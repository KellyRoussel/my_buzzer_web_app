"""Loads the local question bank and song list."""
import json
from functools import lru_cache
from pathlib import Path

from app.models import QuizQuestion, SongQuestion

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
QUESTIONS_PATH = DATA_DIR / "questions.fr.json"
SONGS_PATH = DATA_DIR / "songs.fr.json"


def _load(path: Path, model):
    items = tuple(model.model_validate(item) for item in json.loads(path.read_text(encoding="utf-8")))
    ids = [item.id for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"Duplicate ids in {path}")
    return items


@lru_cache
def load_questions(path: Path = QUESTIONS_PATH) -> tuple[QuizQuestion, ...]:
    return _load(path, QuizQuestion)


@lru_cache
def load_songs(path: Path = SONGS_PATH) -> tuple[SongQuestion, ...]:
    return _load(path, SongQuestion)
