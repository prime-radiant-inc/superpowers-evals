"""Run a scenario's setup.sh against a temp workdir.

setup.sh builds the fixture (clones the template, plants files…). It is run
with HARNESS_WORKDIR exported so the script (and any setup helpers it invokes)
can locate the workdir.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


class SetupError(RuntimeError):
    """Raised when setup.sh exits non-zero."""


def _run_scenario_script(
    scenario_dir: Path,
    script_name: str,
    workdir: Path,
    env_extra: dict[str, str] | None,
    error_cls: type[RuntimeError],
) -> None:
    script = scenario_dir / script_name
    if not script.exists():
        return
    env = {**os.environ, "HARNESS_WORKDIR": str(workdir), **(env_extra or {})}
    proc = subprocess.run(
        [str(script)],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise error_cls(
            f"{script_name} exit {proc.returncode} (in {scenario_dir.name}):\n"
            f"--- stdout ---\n{proc.stdout}\n"
            f"--- stderr ---\n{proc.stderr}"
        )


def run_setup(
    scenario_dir: Path,
    workdir: Path,
    env_extra: dict[str, str] | None = None,
) -> None:
    _run_scenario_script(scenario_dir, "setup.sh", workdir, env_extra, SetupError)
