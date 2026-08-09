"""Integration tests for /ops/stacks* and the legacy /ops/containers* routes."""

from __future__ import annotations


def _seed(client) -> None:
    client.fake_docker.add("homeassistant", image="ha:stable")
    client.fake_docker.add("grocy", image="grocy:latest")
    client.fake_docker.add("homebutler")
    client.fake_docker.add("mosquitto")
    client.fake_docker.add("govee2mqtt")
    client.fake_docker.add("zigbee2mqtt")
    client.fake_docker.add("ha-cloudflared")
    client.fake_docker.add("tor-proxy")
    # tor-firefox intentionally not added so its `container` field is null.
    client.fake_docker.add("morpheus")


def test_legacy_containers_list_still_works(client) -> None:
    _seed(client)
    res = client.get("/ops/containers")
    assert res.status_code == 200
    names = [c["name"] for c in res.json()["containers"]]
    assert "homeassistant" in names


def test_legacy_container_restart_still_works(client) -> None:
    _seed(client)
    res = client.post("/ops/containers/grocy/restart")
    assert res.status_code == 200
    assert res.json()["status"] == "restarted"
    assert "grocy" in client.fake_docker.restart_calls


def test_list_stacks_returns_all_registered(client) -> None:
    _seed(client)
    res = client.get("/ops/stacks")
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 4
    ids = sorted(s["stack"] for s in body["stacks"])
    assert ids == ["homeassistant", "mediaserver", "morpheus", "tor"]


def test_list_stacks_populates_container_from_running_list(client) -> None:
    _seed(client)
    res = client.get("/ops/stacks")
    by_stack = {s["stack"]: s for s in res.json()["stacks"]}
    tor = by_stack["tor"]
    svcs = {s["service"]: s for s in tor["services"]}
    assert svcs["proxy"]["container"] is not None
    assert svcs["firefox"]["container"] is None  # not seeded


def test_get_stack_returns_single_stack(client) -> None:
    _seed(client)
    res = client.get("/ops/stacks/homeassistant")
    assert res.status_code == 200
    body = res.json()
    assert body["stack"]["stack"] == "homeassistant"
    assert body["stack"]["repo_path_env"] == "HOMEBUTLER_HOMEASSISTANT_REPO"
    # repo_path_resolved should be set because the conftest tmp_path is mkdir'd.
    assert body["stack"]["repo_path_resolved"] is not None


def test_get_unknown_stack_returns_404(client) -> None:
    res = client.get("/ops/stacks/notreal")
    assert res.status_code == 404
    assert res.json()["detail"]["error"] == "stack_not_found"


def test_get_invalid_stack_id_shape_returns_404(client) -> None:
    res = client.get("/ops/stacks/BAD-SHAPE!")
    assert res.status_code == 404


def test_get_service_returns_detail_with_container(client) -> None:
    _seed(client)
    res = client.get("/ops/stacks/homeassistant/services/grocy")
    assert res.status_code == 200
    body = res.json()
    assert body["service"]["service"] == "grocy"
    assert body["service"]["container_name"] == "grocy"
    assert body["service"]["container"] is not None


def test_get_service_returns_null_container_when_absent(client) -> None:
    # tor-firefox not seeded
    res = client.get("/ops/stacks/tor/services/firefox")
    assert res.status_code == 200
    body = res.json()
    assert body["service"]["container"] is None


def test_get_unknown_service_returns_404(client) -> None:
    res = client.get("/ops/stacks/tor/services/notreal")
    assert res.status_code == 404
    assert res.json()["detail"]["error"] == "service_not_found"


def test_service_logs_call_docker_with_resolved_container_name(client) -> None:
    _seed(client)
    res = client.get("/ops/stacks/mediaserver/services/gluetun/logs?tail=50")
    # gluetun not seeded -> DockerOps returns 404 through the route
    assert res.status_code == 404

    client.fake_docker.add("gluetun")
    res = client.get("/ops/stacks/mediaserver/services/gluetun/logs?tail=50")
    assert res.status_code == 200
    assert res.json()["container_name"] == "gluetun"
    assert client.fake_docker.log_calls[-1] == ("gluetun", 50)


def test_service_logs_rejects_too_large_tail(client) -> None:
    res = client.get("/ops/stacks/homeassistant/services/grocy/logs?tail=9999")
    assert res.status_code == 422


def test_service_restart_resolves_container_name(client) -> None:
    _seed(client)
    res = client.post("/ops/stacks/homeassistant/services/cloudflared/restart")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "restarted"
    assert body["service"]["container_name"] == "ha-cloudflared"
    assert client.fake_docker.restart_calls[-1] == "ha-cloudflared"
