import json
import os
from pathlib import Path
from typing import Any, cast

import pytest
import yaml

from quorum.doctor import DoctorPaths, DoctorStatus, run_all_doctors, run_target_doctor


def _write_agent(
    coding_agents_dir: Path,
    name: str = "gemini",
    *,
    binary: str = "demo-agent",
    runtime_family: str | None = None,
    required_env: list[str] | None = None,
) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "name": name,
        "binary": binary,
        "agent_config_env": f"{name.upper().replace('-', '_')}_HOME",
        "session_log_dir": f"${{{name.upper().replace('-', '_')}_HOME}}/sessions",
        "session_log_glob": "*.jsonl",
        "normalizer": "codex",
        "required_env": required_env or ["SUPERPOWERS_ROOT"],
    }
    if runtime_family is not None:
        doc["runtime_family"] = runtime_family
    (coding_agents_dir / f"{name}.yaml").write_text(yaml.safe_dump(doc))


def _write_tool(bin_dir: Path, name: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    tool = bin_dir / name
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)


def _write_context(coding_agents_dir: Path, runtime_family: str = "codex") -> None:
    context = coding_agents_dir / f"{runtime_family}-context"
    context.mkdir(parents=True, exist_ok=True)
    (context / "HOWTO.md").write_text("use the target\n")
    (context / "launch-agent").write_text("#!/bin/sh\nexec demo-agent\n")


def _write_sentinel(scenarios_root: Path, target: str = "codex") -> None:
    scenario = scenarios_root / "sentinel"
    scenario.mkdir(parents=True, exist_ok=True)
    scenario.joinpath("story.md").write_text(
        "---\nid: sentinel\nstatus: ready\nquorum_tier: sentinel\n---\nSentinel.\n"
    )
    scenario.joinpath("checks.sh").write_text(
        f"# coding-agents: {target}\npre() {{ :; }}\npost() {{ :; }}\n"
    )


def _write_superpowers_root(root: Path) -> None:
    required = {
        ".claude-plugin/plugin.json",
        ".kimi-plugin/plugin.json",
        ".opencode/plugins/superpowers.js",
        "GEMINI.md",
        "hooks/hooks.json",
        "hooks/run-hook.cmd",
        "hooks/session-start",
        "skills/brainstorming/SKILL.md",
        "skills/using-superpowers/SKILL.md",
        "skills/using-superpowers/references/copilot-tools.md",
        "skills/using-superpowers/references/gemini-tools.md",
        "skills/using-superpowers/references/pi-tools.md",
    }
    for rel in required:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n" if rel.endswith(".json") else "fixture\n")


def _doctor_paths(tmp_path: Path) -> DoctorPaths:
    return DoctorPaths(
        coding_agents_dir=tmp_path / "coding-agents",
        scenarios_root=tmp_path / "scenarios",
        profile_root=tmp_path / "profiles",
        profile_owner_uid=os.getuid(),
    )


def _profiles_dir(paths: DoctorPaths) -> Path:
    """Narrow DoctorPaths.profile_root (Optional) to Path — every doctor test sets it."""
    assert paths.profile_root is not None
    return paths.profile_root


def _ready_fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[DoctorPaths, dict[str, str]]:
    paths = _doctor_paths(tmp_path)
    bin_dir = tmp_path / "bin"
    _write_tool(bin_dir, "demo-agent")
    _write_agent(paths.coding_agents_dir, required_env=["GEMINI_API_KEY", "SUPERPOWERS_ROOT"])
    _write_context(paths.coding_agents_dir, runtime_family="gemini")
    _write_sentinel(paths.scenarios_root, target="gemini")
    _profiles_dir(paths).mkdir(parents=True)
    _profiles_dir(paths).chmod(0o700)
    profile = _profiles_dir(paths) / "gemini.env"
    profile.write_text("GEMINI_API_KEY=profile-key\n")
    profile.chmod(0o600)
    _write_superpowers_root(tmp_path / "superpowers")
    env = {
        "PATH": str(bin_dir),
        "QUORUM_MANAGED_HOST": "1",
        "QUORUM_TARGET_PROFILE_ROOT": str(_profiles_dir(paths)),
        "SUPERPOWERS_ROOT": str(tmp_path / "superpowers"),
    }
    monkeypatch.setenv("PATH", str(bin_dir))
    return paths, env


def test_ready_target_returns_ready(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)

    result = run_target_doctor("gemini", paths, env)

    assert result.target == "gemini"
    assert result.status is DoctorStatus.READY
    assert all(check.status is DoctorStatus.READY for check in result.checks)
    assert any(check.name == "sanitized-env" for check in result.checks)


def test_managed_readiness_ignores_ambient_required_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    env["GEMINI_API_KEY"] = ""

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.READY
    assert all(
        check.name != "coding-agent-config" or check.status is DoctorStatus.READY
        for check in result.checks
    )


def test_bad_profile_permissions_are_failed_with_remediation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    profile = _profiles_dir(paths) / "gemini.env"
    profile.chmod(0o666)

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    permissions = next(check for check in result.checks if check.name == "profile-permissions")
    assert permissions.status is DoctorStatus.FAILED
    assert permissions.remediation
    assert "chmod 0600" in permissions.remediation


def test_json_shape_includes_target_status_checks_and_remediation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    (_profiles_dir(paths) / "gemini.env").chmod(0o666)

    payload = run_target_doctor("gemini", paths, env).to_dict()

    assert payload["target"] == "gemini"
    assert payload["status"] == "failed"
    checks = payload["checks"]
    assert isinstance(checks, list)
    typed_checks = cast("list[dict[str, Any]]", checks)
    assert any(check.get("remediation") for check in typed_checks)
    assert any(check.get("reason") == "config-error" for check in typed_checks)
    json.dumps(payload)


@pytest.mark.parametrize("yaml_text", ["- name\n", "42\n"])
def test_malformed_coding_agent_yaml_does_not_crash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    yaml_text: str,
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    (paths.coding_agents_dir / "gemini.yaml").write_text(yaml_text)

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    config = next(check for check in result.checks if check.name == "coding-agent-config")
    assert config.reason == "config-error"


@pytest.mark.parametrize(
    "yaml_text",
    [
        "name: gemini\nrequired_env: 42\n",
        "name: gemini\nrequired_env:\n  - [GEMINI_API_KEY]\n",
        "name: gemini\nnormalizer:\n  - codex\n",
    ],
)
def test_malformed_coding_agent_yaml_mapping_fields_do_not_crash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    yaml_text: str,
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    (paths.coding_agents_dir / "gemini.yaml").write_text(yaml_text)

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    config = next(check for check in result.checks if check.name == "coding-agent-config")
    assert config.reason == "config-error"


def test_codex_is_blocked_until_key_backed_mode_is_verified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _doctor_paths(tmp_path)
    bin_dir = tmp_path / "bin"
    _write_tool(bin_dir, "demo-agent")
    _write_agent(paths.coding_agents_dir, name="codex", required_env=["SUPERPOWERS_ROOT"])
    _write_context(paths.coding_agents_dir)
    _write_sentinel(paths.scenarios_root, target="codex")
    _profiles_dir(paths).mkdir(parents=True)
    _profiles_dir(paths).chmod(0o700)
    profile = _profiles_dir(paths) / "codex.env"
    profile.write_text("OPENAI_API_KEY=profile-key\n")
    profile.chmod(0o600)
    _write_superpowers_root(tmp_path / "superpowers")
    env = {
        "PATH": str(bin_dir),
        "QUORUM_MANAGED_HOST": "1",
        "SUPERPOWERS_ROOT": str(tmp_path / "superpowers"),
    }
    monkeypatch.setenv("PATH", str(bin_dir))

    result = run_target_doctor("codex", paths, env)

    assert result.status is DoctorStatus.BLOCKED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert "key-backed Codex mode" in credentials.message
    assert credentials.reason == "unsupported-key-backed-mode"


def test_opencode_is_blocked_until_managed_env_surface_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _doctor_paths(tmp_path)
    bin_dir = tmp_path / "bin"
    _write_tool(bin_dir, "demo-agent")
    _write_agent(paths.coding_agents_dir, name="opencode", required_env=["SUPERPOWERS_ROOT"])
    env = {
        "PATH": str(bin_dir),
        "QUORUM_MANAGED_HOST": "1",
        "SUPERPOWERS_ROOT": str(tmp_path / "superpowers"),
    }
    monkeypatch.setenv("PATH", str(bin_dir))

    result = run_target_doctor("opencode", paths, env)

    assert result.status is DoctorStatus.BLOCKED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert "OpenCode managed env narrowing" in credentials.message
    assert credentials.reason == "unsupported-key-backed-mode"


def test_placeholder_profile_secret_is_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    (_profiles_dir(paths) / "gemini.env").write_text("GEMINI_API_KEY=placeholder\n")

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert credentials.reason == "placeholder-secret"
    assert "GEMINI_API_KEY" in credentials.message


def test_wrong_profile_owner_is_failed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    paths = DoctorPaths(
        coding_agents_dir=paths.coding_agents_dir,
        scenarios_root=paths.scenarios_root,
        profile_root=_profiles_dir(paths),
        profile_owner_uid=os.getuid() + 1,
    )

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    permissions = next(check for check in result.checks if check.name == "profile-permissions")
    assert permissions.reason == "config-error"
    assert "owner uid" in permissions.message


def test_managed_roots_must_be_directories(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    artifact_root = tmp_path / "artifact-file"
    artifact_root.write_text("not a directory\n")
    artifact_root.chmod(0o700)
    env["QUORUM_ARTIFACT_ROOT"] = str(artifact_root)

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    artifact = next(check for check in result.checks if check.name == "artifact-root")
    assert artifact.reason == "config-error"
    assert "not a directory" in artifact.message


def test_managed_root_parent_must_be_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    file_parent = tmp_path / "file-parent"
    file_parent.write_text("not a directory\n")
    file_parent.chmod(0o700)
    env["QUORUM_ARTIFACT_ROOT"] = str(file_parent / "child")

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    artifact = next(check for check in result.checks if check.name == "artifact-root")
    assert artifact.reason == "config-error"
    assert "nearest existing parent" in artifact.message


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unavailable")
def test_managed_root_broken_symlink_is_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    artifact_root = tmp_path / "artifact-link"
    artifact_root.symlink_to(tmp_path / "missing-target")
    env["QUORUM_ARTIFACT_ROOT"] = str(artifact_root)

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    artifact = next(check for check in result.checks if check.name == "artifact-root")
    assert artifact.reason == "config-error"
    assert "symlink" in artifact.message


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unavailable")
def test_managed_root_broken_symlink_parent_is_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    parent = tmp_path / "parent-link"
    parent.symlink_to(tmp_path / "missing-target")
    env["QUORUM_ARTIFACT_ROOT"] = str(parent / "child")

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.FAILED
    artifact = next(check for check in result.checks if check.name == "artifact-root")
    assert artifact.reason == "config-error"
    assert "symlink" in artifact.message


def test_run_all_missing_coding_agents_dir_is_command_error(tmp_path: Path) -> None:
    paths = DoctorPaths(coding_agents_dir=tmp_path / "missing")

    results = run_all_doctors(paths, {"QUORUM_MANAGED_HOST": "1"})

    assert len(results) == 1
    assert results[0].status is DoctorStatus.FAILED
    check = results[0].checks[0]
    assert check.name == "coding-agent-config"
    assert check.reason == "config-error"


def test_gemini_personal_oauth_is_blocked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths, env = _ready_fixture(tmp_path, monkeypatch)
    (_profiles_dir(paths) / "gemini.env").write_text(
        "GEMINI_API_KEY=profile-key\nGEMINI_AUTH_TYPE=oauth-personal\n"
    )

    result = run_target_doctor("gemini", paths, env)

    assert result.status is DoctorStatus.BLOCKED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert credentials.reason == "personal-auth"
    assert "oauth-personal" in credentials.message


def test_copilot_missing_provider_mode_profile_is_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _doctor_paths(tmp_path)
    bin_dir = tmp_path / "bin"
    _write_tool(bin_dir, "demo-agent")
    _write_agent(paths.coding_agents_dir, name="copilot", required_env=["SUPERPOWERS_ROOT"])
    _write_context(paths.coding_agents_dir, runtime_family="copilot")
    _write_sentinel(paths.scenarios_root, target="copilot")
    _profiles_dir(paths).mkdir(parents=True)
    _profiles_dir(paths).chmod(0o700)
    profile = _profiles_dir(paths) / "copilot.env"
    profile.write_text("# no provider mode yet\n")
    profile.chmod(0o600)
    _write_superpowers_root(tmp_path / "superpowers")
    env = {
        "PATH": str(bin_dir),
        "QUORUM_MANAGED_HOST": "1",
        "SUPERPOWERS_ROOT": str(tmp_path / "superpowers"),
    }
    monkeypatch.setenv("PATH", str(bin_dir))

    result = run_target_doctor("copilot", paths, env)

    assert result.status is DoctorStatus.FAILED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert credentials.reason == "missing-secret"
    assert "COPILOT_PROVIDER_BASE_URL" in credentials.message


def test_copilot_hook_env_references_must_be_profile_backed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _doctor_paths(tmp_path)
    bin_dir = tmp_path / "bin"
    _write_tool(bin_dir, "demo-agent")
    _write_agent(paths.coding_agents_dir, name="copilot", required_env=["SUPERPOWERS_ROOT"])
    _write_context(paths.coding_agents_dir, runtime_family="copilot")
    _write_sentinel(paths.scenarios_root, target="copilot")
    _profiles_dir(paths).mkdir(parents=True)
    _profiles_dir(paths).chmod(0o700)
    profile = _profiles_dir(paths) / "copilot.env"
    profile.write_text(
        "COPILOT_PROVIDER_BASE_URL=https://example.invalid\n"
        "COPILOT_PROVIDER_TYPE=openai\n"
        "COPILOT_PROVIDER_API_KEY=provider-key\n"
    )
    profile.chmod(0o600)
    sp_root = tmp_path / "superpowers"
    _write_superpowers_root(sp_root)
    (sp_root / "hooks" / "session-start").write_text('echo "$OPENAI_API_KEY"\n')
    env = {
        "PATH": str(bin_dir),
        "QUORUM_MANAGED_HOST": "1",
        "SUPERPOWERS_ROOT": str(sp_root),
    }
    monkeypatch.setenv("PATH", str(bin_dir))

    result = run_target_doctor("copilot", paths, env)

    assert result.status is DoctorStatus.FAILED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert credentials.reason == "missing-secret"
    assert "OPENAI_API_KEY" in credentials.message


def test_copilot_personal_github_token_is_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _doctor_paths(tmp_path)
    bin_dir = tmp_path / "bin"
    _write_tool(bin_dir, "demo-agent")
    _write_agent(paths.coding_agents_dir, name="copilot", required_env=["SUPERPOWERS_ROOT"])
    _write_context(paths.coding_agents_dir, runtime_family="copilot")
    _write_sentinel(paths.scenarios_root, target="copilot")
    _profiles_dir(paths).mkdir(parents=True)
    _profiles_dir(paths).chmod(0o700)
    profile = _profiles_dir(paths) / "copilot.env"
    profile.write_text(
        "COPILOT_PROVIDER_BASE_URL=https://example.invalid\n"
        "COPILOT_PROVIDER_TYPE=openai\n"
        "COPILOT_PROVIDER_API_KEY=provider-key\n"
        "GITHUB_TOKEN=profile-github-token\n"
    )
    profile.chmod(0o600)
    _write_superpowers_root(tmp_path / "superpowers")
    env = {
        "PATH": str(bin_dir),
        "QUORUM_MANAGED_HOST": "1",
        "SUPERPOWERS_ROOT": str(tmp_path / "superpowers"),
    }
    monkeypatch.setenv("PATH", str(bin_dir))

    result = run_target_doctor("copilot", paths, env)

    assert result.status is DoctorStatus.BLOCKED
    credentials = next(check for check in result.checks if check.name == "required-credentials")
    assert credentials.reason == "personal-auth"
    assert "GITHUB_TOKEN" in credentials.message
