"""quorum run-all — batch driver over `quorum run`.

Constructs the (scenario × Coding-Agent) matrix, pre-filters pairs by the
`# coding-agents:` directive in each scenario's checks.sh, runs the
runnable pairs concurrently as child `quorum run` processes, and writes a
minimal batch index under results/batches/<id>/.
"""

from __future__ import annotations

import json
import secrets
import subprocess
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from quorum.checks import parse_coding_agents_directive
from quorum.show import _fmt_cost


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
    """Mirror `quorum list`: scenario dirs are children with story.md."""
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
    """Outcome of one child `quorum run` invocation.

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
    """Run one `quorum run` as a subprocess; capture its run-id line.

    `coding_agents_dir` and `out_root` are forwarded as explicit flags so
    the child doesn't rely on its own cwd-relative defaults.
    """
    cmd = [
        "uv",
        "run",
        "quorum",
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
    return f"batch-{stamp}-{nonce}"


def allocate_batch_dir(*, out_root: Path) -> Path:
    """Create results/batches/<id>/ and return its path."""
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


class BatchProgress:
    """Owns rendering state for a batch.

    Thread-safe for the limited mutations workers make (`started` /
    `finished`); reads happen on the main thread (via `__rich__` from the
    Live refresh tick, and via `snapshot()` at end of batch for the
    summary).
    """

    def __init__(
        self,
        *,
        batch_id: str,
        total: int,
        jobs: int,
        skipped: int,
        idx_w: int = 1,
        agent_w: int = 1,
        scn_w: int = 1,
    ) -> None:
        """`skipped` is known upfront (set from len(skipped_indexed)).

        All further mutations come from worker threads via `started` /
        `finished` — there's no runtime `skipped()` mutator, which keeps
        the invariant that `_counts['skipped']` never changes during the
        Live phase.
        """
        self.batch_id = batch_id
        self.total = total
        self.jobs = jobs
        self.idx_w = idx_w
        self.agent_w = agent_w
        self.scn_w = scn_w
        self._lock = threading.Lock()
        self._in_flight: dict[int, tuple[MatrixEntry, float]] = {}
        self._counts: dict[str, int] = {
            "pass": 0,
            "fail": 0,
            "indeterminate": 0,
            "unknown": 0,
            "skipped": skipped,
        }
        self._started = time.monotonic()

    def started(self, idx: int, entry: MatrixEntry) -> None:
        with self._lock:
            self._in_flight[idx] = (entry, time.monotonic())

    def finished(self, idx: int, final: str) -> None:
        with self._lock:
            self._in_flight.pop(idx, None)
            self._counts[final] = self._counts.get(final, 0) + 1

    def snapshot(
        self,
    ) -> tuple[list[tuple[int, MatrixEntry, float]], dict[str, int]]:
        with self._lock:
            in_flight = [
                (idx, entry, time.monotonic() - t0)
                for idx, (entry, t0) in sorted(self._in_flight.items())
            ]
            counts = dict(self._counts)
        return in_flight, counts

    def __rich__(self) -> Group:
        """Called by rich.live.Live on each refresh tick."""
        in_flight, counts = self.snapshot()
        rows = []
        for idx, entry, elapsed in in_flight:
            scn = _truncate(entry.scenario, self.scn_w)
            rows.append(
                f"  [{idx:0{self.idx_w}d}/{self.total}]  "
                f"{scn:<{self.scn_w}}  {entry.coding_agent:<{self.agent_w}}"
                f"  {_fmt_duration(elapsed):>{_DUR_COL_W}}"
            )
        panel_body = "\n".join(rows) if rows else "(idle)"
        panel = Panel(
            panel_body,
            title=f"in flight ({len(in_flight)}/{self.jobs})",
            title_align="left",
        )
        done = (
            counts["pass"]
            + counts["fail"]
            + counts["indeterminate"]
            + counts["unknown"]
        )
        wall = _fmt_duration(time.monotonic() - self._started)
        footer_text = (
            f"progress {done + counts['skipped']}/{self.total}"
            f" · ✓{counts['pass']} ✗{counts['fail']} ⊘{counts['indeterminate']}"
            f" —{counts['skipped']}"
        )
        if counts["unknown"]:
            footer_text += f" ?{counts['unknown']}"
        footer_text += f" · wall {wall}"
        footer = Text(footer_text)
        return Group(panel, footer)


# Status -> Rich style string. Lines build a `Text` object via
# `Text.assemble(...)`, passing `(label, _STATUS_STYLES[final])` tuples for
# the styled segments. The surrounding `[N/M]` prefix stays as a plain
# segment so Rich's markup parser doesn't try to interpret it. Console
# decides whether to emit ANSI based on TTY detection.
#
# Same palette as quorum/show.py:_BATCH_GLYPH_COLORS — keep in sync.
_STATUS_STYLES = {
    "pass":          "rgb(80,250,123)",
    "fail":          "rgb(255,85,85)",
    "indeterminate": "rgb(241,250,140)",
    "skipped":       "rgb(122,130,148)",
    "unknown":       "rgb(122,130,148)",
}


def run_batch(
    *,
    scenarios_root: Path,
    coding_agents_dir: Path,
    out_root: Path,
    jobs: int,
    agent_filter: list[str] | None,
    invoke: Callable[..., ChildResult] | None = None,
    stream: TextIO | None = None,
    use_cursor: bool = True,
) -> Path:
    """Run the full batch. Returns the batch dir path.

    `use_cursor=True` (default) uses a Rich `Live` in-flight panel on a
    TTY; falls back to plain append-only output when stdout is not a TTY
    or `use_cursor=False`.
    """
    if jobs < 1:
        raise ValueError(f"jobs must be >= 1, got {jobs}")
    # Late-bind to invoke_child so monkeypatch.setattr(
    # "quorum.run_all.invoke_child", ...) works without needing to also
    # pass `invoke=` explicitly.
    invoke = invoke or invoke_child

    entries = build_matrix(
        scenarios_root=scenarios_root,
        coding_agents_dir=coding_agents_dir,
        agent_filter=agent_filter,
    )
    batch_dir = allocate_batch_dir(out_root=out_root)
    started_at = datetime.now(UTC)
    indexed = list(enumerate(entries, 1))
    total = len(entries)
    runnable_indexed = [(idx, e) for idx, e in indexed if e.runnable]
    skipped_indexed = [(idx, e) for idx, e in indexed if not e.runnable]
    agents_in_batch = sorted({e.coding_agent for e in entries})

    # Tabular layout: column widths derived from this batch's data, so
    # short batches don't pay for wide padding.
    idx_w = len(str(total))
    agent_w = max((len(a) for a in agents_in_batch), default=1)
    scn_w = min(_SCN_COL_MAX, max((len(e.scenario) for e in entries), default=1))

    write_batch_header(
        batch_dir=batch_dir,
        coding_agents=agents_in_batch,
        jobs=jobs,
        started_at=started_at,
    )

    # Construct Console with force_terminal=None if stream is None so the
    # default stdout path picks up real TTY detection; if the caller passes
    # a stream (test harnesses, pipes), force non-terminal so no ANSI
    # leaks into captured output.
    console = Console(
        file=stream,
        force_terminal=None if stream is None else False,
    )
    use_live = use_cursor and console.is_terminal
    progress = BatchProgress(
        batch_id=batch_dir.name,
        total=total,
        jobs=jobs,
        skipped=len(skipped_indexed),
        idx_w=idx_w,
        agent_w=agent_w,
        scn_w=scn_w,
    )

    # Header banner.
    console.print(
        f"batch {batch_dir.name} · {total} pairs "
        f"({len(runnable_indexed)} runnable, {len(skipped_indexed)} skipped by directive) "
        f"· --jobs {jobs}",
        markup=False,
        highlight=False,
    )

    # Skips render first, synchronously. Use Text.assemble() not f-strings:
    # the literal `[N/M]` prefix would otherwise be interpreted as Rich
    # markup. The styled tail is applied via a (text, style) tuple.
    for idx, entry in skipped_indexed:
        directive = parse_coding_agents_directive(entry.scenario_dir / "checks.sh") or []
        scn = _truncate(entry.scenario, scn_w)
        line = Text.assemble(
            f"[{idx:0{idx_w}d}/{total}] {'skip':<{_STATE_COL_W}}  "
            f"{scn:<{scn_w}}  {entry.coding_agent:<{agent_w}}  ",
            (_GLYPH_SKIP, _STATUS_STYLES["skipped"]),
            f"  {'':<{_DUR_COL_W}}  (requires {', '.join(directive)})",
        )
        console.print(line, markup=False, highlight=False)
        append_result_record(
            batch_dir=batch_dir,
            scenario=entry.scenario,
            coding_agent=entry.coding_agent,
            run_id=None,
            skipped="directive",
        )

    # Lock guards both `console.print` from workers (plain mode) AND
    # results.jsonl writes (which happen on the main futures-completion
    # thread, but a lock is cheap insurance).
    print_lock = threading.Lock()
    # Mutable cell so the nested _drain closure can accumulate the batch cost.
    batch_cost_total = [0.0]

    def _worker(
        idx: int, entry: MatrixEntry
    ) -> tuple[int, MatrixEntry, ChildResult, float]:
        progress.started(idx, entry)
        if not use_live:
            with print_lock:
                scn = _truncate(entry.scenario, scn_w)
                console.print(
                    Text(
                        f"[{idx:0{idx_w}d}/{total}] {'start':<{_STATE_COL_W}}  "
                        f"{scn:<{scn_w}}  {entry.coding_agent:<{agent_w}}"
                    ),
                    markup=False,
                    highlight=False,
                )
        t0 = time.monotonic()
        result = invoke(
            scenario_dir=entry.scenario_dir,
            coding_agent=entry.coding_agent,
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
        )
        return idx, entry, result, time.monotonic() - t0

    def _drain(pool: ThreadPoolExecutor) -> None:
        # All console.print calls inside Live MUST use this Console
        # (already passed as console=console to Live above) — output
        # corrupts if a worker constructs its own Console or calls plain
        # print().
        futures = [pool.submit(_worker, idx, e) for idx, e in runnable_indexed]
        for fut in as_completed(futures):
            idx, entry, result, elapsed = fut.result()
            final = _final_status_for_result(result, out_root)
            progress.finished(idx, final)
            glyph = _GLYPH_FOR_FINAL.get(final, "?")
            scn = _truncate(entry.scenario, scn_w)
            duration = _fmt_duration(elapsed)
            cost = _run_cost(out_root / result.run_id) if result.run_id else None
            cost_cell = _fmt_cost(cost) if cost is not None else "—"
            # Use Text.assemble() with explicit segments so the literal
            # `[N/M]` prefix is not parsed as Rich markup; the styled
            # glyph is applied via the (text, style) tuple form.
            line = Text.assemble(
                f"[{idx:0{idx_w}d}/{total}] {'done':<{_STATE_COL_W}}  "
                f"{scn:<{scn_w}}  {entry.coding_agent:<{agent_w}}  ",
                (glyph, _STATUS_STYLES.get(final, "")),
                f"  {duration:>{_DUR_COL_W}}  {cost_cell:>{_COST_COL_W}}",
            )
            with print_lock:
                if cost is not None:
                    batch_cost_total[0] += cost
                console.print(line, markup=False, highlight=False)
                append_result_record(
                    batch_dir=batch_dir,
                    scenario=entry.scenario,
                    coding_agent=entry.coding_agent,
                    run_id=result.run_id,
                    skipped=None,
                )

    if use_live:
        # transient=True so the in-flight panel disappears when Live
        # exits; otherwise an obsolete `(idle)` panel lingers between the
        # last `done` event and the `batch done` summary line.
        with (
            Live(
                progress,
                refresh_per_second=4,
                console=console,
                transient=True,
            ),
            ThreadPoolExecutor(max_workers=jobs) as pool,
        ):
            _drain(pool)
    else:
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            _drain(pool)

    finished_at = datetime.now(UTC)
    write_batch_footer(batch_dir=batch_dir, finished_at=finished_at)

    _, counts = progress.snapshot()
    summary_line = (
        f"batch done · {counts['pass']} ✓ · {counts['fail']} ✗ · "
        f"{counts['indeterminate']} ⊘ · {counts['skipped']} —"
    )
    if counts["unknown"]:
        summary_line += f" · {counts['unknown']} ?"
    summary_line += (
        f" · wall {_fmt_duration((finished_at - started_at).total_seconds())}"
    )
    if batch_cost_total[0] > 0:
        summary_line += f" · cost ${batch_cost_total[0]:.2f}"
    console.print(summary_line, markup=False, highlight=False)
    try:
        artifacts_path = batch_dir.relative_to(Path.cwd())
    except ValueError:
        artifacts_path = batch_dir
    console.print(f"artifacts: {artifacts_path}", markup=False, highlight=False)
    return batch_dir


def _fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    m, s = divmod(seconds, 60)
    return f"{m}m{s:02d}s"


def _read_verdict(run_dir: Path) -> dict | None:
    """Read verdict.json for a run-id; return None if missing/unparseable."""
    p = run_dir / "verdict.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def _run_cost(run_dir: Path) -> float | None:
    """Frozen total est cost for a run from its verdict.json economics block."""
    verdict = _read_verdict(run_dir)
    if not verdict:
        return None
    return (verdict.get("economics") or {}).get("total_est_cost_usd")


_GLYPH_FOR_FINAL = {
    "pass":          "✓",
    "fail":          "✗",
    "indeterminate": "⊘",
    "unknown":       "?",
}
_GLYPH_SKIP = "—"

# Cap scenario-name column at 44 — fits every name in the current scenarios
# tree (longest is 44) and bounds the worst-case if someone adds a runaway.
_SCN_COL_MAX = 44
# State column fits "start" (5), the longest of {start, done, skip}.
_STATE_COL_W = 5
# Duration column: longest is "10m00s" (6) at the current max_time of 10m.
_DUR_COL_W = 6
# Cost column: a frozen "$NN.NN" total est cost, or "—" when absent.
_COST_COL_W = 7


def _truncate(s: str, w: int) -> str:
    return s if len(s) <= w else s[: w - 1] + "…"


def _final_status_for_result(result: ChildResult, out_root: Path) -> str:
    """Map a child outcome to one of pass / fail / indeterminate / unknown."""
    if result.error is not None or result.run_id is None:
        return "unknown"
    verdict = _read_verdict(out_root / result.run_id)
    if verdict is None:
        return "unknown"
    final = verdict.get("final", "unknown")
    return final if final in ("pass", "fail", "indeterminate") else "unknown"
