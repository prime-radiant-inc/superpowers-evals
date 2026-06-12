from __future__ import annotations

import getpass
import json
import os
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, cast

from quorum import runtime_env
from quorum.locks import (
    LockConflict,
    LockRequest,
    ManagedLock,
    acquire_locks,
    read_active_cooldowns,
    release_locks,
    write_cooldown,
)
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
from quorum.run_all import ChildResult, MatrixEntry, run_batch
from quorum.runner import ANTIGRAVITY_RATE_LIMIT_MARKER, _allocate_run_dir, run_scenario_in_dir
from quorum.runtime_env import TargetProfile, build_managed_env, load_target_profile
from quorum.secret_scan import (
    SecretPattern,
    SecretScanResult,
    build_secret_patterns,
    scan_job_artifacts,
    scan_path_for_secrets,
    taint_job_on_secret_match,
)

TERMINAL_STATES = frozenset({"succeeded", "failed", "interrupted"})
ACTIVE_STATES = frozenset({"planned", "running"})
WORKER_EXECUTORS: dict[str, Callable[[ManagedJob, ManagedPaths, Mapping[str, str]], int]] = {}
SMOKE_SCENARIO_FALLBACK = "00-quorum-smoke-hello-world"
TARGET_SMOKE_SCENARIOS = {
    "antigravity": "antigravity-superpowers-bootstrap",
    "copilot": "copilot-superpowers-bootstrap",
    "gemini": "gemini-superpowers-bootstrap",
    "kimi": "kimi-superpowers-bootstrap",
    "opencode": "opencode-superpowers-bootstrap",
    "pi": "pi-superpowers-bootstrap",
}
PROVIDER_BY_TARGET = {
    "antigravity": "gemini",
    "claude": "anthropic",
    "claude-haiku": "anthropic",
    "claude-sonnet": "anthropic",
    "codex": "openai",
    "copilot": "github-copilot",
    "gemini": "gemini",
    "kimi": "kimi",
    "opencode": "openai",
    "pi": "pi",
}
RATE_LIMIT_SKIP_SENTINEL = "agy-rate-limit-skip"
ABORT_SKIP_SENTINEL = "batch-abort-skip"
TMUX_WORKER_ENV_ALLOWLIST = (
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "QUORUM_MANAGED_HOST",
    "QUORUM_TARGET_PROFILE_ROOT",
    "SUPERPOWERS_ROOT",
)
WORKER_TOKEN_WRAPPER = (
    'if [ -r "$1" ]; then '
    'QUORUM_MANAGED_WORKER_TOKEN="$(cat "$1")"; '
    "export QUORUM_MANAGED_WORKER_TOKEN; "
    "fi; "
    'shift; exec "$@"'
)


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
    env: Mapping[str, str] | None = None

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


class _SecretScanTainted(RuntimeError):
    def __init__(self) -> None:
        super().__init__("secret-like material detected in managed artifacts")


def create_job(
    kind: str,
    target: str | None,
    args: Sequence[str],
    paths: ManagedPaths,
    owner: str | None,
    *,
    coding_agents: Sequence[str] | None = None,
    tier: str | None = None,
    include_drafts: bool | None = None,
    scenario_filter: str | None = None,
    extra: Mapping[str, object] | None = None,
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
        coding_agents=(
            list(coding_agents) if coding_agents is not None else ([target] if target else [])
        ),
        tier=tier,
        include_drafts=include_drafts,
        scenario_filter=scenario_filter,
        out_root=str(paths.artifact_root),
        log_path=str(paths.state_root / "logs" / f"{job_id}.log"),
        extra=dict(extra or {}),
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
    command = _worker_command(
        job.id,
        paths,
        env=_worker_command_env(supervisor),
        read_worker_token=isinstance(supervisor, TmuxSupervisor),
    )
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
    secret_patterns = _secret_patterns_for_job(job, worker_env)
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
    except _SecretScanTainted:
        append_event(
            paths,
            job.id,
            {
                "event": "worker-tainted",
                "job_id": job.id,
                "exit_code": 1,
            },
        )
        current = read_job(paths, job.id)
        if current.state == "running":
            mark_job_state(
                paths,
                job.id,
                "failed",
                final_exit_code=1,
                failure_reason="secret-like material detected in managed artifacts",
            )
        return 1
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
        failed = mark_job_state(
            paths,
            job.id,
            "failed",
            final_exit_code=exit_code,
            failure_reason=failure_reason,
        )
        _taint_job_if_secret_match(paths, failed.id, secret_patterns)
        return exit_code

    if exit_code == 0:
        if _fail_job_if_secret_match(paths, job.id, secret_patterns):
            return 1
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
    _taint_job_if_secret_match(paths, job.id, secret_patterns)
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


def _execute_smoke(job: ManagedJob, paths: ManagedPaths, env: Mapping[str, str]) -> int:
    target = _single_target(job)
    opts = _parse_managed_options(job.command[2:])
    secret_patterns = _secret_patterns_for_job(job, env)
    scenarios_root = Path(_str_option(opts, "scenarios_root", "scenarios"))
    coding_agents_dir = Path(_str_option(opts, "coding_agents_dir", "coding-agents"))
    out_root = Path(_str_option(opts, "out_root", str(paths.artifact_root)))
    scenario_dir = _smoke_scenario_dir(scenarios_root, target)
    run_dir = _allocate_run_dir(
        out_root=out_root,
        scenario_name=scenario_dir.name,
        coding_agent=target,
    )
    child_id = "child-0001"
    locks = _lock_requests_for_targets([target])
    _fail_on_active_cooldowns(paths, job, [target])
    held = _acquire_job_locks(paths, job, locks)
    try:
        _update_job(paths, job.id, locks=[lock.name for lock in held])
        _upsert_child(
            paths,
            job.id,
            {
                "id": child_id,
                "kind": "run",
                "target": target,
                "coding_agent": target,
                "scenario": scenario_dir.name,
                "run_id": run_dir.name,
                "run_dir": str(run_dir),
                "state": "running",
            },
        )
        _run_dir, verdict = run_scenario_in_dir(
            run_dir=run_dir,
            scenario_dir=scenario_dir,
            coding_agent=target,
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            env_base=_managed_env_for_target(target, paths, env),
        )
        _upsert_child(
            paths,
            job.id,
            {
                "id": child_id,
                "run_id": run_dir.name,
                "run_dir": str(run_dir),
                "state": "finished",
                "final": verdict.final,
            },
        )
        _update_job(paths, job.id, result_rollup=_rollup_children(read_job(paths, job.id).children))
        _raise_if_artifact_secret_match(paths, job.id, [run_dir], secret_patterns)
        return 0
    finally:
        release_locks(held)


def _execute_column(job: ManagedJob, paths: ManagedPaths, env: Mapping[str, str]) -> int:
    target = _single_target(job)
    opts = _parse_managed_options(job.command[2:])
    opts.setdefault("jobs", "1")
    opts["coding_agents"] = target
    opts.setdefault("tier", "sentinel")
    return _execute_batch_like(job, paths, env, opts, targets=[target])


def _execute_batch(job: ManagedJob, paths: ManagedPaths, env: Mapping[str, str]) -> int:
    opts = _parse_managed_options(job.command[2:])
    targets = _targets_from_options_or_job(opts, job)
    opts.setdefault("tier", "sentinel")
    return _execute_batch_like(job, paths, env, opts, targets=targets)


def _execute_batch_like(
    job: ManagedJob,
    paths: ManagedPaths,
    env: Mapping[str, str],
    opts: Mapping[str, str | bool],
    *,
    targets: Sequence[str],
) -> int:
    if not targets:
        raise ValueError("managed batch requires at least one target")
    locks = _lock_requests_for_targets(targets, broad_batch=len(targets) != 1)
    _fail_on_active_cooldowns(paths, job, targets)
    held = _acquire_job_locks(paths, job, locks)
    state_lock = threading.Lock()
    abort_event = threading.Event()
    current_batch: dict[str, str] = {}
    batch_out_root = Path(str(opts.get("out_root") or paths.artifact_root)).resolve()
    secret_patterns = _secret_patterns_for_job(job, env)
    try:
        _update_job(paths, job.id, locks=[lock.name for lock in held])

        def on_batch_allocated(batch_dir: Path) -> None:
            current_batch["batch_id"] = batch_dir.name
            current_batch["batch_dir"] = str(batch_dir)
            _upsert_child(
                paths,
                job.id,
                {
                    "id": "batch",
                    "kind": "batch",
                    "batch_id": batch_dir.name,
                    "batch_dir": str(batch_dir),
                    "state": "running",
                },
                lock=state_lock,
            )

        def on_child_started(child_id: str, entry: MatrixEntry, command: list[str]) -> None:
            _upsert_child(
                paths,
                job.id,
                {
                    "id": child_id,
                    "kind": "run",
                    "target": entry.coding_agent,
                    "coding_agent": entry.coding_agent,
                    "scenario": entry.scenario,
                    "command": command,
                    **current_batch,
                    "state": "running",
                },
                lock=state_lock,
            )

        def on_child_finished(child_id: str, result: ChildResult) -> None:
            tainted = _record_child_finished(
                paths,
                job.id,
                child_id,
                result,
                artifact_root=batch_out_root,
                batch=current_batch,
                secret_patterns=secret_patterns,
                lock=state_lock,
            )
            if tainted:
                abort_event.set()

        batch_dir = run_batch(
            scenarios_root=Path(str(opts.get("scenarios_root") or "scenarios")).resolve(),
            coding_agents_dir=Path(str(opts.get("coding_agents_dir") or "coding-agents")).resolve(),
            out_root=batch_out_root,
            jobs=int(str(opts.get("jobs") or "1")),
            agent_filter=list(targets),
            scenario_filter=_csv_option(opts.get("scenarios")),
            tier=str(opts.get("tier") or "sentinel"),
            include_drafts=bool(opts.get("include_drafts")),
            use_cursor=False,
            env_base=_managed_env_for_target(
                _batch_env_target(targets),
                paths,
                env,
                include_worker_token=True,
            ),
            on_batch_allocated=on_batch_allocated,
            on_child_started=on_child_started,
            on_child_finished=on_child_finished,
            abort_event=abort_event,
        )
        _upsert_child(
            paths,
            job.id,
            {
                "id": "batch",
                "kind": "batch",
                "batch_id": batch_dir.name,
                "batch_dir": str(batch_dir),
                "state": "finished",
            },
            lock=state_lock,
        )
        _update_job(paths, job.id, result_rollup=_rollup_children(read_job(paths, job.id).children))
        if _taint_job_if_artifact_secret_match(paths, job.id, [batch_dir], secret_patterns):
            abort_event.set()
        if abort_event.is_set():
            raise _SecretScanTainted()
        return 0
    finally:
        release_locks(held)


def _run_executor(job: ManagedJob, paths: ManagedPaths, env: Mapping[str, str]) -> int:
    kind = job.managed_command or (job.command[1] if len(job.command) > 1 else "")
    executor = WORKER_EXECUTORS.get(kind)
    if executor is None:
        raise NotImplementedError(f"managed job kind {kind!r} is not implemented yet")
    return executor(job, paths, env)


def _secret_patterns_for_job(job: ManagedJob, env: Mapping[str, str]) -> list[SecretPattern]:
    patterns = build_secret_patterns(TargetProfile(target="managed", path=None, env={}))
    profile_root = env.get("QUORUM_TARGET_PROFILE_ROOT")
    if profile_root:
        for target in _targets_for_secret_scan(job):
            try:
                profile = load_target_profile(Path(profile_root), target)
            except runtime_env.TargetProfileError:
                continue
            patterns.extend(build_secret_patterns(profile))
    return _dedupe_secret_patterns(patterns)


def _targets_for_secret_scan(job: ManagedJob) -> list[str]:
    targets = list(job.coding_agents)
    if not targets:
        targets = _targets_from_options_or_job(_parse_managed_options(job.command[2:]), job)
    return sorted(set(targets))


def _dedupe_secret_patterns(patterns: Sequence[SecretPattern]) -> list[SecretPattern]:
    deduped: list[SecretPattern] = []
    seen: set[tuple[str, bytes]] = set()
    for pattern in patterns:
        key = (pattern.name, pattern.regex.pattern)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(pattern)
    return deduped


def _taint_job_if_secret_match(
    paths: ManagedPaths,
    job_id: str,
    patterns: Sequence[SecretPattern],
) -> bool:
    job = read_job(paths, job_id)
    result = scan_job_artifacts(job, patterns, paths)
    taint_job_on_secret_match(paths, job, result)
    return result.found


def _fail_job_if_secret_match(
    paths: ManagedPaths,
    job_id: str,
    patterns: Sequence[SecretPattern],
) -> bool:
    if not _taint_job_if_secret_match(paths, job_id, patterns):
        return False
    append_event(
        paths,
        job_id,
        {
            "event": "worker-tainted",
            "job_id": job_id,
            "exit_code": 1,
        },
    )
    mark_job_state(
        paths,
        job_id,
        "failed",
        final_exit_code=1,
        failure_reason="secret-like material detected in managed artifacts",
    )
    return True


def _taint_job_if_artifact_secret_match(
    paths: ManagedPaths,
    job_id: str,
    artifact_paths: Sequence[Path],
    patterns: Sequence[SecretPattern],
) -> bool:
    matches = []
    for artifact_path in artifact_paths:
        matches.extend(scan_path_for_secrets(artifact_path, patterns).matches)
    if not matches:
        return False
    taint_job_on_secret_match(
        paths,
        read_job(paths, job_id),
        SecretScanResult(matches=matches),
    )
    return True


def _raise_if_artifact_secret_match(
    paths: ManagedPaths,
    job_id: str,
    artifact_paths: Sequence[Path],
    patterns: Sequence[SecretPattern],
) -> None:
    if _taint_job_if_artifact_secret_match(paths, job_id, artifact_paths, patterns):
        raise _SecretScanTainted()


def _parse_managed_options(args: Sequence[str]) -> dict[str, str | bool]:
    opts: dict[str, str | bool] = {}
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--include-drafts":
            opts["include_drafts"] = True
            idx += 1
            continue
        if arg.startswith("--"):
            key = arg[2:].replace("-", "_")
            if idx + 1 >= len(args):
                raise ValueError(f"{arg} requires a value")
            opts[key] = args[idx + 1]
            idx += 2
            continue
        idx += 1
    return opts


def _single_target(job: ManagedJob) -> str:
    if job.coding_agents:
        return job.coding_agents[0]
    if len(job.command) >= 3:
        return job.command[2]
    raise ValueError(f"managed {job.managed_command} job has no target")


def _targets_from_options_or_job(
    opts: Mapping[str, str | bool],
    job: ManagedJob,
) -> list[str]:
    if opts.get("coding_agent"):
        return [str(opts["coding_agent"])]
    if opts.get("coding_agents"):
        return _csv_option(opts["coding_agents"]) or []
    return list(job.coding_agents)


def _csv_option(value: object) -> list[str] | None:
    if not isinstance(value, str) or not value:
        return None
    items = [item.strip() for item in value.split(",") if item.strip()]
    return items or None


def _str_option(opts: Mapping[str, str | bool], key: str, default: str) -> str:
    value = opts.get(key)
    return value if isinstance(value, str) else default


def _smoke_scenario_dir(scenarios_root: Path, target: str) -> Path:
    preferred = TARGET_SMOKE_SCENARIOS.get(target)
    if preferred is not None and (scenarios_root / preferred / "story.md").exists():
        return scenarios_root / preferred
    fallback = scenarios_root / SMOKE_SCENARIO_FALLBACK
    if not (fallback / "story.md").exists():
        raise FileNotFoundError(f"smoke scenario not found: {fallback}")
    return fallback


def _managed_env_for_target(
    target: str | None,
    paths: ManagedPaths,
    env: Mapping[str, str],
    *,
    include_worker_token: bool = False,
) -> dict[str, str]:
    profile_root = env.get("QUORUM_TARGET_PROFILE_ROOT")
    if target is not None and profile_root:
        profile = load_target_profile(Path(profile_root), target)
    else:
        profile = TargetProfile(target=target or "batch", path=None, env={})
    managed_env = build_managed_env(env, paths, profile, runtime_vars={})
    if include_worker_token and env.get("QUORUM_MANAGED_WORKER_TOKEN"):
        managed_env["QUORUM_MANAGED_WORKER_TOKEN"] = env["QUORUM_MANAGED_WORKER_TOKEN"]
    return managed_env


def _batch_env_target(targets: Sequence[str]) -> str | None:
    return targets[0] if len(targets) == 1 else None


def _lock_requests_for_targets(
    targets: Sequence[str],
    *,
    broad_batch: bool = False,
) -> list[LockRequest]:
    requests: list[LockRequest] = [LockRequest("global:active")]
    if broad_batch:
        requests.append(LockRequest("global:broad-batch"))
    for target in sorted(set(targets)):
        requests.append(LockRequest(f"provider:{_provider_for_target(target)}"))
        requests.append(LockRequest(f"target:{target}"))
    return requests


def _acquire_job_locks(
    paths: ManagedPaths,
    job: ManagedJob,
    requests: Sequence[LockRequest],
) -> list[ManagedLock]:
    try:
        return acquire_locks(paths, requests, job.id, job.command)
    except LockConflict as exc:
        append_event(
            paths,
            job.id,
            {
                "event": "lock-conflict",
                "job_id": job.id,
                "lock_name": exc.lock_name,
                "conflict": exc.to_json(),
            },
        )
        raise


def _provider_for_target(target: str) -> str:
    return PROVIDER_BY_TARGET.get(target, target)


def _fail_on_active_cooldowns(
    paths: ManagedPaths,
    job: ManagedJob,
    targets: Sequence[str],
) -> None:
    providers = {_provider_for_target(target) for target in targets}
    active = [
        cooldown
        for cooldown in read_active_cooldowns(paths, datetime.now(UTC))
        if cooldown.provider in providers
    ]
    if not active:
        return
    cooldown = active[0]
    append_event(
        paths,
        job.id,
        {
            "event": "cooldown-active",
            "job_id": job.id,
            "provider": cooldown.provider,
            "reason": cooldown.reason,
            "until": cooldown.until,
        },
    )
    raise RuntimeError(
        f"active provider cooldown for {cooldown.provider} until "
        f"{cooldown.until.isoformat()}: {cooldown.reason}"
    )


def _record_child_finished(
    paths: ManagedPaths,
    job_id: str,
    child_id: str,
    result: ChildResult,
    *,
    artifact_root: Path,
    batch: Mapping[str, str],
    secret_patterns: Sequence[SecretPattern],
    lock: threading.Lock,
) -> bool:
    skipped_reason = _skipped_reason(result)
    if skipped_reason is not None:
        _upsert_child(
            paths,
            job_id,
            {
                "id": child_id,
                "kind": "run",
                **batch,
                "state": "skipped",
                "skipped": skipped_reason,
                "error": result.error,
            },
            lock=lock,
        )
        return False

    final = _final_for_child_result(result, artifact_root)
    child: dict[str, object] = {
        "id": child_id,
        "kind": "run",
        **batch,
        "state": "finished",
    }
    if result.run_id is not None:
        child["run_id"] = result.run_id
        child["run_dir"] = str(artifact_root / result.run_id)
    if result.error is not None:
        child["error"] = result.error
    if final is not None:
        child["final"] = final
    _upsert_child(paths, job_id, child, lock=lock)
    if result.run_id is not None and _is_antigravity_rate_limit(artifact_root / result.run_id):
        until = datetime.now(UTC) + timedelta(minutes=30)
        write_cooldown(
            paths,
            "gemini",
            "Code Assist rate limit",
            until,
        )
        _append_job_cooldown(
            paths,
            job_id,
            {
                "provider": "gemini",
                "reason": "Code Assist rate limit",
                "source_child_id": child_id,
                "source_job_id": job_id,
                "source_run_id": result.run_id,
                "until": until.isoformat().replace("+00:00", "Z"),
            },
            lock=lock,
        )
    if result.run_id is not None:
        return _taint_job_if_artifact_secret_match(
            paths,
            job_id,
            [artifact_root / result.run_id],
            secret_patterns,
        )
    return False


def _skipped_reason(result: ChildResult) -> str | None:
    if result.error == RATE_LIMIT_SKIP_SENTINEL:
        return "rate-limited"
    if result.error == ABORT_SKIP_SENTINEL:
        return "aborted"
    prefix = "skipped:"
    if isinstance(result.error, str) and result.error.startswith(prefix):
        return result.error[len(prefix) :] or "skipped"
    return None


def _final_for_child_result(result: ChildResult, artifact_root: Path) -> str | None:
    if result.error is not None:
        return None
    if result.run_id is None:
        return "unknown"
    verdict = _read_run_verdict(artifact_root / result.run_id)
    if verdict is None:
        return "unknown"
    final = verdict.get("final")
    if isinstance(final, str) and final in {"pass", "fail", "indeterminate"}:
        return final
    return "unknown"


def _is_antigravity_rate_limit(run_dir: Path) -> bool:
    verdict = _read_run_verdict(run_dir)
    if not verdict:
        return False
    error_obj = verdict.get("error")
    if not isinstance(error_obj, dict):
        return False
    error = cast(dict[str, object], error_obj)
    message = error.get("message")
    return isinstance(message, str) and ANTIGRAVITY_RATE_LIMIT_MARKER in message


def _read_run_verdict(run_dir: Path) -> dict[str, object] | None:
    try:
        payload = json.loads((run_dir / "verdict.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return cast(dict[str, object], payload) if isinstance(payload, dict) else None


def _append_job_cooldown(
    paths: ManagedPaths,
    job_id: str,
    cooldown: Mapping[str, object],
    *,
    lock: threading.Lock,
) -> ManagedJob:
    with lock:
        job = read_job(paths, job_id)
        extra = dict(job.extra)
        existing = extra.get("cooldowns")
        cooldowns = list(existing) if isinstance(existing, list) else []
        cooldowns.append(dict(cooldown))
        extra["cooldowns"] = cooldowns
        return _update_job(paths, job_id, extra=extra)


def _rollup_children(children: Sequence[Mapping[str, object]]) -> Mapping[str, object]:
    finals = [
        str(child.get("final"))
        for child in children
        if child.get("kind") != "batch" and child.get("state") != "skipped"
    ]
    passed = finals.count("pass")
    failed = finals.count("fail")
    indeterminate = finals.count("indeterminate")
    unknown = len([final for final in finals if final not in {"pass", "fail", "indeterminate"}])
    if failed:
        final = "fail"
    elif indeterminate or unknown or not finals:
        final = "indeterminate"
    else:
        final = "pass"
    rollup: dict[str, object] = {
        "final": final,
        "total": len(finals),
        "passed": passed,
        "failed": failed,
    }
    if indeterminate:
        rollup["indeterminate"] = indeterminate
    if unknown:
        rollup["unknown"] = unknown
    skipped = len(
        [
            child
            for child in children
            if child.get("kind") != "batch" and child.get("state") == "skipped"
        ]
    )
    if skipped:
        rollup["skipped"] = skipped
    return rollup


def _upsert_child(
    paths: ManagedPaths,
    job_id: str,
    child: Mapping[str, object],
    *,
    lock: threading.Lock | None = None,
) -> ManagedJob:
    if lock is None:
        return _upsert_child_unlocked(paths, job_id, child)
    with lock:
        return _upsert_child_unlocked(paths, job_id, child)


def _upsert_child_unlocked(
    paths: ManagedPaths,
    job_id: str,
    child: Mapping[str, object],
) -> ManagedJob:
    job = read_job(paths, job_id)
    child_id = child.get("id")
    children = [dict(existing) for existing in job.children]
    for idx, existing in enumerate(children):
        if existing.get("id") == child_id:
            existing.update(dict(child))
            children[idx] = existing
            break
    else:
        children.append(dict(child))
    return _update_job(paths, job_id, children=children)


def _update_job(paths: ManagedPaths, job_id: str, **updates: Any) -> ManagedJob:
    job = read_job(paths, job_id)
    updated = replace(job, updated_at=datetime.now(UTC), **updates)
    write_job_atomic(paths, updated)
    return updated


def _worker_command(
    job_id: str,
    paths: ManagedPaths,
    *,
    env: Mapping[str, str] | None = None,
    read_worker_token: bool = False,
) -> list[str]:
    command = [
        "env",
        *_worker_env_assignments(paths, env),
        "uv",
        "run",
        "quorum",
        "managed-worker",
        job_id,
    ]
    if not read_worker_token:
        return command
    return [
        "sh",
        "-c",
        WORKER_TOKEN_WRAPPER,
        "quorum-managed-worker-token",
        str(runtime_env.MANAGED_WORKER_TOKEN_PATH),
        *command,
    ]


def _worker_command_env(supervisor: Supervisor) -> Mapping[str, str] | None:
    if isinstance(supervisor, TmuxSupervisor):
        return supervisor.env if supervisor.env is not None else os.environ
    return None


def _worker_env_assignments(paths: ManagedPaths, env: Mapping[str, str] | None) -> list[str]:
    assignments = [
        "QUORUM_MANAGED_WORKER=1",
        f"QUORUM_STATE_ROOT={paths.state_root}",
        f"QUORUM_ARTIFACT_ROOT={paths.artifact_root}",
    ]
    if env is None:
        return assignments
    for name in TMUX_WORKER_ENV_ALLOWLIST:
        value = env.get(name)
        if value:
            assignments.append(f"{name}={value}")
    return assignments


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


WORKER_EXECUTORS.update(
    {
        "smoke": _execute_smoke,
        "column": _execute_column,
        "batch": _execute_batch,
    }
)
