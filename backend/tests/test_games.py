"""POST /api/events/{slug}/games and /games/{id}/submit."""
import asyncio
import hashlib
import json
import random
import re
import threading
import time
from collections import Counter
from datetime import datetime, timedelta

import pytest
from sqlalchemy import update

from app import security
from app.config import settings
from app.database import engine
from app.models import GameAnswer, GameSession, utcnow
from app.routers import games as games_router

IS_POSTGRES = engine.dialect.name == "postgresql"


@pytest.fixture
def broadcasts(monkeypatch):
    """Record the notify_event_changed calls made by the submit endpoint."""
    calls = []
    monkeypatch.setattr(games_router, "notify_event_changed", calls.append)
    return calls


@pytest.fixture
def setup(make_event, make_category, make_question, make_player):
    """A live event ("quiz") with 2 categories x 3 questions (correct answer: green) and a player."""

    def _setup(per_game=3, **event_kwargs):
        event = make_event(slug="quiz", questions_per_game=per_game, **event_kwargs)
        cats = [make_category(event, name="Alpha"), make_category(event, name="Beta")]
        questions = [make_question(event, cats[i % 2]) for i in range(6)]
        player = make_player(event)
        return event, cats, questions, player

    return _setup


def start(client, slug, player_id, headers=None):
    return client.post(f"/api/events/{slug}/games", json={"player_id": player_id}, headers=headers or {})


def submit(client, slug, game_id, answers, headers=None):
    return client.post(f"/api/events/{slug}/games/{game_id}/submit", json={"answers": answers}, headers=headers or {})


def ans(question_id, answer="green", time_taken=0.0):
    return {"question_id": question_id, "player_answer": answer, "time_taken": time_taken}


def started(client, slug, player):
    body = start(client, slug, player.id).json()
    return body["game_session_id"], [q["id"] for q in body["questions"]]


# =============================================================================================
# start
# =============================================================================================
def test_start_game_happy_path(client, setup, db):
    event, _, _, player = setup(per_game=4, timer_seconds=25, points_correct=120, time_bonus_max=60)
    response = start(client, "quiz", player.id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"game_session_id", "timer_seconds", "points_correct", "time_bonus_max", "questions", "submit_token"}
    assert body["timer_seconds"] == 25
    assert body["points_correct"] == 120
    assert body["time_bonus_max"] == 60
    assert len(body["questions"]) == 4
    assert len({q["id"] for q in body["questions"]}) == 4

    session = db.get(GameSession, body["game_session_id"])
    assert session.event_id == event.id and session.player_id == player.id
    assert session.status == "in_progress"
    assert session.game_config == {
        "questions_per_game": 4, "timer_seconds": 25, "points_correct": 120, "points_wrong": 0, "time_bonus_max": 60,
        "submit_token_hash": hashlib.sha256(body["submit_token"].encode()).hexdigest(),
    }
    slots = db.query(GameAnswer).filter_by(game_session_id=session.id).order_by(GameAnswer.question_order).all()
    assert [s.question_id for s in slots] == [q["id"] for q in body["questions"]]
    assert [s.question_order for s in slots] == [1, 2, 3, 4]
    assert all(s.player_answer is None and s.is_correct is None and s.points_earned == 0 for s in slots)


def test_start_game_never_leaks_answers_or_explanations(client, setup):
    _, _, _, player = setup()
    response = start(client, "quiz", player.id)
    for question in response.json()["questions"]:
        assert set(question) == {
            "id", "question_format", "question_text_en", "question_text_fr", "question_type", "media_url",
            "green_label_en", "green_label_fr", "red_label_en", "red_label_fr", "difficulty", "category",
        }
        assert set(question["category"]) == {"id", "name", "name_fr", "color"}
    assert "correct_answer" not in response.text
    assert "explanation" not in response.text.lower()


def test_start_game_includes_labels_and_format(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=1)
    cat = make_category(event)
    make_question(event, cat, question_format="two_choices", green_label_en="LLM Proxy", green_label_fr="Proxy LLM",
                  red_label_en="MCP Proxy", red_label_fr="Proxy MCP", correct_answer="red")
    player = make_player(event)
    (question,) = start(client, "quiz", player.id).json()["questions"]
    assert question["question_format"] == "two_choices"
    assert (question["green_label_en"], question["red_label_fr"]) == ("LLM Proxy", "Proxy MCP")


def test_start_game_uncategorised_question_has_null_category(client, make_event, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=1)
    make_question(event)
    (question,) = start(client, "quiz", make_player(event).id).json()["questions"]
    assert question["category"] is None


def test_start_game_unknown_player_is_404(client, setup):
    setup()
    response = start(client, "quiz", 424242)
    assert response.status_code == 404
    assert response.json() == {"detail": "Player not found"}


def test_start_game_player_of_another_event_is_404(client, setup, make_event, make_player, db):
    setup()
    stranger = make_player(make_event(slug="other"))
    response = start(client, "quiz", stranger.id)
    assert response.status_code == 404
    assert response.json() == {"detail": "Player not found"}
    assert db.query(GameSession).count() == 0


def test_start_game_unknown_event_is_404(client, setup):
    _, _, _, player = setup()
    assert start(client, "nope", player.id).status_code == 404


def test_start_game_invalid_body_is_422(client, setup):
    setup()
    assert client.post("/api/events/quiz/games", json={}).status_code == 422
    assert client.post("/api/events/quiz/games", json={"player_id": "abc"}).status_code == 422


def test_start_game_closed_event_is_403(client, setup, db):
    event, _, _, player = setup()
    event.status = "closed"
    db.commit()
    response = start(client, "quiz", player.id)
    assert response.status_code == 403
    assert response.json() == {"detail": "event_closed"}
    assert db.query(GameSession).count() == 0


def test_start_game_draft_event_is_404_but_admins_can_preview(client, setup, db, admin_headers):
    event, _, _, player = setup()
    event.status = "draft"
    db.commit()
    assert start(client, "quiz", player.id).status_code == 404
    assert start(client, "quiz", player.id, headers=admin_headers).status_code == 200


def test_start_game_not_enough_questions_is_400(client, setup, db):
    _, _, _, player = setup(per_game=7)  # only 6 questions exist
    response = start(client, "quiz", player.id)
    assert response.status_code == 400
    assert response.json() == {"detail": "not_enough_questions"}
    assert db.query(GameSession).count() == 0


def test_start_game_inactive_questions_are_never_served_nor_counted(client, setup, db):
    _, _, questions, player = setup(per_game=4)
    for question in questions[:2]:
        question.is_active = False
    db.commit()
    body = start(client, "quiz", player.id).json()  # exactly 4 active questions left
    assert sorted(q["id"] for q in body["questions"]) == sorted(q.id for q in questions[2:])

    event = questions[0].event
    event.questions_per_game = 5
    db.commit()
    assert start(client, "quiz", player.id).status_code == 400


def test_start_game_questions_of_inactive_categories_are_excluded(client, setup, db):
    event, cats, questions, player = setup(per_game=3)
    cats[1].is_active = False  # Beta: 3 questions
    db.commit()
    body = start(client, "quiz", player.id).json()
    assert {q["category"]["name"] for q in body["questions"]} == {"Alpha"}
    event.questions_per_game = 4
    db.commit()
    assert start(client, "quiz", player.id).status_code == 400


def test_start_game_only_uses_questions_of_the_event(client, setup, make_event, make_category, make_question):
    _, _, questions, player = setup(per_game=6)
    other = make_event(slug="other")
    foreign = [make_question(other, make_category(other)) for _ in range(10)]
    body = start(client, "quiz", player.id).json()
    assert sorted(q["id"] for q in body["questions"]) == sorted(q.id for q in questions)
    assert not {q.id for q in foreign} & {q["id"] for q in body["questions"]}


def test_start_game_follows_the_category_distribution(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=8)
    alpha, beta = make_category(event, name="Alpha"), make_category(event, name="Beta")
    for _ in range(10):
        make_question(event, alpha)
        make_question(event, beta)
    event.category_distribution = {str(alpha.id): 1, str(beta.id): 3}
    player = make_player(event)
    for _ in range(5):
        questions = start(client, "quiz", player.id).json()["questions"]
        assert Counter(q["category"]["name"] for q in questions) == {"Alpha": 2, "Beta": 6}


def test_start_game_without_distribution_splits_equally(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=6)
    for name in ("A", "B", "C"):
        cat = make_category(event, name=name)
        for _ in range(8):
            make_question(event, cat)
    player = make_player(event)
    questions = start(client, "quiz", player.id).json()["questions"]
    assert Counter(q["category"]["name"] for q in questions) == {"A": 2, "B": 2, "C": 2}


def test_start_game_redistributes_when_a_category_is_short(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=6)
    small, big = make_category(event, name="Small"), make_category(event, name="Big")
    make_question(event, small)
    for _ in range(10):
        make_question(event, big)
    player = make_player(event)
    questions = start(client, "quiz", player.id).json()["questions"]
    assert Counter(q["category"]["name"] for q in questions) == {"Small": 1, "Big": 5}


def test_start_game_easy_to_hard_order(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=9, question_order="easy_to_hard")
    cat = make_category(event)
    for difficulty in (3, 1, 2, 3, 1, 2, 1, 3, 2, 1, 2, 3):
        make_question(event, cat, difficulty=difficulty)
    player = make_player(event)
    for _ in range(5):
        difficulties = [q["difficulty"] for q in start(client, "quiz", player.id).json()["questions"]]
        assert difficulties == sorted(difficulties)


def test_start_game_random_order_varies(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=10, question_order="random")
    cat = make_category(event)
    for _ in range(10):
        make_question(event, cat)
    player = make_player(event)
    orders = {tuple(q["id"] for q in start(client, "quiz", player.id).json()["questions"]) for _ in range(6)}
    assert len(orders) > 1


def test_start_game_is_deterministic_with_a_seeded_rng(client, setup, monkeypatch):
    _, _, _, player = setup(per_game=4)
    monkeypatch.setattr(games_router, "_make_rng", lambda: random.Random(99))
    first = [q["id"] for q in start(client, "quiz", player.id).json()["questions"]]
    second = [q["id"] for q in start(client, "quiz", player.id).json()["questions"]]
    assert first == second


def test_a_player_can_start_several_games(client, setup, db):
    _, _, _, player = setup()
    first = start(client, "quiz", player.id).json()["game_session_id"]
    second = start(client, "quiz", player.id).json()["game_session_id"]
    assert first != second
    assert db.query(GameSession).count() == 2


# =============================================================================================
# submit: scoring
# =============================================================================================
def test_submit_scores_server_side_with_time_bonus(client, setup, db, broadcasts):
    event, _, _, player = setup(per_game=3)  # defaults: 100 pts, +50 bonus max over 20 s
    game_id, ids = started(client, "quiz", player)
    response = submit(client, "quiz", game_id, [ans(ids[0], "green", 0), ans(ids[1], "green", 5), ans(ids[2], "green", 20)])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["game_session"]["total_score"] == 150 + 137 + 100
    assert body["game_session"]["correct_answers"] == 3
    assert body["game_session"]["wrong_answers"] == 0
    assert body["game_session"]["unanswered"] == 0
    assert [r["points_earned"] for r in body["review"]] == [150, 137, 100]
    assert body["rank"] == 1 and body["total_players"] == 1

    session = db.get(GameSession, game_id)
    assert session.status == "completed" and session.completed_at is not None
    assert session.total_score == 387
    assert broadcasts == [event.id]


def test_submit_response_shape_and_review(client, setup):
    _, _, questions, player = setup(per_game=2)
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 4), ans(ids[1], "red", 6)]).json()

    session = body["game_session"]
    assert set(session) == {
        "id", "player_id", "status", "total_score", "correct_answers", "wrong_answers", "unanswered",
        "started_at", "completed_at",
    }
    assert session["id"] == game_id and session["player_id"] == player.id and session["status"] == "completed"
    assert session["started_at"].endswith("Z") and session["completed_at"].endswith("Z")

    assert [r["question_id"] for r in body["review"]] == ids  # play order
    first, second = body["review"]
    assert set(first) == {
        "question_id", "question_format", "question_text_en", "question_text_fr", "correct_answer", "player_answer",
        "is_correct", "explanation_en", "explanation_fr", "time_taken", "points_earned", "green_label_en",
        "green_label_fr", "red_label_en", "red_label_fr", "category",
    }
    by_id = {q.id: q for q in questions}
    assert first["correct_answer"] == "green" and first["player_answer"] == "green" and first["is_correct"] is True
    assert first["explanation_en"] == by_id[ids[0]].explanation_en
    assert first["explanation_fr"] == by_id[ids[0]].explanation_fr
    assert first["question_text_fr"] == by_id[ids[0]].question_text_fr
    assert first["time_taken"] == 4.0 and first["points_earned"] == 140
    assert (first["green_label_en"], first["red_label_fr"]) == ("TRUE", "Faux")
    assert set(first["category"]) == {"id", "name", "name_fr", "color"}
    assert second["player_answer"] == "red" and second["is_correct"] is False and second["points_earned"] == 0


def test_submit_wrong_answers_use_points_wrong(client, setup):
    _, _, _, player = setup(per_game=3, points_wrong=10)
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "red", 1), ans(ids[1], "red", 1), ans(ids[2], "green", 20)]).json()
    assert body["game_session"]["wrong_answers"] == 2
    assert body["game_session"]["correct_answers"] == 1
    assert body["game_session"]["total_score"] == 10 + 10 + 100


def test_submit_unanswered_null_and_missing(client, setup, db):
    _, _, _, player = setup(per_game=3)
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 2), ans(ids[1], None, 20)]).json()  # ids[2] missing
    assert body["game_session"]["total_score"] == 145
    assert body["game_session"]["correct_answers"] == 1
    assert body["game_session"]["wrong_answers"] == 0
    assert body["game_session"]["unanswered"] == 2
    review = body["review"]
    assert review[1]["player_answer"] is None and review[1]["is_correct"] is None and review[1]["points_earned"] == 0
    assert review[2]["player_answer"] is None and review[2]["is_correct"] is None and review[2]["time_taken"] is None
    slot = db.query(GameAnswer).filter_by(game_session_id=game_id, question_id=ids[2]).one()
    assert slot.player_answer is None and slot.is_correct is None and slot.points_earned == 0


def test_submit_all_unanswered(client, setup):
    _, _, _, player = setup(per_game=3)
    game_id, _ = started(client, "quiz", player)
    response = submit(client, "quiz", game_id, [])
    assert response.status_code == 200
    body = response.json()
    assert body["game_session"]["total_score"] == 0
    assert body["game_session"]["unanswered"] == 3
    assert body["game_session"]["correct_answers"] == 0 and body["game_session"]["wrong_answers"] == 0
    assert len(body["review"]) == 3
    assert all(item["player_answer"] is None for item in body["review"])
    assert body["rank"] == 1


def test_submit_ignores_unknown_question_ids(client, setup, make_event, make_category, make_question):
    _, _, _, player = setup(per_game=3)
    other = make_event(slug="other")
    foreign = make_question(other, make_category(other))
    game_id, ids = started(client, "quiz", player)
    stray = max(ids) + 1000
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 0), ans(stray, "green", 0), ans(foreign.id, "green", 0)]).json()
    assert body["game_session"]["total_score"] == 150
    assert body["game_session"]["correct_answers"] == 1
    assert body["game_session"]["unanswered"] == 2  # the 2 other slots; strays are not counted at all
    assert [r["question_id"] for r in body["review"]] == ids


def test_submit_clamps_time_taken(client, setup, db):
    _, _, _, player = setup(per_game=3)  # timer 20
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 999), ans(ids[1], "green", 20.5), ans(ids[2], "green", 86400)]).json()
    assert [r["time_taken"] for r in body["review"]] == [20.0, 20.0, 20.0]
    assert [r["points_earned"] for r in body["review"]] == [100, 100, 100]  # no bonus, never negative
    stored = db.query(GameAnswer).filter_by(game_session_id=game_id).all()
    assert {s.time_taken for s in stored} == {20.0}


def test_submit_rejects_negative_or_absurd_times(client, setup, db):
    _, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    assert submit(client, "quiz", game_id, [ans(ids[0], "green", -1)]).status_code == 422
    assert submit(client, "quiz", game_id, [ans(ids[0], "green", 86401)]).status_code == 422
    assert db.get(GameSession, game_id).status == "in_progress"  # nothing was consumed


def test_submit_without_time_taken_gets_no_bonus(client, setup):
    _, _, _, player = setup(per_game=2)
    game_id, ids = started(client, "quiz", player)
    body = submit(
        client, "quiz", game_id,
        [{"question_id": ids[0], "player_answer": "green"}, {"question_id": ids[1], "player_answer": "green", "time_taken": 0}],
    ).json()
    assert [r["points_earned"] for r in body["review"]] == [100, 150]
    assert body["review"][0]["time_taken"] is None


def test_submit_uses_the_rules_snapshotted_at_start(client, setup, db):
    event, _, _, player = setup(per_game=2, points_correct=100, time_bonus_max=50, timer_seconds=20)
    game_id, ids = started(client, "quiz", player)
    # the admin edits the rules while the game is running
    event.points_correct, event.time_bonus_max, event.timer_seconds, event.points_wrong = 999, 999, 5, 77
    db.commit()
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 10), ans(ids[1], "red", 10)]).json()
    assert [r["points_earned"] for r in body["review"]] == [125, 0]  # old rules: 100 + 50 * 0.5, wrong = 0


def test_submit_falls_back_to_event_rules_without_a_snapshot(client, setup, db):
    event, _, _, player = setup(per_game=1, points_correct=200, time_bonus_max=0)
    game_id, ids = started(client, "quiz", player)
    db.execute(update(GameSession).where(GameSession.id == game_id).values(game_config=None))
    db.commit()
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 0)]).json()
    assert body["game_session"]["total_score"] == 200


def test_submit_two_choices_question_scores_like_any_other(client, make_event, make_category, make_question, make_player):
    event = make_event(slug="quiz", questions_per_game=1)
    make_question(event, make_category(event), question_format="two_choices", correct_answer="red")
    player = make_player(event)
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "red", 10)]).json()
    assert body["game_session"]["total_score"] == 125
    assert body["review"][0]["question_format"] == "two_choices"
    assert (body["review"][0]["green_label_en"], body["review"][0]["red_label_en"]) == ("Option A", "Option B")


def test_submit_validation_errors_are_422(client, setup):
    _, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    url = f"/api/events/quiz/games/{game_id}/submit"
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json={"answers": "x"}).status_code == 422
    assert submit(client, "quiz", game_id, [ans(ids[0], "blue", 1)]).status_code == 422
    assert submit(client, "quiz", game_id, [ans(ids[0], "green", 1), ans(ids[0], "red", 2)]).status_code == 422  # dup
    assert submit(client, "quiz", game_id, [ans(i, "green", 1) for i in range(1, 102)]).status_code == 422  # > 100
    assert submit(client, "quiz", game_id, [{"player_answer": "green"}]).status_code == 422  # no question_id


# =============================================================================================
# submit: lifecycle, gating, concurrency
# =============================================================================================
def test_double_submit_is_409_and_keeps_the_first_score(client, setup, db, broadcasts):
    event, _, _, player = setup(per_game=2)
    game_id, ids = started(client, "quiz", player)
    assert submit(client, "quiz", game_id, [ans(ids[0], "green", 0)]).status_code == 200
    second = submit(client, "quiz", game_id, [ans(ids[0], "green", 0), ans(ids[1], "green", 0)])
    assert second.status_code == 409
    assert second.json() == {"detail": "game_already_completed"}
    session = db.get(GameSession, game_id)
    assert session.total_score == 150 and session.correct_answers == 1 and session.unanswered == 1
    assert broadcasts == [event.id]  # only the successful submit notified


def test_submit_abandoned_game_is_409(client, setup, db):
    _, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    db.execute(update(GameSession).where(GameSession.id == game_id).values(status="abandoned"))
    db.commit()
    response = submit(client, "quiz", game_id, [ans(ids[0])])
    assert response.status_code == 409
    assert response.json() == {"detail": "game_not_in_progress"}


@pytest.mark.skipif(IS_POSTGRES, reason="PostgreSQL row-locks the game: a rival write would block, see the threaded test")
def test_submit_race_loser_gets_409_and_changes_nothing(client, setup, db, broadcasts, monkeypatch):
    """Without row locks (SQLite) two submits pass the status check; only the guarded UPDATE lets one through."""
    _, _, _, player = setup(per_game=2)
    game_id, ids = started(client, "quiz", player)
    real_summarize = games_router.summarize

    def summarize_after_a_rival_completed_the_game(scores):
        # a concurrent request completes the game between our status check and our write
        db.execute(
            update(GameSession)
            .where(GameSession.id == game_id)
            .values(status="completed", total_score=777, completed_at=utcnow())
        )
        db.commit()
        return real_summarize(scores)

    monkeypatch.setattr(games_router, "summarize", summarize_after_a_rival_completed_the_game)
    response = submit(client, "quiz", game_id, [ans(ids[0], "green", 0), ans(ids[1], "green", 0)])
    assert response.status_code == 409
    assert response.json() == {"detail": "game_already_completed"}
    session = db.get(GameSession, game_id)
    assert session.total_score == 777  # the rival's result stands
    assert db.query(GameAnswer).filter_by(game_session_id=game_id, is_correct=True).count() == 0  # nothing leaked
    assert broadcasts == []


@pytest.mark.skipif(not IS_POSTGRES, reason="needs real row locks and several connections (set TEST_DATABASE_URL to PostgreSQL)")
def test_concurrent_double_submit_scores_exactly_once(setup, db, broadcasts):
    """SELECT ... FOR UPDATE: simultaneous submits of one game -> one 200, the others 409, one score."""
    _, _, _, player = setup(per_game=3)
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        game_id, ids = started(c, "quiz", player)
    answers = [ans(i, "green", 1) for i in ids]
    barrier = threading.Barrier(8)
    statuses = []

    def worker():
        with TestClient(app) as c:  # own client/connection per thread
            barrier.wait()
            statuses.append(submit(c, "quiz", game_id, answers).status_code)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert sorted(statuses) == [200] + [409] * 7
    db.expire_all()
    session = db.get(GameSession, game_id)
    assert session.status == "completed" and session.total_score == 3 * 147 and session.correct_answers == 3
    assert len(broadcasts) == 1


def test_submit_unknown_game_is_404(client, setup):
    setup()
    response = submit(client, "quiz", 999999, [])
    assert response.status_code == 404
    assert response.json() == {"detail": "Game not found"}


def test_submit_unknown_event_is_404(client, setup):
    _, _, _, player = setup()
    game_id, _ = started(client, "quiz", player)
    assert submit(client, "nope", game_id, []).status_code == 404


def test_submit_game_of_another_event_is_404(client, setup, make_event, make_category, make_question, make_player, db, broadcasts):
    _, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    other = make_event(slug="other", questions_per_game=1)
    make_question(other, make_category(other))
    assert submit(client, "other", game_id, [ans(ids[0])]).status_code == 404  # right game, wrong event
    assert db.get(GameSession, game_id).status == "in_progress"
    assert broadcasts == []


def test_submit_on_closed_event_is_403_once_the_grace_period_is_over(client, setup, db, broadcasts):
    event, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    event.status = "closed"
    db.execute(update(GameSession).where(GameSession.id == game_id).values(started_at=utcnow() - timedelta(minutes=16)))
    db.commit()
    response = submit(client, "quiz", game_id, [ans(ids[0])])
    assert response.status_code == 403
    assert response.json() == {"detail": "event_closed"}
    assert db.get(GameSession, game_id).status == "in_progress"
    assert broadcasts == []


def test_submit_on_draft_event_is_404_but_admin_can(client, setup, db, admin_headers):
    event, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    event.status = "draft"
    db.commit()
    assert submit(client, "quiz", game_id, [ans(ids[0])]).status_code == 404
    assert submit(client, "quiz", game_id, [ans(ids[0])], headers=admin_headers).status_code == 200


def test_submit_survives_a_broken_broadcaster_notification(client, setup, monkeypatch):
    """A scoreboard hiccup must never fail the player's submit (the notification is best effort)."""
    from app.services import broadcaster

    class Exploding:
        def notify(self, event_id):
            raise RuntimeError("hub down")

    monkeypatch.setattr(broadcaster, "hub", Exploding())
    _, _, _, player = setup(per_game=1)
    game_id, ids = started(client, "quiz", player)
    assert submit(client, "quiz", game_id, [ans(ids[0], "green", 0)]).status_code == 200


# =============================================================================================
# submit: rank and totals
# =============================================================================================
def test_rank_is_computed_within_the_event_only(client, setup, make_event, make_player, make_game_session):
    event, _, _, player = setup(per_game=1)
    other = make_event(slug="other")
    make_game_session(other, make_player(other), total_score=9999)  # a far better score in ANOTHER event
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 20)]).json()
    assert body["rank"] == 1
    assert body["total_players"] == 1


def test_rank_counts_better_scores_and_ignores_unfinished_games(client, setup, make_player, make_game_session, db):
    event, _, _, player = setup(per_game=1)
    for score in (500, 300, 120):
        make_game_session(event, make_player(event), total_score=score)
    make_game_session(event, make_player(event), status="in_progress", total_score=10_000)  # not completed: ignored
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 0)]).json()  # 150
    assert body["game_session"]["total_score"] == 150
    assert body["rank"] == 3  # behind 500 and 300, ahead of 120
    assert body["total_players"] == 4


def test_equal_scores_rank_by_completion_time_like_the_scoreboard(client, setup, make_player, make_game_session, db):
    event, _, _, player = setup(per_game=1)
    early = make_game_session(event, make_player(event), total_score=150, completed_at=utcnow() - timedelta(minutes=5))
    game_id, ids = started(client, "quiz", player)
    body = submit(client, "quiz", game_id, [ans(ids[0], "green", 0)]).json()  # 150, completes AFTER `early`
    assert body["game_session"]["total_score"] == early.total_score
    assert body["rank"] == 2
    board = client.get("/api/events/quiz/scoreboard").json()
    assert [e["id"] for e in board] == [early.id, game_id]
    assert body["rank"] == next(e["rank"] for e in board if e["id"] == game_id)  # same ordering everywhere


def test_equal_scores_and_equal_timestamps_fall_back_to_the_session_id(client, setup, make_player, make_game_session):
    event, _, _, player = setup(per_game=1)
    game_id, ids = started(client, "quiz", player)
    submit(client, "quiz", game_id, [ans(ids[0], "green", 0)])
    ts = client.get("/api/events/quiz/scoreboard").json()[0]["completed_at"]
    same_moment = datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
    later = make_game_session(event, make_player(event), total_score=150, completed_at=same_moment)
    board = client.get("/api/events/quiz/scoreboard").json()
    assert [e["id"] for e in board] == [game_id, later.id]  # lower id first


def test_total_players_counts_completed_games_of_the_event(client, setup, make_player, make_game_session):
    event, _, _, player = setup(per_game=1)
    make_game_session(event, make_player(event), total_score=10)
    make_game_session(event, make_player(event), total_score=20)
    game_id, ids = started(client, "quiz", player)
    assert submit(client, "quiz", game_id, [ans(ids[0], "green", 0)]).json()["total_players"] == 3


# =============================================================================================
# load: pool smaller than the threadpool must not deadlock
# =============================================================================================
def test_concurrent_requests_beyond_the_pool_size_do_not_deadlock(tmp_path):
    """Regression: a handler that keeps its session open while FastAPI waits for a threadpool slot to
    serialise the response deadlocks the threadpool (all slots waiting for a connection) against the
    connection pool (all connections waiting for a slot) until ``pool_timeout`` -> 500s.

    Reproduced here with a 2-connection pool, 6 threadpool slots and 30 simultaneous player journeys.
    """
    import anyio.to_thread
    import httpx
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import QueuePool

    from app.database import Base, get_db
    from app.main import app
    from app.models import Category, Event, Question

    small_engine = create_engine(
        f"sqlite:///{tmp_path / 'pool.db'}",
        poolclass=QueuePool,
        pool_size=2,
        max_overflow=0,
        pool_timeout=3,
        connect_args={"check_same_thread": False, "timeout": 20},
    )
    Base.metadata.create_all(small_engine)
    factory = sessionmaker(bind=small_engine, autoflush=False, expire_on_commit=False)
    with factory() as seed:
        event = Event(slug="quiz", name="Quiz", game_title="Quiz", status="live", questions_per_game=2)
        seed.add(event)
        seed.flush()
        category = Category(event_id=event.id, name="Alpha")
        seed.add(category)
        seed.flush()
        seed.add_all(
            Question(event_id=event.id, category_id=category.id, question_text_en=f"Q{i}?", correct_answer="green")
            for i in range(6)
        )
        seed.commit()

    def override_get_db():
        session = factory()
        try:
            yield session
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db

    async def journey(client, i):
        assert (await client.get("/api/events/quiz")).status_code == 200
        registered = await client.post(
            "/api/events/quiz/players", json={"first_name": f"Player{i}", "last_name": "Test", "email": f"p{i}@example.com"}
        )
        assert registered.status_code == 201, registered.text
        started = await client.post("/api/events/quiz/games", json={"player_id": registered.json()["id"]})
        assert started.status_code == 200, started.text
        game = started.json()
        answers = [{"question_id": q["id"], "player_answer": "green", "time_taken": 1} for q in game["questions"]]
        done = await client.post(f"/api/events/quiz/games/{game['game_session_id']}/submit", json={"answers": answers})
        assert done.status_code == 200, done.text
        assert (await client.get("/api/events/quiz/scoreboard")).status_code == 200

    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        original = limiter.total_tokens
        limiter.total_tokens = 6
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=60) as client:
                started = time.monotonic()
                await asyncio.wait_for(asyncio.gather(*(journey(client, i) for i in range(30))), 45)
                assert time.monotonic() - started < 3, "requests waited for the pool timeout: connections are held too long"
        finally:
            limiter.total_tokens = original

    try:
        asyncio.run(scenario())
    finally:
        small_engine.dispose()


# =============================================================================================
# closed event: players mid-game keep their game for 15 minutes
# =============================================================================================
def close_event(db, event):
    event.status = "closed"
    db.commit()


def age_game(db, game_id, minutes):
    db.execute(update(GameSession).where(GameSession.id == game_id).values(started_at=utcnow() - timedelta(minutes=minutes)))
    db.commit()


def test_a_game_in_progress_can_still_be_submitted_after_the_event_is_closed(client, setup, db, broadcasts):
    event, _, _, player = setup(per_game=2)
    game_id, ids = started(client, "quiz", player)
    close_event(db, event)
    response = submit(client, "quiz", game_id, [ans(ids[0], "green", 0), ans(ids[1], "red", 0)])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["game_session"]["status"] == "completed"
    assert (body["game_session"]["total_score"], body["game_session"]["correct_answers"]) == (150, 1)
    assert body["rank"] == 1 and body["total_players"] == 1
    session = db.get(GameSession, game_id)
    assert session.status == "completed" and session.total_score == 150
    assert broadcasts == [event.id]  # the (still readable) scoreboard of the closed event updates
    board = client.get("/api/events/quiz/scoreboard").json()
    assert [e["id"] for e in board] == [game_id]


def test_the_grace_period_is_fifteen_minutes_from_the_start_of_the_game(client, setup, db, broadcasts):
    event, _, _, player = setup(per_game=1)
    close_event(db, event)
    inside, outside = (db.merge(GameSession(event_id=event.id, player_id=player.id, status="in_progress")) for _ in range(2))
    db.commit()
    age_game(db, inside.id, 14)
    age_game(db, outside.id, 16)
    assert submit(client, "quiz", inside.id, []).status_code == 200
    late = submit(client, "quiz", outside.id, [])
    assert (late.status_code, late.json()) == (403, {"detail": "event_closed"})
    assert db.get(GameSession, outside.id).status == "in_progress"
    assert broadcasts == [event.id]


def test_closing_the_event_does_not_restart_the_clock(client, setup, db, broadcasts):
    """The window is counted from the start of the game, not from the moment the admin closed the event."""
    event, _, _, player = setup(per_game=1)
    game_id, ids = started(client, "quiz", player)
    age_game(db, game_id, 40)  # a long forgotten game
    close_event(db, event)  # closed just now: still no grace for a game that started 40 minutes ago
    assert submit(client, "quiz", game_id, [ans(ids[0])]).status_code == 403


def test_closed_event_still_refuses_a_second_submit_unknown_games_and_abandoned_ones(client, setup, db, make_player):
    event, _, _, player = setup(per_game=1)
    game_id, ids = started(client, "quiz", player)
    assert submit(client, "quiz", game_id, [ans(ids[0])]).status_code == 200
    abandoned = db.merge(GameSession(event_id=event.id, player_id=player.id, status="abandoned"))
    db.commit()
    close_event(db, event)
    for target in (game_id, 999_999, abandoned.id):  # completed, unknown, abandoned
        response = submit(client, "quiz", target, [ans(ids[0])])
        assert (response.status_code, response.json()) == (403, {"detail": "event_closed"}), target


def test_closed_event_still_refuses_registrations_and_new_games_even_for_a_player_in_grace(client, setup, db):
    event, _, _, player = setup()
    game_id, _ = started(client, "quiz", player)
    close_event(db, event)
    new_game = start(client, "quiz", player.id)
    assert (new_game.status_code, new_game.json()) == (403, {"detail": "event_closed"})
    registration = client.post(
        "/api/events/quiz/players", json={"first_name": "Late", "last_name": "Comer", "email": "late@example.com"}
    )
    assert (registration.status_code, registration.json()) == (403, {"detail": "event_closed"})
    assert db.query(GameSession).count() == 1  # only the game that was already running
    assert db.get(GameSession, game_id).status == "in_progress"


def test_the_grace_period_does_not_open_draft_events_to_the_public(client, setup, db):
    event, _, _, player = setup()
    game_id, ids = started(client, "quiz", player)
    event.status = "draft"
    db.commit()
    assert submit(client, "quiz", game_id, [ans(ids[0])]).status_code == 404


def test_the_submit_token_is_still_checked_inside_the_grace_period(client, setup, db, monkeypatch):
    monkeypatch.setattr(settings, "REQUIRE_SUBMIT_TOKEN", True)
    event, _, _, player = setup(per_game=1)
    game = start(client, "quiz", player.id).json()
    close_event(db, event)
    url = f"/api/events/quiz/games/{game['game_session_id']}/submit"
    assert client.post(url, json={"answers": []}).status_code == 403
    assert client.post(url, json={"answers": [], "submit_token": game["submit_token"]}).status_code == 200


# =============================================================================================
# game integrity: the per-game submit token
# =============================================================================================
def start_with_token(client, player_id, slug="quiz"):
    body = start(client, slug, player_id).json()
    return body["game_session_id"], [q["id"] for q in body["questions"]], body["submit_token"]


def submit_with(client, game_id, answers, token=None, header=None, slug="quiz", **extra):
    body = {"answers": answers, **extra}
    if token is not None:
        body["submit_token"] = token
    headers = {"X-Game-Token": header} if header is not None else {}
    return client.post(f"/api/events/{slug}/games/{game_id}/submit", json=body, headers=headers)


NOT_AUTHORISED = {"detail": "invalid_game_token"}


@pytest.fixture
def require_token(monkeypatch):
    monkeypatch.setattr(settings, "REQUIRE_SUBMIT_TOKEN", True)


def test_start_returns_an_opaque_128_bit_url_safe_token_and_stores_only_its_hash(client, setup, db):
    _, _, _, player = setup()
    tokens = []
    for _ in range(5):
        game_id, _, token = start_with_token(client, player.id)
        assert re.fullmatch(r"[A-Za-z0-9_-]{22}", token)  # 16 random bytes, url-safe base64 without padding
        tokens.append(token)
        config = db.get(GameSession, game_id).game_config
        assert config["submit_token_hash"] == hashlib.sha256(token.encode()).hexdigest()
        assert token not in json.dumps(config)  # the secret itself is never persisted
    assert len(set(tokens)) == 5


def test_the_token_is_not_repeated_in_the_submit_response_or_the_admin_views(client, setup, admin_headers, db):
    event, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    done = submit_with(client, game_id, [ans(ids[0])], token=token)
    assert done.status_code == 200
    assert token not in done.text and "submit_token" not in done.text
    config_hash = db.get(GameSession, game_id).game_config["submit_token_hash"]
    for path in (f"/api/admin/results/{game_id}", f"/api/admin/events/{event.id}/results?status=all"):
        text = client.get(path, headers=admin_headers).text
        assert token not in text and config_hash not in text and "submit_token" not in text


def test_a_correct_token_in_the_body_or_in_the_header_is_accepted(client, setup, db):
    _, _, _, player = setup(per_game=1)
    first, ids, token = start_with_token(client, player.id)
    assert submit_with(client, first, [ans(ids[0])], token=token).status_code == 200
    second, ids, token = start_with_token(client, player.id)
    assert submit_with(client, second, [ans(ids[0])], header=token).status_code == 200
    third, ids, token = start_with_token(client, player.id)
    assert submit_with(client, third, [ans(ids[0])], token=token, header=token).status_code == 200


def test_without_a_token_a_submit_is_accepted_while_the_setting_is_off(client, setup, db):
    """Stage 1 of the rollout: frontends that do not send the token yet keep working."""
    assert settings.REQUIRE_SUBMIT_TOKEN is False
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    assert submit_with(client, game_id, [ans(ids[0])]).status_code == 200


@pytest.mark.parametrize("where", ["body", "header"])
def test_a_wrong_token_is_always_refused_even_while_the_setting_is_off(client, setup, db, broadcasts, where):
    assert settings.REQUIRE_SUBMIT_TOKEN is False
    _, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    wrong = token[:-1] + ("A" if token[-1] != "A" else "B")
    response = submit_with(client, game_id, [ans(ids[0])], **{"token" if where == "body" else "header": wrong})
    assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)
    assert db.get(GameSession, game_id).status == "in_progress"  # nothing scored
    assert broadcasts == []
    # the legitimate player can still finish: a wrong guess does not burn the game
    assert submit_with(client, game_id, [ans(ids[0])], token=token).status_code == 200
    assert broadcasts == [db.get(GameSession, game_id).event_id]


def test_a_token_from_another_game_is_refused(client, setup, db):
    _, _, _, player = setup(per_game=1)
    mine, my_ids, _ = start_with_token(client, player.id)
    _, _, stolen = start_with_token(client, player.id)  # e.g. the token of the previous game of the same player
    response = submit_with(client, mine, [ans(my_ids[0])], token=stolen)
    assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)


def test_every_presented_token_must_match(client, setup, db):
    _, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    assert submit_with(client, game_id, [ans(ids[0])], token=token, header="nope").status_code == 403
    assert submit_with(client, game_id, [ans(ids[0])], token="nope", header=token).status_code == 403
    assert db.get(GameSession, game_id).status == "in_progress"
    assert submit_with(client, game_id, [ans(ids[0])], token=token, header=token).status_code == 200


@pytest.mark.parametrize("junk", ["x" * 1000, "é" * 22, "😀", "a b", "<script>", "   "])
def test_hostile_tokens_are_a_403_never_a_500(client, setup, junk):
    _, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    response = submit_with(client, game_id, [ans(ids[0])], token=junk)
    assert response.status_code == 403 and response.json() == NOT_AUTHORISED


def test_a_non_ascii_or_oversized_header_is_a_403_never_a_500(client, setup):
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    for value in ("héllo".encode("latin-1"), "héllo".encode(), b"a" * 5000):
        response = submit_with(client, game_id, [ans(ids[0])], header=value)
        assert response.status_code == 403, value


def test_a_lone_surrogate_token_is_a_403_never_a_500(client, setup):
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    response = client.post(
        f"/api/events/quiz/games/{game_id}/submit",
        content=b'{"answers": [], "submit_token": "\\ud800"}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 403 and response.json() == NOT_AUTHORISED


def test_a_non_string_token_is_a_422(client, setup):
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    assert submit_with(client, game_id, [ans(ids[0])], token=None, submit_token=["x"]).status_code == 422


def test_the_token_is_compared_in_constant_time(client, setup, monkeypatch):
    calls = []
    real = security.secrets.compare_digest

    def spy(a, b):
        calls.append((type(a), type(b)))
        return real(a, b)

    monkeypatch.setattr(security.secrets, "compare_digest", spy)
    _, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    submit_with(client, game_id, [ans(ids[0])], token="wrong-token")
    submit_with(client, game_id, [ans(ids[0])], token=token)
    assert len(calls) == 2 and set(calls) == {(bytes, bytes)}


def test_the_token_is_checked_before_the_game_state_is_revealed(client, setup, db):
    """A caller without the token must not learn whether a game is finished (no 409 oracle on someone's game)."""
    _, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    assert submit_with(client, game_id, [ans(ids[0])], token=token).status_code == 200
    assert submit_with(client, game_id, [ans(ids[0])], token="wrong").status_code == 403
    again = submit_with(client, game_id, [ans(ids[0])], token=token)  # the real player retrying: still 409
    assert (again.status_code, again.json()) == (409, {"detail": "game_already_completed"})


def test_a_wrong_token_does_not_hide_an_unknown_game_or_event(client, setup):
    _, _, _, player = setup(per_game=1)
    start_with_token(client, player.id)
    assert submit_with(client, 999_999, [], token="whatever").status_code == 404
    assert submit_with(client, 1, [], token="whatever", slug="nope").status_code == 404


# --- stage 2: REQUIRE_SUBMIT_TOKEN -----------------------------------------------------------
def test_when_required_a_missing_token_is_a_403(client, setup, db, require_token, broadcasts):
    _, _, _, player = setup(per_game=1)
    game_id, ids, token = start_with_token(client, player.id)
    response = submit_with(client, game_id, [ans(ids[0])])
    assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)
    assert db.get(GameSession, game_id).status == "in_progress" and broadcasts == []


@pytest.mark.parametrize("blank", ["", "   "])
def test_when_required_a_blank_token_counts_as_missing(client, setup, require_token, blank):
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    assert submit_with(client, game_id, [ans(ids[0])], submit_token=blank).status_code == 403
    assert submit_with(client, game_id, [ans(ids[0])], header="").status_code == 403


def test_when_required_a_wrong_token_is_a_403(client, setup, require_token):
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    response = submit_with(client, game_id, [ans(ids[0])], token="nope")
    assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)


def test_when_required_the_right_token_works_in_body_and_header(client, setup, require_token):
    _, _, _, player = setup(per_game=1)
    first, ids, token = start_with_token(client, player.id)
    assert submit_with(client, first, [ans(ids[0])], token=token).status_code == 200
    second, ids, token = start_with_token(client, player.id)
    assert submit_with(client, second, [ans(ids[0])], header=token).status_code == 200


def test_games_started_before_tokens_existed_have_no_hash(client, setup, db, monkeypatch):
    """A session created by the previous version (no ``submit_token_hash`` in its config)."""
    event, _, _, player = setup(per_game=1)
    legacy = GameSession(event_id=event.id, player_id=player.id, status="in_progress", game_config={"timer_seconds": 20})
    bare = GameSession(event_id=event.id, player_id=player.id, status="in_progress", game_config=None)
    db.add_all([legacy, bare])
    db.commit()
    # setting off: no token is fine, any presented token cannot match
    assert submit_with(client, legacy.id, []).status_code == 200
    assert submit_with(client, bare.id, [], token="anything").status_code == 403
    assert db.get(GameSession, bare.id).status == "in_progress"
    # setting on: nothing can be proven for such a game
    monkeypatch.setattr(settings, "REQUIRE_SUBMIT_TOKEN", True)
    assert submit_with(client, bare.id, []).status_code == 403
    assert submit_with(client, bare.id, [], token="anything").status_code == 403


def test_an_admin_bearer_token_does_not_replace_the_game_token_when_required(client, setup, require_token, admin_headers):
    """The admin preview bypasses draft gating only; the game secret is still the game secret."""
    _, _, _, player = setup(per_game=1)
    game_id, ids, _ = start_with_token(client, player.id)
    response = client.post(
        f"/api/events/quiz/games/{game_id}/submit", json={"answers": []}, headers=admin_headers
    )
    assert response.status_code == 403
