"""
Database engine, session factory and startup initialisation.

* PostgreSQL in production (pooled, ``pool_pre_ping``); SQLite is supported for tests / quick local
  runs (in-memory URLs use a StaticPool and every connection enables ``PRAGMA foreign_keys=ON`` so
  ON DELETE CASCADE behaves like PostgreSQL).
* ``Base`` lives in ``app.models`` (it carries the constraint naming convention) and is re-exported
  here for convenience: ``from app.database import Base, get_db``.
"""
import logging
import time

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.models import Base

logger = logging.getLogger(__name__)

__all__ = ["Base", "SessionLocal", "engine", "get_db", "init_db", "make_engine", "wait_for_db"]


def make_engine(url: str) -> Engine:
    """Build an engine for ``url`` with sensible defaults per backend."""
    kwargs: dict = {"pool_pre_ping": True, "echo": False}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if url in ("sqlite://", "sqlite:///", "sqlite:///:memory:") or ":memory:" in url:
            kwargs["poolclass"] = StaticPool  # one shared connection => one shared in-memory DB
    else:
        kwargs.update(
            pool_size=settings.DB_POOL_SIZE,
            max_overflow=settings.DB_MAX_OVERFLOW,
            pool_timeout=settings.DB_POOL_TIMEOUT,
            pool_recycle=settings.DB_POOL_RECYCLE,
        )
    eng = create_engine(url, **kwargs)

    if eng.dialect.name == "sqlite":

        @event.listens_for(eng, "connect")
        def _sqlite_fk_pragma(dbapi_connection, _record):  # pragma: no cover - trivial
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return eng


engine = make_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)


def get_db():
    """FastAPI dependency: one session per request, always closed (rolled back on error)."""
    db: Session = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def wait_for_db(max_wait_seconds: float = 30.0, interval: float = 1.0) -> None:
    """Block until the database answers ``SELECT 1`` (the DB container may start after the API)."""
    deadline = time.monotonic() + max_wait_seconds
    attempt = 0
    while True:
        attempt += 1
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except OperationalError as exc:
            if time.monotonic() >= deadline:
                logger.error("Database still unreachable after %.0fs", max_wait_seconds)
                raise
            logger.warning("Database not ready (attempt %d): %s", attempt, str(exc).splitlines()[0])
            time.sleep(interval)


def init_db() -> None:
    """Prepare the schema, then seed an empty database.

    * ``USE_ALEMBIC`` (default): run the Alembic migrations (``app.migrate.run_migrations``).
    * otherwise (tests): ``Base.metadata.create_all``.
    * then ``app.seed.seed_if_empty()`` unless ``SEED_ON_STARTUP`` is false.
    """
    if engine.dialect.name != "sqlite":
        wait_for_db()

    if settings.USE_ALEMBIC:
        from app.migrate import run_migrations

        logger.info("Running database migrations...")
        run_migrations()
    else:
        logger.info("Creating database tables with create_all (USE_ALEMBIC=false)...")
        Base.metadata.create_all(bind=engine)

    if settings.SEED_ON_STARTUP:
        from app.seed import seed_if_empty

        seed_if_empty()
    logger.info("Database ready")
