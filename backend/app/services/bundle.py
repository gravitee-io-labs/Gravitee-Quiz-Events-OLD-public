"""
Event bundles: export, import and duplicate (docs/ARCHITECTURE.md section 6).

Pure service functions shared by the admin router, ``app.seed`` and the CLI. They take a SQLAlchemy
session and COMMIT on success by default (``commit=False`` only flushes, for callers that want to
own the transaction). On failure the transaction is rolled back and nothing is left half-created.

* ``export_event(db, event) -> dict``           JSON-able ``gravitee-quiz-event`` v1 bundle. Category
  weights are keyed by category NAME (ids are meaningless outside one database).
* ``import_bundle(db, bundle, overrides)``      validates with ``BundleV1`` (dict or model), creates
  event + categories + questions in ONE transaction, remaps the weights to the new category ids.
  ``overrides`` may carry ``slug`` / ``name`` / ``status``. Raises ``SlugConflictError`` when the
  slug is taken, ``pydantic.ValidationError`` for an invalid bundle, ``ValueError`` for a bad override.
* ``duplicate_event(db, event, opts)``          a new ``draft`` event from an existing one. Never
  copies players, games or results. ``copy_questions`` copies categories AND questions (a question
  pool is meaningless without its categories); without it the copy starts with an empty pool and no
  category weights. Dates and location are never copied (they belong to the original occurrence).
"""
import logging
from collections.abc import Mapping
from typing import Any, Optional, Union

from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import DEFAULT_BRANDING, DEFAULT_SETTINGS, Category, Event, Question
from app.schemas import (
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    BundleV1,
    EventDuplicate,
    EventName,
    EventStatus,
    validate_slug,
)

logger = logging.getLogger(__name__)

_EVENT_TEXT_FIELDS = (
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
)
_SETTINGS_FIELDS = (
    "questions_per_game",
    "timer_seconds",
    "points_correct",
    "points_wrong",
    "time_bonus_max",
    "question_order",
    "collect_phone",
    "consent_text_en",
    "consent_text_fr",
)
_CATEGORY_FIELDS = ("name", "name_fr", "description", "description_fr", "color", "is_active")
_QUESTION_COPY_FIELDS = (
    "question_format",
    "difficulty",
    "question_text_en",
    "question_text_fr",
    "question_type",
    "media_url",
    "correct_answer",
    "green_label_en",
    "green_label_fr",
    "red_label_en",
    "red_label_fr",
    "explanation_en",
    "explanation_fr",
    "is_active",
)
_OVERRIDE_KEYS = frozenset({"slug", "name", "status"})
_EVENT_NAME = TypeAdapter(EventName)
_EVENT_STATUS = TypeAdapter(EventStatus)


class SlugConflictError(Exception):
    """An event with this slug already exists."""

    def __init__(self, slug: str):
        super().__init__(f"An event with the slug '{slug}' already exists")
        self.slug = slug


# ---------------------------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------------------------
def slug_taken(db: Session, slug: str, exclude_id: Optional[int] = None) -> bool:
    stmt = select(Event.id).where(Event.slug == slug)
    if exclude_id is not None:
        stmt = stmt.where(Event.id != exclude_id)
    return db.execute(stmt.limit(1)).first() is not None


def ensure_slug_available(db: Session, slug: str, exclude_id: Optional[int] = None) -> None:
    if slug_taken(db, slug, exclude_id):
        raise SlugConflictError(slug)


def _upper_color(value: Any) -> Any:
    return value.upper() if isinstance(value, str) else value


def lost_slug_race(db: Session, slug: str, exc: IntegrityError) -> bool:
    """Is this ``IntegrityError`` the unique index on ``events.slug`` (another request took the slug between
    our pre-check and our INSERT / UPDATE)?

    ``ensure_slug_available`` can never close that race, only the unique index can: callers catch the
    ``IntegrityError``, ROLL BACK, then ask this (it queries, so the session must be usable again) and turn a
    ``True`` into the very same 409 as the pre-check. Recognised by the constraint name / column in the driver
    message (``uq_events_slug`` on PostgreSQL, ``events.slug`` on SQLite), with the slug now being taken as the
    fallback for any other driver wording. Anything else is a genuine integrity bug: ``False``, re-raise it.
    """
    detail = str(getattr(exc, "orig", exc))
    return "uq_events_slug" in detail or "events.slug" in detail or slug_taken(db, slug)


def _finish(db: Session, event: Event, commit: bool) -> Event:
    """Flush/commit and turn a lost slug race (unique violation) into ``SlugConflictError``."""
    slug = event.slug  # read now: after a rollback the instance is no longer usable
    try:
        db.flush()
        if commit:
            db.commit()
    except IntegrityError as exc:
        db.rollback()
        if lost_slug_race(db, slug, exc):
            raise SlugConflictError(slug) from None
        raise
    except Exception:
        db.rollback()
        raise
    return event


def _remap_distribution(distribution: Optional[Mapping[str, int]], id_map: Mapping[int, int]) -> Optional[dict]:
    """``{old category id: weight}`` -> ``{new category id: weight}``; unknown ids are dropped."""
    result: dict[str, int] = {}
    for key, weight in (distribution or {}).items():
        try:
            new_id = id_map.get(int(key))
        except (TypeError, ValueError):
            continue
        if new_id is not None:
            result[str(new_id)] = weight
    return result or None


# ---------------------------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------------------------
def export_event(db: Session, event: Event) -> dict[str, Any]:
    """The event as a ``gravitee-quiz-event`` v1 bundle (plain JSON-able dict).

    Built straight from the database (not through ``BundleV1``) so that exporting never fails on odd
    legacy data; importing it again is what validates it.
    """
    categories = list(db.scalars(select(Category).where(Category.event_id == event.id).order_by(Category.id)))
    questions = list(db.scalars(select(Question).where(Question.event_id == event.id).order_by(Question.id)))
    category_names = {c.id: c.name for c in categories}

    distribution: Optional[dict[str, int]] = None
    if event.category_distribution:
        named: dict[str, int] = {}
        for key, weight in event.category_distribution.items():
            try:
                name = category_names.get(int(key))
            except (TypeError, ValueError):
                name = None
            if name is not None:
                named[name] = weight
        distribution = named or None

    branding = {**DEFAULT_BRANDING, **(event.branding or {})}
    branding["primary_color"] = _upper_color(branding["primary_color"])
    branding["accent_color"] = _upper_color(branding["accent_color"])

    event_data: dict[str, Any] = {field: getattr(event, field) for field in _EVENT_TEXT_FIELDS}
    event_data["starts_on"] = event.starts_on.isoformat() if event.starts_on else None
    event_data["ends_on"] = event.ends_on.isoformat() if event.ends_on else None
    event_data["languages"] = list(event.languages or [])
    event_data["default_language"] = event.default_language
    event_data["branding"] = {key: branding.get(key) for key in DEFAULT_BRANDING}
    settings = {field: getattr(event, field) for field in _SETTINGS_FIELDS[:5]}
    settings["category_distribution"] = distribution
    settings.update({field: getattr(event, field) for field in _SETTINGS_FIELDS[5:]})
    event_data["settings"] = settings

    exported_questions = []
    for q in questions:
        item: dict[str, Any] = {
            "category": category_names.get(q.category_id) if q.category_id is not None else None,
            "question_format": q.question_format,
            "difficulty": q.difficulty or 1,
            "question_text_en": q.question_text_en,
            "question_text_fr": q.question_text_fr,
        }
        if q.question_type and q.question_type != "text":
            item["question_type"] = q.question_type
        if q.media_url:
            item["media_url"] = q.media_url
        item.update(
            {
                "correct_answer": q.correct_answer,
                "green_label_en": q.green_label_en,
                "green_label_fr": q.green_label_fr,
                "red_label_en": q.red_label_en,
                "red_label_fr": q.red_label_fr,
                "explanation_en": q.explanation_en,
                "explanation_fr": q.explanation_fr,
                "is_active": q.is_active is not False,
            }
        )
        exported_questions.append(item)

    return {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "event": event_data,
        "categories": [
            {
                "name": c.name,
                "name_fr": c.name_fr,
                "description": c.description,
                "description_fr": c.description_fr,
                "color": _upper_color(c.color),
                "is_active": c.is_active is not False,
            }
            for c in categories
        ],
        "questions": exported_questions,
    }


# ---------------------------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------------------------
def import_bundle(
    db: Session,
    bundle: Union[BundleV1, Mapping[str, Any]],
    overrides: Optional[Mapping[str, Any]] = None,
    *,
    commit: bool = True,
) -> Event:
    """Create an event (+ its categories and questions) from a bundle, atomically."""
    parsed = bundle if isinstance(bundle, BundleV1) else BundleV1.model_validate(bundle)

    overrides = {k: v for k, v in (overrides or {}).items() if v is not None}
    unknown = set(overrides) - _OVERRIDE_KEYS
    if unknown:
        raise ValueError(f"unsupported override(s): {', '.join(sorted(unknown))}")

    data = parsed.event.model_dump()
    settings = data.pop("settings")
    named_distribution = settings.pop("category_distribution")
    branding = data.pop("branding")
    if "slug" in overrides:
        data["slug"] = validate_slug(overrides["slug"])
    if "name" in overrides:
        data["name"] = _EVENT_NAME.validate_python(overrides["name"])
    if "status" in overrides:
        data["status"] = _EVENT_STATUS.validate_python(overrides["status"])

    slug = data["slug"]
    ensure_slug_available(db, slug)
    event = Event(**data, branding=branding, category_distribution=None, **settings)
    db.add(event)
    try:
        db.flush()  # event.id (a lost slug race surfaces HERE: the INSERT waits for the winner, then fails)
        by_name: dict[str, Category] = {}
        for item in parsed.categories:
            category = Category(event_id=event.id, **item.model_dump())
            db.add(category)
            by_name[item.name] = category
        db.flush()  # category ids

        if named_distribution:
            event.category_distribution = {str(by_name[name].id): weight for name, weight in named_distribution.items()}

        db.add_all(
            Question(
                event_id=event.id,
                category_id=by_name[q.category].id if q.category is not None else None,
                **q.model_dump(exclude={"category"}),
            )
            for q in parsed.questions
        )
    except IntegrityError as exc:
        db.rollback()
        if lost_slug_race(db, slug, exc):
            raise SlugConflictError(slug) from None
        raise
    except Exception:
        db.rollback()
        raise
    _finish(db, event, commit)
    logger.info(
        "Imported event '%s' (%d categories, %d questions)", event.slug, len(parsed.categories), len(parsed.questions)
    )
    return event


# ---------------------------------------------------------------------------------------------
# Duplicate
# ---------------------------------------------------------------------------------------------
def duplicate_event(
    db: Session,
    event: Event,
    opts: Union[EventDuplicate, Mapping[str, Any]],
    *,
    commit: bool = True,
) -> Event:
    """A new ``draft`` event copied from ``event`` (see the module docstring for what is copied)."""
    opts = opts if isinstance(opts, EventDuplicate) else EventDuplicate.model_validate(opts)
    ensure_slug_available(db, opts.slug)

    values: dict[str, Any] = {
        "slug": opts.slug,
        "name": opts.name,
        "game_title": opts.game_title or event.game_title,
        "status": "draft",
    }
    if opts.copy_branding:
        for field in ("hero_title_en", "hero_title_fr", "tagline_en", "tagline_fr", "description_en", "description_fr"):
            values[field] = getattr(event, field)
        values["languages"] = list(event.languages)
        values["default_language"] = event.default_language
        values["branding"] = {**DEFAULT_BRANDING, **(event.branding or {})}
    # else: the Event column defaults apply (both languages, default branding)

    if opts.copy_settings:
        for field in _SETTINGS_FIELDS:
            values[field] = getattr(event, field)
    else:
        for field in _SETTINGS_FIELDS:
            values[field] = DEFAULT_SETTINGS[field]

    copy = Event(**values)
    db.add(copy)
    try:
        db.flush()  # a lost slug race surfaces here (see import_bundle)
        if opts.copy_questions:
            id_map: dict[int, int] = {}
            for source in db.scalars(select(Category).where(Category.event_id == event.id).order_by(Category.id)):
                target = Category(event_id=copy.id, **{f: getattr(source, f) for f in _CATEGORY_FIELDS})
                db.add(target)
                id_map[source.id] = target
            db.flush()
            id_map = {old: new.id for old, new in id_map.items()}

            if opts.copy_settings:
                copy.category_distribution = _remap_distribution(event.category_distribution, id_map)

            db.add_all(
                Question(
                    event_id=copy.id,
                    category_id=id_map.get(source.category_id) if source.category_id is not None else None,
                    **{f: getattr(source, f) for f in _QUESTION_COPY_FIELDS},
                )
                for source in db.scalars(select(Question).where(Question.event_id == event.id).order_by(Question.id))
            )
    except IntegrityError as exc:
        db.rollback()
        if lost_slug_race(db, opts.slug, exc):
            raise SlugConflictError(opts.slug) from None
        raise
    except Exception:
        db.rollback()
        raise
    _finish(db, copy, commit)
    logger.info("Duplicated event '%s' -> '%s'", event.slug, copy.slug)
    return copy
