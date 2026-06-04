# agy Rate-Limit Reliability — Design Specification

**Status:** Specification, ready for implementation planning. Not yet
implemented.
**Date:** 2026-06-04
**Scope:** Stream 1 of 2. This spec covers **antigravity (`agy`) reliability
only** — surviving and recovering from the Gemini Code Assist rate window. The
suite-wide cost/length problem (scenario tiering, redundant-scenario cuts,
parallelism defaults) is a deliberately **separate** spec (Stream 2), even
though the two touch at one seam (§7).

**Frame.** A full `quorum run-all` that includes antigravity keeps "hitting the
5-hour limit": the sweep stalls, burns wall-clock on hung cells, and produces a
pile of indeterminates. This spec pins down what that limit actually is, then
fixes the harness so agy fails fast when throttled and eventually completes its
coverage — without pretending agy can use a backend it cannot.

---

## 1. Problem

In recorded runs, antigravity is the least reliable coding-agent: 19 of 49
indeterminate verdicts in the audited corpus were antigravity auth-preflight or
Code Assist rate-limit failures, and antigravity sweeps are the ones that
approach ~5 hours of wall-clock. Two things go wrong:

1. **A cell that exhausts the rate window mid-run hangs to its full budget.**
   The existing detection (§3) catches a window that is *already* exhausted when
   a cell starts, but not one that trips *during* the gauntlet-driven main run.
   That cell burns up to its `max_time` (10m default) and is then misfiled as an
   empty-trace / "investigate" indeterminate rather than a rate-limit.
2. **No path back to full coverage.** Once the window trips, the remaining agy
   cells are correctly skipped, but there is no one-command way to re-run just
   those deferred cells in the next window. agy coverage silently ends up
   partial.

## 2. Root cause — what the "5-hour limit" actually is

Confirmed by inspecting the installed `agy` binary and Google's current plan
documentation (2026-06-04):

- **agy v1.0.4 has exactly one backend:** Gemini Code Assist over an OAuth
  personal account (`~/.gemini/settings.json` → `selectedType: oauth-personal`).
  The binary contains **no** `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_GENAI_USE_VERTEXAI`, or `GOOGLE_CLOUD_PROJECT` string — there is no
  API-key or Vertex/GCP metered path. *(Verified: 0 whole-word `strings` hits;
  corroborated by upstream feature request antigravity-cli#78.)* **We do not
  design around metered billing for agy — it cannot reach it.**
- **The "5-hour limit" is the subscription's usage-refresh window.** Under
  Google's March 2026 Antigravity plan structure, Pro/Ultra subscriptions
  **refresh usage every 5 hours** (free tier refreshes weekly), metered by
  compute ("work done"), not a published request rate. A sweep burns the 5-hour
  compute budget partway in, then every subsequent agy call returns
  `RESOURCE_EXHAUSTED` until the window refreshes. *(Web-cited to
  blog.google / antigravity.google plan announcements; Google does not publish
  the absolute compute numbers — high confidence on the mechanism, not on the
  numeric ceiling.)*
- **The only throughput lever is the account tier.** AI Pro ($19.99) →
  AI Ultra **5×** ($99.99) → AI Ultra **20×** ($199.99). agy inherits the
  account entitlement automatically; no wiring change.

**Decision already taken:** the eval account (`arittr@gmail.com`, the account
agy already authenticates as) is upgraded to **AI Ultra 5×**. Because it is the
same account, nothing is re-seeded; the larger 5-hour bucket is live on the next
run.

## 3. What already exists (build on this, don't rebuild)

- `runner.py:460` — `ANTIGRAVITY_RATE_LIMIT_MARKER = "Code Assist rate limit"`.
- `runner.py:465` — `_AGY_RATE_LIMIT_SIGNALS = ("resource_exhausted",
  "ratelimitexceeded", "429")`, matched case-insensitively by
  `_agy_log_shows_rate_limit()` (`runner.py:468`).
- `runner.py:473` — `_run_antigravity_auth_preflight()` runs a 90s `agy --print`
  probe; on an empty/failed reply whose log shows a rate-limit signal it raises a
  `RunnerError(stage="setup")` carrying the marker. This catches an
  **already-exhausted** window cheaply, before the expensive main run.
- `run_all.py:612-651` — a per-batch latch: when a cell's verdict is a
  rate-limit verdict (`_is_rate_limited_verdict`, `run_all.py:781`), the agent is
  added to `rate_limited_agents`; subsequent cells for that agent short-circuit
  via `_RATE_LIMIT_SKIP_SENTINEL` (`run_all.py:166`) and never invoke.
- `run_all.py:661-678` — skipped cells are recorded distinctly as
  `skipped="rate-limited"` and counted in a dedicated `rate_limited` bucket
  (the `⏸` footer), **separate from indeterminate**.

So the *already-exhausted-at-start* case and the *skip-the-rest* latch are
solved. The gaps are mid-run detection (§4) and resume (§5).

## 4. Part A — fail fast and classify correctly

**Goal:** no agy cell hangs to its budget because of a 429, and every 429 is
recorded as a rate-limit (with its cause), not as an empty-trace indeterminate.

**A1. Live mid-run detection.** While the gauntlet subprocess drives the main
agy run, watch the run's `agy.log` for an `_AGY_RATE_LIMIT_SIGNALS` hit. On the
first hit, terminate the gauntlet invocation immediately rather than waiting for
`max_time`. Write the verdict as a rate-limit (reuse `ANTIGRAVITY_RATE_LIMIT_MARKER`)
so the latch (§3) trips and the rest of agy is skipped.

> **Latch predicate must broaden.** `_is_rate_limited_verdict` (`run_all.py:781`)
> currently requires `error.stage == "setup"` — true for the preflight path but
> not for a mid-run abort, which is a later stage. A1 must make the latch
> recognize a mid-run rate-limit verdict: match on `ANTIGRAVITY_RATE_LIMIT_MARKER`
> regardless of stage (or set an explicit `rate_limited: true` flag on the verdict
> and key the latch off that). Pick one and use it consistently; do not write a
> setup-stage error for a run that actually started.

> **Implementation constraint to confirm first.** The main agy run is driven by
> **gauntlet** (TUI adapter via tmux), so quorum does not own the agy process
> directly — it owns the *gauntlet* subprocess. A1 therefore watches the known
> `agy.log` path and, on a signal, kills the gauntlet subprocess (tearing down
> agy). The implementation plan MUST start by reproducing a mid-run 429 and
> confirming (a) where `agy.log` is for the main run, (b) that killing gauntlet
> cleanly tears down agy and leaves a capturable run dir, and (c) that we do not
> race a legitimate late-run recovery. Do not build A1 before this reproduction
> exists.

**A2. Capture the `quota_metric`.** The `RESOURCE_EXHAUSTED` payload identifies
*which* quota was exhausted (the Antigravity 5-hour compute window vs. the Code
Assist per-user day cap). Extract and persist that string on the rate-limit
verdict (e.g. `verdict.error.quota_metric`). This is the diagnostic that tells
us, empirically, whether the 5× upgrade or a different lever is the right next
move — it pays for itself by removing a guess from Part B and from any future
account decision.

**A3. Keep the deferred cells out of the indeterminate count.** Already true for
latch-skipped cells (`skipped="rate-limited"`). Extend the same classification to
the *first* mid-run-aborted cell from A1 so a tripped window produces a clean
"deferred" set, never indeterminate noise.

## 5. Part B — reliable coverage

**Goal:** agy eventually covers its whole scenario set despite the window.

**B1. Bigger bucket (done, no code).** AI Ultra 5× is live on the eval account.
agy inherits it; nothing to wire.

**B2. Resume-deferred command.** Add a way to re-run **only** the cells a batch
deferred for rate-limit, re-running them into a fresh window and appending to the
same batch's results. The deferred set is the **union** of (a) the latch-skipped
cells (`skipped="rate-limited"` records) and (b) the cell that tripped the window
mid-run, whose verdict is a rate-limit verdict (§6) — both must be re-run, or the
first cell is silently lost. This converts Part A's "skip now" into
eventually-complete coverage. CLI surface: a flag/subcommand on the existing
run-all path (exact shape decided in the implementation plan); it must reuse the
matrix-expansion and invoke machinery, not duplicate it.

**B3. Keep the three sdd 90-minute builds off agy's routine set.** The
`sdd-go-fractals`, `sdd-svelte-todo`, and `sdd-rejects-extra-features` scenarios
override `quorum_max_time` to 90m and are the single largest consumers of the
compute window. Spending a 5-hour bucket on a $30 build is how the window trips.
**This is the seam into Stream 2** (§7); this spec only records the requirement,
it does not implement scenario tiering.

**B4. Validate, then decide on fan-out.** After the upgrade, run one full agy
sweep and read A2's `quota_metric` plus the deferred count. If 5× holds a whole
sweep, the stream is done. Only if it does not do we consider fanning agy across
2–3 accounts. **Account fan-out is explicitly out of scope here (YAGNI) until the
measurement says we need it.**

## 6. Data & interfaces

- **Rate-limit verdict** gains an optional `quota_metric` field under its error
  block (A2). Absent when the metric could not be parsed.
- **Deferred set** is not a new artifact: it is, within a batch, the union of
  the `skipped="rate-limited"` result records (latch-skipped cells) and the
  cell(s) whose verdict carries the rate-limit marker / `rate_limited` flag (the
  mid-run trip from A1). B2 reads both; no new schema.
- **Resume command** takes a batch id (or the latest batch) and re-runs its
  rate-limited records. No new persistent state beyond the appended run dirs.

No change to the verdict pass/fail/indeterminate semantics. "Deferred /
rate-limited" remains a *skip* category, not a verdict.

## 7. Seam to Stream 2 (suite cost/length)

The only coupling: **which scenarios agy runs** is a tiering decision. B3
requires that the routine agy set excludes the 90-minute sdd builds. Stream 2
owns the mechanism (tiers / `tags:` / `status:` wiring); this spec owns the
requirement. When Stream 2 lands, B3 is satisfied by placing the sdd scenarios in
a non-routine tier for agy. Until then, B3 can be met by the existing
`# coding-agents:` directive convention or an explicit exclusion list.

## 8. Testing

Follow TDD; tests must be deterministic and must not hit the live Code Assist
backend.

- **A1 mid-run detection:** unit-test the log-watcher against a synthetic
  `agy.log` that gains a `RESOURCE_EXHAUSTED` line mid-stream; assert the
  gauntlet invocation is terminated and a rate-limit verdict is written. The
  process-teardown behavior is validated against the reproduction harness from
  the §4 constraint, not mocked away.
- **A2 quota_metric:** unit-test extraction from representative
  `RESOURCE_EXHAUSTED` payloads (real captured strings, both window and day-cap
  variants once observed); assert the field is persisted and absent-safe.
- **A3 classification:** extend the existing rate-limit tests
  (`tests/quorum/test_run_all.py::test_run_batch_fail_fast_on_agy_rate_limit`,
  `tests/quorum/test_runner.py` rate-limit-diagnosis cases) to assert the first
  mid-run-aborted cell records `skipped="rate-limited"`, not indeterminate.
- **B2 resume:** unit-test that resume re-runs exactly the `skipped="rate-limited"`
  cells of a batch and nothing else.

Test output must be pristine; intentionally-triggered rate-limit errors are
captured and asserted, never leaked to logs.

## 9. Open questions / future

- **Exact 5-hour vs day-cap attribution** — resolved empirically by A2's
  `quota_metric`, not by this spec.
- **Account fan-out** — deferred (B4), pending measurement.
- **Model selection (`--model`, agy ≥1.0.5)** — a cheaper/higher-quota model
  (Flash) could widen headroom, but requires updating agy (evals disable
  auto-update) and threading `--model` through the launcher. Out of scope; note
  for later.
- **Whether killing gauntlet mid-run is the right teardown** vs. a future
  gauntlet-side early-abort hook — A1 takes the quorum-side path now; a
  gauntlet-side hook is a possible later refinement.

## 10. Non-goals

- Metered/Vertex/API-key routing for agy (impossible on v1.0.4).
- Scenario tiering, redundant-scenario cuts, parallelism defaults (Stream 2).
- Capture/verdict reliability for non-agy indeterminates (empty-trace,
  stuck-judge) — a separate reliability effort.
- Changing the Gauntlet-Agent (judge) model.
