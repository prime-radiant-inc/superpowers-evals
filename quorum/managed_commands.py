from __future__ import annotations

import getpass
import os
import socket
import subprocess
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from quorum.managed_state import (
    ManagedJob,
    ManagedPaths,
    append_event,
    discover_managed_paths,
    list_jobs,
    mark_job_state,
    new_job_id,
    read_job,
    write_job_atomic,
)

TERMINAL_STATES = frozenset({"succeeded", "failed", "interrupted"})
ACTIVE_STATES = frozenset({"planned", "running"})
WORKER_EXECUTORS: dict[str, Callable[[ManagedJob, ManagedPaths, Mapping[str, str]], int]] = {}


@dataclass(frozen=True)
class StartResult:
    job_id: str
    command: list[str]
    supervisor: Mapping[str, object]
    exit_code: int | None = None


class Supervisor(Protocol):
    def start(
        self,
        job: ManagedJob,
        paths: ManagedPaths,
        command: Sequence[str],
    ) -> StartResult: ...


@dataclass(frozen=True)
class InlineSupervisor:
    env: Mapping[str, str] | None = None

    def start(
        self,
        job: ManagedJob,
        paths: ManagedPaths,
        command: Sequence[str],
    ) -> StartResult:
        worker_env = dict(self.env or os.environ)
        worker_env["QUORUM_MANAGED_WORKER"] = "1"
        exit_code = run_managed_worker(job.id, paths, worker_env)
        return StartResult(
            job_id=job.id,
            command=list(command),
            supervisor={"kind": "inline"},
            exit_code=exit_code,
        )


@dataclass(frozen=True)
class TmuxSupervisor:
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run

    def start(
        self,
        job: ManagedJob,
        paths: ManagedPaths,
        command: Sequence[str],
    ) -> StartResult:
        session = _tmux_session_name(job.id)
        log_path = _job_log_path(job, paths)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.touch(exist_ok=True)
        tmux_command = [
            "tmux",
            "new-session",
            "-d",
            "-s",
            session,
            "--",
            *_log_wrapped_command(command, log_path),
        ]
        self.runner(tmux_command, check=True, text=True)
        return StartResult(
            job_id=job.id,
            command=list(command),
            supervisor={"kind": "tmux", "session": session},
            exit_code=None,
        )


def create_job(
    kind: str,
    target: str | None,
    args: Sequence[str],
    paths: ManagedPaths,
    owner: str | None,
) -> ManagedJob:
    now = datetime.now(UTC)
    job_id = new_job_id(now, kind, target)
    command = ["quorum", kind]
    if target is not None:
        command.append(target)
    command.extend(args)
    job = ManagedJob(
        id=job_id,
        state="planned",
        created_at=now,
        updated_at=now,
        owner=owner or getpass.getuser(),
        host=socket.gethostname(),
        command=command,
        managed_command=kind,
        coding_agents=[target] if target else [],
        out_root=str(paths.artifact_root),
        log_path=str(paths.state_root / "logs" / f"{job_id}.log"),
    )
    write_job_atomic(paths, job)
    append_event(
        paths,
        job.id,
        {
            "event": "job-created",
            "job_id": job.id,
            "state": job.state,
            "created_at": now,
            "command": command,
        },
    )
    return job


def start_job(job: ManagedJob, paths: ManagedPaths, supervisor: Supervisor) -> StartResult:
    command = _worker_command(job.id, paths)
    supervisor_info = _supervisor_info(supervisor, job.id)
    write_job_atomic(
        paths,
        replace(
            job,
            supervisor=supervisor_info,
            updated_at=datetime.now(UTC),
        ),
    )
    append_event(
        paths,
        job.id,
        {
            "event": "job-started",
            "job_id": job.id,
            "supervisor": supervisor_info,
            "worker_command": command,
        },
    )
    try:
        result = supervisor.start(read_job(paths, job.id), paths, command)
    except subprocess.CalledProcessError as exc:
        failure_reason = _failure_reason(exc)
        append_event(
            paths,
            job.id,
            {
                "event": "job-start-failed",
                "job_id": job.id,
                "exit_code": exc.returncode,
                "failure_reason": failure_reason,
            },
        )
        mark_job_state(
            paths,
            job.id,
            "failed",
            final_exit_code=exc.returncode,
            failure_reason=failure_reason,
        )
        return StartResult(
            job_id=job.id,
            command=command,
            supervisor=supervisor_info,
            exit_code=exc.returncode,
        )
    except Exception as exc:
        exit_code = _exit_code(exc)
        failure_reason = _failure_reason(exc)
        append_event(
            paths,
            job.id,
            {
                "event": "job-start-failed",
                "job_id": job.id,
                "exit_code": exit_code,
                "failure_reason": failure_reason,
            },
        )
        mark_job_state(
            paths,
            job.id,
            "failed",
            final_exit_code=exit_code,
            failure_reason=failure_reason,
        )
        return StartResult(
            job_id=job.id,
            command=command,
            supervisor=supervisor_info,
            exit_code=exit_code,
        )
    return result


def run_managed_worker(job_id: str, paths: ManagedPaths, env: Mapping[str, str]) -> int:
    worker_env = dict(env)
    worker_env["QUORUM_MANAGED_WORKER"] = "1"
    job = mark_job_state(paths, job_id, "running")
    append_event(
        paths,
        job.id,
        {
            "event": "worker-started",
            "job_id": job.id,
            "state": "running",
            "started_at": job.started_at or job.updated_at,
        },
    )
    try:
        exit_code = _run_executor(job, paths, worker_env)
    except KeyboardInterrupt:
        append_event(
            paths,
            job.id,
            {
                "event": "worker-interrupted",
                "job_id": job.id,
                "exit_code": 130,
            },
        )
        mark_job_state(
            paths,
            job.id,
            "interrupted",
            final_exit_code=130,
            failure_reason="worker interrupted",
        )
        return 130
    except BaseException as exc:
        exit_code = _exit_code(exc)
        failure_reason = _failure_reason(exc)
        append_event(
            paths,
            job.id,
            {
                "event": "worker-failed",
                "job_id": job.id,
                "exit_code": exit_code,
                "failure_reason": failure_reason,
            },
        )
        mark_job_state(
            paths,
            job.id,
            "failed",
            final_exit_code=exit_code,
            failure_reason=failure_reason,
        )
        return exit_code

    if exit_code == 0:
        append_event(
            paths,
            job.id,
            {
                "event": "worker-succeeded",
                "job_id": job.id,
                "exit_code": 0,
            },
        )
        mark_job_state(paths, job.id, "succeeded", final_exit_code=0)
        return 0

    failure_reason = f"managed worker exited {exit_code}"
    append_event(
        paths,
        job.id,
        {
            "event": "worker-failed",
            "job_id": job.id,
            "exit_code": exit_code,
            "failure_reason": failure_reason,
        },
    )
    mark_job_state(
        paths,
        job.id,
        "failed",
        final_exit_code=exit_code,
        failure_reason=failure_reason,
    )
    return exit_code


def status_summary(paths: ManagedPaths, limit: int, include_finished: bool) -> list[ManagedJob]:
    jobs = list_jobs(paths).jobs
    active = sorted(
        [job for job in jobs if job.state in ACTIVE_STATES],
        key=lambda job: (job.updated_at, job.id),
        reverse=True,
    )
    if not include_finished:
        return active[:limit]
    terminal = sorted(
        [job for job in jobs if job.state in TERMINAL_STATES],
        key=lambda job: (job.finished_at or job.updated_at, job.id),
        reverse=True,
    )
    return [*active, *terminal][:limit]


def tail_job(
    job_id: str,
    child_id: str | None = None,
    follow: bool = False,
    *,
    paths: ManagedPaths | None = None,
) -> Iterator[str]:
    managed_paths = paths or discover_managed_paths(os.environ)
    if child_id is None:
        sources = _parent_tail_sources(managed_paths, job_id)
    else:
        sources = _child_tail_sources(managed_paths, job_id, child_id)
    yield from _tail_sources(sources, managed_paths, job_id, follow)


def _run_executor(job: ManagedJob, paths: ManagedPaths, env: Mapping[str, str]) -> int:
    kind = job.managed_command or (job.command[1] if len(job.command) > 1 else "")
    executor = WORKER_EXECUTORS.get(kind)
    if executor is None:
        raise NotImplementedError(f"managed job kind {kind!r} is not implemented yet")
    return executor(job, paths, env)


def _worker_command(job_id: str, paths: ManagedPaths) -> list[str]:
    return [
        "env",
        "QUORUM_MANAGED_WORKER=1",
        f"QUORUM_STATE_ROOT={paths.state_root}",
        f"QUORUM_ARTIFACT_ROOT={paths.artifact_root}",
        "uv",
        "run",
        "quorum",
        "managed-worker",
        job_id,
    ]


def _job_log_path(job: ManagedJob, paths: ManagedPaths) -> Path:
    if job.log_path:
        return Path(job.log_path)
    return paths.state_root / "logs" / f"{job.id}.log"


def _log_wrapped_command(command: Sequence[str], log_path: Path) -> list[str]:
    return [
        "sh",
        "-c",
        'exec >> "$1" 2>&1; shift; exec "$@"',
        "quorum-managed-worker",
        str(log_path),
        *command,
    ]


def _tmux_session_name(job_id: str) -> str:
    return f"quorum-{job_id}"


def _supervisor_info(supervisor: Supervisor, job_id: str) -> Mapping[str, object]:
    if isinstance(supervisor, InlineSupervisor):
        return {"kind": "inline"}
    if isinstance(supervisor, TmuxSupervisor):
        return {"kind": "tmux", "session": _tmux_session_name(job_id)}
    return {"kind": supervisor.__class__.__name__}


def _exit_code(exc: BaseException) -> int:
    value = getattr(exc, "returncode", None)
    if isinstance(value, int):
        return value
    value = getattr(exc, "exit_code", None)
    if isinstance(value, int):
        return value
    return 2 if isinstance(exc, NotImplementedError) else 1


def _failure_reason(exc: BaseException) -> str:
    if isinstance(exc, subprocess.CalledProcessError):
        stderr = (
            exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else exc.stderr
        )
        stdout = (
            exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else exc.stdout
        )
        detail = (stderr or stdout or str(exc)).strip()
        return detail or f"command exited {exc.returncode}"
    return str(exc)


def _parent_tail_sources(paths: ManagedPaths, job_id: str) -> list[Path]:
    job = read_job(paths, job_id)
    sources = [paths.events_dir / f"{job_id}.jsonl"]
    if job.log_path:
        sources.append(Path(job.log_path))
    return sources


def _child_tail_sources(paths: ManagedPaths, job_id: str, child_id: str) -> list[Path]:
    job = read_job(paths, job_id)
    child = _find_child(job, child_id)
    sources: list[Path] = []
    log_path = _path_value(child.get("log_path"))
    if log_path is not None:
        sources.append(log_path)
    batch_dir = _path_value(child.get("batch_dir"))
    if batch_dir is not None:
        sources.extend([batch_dir / "batch.log", batch_dir / "results.jsonl"])
    batch_id = _str_value(child.get("batch_id"))
    if batch_id is not None:
        sources.extend(
            [
                paths.artifact_root / "batches" / batch_id / "batch.log",
                paths.artifact_root / "batches" / batch_id / "results.jsonl",
            ]
        )
    run_dir = _path_value(child.get("run_dir"))
    run_id = _str_value(child.get("run_id"))
    if run_dir is None and run_id is not None:
        run_dir = paths.artifact_root / run_id
    if run_dir is not None:
        sources.extend(
            [
                run_dir / "gauntlet-agent" / "transcript.txt",
                run_dir / "coding-agent-config" / "agy.log",
                run_dir / "coding-agent-tool-calls.jsonl",
                run_dir / "verdict.json",
            ]
        )
    return sources


def _find_child(job: ManagedJob, child_id: str) -> Mapping[str, object]:
    for child in job.children:
        if child.get("id") == child_id or child.get("child_id") == child_id:
            return child
    raise ValueError(f"no child {child_id!r} for managed job {job.id}")


def _path_value(value: object) -> Path | None:
    if isinstance(value, str) and value:
        return Path(value)
    return None


def _str_value(value: object) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def _tail_sources(
    sources: Sequence[Path],
    paths: ManagedPaths,
    job_id: str,
    follow: bool,
) -> Iterator[str]:
    offsets = {path: 0 for path in sources}
    yield from _read_available_lines(sources, offsets)
    if not follow:
        return

    while True:
        yield from _read_available_lines(sources, offsets)
        try:
            if read_job(paths, job_id).state in TERMINAL_STATES:
                yield from _read_available_lines(sources, offsets)
                return
        except (FileNotFoundError, ValueError):
            return
        time.sleep(0.25)


def _read_available_lines(sources: Sequence[Path], offsets: dict[Path, int]) -> Iterator[str]:
    for path in sources:
        try:
            with path.open() as f:
                f.seek(offsets[path])
                lines = f.readlines()
                offsets[path] = f.tell()
        except FileNotFoundError:
            continue
        yield from lines
