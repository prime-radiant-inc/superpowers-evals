"""click CLI: quorum run, list, new, check."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import cast

import click

from quorum.doctor import (
    DoctorPaths,
    DoctorStatus,
    TargetDoctorResult,
    is_doctor_command_error,
    run_all_doctors,
    run_target_doctor,
)
from quorum.managed_commands import run_managed_worker, status_summary, tail_job
from quorum.managed_state import discover_managed_paths, job_to_json, read_job
from quorum.run_all import run_batch
from quorum.runner import run_scenario
from quorum.runtime_env import (
    TargetProfile,
    TargetProfileError,
    assert_raw_command_allowed,
    build_managed_env,
    is_managed_host,
    is_trusted_managed_worker,
    load_target_profile,
)
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
_KIMI_PREFLIGHT_RUNTIME_KEYS = (
    "QUORUM_KIMI_PREFLIGHT_SENTINEL",
    "QUORUM_KIMI_PREFLIGHT_TOKEN",
)


def _managed_env_base_for_target(target: str | None) -> dict[str, str] | None:
    if not is_managed_host(os.environ):
        return None
    paths = discover_managed_paths(os.environ)
    profile = TargetProfile(target=target or "batch", path=None, env={})
    profile_root = os.environ.get("QUORUM_TARGET_PROFILE_ROOT")
    if target is not None and profile_root:
        profile = load_target_profile(Path(profile_root), target)
    runtime_vars = (
        {name: os.environ[name] for name in _KIMI_PREFLIGHT_RUNTIME_KEYS if os.environ.get(name)}
        if target == "kimi"
        else {}
    )
    env_base = build_managed_env(os.environ, paths, profile, runtime_vars=runtime_vars)
    if target is None and is_trusted_managed_worker(os.environ):
        env_base["QUORUM_MANAGED_WORKER_TOKEN"] = os.environ["QUORUM_MANAGED_WORKER_TOKEN"]
    return env_base


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
    try:
        assert_raw_command_allowed("run", os.environ)
    except PermissionError as e:
        click.echo(str(e), err=True)
        sys.exit(2)
    try:
        env_base = _managed_env_base_for_target(coding_agent)
    except TargetProfileError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(2)
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
        env_base=env_base,
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


@main.command("doctor")
@click.argument("target", required=False)
@click.option(
    "--all",
    "all_targets",
    is_flag=True,
    help="Check every configured Coding-Agent target.",
)
@click.option("--json", "mode_json", is_flag=True, help="Print stable JSON for automation.")
@click.option(
    "--scenarios-root",
    default=_DEFAULT_SCENARIOS_ROOT,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option(
    "--coding-agents-dir",
    default=_DEFAULT_CODING_AGENTS_DIR,
    type=click.Path(file_okay=False, path_type=Path),
)
def doctor(
    target: str | None,
    all_targets: bool,
    mode_json: bool,
    scenarios_root: Path,
    coding_agents_dir: Path,
) -> None:
    """Check whether Coding-Agent targets are runnable without launching live evals."""
    if all_targets and target is not None:
        click.echo("error: pass either TARGET or --all, not both", err=True)
        sys.exit(1)
    if not all_targets and target is None:
        click.echo("error: pass TARGET or --all", err=True)
        sys.exit(1)

    env = dict(os.environ)
    paths = DoctorPaths(
        coding_agents_dir=coding_agents_dir.resolve(),
        scenarios_root=scenarios_root.resolve(),
        profile_root=Path(env["QUORUM_TARGET_PROFILE_ROOT"]).resolve()
        if env.get("QUORUM_TARGET_PROFILE_ROOT")
        else None,
        managed_paths=discover_managed_paths(env),
    )
    if all_targets:
        results = run_all_doctors(paths, env)
        if mode_json:
            click.echo(
                json.dumps(
                    [result.to_dict() for result in results],
                    indent=2,
                    sort_keys=True,
                )
            )
        else:
            click.echo(_render_doctor_table(results), nl=False)
        sys.exit(_doctor_results_exit_code(results))

    assert target is not None
    result = run_target_doctor(target, paths, env)
    if mode_json:
        click.echo(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    else:
        click.echo(_render_doctor_table([result]), nl=False)
    sys.exit(_doctor_exit_code(result))


def _doctor_exit_code(result: TargetDoctorResult) -> int:
    if is_doctor_command_error(result):
        return 2
    status = result.status
    if status is DoctorStatus.READY:
        return 0
    if status is DoctorStatus.BLOCKED:
        return 3
    return 1


def _doctor_results_exit_code(results: list[TargetDoctorResult]) -> int:
    if any(is_doctor_command_error(result) for result in results):
        return 2
    if any(result.status is DoctorStatus.FAILED for result in results):
        return 1
    return 0


def _render_doctor_table(results: list[TargetDoctorResult]) -> str:
    lines = ["target  status   check                  message"]
    for result in results:
        first = True
        for check in result.checks:
            target_text = result.target if first else ""
            status_text = result.status.value if first else ""
            lines.append(
                f"{target_text:<7} {status_text:<8} {check.name:<22} {check.message}"
            )
            if check.remediation:
                lines.append(f"{'':<7} {'':<8} {'remediation':<22} {check.remediation}")
            first = False
    return "\n".join(lines) + "\n"


@main.command("status")
@click.argument("job_id", required=False)
@click.option("--json", "mode_json", is_flag=True, help="Print stable JSON for automation.")
@click.option("--limit", default=20, type=click.IntRange(min=1), help="Maximum jobs to show.")
@click.option(
    "--active-only",
    is_flag=True,
    help="Hide terminal jobs and show only planned/running jobs.",
)
def managed_status(
    job_id: str | None,
    mode_json: bool,
    limit: int,
    active_only: bool,
) -> None:
    """Show managed Quorum job status."""
    paths = discover_managed_paths(os.environ)
    if job_id is not None:
        try:
            job = read_job(paths, job_id)
        except (FileNotFoundError, ValueError) as e:
            click.echo(f"error: {e}", err=True)
            sys.exit(1)
        if mode_json:
            click.echo(json.dumps(job_to_json(job), indent=2, sort_keys=True))
        else:
            click.echo(_render_managed_job_detail(job_to_json(job)), nl=False)
        return

    jobs = status_summary(paths, limit=limit, include_finished=not active_only)
    payload = [job_to_json(job) for job in jobs]
    if mode_json:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    else:
        click.echo(_render_managed_status_table(payload), nl=False)


@main.command("tail")
@click.argument("job_id")
@click.option("--child", "child_id", help="Tail one child record's underlying log.")
@click.option("--follow", is_flag=True, help="Follow appended bytes until the job is terminal.")
def managed_tail(job_id: str, child_id: str | None, follow: bool) -> None:
    """Tail managed Quorum job events and logs."""
    paths = discover_managed_paths(os.environ)
    try:
        for line in tail_job(job_id, child_id=child_id, follow=follow, paths=paths):
            click.echo(line, nl=False)
    except (FileNotFoundError, ValueError) as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(1)


@main.command("managed-worker", hidden=True)
@click.argument("job_id")
def managed_worker(job_id: str) -> None:
    """Internal managed Quorum worker entrypoint."""
    if os.environ.get("QUORUM_MANAGED_WORKER") != "1":
        click.echo("error: managed-worker must be launched by a managed supervisor", err=True)
        sys.exit(2)
    paths = discover_managed_paths(os.environ)
    sys.exit(run_managed_worker(job_id, paths, dict(os.environ)))


def _render_managed_status_table(jobs: list[dict[str, object]]) -> str:
    if not jobs:
        return "no managed jobs\n"
    lines = ["job id                       state        updated               command"]
    for job in jobs:
        command = _render_managed_command(job)
        lines.append(
            f"{str(job['id']):<28} {str(job['state']):<12} "
            f"{str(job['updated_at']):<21} {command}"
        )
    return "\n".join(lines) + "\n"


def _render_managed_job_detail(job: dict[str, object]) -> str:
    lines = [
        f"id: {job['id']}",
        f"state: {job['state']}",
        f"created_at: {job['created_at']}",
        f"updated_at: {job['updated_at']}",
        "command: " + _render_managed_command(job),
    ]
    for field in ("owner", "started_at", "finished_at", "final_exit_code", "failure_reason"):
        value = job.get(field)
        if value is not None:
            lines.append(f"{field}: {value}")
    children = job.get("children")
    if isinstance(children, list):
        lines.append("children:")
        if children:
            for child in children:
                if isinstance(child, Mapping):
                    child_record = cast(Mapping[str, object], child)
                    child_id = child_record.get("id") or child_record.get("child_id") or "unknown"
                    child_state = child_record.get("state") or "unknown"
                    lines.append(f"  - {child_id}: {child_state}")
        else:
            lines.append("  (none)")
    return "\n".join(lines) + "\n"


def _render_managed_command(job: Mapping[str, object]) -> str:
    command = job.get("command")
    if isinstance(command, list):
        return " ".join(str(part) for part in command)
    return ""


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
    try:
        assert_raw_command_allowed("run-all", os.environ)
    except PermissionError as e:
        click.echo(str(e), err=True)
        sys.exit(2)
    try:
        env_base = _managed_env_base_for_target(None)
    except TargetProfileError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(2)
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
            env_base=env_base,
        )
    except ValueError as e:
        click.echo(f"error: {e}", err=True)
        sys.exit(1)
