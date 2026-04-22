from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from app.clients.grocy import GrocyClient, GrocyClientError
from app.config import Settings, get_settings
from app.schemas import (
    GrocySummary,
    ProductSearchResponse,
    ProductSummary,
    ShoppingContractResponse,
    ShoppingItemDraft,
    ShoppingItemMutationResponse,
    ShoppingItemSummary,
    ShoppingItemUpdate,
    ShoppingItemsResponse,
    ShoppingListSummary,
    ShoppingListsResponse,
)

router = APIRouter(prefix="/shopping", tags=["shopping"])


def _get_client(settings: Settings) -> GrocyClient:
    return GrocyClient(
        base_url=settings.grocy_base_url,
        api_key=settings.grocy_api_key,
        timeout_seconds=settings.grocy_timeout_seconds,
        verify_ssl=settings.grocy_verify_ssl,
    )


def _get_grocy_summary(client: GrocyClient) -> GrocySummary:
    status_info = client.status()
    return GrocySummary(
        base_url=status_info.base_url,
        api_key_configured=status_info.api_key_configured,
        timeout_seconds=status_info.timeout_seconds,
        verify_ssl=status_info.verify_ssl,
    )


def _raise_http(exc: GrocyClientError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("", response_model=ShoppingContractResponse)
def get_shopping_contract() -> ShoppingContractResponse:
    settings = get_settings()
    client = _get_client(settings)
    capabilities = client.shopping_capabilities()
    api_key_configured = client.status().api_key_configured

    return ShoppingContractResponse(
        status=("ready" if api_key_configured else "needs-api-key"),
        reads_ready=capabilities["reads_ready"],
        writes_ready=capabilities["writes_ready"],
        next_step=(
            "Create a Grocy API key in the web UI, add it to .env as GROCY_API_KEY, then restart HomeButler."
            if not api_key_configured
            else "Grocy shopping sync is enabled. Use /shopping/lists, /shopping/items, and /shopping/products/search."
        ),
        notes=capabilities["notes"],
        grocy=_get_grocy_summary(client),
    )


@router.get("/lists", response_model=ShoppingListsResponse)
def get_shopping_lists() -> ShoppingListsResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        shopping_lists = client.get_shopping_lists()
    except GrocyClientError as exc:
        _raise_http(exc)

    return ShoppingListsResponse(
        count=len(shopping_lists),
        lists=[ShoppingListSummary(**item) for item in shopping_lists],
    )


@router.get("/items", response_model=ShoppingItemsResponse)
def get_shopping_items(
    list_id: int | None = Query(default=None, ge=1),
) -> ShoppingItemsResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        items = client.get_shopping_items(list_id=list_id)
    except GrocyClientError as exc:
        _raise_http(exc)

    return ShoppingItemsResponse(
        count=len(items),
        list_id=list_id,
        items=[ShoppingItemSummary(**item) for item in items],
    )


@router.get("/products/search", response_model=ProductSearchResponse)
def search_products(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
) -> ProductSearchResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        products = client.search_products(q, limit=limit)
    except GrocyClientError as exc:
        _raise_http(exc)

    return ProductSearchResponse(
        query=q,
        count=len(products),
        products=[ProductSummary(**item) for item in products],
    )


@router.post(
    "/items",
    response_model=ShoppingItemMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_shopping_item(draft: ShoppingItemDraft) -> ShoppingItemMutationResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        result = client.add_shopping_item(
            product_id=draft.product_id,
            product_name=draft.product_name,
            product_amount=draft.product_amount,
            list_id=draft.list_id,
            qu_id=draft.qu_id,
            note=draft.note,
        )
    except GrocyClientError as exc:
        _raise_http(exc)

    product = result.get("product") or {}
    item = result.get("item") or {}

    return ShoppingItemMutationResponse(
        status="created",
        message="Added item to Grocy shopping list",
        list_id=draft.list_id,
        product_id=product.get("id"),
        product_name=product.get("name"),
        item_id=item.get("id"),
    )


@router.patch("/items/{item_id}", response_model=ShoppingItemMutationResponse)
def update_shopping_item(
    item_id: int,
    patch: ShoppingItemUpdate,
) -> ShoppingItemMutationResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        item = client.update_shopping_item(
            item_id,
            product_amount=patch.product_amount,
            note=patch.note,
            qu_id=patch.qu_id,
            done=patch.done,
            list_id=patch.list_id,
        )
    except GrocyClientError as exc:
        _raise_http(exc)

    return ShoppingItemMutationResponse(
        status="updated",
        message="Updated Grocy shopping list item",
        list_id=item.get("shopping_list_id"),
        product_id=item.get("product_id"),
        product_name=item.get("product_name"),
        item_id=item.get("id"),
    )


@router.delete("/items/{item_id}", response_model=ShoppingItemMutationResponse)
def delete_shopping_item(item_id: int) -> ShoppingItemMutationResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        item = client.get_shopping_item(item_id)
        client.delete_shopping_item(item_id)
    except GrocyClientError as exc:
        _raise_http(exc)

    return ShoppingItemMutationResponse(
        status="deleted",
        message="Deleted Grocy shopping list item",
        list_id=item.get("shopping_list_id"),
        product_id=item.get("product_id"),
        product_name=item.get("product_name"),
        item_id=item_id,
    )
