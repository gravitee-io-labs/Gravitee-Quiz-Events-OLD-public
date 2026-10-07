#!/usr/bin/env python3
"""csv_to_bundle.py - turn a legacy question CSV into a quiz "event bundle" (docs/ARCHITECTURE.md section 6).

Faithful conversion, not a rewrite: question texts, labels and explanations are copied verbatim
(only surrounding whitespace is trimmed). The converter adds what a CSV cannot carry: the event
(slug, name, branding, rules) and the categories (colours, French names, descriptions).

CSV columns (as the legacy file and the admin CSV import)::

    category, difficulty, question_text_en, question_text_fr, correct_answer,
    green_label_en, green_label_fr, red_label_en, red_label_fr, explanation_en, explanation_fr
    [question_format], [is_active], [question_type], [media_url]

Only ``question_text_en`` and ``correct_answer`` are mandatory. ``question_format`` is inferred
like the backend does when absent: ``true_false`` when the English labels are TRUE / FALSE (or
there are no labels at all), otherwise ``two_choices``. UTF-8 with or without BOM; the delimiter
(``,`` ``;`` or tab) is sniffed from the header line.

Usage::

    python3 scripts/csv_to_bundle.py QUESTIONS.csv --slug my-event --name "My Event" -o events/my-event.json

    # events/api-masters.json was produced with:
    python3 scripts/csv_to_bundle.py "questions/API Masters Quiz Questions - quiz_questions.csv" \\
      --slug api-masters --name "API Masters" --status live \\
      --hero-en "Become THE Ultimate API Master!" --hero-fr "Devenez LE Maître des API !" \\
      --tagline-en "..." --tagline-fr "..." --description-en "..." --description-fr "..." \\
      --primary-color "#FC5607" --accent-color "#FF9A52" --question-order random \\
      --category-meta '{"REST API": {"name_fr": "API REST", "color": "#3B82F6", ...}}' \\
      -o events/api-masters.json

Category metadata (``--category-meta``) is a JSON object, inline or a file path, keyed by the
category name found in the CSV::

    {"REST API": {"name_fr": "API REST", "description": "...", "description_fr": "...", "color": "#3B82F6"}}

Its key order also sets the category order; categories not listed get a palette colour.
``--fr-nbsp`` applies French typography to every French field (plain space -> U+00A0 before
? ! : ; and around guillemets; no wording change). ``--fill-missing-fr`` copies the English text into every missing French field (the runtime falls
back to English anyway; this makes the fallback explicit and keeps the validator quiet).

The result is written first, then checked with scripts/validate_bundle.py (``--no-validate`` to skip). Exit codes:
0 ok, 1 invalid rows or a bundle that fails validation (nothing is written for invalid rows unless
``--skip-invalid``), 2 usage / unreadable input.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Optional

# Same palette as backend/app/services/csv_io.py (CATEGORY_PALETTE): brand orange first.
CATEGORY_PALETTE = ("#FC5607", "#7C5CFF", "#22D3EE", "#10B981", "#F59E0B", "#EC4899", "#3B82F6", "#84CC16")
KNOWN_COLUMNS = (
    "category", "difficulty", "question_text_en", "question_text_fr", "correct_answer",
    "green_label_en", "green_label_fr", "red_label_en", "red_label_fr", "explanation_en",
    "explanation_fr", "question_format", "is_active", "question_type", "media_url",
)
TRUE_FALSE_LABELS = {"green_label_en": "TRUE", "green_label_fr": "Vrai", "red_label_en": "FALSE", "red_label_fr": "Faux"}
TRUE_WORDS = {"true", "1", "yes", "y", "oui", "vrai"}
FALSE_WORDS = {"false", "0", "no", "n", "non", "faux"}
ANSWER_ALIASES = {"green": "green", "red": "red", "true": "green", "false": "red"}


class ConversionError(Exception):
    """Fatal problem with the input as a whole (unreadable file, missing columns...)."""


def normalize_header(value: str) -> str:
    return re.sub(r"[\s\-]+", "_", value.strip().lstrip("﻿").strip().lower())


def norm_text(text: Optional[str]) -> str:
    """Duplicate key: NFKC, collapsed whitespace, casefolded (same rule as the backend import)."""
    return " ".join(unicodedata.normalize("NFKC", text or "").split()).casefold()


def detect_delimiter(text: str) -> str:
    first_line = text.lstrip("﻿").split("\n", 1)[0]
    best, best_score = ",", -1
    for delimiter in (",", ";", "\t"):
        try:
            header = next(csv.reader([first_line], delimiter=delimiter))
        except (csv.Error, StopIteration):
            continue
        score = sum(1 for cell in header if normalize_header(cell) in KNOWN_COLUMNS)
        if score > best_score:
            best, best_score = delimiter, score
    return best


def read_rows(path: Path) -> list:
    """Return ``[(csv_row_number, {normalised_header: value})]``; row 1 is the header."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ConversionError(f"cannot read {path}: {exc}") from exc
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ConversionError("the file is not valid UTF-8 (in your spreadsheet: Save as > CSV UTF-8)") from exc
    if not text.strip():
        raise ConversionError("the file is empty")
    delimiter = detect_delimiter(text)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        header = [normalize_header(h) for h in next(reader)]
    except StopIteration as exc:
        raise ConversionError("the file has no header line") from exc
    missing = [c for c in ("question_text_en", "correct_answer") if c not in header]
    if missing:
        raise ConversionError(f"missing required column(s): {', '.join(missing)} (found: {', '.join(header)})")
    rows = []
    for number, cells in enumerate(reader, start=2):
        if not any(cell.strip() for cell in cells):
            continue
        rows.append((number, {h: (cells[i] if i < len(cells) else "") for i, h in enumerate(header)}))
    return rows


def clean(value: Any) -> Optional[str]:
    text = (value or "").strip() if isinstance(value, str) else None
    return text or None


def infer_format(green_en: Optional[str], red_en: Optional[str]) -> str:
    if not green_en and not red_en:
        return "true_false"
    if (green_en or "").strip().upper() == "TRUE" and (red_en or "").strip().upper() == "FALSE":
        return "true_false"
    return "two_choices"


def parse_bool(value: Optional[str], default: bool = True) -> bool:
    if value is None:
        return default
    word = value.strip().lower()
    if word in TRUE_WORDS:
        return True
    if word in FALSE_WORDS:
        return False
    raise ValueError(f"is_active must be true/false, got {value!r}")


def fr_nbsp(text: Optional[str]) -> Optional[str]:
    """French typography: a non-breaking space before ? ! : ; %, around guillemets and in 12 345 numbers.

    Only swaps U+0020 for U+00A0 (nothing is added or removed), so the text reads the same but a
    phone never wraps a lone "?" or "»" onto the next line.
    """
    if not text:
        return text
    text = re.sub(r"(?<=\S) +(?=[?!:;»%€])", "\u00a0", text)
    text = re.sub(r"« +", "«\u00a0", text)
    text = re.sub(r"(?<=\d) (?=\d{3}(?!\d))", "\u00a0", text)
    return text


def convert_row(row: dict, fill_fr: bool, stats: dict, nbsp: bool = False) -> dict:
    """One CSV row -> bundle question (without the category key, added by the caller). Raises ValueError."""
    en = clean(row.get("question_text_en"))
    if not en:
        raise ValueError("question_text_en is empty")
    fr = clean(row.get("question_text_fr"))
    answer = ANSWER_ALIASES.get((row.get("correct_answer") or "").strip().lower())
    if answer is None:
        raise ValueError(f"correct_answer must be green or red, got {row.get('correct_answer')!r}")
    try:
        difficulty = int((row.get("difficulty") or "1").strip() or 1)
    except ValueError:
        raise ValueError(f"difficulty must be an integer, got {row.get('difficulty')!r}") from None
    if not 1 <= difficulty <= 5:
        raise ValueError(f"difficulty must be between 1 and 5, got {difficulty}")

    labels = {k: clean(row.get(k)) for k in TRUE_FALSE_LABELS}
    fmt = clean(row.get("question_format"))
    fmt = fmt.lower() if fmt else infer_format(labels["green_label_en"], labels["red_label_en"])
    if fmt not in ("true_false", "two_choices"):
        raise ValueError(f"question_format must be true_false or two_choices, got {fmt!r}")
    if fmt == "true_false":
        labels = dict(TRUE_FALSE_LABELS)
    else:
        if not labels["green_label_en"] or not labels["red_label_en"]:
            raise ValueError("two_choices questions need green_label_en and red_label_en")
        if labels["green_label_en"].casefold() == labels["red_label_en"].casefold():
            raise ValueError("the two answer labels must differ")

    explanation_en, explanation_fr = clean(row.get("explanation_en")), clean(row.get("explanation_fr"))
    if fill_fr:
        for key, source in (("green_label_fr", "green_label_en"), ("red_label_fr", "red_label_en")):
            if not labels[key] and labels[source]:
                labels[key] = labels[source]
                stats["fr_filled"] += 1
        if not fr:
            fr = en
            stats["fr_filled"] += 1
        if not explanation_fr and explanation_en:
            explanation_fr = explanation_en
            stats["fr_filled"] += 1

    if nbsp:
        fr, explanation_fr = fr_nbsp(fr), fr_nbsp(explanation_fr)
        labels["green_label_fr"], labels["red_label_fr"] = fr_nbsp(labels["green_label_fr"]), fr_nbsp(labels["red_label_fr"])

    question: dict = {
        "question_format": fmt,
        "difficulty": difficulty,
        "question_text_en": en,
        "question_text_fr": fr,
        "correct_answer": answer,
        **labels,
        "explanation_en": explanation_en,
        "explanation_fr": explanation_fr,
        "is_active": parse_bool(clean(row.get("is_active"))),
    }
    question_type = clean(row.get("question_type"))
    if question_type and question_type != "text":
        question["question_type"] = question_type
    media_url = clean(row.get("media_url"))
    if media_url:
        question["media_url"] = media_url
    return question


def load_category_meta(arg: Optional[str]) -> dict:
    if not arg:
        return {}
    text = arg if arg.lstrip().startswith("{") else Path(arg).read_text(encoding="utf-8")
    try:
        meta = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConversionError(f"--category-meta is not valid JSON: {exc}") from exc
    if not isinstance(meta, dict) or not all(isinstance(v, dict) for v in meta.values()):
        raise ConversionError("--category-meta must be an object of objects keyed by category name")
    return meta


def build_categories(order: list, meta: dict, fill_fr: bool, warnings: list, nbsp: bool = False) -> list:
    meta_by_norm = {norm_text(k): v for k, v in meta.items()}
    used = {norm_text(name) for name in order}
    for key in meta:
        if norm_text(key) not in used:
            warnings.append(f"--category-meta lists '{key}' but no CSV row uses it (ignored)")
    categories = []
    for index, name in enumerate(order):
        m = meta_by_norm.get(norm_text(name), {})
        name_fr, description, description_fr = clean(m.get("name_fr")), clean(m.get("description")), clean(m.get("description_fr"))
        if fill_fr:
            name_fr = name_fr or name
            description_fr = description_fr or description
        categories.append({
            "name": name,
            "name_fr": fr_nbsp(name_fr) if nbsp else name_fr,
            "description": description,
            "description_fr": fr_nbsp(description_fr) if nbsp else description_fr,
            "color": (m.get("color") or CATEGORY_PALETTE[index % len(CATEGORY_PALETTE)]).upper(),
            "is_active": bool(m.get("is_active", True)),
        })
    return categories


def build_bundle(args: argparse.Namespace, rows: list) -> tuple:
    """Return ``(bundle, report)`` where report carries counters and messages."""
    report = {"rows": len(rows), "skipped_duplicates": [], "errors": [], "warnings": [], "fr_filled": 0}
    meta = load_category_meta(args.category_meta)

    questions, seen, canonical = [], {}, {}
    order = [name for name in meta]  # meta order wins, filtered to used categories below
    for number, row in rows:
        try:
            question = convert_row(row, args.fill_missing_fr, report, args.fr_nbsp)
        except ValueError as exc:
            report["errors"].append(f"row {number}: {exc}")
            continue
        key = norm_text(question["question_text_en"])
        if key in seen:
            report["skipped_duplicates"].append(f"row {number} duplicates row {seen[key]}: {question['question_text_en'][:60]!r}")
            continue
        seen[key] = number
        category = clean(row.get("category"))
        if category:
            canonical.setdefault(norm_text(category), category)
            name = canonical[norm_text(category)]
            # prefer the spelling used in --category-meta when it matches case-insensitively
            for meta_key in meta:
                if norm_text(meta_key) == norm_text(category):
                    name = canonical[norm_text(category)] = meta_key
            question = {"category": name, **question}
        else:
            question = {"category": None, **question}
        questions.append(question)

    used_names = []
    for q in questions:
        if q["category"] and q["category"] not in used_names:
            used_names.append(q["category"])
    ordered = [n for n in order if n in used_names] + [n for n in used_names if n not in order]
    categories = build_categories(ordered, meta, args.fill_missing_fr, report["warnings"], args.fr_nbsp)
    if any(q["category"] is None for q in questions):
        report["warnings"].append("some rows have no category: they are imported uncategorised")

    if args.sort:
        rank = {name: i for i, name in enumerate(ordered)}
        questions.sort(key=lambda q: (rank.get(q["category"], len(rank)), q["difficulty"]))

    distribution: Optional[dict] = None
    if args.distribution == "equal":
        weight = max(1, 100 // max(1, len(categories)))
        distribution = {c["name"]: weight for c in categories}
    elif args.distribution not in (None, "none"):
        try:
            distribution = json.loads(args.distribution)
        except json.JSONDecodeError as exc:
            raise ConversionError(f"--distribution must be 'none', 'equal' or a JSON object: {exc}") from exc

    languages = [x.strip() for x in args.languages.split(",") if x.strip()]
    event_fr = {"hero": args.hero_fr, "tagline": args.tagline_fr, "description": args.description_fr}
    if args.fill_missing_fr:
        event_fr = {k: event_fr[k] or getattr(args, {"hero": "hero_en", "tagline": "tagline_en", "description": "description_en"}[k]) for k in event_fr}
    if args.fr_nbsp:
        event_fr = {k: fr_nbsp(v) for k, v in event_fr.items()}
    bundle = {
        "format": "gravitee-quiz-event",
        "version": 1,
        "event": {
            "slug": args.slug,
            "name": args.name,
            "game_title": args.game_title or args.name,
            "status": args.status,
            "hero_title_en": args.hero_en,
            "hero_title_fr": event_fr["hero"],
            "tagline_en": args.tagline_en,
            "tagline_fr": event_fr["tagline"],
            "description_en": args.description_en,
            "description_fr": event_fr["description"],
            "location": args.location,
            "starts_on": args.starts_on,
            "ends_on": args.ends_on,
            "languages": languages,
            "default_language": args.default_language,
            "branding": {
                "primary_color": args.primary_color.upper(),
                "accent_color": args.accent_color.upper(),
                "background_style": args.background_style,
                "logo_url": args.logo_url,
                "default_theme": args.theme,
            },
            "settings": {
                "questions_per_game": args.questions_per_game,
                "timer_seconds": args.timer_seconds,
                "points_correct": args.points_correct,
                "points_wrong": args.points_wrong,
                "time_bonus_max": args.time_bonus_max,
                "category_distribution": distribution,
                "question_order": args.question_order,
                "collect_phone": args.collect_phone,
                "consent_text_en": args.consent_en,
                "consent_text_fr": args.consent_fr,
            },
        },
        "categories": categories,
        "questions": questions,
    }
    return bundle, report


def make_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Convert a legacy question CSV into a gravitee-quiz-event bundle (JSON).",
        epilog="See the module docstring (python3 -c 'import csv_to_bundle; help(csv_to_bundle)') for the CSV columns.",
    )
    ap.add_argument("csv", type=Path, help="question CSV (UTF-8)")
    ap.add_argument("-o", "--output", help="output JSON file (default: stdout)")
    g = ap.add_argument_group("event")
    g.add_argument("--slug", required=True, help="URL slug, e.g. world-ai-summit-2026")
    g.add_argument("--name", required=True, help="event name")
    g.add_argument("--game-title", help="brand shown in the UI (default: --name)")
    g.add_argument("--status", default="draft", choices=("draft", "live", "closed"))
    g.add_argument("--hero-en"), g.add_argument("--hero-fr")
    g.add_argument("--tagline-en"), g.add_argument("--tagline-fr")
    g.add_argument("--description-en"), g.add_argument("--description-fr")
    g.add_argument("--location"), g.add_argument("--starts-on", metavar="YYYY-MM-DD"), g.add_argument("--ends-on", metavar="YYYY-MM-DD")
    g.add_argument("--languages", default="en,fr", help="comma separated subset of en,fr (default en,fr)")
    g.add_argument("--default-language", default="en", choices=("en", "fr"))
    b = ap.add_argument_group("branding")
    b.add_argument("--primary-color", default="#FC5607"), b.add_argument("--accent-color", default="#FF9A52")
    b.add_argument("--background-style", default="aurora", choices=("aurora", "grid", "plain"))
    b.add_argument("--theme", default="dark", choices=("dark", "light", "system"))
    b.add_argument("--logo-url")
    r = ap.add_argument_group("rules")
    r.add_argument("--questions-per-game", type=int, default=15)
    r.add_argument("--timer-seconds", type=int, default=20)
    r.add_argument("--points-correct", type=int, default=100)
    r.add_argument("--points-wrong", type=int, default=0)
    r.add_argument("--time-bonus-max", type=int, default=50)
    r.add_argument("--question-order", default="random", choices=("random", "easy_to_hard"))
    r.add_argument("--collect-phone", default="optional", choices=("hidden", "optional", "required"))
    r.add_argument("--consent-en"), r.add_argument("--consent-fr")
    r.add_argument("--distribution", default="none", help="'none' (equal split, default), 'equal' (explicit equal weights) or a JSON object {category: weight}")
    c = ap.add_argument_group("conversion")
    c.add_argument("--category-meta", help="JSON (inline or file) with name_fr / description / description_fr / color per category")
    c.add_argument("--fill-missing-fr", action="store_true", help="copy the English text into every missing French field")
    c.add_argument("--fr-nbsp", action="store_true", help="French typography: swap plain spaces for non-breaking ones before ? ! : ; %% and around guillemets (no wording change)")
    c.add_argument("--sort", action="store_true", help="order questions by category then difficulty (default: CSV order)")
    c.add_argument("--skip-invalid", action="store_true", help="write the bundle even if some CSV rows are invalid (they are dropped)")
    c.add_argument("--no-validate", action="store_true", help="do not run validate_bundle.py on the result")
    c.add_argument("--strict", action="store_true", help="fail on validator warnings too")
    return ap


def run_validator(bundle: dict, strict: bool) -> bool:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import validate_bundle  # type: ignore
    except ImportError:
        print("validator: scripts/validate_bundle.py not found, skipped", file=sys.stderr)
        return True
    result = validate_bundle.validate(bundle)
    style = validate_bundle.Style(sys.stderr.isatty())
    validate_bundle.print_findings(result, style, show_all=False, per_code=3, out=sys.stderr)
    ok = result.ok(strict=strict)
    print(f"validator: {len(result.errors)} error(s), {len(result.warnings)} warning(s) -> {'OK' if ok else 'FAILED'}", file=sys.stderr)
    return ok


def main(argv: Optional[list] = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        rows = read_rows(args.csv)
        bundle, report = build_bundle(args, rows)
    except ConversionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for message in report["warnings"]:
        print(f"warning: {message}", file=sys.stderr)
    for message in report["skipped_duplicates"]:
        print(f"skipped duplicate: {message}", file=sys.stderr)
    for message in report["errors"]:
        print(f"invalid: {message}", file=sys.stderr)
    if report["errors"] and not args.skip_invalid:
        print(f"{len(report['errors'])} invalid row(s): nothing written (fix the CSV or use --skip-invalid)", file=sys.stderr)
        return 1

    output = json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
    if args.output and args.output != "-":
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    print(
        f"{report['rows']} CSV row(s) -> {len(bundle['questions'])} question(s) in {len(bundle['categories'])} categor"
        f"{'y' if len(bundle['categories']) == 1 else 'ies'}; {len(report['skipped_duplicates'])} duplicate(s) skipped; "
        f"{len(report['errors'])} invalid; {report['fr_filled']} French field(s) filled from English"
        + (f" -> {args.output}" if args.output and args.output != "-" else ""),
        file=sys.stderr,
    )
    if not args.no_validate and not run_validator(bundle, args.strict):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
