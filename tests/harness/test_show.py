# tests/harness/test_show.py
from __future__ import annotations

import json as _json
import os
import time
from pathlib import Path

import pytest

from harness.show import ShowError, render, resolve_target


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
    root = tmp_path / "results-harness"
    root.mkdir()
    _make_run(root, "old-claude-20260501T000000Z-aaaa", age_seconds=10000)
    new = _make_run(root, "new-claude-20260523T000000Z-bbbb")
    assert resolve_target(None, results_root=root) == new


def test_resolve_path_to_run_dir(tmp_path: Path):
    root = tmp_path / "results-harness"
    root.mkdir()
    run = _make_run(root, "x-claude-20260523T000000Z-aaaa")
    assert resolve_target(str(run), results_root=root) == run


def test_resolve_path_to_verdict_json(tmp_path: Path):
    root = tmp_path / "results-harness"
    root.mkdir()
    run = _make_run(root, "x-claude-20260523T000000Z-aaaa")
    assert resolve_target(str(run / "verdict.json"), results_root=root) == run


def test_resolve_prefix_match_newest(tmp_path: Path):
    root = tmp_path / "results-harness"
    root.mkdir()
    _make_run(root, "worktree-flow-claude-20260501T000000Z-aaaa", age_seconds=10000)
    new = _make_run(root, "worktree-flow-claude-20260523T000000Z-bbbb")
    assert resolve_target("worktree-flow", results_root=root) == new


def test_resolve_prefix_greedy_picks_newest_across_variants(tmp_path: Path):
    # `worktree-already-inside` is a prefix of both `worktree-already-inside-*`
    # and `worktree-already-inside-spec-aware-*` (today's sweep has both).
    # Resolver is greedy and picks newest mtime across the union — spec §5.
    root = tmp_path / "results-harness"
    root.mkdir()
    _make_run(root, "worktree-already-inside-claude-20260501T000000Z-a",
              age_seconds=10000)
    new = _make_run(root, "worktree-already-inside-spec-aware-claude-20260523T000000Z-b")
    assert resolve_target("worktree-already-inside", results_root=root) == new


def test_resolve_no_match_raises(tmp_path: Path):
    root = tmp_path / "results-harness"
    root.mkdir()
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target("does-not-exist", results_root=root)


def test_resolve_empty_results_root_raises(tmp_path: Path):
    root = tmp_path / "results-harness"
    root.mkdir()
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target(None, results_root=root)


def test_resolve_path_without_verdict_json_raises(tmp_path: Path):
    bad = tmp_path / "not-a-run"
    bad.mkdir()
    with pytest.raises(ShowError, match="no verdict.json"):
        resolve_target(str(bad), results_root=tmp_path)


def test_resolve_missing_results_root_omitted_target(tmp_path: Path):
    # Riker@401c4999 bug #1: results-harness/ may not exist on a fresh
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
    root = tmp_path / "results-harness"
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
