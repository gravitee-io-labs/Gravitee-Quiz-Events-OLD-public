import pytest
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError

from app.database import engine
from app.models import (
    NAMING_CONVENTION,
    Base,
    Category,
    Event,
    GameAnswer,
    GameSession,
    Player,
    Question,
)


def _count(db, model):
    return db.scalar(select(text("count(*)")).select_from(model))


def _populate(db, make_event, make_category, make_question, make_player, make_game_session):
    event = make_event()
    category = make_category(event)
    q1 = make_question(event, category)
    q2 = make_question(event)
    session = make_game_session(
        event,
        answers=[{"question": q1, "player_answer": "green"}, {"question": q2, "player_answer": "red"}],
    )
    return event, category, q1, q2, session


def test_sqlite_foreign_keys_are_enforced(db, make_event):
    if engine.dialect.name != "sqlite":
        pytest.skip("sqlite only")
    assert db.execute(text("PRAGMA foreign_keys")).scalar() == 1
    db.add(Category(event_id=9999, name="orphan"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_deleting_an_event_removes_everything(db, make_event, make_category, make_question, make_player, make_game_session):
    event, *_ = _populate(db, make_event, make_category, make_question, make_player, make_game_session)
    other, *_ = _populate(db, make_event, make_category, make_question, make_player, make_game_session)

    db.delete(event)
    db.commit()

    # only the other event's data remains
    assert _count(db, Event) == 1
    assert _count(db, Category) == 1
    assert _count(db, Question) == 2
    assert _count(db, Player) == 1
    assert _count(db, GameSession) == 1
    assert _count(db, GameAnswer) == 2
    assert db.scalar(select(Event.id)) == other.id


def test_bulk_delete_statement_cascades_at_database_level(db, make_event, make_category, make_question, make_player, make_game_session):
    event, *_ = _populate(db, make_event, make_category, make_question, make_player, make_game_session)
    db.execute(text("DELETE FROM events WHERE id = :id"), {"id": event.id})
    db.commit()
    for model in (Event, Category, Question, Player, GameSession, GameAnswer):
        assert _count(db, model) == 0


def test_deleting_a_category_uncategorises_its_questions(db, make_event, make_category, make_question):
    event = make_event()
    category = make_category(event)
    question = make_question(event, category)
    db.delete(category)
    db.commit()
    db.expire_all()
    assert db.get(Question, question.id).category_id is None


def test_deleting_a_question_removes_its_answers_only(db, make_event, make_category, make_question, make_player, make_game_session):
    event, _category, q1, q2, session = _populate(db, make_event, make_category, make_question, make_player, make_game_session)
    db.delete(q1)
    db.commit()
    db.expire_all()
    assert _count(db, GameAnswer) == 1
    assert db.get(GameSession, session.id) is not None
    assert db.get(Question, q2.id) is not None


def test_deleting_a_game_session_removes_answers_and_keeps_player(db, make_event, make_category, make_question, make_player, make_game_session):
    _event, _c, _q1, _q2, session = _populate(db, make_event, make_category, make_question, make_player, make_game_session)
    player_id = session.player_id
    db.delete(session)
    db.commit()
    assert _count(db, GameAnswer) == 0
    assert db.get(Player, player_id) is not None


def test_category_name_is_unique_per_event_only(db, make_event, make_category):
    a, b = make_event(), make_event()
    make_category(a, name="Security")
    make_category(b, name="Security")  # same name, other event: fine
    db.add(Category(event_id=a.id, name="Security"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_event_slug_is_unique(db, make_event):
    make_event(slug="dup")
    db.add(Event(slug="dup", name="x", game_title="y"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


@pytest.mark.parametrize(
    "field,value",
    [
        ("status", "archived"),
        ("question_order", "alphabetical"),
        ("collect_phone", "always"),
        ("default_language", "de"),
        ("questions_per_game", 0),
        ("questions_per_game", 51),
        ("timer_seconds", 4),
        ("timer_seconds", 121),
        ("points_correct", -1),
        ("points_wrong", -1),
        ("time_bonus_max", -1),
    ],
)
def test_event_check_constraints(db, make_event, field, value):
    with pytest.raises(IntegrityError):
        make_event(**{field: value})
    db.rollback()


@pytest.mark.parametrize(
    "field,value",
    [("question_format", "multiple"), ("difficulty", 0), ("difficulty", 6), ("correct_answer", "blue")],
)
def test_question_check_constraints(db, make_event, make_question, field, value):
    event = make_event()
    with pytest.raises(IntegrityError):
        make_question(event, **{field: value})
    db.rollback()


def test_event_defaults(db):
    event = Event(slug="defaults", name="Defaults", game_title="Quiz")
    db.add(event)
    db.commit()
    assert event.status == "draft"
    assert event.languages == ["en", "fr"] and event.default_language == "en"
    assert event.branding["primary_color"] == "#FC5607"
    assert (event.questions_per_game, event.timer_seconds) == (15, 20)
    assert (event.points_correct, event.points_wrong, event.time_bonus_max) == (100, 0, 50)
    assert event.question_order == "random" and event.collect_phone == "optional"
    assert event.category_distribution is None
    assert event.created_at and event.updated_at


def test_json_columns_track_in_place_mutation(db, make_event):
    event = make_event(category_distribution={"1": 50})
    event.branding["primary_color"] = "#112233"
    event.languages.append("de")
    event.category_distribution["2"] = 50
    db.commit()
    db.expire_all()
    fresh = db.get(Event, event.id)
    assert fresh.branding["primary_color"] == "#112233"
    assert fresh.languages[-1] == "de"
    assert fresh.category_distribution == {"1": 50, "2": 50}


def test_naming_convention_is_applied():
    assert Base.metadata.naming_convention == NAMING_CONVENTION
    tables = Base.metadata.tables
    events = tables["events"]
    names = {c.name for c in events.constraints}
    assert {"uq_events_slug", "pk_events", "ck_events_status_valid", "ck_events_timer_seconds_range"} <= names
    assert "uq_categories_event_id_name" in {c.name for c in tables["categories"].constraints}
    assert "fk_categories_event_id_events" in {c.name for c in tables["categories"].constraints}
    assert "fk_questions_category_id_categories" in {c.name for c in tables["questions"].constraints}
    assert "fk_game_answers_game_session_id_game_sessions" in {c.name for c in tables["game_answers"].constraints}
    index_names = {i.name for t in tables.values() for i in t.indexes}
    assert "ix_game_sessions_event_status_score" in index_names
    assert {"ix_categories_event_id", "ix_questions_event_id", "ix_players_event_id"} <= index_names
    assert all(len(n) <= 63 for t in tables.values() for n in [c.name for c in t.constraints if c.name] + [i.name for i in t.indexes])


def test_schema_has_expected_tables_and_columns():
    inspector = inspect(engine)
    assert {"events", "categories", "questions", "players", "game_sessions", "game_answers", "users"} <= set(
        inspector.get_table_names()
    )
    assert "game_settings" not in Base.metadata.tables  # legacy table is no longer modelled
    event_cols = {c["name"] for c in inspector.get_columns("events")}
    assert {
        "slug", "name", "game_title", "status", "hero_title_en", "hero_title_fr", "tagline_en", "tagline_fr",
        "description_en", "description_fr", "location", "starts_on", "ends_on", "languages", "default_language",
        "branding", "questions_per_game", "timer_seconds", "points_correct", "points_wrong", "time_bonus_max",
        "category_distribution", "question_order", "collect_phone", "consent_text_en", "consent_text_fr",
        "created_at", "updated_at",
    } <= event_cols
    assert {"event_id", "name_fr", "description_fr"} <= {c["name"] for c in inspector.get_columns("categories")}
    assert {"event_id", "question_format"} <= {c["name"] for c in inspector.get_columns("questions")}
    assert {"event_id", "consent_at"} <= {c["name"] for c in inspector.get_columns("players")}
    assert "event_id" in {c["name"] for c in inspector.get_columns("game_sessions")}
    question_fr = next(c for c in inspector.get_columns("questions") if c["name"] == "question_text_fr")
    assert question_fr["nullable"] is True
