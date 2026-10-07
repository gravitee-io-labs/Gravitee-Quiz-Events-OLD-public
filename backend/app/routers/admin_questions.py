"""
Admin - questions (docs/ARCHITECTURE.md section 5.3). Mounted under ``/api/admin``.

    GET    /events/{id}/questions               filters + search + pagination -> {items, total}
    POST   /events/{id}/questions               create
    POST   /events/{id}/questions/bulk          activate / deactivate / delete / set_category / set_difficulty
    POST   /events/{id}/questions/import-csv    multipart ``file``, ``?dry_run=true``
    GET    /events/{id}/questions/export.csv    same columns as the import
    GET    /questions/{qid}  PUT  DELETE        one question

``include_inactive`` defaults to ``false`` (legacy behaviour): the admin UI passes ``true`` to see
everything. ``category_id=0`` selects the uncategorised questions.
"""
import logging
from typing import Optional

from fastapi import Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session, joinedload

from app.auth import admin_router
from app.database import get_db
from app.models import Category, Question
from app.schemas import (
    QUESTION_FIELDS,
    BulkResult,
    CsvImportResult,
    QuestionAdmin,
    QuestionBulkRequest,
    QuestionCreate,
    QuestionFormat,
    QuestionPage,
    QuestionUpdate,
)
from app.services.csv_io import (
    MAX_CSV_BYTES,
    CsvFormatError,
    import_questions_csv,
    questions_to_csv,
)
from app.services.events import get_event_by_id_or_404
from app.services.search import LIKE_ESCAPE, like_pattern, search_term

logger = logging.getLogger(__name__)

router = admin_router()

QUESTION_NOT_FOUND = "Question not found"
MAX_PAGE_SIZE = 500


def get_question_or_404(db: Session, question_id: int) -> Question:
    question = db.scalars(
        select(Question).options(joinedload(Question.category)).where(Question.id == question_id)
    ).first()
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=QUESTION_NOT_FOUND)
    return question


def _check_category(db: Session, event_id: int, category_id: Optional[int]) -> None:
    """The category must exist and belong to the event (422 otherwise); ``None`` is fine."""
    if category_id is None:
        return
    owner = db.scalar(select(Category.event_id).where(Category.id == category_id))
    if owner != event_id:
        raise HTTPException(
            status_code=422,
            detail="category_id does not belong to this event",
        )


# ---------------------------------------------------------------------------------------------
# List / create
# ---------------------------------------------------------------------------------------------
@router.get("/events/{event_id}/questions", response_model=QuestionPage, summary="List / search questions")
def list_questions(
    event_id: int,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
    include_inactive: bool = Query(False),
    category_id: Optional[int] = Query(None, ge=0, description="0 = uncategorised"),
    difficulty: Optional[int] = Query(None, ge=1, le=5),
    question_format: Optional[QuestionFormat] = Query(None),
    search: Optional[str] = Query(None, max_length=200, description="Case-insensitive, EN and FR text"),
    db: Session = Depends(get_db),
):
    get_event_by_id_or_404(db, event_id)

    conditions = [Question.event_id == event_id]
    if not include_inactive:
        conditions.append(Question.is_active.is_(True))
    if category_id is not None:
        conditions.append(Question.category_id.is_(None) if category_id == 0 else Question.category_id == category_id)
    if difficulty is not None:
        conditions.append(Question.difficulty == difficulty)
    if question_format is not None:
        conditions.append(Question.question_format == question_format)
    term = search_term(search)
    if term:
        pattern = like_pattern(term)
        conditions.append(
            or_(
                Question.question_text_en.ilike(pattern, escape=LIKE_ESCAPE),
                Question.question_text_fr.ilike(pattern, escape=LIKE_ESCAPE),
            )
        )

    total = db.scalar(select(func.count(Question.id)).where(*conditions)) or 0
    items = db.scalars(
        select(Question)
        .options(joinedload(Question.category))
        .where(*conditions)
        .order_by(Question.id)
        .offset(skip)
        .limit(limit)
    ).all()
    return QuestionPage(items=[QuestionAdmin.model_validate(q) for q in items], total=total)


@router.post(
    "/events/{event_id}/questions",
    response_model=QuestionAdmin,
    status_code=status.HTTP_201_CREATED,
    summary="Create a question",
)
def create_question(event_id: int, payload: QuestionCreate, db: Session = Depends(get_db)):
    get_event_by_id_or_404(db, event_id)
    _check_category(db, event_id, payload.category_id)
    question = Question(event_id=event_id, **payload.model_dump())
    db.add(question)
    db.commit()
    return QuestionAdmin.model_validate(get_question_or_404(db, question.id))


# ---------------------------------------------------------------------------------------------
# Bulk / CSV
# ---------------------------------------------------------------------------------------------
@router.post("/events/{event_id}/questions/bulk", response_model=BulkResult, summary="Bulk action on questions")
def bulk_questions(event_id: int, payload: QuestionBulkRequest, db: Session = Depends(get_db)):
    get_event_by_id_or_404(db, event_id)
    # only ids of THIS event are touched; foreign ids are ignored
    scope = (Question.event_id == event_id, Question.id.in_(list(set(payload.ids))))

    if payload.action == "delete":
        result = db.execute(delete(Question).where(*scope))
    else:
        if payload.action == "activate":
            values = {"is_active": True}
        elif payload.action == "deactivate":
            values = {"is_active": False}
        elif payload.action == "set_category":
            _check_category(db, event_id, payload.category_id)
            values = {"category_id": payload.category_id}
        else:  # set_difficulty (the schema guarantees the value)
            values = {"difficulty": payload.difficulty}
        result = db.execute(update(Question).where(*scope).values(**values))
    db.commit()
    return BulkResult(affected=result.rowcount or 0)


@router.post(
    "/events/{event_id}/questions/import-csv",
    response_model=CsvImportResult,
    summary="Import questions from a CSV file (UTF-8, delimiter , or ;)",
    description=(
        "Multipart field `file`. Columns: category, difficulty, question_text_en, question_text_fr, "
        "correct_answer, green_label_en, green_label_fr, red_label_en, red_label_fr, explanation_en, "
        "explanation_fr, question_format (optional), is_active (optional). Valid rows are imported, "
        "invalid rows are reported in `errors` (`row` = spreadsheet row, header = 1). Duplicates "
        "(same English text) are skipped. `?dry_run=true` validates without writing."
    ),
)
def import_questions(
    event_id: int,
    file: UploadFile = File(...),
    dry_run: bool = Query(False),
    db: Session = Depends(get_db),
):
    event = get_event_by_id_or_404(db, event_id)
    raw = file.file.read(MAX_CSV_BYTES + 1)
    if len(raw) > MAX_CSV_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"The file is too large (max {MAX_CSV_BYTES // (1024 * 1024)} MB)",
        )
    try:
        return import_questions_csv(db, event, raw, dry_run=dry_run)
    except CsvFormatError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None


@router.get("/events/{event_id}/questions/export.csv", summary="Export all questions as CSV")
def export_questions_csv(event_id: int, db: Session = Depends(get_db)):
    event = get_event_by_id_or_404(db, event_id)
    questions = db.scalars(
        select(Question).options(joinedload(Question.category)).where(Question.event_id == event.id).order_by(Question.id)
    ).all()
    return Response(
        content=questions_to_csv(questions),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{event.slug}-questions.csv"'},
    )


# ---------------------------------------------------------------------------------------------
# One question
# ---------------------------------------------------------------------------------------------
@router.get("/questions/{question_id}", response_model=QuestionAdmin, summary="Get a question")
def get_question(question_id: int, db: Session = Depends(get_db)):
    return QuestionAdmin.model_validate(get_question_or_404(db, question_id))


@router.put("/questions/{question_id}", response_model=QuestionAdmin, summary="Partially update a question")
def update_question(question_id: int, payload: QuestionUpdate, db: Session = Depends(get_db)):
    question = get_question_or_404(db, question_id)
    if "category_id" in payload.model_fields_set:
        _check_category(db, question.event_id, payload.category_id)
    try:
        changes = payload.resolve({field: getattr(question, field) for field in QUESTION_FIELDS})
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    for field, value in changes.items():
        setattr(question, field, value)
    db.commit()
    db.expire(question)  # reload (also re-resolves the category relationship after a category change)
    return QuestionAdmin.model_validate(get_question_or_404(db, question_id))


@router.delete("/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a question")
def delete_question(question_id: int, db: Session = Depends(get_db)):
    question = get_question_or_404(db, question_id)
    db.execute(delete(Question).where(Question.id == question.id))  # answers cascade in the database
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
