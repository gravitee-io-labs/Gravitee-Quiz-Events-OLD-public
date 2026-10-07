"""Admin questions API: CRUD, filters / search / pagination, bulk actions, CSV import / export."""
import csv
import io
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.models import Category, GameAnswer, GameSession, Question
from app.routers import admin_questions
from app.services import csv_io

FIXTURES = Path(__file__).parent / "fixtures"


def list_url(event_id, query=""):
    return f"/api/admin/events/{event_id}/questions{query}"


def item_url(question_id):
    return f"/api/admin/questions/{question_id}"


def bulk_url(event_id):
    return f"/api/admin/events/{event_id}/questions/bulk"


def import_url(event_id, query=""):
    return f"/api/admin/events/{event_id}/questions/import-csv{query}"


def tf(**extra):
    body = {"question_text_en": "Is the gateway stateless?", "correct_answer": "green"}
    body.update(extra)
    return body


def upload(client, admin_headers, event_id, content: bytes, query="", filename="questions.csv"):
    return client.post(
        import_url(event_id, query), files={"file": (filename, content, "text/csv")}, headers=admin_headers
    )


def db_count(db, model, **filters):
    stmt = select(func.count()).select_from(model)
    for key, value in filters.items():
        stmt = stmt.where(getattr(model, key) == value)
    return db.scalar(stmt)


# ---------------------------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------------------------
def test_create_true_false_question_forces_the_labels(client, admin_headers, make_event, make_category):
    event = make_event()
    category = make_category(event, name="Gravitee")
    response = client.post(
        list_url(event.id),
        json=tf(category_id=category.id, question_text_fr="La passerelle est-elle sans état ?", difficulty=2,
                explanation_en="Because.", green_label_en="whatever"),
        headers=admin_headers,
    )
    assert response.status_code == 201, response.text
    q = response.json()
    assert q["event_id"] == event.id and q["category_id"] == category.id and q["category"]["name"] == "Gravitee"
    assert q["question_format"] == "true_false" and q["difficulty"] == 2 and q["is_active"] is True
    assert (q["green_label_en"], q["green_label_fr"], q["red_label_en"], q["red_label_fr"]) == ("TRUE", "Vrai", "FALSE", "Faux")
    assert q["correct_answer"] == "green" and q["explanation_en"] == "Because." and q["question_type"] == "text"
    assert q["created_at"].endswith("Z")


def test_create_two_choices_question(client, admin_headers, make_event):
    q = client.post(
        list_url(make_event().id),
        json=tf(question_format="two_choices", green_label_en="LLM Proxy", green_label_fr="Proxy LLM",
                red_label_en="MCP Proxy", correct_answer="red"),
        headers=admin_headers,
    ).json()
    assert q["question_format"] == "two_choices" and q["correct_answer"] == "red"
    assert (q["green_label_en"], q["green_label_fr"]) == ("LLM Proxy", "Proxy LLM")
    assert (q["red_label_en"], q["red_label_fr"]) == ("MCP Proxy", "MCP Proxy")  # FR falls back to EN
    assert q["category"] is None and q["question_text_fr"] is None


@pytest.mark.parametrize(
    "extra",
    [
        {"question_text_en": ""}, {"question_text_en": "   "}, {"question_text_en": "x" * 2001}, {"correct_answer": "blue"},
        {"correct_answer": None}, {"difficulty": 0}, {"difficulty": 6}, {"question_format": "multiple"},
        {"question_format": "two_choices"},  # labels missing
        {"question_format": "two_choices", "green_label_en": "A"},
        {"question_format": "two_choices", "green_label_en": "A", "red_label_en": "a"},  # same labels
        {"question_format": "two_choices", "green_label_en": "A" * 101, "red_label_en": "B"},
        {"media_url": "http://insecure.example/x.png"}, {"media_url": "javascript:alert(1)"}, {"question_type": "Bad Type!"},
    ],
)
def test_create_question_validation(client, admin_headers, make_event, extra):
    assert client.post(list_url(make_event().id), json=tf(**extra), headers=admin_headers).status_code == 422


def test_create_question_with_a_category_of_another_event_is_refused(client, admin_headers, make_event, make_category):
    event, other = make_event(), make_event()
    foreign = make_category(other)
    response = client.post(list_url(event.id), json=tf(category_id=foreign.id), headers=admin_headers)
    assert response.status_code == 422 and "category" in response.json()["detail"]
    assert client.post(list_url(event.id), json=tf(category_id=99999), headers=admin_headers).status_code == 422


def test_create_question_in_unknown_event_is_404(client, admin_headers):
    assert client.post(list_url(999), json=tf(), headers=admin_headers).status_code == 404


def test_get_one_question(client, admin_headers, make_event, make_question):
    q = make_question(make_event())
    body = client.get(item_url(q.id), headers=admin_headers).json()
    assert body["id"] == q.id and body["correct_answer"] == "green" and "explanation_en" in body
    assert client.get(item_url(99999), headers=admin_headers).status_code == 404


# ---------------------------------------------------------------------------------------------
# list: filters, search, pagination
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def pool(make_event, make_category, make_question):
    event = make_event()
    rest, ai = make_category(event, name="REST"), make_category(event, name="AI")
    questions = {
        "rest1": make_question(event, rest, question_text_en="REST uses HTTP verbs", question_text_fr="REST utilise les verbes HTTP", difficulty=1),
        "rest2": make_question(event, rest, question_text_en="PATCH replaces a resource", question_text_fr="PATCH remplace une ressource", difficulty=2),
        "ai1": make_question(event, ai, question_text_en="An LLM predicts tokens", question_text_fr="Un LLM prédit des jetons", difficulty=1, question_format="two_choices"),
        "ai2": make_question(event, ai, question_text_en="Guardrails filter prompts", question_text_fr="Les garde-fous filtrent les prompts", difficulty=3, is_active=False),
        "loose": make_question(event, None, question_text_en="100% of cats are mammals_", question_text_fr=None, difficulty=2),
    }
    other = make_event()
    make_question(other, question_text_en="REST in another event")
    return event, rest, ai, questions


def texts(response):
    assert response.status_code == 200, response.text
    return [q["question_text_en"] for q in response.json()["items"]]


def test_list_defaults_exclude_inactive_and_order_by_id(client, admin_headers, pool):
    event, _, _, _ = pool
    response = client.get(list_url(event.id), headers=admin_headers)
    body = response.json()
    assert body["total"] == 4 and set(body) == {"items", "total"}
    assert texts(response) == ["REST uses HTTP verbs", "PATCH replaces a resource", "An LLM predicts tokens", "100% of cats are mammals_"]
    first = body["items"][0]
    assert first["category"]["name"] == "REST" and first["correct_answer"] == "green" and "explanation_fr" in first


def test_list_include_inactive(client, admin_headers, pool):
    event, *_ = pool
    response = client.get(list_url(event.id, "?include_inactive=true"), headers=admin_headers)
    assert response.json()["total"] == 5 and "Guardrails filter prompts" in texts(response)


def test_list_filters(client, admin_headers, pool):
    event, rest, ai, _ = pool
    base = "?include_inactive=true&"
    assert texts(client.get(list_url(event.id, base + f"category_id={rest.id}"), headers=admin_headers)) == [
        "REST uses HTTP verbs", "PATCH replaces a resource"]
    assert texts(client.get(list_url(event.id, base + "category_id=0"), headers=admin_headers)) == ["100% of cats are mammals_"]
    assert texts(client.get(list_url(event.id, base + "difficulty=3"), headers=admin_headers)) == ["Guardrails filter prompts"]
    assert texts(client.get(list_url(event.id, base + "difficulty=2"), headers=admin_headers)) == [
        "PATCH replaces a resource", "100% of cats are mammals_"]
    assert texts(client.get(list_url(event.id, base + "question_format=two_choices"), headers=admin_headers)) == ["An LLM predicts tokens"]
    assert len(texts(client.get(list_url(event.id, base + "question_format=true_false"), headers=admin_headers))) == 4
    # combined filters
    combined = list_url(event.id, base + f"category_id={ai.id}&difficulty=1&question_format=two_choices")
    assert texts(client.get(combined, headers=admin_headers)) == ["An LLM predicts tokens"]
    assert texts(client.get(list_url(event.id, base + f"category_id={ai.id}&difficulty=2"), headers=admin_headers)) == []


def test_list_invalid_filters_are_422(client, admin_headers, pool):
    event, *_ = pool
    for query in ("difficulty=0", "difficulty=6", "difficulty=abc", "question_format=nope", "category_id=-1", "limit=0",
                  "limit=501", "skip=-1", "include_inactive=maybe"):
        assert client.get(list_url(event.id, "?" + query), headers=admin_headers).status_code == 422, query


def test_list_search_is_case_insensitive_on_english_and_french(client, admin_headers, pool):
    event, *_ = pool
    q = lambda term: texts(client.get(list_url(event.id, "?include_inactive=true&search=" + term), headers=admin_headers))  # noqa: E731
    assert q("rest") == ["REST uses HTTP verbs", "PATCH replaces a resource"] or "REST uses HTTP verbs" in q("rest")
    assert q("llm") == ["An LLM predicts tokens"] and q("LLM") == ["An LLM predicts tokens"] and q("LlM") == ["An LLM predicts tokens"]
    assert q("ressource") == ["PATCH replaces a resource"]  # French text only
    assert q("RESSOURCE") == ["PATCH replaces a resource"]
    assert q("garde-fous") == ["Guardrails filter prompts"]  # inactive, French only
    assert q("jetons") == ["An LLM predicts tokens"]
    assert q("%20http%20verbs") == ["REST uses HTTP verbs"]  # urlencoded spaces
    assert q("nothing-matches-this") == []


def test_list_search_is_trimmed_and_blank_means_no_filter(client, admin_headers, pool):
    event, *_ = pool
    assert client.get(list_url(event.id, "?search=%20%20"), headers=admin_headers).json()["total"] == 4
    assert client.get(list_url(event.id, "?search="), headers=admin_headers).json()["total"] == 4
    assert texts(client.get(list_url(event.id, "?search=%20llm%20"), headers=admin_headers)) == ["An LLM predicts tokens"]


def test_list_search_treats_like_wildcards_literally(client, admin_headers, pool):
    event, *_ = pool
    get = lambda term: texts(client.get(list_url(event.id, "?include_inactive=true&search=" + term), headers=admin_headers))  # noqa: E731
    assert get("100%25") == ["100% of cats are mammals_"]  # a literal percent sign
    assert get("%25") == ["100% of cats are mammals_"]
    assert get("mammals_") == ["100% of cats are mammals_"]
    assert get("_") == ["100% of cats are mammals_"]  # not "any single character"
    assert get("a_c") == []  # would match "a c"/"abc" if _ were a wildcard
    assert get("%5C") == []  # a backslash


@pytest.mark.parametrize(
    "term",
    ["'", "' OR '1'='1", "'; DROP TABLE questions; --", '" OR ""="', "\\", "%' --", "1; SELECT * FROM events", "e\u0301"],
)
def test_list_search_is_parameterised(client, admin_headers, db, pool, term):
    event, *_ = pool
    response = client.get(list_url(event.id), params={"search": term}, headers=admin_headers)
    assert response.status_code == 200 and response.json()["items"] == []
    assert db_count(db, Question) == 6  # the table is still there, nothing dropped
    still = client.get(list_url(event.id), headers=admin_headers).json()
    assert still["total"] == 4


def test_list_search_ignores_nul_characters(client, admin_headers, pool):
    """NUL is illegal in PostgreSQL text parameters: it must never reach the database (would be a 500)."""
    event, *_ = pool
    assert client.get(list_url(event.id), params={"search": "\x00"}, headers=admin_headers).json()["total"] == 4
    assert texts(client.get(list_url(event.id), params={"search": "ll\x00m"}, headers=admin_headers)) == ["An LLM predicts tokens"]


def test_list_search_length_is_bounded(client, admin_headers, pool):
    event, *_ = pool
    assert client.get(list_url(event.id), params={"search": "x" * 201}, headers=admin_headers).status_code == 422
    assert client.get(list_url(event.id), params={"search": "x" * 200}, headers=admin_headers).status_code == 200


def test_list_pagination(client, admin_headers, make_event, make_question):
    event = make_event()
    created = [make_question(event, question_text_en=f"Question {i:02d}?") for i in range(25)]
    page = lambda skip, limit: client.get(list_url(event.id, f"?skip={skip}&limit={limit}"), headers=admin_headers).json()  # noqa: E731
    first = page(0, 10)
    assert first["total"] == 25 and len(first["items"]) == 10
    assert [q["id"] for q in first["items"]] == [q.id for q in created[:10]]
    second = page(10, 10)
    third = page(20, 10)
    assert [q["id"] for q in second["items"]] == [q.id for q in created[10:20]]
    assert len(third["items"]) == 5 and third["total"] == 25
    assert page(25, 10)["items"] == [] and page(25, 10)["total"] == 25
    assert page(1000, 10) == {"items": [], "total": 25}
    everything = [q["id"] for p in (first, second, third) for q in p["items"]]
    assert everything == sorted(set(everything)) and len(everything) == 25  # no gaps, no duplicates
    assert len(page(0, 500)["items"]) == 25
    assert len(client.get(list_url(event.id), headers=admin_headers).json()["items"]) == 25  # default limit 50


def test_total_reflects_filters_not_the_page(client, admin_headers, make_event, make_question):
    event = make_event()
    for i in range(12):
        make_question(event, question_text_en=f"Alpha {i}", difficulty=1 + i % 2)
    body = client.get(list_url(event.id, "?difficulty=1&limit=2&search=alpha"), headers=admin_headers).json()
    assert body["total"] == 6 and len(body["items"]) == 2


def test_list_unknown_event_is_404(client, admin_headers):
    assert client.get(list_url(999), headers=admin_headers).status_code == 404


def test_list_does_not_run_a_query_per_question(client, admin_headers, make_event, make_category, make_question):
    from sqlalchemy import event as sa_event

    from app.database import engine

    event = make_event()
    category = make_category(event)
    for _ in range(30):
        make_question(event, category)
    statements = []

    def spy(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    sa_event.listen(engine, "before_cursor_execute", spy)
    try:
        assert client.get(list_url(event.id), headers=admin_headers).status_code == 200
    finally:
        sa_event.remove(engine, "before_cursor_execute", spy)
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    assert len(selects) <= 4, selects  # event lookup + count + page (+ slack), independent of the 30 questions


# ---------------------------------------------------------------------------------------------
# update / delete
# ---------------------------------------------------------------------------------------------
def test_update_is_partial(client, admin_headers, make_event, make_category, make_question):
    event = make_event()
    category = make_category(event, name="Old")
    q = make_question(event, category, question_text_en="Original?", difficulty=1)
    new_category = make_category(event, name="New")
    response = client.put(
        item_url(q.id),
        json={"question_text_en": "Changed?", "difficulty": 3, "category_id": new_category.id, "correct_answer": "red", "is_active": False},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["question_text_en"] == "Changed?" and body["difficulty"] == 3 and body["correct_answer"] == "red"
    assert body["is_active"] is False and body["category"]["name"] == "New" and body["category_id"] == new_category.id
    assert body["question_text_fr"] == q.question_text_fr and body["explanation_en"] == q.explanation_en  # untouched
    assert body["updated_at"] >= body["created_at"]


def test_update_switching_format_rewrites_the_labels(client, admin_headers, make_event, make_question):
    q = make_question(make_event())
    two = client.put(
        item_url(q.id),
        json={"question_format": "two_choices", "green_label_en": "Left", "green_label_fr": "Gauche", "red_label_en": "Right", "red_label_fr": "Droite"},
        headers=admin_headers,
    ).json()
    assert two["question_format"] == "two_choices"
    assert (two["green_label_en"], two["green_label_fr"], two["red_label_en"], two["red_label_fr"]) == ("Left", "Gauche", "Right", "Droite")
    back = client.put(item_url(q.id), json={"question_format": "true_false"}, headers=admin_headers).json()
    assert (back["green_label_en"], back["green_label_fr"], back["red_label_en"], back["red_label_fr"]) == ("TRUE", "Vrai", "FALSE", "Faux")


def test_switching_to_two_choices_with_english_labels_only_leaves_no_stale_french_labels(client, admin_headers, make_event, make_question):
    q = make_question(make_event())  # true_false: TRUE / Vrai / FALSE / Faux
    body = client.put(
        item_url(q.id),
        json={"question_format": "two_choices", "green_label_en": "Yes", "red_label_en": "No"},
        headers=admin_headers,
    ).json()
    assert body["question_format"] == "two_choices"
    assert (body["green_label_en"], body["green_label_fr"], body["red_label_en"], body["red_label_fr"]) == ("Yes", "Yes", "No", "No")
    # a French label sent explicitly is kept
    again = client.put(item_url(q.id), json={"green_label_fr": "Oui", "red_label_fr": "Non"}, headers=admin_headers).json()
    assert (again["green_label_fr"], again["red_label_fr"]) == ("Oui", "Non")


def test_the_admin_console_payload_with_blank_french_labels_is_accepted(client, admin_headers, make_event, make_question):
    """What question-editor.js sends: every field, with ``null`` for a blank French label."""
    q = make_question(make_event(), question_format="two_choices", green_label_en="GET", green_label_fr="OBTENIR", red_label_en="POST", red_label_fr="ENVOYER")
    payload = {
        "category_id": None, "question_format": "two_choices", "difficulty": 2, "question_text_en": "Which verb?",
        "question_text_fr": None, "correct_answer": "green", "green_label_en": "GET", "green_label_fr": None,
        "red_label_en": "POST", "red_label_fr": None, "explanation_en": None, "explanation_fr": None,
        "media_url": None, "is_active": True,
    }
    response = client.put(item_url(q.id), json=payload, headers=admin_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["green_label_fr"], body["red_label_fr"]) == ("GET", "POST")  # falls back to the English labels


def test_english_labels_cannot_be_nulled_through_the_api(client, admin_headers, make_event, make_question):
    q = make_question(make_event(), question_format="two_choices")
    assert client.put(item_url(q.id), json={"green_label_en": None}, headers=admin_headers).status_code == 422


def test_update_to_two_choices_without_labels_is_422(client, admin_headers, make_event, make_question):
    q = make_question(make_event())
    # the stored labels are TRUE/FALSE, which are valid and different, so this alone is accepted ...
    assert client.put(item_url(q.id), json={"question_format": "two_choices"}, headers=admin_headers).status_code == 200
    # ... but identical labels are not
    response = client.put(item_url(q.id), json={"green_label_en": "Same", "red_label_en": "same"}, headers=admin_headers)
    assert response.status_code == 422 and "different" in response.json()["detail"]


def test_update_category_rules(client, admin_headers, make_event, make_category, make_question):
    event, other = make_event(), make_event()
    category, foreign = make_category(event), make_category(other)
    q = make_question(event, category)
    assert client.put(item_url(q.id), json={"category_id": foreign.id}, headers=admin_headers).status_code == 422
    assert client.put(item_url(q.id), json={"category_id": 99999}, headers=admin_headers).status_code == 422
    uncategorised = client.put(item_url(q.id), json={"category_id": None}, headers=admin_headers).json()
    assert uncategorised["category_id"] is None and uncategorised["category"] is None
    # not mentioning category_id leaves it alone
    again = client.put(item_url(q.id), json={"category_id": category.id}, headers=admin_headers).json()
    assert client.put(item_url(q.id), json={"difficulty": 2}, headers=admin_headers).json()["category_id"] == again["category_id"]


def test_update_nullable_text_fields_can_be_cleared(client, admin_headers, make_event, make_question):
    q = make_question(make_event())
    body = client.put(item_url(q.id), json={"question_text_fr": None, "explanation_en": "", "media_url": None}, headers=admin_headers).json()
    assert body["question_text_fr"] is None and body["explanation_en"] is None and body["media_url"] is None
    for field in ("question_text_en", "correct_answer", "difficulty", "is_active", "question_format"):
        assert client.put(item_url(q.id), json={field: None}, headers=admin_headers).status_code == 422, field


def test_update_validation_and_404(client, admin_headers, make_event, make_question):
    q = make_question(make_event())
    assert client.put(item_url(q.id), json={"difficulty": 9}, headers=admin_headers).status_code == 422
    assert client.put(item_url(q.id), json={"correct_answer": "blue"}, headers=admin_headers).status_code == 422
    assert client.put(item_url(99999), json={"difficulty": 2}, headers=admin_headers).status_code == 404
    assert client.put(item_url(q.id), json={}, headers=admin_headers).status_code == 200


def test_delete_question_cascades_to_its_answers_only(client, admin_headers, db, make_event, make_question, make_game_session):
    event = make_event()
    doomed, kept = make_question(event), make_question(event)
    session = make_game_session(event, answers=[{"question": doomed, "player_answer": "green"}, {"question": kept, "player_answer": "red"}])
    doomed_id, kept_id, session_id = doomed.id, kept.id, session.id
    assert client.delete(item_url(doomed_id), headers=admin_headers).status_code == 204
    assert db.get(Question, doomed_id) is None and db.get(Question, kept_id) is not None
    remaining = db.scalars(select(GameAnswer).where(GameAnswer.game_session_id == session_id)).all()
    assert [a.question_id for a in remaining] == [kept_id]
    assert db.get(GameSession, session_id) is not None
    assert client.delete(item_url(doomed_id), headers=admin_headers).status_code == 404


# ---------------------------------------------------------------------------------------------
# bulk
# ---------------------------------------------------------------------------------------------
@pytest.fixture
def bulk_setup(make_event, make_category, make_question):
    event, other = make_event(), make_event()
    category = make_category(event, name="Target")
    mine = [make_question(event, difficulty=1) for _ in range(4)]
    foreign = make_question(other, difficulty=1)
    return event, category, mine, foreign


def post_bulk(client, admin_headers, event, ids, action, **extra):
    return client.post(bulk_url(event.id), json={"ids": ids, "action": action, **extra}, headers=admin_headers)


def test_bulk_deactivate_and_activate(client, admin_headers, db, bulk_setup):
    event, _, mine, foreign = bulk_setup
    ids = [q.id for q in mine[:3]] + [foreign.id, 987654]  # a foreign id and a missing id are ignored
    response = post_bulk(client, admin_headers, event, ids, "deactivate")
    assert response.status_code == 200 and response.json() == {"affected": 3}
    state = {q.id: q.is_active for q in db.scalars(select(Question))}
    assert [state[q.id] for q in mine] == [False, False, False, True] and state[foreign.id] is True
    assert post_bulk(client, admin_headers, event, [mine[0].id], "activate").json() == {"affected": 1}
    db.expire_all()
    assert db.get(Question, mine[0].id).is_active is True


def test_bulk_set_difficulty(client, admin_headers, db, bulk_setup):
    event, _, mine, foreign = bulk_setup
    response = post_bulk(client, admin_headers, event, [mine[0].id, mine[1].id, foreign.id], "set_difficulty", difficulty=3)
    assert response.json() == {"affected": 2}
    assert [db.get(Question, q.id).difficulty for q in (*mine[:2], mine[2], foreign)] == [3, 3, 1, 1]
    assert post_bulk(client, admin_headers, event, [mine[0].id], "set_difficulty").status_code == 422  # missing value
    assert post_bulk(client, admin_headers, event, [mine[0].id], "set_difficulty", difficulty=9).status_code == 422


def test_bulk_set_category(client, admin_headers, db, bulk_setup, make_category, make_event):
    event, category, mine, foreign = bulk_setup
    ids = [q.id for q in mine[:2]]
    assert post_bulk(client, admin_headers, event, ids, "set_category", category_id=category.id).json() == {"affected": 2}
    assert [db.get(Question, i).category_id for i in ids] == [category.id, category.id]
    # null un-categorises
    assert post_bulk(client, admin_headers, event, ids[:1], "set_category", category_id=None).json() == {"affected": 1}
    assert db.get(Question, ids[0]).category_id is None
    # the category must exist in THIS event; and the argument is mandatory
    foreign_category = make_category(make_event(), name="Elsewhere")
    assert post_bulk(client, admin_headers, event, ids, "set_category", category_id=foreign_category.id).status_code == 422
    assert post_bulk(client, admin_headers, event, ids, "set_category", category_id=99999).status_code == 422
    assert post_bulk(client, admin_headers, event, ids, "set_category").status_code == 422
    assert db.get(Question, ids[1]).category_id == category.id  # the refused calls changed nothing


def test_bulk_delete_removes_questions_and_their_answers(client, admin_headers, db, bulk_setup, make_game_session):
    event, _, mine, foreign = bulk_setup
    session = make_game_session(event, answers=[{"question": mine[0], "player_answer": "green"}, {"question": mine[3], "player_answer": "green"}])
    ids = [q.id for q in mine]
    foreign_id, session_id = foreign.id, session.id
    doomed = [ids[0], ids[1], foreign_id]
    assert post_bulk(client, admin_headers, event, doomed, "delete").json() == {"affected": 2}
    assert db.get(Question, ids[0]) is None and db.get(Question, ids[1]) is None
    assert db.get(Question, foreign_id) is not None  # other events are never touched
    assert [a.question_id for a in db.scalars(select(GameAnswer).where(GameAnswer.game_session_id == session_id))] == [ids[3]]


def test_bulk_handles_duplicates_and_validation(client, admin_headers, bulk_setup):
    event, _, mine, _ = bulk_setup
    assert post_bulk(client, admin_headers, event, [mine[0].id] * 5, "deactivate").json() == {"affected": 1}
    assert post_bulk(client, admin_headers, event, [], "delete").status_code == 422
    assert post_bulk(client, admin_headers, event, [mine[0].id], "explode").status_code == 422
    assert post_bulk(client, admin_headers, event, ["abc"], "delete").status_code == 422
    assert post_bulk(client, admin_headers, event, list(range(1, 5002)), "delete").status_code == 422
    assert client.post(bulk_url(999), json={"ids": [1], "action": "delete"}, headers=admin_headers).status_code == 404


def test_bulk_with_many_ids(client, admin_headers, db, make_event, make_question):
    event = make_event()
    created = [make_question(event) for _ in range(300)]
    ids = [q.id for q in created]
    assert post_bulk(client, admin_headers, event, ids, "deactivate").json() == {"affected": 300}
    assert db_count(db, Question, is_active=False) == 300


# ---------------------------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------------------------
def test_import_csv_creates_questions_and_categories(client, admin_headers, db, make_event):
    event = make_event()
    response = upload(client, admin_headers, event.id, (FIXTURES / "legacy_questions.csv").read_bytes())
    assert response.status_code == 200, response.text
    assert response.json() == {"created": 14, "skipped_duplicates": 0, "categories_created": 4, "errors": [], "dry_run": False}
    assert db_count(db, Question, event_id=event.id) == 14 and db_count(db, Category, event_id=event.id) == 4
    # visible through the list API
    body = client.get(list_url(event.id, "?limit=100"), headers=admin_headers).json()
    assert body["total"] == 14 and body["items"][0]["category"]["name"] == "REST API"


def test_import_csv_dry_run_writes_nothing(client, admin_headers, db, make_event):
    event = make_event()
    content = (FIXTURES / "legacy_questions.csv").read_bytes()
    dry = upload(client, admin_headers, event.id, content, "?dry_run=true").json()
    assert (dry["created"], dry["categories_created"], dry["dry_run"]) == (14, 4, True)
    assert db_count(db, Question) == 0 and db_count(db, Category) == 0
    real = upload(client, admin_headers, event.id, content).json()
    assert (real["created"], real["categories_created"], real["dry_run"]) == (14, 4, False)
    again = upload(client, admin_headers, event.id, content, "?dry_run=true").json()
    assert (again["created"], again["skipped_duplicates"]) == (0, 14)  # a dry run sees the duplicates


def test_import_csv_semicolon_with_bom(client, admin_headers, db, make_event):
    event = make_event()
    response = upload(client, admin_headers, event.id, (FIXTURES / "questions_semicolon_bom.csv").read_bytes())
    assert response.json()["created"] == 3 and response.json()["categories_created"] == 2
    items = client.get(list_url(event.id, "?include_inactive=true&search=proxy"), headers=admin_headers).json()["items"]
    assert items[0]["question_format"] == "two_choices" and items[0]["category"]["name"] == "IA générative"


def test_import_csv_reports_row_errors_but_imports_the_valid_rows(client, admin_headers, db, make_event):
    event = make_event()
    content = (
        b"category,difficulty,question_text_en,correct_answer\n"
        b"AI,1,Valid one?,green\n"
        b"AI,zero,Bad difficulty?,green\n"
        b"AI,2,Valid two?,red\n"
        b"AI,2,Bad answer?,perhaps\n"
        b",1,,green\n"
    )
    body = upload(client, admin_headers, event.id, content).json()
    assert body["created"] == 2
    assert [e["row"] for e in body["errors"]] == [3, 5, 6]  # spreadsheet rows: header = 1
    assert "difficulty" in body["errors"][0]["message"] and "correct_answer" in body["errors"][1]["message"]
    assert db_count(db, Question) == 2


def test_import_csv_skips_duplicates(client, admin_headers, make_event, make_question):
    event = make_event()
    make_question(event, question_text_en="Already here?")
    content = b"question_text_en,correct_answer\nalready   HERE?,green\nNew one?,green\nnew one?,red\n"
    body = upload(client, admin_headers, event.id, content).json()
    assert (body["created"], body["skipped_duplicates"]) == (1, 2)


@pytest.mark.parametrize(
    "content,expected",
    [
        (b"", "empty"),
        (b"\n\n", "empty"),
        (b"foo,bar\n1,2\n", "Missing required column"),
        (b"category,difficulty\nAI,1\n", "question_text_en"),
        ("category,question_text_en,correct_answer\nAI,Café?,green\n".encode("cp1252"), "UTF-8"),
        (b"\xff\xfe\x00\x00binary", "UTF-8"),
    ],
)
def test_import_csv_unusable_files_are_400_with_a_message(client, admin_headers, db, make_event, content, expected):
    event = make_event()
    response = upload(client, admin_headers, event.id, content)
    assert response.status_code == 400 and expected in response.json()["detail"]
    assert db_count(db, Question) == 0


def test_import_csv_requires_a_file_and_a_known_event(client, admin_headers, make_event):
    event = make_event()
    assert client.post(import_url(event.id), headers=admin_headers).status_code == 422
    assert client.post(import_url(event.id), data={"file": "not a file"}, headers=admin_headers).status_code == 422
    assert upload(client, admin_headers, 999, b"question_text_en,correct_answer\nQ?,green\n").status_code == 404


def test_import_csv_size_limit(client, admin_headers, make_event, monkeypatch):
    event = make_event()
    monkeypatch.setattr(admin_questions, "MAX_CSV_BYTES", 50)
    monkeypatch.setattr(csv_io, "MAX_CSV_BYTES", 50)
    big = b"question_text_en,correct_answer\n" + b"A fairly long question text?,green\n" * 5
    assert upload(client, admin_headers, event.id, big).status_code == 413


def test_import_csv_quoted_multiline_cells(client, admin_headers, db, make_event):
    event = make_event()
    content = b'category,question_text_en,correct_answer,explanation_en\r\nAI,"Line one\r\nline two, with a comma?",green,"He said ""yes"""\r\n'
    assert upload(client, admin_headers, event.id, content).json()["created"] == 1
    q = db.scalars(select(Question)).one()
    assert q.question_text_en == "Line one\r\nline two, with a comma?" and q.explanation_en == 'He said "yes"'


# ---------------------------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------------------------
def test_export_csv_headers_and_content(client, admin_headers, make_event, make_category, make_question):
    event = make_event(slug="csv-export")
    category = make_category(event, name="Gravitee")
    make_question(event, category, question_text_en="One?", question_text_fr="Un ? é")
    make_question(event, None, question_text_en="Two?", is_active=False, question_format="two_choices")
    response = client.get(f"/api/admin/events/{event.id}/questions/export.csv", headers=admin_headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == 'attachment; filename="csv-export-questions.csv"'
    assert response.content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
    assert rows[0] == [
        "category", "difficulty", "question_text_en", "question_text_fr", "correct_answer", "green_label_en",
        "green_label_fr", "red_label_en", "red_label_fr", "explanation_en", "explanation_fr", "question_format", "is_active",
    ]
    assert len(rows) == 3 and rows[1][0] == "Gravitee" and rows[1][3] == "Un ? é" and rows[2][11] == "two_choices"
    assert client.get("/api/admin/events/999/questions/export.csv", headers=admin_headers).status_code == 404


def test_export_csv_includes_inactive_and_only_this_event(client, admin_headers, make_event, make_question):
    event, other = make_event(), make_event()
    make_question(event, is_active=False)
    make_question(other)
    rows = list(csv.reader(io.StringIO(client.get(f"/api/admin/events/{event.id}/questions/export.csv", headers=admin_headers).content.decode("utf-8-sig"))))
    assert len(rows) == 2 and rows[1][12] == "false"


def test_export_then_import_into_another_event_round_trips(client, admin_headers, db, make_event):
    source, target = make_event(), make_event()
    for fixture in ("legacy_questions.csv", "questions_semicolon_bom.csv"):
        upload(client, admin_headers, source.id, (FIXTURES / fixture).read_bytes())
    exported = client.get(f"/api/admin/events/{source.id}/questions/export.csv", headers=admin_headers).content
    result = upload(client, admin_headers, target.id, exported).json()
    assert result["created"] == 17 and result["errors"] == [] and result["categories_created"] == 6

    def snapshot(event_id):
        body = client.get(list_url(event_id, "?include_inactive=true&limit=100"), headers=admin_headers).json()
        return [
            {k: v for k, v in item.items() if k not in ("id", "event_id", "category_id", "created_at", "updated_at", "category")}
            | {"category": item["category"]["name"] if item["category"] else None}
            for item in body["items"]
        ]

    assert snapshot(target.id) == snapshot(source.id)
    # importing the export into its own event is a no-op
    again = upload(client, admin_headers, source.id, exported).json()
    assert (again["created"], again["skipped_duplicates"]) == (0, 17)
