"""
Shared pytest fixtures for the backend test-suite.

Environment is forced BEFORE ``app`` is imported: SQLite in-memory (StaticPool, ``PRAGMA foreign_keys=ON``,
see ``app.database.make_engine``), ``USE_ALEMBIC=false`` (schema through ``create_all``), no seeding,
a strong test SECRET_KEY, admin/admin. Set ``TEST_DATABASE_URL`` (e.g. a throw-away PostgreSQL) to run
the very same suite against another database.

Fixture API (all function scoped, the schema is dropped and re-created before every test)
------------------------------------------------------------------------------------------
db                      SQLAlchemy ``Session`` on the app engine (``expire_all`` is called after every
                        ``client`` request, so ORM objects reflect what the API wrote)
client                  ``TestClient`` (lifespan on, ``get_db`` overridden), ``client.headers`` untouched
admin_headers           ``{"Authorization": "Bearer <jwt>"}`` obtained through ``POST /api/auth/login``
make_event(**kw)        -> Event          persisted, defaults: live, en/fr, slug "event-N"
make_category(event=None, **kw)           -> Category      (event auto-created when omitted)
make_question(event=None, category=None, **kw) -> Question (true_false, green is correct, difficulty 1)
make_player(event=None, **kw)             -> Player
make_game_session(event=None, player=None, status="completed", answers=None, **kw) -> GameSession
                        ``answers`` = list of dicts {question, player_answer, is_correct?, time_taken?,
                        points_earned?}; counts / total_score are derived unless given explicitly
sample_bundle()         -> dict   a fresh, VALID event bundle v1 (slug "sample-event", 2 categories, 4 questions:
                        2 true_false + 2 two_choices, category_distribution keyed by name) - for import/export/seed tests
app_settings            the live ``app.config.settings`` (use ``monkeypatch.setattr`` to tweak it)
"""
import itertools
import os

os.environ["APP_ENV"] = "test"
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or "sqlite://"
os.environ["USE_ALEMBIC"] = "false"
os.environ["SEED_ON_STARTUP"] = "false"
os.environ["SECRET_KEY"] = "pytest-secret-key-0123456789-0123456789-abcdef"
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin"
os.environ["ENABLE_DOCS"] = "true"
os.environ["LOGIN_MAX_FAILURES"] = "10"
os.environ["LOGIN_WINDOW_SECONDS"] = "300"
os.environ["ACCESS_TOKEN_EXPIRE_MINUTES"] = "60"
os.environ["LOG_LEVEL"] = "WARNING"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import Base, engine, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Category,
    Event,
    GameAnswer,
    GameSession,
    Player,
    Question,
    utcnow,
)
from app.security import login_throttle  # noqa: E402

TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
def _fresh_database():
    """Empty schema + empty login throttle for every test."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    login_throttle.reset()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def app_settings():
    return settings


@pytest.fixture
def db():
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


class _SyncedClient(TestClient):
    """TestClient that refreshes the test ``db`` session after each request."""

    db_session = None

    def request(self, *args, **kwargs):
        response = super().request(*args, **kwargs)
        if self.db_session is not None:
            self.db_session.expire_all()
        return response


@pytest.fixture
def client(db):
    def override_get_db():
        session = TestingSessionLocal()
        try:
            yield session
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    with _SyncedClient(app) as test_client:
        test_client.db_session = db
        yield test_client


@pytest.fixture
def admin_headers(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


# ---------------------------------------------------------------------------------------------
# Factories
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def make_event(db):
    counter = itertools.count(1)

    def _make(**kwargs) -> Event:
        n = next(counter)
        values = {
            "slug": f"event-{n}",
            "name": f"Event {n}",
            "game_title": "API Masters",
            "status": "live",
            "languages": ["en", "fr"],
            "default_language": "en",
        }
        values.update(kwargs)
        event = Event(**values)
        db.add(event)
        db.commit()
        return event

    return _make


@pytest.fixture
def make_category(db, make_event):
    counter = itertools.count(1)

    def _make(event: Event | None = None, **kwargs) -> Category:
        n = next(counter)
        event = event or make_event()
        values = {"event_id": event.id, "name": f"Category {n}", "name_fr": f"Catégorie {n}", "color": "#7C5CFF"}
        values.update(kwargs)
        category = Category(**values)
        db.add(category)
        db.commit()
        return category

    return _make


@pytest.fixture
def make_question(db, make_event):
    counter = itertools.count(1)

    def _make(event: Event | None = None, category: Category | None = None, **kwargs) -> Question:
        n = next(counter)
        if event is None:
            event = db.get(Event, category.event_id) if category else make_event()
        values = {
            "event_id": event.id,
            "category_id": category.id if category else None,
            "question_format": "true_false",
            "question_text_en": f"Question {n}?",
            "question_text_fr": f"Question {n} ?",
            "correct_answer": "green",
            "difficulty": 1,
            "is_active": True,
            "explanation_en": f"Explanation {n}.",
            "explanation_fr": f"Explication {n}.",
        }
        if kwargs.get("question_format") == "two_choices":
            values.update(
                green_label_en="Option A", green_label_fr="Option A", red_label_en="Option B", red_label_fr="Option B"
            )
        else:
            values.update(green_label_en="TRUE", green_label_fr="Vrai", red_label_en="FALSE", red_label_fr="Faux")
        values.update(kwargs)
        question = Question(**values)
        db.add(question)
        db.commit()
        return question

    return _make


@pytest.fixture
def make_player(db, make_event):
    counter = itertools.count(1)

    def _make(event: Event | None = None, **kwargs) -> Player:
        n = next(counter)
        event = event or make_event()
        values = {
            "event_id": event.id,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "email": f"player{n}@example.com",
        }
        values.update(kwargs)
        player = Player(**values)
        db.add(player)
        db.commit()
        return player

    return _make


@pytest.fixture
def make_game_session(db, make_event, make_player):
    def _make(
        event: Event | None = None,
        player: Player | None = None,
        status: str = "completed",
        answers: list[dict] | None = None,
        **kwargs,
    ) -> GameSession:
        if event is None:
            event = db.get(Event, player.event_id) if player else make_event()
        player = player or make_player(event)
        values = {"event_id": event.id, "player_id": player.id, "status": status}
        if status == "completed":
            values["completed_at"] = utcnow()
        if answers:
            rows = []
            for order, spec in enumerate(answers, start=1):
                answer = spec.get("player_answer")
                is_correct = spec.get("is_correct", None if answer is None else answer == spec["question"].correct_answer)
                rows.append(
                    GameAnswer(
                        question_id=spec["question"].id,
                        question_order=order,
                        player_answer=answer,
                        is_correct=is_correct,
                        time_taken=spec.get("time_taken", 5.0 if answer else None),
                        points_earned=spec.get("points_earned", 100 if is_correct else 0),
                    )
                )
            values.setdefault("correct_answers", sum(1 for r in rows if r.is_correct))
            values.setdefault("wrong_answers", sum(1 for r in rows if r.is_correct is False))
            values.setdefault("unanswered", sum(1 for r in rows if r.player_answer is None))
            values.setdefault("total_score", sum(r.points_earned for r in rows))
        else:
            rows = []
        values.update(kwargs)
        session = GameSession(**values)
        session.answers = rows
        db.add(session)
        db.commit()
        return session

    return _make


# ---------------------------------------------------------------------------------------------
# Bundle sample
# ---------------------------------------------------------------------------------------------
def _sample_bundle() -> dict:
    def tf(category, text_en, text_fr, correct, difficulty):
        return {
            "category": category, "question_format": "true_false", "difficulty": difficulty,
            "question_text_en": text_en, "question_text_fr": text_fr, "correct_answer": correct,
            "green_label_en": "TRUE", "green_label_fr": "Vrai", "red_label_en": "FALSE", "red_label_fr": "Faux",
            "explanation_en": "Because.", "explanation_fr": "Parce que.", "is_active": True,
        }

    def two(category, text_en, text_fr, correct, difficulty, green, red):
        return {
            "category": category, "question_format": "two_choices", "difficulty": difficulty,
            "question_text_en": text_en, "question_text_fr": text_fr, "correct_answer": correct,
            "green_label_en": green[0], "green_label_fr": green[1], "red_label_en": red[0], "red_label_fr": red[1],
            "explanation_en": "Because.", "explanation_fr": "Parce que.", "is_active": True,
        }

    return {
        "format": "gravitee-quiz-event",
        "version": 1,
        "event": {
            "slug": "sample-event", "name": "Sample Event", "game_title": "Sample Masters", "status": "live",
            "hero_title_en": "Become THE Sample Master!", "hero_title_fr": "Devenez LE Sample Master !",
            "tagline_en": "Fast answers win", "tagline_fr": "Les réponses rapides gagnent",
            "description_en": "A sample event.", "description_fr": "Un évènement exemple.",
            "location": "Paris", "starts_on": "2026-10-07", "ends_on": "2026-10-08",
            "languages": ["en", "fr"], "default_language": "en",
            "branding": {"primary_color": "#7C5CFF", "accent_color": "#22D3EE", "background_style": "aurora",
                         "logo_url": None, "default_theme": "dark", "show_join_qr": True},
            "settings": {"questions_per_game": 2, "timer_seconds": 20, "points_correct": 100, "points_wrong": 0,
                         "time_bonus_max": 50, "category_distribution": {"Alpha": 50, "Beta": 50},
                         "question_order": "random", "collect_phone": "optional",
                         "consent_text_en": None, "consent_text_fr": None},
        },
        "categories": [
            {"name": "Alpha", "name_fr": "Alpha FR", "description": "First", "description_fr": "Premier",
             "color": "#7C5CFF", "is_active": True},
            {"name": "Beta", "name_fr": None, "description": None, "description_fr": None,
             "color": "#FC5607", "is_active": True},
        ],
        "questions": [
            tf("Alpha", "Alpha is first?", "Alpha est premier ?", "green", 1),
            tf("Alpha", "Alpha is last?", "Alpha est dernier ?", "red", 2),
            two("Beta", "Pick the proxy", "Choisissez le proxy", "green", 2, ("LLM Proxy", "Proxy LLM"), ("MCP Proxy", "Proxy MCP")),
            two("Beta", "Pick the verb", "Choisissez le verbe", "red", 3, ("GET", "GET"), ("POST", "POST")),
        ],
    }


@pytest.fixture
def sample_bundle():
    return _sample_bundle
