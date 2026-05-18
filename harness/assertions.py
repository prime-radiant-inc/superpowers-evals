"""Run a scenario's assertions/*.sh against the per-run dir.

These are AC regression-tests, not a second verifier. The Gauntlet QA
agent's verdict is authoritative for any single run; the assertions are
frozen deterministic checks that an AC catches what it should catch as
LLMs drift over time.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AssertionResult:
    name: str
    exit_code: int
    stdout: str
    stderr: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


def run_assertions(
    *,
    assertions_dir: Path,
    run_dir: Path,
    workdir: Path,
    bin_dir: Path,
) -> tuple[list[AssertionResult], bool]:
    if not assertions_dir.exists():
        return [], True
    scripts = sorted(
        p for p in assertions_dir.iterdir()
        if p.is_file() and os.access(p, os.X_OK)
    )
    env = {
        **os.environ,
        "DRILL_WORKDIR": str(workdir),
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
    }
    results: list[AssertionResult] = []
    for script in scripts:
        proc = subprocess.run(
            [str(script)],
            cwd=run_dir,
            env=env,
            capture_output=True,
            text=True,
        )
        results.append(AssertionResult(
            name=script.name,
            exit_code=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
        ))
    return results, all(r.passed for r in results)
