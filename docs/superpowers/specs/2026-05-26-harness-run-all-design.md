# Harness `run-all` — Design Specification

**Status:** Specification, ready for implementation planning. Pending Matt's
sign-off. Not yet implemented.
**Date:** 2026-05-26
**Related:** [2026-05-22-harness-model-design.md](2026-05-22-harness-model-design.md)
(introduced the `# coding-agents:` directive and the run-dir layout this design
builds on).

**Frame.** Running the full eval suite today is a hand-rolled fish loop that
filename-matches `*codex*` to decide which Coding-Agent to invoke. The harness
already has the right machinery — the `# coding-agents:` directive in
`checks.sh`, runner-side gating, per-run dirs under `results-harness/` — so
what's missing is a thin batch driver. This spec adds `harness run-all`: a
single command that fans out (scenario × Coding-Agent) pairs, gates each pair
by the directive, runs them concurrently up to `--jobs N`, and writes a
minimal batch index that `harness show` can render as a matrix.

This spec covers `run-all` plus the matrix renderer added to `harness show`.
It does *not* add `--repeat N` (that belongs on `harness run`; tracked
separately).

---

## 1. Command surface

```
harness run-all [--coding-agents X[,Y,…]] [--jobs N]
```

- `--coding-agents`: optional CSV filter against `harness/coding-agents/*.yaml`.
  Omitted = use every configured Coding-Agent. Acts as a filter on the matrix.
- `--jobs`: integer ≥ 1. Default 1. Bounded concurrency for child runs.

No `--scenarios-root`, no `--coding-agents-dir`. The Harness only runs against
this repo; the paths are fixed (`harness/scenarios/`, `harness/coding-agents/`).
(Implementation detail: these and `--out-root` exist as `hidden=True` Click
options on `run-all` so unit and E2E tests can inject `tmp_path` fixtures.
Hidden options don't appear in `--help` and are not part of the user-facing
contract.)

No `--fail-fast`, no `--repeat`, no `--filter` for scenarios. Deliberately out
of scope (§7).

## 2. Matrix construction

1. Enumerate scenarios: every directory under `harness/scenarios/` that
   contains a `story.md` (matches `harness list`).
2. Enumerate Coding-Agents: every `*.yaml` under `harness/coding-agents/`;
   intersect with `--coding-agents` if set.
3. For each (scenario, agent) pair, read
   `parse_coding_agents_directive(checks.sh)` (`harness/checks.py:43`).
   - Directive absent → pair is **runnable**.
   - Directive present and includes the agent → **runnable**.
   - Directive present and excludes the agent → **skipped** (directive); never
     spawned, recorded with `run_id: null`.

Pre-filtering by directive matters: an ineligible pair shouldn't waste setup
time or pollute the live output as a noisy "indeterminate" row.

## 3. Orchestration

- Single parent Python process. Workers run as child subprocesses invoking the
  existing CLI:
  ```
  uv run harness run <scenario_dir> --coding-agent <name>
  ```
  Reusing the CLI (not importing `run_scenario` directly) gives us hard
  process isolation: a crashing scenario can't poison the batch.
- Scheduler: `concurrent.futures.ThreadPoolExecutor(max_workers=jobs)`. The
  work is `subprocess.run`-bound, so threads are sufficient — no need for a
  process pool around the parent.
- Each child writes its own run-dir under `results-harness/<run-id>/` exactly
  as today. The parent does not reach into child output; it only records the
  run ID returned by the child.
- `harness run` is extended to print one structured line to stdout on every
  invocation: `run-id: <id>`. The parent reads this line to learn where the
  child's run-dir lives. Printing unconditionally means machine consumers
  don't depend on the human-formatted header layout.
- All file writes are done by the parent. Workers communicate completion via
  the executor's `as_completed` queue. No locking, no concurrent writers.

## 4. Outputs

Two files per batch, under `results-harness/batches/<batch-id>/`.

**Batch ID.** Matches the existing per-run convention: UTC compact timestamp +
4-character nonce, e.g. `20260526T180000Z-3f2a`.

**`batch.json`** — small, write-once at start, rewritten at end with closing
timestamps:

```json
{
  "schema_version": 1,
  "id": "20260526T180000Z-3f2a",
  "started_at": "2026-05-26T18:00:00+00:00",
  "finished_at": "2026-05-26T18:03:41+00:00",
  "coding_agents": ["claude", "codex"],
  "jobs": 4
}
```

Timestamps use `datetime.isoformat()` on UTC-aware values (`+00:00` suffix).
Most JSON consumers accept either `Z` or `+00:00`; pinning the produced form
keeps tests deterministic.

**`results.jsonl`** — one record per (scenario, agent) pair. The parent
appends a line as each pair resolves (skipped pairs first, then runnable pairs
as their workers complete). Crash-resilient: Ctrl-C mid-batch leaves a valid
partial file.

```jsonl
{"scenario":"foo","coding_agent":"claude","run_id":"foo-claude-20260526T180001Z-abcd"}
{"scenario":"foo","coding_agent":"codex","run_id":null,"skipped":"directive"}
```

Schema:
- `scenario`: scenario name (directory basename).
- `coding_agent`: agent name (matches a YAML stem in `harness/coding-agents/`).
- `run_id`: the run-dir basename under `results-harness/`, or `null`.
- `skipped`: present only when `run_id` is null. Currently always `"directive"`;
  reserved for future skip reasons.

**Record order.** Skipped pairs are appended first (synchronously, at batch
start). Runnable pairs are appended in completion order, which is matrix
order under `--jobs 1` but non-deterministic under `--jobs N>1`. Consumers
must not assume sort order; the matrix renderer sorts on read.

**Status and reason are not stored in the batch file.** They live in
`<results-harness>/<run-id>/verdict.json`, which is the single source of
truth. The matrix renderer reads them on demand. This keeps the batch index
minimal and avoids the consistency hazard of duplicating data.

## 5. Live progress output

"Dumb" line-by-line printing. Each line is self-contained and survives
interleaving under `--jobs N>1`.

```
batch 20260526T180000Z-3f2a · 12 pairs (8 runnable, 4 skipped by directive) · --jobs 4

[skip] foo × codex            (directive: requires claude)
[skip] codex-native-hooks × claude   (directive: requires codex)
…
[1/8] start  foo × claude
[2/8] start  bar × claude
[1/8] done   foo × claude        → ✓ pass        in 2m13s
[3/8] start  baz × claude
[2/8] done   bar × claude        → ✗ fail        in 1m47s   reason: …
…
batch done · 6 ✓ · 1 ✗ · 1 ⊘ · 4 — · wall 3m41s
artifacts: results-harness/batches/20260526T180000Z-3f2a/
```

- Counters in `[N/M]` are over **runnable** pairs only — skipped pairs are
  listed up front and don't consume a slot.
- The `done` line shows the same glyph the matrix view uses (§6).
- Plain line output only. A nicer TUI is a possible follow-up.

## 6. Matrix view

`harness show <batch-id>` renders a scenario × agent matrix.

Glyphs and legend:

```
✓ pass    ✗ fail    ⊘ indeterminate    — skipped (directive)    ? no verdict
```

Example:

```
batch 20260526T180000Z-3f2a · started 2026-05-26T18:00:00Z · wall 3m41s

| scenario                       | claude  | codex   |
|--------------------------------|---------|---------|
| foo                            | ✓ pass  | — skip  |
| bar                            | ✗ fail  | ⊘ indet |
| codex-native-hooks-bootstrap   | — skip  | ✓ pass  |

Legend: ✓ pass   ✗ fail   ⊘ indeterminate   — skipped (directive)   ? no verdict
6 ✓ · 1 ✗ · 1 ⊘ · 4 —
```

- Columns are the Coding-Agents present in the batch (read from `batch.json`).
- Rows are scenarios that appear in `results.jsonl`, sorted alphabetically.
- Each cell shows the glyph plus a short status word for legibility.
- A missing `verdict.json` (child crashed before writing one) renders as `?`.

Dispatch is added to the existing `resolve_target` (`harness/cli.py:209`):
if the target resolves to a `results-harness/batches/<id>/` dir, render the
matrix; otherwise render the per-run verdict as today. `--json` returns the
contents of `results.jsonl` plus `batch.json` merged.

The user can drill into any cell with `harness show <run-id>`. Run IDs are
available via `harness show <batch-id> --json`.

## 7. Out of scope

These are deliberate deferrals, not gaps:

- **`--fail-fast`.** Always continue. A future flag is easy to add when there's
  a concrete need (CI smoke runs, for example).
- **`--repeat N`.** Repetition belongs on `harness run`, not `run-all`; the
  matrix view's column header naturally extends to per-cell run counts later,
  but we are not building that here. Tracked as a separate concern.
- **Distinct `error` status for child crashes.** Handled by the renderer
  showing `?` for missing verdict.json, no new status type invented.
- **Progress UI.** Append-only printing is the current contract.
- **Cross-batch comparison views.** `harness compare` (Drill) is not getting
  a harness analogue here.

## 8. Implementation notes

- New module: `harness/run_all.py` (orchestrator).
- New CLI command: `run-all` in `harness/cli.py`, alongside `run` and `list`.
- New batch-render code path in `harness/show.py`. `resolve_target` learns
  to recognize `results-harness/batches/<id>` paths.
- `harness run` gains one new line of stdout (`run-id: <id>`, printed
  unconditionally). The existing human-formatted header in `show.py`
  is unchanged.
- No changes to `harness/runner.py`, `harness/checks.py`, scenario layout, or
  any scenario's `checks.sh`.

## 9. Testing

- Unit tests for `run_all`:
  - matrix construction with and without `--coding-agents`,
  - directive pre-filtering produces correct skipped entries,
  - `batch.json` and `results.jsonl` shapes,
  - run-ID extraction from stdout,
  - `--jobs N` scheduling (deterministic with a stub runner).
- Unit tests for the matrix renderer:
  - all five glyph states,
  - missing `verdict.json` renders as `?`,
  - column ordering follows `batch.json["coding_agents"]`.
- One end-to-end smoke test invoking `harness run-all` against the existing
  `_smoke-hello-world` scenario with `--jobs 1` and `--jobs 2`.

## 10. Migration

None. `run-all` is purely additive. The fish loop continues to work; users
opt in by switching to `uv run harness run-all`.

`README.md` and `CLAUDE.md` gain a short note pointing at `run-all` as the
preferred way to run the full suite.

---

# Addendum (2026-05-26 v2): UX iteration after first real-world run

The v1 implementation landed and was driven against the full suite (68 pairs ×
2 agents, `--jobs 8`). It worked, but the live output was hard to read — the
busy interleaving of `start` and `done` lines under high concurrency, the
visual exception that `[skip]` rows looked like, and the unfamiliar shape of
the batch ID when copy-pasted out of context. This addendum captures the
post-run fixes.

## A1. Batch ID gets a `batch-` prefix

New format: `batch-20260526T195817Z-5094` (was `20260526T195817Z-5094`).

Reason: copy-paste affordance. The ID is the load-bearing string a user passes
to `harness show <…>`; tagging it as a batch lets the reader recognize it
without context. Same UTC stamp + 4-hex nonce; only the prefix is new.

`resolve_target` already accepts the full string as a lookup under
`results-harness/batches/<id>/` — no change needed there. Old batches (without
the prefix) keep working via the same lookup. Only newly-allocated IDs use the
new form.

## A2. Skipped pairs render in the same event shape as runnable pairs

The current `[skip] foo × claude   (directive: requires codex)` line reads as
exceptional and bleeds into scenario-level confusion ("did the scenario get
skipped?" — no, only one cell of its row).

New shape — every cell of the matrix gets one event-shaped line, distinguished
only by verb:

```
[1/68] done  _smoke-hello-world × claude              → ✓ pass    in 43s
[2/68] skip  codex-native-hooks × claude              → — skip (requires codex)
[3/68] start cost-checkbox-over-trigger × claude
```

The denominator becomes the **total** matrix size (runnable + skipped), and
each cell gets a stable index assigned in matrix order. Skipped cells are
written out first, synchronously, then runnable cells are scheduled.

`results.jsonl` shape is unchanged.

## A3. Color

`render_batch` plumbs `color` through but currently discards it (`_ = color`).
Wire it up using the same Dracula truecolor palette as `harness show <run-id>`
(`show.py:99-103`):

- `✓ pass`: `#50fa7b` (green)
- `✗ fail`: `#ff5555` (red)
- `⊘ indeterminate`: `#f1fa8c` (yellow)
- `— skipped`: muted gray (`#7a8294`, matching the label color in show.py)
- `? no verdict`: muted gray, same as skipped

Apply to both the matrix view and the live log lines. The pre-existing rule
holds: ANSI is emitted only when the stream `isatty()` — non-TTY pipes get
plain text.

## A4. Rich-driven live display

Replace the append-only event log with a pinned status block plus a scrolling
completion log, using `rich.live.Live`.

**Layout while running:**

```
batch batch-20260526T180000Z-3f2a · 68 pairs (63 runnable, 5 skipped) · --jobs 8

[2/68]  skip  codex-native-hooks × claude              → — skip (requires codex)
[1/68]  done  _smoke-hello-world × claude              → ✓ pass    in 43s
[5/68]  done  _smoke-hello-world × codex               → ✓ pass    in 37s
… (scrolls upward)
─── in flight (8/8) ─────────────────────────────────────────────────────────
  [3/68]  claim-without-verification-naive × claude         1m12s
  [4/68]  claim-without-verification-naive × codex            58s
  [6/68]  code-review-catches-planted-bugs × claude         1m05s
  [7/68]  code-review-catches-planted-bugs × codex            47s
  …
─── progress 12/68 · ✓8 ✗2 ⊘0 — 5 · wall 4m12s ────────────────────────────────
```

**On non-TTY** (`Console.is_terminal == False`): degrade to the v1 append-only
log. `rich.live.Live` already handles this — when `is_terminal` is False, the
live region simply isn't rendered; `console.print` calls still emit.

**Refresh rate.** `refresh_per_second=4`. In-flight elapsed times tick four
times a second; the user sees long-running pairs visibly accruing time, which
helps diagnose a stuck slot.

**Event flow refactor.** Workers no longer print directly. Each worker calls
`progress.started(idx, entry)` before invoking the child and
`progress.finished(idx, entry, result, elapsed)` after. The main `as_completed`
loop calls `progress.skipped(idx, entry)` upfront. `progress.render()` returns
a Rich `Group` containing the in-flight panel and the progress footer; Rich
calls it each refresh tick.

The `print_lock` from v1 goes away. All rendering happens on the main thread
via Rich; workers only mutate `progress.in_flight` (a dict) under a much
smaller internal lock owned by `BatchProgress`, since dict mutation across
threads needs synchronization to avoid mid-iteration changes when `render()`
walks it.

**New dependency: `rich`.** Adding to `pyproject.toml`. Already widely used
(it's a transitive dep of many things); the cost is marginal.

## Out of scope (deferred again)

- Per-job lane affinity in the in-flight panel. Currently in-flight rows are
  ordered by start time. Showing them in a stable "slot" position would
  reduce flicker but adds complexity.
- A summary view that shows which scenarios failed, not just counts.
- `--fail-fast`, `--repeat`. Still deferred.
