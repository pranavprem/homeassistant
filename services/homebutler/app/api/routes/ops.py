from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.clients.docker_ops import DockerOpsClient, DockerOpsError
from app.config import get_settings
from app.schemas import (
    ContainerDetailResponse,
    ContainerListResponse,
    ContainerLogsResponse,
    ContainerMutationResponse,
    ContainerSummary,
)

router = APIRouter(prefix="/ops", tags=["ops"])


def _get_client() -> DockerOpsClient:
    settings = get_settings()
    return DockerOpsClient(
        docker_host=settings.docker_host,
        allowed_containers=settings.controlled_containers,
    )


def _raise_http(exc: DockerOpsError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/containers", response_model=ContainerListResponse)
def list_containers() -> ContainerListResponse:
    try:
        containers = _get_client().list_containers()
    except DockerOpsError as exc:
        _raise_http(exc)

    return ContainerListResponse(
        count=len(containers),
        containers=[ContainerSummary(**item) for item in containers],
    )


@router.get("/containers/{name}", response_model=ContainerDetailResponse)
def get_container(name: str) -> ContainerDetailResponse:
    try:
        container = _get_client().get_container(name)
    except DockerOpsError as exc:
        _raise_http(exc)

    return ContainerDetailResponse(container=ContainerSummary(**container))


@router.get("/containers/{name}/logs", response_model=ContainerLogsResponse)
def get_container_logs(
    name: str,
    tail: int = Query(default=200, ge=1, le=1000),
) -> ContainerLogsResponse:
    try:
        logs = _get_client().get_logs(name, tail=tail)
    except DockerOpsError as exc:
        _raise_http(exc)

    return ContainerLogsResponse(name=name, tail=tail, logs=logs)


@router.post("/containers/{name}/restart", response_model=ContainerMutationResponse)
def restart_container(name: str) -> ContainerMutationResponse:
    try:
        container = _get_client().restart(name)
    except DockerOpsError as exc:
        _raise_http(exc)

    summary = ContainerSummary(**container)
    return ContainerMutationResponse(
        status="restarted",
        message=f"Restarted container {name}",
        container=summary,
    )
