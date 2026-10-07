import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import inspect

from app import database
from app.config import DEFAULT_SECRET_KEY, Settings
from app.main import app
from app.routers import health

BACKEND_DIR = Path(__file__).resolve().parents[1]
STRONG_KEY = "k" * 40


@pytest.fixture(autouse=True)
def _clean_settings_env(monkeypatch):
    """Settings() must see defaults, not the values conftest exported for the app under test."""
    for name in Settings.model_fields:
        monkeypatch.delenv(name, raising=False)


def prod(**overrides):
    values = {"APP_ENV": "production", "SECRET_KEY": STRONG_KEY, "ADMIN_PASSWORD": "a-long-random-password"}
    values.update(overrides)
    return Settings(_env_file=None, **values)


# ---------------------------------------------------------------------------------------------
# production guard
# ---------------------------------------------------------------------------------------------
def test_production_with_strong_secrets_is_accepted():
    prod().assert_production_ready()


@pytest.mark.parametrize(
    "overrides,fragment",
    [
        ({"SECRET_KEY": DEFAULT_SECRET_KEY}, "SECRET_KEY"),
        ({"SECRET_KEY": "short"}, "SECRET_KEY"),
        ({"SECRET_KEY": "k" * 31}, "SECRET_KEY"),
        ({"ADMIN_PASSWORD": "admin"}, "ADMIN_PASSWORD"),
        ({"ADMIN_PASSWORD": ""}, "ADMIN_PASSWORD"),
        ({"ADMIN_USERNAME": ""}, "ADMIN_USERNAME"),
    ],
)
def test_production_refuses_weak_settings(overrides, fragment):
    with pytest.raises(RuntimeError, match=fragment):
        prod(**overrides).assert_production_ready()


def test_production_guard_reports_every_problem():
    with pytest.raises(RuntimeError) as exc:
        Settings(_env_file=None, APP_ENV="production").assert_production_ready()
    assert "SECRET_KEY" in str(exc.value) and "ADMIN_PASSWORD" in str(exc.value)


@pytest.mark.parametrize("env", ["dev", "test"])
def test_non_production_accepts_defaults(env):
    Settings(_env_file=None, APP_ENV=env).assert_production_ready()


def test_app_env_is_validated_and_case_insensitive():
    assert Settings(_env_file=None, APP_ENV="Production").APP_ENV == "production"
    with pytest.raises(ValidationError):
        Settings(_env_file=None, APP_ENV="prod")


def test_startup_refuses_to_run_in_production_with_default_credentials(monkeypatch, app_settings):
    monkeypatch.setattr(app_settings, "APP_ENV", "production")
    monkeypatch.setattr(app_settings, "SECRET_KEY", DEFAULT_SECRET_KEY)
    with pytest.raises(RuntimeError, match="Refusing to start"):
        with TestClient(app):
            pass  # pragma: no cover


def test_startup_succeeds_in_production_with_strong_credentials(monkeypatch, app_settings):
    monkeypatch.setattr(app_settings, "APP_ENV", "production")
    monkeypatch.setattr(app_settings, "ADMIN_PASSWORD", "a-long-random-password")
    monkeypatch.setattr(app_settings, "SECRET_KEY", STRONG_KEY)
    with TestClient(app) as http:
        assert http.get("/health").status_code == 200


# ---------------------------------------------------------------------------------------------
# misc settings
# ---------------------------------------------------------------------------------------------
def test_cors_origins_parsing():
    assert Settings(_env_file=None, CORS_ORIGINS="http://a.test, http://b.test").CORS_ORIGINS == ["http://a.test", "http://b.test"]
    assert Settings(_env_file=None, CORS_ORIGINS='["http://a.test"]').CORS_ORIGINS == ["http://a.test"]


def test_cors_origins_from_environment(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://quiz.events.gravitee.io,http://localhost:8080")
    assert Settings(_env_file=None).CORS_ORIGINS == ["https://quiz.events.gravitee.io", "http://localhost:8080"]


@pytest.mark.parametrize("raw,expected", [("", ""), ("/", ""), ("quiz", "/quiz"), ("/quiz/", "/quiz"), (" /a/b ", "/a/b")])
def test_base_path_is_normalised(raw, expected):
    assert Settings(_env_file=None, BASE_PATH=raw).BASE_PATH == expected


def test_old_game_default_env_vars_are_gone_and_ignored(monkeypatch):
    monkeypatch.setenv("DEFAULT_QUESTIONS_PER_GAME", "99")
    s = Settings(_env_file=None)
    assert not hasattr(s, "DEFAULT_QUESTIONS_PER_GAME")


def test_seed_dir_resolution(tmp_path):
    assert Settings(_env_file=None, SEED_DIR=str(tmp_path)).resolve_seed_dir() == tmp_path
    fallback = Settings(_env_file=None, SEED_DIR="/definitely/not/here").resolve_seed_dir()
    assert fallback == BACKEND_DIR.parent / "events"


def test_throttle_and_misc_defaults():
    s = Settings(_env_file=None)
    assert (s.LOGIN_MAX_FAILURES, s.LOGIN_WINDOW_SECONDS, s.ENABLE_DOCS, s.USE_ALEMBIC, s.ALGORITHM) == (10, 300, True, True, "HS256")
    assert s.SEED_DIR == "/app/seed/events"


# ---------------------------------------------------------------------------------------------
# init_db
# ---------------------------------------------------------------------------------------------
def test_init_db_uses_alembic_when_enabled_then_seeds(monkeypatch, app_settings):
    calls = []
    monkeypatch.setattr(app_settings, "USE_ALEMBIC", True)
    monkeypatch.setattr(app_settings, "SEED_ON_STARTUP", True)
    monkeypatch.setattr("app.migrate.run_migrations", lambda: calls.append("migrate"))
    monkeypatch.setattr("app.seed.seed_if_empty", lambda: calls.append("seed"))
    database.init_db()
    assert calls == ["migrate", "seed"]


def test_init_db_without_alembic_uses_create_all(monkeypatch, app_settings):
    calls = []
    monkeypatch.setattr(app_settings, "USE_ALEMBIC", False)
    monkeypatch.setattr(app_settings, "SEED_ON_STARTUP", True)
    monkeypatch.setattr("app.migrate.run_migrations", lambda: calls.append("migrate"))
    monkeypatch.setattr("app.seed.seed_if_empty", lambda: calls.append("seed"))
    database.Base.metadata.drop_all(bind=database.engine)
    database.init_db()
    assert calls == ["seed"]
    assert "events" in inspect(database.engine).get_table_names()


def test_init_db_can_skip_seeding(monkeypatch, app_settings):
    calls = []
    monkeypatch.setattr(app_settings, "USE_ALEMBIC", False)
    monkeypatch.setattr(app_settings, "SEED_ON_STARTUP", False)
    monkeypatch.setattr("app.seed.seed_if_empty", lambda: calls.append("seed"))
    database.init_db()
    assert calls == []


def test_make_engine_sqlite_memory_enforces_foreign_keys():
    eng = database.make_engine("sqlite://")
    with eng.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1


# ---------------------------------------------------------------------------------------------
# app wiring
# ---------------------------------------------------------------------------------------------
def test_openapi_and_docs_are_served(client):
    spec = client.get("/api/openapi.json").json()
    assert spec["info"]["title"] == "Gravitee Quiz Events API" and spec["info"]["version"] == "2.0.0"
    assert "/api/auth/login" in spec["paths"] and "/api/health" in spec["paths"]
    assert client.get("/api/docs").status_code == 200
    assert client.get("/docs").status_code == 404 and client.get("/openapi.json").status_code == 404


def test_docs_can_be_disabled():
    code = (
        "from app.main import app; "
        "assert app.docs_url is None and app.openapi_url is None and app.redoc_url is None; print('ok')"
    )
    env = {**os.environ, "ENABLE_DOCS": "false"}
    result = subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0 and "ok" in result.stdout, result.stderr


def test_base_path_sets_root_path():
    code = "from app.main import app; print(app.root_path)"
    env = {**os.environ, "BASE_PATH": "/quiz/"}
    result = subprocess.run([sys.executable, "-c", code], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60)
    assert result.stdout.strip() == "/quiz", result.stderr


def test_unknown_routes_and_json_errors(client):
    assert client.get("/api/nope").status_code == 404
    assert client.get("/api/auth/login").status_code == 405


def test_cors_headers_for_allowed_origin(client):
    response = client.options(
        "/api/auth/login",
        headers={"Origin": "http://localhost:8080", "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:8080"
    denied = client.options(
        "/api/auth/login", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert "access-control-allow-origin" not in denied.headers


def test_unhandled_errors_do_not_leak_details(client):
    def boom():
        raise ZeroDivisionError("secret internals")

    app.add_api_route("/api/_boom", boom)
    try:
        with TestClient(app, raise_server_exceptions=False) as http:
            response = http.get("/api/_boom")
        assert response.status_code == 500
        assert response.json() == {"detail": "Internal server error"}
    finally:
        app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", "") != "/api/_boom"]


def test_health_router_paths():
    assert {r.path for r in health.router.routes} == {"/health", "/api/health", "/livez", "/api/livez"}


# ---------------------------------------------------------------------------------------------
# GUARD: every /api/admin route must reject anonymous requests
# ---------------------------------------------------------------------------------------------
def _admin_routes():
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/admin"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, route.path


@pytest.mark.parametrize("method,path", list(_admin_routes()) or [pytest.param("GET", "", marks=pytest.mark.skip("no admin routes yet"))])
def test_every_admin_route_requires_a_bearer_token(client, method, path):
    concrete = re.sub(r"\{[^}]+\}", "1", path)  # int path params
    anonymous = client.request(method, concrete)
    assert anonymous.status_code == 401, f"{method} {path} is not protected"
    garbage = client.request(method, concrete, headers={"Authorization": "Bearer garbage"})
    assert garbage.status_code == 401, f"{method} {path} accepts a garbage token"


def test_admin_routers_are_mounted_behind_the_admin_guard():
    """main.py mounts every admin router with the guard, even when the router declares none."""
    from app.auth import require_admin
    from app.main import ADMIN_GUARD

    assert [d.dependency for d in ADMIN_GUARD] == [require_admin]
    admin_paths = [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/api/admin")]
    for route in admin_paths:
        assert any(d.call is require_admin for d in route.dependant.dependencies), route.path
