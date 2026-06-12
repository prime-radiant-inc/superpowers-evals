from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

from quorum.managed_state import ManagedJob, ManagedPaths, append_event, mark_job_tainted
from quorum.runtime_env import TargetProfile

_BINARY_SAMPLE_BYTES = 4096
_SCAN_CHUNK_BYTES = 1024 * 1024
_SCAN_OVERLAP_BYTES = 8192
_SECRET_ENV_NAME_RE = re.compile(
    r"(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)(?:_|$)"
)


@dataclass(frozen=True)
class SecretPattern:
    name: str
    regex: re.Pattern[bytes]


@dataclass(frozen=True)
class SecretMatch:
    path: str
    offset: int
    pattern: str
    digest: str

    def to_json(self) -> dict[str, object]:
        return {
            "path": self.path,
            "offset": self.offset,
            "pattern": self.pattern,
            "digest": self.digest,
        }


@dataclass(frozen=True)
class SecretScanResult:
    matches: list[SecretMatch] = field(default_factory=list)

    @property
    def found(self) -> bool:
        return bool(self.matches)

    def to_json(self) -> dict[str, object]:
        return {"matches": [match.to_json() for match in self.matches]}


def build_secret_patterns(target_profile: TargetProfile) -> list[SecretPattern]:
    patterns = [
        SecretPattern("anthropic-api-key", re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{16,}\b")),
        SecretPattern("openai-api-key", re.compile(rb"\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b")),
        SecretPattern(
            "github-token",
            re.compile(
                rb"\b(?:ghp_[A-Za-z0-9_]{20,}|"
                rb"gho_[A-Za-z0-9_]{20,}|"
                rb"github_pat_[A-Za-z0-9_]{20,})\b"
            ),
        ),
        SecretPattern("google-api-key", re.compile(rb"\bAIza[0-9A-Za-z_-]{20,}\b")),
        SecretPattern("aws-access-key-id", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ]
    for name, value in sorted(target_profile.env.items()):
        if value and _SECRET_ENV_NAME_RE.search(name):
            patterns.append(SecretPattern(name, re.compile(re.escape(value.encode()))))
    return patterns


def scan_path_for_secrets(path: Path, patterns: Sequence[SecretPattern]) -> SecretScanResult:
    if not patterns:
        return SecretScanResult()
    matches: list[SecretMatch] = []
    for file_path in _iter_scan_files(path):
        matches.extend(_scan_file_for_secrets(file_path, patterns))
    return SecretScanResult(matches=matches)


def scan_job_artifacts(
    job: ManagedJob,
    patterns: Sequence[SecretPattern],
    paths: ManagedPaths | None = None,
) -> SecretScanResult:
    matches: list[SecretMatch] = []
    for path in _job_artifact_paths(job, paths):
        matches.extend(scan_path_for_secrets(path, patterns).matches)
    return SecretScanResult(matches=matches)


def taint_job_on_secret_match(
    paths: ManagedPaths,
    job: ManagedJob,
    result: SecretScanResult,
) -> ManagedJob:
    if not result.found:
        return job
    match_list = [match.to_json() for match in result.matches]
    reason = "secret-like material detected in managed artifacts"
    updated = mark_job_tainted(paths, job.id, reason, match_list)
    append_event(
        paths,
        job.id,
        {
            "event": "job-tainted",
            "job_id": job.id,
            "reason": reason,
            "matches": match_list,
        },
    )
    return updated


def _iter_scan_files(path: Path) -> list[Path]:
    try:
        if path.is_symlink() or not path.exists():
            return []
        if path.is_file():
            return [path]
        if not path.is_dir():
            return []
    except OSError:
        return []

    files: list[Path] = []
    for root, dirs, filenames in os.walk(path, followlinks=False):
        root_path = Path(root)
        dirs[:] = sorted(dirname for dirname in dirs if not (root_path / dirname).is_symlink())
        for filename in sorted(filenames):
            file_path = root_path / filename
            try:
                if file_path.is_file() and not file_path.is_symlink():
                    files.append(file_path)
            except OSError:
                continue
    return files


def _scan_file_for_secrets(path: Path, patterns: Sequence[SecretPattern]) -> list[SecretMatch]:
    try:
        with path.open("rb") as file:
            sample = file.read(_BINARY_SAMPLE_BYTES)
            if b"\x00" in sample:
                return []
            file.seek(0)
            return _scan_stream_for_secrets(file, str(path), patterns)
    except OSError:
        return []


def _scan_stream_for_secrets(
    stream: BinaryIO,
    path: str,
    patterns: Sequence[SecretPattern],
) -> list[SecretMatch]:
    matches: list[SecretMatch] = []
    seen: set[tuple[str, int, str]] = set()
    pending = b""
    stream_offset = 0

    while True:
        chunk = stream.read(_SCAN_CHUNK_BYTES)
        if not chunk:
            _extend_matches(matches, seen, path, pending, stream_offset - len(pending), patterns)
            return matches

        data = pending + chunk
        base_offset = stream_offset - len(pending)
        safe_end = max(0, len(data) - _SCAN_OVERLAP_BYTES)
        _extend_matches(
            matches,
            seen,
            path,
            data[:safe_end],
            base_offset,
            patterns,
        )
        pending = data[safe_end:]
        if len(pending) > _SCAN_OVERLAP_BYTES:
            pending = pending[-_SCAN_OVERLAP_BYTES:]
        stream_offset += len(chunk)


def _extend_matches(
    matches: list[SecretMatch],
    seen: set[tuple[str, int, str]],
    path: str,
    data: bytes,
    base_offset: int,
    patterns: Sequence[SecretPattern],
) -> None:
    for pattern in patterns:
        for match in pattern.regex.finditer(data):
            offset = base_offset + match.start()
            digest = _short_digest(match.group(0))
            key = (pattern.name, offset, digest)
            if key in seen:
                continue
            seen.add(key)
            matches.append(
                SecretMatch(
                    path=path,
                    offset=offset,
                    pattern=pattern.name,
                    digest=digest,
                )
            )


def _job_artifact_paths(job: ManagedJob, managed_paths: ManagedPaths | None) -> list[Path]:
    artifact_paths: list[Path] = []
    seen: set[str] = set()
    if managed_paths is not None:
        _append_unique(artifact_paths, managed_paths.jobs_dir / f"{job.id}.json", seen)
        _append_unique(artifact_paths, managed_paths.events_dir / f"{job.id}.jsonl", seen)
    if job.log_path:
        _append_unique(artifact_paths, Path(job.log_path), seen)
    for child in job.children:
        for path in _child_artifact_paths(job, child):
            _append_unique(artifact_paths, path, seen)
    return artifact_paths


def _append_unique(paths: list[Path], path: Path, seen: set[str]) -> None:
    key = str(path)
    if key in seen:
        return
    seen.add(key)
    paths.append(path)


def _child_artifact_paths(job: ManagedJob, child: Mapping[str, object]) -> list[Path]:
    paths: list[Path] = []
    run_dir = _path_value(child.get("run_dir"))
    run_id = _str_value(child.get("run_id"))
    out_root = _path_value(job.out_root)
    if run_dir is None and run_id is not None and out_root is not None:
        run_dir = out_root / run_id
    if run_dir is not None:
        paths.append(run_dir)

    batch_dir = _path_value(child.get("batch_dir"))
    batch_id = _str_value(child.get("batch_id"))
    if batch_dir is None and batch_id is not None and out_root is not None:
        batch_dir = out_root / "batches" / batch_id
    if batch_dir is not None:
        paths.append(batch_dir)
    return paths


def _path_value(value: object) -> Path | None:
    if isinstance(value, str) and value:
        return Path(value)
    return None


def _str_value(value: object) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def _short_digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()[:8]}"
