"""Loads the local question bank."""
import json
from functools import lru_cache
from pathlib import Path

from app.models import QuizQuestion

QUESTIONS_PATH = Path(__file__).resolve().parents[1] / "data" / "questions.fr.json"


@lru_cache
def load_questions(path: Path = QUESTIONS_PATH) -> tuple[QuizQuestion, ...]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    questions = tuple(QuizQuestion.model_validate(item) for item in raw)
    ids = [q.id for q in questions]
    if len(ids) != len(set(ids)):
        raise ValueError(f"Duplicate question ids in {path}")
    return questions
