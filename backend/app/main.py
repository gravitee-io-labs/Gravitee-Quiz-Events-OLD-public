"""
Gravitee Quiz Events API (FastAPI).

Mounting (docs/ARCHITECTURE.md section 5):
    /livez, /api/livez                    liveness (no database)
    /health, /api/health                  readiness (checks the database)
    /api/auth/*                           admin login / logout / me
    /api/events...                        public: events, players, games, scoreboard (+ SSE)
    /api/admin/...                        admin (EVERY route requires an admin Bearer token)
"""
import contextvars
import logging
import math
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError

from app.auth import require_admin
from app.config import settings
from app.database import init_db
from app.routers import (
    admin_categories,
    admin_events,
    admin_questions,
    admin_results,
    games,
    health,
    public_events,
    scoreboard,
)
from app.routers import auth as auth_router

API_VERSION = "2.0.0"
LOG_FORMAT = "%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s"
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_QUIET_PATHS = {"/health", "/api/health", "/livez", "/api/livez"}  # probes: logged at DEBUG only
_NO_STORE_PREFIXES = ("/api/admin/", "/api/auth/")  # personal data / tokens: never cached by a proxy or browser

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")
logger = logging.getLogger("app.main")
access_logger = logging.getLogger("app.access")


# ---------------------------------------------------------------------------------------------
# Logging + request id
# ---------------------------------------------------------------------------------------------
def configure_logging() -> None:
    """Idempotent: add ``request_id`` to every log record and set up the root logger if bare."""
    current_factory = logging.getLogRecordFactory()
    if not getattr(current_factory, "_has_request_id", False):

        def factory(*args, **kwargs):
            record = current_factory(*args, **kwargs)
            record.request_id = request_id_var.get()
            return record

        factory._has_request_id = True  # type: ignore[attr-defined]
        logging.setLogRecordFactory(factory)

    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO), format=LOG_FORMAT)


class RequestIdMiddleware:
    """Pure ASGI middleware (safe for SSE): X-Request-ID in/out, one access-log line per request, and the
    response headers every API answer should carry (``nosniff``; ``no-store`` for admin / auth routes)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode("latin-1")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex[:16]
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status_code = 500

        async def send_with_id(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = list(message.get("headers") or [])
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                headers.append((b"x-content-type-options", b"nosniff"))
                if scope["path"].startswith(_NO_STORE_PREFIXES) and not any(k == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", b"no-store"))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            access_logger.exception("%s %s -> unhandled error", scope["method"], scope["path"])
            raise
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            if scope["path"] in _QUIET_PATHS:
                level = logging.DEBUG
            elif status_code >= 500:
                level = logging.ERROR
            elif status_code >= 400:
                level = logging.WARNING
            else:
                level = logging.INFO
            access_logger.log(
                level, "%s %s -> %s (%.0f ms)", scope["method"], scope["path"], status_code, elapsed_ms
            )
            request_id_var.reset(token)


# ---------------------------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    settings.assert_production_ready()  # RuntimeError => the server refuses to start
    if not settings.is_production and (settings.ADMIN_PASSWORD == "admin"):
        logger.warning("Using the default admin credentials (fine for %s, never in production)", settings.APP_ENV)
    logger.info("Starting Gravitee Quiz Events API %s (env=%s)", API_VERSION, settings.APP_ENV)
    init_db()
    yield
    logger.info("Shutting down Gravitee Quiz Events API")


app = FastAPI(
    title="Gravitee Quiz Events API",
    description="Multi-event quiz platform: events, branding, questions, games, scoreboard and admin.",
    version=API_VERSION,
    lifespan=lifespan,
    root_path=settings.BASE_PATH,
    docs_url="/api/docs" if settings.ENABLE_DOCS else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if settings.ENABLE_DOCS else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "Content-Disposition", "Retry-After"],
)
app.add_middleware(RequestIdMiddleware)  # outermost: also tags CORS preflights

# Every admin router is mounted with the admin guard, whatever the router itself declares.
ADMIN_GUARD = [Depends(require_admin)]

app.include_router(health.router)
app.include_router(auth_router.router, prefix="/api/auth")
app.include_router(public_events.router, prefix="/api/events", tags=["Public - Events"])
app.include_router(games.router, prefix="/api/events", tags=["Public - Games"])
app.include_router(scoreboard.router, prefix="/api/events", tags=["Public - Scoreboard"])
app.include_router(admin_events.router, prefix="/api/admin", tags=["Admin - Events"], dependencies=ADMIN_GUARD)
app.include_router(
    admin_categories.router, prefix="/api/admin", tags=["Admin - Categories"], dependencies=ADMIN_GUARD
)
app.include_router(
    admin_questions.router, prefix="/api/admin", tags=["Admin - Questions"], dependencies=ADMIN_GUARD
)
app.include_router(admin_results.router, prefix="/api/admin", tags=["Admin - Results"], dependencies=ADMIN_GUARD)


@app.get("/", include_in_schema=False)
def root():
    return {"name": "Gravitee Quiz Events API", "version": API_VERSION, "status": "running"}


# ---------------------------------------------------------------------------------------------
# Error handling: never a 500 for bad client input, never an internal detail in a response
# ---------------------------------------------------------------------------------------------
def _json_safe(value: Any) -> Any:
    """Make a validation-error fragment serialisable: NaN / inf and lone surrogates (both legal in a
    Python object, both fatal for ``JSONResponse``) become plain strings."""
    if isinstance(value, str):
        return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, (bool, int)):
        return value
    return str(value)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request, exc: RequestValidationError):
    """FastAPI's ``{"detail": [{type, loc, msg}]}`` 422, without echoing the submitted ``input``.

    The stock handler answers 500 when the input holds NaN (``time_taken: NaN``) or a lone surrogate
    (``"\\ud800"``), because it puts the offending input back into the JSON body.
    """
    detail = [
        {"type": _json_safe(err.get("type")), "loc": _json_safe(err.get("loc", ())), "msg": _json_safe(err.get("msg"))}
        for err in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(DataError)
async def data_error_handler(_request, exc: DataError):
    """A value the database cannot store (integer out of range, ...): the client's fault."""
    logger.warning("Unstorable value rejected: %s", str(exc.orig).splitlines()[0] if exc.orig else "DataError")
    return JSONResponse(status_code=422, content={"detail": "A value is out of range or cannot be stored"})


@app.exception_handler(ValueError)
async def value_error_handler(_request, exc: ValueError):
    """psycopg2 raises a bare ``ValueError`` for NUL (0x00) characters (PostgreSQL text cannot hold
    them) and ``UnicodeEncodeError`` for lone surrogates: both come from client input. Any other
    ``ValueError`` is a bug: logged, answered as a plain 500."""
    if isinstance(exc, UnicodeEncodeError) or "NUL (0x00)" in str(exc):
        logger.warning("Unstorable text rejected: %s", type(exc).__name__)
        return JSONResponse(
            status_code=422, content={"detail": "Text cannot contain NUL characters or invalid Unicode"}
        )
    access_logger.error("%s (unhandled ValueError)", exc, exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request, _exc):
    # details are logged by RequestIdMiddleware; never leak internals to clients
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
