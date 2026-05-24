# tests/harness/test_runner_always_verdict.py
"""Task 2.8: verify run_scenario always writes verdict.json, even on crash.

A setup.sh that exits non-zero must still produce a verdict.json with
final=indeterminate and error.stage=setup.  Same for unexpected harness errors.
"""
import json
import stat
from pathlib import Path
from unittest.mock import patch

import yaml

from harness.composer import FinalVerdict
from harness.runner import run_scenario

# ---------------------------------------------------------------------------
# Helpers (shared with test_runner_gating pattern)
# ---------------------------------------------------------------------------

def _make_coding_agent(coding_agents_dir: Path, name: str, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / f"{name}.yaml").write_text(yaml.safe_dump({
        "name": name,
        "binary": "echo",
        "agent_config_env": "CLAUDE_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }))


def _exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _invoke(
    tmp_path: Path,
    scenario_dir: Path,
    coding_agent: str = "claude",
) -> tuple[Path, FinalVerdict]:
    """Invoke run_scenario with minimal fixture wiring."""
    coding_agents_dir = tmp_path / "coding-agents"
    session_log_dir = tmp_path / "session-logs"
    session_log_dir.mkdir(parents=True, exist_ok=True)
    _make_coding_agent(coding_agents_dir, coding_agent, session_log_dir)

    contexts_dir = tmp_path / "contexts"
    (contexts_dir / coding_agent).mkdir(parents=True, exist_ok=True)

    skeleton_root = tmp_path / "fixtures"
    skeleton_root.mkdir(exist_ok=True)

    out_root = tmp_path / "results"

    return run_scenario(
        scenario_dir=scenario_dir,
        coding_agent=coding_agent,
        coding_agents_dir=coding_agents_dir,
        coding_agent_contexts_dir=contexts_dir,
        out_root=out_root,
        skeleton_root=skeleton_root,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAlwaysVerdict:
    def test_setup_failure_yields_indeterminate_verdict(self, tmp_path):
        """A scenario whose setup.sh exits non-zero must still produce a verdict.json
        with final=indeterminate, error.stage=setup."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text(
            "---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n"
        )
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 1\n")
        # No checks.sh — old path; setup failure raises RunnerError wrapping SetupError.

        run_dir, verdict = _invoke(tmp_path, scen)

        assert run_dir.is_dir(), "run_dir must exist"
        verdict_path = run_dir / "verdict.json"
        assert verdict_path.exists(), "verdict.json must be written even on setup failure"
        data = json.loads(verdict_path.read_text())
        assert data["final"] == "indeterminate"
        assert data["error"] is not None
        assert data["error"]["stage"] == "setup"

    def test_setup_failure_verdict_object_matches_json(self, tmp_path):
        """The returned verdict object must match what was written to disk."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text(
            "---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n"
        )
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 1\n")

        run_dir, verdict = _invoke(tmp_path, scen)

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"

    def test_setup_failure_run_dir_returned(self, tmp_path):
        """run_dir must be the first return value and must exist on disk."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text(
            "---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n"
        )
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\necho 'boom'; exit 1\n")

        run_dir, verdict = _invoke(tmp_path, scen)

        out_root = tmp_path / "results"
        assert run_dir.parent == out_root
        assert run_dir.name.startswith("s-claude-")
        assert run_dir.is_dir()

    def test_runner_error_yields_indeterminate_verdict(self, tmp_path):
        """A RunnerError (e.g. missing story.md) is caught and written as indeterminate."""
        scen = tmp_path / "s"
        scen.mkdir()
        # Deliberately omit story.md to trigger RunnerError
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 0\n")

        run_dir, verdict = _invoke(tmp_path, scen)

        verdict_path = run_dir / "verdict.json"
        assert verdict_path.exists()
        data = json.loads(verdict_path.read_text())
        assert data["final"] == "indeterminate"
        assert data["error"] is not None
        # Missing story.md is a RunnerError → stage="unknown"
        assert data["error"]["stage"] == "unknown"

    def test_unexpected_exception_yields_indeterminate_verdict(self, tmp_path):
        """An unexpected exception from _run_scenario_inner is caught by the wrapper."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text(
            "---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n"
        )
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 0\n")

        def _boom(**kwargs):
            raise ValueError("simulated unexpected crash")

        with patch("harness.runner._run_scenario_inner", side_effect=_boom):
            run_dir, verdict = _invoke(tmp_path, scen)

        verdict_path = run_dir / "verdict.json"
        assert verdict_path.exists()
        data = json.loads(verdict_path.read_text())
        assert data["final"] == "indeterminate"
        assert "unexpected harness crash" in data["final_reason"]
        assert data["error"]["stage"] == "unknown"
        assert "simulated unexpected crash" in data["error"]["message"]

    def test_verdict_json_written_before_exception_propagates(self, tmp_path):
        """verdict.json must exist on disk regardless of which exception fires."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text(
            "---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n"
        )
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 1\n")

        run_dir, _verdict = _invoke(tmp_path, scen)

        # verdict.json must exist and be valid JSON
        data = json.loads((run_dir / "verdict.json").read_text())
        assert data["final"] == "indeterminate"
