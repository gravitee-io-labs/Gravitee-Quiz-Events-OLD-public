#!/usr/bin/env python3
"""validate_bundle.py - lint a Gravitee quiz "event bundle" (docs/ARCHITECTURE.md section 6).

Standard library only. The structural rules mirror the backend's strict ``BundleV1`` schema
(backend/app/schemas.py), so a bundle that passes here without errors imports cleanly. On top of
that it applies editorial checks that the backend cannot: duplicates, balance, text lengths, FR
completeness, difficulty ramp, French typography and a leak scan for confidential vocabulary.

Severity
    error   the backend would reject the bundle, or the game would misbehave. Exit code 1.
    warn    quality problem (too long, unbalanced, missing FR, near-duplicate...). Exit code 0,
            or 1 with ``--strict``.
    note    information only.

Usage
    python3 scripts/validate_bundle.py events/world-ai-summit-2026.json
    python3 scripts/validate_bundle.py events/*.json --strict
    python3 scripts/validate_bundle.py bundle.json --all --no-stats
    python3 scripts/validate_bundle.py bundle.json --json            # machine readable

Exit codes: 0 ok, 1 validation failed, 2 unreadable file / not JSON.

Use it as a library: ``import validate_bundle; result = validate_bundle.validate(bundle_dict)``
(``result.errors``, ``result.warnings``, ``result.stats``).
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import difflib
import json
import math
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

# --------------------------------------------------------------------------------------------
# Contract (keep in sync with docs/ARCHITECTURE.md and backend/app/schemas.py)
# --------------------------------------------------------------------------------------------
BUNDLE_FORMAT = "gravitee-quiz-event"
BUNDLE_VERSION = 1
RESERVED_SLUGS = frozenset(
    "api admin assets shared css js vendor fonts static health docs openapi favicon robots "
    "scoreboard game events new login config index manifest sw".split()
)
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
LANGUAGES = ("en", "fr")
STATUSES = ("draft", "live", "closed")
QUESTION_ORDERS = ("random", "easy_to_hard")
COLLECT_PHONE = ("hidden", "optional", "required")
FORMATS = ("true_false", "two_choices")
ANSWERS = ("green", "red")
BACKGROUNDS = ("aurora", "grid", "plain")
THEMES = ("dark", "light", "system")

TOP_KEYS = {"format", "version", "event", "categories", "questions"}
EVENT_KEYS = {
    "slug", "name", "game_title", "status", "hero_title_en", "hero_title_fr", "tagline_en",
    "tagline_fr", "description_en", "description_fr", "location", "starts_on", "ends_on",
    "languages", "default_language", "branding", "settings",
}
BRANDING_KEYS = {"primary_color", "accent_color", "background_style", "logo_url", "default_theme", "show_join_qr"}
SETTINGS_KEYS = {
    "questions_per_game", "timer_seconds", "points_correct", "points_wrong", "time_bonus_max",
    "category_distribution", "question_order", "collect_phone", "consent_text_en", "consent_text_fr",
}
CATEGORY_KEYS = {"name", "name_fr", "description", "description_fr", "color", "is_active"}
QUESTION_KEYS = {
    "category", "question_format", "difficulty", "question_text_en", "question_text_fr",
    "question_type", "media_url", "correct_answer", "green_label_en", "green_label_fr",
    "red_label_en", "red_label_fr", "explanation_en", "explanation_fr", "is_active",
}
TRUE_FALSE_LABELS = {
    "green_label_en": "TRUE", "green_label_fr": "Vrai", "red_label_en": "FALSE", "red_label_fr": "Faux",
}

# Editorial limits. Soft limits are warnings, hard limits are errors.
EN_STATEMENT_MAX = 160       # EN statement / question, characters
FR_STATEMENT_MAX = 200       # FR is naturally ~20% longer
LABEL_SOFT_MAX = 28          # option labels must fit a big button
LABEL_HARD_MAX = 40          # design limit, docs/ARCHITECTURE.md section 6 (warning)
LABEL_BACKEND_MAX = 100      # what the backend accepts (error)
EXPLANATION_EN_MAX = 400
EXPLANATION_FR_MAX = 480
TAGLINE_SOFT_MAX = 100
HERO_SOFT_MAX = 80
DESCRIPTION_SOFT_MAX = 300
CATEGORY_NAME_SOFT_MAX = 40
NEAR_DUPLICATE_RATIO = 0.86
NEAR_DUPLICATE_MAX_QUESTIONS = 800
GREEN_SHARE_RANGE = (0.40, 0.60)           # whole bundle
GREEN_SHARE_RANGE_CATEGORY = (0.30, 0.70)  # per category (>= 10 questions)

# Vocabulary that must never reach a public question (customers, competitors, finance, unreleased features...).
# The confidential list is NOT stored in this public repository: put one regular expression per line in
# scripts/leak-terms.local.txt (gitignored) or point QUIZ_LEAK_TERMS_FILE at a file. Only generic finance terms are built in.
LEAK_TERMS = (r"\bARR\b", r"\bIPO\b")


def _load_leak_terms():
    terms = list(LEAK_TERMS)
    path = os.environ.get("QUIZ_LEAK_TERMS_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "leak-terms.local.txt")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            terms += [ln.strip() for ln in fh if ln.strip() and not ln.lstrip().startswith("#")]
    return terms


LEAK_RE = re.compile(r"(?<![\w])(?:" + "|".join(_load_leak_terms()) + r")(?![\w])")


# --------------------------------------------------------------------------------------------
# Findings
# --------------------------------------------------------------------------------------------
@dataclass
class Finding:
    level: str  # error | warn | note
    code: str
    where: str
    message: str


@dataclass
class Result:
    findings: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def add(self, level: str, code: str, where: str, message: str) -> None:
        self.findings.append(Finding(level, code, where, message))

    def error(self, code: str, where: str, message: str) -> None:
        self.add("error", code, where, message)

    def warn(self, code: str, where: str, message: str) -> None:
        self.add("warn", code, where, message)

    def note(self, code: str, where: str, message: str) -> None:
        self.add("note", code, where, message)

    @property
    def errors(self) -> list:
        return [f for f in self.findings if f.level == "error"]

    @property
    def warnings(self) -> list:
        return [f for f in self.findings if f.level == "warn"]

    @property
    def notes(self) -> list:
        return [f for f in self.findings if f.level == "note"]

    def ok(self, strict: bool = False) -> bool:
        return not self.errors and not (strict and self.warnings)


# --------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------
def norm_text(text: Any) -> str:
    """Duplicate-detection key (same as the backend CSV import): NFKC, collapsed spaces, casefold."""
    return " ".join(unicodedata.normalize("NFKC", text or "").split()).casefold()


def is_str(value: Any) -> bool:
    return isinstance(value, str)


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def opt_text(value: Any) -> Optional[str]:
    """The text if it is a non-blank string, else None (the backend turns blank into null)."""
    return value.strip() if isinstance(value, str) and value.strip() else None


def clip(text: str, width: int = 60) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[: width - 1] + "…"


def parse_date(value: Any) -> Optional[dt.date]:
    if not is_str(value):
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def pct(part: int, whole: int) -> str:
    return f"{(100.0 * part / whole):.0f}%" if whole else "-"


def largest_remainder(total: int, weights: dict) -> dict:
    """Allocate ``total`` slots proportionally to ``weights`` (largest remainder, ties by name)."""
    weight_sum = sum(weights.values())
    if total <= 0 or weight_sum <= 0:
        return {k: 0 for k in weights}
    raw = {k: total * w / weight_sum for k, w in weights.items()}
    alloc = {k: int(math.floor(v)) for k, v in raw.items()}
    leftover = total - sum(alloc.values())
    for k in sorted(weights, key=lambda key: (-(raw[key] - alloc[key]), key))[:leftover]:
        alloc[k] += 1
    return alloc


# --------------------------------------------------------------------------------------------
# Section checks
# --------------------------------------------------------------------------------------------
def check_keys(res: Result, where: str, obj: dict, allowed: set, required: tuple = ()) -> None:
    for key in sorted(set(obj) - allowed):
        res.error("unknown-key", where, f"unknown key '{key}' (the backend rejects it)")
    for key in required:
        if key not in obj:
            res.error("missing-key", where, f"missing required key '{key}'")


def check_text_field(res: Result, where: str, obj: dict, key: str, max_len: int,
                     soft_max: Optional[int] = None, required: bool = False) -> None:
    value = obj.get(key)
    if value is None:
        if required:
            res.error("missing-value", where, f"'{key}' is required")
        return
    if not is_str(value):
        res.error("bad-type", where, f"'{key}' must be a string or null")
        return
    if required and not value.strip():
        res.error("missing-value", where, f"'{key}' must not be blank")
    if len(value) > max_len:
        res.error("too-long", where, f"'{key}' is {len(value)} chars (max {max_len})")
    elif soft_max is not None and len(value) > soft_max:
        res.warn("long-text", where, f"'{key}' is {len(value)} chars (recommended <= {soft_max})")


def check_color(res: Result, where: str, key: str, value: Any) -> None:
    if not is_str(value) or not HEX_RE.match(value):
        res.error("bad-color", where, f"'{key}' must be #RRGGBB, got {value!r}")


def check_event(res: Result, bundle: dict) -> dict:
    ev = bundle.get("event")
    where = "event"
    info = {"languages": [], "settings": {}, "status": None, "slug": None, "name": None}
    if not isinstance(ev, dict):
        res.error("bad-type", where, "'event' must be an object")
        return info
    check_keys(res, where, ev, EVENT_KEYS, ("slug", "name", "game_title", "languages", "default_language"))

    slug = ev.get("slug")
    info["slug"], info["name"] = slug, ev.get("name")
    if is_str(slug):
        if not 2 <= len(slug) <= 48:
            res.error("bad-slug", where, f"slug must be 2-48 chars, got {len(slug)}")
        if not SLUG_RE.match(slug):
            res.error("bad-slug", where, f"slug '{slug}' must match ^[a-z0-9]+(-[a-z0-9]+)*$")
        if slug in RESERVED_SLUGS:
            res.error("reserved-slug", where, f"slug '{slug}' is reserved")
    elif slug is not None:
        res.error("bad-type", where, "'slug' must be a string")

    check_text_field(res, where, ev, "name", 200, required=True)
    check_text_field(res, where, ev, "game_title", 100, required=True)
    check_text_field(res, where, ev, "hero_title_en", 200, HERO_SOFT_MAX)
    check_text_field(res, where, ev, "hero_title_fr", 200, HERO_SOFT_MAX)
    check_text_field(res, where, ev, "tagline_en", 300, TAGLINE_SOFT_MAX)
    check_text_field(res, where, ev, "tagline_fr", 300, TAGLINE_SOFT_MAX)
    check_text_field(res, where, ev, "description_en", 4000, DESCRIPTION_SOFT_MAX)
    check_text_field(res, where, ev, "description_fr", 4000, DESCRIPTION_SOFT_MAX)
    check_text_field(res, where, ev, "location", 200)

    status = ev.get("status", "draft")
    info["status"] = status
    if status not in STATUSES:
        res.error("bad-enum", where, f"status must be one of {STATUSES}, got {status!r}")

    langs = ev.get("languages")
    default = ev.get("default_language")
    if not isinstance(langs, list) or not langs:
        res.error("bad-languages", where, "languages must be a non-empty list")
        langs = []
    else:
        for lang in langs:
            if lang not in LANGUAGES:
                res.error("bad-languages", where, f"unsupported language {lang!r} (allowed {LANGUAGES})")
        if len(set(map(str, langs))) != len(langs):
            res.error("bad-languages", where, "languages contains duplicates")
        if default not in langs:
            res.error("bad-languages", where, f"default_language {default!r} must be one of languages")
    info["languages"] = [lang for lang in langs if lang in LANGUAGES]
    if "fr" in info["languages"]:
        for key in ("hero_title_fr", "tagline_fr", "description_fr"):
            if not opt_text(ev.get(key)):
                res.warn("missing-fr", where, f"'{key}' is empty although 'fr' is enabled (falls back to EN)")
    for key in ("hero_title_en", "tagline_en", "description_en"):
        if not opt_text(ev.get(key)):
            res.warn("missing-event-text", where, f"'{key}' is empty (UI falls back to a generic default)")

    starts, ends = ev.get("starts_on"), ev.get("ends_on")
    for key, value in (("starts_on", starts), ("ends_on", ends)):
        if value is not None and parse_date(value) is None:
            res.error("bad-date", where, f"'{key}' must be an ISO date YYYY-MM-DD, got {value!r}")
    d1, d2 = parse_date(starts), parse_date(ends)
    if d1 and d2 and d2 < d1:
        res.error("bad-date", where, "ends_on is before starts_on")
    if ev.get("status") == "live" and d2 and d2 < dt.date.today():
        res.warn("event-over", where, f"event is 'live' but ended on {d2.isoformat()}")

    branding = ev.get("branding", {})
    bw = "event.branding"
    if not isinstance(branding, dict):
        res.error("bad-type", bw, "'branding' must be an object")
    else:
        check_keys(res, bw, branding, BRANDING_KEYS)
        for key in ("primary_color", "accent_color"):
            if key in branding:
                check_color(res, bw, key, branding[key])
        if branding.get("background_style", "aurora") not in BACKGROUNDS:
            res.error("bad-enum", bw, f"background_style must be one of {BACKGROUNDS}")
        if branding.get("default_theme", "dark") not in THEMES:
            res.error("bad-enum", bw, f"default_theme must be one of {THEMES}")
        logo = branding.get("logo_url")
        if logo is not None:
            if not is_str(logo) or len(logo) > 500 or re.search(r"[\s\"'<>]", logo) or not (
                (logo.startswith("https://") and len(logo) > 8) or (logo.startswith("/") and not logo.startswith("//"))
            ):
                res.error("bad-url", bw, "logo_url must be null, https://... or a root-relative /path")
        p, a = branding.get("primary_color"), branding.get("accent_color")
        if is_str(p) and is_str(a) and p.upper() == a.upper():
            res.warn("same-colors", bw, "primary_color and accent_color are identical")

    settings = ev.get("settings", {})
    sw = "event.settings"
    if not isinstance(settings, dict):
        res.error("bad-type", sw, "'settings' must be an object")
        settings = {}
    check_keys(res, sw, settings, SETTINGS_KEYS)
    ranges = {
        "questions_per_game": (1, 50), "timer_seconds": (5, 120), "points_correct": (0, 100_000),
        "points_wrong": (0, 100_000), "time_bonus_max": (0, 100_000),
    }
    for key, (lo, hi) in ranges.items():
        if key in settings and not (is_int(settings[key]) and lo <= settings[key] <= hi):
            res.error("bad-setting", sw, f"'{key}' must be an integer in [{lo}, {hi}], got {settings[key]!r}")
    if settings.get("question_order", "random") not in QUESTION_ORDERS:
        res.error("bad-enum", sw, f"question_order must be one of {QUESTION_ORDERS}")
    if settings.get("collect_phone", "optional") not in COLLECT_PHONE:
        res.error("bad-enum", sw, f"collect_phone must be one of {COLLECT_PHONE}")
    for key in ("consent_text_en", "consent_text_fr"):
        check_text_field(res, sw, settings, key, 4000)
    if opt_text(settings.get("consent_text_en")) and "fr" in info["languages"] and not opt_text(
        settings.get("consent_text_fr")
    ):
        res.warn("missing-fr", sw, "consent_text_fr is empty although consent_text_en is set")
    info["settings"] = settings
    return info


def check_categories(res: Result, bundle: dict, langs: list) -> list:
    cats = bundle.get("categories")
    if not isinstance(cats, list):
        res.error("bad-type", "categories", "'categories' must be a list")
        return []
    names, seen, colors = [], {}, collections.defaultdict(list)
    for i, cat in enumerate(cats):
        where = f"categories[{i}]"
        if not isinstance(cat, dict):
            res.error("bad-type", where, "category must be an object")
            continue
        check_keys(res, where, cat, CATEGORY_KEYS, ("name",))
        name = cat.get("name")
        check_text_field(res, where, cat, "name", 100, CATEGORY_NAME_SOFT_MAX, required=True)
        check_text_field(res, where, cat, "name_fr", 100, CATEGORY_NAME_SOFT_MAX)
        check_text_field(res, where, cat, "description", 2000, 200)
        check_text_field(res, where, cat, "description_fr", 2000, 220)
        if "color" in cat:
            check_color(res, where, "color", cat["color"])
            if is_str(cat["color"]):
                colors[cat["color"].upper()].append(name)
        if "is_active" in cat and not isinstance(cat["is_active"], bool):
            res.error("bad-type", where, "'is_active' must be a boolean")
        if is_str(name):
            names.append(name)
            key = norm_text(name)
            if key in seen:
                res.error("duplicate-category", where, f"category name '{name}' duplicates categories[{seen[key]}]")
            seen[key] = i
        if "fr" in langs:
            if not opt_text(cat.get("name_fr")):
                res.warn("missing-fr", where, "name_fr is empty although 'fr' is enabled")
            if opt_text(cat.get("description")) and not opt_text(cat.get("description_fr")):
                res.warn("missing-fr", where, "description_fr is empty although description is set")
    for color, owners in colors.items():
        if len(owners) > 1:
            res.warn("same-colors", "categories", f"colour {color} is shared by {owners}: chips become indistinguishable")
    return names


def check_questions(res: Result, bundle: dict, cat_names: list, langs: list, settings: dict) -> list:
    """Per-question checks; returns the list of usable question dicts (with their index)."""
    questions = bundle.get("questions")
    if not isinstance(questions, list):
        res.error("bad-type", "questions", "'questions' must be a list")
        return []
    known = set(cat_names)
    usable = []
    fr_on = "fr" in langs
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            res.error("bad-type", f"questions[{i}]", "question must be an object")
            continue
        tag = f"questions[{i}]"
        label = f"{tag} [{q.get('category')}, d{q.get('difficulty')}] {clip(q.get('question_text_en', ''), 48)!r}"
        check_keys(res, label, q, QUESTION_KEYS, ("question_text_en", "correct_answer"))

        category = q.get("category")
        if category is None:
            res.warn("uncategorised", label, "question has no category")
        elif category not in known:
            res.error("bad-category-ref", label, f"category '{category}' is not defined in categories")

        fmt = q.get("question_format", "true_false")
        if fmt not in FORMATS:
            res.error("bad-enum", label, f"question_format must be one of {FORMATS}, got {fmt!r}")
        diff = q.get("difficulty", 1)
        if not (is_int(diff) and 1 <= diff <= 5):
            res.error("bad-difficulty", label, f"difficulty must be an integer 1-5, got {diff!r}")
        elif diff > 3:
            res.note("difficulty-range", label, f"difficulty {diff} is outside the 1-3 scale used by the content")
        if q.get("correct_answer") not in ANSWERS:
            res.error("bad-enum", label, f"correct_answer must be 'green' or 'red', got {q.get('correct_answer')!r}")
        if "is_active" in q and not isinstance(q["is_active"], bool):
            res.error("bad-type", label, "'is_active' must be a boolean")

        en, fr = q.get("question_text_en"), q.get("question_text_fr")
        if not is_str(en) or not en.strip():
            res.error("missing-value", label, "question_text_en is required")
            continue
        if len(en) > 2000:
            res.error("too-long", label, f"question_text_en is {len(en)} chars (max 2000)")
        elif len(en) > EN_STATEMENT_MAX:
            res.warn("long-text", label, f"EN statement is {len(en)} chars (recommended <= {EN_STATEMENT_MAX})")
        if fr is not None and not is_str(fr):
            res.error("bad-type", label, "question_text_fr must be a string or null")
            fr = None
        if fr and len(fr) > 2000:
            res.error("too-long", label, f"question_text_fr is {len(fr)} chars (max 2000)")
        elif fr and len(fr) > FR_STATEMENT_MAX:
            res.warn("long-text", label, f"FR statement is {len(fr)} chars (recommended <= {FR_STATEMENT_MAX})")
        if fr_on and not opt_text(fr):
            res.warn("missing-fr", label, "question_text_fr is empty although 'fr' is enabled (falls back to EN)")
        elif fr and norm_text(fr) == norm_text(en):
            res.note("fr-equals-en", label, "FR statement is identical to EN (fallback copy?)")
        if fmt == "true_false" and en.rstrip().endswith("?"):
            res.warn("tf-question-mark", label, "a TRUE/FALSE item should be a statement, not a question")

        labels = {k: q.get(k) for k in ("green_label_en", "green_label_fr", "red_label_en", "red_label_fr")}
        for key, value in labels.items():
            if value is not None and not is_str(value):
                res.error("bad-type", label, f"'{key}' must be a string or null")
                labels[key] = None
        if fmt == "true_false":
            for key, expected in TRUE_FALSE_LABELS.items():
                if labels[key] is not None and labels[key] != expected:
                    res.error("tf-labels", label, f"true_false labels must be {expected!r} for '{key}', got {labels[key]!r}")
                elif labels[key] is None:
                    res.note("tf-labels", label, f"'{key}' omitted; the backend sets {expected!r}")
        elif fmt == "two_choices":
            for key in ("green_label_en", "red_label_en"):
                if not opt_text(labels[key]):
                    res.error("missing-label", label, f"two_choices requires '{key}'")
            if opt_text(labels["green_label_en"]) and opt_text(labels["red_label_en"]) and (
                labels["green_label_en"].strip().casefold() == labels["red_label_en"].strip().casefold()
            ):
                res.error("same-labels", label, "the two EN answer labels must differ")
            if (
                opt_text(labels["green_label_fr"])
                and opt_text(labels["red_label_fr"])
                and labels["green_label_fr"].strip().casefold() == labels["red_label_fr"].strip().casefold()
            ):
                res.error("same-labels", label, "the two FR answer labels must differ")
            for key, value in labels.items():
                if not value:
                    if fr_on and key.endswith("_fr") and opt_text(labels[key.replace("_fr", "_en")]):
                        res.warn("missing-fr", label, f"'{key}' is empty (falls back to the EN label)")
                    continue
                if len(value) > LABEL_BACKEND_MAX:
                    res.error("label-too-long", label, f"'{key}' is {len(value)} chars (the backend rejects more than {LABEL_BACKEND_MAX})")
                elif len(value) > LABEL_HARD_MAX:
                    res.warn("label-long", label, f"'{key}' is {len(value)} chars, over the {LABEL_HARD_MAX}-char design limit of docs/ARCHITECTURE.md: {value!r}")
                elif len(value) > LABEL_SOFT_MAX:
                    res.warn("label-long", label, f"'{key}' is {len(value)} chars (recommended <= {LABEL_SOFT_MAX}): {value!r}")

        for key, soft in (("explanation_en", EXPLANATION_EN_MAX), ("explanation_fr", EXPLANATION_FR_MAX)):
            value = q.get(key)
            if value is not None and not is_str(value):
                res.error("bad-type", label, f"'{key}' must be a string or null")
            elif value and len(value) > 4000:
                res.error("too-long", label, f"'{key}' is {len(value)} chars (max 4000)")
            elif value and len(value) > soft:
                res.warn("long-explanation", label, f"'{key}' is {len(value)} chars (recommended <= {soft})")
        if not opt_text(q.get("explanation_en")):
            res.warn("no-explanation", label, "explanation_en is empty (the review screen has nothing to teach)")
        if fr_on and opt_text(q.get("explanation_en")) and not opt_text(q.get("explanation_fr")):
            res.warn("missing-fr", label, "explanation_fr is empty although 'fr' is enabled")

        media = q.get("media_url")
        if media is not None and not (is_str(media) and (media.startswith("https://") or (media.startswith("/") and not media.startswith("//")))):
            res.error("bad-url", label, "media_url must be null, https://... or a root-relative /path")

        usable.append({**q, "_i": i, "_label": label, "_fmt": fmt})
    return usable


def check_cross_question(res: Result, usable: list) -> None:
    """Duplicates, near-duplicates and mirrored two-choice pairs."""
    seen: dict = {}
    for q in usable:
        key = norm_text(q.get("question_text_en"))
        if key in seen:
            res.error("duplicate-question", q["_label"], f"duplicates questions[{seen[key]}] (same normalised EN text)")
        else:
            seen[key] = q["_i"]

    if len(usable) <= NEAR_DUPLICATE_MAX_QUESTIONS:
        texts = [(q, norm_text(q.get("question_text_en"))) for q in usable]
        for a in range(len(texts)):
            qa, ta = texts[a]
            for b in range(a + 1, len(texts)):
                qb, tb = texts[b]
                if ta == tb:
                    continue
                matcher = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
                if matcher.real_quick_ratio() >= NEAR_DUPLICATE_RATIO and matcher.quick_ratio() >= NEAR_DUPLICATE_RATIO:
                    ratio = matcher.ratio()
                    if ratio >= NEAR_DUPLICATE_RATIO:
                        res.warn("near-duplicate", qa["_label"], f"{ratio:.0%} similar to questions[{qb['_i']}] {clip(qb.get('question_text_en', ''), 50)!r}")
    else:
        res.note("near-duplicate", "questions", f"near-duplicate scan skipped (> {NEAR_DUPLICATE_MAX_QUESTIONS} questions)")

    pairs = collections.defaultdict(list)
    for q in usable:
        if q["_fmt"] == "two_choices" and opt_text(q.get("green_label_en")) and opt_text(q.get("red_label_en")):
            pairs[frozenset((norm_text(q["green_label_en"]), norm_text(q["red_label_en"])))].append(q["_i"])
    for pair, idx in pairs.items():
        if len(idx) > 1:
            res.warn("mirrored-choices", f"questions{idx}", f"same pair of answer labels {sorted(pair)} used {len(idx)} times (mirror questions?)")


def check_text_hygiene(res: Result, bundle: dict, usable: list, cats: list) -> None:
    """Aggregated typography / whitespace checks over every player-facing string."""
    fields = []  # (where, key, text)
    ev = bundle.get("event", {}) if isinstance(bundle.get("event"), dict) else {}
    for key in ("name", "game_title", "hero_title_en", "hero_title_fr", "tagline_en", "tagline_fr", "description_en", "description_fr"):
        if is_str(ev.get(key)):
            fields.append(("event", key, ev[key]))
    for i, c in enumerate(cats):
        if isinstance(c, dict):
            for key in ("name", "name_fr", "description", "description_fr"):
                if is_str(c.get(key)):
                    fields.append((f"categories[{i}]", key, c[key]))
    for q in usable:
        for key in ("question_text_en", "question_text_fr", "green_label_en", "green_label_fr", "red_label_en", "red_label_fr", "explanation_en", "explanation_fr"):
            if is_str(q.get(key)):
                fields.append((q["_label"], key, q[key]))

    fr_plain_space = re.compile(r"(?<=[^\s  ]) (?=[?!:;»])|« ")
    straight = curly = 0
    for where, key, text in fields:
        if text != text.strip():
            res.warn("whitespace", where, f"'{key}' has leading/trailing whitespace")
        if "  " in text:
            res.warn("whitespace", where, f"'{key}' contains a double space")
        if re.search(r"[\x00-\x08\x0b-\x1f]", text):
            res.error("control-char", where, f"'{key}' contains a control character")
        if key.endswith("_fr") and fr_plain_space.search(text):
            res.warn("fr-typography", where, f"'{key}': use a non-breaking space (U+00A0) before ? ! : ; and inside « »")
        straight += len(re.findall(r"(?<=\w)'(?=\w)", text))
        curly += len(re.findall(r"(?<=\w)’(?=\w)", text))
        leak = LEAK_RE.search(text)
        if leak:
            res.warn("leak-scan", where, f"'{key}' mentions '{leak.group(0)}': confidential, customer, competitor or roadmap vocabulary?")
    if straight and curly:
        res.warn("mixed-apostrophes", "bundle", f"mixed apostrophe styles: {straight} straight (') and {curly} typographic (’)")


def check_balance_and_settings(res: Result, usable: list, cat_names: list, settings: dict) -> dict:
    """Capacity vs rules, answer balance, difficulty ramp. Returns the stats dict."""
    active = [q for q in usable if q.get("is_active", True) is not False]
    per_cat = collections.OrderedDict((n, []) for n in cat_names)
    uncategorised = []
    for q in active:
        (per_cat[q["category"]] if q.get("category") in per_cat else uncategorised).append(q)

    stats: dict = {
        "total": len(usable), "active": len(active), "categories": {}, "overall": {},
    }

    def tally(items: list) -> dict:
        t = {
            "n": len(items),
            "difficulty": collections.Counter(q.get("difficulty", 1) for q in items),
            "format": collections.Counter(q["_fmt"] for q in items),
            "answer": collections.Counter(q.get("correct_answer") for q in items),
            "fmt_answer": collections.Counter((q["_fmt"], q.get("correct_answer")) for q in items),
        }
        t["lens"] = {
            "en": [len(q.get("question_text_en") or "") for q in items],
            "fr": [len(q.get("question_text_fr") or "") for q in items],
            "label": [len(q.get(k) or "") for q in items if q["_fmt"] == "two_choices" for k in ("green_label_en", "red_label_en")],
            "expl_en": [len(q.get("explanation_en") or "") for q in items],
            "expl_fr": [len(q.get("explanation_fr") or "") for q in items],
        }
        return t

    for name, items in per_cat.items():
        stats["categories"][name] = tally(items)
    stats["overall"] = tally(active)

    # overall answer balance
    n = len(active)
    if n >= 10:
        lo, hi = GREEN_SHARE_RANGE
        share = stats["overall"]["answer"]["green"] / n
        if not lo <= share <= hi:
            res.warn("balance", "bundle", f"green is the right answer for {share:.0%} of questions (target {lo:.0%}-{hi:.0%})")
        for fmt in FORMATS:
            sub = [q for q in active if q["_fmt"] == fmt]
            if len(sub) >= 10:
                g = sum(1 for q in sub if q.get("correct_answer") == "green") / len(sub)
                if not 0.35 <= g <= 0.65:
                    res.warn("balance", "bundle", f"{fmt}: green is correct for {g:.0%} of {len(sub)} questions (target 35%-65%)")
    for name, items in per_cat.items():
        if len(items) >= 10:
            lo, hi = GREEN_SHARE_RANGE_CATEGORY
            share = sum(1 for q in items if q.get("correct_answer") == "green") / len(items)
            if not lo <= share <= hi:
                res.warn("balance", f"category '{name}'", f"green is correct for {share:.0%} of {len(items)} questions (target {lo:.0%}-{hi:.0%})")
    if uncategorised:
        res.note("uncategorised", "bundle", f"{len(uncategorised)} active question(s) without a category")

    # capacity vs rules
    per_game = settings.get("questions_per_game", 15) if is_int(settings.get("questions_per_game", 15)) else 15
    if len(active) < per_game:
        res.error("not-enough-questions", "event.settings", f"only {len(active)} active questions for questions_per_game={per_game} (the API answers 400 not_enough_questions)")
    distribution = settings.get("category_distribution")
    usable_cats = {n: items for n, items in per_cat.items() if items}
    if isinstance(distribution, dict) and distribution:
        for key in distribution:
            if key not in per_cat:
                res.error("bad-distribution", "event.settings", f"category_distribution key '{key}' is not a category name")
        weights = {}
        for key, w in distribution.items():
            if not (is_int(w) and 0 <= w <= 1000):
                res.error("bad-distribution", "event.settings", f"weight for '{key}' must be an integer 0-1000, got {w!r}")
            elif key in usable_cats:
                weights[key] = w
        if distribution and not any(is_int(w) and w > 0 for w in distribution.values()):
            res.error("bad-distribution", "event.settings", "category_distribution needs at least one weight > 0")
        for name in usable_cats:
            if name not in distribution:
                res.warn("bad-distribution", "event.settings", f"category '{name}' has questions but no weight: it is never drawn")
    else:
        weights = {n: 1 for n in usable_cats}
    stats["weights"] = weights
    alloc = largest_remainder(per_game, weights) if weights else {}
    stats["allocation"] = alloc
    for name, slots in alloc.items():
        have = len(usable_cats.get(name, []))
        if have < slots:
            res.warn("capacity", f"category '{name}'", f"allocated {slots} slot(s) per game but only {have} active question(s): shortfall is redistributed")

    # difficulty ramp (easy_to_hard)
    if settings.get("question_order") == "easy_to_hard" and alloc:
        for name, slots in alloc.items():
            if slots <= 0:
                continue
            counts = collections.Counter(q.get("difficulty", 1) for q in usable_cats.get(name, []))
            for level in (1, 2, 3):
                if counts.get(level, 0) < slots:
                    res.warn("ramp", f"category '{name}'", f"only {counts.get(level, 0)} question(s) of difficulty {level} for {slots} slot(s) per game: the easy-to-hard ramp will feel thin")
    return stats


# --------------------------------------------------------------------------------------------
# Entry point (library + CLI)
# --------------------------------------------------------------------------------------------
def validate(bundle: Any) -> Result:
    res = Result()
    if not isinstance(bundle, dict):
        res.error("bad-type", "bundle", "the bundle must be a JSON object")
        return res
    check_keys(res, "bundle", bundle, TOP_KEYS, ("format", "version", "event"))
    if bundle.get("format") != BUNDLE_FORMAT:
        res.error("bad-format", "bundle", f"format must be {BUNDLE_FORMAT!r}, got {bundle.get('format')!r}")
    if bundle.get("version") != BUNDLE_VERSION or isinstance(bundle.get("version"), bool):
        res.error("bad-format", "bundle", f"version must be {BUNDLE_VERSION}, got {bundle.get('version')!r}")

    info = check_event(res, bundle)
    cat_names = check_categories(res, bundle, info["languages"])
    usable = check_questions(res, bundle, cat_names, info["languages"], info["settings"])
    check_cross_question(res, usable)
    check_text_hygiene(res, bundle, usable, bundle.get("categories") if isinstance(bundle.get("categories"), list) else [])
    res.stats = check_balance_and_settings(res, usable, cat_names, info["settings"])
    res.stats["event"] = {k: info[k] for k in ("slug", "name", "status", "languages")}
    return res


# --------------------------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------------------------
class Style:
    def __init__(self, color: bool):
        self.color = color

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def red(self, t: str) -> str:
        return self._wrap("31", t)

    def yellow(self, t: str) -> str:
        return self._wrap("33", t)

    def green(self, t: str) -> str:
        return self._wrap("32", t)

    def dim(self, t: str) -> str:
        return self._wrap("2", t)

    def bold(self, t: str) -> str:
        return self._wrap("1", t)


def avg(values: list) -> str:
    return f"{sum(values) / len(values):.0f}" if values else "-"


def mx(values: list) -> str:
    return str(max(values)) if values else "-"


def print_findings(res: Result, style: Style, show_all: bool, per_code: int, out) -> None:
    for level, title, paint in (("error", "ERRORS", style.red), ("warn", "WARNINGS", style.yellow), ("note", "NOTES", style.dim)):
        items = [f for f in res.findings if f.level == level]
        if not items:
            continue
        print(paint(f"\n{title} ({len(items)})"), file=out)
        by_code = collections.OrderedDict()
        for f in items:
            by_code.setdefault(f.code, []).append(f)
        for code, group in by_code.items():
            print(f"  {paint('[' + code + ']')} x{len(group)}", file=out)
            shown = group if show_all else group[:per_code]
            for f in shown:
                print(f"    - {f.where}: {f.message}", file=out)
            if len(shown) < len(group):
                print(style.dim(f"    ... and {len(group) - len(shown)} more (use --all)"), file=out)


def print_stats(res: Result, style: Style, out) -> None:
    s = res.stats
    if not s or "categories" not in s:
        return
    ov = s["overall"]
    n = ov["n"]
    ev = s.get("event", {})
    print(style.bold(f"\nSTATS  {ev.get('slug')}  \"{ev.get('name')}\"  [{ev.get('status')}]  langs={','.join(ev.get('languages', []))}"), file=out)
    print(f"  questions: {s['total']} ({s['active']} active) in {len(s['categories'])} categories", file=out)

    header = f"  {'category':<28}{'d1':>4}{'d2':>4}{'d3':>4}{'tot':>5}  {'TF':>4}{'2ch':>5}  {'green':>6}  {'slots':>5}"
    print(style.dim(header), file=out)
    for name, t in list(s["categories"].items()) + [("ALL", ov)]:
        d, f, a = t["difficulty"], t["format"], t["answer"]
        slots = s.get("allocation", {}).get(name, "") if name != "ALL" else sum(s.get("allocation", {}).values()) or ""
        green = f"{pct(a['green'], t['n'])}" if t["n"] else "-"
        print(f"  {clip(name, 27):<28}{d.get(1, 0):>4}{d.get(2, 0):>4}{d.get(3, 0):>4}{t['n']:>5}  {f['true_false']:>4}{f['two_choices']:>5}  {green:>6}  {slots!s:>5}", file=out)
    other = {k: v for k, v in ov["difficulty"].items() if k not in (1, 2, 3)}
    if other:
        print(f"  other difficulties: {dict(other)}", file=out)

    fa = ov["fmt_answer"]
    print(f"\n  answers: green {ov['answer']['green']} ({pct(ov['answer']['green'], n)}) / red {ov['answer']['red']} ({pct(ov['answer']['red'], n)})", file=out)
    for fmt in FORMATS:
        g, r = fa[(fmt, 'green')], fa[(fmt, 'red')]
        print(f"    {fmt:<11} {g + r:>3}  green {g} / red {r}", file=out)
    L = ov["lens"]
    print(f"  length (chars)   avg / max:  EN statement {avg(L['en'])} / {mx(L['en'])}   FR statement {avg(L['fr'])} / {mx(L['fr'])}   labels - / {mx(L['label'])}", file=out)
    print(f"                   explanation EN {avg(L['expl_en'])} / {mx(L['expl_en'])}   FR {avg(L['expl_fr'])} / {mx(L['expl_fr'])}", file=out)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Validate Gravitee quiz event bundles (docs/ARCHITECTURE.md section 6).")
    ap.add_argument("files", nargs="+", help="bundle JSON file(s)")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors (exit 1)")
    ap.add_argument("--all", action="store_true", help="print every finding instead of the first few per code")
    ap.add_argument("--per-code", type=int, default=5, metavar="N", help="findings shown per code (default 5)")
    ap.add_argument("--no-stats", action="store_true", help="skip the statistics tables")
    ap.add_argument("--json", action="store_true", help="machine readable output")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args(argv)

    style = Style(sys.stdout.isatty() and not args.no_color and not args.json)
    exit_code = 0
    json_out = []
    for path in args.files:
        try:
            bundle = json.loads(Path(path).read_text(encoding="utf-8"))
        except OSError as exc:
            print(f"{path}: cannot read file: {exc}", file=sys.stderr)
            exit_code = max(exit_code, 2)
            continue
        except json.JSONDecodeError as exc:
            print(f"{path}: not valid JSON: {exc}", file=sys.stderr)
            exit_code = max(exit_code, 2)
            continue
        res = validate(bundle)
        ok = res.ok(strict=args.strict)
        if args.json:
            def dump(fs):
                return [{"code": f.code, "where": f.where, "message": f.message} for f in fs]
            stats = res.stats
            json_out.append({
                "file": path, "ok": ok, "errors": dump(res.errors), "warnings": dump(res.warnings), "notes": dump(res.notes),
                "questions": stats.get("total"), "active": stats.get("active"),
            })
        else:
            print(style.bold(f"\n=== {path}"), file=sys.stdout)
            print_findings(res, style, args.all, args.per_code, sys.stdout)
            if not args.no_stats:
                print_stats(res, style, sys.stdout)
            verdict = f"{len(res.errors)} error(s), {len(res.warnings)} warning(s), {len(res.notes)} note(s)"
            print("\n" + (style.green(f"OK  {verdict}") if ok else style.red(f"FAILED  {verdict}" + ("  (--strict)" if not res.errors else ""))), file=sys.stdout)
        if not ok:
            exit_code = max(exit_code, 1)
    if args.json:
        print(json.dumps(json_out, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
