"""events: multi-event data model (docs/ARCHITECTURE.md section 3)

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-06

What this does to a LEGACY production database (non-destructive, one transaction, all-or-nothing):

1. creates ``events``;
2. if the legacy tables hold any data, inserts ONE event ``api-masters`` ("API Masters", live, en+fr,
   Gravitee orange branding) whose game rules are copied from the legacy ``game_settings`` row
   (defaults when there is none; out-of-range values are clamped so the new CHECKs hold);
   on a brand new empty database NO event is created (the application seeds events/api-masters.json);
3. adds the new columns (``event_id`` x4, ``categories.name_fr/description_fr``, ``questions.question_format``,
   ``players.consent_at``) and BACKFILLS every category / question / player / game session with that event;
4. makes ``questions.question_text_fr`` nullable; sets ``question_format`` (``true_false`` when the English
   labels are TRUE/FALSE, otherwise ``two_choices``);
5. then applies NOT NULL, foreign keys (ON DELETE CASCADE / SET NULL), indexes, the CHECK constraints (skipped,
   with a warning, if hand-edited legacy rows violate one) and
   the unique ``(event_id, name)`` on categories (replacing the legacy auto-named unique on ``name``,
   whose real name is discovered by introspection), all with the names the ORM naming convention yields
   (app.models.NAMING_CONVENTION) so that ``alembic revision --autogenerate`` sees no drift.

It also converges the legacy "everything is nullable" columns with the ORM (NULLs are replaced by the old
ORM defaults first) and renames the primary keys ``<table>_pkey`` -> ``pk_<table>``.

Deliberate, minimal content changes (everything else is preserved byte for byte):
* NULL values of columns that become NOT NULL get the old ORM default (``is_active`` true, ``difficulty`` 1,
  labels Green/Vert/Red/Rouge, scores 0, ...). The production data has none; this only protects against
  hand-edited rows so the upgrade can never fail on them.
* For questions classified ``true_false`` whose French labels are the English ones (the legacy CSV import
  stored ``TRUE``/``FALSE`` in both languages) or empty, the French labels become ``Vrai``/``Faux``.

Every step first checks the live catalog, so re-running it on a partially upgraded database (for example
after ``UPDATE alembic_version SET version_num='0001'``) converges instead of failing. ``game_settings``
is left untouched (legacy, unused). ``downgrade`` restores the legacy schema when a single event exists.
"""
from __future__ import annotations

import json
import logging

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration.0002")

DEFAULT_EVENT_SLUG = "api-masters"
DEFAULT_EVENT = {
    "name": "API Masters",
    "game_title": "API Masters",
    "status": "live",
    "tagline_en": "Answer quick-fire questions, beat the other players and become THE API Master.",
    "tagline_fr": "Répondez à des questions en rafale, battez les autres joueurs et devenez THE API Master.",
    "description_en": "Test your knowledge of APIs, event-driven architecture and AI against the other attendees.",
    "description_fr": "Testez vos connaissances sur les API, l'event-driven et l'IA face aux autres participants.",
    "languages": ["en", "fr"],
    "default_language": "en",
    "branding": {
        "primary_color": "#FC5607",
        "accent_color": "#FF9A52",
        "background_style": "aurora",
        "logo_url": None,
        "default_theme": "dark",
    },
}
DEFAULT_SETTINGS = {
    "questions_per_game": 15,
    "timer_seconds": 20,
    "points_correct": 100,
    "points_wrong": 0,
    "time_bonus_max": 50,
}
# (column, min, max) ranges enforced by the CHECK constraints of ``events``
SETTINGS_RANGES = {
    "questions_per_game": (1, 50),
    "timer_seconds": (5, 120),
    "points_correct": (0, 2_147_483_647),
    "points_wrong": (0, 2_147_483_647),
    "time_bonus_max": (0, 2_147_483_647),
}

LOCK_TIMEOUT = "60s"  # fail fast instead of freezing live traffic behind a long-running old transaction

NOW_UTC = "timezone('utc', now())"

# Legacy tables that receive an ``event_id``
EVENT_SCOPED_TABLES = ("categories", "questions", "players", "game_sessions")

# Legacy primary keys are renamed to the ORM convention
PK_TABLES = ("users", "categories", "questions", "players", "game_sessions", "game_answers")

# (table, column, SQL expression used for NULLs): legacy columns the ORM declares NOT NULL.
# Defaults are the OLD ORM defaults (what the legacy code always wrote), so no real row is affected.
NOT_NULL_BACKFILL = (
    ("users", "is_active", "TRUE"),
    ("users", "created_at", NOW_UTC),
    ("categories", "color", "'#FC5607'"),
    ("categories", "is_active", "TRUE"),
    ("categories", "created_at", NOW_UTC),
    ("categories", "updated_at", f"COALESCE(created_at, {NOW_UTC})"),
    ("questions", "question_type", "'text'"),
    ("questions", "green_label_en", "'Green'"),
    ("questions", "green_label_fr", "'Vert'"),
    ("questions", "red_label_en", "'Red'"),
    ("questions", "red_label_fr", "'Rouge'"),
    ("questions", "is_active", "TRUE"),
    ("questions", "difficulty", "1"),
    ("questions", "created_at", NOW_UTC),
    ("questions", "updated_at", f"COALESCE(created_at, {NOW_UTC})"),
    ("players", "created_at", NOW_UTC),
    (
        "game_sessions",
        "status",
        "CASE WHEN completed_at IS NOT NULL THEN 'completed' ELSE 'in_progress' END",
    ),
    ("game_sessions", "total_score", "0"),
    ("game_sessions", "correct_answers", "0"),
    ("game_sessions", "wrong_answers", "0"),
    ("game_sessions", "unanswered", "0"),
    ("game_sessions", "started_at", f"COALESCE(completed_at, {NOW_UTC})"),
    ("game_answers", "points_earned", "0"),
)

# Foreign keys: (table, column, referred table, ORM-convention name, ON DELETE)
FOREIGN_KEYS = (
    ("categories", "event_id", "events", "fk_categories_event_id_events", "CASCADE"),
    ("questions", "event_id", "events", "fk_questions_event_id_events", "CASCADE"),
    ("players", "event_id", "events", "fk_players_event_id_events", "CASCADE"),
    ("game_sessions", "event_id", "events", "fk_game_sessions_event_id_events", "CASCADE"),
    ("questions", "category_id", "categories", "fk_questions_category_id_categories", "SET NULL"),
    ("game_sessions", "player_id", "players", "fk_game_sessions_player_id_players", "CASCADE"),
    ("game_answers", "game_session_id", "game_sessions", "fk_game_answers_game_session_id_game_sessions", "CASCADE"),
    ("game_answers", "question_id", "questions", "fk_game_answers_question_id_questions", "CASCADE"),
)

# Legacy FK names (PostgreSQL auto names) restored by the downgrade
LEGACY_FOREIGN_KEYS = (
    ("questions", "category_id", "categories", "questions_category_id_fkey"),
    ("game_sessions", "player_id", "players", "game_sessions_player_id_fkey"),
    ("game_answers", "game_session_id", "game_sessions", "game_answers_game_session_id_fkey"),
    ("game_answers", "question_id", "questions", "game_answers_question_id_fkey"),
)

NEW_INDEXES = (
    ("ix_categories_event_id", "categories", "event_id"),
    ("ix_questions_event_id", "questions", "event_id"),
    ("ix_questions_category_id", "questions", "category_id"),
    ("ix_players_event_id", "players", "event_id"),
    ("ix_game_sessions_player_id", "game_sessions", "player_id"),
    ("ix_game_answers_game_session_id", "game_answers", "game_session_id"),
    ("ix_game_answers_question_id", "game_answers", "question_id"),
)
SCOREBOARD_INDEX = "ix_game_sessions_event_status_score"

CHECKS = (
    ("questions", "ck_questions_question_format_valid", "question_format IN ('true_false', 'two_choices')"),
    ("questions", "ck_questions_difficulty_range", "difficulty >= 1 AND difficulty <= 5"),
    ("questions", "ck_questions_correct_answer_valid", "correct_answer IN ('green', 'red')"),
    ("game_sessions", "ck_game_sessions_status_valid", "status IN ('in_progress', 'completed', 'abandoned')"),
)

IS_TRUE_FALSE = "upper(btrim(coalesce(green_label_en, ''))) = 'TRUE' AND upper(btrim(coalesce(red_label_en, ''))) = 'FALSE'"


# ---------------------------------------------------------------------------------------------
# Catalog helpers
# ---------------------------------------------------------------------------------------------
def _q(bind, identifier: str) -> str:
    return bind.dialect.identifier_preparer.quote(identifier)


def _has_table(bind, table: str) -> bool:
    return sa.inspect(bind).has_table(table)


def _columns(bind, table: str) -> dict[str, dict]:
    return {c["name"]: c for c in sa.inspect(bind).get_columns(table)}


def _constraint_exists(bind, table: str, name: str) -> bool:
    return bool(
        bind.execute(
            sa.text(
                "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
                "WHERE t.relname = :t AND c.conname = :n AND t.relnamespace = current_schema()::regnamespace"
            ),
            {"t": table, "n": name},
        ).first()
    )


def _count(bind, sql: str, **params) -> int:
    return int(bind.execute(sa.text(sql), params).scalar() or 0)


def _exec(bind, sql: str, **params):
    return bind.execute(sa.text(sql), params)


# ---------------------------------------------------------------------------------------------
# Step 1: events table
# ---------------------------------------------------------------------------------------------
def _create_events_table(bind) -> None:
    if _has_table(bind, "events"):
        log.info("0002: table events already exists, keeping it")
        return
    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(length=48), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("game_title", sa.String(length=100), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("hero_title_en", sa.String(length=200), nullable=True),
        sa.Column("hero_title_fr", sa.String(length=200), nullable=True),
        sa.Column("tagline_en", sa.String(length=300), nullable=True),
        sa.Column("tagline_fr", sa.String(length=300), nullable=True),
        sa.Column("description_en", sa.Text(), nullable=True),
        sa.Column("description_fr", sa.Text(), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("starts_on", sa.Date(), nullable=True),
        sa.Column("ends_on", sa.Date(), nullable=True),
        sa.Column("languages", sa.JSON(), nullable=False),
        sa.Column("default_language", sa.String(length=2), nullable=False),
        sa.Column("branding", sa.JSON(), nullable=False),
        sa.Column("questions_per_game", sa.Integer(), nullable=False),
        sa.Column("timer_seconds", sa.Integer(), nullable=False),
        sa.Column("points_correct", sa.Integer(), nullable=False),
        sa.Column("points_wrong", sa.Integer(), nullable=False),
        sa.Column("time_bonus_max", sa.Integer(), nullable=False),
        sa.Column("category_distribution", sa.JSON(), nullable=True),
        sa.Column("question_order", sa.String(length=12), nullable=False),
        sa.Column("collect_phone", sa.String(length=10), nullable=False),
        sa.Column("consent_text_en", sa.Text(), nullable=True),
        sa.Column("consent_text_fr", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_events")),
        sa.UniqueConstraint("slug", name=op.f("uq_events_slug")),
        sa.CheckConstraint("status IN ('draft', 'live', 'closed')", name=op.f("ck_events_status_valid")),
        sa.CheckConstraint(
            "question_order IN ('random', 'easy_to_hard')", name=op.f("ck_events_question_order_valid")
        ),
        sa.CheckConstraint(
            "collect_phone IN ('hidden', 'optional', 'required')", name=op.f("ck_events_collect_phone_valid")
        ),
        sa.CheckConstraint("default_language IN ('en', 'fr')", name=op.f("ck_events_default_language_valid")),
        sa.CheckConstraint(
            "questions_per_game >= 1 AND questions_per_game <= 50", name=op.f("ck_events_questions_per_game_range")
        ),
        sa.CheckConstraint(
            "timer_seconds >= 5 AND timer_seconds <= 120", name=op.f("ck_events_timer_seconds_range")
        ),
        sa.CheckConstraint("points_correct >= 0", name=op.f("ck_events_points_correct_nonneg")),
        sa.CheckConstraint("points_wrong >= 0", name=op.f("ck_events_points_wrong_nonneg")),
        sa.CheckConstraint("time_bonus_max >= 0", name=op.f("ck_events_time_bonus_max_nonneg")),
    )
    log.info("0002: created table events")


# ---------------------------------------------------------------------------------------------
# Step 2: default event from the legacy game_settings row
# ---------------------------------------------------------------------------------------------
def _legacy_has_data(bind) -> bool:
    for table in ("categories", "questions", "players", "game_sessions", "game_settings"):
        if bind.execute(sa.text(f"SELECT EXISTS (SELECT 1 FROM {table})")).scalar():
            return True
    return False


def _bounded_int(name: str, value, default: int) -> int:
    lo, hi = SETTINGS_RANGES[name]
    if value is None:
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        log.warning("0002: legacy game_settings.%s=%r is not a number, using %s", name, value, default)
        return default
    bounded = min(max(number, lo), hi)
    if bounded != number:
        log.warning("0002: legacy game_settings.%s=%s is outside %s..%s, using %s", name, number, lo, hi, bounded)
    return bounded


def _clean_distribution(value):
    """Legacy ``{"<category id>": percentage}`` -> same mapping with valid numbers only (None when empty)."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    cleaned = {}
    for key, weight in value.items():
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or weight < 0:
            log.warning("0002: dropping invalid category_distribution entry %r: %r", key, weight)
            continue
        cleaned[str(key)] = int(weight) if float(weight).is_integer() else weight
    return cleaned or None


def _legacy_settings(bind) -> dict:
    row = (
        bind.execute(
            sa.text(
                "SELECT questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                "category_distribution FROM game_settings ORDER BY id LIMIT 1"
            )
        )
        .mappings()
        .first()
    )
    settings = dict(DEFAULT_SETTINGS)
    distribution = None
    if row is None:
        log.info("0002: no legacy game_settings row, using defaults")
    else:
        for name in DEFAULT_SETTINGS:
            settings[name] = _bounded_int(name, row[name], DEFAULT_SETTINGS[name])
        distribution = _clean_distribution(row["category_distribution"])
    settings["category_distribution"] = distribution
    return settings


def _find_default_event(bind) -> int | None:
    row = _exec(bind, "SELECT id FROM events WHERE slug = :slug", slug=DEFAULT_EVENT_SLUG).first()
    return int(row[0]) if row else None


def _ensure_default_event(bind) -> int | None:
    """Id of the ``api-masters`` event; created from the legacy data when there is some to migrate."""
    event_id = _find_default_event(bind)
    if event_id is not None:
        log.info("0002: default event %r already exists (id=%s)", DEFAULT_EVENT_SLUG, event_id)
        return event_id
    if not _legacy_has_data(bind):
        log.info("0002: empty database, no default event created (it is seeded from events/api-masters.json)")
        return None
    settings = _legacy_settings(bind)
    event = DEFAULT_EVENT
    event_id = int(
        _exec(
            bind,
            f"""
            INSERT INTO events (
                slug, name, game_title, status, tagline_en, tagline_fr, description_en, description_fr,
                languages, default_language, branding,
                questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max,
                category_distribution, question_order, collect_phone, created_at, updated_at
            ) VALUES (
                :slug, :name, :game_title, :status, :tagline_en, :tagline_fr, :description_en, :description_fr,
                CAST(:languages AS json), :default_language, CAST(:branding AS json),
                :questions_per_game, :timer_seconds, :points_correct, :points_wrong, :time_bonus_max,
                CAST(:category_distribution AS json), 'random', 'optional', {NOW_UTC}, {NOW_UTC}
            ) RETURNING id
            """,
            slug=DEFAULT_EVENT_SLUG,
            name=event["name"],
            game_title=event["game_title"],
            status=event["status"],
            tagline_en=event["tagline_en"],
            tagline_fr=event["tagline_fr"],
            description_en=event["description_en"],
            description_fr=event["description_fr"],
            languages=json.dumps(event["languages"]),
            default_language=event["default_language"],
            branding=json.dumps(event["branding"]),
            questions_per_game=settings["questions_per_game"],
            timer_seconds=settings["timer_seconds"],
            points_correct=settings["points_correct"],
            points_wrong=settings["points_wrong"],
            time_bonus_max=settings["time_bonus_max"],
            category_distribution=json.dumps(settings["category_distribution"])
            if settings["category_distribution"] is not None
            else None,
        ).scalar()
    )
    log.info("0002: created default event %r (id=%s) with settings %s", DEFAULT_EVENT_SLUG, event_id, settings)
    return event_id


# ---------------------------------------------------------------------------------------------
# Step 3: new columns + backfill
# ---------------------------------------------------------------------------------------------
def _add_columns(bind) -> None:
    for statement in (
        "ALTER TABLE categories ADD COLUMN IF NOT EXISTS event_id INTEGER",
        "ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_fr VARCHAR(100)",
        "ALTER TABLE categories ADD COLUMN IF NOT EXISTS description_fr TEXT",
        "ALTER TABLE questions ADD COLUMN IF NOT EXISTS event_id INTEGER",
        "ALTER TABLE questions ADD COLUMN IF NOT EXISTS question_format VARCHAR(12)",
        "ALTER TABLE players ADD COLUMN IF NOT EXISTS event_id INTEGER",
        "ALTER TABLE players ADD COLUMN IF NOT EXISTS consent_at TIMESTAMP WITHOUT TIME ZONE",
        "ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS event_id INTEGER",
    ):
        bind.execute(sa.text(statement))


def _backfill_event_id(bind, event_id: int | None) -> None:
    for table in EVENT_SCOPED_TABLES:
        if event_id is not None:
            updated = _exec(
                bind, f"UPDATE {table} SET event_id = :event_id WHERE event_id IS NULL", event_id=event_id
            ).rowcount
            log.info("0002: %s: %s row(s) assigned to event id=%s", table, updated, event_id)
        orphans = _count(bind, f"SELECT count(*) FROM {table} WHERE event_id IS NULL")
        if orphans:  # cannot happen (an event exists whenever legacy rows do) but never fail silently
            raise RuntimeError(f"0002: {orphans} row(s) of {table} have no event after the backfill")


def _backfill_question_format(bind) -> None:
    """Fix the French true/false labels, then set ``question_format`` (only rows not yet classified)."""
    fixed = _exec(
        bind,
        f"""
        UPDATE questions SET
            green_label_fr = CASE WHEN green_label_fr IS NULL OR upper(btrim(green_label_fr)) IN ('', 'TRUE')
                                  THEN 'Vrai' ELSE green_label_fr END,
            red_label_fr = CASE WHEN red_label_fr IS NULL OR upper(btrim(red_label_fr)) IN ('', 'FALSE')
                                THEN 'Faux' ELSE red_label_fr END
        WHERE question_format IS NULL AND {IS_TRUE_FALSE}
          AND (green_label_fr IS NULL OR upper(btrim(green_label_fr)) IN ('', 'TRUE')
               OR red_label_fr IS NULL OR upper(btrim(red_label_fr)) IN ('', 'FALSE'))
        """,
    ).rowcount
    _fill_nulls(bind, "questions", ("green_label_en", "green_label_fr", "red_label_en", "red_label_fr"))
    classified = _exec(
        bind,
        f"""
        UPDATE questions SET question_format = CASE WHEN {IS_TRUE_FALSE} THEN 'true_false' ELSE 'two_choices' END
        WHERE question_format IS NULL
        """,
    ).rowcount
    log.info("0002: questions: %s classified (question_format), %s French true/false label(s) set to Vrai/Faux",
             classified, fixed)


def _fill_nulls(bind, table: str, only: tuple[str, ...] | None = None) -> None:
    """Replace NULLs of legacy columns the ORM declares NOT NULL by the old ORM defaults."""
    columns = _columns(bind, table)
    for t, column, expression in NOT_NULL_BACKFILL:
        if t != table or (only is not None and column not in only):
            continue
        if columns.get(column, {}).get("nullable", False):
            updated = _exec(bind, f"UPDATE {table} SET {column} = {expression} WHERE {column} IS NULL").rowcount
            if updated:
                log.warning("0002: %s.%s: %s NULL value(s) replaced by the legacy default", table, column, updated)


# ---------------------------------------------------------------------------------------------
# Step 4/5: constraints
# ---------------------------------------------------------------------------------------------
def _set_not_null(bind, table: str, column: str) -> None:
    if _columns(bind, table)[column]["nullable"]:
        bind.execute(sa.text(f"ALTER TABLE {table} ALTER COLUMN {column} SET NOT NULL"))


def _ensure_fk(bind, table: str, column: str, ref_table: str, name: str, ondelete: str) -> None:
    """Make sure exactly one FK ``column -> ref_table.id`` exists, named ``name``, with ``ondelete``."""
    keep = False
    for fk in sa.inspect(bind).get_foreign_keys(table):
        if fk["constrained_columns"] != [column] or fk["referred_table"] != ref_table:
            continue
        action = ((fk.get("options") or {}).get("ondelete") or "").upper()
        if not keep and fk["name"] == name and action == ondelete:
            keep = True
            continue
        bind.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT {_q(bind, fk['name'])}"))
    if not keep:
        bind.execute(
            sa.text(
                f"ALTER TABLE {table} ADD CONSTRAINT {name} FOREIGN KEY ({column}) "
                f"REFERENCES {ref_table} (id) ON DELETE {ondelete}"
            )
        )


def _replace_category_name_unique(bind) -> None:
    """Drop the legacy unique(name) (auto name discovered by introspection), add unique(event_id, name)."""
    insp = sa.inspect(bind)
    for uc in insp.get_unique_constraints("categories"):
        if uc["column_names"] == ["name"]:
            log.info("0002: dropping legacy unique constraint %s on categories.name", uc["name"])
            bind.execute(sa.text(f"ALTER TABLE categories DROP CONSTRAINT {_q(bind, uc['name'])}"))
    for ix in sa.inspect(bind).get_indexes("categories"):
        if ix.get("unique") and ix["column_names"] == ["name"] and not ix.get("duplicates_constraint"):
            log.info("0002: dropping legacy unique index %s on categories.name", ix["name"])
            bind.execute(sa.text(f"DROP INDEX {_q(bind, ix['name'])}"))
    if not _constraint_exists(bind, "categories", "uq_categories_event_id_name"):
        bind.execute(
            sa.text("ALTER TABLE categories ADD CONSTRAINT uq_categories_event_id_name UNIQUE (event_id, name)")
        )


def _add_check(bind, table: str, name: str, expression: str) -> None:
    """Add a CHECK constraint, unless existing (hand-edited) legacy rows violate it.

    Such rows are never rewritten and must never block the upgrade, so in that case the constraint is
    skipped with a loud warning (NOT VALID would also work, but SQLAlchemy 2.0.44's reflection chokes on
    NOT VALID checks, which breaks ``alembic revision --autogenerate``). The API validates these values anyway.
    """
    if _constraint_exists(bind, table, name):
        return
    violations = _count(bind, f"SELECT count(*) FROM {table} WHERE ({expression}) IS FALSE")
    if violations:
        log.warning(
            "0002: %s row(s) of %s violate CHECK (%s): constraint %s NOT created. Fix the rows, then run: "
            "ALTER TABLE %s ADD CONSTRAINT %s CHECK (%s)",
            violations, table, expression, name, table, name, expression,
        )
        return
    bind.execute(sa.text(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expression})"))


def _rename_primary_keys(bind) -> None:
    for table in PK_TABLES:
        pk = sa.inspect(bind).get_pk_constraint(table)
        target = f"pk_{table}"
        if pk.get("name") and pk["name"] != target:
            bind.execute(sa.text(f"ALTER TABLE {table} RENAME CONSTRAINT {_q(bind, pk['name'])} TO {target}"))


# ---------------------------------------------------------------------------------------------
# upgrade / downgrade
# ---------------------------------------------------------------------------------------------
def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        raise RuntimeError("Revision 0002 only supports PostgreSQL")
    bind.execute(sa.text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))

    _create_events_table(bind)
    _add_columns(bind)

    event_id = _ensure_default_event(bind)
    _backfill_event_id(bind, event_id)

    # Legacy NULLs -> old ORM defaults (so NOT NULL below cannot fail), then classify questions
    _backfill_question_format(bind)
    for table in ("users", "categories", "questions", "players", "game_sessions", "game_answers"):
        _fill_nulls(bind, table)
    bind.execute(sa.text("ALTER TABLE questions ALTER COLUMN question_text_fr DROP NOT NULL"))

    for table in EVENT_SCOPED_TABLES:
        _set_not_null(bind, table, "event_id")
    _set_not_null(bind, "questions", "question_format")
    for table, column, _expression in NOT_NULL_BACKFILL:
        _set_not_null(bind, table, column)

    _rename_primary_keys(bind)
    _replace_category_name_unique(bind)
    for table, column, ref_table, name, ondelete in FOREIGN_KEYS:
        _ensure_fk(bind, table, column, ref_table, name, ondelete)
    for name, table, column in NEW_INDEXES:
        bind.execute(sa.text(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({column})"))
    bind.execute(
        sa.text(
            f"CREATE INDEX IF NOT EXISTS {SCOREBOARD_INDEX} ON game_sessions (event_id, status, total_score DESC)"
        )
    )
    for table, name, expression in CHECKS:
        _add_check(bind, table, name, expression)
    log.info("0002: events migration complete")


def downgrade() -> None:
    """Restore the legacy schema. Only possible while a single event exists (otherwise the events'
    categories/questions/players would be merged); data of the legacy tables is preserved, the
    ``events`` table and all new columns are dropped."""
    bind = op.get_bind()
    events = _count(bind, "SELECT count(*) FROM events") if _has_table(bind, "events") else 0
    if events > 1:
        raise RuntimeError(f"Refusing to downgrade 0002: {events} events exist (delete the extra events first)")
    bind.execute(sa.text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))

    for table, name, _expression in CHECKS:
        bind.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}"))
    for name, _table, _column in NEW_INDEXES:
        bind.execute(sa.text(f"DROP INDEX IF EXISTS {name}"))
    bind.execute(sa.text(f"DROP INDEX IF EXISTS {SCOREBOARD_INDEX}"))

    # legacy foreign keys: no ON DELETE action, auto names
    for table, column, ref_table, name in LEGACY_FOREIGN_KEYS:
        for fk in sa.inspect(bind).get_foreign_keys(table):
            if fk["constrained_columns"] == [column] and fk["referred_table"] == ref_table:
                bind.execute(sa.text(f"ALTER TABLE {table} DROP CONSTRAINT {_q(bind, fk['name'])}"))
        bind.execute(
            sa.text(f"ALTER TABLE {table} ADD CONSTRAINT {name} FOREIGN KEY ({column}) REFERENCES {ref_table} (id)")
        )

    # unique(name) back (auto name of the legacy schema); fails only if two events shared a name
    bind.execute(sa.text("ALTER TABLE categories DROP CONSTRAINT IF EXISTS uq_categories_event_id_name"))
    if not _constraint_exists(bind, "categories", "categories_name_key"):
        bind.execute(sa.text("ALTER TABLE categories ADD CONSTRAINT categories_name_key UNIQUE (name)"))

    # new columns (their FKs / remaining indexes disappear with them)
    for table in EVENT_SCOPED_TABLES:
        bind.execute(sa.text(f"ALTER TABLE {table} DROP COLUMN IF EXISTS event_id"))
    bind.execute(sa.text("ALTER TABLE categories DROP COLUMN IF EXISTS name_fr"))
    bind.execute(sa.text("ALTER TABLE categories DROP COLUMN IF EXISTS description_fr"))
    bind.execute(sa.text("ALTER TABLE questions DROP COLUMN IF EXISTS question_format"))
    bind.execute(sa.text("ALTER TABLE players DROP COLUMN IF EXISTS consent_at"))

    bind.execute(sa.text("UPDATE questions SET question_text_fr = question_text_en WHERE question_text_fr IS NULL"))
    bind.execute(sa.text("ALTER TABLE questions ALTER COLUMN question_text_fr SET NOT NULL"))

    # the legacy schema had these columns nullable
    for table, column, _expression in NOT_NULL_BACKFILL:
        bind.execute(sa.text(f"ALTER TABLE {table} ALTER COLUMN {column} DROP NOT NULL"))

    for table in PK_TABLES:
        pk = sa.inspect(bind).get_pk_constraint(table)
        legacy = f"{table}_pkey"
        if pk.get("name") and pk["name"] != legacy:
            bind.execute(sa.text(f"ALTER TABLE {table} RENAME CONSTRAINT {_q(bind, pk['name'])} TO {legacy}"))

    op.drop_table("events")
