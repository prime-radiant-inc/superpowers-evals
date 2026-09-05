# Core comparison implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure a supported comparative question, run it once through the appliance, and obtain an honest comparison and accounting report, including after cancellation or controller loss.

**Architecture:** Retain the runner, provisioning, capture, snapshot, classification, and admission algorithms. Replace campaign lifecycle authority with one atomic journal fold, prepared container ownership, a single controller authorization, and termination-only cancellation. Reports consume fixed primary slots and immutable attempt evidence; cost never authorizes work.

**Tech Stack:** TypeScript, Bun >=1.3.13 (the current package floor), Zod, bun:sqlite, existing Docker CLI adapter, GNU coreutils timeout under Docker init. No new service, runtime framework, or token accounting library.

**Spec:** [Campaign consolidation design](../specs/2026-09-04-campaign-consolidation-design.md).

**Tracking:** [PRI-2874](https://linear.app/prime-radiant/issue/PRI-2874/quorum-overhaul-campaign-platform-comparative-evals-as-configuration), selected by Drew, In Dev.

## Global Constraints

- The supported campaign product runs on one Linux appliance for trusted maintainers, with one live campaign per appliance and parallel attempts inside it.
- The current increment delivers that comparison within one controller session.
- A lost controller is never replaced for the same campaign.
- Post-crash cancellation is the only mutating operation on interrupted work.
- No database transaction spans a provider call, container operation, or filesystem publication.
- Missing price does not stop behavioral measurement.
- Reserve blocks add replacement capacity, never planned samples.
- Preserve scenario checks/manifests, provisioning, agent adapters, capture/ATIF, eligibility, frozen snapshots, credential scoping, writer fencing, and host exclusion.
- Direct `quorum run` and `run-all` remain development workflows with real platform checks. They are not alternate campaign backends.
- Do not move or convert old artifacts during development. No runtime V1 compatibility reader. Operational cutover and paid runs require separate authorization.
- Existing untracked review notes are not implementation inputs or permission to change scope. Do not stage them.

---

## Source integration and contract precedence

At Drew's explicit request, use the fresh `.worktrees/core-comparison` worktree on `codex/core-comparison` for implementation. It starts at design/plan commit `270dd5b5`, descended from main `f8e1889c745f916491526b5e57ea3fa30e9dfcac`. Merge appliance work `65c28448625d8446720f36c377890879dacd7f1d` into this branch before implementation. The source tips' common ancestor is `c2059d0b7e1ca68c6ee60222d13e7fbca3ff2a8a`; neither source supersedes the other. In particular, retain main's Codex/Kimi/Pi/Copilot capability and estimate fixes as well as the appliance container implementation. The earlier design worktree remains a design workspace.

This plan makes the consolidation design's overrides explicit:

| Earlier contract | Binding core interpretation |
|---|---|
| Platform rev 3 comparative configuration, frozen identity, measurement validity | Retain; supported axes stay the current agent/model/credential/scenario/skill-ref-or-none axes. |
| D1-D3 budget, exposure dollars, gating profiles and price gates | Remove from V2 intake, admission, journal, and commands. Existing cost capture remains measurement. |
| D3 incremental internal event prefixes and recovery repair | Replace with complete validated atomic transitions. External effects still need prepared and bound ownership. |
| V2 snapshot/mount/credential hardening, namespace isolation, immutable publication | Retain. Freeze the complete runtime specification before create. |
| V2 controller replacement, adoption, recovery admission, storage pause | Omit. Interruption is terminal for admission; cancellation only establishes death and closes accounting. |
| D4a sealed-only report access and inclusion-coupled costs | Replace with prefix-bound incomplete reports, accepted-only behavior, and independently validated all-attempt accounting. |
| D4a exposure/contention/provenance validity | Retain the checks; invalid observations cannot enter the selected behavior cohort. Removing gating does not waive measurement validity. |
| Early allocation of runner run ID | Runner keeps allocating run IDs. Allocate attempt/output/container identity before create; bind the run ID only after manifest and identity verification. |
| Appliance job lifecycle | Invocation receipt only. Campaign state comes from the shared journal fold and current ownership observation. |

Historical specs and evidence continue to describe their original V1 behavior. They are not migration requirements. The integrated branch is the only development location; do not retire the installed runtime during this work.

## File map and interfaces

Change existing modules by responsibility. New files below hold domain boundaries, not a parallel controller implementation. Old V1 entry points may remain temporarily during dependent commits, but Task 9 removes them from the shipping import/command graph.

| Files | Responsibility |
|---|---|
| `src/contracts/campaign/experiment.ts` (new), `suite.ts`, `campaign.ts`, `digest.ts` | V2 frozen experiment, primary slots, reserve inventory, independent invocation identity, existing shared runner identity. |
| `src/contracts/campaign/execution.ts` (new), `src/campaign/execution-state.ts` (new) | Closed transition grammar and the sole incremental lifecycle/inclusion fold. |
| `src/campaign/journal.ts`, `src/campaign/ownership.ts` (new), `locks.ts`, `src/cli/run-command.ts`, `src/run-all/index.ts` | Atomic transition storage, fencing, durable host claim and termination receipt; authenticated child versus host admission. Keep allocated reserve/fsync primitives. |
| `src/campaign/resource-policy.ts` (new), `registration.ts`, `campaign-document.ts`, `arm-suite-check.ts` | One compiled policy; snapshot-first registration and authentic V2 intake. |
| `src/campaign/container-spawner.ts`, `spawn.ts`, `attempt-projection.ts`, `attempt-publish.ts`, `src/agents/command-runner.ts`, `container/attempt-entrypoint.sh`, `container/Dockerfile` | Prepared/create/bind/start boundary, strict projection, independent deadline, verified death and immutable evidence. |
| `src/appliance/cli.ts`, `campaign-run.ts`, `process.ts`, `types.ts`, `src/campaign/cancellation.ts` (new) | Gated controller launch and cancellation without admission/replay reconstruction. |
| `src/campaign/dispatcher.ts`, `classifier.ts`, `contention.ts`, `key-select.ts`, `sensors.ts` | Existing admission algorithms over the new state. Bounded in-session whole-block replacement and explicit validity. |
| `src/campaign/report-evidence.ts`, `report.ts`, `seal.ts`, `src/contracts/campaign/report.ts` | Attempt-keyed evidence, pure report fold, evidence anchor, canonical JSON and readable rendering. |
| `src/cli/campaign.ts`, `src/appliance/cli.ts`, `docs/appliance-runbook.md`, `docs/campaign-comparisons.md` (new), `examples/campaigns/` (new) | One supported operator journey and four question examples. |
| `src/campaign/recovery.ts`, `src/contracts/campaign/{journal-events,state-machine,crash-windows,profile-params}.ts` | Remove retired campaign responsibilities after their consumers are cut over; keep shared leaf contracts only when another supported workflow actually imports them. |

### Shared records

Define strict Zod schemas alongside these types; never deserialize with a cast. Use the existing `CampaignIdentity`, `ExecutionSurfaceArm`, `ContentionDeclaration`, `CheckRecord`, `FinalVerdict`, and `TokenUsage` contracts for their existing data. `ArtifactRef` is a relative path, SHA-256, and byte length under the immutable attempt publication root; reject traversal, symlinks, digest mismatch, and another attempt's identity.

```ts
type ProcessIdentity = { pid: number; birth: string; boot_id: string };
type ExperimentIdentity = { campaign_id: string; input_digest: string };
type PlannedSlot = {
  sample_id: string; primary_block_id: string; comparison_id: string;
  scenario: string; arm: string; replicate: number;
};
type ReserveSlot = { reserve_id: string; comparison_id: string; scenario: string };
type PoolPolicy = {
  pool_id: string; max_concurrency: number; launch_spacing_seconds: number;
};
type ArtifactRef = { path: string; sha256: string; bytes: number };
// Same wire shape, resolved only under the campaign's immutable control evidence root.
type CampaignEvidenceRef = { path: string; sha256: string; bytes: number };
type Observed<T> =
  | { value: T; artifact: ArtifactRef }
  | { missing: 'absent' | 'invalid' | 'unpriced' | 'not_recorded' };
type AttemptIntent = {
  identity: CampaignIdentity; primary_block_id: string; attempt_number: number;
  output_root: string; container_name: string; runtime_spec_digest: string;
  runtime_spec: AttemptRuntimeSpec;
};
type BlockActivation = {
  block_id: string; primary_block_id: string; reserve_id: string | null;
  predecessor_block_id: string | null; attempts: AttemptIntent[];
};
type ExecutionStart = ExperimentIdentity & {
  start_id: string; launcher: ProcessIdentity; claimed_at: string;
};
type HostCampaignClaim = ExecutionStart & { campaign_dir: string };
type VerifiedStopped = {
  execution_attempt_id: string; container_id: string | null;
  proof: 'inspected_stopped' | 'verified_absent' | 'never_created';
  observed_at: string;
};
type AttemptObservation = {
  execution_attempt_id: string; stopped: VerifiedStopped;
  outcome: 'pass' | 'fail' | 'indeterminate';
  failure_class: 'evidence' | 'instrument' | 'aborted';
  cause: string | null; artifacts: ArtifactRef[];
  evidence_missing: string | null;
  validity: 'valid' | 'invalid' | 'unknown';
};
```

`Experiment` in `experiment.ts` is schema version 2 and contains identity, the normalized suite, resolved refs, cells/comparisons, `planned_slots`, `reserve_slots`, execution surface and public credential authority digest, pool policy, contention declaration, frozen runtime limits, optional estimates, registration actor/time, and input digest. Retain existing source/snapshot authentication. Compute `input_digest` without campaign ID or registration time/actor; generate campaign IDs independently using `crypto.randomUUID()`. Two registrations of identical inputs have different IDs and equal input digests.

`SuiteSchema` version 2 retains name, comparisons, scenario selectors and per-cell `n`; requires `reserve >= 0`, `attempt_bounds.max_attempts >= 1`, finite positive `attempt_bounds.max_time_s`, and explicit finite exposure-skew bound. Remove kind, budget, profile/profile parameters, cell class/tripwire, declared metrics, and pricing overrides. `reserve` is extra whole-block activations per comparison/scenario cell. `max_attempts` counts each primary slot's initial attempt plus successors. A replacement must satisfy both limits and always reruns the whole block; there is no separate unbounded retry counter. Frozen graceful shutdown allowance is 5 seconds.

### Atomic grammar and selection

`CampaignTransition` is a strict discriminated union with `{transition_id, at, type, payload}`. Its type/payload pairs are below. Store audit events grouped by `transition_id` in one SQLite transaction. An implementation may represent a compound transition as one event containing its members; it must not expose partially applied members. `commitTransition(transition: CampaignTransition): CommittedTransition` validates against the current `CampaignProjection`, appends the complete group, commits, and only then replaces the projection. `foldTransition(state: CampaignProjection, transition: CampaignTransition): CampaignProjection` is pure and is shared by writer, reader, status, and dispatcher. The reader does not infer missing transitions.

| Type / payload | Preconditions and effect |
|---|---|
| `registered / ExperimentIdentity` | First transition only; anchors the published document. |
| `started / ExecutionStart` | Registered and never started. Permanently consumes start authorization. |
| `controller_bound / {start_id, controller: ProcessIdentity}` | Matching start, no prior different controller. Does not grant another start. |
| `block_activated / BlockActivation` | Bound live session, no stop intent, primary not yet selected; atomically records all attempts and selects this coherent instance. |
| `block_replaced / {activation: BlockActivation, reason: ReplacementCause}` | Predecessor selected, all its workers verified dead, typed replaceable reason, reserve and per-slot allowance available. Atomically consumes reserve, creates all successor intents, excludes predecessor and selects successor. |
| `runtime_bound / {execution_attempt_id, container_id, runtime_spec_digest}` | Prepared attempt only; exact specification digest; immutable ID may be bound once. |
| `runtime_started / {execution_attempt_id, observed_at, receipt: 'docker_start_succeeded'}` | Bound attempt; durably records the successful, settled Docker start response, not permission to start. Missing this row after a crash never proves no worker ran or that the request settled. |
| `attempt_observed / {observation: AttemptObservation, excluded_block: {block_id, reason} | null}` | Exact intent and verified death; closes execution immutably with validated references or explicit missingness. Only live controller may accept behavior. If this observation establishes invalid/unknown required validity, exclude its coherent block in the same transaction; do not wait for a replacement. |
| `accounting_observed / {execution_attempt_id, stopped: VerifiedStopped, artifacts: ArtifactRef[], evidence_missing: string | null}` | Persists verified death and available accounting, including an empty artifact set with explicit missingness; accepted behavior unchanged. May be written by cancellation for orphan accounting. |
| `block_validated / {block_id, evidence_refs: CampaignEvidenceRef[]}` | Live controller only, all member executions closed and required validity audits complete. Positive inclusion receipt; cannot undo an invalidation. |
| `block_invalidated / {block_id, reason: ValidityCause, evidence_refs: CampaignEvidenceRef[]}` | Live controller only, before ended. Atomically excludes an activated block when a closed-window validity audit arrives after observations were accepted. No observation rewrite, reserve consumption or successor required. |
| `block_exhausted / {primary_block_id, reason: ReplacementCause}` | Selected failed instance closed, no legal replacement remains. Its excluded observations stay readable; fixed slots become observed-but-excluded. |
| `ended / {outcome: 'completed'|'cancelled'|'interrupted', reason: string, cancel_intent: CampaignEvidenceRef | null}` | No further admission. Completed requires every primary block resolved with final validity receipt or exhausted and all workers stopped. Cancelled requires an authenticated ordinary cancel-intent reference and all workers stopped. Interrupted never changes to completed/cancelled. |
| `termination_verified / {start_id, stopped: VerifiedStopped[], process_evidence: CampaignEvidenceRef[]}` | An existing ended outcome and complete intent inventory, controller and pending launcher verified dead or current authorized terminator, no possible owned live worker. Enables removal of matching host claim. Never changes inclusion. |

`ReplacementCause` is the closed table below, not arbitrary strings. Reject duplicate identities, missing arms, wrong primary slots, changed arm mapping, reserve reuse, cross-cell successors, backward timestamps where monotonicity matters, changed runtime binding, and transitions after termination. A duplicate `transition_id` is idempotent only if canonical bytes match; different bytes are corruption. No standalone mutable sample status is persisted. The projection stores immutable attempts and one selected block instance per primary block, plus exhausted disposition.

`ValidityCause` is `contention | exposure | skew | missing_telemetry | provenance`. Late validity audits use `block_invalidated` even when no replacement remains, and completion waits for all required closed-window audits. Cancellation cannot perform new validity adjudication. Interrupted reports honor every previously committed invalidation while leaving unaccepted artifacts unpromoted.

Pass/fail observations require supporting artifacts; empty evidence can only support an explicitly missing indeterminate observation. Accounting or termination may persist a newly discovered immutable container ID for an unbound intent after authenticated inspection, preserving uniqueness and every known ID. That observation never grants start authority.

The positive `block_validated` receipt is required for analytical inclusion; pending validity is explicit missingness even when raw attempt outcomes are readable. Artifact bytes, symlinks, process death and cancellation sidecars are authenticated at the IO boundary before journal commit. Task 5 authenticates immutable attempt publication; Task 7 commits only those verified references; Task 8 revalidates the referenced bytes for field-level reads. Task 3 authenticates cancellation and termination/control-evidence anchors, while runtime producers establish actual namespace death and operation settlement. The pure fold checks record identity, path shape and legal predecessors, not the filesystem. Cancellation intent remains the one fsynced sidecar; do not add a second journal intent authority. A cancellation writer may append accounting, end and termination records only, never behavior, validity, admission or replacement decisions.

### Failure policy

Use `classifyFailure()`'s first-match rows only with qualified production evidence, then apply this session policy. Do not make retry depend on pass/fail or on cost. Drew explicitly deferred subject lifecycle/error reporting after review established that aggregate Quorum stderr, process exit, and Gauntlet teardown cannot authenticate the required subject causes. Retained classifier names alone are not supported capabilities.

| Evidence/cause | Behavior and execution action |
|---|---|
| Valid pass/fail; unknown indeterminate with no recognized instrument cause | Accept observation; no replacement. |
| Authenticated `grader_rate_limited`, qualified `grader_crashed`, `setup_failed`, `capture_failed`, `checks_crashed` | Verify/stop the whole block; retain every observation/cost; select a whole-block successor only if both finite allowances permit. Preserve existing pool latch/spacing behavior. |
| Subject spawn/crash/rate-limit claims without reliable actor evidence | Indeterminate; no automatic retry or pool latch from that claim. Coordinated subject lifecycle/error producers are deferred by Drew. |
| `grader_billing_exhausted`, `grader_misconfigured`, public credential revocation | End session incomplete and stop owned workers. Repeating a known unusable configuration cannot buy useful evidence. |
| Sustained contention, failed exposure/skew validity | Exclude affected coherent blocks, preserve costs, use bounded whole-block successor if legal. Missing required telemetry is an invalid observation, never silent validity. |
| Snapshot or frozen authority drift, storage failure, controller loss | End interrupted; no drift repair, pause, or recovery admission. |
| Operator cancel | Stop; retain already accepted observations. Controller loss observed before cancellation remains interrupted. |
| Runtime monitor failure, Docker-client timeout, unknown ownership | Stop/inspect; keep capacity and host guard until verified death. If death becomes known, retain an indeterminate observation; unknown cause does not become a retryable instrument error. |
| Deadline, exit 124/137 without conclusive typed cause | Indeterminate; cost retained. Exit code alone does not prove which deadline or process caused it. No automatic replacement on ambiguous cause. |
| Invalid/missing published evidence | Indeterminate with explicit missingness, or the existing typed capture/check failure if independently established. Never infer a pass or cost completeness. |

The qualified grader-crash producer retains the actual Gauntlet child code and signal in the frozen verdict layer. It can establish `grader_crashed` only for an indeterminate invocation with no parseable Gauntlet result and an intrinsic fatal signal (`SIGABRT`, `SIGSEGV`, `SIGBUS`, `SIGILL`, `SIGFPE`, `SIGTRAP`, or `SIGSYS`). Stopped/cancellation and permanent-misconfiguration precedence remain intact. A valid result, arbitrary nonzero code, 124/137/130, or HUP/INT/TERM/KILL does not buy a retry. Check-manifest mismatch already reaches `checks_crashed` through the actual composer's `checks` stage; no prose parser or synthetic manifest-mismatch sensor is needed. Independently established validity causes retain their existing policy and cannot be inferred from an unsupported actor claim.

## Runtime and ownership sequence

The helper holds `run.lock -> live-spend lease -> journal lease` in that order. Commit `started` first, then durably publish a host claim pointing to that exact campaign/start identity, then spawn a child blocked on a private inherited pipe. A crash before claim publication has no possible worker, but the start remains permanently consumed. No controller or raw entry point may launch before the claim is durable. Persist the child's PID/birth/boot identity, recheck cancellation and fencing, then release its gate. EOF, invalid release, or a 30-second startup gate timeout exits without admission. `DETACHED_SPAWN_ACK` alone is insufficient: it currently precedes unref, not child execution.

Release and reacquire normal per-process leases during handoff; never copy/transfer lease token bytes. The durable host claim bridges that gap. The controller may acquire for the exact bound start and identity; every other acquisition in `acquireLiveSpendLock()` refuses while that claim is unresolved. A forged environment variable is not matching ownership. Direct run/run-all, another campaign, credential bundle mutation, helper replacement, and refresh all consult this guard. Supported refresh/replacement cannot remove the current ownership reader while unresolved work exists.

The covered-child branch in `src/cli/run-command.ts` currently skips acquisition entirely. Route that branch through explicit child authorization; the marker alone cannot authorize it. Run-all children must validate their live parent lease identity. A container attempt validates its exact private prepared authority through the entrypoint/runner contract, without mounting host locks or the credential bundle. Keep these two existing child roles explicit; add no general capability service. All host-side lock/claim readers use the same canonical configured lock root, never the attempt's throwaway HOME.

On the appliance, resolve the root from the existing canonical `/srv/quorum/config/appliance.json`; an explicit `EVALS_APPLIANCE_CONFIG` may select a configuration only if its lock root agrees with that canonical appliance configuration. An explicit `QUORUM_LIVE_SPEND_LOCK` mismatch refuses. A present but unreadable/invalid appliance configuration refuses; it never falls back to HOME. Parse the exact bytes from one pinned no-follow configuration read. The HOME fallback remains only for a workstation without appliance configuration. Add env-unset raw run/run-all tests against an active helper claim. Helper installation with a custom configuration must retain the canonical lock-location configuration; it cannot create a second appliance authority. Tasks 6/9 wire the existing installer, source refresh and supported credential mutations through the same host lease and preserve a usable ownership reader.

Prepare private inputs, output root, exact credential projections, deterministic name and complete Docker specification; commit intent; create and inspect; commit immutable container binding; start. Keep runner-minted run IDs and verify/bind them at publication. Docker create/start/inspect/stop client calls have a finite timeout through the existing `CommandRunner` seam; timeout is unknown state, never absent/dead. Inspect image, command/entrypoint, timeout arguments, labels, mounts, user, private PID namespace, init, restart policy, and hardening against the prepared specification.

```ts
type PreparedExecution = {
  intent: AttemptIntent;
};
type BoundExecution = PreparedExecution & { container_id: string };
type StopObservation =
  | { kind: 'dead'; stopped: VerifiedStopped }
  | { kind: 'unresolved'; reason: string };
interface AttemptRuntime {
  create(prepared: PreparedExecution): Promise<BoundExecution>;
  start(bound: BoundExecution): Promise<AttemptMonitor>;
  inspectOwned(prepared: PreparedExecution): Promise<OwnedRuntimeObservation>;
  stop(bound: BoundExecution, graceSeconds: number): Promise<StopObservation>;
}
```

Freeze exact public environment values, entrypoint and identity labels in the runtime specification; names alone cannot authenticate output or authority paths. `QUORUM_ATTEMPT_AUTHORITY_FILE` identifies the private prepared attempt authority, distinct from the credential-authority digest. Its fixed target is `/run/quorum/attempt-authority.json`; the strict document is `{schema_version:1,campaign_id,input_digest,start_id,intent}`. Its single read-only file mount must have a private source outside writable output and every writable source mount, including equal paths. Task 3 validates this contract; Task 5 produces and inspects the actual complete layout. Secret values remain in private credential projections.

Define `AttemptRuntimeSpec` as the existing structured Docker inputs plus frozen deadline/init/restart/private-namespace fields; persist its complete public contents in the intent and authenticate them with `runtime_spec_digest`. It contains no secret values. Cancellation must not reconstruct this specification from mutable configuration. `OwnedRuntimeObservation` is `absent | matching-created | matching-running | matching-stopped | unresolved`, each matching case carrying the immutable container ID and inspected specification digest. `AttemptMonitor` exposes separate `onStopped(VerifiedStopped)` and `onMonitorFailure(reason: string)` callbacks. No callback from a failed follower is death proof. Unknown runtime state prevents publication, capacity release and replacement.

A stopped/absent snapshot is insufficient when a start-capable Docker request may still be in flight. Track that uncertainty through the runtime seam; killing or timing out the CLI does not settle the daemon request. In that case `stop` returns unresolved, retaining host ownership, until it has a conclusive operation completion receipt and subsequent namespace-death proof. Add a fake cut that reports stopped, then delivers a delayed successful start: publication and capacity/host release must remain blocked. A controller crash without a durably recorded start response is also uncertain. Repeated cancellation may establish later runtime completion/death, but may not manufacture a receipt from elapsed time. Exact-ID disposal could provide a future alternative after pinned-runtime proof; this plan does not assume it or introduce general cleanup.

Use `/usr/bin/timeout --signal=TERM --kill-after=5s <max_time_s>s <attempt-entrypoint> ...` as init's direct child, with `--init --restart=no`. Its clock starts before entrypoint preparation and covers setup, drive and capture. Pin and check GNU timeout availability in the image. The intended namespace teardown follows [GNU timeout semantics](https://www.gnu.org/software/coreutils/manual/coreutils.html), [Tini's main-child exit behavior](https://github.com/krallin/tini/blob/master/src/tini.c), and [Linux PID namespace init termination](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html); Linux integration must prove the actual pinned image, including daemonized signal-ignoring descendants.

Cancellation first publishes and fsyncs a campaign/start-bound intent sidecar without waiting for the journal writer. Intent records whether controller loss was already established. Fence pending launch release, ask the live controller to stop, then signal and verify its identity has died if necessary. Only after controller death may a cancellation writer take over. Resolve every prepared intent by exact name plus expected specification, including create-before-binding. Stop containers, verify death, publish immutable accounting where valid, append interruption/cancellation and termination receipts, then clear only the matching host claim. It never reconstructs dispatch, adopts workers, selects observations, activates reserves, or modifies previous outcomes. Repeated cancel is idempotent; ambiguous identities remain unresolved.

On ENOSPC, cease admission and stop all owned workers. Keep the existing physically allocated 8 MiB reserve. After stop attempts, release it and write/fsync bounded interruption and death evidence; if journal publication fails, use a campaign/input/start-bound emergency sidecar. If both fail, or workers remain unknown, retain the host claim and report unresolved. Verify/recreate the reserve before admitting any new campaign. Never report resumable storage pause.

Status precedence: invalid/unreadable ownership -> `unresolved, next_action=cancel`; outstanding stop intent/unverified workers -> `stopping, next_action=cancel`; dead controller after start and before an ended transition -> `interrupted, next_action=cancel` until termination verified, then `next_action=register`; terminal journal -> its immutable outcome, with `next_action=cancel` while termination or claim release remains outstanding and `next_action=report` after ownership is resolved; matching live controller -> `running, next_action=status`; no start -> `registered, next_action=run`. Controller loss after a committed completed/cancelled end never rewrites that outcome. A claimed launch with unknown/dead launcher and no released controller is interrupted, not registered. Active status exposes progress/cost coverage only, no pass/fail results.

## Worked report oracle

Checked-in fixture: `test/fixtures/core-comparison/`. Values below are already frozen evidence, not inputs to a new cost estimator. Two comparisons repeat baseline B: C1 is B/T1 with four primary pairs; C2 is B/T2 with two. All rows are executed attempts; the two C2/r2 workers are stopped during interruption and have unaccepted behavior. C1/r4 never executes. C1/r3's first block is superseded atomically by its reserve successor. `?` means missing, never zero. Times are seconds.

| Comparison/replicate/instance | Arm | Accepted selected outcome | Subject $ | Grader $ | Wall s |
|---|---|---|---:|---:|---:|
| C1/1/primary | B | pass | 1 | .1 | 10 |
| C1/1/primary | T1 | pass | 2 | .2 | 20 |
| C1/2/primary | B | fail | 100 | 1 | 100 |
| C1/2/primary | T1 | pass | ? | .4 | 40 |
| C1/3/primary | B | superseded pass | 3 | .3 | 30 |
| C1/3/primary | T1 | superseded instrument indeterminate | 4 | .4 | 40 |
| C1/3/reserve | B | indeterminate | 5 | .5 | 50 |
| C1/3/reserve | T1 | pass | 6 | .6 | 60 |
| C2/1/primary | B | pass | 7 | .7 | 70 |
| C2/1/primary | T2 | fail | 8 | .8 | 80 |
| C2/2/primary | B | unaccepted artifact says pass | ? | .9 | ? |
| C2/2/primary | T2 | unaccepted / absent | ? | ? | ? |

Required exact assertions:

- C1/B denominator 4: pass 1, fail 1, indeterminate 1, no usable result 1. C1/T1 denominator 4: pass 3, no usable result 1. C2/B denominator 2: pass 1, no usable result 1; C2/T2 denominator 2: fail 1, no usable result 1. Never pool B across C1/C2.
- C1 complete determinate pair count 2: baseline .5, treatment 1, delta +.5. C2 pair count 1, delta -1. C1/r3 is absent from all conditional pair quantities because its baseline is indeterminate.
- Use arithmetic means and mean within-pair treatment-minus-baseline differences. C1 subject cost has one matched pair: 1 vs 2, delta +1. Comparing independently available means (50.5 vs 4) is wrong. C1 grader cost has two matched pairs: .55 vs .30, delta -.25. C1 wall time has two matched pairs: 55 vs 30, delta -25 seconds.
- All 12 attempts remain in accounting. Subject known subtotal $136 with 9/12 priced; grader known subtotal $5.90 with 11/12 priced; known combined subtotal $141.90, explicitly incomplete. Wall time known subtotal 500 seconds with 10/12 observed, not campaign elapsed time.
- Superseded attempts cost $7.70 and 70 seconds. Unaccepted orphan accounting contributes another known $.90 with missing coverage. It contributes no behavior. Selected indeterminate work remains visible in all-attempt accounting.
- A failed artifact path, digest, or byte check invalidates all values sourced from that artifact; independently authenticated artifacts remain usable. A malformed optional role price or duration invalidates that field. A failed identity or manifest invalidates the bound publication as a whole. A cost-only orphan never acquires an accepted outcome.
- Cross-arm replacement, reused reserve, mixed predecessor/successor pairs, and a duplicate selected attempt are rejected by the shared fold before reporting.

Report JSON has a versioned deterministic fold, campaign/input identity, journal prefix digest/last sequence, and sorted artifact references/digests. Terminal completed reports may be sealed against that same anchor. Interrupted reports remain explicitly incomplete without requiring a completed seal. Render Markdown from JSON; formatting is not part of the measurement digest. Per-arm available counts and pair-specific counts accompany each quantity. All-attempt duration/cost, excluded cost, role breakdown, missingness, validity caveats and artifact links remain separate from conditional comparison summaries. Read frozen economics/usage from the existing runner artifacts; never reprice them against today's tables.

## Task 1: Integrate the actual source baseline

Completed in `14e13006`; integration review accepted the retained source histories. Baseline `bun run check` exited 1 with one intermittent CLI timeout, 3675 passing tests and 6 skips. Isolated reruns passed unchanged; the full portable gate remains required after implementation. Scenario validation and the separate dashboard check passed.

**Files:** Git integration in the fresh implementation worktree, then this plan's progress boxes. Preserve the untracked `docs/experiments/2026-09-04-campaign-consolidation-design-review.md` in the design worktree unchanged; do not copy it into implementation.

**Interfaces:** Produces a branch containing both exact source tips above and the approved design. No runtime behavior changes are part of this task.

- [x] Record `git status --short`, `git rev-parse HEAD`, gitdir/common-dir, and the design worktree note's SHA-256. Confirm the fresh current worktree is linked and the two pinned commits exist.
- [x] Merge the appliance source into this worktree; resolve only actual conflicts while retaining main's capability/credential fixes. If overlapping user edits appear, leave them untouched and report the concrete overlap.

```sh
git merge --no-ff 65c28448625d8446720f36c377890879dacd7f1d
bun install --frozen-lockfile
bun run check
bun run quorum check
```

- [x] Record baseline command exits. Existing failures are blockers to distinguish from new failures; do not silently delete their tests or claim a green baseline. Check no Docker/live command ran as a side effect.
- [x] Verify both tips are ancestors. Commit merge resolution with a detailed body explaining the two source lines and core-only scope; preserve hooks.

## Task 2: Define fixed experiment slots and the one-session fold

Completed through `16b03af4`; independent review and scoped fix review approved the records/fold. The final task receipt is 89 passing related tests, including 38 focused tests, plus typecheck and scoped Biome. Review fixes cover discovered container identities after create-before-bind and rejection of pass/fail without supporting artifacts.

**Files:** Create `src/contracts/campaign/experiment.ts`, `src/contracts/campaign/execution.ts`, `src/campaign/execution-state.ts`, `test/campaign-execution-state.test.ts`, `test/fixtures/core-comparison/factory.ts`. Modify shared leaf schemas only as needed; cut over V1 consumers in Task 9.

**Interfaces:** Produces `ExperimentSchema`, `CampaignTransitionSchema`, `CampaignProjection`, `initialProjection(experiment: Experiment): CampaignProjection`, and `foldTransition(state, transition): CampaignProjection`. Shared record shapes and exact transition table are above. Factory exports a valid two-arm experiment and deterministic transition builders using fixture timestamps/IDs.

- [x] Write behavior tests for sole start, atomic complete arm inventory, immutable outcomes, reserve/per-slot limits, and coherent selection. Include an already accepted predecessor whose successor has one indeterminate arm.

```ts
test('replacement preserves observations and the primary denominator', () => {
  const { experiment, transitions, primary, successor } = replacementFixture();
  const state = transitions.reduce(foldTransition, initialProjection(experiment));
  expect(experiment.planned_slots).toHaveLength(2);
  expect(state.attempts.get(primary.attempts[0].identity.execution_attempt_id)?.observation?.outcome).toBe('pass');
  expect(state.selected_blocks.get(primary.primary_block_id)).toBe(successor.block_id);
  expect(() => foldTransition(state, startTransition(experiment))).toThrow();
});
```

- [x] Run `bun test test/campaign-execution-state.test.ts`; expect missing exports, then implement the strict records and pure fold. Validate the entire proposed transition against a cloned projection before changing any maps; a thrown validation error leaves the input untouched.

```ts
export function foldTransition(state: CampaignProjection, transition: CampaignTransition): CampaignProjection {
  const next = cloneProjection(state);
  applyValidatedTransition(next, CampaignTransitionSchema.parse(transition));
  return next;
}
```

`cloneProjection` copies mutable maps/sets; `applyValidatedTransition` is a private exhaustive switch implementing the table, with no I/O. Neither is a second replay policy.
- [x] Run the focused tests including table-driven illegal predecessor/identity cases. Commit the domain contracts and fixture factory with their intent and finite-bound semantics.

## Task 3: Make journal transitions atomic and host ownership durable

Completed through `4d02be64`; independent task review and scoped fix review passed. The task reported 140 related tests, 69 additional configuration/ownership tests and 95 affected fix tests, with lint/typecheck/scenario validation passing at the recorded stages. Review fixes bind claim release to the complete durable start and reject writable aliases of the private authority file. Actual container/launch/mutation integration remains in Tasks 5–9.

**Files:** Modify `src/campaign/journal.ts`, `locks.ts`, `src/cli/run-command.ts`, `src/run-all/index.ts`; create `src/campaign/ownership.ts`, `test/campaign-transitions.test.ts`, `test/campaign-ownership.test.ts`; extend `test/campaign-lock-threading.test.ts`.

A separate `src/campaign/execution-journal.ts` may hold the V2 writer while unchanged V1 consumers retain `journal.ts` until Task 9 removes them. This is an intermediate source arrangement, never schema-based runtime compatibility. Extract shared durable-file primitives only to avoid duplication. A small pure experiment digest helper may move forward from Task 4 so the journal reader can authenticate its document without a document/journal import cycle. Exclude campaign ID, input digest, and registration actor/time; retain all other frozen fields, including supplied scheduling estimates.

**Interfaces:** Consume Task 2. Produce `commitTransition`, `readProjection(campaignDir): CampaignProjection`, `publishHostClaim(claim: HostCampaignClaim): void`, `readHostClaim(): HostCampaignClaim | null`, `clearHostClaim(receipt: TerminationReceipt): void`. `TerminationReceipt` contains experiment/start identity, the committed termination transition ID/digest and complete stopped inventory. Paths derive from the existing host lock root and campaign directory. `acquireLiveSpendLock` gains an explicit typed matching-start or cancellation authority; default callers can never bypass a claim.

- [x] Write SQLite fault-injection tests: fail before insert, in the middle of audit-row insertion, and immediately after commit; a reopened reader sees zero or all members. A duplicate ID with unequal bytes fails. A deposed writer cannot append, even with a previously validated projection. A single complete transition row exercises equivalent actual transaction boundaries.

```ts
test('a mid-group write failure publishes no admission', () => {
  const { writer, read, activation } = journalFixture({ failAfterRow: 1 });
  expect(() => writer.commitTransition(activation)).toThrow();
  expect(read().attempts.size).toBe(0);
});
```

- [x] Run `bun test test/campaign-transitions.test.ts test/campaign-ownership.test.ts`; expect missing atomic API/guard behavior. Implement `BEGIN IMMEDIATE`, fence validation, full transition validation, inserts, commit, then memory update; rollback/poison on uncertain commit as existing storage discipline requires.

```ts
const next = foldTransition(current, transition);
db.transaction(() => {
  assertWriterFence();
  insertCompleteTransition(transition);
})();
current = next;
```

- [x] Implement claim file exclusive publication and file/directory fsync using the existing journal filesystem primitives. Under the host lease, validate any claim before admitting any spender. PID reclamation cannot delete it; cancellation needs a matching durable termination receipt. Include the covered-child branch and canonical host lock root in this plumbing; test parent-release/child-acquire gaps, dead controller/live worker, unknown Docker state and forged child-marker paths.
- [x] Exercise ENOSPC using injected filesystem/SQLite failures and physically allocated reserve checks; durable emergency sidecar or unresolved guard is required. Do not simulate ENOSPC by filling Drew's disk.
- [x] Run these tests plus existing lock/publication tests whose contracts remain, and commit the journal/ownership deliverable.

## Task 4: Compile and register a finite, price-independent experiment

**Files:** Modify `src/contracts/campaign/suite.ts`, `digest.ts`, `src/campaign/registration.ts`, `campaign-document.ts`, `arm-suite-check.ts`; create `src/campaign/resource-policy.ts`, `test/campaign-resource-policy.test.ts`; extend registration/document/credential capability tests.

**Interfaces:** `compileResourcePolicy(registry: Readonly<Record<string, Credential>>, activeCredentialNames: readonly string[]): ReadonlyMap<string, PoolPolicy>` uses the existing registry shape and campaign `poolKey`: explicit `quota_pool`, otherwise endpoint/name plus API plus model. The distinct run-all `limiterKey` remains unchanged. `prepareRegistration` returns the V2 `Experiment` inputs; `registerCampaign` publishes a new independent campaign ID and initial transition; `loadFrozenCampaign` authenticates schema 2, input digest and journal anchor. Keep existing source resolver, snapshot preparation and exact eligibility checks.

- [x] Add tests for two identical registrations yielding distinct IDs/equal digests, no secret reads for configuration validation, unknown price allowed, missing finite bounds rejected, reserve not expanding primary slots, and aliases reordered without changing policy/admission feasibility.

```ts
test('shared grader and subject consume the same compiled pool', () => {
  const policy = compileResourcePolicy(registryWithSharedPool(2, 1), ['subject', 'grader']);
  expect([...policy.values()][0].max_concurrency).toBe(1);
  expect(() => assertFeasible(twoArmDemandIncludingGrader(), policy, 8)).toThrow();
});
```

Fixture helpers in this test build actual credential registry objects; `assertFeasible` is exported by `resource-policy.ts` and consumes `ReadonlyMap<string, number>` demand, the policy map, and global capacity. Reuse the existing complete demand calculation from dispatcher in this module so registration and dispatch call the same function.
- [x] Run `bun test test/campaign-resource-policy.test.ts test/campaign-registration.test.ts`. Implement minimum explicit concurrency and maximum declared spacing over **all registry aliases** for each active pool. Refuse an active pool with no explicit concurrency declaration; retain per-key constraints. Freeze optional scheduling estimates; missing estimates fall back to the frozen attempt deadline, with stable identity tie-breaking.

```ts
const limits = aliases.flatMap((c) => c.max_concurrency === undefined ? [] : [c.max_concurrency]);
if (limits.length === 0) throw new RegistrationError(`pool ${poolId} needs an explicit concurrency limit`);
const capacity = Math.min(...limits);
```

- [x] Pin the public credential authority/projection policy digest. Reject changes before new starts; supported bundle mutation paths check host ownership. Do not embed secret bytes in experiment, claim, logs or report.
- [x] Verify existing declared capabilities: Claude/Codex/Pi/Copilot ref and none; Kimi ref supported and none rejected. No adapter feature expansion. Commit registration and policy changes.

## Task 5: Bind containers before start and enforce the independent deadline

**Files:** Modify `src/campaign/container-spawner.ts`, `spawn.ts`, `attempt-projection.ts`, `attempt-publish.ts`, `src/agents/command-runner.ts`, `container/attempt-entrypoint.sh`, `container/Dockerfile`; extend `test/campaign-container-spawner.test.ts`, `test/campaign-attempt-projection.test.ts`, `test/campaign-attempt-publish.test.ts`, `test/linux/campaign-attempt-docker.test.ts`.

**Interfaces:** Implement `AttemptRuntime`, `PreparedExecution`, `BoundExecution`, `OwnedRuntimeObservation`, `AttemptMonitor` from the runtime section. Retain `containerNameForAttempt`, `buildAttemptMounts`, private stage and manifest publication. Existing `CommandOptions` gains optional positive `timeoutMs`; timeout throws a typed client-timeout error and forcibly terminates the client subprocess.

- [x] Write a fake-Docker behavior test that rejects start without committed binding, and a monitor-failure test where inspect is unknown: no publication or slot release occurs. Exercise partial create followed by cancellation discovery by exact specification.

```ts
test('a failed monitor cannot masquerade as a stopped worker', async () => {
  const f = runtimeFixture({ monitorFails: true, inspect: 'unknown' });
  await f.driveOneAttempt();
  expect(f.published).toHaveLength(0);
  expect(f.releasedSlots).toBe(0);
  expect(f.stopRequests).toHaveLength(1);
});
```

- [x] Run `bun test test/campaign-container-spawner.test.ts`; expect the combined spawn path to violate the new contract. Split create and start without replacing the surrounding runner. Return immutable ID only after full spec inspection. Before start, recheck journal binding, cancellation, writer fence and credential authority.

```ts
const bound = await runtime.create(prepared);
writer.commitTransition(runtimeBoundTransition(bound));
assertStartStillAuthorized();
const monitor = await runtime.start(bound);
```

`runtimeBoundTransition` creates the exact table row; `assertStartStillAuthorized` consults the current fold, intent, host claim and cancel sidecar. These are controller-local helpers, not exported authority bypasses.
- [x] Configure structured Docker args for init/timeout/restart and assert GNU timeout in the built image. Keep strict credential parsing and current hardening. Test actual runner termination behavior with fakes; do not assert a giant rendered shell string.
- [x] Add the Linux tests now: normal exit, TERM-handling timeout, forced timeout with `setsid`/TERM-ignoring descendant, killed controller, client timeout, create-before-bind, and delayed daemon start after a stopped snapshot. Run only portable tests at this stage. Commit; label Linux cases unrun until Task 10.

## Task 6: Gate controller launch and implement termination-only cancellation

**Files:** Modify `src/appliance/cli.ts`, `campaign-run.ts`, `process.ts`, `types.ts`; create `src/campaign/cancellation.ts`, `test/campaign-cancellation.test.ts`; extend `test/appliance-campaign-run.test.ts`, `test/appliance-process.test.ts`, `test/campaign-lock-threading.test.ts`.

**Interfaces:** `startCampaignOnce` consumes authenticated experiment and helper dependencies; returns `launched | already_running | refused` with shared status. `cancelCampaign` consumes the same identity plus stop/runtime probes and returns `terminated | unresolved`; it never imports dispatcher or replacement functions. `observeCampaignStatus` is read-only and implements the precedence above. Job records store invocation/controller/result only.

- [x] Add real child-process tests with a gated harmless worker: two racing invocations consume one start; pipe EOF, invalid gate message, startup timeout, or cancel-before-release produces no worker marker. Use temporary directories and fake runtime, no provider calls.

```ts
test('a consumed start survives launcher loss', async () => {
  const f = await launchFixture({ crashAfter: 'started' });
  await f.firstRun();
  expect((await f.secondRun()).kind).toBe('refused');
  expect(f.runtimeStartCount()).toBe(0);
  expect(f.hostClaim()).toBeNull();
});

test('a published claim survives loss before child creation', async () => {
  const f = await launchFixture({ crashAfter: 'claim_published' });
  await f.firstRun();
  expect((await f.secondRun()).kind).toBe('refused');
  expect(f.runtimeStartCount()).toBe(0);
  expect(f.hostClaim()).not.toBeNull();
});
```

- [x] Run focused tests; implement the pipe gate and ownership sequence exactly as above. Persist PID, birth and boot identity before release. A helper ACK without a gated child is not sufficient. Treat callback/pipe-write failures as consumed interrupted starts.
- [x] Implement cancellation from frozen intent inventory and runtime observations. Assert import boundaries behaviorally with a fake runtime that throws if cancellation calls create/start; cover all crash cuts, idempotent repeated cancel, controller-death-before-writer-takeover, and orphan accounting without accepted outcomes.

```ts
await publishCancelIntent(identity);
await stopAndVerifyLauncherAndController(identity);
const writer = electCancellationWriter(identity);
const stopped = await stopEveryPreparedAttempt(writer.readProjection());
await closeAccountingWithoutBehavior(writer, stopped);
commitTerminationAndClearMatchingClaim(writer, stopped);
```

These private functions are the steps inside `cancelCampaign`; each failure returns unresolved and retains the host claim. An ordinary cancel observed by the live controller may write cancelled; post-loss cancellation preserves interrupted. Never take the writer before verifying the previous controller dead.
- [x] Test refresh/helper replacement/bundle mutation refusal with unresolved ownership. Run portable helper, process, cancellation and lock tests; commit.

## Task 7: Connect existing dispatch algorithms to the atomic session

**Files:** Modify `src/campaign/dispatcher.ts`, `classifier.ts`, `contention.ts`, `key-select.ts`, `sensors.ts`; extend `test/campaign-dispatcher.test.ts`, `test/campaign-dispatcher-container.test.ts`, classifier/contention tests.

**Interfaces:** `runCampaignDispatch` consumes authenticated `Experiment`, `JournalWriter` with shared projection, compiled policy, `AttemptRuntime`, clock/sampler and cancellation signal. It returns a terminal/incomplete execution result. Remove `resumeAdmission` and `repairSnapshot`. Reuse `compareAdmissionOrder`, complete demand, pool spacing/latches, key selection, skew/contention evaluator and telemetry capture; policy is frozen, not rederived.

- [ ] Write a deterministic fake-runtime session with a two-arm block, instrument failure, one whole-block reserve replacement and another never-started primary after cancellation. Assert each new attempt consumes a number/reserve; behavioral failure creates no retry; no replacement starts before every predecessor is dead and terminal transition committed.

```ts
test('unknown price changes accounting, never admission', async () => {
  const priced = await dispatchFixture({ subjectPrice: 1, reserve: 0 });
  const unpriced = await dispatchFixture({ subjectPrice: null, reserve: 0 });
  expect(unpriced.startedIdentities).toEqual(priced.startedIdentities);
  expect(unpriced.selectedOutcomes).toEqual(priced.selectedOutcomes);
});
```

- [ ] Run the focused dispatch tests; replace local sample/reentry routing with reads from `writer.readProjection()`. Commit activation before effects; commit closure before release; commit replacement identity/selection/allowance in one transition.

```ts
const candidate = nextEligibleBlock(writer.readProjection(), frozenPolicy, clock.now());
if (candidate) {
  writer.commitTransition(activationFor(candidate));
  await executePreparedBlock(candidate);
}
```

Private helpers reuse the existing greedy admission order and demand evaluator. They must not reconstruct a dispatcher after restart. The controller's single mutation queue rechecks fence/cancel before effects and after await boundaries.
- [ ] Implement the qualified failure table, including permanent grader configuration/billing failure, invalid telemetry, uncertain death and ENOSPC. Preserve conservative outcomes for the subject producers Drew deferred. Remove dollar budget stops, amendments, in-flight dollar reservations and price gates from this path. Keep observed economics collection.
- [ ] Run fake-clock fairness/cap/spacing and fault-cut tests. Confirm no behavior changes in the run-all scheduler. Commit the connected session.

## Task 8: Publish the comparison and all-attempt accounting report

**Files:** Modify `src/campaign/report-evidence.ts`, `report.ts`, `seal.ts`, `src/contracts/campaign/report.ts`; create `test/fixtures/core-comparison/{campaign.json,transitions.json,evidence.json,expected-report.json}`; extend report/evidence tests.

**Interfaces:** `readAttemptEvidence({resultsRoot, expectedIdentity, artifacts}): AttemptEvidence`, where `AttemptEvidence` contains observed outcome, Gauntlet judgment, checks, wall duration, role usage/cost, versions and field missingness. `foldComparisonReport({experiment, state, evidenceByAttempt}): ComparisonReport` is pure. `publishReport` freezes the canonical anchor; `renderReportMd` consumes that same JSON. Cost/usage types come from existing captured economics and `TokenUsage`.

- [ ] Encode the worked fixture and literal expected numbers above. Include unaccepted orphan accounting, malformed field, absent price, changed identity and cross-block pairing tests. Do not derive expected values using the production aggregation functions.

```ts
test('cost pairs are matched per quantity', () => {
  const report = foldComparisonReport(mixedComparisonFixture());
  const c1 = report.comparisons.find((c) => c.comparison_id === 'c1')!;
  expect(c1.paired.subject_cost_usd).toEqual({ n: 1, baseline_mean: 1, treatment_mean: 2, mean_delta: 1 });
  expect(report.accounting.subject_cost_usd).toEqual({ known_subtotal: 136, observed: 9, attempts: 12, complete: false });
});
```

- [ ] Run report/evidence tests; change joins from sample-only to execution-attempt identity. Validate each artifact before reading existing verdict/economics fields. A valid role subtotal survives another missing role, while corrupt identity invalidates the artifact. No read from raw transcripts or current pricing tables.

```ts
const pairs = selectedCoherentDeterminatePairs(experiment, state, evidenceByAttempt);
const matched = pairs.filter((p) => present(p.baseline.subject_cost_usd) && present(p.treatment.subject_cost_usd));
const costSummary = summarizeMatchedPairs(matched, (a) => a.subject_cost_usd);
```

Private report helpers implement complete-pair selection, observed-value narrowing and arithmetic means; empty cohorts yield explicit missing summary with `n: 0`, never zero-valued averages. Account across all execution attempts separately.
- [ ] Render the fixture JSON and Markdown, manually inspect counts/units/coverage/reasons/links, and independently calculate the golden totals. Permit interrupted prefix-bound reports; active status remains behavior-blind. Commit report and fixtures.

## Task 9: Complete the helper journey and remove retired runtime paths

**Files:** Modify `src/cli/campaign.ts`, `src/appliance/cli.ts`, `docs/appliance-runbook.md`, `README.md`, `AGENTS.md` architecture section; create `docs/campaign-comparisons.md`, `examples/campaigns/{pr-base,harnesses,skill-stock,models}/`; remove retired responsibilities listed in the file map and unused V1-only tests/fixtures only after porting their retained contracts. Do not touch landed campaign/results artifacts.

**Interfaces:** Helper verbs `campaign register|list|status|run|cancel|costs|report` share the same loader/fold/evidence projection. Raw internal campaign entry points reject continuation and cannot select the old process backend. New configuration validation accepts only V2 suite format; historical schemas/artifacts fail with a clear unsupported-version error.

- [ ] Add command-level tests using a prepared fixture appliance and fake runtime: configure -> register -> run -> status/costs -> report; second campaign -> killed controller -> cancel -> incomplete report -> fresh identity. Assert job receipts cannot override journal/worker status.

```ts
test('a changed comparison needs configuration only', async () => {
  const f = await helperFixture();
  const registration = await f.registerExample('models', { treatmentModel: 'fixture-model-b' });
  expect(registration.planned_slots).toHaveLength(2);
  await f.runToCompletion(registration.campaign_id);
  expect((await f.report(registration.campaign_id)).comparisons).toHaveLength(1);
});
```

- [ ] Provide checked examples for PR/base refs (same supported agent/model), Claude/Codex harnesses (compatible credential), skill ref/none (supported adapter), and two model credentials (same adapter). Explain exact prerequisites and adapter support, finite work limits, fresh-run identity, costs/coverage and no continuation. Use local fake fixtures for tests; no invented working remote refs or account setup.
- [ ] Cut every active caller to the new contracts; remove the V1 dollar-control, recovery/adoption, replay-dispatch, partial-prefix repair, gating/profile and duplicate job-authority paths. Preserve shared runner identity, Phase 0 corpus/estimates/simulation tooling and direct development execution. Move no historical artifact and add no compatibility parser.
- [ ] Run import/text searches for retired execution terms, then inspect each remaining hit by responsibility. Historical docs, archived evidence and rejection tests may mention them; production V2 must not execute them. Replace tests of removed behavior with rejection tests, not broad test deletion to obtain green output.
- [ ] Run `bun run check` and `bun run quorum check`. Resolve relevant failures and perform a real platform-appropriate local smoke using fake commands/credentials only. Commit the complete operator path with removal ledger and verification receipts.

## Task 10: Verify the real boundary and record operational limits

**Files:** Existing `test/linux/campaign-attempt-docker.test.ts`, `test/linux/fixtures/`, and dated experiment evidence in `docs/experiments/2026-09-04-core-comparison-validation.md`.

**Interfaces:** No new feature. Produces separate receipts for portable contracts, Linux container boundary and installed appliance path.

- [ ] Perform one narrow staff review of the final implementation against single launch, termination cuts, fixed denominators, matched comparison quantities and removed responsibilities. Fix concrete findings and rerun only affected checks before final full portable gates.
- [ ] Record portable check results and exact integrated commit. Keep existing Linux fake runtime/provider fixtures. Test real runner setup/drive/capture in a Linux container with local fake provider; verify whole namespace death after killed controller, including daemonized signal-ignoring worker, and ownership retention on unknown runtime responses.

```sh
bun test test/linux/campaign-attempt-docker.test.ts
```

This command belongs on the explicitly selected Linux environment with Docker access and the pinned test image. Do not silently run it through Docker Desktop or switch to a remote host. If that environment is not authorized/available, mark Linux proof pending and present the concrete command/image/expected checks for Drew's final operational approval after local work is reviewable.
- [ ] On the prepared appliance, time one maintainer's changed supported question from blank editor to accepted registration; target under 30 minutes, record setup time separately. A unit-test fixture is not that usability measurement.
- [ ] Only after separate operational authorization, run a small installed comparison and record artifact/report identities, role cost coverage, elapsed time and failures. Do not use a paid run to compensate for missing local fault tests. Do not drain/retire V1 or migrate artifacts as part of the coding task.
- [ ] Final readout states what is implemented, which checks ran, what remains unverified, and the surviving responsibilities. Never claim eight-hour workload readiness from simulation or the old sentinel run.

## Plan self-review and progress

| Spec obligation | Tasks |
|---|---|
| One authority, one launch, read-only status | 2, 3, 6, 9 |
| Fixed paths, exact credential authority, immutable ownership | 3, 4, 5, 6 |
| Atomic admission/replacement/observation, writer fencing | 2, 3, 7 |
| Independent whole-attempt deadline and namespace death | 5, 10 |
| No resume, safe abort-only cancellation, ENOSPC | 3, 6, 7 |
| Finite work, invariant resource policy, cost independence | 2, 4, 7 |
| Fixed denominators, coherent pairs, all-attempt accounting | 2, 8 |
| Four examples and one helper journey | 4, 9, 10 |
| Preservation, removal, platform development workflows | 1, 9 |
| Honest distinction between portable/Linux/installed proof | 10 |

- [x] Root self-review: every spec obligation mapped; corrected the credential registry and command-options signatures against source; verified existing task paths; scanned for unresolved placeholders. Test-local fixture helpers are specified by their scenario rather than production APIs.
- [x] Narrow execution review: addressed the five ownership/accounting/validity findings and the scoped re-review's late-invalidation and launch-cut corrections. Uncertain daemon starts retain ownership until conclusive settlement; no stop snapshot or elapsed-time inference clears it. The report oracle's fixed denominators and literal arithmetic were independently checked.
- [ ] Execute Tasks 1-9 locally with task-scoped review and focused tests; Task 10's environment-dependent proof remains separately identified.

Task 4 checkpoint: finite registration and shared resource policy are complete at `edd5e979`. Independent task review and scoped fix review pass after rejecting non-Linux targets, requiring exact grader/credential model identity through one strict parser, and refusing the reserved global pool identity. The final focused receipt is 245 passing tests, with lint, typecheck and scenario validation passing. Runtime consumers and removal of temporary budgeted source APIs remain Tasks 5–9.

Task 5 checkpoint: runtime creation, binding, start, independent deadline, strict credential projection and immutable publication are complete at `94000530`, with independent spec/quality approval and scoped confirmation of the subscriber-isolation fix. The main focused receipt is 215 passing tests; the fix receipt is 39 passing covering tests. Lint and typecheck pass. Seven Linux runtime cases remain explicitly unrun, and full real entrypoint/runner/authority integration remains an environment-dependent gate.

The reviewed runtime has required create/start authority callbacks and a separate start-settlement callback. A durably unbound intent cannot have issued a permitted start; a bound intent without a durable successful start receipt remains uncertain after controller loss. Image defaults are authenticated by immutable image ID before comparison of the full actual runtime inventory. The spec requires `credential_projection: { path, sha256 }` for the private read-only registry derived from the frozen subject credential and selected key grant; this preserves key-pool selection through existing runner auth. Both attempt credential deliveries use strict literal records, with the shared Phase 1 serializer unchanged. Tasks 6/7 own production callback wiring and controller error handling; Task 9 removes the temporary budgeted spawner.

Task 6 checkpoint: the one-session helper lifecycle, termination-only cancellation, truthful status and supported mutation guards are complete at `db4668eb`. Independent task review found the late controller-binding race and unknown-as-loss bug; the scoped fix review passes those corrections plus the root-identified healthy-handoff status correction. The initial affected receipt is 265 passing tests; the final fix receipt is 65 passing affected tests, with lint and typecheck passing. Real harmless processes exercise gate/launcher behavior; actual Linux container and installed appliance proof remain unrun.

The internal controller target is required and local, with no old-controller default. `CampaignControllerContext` supplies authenticated experiment/start/claim/process identity, resolved results root, held run/live/journal handles, and `assertAdmission()`. `ExecutionJournalWriter.assertCurrentOwner()` checks the current lease and SQLite generation; a cached projection alone is not authority. A durable launcher-role release receipt is published only after parent leases are released and binding/admission is permanently relinquished, before gate delivery. It proves role quiescence, not launcher OS death. Cancellation settles the final controller binding after launcher quiescence and checks that identity against the elected writer before certifying termination.

Normal completion calls `completeControllerTermination` with the current controller's held handles, immutable ended state, complete stopped inventory, and the runtime's required `assertNoUnsettledStarts` assertion. A timed-out or rejected client call never erases daemon-start uncertainty. Claim release follows durable termination; no further admission is permitted. Read-only status treats a matching known-live bound child as running during the legitimate lease handoff without claiming an attempt is already admitted. Unknown identity never becomes established controller loss.

Attempt artifact references are `<runId>/<file>` relative to the configured shared `resultsRoot`, including the manifest. Control/process evidence references remain relative to `campaignDir`. The helper resolves and passes the shared root through controller, cancellation and report readers; it does not create campaign-local results or move old artifacts. Publication retains ENOSPC causes so cancellation stops the full inventory and records emergency evidence instead of reporting ordinary missing output.

Report integration must also preserve partially priced role subtotals: existing captured usage can carry known cost with unpriced models. Keep that known spend in all-attempt accounting with incomplete coverage; it cannot participate as a complete role total in matched cost comparisons. This reads frozen values and flags, without repricing.
