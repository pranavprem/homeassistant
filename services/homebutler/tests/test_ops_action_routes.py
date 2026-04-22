"""Integration tests for /ops/actions* routes."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _make_executable_available(monkeypatch):
    # Pretend make and docker are both on PATH so action availability is controlled
    # entirely by repo-path existence (conftest creates those dirs).
    import shutil

    real_which = shutil.which

    def fake_which(name, *args, **kwargs):
        if name in ("make", "docker"):
            return f"/usr/bin/{name}"
        return real_which(name, *args, **kwargs)

    monkeypatch.setattr("app.registry.availability.shutil.which", fake_which)


def test_list_actions_returns_all_registered(client) -> None:
    res = client.get("/ops/actions")
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 6
    ids = {a["action"] for a in body["actions"]}
    assert ids == {
        "mediaserver.update_gluetun",
        "mediaserver.sync_configs",
        "morpheus.redeploy",
        "morpheus.health",
        "tor.restart",
        "tor.status",
    }
    # With make + docker faked and tmp repos mkdir'd, all actions should be available.
    assert all(a["availability"]["available"] for a in body["actions"]), body


def test_get_action_returns_detail(client) -> None:
    res = client.get("/ops/actions/morpheus.health")
    assert res.status_code == 200
    body = res.json()
    assert body["action"]["action"] == "morpheus.health"
    assert body["action"]["mutating"] is False
    assert body["action"]["argv"] == ["make", "health"]


def test_unknown_action_returns_404(client) -> None:
    res = client.get("/ops/actions/nope.nope")
    assert res.status_code == 404
    assert res.json()["detail"]["error"] == "action_not_found"


def test_action_id_with_bad_shape_returns_404(client) -> None:
    res = client.get("/ops/actions/nodot")
    assert res.status_code == 404


def test_run_action_calls_runner_with_registry_argv(client) -> None:
    res = client.post("/ops/actions/morpheus.health/run")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "ok"
    assert body["exit_code"] == 0
    assert body["timed_out"] is False

    assert len(client.fake_runner.calls) == 1
    call = client.fake_runner.calls[0]
    assert call["argv"] == ("make", "health")
    assert call["action_id"] == "morpheus.health"
    assert call["timeout_seconds"] == 60


def test_run_action_surfaces_nonzero_exit_as_failed_not_5xx(client) -> None:
    client.fake_runner.script("morpheus.redeploy", exit_code=2, stderr="boom")
    res = client.post("/ops/actions/morpheus.redeploy/run")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "failed"
    assert body["exit_code"] == 2
    assert "boom" in body["stderr"]


def test_run_action_timeout_returns_504(client) -> None:
    client.fake_runner.script("tor.restart", timed_out=True, exit_code=-1)
    res = client.post("/ops/actions/tor.restart/run")
    assert res.status_code == 504
    assert res.json()["detail"]["error"] == "action_timed_out"


def test_run_action_returns_409_when_repo_missing(client, monkeypatch, tmp_path) -> None:
    # Point one stack's repo at a non-existent dir and confirm the action is rejected
    # with a 409, with no call to the runner.
    ghost = tmp_path / "does-not-exist"
    monkeypatch.setenv("HOMEBUTLER_MORPHEUS_REPO", str(ghost))
    res = client.post("/ops/actions/morpheus.health/run")
    assert res.status_code == 409
    body = res.json()
    assert body["detail"]["error"] == "action_unavailable"
    assert len(client.fake_runner.calls) == 0


def test_run_action_rejects_extra_body_fields(client) -> None:
    res = client.post(
        "/ops/actions/morpheus.health/run",
        json={"target": "rm -rf /"},
    )
    assert res.status_code == 422


def test_run_action_accepts_empty_body(client) -> None:
    res = client.post("/ops/actions/morpheus.health/run", json={})
    assert res.status_code == 200


def test_actions_disabled_returns_503(client, monkeypatch) -> None:
    from app import config as config_module

    monkeypatch.setenv("HOMEBUTLER_ACTIONS_ENABLED", "false")
    config_module.get_settings.cache_clear()

    res = client.get("/ops/actions")
    assert res.status_code == 503
    assert res.json()["detail"]["error"] == "actions_disabled"

    res = client.post("/ops/actions/morpheus.health/run")
    assert res.status_code == 503

    # Stack routes still work with actions disabled.
    res = client.get("/ops/stacks")
    assert res.status_code == 200
