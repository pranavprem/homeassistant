from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import docker
from docker.errors import APIError, DockerException, NotFound


class DockerOpsError(Exception):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class DockerContainerSummary:
    name: str
    image: str
    state: str
    status: str
    health: str | None


class DockerOpsClient:
    def __init__(
        self,
        *,
        docker_host: str | None = None,
        allowed_containers: list[str] | None = None,
    ) -> None:
        self.docker_host = docker_host
        self.allowed_containers = [name.strip() for name in (allowed_containers or []) if name.strip()]

        try:
            if docker_host:
                self.client = docker.DockerClient(base_url=docker_host)
            else:
                self.client = docker.from_env()
        except DockerException as exc:
            raise DockerOpsError(f"Failed to connect to Docker: {exc}") from exc

    def list_containers(self) -> list[dict[str, Any]]:
        try:
            containers = self.client.containers.list(all=True)
        except DockerException as exc:
            raise DockerOpsError(f"Failed to list Docker containers: {exc}") from exc

        summaries = [self._summarize(container) for container in containers]
        if self.allowed_containers:
            allowed = set(self.allowed_containers)
            summaries = [summary for summary in summaries if summary["name"] in allowed]

        return sorted(summaries, key=lambda item: item["name"])

    def get_container(self, name: str) -> dict[str, Any]:
        container = self._load_container(name)
        return self._summarize(container)

    def get_logs(self, name: str, *, tail: int = 200) -> str:
        container = self._load_container(name)
        try:
            raw = container.logs(tail=tail)
        except (APIError, DockerException) as exc:
            raise DockerOpsError(f"Failed to fetch logs for {name}: {exc}") from exc
        return raw.decode("utf-8", errors="replace")

    def restart(self, name: str) -> dict[str, Any]:
        container = self._load_container(name)
        try:
            container.restart()
            container.reload()
        except (APIError, DockerException) as exc:
            raise DockerOpsError(f"Failed to restart {name}: {exc}") from exc
        return self._summarize(container)

    def _load_container(self, name: str):
        self._assert_allowed(name)
        try:
            return self.client.containers.get(name)
        except NotFound as exc:
            raise DockerOpsError(f"Container not found: {name}", status_code=404) from exc
        except DockerException as exc:
            raise DockerOpsError(f"Failed to inspect container {name}: {exc}") from exc

    def _assert_allowed(self, name: str) -> None:
        if self.allowed_containers and name not in self.allowed_containers:
            allowed = ", ".join(self.allowed_containers)
            raise DockerOpsError(
                f"Container '{name}' is not in the allowed control list. Allowed: {allowed}",
                status_code=403,
            )

    @staticmethod
    def _summarize(container) -> dict[str, Any]:
        attrs = getattr(container, "attrs", {}) or {}
        state = attrs.get("State", {}) or {}
        health = (state.get("Health") or {}).get("Status")
        image_tags = getattr(container.image, "tags", None) or []
        image = image_tags[0] if image_tags else getattr(container.image, "short_id", "unknown")

        return {
            "name": container.name,
            "image": image,
            "state": state.get("Status") or getattr(container, "status", "unknown"),
            "status": getattr(container, "status", state.get("Status") or "unknown"),
            "health": health,
        }
