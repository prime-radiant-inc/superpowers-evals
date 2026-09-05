# PR 2258 parallel comparison preparation

Date: September 5, 2026. Tracking: PRI-3097.

## Question and frozen method

Measure the base/head effect of Superpowers PR 2258 within Codex Astra, Codex
Sol, and Claude Opus 5 on `brainstorming-todo-shared-intent`. This is n=2 on one
case, exploratory evidence rather than a general model ranking. Each comparison
uses base `fd02874aa5c55ba3c2bca431253b48e0e4c8be5a` and head
`069edf3ffc2ffdce80a84d3344a4064acec7e10c`.

The measured cohort is twelve fresh samples, with reserve 0, max_attempts 1,
target capacity six and within-pair exposure skew at most 60 seconds. A separately
registered six-arm n=1 diagnostic precedes measurement and contributes no measured
samples. Neither diagnostic nor measured execution has been launched for this
preparation record. Prior serial pilot results remain in
[the September 4 pilot log](2026-09-04-pr2258-astra-sol-brainstorming.md).

## Staff review and authorization

Sol, Fable, K3 and Qwen independently reviewed the design, then reconciled concrete
source counterexamples. Drew approved amending the spec and beginning source
implementation. The amended
[spec](../superpowers/specs/2026-09-05-pr2258-parallel-comparison-design.md) is
committed at `99206154`; the initial source baseline is `672a0ad2`.

The primary behavioral readout is a preregistered strict-observer pair cohort,
with the generic composed cohort unchanged and a separate denominator. Missing
or disputed evidence stays visible. Independent cosmetic labels bind sealed
artifacts and do not change strict scores. Every measured run needs independent
review before interpretation.

## Source implementation sequence

The first [implementation plan](../superpowers/plans/2026-09-05-pr2258-campaign-foundations.md)
has four independently reviewed tasks:

1. Isolated non-credential-bearing check HOME and a real checks-bearing runner
   publication regression. Preserve manifest exclusions and strict inventory.
2. Repetition-first admission after duration priority, including a real first-six
   controller activation test and total-order coverage.
3. Per-entry unreadable campaign listing, preserving exact/prefix execution
   resolution and historical artifacts.
4. Explicit suite pricing path/digest, verified at registration and worker
   preparation and delivered through the existing read-only Evals mount.

The first three tasks begin from plan commit `163aca3d`; pricing delivery is
planned at `09ba1fb4`. Integration runs in branch
`codex/pr2258-parallel-comparison-impl`. Workers use isolated branches and focused
tests; the controller owns review and the integrated full check.

## Baseline evidence

On the unchanged source in the isolated implementation worktree, `bun run check`
passed lint and typecheck, then ran 3,507 core tests: 3,492 passed, 14 skipped and
one failed by exceeding its 5,000 ms timeout. The failure was
`quorum run embeds linux in run-id when --os linux is explicit` in
`test/cli-run.test.ts`. A focused rerun of the whole CLI test file passed 8/8 in
2.31 seconds without changing source. Preserve the original timeout as a baseline
receipt; do not claim a completely clean initial full check. Dashboard checks
were not reached in that failed invocation.

## Evidence integration dependency

Planning found that Gauntlet's current private-TUI shutdown snapshots bare PIDs,
does not verify final absence after SIGKILL, and can treat process enumeration
failure as an empty list. Gauntlet exit or stable transcript bytes therefore
cannot establish the termination proof required by the amended spec.

The evidence implementation must add an actual Gauntlet-owned, run-bound
lifecycle/containment proof and have Evals validate it before successful observer
finalization. A receipt wrapped around the existing unchecked shutdown is
insufficient. Ambiguous or unproven ownership/termination remains unusable
evidence. The host controller's container-stop proof is a separate acceptance gate.
The five-second hard-kill grace remains unchanged; no partial bundle is published
by omission or completed by hand.

## Remaining qualification gates

Source tests, cross-repository Linux instrument tests, installed appliance proof,
and paid model samples are distinct. Still required after foundation work:

- V2 shared raw adapters/binding, portable finalization, strict scorer/readout,
  authenticated independent-review sidecars, and dialect-aware observer workflow.
- Pinned-build Claude traces covering replay, compaction, split blocks and
  parent/child identity; earlier-build traces alone do not qualify a new build.
- Six-arm declarations and no-spend preflight of every credential projection,
  actual worker pricing, all-pool capacity and supported runtime settings.
- A distinct grader bearer and complete verified pricing for subjects, grader,
  cache buckets and delegates; no values or invented rates are committed here.
- A diagnostic with 3/3 valid pairs, six overlapping exposures, complete observer
  review, no invalidating skew/contention/exposure/telemetry condition, no grader
  429 latch, and reported margins.

No installed changes, credential issuance or paid execution is authorized by
this source-work record. Missing rare-case coverage requires a concrete bounded
qualification request, not automatic extra samples or a waiver into measurement.
Failed diagnostics and incomplete measured pairs remain in the record at equal
billing to successful outcomes.
