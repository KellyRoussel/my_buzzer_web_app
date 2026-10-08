"""Pydantic schemas."""
from pydantic import BaseModel, Field


class SongQuestion(BaseModel):
    """A blind test round: an extract of a song, played by the host screen."""
    id: str
    artist: str
    title: str
    year: int | None = None
    tags: list[str] = Field(default_factory=list)
    acceptedArtists: list[str] = Field(default_factory=list)
    acceptedTitles: list[str] = Field(default_factory=list)
    # Filled in when the game is prepared (Deezer preview URLs expire, so never stored).
    preview_url: str | None = None
    cover_url: str | None = None


class Theme(BaseModel):
    """A playlist to pick songs from: a range of years and/or tags (neither means every song)."""
    id: str
    label: str
    emoji: str
    description: str = ""
    years: tuple[int, int] | None = None
    tags: list[str] = Field(default_factory=list)

    def matches(self, song: SongQuestion) -> bool:
        if self.years and (song.year is None or not self.years[0] <= song.year <= self.years[1]):
            return False
        return not self.tags or any(tag in song.tags for tag in self.tags)


class CreateRoomRequest(BaseModel):
    total_questions: int = Field(5, ge=1, le=30)
    theme: str = "mix"


class CreateRoomResponse(BaseModel):
    code: str
    host_key: str
    host_url: str
    join_url: str
