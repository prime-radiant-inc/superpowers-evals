# tests/quorum/test_cli.py
import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from quorum.cli import _managed_env_base_for_target, main


def _allow_test_profile_owner(monkeypatch) -> None:
    monkeypatch.setattr("quorum.doctor.DEFAULT_PROFILE_OWNER_UID", os.getuid())


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


def test_run_blocked_on_managed_host_before_runner(tmp_path, monkeypatch):
    sd = tmp_path / "scenarios" / "x"
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\n---\n")
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    runner = CliRunner()
    with patch("quorum.cli.run_scenario") as mock:
        result = runner.invoke(
            main,
            [
                "run",
                str(sd),
                "--coding-agent",
                "claude",
            ],
        )
    assert result.exit_code == 2
    assert "raw live eval commands are disabled on the managed Quorum host" in result.output
    mock.assert_not_called()


def test_run_all_blocked_on_managed_host_before_batch(tmp_path, monkeypatch):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    (scenarios / "x").mkdir(parents=True)
    (scenarios / "x" / "story.md").write_text("---\nid: x\n---\n")
    agents.mkdir()
    (agents / "claude.yaml").write_text("name: claude\nbinary: echo\n")
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    runner = CliRunner()
    with patch("quorum.cli.run_batch") as mock:
        result = runner.invoke(
            main,
            [
                "run-all",
                "--scenarios-root",
                str(scenarios),
                "--coding-agents-dir",
                str(agents),
            ],
        )
    assert result.exit_code == 2
    assert "raw live eval commands are disabled on the managed Quorum host" in result.output
    mock.assert_not_called()


def test_run_managed_worker_flag_without_token_is_blocked(tmp_path, monkeypatch):
    sd = tmp_path / "scenarios" / "x"
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\n---\n")
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_MANAGED_WORKER", "1")
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
            ],
        )
    assert result.exit_code == 2
    mock.assert_not_called()


def test_run_allowed_on_managed_worker_with_matching_token(tmp_path, monkeypatch):
    sd = tmp_path / "scenarios" / "x"
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\n---\n")
    state_root = tmp_path / "state"
    state_root.mkdir()
    (state_root / "worker-token").write_text("worker-secret\n")
    (state_root / "worker-token").chmod(0o600)
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_MANAGED_WORKER", "1")
    monkeypatch.setenv("QUORUM_MANAGED_WORKER_TOKEN", "worker-secret")
    monkeypatch.setattr("quorum.runtime_env.MANAGED_WORKER_TOKEN_PATH", state_root / "worker-token")
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


def test_run_all_managed_worker_passes_token_to_child_control_env(tmp_path, monkeypatch):
    captured = {}
    state_root = tmp_path / "state"
    state_root.mkdir()
    token_file = state_root / "worker-token"
    token_file.write_text("worker-secret\n")
    token_file.chmod(0o600)

    def fake_run_batch(**kwargs):
        captured.update(kwargs)
        return tmp_path / "results" / "batches" / "fakebatch"

    monkeypatch.setattr("quorum.cli.run_batch", fake_run_batch)
    monkeypatch.setattr("quorum.runtime_env.MANAGED_WORKER_TOKEN_PATH", token_file)
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_MANAGED_WORKER", "1")
    monkeypatch.setenv("QUORUM_MANAGED_WORKER_TOKEN", "worker-secret")
    monkeypatch.setenv("QUORUM_STATE_ROOT", str(state_root))
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-poison")
    (tmp_path / "scenarios").mkdir(parents=True)
    (tmp_path / "coding-agents").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(main, ["run-all"])

    assert result.exit_code == 0, result.output
    assert captured["env_base"]["QUORUM_MANAGED_WORKER_TOKEN"] == "worker-secret"
    assert "OPENAI_API_KEY" not in captured["env_base"]


def test_managed_kimi_target_env_preserves_batch_preflight_markers(tmp_path, monkeypatch):
    profile_root = tmp_path / "profiles"
    profile_root.mkdir()
    (profile_root / "kimi.env").write_text("KIMI_MODEL_API_KEY=profile-key\n")
    marker = tmp_path / "batch" / "kimi-preflight-ok.json"

    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profile_root))
    monkeypatch.setenv("QUORUM_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("QUORUM_ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    monkeypatch.setenv("QUORUM_KIMI_PREFLIGHT_SENTINEL", str(marker))
    monkeypatch.setenv("QUORUM_KIMI_PREFLIGHT_TOKEN", "batch-token")

    env_base = _managed_env_base_for_target("kimi")

    assert env_base is not None
    assert env_base["KIMI_MODEL_API_KEY"] == "profile-key"
    assert env_base["QUORUM_KIMI_PREFLIGHT_SENTINEL"] == str(marker)
    assert env_base["QUORUM_KIMI_PREFLIGHT_TOKEN"] == "batch-token"


def _write_doctor_agent_fixture(
    tmp_path: Path,
    *,
    target: str = "gemini",
) -> tuple[Path, Path, Path]:
    import yaml

    agents = tmp_path / "coding-agents"
    scenarios = tmp_path / "scenarios"
    profiles = tmp_path / "profiles"
    bin_dir = tmp_path / "bin"
    agents.mkdir()
    scenarios.mkdir()
    profiles.mkdir()
    profiles.chmod(0o700)
    bin_dir.mkdir()
    (bin_dir / "demo-agent").write_text("#!/bin/sh\nexit 0\n")
    (bin_dir / "demo-agent").chmod(0o755)
    (agents / f"{target}.yaml").write_text(
        yaml.safe_dump(
            {
                "name": target,
                "binary": "demo-agent",
                "agent_config_env": "DEMO_HOME",
                "session_log_dir": "${DEMO_HOME}/sessions",
                "session_log_glob": "*.jsonl",
                "normalizer": "codex",
                "required_env": ["GEMINI_API_KEY", "SUPERPOWERS_ROOT"],
            }
        )
    )
    context = agents / f"{target}-context"
    context.mkdir()
    (context / "HOWTO.md").write_text("Use gemini.\n")
    sentinel = scenarios / "sentinel"
    sentinel.mkdir()
    (sentinel / "story.md").write_text(
        "---\nid: sentinel\nstatus: ready\nquorum_tier: sentinel\n---\n"
    )
    (sentinel / "checks.sh").write_text(
        f"# coding-agents: {target}\npre() {{ :; }}\npost() {{ :; }}\n"
    )
    profile = profiles / f"{target}.env"
    profile.write_text("GEMINI_API_KEY=profile-key\n")
    profile.chmod(0o600)
    superpowers = tmp_path / "superpowers"
    for rel in (
        "GEMINI.md",
        "skills/using-superpowers/SKILL.md",
        "skills/using-superpowers/references/gemini-tools.md",
    ):
        path = superpowers / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture\n")
    return agents, scenarios, profiles


def test_doctor_ready_target_exits_zero(tmp_path, monkeypatch):
    _allow_test_profile_owner(monkeypatch)
    agents, scenarios, profiles = _write_doctor_agent_fixture(tmp_path)
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "gemini",
            "--coding-agents-dir",
            str(agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "gemini" in result.output
    assert "ready" in result.output


def test_doctor_missing_profile_on_managed_host_exits_one(tmp_path, monkeypatch):
    _allow_test_profile_owner(monkeypatch)
    agents, scenarios, profiles = _write_doctor_agent_fixture(tmp_path)
    (profiles / "gemini.env").unlink()
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "gemini",
            "--coding-agents-dir",
            str(agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 1
    assert "failed" in result.output
    assert "profile" in result.output


def test_doctor_all_reports_failed_profile_and_exits_one(tmp_path, monkeypatch):
    _allow_test_profile_owner(monkeypatch)
    agents, scenarios, profiles = _write_doctor_agent_fixture(tmp_path)
    (profiles / "gemini.env").unlink()
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "--all",
            "--coding-agents-dir",
            str(agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 1, result.output
    assert "gemini" in result.output
    assert "failed" in result.output


def test_doctor_all_missing_coding_agents_dir_exits_two(tmp_path, monkeypatch):
    missing_agents = tmp_path / "missing-agents"
    scenarios = tmp_path / "scenarios"
    scenarios.mkdir()
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "--all",
            "--coding-agents-dir",
            str(missing_agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 2
    assert "coding-agents directory not found" in result.output


def test_doctor_missing_coding_agent_yaml_fails_and_exits_one(tmp_path, monkeypatch):
    _allow_test_profile_owner(monkeypatch)
    agents, scenarios, profiles = _write_doctor_agent_fixture(tmp_path)
    (agents / "gemini.yaml").unlink()
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "gemini",
            "--coding-agents-dir",
            str(agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 1
    assert "failed" in result.output
    assert "coding-agent config" in result.output


def test_doctor_malformed_coding_agent_yaml_exits_two(tmp_path, monkeypatch):
    _allow_test_profile_owner(monkeypatch)
    agents, scenarios, profiles = _write_doctor_agent_fixture(tmp_path)
    (agents / "gemini.yaml").write_text("[]\n")
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "gemini",
            "--coding-agents-dir",
            str(agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 2
    assert "failed" in result.output
    assert "coding-agent config" in result.output


def test_doctor_json_output_is_stable(tmp_path, monkeypatch):
    _allow_test_profile_owner(monkeypatch)
    agents, scenarios, profiles = _write_doctor_agent_fixture(tmp_path)
    (profiles / "gemini.env").chmod(0o666)
    monkeypatch.setenv("QUORUM_MANAGED_HOST", "1")
    monkeypatch.setenv("QUORUM_TARGET_PROFILE_ROOT", str(profiles))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))

    result = CliRunner().invoke(
        main,
        [
            "doctor",
            "gemini",
            "--json",
            "--coding-agents-dir",
            str(agents),
            "--scenarios-root",
            str(scenarios),
        ],
    )

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["target"] == "gemini"
    assert payload["status"] == "failed"
    assert isinstance(payload["checks"], list)
    assert any(check.get("remediation") for check in payload["checks"])
    assert any(check.get("reason") == "config-error" for check in payload["checks"])


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
