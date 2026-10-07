"""
Database migrations, run programmatically at application start-up.

``run_migrations()`` performs ``alembic upgrade head`` while holding a PostgreSQL *session level*
advisory lock, so several replicas (or a rolling restart) starting together are serialised: the first
one migrates, the others wait and then find the database already at ``head``.

* PostgreSQL only. For SQLite (tests, quick local runs) it is a no-op: those use ``create_all``.
* Any failure is logged and re-raised: the application must NOT start on a half-migrated database
  (the whole upgrade is one transaction, so a failure also leaves the database untouched).
* Safe to call any number of times.

Revisions (backend/alembic/versions):
    0001  baseline  - creates the legacy schema if absent (fresh DB), otherwise leaves it alone
    0002  events    - multi-event data model + backfill of existing data (see docs/ARCHITECTURE.md §3)
"""
from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.pool import NullPool

from alembic import command
from app.config import settings

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[1]
ALEMBIC_INI = BACKEND_DIR / "alembic.ini"
ALEMBIC_DIR = BACKEND_DIR / "alembic"

# Arbitrary but stable bigint identifying "the quiz schema migration" in pg_advisory_lock().
MIGRATION_LOCK_KEY = int.from_bytes(hashlib.sha256(b"gravitee-quiz-events:alembic").digest()[:8], "big", signed=True)
DEFAULT_LOCK_TIMEOUT_SECONDS = 300.0
LOCK_POLL_SECONDS = 0.5
LOCK_LOG_EVERY_SECONDS = 5.0

# Tables that exist in legacy databases but are no longer modelled: Alembic must leave them alone
# (``game_settings`` is kept as-is, unused, after the migration to events).
UNMANAGED_TABLES = frozenset({"game_settings"})


def include_object(obj, name, type_, reflected, compare_to) -> bool:
    """Alembic ``include_object`` hook shared by env.py and the tests: ignore unmanaged legacy tables."""
    if type_ == "table" and name in UNMANAGED_TABLES:
        return False
    table = getattr(obj, "table", None)
    if table is not None and getattr(table, "name", None) in UNMANAGED_TABLES:
        return False
    return True


def alembic_config(database_url: str) -> Config:
    """Alembic ``Config`` for ``database_url`` (location of alembic.ini is resolved from this package)."""
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_DIR))
    # ConfigParser interpolation: a literal "%" (e.g. URL-encoded password) must be doubled.
    cfg.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    cfg.attributes["configure_logger"] = False  # keep the application's logging configuration
    return cfg


def _make_engine(url: str) -> Engine:
    return create_engine(url, poolclass=NullPool, pool_pre_ping=True)


@contextmanager
def migration_lock(engine: Engine, timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS) -> Iterator[None]:
    """Hold the session-level advisory lock for the duration of the block.

    The lock lives on a dedicated autocommit connection that stays open while the migration runs on
    its own connection; if this process dies the server releases the lock automatically.
    Polls ``pg_try_advisory_lock`` so that waiting is visible in the logs and bounded by ``timeout``.
    """
    conn = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
    acquired = False
    try:
        started = time.monotonic()
        next_log = started + LOCK_LOG_EVERY_SECONDS
        while True:
            acquired = bool(conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": MIGRATION_LOCK_KEY}).scalar())
            if acquired:
                break
            now = time.monotonic()
            if now - started >= timeout:
                raise TimeoutError(
                    f"Could not acquire the migration lock within {timeout:.0f}s: another instance is "
                    "still migrating the database (or crashed while holding the lock)"
                )
            if now >= next_log:
                logger.info("Waiting for another instance to finish migrating the database (%.0fs)...", now - started)
                next_log = now + LOCK_LOG_EVERY_SECONDS
            time.sleep(LOCK_POLL_SECONDS)
        waited = time.monotonic() - started
        logger.info("Migration lock acquired%s", f" after waiting {waited:.1f}s" if waited >= 0.5 else "")
        yield
    finally:
        try:
            if acquired:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": MIGRATION_LOCK_KEY})
                logger.info("Migration lock released")
        finally:
            conn.close()  # closing the session also releases the lock if the explicit unlock failed


def current_revision(engine: Engine) -> str | None:
    """Revision stored in ``alembic_version`` (None: no such table / empty = legacy or fresh database)."""
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def _has_legacy_schema(engine: Engine) -> bool:
    with engine.connect() as conn:
        return inspect(conn).has_table("questions")


def head_revision(cfg: Config) -> str | None:
    return ScriptDirectory.from_config(cfg).get_current_head()


def run_migrations(database_url: str | None = None, *, lock_timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS) -> None:
    """Bring the database to ``head`` (no-op on SQLite). Raises on any failure.

    ``database_url`` defaults to ``settings.DATABASE_URL``.
    """
    url = database_url or settings.DATABASE_URL
    backend = make_url(url).get_backend_name()
    if backend == "sqlite":
        logger.info("SQLite database: migrations skipped (schema is created with create_all)")
        return
    if backend != "postgresql":
        logger.warning("Unsupported database backend %r: migrations skipped", backend)
        return

    cfg = alembic_config(url)
    engine = _make_engine(url)
    started = time.monotonic()
    try:
        with migration_lock(engine, lock_timeout):
            head = head_revision(cfg)
            before = current_revision(engine)
            logger.info("Database revision: %s, target: %s", before or "none", head)
            if before is None:
                if _has_legacy_schema(engine):
                    logger.info(
                        "Legacy schema detected (tables without alembic_version): baselining it "
                        "(0001 touches nothing) then upgrading, existing data is preserved"
                    )
                else:
                    logger.info("Empty database: creating the schema from scratch")
            if before == head:
                logger.info("Database schema is up to date")
                return
            command.upgrade(cfg, "head")
            after = current_revision(engine)
            if after != head:
                raise RuntimeError(f"Migration finished but the database is at {after!r}, expected {head!r}")
            logger.info("Database migrated %s -> %s in %.2fs", before or "(none)", after, time.monotonic() - started)
    except Exception:
        logger.exception("Database migration FAILED: the application must not start on this database")
        raise
    finally:
        engine.dispose()
