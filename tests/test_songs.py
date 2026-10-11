"""Song rounds, artist/title scoring, themes and the Deezer preview lookup."""
import asyncio
import random

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.routes as routes
from app.deezer import find_preview, prepare_song_deck
from app.game import Game, GameError, GameSettings, Phase
from app.models import SongQuestion, Theme
from app.songs import get_theme, load_songs, load_themes, songs_for_theme


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

def test_song_game_reports_its_theme_and_uses_the_song_window():
    game = Game(make_songs(), GameSettings(total_questions=3, buzz_window_s=25), theme="Années 80")
    game.add_player("p0", "Léa")
    payload, events = game.start_game(0)
    assert payload["theme"] == "Années 80" and events[0] == {"type": "game_started", "theme": "Années 80"}
    assert game.public_state(0)["theme"] == "Années 80" and game.agent_state()["theme"] == "Années 80"
    assert payload["acceptedArtists"] and payload["acceptedTitles"]
    game.start_timer(1)
    assert game.deadline == pytest.approx(26)


def test_host_screen_gets_the_clip_but_not_the_answer():
    game = song_game()
    game.start_game(0)
    state = game.public_state(0)
    song = game.current_question
    assert state["question"]["clipUrl"] == song.preview_url
    assert song.artist not in str(state) and song.title not in str(state)
    assert "coverUrl" not in state


@pytest.mark.parametrize("artist,title,points", [(True, False, 1), (False, True, 1), (True, True, 3)])
def test_song_scoring(artist, title, points):
    game = buzzed(song_game())
    payload, events = game.submit_verdict("p0", 3, artist=artist, title=title)
    assert game.players["p0"].score == points
    assert payload["points"] == points and events[0]["points"] == points
    assert events[0]["found"] == {"artist": artist, "title": title}
    assert game.phase == Phase.REVEAL
    assert ("missing" in payload) == (points == 1)


def test_song_nothing_found_locks_the_player():
    game = buzzed(song_game())
    _, events = game.submit_verdict("p0", 3, artist=False, title=False)
    assert events[0]["correct"] is False and "p0" in game.locked
    assert game.phase == Phase.BUZZ_OPEN


def test_song_plain_correct_counts_as_both_and_plain_wrong_as_nothing():
    game = buzzed(song_game())
    payload, _ = game.submit_verdict("p0", 3, correct=True)
    assert payload["points"] == 3 and game.players["p0"].score == 3
    game = buzzed(song_game())
    game.submit_verdict("p0", 3, correct=False)
    assert game.players["p0"].score == 0 and "p0" in game.locked


def test_song_reveal_shows_artist_title_year_and_cover():
    game = buzzed(song_game())
    game.submit_verdict("p0", 3, artist=True, title=True)
    song = game.current_question
    assert game.reveal_answer() == {"artist": song.artist, "title": song.title, "year": song.year,
                                    "answer": f"{song.artist} — {song.title}"}
    state = game.public_state(4)
    assert state["answer"] == f"{song.artist} — {song.title}" and state["coverUrl"] == song.cover_url
    assert (state["artist"], state["title"]) == (song.artist, song.title)


def test_verdict_requires_artist_and_title_or_correct():
    game = buzzed(song_game())
    with pytest.raises(GameError):
        game.submit_verdict("p0", 3)


# ------------------------------------------------------- songs and themes

def test_song_list_is_large_and_well_formed():
    songs = load_songs()
    assert len(songs) >= 200
    assert len({(s.artist.casefold(), s.title.casefold()) for s in songs}) == len(songs)
    tags = {tag for theme in load_themes() for tag in theme.tags}
    for song in songs:
        assert song.acceptedArtists and song.acceptedTitles, song.id
        assert all(a == a.lower() for a in song.acceptedArtists + song.acceptedTitles), song.id
        assert song.year and 1930 <= song.year <= 2030, song.id
        assert set(song.tags) <= tags, song.id
        assert song.preview_url is None


def test_every_theme_has_enough_songs_for_a_long_game():
    themes = load_themes()
    assert themes[0].id == "mix" and len(songs_for_theme(themes[0])) == len(load_songs())
    for theme in themes:
        assert len(songs_for_theme(theme)) >= 25, theme.id


def test_theme_matches_years_and_tags():
    song = SongQuestion(id="s", artist="A", title="T", year=1985, tags=["fete"])
    assert Theme(id="x", label="x", emoji="x").matches(song)
    assert Theme(id="x", label="x", emoji="x", years=(1980, 1989)).matches(song)
    assert not Theme(id="x", label="x", emoji="x", years=(1990, 1999)).matches(song)
    assert Theme(id="x", label="x", emoji="x", tags=["rap", "fete"]).matches(song)
    assert not Theme(id="x", label="x", emoji="x", tags=["rap"]).matches(song)
    assert get_theme("annees-80").matches(song) and get_theme("nope") is None


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

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as test_client:
        yield test_client


def test_themes_endpoint_lists_every_theme_with_its_song_count(client):
    themes = client.get("/api/themes").json()
    assert [t["id"] for t in themes] == [t.id for t in load_themes()]
    assert all(t["songCount"] >= 25 and t["label"] and t["emoji"] for t in themes)


def test_create_room_draws_songs_from_the_theme(client):
    response = client.post("/api/rooms", json={"total_questions": 10, "theme": "annees-80"})
    assert response.status_code == 200
    code = response.json()["code"]
    assert client.get(f"/api/rooms/{code}").json()["theme"] == "Années 80"
    deck = routes.room_manager.get(code).game.deck
    assert len(deck) == 10 and all(1980 <= song.year <= 1989 for song in deck)


def test_unknown_theme_is_rejected(client):
    assert client.post("/api/rooms", json={"total_questions": 4, "theme": "nope"}).status_code == 404


def test_room_creation_fails_cleanly_when_deezer_is_unreachable(client, monkeypatch):
    async def no_deck(songs, total, **kwargs):
        return []

    monkeypatch.setattr(routes, "prepare_song_deck", no_deck)
    assert client.post("/api/rooms", json={"total_questions": 4}).status_code == 502
