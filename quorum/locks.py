from __future__ import annotations

import errno
import fcntl
import getpass
import json
import os
import re
import socket
import tempfile
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, cast

from quorum.managed_state import ManagedPaths

_SCHEMA_VERSION = 1
_LOCK_PREFIX_ORDER = {"global": 0, "checkout": 1, "provider": 2, "target": 3}
_REQUIRES_LOCK_DETAIL = {"provider", "target"}
_JOB_ID_RE = re.compile(r"^job-\d{8}T\d{6}Z-[0-9a-f]{4}$")
_SAFE_NAME_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "._:-"
    "-"
)


@dataclass(frozen=True)
class LockRequest:
    name: str
    exclusive: bool = True


@dataclass(frozen=True)
class LockHolder:
    lock_name: str
    job_id: str
    pid: int
    hostname: str
    started_at: datetime
    command: list[str]
    user: str | None = None

    def to_json(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": _SCHEMA_VERSION,
            "lock_name": self.lock_name,
            "job_id": self.job_id,
            "pid": self.pid,
            "hostname": self.hostname,
            "started_at": _format_datetime(self.started_at),
            "command": self.command,
        }
        if self.user is not None:
            payload["user"] = self.user
        return payload


@dataclass(frozen=True)
class ManagedLock:
    name: str
    path: Path
    sidecar_path: Path
    exclusive: bool
    _file: IO[str]


@dataclass(frozen=True)
class Cooldown:
    provider: str
    reason: str
    until: datetime

    def to_json(self) -> dict[str, object]:
        return {
            "schema_version": _SCHEMA_VERSION,
            "provider": self.provider,
            "reason": self.reason,
            "until": _format_datetime(self.until),
        }


class LockConflict(RuntimeError):
    def __init__(
        self,
        *,
        lock_name: str,
        lock_path: Path,
        holder: LockHolder | None,
        requested_job_id: str,
        command: Sequence[str],
        wait: bool,
    ) -> None:
        super().__init__(f"lock conflict for {lock_name}")
        self.lock_name = lock_name
        self.lock_path = lock_path
        self.holder = holder
        self.requested_job_id = requested_job_id
        self.command = list(command)
        self.wait = wait

    def to_json(self) -> dict[str, object]:
        return {
            "error": "lock-conflict",
            "lock_name": self.lock_name,
            "lock_path": str(self.lock_path),
            "holder": self.holder.to_json() if self.holder is not None else None,
            "requested_job_id": self.requested_job_id,
            "command": self.command,
            "wait": self.wait,
        }


def acquire_locks(
    paths: ManagedPaths,
    requests: Sequence[LockRequest],
    job_id: str,
    command: Sequence[str],
    wait: bool = False,
) -> list[ManagedLock]:
    _validate_job_id(job_id)
    held: list[ManagedLock] = []
    try:
        for request in sorted(requests, key=_lock_request_sort_key):
            held.append(_acquire_one(paths, request, job_id, command, wait=wait))
    except BaseException:
        release_locks(held)
        raise
    return held


def release_locks(held: Sequence[ManagedLock]) -> None:
    for lock in reversed(held):
        try:
            lock.sidecar_path.unlink(missing_ok=True)
        finally:
            try:
                fcntl.flock(lock._file.fileno(), fcntl.LOCK_UN)
            finally:
                lock._file.close()


def read_lock_holder(paths: ManagedPaths, lock_name: str) -> LockHolder | None:
    for sidecar_path in _sidecar_paths(paths, lock_name):
        try:
            return _lock_holder_from_json(json.loads(sidecar_path.read_text()))
        except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError):
            continue
    return None


def write_cooldown(paths: ManagedPaths, provider: str, reason: str, until: datetime) -> None:
    cooldown = Cooldown(
        provider=_validate_cooldown_name(provider),
        reason=reason,
        until=_to_utc(until),
    )
    paths.cooldowns_dir.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(paths.cooldowns_dir / f"{cooldown.provider}.json", cooldown.to_json())


def read_active_cooldowns(paths: ManagedPaths, now: datetime) -> list[Cooldown]:
    active: list[Cooldown] = []
    current = _to_utc(now)
    if not paths.cooldowns_dir.exists():
        return active

    for path in sorted(paths.cooldowns_dir.glob("*.json")):
        provider = path.name.removesuffix(".json")
        try:
            _validate_cooldown_name(provider)
            cooldown = _cooldown_from_json(json.loads(path.read_text()))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if cooldown.until <= current:
            path.unlink(missing_ok=True)
            continue
        active.append(cooldown)

    active.sort(key=lambda cooldown: cooldown.provider)
    return active


def _acquire_one(
    paths: ManagedPaths,
    request: LockRequest,
    job_id: str,
    command: Sequence[str],
    *,
    wait: bool,
) -> ManagedLock:
    lock_name = _validate_lock_name(request.name)
    paths.locks_dir.mkdir(parents=True, exist_ok=True)
    lock_path = paths.locks_dir / f"{lock_name}.lock"
    sidecar_path = _holder_sidecar_path(paths, lock_name, job_id)
    file = _open_lock_file(lock_path)
    flags = fcntl.LOCK_EX if request.exclusive else fcntl.LOCK_SH
    if not wait:
        flags |= fcntl.LOCK_NB

    try:
        fcntl.flock(file.fileno(), flags)
    except OSError as exc:
        file.close()
        if exc.errno in {errno.EACCES, errno.EAGAIN}:
            raise LockConflict(
                lock_name=lock_name,
                lock_path=lock_path,
                holder=read_lock_holder(paths, lock_name),
                requested_job_id=job_id,
                command=command,
                wait=wait,
            ) from exc
        raise

    holder = LockHolder(
        lock_name=lock_name,
        job_id=job_id,
        pid=os.getpid(),
        hostname=socket.gethostname(),
        started_at=datetime.now(UTC),
        command=list(command),
        user=getpass.getuser(),
    )
    try:
        _write_json_atomic(sidecar_path, holder.to_json())
    except BaseException:
        try:
            fcntl.flock(file.fileno(), fcntl.LOCK_UN)
        finally:
            file.close()
        raise
    return ManagedLock(
        name=lock_name,
        path=lock_path,
        sidecar_path=sidecar_path,
        exclusive=request.exclusive,
        _file=file,
    )


def _open_lock_file(path: Path) -> IO[str]:
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o660)
    with suppress(OSError):
        os.chmod(path, 0o660)
    return os.fdopen(fd, "r+")


def _lock_request_sort_key(request: LockRequest) -> tuple[int, str]:
    name = _validate_lock_name(request.name)
    prefix = name.split(":", maxsplit=1)[0]
    return (_LOCK_PREFIX_ORDER[prefix], name)


def _lock_path(paths: ManagedPaths, lock_name: str) -> Path:
    return paths.locks_dir / f"{_validate_lock_name(lock_name)}.lock"


def _sidecar_path(paths: ManagedPaths, lock_name: str) -> Path:
    return _lock_path(paths, lock_name).with_suffix(".json")


def _holder_sidecar_path(paths: ManagedPaths, lock_name: str, job_id: str) -> Path:
    return paths.locks_dir / f"{_validate_lock_name(lock_name)}.{_validate_job_id(job_id)}.json"


def _sidecar_paths(paths: ManagedPaths, lock_name: str) -> list[Path]:
    base = _sidecar_path(paths, lock_name)
    if not paths.locks_dir.exists():
        return []
    return sorted([base, *paths.locks_dir.glob(f"{_validate_lock_name(lock_name)}.job-*.json")])


def _write_json_atomic(destination: Path, payload: Mapping[str, object]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(dict(payload), indent=2, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
        text=True,
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, destination)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def _validate_lock_name(name: str) -> str:
    if not _is_safe_name(name):
        raise ValueError(f"invalid lock name: {name}")
    parts = name.split(":")
    prefix = parts[0]
    if prefix not in _LOCK_PREFIX_ORDER:
        raise ValueError(f"invalid lock name: {name}")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError(f"invalid lock name: {name}")
    if prefix in _REQUIRES_LOCK_DETAIL and len(parts) == 1:
        raise ValueError(f"invalid lock name: {name}")
    return name


def _validate_cooldown_name(name: str) -> str:
    if not _is_safe_name(name):
        raise ValueError(f"invalid cooldown name: {name}")
    return name


def _is_safe_name(name: str) -> bool:
    if not name or name in {".", ".."}:
        return False
    if any(char not in _SAFE_NAME_CHARS for char in name):
        return False
    if ".." in name.split(":"):
        return False
    return not Path(name).is_absolute()


def _validate_job_id(job_id: str) -> str:
    if _JOB_ID_RE.fullmatch(job_id) is None:
        raise ValueError(f"invalid managed job id: {job_id}")
    return job_id


def _lock_holder_from_json(data: object) -> LockHolder:
    if not isinstance(data, dict):
        raise ValueError("lock holder JSON must be an object")
    raw = cast(dict[str, object], data)
    return LockHolder(
        lock_name=_validate_lock_name(_required_str(raw.get("lock_name"), "lock_name")),
        job_id=_validate_job_id(_required_str(raw.get("job_id"), "job_id")),
        pid=_required_int(raw.get("pid"), "pid"),
        hostname=_required_str(raw.get("hostname"), "hostname"),
        started_at=_parse_datetime(raw.get("started_at")),
        command=_string_list(raw.get("command"), "command"),
        user=_optional_str(raw.get("user"), "user"),
    )


def _cooldown_from_json(data: object) -> Cooldown:
    if not isinstance(data, dict):
        raise ValueError("cooldown JSON must be an object")
    raw = cast(dict[str, object], data)
    provider = _validate_cooldown_name(_required_str(raw.get("provider"), "provider"))
    return Cooldown(
        provider=provider,
        reason=_required_str(raw.get("reason"), "reason"),
        until=_parse_datetime(raw.get("until")),
    )


def _required_str(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    return value


def _optional_str(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    return _required_str(value, field_name)


def _required_int(value: object, field_name: str) -> int:
    if not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def _string_list(value: object, field_name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{field_name} must be a list of strings")
    return cast(list[str], value)


def _parse_datetime(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("datetime value must be a string")
    return _to_utc(datetime.fromisoformat(value.replace("Z", "+00:00")))


def _format_datetime(value: datetime) -> str:
    return _to_utc(value).isoformat().replace("+00:00", "Z")


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
