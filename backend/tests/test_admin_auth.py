"""Every /api/admin route is protected, and the contract's admin routes all exist."""
import re
from datetime import timedelta

import pytest
from fastapi.routing import APIRoute

from app.auth import create_access_token
from app.main import app

EXPECTED_ROUTES = {
    # events
    ("GET", "/api/admin/events"),
    ("POST", "/api/admin/events"),
    ("POST", "/api/admin/events/import"),
    ("GET", "/api/admin/events/{event_id}"),
    ("PUT", "/api/admin/events/{event_id}"),
    ("DELETE", "/api/admin/events/{event_id}"),
    ("POST", "/api/admin/events/{event_id}/duplicate"),
    ("GET", "/api/admin/events/{event_id}/export"),
    ("GET", "/api/admin/events/{event_id}/stats"),
    # categories
    ("GET", "/api/admin/events/{event_id}/categories"),
    ("POST", "/api/admin/events/{event_id}/categories"),
    ("PUT", "/api/admin/categories/{category_id}"),
    ("DELETE", "/api/admin/categories/{category_id}"),
    # questions
    ("GET", "/api/admin/events/{event_id}/questions"),
    ("POST", "/api/admin/events/{event_id}/questions"),
    ("POST", "/api/admin/events/{event_id}/questions/bulk"),
    ("POST", "/api/admin/events/{event_id}/questions/import-csv"),
    ("GET", "/api/admin/events/{event_id}/questions/export.csv"),
    ("PUT", "/api/admin/questions/{question_id}"),
    ("DELETE", "/api/admin/questions/{question_id}"),
    # results
    ("GET", "/api/admin/events/{event_id}/results"),
    ("GET", "/api/admin/events/{event_id}/results.csv"),
    ("GET", "/api/admin/results/{session_id}"),
    ("DELETE", "/api/admin/results/{session_id}"),
    ("PATCH", "/api/admin/results/{session_id}/score"),
}


def admin_routes():
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/admin"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, route.path


def test_the_contract_routes_are_all_registered():
    registered = set(admin_routes())
    assert EXPECTED_ROUTES <= registered, f"missing: {sorted(EXPECTED_ROUTES - registered)}"


def concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


@pytest.mark.parametrize("method,path", sorted(admin_routes()))
def test_admin_route_rejects_anonymous_garbage_and_foreign_tokens(client, method, path):
    url = concrete(path)
    assert client.request(method, url).status_code == 401, f"{method} {path} is open"
    assert client.request(method, url, headers={"Authorization": "Bearer garbage"}).status_code == 401
    assert client.request(method, url, headers={"Authorization": "Basic YWRtaW46YWRtaW4="}).status_code == 401
    # a perfectly signed token for somebody who is not the admin
    stranger = create_access_token("mallory")
    assert client.request(method, url, headers={"Authorization": f"Bearer {stranger}"}).status_code == 401
    # an expired admin token
    expired = create_access_token("admin", expires_delta=timedelta(seconds=-5))
    assert client.request(method, url, headers={"Authorization": f"Bearer {expired}"}).status_code == 401


@pytest.mark.parametrize("method,path", sorted(admin_routes()))
def test_admin_route_does_not_answer_401_to_the_admin(client, admin_headers, method, path):
    """With a valid token the guard lets the request through (404 / 422 for the fake id are fine)."""
    response = client.request(method, concrete(path), headers=admin_headers)
    assert response.status_code != 401, f"{method} {path}"
    assert response.status_code < 500, f"{method} {path} -> {response.status_code} {response.text}"


def test_unauthenticated_request_leaks_nothing(client, make_event):
    event = make_event(slug="secret-event")
    response = client.get(f"/api/admin/events/{event.id}")
    assert response.status_code == 401
    assert "secret-event" not in response.text
    assert response.headers["www-authenticate"] == "Bearer"
