from __future__ import annotations

from fastapi import APIRouter

from app.clients.grocy import GrocyClient
from app.config import APP_VERSION, Settings, get_settings
from app.schemas import ConfigResponse, GrocySummary, HealthResponse, HttpSummary

router = APIRouter(tags=["system"])


def _build_grocy_summary(settings: Settings) -> GrocySummary:
    client = GrocyClient(
        base_url=settings.grocy_base_url,
        api_key=settings.grocy_api_key,
        timeout_seconds=settings.grocy_timeout_seconds,
        verify_ssl=settings.grocy_verify_ssl,
    )
    status = client.status()
    return GrocySummary(
        base_url=status.base_url,
        api_key_configured=status.api_key_configured,
        timeout_seconds=status.timeout_seconds,
        verify_ssl=status.verify_ssl,
    )


@router.get("/health", response_model=HealthResponse)
def get_health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(
        service=settings.service_name,
        environment=settings.environment,
        version=APP_VERSION,
        grocy=_build_grocy_summary(settings),
    )


@router.get("/config", response_model=ConfigResponse)
def get_config() -> ConfigResponse:
    settings = get_settings()
    return ConfigResponse(
        service=settings.service_name,
        environment=settings.environment,
        service_role="action/orchestration/control layer",
        household_state_owner="Grocy",
        http=HttpSummary(host=settings.host, port=settings.port),
        grocy=_build_grocy_summary(settings),
        controlled_containers=settings.controlled_containers,
    )

