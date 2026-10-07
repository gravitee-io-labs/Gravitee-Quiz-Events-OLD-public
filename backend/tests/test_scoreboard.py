"""GET /api/events/{slug}/scoreboard and /scoreboard/stream (SSE).

The stream is driven at the ASGI level (raw scope/receive/send), never through a TestClient that would
wait for an infinite response to end.
"""
import asyncio
import json
from datetime import datetime, timedelta

import pytest

from app.main import app
from app.services import broadcaster
from app.services.broadcaster import ScoreboardHub

NOW = datetime(2026, 10, 7, 10, 0, 0)


@pytest.fixture
def fast_hub(monkeypatch):
    """Replace the process-wide hub with one that refreshes quickly (restored by monkeypatch)."""
    test_hub = ScoreboardHub(refresh_interval=0.05, min_refresh_interval=0.0, keepalive_interval=5.0, poll_interval=0.05)
    monkeypatch.setattr(broadcaster, "hub", test_hub)
    return test_hub


def board(client, slug="quiz", headers=None, **params):
    return client.get(f"/api/events/{slug}/scoreboard", params=params, headers=headers or {})


@pytest.fixture
def populated(make_event, make_player, make_game_session):
    """Event "quiz" with 3 completed games (Ada 300, Grace 200 early, Alan 200 late) + noise."""
    event = make_event(slug="quiz")
    ada = make_player(event, first_name="Ada", last_name="Lovelace", email="ada@private.example", phone_number="+33611223344")
    grace = make_player(event, first_name="Grace", last_name="Hopper", email="grace@private.example", phone_number="+33699887766")
    alan = make_player(event, first_name="Alan", last_name="Turing", email="alan@private.example")
    games = {
        "ada": make_game_session(event, ada, total_score=300, correct_answers=6, wrong_answers=1, completed_at=NOW + timedelta(minutes=5)),
        "grace": make_game_session(event, grace, total_score=200, correct_answers=4, wrong_answers=2, completed_at=NOW),
        "alan": make_game_session(event, alan, total_score=200, correct_answers=4, wrong_answers=3, completed_at=NOW + timedelta(minutes=1)),
    }
    make_game_session(event, make_player(event), status="in_progress", total_score=9999)
    return event, games


# =============================================================================================
# REST
# =============================================================================================
def test_scoreboard_order_rank_and_shape(client, populated):
    _, games = populated
    response = board(client)
    assert response.status_code == 200
    rows = response.json()
    assert [r["player_name"] for r in rows] == ["Ada L.", "Grace H.", "Alan T."]
    assert [r["rank"] for r in rows] == [1, 2, 3]
    assert [r["score"] for r in rows] == [300, 200, 200]  # tie broken by completed_at asc
    assert [r["id"] for r in rows] == [games["ada"].id, games["grace"].id, games["alan"].id]
    assert rows[0]["correct_answers"] == 6 and rows[0]["wrong_answers"] == 1
    assert rows[1]["completed_at"] == "2026-10-07T10:00:00Z"
    assert set(rows[0]) == {"id", "rank", "player_name", "score", "correct_answers", "wrong_answers", "completed_at"}


def test_scoreboard_never_exposes_email_phone_or_full_names(client, populated):
    text = board(client, limit=100).text
    for secret in ("private.example", "+336", "email", "phone", "Lovelace", "Hopper", "Turing"):
        assert secret not in text


def test_scoreboard_only_shows_completed_games(client, populated):
    rows = board(client).json()
    assert 9999 not in [r["score"] for r in rows]
    assert len(rows) == 3


def test_scoreboard_is_scoped_to_its_event(client, populated, make_event, make_player, make_game_session):
    other = make_event(slug="other")
    make_game_session(other, make_player(other, first_name="Zed", last_name="Zimmer"), total_score=5000)
    assert "Zed Z." not in [r["player_name"] for r in board(client).json()]
    assert [r["player_name"] for r in board(client, "other").json()] == ["Zed Z."]


def test_scoreboard_empty_event(client, make_event):
    make_event(slug="quiz")
    response = board(client)
    assert response.status_code == 200
    assert response.json() == []


def test_scoreboard_default_limit_is_10(client, make_event, make_player, make_game_session):
    event = make_event(slug="quiz")
    for score in range(15):
        make_game_session(event, make_player(event), total_score=score)
    rows = board(client).json()
    assert len(rows) == 10
    assert [r["score"] for r in rows] == list(range(14, 4, -1))


@pytest.mark.parametrize("limit,expected", [(1, 1), (3, 3), (50, 50), (100, 100)])
def test_scoreboard_limit(client, make_event, make_player, make_game_session, limit, expected):
    event = make_event(slug="quiz")
    for score in range(120):
        make_game_session(event, make_player(event), total_score=score)
    rows = board(client, limit=limit).json()
    assert len(rows) == expected
    assert [r["rank"] for r in rows] == list(range(1, expected + 1))


@pytest.mark.parametrize("limit", [0, -1, 101, 1000, "abc", ""])
def test_scoreboard_limit_out_of_bounds_is_422(client, make_event, limit):
    make_event(slug="quiz")
    assert board(client, limit=limit).status_code == 422


def test_scoreboard_same_player_two_games_appear_twice(client, make_event, make_player, make_game_session):
    event = make_event(slug="quiz")
    player = make_player(event, first_name="Ada", last_name="Lovelace")
    make_game_session(event, player, total_score=100)
    make_game_session(event, player, total_score=200)
    assert [(r["player_name"], r["score"]) for r in board(client).json()] == [("Ada L.", 200), ("Ada L.", 100)]


def test_scoreboard_unknown_event_is_404(client):
    assert board(client, "nope").status_code == 404


def test_scoreboard_draft_is_404_for_the_public_and_visible_to_admins(client, make_event, make_player, make_game_session, admin_headers):
    event = make_event(slug="secret", status="draft")
    make_game_session(event, make_player(event), total_score=10)
    assert board(client, "secret").status_code == 404
    response = board(client, "secret", headers=admin_headers)
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_scoreboard_of_a_closed_event_is_still_readable(client, make_event, make_player, make_game_session):
    event = make_event(slug="over", status="closed")
    make_game_session(event, make_player(event, first_name="Ada", last_name="Lovelace"), total_score=10)
    response = board(client, "over")
    assert response.status_code == 200
    assert response.json()[0]["player_name"] == "Ada L."


def test_scoreboard_reflects_a_game_played_through_the_api(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=1)
    make_question(event, make_category(event))
    player = make_player(event, first_name="Ada", last_name="Lovelace")
    game = client.post("/api/events/quiz/games", json={"player_id": player.id}).json()
    qid = game["questions"][0]["id"]
    assert board(client).json() == []  # not finished yet
    client.post(
        f"/api/events/quiz/games/{game['game_session_id']}/submit",
        json={"answers": [{"question_id": qid, "player_answer": "green", "time_taken": 0}]},
    )
    (row,) = board(client).json()
    assert row["player_name"] == "Ada L." and row["score"] == 150 and row["id"] == game["game_session_id"]


# =============================================================================================
# SSE endpoint: gating (plain JSON errors, no streaming involved)
# =============================================================================================
def test_stream_unknown_event_is_404(client, fast_hub):
    response = client.get("/api/events/nope/scoreboard/stream")
    assert response.status_code == 404
    assert response.json() == {"detail": "Event not found"}


def test_stream_draft_event_is_404_for_the_public(client, make_event, fast_hub):
    make_event(slug="secret", status="draft")
    assert client.get("/api/events/secret/scoreboard/stream").status_code == 404
    assert fast_hub.channel_count() == 0  # nothing was subscribed


@pytest.mark.parametrize("limit", [0, 101, "x"])
def test_stream_limit_out_of_bounds_is_422(client, make_event, fast_hub, limit):
    make_event(slug="quiz")
    assert client.get("/api/events/quiz/scoreboard/stream", params={"limit": limit}).status_code == 422


# =============================================================================================
# SSE endpoint: real ASGI conversation
# =============================================================================================
class AsgiStream:
    """Drive the ASGI app by hand: collect response messages, inject a client disconnect."""

    def __init__(self, path, query="", headers=(), spec_version="2.3"):
        self.scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": spec_version}, "http_version": "1.1",
            "method": "GET", "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
            "query_string": query.encode(), "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
            "client": ("127.0.0.1", 50000), "server": ("testserver", 80),
        }
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.messages: asyncio.Queue = asyncio.Queue()
        self.task: asyncio.Task | None = None

    async def receive(self):
        return await self.inbox.get()

    async def send(self, message):
        await self.messages.put(message)

    async def open(self):
        self.task = asyncio.create_task(app(self.scope, self.receive, self.send))
        start = await self.get()
        assert start["type"] == "http.response.start"
        return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}

    async def get(self, timeout=3.0):
        return await asyncio.wait_for(self.messages.get(), timeout)

    async def next_chunk(self, timeout=3.0):
        message = await self.get(timeout)
        assert message["type"] == "http.response.body"
        return message["body"].decode()

    async def disconnect(self):
        await self.inbox.put({"type": "http.disconnect"})
        await asyncio.wait_for(self.task, 3.0)  # the app returns by itself


def _data(chunk: str) -> dict:
    assert chunk.startswith("data: ") and chunk.endswith("\n\n")
    return json.loads(chunk[6:-2])


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
def test_stream_sends_the_snapshot_then_updates_then_cleans_up(fast_hub, populated, make_player, make_game_session, spec_version):
    event, _ = populated

    async def scenario():
        stream = AsgiStream("/api/events/quiz/scoreboard/stream", "limit=2", spec_version=spec_version)
        status, headers = await stream.open()
        assert status == 200
        assert headers["content-type"].startswith("text/event-stream")
        assert headers["cache-control"] == "no-cache"
        assert headers["x-accel-buffering"] == "no"
        assert "x-request-id" in headers  # the pure ASGI middleware stack does not buffer / break SSE

        first = _data(await stream.next_chunk())
        assert [e["player_name"] for e in first["entries"]] == ["Ada L.", "Grace H."]  # limit=2
        assert first["total_players"] == 3 and first["total_games"] == 3
        assert fast_hub.subscriber_count(event.id) == 1

        def add_game():
            make_game_session(event, make_player(event, first_name="Linus", last_name="Torvalds"), total_score=999)

        await asyncio.to_thread(add_game)
        fast_hub.notify(event.id)
        update = _data(await stream.next_chunk())
        assert [e["player_name"] for e in update["entries"]] == ["Linus T.", "Ada L."]
        assert update["total_games"] == 4

        await stream.disconnect()
        assert fast_hub.subscriber_count() == 0 and fast_hub.channel_count() == 0

    asyncio.run(scenario())


def test_stream_payload_never_contains_private_data(fast_hub, populated):
    async def scenario():
        stream = AsgiStream("/api/events/quiz/scoreboard/stream", "limit=100")
        await stream.open()
        chunk = await stream.next_chunk()
        for secret in ("private.example", "+336", "email", "phone", "Lovelace", "Hopper", "Turing"):
            assert secret not in chunk
        await stream.disconnect()

    asyncio.run(scenario())


def test_stream_of_a_closed_event_still_serves_the_final_results(fast_hub, make_event, make_player, make_game_session):
    event = make_event(slug="over", status="closed")
    make_game_session(event, make_player(event, first_name="Ada", last_name="Lovelace"), total_score=10)

    async def scenario():
        stream = AsgiStream("/api/events/over/scoreboard/stream")
        status, _ = await stream.open()
        assert status == 200
        assert [e["score"] for e in _data(await stream.next_chunk())["entries"]] == [10]
        await stream.disconnect()

    asyncio.run(scenario())


def test_stream_of_a_draft_event_is_available_to_admins(fast_hub, make_event, admin_headers):
    make_event(slug="secret", status="draft")

    async def scenario():
        stream = AsgiStream(
            "/api/events/secret/scoreboard/stream", headers=[("authorization", admin_headers["Authorization"])]
        )
        status, _ = await stream.open()
        assert status == 200
        assert _data(await stream.next_chunk())["entries"] == []
        await stream.disconnect()

    asyncio.run(scenario())


def test_stream_of_a_draft_event_is_404_without_a_token_at_the_asgi_level(fast_hub, make_event):
    make_event(slug="secret", status="draft")

    async def scenario():
        stream = AsgiStream("/api/events/secret/scoreboard/stream")
        status, headers = await stream.open()
        assert status == 404
        assert headers["content-type"].startswith("application/json")
        await asyncio.wait_for(stream.task, 3.0)
        assert fast_hub.channel_count() == 0

    asyncio.run(scenario())


def test_stream_holds_no_database_session_while_open(fast_hub, populated, monkeypatch):
    """The endpoint (and the hub) must not keep a session for the stream's lifetime."""
    from app import database

    real_factory = database.SessionLocal
    state = {"open": 0, "total": 0}

    def counting_factory():
        session = real_factory()
        state["open"] += 1
        state["total"] += 1
        original_close = session.close

        def close():
            state["open"] -= 1
            return original_close()

        session.close = close
        return session

    monkeypatch.setattr(database, "SessionLocal", counting_factory)

    async def scenario():
        stream = AsgiStream("/api/events/quiz/scoreboard/stream")
        await stream.open()
        await stream.next_chunk()
        # several periodic refreshes happen meanwhile; a refresh in flight legitimately holds a session for
        # a few ms (longer on a networked PostgreSQL), so sample often: a session held for the stream's
        # whole lifetime would never be seen closed
        seen_open = []
        for _ in range(60):
            await asyncio.sleep(0.01)
            seen_open.append(state["open"])
        assert state["total"] >= 3  # event lookup + refreshes each used a short-lived session ...
        assert min(seen_open) == 0, "a database session is held while the stream is open"  # ... and closed it
        await stream.disconnect()

    asyncio.run(scenario())
