"""Best-effort ATIF trajectory emission alongside the flat tool-call capture.

The runner's primary capture path (capture.py + normalizers.py) produces the
flat coding-agent-tool-calls.jsonl that bin/ check tools read; that path is
untouched. This module ADDITIONALLY shells out to the bun ATIF normalizer to
emit <run_dir>/trajectory.json (ATIF v1.7). It is purely additive and
best-effort: any failure (bun missing, normalizer error, missing session log)
is logged and returns False, never raising into the run and never changing the
existing verdict.

Only the claude runtime is wired today. The other-agent normalizers are being
built in parallel; ATIF_NORMALIZER_CLIS maps a normalizer name to its bun CLI,
so adding an agent later is a one-line dispatch entry.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ATIF_TRAJECTORY_FILENAME = "trajectory.json"

# normalizer name -> bun CLI (relative to <ts_root>/src) that turns a session
# log into an ATIF v1.7 trajectory on stdout. One entry per supported
# normalizer; adding an agent is a one-line addition here.
ATIF_NORMALIZER_CLIS: dict[str, str] = {
    "claude": "cli/normalize-claude.ts",
}


def supports_atif(normalizer: str) -> bool:
    """True when an ATIF normalizer CLI exists for this normalizer."""
    return normalizer in ATIF_NORMALIZER_CLIS


def emit_atif_trajectory(
    *,
    session_log_path: Path,
    out_path: Path,
    normalizer: str,
    version: str,
    ts_root: Path,
    bun: str = "bun",
) -> bool:
    """Run the bun ATIF normalizer on session_log_path, write stdout to out_path.

    Returns True on success, False on any failure. Never raises: a bun or
    normalizer failure must not change the run's verdict. The existing flat-JSONL
    capture path is independent of this call.
    """
    cli_rel = ATIF_NORMALIZER_CLIS.get(normalizer)
    if cli_rel is None:
        logger.info("ATIF emission skipped: no normalizer CLI for %r", normalizer)
        return False
    if not session_log_path.exists():
        logger.info("ATIF emission skipped: session log not found: %s", session_log_path)
        return False

    cli_path = ts_root / "src" / cli_rel
    cmd = [
        bun,
        "run",
        str(cli_path),
        str(session_log_path),
        "--version",
        version,
    ]
    try:
        result = subprocess.run(cmd, text=True, capture_output=True)
    except (OSError, subprocess.SubprocessError) as e:
        logger.info("ATIF emission failed to launch bun normalizer: %s", str(e)[:200])
        return False

    if result.returncode != 0:
        logger.info(
            "ATIF normalizer exited %d for %s; stderr: %s",
            result.returncode,
            session_log_path,
            result.stderr.strip()[:300],
        )
        return False

    try:
        out_path.write_text(result.stdout)
    except OSError as e:
        logger.info("ATIF emission failed to write %s: %s", out_path, str(e)[:200])
        return False
    return True
