"""
Admin - categories (docs/ARCHITECTURE.md section 5.3). Mounted under ``/api/admin``.

    GET    /events/{id}/categories    list (with question_count = all questions of the category)
    POST   /events/{id}/categories    create (name unique per event, compared case-insensitively)
    PUT    /categories/{cid}          partial update
    DELETE /categories/{cid}          questions become uncategorised; its weight is dropped from the
                                      event's category_distribution
"""
import logging
from typing import Optional

from fastapi import Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import admin_router
from app.database import get_db
from app.models import Category, Event, Question
from app.schemas import CategoryAdmin, CategoryCreate, CategoryUpdate
from app.services.csv_io import normalize_category_name
from app.services.events import get_event_by_id_or_404

logger = logging.getLogger(__name__)

router = admin_router()

CATEGORY_NOT_FOUND = "Category not found"


def _to_admin(category: Category, question_count: int) -> CategoryAdmin:
    item = CategoryAdmin.model_validate(category)
    item.question_count = question_count
    return item


def _question_count(db: Session, category_id: int) -> int:
    return db.scalar(select(func.count(Question.id)).where(Question.category_id == category_id)) or 0


def _name_conflict(name: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT, detail=f"A category named '{name}' already exists in this event"
    )


def _ensure_name_free(db: Session, event_id: int, name: str, exclude_id: Optional[int] = None) -> None:
    wanted = normalize_category_name(name)
    for category_id, existing in db.execute(select(Category.id, Category.name).where(Category.event_id == event_id)):
        if category_id != exclude_id and normalize_category_name(existing) == wanted:
            raise _name_conflict(name)


def get_category_or_404(db: Session, category_id: int) -> Category:
    category = db.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=CATEGORY_NOT_FOUND)
    return category


@router.get("/events/{event_id}/categories", response_model=list[CategoryAdmin], summary="List an event's categories")
def list_categories(event_id: int, db: Session = Depends(get_db)):
    get_event_by_id_or_404(db, event_id)
    count = func.count(Question.id)
    rows = db.execute(
        select(Category, count)
        .outerjoin(Question, Question.category_id == Category.id)
        .where(Category.event_id == event_id)
        .group_by(Category.id)
        .order_by(Category.id)
    ).all()
    return [_to_admin(category, total) for category, total in rows]


@router.post(
    "/events/{event_id}/categories",
    response_model=CategoryAdmin,
    status_code=status.HTTP_201_CREATED,
    summary="Create a category",
)
def create_category(event_id: int, payload: CategoryCreate, db: Session = Depends(get_db)):
    get_event_by_id_or_404(db, event_id)
    _ensure_name_free(db, event_id, payload.name)
    category = Category(event_id=event_id, **payload.model_dump())
    db.add(category)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _name_conflict(payload.name) from None
    db.refresh(category)
    return _to_admin(category, 0)


@router.put("/categories/{category_id}", response_model=CategoryAdmin, summary="Partially update a category")
def update_category(category_id: int, payload: CategoryUpdate, db: Session = Depends(get_db)):
    category = get_category_or_404(db, category_id)
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] != category.name:
        _ensure_name_free(db, category.event_id, changes["name"], exclude_id=category.id)
    for field, value in changes.items():
        setattr(category, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _name_conflict(changes.get("name", category.name)) from None
    db.refresh(category)
    return _to_admin(category, _question_count(db, category.id))


@router.delete(
    "/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a category"
)
def delete_category(category_id: int, db: Session = Depends(get_db)):
    category = get_category_or_404(db, category_id)

    # explicit (not only ON DELETE SET NULL) so it also holds on databases whose FK lacks the action
    db.execute(update(Question).where(Question.category_id == category.id).values(category_id=None))

    event = db.get(Event, category.event_id)
    if event is not None and event.category_distribution and str(category.id) in event.category_distribution:
        remaining = {k: v for k, v in event.category_distribution.items() if k != str(category.id)}
        event.category_distribution = remaining if sum(remaining.values()) > 0 else None

    db.execute(delete(Category).where(Category.id == category.id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
