from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.clients.grocy import GrocyClient, GrocyClientError
from app.config import Settings, get_settings
from app.schemas import (
    GrocyMigrationBundle,
    GrocyMigrationResponse,
    GrocyMigrationSummary,
)
from app.services.grocy_migration import (
    MigrationError,
    apply_migration,
)

router = APIRouter(prefix="/migration", tags=["migration"])


def _get_client(settings: Settings) -> GrocyClient:
    return GrocyClient(
        base_url=settings.grocy_base_url,
        api_key=settings.grocy_api_key,
        timeout_seconds=settings.grocy_timeout_seconds,
        verify_ssl=settings.grocy_verify_ssl,
    )


@router.post("/grocy/apply", response_model=GrocyMigrationResponse)
def apply_grocy_migration(bundle: GrocyMigrationBundle) -> GrocyMigrationResponse:
    settings = get_settings()
    client = _get_client(settings)

    try:
        summary = apply_migration(
            client,
            bundle.model_dump(exclude_none=True),
            purchased_date=bundle.purchased_date,
        )
    except MigrationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except GrocyClientError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    return GrocyMigrationResponse(
        meta=bundle.meta,
        summary=GrocyMigrationSummary(**summary.as_dict()),
    )
