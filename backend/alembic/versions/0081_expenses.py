"""Household expenses: categories, fixed expenses and the expenses of each month.

Revision ID: 0081_expenses
Revises: 0080_user_mfa
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0081_expenses"
down_revision: Union[str, None] = "0080_user_mfa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "expense_categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("family_id", sa.Integer(), sa.ForeignKey("families.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("family_id", "name", name="uq_expense_category_name"),
    )
    op.create_index("ix_expense_categories_family_id", "expense_categories", ["family_id"])

    op.create_table(
        "fixed_expenses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("family_id", sa.Integer(), sa.ForeignKey("families.id", ondelete="CASCADE"), nullable=False),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("expense_categories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("due_day", sa.Integer(), nullable=True),
        sa.Column("starts_on", sa.Date(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_fixed_expenses_family_id", "fixed_expenses", ["family_id"])

    op.create_table(
        "expenses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("family_id", sa.Integer(), sa.ForeignKey("families.id", ondelete="CASCADE"), nullable=False),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("expense_categories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("fixed_expense_id", sa.Integer(), sa.ForeignKey("fixed_expenses.id", ondelete="SET NULL"), nullable=True),
        sa.Column("paid_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("description", sa.String(160), nullable=False),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("spent_on", sa.Date(), nullable=False),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False, server_default="variable"),
        sa.Column("paid", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("skipped", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("notes", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("fixed_expense_id", "period", name="uq_expense_fixed_period"),
    )
    op.create_index("ix_expenses_family_period", "expenses", ["family_id", "period"])


def downgrade() -> None:
    op.drop_index("ix_expenses_family_period", table_name="expenses")
    op.drop_table("expenses")
    op.drop_index("ix_fixed_expenses_family_id", table_name="fixed_expenses")
    op.drop_table("fixed_expenses")
    op.drop_index("ix_expense_categories_family_id", table_name="expense_categories")
    op.drop_table("expense_categories")
