import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from quorum.managed_state import (
    ManagedJob,
    append_event,
    discover_managed_paths,
    heartbeat_job,
    list_jobs,
    mark_job_state,
    mark_job_tainted,
    new_job_id,
    read_job,
    write_job_atomic,
)


def _job(job_id: str = "job-20260612T190000Z-a1b2") -> ManagedJob:
    now = datetime(2026, 6, 12, 19, 0, tzinfo=UTC)
    return ManagedJob(
        id=job_id,
        state="planned",
        result_rollup=None,
        created_at=now,
        updated_at=now,
        command=["quorum", "smoke", "claude"],
        managed_command="smoke",
        coding_agents=["claude"],
    )


def test_discovered_paths_are_created_lazily(tmp_path):
    paths = discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )

    assert paths.state_root == tmp_path / "state"
    assert paths.artifact_root == tmp_path / "artifacts"
    assert paths.jobs_dir == tmp_path / "state" / "jobs"
    assert paths.events_dir == tmp_path / "state" / "events"
    assert paths.locks_dir == tmp_path / "state" / "locks"
    assert paths.cooldowns_dir == tmp_path / "state" / "cooldowns"
    assert paths.taints_dir == tmp_path / "state" / "taints"
    assert not paths.state_root.exists()

    write_job_atomic(paths, _job())
    append_event(paths, _job().id, {"level": "info", "message": "created"})

    assert paths.jobs_dir.is_dir()
    assert paths.events_dir.is_dir()
    assert not paths.locks_dir.exists()


def test_job_ids_are_unique_sortable_and_use_spec_shape():
    now = datetime(2026, 6, 12, 19, 0, tzinfo=UTC)

    ids = [
        new_job_id(now, "smoke", "claude"),
        new_job_id(now + timedelta(seconds=1), "smoke", "kimi/code"),
        new_job_id(now + timedelta(seconds=2), "batch", None),
    ]

    assert len(set(ids)) == 3
    assert ids == sorted(ids)
    assert all(job_id.startswith("job-20260612T19000") for job_id in ids)
    assert all(len(job_id.rsplit("-", maxsplit=1)[1]) == 4 for job_id in ids)


def test_atomic_write_failure_leaves_existing_job_json_intact(tmp_path, monkeypatch):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    original = _job()
    replacement = replace(original, state="running")

    write_job_atomic(paths, original)

    def fail_replace(src: str, dst: str) -> None:
        raise OSError(f"refusing to replace {src} -> {dst}")

    monkeypatch.setattr("quorum.managed_state.os.replace", fail_replace)

    with pytest.raises(OSError):
        write_job_atomic(paths, replacement)

    assert read_job(paths, original.id) == original
    json.loads((paths.jobs_dir / f"{original.id}.json").read_text())


def test_atomic_write_fsyncs_jobs_directory_after_replace(tmp_path, monkeypatch):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    fsynced: list[Path] = []

    monkeypatch.setattr("quorum.managed_state._fsync_directory", fsynced.append)

    write_job_atomic(paths, _job())

    assert fsynced == [paths.jobs_dir]


@pytest.mark.parametrize("job_id", ["../escape", "/tmp/escape", "job-20260612T190000Z-a1b2/child"])
def test_job_id_path_traversal_is_rejected(tmp_path, job_id):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})

    with pytest.raises(ValueError, match="invalid managed job id"):
        write_job_atomic(paths, replace(_job(), id=job_id))
    with pytest.raises(ValueError, match="invalid managed job id"):
        read_job(paths, job_id)
    with pytest.raises(ValueError, match="invalid managed job id"):
        append_event(paths, job_id, {"level": "info"})

    assert not (tmp_path / "escape.json").exists()


@pytest.mark.parametrize("state", ["orphaned", "waiting", "queued"])
def test_write_job_rejects_non_worker_lifecycle_states(tmp_path, state):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})

    with pytest.raises(ValueError, match="unsupported managed job state"):
        write_job_atomic(paths, replace(_job(), state=state))

    assert not paths.jobs_dir.exists()


def test_read_job_rejects_invalid_persisted_state(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    write_job_atomic(paths, _job())
    job_path = paths.jobs_dir / f"{_job().id}.json"
    payload = json.loads(job_path.read_text())
    payload["state"] = "queued"
    job_path.write_text(json.dumps(payload))

    with pytest.raises(ValueError, match="unsupported managed job state"):
        read_job(paths, _job().id)


def test_list_jobs_reports_invalid_persisted_state_as_malformed(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    write_job_atomic(paths, _job("job-20260612T190000Z-cafe"))
    bad = replace(_job("job-20260612T190001Z-bad1"), state="running")
    write_job_atomic(paths, bad)
    bad_path = paths.jobs_dir / f"{bad.id}.json"
    payload = json.loads(bad_path.read_text())
    payload["state"] = "orphaned"
    bad_path.write_text(json.dumps(payload))

    result = list_jobs(paths)

    assert [job.id for job in result.jobs] == ["job-20260612T190000Z-cafe"]
    assert len(result.diagnostics.warnings) == 1
    assert result.diagnostics.warnings[0]["event"] == "malformed-job-json"
    assert "unsupported managed job state" in str(result.diagnostics.warnings[0]["message"])


def test_list_jobs_ignores_malformed_files_and_records_diagnostic_warning(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    write_job_atomic(paths, _job("job-20260612T190000Z-cafe"))
    paths.jobs_dir.mkdir(parents=True, exist_ok=True)
    (paths.jobs_dir / "broken.json").write_text("{not-json")

    result = list_jobs(paths)

    assert [job.id for job in result.jobs] == ["job-20260612T190000Z-cafe"]
    assert len(result.diagnostics.warnings) == 1
    assert result.diagnostics.warnings[0]["level"] == "warning"
    warning_path = result.diagnostics.warnings[0]["path"]
    assert isinstance(warning_path, str)
    assert warning_path.endswith("broken.json")


def test_append_event_normalizes_datetime_and_path_fields(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    occurred_at = datetime(2026, 6, 12, 20, 0, tzinfo=UTC)

    append_event(
        paths,
        _job().id,
        {"level": "info", "occurred_at": occurred_at, "path": tmp_path / "artifact.txt"},
    )

    event = json.loads((paths.events_dir / f"{_job().id}.jsonl").read_text())
    assert event["occurred_at"] == "2026-06-12T20:00:00Z"
    assert event["path"] == str(tmp_path / "artifact.txt")


def test_heartbeat_updates_updated_at_without_mutating_immutable_fields(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    job = _job()
    write_job_atomic(paths, job)
    heartbeat_at = job.updated_at + timedelta(minutes=5)

    updated = heartbeat_job(paths, job.id, heartbeat_at)

    assert updated.updated_at == heartbeat_at
    assert updated.id == job.id
    assert updated.state == job.state
    assert updated.created_at == job.created_at
    assert updated.command == job.command
    assert updated.managed_command == job.managed_command
    assert updated.coding_agents == job.coding_agents
    assert read_job(paths, job.id) == updated


def test_mark_job_state_sets_started_at_when_entering_running(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    job = _job()
    write_job_atomic(paths, job)

    updated = mark_job_state(paths, job.id, "running")

    assert updated.state == "running"
    assert updated.started_at == updated.updated_at
    assert updated.finished_at is None


def test_mark_job_tainted_preserves_state_and_previous_result_rollup(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    job = _job()
    write_job_atomic(paths, job)
    mark_job_state(
        paths,
        job.id,
        "succeeded",
        result_rollup={"result": "pass", "failed": 0},
        final_exit_code=0,
    )

    tainted = mark_job_tainted(
        paths,
        job.id,
        "secret-like material in transcript",
        [{"path": "transcript.txt", "line": 7}],
    )

    assert tainted.state == "succeeded"
    assert tainted.tainted is True
    assert tainted.result_rollup == {"result": "pass", "failed": 0}
    assert tainted.taint_reason == "secret-like material in transcript"
    assert tainted.taint_matches == [{"path": "transcript.txt", "line": 7}]


def test_mark_job_state_records_result_rollup_and_final_exit_code(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    job = _job()
    write_job_atomic(paths, job)

    updated = mark_job_state(
        paths,
        job.id,
        "failed",
        result_rollup={"result": "fail", "failed": 1},
        final_exit_code=17,
        failure_reason="child failed",
    )

    assert updated.state == "failed"
    assert updated.result_rollup == {"result": "fail", "failed": 1}
    assert updated.final_exit_code == 17
    assert updated.failure_reason == "child failed"
    assert updated.finished_at == updated.updated_at


def test_artifact_bytes_round_trips_through_job_json(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    job = replace(_job(), artifact_bytes=1234)

    write_job_atomic(paths, job)

    assert read_job(paths, job.id).artifact_bytes == 1234


def test_extra_fields_preserve_unknowns_without_overriding_canonical_fields(tmp_path):
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(tmp_path / "state")})
    job = replace(
        _job(),
        extra={
            "state": "queued",
            "id": "../escape",
            "future_field": {"enabled": True},
        },
    )

    write_job_atomic(paths, job)
    payload = json.loads((paths.jobs_dir / f"{job.id}.json").read_text())
    restored = read_job(paths, job.id)

    assert payload["id"] == job.id
    assert payload["state"] == "planned"
    assert payload["future_field"] == {"enabled": True}
    assert restored.extra == {"future_field": {"enabled": True}}
