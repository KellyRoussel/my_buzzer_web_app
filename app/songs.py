"""Loads the song list and the themes players pick from."""
import json
from functools import lru_cache
from pathlib import Path

from app.models import SongQuestion, Theme

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
SONGS_PATH = DATA_DIR / "songs.fr.json"
THEMES_PATH = DATA_DIR / "themes.fr.json"


def _load(path: Path, model):
    items = tuple(model.model_validate(item) for item in json.loads(path.read_text(encoding="utf-8")))
    ids = [item.id for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"Duplicate ids in {path}")
    return items


@lru_cache
def load_songs(path: Path = SONGS_PATH) -> tuple[SongQuestion, ...]:
    return _load(path, SongQuestion)


@lru_cache
def load_themes(path: Path = THEMES_PATH) -> tuple[Theme, ...]:
    return _load(path, Theme)


def get_theme(theme_id: str) -> Theme | None:
    return next((theme for theme in load_themes() if theme.id == theme_id), None)


def songs_for_theme(theme: Theme) -> list[SongQuestion]:
    return [song for song in load_songs() if theme.matches(song)]
