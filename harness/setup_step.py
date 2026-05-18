"""Run a scenario's setup.sh against a temp workdir.

DRILL_WORKDIR is exported (matching Drill's convention) so existing helper
shell scripts continue to work without rename.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


class SetupError(RuntimeError):
    """Raised when setup.sh exits non-zero."""


def run_setup(
    scenario_dir: Path,
    workdir: Path,
    env_extra: dict[str, str] | None = None,
) -> None:
    setup_path = scenario_dir / "setup.sh"
    if not setup_path.exists():
        return
    env = {**os.environ, "DRILL_WORKDIR": str(workdir), **(env_extra or {})}
    proc = subprocess.run(
        [str(setup_path)],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SetupError(
            f"setup.sh exit {proc.returncode} (in {scenario_dir.name}):\n"
            f"--- stdout ---\n{proc.stdout}\n"
            f"--- stderr ---\n{proc.stderr}"
        )
