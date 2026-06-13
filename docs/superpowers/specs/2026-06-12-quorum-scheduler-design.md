# Quorum Scheduler — Per-Harness Speed Control

**Date:** 2026-06-12
**Status:** Design approved; spec only — implementation lands in the planned
TypeScript rewrite, no Python plan follows this document.
**Author:** Hephaestus@d7d3584c (Fable 5), with Matt.
**Ticket:** PRI-2203 (related: PRI-2185 dashboard, PRI-2079 agy reliability)

## Purpose

Some coding agents are backed by models/APIs with very low concurrency
limits (antigravity); others tolerate very high parallelism (claude, codex).
Batch runs — CLI `run-all` and dashboard launches alike — need **per-harness
speed control**: run wildly fast by default, clamp only where a harness
requires it.

This spec defines the scheduling **semantics** any implementation must
satisfy. It is deliberately language-agnostic: the implementer is expected
to be the TypeScript rewrite of quorum. The current Python
(`quorum/scheduler.py`) is the incumbent baseline, referenced for behavior
and for one known defect that must not be ported.

## The model in one paragraph

One global slot pool of size `jobs` ("we can run up to this many of
anything"). Per-harness rules say how many of those slots that harness may
hold and how closely it may space its launches. Most harnesses declare no
rules and fill anything available. There is **no fairness**: filling every
slot with one harness before another gets any is acceptable and expected.

Limits are **per-batch and per-process**: two concurrent batches (CLI +
dashboard, or two dashboards) each get an independent slot pool, so a
`cap=1` harness can run N-wide across N simultaneous batches. There is no
cross-process global accounting — accepted and recorded, not defended
against.

## Scheduling semantics

### State (per batch)

- `free_slots` — initialized to `jobs` (validated ≥ 1).
- `inflight[h]` — in-flight run count per harness.
- `next_start[h]` — earliest permitted next launch per harness
  (initialized to the epoch: a harness's first start is immediate).
- `latched` — set of harnesses latched off by a rate-limit verdict.
- `stop_requested` — flag set by the consumer (dashboard `/stop`).

### Eligibility

A queued cell of harness `h` may start iff **all** hold:

```
free_slots > 0
AND inflight[h] < cap[h]          (cap default: unbounded)
AND now ≥ next_start[h]           (spacing default: 0)
AND h ∉ latched
AND NOT stop_requested
```

### Dispatch

A central dispatcher owns all state and accounting. It greedily starts any
eligible cell — scan order is arbitrary; no fairness across harnesses or
cells. When queued work exists but nothing is eligible, the dispatcher
sleeps until the earliest `next_start` or the next in-flight completion,
whichever comes first.

**The mandated property: a cell waiting on its harness's cap, spacing, or
latch never occupies a global slot.** Slots are consumed only by running
work. (This is the property the incumbent violates — see Incumbent
baseline.)

On start: `free_slots -= 1`, `inflight[h] += 1`,
`next_start[h] = start_time + spacing[h]`, emit `cell_started`, invoke the
child. On completion: release both counters, emit the terminal event,
re-dispatch.

**All time reads go through a single injectable clock** — both the
eligibility comparison (`now ≥ next_start[h]`) and the dispatcher's sleep
target. Tests advance the clock manually; an implementation mixing the
injected clock with wall time for sleeps fails the verification contract's
determinism requirement.

### Pacing semantics

`spacing[h]` is measured **start-to-start**, independent of completions:
concurrency caps in-flight volume, spacing caps burst rate, and both bind
independently (a harness with `cap=1, spacing=30s` whose runs take 5s still
starts at most one run per 30s; one whose runs take 5min is bound by the cap
alone). State is per-batch: back-to-back batches may violate spacing across
the batch boundary — accepted, not defended against.

### Rate-limit latch (unchanged decision: latch-and-skip)

When a finished run's verdict is rate-limited (the existing
`is_rate_limited` hook), its harness joins `latched` and **all of that
harness's undispatched cells immediately emit `cell_skipped`
(`rate-limited`)** — an improvement over the incumbent, which skips them
lazily one-by-one as dead workers drain. In-flight runs of the harness are
left to finish. Latch dominates spacing: a latched harness's `next_start`
is never consulted again. Pause/retry/backoff was considered and rejected: agy's
window is multi-hour; waiting it out mid-batch is theater.

### Stop

When `stop_requested` is set, all undispatched cells immediately emit
`cell_skipped` (`stopped`). In-flight children are the consumer's concern
(the dashboard SIGINTs registered pids; see PRI-2185/PRI-2188) — the
scheduler just stops dispatching and drains.

### Completion

Every runnable cell receives **exactly one terminal event**
(`cell_finished` or `cell_skipped`). The valid per-cell lifecycles are
`queued → started → finished` and `queued → skipped` (skips never start —
a latch- or stop-skipped cell still received its `cell_queued`).
`batch_done` fires exactly once, after all terminal events.

## Configuration

Per-harness, in the existing `coding-agents/<name>.yaml`:

```yaml
max_concurrency: 1          # max in-flight runs; absent = unbounded
launch_spacing_seconds: 30  # min start-to-start gap; absent = 0
```

- `max_concurrency`: existing key, unchanged name; integer ≥ 1.
- `launch_spacing_seconds`: new; number ≥ 0.
- Both absent (claude, codex, kimi, claude-haiku, claude-sonnet): the
  harness runs at full slot speed — `jobs` is its only limit.
- antigravity: `max_concurrency: 1` plus `launch_spacing_seconds: 30` as the
  starting value (its yaml already documents that *bursts* trip a multi-hour
  window; serial back-to-back starts are still a burst from the API's view).
  Tune from experience.
- copilot, gemini, pi, opencode: keep their existing `max_concurrency: 1`;
  spacing optional.

`--jobs` keeps its meaning ("up to this many of anything") but its **default
moves from 1 to 8**. Today's default is maximally conservative — the
opposite of the design's posture. CLI and dashboard share one default
constant; the dashboard run strip's `M in flight` continues to mirror it.

## Events & consumer contract (unchanged)

Event kinds: `cell_queued / cell_started / cell_finished / cell_skipped /
batch_done`, with the fields the incumbent carries (`idx`, `entry`, `final`,
`run_id`, `elapsed_s`, `cost_usd`, `skipped_reason`). `cell_skipped` reasons:
`rate-limited | stopped`. Both consumers — run-all's Rich readout and the
dashboard's SSE bus — must work unmodified against the new engine.

Ordering guarantees (stated explicitly for the first time):

1. Every runnable cell emits `cell_queued` before any cell starts.
2. A cell's `cell_started` precedes its `cell_finished`.
3. A skipped cell never emits `cell_started`.
4. Exactly one terminal event per cell; `batch_done` strictly last.

Callbacks may fire from scheduler internals on any thread/task; the callback
must be thread-safe (run-all locks; the dashboard marshals onto its event
loop). `on_spawn` (child-pid registration for `/stop`) and `should_abort`
pass through with incumbent semantics; `should_abort` remains a
belt-and-suspenders check at dispatch time alongside `stop_requested`. An
implementation MAY unify the two if both observe the same stop intent.

Directive/draft/tier skips remain the **caller's** concern (computed by
`build_matrix` before scheduling); the scheduler only ever sees runnable
entries. Kimi preflight likewise stays caller-side, delivered per-harness
via `preflight_env_by_agent`.

## Verification contract

The implementer (a future agent, likely in TypeScript) must ship these as
deterministic tests — injected/fake clock, stub invoke; no real children, no
sleeps:

1. **Global cap:** total in-flight never exceeds `jobs`, including when
   per-harness lanes exist (the incumbent's exact failure).
2. **Harness cap:** per-harness in-flight never exceeds its
   `max_concurrency`.
3. **Spacing:** consecutive starts of one harness are ≥
   `launch_spacing_seconds` apart, measured start-to-start.
4. **No wasted slots:** with `jobs=2`, harness A at `cap=1` with one cell
   running and more queued, harness B unbounded with work queued — assert
   on scheduler state once dispatch quiesces: `inflight[B] == 1`,
   `free_slots == 0`, and A's remaining cells are still undispatched. A
   state assertion, not a timing one.
5. **Latch:** a rate-limited completion immediately skips all of that
   harness's undispatched cells (`rate-limited`); other harnesses proceed.
6. **Stop:** setting stop immediately skips all undispatched cells
   (`stopped`); nothing new spawns.
7. **Termination:** exactly one terminal event per runnable cell;
   `batch_done` exactly once, last.
8. **No fairness assertions:** greedy/unfair interleavings are permitted —
   no test may constrain order beyond properties 1–7.

## Incumbent baseline (do not port the bug)

`quorum/scheduler.py` (Python, extracted from `run_all` in PRI-2185)
implements the same event contract with nested thread pools: a main pool of
size `jobs` plus a dedicated lane pool per harness whose `cap < jobs`.
**Known defect: lane-pool work bypasses the main pool's accounting, so the
global cap is not actually global** — with lanes present, total in-flight
can exceed `jobs`. The latch also skips lazily (dead workers drain one at a
time) rather than immediately. Both behaviors are corrected by this spec,
not grandfathered. Everything else — the event vocabulary, the
caller/scheduler split, latch-and-skip, `on_spawn`/`should_abort` — carries
forward as the contract above.

## Out of scope

- Pause/retry/backoff on rate limits (rejected: latch-and-skip stays).
- Budget-window modeling (N runs per 5h) — provider windows are opaque;
  we'd be modeling guesses.
- Fairness/priority between harnesses or cells.
- Cross-batch pacing memory.
- The TypeScript rewrite itself and its idioms — this spec constrains
  semantics, not implementation.

## References

- `quorum/scheduler.py` — incumbent engine (event contract source of truth).
- `quorum/run_all.py` — caller: matrix pre-filter, kimi preflight, Rich
  consumer. `coding-agents/*.yaml` — per-harness config home.
- `docs/superpowers/specs/2026-06-11-quorum-dashboard-build-design.md` —
  dashboard consumer (SSE bus, stop semantics, PRI-2188 process-group
  follow-up).
- `docs/superpowers/specs/2026-06-04-agy-rate-limit-reliability-design.md` —
  the latch's origin and agy's rate-window behavior.
