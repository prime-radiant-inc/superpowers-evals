# tests/harness/test_cli.py
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from harness.cli import main


def test_list_finds_scenarios(tmp_path):
    scenarios = tmp_path / "scenarios"
    (scenarios / "alpha").mkdir(parents=True)
    (scenarios / "alpha" / "story.md").write_text("---\nid: alpha\n---\n")
    (scenarios / "beta").mkdir()
    (scenarios / "beta" / "story.md").write_text("---\nid: beta\n---\n")
    (scenarios / "not-a-scenario").mkdir()  # no story.md
    runner = CliRunner()
    result = runner.invoke(main, ["list", "--scenarios-root", str(scenarios)])
    assert result.exit_code == 0
    assert "alpha" in result.output
    assert "beta" in result.output
    assert "not-a-scenario" not in result.output


def test_run_invokes_run_scenario(tmp_path):
    sd = tmp_path / "scenarios" / "x"
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\n---\n")
    runner = CliRunner()
    with patch("harness.cli.run_scenario") as mock:
        fake_run_dir = tmp_path / "results" / "x-claude-20260101T000000"
        fake_verdict = MagicMock(final="pass", to_dict=lambda: {"final": "pass"})
        mock.return_value = (fake_run_dir, fake_verdict)
        result = runner.invoke(main, [
            "run", str(sd),
            "--coding-agent", "claude",
            "--coding-agents-dir", str(tmp_path / "t"),
            "--coding-agent-contexts-dir", str(tmp_path / "c"),
            "--out-root", str(tmp_path / "out"),
        ])
        assert result.exit_code == 0
        mock.assert_called_once()


def test_run_resolves_relative_paths_to_absolute(tmp_path, monkeypatch):
    # Regression: setup_step.run_setup does subprocess.run([str(setup_path)],
    # cwd=workdir). If setup_path is relative, subprocess resolves it
    # against workdir (the temp dir) and fails. CLI must resolve every
    # path to absolute at the boundary.
    sd = tmp_path / "scenarios" / "x"
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\n---\n")
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    with patch("harness.cli.run_scenario") as mock:
        fake_run_dir = tmp_path / "results" / "x-claude-20260101T000000"
        fake_verdict = MagicMock(final="pass", to_dict=lambda: {"final": "pass"})
        mock.return_value = (fake_run_dir, fake_verdict)
        result = runner.invoke(main, [
            "run", "scenarios/x",  # RELATIVE path
            "--coding-agent", "claude",
            "--coding-agents-dir", "t",
            "--coding-agent-contexts-dir", "c",
            "--out-root", "out",
        ])
        assert result.exit_code == 0
        call = mock.call_args
        # Every path passed to run_scenario must be absolute.
        for key in ("scenario_dir", "coding_agents_dir", "coding_agent_contexts_dir",
                    "out_root"):
            value = call.kwargs[key]
            assert isinstance(value, Path)
            assert value.is_absolute(), f"{key} was {value} (not absolute)"


# ---------- show subcommand --------------------------------------------

def _write_verdict(run_dir: Path, body: dict) -> None:
    import json as _json
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "verdict.json").write_text(_json.dumps(body))


def test_show_subcommand_renders_latest(tmp_path):
    root = tmp_path / "results-harness"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {"schema": 1, "final": "pass", "final_reason": "ok",
         "gauntlet": {"status": "pass", "summary": "s", "reasoning": "r",
                      "run_id": "x_z_0000"},
         "checks": [], "error": None},
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 0
    assert "final" in result.output and "pass" in result.output


def test_show_subcommand_quiet_flag(tmp_path):
    root = tmp_path / "results-harness"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {"schema": 1, "final": "fail", "final_reason": "1 post-check(s) failed",
         "gauntlet": None, "checks": [], "error": None},
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "-q", "--results-root", str(root)])
    assert result.exit_code == 0
    assert result.output.count("\n") == 2
    assert result.output.endswith("\n")


def test_show_subcommand_missing_target_exits_1(tmp_path):
    root = tmp_path / "results-harness"
    root.mkdir()
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 1
    # CliRunner merges stderr into output by default; error message should appear.
    assert "no run-dir resolved" in result.output


def test_show_subcommand_json_flag(tmp_path):
    import json as _json
    root = tmp_path / "results-harness"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {"schema": 1, "final": "pass", "final_reason": "ok",
         "gauntlet": None, "checks": [], "error": None},
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--json", "--results-root", str(root)])
    assert result.exit_code == 0
    parsed = _json.loads(result.output)
    assert parsed["schema"] == 1


def test_show_subcommand_exits_zero_on_fail_verdict(tmp_path):
    # Load-bearing: harness show is a display tool, not a verdict carrier.
    # Unlike `harness run`, fail/indeterminate must NOT map to non-zero exit.
    root = tmp_path / "results-harness"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {"schema": 1, "final": "fail", "final_reason": "1 post-check(s) failed",
         "gauntlet": {"status": "fail", "summary": "bad", "reasoning": "bad",
                      "run_id": "x_z_0"},
         "checks": [], "error": None},
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 0, f"got {result.exit_code}; output: {result.output}"


def test_show_subcommand_quiet_and_json_mutually_exclusive(tmp_path):
    root = tmp_path / "results-harness"
    root.mkdir()
    runner = CliRunner()
    result = runner.invoke(main, [
        "show", "-q", "--json", "--results-root", str(root),
    ])
    assert result.exit_code == 1
    assert "mutually exclusive" in result.output


def test_show_subcommand_malformed_verdict_exits_2(tmp_path):
    root = tmp_path / "results-harness"
    run = root / "x-claude-20260523T000000Z-aaaa"
    run.mkdir(parents=True)
    (run / "verdict.json").write_text("{not valid json")
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 2
    assert "malformed" in result.output


def test_show_subcommand_schema_deviant_verdict_exits_2(tmp_path):
    # Riker@401c4999 bug #3: parseable JSON missing schema-required keys
    # should hit the same exit-2 path as malformed JSON. Without the guard,
    # render() raises KeyError and the CLI leaks a Python traceback.
    import json as _json
    root = tmp_path / "results-harness"
    run = root / "x-claude-20260523T000000Z-aaaa"
    run.mkdir(parents=True)
    # Valid JSON, but missing "final" field — render() would KeyError.
    (run / "verdict.json").write_text(_json.dumps({"schema": 1, "checks": []}))
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 2
    assert "schema v1" in result.output
