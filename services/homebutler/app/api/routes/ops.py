"""Ops routes.

Three layers under ``/ops``:

* Legacy flat ``/ops/containers*`` — unchanged, still delegates to
  ``DockerOpsClient`` with the effective allowlist.
* ``/ops/stacks*`` — new stack/service navigation on top of the registry.
* ``/ops/actions*`` — allowlisted higher-level actions (``make`` targets,
  ``docker compose`` commands) with availability metadata and a strict
  command runner.

IDs are validated by shape inside the route handlers (so rejection is 404,
not FastAPI's default 422) and then checked against the registry. Unknown
IDs always return 404.
"""

from __future__ import annotations

import datetime as _dt
import os
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Path, Query

from app.clients.docker_ops import DockerOpsClient, DockerOpsError
from app.config import Settings, get_settings
from app.registry.actions import (
    ActionDef,
    ActionNotFound,
    get_action,
    list_actions,
)
from app.registry.availability import ActionAvailability, compute_availability
from app.registry.stacks import (
    ServiceDef,
    ServiceNotFound,
    StackDef,
    StackNotFound,
    get_service,
    get_stack,
    list_stacks,
)
from app.schemas import (
    ActionAvailabilityInfo,
    ActionDetailResponse,
    ActionInfo,
    ActionListResponse,
    ActionRunResponse,
    ContainerDetailResponse,
    ContainerListResponse,
    ContainerLogsResponse,
    ContainerMutationResponse,
    ContainerSummary,
    OpsError,
    RunActionRequest,
    ServiceDetailResponse,
    ServiceInfo,
    ServiceLogsResponse,
    ServiceMutationResponse,
    StackDetailResponse,
    StackInfo,
    StackListResponse,
)
from app.services.command_runner import CommandResult, CommandRunner

router = APIRouter(prefix="/ops", tags=["ops"])

# ID shape is validated inside the route handlers (not via FastAPI Path
# pattern=) so rejection is 404 rather than 422 — per design §8.2, we don't
# want to leak "this shape was close" through a validation error.
_STACK_RE = re.compile(r"^[a-z0-9_]+$")
_ACTION_RE = re.compile(r"^[a-z0-9_]+(?:\.[a-z0-9_]+)+$")


# --- Dependencies ---------------------------------------------------------


def _get_client() -> DockerOpsClient:
    settings = get_settings()
    return DockerOpsClient(
        docker_host=settings.docker_host,
        allowed_containers=settings.controlled_containers,
    )


# Module-level singleton so tests can monkeypatch it. A CommandRunner is
# stateless so sharing is safe.
_COMMAND_RUNNER = CommandRunner()


def _get_command_runner() -> CommandRunner:
    return _COMMAND_RUNNER


# --- Error helpers --------------------------------------------------------


def _ops_error(
    *,
    status_code: int,
    error: str,
    message: str,
    detail: dict[str, Any] | None = None,
) -> HTTPException:
    payload = OpsError(error=error, message=message, detail=detail).model_dump()
    return HTTPException(status_code=status_code, detail=payload)


def _raise_docker_http(exc: DockerOpsError) -> None:
    err_code = "docker_error"
    if exc.status_code == 404:
        err_code = "not_found"
    elif exc.status_code == 403:
        err_code = "forbidden"
    raise _ops_error(
        status_code=exc.status_code,
        error=err_code,
        message=str(exc),
    ) from exc


# --- Legacy flat routes ---------------------------------------------------


@router.get(
    "/containers",
    response_model=ContainerListResponse,
    summary="List controlled containers (legacy flat view)",
    description="Legacy flat container view; prefer `/ops/stacks/...`.",
)
def list_containers() -> ContainerListResponse:
    try:
        containers = _get_client().list_containers()
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    return ContainerListResponse(
        count=len(containers),
        containers=[ContainerSummary(**item) for item in containers],
    )


@router.get(
    "/containers/{name}",
    response_model=ContainerDetailResponse,
    summary="Get container (legacy)",
    description="Legacy flat container view; prefer `/ops/stacks/...`.",
)
def get_container(name: str) -> ContainerDetailResponse:
    try:
        container = _get_client().get_container(name)
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    return ContainerDetailResponse(container=ContainerSummary(**container))


@router.get(
    "/containers/{name}/logs",
    response_model=ContainerLogsResponse,
    summary="Get container logs (legacy)",
    description="Legacy flat container view; prefer `/ops/stacks/...`.",
)
def get_container_logs(
    name: str,
    tail: int = Query(default=200, ge=1, le=1000),
) -> ContainerLogsResponse:
    try:
        logs = _get_client().get_logs(name, tail=tail)
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    return ContainerLogsResponse(name=name, tail=tail, logs=logs)


@router.post(
    "/containers/{name}/restart",
    response_model=ContainerMutationResponse,
    summary="Restart container (legacy)",
    description="Legacy flat container view; prefer `/ops/stacks/...`.",
)
def restart_container(name: str) -> ContainerMutationResponse:
    try:
        container = _get_client().restart(name)
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    summary = ContainerSummary(**container)
    return ContainerMutationResponse(
        status="restarted",
        message=f"Restarted container {name}",
        container=summary,
    )


# --- Stack / service routes ----------------------------------------------


def _repo_path_resolved(stack: StackDef, settings: Settings) -> str | None:
    path = settings.repo_paths.get(stack.stack_id)
    if path and os.path.isdir(path):
        return path
    return None


def _service_info(
    stack: StackDef,
    svc: ServiceDef,
    containers_by_name: dict[str, dict[str, Any]] | None,
) -> ServiceInfo:
    container_summary: ContainerSummary | None = None
    if containers_by_name is not None:
        raw = containers_by_name.get(svc.container_name)
        if raw is not None:
            container_summary = ContainerSummary(**raw)
    return ServiceInfo(
        stack=stack.stack_id,
        service=svc.service_id,
        container_name=svc.container_name,
        description=svc.description,
        tags=list(svc.tags),
        container=container_summary,
    )


def _stack_info(
    stack: StackDef,
    settings: Settings,
    containers_by_name: dict[str, dict[str, Any]] | None,
) -> StackInfo:
    return StackInfo(
        stack=stack.stack_id,
        display_name=stack.display_name,
        description=stack.description,
        repo_path_env=stack.repo_path_env,
        repo_path_resolved=_repo_path_resolved(stack, settings),
        services=[_service_info(stack, svc, containers_by_name) for svc in stack.services],
    )


def _require_stack_id(stack_id: str) -> StackDef:
    if not _STACK_RE.match(stack_id):
        raise _ops_error(
            status_code=404,
            error="stack_not_found",
            message=f"Unknown stack {stack_id!r}",
        )
    try:
        return get_stack(stack_id)
    except StackNotFound as exc:
        raise _ops_error(
            status_code=404,
            error="stack_not_found",
            message=f"Unknown stack {stack_id!r}",
        ) from exc


def _require_service(stack_id: str, service_id: str) -> tuple[StackDef, ServiceDef]:
    # stack validation comes first so we return stack_not_found in that case.
    _require_stack_id(stack_id)
    if not _STACK_RE.match(service_id):
        raise _ops_error(
            status_code=404,
            error="service_not_found",
            message=f"Unknown service {service_id!r} in stack {stack_id!r}",
        )
    try:
        return get_service(stack_id, service_id)
    except ServiceNotFound as exc:
        raise _ops_error(
            status_code=404,
            error="service_not_found",
            message=f"Unknown service {service_id!r} in stack {stack_id!r}",
        ) from exc


@router.get("/stacks", response_model=StackListResponse)
def list_stacks_route() -> StackListResponse:
    settings = get_settings()
    client = _get_client()
    try:
        raw = client.list_containers()
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    by_name = {item["name"]: item for item in raw}
    stacks = [_stack_info(stack, settings, by_name) for stack in list_stacks()]
    return StackListResponse(count=len(stacks), stacks=stacks)


@router.get("/stacks/{stack}", response_model=StackDetailResponse)
def get_stack_route(
    stack: str = Path(...),
) -> StackDetailResponse:
    stack_def = _require_stack_id(stack)
    settings = get_settings()
    client = _get_client()
    try:
        raw = client.list_containers()
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    by_name = {item["name"]: item for item in raw}
    return StackDetailResponse(stack=_stack_info(stack_def, settings, by_name))


@router.get(
    "/stacks/{stack}/services/{service}",
    response_model=ServiceDetailResponse,
)
def get_service_route(
    stack: str = Path(...),
    service: str = Path(...),
) -> ServiceDetailResponse:
    stack_def, svc_def = _require_service(stack, service)
    client = _get_client()
    # Try to fetch the specific container; if absent, return null.
    by_name: dict[str, dict[str, Any]] | None
    try:
        container = client.get_container(svc_def.container_name)
        by_name = {svc_def.container_name: container}
    except DockerOpsError as exc:
        if exc.status_code == 404:
            by_name = {}
        else:
            _raise_docker_http(exc)
            return  # unreachable

    return ServiceDetailResponse(service=_service_info(stack_def, svc_def, by_name))


@router.get(
    "/stacks/{stack}/services/{service}/logs",
    response_model=ServiceLogsResponse,
)
def get_service_logs_route(
    stack: str = Path(...),
    service: str = Path(...),
    tail: int = Query(default=200, ge=1, le=1000),
) -> ServiceLogsResponse:
    _stack_def, svc_def = _require_service(stack, service)
    client = _get_client()
    try:
        logs = client.get_logs(svc_def.container_name, tail=tail)
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    return ServiceLogsResponse(
        stack=stack,
        service=service,
        container_name=svc_def.container_name,
        tail=tail,
        logs=logs,
    )


@router.post(
    "/stacks/{stack}/services/{service}/restart",
    response_model=ServiceMutationResponse,
)
def restart_service_route(
    stack: str = Path(...),
    service: str = Path(...),
) -> ServiceMutationResponse:
    stack_def, svc_def = _require_service(stack, service)
    client = _get_client()
    try:
        raw = client.restart(svc_def.container_name)
    except DockerOpsError as exc:
        _raise_docker_http(exc)

    info = _service_info(stack_def, svc_def, {svc_def.container_name: raw})
    return ServiceMutationResponse(
        status="restarted",
        message=f"Restarted container {svc_def.container_name}",
        service=info,
    )


# --- Action routes -------------------------------------------------------


def _require_actions_enabled() -> None:
    if not get_settings().actions_enabled:
        raise _ops_error(
            status_code=503,
            error="actions_disabled",
            message="Action routes are disabled via HOMEBUTLER_ACTIONS_ENABLED=false",
        )


def _require_action_id(action_id: str) -> ActionDef:
    if not _ACTION_RE.match(action_id):
        raise _ops_error(
            status_code=404,
            error="action_not_found",
            message=f"Unknown action {action_id!r}",
        )
    try:
        return get_action(action_id)
    except ActionNotFound as exc:
        raise _ops_error(
            status_code=404,
            error="action_not_found",
            message=f"Unknown action {action_id!r}",
        ) from exc


def _action_info(action: ActionDef, availability: ActionAvailability) -> ActionInfo:
    return ActionInfo(
        action=action.action_id,
        stack=action.stack_id,
        description=action.description,
        kind=action.kind.value,
        argv=list(action.argv),
        timeout_seconds=action.timeout_seconds,
        mutating=action.mutating,
        required_executables=list(action.required_executables),
        availability=ActionAvailabilityInfo(
            available=availability.available,
            repo_path_resolved=availability.repo_path_resolved,
            missing_executables=list(availability.missing_executables),
            reason=availability.reason,
        ),
    )


@router.get("/actions", response_model=ActionListResponse)
def list_actions_route() -> ActionListResponse:
    _require_actions_enabled()
    entries = [
        _action_info(action, compute_availability(action)) for action in list_actions()
    ]
    return ActionListResponse(count=len(entries), actions=entries)


@router.get("/actions/{action}", response_model=ActionDetailResponse)
def get_action_route(
    action: str = Path(...),
) -> ActionDetailResponse:
    _require_actions_enabled()
    action_def = _require_action_id(action)
    return ActionDetailResponse(
        action=_action_info(action_def, compute_availability(action_def)),
    )


def _run_status(result: CommandResult) -> str:
    if result.timed_out:
        return "timed_out"
    return "ok" if result.exit_code == 0 else "failed"


@router.post("/actions/{action}/run", response_model=ActionRunResponse)
def run_action_route(
    action: str = Path(...),
    body: RunActionRequest | None = None,
) -> ActionRunResponse:
    _require_actions_enabled()
    action_def = _require_action_id(action)

    # Body is reserved; Pydantic already rejects unknown fields via extra="forbid".
    # Accepting None lets clients POST with no body.
    _ = body or RunActionRequest()

    availability = compute_availability(action_def)
    if not availability.available:
        raise _ops_error(
            status_code=409,
            error="action_unavailable",
            message=f"Action {action_def.action_id} is unavailable: {availability.reason}",
            detail={
                "reason": availability.reason,
                "missing_executables": list(availability.missing_executables),
                "repo_path_env": action_def.repo_path_env,
            },
        )
    if not availability.repo_path_resolved:
        raise _ops_error(
            status_code=409,
            error="action_unavailable",
            message=f"Action {action_def.action_id} has no resolved repo path",
        )

    runner = _get_command_runner()
    started_at = _dt.datetime.now(_dt.timezone.utc)
    try:
        result = runner.run(
            argv=action_def.argv,
            cwd=availability.repo_path_resolved,
            timeout_seconds=action_def.timeout_seconds,
            extra_env_allowlist=action_def.extra_env_allowlist,
            action_id=action_def.action_id,
        )
    except FileNotFoundError as exc:
        raise _ops_error(
            status_code=502,
            error="executable_missing",
            message=f"Executable for action {action_def.action_id} not found: {exc}",
        ) from exc
    except ValueError as exc:
        raise _ops_error(
            status_code=502,
            error="runner_error",
            message=str(exc),
        ) from exc
    finished_at = _dt.datetime.now(_dt.timezone.utc)

    status = _run_status(result)
    response = ActionRunResponse(
        action=action_def.action_id,
        status=status,
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        duration_ms=result.duration_ms,
        truncated=result.truncated,
        timed_out=result.timed_out,
        started_at=started_at.isoformat(),
        finished_at=finished_at.isoformat(),
    )

    if result.timed_out:
        raise _ops_error(
            status_code=504,
            error="action_timed_out",
            message=f"Action {action_def.action_id} timed out after {action_def.timeout_seconds}s",
            detail=response.model_dump(),
        )

    return response
