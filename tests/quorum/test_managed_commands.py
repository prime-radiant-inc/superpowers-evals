import json
import subprocess
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from click.testing import CliRunner

import quorum.managed_commands as managed_commands
from quorum.cli import main
from quorum.managed_state import (
    ManagedJob,
    append_event,
    discover_managed_paths,
    mark_job_state,
    read_job,
    write_job_atomic,
)


def _paths(tmp_path):
    return discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )


def _env(paths):
    return {
        "QUORUM_STATE_ROOT": str(paths.state_root),
        "QUORUM_ARTIFACT_ROOT": str(paths.artifact_root),
    }


def _job(
    job_id: str,
    *,
    state: str,
    created_at: datetime,
    updated_at: datetime | None = None,
    children: list[dict[str, object]] | None = None,
) -> ManagedJob:
    return ManagedJob(
        id=job_id,
        state=state,
        created_at=created_at,
        updated_at=updated_at or created_at,
        command=["quorum", "unit", "claude"],
        managed_command="unit",
        coding_agents=["claude"],
        children=children or [],
    )


def _events(paths, job_id):
    event_path = paths.events_dir / f"{job_id}.jsonl"
    return [json.loads(line) for line in event_path.read_text().splitlines()]


def test_create_job_writes_planned_state_and_creation_event(tmp_path):
    paths = _paths(tmp_path)

    job = managed_commands.create_job(
        "smoke",
        "claude",
        ["--jobs", "1"],
        paths,
        owner="drew",
    )

    stored = read_job(paths, job.id)
    assert stored.state == "planned"
    assert stored.owner == "drew"
    assert stored.host
    assert stored.managed_command == "smoke"
    assert stored.command == ["quorum", "smoke", "claude", "--jobs", "1"]
    assert stored.coding_agents == ["claude"]
    assert stored.out_root == str(paths.artifact_root)
    assert stored.log_path == str(paths.state_root / "logs" / f"{job.id}.log")

    [event] = _events(paths, job.id)
    assert event["event"] == "job-created"
    assert event["job_id"] == job.id
    assert event["state"] == "planned"


def test_inline_supervisor_runs_worker_and_marks_job_succeeded(tmp_path, monkeypatch):
    paths = _paths(tmp_path)

    def executor(job, worker_paths, env):
        assert worker_paths == paths
        assert env["QUORUM_MANAGED_WORKER"] == "1"
        assert read_job(paths, job.id).state == "running"
        append_event(paths, job.id, {"event": "unit-executor-ran"})
        return 0

    monkeypatch.setitem(managed_commands.WORKER_EXECUTORS, "unit", executor)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    result = managed_commands.start_job(
        job,
        paths,
        managed_commands.InlineSupervisor(env=_env(paths)),
    )

    assert result.exit_code == 0
    stored = read_job(paths, job.id)
    assert stored.state == "succeeded"
    assert stored.started_at is not None
    assert stored.finished_at is not None
    assert stored.final_exit_code == 0
    assert stored.supervisor is not None
    assert stored.supervisor["kind"] == "inline"
    assert [event["event"] for event in _events(paths, job.id)] == [
        "job-created",
        "job-started",
        "worker-started",
        "unit-executor-ran",
        "worker-succeeded",
    ]


def test_worker_marks_failed_with_exit_code_when_executor_raises(tmp_path, monkeypatch):
    paths = _paths(tmp_path)

    def executor(job, worker_paths, env):
        raise subprocess.CalledProcessError(17, job.command, stderr="child exploded")

    monkeypatch.setitem(managed_commands.WORKER_EXECUTORS, "unit", executor)
    job = managed_commands.create_job("unit", None, [], paths, owner="drew")

    exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))

    assert exit_code == 17
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    assert stored.final_exit_code == 17
    assert "child exploded" in (stored.failure_reason or "")


def test_worker_fails_unknown_job_kind_with_clear_reason(tmp_path):
    paths = _paths(tmp_path)
    job = managed_commands.create_job("future-kind", "claude", [], paths, owner="drew")

    exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))

    assert exit_code == 2
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    assert "future-kind" in (stored.failure_reason or "")
    assert "not implemented" in (stored.failure_reason or "")


def test_tmux_supervisor_uses_phase_one_worker_command(tmp_path):
    paths = _paths(tmp_path)
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0)

    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    result = managed_commands.start_job(
        job,
        paths,
        managed_commands.TmuxSupervisor(runner=runner),
    )

    assert result.exit_code is None
    log_path = paths.state_root / "logs" / f"{job.id}.log"
    assert calls == [
        (
            [
                "tmux",
                "new-session",
                "-d",
                "-s",
                f"quorum-{job.id}",
                "--",
                "sh",
                "-c",
                'exec >> "$1" 2>&1; shift; exec "$@"',
                "quorum-managed-worker",
                str(log_path),
                "env",
                "QUORUM_MANAGED_WORKER=1",
                f"QUORUM_STATE_ROOT={paths.state_root}",
                f"QUORUM_ARTIFACT_ROOT={paths.artifact_root}",
                "uv",
                "run",
                "quorum",
                "managed-worker",
                job.id,
            ],
            {"check": True, "text": True},
        )
    ]
    assert log_path.parent.is_dir()
    assert log_path.read_text() == ""


def test_tmux_supervisor_does_not_interpolate_paths_into_shell_wrapper(tmp_path):
    paths = _paths(tmp_path)
    calls = []

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0)

    job = managed_commands.create_job(
        "unit",
        "claude",
        [],
        paths,
        owner="drew",
    )

    managed_commands.start_job(
        job,
        paths,
        managed_commands.TmuxSupervisor(runner=runner),
    )

    command = calls[0][0]
    shell_script = command[command.index("-c") + 1]
    assert str(paths.state_root) not in shell_script
    assert str(paths.artifact_root) not in shell_script
    assert str(paths.state_root / "logs" / f"{job.id}.log") not in shell_script


def test_start_job_marks_failed_when_supervisor_cannot_launch(tmp_path):
    paths = _paths(tmp_path)

    class BrokenSupervisor:
        def start(self, job, worker_paths, command):
            raise FileNotFoundError("tmux")

    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    result = managed_commands.start_job(job, paths, BrokenSupervisor())

    assert result.exit_code == 1
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    assert stored.final_exit_code == 1
    assert "tmux" in (stored.failure_reason or "")
    assert [event["event"] for event in _events(paths, job.id)] == [
        "job-created",
        "job-started",
        "job-start-failed",
    ]


def test_status_summary_sorts_active_before_terminal_jobs(tmp_path):
    paths = _paths(tmp_path)
    now = datetime(2026, 6, 12, 20, 0, tzinfo=UTC)
    terminal_old = _job(
        "job-20260612T200000Z-a111",
        state="succeeded",
        created_at=now,
        updated_at=now + timedelta(minutes=1),
    )
    running = _job(
        "job-20260612T200001Z-b222",
        state="running",
        created_at=now + timedelta(seconds=1),
        updated_at=now + timedelta(seconds=2),
    )
    planned = _job(
        "job-20260612T200002Z-c333",
        state="planned",
        created_at=now + timedelta(seconds=2),
        updated_at=now + timedelta(seconds=3),
    )
    terminal_recent = _job(
        "job-20260612T200003Z-d444",
        state="failed",
        created_at=now + timedelta(seconds=3),
        updated_at=now + timedelta(minutes=2),
    )
    for job in [terminal_old, running, planned, terminal_recent]:
        write_job_atomic(paths, job)

    summary = managed_commands.status_summary(paths, limit=10, include_finished=True)

    assert [job.id for job in summary] == [
        planned.id,
        running.id,
        terminal_recent.id,
        terminal_old.id,
    ]


def test_status_json_is_parseable_and_contains_child_records(tmp_path):
    paths = _paths(tmp_path)
    job = managed_commands.create_job("unit", "codex", [], paths, owner="drew")
    write_job_atomic(
        paths,
        replace(
            job,
            children=[
                {
                    "id": "child-1",
                    "state": "succeeded",
                    "run_id": "scenario-codex-20260612T200000Z-abcd",
                }
            ],
        ),
    )

    result = CliRunner().invoke(main, ["status", job.id, "--json"], env=_env(paths))

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["id"] == job.id
    assert payload["children"] == [
        {
            "id": "child-1",
            "run_id": "scenario-codex-20260612T200000Z-abcd",
            "state": "succeeded",
        }
    ]


def test_tail_returns_parent_events_and_log_content(tmp_path):
    paths = _paths(tmp_path)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")
    append_event(paths, job.id, {"event": "custom", "message": "hello"})
    log_path = paths.state_root / "logs" / f"{job.id}.log"
    log_path.parent.mkdir(parents=True)
    log_path.write_text("stdout line\nstderr line\n")

    lines = list(managed_commands.tail_job(job.id, paths=paths))

    events = [json.loads(line) for line in lines if line.startswith("{")]
    assert [event["event"] for event in events] == ["job-created", "custom"]
    assert "stdout line\n" in lines
    assert "stderr line\n" in lines


def test_tail_returns_child_log_content_when_child_id_is_supplied(tmp_path):
    paths = _paths(tmp_path)
    child_log = tmp_path / "child.log"
    child_log.write_text("child line one\nchild line two\n")
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")
    write_job_atomic(
        paths,
        replace(
            job,
            children=[
                {
                    "id": "child-1",
                    "state": "running",
                    "log_path": str(child_log),
                }
            ],
        ),
    )

    assert list(managed_commands.tail_job(job.id, child_id="child-1", paths=paths)) == [
        "child line one\n",
        "child line two\n",
    ]


def test_hidden_managed_worker_command_is_callable_directly(tmp_path, monkeypatch):
    paths = _paths(tmp_path)

    def executor(job, worker_paths, env):
        return 0

    monkeypatch.setitem(managed_commands.WORKER_EXECUTORS, "unit", executor)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    result = CliRunner().invoke(
        main,
        ["managed-worker", job.id],
        env={**_env(paths), "QUORUM_MANAGED_WORKER": "1"},
    )

    assert result.exit_code == 0, result.output
    assert read_job(paths, job.id).state == "succeeded"


def test_hidden_managed_worker_command_requires_worker_env_marker(tmp_path):
    paths = _paths(tmp_path)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    result = CliRunner().invoke(main, ["managed-worker", job.id], env=_env(paths))

    assert result.exit_code == 2
    assert "managed supervisor" in result.output
    assert read_job(paths, job.id).state == "planned"


def test_status_can_hide_finished_jobs(tmp_path):
    paths = _paths(tmp_path)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")
    mark_job_state(paths, job.id, "succeeded", final_exit_code=0)

    result = CliRunner().invoke(main, ["status", "--active-only", "--json"], env=_env(paths))

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == []
