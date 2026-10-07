# Gravitee Quiz Events - backend (FastAPI + Alembic migrations at start-up)
#
# The build context is the REPOSITORY ROOT (the image also ships events/*.json, the seed bundles):
#
#   docker build -f backend/Dockerfile -t quiz-backend:dev .
#   docker build -f backend/Dockerfile --platform linux/amd64 -t dobl1/quiz-backend:2.0.0 .   # AKS target
#
# Only what runs is copied (app, alembic, requirements): .venv, tests and caches never enter the image,
# whatever .dockerignore files are in use.
#
# Runtime contract: DATABASE_URL, SECRET_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, APP_ENV, CORS_ORIGINS ...
# (see backend/app/config.py). APP_ENV is deliberately NOT set here: unset means "dev" so a plain
# `docker run` / docker-compose works with the dev credentials; Kubernetes sets APP_ENV=production, which
# makes the app refuse to start with default secrets.
#
# One uvicorn worker on purpose: the scoreboard SSE hub is in-process (scale with replicas, not workers).
# --no-access-log: the app writes its own one-line access log (app.access: method, path, status, time, no query
# string), uvicorn's would duplicate it and print query strings (e.g. an admin search for an e-mail address).
FROM python:3.12-slim

LABEL org.opencontainers.image.title="quiz-backend" \
      org.opencontainers.image.description="Gravitee Quiz Events API (FastAPI)" \
      org.opencontainers.image.vendor="Gravitee"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first (cached layer). Every requirement ships a manylinux wheel for CPython 3.12 on amd64 and
# arm64 (psycopg2-binary, cryptography, pydantic-core, uvloop, httptools...), so no compiler and no
# libpq-dev are needed, neither to build nor in the final image.
COPY backend/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

# Application, migrations and seed bundles (events/ may hold no .json yet: BuildKit accepts an empty glob;
# the mkdir guarantees the directory exists either way)
RUN mkdir -p /app/seed/events
COPY backend/alembic.ini ./alembic.ini
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY event[s]/*.json /app/seed/events/

# Non-root user (numeric uid/gid so Kubernetes runAsNonRoot can verify it); code stays root-owned, read-only
RUN groupadd --system --gid 10001 quiz \
    && useradd --system --uid 10001 --gid quiz --no-create-home --shell /usr/sbin/nologin quiz \
    && chmod -R a+rX /app
USER 10001:10001

EXPOSE 8000

# start-period covers the Alembic migration that runs before the app answers
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-graceful-shutdown", "10", "--no-access-log", "--no-server-header"]
