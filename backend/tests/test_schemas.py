import copy
from datetime import date, datetime

import pytest
from pydantic import ValidationError

from app.schemas import (
    RESERVED_SLUGS,
    AnswerSubmission,
    Branding,
    BrandingUpdate,
    BundleV1,
    CategoryCreate,
    CategoryUpdate,
    EventAdmin,
    EventCreate,
    EventDuplicate,
    EventImportRequest,
    EventSettings,
    EventSettingsUpdate,
    EventUpdate,
    GameSessionResponse,
    GameSubmitRequest,
    PlayerCreate,
    QuestionBulkRequest,
    QuestionCreate,
    QuestionUpdate,
    infer_question_format,
    normalize_question_fields,
    validate_slug,
)

CONTRACT_RESERVED = (
    "api admin assets shared css js vendor fonts static health docs openapi favicon robots scoreboard "
    "game events new login config index manifest sw"
).split()


def minimal_bundle(**event_overrides):
    event = {
        "slug": "demo-event",
        "name": "Demo Event",
        "game_title": "Demo Masters",
        "languages": ["en", "fr"],
        "default_language": "en",
    }
    event.update(event_overrides)
    return {"format": "gravitee-quiz-event", "version": 1, "event": event, "categories": [], "questions": []}


def full_bundle():
    return {
        "format": "gravitee-quiz-event",
        "version": 1,
        "event": {
            "slug": "world-ai-summit-2026",
            "name": "World Summit AI - Amsterdam 2026",
            "game_title": "AI Masters",
            "status": "live",
            "hero_title_en": "Become THE AI Master!",
            "hero_title_fr": "Devenez LE AI Master !",
            "tagline_en": "Answer fast",
            "tagline_fr": "Répondez vite",
            "description_en": "d",
            "description_fr": "d",
            "location": "Amsterdam",
            "starts_on": "2026-10-07",
            "ends_on": "2026-10-08",
            "languages": ["en", "fr"],
            "default_language": "en",
            "branding": {
                "primary_color": "#7c5cff",
                "accent_color": "#22D3EE",
                "background_style": "aurora",
                "logo_url": None,
                "default_theme": "dark",
                "show_join_qr": True,
            },
            "settings": {
                "questions_per_game": 15,
                "timer_seconds": 20,
                "points_correct": 100,
                "points_wrong": 0,
                "time_bonus_max": 50,
                "category_distribution": {"LLMs": 60, "Gravitee": 40},
                "question_order": "easy_to_hard",
                "collect_phone": "optional",
                "consent_text_en": None,
                "consent_text_fr": None,
            },
        },
        "categories": [
            {"name": "LLMs", "name_fr": "LLM", "description": "d", "description_fr": "d", "color": "#7C5CFF", "is_active": True},
            {"name": "Gravitee", "name_fr": None, "description": None, "description_fr": None, "color": "#FC5607", "is_active": True},
        ],
        "questions": [
            {
                "category": "LLMs",
                "question_format": "true_false",
                "difficulty": 1,
                "question_text_en": "LLMs predict tokens?",
                "question_text_fr": "Les LLM predisent des tokens ?",
                "correct_answer": "green",
                "green_label_en": "TRUE",
                "green_label_fr": "Vrai",
                "red_label_en": "FALSE",
                "red_label_fr": "Faux",
                "explanation_en": "yes",
                "explanation_fr": "oui",
                "is_active": True,
            },
            {
                "category": "Gravitee",
                "question_format": "two_choices",
                "difficulty": 2,
                "question_text_en": "Which proxy fronts MCP servers?",
                "question_text_fr": "Quel proxy expose les serveurs MCP ?",
                "correct_answer": "red",
                "green_label_en": "LLM Proxy",
                "green_label_fr": "Proxy LLM",
                "red_label_en": "MCP Proxy",
                "red_label_fr": "Proxy MCP",
                "explanation_en": None,
                "explanation_fr": None,
                "is_active": True,
            },
        ],
    }


# ---------------------------------------------------------------------------------------------
# slugs
# ---------------------------------------------------------------------------------------------
def test_reserved_slugs_match_the_contract():
    assert sorted(RESERVED_SLUGS) == sorted(CONTRACT_RESERVED)


@pytest.mark.parametrize("slug", ["ab", "api-masters", "world-ai-summit-2026", "a1", "x" * 48, "2026", "a-b-c"])
def test_valid_slugs(slug):
    assert validate_slug(slug) == slug


@pytest.mark.parametrize(
    "slug",
    ["a", "x" * 49, "Api-Masters", "api_masters", "-lead", "trail-", "dou--ble", "with space", "é-vent", "a/b", "", " api-masters"],
)
def test_invalid_slugs(slug):
    with pytest.raises(ValueError):
        validate_slug(slug)


@pytest.mark.parametrize("slug", CONTRACT_RESERVED)
def test_reserved_slugs_are_rejected_everywhere(slug):
    with pytest.raises(ValidationError, match="reserved"):
        EventCreate(slug=slug, name="n", game_title="g")
    with pytest.raises(ValidationError):
        EventDuplicate(slug=slug, name="n")
    with pytest.raises(ValidationError):
        BundleV1.model_validate(minimal_bundle(slug=slug))
    with pytest.raises(ValidationError):
        EventUpdate(slug=slug)


# ---------------------------------------------------------------------------------------------
# colours, branding, languages
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("color", ["FC5607", "#FC560", "#GGGGGG", "#FC56077", "rgb(1,2,3)", "", "#fc 607"])
def test_invalid_colors(color):
    with pytest.raises(ValidationError):
        Branding(primary_color=color)
    with pytest.raises(ValidationError):
        CategoryCreate(name="x", color=color)


def test_colors_are_normalised_to_uppercase():
    assert Branding(primary_color="#fc5607", accent_color="#abcdef").primary_color == "#FC5607"
    assert CategoryCreate(name="x", color="#a1b2c3").color == "#A1B2C3"


def test_branding_defaults_and_enums():
    branding = Branding()
    assert branding.model_dump() == {
        "primary_color": "#FC5607",
        "accent_color": "#FF9A52",
        "background_style": "aurora",
        "logo_url": None,
        "default_theme": "dark",
        "show_join_qr": True,
    }
    with pytest.raises(ValidationError):
        Branding(background_style="rainbow")
    with pytest.raises(ValidationError):
        Branding(default_theme="neon")


@pytest.mark.parametrize("url", ["javascript:alert(1)", "http://insecure.example/logo.png", "//evil.example/x.png", "ftp://x/y", "https://x/a b.png", "/x\"y"])
def test_logo_url_rules(url):
    with pytest.raises(ValidationError):
        Branding(logo_url=url)


@pytest.mark.parametrize("url", ["https://cdn.example.com/logo.svg", "/assets/logo.png", None, "   "])
def test_logo_url_accepted(url):
    assert Branding(logo_url=url).logo_url == (url.strip() or None if url else None)


@pytest.mark.parametrize("languages", [[], ["de"], ["en", "en"], ["en", "fr", "de"], ["EN"]])
def test_invalid_languages(languages):
    with pytest.raises(ValidationError):
        EventCreate(slug="ok-slug", name="n", game_title="g", languages=languages, default_language="en")


def test_default_language_must_be_in_languages():
    with pytest.raises(ValidationError, match="default_language"):
        EventCreate(slug="ok-slug", name="n", game_title="g", languages=["en"], default_language="fr")
    EventCreate(slug="ok-slug", name="n", game_title="g", languages=["fr"], default_language="fr")
    with pytest.raises(ValidationError, match="default_language"):
        EventUpdate(languages=["en"], default_language="fr")


def test_event_create_defaults_and_limits():
    event = EventCreate(slug="ok-slug", name="  Name  ", game_title="Quiz")
    assert event.name == "Name" and event.status == "draft"
    assert event.languages == ["en", "fr"] and event.default_language == "en"
    assert event.settings.questions_per_game == 15 and event.branding.primary_color == "#FC5607"
    for kwargs in (
        {"name": ""},
        {"name": "x" * 201},
        {"game_title": "x" * 101},
        {"status": "archived"},
        {"tagline_en": "x" * 301},
        {"hero_title_fr": "x" * 201},
        {"location": "x" * 201},
        {"starts_on": date(2026, 10, 8), "ends_on": date(2026, 10, 7)},
    ):
        base = {"slug": "ok-slug", "name": "n", "game_title": "g", **kwargs}
        with pytest.raises(ValidationError):
            EventCreate(**base)


def test_blank_optional_text_becomes_none():
    event = EventCreate(slug="ok-slug", name="n", game_title="g", tagline_en="   ", location="")
    assert event.tagline_en is None and event.location is None


# ---------------------------------------------------------------------------------------------
# settings & partial updates
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "field,value",
    [
        ("questions_per_game", 0),
        ("questions_per_game", 51),
        ("timer_seconds", 4),
        ("timer_seconds", 121),
        ("points_correct", -1),
        ("points_wrong", -1),
        ("time_bonus_max", -1),
        ("question_order", "alpha"),
        ("collect_phone", "yes"),
        ("category_distribution", {"abc": 10}),
        ("category_distribution", {"1": -5}),
        ("category_distribution", {"1": 0, "2": 0}),
    ],
)
def test_invalid_settings(field, value):
    with pytest.raises(ValidationError):
        EventSettings(**{field: value})
    with pytest.raises(ValidationError):
        EventSettingsUpdate(**{field: value})


def test_empty_category_distribution_is_normalised_to_none():
    assert EventSettings(category_distribution={}).category_distribution is None
    assert EventSettings(category_distribution={"1": 60, "2": 40}).category_distribution == {"1": 60, "2": 40}


def test_event_update_is_partial():
    update = EventUpdate(name="New", settings={"timer_seconds": 30}, branding={"primary_color": "#112233"})
    assert update.model_dump(exclude_unset=True) == {
        "name": "New",
        "settings": {"timer_seconds": 30},
        "branding": {"primary_color": "#112233"},
    }
    assert EventUpdate().model_dump(exclude_unset=True) == {}


def test_event_update_nullable_vs_non_nullable():
    cleared = EventUpdate(tagline_en=None, location="", starts_on=None, settings={"consent_text_en": None})
    dumped = cleared.model_dump(exclude_unset=True)
    assert dumped["tagline_en"] is None and dumped["location"] is None and dumped["starts_on"] is None
    assert dumped["settings"] == {"consent_text_en": None}
    for field in ("name", "slug", "game_title", "status", "languages", "default_language", "branding", "settings"):
        with pytest.raises(ValidationError, match="cannot be null"):
            EventUpdate(**{field: None})
    with pytest.raises(ValidationError, match="cannot be null"):
        EventSettingsUpdate(timer_seconds=None)
    with pytest.raises(ValidationError, match="cannot be null"):
        BrandingUpdate(primary_color=None)
    assert BrandingUpdate(logo_url=None).model_dump(exclude_unset=True) == {"logo_url": None}


def test_event_update_ignores_unknown_keys_so_an_spa_can_send_back_the_whole_object():
    update = EventUpdate(id=3, counts={"questions": 1}, created_at="2026-01-01T00:00:00Z", name="Same")
    assert update.model_dump(exclude_unset=True) == {"name": "Same"}


def test_category_update_partial():
    assert CategoryUpdate(is_active=False).model_dump(exclude_unset=True) == {"is_active": False}
    assert CategoryUpdate(name_fr=None).model_dump(exclude_unset=True) == {"name_fr": None}
    with pytest.raises(ValidationError):
        CategoryUpdate(name=None)
    with pytest.raises(ValidationError):
        CategoryCreate(name="x" * 101)
    with pytest.raises(ValidationError):
        CategoryCreate(name="x", name_fr="y" * 101)


# ---------------------------------------------------------------------------------------------
# questions
# ---------------------------------------------------------------------------------------------
def question(**kwargs):
    values = {"question_text_en": "Is the sky blue?", "correct_answer": "green"}
    values.update(kwargs)
    return QuestionCreate(**values)


def test_true_false_labels_are_normalised():
    q = question(green_label_en="Yes", red_label_en="No", green_label_fr="Oui", red_label_fr="Non")
    assert (q.green_label_en, q.green_label_fr, q.red_label_en, q.red_label_fr) == ("TRUE", "Vrai", "FALSE", "Faux")
    default = question()
    assert default.question_format == "true_false" and default.green_label_en == "TRUE"


def test_two_choices_rules():
    q = question(question_format="two_choices", green_label_en="GET", red_label_en="POST")
    assert (q.green_label_fr, q.red_label_fr) == ("GET", "POST")  # FR falls back to EN
    q = question(question_format="two_choices", green_label_en="A", red_label_en="B", green_label_fr="Un", red_label_fr="Deux")
    assert q.green_label_fr == "Un"
    for kwargs in (
        {"green_label_en": "A"},
        {"red_label_en": "B"},
        {"green_label_en": "same", "red_label_en": "SAME"},
        {"green_label_en": "x" * 101, "red_label_en": "B"},
        {"green_label_en": "A", "red_label_en": "B", "red_label_fr": "y" * 101},
    ):
        with pytest.raises(ValidationError):
            question(question_format="two_choices", **kwargs)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"question_text_en": ""},
        {"question_text_en": "x" * 2001},
        {"correct_answer": "blue"},
        {"difficulty": 0},
        {"difficulty": 6},
        {"question_format": "multiple"},
        {"media_url": "javascript:alert(1)"},
        {"question_type": "Text With Spaces"},
    ],
)
def test_invalid_questions(kwargs):
    with pytest.raises(ValidationError):
        question(**kwargs)


def test_question_defaults():
    q = question()
    assert (q.difficulty, q.is_active, q.question_type, q.question_text_fr, q.category_id) == (1, True, "text", None, None)


def test_normalize_question_fields_and_infer_format():
    data = normalize_question_fields({"question_format": "true_false", "green_label_en": "x"})
    assert data["red_label_fr"] == "Faux"
    assert infer_question_format("true", "False") == "true_false"
    assert infer_question_format("TRUE", "NOPE") == "two_choices"
    assert infer_question_format(None, None) == "two_choices"


def test_question_update_resolve_applies_format_rules_on_the_merged_state():
    current = {
        "category_id": 3, "question_format": "two_choices", "question_text_en": "Q", "question_text_fr": None,
        "question_type": "text", "media_url": None, "correct_answer": "green", "green_label_en": "GET",
        "green_label_fr": "GET", "red_label_en": "POST", "red_label_fr": "POST", "explanation_en": None,
        "explanation_fr": None, "is_active": True, "difficulty": 1,
    }
    # plain field change: only that field is returned
    assert QuestionUpdate(difficulty=3).resolve(current) == {"difficulty": 3}
    # relabel one side only
    assert QuestionUpdate(red_label_en="PATCH", red_label_fr="PATCH").resolve(current) == {
        "red_label_en": "PATCH",
        "red_label_fr": "PATCH",
    }
    # switching to true_false rewrites the labels
    changes = QuestionUpdate(question_format="true_false").resolve(current)
    assert changes == {
        "question_format": "true_false",
        "green_label_en": "TRUE", "green_label_fr": "Vrai", "red_label_en": "FALSE", "red_label_fr": "Faux",
    }
    # un-categorise with an explicit null
    assert QuestionUpdate(category_id=None).resolve(current) == {"category_id": None}
    # invalid merged state
    with pytest.raises(ValueError):
        QuestionUpdate(red_label_en="get").resolve(current)
    with pytest.raises(ValidationError):
        QuestionUpdate(correct_answer=None)
    with pytest.raises(ValidationError):
        QuestionUpdate(difficulty=9)


def test_bulk_request_rules():
    assert QuestionBulkRequest(ids=[1, 2], action="activate").action == "activate"
    assert QuestionBulkRequest(ids=[1], action="set_category", category_id=None).category_id is None
    assert QuestionBulkRequest(ids=[1], action="set_difficulty", difficulty=2).difficulty == 2
    for kwargs in (
        {"ids": [], "action": "delete"},
        {"ids": [1], "action": "explode"},
        {"ids": [1], "action": "set_category"},
        {"ids": [1], "action": "set_difficulty"},
        {"ids": [1], "action": "set_difficulty", "difficulty": 7},
    ):
        with pytest.raises(ValidationError):
            QuestionBulkRequest(**kwargs)


# ---------------------------------------------------------------------------------------------
# players / games
# ---------------------------------------------------------------------------------------------
def test_player_create():
    p = PlayerCreate(first_name=" Ada ", last_name="Lovelace", email="ada@example.com", phone_number="  ")
    assert p.first_name == "Ada" and p.phone_number is None and p.consent is None
    assert PlayerCreate(first_name="A", last_name="B", email="a@example.com", phone_number="+33 6 12 34 56 78", consent=True).consent is True
    for kwargs in (
        {"first_name": "ada@example.com"},
        {"last_name": "x@y"},
        {"first_name": ""},
        {"email": "not-an-email"},
        {"phone_number": "1" * 21},
    ):
        values = {"first_name": "Ada", "last_name": "L", "email": "a@example.com", **kwargs}
        with pytest.raises(ValidationError):
            PlayerCreate(**values)


def test_answer_submission_and_submit_request():
    assert AnswerSubmission(question_id=1, player_answer=None, time_taken=2.5).player_answer is None
    assert AnswerSubmission(question_id=1).time_taken == 0
    for kwargs in ({"player_answer": "blue"}, {"time_taken": -1}, {"time_taken": float("nan")}, {"time_taken": float("inf")}):
        with pytest.raises(ValidationError):
            AnswerSubmission(question_id=1, **kwargs)
    with pytest.raises(ValidationError, match="same question twice"):
        GameSubmitRequest(answers=[{"question_id": 1}, {"question_id": 1}])
    with pytest.raises(ValidationError):
        GameSubmitRequest(answers=[{"question_id": i} for i in range(101)])
    assert GameSubmitRequest(answers=[]).answers == []


def test_datetimes_serialise_as_utc_with_z():
    session = GameSessionResponse(
        id=1, player_id=2, status="completed", total_score=10, correct_answers=1, wrong_answers=0,
        unanswered=0, started_at=datetime(2026, 10, 7, 9, 30, 0), completed_at=None,
    )
    assert session.model_dump(mode="json")["started_at"] == "2026-10-07T09:30:00Z"


# ---------------------------------------------------------------------------------------------
# bundle v1
# ---------------------------------------------------------------------------------------------
def test_minimal_bundle_is_valid():
    bundle = BundleV1.model_validate(minimal_bundle())
    assert bundle.event.status == "draft" and bundle.event.branding.primary_color == "#FC5607"
    assert bundle.event.settings.questions_per_game == 15


def test_full_bundle_roundtrip():
    bundle = BundleV1.model_validate(full_bundle())
    assert bundle.event.branding.primary_color == "#7C5CFF"  # normalised
    assert bundle.questions[0].green_label_en == "TRUE"
    dumped = bundle.model_dump(mode="json")
    assert BundleV1.model_validate(dumped) == bundle
    assert dumped["event"]["starts_on"] == "2026-10-07"
    request = EventImportRequest.model_validate({"bundle": full_bundle(), "slug": "ai-masters-test", "status": "draft"})
    assert request.slug == "ai-masters-test"


def _mutated(mutator):
    data = copy.deepcopy(full_bundle())
    mutator(data)
    return data


@pytest.mark.parametrize(
    "mutator",
    [
        lambda d: d.update(format="other"),
        lambda d: d.update(version=2),
        lambda d: d.pop("event"),
        lambda d: d.update(unknown_key=1),
        lambda d: d["event"].update(unknown_key=1),
        lambda d: d["event"]["branding"].update(unknown_key=1),
        lambda d: d["event"]["settings"].update(unknown_key=1),
        lambda d: d["event"].update(slug="api"),
        lambda d: d["event"].update(slug="Bad Slug"),
        lambda d: d["event"].update(languages=["en", "de"]),
        lambda d: d["event"].update(languages=[]),
        lambda d: d["event"].update(languages=["fr"], default_language="en"),
        lambda d: d["event"].update(status="published"),
        lambda d: d["event"].update(starts_on="2026-10-09"),
        lambda d: d["event"]["branding"].update(primary_color="orange"),
        lambda d: d["event"]["branding"].update(default_theme="blue"),
        lambda d: d["event"]["settings"].update(questions_per_game=99),
        lambda d: d["event"]["settings"].update(timer_seconds=1),
        lambda d: d["event"]["settings"].update(question_order="shuffle"),
        lambda d: d["event"]["settings"].update(category_distribution={"Unknown": 10}),
        lambda d: d["event"]["settings"].update(category_distribution={"LLMs": -1}),
        lambda d: d["categories"].append(dict(d["categories"][0])),
        lambda d: d["categories"][0].update(color="#12"),
        lambda d: d["categories"][0].update(name=""),
        lambda d: d["categories"][0].update(extra="x"),
        lambda d: d["questions"][0].update(category="Nope"),
        lambda d: d["questions"][0].update(difficulty=0),
        lambda d: d["questions"][0].update(difficulty=6),
        lambda d: d["questions"][0].update(correct_answer="yellow"),
        lambda d: d["questions"][0].update(question_format="open"),
        lambda d: d["questions"][0].update(question_text_en=""),
        lambda d: d["questions"][0].update(surprise=True),
        lambda d: d["questions"][1].update(green_label_en="x" * 101),
        lambda d: d["questions"][1].update(red_label_en="LLM Proxy"),
        lambda d: d["questions"][1].update(green_label_en=None),
    ],
)
def test_invalid_bundles(mutator):
    with pytest.raises(ValidationError):
        BundleV1.model_validate(_mutated(mutator))


def test_bundle_true_false_labels_are_normalised_not_rejected():
    data = _mutated(lambda d: d["questions"][0].update(green_label_en="Yes", red_label_en="No"))
    bundle = BundleV1.model_validate(data)
    assert (bundle.questions[0].green_label_en, bundle.questions[0].red_label_en) == ("TRUE", "FALSE")


def test_bundle_question_without_category_is_allowed():
    data = _mutated(lambda d: d["questions"][0].update(category=None))
    assert BundleV1.model_validate(data).questions[0].category is None


def test_event_admin_schema_from_orm_like_data():
    admin = EventAdmin.model_validate(
        {
            "id": 1, "slug": "demo", "name": "Demo", "game_title": "Demo", "status": "live",
            "languages": ["en"], "default_language": "en", "branding": {"primary_color": "#abcdef"},
            "settings": {}, "created_at": datetime(2026, 1, 1), "updated_at": datetime(2026, 1, 2),
        }
    )
    assert admin.branding.primary_color == "#ABCDEF" and admin.branding.background_style == "aurora"
    assert admin.counts.questions == 0
    assert admin.model_dump(mode="json")["created_at"] == "2026-01-01T00:00:00Z"


def test_conftest_sample_bundle_is_valid(sample_bundle):
    bundle = BundleV1.model_validate(sample_bundle())
    assert len(bundle.categories) == 2 and len(bundle.questions) == 4
    assert {q.question_format for q in bundle.questions} == {"true_false", "two_choices"}


def test_every_schema_can_produce_a_json_schema():
    """FastAPI builds /api/openapi.json from these: none may blow up."""
    import inspect

    from pydantic import BaseModel

    import app.schemas as schemas

    models = [m for _, m in inspect.getmembers(schemas, inspect.isclass) if issubclass(m, BaseModel) and m is not BaseModel]
    assert len(models) > 60
    for model in models:
        assert model.model_json_schema()
        assert model.model_json_schema(mode="serialization")


# ---------------------------------------------------------------------------------------------
# QuestionUpdate.resolve: no stale French labels when the format switches
# ---------------------------------------------------------------------------------------------
TRUE_FALSE_CURRENT = {
    "category_id": None, "question_format": "true_false", "question_text_en": "Q", "question_text_fr": None,
    "question_type": "text", "media_url": None, "correct_answer": "green", "green_label_en": "TRUE",
    "green_label_fr": "Vrai", "red_label_en": "FALSE", "red_label_fr": "Faux", "explanation_en": None,
    "explanation_fr": None, "is_active": True, "difficulty": 1,
}


def test_switching_true_false_to_two_choices_with_english_labels_only_drops_the_old_translations():
    changes = QuestionUpdate(question_format="two_choices", green_label_en="Yes", red_label_en="No").resolve(
        TRUE_FALSE_CURRENT
    )
    assert changes == {
        "question_format": "two_choices",
        "green_label_en": "Yes", "green_label_fr": "Yes",  # not "Vrai"
        "red_label_en": "No", "red_label_fr": "No",  # not "Faux"
    }  # fmt: skip


def test_switching_keeps_the_french_labels_that_are_sent():
    changes = QuestionUpdate(
        question_format="two_choices", green_label_en="Yes", green_label_fr="Oui", red_label_en="No"
    ).resolve(TRUE_FALSE_CURRENT)
    assert (changes["green_label_fr"], changes["red_label_fr"]) == ("Oui", "No")


def test_switching_with_no_label_at_all_changes_nothing_but_the_format():
    """The stored pair is still consistent (TRUE/Vrai, FALSE/Faux): nothing is stale, nothing is invented."""
    assert QuestionUpdate(question_format="two_choices").resolve(TRUE_FALSE_CURRENT) == {"question_format": "two_choices"}


def test_switching_with_only_one_side_relabelled_resets_only_that_side():
    changes = QuestionUpdate(question_format="two_choices", green_label_en="Yes").resolve(TRUE_FALSE_CURRENT)
    assert changes == {"question_format": "two_choices", "green_label_en": "Yes", "green_label_fr": "Yes"}


def test_an_explicit_null_french_label_means_fall_back_to_english():
    """The admin console sends null for a blank French label (it used to be a 422)."""
    current = {**TRUE_FALSE_CURRENT, "question_format": "two_choices", "green_label_en": "GET", "green_label_fr": "OBTENIR",
               "red_label_en": "POST", "red_label_fr": "ENVOYER"}  # fmt: skip
    update = QuestionUpdate(green_label_fr=None, red_label_fr="")
    assert update.model_dump(exclude_unset=True) == {"green_label_fr": None, "red_label_fr": None}
    assert update.resolve(current) == {"green_label_fr": "GET", "red_label_fr": "POST"}
    full = QuestionUpdate(
        question_format="two_choices", green_label_en="Yes", green_label_fr=None, red_label_en="No", red_label_fr=None
    )
    assert full.resolve(TRUE_FALSE_CURRENT)["green_label_fr"] == "Yes"


def test_english_labels_still_cannot_be_null_or_blank():
    for field in ("green_label_en", "red_label_en"):
        with pytest.raises(ValidationError, match="cannot be null"):
            QuestionUpdate(**{field: None})
        with pytest.raises(ValidationError, match="cannot be null"):
            QuestionUpdate(**{field: "  "})


def test_relabelling_within_two_choices_is_a_plain_partial_update():
    """Outside a format switch nothing is reset: the French label stays where the request did not touch it."""
    current = {**TRUE_FALSE_CURRENT, "question_format": "two_choices", "green_label_en": "GET", "green_label_fr": "OBTENIR",
               "red_label_en": "POST", "red_label_fr": "ENVOYER"}  # fmt: skip
    assert QuestionUpdate(green_label_en="FETCH").resolve(current) == {"green_label_en": "FETCH"}


def test_round_trip_two_choices_to_true_false_and_back_never_resurrects_old_labels():
    current = {**TRUE_FALSE_CURRENT, "question_format": "two_choices", "green_label_en": "GET", "green_label_fr": "OBTENIR",
               "red_label_en": "POST", "red_label_fr": "ENVOYER"}  # fmt: skip
    to_tf = QuestionUpdate(question_format="true_false").resolve(current)
    assert to_tf["green_label_fr"] == "Vrai" and to_tf["red_label_fr"] == "Faux"
    back = QuestionUpdate(question_format="two_choices", green_label_en="Left", red_label_en="Right").resolve(
        {**current, **to_tf}
    )
    assert (back["green_label_fr"], back["red_label_fr"]) == ("Left", "Right")


@pytest.mark.parametrize(
    "url",
    [
        "https://user@evil.example/x.png",  # userinfo
        "https://trusted.example@evil.example/x.png",
        "https://",  # empty host
        "https:///x.png",
        "https://.example/x.png",
        "https://exa mple.com/x.png",
        "https://example.com:99999/x.png",
        "https://example.com/a%0d%0aSet-Cookie:x",  # encoded CR LF
        "https://example.com/a%0Ab.png",
        "https://example.com/a‮b.png",  # bidi override
        "https://example.com/a​b.png",  # zero width
        "https://example.com/a\x00b.png",
        "/\\evil.example/x.png",  # backslash
        "//evil.example/x.png",  # protocol-relative
        "/a/../b.png",
        "/a/%2e%2e/b.png",
        "/a b.png",
        "/a\nb.png",
        "/a%0d%0ab.png",
        "/a⁦b.png",
        "data:image/png;base64,AAAA",
        "http://example.com/x.png",
        "x" * 501,
    ],
)
def test_asset_urls_are_strict(url):
    with pytest.raises(ValidationError):
        Branding(logo_url=url)


@pytest.mark.parametrize(
    "url",
    [
        "https://cdn.example.com/logo.svg",
        "https://cdn.example.com:8443/a/b.png?v=2#x",
        "https://xn--caf-dma.example/logo.png",
        "https://example.com",
        "/assets/logo.png",
        "/assets/a-b_c.v2.png?v=3",
        "/",
    ],
)
def test_asset_urls_that_are_fine_stay_valid(url):
    assert Branding(logo_url=url).logo_url == url
