"""click CLI: quorum run, list, new, check."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from quorum.economics import backfill_run_economics
from quorum.run_all import run_batch
from quorum.runner import run_scenario
from quorum.scaffold import (
    ScaffoldError,
    check_scenario,
    fix_executable_bits,
    new_scenario,
)
from quorum.show import (
    ShowError,
    ShowMode,
    is_batch_dir,
    render,
    render_batch,
    resolve_target,
)

_DEFAULT_SCENARIOS_ROOT = Path("scenarios")
_DEFAULT_CODING_AGENTS_DIR = Path("coding-agents")
_DEFAULT_OUT_ROOT = Path("results")


@click.group()
def main() -> None:
    """Eval runner (quorum) wrapping Gauntlet for skill-compliance benchmarks."""


@main.command("run")
@click.argument(
    "scenario_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option(
    "--coding-agent",
    required=True,
    help="Coding-Agent name (matches coding-agents/<name>.yaml)",
)
@click.option(
    "--coding-agents-dir",
    default=_DEFAULT_CODING_AGENTS_DIR,
    type=click.Path(path_type=Path),
)
@click.option(
    "--out-root",
    default=_DEFAULT_OUT_ROOT,
    type=click.Path(path_type=Path),
)
def run(
    scenario_dir: Path,
    coding_agent: str,
    coding_agents_dir: Path,
    out_root: Path,
) -> None:
    """Run one scenario against one Coding-Agent."""
    # Resolve every path to absolute at the CLI boundary. subprocess.run
    # with cwd= resolves relative executable paths against that cwd, not
    # quorum's cwd — relative paths here would silently misresolve
    # inside setup.sh invocations.
    scenario_dir = scenario_dir.resolve()
    coding_agents_dir = coding_agents_dir.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    out_root = out_root.resolve()
    run_dir, verdict = run_scenario(
        scenario_dir=scenario_dir,
        coding_agent=coding_agent,
        coding_agents_dir=coding_agents_dir,
        out_root=out_root,
    )
    # Machine-readable line for `quorum run-all` to parse. Printed
    # unconditionally — color/mode flags don't affect it.
    click.echo(f"run-id: {run_dir.name}")
    # Same renderer as `quorum show` — consistent UX whether you're
    # watching a fresh run or re-rendering an old one. verdict.json is
    # always persisted to run_dir/ so the JSON is one `quorum show --json`
    # or `cat verdict.json` away.
    color = sys.stdout.isatty()
    click.echo(render(verdict.to_dict(), run_dir, color=color, mode="full"), nl=False)
    sys.exit({"pass": 0, "fail": 1, "indeterminate": 2}[verdict.final])


@main.command("list")
@click.option(
    "--scenarios-root",
    default=_DEFAULT_SCENARIOS_ROOT,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
def list_scenarios(scenarios_root: Path) -> None:
    """List scenarios under scenarios-root."""
    found = sorted(
        d.name for d in scenarios_root.iterdir() if d.is_dir() and (d / "story.md").exists()
    )
    for name in found:
        click.echo(name)


@main.command("new")
@click.argument("name")
@click.option(
    "--scenarios-root",
    default=_DEFAULT_SCENARIOS_ROOT,
    type=click.Path(file_okay=False, path_type=Path),
)
def new(name: str, scenarios_root: Path) -> None:
    """Scaffold a new scenario skeleton (story.md, setup.sh, checks.sh)."""
    try:
        scenario_dir = new_scenario(scenarios_root, name)
    except ScaffoldError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(1)
    click.echo(f"created {scenario_dir}/")
    click.echo("  story.md, setup.sh, checks.sh — fill in the TODOs")


@main.command("check")
@click.argument("names", nargs=-1)
@click.option(
    "--fix",
    is_flag=True,
    help="chmod +x any scripts missing the executable bit",
)
@click.option(
    "--scenarios-root",
    default=_DEFAULT_SCENARIOS_ROOT,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
def check(names: tuple[str, ...], fix: bool, scenarios_root: Path) -> None:
    """Validate scenario structure (named scenarios, or all if none given)."""
    if names:
        targets = [scenarios_root / n for n in names]
        for target in targets:
            if not target.is_dir():
                click.echo(
                    f"error: no scenario {target.name!r} under {scenarios_root}",
                    err=True,
                )
                sys.exit(1)
    else:
        targets = sorted(
            d for d in scenarios_root.iterdir() if d.is_dir() and (d / "story.md").exists()
        )

    failed = 0
    for scenario_dir in targets:
        if fix:
            for fixed in fix_executable_bits(scenario_dir):
                click.echo(f"fixed +x {scenario_dir.name}/{fixed}")
        problems = check_scenario(scenario_dir)
        if problems:
            failed += 1
            click.echo(f"FAIL {scenario_dir.name}")
            for problem in problems:
                click.echo(f"  - {problem}")
        else:
            click.echo(f"ok   {scenario_dir.name}")

    if failed:
        click.echo(f"\n{failed} scenario(s) failed validation", err=True)
        sys.exit(1)


@main.command("show")
@click.argument("target", required=False)
@click.option(
    "-q",
    "--quiet",
    "mode_quiet",
    is_flag=True,
    help="Print only the two-line header (final + reason).",
)
@click.option(
    "--json", "mode_json", is_flag=True, help="Print raw verdict.json after resolving target."
)
@click.option(
    "--no-color",
    "no_color",
    is_flag=True,
    help="Disable ANSI color (auto-disabled when stdout isn't a TTY).",
)
@click.option(
    "--results-root",
    default=_DEFAULT_OUT_ROOT,
    type=click.Path(path_type=Path),
    help="Where to look for run-dirs (default: results/).",
)
def show(
    target: str | None,
    mode_quiet: bool,
    mode_json: bool,
    no_color: bool,
    results_root: Path,
) -> None:
    """Render a quorum run's verdict.

    TARGET resolution (in order): omitted → newest run-dir under
    --results-root; path/to/run-dir/ → that dir; path/.../verdict.json →
    its parent; prefix → newest results-root/<prefix>-* by mtime.

    Always exits 0 on success — this is a display tool, not a verdict
    carrier. Use `quorum run`'s exit code for pass/fail signal. Exits 1
    on resolution failure, 2 on malformed verdict.json.
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

    color = not no_color and sys.stdout.isatty()

    if is_batch_dir(run_dir):
        if mode_json:
            batch = json.loads((run_dir / "batch.json").read_text())
            results = [
                json.loads(line) for line in (run_dir / "results.jsonl").read_text().splitlines()
            ]
            click.echo(json.dumps({**batch, "results": results}, indent=2))
            return
        click.echo(
            render_batch(batch_dir=run_dir, results_root=results_root, color=color),
            nl=False,
        )
        return

    verdict_path = run_dir / "verdict.json"
    try:
        verdict = json.loads(verdict_path.read_text())
    except json.JSONDecodeError as e:
        click.echo(f"error: malformed verdict.json at {verdict_path}: {e}", err=True)
        sys.exit(2)

    try:
        click.echo(render(verdict, run_dir, color=color, mode=mode), nl=False)
    except (KeyError, TypeError) as e:
        # Schema-deviant verdict (parseable JSON, but missing/wrong fields).
        # Same exit as malformed JSON — the contract is "either valid against
        # schema v1 or exit 2"; the cause distinction is in the message.
        click.echo(
            f"error: verdict at {verdict_path} doesn't match schema v1: {e}",
            err=True,
        )
        sys.exit(2)


@main.command("backfill-economics")
@click.argument("target", required=False, type=click.Path(path_type=Path))
@click.option("--all", "do_all", is_flag=True, help="Backfill every run-dir under --results-root.")
@click.option(
    "--results-root",
    default=_DEFAULT_OUT_ROOT,
    type=click.Path(path_type=Path),
    help="Where to find run-dirs when using --all (default: results/).",
)
def backfill_economics(target: Path | None, do_all: bool, results_root: Path) -> None:
    """Recompute + inject `economics` into existing runs' verdict.json.

    Re-derives per-agent cost/timing from each run's preserved session logs
    (regenerating coding-agent-token-usage.json with the per-model breakdown)
    and adds an `economics` block to verdict.json. Use this to backfill runs
    that predate the economics feature.

    NOTE: this re-prices at CURRENT pricing tables — a deliberate re-pricing,
    not a faithful replay of run-time cost. Pass a run-dir, or --all.
    """
    if do_all == bool(target):
        click.echo("error: pass exactly one of a run-dir or --all", err=True)
        sys.exit(1)
    if do_all:
        run_dirs = sorted({p.parent for p in results_root.rglob("verdict.json")})
        if not run_dirs:
            click.echo(f"no run-dirs with verdict.json under {results_root}")
            return
    else:
        # The guard above guarantees target is set when do_all is False.
        assert target is not None
        run_dirs = [target]

    n_ok = 0
    for rd in run_dirs:
        status = backfill_run_economics(rd)
        if status == "backfilled":
            n_ok += 1
        click.echo(f"{status:<32} {rd}")
    if do_all:
        click.echo(f"backfilled {n_ok}/{len(run_dirs)}")


@main.command("run-all")
@click.option(
    "--coding-agents",
    "coding_agents_csv",
    default=None,
    help="CSV filter, e.g. claude,codex. Default: every YAML in coding-agents/.",
)
@click.option(
    "--scenarios",
    "scenarios_csv",
    default=None,
    help="CSV filter of scenario names, e.g. sdd-svelte-todo,spec-writing-blind-spot. "
    "Default: all. Use to resume a subset.",
)
@click.option(
    "--jobs",
    "jobs",
    default=1,
    type=click.IntRange(min=1),
    help="Worker pool size. Default 1. N>1 runs scenarios concurrently.",
)
@click.option(
    "--scenarios-root",
    default=_DEFAULT_SCENARIOS_ROOT,
    hidden=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option(
    "--coding-agents-dir",
    default=_DEFAULT_CODING_AGENTS_DIR,
    hidden=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option(
    "--out-root",
    default=_DEFAULT_OUT_ROOT,
    hidden=True,
    type=click.Path(path_type=Path),
)
@click.option(
    "--no-cursor",
    "no_cursor",
    is_flag=True,
    default=False,
    help="Disable in-place live display; print events as plain lines.",
)
@click.option(
    "--tier",
    type=click.Choice(["sentinel", "full", "adhoc"]),
    default=None,
    help="Run only scenarios in this tier. Default: all tiers.",
)
@click.option(
    "--include-drafts",
    "include_drafts",
    is_flag=True,
    default=False,
    help="Include status: draft scenarios (excluded by default).",
)
def run_all_cmd(
    coding_agents_csv: str | None,
    scenarios_csv: str | None,
    jobs: int,
    scenarios_root: Path,
    coding_agents_dir: Path,
    out_root: Path,
    no_cursor: bool,
    tier: str | None,
    include_drafts: bool,
) -> None:
    """Run every (scenario × Coding-Agent) pair, gated by `# coding-agents:`.

    Use --tier to restrict to a named tier (sentinel/full/adhoc).
    Use --include-drafts to include status: draft scenarios (excluded by default).
    """
    agent_filter = (
        [a.strip() for a in coding_agents_csv.split(",") if a.strip()]
        if coding_agents_csv
        else None
    )
    scenario_filter = (
        [s.strip() for s in scenarios_csv.split(",") if s.strip()] if scenarios_csv else None
    )
    out_root.mkdir(parents=True, exist_ok=True)
    try:
        run_batch(
            scenarios_root=scenarios_root.resolve(),
            coding_agents_dir=coding_agents_dir.resolve(),
            out_root=out_root.resolve(),
            jobs=jobs,
            agent_filter=agent_filter,
            scenario_filter=scenario_filter,
            use_cursor=not no_cursor,
            tier=tier,
            include_drafts=include_drafts,
        )
    except ValueError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(1)
