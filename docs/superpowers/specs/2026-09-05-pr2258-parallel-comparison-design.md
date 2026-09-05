# PR 2258: parallel Codex and Claude comparison

**Date:** 2026-09-05

**Status:** Proposed design selected by Drew; written spec awaiting review.

**Source inspected:** Evals `672a0ad2580b75153e1a954ae3a8cad4c1e97b90`.

**Question:** Does PR 2258 improve shared intent and approval discipline within
Codex Astra, Codex Sol, and Claude Opus 5, and what does that improvement cost
in completion, time, tokens, and simulated user attention?

## Decision and scope

Drew selected base/head comparisons within each of the three subjects, a shared
Codex/Claude evidence interface, and the existing campaign controller targeting
six concurrent attempts. Preserve strict scores and describe cosmetic
post-approval edits separately. The first measured execution contains twelve
fresh samples: two repetitions of each of six arms on the original todo case.

Deliver a comparison that an operator can declare, register, run, inspect, and
review through the supported appliance journey. Ordinary harness support already
provides provisioning, normalized transcripts, and economics. This work adds
qualified approval evidence for Claude and makes that evidence portable across
campaign execution and publication.

Three approaches were considered:

| Approach | Assessment |
|---|---|
| Shared evidence interface, Codex/Claude adapters, existing campaign controller | Selected. Reuses capture and scoring rules while repairing their source-identity and publication boundaries. |
| A custom parallel version of the historical pilot driver | Leaves duplicate orchestration and temporary-home evidence assumptions; insufficient for repeatable campaign use. |
| Qualify approval observers for every supported harness immediately | Requires unrelated log-format investigations. Other harnesses can implement the same interface later, with explicit qualification. |

This spec does not authorize a live run, appliance cutover, credential changes,
or additional spending. It defines their reviewable prerequisites. It adds no
campaign resume/restart, historical-format reader, dollar-budget controller,
six-arm atomic block, or generalized semantic judge. The accepted finite
[campaign design](2026-09-04-campaign-consolidation-design.md) remains authoritative
except for the narrow admission tie-break change described below.

## Evidence for the gaps

The [September 5 pilot record](../../experiments/2026-09-04-pr2258-astra-sol-brainstorming.md)
reports eight serial Codex samples with capture receipts and no canonical-score
evidence errors. Those are historical receipts, not Claude or parallel-container
qualification. The initial status paragraph in that rolling record describes an
earlier pause; its final fresh-pilot results contain the completed execution.

Current source establishes these gaps:

| Boundary | Finding |
|---|---|
| Scenario eligibility | `brainstorming-todo-shared-intent/checks.sh` permits only Codex. |
| Discovery and indexing | `brainstorming-input-capture.ts` selects Codex parent rollouts; `brainstorming-evidence.ts` projects Codex messages and calls. |
| Home identity | The guard persists the configured subject home, but scoring reconstructs `<run>/home/.codex/sessions`. Campaign homes are `<attempt>/home`, outside the staged run. |
| Publication | Review files name a live absolute raw-log path. Receipts contain document bytes and transcript-prefix hashes, but not the raw transcript. Publication moves the staged run, leaving the attempt home behind. |
| Admission | Equal-priority blocks sort by comparison before repetition, allowing both Astra repetitions to start before Claude. |
| Grader capacity | The active direct `sonnet5` declaration caps graders at two. Six attempts require six graders. |

Read-only checks on the installed appliance on September 5 found a healthy
ordinary doctor result, a running container, absent run/sync locks, and campaign
commands in the helper. However, `campaign list --json` returned `config_invalid`
because `campaigns/0231c6cd-d4a_live_crash/campaign.json` is V1. A working helper
entry point is not evidence of a qualified V2 installation.

## Architecture and responsibility

```mermaid
flowchart TD
    A[Runner supplies attempt and harness identity] --> B[Observer binding]
    B --> C[Codex or Claude raw-evidence adapter]
    C --> D[Guard captures stable documents and transcript prefix]
    D --> E[Gauntlet-Agent reviews and replies]
    E --> C
    C --> F[Finalize immutable evidence bundle]
    F --> G[Scenario chronology scorer]
    G --> H[Attempt manifest and campaign publication]
    H --> I[Campaign report and PR2258 diagnostic readout]
```

The observer infrastructure owns source selection, canonical raw anchors,
stable snapshots, and evidence integrity. The scenario owns the hidden actor
purpose, response policy, semantic action classification, approval stages, and
first-successful-implementation endpoint. The Gauntlet-Agent remains a simulated
user and initial reviewer; independent review checks its semantic judgments.
The subject and observer cooperate inside an attempt. Keeping evidence outside
the subject workdir is not a security boundary against a malicious subject.

Use one small internal evidence-adapter interface keyed by runtime family and
qualified raw dialect. Initially support Codex rollouts and Claude session logs.
General normalizer availability does not imply observer capability. Unsupported
combinations fail before subject interaction; enable Claude in the scenario only
after its contracts pass. Avoid a configurable observer plugin framework.

## One authoritative run binding

Setup receives the resolved runtime family and actual run, workdir, and subject
home from Quorum. Resolve the normal session-root configuration from the selected
agent configuration; do not infer the runtime from filenames or reconstruct home
from the evidence directory. Persist one versioned binding outside the subject
workdir. Installation, live capture, indexing, finalization, and scoring consume
that identity.

The binding records run/attempt identity, runtime family, dialect, source roots,
workdir, and the selected main session's identity and path once discovered. A
campaign binding includes the existing campaign/sample/attempt identity. Discovery
may wait through an unchanged startup inventory, but once selected the parent
cannot silently switch, disappear, or become ambiguous. A foreign run, child
session, symlink, or replaced source cannot supply approvals.

Live paths locate sources only during execution. Published evidence uses
bundle-relative paths and content digests. Original absolute paths may remain as
provenance labels; replay must not dereference them.

## Raw chronology adapters

Both adapters produce an ordered evidence index retaining source-file identity,
raw line and content-block position, canonical user/assistant messages, stable
tool-call IDs and arguments, and result references. Duplicate/replayed records
retain their original canonical anchors. Conflicting duplicate identities or
unrecognized action-bearing records fail closed. Missing or ambiguous evidence
produces `indeterminate`, never a behavioral pass.

Keep the raw JSONL bytes unchanged. Parsing is strict about complete JSONL
boundaries. Share low-level parsing helpers with ordinary normalizers where
appropriate, but do not use a timestamp-merged ATIF trajectory as the approval
timeline. Full-log normalization can combine later events into earlier steps;
per-line normalization loses stream-wide deduplication state. Neither establishes
the original presentation/capture/approval order by itself.

### Codex

Preserve the qualified parent TUI selection using cwd and canonical session
metadata, canonical message selection, tool projections, and omission detection.
Move those assumptions behind the adapter. Keep the existing Codex score behavior
under equivalent evidence, including composite calls and native calls requiring
stable observer-assigned IDs.

### Claude

Inspect canonical identity-bearing rows rather than assuming the first row is
metadata: real fixtures start with queue operations. Parent selection combines
qualified log layout, cwd/session identity, and exclusion of `isSidechain`,
`agentId`, and subagent paths. Child fixtures can share the parent's session ID
and cwd and have null `parentUuid`; those fields alone are insufficient.

Index the full stream statefully. Deduplicate UUID replays and tool-use IDs while
retaining original raw positions. Repeated `message.id` rows must not move later
text, tool uses, or results before an intervening capture. Multiple content
blocks on one line need distinct anchors where their roles differ. A replay of
an earlier approval is not a new approval.

Tool-result-only user records, queue/progress records, attachments, compaction
summaries, and child-user messages cannot act as external-user approval. Mixed
records must identify the actual canonical message block; ambiguous provenance
is an evidence error. Qualify the exact Claude CLI build and dialect used by the
experiment; existing parser fixtures alone do not establish current TUI behavior.

### Descendants

Approval chronology belongs to the main conversation. Retain relevant descendant
logs and their parent linkage for independent review; do not merge child user
messages into that conversation. Parent delegation calls remain classified by
their actual purpose. Qualification covers document-review descendants whose
effects are read-only/process. A descendant write or unresolved effect that
cannot be placed causally against the approval boundary makes the evidence
indeterminate. It must not disappear merely because the child was excluded from
parent selection. General cross-session ordering is outside this increment.

## Capture, finalization, and replay

Retain the existing Gauntlet input guard on typing, key submission, combined
submit, and the shared shell tool. Snapshot stability, startup inventory checks,
document additions/deletions, partial writes, and cancellation controls keep
their existing contracts. No approval-wording detector is introduced. Reads and
replies stay separate; a shell call that rewrites subject artifacts and injects
an approval does not provide valid review evidence.

Each receipt binds the actual document revision to a complete, stable prefix of
the selected raw transcript after presentation and before approval. Preserve
distinct observations even when document bytes repeat. Raw mutation or replay
cannot turn an old receipt into a later approval boundary.

After the subject stops and logs settle, finalize the source evidence under
`<run>/brainstorming-evidence/`. The post-check scores only those frozen source
bytes and adds its derived score; the attempt manifest then authenticates the
complete self-contained bundle. Include:

- versioned source/attempt binding and adapter identity;
- byte-faithful parent raw transcript and relevant linked descendant logs;
- immutable document receipts and their source-prefix bindings;
- actor review, derived canonical score, and explicit evidence errors;
- enough identity and hashes to reconstruct the same index and score offline.

Finalization verifies that each referenced prefix matches the finalized raw
bytes. It must reject an incomplete or changing source rather than publish a
plausible partial approval chain. Failure still produces explicit diagnostic
evidence where possible; it cannot count as a valid sample.

The existing manifest and publisher authenticate these ordinary run artifacts.
Do not publish the whole home, auth files, or credential projections. Raw evidence
is sensitive and remains under the existing private-results handling policy.
The decisive portability test scores a copied published run with its original
attempt home and staging directory unavailable, using only the bundle. It must
produce the same score and detect altered transcript/receipt bytes.

Use an explicit new observer-bundle schema where the binding and anchor changes
require it. No automatic reader/converter for historical pilot bundles is added.
Retain their original files, pinned scoring code, and recorded outcomes.

## Scoring and readout

Preserve the current strict chronology policy: any spec change invalidates the
standing artifact approvals; a plan change invalidates plan approval. Keep the
first violation, canonical score, and composed Quorum verdict separately visible.
Do not retroactively promote historical cosmetic-edit failures to passes.

The diagnostic readout identifies independently reviewed cosmetic status-only
edits versus substantive changes, with exact before/after receipts and call
anchors. This label does not modify the strict score. Unresolved edits remain
unclassified. Also report purpose discovery, last completed stage, first
violation, completion, observer/instrument failures, and reviewer disagreement.

Provide a supported deterministic scenario readout through the existing observer
CLI, consuming only terminal campaign evidence references and authenticated
published bundles. It must use the campaign report's accepted complete-pair
cohorts for comparative summaries and separately show every planned slot and
attempt. Never infer inclusion from which files happen to exist. Active
campaigns retain the existing behavior-hiding policy. Independent review files
are separate derived artifacts and never overwrite sealed actor evidence.

Keep general campaign reports responsible for overall outcomes, paired costs,
tokens, wall time, elapsed campaign time, and all-attempt cost coverage. Avoid
adding brainstorming-specific fields to the general execution state. The scenario
readout may add evidence-backed actor-turn/review-size measures; missing measures
remain explicit. A fast stage-skipping failure is not an efficiency win. Human
attention measures are simulated-user proxies, not measured human review time.

## Frozen experiment

The target skill commits were verified against PR 2258 on September 5:

- Base: `fd02874aa5c55ba3c2bca431253b48e0e4c8be5a`.
- Head: `069edf3ffc2ffdce80a84d3344a4064acec7e10c`.

Freeze these exact revisions for this experiment. If the PR moves before launch,
report the drift and explicitly choose a new experiment revision; do not silently
move a treatment arm.

| Comparison | Subject credential | Base/head arms |
|---|---|---|
| Codex Astra | `openai_responses_6astra` | Existing `codex_astra_pr2258_base` / `codex_astra_pr2258_head` |
| Codex Sol | `openai_responses_56sol` | Existing `codex_sol_pr2258_base` / `codex_sol_pr2258_head` |
| Claude Opus 5 | `opus5_bedrock` | New `claude_opus5_pr2258_base` / `claude_opus5_pr2258_head` |

Use a schema-V2 suite with three base/head comparisons, the
`brainstorming-todo-shared-intent` scenario, `n: 2`, `reserve: 0`,
`max_attempts: 1`, and `max_exposure_skew: 60` seconds within each pair. Twelve
planned samples are the measured cohort. No automatic replacement or expansion.
The historical schema-V1 pilot manifest remains historical.

Keep the 25-minute subject-interaction cutoff and 30-minute total Gauntlet
allowance, including five minutes for observer completion. Set a separate
40-minute whole-attempt ceiling to cover setup and final capture. This bounds
worker execution; host preparation, publication, and final termination verification
must also be reported, not hidden inside a subject-time claim.

Pin Evals and Gauntlet source revisions and the runtime image digest. Record and
verify actual harness builds, served subject/grader models, loaded skill bytes,
native instruction layers, and delegated model usage. Use Codex `xhigh` for both
Codex comparisons. Before manifest freeze, select and record an explicit Claude
effort setting supported by the qualified build; verify its effective setting
through runtime evidence. Effort names across vendors are not equivalent units.
The exact Claude setting is a required launch configuration, not a new experiment
axis. No unknown/default effort may silently stand in for a selected setting.

Preserve the same scenario, actor responses, grader model/prompt, and observation
policy across all arms. Cross-harness differences in native instructions and
capabilities remain documented properties of the complete subject stack. The
primary findings are three within-stack PR effects, not an isolated model ranking.

## Parallel admission and capacity

Use one registered campaign and one controller, with a private container/home,
tmux session, observer binding, receipts, and result tree per attempt. Do not
parallelize independent Phase 1 helper jobs around their host locks.

Target global capacity six: four OpenAI subjects, two Claude subjects, and six
separate grader sessions. Capacity declarations are not provider quota proof.
Validate aggregate provider demand as well as per-model pool demand; the current
campaign pool identity includes model unless a shared `quota_pool` is declared.
Declare actual shared account constraints instead of borrowing run-all's
different limiter-key semantics.

Keep Sonnet 5 through Mantle as grader for continuity with the pilot, using a
separately keyed grader credential and an explicit qualified six-slot limit.
The existing subject and Mantle grader declarations share
`AWS_BEARER_TOKEN_BEDROCK` and cannot satisfy campaign secret separation together.
Provision a genuinely different grader secret via the blessed bundle and its
own public environment name; aliases of the same secret do not qualify. A
different grading endpoint requires an explicit instrument revision and fresh
qualification. No secret value enters Git or the spec.

For equal-duration primary blocks, change the deterministic tie-break to visit
repetition ordinal before comparison and scenario order. Preserve longest-duration
priority, stable ordering, whole-pair demand, resource fences, and existing
replacement rules. This suite supplies no duration estimates, giving all pairs
the same frozen-deadline priority. Under available capacity, the initial admission
order becomes Astra r1, Sol r1, Claude r1 before their second repetitions.

This is three overlapping paired comparisons, not a six-arm atomic block or a
wave barrier. Preparation and provider constraints may affect actual start times.
Record actual overlap, exposure skew, and contention. Qualify mixed-harness
overlap with real attempt lifetimes; configured capacity alone is insufficient.
Do not silently describe a two-slot fallback as six-slot readiness. If six is
unavailable, present the actual constraint and revise the run configuration.

Six-way execution should shorten elapsed turnaround compared with twelve serial
jobs. Two nominal 40-minute waves give a useful planning shape, not a completion
promise: startup, skew, provider pressure, and observer work require measurement.
Report campaign elapsed time alongside per-attempt time and observer overhead
where the existing guard timing evidence supports it.

## Appliance preparation and spending

The installed command derives campaigns from `<configured evals.path>/campaigns`;
there is no separate campaign-root knob to assume. Use a fresh configured Evals
checkout for the V2 namespace after verifying the appliance is drained. Preserve
the existing checkout and V1 artifacts untouched. Snapshot and verify configuration
changes, results-root selection, credential projections, exact source refs, and
image identity. Verify the installed helper's launcher resolves the qualified
code and configuration as well as the attempt runtime; changing only a source
checkout field is insufficient proof. This operational cutover needs explicit
authorization; adding a V1 reader or moving historical evidence is not part of
the repair.

Require working register/list/status/costs/report and exact cancellation on the
qualified installation. A doctor pass alone is insufficient. Interrupted campaigns
retain evidence and support termination reconciliation only; further execution
requires a fresh registered identity.

Freeze a pricing snapshot covering Astra, Sol, Opus 5, Sonnet 5 and observed
delegates, including endpoint-specific cache buckets. Verify actual pricing
coverage in qualification. Missing prices remain explicit and do not become zero
or silently change the campaign's behavioral inclusion rules.

The prior eight samples reportedly cost $30.18; $46.56 was accounted against their
historical $500 allowance including earlier attempts and reserves. These figures
are context, not authorization or a Claude cost forecast. Before paid work,
present the exact qualification/measured sample counts, conservative per-attempt
cost estimate, aggregate exposure at six concurrent attempts, and a requested
allowance covering subject, grader, failed, and diagnostic work. Monitor all-attempt
costs through the canonical readout. V2 has finite work/time limits, not an enforced
dollar ceiling; do not reintroduce budget admission or promise an invoice hard cap.

## Acceptance and qualification

Implementation is complete only when these contracts have evidence:

| Layer | Required proof |
|---|---|
| Shared semantics | The same approval-chain cases produce equivalent outcomes through Codex and Claude adapters; existing strict Codex behavior is retained. |
| Claude chronology | Real-format queue prefixes, UUID replays, split messages, multiple tool blocks, result-only user rows, duplicate/conflicting calls, and parent/child identities are handled without false approvals. |
| Capture boundary | Uncaptured replies are blocked across all existing input routes; changing files/logs, symlinks, partial JSONL, and ambiguous source identity cannot yield valid evidence. Cancellation stays usable. |
| Campaign paths | Full setup, guard, finalization, post-check and publication work with home outside the staged run. Published evidence scores identically after temporary paths disappear. |
| Descendant effects | Child user messages cannot approve; linked review evidence is retained; unresolved child writes cannot establish a pass. |
| Parallel behavior | Six simultaneous fake-provider attempts include all three comparisons, keep evidence and credentials separate, and enforce complete subject/grader demand. Ordering tests exercise admission behavior rather than matching generated scripts. |
| Real boundary | The actual Quorum/Gauntlet input path works for both dialects in Linux containers, including guard failure and portable publication. Tests conditionally skipped without `GAUNTLET_ROOT` or Linux Docker are explicitly run in this gate. |
| Termination | Existing cancellation and independent deadlines still terminate exact owned workers under concurrent load, including controller loss. Reuse qualified core tests and extend only uncovered integration cases. |
| Reporting | Terminal scenario readout authenticates bundles, honors campaign cohorts, preserves strict/composed outcomes and missingness, and exposes cosmetic-edit diagnostics without changing scores. |
| Installed readiness | Fresh V2 namespace, exact runtime, separate grader secret, six-way capacity, served models/effort, skill exposure, complete prices, and replayable evidence verified on the appliance. |

Run focused behavioral tests during implementation, then the normal Evals checks,
scenario validation, and required cross-repository/Linux qualification. Do not
treat portable fixtures as installed or provider proof.

Paid qualification is a separate fresh six-arm, one-repetition diagnostic
execution after the offline/Linux gates and spending approval. It verifies the
actual target mix concurrently; it is not pooled into the measured results.
Every measured run receives independent raw-evidence review before interpretation.
Start the twelve measured samples only after the diagnostic evidence establishes
readiness and the runtime/instrument is frozen. A failed qualification stays
recorded; no automatic replacement or expanded screen is purchased.

## Delivery boundary

One implementation plan should cover the observer binding/adapters, portable
bundle and scenario readout, the admission tie-break, scenario/arm/suite/pricing
configuration, and the qualification runbook. Keep operational cutover and paid
executions as explicit later gates with exact inputs and evidence to approve.

Approval of this written spec precedes implementation planning. The next review
should be able to identify the behavior being built, its acceptance evidence,
and the remaining environment prerequisites without reading this conversation.
