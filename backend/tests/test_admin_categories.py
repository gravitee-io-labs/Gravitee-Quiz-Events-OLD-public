"""Admin categories API."""
import pytest
from sqlalchemy import func, select

from app.models import Category, Event, GameAnswer, Question


def list_url(event_id):
    return f"/api/admin/events/{event_id}/categories"


def item_url(category_id):
    return f"/api/admin/categories/{category_id}"


def create(client, admin_headers, event, **body):
    body.setdefault("name", "REST API")
    response = client.post(list_url(event.id), json=body, headers=admin_headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_create_category_with_defaults_and_everything(client, admin_headers, make_event):
    event = make_event()
    minimal = create(client, admin_headers, event, name="  Minimal  ")
    assert minimal == {
        "id": minimal["id"], "event_id": event.id, "name": "Minimal", "name_fr": None, "description": None,
        "description_fr": None, "color": "#FC5607", "is_active": True, "question_count": 0,
    }
    full = create(
        client, admin_headers, event, name="LLMs & GenAI", name_fr="LLM & IA générative", description="About LLMs",
        description_fr="À propos des LLM", color="#7c5cff", is_active=False,
    )
    assert full["color"] == "#7C5CFF" and full["is_active"] is False and full["name_fr"] == "LLM & IA générative"


@pytest.mark.parametrize(
    "body",
    [
        {"name": ""}, {"name": "   "}, {"name": "x" * 101}, {}, {"name": "ok", "color": "red"},
        {"name": "ok", "color": "#12345"}, {"name": "ok", "color": "#GGGGGG"}, {"name": "ok", "color": "#1234567"},
        {"name": "ok", "name_fr": "x" * 101}, {"name": "ok", "is_active": "maybe"},
    ],
)
def test_create_category_validation(client, admin_headers, make_event, body):
    assert client.post(list_url(make_event().id), json=body, headers=admin_headers).status_code == 422


def test_blank_optional_fields_become_null(client, admin_headers, make_event):
    category = create(client, admin_headers, make_event(), name="Blanks", name_fr="  ", description="")
    assert category["name_fr"] is None and category["description"] is None


def test_names_are_unique_per_event_case_insensitively(client, admin_headers, make_event):
    event, other = make_event(), make_event()
    create(client, admin_headers, event, name="Gravitee")
    for clash in ("Gravitee", "gravitee", "  GRAVITEE ", "GrAvItEe"):
        response = client.post(list_url(event.id), json={"name": clash}, headers=admin_headers)
        assert response.status_code == 409, clash
        assert "already exists" in response.json()["detail"]
    # the same name in another event is fine
    create(client, admin_headers, other, name="Gravitee")
    assert len(client.get(list_url(event.id), headers=admin_headers).json()) == 1


def test_create_category_for_unknown_event_is_404(client, admin_headers):
    assert client.post(list_url(999), json={"name": "X"}, headers=admin_headers).status_code == 404
    assert client.get(list_url(999), headers=admin_headers).status_code == 404


def test_list_categories_with_question_counts_scoped_to_the_event(client, admin_headers, make_event, make_category, make_question):
    event, other = make_event(), make_event()
    a, b, c = (make_category(event, name=n) for n in ("A", "B", "C"))
    for _ in range(3):
        make_question(event, a)
    make_question(event, a, is_active=False)  # inactive questions are counted too
    make_question(event, b)
    make_category(other, name="Foreign")
    items = client.get(list_url(event.id), headers=admin_headers).json()
    assert [(i["name"], i["question_count"]) for i in items] == [("A", 4), ("B", 1), ("C", 0)]
    assert [i["id"] for i in items] == sorted(i["id"] for i in items)
    assert all(i["event_id"] == event.id for i in items)


def test_update_is_partial(client, admin_headers, make_event):
    event = make_event()
    category = create(client, admin_headers, event, name="Old", name_fr="Ancien", description="d", color="#112233")
    response = client.put(item_url(category["id"]), json={"name": "New", "color": "#abcdef"}, headers=admin_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "New" and body["color"] == "#ABCDEF"
    assert body["name_fr"] == "Ancien" and body["description"] == "d" and body["is_active"] is True


def test_update_can_clear_nullable_fields_and_toggle_active(client, admin_headers, make_event):
    category = create(client, admin_headers, make_event(), name="X", name_fr="Y", description="Z")
    body = client.put(item_url(category["id"]), json={"name_fr": None, "description": "", "is_active": False}, headers=admin_headers).json()
    assert body["name_fr"] is None and body["description"] is None and body["is_active"] is False
    for field in ("name", "color", "is_active"):
        assert client.put(item_url(category["id"]), json={field: None}, headers=admin_headers).status_code == 422, field


def test_update_name_conflicts(client, admin_headers, make_event):
    event, other = make_event(), make_event()
    first = create(client, admin_headers, event, name="First")
    create(client, admin_headers, event, name="Second")
    foreign = create(client, admin_headers, other, name="Second")
    assert client.put(item_url(first["id"]), json={"name": "second"}, headers=admin_headers).status_code == 409
    # keeping the name (or only changing its case) is fine
    assert client.put(item_url(first["id"]), json={"name": "First"}, headers=admin_headers).status_code == 200
    assert client.put(item_url(first["id"]), json={"name": "FIRST"}, headers=admin_headers).status_code == 200
    # a different event may use the name
    assert client.put(item_url(foreign["id"]), json={"name": "First"}, headers=admin_headers).status_code == 200


def test_update_unknown_category_is_404(client, admin_headers):
    assert client.put(item_url(999), json={"name": "x"}, headers=admin_headers).status_code == 404
    assert client.delete(item_url(999), headers=admin_headers).status_code == 404


def test_update_keeps_the_question_count(client, admin_headers, make_event, make_category, make_question):
    event = make_event()
    category = make_category(event, name="Counted")
    make_question(event, category)
    make_question(event, category)
    assert client.put(item_url(category.id), json={"color": "#000000"}, headers=admin_headers).json()["question_count"] == 2


def test_delete_uncategorises_the_questions_but_keeps_them(client, admin_headers, db, make_event, make_category, make_question):
    event = make_event()
    doomed, kept = make_category(event, name="Doomed"), make_category(event, name="Kept")
    q1, q2 = make_question(event, doomed), make_question(event, doomed, is_active=False)
    q3 = make_question(event, kept)
    ids = (q1.id, q2.id, q3.id)
    doomed_id = doomed.id

    response = client.delete(item_url(doomed_id), headers=admin_headers)
    assert response.status_code == 204 and response.content == b""

    assert db.get(Category, doomed_id) is None
    questions = {q.id: q for q in db.scalars(select(Question).where(Question.id.in_(ids)))}
    assert len(questions) == 3  # no question was deleted
    assert questions[ids[0]].category_id is None and questions[ids[1]].category_id is None
    assert questions[ids[2]].category_id == kept.id
    # they show up as uncategorised through the API
    listing = client.get(f"/api/admin/events/{event.id}/questions?include_inactive=true&category_id=0", headers=admin_headers).json()
    assert listing["total"] == 2


def test_delete_removes_the_categorys_weight_from_the_event(client, admin_headers, db, make_event, make_category):
    event = make_event()
    a, b = make_category(event, name="A"), make_category(event, name="B")
    event.category_distribution = {str(a.id): 60, str(b.id): 40}
    db.commit()
    event_id, a_id, b_id = event.id, a.id, b.id
    client.delete(item_url(a_id), headers=admin_headers)
    assert db.get(Event, event_id).category_distribution == {str(b_id): 40}
    client.delete(item_url(b_id), headers=admin_headers)
    db.expire_all()
    assert db.get(Event, event_id).category_distribution is None  # nothing left to weight => equal split


def test_delete_leaves_game_history_intact(client, admin_headers, db, make_event, make_category, make_question, make_game_session):
    event = make_event()
    category = make_category(event)
    question = make_question(event, category)
    session = make_game_session(event, answers=[{"question": question, "player_answer": "green"}])
    category_id, session_id = category.id, session.id
    assert client.delete(item_url(category_id), headers=admin_headers).status_code == 204
    assert db.scalar(select(func.count()).select_from(GameAnswer).where(GameAnswer.game_session_id == session_id)) == 1


def test_delete_only_touches_its_own_event(client, admin_headers, db, make_event, make_category, make_question):
    event, other = make_event(), make_event()
    mine, theirs = make_category(event, name="Same"), make_category(other, name="Same")
    make_question(other, theirs)
    client.delete(item_url(mine.id), headers=admin_headers)
    assert db.scalar(select(func.count()).select_from(Category).where(Category.event_id == other.id)) == 1
    assert db.scalars(select(Question).where(Question.event_id == other.id)).one().category_id == theirs.id


def test_a_deleted_category_name_can_be_reused(client, admin_headers, make_event):
    event = make_event()
    first = create(client, admin_headers, event, name="Again")
    assert client.delete(item_url(first["id"]), headers=admin_headers).status_code == 204
    assert create(client, admin_headers, event, name="Again")["question_count"] == 0
