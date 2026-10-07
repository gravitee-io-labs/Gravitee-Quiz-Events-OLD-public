"""Regression tests from the adversarial verification pass: hostile input must never produce a 500,
never echo itself back, and never leak internals.

* validation errors (NaN, lone surrogates) answer 422 JSON (the stock FastAPI handler crashed with a 500)
* characters PostgreSQL cannot store (NUL) and values it cannot hold are 422 / 404, not 500
* stored data that no longer validates (branding) must not take the hub down
* the "real PostgreSQL" variants run when ``TEST_DATABASE_URL`` points at a PostgreSQL database
"""
import json

import pytest
from sqlalchemy.exc import DataError

from app.database import engine
from app.routers import public_events

ON_POSTGRES = engine.dialect.name == "postgresql"
needs_postgres = pytest.mark.skipif(not ON_POSTGRES, reason="PostgreSQL rejects NUL, SQLite does not")

NUL = "a\u0000b"


@pytest.fixture
def played(client, make_event, make_category, make_question, make_player):
    """A live event with a player and an in-progress game: ``(event, game_session_id, question_id)``."""
    event = make_event(slug="hostile", questions_per_game=1)
    category = make_category(event)
    question = make_question(event, category)
    player = make_player(event)
    started = client.post(f"/api/events/{event.slug}/games", json={"player_id": player.id})
    assert started.status_code == 200, started.text
    return event, started.json()["game_session_id"], question.id


# ---------------------------------------------------------------------------------------------
# validation errors are 422 JSON, whatever the input
# ---------------------------------------------------------------------------------------------
def test_nan_and_infinity_in_a_body_are_a_422_not_a_500(client, played):
    event, game_id, question_id = played
    for literal in ("NaN", "Infinity", "-Infinity"):
        body = f'{{"answers":[{{"question_id":{question_id},"player_answer":"green","time_taken":{literal}}}]}}'
        response = client.post(
            f"/api/events/{event.slug}/games/{game_id}/submit",
            content=body,
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 422, (literal, response.text)
        assert isinstance(response.json()["detail"], list)


def test_a_lone_surrogate_in_a_body_is_a_422_not_a_500(client, make_event):
    event = make_event()
    response = client.post(
        f"/api/events/{event.slug}/players",
        content='{"first_name":"\\ud800","last_name":"x","email":"s@example.com"}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422, response.text
    json.loads(response.text)  # well formed JSON


def test_validation_errors_do_not_echo_the_submitted_input(client, make_event):
    event = make_event()
    secret = "do-not-echo-me@example.com"
    response = client.post(
        f"/api/events/{event.slug}/players",
        json={"first_name": "", "last_name": "x", "email": secret, "phone_number": "12"},
    )
    assert response.status_code == 422
    assert secret not in response.text
    errors = response.json()["detail"]
    assert errors and all(set(error) == {"type", "loc", "msg"} for error in errors)
    assert any(error["loc"][-1] == "first_name" for error in errors)


def test_the_422_shape_is_still_a_list_of_type_loc_msg(client, admin_headers):
    response = client.post("/api/admin/events", json={"slug": "Bad Slug", "name": ""}, headers=admin_headers)
    assert response.status_code == 422
    fields = {tuple(error["loc"])[-1] for error in response.json()["detail"]}
    assert {"slug", "name", "game_title"} <= fields


@pytest.mark.parametrize("name", ["<script>alert(1)</script>", "Ada<b>", "a>b", "<img src=x onerror=alert(1)>"])
def test_names_cannot_carry_markup(client, make_event, name):
    event = make_event()
    for field in ("first_name", "last_name"):
        payload = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com", field: name}
        response = client.post(f"/api/events/{event.slug}/players", json=payload)
        assert response.status_code == 422, (field, name, response.text)


@pytest.mark.parametrize("url", ["/x\u0000y", "/logo\n.png", "https://x.example/a\tb", "/a\x7fb", "javascript:alert(1)"])
def test_asset_urls_reject_control_characters_and_schemes(client, admin_headers, make_event, url):
    event = make_event()
    response = client.put(f"/api/admin/events/{event.id}", json={"branding": {"logo_url": url}}, headers=admin_headers)
    assert response.status_code == 422, (url, response.text)


# ---------------------------------------------------------------------------------------------
# database level rejections map to client errors (simulated, runs on SQLite too)
# ---------------------------------------------------------------------------------------------
def test_a_nul_character_rejected_by_the_driver_is_a_422(client, make_event, monkeypatch):
    make_event(slug="nul-driver")

    def refuse(*_args, **_kwargs):
        raise ValueError("A string literal cannot contain NUL (0x00) characters.")

    monkeypatch.setattr(public_events, "get_event_or_404", refuse)
    response = client.get("/api/events/nul-driver")
    assert response.status_code == 422, response.text
    assert "NUL" in response.json()["detail"] and "Traceback" not in response.text


def test_a_value_the_database_cannot_store_is_a_422(client, make_event, monkeypatch):
    make_event(slug="too-big")

    def refuse(*_args, **_kwargs):
        raise DataError("SELECT 1", {}, Exception("integer out of range"))

    monkeypatch.setattr(public_events, "get_event_or_404", refuse)
    response = client.get("/api/events/too-big")
    assert response.status_code == 422
    assert "integer out of range" not in response.text  # the driver's message stays in the log


def test_any_other_value_error_is_a_plain_500_without_details(client, make_event, monkeypatch):
    make_event(slug="bug")

    def explode(*_args, **_kwargs):
        raise ValueError("secret internal state: /etc/passwd")

    monkeypatch.setattr(public_events, "get_event_or_404", explode)
    response = client.get("/api/events/bug")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}


def test_a_slug_with_a_nul_character_is_a_404(client):
    assert client.get("/api/events/a%00b").status_code == 404
    assert client.get("/api/events/a%00b/scoreboard").status_code == 404
    assert client.post("/api/events/a%00b/players", json={}).status_code in (404, 422)


# ---------------------------------------------------------------------------------------------
# the same with a real PostgreSQL
# ---------------------------------------------------------------------------------------------
@needs_postgres
@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/api/admin/events", {"slug": "nul-event", "name": NUL, "game_title": "x"}),
        ("POST", "/api/admin/events/{event}/categories", {"name": NUL}),
        ("POST", "/api/admin/events/{event}/questions", {"question_text_en": NUL, "correct_answer": "green"}),
        ("POST", "/api/admin/events/{event}/questions", {"question_text_en": "ok?", "correct_answer": "green", "explanation_en": NUL}),
    ],
)
def test_nul_characters_in_admin_text_are_a_422_on_postgresql(client, admin_headers, make_event, method, path, body):
    event = make_event()
    response = client.request(method, path.format(event=event.id), json=body, headers=admin_headers)
    assert response.status_code == 422, response.text


@needs_postgres
def test_nul_in_a_search_or_a_registration_is_harmless_on_postgresql(client, admin_headers, make_event):
    event = make_event()
    assert client.get(f"/api/admin/events/{event.id}/questions", params={"search": NUL}, headers=admin_headers).status_code == 200
    assert client.get(f"/api/admin/events/{event.id}/results", params={"search": NUL}, headers=admin_headers).status_code == 200
    registration = {"first_name": NUL, "last_name": "x", "email": "n@example.com"}
    assert client.post(f"/api/events/{event.slug}/players", json=registration).status_code == 422


@needs_postgres
def test_huge_ids_never_500_on_postgresql(client, admin_headers, make_event, played):
    event, _game_id, _question_id = played
    big = 2**40
    huge = 10**30
    for identifier in (big, huge, -1):
        assert client.get(f"/api/admin/events/{identifier}", headers=admin_headers).status_code in (404, 422)
        assert client.get(f"/api/admin/results/{identifier}", headers=admin_headers).status_code in (404, 422)
        assert client.post(f"/api/events/{event.slug}/games", json={"player_id": identifier}).status_code in (404, 422)
        assert client.post(f"/api/events/{event.slug}/games/{identifier}/submit", json={"answers": []}).status_code in (404, 422)
    assert client.get(f"/api/admin/events/{event.id}/questions", params={"skip": huge}, headers=admin_headers).status_code in (200, 422)


# ---------------------------------------------------------------------------------------------
# response headers
# ---------------------------------------------------------------------------------------------
def test_admin_and_auth_responses_are_never_cacheable(client, admin_headers, make_event):
    event = make_event()
    for path in (f"/api/admin/events/{event.id}", "/api/admin/events", "/api/auth/me"):
        response = client.get(path, headers=admin_headers)
        assert response.status_code == 200, path
        assert response.headers["cache-control"] == "no-store", path
    login = client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert login.headers["cache-control"] == "no-store"  # a token must not sit in a shared cache
    assert client.get("/api/admin/events").headers["cache-control"] == "no-store"  # also on 401


def test_every_response_is_nosniff_and_public_routes_are_not_forced_no_store(client, make_event):
    event = make_event()
    for path in ("/api/health", "/api/events", f"/api/events/{event.slug}", "/api/nope"):
        response = client.get(path)
        assert response.headers["x-content-type-options"] == "nosniff", path
    assert "no-store" not in client.get(f"/api/events/{event.slug}").headers.get("cache-control", "")


# ---------------------------------------------------------------------------------------------
# the public surface is an explicit allow-list
# ---------------------------------------------------------------------------------------------
PUBLIC_ROUTES = {
    ("GET", "/"),
    ("GET", "/health"),
    ("GET", "/api/health"),
    ("GET", "/livez"),
    ("GET", "/api/livez"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/me"),  # guarded by require_admin itself
    ("GET", "/api/events"),
    ("GET", "/api/events/{slug}"),
    ("POST", "/api/events/{slug}/players"),
    ("POST", "/api/events/{slug}/games"),
    ("POST", "/api/events/{slug}/games/{game_id}/submit"),
    ("GET", "/api/events/{slug}/games/{game_id}/result"),  # guarded by the game's own token (X-Game-Token)
    ("GET", "/api/events/{slug}/scoreboard"),
    ("GET", "/api/events/{slug}/scoreboard/stream"),
}
FRAMEWORK_ROUTES = {"/api/docs", "/api/openapi.json", "/docs/oauth2-redirect"}  # only when ENABLE_DOCS


def test_every_route_outside_api_admin_is_on_the_reviewed_public_list():
    """A new route that is not under /api/admin (so not behind the admin guard) must be added here
    on purpose: this is the check that a forgotten ``Depends(require_admin)`` cannot slip through."""
    from fastapi.routing import APIRoute

    from app.main import app

    found = {
        (method, route.path)
        for route in app.routes
        if isinstance(route, APIRoute) and not route.path.startswith("/api/admin")
        for method in route.methods - {"HEAD", "OPTIONS"}
    }
    assert found == PUBLIC_ROUTES, f"unreviewed: {sorted(found - PUBLIC_ROUTES)}, vanished: {sorted(PUBLIC_ROUTES - found)}"
    extra = {route.path for route in app.routes if not isinstance(route, APIRoute)} - FRAMEWORK_ROUTES
    assert extra == set(), f"non-API routes mounted: {sorted(extra)}"


def test_category_names_are_unique_up_to_unicode_normalisation_in_the_admin_api(client, admin_headers, make_event):
    """Same rule as the CSV import: 'Café' typed with a combining accent is the same category."""
    event = make_event()
    url = f"/api/admin/events/{event.id}/categories"
    assert client.post(url, json={"name": "Café"}, headers=admin_headers).status_code == 201
    assert client.post(url, json={"name": "Café"}, headers=admin_headers).status_code == 409
    assert client.post(url, json={"name": "  CAFÉ "}, headers=admin_headers).status_code == 409
