"""GET /api/events/{slug}/games/{game_id}/result: the result of a COMPLETED game, read again.

The point of the endpoint: the server scored the game but the response never reached the player (network lost
on the way back), the retry gets 409 ``game_already_completed``, and the client needs the result it is owed.
It must hand it out to that player and to nobody else: the guard is the game's submit token (``X-Game-Token``).
"""
import json
from datetime import timedelta

import pytest
from sqlalchemy import update

from app import security
from app.config import settings
from app.models import GameSession, utcnow

NOT_AUTHORISED = {"detail": "invalid_game_token"}
NOT_COMPLETED = {"detail": "game_not_completed"}


@pytest.fixture
def setup(make_event, make_category, make_question, make_player):
    """A live event ("quiz") with 2 categories x 3 questions (correct answer: green) and a player."""

    def _setup(per_game=3, **event_kwargs):
        event = make_event(slug="quiz", questions_per_game=per_game, **event_kwargs)
        cats = [make_category(event, name="Alpha"), make_category(event, name="Beta")]
        for i in range(6):
            make_question(event, cats[i % 2])
        return event, make_player(event)

    return _setup


@pytest.fixture
def require_token(monkeypatch):
    monkeypatch.setattr(settings, "REQUIRE_SUBMIT_TOKEN", True)


def play(client, player, slug="quiz", answers=("green", "red", None), time_taken=1.5, submit=True):
    """Start a game; optionally submit it. Returns ``(game_id, token, submit response or None)``."""
    started = client.post(f"/api/events/{slug}/games", json={"player_id": player.id})
    assert started.status_code == 200, started.text
    game = started.json()
    if not submit:
        return game["game_session_id"], game["submit_token"], None
    body = {
        "answers": [
            {"question_id": q["id"], "player_answer": answer, "time_taken": time_taken}
            for q, answer in zip(game["questions"], answers, strict=False)
        ]
    }
    done = client.post(
        f"/api/events/{slug}/games/{game['game_session_id']}/submit",
        json=body,
        headers={"X-Game-Token": game["submit_token"]},
    )
    assert done.status_code == 200, done.text
    return game["game_session_id"], game["submit_token"], done


def result(client, game_id, token=None, slug="quiz", headers=None, **kwargs):
    headers = dict(headers or {})
    if token is not None:
        headers["X-Game-Token"] = token
    return client.get(f"/api/events/{slug}/games/{game_id}/result", headers=headers, **kwargs)


def wrong(token):
    return token[:-1] + ("A" if token[-1] != "A" else "B")


# ---------------------------------------------------------------------------------------------
# the payload
# ---------------------------------------------------------------------------------------------
def test_the_result_is_exactly_what_submit_returned(client, setup, make_player):
    event, player = setup()
    game_id, token, done = play(client, player)
    response = result(client, game_id, token)
    assert response.status_code == 200, response.text
    assert response.json() == done.json()
    body = response.json()
    assert set(body) == {"game_session", "rank", "total_players", "review"}
    assert body["game_session"]["status"] == "completed" and body["game_session"]["player_id"] == player.id
    assert [r["player_answer"] for r in body["review"]] == ["green", "red", None]  # incl. the unanswered one
    assert (body["rank"], body["total_players"]) == (1, 1)
    first = body["review"][0]
    assert {"correct_answer", "explanation_en", "explanation_fr", "green_label_en", "category"} <= set(first)


def test_reading_the_result_twice_gives_the_same_answer_and_changes_nothing(client, setup, db):
    event, player = setup()
    game_id, token, done = play(client, player)
    before = db.get(GameSession, game_id).total_score
    assert result(client, game_id, token).json() == result(client, game_id, token).json() == done.json()
    db.expire_all()
    assert db.get(GameSession, game_id).total_score == before


def test_the_token_is_not_echoed_in_the_result(client, setup, db):
    event, player = setup()
    game_id, token, _ = play(client, player)
    text = result(client, game_id, token).text
    assert token not in text and "submit_token" not in text
    assert db.get(GameSession, game_id).game_config["submit_token_hash"] not in text


def test_the_result_follows_a_score_correction_made_by_an_admin(client, setup, admin_headers):
    event, player = setup()
    game_id, token, _ = play(client, player)
    patched = client.patch(f"/api/admin/results/{game_id}/score", json={"total_score": 4242}, headers=admin_headers)
    assert patched.status_code == 200, patched.text
    assert result(client, game_id, token).json()["game_session"]["total_score"] == 4242


# ---------------------------------------------------------------------------------------------
# rank / total_players: same computation as submit, evaluated now
# ---------------------------------------------------------------------------------------------
def test_rank_and_total_count_the_completed_games_of_this_event_only(
    client, setup, make_event, make_player, make_game_session, db
):
    event, player = setup()
    game_id, token, done = play(client, player, answers=("green", "green", "green"), time_taken=0)
    score = done.json()["game_session"]["total_score"]
    # two better games in this event, one equal-but-later (behind), one worse, one unfinished, and a better game elsewhere
    make_game_session(event, make_player(event), total_score=score + 10, completed_at=utcnow() - timedelta(minutes=5))
    make_game_session(event, make_player(event), total_score=score + 1, completed_at=utcnow() - timedelta(minutes=4))
    make_game_session(event, make_player(event), total_score=score, completed_at=utcnow() + timedelta(minutes=1))
    make_game_session(event, make_player(event), total_score=score - 1, completed_at=utcnow() - timedelta(minutes=3))
    make_game_session(event, make_player(event), status="in_progress", total_score=score + 500)
    other = make_event(slug="elsewhere")
    make_game_session(other, make_player(other), total_score=score + 999)
    body = result(client, game_id, token).json()
    assert (body["rank"], body["total_players"]) == (3, 5)  # submit said 1/1: the board moved since


def test_equal_scores_rank_by_completion_time_then_by_session_id(client, setup, make_player, make_game_session, db):
    event, player = setup()
    game_id, token, done = play(client, player, answers=("green", "green", "green"), time_taken=0)
    score = done.json()["game_session"]["total_score"]
    completed_at = db.get(GameSession, game_id).completed_at
    make_game_session(event, make_player(event), total_score=score, completed_at=completed_at - timedelta(seconds=1))  # ahead
    make_game_session(event, make_player(event), total_score=score, completed_at=completed_at)  # same instant, later id
    behind = make_game_session(event, make_player(event), total_score=score, completed_at=completed_at)
    assert behind.id > game_id
    assert result(client, game_id, token).json()["rank"] == 2  # only the one completed earlier is ahead of it


def test_a_completed_game_without_a_completion_time_ranks_after_the_dated_ones(
    client, setup, make_player, make_game_session, db
):
    """Legacy rows: the scoreboard sorts a missing ``completed_at`` last, and so does the rank."""
    event, player = setup()
    game_id, token, done = play(client, player)
    db.execute(update(GameSession).where(GameSession.id == game_id).values(completed_at=None, total_score=77))
    db.commit()
    dated = make_game_session(event, make_player(event), total_score=77, completed_at=utcnow())
    undated_earlier = make_game_session(event, make_player(event), total_score=77)
    db.execute(update(GameSession).where(GameSession.id == undated_earlier.id).values(completed_at=None))
    db.commit()
    assert undated_earlier.id > game_id
    body = result(client, game_id, token).json()
    assert body["game_session"]["completed_at"] is None
    assert body["rank"] == 2  # behind the dated game; ahead of the undated one with a later id
    assert dated.id and body["total_players"] == 3


# ---------------------------------------------------------------------------------------------
# status of the game / of the event
# ---------------------------------------------------------------------------------------------
def test_a_game_still_in_progress_is_a_409_game_not_completed(client, setup, db):
    event, player = setup()
    game_id, token, _ = play(client, player, submit=False)
    response = result(client, game_id, token)
    assert (response.status_code, response.json()) == (409, NOT_COMPLETED)
    assert db.get(GameSession, game_id).status == "in_progress"  # reading never scores anything


def test_an_abandoned_game_is_a_409_game_not_completed(client, setup, db):
    event, player = setup()
    game_id, token, _ = play(client, player, submit=False)
    db.execute(update(GameSession).where(GameSession.id == game_id).values(status="abandoned"))
    db.commit()
    response = result(client, game_id, token)
    assert (response.status_code, response.json()) == (409, NOT_COMPLETED)


def test_unknown_game_unknown_event_and_game_of_another_event_are_404(client, setup, make_event, make_player):
    event, player = setup()
    game_id, token, _ = play(client, player)
    assert result(client, 999_999, token).status_code == 404
    assert result(client, game_id, token, slug="nope").status_code == 404
    other = make_event(slug="elsewhere")
    assert result(client, game_id, token, slug=other.slug).status_code == 404  # right token, wrong event
    assert result(client, game_id, token).status_code == 200


def test_a_wrong_token_does_not_hide_an_unknown_game_or_event(client, setup):
    event, player = setup()
    game_id, _, _ = play(client, player)
    assert result(client, 999_999, "whatever").status_code == 404
    assert result(client, game_id, "whatever", slug="nope").status_code == 404


def test_a_closed_event_still_serves_results_read_only(client, setup, db):
    event, player = setup()
    game_id, token, done = play(client, player)
    event.status = "closed"
    db.commit()
    db.execute(update(GameSession).where(GameSession.id == game_id).values(started_at=utcnow() - timedelta(days=2)))
    db.commit()  # long after the 15 minute submit grace: reading is not submitting
    response = result(client, game_id, token)
    assert response.status_code == 200 and response.json()["game_session"]["total_score"] == done.json()["game_session"]["total_score"]
    # ... while the same closed event is still not playable
    assert client.post("/api/events/quiz/games", json={"player_id": player.id}).status_code == 403
    # and an unfinished game of a closed event is simply "not completed"
    pending = GameSession(event_id=event.id, player_id=player.id, status="in_progress", game_config=None)
    db.add(pending)
    db.commit()
    assert result(client, pending.id).json() == NOT_COMPLETED


def test_a_draft_event_is_a_404_for_the_public_but_visible_to_an_admin_with_the_token(
    client, setup, db, admin_headers
):
    event, player = setup()
    game_id, token, _ = play(client, player)
    event.status = "draft"
    db.commit()
    assert result(client, game_id, token).status_code == 404
    assert result(client, game_id, token, headers=admin_headers).status_code == 200


# ---------------------------------------------------------------------------------------------
# nobody reads another player's result without the token
# ---------------------------------------------------------------------------------------------
def two_finished_games(client, setup, make_player):
    event, alice = setup()
    bob = make_player(event)
    alice_game, alice_token, _ = play(client, alice, answers=("green", "green", "green"))
    bob_game, bob_token, _ = play(client, bob, answers=("red", "red", "red"))
    return alice_game, alice_token, bob_game, bob_token


def test_when_required_nobody_reads_a_result_without_the_right_token(client, setup, make_player, require_token, admin_headers):
    alice_game, alice_token, bob_game, bob_token = two_finished_games(client, setup, make_player)
    attempts = {
        "no token": result(client, alice_game),
        "blank header": result(client, alice_game, headers={"X-Game-Token": "   "}),
        "garbage": result(client, alice_game, "garbage"),
        "one character off": result(client, alice_game, wrong(alice_token)),
        "the other player's token": result(client, alice_game, bob_token),
        "an upper-cased token": result(client, alice_game, alice_token.upper() if alice_token.upper() != alice_token else alice_token + "x"),
        "the token in the URL": result(client, alice_game, params={"submit_token": alice_token}),
        "the token in a cookie": result(client, alice_game, headers={"Cookie": f"X-Game-Token={alice_token}"}),
        "an admin Bearer token alone": result(client, alice_game, headers=admin_headers),
    }
    for label, response in attempts.items():
        assert (response.status_code, response.json()) == (403, NOT_AUTHORISED), label
        assert alice_token not in response.text, label
    # each player reads exactly their own game
    assert result(client, alice_game, alice_token).json()["game_session"]["id"] == alice_game
    assert result(client, bob_game, bob_token).json()["game_session"]["id"] == bob_game
    assert result(client, alice_game, alice_token).json()["review"][0]["player_answer"] == "green"
    assert result(client, bob_game, bob_token).json()["review"][0]["player_answer"] == "red"


def test_a_missing_token_is_accepted_only_while_the_setting_is_off_like_submit(client, setup, make_player, monkeypatch):
    alice_game, alice_token, _, _ = two_finished_games(client, setup, make_player)
    assert settings.REQUIRE_SUBMIT_TOKEN is False
    assert result(client, alice_game).status_code == 200  # stage 1 of the rollout, same as submit
    monkeypatch.setattr(settings, "REQUIRE_SUBMIT_TOKEN", True)
    assert result(client, alice_game).status_code == 403


def test_a_wrong_token_is_always_refused_even_while_the_setting_is_off(client, setup, make_player):
    alice_game, alice_token, _, bob_token = two_finished_games(client, setup, make_player)
    assert settings.REQUIRE_SUBMIT_TOKEN is False
    for token in ("garbage", wrong(alice_token), bob_token):
        response = result(client, alice_game, token)
        assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)


def test_the_token_is_checked_before_the_state_of_the_game_is_revealed(client, setup, db, require_token):
    """No oracle on someone else's game: without the token, in progress and completed look the same."""
    event, player = setup()
    running, running_token, _ = play(client, player, submit=False)
    finished, finished_token, _ = play(client, player)
    for game_id in (running, finished):
        response = result(client, game_id, "wrong")
        assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)
        assert result(client, game_id).status_code == 403
    assert result(client, running, running_token).status_code == 409
    assert result(client, finished, finished_token).status_code == 200


@pytest.mark.parametrize("junk", ["x" * 1000, "é" * 22, "😀", "a b", "<script>"])
def test_hostile_tokens_are_a_403_never_a_500(client, setup, junk):
    event, player = setup()
    game_id, _, _ = play(client, player)
    response = client.get(f"/api/events/quiz/games/{game_id}/result", headers={"X-Game-Token": junk.encode()})
    assert (response.status_code, response.json()) == (403, NOT_AUTHORISED)


def test_the_token_is_compared_in_constant_time(client, setup, monkeypatch):
    calls = []
    real = security.secrets.compare_digest

    def spy(a, b):
        calls.append((type(a), type(b)))
        return real(a, b)

    event, player = setup()
    game_id, token, _ = play(client, player)
    monkeypatch.setattr(security.secrets, "compare_digest", spy)
    result(client, game_id, "wrong-token")
    result(client, game_id, token)
    assert len(calls) == 2 and set(calls) == {(bytes, bytes)}


def test_games_started_before_tokens_existed_can_never_be_proven(client, setup, db, monkeypatch):
    event, player = setup()
    legacy = GameSession(
        event_id=event.id, player_id=player.id, status="completed", completed_at=utcnow(), game_config=None
    )
    db.add(legacy)
    db.commit()
    assert result(client, legacy.id, "anything").status_code == 403  # nothing to compare with: refused, not a 500
    assert result(client, legacy.id).status_code == 200  # setting off: like submit, nothing is asked
    monkeypatch.setattr(settings, "REQUIRE_SUBMIT_TOKEN", True)
    assert result(client, legacy.id).status_code == 403


# ---------------------------------------------------------------------------------------------
# never cached, never a body
# ---------------------------------------------------------------------------------------------
def test_every_answer_is_marked_no_store(client, setup, require_token):
    event, player = setup()
    done_game, token, _ = play(client, player)
    pending_game, pending_token, _ = play(client, player, submit=False)
    responses = [
        result(client, done_game, token),  # 200
        result(client, done_game),  # 403
        result(client, 999_999, token),  # 404
        result(client, pending_game, pending_token),  # 409
    ]
    assert [r.status_code for r in responses] == [200, 403, 404, 409]
    for response in responses:
        assert response.headers["cache-control"] == "no-store"


def test_the_endpoint_is_get_only_and_has_no_request_body(client, setup):
    event, player = setup()
    game_id, token, _ = play(client, player)
    url = f"/api/events/quiz/games/{game_id}/result"
    assert client.post(url, json={"answers": [], "submit_token": token}).status_code == 405
    assert client.put(url, json={}).status_code == 405
    # a body on a GET is ignored: the token must come in the header
    response = client.request("GET", url, content=json.dumps({"submit_token": token}))
    assert response.status_code == 200  # setting off: no token needed, and the body is not read as one
    assert settings.REQUIRE_SUBMIT_TOKEN is False
