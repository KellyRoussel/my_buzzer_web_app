import pytest

import app.routes as routes


@pytest.fixture(autouse=True)
def offline_deezer(monkeypatch):
    """Rooms are created without calling Deezer: every song gets a fake preview."""
    async def fake_deck(songs, total, **kwargs):
        return [song.model_copy(update={"preview_url": f"https://cdn.example/{song.id}.mp3",
                                        "cover_url": f"https://cdn.example/{song.id}.jpg"})
                for song in list(songs)[:total]]

    monkeypatch.setattr(routes, "prepare_song_deck", fake_deck)
