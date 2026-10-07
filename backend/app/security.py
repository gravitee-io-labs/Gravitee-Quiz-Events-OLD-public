"""
Security helpers: constant-time credential check, client IP extraction (trusted-proxy aware), the per-game
submit token and the in-memory login throttle.

Login throttle policy
---------------------
Failures are counted per ``ip|username`` over a sliding window (``LOGIN_WINDOW_SECONDS``, 5 min), with two
thresholds (``LOGIN_MAX_FAILURES`` = 10, ``LOGIN_HARD_MAX_FAILURES`` = 50):

* below 10 failures: a wrong password is a 401.
* 10 to 49 failures ("throttled"): the credentials are checked FIRST, in constant time. Correct: the login
  succeeds and the counter is reset. Wrong: 429 + ``Retry-After`` (instead of 401), the failure is counted.
* 50 failures ("locked"): 429 + ``Retry-After`` for EVERY attempt, the password is not even looked at, until
  old failures slide out of the window.

Why the real admin is not locked out at 10: behind a shared proxy IP (AKS, every client seen as one node)
the key degenerates to the username, so with a lock at 10 anybody (a scanner, a curious attendee trying
``admin/admin``) could keep the real admin from logging in during the event. Letting a correct password
through the soft threshold gives the admin that guarantee against every attacker who does not know it.

Why that is not a brute force hole: exempting correct credentials only from the SOFT threshold does not
lift the cap on guessing, the hard limit does that job. At most 50 wrong guesses are evaluated per window
per ``ip|username`` (about 10 a minute: 14 400 a day per IP, against 2 880 with a plain lock at 10), and a
guess that happens to be right succeeds just as it would on an unthrottled endpoint. A 429 and a 401 both
only say "wrong", so nothing is learnt that an unthrottled endpoint would not tell. The cost of the
trade-off is a 5x larger guess budget on the admin password (use a long random one: with 16+ random
characters 14 400 guesses a day is irrelevant) and that an attacker sharing the admin's IP can still lock
the admin out for up to 5 minutes by burning the 50 failures (an already issued token keeps working for
24 h; only a NEW login waits). From a different IP the attacker cannot touch the admin's key at all.

Rejected: a global per-username limiter (all IPs together, 429 for everyone after N failures) would re-create
the lock-out from any IP with a handful of requests; and a ``sleep`` progressive delay would pin one
threadpool thread per attempt, which is a denial of service of its own. A deployment that prefers the
strict behaviour sets ``LOGIN_HARD_MAX_FAILURES`` equal to ``LOGIN_MAX_FAILURES``.

The throttle is per process (per replica). That is deliberate: it is a speed bump against guessing the single
admin password, not a distributed rate limiter (N replicas = N times the budget).
"""
import hashlib
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import NamedTuple

from fastapi import Request

from app.config import settings


def constant_time_equals(a: str, b: str) -> bool:
    """Compare two strings in constant time (UTF-8 bytes: works for non-ASCII input)."""
    return secrets.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def verify_admin_credentials(username: str, password: str) -> bool:
    """Check the env-configured admin credentials.

    BOTH fields are always compared (no short-circuit) so timing does not reveal whether the
    username was the wrong part.
    """
    username_ok = constant_time_equals(username, settings.ADMIN_USERNAME)
    password_ok = constant_time_equals(password, settings.ADMIN_PASSWORD)
    return username_ok & password_ok


# ---------------------------------------------------------------------------------------------
# Per-game submit token (game integrity)
# ---------------------------------------------------------------------------------------------
SUBMIT_TOKEN_BYTES = 16  # 128 bit of entropy: not guessable, whatever the request rate
SUBMIT_TOKEN_MAX_LENGTH = 128  # a legitimate token is 22 characters; anything longer is refused unhashed


def hash_submit_token(token: str) -> str:
    """SHA-256 hex digest. Fast hashing is fine: the token is 128 random bits, not a human password."""
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def new_submit_token() -> tuple[str, str]:
    """``(token, sha256 hex of the token)``: the token goes to the player, only the hash is stored."""
    token = secrets.token_urlsafe(SUBMIT_TOKEN_BYTES)
    return token, hash_submit_token(token)


def submit_token_matches(token: str, stored_hash: object) -> bool:
    """Constant-time check of a presented token against the stored hash (``False`` for anything odd)."""
    if not isinstance(stored_hash, str) or not token or len(token) > SUBMIT_TOKEN_MAX_LENGTH:
        return False
    return secrets.compare_digest(
        hash_submit_token(token).encode("ascii"), stored_hash.encode("utf-8", "replace")
    )


def get_client_ip(request: Request) -> str:
    """Client IP for throttling / logs.

    Behind ``TRUSTED_PROXY_HOPS`` reverse proxies (default 1: the gateway / ingress) the address is the
    one the last trusted proxy appended to ``X-Forwarded-For`` (counted from the RIGHT). Entries further
    left were sent by the client and are never trusted, so rotating the header cannot dodge the login
    throttle. Without the header (or with ``TRUSTED_PROXY_HOPS=0``) the TCP peer is used.
    """
    hops = settings.TRUSTED_PROXY_HOPS
    forwarded = request.headers.get("x-forwarded-for") if hops > 0 else None
    if forwarded:
        parts = [part.strip() for part in forwarded.split(",") if part.strip()]
        if parts:
            return parts[max(0, len(parts) - hops)][:64]
    return request.client.host if request.client else "unknown"


class ThrottleStatus(NamedTuple):
    """Where a key stands: seconds until it is no longer ``throttled`` / ``locked`` (0 = it is not)."""

    throttled_for: int = 0  # >= LOGIN_MAX_FAILURES failures in the window
    locked_for: int = 0  # >= LOGIN_HARD_MAX_FAILURES failures in the window

    @property
    def throttled(self) -> bool:
        return self.throttled_for > 0

    @property
    def locked(self) -> bool:
        return self.locked_for > 0


class LoginThrottle:
    """Sliding-window failure counter keyed by an arbitrary string (``ip|username``), see the module docstring."""

    MAX_KEYS = 10_000

    def __init__(
        self,
        max_failures: Callable[[], int] | None = None,
        window_seconds: Callable[[], float] | None = None,
        clock: Callable[[], float] = time.monotonic,
        hard_max_failures: Callable[[], int] | None = None,
    ):
        self._max_failures = max_failures or (lambda: settings.LOGIN_MAX_FAILURES)
        self._hard_max_failures = hard_max_failures or (lambda: settings.LOGIN_HARD_MAX_FAILURES)
        self._window = window_seconds or (lambda: settings.LOGIN_WINDOW_SECONDS)
        self._clock = clock
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _limits(self) -> tuple[int, int]:
        soft = self._max_failures()
        return soft, max(soft, self._hard_max_failures())  # the hard limit is never below the soft one

    def _prune(self, key: str, now: float) -> deque[float] | None:
        attempts = self._failures.get(key)
        if attempts is None:
            return None
        cutoff = now - self._window()
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if not attempts:
            del self._failures[key]
            return None
        return attempts

    def _seconds_until_below(self, attempts: deque[float], limit: int, now: float) -> int:
        """Seconds until fewer than ``limit`` failures remain (``len(attempts) >= limit``): the failure at
        index ``len - limit`` (oldest first) has to leave the window."""
        expiring = attempts[len(attempts) - limit]
        return max(1, int(expiring + self._window() - now) + 1)

    def status(self, key: str) -> ThrottleStatus:
        """Throttled / locked state of ``key`` (one lock acquisition, so both numbers are consistent)."""
        with self._lock:
            now = self._clock()
            attempts = self._prune(key, now)
            if attempts is None:
                return ThrottleStatus()
            soft, hard = self._limits()
            count = len(attempts)
            return ThrottleStatus(
                throttled_for=self._seconds_until_below(attempts, soft, now) if count >= soft else 0,
                locked_for=self._seconds_until_below(attempts, hard, now) if count >= hard else 0,
            )

    def retry_after(self, key: str) -> int:
        """Seconds until ``key`` is no longer throttled (0 when it is not)."""
        return self.status(key).throttled_for

    def record_failure(self, key: str) -> None:
        with self._lock:
            now = self._clock()
            if key not in self._failures and len(self._failures) >= self.MAX_KEYS:
                self._evict(now)
            attempts = self._prune(key, now)
            if attempts is not None and len(attempts) >= self._limits()[1]:
                return  # locked: nothing more to learn, and the list stays bounded
            self._failures.setdefault(key, deque()).append(now)

    def reset(self, key: str | None = None) -> None:
        """Forget failures for ``key`` (successful login) or everything (tests)."""
        with self._lock:
            if key is None:
                self._failures.clear()
            else:
                self._failures.pop(key, None)

    def _evict(self, now: float) -> None:
        for k in list(self._failures):
            self._prune(k, now)
        if len(self._failures) >= self.MAX_KEYS:  # still full: drop the oldest quarter
            for k in sorted(self._failures, key=lambda x: self._failures[x][-1])[: self.MAX_KEYS // 4]:
                del self._failures[k]


login_throttle = LoginThrottle()


def throttle_key(ip: str, username: str) -> str:
    return f"{ip}|{username.strip().lower()[:100]}"
