"""
Application configuration (environment variables / optional ``.env``).

Game rules are NOT configured here any more: they live on each ``Event`` (defaults in
``app.models.DEFAULT_SETTINGS`` / ``app.schemas.EventSettings``).

Game integrity (``REQUIRE_SUBMIT_TOKEN``, rolled out in two stages)
-------------------------------------------------------------------
``POST /api/events/{slug}/games`` returns a random ``submit_token`` (128 bit, URL safe) that only the
player who started the game knows; the server keeps just its SHA-256 in ``game_sessions.game_config``.
``POST .../games/{id}/submit`` accepts it as the JSON field ``submit_token`` or the ``X-Game-Token``
header (compared in constant time). Without it, anybody who can guess the sequential game id could submit
(and so spoil) somebody else's game.

* ``REQUIRE_SUBMIT_TOKEN=false`` (default, stage 1): a submit WITHOUT a token is still accepted, so frontends
  that do not send it yet keep working; a token that IS present but wrong is always refused.
* ``REQUIRE_SUBMIT_TOKEN=true`` (stage 2): a missing or wrong token is refused, in both cases with
  ``403 {"detail": "invalid_game_token"}``. Switch it on only once every frontend sends the token. Games
  started before the token existed (no stored hash) can no longer be submitted after the switch.
"""
import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

DEFAULT_SECRET_KEY = "your-secret-key-change-in-production"
MIN_PRODUCTION_SECRET_LENGTH = 32
DEFAULT_SEED_DIR = "/app/seed/events"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Runtime -------------------------------------------------------------------------------
    APP_ENV: Literal["dev", "test", "production"] = "dev"
    BASE_PATH: str = ""  # reverse-proxy sub-path ("" = served at the root)
    ENABLE_DOCS: bool = True  # /api/docs + /api/openapi.json
    LOG_LEVEL: str = "INFO"

    # --- Database ------------------------------------------------------------------------------
    DATABASE_URL: str = "postgresql://quiz_user:quiz_password@db:5432/gravitee_quiz"
    # Per process. 300 players registering / starting / submitting within a minute plus 100 scoreboard
    # viewers never used more than ~12 connections (requests hold one for a few ms, the SSE hub shares
    # one short-lived session per event). 10 + 10 per replica keeps 3 pods (rolling update) well below
    # PostgreSQL's default max_connections of 100.
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 10
    DB_POOL_TIMEOUT: int = 15  # seconds a request waits for a free connection before failing
    DB_POOL_RECYCLE: int = 3600
    USE_ALEMBIC: bool = True  # tests set false and use create_all
    SEED_ON_STARTUP: bool = True  # seed events/api-masters.json when the DB has no event
    SEED_DIR: str = DEFAULT_SEED_DIR

    # --- Security ------------------------------------------------------------------------------
    SECRET_KEY: str = DEFAULT_SECRET_KEY
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    # Login throttle (see ``app.security``), failures counted per (client ip, username) over a sliding window:
    #  * from LOGIN_MAX_FAILURES on, a WRONG password answers 429 + Retry-After instead of 401 (a correct one
    #    still logs in: behind a shared proxy IP a stranger must not be able to lock the real admin out);
    #  * from LOGIN_HARD_MAX_FAILURES on, EVERY attempt answers 429 without even checking the password, until
    #    old failures leave the window. That hard limit is what caps password guessing (at most that many
    #    wrong guesses are ever evaluated per window and key). Set it equal to LOGIN_MAX_FAILURES for the
    #    strict "lock after N failures, even for the right password" behaviour.
    LOGIN_MAX_FAILURES: int = 10
    LOGIN_HARD_MAX_FAILURES: int = Field(50, ge=1)
    LOGIN_WINDOW_SECONDS: int = 300
    # Reverse proxies in front of the API that APPEND the peer they saw to X-Forwarded-For (gateway nginx
    # in docker-compose, ingress-nginx on AKS: 1). The client IP is the entry added by the LAST trusted
    # proxy, counted from the right, because everything left of it is client controlled (spoofable).
    # 0 = ignore X-Forwarded-For and use the TCP peer (backend exposed directly, no proxy).
    TRUSTED_PROXY_HOPS: int = Field(1, ge=0, le=5)
    # Per-game submit token (see the module docstring): false = a missing token is tolerated (a wrong one is
    # not), true = a missing / wrong token is a 403 invalid_game_token.
    REQUIRE_SUBMIT_TOKEN: bool = False

    # --- CORS ----------------------------------------------------------------------------------
    # Same-origin behind the gateway/ingress needs no CORS; these are for local tooling.
    CORS_ORIGINS: Annotated[list[str], NoDecode] = [
        "http://localhost:8080",
        "http://localhost:8081",
        "http://localhost:8082",
    ]

    @field_validator("APP_ENV", mode="before")
    @classmethod
    def _normalise_app_env(cls, v):
        return v.strip().lower() if isinstance(v, str) else v

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _parse_cors_origins(cls, v):
        """Accept a comma separated string or a JSON array."""
        if isinstance(v, str):
            s = v.strip()
            if s.startswith("["):
                return json.loads(s)
            return [origin.strip() for origin in s.split(",") if origin.strip()]
        return v

    @field_validator("BASE_PATH")
    @classmethod
    def _normalise_base_path(cls, v: str) -> str:
        v = (v or "").strip()
        if v in ("", "/"):
            return ""
        return "/" + v.strip("/")

    # --- Helpers -------------------------------------------------------------------------------
    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"

    def resolve_seed_dir(self) -> Path:
        """Directory holding the event bundles (``*.json``) used to seed an empty database.

        ``SEED_DIR`` (default ``/app/seed/events``, baked into the image) is used when it exists;
        otherwise fall back to ``<repo>/events`` so ``uvicorn`` works from a plain checkout.
        """
        configured = Path(self.SEED_DIR)
        if configured.is_dir():
            return configured
        return Path(__file__).resolve().parents[2] / "events"

    def production_problems(self) -> list[str]:
        """Reasons why these settings are unsafe for production (empty list = fine)."""
        problems: list[str] = []
        if self.SECRET_KEY == DEFAULT_SECRET_KEY or len(self.SECRET_KEY) < MIN_PRODUCTION_SECRET_LENGTH:
            problems.append(
                f"SECRET_KEY must be set to a random value of at least {MIN_PRODUCTION_SECRET_LENGTH} "
                "characters (it is the default or too short)"
            )
        if not self.ADMIN_PASSWORD or self.ADMIN_PASSWORD == "admin":
            problems.append("ADMIN_PASSWORD must be set and must not be 'admin'")
        if not self.ADMIN_USERNAME:
            problems.append("ADMIN_USERNAME must not be empty")
        return problems

    def assert_production_ready(self) -> None:
        """Startup guard: with APP_ENV=production refuse to run with default/weak credentials."""
        if not self.is_production:
            return
        problems = self.production_problems()
        if problems:
            raise RuntimeError(
                "Refusing to start with APP_ENV=production: " + "; ".join(problems)
            )


settings = Settings()
