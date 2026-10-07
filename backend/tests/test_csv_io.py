"""Unit tests for app.services.csv_io (parsing, validation, import, export, injection safety)."""
import csv
import io
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.models import Category, Question
from app.services import csv_io
from app.services.csv_io import (
    CATEGORY_PALETTE,
    LEADS_CSV_COLUMNS,
    PHONE_NUMBER,
    QUESTION_CSV_COLUMNS,
    CsvFormatError,
    decode_csv_bytes,
    detect_delimiter,
    import_questions_csv,
    leads_to_csv,
    neutralize_cell,
    normalize_question_text,
    parse_questions_csv,
    questions_to_csv,
    unguard_cell,
)

FIXTURES = Path(__file__).parent / "fixtures"
HEADER = "category,difficulty,question_text_en,question_text_fr,correct_answer,green_label_en,green_label_fr,red_label_en,red_label_fr,explanation_en,explanation_fr"


def read_fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def rows_by_number(result):
    return {r.row: r for r in result.rows}


def errors_by_row(result):
    return {e.row: e.message for e in result.errors}


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "value,expected",
    [
        ("=1+1", "'=1+1"),
        ("-2+3", "'-2+3"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("\tcmd", "'\tcmd"),
        ("\rcmd", "'\rcmd"),
        ('=HYPERLINK("http://evil","x")', "'=HYPERLINK(\"http://evil\",\"x\")"),
        ("Ada", "Ada"),
        ("a=b", "a=b"),
        ("ada+tag@example.com", "ada+tag@example.com"),
        (" =padded", " =padded"),
        ("", ""),
        (None, ""),
        (12, 12),
        (0, 0),
        (3.5, 3.5),
    ],
)
def test_neutralize_cell(value, expected):
    assert neutralize_cell(value) == expected


@pytest.mark.parametrize(
    "phone",
    [
        "+33612345678",
        "+33 6 12 34 56 78",
        "+1 (415) 555-0132",
        "+44 20 7946 0958",
        "+49.30.901820",
        "+31-20-1234567",
        "+00000",
        "+1 234 5",
    ],
)
def test_a_plain_international_phone_number_is_not_prefixed(phone):
    assert neutralize_cell(phone) == phone


@pytest.mark.parametrize(
    "hostile",
    [
        "+SUM(1,1)",  # a function
        "+cmd|' /C calc'!A0",  # DDE
        "+33 6 12 34 56 78 foo",  # letters
        "+33 6 12 34 56 78\n",  # trailing newline (must not slip through a "$" anchor)
        "+33 6 12 34 56 78\t",
        "+33+1",  # a second plus: arithmetic
        "+33,1",
        "+33;1",
        "+1234|5678",
        "+12 3!A1",
        "+1=1",
        "+1",  # too short to be a phone number
        "+123",
        "+1234",
        "+",
        "+ 33 123456",  # a space right after the plus is not a number
        "++33612345678",
        "+٣٣٦١٢٣٤٥٦٧٨",  # non-ASCII digits
        "-33612345678",  # only '+' is exempted: '-' stays guarded
        "=33612345678",
        "@33612345678",
        "\t+33612345678",
        "+33612345678=1",
    ],
)
def test_everything_else_starting_with_a_plus_stays_guarded(hostile):
    assert neutralize_cell(hostile) == "'" + hostile


def test_only_the_plus_prefix_has_the_phone_exemption():
    assert neutralize_cell("33612345678") == "33612345678"  # digits first: never was a formula
    assert neutralize_cell("-33612345678") == "'-33612345678"


def test_normalize_question_text_ignores_case_whitespace_and_unicode_forms():
    assert normalize_question_text("  Is   REST\tstateless? ") == "is rest stateless?"
    assert normalize_question_text("Café") == normalize_question_text("Café")  # NFC vs NFD
    assert normalize_question_text("ＡＢＣ") == "abc"  # full width forms
    assert normalize_question_text(None) == ""


def test_decode_with_and_without_bom():
    assert decode_csv_bytes("﻿a;b".encode()) == "a;b"
    assert decode_csv_bytes("é".encode()) == "é"
    with pytest.raises(CsvFormatError, match="UTF-8"):
        decode_csv_bytes("é".encode("cp1252"))


@pytest.mark.parametrize(
    "header,expected",
    [
        ("category,difficulty,question_text_en", ","),
        ("category;difficulty;question_text_en", ";"),
        ("category\tdifficulty\tquestion_text_en", "\t"),
        ('"category";"difficulty";"question_text_en"', ";"),
        ("﻿category;difficulty;question_text_en", ";"),
        ("Category ; Difficulty ; Question Text EN", ";"),
        ("question_text_en", ","),
        ("", ","),
    ],
)
def test_detect_delimiter(header, expected):
    assert detect_delimiter(header + "\nrest") == expected


# ---------------------------------------------------------------------------------------------
# parsing: fixtures
# ---------------------------------------------------------------------------------------------
def test_parse_legacy_file():
    result = parse_questions_csv(read_fixture("legacy_questions.csv"))
    assert result.errors == []
    assert result.delimiter == ","
    assert len(result.rows) == 14
    assert [r.row for r in result.rows] == list(range(2, 16))  # header is row 1
    first = result.rows[0]
    assert first.category == "REST API"
    q = first.question
    assert (q.question_format, q.difficulty, q.correct_answer) == ("true_false", 1, "red")
    assert (q.green_label_en, q.green_label_fr, q.red_label_en, q.red_label_fr) == ("TRUE", "Vrai", "FALSE", "Faux")
    assert q.question_text_fr.startswith("Les API REST")
    assert {r.category for r in result.rows} == {"REST API", "Event API", "AI", "Gravitee"}
    assert all(r.question.question_format == "true_false" for r in result.rows)


def test_parse_english_only_file_without_fr_columns():
    result = parse_questions_csv(read_fixture("legacy_questions_en_only.csv"))
    assert result.errors == []
    assert len(result.rows) == 6
    q = result.rows[0].question
    assert q.question_text_fr is None
    assert (q.green_label_fr, q.red_label_fr) == ("Vrai", "Faux")
    assert q.explanation_fr is None


def test_parse_semicolon_bom_file_with_accents_formats_and_flags():
    result = parse_questions_csv(read_fixture("questions_semicolon_bom.csv"))
    assert result.errors == []
    assert result.delimiter == ";"
    rows = rows_by_number(result)
    assert sorted(rows) == [2, 3, 4]
    assert rows[2].category == "IA générative"
    assert rows[2].question.question_format == "true_false"
    assert rows[3].question.question_format == "two_choices"
    assert (rows[3].question.green_label_en, rows[3].question.green_label_fr) == ("LLM Proxy", "Proxy LLM")
    assert rows[3].question.correct_answer == "green"
    assert rows[4].question.is_active is False
    assert rows[4].question.question_format == "true_false"  # inferred from TRUE / FALSE
    assert rows[4].question.explanation_en is None
    assert rows[4].question.question_text_fr == "Les garde-fous s'exécutent avant le modèle"


def test_bom_does_not_change_the_result():
    raw = read_fixture("legacy_questions.csv")
    plain = parse_questions_csv(raw)
    with_bom = parse_questions_csv(b"\xef\xbb\xbf" + raw)
    assert [r.question.model_dump() for r in plain.rows] == [r.question.model_dump() for r in with_bom.rows]
    assert with_bom.rows[0].category == "REST API"  # BOM did not leak into the first header


def test_tab_delimited_file():
    raw = b"category\tquestion_text_en\tcorrect_answer\nAI\tIs it?\tgreen\n"
    result = parse_questions_csv(raw)
    assert result.delimiter == "\t"
    assert len(result.rows) == 1 and result.rows[0].question.correct_answer == "green"


def test_header_is_case_and_space_insensitive_and_unknown_columns_are_ignored():
    raw = b"Category , Question Text EN,Correct-Answer,whatever\nAI,Is it?,RED,ignored\n"
    result = parse_questions_csv(raw)
    assert result.errors == []
    row = result.rows[0]
    assert row.category == "AI" and row.question.correct_answer == "red" and row.question.difficulty == 1


# ---------------------------------------------------------------------------------------------
# parsing: file level problems
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("raw", [b"", b"   \n\n  ", "﻿".encode()])
def test_empty_file_is_rejected(raw):
    with pytest.raises(CsvFormatError, match="empty"):
        parse_questions_csv(raw)


def test_not_utf8_is_rejected():
    with pytest.raises(CsvFormatError, match="UTF-8"):
        parse_questions_csv("category,question_text_en,correct_answer\nAI,Café ?,green\n".encode("cp1252"))


def test_missing_required_columns_are_named():
    with pytest.raises(CsvFormatError) as exc:
        parse_questions_csv(b"category,difficulty\nAI,1\n")
    assert "question_text_en" in str(exc.value) and "correct_answer" in str(exc.value)


def test_header_only_file_yields_no_rows_and_no_errors():
    result = parse_questions_csv(b"question_text_en,correct_answer\n")
    assert result.rows == [] and result.errors == []


def test_file_with_only_blank_lines_before_a_header_is_ok_and_rows_count_blank_lines():
    result = parse_questions_csv(b"\n\nquestion_text_en,correct_answer\nIs it?,green\n,\nBad,maybe\n")
    # blank lines count: header is row 3, "Is it?" row 4, ",": row 5 (ignored), "Bad": row 6
    assert [r.row for r in result.rows] == [4]
    assert list(errors_by_row(result)) == [6]


def test_too_many_rows_and_too_large_files_are_rejected(monkeypatch):
    monkeypatch.setattr(csv_io, "MAX_CSV_ROWS", 2)
    raw = b"question_text_en,correct_answer\nA?,green\nB?,green\nC?,green\n"
    with pytest.raises(CsvFormatError, match="Too many rows"):
        parse_questions_csv(raw)
    monkeypatch.setattr(csv_io, "MAX_CSV_BYTES", 10)
    with pytest.raises(CsvFormatError, match="too large"):
        parse_questions_csv(raw)


def test_oversized_field_is_a_clean_format_error():
    huge = "x" * (csv.field_size_limit() + 10)
    with pytest.raises(CsvFormatError, match="not a valid CSV"):
        parse_questions_csv(f"question_text_en,correct_answer\n{huge},green\n".encode())


# ---------------------------------------------------------------------------------------------
# parsing: row validation
# ---------------------------------------------------------------------------------------------
def parse_rows(*lines: str, header: str = HEADER):
    return parse_questions_csv(("\n".join([header, *lines]) + "\n").encode())


def test_every_row_is_validated_and_errors_carry_spreadsheet_row_numbers():
    result = parse_rows(
        "AI,1,Valid one?,,green,TRUE,Vrai,FALSE,Faux,,",  # row 2 ok
        "AI,abc,Bad difficulty?,,green,TRUE,Vrai,FALSE,Faux,,",  # row 3
        "AI,9,Difficulty out of range?,,green,TRUE,Vrai,FALSE,Faux,,",  # row 4
        "AI,1,Bad answer?,,maybe,TRUE,Vrai,FALSE,Faux,,",  # row 5
        "AI,1,,,green,TRUE,Vrai,FALSE,Faux,,",  # row 6: no text
        "AI,1,Same labels?,,green,Yes,Oui,yes,Oui,,",  # row 7: two_choices with equal labels
        f"AI,1,Label too long?,,green,{'L' * 101},x,Other,y,,",  # row 8
        "AI,1,Another valid?,,red,Left,Gauche,Right,Droite,,",  # row 9 ok (two_choices inferred)
        f"{'C' * 101},1,Category too long?,,green,TRUE,Vrai,FALSE,Faux,,",  # row 10
        "AI,1,Too many cells?,,green,TRUE,Vrai,FALSE,Faux,,,extra,cells",  # row 11
    )
    assert [r.row for r in result.rows] == [2, 9]
    errors = errors_by_row(result)
    assert sorted(errors) == [3, 4, 5, 6, 7, 8, 10, 11]
    assert "difficulty" in errors[3]
    assert "difficulty" in errors[4]
    assert "correct_answer" in errors[5]
    assert "question_text_en" in errors[6]
    assert "different" in errors[7]
    assert "green_label_en" in errors[8]
    assert "category" in errors[10]
    assert "cells" in errors[11] and "quotes" in errors[11]
    assert all(not m.startswith("Value error") for m in errors.values())


def test_row_numbers_follow_records_not_physical_lines():
    raw = (
        b'category,question_text_en,correct_answer\r\n'
        b'AI,"A question\r\nspanning\r\nthree lines?",green\r\n'
        b"AI,Broken,maybe\r\n"
    )
    result = parse_questions_csv(raw)
    assert [r.row for r in result.rows] == [2]
    assert result.rows[0].question.question_text_en == "A question\r\nspanning\r\nthree lines?"
    assert list(errors_by_row(result)) == [3]  # record 3, even though it sits on physical line 5


def test_quoted_delimiters_quotes_and_unicode_survive():
    raw = ('category,question_text_en,question_text_fr,correct_answer,explanation_en\n'
           'AI,"Is a ""token"", a word; or not?","Un « token », est-ce un mot ?",red,"Commas, ""quotes"" and ; are fine"\n').encode()
    result = parse_questions_csv(raw)
    q = result.rows[0].question
    assert q.question_text_en == 'Is a "token", a word; or not?'
    assert q.question_text_fr == "Un « token », est-ce un mot ?"
    assert q.explanation_en == 'Commas, "quotes" and ; are fine'


@pytest.mark.parametrize(
    "answer,fmt,expected",
    [
        ("green", "true_false", "green"),
        ("RED", "true_false", "red"),
        (" Green ", "two_choices", "green"),
        ("TRUE", "true_false", "green"),
        ("false", "true_false", "red"),
        ("Vrai", "true_false", "green"),
        ("faux", "true_false", "red"),
    ],
)
def test_correct_answer_spellings(answer, fmt, expected):
    labels = "TRUE,Vrai,FALSE,Faux" if fmt == "true_false" else "Left,Gauche,Right,Droite"
    result = parse_rows(f"AI,1,Q?,,{answer},{labels},,")
    assert result.errors == [] and result.rows[0].question.correct_answer == expected


@pytest.mark.parametrize("answer", ["true", "false", "yes", "1", ""])
def test_true_false_words_are_not_valid_for_two_choices_questions(answer):
    result = parse_rows(f"AI,1,Q?,,{answer},Left,Gauche,Right,Droite,,")
    assert result.rows == [] and "correct_answer" in result.errors[0].message


@pytest.mark.parametrize(
    "value,expected", [("true", True), ("FALSE", False), ("1", True), ("0", False), ("oui", True), ("non", False), ("", True)]
)
def test_is_active_parsing(value, expected):
    raw = f"question_text_en,correct_answer,is_active\nQ?,green,{value}\n".encode()
    assert parse_questions_csv(raw).rows[0].question.is_active is expected


def test_is_active_garbage_is_a_row_error():
    result = parse_questions_csv(b"question_text_en,correct_answer,is_active\nQ?,green,maybe\n")
    assert result.rows == [] and "is_active" in result.errors[0].message


def test_explicit_question_format_wins_and_is_validated():
    # two_choices forced on TRUE/FALSE labels is allowed (the labels are kept)
    raw = b"question_text_en,correct_answer,green_label_en,red_label_en,question_format\nQ?,green,TRUE,FALSE,two_choices\nR?,green,TRUE,FALSE,nonsense\n"
    result = parse_questions_csv(raw)
    assert result.rows[0].question.question_format == "two_choices"
    assert "question_format" in errors_by_row(result)[3]
    # true_false forced on other labels: labels are overwritten with TRUE/FALSE
    raw = b"question_text_en,correct_answer,green_label_en,red_label_en,question_format\nQ?,green,Left,Right,true_false\n"
    q = parse_questions_csv(raw).rows[0].question
    assert (q.green_label_en, q.red_label_en) == ("TRUE", "FALSE")


def test_missing_labels_default_to_true_false_and_missing_french_label_falls_back_to_english():
    result = parse_questions_csv(b"question_text_en,correct_answer\nQ?,red\n")
    q = result.rows[0].question
    assert q.question_format == "true_false" and (q.green_label_en, q.red_label_fr) == ("TRUE", "Faux")
    result = parse_questions_csv(b"question_text_en,correct_answer,green_label_en,red_label_en\nQ?,red,Left,Right\n")
    q = result.rows[0].question
    assert q.question_format == "two_choices" and (q.green_label_fr, q.red_label_fr) == ("Left", "Right")


def test_whitespace_is_stripped_and_blank_optional_cells_become_null():
    result = parse_rows("  AI  ,  2 ,  Spaced?  ,   ,green,TRUE,Vrai,FALSE,Faux,   ,  ")
    row = result.rows[0]
    assert row.category == "AI" and row.question.difficulty == 2
    assert row.question.question_text_en == "Spaced?"
    assert row.question.question_text_fr is None and row.question.explanation_en is None


def test_blank_category_means_uncategorised():
    result = parse_rows(",1,Q?,,green,TRUE,Vrai,FALSE,Faux,,")
    assert result.rows[0].category is None


def test_short_rows_are_padded_with_blanks():
    result = parse_questions_csv(b"category,difficulty,question_text_en,correct_answer,explanation_en\nAI,2,Q?,green\n")
    assert result.errors == [] and result.rows[0].question.explanation_en is None


def test_formula_like_cells_are_stored_verbatim_on_import():
    result = parse_questions_csv(b'question_text_en,correct_answer\n"=1+1 is two?",green\n')
    assert result.rows[0].question.question_text_en == "=1+1 is two?"


# ---------------------------------------------------------------------------------------------
# import into an event
# ---------------------------------------------------------------------------------------------
def counts(db, event):
    return (
        db.scalar(select(func.count(Question.id)).where(Question.event_id == event.id)),
        db.scalar(select(func.count(Category.id)).where(Category.event_id == event.id)),
    )


def test_import_creates_questions_and_categories(db, make_event):
    event = make_event()
    result = import_questions_csv(db, event, read_fixture("legacy_questions.csv"))
    assert (result.created, result.skipped_duplicates, result.categories_created) == (14, 0, 4)
    assert result.errors == [] and result.dry_run is False
    assert counts(db, event) == (14, 4)
    names = {c.name for c in db.scalars(select(Category).where(Category.event_id == event.id))}
    assert names == {"REST API", "Event API", "AI", "Gravitee"}
    q = db.scalars(select(Question).where(Question.event_id == event.id).order_by(Question.id)).first()
    assert q.category.name == "REST API" and q.question_format == "true_false" and q.is_active is True


def test_new_categories_get_distinct_palette_colours(db, make_event):
    event = make_event()
    import_questions_csv(db, event, read_fixture("legacy_questions.csv"))
    colours = [c.color for c in db.scalars(select(Category).where(Category.event_id == event.id).order_by(Category.id))]
    assert colours == list(CATEGORY_PALETTE[:4])


def test_dry_run_validates_and_counts_but_writes_nothing(db, make_event):
    event = make_event()
    result = import_questions_csv(db, event, read_fixture("legacy_questions.csv"), dry_run=True)
    assert (result.created, result.categories_created, result.dry_run) == (14, 4, True)
    assert counts(db, event) == (0, 0)
    # and the same file imported for real afterwards gives the very same numbers
    real = import_questions_csv(db, event, read_fixture("legacy_questions.csv"))
    assert (real.created, real.categories_created) == (14, 4)


def test_reimporting_the_same_file_skips_every_duplicate(db, make_event):
    event = make_event()
    import_questions_csv(db, event, read_fixture("legacy_questions.csv"))
    again = import_questions_csv(db, event, read_fixture("legacy_questions.csv"))
    assert (again.created, again.skipped_duplicates, again.categories_created) == (0, 14, 0)
    assert counts(db, event) == (14, 4)


def test_duplicates_are_detected_by_normalised_english_text_in_db_and_in_file(db, make_event, make_category, make_question):
    event = make_event()
    category = make_category(event, name="Existing")
    make_question(event, category, question_text_en="Is REST stateless?")
    raw = (
        b"category,question_text_en,correct_answer\n"
        b"Existing,  is rest   STATELESS? ,green\n"  # dup of the DB question
        b"Existing,Brand new one?,green\n"
        b"Existing,brand NEW one?,red\n"  # dup of the previous row of the same file
        b"existing,Another one?,red\n"  # category matched case-insensitively
    )
    result = import_questions_csv(db, event, raw)
    assert (result.created, result.skipped_duplicates, result.categories_created) == (2, 2, 0)
    assert counts(db, event) == (3, 1)


def test_same_text_in_another_event_is_not_a_duplicate(db, make_event, make_question):
    other, event = make_event(), make_event()
    make_question(other, question_text_en="Shared question?")
    result = import_questions_csv(db, event, b"question_text_en,correct_answer\nShared question?,green\n")
    assert result.created == 1 and result.skipped_duplicates == 0


def test_categories_only_used_by_skipped_rows_are_not_created(db, make_event, make_question):
    event = make_event()
    make_question(event, question_text_en="Already there?")
    result = import_questions_csv(db, event, b"category,question_text_en,correct_answer\nGhost,Already there?,green\n")
    assert (result.created, result.skipped_duplicates, result.categories_created) == (0, 1, 0)
    assert counts(db, event) == (1, 0)


def test_valid_rows_are_imported_even_when_other_rows_are_rejected(db, make_event):
    event = make_event()
    raw = b"category,difficulty,question_text_en,correct_answer\nAI,1,Good?,green\nAI,x,Bad?,green\nAI,2,Also good?,red\n"
    result = import_questions_csv(db, event, raw)
    assert (result.created, [(e.row, e.message[:10]) for e in result.errors]) == (2, [(3, "difficulty")])
    assert counts(db, event) == (2, 1)
    # fixing the file and uploading it again only adds the repaired row
    fixed = raw.replace(b"AI,x,Bad?", b"AI,3,Bad?")
    again = import_questions_csv(db, event, fixed)
    assert (again.created, again.skipped_duplicates, again.errors) == (1, 2, [])


def test_import_of_an_unusable_file_changes_nothing(db, make_event):
    event = make_event()
    with pytest.raises(CsvFormatError):
        import_questions_csv(db, event, b"nope,nada\n1,2\n")
    assert counts(db, event) == (0, 0)


def test_import_with_only_invalid_rows_creates_nothing(db, make_event):
    event = make_event()
    result = import_questions_csv(db, event, b"category,question_text_en,correct_answer\nAI,Q?,maybe\n")
    assert (result.created, result.categories_created, len(result.errors)) == (0, 0, 1)
    assert counts(db, event) == (0, 0)


def test_import_semicolon_bom_file(db, make_event):
    event = make_event()
    result = import_questions_csv(db, event, read_fixture("questions_semicolon_bom.csv"))
    assert (result.created, result.categories_created, result.errors) == (3, 2, [])
    inactive = db.scalars(select(Question).where(Question.event_id == event.id, Question.is_active.is_(False))).all()
    assert len(inactive) == 1 and inactive[0].category.name == "Gouvernance"
    two = db.scalars(select(Question).where(Question.question_format == "two_choices")).one()
    assert (two.green_label_en, two.red_label_fr) == ("LLM Proxy", "Proxy MCP")


# ---------------------------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------------------------
def test_questions_export_has_bom_header_and_all_rows(db, make_event, make_category, make_question):
    event = make_event()
    cat = make_category(event, name="Gravitee")
    make_question(event, cat, question_text_en="One?", question_text_fr="Un ?", difficulty=2)
    make_question(event, None, question_text_en="Two?", question_text_fr=None, is_active=False, correct_answer="red")
    make_question(event, cat, question_format="two_choices", question_text_en="Three?", correct_answer="red")
    questions = db.scalars(select(Question).order_by(Question.id)).all()
    raw = questions_to_csv(questions)
    assert raw.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    assert tuple(rows[0]) == QUESTION_CSV_COLUMNS
    assert rows[0][:11] == HEADER.split(",")  # legacy columns first, in the legacy order
    assert rows[0][11:] == ["question_format", "is_active"]
    assert len(rows) == 4
    by_text = {r[2]: r for r in rows[1:]}
    assert by_text["One?"][0] == "Gravitee" and by_text["One?"][1] == "2" and by_text["One?"][12] == "true"
    assert by_text["Two?"][0] == "" and by_text["Two?"][3] == "" and by_text["Two?"][12] == "false"
    assert by_text["Three?"][11] == "two_choices" and by_text["Three?"][5] == "Option A"


def test_export_import_round_trip_into_a_new_event(db, make_event):
    source, target = make_event(), make_event()
    import_questions_csv(db, source, read_fixture("legacy_questions.csv"))
    import_questions_csv(db, source, read_fixture("questions_semicolon_bom.csv"))
    exported = questions_to_csv(db.scalars(select(Question).where(Question.event_id == source.id).order_by(Question.id)).all())
    result = import_questions_csv(db, target, exported)
    assert result.errors == [] and result.created == 17 and result.skipped_duplicates == 0

    fields = [
        "question_format", "difficulty", "question_text_en", "question_text_fr", "correct_answer",
        "green_label_en", "green_label_fr", "red_label_en", "red_label_fr", "explanation_en",
        "explanation_fr", "is_active",
    ]

    def snapshot(event):
        rows = db.scalars(select(Question).where(Question.event_id == event.id).order_by(Question.id)).all()
        return [(q.category.name if q.category else None, *[getattr(q, f) for f in fields]) for q in rows]

    assert snapshot(target) == snapshot(source)
    # and re-importing into the SAME event skips everything
    again = import_questions_csv(db, source, exported)
    assert again.created == 0 and again.skipped_duplicates == 17


def test_export_round_trips_awkward_text(db, make_event, make_question):
    event = make_event()
    make_question(
        event,
        question_text_en='Quotes "inside", commas, semicolons; and\nnewlines?',
        question_text_fr="Accents é à ç œ « » — ok ?",
        explanation_en="=not a formula, just text",
    )
    exported = questions_to_csv(db.scalars(select(Question)).all())
    other = make_event()
    assert import_questions_csv(db, other, exported).created == 1
    q = db.scalars(select(Question).where(Question.event_id == other.id)).one()
    assert q.question_text_en == 'Quotes "inside", commas, semicolons; and\nnewlines?'
    assert q.question_text_fr == "Accents é à ç œ « » — ok ?"
    assert q.explanation_en == "=not a formula, just text"  # the export guards it with a quote, the import takes it off


# ---------------------------------------------------------------------------------------------
# leads CSV
# ---------------------------------------------------------------------------------------------
def test_leads_csv_bom_header_and_neutralised_cells():
    raw = leads_to_csv(
        [
            [1, "=cmd|' /C calc'!A0", "+SUM(1,1)", "-2@x.io", "@home", "2026-10-07T09:00:00Z", 300, 3, 0, "\tfoo"],
            [2, "Zoë", "Müller", "zoe@example.com", "+33612345678", "", 200, 2, 1, "2026-10-07T09:05:00Z"],
        ]
    )
    assert raw.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    assert tuple(rows[0]) == LEADS_CSV_COLUMNS
    assert rows[1][1:5] == ["'=cmd|' /C calc'!A0", "'+SUM(1,1)", "'-2@x.io", "'@home"]
    assert rows[1][9] == "'\tfoo"
    assert rows[1][0] == "1" and rows[1][6] == "300"  # numbers are untouched
    assert rows[2][1:5] == ["Zoë", "Müller", "zoe@example.com", "+33612345678"]  # a real phone number is left alone
    # no cell of the data rows starts with a formula character, but the phone number
    for row in rows[1:]:
        assert not any(cell.startswith(("=", "+", "-", "@", "\t", "\r")) for cell in row if cell != "+33612345678")


def test_leads_csv_none_becomes_empty_cell():
    rows = list(csv.reader(io.StringIO(leads_to_csv([[1, "A", "B", "a@b.c", None, None, 0, 0, 0, None]]).decode("utf-8-sig"))))
    assert rows[1][4] == "" and rows[1][5] == "" and rows[1][9] == ""


# ---------------------------------------------------------------------------------------------
# question export: guarded against formula injection AND round-trippable
# ---------------------------------------------------------------------------------------------
def export_rows(db, event=None):
    stmt = select(Question).order_by(Question.id)
    if event is not None:
        stmt = stmt.where(Question.event_id == event.id)
    raw = questions_to_csv(db.scalars(stmt).all())
    return raw, list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline="")))


def test_question_export_neutralises_every_formula_looking_text_cell(db, make_event, make_category, make_question):
    event = make_event()
    category = make_category(event, name="=EvilCategory")
    make_question(
        event,
        category,
        question_format="two_choices",
        question_text_en="=HYPERLINK(\"http://evil\",\"click\")",
        question_text_fr="+SUM(1,1)",
        green_label_en="-2+3",
        green_label_fr="@home",
        red_label_en="\tTabbed",
        red_label_fr="\rReturned",
        explanation_en="=1+1",
        explanation_fr="+33 6 12 34 56 78",  # a plain phone number: nothing to execute, left alone
    )
    _, rows = export_rows(db)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["category"] == "'=EvilCategory"
    assert row["question_text_en"] == "'=HYPERLINK(\"http://evil\",\"click\")"
    assert row["question_text_fr"] == "'+SUM(1,1)"
    assert row["green_label_en"] == "'-2+3" and row["green_label_fr"] == "'@home"
    assert row["red_label_en"] == "'\tTabbed" and row["red_label_fr"] == "'\rReturned"
    assert row["explanation_en"] == "'=1+1"
    assert row["explanation_fr"] == "+33 6 12 34 56 78"
    # the fixed vocabulary columns are untouched
    assert (row["difficulty"], row["correct_answer"], row["question_format"], row["is_active"]) == ("1", "green", "two_choices", "true")
    # nothing the spreadsheet would run starts a text cell any more
    for cell in rows[1]:
        assert not cell.startswith(("=", "-", "@", "\t", "\r")) and not (cell.startswith("+") and not PHONE_NUMBER.fullmatch(cell))


HOSTILE_TEXTS = [
    "=1+1",
    "+SUM(1,1)",
    "-2+3 is what?",
    "@home",
    "\tTabbed",
    "\rReturned",
    "'=already quoted",  # looks like the guard of "=already quoted"
    "''=two quotes",
    "'+SUM(1,1)",
    "'-5",
    "'@x",
    "'\tx",
    "'hello",  # an apostrophe in front of something harmless stays
    "'",
    "''",
    "don't",
    "+33 6 12 34 56 78",
    "'+33 6 12 34 56 78",
    "=",
    "+",
    "-",
    "@",
    "a=b",
    "É=mc²",
]


@pytest.mark.parametrize("text", HOSTILE_TEXTS)
def test_unguard_cell_undoes_exactly_what_the_reversible_guard_added(text):
    assert unguard_cell(neutralize_cell(text, reversible=True)) == text


def test_the_question_export_round_trips_every_hostile_text_exactly(db, make_event, make_category, make_question):
    """Texts without outer whitespace (the question schema trims it) come back byte for byte, in every text column."""
    source, target = make_event(), make_event()
    texts = [t for t in HOSTILE_TEXTS if t == t.strip()]
    for text in texts:
        make_question(
            source,
            make_category(source, name=f"{text}-cat" if text[0] in "=+-@'" else f"Cat {text}"),
            question_format="two_choices",
            question_text_en=text,
            question_text_fr=text,
            green_label_en=text,
            green_label_fr=text,
            red_label_en="Other",
            red_label_fr="Autre",
            explanation_en=text,
            explanation_fr=text,
        )
    raw, _ = export_rows(db, source)
    result = import_questions_csv(db, target, raw)
    assert result.errors == [], result.errors
    assert result.created == len(texts) and result.skipped_duplicates == 0

    columns = ["question_text_en", "question_text_fr", "green_label_en", "green_label_fr", "explanation_en", "explanation_fr"]

    def snapshot(event):
        found = db.scalars(select(Question).where(Question.event_id == event.id)).all()
        return sorted((q.category.name, *[getattr(q, c) for c in columns]) for q in found)

    assert snapshot(target) == snapshot(source)
    assert {row[1] for row in snapshot(target)} == set(texts)  # and nothing was lost on the way


def test_a_leading_tab_or_return_is_guarded_in_the_export_and_does_not_break_the_import(db, make_event, make_question):
    source, target = make_event(), make_event()
    make_question(source, None, question_text_en="\tTabbed?", question_text_fr="\rReturned ?", explanation_en="\t=1+1")
    raw, rows = export_rows(db, source)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["question_text_en"] == "'\tTabbed?" and row["question_text_fr"] == "'\rReturned ?" and row["explanation_en"] == "'\t=1+1"
    result = import_questions_csv(db, target, raw)
    assert result.errors == [] and result.created == 1
    imported = db.scalars(select(Question).where(Question.event_id == target.id)).one()
    assert imported.question_text_en.strip() == "Tabbed?"  # the schema trims outer whitespace, as for any other import


def test_a_quote_in_front_of_harmless_text_is_never_removed_by_the_import(db, make_event):
    event = make_event()
    raw = (HEADER + ",question_format,is_active\n" + ",1,'Hello?,'Bonjour ?,green,,,,,'Because,'Parce que,true_false,true\n").encode()
    assert import_questions_csv(db, event, raw).created == 1
    q = db.scalars(select(Question).where(Question.event_id == event.id)).one()
    assert (q.question_text_en, q.question_text_fr, q.explanation_en, q.explanation_fr) == ("'Hello?", "'Bonjour ?", "'Because", "'Parce que")


def test_export_then_import_through_the_api_keeps_hostile_text_as_text(client, admin_headers, make_event, make_category, make_question):
    source = make_event()
    cat = make_category(source, name="@Team")
    make_question(source, cat, question_text_en="=cmd|' /C calc'!A0", question_text_fr="+SUM(1,1)", explanation_en="-1+1", is_active=False)
    exported = client.get(f"/api/admin/events/{source.id}/questions/export.csv", headers=admin_headers)
    assert exported.status_code == 200
    body = exported.content.decode("utf-8-sig")
    assert "'=cmd|' /C calc'!A0" in body and "'+SUM(1,1)" in body and "'-1+1" in body and "'@Team" in body
    target = make_event()
    done = client.post(
        f"/api/admin/events/{target.id}/questions/import-csv",
        files={"file": ("q.csv", exported.content, "text/csv")},
        headers=admin_headers,
    )
    assert done.status_code == 200 and done.json()["created"] == 1, done.text
    listed = client.get(f"/api/admin/events/{target.id}/questions?include_inactive=true", headers=admin_headers).json()["items"][0]
    assert listed["question_text_en"] == "=cmd|' /C calc'!A0"
    assert listed["question_text_fr"] == "+SUM(1,1)"
    assert listed["explanation_en"] == "-1+1"
    assert listed["category"]["name"] == "@Team"
    assert listed["is_active"] is False


def test_the_leads_endpoint_keeps_international_phone_numbers_intact(client, admin_headers, make_event, make_player, make_game_session):
    event = make_event(slug="leads")
    for first, phone in (("Ada", "+33612345678"), ("Bob", "+1 (415) 555-0132"), ("Eve", "+SUM(1,1)"), ("Max", "=1+1")):
        make_game_session(event, make_player(event, first_name=first, phone_number=phone), total_score=100)
    response = client.get(f"/api/admin/events/{event.id}/results.csv", headers=admin_headers)
    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
    phones = {r[1]: r[4] for r in rows[1:]}
    assert phones == {"Ada": "+33612345678", "Bob": "+1 (415) 555-0132", "Eve": "'+SUM(1,1)", "Max": "'=1+1"}
