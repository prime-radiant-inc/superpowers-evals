# Harness Triage Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `harness show <target>` (neutral renderer over `verdict.json`) and the `triaging-a-failing-eval` skill (pattern-atlas markdown doc), so triaging a non-passing harness run is a 30-second operation. Validate by attributing all of today's non-pass runs (11: 8 fail + 3 indeterminate from the 2026-05-23 sweep) cleanly to the six-pattern taxonomy.

**Architecture:** New `harness/show.py` module holds a `resolve_target` function (five-rule resolver) and a `render` function (renders verdict + judge layer + checks layer). `harness/cli.py` adds a thin `show` subcommand. Skill doc is plain markdown at `docs/superpowers/skills/triaging-a-failing-eval.md`. ANSI via `click.style` to match the existing CLI's conventions. No new dependencies.

**Tech Stack:** Python 3.11+, click (already in use), pytest (TDD).

**Spec:** [`docs/superpowers/specs/2026-05-23-harness-triage-tooling-design.md`](../specs/2026-05-23-harness-triage-tooling-design.md). The decisions log at the bottom of the spec is the canonical reference.

---

## File Structure

**New files:**
- `harness/show.py` — `ShowError`, `ShowMode`, `resolve_target`, `render`, plus small helpers (`_format_header`, `_format_gauntlet_pane`, `_format_checks_pane`).
- `tests/harness/test_show.py` — resolver and renderer tests.
- `docs/superpowers/skills/triaging-a-failing-eval.md` — the pattern atlas.

**Modified files:**
- `harness/cli.py` — add `show` subcommand (~15 lines).
- `CLAUDE.md` — one-line reference to the skill.

**Out of scope:** no changes to `composer.py`, `runner.py`, `checks.py`, or any scenario.

---

## Task 1: Target resolver (TDD, no rendering yet)

**Files:**
- Create: `harness/show.py`
- Test: `tests/harness/test_show.py`

The resolver is the load-bearing logic — five distinct cases per spec §5. Build it standalone before any rendering.

- [ ] **Step 1: Write failing tests for the resolver**

Create `tests/harness/test_show.py`:

```python
# tests/harness/test_show.py
from pathlib import Path

import pytest

from harness.show import ShowError, resolve_target


def _make_run(root: Path, name: str, *, age_seconds: int = 0) -> Path:
    """Create a run-dir with a stub verdict.json; age_seconds backdates mtime."""
    import time
    d = root / name
    d.mkdir(parents=True)
    (d / "verdict.json").write_text('{"schema":1,"final":"pass"}')
    if age_seconds:
        t = time.time() - age_seconds
        import os
        os.utime(d / "verdict.json", (t, t))
        os.utime(d, (t, t))
    return d


def test_resolve_omitted_picks_newest(tmp_path: Path):
    root = tmp_path / "results-harness"; root.mkdir()
    _make_run(root, "old-claude-20260501T000000Z-aaaa", age_seconds=10000)
    new = _make_run(root, "new-claude-20260523T000000Z-bbbb")
    assert resolve_target(None, results_root=root) == new


def test_resolve_path_to_run_dir(tmp_path: Path):
    root = tmp_path / "results-harness"; root.mkdir()
    run = _make_run(root, "x-claude-20260523T000000Z-aaaa")
    assert resolve_target(str(run), results_root=root) == run


def test_resolve_path_to_verdict_json(tmp_path: Path):
    root = tmp_path / "results-harness"; root.mkdir()
    run = _make_run(root, "x-claude-20260523T000000Z-aaaa")
    assert resolve_target(str(run / "verdict.json"), results_root=root) == run


def test_resolve_prefix_match_newest(tmp_path: Path):
    root = tmp_path / "results-harness"; root.mkdir()
    _make_run(root, "worktree-flow-claude-20260501T000000Z-aaaa", age_seconds=10000)
    new = _make_run(root, "worktree-flow-claude-20260523T000000Z-bbbb")
    assert resolve_target("worktree-flow", results_root=root) == new


def test_resolve_no_match_raises(tmp_path: Path):
    root = tmp_path / "results-harness"; root.mkdir()
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target("does-not-exist", results_root=root)


def test_resolve_empty_results_root_raises(tmp_path: Path):
    root = tmp_path / "results-harness"; root.mkdir()
    with pytest.raises(ShowError, match="no run-dir resolved"):
        resolve_target(None, results_root=root)


def test_resolve_path_without_verdict_json_raises(tmp_path: Path):
    bad = tmp_path / "not-a-run"; bad.mkdir()
    with pytest.raises(ShowError, match="no verdict.json"):
        resolve_target(str(bad), results_root=tmp_path)
```

- [ ] **Step 2: Run tests to confirm they fail**

```
uv run pytest tests/harness/test_show.py -x -q
```

Expected: `ModuleNotFoundError: No module named 'harness.show'`.

- [ ] **Step 3: Write the minimal `harness/show.py`**

```python
# harness/show.py
"""harness show — neutral renderer over verdict.json + siblings.

Spec: docs/superpowers/specs/2026-05-23-harness-triage-tooling-design.md.
"""
from __future__ import annotations

from pathlib import Path


class ShowError(Exception):
    """Resolution or rendering failure; CLI maps to exit code 1 (resolution)
    or 2 (malformed verdict)."""


def resolve_target(target: str | None, *, results_root: Path) -> Path:
    """Resolve `<target>` (per spec §5) to a run-dir Path.

    Order:
      1. None → newest run-dir under results_root (by mtime).
      2. Path that is a dir with verdict.json → that dir.
      3. Path that is a verdict.json file → its parent dir.
      4. Prefix match: results_root/<target>-* → newest match by mtime.
      5. Else → ShowError.
    """
    # Rule 1: omitted
    if target is None:
        candidates = [d for d in results_root.iterdir() if (d / "verdict.json").is_file()]
        if not candidates:
            raise ShowError(f"no run-dir resolved from {target!r} (no runs in {results_root})")
        return max(candidates, key=lambda d: (d / "verdict.json").stat().st_mtime)

    p = Path(target)
    # Rule 2: directory containing verdict.json
    if p.is_dir():
        if (p / "verdict.json").is_file():
            return p
        raise ShowError(f"no verdict.json in {p}")
    # Rule 3: verdict.json file itself
    if p.is_file() and p.name == "verdict.json":
        return p.parent

    # Rule 4: prefix match under results_root
    matches = [
        d for d in results_root.glob(f"{target}-*")
        if d.is_dir() and (d / "verdict.json").is_file()
    ]
    if matches:
        return max(matches, key=lambda d: (d / "verdict.json").stat().st_mtime)

    # Rule 5: nothing matched
    raise ShowError(f"no run-dir resolved from {target!r}")
```

- [ ] **Step 4: Run tests; expect green**

```
uv run pytest tests/harness/test_show.py -x -q
```

Expected: all 7 resolver tests pass.

- [ ] **Step 5: Commit**

```bash
git add harness/show.py tests/harness/test_show.py
git commit -m "harness: add show.resolve_target with 5-rule resolution

Pure resolver, no rendering yet. Per spec §5: omitted → newest;
explicit path → use it; prefix match → newest match. Raises
ShowError on no-match or no-verdict-json.

Co-Authored-By: <your-handle>"
```

---

## Task 2: Renderer — full mode, plain text (no ANSI yet)

**Files:**
- Modify: `harness/show.py`
- Test: `tests/harness/test_show.py`

Build the layout per spec §6 in plain text. ANSI comes in Task 4.

- [ ] **Step 1: Write a failing renderer test using a real verdict shape**

Append to `tests/harness/test_show.py`:

```python
import json

from harness.show import render


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


def test_render_full_contains_canonical_fields(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    # Header
    assert str(run_dir) in out
    assert "final" in out and "fail" in out
    assert "1 post-check(s) failed" in out
    # Gauntlet pane
    assert "Gauntlet-Agent" in out
    assert "pass" in out
    assert "The agent created a worktree for notifications." in out
    assert "Both ACs satisfied" in out
    # Checks pane
    assert "git-repo" in out
    assert "git-count worktrees eq 2" in out
    assert "worktrees count 1 not eq 2" in out
    # Footer
    assert "triaging-a-failing-eval.md" in out


def test_render_full_separates_pre_and_post(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    pre_idx = out.index("git-repo")
    post_idx = out.index("git-count")
    assert pre_idx < post_idx  # pre checks rendered before post
```

- [ ] **Step 2: Run; expect failure (`render` not defined)**

```
uv run pytest tests/harness/test_show.py -x -q
```

- [ ] **Step 3: Add `render` to `harness/show.py`**

```python
# Append to harness/show.py

from typing import Literal

ShowMode = Literal["full", "quiet", "json"]

_FOOTER = "see docs/superpowers/skills/triaging-a-failing-eval.md for triage."


def render(verdict: dict, run_dir: Path, *, color: bool, mode: ShowMode) -> str:
    """Render a verdict per spec §6. ANSI when color=True (Task 4).

    Returns the rendered string with a trailing newline. Caller decides
    where it goes (stdout, file, test).
    """
    if mode == "json":
        import json
        return json.dumps(verdict, indent=2) + "\n"

    if mode == "quiet":
        return (
            f"final     {verdict['final']}\n"
            f"reason    {verdict.get('final_reason', '')}\n"
        )

    # mode == "full"
    parts: list[str] = []
    parts.append(_format_header(verdict, run_dir))
    parts.append(_format_gauntlet_pane(verdict))
    parts.append(_format_checks_pane(verdict))
    parts.append(_FOOTER + "\n")
    return "\n".join(parts)


def _format_header(verdict: dict, run_dir: Path) -> str:
    final = verdict["final"]
    reason = verdict.get("final_reason", "")
    return (
        f"run-dir   {run_dir}\n"
        f"final     {final}\n"
        f"reason    {reason}\n"
    )


def _format_gauntlet_pane(verdict: dict) -> str:
    g = verdict.get("gauntlet") or {}
    status = g.get("status", "—")
    summary = _wrap_indent(g.get("summary", ""), indent=10, width=72)
    reasoning = _wrap_indent(g.get("reasoning", ""), indent=10, width=72)
    return (
        "─── Gauntlet-Agent ───────────────────────────────\n"
        f"status    {status}\n"
        f"summary   {summary}\n"
        f"reasoning {reasoning}\n"
    )


def _format_checks_pane(verdict: dict) -> str:
    checks = verdict.get("checks") or []
    lines: list[str] = ["─── Deterministic checks ─────────────────────────"]
    # Group: pre first, then post, preserving order within each phase.
    for phase in ("pre", "post"):
        for c in checks:
            if c.get("phase") != phase:
                continue
            mark = "✓" if c["passed"] else "✗"
            negated = "NOT " if c.get("negated") else ""
            args = " ".join(c.get("args") or [])
            head = f"{phase:<4} {mark} {negated}{c['check']}"
            if args:
                head += f" {args}"
            lines.append(head)
            if not c["passed"] and c.get("detail"):
                lines.append(f"       {c['detail']}")
    return "\n".join(lines) + "\n"


def _wrap_indent(text: str, *, indent: int, width: int) -> str:
    """Word-wrap `text` to `width` cols, indenting all but the first line."""
    if not text:
        return ""
    import textwrap
    pad = " " * indent
    wrapped = textwrap.fill(text, width=width, subsequent_indent=pad)
    return wrapped
```

- [ ] **Step 4: Run; expect green**

```
uv run pytest tests/harness/test_show.py -x -q
```

- [ ] **Step 5: Commit**

```bash
git add harness/show.py tests/harness/test_show.py
git commit -m "harness: render verdict in full + quiet + json modes (plain text)

Three-pane layout per spec §6: header, Gauntlet-Agent pane, checks
pane grouped pre-then-post, footer pointing at the skill. Word-wrap
gauntlet summary/reasoning at 72 cols. Detail line below failing
checks. Quiet and json modes also work; ANSI styling comes in Task 4.

Co-Authored-By: <your-handle>"
```

---

## Task 3: Quiet + JSON edge-case tests

**Files:**
- Test: `tests/harness/test_show.py`

Already added the modes in Task 2; backfill explicit tests now.

- [ ] **Step 1: Add tests**

```python
def test_render_quiet_two_lines(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="quiet")
    lines = out.splitlines()
    assert len(lines) == 2
    assert lines[0].startswith("final")
    assert lines[1].startswith("reason")


def test_render_json_is_valid_verdict_json(tmp_path: Path):
    import json as _json
    run_dir = tmp_path / "run"; run_dir.mkdir()
    v = _verdict_fail_pass_judge()
    out = render(v, run_dir, color=False, mode="json")
    parsed = _json.loads(out)
    assert parsed["schema"] == 1
    assert parsed["final"] == "fail"
    assert len(parsed["checks"]) == 3


def test_render_handles_pass_verdict(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
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
    # No "failing check detail" line on a pass
    assert out.count("\n") < 20


def test_render_handles_indeterminate_with_error(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
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
```

- [ ] **Step 2: Run; expect all green**

```
uv run pytest tests/harness/test_show.py -x -q
```

If `test_render_handles_indeterminate_with_error` fails because `_format_gauntlet_pane` crashes on `gauntlet=None`, fix by guarding in `_format_gauntlet_pane`:

```python
def _format_gauntlet_pane(verdict: dict) -> str:
    g = verdict.get("gauntlet") or {}
    # ... unchanged
```

(The Task 2 implementation already does `verdict.get("gauntlet") or {}`. If a test fails for another reason, fix that exact issue — don't speculatively change anything else.)

- [ ] **Step 3: Commit**

```bash
git add tests/harness/test_show.py
git commit -m "harness: backfill show renderer edge-case tests

Quiet mode = 2 lines. JSON mode = parseable verdict.json. Pass
verdict renders short and clean. Indeterminate with error still
shows all panes (Gauntlet-Agent pane gets em-dash placeholder).

Co-Authored-By: <your-handle>"
```

---

## Task 4: ANSI color via click.style

**Files:**
- Modify: `harness/show.py`
- Test: `tests/harness/test_show.py`

- [ ] **Step 1: Write failing tests for color injection**

```python
def test_render_full_color_injects_ansi(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=True, mode="full")
    # ANSI escape sequences present
    assert "\x1b[" in out
    # Red glyph and word for the fail
    assert "\x1b[31m" in out or "\x1b[91m" in out  # red or bright red


def test_render_full_no_color_omits_ansi(tmp_path: Path):
    run_dir = tmp_path / "run"; run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=False, mode="full")
    assert "\x1b[" not in out


def test_render_quiet_color_skipped(tmp_path: Path):
    # Quiet mode is for pipelines; color noise off even when color=True.
    run_dir = tmp_path / "run"; run_dir.mkdir()
    out = render(_verdict_fail_pass_judge(), run_dir, color=True, mode="quiet")
    assert "\x1b[" not in out
```

- [ ] **Step 2: Run; expect failure (no ANSI in any output)**

- [ ] **Step 3: Wire colors via `click.style` in the formatters**

Replace the formatters with color-aware versions:

```python
# Add at top of harness/show.py
import click

_VERDICT_COLORS = {"pass": "green", "fail": "red", "indeterminate": "yellow"}


def _style(text: str, *, fg: str | None = None, dim: bool = False, color: bool) -> str:
    """Apply click.style only when color=True; passthrough otherwise."""
    if not color:
        return text
    return click.style(text, fg=fg, dim=dim or False)


def _format_header(verdict: dict, run_dir: Path, *, color: bool = False) -> str:
    final = verdict["final"]
    reason = verdict.get("final_reason", "")
    final_styled = _style(final, fg=_VERDICT_COLORS.get(final), color=color)
    return (
        f"run-dir   {run_dir}\n"
        f"final     {final_styled}\n"
        f"reason    {reason}\n"
    )


def _format_gauntlet_pane(verdict: dict, *, color: bool = False) -> str:
    g = verdict.get("gauntlet") or {}
    status = g.get("status", "—")
    status_styled = _style(status, fg=_VERDICT_COLORS.get(status), color=color)
    summary = _wrap_indent(g.get("summary", ""), indent=10, width=72)
    reasoning = _wrap_indent(g.get("reasoning", ""), indent=10, width=72)
    sep = _style("─── Gauntlet-Agent ───────────────────────────────", fg="cyan", dim=True, color=color)
    return (
        f"{sep}\n"
        f"status    {status_styled}\n"
        f"summary   {summary}\n"
        f"reasoning {reasoning}\n"
    )


def _format_checks_pane(verdict: dict, *, color: bool = False) -> str:
    checks = verdict.get("checks") or []
    sep = _style("─── Deterministic checks ─────────────────────────", fg="cyan", dim=True, color=color)
    lines: list[str] = [sep]
    for phase in ("pre", "post"):
        for c in checks:
            if c.get("phase") != phase:
                continue
            mark = _style("✓" if c["passed"] else "✗",
                          fg="green" if c["passed"] else "red", color=color)
            negated = "NOT " if c.get("negated") else ""
            args = " ".join(c.get("args") or [])
            head = f"{phase:<4} {mark} {negated}{c['check']}"
            if args:
                head += f" {args}"
            lines.append(head)
            if not c["passed"] and c.get("detail"):
                lines.append(f"       {c['detail']}")
    return "\n".join(lines) + "\n"
```

And update `render` to thread color:

```python
def render(verdict: dict, run_dir: Path, *, color: bool, mode: ShowMode) -> str:
    if mode == "json":
        import json
        return json.dumps(verdict, indent=2) + "\n"
    if mode == "quiet":
        # Quiet mode is for pipelines; no color regardless of flag.
        return (
            f"final     {verdict['final']}\n"
            f"reason    {verdict.get('final_reason', '')}\n"
        )
    parts: list[str] = [
        _format_header(verdict, run_dir, color=color),
        _format_gauntlet_pane(verdict, color=color),
        _format_checks_pane(verdict, color=color),
        _FOOTER + "\n",
    ]
    return "\n".join(parts)
```

- [ ] **Step 4: Run; expect green**

```
uv run pytest tests/harness/test_show.py -x -q
```

- [ ] **Step 5: Commit**

```bash
git add harness/show.py tests/harness/test_show.py
git commit -m "harness: add ANSI color to show renderer

Color via click.style — pass green, fail red, indeterminate yellow.
Check marks ✓/✗ colored. Separators dim cyan. color=False is a no-op
pass-through. Quiet mode never colors (pipeline use).

Co-Authored-By: <your-handle>"
```

---

## Task 5: CLI subcommand + auto-TTY detection

**Files:**
- Modify: `harness/cli.py`
- Test: `tests/harness/test_cli.py`

- [ ] **Step 1: Read existing CLI patterns**

```
cat harness/cli.py | head -80
```

Note the existing `@main.command(…)` patterns, click options style, exit-code conventions.

- [ ] **Step 2: Write failing test for the CLI**

Append to `tests/harness/test_cli.py`:

```python
def test_show_subcommand_renders_latest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from click.testing import CliRunner
    from harness.cli import main

    root = tmp_path / "results-harness"
    run = root / "x-claude-20260523T000000Z-aaaa"
    run.mkdir(parents=True)
    (run / "verdict.json").write_text(
        '{"schema":1,"final":"pass","final_reason":"ok",'
        '"gauntlet":{"status":"pass","summary":"s","reasoning":"r","run_id":"x_z_0000"},'
        '"checks":[],"error":null}'
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 0
    assert "final" in result.output and "pass" in result.output


def test_show_subcommand_quiet_flag(tmp_path: Path):
    from click.testing import CliRunner
    from harness.cli import main

    root = tmp_path / "results-harness"
    run = root / "x-claude-20260523T000000Z-aaaa"
    run.mkdir(parents=True)
    (run / "verdict.json").write_text(
        '{"schema":1,"final":"fail","final_reason":"1 post-check(s) failed",'
        '"gauntlet":null,"checks":[],"error":null}'
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "-q", "--results-root", str(root)])
    assert result.exit_code == 0
    assert result.output.count("\n") == 2


def test_show_subcommand_missing_target_exits_1(tmp_path: Path):
    from click.testing import CliRunner
    from harness.cli import main

    root = tmp_path / "results-harness"; root.mkdir()
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--results-root", str(root)])
    assert result.exit_code == 1
    assert "no run-dir resolved" in result.output


def test_show_subcommand_json_flag(tmp_path: Path):
    import json as _json
    from click.testing import CliRunner
    from harness.cli import main

    root = tmp_path / "results-harness"
    run = root / "x-claude-20260523T000000Z-aaaa"
    run.mkdir(parents=True)
    (run / "verdict.json").write_text(
        '{"schema":1,"final":"pass","final_reason":"ok","gauntlet":null,"checks":[],"error":null}'
    )
    runner = CliRunner()
    result = runner.invoke(main, ["show", "--json", "--results-root", str(root)])
    assert result.exit_code == 0
    parsed = _json.loads(result.output)
    assert parsed["schema"] == 1
```

- [ ] **Step 3: Run; expect failure (`show` subcommand doesn't exist)**

- [ ] **Step 4: Add the `show` subcommand to `harness/cli.py`**

Append (following the file's existing patterns — `@main.command(...)`, click options, exit handling):

```python
# In harness/cli.py — alongside other subcommands

import json as _json
import sys

from harness.show import ShowError, ShowMode, render, resolve_target

_DEFAULT_RESULTS_ROOT = Path("results-harness")


@main.command("show")
@click.argument("target", required=False)
@click.option("-q", "--quiet", "mode_quiet", is_flag=True,
              help="Print only the two-line header (for pipelines).")
@click.option("--json", "mode_json", is_flag=True,
              help="Print raw verdict.json after resolving target.")
@click.option("--no-color", "no_color", is_flag=True,
              help="Disable ANSI color (auto-disabled when stdout isn't a TTY).")
@click.option(
    "--results-root",
    default=_DEFAULT_RESULTS_ROOT,
    type=click.Path(path_type=Path),
    help="Where to look for run-dirs (default: results-harness/).",
)
def show(
    target: str | None,
    mode_quiet: bool,
    mode_json: bool,
    no_color: bool,
    results_root: Path,
) -> None:
    """Render a harness run's verdict + sibling files.

    TARGET resolution (in order):
      • omitted             → newest run-dir under --results-root
      • path/to/run-dir/    → that dir (must contain verdict.json)
      • path/.../verdict.json → its parent
      • prefix              → newest results-harness/<prefix>-* by mtime
    """
    if mode_quiet and mode_json:
        click.echo("error: --quiet and --json are mutually exclusive", err=True)
        sys.exit(1)
    mode: ShowMode = "json" if mode_json else "quiet" if mode_quiet else "full"

    try:
        run_dir = resolve_target(target, results_root=results_root)
    except ShowError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(1)

    verdict_path = run_dir / "verdict.json"
    try:
        verdict = _json.loads(verdict_path.read_text())
    except _json.JSONDecodeError as e:
        click.echo(f"error: malformed verdict.json at {verdict_path}: {e}", err=True)
        sys.exit(2)

    color = not no_color and sys.stdout.isatty()
    click.echo(render(verdict, run_dir, color=color, mode=mode), nl=False)
```

- [ ] **Step 5: Run; expect green**

```
uv run pytest tests/harness/test_cli.py -x -q
```

- [ ] **Step 6: Smoke against a real run-dir**

```bash
uv run harness show
uv run harness show -q
uv run harness show --json | jq .final
uv run harness show worktree-consent-flow
```

Each should produce sensible output. Fix any issues observed (likely none if tests pass).

- [ ] **Step 7: Commit**

```bash
git add harness/cli.py tests/harness/test_cli.py
git commit -m "harness: add 'show' CLI subcommand

Thin click wrapper over harness.show.resolve_target + render. Flags:
-q / --quiet, --json, --no-color (auto-applied when stdout isn't a
TTY). --quiet and --json are mutually exclusive. Exit codes: 0 on
success, 1 on resolution failure, 2 on malformed verdict.json.

Smoked against today's results-harness/ entries; resolver correctly
finds the latest run when target is omitted, finds a scenario-prefix
match, and reads back the exact verdict.json via --json.

Co-Authored-By: <your-handle>"
```

---

## Task 6: Write the pattern atlas skill

**Files:**
- Create: `docs/superpowers/skills/triaging-a-failing-eval.md`

This is markdown writing, not code. No tests; the validation is Task 8.

- [ ] **Step 1: Create the directory if needed**

```bash
mkdir -p docs/superpowers/skills
```

- [ ] **Step 2: Write the atlas**

Create `docs/superpowers/skills/triaging-a-failing-eval.md` with the structure below. Use real run-dir examples from `results-harness/` for Patterns 1-5; Pattern 6 (setup failure) gets a wording-only example since no live one exists yet.

```markdown
# Triaging a failing harness eval

When `harness run` produces `final: fail` or `final: indeterminate`, this
is the procedure. The tool that surfaces evidence is `harness show`; the
six patterns below are the model you match against.

## How to use this atlas

1. Run `harness show <target>` to see the verdict.
2. Match the verdict's shape to one of the six **Signature** lines below.
3. If you find a match: read **What to look for** and **Suggested next**.
4. If two patterns match (almost always Pattern 2 vs Pattern 4):
   apply the *verify-the-check-before-blaming-the-agent* rubric. Re-run
   the failing check against a known-good fixture. If it passes there,
   the agent is at fault (Pattern 2); if it still fails, the check is
   broken (Pattern 4).
5. If no pattern matches: read all six anyway, then escalate to Matt.

---

## Pattern 1 — Real defect, judge caught

The Gauntlet-Agent watched the conversation and judged it failed. The
deterministic checks back this up (or are silent).

**Signature**: `final=fail` · `gauntlet=fail` · post-checks mostly clean

**What to look for**:
- `gauntlet.summary` and `gauntlet.reasoning` describe what the agent did wrong.
- Failing checks (if any) corroborate.

**Sample** (from `triggering-test-driven-development-claude-…`):
- judge: *"The agent loaded `superpowers:brainstorming` instead of `superpowers:test-driven-development` when asked to implement the email validation feature."*
- check: `skill-called superpowers:test-driven-development → never called`

**Suggested next**:
The bug is in the agent (or the skill it should have loaded). Read the
transcript for the moment the wrong skill loaded — usually the model
matched on a too-broad trigger. Either fix the skill's trigger
description or escalate to Matt.

---

## Pattern 2 — Real defect, check caught (judge missed)

The conversation looked fine to the Gauntlet-Agent, but a deterministic
check found the work was never actually done. **This is the case the
two-layer verdict exists to surface.**

**Signature**: `final=fail` · `gauntlet=pass` · ≥1 post-check fails

**What to look for**:
- The failing check's `detail` field names the missing artifact
  (worktree count, file path, git state).
- `gauntlet.reasoning` describes what *looked* like success — read for
  the gap between "agent said it did X" and "X actually happened on disk."

**Sample** (from `worktree-consent-flow-claude-…`):
- judge: *"The agent correctly treated naming the worktree skill as consent, proceeded without asking, and created a worktree for the notifications feature."*
- check: `git-count worktrees eq 2 → count 1`

**Suggested next**:
**First**, verify the check is correct (the Pattern 2 vs Pattern 4
rubric): re-run the failing check against a known-good fixture or by
hand. If it correctly passes when the artifact exists, this is genuinely
Pattern 2 — the agent described doing the work without actually
running the command, or ran it in the wrong directory. Check the
tool-calls (`coding-agent-tool-calls.jsonl`) for the missing
invocation.

---

## Pattern 3 — Environment-missing

The pre-check phase failed because a required tool isn't installed in
the sandbox. We can't tell what the agent did because we never got to
post-checks.

**Signature**: `final=indeterminate` · pre-check failed (often
`command-succeeds 'command -v <tool>'`)

**What to look for**:
- Failing pre-check's `detail` says `exit non-zero:` (often empty body)
  because `command -v` doesn't print on missing tools.
- **Note**: `gauntlet.status` may be `pass` here even though `final` is
  `indeterminate` — the Gauntlet-Agent ran to completion before the
  pre-check failure was composed into the final verdict. Don't be
  thrown by judge=pass; the pre-check failure is what matters.

**Sample** (from `sdd-go-fractals-claude-…`):
- pre-check: `command-succeeds 'command -v go' → exit non-zero:`

**Suggested next**:
Not an agent bug. Either: install the missing tool on the eval host,
or update the scenario to skip when the toolchain isn't available.
(A future `requires-tool` primitive would surface this cleanly; until
then, document the dependency in the scenario's `story.md`.)

---

## Pattern 4 — Broken check (false fail)

A post-check is wrong (path mismatch, references a deleted file, bash
syntax error). The verdict says fail, but the agent did fine — the
harness is the bug.

**Signature**: `final=fail` · `gauntlet=pass` · failing-check `detail`
is a path mismatch, "no such file" of an internal harness path, or
otherwise nonsensical given the actual run-dir contents

**What to look for**:
- The failing check refers to a path that doesn't exist in the run-dir
  layout (e.g., `bin/tool-called` after the `bin/` → `harness/bin/` migration).
- The check's `detail` doesn't describe an artifact the *story* claimed.

**Sample** (from `cost-tool-result-bloat-claude-…`, fixed in commit `a04ba45`):
- check: `command-succeeds 'bin/tool-called Read 2>/dev/null || bin/tool-called Grep' → exit non-zero: bash: bin/tool-called: No such file or directory`

**Suggested next**:
Fix the check in `harness/scenarios/<name>/checks.sh`. Verify by running
the same check by hand against a previously-passing run-dir (the prior
agent's behavior should now classify correctly). Re-run the scenario
to confirm.

---

## Pattern 5 — Judge errored

The Gauntlet-Agent's own LLM call failed — empty response, API error,
or explicit `investigate` status. We can't trust the judge layer for
this run; deterministic checks may still be informative.

**Signature**: `final=indeterminate` · `gauntlet.status` is `"investigate"` or `"errored"`

(`composer.py:95` treats both as the same indeterminate verdict.)

**What to look for**:
- `gauntlet.summary` often short and odd
  ("LLM returned neither tool call nor text").
- Check whether the post-checks ran anyway — they did, and their
  pass/fail still tells you something about the artifact state.

**Sample** (from `cost-spec-plan-duplication-claude-…`):
- gauntlet.summary: *"LLM returned neither tool call nor text"*
- check: `file-exists docs/superpowers/plans/*.md → no path matched`

**Suggested next**:
Re-run the scenario. Most "investigate" results are transient. If it
reproduces, the Gauntlet-Agent's model or prompt may be the issue — file
an issue against Gauntlet or escalate to Matt. The deterministic checks
that *did* fire are still useful evidence even when the judge errored.

---

## Pattern 6 — Setup failure

`setup.sh` (or a setup-helper it calls) crashed before the Coding-Agent
ever ran. The fixture never came up.

**Signature**: `final=indeterminate` · `error.stage="setup"`

**What to look for**:
- `error.message` names the failure.
- `coding-agent-workdir/` is empty or partial.

**Sample**: no live example as of this writing. Verdict shape is
emitted by `harness.runner.run_scenario` when `run_setup` raises
`SetupError`.

**Suggested next**:
Read the scenario's `setup.sh` and the setup-helper it calls. Most
setup failures are missing fixture files, permission issues, or a
setup-helper bug. Reproduce by running `setup.sh` directly in a fresh
tmp dir.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/skills/triaging-a-failing-eval.md
git commit -m "skill: add triaging-a-failing-eval pattern atlas

Six attribution patterns per spec §4, one card each, with real
run-dir examples from today's sweep for Patterns 1-5. Pattern 6
(setup failure) has wording only — no live example yet. Short intro
covers the 'where to start' gap and explicitly names the Pattern 2
vs Pattern 4 rubric (verify the check before blaming the agent).

Co-Authored-By: <your-handle>"
```

---

## Task 7: Wire the skill into CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the CLAUDE.md Conventions section**

```
grep -n "^## " CLAUDE.md
```

Find the right location. Most likely fits as a new line under "Conventions" or as its own short section.

- [ ] **Step 2: Add one-line reference**

Add under Conventions (or after the Harness commands section if it fits better there):

```markdown
- **Triaging a non-passing harness run**: see [docs/superpowers/skills/triaging-a-failing-eval.md](docs/superpowers/skills/triaging-a-failing-eval.md).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: reference triaging-a-failing-eval skill from CLAUDE.md

Bobs working in this repo find the triage skill via the renderer's
footer line *and* via CLAUDE.md. Both paths are intentional.

Co-Authored-By: <your-handle>"
```

---

## Task 8: Validation — attribute today's 12 non-passes

**Files:**
- No code; this is acceptance testing per spec §8.

- [ ] **Step 1: List the non-pass runs**

```bash
for d in results-harness/*/; do
  final=$(jq -r '.final' "$d/verdict.json")
  if [ "$final" != "pass" ]; then
    echo "$final  $(basename "$d")"
  fi
done | tee /tmp/triage-nonpass.txt
wc -l /tmp/triage-nonpass.txt
```

Record the actual count. Today's expected: **11** (8 fail + 3 indeterminate).
If the count differs (someone re-ran scenarios since this plan was written),
proceed with the actual list.

- [ ] **Step 2: For each run, use `harness show` and attribute to a pattern**

For each non-pass run-dir, run:

```bash
uv run harness show "$d"
```

Then open `docs/superpowers/skills/triaging-a-failing-eval.md` and find the
matching pattern by **Signature**. Record the attribution.

- [ ] **Step 3: Cross-check against the spec table**

Compare your attributions to spec §4's example column. The expected
mapping (from Saga@99240174's sweep on 2026-05-23):

| Run | `final` | Pattern | Notes |
|---|---|---|---|
| `codex-native-hooks-bootstrap` | fail | 4 → fixed (a04ba45) | Was wrong path; current state pre-fix is a Pattern 4. Skill should cite by commit-ref, not point at this run-dir. |
| `cost-checkbox-over-trigger` | fail | 1 (judge caught) | |
| `cost-spec-plan-duplication` | indeterminate | 5 (judge errored) | |
| `cost-tool-result-bloat` | fail | 4 → fixed (a04ba45) | Same as above. |
| `sdd-go-fractals` | indeterminate | 3 (env-missing) | |
| `sdd-rejects-extra-features` | **fail** | **4 (missing pre-guard)** | npm not on PATH; scenario lacks a `command-succeeds 'command -v npm'` pre-guard, so env-missing surfaces as a post-check fail instead of indeterminate. Strictly Pattern 4 (broken check; the check assumes npm exists when it shouldn't); the *fix* is to add the pre-guard, which would make it Pattern 3 cleanly. **This case is itself a useful pattern-distinguishing exercise — note in the skill.** |
| `sdd-svelte-todo` | indeterminate | 3 (env-missing) | |
| `triggering-requesting-code-review` | fail | 1 (judge caught) | |
| `triggering-test-driven-development` | fail | 1 (judge caught) | |
| `worktree-caller-consent-gate` | fail | 1 (judge caught) | |
| `worktree-consent-flow` | fail | 2 (check caught) | The gold case. |

Total: 11. Patterns covered: 1 (×4), 2 (×1), 3 (×2), 4 (×3 including 2 fixed), 5 (×1). Pattern 6 (setup failure) has no live example today.

- [ ] **Step 4: If all 12 attribute cleanly to one of the six patterns, declare validation success**

If any are ambiguous or unattributable, the design has a bug. Options:
- Skill wording is unclear → tighten the **What to look for** lines.
- A 7th pattern is needed → escalate to Matt; do not silently add.
- The renderer is missing a field that would disambiguate → escalate.

- [ ] **Step 5: Commit the validation note**

If validation passes cleanly, add a short note to the spec confirming it:

```markdown
# Append to spec §8

**Validation status (YYYY-MM-DD):** ✅ All 12 non-pass runs from the
2026-05-23 sweep attributed cleanly to Patterns 1-5 (Pattern 6 had no
live example). Saga@99240174's six-pattern taxonomy holds.
```

```bash
git add docs/superpowers/specs/2026-05-23-harness-triage-tooling-design.md
git commit -m "spec: record triage tooling validation pass

Co-Authored-By: <your-handle>"
```

---

## Task 9: Final code-review pass (when implementing via SDD)

Optional if implementing inline: skip the final SDD reviewer. If using
subagent-driven-development per the plan header, the final-reviewer step
runs as normal — give it the spec, the plan, and the final SHAs of all
seven commits above.

---

## Self-review (controller)

After all tasks complete:

- **Spec coverage:** spec §3 (UX), §5 (resolver + flags), §6 (output), §7 (skill), §8 (validation) all map to tasks above. Spec §4 (six patterns) and §9 (rejected ideas) inform Task 6's content.
- **Type consistency:** `ShowMode`, `ShowError`, `resolve_target`, `render` names used consistently across show.py, cli.py, and tests.
- **Validation gate:** Task 8 is the acceptance test. If it fails, the spec needs revision before this work ships.
