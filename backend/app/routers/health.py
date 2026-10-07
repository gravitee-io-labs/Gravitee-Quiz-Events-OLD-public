"""
Health endpoints.

* ``GET /livez`` and ``GET /api/livez``  LIVENESS: no database, no dependency, always ``200 {"status":"ok"}``
  while the process answers. A Kubernetes liveness probe must use this one: restarting a healthy pod
  because PostgreSQL is briefly unreachable only makes an outage worse. It is ``async`` on purpose: it is
  served straight from the event loop, so it still answers when the threadpool is saturated by slow
  database requests (a probe stuck behind them would get the pod killed in the middle of the event).
* ``GET /health`` and ``GET /api/health``  READINESS: checks the database with ``SELECT 1``
  (503 ``{"status":"error","db":"error"}`` when it is unreachable, so the pod leaves the Service
  endpoints until the database is back).
"""
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import HealthStatus, LiveStatus

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Health"])


def _check(db: Session):
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Health check: database unreachable")
        return JSONResponse(status_code=503, content={"status": "error", "db": "error"})
    return HealthStatus(status="ok", db="ok")


@router.get("/health", response_model=HealthStatus, responses={503: {"model": HealthStatus}})
def health(db: Session = Depends(get_db)):
    return _check(db)


@router.get("/api/health", response_model=HealthStatus, responses={503: {"model": HealthStatus}})
def api_health(db: Session = Depends(get_db)):
    return _check(db)


@router.get("/livez", response_model=LiveStatus, summary="Liveness probe (no database)")
@router.get("/api/livez", response_model=LiveStatus, include_in_schema=False)
async def livez():
    return LiveStatus()
