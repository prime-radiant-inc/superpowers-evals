# Quorum overhaul program: fast, interpretable, multi-user evals

**Date:** 2026-08-12
**Status:** direction approved (Drew, 2026-08-12); written spec awaiting review; child specs pending
**Tracking:** PRI-2874
**Research brief:** https://claude.ai/code/artifact/c3794032-07aa-405f-88d0-c0587efaa766
**Builds on:**
`2026-06-12-quorum-scheduler-design.md`,
`2026-06-18-shared-eval-appliance-design.md` (adopts Phase 2),
`2026-06-18-dashboard-decoupling-design.md` (honors read-only decision),
`2026-07-09-transient-indeterminate-retry-hang-detect-design.md` (adopts),
`2026-08-09-appliance-results-import-design.md`

## Problem

Quorum's turnaround, interpretability, and single-operator design block
superpowers releases. A release-gate campaign takes ~2 days of appliance
lock-time; by the time results land, the codebase has changed again. Reading a
campaign requires the maintainer to hand-triage run dirs against a 7-pattern
atlas. Nobody but the maintainer can launch runs or read results.

The 2026-08-12 recon (10-agent sweep of 855 runs, all adjacent repos, and the
external SOTA) located the bottleneck precisely:

- Harness overhead outside the LLM drive is a **median 1s per run** (p90 3s).
  The runner is already fast; per-run optimization is a dead end.
- Batches achieve a **median 1.68× effective parallelism** (best ever 4.9×,
  `--jobs` never above 5, appliance `run.lock` allows one job per host). One
  rep of the 504-cell runnable matrix costs ~67 serial hours.
- **sdd-\*** scenarios consume 73% of all wall hours from 23% of runs; the
  slowest cells gate every batch.
- **~1/6 of spend is waste**: 17.5% of runs end indeterminate (opencode 48%),
  59 grader-"investigate" verdicts cost full price for zero signal, 51 runs
  fail at setup after spending nothing but still burning a slot, 30 cells were
  silently dropped by the 429 latch, and 81 run dirs carry no verdict at all.
- The Gauntlet-Agent adds a median 75s per run (34% of drive) and dominates
  short scenarios.

Two doctrine facts shape everything below. First, behavioral base rates are
nonstationary (±25 points within hours), so only contemporaneous paired arms
count as evidence — **parallel capacity is a validity mechanism, not just a
speed win**. Second, run homes persist live OAuth tokens (~65MB of a 68MB run
dir), so **scrubbing at capture time is a prerequisite for every sharing
feature**.

## Success criteria

1. **Release signal inside one working day (critical).** A paired,
   pre-registered release-gate campaign at fresh-gate scale (~390 runs)
   completes start-to-verdict inside one working day. This is the bar
   Workstreams 1, 2, and 7 together must clear.
2. Sentinel tier (~128 cells) completes in ≤2 hours (nice-to-have).
3. A full 504-cell matrix rep completes overnight at Stage 2, faster at
   Stage 3 (nice-to-have).

Capacity math for criterion 1: ~390 runs × mean ~476s ≈ 52 serial hours, so an
8-hour day requires sustained ≥7× effective parallelism — above the best ever
observed. Paired arms run the same agents simultaneously, doubling load on the
same credential pools. Quota engineering (W7) is therefore on the critical
path, not optional hardening.

Wall-clock under parallel load is descriptive only; tokens and dollars remain
the primary comparison metrics (2026-06-10 cost-experiments doctrine).

## Decisions

Recorded from the 2026-08-12 discussion; each binds the child specs.

1. **Staged A+B ("CoA C") with the fleet as a committed destination.** Scale
   the appliance first, but design the Stage-2 supervisor and limiter as the
   front door the Stage-3 Firecracker fleet will use unchanged.
2. **ATIF is the transcript bet.** No Inspect-EvalLog convergence. Spike ATIF
   v1.7 against Harbor RFC 0001 to see whether Harbor-ecosystem trajectory
   viewers render our trajectories for free.
3. **smevals is a contracts donor, not a dependency.** Adopt what fits
   (run/grade decoupling, tags+metrics check vocabulary, `-n` top-up
   sampling, serve/build static-site duality) in quorum's own TypeScript
   schemas. No coordination required.
4. **Runner/grader split is the target architecture.** The runner drives
   interactively and captures; the grader is a separate pass over the frozen
   run dir (transcript plus workspace probes). A parity spike (~50
   known-verdict runs judged offline against their live verdicts) gates
   cutover; fused mode remains the fallback until parity holds. Regraded
   verdicts are always labeled counterfactual and never serve as headline
   evidence unless the campaign pre-registered offline grading.
5. **Rubric-blind driver.** A driver that knows the acceptance criteria leads
   the witness toward graded behaviors. The driver receives an interaction
   script (persona, prompts, pressure moves, evidence-eliciting closers such
   as "show me the test output"); only the grader receives the ACs. Watch
   item: over-blinded drivers may end runs without the evidence the grader
   needs — indeterminate rate is the canary.
6. **Quota engineering is in scope end-to-end**: Bedrock TPM raises, grader
   key pooling or Bedrock grader (PRI-2524), and OAuth→API-key conversions
   where a key path exists.
7. **Jesse is the prototypical second user.** Read and share for certain;
   make launching (through the supervisor, never the dashboard) easy enough
   that he uses it too.

## Constraints that bind every workstream

- No tooling may compare absolute pass rates across batches. Paired
  contemporaneous arms are the only evidence; every rendered rate carries its
  n and cell class (confirmatory/probe/tripwire/descriptive).
- Live evals stay inside the trusted boundary: permissive-mode agent CLIs,
  sensitive transcripts, credential-bearing run homes. Never public CI.
- The dashboard remains a read-only filesystem consumer (Jesse, 2026-06-18).
  Launching belongs to the supervisor.
- Fan-out ships with pinned per-run resources. Anthropic measured 6pp
  benchmark swings from resource configuration alone; unpinned parallelism
  would move the behavioral base rates we measure.
- Provenance hard-gates: no run is pooled or arm-attributed without
  superpowers rev, evals rev, credential identity, and per-harness model-id
  readback.

## Workstreams

Each workstream gets its own child spec and Linear issue before
implementation. Scope lines below bound the child specs; they do not replace
them.

### W1 — Reliability and waste (Stage 1)

Recover the ~1/6 of spend lost to instrument failures.

- Implement the approved transient-indeterminate retry + startup hang-detect
  design (2026-07-09).
- Preflight setup: fail cells before agent spend (51 setup-stage failures in
  corpus).
- Surface gauntlet `run_error` in the composed verdict so a dead grader key
  stops masquerading as a coding-agent capture-indeterminate.
- Replace the batch-lifetime 429 latch with per-limiterKey backoff and retry;
  extend rate-limit detection beyond the antigravity marker.
- Fix the opencode capture path (48% indeterminate).
- Guarantee every run dir ends with a verdict; surface orphans and skipped
  cells in the read side.

Exit: indeterminate rate below 5% on a sentinel batch; zero silently dropped
cells.

### W2 — Scheduling and throughput (Stages 1–2)

The parallelism lever; the supervisor is the fleet's future front door.

- Longest-first scheduling (sdd cells gate batch completion today); per-column
  time caps sized from p90 wall.
- Raise `--jobs` toward credential-cap ceilings; measure per-run host
  footprint to size the box.
- Build the approved Phase 2 supervisor (durable job table, submit/status/
  cancel, named credential bundles), replacing the single-job `run.lock` with
  per-job immutable checkout snapshots and limiterKey-scoped locking.
- Add the cross-process credential accounting the 2026-06-12 scheduler spec
  explicitly punted (shared caps and 429 state across concurrent jobs).
- Scheduler-owned paired-arm interleaving and matched cross-arm backfill, so
  campaign validity does not depend on hand-rolled driver scripts.

Exit: success criterion 1 demonstrated on a real paired campaign.

### W3 — Campaign artifact and report (Stages 1–2)

Kill tea-leaf reading; make the fresh-gate methodology machine-enforced.

- Extend `batch.json` with label, purpose, superpowers-ref-under-test, and
  credential set; make n>1 per cell representable (results.jsonl is
  last-write-wins today).
- `campaign.json`: arms, cells, target n, cell class, pre-registered decision
  rule, committed power/p-value generation.
- `quorum report <batch|campaign> [--vs <baseline>]`: verdict matrix with
  per-cell n, paired deltas with Fisher results, cost and duration roll-ups,
  auto-classified triage pattern (4 of the 7 atlas patterns are
  verdict-shape-classifiable), links into run dirs.
- Adopt smevals-style tags and metrics in check records for faceted reading.
- `-n` top-up semantics in run-all: count determinate runs per cell, execute
  the shortfall, replace indeterminates.

Exit: a release-gate readout produced by `quorum report` with no
hand-computed statistics.

### W4 — Runner/grader split and rubric-blind driver (Stage 2-adjacent; gauntlet upstream)

Decisions 4 and 5. Parity spike first; no cutover until it passes. Includes
per-scenario grader-model routing (`--model agent=` is already per-run) and a
deterministic-checks-only mode for short trigger probes — those two land
regardless of the split's fate and roughly halve triggering-* wall time.

Exit: parity spike verdict published to the experiment log; routing shipped.

### W5 — Dashboard and sharing (Stage 2)

- Scrub-at-capture: exclude live credential material from retained run homes
  (also cuts run dirs ~95%).
- Surface gauntlet's per-criterion verdicts and evidence (result.json v5
  carries them; quorum discards them today).
- Drill-down routes (run, batch, campaign, cell history) behind tailnet-scoped
  access; replace pid-based liveness with heartbeats so the read side
  survives a central results store.
- Static-site export of a batch/campaign (smevals/Inspect `bundle` pattern)
  as the shareable object.
- ATIF trajectory replay (pending the ATIF/Harbor viewer spike from
  decision 2).

Exit: Jesse reads a campaign end-to-end without terminal access.

### W6 — Fleet (Stage 3)

- Everyharness guest image for stockyard (bake-and-pin, cloud-build
  pipeline pattern); one Firecracker VM per run.
- Fire-and-forget job-runner init reading a job spec, uploading the run dir
  to an artifact sink, and powering off (stockyard's exec API remains
  unbuilt; the baked job-runner sidesteps it).
- Distributed credential-scoped limiter preserving limiterKey semantics
  behind the W2 supervisor.
- Enrollment-based multi-user submission (cloud-build bastion pattern).

Exit: success criterion 1 with headroom; per-run hermetic isolation retires
leak-police mode and KI-01.

### W7 — Quota and credentials (cross-cutting; critical path for criterion 1)

- Grader de-single-point-of-failure: key pool or Bedrock grader (PRI-2524) —
  three whole-appliance outages to date trace to the one shared Anthropic key.
- Bedrock TPM raises sized from the capacity model; OAuth→API-key conversions
  for columns that have a key path; per-batch cost caps.
- Fix PRI-2833 (appliance prepare must install deps) before any redesign code
  reaches the box.

Exit: a documented per-column concurrency budget that supports ≥7× sustained
parallelism for the release-gate battery.

## Sequencing

W1 and W7 start first (small, independent, immediately valuable). W2 follows
on W7's budgets; W3 develops in parallel with W2 and must land with it (a
one-day gate nobody can read is not a gate). W4 and W5 proceed as Stage-2
adjacents gated by their spikes. W6 starts only after the W2 supervisor API
stabilizes, and reuses it unchanged.

## Non-goals

- Windows and Antigravity columns stay on their separate trusted-maintainer
  paths; the fleet is Linux/amd64.
- No self-serve access for untrusted users; multi-user means enrolled,
  trusted operators.
- No dashboard launch UI (standing decision, 2026-06-18).
- No fabricated token counts; unpriceable columns stay visibly unpriced.

## Risks

- **Provider quotas are the intrinsic ceiling.** More workers without more
  quota move the bottleneck to 429s. W7 leads W2 for a reason.
- **Faster ≠ valid.** Fan-out without resource pinning and paired-arm
  scheduling would corrupt the measurements it accelerates. W2 carries the
  doctrine, not just the throughput.
- **Grader split parity may fail.** If offline verdicts disagree with live
  ones beyond explainable cases, we keep fused mode and bank the routing wins;
  the program does not depend on the split.
- **OAuth columns cannot fan out.** antigravity, codex-sub, and copilot stay
  serial until account pooling exists; the report must mark their cells
  rather than let them gate batches.
- **Campaign freezes collide with rollout.** Evals main freezes during gates;
  redesign work lands between campaigns, and per-job ref pinning (W2) removes
  the need for freezes entirely.

## Relationship to prior specs

This program adopts the 2026-06-18 appliance Phase 2 supervisor as W2's core,
adopts the 2026-07-09 retry design as W1's core, honors the 2026-06-18
dashboard read-only decision in W5, and amends the 2026-06-12 scheduler spec
by building the cross-process accounting it recorded as an accepted gap. The
2026-08-09 export/import scrub pipeline becomes the basis of W5's
scrub-at-capture. No prior spec is retired.
