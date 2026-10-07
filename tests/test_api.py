"""WebSocket and HTTP tests for the router."""
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.routes import router


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


def create_room(client, total=3):
    response = client.post("/api/rooms", json={"total_questions": total})
    assert response.status_code == 200
    return response.json()


def receive_until(ws, predicate, limit=50):
    for _ in range(limit):
        message = ws.receive_json()
        if predicate(message):
            return message
    raise AssertionError("expected message not received")


def join(client, code, name):
    ws = client.websocket_connect(f"/ws/{code}/player").__enter__()
    ws.send_json({"type": "join", "name": name})
    joined = receive_until(ws, lambda m: m["type"] == "joined")
    return ws, joined["playerId"]


def host_action(ws, action, params=None, request_id="1"):
    ws.send_json({"type": "action", "id": request_id, "action": action, "params": params or {}})
    return receive_until(ws, lambda m: m["type"] == "result" and m["id"] == request_id)


def test_create_room_and_pages(client):
    room = create_room(client)
    assert len(room["code"]) == 4
    assert room["join_url"].endswith(f"/play/{room['code']}")
    assert client.get(f"/host/{room['code']}").status_code == 200
    assert client.get(f"/play/{room['code']}").status_code == 200
    summary = client.get(f"/api/rooms/{room['code'].lower()}").json()
    assert summary["phase"] == "LOBBY"
    assert client.get("/api/rooms/ZZZZ").status_code == 404


def test_qr_code_encodes_forwarded_url(client):
    room = create_room(client)
    response = client.get(
        f"/api/rooms/{room['code']}/qr.svg",
        headers={"x-forwarded-proto": "https", "x-forwarded-host": "quiz.example.org"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.text.startswith("<svg") and "xmlns" in response.text


def test_host_socket_requires_key(client):
    room = create_room(client)
    with client.websocket_connect(f"/ws/{room['code']}/host") as ws:
        ws.send_json({"type": "auth", "key": "nope"})
        assert ws.receive_json()["code"] == "unauthorized"


def test_eleven_token_requires_host_key_and_config(client, monkeypatch):
    room = create_room(client)
    url = f"/api/rooms/{room['code']}/eleven-token"
    assert client.get(url).status_code == 401
    monkeypatch.setattr(settings, "elevenlabs_agent_id", "")
    assert client.get(url, headers={"x-host-key": room["host_key"]}).status_code == 503
    monkeypatch.setattr(settings, "elevenlabs_agent_id", "agent_123")
    monkeypatch.setattr(settings, "elevenlabs_api_key", "")
    body = client.get(url, headers={"x-host-key": room["host_key"]}).json()
    assert body == {"mode": "public", "agentId": "agent_123"}


def test_full_round_over_websockets(client):
    room = create_room(client)
    code, key = room["code"], room["host_key"]
    with client.websocket_connect(f"/ws/{code}/host") as host:
        host.send_json({"type": "auth", "key": key})
        assert host.receive_json()["type"] == "welcome"
        players = [join(client, code, name) for name in ("Léa", "Tom", "Inès")]
        receive_until(host, lambda m: m["type"] == "state" and len(m["state"]["players"]) == 3)

        result = host_action(host, "start_game")
        assert result["ok"] and result["data"]["index"] == 1
        assert result["data"]["acceptedAnswers"]

        # Buzzing before the timer starts is too early.
        players[2][0].send_json({"type": "buzz"})
        assert receive_until(players[2][0], lambda m: m["type"] == "buzz_result")["result"] == "too_early"
        assert host_action(host, "start_timer", request_id="t")["ok"]
        time.sleep(0.35)  # past Inès's 300 ms anti-spam window

        # Everyone buzzes; the first message processed wins, the others are too late.
        for ws, _ in players:
            ws.send_json({"type": "buzz"})
        results = [receive_until(ws, lambda m: m["type"] == "buzz_result")["result"] for ws, _ in players]
        assert results == ["accepted", "too_late", "too_late"]
        winner = receive_until(host, lambda m: m["type"] == "event" and m["event"]["type"] == "buzz_winner")
        assert winner["event"]["name"] == "Léa"

        wrong_player = host_action(host, "submit_verdict", {"playerId": players[1][1], "correct": True}, "2")
        assert not wrong_player["ok"] and "Léa" in wrong_player["error"]

        verdict = host_action(host, "submit_verdict", {"playerId": players[0][1], "correct": "true"}, "3")
        assert verdict["ok"] and verdict["data"]["verdict"] == "correct"

        state = receive_until(players[0][0], lambda m: m["type"] == "state" and m["state"]["phase"] == "REVEAL")
        assert state["state"]["me"]["score"] == 1 and state["state"]["answer"]

        assert host_action(host, "nope", request_id="4")["ok"] is False
        for ws, _ in players:
            ws.__exit__(None, None, None)


def test_player_reconnects_with_same_id(client):
    room = create_room(client)
    code = room["code"]
    ws, player_id = join(client, code, "Léa")
    ws.__exit__(None, None, None)
    with client.websocket_connect(f"/ws/{code}/player") as again:
        again.send_json({"type": "join", "name": "Léa", "playerId": player_id})
        joined = receive_until(again, lambda m: m["type"] == "joined")
        assert joined["playerId"] == player_id
    assert client.get(f"/api/rooms/{code}").json()["playerCount"] == 1


def test_unknown_room_player_socket(client):
    with client.websocket_connect("/ws/ZZZZ/player") as ws:
        assert ws.receive_json()["code"] == "room_not_found"
