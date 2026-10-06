import random

import pytest

from app.game import BuzzResult, Game, GameError, GameSettings, Phase
from app.models import QuizQuestion


def make_questions(n: int = 10) -> list[QuizQuestion]:
    return [
        QuizQuestion(id=f"q{i}", category="Test", question=f"Question {i} ?", answer=f"R{i}",
                     acceptedAnswers=[f"r{i}"])
        for i in range(n)
    ]


def make_game(players: int = 3, total: int = 5, **settings) -> Game:
    game = Game(make_questions(), GameSettings(total_questions=total, **settings), rng=random.Random(42))
    for i in range(players):
        game.add_player(f"p{i}", f"Joueur {i}")
    return game


def started_game(players: int = 3, total: int = 5, now: float = 0.0, **settings) -> Game:
    game = make_game(players, total, **settings)
    game.start_game(now)
    return game


# --------------------------------------------------------------------- lobby

def test_new_game_is_in_lobby_with_unique_deck():
    game = make_game(total=5)
    assert game.phase == Phase.LOBBY
    assert len(game.deck) == 5
    assert len({q.id for q in game.deck}) == 5


def test_total_is_capped_by_bank_size():
    game = Game(make_questions(3), GameSettings(total_questions=10))
    assert game.settings.total_questions == 3


def test_duplicate_names_are_suffixed_and_rejoin_keeps_player():
    game = make_game(players=0)
    first, events = game.add_player("a", "Léa")
    second, _ = game.add_player("b", "léa")
    assert events[0]["type"] == "player_joined"
    assert second.name == "léa 2"
    game.set_connected("a", False)
    again, events = game.add_player("a", "Autre nom")
    assert again is first and again.connected and again.name == "Léa"
    assert events == []


def test_blank_name_is_rejected():
    with pytest.raises(GameError):
        make_game(players=0).add_player("a", "   ")


def test_start_requires_a_player():
    with pytest.raises(GameError):
        make_game(players=0).start_game(0)


def test_start_game_opens_first_question_with_accepted_answers():
    game = make_game()
    payload, events = game.start_game(0)
    assert game.phase == Phase.QUESTION_READING
    assert payload["index"] == 1 and payload["total"] == 5
    assert payload["acceptedAnswers"] == game.current_question.acceptedAnswers
    assert "answer" not in payload
    assert [e["type"] for e in events] == ["game_started", "question"]


def test_next_question_before_start_is_an_error():
    with pytest.raises(GameError):
        make_game().next_question(0)


def test_next_question_during_question_returns_current_one():
    game = started_game()
    first = game.current_question
    payload, events = game.next_question(1)
    assert game.current_question is first
    assert payload["note"] and events == []


# ------------------------------------------------------------------ buzzing

def test_buzz_is_allowed_while_reading():
    game = started_game()
    result, events = game.buzz("p1", 2.0)
    assert result == BuzzResult.ACCEPTED
    assert game.phase == Phase.ANSWERING and game.answering == "p1"
    assert events[0]["type"] == "buzz_winner" and events[0]["reactionS"] == 2.0


def test_reading_done_opens_buzz_window():
    game = started_game()
    events = game.reading_done(3.0)
    assert game.phase == Phase.BUZZ_OPEN
    assert game.deadline == pytest.approx(3.0 + game.settings.buzz_window_s)
    assert events[0]["type"] == "buzz_open"
    assert game.reading_done(4.0) == []  # idempotent


def test_reading_fallback_opens_buzz_window():
    game = started_game(reading_fallback_s=15)
    assert game.tick(14.9) == []
    events = game.tick(15.0)
    assert game.phase == Phase.BUZZ_OPEN and events[0]["type"] == "buzz_open"


def test_first_received_buzz_wins_among_twenty_near_simultaneous_buzzes():
    game = make_game(players=20)
    game.start_game(0)
    game.reading_done(1)
    results = [game.buzz(f"p{i}", 5.0 + i * 1e-6)[0] for i in range(20)]
    assert results[0] == BuzzResult.ACCEPTED
    assert results[1:] == [BuzzResult.TOO_LATE] * 19
    assert game.answering == "p0"


def test_arbitration_is_deterministic_for_any_arrival_order():
    for seed in range(50):
        order = [f"p{i}" for i in range(20)]
        random.Random(seed).shuffle(order)
        game = make_game(players=20)
        game.start_game(0)
        winners = [pid for pid in order if game.buzz(pid, 5.0)[0] == BuzzResult.ACCEPTED]
        assert winners == [order[0]]


def test_buzz_log_keeps_order_of_ignored_buzzes():
    game = started_game()
    for pid in ("p2", "p0", "p1"):
        game.buzz(pid, 1.0)
    assert [r.player_id for r in game.buzz_log] == ["p2", "p0", "p1"]
    assert [r.result for r in game.buzz_log] == [BuzzResult.ACCEPTED, BuzzResult.TOO_LATE, BuzzResult.TOO_LATE]


def test_buzz_rate_limit_is_300ms_per_player():
    game = started_game()
    game.buzz("p0", 1.0)  # wins
    assert game.buzz("p0", 1.1)[0] == BuzzResult.RATE_LIMITED
    assert game.buzz("p0", 1.31)[0] == BuzzResult.ALREADY_ANSWERING
    assert game.buzz("p1", 1.1)[0] == BuzzResult.TOO_LATE  # other players are not affected


def test_buzz_in_lobby_reveal_and_unknown_player():
    game = make_game()
    assert game.buzz("p0", 0)[0] == BuzzResult.NOT_OPEN
    game.start_game(1)
    assert game.buzz("ghost", 2)[0] == BuzzResult.UNKNOWN_PLAYER
    game.buzz("p0", 2)
    game.submit_verdict("p0", True, 3)
    assert game.phase == Phase.REVEAL
    assert game.buzz("p1", 4)[0] == BuzzResult.TOO_LATE


# ------------------------------------------------------------------ verdicts

def test_correct_answer_scores_and_reveals():
    game = started_game()
    game.buzz("p0", 1)
    payload, events = game.submit_verdict("p0", True, 2)
    assert game.players["p0"].score == 1
    assert game.phase == Phase.REVEAL
    assert payload["verdict"] == "correct" and payload["newScore"] == 1
    assert events[0]["correct"] is True and events[0]["next"] == "REVEAL"


def test_wrong_answer_locks_player_and_reopens_buzz():
    game = started_game()
    game.buzz("p0", 1)
    payload, events = game.submit_verdict("p0", False, 2)
    assert game.phase == Phase.BUZZ_OPEN
    assert "p0" in game.locked and game.players["p0"].score == 0
    assert game.deadline == pytest.approx(2 + game.settings.rebuzz_window_s)
    assert events[0]["remaining"] == ["Joueur 1", "Joueur 2"]
    assert "Relance" in payload["nextStep"]
    assert game.buzz("p0", 3)[0] == BuzzResult.LOCKED
    assert game.buzz("p1", 3)[0] == BuzzResult.ACCEPTED


def test_everyone_wrong_goes_to_reveal():
    game = started_game(players=2)
    game.buzz("p0", 1)
    game.submit_verdict("p0", False, 2)
    game.buzz("p1", 3)
    _, events = game.submit_verdict("p1", False, 4)
    assert game.phase == Phase.REVEAL
    assert events[0]["allWrong"] is True


def test_disconnected_players_do_not_keep_the_question_open():
    game = started_game(players=2)
    game.set_connected("p1", False)
    game.buzz("p0", 1)
    game.submit_verdict("p0", False, 2)
    assert game.phase == Phase.REVEAL


def test_verdict_for_wrong_player_or_phase_is_rejected():
    game = started_game()
    with pytest.raises(GameError):
        game.submit_verdict("p0", True, 1)
    game.buzz("p0", 1)
    with pytest.raises(GameError, match="Joueur 0"):
        game.submit_verdict("p1", True, 2)


def test_lock_resets_on_next_question():
    game = started_game(players=1)
    game.buzz("p0", 1)
    game.submit_verdict("p0", False, 2)
    game.next_question(3)
    assert game.locked == set()
    assert game.buzz("p0", 4)[0] == BuzzResult.ACCEPTED


# ------------------------------------------------------------------ timeouts

def test_no_buzz_times_out_to_reveal():
    game = started_game()
    game.reading_done(5)
    assert game.tick(24.9) == []
    events = game.tick(25)
    assert game.phase == Phase.REVEAL
    assert events[0]["type"] == "buzz_timeout"


def test_answer_window_then_hard_timeout_counts_wrong():
    game = started_game()
    game.buzz("p0", 10)
    events = game.tick(18)
    assert events == [{"type": "answer_time_up", "playerId": "p0", "name": "Joueur 0"}]
    assert game.phase == Phase.ANSWERING  # the agent may still judge
    events = game.tick(30)
    assert [e["type"] for e in events] == ["answer_timeout", "verdict"]
    assert events[1]["by"] == "timeout"
    assert "p0" in game.locked and game.phase == Phase.BUZZ_OPEN


def test_late_verdict_after_hard_timeout_is_rejected():
    game = started_game(players=1)
    game.buzz("p0", 0)
    game.tick(100)
    game.tick(100)
    with pytest.raises(GameError):
        game.submit_verdict("p0", True, 101)


def test_pause_freezes_and_resume_restores_timer():
    game = started_game()
    game.reading_done(0)  # deadline at 20
    game.pause(5)
    assert game.tick(100) == []
    assert game.buzz("p0", 101)[0] == BuzzResult.NOT_OPEN
    game.resume(200)
    assert game.deadline == pytest.approx(215)


# ------------------------------------------------------------- reveal & end

def test_reveal_answer_only_after_the_question_is_closed():
    game = started_game()
    with pytest.raises(GameError):
        game.reveal_answer()
    game.buzz("p0", 1)
    with pytest.raises(GameError):
        game.reveal_answer()
    game.submit_verdict("p0", True, 2)
    assert game.reveal_answer()["answer"] == game.current_question.answer


def test_public_state_hides_answer_until_reveal():
    game = started_game()
    state = game.public_state(1)
    assert state["question"]["text"] and state["answer"] is None
    assert "acceptedAnswers" not in str(state)
    game.buzz("p0", 1)
    game.submit_verdict("p0", True, 2)
    assert game.public_state(3)["answer"] == game.current_question.answer


def test_player_state_flags():
    game = started_game()
    assert game.player_state("p0", 0)["canBuzz"] is True
    game.buzz("p0", 1)
    assert game.player_state("p0", 1)["hasHand"] is True
    assert game.player_state("p1", 1)["answeringName"] == "Joueur 0"
    assert game.player_state("p1", 1)["canBuzz"] is False


def test_full_game_until_finished_with_ties():
    game = started_game(players=3, total=3)
    for i in range(3):
        game.buzz(f"p{i % 2}", 10 * i + 1)
        game.submit_verdict(f"p{i % 2}", True, 10 * i + 2)
        payload, events = game.next_question(10 * i + 3)
    assert game.phase == Phase.FINISHED
    assert payload["finished"] is True
    assert payload["winners"] == ["Joueur 0"]
    assert events == [{"type": "finished", "winners": ["Joueur 0"]}]
    ranking = game.ranking()
    assert [(r["name"], r["rank"]) for r in ranking] == [("Joueur 0", 1), ("Joueur 1", 2), ("Joueur 2", 3)]


def test_ranking_ties_share_rank():
    game = make_game(players=3)
    game.players["p0"].score = 2
    game.players["p1"].score = 2
    assert [r["rank"] for r in game.ranking()] == [1, 1, 3]


def test_scores_are_announced_every_two_questions():
    game = started_game(total=5)
    game.buzz("p0", 1)
    first, _ = game.submit_verdict("p0", True, 2)
    game.next_question(3)
    game.buzz("p0", 4)
    second, _ = game.submit_verdict("p0", True, 5)
    assert first["announceScores"] is False
    assert second["announceScores"] is True


def test_locked_player_spamming_is_reported_once():
    game = started_game(spam_tease_threshold=3)
    game.buzz("p0", 0)
    game.submit_verdict("p0", False, 0.1)
    events = []
    for i in range(6):
        events += game.buzz("p0", 1 + i)[1]
    assert [e["type"] for e in events] == ["locked_spam"]


def test_hardware_source_is_recorded():
    game = started_game()
    _, events = game.buzz("p0", 1, source="hardware")
    assert events[0]["source"] == "hardware"
    assert game.buzz_log[-1].source == "hardware"


def test_forced_next_question_skips_the_current_one():
    game = started_game()
    game.buzz("p0", 1)
    payload, events = game.next_question(2, force=True)
    assert payload["index"] == 2
    assert [e["type"] for e in events] == ["question_skipped", "question"]
    assert game.phase == Phase.QUESTION_READING and game.answering is None


def test_timeout_reveal_keeps_answer_hidden_until_said():
    game = started_game()
    game.reading_done(0)
    game.tick(100)
    assert game.phase == Phase.REVEAL
    assert game.public_state(100)["answer"] is None
    game.reveal_answer()
    assert game.public_state(100)["answer"] == game.current_question.answer
