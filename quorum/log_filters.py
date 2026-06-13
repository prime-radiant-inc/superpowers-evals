"""Attribute shared-tree session logs to the run that produced them.

Codex, Pi, and Kimi write every session into one shared tree (~/.codex/sessions,
etc.), so a post-drive snapshot diff sees logs from concurrent runs too. These
helpers narrow a new-file diff to the logs whose recorded session cwd matches
the run's launch cwd, and flag logs that landed in the wrong cwd (a QA-agent
misconfiguration) versus logs that simply can't be attributed.

These are log-location concerns, not tool-call normalization — normalization is
handled by the TS ATIF normalizers via quorum/atif.py.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def filter_codex_logs_by_cwd(paths: list[Path], target_cwd: str) -> list[Path]:
    """Drop codex rollouts whose session_meta.cwd doesn't match target_cwd.

    Codex stores all sessions under a shared ~/.codex/sessions/ tree, so when
    multiple drill scenarios run in parallel each one's snapshot diff sees every
    other run's rollouts. Each rollout's first line is a `session_meta` event
    that records the cwd the codex CLI was launched in — use it to attribute
    rollouts to the run that produced them.

    Paths are compared after realpath resolution: macOS hands out workdirs
    under /var/folders/... but codex records the resolved /private/var/...
    realpath, so raw string equality would drop every rollout.
    """
    target = os.path.realpath(target_cwd)
    matched: list[Path] = []
    for path in paths:
        try:
            with path.open() as f:
                first_line = f.readline()
            entry = json.loads(first_line)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") != "session_meta":
            continue
        cwd = entry.get("payload", {}).get("cwd", "")
        if cwd and os.path.realpath(cwd) == target:
            matched.append(path)
    return matched


def find_misplaced_codex_rollouts(
    paths: list[Path], *, run_dir: Path, launch_cwd: Path
) -> list[Path]:
    """Rollouts whose cwd is inside run_dir but isn't the expected launch_cwd.

    Smoking gun for "QA agent skipped `cd $QUORUM_AGENT_CWD` before launching
    codex" — the rollout is clearly attributable to this run (it's inside the
    run dir) but codex booted in the wrong subdirectory, so filter_codex_logs_by_cwd
    correctly excludes it from the normalized output. The runner uses this to
    distinguish that QA-agent misconfiguration from a genuine never-launched
    failure.
    """
    run_dir_real = os.path.realpath(run_dir)
    launch_cwd_real = os.path.realpath(launch_cwd)
    misplaced: list[Path] = []
    for path in paths:
        try:
            with path.open() as f:
                first_line = f.readline()
            entry = json.loads(first_line)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") != "session_meta":
            continue
        cwd = entry.get("payload", {}).get("cwd", "")
        if not cwd:
            continue
        cwd_real = os.path.realpath(cwd)
        inside_run_dir = cwd_real == run_dir_real or cwd_real.startswith(run_dir_real + os.sep)
        if inside_run_dir and cwd_real != launch_cwd_real:
            misplaced.append(path)
    return misplaced


def filter_pi_logs_by_cwd(paths: list[Path], target_cwd: str) -> list[Path]:
    """Drop Pi sessions whose header cwd doesn't match target_cwd.

    Paths are realpath-resolved before comparison — see
    filter_codex_logs_by_cwd for why raw string equality fails on macOS.
    """
    target = os.path.realpath(target_cwd)
    matched: list[Path] = []
    for path in paths:
        try:
            with path.open() as f:
                first_line = f.readline()
            entry = json.loads(first_line)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") != "session":
            continue
        cwd = entry.get("cwd", "")
        if cwd and os.path.realpath(cwd) == target:
            matched.append(path)
    return matched


def _pi_session_header_cwd(path: Path) -> str | None:
    try:
        with path.open() as f:
            first_line = f.readline()
        entry = json.loads(first_line)
    except (OSError, json.JSONDecodeError):
        return None
    if entry.get("type") != "session":
        return None
    cwd = entry.get("cwd", "")
    return cwd if isinstance(cwd, str) and cwd else None


def find_misplaced_pi_sessions(paths: list[Path], *, launch_cwd: Path) -> list[Path]:
    """New run-local Pi sessions that launched in the wrong cwd."""
    launch_cwd_real = os.path.realpath(launch_cwd)
    misplaced: list[Path] = []
    for path in paths:
        cwd = _pi_session_header_cwd(path)
        if cwd is None:
            continue
        cwd_real = os.path.realpath(cwd)
        if cwd_real != launch_cwd_real:
            misplaced.append(path)
    return misplaced


def find_unusable_pi_sessions(paths: list[Path]) -> list[Path]:
    """New Pi session files whose first row cannot identify a session cwd."""
    return [path for path in paths if _pi_session_header_cwd(path) is None]


def _kimi_home_for_log(path: Path) -> Path | None:
    for parent in path.parents:
        if parent.name == "sessions":
            return parent.parent
    return None


def filter_kimi_logs_by_cwd(paths: list[Path], target_cwd: str) -> list[Path]:
    """Drop Kimi wire logs whose session_index workDir doesn't match target_cwd."""
    target = os.path.realpath(target_cwd)
    matched: list[Path] = []
    index_cache: dict[Path, list[dict[str, str]]] = {}

    for path in paths:
        kimi_home = _kimi_home_for_log(path)
        if kimi_home is None:
            continue
        if kimi_home not in index_cache:
            entries: list[dict[str, str]] = []
            index_path = kimi_home / "session_index.jsonl"
            try:
                with index_path.open() as f:
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
                entries = []
            index_cache[kimi_home] = entries

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
            if inside_session and os.path.realpath(work_dir) == target:
                matched.append(path)
                break
    return matched
