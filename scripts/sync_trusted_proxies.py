#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ipaddress
import os
import re
import shlex
import socket
import subprocess
import sys
from pathlib import Path
from typing import Iterable

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT_DIR / ".env"

UNTRUSTED_PROXY_RE = re.compile(r"untrusted proxy ([0-9a-fA-F:.]+)", re.IGNORECASE)


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = raw_line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def get_compose_cmd() -> list[str]:
    for cmd in (("docker", "compose"), ("docker-compose",)):
        try:
            subprocess.run(
                list(cmd) + ["version"],
                cwd=ROOT_DIR,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return list(cmd)
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    raise SystemExit("docker compose is required")


def ordered_unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def valid_ip_or_cidr(value: str) -> bool:
    try:
        if "/" in value:
            ipaddress.ip_network(value, strict=False)
        else:
            ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def detect_primary_host_ip() -> list[str]:
    candidates: list[str] = []
    for family, target in ((socket.AF_INET, ("8.8.8.8", 80)), (socket.AF_INET6, ("2001:4860:4860::8888", 80, 0, 0))):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                sock.connect(target)
                ip = sock.getsockname()[0]
                if not ip:
                    continue
                parsed = ipaddress.ip_address(ip)
                if parsed.is_loopback:
                    continue
                if parsed.is_private or parsed.is_link_local:
                    candidates.append(ip)
        except OSError:
            continue
    return ordered_unique(candidates)


def run_text(command: list[str]) -> str:
    result = subprocess.run(
        command,
        cwd=ROOT_DIR,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return ""
    return result.stdout


def detect_untrusted_proxy_ips(compose_cmd: list[str]) -> list[str]:
    logs = run_text(compose_cmd + ["logs", "--tail=400", "homeassistant"])
    return ordered_unique(match.group(1) for match in UNTRUSTED_PROXY_RE.finditer(logs))


def detect_cloudflared_container_ips() -> list[str]:
    output = run_text(
        [
            "docker",
            "inspect",
            "ha-cloudflared",
            "--format",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}}\n{{end}}",
        ]
    )
    return ordered_unique(line.strip() for line in output.splitlines() if line.strip())


def render_trusted_proxies(proxies: list[str]) -> list[str]:
    return ["  trusted_proxies:", *[f"    - {proxy}" for proxy in proxies]]


def update_http_block(block_lines: list[str], proxies: list[str]) -> list[str]:
    out: list[str] = []
    have_use_xff = False
    have_trusted_proxies = False
    i = 0
    while i < len(block_lines):
        line = block_lines[i]
        stripped = line.strip()

        if stripped.startswith("use_x_forwarded_for:"):
            out.append("  use_x_forwarded_for: true")
            have_use_xff = True
            i += 1
            continue

        if stripped.startswith("trusted_proxies:"):
            out.extend(render_trusted_proxies(proxies))
            have_trusted_proxies = True
            i += 1
            while i < len(block_lines):
                nxt = block_lines[i]
                if nxt.startswith("    ") or nxt.startswith("\t\t"):
                    i += 1
                    continue
                if not nxt.strip():
                    i += 1
                    continue
                break
            continue

        out.append(line)
        i += 1

    additions: list[str] = []
    if not have_use_xff:
        additions.append("  use_x_forwarded_for: true")
    if not have_trusted_proxies:
        additions.extend(render_trusted_proxies(proxies))

    if additions:
        if out and out[-1].strip():
            out.append("")
        out.extend(additions)

    return out


def patch_configuration_text(text: str, proxies: list[str]) -> str:
    lines = text.splitlines()
    http_start: int | None = None
    for idx, line in enumerate(lines):
        if line == "http:":
            http_start = idx
            break

    if http_start is None:
        new_lines = list(lines)
        if new_lines and new_lines[-1].strip():
            new_lines.append("")
        new_lines.extend(["http:", "  use_x_forwarded_for: true", *render_trusted_proxies(proxies)])
        return "\n".join(new_lines).rstrip() + "\n"

    http_end = len(lines)
    for idx in range(http_start + 1, len(lines)):
        line = lines[idx]
        if line and not line.startswith((" ", "\t")):
            http_end = idx
            break

    block = lines[http_start + 1 : http_end]
    updated_block = update_http_block(block, proxies)
    new_lines = lines[: http_start + 1] + updated_block + lines[http_end:]
    return "\n".join(new_lines).rstrip() + "\n"


def restart_homeassistant_if_running(compose_cmd: list[str]) -> bool:
    ps = run_text(compose_cmd + ["ps", "--services", "--filter", "status=running"])
    running = {line.strip() for line in ps.splitlines() if line.strip()}
    if "homeassistant" not in running:
        return False
    subprocess.run(compose_cmd + ["restart", "homeassistant"], cwd=ROOT_DIR, check=False)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync Home Assistant trusted_proxies with detected Cloudflared source IPs")
    parser.add_argument("--env-file", default=str(ENV_FILE))
    parser.add_argument("--config-file", help="Override configuration.yaml path")
    parser.add_argument("--restart-homeassistant", action="store_true", help="Restart Home Assistant if the config changed and the service is running")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    env_values = parse_env_file(Path(args.env_file))
    ha_config_path = args.config_file or str(Path(env_values.get("HA_CONFIG_PATH", os.environ.get("HA_CONFIG_PATH", ""))) / "configuration.yaml")
    if not ha_config_path or ha_config_path == "configuration.yaml":
        raise SystemExit("HA_CONFIG_PATH is not set; cannot locate configuration.yaml")

    config_file = Path(ha_config_path)
    config_file.parent.mkdir(parents=True, exist_ok=True)

    compose_cmd = get_compose_cmd()

    proxy_subnet = os.environ.get("PROXY_SUBNET") or env_values.get("PROXY_SUBNET") or ""
    detected = ordered_unique(
        [
            "127.0.0.1",
            "::1",
            proxy_subnet,
            *detect_primary_host_ip(),
            *detect_cloudflared_container_ips(),
            *detect_untrusted_proxy_ips(compose_cmd),
        ]
    )
    proxies = [value for value in detected if valid_ip_or_cidr(value)]
    if not proxies:
        raise SystemExit("Could not determine any trusted proxies")

    original = config_file.read_text() if config_file.exists() else ""
    updated = patch_configuration_text(original, proxies)

    changed = updated != original
    print("Trusted proxies:")
    for proxy in proxies:
        print(f"- {proxy}")

    if args.dry_run:
        print("\n(dry run, no file changes written)")
        return 0

    if changed:
        config_file.write_text(updated)
        print(f"\nUpdated {config_file}")
    else:
        print(f"\nNo changes needed in {config_file}")

    if changed and args.restart_homeassistant:
        restarted = restart_homeassistant_if_running(compose_cmd)
        if restarted:
            print("Restarted Home Assistant to apply trusted_proxies change")
        else:
            print("Home Assistant is not running yet, skipped restart")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
