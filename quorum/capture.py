"""Snapshot, diff, and capture agent-under-test session-log directories.

Capture emits the ATIF trajectory.json (via the bun TS normalizers in
quorum/atif.py) from the run's new session logs. A run can produce more than
one session log — gemini writes a main chat plus a subagent chat, and any
agent's subagent runs each write their own file — so capture normalizes EVERY
new log and merges them into ONE trajectory ordered by step timestamp. The flat
tool-call JSONL and the Python normalizers it used are gone — checks read the
ATIF trajectory via QUORUM_TRANSCRIPT_PATH.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from quorum.atif import ATIF_TRAJECTORY_FILENAME, emit_atif_trajectory
from quorum.log_filters import (
    filter_codex_logs_by_cwd,
    filter_kimi_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    find_misplaced_pi_sessions,
    find_unusable_pi_sessions,
)
from quorum.obol_capture import estimate_session_logs
from quorum.timing import session_logs_duration_ms


def _ts_root() -> Path:
    """Return the repo's ts/ directory (where the bun ATIF normalizers live)."""
    return Path(__file__).resolve().parent.parent / "ts"


@dataclass(frozen=True)
class CaptureResult:
    # Path to the emitted ATIF trajectory.json. The file may be absent on a
    # zero-row capture: emission failures and trajectories with no tool calls
    # leave no file (so downstream loaders fail closed and the retry fires).
    path: Path
    source_logs: tuple[Path, ...]
    row_count: int
    # How many capture passes ran (PRI-2081): 1 = first pass succeeded;
    # >1 = the empty-capture retry re-diffed after a delay.
    attempts: int = 1


@dataclass(frozen=True)
class KimiUnmatchedLogsDiagnostic:
    paths: tuple[Path, ...]
    reason: Literal["wrong-cwd", "unmapped"]
    stage: Literal["capture", "qa-agent-misconfigured"]


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
    """New session-log files since `snapshot`, cwd-filtered for shared-log agents.

    codex, kimi, and pi share one session-log tree across runs, so their new-file
    diff is narrowed to logs whose recorded session cwd matches the
    launch cwd. This must be the launch cwd, not the scenario workdir — a
    scenario may point the agent at a subdir via .quorum-launch-cwd.
    """
    new = new_files_since(log_dir, log_glob, snapshot)
    if normalizer == "codex" and launch_cwd is not None:
        new = filter_codex_logs_by_cwd(new, str(launch_cwd))
    elif normalizer == "kimi" and launch_cwd is not None:
        new = filter_kimi_logs_by_cwd(new, str(launch_cwd))
    elif normalizer == "pi" and launch_cwd is not None:
        new = filter_pi_logs_by_cwd(new, str(launch_cwd))
    return new


def _trajectory_tool_call_count(trajectory_path: Path) -> int:
    """Number of tool_calls across all steps in an emitted ATIF trajectory.

    A trajectory that parses but carries no tool calls counts as zero — the
    same "nothing captured" signal the flat-JSONL row count used to give, which
    keeps the empty-capture retry firing for still-flushing logs.
    """
    try:
        data = json.loads(trajectory_path.read_text())
    except (OSError, json.JSONDecodeError):
        return 0
    return _steps_tool_call_count(data.get("steps", []) if isinstance(data, dict) else [])


def _steps_tool_call_count(steps: list[dict]) -> int:
    count = 0
    for step in steps:
        if isinstance(step, dict):
            tool_calls = step.get("tool_calls")
            if isinstance(tool_calls, list):
                count += len(tool_calls)
    return count


def _step_timestamp(step: dict) -> str:
    """ISO-8601 step timestamp, or "" when the step carries none.

    Empty-string sorts last among the merge keys so timestamped steps order
    among themselves and untimestamped steps fall back to file/in-file order.
    """
    ts = step.get("timestamp")
    return ts if isinstance(ts, str) else ""


def _merge_trajectories(per_file: list[dict]) -> dict | None:
    """Merge one ATIF trajectory per source file into a single trajectory.

    A run can produce more than one session log (gemini main + subagent chats;
    any agent's subagent runs). Emitting from only the first log silently drops
    every tool call recorded in the others. This merges the steps of all files
    into one trajectory:

    - Steps are ordered by their ISO-8601 `timestamp` where present, with a
      STABLE fallback (file order = the input `per_file` order, then in-file
      order) for steps that carry no timestamp. Timestamped steps sort among
      themselves by timestamp; steps lacking a timestamp keep their relative
      input position via the (file index, in-file index) tiebreak.
    - `step_id` is renumbered sequentially from 1 across the merged set.
    - Each step's `tool_calls`/`observation` are kept intact; observations
      already reference tool_call_ids in their own step, so renumbering step_ids
      preserves validateTrajectory's same-step observation invariant.

    Returns the merged trajectory dict, or None when no file yielded a parseable
    trajectory with steps. The trajectory envelope (schema_version, agent) is
    taken from the first file that has steps.
    """
    envelope: dict | None = None
    ordered: list[tuple[bool, str, int, int, dict]] = []
    for file_index, data in enumerate(per_file):
        if not isinstance(data, dict):
            continue
        steps = data.get("steps")
        if not isinstance(steps, list) or not steps:
            continue
        if envelope is None:
            envelope = data
        for in_file_index, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            ts = _step_timestamp(step)
            ordered.append((ts == "", ts, file_index, in_file_index, step))

    if envelope is None or not ordered:
        return None

    ordered.sort(key=lambda item: item[:4])
    merged_steps: list[dict] = []
    for step_id, (*_key, step) in enumerate(ordered, start=1):
        merged = dict(step)
        merged["step_id"] = step_id
        merged_steps.append(merged)

    merged_trajectory = dict(envelope)
    merged_trajectory["steps"] = merged_steps
    return merged_trajectory


def capture_tool_calls(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
    version: str = "unknown",
    ts_root: Path | None = None,
) -> CaptureResult:
    """Diff log_dir, filter by cwd if applicable, emit the merged ATIF trajectory.

    Locates the run's new source logs (cwd-filtered for shared-tree agents),
    normalizes EVERY one via the bun TS normalizer, and merges their steps into
    a single run_dir/trajectory.json ordered by step timestamp (see
    _merge_trajectories). Merging matters because a run can produce more than
    one session log (gemini main + subagent; any agent's subagent runs); the
    earlier first-log-only emission silently dropped every tool call in the
    others. row_count is the number of tool_calls in the merged trajectory.
    When there is no source log, all emissions fail, or the merge has no tool
    calls, row_count is 0 and any stale trajectory.json is removed — so
    downstream loaders fail closed and the empty-capture retry (PRI-2081) still
    fires.
    """
    new = _new_session_logs(log_dir, log_glob, snapshot, normalizer, launch_cwd)
    out_path = run_dir / ATIF_TRAJECTORY_FILENAME
    resolved_ts_root = ts_root or _ts_root()

    per_file: list[dict] = []
    for source_log in new:
        data = _emit_and_load(
            source_log=source_log,
            normalizer=normalizer,
            version=version,
            ts_root=resolved_ts_root,
        )
        if data is not None:
            per_file.append(data)

    merged = _merge_trajectories(per_file)
    row_count = _steps_tool_call_count(merged["steps"]) if merged else 0
    if merged is not None and row_count > 0:
        out_path.write_text(json.dumps(merged, indent=2) + "\n")
    else:
        # A zero-row capture must not leave a stale trajectory behind: a later
        # retry pass (or a downstream loader) must see "nothing captured".
        out_path.unlink(missing_ok=True)

    return CaptureResult(path=out_path, source_logs=tuple(new), row_count=row_count)


def _emit_and_load(
    *,
    source_log: Path,
    normalizer: str,
    version: str,
    ts_root: Path,
) -> dict | None:
    """Normalize one source log to ATIF and return the parsed trajectory dict.

    Emits the per-file trajectory to a temp file (never the run's final
    trajectory.json) so the merge owns the canonical artifact. Returns None on
    any emission or parse failure — the same fail-closed signal a missing log
    gives, which keeps the empty-capture retry intact.
    """
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / ATIF_TRAJECTORY_FILENAME
        emitted = emit_atif_trajectory(
            session_log_path=source_log,
            out_path=tmp_path,
            normalizer=normalizer,
            version=version,
            ts_root=ts_root,
        )
        if not emitted:
            return None
        try:
            return json.loads(tmp_path.read_text())
        except (OSError, json.JSONDecodeError):
            return None


def capture_tool_calls_with_retry(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
    version: str = "unknown",
    ts_root: Path | None = None,
    attempts: int = 3,
    delay_s: float = 2.0,
    sleep: Callable[[float], None] = time.sleep,
) -> CaptureResult:
    """capture_tool_calls with an empty-capture retry/guard (PRI-2081).

    A run that produced no new source logs — or logs that yield zero tool
    calls — is usually a real failure, but it is sometimes a transient race:
    the Coding-Agent's session log is still being flushed (or renamed into
    place) when the post-drive diff runs. Those races turned whole runs into
    permanent stage="capture" indeterminates, paying full Gauntlet + subject
    spend for no verdict.

    Re-run the same snapshot diff up to `attempts` times, `delay_s` apart,
    until something captures. Each pass re-emits trajectory.json, so the
    artifact always reflects the final capture. The returned `attempts` field
    records how many passes ran; a genuinely-empty run still comes back empty
    (and the runner's per-backend diagnostic cascade proceeds unchanged), just
    `delay_s * (attempts - 1)` seconds later.
    """
    result = capture_tool_calls(
        log_dir=log_dir,
        log_glob=log_glob,
        snapshot=snapshot,
        normalizer=normalizer,
        run_dir=run_dir,
        launch_cwd=launch_cwd,
        version=version,
        ts_root=ts_root,
    )
    used = 1
    while result.row_count == 0 and used < attempts:
        sleep(delay_s)
        used += 1
        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob=log_glob,
            snapshot=snapshot,
            normalizer=normalizer,
            run_dir=run_dir,
            launch_cwd=launch_cwd,
            version=version,
            ts_root=ts_root,
        )
    return replace(result, attempts=used)


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


def _kimi_home_for_log(path: Path) -> Path | None:
    for parent in path.parents:
        if parent.name == "sessions":
            return parent.parent
    return None


def _read_kimi_session_index(kimi_home: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    try:
        with (kimi_home / "session_index.jsonl").open() as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict):
                    entries.append(
                        {
                            "sessionDir": str(entry.get("sessionDir", "")),
                            "workDir": str(entry.get("workDir", "")),
                        }
                    )
    except OSError:
        return []
    return entries


def _indexed_wrong_cwd_kimi_logs(paths: list[Path], launch_cwd: Path) -> list[Path]:
    target = os.path.realpath(launch_cwd)
    mismatched: list[Path] = []
    index_cache: dict[Path, list[dict[str, str]]] = {}
    for path in paths:
        kimi_home = _kimi_home_for_log(path)
        if kimi_home is None:
            continue
        if kimi_home not in index_cache:
            index_cache[kimi_home] = _read_kimi_session_index(kimi_home)

        path_real = os.path.realpath(path)
        for entry in index_cache[kimi_home]:
            session_dir = entry.get("sessionDir", "")
            work_dir = entry.get("workDir", "")
            if not session_dir or not work_dir:
                continue
            session_real = os.path.realpath(session_dir)
            inside_session = path_real == session_real or path_real.startswith(
                session_real + os.sep
            )
            if inside_session and os.path.realpath(work_dir) != target:
                mismatched.append(path)
                break
    return mismatched


def diagnose_kimi_unmatched_logs(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    launch_cwd: Path,
) -> KimiUnmatchedLogsDiagnostic | None:
    new = new_files_since(log_dir, log_glob, snapshot)
    if not new:
        return None
    matched = filter_kimi_logs_by_cwd(new, str(launch_cwd))
    if matched:
        return None
    mismatched = _indexed_wrong_cwd_kimi_logs(new, launch_cwd)
    if mismatched:
        return KimiUnmatchedLogsDiagnostic(
            paths=tuple(mismatched),
            reason="wrong-cwd",
            stage="qa-agent-misconfigured",
        )
    return KimiUnmatchedLogsDiagnostic(
        paths=tuple(new),
        reason="unmapped",
        stage="capture",
    )


def detect_kimi_cwd_mismatch(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    launch_cwd: Path,
) -> list[Path]:
    diagnostic = diagnose_kimi_unmatched_logs(
        log_dir=log_dir,
        log_glob=log_glob,
        snapshot=snapshot,
        launch_cwd=launch_cwd,
    )
    if diagnostic is None or diagnostic.reason != "wrong-cwd":
        return []
    return list(diagnostic.paths)


def capture_token_usage(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
) -> Path | None:
    """Price the run's new session logs via obol; write coding-agent-token-usage.json.

    Measurement only — the pass/fail verdict is unaffected.
    coding-agent-token-usage.json sits in run_dir alongside verdict.json; a
    cost scenario reads it from an ordinary deterministic assertion (see
    docs/migration-notes.md, the cost / measurement decision). Returns the
    written path, or None when usage can't be captured — a backend obol has
    no dialect for, a log obol can't parse, or no new session logs — in
    which case no file is written (PRI-2130).
    """
    new = _new_session_logs(log_dir, log_glob, snapshot, normalizer, launch_cwd)
    usage = estimate_session_logs(normalizer, new)
    if usage is None:
        return None
    usage["duration_ms"] = session_logs_duration_ms(new)
    out_path = run_dir / "coding-agent-token-usage.json"
    out_path.write_text(json.dumps(usage, indent=2) + "\n")
    return out_path
