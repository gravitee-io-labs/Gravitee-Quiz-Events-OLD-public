"""docs/ARCHITECTURE.md sections 4-6 as executable checks.

The frontends are written against that document, so a field that disappears breaks them and a field that
appears on a PUBLIC schema may leak (answers, e-mails). Public schemas are therefore compared for EXACT
equality, admin schemas must contain at least the documented fields.
"""
import pytest
from fastapi.routing import APIRoute

from app import schemas as s
from app.main import app


def fields(model) -> set[str]:
    return set(model.model_fields)


# ---------------------------------------------------------------------------------------------
# routes: method + path + status code (5.1, 5.2, 5.3)
# ---------------------------------------------------------------------------------------------
CONTRACT_ROUTES = {
    # (method, path): success status
    ("GET", "/api/health"): 200,
    ("GET", "/health"): 200,
    ("GET", "/api/livez"): 200,
    ("GET", "/livez"): 200,
    ("GET", "/api/events"): 200,
    ("GET", "/api/events/{slug}"): 200,
    ("POST", "/api/events/{slug}/players"): 201,
    ("POST", "/api/events/{slug}/games"): 200,
    ("POST", "/api/events/{slug}/games/{game_id}/submit"): 200,
    ("GET", "/api/events/{slug}/games/{game_id}/result"): 200,
    ("GET", "/api/events/{slug}/scoreboard"): 200,
    ("GET", "/api/events/{slug}/scoreboard/stream"): 200,
    ("POST", "/api/auth/login"): 200,
    ("POST", "/api/auth/logout"): 200,
    ("GET", "/api/auth/me"): 200,
    ("GET", "/api/admin/events"): 200,
    ("POST", "/api/admin/events"): 201,
    ("GET", "/api/admin/events/{event_id}"): 200,
    ("PUT", "/api/admin/events/{event_id}"): 200,
    ("DELETE", "/api/admin/events/{event_id}"): 204,
    ("POST", "/api/admin/events/{event_id}/duplicate"): 201,
    ("GET", "/api/admin/events/{event_id}/export"): 200,
    ("POST", "/api/admin/events/import"): 201,
    ("GET", "/api/admin/events/{event_id}/stats"): 200,
    ("GET", "/api/admin/events/{event_id}/categories"): 200,
    ("POST", "/api/admin/events/{event_id}/categories"): 201,
    ("PUT", "/api/admin/categories/{category_id}"): 200,
    ("DELETE", "/api/admin/categories/{category_id}"): 204,
    ("GET", "/api/admin/events/{event_id}/questions"): 200,
    ("POST", "/api/admin/events/{event_id}/questions"): 201,
    ("PUT", "/api/admin/questions/{question_id}"): 200,
    ("DELETE", "/api/admin/questions/{question_id}"): 204,
    ("POST", "/api/admin/events/{event_id}/questions/bulk"): 200,
    ("POST", "/api/admin/events/{event_id}/questions/import-csv"): 200,
    ("GET", "/api/admin/events/{event_id}/questions/export.csv"): 200,
    ("GET", "/api/admin/events/{event_id}/results"): 200,
    ("GET", "/api/admin/results/{session_id}"): 200,
    ("DELETE", "/api/admin/results/{session_id}"): 204,
    ("PATCH", "/api/admin/results/{session_id}/score"): 200,
    ("GET", "/api/admin/events/{event_id}/results.csv"): 200,
}


def test_every_contract_route_exists_with_its_success_status():
    routes = {
        (method, route.path): route.status_code
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in route.methods - {"HEAD", "OPTIONS"}
    }
    missing = sorted(set(CONTRACT_ROUTES) - set(routes))
    assert not missing, f"routes of the contract that are not served: {missing}"
    wrong = {key: (routes[key], want) for key, want in CONTRACT_ROUTES.items() if (routes[key] or 200) != want}
    assert not wrong, f"unexpected success status (got, contract): {wrong}"


# ---------------------------------------------------------------------------------------------
# public schemas: exact field sets (privacy relevant)
# ---------------------------------------------------------------------------------------------
EVENT_SUMMARY = {
    "slug", "name", "game_title", "status", "tagline_en", "tagline_fr", "description_en", "description_fr",
    "location", "starts_on", "ends_on", "languages", "default_language", "branding",
}  # fmt: skip
PUBLIC_SETTINGS = {
    "questions_per_game", "timer_seconds", "points_correct", "points_wrong", "time_bonus_max", "collect_phone",
    "consent_text_en", "consent_text_fr", "question_order",
}  # fmt: skip
QUESTION_FOR_GAME = {
    "id", "question_format", "question_text_en", "question_text_fr", "question_type", "media_url",
    "green_label_en", "green_label_fr", "red_label_en", "red_label_fr", "difficulty", "category",
}  # fmt: skip


@pytest.mark.parametrize(
    "model,expected",
    [
        (s.EventSummary, EVENT_SUMMARY),
        (s.EventPublic, EVENT_SUMMARY | {"hero_title_en", "hero_title_fr", "settings", "categories", "stats"}),
        (s.EventSettingsPublic, PUBLIC_SETTINGS),
        (s.EventPublicStats, {"players", "games_completed"}),
        (s.CategoryPublic, {"id", "name", "name_fr", "color", "question_count"}),
        (s.QuestionForGame, QUESTION_FOR_GAME),  # NEVER the answer or the explanation
        (
            s.GameStarted,
            {"game_session_id", "timer_seconds", "points_correct", "time_bonus_max", "questions", "submit_token"},
        ),
        (s.GameComplete, {"game_session", "rank", "total_players", "review"}),
        (
            s.GameSessionResponse,
            {"id", "player_id", "status", "total_score", "correct_answers", "wrong_answers", "unanswered", "started_at", "completed_at"},
        ),
        (
            s.ReviewItem,
            {
                "question_id", "question_format", "question_text_en", "question_text_fr", "correct_answer",
                "player_answer", "is_correct", "explanation_en", "explanation_fr", "time_taken", "points_earned",
                "green_label_en", "green_label_fr", "red_label_en", "red_label_fr", "category",
            },
        ),  # fmt: skip
        (s.ScoreboardEntry, {"id", "rank", "player_name", "score", "correct_answers", "wrong_answers", "completed_at"}),
        (s.ScoreboardSnapshot, {"entries", "total_players", "total_games"}),
        (s.AnswerSubmission, {"question_id", "player_answer", "time_taken"}),
        (s.PlayerCreate, {"first_name", "last_name", "email", "phone_number", "consent"}),
    ],
)
def test_public_schema_fields_are_exactly_the_documented_ones(model, expected):
    assert fields(model) == expected, (
        f"{model.__name__}: unexpected {sorted(fields(model) - expected)}, missing {sorted(expected - fields(model))}"
    )


def test_a_public_schema_can_never_carry_the_answer_an_email_or_a_phone():
    leaky = {"correct_answer", "explanation_en", "explanation_fr", "email", "phone_number", "consent_at", "is_correct"}
    for model in (s.QuestionForGame, s.GameStarted, s.ScoreboardEntry, s.ScoreboardSnapshot, s.EventPublic, s.EventSummary):
        assert not (fields(model) & leaky), model.__name__
    # the game's own player gets his registration back, nobody else's data travels in that response
    assert fields(s.PlayerResponse) >= {"id", "event_id", "first_name", "last_name", "email"}


# ---------------------------------------------------------------------------------------------
# admin schemas: at least the documented fields
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "model,expected",
    [
        (s.EventAdmin, EVENT_SUMMARY | {"id", "hero_title_en", "hero_title_fr", "settings", "counts", "created_at", "updated_at"}),
        (s.EventCounts, {"questions", "active_questions", "categories", "players", "games_completed"}),
        (s.EventSettings, PUBLIC_SETTINGS | {"category_distribution"}),
        (s.Branding, {"primary_color", "accent_color", "background_style", "logo_url", "default_theme", "show_join_qr"}),
        (
            s.EventStats,
            {
                "players", "games_completed", "games_in_progress", "avg_score", "top_score", "avg_correct",
                "questions_active", "hardest_questions", "easiest_questions",
            },
        ),  # fmt: skip
        (s.QuestionStat, {"id", "question_text_en", "correct_rate", "answered"}),
        (
            s.CategoryAdmin,
            {"id", "event_id", "name", "name_fr", "description", "description_fr", "color", "is_active", "question_count"},
        ),
        (
            s.QuestionAdmin,
            {
                "id", "event_id", "category_id", "category", "question_format", "question_text_en", "question_text_fr",
                "question_type", "media_url", "correct_answer", "green_label_en", "green_label_fr", "red_label_en",
                "red_label_fr", "explanation_en", "explanation_fr", "is_active", "difficulty",
            },
        ),  # fmt: skip
        (s.QuestionPage, {"items", "total"}),
        (s.BulkResult, {"affected"}),
        (s.CsvImportResult, {"created", "skipped_duplicates", "categories_created", "errors"}),
        (s.ResultPage, {"items", "total"}),
        (
            s.ResultSummary,
            {"id", "player", "status", "total_score", "correct_answers", "wrong_answers", "unanswered", "started_at", "completed_at"},
        ),
        (s.ResultPlayer, {"id", "first_name", "last_name", "email", "phone_number", "consent_at"}),
        (
            s.ResultAnswerDetail,
            {
                "question_id", "question_text_en", "question_text_fr", "green_label_en", "red_label_en", "correct_answer",
                "player_answer", "is_correct", "time_taken", "points_earned", "question_order",
            },
        ),  # fmt: skip
        (s.EventDuplicate, {"slug", "name", "game_title", "copy_branding", "copy_settings", "copy_questions"}),
        (s.EventImportRequest, {"bundle", "slug", "name", "status"}),
        (s.Token, {"access_token", "token_type"}),
        (s.AdminMe, {"username"}),
    ],
)
def test_admin_schemas_contain_the_documented_fields(model, expected):
    assert fields(model) >= expected, f"{model.__name__}: missing {sorted(expected - fields(model))}"


# ---------------------------------------------------------------------------------------------
# bundle format (section 6)
# ---------------------------------------------------------------------------------------------
def test_bundle_fields_are_exactly_the_documented_ones():
    assert fields(s.BundleV1) == {"format", "version", "event", "categories", "questions"}
    assert fields(s.BundleEvent) == {
        "slug", "name", "game_title", "status", "hero_title_en", "hero_title_fr", "tagline_en", "tagline_fr",
        "description_en", "description_fr", "location", "starts_on", "ends_on", "languages", "default_language",
        "branding", "settings",
    }  # fmt: skip
    assert fields(s.BundleSettings) == PUBLIC_SETTINGS | {"category_distribution"}
    assert fields(s.BundleCategory) == {"name", "name_fr", "description", "description_fr", "color", "is_active"}
    assert fields(s.BundleQuestion) == {
        "category", "question_format", "difficulty", "question_text_en", "question_text_fr", "question_type",
        "media_url", "correct_answer", "green_label_en", "green_label_fr", "red_label_en", "red_label_fr",
        "explanation_en", "explanation_fr", "is_active",
    }  # fmt: skip


# ---------------------------------------------------------------------------------------------
# reserved slugs and slug rules (section 1)
# ---------------------------------------------------------------------------------------------
DOCUMENTED_RESERVED_SLUGS = (
    "api admin assets shared css js vendor fonts static health docs openapi favicon robots scoreboard game "
    "events new login config index manifest sw"
).split()


@pytest.mark.parametrize("slug", DOCUMENTED_RESERVED_SLUGS)
def test_reserved_slugs_are_refused(slug):
    with pytest.raises(ValueError, match="reserved"):
        s.validate_slug(slug)


@pytest.mark.parametrize("slug", ["a", "x" * 49, "Upper", "two--hyphens", "-lead", "trail-", "with space", "under_score", "é"])
def test_malformed_slugs_are_refused(slug):
    with pytest.raises(ValueError):
        s.validate_slug(slug)


@pytest.mark.parametrize("slug", ["ai", "world-ai-summit-2026", "api-days-paris-2027", "x" * 48, "a1-b2"])
def test_well_formed_slugs_are_accepted(slug):
    assert s.validate_slug(slug) == slug
