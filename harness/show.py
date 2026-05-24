# harness/show.py
"""harness show — neutral renderer over verdict.json + siblings.

Spec: docs/superpowers/specs/2026-05-23-harness-triage-tooling-design.md.
Plan: docs/superpowers/plans/2026-05-23-harness-triage-tooling.md.

The renderer deliberately doesn't attribute failures to patterns — that
lives in the `triaging-a-failing-eval` skill, where a Bob (the LLM) does
the judgement Pattern 2 vs Pattern 4 requires.
"""
from __future__ import annotations

import json as _json
import textwrap
from pathlib import Path
from typing import Literal

import click

ShowMode = Literal["full", "quiet", "json"]


class ShowError(Exception):
    """Resolution or rendering failure; the CLI maps to exit 1 (resolution)
    or 2 (malformed verdict)."""


# ---------- resolver ----------------------------------------------------

def resolve_target(target: str | None, *, results_root: Path) -> Path:
    """Resolve `<target>` (per spec §5) to a run-dir Path.

    Order:
      1. None → newest run-dir under results_root (by verdict.json mtime).
      2. Path that is a dir with verdict.json → that dir.
      3. Path that is a verdict.json file → its parent dir.
      4. Prefix match under results_root: `<target>-*` → newest match by mtime.
      5. Else → ShowError.

    Rules 1 and 4 require results_root to exist; rules 2-3 don't.
    """
    # Rule 1: omitted
    if target is None:
        if not results_root.is_dir():
            raise ShowError(
                f"no run-dir resolved from <none> (results root does not exist: {results_root})"
            )
        candidates = [
            d for d in results_root.iterdir()
            if d.is_dir() and (d / "verdict.json").is_file()
        ]
        if not candidates:
            raise ShowError(
                f"no run-dir resolved from <none> (no runs in {results_root})"
            )
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

    # Rule 4: prefix match under results_root. An absolute path that didn't
    # match rules 2-3 cannot be a valid run-dir prefix; bail before Path.glob
    # (which raises NotImplementedError on absolute patterns).
    if p.is_absolute():
        raise ShowError(f"no run-dir resolved from {target!r}")
    if not results_root.is_dir():
        raise ShowError(
            f"no run-dir resolved from {target!r} (results root does not exist: {results_root})"
        )
    matches = [
        d for d in results_root.glob(f"{target}-*")
        if d.is_dir() and (d / "verdict.json").is_file()
    ]
    if matches:
        return max(matches, key=lambda d: (d / "verdict.json").stat().st_mtime)

    # Rule 5: nothing matched
    raise ShowError(f"no run-dir resolved from {target!r}")


# ---------- renderer ----------------------------------------------------

_FOOTER = "see docs/superpowers/skills/triaging-a-failing-eval.md for triage."

# Verdict colors as 24-bit RGB tuples (not named-color strings). The named
# colors got remapped to muted variants by some terminal themes — bright_green
# rendered as olive on Matt's screen, bright_red as salmon. Truecolor bypasses
# the theme's color mapping so the verdict has consistent punch everywhere.
# Palette source: Dracula (a saturated-but-not-headache neon family).
_VERDICT_COLORS: dict[str, tuple[int, int, int]] = {
    "pass": (80, 250, 123),         # #50fa7b
    "fail": (255, 85, 85),          # #ff5555
    "indeterminate": (241, 250, 140),  # #f1fa8c
}

# Label color — replaces `dim` on the left-column field names. dim renders
# as nearly-invisible on dark themes; a concrete bluish-gray stays readable
# while still sitting clearly behind the colored values.
_LABEL_RGB: tuple[int, int, int] = (122, 130, 148)  # #7a8294


def _style(
    text: str,
    *,
    fg: str | tuple[int, int, int] | None = None,
    dim: bool = False,
    bold: bool = False,
    color: bool,
) -> str:
    """Apply click.style only when color=True; passthrough otherwise.

    `fg` accepts either a named color (click's standard names) or a 24-bit
    RGB tuple. The tuple form requires a truecolor-capable terminal (every
    modern one — iTerm2, Warp, Terminal.app, Alacritty, etc.).
    """
    if not color:
        return text
    return click.style(text, fg=fg, dim=dim, bold=bold)


def render(verdict: dict, run_dir: Path, *, color: bool, mode: ShowMode) -> str:
    """Render a verdict per spec §6.

    Returns the rendered string with a trailing newline. Caller decides
    where it goes (stdout, file, test capture).
    """
    if mode == "json":
        return _json.dumps(verdict, indent=2) + "\n"

    if mode == "quiet":
        # Quiet mode is for pipelines — never color, regardless of flag.
        return (
            f"final     {verdict['final']}\n"
            f"reason    {verdict.get('final_reason', '')}\n"
        )

    # mode == "full"
    parts: list[str] = [
        _format_header(verdict, run_dir, color=color),
        _format_gauntlet_pane(verdict, color=color),
        _format_checks_pane(verdict, color=color),
        _FOOTER + "\n",
    ]
    return "\n".join(parts)


def _label(text: str, *, color: bool) -> str:
    """Left-column field labels rendered in a fixed bluish-gray.

    Replaces a previous `dim=True` styling that became nearly invisible
    on some dark themes (notably the one in Matt's 2026-05-23 screenshot).
    """
    return _style(text, fg=_LABEL_RGB, color=color)


def _format_header(verdict: dict, run_dir: Path, *, color: bool) -> str:
    final = verdict["final"]
    reason = verdict.get("final_reason", "")
    final_styled = _style(
        final, fg=_VERDICT_COLORS.get(final), bold=True, color=color,
    )
    # Path itself stays plain — long, scanned for the timestamp, not the focus.
    return (
        f"{_label('run-dir  ', color=color)} {run_dir}\n"
        f"{_label('final    ', color=color)} {final_styled}\n"
        f"{_label('reason   ', color=color)} {reason}\n"
    )


def _format_gauntlet_pane(verdict: dict, *, color: bool) -> str:
    g = verdict.get("gauntlet") or {}
    status = g.get("status") or "—"
    status_styled = _style(
        status, fg=_VERDICT_COLORS.get(status), bold=True, color=color,
    )
    summary = _wrap_indent(g.get("summary", ""), indent=10, width=72)
    reasoning = _wrap_indent(g.get("reasoning", ""), indent=10, width=72)
    sep = _style(
        "─── Gauntlet-Agent ───────────────────────────────",
        fg="bright_cyan", bold=True, color=color,
    )
    return (
        f"{sep}\n"
        f"{_label('status   ', color=color)} {status_styled}\n"
        f"{_label('summary  ', color=color)} {summary}\n"
        f"{_label('reasoning', color=color)} {reasoning}\n"
    )


def _format_checks_pane(verdict: dict, *, color: bool) -> str:
    checks = verdict.get("checks") or []
    sep = _style(
        "─── Deterministic checks ─────────────────────────",
        fg="bright_cyan", bold=True, color=color,
    )
    lines: list[str] = [sep]
    # Group: pre first, then post, preserving order within each phase.
    for phase in ("pre", "post"):
        # Phase prefix colored so a quick scan of the left edge tells you
        # which phase produced each check without reading the line.
        phase_styled = _style(f"{phase:<4}", fg="bright_blue", color=color)
        for c in checks:
            if c.get("phase") != phase:
                continue
            mark_char = "✓" if c["passed"] else "✗"
            # Glyph colors match the verdict palette (pass/fail tuples)
            # so the ✓/✗ pop the same way the verdict word does.
            mark = _style(
                mark_char,
                fg=_VERDICT_COLORS["pass" if c["passed"] else "fail"],
                bold=True, color=color,
            )
            # Negation modifier needs to jump out — `NOT tool-called X`
            # is semantically the opposite of `tool-called X`; if you skim
            # past the NOT you read the line backwards.
            negated = (
                _style("NOT ", fg="bright_magenta", bold=True, color=color)
                if c.get("negated") else ""
            )
            args = " ".join(c.get("args") or [])
            head = f"{phase_styled} {mark} {negated}{c['check']}"
            if args:
                head += f" {args}"
            lines.append(head)
            if not c["passed"] and c.get("detail"):
                # Failure detail tinted red and lead with ↳ so the eye
                # reads it as continuation of the line above (not a new
                # check missing its glyph).
                lines.append(_style(f"       ↳ {c['detail']}", fg="red", color=color))
    return "\n".join(lines) + "\n"


def _wrap_indent(text: str, *, indent: int, width: int) -> str:
    """Word-wrap `text` to `width` cols, indenting all but the first line."""
    if not text:
        return ""
    pad = " " * indent
    return textwrap.fill(text, width=width, subsequent_indent=pad)
