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

# TODO(phase-3): when drill is decommissioned, scenarios move to top-level
# scenarios/ and target_contexts/targets/ may relocate.
_DEFAULT_SCENARIOS_ROOT = Path("harness/scenarios")
_DEFAULT_TARGETS_DIR = Path("harness/targets")
_DEFAULT_CONTEXTS_DIR = Path("harness/target_contexts")
_DEFAULT_OUT_ROOT = Path("results-harness")
_DEFAULT_BIN_DIR = Path("bin")


@click.group()
def main() -> None:
    """Eval harness wrapping Gauntlet for skill-compliance benchmarks."""


@main.command("run")
@click.argument("scenario_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--target", required=True, help="Target name (matches harness/targets/<name>.yaml)")
@click.option("--targets-dir", default=_DEFAULT_TARGETS_DIR, type=click.Path(path_type=Path))
@click.option("--contexts-dir", default=_DEFAULT_CONTEXTS_DIR, type=click.Path(path_type=Path))
@click.option("--out-root", default=_DEFAULT_OUT_ROOT, type=click.Path(path_type=Path))
@click.option("--bin-dir", default=_DEFAULT_BIN_DIR, type=click.Path(path_type=Path))
def run(
    scenario_dir: Path,
    target: str,
    targets_dir: Path,
    contexts_dir: Path,
    out_root: Path,
    bin_dir: Path,
) -> None:
    """Run one scenario against one target."""
    # Resolve every path to absolute at the CLI boundary. subprocess.run
    # with cwd= resolves relative executable paths against that cwd, not
    # the harness's cwd — relative paths here would silently misresolve
    # inside setup.sh and assertion script invocations.
    scenario_dir = scenario_dir.resolve()
    targets_dir = targets_dir.resolve()
    contexts_dir = contexts_dir.resolve()
    bin_dir = bin_dir.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    out_root = out_root.resolve()
    verdict = run_scenario(
        scenario_dir=scenario_dir,
        target=target,
        targets_dir=targets_dir,
        contexts_dir=contexts_dir,
        out_root=out_root,
        bin_dir=bin_dir,
    )
    click.echo(json.dumps(verdict.to_dict(), indent=2))
    sys.exit(0 if verdict.final == "pass" else 1)


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
    """Scaffold a new scenario skeleton (story.md, setup.sh, preflight.sh)."""
    try:
        scenario_dir = new_scenario(scenarios_root, name)
    except ScaffoldError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(1)
    click.echo(f"created {scenario_dir}/")
    click.echo("  story.md, setup.sh, preflight.sh, assertions/ — fill in the TODOs")


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
