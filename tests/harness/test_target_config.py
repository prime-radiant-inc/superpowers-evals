# tests/harness/test_target_config.py
from pathlib import Path

import pytest
import yaml

from harness.target_config import TargetConfig, TargetConfigError, load_target_config


def _write(tmp_path: Path, name: str, doc: dict) -> Path:
    p = tmp_path / f"{name}.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


class TestLoadTargetConfig:
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
        cfg = load_target_config(path)
        assert isinstance(cfg, TargetConfig)
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
        cfg = load_target_config(path)
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
        cfg = load_target_config(path)
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
        with pytest.raises(TargetConfigError, match="ANTHROPIC_API_KEY"):
            load_target_config(path)

    def test_missing_agent_config_env_raises(self, tmp_path):
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })
        with pytest.raises(TargetConfigError, match="agent_config_env"):
            load_target_config(path)

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
        with pytest.raises(TargetConfigError, match="weirdo"):
            load_target_config(path)

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
        cfg = load_target_config(path)
        assert cfg.max_time == "5m"
