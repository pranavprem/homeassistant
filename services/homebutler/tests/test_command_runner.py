"""Unit tests for the synchronous command runner."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.services.command_runner import CommandRunner  # noqa: E402


@pytest.fixture
def runner() -> CommandRunner:
    return CommandRunner(stdout_cap_bytes=256, stderr_cap_bytes=256)


def test_success_captures_output(runner: CommandRunner, tmp_path: Path) -> None:
    result = runner.run(
        argv=(sys.executable, "-c", "print('hello world')"),
        cwd=str(tmp_path),
        timeout_seconds=10,
        action_id="test.success",
    )
    assert result.exit_code == 0
    assert result.timed_out is False
    assert result.truncated is False
    assert "hello world" in result.stdout
    assert result.duration_ms >= 0


def test_non_zero_exit_is_captured_not_raised(runner: CommandRunner, tmp_path: Path) -> None:
    result = runner.run(
        argv=(sys.executable, "-c", "import sys; sys.exit(3)"),
        cwd=str(tmp_path),
        timeout_seconds=10,
    )
    assert result.exit_code == 3
    assert result.timed_out is False


def test_timeout_kills_process(runner: CommandRunner, tmp_path: Path) -> None:
    result = runner.run(
        argv=(sys.executable, "-c", "import time; time.sleep(5)"),
        cwd=str(tmp_path),
        timeout_seconds=1,
    )
    assert result.timed_out is True
    assert result.exit_code == -1


def test_stdout_truncated_when_over_cap(runner: CommandRunner, tmp_path: Path) -> None:
    # Print ~2KB to exceed the 256-byte cap
    script = "import sys; sys.stdout.write('x' * 2048)"
    result = runner.run(
        argv=(sys.executable, "-c", script),
        cwd=str(tmp_path),
        timeout_seconds=10,
    )
    assert result.truncated is True
    assert "[truncated" in result.stdout


def test_cwd_must_be_absolute(runner: CommandRunner) -> None:
    with pytest.raises(ValueError, match="absolute"):
        runner.run(argv=("echo", "hi"), cwd="relative/path", timeout_seconds=1)


def test_cwd_must_exist(runner: CommandRunner, tmp_path: Path) -> None:
    ghost = tmp_path / "nope"
    with pytest.raises(ValueError, match="does not exist|is not a directory"):
        runner.run(argv=("echo", "hi"), cwd=str(ghost), timeout_seconds=1)


def test_timeout_seconds_bounds_enforced(runner: CommandRunner, tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        runner.run(argv=("echo", "hi"), cwd=str(tmp_path), timeout_seconds=0)
    with pytest.raises(ValueError):
        runner.run(argv=("echo", "hi"), cwd=str(tmp_path), timeout_seconds=9999)


def test_env_stripped_to_allowlist(runner: CommandRunner, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SHOULD_NOT_LEAK", "leak-value")
    script = "import os, json, sys; sys.stdout.write(json.dumps(sorted(os.environ.keys())))"
    result = runner.run(
        argv=(sys.executable, "-c", script),
        cwd=str(tmp_path),
        timeout_seconds=10,
    )
    assert result.exit_code == 0
    assert "SHOULD_NOT_LEAK" not in result.stdout
    # PATH is part of the default allowlist and must be present for the subprocess to work.
    assert "PATH" in result.stdout


def test_env_passthrough_allowed_for_extra_allowlist(runner: CommandRunner, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPTIONAL_PASSTHROUGH", "yes-i-can-see-this")
    script = "import os, sys; sys.stdout.write(os.environ.get('OPTIONAL_PASSTHROUGH', '<missing>'))"
    result = runner.run(
        argv=(sys.executable, "-c", script),
        cwd=str(tmp_path),
        timeout_seconds=10,
        extra_env_allowlist=("OPTIONAL_PASSTHROUGH",),
    )
    assert result.exit_code == 0
    assert "yes-i-can-see-this" in result.stdout


def test_request_supplied_env_rejected_by_signature(runner: CommandRunner, tmp_path: Path) -> None:
    # The signature does not accept `env=`; passing it should fail at the type/kw level.
    with pytest.raises(TypeError):
        runner.run(  # type: ignore[call-arg]
            argv=("echo", "hi"),
            cwd=str(tmp_path),
            timeout_seconds=1,
            env={"FOO": "bar"},
        )


def test_secrets_are_redacted(runner: CommandRunner, tmp_path: Path, monkeypatch) -> None:
    secret = "sk-super-secret-token-1234567890"
    monkeypatch.setenv("GROCY_API_KEY", secret)
    script = f"import sys; sys.stdout.write({secret!r})"
    result = runner.run(
        argv=(sys.executable, "-c", script),
        cwd=str(tmp_path),
        timeout_seconds=10,
    )
    assert secret not in result.stdout
    assert "***" in result.stdout


def test_argv_must_be_nonempty(runner: CommandRunner, tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        runner.run(argv=(), cwd=str(tmp_path), timeout_seconds=1)
    with pytest.raises(ValueError):
        runner.run(argv=("",), cwd=str(tmp_path), timeout_seconds=1)
