"""Snapshot, diff, and normalize agent-under-test session-log directories."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from quorum.normalizers import (
    NORMALIZERS,
    filter_codex_logs_by_cwd,
    filter_kimi_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    find_misplaced_pi_sessions,
    find_unusable_pi_sessions,
    normalize_gemini_logs_with_order,
)
from quorum.obol_capture import estimate_session_logs
from quorum.timing import session_logs_duration_ms


@dataclass(frozen=True)
class CaptureResult:
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
        if normalizer == "gemini":
            ordered_rows: list[tuple[bool, str, int, int, dict[str, object]]] = []
            for source_index, path in enumerate(new):
                for row_index, (timestamp, row) in enumerate(
                    normalize_gemini_logs_with_order(path.read_text())
                ):
                    ordered_rows.append(
                        (not bool(timestamp), timestamp, source_index, row_index, row)
                    )
            ordered_rows.sort(key=lambda item: item[:4])
            for *_order, row in ordered_rows:
                f.write(json.dumps(row) + "\n")
                row_count += 1
        else:
            for path in new:
                for row in fn(path.read_text()):
                    f.write(json.dumps(row) + "\n")
                    row_count += 1
    return CaptureResult(path=out_path, source_logs=tuple(new), row_count=row_count)


def capture_tool_calls_with_retry(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
    attempts: int = 3,
    delay_s: float = 2.0,
    sleep: Callable[[float], None] = time.sleep,
) -> CaptureResult:
    """capture_tool_calls with an empty-capture retry/guard (PRI-2081).

    A run that produced no new source logs — or logs that normalize to zero
    rows — is usually a real failure, but it is sometimes a transient race:
    the Coding-Agent's session log is still being flushed (or renamed into
    place) when the post-drive diff runs. Those races turned whole runs into
    permanent stage="capture" indeterminates, paying full Gauntlet + subject
    spend for no verdict.

    Re-run the same snapshot diff up to `attempts` times, `delay_s` apart,
    until something normalizes. Each pass rewrites
    coding-agent-tool-calls.jsonl, so the artifact always reflects the final
    capture. The returned `attempts` field records how many passes ran;
    a genuinely-empty run still comes back empty (and the runner's
    per-backend diagnostic cascade proceeds unchanged), just `delay_s *
    (attempts - 1)` seconds later.
    """
    result = capture_tool_calls(
        log_dir=log_dir,
        log_glob=log_glob,
        snapshot=snapshot,
        normalizer=normalizer,
        run_dir=run_dir,
        launch_cwd=launch_cwd,
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
