from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from drill.backend import Backend
from drill.engine import Engine, RunResult, ScenarioConfig, VerifyConfig, snapshot_filesystem


class TestVerifyConfig:
    def test_defaults(self):
        vc = VerifyConfig()
        assert vc.criteria == []
        assert vc.assertions == []
        assert vc.observe is False

    def test_from_dict(self):
        vc = VerifyConfig(
            criteria=["test criterion"],
            assertions=["tool-called Read"],
            observe=True,
        )
        assert len(vc.criteria) == 1
        assert len(vc.assertions) == 1
        assert vc.observe is True


class TestScenarioConfig:
    def test_loads_from_yaml(self, tmp_path):
        scenario_file = tmp_path / "test.yaml"
        scenario_file.write_text("""
scenario: test-scenario
description: "A test"
user_posture: naive
setup:
  helpers:
    - create_base_repo
  assertions:
    - "git rev-parse --is-inside-work-tree"
turns:
  - intent: "Do the thing"
limits:
  max_turns: 10
  turn_timeout: 60
verify:
  criteria:
    - "Thing was done"
  assertions:
    - "tool-called Bash"
  observe: true
""")
        config = ScenarioConfig.from_yaml(scenario_file)
        assert config.scenario == "test-scenario"
        assert config.user_posture == "naive"
        assert config.limits["max_turns"] == 10
        assert len(config.turns) == 1
        assert len(config.verify.criteria) == 1
        assert len(config.verify.assertions) == 1
        assert config.verify.observe is True

    def test_loads_without_assertions(self, tmp_path):
        scenario_file = tmp_path / "test.yaml"
        scenario_file.write_text("""
scenario: minimal
verify:
  criteria:
    - "Something happened"
""")
        config = ScenarioConfig.from_yaml(scenario_file)
        assert config.verify.assertions == []
        assert config.verify.observe is False

    def test_loads_without_verify(self, tmp_path):
        scenario_file = tmp_path / "test.yaml"
        scenario_file.write_text("""
scenario: bare-minimum
""")
        config = ScenarioConfig.from_yaml(scenario_file)
        assert config.verify.criteria == []
        assert config.verify.assertions == []


class TestSnapshotFilesystem:
    def test_captures_git_state(self, tmp_path):
        subprocess.run(["git", "init", "-b", "main"], cwd=tmp_path, capture_output=True)
        subprocess.run(
            ["git", "commit", "--allow-empty", "-m", "init"], cwd=tmp_path, capture_output=True
        )
        snapshot = snapshot_filesystem(tmp_path)
        data = json.loads(snapshot)
        assert "git_status" in data
        assert "branch" in data
        assert "worktree_list" in data
        assert "files" in data


class TestEngineLogDirs:
    def test_codex_uses_drill_codex_home_for_session_logs(self, tmp_path, monkeypatch):
        engine = object.__new__(Engine)
        engine.backend = Backend(
            name="codex",
            cli="env",
            args=[],
            required_env=[],
            hooks={"pre_run": []},
            shutdown="<<KEY:ctrl-d>>",
            idle={},
            startup_timeout=30,
            terminal={},
            session_logs={},
        )
        codex_home = tmp_path / "codex-home"
        monkeypatch.setenv("DRILL_CODEX_HOME", str(codex_home))

        assert engine._resolve_log_dir(tmp_path / "workdir") == codex_home / "sessions"

    def test_claude_uses_claude_config_dir_for_session_logs(self, tmp_path, monkeypatch):
        engine = object.__new__(Engine)
        engine.backend = Backend(
            name="claude-opus-4-7",
            cli="claude",
            args=[],
            required_env=[],
            hooks={"pre_run": []},
            shutdown="/exit",
            idle={},
            startup_timeout=30,
            terminal={},
            session_logs={},
        )
        claude_home = tmp_path / "claude-home"
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude_home))
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        encoded = str(workdir.resolve()).replace("/", "-")

        assert engine._resolve_log_dir(workdir) == claude_home / "projects" / encoded

    def test_claude_falls_back_to_home_when_config_dir_unset(self, tmp_path, monkeypatch):
        engine = object.__new__(Engine)
        engine.backend = Backend(
            name="claude-opus-4-7",
            cli="claude",
            args=[],
            required_env=[],
            hooks={"pre_run": []},
            shutdown="/exit",
            idle={},
            startup_timeout=30,
            terminal={},
            session_logs={},
        )
        monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        encoded = str(workdir.resolve()).replace("/", "-")

        assert engine._resolve_log_dir(workdir) == Path.home() / ".claude" / "projects" / encoded


class TestSeedClaudeHome:
    def _skeleton(self, root: Path) -> Path:
        skel = root / "skeleton"
        skel.mkdir()
        (skel / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
        (skel / "settings.json").write_text('{"theme": "dark"}')
        return skel

    def test_copies_skeleton_and_pre_trusts_workdir(self, tmp_path):
        from drill.engine import _seed_claude_home
        skel = self._skeleton(tmp_path)
        dest = tmp_path / "claude-home"
        workdir = tmp_path / "workdir"
        workdir.mkdir()

        _seed_claude_home(skel, dest, workdir)

        assert (dest / "settings.json").read_text() == '{"theme": "dark"}'
        cfg = json.loads((dest / ".claude.json").read_text())
        assert cfg["hasCompletedOnboarding"] is True
        entry = cfg["projects"][str(workdir.resolve())]
        assert entry["hasTrustDialogAccepted"] is True
        assert entry["projectOnboardingSeenCount"] == 1

    def test_uses_resolved_workdir_path_as_key(self, tmp_path):
        # Claude keys projects by canonical (symlink-resolved) cwd; the trust
        # entry must use the resolved path to match.
        from drill.engine import _seed_claude_home
        skel = self._skeleton(tmp_path)
        real = tmp_path / "real"
        real.mkdir()
        link = tmp_path / "link"
        link.symlink_to(real)

        _seed_claude_home(skel, tmp_path / "claude-home", link)

        cfg = json.loads((tmp_path / "claude-home" / ".claude.json").read_text())
        assert str(real.resolve()) in cfg["projects"]

    def test_raises_when_skeleton_missing(self, tmp_path):
        from drill.engine import _seed_claude_home
        with pytest.raises(FileNotFoundError, match="refresh-skeleton-claude-home"):
            _seed_claude_home(tmp_path / "missing", tmp_path / "dest", tmp_path)


class TestLaunchCommand:
    def _engine(self, name, cli, args):
        engine = object.__new__(Engine)
        engine.backend = Backend(
            name=name,
            cli=cli,
            args=args,
            required_env=[],
            hooks={"pre_run": []},
            shutdown="/exit",
            idle={},
            startup_timeout=30,
            terminal={},
            session_logs={},
        )
        engine.claude_home = None
        return engine

    def test_claude_command_bakes_in_config_dir(self, tmp_path):
        # tmux new-session inherits the server's env, not this process's, so
        # CLAUDE_CONFIG_DIR must travel inside the command string itself.
        engine = self._engine("claude-opus-4-7", "claude", ["--model", "opus"])
        engine.claude_home = tmp_path / "ch"
        cmd = engine._launch_command(tmp_path / "wd")
        assert cmd[:2] == ["env", f"CLAUDE_CONFIG_DIR={tmp_path / 'ch'}"]
        assert cmd[2] == "claude"

    def test_claude_command_unwrapped_when_no_home(self, tmp_path):
        engine = self._engine("claude-opus-4-7", "claude", ["--model", "opus"])
        engine.claude_home = None
        cmd = engine._launch_command(tmp_path / "wd")
        assert cmd[0] == "claude"

    def test_non_claude_command_not_wrapped(self, tmp_path):
        engine = self._engine("codex", "env", ["CODEX_HOME=/x", "codex"])
        engine.claude_home = None
        cmd = engine._launch_command(tmp_path / "wd")
        assert not any("CLAUDE_CONFIG_DIR" in c for c in cmd)


class TestRunResult:
    def test_serializes_to_dir(self, tmp_path):
        result = RunResult(
            scenario="test",
            backend="claude",
            timestamp="2026-04-07T14-30-00",
            session_log="session output here",
            filesystem_json='{"files": []}',
            tool_calls_jsonl='{"tool": "Bash"}\n',
            verdict_json='{"criteria": [], "observations": [], "summary": "ok"}',
            meta={"backend": "claude", "duration_seconds": 42, "actor_turns": 5},
        )
        result.save(tmp_path)
        assert (tmp_path / "session.log").read_text() == "session output here"
        assert (tmp_path / "filesystem.json").exists()
        assert (tmp_path / "tool_calls.jsonl").exists()
        assert (tmp_path / "verdict.json").exists()
        assert (tmp_path / "meta.json").exists()


class TestEngineAssertionIntegration:
    def test_run_result_save_splits_artifacts_and_verdict(self, tmp_path):
        result = RunResult(
            scenario="test",
            backend="claude",
            timestamp="2026-04-20T10-00-00",
            session_log="log here",
            filesystem_json='{"files": []}',
            tool_calls_jsonl='{"tool": "Bash"}\n',
            verdict_json='{"criteria": [], "observations": [], "summary": "ok"}',
            meta={"backend": "claude"},
        )
        result.save_artifacts(tmp_path)
        assert (tmp_path / "session.log").exists()
        assert (tmp_path / "filesystem.json").exists()
        assert (tmp_path / "tool_calls.jsonl").exists()
        assert not (tmp_path / "verdict.json").exists()
        assert not (tmp_path / "meta.json").exists()

        result.save_verdict(tmp_path)
        assert (tmp_path / "verdict.json").exists()
        assert (tmp_path / "meta.json").exists()


class TestEnginePiBackend:
    def test_resolves_pi_session_log_root(self, tmp_path: Path) -> None:
        scenario = tmp_path / "scenario.yaml"
        scenario.write_text("scenario: test-pi\n")
        backends = tmp_path / "backends"
        backends.mkdir()
        (backends / "pi.yaml").write_text(
            """
name: pi
cli: pi
args: []
required_env: []
hooks:
  pre_run: []
  post_run: []
shutdown: /quit
idle: {}
startup_timeout: 1
terminal: {}
session_logs:
  pattern: ~/.pi/agent/sessions/**/*.jsonl
"""
        )
        engine = Engine(
            scenario_path=scenario,
            backend_name="pi",
            backends_dir=backends,
            fixtures_dir=tmp_path,
            results_dir=tmp_path,
        )

        assert engine._resolve_log_dir(tmp_path) == Path.home() / ".pi" / "agent" / "sessions"


class TestEngineRunParams:
    def test_run_result_uses_custom_output_dir(self, tmp_path: Path) -> None:
        custom_dir = tmp_path / "custom" / "run-00"
        result = RunResult(
            scenario="test",
            backend="claude",
            timestamp="2026-04-20T10-00-00",
            session_log="log",
            filesystem_json='{"files": []}',
            tool_calls_jsonl='{"tool": "Bash"}\n',
            verdict_json='{"criteria": [], "observations": [], "summary": "ok"}',
            meta={"backend": "claude"},
        )
        result.save(custom_dir)
        assert (custom_dir / "session.log").read_text() == "log"
        assert (custom_dir / "verdict.json").exists()
        assert (custom_dir / "meta.json").exists()

    def test_run_result_nested_dir_created(self, tmp_path: Path) -> None:
        deep_dir = tmp_path / "a" / "b" / "c" / "run-05"
        result = RunResult(
            scenario="test",
            backend="claude",
            timestamp="2026-04-20T10-00-00",
            session_log="log",
            filesystem_json='{"files": []}',
            tool_calls_jsonl='{"tool": "Bash"}\n',
            verdict_json='{"criteria": [], "observations": [], "summary": "ok"}',
            meta={"backend": "claude"},
        )
        result.save(deep_dir)
        assert deep_dir.exists()
        assert (deep_dir / "session.log").exists()
