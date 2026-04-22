"""Synchronous subprocess runner for allowlisted actions.

Everything about this module is intentionally narrow:

* ``argv`` is always a tuple of strings. ``shell=False``.
* ``env`` is rebuilt from scratch per invocation from an allowlist.
* Output is capped, decoded with ``errors='replace'``, and scrubbed for known
  secret values before being returned or logged.
* On timeout the process is killed and partial output is returned.

No caller path exists anywhere in HomeButler that passes a user-provided
string into ``argv``; the registry is the only source.
"""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

_LOG = logging.getLogger(__name__)

# Env var names whose VALUES (if set) should be scrubbed out of captured
# output before we return or log it. Exhaustive, not heuristic.
_SECRET_ENV_NAMES: tuple[str, ...] = (
    "GROCY_API_KEY",
    "CLOUDFLARED_TOKEN",
    "GOVEE_API_KEY",
    "GOVEE_PASSWORD",
    "MQTT_PASSWORD",
)

_DEFAULT_GLOBAL_ENV_ALLOWLIST: tuple[str, ...] = (
    "PATH",
    "HOME",
    "TZ",
    "LANG",
    "LC_ALL",
)


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    truncated: bool
    timed_out: bool


def _redact(text: str) -> str:
    if not text:
        return text
    redacted = text
    for name in _SECRET_ENV_NAMES:
        value = os.environ.get(name)
        if value and len(value) >= 4:
            redacted = redacted.replace(value, "***")
    return redacted


def _decode_and_cap(raw: bytes, cap_bytes: int) -> tuple[str, bool]:
    if raw is None:
        return "", False
    truncated = False
    if len(raw) > cap_bytes:
        raw = raw[:cap_bytes]
        truncated = True
    text = raw.decode("utf-8", errors="replace")
    if truncated:
        text += f"\n… [truncated, output exceeded {cap_bytes} bytes]\n"
    return text, truncated


def _argv_hash(argv: tuple[str, ...]) -> str:
    joined = "\x00".join(argv).encode("utf-8")
    return hashlib.sha256(joined).hexdigest()[:12]


class CommandRunner:
    def __init__(
        self,
        *,
        stdout_cap_bytes: int = 64 * 1024,
        stderr_cap_bytes: int = 64 * 1024,
        global_env_allowlist: tuple[str, ...] = _DEFAULT_GLOBAL_ENV_ALLOWLIST,
    ) -> None:
        if stdout_cap_bytes <= 0 or stderr_cap_bytes <= 0:
            raise ValueError("output caps must be positive")
        self._stdout_cap = stdout_cap_bytes
        self._stderr_cap = stderr_cap_bytes
        self._global_env_allowlist = tuple(global_env_allowlist)

    def run(
        self,
        *,
        argv: tuple[str, ...],
        cwd: str,
        timeout_seconds: int,
        extra_env_allowlist: tuple[str, ...] = (),
        action_id: str | None = None,
    ) -> CommandResult:
        if not argv or not all(isinstance(token, str) and token for token in argv):
            raise ValueError("argv must be a non-empty tuple of non-empty strings")
        if not isinstance(timeout_seconds, int) or not (1 <= timeout_seconds <= 1800):
            raise ValueError("timeout_seconds must be an int in [1, 1800]")

        cwd_path = Path(cwd)
        if not cwd_path.is_absolute():
            raise ValueError(f"cwd must be absolute: {cwd!r}")
        if not cwd_path.exists() or not cwd_path.is_dir():
            raise ValueError(f"cwd does not exist or is not a directory: {cwd!r}")

        env_allowlist = tuple(self._global_env_allowlist) + tuple(extra_env_allowlist)
        env = {k: os.environ[k] for k in env_allowlist if k in os.environ}

        start = time.monotonic()
        timed_out = False
        exit_code: int = -1
        stdout_raw = b""
        stderr_raw = b""

        try:
            # Popen lets us capture partial output on timeout. shell=False is hard-coded.
            proc = subprocess.Popen(  # noqa: S603 - argv is from registry, shell=False
                list(argv),
                cwd=str(cwd_path),
                env=env,
                shell=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                stdout_raw, stderr_raw = proc.communicate(timeout=timeout_seconds)
                exit_code = int(proc.returncode)
            except subprocess.TimeoutExpired:
                timed_out = True
                proc.kill()
                try:
                    stdout_raw, stderr_raw = proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    stdout_raw, stderr_raw = b"", b""
                exit_code = -1
        except FileNotFoundError as exc:
            duration_ms = int((time.monotonic() - start) * 1000)
            _LOG.warning(
                "command_runner: executable missing",
                extra={
                    "action_id": action_id,
                    "argv_hash": _argv_hash(argv),
                    "error": str(exc),
                },
            )
            raise

        duration_ms = int((time.monotonic() - start) * 1000)
        stdout, stdout_trunc = _decode_and_cap(stdout_raw, self._stdout_cap)
        stderr, stderr_trunc = _decode_and_cap(stderr_raw, self._stderr_cap)
        stdout = _redact(stdout)
        stderr = _redact(stderr)

        _LOG.info(
            "command_runner: complete",
            extra={
                "action_id": action_id,
                "argv_hash": _argv_hash(argv),
                "cwd": str(cwd_path),
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "timed_out": timed_out,
                "truncated": stdout_trunc or stderr_trunc,
            },
        )

        return CommandResult(
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            truncated=stdout_trunc or stderr_trunc,
            timed_out=timed_out,
        )
