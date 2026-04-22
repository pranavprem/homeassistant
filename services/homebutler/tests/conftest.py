"""Shared fixtures for HomeButler tests.

Keeps the existing ``test_grocy_migration`` smoke test untouched while
providing fakes and TestClient plumbing for the new control-plane tests.
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from typing import Any, Iterable

import pytest

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _install_docker_stub() -> None:
    """Install a minimal stub for the ``docker`` package if it is not available.

    The real ``docker`` SDK is only needed when HomeButler actually talks to
    a Docker daemon. Route tests use a fake client via dependency override,
    so we only need the import to succeed and ``DockerException`` / ``APIError``
    / ``NotFound`` / ``from_env`` / ``DockerClient`` to be importable.
    """

    if "docker" in sys.modules:
        return
    try:
        import docker  # noqa: F401
    except ImportError:
        pass
    else:
        return

    class _DockerException(Exception):
        pass

    class _APIError(_DockerException):
        pass

    class _NotFound(_DockerException):
        pass

    docker_mod = types.ModuleType("docker")
    docker_mod.DockerException = _DockerException  # type: ignore[attr-defined]

    def _from_env(*args, **kwargs):  # pragma: no cover - defensive
        raise _DockerException("stub: docker not available in test env")

    class _DockerClient:  # pragma: no cover - defensive
        def __init__(self, *args, **kwargs):
            raise _DockerException("stub: docker not available in test env")

    docker_mod.from_env = _from_env  # type: ignore[attr-defined]
    docker_mod.DockerClient = _DockerClient  # type: ignore[attr-defined]

    errors_mod = types.ModuleType("docker.errors")
    errors_mod.DockerException = _DockerException  # type: ignore[attr-defined]
    errors_mod.APIError = _APIError  # type: ignore[attr-defined]
    errors_mod.NotFound = _NotFound  # type: ignore[attr-defined]

    sys.modules["docker"] = docker_mod
    sys.modules["docker.errors"] = errors_mod


_install_docker_stub()


# --- Fake docker client ---------------------------------------------------


class FakeDockerOpsClient:
    """In-memory stand-in for ``DockerOpsClient`` used by route tests."""

    def __init__(self, *, allowed_containers: Iterable[str] | None = None) -> None:
        self.allowed_containers = list(allowed_containers or [])
        # name -> dict(name, image, state, status, health)
        self._containers: dict[str, dict[str, Any]] = {}
        self.restart_calls: list[str] = []
        self.log_calls: list[tuple[str, int]] = []

    def add(
        self,
        name: str,
        *,
        image: str = "test/image:latest",
        state: str = "running",
        status: str = "Up 5 minutes",
        health: str | None = "healthy",
    ) -> None:
        self._containers[name] = {
            "name": name,
            "image": image,
            "state": state,
            "status": status,
            "health": health,
        }

    def list_containers(self) -> list[dict[str, Any]]:
        items = list(self._containers.values())
        if self.allowed_containers:
            allowed = set(self.allowed_containers)
            items = [c for c in items if c["name"] in allowed]
        return sorted(items, key=lambda c: c["name"])

    def get_container(self, name: str) -> dict[str, Any]:
        self._assert_allowed(name)
        if name not in self._containers:
            from app.clients.docker_ops import DockerOpsError

            raise DockerOpsError(f"Container not found: {name}", status_code=404)
        return dict(self._containers[name])

    def get_logs(self, name: str, *, tail: int = 200) -> str:
        self._assert_allowed(name)
        if name not in self._containers:
            from app.clients.docker_ops import DockerOpsError

            raise DockerOpsError(f"Container not found: {name}", status_code=404)
        self.log_calls.append((name, tail))
        return f"<logs for {name} tail={tail}>"

    def restart(self, name: str) -> dict[str, Any]:
        self._assert_allowed(name)
        if name not in self._containers:
            from app.clients.docker_ops import DockerOpsError

            raise DockerOpsError(f"Container not found: {name}", status_code=404)
        self.restart_calls.append(name)
        return dict(self._containers[name])

    def _assert_allowed(self, name: str) -> None:
        if self.allowed_containers and name not in self.allowed_containers:
            from app.clients.docker_ops import DockerOpsError

            raise DockerOpsError(
                f"Container '{name}' not in allowed list.",
                status_code=403,
            )


# --- Fake command runner --------------------------------------------------


class FakeCommandRunner:
    def __init__(self) -> None:
        from app.services.command_runner import CommandResult

        self.CommandResult = CommandResult
        self.calls: list[dict[str, Any]] = []
        self.scripted: dict[str | None, dict[str, Any]] = {}

    def script(self, action_id: str | None, **kwargs: Any) -> None:
        self.scripted[action_id] = kwargs

    def run(
        self,
        *,
        argv: tuple[str, ...],
        cwd: str,
        timeout_seconds: int,
        extra_env_allowlist: tuple[str, ...] = (),
        action_id: str | None = None,
    ) -> Any:
        self.calls.append(
            {
                "argv": tuple(argv),
                "cwd": cwd,
                "timeout_seconds": timeout_seconds,
                "extra_env_allowlist": tuple(extra_env_allowlist),
                "action_id": action_id,
            }
        )
        cfg = self.scripted.get(action_id) or {}
        return self.CommandResult(
            exit_code=cfg.get("exit_code", 0),
            stdout=cfg.get("stdout", ""),
            stderr=cfg.get("stderr", ""),
            duration_ms=cfg.get("duration_ms", 12),
            truncated=cfg.get("truncated", False),
            timed_out=cfg.get("timed_out", False),
        )


# --- TestClient fixture ---------------------------------------------------


@pytest.fixture
def client(monkeypatch, tmp_path):
    """FastAPI TestClient with fakes wired in and settings cache cleared."""

    # Clear Settings cache so env overrides are respected.
    from app import config as config_module

    config_module.get_settings.cache_clear()

    # Make the four stack repo paths exist so availability checks that rely on
    # the directory existing can pass (individual tests can override per-env).
    for stack_id in ("homeassistant", "mediaserver", "morpheus", "tor"):
        p = tmp_path / stack_id
        p.mkdir(exist_ok=True)
        monkeypatch.setenv(f"HOMEBUTLER_{stack_id.upper()}_REPO", str(p))

    monkeypatch.setenv("HOMEBUTLER_REPO_ROOT", str(tmp_path))
    monkeypatch.setenv("HOMEBUTLER_ACTIONS_ENABLED", "true")

    from app.api.routes import ops as ops_module
    from app.main import create_app
    from fastapi.testclient import TestClient

    fake_docker = FakeDockerOpsClient(
        allowed_containers=config_module.get_settings().controlled_containers
    )
    fake_runner = FakeCommandRunner()

    monkeypatch.setattr(ops_module, "_get_client", lambda: fake_docker)
    monkeypatch.setattr(ops_module, "_get_command_runner", lambda: fake_runner)

    app = create_app()
    tc = TestClient(app)
    tc.fake_docker = fake_docker  # type: ignore[attr-defined]
    tc.fake_runner = fake_runner  # type: ignore[attr-defined]
    try:
        yield tc
    finally:
        config_module.get_settings.cache_clear()
