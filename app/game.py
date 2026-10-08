"""Blind test game state machine.

The game is the single source of truth for phases, buzz order and scores.
It is pure and synchronous: every method takes the current time (`now`, in
seconds from a monotonic clock) and returns the events it produced, so it can
be unit-tested without sockets, timers or an event loop.

Phases:
    LOBBY -> QUESTION_READING -> BUZZ_OPEN -> ANSWERING -> REVEAL
          -> (QUESTION_READING | FINISHED)

Each question is a song extract, played by the host screen. Buzzing opens only
when the timer starts (start_timer), once the agent has announced the song: a
buzz during QUESTION_READING is "too early".

Messages returned to the agent (errors, hints) are in French because they are
read by a French-speaking voice agent.
"""
import math
import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from app.models import SongQuestion

PLAYER_COLORS = [
    "#ff3d7f", "#3dd6ff", "#ffd23d", "#9d5cff",
    "#3dff8b", "#ff8a3d", "#ff5cf0", "#5c7cff",
]

Event = dict[str, Any]


class Phase(str, Enum):
    LOBBY = "LOBBY"
    QUESTION_READING = "QUESTION_READING"
    BUZZ_OPEN = "BUZZ_OPEN"
    ANSWERING = "ANSWERING"
    REVEAL = "REVEAL"
    FINISHED = "FINISHED"


BUZZABLE_PHASES = (Phase.BUZZ_OPEN,)


class BuzzResult(str, Enum):
    ACCEPTED = "accepted"
    TOO_EARLY = "too_early"
    TOO_LATE = "too_late"
    LOCKED = "locked"
    NOT_OPEN = "not_open"
    RATE_LIMITED = "rate_limited"
    ALREADY_ANSWERING = "already_answering"
    UNKNOWN_PLAYER = "unknown_player"


class GameError(Exception):
    """A rejected action. The message is shown to the agent or the host."""


@dataclass
class GameSettings:
    total_questions: int = 5
    # If the timer is never started (agent forgot start_timer), start it anyway.
    # Generous on purpose: the agent often comments on the previous answer before reading.
    reading_fallback_s: float = 30.0
    # Buzz window while the 30 s song preview plays.
    buzz_window_s: float = 25.0
    # Shorter window after a wrong answer, to keep the pace up.
    rebuzz_window_s: float = 10.0
    # Microphone window given to the player who has the hand, from the moment they buzz.
    answer_window_s: float = 8.0
    # Safety net: if nobody submits a verdict, the answer is counted wrong.
    # Generous: a voice agent can take several seconds to judge (transcription + LLM + retries).
    answer_hard_timeout_s: float = 30.0
    # Once the answer is heard, the agent has at least this long to judge it.
    judge_timeout_s: float = 15.0
    buzz_cooldown_s: float = 0.3
    # Rejected buzzes from a locked player before the agent is told to tease them.
    spam_tease_threshold: int = 3


@dataclass
class Player:
    id: str
    name: str
    color: str
    score: int = 0
    streak: int = 0
    best_streak: int = 0
    wrong_answers: int = 0
    connected: bool = True
    last_buzz_at: float = -math.inf
    spam_this_question: int = 0


@dataclass
class BuzzRecord:
    player_id: str
    at: float
    source: str
    result: BuzzResult


@dataclass
class Game:
    questions: list[SongQuestion]
    settings: GameSettings = field(default_factory=GameSettings)
    rng: random.Random = field(default_factory=random.Random)
    theme: str = "Le grand mix"

    def __post_init__(self) -> None:
        if not self.questions:
            raise ValueError("The song list is empty")
        total = min(self.settings.total_questions, len(self.questions))
        self.settings.total_questions = total
        # Drawn once, so a game never repeats a question.
        self.deck: list[SongQuestion] = self.rng.sample(list(self.questions), total)
        self.players: dict[str, Player] = {}
        self.phase = Phase.LOBBY
        self.question_index = -1
        self.locked: set[str] = set()
        self.answering: str | None = None
        self.buzz_log: list[BuzzRecord] = []
        self.buzz_opened_at: float | None = None
        self.answer_started_at: float | None = None
        self.answered = False  # the player's answer has been heard
        self.deadline: float | None = None
        self.deadline_kind: str | None = None
        self.deadline_total: float | None = None
        self.paused_remaining: float | None = None
        self.answer_revealed = False
        self.solved = False
        self.teased: set[str] = set()

    # ------------------------------------------------------------------ players

    def add_player(self, player_id: str, name: str) -> tuple[Player, list[Event]]:
        """Adds a player, or reattaches a reconnecting one (same id)."""
        name = " ".join(name.split())[:20]
        if not name:
            raise GameError("Pseudo vide.")
        existing = self.players.get(player_id)
        if existing:
            existing.connected = True
            return existing, []
        taken = {p.name.casefold() for p in self.players.values()}
        base, n = name, 2
        while name.casefold() in taken:
            name = f"{base[:17]} {n}"
            n += 1
        player = Player(id=player_id, name=name, color=PLAYER_COLORS[len(self.players) % len(PLAYER_COLORS)])
        self.players[player_id] = player
        return player, [{"type": "player_joined", "playerId": player.id, "name": player.name}]

    def set_connected(self, player_id: str, connected: bool) -> list[Event]:
        player = self.players.get(player_id)
        if not player or player.connected == connected:
            return []
        player.connected = connected
        return [{"type": "player_connection", "playerId": player_id, "name": player.name, "connected": connected}]

    # --------------------------------------------------------------- game flow

    @property
    def current_question(self) -> SongQuestion | None:
        if 0 <= self.question_index < len(self.deck):
            return self.deck[self.question_index]
        return None

    def start_game(self, now: float) -> tuple[dict, list[Event]]:
        if self.phase != Phase.LOBBY:
            return self._question_payload(note="La partie a déjà commencé : voici la question en cours."), []
        if not self.players:
            raise GameError("Aucun joueur n'a rejoint la partie. Attends qu'au moins un joueur scanne le QR code.")
        events = [{"type": "game_started", "theme": self.theme}]
        events += self._open_question(now)
        return {"theme": self.theme, **self._question_payload()}, events

    def next_question(self, now: float, force: bool = False) -> tuple[dict, list[Event]]:
        """Moves on to the next question. `force` (host button) skips a question still in play."""
        if self.phase == Phase.LOBBY:
            raise GameError("La partie n'a pas commencé : appelle d'abord start_game.")
        events: list[Event] = []
        if force and self.phase in (Phase.QUESTION_READING, Phase.BUZZ_OPEN, Phase.ANSWERING):
            self.phase = Phase.REVEAL
            self.answering = None
            self._clear_deadline()
            events.append({"type": "question_skipped", "questionNumber": self.question_index + 1})
        if self.phase in (Phase.QUESTION_READING, Phase.BUZZ_OPEN, Phase.ANSWERING):
            # Forgiving on purpose: an LLM agent sometimes asks twice.
            return self._question_payload(note="Une question est déjà en cours : la voici à nouveau. Ne la saute pas."), []
        if self.phase == Phase.FINISHED or self.question_index + 1 >= len(self.deck):
            payload, finish_events = self._finish()
            return payload, events + finish_events
        events += self._open_question(now)
        return self._question_payload(), events

    def start_timer(self, now: float) -> list[Event]:
        """The song has been announced: the music starts, buzzing opens and the countdown runs."""
        if self.phase != Phase.QUESTION_READING:
            return []
        self.phase = Phase.BUZZ_OPEN
        self.buzz_opened_at = now
        window = self.settings.buzz_window_s
        self._set_deadline("buzz", now, window)
        return [{"type": "buzz_open", "windowS": window}]

    def buzz(self, player_id: str, now: float, source: str = "mobile") -> tuple[BuzzResult, list[Event]]:
        """Arbitrates a buzz. The first buzz *received* wins; client clocks are never trusted."""
        player = self.players.get(player_id)
        if not player:
            return BuzzResult.UNKNOWN_PLAYER, []
        if now - player.last_buzz_at < self.settings.buzz_cooldown_s:
            return BuzzResult.RATE_LIMITED, []
        player.last_buzz_at = now

        result = self._classify_buzz(player_id)
        self.buzz_log.append(BuzzRecord(player_id=player_id, at=now, source=source, result=result))
        events: list[Event] = []

        if result == BuzzResult.ACCEPTED:
            self.phase = Phase.ANSWERING
            self.answering = player_id
            self.answer_started_at = now
            self.answered = False
            self._set_deadline("answer", now, self.settings.answer_window_s)
            reaction = now - self.buzz_opened_at if self.buzz_opened_at is not None else None
            events.append({
                "type": "buzz_winner",
                "playerId": player_id,
                "name": player.name,
                "source": source,
                "reactionS": round(reaction, 2) if reaction is not None else None,
                "answerWindowS": self.settings.answer_window_s,
            })
        elif result == BuzzResult.LOCKED:
            player.spam_this_question += 1
            if player.spam_this_question >= self.settings.spam_tease_threshold and player_id not in self.teased:
                self.teased.add(player_id)
                events.append({"type": "locked_spam", "playerId": player_id, "name": player.name,
                               "attempts": player.spam_this_question})
        return result, events

    def answer_heard(self, now: float) -> list[Event]:
        """The player's answer has been heard: stop the answer countdown and wait for the verdict."""
        if self.phase != Phase.ANSWERING or self.answered:
            return []
        self.answered = True
        remaining = self.answer_started_at + self.settings.answer_hard_timeout_s - now
        self._set_deadline("answer_hard", now, max(remaining, self.settings.judge_timeout_s))
        player = self.players[self.answering]
        return [{"type": "answer_heard", "playerId": player.id, "name": player.name}]

    def submit_verdict(
        self,
        player_id: str,
        now: float,
        artist: bool | None = None,
        title: bool | None = None,
        correct: bool | None = None,
        by: str = "agent",
    ) -> tuple[dict, list[Event]]:
        """Judges the answer of the player who has the hand.

        `artist` and `title` are scored 1 point each, 3 for both. A plain `correct`
        also works: true for the whole song, false for "nothing right".
        """
        if self.phase != Phase.ANSWERING or self.answering is None:
            raise GameError("Personne n'a la main en ce moment : il n'y a rien à juger.")
        if player_id != self.answering:
            holder = self.players[self.answering]
            raise GameError(f"Ce n'est pas ce joueur qui a la main. C'est {holder.name} (id {holder.id}).")
        if artist is None and title is None:
            if correct is None:
                raise GameError("Indique artist et title (true ou false).")
            # "correct" means the whole song. Accepting it beats an error and a retry that can
            # take longer than the time left to judge.
            artist = title = correct
        found = {"artist": bool(artist), "title": bool(title)}
        points = SONG_POINTS[(found["artist"], found["title"])]
        events = self._apply_verdict(points, now, by=by, found=found)
        return self._verdict_payload(player_id, points, found), events

    def reveal_answer(self) -> dict:
        question = self.current_question
        if question is None:
            raise GameError("Aucune question en cours.")
        if self.phase not in (Phase.REVEAL, Phase.FINISHED):
            raise GameError("Interdit de donner la réponse maintenant : la question est encore en jeu.")
        self.answer_revealed = True
        return {"artist": question.artist, "title": question.title, "year": question.year,
                "answer": _song_answer(question)}

    def pause(self, now: float) -> list[Event]:
        if self.paused_remaining is not None:
            return []
        self.paused_remaining = (self.deadline - now) if self.deadline is not None else math.inf
        self.deadline = None
        return [{"type": "paused"}]

    def resume(self, now: float) -> list[Event]:
        if self.paused_remaining is None:
            return []
        if self.paused_remaining == math.inf:
            self.deadline_kind = None
        else:
            self.deadline = now + self.paused_remaining
        self.paused_remaining = None
        return [{"type": "resumed"}]

    @property
    def answer_visible(self) -> bool:
        """Screens show the answer once it has been said out loud, not as soon as the question closes."""
        if self.current_question is None:
            return False
        if self.phase == Phase.FINISHED:
            return True
        return self.phase == Phase.REVEAL and (self.answer_revealed or self.solved)

    @property
    def paused(self) -> bool:
        return self.paused_remaining is not None

    def tick(self, now: float) -> list[Event]:
        """Fires the pending deadline, if it has expired."""
        if self.paused or self.deadline is None or now < self.deadline:
            return []
        kind = self.deadline_kind
        self.deadline = self.deadline_kind = None
        if kind == "reading":
            return self.start_timer(now)
        if kind == "buzz":
            self.phase = Phase.REVEAL
            return [{"type": "buzz_timeout", **self._progress()}]
        if kind == "answer":
            player = self.players[self.answering]
            self._set_deadline("answer_hard", now, self.answer_started_at + self.settings.answer_hard_timeout_s - now)
            return [{"type": "answer_time_up", "playerId": player.id, "name": player.name}]
        if kind == "answer_hard":
            player = self.players[self.answering]
            events: list[Event] = [{"type": "answer_timeout", "playerId": player.id, "name": player.name}]
            return events + self._apply_verdict(0, now, by="timeout")
        return []

    # ------------------------------------------------------------------- views

    def ranking(self) -> list[dict]:
        ordered = sorted(self.players.values(), key=lambda p: (-p.score, p.name.casefold()))
        ranking, previous_score, rank = [], None, 0
        for position, player in enumerate(ordered, start=1):
            if player.score != previous_score:
                rank, previous_score = position, player.score
            ranking.append({
                "rank": rank,
                "playerId": player.id,
                "name": player.name,
                "score": player.score,
                "streak": player.streak,
                "wrongAnswers": player.wrong_answers,
            })
        return ranking

    def scores_payload(self) -> dict:
        ranking = self.ranking()
        return {
            "ranking": ranking,
            **self._progress(),
            "teasingMaterial": self._teasing_material(ranking),
        }

    def agent_state(self) -> dict:
        """What the agent sees through get_game_state."""
        state: dict[str, Any] = {
            "phase": self.phase.value,
            "theme": self.theme,
            **self._progress(),
            "players": self.ranking(),
            "nextStep": self._next_step_hint(),
        }
        if self.answering:
            state["answering"] = {"playerId": self.answering, "name": self.players[self.answering].name}
        if self.locked:
            state["lockedPlayers"] = [self.players[pid].name for pid in self.locked]
        if self.current_question and self.phase not in (Phase.LOBBY, Phase.FINISHED):
            state["currentQuestion"] = self._question_payload()
        return state

    def public_state(self, now: float) -> dict:
        """What the host screen displays. Never contains the answer before REVEAL."""
        question = self.current_question
        state: dict[str, Any] = {
            "phase": self.phase.value,
            "theme": self.theme,
            **self._progress(),
            "paused": self.paused,
            "players": [
                {
                    "id": p.id, "name": p.name, "color": p.color, "score": p.score,
                    "streak": p.streak, "connected": p.connected, "locked": p.id in self.locked,
                }
                for p in self.players.values()
            ],
            "ranking": self.ranking(),
            "answering": self.answering,
            **self._deadline_view(now),
            "question": None,
            "answer": None,
        }
        if question and self.phase != Phase.LOBBY:
            # The clip URL reveals nothing about the song; the host screen plays it.
            state["question"] = {"text": f"Chanson {self.question_index + 1}", "clipUrl": question.preview_url}
            if self.answer_visible:
                state["answer"] = _song_answer(question)
                state["artist"], state["title"], state["year"] = question.artist, question.title, question.year
                state["coverUrl"] = question.cover_url
        return state

    def player_state(self, player_id: str, now: float) -> dict:
        player = self.players[player_id]
        rank = next((r["rank"] for r in self.ranking() if r["playerId"] == player_id), None)
        return {
            "phase": self.phase.value,
            "theme": self.theme,
            **self._progress(),
            "paused": self.paused,
            "me": {
                "id": player.id, "name": player.name, "color": player.color,
                "score": player.score, "rank": rank, "playerCount": len(self.players),
                "streak": player.streak,
            },
            "locked": player_id in self.locked,
            "hasHand": self.answering == player_id,
            "answered": self.answered and self.answering == player_id,
            "answeringName": self.players[self.answering].name if self.answering else None,
            "canBuzz": self.phase in BUZZABLE_PHASES and player_id not in self.locked and not self.paused,
            **self._deadline_view(now),
            "answer": _song_answer(self.current_question) if self.answer_visible else None,
        }

    # ---------------------------------------------------------------- internals

    def _deadline_view(self, now: float) -> dict:
        return {
            "deadlineKind": self.deadline_kind,
            "deadlineIn": round(self.deadline - now, 2) if self.deadline is not None else None,
            "deadlineTotal": self.deadline_total,
        }

    def _classify_buzz(self, player_id: str) -> BuzzResult:
        if self.paused:
            return BuzzResult.NOT_OPEN
        if self.phase == Phase.QUESTION_READING:
            return BuzzResult.TOO_EARLY
        if self.phase in BUZZABLE_PHASES:
            return BuzzResult.LOCKED if player_id in self.locked else BuzzResult.ACCEPTED
        if self.phase == Phase.ANSWERING:
            return BuzzResult.ALREADY_ANSWERING if player_id == self.answering else BuzzResult.TOO_LATE
        if self.phase == Phase.REVEAL:
            return BuzzResult.TOO_LATE
        return BuzzResult.NOT_OPEN

    def _open_question(self, now: float) -> list[Event]:
        self.question_index += 1
        self.phase = Phase.QUESTION_READING
        self.locked.clear()
        self.teased.clear()
        self.answering = None
        self.answer_revealed = False
        self.solved = False
        self.buzz_opened_at = None
        for player in self.players.values():
            player.spam_this_question = 0
        self._set_deadline("reading", now, self.settings.reading_fallback_s)
        return [{"type": "question", "index": self.question_index + 1, "total": len(self.deck)}]

    def _apply_verdict(self, points: int, now: float, by: str, found: dict | None = None) -> list[Event]:
        player = self.players[self.answering]
        self.answering = None
        self.answer_started_at = None
        extra = {"found": found} if found is not None else {}
        if points > 0:
            self.solved = True
            player.score += points
            player.streak += 1
            player.best_streak = max(player.best_streak, player.streak)
            self.phase = Phase.REVEAL
            self._clear_deadline()
            return [{"type": "verdict", "playerId": player.id, "name": player.name, "correct": True, "by": by,
                     "points": points, **extra, "next": "REVEAL", **self._progress()}]

        player.streak = 0
        player.wrong_answers += 1
        self.locked.add(player.id)
        still_in = [p for p in self.players.values() if p.connected and p.id not in self.locked]
        event: Event = {"type": "verdict", "playerId": player.id, "name": player.name, "correct": False, "by": by,
                        "points": 0, **extra}
        if still_in:
            self.phase = Phase.BUZZ_OPEN
            self._set_deadline("buzz", now, self.settings.rebuzz_window_s)
            event.update(next="BUZZ_OPEN", remaining=[p.name for p in still_in])
        else:
            self.phase = Phase.REVEAL
            self._clear_deadline()
            event.update(next="REVEAL", allWrong=True, **self._progress())
        return [event]

    def _finish(self) -> tuple[dict, list[Event]]:
        self.phase = Phase.FINISHED
        self._clear_deadline()
        ranking = self.ranking()
        winners = [r["name"] for r in ranking if r["rank"] == 1]
        payload = {
            "finished": True,
            "winners": winners,
            "podium": [r for r in ranking if r["rank"] <= 3],
            "ranking": ranking,
            "teasingMaterial": self._teasing_material(ranking),
            "nextStep": "C'est fini ! Annonce le podium avec panache, puis chambre gentiment le dernier.",
        }
        return payload, [{"type": "finished", "winners": winners}]

    def _question_payload(self, note: str | None = None) -> dict:
        question = self.current_question
        payload = {
            "index": self.question_index + 1,
            "total": len(self.deck),
            # The agent judges by ear, so it needs the answer; the prompt keeps it secret.
            "artist": question.artist,
            "title": question.title,
            "acceptedArtists": question.acceptedArtists,
            "acceptedTitles": question.acceptedTitles,
            "secret": "Ne révèle JAMAIS l'artiste, le titre ni l'année, et ne fredonne pas, avant un verdict ou reveal_answer.",
            "nextStep": (f"Annonce « Chanson numéro {self.question_index + 1} ! » en une phrase, appelle "
                         "start_timer (la musique démarre quand tu te tais), puis tais-toi pendant l'extrait "
                         "et attends un message BUZZ ou TIMEOUT."),
        }
        if note:
            payload["note"] = note
        return payload

    def _verdict_payload(self, player_id: str, points: int, found: dict) -> dict:
        correct = points > 0
        player = self.players[player_id]
        payload: dict[str, Any] = {
            "verdict": "correct" if correct else "faux",
            "player": player.name,
            "points": points,
            "newScore": player.score,
            "phase": self.phase.value,
            "ranking": self.ranking(),
        }
        if self.phase == Phase.BUZZ_OPEN:
            remaining = [p.name for p in self.players.values() if p.connected and p.id not in self.locked]
            payload["nextStep"] = (
                f"Mauvaise réponse. {player.name} est bloqué·e pour cette question. "
                f"Relance les autres ({', '.join(remaining)}) en une phrase, puis tais-toi."
            )
        else:
            payload["nextStep"] = self._next_step_hint()
            payload["announceScores"] = self._should_announce_scores()
        if correct:
            missing = [label for key, label in (("artist", "l'artiste"), ("title", "le titre")) if not found[key]]
            payload["found"] = found
            if missing:
                payload["missing"] = f"{player.name} n'a pas trouvé {missing[0]} : tu peux le donner en révélant la réponse."
            if player.streak >= 2:
                payload["streak"] = f"{player.name} enchaîne {player.streak} bonnes réponses d'affilée."
        return payload

    def _progress(self) -> dict:
        return {
            "questionNumber": max(self.question_index + 1, 0),
            "totalQuestions": len(self.deck),
            "isLastQuestion": self.question_index + 1 >= len(self.deck),
        }

    def _should_announce_scores(self) -> bool:
        number = self.question_index + 1
        return number % 2 == 0 and number < len(self.deck)

    def _next_step_hint(self) -> str:
        if self.phase == Phase.LOBBY:
            return (f"Accueille les joueurs et annonce le thème du blind test ({self.theme}). "
                    "Quand l'hôte te demande de lancer, appelle start_game.")
        if self.phase == Phase.QUESTION_READING:
            return "Annonce la chanson si ce n'est pas fait, puis appelle start_timer et tais-toi pendant la musique."
        if self.phase in BUZZABLE_PHASES:
            return "Chrono lancé : tais-toi et attends un message BUZZ ou TIMEOUT."
        if self.phase == Phase.ANSWERING:
            name = self.players[self.answering].name
            return f"{name} a la main : écoute UNE réponse, puis appelle submit_verdict avec artist et title."
        if self.phase == Phase.REVEAL:
            last = self.question_index + 1 >= len(self.deck)
            then = "puis appelle next_question pour terminer la partie" if last else "puis appelle next_question"
            if self.answer_revealed:
                return f"Réponse déjà donnée : {then}."
            return f"Si l'artiste et le titre n'ont pas été dits, appelle reveal_answer et annonce-les, {then}."
        return "La partie est terminée : annonce le podium."

    def _teasing_material(self, ranking: list[dict]) -> list[str]:
        """Facts the agent can use to tease players (gently)."""
        facts: list[str] = []
        if len(ranking) >= 2:
            last = ranking[-1]
            if last["rank"] != 1:
                facts.append(f"{last['name']} est dernier·e avec {last['score']} point(s).")
        for player in self.players.values():
            if player.streak >= 2:
                facts.append(f"{player.name} est en série de {player.streak} bonnes réponses.")
            if player.wrong_answers >= 2:
                facts.append(f"{player.name} a déjà donné {player.wrong_answers} mauvaises réponses.")
            if self.question_index >= 1 and player.score == 0:
                facts.append(f"{player.name} n'a toujours aucun point.")
        return facts

    def _set_deadline(self, kind: str, now: float, duration: float) -> None:
        self.deadline_kind = kind
        self.deadline_total = duration
        if self.paused:
            # The host acted during a pause: keep the new timer frozen until resume().
            self.paused_remaining = duration
            self.deadline = None
        else:
            self.deadline = now + duration

    def _clear_deadline(self) -> None:
        self.deadline = self.deadline_kind = None
        if self.paused:
            self.paused_remaining = math.inf


# Blind test scoring: (artist found, title found) -> points.
SONG_POINTS = {(False, False): 0, (True, False): 1, (False, True): 1, (True, True): 3}


def _song_answer(song: SongQuestion) -> str:
    return f"{song.artist} — {song.title}"

