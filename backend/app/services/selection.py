"""
Question selection for a new game (docs/ARCHITECTURE.md section 4). Pure functions, no I/O.

Rules
-----
* ``category_distribution`` set  -> allocate by normalised weights with the largest-remainder method.
  Unset / empty                  -> equal split across the categories that have questions.
* A category that cannot provide its share (too few questions) hands the shortfall to the other
  categories, again proportionally to their weights (and so on until nobody can take more).
* Whatever is still missing is filled at random from the remaining questions (other categories not
  in the distribution, uncategorised questions...).
* Not enough questions in total -> ``NotEnoughQuestions``.
* ``order="easy_to_hard"``: sorted by difficulty ascending, random inside one difficulty;
  ``"random"`` (default): shuffled.

All randomness goes through the ``random.Random`` instance given as ``rng`` so tests are deterministic.

The functions work on any objects exposing ``id``, ``category_id`` and ``difficulty`` (ORM rows,
named tuples...).
"""
from __future__ import annotations

import random
from collections.abc import Hashable, Mapping, Sequence
from fractions import Fraction
from typing import Any, Protocol

__all__ = [
    "NotEnoughQuestions",
    "SelectableQuestion",
    "allocate_counts",
    "largest_remainder",
    "parse_distribution",
    "select_questions",
]


class SelectableQuestion(Protocol):
    id: int
    category_id: int | None
    difficulty: int


class NotEnoughQuestions(ValueError):
    """Fewer eligible questions than the game needs."""

    def __init__(self, available: int, required: int):
        super().__init__(f"not enough questions: {available} available, {required} required")
        self.available = available
        self.required = required


def parse_distribution(distribution: Mapping[Any, Any] | None) -> dict[int, Fraction]:
    """``{"<category_id>": weight}`` -> ``{category_id: Fraction}`` keeping only usable entries.

    Non numeric keys, non numeric / non positive / non finite weights are ignored (the stored JSON is
    validated on write, this is only a safety net for hand edited rows).
    """
    result: dict[int, Fraction] = {}
    for key, raw in (distribution or {}).items():
        try:
            category_id = int(key)
            if isinstance(raw, bool):
                continue
            weight = Fraction(raw)
        except (TypeError, ValueError, ZeroDivisionError, OverflowError):
            continue
        if weight > 0:
            result[category_id] = weight
    return result


def largest_remainder[K: Hashable](total: int, weights: Mapping[K, Any], rng: random.Random) -> dict[K, int]:
    """Split ``total`` units proportionally to ``weights`` with the largest-remainder method.

    Every key gets the floor of its exact quota, the units left over go to the keys with the biggest
    fractional parts; exact ties are broken at random (``rng``). The result always sums to ``total``.

    >>> largest_remainder(10, {"a": 50, "b": 30, "c": 20}, random.Random(0))
    {'a': 5, 'b': 3, 'c': 2}
    """
    if total < 0:
        raise ValueError("total must be >= 0")
    exact_weights = {key: Fraction(weight) for key, weight in weights.items()}
    if any(w < 0 for w in exact_weights.values()):
        raise ValueError("weights must be >= 0")
    weight_sum = sum(exact_weights.values(), Fraction(0))
    if weight_sum <= 0:
        raise ValueError("weights must have a positive sum")

    quotas = {key: total * w / weight_sum for key, w in exact_weights.items()}
    counts = {key: int(quota) for key, quota in quotas.items()}  # floor (quotas are >= 0)
    leftover = total - sum(counts.values())
    if leftover:
        keys = list(quotas)
        rng.shuffle(keys)  # random tie-break: the sort below is stable
        keys.sort(key=lambda k: quotas[k] - counts[k], reverse=True)
        for key in keys[:leftover]:
            counts[key] += 1
    return counts


def allocate_counts[K: Hashable](
    total: int,
    weights: Mapping[K, Any],
    capacities: Mapping[K, int],
    rng: random.Random,
) -> tuple[dict[K, int], int]:
    """Weighted allocation of ``total`` slots with capacity limits and shortfall redistribution.

    Returns ``(counts, unallocated)``: ``counts[key] <= capacities[key]`` for every key and
    ``sum(counts) + unallocated == total``. ``unallocated > 0`` only when every key with a positive
    weight is exhausted (the caller then fills from the other questions).
    """
    counts: dict[K, int] = dict.fromkeys(weights, 0)
    remaining = total
    live = {k: Fraction(w) for k, w in weights.items() if w > 0 and capacities.get(k, 0) > 0}
    while remaining > 0 and live:
        quotas = largest_remainder(remaining, live, rng)
        given = 0
        for key, quota in quotas.items():
            take = min(quota, capacities[key] - counts[key])
            counts[key] += take
            given += take
        remaining -= given
        # a category that reached its capacity hands its shortfall to the others next round
        live = {k: w for k, w in live.items() if counts[k] < capacities[k]}
        if given == 0:  # defensive: cannot happen (live keys all have spare capacity)
            break
    return counts, remaining


def select_questions[Q: SelectableQuestion](
    questions: Sequence[Q],
    count: int,
    distribution: Mapping[Any, Any] | None = None,
    order: str = "random",
    rng: random.Random | None = None,
) -> list[Q]:
    """Pick ``count`` questions for one game, already in play order.

    ``questions`` must be the eligible pool (active questions of the event). Raises
    ``NotEnoughQuestions`` when the pool is smaller than ``count``. Never returns duplicates.
    """
    rng = rng or random.Random()
    pool = list(questions)
    if count < 1:
        return []
    if len(pool) < count:
        raise NotEnoughQuestions(len(pool), count)

    # group by category; each group is shuffled once so "the first n" is a random sample
    groups: dict[int | None, list[Q]] = {}
    for question in pool:
        groups.setdefault(question.category_id, []).append(question)
    category_ids = sorted(k for k in groups if k is not None)
    group_order: list[int | None] = [*category_ids, *([None] if None in groups else [])]
    for key in group_order:
        rng.shuffle(groups[key])

    configured = parse_distribution(distribution)
    weights = {cid: configured[cid] for cid in category_ids if cid in configured}
    if not weights:  # no distribution, or it only names categories that have no questions
        weights = {cid: Fraction(1) for cid in category_ids}  # equal split
    capacities = {cid: len(groups[cid]) for cid in category_ids}

    counts, missing = allocate_counts(count, weights, capacities, rng)

    selected: list[Q] = []
    leftovers: list[Q] = []
    for key in group_order:
        taken = counts.get(key, 0) if key is not None else 0
        selected.extend(groups[key][:taken])
        leftovers.extend(groups[key][taken:])
    if missing:
        rng.shuffle(leftovers)
        selected.extend(leftovers[:missing])

    rng.shuffle(selected)  # mix the categories
    if order == "easy_to_hard":
        selected.sort(key=lambda q: q.difficulty or 1)  # stable: random inside one difficulty
    return selected
