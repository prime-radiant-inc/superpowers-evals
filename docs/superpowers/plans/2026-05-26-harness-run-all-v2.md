# Harness `run-all` v2 UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the v2 addendum from `docs/superpowers/specs/2026-05-26-harness-run-all-design.md` — batch-ID prefix, skip-as-event format, color, and a Rich-driven live display — to the v1 implementation that just landed on this branch.

**Architecture:** Three task rounds. (1) Tiny change to `_make_batch_id` and its test. (2) Add `rich` as a dependency and colorize `render_batch` using Rich's `Console`. (3) Refactor `run_batch` to use `rich.live.Live` with a pinned in-flight panel plus a scrolling completion log; in the same refactor, switch the live output to the event-shaped format (skips render with `[idx/total] skip` lines and counted against the full matrix total).

**Tech Stack:** Python 3.11+, `rich`, `click`, `concurrent.futures.ThreadPoolExecutor`, `pytest`.

**Spec:** [docs/superpowers/specs/2026-05-26-harness-run-all-design.md](../specs/2026-05-26-harness-run-all-design.md) (Addendum at bottom).

---

## File structure

**Modify:**
- `harness/run_all.py` — `_make_batch_id` prefix; orchestrator refactor to Rich; new `BatchProgress` helper class.
- `harness/show.py` — `render_batch` wires its `color` parameter through a `Console`.
- `pyproject.toml` — add `rich` dependency.
- `tests/harness/test_run_all.py` — update for new batch-ID format, total denominator, event shape.
- `tests/harness/test_show.py` — verify colored output (presence of ANSI codes when color=True).

**No changes to:**
- `harness/cli.py` (the `run-all` command still calls `run_batch(...)` the same way).
- `harness/checks.py`, `harness/runner.py`, scenario layouts.
- The `results.jsonl` / `batch.json` schema (apart from `id` values picking up the new prefix).

---

## Task 1: Batch ID gets a `batch-` prefix

**Why first:** Smallest change, fully independent. Lets us verify the test bus still works against the existing module before touching the orchestrator.

**Files:**
- Modify: `harness/run_all.py` (`_make_batch_id`)
- Test: `tests/harness/test_run_all.py` (regex assertion)

- [ ] **Step 1: Update the failing test to match the new ID shape**

In `tests/harness/test_run_all.py`, the existing `test_allocate_batch_dir_creates_unique_dir` asserts:

```python
assert re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{4}", batch_dir.name), batch_dir.name
```

Change it to:

```python
assert re.fullmatch(r"batch-\d{8}T\d{6}Z-[0-9a-f]{4}", batch_dir.name), batch_dir.name
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/harness/test_run_all.py::test_allocate_batch_dir_creates_unique_dir -x -q`
Expected: FAIL — the current ID is `20260526T180000Z-abcd`, missing the `batch-` prefix.

- [ ] **Step 3: Add the prefix in `_make_batch_id`**

In `harness/run_all.py`, find `_make_batch_id`:

```python
def _make_batch_id(now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    nonce = secrets.token_hex(2)  # 4 hex chars, matches per-run convention
    return f"{stamp}-{nonce}"
```

Change the return to:

```python
    return f"batch-{stamp}-{nonce}"
```

Update the docstring comment if there's one referencing the old shape.

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/harness/test_run_all.py::test_allocate_batch_dir_creates_unique_dir -x -q`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest -x -q --ignore=tests/harness/test_run_all_e2e.py`
Expected: PASS — 430 tests.

- [ ] **Step 6: Commit**

```bash
git add harness/run_all.py tests/harness/test_run_all.py
git commit -m "harness: prefix batch IDs with \`batch-\` for copy-paste affordance

Co-Authored-By: YourBobName@<first8hex> (Sonnet 4.6)"
```

---

## Task 2: Add `rich` dep + colorize `render_batch`

**Why next:** Establishes the Rich dependency and the styling palette before the bigger live-display refactor. `render_batch` is the easier of the two consumers — pure-function, single test entry point.

**Files:**
- Modify: `pyproject.toml`
- Modify: `harness/show.py` (`render_batch`)
- Test: `tests/harness/test_show.py`

- [ ] **Step 1: Add `rich` to project dependencies**

In `pyproject.toml`, add `"rich>=13.7"` to the main `dependencies` list (not `dev`). Then run:

```
uv sync
```

Expected: installs rich and its deps. No errors.

- [ ] **Step 2: Write the failing color test**

Append to `tests/harness/test_show.py`:

```python
def test_render_batch_emits_ansi_when_color_true(tmp_path):
    """When color=True, glyphs are wrapped in ANSI sequences."""
    batch_dir = _seed_batch(tmp_path, agents=["claude"], rows=[
        {"scenario": "foo", "coding_agent": "claude",
         "run_id": "foo-claude-x", "_verdict": "pass"},
    ])

    out = render_batch(
        batch_dir=batch_dir,
        results_root=tmp_path / "results-harness",
        color=True,
    )

    # The "pass" glyph should be wrapped in an ANSI sequence (\x1b[).
    assert "\x1b[" in out
    # Plain text (color=False) should NOT contain ANSI sequences.
    out_plain = render_batch(
        batch_dir=batch_dir,
        results_root=tmp_path / "results-harness",
        color=False,
    )
    assert "\x1b[" not in out_plain
```

- [ ] **Step 3: Run to verify it fails**

Run: `uv run pytest tests/harness/test_show.py::test_render_batch_emits_ansi_when_color_true -x -q`
Expected: FAIL — `color=True` currently does nothing (`_ = color`).

- [ ] **Step 4: Wire color through `render_batch`**

Import Rich at the top of `harness/show.py`:

```python
from rich.console import Console
```

Define a palette near the existing color tables (`_VERDICT_COLORS` is at `show.py:99` — slot the new map nearby):

```python
# Matrix-view glyph colors. Same Dracula palette as _VERDICT_COLORS for
# pass/fail/indeterminate so the matrix matches `harness show <run-id>`.
# Skipped and unknown use the label gray.
#
# Mirrors harness/run_all.py:_STATUS_STYLES — keep in sync.
_BATCH_GLYPH_COLORS = {
    "pass":          "rgb(80,250,123)",
    "fail":          "rgb(255,85,85)",
    "indeterminate": "rgb(241,250,140)",
    "skipped":       "rgb(122,130,148)",
    "unknown":       "rgb(122,130,148)",
}
```

Replace the `_ = color` line in `render_batch` and the cell-construction loop. Specifically, the existing block:

```python
    cells: dict[tuple[str, str], tuple[str, str]] = {}
    counts = {...}
    for r in rows:
        ...
        cells[key] = _GLYPHS["skipped"]
        ...
        cells[key] = _GLYPHS.get(final, _GLYPHS["unknown"])
        ...
```

becomes (storing the verdict key instead of the pre-rendered `_GLYPHS` tuple, so we can style at render time):

```python
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
```

Then use a `Console` to render the cell strings with optional styling. The cleanest way is to build the output as plain text and use a Rich `Console(no_color=not color)` to control whether ANSI escapes are emitted:

```python
    import io
    buf = io.StringIO()
    console = Console(
        file=buf,
        force_terminal=color,  # emit ANSI even though buf isn't a TTY
        no_color=not color,
        width=200,             # don't word-wrap our matrix
    )
    # ... build the lines using f-strings with Rich [color]…[/] markup ...
    for s in scenarios:
        row_cells = []
        for a in agents:
            verdict = cell_verdicts.get((s, a), "unknown")
            glyph, label = _GLYPHS[verdict]
            text = f"{glyph} {label}".ljust(cell_w)
            color_name = _BATCH_GLYPH_COLORS[verdict]
            row_cells.append(f"[{color_name}]{text}[/]")
        console.print("| " + s.ljust(scen_w) + " | " + " | ".join(row_cells) + " |", highlight=False)
    # ... legend, tally line ...
    return buf.getvalue()
```

Pre-existing pure-string parts of the function (header line, separator, legend, tally) should stay as `console.print(...)` calls too so the whole output goes through one writer. The non-styled lines call `console.print("...", highlight=False)`.

NOTE: Rich's `[color]...[/]` markup applies only when `no_color=False`; when `no_color=True`, the markup is stripped and the raw text is emitted. That's exactly what we want.

- [ ] **Step 5: Run all show tests**

Run: `uv run pytest tests/harness/test_show.py -x -q`
Expected: PASS — the original `render_batch` tests still pass (they check substring presence, which is unaffected by surrounding ANSI), plus the new color test passes.

- [ ] **Step 6: Run the full suite**

Run: `uv run pytest -x -q --ignore=tests/harness/test_run_all_e2e.py`
Expected: PASS.

- [ ] **Step 7: Manual smoke**

```
uv run harness show <some-batch-id>
```

Expected: matrix renders with colored verdict cells when stdout is a TTY; plain text when piped.

- [ ] **Step 8: Commit**

```bash
git add pyproject.toml uv.lock harness/show.py tests/harness/test_show.py
git commit -m "harness: colorize \`harness show <batch-id>\` matrix view (Dracula palette)

Adds rich as a dependency. Matrix glyphs now use the same Dracula
palette as \`harness show <run-id>\`. ANSI is emitted only when color=True;
color=False output is unchanged byte-for-byte from v1.

Co-Authored-By: YourBobName@<first8hex> (Sonnet 4.6)"
```

---

## Task 3: Rich-driven live display + skip-as-event refactor

**Why this is one task:** The event-format change and the Rich refactor both rewrite the orchestration loop in `run_batch`. Doing them separately means refactoring the same code twice. Combined, it's the largest task in this iteration — comparable to v1's Task 5.

**Files:**
- Modify: `harness/run_all.py`
- Test: `tests/harness/test_run_all.py`

### Behavioral changes

1. **Total counts all entries, not just runnable.** `[N/M]` where M = `len(entries)`.
2. **Each entry gets a stable index in matrix order** (the sort order `build_matrix` already produces).
3. **Skips render as `[idx/total] skip <scenario> × <agent> → — skip (requires <directive>)`** — same shape as `done` lines.
4. **TTY path**: use `rich.live.Live` with a pinned panel showing in-flight rows. Completion events scroll above via `console.print`.
5. **Non-TTY path** (`Console.is_terminal == False`): fall back to a plain append-only print of each event (no Live, no in-flight panel).

### Step 1: Add tests for the new event format

Append to `tests/harness/test_run_all.py`:

```python
def test_run_batch_event_format_uses_total_denominator_and_skip_verb(
    tmp_path, capsys, monkeypatch
):
    """[N/M] denominator counts the full matrix; skips render in event shape.

    Strong assertions: skip line precedes runnable lines, and each
    runnable index appears in BOTH a `start` and a `done` line.
    """
    # Pin Console TTY detection regardless of CI env (FORCE_COLOR).
    monkeypatch.delenv("FORCE_COLOR", raising=False)

    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "alpha", directive="codex")  # claude skipped at idx 1
    _scenario(scenarios, "beta")
    _agent(agents, "claude")
    _agent(agents, "codex")
    out_root = tmp_path / "results-harness"

    def fake_invoke(*, scenario_dir, coding_agent, coding_agents_dir,
                    out_root, timeout_seconds=None):
        return ChildResult(
            run_id=f"{scenario_dir.name}-{coding_agent}-x",
            exit_code=0, error=None,
        )

    run_batch(
        scenarios_root=scenarios, coding_agents_dir=agents,
        out_root=out_root, jobs=1, agent_filter=None,
        invoke=fake_invoke,
    )

    captured = capsys.readouterr().out
    # build_matrix sort order: alpha×claude (skip, idx 1), alpha×codex (2),
    # beta×claude (3), beta×codex (4).
    assert "[1/4] skip" in captured, captured
    # Old [skip] prefix is gone.
    assert "[skip]" not in captured

    # Each runnable index appears in BOTH a start and a done line.
    for i in (2, 3, 4):
        assert f"[{i}/4] start" in captured, captured
        assert f"[{i}/4] done" in captured, captured

    # Skip event is emitted upfront, before any runnable start.
    skip_pos = captured.find("[1/4] skip")
    first_start_pos = min(
        captured.find(f"[{i}/4] start") for i in (2, 3, 4)
    )
    assert 0 <= skip_pos < first_start_pos, (skip_pos, first_start_pos)
```

(Some of these tests check stdout shape from `capsys`. With `--jobs 1`, ordering is deterministic.)

### Step 2: Update existing tests for the new shape

The `test_run_batch_writes_skipped_then_runnable` test should keep its plain stream capture while asserting the new shape:

```python
    batch_dir = run_batch(
        scenarios_root=scenarios, coding_agents_dir=agents,
        out_root=out_root, jobs=1, agent_filter=None,
        invoke=fake_invoke,
    )
```

Same for `test_run_batch_writes_batch_json_header_and_footer` and `test_run_batch_jobs_gt_one_runs_all_pairs`.

### Step 3: Run failing tests

Run: `uv run pytest tests/harness/test_run_all.py -x -q`
Expected: FAIL — `[skip]` prefix still present.

### Step 4: Refactor `run_batch`

Three changes:

1. **Build the full indexed entry list before any printing.** Replace:

   ```python
   runnable = [e for e in entries if e.runnable]
   skipped = [e for e in entries if not e.runnable]
   ```

   with:

   ```python
   # Stable matrix-order indices for every entry (1-based, includes skips).
   indexed = list(enumerate(entries, 1))
   total = len(entries)
   runnable_indexed = [(idx, e) for idx, e in indexed if e.runnable]
   skipped_indexed = [(idx, e) for idx, e in indexed if not e.runnable]
   ```

2. **Introduce a `BatchProgress` helper that owns rendering**, and a top-level branch on terminal detection. New module-level class:

   ```python
   from rich.console import Console
   from rich.group import Group
   from rich.live import Live
   from rich.panel import Panel
   from rich.text import Text


   class BatchProgress:
       """Owns rendering state for a batch. Thread-safe for the limited mutations
       workers make (`started` / `finished`); reads happen on the main thread."""

       def __init__(self, *, batch_id: str, total: int, jobs: int,
                    skipped: int):
           """`skipped` is known upfront (set from len(skipped_indexed)). All
           further mutations come from worker threads via `started` / `finished`
           — there's no runtime `skipped()` mutator, which keeps the invariant
           that `_counts['skipped']` never changes during the Live phase."""
           self.batch_id = batch_id
           self.total = total
           self.jobs = jobs
           self._lock = threading.Lock()
           self._in_flight: dict[int, tuple[MatrixEntry, float]] = {}
           self._counts = {"pass": 0, "fail": 0, "indeterminate": 0,
                           "unknown": 0, "skipped": skipped}
           self._started = time.monotonic()

       def started(self, idx: int, entry: MatrixEntry) -> None:
           with self._lock:
               self._in_flight[idx] = (entry, time.monotonic())

       def finished(self, idx: int, final: str) -> None:
           with self._lock:
               self._in_flight.pop(idx, None)
               self._counts[final] = self._counts.get(final, 0) + 1

       def snapshot(self) -> tuple[list[tuple[int, MatrixEntry, float]], dict[str, int]]:
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
               rows.append(
                   f"  [{idx}/{self.total}]  {entry.scenario} × {entry.coding_agent}"
                   f"  {_fmt_duration(elapsed)}"
               )
           panel_body = "\n".join(rows) if rows else "(idle)"
           panel = Panel(
               panel_body,
               title=f"in flight ({len(in_flight)}/{self.jobs})",
               title_align="left",
           )
           done = counts["pass"] + counts["fail"] + counts["indeterminate"] + counts["unknown"]
           wall = _fmt_duration(time.monotonic() - self._started)
           footer = Text(
               f"progress {done + counts['skipped']}/{self.total}"
               f" · ✓{counts['pass']} ✗{counts['fail']} ⊘{counts['indeterminate']}"
               f" —{counts['skipped']}"
               + (f" ?{counts['unknown']}" if counts['unknown'] else "")
               + f" · wall {wall}"
           )
           return Group(panel, footer)
   ```

   Implementing `__rich__` (rather than passing a callable) is the canonical
   Rich pattern: `Live(progress, refresh_per_second=4)` re-walks `progress`
   on every tick, picking up fresh state from `self._in_flight`. No tick
   thread needed.

3. **Split `run_batch` into a TTY path and a plain path.** Both share matrix construction, batch-dir allocation, `started_at`, `BatchProgress` instantiation, and the skip-event emission. They diverge in how events are surfaced:

   - **Plain path** (`console.is_terminal=False`): emit each event as a `print(...)` call to the provided stream (or `sys.stdout`). No Live. Format matches the spec:

     ```
     [idx/total] skip   scenario × agent      → — skip (requires <directive>)
     [idx/total] start  scenario × agent
     [idx/total] done   scenario × agent      → ✓ pass    in 43s
     ```

   - **TTY path:** wrap the scheduling loop in `with Live(progress.render, refresh_per_second=4, console=console) as live:`. Use `console.print(...)` for the completion log lines (start lines are NOT printed in TTY mode — the in-flight panel already shows them; only `done` and `skip` lines scroll). Live re-pulls `progress.render` four times a second so in-flight elapsed times update.

Implementation sketch for `run_batch`:

```python
def run_batch(
    *,
    scenarios_root: Path,
    coding_agents_dir: Path,
    out_root: Path,
    jobs: int,
    agent_filter: list[str] | None,
    invoke: Callable[..., ChildResult] | None = None,
    stream: TextIO | None = None,
) -> Path:
    if jobs < 1:
        raise ValueError(f"jobs must be >= 1, got {jobs}")
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

    write_batch_header(
        batch_dir=batch_dir, coding_agents=agents_in_batch,
        jobs=jobs, started_at=started_at,
    )

    console = Console(file=stream, force_terminal=None if stream is None else False)
    use_live = console.is_terminal
    progress = BatchProgress(
        batch_id=batch_dir.name, total=total, jobs=jobs,
        skipped=len(skipped_indexed),
    )

    # Header banner.
    console.print(
        f"batch {batch_dir.name} · {total} pairs "
        f"({len(runnable_indexed)} runnable, {len(skipped_indexed)} skipped by directive) "
        f"· --jobs {jobs}",
        markup=False, highlight=False,
    )

    # Skips render first, synchronously. Use Text() not f-strings: the
    # literal `[N/M]` prefix would otherwise be interpreted as Rich markup.
    for idx, entry in skipped_indexed:
        directive = parse_coding_agents_directive(entry.scenario_dir / "checks.sh") or []
        line = Text.assemble(
            f"[{idx}/{total}] skip   {entry.scenario} × {entry.coding_agent}      → ",
            (f"— skip (requires {', '.join(directive)})", _STATUS_STYLES["skipped"]),
        )
        console.print(line, markup=False, highlight=False)
        append_result_record(
            batch_dir=batch_dir, scenario=entry.scenario,
            coding_agent=entry.coding_agent, run_id=None, skipped="directive",
        )

    def _worker(idx: int, entry: MatrixEntry) -> tuple[int, MatrixEntry, ChildResult, float]:
        progress.started(idx, entry)
        if not use_live:
            console.print(
                Text(f"[{idx}/{total}] start  {entry.scenario} × {entry.coding_agent}"),
                markup=False, highlight=False,
            )
        t0 = time.monotonic()
        result = invoke(
            scenario_dir=entry.scenario_dir, coding_agent=entry.coding_agent,
            coding_agents_dir=coding_agents_dir, out_root=out_root,
        )
        return idx, entry, result, time.monotonic() - t0

    def _drain(pool: ThreadPoolExecutor) -> None:
        # All console.print calls inside Live MUST use this Console (already
        # passed as console=console to Live above) — output corrupts if a
        # worker constructs its own Console or calls plain print().
        futures = [pool.submit(_worker, idx, e) for idx, e in runnable_indexed]
        for fut in as_completed(futures):
            idx, entry, result, elapsed = fut.result()
            final = _final_status_for_result(result, out_root)
            progress.finished(idx, final)
            label = _GLYPH_FOR_FINAL.get(final, f"? {final}")
            # Use Text() with explicit segments so the literal `[N/M]` prefix
            # is not parsed as Rich markup; the styled label is applied via
            # the (text, style) tuple form of Text.assemble.
            line = Text.assemble(
                f"[{idx}/{total}] done   {entry.scenario} × {entry.coding_agent}      → ",
                (label, _STATUS_STYLES.get(final, "")),
                f"      in {_fmt_duration(elapsed)}",
            )
            console.print(line, markup=False, highlight=False)
            append_result_record(
                batch_dir=batch_dir, scenario=entry.scenario,
                coding_agent=entry.coding_agent,
                run_id=result.run_id, skipped=None,
            )

    if use_live:
        # transient=True so the in-flight panel disappears when Live exits;
        # otherwise an obsolete `(idle)` panel lingers between the last
        # `done` event and the `batch done` summary line.
        with Live(
            progress, refresh_per_second=4, console=console, transient=True,
        ):
            with ThreadPoolExecutor(max_workers=jobs) as pool:
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
    console.print(summary_line, markup=False, highlight=False)
    try:
        artifacts_path = batch_dir.relative_to(Path.cwd())
    except ValueError:
        artifacts_path = batch_dir
    console.print(f"artifacts: {artifacts_path}", markup=False, highlight=False)
    return batch_dir


# Status -> Rich style string. Lines build a `Text` object via
# `Text.assemble(...)`, passing `(label, _STATUS_STYLES[final])` tuples for
# the styled segments. The surrounding `[N/M]` prefix stays as a plain
# segment so Rich's markup parser doesn't try to interpret it. Console
# decides whether to emit ANSI based on TTY detection.
#
# Same palette as harness/show.py:_BATCH_GLYPH_COLORS — keep in sync.
_STATUS_STYLES = {
    "pass":          "rgb(80,250,123)",
    "fail":          "rgb(255,85,85)",
    "indeterminate": "rgb(241,250,140)",
    "skipped":       "rgb(122,130,148)",
    "unknown":       "rgb(122,130,148)",
}
```

Imports to add at the top of `harness/run_all.py`:

```python
from rich.console import Console
from rich.group import Group
from rich.live import Live
from rich.panel import Panel
from rich.text import Text
```

### Step 5: Run all tests

Run: `uv run pytest -x -q --ignore=tests/harness/test_run_all_e2e.py`
Expected: PASS — 432 tests (430 + 2 new).

### Step 6: Keep CLI output mode implicit

Do not add an output-mode flag. `run_batch(...)` selects the live path from
terminal detection and falls back to plain lines for non-TTY output.

### Step 7: Manual smoke

```
uv run harness run-all --coding-agents claude --jobs 4 [against a small scenarios root]
```

Expected: in-flight panel pins at the bottom; completion events scroll above; final summary prints below.

```
uv run harness run-all --coding-agents claude --jobs 4 | cat
```

Expected: plain append-only output (Console detects non-TTY automatically).

### Step 8: Commit

```bash
git add harness/run_all.py harness/cli.py tests/harness/test_run_all.py tests/harness/test_cli.py
git commit -m "harness: Rich-driven live display + skip-as-event refactor

Live mode (default on TTY): in-flight panel pinned at bottom, completion
events scroll above, refresh ticks 4×/sec so in-flight elapsed times
update. Falls back to plain append-only output when stdout isn't a TTY.

Same change replaces the v1 \`[skip]\` prefix with the event-shaped
\`[idx/total] skip <scenario> × <agent>\` line, and counts skips against
the full matrix total in the [N/M] denominator.

Co-Authored-By: YourBobName@<first8hex> (Sonnet 4.6)"
```

---

## Final verification

After Task 3:

- [ ] `uv run pytest -x -q` — green (432 tests).
- [ ] `uv run ruff check` — clean.
- [ ] `uv run ty check` — clean.
- [ ] Manual smoke: live mode on TTY, plain mode via pipe.

If any step fails, do NOT mark complete — diagnose and add follow-up tasks.
