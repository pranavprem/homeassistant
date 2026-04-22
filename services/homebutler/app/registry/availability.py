"""Action availability computation.

Computed at request time (not cached) because mount state can change at any
moment. Availability is a cheap filesystem + ``shutil.which`` check; never a
network call.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.registry.actions import ActionDef


@dataclass(frozen=True)
class ActionAvailability:
    available: bool
    repo_path_resolved: str | None
    missing_executables: tuple[str, ...]
    reason: str | None


def compute_availability(action: ActionDef) -> ActionAvailability:
    """Check whether ``action`` can run right now.

    Checks, in order:
      1. Every ``required_executables`` entry resolves via ``shutil.which``.
      2. ``repo_path_env`` (if set) resolves to an existing directory.

    Missing executables take priority when both fail because they'd block every
    invocation until the image is rebuilt — the operator should fix that first.
    """

    missing = tuple(
        name for name in action.required_executables if shutil.which(name) is None
    )

    repo_path_resolved: str | None = None
    repo_path_reason: str | None = None
    if action.repo_path_env:
        raw = os.environ.get(action.repo_path_env, "").strip()
        if not raw:
            repo_path_reason = (
                f"env var {action.repo_path_env} is not set"
            )
        else:
            path = Path(raw)
            if not path.exists():
                repo_path_reason = f"repo path {raw} does not exist"
            elif not path.is_dir():
                repo_path_reason = f"repo path {raw} is not a directory"
            else:
                repo_path_resolved = str(path)

    if missing:
        reason = f"missing executable(s): {', '.join(missing)}"
        return ActionAvailability(
            available=False,
            repo_path_resolved=repo_path_resolved,
            missing_executables=missing,
            reason=reason,
        )

    if repo_path_reason is not None:
        return ActionAvailability(
            available=False,
            repo_path_resolved=None,
            missing_executables=(),
            reason=repo_path_reason,
        )

    return ActionAvailability(
        available=True,
        repo_path_resolved=repo_path_resolved,
        missing_executables=(),
        reason=None,
    )
