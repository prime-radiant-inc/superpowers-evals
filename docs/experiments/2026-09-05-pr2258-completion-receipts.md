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

Tasks 1, 5 and 6 have reviewed source implementations integrated. Tasks 2 and 3
have reviewed source slices, with native parent/descendant qualification still
incomplete. Task 4 and the native capture driver have integrated corrections
that passed scoped re-review. Task 7's first full check found one credential test
fixture omission, now fixed and reviewed. The six-concurrent Linux rehearsal
is being prepared as source; no Linux or native qualification has run.
Tasks 9–11 remain pending. Source implementation/review remains authorized.
Linux qualification, installed changes/credential issuance and provider execution
each await their concrete packet and applicable authorization. No new spending,
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

## Reviewed source integration

Task 2 receipt access passed both scoped fix reviews: the actor can discover
validated receipts through model-visible tool results, and pages fit a 32 KiB
serialized UTF-8 bound even with deep paths. Worker reports 31 capture and
Gauntlet journey tests passing. Integrated source ends at `841a2c28`.
Task 3 reviewed corrections end at `86601219`. Their native authority and
passing cross-dialect/descendant requirements remain open.

Task 6 source is reviewed and integrated through `4fde4c1c`. The second fix
round binds served models to their exact roles, includes scoring and readout
files in the instrument inventory, and requires finite fake-provider start skew
and its margin to the fixed 60-second bound. All review findings are addressed;
worker reports 26 focused tests, typecheck and lint passing. The runtime
projection, served/delegate/cache and quota requirements remain unverified and
are retained as operational gates, including the unchecked runtime proof item
in Task 6. The preflight cannot return ready merely because its source tests pass.

The producer uncovered an existing file-only publisher limitation: required empty
artifact directories would be rejected. The implementation may supply only the
verified bundle's normalized run-relative directory inventory to that existing
check. The mandatory observer gate must authenticate it first. If wrong, unlisted
directories could publish; exact added/deleted/empty-directory tests cover this
ruling without a new manifest schema or optional validation callback.

## Publication, readout and capture preparation

Task 5 independent review approved the four-file implementation with no findings;
its source is integrated as `65899459`. Worker reports 65 focused tests, typecheck
and scoped lint passing. Task 4 centralizes its bundle constant and connects the
flag-only readout CLI.

Task 4 source is integrated through `bae93b8e` for independent review. The worker
reports 442 focused tests across 17 files passing with an explicit 20-second
per-test budget, then four CLI contract tests after correcting positional readout
arguments to the plan's explicit root flags. Earlier broad checks had two default
timeout failures and a test loaded while its implementation was still changing;
the settled-source rerun passed. No production deadline or hard-kill grace changed.
The runner fixtures cover normal and error/stop exits, missing evidence, exact
publication refusal, immutable saved scoring and copied-run replay. These are
local synthetic instrument tests, not native/Linux proof.

Root identity wording in the plan is corrected: the approved binding carries root
paths and selected-source device/inode, while FinalState carries root device/inode.
Root identities must match capture A/B and final live verification. If a stronger
startup-to-finish root-identity guarantee were required, this would not provide
it; the primary spec deliberately claims final-state equality and retains raw
chronology/input receipts as separate duties. Root replacement during capture
or after candidate creation must still refuse. No binding schema was expanded.

The test-only native streaming provider and its cancellation coverage passed
independent review and are integrated through `3d1e76cf`. Worker reports 20 tests
and 323 assertions with real local SDK stream consumers, typecheck and lint
passing. A first ordinary-parent TUI capture driver is integrated as `e79ffa61`
for review; its worker reports 28 tests and 373 assertions using explicit fake
native binaries, real private tmux and localhost only. Its command still requires
an approved isolated Linux environment. Direct native-ELF launch, two text-only
turns and owned-tmux cleanup do not establish wrapper parity, descendant cleanup,
Gauntlet-route equivalence or native grammar qualification.

All source is now assembled for Task 7 checks; Task 4 and driver reviews remain
pending. Native parent/child grammar, actual Linux shutdown, installed projections
and provider execution are still open. No provider call or native session was
started during source preparation.

## Integrated check and review corrections

At `507b9164`, `bun run check` with the pinned local Gauntlet checkout passed
lint and typecheck, then reported **3,908 core passes, 13 skips and one failure**
(21,208 assertions, 262 files). The exhaustive credential delivery test lacked
its new dedicated grader entry. Reviewed correction `48721462`, integrated as
`50c3052a`, adds the exact named environment route; its 96 focused tests passed.
The dashboard stage did not run after that core failure. Separate scenario
validation passed. The complete check must be rerun on settled integrated source.

Twelve skipped tests require real Linux/Docker qualification; the remaining skip
is a Windows PowerShell override test outside this Linux campaign's scope.
Cross-repository Gauntlet and SDK tests ran with the pinned local checkout.

Task 4 review reproduced a real Git fixture publication failure: the original
content-scoped inventory omitted empty `.git` and `node_modules` directories.
Correction `b818648b`, integrated as `0cfd9c2c`, adds a required authenticated
complete artifact directory-only inventory. Worker reports 273 focused passes
plus 42 final-state passes after an additional A/B regression; typecheck and
scoped lint passed. Scoped re-review approved with no open or new findings.

Execution ruling 6: preserve the existing content exclusions while separately
authenticating every artifact directory, including excluded trees. Otherwise
real Git fixtures cannot pass the existing strict publisher. If wrong, directory
metadata or race handling could authorize changed evidence; real scenario setup,
late additions/deletions/replacements and no-follow tests cover this decision.
This extends the earlier verified-directory publication ruling without a new
ordinary manifest schema or compatibility reader.

Native capture driver review found cleanup could be skipped after screen/storage
failure and inventory reads could follow replacement paths. Correction
`eff471fe`, integrated as `3c4044e8`, separates bounded cleanup attempts and uses
pinned descriptor reads. Worker reports 30 passes and 395 assertions, including
actual fake-native PID cleanup and filesystem replacement/growth regressions;
typecheck and scoped lint passed. Scoped re-review approved with no open or new findings. These tests
use generated fake binaries, never installed native subjects.
