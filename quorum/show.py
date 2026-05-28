# quorum/show.py
"""quorum show — neutral renderer over verdict.json + siblings.

Spec: docs/superpowers/specs/2026-05-23-harness-triage-tooling-design.md.
Plan: docs/superpowers/plans/2026-05-23-harness-triage-tooling.md.

The renderer deliberately doesn't attribute failures to patterns — that
lives in the `triaging-a-failing-eval` skill, where a Bob (the LLM) does
the judgement Pattern 2 vs Pattern 4 requires.
"""
from __future__ import annotations

import io
import json as _json
import textwrap
from pathlib import Path
from typing import Literal

import click
from rich.console import Console

ShowMode = Literal["full", "quiet", "json"]


class ShowError(Exception):
    """Resolution or rendering failure; the CLI maps to exit 1 (resolution)
    or 2 (malformed verdict)."""


# ---------- resolver ----------------------------------------------------

def is_batch_dir(path: Path) -> bool:
    """A path is a batch dir if it contains batch.json."""
    return path.is_dir() and (path / "batch.json").exists()


def resolve_target(target: str | None, *, results_root: Path) -> Path:
    """Resolve `<target>` (per spec §5) to a run-dir or batch-dir Path.

    Order:
      1. None → newest run-dir under results_root (by verdict.json mtime).
      2a. Path that is a batch dir (contains batch.json) → that dir.
      2. Path that is a dir with verdict.json → that dir.
      3. Path that is a verdict.json file → its parent dir.
      4a. Batch ID under results_root/batches/<target>/ → that batch dir.
      4. Prefix match under results_root: `<target>-*` → newest match by mtime.
      5. Else → ShowError.

    Rules 1, 4, and 4a require results_root to exist; rules 2, 2a, 3 don't.
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

    # Batch dir (explicit path) — must precede the run-dir check, which
    # would otherwise raise "no verdict.json in <p>" for a batch path.
    if p.is_dir() and is_batch_dir(p):
        return p

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
    # Batch ID lookup: results_root/batches/<target>/.
    batch_candidate = results_root / "batches" / target
    if is_batch_dir(batch_candidate):
        return batch_candidate
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


# Matrix-view glyph colors. Same Dracula palette as _VERDICT_COLORS for
# pass/fail/indeterminate so the matrix matches `quorum show <run-id>`.
# Skipped and unknown use the label gray.
#
# Mirrors quorum/run_all.py:_STATUS_STYLES (to be added in v2 Task 3) —
# keep in sync if either changes.
_BATCH_GLYPH_COLORS = {
    "pass":          "rgb(80,250,123)",
    "fail":          "rgb(255,85,85)",
    "indeterminate": "rgb(241,250,140)",
    "skipped":       "rgb(122,130,148)",
    "unknown":       "rgb(122,130,148)",
}


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


def _fmt_ms(ms: int | None) -> str:
    if not ms:
        return "—"
    s = int(ms) // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return (f"{h}h {m:02d}m" if h else f"{m}m {sec:02d}s")


def _fmt_cost(c) -> str:
    return f"${c:.2f}" if isinstance(c, (int, float)) else "n/a"


def _fmt_tokens(n) -> str:
    if not isinstance(n, (int, float)) or n == 0:
        return "—"
    return f"{n/1_000_000:.1f}M" if n >= 1_000_000 else f"{n/1_000:.0f}K"


def _agent_row(label, block, *, color):
    if not block:
        return f"  {label:<10} {'—':>10} {'—':>9} {'—':>9}"
    dur = _fmt_ms(block.get("duration_ms"))
    tok = _fmt_tokens((block.get('tokens') or {}).get('total'))
    cost = _fmt_cost(block.get("est_cost_usd"))
    if block.get("est_cost_usd") is None and block.get("model"):
        cost = f"n/a ({block['model']})"
    return f"  {label:<10} {dur:>10} {tok:>9} {cost:>9}"


def _short_model(model_id: str | None) -> str:
    """Friendly short label for a model id (opus/sonnet/haiku/gpt), else raw."""
    if not isinstance(model_id, str):
        return "—"
    m = model_id.lower()
    for fam in ("opus", "sonnet", "haiku"):
        if fam in m:
            return fam
    if "gpt" in m or "codex" in m:
        return "gpt"
    return model_id


def _model_subrow(entry: dict) -> str:
    """Indented per-model line under the Coding row."""
    label = "  " + _short_model(entry.get("model"))
    tok = _fmt_tokens((entry.get("tokens") or {}).get("total"))
    cost = _fmt_cost(entry.get("est_cost_usd"))
    if entry.get("est_cost_usd") is None and entry.get("model"):
        cost = "n/a"
    return f"  {label:<10} {'':>10} {tok:>9} {cost:>9}"


def _format_economics_pane(verdict: dict, *, color: bool) -> str:
    econ = verdict.get("economics")
    if not econ:
        return ""
    sep = _style("─── Economics ────────────────────────────────────",
                 fg="bright_cyan", bold=True, color=color)
    header = f"  {'':<10} {'duration':>10} {'tokens':>9} {'est cost':>9}"
    rows = [_agent_row("Gauntlet", econ.get("gauntlet"), color=color)]
    coding = econ.get("coding_agent")
    rows.append(_agent_row("Coding", coding, color=color))
    # Per-model sub-rows under Coding (PRI-1872): a coding run is multi-model.
    for entry in (coding or {}).get("models") or []:
        rows.append(_model_subrow(entry))
    total = econ.get("total_est_cost_usd")
    total_str = _fmt_cost(total) if total is not None else ("partial" if econ.get("partial") else "—")
    rows.append(f"  {'total':<10} {'':>10} {'':>9} {total_str:>9}")
    return "\n".join([sep, header, *rows]) + "\n"


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
        _format_economics_pane(verdict, color=color),
        _FOOTER + "\n",
    ]
    return "\n".join(p for p in parts if p)


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


# ---------- batch matrix renderer --------------------------------------

_GLYPHS = {
    "pass":          ("✓", "pass"),
    "fail":          ("✗", "fail"),
    "indeterminate": ("⊘", "indet"),
    "skipped":       ("—", "skip"),
    "unknown":       ("?", "?"),
}


def render_batch(
    *,
    batch_dir: Path,
    results_root: Path,
    color: bool,
) -> str:
    """Render a batch as a scenario × agent matrix table."""
    batch = _json.loads((batch_dir / "batch.json").read_text())
    rows = [
        _json.loads(line)
        for line in (batch_dir / "results.jsonl").read_text().splitlines()
    ]

    agents = batch["coding_agents"]
    scenarios = sorted({r["scenario"] for r in rows})

    # Store verdict keys (not pre-rendered tuples) so styling can be
    # applied at render time per cell.
    cell_verdicts: dict[tuple[str, str], str] = {}
    counts = {"pass": 0, "fail": 0, "indeterminate": 0, "skipped": 0, "unknown": 0}
    for r in rows:
        key = (r["scenario"], r["coding_agent"])
        if r.get("skipped"):
            cell_verdicts[key] = "skipped"
            counts["skipped"] += 1
            continue
        run_id = r.get("run_id")
        verdict_path = results_root / run_id / "verdict.json" if run_id else None
        if not verdict_path or not verdict_path.exists():
            cell_verdicts[key] = "unknown"
            counts["unknown"] += 1
            continue
        try:
            v = _json.loads(verdict_path.read_text())
        except _json.JSONDecodeError:
            cell_verdicts[key] = "unknown"
            counts["unknown"] += 1
            continue
        final = v.get("final", "unknown")
        if final not in _GLYPHS:
            final = "unknown"
        cell_verdicts[key] = final
        counts[final] = counts.get(final, 0) + 1

    # Column widths grow to fit content.
    scen_w = max((len(s) for s in scenarios), default=8)
    scen_w = max(scen_w, len("scenario"))
    cell_w = max([len(a) for a in agents] + [len("⊘ indet")])  # widest header or glyph

    sep = "|" + "-" * (scen_w + 2) + "|" + "|".join("-" * (cell_w + 2) for _ in agents) + "|"
    header = (
        "| " + "scenario".ljust(scen_w) + " | "
        + " | ".join(a.ljust(cell_w) for a in agents) + " |"
    )

    buf = io.StringIO()
    console = Console(
        file=buf,
        force_terminal=color,
        no_color=not color,
        width=200,
    )

    banner = (
        f"batch {batch['id']} · started {batch['started_at']}"
        + (f" · finished {batch['finished_at']}" if batch.get('finished_at') else "")
    )
    console.print(banner, highlight=False)
    console.print("", highlight=False)
    console.print(header, highlight=False)
    console.print(sep, highlight=False)
    for s in scenarios:
        row_cells = []
        for a in agents:
            verdict = cell_verdicts.get((s, a), "unknown")
            glyph, label = _GLYPHS[verdict]
            text = f"{glyph} {label}".ljust(cell_w)
            color_name = _BATCH_GLYPH_COLORS[verdict]
            row_cells.append(f"[{color_name}]{text}[/]")
        console.print(
            "| " + s.ljust(scen_w) + " | " + " | ".join(row_cells) + " |",
            highlight=False,
        )
    console.print("", highlight=False)
    console.print(
        "Legend: ✓ pass   ✗ fail   ⊘ indeterminate   "
        "— skipped (directive)   ? no verdict",
        highlight=False,
    )
    tally = (
        f"{counts['pass']} ✓ · {counts['fail']} ✗ · "
        f"{counts['indeterminate']} ⊘ · {counts['skipped']} —"
        + (f" · {counts['unknown']} ?" if counts['unknown'] else "")
    )
    console.print(tally, highlight=False)
    return buf.getvalue()
