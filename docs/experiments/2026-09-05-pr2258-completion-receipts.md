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

Reviewed source is integrated through `00798a4c`. Both exact installed native
builds completed two no-provider text turns and clean shutdown on the selected
Linux appliance. The last scoped review finding is closed. The minimum installed
source update passed at `0d6eae90`. The claimed missing-grader-key blocker was
subsequently diagnosed as a credential-policy mismatch; see the correction below.
No diagnostic or measured provider attempt has started.

Drew's approved diagnostic-first sequence below supersedes the older Gate A/B
prerequisite prose. Exhaustive fault rehearsal remains deferred, and incomplete
native physical-call/descendant coverage is an explicit diagnostic gap. The full
comparison remains incomplete until real diagnostic and measured evidence exists.

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
