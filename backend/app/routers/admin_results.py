"""
Admin - results (docs/ARCHITECTURE.md section 5.3). Mounted under ``/api/admin``.

    GET    /events/{id}/results?skip&limit&search&order[&status]   paginated -> {items, total}
    GET    /events/{id}/results.csv                                leads export (BOM, injection-safe)
    GET    /results/{sid}                                          detail with the answers
    DELETE /results/{sid}[?purge_player=true]                      one game (+ its player when it was their last)
    DELETE /events/{id}/results?confirm={slug}[&include_players=true]   purge every game of the event
    PATCH  /results/{sid}/score    {total_score}

GDPR: a result carries the player's registration (name, e-mail, phone), so deleting the LAST game of a
player deletes the player row too, and ``purge_player=true`` erases the player with all their games at once.
The event purge removes every game session (answers cascade); registered players are only removed when
``include_players=true`` (registrations that never finished a game are personal data as well).

Every mutation tells the scoreboard broadcaster, so open big screens refresh immediately.
``status`` defaults to ``completed`` (an in-progress game has no score yet); use ``all`` to see them all.
The leads CSV ranks completed games by score (ties: earliest completion first).
"""
import logging
from typing import Literal, Optional

from fastapi import Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.orm import Session, contains_eager, joinedload, selectinload

from app.auth import admin_router
from app.database import get_db
from app.models import GameAnswer, GameSession, Player
from app.schemas import (
    ResultAnswerDetail,
    ResultDetail,
    ResultOrder,
    ResultPage,
    ResultsPurged,
    ResultSummary,
    ScoreUpdate,
    ScoreUpdateResult,
)
from app.services import broadcaster
from app.services.csv_io import leads_to_csv
from app.services.events import get_event_by_id_or_404
from app.services.search import LIKE_ESCAPE, like_pattern, search_term

logger = logging.getLogger(__name__)

router = admin_router()

RESULT_NOT_FOUND = "Game session not found"
MAX_PAGE_SIZE = 500


def _get_session_or_404(db: Session, session_id: int) -> GameSession:
    session = db.get(GameSession, session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=RESULT_NOT_FOUND)
    return session


@router.get("/events/{event_id}/results", response_model=ResultPage, summary="List results (games)")
def list_results(
    event_id: int,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
    search: Optional[str] = Query(None, max_length=200, description="Player name or e-mail"),
    order: ResultOrder = Query("recent"),
    game_status: Literal["completed", "in_progress", "abandoned", "all"] = Query("completed", alias="status"),
    db: Session = Depends(get_db),
):
    get_event_by_id_or_404(db, event_id)

    conditions = [GameSession.event_id == event_id]
    if game_status != "all":
        conditions.append(GameSession.status == game_status)
    term = search_term(search)
    if term:
        pattern = like_pattern(term)
        conditions.append(
            or_(
                Player.first_name.ilike(pattern, escape=LIKE_ESCAPE),
                Player.last_name.ilike(pattern, escape=LIKE_ESCAPE),
                Player.email.ilike(pattern, escape=LIKE_ESCAPE),
                (Player.first_name + " " + Player.last_name).ilike(pattern, escape=LIKE_ESCAPE),
            )
        )

    total = db.scalar(select(func.count(GameSession.id)).join(Player, GameSession.player_id == Player.id).where(*conditions)) or 0

    if order == "score":
        ordering = (GameSession.total_score.desc(), GameSession.completed_at.asc().nulls_last(), GameSession.id.asc())
    else:
        ordering = (func.coalesce(GameSession.completed_at, GameSession.started_at).desc(), GameSession.id.desc())
    rows = db.scalars(
        select(GameSession)
        .join(Player, GameSession.player_id == Player.id)
        .options(contains_eager(GameSession.player))
        .where(*conditions)
        .order_by(*ordering)
        .offset(skip)
        .limit(limit)
    ).all()
    return ResultPage(items=[ResultSummary.model_validate(r) for r in rows], total=total)


@router.get("/events/{event_id}/results.csv", summary="Leads export (CSV, UTF-8 BOM)")
def export_leads(event_id: int, db: Session = Depends(get_db)):
    event = get_event_by_id_or_404(db, event_id)
    sessions = db.scalars(
        select(GameSession)
        .join(Player, GameSession.player_id == Player.id)
        .options(contains_eager(GameSession.player))
        .where(GameSession.event_id == event.id, GameSession.status == "completed")
        .order_by(GameSession.total_score.desc(), GameSession.completed_at.asc().nulls_last(), GameSession.id.asc())
    ).all()
    rows = (
        [
            rank,
            s.player.first_name,
            s.player.last_name,
            s.player.email,
            s.player.phone_number,
            s.player.consent_at.isoformat(timespec="seconds") + "Z" if s.player.consent_at else "",
            s.total_score,
            s.correct_answers,
            s.wrong_answers,
            s.completed_at.isoformat(timespec="seconds") + "Z" if s.completed_at else "",
        ]
        for rank, s in enumerate(sessions, start=1)
    )
    return Response(
        content=leads_to_csv(rows),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{event.slug}-leads.csv"'},
    )


@router.get("/results/{session_id}", response_model=ResultDetail, summary="Result detail with answers")
def get_result(session_id: int, db: Session = Depends(get_db)):
    session = db.scalars(
        select(GameSession)
        .options(
            joinedload(GameSession.player),
            selectinload(GameSession.answers).joinedload(GameAnswer.question),
        )
        .where(GameSession.id == session_id)
    ).first()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=RESULT_NOT_FOUND)

    answers = [
        ResultAnswerDetail(
            question_id=a.question_id,
            question_text_en=a.question.question_text_en,
            question_text_fr=a.question.question_text_fr,
            green_label_en=a.question.green_label_en,
            red_label_en=a.question.red_label_en,
            correct_answer=a.question.correct_answer,
            player_answer=a.player_answer,
            is_correct=a.is_correct,
            time_taken=a.time_taken,
            points_earned=a.points_earned,
            question_order=a.question_order,
        )
        for a in session.answers
    ]
    return ResultDetail(**ResultSummary.model_validate(session).model_dump(), answers=answers)


@router.delete(
    "/results/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a result (and its player when it was their last game)",
)
def delete_result(
    session_id: int,
    purge_player: bool = Query(
        False,
        description="Also delete the player (name, e-mail, phone) and, by cascade, ALL of their games: "
        "the way to honour an erasure request. Without it only this game is removed, plus the player "
        "when this was their last game (the registered personal data goes with the result).",
    ),
    db: Session = Depends(get_db),
):
    session = _get_session_or_404(db, session_id)
    event_id, player_id = session.event_id, session.player_id
    if purge_player:
        db.execute(delete(Player).where(Player.id == player_id))  # games and answers cascade
        logger.info("Player %s erased with game %s of event %s", player_id, session_id, event_id)
    else:
        db.delete(session)  # answers cascade
        db.flush()
        # One guarded statement (not "count, then delete"): a game started for this player in between keeps
        # the player, instead of being swept away by the cascade.
        orphan = db.execute(
            delete(Player)
            .where(Player.id == player_id, ~exists().where(GameSession.player_id == player_id))
            .execution_options(synchronize_session=False)
        )
        if orphan.rowcount:
            logger.info("Player %s erased with their last game %s of event %s", player_id, session_id, event_id)
    db.commit()
    broadcaster.notify_event_changed(event_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/events/{event_id}/results",
    response_model=ResultsPurged,
    summary="Purge every game of an event (optionally its players too)",
    responses={400: {"description": "`confirm` is missing or is not the event slug"}},
)
def purge_results(
    event_id: int,
    confirm: Optional[str] = Query(None, description="Must equal the event slug"),
    include_players: bool = Query(
        False,
        description="Also delete every registered player of the event (name, e-mail, phone), including those "
        "who never finished a game. Without it the registrations stay and only the games are removed.",
    ),
    db: Session = Depends(get_db),
):
    """Reset the scoreboard of an event (e.g. after the dry run) or erase its personal data after the event.

    Every game session goes (in progress, completed and abandoned; answers cascade). Irreversible.
    """
    event = get_event_by_id_or_404(db, event_id)
    if confirm != event.slug:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Purging results requires ?confirm=<the event slug>",
        )
    deleted_results = db.execute(
        delete(GameSession).where(GameSession.event_id == event.id).execution_options(synchronize_session=False)
    ).rowcount  # the database cascades to the answers
    deleted_players = 0
    if include_players:
        deleted_players = db.execute(
            delete(Player).where(Player.event_id == event.id).execution_options(synchronize_session=False)
        ).rowcount
    db.commit()
    logger.info(
        "Event %s (%s): purged %s game(s) and %s player(s)", event.id, event.slug, deleted_results, deleted_players
    )
    broadcaster.notify_event_changed(event.id)
    return ResultsPurged(deleted_results=deleted_results or 0, deleted_players=deleted_players or 0)


@router.patch("/results/{session_id}/score", response_model=ScoreUpdateResult, summary="Correct a total score")
def update_score(session_id: int, payload: ScoreUpdate, db: Session = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    session.total_score = payload.total_score
    db.commit()
    broadcaster.notify_event_changed(session.event_id)
    return ScoreUpdateResult(id=session.id, total_score=session.total_score)
