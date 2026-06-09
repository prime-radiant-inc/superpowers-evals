# tests/quorum/test_cli.py
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from quorum.cli import main


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
    with patch("quorum.cli.run_scenario") as mock:
        fake_run_dir = tmp_path / "results" / "x-claude-20260101T000000"
        fake_verdict = MagicMock(final="pass", to_dict=lambda: {"final": "pass"})
        mock.return_value = (fake_run_dir, fake_verdict)
        result = runner.invoke(
            main,
            [
                "run",
                str(sd),
                "--coding-agent",
                "claude",
                "--coding-agents-dir",
                str(tmp_path / "t"),
                "--out-root",
                str(tmp_path / "out"),
            ],
        )
        assert result.exit_code == 0
        mock.assert_called_once()


def test_run_prints_run_id_line(tmp_path, monkeypatch):
    """`quorum run` prints `run-id: <id>` as the first stdout line."""
    from click.testing import CliRunner

    from quorum.cli import main
    from quorum.composer import FinalVerdict, GauntletLayer

    # Stub run_scenario so we don't actually drive an agent. Use real
    # dataclass types — FinalVerdict.to_dict() calls asdict() on its
    # nested fields and will TypeError on plain dicts.
    fake_run_dir = tmp_path / "results" / "foo-claude-20260526T180001Z-abcd"
    fake_run_dir.mkdir(parents=True)
    fake_verdict = FinalVerdict(
        final="pass",
        final_reason="ok",
        gauntlet=GauntletLayer(status="pass", summary="ok", reasoning="ok"),
        checks=[],
        error=None,
    )

    def fake_run_scenario(**kwargs):
        return fake_run_dir, fake_verdict

    monkeypatch.setattr("quorum.cli.run_scenario", fake_run_scenario)

    # Minimal scenario dir to satisfy click.Path(exists=True).
    scenario_dir = tmp_path / "scenario"
    scenario_dir.mkdir()

    result = CliRunner().invoke(
        main,
        [
            "run",
            str(scenario_dir),
            "--coding-agent",
            "claude",
        ],
    )
    assert result.exit_code == 0, result.output  # surface renderer crashes
    first_line = result.output.splitlines()[0]
    assert first_line == "run-id: foo-claude-20260526T180001Z-abcd"


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
    with patch("quorum.cli.run_scenario") as mock:
        fake_run_dir = tmp_path / "results" / "x-claude-20260101T000000"
        fake_verdict = MagicMock(final="pass", to_dict=lambda: {"final": "pass"})
        mock.return_value = (fake_run_dir, fake_verdict)
        result = runner.invoke(
            main,
            [
                "run",
                "scenarios/x",  # RELATIVE path
                "--coding-agent",
                "claude",
                "--coding-agents-dir",
                "t",
                "--out-root",
                "out",
            ],
        )
        assert result.exit_code == 0
        call = mock.call_args
        # Every path passed to run_scenario must be absolute.
        for key in ("scenario_dir", "coding_agents_dir", "out_root"):
            value = call.kwargs[key]
            assert isinstance(value, Path)
            assert value.is_absolute(), f"{key} was {value} (not absolute)"


# ---------- show subcommand --------------------------------------------


def _write_verdict(run_dir: Path, body: dict) -> None:
    import json as _json

    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "verdict.json").write_text(_json.dumps(body))


def test_show_subcommand_renders_latest(tmp_path):
    root = tmp_path / "results"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {
            "schema": 1,
            "final": "pass",
            "final_reason": "ok",
            "gauntlet": {"status": "pass", "summary": "s", "reasoning": "r", "run_id": "x_z_0000"},
            "checks": [],
            "error": None,
        },
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 0
    assert "final" in result.output and "pass" in result.output


def test_show_subcommand_quiet_flag(tmp_path):
    root = tmp_path / "results"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {
            "schema": 1,
            "final": "fail",
            "final_reason": "1 post-check(s) failed",
            "gauntlet": None,
            "checks": [],
            "error": None,
        },
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "-q", "--results-root", str(root)])
    assert result.exit_code == 0
    assert result.output.count("\n") == 2
    assert result.output.endswith("\n")


def test_show_subcommand_missing_target_exits_1(tmp_path):
    root = tmp_path / "results"
    root.mkdir()
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 1
    # CliRunner merges stderr into output by default; error message should appear.
    assert "no run-dir resolved" in result.output


def test_show_subcommand_json_flag(tmp_path):
    import json as _json

    root = tmp_path / "results"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {
            "schema": 1,
            "final": "pass",
            "final_reason": "ok",
            "gauntlet": None,
            "checks": [],
            "error": None,
        },
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--json", "--results-root", str(root)])
    assert result.exit_code == 0
    parsed = _json.loads(result.output)
    assert parsed["schema"] == 1


def test_show_subcommand_exits_zero_on_fail_verdict(tmp_path):
    # Load-bearing: quorum show is a display tool, not a verdict carrier.
    # Unlike `quorum run`, fail/indeterminate must NOT map to non-zero exit.
    root = tmp_path / "results"
    _write_verdict(
        root / "x-claude-20260523T000000Z-aaaa",
        {
            "schema": 1,
            "final": "fail",
            "final_reason": "1 post-check(s) failed",
            "gauntlet": {"status": "fail", "summary": "bad", "reasoning": "bad", "run_id": "x_z_0"},
            "checks": [],
            "error": None,
        },
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 0, f"got {result.exit_code}; output: {result.output}"


def test_show_subcommand_quiet_and_json_mutually_exclusive(tmp_path):
    root = tmp_path / "results"
    root.mkdir()
    runner = CliRunner()
    result = runner.invoke(
        main,
        [
            "show",
            "-q",
            "--json",
            "--results-root",
            str(root),
        ],
    )
    assert result.exit_code == 1
    assert "mutually exclusive" in result.output


def test_show_subcommand_malformed_verdict_exits_2(tmp_path):
    root = tmp_path / "results"
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

    root = tmp_path / "results"
    run = root / "x-claude-20260523T000000Z-aaaa"
    run.mkdir(parents=True)
    # Valid JSON, but missing "final" field — render() would KeyError.
    (run / "verdict.json").write_text(_json.dumps({"schema": 1, "checks": []}))
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 2
    assert "schema v1" in result.output


def test_run_all_command_invokes_run_batch(tmp_path, monkeypatch):
    captured = {}

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)

    # Minimum dirs to satisfy click.Path(exists=True) on the defaults.
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(
        main,
        [
            "run-all",
            "--coding-agents",
            "claude,codex",
            "--jobs",
            "4",
        ],
    )

    assert result.exit_code == 0, result.output
    assert captured["jobs"] == 4
    assert captured["agent_filter"] == ["claude", "codex"]


def test_run_all_scenarios_filter_forwarded(tmp_path, monkeypatch):
    """`--scenarios` is discoverable and forwarded to run_batch as a list."""
    captured = {}

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    help_result = CliRunner().invoke(main, ["run-all", "--help"])
    assert "--scenarios" in help_result.output

    result = CliRunner().invoke(main, ["run-all", "--scenarios", "alpha, gamma"])
    assert result.exit_code == 0, result.output
    assert captured["scenario_filter"] == ["alpha", "gamma"]


def test_run_all_jobs_must_be_positive(tmp_path, monkeypatch):
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(main, ["run-all", "--jobs", "0"])
    assert result.exit_code != 0


def test_run_all_accepts_no_cursor_flag(tmp_path, monkeypatch):
    """`--no-cursor` is wired through and forwarded to `run_batch`."""
    captured = {}

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)

    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    # --help must list the flag so users can discover it.
    help_result = CliRunner().invoke(main, ["run-all", "--help"])
    assert help_result.exit_code == 0
    assert "--no-cursor" in help_result.output

    result = CliRunner().invoke(main, ["run-all", "--no-cursor"])
    assert result.exit_code == 0, result.output
    assert captured["use_cursor"] is False


def test_run_all_tier_flag_threads_through(tmp_path, monkeypatch):
    """`--tier sentinel` is forwarded to run_batch as tier="sentinel"."""
    captured = {}

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    help_result = CliRunner().invoke(main, ["run-all", "--help"])
    assert "--tier" in help_result.output

    result = CliRunner().invoke(main, ["run-all", "--tier", "sentinel"])
    assert result.exit_code == 0, result.output
    assert captured["tier"] == "sentinel"
    assert captured["include_drafts"] is False


def test_run_all_include_drafts_flag_threads_through(tmp_path, monkeypatch):
    """`--include-drafts` is forwarded to run_batch as include_drafts=True."""
    captured = {}

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    help_result = CliRunner().invoke(main, ["run-all", "--help"])
    assert "--include-drafts" in help_result.output

    result = CliRunner().invoke(main, ["run-all", "--include-drafts"])
    assert result.exit_code == 0, result.output
    assert captured["include_drafts"] is True


def test_run_all_tier_default_is_none(tmp_path, monkeypatch):
    """When --tier is omitted, run_batch receives tier=None (all tiers run)."""
    captured = {}

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(main, ["run-all"])
    assert result.exit_code == 0, result.output
    assert captured["tier"] is None
    assert captured["include_drafts"] is False


def test_run_all_tier_rejects_invalid_value(tmp_path, monkeypatch):
    """`--tier bogus` exits non-zero (not a valid choice)."""
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(main, ["run-all", "--tier", "bogus"])
    assert result.exit_code != 0


def test_show_renders_batch_when_target_is_batch_id(tmp_path, monkeypatch):
    out_root = tmp_path / "results"
    batch_dir = out_root / "batches" / "20260526T180000Z-abcd"
    batch_dir.mkdir(parents=True)
    batch_dir.joinpath("batch.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "id": batch_dir.name,
                "started_at": "2026-05-26T18:00:00+00:00",
                "finished_at": "2026-05-26T18:03:41+00:00",
                "coding_agents": ["claude"],
                "jobs": 1,
            }
        )
    )
    batch_dir.joinpath("results.jsonl").write_text(
        json.dumps(
            {"scenario": "foo", "coding_agent": "claude", "run_id": None, "skipped": "directive"}
        )
        + "\n"
    )

    result = CliRunner().invoke(
        main,
        [
            "show",
            "20260526T180000Z-abcd",
            "--results-root",
            str(out_root),
        ],
    )
    assert result.exit_code == 0, result.output
    assert "Legend:" in result.output
    assert "— skip" in result.output
