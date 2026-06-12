from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

_SCHEMA_VERSION = 1
_WORKER_WRITTEN_STATES = {"planned", "running", "succeeded", "failed", "interrupted"}
_JOB_ID_RE = re.compile(r"^job-\d{8}T\d{6}Z-[0-9a-f]{4}$")


@dataclass(frozen=True)
class ManagedPaths:
    state_root: Path
    artifact_root: Path
    jobs_dir: Path
    events_dir: Path
    locks_dir: Path
    cooldowns_dir: Path
    taints_dir: Path


@dataclass(frozen=True)
class ManagedDiagnostics:
    warnings: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True)
class JobListResult:
    jobs: list[ManagedJob]
    diagnostics: ManagedDiagnostics


@dataclass(frozen=True)
class ManagedJob:
    id: str
    state: str
    created_at: datetime
    updated_at: datetime
    command: list[str]
    schema_version: int = _SCHEMA_VERSION
    managed_command: str | None = None
    coding_agents: list[str] = field(default_factory=list)
    result_rollup: Mapping[str, object] | None = None
    owner: str | None = None
    host: str | None = None
    profile: str | None = None
    scenario_filter: str | None = None
    tier: str | None = None
    include_drafts: bool | None = None
    out_root: str | None = None
    log_path: str | None = None
    locks: list[str] = field(default_factory=list)
    env_profiles: list[str] = field(default_factory=list)
    evals_repo: Mapping[str, object] | None = None
    superpowers_repo: Mapping[str, object] | None = None
    supervisor: Mapping[str, object] | None = None
    children: list[Mapping[str, object]] = field(default_factory=list)
    artifact_bytes: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    final_exit_code: int | None = None
    failure_reason: str | None = None
    tainted: bool = False
    taint_reason: str | None = None
    taint_matches: list[Mapping[str, object]] = field(default_factory=list)
    extra: Mapping[str, object] = field(default_factory=dict)


def discover_managed_paths(env: Mapping[str, str]) -> ManagedPaths:
    artifact_root = Path(env.get("QUORUM_ARTIFACT_ROOT") or env.get("QUORUM_OUT_ROOT") or "results")
    state_root = Path(env.get("QUORUM_STATE_ROOT") or artifact_root / ".quorum")
    return ManagedPaths(
        state_root=state_root,
        artifact_root=artifact_root,
        jobs_dir=state_root / "jobs",
        events_dir=state_root / "events",
        locks_dir=state_root / "locks",
        cooldowns_dir=state_root / "cooldowns",
        taints_dir=state_root / "taints",
    )


def new_job_id(now: datetime, kind: str, target: str | None) -> str:
    del kind, target
    timestamp = _to_utc(now).strftime("%Y%m%dT%H%M%SZ")
    return f"job-{timestamp}-{secrets.token_hex(2)}"


def write_job_atomic(paths: ManagedPaths, job: ManagedJob) -> None:
    _validate_job_id(job.id)
    _validate_worker_state(job.state)
    paths.jobs_dir.mkdir(parents=True, exist_ok=True)
    destination = _job_path(paths, job.id)
    payload = json.dumps(_job_to_json(job), indent=2, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=paths.jobs_dir,
        text=True,
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as tmp:
            tmp.write(payload)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(str(tmp_path), str(destination))
        _fsync_directory(paths.jobs_dir)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def read_job(paths: ManagedPaths, job_id: str) -> ManagedJob:
    return _job_from_json(json.loads(_job_path(paths, job_id).read_text()))


def list_jobs(paths: ManagedPaths) -> JobListResult:
    warnings: list[dict[str, object]] = []
    jobs: list[ManagedJob] = []
    if not paths.jobs_dir.exists():
        return JobListResult(jobs=[], diagnostics=ManagedDiagnostics())

    for path in sorted(paths.jobs_dir.glob("*.json")):
        try:
            jobs.append(_job_from_json(json.loads(path.read_text())))
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            warnings.append(
                {
                    "level": "warning",
                    "event": "malformed-job-json",
                    "path": str(path),
                    "message": str(exc),
                }
            )

    jobs.sort(key=lambda job: job.id)
    return JobListResult(jobs=jobs, diagnostics=ManagedDiagnostics(warnings=warnings))


def append_event(paths: ManagedPaths, job_id: str, event: Mapping[str, object]) -> None:
    _validate_job_id(job_id)
    paths.events_dir.mkdir(parents=True, exist_ok=True)
    event_path = paths.events_dir / f"{job_id}.jsonl"
    with event_path.open("a") as f:
        f.write(json.dumps(_json_value(dict(event)), sort_keys=True) + "\n")


def mark_job_state(
    paths: ManagedPaths,
    job_id: str,
    state: str,
    *,
    result_rollup: Mapping[str, object] | None = None,
    final_exit_code: int | None = None,
    failure_reason: str | None = None,
) -> ManagedJob:
    _validate_worker_state(state)
    job = read_job(paths, job_id)
    updates: dict[str, Any] = {
        "state": state,
        "updated_at": datetime.now(UTC),
    }
    if result_rollup is not None:
        updates["result_rollup"] = dict(result_rollup)
    if final_exit_code is not None:
        updates["final_exit_code"] = final_exit_code
    if failure_reason is not None:
        updates["failure_reason"] = failure_reason
    if state == "running" and job.started_at is None:
        updates["started_at"] = updates["updated_at"]
    if state in {"succeeded", "failed", "interrupted"} and job.finished_at is None:
        updates["finished_at"] = updates["updated_at"]
    updated = _replace_job(job, **updates)
    write_job_atomic(paths, updated)
    return updated


def heartbeat_job(paths: ManagedPaths, job_id: str, now: datetime) -> ManagedJob:
    job = read_job(paths, job_id)
    updated = _replace_job(job, updated_at=_to_utc(now))
    write_job_atomic(paths, updated)
    return updated


def mark_job_tainted(
    paths: ManagedPaths,
    job_id: str,
    reason: str,
    matches: Sequence[Mapping[str, object]],
) -> ManagedJob:
    job = read_job(paths, job_id)
    updated = _replace_job(
        job,
        updated_at=datetime.now(UTC),
        tainted=True,
        taint_reason=reason,
        taint_matches=[dict(match) for match in matches],
    )
    write_job_atomic(paths, updated)
    return updated


def _job_path(paths: ManagedPaths, job_id: str) -> Path:
    _validate_job_id(job_id)
    return paths.jobs_dir / f"{job_id}.json"


def _validate_job_id(job_id: str) -> None:
    if _JOB_ID_RE.fullmatch(job_id) is None:
        raise ValueError(f"invalid managed job id: {job_id}")


def _validate_worker_state(state: str) -> None:
    if state not in _WORKER_WRITTEN_STATES:
        raise ValueError(f"unsupported managed job state: {state}")


def _replace_job(job: ManagedJob, **updates: object) -> ManagedJob:
    data = asdict(job)
    data.update(updates)
    return ManagedJob(**data)


def _job_to_json(job: ManagedJob) -> dict[str, object]:
    data = asdict(job)
    known_fields = set(data)
    extra = data.pop("extra", {})
    if isinstance(extra, Mapping):
        data.update({key: value for key, value in extra.items() if key not in known_fields})
    return {key: _json_value(value) for key, value in data.items()}


def _job_from_json(data: object) -> ManagedJob:
    if not isinstance(data, dict) or not all(isinstance(key, str) for key in data):
        raise ValueError("job JSON must be an object")

    raw = cast(dict[str, object], data)
    known_fields = ManagedJob.__dataclass_fields__
    extra = {key: value for key, value in raw.items() if key not in known_fields or key == "extra"}

    for key in ("id", "state", "created_at", "updated_at", "command"):
        if key not in raw:
            raise ValueError(f"job JSON missing required field: {key}")

    return ManagedJob(
        id=_valid_job_id(raw["id"]),
        state=_valid_worker_state(raw["state"]),
        created_at=_parse_datetime(raw["created_at"]),
        updated_at=_parse_datetime(raw["updated_at"]),
        command=_string_list(raw["command"], "command"),
        schema_version=_int_value(raw.get("schema_version", _SCHEMA_VERSION), "schema_version"),
        managed_command=_optional_str(raw.get("managed_command"), "managed_command"),
        coding_agents=_string_list(raw.get("coding_agents", []), "coding_agents"),
        result_rollup=_optional_mapping(raw.get("result_rollup"), "result_rollup"),
        owner=_optional_str(raw.get("owner"), "owner"),
        host=_optional_str(raw.get("host"), "host"),
        profile=_optional_str(raw.get("profile"), "profile"),
        scenario_filter=_optional_str(raw.get("scenario_filter"), "scenario_filter"),
        tier=_optional_str(raw.get("tier"), "tier"),
        include_drafts=_optional_bool(raw.get("include_drafts"), "include_drafts"),
        out_root=_optional_str(raw.get("out_root"), "out_root"),
        log_path=_optional_str(raw.get("log_path"), "log_path"),
        locks=_string_list(raw.get("locks", []), "locks"),
        env_profiles=_string_list(raw.get("env_profiles", []), "env_profiles"),
        evals_repo=_optional_mapping(raw.get("evals_repo"), "evals_repo"),
        superpowers_repo=_optional_mapping(raw.get("superpowers_repo"), "superpowers_repo"),
        supervisor=_optional_mapping(raw.get("supervisor"), "supervisor"),
        children=_mapping_list(raw.get("children", []), "children"),
        artifact_bytes=_optional_int(raw.get("artifact_bytes"), "artifact_bytes"),
        started_at=_optional_datetime(raw.get("started_at"), "started_at"),
        finished_at=_optional_datetime(raw.get("finished_at"), "finished_at"),
        final_exit_code=_optional_int(raw.get("final_exit_code"), "final_exit_code"),
        failure_reason=_optional_str(raw.get("failure_reason"), "failure_reason"),
        tainted=_bool_value(raw.get("tainted", False), "tainted"),
        taint_reason=_optional_str(raw.get("taint_reason"), "taint_reason"),
        taint_matches=_mapping_list(raw.get("taint_matches", []), "taint_matches"),
        extra=extra,
    )


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _parse_datetime(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("datetime value must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return _to_utc(parsed)


def _optional_datetime(value: object, field_name: str) -> datetime | None:
    if value is None:
        return None
    try:
        return _parse_datetime(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a datetime string") from exc


def _json_value(value: object) -> object:
    if isinstance(value, datetime):
        return _to_utc(value).isoformat().replace("+00:00", "Z")
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    return value


def _string_list(value: object, field_name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{field_name} must be a list of strings")
    return cast(list[str], value)


def _mapping_list(value: object, field_name: str) -> list[Mapping[str, object]]:
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{field_name} must be a list of objects")
    return [cast(Mapping[str, object], item) for item in value]


def _required_str(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    return value


def _optional_str(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _required_str(value, field_name)


def _bool_value(value: object, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _optional_bool(value: object, field_name: str) -> bool | None:
    if value is None:
        return None
    return _bool_value(value, field_name)


def _int_value(value: object, field_name: str) -> int:
    if not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def _optional_int(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    return _int_value(value, field_name)


def _optional_mapping(value: object, field_name: str) -> Mapping[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{field_name} must be an object")
    return cast(Mapping[str, object], value)


def _valid_job_id(value: object) -> str:
    job_id = _required_str(value, "id")
    _validate_job_id(job_id)
    return job_id


def _valid_worker_state(value: object) -> str:
    state = _required_str(value, "state")
    _validate_worker_state(state)
    return state


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
