"""Pydantic schemas."""
from pydantic import BaseModel, Field


class QuizQuestion(BaseModel):
    id: str
    category: str
    question: str
    answer: str
    acceptedAnswers: list[str] = Field(default_factory=list)
    difficulty: int = Field(1, ge=1, le=3)


class CreateRoomRequest(BaseModel):
    total_questions: int = Field(5, ge=1, le=30)


class CreateRoomResponse(BaseModel):
    code: str
    host_key: str
    host_url: str
    join_url: str
