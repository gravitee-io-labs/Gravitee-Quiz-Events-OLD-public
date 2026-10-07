"""Scoreboard data helpers and the in-process SSE hub (services/broadcaster.py).

The hub / generator logic is tested directly (``asyncio.run`` + injected loader and tiny intervals):
no test depends on a TestClient streaming an infinite response.
"""
import asyncio
import json
import threading
import time
from datetime import datetime, timedelta

import pytest

from app.services import broadcaster
from app.services.broadcaster import (
    MAX_ENTRIES,
    ScoreboardHub,
    Snapshot,
    build_snapshot,
    fetch_entries,
    fetch_totals,
    load_snapshot,
    notify_event_changed,
)

WAIT = 3.0  # generous upper bound for things that must happen


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def make_snapshot(scores, total_players=None, total_games=None) -> Snapshot:
    entries = tuple(
        {
            "id": 100 + i, "rank": i + 1, "player_name": f"Player {i + 1}", "score": score,
            "correct_answers": 1, "wrong_answers": 0, "completed_at": "2026-10-07T10:00:00Z",
        }
        for i, score in enumerate(scores)
    )
    return Snapshot(
        entries=entries,
        total_players=len(entries) if total_players is None else total_players,
        total_games=len(entries) if total_games is None else total_games,
    )


class FakeLoader:
    """Thread-safe loader double: per-event scores that tests mutate, plus a call log."""

    def __init__(self, scores=None, delay=0.0):
        self.scores = scores or {1: [300, 200, 100]}
        self.calls: list[int] = []
        self.delay = delay
        self.fail_next = 0
        self._lock = threading.Lock()

    def __call__(self, event_id):
        with self._lock:
            self.calls.append(event_id)
            if self.fail_next:
                self.fail_next -= 1
                raise RuntimeError("database is down")
            scores = list(self.scores.get(event_id, []))
        if self.delay:
            time.sleep(self.delay)
        return make_snapshot(scores)

    def count(self, event_id=None):
        with self._lock:
            return len(self.calls) if event_id is None else self.calls.count(event_id)


def fast_hub(loader=None, **kwargs):
    options = {"refresh_interval": 0.05, "min_refresh_interval": 0.0, "keepalive_interval": 5.0, "poll_interval": 0.05}
    options.update(kwargs)
    return ScoreboardHub(loader or FakeLoader(), **options)


async def next_frame(agen, timeout=WAIT):
    return await asyncio.wait_for(agen.__anext__(), timeout)


def payload(frame: str) -> dict:
    assert frame.startswith("data: ") and frame.endswith("\n\n"), frame
    return json.loads(frame[len("data: "):-2])


def scores_of(frame: str) -> list[int]:
    return [e["score"] for e in payload(frame)["entries"]]


async def wait_until(predicate, timeout=WAIT):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


# ---------------------------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------------------------
def test_snapshot_json_shape_slice_and_memoisation():
    snap = make_snapshot([30, 20, 10], total_players=7, total_games=9)
    data = json.loads(snap.json_for(2))
    assert list(data) == ["entries", "total_players", "total_games"]
    assert [e["score"] for e in data["entries"]] == [30, 20]
    assert data["total_players"] == 7 and data["total_games"] == 9
    assert snap.json_for(2) is snap.json_for(2)  # serialised once per limit
    assert len(json.loads(snap.json_for(100))["entries"]) == 3
    assert " " not in snap.json_for(2).replace("Player 1", "").replace("Player 2", "")  # compact separators


def test_snapshot_same_content():
    assert make_snapshot([3, 2]).same_content(make_snapshot([3, 2]))
    assert not make_snapshot([3, 2]).same_content(make_snapshot([3, 1]))
    assert not make_snapshot([3, 2]).same_content(make_snapshot([3, 2], total_players=5))
    assert not make_snapshot([3, 2]).same_content(make_snapshot([3, 2], total_games=5))


# ---------------------------------------------------------------------------------------------
# Real queries
# ---------------------------------------------------------------------------------------------
def test_fetch_entries_privacy_and_order(db, make_event, make_player, make_game_session):
    event = make_event()
    now = datetime(2026, 10, 7, 10, 0, 0)
    a = make_player(event, first_name="Ada", last_name="Lovelace", email="ada@secret.example", phone_number="+33 6 11 22 33 44")
    b = make_player(event, first_name="Grace", last_name="Hopper", email="grace@secret.example")
    c = make_player(event, first_name="Alan", last_name="Turing", email="alan@secret.example")
    make_game_session(event, a, total_score=200, correct_answers=3, wrong_answers=1, completed_at=now + timedelta(minutes=2))
    first = make_game_session(event, b, total_score=200, correct_answers=3, wrong_answers=1, completed_at=now)
    make_game_session(event, c, total_score=300, correct_answers=5, wrong_answers=0, completed_at=now + timedelta(minutes=9))
    entries = fetch_entries(db, event.id)
    assert [e.player_name for e in entries] == ["Alan T.", "Grace H.", "Ada L."]
    assert [e.rank for e in entries] == [1, 2, 3]
    assert entries[1].id == first.id  # tie on 200: earliest completed_at first
    dumped = json.dumps([e.model_dump(mode="json") for e in entries])
    for secret in ("secret.example", "+33", "Lovelace", "Hopper", "Turing", "phone", "email"):
        assert secret not in dumped
    assert set(entries[0].model_dump()) == {
        "id", "rank", "player_name", "score", "correct_answers", "wrong_answers", "completed_at",
    }


def test_fetch_entries_only_completed_games_of_the_event(db, make_event, make_player, make_game_session):
    event, other = make_event(), make_event()
    make_game_session(event, make_player(event), total_score=10)
    make_game_session(event, make_player(event), status="in_progress", total_score=999)
    make_game_session(event, make_player(event), status="abandoned", total_score=999)
    make_game_session(other, make_player(other), total_score=500)
    assert [e.score for e in fetch_entries(db, event.id)] == [10]
    assert [e.score for e in fetch_entries(db, other.id)] == [500]


def test_fetch_entries_limit_and_equal_everything_uses_id(db, make_event, make_player, make_game_session):
    event = make_event()
    moment = datetime(2026, 10, 7, 12, 0, 0)
    ids = [make_game_session(event, make_player(event), total_score=50, completed_at=moment).id for _ in range(5)]
    assert [e.id for e in fetch_entries(db, event.id)] == ids
    assert [e.id for e in fetch_entries(db, event.id, 2)] == ids[:2]


def test_fetch_entries_null_completed_at_sorts_last(db, make_event, make_player, make_game_session):
    event = make_event()
    odd = make_game_session(event, make_player(event), total_score=50, completed_at=None)
    normal = make_game_session(event, make_player(event), total_score=50)
    assert [e.id for e in fetch_entries(db, event.id)] == [normal.id, odd.id]


def test_fetch_entries_legacy_email_in_name_is_hidden(db, make_event, make_player, make_game_session):
    event = make_event()
    make_game_session(event, make_player(event, first_name="ada@example.com", last_name="Lovelace"), total_score=1)
    assert fetch_entries(db, event.id)[0].player_name == "Player"


def test_fetch_totals_counts_distinct_players_and_games(db, make_event, make_player, make_game_session):
    event, other = make_event(), make_event()
    repeat = make_player(event)
    make_game_session(event, repeat)
    make_game_session(event, repeat)  # same player, second game
    make_game_session(event, make_player(event))
    make_game_session(event, make_player(event), status="in_progress")
    make_game_session(other, make_player(other))
    assert fetch_totals(db, event.id) == (2, 3)
    assert fetch_totals(db, other.id) == (1, 1)
    empty = make_event()
    assert fetch_totals(db, empty.id) == (0, 0)


def test_build_snapshot_and_load_snapshot_agree(db, make_event, make_player, make_game_session):
    event = make_event()
    for score in (30, 20, 10):
        make_game_session(event, make_player(event), total_score=score)
    built = build_snapshot(db, event.id)
    loaded = load_snapshot(event.id)  # own short-lived session
    assert built.same_content(loaded)
    assert [e["score"] for e in loaded.entries] == [30, 20, 10]
    assert loaded.total_players == 3 and loaded.total_games == 3
    assert loaded.entries[0]["completed_at"].endswith("Z")


def test_build_snapshot_is_capped_at_the_max_entries(db, make_event, make_player, make_game_session):
    event = make_event()
    for score in range(MAX_ENTRIES + 20):
        make_game_session(event, make_player(event), total_score=score)
    snap = build_snapshot(db, event.id)
    assert len(snap.entries) == MAX_ENTRIES
    assert snap.total_games == MAX_ENTRIES + 20
    assert snap.entries[0]["score"] == MAX_ENTRIES + 19


# ---------------------------------------------------------------------------------------------
# Hub: first message, slicing, change detection
# ---------------------------------------------------------------------------------------------
def test_first_frame_is_the_current_snapshot():
    async def scenario():
        hub = fast_hub()
        gen = hub.stream(1, limit=10)
        frame = await next_frame(gen)
        data = payload(frame)
        assert [e["score"] for e in data["entries"]] == [300, 200, 100]
        assert data["total_players"] == 3 and data["total_games"] == 3
        await gen.aclose()
        assert hub.channel_count() == 0

    asyncio.run(scenario())


def test_limit_slices_entries_and_keeps_totals():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [50, 40, 30, 20, 10]}))
        small, big = hub.stream(1, limit=2), hub.stream(1, limit=100)
        assert scores_of(await next_frame(small)) == [50, 40]
        assert scores_of(await next_frame(big)) == [50, 40, 30, 20, 10]
        assert payload(await next_frame(hub.stream(1, limit=1)))["total_games"] == 5
        await small.aclose()
        await big.aclose()

    asyncio.run(scenario())


def test_limit_is_clamped_to_the_allowed_range():
    async def scenario():
        hub = fast_hub(FakeLoader({1: list(range(150, 0, -1))}), max_entries=100)
        huge, zero = hub.stream(1, limit=10_000), hub.stream(1, limit=0)
        assert len(payload(await next_frame(huge))["entries"]) == 100
        assert len(payload(await next_frame(zero))["entries"]) == 1
        await huge.aclose()
        await zero.aclose()

    asyncio.run(scenario())


def test_periodic_refresh_pushes_changes_made_elsewhere():
    """A score written by another replica (no in-process notify) shows up through the DB re-check."""

    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=0.05)
        gen = hub.stream(1)
        assert scores_of(await next_frame(gen)) == [100]
        loader.scores[1] = [250, 100]
        assert scores_of(await next_frame(gen)) == [250, 100]
        await gen.aclose()

    asyncio.run(scenario())


def test_unchanged_snapshot_is_never_resent_only_keepalives():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=0.02, keepalive_interval=0.15)
        gen = hub.stream(1)
        await next_frame(gen)  # the data frame
        frames = [await next_frame(gen) for _ in range(3)]
        assert frames == [": keepalive\n\n"] * 3
        assert loader.count(1) > 3  # it kept re-checking the database meanwhile
        await gen.aclose()

    asyncio.run(scenario())


def test_message_is_sent_only_when_the_viewers_slice_changed():
    async def scenario():
        loader = FakeLoader({1: [50, 40, 30, 20, 10]})
        hub = fast_hub(loader, refresh_interval=0.02, keepalive_interval=0.2)
        top2, top5 = hub.stream(1, limit=2), hub.stream(1, limit=5)
        await next_frame(top2)
        await next_frame(top5)
        loader.scores[1] = [50, 40, 30, 20, 15]  # only rank 5 changes
        assert scores_of(await next_frame(top5)) == [50, 40, 30, 20, 15]  # visible for limit=5 ...
        assert await next_frame(top2) == ": keepalive\n\n"  # ... invisible for limit=2: nothing but a keepalive
        loader.scores[1] = [90, 50, 40]  # the top 2 change
        assert scores_of(await next_frame(top2)) == [90, 50]
        await top2.aclose()
        await top5.aclose()

    asyncio.run(scenario())


def test_totals_change_alone_triggers_a_message():
    async def scenario():
        state = {"games": 1}

        def loader(event_id):
            return make_snapshot([10], total_players=1, total_games=state["games"])

        hub = fast_hub(loader, refresh_interval=0.02)
        gen = hub.stream(1)
        assert payload(await next_frame(gen))["total_games"] == 1
        state["games"] = 2  # same top entries, one more game elsewhere in the ranking
        assert payload(await next_frame(gen))["total_games"] == 2
        await gen.aclose()

    asyncio.run(scenario())


def test_events_are_isolated():
    async def scenario():
        loader = FakeLoader({1: [10], 2: [99, 98]})
        hub = fast_hub(loader, refresh_interval=0.02, keepalive_interval=0.2)
        one, two = hub.stream(1), hub.stream(2)
        assert scores_of(await next_frame(one)) == [10]
        assert scores_of(await next_frame(two)) == [99, 98]
        loader.scores[2] = [150, 99, 98]
        assert scores_of(await next_frame(two)) == [150, 99, 98]
        assert await next_frame(one) == ": keepalive\n\n"
        assert hub.channel_count() == 2
        await one.aclose()
        await two.aclose()

    asyncio.run(scenario())


# ---------------------------------------------------------------------------------------------
# Hub: notifications
# ---------------------------------------------------------------------------------------------
def test_notify_refreshes_immediately_without_waiting_for_the_interval():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=60.0)  # periodic refresh would take a minute
        gen = hub.stream(1)
        await next_frame(gen)
        loader.scores[1] = [100, 90]
        started = time.monotonic()
        hub.notify(1)
        assert scores_of(await next_frame(gen)) == [100, 90]
        assert time.monotonic() - started < 1.0
        await gen.aclose()

    asyncio.run(scenario())


def test_notify_from_a_worker_thread_is_safe():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=60.0)
        gen = hub.stream(1)
        await next_frame(gen)
        loader.scores[1] = [100, 90]
        thread = threading.Thread(target=hub.notify, args=(1,))  # what a threadpool endpoint does
        thread.start()
        assert scores_of(await next_frame(gen)) == [100, 90]
        thread.join()
        await gen.aclose()

    asyncio.run(scenario())


def test_many_threads_notifying_at_once():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=60.0, min_refresh_interval=0.02)
        gen = hub.stream(1)
        await next_frame(gen)
        loader.scores[1] = [100, 95]
        threads = [threading.Thread(target=hub.notify, args=(1,)) for _ in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert scores_of(await next_frame(gen)) == [100, 95]
        await gen.aclose()

    asyncio.run(scenario())


def test_burst_of_notifications_is_coalesced_into_few_refreshes():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=60.0, min_refresh_interval=0.2)
        gen = hub.stream(1)
        await next_frame(gen)
        before = loader.count(1)
        for _ in range(200):
            hub.notify(1)
            await asyncio.sleep(0.001)
        await asyncio.sleep(0.3)
        assert loader.count(1) - before <= 3  # 200 notifications -> a handful of queries
        await gen.aclose()

    asyncio.run(scenario())


def test_notification_during_a_slow_load_triggers_another_refresh():
    async def scenario():
        loader = FakeLoader({1: [100]}, delay=0.15)
        hub = fast_hub(loader, refresh_interval=60.0)
        gen = hub.stream(1)
        await next_frame(gen)
        loader.scores[1] = [100, 80]
        hub.notify(1)  # starts load #2 (slow)
        await wait_until(lambda: loader.count(1) >= 2)
        loader.scores[1] = [100, 80, 60]
        hub.notify(1)  # arrives while load #2 runs: must not be lost
        frames = []
        while True:
            frame = await next_frame(gen)
            frames.append(frame)
            if scores_of(frame) == [100, 80, 60]:
                break
        await gen.aclose()

    asyncio.run(scenario())


def test_notify_without_subscribers_is_a_noop():
    hub = ScoreboardHub(FakeLoader())
    hub.notify(1)  # no loop, no channel
    assert hub.channel_count() == 0 and hub.subscriber_count() == 0


def test_notify_for_an_event_nobody_watches_is_ignored():
    async def scenario():
        loader = FakeLoader({1: [1], 2: [2]})
        hub = fast_hub(loader, refresh_interval=60.0)
        gen = hub.stream(1)
        await next_frame(gen)
        hub.notify(2)
        await asyncio.sleep(0.1)
        assert loader.count(2) == 0
        await gen.aclose()

    asyncio.run(scenario())


def test_notify_with_a_closed_loop_does_not_raise():
    loop = asyncio.new_event_loop()
    loop.close()
    hub = ScoreboardHub(FakeLoader())
    hub._loop = loop
    hub.notify(1)  # RuntimeError('Event loop is closed') is swallowed


def test_module_notify_event_changed_routes_to_the_hub(monkeypatch):
    seen = []

    class Recorder:
        def notify(self, event_id):
            seen.append(event_id)

    monkeypatch.setattr(broadcaster, "hub", Recorder())
    assert notify_event_changed(42) is None
    assert seen == [42]


def test_module_notify_event_changed_never_raises(monkeypatch):
    class Boom:
        def notify(self, event_id):
            raise RuntimeError("boom")

    monkeypatch.setattr(broadcaster, "hub", Boom())
    assert notify_event_changed(1) is None


def test_default_hub_is_idle_at_import_time():
    assert broadcaster.hub.channel_count() == 0
    assert notify_event_changed(1) is None


# ---------------------------------------------------------------------------------------------
# Hub: fan-out, lifecycle, cleanup
# ---------------------------------------------------------------------------------------------
def test_hundreds_of_viewers_share_one_task_and_one_query_per_refresh():
    async def scenario():
        loader = FakeLoader({1: [100, 90, 80]})
        hub = fast_hub(loader, refresh_interval=60.0)
        viewers = [hub.stream(1, limit=[3, 10, 50, 100][i % 4]) for i in range(300)]
        first = await asyncio.gather(*(next_frame(v) for v in viewers))
        assert all(scores_of(f) == [100, 90, 80] for f in first)
        assert hub.channel_count() == 1
        assert hub.subscriber_count(1) == 300
        assert loader.count(1) == 1  # 300 viewers, ONE database load

        loader.scores[1] = [120, 100, 90, 80]
        hub.notify(1)
        second = await asyncio.gather(*(next_frame(v) for v in viewers))
        assert all(scores_of(f)[0] == 120 for f in second)
        assert loader.count(1) == 2  # one more load for everybody
        await asyncio.gather(*(v.aclose() for v in viewers))
        assert hub.channel_count() == 0 and hub.subscriber_count() == 0

    asyncio.run(scenario())


def test_late_joiner_gets_the_cached_snapshot_without_a_new_query():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=60.0)
        early = hub.stream(1)
        await next_frame(early)
        late = hub.stream(1)
        assert scores_of(await next_frame(late)) == [100]
        assert loader.count(1) == 1
        await early.aclose()
        await late.aclose()

    asyncio.run(scenario())


def test_slow_first_load_delays_the_first_frame_but_it_arrives():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [7]}, delay=0.3))
        started = time.monotonic()
        frame = await next_frame(hub.stream(1))
        assert scores_of(frame) == [7]
        assert time.monotonic() - started >= 0.25

    asyncio.run(scenario())


def test_last_viewer_leaving_stops_the_refresh_task_and_the_queries():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=0.02)
        a, b = hub.stream(1), hub.stream(1)
        await next_frame(a)
        await next_frame(b)
        task = hub._channels[1].task
        await a.aclose()
        assert hub.channel_count() == 1 and not task.done()  # b still watches
        await b.aclose()
        assert hub.channel_count() == 0
        await asyncio.sleep(0.05)
        assert task.cancelled() or task.done()
        calls = loader.count(1)
        await asyncio.sleep(0.2)
        assert loader.count(1) == calls  # no viewer, no database work
        assert hub._loop is None

    asyncio.run(scenario())


def test_cleanup_when_the_client_disconnects():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=0.02)
        gone = {"value": False}

        async def is_disconnected():
            return gone["value"]

        gen = hub.stream(1, 10, is_disconnected)
        await next_frame(gen)
        assert hub.subscriber_count(1) == 1
        gone["value"] = True
        with pytest.raises(StopAsyncIteration):  # the stream ends by itself within poll_interval
            await next_frame(gen)
        assert hub.channel_count() == 0 and hub.subscriber_count() == 0

    asyncio.run(scenario())


def test_disconnect_is_noticed_even_when_nothing_changes():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [100]}), refresh_interval=60.0, keepalive_interval=60.0, poll_interval=0.05)
        calls = {"n": 0}

        async def is_disconnected():
            calls["n"] += 1
            return calls["n"] > 3

        gen = hub.stream(1, 10, is_disconnected)
        await next_frame(gen)
        started = time.monotonic()
        with pytest.raises(StopAsyncIteration):
            await next_frame(gen)
        assert time.monotonic() - started < 1.0  # ~3 polls of 50 ms, not the 60 s keepalive
        assert hub.channel_count() == 0

    asyncio.run(scenario())


def test_cleanup_when_the_consumer_task_is_cancelled():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [100]}), refresh_interval=0.02)

        async def consume():
            async for _ in hub.stream(1):
                pass

        task = asyncio.create_task(consume())
        await wait_until(lambda: hub.subscriber_count(1) == 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert hub.channel_count() == 0 and hub.subscriber_count() == 0

    asyncio.run(scenario())


def test_cleanup_happens_even_if_the_stream_was_never_started():
    async def scenario():
        hub = fast_hub()
        gen = hub.stream(1)  # created but never iterated
        await gen.aclose()
        assert hub.channel_count() == 0

    asyncio.run(scenario())


def test_one_viewer_leaving_does_not_disturb_the_others():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=0.02)
        stay, leave = hub.stream(1), hub.stream(1)
        await next_frame(stay)
        await next_frame(leave)
        await leave.aclose()
        loader.scores[1] = [100, 50]
        assert scores_of(await next_frame(stay)) == [100, 50]
        await stay.aclose()

    asyncio.run(scenario())


def test_a_viewer_can_reconnect_after_the_channel_was_dropped():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader)
        first = hub.stream(1)
        await next_frame(first)
        await first.aclose()
        assert hub.channel_count() == 0
        loader.scores[1] = [200]
        again = hub.stream(1)
        assert scores_of(await next_frame(again)) == [200]  # fresh channel, fresh load
        await again.aclose()

    asyncio.run(scenario())


def test_keepalive_comments_when_idle():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [100]}), refresh_interval=60.0, keepalive_interval=0.1)
        gen = hub.stream(1)
        await next_frame(gen)
        started = time.monotonic()
        assert await next_frame(gen) == ": keepalive\n\n"
        assert await next_frame(gen) == ": keepalive\n\n"
        assert 0.15 <= time.monotonic() - started < 1.5
        await gen.aclose()

    asyncio.run(scenario())


def test_database_errors_do_not_kill_the_stream(caplog):
    async def scenario():
        loader = FakeLoader({1: [100]})
        loader.fail_next = 2
        hub = fast_hub(loader, refresh_interval=0.03)
        gen = hub.stream(1)
        assert scores_of(await next_frame(gen)) == [100]  # after 2 failed attempts
        assert loader.count(1) >= 3
        await gen.aclose()

    with caplog.at_level("WARNING", logger="app.services.broadcaster"):
        asyncio.run(scenario())
    assert "Scoreboard refresh failed" in caplog.text


def test_database_error_after_a_good_snapshot_keeps_the_last_one():
    async def scenario():
        loader = FakeLoader({1: [100]})
        hub = fast_hub(loader, refresh_interval=0.02, keepalive_interval=0.1)
        gen = hub.stream(1)
        await next_frame(gen)
        loader.fail_next = 5
        assert await next_frame(gen) == ": keepalive\n\n"  # still connected, nothing bogus sent
        late = hub.stream(1)
        assert scores_of(await next_frame(late)) == [100]  # newcomers still get the last good snapshot
        await gen.aclose()
        await late.aclose()

    asyncio.run(scenario())


def test_hub_aclose_stops_every_refresh_task():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [1], 2: [2]}), refresh_interval=0.02)
        a, b = hub.stream(1), hub.stream(2)
        await next_frame(a)
        await next_frame(b)
        tasks = [c.task for c in hub._channels.values()]
        await hub.aclose()
        assert all(t.cancelled() or t.done() for t in tasks)
        assert hub.channel_count() == 0
        await a.aclose()  # closing the streams afterwards is harmless
        await b.aclose()

    asyncio.run(scenario())


def test_subscriber_count_introspection():
    async def scenario():
        hub = fast_hub(FakeLoader({1: [1], 2: [2]}))
        streams = [hub.stream(1), hub.stream(1), hub.stream(2)]
        for s in streams:
            await next_frame(s)
        assert hub.subscriber_count(1) == 2 and hub.subscriber_count(2) == 1 and hub.subscriber_count() == 3
        assert hub.subscriber_count(99) == 0
        for s in streams:
            await s.aclose()

    asyncio.run(scenario())


# ---------------------------------------------------------------------------------------------
# Hub + real database (end to end, no HTTP)
# ---------------------------------------------------------------------------------------------
def test_hub_with_the_real_loader_streams_database_changes(db, make_event, make_player, make_game_session):
    event = make_event()
    make_game_session(event, make_player(event, first_name="Ada", last_name="Lovelace"), total_score=100)

    async def scenario():
        hub = ScoreboardHub(refresh_interval=0.05, min_refresh_interval=0.0, poll_interval=0.05)
        gen = hub.stream(event.id, limit=10)
        data = payload(await next_frame(gen))
        assert [e["player_name"] for e in data["entries"]] == ["Ada L."]
        assert data["total_players"] == 1 and data["total_games"] == 1

        def add_better_game():
            make_game_session(event, make_player(event, first_name="Grace", last_name="Hopper"), total_score=250)

        await asyncio.to_thread(add_better_game)
        data = payload(await next_frame(gen))
        assert [e["player_name"] for e in data["entries"]] == ["Grace H.", "Ada L."]
        assert data["total_players"] == 2
        assert "email" not in json.dumps(data) and "phone" not in json.dumps(data)
        await gen.aclose()
        assert hub.channel_count() == 0

    asyncio.run(scenario())
