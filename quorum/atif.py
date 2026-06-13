"""ATIF trajectory emission via the bun TS normalizers.

This module shells out to the unified bun ATIF normalizer (cli/normalize.ts)
to emit <run_dir>/trajectory.json (ATIF v1.7) — the canonical transcript that
the check-transcript CLI reads. capture.py drives this as its capture step;
checks read the result via QUORUM_TRANSCRIPT_PATH.

emit_atif_trajectory never raises: any failure (bun missing, normalizer error,
missing session log) is logged and returns False. capture.py treats that as a
zero-row capture, which keeps the empty-capture retry/guard (PRI-2081) intact.

All eight coding agents (claude, codex, gemini, copilot, opencode, pi, kimi,
antigravity) are TS-backed via the unified cli/normalize.ts dispatcher.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ATIF_TRAJECTORY_FILENAME = "trajectory.json"

# Absolute path to bun, resolved at import against the real PATH. capture.py
# drives emission as part of the verdict path, which runs under a sanitized
# PATH (the gauntlet env allowlist) — resolving bun here decouples capture from
# that runtime PATH so the emission doesn't silently fail. Falls back to the
# bare name when bun isn't discoverable at import.
_RESOLVED_BUN = shutil.which("bun") or "bun"

# The unified CLI that dispatches to the per-agent normalize function.
# Takes: <normalizer-name> <session-log-path> [--version <v>]
_UNIFIED_CLI = "cli/normalize.ts"

# Normalizer names that have a TS implementation in the unified dispatcher.
# All eight coding agents are TS-backed.
ATIF_SUPPORTED_NORMALIZERS: frozenset[str] = frozenset(
    {"claude", "codex", "gemini", "copilot", "opencode", "pi", "kimi", "antigravity"}
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
    normalizer failure must not change the run's verdict — capture.py treats a
    False return as a zero-row capture, which keeps the empty-capture retry
    (PRI-2081) firing. The default bare "bun" is resolved to the absolute path
    discovered at import; an explicit bun argument is used verbatim.
    """
    if normalizer not in ATIF_SUPPORTED_NORMALIZERS:
        logger.info("ATIF emission skipped: no normalizer for %r", normalizer)
        return False
    if not session_log_path.exists():
        logger.info("ATIF emission skipped: session log not found: %s", session_log_path)
        return False

    bun_exe = _RESOLVED_BUN if bun == "bun" else bun
    cli_path = ts_root / "src" / _UNIFIED_CLI
    cmd = [
        bun_exe,
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
