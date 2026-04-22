from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache

APP_VERSION = "0.1.0"

_LOG = logging.getLogger(__name__)

_TRUE_VALUES = {"1", "true", "yes", "on"}

# Default base path inside the HomeButler container where host repos are
# bind-mounted. Individual stack paths can be overridden explicitly.
_DEFAULT_REPO_ROOT = "/opt/repos"


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


def _resolve_repo_path(env_name: str, repo_root: str, stack_id: str) -> str:
    override = os.getenv(env_name, "").strip()
    if override:
        return override
    return os.path.join(repo_root, stack_id)


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
    repo_root: str
    repo_paths: dict[str, str]
    actions_enabled: bool


def _compute_controlled_containers(env_value: list[str] | None) -> list[str]:
    """Merge the stack-registry allowlist with any legacy env-var additions.

    The registry is the source of truth; the env var can only *add*. This lets
    us roll out without breaking anyone who customised the env var, while
    avoiding a situation where ``.env`` can silently remove containers from
    the allowlist.
    """

    # Local import to avoid a circular import between config.py and the
    # registry's own (non-existent) config consumer.
    from app.registry.stacks import all_controlled_container_names

    registry = set(all_controlled_container_names())
    effective = set(registry)
    extras: list[str] = []

    if env_value:
        for name in env_value:
            if name and name not in registry:
                extras.append(name)
                effective.add(name)

    if extras:
        _LOG.warning(
            "controlled_containers: %s env additions beyond registry: %s",
            len(extras),
            sorted(extras),
        )

    return sorted(effective)


@lru_cache
def get_settings() -> Settings:
    grocy_api_key = os.getenv("GROCY_API_KEY", "").strip() or None
    docker_host = os.getenv("DOCKER_HOST", "").strip() or None

    repo_root = os.getenv("HOMEBUTLER_REPO_ROOT", _DEFAULT_REPO_ROOT).strip() or _DEFAULT_REPO_ROOT
    repo_paths = {
        "homeassistant": _resolve_repo_path("HOMEBUTLER_HOMEASSISTANT_REPO", repo_root, "homeassistant"),
        "mediaserver": _resolve_repo_path("HOMEBUTLER_MEDIASERVER_REPO", repo_root, "mediaserver"),
        "morpheus": _resolve_repo_path("HOMEBUTLER_MORPHEUS_REPO", repo_root, "morpheus"),
        "tor": _resolve_repo_path("HOMEBUTLER_TOR_REPO", repo_root, "tor"),
    }

    env_controlled = _get_list("HOMEBUTLER_CONTROLLED_CONTAINERS", [])
    controlled = _compute_controlled_containers(env_controlled or None)

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
        controlled_containers=controlled,
        repo_root=repo_root,
        repo_paths=repo_paths,
        actions_enabled=_get_bool("HOMEBUTLER_ACTIONS_ENABLED", True),
    )
