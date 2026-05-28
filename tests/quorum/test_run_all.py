"""Tests for quorum.run_all."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import pytest

from quorum.run_all import (
    ChildResult,
    allocate_batch_dir,
    append_result_record,
    build_matrix,
    invoke_child,
    run_batch,
    write_batch_footer,
    write_batch_header,
    _run_cost,
)


def _scenario(root: Path, name: str, *, directive: str | None = None) -> Path:
    d = root / name
    d.mkdir(parents=True)
    (d / "story.md").write_text("---\nid: x\ntitle: t\n---\n")
    directive_line = f"# coding-agents: {directive}\n" if directive else ""
    (d / "checks.sh").write_text(directive_line + "pre() { :; }\npost() { :; }\n")
    return d


def _agent(root: Path, name: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.yaml").write_text(f"name: {name}\nbinary: echo\n")


def test_build_matrix_full_cross_product_when_no_directive(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _scenario(scenarios, "beta")
    _agent(agents, "claude")
    _agent(agents, "codex")

    entries = build_matrix(scenarios_root=scenarios, coding_agents_dir=agents)

    assert len(entries) == 4
    pairs = {(e.scenario, e.coding_agent) for e in entries}
    assert pairs == {("alpha", "claude"), ("alpha", "codex"), ("beta", "claude"), ("beta", "codex")}
    assert all(e.runnable for e in entries)


def test_build_matrix_marks_directive_excluded_pairs_skipped(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha", directive="codex")
    _scenario(scenarios, "beta")  # no directive — runnable on both
    _agent(agents, "claude")
    _agent(agents, "codex")

    entries = build_matrix(scenarios_root=scenarios, coding_agents_dir=agents)

    skipped = {(e.scenario, e.coding_agent) for e in entries if not e.runnable}
    runnable = {(e.scenario, e.coding_agent) for e in entries if e.runnable}
    assert skipped == {("alpha", "claude")}
    assert runnable == {("alpha", "codex"), ("beta", "claude"), ("beta", "codex")}
    for e in entries:
        if not e.runnable:
            assert e.skipped_reason == "directive"


def test_build_matrix_filters_agents(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _agent(agents, "claude")
    _agent(agents, "codex")

    entries = build_matrix(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        agent_filter=["claude"],
    )

    assert {e.coding_agent for e in entries} == {"claude"}


def test_build_matrix_unknown_agent_in_filter_raises(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _agent(agents, "claude")

    with pytest.raises(ValueError, match="unknown coding-agent.*gemini"):
        build_matrix(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            agent_filter=["gemini"],
        )


def test_build_matrix_sorts_entries_for_deterministic_output(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "zeta")
    _scenario(scenarios, "alpha")
    _agent(agents, "codex")
    _agent(agents, "claude")

    entries = build_matrix(scenarios_root=scenarios, coding_agents_dir=agents)

    names = [(e.scenario, e.coding_agent) for e in entries]
    assert names == sorted(names)


def test_invoke_child_parses_run_id_from_stdout(tmp_path):
    fake_stdout = "run-id: foo-claude-20260526T180001Z-abcd\nheader line one\nheader line two\n"
    completed = CompletedProcess(args=[], returncode=0, stdout=fake_stdout, stderr="")
    with patch("quorum.run_all.subprocess.run", return_value=completed) as mock:
        result = invoke_child(
            scenario_dir=tmp_path / "foo",
            coding_agent="claude",
            coding_agents_dir=tmp_path / "agents",
            out_root=tmp_path / "results",
        )
    assert result.run_id == "foo-claude-20260526T180001Z-abcd"
    assert result.exit_code == 0
    assert result.error is None
    # Verify we shelled out to `uv run quorum run` AND forwarded the
    # parent's --coding-agents-dir / --out-root so the child uses the
    # same roots (not its cwd-relative defaults).
    cmd = mock.call_args[0][0]
    assert cmd[:4] == ["uv", "run", "quorum", "run"]
    assert "--coding-agent" in cmd and "claude" in cmd
    assert "--coding-agents-dir" in cmd
    assert "--out-root" in cmd


def test_invoke_child_records_nonzero_exit_with_run_id_when_present(tmp_path):
    """A fail verdict exits 1 but still emits run-id. We record both."""
    completed = CompletedProcess(
        args=[],
        returncode=1,
        stdout="run-id: foo-claude-20260526T180001Z-abcd\n",
        stderr="",
    )
    with patch("quorum.run_all.subprocess.run", return_value=completed):
        result = invoke_child(
            scenario_dir=tmp_path / "foo",
            coding_agent="claude",
            coding_agents_dir=tmp_path / "agents",
            out_root=tmp_path / "results",
        )
    assert result.run_id == "foo-claude-20260526T180001Z-abcd"
    assert result.exit_code == 1
    assert result.error is None  # exit 1 is a normal fail verdict, not a child error


def test_invoke_child_no_run_id_in_stdout_is_error(tmp_path):
    """Child crashed before allocating a run-dir."""
    completed = CompletedProcess(
        args=[],
        returncode=137,
        stdout="boom\n",
        stderr="segfault",
    )
    with patch("quorum.run_all.subprocess.run", return_value=completed):
        result = invoke_child(
            scenario_dir=tmp_path / "foo",
            coding_agent="claude",
            coding_agents_dir=tmp_path / "agents",
            out_root=tmp_path / "results",
        )
    assert result.run_id is None
    assert result.exit_code == 137
    assert result.error is not None and "run-id" in result.error


def test_allocate_batch_dir_creates_unique_dir(tmp_path):
    import re

    out_root = tmp_path / "results"
    out_root.mkdir()

    batch_dir = allocate_batch_dir(out_root=out_root)

    assert batch_dir.parent == out_root / "batches"
    assert batch_dir.is_dir()
    # ID looks like batch-20260526T180000Z-abcd
    assert re.fullmatch(r"batch-\d{8}T\d{6}Z-[0-9a-f]{4}", batch_dir.name), batch_dir.name


def test_write_batch_header_writes_batch_json(tmp_path):
    batch_dir = tmp_path / "batches" / "20260526T180000Z-abcd"
    batch_dir.mkdir(parents=True)

    started_at = datetime(2026, 5, 26, 18, 0, 0, tzinfo=UTC)
    write_batch_header(
        batch_dir=batch_dir,
        coding_agents=["claude", "codex"],
        jobs=4,
        started_at=started_at,
    )

    data = json.loads((batch_dir / "batch.json").read_text())
    assert data["schema_version"] == 1
    assert data["id"] == "20260526T180000Z-abcd"
    assert data["coding_agents"] == ["claude", "codex"]
    assert data["jobs"] == 4
    assert data["started_at"] == "2026-05-26T18:00:00+00:00"
    assert data["finished_at"] is None


def test_write_batch_footer_sets_finished_at(tmp_path):
    batch_dir = tmp_path / "batches" / "20260526T180000Z-abcd"
    batch_dir.mkdir(parents=True)
    started_at = datetime(2026, 5, 26, 18, 0, 0, tzinfo=UTC)
    write_batch_header(
        batch_dir=batch_dir,
        coding_agents=["claude"],
        jobs=1,
        started_at=started_at,
    )

    finished_at = datetime(2026, 5, 26, 18, 3, 41, tzinfo=UTC)
    write_batch_footer(batch_dir=batch_dir, finished_at=finished_at)

    data = json.loads((batch_dir / "batch.json").read_text())
    assert data["finished_at"] == "2026-05-26T18:03:41+00:00"
    # Header fields preserved
    assert data["coding_agents"] == ["claude"]


def test_append_result_record_skipped(tmp_path):
    batch_dir = tmp_path / "batch"
    batch_dir.mkdir()

    append_result_record(
        batch_dir=batch_dir,
        scenario="foo",
        coding_agent="codex",
        run_id=None,
        skipped="directive",
    )

    lines = (batch_dir / "results.jsonl").read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec == {
        "scenario": "foo",
        "coding_agent": "codex",
        "run_id": None,
        "skipped": "directive",
    }


def test_append_result_record_runnable(tmp_path):
    batch_dir = tmp_path / "batch"
    batch_dir.mkdir()

    append_result_record(
        batch_dir=batch_dir,
        scenario="foo",
        coding_agent="claude",
        run_id="foo-claude-20260526T180001Z-abcd",
        skipped=None,
    )

    rec = json.loads((batch_dir / "results.jsonl").read_text().splitlines()[0])
    assert rec == {
        "scenario": "foo",
        "coding_agent": "claude",
        "run_id": "foo-claude-20260526T180001Z-abcd",
    }
    assert "skipped" not in rec


def test_run_batch_writes_skipped_then_runnable(tmp_path, capsys):
    """Skipped entries are written upfront; runnable pairs appended on completion."""
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha", directive="codex")  # claude skipped
    _scenario(scenarios, "beta")                      # both runnable
    _agent(agents, "claude")
    _agent(agents, "codex")
    out_root = tmp_path / "results"

    def fake_invoke(*, scenario_dir, coding_agent, coding_agents_dir,
                    out_root, timeout_seconds=None):
        return ChildResult(
            run_id=f"{scenario_dir.name}-{coding_agent}-fakerun",
            exit_code=0, error=None,
        )

    batch_dir = run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=1,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
    )

    lines = (batch_dir / "results.jsonl").read_text().splitlines()
    records = [json.loads(line) for line in lines]
    # 1 skipped (alpha × claude) + 3 runnable = 4 records.
    assert len(records) == 4

    # Spec §4: skipped pairs are written upfront; runnable pairs follow.
    assert records[0]["scenario"] == "alpha"
    assert records[0]["coding_agent"] == "claude"
    assert records[0].get("skipped") == "directive"
    assert all(r.get("run_id") for r in records[1:])

    skipped = [r for r in records if r.get("skipped")]
    assert len(skipped) == 1

    runnable = [r for r in records if r.get("run_id")]
    assert len(runnable) == 3
    assert all(r["run_id"].endswith("-fakerun") for r in runnable)


def test_run_batch_writes_batch_json_header_and_footer(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _agent(agents, "claude")
    out_root = tmp_path / "results"

    def fake_invoke(*, scenario_dir, coding_agent, coding_agents_dir,
                    out_root, timeout_seconds=None):
        return ChildResult(run_id="alpha-claude-fake", exit_code=0, error=None)

    batch_dir = run_batch(
        scenarios_root=scenarios, coding_agents_dir=agents,
        out_root=out_root, jobs=1, agent_filter=None, invoke=fake_invoke,
        use_cursor=False,
    )

    data = json.loads((batch_dir / "batch.json").read_text())
    assert data["coding_agents"] == ["claude"]
    assert data["jobs"] == 1
    assert data["started_at"] is not None
    assert data["finished_at"] is not None


def test_run_batch_jobs_gt_one_runs_all_pairs(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    for n in ("a", "b", "c", "d"):
        _scenario(scenarios, n)
    _agent(agents, "claude")
    out_root = tmp_path / "results"

    invocations: list[tuple[str, str]] = []

    def fake_invoke(*, scenario_dir, coding_agent, coding_agents_dir,
                    out_root, timeout_seconds=None):
        invocations.append((scenario_dir.name, coding_agent))
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x",
                           exit_code=0, error=None)

    batch_dir = run_batch(
        scenarios_root=scenarios, coding_agents_dir=agents,
        out_root=out_root, jobs=4, agent_filter=None, invoke=fake_invoke,
        use_cursor=False,
    )

    assert sorted(invocations) == [
        ("a", "claude"), ("b", "claude"), ("c", "claude"), ("d", "claude"),
    ]
    assert len((batch_dir / "results.jsonl").read_text().splitlines()) == 4


def test_run_batch_event_format_uses_total_denominator_and_skip_verb(
    tmp_path, capsys, monkeypatch
):
    """[N/M] denominator counts the full matrix; skips render in event shape.

    Strong assertions: skip line precedes runnable lines, and each
    runnable index appears in BOTH a `start` and a `done` line.
    """
    # Pin Console TTY detection regardless of CI env (FORCE_COLOR).
    monkeypatch.delenv("FORCE_COLOR", raising=False)

    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha", directive="codex")  # claude skipped at idx 1
    _scenario(scenarios, "beta")
    _agent(agents, "claude")
    _agent(agents, "codex")
    out_root = tmp_path / "results"

    def fake_invoke(*, scenario_dir, coding_agent, coding_agents_dir,
                    out_root, timeout_seconds=None):
        return ChildResult(
            run_id=f"{scenario_dir.name}-{coding_agent}-x",
            exit_code=0, error=None,
        )

    run_batch(
        scenarios_root=scenarios, coding_agents_dir=agents,
        out_root=out_root, jobs=1, agent_filter=None,
        invoke=fake_invoke, use_cursor=False,
    )

    captured = capsys.readouterr().out
    # build_matrix sort order: alpha×claude (skip, idx 1), alpha×codex (2),
    # beta×claude (3), beta×codex (4).
    assert "[1/4] skip" in captured, captured
    # Old [skip] prefix is gone.
    assert "[skip]" not in captured

    # Each runnable index appears in BOTH a start and a done line.
    for i in (2, 3, 4):
        assert f"[{i}/4] start" in captured, captured
        assert f"[{i}/4] done" in captured, captured

    # Skip event is emitted upfront, before any runnable start.
    skip_pos = captured.find("[1/4] skip")
    first_start_pos = min(
        captured.find(f"[{i}/4] start") for i in (2, 3, 4)
    )
    assert 0 <= skip_pos < first_start_pos, (skip_pos, first_start_pos)


def test_run_cost_reads_frozen_total(tmp_path):
    run_dir = tmp_path / "run-1"
    run_dir.mkdir()
    (run_dir / "verdict.json").write_text(json.dumps({
        "final": "pass",
        "economics": {"total_est_cost_usd": 2.27, "partial": False},
    }))
    assert _run_cost(run_dir) == 2.27


def test_run_cost_none_when_no_economics(tmp_path):
    run_dir = tmp_path / "run-2"
    run_dir.mkdir()
    (run_dir / "verdict.json").write_text(json.dumps({"final": "pass"}))
    assert _run_cost(run_dir) is None


def test_run_cost_none_when_no_verdict(tmp_path):
    run_dir = tmp_path / "run-3"
    run_dir.mkdir()
    assert _run_cost(run_dir) is None


def test_run_batch_renders_cost_column_and_batch_total(tmp_path, capsys, monkeypatch):
    """Per-run cost cells and a footer batch total render from frozen economics."""
    monkeypatch.delenv("FORCE_COLOR", raising=False)
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _agent(agents, "claude")
    out_root = tmp_path / "results"

    def fake_invoke(*, scenario_dir, coding_agent, coding_agents_dir,
                    out_root, timeout_seconds=None):
        run_id = f"{scenario_dir.name}-{coding_agent}-x"
        rd = out_root / run_id
        rd.mkdir(parents=True, exist_ok=True)
        (rd / "verdict.json").write_text(json.dumps({
            "final": "pass",
            "economics": {"total_est_cost_usd": 2.27, "partial": False},
        }))
        return ChildResult(run_id=run_id, exit_code=0, error=None)

    run_batch(
        scenarios_root=scenarios, coding_agents_dir=agents,
        out_root=out_root, jobs=1, agent_filter=None,
        invoke=fake_invoke, use_cursor=False,
    )

    captured = capsys.readouterr().out
    assert "$2.27" in captured, captured          # per-run cost cell
    assert "cost $2.27" in captured, captured      # footer batch total
