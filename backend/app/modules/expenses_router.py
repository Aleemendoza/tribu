"""Household expenses: what the family spends, month by month.

Fixed expenses (rent, electricity) are templates: each month they appear once
as a pending expense, whose real amount can then be adjusted without touching
the template or other months. Months are generated when someone looks at them,
and only up to the current month. An expense keeps the month it belongs to in
``period``, so totals by month need no date arithmetic in the database.

Money belongs to the adults: children and other families are refused.
"""

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.clock import local_today
from app.core.deps import current_user, ensure_adult
from app.core.errors import (
    EXPENSE_CATEGORY_EXISTS,
    EXPENSE_CATEGORY_NOT_FOUND,
    EXPENSE_NOT_FOUND,
    EXPENSE_PAYER_NOT_MEMBER,
    FIXED_EXPENSE_NOT_FOUND,
    error_detail,
)
from app.core.scopes import require_scope
from app.database import get_db
from app.models import Expense, ExpenseCategory, FixedExpense, Membership, User
from app.schemas import (
    AUTH_RESPONSES,
    ExpenseCategoryCreate,
    ExpenseCategoryResponse,
    ExpenseCategoryUpdate,
    ExpenseCreate,
    ExpenseMonthResponse,
    ExpenseReportResponse,
    ExpenseResponse,
    ExpenseUpdate,
    FixedExpenseCreate,
    FixedExpenseResponse,
    FixedExpenseUpdate,
)

router = APIRouter(prefix="/expenses", tags=["expenses"], responses={**AUTH_RESPONSES})

DEFAULT_CATEGORIES = (
    "Vivienda", "Servicios", "Supermercado", "Transporte", "Salud", "Educación", "Impuestos", "Ocio", "Otros",
)
UNCATEGORIZED = "Sin categoría"


def _period_of(day: date) -> date:
    return day.replace(day=1)


def _category_or_404(db: Session, family_id: int, category_id):
    if category_id is None:
        return None
    category = db.query(ExpenseCategory).filter(
        ExpenseCategory.id == category_id, ExpenseCategory.family_id == family_id,
    ).first()
    if not category:
        raise HTTPException(status_code=404, detail=error_detail(EXPENSE_CATEGORY_NOT_FOUND))
    return category


def _check_payer(db: Session, family_id: int, user_id) -> None:
    if user_id is None:
        return
    member = db.query(Membership).filter(Membership.family_id == family_id, Membership.user_id == user_id).first()
    if not member:
        raise HTTPException(status_code=400, detail=error_detail(EXPENSE_PAYER_NOT_MEMBER))


def _owned(db: Session, model, item_id: int, user: User, not_found: str):
    """The row, if it belongs to a family where this user is an adult.

    Any other family's row looks like a missing one.
    """
    row = db.query(model).filter(model.id == item_id).first()
    if row:
        member = db.query(Membership).filter(
            Membership.family_id == row.family_id, Membership.user_id == user.id,
        ).first()
        if member:
            ensure_adult(db, user.id, row.family_id)
            return row
    raise HTTPException(status_code=404, detail=error_detail(not_found))


def _generate_month(db: Session, family_id: int, period: date) -> None:
    """Add this month's fixed expenses that are still missing."""
    if period > _period_of(local_today()):
        return
    fixed = db.query(FixedExpense).filter(
        FixedExpense.family_id == family_id, FixedExpense.active.is_(True), FixedExpense.starts_on <= period,
    ).all()
    if not fixed:
        return
    # Deleted months stay as skipped rows, so they are found here too.
    present = {
        row[0]
        for row in db.query(Expense.fixed_expense_id).filter(
            Expense.family_id == family_id, Expense.period == period, Expense.fixed_expense_id.isnot(None),
        )
    }
    last_day = calendar.monthrange(period.year, period.month)[1]
    added = False
    for item in fixed:
        if item.id in present:
            continue
        db.add(Expense(
            family_id=family_id,
            category_id=item.category_id,
            fixed_expense_id=item.id,
            description=item.name,
            amount_cents=item.amount_cents,
            spent_on=period.replace(day=min(item.due_day or 1, last_day)),
            period=period,
            kind="fixed",
            paid=False,
            notes=item.notes,
        ))
        added = True
    if added:
        try:
            db.commit()
        except IntegrityError:
            # Someone else opened the same month at the same moment.
            db.rollback()


def _summary(rows) -> dict:
    fixed = sum(row.amount_cents for row in rows if row.kind == "fixed")
    variable = sum(row.amount_cents for row in rows if row.kind != "fixed")
    return {
        "total_cents": fixed + variable,
        "fixed_cents": fixed,
        "variable_cents": variable,
        "pending_cents": sum(row.amount_cents for row in rows if not row.paid),
    }


# ── Categories ──────────────────────────────────────────────


@router.get("/categories", response_model=list[ExpenseCategoryResponse], summary="List expense categories")
def list_categories(
    family_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:read"),
):
    ensure_adult(db, user.id, family_id)
    query = db.query(ExpenseCategory).filter(ExpenseCategory.family_id == family_id)
    if not query.first():
        db.add_all(ExpenseCategory(family_id=family_id, name=name) for name in DEFAULT_CATEGORIES)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    return query.order_by(func.lower(ExpenseCategory.name)).all()


def _refuse_duplicate(db: Session, family_id: int, name: str, keep_id=None) -> None:
    query = db.query(ExpenseCategory).filter(
        ExpenseCategory.family_id == family_id, func.lower(ExpenseCategory.name) == name.lower(),
    )
    if keep_id is not None:
        query = query.filter(ExpenseCategory.id != keep_id)
    if query.first():
        raise HTTPException(status_code=409, detail=error_detail(EXPENSE_CATEGORY_EXISTS))


@router.post("/categories", response_model=ExpenseCategoryResponse, summary="Create an expense category")
def create_category(
    payload: ExpenseCategoryCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    ensure_adult(db, user.id, payload.family_id)
    name = payload.name.strip()
    _refuse_duplicate(db, payload.family_id, name)
    category = ExpenseCategory(family_id=payload.family_id, name=name)
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


@router.patch("/categories/{category_id}", response_model=ExpenseCategoryResponse, summary="Rename an expense category")
def update_category(
    category_id: int,
    payload: ExpenseCategoryUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    category = _owned(db, ExpenseCategory, category_id, user, EXPENSE_CATEGORY_NOT_FOUND)
    name = payload.name.strip()
    _refuse_duplicate(db, category.family_id, name, keep_id=category.id)
    category.name = name
    db.commit()
    db.refresh(category)
    return category


@router.delete("/categories/{category_id}", summary="Delete an expense category; its expenses stay without one")
def delete_category(
    category_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    category = _owned(db, ExpenseCategory, category_id, user, EXPENSE_CATEGORY_NOT_FOUND)
    db.query(Expense).filter(Expense.category_id == category.id).update(
        {Expense.category_id: None}, synchronize_session=False,
    )
    db.query(FixedExpense).filter(FixedExpense.category_id == category.id).update(
        {FixedExpense.category_id: None}, synchronize_session=False,
    )
    db.delete(category)
    db.commit()
    return {"status": "deleted"}


# ── Fixed expenses ──────────────────────────────────────────


@router.get("/fixed", response_model=list[FixedExpenseResponse], summary="List fixed expenses")
def list_fixed(
    family_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:read"),
):
    ensure_adult(db, user.id, family_id)
    return db.query(FixedExpense).filter(FixedExpense.family_id == family_id).order_by(
        FixedExpense.active.desc(), func.lower(FixedExpense.name),
    ).all()


@router.post("/fixed", response_model=FixedExpenseResponse, summary="Create a fixed expense")
def create_fixed(
    payload: FixedExpenseCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    ensure_adult(db, user.id, payload.family_id)
    _category_or_404(db, payload.family_id, payload.category_id)
    data = payload.model_dump()
    data["starts_on"] = _period_of(payload.starts_on or local_today())
    item = FixedExpense(**data)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/fixed/{fixed_id}", response_model=FixedExpenseResponse, summary="Update a fixed expense")
def update_fixed(
    fixed_id: int,
    payload: FixedExpenseUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    item = _owned(db, FixedExpense, fixed_id, user, FIXED_EXPENSE_NOT_FOUND)
    changes = payload.model_dump(exclude_unset=True)
    if "category_id" in changes:
        _category_or_404(db, item.family_id, changes["category_id"])
    if changes.get("starts_on"):
        changes["starts_on"] = _period_of(changes["starts_on"])
    for key, value in changes.items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/fixed/{fixed_id}", summary="Delete a fixed expense; months already generated stay")
def delete_fixed(
    fixed_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    item = _owned(db, FixedExpense, fixed_id, user, FIXED_EXPENSE_NOT_FOUND)
    db.query(Expense).filter(Expense.fixed_expense_id == item.id).update(
        {Expense.fixed_expense_id: None}, synchronize_session=False,
    )
    db.delete(item)
    db.commit()
    return {"status": "deleted"}


# ── Yearly report ───────────────────────────────────────────


@router.get("/report", response_model=ExpenseReportResponse, summary="Yearly report by month and category")
def yearly_report(
    family_id: int,
    year: int = Query(ge=2000, le=2100),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:read"),
):
    ensure_adult(db, user.id, family_id)
    for month in range(1, 13):
        _generate_month(db, family_id, date(year, month, 1))

    rows = db.query(Expense).filter(
        Expense.family_id == family_id,
        Expense.skipped.is_(False),
        Expense.period >= date(year, 1, 1),
        Expense.period <= date(year, 12, 1),
    ).all()
    names = {
        category.id: category.name
        for category in db.query(ExpenseCategory).filter(ExpenseCategory.family_id == family_id)
    }

    months = []
    per_category: dict = {}
    for month in range(1, 13):
        in_month = [row for row in rows if row.period.month == month]
        months.append({"month": month, **_summary(in_month)})
        for row in in_month:
            per_category.setdefault(row.category_id, [0] * 12)[month - 1] += row.amount_cents

    categories = [
        {
            "category_id": category_id,
            "name": names.get(category_id, UNCATEGORIZED),
            "months": amounts,
            "total_cents": sum(amounts),
        }
        for category_id, amounts in per_category.items()
    ]
    categories.sort(key=lambda row: row["total_cents"], reverse=True)

    total = sum(month["total_cents"] for month in months)
    used = sum(1 for month in months if month["total_cents"] > 0)
    return {
        "year": year,
        "months": months,
        "categories": categories,
        "total_cents": total,
        "monthly_average_cents": total // used if used else 0,
    }


# ── Expenses of a month ─────────────────────────────────────


@router.get("", response_model=ExpenseMonthResponse, summary="Expenses of one month, with totals")
def list_month(
    family_id: int,
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:read"),
):
    ensure_adult(db, user.id, family_id)
    period = date(year, month, 1)
    _generate_month(db, family_id, period)
    items = db.query(Expense).filter(
        Expense.family_id == family_id, Expense.period == period, Expense.skipped.is_(False),
    ).order_by(Expense.spent_on, Expense.id).all()
    return {"year": year, "month": month, "items": items, "summary": _summary(items)}


@router.post("", response_model=ExpenseResponse, summary="Add an expense")
def create_expense(
    payload: ExpenseCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    ensure_adult(db, user.id, payload.family_id)
    _category_or_404(db, payload.family_id, payload.category_id)
    _check_payer(db, payload.family_id, payload.paid_by_user_id)
    expense = Expense(
        **payload.model_dump(),
        period=_period_of(payload.spent_on),
        created_by_user_id=user.id,
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense


@router.patch("/{expense_id}", response_model=ExpenseResponse, summary="Update an expense")
def update_expense(
    expense_id: int,
    payload: ExpenseUpdate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    expense = _owned(db, Expense, expense_id, user, EXPENSE_NOT_FOUND)
    changes = payload.model_dump(exclude_unset=True)
    if "category_id" in changes:
        _category_or_404(db, expense.family_id, changes["category_id"])
    if "paid_by_user_id" in changes:
        _check_payer(db, expense.family_id, changes["paid_by_user_id"])
    for key, value in changes.items():
        setattr(expense, key, value)
    # A fixed expense stays in its month, so that month is not generated again.
    if expense.fixed_expense_id is None:
        expense.period = _period_of(expense.spent_on)
    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/{expense_id}", summary="Delete an expense")
def delete_expense(
    expense_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    _scope=require_scope("expenses:write"),
):
    expense = _owned(db, Expense, expense_id, user, EXPENSE_NOT_FOUND)
    if expense.fixed_expense_id is not None:
        # Remember the month was removed, or it would be generated again.
        expense.skipped = True
    else:
        db.delete(expense)
    db.commit()
    return {"status": "deleted"}
