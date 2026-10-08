"""Finds 30-second song previews with the public Deezer API (no key needed).

Preview URLs are signed and expire after a while, so they are looked up when a
blind test game is created, never stored.
"""
import asyncio
import logging
import random
import unicodedata

import httpx

from app.models import SongQuestion

logger = logging.getLogger(__name__)

DEEZER_API_URL = "https://api.deezer.com"


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFD", text.casefold())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def _same_artist(expected: str, found: str) -> bool:
    expected, found = _normalize(expected), _normalize(found)
    return bool(expected) and (expected in found or found in expected)


async def find_preview(client: httpx.AsyncClient, song: SongQuestion) -> SongQuestion | None:
    """Returns the song with its preview and cover URLs, or None if Deezer has no usable match."""
    queries = [f'artist:"{song.artist}" track:"{song.title}"', f"{song.artist} {song.title}"]
    for query in queries:
        try:
            response = await client.get("/search", params={"q": query, "limit": 10})
            response.raise_for_status()
            results = response.json().get("data", [])
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Deezer search failed for %s - %s: %s", song.artist, song.title, exc)
            return None
        for track in results:
            if track.get("preview") and _same_artist(song.artist, track.get("artist", {}).get("name", "")):
                album = track.get("album") or {}
                return song.model_copy(update={
                    "preview_url": track["preview"],
                    "cover_url": album.get("cover_big") or album.get("cover_medium"),
                })
    logger.info("No Deezer preview for %s - %s", song.artist, song.title)
    return None


async def prepare_song_deck(
    songs: list[SongQuestion],
    total: int,
    rng: random.Random | None = None,
    client: httpx.AsyncClient | None = None,
) -> list[SongQuestion]:
    """Draws `total` songs at random and keeps those Deezer has a preview for."""
    candidates = list(songs)
    (rng or random.Random()).shuffle(candidates)
    owns_client = client is None
    client = client or httpx.AsyncClient(base_url=DEEZER_API_URL, timeout=8)
    deck: list[SongQuestion] = []
    try:
        while len(deck) < total and candidates:
            # A few spares per batch, in case some songs are missing from Deezer.
            batch, candidates = candidates[: total - len(deck) + 2], candidates[total - len(deck) + 2:]
            found = await asyncio.gather(*(find_preview(client, song) for song in batch))
            deck += [song for song in found if song is not None]
    finally:
        if owns_client:
            await client.aclose()
    return deck[:total]
