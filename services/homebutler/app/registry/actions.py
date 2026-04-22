"""Action registry.

Each action is a fixed ``argv`` bound to a stack. The registry is validated at
import time so HomeButler refuses to start with a malformed entry rather than
failing at request time. There is no pathway to accept user-supplied argv,
targets, or env: v1 actions take no parameters.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from app.registry.stacks import StackId, get_stack

ActionId = str

_ACTION_ID_RE = re.compile(r"^[a-z0-9_]+(\.[a-z0-9_]+)+$")
_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
_SHELL_METACHARS = (";", "&&", "||", "|", "<", ">", "`", "$(")

# Hard cap on per-action timeout. Design doc §3.2.
_MAX_TIMEOUT_SECONDS = 1800


class ActionNotFound(KeyError):
    """Raised when an action_id is not in the registry."""


class ActionKind(str, Enum):
    MAKE_TARGET = "make_target"
    COMPOSE_COMMAND = "compose_command"
    SCRIPT = "script"  # reserved for future use


@dataclass(frozen=True)
class ActionDef:
    action_id: ActionId
    stack_id: StackId
    description: str
    kind: ActionKind
    argv: tuple[str, ...]
    repo_path_env: str | None
    timeout_seconds: int
    mutating: bool
    required_executables: tuple[str, ...]
    extra_env_allowlist: tuple[str, ...] = ()


_ACTIONS: tuple[ActionDef, ...] = (
    ActionDef(
        action_id="mediaserver.update_gluetun",
        stack_id="mediaserver",
        description="Pull & recreate the Gluetun VPN container on the mediaserver stack.",
        kind=ActionKind.MAKE_TARGET,
        argv=("make", "update-gluetun"),
        repo_path_env="HOMEBUTLER_MEDIASERVER_REPO",
        timeout_seconds=600,
        mutating=True,
        required_executables=("make",),
    ),
    ActionDef(
        action_id="mediaserver.sync_configs",
        stack_id="mediaserver",
        description="Sync *arr configs via recyclarr and related tooling.",
        kind=ActionKind.MAKE_TARGET,
        argv=("make", "sync-configs"),
        repo_path_env="HOMEBUTLER_MEDIASERVER_REPO",
        timeout_seconds=300,
        mutating=True,
        required_executables=("make",),
    ),
    ActionDef(
        action_id="morpheus.redeploy",
        stack_id="morpheus",
        description="Rebuild & redeploy the Morpheus stack.",
        kind=ActionKind.MAKE_TARGET,
        argv=("make", "redeploy"),
        repo_path_env="HOMEBUTLER_MORPHEUS_REPO",
        timeout_seconds=900,
        mutating=True,
        required_executables=("make",),
    ),
    ActionDef(
        action_id="morpheus.health",
        stack_id="morpheus",
        description="Run the Morpheus stack health check target.",
        kind=ActionKind.MAKE_TARGET,
        argv=("make", "health"),
        repo_path_env="HOMEBUTLER_MORPHEUS_REPO",
        timeout_seconds=60,
        mutating=False,
        required_executables=("make",),
    ),
    ActionDef(
        action_id="tor.restart",
        stack_id="tor",
        description="docker compose restart on the tor stack (all services).",
        kind=ActionKind.COMPOSE_COMMAND,
        argv=("docker", "compose", "restart"),
        repo_path_env="HOMEBUTLER_TOR_REPO",
        timeout_seconds=180,
        mutating=True,
        required_executables=("docker",),
    ),
    ActionDef(
        action_id="tor.status",
        stack_id="tor",
        description="docker compose ps on the tor stack.",
        kind=ActionKind.COMPOSE_COMMAND,
        argv=("docker", "compose", "ps"),
        repo_path_env="HOMEBUTLER_TOR_REPO",
        timeout_seconds=30,
        mutating=False,
        required_executables=("docker",),
    ),
)


def _validate_argv(action: ActionDef) -> None:
    if not action.argv:
        raise ValueError(f"Action {action.action_id}: argv must be non-empty")
    for token in action.argv:
        if not isinstance(token, str) or token == "":
            raise ValueError(f"Action {action.action_id}: argv has empty/non-str token")
        for meta in _SHELL_METACHARS:
            if meta in token:
                raise ValueError(
                    f"Action {action.action_id}: argv token {token!r} contains shell metacharacter"
                )
    if action.argv[0] not in action.required_executables:
        raise ValueError(
            f"Action {action.action_id}: argv[0]={action.argv[0]!r} must appear in "
            f"required_executables={action.required_executables!r}"
        )

    if action.kind is ActionKind.MAKE_TARGET:
        if action.argv[0] != "make" or len(action.argv) != 2:
            raise ValueError(
                f"Action {action.action_id}: MAKE_TARGET must be ('make', '<target>')"
            )
    elif action.kind is ActionKind.COMPOSE_COMMAND:
        if action.argv[:2] != ("docker", "compose") or len(action.argv) < 3:
            raise ValueError(
                f"Action {action.action_id}: COMPOSE_COMMAND must start with ('docker', 'compose', ...)"
            )


def _validate_action(action: ActionDef) -> None:
    if not _ACTION_ID_RE.match(action.action_id):
        raise ValueError(f"Invalid action_id: {action.action_id!r}")

    try:
        get_stack(action.stack_id)
    except KeyError as exc:
        raise ValueError(
            f"Action {action.action_id}: references unknown stack {action.stack_id!r}"
        ) from exc

    if not (1 <= action.timeout_seconds <= _MAX_TIMEOUT_SECONDS):
        raise ValueError(
            f"Action {action.action_id}: timeout_seconds must be in [1, {_MAX_TIMEOUT_SECONDS}]"
        )

    if not action.required_executables:
        raise ValueError(f"Action {action.action_id}: required_executables must be non-empty")

    for name in action.extra_env_allowlist:
        if not _ENV_NAME_RE.match(name):
            raise ValueError(
                f"Action {action.action_id}: extra_env_allowlist entry {name!r} must be an uppercase identifier"
            )

    _validate_argv(action)


def _validate_registry(actions: tuple[ActionDef, ...]) -> None:
    seen: set[str] = set()
    for action in actions:
        if action.action_id in seen:
            raise ValueError(f"Duplicate action_id: {action.action_id!r}")
        seen.add(action.action_id)
        _validate_action(action)


_validate_registry(_ACTIONS)


def list_actions() -> tuple[ActionDef, ...]:
    return _ACTIONS


def get_action(action_id: str) -> ActionDef:
    for action in _ACTIONS:
        if action.action_id == action_id:
            return action
    raise ActionNotFound(action_id)


def validate_action_def(action: ActionDef) -> None:
    """Validate a single ActionDef in isolation — used by tests."""

    _validate_action(action)
