"""Smoke tests for the Grocy migration apply logic.

Uses an in-memory fake Grocy backend that mimics the shape of the endpoints
our GrocyClient uses during migration. The goal is to prove:
  1. A fresh apply creates every declared object.
  2. A second apply on the same bundle is a no-op (idempotent).
  3. Stock baselines only add the missing amount, never duplicate.

Run directly from the services/homebutler directory:
    python -m tests.test_grocy_migration
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Make ``app`` importable when the test is run as a script from this directory.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.services.grocy_migration import apply_migration  # noqa: E402


class FakeGrocy:
    """Minimal in-memory Grocy stand-in for the endpoints migration touches."""

    def __init__(self) -> None:
        self._tables: dict[str, list[dict[str, Any]]] = {}
        self._next_ids: dict[str, int] = {}
        self._stock: dict[int, list[dict[str, Any]]] = {}
        self.stock_adds: list[dict[str, Any]] = []

    def _next_id(self, entity: str) -> int:
        current = self._next_ids.get(entity, 0) + 1
        self._next_ids[entity] = current
        return current

    def get_objects(self, entity: str, **_: Any) -> list[dict[str, Any]]:
        return [dict(row) for row in self._tables.get(entity, [])]

    def create_object(self, entity: str, data: dict[str, Any]) -> int:
        object_id = self._next_id(entity)
        row = {"id": object_id, **data}
        self._tables.setdefault(entity, []).append(row)
        return object_id

    def update_object(self, entity: str, object_id: int, data: dict[str, Any]) -> None:
        for row in self._tables.get(entity, []):
            if int(row["id"]) == int(object_id):
                row.update(data)
                return
        raise AssertionError(f"update_object on missing row: {entity}/{object_id}")

    def get_product_stock_entries(self, product_id: int) -> list[dict[str, Any]]:
        return [dict(row) for row in self._stock.get(product_id, [])]

    def add_product_stock(
        self,
        product_id: int,
        *,
        amount: float,
        purchased_date: str,
        location_id: int | None = None,
        shopping_location_id: int | None = None,
        note: str | None = None,
    ) -> None:
        self._stock.setdefault(product_id, []).append({"amount": amount})
        self.stock_adds.append(
            {
                "product_id": product_id,
                "amount": amount,
                "purchased_date": purchased_date,
                "location_id": location_id,
                "shopping_location_id": shopping_location_id,
                "note": note,
            }
        )


def _sample_bundle() -> dict[str, Any]:
    return {
        "quantity_units": [
            {"name": "Piece", "name_plural": "Pieces"},
            {"name": "Cup", "name_plural": "Cups"},
        ],
        "locations": [{"name": "Pantry", "is_freezer": 0}],
        "shopping_locations": [{"name": "Costco"}],
        "task_categories": [{"name": "Household", "description": "Chores"}],
        "chores": [
            {
                "name": "Dishes",
                "description": "Every 2 days",
                "period_type": "daily",
                "period_interval": 2,
                "start_date": "2026-04-21 20:00:00",
            }
        ],
        "tasks": [
            {
                "name": "Renew registration",
                "description": "DMV",
                "due_date": "2026-06-01",
                "category": "Household",
            }
        ],
        "equipment": [{"name": "Washer"}],
        "products": [
            {
                "name": "Oats",
                "description": "Rolled oats",
                "location": "Pantry",
                "shopping_location": "Costco",
                "qu": "Cup",
                "min_stock_amount": 2,
                "stock_amount": 4,
            }
        ],
        "recipes": [
            {
                "name": "Oatmeal",
                "description": "Simple oatmeal",
                "base_servings": 2,
                "ingredients": [{"product": "Oats", "amount": 1, "qu": "Cup"}],
            }
        ],
        "meal_plan": [
            {
                "type": "recipe",
                "day": "2026-04-22",
                "recipe": "Oatmeal",
                "servings": 2,
                "note": "breakfast",
            }
        ],
    }


def test_apply_is_idempotent() -> None:
    fake = FakeGrocy()
    bundle = _sample_bundle()

    first = apply_migration(fake, bundle, purchased_date="2026-04-21")
    assert first.products == 1, first
    assert first.stock_topped_up == 1, first
    assert abs(first.stock_topped_up_amount - 4.0) < 1e-6, first
    assert len(fake.stock_adds) == 1, fake.stock_adds

    second = apply_migration(fake, bundle, purchased_date="2026-04-21")
    assert second.stock_topped_up == 0, second
    assert len(fake.stock_adds) == 1, fake.stock_adds

    # Every named table should still have exactly one row of each declared name.
    assert len(fake.get_objects("quantity_units")) == 2
    assert len(fake.get_objects("locations")) == 1
    assert len(fake.get_objects("products")) == 1
    assert len(fake.get_objects("recipes")) == 1
    assert len(fake.get_objects("recipes_pos")) == 1
    assert len(fake.get_objects("meal_plan")) == 1


def test_stock_tops_up_missing_amount_only() -> None:
    fake = FakeGrocy()
    bundle = _sample_bundle()

    apply_migration(fake, bundle, purchased_date="2026-04-21")

    bundle["products"][0]["stock_amount"] = 6
    second = apply_migration(fake, bundle, purchased_date="2026-04-21")

    assert second.stock_topped_up == 1, second
    assert abs(second.stock_topped_up_amount - 2.0) < 1e-6, second
    assert len(fake.stock_adds) == 2, fake.stock_adds
    assert abs(fake.stock_adds[-1]["amount"] - 2.0) < 1e-6


def main() -> int:
    test_apply_is_idempotent()
    test_stock_tops_up_missing_amount_only()
    print("grocy_migration smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
