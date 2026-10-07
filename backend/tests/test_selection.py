"""Pure tests for services/selection.py (no database, no HTTP)."""
import random
from collections import Counter
from fractions import Fraction
from typing import NamedTuple, Optional

import pytest

from app.services.selection import (
    NotEnoughQuestions,
    allocate_counts,
    largest_remainder,
    parse_distribution,
    select_questions,
)


class Q(NamedTuple):
    id: int
    category_id: Optional[int]
    difficulty: int = 1


def make_pool(spec: dict, difficulty=lambda i: 1) -> list[Q]:
    """spec: {category_id|None: number_of_questions}"""
    pool, next_id = [], 1
    for category_id, n in spec.items():
        for _ in range(n):
            pool.append(Q(next_id, category_id, difficulty(next_id)))
            next_id += 1
    return pool


def per_category(selected) -> Counter:
    return Counter(q.category_id for q in selected)


# ---------------------------------------------------------------------------------------------
# parse_distribution
# ---------------------------------------------------------------------------------------------
def test_parse_distribution_keeps_usable_entries_only():
    parsed = parse_distribution({"1": 50, "2": 0, "3": -4, "x": 10, "4": "30", "5": None, "6": True, "7": 2.5})
    assert parsed == {1: Fraction(50), 4: Fraction(30), 7: Fraction(5, 2)}


@pytest.mark.parametrize("value", [None, {}, []])
def test_parse_distribution_empty(value):
    assert parse_distribution(value) == {}


# ---------------------------------------------------------------------------------------------
# largest_remainder
# ---------------------------------------------------------------------------------------------
def test_largest_remainder_exact_split():
    assert largest_remainder(10, {"a": 50, "b": 30, "c": 20}, random.Random(0)) == {"a": 5, "b": 3, "c": 2}


def test_largest_remainder_gives_leftovers_to_biggest_fractions():
    # quotas 3.33 / 3.33 / 3.33 -> everybody 3, the single leftover goes to one of them
    counts = largest_remainder(10, {"a": 1, "b": 1, "c": 1}, random.Random(1))
    assert sorted(counts.values()) == [3, 3, 4]
    # quotas 5.14 / 2.57 / 1.29 -> floors 5/2/1 -> the single leftover goes to b (biggest fraction .57)
    counts = largest_remainder(9, {"a": 4, "b": 2, "c": 1}, random.Random(1))
    assert counts == {"a": 5, "b": 3, "c": 1}
    assert sum(counts.values()) == 9


def test_largest_remainder_ties_are_random_but_reproducible():
    results = {tuple(largest_remainder(1, {"a": 1, "b": 1, "c": 1}, random.Random(seed)).items()) for seed in range(30)}
    winners = {next(k for k, v in dict(r).items() if v) for r in results}
    assert winners == {"a", "b", "c"}  # every key can win a tie
    same = [largest_remainder(1, {"a": 1, "b": 1, "c": 1}, random.Random(5)) for _ in range(3)]
    assert same[0] == same[1] == same[2]


def test_largest_remainder_zero_weight_gets_nothing():
    assert largest_remainder(7, {"a": 1, "b": 0}, random.Random(0)) == {"a": 7, "b": 0}


@pytest.mark.parametrize("total", [0, 1, 7, 15, 50])
def test_largest_remainder_always_sums_to_total(total):
    rng = random.Random(total)
    for _ in range(50):
        weights = {i: rng.randint(0, 40) for i in range(rng.randint(1, 8))}
        if sum(weights.values()) == 0:
            weights[0] = 1
        counts = largest_remainder(total, weights, rng)
        assert sum(counts.values()) == total
        assert all(c >= 0 for c in counts.values())


def test_largest_remainder_rejects_bad_input():
    with pytest.raises(ValueError):
        largest_remainder(5, {"a": 0, "b": 0}, random.Random(0))
    with pytest.raises(ValueError):
        largest_remainder(5, {}, random.Random(0))
    with pytest.raises(ValueError):
        largest_remainder(-1, {"a": 1}, random.Random(0))
    with pytest.raises(ValueError):
        largest_remainder(5, {"a": -1, "b": 3}, random.Random(0))


def test_largest_remainder_accepts_float_weights():
    assert largest_remainder(4, {"a": 0.5, "b": 0.5}, random.Random(0)) == {"a": 2, "b": 2}


# ---------------------------------------------------------------------------------------------
# allocate_counts (capacities + redistribution)
# ---------------------------------------------------------------------------------------------
def test_allocate_counts_respects_capacity_and_redistributes():
    counts, missing = allocate_counts(10, {"a": 50, "b": 30, "c": 20}, {"a": 100, "b": 1, "c": 100}, random.Random(0))
    assert counts["b"] == 1
    assert counts["a"] + counts["c"] == 9
    assert missing == 0
    # the shortfall is shared proportionally to the weights of the others (50:20)
    assert counts["a"] > counts["c"]


def test_allocate_counts_chain_of_exhausted_categories():
    counts, missing = allocate_counts(
        12, {"a": 1, "b": 1, "c": 1}, {"a": 1, "b": 2, "c": 100}, random.Random(0)
    )
    assert counts == {"a": 1, "b": 2, "c": 9}
    assert missing == 0


def test_allocate_counts_reports_what_could_not_be_placed():
    counts, missing = allocate_counts(10, {"a": 1, "b": 1}, {"a": 2, "b": 3}, random.Random(0))
    assert counts == {"a": 2, "b": 3}
    assert missing == 5


def test_allocate_counts_ignores_zero_weight_and_missing_capacity():
    counts, missing = allocate_counts(4, {"a": 0, "b": 1, "ghost": 5}, {"a": 10, "b": 10}, random.Random(0))
    assert counts == {"a": 0, "b": 4, "ghost": 0}
    assert missing == 0


# ---------------------------------------------------------------------------------------------
# select_questions: allocation
# ---------------------------------------------------------------------------------------------
def test_equal_split_without_distribution():
    pool = make_pool({1: 20, 2: 20, 3: 20})
    selected = select_questions(pool, 9, None, "random", random.Random(3))
    assert len(selected) == 9
    assert per_category(selected) == {1: 3, 2: 3, 3: 3}


def test_equal_split_spreads_the_remainder_randomly():
    pool = make_pool({1: 20, 2: 20, 3: 20})
    extra_winners = set()
    for seed in range(40):
        counts = per_category(select_questions(pool, 10, None, "random", random.Random(seed)))
        assert sorted(counts.values()) == [3, 3, 4]
        extra_winners.add(next(c for c, n in counts.items() if n == 4))
    assert extra_winners == {1, 2, 3}


def test_empty_distribution_dict_means_equal_split():
    pool = make_pool({1: 10, 2: 10})
    assert per_category(select_questions(pool, 6, {}, "random", random.Random(1))) == {1: 3, 2: 3}


def test_weighted_distribution():
    pool = make_pool({1: 50, 2: 50, 3: 50})
    selected = select_questions(pool, 10, {"1": 50, "2": 30, "3": 20}, "random", random.Random(1))
    assert per_category(selected) == {1: 5, 2: 3, 3: 2}


def test_weights_are_normalised_not_percentages():
    pool = make_pool({1: 50, 2: 50})
    selected = select_questions(pool, 12, {"1": 1, "2": 3}, "random", random.Random(1))  # weights sum to 4
    assert per_category(selected) == {1: 3, 2: 9}


def test_weighted_largest_remainder_rounding():
    pool = make_pool({1: 50, 2: 50, 3: 50})
    selected = select_questions(pool, 10, {"1": 1, "2": 1, "3": 1}, "random", random.Random(2))
    assert sorted(per_category(selected).values()) == [3, 3, 4]


def test_category_without_enough_questions_redistributes_to_others():
    pool = make_pool({1: 2, 2: 50, 3: 50})
    selected = select_questions(pool, 12, {"1": 50, "2": 25, "3": 25}, "random", random.Random(4))
    counts = per_category(selected)
    assert counts[1] == 2  # everything it has
    assert counts[2] + counts[3] == 10
    assert counts[2] == counts[3] == 5  # equal weights -> equal share of the shortfall


def test_category_with_zero_questions_in_distribution_is_skipped():
    pool = make_pool({2: 30, 3: 30})
    selected = select_questions(pool, 10, {"1": 60, "2": 20, "3": 20}, "random", random.Random(4))
    assert per_category(selected) == {2: 5, 3: 5}  # category 1 does not exist in the pool


def test_categories_missing_from_distribution_are_only_used_as_filler():
    pool = make_pool({1: 3, 2: 30, None: 5})
    # distribution only knows category 1 (3 questions): the rest is filled at random from the others
    selected = select_questions(pool, 10, {"1": 100}, "random", random.Random(6))
    counts = per_category(selected)
    assert counts[1] == 3
    assert sum(counts.values()) == 10
    assert counts[2] + counts.get(None, 0) == 7


def test_distribution_naming_only_unknown_categories_falls_back_to_equal_split():
    pool = make_pool({1: 10, 2: 10})
    selected = select_questions(pool, 8, {"99": 100}, "random", random.Random(6))
    assert per_category(selected) == {1: 4, 2: 4}
    assert len({q.id for q in selected}) == 8


def test_uncategorised_questions_do_not_count_as_a_category_in_equal_split():
    pool = make_pool({1: 10, 2: 10, None: 100})
    selected = select_questions(pool, 10, None, "random", random.Random(6))
    assert per_category(selected) == {1: 5, 2: 5}


def test_uncategorised_only_pool():
    pool = make_pool({None: 12})
    selected = select_questions(pool, 5, None, "random", random.Random(1))
    assert len(selected) == 5
    assert all(q.category_id is None for q in selected)


def test_uncategorised_fill_when_categories_run_out():
    pool = make_pool({1: 2, 2: 2, None: 10})
    selected = select_questions(pool, 8, None, "random", random.Random(1))
    counts = per_category(selected)
    assert counts[1] == 2 and counts[2] == 2 and counts[None] == 4


def test_garbage_in_distribution_is_ignored():
    pool = make_pool({1: 10, 2: 10})
    selected = select_questions(pool, 6, {"1": "oops", "x": 3, "2": -1}, "random", random.Random(1))
    assert per_category(selected) == {1: 3, 2: 3}  # nothing usable -> equal split


# ---------------------------------------------------------------------------------------------
# select_questions: size, uniqueness, errors
# ---------------------------------------------------------------------------------------------
def test_not_enough_questions():
    pool = make_pool({1: 3, 2: 4})
    with pytest.raises(NotEnoughQuestions) as exc:
        select_questions(pool, 8, None, "random", random.Random(1))
    assert (exc.value.available, exc.value.required) == (7, 8)


def test_exactly_enough_questions_uses_all_of_them():
    pool = make_pool({1: 3, 2: 4, None: 1})
    selected = select_questions(pool, 8, {"1": 10, "2": 1}, "random", random.Random(1))
    assert sorted(q.id for q in selected) == sorted(q.id for q in pool)


def test_empty_pool_and_zero_count():
    with pytest.raises(NotEnoughQuestions):
        select_questions([], 1)
    assert select_questions(make_pool({1: 3}), 0) == []


def test_accepts_any_sequence_without_mutating_it():
    pool = make_pool({1: 6, 2: 6})
    snapshot = list(pool)
    select_questions(tuple(pool), 5, None, "random", random.Random(1))
    select_questions(pool, 5, None, "easy_to_hard", random.Random(1))
    assert pool == snapshot


def test_no_duplicates_and_exact_count_over_many_random_setups():
    rng = random.Random(1234)
    for seed in range(300):
        spec = {cid: rng.randint(0, 15) for cid in range(1, rng.randint(1, 6))}
        if rng.random() < 0.5:
            spec[None] = rng.randint(0, 8)
        pool = make_pool(spec, lambda i: rng.randint(1, 3))
        if not pool:
            continue
        count = rng.randint(1, len(pool))
        distribution = None
        if rng.random() < 0.7:
            distribution = {str(cid): rng.randint(0, 50) for cid in list(spec) + [77] if cid is not None}
        order = rng.choice(["random", "easy_to_hard"])
        selected = select_questions(pool, count, distribution, order, random.Random(seed))
        ids = [q.id for q in selected]
        assert len(ids) == count
        assert len(set(ids)) == count
        assert set(ids) <= {q.id for q in pool}
        if order == "easy_to_hard":
            assert [q.difficulty for q in selected] == sorted(q.difficulty for q in selected)


# ---------------------------------------------------------------------------------------------
# select_questions: ordering and determinism
# ---------------------------------------------------------------------------------------------
def test_easy_to_hard_sorts_by_difficulty_and_randomises_inside_a_level():
    pool = make_pool({1: 30, 2: 30}, difficulty=lambda i: (i % 3) + 1)
    first_of_level_one = set()
    for seed in range(20):
        selected = select_questions(pool, 24, None, "easy_to_hard", random.Random(seed))
        difficulties = [q.difficulty for q in selected]
        assert difficulties == sorted(difficulties)
        first_of_level_one.add(selected[0].id)
    assert len(first_of_level_one) > 1  # not always the same easy question first


def test_random_order_actually_shuffles():
    pool = make_pool({1: 30}, difficulty=lambda i: 1 if i <= 10 else 3)
    orders = {tuple(q.id for q in select_questions(pool, 15, None, "random", random.Random(s))) for s in range(10)}
    assert len(orders) > 5
    # not sorted by difficulty either
    some = select_questions(pool, 15, None, "random", random.Random(1))
    assert [q.difficulty for q in some] != sorted(q.difficulty for q in some)


def test_unknown_order_behaves_like_random():
    pool = make_pool({1: 30}, difficulty=lambda i: (i % 3) + 1)
    selected = select_questions(pool, 15, None, "whatever", random.Random(1))
    assert len(selected) == 15
    assert [q.difficulty for q in selected] != sorted(q.difficulty for q in selected)


def test_same_seed_same_result_different_seed_different_result():
    pool = make_pool({1: 30, 2: 30, 3: 30})
    a = [q.id for q in select_questions(pool, 15, {"1": 2, "2": 1, "3": 1}, "random", random.Random(42))]
    b = [q.id for q in select_questions(pool, 15, {"1": 2, "2": 1, "3": 1}, "random", random.Random(42))]
    c = [q.id for q in select_questions(pool, 15, {"1": 2, "2": 1, "3": 1}, "random", random.Random(43))]
    assert a == b
    assert a != c


def test_input_order_of_the_pool_does_not_change_the_result_for_a_seed():
    pool = make_pool({1: 20, 2: 20})
    a = [q.id for q in select_questions(pool, 10, None, "random", random.Random(9))]
    b = [q.id for q in select_questions(list(reversed(pool)), 10, None, "random", random.Random(9))]
    assert len(a) == len(b) == 10
    assert per_category([q for q in pool if q.id in a]) == per_category([q for q in pool if q.id in b])


def test_selection_is_statistically_uniform_inside_a_category():
    pool = make_pool({1: 10})
    hits = Counter()
    rng = random.Random(7)
    for _ in range(2000):
        hits.update(q.id for q in select_questions(pool, 3, None, "random", rng))
    # each question is expected ~600 times (3/10 of 2000)
    assert all(450 < n < 750 for n in hits.values()), hits


def test_default_rng_is_used_when_none_is_given():
    pool = make_pool({1: 10, 2: 10})
    assert len(select_questions(pool, 6)) == 6
