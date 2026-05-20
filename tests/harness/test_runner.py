# tests/harness/test_runner.py
import json
import stat
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from harness.runner import RunnerError, _seed_agent_config_dir, run_scenario
from harness.target_config import TargetConfig


def _exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _make_target(targets_dir: Path, name: str, session_log_dir: Path) -> None:
    targets_dir.mkdir(parents=True, exist_ok=True)
    (targets_dir / f"{name}.yaml").write_text(yaml.safe_dump({
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


def _tcfg(name: str = "claude") -> TargetConfig:
    return TargetConfig(
        name=name,
        binary="echo",
        agent_config_env="CLAUDE_CONFIG_DIR",
        session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob="*.jsonl",
        normalizer="claude",
        required_env=(),
        max_time=None,
    )


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
        # Codex has its own plugin-trust mechanism (per-scenario setup.sh);
        # the runner doesn't mutate codex's config.
        skel = tmp_path / "skeleton-codex-home"
        skel.mkdir()
        (skel / "config.toml").write_text("[features]\nplugins = true\n")
        dest = tmp_path / "agent-config"

        _seed_agent_config_dir(_tcfg("codex"), tmp_path, dest, tmp_path / "workdir")

        assert (dest / "config.toml").exists()
        assert not (dest / ".claude.json").exists()


def _make_scenario(
    scenarios_dir: Path,
    name: str,
    *,
    asserts_pass: bool = True,
    compat: list[str] | None = None,
    with_assertion: bool = True,
) -> Path:
    sd = scenarios_dir / name
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\ntitle: x\n---\nbody\n")
    _exec(sd / "setup.sh", "#!/usr/bin/env bash\necho ok > marker\n")
    if compat is not None:
        (sd / "scenario.yaml").write_text(yaml.safe_dump({"compatible_targets": compat}))
    a = sd / "assertions"
    a.mkdir()
    if with_assertion:
        _exec(a / "01-x.sh", f"#!/usr/bin/env bash\nexit {'0' if asserts_pass else '1'}\n")
    return sd


def _stub_gauntlet_pass(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return "pass"


def _stub_gauntlet_fail(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return "fail"


class TestRunScenario:
    def test_happy_path(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "session-logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_assertion=False)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        (contexts_dir / "claude" / "HOWTO.md").write_text("invoke `claude`")
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "pass"
        run_dirs = list(out_root.iterdir())
        assert len(run_dirs) == 1
        rd = run_dirs[0]
        assert (rd / "verdict.json").exists()
        assert (rd / "tool_calls.jsonl").exists()
        assert (rd / ".gauntlet" / "context" / "HOWTO.md").read_text() == "invoke `claude`"

    def test_assertion_fail_overrides_gauntlet_pass(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", asserts_pass=False)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "fail"
        assert verdict.assertions == "fail"

    def test_setup_failure_aborts_before_gauntlet(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(sd / "setup.sh", "#!/usr/bin/env bash\nexit 9\n")
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet") as mock_g:
            with pytest.raises(RunnerError, match="setup"):
                run_scenario(
                    scenario_dir=sd,
                    target="claude",
                    targets_dir=targets_dir,
                    contexts_dir=contexts_dir,
                    out_root=out_root,
                    bin_dir=bin_dir,
                    skeleton_root=_empty_skeleton(tmp_path),
                )
            mock_g.assert_not_called()

    def test_incompatible_target_refused(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", compat=["codex"])
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet") as mock_g:
            with pytest.raises(RunnerError, match="compat"):
                run_scenario(
                    scenario_dir=sd,
                    target="claude",
                    targets_dir=targets_dir,
                    contexts_dir=contexts_dir,
                    out_root=out_root,
                    bin_dir=bin_dir,
                    skeleton_root=_empty_skeleton(tmp_path),
                )
            mock_g.assert_not_called()

    def test_empty_capture_synthetic_fires_whenever_assertions_exist(self, tmp_path):
        # Drill parity (engine.py:169-178): the synthetic fires whenever the
        # scenario has any assertions at all, not just tool-named ones.
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")  # default assertion 01-x.sh passes
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        # Capture was empty (no real CLI run); scenario has at least one
        # assertion; synthetic 00-non-empty-capture fires regardless of name.
        assert verdict.final == "fail"
        assert any(d["name"] == "00-non-empty-capture" for d in verdict.assertion_details)

    def test_no_assertions_no_synthetic_even_when_capture_empty(self, tmp_path):
        # A scenario with zero assertions doesn't get the synthetic — the
        # guard only fires when something declared assertions to begin with.
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", with_assertion=False)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "pass"
        assert all(d["name"] != "00-non-empty-capture" for d in verdict.assertion_details)

    def test_launch_cwd_sentinel_threads_through_to_gauntlet(self, tmp_path):
        # When setup.sh writes .harness-launch-cwd, the runner reads it and
        # passes that path as launch_cwd to invoke_gauntlet (which exports
        # HARNESS_AGENT_CWD for the QA agent's bash to use).
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(
            sd / "setup.sh",
            '#!/usr/bin/env bash\nset -e\n'
            'sib="${HARNESS_WORKDIR}-sibling"\nmkdir -p "$sib"\n'
            'echo "$sib" > "${HARNESS_WORKDIR}/.harness-launch-cwd"\n',
        )
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        captured: dict[str, Path] = {}

        def stub(*, run_dir, launch_cwd, **kwargs):
            captured["launch_cwd"] = launch_cwd
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        with patch("harness.runner.invoke_gauntlet", side_effect=stub):
            run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert captured["launch_cwd"].name.endswith("-sibling")

    def test_populate_context_dir_copies_target_contexts(self, tmp_path):
        # Spot-check that target context HOWTOs land in <run-dir>/.gauntlet/context/.
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        contexts_dir = tmp_path / "contexts"
        cd_claude = contexts_dir / "claude"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text("invoke `claude --foo`")
        (cd_claude / "extra.md").write_text("extra context")
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        ctx = rd / ".gauntlet" / "context"
        assert (ctx / "HOWTO.md").read_text() == "invoke `claude --foo`"
        assert (ctx / "extra.md").read_text() == "extra context"

    def test_howto_substitutes_harness_agent_cwd_and_superpowers_root(
        self, tmp_path, monkeypatch
    ):
        # tmux strips arbitrary env vars from new sessions, so we burn
        # resolved values into the HOWTO at runtime instead.
        monkeypatch.setenv("SUPERPOWERS_ROOT", "/path/to/sp")
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        contexts_dir = tmp_path / "contexts"
        cd_claude = contexts_dir / "claude"
        cd_claude.mkdir(parents=True)
        (cd_claude / "HOWTO.md").write_text(
            'cd "$HARNESS_AGENT_CWD"\n'
            'claude --plugin-dir "$SUPERPOWERS_ROOT"\n'
        )
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        rd = list(out_root.iterdir())[0]
        ctx_content = (rd / ".gauntlet" / "context" / "HOWTO.md").read_text()
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

    def test_workdir_kept_on_failure(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", asserts_pass=False)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd,
                target="claude",
                targets_dir=targets_dir,
                contexts_dir=contexts_dir,
                out_root=out_root,
                bin_dir=bin_dir,
                skeleton_root=_empty_skeleton(tmp_path),
            )
        assert verdict.final == "fail"
        rd = list(out_root.iterdir())[0]
        wd_path = Path((rd / "workdir-path.txt").read_text().strip())
        assert wd_path.exists()

