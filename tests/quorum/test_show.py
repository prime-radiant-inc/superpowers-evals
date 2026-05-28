# tests/quorum/test_show.py
from __future__ import annotations

import json as _json
import os
import time
from pathlib import Path

import pytest

from quorum.show import ShowError, is_batch_dir, render, render_batch, resolve_target


def _make_run(root: Path, name: str, *, age_seconds: int = 0) -> Path:
    """Create a run-dir with a stub verdict.json; age_seconds backdates mtime.

    Backdates only verdict.json — that's what the resolver reads. Directory
    mtime is incidental. (Linux/NFS may silently ignore os.utime on dirs;
    relying on file mtime keeps this portable.)
    """
    d = root / name
    d.mkdir(parents=True)
    (d / "verdict.json").write_text('{"schema":1,"final":"pass"}')
    if age_seconds:
        t = time.time() - age_seconds
        os.utime(d / "verdict.json", (t, t))
    return d


# ---------- resolver ----------------------------------------------------

def test_resolve_omitted_picks_newest(tmp_path: Path):
    root = tmp_path / "results"
    root.mkdir()
    _make_run(root, "old-claude-20260501T000000Z-aaaa", age_seconds=10000)
    new = _make_run(root, "new-claude-20260523T000000Z-bbbb")
    assert resolve_target(None, results_root=root) == new


def test_resolve_path_to_run_dir(tmp_path: Path):
    root = tmp_path / "results"
    root.mkdir()
    run = _make_run(root, "x-claude-20260523T000000Z-aaaa")
    assert resolve_target(str(run), results_root=root) == run


def test_resolve_path_to_verdict_json(tmp_path: Path):
    root = tmp_path / "results"
    root.mkdir()
    run = _make_run(root, "x-claude-20260523T000000Z-aaaa")
    assert resolve_target(str(run / "verdict.json"), results_root=root) == run


def test_resolve_prefix_match_newest(tmp_path: Path):
    root = tmp_path / "results"
    root.mkdir()
    _make_run(root, "worktree-flow-claude-20260501T000000Z-aaaa", age_seconds=10000)
    new = _make_run(root, "worktree-flow-claude-20260523T000000Z-bbbb")
    assert resolve_target("worktree-flow", results_root=root) == new


def test_resolve_prefix_greedy_picks_newest_across_variants(tmp_path: Path):
    # `worktree-already-inside` is a prefix of both `worktree-already-inside-*`
    # and `worktree-already-inside-spec-aware-*` (today's sweep has both).
    # Resolver is greedy and picks newest mtime across the union — spec §5.
    root = tmp_path / "results"
    root.mkdir()
    _make_run(root, "worktree-already-inside-claude-20260501T000000Z-a",
              age_seconds=10000)
    new = _make_run(root, "worktree-already-inside-spec-aware-claude-20260523T000000Z-b")
    assert resolve_target("worktree-already-inside", results_root=root) == new


def test_resolve_no_match_raises(tmp_path: Path):
    root = tmp_path / "results"
    root.mkdir()
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target("does-not-exist", results_root=root)


def test_resolve_empty_results_root_raises(tmp_path: Path):
    root = tmp_path / "results"
    root.mkdir()
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target(None, results_root=root)


def test_resolve_path_without_verdict_json_raises(tmp_path: Path):
    bad = tmp_path / "not-a-run"
    bad.mkdir()
    with pytest.raises(ShowError, match="no verdict.json"):
        resolve_target(str(bad), results_root=tmp_path)


def test_resolve_missing_results_root_omitted_target(tmp_path: Path):
    # Riker@401c4999 bug #1: results/ may not exist on a fresh
    # clone. resolve_target(None) shouldn't leak FileNotFoundError.
    nope = tmp_path / "does-not-exist"
    with pytest.raises(ShowError, match="results root does not exist"):
        resolve_target(None, results_root=nope)


def test_resolve_missing_results_root_prefix_target(tmp_path: Path):
    # Same bug class for the prefix-match branch.
    nope = tmp_path / "does-not-exist"
    with pytest.raises(ShowError, match="results root does not exist"):
        resolve_target("worktree", results_root=nope)


def test_resolve_absolute_path_nonexistent_no_glob_crash(tmp_path: Path):
    # Riker@401c4999 bug #2: absolute path that doesn't match rules 2-3
    # used to fall into Path.glob and crash with NotImplementedError.
    root = tmp_path / "results"
    root.mkdir()
    typo = "/Users/me/typo-run-dir"
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target(typo, results_root=root)


# ---------- renderer fixtures (used by Tasks 2-4) -----------------------

def _verdict_fail_pass_judge() -> dict:
    """worktree-consent-flow shape: gauntlet=pass, post-check fails."""
    return {
        "schema": 1,
        "final": "fail",
        "final_reason": "1 post-check(s) failed",
        "gauntlet": {
            "status": "pass",
            "summary": "The agent created a worktree for notifications.",
            "reasoning": "Both ACs satisfied: (1) agent proceeded; (2) worktree created.",
            "run_id": "worktree-consent-flow_20260523T215258Z_22i6",
        },
        "checks": [
            {"check": "git-repo", "args": [], "negated": False, "passed": True,
             "detail": None, "phase": "pre"},
            {"check": "git-branch", "args": ["main"], "negated": False, "passed": True,
             "detail": None, "phase": "pre"},
            {"check": "git-count", "args": ["worktrees", "eq", "2"], "negated": False,
             "passed": False, "detail": "worktrees count 1 not eq 2", "phase": "post"},
        ],
        "error": None,
    }


# ---------- renderer: full mode -----------------------------------------

def test_render_full_contains_canonical_fields(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    # Header
    assert str(run_dir) in out
    assert "final" in out and "fail" in out
    assert "1 post-check(s) failed" in out
    # Gauntlet pane
    assert "Gauntlet-Agent" in out
    assert "The agent created a worktree for notifications." in out
    assert "Both ACs satisfied" in out
    # Checks pane
    assert "git-repo" in out
    assert "git-count worktrees eq 2" in out
    assert "worktrees count 1 not eq 2" in out
    # Footer
    assert "triaging-a-failing-eval.md" in out


def test_render_full_separates_pre_and_post(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    assert out.index("git-repo") < out.index("git-count")


def test_render_full_failing_check_shows_detail(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    # Detail line follows the failing check line
    gc_idx = out.index("git-count")
    detail_idx = out.index("worktrees count 1 not eq 2")
    assert detail_idx > gc_idx


# ---------- renderer: quiet + json --------------------------------------

def test_render_quiet_two_lines(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="quiet")
    lines = out.splitlines()
    assert len(lines) == 2
    assert lines[0].startswith("final")
    assert lines[1].startswith("reason")
    assert out.endswith("\n")


def test_render_json_is_valid_verdict_json(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    v = _verdict_fail_pass_judge()
    out = render(v, run_dir, color=False, mode="json")
    parsed = _json.loads(out)
    assert parsed["schema"] == 1
    assert parsed["final"] == "fail"
    assert len(parsed["checks"]) == 3


# ---------- renderer: other verdict shapes ------------------------------

def test_render_handles_pass_verdict(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    v = {
        "schema": 1, "final": "pass",
        "final_reason": "Gauntlet-Agent passed; 2 post-check(s) passed",
        "gauntlet": {"status": "pass", "summary": "ok", "reasoning": "ok",
                     "run_id": "x_20260523T000000Z_0000"},
        "checks": [
            {"check": "file-exists", "args": ["x.md"], "negated": False,
             "passed": True, "detail": None, "phase": "post"},
        ],
        "error": None,
    }
    out = render(v, run_dir, color=False, mode="full")
    assert "pass" in out
    assert "✓" in out


def test_render_handles_indeterminate_with_error(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    v = {
        "schema": 1, "final": "indeterminate",
        "final_reason": "setup.sh crashed (exit 2)",
        "gauntlet": None,
        "checks": [],
        "error": {"stage": "setup", "message": "setup.sh exit 2"},
    }
    out = render(v, run_dir, color=False, mode="full")
    assert "indeterminate" in out
    assert "setup.sh crashed" in out
    # Empty gauntlet still renders the pane (with — placeholder)
    assert "Gauntlet-Agent" in out


# ---------- renderer: ANSI color ----------------------------------------

def test_render_full_color_injects_ansi(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=True, mode="full")
    # ANSI present at all
    assert "\x1b[" in out
    # Red somewhere for the fail word + the ✗ glyph. Accept named-color
    # forms (\x1b[31m / \x1b[91m) and truecolor forms (\x1b[38;2;R;G;B;m
    # where R is high) — current palette is truecolor (255, 85, 85).
    assert (
        "\x1b[31m" in out
        or "\x1b[91m" in out
        or "\x1b[38;2;255;85;85m" in out
    )


def test_render_full_color_yellow_on_indeterminate(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    v = {
        "schema": 1, "final": "indeterminate",
        "final_reason": "pre-check(s) failed",
        "gauntlet": {"status": "pass", "summary": "s", "reasoning": "r",
                     "run_id": "x_z_0"},
        "checks": [],
        "error": None,
    }
    out = render(v, run_dir, color=True, mode="full")
    # Yellow or bright-yellow or the current truecolor Dracula yellow
    # (#f1fa8c = 241,250,140). Contract: "yellow-ish".
    assert (
        "\x1b[33m" in out
        or "\x1b[93m" in out
        or "\x1b[38;2;241;250;140m" in out
    )


def test_render_full_no_color_omits_ansi(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    assert "\x1b[" not in out


def test_render_quiet_color_skipped(tmp_path: Path):
    # Quiet mode is for pipelines; no color regardless of flag.
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=True, mode="quiet")
    assert "\x1b[" not in out


# ---------- renderer: batch matrix --------------------------------------

def _seed_batch(tmp_path: Path, *, agents: list[str], rows: list[dict]) -> Path:
    """Build a fake batch dir + sibling per-run dirs to test the renderer."""
    out_root = tmp_path / "results"
    batch_dir = out_root / "batches" / "20260526T180000Z-abcd"
    batch_dir.mkdir(parents=True)
    (batch_dir / "batch.json").write_text(_json.dumps({
        "schema_version": 1, "id": batch_dir.name,
        "started_at": "2026-05-26T18:00:00+00:00",
        "finished_at": "2026-05-26T18:03:41+00:00",
        "coding_agents": agents, "jobs": 1,
    }))
    lines = []
    for r in rows:
        lines.append(_json.dumps(r))
        if r.get("run_id"):
            run_dir = out_root / r["run_id"]
            run_dir.mkdir(parents=True)
            (run_dir / "verdict.json").write_text(_json.dumps({
                "final": r.pop("_verdict", "pass"),
                "final_reason": r.pop("_reason", "ok"),
                "gauntlet": {}, "checks": {}, "error": None,
            }))
    (batch_dir / "results.jsonl").write_text("\n".join(lines) + "\n")
    return batch_dir


def test_render_batch_matrix_two_agents(tmp_path):
    batch_dir = _seed_batch(tmp_path, agents=["claude", "codex"], rows=[
        {"scenario": "foo", "coding_agent": "claude",
         "run_id": "foo-claude-x", "_verdict": "pass"},
        {"scenario": "foo", "coding_agent": "codex",
         "run_id": None, "skipped": "directive"},
        {"scenario": "bar", "coding_agent": "claude",
         "run_id": "bar-claude-x", "_verdict": "fail"},
        {"scenario": "bar", "coding_agent": "codex",
         "run_id": "bar-codex-x", "_verdict": "indeterminate"},
    ])

    out = render_batch(batch_dir=batch_dir, results_root=tmp_path / "results", color=False)

    assert "scenario" in out and "claude" in out and "codex" in out
    assert "✓ pass" in out
    assert "✗ fail" in out
    assert "⊘ indet" in out
    assert "— skip" in out
    assert "Legend:" in out
    # Tally line
    assert "1 ✓" in out and "1 ✗" in out and "1 ⊘" in out and "1 —" in out


def test_render_batch_missing_verdict_renders_question_glyph(tmp_path):
    batch_dir = _seed_batch(tmp_path, agents=["claude"], rows=[
        {"scenario": "foo", "coding_agent": "claude", "run_id": "ghost"},
    ])
    out = render_batch(batch_dir=batch_dir, results_root=tmp_path / "results", color=False)
    assert "?" in out


# ---------- resolver: batch-dir handling --------------------------------

def test_resolve_target_returns_batch_dir_for_batch_id(tmp_path):
    out_root = tmp_path / "results"
    batch_dir = out_root / "batches" / "20260526T180000Z-abcd"
    batch_dir.mkdir(parents=True)
    (batch_dir / "batch.json").write_text("{}")

    resolved = resolve_target("20260526T180000Z-abcd", results_root=out_root)
    assert resolved == batch_dir


def test_resolve_target_returns_batch_dir_for_explicit_path(tmp_path):
    """Explicit path to a batch dir must NOT trip the 'no verdict.json' check."""
    out_root = tmp_path / "results"
    batch_dir = out_root / "batches" / "20260526T180000Z-abcd"
    batch_dir.mkdir(parents=True)
    (batch_dir / "batch.json").write_text("{}")

    resolved = resolve_target(str(batch_dir), results_root=out_root)
    assert resolved == batch_dir


def test_is_batch_dir(tmp_path):
    batch_dir = tmp_path / "20260526T180000Z-abcd"
    batch_dir.mkdir()
    (batch_dir / "batch.json").write_text("{}")
    assert is_batch_dir(batch_dir) is True

    run_dir = tmp_path / "foo-claude-20260526T180000Z-abcd"
    run_dir.mkdir()
    (run_dir / "verdict.json").write_text("{}")
    assert is_batch_dir(run_dir) is False


def test_render_batch_emits_ansi_when_color_true(tmp_path):
    """When color=True, glyphs are wrapped in ANSI sequences."""
    batch_dir = _seed_batch(tmp_path, agents=["claude"], rows=[
        {"scenario": "foo", "coding_agent": "claude",
         "run_id": "foo-claude-x", "_verdict": "pass"},
    ])

    out = render_batch(
        batch_dir=batch_dir,
        results_root=tmp_path / "results",
        color=True,
    )

    # The "pass" glyph should be wrapped in an ANSI sequence (\x1b[).
    assert "\x1b[" in out
    # Plain text (color=False) should NOT contain ANSI sequences.
    out_plain = render_batch(
        batch_dir=batch_dir,
        results_root=tmp_path / "results",
        color=False,
    )
    assert "\x1b[" not in out_plain


def test_render_includes_economics_pane():
    from quorum.show import render
    verdict = {
        "final": "pass", "final_reason": "ok",
        "gauntlet": {"status": "pass", "summary": "", "reasoning": ""},
        "checks": [],
        "economics": {
            "pricing_asof": "2026-05",
            "gauntlet": {"duration_ms": 1885117, "model": "claude-sonnet-4-6",
                         "tokens": {"total": 7100000}, "est_cost_usd": 0.42},
            "coding_agent": {"duration_ms": 1443000, "model": "gpt-5.5",
                             "tokens": {"total": 2300000}, "est_cost_usd": 1.85},
            "total_est_cost_usd": 2.27, "partial": False,
        },
    }
    out = render(verdict, Path("/tmp/run"), color=False, mode="full")
    assert "Economics" in out
    assert "$2.27" in out
    assert "Gauntlet" in out and "Coding" in out


def test_render_economics_absent_is_safe():
    from quorum.show import render
    verdict = {"final": "pass", "final_reason": "", "gauntlet": {"status": "pass"},
               "checks": []}  # no economics key
    out = render(verdict, Path("/tmp/run"), color=False, mode="full")
    assert isinstance(out, str)  # no crash


def test_economics_pane_shows_per_model_subrows():
    from quorum.show import render
    verdict = {
        "final": "pass", "final_reason": "ok",
        "gauntlet": {"status": "pass", "summary": "", "reasoning": ""},
        "checks": [],
        "economics": {
            "pricing_asof": "2026-05",
            "gauntlet": {"duration_ms": 1000, "model": "claude-sonnet-4-6",
                         "tokens": {"total": 4_300_000}, "est_cost_usd": 1.71},
            "coding_agent": {"duration_ms": 2000, "model": "claude-opus-4-7",
                "tokens": {"total": 27_500_000}, "est_cost_usd": 32.98,
                "models": [
                    {"model": "claude-opus-4-7", "tokens": {"total": 9_700_000}, "est_cost_usd": 25.09},
                    {"model": "claude-sonnet-4-6", "tokens": {"total": 11_400_000}, "est_cost_usd": 6.50},
                    {"model": "claude-haiku-4-5-20251001", "tokens": {"total": 6_400_000}, "est_cost_usd": 1.39},
                ]},
            "total_est_cost_usd": 34.69, "partial": False,
        },
    }
    out = render(verdict, Path("/tmp/run"), color=False, mode="full")
    assert "opus" in out and "sonnet" in out and "haiku" in out
    assert "$25.09" in out and "$6.50" in out and "$1.39" in out
    assert "$34.69" in out  # total
