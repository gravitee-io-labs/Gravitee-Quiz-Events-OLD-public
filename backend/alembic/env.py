"""Alembic environment (PostgreSQL only; online mode only).

Used both by ``app.migrate.run_migrations`` (programmatic, at application start-up, which injects the
URL in ``sqlalchemy.url`` and disables logging re-configuration) and by the ``alembic`` CLI.

All pending revisions run in ONE transaction (PostgreSQL has transactional DDL): a failure leaves the
database exactly as it was.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from alembic import context

# Make ``import app`` work when the CLI is started from another directory.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.migrate import include_object  # noqa: E402
from app.models import Base  # noqa: E402

config = context.config

# The application configures its own logging; only the CLI lets alembic.ini do it.
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    url = config.get_main_option("sqlalchemy.url") or os.environ.get("DATABASE_URL")
    if not url:
        from app.config import settings

        url = settings.DATABASE_URL
    return url


def run_migrations_offline() -> None:
    raise RuntimeError(
        "Offline (--sql) mode is not supported: the migrations inspect the live database "
        "(legacy schema detection, constraint discovery) and run data backfills."
    )


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), poolclass=NullPool)
    try:
        with engine.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                include_object=include_object,
                compare_type=True,
                transaction_per_migration=False,  # one transaction for the whole upgrade
            )
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
