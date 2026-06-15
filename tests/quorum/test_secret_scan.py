import json
from dataclasses import replace
from pathlib import Path

from quorum.managed_commands import create_job
from quorum.managed_state import discover_managed_paths, read_job, write_job_atomic
from quorum.runtime_env import TargetProfile
from quorum.secret_scan import (
    build_secret_patterns,
    scan_job_artifacts,
    scan_path_for_secrets,
    taint_job_on_secret_match,
)


def test_exact_profile_secret_is_detected_in_nested_artifact_file(tmp_path):
    secret = "target-secret-value-123"
    artifacts = tmp_path / "artifacts"
    nested = artifacts / "run-1" / "gauntlet-agent" / "results"
    nested.mkdir(parents=True)
    transcript = nested / "transcript.txt"
    prefix = b"before "
    transcript.write_bytes(prefix + secret.encode() + b" after")
    profile = TargetProfile(
        target="claude",
        path=tmp_path / "profiles" / "claude.env",
        env={"ANTHROPIC_API_KEY": secret},
    )

    result = scan_path_for_secrets(artifacts, build_secret_patterns(profile))

    assert len(result.matches) == 1
    match = result.matches[0]
    assert match.path == str(transcript)
    assert match.offset == len(prefix)
    assert match.pattern == "ANTHROPIC_API_KEY"
    assert match.digest.startswith("sha256:")
    assert secret not in json.dumps(result.to_json(), sort_keys=True)


def test_provider_pattern_is_detected_without_profile_value(tmp_path):
    leaked_key = "sk-ant-api03-" + ("A" * 32)
    artifact = tmp_path / "stdout.txt"
    artifact.write_text(f"provider wrote {leaked_key}\n")
    profile = TargetProfile(target="claude", path=None, env={})

    result = scan_path_for_secrets(artifact, build_secret_patterns(profile))

    assert len(result.matches) == 1
    assert result.matches[0].pattern == "anthropic-api-key"
    assert leaked_key not in json.dumps(result.to_json(), sort_keys=True)


def test_large_text_artifact_is_scanned_in_chunks(tmp_path):
    secret = "large-artifact-secret-123"
    artifact = tmp_path / "large-transcript.txt"
    artifact.write_bytes((b"x" * (1024 * 1024 + 32)) + secret.encode())
    profile = TargetProfile(target="claude", path=None, env={"ANTHROPIC_API_KEY": secret})

    result = scan_path_for_secrets(artifact, build_secret_patterns(profile))

    assert len(result.matches) == 1
    assert result.matches[0].path == str(artifact)
    assert result.matches[0].offset == 1024 * 1024 + 32
    assert secret not in json.dumps(result.to_json(), sort_keys=True)


def test_non_secret_profile_values_are_not_exact_match_patterns(tmp_path):
    value = "claude-3-5-sonnet"
    artifact = tmp_path / "stdout.txt"
    artifact.write_text(value)
    profile = TargetProfile(
        target="claude",
        path=None,
        env={"ANTHROPIC_MODEL": value, "ANTHROPIC_API_KEY": "target-secret-value"},
    )

    result = scan_path_for_secrets(artifact, build_secret_patterns(profile))

    assert result.matches == []


def test_scan_job_artifacts_scans_recorded_run_and_batch_dirs(tmp_path):
    secret = "job-artifact-secret-123"
    paths = discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )
    run_dir = paths.artifact_root / "scenario-claude-x"
    batch_dir = paths.artifact_root / "batches" / "batch-x"
    (run_dir / "gauntlet-agent").mkdir(parents=True)
    batch_dir.mkdir(parents=True)
    (run_dir / "gauntlet-agent" / "transcript.txt").write_text("clean\n")
    (batch_dir / "results.jsonl").write_text(f"{secret}\n")
    job = create_job("batch", None, [], paths, owner="drew", coding_agents=["claude"])
    job = replace(
        read_job(paths, job.id),
        children=[
            {
                "id": "batch",
                "kind": "batch",
                "batch_dir": str(batch_dir),
            },
            {
                "id": "child-0001",
                "kind": "run",
                "run_dir": str(run_dir),
            },
        ],
    )

    result = scan_job_artifacts(
        job,
        build_secret_patterns(
            TargetProfile(target="claude", path=None, env={"ANTHROPIC_API_KEY": secret})
        ),
    )

    assert [match.path for match in result.matches] == [str(batch_dir / "results.jsonl")]


def test_scan_job_artifacts_includes_job_metadata_and_durable_log(tmp_path):
    secret = "metadata-secret-value-123"
    paths = discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )
    job = create_job("unit", "claude", [], paths, owner="drew")
    log_path = Path(read_job(paths, job.id).log_path or "")
    log_path.parent.mkdir(parents=True)
    log_path.write_text(f"log leaked {secret}\n")
    write_job_atomic(
        paths,
        replace(read_job(paths, job.id), command=["quorum", "unit", secret]),
    )

    result = scan_job_artifacts(
        read_job(paths, job.id),
        build_secret_patterns(
            TargetProfile(target="claude", path=None, env={"ANTHROPIC_API_KEY": secret})
        ),
        paths,
    )

    match_paths = {match.path for match in result.matches}
    assert str(paths.jobs_dir / f"{job.id}.json") in match_paths
    assert str(log_path) in match_paths
    assert secret not in json.dumps(result.to_json(), sort_keys=True)


def test_taint_job_on_secret_match_marks_and_events_only_when_matches_exist(tmp_path):
    secret = "taint-secret-value-123"
    paths = discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )
    job = create_job("smoke", "claude", [], paths, owner="drew")
    clean_result = scan_path_for_secrets(
        tmp_path / "missing",
        build_secret_patterns(TargetProfile(target="claude", path=None, env={})),
    )

    unchanged = taint_job_on_secret_match(paths, job, clean_result)

    assert unchanged == job
    assert read_job(paths, job.id).tainted is False

    artifact = paths.artifact_root / "run" / "stdout.txt"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(secret)
    result = scan_path_for_secrets(
        paths.artifact_root,
        build_secret_patterns(
            TargetProfile(target="claude", path=None, env={"ANTHROPIC_API_KEY": secret})
        ),
    )

    tainted = taint_job_on_secret_match(paths, read_job(paths, job.id), result)

    assert tainted.state == "planned"
    assert tainted.tainted is True
    assert tainted.taint_reason == "secret-like material detected in managed artifacts"
    assert tainted.taint_matches == result.to_json()["matches"]
    events = (paths.events_dir / f"{job.id}.jsonl").read_text().splitlines()
    assert any(json.loads(line)["event"] == "job-tainted" for line in events)
    assert secret not in (paths.jobs_dir / f"{job.id}.json").read_text()
    assert secret not in (paths.events_dir / f"{job.id}.jsonl").read_text()


def test_worker_token_value_is_not_a_pattern_unless_in_target_profile(tmp_path):
    worker_token = "worker-token-not-provider-shaped"
    artifact = tmp_path / "worker.log"
    artifact.write_text(worker_token)

    no_profile_result = scan_path_for_secrets(
        artifact,
        build_secret_patterns(TargetProfile(target="claude", path=None, env={})),
    )
    profile_result = scan_path_for_secrets(
        artifact,
        build_secret_patterns(
            TargetProfile(target="claude", path=None, env={"SESSION_TOKEN": worker_token})
        ),
    )

    assert no_profile_result.matches == []
    assert len(profile_result.matches) == 1
    assert profile_result.matches[0].pattern == "SESSION_TOKEN"
