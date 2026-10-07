"""Admin events API: CRUD, duplicate, export / import, stats."""
import copy
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.models import Category, Event, GameAnswer, GameSession, Player, Question, utcnow
from app.schemas import BundleV1
from app.services import broadcaster

URL = "/api/admin/events"


@pytest.fixture
def notified(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(broadcaster, "notify_event_changed", lambda event_id: calls.append(event_id))
    return calls


def new_event(client, admin_headers, **overrides):
    body = {"slug": "ai-masters", "name": "AI Masters", "game_title": "AI Masters"}
    body.update(overrides)
    response = client.post(URL, json=body, headers=admin_headers)
    assert response.status_code == 201, response.text
    return response.json()


def count(db, model, **filters):
    stmt = select(func.count()).select_from(model)
    for key, value in filters.items():
        stmt = stmt.where(getattr(model, key) == value)
    return db.scalar(stmt)


# ---------------------------------------------------------------------------------------------
# create / get / list
# ---------------------------------------------------------------------------------------------
def test_create_event_with_defaults(client, admin_headers):
    event = new_event(client, admin_headers)
    assert event["id"] and event["slug"] == "ai-masters" and event["status"] == "draft"
    assert event["languages"] == ["en", "fr"] and event["default_language"] == "en"
    assert event["branding"] == {
        "primary_color": "#FC5607", "accent_color": "#FF9A52", "background_style": "aurora",
        "logo_url": None, "default_theme": "dark", "show_join_qr": True,
    }
    assert event["settings"] == {
        "questions_per_game": 15, "timer_seconds": 20, "points_correct": 100, "points_wrong": 0,
        "time_bonus_max": 50, "question_order": "random", "collect_phone": "optional",
        "consent_text_en": None, "consent_text_fr": None, "category_distribution": None,
    }
    assert event["counts"] == {"questions": 0, "active_questions": 0, "categories": 0, "players": 0, "games_completed": 0}
    assert event["created_at"].endswith("Z") and event["updated_at"].endswith("Z")
    # it is persisted and readable
    again = client.get(f"{URL}/{event['id']}", headers=admin_headers)
    assert again.status_code == 200 and again.json() == event


def test_create_event_with_everything(client, admin_headers):
    event = new_event(
        client, admin_headers,
        slug="world-ai-summit-2026", name="World Summit AI - Amsterdam 2026", game_title="AI Masters", status="live",
        hero_title_en="Become THE AI Master!", hero_title_fr="Devenez LE AI Master !",
        tagline_en="Fast", tagline_fr="Vite", description_en="Desc", description_fr="Description",
        location="Amsterdam", starts_on="2026-10-07", ends_on="2026-10-08",
        languages=["en"], default_language="en",
        branding={"primary_color": "#7c5cff", "accent_color": "#22d3ee", "background_style": "grid",
                  "logo_url": "https://example.com/logo.svg", "default_theme": "light"},
        settings={"questions_per_game": 12, "timer_seconds": 25, "points_correct": 120, "points_wrong": 5,
                  "time_bonus_max": 30, "question_order": "easy_to_hard", "collect_phone": "required",
                  "consent_text_en": "I agree", "consent_text_fr": "J'accepte"},
    )
    assert event["status"] == "live" and event["location"] == "Amsterdam" and event["starts_on"] == "2026-10-07"
    assert event["branding"]["primary_color"] == "#7C5CFF"  # normalised
    assert event["branding"]["logo_url"] == "https://example.com/logo.svg"
    assert event["settings"]["question_order"] == "easy_to_hard" and event["settings"]["collect_phone"] == "required"
    assert event["settings"]["consent_text_fr"] == "J'accepte"
    assert event["languages"] == ["en"]


@pytest.mark.parametrize(
    "slug",
    ["Has Caps", "UPPER", "with_underscore", "-leading", "trailing-", "double--hyphen", "x", "a" * 49, "", "sp ace", "é-accent"]
    + ["api", "admin", "assets", "shared", "scoreboard", "events", "health", "docs", "new", "login"],
)
def test_create_event_rejects_invalid_and_reserved_slugs(client, admin_headers, slug):
    response = client.post(URL, json={"slug": slug, "name": "N", "game_title": "G"}, headers=admin_headers)
    assert response.status_code == 422


def test_create_event_accepts_boundary_slugs(client, admin_headers):
    for slug in ("ab", "a1", "a" * 48, "api-days-2026", "9-lives"):
        new_event(client, admin_headers, slug=slug, name=slug)


def test_create_event_duplicate_slug_is_a_409(client, admin_headers):
    new_event(client, admin_headers)
    response = client.post(URL, json={"slug": "ai-masters", "name": "Other", "game_title": "G"}, headers=admin_headers)
    assert response.status_code == 409
    assert "ai-masters" in response.json()["detail"]


@pytest.mark.parametrize(
    "patch",
    [
        {"name": ""}, {"game_title": " "}, {"status": "archived"}, {"languages": []}, {"languages": ["en", "en"]},
        {"languages": ["de"]}, {"default_language": "fr", "languages": ["en"]},
        {"starts_on": "2026-10-08", "ends_on": "2026-10-07"},
        {"branding": {"primary_color": "orange"}}, {"branding": {"logo_url": "http://insecure.example/x.png"}},
        {"branding": {"background_style": "neon"}},
        {"settings": {"questions_per_game": 0}}, {"settings": {"questions_per_game": 51}},
        {"settings": {"timer_seconds": 4}}, {"settings": {"timer_seconds": 121}},
        {"settings": {"points_correct": -1}}, {"settings": {"collect_phone": "maybe"}},
        {"settings": {"question_order": "alphabetical"}},
    ],
)
def test_create_event_validation(client, admin_headers, patch):
    body = {"slug": "valid-slug", "name": "N", "game_title": "G", **patch}
    assert client.post(URL, json=body, headers=admin_headers).status_code == 422


def test_create_event_cannot_weight_categories_that_do_not_exist_yet(client, admin_headers):
    body = {"slug": "weights", "name": "N", "game_title": "G", "settings": {"category_distribution": {"1": 10}}}
    response = client.post(URL, json=body, headers=admin_headers)
    assert response.status_code == 422 and "category_distribution" in response.json()["detail"]
    assert client.get(URL, headers=admin_headers).json() == []  # nothing was created


def test_get_unknown_event_is_404(client, admin_headers):
    response = client.get(f"{URL}/999", headers=admin_headers)
    assert response.status_code == 404 and response.json() == {"detail": "Event not found"}
    assert client.get(f"{URL}/abc", headers=admin_headers).status_code == 422


def test_list_events_with_counts_newest_first(client, admin_headers, make_event, make_category, make_question, make_player, make_game_session):
    first = make_event(slug="first-event", status="live")
    second = make_event(slug="second-event", status="draft")
    category = make_category(first)
    q1 = make_question(first, category)
    make_question(first, category, is_active=False)
    make_question(second)
    make_game_session(first, answers=[{"question": q1, "player_answer": "green"}])
    make_game_session(first, status="in_progress")
    make_player(first)

    response = client.get(URL, headers=admin_headers)
    assert response.status_code == 200
    items = response.json()
    assert [e["slug"] for e in items] == ["second-event", "first-event"]
    by_slug = {e["slug"]: e for e in items}
    assert by_slug["first-event"]["counts"] == {
        "questions": 2, "active_questions": 1, "categories": 1, "players": 3, "games_completed": 1,
    }
    assert by_slug["second-event"]["counts"]["questions"] == 1 and by_slug["second-event"]["counts"]["players"] == 0
    assert by_slug["first-event"]["settings"]["timer_seconds"] == 20


def test_list_events_empty(client, admin_headers):
    assert client.get(URL, headers=admin_headers).json() == []


# ---------------------------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------------------------
def test_update_is_partial_and_merges_branding_and_settings(client, admin_headers):
    event = new_event(client, admin_headers, location="Paris", settings={"timer_seconds": 30, "questions_per_game": 10})
    response = client.put(
        f"{URL}/{event['id']}",
        json={"name": "Renamed", "branding": {"primary_color": "#112233"}, "settings": {"points_correct": 200}},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["name"] == "Renamed" and updated["location"] == "Paris" and updated["slug"] == "ai-masters"
    assert updated["branding"]["primary_color"] == "#112233"
    assert updated["branding"]["accent_color"] == "#FF9A52"  # untouched keys survive
    assert updated["settings"]["points_correct"] == 200
    assert (updated["settings"]["timer_seconds"], updated["settings"]["questions_per_game"]) == (30, 10)
    assert updated["updated_at"] >= event["updated_at"]


def test_update_branding_key_by_key_over_several_calls(client, admin_headers):
    event = new_event(client, admin_headers)
    url = f"{URL}/{event['id']}"
    client.put(url, json={"branding": {"background_style": "grid"}}, headers=admin_headers)
    client.put(url, json={"branding": {"default_theme": "system"}}, headers=admin_headers)
    client.put(url, json={"branding": {"logo_url": "/assets/logo.png"}}, headers=admin_headers)
    branding = client.get(url, headers=admin_headers).json()["branding"]
    assert branding == {
        "primary_color": "#FC5607", "accent_color": "#FF9A52", "background_style": "grid",
        "logo_url": "/assets/logo.png", "default_theme": "system", "show_join_qr": True,
    }
    # an explicit null clears the logo only
    client.put(url, json={"branding": {"logo_url": None}}, headers=admin_headers)
    branding = client.get(url, headers=admin_headers).json()["branding"]
    assert branding["logo_url"] is None and branding["background_style"] == "grid"


def test_update_can_clear_nullable_fields_but_not_required_ones(client, admin_headers):
    event = new_event(client, admin_headers, location="Paris", tagline_en="Hi", settings={"consent_text_en": "I agree"})
    url = f"{URL}/{event['id']}"
    cleared = client.put(url, json={"location": None, "tagline_en": "", "settings": {"consent_text_en": None}}, headers=admin_headers)
    assert cleared.status_code == 200
    body = cleared.json()
    assert body["location"] is None and body["tagline_en"] is None and body["settings"]["consent_text_en"] is None
    for field in ("name", "game_title", "slug", "status", "languages", "default_language"):
        assert client.put(url, json={field: None}, headers=admin_headers).status_code == 422, field
    assert client.put(url, json={"settings": {"timer_seconds": None}}, headers=admin_headers).status_code == 422


def test_update_status_transitions(client, admin_headers):
    event = new_event(client, admin_headers)
    url = f"{URL}/{event['id']}"
    for status in ("live", "closed", "draft", "live"):
        response = client.put(url, json={"status": status}, headers=admin_headers)
        assert response.status_code == 200 and response.json()["status"] == status


def test_update_slug_is_allowed_but_unique(client, admin_headers):
    first = new_event(client, admin_headers, slug="first-one")
    new_event(client, admin_headers, slug="second-one")
    url = f"{URL}/{first['id']}"
    ok = client.put(url, json={"slug": "renamed-one"}, headers=admin_headers)
    assert ok.status_code == 200 and ok.json()["slug"] == "renamed-one"
    clash = client.put(url, json={"slug": "second-one"}, headers=admin_headers)
    assert clash.status_code == 409 and "second-one" in clash.json()["detail"]
    same = client.put(url, json={"slug": "renamed-one", "name": "Same slug"}, headers=admin_headers)
    assert same.status_code == 200  # keeping your own slug is not a conflict
    assert client.get(url, headers=admin_headers).json()["slug"] == "renamed-one"
    assert client.put(url, json={"slug": "admin"}, headers=admin_headers).status_code == 422  # reserved
    assert client.put(url, json={"slug": "Bad Slug"}, headers=admin_headers).status_code == 422


def test_update_language_consistency_is_checked_on_the_merged_state(client, admin_headers):
    event = new_event(client, admin_headers, languages=["en", "fr"], default_language="fr")
    url = f"{URL}/{event['id']}"
    # dropping the default language alone is refused ...
    assert client.put(url, json={"languages": ["en"]}, headers=admin_headers).status_code == 422
    # ... and so is a default language outside the stored languages
    english_only = new_event(client, admin_headers, slug="english-only", languages=["en"], default_language="en")
    assert client.put(f"{URL}/{english_only['id']}", json={"default_language": "fr"}, headers=admin_headers).status_code == 422
    # changing both together is fine
    ok = client.put(url, json={"languages": ["en"], "default_language": "en"}, headers=admin_headers)
    assert ok.status_code == 200 and ok.json()["languages"] == ["en"]
    # nothing was half-applied by the refused calls
    assert client.get(f"{URL}/{english_only['id']}", headers=admin_headers).json()["default_language"] == "en"


def test_update_dates_are_checked_on_the_merged_state(client, admin_headers):
    event = new_event(client, admin_headers, starts_on="2026-10-07", ends_on="2026-10-08")
    url = f"{URL}/{event['id']}"
    assert client.put(url, json={"ends_on": "2026-10-01"}, headers=admin_headers).status_code == 422
    assert client.put(url, json={"starts_on": "2026-10-09"}, headers=admin_headers).status_code == 422
    assert client.put(url, json={"starts_on": None}, headers=admin_headers).status_code == 200


def test_update_category_distribution_must_reference_the_events_own_categories(client, admin_headers, db, make_category, make_event):
    event = new_event(client, admin_headers)
    other = make_event()
    mine = make_category(db.get(Event, event["id"]), name="Mine")
    foreign = make_category(other, name="Foreign")
    url = f"{URL}/{event['id']}"
    assert client.put(url, json={"settings": {"category_distribution": {str(foreign.id): 5}}}, headers=admin_headers).status_code == 422
    assert client.put(url, json={"settings": {"category_distribution": {"999999": 5}}}, headers=admin_headers).status_code == 422
    ok = client.put(url, json={"settings": {"category_distribution": {str(mine.id): 7}}}, headers=admin_headers)
    assert ok.status_code == 200 and ok.json()["settings"]["category_distribution"] == {str(mine.id): 7}
    # other settings keep the distribution; an explicit null clears it
    kept = client.put(url, json={"settings": {"timer_seconds": 40}}, headers=admin_headers)
    assert kept.json()["settings"]["category_distribution"] == {str(mine.id): 7}
    cleared = client.put(url, json={"settings": {"category_distribution": None}}, headers=admin_headers)
    assert cleared.json()["settings"]["category_distribution"] is None
    assert client.put(url, json={"settings": {"category_distribution": {str(mine.id): 0}}}, headers=admin_headers).status_code == 422


def test_update_unknown_event_and_empty_body(client, admin_headers):
    assert client.put(f"{URL}/999", json={"name": "x"}, headers=admin_headers).status_code == 404
    event = new_event(client, admin_headers)
    same = client.put(f"{URL}/{event['id']}", json={}, headers=admin_headers)
    assert same.status_code == 200 and same.json()["name"] == "AI Masters"


# ---------------------------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------------------------
def build_event_with_everything(db, make_event, make_category, make_question, make_player, make_game_session, slug):
    event = make_event(slug=slug)
    category = make_category(event, name=f"Cat {slug}")
    questions = [make_question(event, category) for _ in range(3)]
    make_game_session(event, answers=[{"question": q, "player_answer": "green"} for q in questions])
    make_game_session(event, status="in_progress")
    make_player(event)
    return event


def table_counts(db):
    return {m.__name__: count(db, m) for m in (Event, Category, Question, Player, GameSession, GameAnswer)}


def test_delete_requires_the_slug_as_confirmation(client, admin_headers, make_event):
    event = make_event(slug="to-delete")
    for query in ("", "?confirm=", "?confirm=wrong-slug", "?confirm=TO-DELETE", "?confirm=to-delete%20"):
        response = client.delete(f"{URL}/{event.id}{query}", headers=admin_headers)
        assert response.status_code == 400, query
    assert client.get(f"{URL}/{event.id}", headers=admin_headers).status_code == 200


def test_delete_cascades_to_everything_of_that_event_only(
    client, admin_headers, db, make_event, make_category, make_question, make_player, make_game_session, notified
):
    doomed = build_event_with_everything(db, make_event, make_category, make_question, make_player, make_game_session, "doomed")
    survivor = build_event_with_everything(db, make_event, make_category, make_question, make_player, make_game_session, "survivor")
    before = table_counts(db)
    assert before == {"Event": 2, "Category": 2, "Question": 6, "Player": 6, "GameSession": 4, "GameAnswer": 6}

    doomed_id, survivor_id = doomed.id, survivor.id
    response = client.delete(f"{URL}/{doomed_id}?confirm=doomed", headers=admin_headers)
    assert response.status_code == 204 and response.content == b""

    assert table_counts(db) == {"Event": 1, "Category": 1, "Question": 3, "Player": 3, "GameSession": 2, "GameAnswer": 3}
    for model in (Category, Question, Player, GameSession):
        assert count(db, model, event_id=doomed_id) == 0
        assert count(db, model, event_id=survivor_id) > 0
    assert client.get(f"{URL}/{doomed_id}", headers=admin_headers).status_code == 404
    assert client.delete(f"{URL}/{doomed_id}?confirm=doomed", headers=admin_headers).status_code == 404
    assert notified == [doomed_id]  # the scoreboard hub is told once


def test_refused_delete_does_not_notify_or_delete(client, admin_headers, make_event, notified, db):
    event = make_event(slug="keep-me")
    client.delete(f"{URL}/{event.id}?confirm=nope", headers=admin_headers)
    assert notified == [] and count(db, Event) == 1


def test_delete_still_succeeds_when_the_broadcaster_fails(client, admin_headers, make_event, monkeypatch, db):
    def boom(_event_id):
        raise RuntimeError("hub down")

    monkeypatch.setattr(broadcaster.hub, "notify", boom)  # notify_event_changed swallows it
    event = make_event(slug="resilient")
    assert client.delete(f"{URL}/{event.id}?confirm=resilient", headers=admin_headers).status_code == 204
    assert count(db, Event) == 0


def test_a_deleted_slug_can_be_reused(client, admin_headers):
    event = new_event(client, admin_headers, slug="reuse-me")
    assert client.delete(f"{URL}/{event['id']}?confirm=reuse-me", headers=admin_headers).status_code == 204
    again = new_event(client, admin_headers, slug="reuse-me")
    assert again["slug"] == "reuse-me" and again["counts"]["questions"] == 0


# ---------------------------------------------------------------------------------------------
# duplicate
# ---------------------------------------------------------------------------------------------
def make_rich_event(client, admin_headers, db, make_category, make_question, make_player, make_game_session):
    created = new_event(
        client, admin_headers, slug="api-masters", name="API Masters", game_title="API Masters", status="live",
        hero_title_en="Become THE API Master!", location="Paris", starts_on="2026-10-07",
        branding={"primary_color": "#FC5607", "background_style": "grid"},
        settings={"timer_seconds": 17, "question_order": "easy_to_hard", "consent_text_en": "I agree"},
    )
    db_event = db.get(Event, created["id"])
    a, b = make_category(db_event, name="A"), make_category(db_event, name="B")
    qs = [make_question(db_event, a), make_question(db_event, b, question_format="two_choices")]
    make_player(db_event)
    make_game_session(db_event, answers=[{"question": qs[0], "player_answer": "green"}])
    client.put(
        f"{URL}/{created['id']}", json={"settings": {"category_distribution": {str(a.id): 70, str(b.id): 30}}}, headers=admin_headers
    )
    return created


def test_duplicate_endpoint(client, admin_headers, db, make_category, make_question, make_player, make_game_session):
    source = make_rich_event(client, admin_headers, db, make_category, make_question, make_player, make_game_session)
    response = client.post(
        f"{URL}/{source['id']}/duplicate", json={"slug": "ai-masters", "name": "AI Masters", "game_title": "AI Masters"},
        headers=admin_headers,
    )
    assert response.status_code == 201, response.text
    copy_ = response.json()
    assert copy_["id"] != source["id"] and copy_["status"] == "draft" and copy_["slug"] == "ai-masters"
    assert copy_["game_title"] == "AI Masters" and copy_["hero_title_en"] == "Become THE API Master!"
    assert copy_["branding"]["background_style"] == "grid"
    assert copy_["settings"]["timer_seconds"] == 17 and copy_["settings"]["consent_text_en"] == "I agree"
    assert copy_["counts"] == {"questions": 2, "active_questions": 2, "categories": 2, "players": 0, "games_completed": 0}
    assert copy_["location"] is None and copy_["starts_on"] is None
    # the weights point at the NEW categories
    cats = {c["name"]: c["id"] for c in client.get(f"{URL}/{copy_['id']}/categories", headers=admin_headers).json()}
    assert copy_["settings"]["category_distribution"] == {str(cats["A"]): 70, str(cats["B"]): 30}
    # the original keeps its players and its own weights
    original = client.get(f"{URL}/{source['id']}", headers=admin_headers).json()
    assert original["counts"]["players"] == 2 and original["counts"]["games_completed"] == 1
    assert set(original["settings"]["category_distribution"]) .isdisjoint(copy_["settings"]["category_distribution"])


def test_duplicate_flags(client, admin_headers, db, make_category, make_question, make_player, make_game_session):
    source = make_rich_event(client, admin_headers, db, make_category, make_question, make_player, make_game_session)
    response = client.post(
        f"{URL}/{source['id']}/duplicate",
        json={"slug": "blank-copy", "name": "Blank", "copy_branding": False, "copy_settings": False, "copy_questions": False},
        headers=admin_headers,
    )
    assert response.status_code == 201
    blank = response.json()
    assert blank["branding"]["background_style"] == "aurora" and blank["hero_title_en"] is None
    assert blank["settings"]["timer_seconds"] == 20 and blank["settings"]["category_distribution"] is None
    assert blank["counts"]["questions"] == 0 and blank["counts"]["categories"] == 0


def test_duplicate_errors(client, admin_headers, make_event):
    event = make_event(slug="source-event")
    url = f"{URL}/{event.id}/duplicate"
    assert client.post(url, json={"slug": "source-event", "name": "Same"}, headers=admin_headers).status_code == 409
    assert client.post(url, json={"slug": "admin", "name": "Reserved"}, headers=admin_headers).status_code == 422
    assert client.post(url, json={"slug": "Not Valid", "name": "Bad"}, headers=admin_headers).status_code == 422
    assert client.post(url, json={"slug": "no-name"}, headers=admin_headers).status_code == 422
    assert client.post(f"{URL}/999/duplicate", json={"slug": "ok-slug", "name": "N"}, headers=admin_headers).status_code == 404


def test_duplicate_is_independent_through_the_api(client, admin_headers, db, make_category, make_question, make_player, make_game_session):
    source = make_rich_event(client, admin_headers, db, make_category, make_question, make_player, make_game_session)
    copy_ = client.post(f"{URL}/{source['id']}/duplicate", json={"slug": "copy-one", "name": "Copy"}, headers=admin_headers).json()
    client.put(f"{URL}/{copy_['id']}", json={"branding": {"primary_color": "#000000"}, "name": "Changed"}, headers=admin_headers)
    cat_ids = [c["id"] for c in client.get(f"{URL}/{copy_['id']}/categories", headers=admin_headers).json()]
    for cid in cat_ids:
        assert client.delete(f"/api/admin/categories/{cid}", headers=admin_headers).status_code == 204
    original = client.get(f"{URL}/{source['id']}", headers=admin_headers).json()
    assert original["name"] == "API Masters" and original["branding"]["primary_color"] == "#FC5607"
    assert original["counts"]["categories"] == 2 and original["counts"]["questions"] == 2
    assert client.delete(f"{URL}/{copy_['id']}?confirm=copy-one", headers=admin_headers).status_code == 204
    assert client.get(f"{URL}/{source['id']}", headers=admin_headers).json()["counts"]["questions"] == 2


# ---------------------------------------------------------------------------------------------
# export / import
# ---------------------------------------------------------------------------------------------
def test_export_downloads_a_valid_bundle(client, admin_headers, db, make_category, make_question, make_player, make_game_session):
    source = make_rich_event(client, admin_headers, db, make_category, make_question, make_player, make_game_session)
    response = client.get(f"{URL}/{source['id']}/export", headers=admin_headers)
    assert response.status_code == 200
    assert response.headers["content-disposition"] == 'attachment; filename="api-masters.json"'
    assert response.headers["content-type"].startswith("application/json")
    bundle = json.loads(response.content.decode("utf-8"))
    BundleV1.model_validate(bundle)
    assert bundle["event"]["slug"] == "api-masters"
    assert bundle["event"]["settings"]["category_distribution"] == {"A": 70, "B": 30}
    assert len(bundle["questions"]) == 2 and len(bundle["categories"]) == 2
    assert "email" not in response.text


def test_export_keeps_non_ascii_text_readable(client, admin_headers, make_event, make_question):
    event = make_event(slug="accents", name="Évènement spécial")
    make_question(event, question_text_fr="Où est l'œuf ?")
    response = client.get(f"{URL}/{event.id}/export", headers=admin_headers)
    assert "Où est l'œuf ?" in response.content.decode("utf-8")  # not \u escaped


def test_export_unknown_event_is_404(client, admin_headers):
    assert client.get(f"{URL}/999/export", headers=admin_headers).status_code == 404


def test_import_creates_an_event_from_a_bundle(client, admin_headers, sample_bundle):
    response = client.post(f"{URL}/import", json={"bundle": sample_bundle()}, headers=admin_headers)
    assert response.status_code == 201, response.text
    event = response.json()
    assert event["slug"] == "sample-event" and event["status"] == "live"
    assert event["counts"]["questions"] == 4 and event["counts"]["categories"] == 2
    cats = {c["name"]: c["id"] for c in client.get(f"{URL}/{event['id']}/categories", headers=admin_headers).json()}
    assert event["settings"]["category_distribution"] == {str(cats["Alpha"]): 50, str(cats["Beta"]): 50}
    assert event["starts_on"] == "2026-10-07"


def test_import_overrides_and_conflict(client, admin_headers, sample_bundle):
    ok = client.post(f"{URL}/import", json={"bundle": sample_bundle()}, headers=admin_headers)
    assert ok.status_code == 201
    conflict = client.post(f"{URL}/import", json={"bundle": sample_bundle()}, headers=admin_headers)
    assert conflict.status_code == 409 and "sample-event" in conflict.json()["detail"]
    overridden = client.post(
        f"{URL}/import",
        json={"bundle": sample_bundle(), "slug": "sample-copy", "name": "Sample copy", "status": "draft"},
        headers=admin_headers,
    )
    assert overridden.status_code == 201
    assert (overridden.json()["slug"], overridden.json()["name"], overridden.json()["status"]) == ("sample-copy", "Sample copy", "draft")
    assert len(client.get(URL, headers=admin_headers).json()) == 2  # the conflict created nothing
    bad_override = client.post(f"{URL}/import", json={"bundle": sample_bundle(), "slug": "admin"}, headers=admin_headers)
    assert bad_override.status_code == 422


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b.update(version=2),
        lambda b: b.update(format="nope"),
        lambda b: b["event"].update(slug="UPPER"),
        lambda b: b["questions"][0].update(category="Missing"),
        lambda b: b["questions"][0].update(correct_answer="yellow"),
        lambda b: b["questions"][0].update(surprise=True),
        lambda b: b.pop("event"),
    ],
)
def test_import_rejects_invalid_bundles_with_422_and_creates_nothing(client, admin_headers, sample_bundle, mutate):
    bundle = sample_bundle()
    mutate(bundle)
    response = client.post(f"{URL}/import", json={"bundle": bundle}, headers=admin_headers)
    assert response.status_code == 422
    assert client.get(URL, headers=admin_headers).json() == []


def test_import_requires_a_bundle(client, admin_headers):
    assert client.post(f"{URL}/import", json={}, headers=admin_headers).status_code == 422
    assert client.post(f"{URL}/import", content=b"not json", headers={**admin_headers, "content-type": "application/json"}).status_code == 422


def test_export_then_import_round_trip_through_the_api(client, admin_headers, sample_bundle):
    created = client.post(f"{URL}/import", json={"bundle": sample_bundle()}, headers=admin_headers).json()
    exported = client.get(f"{URL}/{created['id']}/export", headers=admin_headers).json()
    assert exported["questions"] == sample_bundle()["questions"]
    reimported = client.post(f"{URL}/import", json={"bundle": exported, "slug": "round-trip"}, headers=admin_headers)
    assert reimported.status_code == 201
    again = client.get(f"{URL}/{reimported.json()['id']}/export", headers=admin_headers).json()
    expected = copy.deepcopy(exported)
    expected["event"]["slug"] = "round-trip"
    assert again == expected


# ---------------------------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------------------------
def test_stats_of_an_empty_event(client, admin_headers, make_event):
    event = make_event()
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert stats == {
        "players": 0, "games_completed": 0, "games_in_progress": 0, "games_abandoned": 0, "avg_score": 0.0,
        "top_score": 0, "avg_correct": 0.0, "questions_active": 0, "hardest_questions": [], "easiest_questions": [],
    }
    assert client.get(f"{URL}/999/stats", headers=admin_headers).status_code == 404


def test_stats_aggregates_completed_games_and_ranks_questions(
    client, admin_headers, make_event, make_category, make_question, make_player, make_game_session
):
    event = make_event()
    other = make_event()
    category = make_category(event)
    q_easy = make_question(event, category, question_text_en="Everybody gets this")
    q_hard = make_question(event, category, question_text_en="Nobody gets this")
    q_rare = make_question(event, category, question_text_en="Too few answers")
    q_mixed = make_question(event, category, question_text_en="Two thirds")
    make_question(event, category, is_active=False)
    q_other = make_question(other)

    def answers(i):
        rows = [
            {"question": q_easy, "player_answer": "green"},  # correct (green is correct)
            {"question": q_hard, "player_answer": "red"},  # wrong
            {"question": q_rare, "player_answer": "green" if i < 2 else None},  # only 2 real answers
            {"question": q_mixed, "player_answer": ("green", "green", "red")[i] if i < 3 else None},
        ]
        return rows

    scores = [100, 200, 300, 400, 500]
    for i, score in enumerate(scores):
        make_game_session(event, answers=answers(i), total_score=score)
    make_game_session(event, status="in_progress", total_score=9999)  # never counts for score stats
    make_game_session(event, status="abandoned", total_score=8888)
    make_game_session(other, answers=[{"question": q_other, "player_answer": "red"}], total_score=7777)
    make_player(event)

    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert stats["games_completed"] == 5 and stats["games_in_progress"] == 1 and stats["games_abandoned"] == 1
    assert stats["players"] == 8  # one per session (7) + the extra player
    assert stats["avg_score"] == 300.0 and stats["top_score"] == 500
    assert stats["questions_active"] == 4
    # per session: correct = q_easy (+ q_rare for i<2) (+ q_mixed when green)
    expected_correct = [3, 3, 1, 1, 1]
    assert stats["avg_correct"] == round(sum(expected_correct) / 5, 2)

    hardest = stats["hardest_questions"]
    easiest = stats["easiest_questions"]
    assert [q["question_text_en"] for q in hardest] == ["Nobody gets this", "Two thirds", "Everybody gets this"]
    assert [q["question_text_en"] for q in easiest] == ["Everybody gets this", "Two thirds", "Nobody gets this"]
    by_text = {q["question_text_en"]: q for q in hardest}
    assert by_text["Nobody gets this"]["correct_rate"] == 0.0 and by_text["Nobody gets this"]["answered"] == 5
    assert by_text["Everybody gets this"]["correct_rate"] == 1.0
    assert by_text["Two thirds"] == {"id": q_mixed.id, "question_text_en": "Two thirds", "correct_rate": 0.6667, "answered": 3}
    assert "Too few answers" not in by_text  # fewer than 3 answers: not ranked


def test_stats_lists_are_capped_at_five(client, admin_headers, make_event, make_question, make_game_session):
    event = make_event()
    questions = [make_question(event) for _ in range(8)]
    for _ in range(3):
        make_game_session(event, answers=[{"question": q, "player_answer": "green"} for q in questions])
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert len(stats["hardest_questions"]) == 5 and len(stats["easiest_questions"]) == 5
    assert all(q["answered"] == 3 for q in stats["hardest_questions"])
    # ties are broken by id so the output is stable
    assert [q["id"] for q in stats["hardest_questions"]] == [q.id for q in questions[:5]]


# ---------------------------------------------------------------------------------------------
# stats: abandoned games (still "in_progress" 3 hours after the start)
# ---------------------------------------------------------------------------------------------
def test_stats_report_an_old_in_progress_game_as_abandoned(client, admin_headers, db, make_event, make_game_session):
    event = make_event()
    now = utcnow()

    def game(status, age):
        return make_game_session(event, status=status, started_at=now - age)

    game("in_progress", timedelta(minutes=5))
    game("in_progress", timedelta(hours=2, minutes=59))
    game("in_progress", timedelta(hours=3, minutes=1))  # walked away
    game("in_progress", timedelta(days=2))  # the dry run of two days ago
    game("abandoned", timedelta(minutes=10))  # explicit status counts as well
    game("completed", timedelta(hours=9))  # a finished game is never "abandoned", however old
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert stats["games_in_progress"] == 2
    assert stats["games_abandoned"] == 3
    assert stats["games_completed"] == 1
    # reporting only: the rows are untouched
    assert sorted(g.status for g in db.query(GameSession)) == ["abandoned", "completed", "in_progress", "in_progress", "in_progress", "in_progress"]


def test_stats_abandoned_boundary_is_exactly_three_hours(client, admin_headers, make_event, make_game_session, monkeypatch):
    from app.routers import admin_events

    event = make_event()
    now = datetime(2026, 10, 7, 12, 0, 0)
    monkeypatch.setattr(admin_events, "utcnow", lambda: now)
    make_game_session(event, status="in_progress", started_at=now - timedelta(hours=3) + timedelta(seconds=1))  # younger
    make_game_session(event, status="in_progress", started_at=now - timedelta(hours=3))  # 3 h old: abandoned
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert (stats["games_in_progress"], stats["games_abandoned"]) == (1, 1)


def test_stats_abandoned_games_are_per_event_and_leave_no_gap_in_the_totals(client, admin_headers, make_event, make_game_session):
    event, other = make_event(), make_event()
    old = timedelta(hours=5)
    make_game_session(event, status="in_progress", started_at=utcnow() - old)
    make_game_session(other, status="in_progress", started_at=utcnow() - old)
    make_game_session(other, status="in_progress")
    mine = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    theirs = client.get(f"{URL}/{other.id}/stats", headers=admin_headers).json()
    assert (mine["games_in_progress"], mine["games_abandoned"]) == (0, 1)
    assert (theirs["games_in_progress"], theirs["games_abandoned"]) == (1, 1)


def test_stats_abandoned_counters_are_plain_integers(client, admin_headers, make_event, make_game_session):
    """The sums must be integers (never null / float) even when nothing matches."""
    event = make_event()
    make_game_session(event, status="completed")
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert stats["games_in_progress"] == 0 and stats["games_abandoned"] == 0
    assert isinstance(stats["games_in_progress"], int) and isinstance(stats["games_abandoned"], int)


# ---------------------------------------------------------------------------------------------
# questions that can be drawn: counts, stats and public numbers agree with game selection
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def mixed_pool(db, make_event, make_category, make_question):
    """Active categorised (3), active uncategorised (1), inactive question (1), questions of an inactive
    category (2 active + 1 inactive): 8 questions, 4 of which a game can draw."""
    event = make_event(slug="mixed", questions_per_game=1)
    live, dormant = make_category(event, name="Live"), make_category(event, name="Dormant", is_active=False)
    for _ in range(3):
        make_question(event, live)
    make_question(event)  # uncategorised: playable
    make_question(event, live, is_active=False)
    make_question(event, dormant)
    make_question(event, dormant)
    make_question(event, dormant, is_active=False)
    return event, live, dormant


def test_active_questions_only_counts_what_a_game_can_draw(client, admin_headers, mixed_pool):
    event, *_ = mixed_pool
    counts = client.get(f"{URL}/{event.id}", headers=admin_headers).json()["counts"]
    assert counts["questions"] == 8 and counts["active_questions"] == 4
    listed = next(e for e in client.get(URL, headers=admin_headers).json() if e["id"] == event.id)
    assert listed["counts"] == counts
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()
    assert stats["questions_active"] == 4


def test_every_view_agrees_with_game_selection(client, admin_headers, db, mixed_pool):
    from app.routers.games import eligible_questions

    event, live, dormant = mixed_pool
    drawable = len(eligible_questions(db, event.id))
    public = client.get("/api/events/mixed").json()
    categorised = sum(c["question_count"] for c in public["categories"])
    assert [c["name"] for c in public["categories"]] == ["Live"]  # the inactive category is not offered
    assert categorised + 1 == drawable == 4  # + the uncategorised question
    admin = client.get(f"{URL}/{event.id}", headers=admin_headers).json()["counts"]["active_questions"]
    stats = client.get(f"{URL}/{event.id}/stats", headers=admin_headers).json()["questions_active"]
    assert admin == stats == drawable


def test_deactivating_and_reactivating_a_category_moves_the_counts(client, admin_headers, mixed_pool):
    event, live, dormant = mixed_pool
    base = f"/api/admin/categories/{dormant.id}"
    assert client.put(base, json={"is_active": True}, headers=admin_headers).status_code == 200
    counts = client.get(f"{URL}/{event.id}", headers=admin_headers).json()["counts"]
    assert counts["active_questions"] == 6  # the 2 active questions of the category are playable again
    public = {c["name"]: c["question_count"] for c in client.get("/api/events/mixed").json()["categories"]}
    assert public == {"Live": 3, "Dormant": 2}
    assert client.put(f"/api/admin/categories/{live.id}", json={"is_active": False}, headers=admin_headers).status_code == 200
    counts = client.get(f"{URL}/{event.id}", headers=admin_headers).json()["counts"]
    assert counts["active_questions"] == 3  # Dormant (2) + the uncategorised one
    assert counts["questions"] == 8  # the total never moves


def test_deleting_a_category_makes_its_questions_uncategorised_and_playable(client, admin_headers, mixed_pool):
    event, live, dormant = mixed_pool
    assert client.delete(f"/api/admin/categories/{dormant.id}", headers=admin_headers).status_code == 204
    counts = client.get(f"{URL}/{event.id}", headers=admin_headers).json()["counts"]
    assert counts["active_questions"] == 6  # 4 + the 2 active questions that lost their (inactive) category


# ---------------------------------------------------------------------------------------------
# a lost slug race (the pre-check said "free", the unique index says otherwise) is a 409, never a 500
# (the real concurrent proof, on PostgreSQL, is tests/test_slug_race.py)
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def blind_precheck(monkeypatch):
    """The slug pre-check always answers "free": every conflict is left to the unique index."""
    from app.routers import admin_events
    from app.services import bundle as bundle_service

    monkeypatch.setattr(admin_events, "ensure_slug_available", lambda *args, **kwargs: None)
    monkeypatch.setattr(bundle_service, "ensure_slug_available", lambda *args, **kwargs: None)


def assert_slug_conflict(response, slug):
    assert response.status_code == 409, response.text
    assert response.json() == {"detail": f"An event with the slug '{slug}' already exists"}


def test_create_with_a_taken_slug_is_a_409_even_when_the_pre_check_missed_it(client, admin_headers, blind_precheck):
    new_event(client, admin_headers, slug="taken")
    clash = client.post(URL, json={"slug": "taken", "name": "Other", "game_title": "G"}, headers=admin_headers)
    assert_slug_conflict(clash, "taken")


def test_rename_to_a_taken_slug_is_a_409_even_when_the_pre_check_missed_it(client, admin_headers, blind_precheck, db):
    new_event(client, admin_headers, slug="taken")
    other = new_event(client, admin_headers, slug="other")
    clash = client.put(f"{URL}/{other['id']}", json={"slug": "taken", "name": "Renamed"}, headers=admin_headers)
    assert_slug_conflict(clash, "taken")
    assert db.get(Event, other["id"]).slug == "other" and db.get(Event, other["id"]).name != "Renamed"


def test_duplicate_to_a_taken_slug_is_a_409_even_when_the_pre_check_missed_it(client, admin_headers, blind_precheck, db):
    source = new_event(client, admin_headers, slug="source")
    clash = client.post(f"{URL}/{source['id']}/duplicate", json={"slug": "source", "name": "Copy"}, headers=admin_headers)
    assert_slug_conflict(clash, "source")
    assert count(db, Event) == 1


def test_import_to_a_taken_slug_is_a_409_even_when_the_pre_check_missed_it(
    client, admin_headers, blind_precheck, sample_bundle, db
):
    first = client.post(f"{URL}/import", json={"bundle": sample_bundle()}, headers=admin_headers)
    assert first.status_code == 201, first.text
    clash = client.post(f"{URL}/import", json={"bundle": sample_bundle()}, headers=admin_headers)
    assert_slug_conflict(clash, "sample-event")
    assert count(db, Event) == 1 and count(db, Category) == 2 and count(db, Question) == 4  # nothing left behind


def test_an_integrity_error_that_is_not_the_slug_is_not_reported_as_a_slug_conflict(db, sample_bundle, monkeypatch):
    """Only the unique slug becomes a 409: any other integrity problem stays a real error."""
    from sqlalchemy.exc import IntegrityError

    from app.services import bundle as bundle_service

    def explode(*_args, **_kwargs):
        raise IntegrityError("INSERT INTO categories ...", {}, Exception("FOREIGN KEY constraint failed"))

    monkeypatch.setattr(db, "flush", explode)
    with pytest.raises(IntegrityError):
        bundle_service.import_bundle(db, sample_bundle())
