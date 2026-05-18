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
            "session_log_dir": "~/.claude/projects",
            "session_log_glob": "**/session-*.jsonl",
            "normalizer": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
        })
        cfg = load_target_config(path)
        assert isinstance(cfg, TargetConfig)
        assert cfg.name == "claude"
        assert cfg.binary == "claude"
        assert cfg.session_log_dir == Path("~/.claude/projects").expanduser()
        assert cfg.normalizer == "claude"
        assert cfg.max_time is None

    def test_missing_required_env_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
        })
        with pytest.raises(TargetConfigError, match="ANTHROPIC_API_KEY"):
            load_target_config(path)

    def test_unknown_normalizer_raises(self, tmp_path, monkeypatch):
        path = _write(tmp_path, "weirdo", {
            "name": "weirdo",
            "binary": "weirdo",
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
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
            "max_time": "5m",
        })
        cfg = load_target_config(path)
        assert cfg.max_time == "5m"
