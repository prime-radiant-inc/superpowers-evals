"""Best-effort ATIF trajectory emission alongside the flat tool-call capture.

The runner's primary capture path (capture.py + normalizers.py) produces the
flat coding-agent-tool-calls.jsonl that bin/ check tools read; that path is
untouched. This module ADDITIONALLY shells out to the bun ATIF normalizer to
emit <run_dir>/trajectory.json (ATIF v1.7). It is purely additive and
best-effort: any failure (bun missing, normalizer error, missing session log)
is logged and returns False, never raising into the run and never changing the
existing verdict.

All six coding agents with TS normalizers (claude, codex, gemini, copilot,
opencode, pi) are supported via the unified cli/normalize.ts dispatcher.
Agents without a TS normalizer (kimi, antigravity) are absent from
ATIF_SUPPORTED_NORMALIZERS and supports_atif returns False for them.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ATIF_TRAJECTORY_FILENAME = "trajectory.json"

# The unified CLI that dispatches to the per-agent normalize function.
# Takes: <normalizer-name> <session-log-path> [--version <v>]
_UNIFIED_CLI = "cli/normalize.ts"

# Normalizer names that have a TS implementation in the unified dispatcher.
# kimi and antigravity have no TS normalizer yet and are absent.
ATIF_SUPPORTED_NORMALIZERS: frozenset[str] = frozenset(
    {"claude", "codex", "gemini", "copilot", "opencode", "pi"}
)

# Kept for backward compatibility and one-line extensibility reference.
# Maps normalizer name -> CLI path relative to <ts_root>/src.
# All supported agents now share the unified CLI; the mapping is uniform.
ATIF_NORMALIZER_CLIS: dict[str, str] = {name: _UNIFIED_CLI for name in ATIF_SUPPORTED_NORMALIZERS}


def supports_atif(normalizer: str) -> bool:
    """True when an ATIF normalizer exists for this normalizer name."""
    return normalizer in ATIF_SUPPORTED_NORMALIZERS


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
    if normalizer not in ATIF_SUPPORTED_NORMALIZERS:
        logger.info("ATIF emission skipped: no normalizer for %r", normalizer)
        return False
    if not session_log_path.exists():
        logger.info("ATIF emission skipped: session log not found: %s", session_log_path)
        return False

    cli_path = ts_root / "src" / _UNIFIED_CLI
    cmd = [
        bun,
        "run",
        str(cli_path),
        normalizer,
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
