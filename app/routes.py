"""HTTP and WebSocket endpoints. All public: players join without an account.

Pages:
- GET  /                      landing page: create a room
- GET  /host/{code}           host screen (TV): QR code, question, scores, voice agent
- GET  /play/{code}           player phone: nickname + BUZZ button

API:
- POST /api/rooms                    create a room, returns its host key
- GET  /api/rooms/{code}             room summary (used by the player page)
- GET  /api/rooms/{code}/qr.svg      QR code of the join URL
- GET  /api/rooms/{code}/eleven-token  agent session credentials (host key required)

WebSockets:
- /ws/{code}/player          join, buzz
- /ws/{code}/host            auth with the host key, then state/events stream, host actions
                             and agent tool calls

Host actions require the room's host key, so a player cannot drive the game
or mint ElevenLabs tokens on the owner's account.
"""
import asyncio
import io
import json
import logging
import secrets
from pathlib import Path

import segno
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.deezer import prepare_song_deck
from app.elevenlabs import ElevenLabsError, get_conversation_token
from app.room import Room, room_manager, run_safely
from app.models import CreateRoomRequest, CreateRoomResponse
from app.questions import load_songs

logger = logging.getLogger(__name__)

router = APIRouter()

PAGES_DIR = Path(__file__).resolve().parents[1] / "static"
MAX_WS_MESSAGE_CHARS = 4096


# ------------------------------------------------------------------- pages

@router.get("/", include_in_schema=False)
def landing_page():
    return FileResponse(PAGES_DIR / "index.html")


@router.get("/host/{code}", include_in_schema=False)
def host_page(code: str):
    return FileResponse(PAGES_DIR / "host.html")


@router.get("/play/{code}", include_in_schema=False)
def play_page(code: str):
    return FileResponse(PAGES_DIR / "play.html")


# --------------------------------------------------------------------- API

def _public_base_url(request: Request) -> str:
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/")
    # Behind a proxy or a tunnel, trust the forwarded scheme/host the browser actually used.
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}"


def _join_url(request: Request, code: str) -> str:
    return f"{_public_base_url(request)}/play/{code}"


def _get_room(code: str) -> Room:
    room = room_manager.get(code)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


def _check_host_key(room: Room, key: str | None) -> None:
    if not key or not secrets.compare_digest(key, room.host_key):
        raise HTTPException(status_code=401, detail="Invalid host key")


@router.post("/api/rooms", response_model=CreateRoomResponse)
async def create_room(body: CreateRoomRequest, request: Request):
    songs = None
    if body.mode == "blindtest":
        # Song previews come from Deezer and expire: look them up now, for this game only.
        songs = await prepare_song_deck(list(load_songs()), body.total_questions)
        if not songs:
            raise HTTPException(status_code=502, detail="Impossible de récupérer les extraits chez Deezer")
    try:
        room = room_manager.create(len(songs) if songs else body.total_questions, songs)
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Too many open rooms, try again later")
    base = _public_base_url(request)
    return CreateRoomResponse(
        code=room.code,
        host_key=room.host_key,
        host_url=f"{base}/host/{room.code}",
        join_url=_join_url(request, room.code),
    )


@router.get("/api/rooms/{code}")
async def room_summary(code: str, request: Request):
    room = _get_room(code)
    return {
        "code": room.code,
        "phase": room.game.phase.value,
        "playerCount": len(room.game.players),
        "mode": room.game.mode,
        "joinUrl": _join_url(request, room.code),
        "agentConfigured": bool(settings.elevenlabs_agent_id),
    }


@router.get("/api/rooms/{code}/qr.svg")
async def room_qr_code(code: str, request: Request):
    room = _get_room(code)
    qr = segno.make(_join_url(request, room.code), error="m")
    buffer = io.BytesIO()
    qr.save(buffer, kind="svg", scale=10, border=2, dark="#111111", light="#ffffff", xmldecl=False)
    return Response(content=buffer.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


@router.get("/api/rooms/{code}/eleven-token")
async def eleven_token(code: str, x_host_key: str | None = Header(default=None)):
    """Returns what the host screen needs to start the agent session.

    - Private agent (API key configured): a short-lived WebRTC conversation token.
    - Public agent (no API key): just the agent id.
    """
    room = _get_room(code)
    _check_host_key(room, x_host_key)
    if not settings.elevenlabs_agent_id:
        raise HTTPException(status_code=503, detail="ELEVENLABS_AGENT_ID is not configured")
    if not settings.elevenlabs_api_key:
        return {"mode": "public", "agentId": settings.elevenlabs_agent_id}
    try:
        token = await get_conversation_token(settings.elevenlabs_api_key, settings.elevenlabs_agent_id)
    except ElevenLabsError as exc:
        logger.warning("Could not mint ElevenLabs conversation token: %s", exc)
        raise HTTPException(status_code=502, detail="Could not get a conversation token from ElevenLabs")
    return {"mode": "token", "conversationToken": token}


# --------------------------------------------------------------- websockets

async def _receive_json(ws: WebSocket) -> dict:
    text = await ws.receive_text()
    if len(text) > MAX_WS_MESSAGE_CHARS:
        return {}
    try:
        message = json.loads(text)
    except ValueError:
        return {}
    return message if isinstance(message, dict) else {}


@router.websocket("/ws/{code}/player")
async def player_socket(ws: WebSocket, code: str):
    room = room_manager.get(code)
    await ws.accept()
    if room is None:
        await ws.send_json({"type": "error", "code": "room_not_found", "message": "Cette salle n'existe pas."})
        await ws.close(code=4404)
        return

    player_id: str | None = None
    try:
        while True:
            message = await _receive_json(ws)
            kind = message.get("type")
            if kind == "join":
                ok, result = await run_safely(
                    room.join_player(ws, str(message.get("name", "")), message.get("playerId"))
                )
                if ok:
                    player_id = result
                else:
                    await ws.send_json({"type": "error", "code": "join_failed", "message": result})
            elif kind == "buzz" and player_id:
                # Fire-and-forget on an already-open socket: no HTTP round trip at buzz time.
                await room.buzz(player_id, source="mobile")
            elif kind == "ping":
                # Lets clients measure their round-trip time (future latency compensation).
                await ws.send_json({"type": "pong", "t": message.get("t")})
    except WebSocketDisconnect:
        pass
    finally:
        if player_id:
            await room.leave_player(ws, player_id)


@router.websocket("/ws/{code}/host")
async def host_socket(ws: WebSocket, code: str):
    room = room_manager.get(code)
    await ws.accept()
    # The host key comes in the first message rather than the URL, so it never lands in access logs.
    try:
        hello = await asyncio.wait_for(_receive_json(ws), timeout=10)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        await ws.close(code=4401)
        return
    key = hello.get("key") if hello.get("type") == "auth" else None
    if room is None or not isinstance(key, str) or not secrets.compare_digest(key, room.host_key):
        await ws.send_json({"type": "error", "code": "unauthorized", "message": "Salle inconnue ou clé hôte invalide."})
        await ws.close(code=4401)
        return

    await ws.send_json({
        "type": "welcome",
        "room": room.code,
        "agentConfigured": bool(settings.elevenlabs_agent_id),
    })
    await room.attach_host(ws)
    try:
        while True:
            message = await _receive_json(ws)
            if message.get("type") != "action":
                continue
            params = message.get("params")
            params = params if isinstance(params, dict) else {}
            ok, result = await run_safely(room.run_action(str(message.get("action")), params))
            reply = {"type": "result", "id": message.get("id"), "ok": ok}
            reply["data" if ok else "error"] = result
            await ws.send_json(reply)
    except WebSocketDisconnect:
        pass
    finally:
        await room.detach_host(ws)
