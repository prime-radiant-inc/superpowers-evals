"""harness run-all — batch driver over `harness run`.

Constructs the (scenario × Coding-Agent) matrix, pre-filters pairs by the
`# coding-agents:` directive in each scenario's checks.sh, runs the
runnable pairs concurrently as child `harness run` processes, and writes a
minimal batch index under results-harness/batches/<id>/.
"""

from __future__ import annotations

import json
import secrets
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from harness.checks import parse_coding_agents_directive


@dataclass(frozen=True)
class MatrixEntry:
    """One (scenario, agent) cell of the batch matrix.

    `skipped_reason` is None for runnable cells, "directive" for cells
    excluded by `# coding-agents:`.
    """

    scenario: str
    coding_agent: str
    scenario_dir: Path
    skipped_reason: str | None  # None | "directive"

    @property
    def runnable(self) -> bool:
        return self.skipped_reason is None


def _discover_scenarios(scenarios_root: Path) -> list[Path]:
    """Mirror `harness list`: scenario dirs are children with story.md."""
    return sorted(d for d in scenarios_root.iterdir() if d.is_dir() and (d / "story.md").exists())


def _discover_agents(coding_agents_dir: Path) -> list[str]:
    return sorted(p.stem for p in coding_agents_dir.glob("*.yaml"))


def build_matrix(
    *,
    scenarios_root: Path,
    coding_agents_dir: Path,
    agent_filter: list[str] | None = None,
) -> list[MatrixEntry]:
    """Compute the (scenario × agent) matrix.

    - Scenarios: every dir under `scenarios_root` with a `story.md`.
    - Agents: every `*.yaml` under `coding_agents_dir`, optionally
      filtered by `agent_filter` (CSV from --coding-agents).
    - For each pair, read the `# coding-agents:` directive in
      checks.sh; pairs excluded by the directive are returned with
      `skipped_reason="directive"`.

    Entries are sorted by (scenario, agent) for deterministic output.
    Raises ValueError if `agent_filter` names an unknown agent.
    """
    available = _discover_agents(coding_agents_dir)
    if agent_filter is not None:
        unknown = [a for a in agent_filter if a not in available]
        if unknown:
            raise ValueError(
                f"unknown coding-agent(s): {', '.join(unknown)} (available: {', '.join(available)})"
            )
        agents = [a for a in available if a in agent_filter]
    else:
        agents = available

    entries: list[MatrixEntry] = []
    for scenario_dir in _discover_scenarios(scenarios_root):
        directive = parse_coding_agents_directive(scenario_dir / "checks.sh")
        for agent in agents:
            skipped = "directive" if directive is not None and agent not in directive else None
            entries.append(
                MatrixEntry(
                    scenario=scenario_dir.name,
                    coding_agent=agent,
                    scenario_dir=scenario_dir,
                    skipped_reason=skipped,
                )
            )
    entries.sort(key=lambda e: (e.scenario, e.coding_agent))
    return entries


@dataclass(frozen=True)
class ChildResult:
    """Outcome of one child `harness run` invocation.

    run_id: the run-dir basename printed by the child, or None if the child
      crashed before allocating one.
    exit_code: child process exit code (0=pass, 1=fail, 2=indeterminate;
      anything else = abnormal exit).
    error: short human-readable description when something went wrong at the
      *process* level (couldn't parse run-id, signal kill, etc.). A `fail`
      verdict — exit 1 with a valid run-id — is NOT an error.
    """

    run_id: str | None
    exit_code: int
    error: str | None


_RUN_ID_PREFIX = "run-id: "


def _parse_run_id(stdout: str) -> str | None:
    for line in stdout.splitlines():
        if line.startswith(_RUN_ID_PREFIX):
            return line[len(_RUN_ID_PREFIX) :].strip()
    return None


def invoke_child(
    *,
    scenario_dir: Path,
    coding_agent: str,
    coding_agents_dir: Path,
    out_root: Path,
    timeout_seconds: float | None = None,
) -> ChildResult:
    """Run one `harness run` as a subprocess; capture its run-id line.

    `coding_agents_dir` and `out_root` are forwarded as explicit flags so
    the child doesn't rely on its own cwd-relative defaults.
    """
    cmd = [
        "uv",
        "run",
        "harness",
        "run",
        str(scenario_dir),
        "--coding-agent",
        coding_agent,
        "--coding-agents-dir",
        str(coding_agents_dir),
        "--out-root",
        str(out_root),
    ]
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return ChildResult(run_id=None, exit_code=-1, error="child timed out")

    run_id = _parse_run_id(completed.stdout)
    if run_id is None:
        return ChildResult(
            run_id=None,
            exit_code=completed.returncode,
            error=f"child did not print run-id (exit {completed.returncode})",
        )
    return ChildResult(run_id=run_id, exit_code=completed.returncode, error=None)


def _make_batch_id(now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    nonce = secrets.token_hex(2)  # 4 hex chars, matches per-run convention
    return f"{stamp}-{nonce}"


def allocate_batch_dir(*, out_root: Path) -> Path:
    """Create results-harness/batches/<id>/ and return its path."""
    batches_root = out_root / "batches"
    batches_root.mkdir(parents=True, exist_ok=True)
    for _ in range(100):
        candidate = batches_root / _make_batch_id()
        try:
            candidate.mkdir(exist_ok=False)
            return candidate
        except FileExistsError:
            continue  # nonce collision; try again
    raise RuntimeError(
        "could not allocate a unique batch id after 100 attempts "
        f"(clock or RNG malfunction?) in {batches_root}"
    )


def write_batch_header(
    *,
    batch_dir: Path,
    coding_agents: list[str],
    jobs: int,
    started_at: datetime,
) -> None:
    """Write batch.json at the start of a batch. `finished_at` is null."""
    data = {
        "schema_version": 1,
        "id": batch_dir.name,
        "started_at": started_at.isoformat(),
        "finished_at": None,
        "coding_agents": coding_agents,
        "jobs": jobs,
    }
    (batch_dir / "batch.json").write_text(json.dumps(data, indent=2))


def write_batch_footer(*, batch_dir: Path, finished_at: datetime) -> None:
    """Update batch.json with `finished_at` when the batch completes."""
    path = batch_dir / "batch.json"
    data = json.loads(path.read_text())
    data["finished_at"] = finished_at.isoformat()
    path.write_text(json.dumps(data, indent=2))


def append_result_record(
    *,
    batch_dir: Path,
    scenario: str,
    coding_agent: str,
    run_id: str | None,
    skipped: str | None,
) -> None:
    """Append one record to results.jsonl. Only the main thread should call."""
    rec: dict = {"scenario": scenario, "coding_agent": coding_agent, "run_id": run_id}
    if skipped is not None:
        rec["skipped"] = skipped
    with (batch_dir / "results.jsonl").open("a") as f:
        f.write(json.dumps(rec) + "\n")
