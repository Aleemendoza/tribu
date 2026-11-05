"""Integration tests for the household expenses module."""

import hashlib
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import ExpenseCategory, Family, Membership, PersonalAccessToken, User
from app.modules import expenses_router
from app.security import PAT_PREFIX, hash_password

engine = create_engine("sqlite:///./test-expenses.db", connect_args={"check_same_thread": False})
TestSession = sessionmaker(bind=engine, autoflush=False)
TODAY = date(2026, 11, 15)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(bind=engine)

    def _override():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override
    monkeypatch.setattr(expenses_router, "local_today", lambda: TODAY)
    yield
    app.dependency_overrides.pop(get_db, None)
    Base.metadata.drop_all(bind=engine)


def _member(db, family_id, name, adult=True):
    user = User(email=f"{name}@example.com", password_hash=hash_password("p"), display_name=name)
    db.add(user)
    db.flush()
    db.add(Membership(user_id=user.id, family_id=family_id, role="admin" if adult else "member", is_adult=adult))
    plain = f"{PAT_PREFIX}{name}"
    digest = hashlib.sha256(plain.encode("utf-8")).hexdigest()
    db.add(PersonalAccessToken(
        user_id=user.id, name=name, token_hash=digest, token_lookup=digest,
        scopes="expenses:read,expenses:write",
    ))
    return plain, user.id


@pytest.fixture
def ctx():
    db = TestSession()
    try:
        family = Family(name="Casa")
        other = Family(name="Otra")
        db.add_all([family, other])
        db.flush()
        adult, adult_id = _member(db, family.id, "ale")
        child, _ = _member(db, family.id, "peque", adult=False)
        stranger, _ = _member(db, other.id, "ajena")
        db.commit()
        return {
            "family": family.id, "other": other.id, "adult": adult, "adult_id": adult_id,
            "child": child, "stranger": stranger,
        }
    finally:
        db.close()


@pytest.fixture
def client():
    return TestClient(app)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _expense(client, ctx, **fields):
    body = {"family_id": ctx["family"], "description": "Pan", "amount_cents": 150000, "spent_on": "2026-11-03", **fields}
    resp = client.post("/expenses", json=body, headers=_h(ctx["adult"]))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _fixed(client, ctx, **fields):
    body = {
        "family_id": ctx["family"], "name": "Alquiler", "amount_cents": 40000000, "due_day": 10,
        "starts_on": "2026-10-01", **fields,
    }
    resp = client.post("/expenses/fixed", json=body, headers=_h(ctx["adult"]))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _month(client, ctx, year=2026, month=11):
    resp = client.get(f"/expenses?family_id={ctx['family']}&year={year}&month={month}", headers=_h(ctx["adult"]))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _report(client, ctx, year=2026):
    resp = client.get(f"/expenses/report?family_id={ctx['family']}&year={year}", headers=_h(ctx["adult"]))
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_children_and_other_families_are_refused(client, ctx):
    url = f"/expenses?family_id={ctx['family']}&year=2026&month=11"
    assert client.get(url, headers=_h(ctx["child"])).status_code == 403
    assert client.get(url, headers=_h(ctx["stranger"])).status_code == 403
    fixed = f"/expenses/fixed?family_id={ctx['family']}"
    assert client.get(fixed, headers=_h(ctx["child"])).status_code == 403


def test_expense_from_another_family_cannot_be_touched(client, ctx):
    created = _expense(client, ctx)
    url = f"/expenses/{created['id']}"
    assert client.patch(url, json={"amount_cents": 1}, headers=_h(ctx["stranger"])).status_code == 404
    assert client.delete(url, headers=_h(ctx["stranger"])).status_code == 404


def test_categories_start_with_defaults_and_are_editable(client, ctx):
    url = f"/expenses/categories?family_id={ctx['family']}"
    names = [c["name"] for c in client.get(url, headers=_h(ctx["adult"])).json()]
    assert "Servicios" in names and "Otros" in names

    body = {"family_id": ctx["family"], "name": "Mascotas"}
    made = client.post("/expenses/categories", json=body, headers=_h(ctx["adult"]))
    assert made.status_code == 200
    duplicate = client.post("/expenses/categories", json={**body, "name": "mascotas"}, headers=_h(ctx["adult"]))
    assert duplicate.status_code == 409

    cat = made.json()["id"]
    renamed = client.patch(f"/expenses/categories/{cat}", json={"name": "Perro"}, headers=_h(ctx["adult"]))
    assert renamed.json()["name"] == "Perro"
    expense = _expense(client, ctx, category_id=cat)
    assert client.delete(f"/expenses/categories/{cat}", headers=_h(ctx["adult"])).status_code == 200
    item = next(i for i in _month(client, ctx)["items"] if i["id"] == expense["id"])
    assert item["category_id"] is None


def test_category_of_another_family_is_refused(client, ctx):
    db = TestSession()
    foreign = ExpenseCategory(family_id=ctx["other"], name="Ajena")
    db.add(foreign)
    db.commit()
    foreign_id = foreign.id
    db.close()
    body = {
        "family_id": ctx["family"], "description": "x", "amount_cents": 1,
        "spent_on": "2026-11-01", "category_id": foreign_id,
    }
    assert client.post("/expenses", json=body, headers=_h(ctx["adult"])).status_code == 404


def test_amounts_above_a_32_bit_integer_are_kept(client, ctx):
    created = _expense(client, ctx, amount_cents=5_000_000_000)
    assert created["amount_cents"] == 5_000_000_000
    assert _month(client, ctx)["summary"]["total_cents"] == 5_000_000_000


def test_negative_amount_is_rejected(client, ctx):
    body = {"family_id": ctx["family"], "description": "x", "amount_cents": -1, "spent_on": "2026-11-01"}
    assert client.post("/expenses", json=body, headers=_h(ctx["adult"])).status_code == 422


def test_month_lists_only_that_month_with_a_summary(client, ctx):
    _expense(client, ctx, amount_cents=1000, paid=True)
    _expense(client, ctx, amount_cents=500, paid=False)
    _expense(client, ctx, amount_cents=9999, spent_on="2026-10-31")
    data = _month(client, ctx)
    assert len(data["items"]) == 2
    assert data["summary"] == {
        "total_cents": 1500, "fixed_cents": 0, "variable_cents": 1500, "pending_cents": 500,
    }


def test_moving_an_expense_to_another_month_moves_it(client, ctx):
    created = _expense(client, ctx)
    moved = client.patch(f"/expenses/{created['id']}", json={"spent_on": "2026-10-20"}, headers=_h(ctx["adult"]))
    assert moved.status_code == 200
    assert _month(client, ctx)["items"] == []
    assert [i["id"] for i in _month(client, ctx, month=10)["items"]] == [created["id"]]


def test_fixed_appears_once_as_pending_in_each_month(client, ctx):
    _fixed(client, ctx)
    first = _month(client, ctx)
    second = _month(client, ctx)
    assert [i["id"] for i in first["items"]] == [i["id"] for i in second["items"]]
    item = first["items"][0]
    assert item["kind"] == "fixed" and item["paid"] is False and item["description"] == "Alquiler"
    assert item["spent_on"] == "2026-11-10"
    assert first["summary"]["fixed_cents"] == 40000000
    assert first["summary"]["pending_cents"] == 40000000


def test_fixed_does_not_appear_before_it_starts_or_in_future_months(client, ctx):
    _fixed(client, ctx)
    assert _month(client, ctx, month=9)["items"] == []
    assert _month(client, ctx, month=12)["items"] == []


def test_due_day_is_clamped_to_short_months(client, ctx):
    _fixed(client, ctx, due_day=31, starts_on="2026-02-01")
    assert _month(client, ctx, month=2)["items"][0]["spent_on"] == "2026-02-28"


def test_real_amount_of_a_month_does_not_change_the_fixed_or_other_months(client, ctx):
    fixed = _fixed(client, ctx)
    november = _month(client, ctx)["items"][0]
    resp = client.patch(
        f"/expenses/{november['id']}", json={"amount_cents": 45000000, "paid": True}, headers=_h(ctx["adult"]),
    )
    assert resp.status_code == 200
    assert _month(client, ctx)["summary"]["pending_cents"] == 0
    assert _month(client, ctx, month=10)["items"][0]["amount_cents"] == fixed["amount_cents"]


def test_new_amount_of_a_fixed_only_applies_to_months_not_generated_yet(client, ctx):
    fixed = _fixed(client, ctx)
    _month(client, ctx)
    client.patch(f"/expenses/fixed/{fixed['id']}", json={"amount_cents": 1}, headers=_h(ctx["adult"]))
    assert _month(client, ctx)["items"][0]["amount_cents"] == 40000000
    assert _month(client, ctx, month=10)["items"][0]["amount_cents"] == 1


def test_deleted_month_of_a_fixed_does_not_come_back(client, ctx):
    _fixed(client, ctx)
    item = _month(client, ctx)["items"][0]
    assert client.delete(f"/expenses/{item['id']}", headers=_h(ctx["adult"])).status_code == 200
    assert _month(client, ctx)["items"] == []
    assert _report(client, ctx)["months"][10]["total_cents"] == 0


def test_inactive_and_deleted_fixed_stop_generating_but_keep_history(client, ctx):
    paused = _fixed(client, ctx, name="Gimnasio")
    client.patch(f"/expenses/fixed/{paused['id']}", json={"active": False}, headers=_h(ctx["adult"]))
    assert _month(client, ctx)["items"] == []

    gone = _fixed(client, ctx, name="Cable", starts_on="2026-11-01")
    kept = _month(client, ctx)["items"][0]
    assert client.delete(f"/expenses/fixed/{gone['id']}", headers=_h(ctx["adult"])).status_code == 200
    assert [i["id"] for i in _month(client, ctx)["items"]] == [kept["id"]]


def test_list_of_fixed_only_shows_this_family(client, ctx):
    _fixed(client, ctx)
    data = client.get(f"/expenses/fixed?family_id={ctx['family']}", headers=_h(ctx["adult"])).json()
    assert [f["name"] for f in data] == ["Alquiler"]


def test_yearly_report_by_month_and_category(client, ctx):
    cats = client.get(f"/expenses/categories?family_id={ctx['family']}", headers=_h(ctx["adult"])).json()
    home = next(c for c in cats if c["name"] == "Vivienda")["id"]
    _fixed(client, ctx, category_id=home)
    _expense(client, ctx, amount_cents=1000, spent_on="2026-03-05", paid=True)
    _expense(client, ctx, amount_cents=1000, spent_on="2025-03-05", paid=True)
    report = _report(client, ctx)

    assert report["year"] == 2026
    assert report["months"][2]["total_cents"] == 1000
    assert report["months"][9]["fixed_cents"] == 40000000
    assert report["months"][10]["pending_cents"] == 40000000
    assert report["months"][11]["total_cents"] == 0
    assert report["total_cents"] == 80001000
    assert report["monthly_average_cents"] == 80001000 // 3

    home_row = next(r for r in report["categories"] if r["category_id"] == home)
    assert home_row["name"] == "Vivienda" and home_row["total_cents"] == 80000000
    assert len(home_row["months"]) == 12
    none_row = next(r for r in report["categories"] if r["category_id"] is None)
    assert none_row["months"][2] == 1000


def test_report_generates_fixed_of_months_nobody_opened(client, ctx):
    _fixed(client, ctx)
    assert _report(client, ctx)["total_cents"] == 80000000


def test_dollars_are_totalled_apart_from_pesos(client, ctx):
    _expense(client, ctx, amount_cents=100000, spent_on="2026-11-05")
    _expense(client, ctx, amount_cents=1999, currency="USD", spent_on="2026-11-05")
    data = _month(client, ctx)
    assert {row["currency"] for row in data["items"]} == {"ARS", "USD"}
    assert data["summary"]["total_cents"] == 100000
    assert data["summary_usd"]["total_cents"] == 1999


def test_unknown_currency_is_rejected(client, ctx):
    resp = client.post(
        "/expenses",
        json={"family_id": ctx["family"], "description": "x", "amount_cents": 1, "spent_on": "2026-11-05", "currency": "EUR"},
        headers=_h(ctx["adult"]),
    )
    assert resp.status_code == 422


def test_subscription_in_dollars_keeps_its_currency_every_month(client, ctx):
    _fixed(client, ctx, name="Streaming", amount_cents=1599, currency="USD")
    data = _month(client, ctx)
    streaming = next(row for row in data["items"] if row["description"] == "Streaming")
    assert streaming["currency"] == "USD"
    assert data["summary"]["total_cents"] == 0
    assert data["summary_usd"]["pending_cents"] == 1599


def test_yearly_report_is_by_currency(client, ctx):
    _expense(client, ctx, amount_cents=100000, spent_on="2026-03-05")
    _expense(client, ctx, amount_cents=1999, currency="USD", spent_on="2026-03-05")
    assert _report(client, ctx)["total_cents"] == 100000
    resp = client.get(f"/expenses/report?family_id={ctx['family']}&year=2026&currency=USD", headers=_h(ctx["adult"]))
    assert resp.status_code == 200
    usd = resp.json()
    assert usd["currency"] == "USD"
    assert usd["total_cents"] == 1999
    assert usd["months"][2]["variable_cents"] == 1999


def test_invalid_month_is_rejected(client, ctx):
    resp = client.get(f"/expenses?family_id={ctx['family']}&year=2026&month=13", headers=_h(ctx["adult"]))
    assert resp.status_code == 422


def test_paid_by_must_belong_to_the_family(client, ctx):
    body = {
        "family_id": ctx["family"], "description": "x", "amount_cents": 1,
        "spent_on": "2026-11-01", "paid_by_user_id": 9999,
    }
    assert client.post("/expenses", json=body, headers=_h(ctx["adult"])).status_code == 400
    assert _expense(client, ctx, paid_by_user_id=ctx["adult_id"])["paid_by_user_id"] == ctx["adult_id"]
