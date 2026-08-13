# Quorum overhaul program: fast, interpretable, multi-user evals

**Date:** 2026-08-12
**Status:** approved (Drew, 2026-08-12) after adversarial review, contract
redline, coherence pass, reviewer P1 redlines, and the OpenAI rate-limit
probe; child specs proceed against this parent contract
**Tracking:** PRI-2874
**Research brief:** https://claude.ai/code/artifact/c3794032-07aa-405f-88d0-c0587efaa766
**Review basis:** `superpowers-evals@ee570dd106fdc3cc2a7cabdf4ce25ab6413c1999`,
Gauntlet `4d26304a16ae48d85edd26ff2d1abc510273ffa0`, Stockyard
`a8e881168a1b603c18f9ce9c6f35a7d5b8fd20be`, prior checked-in designs and
experiment logs, and read-only live appliance inspections on 2026-08-12
**Builds on:**
`2026-06-12-quorum-scheduler-design.md` (amends),
`2026-06-18-shared-eval-appliance-design.md` (adopts Phase 2),
`2026-06-18-dashboard-decoupling-design.md` (honors read-only decision),
`2026-07-09-transient-indeterminate-retry-hang-detect-design.md` (retains
selected mechanics; amends retry predicate),
`2026-08-09-appliance-results-import-design.md` (retains internal transfer;
does not adopt it as the publication shape)

## How to read this document

Orientation for a reader who was not in the room: quorum's eval results
arrive too slowly to gate superpowers releases (Problem). The fix is judged
by four criteria — the critical one is a full paired release gate, submission
to machine-generated report, inside eight hours (Success criteria). Ten
recorded decisions and a set of binding constraints shape the design. The
canonical-contracts section defines the shared vocabulary every workstream
implements (campaign/sample/attempt identity, lifecycle, admission, executor
protocol) — skim it first and return as needed. Seven workstreams carry the
work: W1 reliability, W2 supervisor/scheduling, W3 campaign artifact and
report, W4 runner/grader split, W5 dashboard/sharing, W6 VM fleet, W7 quota
and credentials. "Stage 1" is pre-supervisor work inside today's appliance,
"Stage 2" is the supervisor era on one host, "Stage 3" is the fleet.
Sequencing lists the five integration gates that order it all.

## Problem

Quorum's turnaround, interpretability, and effectively single-active-job
appliance design block superpowers releases. A release-gate campaign takes ~2
days of appliance lock-time; by the time results land, the codebase has changed
again. Reading a campaign requires the maintainer to hand-triage run dirs
against a 7-pattern atlas. The Phase-1 helper already exposes
run/run-all/status/cancel/show/costs/import and the dashboard exposes a
read-only grid, but one `run.lock`, shared mutable execution state, no
idempotent submit/list/event recovery, and incomplete campaign interpretation
keep normal operation maintainer-mediated.

The 2026-08-12 recon (10-agent sweep of an audited 855-run corpus, adjacent
repos, and the external SOTA) located the bottleneck precisely. These are
historical corpus claims, not assertions about every path in current HEAD:

- Harness overhead outside the LLM drive is a **median 1s per run** (p90 3s).
  The wrapper is already fast; micro-optimizing that overhead is a dead end.
- Batches in the corpus achieve a **median 1.68× effective parallelism** (best
  4.9×; no observed batch used `--jobs > 5`). Current HEAD defaults to 8, but
  appliance `run.lock` still allows only one live job per host. A historical
  504-cell matrix cost ~67 serial hours; matrix size is configuration-dependent
  and must not be hard-coded as the current full grid.
- **sdd-\*** scenarios consume 73% of all wall hours from 23% of runs; the
  slowest cells gate every batch.
- **~1/6 of spend is waste** in the corpus: 17.5% of runs ended indeterminate,
  including 48% of OpenCode runs; 59 grader-`investigate` verdicts cost full
  price for no determinate signal; 51 runs failed at setup; 30 cells were
  omitted by historical 429-latch behavior; and 81 run dirs had no verdict.
  Current HEAD records rate-limited skips, but still terminal-skips rather than
  backing off. The OpenCode aggregate is an outcome baseline, not proof that
  current capture code is the remaining cause.
- The Gauntlet-Agent adds a median 75s per run (34% of drive) and dominates
  short scenarios.

The appliance corpus (3,601 verdicts through 2026-08-12) — the corpus the
program actually operates on — shifts several of these figures: median batch
parallelism there is 2.96× with a 10.28× maximum at `--jobs 12`; indeterminate
is 10.8% overall; OpenCode currently runs ~8% indeterminate post-fix; grader
`investigate` verdicts number 223; verdict-less dirs are 0.6%; and sdd-\* is
~35% of corpus-wide wall (74% within the gate battery itself). The local
figures above stand as the audited historical baseline; child specs size
against the appliance corpus.

Before a child spec uses any corpus number as sizing or root-cause evidence,
the sanitized corpus manifest, selection/exclusion rules, query or script, and
output digest must be checked in. The external research brief remains useful
discussion context; it is not the reproducible evidence artifact.

Read-only appliance inspection at 2026-08-12T21:44:57Z found the Phase-1 helper
healthy and idle, no run/sync locks, one singleton container, configured mutable
`evals_ref=main`, and the blessed 2026-08-05 credential bundle. An old June job
still resolved durably as done (3 pass, 1 indeterminate). The helper exposed
doctor/prepare/run/run-all/status/cancel/show/costs/import, but not list/events/
inspect/version/capacity/archive/prune; `doctor` did not expose installed exact
evals SHA, executor image digest, or enforceable resource capacity. This is a
sanitized operational snapshot, not a live-eval receipt and not a security
assessment.

Two doctrine facts shape everything below. First, behavioral base rates are
nonstationary (±25 points within hours), so only contemporaneous paired arms
count as evidence — **parallel capacity is a validity mechanism, not just a
speed win**. Second, run homes persist live OAuth tokens (~65MB of a 68MB run
dir), so **scrubbing at capture time is a prerequisite for every sharing
feature**.

## Success criteria

1. **Release signal inside eight elapsed hours (critical).** The acceptance
   workload is a checked-in, pre-registered `campaign.json`. The initial fixture
   must be derived from the 2026-08-08 fresh-gate design and spell out all 388
   historical target arm-samples, both arms combined, their classes, reserves,
   comparisons, and registration digest. Until that fixture is checked in and
   validated, 388 is sizing evidence rather than an executable acceptance
   definition. A changed grid is a new fixture and registration hash; “~390
   runs” is never an acceptance definition. The historical design contains only
   Linux-container Claude/Codex credentials; fixture validation nevertheless
   recomputes managed-substrate eligibility and gating admission class
   (decision 9), and rejects any primary column that is not gating-class on
   a managed substrate — today that excludes Windows and Antigravity.
   Validation also asserts equality with the frozen `acceptance_columns`
   and the expected sample total, so a graduated column cannot be silently
   omitted from an unchanged fixture. Criterion 4 runs this
   same registered Linux/amd64 workload, not a silently reduced fleet subset.

   The clock starts when the supervisor durably accepts the campaign and ends
   when it durably commits the machine-generated report. The campaign clears
   this criterion only when:

   - all registered primary arm-samples are activated and every cell class
     satisfies its frozen completion rule;
   - every activated sample and every admitted attempt reaches a logical
     terminal state;
   - every primary slot has an included outcome or a replacement authorized by
     the frozen outcome-independent rule;
   - `exhausted` never counts toward target completion or analysis n; it may
     remain as terminal evidence only after another frozen-rule replacement
     has supplied the included outcome for its primary slot;
   - no pending, missing, `not_run`, unclassified, or silently omitted activated
     sample remains;
   - every broken pair, duplicate, orphan, and provenance failure has a terminal
     typed disposition and every replacement required by the frozen
     outcome-independent rule is resolved;
   - every headline sample passes the provenance and resource-equivalence
     gates;
   - the report applies the frozen decision rule without hand-computed
     statistics; and
   - maximum outstanding commitment never exceeds the pre-registered hard
     commitment cap; reconciled actual spend, retry, and backfill are reported
     against their separately registered qualification bounds. An actual-dollar
     hard cap is claimed only where the provider or proxy can enforce it.

   W1, W2, W3, and W7 jointly own this criterion. No one workstream may claim
   it independently.
2. **Sentinel qualification.** A checked-in sentinel fixture, expressed in
   arm-samples rather than ambiguous “cells,” completes through durable report
   commit in ≤2 elapsed hours under the same credential, resource, retry, and
   provenance rules. Its registration records pairing, included/excluded slow
   scenarios, per-pool distribution, measured mean duration, and implied
   capacity. The fixture is invalid if it silently demands a higher capacity
   floor than criterion 1 without declaring the extra provisioning.
   W1's two-run reliability exit uses this same registered sentinel fixture;
   reliability and throughput remain separately reported gates.
3. **Stage-2 full-grid target.** The runnable arm-sample count in a frozen
   matrix manifest generated from registered evals, credential, agent, OS,
   scenario-tier, admission-class, and filter inputs completes through
   durable report commit in ≤12 elapsed
   hours. Historical “504 cells” is not a frozen current-grid definition.
4. **Stage-3 headroom.** The critical acceptance campaign still completes in
   ≤8 elapsed hours with `ceil(20%)` of declared worker slots withheld for
   the entire campaign, drawn per qualified resource class and failure
   domain.

Preliminary capacity math for criterion 1: 388 arm-samples × mean ~476s ≈ 51.3
serial hours. Primaries alone require ≈6.41× effective parallelism over eight
hours. W7 starts at the ≥9× fixture-composition working floor below but must
derive the actual acceptance floor from the
frozen primary workload plus registered reserve/backfill, retry, cooldown, and
reporting allowances; 7× is not enough merely because it exceeds 6.41×. Priced
from the fixture's own cell composition rather than the corpus mean, the same
battery is ~70 serial hours (~645s/run), implying **≥9× before allowances** —
the working planning floor until the frozen fixture computes the exact number.
Historical unpinned fan-out reached 10.28× (2026-06-25, `--jobs 12`) —
evidence the substrate can exceed the floor raw, not proof of the
allowance-inclusive requirement under pinned resources — and the 08-08
gate's own failure mode was campaign-level scheduling at 1.65×, not batch
fan-out. The 388
historical samples already include both arms. Concurrent arms concentrate
demand on the same quota domains; they do not double that workload again. The
capacity model proves the makespan of every serial or constrained quota path,
not only aggregate throughput — including the longest cell-chain per pool:
replicates of the slowest cells plus activated reserves inside one capped
pool are the binding serial path, not the single longest cell. Stage 3
separately sizes nominal capacity so the full registered workload still
clears after 20% of worker slots are withheld.

If Stage 2 slips, the dated interim bar is the same acceptance campaign in
≤12 elapsed hours — an explicit stair-step toward criterion 1, never a
silent substitute for it.

Wall-clock is an operational service objective, not a behavioral comparison
metric. Tokens and dollars remain the primary treatment/control efficiency
metrics under the 2026-06-10 cost-experiments doctrine.

## Decisions

Recorded from the 2026-08-12 discussion; each binds the child specs.

1. **Staged A+B ("CoA C") with the fleet as a committed destination.** Scale
   the appliance first. Stage 2 freezes the complete northbound operator
   contract defined below—not only an illustrative command subset—and the
   internal leased-executor contract. Stage 3
   preserves those contracts while replacing the local executor and durable
   admission backend; “unchanged” does not prohibit a versioned worker
   lease/upload protocol.
2. **ATIF is the transcript bet.** No Inspect-EvalLog convergence. Spike ATIF
   v1.7 against Harbor RFC 0001 to see whether Harbor-ecosystem trajectory
   viewers render our trajectories for free.
3. **smevals is a contracts donor, not a dependency.** Adopt what fits
   (run/grade decoupling, tags+metrics check vocabulary, `-n` top-up
   sampling, serve/build static-site duality) in quorum's own TypeScript
   schemas. No coordination required.
4. **Runner/grader split is the target architecture.** The runner drives
   interactively and freezes evidence; the grader is a separate pass over that
   content-addressed evidence. Cutover requires both frozen-artifact grader
   parity and a contemporaneous rubric-aware-versus-rubric-blind driver canary.
   Fused mode remains the fallback until both hold. Regraded verdicts are
   append-only, counterfactual assessments and never serve as headline evidence
   unless the campaign pre-registered offline grading.
5. **Rubric-blind driver.** A driver that knows the acceptance criteria leads
   the witness toward graded behaviors. The driver receives an interaction
   script (persona, prompts, pressure moves, evidence-eliciting closers such
   as "show me the test output"); only the grader receives the ACs. Watch
   item: over-blinded drivers may end runs without the evidence the grader
   needs. Evidence completeness, behavioral deltas, and unresolved rate are
   separate canaries.
6. **Quota engineering is in scope end-to-end.** Explicit quota-pool identity,
   the shared driver/grader pool, Bedrock TPM raises, grader key pooling or a
   calibrated Bedrock grader (PRI-2524), and OAuth→API-key conversions where a
   key path exists all feed one admission model. Changing grader model/provider
   is an instrument change and must pass W4 calibration; it is not merely an
   availability change.
7. **Jesse is the prototypical second user.** Read and share for certain;
   make Stage-2 launching, discovery, cancellation, and lost-response recovery
   through the supervisor—never the dashboard—easy enough that he uses it too.
8. **Retry the failed component, not “an indeterminate.”** Evaluation outcome,
   execution lifecycle, and artifact health remain distinct. Automatic retry
   requires a positively identified, typed, retryable instrument cause; a bare
   clean `investigate` is an unresolved outcome, not retry evidence.
9. **Key-backed columns gate; seat-backed columns inform (Drew, 2026-08-12).**
   A versioned column registry classifies every column with an explicit
   `column_admission_class: gating | observational`. Gating requires an auth
   class from the registry's enum — `api_key`, `bedrock-bearer`, and `adc`
   are gating-eligible; `subscription`/seat auth is observational — plus
   managed-substrate capability receipts and quota that can be pooled or
   purchased. ("Tier 1"/"tier 2" elsewhere in this document are aliases for
   gating/observational and never refer to scenario tiers.) The acceptance
   fixture freezes `acceptance_columns` and asserts its expected sample
   total (initially 388) against fixture equality, so a newly graduated
   column can never be silently omitted — a registry change is a new fixture
   registration. The acceptance campaign and criterion 1 are defined over
   the gating class. Observational work runs as a separately registered,
   separately sealed campaign linked to the acceptance campaign: admission
   reserves gating capacity first, observational work admits only from
   proven residual capacity, and the acceptance campaign's sealing and
   decision never wait on it.
   Seat/subscription-auth columns are tier 2: scheduled contemporaneously as
   capacity allows, reported separately, and never gating the eight-hour
   window. Codex moves to API-key credentials as its gating path. Copilot's
   designated route is CLI BYOK on dedicated provider orgs; Antigravity's is
   ADC via the Gemini Enterprise Agent Platform (details in W7). A column
   graduates to tier 1 only when its route passes a registered smoke.
   Purchased seats may widen a tier-2 column, weighed per column against the
   ops overhead and provider-ToS exposure of pooled human accounts.
10. **Resources are not the constrained variable (Drew, 2026-08-12).** Key
    pools, quota raises, larger hosts, and disk are in scope whenever they are
    the cheapest path to the criteria; the constrained variables are validity
    and avoiding product work the goal does not need. Sizing decisions still
    require the capacity model's evidence, not headroom by assumption.

## Constraints that bind every workstream

- No tooling may make inferential pass-rate comparisons across unrelated
  batches. Inferential comparison names arms in one frozen contemporaneous
  campaign; historical baselines are descriptive only. Every rendered rate
  carries its n, denominator, measurement coverage, and cell class
  (confirmatory/probe/tripwire/descriptive).
- Live evals stay inside the trusted boundary: permissive-mode agent CLIs,
  sensitive transcripts, credential-bearing run homes. Never public CI.
- The dashboard remains a read-only filesystem consumer (Jesse, 2026-06-18).
  Launching belongs to the supervisor.
- Fan-out ships with a versioned per-run resource class: worker image digest,
  OS/architecture, CPU quota, memory limit, writable-disk allocation, and
  process/container limits. Admission accounts for aggregate resource vectors
  with reserved system headroom; actual runtime readback is recorded per
  attempt. Stage 2 must prove enforceable CPU, memory, PID, and disk limits under
  concurrency. A normal writable bind mount is not disk enforcement; if the
  appliance cannot enforce a required limit, the affected samples are
  non-poolable and the program advances to W6 rather than pretending they match.
  Arms in one comparison block use the same class and actual limits unless the
  campaign explicitly studies resources. Missing or mismatched readback makes
  the block non-poolable.
- Provenance hard-gates: no attempt is pooled or arm-attributed without the
  campaign registration hash; resolved Superpowers, evals, and Gauntlet SHAs;
  scenario/check digest; public credential and credential-bundle identity;
  explicit quota-pool identity; driver/grader prompt, configuration, build,
  provider route, and observed model readback for every model-mediated drive or
  assessment; harness/CLI and normalizer versions; and harness-specific observed
  Coding-Agent model readback. Intended credential or model labels are not
  readback. A route that cannot supply immutable model identity is non-poolable
  for confirmatory inference unless the plan registers and proves an equivalent
  immutable routing mechanism.
- Missing, dirty, inferred, or mismatched hard-gate evidence remains visible as
  typed non-poolable data. It never degrades to a warning or silently enters an
  aggregate.

## Canonical contracts shared by every workstream

The child specs may add implementation detail and namespaced `extensions`, but
they may not invent parallel definitions of campaign identity, retries,
admission, terminality, or artifact selection. Every artifact has one exact
top-level discriminator such as `quorum.campaign/v1`; required core objects are
strict, semantic or required-field changes increment the version, readers
reject unknown major versions, and the child specs publish a reader/writer
compatibility matrix.

### Campaign, sample, execution, and assessment identity

A campaign is one immutable plan plus one authoritative append-only logical
event stream. During Stage-2 live execution, a SQLite campaign-event table is
the sole authoritative ledger and shares transactions with sample/job state,
permit and lease mutations, artifact selection, and a materialization outbox.
Stage 3 may replace the store only with equivalent transactional and replay
semantics. Workers never append a second canonical ledger.

The W2 child spec defines online backup, integrity checks, and corruption/host-
loss recovery for this sole authority. Ordinary process/host restart has RPO=0
for every acknowledged mutation, event, idempotency record, permit/lease, and
artifact CAS. A host-loss restore from an older durable prefix may resume normal
service only in a new fenced recovery epoch: submissions stay drained; the old
campaign/event streams are permanently closed; event identity includes the new
epoch so sequence space is never reused; and all external attempts/artifacts
beyond the restored prefix are terminated, reconciled, and quarantined before
new work. Every mutation request carries the supervisor recovery epoch. A
restored known ID keeps normal replay semantics; an unknown ID tagged with a
closed/prior epoch returns typed `recovery_unknown`; a fresh never-reused ID
tagged with the current epoch may create work. IDs cannot be retagged across
epochs. Backup/restore fault tests prove that neither path duplicates spend nor
manufactures permits, selected artifacts, or a sealed report.

- `campaign.json` (`quorum.campaign/v1`) is an immutable input naming every
  primary slot, bounded reserve slot, comparison, completeness rule, and
  assessment selector. It freezes before any campaign-bound provider call or
  inspection of campaign outcome evidence. Smokes and calibration use separate
  fixtures and can never be relabeled into the campaign.
- The live event table records one monotonically sequenced, idempotent stream.
  `events.jsonl` (`quorum.campaign-events/v1`) is a sealed checksummed export at
  a recorded database sequence, not a second live authority.
- `report.json` (`quorum.campaign-report/v1`) is a deterministic projection at
  an `as_of_seq`; `report.html` renders exactly the same data.
- `batch.json` (`quorum.batch/v2`) identifies one execution shard and references
  the campaign and plan digest. A batch is not independently inferential.
- `verdict.json` (`quorum.verdict/v2`) is immutable per-run execution evidence
  linked to canonical identities. Assessments are separate append-only records.
- `results.jsonl` may remain a compatibility projection, but it is not the
  campaign ledger and repeated cell keys do not acquire replicate semantics.

The exported event slice is exactly `1..as_of_seq`; gaps, conflicting event IDs,
or conflicting duplicate sequence numbers fail closed. `campaign.json` is
never edited after registration. Protocol deviations and analysis amendments
are append-only events recording author, rationale, affected comparisons,
prior/new digest, event sequence, and whether outcomes had been observed. A
post-outcome amendment produces only a labeled sensitivity/counterfactual
report unless the original plan contained that exact amendment mechanism.

These identifiers are distinct:

| Identifier | Meaning |
|---|---|
| `cell_id` | scenario × agent/harness × credential × OS × resource class, shared across arms |
| `pair_block_id` | one registered contemporaneous scheduling or analysis block |
| `sample_id` | one registered statistical observation: cell + arm + replicate/slot |
| `execution_attempt_id` | one supervisor invocation for exactly one `sample_id`; produces at most one `run_id` |
| `run_id` | canonical run artifact allocated by one execution attempt |
| `runner_attempt_id` | W1 component retry nested inside one run |
| `assessment_id` | one live or offline assessment over frozen evidence |

`run_id` is reserved exclusively for the Quorum-allocated artifact. Gauntlet's
internal identifier is `gauntlet_run_id` and is provenance only. Legacy
`verdict.gauntlet.run_id` maps to `gauntlet_run_id`; it never satisfies the
`execution_attempt_id`→`run_id` binding. Verdict v2 carries both under distinct
fields.

Activating a matched reserve block creates one block event and one execution
attempt per arm; it is not one multi-arm execution. No identity is reconstructed
from a filename or timestamp. The supervisor persists sample and attempt
identity before spawn. Immediately after allocation, the runner durably emits
the `execution_attempt_id`→`run_id` binding; the supervisor persists and
acknowledges it before provider spend. Stdout observed only at process exit is
not an identity protocol.

Each immutable assessment carries at least its IDs; `live|offline` mode and
parent assessment; creation event sequence; criterion-set and frozen-input
manifest digests; grader prompt/configuration/build/provider/model and observed
readback; per-criterion `pass|fail|unresolved|not_assessed`, evidence references,
and rationale; aggregate outcome; and completion status. The frozen campaign
selects the assessment eligible for each headline outcome—normally the primary
live assessment unless offline grading was registered. Creation order never
selects a headline, and a regrade or normalizer correction never overwrites or
implicitly supersedes an earlier assessment.

### Lifecycle, failure, and retry doctrine

The attempt lifecycle is distinct from job and campaign lifecycle:

```text
planned → queued → leased → starting → ready_to_drive → running
running → uncertain → running | cancelling | lost | infrastructure_failed
pre-commit nonterminal → cancelling → cancelled
running → artifact_committed → classified → completed | infrastructure_failed
```

The canonical record preserves orthogonal axes rather than one display enum:

- `evaluation_outcome = pass | fail | unresolved | not_assessed`;
- `execution_terminal = completed | cancelled | lost | infrastructure_failed`;
- `artifact_state = none | staged | committed | missing | orphaned | quarantined`;
- `analysis_disposition = pending | included | excluded | void`, keyed by
  `(analysis_id, arm/stratum)` — one sample may be included in one named
  analysis and excluded from another (a binary-outcome analysis and a token
  analysis legitimately retain different cohorts), and `analysis_n` counts
  per `analysis_id`;
- `sample_activation = primary | available_reserve | activated_reserve`;
- `sample_lifecycle = open | terminal` for activated samples; and
- `sample_resolution = pending | selected_execution | exhausted | not_run`.

`runner_attempt_terminal` and `assessment_terminal` use the same terminal enum
for their own identities; they are not alternate execution-terminal fields.
Assessment `completion_status` is exactly `assessment_terminal`; only a
completed assessment may provide a schema-valid evaluation outcome. Every
other assessment outcome is `not_assessed` with a typed failure or missing
reason.

`pass` and `fail` are behavioral determinations. `unresolved` means a valid
drive or schema-valid assessment did not support pass/fail; a clean Gauntlet
`investigate` is unresolved. `infrastructure_failed` additionally names the
component, phase, stable cause, evidence, retryability, and retry-policy
version. `lost` means no authoritative live owner and no selected terminal
artifact after bounded reconciliation. `orphaned` means artifact bytes lack a
durable link; reconciliation either restores that link or quarantines them.
`not_run` is a terminal activated-sample resolution with no admitted execution
at abort/invalid finalization. `exhausted` means every authorized attempt is
terminal but no execution was selected. `selected_execution` means exactly one
execution supplies the sample's raw evidence; the separate analysis disposition
still decides whether that evidence is included. Unused reserve remains
`available_reserve`, not missing or not-run. `open_samples` and
`terminal_samples` partition primary plus activated-reserve samples;
`activated_reserve` is the registered reserve subset that left
`available_reserve`. `broken` is a pair-block state. `deferred` is a nonterminal
scheduling substate of an open sample, with a reason and next eligibility time;
it is not an evaluation outcome or a separate sample terminal.

`excluded` preserves an observation that the frozen plan makes ineligible for a
named analysis. `void` means a positively identified, outcome-independent
instrument failure produced no usable observation and the frozen rule permits
replacement. Behavioral or ambiguous non-completion is never voided merely to
restore power. Renderers may derive a convenience label but may not discard any
axis or present counts from different axes as one summable partition.

Retry the smallest failed component. A grading retry is permitted only when a
registered typed, outcome-independent instrument failure produced no
schema-valid assessment; `unresolved` is never retry evidence. With a valid
frozen drive artifact, grading retry creates another assessment, not another
Coding-Agent drive. A drive retry requires a typed transient cause that
invalidated the drive artifact under the frozen rule. A 429 does not by itself
authorize whole-execution retry. Fused mode uses component
`fused_driver_grader` and never infers driver versus grader from free text.
Every attempt is bounded by count, elapsed deadline, and cost; every failed and
retry-resolved attempt remains visible and charged.

The canonical projections enforce at least:

```text
registered_slots = primary_slots + reserve_slots
reserve_slots = available_reserve + activated_reserve
activated_samples = open_samples + terminal_samples
closed_analysis = included + excluded + void
```

Dimensions remain orthogonal even when their counts differ. Every admitted
execution, nested runner attempt, and assessment has exactly one logical
terminal disposition; idempotent replay of the same event does not create
another terminal. Every execution has an artifact pointer or explicit missing
reason. Power loss is not required to synthesize a `verdict.json`.

### Pairing, top-up, and analysis

Every paired campaign declares whether `pair_block_id` is:

- a **scheduling block** controlling contemporaneous exposure while independent
  eligible arm observations remain the analysis unit; or
- an **analysis block** whose complete matched outcomes are the inferential
  unit.

`-n` sets `target_n`, the primary sample slots per registered arm/cell. The plan
declares `reserve_n` separately. Primary slots start activated; reserve slots
start available, become activated only through the frozen whole-block rule, and
never return to available. `analysis_n` counts eligible included outcomes, not
registered identities or attempts. At most one execution outcome is selected
per sample; retries and backfill never erase original evidence or spend.
Every activated reserve sample names `replaces_primary_sample_id` (and its
`pair_block_id`); exactly one included outcome exists per primary slot per
named analysis, so `analysis_n` can never exceed `target_n` or drift
arm-imbalanced.

Corresponding arms complete local provisioning, fixture setup, and deterministic
prechecks before entering durable `ready_to_drive`. The supervisor atomically
reserves a feasible launch plan across all arms, then acquires runtime permits
only for each actual launch; a reservation never consumes simultaneous capacity
the pool does not own. `analysis_exposure_started_at` is the first Coding-Agent
generation request. Permit acquisition, lease issue, process spawn, and
Gauntlet startup are not arm start. The registered `max_start_skew` compares
these exposure events. If aggregate pool/resource demand, launch spacing, or a
serial critical path cannot meet the skew, registration rejects the block or
marks it descriptive before spend.

Reserve activation and outcome selection depend only on registration order,
slot role, and typed outcome-independent exclusion state—never behavioral
outcome, criterion status, cost, duration, or tokens. A matched replacement
activates the whole reserve block before any reserve outcome is observed. The
plan declares whether an otherwise valid arm from a skew-broken scheduling
block remains independently eligible; an analysis block requires complete
matched outcomes. Reports show complete, incomplete, skew-invalid,
resource-invalid, and unschedulable blocks even when independent-arm Fisher is
the registered analysis.

Inferential `quorum report --vs` resolves only to a named comparison in one
frozen campaign. Each outcome or metric registers its estimand, analysis unit,
eligible classes, strata/blocks, inclusion and missingness rules, assessment
selector, test, sidedness, alpha, multiplicity policy, effect/interval method,
minimum n, and permitted decision language. Fisher is permitted only for
declared independent binary arm observations; analytically matched outcomes use
a matched method. Raw pooling across strata is descriptive only.

### Supervisor and operator contract

The supervisor is the only normal write front door for Stage 2 and Stage 3;
the dashboard remains read-only. The stable operator surface provides
idempotent `submit`; `list`, `status`, and sequenced `events`; idempotent
`cancel`; typed `import`, `archive`, `restore`, and `prune --dry-run|--apply`;
`show`, `costs`, `report`, and artifact references; and read-only `doctor`,
`inspect`, and `capacity --json`. Mutations use request idempotency and return a
new state revision. Static export is a pure build from a sealed scrubbed
snapshot; publishing that bundle, if automated, is a separate idempotent
supervisor operation.

Submit uniqueness is `(recovery_epoch, enrolled_operator_id, request_id)`, with
the cross-epoch non-retagging rule above. The same canonical request digest
returns the original job and current revision; a different digest returns typed
`idempotency_conflict`. Lookup accepts epoch plus request ID, and
idempotency tombstones outlive artifact/job pruning and the maximum retry
horizon. The W2 child spec sets a retention floor and compaction protocol; an
expired key is never silently reusable and requires a fresh `request_id`.
Operator identity is unique and server-derived from the enrolled
trusted access path, never optional caller environment. For this Drew/Jesse
trusted deployment, both enrolled operators may discover, inspect, and cancel
all jobs; owner remains recorded for coordination and audit. This is not an
untrusted-user authorization model.

Job orchestration, attempt execution, and campaign completion use distinct
namespaces. Job state is:

```text
accepted → queued → preflighting → running
running → waiting(reason, next_retry_at) → queued
pre-commit nonterminal → cancelling → cancelled
running → completed
control-plane terminal → failed
```

A job is `completed` only when every execution it owns is terminal and its
terminal projection is durable; behavioral fail/unresolved does not make the
orchestration fail. `failed` means the supervisor cannot continue or produce
that projection. Campaign state is
`registered → running → sealing → sealed | aborted | invalid`. A campaign seals
only when all activated samples are terminal, pair/replacement rules are
resolved, and its frozen completeness predicate passes. `aborted` and `invalid`
preserve partial evidence and cannot emit a release decision. A sealed campaign
separately reports decision eligibility; `sealed` does not fabricate adequate
power.

Every terminal job response and status includes attempt counts by canonical
axis, artifact health, campaign state, report seal and decision eligibility,
owner, exact refs, state revision, queue position or blocker, next retry time,
progress, and artifact/report IDs. `doctor`/`inspect`/`capacity` expose supervisor
build/schema and migration revision, drain/reconciliation state, exact executor
image/capabilities, host allocatable/reserved resources, and quota cooldowns.
The supervisor exposes health distinctly from job status. Startup repairs
durable state; merely deriving `done` or `lost` at read time is not recovery.

Workers use renewable, fenced leases naming attempt, generation, resource and
cost claims, issue time, and expiry. Only the current generation may launch,
renew, or select an artifact. Lease expiry alone moves a running attempt to
`uncertain` and fences commit; it does not release execution/quota/cost claims
or authorize redispatch. `uncertain` is nonterminal, retains every claim, cannot
launch or select artifacts, and returns to `running` only after authoritative
same-executor reconciliation plus durable lease re-establishment. Otherwise it
terminalizes only after authoritative process-group/cgroup/container/VM
termination. Host resources are never released on a timestamp alone. Provider
quota/cost claims may close earlier only when an independently enforced fence—a
proxy, expiring credential, or trusted out-of-process watchdog—proves further
billable calls impossible. Host PIDs remain local diagnostics rather than
shared-store liveness.

`cancel_requested` records accepted intent. Cancellation fencing and selected-
artifact commit linearize through the same compare-and-swap. If commit wins,
the attempt enters `artifact_committed`, is permanently non-cancellable, and
proceeds through classification to its selected terminal; later cancel is an
idempotent no-op. If cancellation fencing wins, the attempt enters
`cancelling`, selected-artifact commit is permanently fenced, and later
artifacts remain visible but cannot be selected. A launched attempt becomes
`cancelled` only after authoritative executor termination; permit and
reservation effects follow the execution-fencing rules above. Campaign/job
cancellation does not relabel already committed results.

### Admission, quotas, resources, and cost

The supervisor is the sole admission authority for managed work. `--jobs` is a
per-job ceiling, not an independent host slot pool. It atomically accounts for:

- host/fleet allocatable CPU, memory, writable disk, and process vectors after
  reserved system headroom;
- per-job ceiling and per-operator share;
- harness/runtime seat;
- Coding-Agent quota pool;
- Gauntlet driver/grader quota pool while fused;
- paired-block launch plan; and
- hierarchical campaign → sample/backfill → attempt cost commitment.

Queued, cooldown-blocked, cap-blocked, or pair-waiting attempts hold no runtime
permit. Impossible resource profiles and infeasible pair plans fail before
launch. Permit release follows authoritative execution fencing above, not lease
expiry alone.

Endpoint routing is not quota identity, and provider limits form a graph,
not a scalar. Every credential names an explicit, non-secret, mandatory
`quota_pool_id` (no heuristic fallback for managed work); managed admission
acquires atomic `quota_claim_ids[]` — one claim per intersecting limit the
capacity model names (organization, project, model family, region,
purchased-capacity product). Every observed model, including subagent
models invoked inside one attempt, is recorded; an unregistered submodel is
a typed admission error, never a silent draw. One pool record owns
concurrency, launch spacing,
account/seat/model/region scope, dated evidence, and one declared enforcement
mode: linearizable per-request proxy; conservative per-attempt request/input/
output-token reservation; or concurrency/spacing only. Opaque CLI/OAuth routes
may not claim enforceable RPM/TPM without a proxy. Consumed window units are not
refunded because an attempt fails. Harness caps remain separate intersecting
resources; missing seat or pool policy is an error, not “unbounded.”

W1 owns provider-specific rate-limit detection and classification. W2 owns
durable pool cooldown and schedules only the component retry authorized above.
A retryable 429 stores provider `Retry-After`, receipt time, cooldown generation,
and a store-authoritative UTC `blocked_until`, updated transactionally as
`max(existing, candidate)` with bounded backoff. Processes convert remaining
time to local monotonic timers after reading it. Waiting work holds no runtime
permit; cooldown survives restart and concurrent 429s without a stampede.
Exhausted windows become visible deferred or terminal sample states, never
silent skips.

Admission uses bounded fairness across operators/jobs. The W2 child spec freezes
weights, the charged unit for multi-arm blocks, `eligible_since`, and a numeric
maximum eligible-bypass or start-lag bound, then proves it under continuous
arrival. Blocked work accrues no active-service entitlement, with one
exception: a structurally feasible pair block retains its original
`eligible_since`, and admission provides bounded atomic multi-slot
reservation (drain) so a feasible block eventually launches even under a
continuous stream of single-slot arrivals — the child spec tests exactly
that adversarial arrival pattern. Longest-first applies only inside an
equivalent ready fairness/pair class; paid work is never preempted.

The hard cost invariant is maximum outstanding commitment, not unknowable final
provider billing. The supervisor reserves a frozen upper bound once through the
hierarchical ledger, covering Coding-Agent, driver/grader, retries, and matched
backfill, then reconciles actual spend. Uncertain attempts retain reservations
until billing exposure closes. Unpriceable work cannot enter a hard-capped
campaign without an explicit registered override.

### Executor and artifact-commit contract

For supervisor-managed `run-all`/campaign work, the supervisor expands the
frozen plan and dispatches exactly one `execution_attempt_id` per lease. The
current self-scheduling `quorum run-all` is local/break-glass compatibility and
is never nested behind supervisor admission.

The supervisor owns planning, admission, pairing, quotas, cancellation, and
attempt selection. An executor owns one leased attempt in an immutable,
job-scoped environment. W2 owns versioned northbound and executor schemas plus
canonical transition/error semantics. Minimum executor messages cover lease
claim/renew/release, cancellation observation, lifecycle event, allocation
binding, artifact manifest/completion, and commit result.

Before dispatch, the supervisor assigns a staging destination. The executor
writes immutable bytes plus a checksum manifest and completion marker. One
database transaction records the selected-attempt CAS,
`artifact_committed` event, and materialization outbox; it fences cancellation
but is not terminal completion. Classification then commits `classified →
completed | infrastructure_failed` plus only ledger effects whose release fences
are already authoritative. It records release intent for every remaining host/
provider claim; each claim releases later, transactionally, only when its
corresponding execution or no-further-billing fence is established. Classifier
retries are component-local and bounded; exhausted classifier error selects
`infrastructure_failed`, retains the committed artifact and typed cause, and
follows the same fenced release process. Identical replay is
idempotent, conflicting bytes fail closed, partial uploads never become terminal
truth, and late attempts remain visible without replacing selected evidence.
The same startup-repair/outbox reconciler re-observes fences and advances every
durable release intent after a crash, so terminal attempts cannot leak claims.
It also reconciles immutable staging rather than creating a second truth.

Stage 2 supplies an appliance executor with immutable checkout, container or
process, temporary, and results namespaces. Stage 3 supplies a baked
Firecracker executor. Workers never self-admit. The same protocol-conformance
corpus runs against both executors, covering stale generation, reordered event,
duplicate/partial/late upload, lost acknowledgement, cancellation races, and
restart.

## Workstreams

Each workstream gets its own child spec and Linear issue before
implementation. Scope lines below bound the child specs; they do not replace
them. A child spec may propose descoping any obligation in this document
that does not serve the four success criteria; a descope requires Drew's
explicit approval and lands as a recorded amendment to this parent with
rationale, never a silent omission.

### W1 — Reliability and waste (Stage 1)

Recover instrument waste without converting ambiguous behavior into passes.

- Retain the 2026-07-09 startup-hang detector, nested runner-attempt evidence,
  summed economics, and flaked-green visibility. Replace that design's broad
  clean-`investigate` retry predicate with the typed failure doctrine above.
- Split every adapter into static validation, `provisionLocal`, fixture setup,
  deterministic prechecks, `validateLive`, then drive. The first four phases
  have no provider credentials or provider-capable auth material; `setup.sh`
  receives a secret-minimized environment and its contract forbids provider
  calls. `validateLive` is the first phase permitted to receive such material
  or call an LLM provider, and its spend is recorded. An adapter that cannot
  separate local setup from live validation cannot claim zero precheck spend.
- Scope the drive phase to the run's own credential: extend the `env -i`
  allowlist launch pattern (PRI-2494) to the gemini, kimi, pi, antigravity,
  hermes, and claude-windows launchers, constrain the OpenCode launcher's
  allowlist (it currently forwards every ambient provider key), and give
  Gauntlet a per-agent scoped subprocess env, so no agent or driver process
  inherits the full credential bundle. A black-box test per agent proves
  only the resolved subject and driver routes are visible from inside the
  run — this is route correctness, provenance, and billing, not attacker
  modeling. Secrets that never enter a transcript need no scrubbing.
- Introduce one async, process-group-aware, cancellable subprocess seam before
  applying deadlines to provisioning, setup, checks, drive, and capture. Each
  deadline requests graceful stop, waits for terminal evidence, then kills the
  descendant tree after a bounded grace period. The current blocking
  `spawnSync`, default-SIGTERM timeout, and exit-only run-ID paths are not a W2
  cancellation substrate.
- Make Gauntlet emit or preserve a structured terminal failure for adapter,
  driver, grader, provider, shutdown, and protocol errors. Quorum carries it
  through composition; free-text `run_error` remains diagnostic evidence, not
  a retry classifier.
- Extend rate-limit detection beyond the Antigravity marker. W1 classifies the
  failure; W2 owns the durable pool cooldown and scheduler retry.
- Re-classify the audited OpenCode indeterminates against the current
  snapshot/export implementation and harness revision, then fix only verified
  remaining causes. The historical 48% outcome is not current root-cause proof.
- W2 persists `sample_id` and `execution_attempt_id` before spawn. W1 accepts
  them, binds `run_id` on allocation through the acknowledged protocol, and
  emits typed runner-attempt and terminal evidence. W3 owns the schemas and
  projections; W2 owns cancellation/loss/orphan reconciliation; W5 renders the
  read side.

Exit: on two consecutive registered sentinel executions, zero silently omitted
registered arm-samples and zero unreported allocated run directories. Report both (a)
failed-or-lost attempts / admitted attempts and (b) unique samples experiencing
at least one failed-or-lost attempt / admitted samples. Retry-resolved failures
remain in both metrics and all-attempt spend; the <5% gate applies to (b).
Final unresolved infrastructure and behavioral `unresolved` are reported
separately and are never reduced by outcome-dependent retry. The no-hidden-
orphan invariant is an integrated W1/W2/W3/W5 gate.

### W2 — Scheduling and throughput (Stages 1–2)

The parallelism lever and the stable front door for both execution substrates.

- Package the supervisor as a versioned release outside managed job evals
  snapshots, owned by the host service manager. Provide atomic install/rollback,
  health, submission drain, and old-writer fencing; preflight of a job's evals
  ref may never replace the running control plane.
- Upgrade the existing Phase-1 file-backed run/run-all/status/cancel layer to
  the transactional Phase-2 supervisor and stable operator surface above.
  Supervisor-managed campaigns expand into one attempt per lease; they never
  shell one appliance job into a privately scheduling `quorum run-all`.
- Cut over behind a durable maintenance barrier, in this order: fence old
  writers FIRST — every installed entrypoint honors the fence, and the
  helper gains a drain command — then idle reconciliation (prove no Phase-1
  `preflighting|queued|running|stopping` job remains, or reconcile each
  against locks, process identity, and artifacts), then the final-sequence
  snapshot with count/digest validation of migrated terminal, lost,
  quarantined, and imported receipts, then promotion, canary, a defined
  rollback boundary, and `run.lock` removal last. The same sequence governs
  every relocation of the SQLite authority — including the expected Stage-2
  move to a larger host.
- Implement the authoritative SQLite event/state/permit/lease/artifact-CAS
  transaction and materialization outbox. Add request idempotency, queue/event
  discovery, revisions, durable repair, the cancel/commit race rule, named
  credential bundles, and a unique server-derived operator identity that keeps
  Drew and Jesse distinct through the installed entrypoint.
- Replace the singleton mutable execution namespace with attempt-scoped
  immutable evals/Superpowers/Gauntlet and dependency snapshots, runtime/process
  identity, temporary/results namespaces, and pinned resource classes. Select
  and prove hard CPU/memory/PID/disk enforcement and actual readback under
  concurrency.
- Make the supervisor the authoritative atomic admission controller across
  host/fleet, job, operator, harness, subject, driver/grader, resource, pair,
  cooldown, and cost constraints. `--jobs` remains a per-job ceiling.
- Add explicit quota pools and global cross-process caps, launch spacing, and
  cooldown state. Pool-waiting work holds no host slot.
- Schedule confirmatory pair blocks within registered start skew and activate
  matched reserve blocks rather than independent arm top-ups.
- Use bounded fairness across jobs/operators. Apply longest-first only within
  an equivalent ready class; use pool-aware remaining critical work across
  heterogeneous quotas. Freeze prediction inputs and conservative tail-derived
  time caps in the campaign; a cap is not simply historical p90.
- Add fenced worker leases without unsafe expiry release, structured artifact
  identity, transactional artifact selection, and restart/cancel fault handling
  behind the stable API. Ship `doctor`/`inspect`/`capacity` and the shared
  Stage-2/Stage-3 executor conformance suite.

Exit: deterministic multi-process and fault-injection tests prove no admission,
spacing, cooldown, resource, pairing, ownership, or reservation violation and
no silent arm-sample. Cutover/rollback receipts prove one writer and stable artifact
digests. W2 then participates with W1, W3, and W7 in the real paired campaign
for success criterion 1; it cannot claim that criterion alone.

### W3 — Canonical campaign artifact and report (Stages 1–2)

Kill tea-leaf reading by making the planned denominator, evidence lineage,
missingness policy, comparison, and decision rule machine-enforced.

- Land the shared TypeScript schema module for campaign, event, batch v2,
  verdict v2, assessment, and report first; W1, W2, and W5 import it rather than
  defining local variants. Check in and validate the initial acceptance and
  sentinel fixtures before their numeric criteria become active. Persist the
  complete primary/reserve cohort and campaign-specific matrix digest before
  dispatch. An unsealed report is visibly **IN PROGRESS** and cannot emit a
  release decision.
- Make `n > 1` first-class. The current `results.jsonl` writer can append
  repeated cell-key rows, but current `run-all` does not schedule supported
  replicates and those rows have no sample/attempt identity; the matrix displays
  the last row while tallying every row. New display and statistics derive only
  from the canonical sample ledger.
- `quorum report <batch>` is descriptive. Inferential campaign reporting only
  evaluates named pre-registered comparisons and the declared independent or
  matched method; it rejects arbitrary historical baselines.
- Every report shows each canonical axis separately plus complete, incomplete,
  skew-invalid, resource-invalid, and unschedulable block counts. It proves the
  conservation rules and preserves both intention-to-run and retained-analysis
  denominators; unused reserve is neither missing nor part of `analysis_n`.
- At the pinned Gauntlet revision, `result.json` may carry optional `criteria[]`
  verdict/evidence entries; schema v5 does not guarantee that field. Pin and
  parse the exact upstream field contract, project available entries into the
  immutable assessment, and preserve `not_assessed`. Regrades append and never
  overwrite live results. W5 renders this data.
- Give deterministic checks stable criterion IDs, typed tags, and metrics with
  units for faceted reading and triage.
- Add deterministic, versioned classification for the three verdict-shape atlas
  patterns that are mechanically derivable. Label the other four as requiring
  human attribution; surface them explicitly in the report's residual-triage
  queue and never guess them from free text. Automating those residual patterns
  is not a release gate for this program.
- Every cost/token/duration aggregate carries value or `known_subtotal`, unit,
  eligible denominator, measured/estimated/unpriceable/missing n, authority,
  and coverage-gate result. Null never becomes zero or “total.” Separate
  campaign elapsed time, queue delay, execution wall time, Coding-Agent
  duration, and grader duration; summed parallel execution durations are not
  campaign turnaround.
- Record plan, event-head, artifact, analyzer, statistics implementation, and
  schema digests. Identical frozen inputs regenerate byte-identical report JSON
  and HTML independent of discovery order, host, time zone, or absolute path;
  volatile delivery metadata is outside canonical files.
- Keep v1 artifacts immutable. Any backward-compatibility adapter is a
  separately approved decision and may expose legacy runs descriptively, but
  cannot invent a planned denominator, pair identity, model readback, or
  inferential eligibility.

Exit: the frozen fresh-gate fixture regenerates the same report bytes and
decision on two clean environments, and independent-oracle goldens prove
correct Fisher, matched exact, fixed-strata, exact token-rank, minimum-n,
multiplicity, missingness, reserve-selection, and rounding behavior. Property
tests cover physical event-row/input enumeration permutations while preserving
canonical event sequence, arm swap, and analytically excluded runs. Separate
tests prove that sequence-sensitive cancel/commit and pre/post-outcome amendment
order produces the registered result. Every registered sample has an explicit
state; incomplete evidence and invalid comparisons fail closed; and a real
paired release-gate readout needs no hand-computed statistic or denominator
repair.

### W4 — Runner/grader split and rubric-blind driver (Stage 2-adjacent; Gauntlet upstream)

Decisions 4 and 5 require two distinct gates:

- **Gate A — frozen-evidence grader parity.** Regrade a pre-stratified,
  content-addressed corpus spanning pass, fail, unresolved, and invalid or
  incomplete artifacts. Independently adjudicate criterion labels and evidence
  validity; agreement with the historical fused grade is a continuity metric,
  not ground truth. Invalid evidence must yield `not_assessed`. Typed
  infrastructure cause remains W1/supervisor truth and is never reclassified by
  the LLM grader. Pre-register overall/per-criterion agreement, evidence-quality,
  abstention, and non-inferiority thresholds. The frozen artifact contains the
  canonical trajectory, workspace snapshot, probe outputs, prompt/model/build
  identity, and completion reason; grading never probes a mutable workspace.
- **Gate B — rubric-blind driver canary.** After Gate A passes, run
  contemporaneous rubric-aware versus rubric-blind drivers with a fixed offline
  grader. Pre-register behavioral, evidence-completeness, unresolved,
  interaction-adherence, cost, and duration thresholds. The grader receives an
  arm-blinded canonical trajectory: treatment assignment and driver
  prompt/script identity remain in an external provenance manifest unavailable
  to the grader, while still permitting source reconstruction.

Before the split, `--grader-model` selects the one fused Gauntlet-Agent and
therefore changes both driving and grading; it is not grader-only routing. W4
introduces distinct driver/grader configuration only with the upstream split
and migrates scenarios from one `story.md` containing interaction directions
plus ACs to separate immutable driver-script and grader-rubric inputs, including
scaffolding, validation, authoring docs, and all scenarios.

The W4 child spec splits delivery into independently reviewable tranches:
structured/frozen upstream protocol, local routing, scenario-format migration,
Gate A, then Gate B. The format migration lands only with the split; an upstream
slip retains fused mode and legacy `story.md` rather than partially migrating
the corpus.

A deterministic-checks-only mode requires the upstream drive-only API, W3's
criterion-ID mapping, and a dedicated deterministic assessment path. Every AC
must map to post-check evidence before admission; missing coverage is a
pre-spend configuration error. Checks-only does not validate, reserve, invoke,
or retry a grader. The W4 child spec must name owners and coordination for the
Gauntlet structured-failure, frozen-evidence, and drive-only changes; fused mode
is the schedule-slip fallback.

Exit: separate Gate A and Gate B experiment-log verdicts meet their frozen
thresholds; grader routing ships; and checks-only ships only if its drive-only
dependency and complete criterion coverage are proven. Fused mode remains the
fallback if either cutover gate fails.

### W5 — Dashboard and sharing (Stage 2)

- Scrub at capture finalization, after required normalization, checks,
  economics, model attestations, and frozen-evidence capture. Retain the
  analytical projection; remove credential-bearing homes rather than treating
  them as the long-term artifact.
- Historical run dirs keep live credential material (the review census found
  six artifact classes the export denylist misses, including `.claude-env`,
  `codex-api.env`, `pi.env`, and `api-key-helper.sh`). A bulk retroactive
  rewrite of both corpora is DESCOPED (Drew, 2026-08-13); the policy
  instead: content-serving routes and exports cover capture-scrubbed runs
  only — historical raw file content is never reachable by construction;
  rotate or revoke the long-lived token classes the census found (OAuth
  refresh tokens outlive the 2026-08-05 bundle rotation); retention/prune
  retires historical homes on schedule. Any future scrub of retained
  artifacts is copy-on-write with an atomic projection switch; committed
  bytes are never rewritten in place.
- Render the canonical plan/ledger/report: run, batch, campaign, and complete
  paginated cell-history routes show planned, queued, running, included,
  replaced, excluded, cancelled, lost, orphaned, and missing samples, plus
  criterion evidence, provenance, measurement coverage, and all-attempt cost.
- Replace PID-based shared-store liveness with the authoritative supervisor read
  model. Initial load obtains snapshot sequence S and subscribes from S through
  one gap-free snapshot/replay-cursor protocol. Every SSE frame is sequenced; a
  non-contiguous frame or bounded-queue overflow emits `reset` and replaces the
  whole projection from a fresh snapshot. Initial-load races, reconnects,
  deletions, bursts, slow consumers, and dashboard restart must converge.
- Consume the immutable campaign-specific matrix W2/W3 persist before dispatch.
  The global suite manifest is only a versioned coverage catalogue and cannot
  be overwritten into describing a concurrent campaign.
- Define three artifact classes: raw operational, scrubbed internal analysis,
  and publishable static bundle. The existing import bundle is an internal
  donor, not the share object: publication excludes raw sessions, internal
  workdirs/logs, credentials, run homes, and machine-local paths.
- Static export contains the frozen plan, exact event slice, report, selected
  safe evidence/ATIF, relative viewer assets, provenance, and sorted checksums.
  Every report link digest-resolves to bundled content or explicitly says
  `not_published`; canonical files exclude generation time, hostname, absolute
  paths, random delivery IDs, and discovery order. Planned but missing or failed
  samples remain represented; partial imports never become a smaller complete
  campaign. Tailnet-scoped live access remains the deployment boundary.
- W5 owns the ATIF v1.7/Harbor viewer spike. Its child spec defines required
  trajectory features, acceptance threshold, and the fallback built-in viewer.
- Repair internal import before using it operationally. Persist an
  `import_attempt` keyed by source-manifest digest with one durable typed outcome
  per declared entry and preserved campaign/plan/sample/attempt/report/event-head
  digests. Stage, verify, and atomically materialize. Identical committed bytes
  are an idempotent no-op; conflicting bytes for a committed `run_id` are
  rejected or quarantined under the import attempt. `--force` may retry staging
  or metadata repair but can never overwrite committed evidence. Legacy
  run-only imports remain descriptive and partial imports cannot seal.
- Render W2's list/filter/archive/prune results. Mutations stay on the supervisor
  API, not the dashboard. Separate raw/internal/published retention and protect
  active leases, staging, unsealed campaigns, publication/retention holds, and
  artifacts referenced by retained reports. Require dry-run/apply parity,
  atomic tombstones, archive checksum verification, restore, resumable
  interruption, and visible admission refusal under disk pressure. Published
  report/provenance and retained safe evidence remain readable after allowed
  raw expiry.

Joint W2/W5 exit: Jesse completes the registered end-to-end UAT without an
appliance shell: inspect exact control-plane/executor/capacity state; lose and
recover a submit response; prove same-digest replay returns one job and changed-
digest replay conflicts; remain distinct from Drew during concurrent work;
interpret queue/backoff/retry state; cancel queued/running work; survive a
supervisor restart; read the sealed campaign; and open an offline static bundle
whose counts match the report. A separate archive/checksum/restore drill proves
reference-safe retention. This UAT is the Stage-2 multi-user/sharing gate, not a
retroactive owner of criterion 1's throughput-to-report measurement.

W5-specific exit, independent of the UAT: a value-based secret scan proves
no historical raw file content is reachable through any serving route or
export; the long-lived-token rotation checklist is complete; the
archive/prune drill passes; and static-bundle regeneration is
byte-deterministic. The Jesse UAT does not substitute for these.

### W6 — Fleet (Stage 3)

- The child spec re-derives W6's case from what survives a Stage-2 success:
  per-run hermetic isolation (retiring cross-run leak policing and the
  host-contamination class) and multi-user scale — not throughput, which
  the rate-limit probe and per-model quota pools may already satisfy at
  Stage 2. Until Stage-2 capacity results land, only the bounded
  feasibility slice from the sequencing gates spends.
- Adapt the digest-pinned `everyharness-container` base already used by the
  evals Docker image into a bootable, immutable-identity Stockyard Firecracker
  guest; one VM executes one fenced attempt under a pinned resource class.
- Treat W6 as a coordinated `superpowers-evals` and Stockyard change. Stockyard
  must persist and report requested and actual CPU, memory, writable disk/PID
  limits, and immutable image generation/digest across create, restart, and
  reconciliation; define immutable job-spec transport despite the currently
  reserved command field; and implement artifact upload/commit acknowledgement
  plus late-worker fencing. Until then only the appliance executor can claim
  conformance.
- Use the W2 leased-executor protocol. The guest reads an immutable job spec,
  uploads a staged checksum manifest and completion marker, waits for or safely
  tolerates commit acknowledgement, and powers off. Duplicate, reordered,
  partial, and late uploads follow the shared artifact-commit contract.
- Put distributed quota-pool admission behind the supervisor. Workers never
  self-admit and the operator does not learn a fleet-specific submission path.
- Extend enrollment from the Stage-2 trusted operator path; do not defer Jesse's
  basic multi-user workflow until the fleet.
- Scope credentials to the VM's blast radius: a guest receives only its
  attempt's subject credential plus the live driver credential — the driver
  remains an in-guest LLM after the W4 split; fused mode may share one
  driver/grader credential, and the split removes only the grader
  credential — never the full bundle. Job-spec/dotenv material is invalidated after init and is not
  readable by the agent-visible user once the drive starts, where the platform
  allows. The child spec records an explicit egress decision (accept full NAT
  in writing, or a per-VM provider-endpoint allowlist) and never exposes
  artifact-sink or tailnet credentials to the guest user the agent runs as.
- Fault-inject worker loss before upload, during upload, and after upload before
  acknowledgement. One sample retains every execution attempt and selects at
  most one outcome.

Exit: success criterion 1 meets its Stage-3 headroom rule, requested and actual
resources match, worker-loss recovery preserves exact accounting, and
cross-run isolation passes. VM isolation may retire cross-run leak policing;
same-run answer-key/rubric policing retires only if W4's rubric-blind path
passes.

### W7 — Quota and credentials (cross-cutting; critical path for criterion 1)

- Build the evidence-backed quota-pool registry and joint capacity model,
  including subject, fused driver/grader, harness, account/seat, each declared
  RPM/TPM enforcement mode, resource, and cost constraints. Model every serial
  critical path and the full registered primary + reserve/retry/cooldown/report
  allowance. ≥9× (the fixture-composition working floor) is the initial lower
  bound, not a substitute for the derived makespan requirement.
- Dissolve the binding OpenAI floor first: 236 of the 388 acceptance-fixture
  samples share one cap-5 `api.openai.com/v1|openai-responses` pool — a
  6.8–7.5h serial floor at perfect utilization that defeats criterion 1 by
  itself. Research (2026-08-12): OpenAI enforces quota per organization and
  per model; project keys never add throughput (and a configured project
  cap can subtract it — leave project limits unset or at org max). The org is
  already usage Tier 5 (Drew, 2026-08-12), so no tier clock applies: turn on
  auto-recharge (the historical hangs were billing exhaustion), run the
  saturation probe on the existing org now, raise pool caps to the probed
  value, and buy the provider's current committed-capacity product for
  genuine increases (Reserved Tier for GPT-5.6-class models at time of
  writing; Scale Tier covers pre-5.6 — verify the product at purchase). A separate eval org
  remains an optional spend-isolation choice — it would start at usage Tier
  1, so it warms in the background and never gates. Usage-Tier-5 per-model
  buckets (~40M TPM sol-class, ~180M TPM luna) carry the target concurrency
  with roughly an order of magnitude of headroom; the probe confirms the
  measured ceiling. (OpenAI "usage tiers" are unrelated to this program's
  column tiers.) Model quota pools as org|model identities (the
  CredentialSchema `quota_pool_id` override from the canonical admission
  contract): today's limiterKey both merges OpenAI's per-model buckets into
  one pool and splits protocols that share a bucket, and the opencode/pi
  columns silently draw the same org quota. Then probe the measured ceiling
  — cap 5 was a billing misdiagnosis, not a limit. The probe protocol, the
  capacity artifact (`quorum.capacity/v1`), and the saturation receipt's
  shape are defined in the W7 child spec; the graduation smokes are
  registered experiments with named owners and experiment-log entries,
  defined there too.
- Column graduation routes (research 2026-08-12). Copilot: the CLI ships
  native BYOK (2026-04-07) through the `COPILOT_PROVIDER_*` seam the adapter
  already forwards; BYOK traffic bills the byo provider org directly and
  bypasses Copilot premium-request quotas, so copilot graduates to tier 1 on
  DEDICATED provider orgs (never silently pooled with the claude/codex
  quota) after an A/B smoke proves behavioral comparability with GitHub
  routing and zero credit consumption — the BYOK credentials ARE the tier-1
  copilot cells. The GitHub-routed credential is an optional tier-2
  observation cell retained to watch GitHub's own serving stack; it does not
  gate copilot's tier-1 membership. MAI-model cells have no key path.
  Antigravity: consumer API keys remain unsupported, but agy
  1.1.10 (2026-08-03) added ADC / Gemini Enterprise Agent Platform sign-in,
  billing inference to a GCP project (Standard PayGo by default) under
  Dynamic Shared Quota — a shared pool with no fixed per-project caps and no
  per-project floor; purchasable Provisioned Throughput is the
  assured-capacity mechanism — with an official headless mode. That route is
  approved (Drew, 2026-08-12); the feature is days old, and the registered
  smoke must show billed consumption on the project and observed model
  readback, not merely successful authentication. Until it passes the
  column stays observational and serial. Paid consumer-account pooling is
  rejected (2026-02 suspension wave; keyring/token-rotation ops burden).
  Graduation to gating CONJOINS: operational smoke, immutable serving
  provenance (observed model readback — Antigravity currently emits none
  and Copilot records intended configuration rather than served models, so
  both need readback work), managed-executor capability receipts, and
  saturation/capacity evidence. A BYOK copilot column is a DISTINCT column:
  valid for gating via its own paired arms from day one, but any claim of
  equivalence or continuity with the GitHub-routed history additionally
  requires a powered, pre-registered calibration. Both routes require real
  adapter work, owned by their smoke's child spec: per-credential BYOK
  wiring for copilot (today's seam forwards host env, which the redesign
  eliminates) and ADC credential seeding into the per-run throwaway home
  for antigravity.
- De-single-point the grader through a key pool or calibrated Bedrock grader
  (PRI-2524). A model/provider change goes through W4 and provenance gates.
- Size Bedrock raises from the frozen workload model; convert OAuth to API-key
  routes where a key path exists. Reconcile checked-in policy with reality:
  Antigravity is capped at 1, Codex subscription currently has no explicit cap,
  and Copilot credentials are capped at 4. An unpooled account is serial unless
  live evidence and an explicit account-scoped budget approve otherwise.
- Registration proves each confirmatory block's minimum feasible exposure skew
  against serial/cap-1 pools. Such a route runs corresponding arms consecutively
  only when that fits the bound; otherwise the block is rejected or descriptive
  before spend.
- Implement campaign/operator/pool commitment reservations covering both LLMs,
  all retry layers, and matched backfill; preserve visible unpriceable coverage.
- PRI-2833 ships immediately as a standalone fix, ahead of and independent
  of this workstream: `prepare` runs a frozen-lockfile dependency
  install for the exact resolved evals SHA, never accidental bind-mounted
  `node_modules`, and runs `quorum check` from that installation. W2 then
  materializes dependency state inside each immutable attempt snapshot keyed by
  evals SHA and lockfile digest; a repaired shared install is not Stage-2
  isolation.

Exit: a versioned capacity artifact plus controlled saturation receipt proves
the joint pool/resource graph supports the acceptance fixture's derived
capacity floor (never below the ≥9× working floor) including registered
allowances, without cap,
spacing, cooldown, model, resource, or cost-reservation violations. A documented
nominal budget alone does not clear W7.

## Program-wide acceptance evidence

Child specs turn the contracts above into executable acceptance tests. At
minimum the integrated program must prove:

- crash/restart/cancel behavior at every boundary from durable plan write
  through permit acquisition, spawn, run allocation, verdict write, artifact
  upload, commit, and report projection;
- the Stage-2 event/state/permit/lease/artifact-selection transaction and outbox
  recover from crashes at each write boundary without two authorities;
- cancel versus selected-artifact commit deterministically honors both CAS
  orders, including replayed cancel, late upload, and restart;
- a real child interrupted after allocation still leaves the supervisor with
  the acknowledged `execution_attempt_id`→`run_id` binding;
- same-principal/same-digest concurrent submit creates one job and one spend,
  changed-digest replay conflicts, and idempotency survives restart and pruning;
- two concurrent OS processes and two operators cannot exceed any shared slot,
  spacing, cooldown, resource, quota-pool, or cost-reservation limit;
- a lost heartbeat cannot release host claims or launch a duplicate spender
  before authoritative executor termination, and cannot release provider claims
  before an enforced no-further-billing fence; advancing a timestamp alone
  releases nothing. Stale generations and duplicate/late uploads cannot publish
  a winner or increase statistical n;
- asymmetric starts/failures, serial pools, and continuous arrivals satisfy
  exposure-skew, outcome-blind reserve selection, and numeric fairness bounds or
  fail registration before spend;
- truncating the campaign event stream at any prefix cannot manufacture a
  complete campaign, valid pair, or release decision;
- a missing/mismatched ref, model readback, scenario digest, grader
  configuration, resource readback, or measurement remains visible and fails
  its corresponding inference gate;
- retry and backfill fixtures preserve raw outcomes and all-attempt spend and
  never discard a behavioral or ambiguous non-completion;
- state-matrix and conservation fixtures cover completed+unresolved,
  lost+orphaned, cancelled+late-quarantined, dormant reserve, not-run primary,
  exhausted primary, exhausted reserve followed by a selected replacement,
  broken pair, underpowered sealed report, and aborted campaign;
- identical and conflicting import replays, partial import/restart, dashboard
  snapshot/SSE races, archive/restore, and Phase-1→2 cutover/rollback preserve
  canonical digests and visible incompleteness;
- identical frozen inputs regenerate identical report data and static-bundle
  checksums; and
- the live Stage-2 receipt demonstrates the registered acceptance campaign only
  after W1/W2/W3/W7 deterministic, migration, reconciliation, and capacity gates
  pass. The W2/W5 Jesse UAT remains a separate required Stage-2 readiness gate.

## Sequencing

The workstreams may develop in parallel, but integration follows these gates:

1. **Contract gate first.** W3 lands the shared campaign/sample/attempt/
   assessment and provenance/resource schema module; W1 and W2 land typed
   failure and supervisor protocol slices against it. No multi-job scheduling,
   top-up, central reporting, or fleet integration may invent a different
   identity or lifecycle. This gate's exit also includes the checked-in,
   validated acceptance fixture and the initial `quorum.capacity/v1`
   artifact — everything numeric in this document derives from them, and no
   scheduling throughput work builds against an unfixed denominator.
2. **Reliability and quota inputs.** W1's typed failure/rate-limit
   classification and W7's measured quota-pool budgets gate W2 cooldown,
   cross-process admission, and throughput proof. W1's async cancellable process
   seam also gates W2 cancellation/deadline work. W1 and W2 are not independent
   at either boundary. The registered sentinel fixture (a W3 deliverable) is a
   prerequisite for measuring W1's exit, not for W1 implementation.
3. **Stage-2 release gate.** W2 scheduling and W3 reporting may implement in
   parallel, but both land before success criterion 1 is attempted. The result
   belongs jointly to W1, W2, W3, and W7.
4. **Grading and retained artifacts.** W4 may run Gate A once canonical frozen
   evidence exists. W5's capture-finalization and retained-artifact contract
   lands before static sharing or any W6 upload to a central artifact sink.
   Serving routes and exports exclude historical (pre-scrub-era) raw file
   content by construction, the long-lived-token rotation precedes any
   content-serving route, and any grader model/provider change — including
   W7's Bedrock grader — passes W4 calibration before campaign use.
5. **Fleet integration last.** A bounded Stockyard feasibility slice for
   bootable image construction, immutable image identity, resource readback,
   job-spec transport, and artifact transport may start after the contract gate
   so a Stage-2 capacity failure does not start cross-repo discovery from zero.
   W6 integration/rollout waits for stable northbound/executor contracts and
   Stage-2 restart/reconciliation tests; Stage 3 preserves those contracts while
   changing the executor.

## Non-goals

- Windows stays on its separate trusted-maintainer path; the fleet is
  Linux/amd64. Antigravity stays on its separate path unless and until its
  ADC route passes the W7 registered smoke AND it gains managed-substrate
  support; only then may a regenerated fixture admit it.
- No self-serve access for untrusted users; multi-user means enrolled,
  trusted operators.
- No security audit or adversarial tenant model for Drew/Jesse appliance use.
  Operational identity exists for idempotency, ownership, discovery, and
  cancellation.
- No dashboard launch UI (standing decision, 2026-06-18).
- No fabricated token counts; unpriceable columns stay visibly unpriced.
- No inferential resurrection of legacy batches whose planned cohort,
  contemporaneous pairing, or hard-gate provenance cannot be recovered.
- No general-purpose workflow engine: the supervisor implements only the job,
  campaign, admission, and artifact contracts required here.

## Risks

- **Provider quotas are the intrinsic ceiling.** More workers without more
  quota move the bottleneck to 429s. W7 leads W2 for a reason.
- **Faster ≠ valid.** Fan-out without resource pinning and paired-arm
  scheduling would corrupt the measurements it accelerates. W2 carries the
  doctrine, not just the throughput.
- **Retry can bias the estimand.** Retrying clean `investigate` outcomes or
  topping up one arm until it becomes determinate can launder behavioral
  failures. Typed causes, frozen dispositions, bounded matched reserve blocks,
  and intention-to-run denominators are validity requirements.
- **Grader split parity may fail.** If offline verdicts disagree with live
  ones or the blind-driver canary changes behavior/evidence beyond its frozen
  threshold, we keep fused mode; the program does not depend on cutover.
- **Account-scoped routes are constrained.** Antigravity is currently capped at
  1, Codex subscription lacks an explicit cap, and Copilot is configured at 4.
  W7 must reconcile configuration with measured account-level evidence;
  constrained cells are marked rather than allowed to gate a campaign they
  cannot complete.
- **Stage-2 isolation may not fit the current box.** The live appliance is
  8 vCPU / 30 GB — undersized for pinned criterion-1 concurrency. Admission
  must refuse resource claims it cannot honor. Under decision 10 the expected
  first response is a larger host: W2's child spec owns the resize/migration
  plan (results move, downtime against active campaigns) before concluding W6
  is required; running unpinned is never the fallback. Storage has the same
  shape: results/ grew ~140 dirs/day averaged over August's active weeks
  (quiet days see ~12; criterion-1 cadence implies 390+), at ~199MB each
  against ~217GB free — grow the volume now, and W5 retention lands before
  sustained criterion-1 cadence.
- **A durable row is not durable execution.** Lost supervisor responses,
  owner death, PID reuse, partial uploads, and late workers can duplicate or
  misattribute paid work without fencing, reconciliation, and atomic commit.
- **A lease fence is not an execution fence.** A partitioned worker may continue
  spending after heartbeat loss. Host claims remain reserved until authoritative
  termination; provider claims remain reserved until termination or an
  independently enforced no-further-billing fence, even when that reduces
  availability. Elapsed time alone is never a fence.
- **Control-plane rollout can create two writers.** The current helper runs from
  a mutable evals checkout. Service packaging, drain, migration validation,
  writer fencing, canary, and rollback precede `run.lock` removal.
- **Campaign freezes collide with rollout.** Evals main freezes during gates;
  redesign work lands between campaigns. Exact per-job snapshots remove the
  mutable-checkout freeze only after their identity and isolation gates pass.

## Relationship to prior specs

This program retains and supersedes prior decisions explicitly:

| Prior design | Retained | Superseded or amended here |
|---|---|---|
| 2026-06-12 scheduler | limiter caps/spacing, injectable clock, and one terminal scheduler event per scheduled attempt remain for local/break-glass `quorum run-all` | for supervisor-managed work: nested self-scheduling, per-process caps/spacing, arbitrary/no-priority dispatch, no-fairness doctrine, and batch-lifetime latch-and-skip; W2 adds one transactional shared admission authority, block-aware priority, bounded fairness, durable cooldown/retry, and explicit quota-pool identity |
| 2026-06-18 shared appliance | Phase-2 SQLite durable store and northbound operator direction | Phase-1 single active `run.lock`, shared mutable checkout/container execution, mutable-checkout control plane, and a job row without the canonical sample/attempt ledger; this design defines the full stable surface, one-attempt leases, transactional event authority, cutover, immutable namespaces, reconciliation, and artifact commit |
| 2026-06-18 dashboard decoupling | dashboard remains a read-only consumer | nothing; W5 may materialize campaign state into a filesystem read model but may not launch or cancel work |
| 2026-07-09 retry design | startup-liveness detector, one canonical run dir with nested runner-attempt evidence, bounded attempt structure, summed economics, and flaked-green visibility | the `investigate + error == null` retry predicate and last-attempt headline semantics; clean/ambiguous investigates are unresolved, retry targets the smallest failed component, and campaign backfill is a separate matched-sample operation |
| 2026-08-09 import design | allowlisted payloads, checksums, provenance uncertainty, and resumable internal transfer | `--force` replacement of committed evidence; conflicting bytes now reject/quarantine and identical bytes are idempotent. Its internal raw-session/workdir bundle is not the static share object; W5 adds durable import receipts, capture-finalization retention classes, atomic repair, and a narrower publication projection |

All unaffected portions remain binding. “No prior spec is retired” does not
preserve the specific decisions this table replaces.
