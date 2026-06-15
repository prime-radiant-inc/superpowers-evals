from pathlib import Path

import pytest

from quorum.managed_state import discover_managed_paths
from quorum.runtime_env import (
    TargetProfile,
    TargetProfileError,
    assert_raw_command_allowed,
    build_managed_env,
    is_managed_host,
    is_managed_worker,
    load_target_profile,
    redact_env_for_logs,
)


def test_managed_host_and_worker_flags_are_exact() -> None:
    assert is_managed_host({"QUORUM_MANAGED_HOST": "1"})
    assert not is_managed_host({"QUORUM_MANAGED_HOST": "true"})
    assert is_managed_worker({"QUORUM_MANAGED_WORKER": "1"})
    assert not is_managed_worker({"QUORUM_MANAGED_WORKER": "true"})


def test_load_target_profile_reads_shell_fragment(tmp_path: Path) -> None:
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    (profile_root / "claude.env").write_text(
        "# comment\n"
        "ANTHROPIC_API_KEY='sk-ant-test value'\n"
        "export ANTHROPIC_BASE_URL=https://anthropic.example\n"
    )

    profile = load_target_profile(profile_root, "claude")

    assert profile == TargetProfile(
        target="claude",
        path=profile_root / "claude.env",
        env={
            "ANTHROPIC_API_KEY": "sk-ant-test value",
            "ANTHROPIC_BASE_URL": "https://anthropic.example",
        },
    )


def test_load_target_profile_rejects_unsupported_lines(tmp_path: Path) -> None:
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    (profile_root / "claude.env").write_text("echo nope\n")

    with pytest.raises(TargetProfileError, match="unsupported"):
        load_target_profile(profile_root, "claude")


def test_build_managed_env_uses_profile_not_ambient_poison(tmp_path: Path) -> None:
    paths = discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )
    profile = TargetProfile(
        target="claude",
        path=tmp_path / "profiles" / "claude.env",
        env={"ANTHROPIC_API_KEY": "profile-key"},
    )

    env = build_managed_env(
        {
            "PATH": "/usr/bin",
            "HOME": "/home/quorum",
            "LANG": "C.UTF-8",
            "QUORUM_MANAGED_WORKER_TOKEN": "worker-secret",
            "OPENAI_API_KEY": "ambient-poison",
            "ANTHROPIC_API_KEY": "ambient-poison",
        },
        paths,
        profile,
        runtime_vars={"QUORUM_WORKDIR": "/work", "OPENAI_API_KEY": "runtime-value"},
    )

    assert env["PATH"] == "/usr/bin"
    assert env["HOME"] == "/home/quorum"
    assert env["QUORUM_ARTIFACT_ROOT"] == str(paths.artifact_root)
    assert env["QUORUM_STATE_ROOT"] == str(paths.state_root)
    assert env["ANTHROPIC_API_KEY"] == "profile-key"
    assert "QUORUM_MANAGED_WORKER_TOKEN" not in env
    assert "OPENAI_API_KEY" not in env
    assert env["QUORUM_WORKDIR"] == "/work"
    assert env["QUORUM_TARGET_ENV_KEYS"] == "ANTHROPIC_API_KEY"


def test_build_managed_env_keeps_controller_owned_paths(tmp_path: Path) -> None:
    paths = discover_managed_paths(
        {
            "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            "QUORUM_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        }
    )
    profile = TargetProfile(
        target="claude",
        path=tmp_path / "profiles" / "claude.env",
        env={"ANTHROPIC_API_KEY": "profile-key"},
    )

    env = build_managed_env(
        {"PATH": "/usr/bin"},
        paths,
        profile,
        runtime_vars={
            "QUORUM_STATE_ROOT": "/tmp/evil-state",
            "QUORUM_ARTIFACT_ROOT": "/tmp/evil-artifacts",
            "QUORUM_TARGET": "evil",
            "QUORUM_TARGET_ENV_KEYS": "OPENAI_API_KEY",
            "QUORUM_WORKDIR": "/work",
        },
    )

    assert env["QUORUM_STATE_ROOT"] == str(paths.state_root)
    assert env["QUORUM_ARTIFACT_ROOT"] == str(paths.artifact_root)
    assert env["QUORUM_TARGET"] == "claude"
    assert env["QUORUM_TARGET_ENV_KEYS"] == "ANTHROPIC_API_KEY"
    assert env["QUORUM_WORKDIR"] == "/work"


def test_redact_env_for_logs_preserves_keys() -> None:
    assert redact_env_for_logs({"OPENAI_API_KEY": "sk-test", "PATH": "/bin"}) == {
        "OPENAI_API_KEY": "[redacted]",
        "PATH": "[redacted]",
    }


def test_raw_command_gate_blocks_host_without_worker() -> None:
    with pytest.raises(PermissionError, match="raw live eval commands are disabled"):
        assert_raw_command_allowed("run", {"QUORUM_MANAGED_HOST": "1"})


def test_raw_command_gate_blocks_worker_flag_without_token(tmp_path: Path) -> None:
    with pytest.raises(PermissionError, match="raw live eval commands are disabled"):
        assert_raw_command_allowed(
            "run",
            {
                "QUORUM_MANAGED_HOST": "1",
                "QUORUM_MANAGED_WORKER": "1",
                "QUORUM_STATE_ROOT": str(tmp_path / "state"),
            },
        )


def test_raw_command_gate_rejects_caller_controlled_state_root_token(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    state_root.mkdir()
    token_file = state_root / "worker-token"
    token_file.write_text("worker-secret\n")
    token_file.chmod(0o600)

    with pytest.raises(PermissionError, match="raw live eval commands are disabled"):
        assert_raw_command_allowed(
            "run",
            {
                "QUORUM_MANAGED_HOST": "1",
                "QUORUM_MANAGED_WORKER": "1",
                "QUORUM_MANAGED_WORKER_TOKEN": "worker-secret",
                "QUORUM_STATE_ROOT": str(state_root),
            },
        )


def test_raw_command_gate_allows_worker_with_matching_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_root = tmp_path / "state"
    state_root.mkdir()
    token_file = state_root / "worker-token"
    token_file.write_text("worker-secret\n")
    token_file.chmod(0o600)
    monkeypatch.setattr("quorum.runtime_env.MANAGED_WORKER_TOKEN_PATH", token_file)

    assert_raw_command_allowed(
        "run",
        {
            "QUORUM_MANAGED_HOST": "1",
            "QUORUM_MANAGED_WORKER": "1",
            "QUORUM_MANAGED_WORKER_TOKEN": "worker-secret",
        },
    )
