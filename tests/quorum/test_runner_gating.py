# tests/quorum/test_runner_gating.py
"""Task 2.6: verify coding-agent gating via # coding-agents: magic comment.

The runner reads the directive from checks.sh AFTER allocating run_dir but
BEFORE setup.sh, _seed_agent_config_dir, or any other side effect. A
mismatched Coding-Agent returns final=indeterminate with a final_reason that
names the required agents. Compatible agents (or absent directive) proceed.
"""

import json
import stat
from pathlib import Path
from unittest.mock import patch

import yaml

from quorum.composer import FinalVerdict
from quorum.runner import run_scenario

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_coding_agent(coding_agents_dir: Path, name: str, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "name": name,
        "binary": "echo",
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


def _exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _scenario(
    d: Path,
    *,
    checks_body: str,
    setup_body: str = "#!/usr/bin/env bash\necho 'SETUP RAN'\n",
) -> Path:
    """Build a minimal scenario dir with story.md, setup.sh, and checks.sh."""
    d.mkdir(parents=True)
    (d / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
    _exec(d / "setup.sh", setup_body)
    (d / "checks.sh").write_text(checks_body)
    return d


def _run(
    tmp_path: Path,
    scenario_dir: Path,
    coding_agent: str = "claude",
) -> FinalVerdict:
    """Invoke run_scenario with minimal fixture wiring. Returns the FinalVerdict."""
    coding_agents_dir = tmp_path / "coding-agents"
    session_log_dir = tmp_path / "session-logs"
    session_log_dir.mkdir(parents=True, exist_ok=True)
    _make_coding_agent(coding_agents_dir, coding_agent, session_log_dir)

    context_name = "claude" if coding_agent == "claude-haiku" else coding_agent
    (coding_agents_dir / f"{context_name}-context").mkdir(parents=True, exist_ok=True)

    skeleton_root = tmp_path / "fixtures"
    skeleton_root.mkdir(exist_ok=True)

    out_root = tmp_path / "results"

    _run_dir, verdict = run_scenario(
        scenario_dir=scenario_dir,
        coding_agent=coding_agent,
        coding_agents_dir=coding_agents_dir,
        out_root=out_root,
        skeleton_root=skeleton_root,
    )
    return verdict


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCodingAgentGating:
    def test_incompatible_coding_agent_returns_indeterminate(self, tmp_path):
        """A scenario requiring codex run with claude → final=indeterminate."""
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: codex\npre() { :; }\npost() { :; }\n",
        )
        # setup.sh must NOT be called — patch invoke_gauntlet to catch any slip
        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            verdict = _run(tmp_path, scen, coding_agent="claude")
        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"

    def test_incompatible_final_reason_names_required_agents(self, tmp_path):
        """final_reason says 'requires coding-agents: codex'."""
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: codex\npre() { :; }\npost() { :; }\n",
        )
        with patch("quorum.runner.invoke_gauntlet"):
            verdict = _run(tmp_path, scen, coding_agent="claude")
        assert "requires coding-agents" in verdict.final_reason
        assert "codex" in verdict.final_reason

    def test_incompatible_verdict_written_to_disk(self, tmp_path):
        """verdict.json is written even when bailing early."""
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: codex\npre() { :; }\npost() { :; }\n",
        )
        out_root = tmp_path / "results"
        coding_agents_dir = tmp_path / "coding-agents"
        session_log_dir = tmp_path / "session-logs"
        session_log_dir.mkdir(parents=True, exist_ok=True)
        _make_coding_agent(coding_agents_dir, "claude", session_log_dir)
        (coding_agents_dir / "claude-context").mkdir(parents=True, exist_ok=True)
        skeleton_root = tmp_path / "fixtures"
        skeleton_root.mkdir(exist_ok=True)

        with patch("quorum.runner.invoke_gauntlet"):
            run_scenario(
                scenario_dir=scen,
                coding_agent="claude",
                coding_agents_dir=coding_agents_dir,
                out_root=out_root,
                skeleton_root=skeleton_root,
            )

        run_dirs = list(out_root.iterdir())
        assert len(run_dirs) == 1
        data = json.loads((run_dirs[0] / "verdict.json").read_text())
        assert data["final"] == "indeterminate"
        assert "requires coding-agents" in data["final_reason"]

    def test_setup_not_executed_on_incompatible_agent(self, tmp_path, monkeypatch):
        """setup.sh must NOT run when the coding-agent is incompatible."""
        marker = tmp_path / "setup-ran-marker"
        # Write a setup.sh that would create the marker file
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: codex\npre() { :; }\npost() { :; }\n",
            setup_body=f"#!/usr/bin/env bash\ntouch '{marker}'\n",
        )
        with patch("quorum.runner.invoke_gauntlet"):
            _run(tmp_path, scen, coding_agent="claude")
        assert not marker.exists(), "setup.sh should NOT have run for incompatible agent"

    def test_compatible_agent_proceeds_normally(self, tmp_path):
        """A matching directive does NOT bail — gauntlet is invoked."""
        from quorum.composer import FinalVerdict

        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: claude\npre() { :; }\npost() { :; }\n",
        )
        invoked = []

        def fake_gauntlet(*, run_dir, **kwargs):
            invoked.append(True)
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        fake_verdict = FinalVerdict(final="pass")
        with (
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
            patch("quorum.runner.compose", return_value=fake_verdict),
        ):
            _run(tmp_path, scen, coding_agent="claude")

        assert invoked, "invoke_gauntlet should have been called for a compatible agent"

    def test_claude_directive_does_not_include_claude_haiku(self, tmp_path):
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: claude\npre() { :; }\npost() { :; }\n",
        )

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            verdict = _run(tmp_path, scen, coding_agent="claude-haiku")

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert "requires coding-agents" in verdict.final_reason

    def test_haiku_directive_proceeds_for_claude_haiku(self, tmp_path):
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: claude-haiku\npre() { :; }\npost() { :; }\n",
        )
        invoked = []

        def fake_gauntlet(*, run_dir, **kwargs):
            invoked.append(True)
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        fake_verdict = FinalVerdict(final="pass")
        with (
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
            patch("quorum.runner.compose", return_value=fake_verdict),
        ):
            _run(tmp_path, scen, coding_agent="claude-haiku")

        assert invoked

    def test_haiku_directive_does_not_include_claude(self, tmp_path):
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: claude-haiku\npre() { :; }\npost() { :; }\n",
        )

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            verdict = _run(tmp_path, scen, coding_agent="claude")

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert "requires coding-agents" in verdict.final_reason

    def test_no_directive_proceeds_for_any_agent(self, tmp_path):
        """Absent directive → compatible with every Coding-Agent."""
        from quorum.composer import FinalVerdict

        scen = _scenario(
            tmp_path / "s",
            checks_body="# no directive here\npre() { :; }\npost() { :; }\n",
        )
        invoked = []

        def fake_gauntlet(*, run_dir, **kwargs):
            invoked.append(True)
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        fake_verdict = FinalVerdict(final="pass")
        with (
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
            patch("quorum.runner.compose", return_value=fake_verdict),
        ):
            _run(tmp_path, scen, coding_agent="claude")

        assert invoked, "invoke_gauntlet should have been called when no directive present"

    def test_no_checks_sh_returns_indeterminate(self, tmp_path):
        """A scenario without checks.sh → final=indeterminate (checks.sh is required)."""
        d = tmp_path / "s"
        d.mkdir(parents=True)
        (d / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
        _exec(d / "setup.sh", "#!/usr/bin/env bash\necho ok\n")
        # No checks.sh at all

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            verdict = _run(tmp_path, d, coding_agent="claude")

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert "checks.sh" in verdict.final_reason

    def test_multi_agent_directive_matches_any_listed(self, tmp_path):
        """# coding-agents: codex, claude → claude is allowed."""
        from quorum.composer import FinalVerdict

        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: codex, claude\npre() { :; }\npost() { :; }\n",
        )
        invoked = []

        def fake_gauntlet(*, run_dir, **kwargs):
            invoked.append(True)
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        fake_verdict = FinalVerdict(final="pass")
        with (
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
            patch("quorum.runner.compose", return_value=fake_verdict),
        ):
            _run(tmp_path, scen, coding_agent="claude")

        assert invoked, "claude should be allowed when listed alongside codex"

    def test_multi_agent_directive_rejects_unlisted(self, tmp_path):
        """# coding-agents: codex, gemini → claude is NOT allowed."""
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: codex, gemini\npre() { :; }\npost() { :; }\n",
        )
        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            verdict = _run(tmp_path, scen, coding_agent="claude")
        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert "codex" in verdict.final_reason
        assert "gemini" in verdict.final_reason
