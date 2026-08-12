# Quorum overhaul program: fast, interpretable, multi-user evals

**Date:** 2026-08-12
**Status:** direction approved (Drew, 2026-08-12); adversarial redline awaiting
Drew's review; child specs blocked on this parent contract
**Tracking:** PRI-2874
**Research brief:** https://claude.ai/code/artifact/c3794032-07aa-405f-88d0-c0587efaa766
**Review basis:** local `superpowers-evals@ee570dd`, adjacent Gauntlet and
Stockyard checkouts, prior designs and experiment logs, and a read-only live
appliance inspection on 2026-08-12
**Builds on:**
`2026-06-12-quorum-scheduler-design.md` (amends),
`2026-06-18-shared-eval-appliance-design.md` (adopts Phase 2),
`2026-06-18-dashboard-decoupling-design.md` (honors read-only decision),
`2026-07-09-transient-indeterminate-retry-hang-detect-design.md` (retains
selected mechanics; amends retry predicate),
`2026-08-09-appliance-results-import-design.md` (retains internal transfer;
does not adopt it as the publication shape)

## Problem

Quorum's turnaround, interpretability, and single-operator design block
superpowers releases. A release-gate campaign takes ~2 days of appliance
lock-time; by the time results land, the codebase has changed again. Reading a
campaign requires the maintainer to hand-triage run dirs against a 7-pattern
atlas. Nobody but the maintainer can launch runs or read results.

The 2026-08-12 recon (10-agent sweep of an audited 855-run corpus, adjacent
repos, and the external SOTA) located the bottleneck precisely. These are
historical corpus claims, not assertions about every path in current HEAD:

- Harness overhead outside the LLM drive is a **median 1s per run** (p90 3s).
  The wrapper is already fast; micro-optimizing that overhead is a dead end.
- Batches in the corpus achieve a **median 1.68× effective parallelism** (best
  4.9×; no observed batch used `--jobs > 5`). Current HEAD defaults to 8, but
  appliance `run.lock` still allows only one live job per host. One rep of the
  504-cell runnable matrix costs ~67 serial hours.
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

Before a child spec uses any corpus number as sizing or root-cause evidence,
the sanitized corpus manifest, selection/exclusion rules, query or script, and
output digest must be checked in. The external research brief remains useful
discussion context; it is not the reproducible evidence artifact.

Two doctrine facts shape everything below. First, behavioral base rates are
nonstationary (±25 points within hours), so only contemporaneous paired arms
count as evidence — **parallel capacity is a validity mechanism, not just a
speed win**. Second, run homes persist live OAuth tokens (~65MB of a 68MB run
dir), so **scrubbing at capture time is a prerequisite for every sharing
feature**.

## Success criteria

1. **Release signal inside eight elapsed hours (critical).** The acceptance
   workload is a checked-in, pre-registered `campaign.json`. Its initial
   acceptance fixture is the 2026-08-08 fresh-gate grid: 388 target arm-samples,
   both arms combined. A changed grid is a new fixture with a new registration
   hash; “~390 runs” is not itself an acceptance definition.

   The clock starts when the supervisor durably accepts the campaign and ends
   when it durably commits the machine-generated report. The campaign clears
   this criterion only when:

   - every registered confirmatory cell reaches its registered paired sample
     floor;
   - every planned sample and launched attempt is explicitly accounted for;
   - no unresolved duplicate, orphan, provenance failure, or silently omitted
     cell remains;
   - every headline sample passes the provenance and resource-equivalence
     gates;
   - the report applies the frozen decision rule without hand-computed
     statistics; and
   - actual spend stays within the pre-registered dollar, retry, and backfill
     caps.

   W1, W2, W3, and W7 jointly own this criterion. No one workstream may claim
   it independently.
2. **Sentinel qualification.** The registered ~128-cell sentinel fixture
   completes through durable report commit in ≤2 elapsed hours under the same
   credential, resource, retry, and provenance rules.
3. **Stage-2 full-grid target.** A registered 504-cell matrix rep completes
   through durable report commit in ≤12 elapsed hours.
4. **Stage-3 headroom.** The critical acceptance campaign still completes in
   ≤8 elapsed hours with 20% of declared worker slots withheld.

Capacity math for criterion 1: 388 arm-samples × mean ~476s ≈ 51.3 serial
hours. Eight elapsed hours requires ≥6.5× effective parallelism; W7 uses ≥7×
as the planning floor. The 388 samples already include both arms. Concurrent
arms concentrate demand on the same quota domains; they do not double the
388-sample workload again. The capacity model must also prove the makespan of
each serial or constrained quota path, not only aggregate throughput.

Wall-clock is an operational service objective, not a behavioral comparison
metric. Tokens and dollars remain the primary treatment/control efficiency
metrics under the 2026-06-10 cost-experiments doctrine.

## Decisions

Recorded from the 2026-08-12 discussion; each binds the child specs.

1. **Staged A+B ("CoA C") with the fleet as a committed destination.** Scale
   the appliance first. Stage 2 freezes the northbound submit/status/cancel/
   show/costs contract and the internal leased-executor contract. Stage 3
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
  process/container limits. Actual runtime readback is recorded per attempt.
  Arms in one comparison block use the same class and actual limits unless the
  campaign explicitly studies resources. Missing or mismatched readback makes
  the block non-poolable.
- Provenance hard-gates: no attempt is pooled or arm-attributed without the
  campaign registration hash; resolved Superpowers, evals, and Gauntlet SHAs;
  scenario/check digest; public credential and credential-bundle identity;
  explicit quota-pool identity; driver/grader configuration; harness/CLI and
  normalizer versions; and harness-specific observed parent-model readback.
  Intended credential labels are not model readback.
- Missing, dirty, inferred, or mismatched hard-gate evidence remains visible as
  typed non-poolable data. It never degrades to a warning or silently enters an
  aggregate.

## Canonical contracts shared by every workstream

The child specs may add fields and implementation detail, but they may not
invent parallel definitions of campaign identity, retries, admission, or
terminality.

### Campaign, sample, execution, and assessment identity

A campaign is one immutable plan plus an append-only event ledger. Generated
reports and filesystem views are projections, never sources of truth.

- `campaign.json` (`quorum.campaign/v1`) is frozen before the first scored
  execution and names every primary and bounded reserve sample.
- `events.jsonl` (`quorum.campaign-events/v1`) records monotonically sequenced,
  idempotent lifecycle, disposition, assessment, and artifact events.
- `report.json` (`quorum.campaign-report/v1`) is a deterministic projection at
  a recorded event sequence. `report.html` renders exactly the same data.
- `batch.json` v2 identifies one execution shard and references the campaign
  and plan digest. A batch is not independently inferential.
- `results.jsonl` may remain a compatibility projection, but it is not the
  canonical campaign ledger.

These identifiers are distinct:

| Identifier | Meaning |
|---|---|
| `cell_id` | scenario × agent/harness × credential × OS × resource class, shared across arms |
| `pair_block_id` | contemporaneous scheduling block linking corresponding arm samples |
| `sample_id` | one pre-registered statistical observation: cell + arm + replicate |
| `execution_attempt_id` | one supervisor invocation or matched backfill invocation |
| `run_id` | canonical run artifact produced by an execution attempt |
| `runner_attempt_id` | W1 retry nested inside one run |
| `assessment_id` | one live or offline grading pass over frozen evidence |

No identity is reconstructed from a filename or timestamp. The supervisor
persists the planned sample and execution identity before process spawn; the
runner binds `run_id` immediately after allocation rather than waiting for
process completion.

### Lifecycle, failure, and retry doctrine

The supervisor is authoritative for the durable execution lifecycle:

```text
planned → queued → leased → starting → running → artifact_committed → classified
```

`cancelled`, `lost`, `broken`, and `deferred` are explicit terminal exits where
applicable. Every transition is durable and idempotent. Restart reconciliation
checks leases, process identity, run artifacts, and the artifact store before
dispatching more work.

Evaluation outcome, lifecycle, and artifact health are separate:

- `pass` and `fail` are valid behavioral determinations and are never retried.
- `unresolved` means a valid drive did not support a pass/fail determination. A
  clean Gauntlet `investigate` is unresolved and is not automatically retried
  or replaced.
- `infrastructure_failed` names a component, phase, stable cause code, evidence,
  retryability, and retry-policy version. Only causes explicitly marked
  retryable may retry.
- `cancelled` records an accepted stop request; it is not a fabricated
  behavioral verdict.
- `lost` records an admitted attempt with no live owner and no valid terminal
  artifact after bounded reconciliation.
- `orphaned` records an artifact without a durable sample/attempt link. The
  system reconciles it from embedded identity or quarantines and surfaces it;
  it never renders as `not_run`.
- `not_run` is reserved for a planned cell that was never admitted.

Retry the smallest failed component. A grader failure with a valid frozen
drive artifact creates another assessment over that artifact, not another
Coding-Agent drive. A drive retry is permitted only when a typed transient
cause invalidated the drive artifact. In fused mode, an unattributed
`investigate` remains unresolved. Every attempt is bounded by count, elapsed
deadline, and cost, and every attempt remains visible and charged.

Raw outcome is immutable. Analysis disposition is separately one of
`included`, `excluded`, `void`, or `pending`, with a closed reason code and the
pre-registered rule that authorized it. Only outcome-independent, positively
identified instrument failures may be excluded and replaced. Behavioral or
ambiguous non-completion follows the frozen decision rule or leaves the cell
underpowered; it is never silently removed from the denominator.

The realizable completion invariant is: **every admitted execution has exactly
one durable terminal lifecycle record and an explicit artifact pointer or
artifact-missing reason.** Power loss is not required to synthesize a
`verdict.json`.

### Pairing, top-up, and analysis

Every paired campaign declares whether `pair_block_id` is:

- a **scheduling block** controlling contemporaneous launch while independent
  eligible arm observations remain the analysis unit; or
- an **analysis block** whose complete matched outcomes are the inferential
  unit.

The campaign freezes a maximum arm-start skew, equivalent instrument/resource
requirements, missingness policy, minimum n, and sample-selection rule. If a
whole-drive sample needs replacement, the scheduler activates a new reserve
block for every arm. An independent delayed arm top-up cannot manufacture a
valid pair. Unmatched outcomes and all spend remain visible.

`-n` counts pre-registered sample identities, not only determinate final
attempts. At most one execution is included per sample. Additional observations
are labeled reserve/backfill samples linked to what they replace; retry and
backfill never erase the original evidence.

Inferential `quorum report --vs` resolves only to a named comparison in one
frozen campaign. Each outcome or metric pre-registers its estimand, analysis
unit, eligible classes, strata/blocks, inclusion and missingness rules, test,
sidedness, alpha, multiplicity policy, effect/interval method, minimum n, and
permitted decision language. Fisher is permitted only for declared independent
binary arm observations; analytically matched outcomes use a matched method.
Raw pooling across strata is descriptive only.

### Supervisor and operator contract

The supervisor is the only normal write front door for Stage 2 and Stage 3;
the dashboard remains read-only. The stable operator surface provides:

- idempotent `submit` with an operator-scoped request ID and canonical request
  digest;
- `list`, `status`, and sequenced `events` so a lost submit response does not
  lose the job;
- idempotent `cancel` from every nonterminal state; and
- `show`, `costs`, report, and artifact references.

The supervisor records the enrolled operator identity supplied by the trusted
access path for ownership, discovery, and audit. This is an operational
multi-user contract for Drew and Jesse, not an untrusted-user security model.

Job state is materialized from append-only events:

```text
accepted → queued → preflighting → running
running → waiting(reason, next_retry_at) → queued
any nonterminal → cancelling → cancelled
any nonterminal → failed
running → completed
```

Status reports owner, exact refs, state revision, queue position or blocker,
next retry time, progress, and artifact/report IDs. Supervisor startup repairs
the durable state; merely deriving `done` or `lost` at read time is not
recovery.

Workers use renewable, fenced leases naming the attempt, generation, resource
claims, issue time, and expiry. Only the current generation may launch, renew,
or commit a selected artifact. A missed heartbeat never overrides a valid
terminal artifact. Host PIDs remain local diagnostics rather than shared-store
liveness.

### Admission, quotas, resources, and cost

The supervisor is the sole admission authority for supervisor-managed work.
`--jobs` is a per-job ceiling, not an independent host slot pool. Before
launch, it atomically acquires every applicable permit:

- host or fleet execution capacity;
- per-job ceiling and per-operator share;
- harness/runtime seat;
- Coding-Agent quota pool;
- Gauntlet driver/grader quota pool while fused;
- pinned resource class;
- paired-block launch reservation; and
- campaign cost reservation.

Queued, backoff-blocked, cap-blocked, or pair-waiting attempts hold no runtime
permit. Durable fenced leases recover capacity exactly once after owner loss.
For a confirmatory block, every arm's permits are acquired in one transaction
with a short launch TTL. If any arm cannot start within the registered skew,
the block becomes broken and all unconsumed claims are released.

Endpoint routing is not quota identity. Every credential names an explicit,
non-secret `quota_pool_id`. One pool record owns its concurrency, launch
spacing, enforceable RPM/TPM windows, durable cooldown, account/seat/model/
region scope, and dated supporting evidence. Harness caps are separate
intersecting resources. Credentials sharing a pool cannot independently
override its limits, and every OAuth/subscription path declares an explicit
seat pool and cap; missing policy is an error, not “unbounded.”

W1 owns provider-specific rate-limit detection and classification. W2 alone
owns durable pool cooldown and scheduler retry. A retryable 429 records one
monotonic pool `blocked_until` using provider `Retry-After` and bounded backoff;
waiting work releases permits, cooldown survives restart, and recovery is
paced rather than a stampede. Exhausted windows become explicit deferred or
terminal outcomes, never silent skips.

Admission uses bounded fairness across operators and jobs. Longest-first
priority applies only within an equivalent ready fairness/pair class; across
heterogeneous pools, the child spec uses remaining predicted work divided by
effective bottleneck capacity. Paid running work is never preempted.

A cost cap is an admission-time commitment cap unless a provider/proxy can
enforce actual dollars. The supervisor reserves a frozen upper-bound estimate
covering Coding-Agent, driver/grader, runner retries, scheduler retries, and
matched backfill, then reconciles against captured actual cost. Unpriceable
work cannot enter a hard-capped campaign without an explicit pre-registered
override.

### Executor and artifact-commit contract

The supervisor owns planning, admission, pairing, quotas, cancellation intent,
and attempt selection. An executor owns one leased attempt in an immutable,
job-scoped environment and reports structured lifecycle and artifact identity.

Before dispatch, the supervisor assigns a staging destination. The executor
uploads a checksum manifest and completion marker; the supervisor atomically
commits the staged artifact and compare-and-swaps the selected attempt.
Replaying identical bytes is idempotent, conflicting bytes fail closed,
partial uploads never become terminal truth, and late attempts remain visible
without silently replacing the selected result.

Stage 2 supplies an appliance executor with immutable checkout, container or
process, temporary, and results namespaces. Stage 3 supplies a baked
Firecracker executor. Workers never self-admit; the operator and executor
contracts remain the same.

## Workstreams

Each workstream gets its own child spec and Linear issue before
implementation. Scope lines below bound the child specs; they do not replace
them.

### W1 — Reliability and waste (Stage 1)

Recover instrument waste without converting ambiguous behavior into passes.

- Retain the 2026-07-09 startup-hang detector, nested runner-attempt evidence,
  summed economics, and flaked-green visibility. Replace that design's broad
  clean-`investigate` retry predicate with the typed failure doctrine above.
- Split preparation into static validation, local provisioning and fixture
  setup, deterministic pre-checks, live credential/model validation, then
  drive. Fixture and deterministic pre-check failures occur before any provider
  call; live smoke calls are recorded as spend.
- Apply bounded deadlines and descendant-process teardown to provisioning,
  setup, checks, drive, and capture. Record the failed component and stable
  cause instead of a generic indeterminate.
- Make Gauntlet emit or preserve a structured terminal failure for adapter,
  driver, grader, provider, shutdown, and protocol errors. Quorum carries it
  through composition; free-text `run_error` remains diagnostic evidence, not
  a retry classifier.
- Extend rate-limit detection beyond the Antigravity marker. W1 classifies the
  failure; W2 owns the durable pool cooldown and scheduler retry.
- Re-classify the audited OpenCode indeterminates against the current
  snapshot/export implementation and harness revision, then fix only verified
  remaining causes. The historical 48% outcome is not current root-cause proof.
- Persist execution identity before child launch, bind `run_id` on allocation,
  and surface cancelled, lost, orphaned, and skipped work through the canonical
  ledger and read side.

Exit: on two consecutive registered sentinel executions, zero silently omitted
cells, zero hidden orphans, every admitted execution has one terminal lifecycle
record, and `infrastructure_failed + lost` is below 5% of all admitted samples.
`unresolved` is reported separately and is never reduced by outcome-dependent
retry.

### W2 — Scheduling and throughput (Stages 1–2)

The parallelism lever and the stable front door for both execution substrates.

- Upgrade the existing Phase-1 file-backed run/run-all/status/cancel job layer
  to the approved Phase-2 durable supervisor. Add request idempotency, queue and
  event discovery, state revisions, restart reconciliation, all-state cancel,
  named credential bundles, and enrolled operator identity.
- Define and test the migration of existing terminal, lost, and imported job
  receipts before retiring `run.lock`; legacy execution semantics do not become
  Stage-2 semantics.
- Replace the singleton mutable execution namespace with job-scoped immutable
  evals/Superpowers/Gauntlet snapshots, runtime/process identity, temporary and
  results namespaces, and the pinned resource classes defined above.
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
- Add fenced worker leases, structured artifact identity, atomic artifact
  commit, and restart/cancel fault handling behind the stable operator API.

Exit: deterministic multi-process and fault-injection tests prove no admission,
spacing, cooldown, resource, pairing, ownership, or reservation violation and
no silent cell. W2 then participates with W1, W3, and W7 in the real paired
campaign for success criterion 1; it cannot claim that criterion alone.

### W3 — Canonical campaign artifact and report (Stages 1–2)

Kill tea-leaf reading by making the planned denominator, evidence lineage,
missingness policy, comparison, and decision rule machine-enforced.

- Implement the canonical campaign, event, batch v2, verdict v2, assessment,
  and report contracts above. Persist the complete planned cohort before
  dispatch. An unsealed report is visibly **IN PROGRESS** and cannot emit a
  release decision.
- Make `n > 1` first-class. `results.jsonl` already preserves duplicate rows,
  but lacks sample/attempt identity and the current matrix displays only the
  last row while tallying every row. All display and statistics derive from
  the canonical sample ledger instead.
- `quorum report <batch>` is descriptive. Inferential campaign reporting only
  evaluates named pre-registered comparisons and the declared independent or
  matched method; it rejects arbitrary historical baselines.
- Every report shows target/reserve, planned, activated, started, terminal,
  included, excluded, void, pending, missing, skipped, orphaned, import-failed,
  and complete/broken pair counts. It preserves both intention-to-run and
  retained-analysis denominators.
- Move Gauntlet's optional v5 per-criterion verdict/evidence projection into
  the canonical immutable assessment contract. Regrades append assessments and
  never overwrite live results. W5 renders this data.
- Give deterministic checks stable criterion IDs, typed tags, and metrics with
  units for faceted reading and triage.
- Report measurement coverage. Null tokens or costs never aggregate as zero;
  totals distinguish measured, estimated, unpriceable, and missing data and
  separate all-attempt spend, retained-cohort subject cost, and grader overhead.
- Record plan, event-head, artifact, analyzer, statistics implementation, and
  schema digests. Identical frozen inputs regenerate byte-identical report JSON
  and HTML independent of filesystem order, host, time zone, or absolute path.
- Keep v1 artifacts immutable. Any backward-compatibility adapter is a
  separately approved decision and may expose legacy runs descriptively, but
  cannot invent a planned denominator, pair identity, model readback, or
  inferential eligibility.

Exit: the frozen fresh-gate fixture regenerates the same report bytes and
decision on two clean environments; every planned sample has an explicit
state; incomplete evidence and invalid comparisons fail closed; and a real
paired release-gate readout needs no hand-computed statistic or denominator
repair.

### W4 — Runner/grader split and rubric-blind driver (Stage 2-adjacent; Gauntlet upstream)

Decisions 4 and 5 require two distinct gates:

- **Gate A — frozen-evidence grader parity.** Regrade a pre-stratified,
  content-addressed corpus spanning pass, fail, unresolved, and instrument
  failures. Pre-register overall and per-criterion agreement, evidence-quality,
  failure-classification, and non-inferiority thresholds. The frozen drive
  artifact contains trajectory, workspace snapshot, deterministic probe
  outputs, driver script/prompt/model/provider/build identity, and completion
  reason; grading never probes a later mutable workspace.
- **Gate B — rubric-blind driver canary.** After Gate A passes, run
  contemporaneous rubric-aware versus rubric-blind drivers with a fixed offline
  grader. Pre-register behavioral, evidence-completeness, unresolved,
  interaction-adherence, cost, and duration thresholds.

Add scenario-declared grader-model selection over the existing per-run
`--grader-model` plumbing. A deterministic-checks-only mode requires an
upstream drive-only API and a manifest mapping every acceptance criterion to
deterministic post-check evidence; it cannot avoid fused grading merely by
ignoring the final report.

Exit: separate Gate A and Gate B experiment-log verdicts meet their frozen
thresholds; grader routing ships; and checks-only ships only if its drive-only
dependency and complete criterion coverage are proven. Fused mode remains the
fallback if either cutover gate fails.

### W5 — Dashboard and sharing (Stage 2)

- Scrub at capture finalization, after required normalization, checks,
  economics, model attestations, and frozen-evidence capture. Retain the
  analytical projection; remove credential-bearing homes rather than treating
  them as the long-term artifact.
- Render the canonical plan/ledger/report: run, batch, campaign, and complete
  paginated cell-history routes show planned, queued, running, included,
  replaced, excluded, cancelled, lost, orphaned, and missing samples, plus
  criterion evidence, provenance, measurement coverage, and all-attempt cost.
- Replace PID-based shared-store liveness with supervisor lease heartbeats and
  terminal-artifact precedence. Every page carries an event sequence; SSE gap
  detection resynchronizes from a snapshot so bounded queues cannot leave a
  slow client permanently stale.
- Store an immutable matrix manifest with each batch/campaign. The global suite
  manifest remains only a versioned coverage catalogue and cannot be overwritten
  into describing a different concurrent campaign.
- Define three artifact classes: raw operational, scrubbed internal analysis,
  and publishable static bundle. The existing import bundle is an internal
  donor, not the share object: publication excludes raw sessions, internal
  workdirs/logs, credentials, run homes, and machine-local paths.
- Static export contains the frozen plan, event slice, report, selected safe
  evidence/ATIF, relative viewer assets, provenance, and checksums. Planned but
  missing or failed samples remain represented; partial imports never become a
  smaller “complete” campaign.
- W5 owns the ATIF v1.7/Harbor viewer spike. Its child spec defines required
  trajectory features, acceptance threshold, and the fallback built-in viewer.
- Repair internal import semantics before using that archive operationally:
  stage, verify, and atomically rename payloads; preserve an existing good
  destination until commit; and return typed per-entry errors rather than only
  a failed count.
- Render W2's list/filter data and add artifact archive and dry-run prune flows
  with separate retention for raw, internal, and published artifacts.
  Report/provenance remain readable after allowed raw-payload expiry.

Joint W2/W5 exit: Jesse completes the registered end-to-end UAT without an
appliance shell: recover a lost submit response, interpret queue/backoff/retry
state, cancel one queued and one running job, survive a supervisor restart,
read the sealed campaign, and open an offline static bundle whose counts match
the report.

### W6 — Fleet (Stage 3)

- Adapt the digest-pinned `everyharness-container` base already used by the
  evals Docker image into a bootable, immutable-identity Stockyard Firecracker
  guest; one VM executes one fenced attempt under a pinned resource class.
- Use the W2 leased-executor protocol. The guest reads an immutable job spec,
  uploads a staged checksum manifest and completion marker, waits for or safely
  tolerates commit acknowledgement, and powers off. Duplicate, reordered,
  partial, and late uploads follow the shared artifact-commit contract.
- Put distributed quota-pool admission behind the supervisor. Workers never
  self-admit and the operator does not learn a fleet-specific submission path.
- Extend enrollment from the Stage-2 trusted operator path; do not defer Jesse's
  basic multi-user workflow until the fleet.
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
  including subject, fused driver/grader, harness, account/seat, RPM/TPM,
  resource, and cost constraints. Model each serial critical path as well as
  aggregate ≥7× throughput.
- De-single-point the grader through a key pool or calibrated Bedrock grader
  (PRI-2524). A model/provider change goes through W4 and provenance gates.
- Size Bedrock raises from the frozen workload model; convert OAuth to API-key
  routes where a key path exists. Reconcile checked-in policy with reality:
  Antigravity is capped at 1, Codex subscription currently has no explicit cap,
  and Copilot credentials are capped at 4. An unpooled account is serial unless
  live evidence and an explicit account-scoped budget approve otherwise.
- Implement campaign/operator/pool commitment reservations covering both LLMs,
  all retry layers, and matched backfill; preserve visible unpriceable coverage.
- Before any redesign code reaches the appliance, fix PRI-2833: `prepare`
  performs a frozen evals dependency install for the exact resolved evals ref,
  does not depend on a pre-existing bind-mounted `node_modules`, and runs
  `quorum check` from that installed environment.

Exit: a versioned capacity artifact plus controlled saturation receipt proves
the joint pool/resource graph supports sustained ≥7× for the acceptance
fixture without cap, spacing, cooldown, model, resource, or cost-reservation
violations. A documented nominal budget alone does not clear W7.

## Program-wide acceptance evidence

Child specs turn the contracts above into executable acceptance tests. At
minimum the integrated program must prove:

- crash/restart/cancel behavior at every boundary from durable plan write
  through permit acquisition, spawn, run allocation, verdict write, artifact
  upload, commit, and report projection;
- two concurrent OS processes and two operators cannot exceed any shared slot,
  spacing, cooldown, resource, quota-pool, or cost-reservation limit;
- stale lease generations and duplicate/late uploads cannot publish a winning
  artifact or increase statistical n;
- truncating the campaign event stream at any prefix cannot manufacture a
  complete campaign, valid pair, or release decision;
- a missing/mismatched ref, model readback, scenario digest, grader
  configuration, resource readback, or measurement remains visible and fails
  its corresponding inference gate;
- retry and backfill fixtures preserve raw outcomes and all-attempt spend and
  never discard a behavioral or ambiguous non-completion;
- identical frozen inputs regenerate identical report data and static-bundle
  checksums; and
- the live Stage-2 receipt demonstrates the registered acceptance campaign only
  after all deterministic, migration, reconciliation, and operator-UAT gates
  pass.

## Sequencing

The workstreams may develop in parallel, but integration follows these gates:

1. **Contract gate first.** The campaign/sample/attempt/assessment contracts,
   failure taxonomy, and provenance/resource schemas are the first shared slice
   of W1, W2, and W3. No multi-job scheduling, top-up, central reporting, or
   fleet work may invent a different identity or lifecycle.
2. **Reliability and quota inputs.** W1's typed failure/rate-limit
   classification and W7's measured quota-pool budgets gate W2 cooldown,
   cross-process admission, and throughput proof. W1 and W2 are not independent
   at the rate-limit boundary.
3. **Stage-2 release gate.** W2 scheduling and W3 reporting may implement in
   parallel, but both land before success criterion 1 is attempted. The result
   belongs jointly to W1, W2, W3, and W7.
4. **Grading and retained artifacts.** W4 may run Gate A once canonical frozen
   evidence exists. W5's capture-finalization and retained-artifact contract
   lands before static sharing or any W6 upload to a central artifact sink.
5. **Fleet last.** W6 starts only after the northbound supervisor and internal
   executor contracts stabilize and Stage 2 passes restart/reconciliation
   tests. Stage 3 preserves those contracts while changing the executor.

## Non-goals

- Windows and Antigravity columns stay on their separate trusted-maintainer
  paths; the fleet is Linux/amd64.
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
- **Stage-2 isolation may not fit the current box.** The live appliance has
  finite CPU and memory. Admission must refuse resource claims it cannot honor;
  if the registered acceptance workload cannot achieve valid ≥7× Stage 2, the
  result is evidence to advance W6, not permission to run unpinned.
- **A durable row is not durable execution.** Lost supervisor responses,
  owner death, PID reuse, partial uploads, and late workers can duplicate or
  misattribute paid work without fencing, reconciliation, and atomic commit.
- **Campaign freezes collide with rollout.** Evals main freezes during gates;
  redesign work lands between campaigns. Exact per-job snapshots remove the
  mutable-checkout freeze only after their identity and isolation gates pass.

## Relationship to prior specs

This program retains and supersedes prior decisions explicitly:

| Prior design | Retained | Superseded or amended here |
|---|---|---|
| 2026-06-12 scheduler | one true per-scheduler slot pool, limiter caps/spacing, injectable clock, and one terminal scheduler event per scheduled attempt | for supervisor-managed work: per-process caps/spacing, arbitrary/no-priority dispatch, no-fairness doctrine, and batch-lifetime latch-and-skip; W2 adds shared admission, block-aware priority, bounded fairness, durable cooldown/retry, and explicit quota-pool identity |
| 2026-06-18 shared appliance | Phase-2 durable job store and northbound submit/status/cancel/show/costs surface | Phase-1 single active `run.lock`, shared mutable checkout/container execution, and a job row without the canonical sample/attempt ledger; W2 adds immutable namespaces, leases, reconciliation, list/events, and artifact commit |
| 2026-06-18 dashboard decoupling | dashboard remains a read-only consumer | nothing; W5 may materialize campaign state into a filesystem read model but may not launch or cancel work |
| 2026-07-09 retry design | startup-liveness detector, one canonical run dir with nested runner-attempt evidence, bounded attempt structure, summed economics, and flaked-green visibility | the `investigate + error == null` retry predicate and last-attempt headline semantics; clean/ambiguous investigates are unresolved, retry targets the smallest failed component, and campaign backfill is a separate matched-sample operation |
| 2026-08-09 import design | allowlisted payloads, checksums, provenance uncertainty, and resumable internal transfer | its internal raw-session/workdir bundle is not the static share object; W5 adds capture-finalization retention classes, typed atomic import repair, and a narrower publication projection |

All unaffected portions remain binding. “No prior spec is retired” does not
preserve the specific decisions this table replaces.
