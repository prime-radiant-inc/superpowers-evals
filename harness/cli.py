"""click CLI: harness run, list, new, check."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from harness.runner import run_scenario
from harness.scaffold import (
    ScaffoldError,
    check_scenario,
    fix_executable_bits,
    new_scenario,
)
from harness.show import ShowError, ShowMode, render, resolve_target

# TODO(phase-3): when drill is decommissioned, scenarios move to top-level
# scenarios/ and coding-agent-contexts/coding-agents/ may relocate.
_DEFAULT_SCENARIOS_ROOT = Path("harness/scenarios")
_DEFAULT_CODING_AGENTS_DIR = Path("harness/coding-agents")
_DEFAULT_CODING_AGENT_CONTEXTS_DIR = Path("harness/coding-agent-contexts")
_DEFAULT_OUT_ROOT = Path("results-harness")


@click.group()
def main() -> None:
    """Eval harness wrapping Gauntlet for skill-compliance benchmarks."""


@main.command("run")
@click.argument(
    "scenario_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option(
    "--coding-agent", required=True,
    help="Coding-Agent name (matches harness/coding-agents/<name>.yaml)",
)
@click.option(
    "--coding-agents-dir",
    default=_DEFAULT_CODING_AGENTS_DIR,
    type=click.Path(path_type=Path),
)
@click.option(
    "--coding-agent-contexts-dir",
    default=_DEFAULT_CODING_AGENT_CONTEXTS_DIR,
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
    coding_agent_contexts_dir: Path,
    out_root: Path,
) -> None:
    """Run one scenario against one Coding-Agent."""
    # Resolve every path to absolute at the CLI boundary. subprocess.run
    # with cwd= resolves relative executable paths against that cwd, not
    # the harness's cwd — relative paths here would silently misresolve
    # inside setup.sh invocations.
    scenario_dir = scenario_dir.resolve()
    coding_agents_dir = coding_agents_dir.resolve()
    coding_agent_contexts_dir = coding_agent_contexts_dir.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    out_root = out_root.resolve()
    run_dir, verdict = run_scenario(
        scenario_dir=scenario_dir,
        coding_agent=coding_agent,
        coding_agents_dir=coding_agents_dir,
        coding_agent_contexts_dir=coding_agent_contexts_dir,
        out_root=out_root,
    )
    # Same renderer as `harness show` — consistent UX whether you're
    # watching a fresh run or re-rendering an old one. verdict.json is
    # always persisted to run_dir/ so the JSON is one `harness show --json`
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
        d.name
        for d in scenarios_root.iterdir()
        if d.is_dir() and (d / "story.md").exists()
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
    "--fix", is_flag=True,
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
            d for d in scenarios_root.iterdir()
            if d.is_dir() and (d / "story.md").exists()
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
@click.option("-q", "--quiet", "mode_quiet", is_flag=True,
              help="Print only the two-line header (final + reason).")
@click.option("--json", "mode_json", is_flag=True,
              help="Print raw verdict.json after resolving target.")
@click.option("--no-color", "no_color", is_flag=True,
              help="Disable ANSI color (auto-disabled when stdout isn't a TTY).")
@click.option(
    "--results-root",
    default=_DEFAULT_OUT_ROOT,
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
    """Render a harness run's verdict.

    TARGET resolution (in order): omitted → newest run-dir under
    --results-root; path/to/run-dir/ → that dir; path/.../verdict.json →
    its parent; prefix → newest results-root/<prefix>-* by mtime.

    Always exits 0 on success — this is a display tool, not a verdict
    carrier. Use `harness run`'s exit code for pass/fail signal. Exits 1
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

    verdict_path = run_dir / "verdict.json"
    try:
        verdict = json.loads(verdict_path.read_text())
    except json.JSONDecodeError as e:
        click.echo(f"error: malformed verdict.json at {verdict_path}: {e}", err=True)
        sys.exit(2)

    color = not no_color and sys.stdout.isatty()
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
