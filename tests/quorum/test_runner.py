import json
import os
import shlex
import shutil
import stat
import subprocess
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from quorum.coding_agent_config import CodingAgentConfig
from quorum.kimi import effective_kimi_model_env, kimi_preflight_sentinel_payload
from quorum.runner import (
    ANTIGRAVITY_RATE_LIMIT_MARKER,
    CLAUDE_ENV_FILE_NAME,
    COPILOT_ENV_FILE_NAME,
    COPILOT_PROVIDER_ENV_NAMES,
    COPILOT_REQUIRED_SUPERPOWERS_FILES,
    COPILOT_SECRET_ENV_NAMES,
    AgentRuntime,
    CopilotProvisioning,
    GauntletResult,
    RunnerError,
    _cleanup_agent_runtime,
    _copilot_gauntlet_env,
    _exclude_antigravity_project_marker,
    _gemini_extension_list_shows_superpowers,
    _gemini_transcripts,
    _gh_auth_token,
    _populate_context_dir,
    _require_copilot_superpowers_root,
    _resolve_copilot_auth_env,
    _run_antigravity_auth_preflight,
    _run_opencode_provider_preflight,
    _scan_copilot_secret_leaks,
    _seed_agent_config_dir,
    _seed_antigravity_config,
    _seed_copilot_config,
    _seed_gemini_config,
    _seed_kimi_config,
    _shell_single_quote,
    _stage_copilot_superpowers_plugin,
    _write_antigravity_settings,
    _write_copilot_env_file,
    _write_gemini_env_file,
    _write_gemini_settings,
    invoke_gauntlet,
    run_scenario,
)


def _exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _fake_copilot_bin(bin_dir: Path, output_path: Path) -> None:
    _exec(
        bin_dir / "copilot",
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        f"output_path = Path({json.dumps(str(output_path))})\n"
        "output_path.write_text(json.dumps({\n"
        "    'argv': sys.argv[1:],\n"
        "    'cwd': os.getcwd(),\n"
        "    'env': dict(os.environ),\n"
        "}, sort_keys=True))\n",
    )


def _make_coding_agent(coding_agents_dir: Path, name: str, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "name": name,
        "binary": "echo",  # we never actually run the real CLI in tests
        "agent_config_env": "CLAUDE_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }
    if name in {"claude", "claude-haiku"}:
        doc["runtime_family"] = "claude"
        doc["model"] = "opus" if name == "claude" else "claude-haiku-4-5-20251001"
    (coding_agents_dir / f"{name}.yaml").write_text(yaml.safe_dump(doc))


def _make_antigravity_agent(
    coding_agents_dir: Path,
    session_log_dir: Path,
    normalizer: str = "antigravity",
) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "antigravity.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "antigravity",
                "binary": "echo",
                "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "*.jsonl",
                "normalizer": normalizer,
                "required_env": [],
            }
        )
    )
    (coding_agents_dir / "antigravity-context").mkdir(parents=True, exist_ok=True)


def _make_gemini_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "gemini.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "gemini",
                "binary": "gemini",
                "agent_config_env": "GEMINI_CLI_HOME",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "*.jsonl",
                "normalizer": "gemini",
                "required_env": [],
            }
        )
    )
    (coding_agents_dir / "gemini-context").mkdir(parents=True, exist_ok=True)


def _make_opencode_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "opencode.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "opencode",
                "binary": "opencode",
                "agent_config_env": "OPENCODE_QUORUM_HOME",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "[0-9]*-ses_*.json",
                "normalizer": "opencode",
                "required_env": ["SUPERPOWERS_ROOT"],
                "max_time": "10m",
            }
        )
    )


def _make_pi_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "pi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "pi",
                "binary": "pi",
                "agent_config_env": "PI_CODING_AGENT_DIR",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "*.jsonl",
                "normalizer": "pi",
                "required_env": [],
            }
        )
    )
    ctx = coding_agents_dir / "pi-context"
    ctx.mkdir(parents=True, exist_ok=True)
    (ctx / "HOWTO.md").write_text("run $QUORUM_LAUNCH_AGENT\n")
    (ctx / "launch-agent").write_text("#!/usr/bin/env bash\nset -euo pipefail\n")


def _make_kimi_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": [],
            }
        )
    )
    (coding_agents_dir / "kimi-context").mkdir(parents=True, exist_ok=True)


def _make_copilot_agent(
    coding_agents_dir: Path,
    session_log_dir: Path | None = None,
) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "copilot.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "copilot",
                "binary": "copilot",
                "agent_config_env": "COPILOT_HOME",
                "session_log_dir": (
                    "${COPILOT_HOME}/session-state"
                    if session_log_dir is None
                    else str(session_log_dir)
                ),
                "session_log_glob": "**/events.jsonl",
                "normalizer": "copilot",
                "required_env": [],
            }
        )
    )
    (coding_agents_dir / "copilot-context").mkdir(parents=True, exist_ok=True)


def _write_copilot_skill_event(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "type": "assistant.message",
                "data": {
                    "toolRequests": [
                        {
                            "name": "skill",
                            "arguments": {"skill": "superpowers:brainstorming"},
                        }
                    ]
                },
            }
        )
        + "\n"
    )


def _copilot_provisioning(
    copilot_home: Path,
    *,
    session_id: str = "session-123",
    secret: str = "secret-token",
) -> CopilotProvisioning:
    env_file = copilot_home / COPILOT_ENV_FILE_NAME
    env_file.parent.mkdir(parents=True, exist_ok=True)
    env_file.write_text(f"COPILOT_GITHUB_TOKEN={_shell_single_quote(secret)}\n")
    return CopilotProvisioning(
        session_id=session_id,
        env_file=env_file,
        secret_names=("COPILOT_GITHUB_TOKEN",),
        secret_values=(secret,),
    )


# Tests pass an empty dir as skeleton_root so _seed_agent_config_dir falls
# through to mkdir-empty without requiring the production skeleton fixture.
def _empty_skeleton(tmp_path: Path) -> Path:
    p = tmp_path / "empty-fixtures"
    p.mkdir(exist_ok=True)
    return p


def _tcfg(
    name: str = "claude",
    runtime_family: str | None = None,
    model: str | None = None,
) -> CodingAgentConfig:
    family = runtime_family or name
    return CodingAgentConfig(
        name=name,
        runtime_family=family,
        binary="echo",
        agent_config_env="CLAUDE_CONFIG_DIR",
        session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob="*.jsonl",
        normalizer="claude",
        required_env=(),
        model=model if model is not None else ("opus" if family == "claude" else None),
        max_time=None,
        project_prompt=None,
    )


def _antigravity_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="antigravity",
        runtime_family="antigravity",
        binary="agy",
        agent_config_env="ANTIGRAVITY_CONFIG_DIR",
        session_log_dir="${ANTIGRAVITY_CONFIG_DIR}/.gemini/antigravity-cli/brain",
        session_log_glob="**/transcript.jsonl",
        normalizer="antigravity",
        required_env=(),
        model=None,
        max_time=None,
        project_prompt=None,
    )


def _gemini_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="gemini",
        runtime_family="gemini",
        binary="gemini",
        agent_config_env="GEMINI_CLI_HOME",
        session_log_dir="${GEMINI_CLI_HOME}/.gemini/tmp",
        session_log_glob="**/chats/**/*.json*",
        normalizer="gemini",
        required_env=(),
        model=None,
        max_time=None,
        project_prompt=None,
    )


def _opencode_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="opencode",
        runtime_family="opencode",
        binary="opencode",
        agent_config_env="OPENCODE_QUORUM_HOME",
        session_log_dir="${OPENCODE_QUORUM_HOME}/.quorum/session-exports",
        session_log_glob="[0-9]*-ses_*.json",
        normalizer="opencode",
        required_env=("SUPERPOWERS_ROOT",),
        model=None,
        max_time="10m",
        project_prompt=None,
    )


def _pi_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="pi",
        runtime_family="pi",
        binary="pi",
        agent_config_env="PI_CODING_AGENT_DIR",
        session_log_dir="${PI_CODING_AGENT_DIR}/sessions",
        session_log_glob="*.jsonl",
        normalizer="pi",
        required_env=("SUPERPOWERS_ROOT", "PI_PROVIDER", "PI_MODEL", "PI_API_KEY"),
        model=None,
        max_time="10m",
        project_prompt=None,
    )


def _copilot_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="copilot",
        runtime_family="copilot",
        binary="copilot",
        agent_config_env="COPILOT_HOME",
        session_log_dir="${COPILOT_HOME}/session-state",
        session_log_glob="**/events.jsonl",
        normalizer="copilot",
        required_env=(),
        model=None,
        max_time=None,
        project_prompt=None,
    )


def _make_superpowers_opencode_root(tmp_path: Path) -> Path:
    sp = tmp_path / "superpowers"
    plugin_src = sp / ".opencode" / "plugins" / "superpowers.js"
    plugin_src.parent.mkdir(parents=True)
    plugin_src.write_text("export const SuperpowersPlugin = async () => ({});")
    for skill_name in ("using-superpowers", "brainstorming"):
        skill_dir = sp / "skills" / skill_name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(f"# {skill_name}")
    return sp


def _make_superpowers_pi_root(path: Path) -> Path:
    root = path / "superpowers"
    (root / ".pi" / "extensions").mkdir(parents=True)
    (root / "skills" / "using-superpowers" / "references").mkdir(parents=True)
    (root / "package.json").write_text(
        '{"pi":{"extensions":["./.pi/extensions/superpowers.ts"],"skills":["./skills"]}}'
    )
    (root / ".pi" / "extensions" / "superpowers.ts").write_text(
        "export default function extension() {}"
    )
    (root / "skills" / "using-superpowers" / "SKILL.md").write_text(
        "---\nname: using-superpowers\n---\n"
    )
    (root / "skills" / "using-superpowers" / "references" / "pi-tools.md").write_text(
        "# Pi tools\n"
    )
    return root


def _kimi_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="kimi",
        runtime_family="kimi",
        binary="kimi",
        agent_config_env="KIMI_CODE_HOME",
        session_log_dir="${KIMI_CODE_HOME}/sessions",
        session_log_glob="**/wire.jsonl",
        normalizer="kimi",
        required_env=(),
        model=None,
        max_time=None,
        project_prompt=None,
    )


def _make_kimi_superpowers_root(tmp_path: Path) -> Path:
    superpowers = tmp_path / "superpowers"
    (superpowers / ".kimi-plugin").mkdir(parents=True)
    (superpowers / ".kimi-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": "superpowers",
                "skills": "./skills/",
                "sessionStart": {"skill": "using-superpowers"},
                "skillInstructions": {"tools": {"Bash": "shell"}},
            }
        )
    )
    (superpowers / "skills" / "using-superpowers").mkdir(parents=True)
    (superpowers / "skills" / "brainstorming").mkdir(parents=True)
    (superpowers / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (superpowers / "skills" / "brainstorming" / "SKILL.md").write_text("skill")
    return superpowers


def _make_scenario(
    scenarios_dir: Path,
    name: str,
    *,
    checks_pass: bool = True,
    with_checks: bool = True,
) -> Path:
    """Build a scenario using checks.sh (the only supported format)."""
    sd = scenarios_dir / name
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\ntitle: x\n---\nbody\n")
    _exec(sd / "setup.sh", "#!/usr/bin/env bash\necho ok > marker\n")
    if with_checks:
        # A post() check that passes or fails depending on checks_pass.
        check_line = "file-exists marker" if checks_pass else "file-exists missing-nonexistent-file"
        (sd / "checks.sh").write_text(f"pre() {{ :; }}\npost() {{ {check_line}; }}\n")
    return sd


def _make_gemini_superpowers_root(tmp_path: Path) -> Path:
    root = tmp_path / "superpowers"
    (root / "skills" / "using-superpowers" / "references").mkdir(parents=True)
    (root / "gemini-extension.json").write_text("{}")
    (root / "GEMINI.md").write_text("# Superpowers\n")
    (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (root / "skills" / "using-superpowers" / "references" / "gemini-tools.md").write_text("tools")
    return root


def _make_superpowers_copilot_root(tmp_path: Path) -> Path:
    root = tmp_path / "superpowers-copilot"
    for rel in COPILOT_REQUIRED_SUPERPOWERS_FILES:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{rel}\n")
    extra = root / "skills" / "extra-skill" / "references" / "extra.md"
    extra.parent.mkdir(parents=True)
    extra.write_text("extra reference\n")
    return root


def _clear_copilot_auth_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        *COPILOT_PROVIDER_ENV_NAMES,
    ):
        monkeypatch.delenv(name, raising=False)


def _write_gemini_extension_metadata(cfg: Path) -> None:
    (cfg / ".gemini" / "extensions" / "superpowers").mkdir(parents=True)
    (cfg / ".gemini" / "extensions" / "superpowers" / ".gemini-extension-install.json").write_text(
        "{}"
    )
    (cfg / ".gemini" / "extensions" / "extension-enablement.json").write_text("{}")
    (cfg / ".gemini" / "extension_integrity.json").write_text("{}")


def _stub_gauntlet_pass(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return GauntletResult(status="pass")


def _stub_gauntlet_fail(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return GauntletResult(status="fail")


def _claude_log_line() -> str:
    # One real Claude transcript line: an assistant message carrying a tool_use
    # (so the claude normalizer yields a tool-call row and capture is non-empty —
    # claude is a strict-capture target) plus a usage block (so token capture
    # produces real economics for tests that assert on cost).
    return (
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "model": "claude-sonnet-4-6",
                    "content": [
                        {"type": "tool_use", "name": "Bash", "input": {"command": "echo hi"}}
                    ],
                    "usage": {"input_tokens": 100, "output_tokens": 50},
                },
            }
        )
        + "\n"
    )


def _stub_gauntlet_pass_writing_log(session_log_dir: Path):
    """Passing-gauntlet stub that also writes a minimal claude session log.

    Generic composition tests that only exercise verdict wiring still need a
    realistic non-empty capture now that claude is a strict-capture target.
    """

    def _stub(*, run_dir, **kwargs):
        (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
        (session_log_dir / "session.jsonl").write_text(_claude_log_line())
        return GauntletResult(status="pass")

    return _stub


def test_invoke_gauntlet_accepts_sanitized_env_base(tmp_path, monkeypatch):
    monkeypatch.setenv("HOST_ONLY", "must-not-leak")
    story = tmp_path / "story.md"
    story.write_text("story\n")
    launch_cwd = tmp_path / "workdir"
    launch_cwd.mkdir()
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    captured: dict[str, dict[str, str]] = {}

    class FakeProc:
        returncode = 0

        def wait(self):
            return 0

    def fake_popen(cmd, **kwargs):
        del cmd
        captured["env"] = kwargs["env"]
        return FakeProc()

    with patch("quorum.runner.subprocess.Popen", side_effect=fake_popen):
        result = invoke_gauntlet(
            story_path=story,
            target_binary="copilot",
            launch_cwd=launch_cwd,
            run_dir=run_dir,
            max_time=None,
            coding_agent="copilot",
            extra_env={"COPILOT_HOME": "/isolated/copilot"},
            env_base={"PATH": "/bin", "TERM": "xterm-256color"},
        )

    assert result.status == "investigate"
    assert captured["env"] == {
        "PATH": "/bin",
        "TERM": "xterm-256color",
        "QUORUM_AGENT_CWD": str(launch_cwd),
        "COPILOT_HOME": "/isolated/copilot",
    }


def test_antigravity_launch_agent_is_interactive_and_substituted(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "antigravity.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "antigravity",
                "binary": "agy",
                "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
                "session_log_dir": ("${ANTIGRAVITY_CONFIG_DIR}/.gemini/antigravity-cli/brain"),
                "session_log_glob": "**/transcript.jsonl",
                "normalizer": "antigravity",
                "required_env": [],
            }
        )
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    cd_antigravity = coding_agents_dir / "antigravity-context"
    cd_antigravity.mkdir(parents=True)
    shutil.copy2(
        Path(__file__).resolve().parents[2]
        / "coding-agents"
        / "antigravity-context"
        / "launch-agent",
        cd_antigravity / "launch-agent",
    )
    out_root = tmp_path / "results"

    with (
        patch("quorum.runner._seed_antigravity_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )
    rd = list(out_root.iterdir())[0]
    shim = rd / "gauntlet-agent" / "context" / "launch-agent"
    assert shim.exists()
    assert shim.stat().st_mode & stat.S_IXUSR
    content = shim.read_text()
    assert "$QUORUM_AGENT_CWD" not in content
    assert "$ANTIGRAVITY_CONFIG_DIR" not in content
    assert "AGY_CLI_DISABLE_AUTO_UPDATE=true" in content
    assert "--gemini_dir=" in content
    assert "--add-dir=" in content
    assert "--dangerously-skip-permissions" in content
    assert "--log-file" in content
    assert "--print" not in content


def test_gemini_launch_agent_is_substituted(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_gemini_agent(coding_agents_dir, session_log_dir)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "gemini-context" / "launch-agent",
        coding_agents_dir / "gemini-context" / "launch-agent",
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = tmp_path / "results"

    with (
        patch("quorum.runner._seed_gemini_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="gemini",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    rd = next(out_root.iterdir())
    shim = rd / "gauntlet-agent" / "context" / "launch-agent"
    assert shim.exists()
    assert shim.stat().st_mode & stat.S_IXUSR
    content = shim.read_text()
    assert "$QUORUM_AGENT_CWD" not in content
    assert "$GEMINI_CLI_HOME" not in content
    assert "$GEMINI_ENV_FILE" not in content
    assert "GEMINI_CLI_HOME=" in content
    assert ".gemini-env" in content
    assert "GEMINI_DEFAULT_AUTH_TYPE='gemini-api-key'" in content
    assert "--skip-trust --approval-mode=yolo" in content


def test_claude_launch_agent_forces_session_persistence(tmp_path):
    """Regression (B1): the generated claude launcher must export
    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1.

    claude >= 2.1.176 skips transcript persistence when it detects a nested
    interactive Claude Code session; the `env -u CLAUDECODE -u
    CLAUDE_CODE_SESSION_ID` strip no longer covers every nested-detection signal
    (e.g. CLAUDE_CODE_CHILD_SESSION). Without the FORCE override the transcript
    is never written, capture comes back empty, and every claude run launched
    from inside Claude Code is a loud indeterminate(stage=capture). The override
    forces persistence regardless of nested-session detection.
    """
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
    (coding_agents_dir / "claude-context").mkdir(parents=True)
    (coding_agents_dir / "claude-context" / "HOWTO.md").write_text("invoke `claude`")
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "claude-context" / "launch-agent",
        coding_agents_dir / "claude-context" / "launch-agent",
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = tmp_path / "results"

    with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
        run_scenario(
            scenario_dir=sd,
            coding_agent="claude",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    rd = next(out_root.iterdir())
    shim = rd / "gauntlet-agent" / "context" / "launch-agent"
    assert shim.exists()
    content = shim.read_text()
    # The nested-session identity strip is necessary but not sufficient on >=2.1.176 ...
    assert "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID" in content
    # ... so the launcher must also force transcript persistence.
    assert "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1" in content


def test_gemini_launch_agent_substitutes_oauth_auth_type(tmp_path, monkeypatch):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_gemini_agent(coding_agents_dir, session_log_dir)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "gemini-context" / "launch-agent",
        coding_agents_dir / "gemini-context" / "launch-agent",
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = tmp_path / "results"
    monkeypatch.setenv("GEMINI_AUTH_TYPE", "oauth-personal")

    with (
        patch("quorum.runner._seed_gemini_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="gemini",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    rd = next(out_root.iterdir())
    content = (rd / "gauntlet-agent" / "context" / "launch-agent").read_text()
    assert "GEMINI_DEFAULT_AUTH_TYPE='oauth-personal'" in content
    assert "GEMINI_DEFAULT_AUTH_TYPE=gemini-api-key" not in content


def test_gemini_launch_agent_handles_shell_sensitive_paths(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_gemini_agent(coding_agents_dir, session_log_dir)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "gemini-context" / "launch-agent",
        coding_agents_dir / "gemini-context" / "launch-agent",
    )
    launch_cwd = tmp_path / 'cwd-$HOME-"quoted"'
    launch_cwd.mkdir()

    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "setup.sh").write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"printf '%s\\n' '{launch_cwd}' > \"$QUORUM_WORKDIR/.quorum-launch-cwd\"\n"
        "touch marker\n"
    )
    sd.joinpath("setup.sh").chmod(sd.joinpath("setup.sh").stat().st_mode | stat.S_IXUSR)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = tmp_path / "results"

    def fake_seed(gemini_home: Path, _workdir: Path) -> None:
        gemini_home.mkdir(parents=True, exist_ok=True)
        (gemini_home / ".gemini-env").write_text("GEMINI_API_KEY='launch key'\n")

    with (
        patch("quorum.runner._seed_gemini_config", side_effect=fake_seed),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="gemini",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    rd = next(out_root.iterdir())
    shim = rd / "gauntlet-agent" / "context" / "launch-agent"
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    capture_path = tmp_path / "gemini-capture.json"
    _exec(
        fake_bin / "gemini",
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(os.environ['FAKE_GEMINI_CAPTURE']).write_text(json.dumps({\n"
        "    'args': sys.argv[1:],\n"
        "    'auth': os.environ.get('GEMINI_DEFAULT_AUTH_TYPE'),\n"
        "    'cwd': os.getcwd(),\n"
        "    'home': os.environ.get('GEMINI_CLI_HOME'),\n"
        "    'key': os.environ.get('GEMINI_API_KEY'),\n"
        "    'trust': os.environ.get('GEMINI_CLI_TRUST_WORKSPACE'),\n"
        "}))\n",
    )

    result = subprocess.run(
        [str(shim), "--probe", "two words"],
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "FAKE_GEMINI_CAPTURE": str(capture_path),
            "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
        },
    )

    assert result.returncode == 0, result.stderr
    record = json.loads(capture_path.read_text())
    assert record == {
        "args": ["--skip-trust", "--approval-mode=yolo", "--probe", "two words"],
        "auth": "gemini-api-key",
        "cwd": str(launch_cwd),
        "home": str(rd / "coding-agent-config"),
        "key": "launch key",
        "trust": "true",
    }


def test_kimi_launch_agent_is_interactive_and_substituted(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": "${KIMI_CODE_HOME}/sessions",
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": [],
            }
        )
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    cd_kimi = coding_agents_dir / "kimi-context"
    cd_kimi.mkdir(parents=True)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "kimi-context" / "launch-agent",
        cd_kimi / "launch-agent",
    )
    out_root = tmp_path / "results"

    with (
        patch(
            "quorum.runner._seed_kimi_config",
            return_value=AgentRuntime(
                env_file=tmp_path / "secret" / "kimi-runtime.env",
                substitutions={
                    "$KIMI_ENV_FILE": str(tmp_path / "secret" / "kimi-runtime.env"),
                    "$KIMI_BINARY": "kimi",
                },
                cleanup_dirs=(tmp_path / "secret",),
            ),
        ),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )
    rd = list(out_root.iterdir())[0]
    shim = rd / "gauntlet-agent" / "context" / "launch-agent"
    assert shim.exists()
    assert shim.stat().st_mode & stat.S_IXUSR
    content = shim.read_text()
    assert "$QUORUM_AGENT_CWD" not in content
    assert "$KIMI_CODE_HOME" not in content
    assert "$KIMI_ENV_FILE" not in content
    assert "set -a" in content
    assert '. "$KIMI_ENV_FILE"' not in content
    assert str(tmp_path / "secret" / "kimi-runtime.env") in content
    assert "trap cleanup_kimi_env EXIT HUP INT TERM" in content
    assert "unset KIMI_ENV_FILE" in content
    assert "$KIMI_BINARY" not in content
    assert "--yolo" in content
    assert "--skills-dir" not in content
    assert "--auto" not in content


def test_kimi_launch_agent_uses_configured_binary(tmp_path, monkeypatch):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    custom_kimi = tmp_path / "custom tools" / "kimi-wrapper"
    custom_kimi.parent.mkdir()
    custom_kimi.write_text("#!/usr/bin/env bash\nexit 0\n")
    custom_kimi.chmod(0o755)
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": str(custom_kimi),
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": "${KIMI_CODE_HOME}/sessions",
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": [],
            }
        )
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    cd_kimi = coding_agents_dir / "kimi-context"
    cd_kimi.mkdir(parents=True)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "kimi-context" / "launch-agent",
        cd_kimi / "launch-agent",
    )
    out_root = tmp_path / "results"
    superpowers = _make_kimi_superpowers_root(tmp_path)
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")

    with (
        patch("quorum.runner.run_kimi_auth_preflight"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    rd = list(out_root.iterdir())[0]
    shim = rd / "gauntlet-agent" / "context" / "launch-agent"
    content = shim.read_text()
    assert f"exec {shlex.quote(str(custom_kimi))} --yolo" in content
    assert "exec kimi --yolo" not in content
    assert "$KIMI_BINARY" not in content


def test_kimi_runtime_env_file_cleaned_when_gauntlet_never_launches(tmp_path, monkeypatch):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": "${KIMI_CODE_HOME}/sessions",
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": [],
            }
        )
    )
    cd_kimi = coding_agents_dir / "kimi-context"
    cd_kimi.mkdir()
    (cd_kimi / "launch-agent").write_text("#!/usr/bin/env bash\nexit 0\n")
    sd = _make_scenario(scenarios_dir, "x")
    out_root = tmp_path / "results"
    secret_dir = tmp_path / "secret"
    secret_dir.mkdir()
    env_file = secret_dir / "kimi-runtime.env"
    env_file.write_text("KIMI_MODEL_API_KEY=fake\n")

    with (
        patch(
            "quorum.runner._seed_kimi_config",
            return_value=AgentRuntime(
                env_file=env_file,
                substitutions={"$KIMI_ENV_FILE": str(env_file)},
                cleanup_dirs=(secret_dir,),
            ),
        ),
        patch(
            "quorum.runner.invoke_gauntlet",
            side_effect=RunnerError("gauntlet boom", stage="gauntlet"),
        ),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert not env_file.exists()
    assert not secret_dir.exists()


def test_copilot_launch_agent_is_substituted_and_uses_env_i(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    copilot_context = coding_agents_dir / "copilot-context"
    copilot_context.mkdir(parents=True)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "copilot-context" / "launch-agent",
        copilot_context / "launch-agent",
    )
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "copilot-context" / "HOWTO.md",
        copilot_context / "HOWTO.md",
    )
    run_dir = tmp_path / "run $HOME's dir"
    launch_cwd = tmp_path / "launch cwd $HOME's place"
    copilot_home = run_dir / "coding agent $HOME's config"
    env_file = copilot_home / "copilot env $HOME's file"
    launch_agent_path = run_dir / "gauntlet-agent" / "context" / "launch-agent"
    launch_cwd.mkdir()
    copilot_home.mkdir(parents=True)
    env_file.write_text("COPILOT_GITHUB_TOKEN='token with spaces'\nLEAK_ME='from-env-file'\n")

    _populate_context_dir(
        coding_agents_dir,
        "copilot",
        run_dir,
        substitutions={
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$QUORUM_AGENT_CWD_SH": _shell_single_quote(str(launch_cwd)),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            "$QUORUM_LAUNCH_AGENT_SH": _shell_single_quote(str(launch_agent_path)),
            "$COPILOT_HOME": str(copilot_home),
            "$COPILOT_HOME_SH": _shell_single_quote(str(copilot_home)),
            "$COPILOT_ENV_FILE": str(env_file),
            "$COPILOT_ENV_FILE_SH": _shell_single_quote(str(env_file)),
            "$QUORUM_COPILOT_SESSION_ID": "quorum-session-123",
        },
    )

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    capture_path = tmp_path / "copilot-capture.json"
    _fake_copilot_bin(fake_bin, capture_path)
    howto = (run_dir / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
    launch_command = _shell_single_quote(str(launch_agent_path))
    assert launch_command in howto
    assert '"$QUORUM_LAUNCH_AGENT"' not in howto
    launch_env_path = str(fake_bin) + os.pathsep + os.environ["PATH"]

    result = subprocess.run(
        [
            "bash",
            "-lc",
            (
                "PATH="
                + _shell_single_quote(launch_env_path)
                + " "
                + launch_command
                + " --extra 'two words' 'semi;colon' 'dollar$arg'"
            ),
        ],
        text=True,
        capture_output=True,
        env={
            "PATH": os.environ["PATH"],
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "LEAK_ME": "from-host",
        },
    )

    assert result.returncode == 0, result.stderr
    record = json.loads(capture_path.read_text())
    env = record["env"]
    assert record["cwd"] == str(launch_cwd)
    expected_env = {
        "COPILOT_AUTO_UPDATE": "false",
        "COPILOT_CACHE_HOME": str(copilot_home / ".cache"),
        "COPILOT_CLI": "1",
        "COPILOT_GITHUB_TOKEN": "token with spaces",
        "COPILOT_HOME": str(copilot_home),
        "HOME": str(copilot_home),
        "LANG": "C.UTF-8",
        "PATH": launch_env_path,
        "TERM": "xterm-256color",
    }
    platform_env = set(env) - set(expected_env)
    assert platform_env <= {"__CF_USER_TEXT_ENCODING"}
    for name in platform_env:
        env.pop(name)
    assert env == expected_env
    assert record["argv"] == [
        "--plugin-dir",
        str(copilot_home / "plugins" / "superpowers"),
        "--session-id",
        "quorum-session-123",
        "--allow-all",
        "--no-auto-update",
        "--no-remote",
        "--disable-builtin-mcps",
        "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN,"
        "COPILOT_PROVIDER_API_KEY,COPILOT_PROVIDER_BEARER_TOKEN",
        "--log-dir",
        str(copilot_home / "logs"),
        "--extra",
        "two words",
        "semi;colon",
        "dollar$arg",
    ]


def test_codex_launch_agent_scrubs_openai_api_key_env(tmp_path, monkeypatch):
    coding_agents_dir = tmp_path / "coding-agents"
    codex_context = coding_agents_dir / "codex-context"
    codex_context.mkdir(parents=True)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "codex-context" / "launch-agent",
        codex_context / "launch-agent",
    )
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "codex-context" / "HOWTO.md",
        codex_context / "HOWTO.md",
    )
    run_dir = tmp_path / "run"
    launch_cwd = tmp_path / "workdir"
    codex_home = run_dir / "coding-agent-config"
    launch_agent_path = run_dir / "gauntlet-agent" / "context" / "launch-agent"
    launch_cwd.mkdir()

    _populate_context_dir(
        coding_agents_dir,
        "codex",
        run_dir,
        substitutions={
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$QUORUM_AGENT_CWD_SH": _shell_single_quote(str(launch_cwd)),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            "$QUORUM_LAUNCH_AGENT_SH": _shell_single_quote(str(launch_agent_path)),
            "$CODEX_HOME": str(codex_home),
            "$CODEX_HOME_SH": _shell_single_quote(str(codex_home)),
        },
    )

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    capture_path = tmp_path / "codex-capture.json"
    _exec(
        fake_bin / "codex",
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        f"Path({json.dumps(str(capture_path))}).write_text(json.dumps({{\n"
        "    'argv': sys.argv[1:],\n"
        "    'cwd': os.getcwd(),\n"
        "    'env': dict(os.environ),\n"
        "}, sort_keys=True))\n",
    )

    launch_env_path = str(fake_bin) + os.pathsep + os.environ["PATH"]
    result = subprocess.run(
        [
            "bash",
            "-lc",
            "PATH="
            + _shell_single_quote(launch_env_path)
            + " "
            + _shell_single_quote(str(launch_agent_path)),
        ],
        capture_output=True,
        text=True,
        check=False,
        env={
            "PATH": os.environ["PATH"],
            "OPENAI_API_KEY": "sk-should-not-reach-codex",
            "OPENAI_BASE_URL": "https://api-key-proxy.example",
            "OPENAI_ORG_ID": "org-key-mode",
        },
    )

    assert result.returncode == 0, result.stderr
    captured = json.loads(capture_path.read_text())
    assert captured["cwd"] == str(launch_cwd)
    assert captured["env"]["CODEX_HOME"] == str(codex_home)
    assert "OPENAI_API_KEY" not in captured["env"]
    assert "OPENAI_BASE_URL" not in captured["env"]
    assert "OPENAI_ORG_ID" not in captured["env"]


def test_codex_launch_agent_isolates_home(tmp_path):
    # Codex discovers user-scope skills/plugins from $HOME/.agents (resolved via
    # $HOME, NOT $CODEX_HOME). If HOME is left at the host's, a host
    # ~/.agents/skills symlink bleeds host skills into the run. The launcher must
    # pin HOME to a per-run dir so Codex uses the staged superpowers@debug skills.
    coding_agents_dir = tmp_path / "coding-agents"
    codex_context = coding_agents_dir / "codex-context"
    codex_context.mkdir(parents=True)
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "codex-context" / "launch-agent",
        codex_context / "launch-agent",
    )
    shutil.copy2(
        Path(__file__).resolve().parents[2] / "coding-agents" / "codex-context" / "HOWTO.md",
        codex_context / "HOWTO.md",
    )
    run_dir = tmp_path / "run"
    launch_cwd = tmp_path / "workdir"
    codex_home = run_dir / "coding-agent-config"
    launch_agent_path = run_dir / "gauntlet-agent" / "context" / "launch-agent"
    launch_cwd.mkdir()

    _populate_context_dir(
        coding_agents_dir,
        "codex",
        run_dir,
        substitutions={
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$QUORUM_AGENT_CWD_SH": _shell_single_quote(str(launch_cwd)),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            "$QUORUM_LAUNCH_AGENT_SH": _shell_single_quote(str(launch_agent_path)),
            "$CODEX_HOME": str(codex_home),
            "$CODEX_HOME_SH": _shell_single_quote(str(codex_home)),
        },
    )

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    capture_path = tmp_path / "codex-capture.json"
    _exec(
        fake_bin / "codex",
        "#!/usr/bin/env python3\n"
        "import json, os\n"
        "from pathlib import Path\n"
        f"Path({json.dumps(str(capture_path))}).write_text(json.dumps({{\n"
        "    'env': dict(os.environ),\n"
        "}, sort_keys=True))\n",
    )

    host_home = tmp_path / "host-home-should-not-leak"
    host_home.mkdir()
    launch_env_path = str(fake_bin) + os.pathsep + os.environ["PATH"]
    result = subprocess.run(
        [
            "bash",
            "-lc",
            "PATH="
            + _shell_single_quote(launch_env_path)
            + " "
            + _shell_single_quote(str(launch_agent_path)),
        ],
        capture_output=True,
        text=True,
        check=False,
        env={
            "PATH": os.environ["PATH"],
            "HOME": str(host_home),
            "OPENAI_API_KEY": "sk-should-not-reach-codex",
        },
    )

    assert result.returncode == 0, result.stderr
    captured = json.loads(capture_path.read_text())
    agent_home = codex_home / "agent-home"
    # HOME is pinned inside the per-run home, not the inherited host HOME, so
    # Codex's $HOME/.agents/{skills,plugins} discovery stays in-isolation.
    assert captured["env"]["HOME"] == str(agent_home)
    assert captured["env"]["HOME"] != str(host_home)
    assert captured["env"]["HOME"].startswith(str(codex_home))
    # XDG + TMPDIR isolated too, and the dirs were created.
    assert captured["env"]["XDG_CONFIG_HOME"] == str(agent_home / ".config")
    assert captured["env"]["TMPDIR"] == str(agent_home / ".tmp")
    assert agent_home.is_dir()
    # CODEX_HOME still set so config/sessions/plugins stay isolated.
    assert captured["env"]["CODEX_HOME"] == str(codex_home)


def test_copilot_context_gets_runtime_substitutions(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    _make_copilot_agent(coding_agents_dir)
    (coding_agents_dir / "copilot-context" / "HOWTO.md").write_text(
        "$QUORUM_LAUNCH_AGENT_SH\n"
        "$COPILOT_HOME_SH\n"
        "$COPILOT_ENV_FILE\n"
        "$COPILOT_ENV_FILE_SH\n"
        "$QUORUM_COPILOT_SESSION_ID\n"
    )
    (coding_agents_dir / "copilot-context" / "launch-agent").write_text(
        "#!/usr/bin/env bash\n"
        "echo $COPILOT_HOME_SH\n"
        "echo $COPILOT_ENV_FILE\n"
        "echo $COPILOT_ENV_FILE_SH\n"
        'echo "$QUORUM_COPILOT_SESSION_ID"\n'
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    env_file = tmp_path / "runtime env $HOME's file"
    provisioning = CopilotProvisioning(
        session_id="session-123",
        env_file=env_file,
        secret_names=("COPILOT_GITHUB_TOKEN",),
        secret_values=("secret-token",),
    )

    with (
        patch("quorum.runner._seed_copilot_config", return_value=provisioning),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_dir, _ = run_scenario(
            scenario_dir=sd,
            coding_agent="copilot",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "out $HOME's dir",
            skeleton_root=_empty_skeleton(tmp_path),
        )

    howto = (run_dir / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
    launch_agent = run_dir / "gauntlet-agent" / "context" / "launch-agent"
    launcher = launch_agent.read_text()
    combined = howto + launcher
    assert "$QUORUM_" not in combined
    assert "$COPILOT_" not in combined
    assert _shell_single_quote(str(launch_agent)) in howto
    assert _shell_single_quote(str(run_dir / "coding-agent-config")) in howto
    assert str(env_file) in howto
    assert _shell_single_quote(str(env_file)) in howto
    assert "session-123" in combined
    assert str(env_file) in launcher
    assert _shell_single_quote(str(env_file)) in launcher


def test_antigravity_launch_uses_visible_alias_for_hidden_cwd(tmp_path, monkeypatch):
    hidden_root = tmp_path / ".hidden"
    visible_root = tmp_path / "visible-workspaces"
    monkeypatch.setenv("QUORUM_ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT", str(visible_root))

    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_antigravity_agent(coding_agents_dir, session_log_dir, normalizer="claude")
    (coding_agents_dir / "antigravity-context" / "HOWTO.md").write_text(
        'launch from "$QUORUM_AGENT_CWD"\n'
    )
    (coding_agents_dir / "antigravity-context" / "launch-agent").write_text(
        '#!/usr/bin/env bash\ncd "$QUORUM_AGENT_CWD"\n'
    )
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = hidden_root / "results"
    captured: dict[str, Path] = {}

    def fake_invoke(*, launch_cwd, run_dir, **_kwargs):
        captured["launch_cwd"] = launch_cwd
        (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
        return GauntletResult(status="pass")

    with (
        patch("quorum.runner._seed_antigravity_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    rd = next(out_root.iterdir())
    workdir = rd / "coding-agent-workdir"
    launch_cwd = captured["launch_cwd"]
    assert launch_cwd.is_symlink()
    assert launch_cwd.resolve() == workdir.resolve()
    assert str(launch_cwd).startswith(str(visible_root))

    record = json.loads((rd / "antigravity-visible-launch-cwd.json").read_text())
    assert record["launch_cwd"] == str(workdir)
    assert record["visible_launch_cwd"] == str(launch_cwd)

    howto = (rd / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
    shim = (rd / "gauntlet-agent" / "context" / "launch-agent").read_text()
    assert str(launch_cwd) in howto
    assert str(launch_cwd) in shim

    settings = json.loads(
        (rd / "coding-agent-config" / ".gemini" / "antigravity-cli" / "settings.json").read_text()
    )
    assert str(launch_cwd) in settings["trustedWorkspaces"]
    assert str(workdir.resolve()) in settings["trustedWorkspaces"]


def test_antigravity_settings_trusts_symlink_alias_and_target(tmp_path):
    cfg = tmp_path / "cfg"
    target = tmp_path / "target-workdir"
    target.mkdir()
    alias = tmp_path / "visible-workdir"
    alias.symlink_to(target, target_is_directory=True)

    _write_antigravity_settings(cfg, alias)

    settings = json.loads((cfg / ".gemini" / "antigravity-cli" / "settings.json").read_text())
    assert str(alias) in settings["trustedWorkspaces"]
    assert str(target.resolve()) in settings["trustedWorkspaces"]


class TestSeedAgentConfigDir:
    def test_mkdir_empty_when_no_skeleton(self, tmp_path):
        dest = tmp_path / "agent-config"
        _seed_agent_config_dir(
            _tcfg("anything"),
            tmp_path / "no-fixtures",
            dest,
            tmp_path,
            run_dir=tmp_path / "run-dir",
        )
        assert dest.is_dir()
        assert list(dest.iterdir()) == []

    def test_copies_skeleton_and_injects_workdir_trust_for_claude(self, tmp_path):
        skel = tmp_path / "claude-home-skeleton"
        skel.mkdir()
        (skel / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        dest = tmp_path / "agent-config"

        _seed_agent_config_dir(
            _tcfg("claude"),
            tmp_path,
            dest,
            workdir,
            run_dir=tmp_path / "run-dir",
        )

        cfg = json.loads((dest / ".claude.json").read_text())
        assert cfg["hasCompletedOnboarding"] is True
        # Per-project trust keyed by canonical (resolved) workdir path.
        entry = cfg["projects"][str(workdir.resolve())]
        assert entry["hasTrustDialogAccepted"] is True

    def test_claude_family_variant_uses_claude_skeleton_and_auth(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        skel = tmp_path / "claude-home-skeleton"
        skel.mkdir()
        (skel / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        dest = tmp_path / "agent-config"
        cfg = CodingAgentConfig(
            name="claude-haiku",
            runtime_family="claude",
            binary="echo",
            agent_config_env="CLAUDE_CONFIG_DIR",
            session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
            session_log_glob="**/*.jsonl",
            normalizer="claude",
            required_env=("ANTHROPIC_API_KEY",),
            model="claude-haiku-4-5-20251001",
            max_time=None,
            project_prompt=None,
        )

        runtime = _seed_agent_config_dir(
            cfg,
            tmp_path,
            dest,
            workdir,
            run_dir=tmp_path / "run-dir",
        )

        env_path = dest / CLAUDE_ENV_FILE_NAME
        claude_config = json.loads((dest / ".claude.json").read_text())
        assert claude_config["hasCompletedOnboarding"] is True
        assert claude_config["projects"][str(workdir.resolve())]["hasTrustDialogAccepted"] is True
        assert claude_config["customApiKeyResponses"]["approved"] == ["sk-test-key"]
        assert env_path.read_text() == "ANTHROPIC_API_KEY='sk-test-key'\n"
        assert oct(env_path.stat().st_mode & 0o777) == "0o600"
        assert runtime.substitutions["$CLAUDE_ENV_FILE"] == str(env_path)
        assert runtime.substitutions["$CLAUDE_ENV_FILE_SH"] == _shell_single_quote(str(env_path))

    def test_claude_target_writes_api_key_env_file_when_required(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        cfg = CodingAgentConfig(
            name="claude",
            runtime_family="claude",
            binary="claude",
            agent_config_env="CLAUDE_CONFIG_DIR",
            session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
            session_log_glob="**/*.jsonl",
            normalizer="claude",
            required_env=("ANTHROPIC_API_KEY",),
            model="opus",
            max_time=None,
            project_prompt=None,
        )
        dest = tmp_path / "agent-config"

        runtime = _seed_agent_config_dir(
            cfg,
            _empty_skeleton(tmp_path),
            dest,
            tmp_path / "workdir",
            run_dir=tmp_path / "run-dir",
        )

        env_path = dest / CLAUDE_ENV_FILE_NAME
        assert env_path.read_text() == "ANTHROPIC_API_KEY='sk-test-key'\n"
        assert oct(env_path.stat().st_mode & 0o777) == "0o600"
        assert runtime.substitutions["$CLAUDE_ENV_FILE"] == str(env_path)
        assert runtime.substitutions["$CLAUDE_ENV_FILE_SH"] == _shell_single_quote(str(env_path))
        claude_config = json.loads((dest / ".claude.json").read_text())
        assert claude_config["customApiKeyResponses"]["approved"] == ["sk-test-key"]
        assert claude_config["customApiKeyResponses"]["rejected"] == []

    def test_claude_seed_raises_without_api_key_when_required(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        cfg = CodingAgentConfig(
            name="claude",
            runtime_family="claude",
            binary="claude",
            agent_config_env="CLAUDE_CONFIG_DIR",
            session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
            session_log_glob="**/*.jsonl",
            normalizer="claude",
            required_env=("ANTHROPIC_API_KEY",),
            model="opus",
            max_time=None,
            project_prompt=None,
        )

        with pytest.raises(RunnerError, match="ANTHROPIC_API_KEY"):
            _seed_agent_config_dir(
                cfg,
                _empty_skeleton(tmp_path),
                tmp_path / "agent-config",
                tmp_path / "workdir",
                run_dir=tmp_path / "run-dir",
            )

    def test_non_claude_target_skips_trust_injection(self, tmp_path):
        # Codex gets no .claude.json trust injection (that is claude-only);
        # codex auth + plugin-hook seeding are stubbed (own tests below).
        skel = tmp_path / "codex-home-skeleton"
        skel.mkdir()
        (skel / "config.toml").write_text("[features]\nplugins = true\n")
        dest = tmp_path / "agent-config"

        with (
            patch("quorum.runner._seed_codex_auth"),
            patch("quorum.runner._seed_codex_plugin_hooks"),
        ):
            _seed_agent_config_dir(
                _tcfg("codex"),
                tmp_path,
                dest,
                tmp_path / "workdir",
                run_dir=tmp_path / "run-dir",
            )

        assert (dest / "config.toml").exists()
        assert not (dest / ".claude.json").exists()

    def test_codex_target_seeds_subscription_auth_from_signed_in_home(self, tmp_path, monkeypatch):
        # Codex evals should use ChatGPT subscription auth, not Platform API-key
        # auth. The per-run CODEX_HOME copies the signed-in account auth state.
        home = tmp_path / "home"
        source = home / ".codex" / "auth.json"
        source.parent.mkdir(parents=True)
        source.write_text(
            json.dumps(
                {
                    "auth_mode": "chatgpt",
                    "OPENAI_API_KEY": None,
                    "tokens": {
                        "access_token": "access",
                        "refresh_token": "refresh",
                        "id_token": "id",
                        "account_id": "acct",
                    },
                    "last_refresh": "2026-06-12T00:00:00.000Z",
                }
            )
        )
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
        dest = tmp_path / "agent-config"
        with (
            patch("quorum.runner.subprocess.run") as mock_run,
            patch("quorum.runner._seed_codex_plugin_hooks"),
        ):
            _seed_agent_config_dir(
                _tcfg("codex"),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )
        mock_run.assert_not_called()
        assert json.loads((dest / "auth.json").read_text())["auth_mode"] == "chatgpt"
        assert (dest / "auth.json").stat().st_mode & 0o777 == 0o600

    def test_codex_seed_rejects_api_key_auth_state(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        source = home / ".codex" / "auth.json"
        source.parent.mkdir(parents=True)
        source.write_text(json.dumps({"auth_mode": "api_key", "OPENAI_API_KEY": "sk-test-key"}))
        monkeypatch.setenv("HOME", str(home))
        dest = tmp_path / "agent-config"
        with (
            patch("quorum.runner._seed_codex_plugin_hooks"),
            pytest.raises(RunnerError, match="ChatGPT subscription auth"),
        ):
            _seed_agent_config_dir(
                _tcfg("codex"),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_codex_seed_raises_without_signed_in_home(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        dest = tmp_path / "agent-config"
        with (
            patch("quorum.runner._seed_codex_plugin_hooks"),
            pytest.raises(RunnerError, match="Codex ChatGPT subscription auth"),
        ):
            _seed_agent_config_dir(
                _tcfg("codex"),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_codex_target_installs_plugin_hooks(self, tmp_path, monkeypatch):
        # The runner stages Superpowers as a trusted plugin hook into the
        # per-run CODEX_HOME — the codex equivalent of claude's Superpowers
        # access. The heavy install ceremony is delegated to the shared
        # setup_helpers function; here we assert the wiring.
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        dest = tmp_path / "agent-config"
        workdir = tmp_path / "wd"
        with (
            patch("quorum.runner._seed_codex_auth"),
            patch("quorum.runner.install_codex_superpowers_plugin_hooks") as mock_install,
        ):
            _seed_agent_config_dir(
                _tcfg("codex"),
                tmp_path,
                dest,
                workdir,
                run_dir=tmp_path / "run-dir",
            )
        (cmd_workdir, cmd_sp), kwargs = mock_install.call_args
        assert cmd_workdir == workdir
        assert cmd_sp == str(tmp_path / "sp")
        assert kwargs["codex_home"] == dest

    def test_codex_plugin_hooks_raise_without_superpowers_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        dest = tmp_path / "agent-config"
        with (
            patch("quorum.runner._seed_codex_auth"),
            pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"),
        ):
            _seed_agent_config_dir(
                _tcfg("codex"),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_antigravity_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
            _seed_antigravity_config(tmp_path / "cfg", tmp_path / "wd")

    def test_antigravity_target_seeds_config(self, tmp_path):
        dest = tmp_path / "agent-config"
        with patch("quorum.runner._seed_antigravity_config") as mock_seed:
            _seed_agent_config_dir(
                _antigravity_tcfg(),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )
        mock_seed.assert_called_once_with(dest, tmp_path / "wd")

    def test_pi_target_seeds_run_local_auth_files(self, tmp_path, monkeypatch):
        superpowers = _make_superpowers_pi_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
        monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
        monkeypatch.setenv("PI_MODEL", "gpt-5.4")
        monkeypatch.setenv("PI_API_KEY", "secret-pi-key")
        monkeypatch.setenv("AZURE_OPENAI_BASE_URL", "https://example.openai.azure.com")
        monkeypatch.setattr(
            "quorum.runner.shutil.which",
            lambda name: "/usr/bin/pi" if name == "pi" else None,
        )

        dest = tmp_path / "cfg"
        _seed_agent_config_dir(
            _pi_tcfg(),
            tmp_path,
            dest,
            tmp_path / "wd",
            run_dir=tmp_path / "run-dir",
        )

        auth_path = dest / "auth.json"
        auth = json.loads(auth_path.read_text())
        assert auth == {"azure-openai-responses": {"type": "api_key", "key": "$PI_API_KEY"}}
        assert oct(auth_path.stat().st_mode & 0o777) == "0o600"
        assert "secret-pi-key" not in auth_path.read_text()

        settings = json.loads((dest / "settings.json").read_text())
        assert settings["defaultProvider"] == "azure-openai-responses"
        assert settings["defaultModel"] == "gpt-5.4"

        env_path = dest / "pi.env"
        env_text = env_path.read_text()
        assert "secret-pi-key" in env_text
        assert "AZURE_OPENAI_BASE_URL=https://example.openai.azure.com" in env_text
        assert oct(env_path.stat().st_mode & 0o777) == "0o600"
        assert (dest / "sessions").is_dir()

    def test_pi_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
        monkeypatch.setenv("PI_MODEL", "gpt-5.4")
        monkeypatch.setenv("PI_API_KEY", "secret-pi-key")

        with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
            _seed_agent_config_dir(
                _pi_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_pi_seed_requires_api_key_env(self, tmp_path, monkeypatch):
        superpowers = _make_superpowers_pi_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
        monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
        monkeypatch.setenv("PI_MODEL", "gpt-5.4")
        monkeypatch.setenv("AZURE_OPENAI_BASE_URL", "https://example.openai.azure.com")
        monkeypatch.delenv("PI_API_KEY", raising=False)

        with pytest.raises(RunnerError, match="PI_API_KEY"):
            _seed_agent_config_dir(
                _pi_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_pi_seed_requires_azure_endpoint_or_resource_name(self, tmp_path, monkeypatch):
        superpowers = _make_superpowers_pi_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
        monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
        monkeypatch.setenv("PI_MODEL", "gpt-5.4")
        monkeypatch.setenv("PI_API_KEY", "secret-pi-key")
        monkeypatch.delenv("AZURE_OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("AZURE_OPENAI_RESOURCE_NAME", raising=False)
        monkeypatch.setattr(
            "quorum.runner.shutil.which",
            lambda name: "/usr/bin/pi" if name == "pi" else None,
        )

        with pytest.raises(
            RunnerError,
            match="AZURE_OPENAI_BASE_URL.*AZURE_OPENAI_RESOURCE_NAME",
        ):
            _seed_agent_config_dir(
                _pi_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_gemini_target_seeds_config(self, tmp_path):
        dest = tmp_path / "agent-config"
        with patch("quorum.runner._seed_gemini_config") as mock_seed:
            _seed_agent_config_dir(
                _gemini_tcfg(),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )
        mock_seed.assert_called_once_with(dest, tmp_path / "wd")

    def test_gemini_seed_requires_api_key(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")

        with pytest.raises(RunnerError, match="GEMINI_API_KEY") as excinfo:
            _seed_gemini_config(tmp_path / "cfg", tmp_path / "wd")

        assert excinfo.value.stage == "setup"

    def test_gemini_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)

        with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT") as excinfo:
            _seed_gemini_config(tmp_path / "cfg", tmp_path / "wd")

        assert excinfo.value.stage == "setup"

    def test_gemini_settings_select_api_key_auth(self, tmp_path):
        cfg = tmp_path / "cfg"

        _write_gemini_settings(cfg)

        settings = json.loads((cfg / ".gemini" / "settings.json").read_text())
        assert settings["security"]["auth"]["selectedType"] == "gemini-api-key"

    def test_gemini_env_file_quotes_api_key_and_is_private(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-'key")

        env_file = _write_gemini_env_file(tmp_path / "cfg")

        assert env_file.name == ".gemini-env"
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
        assert env_file.read_text() == "GEMINI_API_KEY='test-'\"'\"'key'\n"

    def test_gemini_env_file_uses_restrictive_open_mode(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        real_open = os.open
        seen: dict[str, int] = {}

        def capture_open(path, flags, mode=0o777):
            seen["flags"] = flags
            seen["mode"] = mode
            return real_open(path, flags, mode)

        with patch("quorum.runner.os.open", side_effect=capture_open):
            env_file = _write_gemini_env_file(tmp_path / "cfg")

        assert env_file.read_text() == "GEMINI_API_KEY='test-key'\n"
        assert seen["mode"] == 0o600
        assert seen["flags"] & os.O_WRONLY
        assert seen["flags"] & os.O_CREAT
        assert seen["flags"] & os.O_TRUNC
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

    def test_copilot_auth_prefers_explicit_copilot_token(self):
        with patch("quorum.runner._gh_auth_token", side_effect=AssertionError("unexpected gh")):
            values, secret_names, secret_values = _resolve_copilot_auth_env(
                {
                    "COPILOT_GITHUB_TOKEN": "copilot-token",
                    "GH_TOKEN": "gh-token",
                    "GITHUB_TOKEN": "github-token",
                }
            )

        assert values == {"COPILOT_GITHUB_TOKEN": "copilot-token"}
        assert secret_names == ("COPILOT_GITHUB_TOKEN",)
        assert secret_values == ("copilot-token",)

    def test_copilot_auth_uses_gh_auth_token_fallback(self, monkeypatch):
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            assert cmd == ["gh", "auth", "token"]
            assert kwargs["text"] is True
            assert kwargs["capture_output"] is True
            assert kwargs["timeout"] == 10
            return subprocess.CompletedProcess(cmd, 0, " gh-token \n", "")

        monkeypatch.setattr("quorum.runner.subprocess.run", fake_run)

        assert _gh_auth_token() == "gh-token"
        values, secret_names, secret_values = _resolve_copilot_auth_env({})
        assert values == {"COPILOT_GITHUB_TOKEN": "gh-token"}
        assert secret_names == ("COPILOT_GITHUB_TOKEN",)
        assert secret_values == ("gh-token",)

    def test_copilot_auth_provider_mode_does_not_require_github_token(self):
        values, secret_names, secret_values = _resolve_copilot_auth_env(
            {
                "COPILOT_PROVIDER_BASE_URL": "http://127.0.0.1:4000",
                "COPILOT_PROVIDER_TYPE": "openai",
                "COPILOT_PROVIDER_API_KEY": "provider-key",
                "COPILOT_PROVIDER_BEARER_TOKEN": "provider-bearer",
                "COPILOT_OFFLINE": "YES",
                "COPILOT_MODEL": "gpt-test",
                "GH_TOKEN": "ignored-gh-token",
            }
        )

        assert values == {
            "COPILOT_PROVIDER_BASE_URL": "http://127.0.0.1:4000",
            "COPILOT_PROVIDER_TYPE": "openai",
            "COPILOT_PROVIDER_API_KEY": "provider-key",
            "COPILOT_PROVIDER_BEARER_TOKEN": "provider-bearer",
            "COPILOT_OFFLINE": "YES",
            "COPILOT_MODEL": "gpt-test",
        }
        assert secret_names == ("COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN")
        assert secret_values == ("provider-key", "provider-bearer")

    def test_copilot_auth_offline_requires_provider_base_url(self):
        with pytest.raises(RunnerError, match="COPILOT_OFFLINE=true") as excinfo:
            _resolve_copilot_auth_env({"COPILOT_OFFLINE": "1"})

        assert excinfo.value.stage == "setup"

    def test_copilot_auth_errors_without_supported_source(self, monkeypatch):
        monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "host-token")
        with (
            patch("quorum.runner._gh_auth_token", return_value=None),
            pytest.raises(RunnerError, match="no Copilot auth found") as excinfo,
        ):
            _resolve_copilot_auth_env({})

        assert excinfo.value.stage == "setup"
        assert "sk-" not in str(excinfo.value)

    def test_copilot_env_file_quotes_values_and_is_private(self, tmp_path):
        env_file = _write_copilot_env_file(
            tmp_path / "cfg",
            {
                "COPILOT_MODEL": "o'clock model",
                "COPILOT_GITHUB_TOKEN": "token with spaces",
            },
        )

        assert env_file.name == COPILOT_ENV_FILE_NAME
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
        assert env_file.read_text() == (
            "COPILOT_GITHUB_TOKEN='token with spaces'\nCOPILOT_MODEL='o'\"'\"'clock model'\n"
        )

    def test_copilot_env_file_uses_restrictive_open_flags(self, tmp_path):
        real_open = os.open
        seen: dict[str, int] = {}

        def capture_open(path, flags, mode=0o777):
            seen["flags"] = flags
            seen["mode"] = mode
            return real_open(path, flags, mode)

        with patch("quorum.runner.os.open", side_effect=capture_open):
            env_file = _write_copilot_env_file(
                tmp_path / "cfg",
                {"COPILOT_GITHUB_TOKEN": "token"},
            )

        assert env_file.read_text() == "COPILOT_GITHUB_TOKEN='token'\n"
        assert seen["mode"] == 0o600
        assert seen["flags"] & os.O_WRONLY
        assert seen["flags"] & os.O_CREAT
        assert seen["flags"] & os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            assert seen["flags"] & os.O_NOFOLLOW
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

    def test_copilot_env_file_chmods_existing_file_before_writing_secret(self, tmp_path):
        cfg = tmp_path / "cfg"
        cfg.mkdir()
        env_file = cfg / COPILOT_ENV_FILE_NAME
        env_file.write_text("old\n")
        env_file.chmod(0o666)
        real_fdopen = os.fdopen

        class ModeCheckingFile:
            def __init__(self, wrapped):
                self._wrapped = wrapped

            def __enter__(self):
                self._wrapped.__enter__()
                return self

            def __exit__(self, *args):
                return self._wrapped.__exit__(*args)

            def write(self, value):
                assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
                return self._wrapped.write(value)

            def flush(self):
                return self._wrapped.flush()

            def fileno(self):
                return self._wrapped.fileno()

        with patch(
            "quorum.runner.os.fdopen",
            side_effect=lambda fd, *args, **kwargs: ModeCheckingFile(
                real_fdopen(fd, *args, **kwargs)
            ),
        ):
            _write_copilot_env_file(cfg, {"COPILOT_GITHUB_TOKEN": "secret"})

        assert env_file.read_text() == "COPILOT_GITHUB_TOKEN='secret'\n"
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

    def test_copilot_seed_stages_plugin_without_plugin_list_subprocess(self, tmp_path, monkeypatch):
        sp = _make_superpowers_copilot_root(tmp_path)
        _clear_copilot_auth_env(monkeypatch)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "seed-secret")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")
        monkeypatch.setattr(
            "quorum.runner.subprocess.run",
            lambda *args, **kwargs: (_ for _ in ()).throw(
                AssertionError("copilot plugin list should not run")
            ),
        )
        cfg = tmp_path / "cfg"
        session_id = str(uuid.uuid4())

        provisioning = _seed_copilot_config(cfg, tmp_path / "wd", session_id)

        assert isinstance(provisioning, CopilotProvisioning)
        assert provisioning.session_id == session_id
        assert provisioning.env_file == cfg / COPILOT_ENV_FILE_NAME
        assert provisioning.secret_names == ("COPILOT_GITHUB_TOKEN",)
        assert provisioning.secret_values == ("seed-secret",)
        assert stat.S_IMODE(provisioning.env_file.stat().st_mode) == 0o600
        for rel in COPILOT_REQUIRED_SUPERPOWERS_FILES:
            staged = cfg / "plugins" / "superpowers" / rel
            assert staged.read_text() == f"{rel}\n"
            assert staged.resolve().is_relative_to(cfg.resolve())
        extra_staged = cfg / "plugins" / "superpowers" / "skills" / "extra-skill"
        extra_source = sp / "skills" / "extra-skill"
        assert (extra_staged / "references" / "extra.md").read_text() == "extra reference\n"
        (extra_source / "references" / "extra.md").unlink()
        (extra_source / "SKILL.md").write_text("mutated source\n")
        assert (extra_staged / "references" / "extra.md").read_text() == "extra reference\n"
        assert not (extra_staged / "SKILL.md").exists()
        for rel in (".quorum", ".cache", "logs", "plugins", "session-state"):
            assert (cfg / rel).is_dir()

    def test_copilot_seed_errors_when_required_plugin_file_missing(self, tmp_path):
        sp = _make_superpowers_copilot_root(tmp_path)
        missing = sp / "skills" / "using-superpowers" / "references" / "copilot-tools.md"
        missing.unlink()

        with pytest.raises(RunnerError, match="copilot-tools.md") as excinfo:
            _require_copilot_superpowers_root(str(sp))

        assert excinfo.value.stage == "setup"

    def test_copilot_seed_rejects_skill_symlink(self, tmp_path):
        sp = _make_superpowers_copilot_root(tmp_path)
        (sp / "skills" / "brainstorming" / "escape").symlink_to(tmp_path)

        with pytest.raises(RunnerError, match="symlink") as excinfo:
            _stage_copilot_superpowers_plugin(sp, tmp_path / "cfg")

        assert excinfo.value.stage == "setup"

    def test_copilot_seed_rejects_skills_root_symlink(self, tmp_path):
        sp = _make_superpowers_copilot_root(tmp_path)
        real_skills = tmp_path / "real-skills"
        shutil.move(str(sp / "skills"), real_skills)
        (sp / "skills").symlink_to(real_skills, target_is_directory=True)

        with pytest.raises(RunnerError, match="symlink") as excinfo:
            _stage_copilot_superpowers_plugin(sp, tmp_path / "cfg")

        assert excinfo.value.stage == "setup"

    @pytest.mark.parametrize(
        "source_rel",
        [
            ".claude-plugin",
            ".claude-plugin/plugin.json",
            "hooks/hooks.json",
            "hooks/run-hook.cmd",
            "hooks/session-start",
        ],
    )
    def test_copilot_seed_rejects_hook_and_plugin_source_symlinks(self, tmp_path, source_rel):
        sp = _make_superpowers_copilot_root(tmp_path)
        source = sp / source_rel
        target = tmp_path / "symlink-target"
        if source.is_dir():
            shutil.move(str(source), target)
            source.symlink_to(target, target_is_directory=True)
        else:
            target.write_text("external\n")
            source.unlink()
            source.symlink_to(target)

        with pytest.raises(RunnerError, match="symlink") as excinfo:
            _stage_copilot_superpowers_plugin(sp, tmp_path / "cfg")

        assert excinfo.value.stage == "setup"

    def test_copilot_seed_rejects_stale_expected_session_state(self, tmp_path, monkeypatch):
        sp = _make_superpowers_copilot_root(tmp_path)
        _clear_copilot_auth_env(monkeypatch)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "seed-secret")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")
        monkeypatch.setattr(
            "quorum.runner.subprocess.run",
            lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("unexpected subprocess")),
        )
        cfg = tmp_path / "cfg"
        session_id = str(uuid.uuid4())
        stale = cfg / "session-state" / session_id / "events.jsonl"
        stale.parent.mkdir(parents=True)
        stale.write_text("{}\n")

        with pytest.raises(RunnerError, match="pre-existing Copilot session-state") as excinfo:
            _seed_copilot_config(cfg, tmp_path / "wd", session_id)

        assert excinfo.value.stage == "setup"

    def test_copilot_gauntlet_env_excludes_auth_provider_otel_and_unrelated_secrets(self):
        host_env = {
            "PATH": "/bin",
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "GH_HOST": "github.enterprise.test",
            "COPILOT_GH_HOST": "copilot.enterprise.test",
            "HTTP_PROXY": "http://proxy.test:8080",
            "HTTPS_PROXY": "http://proxy.test:8080",
            "all_proxy": "socks5://proxy.test:1080",
            "no_proxy": "localhost,127.0.0.1",
            "SSL_CERT_FILE": "/certs/ca.pem",
            "NODE_EXTRA_CA_CERTS": "/certs/node.pem",
            "ANTHROPIC_API_KEY": "anthropic-key",
            "OPENAI_API_KEY": "openai-key",
            "OPENAI_BASE_URL": "https://openai.test/v1",
            "COPILOT_MODEL": "gpt-test",
            "COPILOT_OFFLINE": "1",
            "COPILOT_GITHUB_TOKEN": "token",
            "GH_TOKEN": "gh-token",
            "GITHUB_TOKEN": "github-token",
            "COPILOT_PROVIDER_API_KEY": "provider-key",
            "COPILOT_PROVIDER_BEARER_TOKEN": "provider-bearer",
            "COPILOT_PROVIDER_BASE_URL": "http://provider",
            "OTEL_EXPORTER_OTLP_HEADERS": "secret",
            "AWS_SECRET_ACCESS_KEY": "aws-secret",
        }

        assert _copilot_gauntlet_env(host_env) == {
            "PATH": "/bin",
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "GH_HOST": "github.enterprise.test",
            "COPILOT_GH_HOST": "copilot.enterprise.test",
            "HTTP_PROXY": "http://proxy.test:8080",
            "HTTPS_PROXY": "http://proxy.test:8080",
            "all_proxy": "socks5://proxy.test:1080",
            "no_proxy": "localhost,127.0.0.1",
            "SSL_CERT_FILE": "/certs/ca.pem",
            "NODE_EXTRA_CA_CERTS": "/certs/node.pem",
            "ANTHROPIC_API_KEY": "anthropic-key",
            "OPENAI_API_KEY": "openai-key",
            "OPENAI_BASE_URL": "https://openai.test/v1",
            "COPILOT_MODEL": "gpt-test",
            "COPILOT_OFFLINE": "1",
        }
        for name in COPILOT_SECRET_ENV_NAMES:
            assert name not in _copilot_gauntlet_env(host_env)
        for name in (
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "COPILOT_PROVIDER_BASE_URL",
            "COPILOT_PROVIDER_BEARER_TOKEN",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "AWS_SECRET_ACCESS_KEY",
        ):
            assert name not in _copilot_gauntlet_env(host_env)

    def test_copilot_gauntlet_env_rejects_credentialed_proxy(self):
        with pytest.raises(RunnerError, match="credentialed proxy") as excinfo:
            _copilot_gauntlet_env(
                {
                    "PATH": "/bin",
                    "HTTP_PROXY": "http://user:pass@proxy.example:8080",
                }
            )

        assert excinfo.value.stage == "setup"

    def test_copilot_leak_scan_reports_only_non_excluded_secret_paths(self, tmp_path):
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        env_file = run_dir / "coding-agent-config" / COPILOT_ENV_FILE_NAME
        env_file.parent.mkdir()
        env_file.write_text("COPILOT_GITHUB_TOKEN='secret-token'\n")
        leaked = run_dir / "gauntlet-agent" / "transcript.txt"
        leaked.parent.mkdir()
        leaked.write_text("observed secret-token in output")
        safe = run_dir / "gauntlet-agent" / "safe.txt"
        safe.write_text("no secrets here")

        leaks = _scan_copilot_secret_leaks(
            run_dir,
            secret_values=("secret-token",),
            excluded_paths=(env_file,),
        )

        assert leaks == (leaked,)

    def test_gemini_seed_links_extension_lists_it_and_verifies_metadata(
        self, tmp_path, monkeypatch
    ):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **kwargs):
            assert kwargs["cwd"] == cfg
            assert kwargs["env"]["GEMINI_CLI_HOME"] == str(cfg)
            assert kwargs["env"]["GEMINI_CLI_TRUST_WORKSPACE"] == "true"
            assert kwargs["env"]["GEMINI_DEFAULT_AUTH_TYPE"] == "gemini-api-key"
            if cmd[:3] == ["gemini", "extensions", "link"]:
                assert cmd == ["gemini", "extensions", "link", str(sp), "--consent"]
                _write_gemini_extension_metadata(cfg)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            assert cmd == ["gemini", "extensions", "list"]
            return subprocess.CompletedProcess(cmd, 0, "superpowers (5.1.0)\t/path\tenabled\n", "")

        with patch("quorum.runner.subprocess.run", side_effect=fake_run) as mock_run:
            _seed_gemini_config(cfg, tmp_path / "wd")

        assert mock_run.call_count == 2
        assert (cfg / ".gemini" / "settings.json").exists()
        assert (cfg / ".gemini-env").exists()
        assert _gemini_transcripts(cfg) == []

    def test_gemini_seed_oauth_copies_credentials_and_uses_oauth_auth(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        source_home = tmp_path / "source-gemini"
        source_home.mkdir()
        (source_home / "oauth_creds.json").write_text('{"refresh_token":"test-refresh"}')
        (source_home / "google_accounts.json").write_text('{"active":"me@example.test"}')
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_AUTH_TYPE", "oauth-personal")
        monkeypatch.setenv("GEMINI_OAUTH_HOME", str(source_home))
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **kwargs):
            assert kwargs["cwd"] == cfg
            assert kwargs["env"]["GEMINI_CLI_HOME"] == str(cfg)
            assert kwargs["env"]["GEMINI_CLI_TRUST_WORKSPACE"] == "true"
            assert kwargs["env"]["GEMINI_DEFAULT_AUTH_TYPE"] == "oauth-personal"
            if cmd[:3] == ["gemini", "extensions", "link"]:
                _write_gemini_extension_metadata(cfg)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            assert cmd == ["gemini", "extensions", "list"]
            return subprocess.CompletedProcess(cmd, 0, "", "✓ superpowers (5.1.0)\n")

        with patch("quorum.runner.subprocess.run", side_effect=fake_run):
            _seed_gemini_config(cfg, tmp_path / "wd")

        settings = json.loads((cfg / ".gemini" / "settings.json").read_text())
        assert settings["security"]["auth"]["selectedType"] == "oauth-personal"
        copied_creds = cfg / ".gemini" / "oauth_creds.json"
        copied_accounts = cfg / ".gemini" / "google_accounts.json"
        assert copied_creds.read_text() == '{"refresh_token":"test-refresh"}'
        assert copied_accounts.read_text() == '{"active":"me@example.test"}'
        assert stat.S_IMODE(copied_creds.stat().st_mode) == 0o600
        assert stat.S_IMODE(copied_accounts.stat().st_mode) == 0o600
        assert (cfg / ".gemini-env").read_text() == ""

    def test_gemini_seed_redacts_api_key_from_link_failure(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-secret-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")

        with (
            patch(
                "quorum.runner.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    ["gemini", "extensions", "link"], 1, "", "bad test-secret-key"
                ),
            ),
            pytest.raises(RunnerError) as excinfo,
        ):
            _seed_gemini_config(tmp_path / "cfg", tmp_path / "wd")

        assert excinfo.value.stage == "setup"
        assert "extensions link failed" in str(excinfo.value)
        assert "test-secret-key" not in str(excinfo.value)

    def test_gemini_seed_redacts_api_key_before_truncating_link_failure(
        self, tmp_path, monkeypatch
    ):
        sp = _make_gemini_superpowers_root(tmp_path)
        api_key = "sk-" + ("secret" * 80)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", api_key)
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")

        with (
            patch(
                "quorum.runner.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    ["gemini", "extensions", "link"], 1, "", f"bad {api_key}"
                ),
            ),
            pytest.raises(RunnerError) as excinfo,
        ):
            _seed_gemini_config(tmp_path / "cfg", tmp_path / "wd")

        message = str(excinfo.value)
        assert "[redacted]" in message
        assert api_key[:300] not in message

    def test_gemini_seed_redacts_api_key_from_list_failure(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-secret-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **_kwargs):
            if cmd[:3] == ["gemini", "extensions", "link"]:
                _write_gemini_extension_metadata(cfg)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            return subprocess.CompletedProcess(cmd, 1, "", "bad test-secret-key")

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(RunnerError) as excinfo,
        ):
            _seed_gemini_config(cfg, tmp_path / "wd")

        assert excinfo.value.stage == "setup"
        assert "extensions list failed" in str(excinfo.value)
        assert "test-secret-key" not in str(excinfo.value)

    def test_gemini_seed_rejects_substring_extension_list_match(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-secret-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **_kwargs):
            if cmd[:3] == ["gemini", "extensions", "link"]:
                _write_gemini_extension_metadata(cfg)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            return subprocess.CompletedProcess(
                cmd, 0, "not-superpowers (1.0.0)\t/path\tenabled\n", ""
            )

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(RunnerError) as excinfo,
        ):
            _seed_gemini_config(cfg, tmp_path / "wd")

        assert excinfo.value.stage == "setup"
        assert "did not show Superpowers extension" in str(excinfo.value)
        assert "test-secret-key" not in str(excinfo.value)

    def test_gemini_seed_reports_missing_metadata_without_api_key(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-secret-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")

        def fake_run(cmd, **_kwargs):
            return subprocess.CompletedProcess(cmd, 0, "superpowers (5.1.0)\t/path\tenabled\n", "")

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(RunnerError) as excinfo,
        ):
            _seed_gemini_config(tmp_path / "cfg", tmp_path / "wd")

        assert excinfo.value.stage == "setup"
        assert "expected metadata files are missing" in str(excinfo.value)
        assert "test-secret-key" not in str(excinfo.value)

    def test_gemini_extension_list_accepts_status_icon_prefix(self):
        output = "✓ superpowers (5.1.0)\n ID: ext_123\n"

        assert _gemini_extension_list_shows_superpowers(output)

    def test_gemini_seed_accepts_extension_list_on_stderr(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **_kwargs):
            if cmd[:3] == ["gemini", "extensions", "link"]:
                _write_gemini_extension_metadata(cfg)
                return subprocess.CompletedProcess(cmd, 0, "", "")
            return subprocess.CompletedProcess(cmd, 0, "", "✓ superpowers (5.1.0)\n")

        with patch("quorum.runner.subprocess.run", side_effect=fake_run):
            _seed_gemini_config(cfg, tmp_path / "wd")

    def test_gemini_seed_fails_when_provisioning_creates_transcripts(self, tmp_path, monkeypatch):
        sp = _make_gemini_superpowers_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/gemini")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **_kwargs):
            if cmd[:3] == ["gemini", "extensions", "link"]:
                _write_gemini_extension_metadata(cfg)
                transcript_dir = cfg / ".gemini" / "tmp" / "session" / "chats"
                transcript_dir.mkdir(parents=True)
                (transcript_dir / "chat.jsonl").write_text("{}\n")
                return subprocess.CompletedProcess(cmd, 0, "", "")
            return subprocess.CompletedProcess(cmd, 0, "superpowers (5.1.0)\t/path\tenabled\n", "")

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(
                RunnerError,
                match="provisioning unexpectedly wrote transcripts",
            ),
        ):
            _seed_gemini_config(cfg, tmp_path / "wd")

    def test_kimi_target_seeds_config(self, tmp_path):
        dest = tmp_path / "agent-config"
        run_dir = tmp_path / "run-dir"
        with patch("quorum.runner._seed_kimi_config") as mock_seed:
            _seed_agent_config_dir(
                _kimi_tcfg(),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=run_dir,
            )
        mock_seed.assert_called_once_with(dest, run_dir=run_dir, binary="kimi")

    def test_kimi_seed_installs_local_path_superpowers_without_host_state(
        self, tmp_path, monkeypatch
    ):
        home = tmp_path / "home"
        source_home = home / ".kimi-code"
        (source_home / "credentials").mkdir(parents=True)
        (source_home / "config.toml").write_text("must not be read\n")

        superpowers = _make_kimi_superpowers_root(tmp_path)

        dest = tmp_path / "agent-config"
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")

        with (
            patch.dict(
                os.environ,
                {
                    "HOME": str(home),
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight"),
        ):
            runtime = _seed_kimi_config(dest, run_dir=tmp_path / "run", binary="kimi")

        assert (dest / "home").is_dir()
        assert not (dest / "config.toml").exists()
        assert not (dest / "credentials").exists()
        assert not (dest / "oauth").exists()
        installed = json.loads((dest / "plugins" / "installed.json").read_text())
        plugin = installed["plugins"][0]
        assert plugin["id"] == "superpowers"
        assert Path(plugin["root"]).resolve() == superpowers.resolve()
        assert plugin["source"] == "local-path"
        assert plugin["enabled"] is True
        assert runtime.env_file is not None
        assert runtime.env_file.exists()

    def test_kimi_seed_runs_auth_preflight_without_sentinel(self, tmp_path, monkeypatch):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

            mock_preflight.assert_called_once_with(
                kimi_binary="/usr/bin/kimi",
                kimi_model_env={
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "KIMI_MODEL_NAME": "kimi-for-coding",
                    "KIMI_MODEL_PROVIDER_TYPE": "kimi",
                    "KIMI_MODEL_BASE_URL": "https://api.kimi.com/coding/v1",
                    "KIMI_MODEL_MAX_CONTEXT_SIZE": "262144",
                    "KIMI_MODEL_CAPABILITIES": "thinking,image_in,video_in,tool_use",
                    "KIMI_MODEL_DEFAULT_THINKING": "true",
                    "KIMI_DISABLE_TELEMETRY": "1",
                    "KIMI_DISABLE_CRON": "1",
                    "KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT": "false",
                },
                base_env=os.environ,
            )

    def test_kimi_seed_skips_auth_preflight_with_sentinel(self, tmp_path, monkeypatch):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")
        sentinel = tmp_path / "sentinel.json"
        kimi_env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-kimi-key"})
        sentinel.write_text(
            json.dumps(
                kimi_preflight_sentinel_payload(
                    kimi_binary="/usr/bin/kimi",
                    kimi_model_env=kimi_env,
                    preflight_token="batch-token",
                )
            )
            + "\n"
        )

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(sentinel),
                    "QUORUM_KIMI_PREFLIGHT_TOKEN": "batch-token",
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

            mock_preflight.assert_not_called()

    def test_kimi_seed_requires_existing_preflight_sentinel(self, tmp_path, monkeypatch):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(tmp_path / "missing-sentinel.json"),
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
            pytest.raises(RunnerError, match="Kimi preflight sentinel missing") as excinfo,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

        assert excinfo.value.stage == "setup"
        mock_preflight.assert_not_called()

    def test_kimi_seed_rejects_malformed_preflight_sentinel(self, tmp_path, monkeypatch):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")
        sentinel = tmp_path / "sentinel.json"
        sentinel.write_text("{not-json")

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(sentinel),
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
            pytest.raises(RunnerError, match="valid JSON") as excinfo,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

        assert excinfo.value.stage == "setup"
        mock_preflight.assert_not_called()

    def test_kimi_seed_rejects_mismatched_preflight_sentinel(self, tmp_path, monkeypatch):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")
        kimi_env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-kimi-key"})
        payload = kimi_preflight_sentinel_payload(
            kimi_binary="/usr/bin/kimi",
            kimi_model_env=kimi_env,
            preflight_token="batch-token",
        )
        payload["model"] = "other-model"
        sentinel = tmp_path / "sentinel.json"
        sentinel.write_text(json.dumps(payload) + "\n")

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(sentinel),
                    "QUORUM_KIMI_PREFLIGHT_TOKEN": "batch-token",
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
            pytest.raises(RunnerError, match="model") as excinfo,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

        assert excinfo.value.stage == "setup"
        mock_preflight.assert_not_called()

    def test_kimi_seed_rejects_preflight_sentinel_without_token(self, tmp_path, monkeypatch):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")
        kimi_env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-kimi-key"})
        sentinel = tmp_path / "sentinel.json"
        sentinel.write_text(
            json.dumps(
                kimi_preflight_sentinel_payload(
                    kimi_binary="/usr/bin/kimi",
                    kimi_model_env=kimi_env,
                    preflight_token="batch-token",
                )
            )
            + "\n"
        )

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(sentinel),
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
            pytest.raises(RunnerError, match="token") as excinfo,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

        assert excinfo.value.stage == "setup"
        mock_preflight.assert_not_called()

    def test_kimi_seed_rejects_preflight_sentinel_with_mismatched_token(
        self, tmp_path, monkeypatch
    ):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")
        kimi_env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-kimi-key"})
        sentinel = tmp_path / "sentinel.json"
        sentinel.write_text(
            json.dumps(
                kimi_preflight_sentinel_payload(
                    kimi_binary="/usr/bin/kimi",
                    kimi_model_env=kimi_env,
                    preflight_token="batch-token-a",
                )
            )
            + "\n"
        )

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                    "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(sentinel),
                    "QUORUM_KIMI_PREFLIGHT_TOKEN": "batch-token-b",
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight") as mock_preflight,
            pytest.raises(RunnerError, match="token") as excinfo,
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

        assert excinfo.value.stage == "setup"
        mock_preflight.assert_not_called()

    def test_kimi_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

    def test_kimi_seed_removes_runtime_env_dir_when_effective_config_write_fails(
        self, tmp_path, monkeypatch
    ):
        superpowers = _make_kimi_superpowers_root(tmp_path)
        monkeypatch.setattr("quorum.kimi.shutil.which", lambda name: "/usr/bin/kimi")
        env_dir = tmp_path / "secret-env"
        env_file = env_dir / "kimi-runtime.env"

        def fake_write_env(_env, *, run_dir):
            env_dir.mkdir()
            env_file.write_text("KIMI_MODEL_API_KEY=fake-kimi-key\n")
            return env_file

        with (
            patch.dict(
                os.environ,
                {
                    "PATH": "/usr/bin:/bin",
                    "SUPERPOWERS_ROOT": str(superpowers),
                    "KIMI_MODEL_API_KEY": "fake-kimi-key",
                },
                clear=True,
            ),
            patch("quorum.runner.run_kimi_auth_preflight"),
            patch("quorum.runner.write_kimi_runtime_env_file", side_effect=fake_write_env),
            patch("quorum.runner.write_effective_kimi_config", side_effect=OSError("disk full")),
            pytest.raises(OSError, match="disk full"),
        ):
            _seed_kimi_config(tmp_path / "cfg", run_dir=tmp_path / "run", binary="kimi")

        assert not env_file.exists()
        assert not env_dir.exists()

    def test_cleanup_agent_runtime_fails_when_runtime_env_file_remains(self, tmp_path, monkeypatch):
        env_dir = tmp_path / "secret-env"
        env_dir.mkdir()
        env_file = env_dir / "kimi-runtime.env"
        env_file.write_text("KIMI_MODEL_API_KEY=fake-kimi-key\n")

        monkeypatch.setattr("quorum.runner.shutil.rmtree", lambda _path: None)

        with pytest.raises(RunnerError, match="cleanup failed") as excinfo:
            _cleanup_agent_runtime(AgentRuntime(env_file=env_file, cleanup_dirs=(env_dir,)))

        assert excinfo.value.stage == "setup"

    def test_run_scenario_reports_indeterminate_when_runtime_cleanup_fails(
        self, tmp_path, monkeypatch
    ):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        out_root = tmp_path / "results"
        session_log_dir = tmp_path / "logs"
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        scenario = _make_scenario(scenarios_dir, "x", with_checks=False)
        (scenario / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        env_dir = tmp_path / "secret-env"
        env_dir.mkdir()
        env_file = env_dir / "kimi-runtime.env"
        env_file.write_text("KIMI_MODEL_API_KEY=fake-kimi-key\n")

        monkeypatch.setattr("quorum.runner.shutil.rmtree", lambda _path: None)

        with (
            patch(
                "quorum.runner._seed_agent_config_dir",
                return_value=AgentRuntime(env_file=env_file, cleanup_dirs=(env_dir,)),
            ),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=scenario,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert "cleanup failed" in verdict.error.message

    def test_antigravity_seed_runs_auth_preflight_then_plugin_install(self, tmp_path, monkeypatch):
        sp = tmp_path / "superpowers"
        sp.mkdir()
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/agy")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **kwargs):
            if "--print" in cmd:
                assert kwargs["cwd"] != cfg
                assert str(cfg) not in str(cmd)
                assert kwargs["timeout"] == 90
                assert kwargs["env"]["AGY_CLI_DISABLE_AUTO_UPDATE"] == "true"
                assert cmd.index("--print-timeout") < cmd.index("--print")
                assert "--log-file" in cmd
                gemini_arg = next(part for part in cmd if part.startswith("--gemini_dir="))
                gemini_dir = Path(gemini_arg.split("=", 1)[1])
                transcript_dir = (
                    gemini_dir
                    / "antigravity-cli"
                    / "brain"
                    / "session"
                    / ".system_generated"
                    / "logs"
                )
                transcript_dir.mkdir(parents=True)
                (transcript_dir / "transcript.jsonl").write_text('{"tool_calls":[]}\n')
                return subprocess.CompletedProcess(cmd, 0, "OK\n", "")
            assert cmd == [
                "agy",
                f"--gemini_dir={cfg / '.gemini'}",
                "plugin",
                "install",
                str(sp),
            ]
            assert kwargs["cwd"] == cfg
            assert kwargs["env"]["AGY_CLI_DISABLE_AUTO_UPDATE"] == "true"
            root = cfg / ".gemini" / "config" / "plugins" / "superpowers"
            (root / "skills" / "using-superpowers").mkdir(parents=True)
            (root / "plugin.json").write_text("{}")
            (root / "hooks.json").write_text("{}")
            (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with patch("quorum.runner.subprocess.run", side_effect=fake_run) as mock_run:
            _seed_antigravity_config(cfg, tmp_path / "wd")

        assert mock_run.call_count == 2

    def test_opencode_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/opencode")

        with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
            _seed_agent_config_dir(
                _opencode_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_opencode_seed_requires_opencode_binary(self, tmp_path, monkeypatch):
        sp = _make_superpowers_opencode_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: None)

        with pytest.raises(RunnerError, match="opencode not found"):
            _seed_agent_config_dir(
                _opencode_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_opencode_seed_stages_plugin_layout(self, tmp_path, monkeypatch):
        sp = _make_superpowers_opencode_root(tmp_path)
        plugin_src = sp / ".opencode" / "plugins" / "superpowers.js"
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")
        monkeypatch.setattr(
            "quorum.runner.subprocess.run",
            lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "OK\n", ""),
        )
        monkeypatch.setattr(
            "quorum.runner.run_opencode_command",
            lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "OK\n", ""),
        )

        dest = tmp_path / "cfg"
        _seed_agent_config_dir(
            _opencode_tcfg(),
            tmp_path,
            dest,
            tmp_path / "wd",
            run_dir=tmp_path / "run-dir",
        )

        config_dir = dest / ".config" / "opencode"
        staged_plugin = config_dir / "superpowers" / ".opencode" / "plugins" / "superpowers.js"
        plugin_link = config_dir / "plugins" / "superpowers.js"
        staged_skills = config_dir / "superpowers" / "skills"

        assert staged_plugin.read_text() == plugin_src.read_text()
        assert plugin_link.is_symlink()
        assert plugin_link.resolve() == staged_plugin.resolve()
        assert staged_skills.is_dir()
        assert not staged_skills.is_symlink()
        assert (staged_skills / "using-superpowers" / "SKILL.md").exists()
        assert staged_skills.resolve().is_relative_to(dest.resolve())
        assert (dest / ".local" / "share" / "opencode").is_dir()
        assert (dest / ".local" / "state" / "opencode").is_dir()
        assert (dest / ".cache").is_dir()
        assert (dest / ".tmp").is_dir()
        assert (dest / ".quorum" / "session-exports").is_dir()
        # Without a pinned model, opencode auto-selects across whatever
        # provider keys are ambient (it picked claude-sonnet over GPT).
        seeded_config = json.loads((config_dir / "opencode.json").read_text())
        assert seeded_config["model"] == "openai/gpt-5.5"

    def test_opencode_seed_rejects_skill_tree_symlinks(self, tmp_path, monkeypatch):
        sp = _make_superpowers_opencode_root(tmp_path)
        (sp / "skills" / "brainstorming" / "escape").symlink_to(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")

        with pytest.raises(RunnerError, match="symlink"):
            _seed_agent_config_dir(
                _opencode_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_opencode_seed_rejects_preexisting_session_exports(self, tmp_path, monkeypatch):
        sp = _make_superpowers_opencode_root(tmp_path)
        skeleton = tmp_path / "opencode-home-skeleton"
        stale = skeleton / ".quorum" / "session-exports" / "0000000000000001-ses_old.json"
        stale.parent.mkdir(parents=True)
        stale.write_text("{}")
        dest = tmp_path / "cfg"
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")

        with pytest.raises(RunnerError, match="pre-existing OpenCode session exports"):
            _seed_agent_config_dir(
                _opencode_tcfg(),
                tmp_path,
                dest,
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )

    def test_opencode_provider_preflight_timeout_is_setup_error(self, tmp_path, monkeypatch):
        sp = _make_superpowers_opencode_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")

        def fake_run(cmd, **kwargs):
            if Path(cmd[0]).name == "node" and cmd[1] == "--check":
                return subprocess.CompletedProcess(cmd, 0, "", "")
            if cmd == ["opencode", "--version"]:
                return subprocess.CompletedProcess(cmd, 0, "1.15.10\n", "")
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 90))

        monkeypatch.setattr("quorum.runner.subprocess.run", fake_run)

        with pytest.raises(RunnerError, match="preflight timed out") as exc:
            _seed_agent_config_dir(
                _opencode_tcfg(),
                tmp_path,
                tmp_path / "cfg",
                tmp_path / "wd",
                run_dir=tmp_path / "run-dir",
            )
        assert exc.value.stage == "setup"

    def test_antigravity_seed_writes_always_proceed_settings(self, tmp_path, monkeypatch):
        sp = tmp_path / "superpowers"
        sp.mkdir()
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/agy")
        cfg = tmp_path / "cfg"
        workdir = tmp_path / "wd"
        workdir.mkdir()

        def fake_run(cmd, **_kwargs):
            gemini_arg = next(part for part in cmd if part.startswith("--gemini_dir="))
            gemini_dir = Path(gemini_arg.split("=", 1)[1])
            if "--print" in cmd:
                transcript_dir = (
                    gemini_dir
                    / "antigravity-cli"
                    / "brain"
                    / "session"
                    / ".system_generated"
                    / "logs"
                )
                transcript_dir.mkdir(parents=True)
                (transcript_dir / "transcript.jsonl").write_text('{"tool_calls":[]}\n')
                return subprocess.CompletedProcess(cmd, 0, "OK\n", "")
            root = cfg / ".gemini" / "config" / "plugins" / "superpowers"
            (root / "skills" / "using-superpowers").mkdir(parents=True)
            (root / "plugin.json").write_text("{}")
            (root / "hooks.json").write_text("{}")
            (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with patch("quorum.runner.subprocess.run", side_effect=fake_run):
            _seed_antigravity_config(cfg, workdir)

        settings = json.loads((cfg / ".gemini" / "antigravity-cli" / "settings.json").read_text())
        assert settings["toolPermission"] == "always-proceed"
        assert settings["artifactReviewPolicy"] == "always-proceed"
        assert str(workdir.resolve()) in settings["trustedWorkspaces"]
        assert "command(*)" in settings["permissions"]["allow"]
        assert "write_file(*)" in settings["permissions"]["allow"]
        assert settings["permissions"]["ask"] == []

    def test_antigravity_seed_fails_when_auth_preflight_has_no_transcript(
        self, tmp_path, monkeypatch
    ):
        sp = tmp_path / "superpowers"
        sp.mkdir()
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/agy")

        with (
            patch(
                "quorum.runner.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "OK\n", ""),
            ),
            pytest.raises(RunnerError, match="produced no transcript"),
        ):
            _seed_antigravity_config(tmp_path / "cfg", tmp_path / "wd")

    def test_antigravity_seed_fails_when_install_creates_real_config_transcript(
        self, tmp_path, monkeypatch
    ):
        sp = tmp_path / "superpowers"
        sp.mkdir()
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/agy")
        cfg = tmp_path / "cfg"

        def fake_run(cmd, **kwargs):
            gemini_arg = next(part for part in cmd if part.startswith("--gemini_dir="))
            gemini_dir = Path(gemini_arg.split("=", 1)[1])
            if "--print" in cmd:
                transcript_dir = (
                    gemini_dir
                    / "antigravity-cli"
                    / "brain"
                    / "session"
                    / ".system_generated"
                    / "logs"
                )
                transcript_dir.mkdir(parents=True)
                (transcript_dir / "transcript.jsonl").write_text('{"tool_calls":[]}\n')
                return subprocess.CompletedProcess(cmd, 0, "OK\n", "")
            root = cfg / ".gemini" / "config" / "plugins" / "superpowers"
            (root / "skills" / "using-superpowers").mkdir(parents=True)
            (root / "plugin.json").write_text("{}")
            (root / "hooks.json").write_text("{}")
            (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
            transcript_dir = (
                cfg
                / ".gemini"
                / "antigravity-cli"
                / "brain"
                / "session"
                / ".system_generated"
                / "logs"
            )
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "transcript.jsonl").write_text("{}\n")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(
                RunnerError,
                match="provisioning unexpectedly wrote transcripts",
            ),
        ):
            _seed_antigravity_config(cfg, tmp_path / "wd")

    def test_preflight_diagnoses_rate_limit_from_log(self):
        """Empty agy reply + 429/RESOURCE_EXHAUSTED in agy.log is diagnosed as a
        Code Assist rate-limit setup error, not a mislabeled auth failure."""

        def fake_run(cmd, **kwargs):
            log_path = Path(cmd[cmd.index("--log-file") + 1])
            log_path.write_text(
                "http_helpers.go: URL streamGenerateContent status 429\n"
                "stream error: RESOURCE_EXHAUSTED quota exceeded\n"
            )
            return subprocess.CompletedProcess(cmd, 0, "", "")  # empty stdout

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(RunnerError) as excinfo,
        ):
            _run_antigravity_auth_preflight()
        assert excinfo.value.stage == "setup"
        assert ANTIGRAVITY_RATE_LIMIT_MARKER in str(excinfo.value)

    def test_preflight_empty_without_rate_limit_is_auth_error(self):
        """Empty agy reply with no rate-limit signal stays an auth-style error."""

        def fake_run(cmd, **kwargs):
            log_path = Path(cmd[cmd.index("--log-file") + 1])
            log_path.write_text("ordinary startup log, no errors here\n")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with (
            patch("quorum.runner.subprocess.run", side_effect=fake_run),
            pytest.raises(RunnerError) as excinfo,
        ):
            _run_antigravity_auth_preflight()
        assert ANTIGRAVITY_RATE_LIMIT_MARKER not in str(excinfo.value)
        assert "did not return OK" in str(excinfo.value)


class TestAntigravityProjectMarkerExclusion:
    def test_excludes_marker_in_git_info_exclude_idempotently(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)

        _exclude_antigravity_project_marker(repo)
        _exclude_antigravity_project_marker(repo)

        exclude_path = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "--git-path", "info/exclude"],
            text=True,
        ).strip()
        lines = (repo / exclude_path).read_text().splitlines()
        assert lines.count(".antigravitycli/") == 1

    def test_exclusion_is_noop_outside_git_repo(self, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()
        _exclude_antigravity_project_marker(plain)
        assert not (plain / ".git").exists()


class TestRunScenario:
    def test_claude_family_missing_binary_fails_before_writing_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda _binary: None)
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir(parents=True)
        (coding_agents_dir / "claude-haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude-haiku",
                    "runtime_family": "claude",
                    "binary": "claude",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY"],
                    "model": "claude-haiku-4-5-20251001",
                }
            )
        )
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude-haiku",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert "Claude Code is not on PATH" in verdict.error.message
        assert not (run_dir / "coding-agent-config" / CLAUDE_ENV_FILE_NAME).exists()

    def test_happy_path(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "session-logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        # Add checks.sh manually (with_checks=False skips it; add one that passes trivially)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        (coding_agents_dir / "claude-context" / "HOWTO.md").write_text("invoke `claude`")
        out_root = tmp_path / "results"

        with patch(
            "quorum.runner.invoke_gauntlet",
            side_effect=_stub_gauntlet_pass_writing_log(session_log_dir),
        ):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "pass"
        run_dirs = list(out_root.iterdir())
        assert len(run_dirs) == 1
        rd = run_dirs[0]
        assert (rd / "verdict.json").exists()
        assert (rd / "coding-agent-tool-calls.jsonl").exists()
        assert (rd / "gauntlet-agent" / "context" / "HOWTO.md").read_text() == "invoke `claude`"

    def test_check_fail_overrides_gauntlet_pass(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        # checks.sh post() always fails (file doesn't exist)
        sd = _make_scenario(scenarios_dir, "x", checks_pass=False)
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch(
            "quorum.runner.invoke_gauntlet",
            side_effect=_stub_gauntlet_pass_writing_log(session_log_dir),
        ):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "fail"
        # Gauntlet passed but the check failed — at least one post check
        # should be marked as failed in the verdict.
        assert any(not c.passed for c in verdict.checks)

    def test_setup_failure_aborts_before_gauntlet(self, tmp_path):
        # Task 2.8: setup failure no longer propagates as RunnerError — it
        # returns an indeterminate verdict and still never invokes gauntlet.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(sd / "setup.sh", "#!/usr/bin/env bash\nexit 9\n")
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert (run_dir / "verdict.json").exists()

    def test_config_error_becomes_setup_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        coding_agents_dir.mkdir(parents=True)
        (coding_agents_dir / "broken.yaml").write_text("name: broken\n")
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="broken",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=_empty_skeleton(tmp_path),
        )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert "missing required fields" in verdict.final_reason
        assert (run_dir / "verdict.json").exists()

    def test_capture_empty_yields_indeterminate_when_trace_checks_present(self, tmp_path):
        # The built-in capture-non-empty guard fires when checks reference
        # trace primitives (tool-called etc.) and capture is empty.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = scenarios_dir / "x"
        sd.mkdir(parents=True)
        (sd / "story.md").write_text("---\nid: x\ntitle: x\n---\nbody\n")
        _exec(sd / "setup.sh", "#!/usr/bin/env bash\necho ok > marker\n")
        # post() references tool-called (a trace primitive) — triggers capture-empty guard
        (sd / "checks.sh").write_text("pre() { :; }\npost() { tool-called Edit; }\n")
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        # Capture was empty (no real CLI run) and there's a trace check →
        # composer returns indeterminate.
        assert verdict.final == "indeterminate"

    def test_claude_empty_capture_is_strict_capture_indeterminate(self, tmp_path):
        # Claude is a strict-capture target: an empty/stub transcript (e.g. the
        # 2.1.169 nested-session persistence skip) must surface as a loud
        # indeterminate(stage=capture) that names Claude, not a silently-masked
        # soft verdict. No trace check is present, so only the strict-capture
        # guard can force the indeterminate here.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = scenarios_dir / "x"
        sd.mkdir(parents=True)
        (sd / "story.md").write_text("---\nid: x\ntitle: x\n---\nbody\n")
        _exec(sd / "setup.sh", "#!/usr/bin/env bash\necho ok > marker\n")
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "indeterminate"
        assert "no Claude transcript appeared" in verdict.final_reason

    def test_launch_cwd_sentinel_threads_through_to_gauntlet(self, tmp_path):
        # When setup.sh writes .quorum-launch-cwd, the runner reads it and
        # passes that path as launch_cwd to invoke_gauntlet (which exports
        # QUORUM_AGENT_CWD for the QA agent's bash to use).
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(
            sd / "setup.sh",
            "#!/usr/bin/env bash\nset -e\n"
            'sib="${QUORUM_WORKDIR}-sibling"\nmkdir -p "$sib"\n'
            'echo "$sib" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"\n',
        )
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"
        captured: dict[str, Path] = {}

        def stub(*, run_dir, launch_cwd, **kwargs):
            captured["launch_cwd"] = launch_cwd
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        with patch("quorum.runner.invoke_gauntlet", side_effect=stub):
            _run_dir, _verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert captured["launch_cwd"].name.endswith("-sibling")

    def test_antigravity_excludes_project_marker_after_launch_cwd_resolution(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir(parents=True, exist_ok=True)
        (coding_agents_dir / "antigravity.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "antigravity",
                    "binary": "echo",
                    "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": [],
                }
            )
        )
        (coding_agents_dir / "antigravity-context").mkdir(parents=True)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(
            sd / "setup.sh",
            "#!/usr/bin/env bash\nset -euo pipefail\n"
            "git init >/dev/null\n"
            "mkdir app\n"
            "git -C app init >/dev/null\n"
            'echo "$QUORUM_WORKDIR/app" > "$QUORUM_WORKDIR/.quorum-launch-cwd"\n',
        )
        out_root = tmp_path / "results"

        with (
            patch("quorum.runner._seed_antigravity_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            run_scenario(
                scenario_dir=sd,
                coding_agent="antigravity",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        launch_repo = next(out_root.iterdir()) / "coding-agent-workdir" / "app"
        exclude_path = subprocess.check_output(
            ["git", "-C", str(launch_repo), "rev-parse", "--git-path", "info/exclude"],
            text=True,
        ).strip()
        assert ".antigravitycli/" in (launch_repo / exclude_path).read_text()

    def test_antigravity_seed_runner_error_preserves_setup_stage(self, tmp_path, monkeypatch):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir(parents=True, exist_ok=True)
        (coding_agents_dir / "antigravity.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "antigravity",
                    "binary": "agy",
                    "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": [],
                }
            )
        )
        (coding_agents_dir / "antigravity-context").mkdir(parents=True)
        sd = _make_scenario(scenarios_dir, "x")

        run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=_empty_skeleton(tmp_path),
        )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert (run_dir / "verdict.json").exists()

    def test_antigravity_missing_transcript_is_indeterminate_even_without_trace_checks(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_antigravity_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        out_root = tmp_path / "results"

        with (
            patch("quorum.runner._seed_antigravity_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="antigravity",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "no Antigravity transcript" in verdict.final_reason
        assert verdict.gauntlet is not None
        assert verdict.gauntlet.status == "pass"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_antigravity_rate_limited_short_circuits_to_rate_limit_verdict(
        self, tmp_path, monkeypatch
    ):
        from quorum.run_all import _is_rate_limited_verdict

        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_antigravity_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        out_root = tmp_path / "results"

        def rate_limited_gauntlet(*, run_dir, **kwargs):
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="fail", rate_limited=True)

        with (
            patch("quorum.runner._seed_antigravity_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=rate_limited_gauntlet),
        ):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="antigravity",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "gauntlet"
        assert ANTIGRAVITY_RATE_LIMIT_MARKER in verdict.error.message
        assert "no Antigravity transcript captured" not in verdict.error.message
        assert "no Antigravity transcript" not in verdict.final_reason

        written = json.loads((run_dir / "verdict.json").read_text())
        assert ANTIGRAVITY_RATE_LIMIT_MARKER in written["error"]["message"]
        assert _is_rate_limited_verdict(written) is True

    def test_antigravity_run_backs_up_and_restores_credential(self, tmp_path, monkeypatch):
        from quorum import agy_creds

        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_antigravity_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        out_root = tmp_path / "results"

        order: list[str] = []

        class _SpyBackup:
            def verify_or_restore(self):
                order.append("restore")

        def spy_backup():
            order.append("backup")
            return _SpyBackup()

        def spy_gauntlet(*, run_dir, **kwargs):
            order.append("gauntlet")
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        monkeypatch.setattr(agy_creds, "backup_credential", spy_backup)
        with (
            patch("quorum.runner._seed_antigravity_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=spy_gauntlet),
        ):
            run_scenario(
                scenario_dir=sd,
                coding_agent="antigravity",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        # backup before the agy run, restore exactly once after it returns
        assert order == ["backup", "gauntlet", "restore"]

    def test_non_antigravity_run_does_not_back_up_credential(self, tmp_path, monkeypatch):
        from quorum import agy_creds

        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        out_root = tmp_path / "results"

        calls = {"backed_up": 0}

        def spy_backup():
            calls["backed_up"] += 1
            return None

        monkeypatch.setattr(agy_creds, "backup_credential", spy_backup)
        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert calls["backed_up"] == 0

    def test_antigravity_zero_normalized_rows_is_distinct_from_missing_transcript(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_antigravity_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        out_root = tmp_path / "results"

        def gauntlet_with_non_tool_log(*, run_dir, **kwargs):
            (session_log_dir / "session.jsonl").write_text('{"type":"assistant","text":"hello"}\n')
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_antigravity_config"),
            patch(
                "quorum.runner.invoke_gauntlet",
                side_effect=gauntlet_with_non_tool_log,
            ),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="antigravity",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "normalized to zero tool-call rows" in verdict.final_reason
        assert verdict.gauntlet is not None
        assert verdict.gauntlet.status == "pass"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_pi_missing_required_env_is_setup_stage(self, tmp_path, monkeypatch):
        monkeypatch.delenv("PI_API_KEY", raising=False)
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "sessions"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir(parents=True)
        (coding_agents_dir / "pi.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "pi",
                    "binary": "pi",
                    "agent_config_env": "PI_CODING_AGENT_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "pi",
                    "required_env": ["PI_API_KEY"],
                }
            )
        )
        (coding_agents_dir / "pi-context").mkdir(parents=True)
        sd = _make_scenario(scenarios_dir, "x")

        with patch("quorum.runner.invoke_gauntlet") as gauntlet:
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="pi",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        gauntlet.assert_not_called()
        assert verdict.final == "indeterminate"
        assert "required env vars not set" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "setup"

    def test_pi_context_substitution_includes_env_file(self, tmp_path, monkeypatch):
        superpowers = _make_superpowers_pi_root(tmp_path)
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
        monkeypatch.setenv("PI_API_KEY", "secret-pi-key")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        coding_agents_dir.mkdir(parents=True)
        (coding_agents_dir / "pi.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "pi",
                    "binary": "pi",
                    "agent_config_env": "PI_CODING_AGENT_DIR",
                    "session_log_dir": "${PI_CODING_AGENT_DIR}/sessions",
                    "session_log_glob": "*.jsonl",
                    "normalizer": "pi",
                    "required_env": [],
                }
            )
        )
        pi_context = coding_agents_dir / "pi-context"
        pi_context.mkdir(parents=True)
        (pi_context / "HOWTO.md").write_text(
            "launch $QUORUM_LAUNCH_AGENT from $QUORUM_AGENT_CWD\n"
            "config $PI_CODING_AGENT_DIR env $PI_ENV_FILE root $SUPERPOWERS_ROOT\n"
        )
        (pi_context / "launch-agent").write_text(
            "#!/usr/bin/env bash\n"
            'cd "$QUORUM_AGENT_CWD"\n'
            '. "$PI_ENV_FILE"\n'
            'exec env PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" '
            'pi --no-context-files --extension "$SUPERPOWERS_ROOT" "$@"\n'
        )
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        with (
            patch("quorum.runner._seed_pi_config", create=True),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            run_scenario(
                scenario_dir=sd,
                coding_agent="pi",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        rd = next((tmp_path / "results").iterdir())
        shim = rd / "gauntlet-agent" / "context" / "launch-agent"
        howto = rd / "gauntlet-agent" / "context" / "HOWTO.md"
        assert shim.exists()
        assert shim.stat().st_mode & stat.S_IXUSR

        copied = shim.read_text() + "\n" + howto.read_text()
        assert str(rd / "coding-agent-workdir") in copied
        assert str(rd / "coding-agent-config") in copied
        assert str(rd / "coding-agent-config" / "pi.env") in copied
        assert str(superpowers) in copied
        assert str(shim) in copied
        assert "--no-context-files" in shim.read_text()
        assert "secret-pi-key" not in copied
        for placeholder in (
            "$PI_ENV_FILE",
            "$PI_CODING_AGENT_DIR",
            "$SUPERPOWERS_ROOT",
            "$QUORUM_LAUNCH_AGENT",
        ):
            assert placeholder not in copied

    def test_gemini_capture_no_transcript_is_capture_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_gemini_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        with (
            patch("quorum.runner._seed_gemini_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="gemini",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "no Gemini transcript" in verdict.final_reason

    def test_gemini_capture_zero_rows_is_capture_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_gemini_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_invoke(*, run_dir, **_kwargs):
            (session_log_dir / "session-empty.jsonl").write_text('{"type":"user"}\n')
            (run_dir / "gauntlet-agent" / "results" / "run-1").mkdir(parents=True)
            (run_dir / "gauntlet-agent" / "results" / "run-1" / "result.json").write_text(
                json.dumps({"status": "pass"})
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_gemini_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="gemini",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "Gemini transcript(s) normalized to zero" in verdict.final_reason

    def test_pi_missing_session_is_indeterminate_even_without_trace_checks(self, tmp_path):
        coding_agents_dir = tmp_path / "agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "sessions"
        session_log_dir.mkdir()
        _make_pi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        with (
            patch("quorum.runner._seed_pi_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="pi",
                out_root=tmp_path / "results",
                coding_agents_dir=coding_agents_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "no Pi session" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_pi_zero_normalized_rows_is_distinct_from_missing_session(self, tmp_path):
        coding_agents_dir = tmp_path / "agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "sessions"
        session_log_dir.mkdir()
        _make_pi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def write_empty_pi_session(*, run_dir, **kwargs):
            workdir = run_dir / "coding-agent-workdir"
            session_log_dir.joinpath("session.jsonl").write_text(
                json.dumps({"type": "session", "cwd": str(workdir)})
                + "\n"
                + json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "done"}],
                        },
                    }
                )
                + "\n"
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_pi_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=write_empty_pi_session),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="pi",
                out_root=tmp_path / "results",
                coding_agents_dir=coding_agents_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "normalized to zero tool-call rows" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_pi_wrong_cwd_session_is_qa_agent_misconfigured(self, tmp_path):
        coding_agents_dir = tmp_path / "agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "sessions"
        session_log_dir.mkdir()
        _make_pi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def write_wrong_cwd_pi_session(*, run_dir, **kwargs):
            wrong_cwd = run_dir / "scratch"
            wrong_cwd.mkdir()
            session_log_dir.joinpath("session.jsonl").write_text(
                json.dumps({"type": "session", "cwd": str(wrong_cwd)}) + "\n"
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_pi_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=write_wrong_cwd_pi_session),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="pi",
                out_root=tmp_path / "results",
                coding_agents_dir=coding_agents_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "wrong cwd" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "qa-agent-misconfigured"

    def test_pi_malformed_session_header_is_capture_error(self, tmp_path):
        coding_agents_dir = tmp_path / "agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "sessions"
        session_log_dir.mkdir()
        _make_pi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def write_malformed_pi_session(**kwargs):
            session_log_dir.joinpath("session.jsonl").write_text("{not json}\n")
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_pi_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=write_malformed_pi_session),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="pi",
                out_root=tmp_path / "results",
                coding_agents_dir=coding_agents_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "unusable Pi session header" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_kimi_no_wire_logs_is_capture_indeterminate_even_without_trace_checks(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "kimi-home" / "sessions"
        session_log_dir.mkdir(parents=True)
        _make_kimi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        with (
            patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="kimi",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "no Kimi wire.jsonl" in verdict.error.message

    def test_kimi_wrong_cwd_index_is_qa_agent_misconfigured(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "kimi-home" / "sessions"
        session_log_dir.mkdir(parents=True)
        _make_kimi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        def fake_gauntlet(**kwargs):
            session_dir = session_log_dir / "wd" / "session"
            wire_dir = session_dir / "agents" / "main"
            wire_dir.mkdir(parents=True)
            (wire_dir / "wire.jsonl").write_text(
                json.dumps(
                    {
                        "type": "context.append_loop_event",
                        "event": {
                            "type": "tool.call",
                            "name": "Read",
                            "args": {"path": "README.md"},
                        },
                    }
                )
                + "\n"
            )
            (session_log_dir.parent / "session_index.jsonl").write_text(
                json.dumps(
                    {"sessionDir": str(session_dir), "workDir": str(session_log_dir / "wrong")}
                )
                + "\n"
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="kimi",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "qa-agent-misconfigured"
        assert "did not match launch cwd" in verdict.error.message

    def test_kimi_unindexed_wire_logs_are_capture_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "kimi-home" / "sessions"
        session_log_dir.mkdir(parents=True)
        _make_kimi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        def fake_gauntlet(**kwargs):
            session_dir = session_log_dir / "wd" / "session"
            wire_dir = session_dir / "agents" / "main"
            wire_dir.mkdir(parents=True)
            (wire_dir / "wire.jsonl").write_text(
                json.dumps(
                    {
                        "type": "context.append_loop_event",
                        "event": {
                            "type": "tool.call",
                            "name": "Read",
                            "args": {"path": "README.md"},
                        },
                    }
                )
                + "\n"
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="kimi",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "not indexed/mappable" in verdict.error.message

    def test_kimi_matched_wire_with_zero_normalized_rows_is_capture_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "kimi-home" / "sessions"
        session_log_dir.mkdir(parents=True)
        _make_kimi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        def fake_gauntlet(*, launch_cwd, **kwargs):
            session_dir = session_log_dir / "wd" / "session"
            wire_dir = session_dir / "agents" / "main"
            wire_dir.mkdir(parents=True)
            (wire_dir / "wire.jsonl").write_text(
                json.dumps(
                    {
                        "type": "context.append_loop_event",
                        "event": {
                            "type": "plugin_session_start",
                            "plugin": "superpowers",
                            "skill": "using-superpowers",
                        },
                    }
                )
                + "\n"
            )
            (session_log_dir.parent / "session_index.jsonl").write_text(
                json.dumps({"sessionDir": str(session_dir), "workDir": str(launch_cwd)}) + "\n"
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="kimi",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "zero rows" in verdict.error.message

    def test_kimi_missing_plugin_session_start_is_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "kimi-home" / "sessions"
        session_log_dir.mkdir(parents=True)
        _make_kimi_agent(coding_agents_dir, session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        def fake_gauntlet(*, launch_cwd, **kwargs):
            session_dir = session_log_dir / "wd" / "session"
            wire_dir = session_dir / "agents" / "main"
            wire_dir.mkdir(parents=True)
            (wire_dir / "wire.jsonl").write_text(
                json.dumps(
                    {
                        "type": "context.append_loop_event",
                        "event": {
                            "type": "tool.call",
                            "name": "Read",
                            "args": {"path": "README.md"},
                        },
                    }
                )
                + "\n"
            )
            (session_log_dir.parent / "session_index.jsonl").write_text(
                json.dumps({"sessionDir": str(session_dir), "workDir": str(launch_cwd)}) + "\n"
            )
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="kimi",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "plugin_session_start" in verdict.error.message

    def test_copilot_run_uses_sanitized_gauntlet_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PATH", "/bin")
        monkeypatch.setenv("TERM", "xterm-256color")
        monkeypatch.setenv("LANG", "C.UTF-8")
        monkeypatch.setenv("GH_HOST", "github.enterprise.test")
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:8080")
        monkeypatch.setenv("SSL_CERT_FILE", "/certs/ca.pem")
        monkeypatch.setenv("COPILOT_MODEL", "gpt-test")
        monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "host-token")
        monkeypatch.setenv("GH_TOKEN", "gh-token")
        monkeypatch.setenv("GITHUB_TOKEN", "github-token")
        monkeypatch.setenv("COPILOT_PROVIDER_API_KEY", "provider-key")
        monkeypatch.setenv("COPILOT_PROVIDER_BASE_URL", "http://provider")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "otel-secret")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-secret")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        captured: dict[str, dict[str, str] | None] = {}

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(copilot_home)

        def fake_invoke(*, run_dir, env_base, extra_env, **_kwargs):
            captured["env_base"] = env_base
            captured["extra_env"] = extra_env
            copilot_home = Path(extra_env["COPILOT_HOME"])
            _write_copilot_skill_event(
                copilot_home / "session-state" / "session-123" / "events.jsonl"
            )
            result_dir = run_dir / "gauntlet-agent" / "results" / "run-1"
            result_dir.mkdir(parents=True)
            (result_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "pass"
        assert captured["env_base"] == {
            "PATH": "/bin",
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "GH_HOST": "github.enterprise.test",
            "HTTPS_PROXY": "http://proxy.test:8080",
            "SSL_CERT_FILE": "/certs/ca.pem",
            "COPILOT_MODEL": "gpt-test",
        }
        assert captured["extra_env"] == {"COPILOT_HOME": str(_run_dir / "coding-agent-config")}
        env_base = captured["env_base"] or {}
        for name in (
            "COPILOT_GITHUB_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "COPILOT_PROVIDER_API_KEY",
            "COPILOT_PROVIDER_BASE_URL",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "AWS_SECRET_ACCESS_KEY",
        ):
            assert name not in env_base

    def test_copilot_missing_transcript_is_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(copilot_home)

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "no Copilot transcript" in verdict.final_reason

    def test_copilot_transcript_zero_rows_is_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(copilot_home)

        def fake_invoke(*, run_dir, extra_env, **_kwargs):
            copilot_home = Path(extra_env["COPILOT_HOME"])
            events = copilot_home / "session-state" / "session-123" / "events.jsonl"
            events.parent.mkdir(parents=True)
            events.write_text('{"type":"session.shutdown"}\n')
            result_dir = run_dir / "gauntlet-agent" / "results" / "run-1"
            result_dir.mkdir(parents=True)
            (result_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "Copilot transcript(s) normalized to zero" in verdict.final_reason

    def test_copilot_missing_expected_session_state_is_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(copilot_home, session_id="expected")

        def fake_invoke(*, run_dir, extra_env, **_kwargs):
            copilot_home = Path(extra_env["COPILOT_HOME"])
            _write_copilot_skill_event(copilot_home / "session-state" / "other" / "events.jsonl")
            result_dir = run_dir / "gauntlet-agent" / "results" / "run-1"
            result_dir.mkdir(parents=True)
            (result_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "expected Copilot session-state log did not appear" in verdict.final_reason

    def test_copilot_extra_session_state_log_is_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(copilot_home, session_id="expected")

        def fake_invoke(*, run_dir, extra_env, **_kwargs):
            copilot_home = Path(extra_env["COPILOT_HOME"])
            expected_log = copilot_home / "session-state" / "expected" / "events.jsonl"
            expected_log.parent.mkdir(parents=True)
            expected_log.write_text('{"type":"session.shutdown"}\n')
            _write_copilot_skill_event(copilot_home / "session-state" / "other" / "events.jsonl")
            result_dir = run_dir / "gauntlet-agent" / "results" / "run-1"
            result_dir.mkdir(parents=True)
            (result_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "unexpected Copilot session-state log" in verdict.final_reason

    def test_copilot_secret_leak_in_wrong_session_state_takes_precedence(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(
                copilot_home,
                session_id="expected",
                secret="leaked-secret",
            )

        def fake_invoke(*, run_dir, extra_env, **_kwargs):
            copilot_home = Path(extra_env["COPILOT_HOME"])
            other_log = copilot_home / "session-state" / "other" / "events.jsonl"
            _write_copilot_skill_event(other_log)
            with other_log.open("a") as f:
                f.write("leaked-secret\n")
            result_dir = run_dir / "gauntlet-agent" / "results" / "run-1"
            result_dir.mkdir(parents=True)
            (result_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "Copilot secret value appeared in non-secret run artifact" in (verdict.final_reason)
        assert "expected Copilot session-state log did not appear" not in (verdict.final_reason)

    def test_copilot_secret_leak_forces_indeterminate(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        _make_copilot_agent(coding_agents_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_seed(copilot_home: Path, workdir: Path, session_id: str):
            del workdir, session_id
            return _copilot_provisioning(copilot_home, secret="leaked-secret")

        def fake_invoke(*, run_dir, extra_env, **_kwargs):
            copilot_home = Path(extra_env["COPILOT_HOME"])
            _write_copilot_skill_event(
                copilot_home / "session-state" / "session-123" / "events.jsonl"
            )
            (run_dir / "gauntlet-agent").mkdir(parents=True, exist_ok=True)
            (run_dir / "gauntlet-agent" / "transcript.txt").write_text(
                "accidentally printed leaked-secret"
            )
            result_dir = run_dir / "gauntlet-agent" / "results" / "run-1"
            result_dir.mkdir(parents=True)
            (result_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return GauntletResult(status="pass")

        with (
            patch("quorum.runner._seed_copilot_config", side_effect=fake_seed),
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_invoke),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="copilot",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "capture"
        assert "Copilot secret value appeared in non-secret run artifact" in (verdict.final_reason)

    def test_populate_context_dir_copies_coding_agent_contexts(self, tmp_path):
        # Spot-check that coding-agent context HOWTOs land in <run-dir>/gauntlet-agent/context/.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        cd_claude = coding_agents_dir / "claude-context"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text("invoke `claude --foo`")
        (cd_claude / "extra.md").write_text("extra context")
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            _run_dir, _verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        ctx = rd / "gauntlet-agent" / "context"
        assert (ctx / "HOWTO.md").read_text() == "invoke `claude --foo`"
        assert (ctx / "extra.md").read_text() == "extra context"

    def test_howto_substitutes_harness_agent_cwd_and_superpowers_root(self, tmp_path, monkeypatch):
        # tmux strips arbitrary env vars from new sessions, so we burn
        # resolved values into the HOWTO at runtime instead.
        monkeypatch.setenv("SUPERPOWERS_ROOT", "/path/to/sp")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        cd_claude = coding_agents_dir / "claude-context"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text(
            'cd "$QUORUM_AGENT_CWD"\nclaude --plugin-dir "$SUPERPOWERS_ROOT"\n'
        )
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            _run_dir, _verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        ctx_content = (rd / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
        # SUPERPOWERS_ROOT resolved from env.
        assert '--plugin-dir "/path/to/sp"' in ctx_content
        # QUORUM_AGENT_CWD resolved from the actual launched workdir (which
        # tempfile.mkdtemp produced under /tmp or platform equivalent).
        assert "$QUORUM_AGENT_CWD" not in ctx_content
        # The substituted value points at a real existing directory.
        cd_line = [ln for ln in ctx_content.splitlines() if ln.startswith("cd ")][0]
        resolved = cd_line.split('"')[1]
        assert Path(resolved).exists()

    def test_launch_agent_shim_generated_executable_and_substituted(self, tmp_path, monkeypatch):
        # The launch-agent template is copied into the context dir with its
        # $… tokens resolved and the +x bit preserved, so the QA agent can
        # invoke it by absolute path. This replaces the fragile
        # "type cd $QUORUM_AGENT_CWD && <binary> verbatim" HOWTO instruction.
        monkeypatch.setenv("SUPERPOWERS_ROOT", "/path/to/sp")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        cd_claude = coding_agents_dir / "claude-context"
        cd_claude.mkdir(parents=True)
        (cd_claude / "launch-agent").write_text(
            "#!/usr/bin/env bash\n"
            'cd "$QUORUM_AGENT_CWD"\n'
            'exec env CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" echo "$@"\n'
        )
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        shim = rd / "gauntlet-agent" / "context" / "launch-agent"
        assert shim.exists()
        # +x survived write_text.
        assert shim.stat().st_mode & stat.S_IXUSR
        content = shim.read_text()
        assert content.startswith("#!")
        # Tokens resolved to literal absolute paths — no env-var refs remain.
        assert "$QUORUM_AGENT_CWD" not in content
        assert "$CLAUDE_CONFIG_DIR" not in content
        cd_line = [ln for ln in content.splitlines() if ln.startswith("cd ")][0]
        assert Path(cd_line.split('"')[1]).exists()

    def test_checked_in_claude_launcher_sources_env_file_and_stays_non_bare(self):
        launcher = (
            Path(__file__).resolve().parents[2]
            / "coding-agents"
            / "claude-context"
            / "launch-agent"
        )

        content = launcher.read_text()

        assert 'source "$CLAUDE_ENV_FILE"' in content
        assert "ANTHROPIC_API_KEY=" in content
        assert "claude --dangerously-skip-permissions" in content
        assert '--model "$CLAUDE_MODEL"' in content
        assert "--model opus" not in content
        assert "--bare" not in content

    def test_checked_in_claude_launcher_strips_nested_claude_session_env(self):
        # Claude Code (>=2.1.166) skips writing its session transcript when it
        # detects a NESTED interactive session via the inherited CLAUDECODE and
        # CLAUDE_CODE_SESSION_ID env vars. Stripping them lets the eval run from
        # inside a Claude Code session and still persist the agent-under-test's
        # transcript, so quorum captures real tool calls.
        launcher = (
            Path(__file__).resolve().parents[2]
            / "coding-agents"
            / "claude-context"
            / "launch-agent"
        )

        content = launcher.read_text()

        assert "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID" in content

    def test_launch_agent_shim_substitutes_claude_env_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir()
        (coding_agents_dir / "claude.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude",
                    "runtime_family": "claude",
                    "binary": "echo",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY"],
                    "model": "opus",
                }
            )
        )
        cd_claude = coding_agents_dir / "claude-context"
        cd_claude.mkdir(parents=True)
        (cd_claude / "launch-agent").write_text(
            "#!/usr/bin/env bash\n"
            'source "$CLAUDE_ENV_FILE"\n'
            'cd "$QUORUM_AGENT_CWD"\n'
            'exec env CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" '
            'ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" echo "$@"\n'
        )
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        rd = list(out_root.iterdir())[0]
        shim = rd / "gauntlet-agent" / "context" / "launch-agent"
        content = shim.read_text()
        assert "$CLAUDE_ENV_FILE" not in content
        assert str(rd / "coding-agent-config" / CLAUDE_ENV_FILE_NAME) in content
        assert (rd / "coding-agent-config" / CLAUDE_ENV_FILE_NAME).is_file()

    def test_claude_family_variant_uses_shared_context_model_and_project_prompt(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda binary: f"/bin/{binary}")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir()
        (coding_agents_dir / "claude-haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude-haiku",
                    "runtime_family": "claude",
                    "binary": "claude",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY"],
                    "model": "claude-haiku-4-5-20251001",
                    "project_prompt": "claude.project-prompt.md",
                }
            )
        )
        shared_prompt = coding_agents_dir / "claude.project-prompt.md"
        shared_prompt.write_text("shared claude prompt")
        claude_context = coding_agents_dir / "claude-context"
        claude_context.mkdir()
        (claude_context / "HOWTO.md").write_text(
            'run "$QUORUM_LAUNCH_AGENT" with model "$CLAUDE_MODEL"\n'
        )
        (claude_context / "launch-agent").write_text(
            '#!/usr/bin/env bash\nexec "$QUORUM_LAUNCH_AGENT" --model "$CLAUDE_MODEL"\n'
        )
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"
        captured: dict[str, object] = {}

        def stub_invoke(*, run_dir, project_prompt, coding_agent, **kwargs):
            captured["project_prompt"] = project_prompt
            captured["coding_agent"] = coding_agent
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            (session_log_dir / "session.jsonl").write_text(_claude_log_line())
            return GauntletResult(status="pass")

        with patch("quorum.runner.invoke_gauntlet", side_effect=stub_invoke):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude-haiku",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        context_dir = run_dir / "gauntlet-agent" / "context"
        howto = (context_dir / "HOWTO.md").read_text()
        launcher = (context_dir / "launch-agent").read_text()
        assert verdict.final == "pass"
        assert "claude-haiku-4-5-20251001" in howto
        assert "claude-haiku-4-5-20251001" in launcher
        assert "$CLAUDE_MODEL" not in howto
        assert "$CLAUDE_MODEL" not in launcher
        assert not (coding_agents_dir / "claude-haiku-context").exists()
        assert captured["project_prompt"] == shared_prompt.resolve()
        assert captured["coding_agent"] == "claude-haiku"

    def test_claude_family_missing_shared_context_is_setup_indeterminate(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda binary: f"/bin/{binary}")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir()
        (coding_agents_dir / "claude-haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude-haiku",
                    "runtime_family": "claude",
                    "binary": "claude",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY"],
                    "model": "claude-haiku-4-5-20251001",
                }
            )
        )
        sd = _make_scenario(scenarios_dir, "x")
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude-haiku",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert "claude-context" in verdict.error.message
        assert (run_dir / "verdict.json").exists()

    def test_howto_references_resolved_launch_agent_path(self, tmp_path):
        # $QUORUM_LAUNCH_AGENT in a HOWTO resolves to the shim's absolute path,
        # which lives at <run-dir>/gauntlet-agent/context/launch-agent.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        cd_claude = coding_agents_dir / "claude-context"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text('run `"$QUORUM_LAUNCH_AGENT"` first\n')
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        howto = (rd / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
        assert "$QUORUM_LAUNCH_AGENT" not in howto
        expected = str(rd / "gauntlet-agent" / "context" / "launch-agent")
        assert expected in howto

    def test_opencode_howto_substitutes_quorum_home_and_launcher(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = Path(__file__).resolve().parents[2] / "coding-agents"
        run_dir = tmp_path / "run"
        launch_cwd = tmp_path / "workdir"
        launch_cwd.mkdir()
        agent_config_dir = run_dir / "coding-agent-config"
        launch_agent_path = run_dir / "gauntlet-agent" / "context" / "launch-agent"

        _populate_context_dir(
            coding_agents_dir,
            "opencode",
            run_dir,
            substitutions={
                "$QUORUM_AGENT_CWD": str(launch_cwd),
                "$SUPERPOWERS_ROOT": str(tmp_path / "sp"),
                "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
                "$OPENCODE_QUORUM_HOME": str(agent_config_dir),
            },
        )

        howto = (run_dir / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
        launcher = launch_agent_path.read_text()

        assert str(launch_agent_path) in howto
        assert str(launch_cwd) in launcher
        assert str(agent_config_dir) in launcher
        assert "opencode run -i --dangerously-skip-permissions" in launcher
        assert "env -i" in launcher
        assert "OPENCODE_CONFIG_DIR=" in launcher
        assert "TMPDIR=" in launcher
        assert "SUPERPOWERS_ROOT" not in launcher

    def test_opencode_exports_sessions_before_capture(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        export_dir = tmp_path / "exports"
        export_dir.mkdir()
        _make_opencode_agent(coding_agents_dir, export_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text(
            "pre() { :; }\npost() { skill-called superpowers:brainstorming; }\n"
        )

        def fake_export(*, opencode_home, export_dir, launch_cwd, snapshot):
            assert snapshot == {"ses_old"}
            exported = export_dir / "0000000000000200-ses_1.json"
            exported.write_text(
                json.dumps(
                    {
                        "messages": [
                            {
                                "parts": [
                                    {
                                        "type": "tool",
                                        "tool": "skill",
                                        "state": {"input": {"name": "brainstorming"}},
                                    }
                                ]
                            }
                        ]
                    }
                )
            )
            return (exported,)

        with (
            patch("quorum.runner._seed_opencode_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
            patch(
                "quorum.runner.snapshot_opencode_sessions",
                return_value={"ses_old"},
                create=True,
            ),
            patch(
                "quorum.runner.export_opencode_sessions",
                side_effect=fake_export,
                create=True,
            ) as mock_export,
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="opencode",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "pass"
        mock_export.assert_called_once()

    def test_opencode_missing_session_export_is_indeterminate(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        export_dir = tmp_path / "exports"
        export_dir.mkdir()
        _make_opencode_agent(coding_agents_dir, export_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_export(*, opencode_home, export_dir, launch_cwd, snapshot):
            (export_dir / "opencode-session-export-manifest.json").write_text(
                json.dumps({"matched_ids": [], "exports": []})
            )
            return ()

        with (
            patch("quorum.runner._seed_opencode_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
            patch("quorum.runner.snapshot_opencode_sessions", return_value=set(), create=True),
            patch("quorum.runner.export_opencode_sessions", side_effect=fake_export, create=True),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="opencode",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "no OpenCode session export" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_opencode_zero_normalized_rows_is_indeterminate(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        export_dir = tmp_path / "exports"
        export_dir.mkdir()
        _make_opencode_agent(coding_agents_dir, export_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        def fake_export(*, opencode_home, export_dir, launch_cwd, snapshot):
            exported = export_dir / "0000000000000100-ses_empty.json"
            exported.write_text(json.dumps({"messages": []}))
            return (exported,)

        with (
            patch("quorum.runner._seed_opencode_config"),
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
            patch("quorum.runner.snapshot_opencode_sessions", return_value=set(), create=True),
            patch("quorum.runner.export_opencode_sessions", side_effect=fake_export, create=True),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="opencode",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "indeterminate"
        assert "OpenCode export(s) normalized to zero tool-call rows" in verdict.final_reason
        assert verdict.error is not None
        assert verdict.error.stage == "capture"

    def test_workdir_in_run_dir_always_present(self, tmp_path):
        # The workdir now lives at <run-dir>/coding-agent-workdir/ — always
        # present inside the run dir, not in /tmp. No workdir-path.txt
        # pointer is written; the dir is co-located with the rest of the
        # evidence and survives regardless of pass/fail verdict.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"

        from quorum.composer import FinalVerdict

        fake_verdict = FinalVerdict(final="pass")

        with (
            patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
            patch("quorum.runner.compose", return_value=fake_verdict),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        assert (rd / "coding-agent-workdir").is_dir()
        assert not (rd / "workdir-path.txt").exists()

    def _agent_with_max_time(self, coding_agents_dir, session_log_dir, max_time):
        coding_agents_dir.mkdir(parents=True, exist_ok=True)
        (coding_agents_dir / "claude.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude",
                    "runtime_family": "claude",
                    "binary": "echo",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": [],
                    "max_time": max_time,
                    "model": "opus",
                }
            )
        )
        (coding_agents_dir / "claude-context").mkdir(parents=True, exist_ok=True)

    def test_quorum_max_time_overrides_agent_default(self, tmp_path):
        # PRI-1869: a story's quorum_max_time strictly overrides the agent
        # default (here, raising 10m → 90m).
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        self._agent_with_max_time(coding_agents_dir, session_log_dir, "10m")
        sd = _make_scenario(scenarios_dir, "x")
        (sd / "story.md").write_text("---\nid: x\ntitle: x\nquorum_max_time: 90m\n---\nbody\n")
        out_root = tmp_path / "results"
        captured: dict[str, str | None] = {}

        def stub(*, run_dir, max_time, **kwargs):
            captured["max_time"] = max_time
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        with patch("quorum.runner.invoke_gauntlet", side_effect=stub):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert captured["max_time"] == "90m"

    def test_agent_default_used_when_no_quorum_max_time(self, tmp_path):
        # Without a story override, the coding-agent default flows through.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        self._agent_with_max_time(coding_agents_dir, session_log_dir, "10m")
        sd = _make_scenario(scenarios_dir, "x")  # story.md has no quorum_max_time
        out_root = tmp_path / "results"
        captured: dict[str, str | None] = {}

        def stub(*, run_dir, max_time, **kwargs):
            captured["max_time"] = max_time
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        with patch("quorum.runner.invoke_gauntlet", side_effect=stub):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert captured["max_time"] == "10m"

    def test_verdict_carries_economics_when_sources_present(self, tmp_path):
        # PRI-1872: when the gauntlet result.json and the coding-agent token
        # usage file both exist in the run dir, run_scenario computes economics
        # at run time and freezes it into verdict.json.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        (coding_agents_dir / "claude-context").mkdir(parents=True)
        out_root = tmp_path / "results"

        def stub(*, run_dir, **kwargs):
            # Real gauntlet output path (economics reads gauntlet-agent/results).
            rid = "run-x"
            gd = run_dir / "gauntlet-agent" / "results" / rid
            gd.mkdir(parents=True, exist_ok=True)
            (gd / "result.json").write_text(
                json.dumps(
                    {
                        "runId": rid,
                        "duration_ms": 120000,
                        "config": {"model": "claude-sonnet-4-6"},
                    }
                )
            )
            # obol.usage sidecar — economics reads this, not result.json's usage block.
            (gd / "usage.jsonl").write_text(
                json.dumps(
                    {
                        "type": "obol.usage",
                        "v": "2026-06-08",
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                        "service_tier": "standard",
                        "usage": {
                            "input_tokens": 100,
                            "cache_read_input_tokens": 1000,
                            "cache_creation_input_tokens": 0,
                            "output_tokens": 200,
                        },
                    }
                )
                + "\n"
            )
            # Frozen coding-agent token usage (obol-priced; carries provenance fields).
            (run_dir / "coding-agent-token-usage.json").write_text(
                json.dumps(
                    {
                        "total_input": 50,
                        "total_cache_create": 0,
                        "total_cache_read": 0,
                        "total_output": 80,
                        "total_tokens": 130,
                        "model": "gpt-5.5",
                        "est_cost_usd": 1.23,
                        "duration_ms": 90000,
                        "models": {
                            "gpt-5.5": {
                                "total_input": 50,
                                "total_cache_create": 0,
                                "total_cache_read": 0,
                                "total_output": 80,
                                "total_tokens": 130,
                                "provider": "openai",
                                "est_cost_usd": 1.23,
                            },
                        },
                        "unpriced_models": [],
                        "approximations": [],
                        "pricing_as_of": "2026-06-09",
                    }
                )
            )
            # claude is a strict-capture target: a non-empty transcript is
            # required, else the run short-circuits to indeterminate(capture).
            (session_log_dir / "session.jsonl").write_text(_claude_log_line())
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        with patch("quorum.runner.invoke_gauntlet", side_effect=stub):
            run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        econ = json.loads((rd / "verdict.json").read_text())["economics"]
        assert isinstance(econ["total_est_cost_usd"], float)
        assert econ["partial"] is False

    def test_malformed_quorum_max_time_yields_indeterminate(self, tmp_path):
        # A malformed override aborts cleanly before gauntlet: run_scenario
        # converts the RunnerError into an indeterminate verdict.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        self._agent_with_max_time(coding_agents_dir, session_log_dir, "10m")
        sd = _make_scenario(scenarios_dir, "x")
        (sd / "story.md").write_text("---\nid: x\ntitle: x\nquorum_max_time: ninety\n---\nbody\n")
        out_root = tmp_path / "results"

        with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass) as mock_g:
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert "quorum_max_time" in verdict.error.message


# The opencode CLI (bun-compiled) ends every command with a bare process.exit()
# that discards stdout not yet drained; even file-redirected tiny replies can
# vanish (exit 0, empty stdout), and with multiple provider keys ambient the
# model auto-selection floats. The fake binary encodes the required contract:
# reply only when the model is pinned and stdout is a regular file, with an
# optional one-shot dropped-reply mode to exercise the retry.
_FAKE_OPENCODE_PREFLIGHT = """#!/usr/bin/env python3
import os, stat, sys

args = sys.argv[1:]
here = os.path.dirname(os.path.abspath(sys.argv[0]))
if args and args[0] == "--version":
    sys.stdout.write("1.16.2-fake")
    sys.exit(0)
if args and args[0] == "run":
    if os.path.exists(os.path.join(here, "stderr-error-mode")):
        sys.stderr.write("provider exploded")
        sys.exit(0)
    if "-m" not in args or "openai/gpt-5.5" not in args:
        sys.stderr.write("model not pinned")
        sys.exit(0)
    marker = os.path.join(here, "first-reply-dropped")
    if os.path.exists(os.path.join(here, "drop-first-reply")) and not os.path.exists(marker):
        open(marker, "w").close()
        sys.exit(0)
    if stat.S_ISFIFO(os.fstat(1).st_mode):
        sys.exit(0)
    sys.stdout.write("OK")
"""


class TestOpencodeProviderPreflight:
    def _install_fake(self, tmp_path, monkeypatch, *, stderr_error=False, drop_first_reply=False):
        bin_dir = tmp_path / "fake-opencode-bin"
        bin_dir.mkdir(exist_ok=True)
        _exec(bin_dir / "opencode", _FAKE_OPENCODE_PREFLIGHT)
        if stderr_error:
            (bin_dir / "stderr-error-mode").touch()
        if drop_first_reply:
            (bin_dir / "drop-first-reply").touch()
        monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
        return bin_dir

    def test_preflight_pins_model_and_survives_stdout_pipe_drop(self, tmp_path, monkeypatch):
        self._install_fake(tmp_path, monkeypatch)
        _run_opencode_provider_preflight()

    def test_preflight_retries_when_reply_dropped(self, tmp_path, monkeypatch):
        bin_dir = self._install_fake(tmp_path, monkeypatch, drop_first_reply=True)
        _run_opencode_provider_preflight()
        assert (bin_dir / "first-reply-dropped").exists()

    def test_preflight_failure_carries_stderr(self, tmp_path, monkeypatch):
        self._install_fake(tmp_path, monkeypatch, stderr_error=True)
        with pytest.raises(RunnerError, match="provider exploded"):
            _run_opencode_provider_preflight()
