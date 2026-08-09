"""Stack / service registry.

The registry is the source of truth for which Docker containers HomeButler
knows about, grouped into logical stacks. It is a typed Python module on
purpose: `mypy` / human review catches bad references at import rather than
at request time, and the diff is obvious in git.

Service IDs use underscores (e.g. ``immich_server``) while the underlying
container names keep their real dashed form (``immich-server``). This lets
callers reason about "the immich_server service in the mediaserver stack"
without memorizing Docker naming quirks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

StackId = str
ServiceId = str

_ID_RE = re.compile(r"^[a-z0-9_]+$")


class StackNotFound(KeyError):
    """Raised when a stack_id is not in the registry."""


class ServiceNotFound(KeyError):
    """Raised when a service_id is not in the given stack."""


@dataclass(frozen=True)
class ServiceDef:
    service_id: ServiceId
    container_name: str
    description: str
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class StackDef:
    stack_id: StackId
    display_name: str
    description: str
    repo_path_env: str | None
    compose_project: str | None
    services: tuple[ServiceDef, ...]


def _svc(
    service_id: str,
    container_name: str,
    description: str,
    *tags: str,
) -> ServiceDef:
    return ServiceDef(
        service_id=service_id,
        container_name=container_name,
        description=description,
        tags=tuple(tags),
    )


_STACKS: tuple[StackDef, ...] = (
    StackDef(
        stack_id="homeassistant",
        display_name="Home Assistant",
        description=(
            "Smart-home hub plus the internal services that support it "
            "(Grocy, HomeButler, MQTT, Govee bridge, tunnel)."
        ),
        repo_path_env="HOMEBUTLER_HOMEASSISTANT_REPO",
        compose_project="homeassistant",
        services=(
            _svc("homeassistant", "homeassistant", "Home Assistant core", "smart_home"),
            _svc("grocy", "grocy", "Grocy household/pantry state", "state"),
            _svc("homebutler", "homebutler", "HomeButler control plane (self)", "control"),
            _svc("mosquitto", "mosquitto", "Internal MQTT broker", "mqtt"),
            _svc("govee2mqtt", "govee2mqtt", "Govee <-> MQTT bridge", "mqtt"),
            _svc("zigbee2mqtt", "zigbee2mqtt", "Zigbee <-> MQTT bridge", "mqtt", "zigbee"),
            _svc("cloudflared", "ha-cloudflared", "Cloudflare tunnel for HA/Grocy", "tunnel"),
        ),
    ),
    StackDef(
        stack_id="mediaserver",
        display_name="Media Server",
        description=(
            "*arr stack, downloaders, media players, Immich, Paperless, "
            "monitoring, and supporting infra."
        ),
        repo_path_env="HOMEBUTLER_MEDIASERVER_REPO",
        compose_project="mediaserver",
        services=(
            _svc("gluetun", "gluetun", "VPN container for downloaders", "vpn"),
            _svc("cloudflared", "cloudflared", "Cloudflare tunnel for media services", "tunnel"),
            _svc("qbittorrent", "qbittorrent", "Torrent client", "downloader"),
            _svc("sabnzbd", "sabnzbd", "Usenet client", "downloader"),
            _svc("prowlarr", "prowlarr", "Indexer manager", "arr"),
            _svc("radarr", "radarr", "Movies manager", "arr"),
            _svc("sonarr", "sonarr", "TV manager", "arr"),
            _svc("recyclarr", "recyclarr", "Recyclarr config sync", "arr"),
            _svc("jellyfin", "jellyfin", "Jellyfin media server", "media"),
            _svc("jellyseerr", "jellyseerr", "Media request frontend", "media"),
            _svc("plex", "plex", "Plex media server", "media"),
            _svc("vaultwarden", "vaultwarden", "Self-hosted Bitwarden", "auth"),
            _svc("immich_server", "immich-server", "Immich photo library server", "media"),
            _svc("immich_ml", "immich-machine-learning", "Immich ML worker", "media"),
            _svc("immich_redis", "immich-redis", "Immich Redis", "media", "database"),
            _svc("immich_postgres", "immich-postgres", "Immich Postgres", "media", "database"),
            _svc("paperless_webserver", "paperless-webserver", "Paperless-ngx webserver", "docs"),
            _svc("paperless_postgres", "paperless-postgres", "Paperless Postgres", "docs", "database"),
            _svc("paperless_redis", "paperless-redis", "Paperless Redis", "docs"),
            _svc("paperless_gotenberg", "paperless-gotenberg", "Paperless Gotenberg", "docs"),
            _svc("paperless_tika", "paperless-tika", "Paperless Tika", "docs"),
            _svc("portainer", "portainer", "Portainer container UI", "ops"),
            _svc("gitea", "gitea", "Gitea git host", "devtools"),
            _svc("watchtower", "watchtower", "Container auto-updater", "ops"),
            _svc("dozzle", "dozzle", "Container log viewer", "ops"),
            _svc("prometheus", "prometheus", "Prometheus metrics", "observability"),
            _svc("cadvisor", "cadvisor", "cAdvisor container metrics", "observability"),
            _svc("node_exporter", "node-exporter", "Node Exporter host metrics", "observability"),
            _svc("grafana", "grafana", "Grafana dashboards", "observability"),
        ),
    ),
    StackDef(
        stack_id="morpheus",
        display_name="Morpheus",
        description="Morpheus service stack.",
        repo_path_env="HOMEBUTLER_MORPHEUS_REPO",
        compose_project="morpheus",
        services=(
            _svc("morpheus", "morpheus", "Morpheus service", "app"),
        ),
    ),
    StackDef(
        stack_id="tor",
        display_name="Tor",
        description="Tor proxy plus Firefox-through-Tor container.",
        repo_path_env="HOMEBUTLER_TOR_REPO",
        compose_project="tor",
        services=(
            _svc("proxy", "tor-proxy", "Tor SOCKS/HTTP proxy", "network"),
            _svc("firefox", "tor-firefox", "Firefox over Tor", "browser"),
        ),
    ),
)


def _validate_registry(stacks: tuple[StackDef, ...]) -> None:
    seen_stacks: set[str] = set()
    seen_containers: set[str] = set()
    for stack in stacks:
        if not _ID_RE.match(stack.stack_id):
            raise ValueError(f"Invalid stack_id: {stack.stack_id!r}")
        if stack.stack_id in seen_stacks:
            raise ValueError(f"Duplicate stack_id: {stack.stack_id!r}")
        seen_stacks.add(stack.stack_id)

        seen_services: set[str] = set()
        for svc in stack.services:
            if not _ID_RE.match(svc.service_id):
                raise ValueError(
                    f"Invalid service_id in {stack.stack_id}: {svc.service_id!r}"
                )
            if svc.service_id in seen_services:
                raise ValueError(
                    f"Duplicate service_id in {stack.stack_id}: {svc.service_id!r}"
                )
            seen_services.add(svc.service_id)

            if not svc.container_name or not isinstance(svc.container_name, str):
                raise ValueError(
                    f"Invalid container_name for {stack.stack_id}/{svc.service_id}"
                )
            if svc.container_name in seen_containers:
                # A container name appearing in two stacks would make the allowlist
                # ambiguous — each container belongs to exactly one stack.
                raise ValueError(
                    f"Container '{svc.container_name}' referenced by multiple services"
                )
            seen_containers.add(svc.container_name)


_validate_registry(_STACKS)


def list_stacks() -> tuple[StackDef, ...]:
    return _STACKS


def get_stack(stack_id: str) -> StackDef:
    for stack in _STACKS:
        if stack.stack_id == stack_id:
            return stack
    raise StackNotFound(stack_id)


def get_service(stack_id: str, service_id: str) -> tuple[StackDef, ServiceDef]:
    stack = get_stack(stack_id)
    for svc in stack.services:
        if svc.service_id == service_id:
            return stack, svc
    raise ServiceNotFound(f"{stack_id}/{service_id}")


def all_controlled_container_names() -> frozenset[str]:
    names: set[str] = set()
    for stack in _STACKS:
        for svc in stack.services:
            names.add(svc.container_name)
    return frozenset(names)
