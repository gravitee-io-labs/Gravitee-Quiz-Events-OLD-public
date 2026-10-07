from datetime import datetime, timedelta, timezone

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from app import security
from app.auth import (
    admin_router,
    authenticate_admin,
    create_access_token,
    decode_access_token,
    optional_admin,
    require_admin,
)
from app.config import settings
from app.security import LoginThrottle, get_client_ip, throttle_key

LOGIN = "/api/auth/login"


def login(client, username="admin", password="admin", **kwargs):
    return client.post(LOGIN, json={"username": username, "password": password}, **kwargs)


# ---------------------------------------------------------------------------------------------
# login / me / logout
# ---------------------------------------------------------------------------------------------
def test_login_success_returns_a_jwt(client):
    response = login(client)
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer" and body["expires_in"] == 3600
    claims = jwt.decode(body["access_token"], settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    assert claims["sub"] == "admin"
    expires = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
    assert abs((expires - datetime.now(timezone.utc)) - timedelta(minutes=60)) < timedelta(seconds=30)


@pytest.mark.parametrize("username,password", [("admin", "wrong"), ("nope", "admin"), ("nope", "nope"), ("", "x")])
def test_login_failure(client, username, password):
    response = client.post(LOGIN, json={"username": username, "password": password})
    assert response.status_code in (401, 422)
    if response.status_code == 401:
        assert response.json() == {"detail": "Incorrect username or password"}
        assert response.headers["www-authenticate"] == "Bearer"


def test_login_with_non_ascii_credentials_does_not_crash(client):
    assert login(client, "adminé", "pässwörd").status_code == 401


def test_login_rejects_malformed_body(client):
    assert client.post(LOGIN, json={"username": "admin"}).status_code == 422


def test_me_requires_a_token_and_returns_the_username(client, admin_headers):
    assert client.get("/api/auth/me").status_code == 401  # not 403
    assert client.get("/api/auth/me", headers=admin_headers).json() == {"username": "admin"}


def test_logout_is_stateless(client):
    response = client.post("/api/auth/logout")
    assert response.status_code == 200 and "logged out" in response.json()["message"]


# ---------------------------------------------------------------------------------------------
# token validation
# ---------------------------------------------------------------------------------------------
def _token(**overrides):
    claims = {"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}
    claims.update(overrides)
    return jwt.encode(claims, settings.SECRET_KEY, algorithm="HS256")


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer not-a-jwt"},
        {"Authorization": "Basic YWRtaW46YWRtaW4="},
        {"Authorization": "Bearer " + jwt.encode({"sub": "admin"}, settings.SECRET_KEY, algorithm="HS256")},  # no exp
    ],
)
def test_me_rejects_missing_or_bad_tokens(client, headers):
    response = client.get("/api/auth/me", headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_me_rejects_expired_wrong_secret_wrong_subject_and_wrong_algorithm(client):
    expired = _token(exp=datetime.now(timezone.utc) - timedelta(seconds=5))
    forged = jwt.encode({"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, "other-secret-key-0123456789-abcdefghij", algorithm="HS256")
    other_user = _token(sub="mallory")
    hs512 = jwt.encode({"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, settings.SECRET_KEY, algorithm="HS512")
    for token in (expired, forged, other_user, hs512):
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_create_and_decode_access_token_roundtrip():
    token = create_access_token("admin", timedelta(minutes=1))
    assert decode_access_token(token).username == "admin"
    assert decode_access_token(token + "x") is None
    assert decode_access_token(create_access_token("admin", timedelta(seconds=-1))) is None


def test_authenticate_admin_compares_both_fields_in_constant_time(monkeypatch):
    calls = []
    real = security.secrets.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(security.secrets, "compare_digest", spy)
    assert authenticate_admin("wrong-user", "admin") is False
    assert len(calls) == 2  # password compared even though the username already failed
    calls.clear()
    assert authenticate_admin("admin", "admin") is True
    assert len(calls) == 2


# ---------------------------------------------------------------------------------------------
# dependencies on a tiny app
# ---------------------------------------------------------------------------------------------
def _mini_app():
    mini = FastAPI()
    guarded = admin_router()

    @guarded.get("/secret")
    def secret():
        return {"secret": True}

    explicit = APIRouter(dependencies=[Depends(require_admin)])

    @explicit.get("/also-secret")
    def also_secret():
        return {"secret": True}

    unguarded = APIRouter()

    @unguarded.get("/maybe")
    def maybe(admin=Depends(optional_admin)):
        return {"admin": admin.username if admin else None}

    @unguarded.get("/forgot-the-guard")
    def forgot():
        return {"leak": True}

    mini.include_router(guarded, prefix="/admin")
    mini.include_router(explicit, prefix="/admin")
    # the pattern main.py uses: guard at include time, whatever the router declares
    mini.include_router(unguarded, prefix="/admin2", dependencies=[Depends(require_admin)])
    mini.include_router(unguarded, prefix="/pub")
    return mini


def test_admin_router_helpers_protect_every_route(admin_headers):
    mini = TestClient(_mini_app())
    for path in ("/admin/secret", "/admin/also-secret", "/admin2/forgot-the-guard", "/admin2/maybe"):
        assert mini.get(path).status_code == 401, path
        assert mini.get(path, headers=admin_headers).status_code == 200, path


def test_optional_admin_never_raises(admin_headers):
    mini = TestClient(_mini_app())
    assert mini.get("/pub/maybe").json() == {"admin": None}
    assert mini.get("/pub/maybe", headers={"Authorization": "Bearer garbage"}).json() == {"admin": None}
    assert mini.get("/pub/maybe", headers={"Authorization": "Bearer"}).json() == {"admin": None}
    assert mini.get("/pub/maybe", headers=admin_headers).json() == {"admin": "admin"}
    other = {"Authorization": "Bearer " + create_access_token("mallory")}
    assert mini.get("/pub/maybe", headers=other).json() == {"admin": None}


# ---------------------------------------------------------------------------------------------
# throttle
# ---------------------------------------------------------------------------------------------
def test_throttle_answers_429_to_a_wrong_password_after_ten_failures_with_retry_after(client):
    for _ in range(10):
        assert login(client, password="bad").status_code == 401
    blocked = login(client, password="bad")
    assert blocked.status_code == 429
    assert 1 <= int(blocked.headers["retry-after"]) <= 301
    assert "www-authenticate" not in blocked.headers
    # ... but the soft threshold does not lock the real admin out (see the next tests)
    assert login(client).status_code == 200


def test_throttle_is_per_ip_and_username(client):
    for _ in range(10):
        login(client, password="bad")
    assert login(client, password="bad").status_code == 429
    assert login(client, username="someone-else", password="bad").status_code == 401  # other username
    other_ip = {"X-Forwarded-For": "203.0.113.9, 10.0.0.1"}
    assert login(client, password="bad", headers=other_ip).status_code == 401  # other client ip
    assert login(client, headers=other_ip).status_code == 200


# ---------------------------------------------------------------------------------------------
# throttle: the real admin is never locked out by the soft threshold, guessing is capped by the hard one
# ---------------------------------------------------------------------------------------------
HARD = 50  # LOGIN_HARD_MAX_FAILURES default


def fail(client, times, **kwargs):
    return [login(client, password="bad", **kwargs).status_code for _ in range(times)]


def test_the_right_password_logs_in_while_the_soft_threshold_is_exceeded_and_resets_the_counter(client):
    assert fail(client, 10) == [401] * 10
    assert fail(client, 5) == [429] * 5  # throttled: wrong guesses are 429s ...
    ok = login(client)  # ... the real admin still gets in
    assert ok.status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {ok.json()['access_token']}"}).json() == {"username": "admin"}
    assert fail(client, 10) == [401] * 10  # the success cleared the failures: 401 again, not 429
    assert fail(client, 1) == [429]


def test_a_wrong_password_while_throttled_is_429_with_retry_after_and_still_counted(client, monkeypatch):
    fail(client, 10)
    response = login(client, password="bad")
    assert response.status_code == 429 and response.json() == {"detail": "Too many failed login attempts. Try again later."}
    assert 1 <= int(response.headers["retry-after"]) <= 301
    assert len(security.login_throttle._failures[throttle_key("testclient", "admin")]) == 11


def test_the_hard_limit_locks_everything_including_the_right_password(client):
    assert fail(client, HARD) == [401] * 10 + [429] * (HARD - 10)
    locked = login(client)  # the 51st attempt carries the right password: refused all the same
    assert locked.status_code == 429
    assert 1 <= int(locked.headers["retry-after"]) <= 301
    assert "access_token" not in locked.text
    assert login(client, password="bad").status_code == 429


def test_password_guessing_is_capped_by_the_hard_limit(client, monkeypatch):
    """However many requests an attacker sends, at most HARD wrong guesses are ever evaluated per window."""
    evaluated = []
    real = authenticate_admin

    def spy(username, password):
        evaluated.append(password)
        return real(username, password)

    monkeypatch.setattr("app.routers.auth.authenticate_admin", spy)
    statuses = [login(client, password=f"guess-{i}").status_code for i in range(HARD * 4)]
    assert len(evaluated) == HARD  # the other 150 requests were refused without looking at the password
    assert statuses.count(401) == 10 and statuses.count(429) == HARD * 4 - 10


def test_the_credentials_are_checked_before_the_soft_threshold_but_not_after_the_hard_limit(client, monkeypatch):
    calls = []
    real = authenticate_admin
    monkeypatch.setattr("app.routers.auth.authenticate_admin", lambda u, p: calls.append(1) or real(u, p))
    fail(client, 10)
    calls.clear()
    assert login(client).status_code == 200 and len(calls) == 1  # throttled: checked (and valid)
    fail(client, HARD)
    calls.clear()
    assert login(client).status_code == 429 and calls == []  # locked: not even checked


def test_the_lock_ends_when_the_failures_leave_the_window(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(security.login_throttle, "_clock", lambda: now[0])
    fail(client, HARD)
    assert login(client).status_code == 429
    now[0] += 299
    assert login(client).status_code == 429  # one second left
    now[0] += 2
    assert login(client).status_code == 200  # the window slid past every failure


def test_the_lock_is_lifted_one_failure_at_a_time_not_all_at_once(client, monkeypatch):
    """Failures spread over time: the lock ends when the OLDEST ones expire, so a slow attacker is not forgiven early."""
    now = [0.0]
    monkeypatch.setattr(security.login_throttle, "_clock", lambda: now[0])
    for _ in range(HARD):
        login(client, password="bad")
        now[0] += 5  # 50 failures over 250 s
    assert login(client).status_code == 429
    now[0] = 300.5  # the first failure (t=0) just left the window: 49 remain, the lock is over
    assert login(client).status_code == 200


def test_an_attacker_on_another_ip_cannot_lock_the_admin_out(client):
    # the trusted proxy appends the peer it saw: the RIGHTMOST entry is the client address
    attacker = {"X-Forwarded-For": "10.9.9.9, 198.51.100.66"}
    admin_ip = {"X-Forwarded-For": "10.9.9.9, 192.0.2.10"}
    assert fail(client, HARD, headers=attacker)[-1] == 429
    assert login(client, headers=attacker).status_code == 429  # locked, even with the right password
    assert login(client, headers=admin_ip).status_code == 200  # the admin's own key is untouched
    assert fail(client, 3, headers=admin_ip) == [401] * 3


def test_failures_against_other_usernames_never_touch_the_admin_key(client):
    for name in ("root", "administrator", "Admin1"):
        assert fail_user(client, name, 60)[-1] == 429
    assert login(client).status_code == 200


def fail_user(client, username, times):
    return [login(client, username=username, password="x").status_code for _ in range(times)]


def test_username_case_and_padding_share_one_key(client):
    for name in ("admin", "ADMIN", " Admin ", "aDmIn"):
        fail_user(client, name, 3)
    assert security.login_throttle.status(throttle_key("testclient", "admin")).throttled  # 12 failures, one key


def test_strict_mode_hard_limit_equal_to_the_soft_one_locks_the_right_password_too(client, monkeypatch):
    """LOGIN_HARD_MAX_FAILURES=LOGIN_MAX_FAILURES restores the plain 'lock after N failures' behaviour."""
    monkeypatch.setattr(settings, "LOGIN_HARD_MAX_FAILURES", 10)
    assert fail(client, 10) == [401] * 10
    assert login(client).status_code == 429
    assert login(client, password="bad").status_code == 429


def test_a_hard_limit_below_the_soft_one_is_treated_as_equal(client, monkeypatch):
    monkeypatch.setattr(settings, "LOGIN_HARD_MAX_FAILURES", 1)
    assert fail(client, 10) == [401] * 10
    assert login(client).status_code == 429


def test_hard_limit_is_configurable(client, monkeypatch):
    monkeypatch.setattr(settings, "LOGIN_HARD_MAX_FAILURES", 12)
    assert fail(client, 12) == [401] * 10 + [429] * 2
    assert login(client).status_code == 429


def test_successful_login_clears_the_failures(client):
    for _ in range(9):
        login(client, password="bad")
    assert login(client).status_code == 200
    for _ in range(9):
        assert login(client, password="bad").status_code == 401
    assert login(client).status_code == 200


def test_throttle_is_configurable(client, monkeypatch):
    monkeypatch.setattr(settings, "LOGIN_MAX_FAILURES", 2)
    login(client, password="bad")
    login(client, password="bad")
    assert login(client, password="bad").status_code == 429


def test_throttle_window_expiry_with_a_fake_clock():
    now = [1000.0]
    throttle = LoginThrottle(max_failures=lambda: 3, window_seconds=lambda: 60, clock=lambda: now[0])
    for _ in range(3):
        throttle.record_failure("k")
    assert throttle.retry_after("k") > 0
    now[0] += 59
    assert 0 < throttle.retry_after("k") <= 2
    now[0] += 2
    assert throttle.retry_after("k") == 0
    throttle.record_failure("k")
    assert throttle.retry_after("k") == 0  # sliding window restarted
    throttle.reset()
    assert throttle.retry_after("k") == 0


def test_throttle_status_has_soft_and_hard_thresholds_with_a_sliding_window():
    now = [1000.0]
    throttle = LoginThrottle(
        max_failures=lambda: 3, hard_max_failures=lambda: 5, window_seconds=lambda: 60, clock=lambda: now[0]
    )
    assert throttle.status("k") == (0, 0) and not throttle.status("k").throttled
    for _ in range(2):
        throttle.record_failure("k")
    assert not throttle.status("k").throttled
    throttle.record_failure("k")  # 3: throttled
    status = throttle.status("k")
    assert status.throttled and not status.locked and 1 <= status.throttled_for <= 61
    for _ in range(2):
        now[0] += 10
        throttle.record_failure("k")  # 5: locked
    status = throttle.status("k")
    assert status.throttled and status.locked
    assert 1 <= status.locked_for <= 61
    now[0] += 55  # t=1075: the failure at 1000 (x3) left the window, 2 remain
    assert throttle.status("k") == (0, 0)


def test_throttle_retry_after_waits_for_the_right_failure_to_expire():
    now = [0.0]
    throttle = LoginThrottle(
        max_failures=lambda: 2, hard_max_failures=lambda: 3, window_seconds=lambda: 100, clock=lambda: now[0]
    )
    for at in (0, 10, 20):
        now[0] = at
        throttle.record_failure("k")
    now[0] = 30
    status = throttle.status("k")
    # locked until the failure at t=0 expires (t=100): 70 s; throttled until the one at t=10 expires: 80 s
    assert status.locked_for == 71 and status.throttled_for == 81


def test_throttle_stops_recording_once_locked_so_the_list_stays_bounded():
    now = [0.0]
    throttle = LoginThrottle(
        max_failures=lambda: 2, hard_max_failures=lambda: 4, window_seconds=lambda: 60, clock=lambda: now[0]
    )
    for _ in range(1000):
        now[0] += 0.001
        throttle.record_failure("k")
    assert len(throttle._failures["k"]) == 4


def test_throttle_hard_limit_never_below_the_soft_limit():
    throttle = LoginThrottle(max_failures=lambda: 5, hard_max_failures=lambda: 2, window_seconds=lambda: 60)
    for _ in range(5):
        throttle.record_failure("k")
    status = throttle.status("k")
    assert status.throttled and status.locked  # collapsed onto the soft limit: the strict lock


def test_throttle_memory_is_bounded():
    now = [0.0]
    throttle = LoginThrottle(max_failures=lambda: 3, window_seconds=lambda: 60, clock=lambda: now[0])
    throttle.MAX_KEYS = 100
    for i in range(500):
        now[0] += 0.001
        throttle.record_failure(f"k{i}")
    assert len(throttle._failures) <= 100


class _FakeRequest:
    def __init__(self, headers, host="10.1.1.1"):
        self.headers = headers
        self.client = type("C", (), {"host": host})() if host else None


def test_client_ip_uses_the_entry_appended_by_the_trusted_proxy():
    # "spoofed, real": the proxy appends the peer it saw, so the RIGHTMOST entry is the trustworthy one
    assert get_client_ip(_FakeRequest({"x-forwarded-for": "6.6.6.6, 5.6.7.8"})) == "5.6.7.8"
    assert get_client_ip(_FakeRequest({"x-forwarded-for": "5.6.7.8"})) == "5.6.7.8"
    assert get_client_ip(_FakeRequest({})) == "10.1.1.1"
    assert get_client_ip(_FakeRequest({}, host=None)) == "unknown"
    assert get_client_ip(_FakeRequest({"x-forwarded-for": " , "})) == "10.1.1.1"
    assert throttle_key("1.2.3.4", " Admin ") == "1.2.3.4|admin"


def test_client_ip_honours_the_number_of_trusted_proxies(monkeypatch):
    request = _FakeRequest({"x-forwarded-for": "9.9.9.9, 1.1.1.1, 2.2.2.2"})
    monkeypatch.setattr(settings, "TRUSTED_PROXY_HOPS", 2)
    assert get_client_ip(request) == "1.1.1.1"
    monkeypatch.setattr(settings, "TRUSTED_PROXY_HOPS", 5)  # more hops than entries: the leftmost one
    assert get_client_ip(request) == "9.9.9.9"
    monkeypatch.setattr(settings, "TRUSTED_PROXY_HOPS", 0)  # no proxy: the header is ignored entirely
    assert get_client_ip(request) == "10.1.1.1"


def test_rotating_x_forwarded_for_does_not_dodge_the_login_throttle(client):
    """An attacker behind the proxy controls the LEFT part of X-Forwarded-For only."""
    for attempt in range(10):
        spoofed = {"X-Forwarded-For": f"198.51.100.{attempt}, 203.0.113.7"}
        assert login(client, password="bad", headers=spoofed).status_code == 401
    assert login(client, password="bad", headers={"X-Forwarded-For": "198.51.100.77, 203.0.113.7"}).status_code == 429
