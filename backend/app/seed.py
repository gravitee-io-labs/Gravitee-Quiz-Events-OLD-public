"""
Seeding of an EMPTY database from event bundles (docs/ARCHITECTURE.md sections 3 and 6).

``seed_if_empty()`` is called at startup (``app.database.init_db``):

* the database already holds at least one event  -> does nothing (never touches existing data);
* otherwise every bundle named in the ``SEED_EVENTS`` environment variable (comma separated, default
  ``api-masters``) is imported from ``settings.resolve_seed_dir()`` (``SEED_DIR``, default
  ``/app/seed/events``, falling back to ``<repo>/events``). ``NAME`` maps to ``NAME.json``.
* a missing / unreadable / invalid bundle is logged and skipped: seeding never crashes the startup;
* idempotent and safe when several replicas start at once: the unique slug makes the loser's import a
  no-op (``import_bundle`` turns the unique violation into ``SlugConflictError``: logged at INFO, never
  a warning or an error).

Existing deployments are migrated by Alembic (which creates the ``api-masters`` event), so they are
never "empty": add further events there with the admin API / console (import a bundle).
"""
import json
import logging
import os
import re
from pathlib import Path
from typing import Optional

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Event
from app.services.bundle import SlugConflictError, import_bundle

logger = logging.getLogger(__name__)

DEFAULT_SEED_EVENTS = "api-masters"
SEED_EVENTS_ENV = "SEED_EVENTS"
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def seed_event_names() -> list[str]:
    """Bundle names from ``SEED_EVENTS`` (default ``api-masters``), de-duplicated, order kept."""
    raw = os.environ.get(SEED_EVENTS_ENV)
    if raw is None:
        raw = DEFAULT_SEED_EVENTS
    names: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if name.lower().endswith(".json"):
            name = name[: -len(".json")]
        if name and name not in names:
            names.append(name)
    return names


def _load_bundle(path: Path) -> Optional[dict]:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        logger.warning("Seed bundle %s not found, skipping", path)
        return None
    except (OSError, ValueError) as exc:  # unreadable file or invalid JSON
        logger.error("Seed bundle %s cannot be read (%s), skipping", path, exc)
        return None
    if not isinstance(data, dict):
        logger.error("Seed bundle %s is not a JSON object, skipping", path)
        return None
    return data


def seed_if_empty(db: Optional[Session] = None) -> list[str]:
    """Import the configured bundles when the database has no event at all.

    Returns the slugs that were created (empty when nothing was done). ``db`` is optional: without it
    a session is opened (and closed) here.
    """
    if db is None:
        from app.database import SessionLocal

        with SessionLocal() as session:
            return seed_if_empty(session)

    if (db.scalar(select(func.count(Event.id))) or 0) > 0:
        logger.info("Database already has events, seeding skipped")
        return []

    names = seed_event_names()
    if not names:
        logger.info("%s is empty, nothing to seed", SEED_EVENTS_ENV)
        return []

    seed_dir = settings.resolve_seed_dir()
    created: list[str] = []
    conflicts = 0
    for name in names:
        if not _NAME_RE.match(name):
            logger.warning("Ignoring invalid seed name %r in %s", name, SEED_EVENTS_ENV)
            continue
        data = _load_bundle(seed_dir / f"{name}.json")
        if data is None:
            continue
        try:
            event = import_bundle(db, data)
        except SlugConflictError as exc:  # another replica seeded it between our check and our INSERT
            conflicts += 1
            logger.info("Seed bundle '%s' skipped: %s", name, exc)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in exc.errors()[:5]
            )
            logger.error("Seed bundle '%s' is invalid (%d errors), skipping: %s", name, exc.error_count(), problems)
        except Exception:
            logger.exception("Seed bundle '%s' failed, skipping", name)
        else:
            created.append(event.slug)
            logger.info("Seeded event '%s' from %s.json", event.slug, name)
    if not created and not conflicts:  # a lost race is not a problem: the event exists
        logger.warning("The database is empty and no event could be seeded from %s", seed_dir)
    return created
