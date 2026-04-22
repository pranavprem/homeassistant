from __future__ import annotations

import json
import ssl
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class GrocyClientStatus:
    base_url: str
    api_key_configured: bool
    timeout_seconds: float
    verify_ssl: bool


class GrocyClientError(Exception):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class GrocyConfigurationError(GrocyClientError):
    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message
            or "GROCY_API_KEY is not configured. Create a Grocy API key in the web UI and add it to .env.",
            status_code=503,
        )


class GrocyClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None,
        timeout_seconds: float,
        verify_ssl: bool,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.verify_ssl = verify_ssl

        self._ssl_context = ssl.create_default_context()
        if not verify_ssl:
            self._ssl_context.check_hostname = False
            self._ssl_context.verify_mode = ssl.CERT_NONE

    def status(self) -> GrocyClientStatus:
        return GrocyClientStatus(
            base_url=self.base_url,
            api_key_configured=bool(self.api_key),
            timeout_seconds=self.timeout_seconds,
            verify_ssl=self.verify_ssl,
        )

    def shopping_capabilities(self) -> dict[str, Any]:
        api_key_configured = bool(self.api_key)
        return {
            "source_of_truth": "Grocy",
            "reads_ready": api_key_configured,
            "writes_ready": api_key_configured,
            "notes": [
                "Shopping reads and writes flow through Grocy's API.",
                "Use /shopping/products/search to resolve Grocy product ids before importing free-form Notion items.",
                (
                    "Live sync is enabled."
                    if api_key_configured
                    else "Create a Grocy API key in the web UI and set GROCY_API_KEY in .env to enable live sync."
                ),
            ],
        }

    def get_shopping_lists(self) -> list[dict[str, Any]]:
        return self.get_objects("shopping_lists", order="name:asc")

    def get_shopping_items(self, *, list_id: int | None = None) -> list[dict[str, Any]]:
        query: list[str] = []
        if list_id is not None:
            query.append(f"shopping_list_id={list_id}")

        items = self.get_objects("shopping_list", query=query or None, order="id:asc")
        list_lookup = {item["id"]: item for item in self.get_shopping_lists()}
        return [self._enrich_shopping_item(item, list_lookup) for item in items]

    def get_shopping_item(self, item_id: int) -> dict[str, Any]:
        item = self.get_object("shopping_list", item_id)
        list_lookup = {entry["id"]: entry for entry in self.get_shopping_lists()}
        return self._enrich_shopping_item(item, list_lookup)

    def search_products(self, name: str, *, limit: int = 10) -> list[dict[str, Any]]:
        products = self.get_objects(
            "products",
            query=[f"name~{name}", "active=1"],
            limit=limit,
            order="name:asc",
        )
        return [
            {
                "id": product["id"],
                "name": product["name"],
                "qu_id_stock": product.get("qu_id_stock"),
                "qu_id_purchase": product.get("qu_id_purchase"),
                "active": bool(product.get("active", 1)),
            }
            for product in products
        ]

    def add_shopping_item(
        self,
        *,
        product_id: int | None = None,
        product_name: str | None = None,
        product_amount: float = 1,
        list_id: int = 1,
        qu_id: int | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        product = self.resolve_product(product_id=product_id, product_name=product_name)
        payload: dict[str, Any] = {
            "product_id": product["id"],
            "list_id": list_id,
            "product_amount": product_amount,
        }
        if qu_id is not None:
            payload["qu_id"] = qu_id
        if note:
            payload["note"] = note

        self._request_json(
            "POST",
            "/api/stock/shoppinglist/add-product",
            data=payload,
            allow_empty=True,
        )

        item = self._find_shopping_item(product_id=product["id"], list_id=list_id)
        return {"product": product, "item": item}

    def update_shopping_item(
        self,
        item_id: int,
        *,
        product_amount: float | None = None,
        note: str | None = None,
        qu_id: int | None = None,
        done: bool | None = None,
        list_id: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if product_amount is not None:
            payload["amount"] = product_amount
        if note is not None:
            payload["note"] = note
        if qu_id is not None:
            payload["qu_id"] = qu_id
        if done is not None:
            payload["done"] = 1 if done else 0
        if list_id is not None:
            payload["shopping_list_id"] = list_id

        if not payload:
            raise GrocyClientError("Provide at least one field to update", status_code=400)

        self._request_json(
            "PUT",
            f"/api/objects/shopping_list/{item_id}",
            data=payload,
            allow_empty=True,
        )
        return self.get_shopping_item(item_id)

    def delete_shopping_item(self, item_id: int) -> None:
        self._request_json(
            "DELETE",
            f"/api/objects/shopping_list/{item_id}",
            allow_empty=True,
        )

    def resolve_product(
        self,
        *,
        product_id: int | None = None,
        product_name: str | None = None,
    ) -> dict[str, Any]:
        if product_id is not None:
            return self.get_object("products", product_id)

        if not product_name:
            raise GrocyClientError("Provide either product_id or product_name", status_code=400)

        products = self.search_products(product_name, limit=10)
        exact_matches = [
            product for product in products if product["name"].casefold() == product_name.casefold()
        ]

        if len(exact_matches) == 1:
            return exact_matches[0]
        if len(exact_matches) > 1:
            raise GrocyClientError(
                f'Product name "{product_name}" matched multiple Grocy products. Use product_id instead.',
                status_code=409,
            )
        if len(products) == 1:
            return products[0]
        if not products:
            raise GrocyClientError(
                f'No active Grocy product matched "{product_name}".',
                status_code=404,
            )

        matches = ", ".join(product["name"] for product in products[:5])
        raise GrocyClientError(
            f'Product name "{product_name}" matched multiple Grocy products: {matches}. Use product_id instead.',
            status_code=409,
        )

    def get_objects(
        self,
        entity: str,
        *,
        query: list[str] | None = None,
        limit: int | None = None,
        order: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if query:
            params["query"] = query
        if limit is not None:
            params["limit"] = limit
        if order:
            params["order"] = order

        data = self._request_json("GET", f"/api/objects/{entity}", query=params or None)
        if isinstance(data, list):
            return data
        raise GrocyClientError(f"Unexpected Grocy response for entity list: {entity}")

    def get_object(self, entity: str, object_id: int) -> dict[str, Any]:
        data = self._request_json("GET", f"/api/objects/{entity}/{object_id}")
        if isinstance(data, dict):
            return data
        raise GrocyClientError(f"Unexpected Grocy response for entity object: {entity}/{object_id}")

    def create_object(self, entity: str, data: dict[str, Any]) -> int:
        result = self._request_json("POST", f"/api/objects/{entity}", data=data)
        if not isinstance(result, dict) or "created_object_id" not in result:
            raise GrocyClientError(
                f"Unexpected Grocy response creating {entity}: {result!r}"
            )
        return int(result["created_object_id"])

    def update_object(self, entity: str, object_id: int, data: dict[str, Any]) -> None:
        self._request_json(
            "PUT",
            f"/api/objects/{entity}/{object_id}",
            data=data,
            allow_empty=True,
        )

    def get_product_stock_entries(self, product_id: int) -> list[dict[str, Any]]:
        data = self._request_json(
            "GET",
            f"/api/stock/products/{product_id}/entries",
        )
        if isinstance(data, list):
            return data
        raise GrocyClientError(
            f"Unexpected Grocy response for stock entries: product {product_id}"
        )

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
        payload: dict[str, Any] = {
            "amount": amount,
            "purchased_date": purchased_date,
        }
        if location_id is not None:
            payload["location_id"] = location_id
        if shopping_location_id is not None:
            payload["shopping_location_id"] = shopping_location_id
        if note:
            payload["note"] = note
        self._request_json(
            "POST",
            f"/api/stock/products/{product_id}/add",
            data=payload,
            allow_empty=True,
        )

    def _enrich_shopping_item(
        self,
        item: dict[str, Any],
        list_lookup: dict[int, dict[str, Any]],
    ) -> dict[str, Any]:
        product = None
        qu = None

        product_id = item.get("product_id")
        if product_id:
            try:
                product = self.get_object("products", int(product_id))
            except GrocyClientError:
                product = None

        qu_id = item.get("qu_id")
        if qu_id:
            try:
                qu = self.get_object("quantity_units", int(qu_id))
            except GrocyClientError:
                qu = None

        shopping_list_id = int(item["shopping_list_id"])
        shopping_list = list_lookup.get(shopping_list_id)

        return {
            "id": int(item["id"]),
            "product_id": int(item["product_id"]),
            "product_name": product.get("name") if product else None,
            "amount": float(item.get("amount", 0)),
            "note": item.get("note") or None,
            "done": (bool(item.get("done")) if item.get("done") is not None else None),
            "qu_id": int(qu_id) if qu_id is not None else None,
            "qu_name": qu.get("name") if qu else None,
            "shopping_list_id": shopping_list_id,
            "list_name": shopping_list.get("name") if shopping_list else None,
        }

    def _find_shopping_item(self, *, product_id: int, list_id: int) -> dict[str, Any] | None:
        items = self.get_shopping_items(list_id=list_id)
        matches = [item for item in items if item["product_id"] == product_id]
        if not matches:
            return None
        return sorted(matches, key=lambda item: item["id"])[-1]

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        data: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        allow_empty: bool = False,
    ) -> Any:
        self._require_api_key()

        encoded_query = ""
        if query:
            query_pairs: list[tuple[str, Any]] = []
            for key, value in query.items():
                if isinstance(value, list):
                    query_pairs.extend((f"{key}[]", item) for item in value)
                else:
                    query_pairs.append((key, value))
            encoded_query = "?" + urlencode(query_pairs)

        body = None
        if data is not None:
            body = json.dumps(data).encode("utf-8")

        request = Request(
            url=f"{self.base_url}{path}{encoded_query}",
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "GROCY-API-KEY": self.api_key or "",
            },
        )

        try:
            with urlopen(
                request,
                timeout=self.timeout_seconds,
                context=self._ssl_context,
            ) as response:
                payload = response.read()
        except HTTPError as exc:
            detail = self._extract_error_message(exc.read())
            status_code = exc.code if exc.code < 500 else 502
            raise GrocyClientError(detail, status_code=status_code) from exc
        except URLError as exc:
            raise GrocyClientError(f"Could not reach Grocy: {exc.reason}", status_code=502) from exc

        if allow_empty and not payload:
            return None
        if not payload:
            return None

        try:
            return json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise GrocyClientError("Grocy returned invalid JSON", status_code=502) from exc

    def _require_api_key(self) -> None:
        if not self.api_key:
            raise GrocyConfigurationError()

    @staticmethod
    def _extract_error_message(payload: bytes) -> str:
        if not payload:
            return "Grocy returned an empty error response"

        try:
            data = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            return payload.decode("utf-8", errors="replace")

        if isinstance(data, dict):
            return data.get("error_message") or data.get("message") or json.dumps(data)
        return json.dumps(data)
