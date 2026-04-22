from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

APP_VERSION = "0.1.0"

_TRUE_VALUES = {"1", "true", "yes", "on"}


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in _TRUE_VALUES


def _get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _get_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _get_list(name: str, default: list[str]) -> list[str]:
    value = os.getenv(name)
    if value is None:
        return default
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    service_name: str
    environment: str
    host: str
    port: int
    log_level: str
    grocy_base_url: str
    grocy_api_key: str | None
    grocy_timeout_seconds: float
    grocy_verify_ssl: bool
    docker_host: str | None
    controlled_containers: list[str]


@lru_cache
def get_settings() -> Settings:
    grocy_api_key = os.getenv("GROCY_API_KEY", "").strip() or None
    docker_host = os.getenv("DOCKER_HOST", "").strip() or None
    return Settings(
        service_name="HomeButler",
        environment=os.getenv("HOMEBUTLER_ENV", "development"),
        host=os.getenv("HOMEBUTLER_HOST", "0.0.0.0"),
        port=_get_int("HOMEBUTLER_PORT", 8000),
        log_level=os.getenv("HOMEBUTLER_LOG_LEVEL", "info"),
        grocy_base_url=os.getenv("GROCY_BASE_URL", "http://grocy").rstrip("/"),
        grocy_api_key=grocy_api_key,
        grocy_timeout_seconds=_get_float("GROCY_TIMEOUT_SECONDS", 10.0),
        grocy_verify_ssl=_get_bool("GROCY_VERIFY_SSL", False),
        docker_host=docker_host,
        controlled_containers=_get_list(
            "HOMEBUTLER_CONTROLLED_CONTAINERS",
            ["grocy", "homeassistant", "ha-cloudflared", "mosquitto", "govee2mqtt", "homebutler"],
        ),
    )

