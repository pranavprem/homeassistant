"""Idempotent Grocy migration apply logic.

Applies a declarative migration bundle to Grocy via the existing GrocyClient.
Designed so the same bundle can be re-applied safely: named objects match by
normalized name, meal-plan entries match by (day, type, note, recipe/product),
and stock only tops up missing amounts against the target baseline.

The supported bundle shape mirrors the reference migration script in
workspace/temp/grocy_migration_2026_04_21.py but lives in this repo so the
HomeButler service can apply it locally over the automation network.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.clients.grocy import GrocyClient, GrocyClientError

# Grocy stock comparisons: anything below this threshold is treated as equal.
_STOCK_EPSILON = 1e-4


@dataclass
class MigrationSummary:
    quantity_units: int = 0
    locations: int = 0
    shopping_locations: int = 0
    task_categories: int = 0
    chores: int = 0
    tasks: int = 0
    equipment: int = 0
    products: int = 0
    recipes: int = 0
    recipe_ingredients: int = 0
    meal_plan_entries: int = 0
    stock_topped_up: int = 0
    stock_topped_up_amount: float = 0.0
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "quantity_units": self.quantity_units,
            "locations": self.locations,
            "shopping_locations": self.shopping_locations,
            "task_categories": self.task_categories,
            "chores": self.chores,
            "tasks": self.tasks,
            "equipment": self.equipment,
            "products": self.products,
            "recipes": self.recipes,
            "recipe_ingredients": self.recipe_ingredients,
            "meal_plan_entries": self.meal_plan_entries,
            "stock_topped_up": self.stock_topped_up,
            "stock_topped_up_amount": round(self.stock_topped_up_amount, 4),
            "warnings": list(self.warnings),
        }


class MigrationError(Exception):
    """Raised when the migration payload is invalid or cannot be applied."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _normalize(text: Any) -> str:
    return " ".join(str(text or "").strip().casefold().split())


def _require(payload: dict[str, Any], key: str, item_type: str) -> Any:
    if key not in payload:
        raise MigrationError(f"{item_type} is missing required field '{key}'")
    return payload[key]


class _EntityCache:
    """Per-apply cache of Grocy object lists to avoid refetching between steps."""

    def __init__(self, client: GrocyClient) -> None:
        self._client = client
        self._cache: dict[str, list[dict[str, Any]]] = {}

    def list(self, entity: str, *, refresh: bool = False) -> list[dict[str, Any]]:
        if refresh or entity not in self._cache:
            self._cache[entity] = self._client.get_objects(entity)
        return self._cache[entity]

    def invalidate(self, entity: str) -> None:
        self._cache.pop(entity, None)

    def find_by_name(self, entity: str, name: str) -> dict[str, Any] | None:
        target = _normalize(name)
        for row in self.list(entity):
            if _normalize(row.get("name")) == target:
                return row
        return None


def _diff_has_changes(existing: dict[str, Any], desired: dict[str, Any]) -> bool:
    for key, value in desired.items():
        if existing.get(key) != value:
            return True
    return False


def _ensure_named_object(
    client: GrocyClient,
    cache: _EntityCache,
    entity: str,
    data: dict[str, Any],
) -> int:
    name = _require(data, "name", entity)
    payload = {k: v for k, v in data.items() if v is not None}
    existing = cache.find_by_name(entity, name)
    if existing:
        object_id = int(existing["id"])
        if _diff_has_changes(existing, payload):
            client.update_object(entity, object_id, payload)
            cache.invalidate(entity)
        return object_id
    object_id = client.create_object(entity, payload)
    cache.invalidate(entity)
    return object_id


def _ensure_chore(client: GrocyClient, cache: _EntityCache, chore: dict[str, Any]) -> int:
    payload = {
        "name": _require(chore, "name", "chore"),
        "description": chore.get("description"),
        "period_type": _require(chore, "period_type", "chore"),
        "period_interval": _require(chore, "period_interval", "chore"),
        "start_date": _require(chore, "start_date", "chore"),
        "track_date_only": chore.get("track_date_only", 1),
        "active": chore.get("active", 1),
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    return _ensure_named_object(client, cache, "chores", payload)


def _ensure_task(
    client: GrocyClient,
    cache: _EntityCache,
    task: dict[str, Any],
    category_ids: dict[str, int],
) -> int:
    category_name = _require(task, "category", "task")
    if category_name not in category_ids:
        raise MigrationError(
            f"Task '{task.get('name')}' references unknown category '{category_name}'"
        )
    payload = {
        "name": _require(task, "name", "task"),
        "description": task.get("description"),
        "due_date": task.get("due_date"),
        "category_id": category_ids[category_name],
        "done": task.get("done", 0),
    }
    return _ensure_named_object(
        client,
        cache,
        "tasks",
        {k: v for k, v in payload.items() if v is not None},
    )


def _ensure_product(
    client: GrocyClient,
    cache: _EntityCache,
    product: dict[str, Any],
    *,
    location_id: int,
    shopping_location_id: int,
    qu_id: int,
) -> int:
    payload = {
        "name": _require(product, "name", "product"),
        "description": product.get("description"),
        "location_id": location_id,
        "shopping_location_id": shopping_location_id,
        "qu_id_purchase": qu_id,
        "qu_id_stock": qu_id,
        "qu_id_consume": qu_id,
        "qu_id_price": qu_id,
        "min_stock_amount": product.get("min_stock_amount", 0),
        "active": product.get("active", 1),
    }
    return _ensure_named_object(
        client,
        cache,
        "products",
        {k: v for k, v in payload.items() if v is not None},
    )


def _ensure_recipe(client: GrocyClient, cache: _EntityCache, recipe: dict[str, Any]) -> int:
    base_servings = _require(recipe, "base_servings", "recipe")
    payload = {
        "name": _require(recipe, "name", "recipe"),
        "description": recipe.get("description"),
        "base_servings": base_servings,
        "desired_servings": recipe.get("desired_servings", base_servings),
        "type": recipe.get("type", "normal"),
    }
    return _ensure_named_object(
        client,
        cache,
        "recipes",
        {k: v for k, v in payload.items() if v is not None},
    )


def _ensure_recipe_ingredient(
    client: GrocyClient,
    cache: _EntityCache,
    *,
    recipe_id: int,
    product_id: int,
    amount: float,
    qu_id: int,
) -> int:
    payload = {
        "recipe_id": recipe_id,
        "product_id": product_id,
        "amount": amount,
        "qu_id": qu_id,
    }

    existing_rows = [
        row
        for row in cache.list("recipes_pos")
        if int(row.get("recipe_id") or 0) == recipe_id
        and int(row.get("product_id") or 0) == product_id
    ]
    if existing_rows:
        object_id = int(existing_rows[0]["id"])
        if _diff_has_changes(existing_rows[0], payload):
            client.update_object("recipes_pos", object_id, payload)
            cache.invalidate("recipes_pos")
        return object_id

    object_id = client.create_object("recipes_pos", payload)
    cache.invalidate("recipes_pos")
    return object_id


def _ensure_stock_baseline(
    client: GrocyClient,
    *,
    product_id: int,
    target_amount: float,
    location_id: int,
    shopping_location_id: int,
    product_name: str,
    purchased_date: str,
) -> float:
    try:
        entries = client.get_product_stock_entries(product_id)
    except GrocyClientError as exc:
        raise MigrationError(
            f"Failed to read stock for product '{product_name}': {exc}",
            status_code=exc.status_code,
        ) from exc

    current = 0.0
    for row in entries:
        try:
            current += float(row.get("amount") or 0)
        except (TypeError, ValueError):
            continue

    missing = round(float(target_amount) - current, 4)
    if missing <= _STOCK_EPSILON:
        return 0.0

    client.add_product_stock(
        product_id,
        amount=missing,
        purchased_date=purchased_date,
        location_id=location_id,
        shopping_location_id=shopping_location_id,
        note=f"HomeButler migration baseline for {product_name}",
    )
    return missing


def _ensure_meal_plan_entry(
    client: GrocyClient,
    cache: _EntityCache,
    entry: dict[str, Any],
    *,
    recipe_id: int | None = None,
    product_id: int | None = None,
    product_qu_id: int | None = None,
) -> int:
    entry_type = _require(entry, "type", "meal_plan entry")
    day = _require(entry, "day", "meal_plan entry")
    note = entry.get("note") or ""

    payload: dict[str, Any] = {
        "day": day,
        "type": entry_type,
        "note": note,
        "section_id": entry.get("section_id", -1),
        "done": entry.get("done", 0),
    }
    if entry_type == "recipe":
        payload["recipe_id"] = recipe_id
        payload["recipe_servings"] = _require(entry, "servings", "meal_plan recipe entry")
    elif entry_type == "product":
        payload["product_id"] = product_id
        payload["product_amount"] = _require(entry, "amount", "meal_plan product entry")
        payload["product_qu_id"] = product_qu_id
    else:
        raise MigrationError(
            f"Unsupported meal_plan entry type '{entry_type}' (expected 'recipe' or 'product')"
        )

    match = None
    for row in cache.list("meal_plan"):
        if row.get("day") != payload["day"]:
            continue
        if row.get("type") != payload["type"]:
            continue
        if (row.get("note") or "") != payload["note"]:
            continue
        if entry_type == "recipe" and int(row.get("recipe_id") or 0) == int(recipe_id or 0):
            match = row
            break
        if entry_type == "product" and int(row.get("product_id") or 0) == int(product_id or 0):
            match = row
            break

    if match:
        object_id = int(match["id"])
        if _diff_has_changes(match, payload):
            client.update_object("meal_plan", object_id, payload)
            cache.invalidate("meal_plan")
        return object_id

    object_id = client.create_object("meal_plan", payload)
    cache.invalidate("meal_plan")
    return object_id


def apply_migration(
    client: GrocyClient,
    bundle: dict[str, Any],
    *,
    purchased_date: str | None = None,
) -> MigrationSummary:
    """Apply the migration bundle idempotently. Missing sections are skipped."""

    summary = MigrationSummary()
    cache = _EntityCache(client)
    today = purchased_date or date.today().isoformat()

    unit_ids: dict[str, int] = {}
    for row in bundle.get("quantity_units", []) or []:
        unit_ids[row["name"]] = _ensure_named_object(client, cache, "quantity_units", row)
        summary.quantity_units += 1

    location_ids: dict[str, int] = {}
    for row in bundle.get("locations", []) or []:
        location_ids[row["name"]] = _ensure_named_object(client, cache, "locations", row)
        summary.locations += 1

    shopping_location_ids: dict[str, int] = {}
    for row in bundle.get("shopping_locations", []) or []:
        shopping_location_ids[row["name"]] = _ensure_named_object(
            client, cache, "shopping_locations", row
        )
        summary.shopping_locations += 1

    category_ids: dict[str, int] = {}
    for row in bundle.get("task_categories", []) or []:
        category_ids[row["name"]] = _ensure_named_object(
            client, cache, "task_categories", row
        )
        summary.task_categories += 1

    for row in bundle.get("chores", []) or []:
        _ensure_chore(client, cache, row)
        summary.chores += 1

    for row in bundle.get("tasks", []) or []:
        _ensure_task(client, cache, row, category_ids)
        summary.tasks += 1

    for row in bundle.get("equipment", []) or []:
        _ensure_named_object(client, cache, "equipment", row)
        summary.equipment += 1

    product_ids: dict[str, int] = {}
    for row in bundle.get("products", []) or []:
        location_name = _require(row, "location", "product")
        shopping_name = _require(row, "shopping_location", "product")
        qu_name = _require(row, "qu", "product")
        if location_name not in location_ids:
            raise MigrationError(
                f"Product '{row.get('name')}' references unknown location '{location_name}'"
            )
        if shopping_name not in shopping_location_ids:
            raise MigrationError(
                f"Product '{row.get('name')}' references unknown shopping_location '{shopping_name}'"
            )
        if qu_name not in unit_ids:
            raise MigrationError(
                f"Product '{row.get('name')}' references unknown quantity unit '{qu_name}'"
            )

        product_id = _ensure_product(
            client,
            cache,
            row,
            location_id=location_ids[location_name],
            shopping_location_id=shopping_location_ids[shopping_name],
            qu_id=unit_ids[qu_name],
        )
        product_ids[row["name"]] = product_id
        summary.products += 1

        target_stock = row.get("stock_amount")
        if target_stock is not None:
            added = _ensure_stock_baseline(
                client,
                product_id=product_id,
                target_amount=float(target_stock),
                location_id=location_ids[location_name],
                shopping_location_id=shopping_location_ids[shopping_name],
                product_name=row["name"],
                purchased_date=today,
            )
            if added > 0:
                summary.stock_topped_up += 1
                summary.stock_topped_up_amount += added

    recipe_ids: dict[str, int] = {}
    for row in bundle.get("recipes", []) or []:
        recipe_id = _ensure_recipe(client, cache, row)
        recipe_ids[row["name"]] = recipe_id
        summary.recipes += 1
        for ingredient in row.get("ingredients", []) or []:
            ingredient_product = _require(ingredient, "product", "recipe ingredient")
            ingredient_qu = _require(ingredient, "qu", "recipe ingredient")
            if ingredient_product not in product_ids:
                raise MigrationError(
                    f"Recipe '{row.get('name')}' references unknown product '{ingredient_product}'"
                )
            if ingredient_qu not in unit_ids:
                raise MigrationError(
                    f"Recipe '{row.get('name')}' references unknown quantity unit '{ingredient_qu}'"
                )
            _ensure_recipe_ingredient(
                client,
                cache,
                recipe_id=recipe_id,
                product_id=product_ids[ingredient_product],
                amount=float(_require(ingredient, "amount", "recipe ingredient")),
                qu_id=unit_ids[ingredient_qu],
            )
            summary.recipe_ingredients += 1

    for row in bundle.get("meal_plan", []) or []:
        entry_type = _require(row, "type", "meal_plan entry")
        if entry_type == "recipe":
            recipe_name = _require(row, "recipe", "meal_plan recipe entry")
            if recipe_name not in recipe_ids:
                raise MigrationError(
                    f"Meal plan entry on {row.get('day')} references unknown recipe '{recipe_name}'"
                )
            _ensure_meal_plan_entry(client, cache, row, recipe_id=recipe_ids[recipe_name])
        else:
            product_name = _require(row, "product", "meal_plan product entry")
            qu_name = _require(row, "qu", "meal_plan product entry")
            if product_name not in product_ids:
                raise MigrationError(
                    f"Meal plan entry on {row.get('day')} references unknown product '{product_name}'"
                )
            if qu_name not in unit_ids:
                raise MigrationError(
                    f"Meal plan entry on {row.get('day')} references unknown quantity unit '{qu_name}'"
                )
            _ensure_meal_plan_entry(
                client,
                cache,
                row,
                product_id=product_ids[product_name],
                product_qu_id=unit_ids[qu_name],
            )
        summary.meal_plan_entries += 1

    return summary
