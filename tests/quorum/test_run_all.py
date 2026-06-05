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
    _is_rate_limited_verdict,
    _run_cost,
    allocate_batch_dir,
    append_result_record,
    build_matrix,
    invoke_child,
    prepare_kimi_batch_preflight,
    run_batch,
    write_batch_footer,
    write_batch_header,
)
from quorum.runner import ANTIGRAVITY_RATE_LIMIT_MARKER


def _scenario(root: Path, name: str, *, directive: str | None = None) -> Path:
    d = root / name
    d.mkdir(parents=True)
    (d / "story.md").write_text("---\nid: x\ntitle: t\n---\n")
    directive_line = f"# coding-agents: {directive}\n" if directive else ""
    (d / "checks.sh").write_text(directive_line + "pre() { :; }\npost() { :; }\n")
    return d


def _agent(
    root: Path,
    name: str,
    *,
    binary: str = "echo",
    max_concurrency: int | None = None,
) -> None:
    root.mkdir(parents=True, exist_ok=True)
    body = f"name: {name}\nbinary: {binary}\n"
    if max_concurrency is not None:
        body += f"max_concurrency: {max_concurrency}\n"
    (root / f"{name}.yaml").write_text(body)


def _mk_scenario(
    root: Path,
    name: str,
    *,
    tier: str | None = None,
    status: str | None = None,
    agents_directive: str | None = None,
) -> Path:
    """Build a minimal scenario dir with optional tier/status frontmatter."""
    d = root / name
    d.mkdir(parents=True)
    fm = "id: " + name
    if tier:
        fm += f"\nquorum_tier: {tier}"
    if status:
        fm += f"\nstatus: {status}"
    (d / "story.md").write_text(f"---\n{fm}\n---\nbody\n")
    checks = "post() { :; }\n"
    if agents_directive:
        checks = f"# coding-agents: {agents_directive}\n" + checks
    (d / "checks.sh").write_text(checks)
    (d / "setup.sh").write_text("true\n")
    return d


@pytest.fixture
def _agents_dir_with(tmp_path: Path):
    """Factory: creates a coding-agents dir with the given agent names."""

    def factory(agent_names: list[str]) -> Path:
        agents_dir = tmp_path / "agents"
        for name in agent_names:
            _agent(agents_dir, name)
        return agents_dir

    return factory


def test_tier_filter_skips_non_matching(tmp_path, _agents_dir_with):
    root = tmp_path / "scenarios"
    _mk_scenario(root, "fast", tier="sentinel")
    _mk_scenario(root, "slow", tier="adhoc")
    _mk_scenario(root, "normal")  # default full
    entries = build_matrix(
        scenarios_root=root,
        coding_agents_dir=_agents_dir_with(["claude"]),
        tier_filter="sentinel",
    )
    runnable = {e.scenario for e in entries if e.runnable}
    assert runnable == {"fast"}
    assert all(e.skipped_reason == "tier" for e in entries if e.scenario in {"slow", "normal"})


def test_drafts_excluded_by_default_and_includable(tmp_path, _agents_dir_with):
    root = tmp_path / "scenarios"
    _mk_scenario(root, "draftone", status="draft")
    _mk_scenario(root, "readyone", status="ready")
    default = build_matrix(
        scenarios_root=root,
        coding_agents_dir=_agents_dir_with(["claude"]),
    )
    assert {e.scenario for e in default if e.runnable} == {"readyone"}
    assert any(e.skipped_reason == "draft" for e in default if e.scenario == "draftone")
    incl = build_matrix(
        scenarios_root=root,
        coding_agents_dir=_agents_dir_with(["claude"]),
        include_drafts=True,
    )
    assert {e.scenario for e in incl if e.runnable} == {"draftone", "readyone"}


def test_entry_carries_tier_and_status(tmp_path, _agents_dir_with):
    root = tmp_path / "scenarios"
    _mk_scenario(root, "s", tier="sentinel", status="ready")
    e = build_matrix(
        scenarios_root=root,
        coding_agents_dir=_agents_dir_with(["claude"]),
    )[0]
    assert e.tier == "sentinel" and e.status == "ready"


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


def test_build_matrix_filters_scenarios(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _scenario(scenarios, "beta")
    _scenario(scenarios, "gamma")
    _agent(agents, "claude")

    entries = build_matrix(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        scenario_filter=["alpha", "gamma"],
    )

    assert {e.scenario for e in entries} == {"alpha", "gamma"}


def test_build_matrix_unknown_scenario_in_filter_raises(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha")
    _agent(agents, "claude")

    with pytest.raises(ValueError, match="unknown scenario.*nope"):
        build_matrix(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            scenario_filter=["nope"],
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


def test_invoke_child_merges_extra_env(tmp_path):
    fake_stdout = "run-id: foo-kimi-20260526T180001Z-abcd\n"
    completed = CompletedProcess(args=[], returncode=0, stdout=fake_stdout, stderr="")
    with patch("quorum.run_all.subprocess.run", return_value=completed) as mock:
        invoke_child(
            scenario_dir=tmp_path / "foo",
            coding_agent="kimi",
            coding_agents_dir=tmp_path / "agents",
            out_root=tmp_path / "results",
            extra_env={"QUORUM_KIMI_PREFLIGHT_SENTINEL": str(tmp_path / "sentinel.json")},
        )

    env = mock.call_args.kwargs["env"]
    assert env["QUORUM_KIMI_PREFLIGHT_SENTINEL"] == str(tmp_path / "sentinel.json")


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
    _scenario(scenarios, "beta")  # both runnable
    _agent(agents, "claude")
    _agent(agents, "codex")
    out_root = tmp_path / "results"

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        return ChildResult(
            run_id=f"{scenario_dir.name}-{coding_agent}-fakerun",
            exit_code=0,
            error=None,
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

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        return ChildResult(run_id="alpha-claude-fake", exit_code=0, error=None)

    batch_dir = run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=1,
        agent_filter=None,
        invoke=fake_invoke,
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

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        invocations.append((scenario_dir.name, coding_agent))
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x", exit_code=0, error=None)

    batch_dir = run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=4,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
    )

    assert sorted(invocations) == [
        ("a", "claude"),
        ("b", "claude"),
        ("c", "claude"),
        ("d", "claude"),
    ]
    assert len((batch_dir / "results.jsonl").read_text().splitlines()) == 4


def test_run_batch_serializes_capped_agent(tmp_path):
    """antigravity (max_concurrency=1) never runs two cells at once, even at
    --jobs 4 — its Code Assist backend 429s on concurrent calls."""
    import threading
    import time

    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    for n in ("a", "b", "c", "d"):
        _scenario(scenarios, n)
    _agent(agents, "claude")
    _agent(agents, "antigravity", max_concurrency=1)
    out_root = tmp_path / "results"

    lock = threading.Lock()
    state = {"agy_now": 0, "agy_max": 0}

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        if coding_agent == "antigravity":
            with lock:
                state["agy_now"] += 1
                state["agy_max"] = max(state["agy_max"], state["agy_now"])
            time.sleep(0.05)
            with lock:
                state["agy_now"] -= 1
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x", exit_code=0, error=None)

    run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=4,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
    )
    assert state["agy_max"] == 1


def test_run_batch_does_not_serialize_uncapped_agent(tmp_path):
    """An agent without max_concurrency still parallelizes up to --jobs (the
    serialize gate must not throttle everyone)."""
    import threading
    import time

    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    for n in ("a", "b", "c", "d"):
        _scenario(scenarios, n)
    _agent(agents, "claude")  # uncapped
    out_root = tmp_path / "results"

    lock = threading.Lock()
    state = {"now": 0, "max": 0}

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        with lock:
            state["now"] += 1
            state["max"] = max(state["max"], state["now"])
        time.sleep(0.05)
        with lock:
            state["now"] -= 1
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x", exit_code=0, error=None)

    run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=4,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
    )
    assert state["max"] >= 2


def test_rate_limited_verdict_detected_regardless_of_stage():
    marker = ANTIGRAVITY_RATE_LIMIT_MARKER
    setup_v = {"error": {"stage": "setup", "message": f"{marker}: preflight"}}
    midrun_v = {"error": {"stage": "gauntlet", "message": f"{marker}: killed mid-run"}}
    other_v = {"error": {"stage": "gauntlet", "message": "no Antigravity transcript captured"}}
    assert _is_rate_limited_verdict(setup_v) is True  # preflight path still works
    assert _is_rate_limited_verdict(midrun_v) is True  # NEW: mid-run kill latches
    assert _is_rate_limited_verdict(other_v) is False  # a plain capture failure does not
    assert _is_rate_limited_verdict(None) is False


def test_run_batch_fail_fast_on_agy_rate_limit(tmp_path):
    """After one antigravity cell hits a Code Assist rate-limit setup verdict,
    the remaining antigravity cells are skipped (rate-limited), not re-run —
    while other agents keep going."""
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    for n in ("a", "b", "c"):
        _scenario(scenarios, n)
    _agent(agents, "claude")
    _agent(agents, "antigravity", max_concurrency=1)
    out_root = tmp_path / "results"

    invoked: list[tuple[str, str]] = []

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        invoked.append((scenario_dir.name, coding_agent))
        run_id = f"{scenario_dir.name}-{coding_agent}-x"
        run_dir = out_root / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        if coding_agent == "antigravity":
            verdict = {
                "final": "indeterminate",
                "error": {
                    "stage": "setup",
                    "message": f"{ANTIGRAVITY_RATE_LIMIT_MARKER}: throttled",
                },
            }
            exit_code = 2
        else:
            verdict = {"final": "pass"}
            exit_code = 0
        (run_dir / "verdict.json").write_text(json.dumps(verdict))
        return ChildResult(run_id=run_id, exit_code=exit_code, error=None)

    batch_dir = run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=1,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
    )

    # Only the first antigravity cell actually ran; the rest latched off.
    assert [s for s, a in invoked if a == "antigravity"] == ["a"]
    # claude is unaffected — all three ran.
    assert sorted(s for s, a in invoked if a == "claude") == ["a", "b", "c"]

    records = [json.loads(line) for line in (batch_dir / "results.jsonl").read_text().splitlines()]
    rate_limited = [r for r in records if r.get("skipped") == "rate-limited"]
    assert len(rate_limited) == 2
    assert all(r["coding_agent"] == "antigravity" for r in rate_limited)
    assert all(r["run_id"] is None for r in rate_limited)


def test_run_batch_preflights_kimi_once_for_multiple_cells(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    _scenario(scenarios, "b")
    _agent(agents, "kimi")
    out_root = tmp_path / "results"
    calls = {"preflight": 0}
    child_envs = []

    def fake_preflight(**_kwargs):
        calls["preflight"] += 1
        return {
            "QUORUM_KIMI_PREFLIGHT_SENTINEL": str(tmp_path / "sentinel.json"),
            "QUORUM_KIMI_PREFLIGHT_TOKEN": "batch-token",
        }

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        child_envs.append(extra_env or {})
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x", exit_code=0, error=None)

    with patch("quorum.run_all.prepare_kimi_batch_preflight", side_effect=fake_preflight):
        run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=fake_invoke,
            use_cursor=False,
        )

    assert calls["preflight"] == 1
    assert len(child_envs) == 2
    assert all("QUORUM_KIMI_PREFLIGHT_SENTINEL" in env for env in child_envs)
    assert all("QUORUM_KIMI_PREFLIGHT_TOKEN" in env for env in child_envs)


def test_prepare_kimi_batch_preflight_writes_token_digest_only(tmp_path, monkeypatch):
    agents = tmp_path / "agents"
    custom_kimi = tmp_path / "custom-kimi"
    custom_kimi.write_text("#!/usr/bin/env bash\nexit 0\n")
    custom_kimi.chmod(0o755)
    _agent(agents, "kimi", binary=str(custom_kimi))
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")
    monkeypatch.setattr("quorum.run_all.secrets.token_urlsafe", lambda _n: "raw-batch-token")

    with patch("quorum.run_all.run_kimi_auth_preflight"):
        env = prepare_kimi_batch_preflight(
            batch_dir=tmp_path / "batch",
            coding_agents_dir=agents,
        )

    marker_text = Path(env["QUORUM_KIMI_PREFLIGHT_SENTINEL"]).read_text()
    assert env["QUORUM_KIMI_PREFLIGHT_TOKEN"] == "raw-batch-token"
    assert "raw-batch-token" not in marker_text
    assert "preflight_token_sha256" in marker_text


def test_run_batch_kimi_preflight_failure_writes_indeterminate_runs(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    _scenario(scenarios, "b")
    _agent(agents, "kimi")
    out_root = tmp_path / "results"

    with patch(
        "quorum.run_all.prepare_kimi_batch_preflight",
        side_effect=RuntimeError("kimi auth failed"),
    ):
        batch_dir = run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=lambda **_kwargs: ChildResult(
                run_id=None,
                exit_code=99,
                error="should not run",
            ),
            use_cursor=False,
        )

    records = [json.loads(line) for line in (batch_dir / "results.jsonl").read_text().splitlines()]
    assert len(records) == 2
    assert all(record["run_id"] for record in records)
    verdicts = [
        json.loads((out_root / record["run_id"] / "verdict.json").read_text()) for record in records
    ]
    assert all(v["final"] == "indeterminate" for v in verdicts)
    assert all(v["error"]["stage"] == "setup" for v in verdicts)
    assert all("kimi auth failed" in v["error"]["message"] for v in verdicts)


def test_run_batch_kimi_parent_preflight_uses_configured_binary(tmp_path, monkeypatch):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    custom_kimi = tmp_path / "custom-kimi"
    custom_kimi.write_text("#!/usr/bin/env bash\nexit 0\n")
    custom_kimi.chmod(0o755)
    _agent(agents, "kimi", binary=str(custom_kimi))
    out_root = tmp_path / "results"
    preflight_binaries = []
    child_envs = []
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")

    def fake_preflight(*, kimi_binary, **_kwargs):
        preflight_binaries.append(kimi_binary)

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        child_envs.append(extra_env or {})
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x", exit_code=0, error=None)

    with patch("quorum.run_all.run_kimi_auth_preflight", side_effect=fake_preflight):
        run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=fake_invoke,
            use_cursor=False,
        )

    assert preflight_binaries == [str(custom_kimi)]
    assert child_envs[0]["QUORUM_KIMI_PREFLIGHT_SENTINEL"]
    assert child_envs[0]["QUORUM_KIMI_PREFLIGHT_TOKEN"]


def test_run_batch_kimi_preflight_token_stays_out_of_batch_artifacts(tmp_path, monkeypatch):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    custom_kimi = tmp_path / "custom-kimi"
    custom_kimi.write_text("#!/usr/bin/env bash\nexit 0\n")
    custom_kimi.chmod(0o755)
    _agent(agents, "kimi", binary=str(custom_kimi))
    out_root = tmp_path / "results"
    child_envs = []
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")
    monkeypatch.setattr("quorum.run_all.secrets.token_urlsafe", lambda _n: "raw-batch-token")

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        child_envs.append(extra_env or {})
        run_id = f"{scenario_dir.name}-{coding_agent}-x"
        run_dir = out_root / run_id
        run_dir.mkdir(parents=True)
        (run_dir / "verdict.json").write_text(
            json.dumps({"final": "pass", "error": None}, indent=2) + "\n"
        )
        return ChildResult(run_id=run_id, exit_code=0, error=None)

    with patch("quorum.run_all.run_kimi_auth_preflight"):
        batch_dir = run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=fake_invoke,
            use_cursor=False,
        )

    assert child_envs[0]["QUORUM_KIMI_PREFLIGHT_TOKEN"] == "raw-batch-token"
    marker = batch_dir / "kimi-preflight-ok.json"
    assert marker.exists()
    assert "raw-batch-token" not in marker.read_text()
    assert "raw-batch-token" not in (batch_dir / "results.jsonl").read_text()
    assert "raw-batch-token" not in (out_root / "a-kimi-x" / "verdict.json").read_text()


def test_run_batch_kimi_preflight_failure_redacts_secret_in_verdict(tmp_path, monkeypatch):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    _agent(agents, "kimi")
    out_root = tmp_path / "results"
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-secret")

    with patch(
        "quorum.run_all.prepare_kimi_batch_preflight",
        side_effect=RuntimeError("kimi auth failed with fake-secret"),
    ):
        batch_dir = run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=lambda **_kwargs: ChildResult(
                run_id=None,
                exit_code=99,
                error="should not run",
            ),
            use_cursor=False,
        )

    [record] = [
        json.loads(line) for line in (batch_dir / "results.jsonl").read_text().splitlines()
    ]
    verdict_text = (out_root / record["run_id"] / "verdict.json").read_text()
    assert "fake-secret" not in verdict_text
    assert "<redacted>" in verdict_text


def test_run_batch_scenario_filter_runs_only_named(tmp_path):
    """--scenarios narrows the batch to the named scenarios (resume support)."""
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    for n in ("a", "b", "c"):
        _scenario(scenarios, n)
    _agent(agents, "claude")
    out_root = tmp_path / "results"

    invoked: list[str] = []

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        invoked.append(scenario_dir.name)
        return ChildResult(run_id=f"{scenario_dir.name}-claude-x", exit_code=0, error=None)

    run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=1,
        agent_filter=None,
        scenario_filter=["a", "c"],
        invoke=fake_invoke,
        use_cursor=False,
    )

    assert sorted(invoked) == ["a", "c"]


def test_run_batch_event_format_uses_total_denominator_and_skip_verb(tmp_path, capsys, monkeypatch):
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

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        return ChildResult(
            run_id=f"{scenario_dir.name}-{coding_agent}-x",
            exit_code=0,
            error=None,
        )

    run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=1,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
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
    first_start_pos = min(captured.find(f"[{i}/4] start") for i in (2, 3, 4))
    assert 0 <= skip_pos < first_start_pos, (skip_pos, first_start_pos)


def test_run_cost_reads_frozen_total(tmp_path):
    run_dir = tmp_path / "run-1"
    run_dir.mkdir()
    (run_dir / "verdict.json").write_text(
        json.dumps(
            {
                "final": "pass",
                "economics": {"total_est_cost_usd": 2.27, "partial": False},
            }
        )
    )
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

    def fake_invoke(
        *,
        scenario_dir,
        coding_agent,
        coding_agents_dir,
        out_root,
        extra_env=None,
        timeout_seconds=None,
    ):
        run_id = f"{scenario_dir.name}-{coding_agent}-x"
        rd = out_root / run_id
        rd.mkdir(parents=True, exist_ok=True)
        (rd / "verdict.json").write_text(
            json.dumps(
                {
                    "final": "pass",
                    "economics": {"total_est_cost_usd": 2.27, "partial": False},
                }
            )
        )
        return ChildResult(run_id=run_id, exit_code=0, error=None)

    run_batch(
        scenarios_root=scenarios,
        coding_agents_dir=agents,
        out_root=out_root,
        jobs=1,
        agent_filter=None,
        invoke=fake_invoke,
        use_cursor=False,
    )

    captured = capsys.readouterr().out
    assert "$2.27" in captured, captured  # per-run cost cell
    assert "cost $2.27" in captured, captured  # footer batch total
