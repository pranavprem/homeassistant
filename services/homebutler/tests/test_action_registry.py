"""Unit tests for the action registry and availability computation."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.registry import actions as actions_module  # noqa: E402
from app.registry.actions import ActionDef, ActionKind, validate_action_def  # noqa: E402
from app.registry.availability import compute_availability  # noqa: E402


def test_expected_actions_present() -> None:
    ids = {a.action_id for a in actions_module.list_actions()}
    assert ids == {
        "mediaserver.update_gluetun",
        "mediaserver.sync_configs",
        "morpheus.redeploy",
        "morpheus.health",
        "tor.restart",
        "tor.status",
    }


def test_all_actions_pass_validation() -> None:
    # Every entry in the registry must pass validation or it would not have imported.
    for action in actions_module.list_actions():
        validate_action_def(action)


def test_action_not_found_raises() -> None:
    with pytest.raises(actions_module.ActionNotFound):
        actions_module.get_action("nope.nope")


@pytest.mark.parametrize(
    "kwargs",
    [
        # Invalid action_id (missing dot)
        {"action_id": "badid", "argv": ("make", "t")},
        # Shell metachar in argv
        {"argv": ("make", "t && rm -rf /")},
        # argv[0] not in required_executables
        {"argv": ("bash", "-c", "echo hi"), "required_executables": ("make",)},
        # MAKE_TARGET with wrong shape
        {"argv": ("make", "t", "extra"), "kind": ActionKind.MAKE_TARGET},
        # Timeout out of bounds
        {"timeout_seconds": 0},
        {"timeout_seconds": 9999},
        # Unknown stack_id
        {"stack_id": "notastack"},
        # Empty required_executables
        {"required_executables": ()},
        # Non-uppercase extra env
        {"extra_env_allowlist": ("lowercase",)},
    ],
)
def test_invalid_action_definitions_are_rejected(kwargs: dict) -> None:
    base = dict(
        action_id="mediaserver.test_action",
        stack_id="mediaserver",
        description="x",
        kind=ActionKind.MAKE_TARGET,
        argv=("make", "t"),
        repo_path_env="HOMEBUTLER_MEDIASERVER_REPO",
        timeout_seconds=30,
        mutating=False,
        required_executables=("make",),
        extra_env_allowlist=(),
    )
    base.update(kwargs)
    candidate = ActionDef(**base)  # dataclass construction succeeds
    with pytest.raises(ValueError):
        validate_action_def(candidate)


def test_compute_availability_true_when_repo_and_exec_present(monkeypatch, tmp_path):
    monkeypatch.setenv("HOMEBUTLER_MEDIASERVER_REPO", str(tmp_path))
    monkeypatch.setattr(
        "app.registry.availability.shutil.which",
        lambda name: "/usr/bin/make" if name == "make" else None,
    )
    action = actions_module.get_action("mediaserver.sync_configs")
    availability = compute_availability(action)
    assert availability.available is True
    assert availability.repo_path_resolved == str(tmp_path)
    assert availability.reason is None
    assert availability.missing_executables == ()


def test_compute_availability_false_when_repo_missing(monkeypatch, tmp_path):
    ghost = tmp_path / "does-not-exist"
    monkeypatch.setenv("HOMEBUTLER_MEDIASERVER_REPO", str(ghost))
    monkeypatch.setattr(
        "app.registry.availability.shutil.which",
        lambda name: "/usr/bin/make",
    )
    action = actions_module.get_action("mediaserver.sync_configs")
    availability = compute_availability(action)
    assert availability.available is False
    assert availability.repo_path_resolved is None
    assert "does not exist" in (availability.reason or "")


def test_compute_availability_false_when_executable_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("HOMEBUTLER_MEDIASERVER_REPO", str(tmp_path))
    monkeypatch.setattr(
        "app.registry.availability.shutil.which",
        lambda name: None,
    )
    action = actions_module.get_action("mediaserver.sync_configs")
    availability = compute_availability(action)
    assert availability.available is False
    assert availability.missing_executables == ("make",)
    assert "make" in (availability.reason or "")


def test_compute_availability_false_when_env_unset(monkeypatch, tmp_path):
    monkeypatch.delenv("HOMEBUTLER_MEDIASERVER_REPO", raising=False)
    monkeypatch.setattr(
        "app.registry.availability.shutil.which",
        lambda name: "/usr/bin/make",
    )
    action = actions_module.get_action("mediaserver.sync_configs")
    availability = compute_availability(action)
    assert availability.available is False
    assert availability.repo_path_resolved is None
    assert "HOMEBUTLER_MEDIASERVER_REPO" in (availability.reason or "")


def test_missing_executable_takes_priority_over_missing_repo(monkeypatch):
    monkeypatch.delenv("HOMEBUTLER_MEDIASERVER_REPO", raising=False)
    monkeypatch.setattr(
        "app.registry.availability.shutil.which",
        lambda name: None,
    )
    action = actions_module.get_action("mediaserver.sync_configs")
    availability = compute_availability(action)
    assert availability.available is False
    assert "missing executable" in (availability.reason or "")
