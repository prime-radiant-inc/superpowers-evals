# quorum/checks.py
"""Source a scenario's checks.sh, run a phase, collect the records.

A scenario's checks.sh defines two bash functions, `pre()` and `post()`. The
quorum invokes one phase at a time:

    bash -c 'source <checks.sh>; <phase>'

with cwd=<workdir>, PATH prepending bin/, and QUORUM_RECORD_SINK
pointing at a fresh JSONL file. Each check tool emits one record; this module
parses the records and returns CheckRecord values. The phase is stamped here.

The script's *exit code* is the crash signal — non-zero means the script did
not run to completion. Pass/fail comes from the records.
"""

from __future__ import annotations

import json
import os
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
    quorum_bin: Path,
    tool_calls_path: Path | None = None,
    run_dir: Path | None = None,
) -> tuple[list[CheckRecord], int]:
    """Source checks.sh, call <phase>, return (records, script_exit_code).

    The exit code is the crash signal: non-zero means the script did not run to
    completion (per spec §7). Callers always need both — never just the records.
    """
    with tempfile.NamedTemporaryFile("w+", delete=False, suffix=".jsonl") as f:
        sink = Path(f.name)
    # Inherit os.environ for PATH and friends — checks like `requires-tool npm`
    # or `command-succeeds 'go test'` need brew / pyenv / nvm tools that don't
    # live in /usr/bin or /bin. Prepend quorum_bin so the check vocabulary
    # wins lookups, then layer our own overrides on top.
    env = {
        **os.environ,
        "PATH": f"{quorum_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "QUORUM_RECORD_SINK": str(sink),
    }
    if tool_calls_path is not None:
        env["QUORUM_TOOL_CALLS_PATH"] = str(tool_calls_path)
    if run_dir is not None:
        # Anchor for checks that need sibling paths (e.g. coding-agent-config/).
        # cwd inside checks.sh is the workdir, so siblings need an explicit anchor.
        env["QUORUM_RUN_DIR"] = str(run_dir)
    try:
        proc = subprocess.run(
            ["bash", "-c", f"source '{checks_sh}'; {phase}"],
            cwd=workdir,
            env=env,
            capture_output=True,
            text=True,
        )
        records = [
            CheckRecord(
                check=d["check"],
                args=d["args"],
                negated=d["negated"],
                passed=d["passed"],
                detail=d.get("detail"),
                phase=phase,
            )
            for line in sink.read_text().splitlines()
            if line.strip()
            for d in [json.loads(line)]
        ]
        # The exit code is the crash signal (spec §7). Distinguishing a
        # *crash* from a *check failure* requires looking at where the exit
        # code lands:
        #
        #   - 0 → phase ran clean to the end. No crash.
        #   - 126 (not-executable), 127 (command-not-found), >= 128
        #     (signal-killed) → bash itself crashed mid-phase. Typo'd
        #     function name (`tools-called` instead of `tool-called`) is the
        #     common bite; that's exit 127. Treat as crash regardless of
        #     whether records were emitted before it happened.
        #   - 1-125 → either a check tool's intentional fail-exit, OR a
        #     user-written `false` / bad conditional. Treat as completed
        #     when any records were emitted; treat as crash when none were
        #     (the script likely failed before any tool ran).
        #
        # This is a heuristic — it can miss a crash whose exit happens to
        # land in 1-125 *and* is followed by no further records (so we
        # incorrectly assume "tool failed"). Codex flagged a stricter
        # alternative — change every tool to exit 0 always, drive crash
        # detection purely off returncode — which is cleaner but a much
        # larger contract change. The heuristic catches every typo-style
        # crash (which is what bites in practice) without that surgery.
        crash_codes = proc.returncode == 126 or proc.returncode == 127 or proc.returncode >= 128
        if proc.returncode == 0:
            exit_code = 0
        elif crash_codes:
            exit_code = proc.returncode
        elif records:
            exit_code = 0
        else:
            exit_code = proc.returncode
        return records, exit_code
    finally:
        sink.unlink(missing_ok=True)
