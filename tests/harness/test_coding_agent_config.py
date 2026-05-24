# tests/harness/test_coding_agent_config.py
from pathlib import Path

import pytest
import yaml

from harness.coding_agent_config import (
    CodingAgentConfig,
    CodingAgentConfigError,
    load_coding_agent_config,
)


def _write(tmp_path: Path, name: str, doc: dict) -> Path:
    p = tmp_path / f"{name}.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


class TestLoadCodingAgentConfig:
    def test_minimal_valid(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "agent_config_env": "CLAUDE_CONFIG_DIR",
            "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
            "session_log_glob": "**/session-*.jsonl",
            "normalizer": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
        })
        cfg = load_coding_agent_config(path)
        assert isinstance(cfg, CodingAgentConfig)
        assert cfg.name == "claude"
        assert cfg.binary == "claude"
        assert cfg.agent_config_env == "CLAUDE_CONFIG_DIR"
        assert cfg.session_log_dir == "${CLAUDE_CONFIG_DIR}/projects"
        assert cfg.normalizer == "claude"
        assert cfg.max_time is None

    def test_resolve_session_log_dir_substitutes_agent_config(self, tmp_path):
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "agent_config_env": "CLAUDE_CONFIG_DIR",
            "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })
        cfg = load_coding_agent_config(path)
        resolved = cfg.resolve_session_log_dir(Path("/tmp/agent-cfg"))
        assert resolved == Path("/tmp/agent-cfg/projects")

    def test_resolve_session_log_dir_literal_path_unchanged(self, tmp_path):
        # No placeholder: resolve is a no-op aside from expanduser.
        path = _write(tmp_path, "weirdo", {
            "name": "weirdo",
            "binary": "weirdo",
            "agent_config_env": "WEIRDO_HOME",
            "session_log_dir": "~/literal/path",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })
        cfg = load_coding_agent_config(path)
        resolved = cfg.resolve_session_log_dir(Path("/tmp/ignored"))
        assert resolved == Path("~/literal/path").expanduser()

    def test_missing_required_env_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "agent_config_env": "CLAUDE_CONFIG_DIR",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
        })
        with pytest.raises(CodingAgentConfigError, match="ANTHROPIC_API_KEY"):
            load_coding_agent_config(path)

    def test_missing_agent_config_env_raises(self, tmp_path):
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })
        with pytest.raises(CodingAgentConfigError, match="agent_config_env"):
            load_coding_agent_config(path)

    def test_unknown_normalizer_raises(self, tmp_path, monkeypatch):
        path = _write(tmp_path, "weirdo", {
            "name": "weirdo",
            "binary": "weirdo",
            "agent_config_env": "WEIRDO_HOME",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "weirdo",
            "required_env": [],
        })
        with pytest.raises(CodingAgentConfigError, match="weirdo"):
            load_coding_agent_config(path)

    def test_max_time_optional(self, tmp_path):
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "agent_config_env": "CLAUDE_CONFIG_DIR",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
            "max_time": "5m",
        })
        cfg = load_coding_agent_config(path)
        assert cfg.max_time == "5m"
