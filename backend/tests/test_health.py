import inspect

from fastapi.routing import APIRoute
from sqlalchemy.exc import OperationalError

from app.database import get_db
from app.main import app


def test_health_ok(client):
    for path in ("/health", "/api/health"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "db": "ok"}


def test_health_reports_database_failure(client):
    class BrokenSession:
        def execute(self, *_args, **_kwargs):
            raise OperationalError("SELECT 1", {}, Exception("db down"))

        def close(self):
            pass

        def rollback(self):
            pass

    def broken_db():
        yield BrokenSession()

    client.app.dependency_overrides[get_db] = broken_db
    for path in ("/health", "/api/health"):
        response = client.get(path)
        assert response.status_code == 503
        assert response.json() == {"status": "error", "db": "error"}


class _DatabaseDown:
    def execute(self, *_args, **_kwargs):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    def close(self):
        pass

    def rollback(self):
        pass


def test_livez_is_always_ok(client):
    for path in ("/livez", "/api/livez"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


def test_livez_does_not_depend_on_the_database(client):
    """Liveness must stay green while PostgreSQL is down (readiness, /health, is what goes red)."""

    def broken_db():
        yield _DatabaseDown()

    client.app.dependency_overrides[get_db] = broken_db
    for path in ("/livez", "/api/livez"):
        assert client.get(path).json() == {"status": "ok"}
    assert client.get("/health").status_code == 503  # readiness does notice


def test_livez_has_no_dependency_and_runs_on_the_event_loop():
    """No ``get_db`` (or any dependency) and ``async def``: it must not need a free threadpool slot or a
    pooled connection, so a saturated pool or threadpool can never get the pod killed by its probe."""
    routes = {r.path: r for r in app.routes if isinstance(r, APIRoute) and r.path in ("/livez", "/api/livez")}
    assert set(routes) == {"/livez", "/api/livez"}
    for route in routes.values():
        assert route.dependant.dependencies == []
        assert inspect.iscoroutinefunction(route.endpoint)


def test_livez_is_logged_quietly_like_the_other_probes(client, caplog):
    import logging

    with caplog.at_level(logging.INFO, logger="app.access"):
        client.get("/livez")
        client.get("/api/livez")
    assert [r for r in caplog.records if "livez" in r.getMessage()] == []
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="app.access"):  # the access line exists, just at DEBUG
        client.get("/livez")
    assert [r.levelno for r in caplog.records if "livez" in r.getMessage()] == [logging.DEBUG]


def test_root_and_request_id(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["version"] == "2.0.0"
    assert len(response.headers["x-request-id"]) >= 8


def test_request_id_is_echoed_when_valid_and_replaced_when_not(client):
    ok = client.get("/health", headers={"X-Request-ID": "abc-123.DEF"})
    assert ok.headers["x-request-id"] == "abc-123.DEF"
    bad = client.get("/health", headers={"X-Request-ID": "bad id with spaces!"})
    assert bad.headers["x-request-id"] != "bad id with spaces!"
    assert len(bad.headers["x-request-id"]) == 16
