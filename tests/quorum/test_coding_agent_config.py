# tests/quorum/test_coding_agent_config.py
import os
from pathlib import Path

import pytest
import yaml

from quorum.coding_agent_config import (
    CodingAgentConfig,
    CodingAgentConfigError,
    default_superpowers_root,
    ensure_superpowers_root_default,
    load_coding_agent_config,
)


def _write(tmp_path: Path, name: str, doc: dict) -> Path:
    p = tmp_path / f"{name}.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


def test_default_superpowers_root_detects_nested_evals_checkout(tmp_path):
    superpowers = tmp_path / "superpowers"
    evals = superpowers / "evals"
    (superpowers / "skills").mkdir(parents=True)
    evals.mkdir()

    assert default_superpowers_root(evals) == superpowers


def test_default_superpowers_root_ignores_standalone_checkout(tmp_path):
    checkout = tmp_path / "superpowers-evals"
    checkout.mkdir()

    assert default_superpowers_root(checkout) is None


def test_ensure_superpowers_root_default_respects_existing_value(tmp_path, monkeypatch):
    superpowers = tmp_path / "superpowers"
    evals = superpowers / "evals"
    (superpowers / "skills").mkdir(parents=True)
    evals.mkdir()
    monkeypatch.setenv("SUPERPOWERS_ROOT", "/custom/superpowers")

    ensure_superpowers_root_default(evals)

    assert os.environ["SUPERPOWERS_ROOT"] == "/custom/superpowers"


def test_ensure_superpowers_root_default_sets_nested_value(tmp_path, monkeypatch):
    superpowers = tmp_path / "superpowers"
    evals = superpowers / "evals"
    (superpowers / "skills").mkdir(parents=True)
    evals.mkdir()
    monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)

    ensure_superpowers_root_default(evals)

    assert os.environ["SUPERPOWERS_ROOT"] == str(superpowers)


def test_antigravity_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "antigravity.yaml"
    )

    assert cfg.name == "antigravity"
    assert cfg.binary == "agy"
    assert cfg.agent_config_env == "ANTIGRAVITY_CONFIG_DIR"
    assert cfg.normalizer == "antigravity"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (
        tmp_path / "cfg" / ".gemini" / "antigravity-cli" / "brain"
    )


def test_claude_config_exposes_runtime_family_and_model(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))

    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "claude.yaml"
    )

    assert cfg.name == "claude"
    assert cfg.runtime_family == "claude"
    assert cfg.model == "opus"
    assert (
        cfg.project_prompt
        == (
            Path(__file__).resolve().parents[2] / "coding-agents" / "claude.project-prompt.md"
        ).resolve()
    )


def test_claude_haiku_config_loads(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))

    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "claude-haiku.yaml"
    )

    assert cfg.name == "claude-haiku"
    assert cfg.runtime_family == "claude"
    assert cfg.binary == "claude"
    assert cfg.agent_config_env == "CLAUDE_CONFIG_DIR"
    assert cfg.normalizer == "claude"
    assert cfg.model == "claude-haiku-4-5-20251001"
    assert (
        cfg.project_prompt
        == (
            Path(__file__).resolve().parents[2] / "coding-agents" / "claude.project-prompt.md"
        ).resolve()
    )


def test_gemini_config_loads_when_env_set(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "gemini.yaml"
    )

    assert cfg.name == "gemini"
    assert cfg.binary == "gemini"
    assert cfg.agent_config_env == "GEMINI_CLI_HOME"
    assert cfg.normalizer == "gemini"
    assert cfg.session_log_glob == "**/chats/**/*.json*"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (tmp_path / "cfg" / ".gemini" / "tmp")


def test_opencode_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "opencode.yaml"
    )

    assert cfg.name == "opencode"
    assert cfg.binary == "opencode"
    assert cfg.agent_config_env == "OPENCODE_QUORUM_HOME"
    assert cfg.session_log_glob == "[0-9]*-ses_*.json"
    assert cfg.normalizer == "opencode"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (
        tmp_path / "cfg" / ".quorum" / "session-exports"
    )


def test_pi_config_loads_when_env_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
    monkeypatch.setenv("PI_MODEL", "gpt-5.4")
    monkeypatch.setenv("PI_API_KEY", "pi-test-key")

    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "pi.yaml"
    )

    assert cfg.name == "pi"
    assert cfg.binary == "pi"
    assert cfg.agent_config_env == "PI_CODING_AGENT_DIR"
    assert cfg.normalizer == "pi"
    assert cfg.session_log_glob == "*.jsonl"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == tmp_path / "cfg" / "sessions"


def test_kimi_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "kimi.yaml"
    )

    assert cfg.name == "kimi"
    assert cfg.binary == "kimi"
    assert cfg.agent_config_env == "KIMI_CODE_HOME"
    assert cfg.required_env == ("SUPERPOWERS_ROOT", "KIMI_MODEL_API_KEY")
    assert cfg.normalizer == "kimi"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (tmp_path / "cfg" / "sessions")


def test_kimi_config_requires_model_api_key(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.delenv("KIMI_MODEL_API_KEY", raising=False)

    with pytest.raises(CodingAgentConfigError, match="KIMI_MODEL_API_KEY"):
        load_coding_agent_config(
            Path(__file__).resolve().parents[2] / "coding-agents" / "kimi.yaml"
        )


def test_copilot_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "copilot.yaml"
    )

    assert cfg.name == "copilot"
    assert cfg.binary == "copilot"
    assert cfg.agent_config_env == "COPILOT_HOME"
    assert cfg.session_log_glob == "**/events.jsonl"
    assert cfg.normalizer == "copilot"
    assert cfg.required_env == ("SUPERPOWERS_ROOT",)
    assert cfg.max_time == "10m"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (tmp_path / "cfg" / "session-state")


class TestLoadCodingAgentConfig:
    def test_minimal_valid(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        path = _write(
            tmp_path,
            "claude",
            {
                "name": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
                "session_log_glob": "**/session-*.jsonl",
                "normalizer": "claude",
                "required_env": ["ANTHROPIC_API_KEY"],
                "model": "opus",
            },
        )
        cfg = load_coding_agent_config(path)
        assert isinstance(cfg, CodingAgentConfig)
        assert cfg.name == "claude"
        assert cfg.binary == "claude"
        assert cfg.agent_config_env == "CLAUDE_CONFIG_DIR"
        assert cfg.session_log_dir == "${CLAUDE_CONFIG_DIR}/projects"
        assert cfg.normalizer == "claude"
        assert cfg.max_time is None

    def test_runtime_family_defaults_to_name_and_model_defaults_unset(self, tmp_path):
        path = _write(
            tmp_path,
            "codex",
            {
                "name": "codex",
                "binary": "codex",
                "agent_config_env": "CODEX_HOME",
                "session_log_dir": "${CODEX_HOME}/sessions",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
            },
        )

        cfg = load_coding_agent_config(path)

        assert cfg.runtime_family == "codex"
        assert cfg.model is None

    def test_valid_claude_variant_loads_runtime_family_and_model(self, tmp_path):
        path = _write(
            tmp_path,
            "claude-haiku",
            {
                "name": "claude-haiku",
                "runtime_family": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
                "session_log_glob": "**/*.jsonl",
                "normalizer": "claude",
                "required_env": [],
                "model": "claude-haiku-4-5-20251001",
            },
        )

        cfg = load_coding_agent_config(path)

        assert cfg.name == "claude-haiku"
        assert cfg.runtime_family == "claude"
        assert cfg.model == "claude-haiku-4-5-20251001"

    def test_file_stem_must_match_name(self, tmp_path):
        path = _write(
            tmp_path,
            "claude-haiku",
            {
                "name": "claude",
                "runtime_family": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
                "session_log_glob": "**/*.jsonl",
                "normalizer": "claude",
                "required_env": [],
                "model": "claude-haiku-4-5-20251001",
            },
        )

        with pytest.raises(CodingAgentConfigError, match="name must match file stem"):
            load_coding_agent_config(path)

    def test_unknown_runtime_family_raises(self, tmp_path):
        path = _write(
            tmp_path,
            "strange",
            {
                "name": "strange",
                "runtime_family": "strange",
                "binary": "strange",
                "agent_config_env": "STRANGE_HOME",
                "session_log_dir": "/tmp/strange",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
            },
        )

        with pytest.raises(CodingAgentConfigError, match="unknown runtime_family"):
            load_coding_agent_config(path)

    def test_claude_family_requires_model(self, tmp_path):
        path = _write(
            tmp_path,
            "claude-haiku",
            {
                "name": "claude-haiku",
                "runtime_family": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
                "session_log_glob": "**/*.jsonl",
                "normalizer": "claude",
                "required_env": [],
            },
        )

        with pytest.raises(CodingAgentConfigError, match="model"):
            load_coding_agent_config(path)

    def test_model_must_not_be_blank(self, tmp_path):
        path = _write(
            tmp_path,
            "claude-haiku",
            {
                "name": "claude-haiku",
                "runtime_family": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
                "session_log_glob": "**/*.jsonl",
                "normalizer": "claude",
                "required_env": [],
                "model": " ",
            },
        )

        with pytest.raises(CodingAgentConfigError, match="model must not be blank"):
            load_coding_agent_config(path)

    def test_model_must_be_string_when_provided(self, tmp_path):
        path = _write(
            tmp_path,
            "codex",
            {
                "name": "codex",
                "binary": "codex",
                "agent_config_env": "CODEX_HOME",
                "session_log_dir": "${CODEX_HOME}/sessions",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
                "model": 123,
            },
        )

        with pytest.raises(CodingAgentConfigError, match="model must be a string"):
            load_coding_agent_config(path)

    def test_non_claude_variant_is_rejected_in_v1(self, tmp_path):
        path = _write(
            tmp_path,
            "opencode-claude",
            {
                "name": "opencode-claude",
                "runtime_family": "opencode",
                "binary": "opencode",
                "agent_config_env": "OPENCODE_QUORUM_HOME",
                "session_log_dir": "${OPENCODE_QUORUM_HOME}/sessions",
                "session_log_glob": "*.json",
                "normalizer": "opencode",
                "required_env": [],
                "model": "anthropic/claude-sonnet-4-6",
            },
        )

        with pytest.raises(CodingAgentConfigError, match="non-Claude variants"):
            load_coding_agent_config(path)

    def test_resolve_session_log_dir_substitutes_agent_config(self, tmp_path):
        path = _write(
            tmp_path,
            "claude",
            {
                "name": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
                "model": "opus",
            },
        )
        cfg = load_coding_agent_config(path)
        resolved = cfg.resolve_session_log_dir(Path("/tmp/agent-cfg"))
        assert resolved == Path("/tmp/agent-cfg/projects")

    def test_resolve_session_log_dir_literal_path_unchanged(self, tmp_path):
        # No placeholder: resolve is a no-op aside from expanduser.
        path = _write(
            tmp_path,
            "codex",
            {
                "name": "codex",
                "binary": "codex",
                "agent_config_env": "CODEX_HOME",
                "session_log_dir": "~/literal/path",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
            },
        )
        cfg = load_coding_agent_config(path)
        resolved = cfg.resolve_session_log_dir(Path("/tmp/ignored"))
        assert resolved == Path("~/literal/path").expanduser()

    def test_missing_required_env_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        path = _write(
            tmp_path,
            "claude",
            {
                "name": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "/tmp",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": ["ANTHROPIC_API_KEY"],
                "model": "opus",
            },
        )
        with pytest.raises(CodingAgentConfigError, match="ANTHROPIC_API_KEY"):
            load_coding_agent_config(path)

    def test_missing_agent_config_env_raises(self, tmp_path):
        path = _write(
            tmp_path,
            "claude",
            {
                "name": "claude",
                "binary": "claude",
                "session_log_dir": "/tmp",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
            },
        )
        with pytest.raises(CodingAgentConfigError, match="agent_config_env"):
            load_coding_agent_config(path)

    def test_unknown_normalizer_raises(self, tmp_path, monkeypatch):
        path = _write(
            tmp_path,
            "codex",
            {
                "name": "codex",
                "binary": "codex",
                "agent_config_env": "CODEX_HOME",
                "session_log_dir": "/tmp",
                "session_log_glob": "*.jsonl",
                "normalizer": "weirdo",
                "required_env": [],
            },
        )
        with pytest.raises(CodingAgentConfigError, match="weirdo"):
            load_coding_agent_config(path)

    def test_max_time_optional(self, tmp_path):
        path = _write(
            tmp_path,
            "claude",
            {
                "name": "claude",
                "binary": "claude",
                "agent_config_env": "CLAUDE_CONFIG_DIR",
                "session_log_dir": "/tmp",
                "session_log_glob": "*.jsonl",
                "normalizer": "claude",
                "required_env": [],
                "max_time": "5m",
                "model": "opus",
            },
        )
        cfg = load_coding_agent_config(path)
        assert cfg.max_time == "5m"
