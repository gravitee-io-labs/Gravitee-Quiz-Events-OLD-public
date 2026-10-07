"""
CSV import / export for questions and the leads export of results.

Question CSV
------------
Columns are the legacy ones (``questions/API Masters Quiz Questions - quiz_questions.csv``) plus
``question_format`` and ``is_active``::

    category, difficulty, question_text_en, question_text_fr, correct_answer,
    green_label_en, green_label_fr, red_label_en, red_label_fr,
    explanation_en, explanation_fr, question_format, is_active

* Import needs only ``question_text_en`` and ``correct_answer``; every other column is optional.
  ``question_format`` is inferred like the 0002 migration when absent or blank (English labels
  TRUE/FALSE => ``true_false``, no labels at all => ``true_false``, anything else => ``two_choices``).
* UTF-8 with or without BOM; the delimiter (``,`` ``;`` or tab) is sniffed from the header line.
* Every row is validated with the same rules as the JSON API (``QuestionCreate``). Errors carry the
  spreadsheet row number: the header is row 1, so the first question is row 2 (blank lines count).
* Valid rows are imported even when other rows are rejected; re-uploading a fixed file is safe
  because duplicates (same normalised English text, in the event or earlier in the file) are skipped.
* Missing categories are created (matched case-insensitively by name).

Leads CSV
---------
``leads_to_csv`` writes a UTF-8 BOM (Excel opens accents correctly) and neutralises spreadsheet
formula injection: any text cell starting with ``= + - @ TAB CR`` is prefixed with a single quote.
The one exception is a plain phone number (``+33 6 12 34 56 78``, see ``PHONE_NUMBER``): it holds nothing
but digits, spaces and ``+ ( ) . -``, so it cannot call a function or reach another cell, and prefixing it
would corrupt every international number of the export.

Question export
---------------
``questions_to_csv`` neutralises its text cells with the same helper (an admin can paste a hostile cell from
a spreadsheet, or an imported CSV can carry one) but stays round-trippable: ``neutralize_cell(...,
reversible=True)`` also guards a text that already starts with quote(s) followed by a dangerous character, and
the import strips exactly ONE leading quote in front of such a character (``unguard_cell``), so
export -> import gives back the very same text, whatever it is.
"""
import csv
import io
import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Optional

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Category, Event, Question
from app.schemas import (
    CategoryName,
    CsvImportError,
    CsvImportResult,
    QuestionCreate,
    infer_question_format,
)

MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_CSV_ROWS = 5000

QUESTION_CSV_COLUMNS: tuple[str, ...] = (
    "category",
    "difficulty",
    "question_text_en",
    "question_text_fr",
    "correct_answer",
    "green_label_en",
    "green_label_fr",
    "red_label_en",
    "red_label_fr",
    "explanation_en",
    "explanation_fr",
    "question_format",
    "is_active",
)
REQUIRED_QUESTION_COLUMNS: tuple[str, ...] = ("question_text_en", "correct_answer")
LEADS_CSV_COLUMNS: tuple[str, ...] = (
    "rank",
    "first_name",
    "last_name",
    "email",
    "phone",
    "consent_at",
    "score",
    "correct",
    "wrong",
    "completed_at",
)

# Colours handed to categories created by an import (cycled, brand orange first).
CATEGORY_PALETTE: tuple[str, ...] = (
    "#FC5607",
    "#7C5CFF",
    "#22D3EE",
    "#10B981",
    "#F59E0B",
    "#EC4899",
    "#3B82F6",
    "#84CC16",
)

_DELIMITERS = (",", ";", "\t")
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
# A plain phone number as stored for a player: optional "+", then a digit, then digits / spaces / ( ) . - only.
# No letter, no "|", no "!", no "," : nothing a spreadsheet could execute (``fullmatch``: a trailing newline is no phone).
PHONE_NUMBER = re.compile(r"\+?[0-9][0-9 ().\-]{4,}")
# a guard quote (one or more quotes) followed by a dangerous first character
_GUARDED = re.compile(r"'+[=+\-@\t\r]")
_TRUE_WORDS = {"true", "1", "yes", "y", "oui", "vrai"}
_FALSE_WORDS = {"false", "0", "no", "n", "non", "faux"}
_CATEGORY_NAME = TypeAdapter(CategoryName)


class CsvFormatError(ValueError):
    """The file as a whole cannot be used (not UTF-8, no header, missing columns, too big...)."""


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
def normalize_header(value: str) -> str:
    return re.sub(r"[\s\-]+", "_", value.strip().lstrip("﻿").strip().lower())


def normalize_question_text(text: Optional[str]) -> str:
    """Duplicate-detection key: Unicode NFKC, collapsed whitespace, case-folded."""
    return " ".join(unicodedata.normalize("NFKC", text or "").split()).casefold()


def normalize_category_name(name: Optional[str]) -> str:
    return normalize_question_text(name)


def neutralize_cell(value: Any, *, reversible: bool = False) -> Any:
    """Defuse CSV / formula injection: prefix text cells that a spreadsheet would execute.

    A text starting with ``= + - @ TAB CR`` gets a leading ``'``, except a plain phone number (``PHONE_NUMBER``:
    ``+33 6 12 34 56 78`` must reach the sales team intact; it cannot execute anything).

    ``reversible`` (the question export): a text that already starts with quote(s) and then a dangerous
    character is guarded too, so that ``unguard_cell`` (one quote off, only before a dangerous character) gives
    back exactly the original text for ANY text.
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        return value
    if value.startswith("+") and PHONE_NUMBER.fullmatch(value):
        return value
    if value.startswith(_FORMULA_PREFIXES) or (reversible and _GUARDED.match(value)):
        return "'" + value
    return value


def unguard_cell(value: str) -> str:
    """Undo ``neutralize_cell(..., reversible=True)`` on import: drop exactly one leading quote when what
    follows the quote(s) is a dangerous character (``'=x`` -> ``=x``, ``''=x`` -> ``'=x``, ``'hello`` untouched)."""
    return value[1:] if _GUARDED.match(value) else value


def decode_csv_bytes(raw: bytes) -> str:
    """UTF-8 (with or without BOM) -> text, or ``CsvFormatError``."""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CsvFormatError(
            "The file is not valid UTF-8. In your spreadsheet use 'Save as' > 'CSV UTF-8'."
        ) from exc


def detect_delimiter(text: str) -> str:
    """Pick ``,`` ``;`` or tab: the one that makes the header line look most like our columns."""
    first_line = text.lstrip("﻿").split("\n", 1)[0]
    best, best_score = ",", (-1, -1)
    for delimiter in _DELIMITERS:
        try:
            header = next(csv.reader([first_line], delimiter=delimiter))
        except (csv.Error, StopIteration):
            continue
        known = sum(1 for cell in header if normalize_header(cell) in QUESTION_CSV_COLUMNS)
        score = (known, len(header))
        if score > best_score:
            best, best_score = delimiter, score
    return best


def _parse_bool(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in _TRUE_WORDS:
        return True
    if lowered in _FALSE_WORDS:
        return False
    raise ValueError("is_active must be true or false")


def _error_message(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        message = err["msg"].removeprefix("Value error, ")
        loc = ".".join(str(p) for p in err["loc"] if p != "__root__")
        parts.append(f"{loc}: {message}" if loc else message)
    return "; ".join(parts)


# ---------------------------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------------------------
@dataclass
class ParsedRow:
    row: int
    category: Optional[str]
    question: QuestionCreate


@dataclass
class ParseResult:
    rows: list[ParsedRow] = field(default_factory=list)
    errors: list[CsvImportError] = field(default_factory=list)
    delimiter: str = ","
    columns: list[str] = field(default_factory=list)


def _convert_row(row_number: int, cells: dict[str, str]) -> ParsedRow:
    """One CSV record -> validated question. Raises ``ValueError`` with a user-facing message."""
    problems: list[str] = []
    if any("\x00" in value for value in cells.values()):  # PostgreSQL text cannot hold NUL
        raise ValueError("the row contains a NUL (0x00) character")

    def cell(name: str) -> str:
        return (cells.get(name) or "").strip()

    def text(name: str) -> str:
        """A free text cell: the export guards formula-looking text with a quote, take it off again."""
        return unguard_cell(cell(name))

    # category
    category = text("category") or None
    if category is not None:
        try:
            category = _CATEGORY_NAME.validate_python(category)
        except ValidationError as exc:
            problems.append("category: " + _error_message(exc))
            category = None

    # difficulty
    difficulty = 1
    if cell("difficulty"):
        try:
            difficulty = int(cell("difficulty"))
        except ValueError:
            problems.append("difficulty: must be an integer between 1 and 5")

    # is_active
    is_active = True
    if cell("is_active"):
        try:
            is_active = _parse_bool(cell("is_active"))
        except ValueError as exc:
            problems.append(str(exc))

    # format
    fmt = cell("question_format").lower().replace("-", "_").replace(" ", "_")
    if fmt not in ("", "true_false", "two_choices"):
        problems.append("question_format: must be 'true_false' or 'two_choices'")
        fmt = ""
    if not fmt:
        has_labels = bool(cell("green_label_en") or cell("red_label_en"))
        fmt = infer_question_format(cell("green_label_en"), cell("red_label_en")) if has_labels else "true_false"

    # correct answer
    answer = cell("correct_answer").lower()
    if answer not in ("green", "red"):
        if fmt == "true_false" and answer in ("true", "vrai"):
            answer = "green"
        elif fmt == "true_false" and answer in ("false", "faux"):
            answer = "red"
        else:
            problems.append("correct_answer: must be 'green' or 'red'")
            answer = ""

    if problems:
        raise ValueError("; ".join(problems))

    payload: dict[str, Any] = {
        "question_format": fmt,
        "difficulty": difficulty,
        "question_text_en": text("question_text_en"),
        "question_text_fr": text("question_text_fr"),
        "correct_answer": answer,
        "green_label_en": text("green_label_en"),
        "green_label_fr": text("green_label_fr"),
        "red_label_en": text("red_label_en"),
        "red_label_fr": text("red_label_fr"),
        "explanation_en": text("explanation_en"),
        "explanation_fr": text("explanation_fr"),
        "is_active": is_active,
    }
    try:
        question = QuestionCreate.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(_error_message(exc)) from exc
    return ParsedRow(row=row_number, category=category, question=question)


def parse_questions_csv(raw: bytes) -> ParseResult:
    """Parse + validate every row. File-level problems raise ``CsvFormatError``; row problems are
    collected in ``ParseResult.errors`` (``row`` = spreadsheet row, header = 1)."""
    if len(raw) > MAX_CSV_BYTES:
        raise CsvFormatError(f"The file is too large (max {MAX_CSV_BYTES // (1024 * 1024)} MB)")
    text = decode_csv_bytes(raw)
    if not text.strip():
        raise CsvFormatError("The file is empty")

    delimiter = detect_delimiter(text)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    result = ParseResult(delimiter=delimiter)
    header: Optional[list[str]] = None
    index: dict[str, int] = {}
    record_number = 0
    data_rows = 0

    try:
        for record in reader:
            record_number += 1
            if header is None:
                if not any(cell.strip() for cell in record):
                    continue  # blank lines before the header
                header = [normalize_header(cell) for cell in record]
                for position, name in enumerate(header):
                    if name:
                        index.setdefault(name, position)
                missing = [c for c in REQUIRED_QUESTION_COLUMNS if c not in index]
                if missing:
                    raise CsvFormatError(
                        "Missing required column(s): " + ", ".join(missing)
                        + ". Expected a header row such as: " + ", ".join(QUESTION_CSV_COLUMNS[:6]) + ", ..."
                    )
                result.columns = [c for c in header if c]
                continue

            if not any(cell.strip() for cell in record):
                continue  # blank line / ",,,,,"
            data_rows += 1
            if data_rows > MAX_CSV_ROWS:
                raise CsvFormatError(f"Too many rows (max {MAX_CSV_ROWS} questions per file)")

            extra = [c for c in record[len(header):] if c.strip()]
            if extra:
                result.errors.append(
                    CsvImportError(
                        row=record_number,
                        message=(
                            f"the row has {len(record)} cells but the header has {len(header)} columns "
                            "(is a delimiter inside a text missing its quotes?)"
                        ),
                    )
                )
                continue
            cells = {name: record[pos] if pos < len(record) else "" for name, pos in index.items()}
            try:
                result.rows.append(_convert_row(record_number, cells))
            except ValueError as exc:
                result.errors.append(CsvImportError(row=record_number, message=str(exc)))
    except csv.Error as exc:
        raise CsvFormatError(f"The file is not a valid CSV (near line {reader.line_num}): {exc}") from exc

    if header is None:
        raise CsvFormatError("The file has no header row")
    return result


# ---------------------------------------------------------------------------------------------
# Import into an event
# ---------------------------------------------------------------------------------------------
def import_questions_csv(db: Session, event: Event, raw: bytes, dry_run: bool = False) -> CsvImportResult:
    """Validate ``raw`` and (unless ``dry_run``) create the questions + missing categories of ``event``.

    Commits once at the end. ``created`` counts the questions created (would be created in a dry run).
    """
    parsed = parse_questions_csv(raw)

    seen = {
        normalize_question_text(text)
        for text in db.scalars(select(Question.question_text_en).where(Question.event_id == event.id))
    }
    categories: dict[str, Category] = {
        normalize_category_name(c.name): c
        for c in db.scalars(select(Category).where(Category.event_id == event.id).order_by(Category.id))
    }

    created = skipped = categories_created = 0
    plan: list[tuple[ParsedRow, Optional[Category]]] = []
    new_categories: list[Category] = []
    for row in parsed.rows:
        key = normalize_question_text(row.question.question_text_en)
        if key in seen:
            skipped += 1
            continue
        seen.add(key)

        category: Optional[Category] = None
        if row.category:
            category_key = normalize_category_name(row.category)
            category = categories.get(category_key)
            if category is None:
                category = Category(
                    event_id=event.id,
                    name=row.category,
                    color=CATEGORY_PALETTE[len(categories) % len(CATEGORY_PALETTE)],
                    is_active=True,
                )
                categories[category_key] = category
                new_categories.append(category)
                categories_created += 1
        plan.append((row, category))
        created += 1

    if not dry_run and plan:
        db.add_all(new_categories)
        db.flush()
        db.add_all(
            Question(
                event_id=event.id,
                category_id=category.id if category is not None else None,
                **row.question.model_dump(exclude={"category_id"}),
            )
            for row, category in plan
        )
        db.commit()

    return CsvImportResult(
        created=created,
        skipped_duplicates=skipped,
        categories_created=categories_created,
        errors=parsed.errors,
        dry_run=dry_run,
    )


# ---------------------------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------------------------
def _csv_bytes(header: Sequence[str], rows: Iterable[Sequence[Any]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    return ("﻿" + buffer.getvalue()).encode("utf-8")  # BOM: Excel needs it for accents


def _cell(value: Any) -> Any:
    """A free text cell of the question export: formula-looking text is guarded (reversibly, see ``neutralize_cell``)."""
    return neutralize_cell(value, reversible=True)


def questions_to_csv(questions: Iterable[Question]) -> bytes:
    """Questions as CSV (UTF-8 BOM), ``QUESTION_CSV_COLUMNS``; re-importable as is. Free text cells are
    neutralised against formula injection and come back unchanged on import (``unguard_cell``)."""

    def rows():
        for q in questions:
            category = q.category.name if q.category is not None else ""
            yield [
                _cell(category),
                q.difficulty,
                _cell(q.question_text_en),
                _cell(q.question_text_fr),
                q.correct_answer,
                _cell(q.green_label_en),
                _cell(q.green_label_fr),
                _cell(q.red_label_en),
                _cell(q.red_label_fr),
                _cell(q.explanation_en),
                _cell(q.explanation_fr),
                q.question_format,
                "true" if q.is_active else "false",
            ]

    return _csv_bytes(QUESTION_CSV_COLUMNS, rows())


def leads_to_csv(rows: Iterable[Sequence[Any]]) -> bytes:
    """Leads export (``LEADS_CSV_COLUMNS``): UTF-8 BOM, formula-injection-safe text cells."""
    return _csv_bytes(LEADS_CSV_COLUMNS, ([neutralize_cell(value) for value in row] for row in rows))
