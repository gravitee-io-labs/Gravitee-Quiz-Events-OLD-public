"""
Game routes (docs/ARCHITECTURE.md sections 4 and 5.1), mounted under ``/api/events``:

    POST /api/events/{slug}/games                     start a game -> questions WITHOUT answers
    POST /api/events/{slug}/games/{game_id}/submit    score it server side -> result + review
    GET  /api/events/{slug}/games/{game_id}/result    the same result + review again, once the game is completed

All handlers are plain ``def`` (run in the threadpool). Status gating comes from
``assert_event_playable``: draft -> 404 (admins may preview), closed -> 403 ``event_closed``. A closed event
refuses registrations and new games at once, but a game that was already in progress may still be submitted
for ``CLOSED_EVENT_SUBMIT_GRACE`` (15 minutes from ITS start): an admin closing the event must not rob the
players in front of a question of their game.

Integrity: ``POST .../games`` returns a random ``submit_token`` (only its SHA-256 is stored, in
``game_sessions.game_config``); ``POST .../submit`` takes it as the JSON field ``submit_token`` or the
``X-Game-Token`` header. A wrong token is always refused; a missing one only when ``REQUIRE_SUBMIT_TOKEN``.
``GET .../result`` is guarded by the very same check (header only: a GET has no body). It exists for the
player whose submit response was lost on the way back (the server scored the game, the client never saw
it, and its retry gets 409): the client reads the result it is owed instead of a dead end. It is read-only,
so it keeps working after the event is closed.

Each handler does ALL its database work in one body and closes the session before returning (see the
connection discipline note in ``routers/public_events.py``: an open session across response
serialisation can deadlock the threadpool against the connection pool under load).
"""
import logging
import random
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session, contains_eager, joinedload

from app.auth import optional_admin
from app.config import settings
from app.database import get_db
from app.models import Category, GameAnswer, GameSession, Player, Question, utcnow
from app.schemas import (
    CategoryRef,
    GameComplete,
    GameSessionResponse,
    GameStarted,
    GameStartRequest,
    GameSubmitRequest,
    QuestionForGame,
    ReviewItem,
    TokenData,
)
from app.security import new_submit_token, submit_token_matches
from app.services.broadcaster import notify_event_changed
from app.services.events import (
    EVENT_CLOSED,
    assert_event_playable,
    drawable_question_condition,
    get_event_or_404,
    may_submit_after_close,
)
from app.services.scoring import AnswerScore, ScoringRules, score_answer, summarize
from app.services.selection import NotEnoughQuestions, select_questions

logger = logging.getLogger(__name__)

router = APIRouter()

NOT_ENOUGH_QUESTIONS = "not_enough_questions"
PLAYER_NOT_FOUND = "Player not found"
GAME_NOT_FOUND = "Game not found"
GAME_ALREADY_COMPLETED = "game_already_completed"
GAME_NOT_IN_PROGRESS = "game_not_in_progress"
GAME_NOT_COMPLETED = "game_not_completed"
INVALID_GAME_TOKEN = "invalid_game_token"
SUBMIT_TOKEN_HASH_KEY = "submit_token_hash"  # key of the SHA-256 in GameSession.game_config


def _make_rng() -> random.Random:
    """One fresh RNG per game start (seeded from the OS); tests monkeypatch this for determinism."""
    return random.Random()


def eligible_questions(db: Session, event_id: int) -> list[Question]:
    """Active questions of the event whose category (if any) is active too, categories loaded."""
    stmt = (
        select(Question)
        .outerjoin(Category, Category.id == Question.category_id)
        .options(contains_eager(Question.category))
        .where(
            Question.event_id == event_id,
            drawable_question_condition(),
        )
        .order_by(Question.id)
    )
    return list(db.execute(stmt).scalars().unique())


# ---------------------------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------------------------
@router.post(
    "/{slug}/games",
    response_model=GameStarted,
    summary="Start a game",
    responses={
        400: {"description": "`not_enough_questions`"},
        403: {"description": "`event_closed`"},
        404: {"description": "Unknown event / draft event / player of another event"},
    },
)
def start_game(
    slug: str,
    payload: GameStartRequest,
    db: Session = Depends(get_db),
    admin: Optional[TokenData] = Depends(optional_admin),
):
    """Pick the questions (weights, redistribution, order: see ``services/selection``), create the
    session with its answer slots and return the questions WITHOUT answers or explanations."""
    try:
        return _start_game(db, slug, payload, is_admin=admin is not None)
    finally:
        db.close()


def _start_game(db: Session, slug: str, payload: GameStartRequest, is_admin: bool) -> GameStarted:
    event = get_event_or_404(db, slug, is_admin=is_admin)
    assert_event_playable(event, is_admin=is_admin)

    player = db.get(Player, payload.player_id)
    if player is None or player.event_id != event.id:  # same 404: never reveal other events' players
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=PLAYER_NOT_FOUND)

    pool = eligible_questions(db, event.id)
    try:
        selected = select_questions(
            pool,
            event.questions_per_game,
            distribution=event.category_distribution,
            order=event.question_order,
            rng=_make_rng(),
        )
    except NotEnoughQuestions:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_ENOUGH_QUESTIONS) from None

    rules = ScoringRules.from_event(event)
    submit_token, submit_token_hash = new_submit_token()
    game = GameSession(
        event_id=event.id,
        player_id=player.id,
        status="in_progress",
        # snapshot of the rules: editing the event later never changes a running game; the submit token is
        # stored hashed only (a database dump or an admin screen never reveals a usable token)
        game_config={
            "questions_per_game": event.questions_per_game,
            **rules.to_config(),
            SUBMIT_TOKEN_HASH_KEY: submit_token_hash,
        },
        answers=[
            GameAnswer(question_id=question.id, question_order=position)
            for position, question in enumerate(selected, start=1)
        ],
    )
    db.add(game)
    db.flush()
    questions = [QuestionForGame.model_validate(question) for question in selected]
    response = GameStarted(
        game_session_id=game.id,
        timer_seconds=rules.timer_seconds,
        points_correct=rules.points_correct,
        time_bonus_max=rules.time_bonus_max,
        questions=questions,
        submit_token=submit_token,
    )
    db.commit()
    logger.info("Game %s started for player %s (event %s)", game.id, player.id, event.slug)
    return response


# ---------------------------------------------------------------------------------------------
# Submit
# ---------------------------------------------------------------------------------------------
def _rank_and_total(db: Session, event_id: int, game: GameSession, score: int, completed_at) -> tuple[int, int]:
    """Position of ``game`` on the event scoreboard (score desc, completed_at asc, id asc) and the
    number of completed games of the event. Shared by ``submit`` and ``result``: same ranking, same numbers."""
    completed = and_(GameSession.event_id == event_id, GameSession.status == "completed")
    if completed_at is None:  # legacy row: the scoreboard sorts a missing completion time LAST
        same_score_ahead = or_(
            GameSession.completed_at.is_not(None),
            and_(GameSession.completed_at.is_(None), GameSession.id < game.id),
        )
    else:
        same_score_ahead = or_(
            GameSession.completed_at < completed_at,
            and_(GameSession.completed_at == completed_at, GameSession.id < game.id),
        )
    ahead = or_(GameSession.total_score > score, and_(GameSession.total_score == score, same_score_ahead))
    better = select(func.count(GameSession.id)).where(completed, ahead).scalar_subquery()
    total = select(func.count(GameSession.id)).where(completed).scalar_subquery()
    better_count, total_count = db.execute(select(better, total)).one()
    return int(better_count or 0) + 1, int(total_count or 0)


def _answer_slots(db: Session, game_id: int) -> list[GameAnswer]:
    """The answer slots of a game in question order, questions and categories loaded."""
    return list(
        db.execute(
            select(GameAnswer)
            .options(joinedload(GameAnswer.question).joinedload(Question.category))
            .where(GameAnswer.game_session_id == game_id)
            .order_by(GameAnswer.question_order)
        )
        .scalars()
        .unique()
    )


def _review_item(slot: GameAnswer) -> ReviewItem:
    """One line of the review (correct answer and explanation included: the game is over)."""
    return ReviewItem(
        question_id=slot.question_id,
        question_format=slot.question.question_format,
        question_text_en=slot.question.question_text_en,
        question_text_fr=slot.question.question_text_fr,
        correct_answer=slot.question.correct_answer,
        player_answer=slot.player_answer,
        is_correct=slot.is_correct,
        explanation_en=slot.question.explanation_en,
        explanation_fr=slot.question.explanation_fr,
        time_taken=slot.time_taken,
        points_earned=slot.points_earned,
        green_label_en=slot.question.green_label_en,
        green_label_fr=slot.question.green_label_fr,
        red_label_en=slot.question.red_label_en,
        red_label_fr=slot.question.red_label_fr,
        category=CategoryRef.model_validate(slot.question.category) if slot.question.category else None,
    )


@router.post(
    "/{slug}/games/{game_id}/submit",
    response_model=GameComplete,
    summary="Submit the answers of a game",
    responses={
        403: {
            "description": "`invalid_game_token` (wrong token, or missing while REQUIRE_SUBMIT_TOKEN is on) or "
            "`event_closed` (closed event: only a game started less than 15 minutes ago can still be submitted)"
        },
        404: {"description": "Unknown event / game (or a game of another event)"},
        409: {"description": "`game_already_completed`"},
    },
)
def submit_game(
    slug: str,
    game_id: int,
    payload: GameSubmitRequest,
    db: Session = Depends(get_db),
    admin: Optional[TokenData] = Depends(optional_admin),
    x_game_token: Optional[str] = Header(None, description="Same as the `submit_token` body field"),
):
    """Score the game on the server.

    * The ``submit_token`` of ``POST .../games`` (body field, or ``X-Game-Token`` header) proves the caller
      is the player who started the game (see the module docstring for the staged rollout).

    * ``time_taken`` is clamped to ``[0, timer]`` (omitted => no time bonus); unknown question ids are
      ignored; questions missing from the submission (or answered ``null``) are unanswered.
    * The session row is locked (``SELECT ... FOR UPDATE`` on PostgreSQL) and finally completed with a
      guarded ``UPDATE ... WHERE status = 'in_progress'``: a double submit gets 409, never a second score.
    """
    try:
        result, event_id = _complete_game(
            db, slug, game_id, payload, is_admin=admin is not None, header_token=x_game_token
        )
    finally:
        db.close()
    notify_event_changed(event_id)  # after the commit, and after the connection went back to the pool
    return result


def _verify_submit_token(game: GameSession, body_token: Optional[str], header_token: Optional[str]) -> None:
    """403 ``invalid_game_token`` unless the presented token(s) match the stored hash.

    * nothing presented: refused only when ``REQUIRE_SUBMIT_TOKEN`` (stage 2 of the rollout);
    * something presented (body and/or header): EVERY presented value must match, always, even while the
      setting is off (a wrong token is an attack or a bug, never "no token").
    A blank value counts as not presented.
    """
    presented = [token for token in (body_token, header_token) if token]
    if not presented:
        if settings.REQUIRE_SUBMIT_TOKEN:
            logger.warning("Game %s: submit refused, no token (REQUIRE_SUBMIT_TOKEN is on)", game.id)
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=INVALID_GAME_TOKEN)
        return
    config = game.game_config if isinstance(game.game_config, dict) else {}
    stored_hash = config.get(SUBMIT_TOKEN_HASH_KEY)  # absent on games started before tokens existed
    matches = [submit_token_matches(token, stored_hash) for token in presented]  # no short-circuit
    if not all(matches):
        logger.warning("Game %s: submit refused, wrong token", game.id)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=INVALID_GAME_TOKEN)


def _complete_game(
    db: Session,
    slug: str,
    game_id: int,
    payload: GameSubmitRequest,
    is_admin: bool,
    header_token: Optional[str] = None,
) -> tuple[GameComplete, int]:
    event = get_event_or_404(db, slug, is_admin=is_admin)
    closed = event.status == "closed"
    if not closed:
        assert_event_playable(event, is_admin=is_admin)  # draft -> 404 for the public

    game = db.execute(
        select(GameSession)
        .where(GameSession.id == game_id, GameSession.event_id == event.id)
        .with_for_update()  # ignored by SQLite
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if game is None:
        # a closed event stays final: whatever is asked of it, the answer is event_closed
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN if closed else status.HTTP_404_NOT_FOUND,
            detail=EVENT_CLOSED if closed else GAME_NOT_FOUND,
        )
    _verify_submit_token(game, payload.submit_token, header_token)
    if closed and not may_submit_after_close(game.status, game.started_at, utcnow()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EVENT_CLOSED)
    if game.status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=GAME_ALREADY_COMPLETED if game.status == "completed" else GAME_NOT_IN_PROGRESS,
        )

    rules = ScoringRules.from_config(game.game_config, ScoringRules.from_event(event))
    submitted = {answer.question_id: answer for answer in payload.answers}

    slots = _answer_slots(db, game.id)

    now = utcnow()
    scores: list[AnswerScore] = []
    for slot in slots:
        answer = submitted.get(slot.question_id)
        if answer is None:  # not submitted: unanswered
            score = AnswerScore("unanswered", None, 0, None)
        else:
            reported = answer.time_taken if "time_taken" in answer.model_fields_set else None
            score = score_answer(rules, slot.question.correct_answer, answer.player_answer, reported)
        slot.player_answer = answer.player_answer if answer is not None else None
        slot.is_correct = score.is_correct
        slot.time_taken = score.time_taken
        slot.points_earned = score.points
        slot.answered_at = now if answer is not None and answer.player_answer is not None else None
        scores.append(score)
    totals = summarize(scores)

    claimed = db.execute(
        update(GameSession)
        .where(GameSession.id == game.id, GameSession.status == "in_progress")
        .values(
            status="completed",
            completed_at=now,
            total_score=totals.total_score,
            correct_answers=totals.correct,
            wrong_answers=totals.wrong,
            unanswered=totals.unanswered,
        )
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:  # lost a race (databases without row locks): nothing was scored
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=GAME_ALREADY_COMPLETED)

    review = [_review_item(slot) for slot in slots]
    session_result = GameSessionResponse(
        id=game.id,
        player_id=game.player_id,
        status="completed",
        total_score=totals.total_score,
        correct_answers=totals.correct,
        wrong_answers=totals.wrong,
        unanswered=totals.unanswered,
        started_at=game.started_at,
        completed_at=now,
    )
    db.commit()

    rank, total_players = _rank_and_total(db, event.id, game, totals.total_score, now)
    logger.info(
        "Game %s completed: score=%s correct=%s wrong=%s unanswered=%s rank=%s/%s",
        game.id, totals.total_score, totals.correct, totals.wrong, totals.unanswered, rank, total_players,
    )
    result = GameComplete(game_session=session_result, rank=rank, total_players=total_players, review=review)
    return result, event.id


# ---------------------------------------------------------------------------------------------
# Result (read a completed game again)
# ---------------------------------------------------------------------------------------------
@router.get(
    "/{slug}/games/{game_id}/result",
    response_model=GameComplete,
    summary="Read the result of a completed game again",
    responses={
        403: {
            "description": "`invalid_game_token` (wrong token, or missing while REQUIRE_SUBMIT_TOKEN is on)"
        },
        404: {"description": "Unknown event / game (or a game of another event)"},
        409: {"description": "`game_not_completed` (still in progress, or abandoned)"},
    },
)
def game_result(
    slug: str,
    game_id: int,
    response: Response,
    db: Session = Depends(get_db),
    admin: Optional[TokenData] = Depends(optional_admin),
    x_game_token: Optional[str] = Header(None, description="The `submit_token` of `POST .../games`"),
):
    """The ``GameComplete`` payload ``submit`` returned, for a game that is ALREADY completed.

    For the player whose submit response never arrived (network lost AFTER the server scored the game: the
    retry then gets 409 ``game_already_completed``). Protected by the game's token exactly like ``submit`` (same
    constant-time check, same ``REQUIRE_SUBMIT_TOKEN`` rule, a wrong token is always a 403) but through the
    ``X-Game-Token`` header only, a GET having no body. Rank and ``total_players`` are those of ``submit``
    (``_rank_and_total``), computed now, so they reflect the scoreboard as it is at this moment.

    Read-only, so it works for a ``closed`` event too (``draft``: 404 unless admin preview). The token is
    checked before the state of the game is revealed. The answer is never cacheable.
    """
    try:
        result = _read_result(db, slug, game_id, is_admin=admin is not None, header_token=x_game_token)
    except HTTPException as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=exc.detail, headers={**(exc.headers or {}), "Cache-Control": "no-store"}
        ) from None
    finally:
        db.close()
    response.headers["Cache-Control"] = "no-store"  # a result carries a player's answers: never from a shared cache
    return result


def _read_result(
    db: Session, slug: str, game_id: int, is_admin: bool, header_token: Optional[str]
) -> GameComplete:
    event = get_event_or_404(db, slug, is_admin=is_admin)  # draft -> 404 (admin preview aside); closed is fine
    game = db.execute(
        select(GameSession).where(GameSession.id == game_id, GameSession.event_id == event.id)
    ).scalar_one_or_none()
    if game is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=GAME_NOT_FOUND)
    _verify_submit_token(game, None, header_token)
    if game.status != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=GAME_NOT_COMPLETED)

    review = [_review_item(slot) for slot in _answer_slots(db, game.id)]
    rank, total_players = _rank_and_total(db, event.id, game, game.total_score, game.completed_at)
    return GameComplete(
        game_session=GameSessionResponse.model_validate(game),
        rank=rank,
        total_players=total_players,
        review=review,
    )
