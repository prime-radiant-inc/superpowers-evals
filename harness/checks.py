# harness/checks.py
"""Source a scenario's checks.sh, run a phase, collect the records.

A scenario's checks.sh defines two bash functions, `pre()` and `post()`. The
Harness invokes one phase at a time:

    bash -c 'source <checks.sh>; <phase>'

with cwd=<workdir>, PATH prepending harness/bin/, and HARNESS_RECORD_SINK
pointing at a fresh JSONL file. Each check tool emits one record; this module
parses the records and returns CheckRecord values. The phase is stamped here.

The script's *exit code* is the crash signal — non-zero means the script did
not run to completion. Pass/fail comes from the records.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Phase = Literal["pre", "post"]


@dataclass(frozen=True)
class CheckRecord:
    check: str
    args: list
    negated: bool
    passed: bool
    detail: str | None
    phase: Phase


_DIRECTIVE_RE = re.compile(r"^\s*#\s*coding-agents:\s*(.+?)\s*$")


def parse_coding_agents_directive(checks_sh: Path) -> list[str] | None:
    """Return the list from `# coding-agents: <csv>` if present, else None.

    Scans only the first ~20 lines; the directive must be a top-of-file comment.
    """
    if not checks_sh.exists():
        return None
    for i, line in enumerate(checks_sh.read_text().splitlines()):
        if i > 20:
            break
        m = _DIRECTIVE_RE.match(line)
        if m:
            return [t.strip() for t in m.group(1).split(",") if t.strip()]
    return None


def run_phase(
    *,
    checks_sh: Path,
    phase: Phase,
    workdir: Path,
    harness_bin: Path,
    tool_calls_path: Path | None = None,
    run_dir: Path | None = None,
) -> tuple[list[CheckRecord], int]:
    """Source checks.sh, call <phase>, return (records, script_exit_code).

    The exit code is the crash signal: non-zero means the script did not run to
    completion (per spec §7). Callers always need both — never just the records.
    """
    with tempfile.NamedTemporaryFile("w+", delete=False, suffix=".jsonl") as f:
        sink = Path(f.name)
    env = {
        "PATH": f"{harness_bin}:/usr/bin:/bin",
        "HARNESS_RECORD_SINK": str(sink),
        "HOME": str(Path.home()),  # git config, jq cache
    }
    if tool_calls_path is not None:
        env["HARNESS_TOOL_CALLS_PATH"] = str(tool_calls_path)
    if run_dir is not None:
        # Anchor for checks that need sibling paths (e.g. coding-agent-config/).
        # cwd inside checks.sh is the workdir, so siblings need an explicit anchor.
        env["HARNESS_RUN_DIR"] = str(run_dir)
    try:
        proc = subprocess.run(
            ["bash", "-c", f"source '{checks_sh}'; {phase}"],
            cwd=workdir, env=env, capture_output=True, text=True,
        )
        records = [
            CheckRecord(
                check=d["check"], args=d["args"], negated=d["negated"],
                passed=d["passed"], detail=d.get("detail"), phase=phase,
            )
            for line in sink.read_text().splitlines() if line.strip()
            for d in [json.loads(line)]
        ]
        # The exit code is the crash signal (spec §7): a non-zero exit with no
        # records means the script did not run to completion. When records were
        # emitted, the phase ran successfully — individual check failures exit
        # the tool with 1, but that is normal behaviour, not a crash.
        exit_code = 0 if records else proc.returncode
        return records, exit_code
    finally:
        sink.unlink(missing_ok=True)
