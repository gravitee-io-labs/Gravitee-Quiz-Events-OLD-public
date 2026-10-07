"""
Concurrent creation of events with the same slug must answer 409, never 500 (PostgreSQL).

The pre-check ``ensure_slug_available`` cannot close the race (two requests both see "free", then both
INSERT): the unique index is the real guard, and its violation has to come out as the very same
``409 {"detail": "An event with the slug '...' already exists"}`` in EVERY path: create, update-slug,
duplicate, import and the startup seed.

Needs a real PostgreSQL (SQLite serialises writers, so the race does not exist there)::

    docker run -d --name quiz-test-pg -e POSTGRES_USER=quiz_user -e POSTGRES_PASSWORD=quiz_password \\
        -e POSTGRES_DB=gravitee_quiz -p 127.0.0.1:55432:5432 postgres:15-alpine
    TEST_POSTGRES_URL=postgresql://quiz_user:quiz_password@127.0.0.1:55432/gravitee_quiz \\
        .venv/bin/python -m pytest tests/test_slug_race.py -m postgres

Each test gets its own throw-away database (dropped afterwards) and fires real threads through the real ASGI
app (one ``TestClient`` per thread). Every scenario runs twice:

* ``gated``: the slug pre-check is held back until ALL requests have performed it, so every request is
  certain to see the slug as free and to reach the INSERT: the race is deterministic;
* ``natural``: no help, plain parallel requests (whatever interleaving the scheduler produces).
"""
import json
import logging
import os
import shutil
import threading
import uuid
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app import seed
from app.config import settings
from app.database import Base, get_db
from app.main import app
from app.models import Category, Event, Question
from app.seed import seed_if_empty
from app.services import bundle as bundle_service

POSTGRES_URL = os.environ.get("TEST_POSTGRES_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not POSTGRES_URL, reason="TEST_POSTGRES_URL is not set"),
]

PARALLEL = 8
CONFLICT = "An event with the slug 'contested' already exists"
FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------------------------
# A throw-away PostgreSQL database wired into the app
# ---------------------------------------------------------------------------------------------
def _admin_engine():
    return create_engine(make_url(POSTGRES_URL).set(database="postgres"), isolation_level="AUTOCOMMIT", poolclass=NullPool)


@pytest.fixture
def pg():
    name = f"qs_{uuid.uuid4().hex[:10]}"
    admin = _admin_engine()
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(
        make_url(POSTGRES_URL).set(database=name), pool_size=PARALLEL * 3, max_overflow=0, pool_timeout=30
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        session = factory()
        try:
            yield session
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield SimpleNamespace(engine=engine, factory=factory)
    finally:
        app.dependency_overrides.pop(get_db, None)
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


@pytest.fixture
def admin_token():
    response = TestClient(app).post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture(params=["gated", "natural"])
def race(request, monkeypatch):
    """``race(n, work)`` runs ``work(i)`` in ``n`` threads released together and returns the results.

    ``gated``: the first ``n`` slug pre-checks (one per request) wait for each other, so no request can
    proceed to its INSERT before all of them have been told "the slug is free"."""
    mode = request.param

    def run(parties, work):
        if mode == "gated":
            real = bundle_service.slug_taken
            barrier = threading.Barrier(parties, timeout=20)
            lock = threading.Lock()
            calls = [0]

            def gated(db, slug, exclude_id=None):
                taken = real(db, slug, exclude_id)
                with lock:
                    calls[0] += 1
                    held = calls[0] <= parties
                if held:
                    barrier.wait()
                return taken

            monkeypatch.setattr(bundle_service, "slug_taken", gated)

        start = threading.Barrier(parties, timeout=20)
        results: list = [None] * parties

        def worker(i):
            try:
                start.wait()
                results[i] = work(i)
            except BaseException as exc:  # noqa: BLE001 - reported by the assertions below
                results[i] = exc

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(parties)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        assert all(not t.is_alive() for t in threads), "a request is stuck"
        return results

    return run


def call(method, path, headers, **kwargs):
    """One HTTP call from the current thread, through its own client (``raise_server_exceptions=False``:
    a bug must show up as a 500 in the assertions, not as an exception in the thread). The client is not
    used as a context manager: that would run the app lifespan (``init_db`` on the default SQLite engine)."""
    return TestClient(app, raise_server_exceptions=False).request(method, path, headers=headers, **kwargs)


def assert_one_winner(responses, winner_status=201):
    assert all(not isinstance(r, BaseException) for r in responses), responses
    statuses = Counter(r.status_code for r in responses)
    assert statuses == {winner_status: 1, 409: PARALLEL - 1}, [(r.status_code, r.text[:200]) for r in responses]
    for r in responses:
        if r.status_code == 409:
            assert r.json() == {"detail": CONFLICT}


def count(pg, model, *where):
    with pg.factory() as session:
        return session.scalar(select(func.count()).select_from(model).where(*where))


# ---------------------------------------------------------------------------------------------
# Admin API
# ---------------------------------------------------------------------------------------------
def test_parallel_creates_with_the_same_slug_give_one_201_and_409s(pg, admin_token, race):
    body = {"slug": "contested", "name": "Contested", "game_title": "API Masters"}
    responses = race(PARALLEL, lambda i: call("POST", "/api/admin/events", admin_token, json=body))
    assert_one_winner(responses)
    assert count(pg, Event) == 1


def test_parallel_renames_to_the_same_slug_give_one_200_and_409s(pg, admin_token, race):
    with pg.factory() as session:
        session.add_all(Event(slug=f"event-{i}", name=f"Event {i}", game_title="Quiz") for i in range(PARALLEL))
        session.commit()
        ids = list(session.scalars(select(Event.id).order_by(Event.id)))

    responses = race(
        PARALLEL, lambda i: call("PUT", f"/api/admin/events/{ids[i]}", admin_token, json={"slug": "contested"})
    )
    assert_one_winner(responses, winner_status=200)
    assert count(pg, Event, Event.slug == "contested") == 1
    # the losers keep their old slug (nothing half applied)
    assert count(pg, Event, Event.slug.like("event-%")) == PARALLEL - 1


def test_parallel_duplicates_with_the_same_slug_give_one_201_and_409s(pg, admin_token, race, sample_bundle):
    with pg.factory() as session:
        source = bundle_service.import_bundle(session, sample_bundle())
        source_id = source.id
    body = {"slug": "contested", "name": "Copy"}
    responses = race(
        PARALLEL, lambda i: call("POST", f"/api/admin/events/{source_id}/duplicate", admin_token, json=body)
    )
    assert_one_winner(responses)
    assert count(pg, Event) == 2
    # exactly one complete copy: no orphan categories / questions from the losers
    assert count(pg, Category) == 2 * 2
    assert count(pg, Question) == 2 * 4


def test_parallel_imports_with_the_same_slug_give_one_201_and_409s(pg, admin_token, race, sample_bundle):
    request = {"bundle": sample_bundle(), "slug": "contested"}
    responses = race(PARALLEL, lambda i: call("POST", "/api/admin/events/import", admin_token, json=request))
    assert_one_winner(responses)
    assert count(pg, Event) == 1
    assert count(pg, Category) == 2 and count(pg, Question) == 4  # one complete event, nothing left by the losers


def test_a_lost_race_is_a_409_through_the_service_layer_too(pg, sample_bundle, monkeypatch):
    """The services raise ``SlugConflictError`` (not a raw ``IntegrityError``), whatever the caller is."""
    monkeypatch.setattr(bundle_service, "ensure_slug_available", lambda *a, **k: None)  # blind pre-check
    with pg.factory() as session:
        bundle_service.import_bundle(session, sample_bundle(), {"slug": "contested"})
    with pg.factory() as session, pytest.raises(bundle_service.SlugConflictError):
        bundle_service.import_bundle(session, sample_bundle(), {"slug": "contested"})
    with pg.factory() as session:
        source = session.scalar(select(Event))
        with pytest.raises(bundle_service.SlugConflictError):
            bundle_service.duplicate_event(session, source, {"slug": "contested", "name": "Copy"})
    assert count(pg, Event) == 1 and count(pg, Category) == 2 and count(pg, Question) == 4


# ---------------------------------------------------------------------------------------------
# Startup seed (several replicas booting on an empty database)
# ---------------------------------------------------------------------------------------------
def test_replicas_seeding_an_empty_database_together_create_one_event_and_log_no_error(
    pg, race, tmp_path, monkeypatch, caplog
):
    shutil.copy(FIXTURES / "seed_alpha.json", tmp_path / "api-masters.json")
    monkeypatch.setattr(settings, "SEED_DIR", str(tmp_path))
    monkeypatch.delenv("SEED_EVENTS", raising=False)
    expected = json.loads((tmp_path / "api-masters.json").read_text(encoding="utf-8"))

    def boot(_i):
        with pg.factory() as session:
            return seed_if_empty(session)

    with caplog.at_level(logging.INFO, logger=seed.logger.name):
        results = race(PARALLEL, boot)

    assert all(not isinstance(r, BaseException) for r in results), results
    assert sorted(slug for created in results for slug in created) == [expected["event"]["slug"]]
    assert [r.levelname for r in caplog.records if r.levelno >= logging.WARNING] == []  # a lost race is not an error
    assert count(pg, Event) == 1
    assert count(pg, Category) == len(expected["categories"]) and count(pg, Question) == len(expected["questions"])
