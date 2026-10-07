"""Pydantic schemas."""
from typing import Literal

from pydantic import BaseModel, Field


class QuizQuestion(BaseModel):
    kind: Literal["text"] = "text"
    id: str
    category: str
    question: str
    answer: str
    acceptedAnswers: list[str] = Field(default_factory=list)
    difficulty: int = Field(1, ge=1, le=3)


class SongQuestion(BaseModel):
    """A blind test round: an extract of a song, played by the host screen."""
    kind: Literal["song"] = "song"
    id: str
    artist: str
    title: str
    acceptedArtists: list[str] = Field(default_factory=list)
    acceptedTitles: list[str] = Field(default_factory=list)
    # Filled in when the game is prepared (Deezer preview URLs expire, so never stored).
    preview_url: str | None = None
    cover_url: str | None = None


Question = QuizQuestion | SongQuestion


class CreateRoomRequest(BaseModel):
    total_questions: int = Field(5, ge=1, le=30)
    mode: Literal["quiz", "blindtest"] = "quiz"


class CreateRoomResponse(BaseModel):
    code: str
    host_key: str
    host_url: str
    join_url: str
