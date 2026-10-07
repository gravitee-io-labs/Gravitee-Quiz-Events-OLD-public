"""seed_if_empty: seeding an empty database from event bundles, never touching a non-empty one."""
import json
import logging
import shutil
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app import seed
from app.config import settings
from app.models import Category, Event, Question
from app.schemas import BundleV1
from app.seed import seed_event_names, seed_if_empty
from app.services.bundle import SlugConflictError, export_event, import_bundle

FIXTURES = Path(__file__).parent / "fixtures"
REPO_EVENTS = Path(__file__).resolve().parents[2] / "events"


@pytest.fixture
def seed_dir(tmp_path, monkeypatch):
    """A temp SEED_DIR holding api-masters.json (alpha bundle) and extra.json (beta bundle)."""
    shutil.copy(FIXTURES / "seed_alpha.json", tmp_path / "api-masters.json")
    shutil.copy(FIXTURES / "seed_beta.json", tmp_path / "extra.json")
    monkeypatch.setattr(settings, "SEED_DIR", str(tmp_path))
    monkeypatch.delenv("SEED_EVENTS", raising=False)
    return tmp_path


def slugs(db):
    return sorted(db.scalars(select(Event.slug)))


def count(db, model):
    return db.scalar(select(func.count()).select_from(model))


# ---------------------------------------------------------------------------------------------
# SEED_EVENTS parsing
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "value,expected",
    [
        (None, ["api-masters"]),
        ("", []),
        ("   ", []),
        ("api-masters", ["api-masters"]),
        ("api-masters,world-ai-summit-2026", ["api-masters", "world-ai-summit-2026"]),
        (" api-masters , world-ai-summit-2026 ,, ", ["api-masters", "world-ai-summit-2026"]),
        ("a.json,b", ["a", "b"]),
        ("a,a,b,a", ["a", "b"]),
        ("A.JSON", ["A"]),
    ],
)
def test_seed_event_names(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("SEED_EVENTS", raising=False)
    else:
        monkeypatch.setenv("SEED_EVENTS", value)
    assert seed_event_names() == expected


# ---------------------------------------------------------------------------------------------
# seeding
# ---------------------------------------------------------------------------------------------
def test_seeds_the_default_bundle_into_an_empty_database(db, seed_dir):
    created = seed_if_empty(db)
    assert created == ["alpha-event"]  # api-masters.json holds the alpha bundle
    assert slugs(db) == ["alpha-event"]
    event = db.scalars(select(Event)).one()
    assert event.game_title == "Alpha Masters" and event.status == "live"
    assert count(db, Category) == 2 and count(db, Question) == 4
    assert all(q.event_id == event.id for q in db.scalars(select(Question)))


def test_seeds_every_listed_bundle_in_order(db, seed_dir, monkeypatch):
    monkeypatch.setenv("SEED_EVENTS", "extra, api-masters")
    assert seed_if_empty(db) == ["beta-event", "alpha-event"]
    assert slugs(db) == ["alpha-event", "beta-event"]
    assert db.scalars(select(Event).where(Event.slug == "beta-event")).one().status == "draft"  # the bundle's own status
    assert count(db, Category) == 4 and count(db, Question) == 8
    # each event got ITS OWN categories and questions
    for event in db.scalars(select(Event)):
        assert count_for(db, Category, event) == 2 and count_for(db, Question, event) == 4


def count_for(db, model, event):
    return db.scalar(select(func.count()).select_from(model).where(model.event_id == event.id))


def test_unlisted_bundles_are_not_imported(db, seed_dir):
    seed_if_empty(db)
    assert "beta-event" not in slugs(db)  # extra.json is in the directory but not in SEED_EVENTS


def test_json_suffix_in_the_name_is_accepted(db, seed_dir, monkeypatch):
    monkeypatch.setenv("SEED_EVENTS", "extra.json")
    assert seed_if_empty(db) == ["beta-event"]


def test_empty_seed_events_means_no_seeding(db, seed_dir, monkeypatch):
    monkeypatch.setenv("SEED_EVENTS", "")
    assert seed_if_empty(db) == [] and slugs(db) == []


def test_non_empty_database_is_never_touched(db, seed_dir, make_event, caplog):
    make_event(slug="existing-event")
    with caplog.at_level(logging.INFO, logger="app.seed"):
        assert seed_if_empty(db) == []
    assert slugs(db) == ["existing-event"]
    assert count(db, Category) == 0 and count(db, Question) == 0
    assert "skipped" in caplog.text


def test_non_empty_database_with_any_status_counts_as_non_empty(db, seed_dir, make_event):
    make_event(slug="just-a-draft", status="draft")
    assert seed_if_empty(db) == []
    assert slugs(db) == ["just-a-draft"]


def test_seeding_is_idempotent(db, seed_dir):
    assert seed_if_empty(db) == ["alpha-event"]
    snapshot = (count(db, Event), count(db, Category), count(db, Question))
    assert seed_if_empty(db) == []
    assert seed_if_empty(db) == []
    assert (count(db, Event), count(db, Category), count(db, Question)) == snapshot


def test_deleting_every_event_makes_the_database_seedable_again(db, seed_dir):
    seed_if_empty(db)
    db.execute(Event.__table__.delete())
    db.commit()
    assert seed_if_empty(db) == ["alpha-event"]


def test_a_missing_bundle_warns_and_does_not_crash(db, seed_dir, monkeypatch, caplog):
    monkeypatch.setenv("SEED_EVENTS", "does-not-exist, api-masters")
    with caplog.at_level(logging.WARNING, logger="app.seed"):
        assert seed_if_empty(db) == ["alpha-event"]  # the other bundle is still imported
    assert any(r.levelno == logging.WARNING and "does-not-exist.json" in r.getMessage() for r in caplog.records)


def test_only_missing_bundles_leave_an_empty_database_and_a_warning(db, seed_dir, monkeypatch, caplog):
    monkeypatch.setenv("SEED_EVENTS", "nope-1,nope-2")
    with caplog.at_level(logging.WARNING, logger="app.seed"):
        assert seed_if_empty(db) == []
    assert slugs(db) == []
    assert "no event could be seeded" in caplog.text


def test_an_invalid_bundle_is_logged_and_leaves_no_partial_data(db, seed_dir, monkeypatch, caplog):
    shutil.copy(FIXTURES / "seed_invalid_version.json", seed_dir / "broken.json")
    monkeypatch.setenv("SEED_EVENTS", "broken,api-masters")
    with caplog.at_level(logging.ERROR, logger="app.seed"):
        assert seed_if_empty(db) == ["alpha-event"]
    assert "broken" in caplog.text and "invalid" in caplog.text
    assert slugs(db) == ["alpha-event"] and count(db, Category) == 2 and count(db, Question) == 4


def test_unreadable_json_is_logged_and_skipped(db, seed_dir, monkeypatch, caplog):
    shutil.copy(FIXTURES / "seed_not_json.json", seed_dir / "garbage.json")
    (seed_dir / "list.json").write_text("[1, 2, 3]", encoding="utf-8")
    monkeypatch.setenv("SEED_EVENTS", "garbage,list,api-masters")
    with caplog.at_level(logging.ERROR, logger="app.seed"):
        assert seed_if_empty(db) == ["alpha-event"]
    assert "garbage.json" in caplog.text and "list.json" in caplog.text


def test_bundle_with_a_utf8_bom_is_accepted(db, seed_dir, monkeypatch):
    (seed_dir / "bom.json").write_bytes(b"\xef\xbb\xbf" + (FIXTURES / "seed_beta.json").read_bytes())
    monkeypatch.setenv("SEED_EVENTS", "bom")
    assert seed_if_empty(db) == ["beta-event"]


@pytest.mark.parametrize("name", ["../secret", "..", "a/b", "/etc/passwd", ".hidden", "-x", "a b", "a\\b"])
def test_names_that_could_escape_the_seed_directory_are_ignored(db, seed_dir, monkeypatch, tmp_path, name):
    (tmp_path.parent / "secret.json").write_text((FIXTURES / "seed_beta.json").read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setenv("SEED_EVENTS", name)
    assert seed_if_empty(db) == [] and slugs(db) == []


def test_a_lost_race_between_replicas_is_not_an_error(db, seed_dir, monkeypatch, caplog):
    """Another replica inserted the slug first: the unique violation is handled, nothing crashes."""

    def lost(*_args, **_kwargs):
        raise SlugConflictError("alpha-event")

    monkeypatch.setattr(seed, "import_bundle", lost)
    with caplog.at_level(logging.INFO, logger="app.seed"):
        assert seed_if_empty(db) == []


def test_an_unexpected_failure_is_contained(db, seed_dir, monkeypatch, caplog):
    def boom(*_args, **_kwargs):
        raise RuntimeError("database exploded")

    monkeypatch.setattr(seed, "import_bundle", boom)
    with caplog.at_level(logging.ERROR, logger="app.seed"):
        assert seed_if_empty(db) == []
    assert "failed" in caplog.text


def test_seed_without_a_session_opens_its_own(seed_dir, db):
    assert seed_if_empty() == ["alpha-event"]
    db.expire_all()
    assert slugs(db) == ["alpha-event"]
    assert seed_if_empty() == []


def test_seed_dir_falls_back_to_the_repository_events_folder(monkeypatch):
    monkeypatch.setattr(settings, "SEED_DIR", "/definitely/not/a/directory")
    assert settings.resolve_seed_dir() == REPO_EVENTS


def test_missing_seed_dir_is_not_fatal(db, monkeypatch, caplog):
    monkeypatch.setattr(settings, "SEED_DIR", "/definitely/not/a/directory")
    monkeypatch.setenv("SEED_EVENTS", "bundle-that-does-not-exist")
    with caplog.at_level(logging.WARNING, logger="app.seed"):
        assert seed_if_empty(db) == []


def test_init_db_seeds_when_enabled(db, seed_dir, monkeypatch):
    """The startup hook (app.database.init_db) goes through seed_if_empty."""
    from app.database import init_db

    monkeypatch.setattr(settings, "SEED_ON_STARTUP", True)
    monkeypatch.setattr(settings, "USE_ALEMBIC", False)
    init_db()
    db.expire_all()
    assert slugs(db) == ["alpha-event"]
    init_db()  # a second start changes nothing
    db.expire_all()
    assert slugs(db) == ["alpha-event"] and count(db, Question) == 4


def test_init_db_does_not_seed_when_disabled(db, seed_dir, monkeypatch):
    from app.database import init_db

    monkeypatch.setattr(settings, "SEED_ON_STARTUP", False)
    monkeypatch.setattr(settings, "USE_ALEMBIC", False)
    init_db()
    assert slugs(db) == []


def test_seeded_event_is_served_by_the_admin_api(client, admin_headers, db, seed_dir):
    seed_if_empty(db)
    events = client.get("/api/admin/events", headers=admin_headers).json()
    assert [e["slug"] for e in events] == ["alpha-event"]
    assert events[0]["counts"]["questions"] == 4 and events[0]["counts"]["categories"] == 2


def test_seed_then_export_gives_the_bundle_back(db, seed_dir):
    seed_if_empty(db)
    exported = export_event(db, db.scalars(select(Event)).one())
    original = json.loads((FIXTURES / "seed_alpha.json").read_text(encoding="utf-8"))
    assert exported["questions"] == original["questions"]
    assert exported["categories"] == original["categories"]
    assert exported["event"] == original["event"]


# ---------------------------------------------------------------------------------------------
# the real bundles of the repository (events/*.json), whatever they currently are
# ---------------------------------------------------------------------------------------------
REPO_BUNDLES = sorted(REPO_EVENTS.glob("*.json")) if REPO_EVENTS.is_dir() else []


@pytest.mark.skipif(not REPO_BUNDLES, reason="no events/*.json bundle in the repository")
@pytest.mark.parametrize("path", REPO_BUNDLES, ids=[p.name for p in REPO_BUNDLES])
def test_repository_bundles_are_valid_and_seedable(db, path):
    bundle = BundleV1.model_validate_json(path.read_bytes())
    assert bundle.event.slug == path.stem, "the file name must be the event slug (SEED_EVENTS uses it)"
    assert bundle.questions, "a bundle without questions cannot host a game"
    event = import_bundle(db, bundle)
    export = export_event(db, event)
    assert BundleV1.model_validate(export)
    assert len(export["questions"]) == len(bundle.questions)
    # every active category has enough questions for the rules, and the rules are playable
    active = sum(1 for q in bundle.questions if q.is_active)
    assert active >= bundle.event.settings.questions_per_game, "fewer active questions than questions_per_game"
