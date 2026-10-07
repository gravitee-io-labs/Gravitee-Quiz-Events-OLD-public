"""
Database migration tests (Alembic 0001 baseline + 0002 events) against a REAL PostgreSQL.

    docker run -d --name quiz-test-pg -e POSTGRES_USER=quiz_user -e POSTGRES_PASSWORD=quiz_password \
        -e POSTGRES_DB=gravitee_quiz -p 127.0.0.1:55432:5432 postgres:15-alpine
    TEST_POSTGRES_URL=postgresql://quiz_user:quiz_password@127.0.0.1:55432/gravitee_quiz \
        .venv/bin/pytest tests/test_migrations.py -s

Skipped (``@pytest.mark.postgres``) unless ``TEST_POSTGRES_URL`` is set; the user must be allowed to
``CREATE DATABASE`` (every test works on its own throw-away database, cloned from a template).

The LEGACY database is built once per session by ``tests/legacy/builder.py``: the OLD application's own
``init_db()`` creates the production schema (+ its 20 default questions), then 3 categories, 100 more
questions (120 in total), 200 players, 206 game sessions (200 completed, 5 in progress, 1 abandoned),
2772 answers and a customised ``game_settings`` row are added. ``builder.snapshot`` gives per-table counts and
md5 checksums of the legacy columns, compared before / after the migration.

Optional: ``TEST_PROD_DUMP=/path/to/pg_dump-custom-format.dump`` also migrates a real production dump.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import psycopg2
import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from alembic import command
from app.migrate import MIGRATION_LOCK_KEY, alembic_config, include_object, run_migrations
from app.models import Base, Category, Event, GameAnswer, GameSession, Player, Question
from tests.legacy import builder

POSTGRES_URL = os.environ.get("TEST_POSTGRES_URL")
BACKEND_DIR = Path(__file__).resolve().parents[1]
HEAD = "0002"

requires_postgres = pytest.mark.skipif(not POSTGRES_URL, reason="TEST_POSTGRES_URL is not set")


def postgres_test(fn):
    """``@pytest.mark.postgres`` + skipped unless TEST_POSTGRES_URL is set."""
    return pytest.mark.postgres(requires_postgres(fn))


# ---------------------------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------------------------
def _admin_engine():
    url = make_url(POSTGRES_URL).set(database="postgres")
    return create_engine(url, isolation_level="AUTOCOMMIT", poolclass=NullPool)


def create_database(template: str | None = None) -> str:
    name = f"qm_{uuid.uuid4().hex[:10]}"
    engine = _admin_engine()
    try:
        with engine.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{name}"' + (f' TEMPLATE "{template}"' if template else "")))
    finally:
        engine.dispose()
    return name


def drop_database(name: str) -> None:
    engine = _admin_engine()
    try:
        with engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    finally:
        engine.dispose()


def url_for(name: str) -> str:
    return make_url(POSTGRES_URL).set(database=name).render_as_string(hide_password=False)


def make_engine(url: str):
    return create_engine(url, poolclass=NullPool)


def rows(url: str, sql: str, **params) -> list[tuple]:
    engine = make_engine(url)
    try:
        with engine.begin() as conn:
            result = conn.execute(text(sql), params)
            return [tuple(r) for r in result.fetchall()] if result.returns_rows else []
    finally:
        engine.dispose()


def scalar(url: str, sql: str, **params):
    return rows(url, sql, **params)[0][0]


def execute(url: str, *statements: str) -> None:
    engine = make_engine(url)
    try:
        with engine.begin() as conn:
            for statement in statements:
                conn.execute(text(statement))
    finally:
        engine.dispose()


def current_version(url: str) -> str | None:
    if scalar(url, "SELECT to_regclass('alembic_version')") is None:
        return None
    return scalar(url, "SELECT version_num FROM alembic_version")


def schema_diff(url: str) -> list:
    """``alembic revision --autogenerate`` result: must be empty (``game_settings`` is ignored)."""
    engine = make_engine(url)
    try:
        with engine.connect() as conn:
            context = MigrationContext.configure(conn, opts={"compare_type": True, "include_object": include_object})
            return compare_metadata(context, Base.metadata)
    finally:
        engine.dispose()


IGNORED_TABLES = {"alembic_version", "game_settings"}


def schema_signature(url: str) -> dict:
    """Everything that defines the schema: columns (type, nullability), PK / FK (+ON DELETE) / unique / check /
    index names and definitions, per table (``game_settings`` and ``alembic_version`` excluded)."""
    engine = make_engine(url)
    try:
        insp = inspect(engine)
        signature = {}
        for table in sorted(set(insp.get_table_names()) - IGNORED_TABLES):
            pk = insp.get_pk_constraint(table)
            signature[table] = {
                "columns": {c["name"]: (str(c["type"]), bool(c["nullable"])) for c in insp.get_columns(table)},
                "pk": (pk["name"], tuple(pk["constrained_columns"])),
                "fks": sorted(
                    (
                        fk["name"], tuple(fk["constrained_columns"]), fk["referred_table"],
                        tuple(fk["referred_columns"]), (fk.get("options") or {}).get("ondelete"),
                    )
                    for fk in insp.get_foreign_keys(table)
                ),
                "uniques": sorted((u["name"], tuple(u["column_names"])) for u in insp.get_unique_constraints(table)),
                "indexes": sorted(
                    (
                        i["name"], tuple(i["column_names"]), bool(i.get("unique")),
                        tuple(sorted((i.get("column_sorting") or {}).items())),
                    )
                    for i in insp.get_indexes(table)
                    if not i.get("duplicates_constraint")
                ),
                "checks": sorted((c["name"], c["sqltext"]) for c in insp.get_check_constraints(table)),
            }
        return signature
    finally:
        engine.dispose()


def invalid_constraints(url: str) -> set[str]:
    return {r[0] for r in rows(url, "SELECT conname FROM pg_constraint WHERE NOT convalidated")}


# ---------------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------------
@dataclass
class LegacyTemplate:
    name: str
    url: str
    summary: builder.DatasetSummary
    snapshot: dict
    signature: dict


@pytest.fixture(scope="session")
def legacy_template():
    """The legacy database, built once (``tests/legacy/builder.py``) and cloned with CREATE DATABASE ... TEMPLATE."""
    name = create_database()
    url = url_for(name)
    try:
        summary = builder.build_legacy_database(url)
        yield LegacyTemplate(name, url, summary, builder.snapshot(url), schema_signature(url))
    finally:
        drop_database(name)


@pytest.fixture(scope="session")
def orm_reference_signature():
    """Schema signature of a brand new database created with ``Base.metadata.create_all`` (what the ORM wants)."""
    name = create_database()
    url = url_for(name)
    try:
        engine = make_engine(url)
        Base.metadata.create_all(engine)
        engine.dispose()
        return schema_signature(url)
    finally:
        drop_database(name)


@pytest.fixture
def legacy_db(legacy_template):
    name = create_database(template=legacy_template.name)
    try:
        yield url_for(name)
    finally:
        drop_database(name)


@pytest.fixture
def empty_db():
    name = create_database()
    try:
        yield url_for(name)
    finally:
        drop_database(name)


@dataclass
class Migrated:
    url: str
    elapsed: float
    before: dict
    after: dict


@pytest.fixture
def migrated_legacy(legacy_db, legacy_template):
    """A clone of the legacy database after ``run_migrations`` (timed)."""
    started = time.perf_counter()
    run_migrations(legacy_db)
    elapsed = time.perf_counter() - started
    return Migrated(legacy_db, elapsed, legacy_template.snapshot, builder.snapshot(legacy_db))


# ---------------------------------------------------------------------------------------------
# Static checks (no PostgreSQL needed)
# ---------------------------------------------------------------------------------------------
def test_single_linear_history():
    script = ScriptDirectory.from_config(alembic_config("postgresql://u:p@localhost/db"))
    assert script.get_heads() == [HEAD]
    assert [r.revision for r in script.walk_revisions()] == ["0002", "0001"]
    assert script.get_revision("0001").down_revision is None


def test_run_migrations_is_a_noop_on_sqlite(caplog):
    caplog.set_level("INFO")
    assert run_migrations("sqlite://") is None
    assert "migrations skipped" in caplog.text


# ---------------------------------------------------------------------------------------------
# Legacy production database -> events
# ---------------------------------------------------------------------------------------------
@postgres_test
def test_legacy_fixture_is_the_production_schema(legacy_template):
    """Sanity: the builder reproduced the production schema (names the migration has to discover)."""
    categories = legacy_template.signature["categories"]
    assert categories["pk"][0] == "categories_pkey"
    assert ("categories_name_key", ("name",)) in categories["uniques"]
    assert [fk[0] for fk in legacy_template.signature["questions"]["fks"]] == ["questions_category_id_fkey"]
    assert legacy_template.signature["questions"]["columns"]["question_text_fr"] == ("TEXT", False)
    assert legacy_template.snapshot["questions"][0] == 120
    assert legacy_template.snapshot["game_sessions"][0] == 206
    assert legacy_template.snapshot["game_answers"][0] > 2000
    assert legacy_template.snapshot["game_settings"][0] == 1
    assert current_version(url_for(legacy_template.name)) is None  # no alembic_version in production


@postgres_test
def test_legacy_upgrade_preserves_all_data(migrated_legacy, legacy_template, capsys):
    url = migrated_legacy.url
    assert current_version(url) == HEAD
    # row counts and checksums of every legacy column of every legacy table: identical
    assert migrated_legacy.after == migrated_legacy.before
    # the old settings table is untouched and still holds the customised row
    assert rows(url, "SELECT questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                     "category_distribution::text FROM game_settings") == [(12, 15, 120, 5, 40, '{"1": 50, "2": 30, "3": 20}')]
    with capsys.disabled():
        print(
            f"\n[migration timing] legacy dataset ({legacy_template.snapshot['players'][0]} players, "
            f"{legacy_template.snapshot['game_sessions'][0]} sessions, {legacy_template.snapshot['game_answers'][0]} answers, "
            f"{legacy_template.snapshot['questions'][0]} questions): 0001+0002 in {migrated_legacy.elapsed:.3f}s"
        )
    assert migrated_legacy.elapsed < 30


@postgres_test
def test_default_event_is_created_from_the_legacy_settings(migrated_legacy):
    url = migrated_legacy.url
    events = rows(url, "SELECT id, slug, name, game_title, status, languages::text, default_language, branding::text, "
                       "question_order, collect_phone, consent_text_en, hero_title_en, location FROM events")
    assert len(events) == 1
    event_id, slug, name, title, status, languages, default_language, branding, order, phone, consent, hero, location = events[0]
    assert (slug, name, title, status) == ("api-masters", "API Masters", "API Masters", "live")
    assert json.loads(languages) == ["en", "fr"] and default_language == "en"
    assert json.loads(branding) == {
        "primary_color": "#FC5607", "accent_color": "#FF9A52", "background_style": "aurora",
        "logo_url": None, "default_theme": "dark",
    }
    assert (order, phone, consent, hero, location) == ("random", "optional", None, None, None)
    # game rules copied from the customised legacy game_settings row
    assert rows(url, "SELECT questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                     "category_distribution::text FROM events") == [(12, 15, 120, 5, 40, '{"1": 50, "2": 30, "3": 20}')]
    # EVERY legacy row belongs to that event
    for table in ("categories", "questions", "players", "game_sessions"):
        assert scalar(url, f"SELECT count(*) FROM {table} WHERE event_id IS DISTINCT FROM :e", e=event_id) == 0, table
    # the distribution keys are category ids and the categories kept their ids
    ids = {r[0] for r in rows(url, "SELECT id FROM categories")}
    assert ids == {int(k) for k in json.loads(rows(url, "SELECT category_distribution::text FROM events")[0][0])}


@postgres_test
def test_question_format_backfill_and_new_columns(migrated_legacy, legacy_template):
    url = migrated_legacy.url
    summary = legacy_template.summary
    assert scalar(url, "SELECT count(*) FROM questions WHERE question_format = 'true_false'") == summary.true_false_questions
    assert scalar(url, "SELECT count(*) FROM questions WHERE question_format = 'two_choices'") == summary.two_choice_questions
    # rule: TRUE/FALSE english labels <=> true_false (the 5 inverted FALSE/TRUE questions are two_choices)
    assert scalar(url, "SELECT count(*) FROM questions WHERE (upper(green_label_en) = 'TRUE' AND upper(red_label_en) = 'FALSE') "
                       "<> (question_format = 'true_false')") == 0
    assert scalar(url, "SELECT count(*) FROM questions WHERE green_label_en = 'FALSE'") == 5
    # French labels of true/false questions become Vrai / Faux; two_choices questions are not touched
    assert rows(url, "SELECT DISTINCT green_label_fr, red_label_fr FROM questions WHERE question_format = 'true_false'") == [("Vrai", "Faux")]
    assert migrated_legacy.after["questions.fr_labels_non_tf"] == migrated_legacy.before["questions.fr_labels_non_tf"]
    # new nullable columns start empty
    assert scalar(url, "SELECT count(*) FROM categories WHERE name_fr IS NOT NULL OR description_fr IS NOT NULL") == 0
    assert scalar(url, "SELECT count(*) FROM players WHERE consent_at IS NOT NULL") == 0
    # question_text_fr is nullable now, the other legacy columns the ORM requires are NOT NULL
    columns = schema_signature(url)["questions"]["columns"]
    assert columns["question_text_fr"][1] is True
    assert columns["is_active"][1] is False and columns["question_format"][1] is False


@postgres_test
def test_schema_matches_the_orm_metadata(migrated_legacy):
    """``alembic revision --autogenerate`` finds nothing to do (indexes, uniques, FKs incl. ON DELETE, types, nullability)."""
    assert schema_diff(migrated_legacy.url) == []


@postgres_test
def test_constraint_and_index_names_match_the_orm_exactly(migrated_legacy, orm_reference_signature):
    """Stricter than autogenerate (which ignores PK / FK / CHECK names): the migrated legacy schema is
    identical, name for name, to a database created by ``Base.metadata.create_all``."""
    assert schema_signature(migrated_legacy.url) == orm_reference_signature


@postgres_test
def test_legacy_unique_name_constraint_is_replaced(migrated_legacy):
    url = migrated_legacy.url
    uniques = schema_signature(url)["categories"]["uniques"]
    assert uniques == [("uq_categories_event_id_name", ("event_id", "name"))]
    execute(url, "INSERT INTO events (slug, name, game_title, status, languages, default_language, branding, questions_per_game, "
                 "timer_seconds, points_correct, points_wrong, time_bonus_max, question_order, collect_phone, created_at, updated_at) "
                 "VALUES ('other', 'Other', 'Other', 'draft', '[\"en\"]', 'en', '{}', 10, 20, 100, 0, 50, 'random', 'optional', now(), now())")
    # the same category name is now allowed in another event, but not twice in the same one
    execute(url, "INSERT INTO categories (name, event_id, color, is_active, created_at, updated_at) "
                 "SELECT 'REST API', id, '#000000', true, now(), now() FROM events WHERE slug = 'other'")
    with pytest.raises(Exception, match="uq_categories_event_id_name"):
        execute(url, "INSERT INTO categories (name, event_id, color, is_active, created_at, updated_at) "
                     "SELECT 'REST API', id, '#000000', true, now(), now() FROM events WHERE slug = 'api-masters'")


@postgres_test
def test_orm_reads_and_writes_the_migrated_legacy_rows(migrated_legacy):
    engine = make_engine(migrated_legacy.url)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        with Session() as s:
            event = s.query(Event).one()
            assert event.slug == "api-masters" and event.languages == ["en", "fr"]
            assert event.branding["primary_color"] == "#FC5607"
            assert event.category_distribution == {"1": 50, "2": 30, "3": 20}
            assert (len(event.categories), len(event.questions), len(event.players), len(event.game_sessions)) == (3, 120, 200, 206)
            question = s.query(Question).filter(Question.question_format == "two_choices").first()
            assert question.green_label_en and question.event_id == event.id
            assert s.query(Question).filter(Question.category_id.is_(None)).count() == 40
            # scoreboard-style query served by ix_game_sessions_event_status_score
            top = (
                s.query(GameSession)
                .filter(GameSession.event_id == event.id, GameSession.status == "completed")
                .order_by(GameSession.total_score.desc())
                .limit(10)
                .all()
            )
            assert len(top) == 10 and top[0].total_score >= top[-1].total_score
            assert top[0].player.first_name and len(top[0].answers) in (12, 15)
            # a new game for a legacy player, written through the new model
            player = Player(event_id=event.id, first_name="New", last_name="Player", email="new@example.test")
            s.add(player)
            s.flush()
            session = GameSession(event_id=event.id, player_id=player.id)
            s.add(session)
            s.flush()
            s.add(GameAnswer(game_session_id=session.id, question_id=question.id, question_order=1))
            s.commit()
            assert player.consent_at is None and session.status == "in_progress"
            # deleting a category un-categorises its questions (ON DELETE SET NULL)
            category = s.query(Category).order_by(Category.id).first()
            in_category = s.query(Question).filter(Question.category_id == category.id).count()
            assert in_category > 0
            s.query(Category).filter(Category.id == category.id).delete()
            s.commit()
            assert s.query(Question).filter(Question.category_id.is_(None)).count() == 40 + in_category
            assert s.query(Question).count() == 120
    finally:
        engine.dispose()


@postgres_test
def test_deleting_the_event_cascades_to_everything(migrated_legacy):
    url = migrated_legacy.url
    event_id = scalar(url, "SELECT id FROM events WHERE slug = 'api-masters'")
    assert scalar(url, "SELECT count(*) FROM game_answers") > 2000
    execute(url, f"DELETE FROM events WHERE id = {event_id}")
    for table in ("categories", "questions", "players", "game_sessions", "game_answers"):
        assert scalar(url, f"SELECT count(*) FROM {table}") == 0, table
    # legacy tables that do not belong to an event are left alone
    assert scalar(url, "SELECT count(*) FROM game_settings") == 1


@postgres_test
def test_orm_event_delete_cascades(migrated_legacy):
    engine = make_engine(migrated_legacy.url)
    try:
        with sessionmaker(bind=engine)() as s:
            s.delete(s.query(Event).one())
            s.commit()
            assert s.query(Question).count() == s.query(Player).count() == s.query(GameAnswer).count() == 0
    finally:
        engine.dispose()


@postgres_test
def test_scoreboard_index_serves_the_ranking_query(migrated_legacy):
    engine = make_engine(migrated_legacy.url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SET enable_seqscan = off"))
            plan = "\n".join(
                r[0]
                for r in conn.execute(
                    text(
                        "EXPLAIN SELECT id FROM game_sessions WHERE event_id = (SELECT id FROM events LIMIT 1) "
                        "AND status = 'completed' ORDER BY total_score DESC LIMIT 10"
                    )
                )
            )
    finally:
        engine.dispose()
    assert "ix_game_sessions_event_status_score" in plan, plan


# ---------------------------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------------------------
@postgres_test
def test_running_twice_is_a_noop(migrated_legacy, caplog):
    caplog.set_level("INFO")
    signature = schema_signature(migrated_legacy.url)
    run_migrations(migrated_legacy.url)
    assert "Database schema is up to date" in caplog.text
    assert "Running upgrade" not in caplog.text
    assert builder.snapshot(migrated_legacy.url) == migrated_legacy.after
    assert schema_signature(migrated_legacy.url) == signature
    assert scalar(migrated_legacy.url, "SELECT count(*) FROM events") == 1


@postgres_test
def test_replaying_0002_on_a_migrated_database_changes_nothing(migrated_legacy):
    """Forgetting that 0002 ran (``alembic_version`` back to 0001) must converge, never duplicate or revert."""
    url = migrated_legacy.url
    signature = schema_signature(url)
    execute(
        url,
        "UPDATE events SET name = 'API Masters (edited by an admin)', timer_seconds = 33",
        "UPDATE questions SET green_label_fr = 'Edited' WHERE question_format = 'true_false' AND id = "
        "(SELECT min(id) FROM questions WHERE question_format = 'true_false')",
        "UPDATE alembic_version SET version_num = '0001'",
    )
    run_migrations(url)
    assert current_version(url) == HEAD
    assert rows(url, "SELECT count(*), min(name), min(timer_seconds) FROM events") == [(1, "API Masters (edited by an admin)", 33)]
    assert scalar(url, "SELECT count(*) FROM questions WHERE green_label_fr = 'Edited'") == 1
    assert schema_signature(url) == signature
    assert schema_diff(url) == []
    assert builder.snapshot(url)["players"] == migrated_legacy.after["players"]


@postgres_test
def test_stamped_baseline_then_upgrade(legacy_db, legacy_template):
    """A legacy database stamped at 0001 (what ``alembic stamp 0001`` does) upgrades to the same result."""
    command.stamp(alembic_config(legacy_db), "0001")
    assert current_version(legacy_db) == "0001"
    run_migrations(legacy_db)
    assert builder.snapshot(legacy_db) == legacy_template.snapshot
    assert schema_diff(legacy_db) == []
    assert scalar(legacy_db, "SELECT count(*) FROM events") == 1


@postgres_test
def test_alembic_cli_upgrade_and_current(legacy_db):
    env = {**os.environ, "DATABASE_URL": legacy_db, "PYTHONPATH": str(BACKEND_DIR)}
    for args in (["upgrade", "head"], ["current"]):
        result = subprocess.run(
            [sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env, capture_output=True, text=True
        )
        assert result.returncode == 0, result.stderr
    assert HEAD in result.stdout + result.stderr
    assert current_version(legacy_db) == HEAD


# ---------------------------------------------------------------------------------------------
# Fresh / empty databases
# ---------------------------------------------------------------------------------------------
@postgres_test
def test_fresh_empty_database_converges_without_creating_an_event(empty_db, orm_reference_signature):
    run_migrations(empty_db)
    assert current_version(empty_db) == HEAD
    # no event: the application seeds events/api-masters.json (docs/ARCHITECTURE.md section 3)
    assert scalar(empty_db, "SELECT count(*) FROM events") == 0
    assert schema_diff(empty_db) == []
    assert schema_signature(empty_db) == orm_reference_signature
    # legacy tables exist next to the new ones
    assert {"users", "categories", "questions", "players", "game_sessions", "game_answers", "game_settings", "events"} <= set(
        inspect(make_engine(empty_db)).get_table_names()
    )
    # and the database is immediately usable
    engine = make_engine(empty_db)
    try:
        with sessionmaker(bind=engine)() as s:
            event = Event(slug="fresh", name="Fresh", game_title="Fresh Masters")
            s.add(event)
            s.flush()
            category = Category(event_id=event.id, name="C")
            s.add(category)
            s.flush()
            s.add(Question(event_id=event.id, category_id=category.id, question_text_en="Q?", correct_answer="green"))
            s.commit()
            s.delete(event)
            s.commit()
            assert s.query(Question).count() == s.query(Category).count() == 0
    finally:
        engine.dispose()


@postgres_test
def test_legacy_database_with_an_empty_questions_table(legacy_db):
    """No categories, no questions (they were all deleted) but a settings row and some players."""
    execute(legacy_db, "DELETE FROM game_answers", "DELETE FROM questions", "DELETE FROM categories",
            "UPDATE game_settings SET category_distribution = NULL")
    before = builder.snapshot(legacy_db)
    assert before["questions"][0] == 0 and before["categories"][0] == 0 and before["players"][0] == 200
    run_migrations(legacy_db)
    assert builder.snapshot(legacy_db) == before
    assert rows(legacy_db, "SELECT slug, questions_per_game, category_distribution FROM events") == [("api-masters", 12, None)]
    assert scalar(legacy_db, "SELECT count(*) FROM players WHERE event_id = (SELECT id FROM events)") == 200
    assert schema_diff(legacy_db) == []


@postgres_test
def test_legacy_database_created_by_the_old_code_with_defaults_only(empty_db):
    """Just what the old ``init_db()`` leaves behind on first start: settings row + 20 default questions."""
    builder.build_legacy_database(empty_db, with_data=False)
    run_migrations(empty_db)
    assert rows(empty_db, "SELECT slug, questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                          "category_distribution FROM events") == [("api-masters", 15, 20, 100, 0, 50, None)]
    assert scalar(empty_db, "SELECT count(*) FROM questions WHERE event_id = (SELECT id FROM events)") == 20
    # the 20 legacy default questions are named (non TRUE/FALSE) choices
    assert scalar(empty_db, "SELECT count(*) FROM questions WHERE question_format = 'two_choices'") == 20
    assert schema_diff(empty_db) == []


@postgres_test
def test_completely_empty_legacy_tables_create_no_event(empty_db):
    builder.build_legacy_database(empty_db, with_data=False)
    execute(empty_db, "DELETE FROM questions", "DELETE FROM game_settings")
    run_migrations(empty_db)
    assert scalar(empty_db, "SELECT count(*) FROM events") == 0
    assert current_version(empty_db) == HEAD


# ---------------------------------------------------------------------------------------------
# Hand-edited / dirty legacy data must never block the upgrade
# ---------------------------------------------------------------------------------------------
@postgres_test
def test_dirty_legacy_data_does_not_block_the_upgrade(legacy_db, caplog):
    caplog.set_level("WARNING")
    execute(
        legacy_db,
        # out-of-range / NULL rules, JSON null literal, plus a second (ignored) settings row
        "UPDATE game_settings SET questions_per_game = 500, timer_seconds = 1, points_correct = NULL, points_wrong = -5, "
        "time_bonus_max = NULL, category_distribution = 'null'::json",
        "INSERT INTO game_settings (questions_per_game, timer_seconds) VALUES (7, 77)",
        # a question full of NULLs, one out-of-range difficulty, one unknown correct answer
        "INSERT INTO questions (question_text_en, question_text_fr, correct_answer) VALUES ('Nulls?', 'Nuls ?', 'green')",
        "INSERT INTO questions (question_text_en, question_text_fr, correct_answer, difficulty, is_active) VALUES ('Hard?', 'Dur ?', 'green', 9, true)",
        "INSERT INTO questions (question_text_en, question_text_fr, correct_answer, difficulty, is_active) VALUES ('Odd?', 'Bizarre ?', 'maybe', 2, true)",
        "INSERT INTO categories (name) VALUES ('Nameless')",
        "INSERT INTO players (first_name, last_name, email) VALUES ('No', 'Date', 'nodate@example.test')",
        "INSERT INTO game_sessions (player_id, completed_at) SELECT id, now() FROM players WHERE email = 'nodate@example.test'",
        "INSERT INTO game_sessions (player_id) SELECT id FROM players WHERE email = 'nodate@example.test'",
    )
    before = builder.snapshot(legacy_db)
    run_migrations(legacy_db)  # must not raise
    after = builder.snapshot(legacy_db)
    # settings: clamped / defaulted (the lowest-id row is the one used), NULL distribution
    assert rows(legacy_db, "SELECT questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                           "category_distribution FROM events") == [(50, 5, 100, 0, 50, None)]
    assert "outside" in caplog.text
    # NULLs replaced by the old ORM defaults; nothing else touched
    assert rows(legacy_db, "SELECT is_active, difficulty, question_type, green_label_en, green_label_fr, red_label_en, red_label_fr, "
                           "question_format FROM questions WHERE question_text_en = 'Nulls?'") == [
        (True, 1, "text", "Green", "Vert", "Red", "Rouge", "two_choices")]
    assert rows(legacy_db, "SELECT color, is_active, created_at IS NOT NULL FROM categories WHERE name = 'Nameless'") == [("#FC5607", True, True)]
    assert rows(legacy_db, "SELECT status, total_score, correct_answers, started_at IS NOT NULL FROM game_sessions "
                           "WHERE player_id = (SELECT id FROM players WHERE email = 'nodate@example.test') ORDER BY id") == [
        ("completed", 0, 0, True), ("in_progress", 0, 0, True)]
    for table in ("users", "game_answers", "game_settings"):
        assert after[table] == before[table], table
    # impossible values are kept (never rewritten); the CHECKs that they violate are skipped (with a warning),
    # the other ones are created
    assert scalar(legacy_db, "SELECT count(*) FROM questions WHERE difficulty = 9") == 1
    assert scalar(legacy_db, "SELECT count(*) FROM questions WHERE correct_answer = 'maybe'") == 1
    checks = {c[0] for c in schema_signature(legacy_db)["questions"]["checks"]}
    assert checks == {"ck_questions_question_format_valid"}
    assert {c[0] for c in schema_signature(legacy_db)["game_sessions"]["checks"]} == {"ck_game_sessions_status_valid"}
    assert "NOT created" in caplog.text
    assert invalid_constraints(legacy_db) == set()
    assert schema_diff(legacy_db) == []


@postgres_test
def test_clean_legacy_data_gets_fully_validated_constraints(migrated_legacy):
    assert invalid_constraints(migrated_legacy.url) == set()


# ---------------------------------------------------------------------------------------------
# Atomicity, locking, concurrency
# ---------------------------------------------------------------------------------------------
@postgres_test
def test_failed_upgrade_leaves_the_database_untouched(legacy_db, legacy_template):
    """0002 runs in ONE transaction: a failure half way (here: an unrelated, incompatible ``events`` table
    already exists) rolls everything back, including the creation of alembic_version."""
    execute(legacy_db, "CREATE TABLE events (id integer)")
    signature = schema_signature(legacy_db)
    with pytest.raises(Exception, match="slug"):
        run_migrations(legacy_db)
    assert current_version(legacy_db) is None
    assert builder.snapshot(legacy_db) == legacy_template.snapshot
    assert schema_signature(legacy_db) == signature
    assert scalar(legacy_db, "SELECT count(*) FROM information_schema.columns WHERE column_name = 'event_id'") == 0
    # the advisory lock was released: a new attempt can take it immediately
    engine = make_engine(legacy_db)
    try:
        with engine.connect() as conn:
            assert conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": MIGRATION_LOCK_KEY}).scalar() is True
    finally:
        engine.dispose()


@postgres_test
def test_lock_timeout_does_not_touch_the_database(legacy_db, legacy_template):
    holder = psycopg2.connect(builder.psycopg_dsn(legacy_db))
    holder.autocommit = True
    try:
        holder.cursor().execute("SELECT pg_advisory_lock(%s)", (MIGRATION_LOCK_KEY,))
        started = time.monotonic()
        with pytest.raises(TimeoutError, match="migration lock"):
            run_migrations(legacy_db, lock_timeout=1.0)
        assert 1.0 <= time.monotonic() - started < 5.0
    finally:
        holder.close()
    assert current_version(legacy_db) is None
    assert builder.snapshot(legacy_db) == legacy_template.snapshot


CHILD = textwrap.dedent(
    """
    import logging, sys, time
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s", stream=sys.stdout)
    from app.migrate import run_migrations
    time.sleep(max(0.0, float(sys.argv[2]) - time.time()))   # start gate: all processes go at the same instant
    print("CHILD-READY", flush=True)
    run_migrations(sys.argv[1])
    print("CHILD-DONE")
    """
)


def _spawn_migration(url: str, go_at: float) -> subprocess.Popen:
    env = {**os.environ, "PYTHONPATH": str(BACKEND_DIR), "APP_ENV": "test", "DATABASE_URL": "sqlite://"}
    return subprocess.Popen(
        [sys.executable, "-c", CHILD, url, str(go_at)], cwd=BACKEND_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )


@postgres_test
def test_concurrent_processes_are_serialised(legacy_db, legacy_template):
    """Four replicas start at the same instant on the legacy database: exactly one migrates, the others wait
    on the advisory lock and then find the database up to date; one event, no duplicates, no data loss."""
    go_at = time.time() + 4.0
    processes = [_spawn_migration(legacy_db, go_at) for _ in range(4)]
    outputs = []
    for process in processes:
        out, _ = process.communicate(timeout=120)
        outputs.append(out)
        assert process.returncode == 0, out
    assert all("CHILD-DONE" in out for out in outputs)
    assert sum("Running upgrade  -> 0001" in out for out in outputs) == 1, outputs
    assert sum("Database schema is up to date" in out for out in outputs) == 3, outputs
    assert current_version(legacy_db) == HEAD
    assert scalar(legacy_db, "SELECT count(*) FROM events") == 1
    assert builder.snapshot(legacy_db) == legacy_template.snapshot
    assert schema_diff(legacy_db) == []


@postgres_test
def test_a_migration_waits_while_another_instance_holds_the_lock(legacy_db, legacy_template):
    holder = psycopg2.connect(builder.psycopg_dsn(legacy_db))
    holder.autocommit = True
    try:
        holder.cursor().execute("SELECT pg_advisory_lock(%s)", (MIGRATION_LOCK_KEY,))
        process = _spawn_migration(legacy_db, time.time())
        for line in process.stdout:  # wait until the child is loaded and about to migrate
            if "CHILD-READY" in line:
                break
        time.sleep(2.0)  # it is now polling for the lock
        assert process.poll() is None, "the migration must block while the lock is held"
        assert current_version(legacy_db) is None
        assert builder.snapshot(legacy_db) == legacy_template.snapshot
    finally:
        holder.close()  # releases the session-level lock
    out, _ = process.communicate(timeout=60)
    assert process.returncode == 0, out
    assert "Migration lock acquired after waiting" in out
    assert "Legacy schema detected" in out
    assert current_version(legacy_db) == HEAD


# ---------------------------------------------------------------------------------------------
# Downgrade (dev convenience) round trip
# ---------------------------------------------------------------------------------------------
@postgres_test
def test_downgrade_restores_the_legacy_schema_and_data(migrated_legacy, legacy_template):
    url = migrated_legacy.url
    migrated_signature = schema_signature(url)
    command.downgrade(alembic_config(url), "0001")
    assert current_version(url) == "0001"
    assert schema_signature(url) == legacy_template.signature  # names, nullability, FKs without ON DELETE...
    assert builder.snapshot(url) == migrated_legacy.before
    # and back up again
    run_migrations(url)
    assert schema_signature(url) == migrated_signature
    assert builder.snapshot(url) == migrated_legacy.before
    assert schema_diff(url) == []


@postgres_test
def test_downgrade_refuses_when_several_events_exist(migrated_legacy):
    url = migrated_legacy.url
    execute(url, "INSERT INTO events (slug, name, game_title, status, languages, default_language, branding, questions_per_game, "
                 "timer_seconds, points_correct, points_wrong, time_bonus_max, question_order, collect_phone, created_at, updated_at) "
                 "VALUES ('second', 'Second', 'Second', 'draft', '[\"en\"]', 'en', '{}', 10, 20, 100, 0, 50, 'random', 'optional', now(), now())")
    with pytest.raises(Exception, match="Refusing to downgrade"):
        command.downgrade(alembic_config(url), "0001")
    assert current_version(url) == HEAD


# ---------------------------------------------------------------------------------------------
# The legacy fixture really is the old application (guards the vendored copy)
# ---------------------------------------------------------------------------------------------
def test_vendored_legacy_code_matches_git_history(tmp_path):
    git = shutil.which("git")
    if not git:
        pytest.skip("git not available")
    try:
        extracted = builder.extract_legacy_from_git(tmp_path)
    except subprocess.CalledProcessError:
        pytest.skip(f"commit {builder.LEGACY_GIT_REF} not available (shallow clone?)")
    for name in ("models", "database", "config"):
        vendored = (builder.LEGACY_APP_DIR / "app" / f"{name}.py").read_text().splitlines()[4:]
        original = (extracted / "app" / f"{name}.py").read_text().splitlines()
        assert vendored == original, f"tests/legacy/legacy_app/app/{name}.py drifted from the legacy code"


@postgres_test
def test_git_extracted_legacy_code_builds_the_same_schema(legacy_template):
    """Reproduce the production schema from git (``git archive`` of the legacy commit), not the vendored copy."""
    try:
        name = create_database()
        url = url_for(name)
        builder.init_legacy_schema(url, source="git")
        assert schema_signature(url) == legacy_template.signature
    except subprocess.CalledProcessError:
        pytest.skip(f"commit {builder.LEGACY_GIT_REF} not available (shallow clone?)")
    finally:
        drop_database(name)


# ---------------------------------------------------------------------------------------------
# Optional: a REAL production dump
# ---------------------------------------------------------------------------------------------
def _restore_dump(url: str, dump: Path) -> None:
    parts = make_url(url)
    if shutil.which("pg_restore"):
        env = {**os.environ, "PGPASSWORD": parts.password or ""}
        subprocess.run(["pg_restore", "--no-owner", "-h", parts.host, "-p", str(parts.port), "-U", parts.username,
                        "-d", parts.database, str(dump)], check=True, env=env, capture_output=True)
        return
    container = os.environ.get("TEST_PG_CONTAINER", "quiz-test-pg")  # no host client: use the one in the container
    subprocess.run(["docker", "cp", str(dump), f"{container}:/tmp/prod.dump"], check=True, capture_output=True)
    subprocess.run(
        ["docker", "exec", "-e", f"PGPASSWORD={parts.password}", container, "pg_restore", "--no-owner", "-h", "localhost",
         "-U", parts.username, "-d", parts.database, "/tmp/prod.dump"],
        check=True, capture_output=True,
    )


@postgres_test
@pytest.mark.skipif(not os.environ.get("TEST_PROD_DUMP"), reason="TEST_PROD_DUMP (custom-format pg_dump) is not set")
def test_real_production_dump_migrates_cleanly(orm_reference_signature):
    dump = Path(os.environ["TEST_PROD_DUMP"])
    name = create_database()
    url = url_for(name)
    try:
        _restore_dump(url, dump)
        before = builder.snapshot(url)
        started = time.perf_counter()
        run_migrations(url)
        elapsed = time.perf_counter() - started
        assert builder.snapshot(url) == before
        assert current_version(url) == HEAD
        assert scalar(url, "SELECT count(*) FROM events") == 1
        legacy = rows(url, "SELECT questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                           "category_distribution::text FROM game_settings ORDER BY id LIMIT 1")
        assert rows(url, "SELECT questions_per_game, timer_seconds, points_correct, points_wrong, time_bonus_max, "
                         "category_distribution::text FROM events") == legacy
        for table in ("categories", "questions", "players", "game_sessions"):
            assert scalar(url, f"SELECT count(*) FROM {table} WHERE event_id IS DISTINCT FROM (SELECT id FROM events)") == 0
        assert invalid_constraints(url) == set()
        assert schema_diff(url) == []
        assert schema_signature(url) == orm_reference_signature
        print(f"\n[production dump] {({t: c[0] if isinstance(c, tuple) else c for t, c in before.items()})} migrated in {elapsed:.3f}s")
    finally:
        drop_database(name)
