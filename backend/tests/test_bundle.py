"""Unit tests for app.services.bundle: export / import / duplicate."""
import copy
import json
from datetime import date

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from app.models import Category, Event, GameAnswer, GameSession, Player, Question
from app.schemas import BundleV1, EventDuplicate
from app.services import bundle as bundle_service
from app.services.bundle import (
    SlugConflictError,
    duplicate_event,
    ensure_slug_available,
    export_event,
    import_bundle,
    slug_taken,
)


def count(db, model, **filters):
    stmt = select(func.count()).select_from(model)
    for key, value in filters.items():
        stmt = stmt.where(getattr(model, key) == value)
    return db.scalar(stmt)


def totals(db):
    return {m.__name__: count(db, m) for m in (Event, Category, Question, Player, GameSession, GameAnswer)}


def with_slug(bundle: dict, slug: str) -> dict:
    out = copy.deepcopy(bundle)
    out["event"]["slug"] = slug
    return out


# ---------------------------------------------------------------------------------------------
# import
# ---------------------------------------------------------------------------------------------
def test_import_creates_event_categories_and_questions(db, sample_bundle):
    event = import_bundle(db, sample_bundle())
    assert event.id and event.slug == "sample-event" and event.status == "live"
    assert (event.name, event.game_title) == ("Sample Event", "Sample Masters")
    assert event.starts_on == date(2026, 10, 7) and event.ends_on == date(2026, 10, 8)
    assert event.languages == ["en", "fr"] and event.default_language == "en"
    assert event.branding == {
        "primary_color": "#7C5CFF", "accent_color": "#22D3EE", "background_style": "aurora",
        "logo_url": None, "default_theme": "dark", "show_join_qr": True,
    }
    assert (event.questions_per_game, event.timer_seconds, event.points_correct, event.time_bonus_max) == (2, 20, 100, 50)
    categories = db.scalars(select(Category).where(Category.event_id == event.id).order_by(Category.id)).all()
    assert [(c.name, c.name_fr, c.color) for c in categories] == [("Alpha", "Alpha FR", "#7C5CFF"), ("Beta", None, "#FC5607")]
    # weights keyed by NAME in the bundle become weights keyed by the new category ids
    assert event.category_distribution == {str(categories[0].id): 50, str(categories[1].id): 50}
    questions = db.scalars(select(Question).where(Question.event_id == event.id).order_by(Question.id)).all()
    assert [q.question_text_en for q in questions] == ["Alpha is first?", "Alpha is last?", "Pick the proxy", "Pick the verb"]
    assert [q.category.name for q in questions] == ["Alpha", "Alpha", "Beta", "Beta"]
    assert questions[2].question_format == "two_choices" and questions[2].green_label_fr == "Proxy LLM"
    assert questions[1].correct_answer == "red" and questions[1].difficulty == 2
    assert all(q.event_id == event.id for q in questions)


def test_import_accepts_a_validated_bundle_model(db, sample_bundle):
    event = import_bundle(db, BundleV1.model_validate(sample_bundle()))
    assert count(db, Question, event_id=event.id) == 4


def test_import_overrides_slug_name_status(db, sample_bundle):
    event = import_bundle(db, sample_bundle(), {"slug": "my-copy", "name": "  My copy ", "status": "draft"})
    assert (event.slug, event.name, event.status) == ("my-copy", "My copy", "draft")
    assert event.game_title == "Sample Masters"  # untouched


def test_import_ignores_none_overrides(db, sample_bundle):
    event = import_bundle(db, sample_bundle(), {"slug": None, "name": None, "status": None})
    assert (event.slug, event.status) == ("sample-event", "live")


@pytest.mark.parametrize(
    "overrides",
    [
        {"slug": "api"},  # reserved
        {"slug": "Not Valid"},
        {"slug": "x"},  # too short
        {"status": "archived"},
        {"name": "   "},
        {"owner": "me"},  # unknown key
    ],
)
def test_import_rejects_bad_overrides_without_writing(db, sample_bundle, overrides):
    with pytest.raises((ValueError, ValidationError)):
        import_bundle(db, sample_bundle(), overrides)
    assert totals(db)["Event"] == 0 and totals(db)["Question"] == 0


def test_import_slug_conflict_creates_nothing(db, sample_bundle):
    import_bundle(db, sample_bundle())
    before = totals(db)
    with pytest.raises(SlugConflictError) as exc:
        import_bundle(db, sample_bundle())
    assert exc.value.slug == "sample-event"
    assert totals(db) == before
    # the override can resolve the conflict
    import_bundle(db, sample_bundle(), {"slug": "sample-event-2"})
    assert totals(db)["Event"] == 2


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b.update(version=2),
        lambda b: b.update(format="something-else"),
        lambda b: b["event"].update(slug="Bad Slug"),
        lambda b: b["event"].update(slug="admin"),
        lambda b: b["event"].update(default_language="de"),
        lambda b: b["event"].update(languages=["fr"]),  # default_language en not in languages
        lambda b: b["event"]["branding"].update(primary_color="red"),
        lambda b: b["event"]["settings"].update(timer_seconds=1),
        lambda b: b["event"].update(unexpected="field"),
        lambda b: b["questions"][0].update(category="Nope"),
        lambda b: b["questions"][0].update(correct_answer="blue"),
        lambda b: b["questions"][0].update(extra=1),
        lambda b: b["event"]["settings"].update(category_distribution={"Nope": 10}),
        lambda b: b["categories"].append(dict(b["categories"][0])),  # duplicate name
    ],
)
def test_invalid_bundles_are_rejected_and_nothing_is_written(db, sample_bundle, mutate):
    bundle = sample_bundle()
    mutate(bundle)
    with pytest.raises(ValidationError):
        import_bundle(db, bundle)
    assert sum(totals(db).values()) == 0


def test_import_is_atomic(db, sample_bundle, monkeypatch):
    """A failure while creating questions rolls back the event and the categories too."""
    real = bundle_service.Question
    calls = {"n": 0}

    def exploding(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("boom")
        return real(*args, **kwargs)

    monkeypatch.setattr(bundle_service, "Question", exploding)
    with pytest.raises(RuntimeError):
        import_bundle(db, sample_bundle())
    monkeypatch.undo()
    assert sum(totals(db).values()) == 0
    import_bundle(db, sample_bundle())  # the session is still usable
    assert totals(db)["Question"] == 4


def test_import_without_commit_only_flushes(db, sample_bundle):
    event = import_bundle(db, sample_bundle(), commit=False)
    assert event.id is not None and count(db, Question) == 4  # visible in this transaction
    db.rollback()
    assert sum(totals(db).values()) == 0


def test_import_bundle_with_no_categories_no_questions_and_no_distribution(db, sample_bundle):
    bundle = sample_bundle()
    bundle["categories"], bundle["questions"] = [], []
    bundle["event"]["settings"]["category_distribution"] = None
    event = import_bundle(db, bundle)
    assert event.category_distribution is None
    assert (count(db, Category), count(db, Question)) == (0, 0)


def test_import_uncategorised_questions(db, sample_bundle):
    bundle = sample_bundle()
    bundle["questions"][0]["category"] = None
    import_bundle(db, bundle)
    first = db.scalars(select(Question).order_by(Question.id)).first()
    assert first.category_id is None


def test_import_normalises_input_like_the_api_does(db, sample_bundle):
    bundle = sample_bundle()
    bundle["event"]["branding"]["primary_color"] = "#7c5cff"
    bundle["event"]["tagline_en"] = "   "
    bundle["questions"][0]["question_text_en"] = "  padded?  "
    bundle["questions"][0]["question_format"] = "true_false"
    bundle["questions"][0]["green_label_en"] = "whatever"  # forced to TRUE for true_false
    event = import_bundle(db, bundle)
    assert event.branding["primary_color"] == "#7C5CFF" and event.tagline_en is None
    first = db.scalars(select(Question).order_by(Question.id)).first()
    assert first.question_text_en == "padded?" and first.green_label_en == "TRUE"


def test_import_many_questions(db, sample_bundle):
    bundle = sample_bundle()
    template = bundle["questions"][0]
    bundle["questions"] = [dict(template, question_text_en=f"Question number {i}?") for i in range(600)]
    event = import_bundle(db, bundle)
    assert count(db, Question, event_id=event.id) == 600
    ids = [q.id for q in db.scalars(select(Question).order_by(Question.id))]
    assert [q.question_text_en for q in db.scalars(select(Question).order_by(Question.id)).all()][:3] == [
        "Question number 0?", "Question number 1?", "Question number 2?",
    ]
    assert ids == sorted(ids)


# ---------------------------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------------------------
def test_export_is_a_valid_bundle_with_names_instead_of_ids(db, sample_bundle):
    event = import_bundle(db, sample_bundle())
    exported = export_event(db, event)
    BundleV1.model_validate(exported)  # the export is a valid v1 bundle
    json.dumps(exported)  # and plain JSON
    assert exported["format"] == "gravitee-quiz-event" and exported["version"] == 1
    assert exported["event"]["slug"] == "sample-event"
    assert exported["event"]["starts_on"] == "2026-10-07"
    assert exported["event"]["settings"]["category_distribution"] == {"Alpha": 50, "Beta": 50}
    assert [c["name"] for c in exported["categories"]] == ["Alpha", "Beta"]
    assert [q["category"] for q in exported["questions"]] == ["Alpha", "Alpha", "Beta", "Beta"]
    assert list(exported["event"]["branding"]) == ["primary_color", "accent_color", "background_style", "logo_url", "default_theme", "show_join_qr"]
    # the contract's key order is kept (readable diffs)
    assert list(exported["event"]["settings"])[:6] == [
        "questions_per_game", "timer_seconds", "points_correct", "points_wrong", "time_bonus_max", "category_distribution",
    ]


def test_export_round_trip_equals_the_original(db, sample_bundle):
    original = import_bundle(db, sample_bundle())
    first = export_event(db, original)
    second_event = import_bundle(db, first, {"slug": "second-copy"})
    second = export_event(db, second_event)
    assert second["event"]["slug"] == "second-copy" and first["event"]["slug"] == "sample-event"
    assert {**second, "event": {**second["event"], "slug": "x"}} == {**first, "event": {**first["event"], "slug": "x"}}
    # and a third generation through real JSON text, to be sure nothing relies on Python objects
    third_event = import_bundle(db, json.loads(json.dumps(second, ensure_ascii=False)), {"slug": "third-copy"})
    third = export_event(db, third_event)
    assert third["event"]["slug"] == "third-copy"
    assert {**third, "event": {**third["event"], "slug": "x"}} == {**second, "event": {**second["event"], "slug": "x"}}


def test_export_matches_the_input_bundle(db, sample_bundle):
    bundle = sample_bundle()
    event = import_bundle(db, bundle)
    exported = export_event(db, event)
    assert exported["event"] == bundle["event"]
    assert exported["categories"] == bundle["categories"]
    assert exported["questions"] == bundle["questions"]


def test_export_omits_default_question_type_and_empty_media_but_keeps_real_ones(db, make_event, make_question):
    event = make_event()
    make_question(event, question_text_en="Plain?")
    make_question(event, question_text_en="With media?", question_type="image", media_url="https://example.com/a.png")
    exported = export_event(db, event)
    plain, media = exported["questions"]
    assert "question_type" not in plain and "media_url" not in plain
    assert (media["question_type"], media["media_url"]) == ("image", "https://example.com/a.png")
    again = import_bundle(db, exported, {"slug": "with-media"})
    stored = db.scalars(select(Question).where(Question.event_id == again.id).order_by(Question.id)).all()
    assert (stored[1].question_type, stored[1].media_url) == ("image", "https://example.com/a.png")


def test_export_of_an_empty_event_and_of_event_defaults(db, make_event):
    event = make_event(slug="bare", name="Bare", game_title="Bare Masters")
    exported = export_event(db, event)
    assert exported["categories"] == [] and exported["questions"] == []
    assert exported["event"]["settings"]["category_distribution"] is None
    assert exported["event"]["settings"]["questions_per_game"] == 15
    assert exported["event"]["branding"]["primary_color"] == "#FC5607"
    BundleV1.model_validate(exported)


def test_export_drops_weights_of_categories_that_no_longer_exist(db, make_event, make_category):
    event = make_event()
    kept = make_category(event, name="Kept")
    event.category_distribution = {str(kept.id): 3, "99999": 7, "oops": 1}
    db.commit()
    assert export_event(db, event)["event"]["settings"]["category_distribution"] == {"Kept": 3}
    event.category_distribution = {"99999": 7}
    db.commit()
    assert export_event(db, event)["event"]["settings"]["category_distribution"] is None


def test_export_never_includes_players_or_results(db, make_event, make_category, make_question, make_game_session):
    event = make_event()
    q = make_question(event, make_category(event))
    make_game_session(event, answers=[{"question": q, "player_answer": "green"}])
    text = json.dumps(export_event(db, event))
    assert "email" not in text and "player" not in text and "total_score" not in text


def test_export_survives_legacy_oddities(db, make_event, make_question):
    """Exporting must not fail on data the strict import schema would refuse (e.g. an http:// media url)."""
    event = make_event()
    make_question(event, media_url="http://legacy.example.com/x.png", question_text_fr=None)
    exported = export_event(db, event)
    assert exported["questions"][0]["media_url"] == "http://legacy.example.com/x.png"
    with pytest.raises(ValidationError):  # ...it is the import that tells you
        import_bundle(db, exported, {"slug": "legacy-copy"})


# ---------------------------------------------------------------------------------------------
# duplicate
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def source(db, sample_bundle, make_player, make_game_session):
    event = import_bundle(db, sample_bundle())
    questions = db.scalars(select(Question).where(Question.event_id == event.id).order_by(Question.id)).all()
    make_game_session(event, answers=[{"question": questions[0], "player_answer": "green"}])
    event.consent_text_en = "I agree"
    event.hero_title_en = "Hero"
    event.location = "Paris"
    db.commit()
    return event


def test_duplicate_copies_everything_but_players_and_results(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Sample copy"})
    assert copy_.id != source.id and copy_.slug == "sample-copy" and copy_.name == "Sample copy"
    assert copy_.status == "draft"
    assert copy_.game_title == source.game_title
    assert copy_.branding == source.branding and copy_.branding is not source.branding
    assert copy_.languages == source.languages and copy_.hero_title_en == "Hero" and copy_.tagline_fr == source.tagline_fr
    assert copy_.consent_text_en == "I agree"
    assert (copy_.questions_per_game, copy_.timer_seconds, copy_.question_order) == (2, 20, "random")
    assert count(db, Category, event_id=copy_.id) == 2 and count(db, Question, event_id=copy_.id) == 4
    assert (count(db, Player, event_id=copy_.id), count(db, GameSession, event_id=copy_.id)) == (0, 0)
    # the source is untouched
    assert (count(db, Player, event_id=source.id), count(db, GameSession, event_id=source.id)) == (1, 1)
    assert count(db, Question, event_id=source.id) == 4


def test_duplicate_does_not_copy_dates_or_location(db, source):
    copy_ = duplicate_event(db, source, EventDuplicate(slug="sample-copy", name="Copy"))
    assert (copy_.starts_on, copy_.ends_on, copy_.location) == (None, None, None)


def test_duplicate_remaps_category_distribution_to_the_new_category_ids(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy"})
    new_categories = {c.name: c.id for c in db.scalars(select(Category).where(Category.event_id == copy_.id))}
    old_categories = {c.name: c.id for c in db.scalars(select(Category).where(Category.event_id == source.id))}
    assert set(new_categories.values()).isdisjoint(old_categories.values())
    assert copy_.category_distribution == {str(new_categories["Alpha"]): 50, str(new_categories["Beta"]): 50}
    assert source.category_distribution == {str(old_categories["Alpha"]): 50, str(old_categories["Beta"]): 50}


def test_duplicate_questions_point_to_the_copied_categories(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy"})
    for q in db.scalars(select(Question).where(Question.event_id == copy_.id)):
        assert q.category.event_id == copy_.id
    originals = {q.id for q in db.scalars(select(Question).where(Question.event_id == source.id))}
    copies = {q.id for q in db.scalars(select(Question).where(Question.event_id == copy_.id))}
    assert originals.isdisjoint(copies)
    # content identical
    assert export_event(db, copy_)["questions"] == export_event(db, source)["questions"]


def test_duplicate_is_independent_from_the_original(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy"})
    # change the copy ...
    copy_.branding = {**copy_.branding, "primary_color": "#000000"}
    copy_.timer_seconds = 99
    for category in db.scalars(select(Category).where(Category.event_id == copy_.id)):
        category.name = category.name + " (copy)"
    db.execute(Question.__table__.update().where(Question.event_id == copy_.id).values(is_active=False))
    db.commit()
    db.expire_all()
    # ... the original is intact
    assert source.branding["primary_color"] == "#7C5CFF" and source.timer_seconds == 20
    assert {c.name for c in db.scalars(select(Category).where(Category.event_id == source.id))} == {"Alpha", "Beta"}
    assert count(db, Question, event_id=source.id, is_active=True) == 4
    # and deleting the copy leaves the original complete (cascade stays inside the event)
    db.execute(Event.__table__.delete().where(Event.id == copy_.id))
    db.commit()
    assert (count(db, Category, event_id=source.id), count(db, Question, event_id=source.id)) == (2, 4)
    assert count(db, GameSession, event_id=source.id) == 1


def test_duplicate_game_title_override(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy", "game_title": "AI Masters"})
    assert copy_.game_title == "AI Masters"


def test_duplicate_without_branding_uses_defaults(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy", "copy_branding": False})
    assert copy_.branding["primary_color"] == "#FC5607"
    assert copy_.hero_title_en is None and copy_.tagline_en is None and copy_.description_fr is None
    assert copy_.languages == ["en", "fr"] and copy_.default_language == "en"
    assert copy_.timer_seconds == 20 and copy_.consent_text_en == "I agree"  # settings still copied


def test_duplicate_without_settings_uses_default_rules(db, source):
    source.timer_seconds, source.points_correct, source.question_order = 33, 7, "easy_to_hard"
    db.commit()
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy", "copy_settings": False})
    assert (copy_.questions_per_game, copy_.timer_seconds, copy_.points_correct, copy_.question_order) == (15, 20, 100, "random")
    assert copy_.category_distribution is None and copy_.consent_text_en is None
    assert copy_.branding == source.branding  # branding still copied
    assert count(db, Question, event_id=copy_.id) == 4


def test_duplicate_without_questions_starts_with_an_empty_pool(db, source):
    copy_ = duplicate_event(db, source, {"slug": "sample-copy", "name": "Copy", "copy_questions": False})
    assert (count(db, Category, event_id=copy_.id), count(db, Question, event_id=copy_.id)) == (0, 0)
    assert copy_.category_distribution is None  # no categories => no weights
    assert copy_.timer_seconds == 20  # the other rules are still copied


def test_duplicate_without_everything_is_a_blank_draft(db, source):
    copy_ = duplicate_event(
        db, source,
        {"slug": "blank", "name": "Blank", "copy_branding": False, "copy_settings": False, "copy_questions": False},
    )
    assert copy_.status == "draft" and totals_for(db, copy_) == (0, 0, 0, 0)


def totals_for(db, event):
    return (
        count(db, Category, event_id=event.id), count(db, Question, event_id=event.id),
        count(db, Player, event_id=event.id), count(db, GameSession, event_id=event.id),
    )


def test_duplicate_keeps_inactive_questions_and_categories(db, make_event, make_category, make_question):
    event = make_event()
    inactive_category = make_category(event, name="Hidden", is_active=False)
    make_question(event, inactive_category, is_active=False)
    copy_ = duplicate_event(db, event, {"slug": "inactive-copy", "name": "Copy"})
    assert db.scalars(select(Category).where(Category.event_id == copy_.id)).one().is_active is False
    assert db.scalars(select(Question).where(Question.event_id == copy_.id)).one().is_active is False


def test_duplicate_drops_stale_distribution_ids_and_keeps_uncategorised_questions(db, make_event, make_category, make_question):
    event = make_event()
    category = make_category(event, name="Real")
    make_question(event, category)
    make_question(event, None)
    event.category_distribution = {str(category.id): 2, "424242": 5}
    db.commit()
    copy_ = duplicate_event(db, event, {"slug": "stale-copy", "name": "Copy"})
    new_category = db.scalars(select(Category).where(Category.event_id == copy_.id)).one()
    assert copy_.category_distribution == {str(new_category.id): 2}
    assert sorted(q.category_id is None for q in db.scalars(select(Question).where(Question.event_id == copy_.id))) == [False, True]


def test_duplicate_slug_conflict_and_validation(db, source):
    with pytest.raises(SlugConflictError):
        duplicate_event(db, source, {"slug": source.slug, "name": "Copy"})
    assert count(db, Event) == 1
    with pytest.raises(ValidationError):
        duplicate_event(db, source, {"slug": "admin", "name": "Copy"})  # reserved
    with pytest.raises(ValidationError):
        duplicate_event(db, source, {"slug": "ok-slug", "name": ""})
    assert count(db, Event) == 1


def test_duplicate_twice_gives_two_independent_events(db, source):
    first = duplicate_event(db, source, {"slug": "copy-one", "name": "One"})
    second = duplicate_event(db, first, {"slug": "copy-two", "name": "Two"})  # copy of a copy
    assert count(db, Event) == 3
    assert count(db, Question, event_id=second.id) == 4 and count(db, Category, event_id=second.id) == 2


# ---------------------------------------------------------------------------------------------
# slug helpers
# ---------------------------------------------------------------------------------------------
def test_slug_helpers(db, make_event):
    event = make_event(slug="taken-slug")
    assert slug_taken(db, "taken-slug") is True
    assert slug_taken(db, "free-slug") is False
    assert slug_taken(db, "taken-slug", exclude_id=event.id) is False  # renaming an event to its own slug
    with pytest.raises(SlugConflictError):
        ensure_slug_available(db, "taken-slug")
    ensure_slug_available(db, "free-slug")
    ensure_slug_available(db, "taken-slug", exclude_id=event.id)
