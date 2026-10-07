"""
Admin - events (docs/ARCHITECTURE.md section 5.3). Mounted under ``/api/admin``.

    GET    /events                      list + counts
    POST   /events                      create (draft by default)
    POST   /events/import               import a bundle (409 on slug conflict)
    GET    /events/{id}                 one event
    PUT    /events/{id}                 partial update (branding / settings merged key by key)
    DELETE /events/{id}?confirm={slug}  cascade delete
    POST   /events/{id}/duplicate       copy branding / rules / categories / questions
    GET    /events/{id}/export          JSON bundle (attachment)
    GET    /events/{id}/stats           aggregated numbers + hardest / easiest questions
                                        (games_in_progress: started < 3 h ago; games_abandoned: the rest)
"""
import json
import logging
from typing import Optional

from fastapi import Depends, HTTPException, Query, Response, status
from sqlalchemy import Float, and_, case, cast, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import admin_router
from app.database import get_db
from app.models import Category, Event, GameAnswer, GameSession, Player, Question, utcnow
from app.schemas import (
    EventAdmin,
    EventCreate,
    EventDuplicate,
    EventImportRequest,
    EventStats,
    EventUpdate,
    QuestionStat,
)
from app.services import broadcaster
from app.services.bundle import (
    SlugConflictError,
    duplicate_event,
    ensure_slug_available,
    export_event,
    import_bundle,
    lost_slug_race,
)
from app.services.events import (
    ABANDONED_AFTER,
    apply_event_update,
    build_event,
    drawable_question_condition,
    event_to_admin,
    events_to_admin,
    get_event_by_id_or_404,
)

logger = logging.getLogger(__name__)

router = admin_router()

MIN_ANSWERS_FOR_RANKING = 3
STATS_TOP_N = 5


def _slug_conflict(exc: SlugConflictError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


def _check_distribution(db: Session, event_id: Optional[int], distribution: Optional[dict[str, int]]) -> None:
    """Weights must reference categories of THIS event (422 otherwise)."""
    if not distribution:
        return
    known: set[str] = set()
    if event_id is not None:
        known = {str(i) for i in db.scalars(select(Category.id).where(Category.event_id == event_id))}
    unknown = sorted(set(distribution) - known, key=lambda k: int(k))
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"category_distribution references unknown categories of this event: {', '.join(unknown)}",
        )


# ---------------------------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------------------------
@router.get("/events", response_model=list[EventAdmin], summary="List events with counts")
def list_events(db: Session = Depends(get_db)):
    events = list(db.scalars(select(Event).order_by(Event.id.desc())))
    return events_to_admin(db, events)


@router.post("/events", response_model=EventAdmin, status_code=status.HTTP_201_CREATED, summary="Create an event")
def create_event(payload: EventCreate, db: Session = Depends(get_db)):
    try:
        ensure_slug_available(db, payload.slug)
    except SlugConflictError as exc:
        raise _slug_conflict(exc) from None
    # a brand-new event has no categories yet, so there is nothing a weight could point to
    _check_distribution(db, None, payload.settings.category_distribution)

    event = build_event(payload)
    db.add(event)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if lost_slug_race(db, payload.slug, exc):  # another request took the slug since the pre-check
            raise _slug_conflict(SlugConflictError(payload.slug)) from None
        raise
    db.refresh(event)
    return event_to_admin(db, event)


@router.post(
    "/events/import",
    response_model=EventAdmin,
    status_code=status.HTTP_201_CREATED,
    summary="Create an event from a bundle (JSON export)",
)
def import_event(payload: EventImportRequest, db: Session = Depends(get_db)):
    try:
        event = import_bundle(
            db,
            payload.bundle,
            {"slug": payload.slug, "name": payload.name, "status": payload.status},
        )
    except SlugConflictError as exc:
        raise _slug_conflict(exc) from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return event_to_admin(db, event)


@router.get("/events/{event_id}", response_model=EventAdmin, summary="Get an event")
def get_event(event_id: int, db: Session = Depends(get_db)):
    return event_to_admin(db, get_event_by_id_or_404(db, event_id))


@router.put("/events/{event_id}", response_model=EventAdmin, summary="Partially update an event")
def update_event(event_id: int, payload: EventUpdate, db: Session = Depends(get_db)):
    event = get_event_by_id_or_404(db, event_id)
    new_slug = payload.slug if payload.slug is not None and payload.slug != event.slug else None

    if new_slug is not None:
        try:
            ensure_slug_available(db, new_slug, exclude_id=event.id)
        except SlugConflictError as exc:
            raise _slug_conflict(exc) from None
    if payload.settings is not None and "category_distribution" in payload.settings.model_fields_set:
        _check_distribution(db, event.id, payload.settings.category_distribution)

    try:
        apply_event_update(event, payload)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if new_slug is not None and lost_slug_race(db, new_slug, exc):
            raise _slug_conflict(SlugConflictError(new_slug)) from None
        raise
    db.refresh(event)
    return event_to_admin(db, event)


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete an event (cascade)")
def delete_event(
    event_id: int,
    confirm: Optional[str] = Query(None, description="Must equal the event slug"),
    db: Session = Depends(get_db),
):
    event = get_event_by_id_or_404(db, event_id)
    if confirm != event.slug:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Deleting an event requires ?confirm=<the event slug>",
        )
    slug = event.slug
    # one DELETE: the database cascades to categories, questions, players, games and answers
    db.execute(delete(Event).where(Event.id == event_id))
    db.commit()
    logger.info("Deleted event %s (%s)", event_id, slug)
    broadcaster.notify_event_changed(event_id)  # a deleted event's scoreboard empties at once
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------------------------
# Duplicate / export / stats
# ---------------------------------------------------------------------------------------------
@router.post(
    "/events/{event_id}/duplicate",
    response_model=EventAdmin,
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate an event (always created as draft; never copies players or results)",
)
def duplicate(event_id: int, payload: EventDuplicate, db: Session = Depends(get_db)):
    event = get_event_by_id_or_404(db, event_id)
    try:
        copy = duplicate_event(db, event, payload)
    except SlugConflictError as exc:
        raise _slug_conflict(exc) from None
    return event_to_admin(db, copy)


@router.get("/events/{event_id}/export", summary="Download the event as a JSON bundle")
def export(event_id: int, db: Session = Depends(get_db)):
    event = get_event_by_id_or_404(db, event_id)
    body = json.dumps(export_event(db, event), ensure_ascii=False, indent=2) + "\n"
    return Response(
        content=body.encode("utf-8"),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{event.slug}.json"'},
    )


def _ranked_questions(db: Session, event_id: int, ascending: bool) -> list[QuestionStat]:
    """Questions with at least ``MIN_ANSWERS_FOR_RANKING`` real answers in completed games, ranked
    by correct rate (``ascending`` = hardest first) then by number of answers."""
    answered = func.count(GameAnswer.id)
    rate = func.avg(case((GameAnswer.is_correct.is_(True), 1.0), else_=0.0))
    stmt = (
        select(Question.id, Question.question_text_en, cast(rate, Float), answered)
        .join(GameAnswer, GameAnswer.question_id == Question.id)
        .join(GameSession, GameSession.id == GameAnswer.game_session_id)
        .where(
            Question.event_id == event_id,
            GameSession.status == "completed",
            GameAnswer.player_answer.is_not(None),
        )
        .group_by(Question.id, Question.question_text_en)
        .having(answered >= MIN_ANSWERS_FOR_RANKING)
        .order_by(rate.asc() if ascending else rate.desc(), answered.desc(), Question.id.asc())
        .limit(STATS_TOP_N)
    )
    return [
        QuestionStat(id=qid, question_text_en=text, correct_rate=round(float(r), 4), answered=int(n))
        for qid, text, r, n in db.execute(stmt)
    ]


@router.get("/events/{event_id}/stats", response_model=EventStats, summary="Event statistics")
def event_stats(event_id: int, db: Session = Depends(get_db)):
    event = get_event_by_id_or_404(db, event_id)

    completed = GameSession.status == "completed"
    # A game that is still "in_progress" 3 hours after it started is abandoned (a player closed the tab):
    # decided here, per request, so the numbers are right without any maintenance job.
    stale_before = utcnow() - ABANDONED_AFTER
    running = and_(GameSession.status == "in_progress", GameSession.started_at > stale_before)
    abandoned = or_(
        GameSession.status == "abandoned",
        and_(GameSession.status == "in_progress", GameSession.started_at <= stale_before),
    )
    games = db.execute(
        select(
            func.sum(case((completed, 1), else_=0)),
            func.sum(case((running, 1), else_=0)),
            func.avg(case((completed, GameSession.total_score))),
            func.max(case((completed, GameSession.total_score))),
            func.avg(case((completed, GameSession.correct_answers))),
            func.sum(case((abandoned, 1), else_=0)),
        ).where(GameSession.event_id == event.id)
    ).one()
    players = db.scalar(select(func.count(Player.id)).where(Player.event_id == event.id)) or 0
    active_questions = (
        db.scalar(
            select(func.count(Question.id))
            .outerjoin(Category, Category.id == Question.category_id)
            .where(Question.event_id == event.id, drawable_question_condition())
        )
        or 0
    )
    return EventStats(
        players=players,
        games_completed=int(games[0] or 0),
        games_in_progress=int(games[1] or 0),
        games_abandoned=int(games[5] or 0),
        avg_score=round(float(games[2] or 0), 2),
        top_score=int(games[3] or 0),
        avg_correct=round(float(games[4] or 0), 2),
        questions_active=active_questions,
        hardest_questions=_ranked_questions(db, event.id, ascending=True),
        easiest_questions=_ranked_questions(db, event.id, ascending=False),
    )
