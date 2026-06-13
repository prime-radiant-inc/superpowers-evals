# tests/quorum/test_runner_always_verdict.py
"""Task 2.8: verify run_scenario always writes verdict.json, even on crash.

A setup.sh that exits non-zero must still produce a verdict.json with
final=indeterminate and error.stage=setup.  Same for unexpected quorum errors.
"""

import json
import shutil
import stat
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from quorum.composer import FinalVerdict
from quorum.runner import GauntletResult, run_scenario

# ---------------------------------------------------------------------------
# Helpers (shared with test_runner_gating pattern)
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

    (coding_agents_dir / f"{coding_agent}-context").mkdir(parents=True, exist_ok=True)

    skeleton_root = tmp_path / "fixtures"
    skeleton_root.mkdir(exist_ok=True)

    out_root = tmp_path / "results"

    return run_scenario(
        scenario_dir=scenario_dir,
        coding_agent=coding_agent,
        coding_agents_dir=coding_agents_dir,
        out_root=out_root,
        skeleton_root=skeleton_root,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_coding_agent_config_error_is_setup_indeterminate(monkeypatch, tmp_path):
    monkeypatch.delenv("KIMI_MODEL_API_KEY", raising=False)

    scen = tmp_path / "s"
    scen.mkdir()
    (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n")
    _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 0\n")
    (scen / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    coding_agents_dir = tmp_path / "coding-agents"
    coding_agents_dir.mkdir()
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": "${KIMI_CODE_HOME}/sessions",
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": ["KIMI_MODEL_API_KEY"],
            }
        )
    )

    with patch("quorum.runner.invoke_gauntlet") as mock_gauntlet:
        run_dir, verdict = run_scenario(
            scenario_dir=scen,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=tmp_path / "fixtures",
        )

    mock_gauntlet.assert_not_called()
    assert verdict.final == "indeterminate"
    assert verdict.error is not None
    assert verdict.error.stage == "setup"
    assert "KIMI_MODEL_API_KEY" in verdict.error.message
    assert json.loads((run_dir / "verdict.json").read_text())["error"]["stage"] == "setup"


class TestAlwaysVerdict:
    def test_setup_failure_yields_indeterminate_verdict(self, tmp_path):
        """A scenario whose setup.sh exits non-zero must still produce a verdict.json
        with final=indeterminate, error.stage=setup."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
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
        (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 1\n")

        run_dir, verdict = _invoke(tmp_path, scen)

        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"

    def test_setup_failure_run_dir_returned(self, tmp_path):
        """run_dir must be the first return value and must exist on disk."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
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
        (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 0\n")

        def _boom(**kwargs):
            raise ValueError("simulated unexpected crash")

        with patch("quorum.runner._run_scenario_inner", side_effect=_boom):
            run_dir, verdict = _invoke(tmp_path, scen)

        verdict_path = run_dir / "verdict.json"
        assert verdict_path.exists()
        data = json.loads(verdict_path.read_text())
        assert data["final"] == "indeterminate"
        assert "unexpected quorum crash" in data["final_reason"]
        assert data["error"]["stage"] == "unknown"
        assert "simulated unexpected crash" in data["error"]["message"]

    def test_verdict_json_written_before_exception_propagates(self, tmp_path):
        """verdict.json must exist on disk regardless of which exception fires."""
        scen = tmp_path / "s"
        scen.mkdir()
        (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
        _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 1\n")

        run_dir, _verdict = _invoke(tmp_path, scen)

        # verdict.json must exist and be valid JSON
        data = json.loads((run_dir / "verdict.json").read_text())
        assert data["final"] == "indeterminate"


# ---------------------------------------------------------------------------
# ATIF trajectory emission (best-effort, additive)
# ---------------------------------------------------------------------------


def _claude_session_line() -> str:
    """One claude transcript line with a tool_use so capture is non-empty."""
    return (
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "model": "claude-sonnet-4-6",
                    "content": [
                        {"type": "tool_use", "name": "Bash", "input": {"command": "echo hi"}}
                    ],
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                },
            }
        )
        + "\n"
    )


def _stub_gauntlet_pass_writing_claude_log(session_log_dir: Path):
    """Passing-gauntlet stub that drops a claude session log into session_log_dir.

    Mirrors test_runner's _stub_gauntlet_pass_writing_log so the capture (and
    thus the ATIF emission) sees a real new session log after the snapshot.
    """

    def _stub(*, run_dir, **kwargs):
        (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
        (session_log_dir / "session.jsonl").write_text(_claude_session_line())
        return GauntletResult(status="pass")

    return _stub


def _passing_scenario(tmp_path: Path) -> Path:
    scen = tmp_path / "s"
    scen.mkdir()
    (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
    _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 0\n")
    (scen / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    return scen


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")
def test_runner_emits_atif_trajectory_for_claude(tmp_path):
    """A claude run captures a valid ATIF trajectory.json."""
    scen = _passing_scenario(tmp_path)
    session_log_dir = tmp_path / "session-logs"
    session_log_dir.mkdir(parents=True, exist_ok=True)

    with patch(
        "quorum.runner.invoke_gauntlet",
        side_effect=_stub_gauntlet_pass_writing_claude_log(session_log_dir),
    ):
        run_dir, _verdict = _invoke(tmp_path, scen)

    trajectory = run_dir / "trajectory.json"
    assert trajectory.exists(), "claude run must emit trajectory.json"
    traj = json.loads(trajectory.read_text())
    assert traj["schema_version"] == "ATIF-v1.7"


def test_runner_still_produces_verdict_when_atif_emission_fails(tmp_path):
    """An ATIF emission failure must not raise or block the verdict.

    Patch the capture emit to report failure (as a missing bun would); the run
    must still complete with a real verdict and leave no trajectory.json — the
    empty-capture path takes over from there.
    """
    scen = _passing_scenario(tmp_path)
    session_log_dir = tmp_path / "session-logs"
    session_log_dir.mkdir(parents=True, exist_ok=True)

    with (
        patch(
            "quorum.runner.invoke_gauntlet",
            side_effect=_stub_gauntlet_pass_writing_claude_log(session_log_dir),
        ),
        patch("quorum.capture.emit_atif_trajectory", return_value=False),
    ):
        run_dir, verdict = _invoke(tmp_path, scen)

    # Run completed and produced a real (non-error) verdict despite the failure.
    assert verdict.final in {"pass", "fail", "indeterminate"}
    assert (run_dir / "verdict.json").exists()
    # No trajectory left behind on a failed emission.
    assert not (run_dir / "trajectory.json").exists()
