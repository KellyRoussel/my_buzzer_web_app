"""In-memory game rooms.

A Room owns one Game, the WebSocket connections attached to it and a small
timer loop that fires the game deadlines. Everything runs on the single
asyncio event loop, so game mutations never interleave: the first buzz
processed is the first buzz received. This also means rooms live in one
process only (run uvicorn with a single worker).
"""
import asyncio
import logging
import secrets
import time
from typing import Any, Awaitable, Callable

from fastapi import WebSocket

from app.game import BuzzResult, Event, Game, GameError, GameSettings
from app.models import Question
from app.questions import load_questions

logger = logging.getLogger(__name__)

ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # no I/O, easy to read on a TV
ROOM_CODE_LENGTH = 4
MAX_ROOMS = 50
ROOM_IDLE_TTL_S = 3 * 3600
TICK_S = 0.1

Clock = Callable[[], float]


class Room:
    def __init__(self, code: str, game: Game, clock: Clock = time.perf_counter):
        self.code = code
        self.host_key = secrets.token_urlsafe(16)
        self.game = game
        self.clock = clock
        self.hosts: set[WebSocket] = set()
        self.player_sockets: dict[str, WebSocket] = {}
        self.last_activity = clock()
        self._ticker: asyncio.Task | None = None
        self._closed = False

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._ticker is None:
            self._ticker = asyncio.create_task(self._tick_loop(), name=f"quiz-room-{self.code}")

    def close(self) -> None:
        self._closed = True
        if self._ticker:
            self._ticker.cancel()

    def touch(self) -> None:
        self.last_activity = self.clock()

    async def _tick_loop(self) -> None:
        while not self._closed:
            await asyncio.sleep(TICK_S)
            try:
                events = self.game.tick(self.clock())
                if events:
                    await self.publish(events)
            except Exception:  # never let one bad tick kill the room
                logger.exception("Quiz room %s tick failed", self.code)

    # -------------------------------------------------------------- connections

    async def attach_host(self, ws: WebSocket) -> None:
        self.hosts.add(ws)
        self.touch()
        await self._send(ws, {"type": "state", "state": self.game.public_state(self.clock())})

    async def detach_host(self, ws: WebSocket) -> None:
        self.hosts.discard(ws)

    async def join_player(self, ws: WebSocket, name: str, player_id: str | None) -> str:
        if not player_id or player_id not in self.game.players:
            player_id = f"p_{secrets.token_hex(4)}"
        player, events = self.game.add_player(player_id, name)
        previous = self.player_sockets.get(player.id)
        self.player_sockets[player.id] = ws
        if previous is not None and previous is not ws:
            # Same player opened a new tab or reconnected: drop the stale socket.
            try:
                await previous.close(code=4000)
            except Exception:
                pass
        events += self.game.set_connected(player.id, True)
        self.touch()
        await self._send(ws, {"type": "joined", "playerId": player.id, "name": player.name, "color": player.color})
        await self.publish(events)
        return player.id

    async def leave_player(self, ws: WebSocket, player_id: str) -> None:
        if self.player_sockets.get(player_id) is not ws:
            return  # a newer socket already replaced this one
        del self.player_sockets[player_id]
        await self.publish(self.game.set_connected(player_id, False))

    # ------------------------------------------------------------------ actions

    async def buzz(self, player_id: str, source: str = "mobile") -> BuzzResult:
        """Generic buzz entry point: mobile today, a hardware buzzer bridge tomorrow."""
        received_at = self.clock()  # timestamp on receipt, before anything else
        result, events = self.game.buzz(player_id, received_at, source=source)
        self.touch()
        socket = self.player_sockets.get(player_id)
        if socket is not None and result != BuzzResult.RATE_LIMITED:
            await self._send(socket, {"type": "buzz_result", "result": result.value})
        if events:
            await self.publish(events)
        await self.publish_to_hosts([{"type": "buzz_received", "playerId": player_id, "result": result.value,
                                      "source": source}])
        return result

    async def run_action(self, action: str, params: dict[str, Any]) -> Any:
        """Runs a host action (button or agent tool call relayed by the host screen)."""
        now = self.clock()
        self.touch()
        handlers: dict[str, Callable[[], tuple[Any, list[Event]]]] = {
            "get_game_state": lambda: (self.game.agent_state(), []),
            "start_game": lambda: self.game.start_game(now),
            "next_question": lambda: self.game.next_question(now, force=_as_bool(params.get("force"))),
            "submit_verdict": lambda: self.game.submit_verdict(
                str(params.get("playerId") or self.game.answering or ""),
                _optional_bool(params.get("correct")),
                now,
                by=str(params.get("by", "agent")),
                artist=_optional_bool(params.get("artist")),
                title=_optional_bool(params.get("title")),
            ),
            "reveal_answer": lambda: (self.game.reveal_answer(), [{"type": "answer_revealed"}]),
            "get_scores": lambda: (self.game.scores_payload(), []),
            "start_timer": lambda: ({"ok": True}, self.game.start_timer(now)),
            "open_floor": lambda: ({"ok": True}, self.game.open_floor(now)),
            "pause": lambda: ({"ok": True}, self.game.pause(now)),
            "resume": lambda: ({"ok": True}, self.game.resume(now)),
        }
        handler = handlers.get(action)
        if handler is None:
            raise GameError(f"Action inconnue : {action}")
        result, events = handler()
        await self.publish(events)
        return result

    # ------------------------------------------------------------ broadcasting

    async def publish(self, events: list[Event]) -> None:
        """Sends events to the host screens, then the fresh state to everyone."""
        if events:
            await self.publish_to_hosts(events)
        now = self.clock()
        public = self.game.public_state(now)
        for ws in list(self.hosts):
            await self._send(ws, {"type": "state", "state": public})
        for player_id, ws in list(self.player_sockets.items()):
            await self._send(ws, {"type": "state", "state": self.game.player_state(player_id, now)})

    async def publish_to_hosts(self, events: list[Event]) -> None:
        for event in events:
            for ws in list(self.hosts):
                await self._send(ws, {"type": "event", "event": event})

    async def _send(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:
            # The receive loop of that socket will notice the disconnect and clean up.
            logger.debug("Quiz room %s: send failed", self.code)


def _optional_bool(value: Any) -> bool | None:
    return None if value is None else _as_bool(value)


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "oui", "vrai", "correct")
    return bool(value)


class RoomManager:
    def __init__(self, clock: Clock = time.perf_counter):
        self.clock = clock
        self.rooms: dict[str, Room] = {}

    def create(self, total_questions: int, questions: list[Question] | None = None) -> Room:
        """Creates a room. `questions` is the pool to draw from (default: the quiz bank)."""
        self.purge_idle()
        if len(self.rooms) >= MAX_ROOMS:
            raise RuntimeError("Too many open rooms")
        code = self._new_code()
        pool = list(questions) if questions is not None else list(load_questions())
        room = Room(code, Game(pool, GameSettings(total_questions=total_questions)), clock=self.clock)
        self.rooms[code] = room
        room.start()
        return room

    def get(self, code: str) -> Room | None:
        return self.rooms.get(code.upper())

    def purge_idle(self) -> None:
        now = self.clock()
        for code, room in list(self.rooms.items()):
            if now - room.last_activity > ROOM_IDLE_TTL_S and not room.hosts and not room.player_sockets:
                room.close()
                del self.rooms[code]

    def _new_code(self) -> str:
        while True:
            code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
            if code not in self.rooms:
                return code


room_manager = RoomManager()


async def run_safely(coro: Awaitable[Any]) -> tuple[bool, Any]:
    """Awaits a room action and turns a GameError into an (ok, error message) pair."""
    try:
        return True, await coro
    except GameError as exc:
        return False, str(exc)
