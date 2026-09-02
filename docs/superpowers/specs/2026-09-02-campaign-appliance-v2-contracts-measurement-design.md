# Campaign Appliance V2 Child 1 — Contracts and Measurement Design

**Date:** 2026-09-02

**Status:** draft for Drew's review

**Parent:** `docs/superpowers/specs/2026-09-02-campaign-appliance-v2-design.md`
at `c91c0a6`

**Delivery order:** child 1 of 5

## Decision

Campaign Appliance V2 replaces the existing campaign contracts in place. It
does not add a parallel V2 namespace, retain a V1 reader, or create a migration
layer.

This child defines and tests the complete durable grammar that later children
consume:

- V2 suite, campaign, report, status, and cost schemas;
- the closed journal vocabulary;
- one pure, executable journal fold with explicit campaign, block, sample, and
  attempt transitions;
- a reusable durable-prefix corpus for recovery compatibility;
- deterministic status and allowed-action projection; and
- read-only cost normalization and aggregation across every attempt outcome.

It also removes dollar-budget authority from the current campaign engine. Cost
remains observable, attributable, and reportable, but no cost or price value may
affect admission, replacement, continuation, cancellation, or sealing.

No live campaign is run or deployed from this intermediate child. The current
host-direct executor remains an implementation seam until child 3 replaces it
with one fresh container per attempt. Child 5 is the first production delivery.

## Why an in-place cutover

No V1 campaign has been run, so there is no durable V1 authority to preserve.
The only V1 material is source code, tests, suite definitions, and historical
design and experiment documentation.

A parallel `campaign-v2` tree would preserve two schemas, two folds, and two
sets of invariants through four more children. It would require a later
conversion or deletion pass and make it easy for new code to import the wrong
generation. A separate contracts package would add another module boundary
without another consumer.

The existing `src/contracts/campaign/` directory therefore becomes V2. Every
V2 loader rejects V1 before doing work. Historical specifications and
experiment logs remain unchanged because they describe what actually existed;
they are not runtime inputs.

## Scope

### In scope

1. Replace the active suite and campaign document schemas with strict V2-only
   schemas.
2. Replace the active report schema with a strict descriptive-only V2 schema.
3. Replace the V1 journal event union and projection state machines with the
   closed V2 event union and one executable fold.
4. Replace `crash-windows.ts` with a durable-prefix contract and corpus.
5. Add strict status and cost contracts plus pure projectors.
6. Upgrade the SQLite journal to schema version 2 with no V1 open or migration
   path.
7. Remove all budget fields, events, projections, amendments, admission gates,
   recovery rules, report counters, CLI inputs, and tests.
8. Separate schedule-affecting duration estimates from optional,
   non-authoritative cost forecasts.
9. Convert active exploratory suite definitions to V2 and move the obsolete
   D4a gating qualification suite into a V1 test fixture.
10. Fail closed at the incomplete production-registration boundary instead of
    manufacturing snapshot, archive, image, or credential-generation values.
11. Keep all repository checks green without making any provider request.

### Non-goals

- Durable namespace and artifact publication changes; child 2 owns them.
- Docker worker creation, container identity, credential generations,
  credential staging, process teardown, or real Gauntlet topology; child 3 owns
  them.
- `evals-appliance campaign` jobs, selectors, controller lifecycle, locks,
  cancellation implementation, or Linux integration; child 4 owns them.
- Terminus paths, mounts, refresh, backups, deployment, rollback, or live
  qualification; child 5 owns them.
- A release decision, gating profile, `SHIP`, or `NO_SHIP` result.
- V1 parsing, conversion, migration, restamping, or compatibility aliases.
- New provider-specific price collection. This child normalizes the evidence
  the runner already produces.
- Cost forecasts as a requirement. Registration remains valid without them.
- Changing ordinary non-campaign `quorum run`, `run-all`, or dashboard cost
  behavior.

## Architectural boundaries

The child has four layers:

```text
strict V2 documents and event schemas
                  |
                  v
       pure journal fold ----------> durable-prefix corpus
          |                 |
          v                 v
  pure status projector   pure cost projector
          |                 |
          +--------+--------+
                   v
        report and operator read models
```

Schemas validate shape and local invariants. The fold alone decides whether an
event sequence is legal and reconstructs durable state. Status combines that
durable state with typed runtime observations, without mutation. Cost combines
durable identities with immutable run evidence, without feeding any value back
into execution.

Storage, Docker, credential material, and CLI rendering remain outside these
pure modules. Later children adapt their real observations to the contracts
defined here.

## Version intake and V1 refusal

Every public V2 document begins with `schema_version: 2`. Loaders first read
only that discriminator from unknown input and then dispatch to the V2 schema.
They do not parse through a V1/V2 union.

The shared refusal is:

```ts
type UnsupportedCampaignVersion = {
  code: 'unsupported_campaign_version';
  artifact: 'suite' | 'campaign' | 'journal' | 'report' | 'cost';
  observed_version: number | null;
  supported_version: 2;
};
```

Missing, non-integer, V1, and future versions fail before registration,
journal replay, reporting, or cost aggregation. An existing SQLite journal is
opened read-only far enough to inspect `meta.schema_version`; any value other
than `2` is refused before a persistent pragma, schema write, or projection
rebuild.

There is no `Legacy` schema arm, normalizer, default, compatibility export, or
copy-forward command. Tests may retain literal V1 objects only to prove loud
rejection.

## Suite contract

`SuiteSchema` remains in `src/contracts/campaign/suite.ts` and has this V2
shape:

```ts
interface SuiteV2 {
  schema_version: 2;
  name: string;
  kind: 'exploratory';
  profile: 'descriptive_v1';
  grader: { credential: string };
  reserve?: number;
  max_exposure_skew?: number;
  attempt_bounds?: {
    max_time_s?: number;
    max_attempts?: number;
  };
  declared_metrics?: Array<{
    name: string;
    unit: string;
    aggregation: string;
  }>;
  profile_params?: Record<string, unknown>;
  comparisons: Comparison[];
}
```

The existing one-arm and two-arm comparison shapes remain. Names and generated
ID components retain their current restricted grammars. Counts and durations
must be finite and positive; reserve is a non-negative integer. Referential
validation continues to happen against arm, scenario, credential, and profile
registries.

The grader model is not duplicated in the suite. Registration resolves it from
the named credential and freezes the resolved public delivery descriptor in
the campaign document. A mismatch cannot therefore hide behind two operator
fields.

The following V1 fields are rejected as unknown keys:

- `budget_usd`;
- `kind: gating`;
- `profile: release_gate_v1`; and
- any release-gate-only profile parameter.

## Campaign contract

`CampaignSchema` remains in `src/contracts/campaign/campaign.ts`. The top-level
shape is:

```ts
interface CampaignV2 {
  schema_version: 2;
  campaign_id: string;
  input_digest: string;
  suite: SuiteV2;
  refs: FrozenRefs;
  cells: CellV2[];
  excluded_cells: ExcludedCell[];
  samples: Sample[];
  comparisons: CampaignComparison[];
  blocks: Block[];
  contention: ContentionDeclaration;
  runtime: FrozenRuntime;
  execution_surface: {
    subjects: SubjectExecutionDescriptor[];
    grader: GraderExecutionDescriptor;
  };
  policies: {
    failure_classification: PolicyRef<'failure_classification_v2'>;
    contention: PolicyRef<'contention_v1'>;
    report_fold: PolicyRef<'descriptive_v1'>;
    cost_aggregation: CostPolicyRef;
  };
  registration: {
    registered_at: string;
    registered_by: string;
    label?: string;
    cost_forecast?: RegistrationCostForecast;
  };
}
```

The referenced shapes are fixed in child 1 even though children 2 and 3 produce
their real values:

```ts
interface FrozenTreeRef {
  commit_sha: string;
  tree_manifest_sha256: string;
  archive_sha256: string;
}

interface FrozenRefs {
  evals: FrozenTreeRef;
  gauntlet: FrozenTreeRef;
  superpowers_by_arm: Record<string, FrozenTreeRef | null>;
}

interface FrozenRuntime {
  worker_image_digest: string;
  hardening_profile: 'attempt_worker_v1';
  toolchain_manifest_sha256: string;
  dependency_manifest_sha256: string;
}

interface PolicyRef<V extends string> {
  version: V;
  implementation_sha256: string;
}

interface CostPolicyRef extends PolicyRef<'observed_cost_v1'> {
  pricing_table_sha256: string;
  pricing_as_of: string;
}

interface RegistrationCostForecast {
  source_sha256: string;
  generated_at: string;
  known_usd_subtotal: number;
  unknown_cell_count: number;
}
```

Commit SHAs are full lowercase 40-hex values. Manifest, archive, policy, and
toolchain digests are lowercase 64-hex values. The worker image is a canonical
OCI `sha256:<64-hex>` digest. A Superpowers value is `null` only for an arm
whose frozen configuration declares no Superpowers installation.
Registration timestamps and pricing dates are strict UTC RFC 3339 strings.
Forecast subtotals are finite and non-negative; unknown-cell counts are
non-negative integers.

Later children materialize and verify these objects; they do not add contract
keys. Any future durable field outside the additive evidence referenced by the
existing digest-bearing slots requires V3.

Each execution descriptor is secret-free and contains:

```ts
interface PublicExecutionDescriptor {
  credential: string;
  auth: 'api-key' | 'bedrock-bearer';
  api: CredentialApi;
  endpoint?: string;
  registered_model: string;
  destination_env_names: string[];
}

interface SubjectExecutionDescriptor extends PublicExecutionDescriptor {
  role: 'subject';
  arm: string;
  agent: string;
}

interface GraderExecutionDescriptor extends PublicExecutionDescriptor {
  role: 'grader';
}
```

There is exactly one subject descriptor for every distinct registered arm and
exactly one grader descriptor. No descriptor contains a secret value, source
environment name, home path, OAuth material, or subscription identity.

Campaign referential validation retains and tightens the existing invariants:

- IDs are unique and grammar-valid.
- Every sample belongs to exactly one block.
- Every block belongs to one comparison and has exactly one sample per arm.
- Primary and reserve ordinals do not overlap.
- Every cell, sample, block, execution descriptor, and ref names a registered
  comparison or arm.
- One-arm comparisons contain one arm; two-arm comparisons contain two
  distinct arms.
- Every credential auth kind is one of the two supported environment-backed
  kinds.

There is no `budget`, `pricing_overrides`, or authorization-oriented price
field.

### Scheduling estimates and cost forecasts

The current `estimates_by_arm` object mixes duration, which affects dispatch
priority, with cost, which V2 forbids from affecting dispatch. V2 separates
them:

```ts
interface CellV2 {
  scenario: string;
  comparison_id: string;
  arms: string[];
  n: number;
  class: CellClass;
  coupling: CouplingClass;
  schedule_duration_by_arm: Record<
    string,
    {
      duration_s: number;
      basis: 'estimate' | 'registered_default';
      confidence: 'high' | 'medium' | 'low';
    }
  >;
}
```

`schedule_duration_by_arm` is always materialized: registration uses supplied
duration evidence when present and otherwise records the one frozen default.
It is included in `input_digest` because it can change dispatch order. A
registration cost forecast is optional metadata under
`registration.cost_forecast`; it is excluded from `input_digest`, never read by
the dispatcher, and never compared with measured cost. Its shape is a source
artifact digest, a known USD subtotal, an unknown-cell count, and the source's
generation timestamp. Child 1 does not support manual price overrides.
Unpriced observations remain explicitly unknown.

## Input digest

`src/contracts/campaign/digest.ts` continues to provide JCS canonicalization
and SHA-256. It replaces `digest` with `input_digest`.

The digest includes every value that can change execution, sample composition,
or interpretation:

- suite, expanded comparisons, cells, samples, and blocks;
- duration estimates;
- frozen refs and execution descriptors;
- contention declaration and global cap;
- complete policy references; and
- frozen scenario, agent, credential-public-surface, and tool identities
  carried by the already-defined refs, execution descriptors, runtime, and
  digest-bearing manifests.

It excludes:

- `campaign_id`;
- registration timestamp, operator, and label;
- optional cost forecast;
- observed costs and runtime state; and
- the digest field itself.

The digest input is one exported, typed projection. Registration and tests do
not independently reconstruct it.

`input_digest` identifies behavior, not every byte of `campaign.json`.
Registration separately hashes the complete canonical campaign document and
records that SHA in both `campaign_opened` and the immutable registration job.
That full-document SHA authenticates labels and optional forecasts without
making them part of experiment identity. It is not stored inside the document
it hashes.

## Journal envelope and storage version

The SQLite journal remains append-only and authoritative. Its storage schema
version becomes `2`. Every event keeps the strict envelope:

```ts
interface JournalEventEnvelope<T extends JournalEventType, P> {
  seq: number;
  ts_ms: number;
  type: T;
  payload: P;
}
```

Sequence numbers begin at one and are contiguous. Payloads are JCS-canonical
JSON. Unknown envelope keys, unknown event types, malformed payloads, sequence
gaps, duplicate single-assignment identities, and impossible transitions are
corruption.

The `events` table is the source of truth. Materialized tables are rebuildable
projections only. V2 removes the `spend` and `amendments` tables. It retains or
adds projections for blocks, rosters, attempts, pools, adjudications,
quarantine, credential pin, and terminal campaign authority. Rebuilding them
must reproduce the same canonical projection as incremental append.

## Closed journal vocabulary

The V2 union contains exactly these events. There is no generic event.

| Event | Required payload and purpose |
|---|---|
| `campaign_opened` | `campaign_id`, `input_digest`, and full canonical campaign-document SHA; sole first event |
| `credential_generation_pinned` | generation ID and public manifest digest; assigned once before admission |
| `block_admitted` | block ID, pool keys, optional rerun predecessor |
| `attempt_created` | campaign/comparison/block/sample/arm IDs, execution-attempt ID, run ID, deterministic container name, credential-stage ID, image digest, container-spec digest, input-manifest digest |
| `run_allocated` | execution-attempt ID, run ID, immutable container ID, image digest, host boot ID, creation time, subject/grader credential names, credential-generation ID and manifest digest, mount/input manifest digest |
| `exposure_started` | execution-attempt ID, sample ID, subject provider-request timestamp |
| `run_completed` | execution-attempt ID, outcome `pass | fail | indeterminate`, result-manifest reference, and a complete subject/grader cost closure |
| `instrument_failure` | execution-attempt ID, closed instrument cause, evidence-manifest reference, and a complete subject/grader cost closure |
| `aborted` | block ID, closed reason, and an evidence manifest plus complete role-cost closure for every not-yet-terminal created attempt in the block; closes live attempts only after their workers are verified stopped or absent, retains an already-terminal sibling's earlier closure, and leaves the frozen samples eligible for policy-governed re-entry |
| `block_replaced` | predecessor/successor block IDs, closed reason, `replacement | rerun`, reserve-activation flag, and complete same-arm roster |
| `sample_disposition` | sample ID plus `included` or `excluded_block_replaced`; the latter requires `superseded_by` |
| `slot_exhausted` | sample ID and closed exhaustion cause |
| `skew_excluded` | block ID and measured exposure facts |
| `pool_blocked` | pool key, unblock timestamp, and closed provider/rate-limit cause |
| `adjudication` | typed scope, closed disposition, and rationale |
| `quarantined` | run ID, execution-attempt ID, closed mismatch reason, evidence-manifest reference, and complete role-cost closure |
| `storage_paused` | pause evidence reference and affected execution-attempt IDs |
| `storage_resumed` | pause sequence and successful storage-check evidence reference |
| `cancel_requested` | requesting job ID and optional operator reason |
| `campaign_cancelled` | cancellation job ID, execution-safety evidence reference, and optional reason |
| `campaign_abandoned` | abandonment job ID, execution-safety evidence reference, required reason, and incomplete-evidence acknowledgement |
| `sealed` | canonical report digest |

`ArtifactRef` and `CostRecordRef` are strict, relative, secret-free references:

```ts
interface ArtifactRef {
  relative_path: string;
  sha256: string;
}

interface CostRecordRef extends ArtifactRef {
  record_id: string;
  role: 'subject' | 'grader';
}

type RoleCostClosure =
  | { state: 'recorded'; record: CostRecordRef }
  | { state: 'not_incurred'; evidence: ArtifactRef };

interface AttemptCostClosure {
  subject: RoleCostClosure;
  grader: RoleCostClosure;
}
```

Child 2 defines how those paths are durably committed. Child 1 validates that
they are relative, normalized, contain no `..`, and use lowercase SHA-256.
`recorded` may reference a known or explicitly unknown canonical record.
`not_incurred` requires evidence that the role could not have made a provider
request; absence of an artifact is not that evidence. Every terminal attempt
event, including abort and quarantine, carries both role closures, so a crash
cannot make a possible cost vanish by omitting a reference. V2 always knows the
host-allocated attempt behind a quarantined worker; claimed worker identity may
be rejected, but the cost stays attributed to the host authority that launched
it.

The adjudication dispositions are closed to:

- `reserve_exhausted`;
- `replacement_unavailable`;
- `contention_invalidated`;
- `unknown_coverage`;
- `integrity_finding`;
- `integrity_caveat`; and
- `snapshot_drift_refused`.

Its scope is exactly one of `{kind: 'campaign'}`, `{kind: 'cell', cell_id}`, or
`{kind: 'block', block_id}`. The fold validates every scoped ID against the
frozen campaign universe. Abort reasons are closed to
`controller_interrupted`, `cancel_requested`, `storage_paused`, and
`partial_block_failure`. Slot exhaustion causes are `max_attempts`,
`max_time`, and `reserve_exhausted`. Pool-block causes are
`subject_rate_limited`, `grader_rate_limited`, and `provider_backoff`.
Quarantine reasons remain `attempt_mismatch`, `late_terminal`, and
`campaign_mismatch`.

V1 cost-accounting dispositions `unpriced_terminal`, `spend_recovered`, and
`ballast_spent` do not survive. Unknown cost is a measurement result, not an
execution or integrity disposition. Storage reserve use belongs in the storage
pause evidence.

The V1 event types `budget_stopped`, `budget_event`, and `amendment` are absent
and rejected as unknown.

## Executable journal fold

`src/contracts/campaign/state-machine.ts` becomes the sole pure reducer for
incremental append and full replay. The SQLite writer calls it before updating
projections; replay calls the same function over the event stream. There is no
second switch statement that independently encodes legal order.

The fold returns:

```ts
interface CampaignFold {
  authority: CampaignAuthorityState;
  credential_generation: CredentialGenerationPin | null;
  blocks: ReadonlyMap<string, BlockState>;
  samples: ReadonlyMap<string, SampleState>;
  sample_dispositions: ReadonlyMap<string, SampleDisposition>;
  attempts: ReadonlyMap<string, AttemptState>;
  replacement_edges: ReadonlyMap<string, ReplacementEdge>;
  pools: ReadonlyMap<string, PoolState>;
  adjudications: readonly Adjudication[];
  quarantine: ReadonlyMap<string, QuarantineRecord>;
  report_digest: string | null;
  cost_record_refs: ReadonlyMap<string, CostRecordRef>;
  last_seq: number;
}
```

The state vocabularies are:

```text
campaign authority:
  opened | pinned | active | storage_paused | cancel_requested |
  sealed | cancelled | abandoned

block:
  planned | admitted | aborted | replaced | exhausted | closed

sample:
  planned | admitted | allocated | exposed | completed |
  instrument_failed | aborted | skew_excluded |
  excluded_block_replaced | exhausted

attempt:
  created | allocated | exposed | completed |
  instrument_failed | aborted | quarantined
```

`allocated` deliberately replaces the V1 name `spawned`: `run_allocated`
binds a stopped container before `docker start`, so the journal cannot claim a
process has spawned.

### Campaign transitions

| Current | Event | Next or result |
|---|---|---|
| empty | `campaign_opened` | `opened` |
| `opened` | `credential_generation_pinned` | `pinned` |
| `pinned` or `active` | `block_admitted` | `active` |
| `pinned` or `active` | `storage_paused` | `storage_paused` |
| `storage_paused` | `storage_resumed` | `active` when any block was admitted, otherwise `pinned` |
| any nonterminal state without cancel intent | `cancel_requested` | `cancel_requested` |
| `cancel_requested` | `campaign_cancelled` | `cancelled` |
| any authenticated nonterminal, nonsealed state | `campaign_abandoned` | `abandoned` |
| `pinned` or `active` with the complete seal predicate | `sealed` | `sealed` |

Activity events that do not change campaign authority are legal only under
their block/sample/attempt predicates. `storage_paused` prohibits new
admission. `cancel_requested` prohibits every event except evidence closure,
abort/disposition events needed for safe cancellation, quarantine, and
`campaign_cancelled`. Terminal authority admits no later event.

### Attempt and sample transitions

The complete transition table is represented as data and statically exhaustive
over `JournalEventType`. Its semantic rules are:

- `attempt_created` requires an admitted sample and creates one fresh attempt.
- `run_allocated` requires that exact created attempt and matching immutable
  IDs; it moves the attempt and sample to `allocated`.
- `exposure_started` requires the exact allocated attempt and moves it and its
  sample to `exposed`.
- `run_completed` closes an allocated attempt only with the explicit
  exploratory no-exposure caveat, otherwise it requires `exposed`. It moves the
  sample to `completed`. Its complete role-cost closure must match the
  attempt's identities.
- `instrument_failure` closes an allocated or exposed attempt and moves the
  sample to `instrument_failed`; a pre-container failure may also close a
  `created` attempt when both role closures prove `not_incurred`. It has the
  same complete role-cost-closure requirement.
- `aborted` applies to every nonterminal attempt/sample in the block. Already
  terminal sibling evidence is retained as a legal late no-op. Its per-attempt
  closure accounts for every not-yet-terminal created attempt before the block
  changes state; earlier terminal events remain the authority for terminal
  siblings. Aborted samples may re-enter only through a frozen-policy rerun or
  replacement.
- `sample_disposition: included` requires completed evidence and is a
  non-mutating final inclusion bind. The fold closes the block when every
  member has a final disposition.
- `block_admitted` with `rerun_of` re-enters only the predecessor roster's
  `aborted`, `instrument_failed`, or completed-but-not-included samples. A
  replacement instead activates fresh registered reserve samples and records
  the complete same-arm predecessor edge.
- `block_replaced` closes the predecessor block, records each successor edge,
  and makes either the frozen reserve block or policy-authorized rerun instance
  eligible for a separate `block_admitted` event. It cannot itself admit work
  or change an earlier sample disposition.
- `excluded_block_replaced`, `skew_excluded`, and `slot_exhausted` have their
  existing closed sources and become final experimental dispositions.
- A late terminal for an already excluded sample is retained and returns
  `ignore-late`; it cannot change the disposition.
- A second identity assignment, different terminal for a closed attempt,
  missing predecessor, cross-block reference, or impossible source state is
  rejected.
- `quarantined` closes its host-authoritative attempt and cost closure without
  trusting the worker's mismatched campaign/run claims or making its result
  eligible for experimental inclusion.

The fold result distinguishes execution completion from experimental
disposition. Sealing does not rely on a flat list of terminal sample states. It
requires every primary sample lineage to end in one included sample or an
explicit terminal exclusion/exhaustion justified by the frozen policy, with no
unresolved live attempt or replacement obligation.

## Durable-prefix corpus

`src/contracts/campaign/durable-prefixes.ts` replaces
`src/contracts/campaign/crash-windows.ts`. It exports typed cases, not a
test-only prose list:

```ts
interface DurablePrefixCase {
  name: string;
  campaign: CampaignV2;
  events: JournalEvent[];
  observations: StatusObservations;
  expected: {
    fold: CanonicalFoldSnapshot;
    status: CampaignStatus;
    appendable_events: JournalEventType[];
  };
}
```

The initial corpus covers every event immediately before and after append and,
at minimum, the parent crash cuts:

- incomplete registration before `campaign.json`;
- pin before first admission;
- attempt creation before Docker create;
- Docker create before allocation binding;
- allocation binding before start;
- start before exposure evidence;
- exposure before terminal evidence;
- result publication before terminal append;
- stopped worker before credential-stage deletion;
- storage pause and resume;
- cancel marker before terminal cancellation;
- sealed event before one report peer; and
- cleanup plan before and during apply.

Child 1 supplies abstract observations for Docker, files, and processes. Later
children add real integration fixtures without changing expected fold or status
results. The installed controller must run this corpus as part of its test gate;
the corpus is the V2 compatibility contract, not a migration framework.

## Status contract

`src/contracts/campaign/status.ts` defines a strict read model and one pure
`projectCampaignStatus` function. It consumes:

- authenticated campaign/document facts;
- the journal fold or a typed integrity failure;
- cancel-marker observation;
- controller observation;
- exact worker observations;
- report and cleanup observations; and
- the current cost summary.

It does not read files, inspect Docker, acquire locks, repair state, or append an
event.

The primary states and precedence are exactly the parent contract:

1. authenticated `sealed`, `cancelled`, or valid external abandonment;
2. durable cancel marker as `cancel_requested`;
3. latest unmatched `storage_paused`;
4. verified live controller as `running` or `sealing`;
5. prior execution with no live controller, unbound handle, or unverified
   worker as `recovery_required`;
6. never-run authenticated campaign as `registered`; and
7. `unknown` when authentication fails and no valid abandonment record exists.

The JSON schema includes:

```ts
interface CampaignStatusV2 {
  schema_version: 2;
  campaign_id: string | null;
  primary_state:
    | 'registered'
    | 'running'
    | 'recovery_required'
    | 'storage_paused'
    | 'cancel_requested'
    | 'sealing'
    | 'sealed'
    | 'cancelled'
    | 'abandoned'
    | 'unknown';
  integrity: 'ok' | 'failed' | 'unknown';
  controller: ControllerObservation;
  workers: WorkerObservation[];
  report: ReportObservation;
  cleanup: CleanupObservation;
  costs: CampaignCostSummary;
  blockers: StatusBlocker[];
  allowed_actions: CampaignAction[];
  next_action: CampaignAction | null;
}
```

The observation schemas are also closed:

```ts
type ControllerObservation =
  | { state: 'absent' }
  | {
      state: 'live';
      job_id: string;
      pid: number;
      phase: 'running' | 'sealing';
    }
  | {
      state: 'dead';
      job_id: string;
      pid: number;
      exit_code: number | null;
      signal: string | null;
    }
  | { state: 'unverified'; job_id: string | null; pid: number | null };

interface WorkerObservation {
  execution_attempt_id: string;
  deterministic_name: string;
  container_id: string | null;
  state:
    | 'not_created'
    | 'created_stopped'
    | 'running'
    | 'exited'
    | 'absent'
    | 'unverified';
  spec_match: 'match' | 'mismatch' | 'unknown';
}

type ReportObservation =
  | { state: 'absent' }
  | { state: 'partial'; digest: string }
  | { state: 'complete'; digest: string }
  | { state: 'divergent'; expected_digest: string; observed_digest: string };

type CleanupObservation =
  | { state: 'none' }
  | { state: 'planned'; plan_digest: string }
  | { state: 'pending'; plan_digest: string }
  | { state: 'complete'; plan_digest: string; receipt_digest: string };
```

`StatusBlocker.code` is closed to `integrity_failed`,
`controller_unverified`, `worker_unverified`, `worker_identity_mismatch`,
`cancel_requested`, `storage_paused`, `credential_unavailable`, `input_drift`,
`report_divergent`, and `terminal`. Each blocker contains a human-safe message
and optional campaign/attempt scope; it never includes a credential value or
raw provider response.

`CampaignAction` is closed to `run`, `cancel`, `abandon`, `status`, `costs`,
`report`, `cleanup`, and `register_new`. Read actions remain available whenever
their required identity can be established. Mutating actions are derived from
state and integrity; callers do not hand-roll eligibility.

Exactly one `next_action` is present when operator work is required; otherwise
it is `null`. Human rendering in child 4 consumes this object and cannot invent
a different recommendation.

The base action table is:

| Primary state | Base allowed actions |
|---|---|
| `registered` | `run`, `cancel`, `status`, `costs` |
| `running` | `cancel`, `status`, `costs` |
| `recovery_required` | `run`, `cancel`, `abandon`, `status`, `costs` |
| `storage_paused` | `run`, `cancel`, `abandon`, `status`, `costs` |
| `cancel_requested` | `cancel`, `abandon`, `status`, `costs` |
| `sealing` | `cancel`, `status`, `costs` |
| `sealed` | `status`, `costs`, `report`, `cleanup`, `register_new` |
| `cancelled` or `abandoned` | `status`, `costs`, `report`, `cleanup`, `register_new` |
| `unknown` | `status`; `costs` when campaign identity is authenticated; `cancel` or `abandon` only when execution safety can be established |

Integrity and exact-worker predicates only remove actions from this table. The
next action is `run` for `registered`, `recovery_required`, and
`storage_paused` when runnable; `cancel` for `cancel_requested`; and `report`
for a terminal authority missing a recoverable report peer. Healthy
`running`/`sealing`, fully published terminal campaigns, and states with no
safe progress action use `null`. Cleanup is optional and is never presented as
mandatory next work.

## Cost records

Cost is a read-only measurement family in
`src/contracts/campaign/cost.ts`. One canonical role-cost record exists per
execution attempt and role when durable evidence shows that role may have made
a provider request.

Its stable identity is the JCS/SHA-256 digest of:

```text
campaign_id
comparison_id
cell_id
arm
sample_id
execution_attempt_id
run_id | null
role = subject | grader
credential
credential_generation_id
endpoint
registered_model
observed_model | null
```

The strict record is:

```ts
interface RoleCostRecordV2 {
  schema_version: 2;
  record_id: string;
  identity: RoleCostIdentity;
  tokens: {
    input: number | null;
    output: number | null;
    cache_create: number | null;
    cache_read: number | null;
    total: number | null;
  };
  duration_ms: number | null;
  observations: Array<{
    observation_id: string;
    basis: 'provider_reported' | 'usage_priced' | 'estimated';
    amount_usd: number;
    observed_at: string;
    pricing_as_of: string | null;
    pricing_source_sha256: string | null;
    source: ArtifactRef;
  }>;
  selected_observation_id: string | null;
  basis:
    | 'provider_reported'
    | 'usage_priced'
    | 'estimated'
    | 'unknown';
  amount_usd: number | null;
  issues: string[];
  source_artifacts: ArtifactRef[];
}
```

Finite non-negative zero is a valid observed amount. `basis: unknown` requires
`amount_usd: null` and no selected observation. Every other basis requires one
matching selected observation and a finite non-negative amount. Missing,
malformed, or conflicting evidence never becomes zero.

Token counts are null or non-negative integers; duration is null or a finite
non-negative integer. Observation timestamps are strict UTC RFC 3339 strings.
An observation ID is the JCS/SHA-256 digest of its basis, amount, timestamp,
pricing metadata, and source artifact reference. Observations, issue codes,
and source-artifact references have one documented canonical sort order before
hashing or publication, so filesystem discovery order cannot change a record.

Raw observations remain visible in the record even when another observation is
selected. The frozen `observed_cost_v1` policy selects explicitly:

1. one valid provider-reported charged amount;
2. otherwise one exact usage record priced by the frozen rate table;
3. otherwise one explicitly labelled estimate; or
4. `unknown`.

Multiple disagreeing candidates at the selected level yield `unknown` with a
conflict issue. Lower-level observations are retained but not summed. This
prevents an OpenRouter charged amount and an obol estimate from being counted
twice.

The existing run artifacts remain the evidence sources:

- Coding-Agent ATIF token/cost measurements;
- `coding-agent-token-usage.json`;
- Gauntlet usage sidecar and result metadata; and
- OpenRouter generation attestation when present.

This child centralizes their normalization for campaigns but does not change
ordinary run economics.

### Expected records and unknown coverage

The cost projector accepts typed attempt facts. A role becomes expected when:

- a started-worker observation means the grader may have called its provider;
- `exposure_started` or subject-provider evidence means the subject may have
  called its provider; or
- any valid or malformed role-specific cost artifact is discovered.

A container proven never started creates no role-cost obligation. A live or
nonterminal expected role is `pending`. A terminal expected role without a
valid record is `unknown`. This lets a crash before Docker start report no
fictional cost gap while a crash after possible provider use cannot disappear
from coverage.

## Cost aggregation

`src/campaign/costs.ts` implements a pure fold over expected identities,
canonical cost records, and sample dispositions. It produces:

```ts
interface CampaignCostSummary {
  as_of: string;
  known_usd_subtotal: number;
  included_evidence_usd: number;
  excluded_replaced_failed_usd: number;
  subject_usd: number;
  grader_usd: number;
  known_records: number;
  expected_records: number;
  pending_records: CostIdentityRef[];
  unknown_records: CostIdentityRef[];
  coverage: number;
  by_arm: CostBreakdown[];
  by_cell: CostBreakdown[];
  by_credential: CostBreakdown[];
  by_model: CostBreakdown[];
  by_attempt: CostBreakdown[];
  registration_forecast?: RegistrationCostForecast;
}
```

The aggregate includes all attempts: included, excluded, replaced, retried,
instrument-failed, aborted after possible exposure, and reserve attempts. It
uses `record_id` for deduplication. The disposition buckets are mutually
exclusive and their known subtotals must add to `known_usd_subtotal`.

Every record and breakdown is sorted by its canonical identity before folding.
Individual observed amounts and every subtotal are rounded to ten decimal
places, matching the existing obol boundary. The live costs view sets `as_of`
to its command timestamp. A report instead sets `as_of` to the latest
referenced observation or terminal-journal timestamp, so regenerating a report
cannot change its digest merely because wall-clock time passed.

`coverage` is `known_records / expected_records`; when no role record is
expected it is `1`, with zero known subtotal and empty pending/unknown lists.
Pending and terminal-unknown identities are separate. A summary with either is
labelled partial by renderers. It never calls a partial subtotal `total` and
never computes measured-minus-forecast.

Cost parsing and aggregation failures affect the cost view and report coverage,
not dispatch. No module under admission, replacement, or concurrency may import
`src/campaign/costs.ts`, a price table, or the cost-forecast types.

## Report contract

`src/contracts/campaign/report.ts` becomes V2 and descriptive-only:

- `schema_version: 2`;
- `profile: descriptive_v1`;
- `stamp: DESCRIPTIVE`;
- `complete: boolean`;
- no verdict field and no `cannot_answer` release-gate semantics;
- the existing comparison/cell outcome and provenance sections;
- accounting without budget events or amendments; and
- a `costs: CampaignCostSummary` section.

Complete sealed reports set `complete: true`. Cancelled and abandoned reports
set `complete: false` and enumerate missing evidence. Unknown cost does not
make an otherwise complete descriptive report incomplete; the cost section
shows reduced coverage. Missing required measurement evidence still prevents a
complete seal under the existing fail-closed report rules.

## Removal of budget authority

The implementation removes, rather than renames, all campaign dollar-control
behavior:

- `budget_usd` and campaign `budget`;
- price-coverage registration refusal and surcharge calculation;
- `pricing_overrides` and `--pricing-overrides`;
- `budget_stopped`, `budget_event`, and `amendment`;
- spend and amendment materialized tables;
- in-flight cost estimates and budget admission predicates;
- budget gates around reserve and contention replacement;
- budget raise and never-resurrect behavior;
- unpriced-terminal fail-stop and spend-recovery adjudications;
- budget and amendment report counters; and
- budget-specific tests and fixture expectations.

Count, time, reserve, contention, concurrency, rate-limit, storage, and
credential bounds remain. Variables that use “budget” in the ordinary timeout
sense are renamed only when they are campaign-dollar concepts; generic time
budgets outside campaign cost authority are not swept mechanically.

Terminal event append no longer waits for a dollar amount. It records available
cost-record references, including an explicit unknown record when required,
and continues according to experimental policy. Sealing verifies record
identity and coverage accounting but does not require every amount to be known.

## Safe intermediate state

Child 1 is developed and reviewed on the Campaign Appliance V2 feature branch.
It is not installed on the appliance and runs no paid campaign. Repository
checks and no-provider campaign tests remain operational.

The internal registration function accepts already-resolved `FrozenRefs`,
`FrozenRuntime`, and policy references so its behavior is fully testable.
Children 2 and 3 become the only production producers of those values. Until
they land, mutating raw commands `quorum campaign register|run|cancel|report`
refuse with typed code `campaign_v2_appliance_not_ready`; they never substitute
zeros, current-checkout paths, mutable tags, or fixture digests. The no-spend
`acquire`, `estimates`, and `simulate` tools remain available after consuming
the V2 schemas.

The host-direct spawn seam may remain in source so the dispatcher can be
unit-tested until child 3 replaces it, but no command reaches it. Documentation
and operator output identify `evals-appliance campaign` as unavailable until
child 4, and child 5 owns the only production cutover.

## Exact source layout

### Contract files

- Modify `src/contracts/campaign/suite.ts`: V2-only exploratory suite.
- Modify `src/contracts/campaign/campaign.ts`: V2 campaign and public execution
  surface.
- Modify `src/contracts/campaign/digest.ts`: `input_digest` projection.
- Modify `src/contracts/campaign/journal-events.ts`: closed V2 union.
- Modify `src/contracts/campaign/state-machine.ts`: sole executable fold.
- Delete `src/contracts/campaign/crash-windows.ts` after moving its retained
  pure obligations into the fold and durable corpus; no forwarding shim.
- Add `src/contracts/campaign/durable-prefixes.ts`: compatibility corpus.
- Add `src/contracts/campaign/status.ts`: status observations and projection.
- Add `src/contracts/campaign/cost.ts`: role record and aggregate schemas.
- Modify `src/contracts/campaign/report.ts`: descriptive V2 report.
- Keep `src/contracts/campaign/typed-failures.ts`, amending only closed causes
  required by the V2 event payloads.

### Runtime files

- Modify `src/campaign/journal.ts`: schema 2, shared fold, V2 projections, no
  spend/amendment tables.
- Modify `src/campaign/registration.ts`: V2 documents, duration/cost split, no
  pricing or budget refusal.
- Modify `src/campaign/dispatcher.ts`: remove budget admission/accounting while
  preserving capacity, reserve, contention, and failure behavior.
- Modify `src/campaign/recovery.ts`: remove spend reconstruction and consume the
  shared fold/durable-prefix contract.
- Add `src/campaign/costs.ts`: campaign cost normalization and aggregation.
- Modify `src/campaign/report.ts`: V2 report fold and cost summary.
- Modify `src/campaign/seal.ts`: V2 completeness without gating or budget.
- Modify `src/campaign/campaign-document.ts`: version-first V2 loading and
  typed rejection.
- Modify `src/campaign/arm-suite-check.ts`: strict V2 suite validation.
- Modify `src/cli/campaign.ts`: remove pricing inputs and consume V2 readers;
  fail closed for mutating campaign commands until their prerequisite children
  land; do not add appliance commands.

### Active suites and fixtures

- Convert `suites/d4a_live_crash.yaml`,
  `suites/d4a_live_exploratory.yaml`, and `suites/opus5_signature.yaml` to V2.
- Move `suites/d4a_live_gating.yaml` to
  `test/fixtures/campaign-v1/d4a_live_gating.yaml`; it remains rejection and
  historical-evidence input, not an active suite.
- Do not rewrite historical files under `docs/experiments/` or superseded specs
  and plans.

## Test strategy

Tests exercise schemas, pure folds, SQLite behavior, and real artifact readers.
They do not snapshot large JSON or rendered output strings.

### Contract tests

- Update `test/campaign-contracts-arm-suite.test.ts` for V2 suite round trips,
  required grader credential, and budget/gating rejection.
- Update `test/campaign-contracts-campaign.test.ts` for full referential and
  execution-surface invariants.
- Update `test/campaign-contracts-digest.test.ts` to prove behavioral inputs
  change `input_digest` while registration metadata and cost forecast do not.
- Update `test/campaign-contracts-journal.test.ts` to round-trip every V2 event
  and reject every removed V1 event.
- Replace `test/campaign-contracts-state-machine.test.ts` with exhaustive
  event/state and identity-conflict coverage against the shared fold.
- Replace `test/campaign-contracts-crash-windows-e7.test.ts` with
  `test/campaign-contracts-durable-prefixes.test.ts`, running every corpus case.
- Add `test/campaign-contracts-status.test.ts` for precedence, actions, and
  next-action uniqueness.
- Add `test/campaign-contracts-cost.test.ts` for identity, observations,
  conflict, zero, unknown, and strictness.
- Update `test/campaign-contracts-report.test.ts` for descriptive-only V2 and
  cost coverage.

### Runtime tests

- Update `test/campaign-journal.test.ts` and
  `test/campaign-journal-replay.test.ts` to prove append/replay equivalence,
  schema-1 refusal before mutation, and projection rebuild.
- Update registration tests to prove cost estimates are optional, duration is
  scheduling input, and no price affects eligibility.
- Update dispatcher tests to prove the same block admits regardless of known,
  unknown, low, or high cost while count/capacity constraints still apply.
- Update recovery tests to prove unknown cost neither blocks nor disappears
  from coverage.
- Add `test/campaign-costs.test.ts` using real fixture artifact shapes for
  subject, grader, OpenRouter charged cost, estimated cost, missing files,
  malformed files, duplicates, and every attempt disposition.
- Update report and seal tests to prove unknown cost is visible but does not
  prevent a complete descriptive seal.
- Update CLI and `quorum check` tests for removed pricing options, V2 suite
  validation, typed V1 refusal, and the intermediate
  `campaign_v2_appliance_not_ready` boundary.

### Architectural assertions

Focused tests and TypeScript boundaries prove:

- the journal writer and replay use the same fold function;
- cost aggregation imports no dispatcher or lock module;
- dispatcher/admission modules import no campaign cost aggregator, cost
  forecast, or price table;
- active schemas expose no V1 or budget union arm; and
- removed event strings cannot parse through a catch-all.

## Implementation order and commit boundaries

The later writing plan must preserve a green tree at every commit and use these
boundaries:

1. V2 suite/campaign/digest schemas and active-suite conversion.
2. V2 event union and sole pure fold.
3. Durable-prefix corpus and status projection.
4. Cost record normalization and aggregation.
5. SQLite V2 projection and V1 refusal.
6. Budget removal from registration, dispatcher, recovery, report, seal, and
   CLI.
7. V2 report integration and full repository verification.

Tests are written before each production change. No commit introduces a V1
reader, temporary compatibility export, or live-spend path.

## Acceptance criteria

Child 1 is complete when:

1. Every active campaign document schema is version 2 and strict.
2. A V1 suite, campaign, journal, report, or cost document returns typed
   `unsupported_campaign_version` without mutation.
3. No active schema, journal event, state, SQL table, CLI option, dispatcher
   predicate, recovery rule, or report field grants dollar authority.
4. The same pure fold drives incremental journal append and replay.
5. Every journal type has an explicit legal transition and every parent crash
   cut has a durable-prefix case.
6. Status precedence, allowed actions, and exactly-zero-or-one next action are
   deterministic for every corpus case.
7. Cost includes all expected subject and grader records across included,
   excluded, failed, retried, and replacement attempts.
8. Missing or conflicting cost is explicit; an observed zero stays zero; no
   unknown becomes zero.
9. Cost values cannot change admission, replacement, continuation,
   cancellation, or sealing.
10. Historical experiment and superseded design documents remain byte-untouched.
11. `bun run check`, `bun run quorum check`, and `git diff --check` pass.
12. No provider request, appliance mutation, credential rotation, remote
    deployment, or live campaign occurs.
13. In the child-1 intermediate state, no public command can reach the retained
    host-direct campaign spawn seam.

## Interfaces handed to later children

Child 2 receives `ArtifactRef`, cost-record references, the journal fold, the
durable-prefix corpus, and report completeness predicates. It must make the
referenced evidence durable without changing their semantics.

Child 3 receives the attempt lifecycle, preallocated identities, public
execution descriptors, expected-cost facts, and allocation/exposure/terminal
event contracts. It must project credentials and produce evidence matching
those contracts.

Child 4 receives the status observation types, action eligibility, journal
authority, cost summary, and durable-prefix corpus. It must adapt real
appliance jobs, locks, Docker observations, and commands to them rather than
reimplementing state.

Child 5 receives a V2-only on-disk grammar and compatibility corpus. It must
prove the installed controller passes that corpus before deployment and refuse
older-volume execution without adding a reader.

## Resolved questions

- **Parallel V1/V2 contracts?** No. In-place clean break.
- **V1 artifact reader?** No. Typed refusal only.
- **Budget replacement?** None. Cost is read-only measurement.
- **Manual price overrides?** Not in V2 child 1. Unknown is honest.
- **Gating profile?** Removed from the active V2 contract.
- **Does unknown cost stop or invalidate execution?** No.
- **Can cost affect dispatch priority?** No. Duration estimates are separate.
- **Does child 1 deploy or spend?** No.
