"""Blind test mode: song rounds, artist/title scoring, Deezer preview lookup."""
import asyncio
import random

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.routes as routes
from app.deezer import find_preview, prepare_song_deck
from app.game import Game, GameError, GameSettings, Phase
from app.models import SongQuestion
from app.questions import load_songs
from tests.test_game import started_game


def make_songs(n: int = 6) -> list[SongQuestion]:
    return [
        SongQuestion(id=f"s{i}", artist=f"Artiste {i}", title=f"Titre {i}", acceptedArtists=[f"artiste {i}"],
                     acceptedTitles=[f"titre {i}"], preview_url=f"https://cdn.example/{i}.mp3",
                     cover_url=f"https://cdn.example/{i}.jpg")
        for i in range(n)
    ]


def song_game(players: int = 2, total: int = 3, **settings) -> Game:
    game = Game(make_songs(), GameSettings(total_questions=total, **settings), rng=random.Random(1))
    for i in range(players):
        game.add_player(f"p{i}", f"Joueur {i}")
    return game


def buzzed(game: Game, player: str = "p0") -> Game:
    game.start_game(0)
    game.start_timer(1)
    game.buzz(player, 2)
    return game


# ------------------------------------------------------------------ game

def test_song_game_reports_blindtest_mode_and_uses_the_song_window():
    game = song_game(song_window_s=25)
    payload, events = game.start_game(0)
    assert game.mode == "blindtest" and payload["mode"] == "blindtest"
    assert payload["kind"] == "chanson" and payload["acceptedArtists"] and payload["acceptedTitles"]
    events = game.start_timer(1)
    assert events[0]["song"] is True
    assert game.deadline == pytest.approx(26)


def test_host_screen_gets_the_clip_but_not_the_answer():
    game = song_game()
    game.start_game(0)
    state = game.public_state(0)
    song = game.current_question
    assert state["question"]["kind"] == "song" and state["question"]["clipUrl"] == song.preview_url
    assert song.artist not in str(state) and song.title not in str(state)
    assert "coverUrl" not in state


@pytest.mark.parametrize("artist,title,points", [(True, False, 1), (False, True, 1), (True, True, 3)])
def test_song_scoring(artist, title, points):
    game = buzzed(song_game())
    payload, events = game.submit_verdict("p0", None, 3, artist=artist, title=title)
    assert game.players["p0"].score == points
    assert payload["points"] == points and events[0]["points"] == points
    assert events[0]["found"] == {"artist": artist, "title": title}
    assert game.phase == Phase.REVEAL
    assert ("missing" in payload) == (points == 1)


def test_song_nothing_found_locks_the_player():
    game = buzzed(song_game())
    _, events = game.submit_verdict("p0", None, 3, artist=False, title=False)
    assert events[0]["correct"] is False and "p0" in game.locked
    assert game.phase == Phase.BUZZ_OPEN


def test_song_plain_correct_counts_as_both_and_plain_wrong_as_nothing():
    game = buzzed(song_game())
    payload, _ = game.submit_verdict("p0", True, 3)
    assert payload["points"] == 3 and game.players["p0"].score == 3
    game = buzzed(song_game())
    game.submit_verdict("p0", False, 3)
    assert game.players["p0"].score == 0 and "p0" in game.locked


def test_song_reveal_shows_artist_title_and_cover():
    game = buzzed(song_game())
    game.submit_verdict("p0", None, 3, artist=True, title=True)
    song = game.current_question
    assert game.reveal_answer() == {"artist": song.artist, "title": song.title,
                                    "answer": f"{song.artist} — {song.title}"}
    state = game.public_state(4)
    assert state["answer"] == f"{song.artist} — {song.title}" and state["coverUrl"] == song.cover_url


def test_quiz_verdict_requires_correct():
    game = started_game()
    game.buzz("p0", 1)
    with pytest.raises(GameError):
        game.submit_verdict("p0", None, 2)


def test_song_list_is_well_formed():
    songs = load_songs()
    assert len(songs) >= 30
    assert len({(s.artist, s.title) for s in songs}) == len(songs)
    for song in songs:
        assert song.acceptedArtists and song.acceptedTitles, song.id
        assert all(a == a.lower() for a in song.acceptedArtists + song.acceptedTitles), song.id
        assert song.preview_url is None


# ---------------------------------------------------------------- deezer

def deezer_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url="https://api.deezer.com", transport=httpx.MockTransport(handler))


def track(artist: str, preview: str = "https://cdn/p.mp3") -> dict:
    return {"title": "x", "preview": preview, "artist": {"name": artist}, "album": {"cover_big": "https://cdn/c.jpg"}}


def test_find_preview_picks_the_right_artist():
    song = SongQuestion(id="s", artist="Édith Piaf", title="La Vie en rose")

    def handler(request):
        assert request.url.path == "/search"
        return httpx.Response(200, json={"data": [track("Some Cover Band"), track("Edith Piaf", "https://cdn/ok.mp3")]})

    async def run():
        async with deezer_client(handler) as client:
            return await find_preview(client, song)

    found = asyncio.run(run())
    assert found.preview_url == "https://cdn/ok.mp3" and found.cover_url == "https://cdn/c.jpg"
    assert song.preview_url is None  # the shared song list is never mutated


def test_find_preview_returns_none_without_match_or_on_error():
    song = SongQuestion(id="s", artist="Renaud", title="Mistral gagnant")

    async def run(handler):
        async with deezer_client(handler) as client:
            return await find_preview(client, song)

    assert asyncio.run(run(lambda r: httpx.Response(200, json={"data": [track("Other")]}))) is None
    assert asyncio.run(run(lambda r: httpx.Response(200, json={"data": [track("Renaud", preview="")]}))) is None
    assert asyncio.run(run(lambda r: httpx.Response(500))) is None


def test_prepare_song_deck_skips_songs_missing_on_deezer():
    songs = [SongQuestion(id=f"s{i}", artist=f"Artiste {i}", title="T") for i in range(8)]
    missing = {"Artiste 1", "Artiste 2", "Artiste 5"}

    def handler(request):
        query = request.url.params["q"]
        artist = next(s.artist for s in songs if f"{s.artist}\"" in query or query.startswith(f"{s.artist} "))
        return httpx.Response(200, json={"data": [] if artist in missing else [track(artist)]})

    async def run():
        async with deezer_client(handler) as client:
            return await prepare_song_deck(songs, 5, rng=random.Random(3), client=client)

    deck = asyncio.run(run())
    assert len(deck) == 5
    assert not {s.artist for s in deck} & missing
    assert all(s.preview_url for s in deck)


# ------------------------------------------------------------------- api

def test_create_blindtest_room(monkeypatch):
    async def fake_deck(songs, total, **kwargs):
        return make_songs(total)

    monkeypatch.setattr(routes, "prepare_song_deck", fake_deck)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        response = client.post("/api/rooms", json={"total_questions": 4, "mode": "blindtest"})
        assert response.status_code == 200
        summary = client.get(f"/api/rooms/{response.json()['code']}").json()
        assert summary["mode"] == "blindtest"


def test_blindtest_room_fails_cleanly_when_deezer_is_unreachable(monkeypatch):
    async def no_deck(songs, total, **kwargs):
        return []

    monkeypatch.setattr(routes, "prepare_song_deck", no_deck)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        response = client.post("/api/rooms", json={"total_questions": 4, "mode": "blindtest"})
        assert response.status_code == 502
