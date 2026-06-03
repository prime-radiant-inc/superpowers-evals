"""Snapshot, diff, and normalize agent-under-test session-log directories."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from quorum.normalizers import (
    NORMALIZERS,
    filter_codex_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    find_misplaced_pi_sessions,
    find_unusable_pi_sessions,
)
from quorum.token_usage import capture_tokens


@dataclass(frozen=True)
class CaptureResult:
    path: Path
    source_logs: tuple[Path, ...]
    row_count: int


def snapshot_dir(log_dir: Path, glob: str) -> set[str]:
    if not log_dir.exists():
        return set()
    return {str(p.relative_to(log_dir)) for p in log_dir.glob(glob)}


def new_files_since(log_dir: Path, glob: str, snapshot: set[str]) -> list[Path]:
    if not log_dir.exists():
        return []
    current = {str(p.relative_to(log_dir)): p for p in log_dir.glob(glob)}
    return [current[k] for k in sorted(set(current) - snapshot)]


def _new_session_logs(
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    launch_cwd: Path | None,
) -> list[Path]:
    """New session-log files since `snapshot`, cwd-filtered for codex/pi.

    codex and pi share one session-log tree across runs, so their new-file
    diff is narrowed to rollouts whose recorded session cwd matches the
    launch cwd. This must be the launch cwd, not the scenario workdir — a
    scenario may point the agent at a subdir via .quorum-launch-cwd.
    """
    new = new_files_since(log_dir, log_glob, snapshot)
    if normalizer == "codex" and launch_cwd is not None:
        new = filter_codex_logs_by_cwd(new, str(launch_cwd))
    elif normalizer == "pi" and launch_cwd is not None:
        new = filter_pi_logs_by_cwd(new, str(launch_cwd))
    return new


def capture_tool_calls(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
) -> CaptureResult:
    """Diff log_dir, filter by cwd if applicable, normalize, write JSONL.

    Always writes coding-agent-tool-calls.jsonl (empty if no new logs) so
    downstream assertions can rely on the file existing. The returned metadata
    lets runner diagnostics distinguish missing source logs from zero normalized
    rows.
    """
    new = _new_session_logs(log_dir, log_glob, snapshot, normalizer, launch_cwd)
    fn = NORMALIZERS[normalizer]
    out_path = run_dir / "coding-agent-tool-calls.jsonl"
    row_count = 0
    with out_path.open("w") as f:
        for path in new:
            for row in fn(path.read_text()):
                f.write(json.dumps(row) + "\n")
                row_count += 1
    return CaptureResult(path=out_path, source_logs=tuple(new), row_count=row_count)


def detect_misplaced_codex_rollouts(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    run_dir: Path,
    launch_cwd: Path,
) -> list[Path]:
    """Codex rollouts inside this run_dir that launched in the wrong cwd.

    Smoking gun for the QA agent skipping `cd $QUORUM_AGENT_CWD` before
    launching codex — see find_misplaced_codex_rollouts. Returns empty when
    nothing is misplaced; runner uses a non-empty return to short-circuit to
    indeterminate with stage="qa-agent-misconfigured".
    """
    new = new_files_since(log_dir, log_glob, snapshot)
    return find_misplaced_codex_rollouts(new, run_dir=run_dir, launch_cwd=launch_cwd)


def detect_misplaced_pi_sessions(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    launch_cwd: Path,
) -> list[Path]:
    """New run-local Pi sessions that launched in the wrong cwd."""
    new = new_files_since(log_dir, log_glob, snapshot)
    return find_misplaced_pi_sessions(new, launch_cwd=launch_cwd)


def detect_unusable_pi_sessions(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
) -> list[Path]:
    """New Pi session files whose first row cannot identify a session cwd."""
    new = new_files_since(log_dir, log_glob, snapshot)
    return find_unusable_pi_sessions(new)


def capture_token_usage(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
) -> Path | None:
    """Sum token usage across the run's new session logs; write coding-agent-token-usage.json.

    Measurement only — the pass/fail verdict is unaffected.
    coding-agent-token-usage.json sits in run_dir alongside verdict.json; a
    cost scenario reads it from an ordinary deterministic assertion (see
    docs/migration-notes.md, the cost / measurement decision). Returns the
    written path, or None when usage can't be captured — a backend
    token_usage.py does not parse (gemini, pi), or no new session logs were
    produced — in which case no file is written.
    """
    new = _new_session_logs(log_dir, log_glob, snapshot, normalizer, launch_cwd)
    usage = capture_tokens(normalizer, new)
    if usage is None:
        return None
    out_path = run_dir / "coding-agent-token-usage.json"
    out_path.write_text(json.dumps(usage, indent=2) + "\n")
    return out_path
