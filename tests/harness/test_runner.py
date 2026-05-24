# tests/harness/test_runner.py
import json
import stat
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from harness.coding_agent_config import CodingAgentConfig
from harness.runner import RunnerError, _seed_agent_config_dir, run_scenario


def _exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _make_coding_agent(coding_agents_dir: Path, name: str, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / f"{name}.yaml").write_text(yaml.safe_dump({
        "name": name,
        "binary": "echo",  # we never actually run the real CLI in tests
        "agent_config_env": "CLAUDE_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }))


# Tests pass an empty dir as skeleton_root so _seed_agent_config_dir falls
# through to mkdir-empty without requiring the production skeleton fixture.
def _empty_skeleton(tmp_path: Path) -> Path:
    p = tmp_path / "empty-fixtures"
    p.mkdir(exist_ok=True)
    return p


def _tcfg(name: str = "claude") -> CodingAgentConfig:
    return CodingAgentConfig(
        name=name,
        binary="echo",
        agent_config_env="CLAUDE_CONFIG_DIR",
        session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob="*.jsonl",
        normalizer="claude",
        required_env=(),
        max_time=None,
    )


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
        (sd / "checks.sh").write_text(
            f"pre() {{ :; }}\npost() {{ {check_line}; }}\n"
        )
    return sd


def _stub_gauntlet_pass(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return "pass"


def _stub_gauntlet_fail(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return "fail"


class TestSeedAgentConfigDir:
    def test_mkdir_empty_when_no_skeleton(self, tmp_path):
        dest = tmp_path / "agent-config"
        _seed_agent_config_dir(_tcfg("anything"), tmp_path / "no-fixtures", dest, tmp_path)
        assert dest.is_dir()
        assert list(dest.iterdir()) == []

    def test_copies_skeleton_and_injects_workdir_trust_for_claude(self, tmp_path):
        skel = tmp_path / "skeleton-claude-home"
        skel.mkdir()
        (skel / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        dest = tmp_path / "agent-config"

        _seed_agent_config_dir(_tcfg("claude"), tmp_path, dest, workdir)

        cfg = json.loads((dest / ".claude.json").read_text())
        assert cfg["hasCompletedOnboarding"] is True
        # Per-project trust keyed by canonical (resolved) workdir path.
        entry = cfg["projects"][str(workdir.resolve())]
        assert entry["hasTrustDialogAccepted"] is True

    def test_non_claude_target_skips_trust_injection(self, tmp_path):
        # Codex gets no .claude.json trust injection (that is claude-only);
        # codex auth + plugin-hook seeding are stubbed (own tests below).
        skel = tmp_path / "skeleton-codex-home"
        skel.mkdir()
        (skel / "config.toml").write_text("[features]\nplugins = true\n")
        dest = tmp_path / "agent-config"

        with (
            patch("harness.runner._seed_codex_auth"),
            patch("harness.runner._seed_codex_plugin_hooks"),
        ):
            _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, tmp_path / "workdir")

        assert (dest / "config.toml").exists()
        assert not (dest / ".claude.json").exists()

    def test_codex_target_seeds_auth_via_codex_login(self, tmp_path, monkeypatch):
        # Codex's auth picker is gated on auth.json, not on $OPENAI_API_KEY,
        # so the runner pipes the env key through `codex login --with-api-key`
        # into the fresh per-run CODEX_HOME.
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key")
        dest = tmp_path / "agent-config"
        with (
            patch("harness.runner.subprocess.run") as mock_run,
            patch("harness.runner._seed_codex_plugin_hooks"),
        ):
            mock_run.return_value = subprocess.CompletedProcess([], 0, "", "")
            _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, tmp_path / "wd")
        (cmd, *_), kwargs = mock_run.call_args
        assert cmd == ["codex", "login", "--with-api-key"]
        assert kwargs["input"] == "sk-test-key"
        assert kwargs["env"]["CODEX_HOME"] == str(dest)

    def test_codex_seed_raises_on_login_failure(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key")
        dest = tmp_path / "agent-config"
        with (
            patch("harness.runner.subprocess.run") as mock_run,
            patch("harness.runner._seed_codex_plugin_hooks"),
        ):
            mock_run.return_value = subprocess.CompletedProcess([], 1, "", "bad key")
            with pytest.raises(RunnerError, match="codex login"):
                _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, tmp_path / "wd")

    def test_codex_seed_raises_without_api_key(self, tmp_path, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        dest = tmp_path / "agent-config"
        with (
            patch("harness.runner._seed_codex_plugin_hooks"),
            pytest.raises(RunnerError, match="OPENAI_API_KEY"),
        ):
            _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, tmp_path / "wd")

    def test_codex_target_installs_plugin_hooks(self, tmp_path, monkeypatch):
        # The runner stages Superpowers as a trusted plugin hook into the
        # per-run CODEX_HOME — the codex equivalent of claude's Superpowers
        # access. The heavy install ceremony is delegated to the shared
        # setup_helpers function; here we assert the wiring.
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        dest = tmp_path / "agent-config"
        workdir = tmp_path / "wd"
        with (
            patch("harness.runner._seed_codex_auth"),
            patch(
                "harness.runner.install_codex_superpowers_plugin_hooks"
            ) as mock_install,
        ):
            _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, workdir)
        (cmd_workdir, cmd_sp), kwargs = mock_install.call_args
        assert cmd_workdir == workdir
        assert cmd_sp == str(tmp_path / "sp")
        assert kwargs["codex_home"] == dest

    def test_codex_plugin_hooks_raise_without_superpowers_root(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
        dest = tmp_path / "agent-config"
        with (
            patch("harness.runner._seed_codex_auth"),
            pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"),
        ):
            _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, tmp_path / "wd")


class TestRunScenario:
    def test_happy_path(self, tmp_path):
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "session-logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        # Add checks.sh manually (with_checks=False skips it; add one that passes trivially)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        coding_agent_contexts_dir = tmp_path / "contexts"
        (coding_agent_contexts_dir / "claude").mkdir(parents=True)
        (coding_agent_contexts_dir / "claude" / "HOWTO.md").write_text("invoke `claude`")
        out_root = tmp_path / "results"

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
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
        coding_agent_contexts_dir = tmp_path / "contexts"
        (coding_agent_contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
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
        coding_agent_contexts_dir = tmp_path / "contexts"
        (coding_agent_contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch("harness.runner.invoke_gauntlet") as mock_g:
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
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
        (sd / "checks.sh").write_text(
            "pre() { :; }\npost() { tool-called Edit; }\n"
        )
        coding_agent_contexts_dir = tmp_path / "contexts"
        (coding_agent_contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        # Capture was empty (no real CLI run) and there's a trace check →
        # composer returns indeterminate.
        assert verdict.final == "indeterminate"

    def test_launch_cwd_sentinel_threads_through_to_gauntlet(self, tmp_path):
        # When setup.sh writes .harness-launch-cwd, the runner reads it and
        # passes that path as launch_cwd to invoke_gauntlet (which exports
        # HARNESS_AGENT_CWD for the QA agent's bash to use).
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(
            sd / "setup.sh",
            '#!/usr/bin/env bash\nset -e\n'
            'sib="${HARNESS_WORKDIR}-sibling"\nmkdir -p "$sib"\n'
            'echo "$sib" > "${HARNESS_WORKDIR}/.harness-launch-cwd"\n',
        )
        coding_agent_contexts_dir = tmp_path / "contexts"
        (coding_agent_contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        captured: dict[str, Path] = {}

        def stub(*, run_dir, launch_cwd, **kwargs):
            captured["launch_cwd"] = launch_cwd
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        with patch("harness.runner.invoke_gauntlet", side_effect=stub):
            _run_dir, _verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert captured["launch_cwd"].name.endswith("-sibling")

    def test_populate_context_dir_copies_coding_agent_contexts(self, tmp_path):
        # Spot-check that coding-agent context HOWTOs land in <run-dir>/gauntlet-agent/context/.
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        coding_agent_contexts_dir = tmp_path / "contexts"
        cd_claude = coding_agent_contexts_dir / "claude"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text("invoke `claude --foo`")
        (cd_claude / "extra.md").write_text("extra context")
        out_root = tmp_path / "results"

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            _run_dir, _verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        ctx = rd / "gauntlet-agent" / "context"
        assert (ctx / "HOWTO.md").read_text() == "invoke `claude --foo`"
        assert (ctx / "extra.md").read_text() == "extra context"

    def test_howto_substitutes_harness_agent_cwd_and_superpowers_root(
        self, tmp_path, monkeypatch
    ):
        # tmux strips arbitrary env vars from new sessions, so we burn
        # resolved values into the HOWTO at runtime instead.
        monkeypatch.setenv("SUPERPOWERS_ROOT", "/path/to/sp")
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        coding_agent_contexts_dir = tmp_path / "contexts"
        cd_claude = coding_agent_contexts_dir / "claude"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text(
            'cd "$HARNESS_AGENT_CWD"\n'
            'claude --plugin-dir "$SUPERPOWERS_ROOT"\n'
        )
        out_root = tmp_path / "results"

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            _run_dir, _verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        ctx_content = (rd / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
        # SUPERPOWERS_ROOT resolved from env.
        assert '--plugin-dir "/path/to/sp"' in ctx_content
        # HARNESS_AGENT_CWD resolved from the actual launched workdir (which
        # tempfile.mkdtemp produced under /tmp or platform equivalent).
        assert "$HARNESS_AGENT_CWD" not in ctx_content
        # The substituted value points at a real existing directory.
        cd_line = [
            ln for ln in ctx_content.splitlines() if ln.startswith("cd ")
        ][0]
        resolved = cd_line.split('"')[1]
        assert Path(resolved).exists()

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
        coding_agent_contexts_dir = tmp_path / "contexts"
        (coding_agent_contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"

        from harness.composer import FinalVerdict
        fake_verdict = FinalVerdict(final="pass")

        with (
            patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
            patch("harness.runner.compose", return_value=fake_verdict),
        ):
            _run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                coding_agent_contexts_dir=coding_agent_contexts_dir,
                out_root=out_root,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        assert (rd / "coding-agent-workdir").is_dir()
        assert not (rd / "workdir-path.txt").exists()
