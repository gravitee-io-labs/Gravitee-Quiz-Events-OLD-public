"""
Builds a realistic LEGACY database (the schema + data production had before the multi-event rework).

Recipe
------
1. ``init_legacy_schema``: run the OLD application's own ``init_db()`` (``Base.metadata.create_all`` +
   default game_settings row + its 20 default questions) in a subprocess against the target database.
   The old code comes from ``tests/legacy/legacy_app`` (a verbatim copy of ``backend/app/{models,database,config}.py``
   at git commit ``LEGACY_GIT_REF``) or, with ``source="git"``, is extracted with ``git archive`` from that commit.
   The result is the exact production schema (``categories_name_key``, ``questions_category_id_fkey``, ...).
2. ``populate_dataset`` adds deterministic (seeded) realistic data with plain SQL:
   * 3 categories with colours (one without description, one with accents)
   * 100 more questions on top of the 20 defaults = 120: 60 TRUE/FALSE (labels TRUE/FALSE in both languages,
     like the production CSV import), 35 named two-choice, 5 "inverted" (green=FALSE/red=TRUE),
     difficulties 1-5, 10 inactive, 80 categorised / 40 uncategorised (the 20 defaults + 20 more), unicode text,
     3 media questions
   * 200 players (accents, repeated e-mails, ~60 % with a phone number)
   * 200 completed sessions (one per player; the first 100 played with 15 questions / 20 s, the rest with the
     customised rules) + 5 in_progress sessions + 1 abandoned one, with all their answers
   * a customised ``game_settings`` row: 12 questions, 15 s, 120/5 points, 40 bonus,
     ``category_distribution`` = ``{"1": 50, "2": 30, "3": 20}``
3. ``snapshot`` computes row counts + md5 checksums over the LEGACY columns of every legacy table, to prove a
   migration preserved everything.

CLI:  ``python -m tests.legacy.builder postgresql://user:pass@host:55432/db [--source git] [--no-data]``
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import random
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values
from sqlalchemy.engine import make_url

HERE = Path(__file__).resolve().parent
LEGACY_APP_DIR = HERE / "legacy_app"  # contains app/{models,database,config}.py
LEGACY_GIT_REF = "63d4171955b2c6b2a0e5349f7da9e656334cf874"  # last commit of `main` before the rework

LEGACY_TABLES = ("users", "categories", "questions", "players", "game_sessions", "game_answers", "game_settings")

# Legacy columns of every legacy table (what must survive a migration untouched).
LEGACY_COLUMNS: dict[str, tuple[str, ...]] = {
    "users": ("id", "username", "hashed_password", "is_active", "created_at"),
    "categories": ("id", "name", "description", "color", "is_active", "created_at", "updated_at"),
    "questions": (
        "id", "category_id", "question_text_en", "question_text_fr", "question_type", "media_url",
        "correct_answer", "green_label_en", "red_label_en", "explanation_en", "explanation_fr",
        "is_active", "difficulty", "created_at", "updated_at",
    ),  # + green_label_fr / red_label_fr checked separately (the migration may set Vrai/Faux on true/false rows)
    "players": ("id", "first_name", "last_name", "email", "phone_number", "created_at"),
    "game_sessions": (
        "id", "player_id", "status", "total_score", "correct_answers", "wrong_answers", "unanswered",
        "started_at", "completed_at", "game_config",
    ),
    "game_answers": (
        "id", "game_session_id", "question_id", "player_answer", "is_correct", "time_taken",
        "points_earned", "question_order", "answered_at",
    ),
    "game_settings": (
        "id", "questions_per_game", "timer_seconds", "points_correct", "points_wrong", "time_bonus_max",
        "category_distribution", "updated_at",
    ),
}

CUSTOM_SETTINGS = {
    "questions_per_game": 12,
    "timer_seconds": 15,
    "points_correct": 120,
    "points_wrong": 5,
    "time_bonus_max": 40,
    "category_distribution": {"1": 50, "2": 30, "3": 20},
}


def psycopg_dsn(url: str) -> str:
    """SQLAlchemy URL (any ``postgresql+driver``) -> libpq URI."""
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


@contextlib.contextmanager
def _connect(url: str):
    """psycopg2 connection that commits on success, rolls back on error and is ALWAYS closed
    (a lingering session would block ``CREATE DATABASE ... TEMPLATE``)."""
    conn = psycopg2.connect(psycopg_dsn(url))
    try:
        with conn:
            yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------------------------
# 1. legacy schema through the OLD application's init_db()
# ---------------------------------------------------------------------------------------------
def extract_legacy_from_git(dest: Path, ref: str = LEGACY_GIT_REF) -> Path:
    """``git archive <ref> backend/app | tar -x -C dest``; returns the directory to put on PYTHONPATH."""
    repo_root = HERE.parents[2]
    archive = subprocess.run(
        ["git", "-C", str(repo_root), "archive", ref, "backend/app"], check=True, capture_output=True
    ).stdout
    subprocess.run(["tar", "-x", "-C", str(dest)], input=archive, check=True)
    return dest / "backend"


def init_legacy_schema(url: str, *, source: str = "vendored") -> None:
    """Run the legacy ``init_db()`` against ``url`` (``source``: ``vendored`` copy or ``git`` extraction)."""
    with tempfile.TemporaryDirectory(prefix="legacy-app-") as tmp:
        app_root = LEGACY_APP_DIR if source == "vendored" else extract_legacy_from_git(Path(tmp))
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": os.environ.get("HOME", tmp),
            "DATABASE_URL": url,
            "PYTHONPATH": str(app_root),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        code = "from app.database import init_db; init_db()"
        result = subprocess.run(
            [sys.executable, "-W", "ignore", "-c", code], cwd=app_root, env=env, capture_output=True, text=True
        )
    if result.returncode != 0:
        raise RuntimeError(f"legacy init_db() failed:\n{result.stdout}\n{result.stderr}")
    # the legacy init_db() swallows seeding errors: verify what it must have produced
    with _connect(url) as conn, conn.cursor() as cur:
        cur.execute("SELECT (SELECT count(*) FROM questions), (SELECT count(*) FROM game_settings)")
        questions, settings = cur.fetchone()
    if (questions, settings) != (20, 1):
        raise RuntimeError(f"legacy init_db() produced {questions} questions / {settings} settings (expected 20 / 1)")


# ---------------------------------------------------------------------------------------------
# 2. realistic data
# ---------------------------------------------------------------------------------------------
@dataclass
class DatasetSummary:
    counts: dict[str, int] = field(default_factory=dict)
    settings: dict = field(default_factory=dict)
    categories: list[tuple[int, str, str]] = field(default_factory=list)
    true_false_questions: int = 0
    two_choice_questions: int = 0


FIRST_NAMES = ["Hélène", "François", "Zoë", "Amélie", "John", "Priya", "Chen", "Søren", "Marta", "Omar", "Léa", "Tom"]
LAST_NAMES = ["Dupont", "O'Connor", "Müller", "Nguyen", "García", "Silva", "Kowalski", "Martin", "Bernard", "Li"]
NAMED_CHOICES = [
    ("GET", "POST"), ("200", "404"), ("OAuth 2.0", "Basic auth"), ("Kafka", "RabbitMQ"), ("JSON", "XML"),
    ("Rate limiting", "Caching"), ("401", "403"), ("PUT", "PATCH"), ("gRPC", "SOAP"), ("MQTT", "AMQP"),
    ("Idempotent", "Safe"), ("Gateway", "Sidecar"), ("OpenAPI", "AsyncAPI"), ("SSE", "WebSocket"),
]


def _questions(rng: random.Random, category_ids: list[int]) -> list[tuple]:
    rows: list[tuple] = []
    base = datetime(2026, 3, 1, 10, 0, 0)
    kinds = ["tf"] * 60 + ["named"] * 35 + ["inverted"] * 5
    rng.shuffle(kinds)
    categorised = set(rng.sample(range(100), 80))
    inactive = set(rng.sample(range(100), 10))
    media = set(rng.sample(range(100), 3))
    for i, kind in enumerate(kinds):
        created = base + timedelta(minutes=7 * i)
        if kind == "tf":
            g_en, g_fr, r_en, r_fr = "TRUE", "TRUE", "FALSE", "FALSE"
        elif kind == "inverted":
            g_en, g_fr, r_en, r_fr = "FALSE", "FAUX", "TRUE", "VRAI"
        else:
            a, b = rng.choice(NAMED_CHOICES)
            g_en, g_fr, r_en, r_fr = a, a, b, b
        text_en = f"Question {i + 1}: which statement about « API-{i} » is right? ✓"
        text_fr = f"Question {i + 1} : quelle affirmation sur « API-{i} » est correcte ? L'été à Paris"
        rows.append(
            (
                rng.choice(category_ids) if i in categorised else None,
                text_en,
                text_fr,
                "image" if i in media else "text",
                f"https://example.test/media/{i}.png" if i in media else None,
                rng.choice(["green", "red"]),
                g_en, g_fr, r_en, r_fr,
                f"Explanation {i + 1}" if i % 4 else None,
                f"Explication {i + 1} : l'API répond." if i % 5 else None,
                i not in inactive,
                rng.choice([1, 1, 2, 2, 3, 3, 4, 5]),
                created,
                created,
            )
        )
    return rows


def populate_dataset(
    url: str,
    *,
    seed: int = 20261006,
    players: int = 200,
    in_progress: int = 5,
    abandoned: int = 1,
) -> DatasetSummary:
    """Fill a database created by ``init_legacy_schema`` (20 default questions, 1 settings row)."""
    rng = random.Random(seed)
    summary = DatasetSummary()
    with _connect(url) as conn:
        with conn.cursor() as cur:
            t0 = datetime(2026, 3, 1, 9, 0, 0)
            summary.categories = execute_values(
                cur,
                "INSERT INTO categories (name, description, color, is_active, created_at, updated_at) VALUES %s "
                "RETURNING id, name, color",
                [
                    ("REST API", "Everything REST", "#4caf50", True, t0, t0),
                    ("Event API", None, "#2196f3", True, t0, t0),
                    ("Sécurité & Gravitee", "OAuth, JWT, policies: l'été des jetons", "#fc5607", True, t0, t0),
                ],
                fetch=True,
            )
            category_ids = [c[0] for c in summary.categories]

            execute_values(
                cur,
                "INSERT INTO questions (category_id, question_text_en, question_text_fr, question_type, media_url, "
                "correct_answer, green_label_en, green_label_fr, red_label_en, red_label_fr, explanation_en, "
                "explanation_fr, is_active, difficulty, created_at, updated_at) VALUES %s",
                _questions(rng, category_ids),
            )
            cur.execute("SELECT id, correct_answer FROM questions WHERE is_active ORDER BY id")
            active = cur.fetchall()

            cur.execute(
                "UPDATE game_settings SET questions_per_game=%s, timer_seconds=%s, points_correct=%s, "
                "points_wrong=%s, time_bonus_max=%s, category_distribution=%s, updated_at=%s",
                (
                    CUSTOM_SETTINGS["questions_per_game"], CUSTOM_SETTINGS["timer_seconds"],
                    CUSTOM_SETTINGS["points_correct"], CUSTOM_SETTINGS["points_wrong"],
                    CUSTOM_SETTINGS["time_bonus_max"], json.dumps(CUSTOM_SETTINGS["category_distribution"]),
                    datetime(2026, 9, 30, 8, 0, 0),
                ),
            )
            summary.settings = dict(CUSTOM_SETTINGS)

            player_rows = []
            for i in range(players):
                first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
                email = f"player{i % 150}@example.test"  # repeated e-mails: one row per registration
                phone = f"+33 6 {rng.randint(10, 99)} {rng.randint(10, 99)} {rng.randint(10, 99)} {rng.randint(10, 99)}" if rng.random() < 0.6 else None
                player_rows.append((first, last, email, phone, datetime(2026, 9, 29, 8, 0) + timedelta(minutes=9 * i)))
            player_ids = [
                r[0]
                for r in execute_values(
                    cur,
                    "INSERT INTO players (first_name, last_name, email, phone_number, created_at) VALUES %s "
                    "RETURNING id",
                    player_rows,
                    fetch=True,
                )
            ]

            sessions: list[tuple] = []  # (player_id, status, total, ok, ko, none, started, completed, config, answers)
            plan = [(pid, "completed") for pid in player_ids]
            plan += [(player_ids[i], "in_progress") for i in range(in_progress)]
            plan += [(player_ids[in_progress + i], "abandoned") for i in range(abandoned)]
            for n, (pid, status) in enumerate(plan):
                early = n < 100  # first sessions were played with the default rules, later ones with the custom ones
                per_game = 15 if early else CUSTOM_SETTINGS["questions_per_game"]
                timer = 20 if early else CUSTOM_SETTINGS["timer_seconds"]
                pc, pw, bonus = (100, 0, 50) if early else (120, 5, 40)
                config = {
                    "questions_per_game": per_game, "timer_seconds": timer,
                    "points_correct": pc, "points_wrong": pw, "time_bonus_max": bonus,
                }
                started = datetime(2026, 9, 29, 8, 5) + timedelta(minutes=9 * n)
                answers, total, ok, ko, none = [], 0, 0, 0, 0
                clock = started
                for order, (qid, correct) in enumerate(rng.sample(active, per_game), start=1):
                    if status == "in_progress":
                        answers.append((qid, None, None, None, 0, order, None))
                        continue
                    roll = rng.random()
                    t = round(rng.uniform(0.8, timer), 3)
                    clock += timedelta(seconds=t)
                    if roll < 0.10:
                        answers.append((qid, None, None, float(timer), 0, order, None))
                        none += 1
                    elif roll < 0.72:
                        points = pc + int(bonus * (1 - t / timer))
                        answers.append((qid, correct, True, t, points, order, clock))
                        total, ok = total + points, ok + 1
                    else:
                        wrong = "red" if correct == "green" else "green"
                        answers.append((qid, wrong, False, t, pw, order, clock))
                        total, ko = total + pw, ko + 1
                completed = clock if status == "completed" else None
                if status == "in_progress":
                    total = ok = ko = none = 0
                sessions.append((pid, status, total, ok, ko, none, started, completed, json.dumps(config), answers))

            session_ids = [
                r[0]
                for r in execute_values(
                    cur,
                    "INSERT INTO game_sessions (player_id, status, total_score, correct_answers, wrong_answers, "
                    "unanswered, started_at, completed_at, game_config) VALUES %s RETURNING id",
                    [s[:9] for s in sessions],
                    fetch=True,
                )
            ]
            answer_rows = [
                (sid, qid, pa, ic, tt, pe, order, at)
                for sid, s in zip(session_ids, sessions, strict=True)
                for (qid, pa, ic, tt, pe, order, at) in s[9]
            ]
            execute_values(
                cur,
                "INSERT INTO game_answers (game_session_id, question_id, player_answer, is_correct, time_taken, "
                "points_earned, question_order, answered_at) VALUES %s",
                answer_rows,
            )
        conn.commit()
    summary.counts = snapshot(url, with_checksums=False)
    summary.true_false_questions = _scalar(url, TRUE_FALSE_COUNT_SQL)
    summary.two_choice_questions = summary.counts["questions"] - summary.true_false_questions
    return summary


def build_legacy_database(url: str, *, source: str = "vendored", with_data: bool = True, seed: int = 20261006) -> DatasetSummary:
    """Create the legacy schema in ``url`` (an existing, empty database) and optionally fill it."""
    init_legacy_schema(url, source=source)
    if not with_data:
        summary = DatasetSummary(counts=snapshot(url, with_checksums=False))
        return summary
    return populate_dataset(url, seed=seed)


# ---------------------------------------------------------------------------------------------
# 3. snapshots
# ---------------------------------------------------------------------------------------------
TRUE_FALSE_RULE = (
    "upper(btrim(coalesce(green_label_en, ''))) = 'TRUE' AND upper(btrim(coalesce(red_label_en, ''))) = 'FALSE'"
)
TRUE_FALSE_COUNT_SQL = f"SELECT count(*) FROM questions WHERE {TRUE_FALSE_RULE}"


def _scalar(url: str, sql: str):
    with _connect(url) as conn, conn.cursor() as cur:
        cur.execute(sql)
        return cur.fetchone()[0]


def snapshot(url: str, *, with_checksums: bool = True) -> dict:
    """``{table: count}`` (``with_checksums=False``) or ``{table: (count, md5)}`` over the legacy columns.

    ``questions`` additionally reports ``questions.fr_labels_non_tf``: the French labels of the questions that
    are NOT true/false must be unchanged by a migration (true/false rows may get Vrai/Faux).
    """
    result: dict = {}
    with _connect(url) as conn, conn.cursor() as cur:
        for table in LEGACY_TABLES:
            if with_checksums:
                columns = ", ".join(LEGACY_COLUMNS[table])
                cur.execute(
                    f"SELECT count(*), md5(coalesce(string_agg(ROW({columns})::text, '|' ORDER BY id), '')) "
                    f"FROM {table}"
                )
                result[table] = tuple(cur.fetchone())
            else:
                cur.execute(f"SELECT count(*) FROM {table}")
                result[table] = cur.fetchone()[0]
        if with_checksums:
            cur.execute(
                "SELECT count(*), md5(coalesce(string_agg(ROW(id, green_label_fr, red_label_fr)::text, '|' ORDER BY id), '')) "
                f"FROM questions WHERE NOT ({TRUE_FALSE_RULE})"
            )
            result["questions.fr_labels_non_tf"] = tuple(cur.fetchone())
    return result


def main() -> None:  # pragma: no cover - manual tool
    parser = argparse.ArgumentParser(description="Build a legacy (pre multi-event) quiz database")
    parser.add_argument("url", help="postgresql://user:pass@host:port/db (an existing, EMPTY database)")
    parser.add_argument("--source", choices=["vendored", "git"], default="vendored")
    parser.add_argument("--no-data", action="store_true", help="schema + the 20 default questions only")
    args = parser.parse_args()
    summary = build_legacy_database(args.url, source=args.source, with_data=not args.no_data)
    print(json.dumps(summary.counts, indent=2))


if __name__ == "__main__":  # pragma: no cover
    main()
