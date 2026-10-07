"""
Scoreboard routes (docs/ARCHITECTURE.md section 5.1), mounted under ``/api/events``:

    GET /api/events/{slug}/scoreboard?limit=10          top games (names "First L.", no e-mail / phone)
    GET /api/events/{slug}/scoreboard/stream?limit=10   Server-Sent Events, live

Draft events are 404 unless the request carries an admin token; ``closed`` events keep serving their
final results. The stream never holds a database session: the event is resolved with a short-lived one
and the data comes from ``services.broadcaster.hub`` (one refresh task per event, shared by all viewers).
The REST handler closes its session before returning (see the note in ``routers/public_events.py``).
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import database
from app.auth import optional_admin
from app.database import get_db
from app.schemas import ScoreboardEntry, TokenData
from app.services import broadcaster
from app.services.events import get_event_or_404

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_LIMIT = broadcaster.MAX_ENTRIES
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@router.get(
    "/{slug}/scoreboard",
    response_model=list[ScoreboardEntry],
    summary="Scoreboard (top games)",
    responses={404: {"description": "Unknown event, or a draft event without an admin token"}},
)
def get_scoreboard(
    slug: str,
    limit: int = Query(10, ge=1, le=MAX_LIMIT, description="Number of rows (1-100)"),
    db: Session = Depends(get_db),
    admin: Optional[TokenData] = Depends(optional_admin),
):
    try:
        event = get_event_or_404(db, slug, is_admin=admin is not None)
        return broadcaster.fetch_entries(db, event.id, limit)
    finally:
        db.close()


def _resolve_event_id(slug: str, is_admin: bool) -> int:
    """Event lookup with a short-lived session (closed before the stream starts)."""
    with database.SessionLocal() as db:
        return get_event_or_404(db, slug, is_admin=is_admin).id


@router.get(
    "/{slug}/scoreboard/stream",
    summary="Scoreboard live stream (SSE)",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": (
                'Each message is `data: {"entries":[ScoreboardEntry...],"total_players":N,"total_games":M}`, '
                "sent on connect and whenever the visible content changes; `: keepalive` comments every 15 s."
            ),
            "content": {"text/event-stream": {}},
        },
        404: {"description": "Unknown event, or a draft event without an admin token"},
    },
)
async def scoreboard_stream(
    slug: str,
    request: Request,
    limit: int = Query(10, ge=1, le=MAX_LIMIT, description="Number of rows (1-100)"),
    admin: Optional[TokenData] = Depends(optional_admin),
):
    event_id = await run_in_threadpool(_resolve_event_id, slug, admin is not None)
    return StreamingResponse(
        broadcaster.hub.stream(event_id, limit, request.is_disconnected),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
