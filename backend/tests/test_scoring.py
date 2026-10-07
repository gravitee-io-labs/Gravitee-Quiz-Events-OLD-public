"""Pure tests for services/scoring.py (no database, no HTTP)."""
import math
from types import SimpleNamespace

import pytest

from app.services.scoring import (
    AnswerScore,
    GameTotals,
    ScoringRules,
    clamp_time,
    score_answer,
    summarize,
    time_bonus,
)

RULES = ScoringRules(timer_seconds=20, points_correct=100, points_wrong=0, time_bonus_max=50)


# ---------------------------------------------------------------------------------------------
# clamp_time
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "value,expected",
    [
        (5, 5.0),
        (0, 0.0),
        (20, 20.0),
        (20.0001, 20.0),
        (9999, 20.0),
        (-3, 0.0),
        (-0.0, 0.0),
        (7.123456, 7.123),
        (float("inf"), 20.0),
        (float("-inf"), 20.0),
        (float("nan"), 20.0),
        ("abc", 20.0),
        (None, 20.0),
    ],
)
def test_clamp_time(value, expected):
    assert clamp_time(value, 20) == expected


# ---------------------------------------------------------------------------------------------
# time_bonus: int(time_bonus_max * (1 - t / timer))
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "t,expected",
    [
        (0, 50),  # instant answer: full bonus
        (5, 37),  # 50 * 0.75 = 37.5 -> 37 (floor)
        (10, 25),
        (15, 12),  # 12.5 -> 12
        (19, 2),  # 2.5 -> 2
        (19.99, 0),
        (20, 0),  # at the buzzer: nothing
        (60, 0),  # past the timer (clamped)
        (-4, 50),  # negative (clamped to 0)
    ],
)
def test_time_bonus_linear_floor(t, expected):
    assert time_bonus(50, t, 20) == expected


def test_time_bonus_matches_the_documented_formula_and_never_exceeds_it():
    for bonus in (1, 10, 50, 100, 250):
        for timer in (5, 10, 20, 30, 120):
            for tenth in range(0, timer * 10 + 1):
                t = tenth / 10
                exact = bonus * (1 - t / timer)
                got = time_bonus(bonus, t, timer)
                assert got == math.floor(exact + 1e-9), (bonus, timer, t)
                assert 0 <= got <= bonus


def test_time_bonus_is_monotonic_non_increasing():
    values = [time_bonus(100, t / 100, 20) for t in range(0, 2001)]
    assert values == sorted(values, reverse=True)
    assert values[0] == 100 and values[-1] == 0


def test_time_bonus_is_immune_to_float_rounding():
    # 100 * (1 - 0.07/20)... style products used to produce 99.99999 -> 99 with plain floats
    assert time_bonus(100, 0.0, 20) == 100
    assert time_bonus(30, 2, 20) == 27  # 30 * 0.9 = 27 exactly
    assert time_bonus(70, 6, 20) == 49  # 70 * 0.7 = 49 exactly


@pytest.mark.parametrize("bonus,timer", [(0, 20), (-5, 20), (50, 0), (50, -1)])
def test_time_bonus_degenerate_rules(bonus, timer):
    assert time_bonus(bonus, 3, timer) == 0


def test_time_bonus_non_finite_time_counts_as_the_full_timer():
    assert time_bonus(50, float("nan"), 20) == 0
    assert time_bonus(50, float("inf"), 20) == 0


# ---------------------------------------------------------------------------------------------
# score_answer
# ---------------------------------------------------------------------------------------------
def test_correct_answer_scores_base_plus_bonus():
    score = score_answer(RULES, "green", "green", 5)
    assert score == AnswerScore("correct", True, 137, 5.0)


def test_correct_answer_at_zero_and_at_the_timer():
    assert score_answer(RULES, "red", "red", 0).points == 150
    assert score_answer(RULES, "red", "red", 20).points == 100
    assert score_answer(RULES, "red", "red", 500).points == 100  # clamped
    assert score_answer(RULES, "red", "red", 500).time_taken == 20.0


def test_wrong_answer_scores_points_wrong():
    assert score_answer(RULES, "green", "red", 3) == AnswerScore("wrong", False, 0, 3.0)
    penalty = ScoringRules(20, 100, 10, 50)
    assert score_answer(penalty, "green", "red", 3).points == 10
    assert score_answer(penalty, "green", "red", 3).is_correct is False


def test_wrong_answer_never_gets_a_time_bonus():
    penalty = ScoringRules(20, 100, 10, 50)
    assert score_answer(penalty, "green", "red", 0).points == 10


def test_unanswered_scores_zero_and_is_not_wrong():
    score = score_answer(RULES, "green", None, 20)
    assert score == AnswerScore("unanswered", None, 0, 20.0)
    assert score.is_correct is None


def test_unanswered_ignores_points_wrong():
    penalty = ScoringRules(20, 100, 10, 50)
    assert score_answer(penalty, "green", None, 20).points == 0


def test_garbage_answer_counts_as_unanswered():
    assert score_answer(RULES, "green", "blue", 2).outcome == "unanswered"
    assert score_answer(RULES, "green", "", 2).outcome == "unanswered"


def test_missing_time_means_no_bonus_but_the_answer_still_counts():
    score = score_answer(RULES, "green", "green", None)
    assert score.outcome == "correct"
    assert score.points == 100  # base points only
    assert score.time_taken is None


def test_zero_bonus_rule():
    rules = ScoringRules(20, 100, 0, 0)
    assert score_answer(rules, "green", "green", 0).points == 100


def test_custom_rules():
    rules = ScoringRules(timer_seconds=10, points_correct=200, points_wrong=5, time_bonus_max=100)
    assert score_answer(rules, "green", "green", 2.5).points == 275
    assert score_answer(rules, "green", "red", 2.5).points == 5


# ---------------------------------------------------------------------------------------------
# summarize
# ---------------------------------------------------------------------------------------------
def test_summarize_counts_each_outcome():
    scores = [
        score_answer(RULES, "green", "green", 0),  # 150
        score_answer(RULES, "green", "green", 20),  # 100
        score_answer(RULES, "green", "red", 1),  # 0
        score_answer(RULES, "green", None, 20),  # 0
        AnswerScore("unanswered", None, 0, None),  # missing from the submission
    ]
    assert summarize(scores) == GameTotals(total_score=250, correct=2, wrong=1, unanswered=2)


def test_summarize_empty():
    assert summarize([]) == GameTotals(0, 0, 0, 0)


# ---------------------------------------------------------------------------------------------
# ScoringRules
# ---------------------------------------------------------------------------------------------
def test_rules_from_event_and_to_config_roundtrip():
    event = SimpleNamespace(timer_seconds=15, points_correct=120, points_wrong=3, time_bonus_max=60)
    rules = ScoringRules.from_event(event)
    assert rules == ScoringRules(15, 120, 3, 60)
    assert ScoringRules.from_config(rules.to_config(), ScoringRules()) == rules


def test_rules_from_config_uses_the_snapshot_over_the_fallback():
    fallback = ScoringRules(20, 100, 0, 50)
    snapshot = {"timer_seconds": 30, "points_correct": 10, "points_wrong": 1, "time_bonus_max": 5, "questions_per_game": 9}
    assert ScoringRules.from_config(snapshot, fallback) == ScoringRules(30, 10, 1, 5)


@pytest.mark.parametrize("config", [None, {}, {"timer_seconds": None}, {"timer_seconds": "x"}, {"timer_seconds": True}])
def test_rules_from_config_falls_back_on_missing_or_invalid_values(config):
    fallback = ScoringRules(25, 90, 2, 40)
    assert ScoringRules.from_config(config, fallback) == fallback


def test_rules_from_config_sanitises_ranges():
    fallback = ScoringRules()
    rules = ScoringRules.from_config(
        {"timer_seconds": 0, "points_correct": -5, "points_wrong": -1, "time_bonus_max": float("nan")}, fallback
    )
    assert rules.timer_seconds == 1  # never divide by zero
    assert rules.points_correct == 0
    assert rules.points_wrong == 0
    assert rules.time_bonus_max == fallback.time_bonus_max


def test_rules_are_immutable():
    with pytest.raises(AttributeError):
        RULES.timer_seconds = 5  # type: ignore[misc]
