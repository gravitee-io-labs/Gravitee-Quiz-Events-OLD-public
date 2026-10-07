"""
Shared event helpers used by the public and admin routers.

* lookups + visibility rules (draft -> 404 for the public, closed -> 403 ``event_closed`` on play)
* serializers ``event_to_summary`` / ``event_to_public`` / ``event_to_admin`` (counts, stats and
  categories come from aggregate queries: no N+1; ``events_to_admin`` is the batch variant)
* ``display_name`` ("First L.") for anything public
* ``build_event`` / ``apply_event_update``: ``EventCreate`` / ``EventUpdate`` -> ORM (partial
  update semantics, ``branding`` merged key by key)

Functions raise ``HTTPException`` for HTTP-level problems and ``ValueError`` for invalid merged
data (map it to a 422/400 in the router).
"""
import logging
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    DEFAULT_BRANDING,
    Category,
    Event,
    GameSession,
    Player,
    Question,
)
from app.schemas import (
    Branding,
    CategoryPublic,
    EventAdmin,
    EventCounts,
    EventCreate,
    EventPublic,
    EventPublicStats,
    EventSettings,
    EventSettingsPublic,
    EventSummary,
    EventUpdate,
    validate_language_combo,
)

logger = logging.getLogger(__name__)

EVENT_CLOSED = "event_closed"
EVENT_NOT_FOUND = "Event not found"
MAX_DISPLAY_FIRST_NAME = 30
# Players already in a game when an admin closes the event may still submit it for this long (counted from
# the start of THEIR game). Registration and new games stay refused at once.
CLOSED_EVENT_SUBMIT_GRACE = timedelta(minutes=15)
# A game still "in_progress" this long after it started was walked away from: the stats report it as abandoned
# (computed in the query, there is no background job; the row itself is left untouched).
ABANDONED_AFTER = timedelta(hours=3)


# ---------------------------------------------------------------------------------------------
# Lookups and visibility
# ---------------------------------------------------------------------------------------------
def get_event_by_slug(db: Session, slug: str) -> Optional[Event]:
    if "\x00" in slug:  # PostgreSQL text cannot hold NUL: no such event, and no 500 either
        return None
    return db.execute(select(Event).where(Event.slug == slug)).scalar_one_or_none()


def get_event_by_id(db: Session, event_id: int) -> Optional[Event]:
    return db.get(Event, event_id)


def get_event_or_404(db: Session, slug: str, is_admin: bool = False) -> Event:
    """Event by slug. A ``draft`` event is a 404 unless ``is_admin`` (admin preview)."""
    event = get_event_by_slug(db, slug)
    if event is None or (event.status == "draft" and not is_admin):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=EVENT_NOT_FOUND)
    return event


def get_event_by_id_or_404(db: Session, event_id: int) -> Event:
    """Admin lookup by numeric id (any status)."""
    event = get_event_by_id(db, event_id)
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=EVENT_NOT_FOUND)
    return event


def assert_event_playable(event: Event, is_admin: bool = False) -> None:
    """Gate for register / start-game / submit.

    ``draft``  -> 404 unless admin (preview);  ``closed`` -> 403 ``event_closed`` (even for admins);
    ``live``   -> ok.
    """
    if event.status == "draft" and not is_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=EVENT_NOT_FOUND)
    if event.status == "closed":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EVENT_CLOSED)


def may_submit_after_close(status: str, started_at: datetime, now: datetime) -> bool:
    """Submitting a game of a ``closed`` event: only a game still ``in_progress`` that started less than
    ``CLOSED_EVENT_SUBMIT_GRACE`` ago (so closing the event never robs a player of the game in front of them)."""
    return status == "in_progress" and now - started_at < CLOSED_EVENT_SUBMIT_GRACE


def list_live_events(db: Session) -> list[Event]:
    """Events listed on the hub: ``live`` only, soonest first (undated last), then oldest id first."""
    stmt = (
        select(Event)
        .where(Event.status == "live")
        .order_by(Event.starts_on.asc().nulls_last(), Event.id.asc())
    )
    return list(db.execute(stmt).scalars())


# ---------------------------------------------------------------------------------------------
# Privacy helper
# ---------------------------------------------------------------------------------------------
def display_name(first_name: Optional[str], last_name: Optional[str]) -> str:
    """Public player name: ``"First L."`` (never the full last name, never an e-mail).

    >>> display_name("Ada", "Lovelace")
    'Ada L.'
    """
    first = (first_name or "").strip()
    last = (last_name or "").strip()
    if "@" in first or "@" in last:  # legacy rows may hold an e-mail in a name field
        return "Player"
    first = first[:MAX_DISPLAY_FIRST_NAME].strip()
    initial = f"{last[0].upper()}." if last else ""
    return " ".join(part for part in (first, initial) if part) or "Player"


# ---------------------------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------------------------
def safe_branding(raw: object, slug: str = "?") -> Branding:
    """Branding for output: a stored key that no longer validates (hand edited row, rule tightened since
    it was written) falls back to its default instead of turning the hub and every page of the event
    into a 500."""
    merged = {**DEFAULT_BRANDING, **(raw if isinstance(raw, dict) else {})}
    try:
        return Branding.model_validate(merged)
    except ValidationError as exc:
        invalid = {str(err["loc"][0]) for err in exc.errors() if err["loc"]}
        logger.warning("Event %s: invalid branding key(s) %s replaced by defaults", slug, sorted(invalid))
        for key in invalid:
            merged[key] = DEFAULT_BRANDING.get(key)
        return Branding.model_validate(merged)


def _summary(event: Event) -> EventSummary:
    data = {name: getattr(event, name) for name in EventSummary.model_fields if name != "branding"}
    return EventSummary.model_validate({**data, "branding": safe_branding(event.branding, event.slug)})


def event_to_summary(event: Event) -> EventSummary:
    return _summary(event)


def drawable_question_condition():
    """SQL condition: the question can be drawn into a game.

    ``is_active`` AND (no category OR an active category). THE single definition of "playable": game
    selection (``routers.games.eligible_questions``), the counts of the admin and public views and the
    stats all use it. The query must outer join ``Category`` on ``Question.category_id``.
    """
    return and_(Question.is_active.is_(True), or_(Question.category_id.is_(None), Category.is_active.is_(True)))


def public_categories(db: Session, event_id: int) -> list[CategoryPublic]:
    """Active categories with >= 1 drawable question, with that question count (one query)."""
    count = func.count(Question.id)
    stmt = (
        select(Category, count)
        .join(Question, Question.category_id == Category.id)
        .where(
            Category.event_id == event_id,
            Category.is_active.is_(True),
            Question.event_id == event_id,
            drawable_question_condition(),
        )
        .group_by(Category.id)
        .having(count > 0)
        .order_by(Category.id)
    )
    result = []
    for category, question_count in db.execute(stmt).all():
        item = CategoryPublic.model_validate(category)
        item.question_count = question_count
        result.append(item)
    return result


def public_stats(db: Session, event_id: int) -> EventPublicStats:
    players = select(func.count(Player.id)).where(Player.event_id == event_id).scalar_subquery()
    games = (
        select(func.count(GameSession.id))
        .where(GameSession.event_id == event_id, GameSession.status == "completed")
        .scalar_subquery()
    )
    row = db.execute(select(players, games)).one()
    return EventPublicStats(players=row[0] or 0, games_completed=row[1] or 0)


def event_to_public(db: Session, event: Event) -> EventPublic:
    summary = _summary(event)
    return EventPublic(
        **summary.model_dump(),
        hero_title_en=event.hero_title_en,
        hero_title_fr=event.hero_title_fr,
        settings=EventSettingsPublic.model_validate(event, from_attributes=True),
        categories=public_categories(db, event.id),
        stats=public_stats(db, event.id),
    )


def event_counts(db: Session, event_ids: Sequence[int]) -> dict[int, EventCounts]:
    """Counts for many events with four grouped queries (no per-event query)."""
    ids = list(event_ids)
    counts = {event_id: EventCounts() for event_id in ids}
    if not ids:
        return counts

    # ``active_questions`` = questions a game can actually draw (an active question of a deactivated
    # category is never served, so it is not counted)
    drawable = func.sum(case((drawable_question_condition(), 1), else_=0))
    for event_id, total, active_total in db.execute(
        select(Question.event_id, func.count(Question.id), drawable)
        .outerjoin(Category, Category.id == Question.category_id)
        .where(Question.event_id.in_(ids))
        .group_by(Question.event_id)
    ):
        counts[event_id].questions = total
        counts[event_id].active_questions = int(active_total or 0)

    for event_id, total in db.execute(
        select(Category.event_id, func.count(Category.id))
        .where(Category.event_id.in_(ids))
        .group_by(Category.event_id)
    ):
        counts[event_id].categories = total

    for event_id, total in db.execute(
        select(Player.event_id, func.count(Player.id))
        .where(Player.event_id.in_(ids))
        .group_by(Player.event_id)
    ):
        counts[event_id].players = total

    for event_id, total in db.execute(
        select(GameSession.event_id, func.count(GameSession.id))
        .where(GameSession.event_id.in_(ids), GameSession.status == "completed")
        .group_by(GameSession.event_id)
    ):
        counts[event_id].games_completed = total
    return counts


def event_settings(event: Event) -> EventSettings:
    return EventSettings.model_validate(event, from_attributes=True)


def _admin(event: Event, counts: EventCounts) -> EventAdmin:
    summary = _summary(event)
    return EventAdmin(
        **summary.model_dump(),
        id=event.id,
        hero_title_en=event.hero_title_en,
        hero_title_fr=event.hero_title_fr,
        settings=event_settings(event),
        counts=counts,
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def event_to_admin(db: Session, event: Event, counts: Optional[EventCounts] = None) -> EventAdmin:
    if counts is None:
        counts = event_counts(db, [event.id])[event.id]
    return _admin(event, counts)


def events_to_admin(db: Session, events: Sequence[Event]) -> list[EventAdmin]:
    all_counts = event_counts(db, [e.id for e in events])
    return [_admin(e, all_counts[e.id]) for e in events]


# ---------------------------------------------------------------------------------------------
# Create / partial update
# ---------------------------------------------------------------------------------------------
_META_FIELDS = (
    "slug",
    "name",
    "game_title",
    "status",
    "hero_title_en",
    "hero_title_fr",
    "tagline_en",
    "tagline_fr",
    "description_en",
    "description_fr",
    "location",
    "starts_on",
    "ends_on",
    "languages",
    "default_language",
)


def build_event(payload: EventCreate) -> Event:
    """New (unsaved) ``Event`` from an ``EventCreate`` (settings flattened, branding as dict)."""
    values = {field: getattr(payload, field) for field in _META_FIELDS}
    values["languages"] = list(payload.languages)
    values["branding"] = payload.branding.model_dump()
    values.update(payload.settings.model_dump())
    return Event(**values)


def merge_branding(current: Optional[dict], patch: dict) -> dict:
    """Key-by-key merge on top of the defaults, validated (raises ``ValueError``)."""
    merged = {**DEFAULT_BRANDING, **(current or {}), **patch}
    return Branding.model_validate(merged).model_dump()


def apply_event_update(event: Event, payload: EventUpdate) -> None:
    """Apply a partial update in place. Does NOT commit; does NOT check slug uniqueness.

    * only fields present in the request are touched (``exclude_unset``)
    * ``branding`` merges key by key; ``settings`` fields are written to the flat columns
    * cross-field rules are checked on the MERGED state: ``default_language in languages``,
      ``ends_on >= starts_on`` (``ValueError`` on violation, nothing modified before the check)
    """
    data = payload.model_dump(exclude_unset=True)
    branding_patch = data.pop("branding", None)
    settings_patch = data.pop("settings", None) or {}

    languages = data.get("languages", event.languages)
    default_language = data.get("default_language", event.default_language)
    validate_language_combo(list(languages), default_language)
    starts_on = data["starts_on"] if "starts_on" in data else event.starts_on
    ends_on = data["ends_on"] if "ends_on" in data else event.ends_on
    if starts_on and ends_on and ends_on < starts_on:
        raise ValueError("ends_on must not be before starts_on")

    new_branding = merge_branding(event.branding, branding_patch) if branding_patch else None

    for field, value in data.items():
        setattr(event, field, list(value) if field == "languages" else value)
    for field, value in settings_patch.items():
        setattr(event, field, value)
    if new_branding is not None:
        event.branding = new_branding
