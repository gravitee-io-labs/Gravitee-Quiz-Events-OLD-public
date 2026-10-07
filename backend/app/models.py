"""
SQLAlchemy 2.0 models for Gravitee Quiz Events (multi-event, see docs/ARCHITECTURE.md section 3).

Works on PostgreSQL (production) and SQLite (tests, FK pragma ON).

=============================================================================
NAMING CONVENTION  (the Alembic migration agent MUST mirror these names)
=============================================================================
`Base.metadata` carries this convention (see ``NAMING_CONVENTION`` below):

    ix  ix_%(column_0_label)s                  e.g. ix_players_event_id, ix_categories_event_id
    uq  uq_%(table_name)s_%(column_0_N_name)s  e.g. uq_events_slug, uq_categories_event_id_name
    ck  ck_%(table_name)s_%(constraint_name)s  e.g. ck_events_status_valid
    fk  fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s
                                               e.g. fk_categories_event_id_events
    pk  pk_%(table_name)s                      e.g. pk_events

Explicitly named indexes (not generated from the convention):
    ix_game_sessions_event_status_score  (event_id, status, total_score DESC)

Check constraints (explicit short names, final DB name = ck_<table>_<name>):
    events:         status_valid, question_order_valid, collect_phone_valid,
                    default_language_valid, questions_per_game_range, timer_seconds_range,
                    points_correct_nonneg, points_wrong_nonneg, time_bonus_max_nonneg
    questions:      question_format_valid, difficulty_range, correct_answer_valid
    game_sessions:  status_valid

Foreign keys and ON DELETE actions (DB level; relationships use passive_deletes=True):
    categories.event_id    -> events.id        CASCADE
    questions.event_id     -> events.id        CASCADE
    players.event_id       -> events.id        CASCADE
    game_sessions.event_id -> events.id        CASCADE
    questions.category_id  -> categories.id    SET NULL   (deleting a category un-categorises questions)
    game_sessions.player_id-> players.id       CASCADE
    game_answers.game_session_id -> game_sessions.id  CASCADE
    game_answers.question_id     -> questions.id      CASCADE
  Every parent->child path cascades, so deleting an event is one DELETE statement and does not
  depend on trigger ordering between sibling cascades (a real PostgreSQL gotcha with NO ACTION FKs).
  NOTE for legacy databases: the pre-existing FKs questions.category_id, game_sessions.player_id,
  game_answers.game_session_id and game_answers.question_id were created WITHOUT an ON DELETE
  action; the migration must drop/recreate them with the actions above.

Other indexes (all plain ``index=True`` => ix_<table>_<column>):
    legacy (already in old databases): ix_categories_id, ix_users_id, ix_users_username (unique),
        ix_questions_id, ix_players_id, ix_players_email, ix_game_sessions_id, ix_game_answers_id
    new: ix_categories_event_id, ix_questions_event_id, ix_questions_category_id, ix_players_event_id,
        ix_game_sessions_player_id, ix_game_answers_game_session_id, ix_game_answers_question_id
Unique constraints: uq_events_slug (slug), uq_categories_event_id_name (event_id, name).
    The legacy unique constraint on categories.name is replaced by uq_categories_event_id_name.
    events.slug has NO separate index: the unique constraint's index serves lookups.

Nullability: columns that the contract does not touch keep the legacy meaning, but this file declares
them NOT NULL where the code relies on a value (is_active, difficulty, labels, scores, ...). Legacy
databases may keep those columns nullable (drift is tolerated; fresh databases are stricter).
New event_id columns are NOT NULL (after the backfill in 0002_events).

Datetimes are naive UTC (``utcnow()`` helper below), matching the legacy ``timestamp without time zone``
columns; the Pydantic layer re-attaches UTC when serialising (ISO-8601 with trailing "Z").

JSON columns (branding, languages, category_distribution, game_config) are plain ``JSON`` (not JSONB),
wrapped with ``MutableDict`` / ``MutableList`` where in-place mutation is plausible so that
``event.branding["primary_color"] = "#fff"`` is tracked. Prefer assigning a new dict anyway.
The legacy ``GameSettings`` ORM model is intentionally gone: the ``game_settings`` table remains in old
databases, untouched and unused.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.ext.mutable import MutableDict, MutableList
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# ---------------------------------------------------------------------------
# Enumerations / defaults shared with schemas.py (single source of truth)
# ---------------------------------------------------------------------------
LANGUAGES = ("en", "fr")
EVENT_STATUSES = ("draft", "live", "closed")
QUESTION_ORDERS = ("random", "easy_to_hard")
COLLECT_PHONE_MODES = ("hidden", "optional", "required")
QUESTION_FORMATS = ("true_false", "two_choices")
ANSWER_VALUES = ("green", "red")
GAME_STATUSES = ("in_progress", "completed", "abandoned")
BACKGROUND_STYLES = ("aurora", "grid", "plain")
THEMES = ("dark", "light", "system")

DEFAULT_PRIMARY_COLOR = "#FC5607"
DEFAULT_ACCENT_COLOR = "#FF9A52"
DEFAULT_BRANDING: dict[str, Any] = {
    "primary_color": DEFAULT_PRIMARY_COLOR,
    "accent_color": DEFAULT_ACCENT_COLOR,
    "background_style": "aurora",
    "logo_url": None,
    "default_theme": "dark",
    "show_join_qr": True,
}
DEFAULT_SETTINGS: dict[str, Any] = {
    "questions_per_game": 15,
    "timer_seconds": 20,
    "points_correct": 100,
    "points_wrong": 0,
    "time_bonus_max": 50,
    "category_distribution": None,
    "question_order": "random",
    "collect_phone": "optional",
    "consent_text_en": None,
    "consent_text_fr": None,
}


def utcnow() -> datetime:
    """Naive UTC now (the DB stores timestamps without time zone, always UTC)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _default_branding() -> dict[str, Any]:
    return dict(DEFAULT_BRANDING)


def _default_languages() -> list[str]:
    return list(LANGUAGES)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------
class Event(Base):
    """A self-contained quiz instance (branding, rules, categories, questions, players, results)."""

    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("slug"),  # uq_events_slug
        CheckConstraint(_in("status", EVENT_STATUSES), name="status_valid"),
        CheckConstraint(_in("question_order", QUESTION_ORDERS), name="question_order_valid"),
        CheckConstraint(_in("collect_phone", COLLECT_PHONE_MODES), name="collect_phone_valid"),
        CheckConstraint(_in("default_language", LANGUAGES), name="default_language_valid"),
        CheckConstraint(
            "questions_per_game >= 1 AND questions_per_game <= 50", name="questions_per_game_range"
        ),
        CheckConstraint("timer_seconds >= 5 AND timer_seconds <= 120", name="timer_seconds_range"),
        CheckConstraint("points_correct >= 0", name="points_correct_nonneg"),
        CheckConstraint("points_wrong >= 0", name="points_wrong_nonneg"),
        CheckConstraint("time_bonus_max >= 0", name="time_bonus_max_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(48), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    game_title: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="draft")

    hero_title_en: Mapped[str | None] = mapped_column(String(200), nullable=True)
    hero_title_fr: Mapped[str | None] = mapped_column(String(200), nullable=True)
    tagline_en: Mapped[str | None] = mapped_column(String(300), nullable=True)
    tagline_fr: Mapped[str | None] = mapped_column(String(300), nullable=True)
    description_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_fr: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    starts_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    ends_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    languages: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), nullable=False, default=_default_languages
    )
    default_language: Mapped[str] = mapped_column(String(2), nullable=False, default="en")
    branding: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSON), nullable=False, default=_default_branding
    )

    # Game rules (flat columns; exposed as the nested "settings" object by the schemas)
    questions_per_game: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    timer_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    points_correct: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    points_wrong: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    time_bonus_max: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    # {"<category_id>": weight}; null/empty => equal split across categories
    category_distribution: Mapped[dict[str, int] | None] = mapped_column(
        MutableDict.as_mutable(JSON), nullable=True
    )
    question_order: Mapped[str] = mapped_column(String(12), nullable=False, default="random")
    collect_phone: Mapped[str] = mapped_column(String(10), nullable=False, default="optional")
    consent_text_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    consent_text_fr: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )

    categories: Mapped[list[Category]] = relationship(
        back_populates="event", cascade="all, delete-orphan", passive_deletes=True
    )
    questions: Mapped[list[Question]] = relationship(
        back_populates="event", cascade="all, delete-orphan", passive_deletes=True
    )
    players: Mapped[list[Player]] = relationship(
        back_populates="event", cascade="all, delete-orphan", passive_deletes=True
    )
    game_sessions: Mapped[list[GameSession]] = relationship(
        back_populates="event", cascade="all, delete-orphan", passive_deletes=True
    )

    def __repr__(self) -> str:
        return f"<Event id={self.id} slug={self.slug!r} status={self.status!r}>"


# ---------------------------------------------------------------------------
# Categories / questions
# ---------------------------------------------------------------------------
class Category(Base):
    """Question category, scoped to an event. Unique name per event."""

    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("event_id", "name"),)  # uq_categories_event_id_name

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    event_id: Mapped[int] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    name_fr: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_fr: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str] = mapped_column(String(7), nullable=False, default=DEFAULT_PRIMARY_COLOR)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )

    event: Mapped[Event] = relationship(back_populates="categories")
    questions: Mapped[list[Question]] = relationship(
        back_populates="category", passive_deletes=True  # DB does ON DELETE SET NULL
    )


class User(Base):
    """Legacy admin users table (kept for compatibility; admin auth uses env credentials)."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)


class Question(Base):
    """Quiz question: bilingual, two answers (green / red), true/false or two named choices."""

    __tablename__ = "questions"
    __table_args__ = (
        CheckConstraint(_in("question_format", QUESTION_FORMATS), name="question_format_valid"),
        CheckConstraint("difficulty >= 1 AND difficulty <= 5", name="difficulty_range"),
        CheckConstraint(_in("correct_answer", ANSWER_VALUES), name="correct_answer_valid"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    event_id: Mapped[int] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # true_false => green = TRUE / red = FALSE; two_choices => labels name the two options
    question_format: Mapped[str] = mapped_column(String(12), nullable=False, default="true_false")
    question_text_en: Mapped[str] = mapped_column(Text, nullable=False)
    question_text_fr: Mapped[str | None] = mapped_column(Text, nullable=True)  # falls back to EN
    question_type: Mapped[str] = mapped_column(String(50), nullable=False, default="text")
    media_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    correct_answer: Mapped[str] = mapped_column(String(10), nullable=False)  # "green" | "red"
    green_label_en: Mapped[str] = mapped_column(String(100), nullable=False, default="TRUE")
    green_label_fr: Mapped[str] = mapped_column(String(100), nullable=False, default="Vrai")
    red_label_en: Mapped[str] = mapped_column(String(100), nullable=False, default="FALSE")
    red_label_fr: Mapped[str] = mapped_column(String(100), nullable=False, default="Faux")

    explanation_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    explanation_fr: Mapped[str | None] = mapped_column(Text, nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    difficulty: Mapped[int] = mapped_column(Integer, nullable=False, default=1)  # 1 easy, 2 medium, 3 hard
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )

    event: Mapped[Event] = relationship(back_populates="questions")
    category: Mapped[Category | None] = relationship(back_populates="questions")
    game_answers: Mapped[list[GameAnswer]] = relationship(
        back_populates="question", cascade="all, delete-orphan", passive_deletes=True
    )


# ---------------------------------------------------------------------------
# Players / games
# ---------------------------------------------------------------------------
class Player(Base):
    """A player registration (one row per registration, even for a repeated e-mail)."""

    __tablename__ = "players"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    event_id: Mapped[int] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    email: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    consent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    event: Mapped[Event] = relationship(back_populates="players")
    game_sessions: Mapped[list[GameSession]] = relationship(
        back_populates="player", cascade="all, delete-orphan", passive_deletes=True
    )


class GameSession(Base):
    """One game played by a player (questions are fixed at start, scored at submit)."""

    __tablename__ = "game_sessions"
    __table_args__ = (CheckConstraint(_in("status", GAME_STATUSES), name="status_valid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    event_id: Mapped[int] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    player_id: Mapped[int] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="in_progress")
    total_score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    correct_answers: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    wrong_answers: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unanswered: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # snapshot of the rules at start time (timer, points...) so later edits don't change a running game
    game_config: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    event: Mapped[Event] = relationship(back_populates="game_sessions")
    player: Mapped[Player] = relationship(back_populates="game_sessions")
    answers: Mapped[list[GameAnswer]] = relationship(
        back_populates="game_session",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="GameAnswer.question_order",
    )


# (event_id, status, total_score DESC): scoreboard / rank queries
Index(
    "ix_game_sessions_event_status_score",
    GameSession.event_id,
    GameSession.status,
    GameSession.total_score.desc(),
)


class GameAnswer(Base):
    """The answer slot for one question of a game (created at start, filled at submit)."""

    __tablename__ = "game_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    game_session_id: Mapped[int] = mapped_column(
        ForeignKey("game_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question_id: Mapped[int] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    player_answer: Mapped[str | None] = mapped_column(String(10), nullable=True)  # green|red|None
    is_correct: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    time_taken: Mapped[float | None] = mapped_column(Float, nullable=True)  # seconds
    points_earned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    question_order: Mapped[int] = mapped_column(Integer, nullable=False)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    game_session: Mapped[GameSession] = relationship(back_populates="answers")
    question: Mapped[Question] = relationship(back_populates="game_answers")


__all__ = [
    "ANSWER_VALUES",
    "BACKGROUND_STYLES",
    "COLLECT_PHONE_MODES",
    "DEFAULT_ACCENT_COLOR",
    "DEFAULT_BRANDING",
    "DEFAULT_PRIMARY_COLOR",
    "DEFAULT_SETTINGS",
    "EVENT_STATUSES",
    "GAME_STATUSES",
    "LANGUAGES",
    "NAMING_CONVENTION",
    "QUESTION_FORMATS",
    "QUESTION_ORDERS",
    "THEMES",
    "Base",
    "Category",
    "Event",
    "GameAnswer",
    "GameSession",
    "Player",
    "Question",
    "User",
    "utcnow",
]
