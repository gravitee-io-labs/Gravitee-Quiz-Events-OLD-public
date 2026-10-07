from datetime import date, datetime, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event as sa_event

from app.database import engine
from app.models import Event
from app.schemas import EventCreate, EventUpdate
from app.services import broadcaster
from app.services.events import (
    CLOSED_EVENT_SUBMIT_GRACE,
    apply_event_update,
    assert_event_playable,
    build_event,
    display_name,
    event_counts,
    event_to_admin,
    event_to_public,
    event_to_summary,
    events_to_admin,
    get_event_by_id_or_404,
    get_event_by_slug,
    get_event_or_404,
    list_live_events,
    may_submit_after_close,
    public_categories,
)


# ---------------------------------------------------------------------------------------------
# display_name
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "first,last,expected",
    [
        ("Ada", "Lovelace", "Ada L."),
        ("  ada ", " lovelace ", "ada L."),
        ("Jean-Pierre", "de la Cruz", "Jean-Pierre D."),
        ("Élodie", "épinal", "Élodie É."),
        ("Madonna", "", "Madonna"),
        ("Madonna", None, "Madonna"),
        ("", "Lovelace", "L."),
        ("", "", "Player"),
        (None, None, "Player"),
        ("ada@example.com", "Lovelace", "Player"),
        ("Ada", "x@y.z", "Player"),
        ("A" * 80, "B", "A" * 30 + " B."),
    ],
)
def test_display_name(first, last, expected):
    assert display_name(first, last) == expected


# ---------------------------------------------------------------------------------------------
# visibility rules
# ---------------------------------------------------------------------------------------------
def test_get_event_by_slug_and_id(make_event, db):
    event = make_event(slug="found-it")
    assert get_event_by_slug(db, "found-it").id == event.id
    assert get_event_by_slug(db, "nope") is None
    assert get_event_by_id_or_404(db, event.id).slug == "found-it"
    with pytest.raises(HTTPException) as exc:
        get_event_by_id_or_404(db, 12345)
    assert exc.value.status_code == 404


def test_get_event_or_404_visibility(make_event, db):
    draft, live, closed = make_event(status="draft"), make_event(status="live"), make_event(status="closed")
    assert get_event_or_404(db, live.slug).id == live.id
    assert get_event_or_404(db, closed.slug).id == closed.id  # readable
    with pytest.raises(HTTPException) as exc:
        get_event_or_404(db, draft.slug)
    assert exc.value.status_code == 404
    assert get_event_or_404(db, draft.slug, is_admin=True).id == draft.id  # admin preview
    with pytest.raises(HTTPException) as exc:
        get_event_or_404(db, "missing", is_admin=True)
    assert exc.value.status_code == 404


def test_assert_event_playable(make_event):
    live, draft, closed = make_event(status="live"), make_event(status="draft"), make_event(status="closed")
    assert_event_playable(live)
    assert_event_playable(live, is_admin=True)
    with pytest.raises(HTTPException) as exc:
        assert_event_playable(draft)
    assert exc.value.status_code == 404
    assert_event_playable(draft, is_admin=True)  # admin can preview-play a draft
    for admin in (False, True):
        with pytest.raises(HTTPException) as exc:
            assert_event_playable(closed, is_admin=admin)
        assert exc.value.status_code == 403 and exc.value.detail == "event_closed"


def test_list_live_events_only_live_soonest_first(make_event, db):
    make_event(slug="draft-one", status="draft")
    make_event(slug="closed-one", status="closed")
    later = make_event(slug="later", starts_on=date(2026, 12, 1))
    undated = make_event(slug="undated")
    sooner = make_event(slug="sooner", starts_on=date(2026, 10, 7))
    assert [e.slug for e in list_live_events(db)] == ["sooner", "later", "undated"]
    assert {later.id, undated.id, sooner.id} == {e.id for e in list_live_events(db)}


# ---------------------------------------------------------------------------------------------
# serializers
# ---------------------------------------------------------------------------------------------
def test_event_to_summary_and_branding_defaults(make_event):
    event = make_event(
        slug="summary", name="Summary", game_title="AI Masters", tagline_en="Fast", location="Amsterdam",
        starts_on=date(2026, 10, 7), branding={"primary_color": "#7c5cff"},
    )
    summary = event_to_summary(event).model_dump(mode="json")
    assert summary["slug"] == "summary" and summary["game_title"] == "AI Masters"
    assert summary["starts_on"] == "2026-10-07" and summary["languages"] == ["en", "fr"]
    assert summary["branding"] == {
        "primary_color": "#7C5CFF", "accent_color": "#FF9A52", "background_style": "aurora",
        "logo_url": None, "default_theme": "dark", "show_join_qr": True,
    }
    assert "settings" not in summary and "hero_title_en" not in summary


def test_event_to_public_filters_categories_and_counts(db, make_event, make_category, make_question, make_player, make_game_session):
    event = make_event(hero_title_en="Become THE AI Master!", consent_text_en="I agree", collect_phone="required")
    a = make_category(event, name="A")
    b = make_category(event, name="B")
    inactive_cat = make_category(event, name="Inactive", is_active=False)
    only_inactive_questions = make_category(event, name="OnlyInactive")
    make_category(event, name="Empty")
    for _ in range(3):
        make_question(event, a)
    make_question(event, b)
    make_question(event, b, is_active=False)  # not counted
    make_question(event, inactive_cat)
    make_question(event, only_inactive_questions, is_active=False)
    make_question(event)  # uncategorised
    other = make_event()  # another event's data must not leak in
    make_question(other, make_category(other, name="A"))
    player = make_player(event)
    make_game_session(event, player, status="completed")
    make_game_session(event, player, status="in_progress")
    make_player(event)

    public = event_to_public(db, event).model_dump(mode="json")
    assert [(c["name"], c["question_count"]) for c in public["categories"]] == [("A", 3), ("B", 1)]
    assert set(public["categories"][0]) == {"id", "name", "name_fr", "color", "question_count"}
    assert public["stats"] == {"players": 2, "games_completed": 1}
    assert public["hero_title_en"] == "Become THE AI Master!"
    assert public["settings"] == {
        "questions_per_game": 15, "timer_seconds": 20, "points_correct": 100, "points_wrong": 0,
        "time_bonus_max": 50, "question_order": "random", "collect_phone": "required",
        "consent_text_en": "I agree", "consent_text_fr": None,
    }
    assert "category_distribution" not in public["settings"]  # admin-only
    assert public_categories(db, other.id)[0].question_count == 1


def test_event_to_admin_has_everything(db, make_event, make_category, make_question, make_player, make_game_session):
    event = make_event(category_distribution={"1": 70, "2": 30}, consent_text_fr="J'accepte")
    category = make_category(event)
    make_question(event, category)
    make_question(event, category, is_active=False)
    make_game_session(event, status="completed")
    admin = event_to_admin(db, event).model_dump(mode="json")
    assert admin["id"] == event.id and admin["settings"]["category_distribution"] == {"1": 70, "2": 30}
    assert admin["settings"]["consent_text_fr"] == "J'accepte"
    assert admin["counts"] == {"questions": 2, "active_questions": 1, "categories": 1, "players": 1, "games_completed": 1}
    assert admin["created_at"].endswith("Z") and admin["updated_at"].endswith("Z")
    assert {"slug", "name", "game_title", "status", "hero_title_fr", "tagline_fr", "description_en", "location",
            "starts_on", "ends_on", "languages", "default_language", "branding", "settings", "counts"} <= set(admin)


def test_events_to_admin_uses_a_constant_number_of_queries(db, make_event, make_category, make_question, make_player, make_game_session):
    def populate(n):
        events = []
        for _ in range(n):
            event = make_event()
            make_question(event, make_category(event))
            make_game_session(event)
            events.append(event)
        return events

    def count_queries(events):
        statements = []

        def before(_conn, _cursor, statement, *_args):
            statements.append(statement)

        sa_event.listen(engine, "before_cursor_execute", before)
        try:
            result = events_to_admin(db, events)
        finally:
            sa_event.remove(engine, "before_cursor_execute", before)
        return len(statements), result

    few = populate(2)
    q_few, _ = count_queries(few)
    many = populate(8)
    q_many, result = count_queries(few + many)
    assert q_few == q_many <= 4
    assert all(e.counts.questions == 1 and e.counts.games_completed == 1 for e in result)
    assert event_counts(db, []) == {}


def test_event_counts_default_to_zero(db, make_event):
    event = make_event()
    counts = event_counts(db, [event.id])[event.id]
    assert counts.model_dump() == {"questions": 0, "active_questions": 0, "categories": 0, "players": 0, "games_completed": 0}


# ---------------------------------------------------------------------------------------------
# build / update
# ---------------------------------------------------------------------------------------------
def test_build_event_from_create_payload(db):
    payload = EventCreate(
        slug="ai-masters", name="AI Masters", game_title="AI Masters", status="live", languages=["en"],
        default_language="en", branding={"primary_color": "#7c5cff"},
        settings={"questions_per_game": 10, "category_distribution": {"1": 1, "2": 3}, "collect_phone": "hidden"},
        location="Amsterdam", starts_on=date(2026, 10, 7),
    )
    event = build_event(payload)
    db.add(event)
    db.commit()
    assert event.id and event.slug == "ai-masters" and event.status == "live"
    assert event.languages == ["en"] and event.branding["primary_color"] == "#7C5CFF"
    assert event.questions_per_game == 10 and event.collect_phone == "hidden"
    assert event.category_distribution == {"1": 1, "2": 3} and event.timer_seconds == 20
    assert event.starts_on == date(2026, 10, 7)


def test_apply_event_update_merges_branding_and_settings(db, make_event):
    event = make_event(branding={"primary_color": "#111111", "accent_color": "#222222", "logo_url": "/assets/a.png"})
    apply_event_update(
        event,
        EventUpdate(name="Renamed", branding={"primary_color": "#abcdef", "logo_url": None}, settings={"timer_seconds": 45, "points_wrong": 10}),
    )
    db.commit()
    db.expire_all()
    fresh = db.get(Event, event.id)
    assert fresh.name == "Renamed" and fresh.timer_seconds == 45 and fresh.points_wrong == 10
    assert fresh.questions_per_game == 15  # untouched
    assert fresh.branding == {
        "primary_color": "#ABCDEF", "accent_color": "#222222", "background_style": "aurora",
        "logo_url": None, "default_theme": "dark", "show_join_qr": True,
    }


def test_apply_event_update_can_clear_nullable_fields(db, make_event):
    event = make_event(tagline_en="x", consent_text_en="agree", category_distribution={"1": 1}, starts_on=date(2026, 1, 1))
    apply_event_update(event, EventUpdate(tagline_en=None, starts_on=None, settings={"consent_text_en": None, "category_distribution": None}))
    db.commit()
    assert event.tagline_en is None and event.starts_on is None
    assert event.consent_text_en is None and event.category_distribution is None


def test_apply_event_update_checks_the_merged_state(make_event):
    event = make_event(languages=["en", "fr"], default_language="fr", starts_on=date(2026, 10, 7))
    with pytest.raises(ValueError, match="default_language"):
        apply_event_update(event, EventUpdate(languages=["en"]))  # default stays fr
    assert event.languages == ["en", "fr"]  # nothing applied
    english_only = make_event(languages=["en"], default_language="en")
    with pytest.raises(ValueError, match="default_language"):
        apply_event_update(english_only, EventUpdate(default_language="fr"))
    with pytest.raises(ValueError, match="ends_on"):
        apply_event_update(event, EventUpdate(ends_on=date(2026, 10, 1)))
    apply_event_update(event, EventUpdate(languages=["fr"]))
    assert event.languages == ["fr"]
    with pytest.raises(ValidationError):
        EventUpdate(languages=["en"], default_language="fr")


def test_broadcaster_stub_keeps_its_signature():
    assert broadcaster.notify_event_changed(1) is None


def test_invalid_stored_branding_degrades_to_defaults_instead_of_breaking_the_hub(client, db, make_event):
    """A hand edited / legacy branding value must not 500 /api/events (the whole hub)."""
    event = make_event(slug="shaky", branding={"primary_color": "#112233", "logo_url": "/x\x00y", "default_theme": "neon"})
    healthy = make_event(slug="healthy")
    listing = client.get("/api/events")
    assert listing.status_code == 200, listing.text
    assert {e["slug"] for e in listing.json()} == {"shaky", "healthy"}
    shaky = next(e for e in listing.json() if e["slug"] == event.slug)
    assert shaky["branding"]["primary_color"] == "#112233"  # the valid key is kept
    assert shaky["branding"]["logo_url"] is None and shaky["branding"]["default_theme"] == "dark"  # bad ones reset
    assert client.get(f"/api/events/{event.slug}").status_code == 200
    assert client.get(f"/api/events/{healthy.slug}").status_code == 200


# ---------------------------------------------------------------------------------------------
# closed-event grace period
# ---------------------------------------------------------------------------------------------
NOW = datetime(2026, 10, 7, 12, 0, 0)


def test_the_grace_period_is_fifteen_minutes():
    assert CLOSED_EVENT_SUBMIT_GRACE == timedelta(minutes=15)


@pytest.mark.parametrize(
    "status,age,allowed",
    [
        ("in_progress", timedelta(0), True),
        ("in_progress", timedelta(minutes=14, seconds=59), True),
        ("in_progress", timedelta(minutes=15), False),  # "less than 15 minutes ago"
        ("in_progress", timedelta(hours=3), False),
        ("in_progress", timedelta(seconds=-30), True),  # clock skew between replicas never locks a player out
        ("completed", timedelta(minutes=1), False),
        ("abandoned", timedelta(minutes=1), False),
    ],
)
def test_may_submit_after_close(status, age, allowed):
    assert may_submit_after_close(status, NOW - age, NOW) is allowed


# ---------------------------------------------------------------------------------------------
# active_questions = questions a game can draw
# ---------------------------------------------------------------------------------------------
def test_event_counts_active_questions_follow_the_game_selection_rule(db, make_event, make_category, make_question):
    from app.routers.games import eligible_questions

    event, other = make_event(), make_event()
    live, dormant = make_category(event, name="Live"), make_category(event, name="Dormant", is_active=False)
    make_question(event, live)
    make_question(event, live, is_active=False)
    make_question(event)  # no category: playable
    make_question(event, dormant)  # active question, inactive category: never served
    make_question(event, dormant, is_active=False)
    make_question(other, make_category(other, name="Other"))
    counts = event_counts(db, [event.id, other.id])
    assert (counts[event.id].questions, counts[event.id].active_questions) == (5, 2)
    assert (counts[other.id].questions, counts[other.id].active_questions) == (1, 1)
    assert counts[event.id].active_questions == len(eligible_questions(db, event.id))


def test_event_counts_of_an_event_whose_only_category_is_inactive(db, make_event, make_category, make_question):
    event = make_event()
    make_question(event, make_category(event, is_active=False))
    counts = event_counts(db, [event.id])[event.id]
    assert (counts.questions, counts.active_questions, counts.categories) == (1, 0, 1)


def test_public_category_counts_use_the_same_rule(db, make_event, make_category, make_question):
    event = make_event()
    live, dormant = make_category(event, name="Live"), make_category(event, name="Dormant", is_active=False)
    make_question(event, live)
    make_question(event, live)
    make_question(event, live, is_active=False)
    make_question(event, dormant)
    assert [(c.name, c.question_count) for c in public_categories(db, event.id)] == [("Live", 2)]
