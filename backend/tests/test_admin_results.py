"""Admin results API: list / search / detail / delete / score patch and the leads CSV export."""
import csv
import io
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.models import GameAnswer, GameSession, Player, utcnow
from app.services import broadcaster


def list_url(event_id, query=""):
    return f"/api/admin/events/{event_id}/results{query}"


def item_url(session_id, suffix=""):
    return f"/api/admin/results/{session_id}{suffix}"


@pytest.fixture
def notified(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(broadcaster, "notify_event_changed", lambda event_id: calls.append(event_id))
    return calls


def names(response):
    assert response.status_code == 200, response.text
    return [f"{i['player']['first_name']} {i['player']['last_name']}" for i in response.json()["items"]]


@pytest.fixture
def board(db, make_event, make_player, make_game_session):
    """Four completed games with distinct scores/times, one in progress, one abandoned, one in another event."""
    event, other = make_event(), make_event()
    now = utcnow()
    specs = [
        ("Ada", "Lovelace", "ada@example.com", 300, 40),
        ("Grace", "Hopper", "grace@navy.mil", 500, 30),
        ("Alan", "Turing", "alan@bletchley.uk", 500, 20),  # same score as Grace, finished later
        ("Linus", "Torvalds", "linus@kernel.org", 100, 10),
    ]
    sessions = []
    for first, last, email, score, minutes_ago in specs:
        player = make_player(event, first_name=first, last_name=last, email=email)
        sessions.append(
            make_game_session(
                event, player=player, total_score=score, correct_answers=score // 100, wrong_answers=1, unanswered=0,
                completed_at=now - timedelta(minutes=minutes_ago), started_at=now - timedelta(minutes=minutes_ago + 2),
            )
        )
    waiting = make_game_session(event, player=make_player(event, first_name="Pending", last_name="Pat", email="pat@example.com"), status="in_progress", total_score=0)
    gone = make_game_session(event, player=make_player(event, first_name="Gone", last_name="Gary", email="gary@example.com"), status="abandoned", total_score=0)
    foreign = make_game_session(other, player=make_player(other, first_name="Other", last_name="Event", email="o@example.com"), total_score=999)
    return event, other, sessions, waiting, gone, foreign


# ---------------------------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------------------------
def test_list_defaults_to_completed_games_most_recent_first(client, admin_headers, board):
    event, *_ = board
    response = client.get(list_url(event.id), headers=admin_headers)
    body = response.json()
    assert body["total"] == 4 and set(body) == {"items", "total"}
    # most recent completion first
    assert names(response) == ["Linus Torvalds", "Alan Turing", "Grace Hopper", "Ada Lovelace"]


def test_list_item_shape(client, admin_headers, board):
    event, *_ = board
    item = client.get(list_url(event.id, "?order=score&limit=1"), headers=admin_headers).json()["items"][0]
    assert set(item) == {
        "id", "player", "status", "total_score", "correct_answers", "wrong_answers", "unanswered", "started_at", "completed_at",
    }
    assert set(item["player"]) == {"id", "first_name", "last_name", "email", "phone_number", "consent_at"}
    assert item["status"] == "completed" and item["completed_at"].endswith("Z") and item["started_at"].endswith("Z")
    assert item["player"]["email"] == "grace@navy.mil"  # admins see the full details


def test_list_order_by_score_breaks_ties_by_earliest_completion(client, admin_headers, board):
    event, *_ = board
    response = client.get(list_url(event.id, "?order=score"), headers=admin_headers)
    # Grace and Alan both have 500; Grace finished first (30 minutes ago vs 20)
    assert names(response) == ["Grace Hopper", "Alan Turing", "Ada Lovelace", "Linus Torvalds"]


def test_list_status_filter(client, admin_headers, board):
    event, *_ = board
    assert client.get(list_url(event.id, "?status=all"), headers=admin_headers).json()["total"] == 6
    assert names(client.get(list_url(event.id, "?status=in_progress"), headers=admin_headers)) == ["Pending Pat"]
    assert names(client.get(list_url(event.id, "?status=abandoned"), headers=admin_headers)) == ["Gone Gary"]
    assert client.get(list_url(event.id, "?status=completed"), headers=admin_headers).json()["total"] == 4
    assert client.get(list_url(event.id, "?status=bogus"), headers=admin_headers).status_code == 422


def test_list_is_scoped_to_the_event(client, admin_headers, board):
    event, other, *_ = board
    assert "Other Event" not in names(client.get(list_url(event.id, "?status=all"), headers=admin_headers))
    assert names(client.get(list_url(other.id), headers=admin_headers)) == ["Other Event"]


@pytest.mark.parametrize(
    "term,expected",
    [
        ("ada", ["Ada Lovelace"]),
        ("ADA", ["Ada Lovelace"]),
        ("lovelace", ["Ada Lovelace"]),
        ("hopper", ["Grace Hopper"]),
        ("navy.mil", ["Grace Hopper"]),  # e-mail
        ("GRACE@NAVY", ["Grace Hopper"]),
        ("ada lovelace", ["Ada Lovelace"]),  # full name
        ("a lo", ["Ada Lovelace"]),  # across the space
        ("tor", ["Linus Torvalds"]),
        ("example.com", ["Ada Lovelace"]),  # the other example.com players are in progress / abandoned: hidden by default
        ("zzz", []),
        ("  ada  ", ["Ada Lovelace"]),
    ],
)
def test_list_search(client, admin_headers, board, term, expected):
    event, *_ = board
    response = client.get(list_url(event.id), params={"search": term}, headers=admin_headers)
    assert sorted(names(response)) == sorted(expected)
    assert response.json()["total"] == len(expected)


def test_list_search_wildcards_and_injection_are_literal(client, admin_headers, db, board):
    event, *_ = board
    for term in ("%", "_", "a%a", "\\", "' OR 1=1 --", "'; DROP TABLE players; --", "\x00"):
        response = client.get(list_url(event.id), params={"search": term}, headers=admin_headers)
        assert response.status_code == 200, term
        if term not in ("\x00",):
            assert response.json()["total"] == 0, term
    assert db.scalar(select(func.count()).select_from(Player)) == 7


def test_list_pagination(client, admin_headers, db, make_event, make_player, make_game_session):
    event = make_event()
    now = utcnow()
    for i in range(23):
        make_game_session(event, player=make_player(event, first_name=f"P{i:02d}"), total_score=i, completed_at=now - timedelta(minutes=i))
    page = lambda skip, limit, order="score": client.get(list_url(event.id, f"?skip={skip}&limit={limit}&order={order}"), headers=admin_headers).json()  # noqa: E731
    first, second, third = page(0, 10), page(10, 10), page(20, 10)
    assert first["total"] == second["total"] == third["total"] == 23
    assert [len(p["items"]) for p in (first, second, third)] == [10, 10, 3]
    scores = [i["total_score"] for p in (first, second, third) for i in p["items"]]
    assert scores == sorted(scores, reverse=True) and len(set(scores)) == 23
    assert page(100, 10) == {"items": [], "total": 23}
    recent = [i["player"]["first_name"] for i in page(0, 5, "recent")["items"]]
    assert recent == ["P00", "P01", "P02", "P03", "P04"]
    for query in ("?limit=0", "?limit=501", "?skip=-1", "?order=random"):
        assert client.get(list_url(event.id, query), headers=admin_headers).status_code == 422


def test_list_total_follows_the_search(client, admin_headers, db, make_event, make_player, make_game_session):
    event = make_event()
    for i in range(12):
        make_game_session(event, player=make_player(event, first_name="Match" if i % 2 else "Other", last_name=f"N{i}"))
    body = client.get(list_url(event.id, "?search=match&limit=2"), headers=admin_headers).json()
    assert body["total"] == 6 and len(body["items"]) == 2


def test_list_unknown_event_is_404(client, admin_headers):
    assert client.get(list_url(999), headers=admin_headers).status_code == 404
    assert client.get("/api/admin/events/999/results.csv", headers=admin_headers).status_code == 404


def test_list_in_progress_games_are_sorted_by_start_time(client, admin_headers, make_event, make_player, make_game_session):
    event = make_event()
    now = utcnow()
    older = make_game_session(event, player=make_player(event, first_name="Older"), status="in_progress", started_at=now - timedelta(minutes=9))
    newer = make_game_session(event, player=make_player(event, first_name="Newer"), status="in_progress", started_at=now - timedelta(minutes=1))
    assert older.completed_at is None and newer.completed_at is None
    assert names(client.get(list_url(event.id, "?status=in_progress"), headers=admin_headers)) == ["Newer Lovelace", "Older Lovelace"]


# ---------------------------------------------------------------------------------------------
# detail
# ---------------------------------------------------------------------------------------------
def test_result_detail_lists_answers_with_question_texts(client, admin_headers, db, make_event, make_player, make_question, make_game_session):
    event = make_event()
    q1 = make_question(event, question_text_en="First?", question_text_fr="Premier ?")
    q2 = make_question(event, question_text_en="Second?", question_text_fr=None, question_format="two_choices", correct_answer="red")
    q3 = make_question(event, question_text_en="Third?")
    player = make_player(event, first_name="Zoë", last_name="Müller", email="zoe@example.com", phone_number="+33612345678", consent_at=utcnow())
    session = make_game_session(
        event, player=player,
        answers=[
            {"question": q1, "player_answer": "green", "time_taken": 3.5},
            {"question": q2, "player_answer": "green", "time_taken": 7.25},  # wrong (red is correct)
            {"question": q3, "player_answer": None},  # unanswered
        ],
    )
    body = client.get(item_url(session.id), headers=admin_headers).json()
    assert body["id"] == session.id and body["status"] == "completed" and body["total_score"] == 100
    assert (body["correct_answers"], body["wrong_answers"], body["unanswered"]) == (1, 1, 1)
    assert body["player"]["first_name"] == "Zoë" and body["player"]["phone_number"] == "+33612345678"
    assert body["player"]["consent_at"].endswith("Z")
    answers = body["answers"]
    assert [a["question_order"] for a in answers] == [1, 2, 3]
    assert answers[0] == {
        "question_id": q1.id, "question_text_en": "First?", "question_text_fr": "Premier ?", "green_label_en": "TRUE",
        "red_label_en": "FALSE", "correct_answer": "green", "player_answer": "green", "is_correct": True, "time_taken": 3.5,
        "points_earned": 100, "question_order": 1,
    }
    assert answers[1]["question_text_fr"] is None and answers[1]["green_label_en"] == "Option A" and answers[1]["is_correct"] is False
    assert answers[1]["correct_answer"] == "red" and answers[1]["points_earned"] == 0
    assert answers[2]["player_answer"] is None and answers[2]["is_correct"] is None and answers[2]["time_taken"] is None


def test_result_detail_without_answers_and_404(client, admin_headers, make_event, make_game_session):
    session = make_game_session(make_event(), status="in_progress")
    assert client.get(item_url(session.id), headers=admin_headers).json()["answers"] == []
    assert client.get(item_url(99999), headers=admin_headers).status_code == 404


# ---------------------------------------------------------------------------------------------
# delete / patch score (and the scoreboard notification)
# ---------------------------------------------------------------------------------------------
def test_delete_result_removes_it_and_its_answers_and_notifies(client, admin_headers, db, make_event, make_question, make_game_session, notified):
    event = make_event()
    q = make_question(event)
    doomed = make_game_session(event, answers=[{"question": q, "player_answer": "green"}])
    kept = make_game_session(event, answers=[{"question": q, "player_answer": "red"}])
    doomed_id, kept_id, event_id, player_id = doomed.id, kept.id, event.id, doomed.player_id
    response = client.delete(item_url(doomed_id), headers=admin_headers)
    assert response.status_code == 204 and response.content == b""
    assert notified == [event_id]
    assert db.get(GameSession, doomed_id) is None and db.get(GameSession, kept_id) is not None
    assert db.scalar(select(func.count()).select_from(GameAnswer).where(GameAnswer.game_session_id == doomed_id)) == 0
    assert db.scalar(select(func.count()).select_from(GameAnswer).where(GameAnswer.game_session_id == kept_id)) == 1
    assert db.get(Player, player_id) is None  # it was the player's only game: the registration goes with it
    assert client.get(item_url(doomed_id), headers=admin_headers).status_code == 404
    assert client.delete(item_url(doomed_id), headers=admin_headers).status_code == 404
    assert notified == [event_id]  # a 404 does not notify


def test_delete_result_can_erase_the_player_and_all_their_games(client, admin_headers, db, make_event, make_player, make_game_session, notified):
    event = make_event()
    leaver, other = make_player(event), make_player(event)
    first = make_game_session(event, player=leaver, total_score=10)
    second = make_game_session(event, player=leaver, total_score=20)
    survivor = make_game_session(event, player=other, total_score=30)
    leaver_id, first_id, second_id, survivor_id, other_id = leaver.id, first.id, second.id, survivor.id, other.id
    response = client.delete(item_url(first_id) + "?purge_player=true", headers=admin_headers)
    assert response.status_code == 204
    assert db.get(Player, leaver_id) is None  # name, e-mail and phone are gone ...
    assert db.get(GameSession, first_id) is None and db.get(GameSession, second_id) is None  # ... with every game
    assert db.get(Player, other_id) is not None and db.get(GameSession, survivor_id) is not None
    assert notified == [event.id]
    assert client.delete(item_url(first_id) + "?purge_player=true", headers=admin_headers).status_code == 404


def test_deleting_the_last_game_of_a_player_deletes_the_player(client, admin_headers, db, make_event, make_player, make_game_session, notified):
    event = make_event()
    leaver, bystander = make_player(event, email="leaver@example.com"), make_player(event, email="bystander@example.com")
    game = make_game_session(event, player=leaver, total_score=10)
    keep = make_game_session(event, player=bystander, total_score=30)
    game_id, leaver_id, bystander_id, keep_id = game.id, leaver.id, bystander.id, keep.id
    assert client.delete(item_url(game_id), headers=admin_headers).status_code == 204
    assert db.get(Player, leaver_id) is None  # name, e-mail and phone are gone with the result
    assert db.get(Player, bystander_id) is not None and db.get(GameSession, keep_id) is not None
    assert notified == [event.id]


def test_a_player_with_other_games_is_kept_until_the_last_one_is_deleted(client, admin_headers, db, make_event, make_player, make_game_session, notified):
    event = make_event()
    player = make_player(event)
    finished = make_game_session(event, player=player, total_score=10)
    running = make_game_session(event, player=player, status="in_progress")
    gave_up = make_game_session(event, player=player, status="abandoned")
    player_id, ids = player.id, [finished.id, running.id, gave_up.id]
    assert client.delete(item_url(ids[0]), headers=admin_headers).status_code == 204
    assert db.get(Player, player_id) is not None  # an in-progress and an abandoned game remain
    assert client.delete(item_url(ids[1]), headers=admin_headers).status_code == 204
    assert db.get(Player, player_id) is not None
    assert client.delete(item_url(ids[2]), headers=admin_headers).status_code == 204
    assert db.get(Player, player_id) is None  # the last one took the registration with it
    assert db.query(GameSession).count() == 0
    assert notified == [event.id] * 3


def test_deleting_an_unfinished_game_also_erases_a_player_who_has_no_other_game(client, admin_headers, db, make_event, make_player, make_game_session):
    event = make_event()
    player = make_player(event)
    waiting = make_game_session(event, player=player, status="in_progress")
    player_id = player.id
    assert client.delete(item_url(waiting.id), headers=admin_headers).status_code == 204
    assert db.get(Player, player_id) is None


def test_a_failed_delete_erases_nobody(client, admin_headers, db, make_event, make_player, make_game_session, notified):
    event = make_event()
    stay = make_player(event)  # registered, never played: not reachable through a result, so never touched here
    other = make_game_session(event, player=make_player(event))
    assert client.delete(item_url(99999), headers=admin_headers).status_code == 404
    assert db.query(Player).count() == 2
    assert db.get(Player, stay.id) is not None and db.get(GameSession, other.id) is not None
    assert notified == []


def test_deleting_the_last_game_cascades_to_its_answers_and_spares_other_events(client, admin_headers, db, make_event, make_player, make_question, make_game_session):
    event, other_event = make_event(), make_event()
    q, other_q = make_question(event), make_question(other_event)
    mine = make_game_session(event, answers=[{"question": q, "player_answer": "green"}, {"question": q, "player_answer": "red"}])
    theirs = make_game_session(other_event, answers=[{"question": other_q, "player_answer": "green"}])
    mine_id, theirs_id, theirs_player = mine.id, theirs.id, theirs.player_id
    assert client.delete(item_url(mine_id), headers=admin_headers).status_code == 204
    assert db.scalar(select(func.count()).select_from(GameAnswer)) == 1  # only the other event's answer is left
    assert db.get(GameSession, theirs_id) is not None and db.get(Player, theirs_player) is not None


# ---------------------------------------------------------------------------------------------
# purge every result of an event
# ---------------------------------------------------------------------------------------------
def purge_url(event_id, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"/api/admin/events/{event_id}/results" + (f"?{query}" if query else "")


@pytest.fixture
def populated(db, make_event, make_player, make_question, make_game_session):
    """Event "mine": 3 players with games (2 completed, 1 in progress), 2 who never finished one (one never
    started a game, one has an abandoned game); plus a second event with its own data that must survive."""
    mine, other = make_event(slug="mine"), make_event(slug="other")
    q, other_q = make_question(mine), make_question(other)
    played = [make_player(mine, email=f"p{i}@example.com") for i in range(3)]
    games = [
        make_game_session(mine, player=played[0], answers=[{"question": q, "player_answer": "green"}], total_score=100),
        make_game_session(mine, player=played[1], answers=[{"question": q, "player_answer": "red"}], total_score=0),
        make_game_session(mine, player=played[2], status="in_progress"),
    ]
    never_started = make_player(mine, email="never@example.com")
    gave_up = make_player(mine, email="gaveup@example.com")
    games.append(make_game_session(mine, player=gave_up, status="abandoned"))
    foreign_player = make_player(other, email="foreign@example.com")
    foreign = make_game_session(other, player=foreign_player, answers=[{"question": other_q, "player_answer": "green"}], total_score=999)
    return {
        "event": mine, "other": other, "games": games, "players": [*played, never_started, gave_up],
        "foreign": foreign, "foreign_player": foreign_player, "question": q,
    }


def test_purge_removes_every_game_of_the_event_but_keeps_the_players_by_default(client, admin_headers, db, populated, notified):
    mine, foreign = populated["event"], populated["foreign"]
    response = client.delete(purge_url(mine.id, confirm="mine"), headers=admin_headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted_results": 4, "deleted_players": 0}
    assert db.query(GameSession).filter_by(event_id=mine.id).count() == 0  # completed, in progress, abandoned: all
    assert db.query(Player).filter_by(event_id=mine.id).count() == 5  # registrations stay
    assert notified == [mine.id]
    # the other event is untouched, scoreboard and stats of this one are empty
    assert db.get(GameSession, foreign.id) is not None and db.get(Player, populated["foreign_player"].id) is not None
    assert client.get("/api/events/mine/scoreboard").json() == []
    stats = client.get(f"/api/admin/events/{mine.id}/stats", headers=admin_headers).json()
    assert (stats["games_completed"], stats["games_in_progress"], stats["players"]) == (0, 0, 5)


def test_purge_cascades_to_the_answers_and_only_those_of_the_event(client, admin_headers, db, populated):
    mine = populated["event"]
    assert db.scalar(select(func.count()).select_from(GameAnswer)) == 3
    client.delete(purge_url(mine.id, confirm="mine"), headers=admin_headers)
    assert db.scalar(select(func.count()).select_from(GameAnswer)) == 1  # the foreign game's answer
    assert db.get(GameSession, populated["foreign"].id).answers  # ... still attached to its game


def test_purge_with_include_players_removes_every_player_of_the_event(client, admin_headers, db, populated, notified):
    mine = populated["event"]
    response = client.delete(purge_url(mine.id, confirm="mine", include_players="true"), headers=admin_headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted_results": 4, "deleted_players": 5}  # incl. the two who never finished a game
    assert db.query(Player).filter_by(event_id=mine.id).count() == 0
    assert db.query(GameSession).filter_by(event_id=mine.id).count() == 0
    assert notified == [mine.id]
    # nothing else goes: the event itself, its questions, the other event
    assert db.get(type(mine), mine.id) is not None
    assert db.get(type(populated["question"]), populated["question"].id) is not None
    assert db.get(Player, populated["foreign_player"].id) is not None
    assert db.get(GameSession, populated["foreign"].id) is not None
    assert db.scalar(select(func.count()).select_from(GameAnswer)) == 1
    assert client.get("/api/events/mine").json()["stats"] == {"players": 0, "games_completed": 0}


def test_purge_include_players_false_is_the_default(client, admin_headers, db, populated):
    response = client.delete(purge_url(populated["event"].id, confirm="mine", include_players="false"), headers=admin_headers)
    assert response.json() == {"deleted_results": 4, "deleted_players": 0}
    assert db.query(Player).filter_by(event_id=populated["event"].id).count() == 5


@pytest.mark.parametrize("params", [{}, {"confirm": "wrong"}, {"confirm": "MINE"}, {"confirm": "mine "}, {"confirm": "other"}, {"confirm": ""}])
def test_purge_requires_the_event_slug_as_confirmation(client, admin_headers, db, populated, notified, params):
    mine = populated["event"]
    response = client.delete(purge_url(mine.id, include_players="true", **params), headers=admin_headers)
    assert response.status_code == 400, response.text
    assert "confirm" in response.json()["detail"]
    assert db.query(GameSession).count() == 5 and db.query(Player).count() == 6  # nothing was deleted
    assert notified == []


def test_purge_of_an_unknown_event_is_404_and_needs_an_admin(client, admin_headers, db, populated):
    assert client.delete(purge_url(99999, confirm="mine"), headers=admin_headers).status_code == 404
    assert client.delete(purge_url(populated["event"].id, confirm="mine")).status_code == 401
    assert client.delete(purge_url(populated["event"].id, confirm="mine"), headers={"Authorization": "Bearer nope"}).status_code == 401
    assert db.query(GameSession).count() == 5


def test_purge_rejects_a_malformed_include_players(client, admin_headers, populated):
    response = client.delete(purge_url(populated["event"].id, confirm="mine", include_players="maybe"), headers=admin_headers)
    assert response.status_code == 422


def test_purge_of_an_empty_event_is_a_harmless_200(client, admin_headers, make_event, notified):
    event = make_event(slug="empty")
    response = client.delete(purge_url(event.id, confirm="empty", include_players="true"), headers=admin_headers)
    assert response.status_code == 200 and response.json() == {"deleted_results": 0, "deleted_players": 0}
    assert notified == [event.id]


def test_purge_is_repeatable(client, admin_headers, populated):
    url = purge_url(populated["event"].id, confirm="mine", include_players="true")
    assert client.delete(url, headers=admin_headers).json() == {"deleted_results": 4, "deleted_players": 5}
    assert client.delete(url, headers=admin_headers).json() == {"deleted_results": 0, "deleted_players": 0}


def test_purge_succeeds_even_if_the_broadcaster_fails(client, admin_headers, db, populated, monkeypatch):
    def boom(_event_id):
        raise RuntimeError("hub down")

    monkeypatch.setattr(broadcaster.hub, "notify", boom)
    response = client.delete(purge_url(populated["event"].id, confirm="mine"), headers=admin_headers)
    assert response.status_code == 200 and response.json()["deleted_results"] == 4


def test_a_player_can_register_and_play_again_after_a_purge(client, admin_headers, db, populated, make_category, make_question):
    """The purge is a reset, not a lock: the event keeps working afterwards."""
    mine = populated["event"]
    mine.questions_per_game = 1
    db.commit()
    client.delete(purge_url(mine.id, confirm="mine", include_players="true"), headers=admin_headers)
    registered = client.post("/api/events/mine/players", json={"first_name": "New", "last_name": "Comer", "email": "new@example.com"})
    assert registered.status_code == 201
    game = client.post("/api/events/mine/games", json={"player_id": registered.json()["id"]})
    assert game.status_code == 200, game.text


def test_patch_score_updates_and_notifies(client, admin_headers, db, make_event, make_game_session, notified):
    event = make_event()
    session = make_game_session(event, total_score=120)
    session_id, event_id = session.id, event.id
    response = client.patch(item_url(session_id, "/score"), json={"total_score": 777}, headers=admin_headers)
    assert response.status_code == 200 and response.json() == {"id": session_id, "total_score": 777}
    assert db.get(GameSession, session_id).total_score == 777
    assert notified == [event_id]
    assert client.patch(item_url(session_id, "/score"), json={"total_score": 0}, headers=admin_headers).json()["total_score"] == 0
    assert client.get(item_url(session_id), headers=admin_headers).json()["total_score"] == 0


@pytest.mark.parametrize("body", [{"total_score": -1}, {"total_score": "abc"}, {"total_score": 1.5}, {"total_score": None}, {}, {"score": 10}, {"total_score": 10_000_001}])
def test_patch_score_validation(client, admin_headers, make_event, make_game_session, notified, body):
    session = make_game_session(make_event(), total_score=50)
    assert client.patch(item_url(session.id, "/score"), json=body, headers=admin_headers).status_code == 422
    assert client.get(item_url(session.id), headers=admin_headers).json()["total_score"] == 50
    assert notified == []


def test_patch_score_unknown_result_is_404(client, admin_headers, notified):
    assert client.patch(item_url(99999, "/score"), json={"total_score": 1}, headers=admin_headers).status_code == 404
    assert notified == []


def test_reads_never_notify(client, admin_headers, board, notified):
    event, *_, foreign = board
    client.get(list_url(event.id), headers=admin_headers)
    client.get(item_url(foreign.id), headers=admin_headers)
    client.get(f"/api/admin/events/{event.id}/results.csv", headers=admin_headers)
    assert notified == []


def test_mutations_succeed_even_if_the_broadcaster_fails(client, admin_headers, db, make_event, make_game_session, monkeypatch):
    def boom(_event_id):
        raise RuntimeError("hub down")

    monkeypatch.setattr(broadcaster.hub, "notify", boom)  # notify_event_changed swallows it
    session = make_game_session(make_event(), total_score=5)
    session_id = session.id
    assert client.patch(item_url(session_id, "/score"), json={"total_score": 6}, headers=admin_headers).status_code == 200
    assert client.delete(item_url(session_id), headers=admin_headers).status_code == 204


# ---------------------------------------------------------------------------------------------
# leads CSV
# ---------------------------------------------------------------------------------------------
def read_csv(response):
    assert response.status_code == 200, response.text
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


def test_leads_csv_headers_bom_and_content(client, admin_headers, board):
    event, *_ = board
    response = client.get(f"/api/admin/events/{event.id}/results.csv", headers=admin_headers)
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == f'attachment; filename="{event.slug}-leads.csv"'
    assert response.content.startswith(b"\xef\xbb\xbf")  # BOM: Excel reads the accents correctly
    rows = read_csv(response)
    assert rows[0] == ["rank", "first_name", "last_name", "email", "phone", "consent_at", "score", "correct", "wrong", "completed_at"]
    assert len(rows) == 5  # only the 4 completed games
    # ranked by score, ties by earliest completion
    assert [(r[0], r[1], r[6]) for r in rows[1:]] == [("1", "Grace", "500"), ("2", "Alan", "500"), ("3", "Ada", "300"), ("4", "Linus", "100")]
    assert rows[1][3] == "grace@navy.mil" and rows[1][8] == "1"
    assert rows[1][9].endswith("Z") and "T" in rows[1][9]


def test_leads_csv_contains_consent_phone_and_accents(client, admin_headers, make_event, make_player, make_game_session):
    event = make_event()
    consent = utcnow().replace(microsecond=0)
    player = make_player(event, first_name="Zoë", last_name="Müller", email="zoe@example.com", phone_number="0612345678", consent_at=consent)
    make_game_session(event, player=player, total_score=10)
    make_game_session(event, player=make_player(event, first_name="No", last_name="Consent", email="nc@example.com"), total_score=5)
    rows = read_csv(client.get(f"/api/admin/events/{event.id}/results.csv", headers=admin_headers))
    assert rows[1][1:5] == ["Zoë", "Müller", "zoe@example.com", "0612345678"]
    assert rows[1][5] == consent.isoformat() + "Z"
    assert rows[2][4] == "" and rows[2][5] == ""  # no phone, no consent


def test_leads_csv_empty_event_is_just_the_header(client, admin_headers, make_event):
    event = make_event()
    rows = read_csv(client.get(f"/api/admin/events/{event.id}/results.csv", headers=admin_headers))
    assert len(rows) == 1


def test_leads_csv_neutralises_formula_injection(client, admin_headers, make_event, make_player, make_game_session):
    event = make_event()
    attackers = [
        ("=HYPERLINK(\"http://evil.example\",\"click\")", "+SUM(1+1)", "-cmd@example.com", "@SUM(A1)"),
        ("\tTabbed", "\rReturned", "ok@example.com", "=1+1"),
        ("Normal", "Person", "normal@example.com", "+33 6 12 34 56 78"),
    ]
    for score, (first, last, email, phone) in enumerate(attackers, start=1):
        make_game_session(event, player=make_player(event, first_name=first, last_name=last, email=email, phone_number=phone), total_score=score)
    response = client.get(f"/api/admin/events/{event.id}/results.csv", headers=admin_headers)
    rows = read_csv(response)
    data = rows[1:]
    assert len(data) == 3
    for row in data:
        for cell in row[1:5]:
            assert not cell.startswith(("=", "+", "-", "@", "\t", "\r")) or cell == "+33 6 12 34 56 78", cell
    by_score = {r[6]: r for r in data}
    assert by_score["1"][1] == "'=HYPERLINK(\"http://evil.example\",\"click\")"
    assert by_score["1"][2] == "'+SUM(1+1)" and by_score["1"][3] == "'-cmd@example.com" and by_score["1"][4] == "'@SUM(A1)"
    assert by_score["2"][1] == "'\tTabbed" and by_score["2"][2] == "'\rReturned" and by_score["2"][4] == "'=1+1"
    assert by_score["3"][1] == "Normal" and by_score["3"][4] == "+33 6 12 34 56 78"  # a real phone number is NOT corrupted
    # numbers (rank, score, counts) are written as plain numbers
    assert [r[0] for r in data] == ["1", "2", "3"] and all(r[6].isdigit() for r in data)


def test_leads_csv_is_scoped_to_the_event(client, admin_headers, board):
    _, other, *_ = board
    rows = read_csv(client.get(f"/api/admin/events/{other.id}/results.csv", headers=admin_headers))
    assert [r[1] for r in rows[1:]] == ["Other"]
