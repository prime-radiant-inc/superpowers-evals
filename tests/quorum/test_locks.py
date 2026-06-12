from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest

from quorum.locks import (
    LockConflict,
    LockRequest,
    acquire_locks,
    read_active_cooldowns,
    read_lock_holder,
    release_locks,
    write_cooldown,
)
from quorum.managed_state import discover_managed_paths

FIXTURES = Path(__file__).parent / "fixtures"


def _paths(tmp_path):
    return discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})


def test_second_process_cannot_acquire_exclusive_lock_already_held(tmp_path):
    paths = _paths(tmp_path)
    holder = subprocess.Popen(
        [
            sys.executable,
            str(FIXTURES / "lock_holder.py"),
            str(paths.state_root),
            "target:claude",
            "job-20260612T190000Z-a1b2",
        ],
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "locked"

        with pytest.raises(LockConflict) as exc_info:
            acquire_locks(
                paths,
                [LockRequest("target:claude")],
                job_id="job-20260612T190001Z-b2c3",
                command=["quorum", "smoke", "claude"],
            )

        conflict = exc_info.value
        assert conflict.lock_name == "target:claude"
        assert conflict.holder is not None
        assert conflict.holder.job_id == "job-20260612T190000Z-a1b2"
        assert conflict.holder.command == ["lock-holder", "target:claude"]
    finally:
        if holder.stdin is not None:
            holder.stdin.write("\n")
            holder.stdin.flush()
        holder.wait(timeout=10)
        assert holder.returncode == 0, holder.stderr.read() if holder.stderr else ""


def test_lock_requests_are_acquired_in_deterministic_order(tmp_path):
    paths = _paths(tmp_path)
    held = acquire_locks(
        paths,
        [
            LockRequest("target:claude"),
            LockRequest("provider:anthropic"),
            LockRequest("checkout:evals:abc123", exclusive=False),
            LockRequest("global:broad-batch"),
        ],
        job_id="job-20260612T190000Z-a1b2",
        command=["quorum", "batch", "sentinel-default"],
    )
    try:
        assert [lock.name for lock in held] == [
            "global:broad-batch",
            "checkout:evals:abc123",
            "provider:anthropic",
            "target:claude",
        ]
    finally:
        release_locks(held)


def test_sidecar_content_includes_holder_diagnostics_and_is_removed_on_release(tmp_path):
    paths = _paths(tmp_path)
    held = acquire_locks(
        paths,
        [LockRequest("provider:anthropic")],
        job_id="job-20260612T190000Z-a1b2",
        command=["quorum", "column", "claude"],
    )
    try:
        holder = read_lock_holder(paths, "provider:anthropic")

        assert holder is not None
        assert holder.lock_name == "provider:anthropic"
        assert holder.job_id == "job-20260612T190000Z-a1b2"
        assert isinstance(holder.pid, int)
        assert holder.pid > 0
        assert holder.hostname
        assert holder.started_at.tzinfo is not None
        assert holder.command == ["quorum", "column", "claude"]
        sidecar = paths.locks_dir / "provider:anthropic.job-20260612T190000Z-a1b2.json"
        assert json.loads(sidecar.read_text())["started_at"].endswith("Z")
    finally:
        release_locks(held)

    assert read_lock_holder(paths, "provider:anthropic") is None
    assert not (paths.locks_dir / "provider:anthropic.job-20260612T190000Z-a1b2.json").exists()


def test_hyphenated_lock_and_cooldown_names_are_allowed(tmp_path):
    paths = _paths(tmp_path)
    now = datetime(2026, 6, 12, 19, 0, tzinfo=UTC)
    held = acquire_locks(
        paths,
        [LockRequest("target:claude-sonnet"), LockRequest("provider:google-code-assist")],
        job_id="job-20260612T190000Z-a1b2",
        command=["quorum", "smoke", "claude-sonnet"],
    )
    try:
        assert [lock.name for lock in held] == [
            "provider:google-code-assist",
            "target:claude-sonnet",
        ]
        assert read_lock_holder(paths, "target:claude-sonnet") is not None
    finally:
        release_locks(held)

    write_cooldown(
        paths,
        "google-code-assist",
        "quota window",
        now + timedelta(minutes=5),
    )
    assert [cooldown.provider for cooldown in read_active_cooldowns(paths, now)] == [
        "google-code-assist"
    ]


def test_sidecar_write_failure_releases_kernel_lock(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    class TrackingFile:
        def __init__(self, path: Path) -> None:
            self._file = path.open("a+")
            self.closed_explicitly = False

        def fileno(self) -> int:
            return self._file.fileno()

        def close(self) -> None:
            self.closed_explicitly = True
            self._file.close()

    opened: list[TrackingFile] = []

    def open_tracking_file(path: Path):
        tracking = TrackingFile(path)
        opened.append(tracking)
        return tracking

    def fail_write(*_args, **_kwargs) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("quorum.locks._open_lock_file", open_tracking_file)
    monkeypatch.setattr("quorum.locks._write_json_atomic", fail_write)

    with pytest.raises(OSError, match="disk full"):
        acquire_locks(
            paths,
            [LockRequest("target:claude")],
            job_id="job-20260612T190000Z-a1b2",
            command=["quorum", "smoke", "claude"],
        )

    assert opened
    assert all(file.closed_explicitly for file in opened)

    monkeypatch.undo()
    held = acquire_locks(
        paths,
        [LockRequest("target:claude")],
        job_id="job-20260612T190001Z-b2c3",
        command=["quorum", "smoke", "claude"],
    )
    release_locks(held)


def test_shared_locks_keep_per_holder_sidecars_until_each_holder_releases(tmp_path):
    paths = _paths(tmp_path)
    first = acquire_locks(
        paths,
        [LockRequest("checkout:evals:abc123", exclusive=False)],
        job_id="job-20260612T190000Z-a1b2",
        command=["quorum", "column", "claude"],
    )
    second = acquire_locks(
        paths,
        [LockRequest("checkout:evals:abc123", exclusive=False)],
        job_id="job-20260612T190001Z-b2c3",
        command=["quorum", "column", "kimi"],
    )

    try:
        holder = read_lock_holder(paths, "checkout:evals:abc123")
        assert holder is not None
        assert holder.job_id in {"job-20260612T190000Z-a1b2", "job-20260612T190001Z-b2c3"}
        sidecars = sorted(paths.locks_dir.glob("checkout:evals:abc123.*.json"))
        assert len(sidecars) == 2

        release_locks(first)

        remaining_sidecars = sorted(paths.locks_dir.glob("checkout:evals:abc123.*.json"))
        assert len(remaining_sidecars) == 1
        assert read_lock_holder(paths, "checkout:evals:abc123") is not None

        with pytest.raises(LockConflict):
            acquire_locks(
                paths,
                [LockRequest("checkout:evals:abc123")],
                job_id="job-20260612T190002Z-c3d4",
                command=["quorum", "sync"],
            )
    finally:
        release_locks(second)

    assert read_lock_holder(paths, "checkout:evals:abc123") is None


def test_cooldown_read_returns_active_cooldowns_and_drops_expired(tmp_path):
    paths = _paths(tmp_path)
    now = datetime(2026, 6, 12, 19, 0, tzinfo=UTC)
    write_cooldown(paths, "anthropic", "429 from claude", now + timedelta(minutes=20))
    write_cooldown(paths, "google", "old quota window", now - timedelta(minutes=1))

    active = read_active_cooldowns(paths, now)

    assert [cooldown.provider for cooldown in active] == ["anthropic"]
    assert active[0].reason == "429 from claude"
    assert active[0].until == now + timedelta(minutes=20)
    assert (paths.cooldowns_dir / "anthropic.json").exists()
    assert not (paths.cooldowns_dir / "google.json").exists()


def test_lock_conflict_objects_are_json_serializable_for_status_output(tmp_path):
    paths = _paths(tmp_path)
    held = acquire_locks(
        paths,
        [LockRequest("target:kimi")],
        job_id="job-20260612T190000Z-a1b2",
        command=["quorum", "smoke", "kimi"],
    )
    try:
        with pytest.raises(LockConflict) as exc_info:
            acquire_locks(
                paths,
                [LockRequest("target:kimi")],
                job_id="job-20260612T190001Z-b2c3",
                command=["quorum", "smoke", "kimi"],
            )

        payload = exc_info.value.to_json()
        holder = cast(dict[str, object], payload["holder"])
        encoded = json.dumps(payload, sort_keys=True)
        assert '"lock_name": "target:kimi"' in encoded
        assert holder["job_id"] == "job-20260612T190000Z-a1b2"
        assert payload["wait"] is False
    finally:
        release_locks(held)


def test_malformed_sidecar_is_diagnostic_only_for_lock_conflicts(tmp_path):
    paths = _paths(tmp_path)
    holder = subprocess.Popen(
        [
            sys.executable,
            str(FIXTURES / "lock_holder.py"),
            str(paths.state_root),
            "provider:google",
            "job-20260612T190000Z-a1b2",
        ],
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "locked"
        (paths.locks_dir / "provider:google.job-20260612T190000Z-a1b2.json").write_text(
            "{not-json"
        )

        with pytest.raises(LockConflict) as exc_info:
            acquire_locks(
                paths,
                [LockRequest("provider:google")],
                job_id="job-20260612T190001Z-b2c3",
                command=["quorum", "smoke", "gemini"],
            )

        assert exc_info.value.holder is None
    finally:
        if holder.stdin is not None:
            holder.stdin.write("\n")
            holder.stdin.flush()
        holder.wait(timeout=10)
        assert holder.returncode == 0, holder.stderr.read() if holder.stderr else ""


def test_sidecar_with_invalid_holder_identity_is_diagnostic_only(tmp_path):
    paths = _paths(tmp_path)
    holder = subprocess.Popen(
        [
            sys.executable,
            str(FIXTURES / "lock_holder.py"),
            str(paths.state_root),
            "provider:google",
            "job-20260612T190000Z-a1b2",
        ],
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "locked"
        (paths.locks_dir / "provider:google.job-20260612T190000Z-a1b2.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "lock_name": "../escape",
                    "job_id": "not-a-job",
                    "pid": 123,
                    "hostname": "host",
                    "started_at": "2026-06-12T19:00:00Z",
                    "command": ["quorum", "smoke", "gemini"],
                }
            )
        )

        assert read_lock_holder(paths, "provider:google") is None
        with pytest.raises(LockConflict) as exc_info:
            acquire_locks(
                paths,
                [LockRequest("provider:google")],
                job_id="job-20260612T190001Z-b2c3",
                command=["quorum", "smoke", "gemini"],
            )

        assert exc_info.value.holder is None
    finally:
        if holder.stdin is not None:
            holder.stdin.write("\n")
            holder.stdin.flush()
        holder.wait(timeout=10)
        assert holder.returncode == 0, holder.stderr.read() if holder.stderr else ""


@pytest.mark.parametrize(
    "bad_name",
    [
        "../escape",
        "/tmp/escape",
        "provider:../anthropic",
        "target:claude/child",
        "provider",
        "provider:",
        "target",
        "target:",
        "global:",
        "checkout:",
        "",
    ],
)
def test_lock_file_names_reject_path_traversal(tmp_path, bad_name):
    paths = _paths(tmp_path)

    with pytest.raises(ValueError, match="invalid lock name"):
        acquire_locks(
            paths,
            [LockRequest(bad_name)],
            job_id="job-20260612T190000Z-a1b2",
            command=["quorum", "smoke", "claude"],
        )
    with pytest.raises(ValueError, match="invalid lock name"):
        read_lock_holder(paths, bad_name)

    assert not (tmp_path / "escape.lock").exists()
    assert not (tmp_path / "escape.json").exists()


@pytest.mark.parametrize("job_id", ["../escape", "not-a-job", "job-20260612T190000Z-zzzz"])
def test_acquire_locks_rejects_invalid_job_ids(tmp_path, job_id):
    paths = _paths(tmp_path)

    with pytest.raises(ValueError, match="invalid managed job id"):
        acquire_locks(
            paths,
            [LockRequest("target:claude")],
            job_id=job_id,
            command=["quorum", "smoke", "claude"],
        )

    assert not paths.locks_dir.exists()


@pytest.mark.parametrize("bad_provider", ["../escape", "/tmp/escape", "openai/child", ""])
def test_cooldown_file_names_reject_path_traversal(tmp_path, bad_provider):
    paths = _paths(tmp_path)
    now = datetime(2026, 6, 12, 19, 0, tzinfo=UTC)

    with pytest.raises(ValueError, match="invalid cooldown name"):
        write_cooldown(paths, bad_provider, "quota", now + timedelta(minutes=5))

    assert not (tmp_path / "escape.json").exists()
