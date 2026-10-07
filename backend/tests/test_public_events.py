"""GET /api/events, GET /api/events/{slug}, POST /api/events/{slug}/players."""
from datetime import date

import pytest

from app.models import Player

PLAYER = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@example.com"}


def register(client, slug, headers=None, **overrides):
    body = {**PLAYER, **overrides}
    return client.post(f"/api/events/{slug}/players", json=body, headers=headers or {})


# ---------------------------------------------------------------------------------------------
# GET /api/events
# ---------------------------------------------------------------------------------------------
def test_list_events_returns_live_events_only(client, make_event):
    make_event(slug="draft-one", status="draft")
    make_event(slug="live-one", status="live")
    make_event(slug="closed-one", status="closed")
    response = client.get("/api/events")
    assert response.status_code == 200
    assert [e["slug"] for e in response.json()] == ["live-one"]


def test_list_events_empty(client):
    response = client.get("/api/events")
    assert response.status_code == 200
    assert response.json() == []


def test_list_events_order_by_start_date_then_creation(client, make_event):
    make_event(slug="undated-first")
    make_event(slug="late", starts_on=date(2026, 12, 1))
    make_event(slug="early", starts_on=date(2026, 10, 7))
    make_event(slug="undated-second")
    slugs = [e["slug"] for e in client.get("/api/events").json()]
    assert slugs == ["early", "late", "undated-first", "undated-second"]


def test_list_events_summary_shape(client, make_event):
    make_event(
        slug="ai-masters", name="World AI Summit", game_title="AI Masters", tagline_en="Fast", location="Amsterdam",
        starts_on=date(2026, 10, 7), ends_on=date(2026, 10, 8),
        branding={"primary_color": "#7C5CFF", "accent_color": "#22D3EE", "background_style": "grid",
                  "logo_url": None, "default_theme": "light"},
    )
    (item,) = client.get("/api/events").json()
    assert set(item) == {
        "slug", "name", "game_title", "status", "tagline_en", "tagline_fr", "description_en", "description_fr",
        "location", "starts_on", "ends_on", "languages", "default_language", "branding",
    }
    assert item["game_title"] == "AI Masters"
    assert item["starts_on"] == "2026-10-07"
    assert item["branding"]["primary_color"] == "#7C5CFF"
    assert item["languages"] == ["en", "fr"]
    assert item["status"] == "live"


def test_list_events_never_leaks_admin_fields(client, make_event):
    make_event(slug="x-event", consent_text_en="I agree")
    (item,) = client.get("/api/events").json()
    for key in ("id", "settings", "counts", "consent_text_en", "category_distribution", "created_at"):
        assert key not in item


# ---------------------------------------------------------------------------------------------
# GET /api/events/{slug}
# ---------------------------------------------------------------------------------------------
def test_get_event_full_shape(client, make_event, make_category, make_question, make_player, make_game_session):
    event = make_event(
        slug="api-masters", game_title="API Masters", hero_title_en="Become THE API Master!", questions_per_game=7,
        timer_seconds=25, points_correct=120, points_wrong=5, time_bonus_max=60, collect_phone="required",
        consent_text_en="I agree", question_order="easy_to_hard",
    )
    cat = make_category(event, name="Gateway", name_fr="Passerelle", color="#112233")
    make_question(event, cat)
    make_question(event, cat)
    make_game_session(event, make_player(event))
    make_player(event)

    response = client.get("/api/events/api-masters")
    assert response.status_code == 200
    body = response.json()
    assert body["hero_title_en"] == "Become THE API Master!"
    assert body["settings"] == {
        "questions_per_game": 7, "timer_seconds": 25, "points_correct": 120, "points_wrong": 5,
        "time_bonus_max": 60, "question_order": "easy_to_hard", "collect_phone": "required",
        "consent_text_en": "I agree", "consent_text_fr": None,
    }
    assert body["categories"] == [
        {"id": cat.id, "name": "Gateway", "name_fr": "Passerelle", "color": "#112233", "question_count": 2}
    ]
    assert body["stats"] == {"players": 2, "games_completed": 1}


def test_get_event_does_not_expose_secrets(client, make_event):
    make_event(slug="safe-event", category_distribution={"1": 10})
    body = client.get("/api/events/safe-event").json()
    assert "category_distribution" not in body["settings"]
    assert "id" not in body and "counts" not in body


def test_get_event_lists_only_active_categories_with_active_questions(client, make_event, make_category, make_question):
    event = make_event(slug="cats-event")
    good = make_category(event, name="Good")
    inactive_cat = make_category(event, name="Inactive cat", is_active=False)
    empty = make_category(event, name="Empty")
    only_inactive_questions = make_category(event, name="Only inactive questions")
    make_question(event, good)
    make_question(event, good, is_active=False)  # not counted
    make_question(event, inactive_cat)
    make_question(event, only_inactive_questions, is_active=False)
    names = {c["name"]: c["question_count"] for c in client.get("/api/events/cats-event").json()["categories"]}
    assert names == {"Good": 1}
    assert empty.id and inactive_cat.id  # created, but hidden


def test_get_event_counts_only_its_own_data(client, make_event, make_category, make_question, make_player):
    mine, other = make_event(slug="mine"), make_event(slug="other")
    make_question(mine, make_category(mine))
    make_question(other, make_category(other))
    make_player(other)
    body = client.get("/api/events/mine").json()
    assert [c["question_count"] for c in body["categories"]] == [1]
    assert body["stats"] == {"players": 0, "games_completed": 0}


def test_get_unknown_event_is_404(client):
    response = client.get("/api/events/nope")
    assert response.status_code == 404
    assert response.json() == {"detail": "Event not found"}


def test_get_draft_event_is_404_for_the_public_but_visible_to_admins(client, make_event, admin_headers):
    make_event(slug="secret", status="draft")
    assert client.get("/api/events/secret").status_code == 404
    assert client.get("/api/events/secret", headers={"Authorization": "Bearer garbage"}).status_code == 404
    response = client.get("/api/events/secret", headers=admin_headers)
    assert response.status_code == 200
    assert response.json()["status"] == "draft"


def test_get_closed_event_is_readable(client, make_event):
    make_event(slug="over", status="closed")
    response = client.get("/api/events/over")
    assert response.status_code == 200
    assert response.json()["status"] == "closed"


def test_draft_is_not_in_the_listing_even_for_admins(client, make_event, admin_headers):
    make_event(slug="secret", status="draft")
    assert client.get("/api/events", headers=admin_headers).json() == []


# ---------------------------------------------------------------------------------------------
# POST /api/events/{slug}/players
# ---------------------------------------------------------------------------------------------
def test_register_player_happy_path(client, make_event, db):
    event = make_event(slug="reg")
    response = register(client, "reg", phone_number="+33 6 12 34 56 78")
    assert response.status_code == 201
    body = response.json()
    assert body["event_id"] == event.id
    assert body["first_name"] == "Ada" and body["last_name"] == "Lovelace"
    assert body["email"] == "ada@example.com"
    assert body["phone_number"] == "+33 6 12 34 56 78"
    assert body["consent_at"] is None
    assert body["created_at"].endswith("Z")
    stored = db.get(Player, body["id"])
    assert stored.event_id == event.id


def test_register_trims_and_normalises_input(client, make_event):
    make_event(slug="reg")
    body = register(
        client, "reg", first_name="  Jean   Pierre ", last_name="\tde  la Cruz\n", email="  Ada.Love@Example.COM "
    ).json()
    assert body["first_name"] == "Jean Pierre"
    assert body["last_name"] == "de la Cruz"
    assert body["email"] == "ada.love@example.com"


def test_register_accepts_accents_hyphens_and_apostrophes(client, make_event):
    make_event(slug="reg")
    response = register(client, "reg", first_name="Élodie-Anne", last_name="O'Brien", email="e@example.com")
    assert response.status_code == 201
    assert response.json()["first_name"] == "Élodie-Anne"


@pytest.mark.parametrize(
    "field,value",
    [
        ("first_name", ""),
        ("first_name", "   "),
        ("last_name", ""),
        ("first_name", "ada@example.com"),  # an e-mail instead of a name
        ("last_name", "x@y.z"),
        ("first_name", "1234"),  # no letter
        ("last_name", "---"),
        ("first_name", "A" * 101),
        ("first_name", "Ada\x00"),  # control character
        ("first_name", "Ada\x07bell"),
        ("email", "not-an-email"),
        ("email", ""),
        ("email", "a@b"),
        ("email", "x" * 250 + "@example.com"),
    ],
)
def test_register_rejects_invalid_input(client, make_event, db, field, value):
    make_event(slug="reg")
    response = register(client, "reg", **{field: value})
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], list)
    assert db.query(Player).count() == 0


INVISIBLE_CHARS = [
    *(chr(c) for c in range(0x200B, 0x2010)),  # zero width space / non joiner / joiner, LRM, RLM
    *(chr(c) for c in range(0x202A, 0x202F)),  # LRE RLE PDF LRO RLO
    *(chr(c) for c in range(0x2060, 0x2065)),  # word joiner + invisible operators
    *(chr(c) for c in range(0x2066, 0x206A)),  # LRI RLI FSI PDI
    "\ufeff",  # BOM / zero width no-break space
    "\u061c",  # Arabic letter mark
]


@pytest.mark.parametrize("field", ["first_name", "last_name"])
@pytest.mark.parametrize("char", INVISIBLE_CHARS, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize("where", ["inside", "leading", "trailing"])
def test_register_rejects_bidi_and_zero_width_characters_in_names(client, make_event, db, field, char, where):
    make_event(slug="reg")
    value = {"inside": f"Ad{char}a", "leading": f"{char}Ada", "trailing": f"Ada{char}"}[where]
    response = register(client, "reg", **{field: value})
    assert response.status_code == 422, response.text
    errors = response.json()["detail"]
    assert errors[0]["loc"] == ["body", field] and errors[0]["msg"] == "Name contains invalid characters"
    assert db.query(Player).count() == 0


def test_a_bidi_override_cannot_hide_a_name_swap(client, make_event, db):
    """The classic: RLO makes 'Ada\u202eEVIL' display as 'AdaLIVE' on the big screen."""
    make_event(slug="reg")
    assert register(client, "reg", first_name="Ada\u202eEVIL", last_name="Lovelace").status_code == 422
    assert register(client, "reg", first_name="Ada", last_name="\u2066Lovelace\u2069").status_code == 422
    assert db.query(Player).count() == 0


@pytest.mark.parametrize(
    "first,last",
    [
        ("Élodie-Anne", "O'Brien"),
        ("Zoë", "Müller"),
        ("Søren", "Ærøskøbing"),
        ("José", "Peña"),
        ("山田", "太郎"),
        ("Анна", "Иванова"),
        ("محمد", "الفارسي"),
        ("שרה", "כהן"),
        ("Nguyễn", "Thị Minh Khai"),
        ("Jean-Luc", "van der Berg"),
        ("Ada", "Lovelace Jr."),
        ("Zoe\u0301", "Cafe\u0301"),  # combining accents (NFD) are letters + marks, not invisible characters
    ],
)
def test_register_still_accepts_international_names(client, make_event, first, last):
    make_event(slug="reg")
    assert register(client, "reg", first_name=first, last_name=last).status_code == 201


def test_register_missing_fields(client, make_event):
    make_event(slug="reg")
    response = client.post("/api/events/reg/players", json={"first_name": "Ada"})
    assert response.status_code == 422


def test_register_same_email_twice_creates_two_players(client, make_event, db):
    make_event(slug="reg")
    first = register(client, "reg").json()
    second = register(client, "reg", first_name="Grace").json()
    assert first["id"] != second["id"]
    assert db.query(Player).count() == 2


def test_register_on_unknown_event_is_404(client):
    assert register(client, "nope").status_code == 404


def test_register_on_closed_event_is_403_event_closed(client, make_event, db):
    make_event(slug="over", status="closed")
    response = register(client, "over")
    assert response.status_code == 403
    assert response.json() == {"detail": "event_closed"}
    assert db.query(Player).count() == 0


def test_register_on_draft_event_is_404_but_admins_can_preview(client, make_event, admin_headers):
    make_event(slug="secret", status="draft")
    assert register(client, "secret").status_code == 404
    assert register(client, "secret", headers=admin_headers).status_code == 201


def test_register_on_closed_event_is_refused_even_for_admins(client, make_event, admin_headers):
    make_event(slug="over", status="closed")
    assert register(client, "over", headers=admin_headers).status_code == 403


# -- phone ----------------------------------------------------------------------------------------
def test_phone_optional_may_be_omitted_or_blank(client, make_event):
    make_event(slug="reg", collect_phone="optional")
    assert register(client, "reg").json()["phone_number"] is None
    assert register(client, "reg", phone_number="").json()["phone_number"] is None
    assert register(client, "reg", phone_number="   ").json()["phone_number"] is None
    assert register(client, "reg", phone_number=None).json()["phone_number"] is None


def test_phone_optional_is_stored_when_given(client, make_event):
    make_event(slug="reg", collect_phone="optional")
    assert register(client, "reg", phone_number=" 06 12 34 56 78 ").json()["phone_number"] == "06 12 34 56 78"


def test_phone_required_must_be_present(client, make_event, db):
    make_event(slug="reg", collect_phone="required")
    for body in ({}, {"phone_number": ""}, {"phone_number": "   "}, {"phone_number": None}):
        response = register(client, "reg", **body)
        assert response.status_code == 422, body
        assert response.json()["detail"][0]["loc"] == ["body", "phone_number"]
    assert db.query(Player).count() == 0
    assert register(client, "reg", phone_number="+31 20 123 4567").status_code == 201


def test_phone_hidden_is_ignored_even_if_sent(client, make_event, db):
    make_event(slug="reg", collect_phone="hidden")
    response = register(client, "reg", phone_number="0612345678")
    assert response.status_code == 201
    assert response.json()["phone_number"] is None
    assert db.query(Player).one().phone_number is None


def test_phone_hidden_ignores_even_garbage(client, make_event):
    make_event(slug="reg", collect_phone="hidden")
    assert register(client, "reg", phone_number="not a phone").status_code == 201


@pytest.mark.parametrize("phone", ["abc", "12", "+++123456", "0612-34-ab-78", "123456789012345678", "<script>"])
def test_phone_invalid_values_are_rejected_when_collected(client, make_event, phone):
    make_event(slug="reg", collect_phone="optional")
    response = register(client, "reg", phone_number=phone)
    assert response.status_code == 422, phone


@pytest.mark.parametrize("phone", ["0612345678", "+33 6 12 34 56 78", "(555) 123-4567", "06.12.34.56.78", "+44 (0)7700 900123"])
def test_phone_common_formats_are_accepted(client, make_event, phone):
    make_event(slug="reg", collect_phone="optional")
    assert register(client, "reg", phone_number=phone).status_code == 201


def test_phone_longer_than_the_column_is_a_422(client, make_event):
    make_event(slug="reg", collect_phone="optional")
    assert register(client, "reg", phone_number="1" * 21).status_code == 422


# -- consent --------------------------------------------------------------------------------------
def test_no_consent_text_means_no_consent_needed_and_no_consent_at(client, make_event):
    make_event(slug="reg")
    assert register(client, "reg").json()["consent_at"] is None
    # sending consent anyway does not record a consent that was never asked for
    assert register(client, "reg", consent=True).json()["consent_at"] is None


@pytest.mark.parametrize("language", ["en", "fr"])
def test_consent_text_in_any_language_makes_consent_required(client, make_event, db, language):
    make_event(slug="reg", **{f"consent_text_{language}": "I agree to be contacted"})
    for body in ({}, {"consent": False}, {"consent": None}):
        response = register(client, "reg", **body)
        assert response.status_code == 422, body
        assert response.json()["detail"][0]["loc"] == ["body", "consent"]
    assert db.query(Player).count() == 0


def test_consent_given_is_timestamped(client, make_event, db):
    make_event(slug="reg", consent_text_en="I agree")
    response = register(client, "reg", consent=True)
    assert response.status_code == 201
    body = response.json()
    assert body["consent_at"] is not None and body["consent_at"].endswith("Z")
    assert db.get(Player, body["id"]).consent_at is not None


def test_consent_and_phone_rules_combine(client, make_event):
    make_event(slug="reg", consent_text_en="I agree", collect_phone="required")
    assert register(client, "reg", consent=True).status_code == 422  # phone missing
    assert register(client, "reg", phone_number="0612345678").status_code == 422  # consent missing
    assert register(client, "reg", phone_number="0612345678", consent=True).status_code == 201


def test_registration_is_scoped_to_the_event_in_the_url(client, make_event, db):
    one, two = make_event(slug="one"), make_event(slug="two")
    register(client, "one")
    register(client, "two")
    assert [p.event_id for p in db.query(Player).order_by(Player.id)] == [one.id, two.id]


def test_registration_rules_come_from_the_event_in_the_url(client, make_event):
    make_event(slug="strict", collect_phone="required", consent_text_en="ok")
    make_event(slug="relaxed", collect_phone="hidden")
    assert register(client, "strict").status_code == 422
    assert register(client, "relaxed").status_code == 201
