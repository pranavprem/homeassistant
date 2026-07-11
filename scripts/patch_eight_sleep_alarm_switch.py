#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from datetime import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT_DIR / ".env"
DEFAULT_HA_CONFIG_PATH = Path("/volume1/media/config/homeassistant-config")
TARGET_RELATIVE_PATH = Path("custom_components/eight_sleep/switch.py")


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
    raise SystemExit("docker compose is required to restart Home Assistant")


def restart_homeassistant_if_running() -> bool:
    compose_cmd = get_compose_cmd()
    ps = subprocess.run(
        compose_cmd + ["ps", "--services", "--filter", "status=running"],
        cwd=ROOT_DIR,
        check=False,
        capture_output=True,
        text=True,
    )
    running = {line.strip() for line in ps.stdout.splitlines() if line.strip()}
    if "homeassistant" not in running:
        return False
    subprocess.run(compose_cmd + ["restart", "homeassistant"], cwd=ROOT_DIR, check=True)
    return True


def resolve_target_file(args: argparse.Namespace, env_values: dict[str, str]) -> Path:
    if args.switch_file:
        return Path(args.switch_file)

    config_path = (
        args.config_dir
        or os.environ.get("HA_CONFIG_PATH")
        or env_values.get("HA_CONFIG_PATH")
        or str(DEFAULT_HA_CONFIG_PATH)
    )
    return Path(config_path) / TARGET_RELATIVE_PATH


def patch_switch_text(text: str) -> tuple[str, bool]:
    if "def _handle_missing_alarm(self) -> None:" in text:
        return text, False

    original = text

    if "import logging\n" not in text:
        needle = "from __future__ import annotations\n"
        if needle not in text:
            raise ValueError("Could not find future import in switch.py")
        text = text.replace(needle, needle + "import logging\n", 1)

    logger_line = "_LOGGER = logging.getLogger(__name__)"
    if logger_line not in text:
        needle = "from .const import DOMAIN\n"
        if needle not in text:
            raise ValueError("Could not find DOMAIN import in switch.py")
        text = text.replace(needle, needle + f"\n{logger_line}\n", 1)

    cleanup_needle = """        self._attr_extra_state_attributes.pop("time", None)
        self._attr_extra_state_attributes.pop("days", None)
        self._attr_extra_state_attributes.pop("thermal", None)
        self._attr_extra_state_attributes.pop("vibration", None)
"""
    cleanup_replacement = """        self._clear_alarm_attributes()
"""
    if cleanup_needle not in text:
        raise ValueError("Could not find alarm attribute cleanup block in switch.py")
    text = text.replace(cleanup_needle, cleanup_replacement, 1)

    helper_needle = """        self._attr_extra_state_attributes = {}
        self._update_attributes()

    def _update_attributes(self) -> None:
"""
    helper_replacement = """        self._attr_extra_state_attributes = {}
        self._update_attributes()

    def _clear_alarm_attributes(self) -> None:
        self._attr_extra_state_attributes.pop("time", None)
        self._attr_extra_state_attributes.pop("days", None)
        self._attr_extra_state_attributes.pop("thermal", None)
        self._attr_extra_state_attributes.pop("vibration", None)

    def _handle_missing_alarm(self) -> None:
        alarm_id = self._alarm_id or self._user_obj.next_alarm_id
        _LOGGER.warning(
            "Eight Sleep alarm with ID %s was not found; marking %s unavailable",
            alarm_id,
            self.entity_id or self.entity_description.key,
        )
        self._attr_available = False
        self._attr_is_on = False
        self._clear_alarm_attributes()

    def _update_attributes(self) -> None:
"""
    if helper_needle not in text:
        raise ValueError("Could not find EightSwitchEntity update method insertion point")
    text = text.replace(helper_needle, helper_replacement, 1)

    enabled_needle = """        if self._user_obj:
            self._attr_is_on = self._user_obj.get_alarm_enabled(self._alarm_id)

            alarm_id = self._alarm_id or self._user_obj.next_alarm_id
"""
    enabled_replacement = """        if self._user_obj:
            try:
                self._attr_is_on = self._user_obj.get_alarm_enabled(self._alarm_id)
            except Exception as err:
                if "Alarm with ID" not in str(err):
                    raise
                self._handle_missing_alarm()
                return

            self._attr_available = True

            alarm_id = self._alarm_id or self._user_obj.next_alarm_id
"""
    if enabled_needle not in text:
        raise ValueError("Could not find get_alarm_enabled call in switch.py")
    text = text.replace(enabled_needle, enabled_replacement, 1)

    return text, text != original


def write_backup(path: Path, original: str) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bak-{timestamp}")
    backup.write_text(original)
    return backup


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Patch the Eight Sleep HACS switch platform so stale next-alarm IDs do not break setup"
    )
    parser.add_argument("--env-file", default=str(ENV_FILE), help="Path to .env file")
    parser.add_argument("--config-dir", help="Override Home Assistant config directory")
    parser.add_argument("--switch-file", help="Patch an explicit eight_sleep/switch.py path")
    parser.add_argument("--restart-homeassistant", action="store_true", help="Restart the HA container after writing a change")
    parser.add_argument("--dry-run", action="store_true", help="Report what would change without writing")
    args = parser.parse_args()

    env_values = parse_env_file(Path(args.env_file))
    switch_file = resolve_target_file(args, env_values)
    if not switch_file.exists():
        raise SystemExit(f"Eight Sleep switch.py not found: {switch_file}")

    original = switch_file.read_text()
    patched, changed = patch_switch_text(original)
    if not changed:
        print(f"Already patched: {switch_file}")
        return 0

    if args.dry_run:
        print(f"Would patch: {switch_file}")
        return 0

    backup = write_backup(switch_file, original)
    switch_file.write_text(patched)
    print(f"Patched: {switch_file}")
    print(f"Backup: {backup}")

    if args.restart_homeassistant:
        if restart_homeassistant_if_running():
            print("Restarted Home Assistant")
        else:
            print("Home Assistant is not running; skipped restart")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
