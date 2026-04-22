from __future__ import annotations

from pydantic import BaseModel, Field, model_validator


class GrocySummary(BaseModel):
    base_url: str
    api_key_configured: bool
    timeout_seconds: float
    verify_ssl: bool
    state_owner: str = "Grocy"


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str
    environment: str
    version: str
    grocy: GrocySummary


class HttpSummary(BaseModel):
    host: str
    port: int
    docs_url: str = "/docs"


class ConfigResponse(BaseModel):
    service: str
    environment: str
    service_role: str
    household_state_owner: str
    http: HttpSummary
    grocy: GrocySummary
    controlled_containers: list[str] = Field(default_factory=list)


class ContainerSummary(BaseModel):
    name: str
    image: str
    state: str
    status: str
    health: str | None = None


class ContainerListResponse(BaseModel):
    count: int
    containers: list[ContainerSummary]


class ContainerDetailResponse(BaseModel):
    container: ContainerSummary


class ContainerLogsResponse(BaseModel):
    name: str
    tail: int
    logs: str


class ContainerMutationResponse(BaseModel):
    status: str
    message: str
    container: ContainerSummary


class ShoppingContractResponse(BaseModel):
    source_of_truth: str = "Grocy"
    status: str
    reads_ready: bool
    writes_ready: bool
    next_step: str
    notes: list[str] = Field(default_factory=list)
    grocy: GrocySummary


class ShoppingListSummary(BaseModel):
    id: int
    name: str
    description: str | None = None


class ShoppingListsResponse(BaseModel):
    count: int
    lists: list[ShoppingListSummary]


class ShoppingItemSummary(BaseModel):
    id: int
    product_id: int
    product_name: str | None = None
    amount: float
    note: str | None = None
    done: bool | None = None
    qu_id: int | None = None
    qu_name: str | None = None
    shopping_list_id: int
    list_name: str | None = None


class ShoppingItemsResponse(BaseModel):
    count: int
    list_id: int | None = None
    items: list[ShoppingItemSummary]


class ProductSummary(BaseModel):
    id: int
    name: str
    qu_id_stock: int | None = None
    qu_id_purchase: int | None = None
    active: bool | None = None


class ProductSearchResponse(BaseModel):
    query: str
    count: int
    products: list[ProductSummary]


class ShoppingItemDraft(BaseModel):
    product_id: int | None = Field(default=None, ge=1)
    product_name: str | None = Field(default=None, min_length=1)
    product_amount: float = Field(
        default=1,
        gt=0,
        description="Amount to add, in Grocy's stock unit for the product",
    )
    list_id: int = Field(default=1, ge=1)
    qu_id: int | None = Field(default=None, ge=1)
    note: str | None = None
    captured_from: str | None = Field(
        default="manual",
        description="Source label such as manual, chat, or migration",
    )

    @model_validator(mode="after")
    def validate_product_reference(self) -> "ShoppingItemDraft":
        if self.product_id is None and not self.product_name:
            raise ValueError("Provide either product_id or product_name")
        return self


class ShoppingItemUpdate(BaseModel):
    product_amount: float | None = Field(default=None, gt=0)
    note: str | None = None
    qu_id: int | None = Field(default=None, ge=1)
    done: bool | None = None
    list_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_has_changes(self) -> "ShoppingItemUpdate":
        if all(
            value is None
            for value in (
                self.product_amount,
                self.note,
                self.qu_id,
                self.done,
                self.list_id,
            )
        ):
            raise ValueError("Provide at least one field to update")
        return self


class ShoppingItemMutationResponse(BaseModel):
    status: str
    message: str
    source_of_truth: str = "Grocy"
    list_id: int | None = None
    product_id: int | None = None
    product_name: str | None = None
    item_id: int | None = None
