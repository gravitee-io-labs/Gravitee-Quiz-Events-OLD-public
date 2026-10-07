"""
Server-side scoring (docs/ARCHITECTURE.md section 4). Pure functions, no I/O.

* correct     -> ``points_correct + int(time_bonus_max * (1 - t / timer))`` with ``t`` clamped to
                 ``[0, timer_seconds]``
* wrong       -> ``points_wrong``
* unanswered  -> 0 (``player_answer`` null, or the question is missing from the submission)

The bonus is computed with integer arithmetic on millisecond precision (``t`` rounded to 1 ms), which
is the mathematically exact floor of the formula above and immune to float rounding surprises
(``50 * (1 - 3/20)`` style products that land on ``41.99999``).
"""
from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Optional

__all__ = [
    "AnswerScore",
    "GameTotals",
    "ScoringRules",
    "clamp_time",
    "score_answer",
    "summarize",
    "time_bonus",
]

Outcome = Literal["correct", "wrong", "unanswered"]
_ANSWERS = ("green", "red")


@dataclass(frozen=True)
class ScoringRules:
    """The rules a game is scored with (snapshotted in ``GameSession.game_config`` at start)."""

    timer_seconds: int = 20
    points_correct: int = 100
    points_wrong: int = 0
    time_bonus_max: int = 50

    @classmethod
    def from_event(cls, event: Any) -> ScoringRules:
        """From anything with the four rule attributes (an ``Event``)."""
        return cls(
            timer_seconds=event.timer_seconds,
            points_correct=event.points_correct,
            points_wrong=event.points_wrong,
            time_bonus_max=event.time_bonus_max,
        )

    @classmethod
    def from_config(cls, config: Optional[Mapping[str, Any]], fallback: ScoringRules) -> ScoringRules:
        """From a stored ``game_config`` snapshot; missing / invalid keys fall back to ``fallback``."""
        config = config or {}

        def read(key: str, default: int, minimum: int) -> int:
            value = config.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                return default
            return max(minimum, int(value))

        return cls(
            timer_seconds=read("timer_seconds", fallback.timer_seconds, 1),
            points_correct=read("points_correct", fallback.points_correct, 0),
            points_wrong=read("points_wrong", fallback.points_wrong, 0),
            time_bonus_max=read("time_bonus_max", fallback.time_bonus_max, 0),
        )

    def to_config(self) -> dict[str, int]:
        return {
            "timer_seconds": self.timer_seconds,
            "points_correct": self.points_correct,
            "points_wrong": self.points_wrong,
            "time_bonus_max": self.time_bonus_max,
        }


@dataclass(frozen=True)
class AnswerScore:
    outcome: Outcome
    is_correct: Optional[bool]  # None when unanswered
    points: int
    time_taken: Optional[float]  # clamped seconds; None when the question was not submitted


@dataclass(frozen=True)
class GameTotals:
    total_score: int = 0
    correct: int = 0
    wrong: int = 0
    unanswered: int = 0


def clamp_time(time_taken: float, timer_seconds: int) -> float:
    """``time_taken`` forced into ``[0, timer_seconds]`` (1 ms precision); NaN / inf count as the full timer."""
    try:
        value = float(time_taken)
    except (TypeError, ValueError):
        return float(timer_seconds)
    if not math.isfinite(value):
        return float(timer_seconds)
    return round(min(max(value, 0.0), float(timer_seconds)), 3)


def time_bonus(time_bonus_max: int, time_taken: float, timer_seconds: int) -> int:
    """``int(time_bonus_max * (1 - t / timer))`` with ``t`` clamped to ``[0, timer]``, computed exactly."""
    if time_bonus_max <= 0 or timer_seconds <= 0:
        return 0
    timer_ms = timer_seconds * 1000
    elapsed_ms = round(clamp_time(time_taken, timer_seconds) * 1000)
    return time_bonus_max * (timer_ms - elapsed_ms) // timer_ms


def score_answer(
    rules: ScoringRules,
    correct_answer: str,
    player_answer: Optional[str],
    time_taken: Optional[float],
) -> AnswerScore:
    """Score one answer. ``time_taken`` is the client reported time, clamped here."""
    clamped = None if time_taken is None else clamp_time(time_taken, rules.timer_seconds)
    if player_answer not in _ANSWERS:  # null (or garbage): the player did not answer
        return AnswerScore("unanswered", None, 0, clamped)
    if player_answer == correct_answer:
        bonus = time_bonus(rules.time_bonus_max, clamped if clamped is not None else rules.timer_seconds,
                           rules.timer_seconds)
        return AnswerScore("correct", True, rules.points_correct + bonus, clamped)
    return AnswerScore("wrong", False, rules.points_wrong, clamped)


def summarize(scores: Iterable[AnswerScore]) -> GameTotals:
    total = correct = wrong = unanswered = 0
    for score in scores:
        total += score.points
        if score.outcome == "correct":
            correct += 1
        elif score.outcome == "wrong":
            wrong += 1
        else:
            unanswered += 1
    return GameTotals(total_score=total, correct=correct, wrong=wrong, unanswered=unanswered)
