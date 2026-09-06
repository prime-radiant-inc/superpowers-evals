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

The second authorized six-attempt diagnostic completed on September 6 at
`2026-09-06T07:20:57.776Z`, campaign
`4e5de280-cab9-4bdc-bda6-4620dd325e68`. Its frozen installed source is
`d682f776`; all six results are unusable and all three strict pairs are missing.
Shutdown is verified. The decision is **NO-GO**, and no measured attempt has
started. The first failed diagnostic remains separately preserved.

The smallest observed Claude production-metadata correction is committed at
`9a7c60b5` and independently reviewed. It is a local source correction, not
installed qualification. Codex still lacks sufficient native result provenance;
see the second diagnostic receipt below. No further paid attempt is authorized
by this receipt. The full comparison remains incomplete.

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

## Six-concurrent rehearsal source

Source commits `523b9e65` and `8063a2e9`, integrated as `f065eeb2` and
`294513c2`, extend the existing gated Linux fixture to six distinct attempts
across three paired blocks. A test-only final-response gate waits for all six
exact attempt witnesses; Docker lifetime intervals must share a common instant.
The fixture checks separate homes, tmux mounts, output roots and namespaces,
then exact termination, publication and cleanup. Its generated fake subject and
scripted grader do not qualify either native observer dialect.

Independent task specification and quality review passed without findings.
Worker reports nine portable passes, twelve Linux skips and 262 assertions;
typecheck, scoped lint and scenario validation passed. The actual HTTP/container
rehearsal, resource margins and failure cleanup remain Gate A evidence.
Fresh whole-branch specification and code reviews cover integrated `294513c2`;
full checks on that source passed as recorded below.

## Integrated check at 294513c2

Observed `GAUNTLET_ROOT` set to the isolated Gauntlet checkout at `588a81e8`,
then `bun run check`: exit 0. Biome and TypeScript passed; **3,937 core tests
passed, 13 skipped, zero failed** across 262 files (216.91 seconds). The dashboard
check also ran and passed: **144 tests, zero failures** across eight files.
Separate `bun run quorum check` exited 0. The twelve Linux skips and one Windows
skip listed above remain unqualified; no skipped test is counted as passed.

Final specification/code review is still in progress. Both reviewers have
identified a source-revision preflight gap: mutually consistent receipt strings
and the observer file list do not authenticate the actual executing checkout.
Its correction belongs to the final combined fix wave; green tests do not waive
that finding. Source and dependent qualification pins must be refreshed afterward.

## Final whole-branch review

Fresh specification and code reviewers inspected `672a0ad2..294513c2` and
requested changes. Their combined list has four Important source defects:
actual executing checkout identity/bytes were not authenticated against the
reviewed Evals SHA; selected credentials sharing a compiled quota pool were
not summed; duplicate account identities could split aggregate demand into
separately checked rows; and unbounded observer index/member responses could
exceed the pinned Gauntlet 64 KiB stdout cap. No Critical or Minor finding was
raised. All six recorded architectural rulings were accepted.

One fresh implementer owns the combined correction wave from `02411699`, with
behavioral regressions and one scoped re-review afterward. The review confirms
the candidate/shutdown/publication, immutable replay and strict/general readout
boundaries as coherent with the selected design, while preserving the separate
native and operational acceptance gaps. Source is not yet ready for qualification.

## Reviewed final correction and integrated evidence

The combined source correction is integrated as `04991f4f` and `08eb2b62`.
Preflight now authenticates the complete executing Git tree before and after
receipt intake, including modifications hidden by index flags. It sums subject
and grader demand by actual pool identity and rejects duplicate account rows.
Observer reads use authenticated continuation with complete content hashes and
a measured 32 KiB serialized envelope. Readable UTF-8 chunks and an exact
`receipt-content` view expose saved approval revisions through the closed guard.
No arbitrary shell route or scoring/campaign change was added.

Worker reports 68 focused source passes and five actual pinned-Gauntlet
integration passes. The latter exercises large indexes, individual call/result
payloads, documents, raw receipts and earlier saved revisions through the real
local tool transport. Initial truncated-JSON and readability failures are retained
in the private logs, as are an existing five-second test timeout during concurrent
suites and its unchanged-timeout sequential pass.

The sole final scoped review marked all four Important findings addressed and
found one Minor: the default UTF-8 decoder could omit a leading BOM, including
at a page boundary. Correction `f399d517`, integrated as `35312e0f`, changes the
shared decoder option and adds both regressions. Worker observed two RED failures,
then seven focused passes (301 assertions), typecheck and scoped lint passing.
The BOM-only review passed with no residual or new finding. Other decoders and
native transcript grammar are unchanged.

Execution ruling 7: apply Drew's explicit standing instruction to fix discovered
bugs immediately to this narrow BOM correction, rather than defer it under the
skill's final-wave guideline. User instructions take precedence over skill
guidance. If wrong, this adds a small verification pass beyond the planned review
budget; leaving it would knowingly retain broken readable-byte fidelity. No
second broad review or unrelated correction wave was opened.

Root-observed integrated `bun run check` at `08eb2b62`: **3,953 core passes,
13 skips, zero failures**, 21,849 assertions across 262 files (236.80 seconds),
plus **144 dashboard passes, zero failures**. Biome and TypeScript passed.
Separate scenario validation exited 0. The actual Gauntlet file ran all five
cases using `588a81e8`. The subsequent one-option BOM change is covered by its
focused tests/typecheck/lint and review above; the entire suite was not repeated
for that narrow correction. Twelve Linux tests and one Windows test remain
skipped and are not qualification evidence.

## Concrete Gate A preparation

The private packet selects the existing appliance, existing image and exact
Gauntlet/Superpowers source, a new detached source namespace, frozen dependency
installs with clean credentials, all twelve gated Linux tests, the five-case
Gauntlet guard file, and two sequential no-network native parent captures.
Only ordinary package-registry access is included in dependency preparation.
The existing six-way fixture has 24 GiB aggregate tmpfs capacity and no CPU,
memory or PID cap; the requested approval must include that actual footprint.
The native captures have explicit smaller resources, client deadlines, private
output retention and exact container teardown. They do not establish every
native rare case or descendant chronology.

Static shell checks initially passed while operational review still found four
command defects: bundle verification cwd, stale Gauntlet case count, conditional
shell error handling during copy, and unbounded Docker clients. Two scoped
packet correction passes resolved those findings and their fix-introduced
function-timeout/copy-budget/cleanup-write issues. Final packet review approved
with no open findings. All nine shell blocks passed syntax and ShellCheck;
these are preparation receipts, not executed cleanup proof. The final source
pin, bundle/config digests and concrete authorization request stay private.

Gate B remains unprepared because it requires actual Linux qualification receipts
and the exact resulting installed/source/image/credential change packet. Neither
Gate A preparation nor green source checks authorizes that work or provider
spending. No diagnostic or measured attempt has started.

## Approved diagnostic-first execution

Drew asked why rehearsal should precede real runs and approved the proposed
short plumbing check → minimum capture fixes → six real diagnostic attempts →
twelve fresh measured attempts once scoring is trustworthy. This supersedes the
large Gate A rehearsal as a diagnostic prerequisite. Counts, zero retries, exact
refs, credential separation, strict scoring and finite runtime remain unchanged.

The selected appliance doctor was healthy and idle. A detached copy of reviewed
source `a074608f` was staged privately; dependency installation succeeded. Only
the two prepared native parent captures were selected, omitting the twelve-case
fault matrix and already completed local Gauntlet suite. No provider was called.

The first export failed: Docker copy returned success but omitted the mounted
tmpfs capture contents. A small real-container witness reproduced this behavior:
the file was visible inside the running container and via a tar stream executed
inside it, but absent from Docker copy. Exact container cleanup succeeded. The
private capture command now exports through the running container's mount
namespace and requires its completion file before accepting the exported bytes.
This is an operational plumbing correction, not a scoring or production runtime
change; the original failed receipt is retained.

Native captures exposed additional startup assumptions before any subject input:
Codex creates temporary launcher symlinks, and Claude sends a `HEAD /` health
probe. The capture helper originally refused both. Codex symlink inventory is
now metadata-only without dereferencing; focused capture tests passed. A later
Codex attempt showed live HOME writes racing the helper's immutable inventory
and an unseeded directory-trust prompt. These are capture-helper defects being
corrected; no native grammar or successful diagnostic is claimed from them.
All created capture/probe containers were absent after cleanup verification.

Diagnostic preflight now reports missing native chronology and fake parallel
proof as explicit gaps. Scoped review required retaining known timing violations
as blockers; that correction remains tracked separately until integrated.
The subject credential channels are present; the dedicated Mantle grader bearer
is absent from the selected blessed bundle. Only names/presence and inequality
booleans were inspected; no secret values are recorded here. Drew was asked for
an existing secret-store reference while independent source work continues.

## Native capture and minimum source completion

Both inspected builds now completed two actual typed parent turns using the
bounded local fake provider: Codex `0.146.0` (21 raw rows, two eligible inputs)
and Claude `2.1.209` (13 raw rows, two eligible inputs). Both captures reported
`captured`, stopped cleanup, two accepted model requests and no receipt failures.
The original private raw bytes replay through the matching native adapters;
redacted fixtures preserve observed record structure. These text-only captures
establish parent startup/continuation and shutdown, not physical tool effects,
subagents, provider service, or the full six-attempt campaign path.

The capture fixes cover metadata-only symlink inventory, stable post-stop
inventory and actual tmpfs bounds, directory trust/onboarding, the exact health
and messages routes, opaque unused tool catalogs, completed SSE cancellation,
and disabling the inspected native Claude title request. Earlier refused
captures are retained with equal visibility. No paid inference was used.

Native adapters now select the exact inspected builds and preserve their known
context metadata while retaining identity and unknown-action refusals. Claude's
later typed inputs require the preceding trusted UUID chain; review found and
corrected a missing-UUID chain bypass in `b1e2be7b`. Scoped re-review closed the
finding with no new findings. The scenario now admits Claude as well as Codex.
Diagnostic preflight exposes unobserved chronology/parallelism as gaps while
still blocking known timing violations. Measured requirements remain unchanged.

`00798a4c` fixes installed registration to freeze the executing Evals checkout,
with a real-Git regression proving it cannot silently select older origin/main.
The minimum installation packet uses existing mutation and registration locks,
a fast-forward, unchanged dependencies/image/config/helper/results paths, and
installed provider-free checks. Historical campaign records remain preserved.

Root-observed full `bun run check`: **4,011 core passes, 13 skips, zero failures**,
plus **144 dashboard passes, zero failures**; Biome and TypeScript passed.
This run started at `77439cca`; final narrow fixes were separately verified at
`00798a4c` with **126 focused passes, 726 assertions, zero failures**, followed by
passing typecheck and scenario validation. The deferred Linux fault tests and
Windows test remain skipped; they are not operational evidence.

Current official account quota reads show Mantle Opus 5 input/output limits of
20M/2M tokens per minute and Sonnet 5 limits of 3M/300K. These token quotas do not
prove six-way overlap or provider success. The selected bundle has subject
credentials but lacks the dedicated grader bearer. Its existing secret-store
reference is requested from Drew; no subject credential is substituted and no
new credential is issued. Independent installed preparation continues.

## Installed minimum update

The selected appliance fast-forwarded its existing clean branch from `6b9bc68a`
to `0d6eae90` under the existing mutation locks and registration lease. Config,
helper, remote branch reference and all historical campaign document hashes
remained unchanged; the image and dependency manifests matched the reviewed
pins. The installed source stayed clean. Doctor passed during the update and
afterward, with run/sync locks released. No provider was called.

The installed focused regressions passed: **2 tests, 21 assertions, zero failures**
for mixed historical listing and freezing installed source despite older
origin/main. A distinct provider-free command-check registration then froze
`0d6eae90` and Gauntlet `588a81e8`, six planned slots, zero reserves and the exact
Sonnet grader. Installed status reported registered; costs reported zero attempts.
Exact cancellation correctly refused because no start was consumed, and the
behavioral report correctly refused registered state. This proves those command
boundaries, not cancellation of an active controller. The unused identity and all
historical evidence remain preserved; it is not a diagnostic sample.

Remaining diagnostic preparation is explicit: obtain the dedicated grader secret
reference, verify actual six-arm credential projections/cleanup and prepared
runtime settings, authenticate installed pricing and minimum-boundary receipts,
and substantiate account/model capacity without treating TPM as concurrency.
Codex's scenario fragment already requests `xhigh`; verify its actual prepared
HOME rather than adding another configuration mechanism. Assemble and execute
the reviewed installed preflight only when these claims have supporting evidence.
Full native chronology and observed parallel overlap remain diagnostic gaps.
There is no diagnostic GO, provider attempt, measured result, push or merge.

## Correction: existing shared Mantle authentication

Drew challenged the request for a new grader key because Bedrock evaluations
already work. Investigation confirmed the July Mantle implementation and the
September 2 campaign's 136 completed attempts using Opus subjects and Sonnet
Mantle grading. This was not missing Bedrock support or an IMDS migration.

The parent campaign V2 design explicitly allows a shared secret member. Its
attempt-worker skeleton instead reused Phase 1's all-pairs secret-inequality
check. The PR 2258 plan then introduced a new grader key to satisfy that check,
creating an unnecessary operator dependency. The earlier requests for a separate
secret and proposed IAM investigation were incorrect diagnoses, retained above
as history rather than current instructions.

The correction restores the explicitly shared regional Mantle source in the
campaign path. It permits only matching selected source names, Mantle bearer
auth and region; other collisions remain refused. The existing Phase 1 check
is unchanged. The six-arm suites use `sonnet5_bedrock`, and preflight verifies
actual shared-source delivery plus one aggregate AWS account receipt. No new
credential, SDK, endpoint, IMDS access or IAM policy is introduced. Shared auth
means shared provider authority, not isolation established by different bytes.

A regression first reproduced the equality rejection through genuine V2
container preparation. After the fix, both consumer environments carry their
intended values, grader-only settings stay out of the subject environment,
public runtime authority contains no secret, and exact stage cleanup succeeds.
Equal-value aliases and cross-region sharing remain rejected. The combined
projection/preflight suite passed 82 tests and 276 assertions. Final review and
installed projection verification follow before claiming operational resolution.

### Shared Mantle correction: reviewed and installed

Source `4635f4ae` passed scoped independent review with no actionable findings.
Root-observed `bun run check` at that immutable source passed **4,017 core tests,
13 skips, zero failures**, plus **144 dashboard tests, zero failures**; Biome
and TypeScript passed. Focused projection/preflight/credential coverage passed
205 tests and 647 assertions. Scenario validation passed. The deferred Linux
fault tests and Windows test remain skipped.

The existing appliance source fast-forwarded from `0d6eae90` to `4635f4ae`
under the reviewed mutation and registration locks. Installed health/listing
checks passed, and configuration/helper/image/dependencies/historical campaign
records remained preserved. The existing blessed credential bundle was read,
not changed.

A separately reviewed no-provider probe invoked the installed production
`prepareAttemptStage` for all six exact suite arms, with the selected Sonnet
Mantle grader, then the real grader environment mapping. **All six projections
passed and all six private credential stages were verified removed.** Both
Claude arms deliberately shared the existing Mantle source with the grader;
the four OpenAI arms retained their own source. Grader-only settings stayed
out of the subject environment. The receipt contains names and booleans only;
no secret values or hashes were recorded. Final doctor passed and run/sync
locks were missing.

This closes the claimed missing-key blocker and verifies installed credential
preparation/mapping, not a new provider authentication request or running
container consumption. No inference request, diagnostic sample or measured
sample was launched by this correction. Continue the remaining installed
settings/pricing/capacity evidence and diagnostic receipt packaging with the
existing credentials; do not request the withdrawn PR-specific grader key.

## Diagnostic capacity and execution authorization

Drew approved completing the remaining installed checks and starting the six
diagnostic attempts, followed by twelve fresh measured attempts only after
trustworthy diagnostic GO. No replacement or extra provider probes are included.

Source `195fb773` records unverified capacity in declared account/model rows as
diagnostic qualification gaps. It does not infer concurrency from token quotas.
Verified insufficient capacity, missing declarations, duplicate/grouping errors
and compiled scheduler constraints remain blockers. Measured admission still
requires capacity qualification. Independent bounded review found no actionable
issues; root observed **55 tests, 158 assertions, zero failures** and a passing
TypeScript check. This changes readiness classification, not the experiment's
models, six-attempt count, concurrency caps, timing or pricing.

## First six-attempt diagnostic: NO-GO

Frozen source `c3e1c440b1042de9becd6762dd3911824822447a` was installed under
owned mutation/registration locks. Six current-source credential projections
passed and cleaned up. Actual worker-image adapter/launcher/skill/pricing
verification passed at unchanged production source `4635f4ae`; the final packet
preserves that original execution identity and authenticates the source-byte
applicability. The independent packet audit found no corrections. Installed
preflight reported ready with no blockers and twelve explicit diagnostic gaps.

The installed helper registered and launched campaign
`d3871573-98b6-41f1-ae27-737f84c7658c`, input digest
`c5a52e05dd9049681b18d32634e0053123816b4e6c570217f5b02f0686e7e5bc`.
Readback matched six slots, three n=1 pairs, zero reserves, the frozen pins,
existing shared Mantle grader, pricing and 2,400-second attempt bounds. All six
attempt containers ran concurrently. This container observation does not prove
six overlapping subject exposure intervals.

The campaign ran from `2026-09-06T06:24:14.351Z` to
`2026-09-06T06:29:34.511Z`: **320.16 seconds**. The terminal report verifies
shutdown, but is incomplete: **six unusable results, zero valid pairs**. All
blocks were excluded for exposure and lacked final positive validity and bound
publication evidence. Strict readout has `interpretation_ready: false`.
No measured attempt or replacement diagnostic was launched.

Preserved worker outputs locate the observed failure:

- All four Codex workers: `observer finalization: Response item type is not recognized.`
  Native 0.146.0 output includes reasoning response items, reasoning events and
  non-null message phases outside the observer's inspected dialect.
- Both Claude workers: `observer finalization: Claude source has no inspected native parent input.`
  Native 2.1.209 typed input follows startup-hook attachments via `parentUuid`;
  the observer incorrectly requires that first human input to have a null parent.
  Actual startup/permission metadata and an absent `lastPrompt` field also need
  narrowly validated dialect support.
- Both Claude trajectories report `claude-opus-5`; the frozen snapshot only has
  `anthropic.claude-opus-5`. Those subject costs are explicitly unpriced.

Existing native output and nonzero token records establish real subject model
work for both providers, including the existing Mantle route. All grader usage
sidecars retain `anthropic.claude-sonnet-5`. This was not a missing-credential
failure. Canonical accounting has **zero observed cost records**, which means
missing costs, not zero spend. Four unpublished Codex usage files contain a
known estimated subtotal of **$1.2355374**, excluding both Claude subjects and
all graders; this is diagnostic context, not a repaired campaign total.

Private exact-byte report digests:

- Canonical helper response: `aef5d5b9a2b1fa93ca9b49bc7477ace7ba0f5bbb175bc7340d785930ab2a066b`.
- Strict readout: `1be21ee40db72296da59e3445755effae92056d366587782be7918c9619b71e0`.
- Redacted worker error inventory: `cd1c3d0da2af4854faaabb71ec632b0048dbfb445db412aee243387504025817`.

Historical staging, logs, manifests, pricing and results remain unchanged.
The observed parser and served-ID pricing corrections are being developed and
verified offline. Any subsequent diagnostic requires a fresh frozen source,
qualification packet and registered identity; these attempts cannot be repaired
into valid samples or counted as measured results.

### Observed dialect corrections: source verified

The Codex correction (`e0adcebb`) accepts the inspected 0.146.0 reasoning
response/event records and commentary/final-answer message phases. Reasoning
remains non-action metadata. Claude (`f66f435b`) validates the observed
SessionStart hook root and linked native typed input, omitted initial
`lastPrompt`, and empty command-permissions metadata. Hooks cannot grant
approval, and unknown variants, broken chains, SDK inputs and sidechains remain
refused. Privacy-safe reduced fixtures preserve record structure and provenance
without original content. Tests reproduced the actual refusals before fixes.

Pricing (`c5d31690`) covers the observed `claude-opus-5` ID only within this
experiment's selected Mantle route. Preflight (`6685f3a6`) requires that exact
observed ID in measured evidence and pricing coverage for both requested and
native IDs. It does not rewrite served IDs or accept generic aliases. Future
suite pricing digest is
`609f6cbb26be00d29be02614c22abeeb556c9d2235f53d1e830b949cca3b1c6f`.

Independent reviews found no actionable issues in these corrections. Root's
combined `bun run check` passed **4,050 core tests, 17 qualification/platform
skips, zero failures**, plus **144 dashboard tests, zero failures**; Biome and
TypeScript passed. Scenario validation passed. Eight real accounting probes
include tier boundaries, cache durations, the observed native ID and unknown
model refusal. These are source checks; installed image verification follows.

The diagnostic NO-GO is final. A new six-attempt diagnostic needs fresh approval,
source/instrument/pricing binding and registration; no sample is repaired or
reused. A repeat of the observed token activity is a planning estimate of about
**$4.69 for six attempts**, conservatively pricing Claude cache creation entirely
at one-hour rates. Future behavior may differ substantially and the 40-minute
bound is not a dollar cap. This estimate is not a repaired historical cost total.

Measured admission still requires trustworthy complete evidence. In particular,
the current preflight's explicitly fake-provider capacity/overlap fields cannot
honestly be satisfied by relabeling live diagnostic observations. Complete
native chronology, remaining capability evidence and diagnostic GO stay open;
source fixes alone do not establish measured readiness.


## September 6: second authorized diagnostic, NO-GO

Drew's subsequent “do it” was explicitly acknowledged as approval for one fresh
six-attempt set after the first set's corrections. No historical attempt was
reused. Installed preflight returned ready with zero blockers and twelve declared
qualification gaps. The helper registered and launched exactly once: six slots,
three n=1 pairs, zero reserves, one attempt per slot, cap six, 60-second skew
bound and 2,400-second attempt ceiling.

Campaign `4e5de280-cab9-4bdc-bda6-4620dd325e68` freezes Evals
`d682f776497d990b57d7cb6e4f15905c551e0c7a`, Gauntlet
`588a81e80fe3cd7b7d3bc2c7f4207bed4ecb14df`, existing shared Mantle
Sonnet 5 grader, the unchanged base/head Superpowers revisions and pricing digest
`609f6cbb26be00d29be02614c22abeeb556c9d2235f53d1e830b949cca3b1c6f`.
Input digest is
`98d1b00b220fb19bdc0194f188a8cf2fd339726e76119c48a9c7ac3cd53c9320`.

It ran from `2026-09-06T07:12:07.762Z` to `2026-09-06T07:20:57.776Z`
(**530.014 seconds**). Canonical report: completed, termination verified,
complete false, **six unusable attempts, zero valid pairs out of three**.
Strict readout has `interpretation_ready: false`. All pairs lack final positive
validity and authenticated publication and are excluded for exposure. Initial
observation of all six containers running together does not establish six
complete overlapping subject exposure intervals. Doctor reports both appliance
locks released and the shared appliance healthy.

Both Claude workers refused `permissionMode: bypassPermissions`. The isolated
capture driver selected `dontAsk`; production selects
`--dangerously-skip-permissions`. The observer therefore overfit its capture
configuration. Commit `9a7c60b5` accepts the observed scalar within the existing
closed metadata shape. It retains session/build checks, action rejection and
parent authority. The implementer replayed both unchanged stopped 27-row traces
successfully and discovered no further parser blocker. Independent review found
no actionable issues and passed 45 focused tests; its production replay claim
is explicitly reported, while its fixture replays were independently witnessed.
No campaign evidence was changed or repaired into a usable score.

All four Codex workers refused an event outside the inspected dialect. The
read-only diagnostic found interruption metadata, web-search completion events
and nested patch results. In both Sol traces, `patch_apply_end.call_id` differs
from the enclosing execution call ID; the outer command invokes `apply_patch`,
but the records inspected so far do not explicitly link the nested result ID.
Discarding the patch result as harmless metadata would lose a physical-effect
witness. Adjacency is insufficient proof for assigning it to the outer call.
The remaining native relationship must be established or represented explicitly
as unresolved evidence before this instrument can qualify. No Codex parser
relaxation or invented ID mapping was applied. Web completion has an explicit
ID match to the following native web-call record, but the current index requires
results to follow their calls. Its representation also needs to preserve both
physical anchors without duplicate actions or synthetic chronology. The short
text-only qualification did not establish either production action/result path.

Canonical subject and grader accounting each have zero observed records out of
six: costs are missing, not zero. Separately preserved unpublished usage has
six priced subject estimates totaling **$3.2524458** and six grader sidecars
estimated at **$2.57307094** using the campaign's frozen rates, including recorded
5-minute versus 1-hour cache creation. Their combined **$5.82551674** is a
supplemental estimate, not an invoice or repaired canonical campaign total.
No subject model is unpriced in these sidecars. The grader records all name
`anthropic.claude-sonnet-5`; no new credential failure was observed.

Private receipts are under the plan workspace's `diagnostic-r2-20260906/`:
registration, launch, status, report, costs, strict readout, terminal doctor,
per-attempt unpublished usage, supplemental arithmetic, and both adapter
diagnoses. Exact-byte digests:

- Canonical helper report: `93fe433f6370a01b53c997a301efe2c81f32b29db19d59fcf3c3b3787167f250`.
- Strict readout: `b36d050c525a4fb0279465f704728ef6177ed229e71d7e16e78f8668f7ba0303`.
- Supplemental cost estimate: `177eec7ed401392e028a9627f519b70919a73101d4138b6b80da2341fa652451`.

This diagnostic is final NO-GO. Independent behavioral call review cannot make
missing authenticated bundles usable, so no review set or behavioral comparison
was fabricated. No measured run, replacement diagnostic, provider probe, source
installation, push or merge followed it. Remaining work is the Codex native
result relationship, production-path qualification of the resulting instrument,
then an explicitly approved fresh diagnostic and conditional measured run.


Final root verification after `9a7c60b5`: `bun run check` passed Biome and
TypeScript, **4,052 core tests, 17 explicit skips, zero failures**, plus **144
dashboard tests, zero failures**. Scenario validation and `git diff --check`
passed. Independent receipt review found no mismatch in campaign counts, timing,
cost arithmetic, missingness, digests or the NO-GO conclusion. These checks do
not close installed/native qualification or authorize another live attempt.


A bounded follow-up inspected the official Codex `rust-v0.146.0` release source
at `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`. Nested Code Mode calls receive
new `exec-<UUIDv4>` IDs by design. Ordinary patch-end records omit the enclosing
exec ID. A separate rollout-trace format has the needed chain:
`ToolCallStarted.requester.CodeCell(runtime_cell_id)` joins
`CodeCellStarted.model_visible_call_id`. Native web-end events explicitly reuse
the web item ID. This identifies a possible existing capture mechanism rather
than a reason to guess parentage or weaken scoring. Availability, enablement,
retention and authentication of that separate trace in the actual attempt path
remain to be verified before implementation or another diagnostic.

## September 6: offline native trace qualification

Drew approved the bounded native capture, replay and instrument integration after
the second diagnostic. All native probes used the selected appliance through
Tailscale SSH, the unchanged pinned image, a network-disabled container and a
deterministic local Responses endpoint. No provider calls, credential changes or
additional campaign attempts were made. The failed campaigns remain unchanged.

Codex 0.146.0 produced the required explicit chain when its optional native trace
root was enabled. The final probe used an exact archive of source
`b697c879a2ce5324cad4923229aec8301c630f4a`; all 1,365 transferred source-file
hashes matched. The native ELF digest remained
`2e863156ed35ecc5253b1e2f907a9143077b9f7cb51942070c61996471ff6e04` and image
`sha256:500e28caf737a820c3f30f21f757b089b8d548081e714e1a20dff1a82de37691`.
The successful nested patch capture has 27 contiguous native trace rows and 19
payloads. Its archive digest is
`7a540ef255f540f4ec8ce47dd8a9d760f98e630955d21242947636bde0572242`.
The file written by the native patch matched the expected bytes. Process exit,
container removal and release of owned appliance locks were verified.

An earlier probe retained a real failed patch and its explicit parent chain.
Another deliberately invalid trace-root path demonstrated that the native writer
fails open: ordinary turns completed without a trace bundle. Successful CLI exit
or setting the environment variable therefore does not qualify observer evidence.
Earlier exploratory driver overlays are recorded separately from the final
committed-byte capture.

Source commits `e8071d52` and `b697c879` provide the reusable nested capture;
`a1808653` binds and authenticates the private trace root, supporting files and
historical byte prefixes through the existing observer pipeline; `b8b90f8f`
validates the explicit native joins; `25ed32c5` retains the complete patch result
on its existing parent action. The production env-i launcher test executes the
real launcher with a fake CLI and verifies the private trace-root injection and
removal of an inherited host value. Portable bundle tests consume retained bytes
after removal of the original home. These are source integration checks, distinct
from the native serializer capture and installed execution evidence.

Local replay of the complete failed, initial successful and final successful raw
captures gives one canonical outer action at line 11, the unchanged native patch
result at line 12 and the separate wrapper result at line 13. Failed versus
successful payloads are preserved. Removing the trace refuses the nested result;
no parent ID is inferred from adjacency. Supplementary trace validation covers
required joins and consistency, not every possible native event kind. Unknown
ordinary action-bearing records remain errors.

Commit `d3bbcce0` separately preserves the native web completion records and
interruption metadata. Exact-byte replays of the historical Astra base/head
captures parse all 81/83 rows. Head web anchors are 64→65, 70→71 and 77→78,
retaining both payloads. The end-event descriptor is not an inferred initiation
time. Historical Sol base/head bytes still refuse at their first patch results,
lines 95/135, because those runs never captured the required native trace. These
replays did not invoke the scorer or repair either campaign.

Independent review initially returned REVISE for ordinary replay handling,
contradictory native lifecycle/input evidence and a historical receipt that could
omit required supporting prefixes. Those negative findings and their original
passing-test counts are retained in the private review reports; final fix and
verification evidence is recorded below. No source-test result alone establishes
three valid diagnostic pairs or authorizes the measured campaign.

Private receipts are under `diagnostic-r3-offline/` in the plan workspace:
`codex-trace-report.md`, `codex-trace-final/verification.json`,
`native-patch-replay.json`, `codex-web-replay.json`,
`codex-missing-trace-replay.json`, `trace-link-review.md` and
`trace-auth-review.md`. Raw native captures and appliance run homes remain private.

The review findings were fixed in `b91d433d` and `435f073f`. Historical receipt
replay now reconstructs only the recorded main and supporting byte prefixes;
the original omitted-support/recomputed-envelope reproduction is refused.
Canonical ordinary replays retain their first anchors. Present cell/turn
lifecycle records and invocation previews must agree with required native
dispatch evidence. Normal turn completion does not terminate a yielded cell.
Independent bounded re-reviews found no remaining actionable findings in those
fixes: 229 authentication/receipt tests and 82 native parser/dispatcher tests
passed. The negative reports are retained beside `trace-auth-fix-review.md` and
`trace-link-fix-review.md`. Root also reran all three complete native captures
and both unchanged historical Astra captures successfully after the fixes.

Final combined source verification after `435f073f`: `bun run check` passed
Biome, TypeScript, **4,189 core tests, 17 explicit skips, zero failures**, and
**144 dashboard tests, zero failures**. Scenario validation and `git diff --check`
passed. Logs are `final-integration-check.log` and `final-scenario-check.log`.
The skips remain explicit; they are not qualification receipts. A fresh
diagnostic still needs a new frozen instrument and registered identity, and its
three valid pairs and full evidence review remain prerequisites for measurement.

### Installed verification: NO-GO

The exact clean source `2375580d927b7a93d430ee3a489918224e36b1e1` was transferred
as a verified Git bundle and fast-forwarded from `d682f776` on the appliance under
the installed mutation locks and campaign registration fence. The image,
dependency files, helper, configuration, origin tracking ref and historical
campaign manifests were preserved. Installed registration/listing tests passed.
The overall installation verification did **not** pass, and its success receipt
was not created. The source remains installed; it was not rolled back or marked
qualified.

The first network-disabled pinned-image check passed 370 tests and failed two
launcher tests. A separate probe confirmed that Docker's `/tmp` mount is
`noexec`: executing a temporary shell file returned `EACCES`, while the same
file in the existing private output bind mount executed successfully. Running
the suite with that executable private scratch fixed the launcher tests. The
second check again passed 370 tests but failed two different existing checks:
byte-identical source replacement after freeze and replacement of a previously
bound parent source.

These second failures are a real observer contract gap. The native filesystem
probe immediately unlinked and recreated a byte-identical regular file and
observed the same device, inode, birth time, change time and modification time.
The subsequent same-tick append changed its size but left the recorded times
equal. The observer persists device/inode and content hashes; timestamps only
protect an individual read. Neither that persisted identity nor an added birth
timestamp can prove original-file continuity in this reproduced case. The
approved design explicitly forbids replaced sources supplying approvals.
Moving tests to a filesystem that does not reproduce reuse would hide the gap.

Durably retaining the original file through post-worker-exit verification is a
new ownership decision. Private retained hard links are a candidate for regular
files; a worker-owned open descriptor dies before controller verification, while
controller-owned descriptors would require discovery handoff. Directory identity
and protection of retained witness state need explicit scope. No timestamp
workaround, weakened replacement rule or new retention mechanism was implemented.

The source-identity diagnosis also found that campaign publication still assumed
exactly two roots, while the native trace binding now requires a third root.
That integration correction is tracked separately from the retention decision.

Private installed receipts are under
`install-transfer-2375580d927b7a93d430ee3a489918224e36b1e1/`: original command log,
failed image tests, `image-check-2/image-check-output/temp-execution.json`, the
second failed test log and `identity-probe/identity.json`. Each probe removed its
container and released its owned appliance locks. No real provider request,
campaign registration, diagnostic attempt or measured attempt was made.

Publication correction `81bb10e6` derives the exact expected root kind/path map
from the validated runtime and build. Codex 0.146.0 requires transcripts,
artifacts and `HOME/.codex/rollout-traces`; other qualified layouts retain two
roots. A real frozen-bundle test verifies that immutable publication retains the
supporting bytes without publishing HOME. Missing, extra and forged roots are
refused. The independent bounded review passed all 38 publisher tests with 142
assertions and found no actionable issue (`trace-publisher-review.md`). This
correction is committed locally; it has not been installed on the appliance.

Final readback in the installation packet's `final-state.json` confirms clean
installed source `2375580d`, unchanged helper/configuration/origin/campaign
manifests, the same image, no probe containers and both locks released. The shared
appliance container remains running. This is operational cleanup proof, not
observer readiness. The inode-reuse defect remains open pending the retention
design decision; no new retention mechanism or weaker identity contract was
introduced.

After `81bb10e6`, the broad `bun run check` passed Biome and TypeScript but its
core test phase finished **4,192 pass, 17 skip, one failure**: the unrelated
explicit-`--os linux` CLI run-ID test exceeded its 5,000 ms timeout (5,467 ms).
An isolated unchanged rerun passed in 2,977 ms with three assertions; no timeout
was raised and no CLI code was changed. The full command remains recorded as a
failure, not an all-green run. The dashboard was then checked separately:
144 pass, zero failures. Scenario validation and `git diff --check` passed.
Receipts: `publisher-final-check.log`, `cli-timeout-rerun.log`,
`publisher-dashboard-check.log` and `publisher-scenario-check.log` under
`diagnostic-r3-offline/`. The confirmed installed inode-reuse failure, rather
than this non-reproducing timeout, remains the design blocker.
