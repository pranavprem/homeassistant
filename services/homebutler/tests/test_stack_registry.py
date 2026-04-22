"""Unit tests for the stack registry."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.registry import stacks  # noqa: E402


def test_expected_stacks_present() -> None:
    ids = {s.stack_id for s in stacks.list_stacks()}
    assert ids == {"homeassistant", "mediaserver", "morpheus", "tor"}


def test_service_resolution_returns_stack_and_service() -> None:
    stack, svc = stacks.get_service("mediaserver", "paperless_webserver")
    assert stack.stack_id == "mediaserver"
    assert svc.service_id == "paperless_webserver"
    assert svc.container_name == "paperless-webserver"


def test_get_stack_raises_for_unknown() -> None:
    with pytest.raises(stacks.StackNotFound):
        stacks.get_stack("nope")


def test_get_service_raises_for_unknown_stack() -> None:
    with pytest.raises(stacks.StackNotFound):
        stacks.get_service("nope", "whatever")


def test_get_service_raises_for_unknown_service() -> None:
    with pytest.raises(stacks.ServiceNotFound):
        stacks.get_service("tor", "not-a-service")


def test_all_controlled_container_names_covers_every_service() -> None:
    names = stacks.all_controlled_container_names()
    flat = [
        svc.container_name for stack in stacks.list_stacks() for svc in stack.services
    ]
    assert set(names) == set(flat)
    assert len(names) == len(flat), "container names must be unique across stacks"


def test_service_ids_use_underscores_not_dashes() -> None:
    for stack in stacks.list_stacks():
        for svc in stack.services:
            assert "-" not in svc.service_id, (
                f"service_id {svc.service_id!r} in stack {stack.stack_id!r} contains '-'"
            )


def test_homeassistant_registry_contains_expected_services() -> None:
    stack = stacks.get_stack("homeassistant")
    names = {svc.service_id: svc.container_name for svc in stack.services}
    assert names["homeassistant"] == "homeassistant"
    assert names["grocy"] == "grocy"
    assert names["homebutler"] == "homebutler"
    assert names["cloudflared"] == "ha-cloudflared"


def test_mediaserver_registry_contains_expected_services() -> None:
    stack = stacks.get_stack("mediaserver")
    names = {svc.service_id: svc.container_name for svc in stack.services}
    # Spot check dashed container names
    assert names["immich_server"] == "immich-server"
    assert names["immich_ml"] == "immich-machine-learning"
    assert names["paperless_gotenberg"] == "paperless-gotenberg"
    assert names["node_exporter"] == "node-exporter"
