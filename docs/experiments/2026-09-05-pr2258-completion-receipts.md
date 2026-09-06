# PR 2258 completion receipts

**Plan:** [All remaining work](../superpowers/plans/2026-09-05-pr2258-completion.md)

**Planning baseline:** `00f4e03d`, branch
`codex/pr2258-parallel-comparison-impl`, clean at inspection on September 5, 2026.
PRI-3097 was read live and remains In Dev. No implementation or qualification
task in the completion plan has been executed by this planning entry.

## Planning evidence

The root inspected the approved design, completed plans and current binding,
raw-adapter, scorer, runner, publisher, cancellation, campaign registration and
report interfaces. Two parallel read-only audits covered scoring/readout and
operations/qualification. Neither audit changed files or ran live operations.

The plan incorporates their execution-critical findings:

- V2 scoring preserves the selected execution method and distinguishes advisory
  from implementation delegation; historical scores remain unchanged.
- The strict cohort uses authenticated committed block selection/validity,
  not the general report's composed `analysis_usable` filter. Required bundle
  members must each authenticate even when general publication identity passes.
- Cancellation reconciliation calls the same required observer publication gate.
- Current pool declarations cannot express arbitrary overlapping account/model
  constraints; preflight verifies both and checks aliases that lower pool caps.
- Exact Linux test enablement, installed campaign commands, pricing projection,
  distinct grader secret and conditional diagnostic/measured approval are explicit.
- Existing registration separates top-level grader from strict SuiteSchema;
  both proposed suite files select the distinct Mantle grader explicitly.

The root completed the specification coverage, interface and placeholder review.
Only documentation changes are part of this planning entry. Source test counts
quoted in the plan are earlier receipts, not reruns or operational proof.

## Execution state

Task 1 is complete. Tasks 2, 3 and 6 have source implementations under review
and correction; Tasks 4 and 5 are implementing against their stable contracts.
A test-only native-provider fixture is preparing Task 8; qualification has not
started. Tasks 7 and 9–11 remain pending. Source implementation/review remains authorized. Linux
qualification, installed changes/credential issuance and provider execution each
await their concrete packet and applicable authorization. No new spending,
provider request, Docker run, installed change, push or merge occurred here.

For each completed task append its commit, test command/results, review and fix
outcomes, evidence references, active authorization and next dependency. Preserve
failures and missing evidence alongside successful receipts. Keep real host/access
details, secrets and raw sensitive traces in private execution evidence.

## Task 1: authoritative binding and bundle contracts

Source `de3bab83` implements strict V2 binding, raw/terminal file inventory and
receipt authentication, plus read-only portable bundle validation. The shared
final-state validator is exported for reuse, without duplicating its schema.
Task specification and code review approved with no blocking findings. A minor
test ambiguity was corrected in `cb549aa9`: distinct score/review members and a
successful control read isolate the evidence-error refusal. Scoped re-review
found that correction addressed with no new breakage.

Worker receipts: 70 focused binding/bundle/final-state tests passed, typecheck,
scoped Biome and diff checks passed. The test-only correction passed all 18 bundle
tests. Reviewers inspected the immutable diff and cited source evidence; these
are reported worker test receipts, not a second full-suite run by reviewers.
Raw semantic validation, score replay, runtime ownership and publisher final
acceptance remain explicit later-task consumers.

## Execution rulings

1. Add `launch_cwd` separately from artifact `workdir`, and install the observer
   in the runner after fixture setup resolves that launch location. Setup cannot
   consume its own unfinished post-setup binding. If wrong, selection or guard
   installation fails; nested-launch-cwd and real setup/guard tests cover it.
2. Give the scorer frozen `raw_sources` instead of caller-created indexes.
   Shorter receipt/review prefixes need the actual raw bytes, and index claims
   cannot establish approval authority. If wrong, consumers require refactoring;
   byte/prefix mutation and chronology tests cover the seam.
3. Constrain the observer's shared-shell route to its supported read/index/private
   review-write CLI commands. The existing capture executable ignored the supplied
   request, so capture alone could not reject a mixed artifact-edit/reply command.
   This fixes the approved guard requirement without a general shell classifier.
   If too restrictive, legitimate observer work would be blocked; actual command
   and Gauntlet-route tests must exercise the complete review journey.

## Read-only and local qualification preparation

Read-only appliance doctor passed, with no run/sync locks and its container
running. Installed campaign listing still returns `config_invalid` on historical
V1 evidence. Installed Evals is clean at `6b9bc68a`; Gauntlet is clean at
`588a81e8`. These observations do not install the new source or qualify its
runtime. No remote mutation, secret value access or provider request occurred.

A local isolated Gauntlet checkout at `588a81e8` was prepared with frozen
dependencies. The existing Codex-shaped cross-repository guard test initially
passed with a missing static UI-template warning. After building the declared UI
artifact, it passed cleanly: one test, two assertions, zero failures. This is a
local baseline, not both-dialect or Linux-container qualification.

Current authoritative pricing research is available for the four primary
model/endpoint combinations. Runtime model IDs/routes, service tiers, delegates,
cache-duration accounting and actual worker snapshot delivery remain required
qualification evidence. The historical pricing snapshot is not reused unchanged.

## Source integration in progress

Task 2 source commits `62525b87`, `e43fa4f7` and `6bd8162c` add bound
source discovery, inspected Codex metadata grammar, private runtime-version
probing and a closed observer command guard. Worker reports 96 focused tests
and 24 runner/provenance tests passing, including the real local Gauntlet
interface. Independent review found that Gauntlet discards successful guard
stdout, preventing the actor from discovering receipt IDs. A bounded receipt
discovery command and model-visible Gauntlet regression are being reviewed.
Claude parent authority and native descendants remain incomplete requirements.

Task 3 source commits `caf19764` and `918664d1` implement V2 raw-byte chronology
and preserve known violations alongside unknown evidence. Independent review
found stale completion after later approval invalidation. Correction `81596618`
clears current completion when its prerequisite chain changes; reapproval alone
cannot restore completion. Seven failing regression cases became green; the
worker reports 72 scorer tests, typecheck and scoped lint passing. Scoped review
marked the finding addressed with no new actionable breakage. Full Task 3
acceptance still requires passing native Claude parity and descendant chronology.

Task 6 commits `2efa6e95` and `9bbb03b2` declare the two suites, Claude arms,
separate public grader configuration, verified pricing and non-launching
preflight. Review found conflated diagnostic/measured gates, unauthenticated
qualification claims and duplicate model-capacity rows. The correction separates
capability gates from reviewed diagnostic GO, authenticates explicit receipt
artifacts and rejects duplicates. The worker reports 22 focused tests plus the
first-six controller regression, seven pricing checks, lint, typecheck and
scenario validation passing. Scoped re-review is pending.

All counts above are worker receipts, not reviewer reruns or operational proof.
The integrated full check and whole-change review remain Task 7. No source slice
listed here authorizes launch.

A read-only version refresh found installed Codex `0.146.0`, Claude `2.1.209`
and Bun `1.3.14`. The running image matches the earlier privately recorded
image digest. These are runtime inventory facts, not native grammar evidence.
The existing fake provider only drives non-streaming Gauntlet requests; a small
test-only streaming provider is being implemented to support native CLI capture
without inference spending. Linux capture still requires its concrete gate.
