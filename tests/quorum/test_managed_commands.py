import json
import subprocess
import threading
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from click.testing import CliRunner

import quorum.managed_commands as managed_commands
from quorum.cli import main
from quorum.composer import FinalVerdict, GauntletLayer
from quorum.locks import (
    LockConflict,
    LockRequest,
    acquire_locks,
    read_active_cooldowns,
    release_locks,
)
from quorum.managed_state import (
    ManagedJob,
    append_event,
    discover_managed_paths,
    mark_job_state,
    mark_job_tainted,
    read_job,
    write_job_atomic,
)
from quorum.run_all import ChildResult, MatrixEntry


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
    children: list[Mapping[str, object]] | None = None,
) -> ManagedJob:
    return ManagedJob(
        id=job_id,
        state=state,
        created_at=created_at,
        updated_at=updated_at or created_at,
        command=["quorum", "unit", "claude"],
        managed_command="unit",
        coding_agents=["claude"],
        children=list(children) if children is not None else [],
    )


def _events(paths, job_id):
    event_path = paths.events_dir / f"{job_id}.jsonl"
    return [json.loads(line) for line in event_path.read_text().splitlines()]


def _pass_verdict(final: Literal["pass", "fail", "indeterminate"] = "pass") -> FinalVerdict:
    return FinalVerdict(
        final=final,
        final_reason=f"{final} reason",
        gauntlet=GauntletLayer(status="pass", summary="ok", reasoning="ok"),
        checks=[],
        error=None,
    )


def _scenario(root: Path, name: str = "00-quorum-smoke-hello-world") -> Path:
    scenario = root / name
    scenario.mkdir(parents=True)
    (scenario / "story.md").write_text("---\nid: smoke\nstatus: draft\ntags: smoke\n---\n")
    (scenario / "setup.sh").write_text("true\n")
    (scenario / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    return scenario


def _agent(root: Path, name: str = "claude") -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.yaml").write_text(f"name: {name}\nbinary: echo\n")


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


def test_worker_marks_job_failed_and_tainted_when_final_scan_finds_secret(
    tmp_path, monkeypatch
):
    paths = _paths(tmp_path)
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    secret = "target-secret-value-456"
    (profile_root / "claude.env").write_text(f"ANTHROPIC_API_KEY={secret}\n")

    def executor(job, worker_paths, env):
        del env
        run_dir = worker_paths.artifact_root / "unit-claude-x"
        run_dir.mkdir(parents=True)
        (run_dir / "stdout.txt").write_text(f"leaked {secret}\n")
        managed_commands._upsert_child(
            worker_paths,
            job.id,
            {
                "id": "child-0001",
                "kind": "run",
                "run_dir": str(run_dir),
                "state": "finished",
                "final": "pass",
            },
        )
        return 0

    monkeypatch.setitem(managed_commands.WORKER_EXECUTORS, "unit", executor)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    exit_code = managed_commands.run_managed_worker(
        job.id,
        paths,
        {**_env(paths), "QUORUM_TARGET_PROFILE_ROOT": str(profile_root)},
    )

    assert exit_code == 1
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    assert stored.final_exit_code == 1
    assert stored.failure_reason == "secret-like material detected in managed artifacts"
    assert stored.tainted is True
    assert stored.taint_matches == [
        {
            "path": str(paths.artifact_root / "unit-claude-x" / "stdout.txt"),
            "offset": len("leaked "),
            "pattern": "ANTHROPIC_API_KEY",
            "digest": stored.taint_matches[0]["digest"],
        }
    ]
    assert secret not in json.dumps(stored.taint_matches, sort_keys=True)
    assert [event["event"] for event in _events(paths, job.id)][-2:] == [
        "job-tainted",
        "worker-tainted",
    ]


def test_worker_final_scan_leaves_clean_artifacts_unchanged(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    (profile_root / "claude.env").write_text("ANTHROPIC_API_KEY=target-secret-value-789\n")

    def executor(job, worker_paths, env):
        del env
        run_dir = worker_paths.artifact_root / "unit-claude-clean"
        run_dir.mkdir(parents=True)
        (run_dir / "stdout.txt").write_text("clean artifact\n")
        managed_commands._upsert_child(
            worker_paths,
            job.id,
            {
                "id": "child-0001",
                "kind": "run",
                "run_dir": str(run_dir),
                "state": "finished",
                "final": "pass",
            },
        )
        return 0

    monkeypatch.setitem(managed_commands.WORKER_EXECUTORS, "unit", executor)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    exit_code = managed_commands.run_managed_worker(
        job.id,
        paths,
        {**_env(paths), "QUORUM_TARGET_PROFILE_ROOT": str(profile_root)},
    )

    assert exit_code == 0
    stored = read_job(paths, job.id)
    assert stored.state == "succeeded"
    assert stored.final_exit_code == 0
    assert stored.tainted is False
    assert stored.taint_matches == []
    assert "job-tainted" not in [event["event"] for event in _events(paths, job.id)]


def test_worker_token_value_is_not_used_as_secret_scan_pattern(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    worker_token = "worker-token-not-provider-shaped"

    def executor(job, worker_paths, env):
        assert env["QUORUM_MANAGED_WORKER_TOKEN"] == worker_token
        run_dir = worker_paths.artifact_root / "unit-claude-worker-token"
        run_dir.mkdir(parents=True)
        (run_dir / "stdout.txt").write_text(worker_token)
        managed_commands._upsert_child(
            worker_paths,
            job.id,
            {
                "id": "child-0001",
                "kind": "run",
                "run_dir": str(run_dir),
                "state": "finished",
                "final": "pass",
            },
        )
        return 0

    monkeypatch.setitem(managed_commands.WORKER_EXECUTORS, "unit", executor)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    exit_code = managed_commands.run_managed_worker(
        job.id,
        paths,
        {**_env(paths), "QUORUM_MANAGED_WORKER_TOKEN": worker_token},
    )

    stored = read_job(paths, job.id)
    assert exit_code == 0
    assert stored.state == "succeeded"
    assert stored.tainted is False
    assert stored.taint_matches == []
    assert worker_token not in (paths.jobs_dir / f"{job.id}.json").read_text()


def test_record_child_finished_taints_job_when_child_artifact_leaks_secret(tmp_path):
    paths = _paths(tmp_path)
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    secret = "child-artifact-secret-123"
    (profile_root / "claude.env").write_text(f"ANTHROPIC_API_KEY={secret}\n")
    run_dir = paths.artifact_root / "scenario-claude-x"
    run_dir.mkdir(parents=True)
    (run_dir / "stdout.txt").write_text(secret)
    job = managed_commands.create_job(
        "batch",
        None,
        [],
        paths,
        owner="drew",
        coding_agents=["claude"],
    )
    mark_job_state(paths, job.id, "running")

    tainted = managed_commands._record_child_finished(
        paths,
        job.id,
        "child-0001",
        ChildResult(run_id=run_dir.name, exit_code=0, error=None),
        artifact_root=paths.artifact_root,
        batch={},
        secret_patterns=managed_commands._secret_patterns_for_job(
            job,
            {**_env(paths), "QUORUM_TARGET_PROFILE_ROOT": str(profile_root)},
        ),
        lock=threading.Lock(),
    )

    stored = read_job(paths, job.id)
    assert tainted is True
    assert stored.state == "running"
    assert stored.tainted is True
    assert stored.taint_matches[0]["path"] == str(run_dir / "stdout.txt")
    assert secret not in (paths.jobs_dir / f"{job.id}.json").read_text()
    assert secret not in (paths.events_dir / f"{job.id}.jsonl").read_text()


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
        managed_commands.TmuxSupervisor(runner=runner, env={}),
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
                "sh",
                "-c",
                managed_commands.WORKER_TOKEN_WRAPPER,
                "quorum-managed-worker-token",
                str(managed_commands.runtime_env.MANAGED_WORKER_TOKEN_PATH),
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


def test_tmux_supervisor_hands_control_env_without_leaking_worker_token(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    calls = []
    token_path = tmp_path / "worker-token"
    monkeypatch.setattr(managed_commands.runtime_env, "MANAGED_WORKER_TOKEN_PATH", token_path)
    secret = "worker-secret-value"

    def runner(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0)

    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")

    managed_commands.start_job(
        job,
        paths,
        managed_commands.TmuxSupervisor(
            runner=runner,
            env={
                "QUORUM_MANAGED_HOST": "1",
                "QUORUM_TARGET_PROFILE_ROOT": str(tmp_path / "profiles"),
                "QUORUM_MANAGED_WORKER_TOKEN": secret,
                "SUPERPOWERS_ROOT": str(tmp_path / "superpowers"),
            },
        ),
    )

    command = calls[0][0]
    assert "QUORUM_MANAGED_HOST=1" in command
    assert f"QUORUM_TARGET_PROFILE_ROOT={tmp_path / 'profiles'}" in command
    assert f"SUPERPOWERS_ROOT={tmp_path / 'superpowers'}" in command
    assert str(token_path) in command
    assert secret not in command
    assert secret not in json.dumps(_events(paths, job.id))
    assert secret not in (paths.jobs_dir / f"{job.id}.json").read_text()


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
        def start(self, job, paths, command):
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


def test_status_text_surfaces_tainted_jobs(tmp_path):
    paths = _paths(tmp_path)
    job = managed_commands.create_job("unit", "claude", [], paths, owner="drew")
    mark_job_state(
        paths,
        job.id,
        "failed",
        final_exit_code=1,
        failure_reason="secret-like material detected in managed artifacts",
    )
    mark_job_tainted(
        paths,
        job.id,
        "secret-like material detected in managed artifacts",
        [{"path": "run/stdout.txt", "offset": 0, "pattern": "ANTHROPIC_API_KEY"}],
    )

    detail = CliRunner().invoke(main, ["status", job.id], env=_env(paths))
    summary = CliRunner().invoke(main, ["status"], env=_env(paths))

    assert detail.exit_code == 0, detail.output
    assert "tainted: true" in detail.output
    assert "taint_reason: secret-like material detected in managed artifacts" in detail.output
    assert summary.exit_code == 0, summary.output
    assert "tainted" in summary.output


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


def test_smoke_executor_records_run_child_before_completion(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    _scenario(scenarios_root)
    _agent(coding_agents_dir, "claude")
    job = managed_commands.create_job(
        "smoke",
        "claude",
        [
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
    )
    observed_children_during_run = []

    def fake_run_scenario_in_dir(**kwargs):
        stored = read_job(paths, job.id)
        observed_children_during_run.extend(stored.children)
        assert kwargs["run_dir"].parent == paths.artifact_root
        assert kwargs["run_dir"].name.startswith("00-quorum-smoke-hello-world-claude-")
        assert kwargs["scenario_dir"] == scenarios_root / "00-quorum-smoke-hello-world"
        assert kwargs["coding_agent"] == "claude"
        assert kwargs["env_base"]["QUORUM_TARGET"] == "claude"
        assert "QUORUM_MANAGED_WORKER_TOKEN" not in kwargs["env_base"]
        return kwargs["run_dir"], _pass_verdict("fail")

    monkeypatch.setattr(managed_commands, "run_scenario_in_dir", fake_run_scenario_in_dir)

    worker_env = {**_env(paths), "QUORUM_MANAGED_WORKER_TOKEN": "worker-secret"}

    exit_code = managed_commands.run_managed_worker(job.id, paths, worker_env)

    assert exit_code == 0
    stored = read_job(paths, job.id)
    serialized_job = (paths.jobs_dir / f"{job.id}.json").read_text(encoding="utf-8")
    assert "worker-secret" not in serialized_job
    assert "worker-secret" not in json.dumps(_events(paths, job.id), sort_keys=True)
    assert stored.state == "succeeded"
    assert observed_children_during_run[0]["state"] == "running"
    assert observed_children_during_run[0]["run_dir"].startswith(str(paths.artifact_root))
    run_id = Path(observed_children_during_run[0]["run_dir"]).name
    assert stored.children == [
        {
            "id": "child-0001",
            "kind": "run",
            "target": "claude",
            "coding_agent": "claude",
            "scenario": "00-quorum-smoke-hello-world",
            "run_id": run_id,
            "run_dir": str(paths.artifact_root / run_id),
            "state": "finished",
            "final": "fail",
        }
    ]
    assert stored.result_rollup == {"final": "fail", "total": 1, "passed": 0, "failed": 1}
    assert sorted(stored.locks) == ["global:active", "provider:anthropic", "target:claude"]


def test_column_executor_calls_run_batch_and_rolls_up_child_results(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    scenario_dir = _scenario(scenarios_root, "triggering-test-driven-development")
    _agent(coding_agents_dir, "claude")
    job = managed_commands.create_job(
        "column",
        "claude",
        [
            "--jobs",
            "2",
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
    )
    batch_dir = paths.artifact_root / "batches" / "batch-test"

    def fake_run_batch(**kwargs):
        assert kwargs["agent_filter"] == ["claude"]
        assert kwargs["jobs"] == 2
        assert kwargs["tier"] == "sentinel"
        assert kwargs["include_drafts"] is False
        assert kwargs["env_base"]["QUORUM_TARGET"] == "claude"
        kwargs["on_batch_allocated"](batch_dir)
        entry = MatrixEntry(
            scenario="triggering-test-driven-development",
            coding_agent="claude",
            scenario_dir=scenario_dir,
            skipped_reason=None,
            tier="sentinel",
            status="ready",
        )
        kwargs["on_child_started"](
            "child-0001",
            entry,
            ["uv", "run", "quorum", "run", str(scenario_dir)],
        )
        run_dir = paths.artifact_root / "triggering-test-driven-development-claude-x"
        run_dir.mkdir(parents=True)
        (run_dir / "verdict.json").write_text(json.dumps({"final": "indeterminate"}))
        kwargs["on_child_finished"](
            "child-0001",
            ChildResult(
                run_id="triggering-test-driven-development-claude-x",
                exit_code=2,
                error=None,
            ),
        )
        return batch_dir

    monkeypatch.setattr(managed_commands, "run_batch", fake_run_batch)

    exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))

    assert exit_code == 0
    stored = read_job(paths, job.id)
    assert stored.state == "succeeded"
    assert stored.result_rollup == {
        "final": "indeterminate",
        "total": 1,
        "passed": 0,
        "failed": 0,
        "indeterminate": 1,
    }
    run_children = [child for child in stored.children if child["kind"] == "run"]
    assert run_children == [
        {
            "id": "child-0001",
            "kind": "run",
            "target": "claude",
            "coding_agent": "claude",
            "scenario": "triggering-test-driven-development",
            "command": ["uv", "run", "quorum", "run", str(scenario_dir)],
            "batch_id": "batch-test",
            "batch_dir": str(batch_dir),
            "run_id": "triggering-test-driven-development-claude-x",
            "run_dir": str(paths.artifact_root / "triggering-test-driven-development-claude-x"),
            "state": "finished",
            "final": "indeterminate",
        }
    ]
    batch_children = [child for child in stored.children if child["kind"] == "batch"]
    assert batch_children == [
        {
            "id": "batch",
            "kind": "batch",
            "batch_id": "batch-test",
            "batch_dir": str(batch_dir),
            "state": "finished",
        }
    ]


def test_column_executor_taints_job_and_aborts_after_child_secret_leak(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    secret = "column-child-secret-123"
    (profile_root / "claude.env").write_text(f"ANTHROPIC_API_KEY={secret}\n")
    alpha = _scenario(scenarios_root, "alpha")
    beta = _scenario(scenarios_root, "beta")
    _agent(coding_agents_dir, "claude")
    job = managed_commands.create_job(
        "column",
        "claude",
        [
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
    )
    batch_dir = paths.artifact_root / "batches" / "batch-tainted"

    def fake_run_batch(**kwargs):
        abort_event = kwargs["abort_event"]
        assert abort_event.is_set() is False
        kwargs["on_batch_allocated"](batch_dir)
        alpha_entry = MatrixEntry(
            scenario="alpha",
            coding_agent="claude",
            scenario_dir=alpha,
            skipped_reason=None,
            tier="sentinel",
            status="ready",
        )
        kwargs["on_child_started"]("child-0001", alpha_entry, ["uv", "run", "quorum", "run"])
        run_id = "alpha-claude-x"
        run_dir = paths.artifact_root / run_id
        run_dir.mkdir(parents=True)
        (run_dir / "verdict.json").write_text(json.dumps({"final": "pass"}))
        (run_dir / "stdout.txt").write_text(secret)
        kwargs["on_child_finished"](
            "child-0001",
            ChildResult(run_id=run_id, exit_code=0, error=None),
        )
        assert abort_event.is_set() is True
        beta_entry = MatrixEntry(
            scenario="beta",
            coding_agent="claude",
            scenario_dir=beta,
            skipped_reason=None,
            tier="sentinel",
            status="ready",
        )
        kwargs["on_child_started"]("child-0002", beta_entry, ["uv", "run", "quorum", "run"])
        kwargs["on_child_finished"](
            "child-0002",
            ChildResult(run_id=None, exit_code=0, error=managed_commands.ABORT_SKIP_SENTINEL),
        )
        return batch_dir

    monkeypatch.setattr(managed_commands, "run_batch", fake_run_batch)

    exit_code = managed_commands.run_managed_worker(
        job.id,
        paths,
        {**_env(paths), "QUORUM_TARGET_PROFILE_ROOT": str(profile_root)},
    )

    assert exit_code == 1
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    assert stored.final_exit_code == 1
    assert stored.tainted is True
    assert stored.taint_matches[0]["path"] == str(
        paths.artifact_root / "alpha-claude-x" / "stdout.txt"
    )
    run_children = [child for child in stored.children if child["kind"] == "run"]
    assert run_children[0]["state"] == "finished"
    assert run_children[1]["state"] == "skipped"
    assert run_children[1]["skipped"] == "aborted"
    assert secret not in (paths.jobs_dir / f"{job.id}.json").read_text()
    assert secret not in (paths.events_dir / f"{job.id}.jsonl").read_text()


def test_column_executor_records_children_under_configured_out_root(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    custom_out_root = tmp_path / "custom-results"
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    scenario_dir = _scenario(scenarios_root, "alpha")
    _agent(coding_agents_dir, "claude")
    job = managed_commands.create_job(
        "column",
        "claude",
        [
            "--out-root",
            str(custom_out_root),
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
    )

    def fake_run_batch(**kwargs):
        assert kwargs["out_root"] == custom_out_root.resolve()
        batch_dir = custom_out_root.resolve() / "batches" / "batch-custom"
        kwargs["on_batch_allocated"](batch_dir)
        entry = MatrixEntry(
            scenario="alpha",
            coding_agent="claude",
            scenario_dir=scenario_dir,
            skipped_reason=None,
            tier="sentinel",
            status="ready",
        )
        kwargs["on_child_started"]("child-0001", entry, ["uv", "run", "quorum", "run"])
        run_id = "alpha-claude-x"
        run_dir = custom_out_root.resolve() / run_id
        run_dir.mkdir(parents=True)
        (run_dir / "verdict.json").write_text(json.dumps({"final": "pass"}))
        kwargs["on_child_finished"](
            "child-0001",
            ChildResult(run_id=run_id, exit_code=0, error=None),
        )
        return batch_dir

    monkeypatch.setattr(managed_commands, "run_batch", fake_run_batch)

    exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))

    assert exit_code == 0
    stored = read_job(paths, job.id)
    run_child = next(child for child in stored.children if child.get("kind") == "run")
    assert run_child["run_dir"] == str(custom_out_root.resolve() / "alpha-claude-x")
    assert stored.result_rollup == {"final": "pass", "total": 1, "passed": 1, "failed": 0}


def test_worker_records_lock_conflict_event(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    _scenario(scenarios_root)
    _agent(coding_agents_dir, "claude")
    job = managed_commands.create_job(
        "smoke",
        "claude",
        [
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
    )

    def fake_acquire_locks(paths_arg, requests, job_id, command, wait=False):
        del requests
        raise LockConflict(
            lock_name="target:claude",
            lock_path=paths_arg.locks_dir / "target:claude.lock",
            holder=None,
            requested_job_id=job_id,
            command=command,
            wait=wait,
        )

    monkeypatch.setattr(managed_commands, "acquire_locks", fake_acquire_locks)

    exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))

    assert exit_code == 1
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    events = _events(paths, job.id)
    conflict = next(event for event in events if event["event"] == "lock-conflict")
    assert conflict["lock_name"] == "target:claude"
    assert conflict["conflict"]["error"] == "lock-conflict"
    assert conflict["conflict"]["requested_job_id"] == job.id


def test_worker_global_active_lock_blocks_disjoint_target(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    _scenario(scenarios_root)
    _agent(coding_agents_dir, "claude")
    job = managed_commands.create_job(
        "smoke",
        "claude",
        [
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
    )
    held = acquire_locks(
        paths,
        [LockRequest("global:active")],
        "job-20260612T230000Z-a111",
        ["quorum", "smoke", "gemini"],
    )

    def fake_run_scenario_in_dir(**_kwargs):
        return paths.artifact_root / "unused", _pass_verdict("pass")

    monkeypatch.setattr(managed_commands, "run_scenario_in_dir", fake_run_scenario_in_dir)
    try:
        exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))
    finally:
        release_locks(held)

    assert exit_code == 1
    stored = read_job(paths, job.id)
    assert stored.state == "failed"
    conflict = next(event for event in _events(paths, job.id) if event["event"] == "lock-conflict")
    assert conflict["lock_name"] == "global:active"


def test_batch_executor_preserves_rate_limit_skip_and_writes_cooldown(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    scenarios_root = tmp_path / "scenarios"
    coding_agents_dir = tmp_path / "coding-agents"
    scenario_dir = _scenario(scenarios_root, "alpha")
    _agent(coding_agents_dir, "antigravity")
    job = managed_commands.create_job(
        "batch",
        None,
        [
            "--coding-agents",
            "antigravity",
            "--scenarios-root",
            str(scenarios_root),
            "--coding-agents-dir",
            str(coding_agents_dir),
        ],
        paths,
        owner="drew",
        coding_agents=["antigravity"],
    )
    batch_dir = paths.artifact_root / "batches" / "batch-rate-limit"

    def fake_run_batch(**kwargs):
        kwargs["on_batch_allocated"](batch_dir)
        entry = MatrixEntry(
            scenario="alpha",
            coding_agent="antigravity",
            scenario_dir=scenario_dir,
            skipped_reason=None,
            tier="sentinel",
            status="ready",
        )
        kwargs["on_child_started"]("child-0001", entry, ["uv", "run", "quorum", "run"])
        run_id = "alpha-antigravity-x"
        run_dir = paths.artifact_root / run_id
        run_dir.mkdir(parents=True)
        (run_dir / "verdict.json").write_text(
            json.dumps(
                {
                    "final": "indeterminate",
                    "error": {"message": "Code Assist rate limit: throttled"},
                }
            )
        )
        kwargs["on_child_finished"](
            "child-0001",
            ChildResult(run_id=run_id, exit_code=2, error=None),
        )
        kwargs["on_child_finished"](
            "child-0002",
            ChildResult(run_id=None, exit_code=0, error="agy-rate-limit-skip"),
        )
        return batch_dir

    monkeypatch.setattr(managed_commands, "run_batch", fake_run_batch)

    exit_code = managed_commands.run_managed_worker(job.id, paths, _env(paths))

    assert exit_code == 0
    stored = read_job(paths, job.id)
    assert stored.result_rollup is not None
    assert stored.result_rollup["final"] == "indeterminate"
    run_children = [child for child in stored.children if child["kind"] == "run"]
    assert run_children[0]["final"] == "indeterminate"
    assert run_children[1]["state"] == "skipped"
    assert run_children[1]["skipped"] == "rate-limited"
    cooldowns = read_active_cooldowns(paths, datetime.now(UTC))
    assert [(cooldown.provider, cooldown.reason) for cooldown in cooldowns] == [
        ("gemini", "Code Assist rate limit")
    ]
    assert stored.extra["cooldowns"] == [
        {
            "provider": "gemini",
            "reason": "Code Assist rate limit",
            "source_child_id": "child-0001",
            "source_job_id": job.id,
            "source_run_id": "alpha-antigravity-x",
            "until": cooldowns[0].until.isoformat().replace("+00:00", "Z"),
        }
    ]
