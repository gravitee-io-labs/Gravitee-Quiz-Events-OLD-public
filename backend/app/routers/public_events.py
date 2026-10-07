"""
Public event routes (docs/ARCHITECTURE.md section 5.1), mounted under ``/api/events``:

    GET  /api/events                  live events (hub cards)
    GET  /api/events/{slug}           one event with rules, categories and stats (draft: admin only)
    POST /api/events/{slug}/players   register a player

All handlers are plain ``def`` (run in the threadpool).

Connection discipline (important under load): every handler does ALL its database work in its own body,
builds plain Pydantic response objects and closes the session (``finally: db.close()``) BEFORE returning.
Otherwise the pooled connection stays checked out while FastAPI waits for a free threadpool slot to
serialise the response, and with more concurrent requests than pool connections the threadpool and the
pool deadlock each other (every thread waits for a connection, every connection waits for a thread) until
``pool_timeout`` expires with 500s. For the same reason these routes do not use DB-touching
dependencies such as ``get_public_event``: a dependency returns to the event loop with its session open.
"""
import logging
import re
import unicodedata
from typing import Optional

from fastapi import APIRouter, Depends, status
from fastapi.exceptions import RequestValidationError
from sqlalchemy.orm import Session

from app.auth import optional_admin
from app.database import get_db
from app.models import Player, utcnow
from app.schemas import (
    EventPublic,
    EventSummary,
    PlayerCreate,
    PlayerResponse,
    TokenData,
)
from app.services.events import (
    assert_event_playable,
    event_to_public,
    event_to_summary,
    get_event_or_404,
    list_live_events,
)

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_EMAIL_LENGTH = 254  # RFC 5321 (the column is 255)
MIN_PHONE_DIGITS = 6
MAX_PHONE_DIGITS = 15  # E.164
_PHONE_ALLOWED_RE = re.compile(r"^\+?[\d\s().\-/]+$")
_FORBIDDEN_NAME_CATEGORIES = {"Cc", "Cs", "Co", "Cn"}  # control, surrogate, private use, unassigned
# Invisible "format" (Cf) characters that let a name look like something else on the big screen and in the CSV
# export: bidi controls (LRE/RLE/PDF/LRO/RLO U+202A-202E, LRI/RLI/FSI/PDI U+2066-2069, the Arabic letter mark
# U+061C) and the zero-width family (U+200B-U+200F, which includes ZWNJ/ZWJ and LRM/RLM; the word joiner and the
# invisible operators U+2060-2064; the BOM / ZWNBSP U+FEFF). A name that needs one of them is refused, not rewritten.
_INVISIBLE_NAME_CHARS_RE = re.compile("[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")


def _invalid(field: str, message: str) -> RequestValidationError:
    """A 422 shaped exactly like FastAPI's own validation errors (``detail`` = list of errors)."""
    return RequestValidationError([{"type": "value_error", "loc": ("body", field), "msg": message}])


def clean_name(value: str, field: str) -> str:
    """Collapse whitespace, reject control / invisible bidi and zero-width characters and names without any letter."""
    cleaned = " ".join(value.split())
    if any(unicodedata.category(ch) in _FORBIDDEN_NAME_CATEGORIES for ch in cleaned):
        raise _invalid(field, "Name contains invalid characters")
    if _INVISIBLE_NAME_CHARS_RE.search(cleaned):
        raise _invalid(field, "Name contains invalid characters")
    if "<" in cleaned or ">" in cleaned:  # names are shown on the big screen: no markup, whatever the UI escapes
        raise _invalid(field, "Name contains invalid characters")
    if not any(ch.isalpha() for ch in cleaned):
        raise _invalid(field, "Name must contain at least one letter")
    return cleaned


def clean_phone(value: str) -> str:
    """Lenient phone check: digits with common separators, 6 to 15 digits, optional leading ``+``."""
    cleaned = " ".join(value.split())
    digits = sum(ch.isdecimal() for ch in cleaned)
    if not _PHONE_ALLOWED_RE.match(cleaned) or not MIN_PHONE_DIGITS <= digits <= MAX_PHONE_DIGITS:
        raise _invalid("phone_number", "Phone number is not valid")
    return cleaned


@router.get(
    "",
    response_model=list[EventSummary],
    summary="List the live events",
    description="Hub listing: `live` events only, soonest `starts_on` first (undated last).",
)
def list_events(db: Session = Depends(get_db)):
    try:
        return [event_to_summary(event) for event in list_live_events(db)]
    finally:
        db.close()


@router.get(
    "/{slug}",
    response_model=EventPublic,
    summary="Get one event",
    responses={404: {"description": "Unknown event, or a draft event without an admin token"}},
)
def get_event(
    slug: str,
    db: Session = Depends(get_db),
    admin: Optional[TokenData] = Depends(optional_admin),
):
    try:
        event = get_event_or_404(db, slug, is_admin=admin is not None)
        return event_to_public(db, event)
    finally:
        db.close()


@router.post(
    "/{slug}/players",
    response_model=PlayerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a player",
    responses={
        403: {"description": "`event_closed`"},
        404: {"description": "Unknown event, or a draft event without an admin token"},
        422: {"description": "Validation error (phone required, consent required, bad name...)"},
    },
)
def register_player(
    slug: str,
    payload: PlayerCreate,
    db: Session = Depends(get_db),
    admin: Optional[TokenData] = Depends(optional_admin),
):
    """Every registration creates a NEW player row (same e-mail twice = two players)."""
    try:
        return _register(db, slug, payload, is_admin=admin is not None)
    finally:
        db.close()


def _register(db: Session, slug: str, payload: PlayerCreate, is_admin: bool) -> PlayerResponse:
    event = get_event_or_404(db, slug, is_admin=is_admin)
    assert_event_playable(event, is_admin=is_admin)

    first_name = clean_name(payload.first_name, "first_name")
    last_name = clean_name(payload.last_name, "last_name")
    email = str(payload.email).strip().lower()
    if len(email) > MAX_EMAIL_LENGTH:
        raise _invalid("email", "Email is too long")

    phone: Optional[str] = None
    if event.collect_phone != "hidden" and payload.phone_number:
        phone = clean_phone(payload.phone_number)
    if event.collect_phone == "required" and phone is None:
        raise _invalid("phone_number", "Phone number is required")

    consent_at = None
    if event.consent_text_en or event.consent_text_fr:
        if payload.consent is not True:
            raise _invalid("consent", "Consent is required")
        consent_at = utcnow()

    player = Player(
        event_id=event.id,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone_number=phone,
        consent_at=consent_at,
    )
    db.add(player)
    db.flush()  # id and created_at are known now
    response = PlayerResponse.model_validate(player)
    db.commit()
    logger.info("Player %s registered for event %s", player.id, event.slug)
    return response
