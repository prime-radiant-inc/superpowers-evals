# Kernel D3 — Campaign Engine: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the campaign engine — the eight D3-owned kernel seams (locks, journal, registration, dispatcher, spawn/key-select, sensors, failure-classifier, recovery) plus the three named CLI/threading surfaces — so a registered campaign runs, crashes, resumes, and cancels over a durable SQLite journal with host-wide spend locking, per the frozen D3 spec.

**Architecture:** A single-writer SQLite journal (`bun:sqlite`, WAL + `synchronous = FULL`) in the campaign dir, fenced by a lock-dir lease + in-transaction `writer_generation` bumps; a thin campaign dispatcher that shares the execution primitive with `run-all` (CLI-argv children of the snapshot's own entrypoint, spawned detached as process-group leaders over an injectable spawner seam); D1's 21-event vocabulary (20 + E7's `quarantined`) replayed through the pinned routing table over universe-plus-instance membership; one pure contention evaluator shared verbatim by sensors, dispatcher, and D4.

**Tech Stack:** TypeScript on Bun ≥1.3; `bun:sqlite` (Bun built-in), `node:child_process`, `node:fs`; zod (existing contracts), Commander (CLI), `bun test`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md` (revision 4, fully ratified + ratified OQ-11 amendment + ratified D1 erratum E7). **Review record:** `docs/experiments/2026-08-26-kernel-d3-spec-review.md`. **Approaches gate:** `docs/experiments/2026-08-26-kernel-d3-approaches-gate.md`.

## Global Constraints

- **Fail-closed everywhere:** every unresolvable state refuses loudly rather than proceeding on a surrogate. No fabricated journal rows, no silent drops; every refusal names the operator's next step.
- **TDD, red first:** every behavior lands as a failing test before its implementation, per step order. Repo gates (`bun run check`, `bun run quorum check`) green per commit.
- **No new dependencies.** `bun:sqlite`, `node:child_process`, and `node:fs` lock-dir mechanics over the existing dependency set only.
- **E7 is RATIFIED (2026-08-26, E1–E6 precedent).** The spec's "gated on ratification" phrasing is historical; task 1 lands the contract bundle ungated. The shipped 21-event vocabulary is live from task 1.
- **40-hex SHAs at the campaign layer** (D1's `FULL_SHA_RE = /^[0-9a-f]{40}$/`, `src/contracts/campaign/campaign.ts:6`). D2's 40/64-hex acceptance in the materializers stays dormant — unused by D3, not removed.
- **Lowercase `quorum`** in code, CLI, paths, and prose (repo convention).
- **One Clock seam, named uniformly:** `Clock`/`FakeClock` from `src/scheduler/clock.ts` — **seconds-based** (`now()` returns seconds) — drives journal timestamps, registration, cancellation, cooldowns, recovery, heartbeats, and sampler cadence. Millisecond journal/sidecar fields derive via `clockNowMs(clock) = Math.round(clock.now() * 1000)` (task 1's `src/campaign/host-stats.ts`). Tests never read wall time for behavior.
- **Seams carry the fiction; no mocked-behavior tests.** Real fixtures, real tmp git repos, real subprocesses. The D3 seams: `FakeClock`, the `CommandRunner` projection (`src/agents/command-runner.ts`), the child-spawner seam (task 1 types, task 6 production), and the host-stats probe (task 1 types, task 2 production).
- **ID-component grammar:** every external component interpolated into a generated id matches `^[a-z0-9][a-z0-9._-]*$`; `:` is reserved exclusively as the generated delimiter (never a component character). A duplicate at construction is a loud programming error.
- **Decision D-2 honesty:** the materialized `attempts.spawn_gap_ms` stat is labeled **"spawn-gap" in every surface that reads it** — never claimed as pure key-wait. Zero journal amendments for key-wait.
- **Journal PRAGMAs on every writer connection:** `journal_mode = WAL`, `synchronous = FULL`, `busy_timeout = 0` (verbatim). Readers use separate connections, never write, never checkpoint.
- **Writer election:** lock-dir lease at `<campaignDir>/journal.lease.d` + in-transaction `meta.writer_generation` fencing; a deposed-but-alive writer's next append fails loudly (`WriterDeposedError`), never interleaves.
- **`run_allocated` payload discipline:** `key_env`/grant fields carry env-var **names only, never values**.
- **Children never acquire locks:** campaign children are marked via an explicit env channel (`QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1`) and covered by the holder's accounting; the live-spend lock is taken by exactly the three top-level spender verbs (`campaign run`, `run-all`, direct `quorum run`).
- **No `run-all` behavior change beyond lock acquisition**, no legacy scheduler change, no dashboard change, no appliance change. `runSchedule` is not generalized in v1; campaigns key pools on `poolKey`, legacy keeps `limiterKey`.
- **Module layout:** no `src/campaign/index.ts` barrel — modules import directly by path. Match that. Env reads go through `src/env.ts` (`getEnv`) only.

## File Structure

New files under `src/campaign/` (spec Artifact layout; one responsibility each):

| File | Responsibility | Task |
|---|---|---|
| `src/campaign/host-stats.ts` | Injectable host probe types (`HostStats`, `HostStatsProbe`) + `clockNowMs` (task 1 typed seam); production Linux probe, fingerprint, resource-floor preflight, fingerprint match (task 2) | 1, 2 |
| `src/campaign/spawn.ts` | Child-spawner seam types (task 1); detached process-group-leader spawn, pgid validation, campaign-child argv, `run_allocated` correlation (task 6) | 1, 6 |
| `src/campaign/locks.ts` | Journal writer lease + host-wide live-spend lock on the D2 lock-dir protocol; heartbeat + ESRCH/birth-identity dead-holder staleness; `ProcessIdentityProbe`; stale reclamation; children-never-acquire | 2 |
| `src/campaign/journal.ts` | SQLite store; lease+fenced one-transaction append; projection tables; routed three-valued replay; ordered read API; `schema_version`; absolute-total budget snapshots; P-4/S-8 publication (ballast, campaign.json staged + renamed last); sealer-writer restriction | 3 |
| `src/campaign/snapshot.ts` | D2 materializer call sites with campaign-dir destinations; `reconstructSnapshot` + `Campaign.refs` cross-check; `verifySnapshot` cadence sites; authorized drift repair; drift → affected-set mapping (consumed by task 8) | 4 |
| `src/campaign/registration.ts` | Snapshot-first intake; child-contract probe; grid expansion; rejection matrix; ref→SHA resolution; pricing (E1/E2 keying, grader-match restriction, versioned surcharge); digest; ID determinism; incomplete-dir classification/repair; marker-file publication; `campaign_opened`; contention declarations | 5 |
| `src/campaign/key-select.ts` | `KeySelector` implementation (least-loaded; wait guard; loud warnings; fail-loud resolution) | 6 |
| `src/campaign/sensors.ts` | Rate-limit marker-table classification (5 pinned rows); `ExposureProbe` per-harness contract + decision point at block terminal | 7 |
| `src/campaign/contention.ts` | Timer-driven sampler + fsynced sidecar; breach edges; coverage; **one pure tri-state evaluator** shared verbatim with dispatcher and D4; dead-sampler liveness | 7 |
| `src/campaign/classifier.ts` | Closed `ClassificationInput → {class, cause?}` table (14 pinned rows) | 7 |
| `src/campaign/dispatcher.ts` | Atomic per-block admission (per-sample global cap, service-end release); longest-expected-first + backfill; cooldowns; E7 ordered mint bundle + replacement/rerun entry; budget enforcement + absolute snapshots + never-resurrects; closed-window contention batch (shared with recovery); wave + block-terminal verify with the full D-11 drift sequence; D-13 detection at both sites + `performStoragePause`; spawn-failure pool halt; breach/liveness halts; D-12 signal handling incl. the live-cancel branch; `realSamplerSeam` production sampler wiring | 8, 9 |
| `src/campaign/recovery.ts` | Identity-guarded pgid kill; journal↔run-dir reconciliation; partial-mint completion; resolver override; rerun re-entry; quarantine; crash-window execution; refs cross-check on resume; ENOSPC reconciliation; the pinned resume order | 9 |

Modified files:

| File | Change | Task |
|---|---|---|
| `src/contracts/campaign/typed-failures.ts` | Four `InstrumentCause` additions; `BlockReplacementReason` set | 1 |
| `src/contracts/campaign/journal-events.ts` | E7 payloads: `quarantined` (21st event), widened `block_replaced`, `block_admitted.rerun_of`, `run_allocated` legacy/new grant union | 1 |
| `src/contracts/campaign/state-machine.ts` | Re-entry edges from `aborted\|completed\|instrument_failed` via `rerun_of`; `admitted` disposition source; terminal-tolerant `aborted`/`skew_excluded` fan-out | 1 |
| `src/contracts/campaign/crash-windows.ts` | Instance-aware fold (universe ∪ mint rosters); successor-local seal predicate (E7.3); superseded-predecessor resolver override | 1 |
| `src/contracts/campaign/campaign.ts` | `BlockSchema.slot`; `contention` block; `execution_surface`; `budget.surcharge_formula_version`; grader-capable `PricingOverrideSchema`; `ID_COMPONENT_RE`; `CampaignIdentitySchema` | 1 |
| `src/runner/index.ts` | `RunScenarioArgs.campaign` identity intake; persisted at run-dir allocation; stamped on every verdict/error/stopped path | 6 |
| `src/runner/stopped.ts` | Stopped verdicts carry the campaign identity block | 6 |
| `src/cli/run-child.ts` | Campaign-identity flags on the internal child parser | 6 |
| `src/cli/run-command.ts` | Identity persistence at the `onRunDir` seam; live-spend-lock acquisition for direct `quorum run` | 6, 9 |
| `src/run-all/index.ts` | Live-spend-lock acquisition at the `run-all` entry (no other behavior change) | 9 |
| `src/cli/campaign.ts` + `src/cli/index.ts` | `quorum campaign register \| run \| cancel` verbs | 9 |
| `.gitignore` | `campaigns/` entry | 5 |
| `docs/appliance-runbook.md` | `QUORUM_LIVE_SPEND_LOCK` appliance-owned shared path (R-LCK-2 implementation obligation) | 2 |
| `AGENTS.md` + D3 spec status line | Architecture bullets + `implemented` status | 9 |
| `test/campaign-*.test.ts`, `test/fixtures/campaign/` | Hermetic tests per module; golden streams, marker streams, fake host-stats series, crash prefixes | 1–9 |
| `test/integration/campaign-linux-matrix.test.ts` | Linux-gated integration matrix (trusted-maintainer, tagged) | final section |

---

### Task 1: E7 contract bundle + contract additions + typed seams

**Files:**
- Modify: `src/contracts/campaign/typed-failures.ts` (four `InstrumentCause` additions, `BlockReplacementReason`)
- Modify: `src/contracts/campaign/journal-events.ts` (`quarantined` 21st event; widened `block_replaced`; `block_admitted.rerun_of`; `run_allocated` legacy/new grant union; parse helpers)
- Modify: `src/contracts/campaign/state-machine.ts` (re-entry edges; `admitted` disposition source; terminal-tolerant `aborted`/`skew_excluded`)
- Modify: `src/contracts/campaign/crash-windows.ts` (instance-aware fold; E7.3 successor-local seal predicate; superseded-predecessor resolver override)
- Modify: `src/contracts/campaign/campaign.ts` (`BlockSchema.slot`; `contention`; `execution_surface`; `budget.surcharge_formula_version`; grader-capable `PricingOverrideSchema`; `ID_COMPONENT_RE`; `CampaignIdentitySchema`; `digestInput` amendment)
- Create: `src/campaign/host-stats.ts` (typed seam: `HostStats`, `HostStatsProbe`, `clockNowMs`)
- Create: `src/campaign/spawn.ts` (typed seam: `CampaignChildSpec`, `SpawnedCampaignChild`, `ChildSpawner`)
- Test: create `test/campaign-contracts-e7.test.ts`; modify `test/campaign-contracts-state-machine.test.ts`, `test/campaign-contracts-journal.test.ts`, `test/campaign-contracts-campaign.test.ts`, `test/campaign-contracts-digest.test.ts`; create `test/campaign-seams.test.ts`

**Interfaces:**
- Consumes: `EnvVarNameSchema` from `src/contracts/credential.ts`; `FiniteNumberSchema` from `src/contracts/finite.ts`; `Clock` from `src/scheduler/clock.ts`; existing D1 contract files as shipped on main.
- Produces (later tasks rely on these exact names):
  - `INSTRUMENT_CAUSES` — now the closed set of **ten** (D1's six + `grader_crashed`, `grader_misconfigured`, `setup_failed`, `subject_rate_limited`); `BLOCK_REPLACEMENT_REASONS: readonly BlockReplacementReason[]` = the ten instrument causes + `'dispatcher_restart' | 'snapshot_drift' | 'storage_failure' | 'skew_refill' | 'exposure_audit' | 'contention'`.
  - `QuarantinedEvent`, `QUARANTINE_REASONS = ['attempt_mismatch', 'late_terminal', 'campaign_mismatch'] as const`; `JOURNAL_EVENT_TYPES` has 21 entries.
  - `BlockRosterEntrySchema`; `normalizeBlockReplaced(payload: BlockReplacedPayload): BlockReplacedRecord` (legacy rows → `{ reason: cause, kind: 'replacement', reserve_activation: true, roster: [] }`; fresh rows pass through).
  - `KeyGrantEntrySchema`; `readRunAllocatedGrants(payload): { role: 'subject' | 'grader'; env: string }[]` (prefers `key_grants`; falls back to legacy `key_env` as the subject grant).
  - `applySampleEvent` with the E7 edges (same signature); `REENTRY_STATES = ['aborted', 'completed', 'instrument_failed'] as const`.
  - `CampaignUniverse` (additive: sample entries gain optional `arm?`/`cell?`; block entries gain optional `slot?`), `sealPredicateHolds(universe, events)` (E7.3 semantics), `resolveCrashWindows(universe, events)` (with the superseded-predecessor override) — signatures unchanged.
  - `ID_COMPONENT_RE = /^[a-z0-9][a-z0-9._-]*$/`, `ContentionDeclarationSchema`, `ExecutionSurfaceArmSchema`, `CampaignIdentitySchema`/`CampaignIdentity`, `BlockSlotSchema`.
  - `clockNowMs(clock: Clock): number` from `src/campaign/host-stats.ts`; `ChildSpawner`/`CampaignChildSpec`/`SpawnedCampaignChild`/`ChildExitInfo` from `src/campaign/spawn.ts`.

Task 1 runs as three executable sub-tasks (1a → 1b → 1c, strictly in order); each has its own failing-tests-first cycle, verify command, and commit. Step numbers stay continuous across the task.

#### Task 1a: E7 vocabulary — typed-failures + journal-events (Steps 1–4; covers R-CLS-5's vocabulary half + the E7 payload contracts R-JRN-6/R-JRN-9 consume)

**Files:** modify `src/contracts/campaign/typed-failures.ts` + `src/contracts/campaign/journal-events.ts`; create `test/campaign-contracts-e7.test.ts`; modify `test/campaign-contracts-journal.test.ts`.

- [ ] **Step 1: Write the failing tests** — create `test/campaign-contracts-e7.test.ts`:

```ts
import { expect, test } from 'bun:test';
import {
  BLOCK_REPLACEMENT_REASONS,
  INSTRUMENT_CAUSES,
} from '../src/contracts/campaign/typed-failures.ts';
import {
  BlockReplacedEvent,
  JOURNAL_EVENT_TYPES,
  JournalEventSchema,
  normalizeBlockReplaced,
  QuarantinedEvent,
  readRunAllocatedGrants,
  RunAllocatedEvent,
} from '../src/contracts/campaign/journal-events.ts';

test('the closed InstrumentCause set is the ten pinned causes (D1 six + four additions)', () => {
  expect([...INSTRUMENT_CAUSES]).toEqual([
    'grader_billing_exhausted',
    'grader_rate_limited',
    'subject_spawn_failed',
    'subject_crashed',
    'capture_failed',
    'checks_crashed',
    'grader_crashed',
    'grader_misconfigured',
    'setup_failed',
    'subject_rate_limited',
  ]);
});

test('BlockReplacementReason is the closed block-scoped set (E7.2)', () => {
  expect([...BLOCK_REPLACEMENT_REASONS]).toEqual([
    ...INSTRUMENT_CAUSES,
    'dispatcher_restart',
    'snapshot_drift',
    'storage_failure',
    'skew_refill',
    'exposure_audit',
    'contention',
  ]);
});

test('quarantined is the 21st event: strict, binding-only payload', () => {
  expect(JOURNAL_EVENT_TYPES).toHaveLength(21);
  expect(JOURNAL_EVENT_TYPES).toContain('quarantined');
  const parsed = QuarantinedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'quarantined',
    payload: { run_id: 'r1', attempt_id: 'a1', reason: 'attempt_mismatch' },
  });
  expect(parsed.payload.reason).toBe('attempt_mismatch');
  expect(() =>
    QuarantinedEvent.parse({
      seq: 1,
      ts_ms: 2,
      type: 'quarantined',
      payload: { run_id: 'r1', reason: 'bogus' },
    }),
  ).toThrow();
  // attempt_id is optional; no state-machine edge (binding-only like attempt_created).
  expect(
    QuarantinedEvent.parse({
      seq: 1,
      ts_ms: 2,
      type: 'quarantined',
      payload: { run_id: 'r1', reason: 'late_terminal' },
    }).payload.attempt_id,
  ).toBeUndefined();
});

test('widened block_replaced: fresh rows carry reason/kind/reserve_activation/roster', () => {
  // A REPLACEMENT row carries the supersedes pairs — same-arm only, never
  // cross-arm; a rerun row (fixture below at the routing tests) is reserve-
  // and count-neutral and carries NO supersedes (E7.2).
  const fresh = BlockReplacedEvent.parse({
    seq: 3,
    ts_ms: 4,
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'c1:scn:x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    },
  });
  const rec = normalizeBlockReplaced(fresh.payload);
  expect(rec).toEqual({
    block_id: 'b1',
    replacement_block_id: 'c1:scn:x1',
    reason: 'grader_crashed',
    kind: 'replacement',
    reserve_activation: true,
    roster: [
      { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
      { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
    ],
  });
});

test('widened block_replaced: legacy rows round-trip (E7.2 legacy rule)', () => {
  const legacy = BlockReplacedEvent.parse({
    seq: 3,
    ts_ms: 4,
    type: 'block_replaced',
    payload: {
      block_id: 'b1',
      replacement_block_id: 'b2',
      cause: 'grader_rate_limited',
    },
  });
  expect(normalizeBlockReplaced(legacy.payload)).toEqual({
    block_id: 'b1',
    replacement_block_id: 'b2',
    reason: 'grader_rate_limited',
    kind: 'replacement',
    reserve_activation: true,
    roster: [],
  });
  // An out-of-vocabulary cause still rejects.
  expect(() =>
    BlockReplacedEvent.parse({
      seq: 3,
      ts_ms: 4,
      type: 'block_replaced',
      payload: { block_id: 'b', replacement_block_id: 'c', cause: 'bogus' },
    }),
  ).toThrow();
});

test('run_allocated: the new arm requires key_grants and forbids key_env', () => {
  // RunAllocatedEvent.parse types .payload as the two-arm union exactly —
  // no cast needed to feed readRunAllocatedGrants.
  const fresh = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 42,
      key_grants: [
        { role: 'subject', env: 'ANTHROPIC_API_KEY' },
        { role: 'grader', env: 'GRADER_KEY' },
      ],
    },
  });
  expect(readRunAllocatedGrants(fresh.payload)).toEqual([
    { role: 'subject', env: 'ANTHROPIC_API_KEY' },
    { role: 'grader', env: 'GRADER_KEY' },
  ]);
  // key_env forbidden on the new arm; duplicate role rejects; 3 entries reject.
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 2,
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 42,
        key_grants: [{ role: 'subject', env: 'K' }],
        key_env: 'OTHER',
      },
    }),
  ).toThrow();
  expect(() =>
    JournalEventSchema.parse({
      seq: 1,
      ts_ms: 2,
      type: 'run_allocated',
      payload: {
        attempt_id: 'a1',
        run_id: 'r1',
        pgid: 42,
        key_grants: [
          { role: 'subject', env: 'K1' },
          { role: 'subject', env: 'K2' },
        ],
      },
    }),
  ).toThrow();
});

test('run_allocated: legacy arm parses unchanged (key_env only / neither)', () => {
  const legacy = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 7, key_env: 'K' },
  });
  expect(readRunAllocatedGrants(legacy.payload)).toEqual([
    { role: 'subject', env: 'K' },
  ]);
  const neither = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 7 },
  });
  expect(readRunAllocatedGrants(neither.payload)).toEqual([]);
  const grantsEmpty = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 2,
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 7, key_grants: [] },
  });
  expect(readRunAllocatedGrants(grantsEmpty.payload)).toEqual([]);
});

test('block_admitted gains additive rerun_of', () => {
  const parsed = JournalEventSchema.parse({
    seq: 1,
    ts_ms: 2,
    type: 'block_admitted',
    payload: { block_id: 'b:i1', pools: ['p'], rerun_of: 'b' },
  });
  expect((parsed.payload as { rerun_of?: string }).rerun_of).toBe('b');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-e7.test.ts`
Expected: FAIL — `BLOCK_REPLACEMENT_REASONS`, `normalizeBlockReplaced`, `QuarantinedEvent`, `readRunAllocatedGrants` do not exist; `JOURNAL_EVENT_TYPES` has 20 entries.

- [ ] **Step 3: Implement the vocabulary amendments**

`src/contracts/campaign/typed-failures.ts` — replace the `INSTRUMENT_CAUSES` block with the pinned set of ten (spec Decision D-10 classifier table + R-CLS-5), then append the reason set:

```ts
export const INSTRUMENT_CAUSES = [
  'grader_billing_exhausted',
  'grader_rate_limited',
  'subject_spawn_failed',
  'subject_crashed',
  'capture_failed',
  'checks_crashed',
  // E7 additions (D3 spec classifier table rows 3, 4, 5, 7 — ratified):
  'grader_crashed',
  'grader_misconfigured',
  'setup_failed',
  'subject_rate_limited',
] as const;
export type InstrumentCause = (typeof INSTRUMENT_CAUSES)[number];

/** E7.2: the closed block-scoped replacement-reason set. The instrument
 *  causes plus the rerun/validity reasons; additions remain platform PRs. */
export const BLOCK_REPLACEMENT_REASONS = [
  ...INSTRUMENT_CAUSES,
  'dispatcher_restart',
  'snapshot_drift',
  'storage_failure',
  'skew_refill',
  'exposure_audit',
  'contention',
] as const;
export type BlockReplacementReason = (typeof BLOCK_REPLACEMENT_REASONS)[number];
```

`src/contracts/campaign/journal-events.ts` — import `BLOCK_REPLACEMENT_REASONS`, then:

1. `BlockAdmittedEvent` payload gains `rerun_of: z.string().min(1).optional()` (after `pools`).
2. Replace `BlockReplacedEvent`:

```ts
export const BlockRosterEntrySchema = z
  .object({
    sample_id: z.string().min(1),
    arm: z.string().min(1),
    supersedes: z.string().min(1).optional(),
  })
  .strict();
export type BlockRosterEntry = z.infer<typeof BlockRosterEntrySchema>;

const BlockReplacedLegacyPayload = z
  .object({
    block_id: z.string().min(1),
    replacement_block_id: z.string().min(1),
    cause: z.enum(INSTRUMENT_CAUSES),
  })
  .strict();
const BlockReplacedFreshPayload = z
  .object({
    block_id: z.string().min(1),
    replacement_block_id: z.string().min(1),
    reason: z.enum(BLOCK_REPLACEMENT_REASONS),
    kind: z.enum(['replacement', 'rerun']),
    reserve_activation: z.boolean(),
    roster: z.array(BlockRosterEntrySchema).min(1),
  })
  .strict();
export type BlockReplacedPayload = z.infer<
  typeof BlockReplacedLegacyPayload
> &
  Partial<z.infer<typeof BlockReplacedFreshPayload>>;
export const BlockReplacedEvent = envelope(
  'block_replaced',
  z.union([BlockReplacedLegacyPayload, BlockReplacedFreshPayload]),
);

export interface BlockReplacedRecord {
  readonly block_id: string;
  readonly replacement_block_id: string;
  readonly reason: BlockReplacementReason;
  readonly kind: 'replacement' | 'rerun';
  readonly reserve_activation: boolean;
  /** Empty for legacy rows: replay derives same-arm pairing from
   *  membership (E7.2 round-trip rule). */
  readonly roster: readonly BlockRosterEntry[];
}

/** E7.2 legacy round-trip: shipped rows parse as
 *  { reason: cause, kind: 'replacement' }, reserve_activation defaults to
 *  kind === 'replacement', absent roster stays empty (replay derives). */
export function normalizeBlockReplaced(
  payload: z.infer<typeof BlockReplacedLegacyPayload> | z.infer<typeof BlockReplacedFreshPayload>,
): BlockReplacedRecord {
  if ('cause' in payload) {
    return {
      block_id: payload.block_id,
      replacement_block_id: payload.replacement_block_id,
      reason: payload.cause,
      kind: 'replacement',
      reserve_activation: true,
      roster: [],
    };
  }
  return {
    block_id: payload.block_id,
    replacement_block_id: payload.replacement_block_id,
    reason: payload.reason,
    kind: payload.kind,
    reserve_activation: payload.reserve_activation,
    roster: payload.roster,
  };
}
```

3. Replace `RunAllocatedEvent` with the E7.5 two-arm union:

```ts
export const KeyGrantEntrySchema = z
  .object({
    role: z.enum(['subject', 'grader']),
    env: EnvVarNameSchema,
  })
  .strict();
export type KeyGrantEntry = z.infer<typeof KeyGrantEntrySchema>;

const RunAllocatedLegacyPayload = z
  .object({
    attempt_id: z.string().min(1),
    run_id: z.string().min(1),
    pgid: z.number().int().positive(),
    key_env: EnvVarNameSchema.optional(),
  })
  .strict();
const RunAllocatedGrantPayload = z
  .object({
    attempt_id: z.string().min(1),
    run_id: z.string().min(1),
    pgid: z.number().int().positive(),
    key_grants: z.array(KeyGrantEntrySchema).max(2),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const roles = payload.key_grants.map((g) => g.role);
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key_grants'],
        message: 'at most one grant entry per role',
      });
    }
  });
export type RunAllocatedPayload =
  | z.infer<typeof RunAllocatedLegacyPayload>
  | z.infer<typeof RunAllocatedGrantPayload>;
export const RunAllocatedEvent = envelope(
  'run_allocated',
  // Strict objects make the union key-discriminable: a fresh payload carries
  // key_grants (legacy arm rejects the unknown key), a legacy payload may
  // carry key_env (fresh arm rejects without key_grants).
  z.union([RunAllocatedGrantPayload, RunAllocatedLegacyPayload]),
);

/** E7.5 reader rule: prefer key_grants; fall back to legacy key_env as the
 *  subject grant. Names only, never values. */
export function readRunAllocatedGrants(
  payload: RunAllocatedPayload,
): readonly KeyGrantEntry[] {
  if ('key_grants' in payload) return payload.key_grants;
  return payload.key_env === undefined
    ? []
    : [{ role: 'subject' as const, env: payload.key_env }];
}
```

4. Append the 21st event before `SealedEvent`:

```ts
export const QUARANTINE_REASONS = [
  'attempt_mismatch',
  'late_terminal',
  'campaign_mismatch',
] as const;
export const QuarantinedEvent = envelope(
  'quarantined',
  z
    .object({
      run_id: z.string().min(1),
      attempt_id: z.string().min(1).optional(),
      reason: z.enum(QUARANTINE_REASONS),
    })
    .strict(),
);
```

Add `QuarantinedEvent` to the `JournalEventSchema` union and `'quarantined'` to `JOURNAL_EVENT_TYPES` (after `'budget_stopped'` position is irrelevant — append before `'sealed'` to match the union order).

- [ ] **Step 4: Amend the existing journal contract tests and run**

In `test/campaign-contracts-journal.test.ts` update the two vocabulary tests:
- `"the vocabulary holds the parent's 19 events plus campaign_cancelled"` → rename to `'the vocabulary holds the parent's 19 events, campaign_cancelled (E5), and quarantined (E7)'` and assert length 21.
- `'JOURNAL_EVENT_TYPES exactly covers the schema union (no missing, no extra)'` — keep as-is; it re-derives from the schema and passes once the union includes `quarantined`.

Run: `bun test test/campaign-contracts-e7.test.ts test/campaign-contracts-journal.test.ts test/campaign-contracts-run-allocated.test.ts`
Expected: PASS.

- [ ] **Commit (task 1a)**

```bash
git add src/contracts/campaign/typed-failures.ts src/contracts/campaign/journal-events.ts test/campaign-contracts-e7.test.ts test/campaign-contracts-journal.test.ts
git commit -m "feat(campaign): E7 vocabulary — quarantined 21st event, widened block_replaced, rerun_of, grant union"
```

#### Task 1b: state-machine edges + campaign.ts document amendments (Steps 5–10; covers the E7.1 re-entry edges R-RCV-2 consumes + the document surface — slot, contention, execution_surface, identity, ID grammar — tasks 5–9 build on)

**Files:** modify `src/contracts/campaign/state-machine.ts`, `src/contracts/campaign/campaign.ts`, `src/contracts/campaign/suite.ts` (ID-grammar refinement on `name` — the spec's second declared home), `src/contracts/campaign/digest.ts`; modify `test/campaign-contracts-state-machine.test.ts`, `test/campaign-contracts-campaign.test.ts`, `test/campaign-contracts-digest.test.ts`.

- [ ] **Step 5: Write the failing state-machine edge tests** — append to `test/campaign-contracts-state-machine.test.ts` (inside the file, after the existing `EXACT` matrix which Step 6 amends):

```ts
const EV_RERUN_ADMITTED = {
  type: 'block_admitted',
  payload: { block_id: 'b:i1', pools: ['p'], rerun_of: 'b' },
} satisfies JournalEventInput;

test('E7.1 re-entry: block_admitted{rerun_of} applies from aborted|completed|instrument_failed only', () => {
  for (const state of ['aborted', 'completed', 'instrument_failed'] as const) {
    expect(applySampleEvent(state, EV_RERUN_ADMITTED)).toEqual(
      A('admitted'),
    );
  }
  // Kill->journal-aborted order violations (corruption) and non-re-entry
  // terminals (E7.6) reject.
  for (const state of [
    'planned',
    'admitted',
    'spawned',
    'exposed',
    'skew_excluded',
    'excluded_block_replaced',
    'exhausted',
    'budget_stopped',
  ] as const) {
    expect(applySampleEvent(state, EV_RERUN_ADMITTED).result).toBe('reject');
  }
});

test('E7.1: aborted and skew_excluded are ignore-late from EVERY terminal', () => {
  for (const terminal of [
    'completed',
    'instrument_failed',
    'aborted',
    'skew_excluded',
    'excluded_block_replaced',
    'exhausted',
    'budget_stopped',
  ] as const) {
    expect(applySampleEvent(terminal, EV.aborted).result).toBe('ignore-late');
    expect(applySampleEvent(terminal, EV.skew_excluded).result).toBe(
      'ignore-late',
    );
  }
  // Non-terminal live states still apply/reject as shipped.
  expect(applySampleEvent('planned', EV.aborted).result).toBe('reject');
  expect(applySampleEvent('planned', EV.skew_excluded).result).toBe('reject');
});

test('E7.1: excluded_block_replaced gains the admitted source', () => {
  expect(applySampleEvent('admitted', EV.disposition_replaced)).toEqual(
    A('excluded_block_replaced'),
  );
});
```

Also amend three shipped assertions in the same file:
- Line ~198 test `'abort reaches admitted, spawned, exposed — never terminals'`: rename to `'abort reaches admitted, spawned, exposed; terminals are ignore-late (E7.1)'` and change the last assertion to `expect(applySampleEvent('completed', EV.aborted).result).toBe('ignore-late');`.
- In the `EXACT` table: `disposition_replaced.expected` gains `admitted: A('excluded_block_replaced')`; `skew_excluded.expected` gains all seven terminals as `LATE`; `aborted.expected` gains all seven terminals as `LATE`.
- Add two rows to `EXACT`: `{ event: 'block_admitted_rerun', expected: { aborted: A('admitted'), completed: A('admitted'), instrument_failed: A('admitted') } }` and `{ event: 'quarantined', expected: {} }` — with matching `EV` entries (`block_admitted_rerun: EV_RERUN_ADMITTED` shape `{ type: 'block_admitted', payload: { block_id: 'b:i1', pools: ['p'], rerun_of: 'b' } }`, `quarantined: { type: 'quarantined', payload: { run_id: 'r1', reason: 'attempt_mismatch' } }`).

- [ ] **Step 6: Implement the state-machine edges**

In `src/contracts/campaign/state-machine.ts`, export the re-entry set and amend three switch cases of `applySampleEvent`:

```ts
/** E7.1 re-entry sources: the three states a live block's samples can hold
 *  at kill time (partial predecessors included). */
export const REENTRY_STATES = ['aborted', 'completed', 'instrument_failed'] as const;
```

```ts
    case 'block_admitted':
      // E7.1: rerun re-entry applies per roster sample of the rerun instance.
      if ((event.payload as { rerun_of?: string }).rerun_of !== undefined) {
        return (REENTRY_STATES as readonly string[]).includes(state)
          ? apply('admitted')
          : REJECT;
      }
      return state === 'planned' ? apply('admitted') : REJECT;
```

```ts
      // The innocent arm's override; its run dir is retained. E7.1 adds
      // admitted to the shipped sources (a sibling can fail after spawning
      // while another sample is still admitted).
      if (
        state === 'admitted' ||
        state === 'spawned' ||
        state === 'exposed' ||
        state === 'completed'
      ) {
        return apply('excluded_block_replaced');
      }
      return REJECT;
```

```ts
    case 'skew_excluded':
      if (state === 'exposed' || state === 'spawned') {
        return apply('skew_excluded');
      }
      // E7.1 terminal-tolerant fan-out: retained-evidence semantics for the
      // completed sibling of a partial-block exclusion.
      if (isTerminal(state)) return LATE;
      return REJECT;
```

```ts
    case 'aborted':
      if (state === 'admitted' || state === 'spawned' || state === 'exposed') {
        return apply('aborted');
      }
      // E7.1 terminal-tolerant fan-out: the canonical partial-block abort —
      // one arm completes, the dispatcher aborts the block.
      if (isTerminal(state)) return LATE;
      return REJECT;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/campaign-contracts-state-machine.test.ts`
Expected: PASS (all shipped cells plus the E7 cells).

- [ ] **Step 8: Write the failing campaign.ts amendment tests** — append to `test/campaign-contracts-campaign.test.ts` (reuse that file's existing minimal-valid-campaign builder — read it first; extend the builder's output with the new required fields `contention`, `execution_surface`, and `budget.surcharge_formula_version: 1` so every existing test in the file stays green after the schema change):

```ts
test('E7.0: BlockSchema.slot is optional, primary | reserve, unknown values reject', () => {
  const doc = minimalCampaign(); // the file's builder, extended per Step 9
  const noSlot = { ...doc, blocks: doc.blocks.map(({ slot: _s, ...b }) => b) };
  expect(() => CampaignSchema.parse(noSlot)).not.toThrow();
  const reserve = {
    ...doc,
    blocks: doc.blocks.map((b) => ({ ...b, slot: 'reserve' as const })),
  };
  expect(() => CampaignSchema.parse(reserve)).not.toThrow();
  const bogus = {
    ...doc,
    blocks: doc.blocks.map((b) => ({ ...b, slot: 'bonus' })),
  };
  expect(() => CampaignSchema.parse(bogus)).toThrow();
});

test('the contention block is required and strict (Decision D-4)', () => {
  const doc = minimalCampaign();
  const { contention: _c, ...rest } = doc;
  expect(() => CampaignSchema.parse(rest)).toThrow();
  expect(() =>
    CampaignSchema.parse({
      ...doc,
      contention: { ...doc.contention, unknown_field: 1 },
    }),
  ).toThrow();
});

test('PricingOverrideSchema: exactly one of arm / applies_to_grader: true', () => {
  expect(() =>
    PricingOverrideSchema.parse({
      arm: 'base',
      per_token_usd: 0.01,
      rationale: 'r',
    }),
  ).not.toThrow();
  expect(() =>
    PricingOverrideSchema.parse({
      applies_to_grader: true,
      per_token_usd: 0.01,
      rationale: 'r',
    }),
  ).not.toThrow();
  expect(() =>
    PricingOverrideSchema.parse({ per_token_usd: 0.01, rationale: 'r' }),
  ).toThrow();
  expect(() =>
    PricingOverrideSchema.parse({
      arm: 'base',
      applies_to_grader: true,
      per_token_usd: 0.01,
      rationale: 'r',
    }),
  ).toThrow();
});

test('ID_COMPONENT_RE: the pinned grammar, delimiter-exclusion included', () => {
  expect(ID_COMPONENT_RE.test('a')).toBe(true);
  expect(ID_COMPONENT_RE.test('scenario-01.x_y')).toBe(true);
  expect(ID_COMPONENT_RE.test('has:colon')).toBe(false);
  expect(ID_COMPONENT_RE.test('Upper')).toBe(false);
  expect(ID_COMPONENT_RE.test('-leading-dash')).toBe(false);
  expect(ID_COMPONENT_RE.test('.dot-first')).toBe(false);
});
```

And append to `test/campaign-contracts-digest.test.ts`:

```ts
test('digest membership: contention block and surcharge_formula_version are members; exclusions stay excluded', () => {
  const doc = minimalCampaign(); // same extended builder
  const base = campaignDigest(doc);
  // Included: mutating any contention field changes the digest.
  expect(
    campaignDigest({
      ...doc,
      contention: { ...doc.contention, cadence_ms: 999999 },
    }),
  ).not.toBe(base);
  expect(
    campaignDigest({
      ...doc,
      budget: { ...doc.budget, surcharge_formula_version: 2 },
    }),
  ).not.toBe(base);
  // Excluded: the R-REG-4 list stays invariant.
  expect(
    campaignDigest({
      ...doc,
      // Extraneous key deliberately outside CampaignSchema: proves digestInput
      // drops unknown keys along with the R-REG-4 exclusions (cast justified —
      // it only admits the extra literal key for this negative probe).
      estimates_by_arm_stripped: true as never,
      budget: { ...doc.budget, surcharge_applied: 999, priced_coverage: 0 },
      registered_at: '2030-01-01T00:00:00Z',
      registered_by: 'someone-else',
    }),
  ).toBe(base);
});
```

(If the digest test file has no `minimalCampaign` helper, copy the builder from the campaign test file into it — test files do not share fixtures in this repo.)

- [ ] **Step 9: Implement the campaign.ts amendments**

In `src/contracts/campaign/campaign.ts`:

1. Imports: add `CREDENTIAL_APIS, CREDENTIAL_AUTHS, EnvVarNameSchema` to the `../credential.ts` import.
2. After `DIGEST_RE`:

```ts
/** Round-4 S-11: every external component interpolated into a generated id —
 *  suite name, scenario name, arm name — matches this grammar. `:` is NOT a
 *  component character: it is reserved exclusively as the generated
 *  delimiter. Registration enforces this before any D3 campaign exists. */
export const ID_COMPONENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
```

3. Export `export const BlockSlotSchema = z.enum(['primary', 'reserve']);` above `BlockSchema`, and `BlockSchema` gains `slot: BlockSlotSchema.optional()` after `sample_ids` (absent reads as `'primary'` — E7.0). `BlockSlotSchema` is the single zod home for the slot vocabulary; the `CampaignUniverse`/dispatcher TS unions mirror it as plain types.
3b. In `src/contracts/campaign/suite.ts` (the spec's second declared home for the ID grammar): `SuiteSchema.name` gains `.regex(ID_COMPONENT_RE, 'suite name must satisfy the campaign ID-component grammar')` in ADDITION to the existing `NAME_RE`. The intersection of `/^[a-z0-9_]+$/` and `/^[a-z0-9][a-z0-9._-]*$/` is effectively `/^[a-z0-9]+$/` — campaign suite names are pure lowercase alphanumerics (underscores fail the ID grammar; dots/dashes fail `NAME_RE`). Rename any existing test-fixture suite names carrying `_` in `test/` accordingly (the Phase 0 simulate fixtures are the only candidates).
4. Add the contention + execution-surface schemas (Decision D-4 shape, verbatim field set):

```ts
export const HostFingerprintSchema = z
  .object({
    cpu_model: z.string().min(1),
    cpu_cores: z.number().int().positive(),
    mem_bytes: z.number().int().positive(),
    disk_total_bytes: z.number().int().positive(),
  })
  .strict();

export const ContentionThresholdSchema = z
  .object({
    metric: z.string().min(1),
    source: z.string().min(1),
    op: z.enum(['gt', 'lt']),
    value: FiniteNumberSchema.positive(),
    relative_of: z.string().min(1).optional(),
  })
  .strict();

export const ContentionDeclarationSchema = z
  .object({
    host_fingerprint: HostFingerprintSchema,
    global_run_cap: z.number().int().min(1),
    thresholds: z.array(ContentionThresholdSchema).min(1),
    cadence_ms: z.number().int().positive(),
    sustain_k: z.number().int().positive(),
    coverage_n: z.number().int().positive(),
    mem_tolerance_pct: FiniteNumberSchema.nonnegative(),
    disk_tolerance_pct: FiniteNumberSchema.nonnegative(),
  })
  .strict();
export type HostFingerprint = z.infer<typeof HostFingerprintSchema>;
export type ContentionThreshold = z.infer<typeof ContentionThresholdSchema>;
export type ContentionDeclaration = z.infer<typeof ContentionDeclarationSchema>;

/** The scrubbed, secret-free arm/credential execution surface (Blocker C
 *  intake): env-var NAMES only, never key material. */
export const ExecutionSurfaceArmSchema = z
  .object({
    name: z.string().min(1),
    agent: z.string().min(1),
    credential: z.string().min(1),
    auth: z.enum(CREDENTIAL_AUTHS),
    api: z.enum(CREDENTIAL_APIS),
    base_url: z.string().min(1).optional(),
    model: z.string().min(1),
    key_env_names: z.array(EnvVarNameSchema),
  })
  .strict();
export type ExecutionSurfaceArm = z.infer<typeof ExecutionSurfaceArmSchema>;

/** R-SPN-4 identity intake: stamped on every verdict/error/stopped path. */
export const CampaignIdentitySchema = z
  .object({
    campaign_id: z.string().min(1),
    comparison_id: z.string().min(1),
    block_id: z.string().min(1),
    sample_id: z.string().min(1),
    execution_attempt_id: z.string().min(1),
  })
  .strict();
export type CampaignIdentity = z.infer<typeof CampaignIdentitySchema>;
```

5. `PricingOverrideSchema` becomes grader-capable:

```ts
export const PricingOverrideSchema = z
  .object({
    arm: z.string().min(1).optional(),
    applies_to_grader: z.boolean().optional(),
    scenario: z.string().min(1).optional(),
    per_token_usd: FiniteNumberSchema.positive(),
    rationale: z.string().min(1),
  })
  .strict()
  .superRefine((override, ctx) => {
    const hasArm = override.arm !== undefined;
    const hasGrader = override.applies_to_grader === true;
    if (hasArm === hasGrader) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          'pricing override targets exactly one of arm or applies_to_grader: true',
      });
    }
  });
```

6. `CampaignSchema` gains, after `blocks`: `contention: ContentionDeclarationSchema`, `execution_surface: z.array(ExecutionSurfaceArmSchema)`; `budget` gains `surcharge_formula_version: z.number().int().positive()` beside `surcharge_applied`.
7. `digest.ts` — `digestInput`'s budget projection becomes:

```ts
    budget: {
      usd_all_in: campaign.budget.usd_all_in,
      // surcharge_formula_version is a digest member (absent from the R-REG-4
      // exclusion list; inclusion is the default). surcharge_applied and
      // priced_coverage stay excluded.
      surcharge_formula_version: campaign.budget.surcharge_formula_version,
    },
```

(`contention` and `execution_surface` ride the `...rest` spread — members by default.)

- [ ] **Step 10: Run contract tests to verify they pass**

Run: `bun test test/campaign-contracts-campaign.test.ts test/campaign-contracts-digest.test.ts`
Expected: PASS.

- [ ] **Commit (task 1b)**

```bash
git add src/contracts/campaign/state-machine.ts src/contracts/campaign/campaign.ts src/contracts/campaign/suite.ts src/contracts/campaign/digest.ts test/campaign-contracts-state-machine.test.ts test/campaign-contracts-campaign.test.ts test/campaign-contracts-digest.test.ts
git commit -m "feat(campaign): E7.1 re-entry edges + D3 campaign-document amendments (slot, contention, execution_surface, ID grammar)"
```

#### Task 1c: crash-windows rewrite + typed seams (Steps 11–17; covers the instance-aware fold/seal predicate R-RCV-2/R-RCV-5 consume + the `HostStatsProbe`/`ChildSpawner`/`clockNowMs` seams tasks 2/6/7/8 consume)

**Files:** modify `src/contracts/campaign/crash-windows.ts`; create `src/campaign/host-stats.ts` + `src/campaign/spawn.ts` (typed seams only); create `test/campaign-contracts-crash-windows-e7.test.ts` + `test/campaign-seams.test.ts`.

- [ ] **Step 11: Write the failing crash-window rewrite tests** — create `test/campaign-contracts-crash-windows-e7.test.ts`:

```ts
import { expect, test } from 'bun:test';
import {
  type CampaignUniverse,
  resolveCrashWindows,
  sealPredicateHolds,
} from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';

// Frozen universe: one two-arm cell, one primary block b1 (samples s1/s2),
// one reserve block x1 (samples x1s1/x1s2), cell key k = c1:scn.
const UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
    { sample_id: 'x1s1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 'x1s2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [
    { block_id: 'b1', sample_ids: ['s1', 's2'], slot: 'primary' },
    { block_id: 'x1', sample_ids: ['x1s1', 'x1s2'], slot: 'reserve' },
  ],
};

let SEQ = 0;
function ev<T extends JournalEvent['type']>(
  type: T,
  payload: unknown,
): JournalEvent {
  SEQ += 1;
  return { seq: SEQ, ts_ms: SEQ * 1000, type, payload } as JournalEvent;
}

function openAndAdmit(): JournalEvent[] {
  return [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
  ];
}

test('instance-complete seal: unactivated reserve imposes nothing; primaries must terminal', () => {
  const events = openAndAdmit();
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
  // Terminal s1+s2 via attempts; reserve x1 stays unactivated.
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 2 }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('replacement chain conservation: superseded predecessor resolves through the included superseder', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('instrument_failure', { attempt_id: 'a1', cause: 'grader_crashed' }),
    // Mint: reserve x1 activates, roster supersedes s1/s2 (same-arm).
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
    // s2 was still admitted at mint time -> excluded_block_replaced.
    ev('sample_disposition', {
      sample_id: 's2',
      disposition: 'excluded_block_replaced',
      superseded_by: 'x1s2',
    }),
    ev('block_admitted', { block_id: 'x1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 'x1s1', attempt_id: 'xa1' }),
    ev('run_allocated', { attempt_id: 'xa1', run_id: 'xr1', pgid: 3 }),
    ev('run_completed', { attempt_id: 'xa1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 'x1s2', attempt_id: 'xa2' }),
    ev('run_allocated', { attempt_id: 'xa2', run_id: 'xr2', pgid: 4 }),
    ev('run_completed', { attempt_id: 'xa2', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('an instrument_failure without its replacement/suppression/exhaustion carrier refuses seal (clause 3)', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('instrument_failure', { attempt_id: 'a1', cause: 'grader_crashed' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
  // The reserve-exhaustion carrier discharges it as named shortfall.
  events.push(
    ev('adjudication', {
      cell: 'c1:scn',
      disposition: 'reserve_exhausted',
      rationale: 'reserve_exhausted',
    }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('rerun successor-local witnesses: predecessor-era terminals never count', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 2 }),
    ev('aborted', { block_id: 'b1' }), // fans out: s1 ignore-late, s2 aborted
    // Rerun mint reusing the SAME sample ids.
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    }),
  );
  // Predecessor-era terminal for s1 must NOT discharge the successor.
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
  events.push(
    ev('block_admitted', { block_id: 'b1:i1', pools: ['p'], rerun_of: 'b1' }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a3' }),
    ev('run_allocated', { attempt_id: 'a3', run_id: 'r3', pgid: 3 }),
    ev('run_completed', { attempt_id: 'a3', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a4' }),
    ev('run_allocated', { attempt_id: 'a4', run_id: 'r4', pgid: 4 }),
    ev('run_completed', { attempt_id: 'a4', outcome: 'pass' }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(true);
});

test('a minted-but-unadmitted successor refuses seal (zero witnesses)', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    ev('aborted', { block_id: 'b1' }),
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    }),
  );
  expect(sealPredicateHolds(UNIVERSE, events)).toBe(false);
});

test('resolver override: a superseded predecessor gets no readmit/rerun action', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
    // Mint supersedes b1 BEFORE the crash; a1 never terminaled.
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
  );
  const report = resolveCrashWindows(UNIVERSE, events);
  expect(report.attempts).toEqual([]); // suppressed — recovery completes the mint instead
});

test('resolver still emits kill_pgid_rerun_block for a post-run_allocated crash without a mint', () => {
  const events = openAndAdmit();
  events.push(
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1 }),
  );
  const report = resolveCrashWindows(UNIVERSE, events);
  expect(report.attempts).toEqual([
    { attempt_id: 'a1', resolution: 'kill_pgid_rerun_block', pgid: 1 },
  ]);
});
```

- [ ] **Step 12: Rewrite `src/contracts/campaign/crash-windows.ts`**

Replace the file with the instance-aware fold. Keep the exported names (`CampaignUniverse`, `AttemptCrashWindow`, `CrashWindowReport`, `sealPredicateHolds`, `resolveCrashWindows`) — signatures unchanged, `CampaignUniverse` gains the additive optional fields:

```ts
// src/contracts/campaign/crash-windows.ts
// Crash-window resolutions + the E7.3 instance-complete seal predicate, pure
// over the frozen universe plus a journal prefix. Membership derives from
// EVENTS (universe blocks UNION mint rosters) — replay with the frozen
// document alone cannot see rerun instances. The resolver suppresses both
// actions for predecessors a block_replaced already superseded (R-RCV-5
// override); recovery completes the mint bundle instead.

import type { JournalEvent } from './journal-events.ts';
import { normalizeBlockReplaced } from './journal-events.ts';

export interface CampaignUniverse {
  readonly samples: ReadonlyArray<{
    readonly sample_id: string;
    /** Parsed Campaign provides; same-arm pairing derivation + seal checks. */
    readonly arm?: string;
    /** Parsed Campaign provides; adjudication coverage (clause 1/3). */
    readonly cell?: string;
  }>;
  readonly blocks: ReadonlyArray<{
    readonly block_id: string;
    readonly sample_ids: readonly string[];
    /** E7.0: absent means 'primary'. */
    readonly slot?: 'primary' | 'reserve';
  }>;
}

export interface AttemptCrashWindow {
  readonly attempt_id: string;
  readonly resolution: 'void_attempt_readmit' | 'kill_pgid_rerun_block';
  readonly pgid?: number;
}

export interface CrashWindowReport {
  readonly attempts: AttemptCrashWindow[];
  /** 'regenerate_report' when the instance-complete seal predicate holds
   *  but no sealed event exists (process died post-predicate pre-report). */
  readonly campaign: 'regenerate_report' | 'none';
}

interface MintRecord {
  readonly mintSeq: number;
  readonly predecessor: string;
  readonly successor: string;
  readonly kind: 'replacement' | 'rerun';
  readonly reason: string;
  readonly reserveActivation: boolean;
  readonly roster: ReadonlyArray<{
    sample_id: string;
    arm?: string;
    supersedes?: string;
  }>;
}

interface PrefixFold {
  readonly created: Set<string>;
  readonly attemptSample: Map<string, string>;
  readonly attemptCreatedSeq: Map<string, number>;
  readonly allocated: Map<string, number>;
  readonly currentAttempt: Map<string, string>;
  readonly terminalAttempts: Set<string>;
  readonly completedAttempts: Set<string>;
  readonly terminalSamples: Set<string>;
  readonly supersededSamples: Map<string, string>; // predecessor -> superseded_by
  readonly sealed: boolean;
  readonly cancelled: boolean;
  readonly mints: MintRecord[];
  readonly supersededBlocks: Set<string>;
  readonly mintBySuccessor: Map<string, MintRecord>;
  readonly rosterByBlock: Map<string, readonly string[]>;
  readonly blockAdmittedSeq: Map<string, number>;
  readonly blockTerminalSeq: Map<string, number>;
  readonly instrumentFailures: ReadonlyArray<{
    attemptId: string;
    sampleId: string;
    blockId: string;
    seq: number;
  }>;
  readonly adjudications: ReadonlyArray<{
    cell: string;
    disposition: string;
    seq: number;
  }>;
}
```

The fold pass (one switch over events; unknown ids are no-ops, never throws):

```ts
function blockOfSampleFor(
  // Only the two lineage maps — callable mid-fold before the full PrefixFold
  // is assembled (the instrument_failure arm below does exactly that).
  fold: Pick<PrefixFold, 'rosterByBlock' | 'blockAdmittedSeq'>,
  sampleId: string,
  atSeq: number,
): string | undefined {
  // The block whose admission most recently preceded the given seq among
  // blocks whose roster contains the sample (lineage-aware).
  let best: { blockId: string; seq: number } | undefined;
  for (const [blockId, roster] of fold.rosterByBlock) {
    if (!roster.includes(sampleId)) continue;
    const admitted = fold.blockAdmittedSeq.get(blockId);
    if (admitted === undefined || admitted > atSeq) continue;
    if (best === undefined || admitted > best.seq) best = { blockId, seq: admitted };
  }
  return best?.blockId;
}

function foldPrefix(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): PrefixFold {
  const rosterByBlock = new Map<string, readonly string[]>(
    universe.blocks.map((b) => [b.block_id, b.sample_ids]),
  );
  const armBySample = new Map<string, string | undefined>(
    universe.samples.map((s) => [s.sample_id, s.arm]),
  );
  const created = new Set<string>();
  const attemptSample = new Map<string, string>();
  const attemptCreatedSeq = new Map<string, number>();
  const allocated = new Map<string, number>();
  const currentAttempt = new Map<string, string>();
  const terminalAttempts = new Set<string>();
  const completedAttempts = new Set<string>();
  const terminalSamples = new Set<string>();
  const supersededSamples = new Map<string, string>();
  const mints: MintRecord[] = [];
  const supersededBlocks = new Set<string>();
  const mintBySuccessor = new Map<string, MintRecord>();
  const blockAdmittedSeq = new Map<string, number>();
  const blockTerminalSeq = new Map<string, number>();
  const instrumentFailures: PrefixFold['instrumentFailures'] = [];
  const adjudications: PrefixFold['adjudications'] = [];
  let sealed = false;
  let cancelled = false;

  for (const event of events) {
    switch (event.type) {
      case 'attempt_created':
        created.add(event.payload.attempt_id);
        attemptSample.set(event.payload.attempt_id, event.payload.sample_id);
        attemptCreatedSeq.set(event.payload.attempt_id, event.seq);
        currentAttempt.set(event.payload.sample_id, event.payload.attempt_id);
        break;
      case 'run_allocated':
        allocated.set(event.payload.attempt_id, event.payload.pgid);
        break;
      case 'run_completed':
        if (attemptSample.has(event.payload.attempt_id)) {
          terminalAttempts.add(event.payload.attempt_id);
          completedAttempts.add(event.payload.attempt_id);
        }
        break;
      case 'instrument_failure': {
        const sampleId = attemptSample.get(event.payload.attempt_id);
        if (sampleId !== undefined) {
          terminalAttempts.add(event.payload.attempt_id);
          instrumentFailures.push({
            attemptId: event.payload.attempt_id,
            sampleId,
            blockId:
              blockOfSampleFor({ rosterByBlock, blockAdmittedSeq }, sampleId, event.seq) ?? '',
            seq: event.seq,
          });
        }
        break;
      }
      case 'sample_disposition':
        if (event.payload.disposition === 'excluded_block_replaced') {
          terminalSamples.add(event.payload.sample_id);
          supersededSamples.set(
            event.payload.sample_id,
            event.payload.superseded_by,
          );
        }
        break;
      case 'slot_exhausted':
        terminalSamples.add(event.payload.sample_id);
        break;
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          terminalSamples.add(sampleId);
        }
        break;
      case 'aborted':
      case 'skew_excluded': {
        const prev = blockTerminalSeq.get(event.payload.block_id);
        if (prev === undefined || event.seq > prev) {
          blockTerminalSeq.set(event.payload.block_id, event.seq);
        }
        for (const sampleId of rosterByBlock.get(event.payload.block_id) ?? []) {
          terminalSamples.add(sampleId);
        }
        break;
      }
      case 'block_admitted': {
        const prev = blockAdmittedSeq.get(event.payload.block_id);
        if (prev === undefined || event.seq > prev) {
          blockAdmittedSeq.set(event.payload.block_id, event.seq);
        }
        break;
      }
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        let roster: MintRecord['roster'] = rec.roster;
        if (roster.length === 0) {
          // E7.2 legacy round-trip: derive same-arm pairing from membership
          // (total — one sample per arm per cell).
          const predSamples = rosterByBlock.get(rec.block_id) ?? [];
          const succSamples = rosterByBlock.get(rec.replacement_block_id) ?? [];
          roster = succSamples
            .map((sampleId) => {
              const arm = armBySample.get(sampleId);
              const pred = predSamples.find(
                (p) => armBySample.get(p) === arm,
              );
              return pred === undefined
                ? { sample_id: sampleId, ...(arm !== undefined ? { arm } : {}) }
                : {
                    sample_id: sampleId,
                    ...(arm !== undefined ? { arm } : {}),
                    supersedes: pred,
                  };
            });
        }
        const mint: MintRecord = {
          mintSeq: event.seq,
          predecessor: rec.block_id,
          successor: rec.replacement_block_id,
          kind: rec.kind,
          reason: rec.reason,
          reserveActivation: rec.reserve_activation,
          roster,
        };
        mints.push(mint);
        supersededBlocks.add(rec.block_id);
        mintBySuccessor.set(rec.replacement_block_id, mint);
        rosterByBlock.set(
          rec.replacement_block_id,
          roster.map((entry) => entry.sample_id),
        );
        for (const entry of roster) {
          if (entry.supersedes !== undefined) {
            supersededSamples.set(entry.supersedes, entry.sample_id);
          }
        }
        break;
      }
      case 'adjudication':
        adjudications.push({
          cell: event.payload.cell,
          disposition: event.payload.disposition,
          seq: event.seq,
        });
        break;
      case 'campaign_cancelled':
        cancelled = true;
        break;
      case 'sealed':
        sealed = true;
        break;
      default:
        break;
    }
  }

  return {
    created,
    attemptSample,
    attemptCreatedSeq,
    allocated,
    currentAttempt,
    terminalAttempts,
    completedAttempts,
    terminalSamples,
    supersededSamples,
    sealed,
    cancelled,
    mints,
    supersededBlocks,
    mintBySuccessor,
    rosterByBlock,
    blockAdmittedSeq,
    blockTerminalSeq,
    instrumentFailures,
    adjudications,
  };
}
```

Seal predicate (E7.3 clauses 1–5):

```ts
function sampleTerminal(fold: PrefixFold, sampleId: string): boolean {
  if (fold.terminalSamples.has(sampleId)) return true;
  const current = fold.currentAttempt.get(sampleId);
  return current !== undefined && fold.terminalAttempts.has(current);
}

/** Successor-local post-mint terminal witness (E7.1): an attempt bound to
 *  the sample, created AFTER the mint AND after the successor's own
 *  block_admitted, that reached a terminal event — or a post-mint
 *  block-terminal event naming the successor. Predecessor-era terminals
 *  never count. */
function successorSampleDischarged(
  fold: PrefixFold,
  mint: MintRecord,
  sampleId: string,
): boolean {
  const blockTerminal = fold.blockTerminalSeq.get(mint.successor);
  if (blockTerminal !== undefined && blockTerminal > mint.mintSeq) return true;
  const admitted = fold.blockAdmittedSeq.get(mint.successor);
  if (admitted === undefined) return false; // minted-but-unadmitted: zero witnesses
  for (const [attemptId, bound] of fold.attemptSample) {
    if (bound !== sampleId) continue;
    const createdSeq = fold.attemptCreatedSeq.get(attemptId) ?? Number.NEGATIVE_INFINITY;
    if (
      createdSeq > mint.mintSeq &&
      createdSeq > admitted &&
      fold.terminalAttempts.has(attemptId)
    ) {
      return true;
    }
  }
  return false;
}

function chainResolvesToIncludedTerminal(
  fold: PrefixFold,
  sampleId: string,
  depth = 0,
): boolean {
  if (depth > 64) return false; // cyclic graph is replay corruption; fail seal
  const next = fold.supersededSamples.get(sampleId);
  if (next !== undefined) return chainResolvesToIncludedTerminal(fold, next, depth + 1);
  // Not superseded: included terminal = completed via a successor-local
  // witness (post-mint where a mint applies).
  const mint = [...fold.mintBySuccessor.values()].find((m) =>
    m.roster.some((entry) => entry.sample_id === sampleId),
  );
  if (mint !== undefined) return successorSampleDischarged(fold, mint, sampleId);
  const current = fold.currentAttempt.get(sampleId);
  return current !== undefined && fold.completedAttempts.has(current);
}

function adjudicationCovers(
  fold: PrefixFold,
  cell: string | undefined,
): boolean {
  if (cell === undefined) return false;
  return fold.adjudications.some(
    (a) =>
      a.cell === cell &&
      (a.disposition === 'replacement_suppressed' ||
        a.disposition === 'reserve_exhausted'),
  );
}

export function sealPredicateHolds(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): boolean {
  const fold = foldPrefix(universe, events);
  if (universe.samples.length === 0) return false;
  const activatedReserve = new Set<string>();
  for (const block of universe.blocks) {
    if (block.slot === 'reserve' && fold.mintBySuccessor.has(block.block_id)) {
      for (const sampleId of block.sample_ids) activatedReserve.add(sampleId);
    }
  }
  const cellBySample = new Map<string, string | undefined>(
    universe.samples.map((s) => [s.sample_id, s.cell]),
  );
  // Clause 1 (+5): every frozen primary sample and every activated reserve
  // sample is accounted; budget_stopped terminals count forever (E7.6).
  for (const sample of universe.samples) {
    const isPrimaryMember = universe.blocks.some(
      (b) => b.slot !== 'reserve' && b.sample_ids.includes(sample.sample_id),
    );
    if (!isPrimaryMember && !activatedReserve.has(sample.sample_id)) continue; // clause 4
    const accounted =
      sampleTerminal(fold, sample.sample_id) ||
      chainResolvesToIncludedTerminal(fold, sample.sample_id) ||
      adjudicationCovers(fold, cellBySample.get(sample.sample_id));
    if (!accounted) return false;
  }
  // Clause 2: every activated successor discharged by successor-local,
  // post-mint witnesses regardless of admission state.
  for (const mint of fold.mints) {
    for (const entry of mint.roster) {
      if (!successorSampleDischarged(fold, mint, entry.sample_id)) return false;
    }
  }
  // Clause 3: every instrument_failure followed by its block_replaced or a
  // typed cell resolution.
  for (const failure of fold.instrumentFailures) {
    const followed =
      fold.mints.some(
        (m) => m.predecessor === failure.blockId && m.mintSeq > failure.seq,
      ) ||
      fold.adjudications.some(
        (a) =>
          a.seq > failure.seq &&
          a.cell === cellBySample.get(failure.sampleId) &&
          (a.disposition === 'replacement_suppressed' ||
            a.disposition === 'reserve_exhausted'),
      );
    if (!followed) return false;
  }
  return true;
}

export function resolveCrashWindows(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): CrashWindowReport {
  const fold = foldPrefix(universe, events);

  const attempts: AttemptCrashWindow[] = [];
  if (!fold.cancelled) {
    for (const attemptId of fold.created) {
      const sampleId = fold.attemptSample.get(attemptId);
      if (sampleId === undefined) continue;
      if (fold.currentAttempt.get(sampleId) !== attemptId) continue;
      if (sampleTerminal(fold, sampleId)) continue;
      // R-RCV-5 resolver override: a predecessor already named by a
      // block_replaced receives no readmit/rerun action — recovery completes
      // the mint bundle and resolves the minted successor instead.
      const blockId = blockOfSampleFor(
        fold,
        sampleId,
        fold.attemptCreatedSeq.get(attemptId) ?? 0,
      );
      if (blockId !== undefined && fold.supersededBlocks.has(blockId)) {
        const mint = fold.mints.find((m) => m.predecessor === blockId);
        if (
          mint !== undefined &&
          (fold.attemptCreatedSeq.get(attemptId) ?? 0) < mint.mintSeq
        ) {
          continue;
        }
      }
      const pgid = fold.allocated.get(attemptId);
      if (pgid !== undefined) {
        attempts.push({
          attempt_id: attemptId,
          resolution: 'kill_pgid_rerun_block',
          pgid,
        });
      } else {
        attempts.push({ attempt_id: attemptId, resolution: 'void_attempt_readmit' });
      }
    }
  }

  const campaign =
    !fold.sealed && !fold.cancelled && sealPredicateHolds(universe, events)
      ? 'regenerate_report'
      : 'none';
  return { attempts, campaign };
}
```

- [ ] **Step 13: Run crash-window tests to verify they pass**

Run: `bun test test/campaign-contracts-crash-windows-e7.test.ts test/campaign-contracts-state-machine.test.ts`
Expected: PASS. Then run the full contracts family: `bun test test/campaign-contracts-journal.test.ts test/campaign-contracts-digest.test.ts test/campaign-contracts-campaign.test.ts` — the campaign-schema tests that build Campaign documents will fail until the builder carries the new required fields; extend every in-test campaign builder with `contention: { host_fingerprint: { cpu_model: 'Apple M1', cpu_cores: 8, mem_bytes: 17179869184, disk_total_bytes: 494384795648 }, global_run_cap: 8, thresholds: [{ metric: 'load1_per_core', source: 'host', op: 'gt', value: 2 }], cadence_ms: 10000, sustain_k: 3, coverage_n: 4, mem_tolerance_pct: 10, disk_tolerance_pct: 10 }`, `execution_surface: []`, and `budget.surcharge_formula_version: 1`.

- [ ] **Step 14: Write the typed-seam tests** — create `test/campaign-seams.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { FakeClock } from '../src/scheduler/clock.ts';
import { clockNowMs, type HostStats, type HostStatsProbe } from '../src/campaign/host-stats.ts';
import type { CampaignChildSpec, ChildSpawner, SpawnedCampaignChild } from '../src/campaign/spawn.ts';

test('clockNowMs derives ts_ms from the seconds-based Clock seam', () => {
  const clock = new FakeClock(0);
  expect(clockNowMs(clock)).toBe(0);
  clock.advance(1.5);
  expect(clockNowMs(clock)).toBe(1500);
  clock.advance(0.0004); // 1.5004s -> 1500ms (round-half-even is fine: assert stable derivation)
  expect(clockNowMs(clock)).toBe(1500);
});

test('HostStatsProbe is injectable: a fake series drives consumers', () => {
  const series: HostStats[] = [
    {
      ts_ms: 1000,
      load1: 0.5,
      mem_available_bytes: 8 * 2 ** 30,
      mem_total_bytes: 16 * 2 ** 30,
      swap_used_bytes: 0,
      swap_total_bytes: 2 * 2 ** 30,
      process_count: 100,
      disk_free_bytes: 100 * 2 ** 30,
      disk_total_bytes: 494 * 2 ** 30,
    },
  ];
  const probe: HostStatsProbe = {
    sample: (nowMs: number) => series[0] ?? { ...series[0]!, ts_ms: nowMs },
  };
  expect(probe.sample(1000).load1).toBe(0.5);
});

test('ChildSpawner is injectable: fake children carry scripted protocol lines', () => {
  const spawned: CampaignChildSpec[] = [];
  const spawner: ChildSpawner = {
    spawn(spec: CampaignChildSpec) {
      spawned.push(spec);
      const exitCbs: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
      // A full, typed SpawnedCampaignChild plus the test's emitExit driver —
      // an intersection type, no cast.
      const handle: SpawnedCampaignChild & { emitExit(code: number): void } = {
        pid: 4242,
        stdoutLines: ['run_allocated: run-x'],
        stderrLines: [],
        onExit(cb) {
          exitCbs.push(cb);
        },
        onStdoutLine(cb) {
          for (const line of ['run_allocated: run-x']) cb(line);
        },
        onStderrLine() {},
        emitExit(code: number) {
          for (const cb of exitCbs) cb({ code, signal: null });
        },
      };
      return handle;
    },
  };
  const child = spawner.spawn({
    command: 'bun',
    args: ['run', 'evals/src/cli/index.ts', 'run', 'scn'],
    cwd: '/camp',
    env: {},
  });
  expect(spawned).toHaveLength(1);
  expect(child.pid).toBe(4242);
});
```

- [ ] **Step 15: Implement the typed seams**

Create `src/campaign/host-stats.ts`:

```ts
// The injectable host-stats probe seam (Decision D-3): preflight (task 2),
// registration fingerprint (task 5), and the contention sampler (task 7)
// share this one probe. Also the uniform ms derivation for the Clock seam:
// src/scheduler/clock.ts is SECONDS-based; every D3 millisecond field
// (journal ts_ms, sidecar lines, heartbeats, cooldowns) derives through
// clockNowMs — one Clock named uniformly, never wall-clock reads in tests.
import type { Clock } from '../scheduler/clock.ts';

export interface HostStats {
  readonly ts_ms: number;
  readonly load1: number;
  readonly mem_available_bytes: number;
  readonly mem_total_bytes: number;
  readonly swap_used_bytes: number;
  readonly swap_total_bytes: number;
  readonly process_count: number;
  readonly disk_free_bytes: number;
  readonly disk_total_bytes: number;
}

/** Injectable: tests supply scripted series; production supplies the Linux
 *  reader (task 2). A probe failure is the caller's policy (missing-sample
 *  gap line for the sampler, refusal for preflight). */
export interface HostStatsProbe {
  sample(nowMs: number): HostStats;
}

export function clockNowMs(clock: Clock): number {
  return Math.round(clock.now() * 1000);
}
```

Create `src/campaign/spawn.ts` (seam types only — production spawn lands in task 6):

```ts
// The child-spawner seam (Decision D-8): the dispatcher observes fake
// children with scripted protocol lines, exit codes, and run-dirs in tests;
// production wraps detached process-group-leader spawn (task 6). Journal FDs
// never reach children (stdio pinning — the Linux matrix asserts it).

export interface CampaignChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Inside the snapshot (R-SPN-8). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ChildExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnedCampaignChild {
  /** The dispatcher validates pgid == pid before journaling run_allocated
   *  (R-SPN-2); the production spawner guarantees detached setsid. */
  readonly pid: number;
  /** Buffered protocol surface: everything observed so far. */
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  /** Subscription for lines arriving after spawn (the parent-pinned
   *  `run_allocated: <run_id>` line; stderr feeds the sensors). */
  onStdoutLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  onExit(cb: (info: ChildExitInfo) => void): void;
}

export interface ChildSpawner {
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild;
}
```

(The Step 14 fake already implements the full interface — `onStderrLine` as a no-op — plus its `emitExit` driver through an intersection type.)

- [ ] **Step 16: Run tests to verify they pass**

Run: `bun test test/campaign-seams.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 17: Full gate + commit (task 1c)**

Run: `bun run check` and `bun run quorum check`.
Expected: green. (No scenario files touched; `quorum check` unaffected.)

```bash
git add src/contracts/campaign/crash-windows.ts src/campaign/host-stats.ts src/campaign/spawn.ts test/campaign-contracts-crash-windows-e7.test.ts test/campaign-seams.test.ts
git commit -m "feat(campaign): E7 crash-windows rewrite + D3 typed seams

Crash windows: instance-aware fold over universe + mint rosters,
successor-local seal predicate (E7.3), superseded-predecessor resolver
override. Seams: HostStatsProbe + clockNowMs, ChildSpawner types."
```

---

### Task 2: locks module + host probe (journal lease, live-spend lock, preflight)

**Files:**
- Create: `src/campaign/locks.ts`
- Modify: `src/campaign/host-stats.ts` (production Linux probe, fingerprint, resource-floor preflight, fingerprint match)
- Modify: `docs/appliance-runbook.md` (`QUORUM_LIVE_SPEND_LOCK` obligation, R-LCK-2)
- Test: create `test/campaign-locks.test.ts`, `test/campaign-host-stats.test.ts`

**Interfaces:**
- Consumes: `Clock`/`FakeClock` from `src/scheduler/clock.ts`; `clockNowMs`, `HostStats`, `HostStatsProbe` from `src/campaign/host-stats.ts` (Task 1); `getEnv` from `src/env.ts`; the D2 lock-dir discipline idiom (re-implemented here with heartbeat tokens — `withDestLock` is private to `src/campaign/provisioning.ts`, and D3's locks add heartbeat + birth identity the provisioning lock does not have).
- Produces (later tasks rely on these exact names):
  - `export class LockError extends Error`
  - `export interface ProcessIdentityProbe { exists(pid: number): 'alive' | 'esrch' | 'unknown'; startTimeMs(pid: number): number | null }` — `null` = unreadable start time = identity unknown, never dead.
  - `export const realProcessIdentityProbe: ProcessIdentityProbe` — `kill(pid, 0)`: success → `'alive'`, `ESRCH` → `'esrch'`, anything else → `'unknown'`; start time via `ps -o lstart=` through a synchronous spawn (production; recycled-pid behavior proven by the Linux matrix).
  - `export interface LockToken { readonly pid: number; readonly birth_ts_ms: number; readonly last_heartbeat_ts_ms: number }`; `formatLockToken(token): string` → the pinned body `pid\nbirth_ts_ms\nlast_heartbeat_ts_ms\n`; `parseLockToken(body): LockToken | null`.
  - `export const DEFAULT_HEARTBEAT_MS = 30_000`; `export const DEFAULT_STALE_HEARTBEAT_FACTOR = 5` (stale threshold = factor × heartbeat).
  - `export interface HeartbeatScheduler { every(ms: number, cb: () => void): () => void }`; `export const realHeartbeatScheduler: HeartbeatScheduler` — production driver: an **unref'd `setInterval`** (never holds the event loop open; a process that exits without `release()` leaves a token whose heartbeat goes stale and reclaimable — the designed crash path). Tests inject a scripted scheduler or beat manually via `heartbeat()`.
  - `export interface LeaseHandle { readonly lockPath: string; readonly ownerFile: string; heartbeat(): void; release(): void }`
  - `export function acquireLease(args: { lockPath: string; clock: Clock; identity: ProcessIdentityProbe; heartbeatMs?: number; staleFactor?: number; label: string; scheduler?: HeartbeatScheduler }): LeaseHandle` — throws `LockError` naming the live holder (pid, heartbeat age). **Starts the heartbeat driver on acquisition** (`scheduler ?? realHeartbeatScheduler`, beat = atomic token rewrite every `heartbeatMs`); `release()` cancels the driver. The journal lease (task 3), the live-spend lock held across dispatch (task 9), and the cancel path all ride this one driver — a running campaign's lock can never silently go stale and become reclaimable (REV-2 P-3).
  - `export const COVERED_BY_LOCK_ENV = 'QUORUM_COVERED_BY_LIVE_SPEND_LOCK'`; children carry it (task 6), acquisition refuses when it is set.
  - `export function defaultLiveSpendLockPath(): string` — `$QUORUM_LIVE_SPEND_LOCK` authoritative, default `$HOME/.quorum/live-spend.lock.d`.
  - `export interface LiveSpendLock extends LeaseHandle { readonly campaignId: string | null }`; `acquireLiveSpendLock(args: { lockPath?: string; campaignId?: string; clock: Clock; identity: ProcessIdentityProbe }): LiveSpendLock`; `readLiveSpendHolder(lockPath): (LockToken & { campaignId: string | null }) | null`.
  - From `host-stats.ts`: `export class PreflightError extends Error`; `export interface ResourceFloors { readonly disk_free_bytes: number; readonly mem_available_bytes: number; readonly process_headroom: number }`; `export const DEFAULT_RESOURCE_FLOORS`; `export function preflightResourceFloors(stats: HostStats, floors: ResourceFloors): void`; `export interface HostFingerprint` (the D-4 shape); `export function probeFingerprint(probe: HostStatsProbe, nowMs: number): HostFingerprint` (the probe's own diskPath already scopes disk_total_bytes); `export function assertFingerprintMatch(registered: HostFingerprint, live: HostFingerprint, tolerances: { mem_tolerance_pct: number; disk_tolerance_pct: number }): void`; `export function linuxHostStatsProbe(diskPath: string): HostStatsProbe`.

Task 2 runs as two executable sub-tasks (2a → 2b); each has its own failing-tests-first cycle, verify command, and commit.

#### Task 2a: locks module (Steps 1–3; covers R-LCK-1's lease mechanism + R-LCK-2's lock/heartbeat/identity core)

**Files:** create `src/campaign/locks.ts`; create `test/campaign-locks.test.ts`.

- [ ] **Step 1: Write the failing lock tests** — create `test/campaign-locks.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  acquireLease,
  acquireLiveSpendLock,
  COVERED_BY_LOCK_ENV,
  DEFAULT_HEARTBEAT_MS,
  defaultLiveSpendLockPath,
  formatLockToken,
  type HeartbeatScheduler,
  LockError,
  parseLockToken,
  readLiveSpendHolder,
  realHeartbeatScheduler,
  type ProcessIdentityProbe,
} from '../src/campaign/locks.ts';

class FakeIdentity implements ProcessIdentityProbe {
  private readonly states = new Map<
    number,
    { exists: 'alive' | 'esrch' | 'unknown'; startMs: number | null }
  >();
  set(pid: number, exists: 'alive' | 'esrch' | 'unknown', startMs: number | null): void {
    this.states.set(pid, { exists, startMs });
  }
  exists(pid: number): 'alive' | 'esrch' | 'unknown' {
    return this.states.get(pid)?.exists ?? 'esrch';
  }
  startTimeMs(pid: number): number | null {
    return this.states.get(pid)?.startMs ?? null;
  }
}

function tmpLockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'lock-')), 'test.lock.d');
}

const BIRTH = 1_000;
// A FOREIGN holder pid: reclamation scenarios must not share the contender's
// own pid (acquireLease reads its OWN OS birth first, so self-keyed fakes
// would trip the own-birth guard instead of the holder disposition).
const HOLDER_PID = 424_242;

function acquireFirst(lockPath: string, clock: FakeClock, identity: FakeIdentity) {
  identity.set(process.pid, 'alive', BIRTH);
  return acquireLease({ lockPath, clock, identity, label: 'test lease' });
}

/** Plant a foreign holder's token directly (no in-process lease handle). */
function plantStaleHolder(lockPath: string, lastHeartbeatMs: number): void {
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, 'owner-00000000-0000-4000-8000-000000000000'),
    formatLockToken({ pid: HOLDER_PID, birth_ts_ms: BIRTH, last_heartbeat_ts_ms: lastHeartbeatMs }),
  );
}

test('token body format is pinned: pid, birth_ts_ms, last_heartbeat_ts_ms', () => {
  const body = formatLockToken({ pid: 123, birth_ts_ms: 456, last_heartbeat_ts_ms: 789 });
  expect(body).toBe('123\n456\n789\n');
  expect(parseLockToken(body)).toEqual({
    pid: 123,
    birth_ts_ms: 456,
    last_heartbeat_ts_ms: 789,
  });
  expect(parseLockToken('garbage')).toBeNull();
  expect(parseLockToken('123\n')).toBeNull();
});

test('acquire creates the lock dir and the owner token', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  expect(existsSync(lockPath)).toBe(true);
  const entries = readdirSync(lockPath).filter((e) => e.startsWith('owner-'));
  expect(entries).toHaveLength(1);
  expect(parseLockToken(readFileSync(join(lockPath, entries[0]!), 'utf8'))).toEqual({
    pid: process.pid,
    birth_ts_ms: BIRTH,
    last_heartbeat_ts_ms: 10_000,
  });
  lease.release();
  expect(existsSync(lockPath)).toBe(false);
});

test('a live holder refuses a contender, named in the error', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  // A different process holds the lock per the token: simulate by claiming
  // the holder pid is live with a matching birth.
  const holderBody = readFileSync(
    join(lockPath, readdirSync(lockPath).find((e) => e.startsWith('owner-'))!),
    'utf8',
  );
  const holder = parseLockToken(holderBody)!;
  identity.set(holder.pid, 'alive', holder.birth_ts_ms);
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(LockError);
  lease.release();
});

test('stale heartbeat + ESRCH: reclaimed; stale heartbeat + live same-birth pid: NEVER reclaimed', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH); // the contender's own birth read
  plantStaleHolder(lockPath, 10_000); // foreign holder, heartbeat at t=10s
  // Stale heartbeat (default 5x 30s = 150s past last heartbeat).
  clock.advance(200);
  identity.set(HOLDER_PID, 'alive', BIRTH); // same birth, still alive
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(LockError); // a merely-old token with a live pid is never reclaimed
  // Now the holder dies (ESRCH) -> stale reclamation proceeds WITHOUT any
  // release: the contender severs the dead holder's lock dir and acquires.
  identity.set(HOLDER_PID, 'esrch', null);
  const second = acquireLease({ lockPath, clock, identity, label: 'test lease' });
  expect(existsSync(second.ownerFile)).toBe(true);
  second.release();
});

test('stale heartbeat + reused pid (different birth): reclaimed, replacement never signaled', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  plantStaleHolder(lockPath, 10_000);
  clock.advance(200);
  identity.set(HOLDER_PID, 'alive', BIRTH + 999_999); // PID reuse
  const second = acquireLease({ lockPath, clock, identity, label: 'test lease' });
  expect(existsSync(second.ownerFile)).toBe(true);
  second.release();
});

test('identity unknown (unreadable start time / kill error) refuses reclamation loudly', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  plantStaleHolder(lockPath, 10_000);
  clock.advance(200);
  identity.set(HOLDER_PID, 'alive', null); // unreadable start time
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(/identity unknown/i);
  identity.set(HOLDER_PID, 'unknown', null); // EPERM-class kill result
  expect(() =>
    acquireLease({ lockPath, clock, identity, label: 'test lease' }),
  ).toThrow(/identity unknown/i);
});

test('heartbeat rewrites the token atomically with a fresh last_heartbeat_ts_ms', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  const lease = acquireFirst(lockPath, clock, identity);
  clock.advance(30);
  lease.heartbeat();
  const body = readFileSync(lease.ownerFile, 'utf8');
  expect(parseLockToken(body)!.last_heartbeat_ts_ms).toBe(40_000);
  lease.release();
});

test('acquisition schedules the heartbeat: an injected scheduler beat rewrites the token; release stops the beats (timer lifecycle)', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(10);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH);
  const beats: (() => void)[] = [];
  const cancelled: boolean[] = [];
  const scheduler: HeartbeatScheduler = {
    every(ms, cb) {
      expect(ms).toBe(DEFAULT_HEARTBEAT_MS); // pinned cadence rides the driver
      beats.push(cb);
      return () => {
        cancelled.push(true);
      };
    },
  };
  const lease = acquireLease({ lockPath, clock, identity, label: 'test lease', scheduler });
  expect(beats).toHaveLength(1); // exactly one driver registered at acquisition
  // A beat at the pinned cadence rewrites the token with a fresh heartbeat —
  // this is what keeps a running campaign's lock from going stale (REV-2 P-3:
  // the P-3 fix exists so a live holder never becomes reclaimable).
  clock.advance(30);
  beats[0]!();
  expect(parseLockToken(readFileSync(lease.ownerFile, 'utf8'))!.last_heartbeat_ts_ms).toBe(40_000);
  // release() cancels the driver; a beat firing after release is a no-op.
  lease.release();
  expect(cancelled).toEqual([true]);
  beats[0]!();
  expect(existsSync(lockPath)).toBe(false);
});

test('the production heartbeat driver is an unref\'d setInterval: fires, cancels, never holds the loop open', async () => {
  let fired = 0;
  const cancel = realHeartbeatScheduler.every(5, () => {
    fired += 1;
  });
  await Bun.sleep(30);
  expect(fired).toBeGreaterThan(0);
  cancel();
  const at = fired;
  await Bun.sleep(20);
  expect(fired).toBe(at); // cancelled: no further beats
  // Process-exit semantics: the timer is unref'd, so a process that exits
  // without release() does NOT wait on the heartbeat — its token simply
  // stops beating, goes stale (5 x cadence), and becomes reclaimable under
  // the stale-heartbeat + dead-holder identity check (the designed crash
  // path; a same-birth live holder is never reclaimed).
});

test('children never acquire: the covered-by-lock env marker refuses acquisition', () => {
  process.env[COVERED_BY_LOCK_ENV] = '1';
  try {
    expect(() =>
      acquireLiveSpendLock({
        lockPath: tmpLockPath(),
        clock: new FakeClock(0),
        identity: new FakeIdentity(),
      }),
    ).toThrow(/never acquire/i);
  } finally {
    delete process.env[COVERED_BY_LOCK_ENV];
  }
});

test('live-spend lock: default path, campaign-id sidecar, holder inspection', () => {
  const lockPath = tmpLockPath();
  const clock = new FakeClock(5);
  const identity = new FakeIdentity();
  identity.set(process.pid, 'alive', BIRTH); // the acquirer's own birth read
  const lock = acquireLiveSpendLock({
    lockPath,
    campaignId: 'abc123',
    clock,
    identity,
  });
  const holder = readLiveSpendHolder(lockPath);
  expect(holder).not.toBeNull();
  expect(holder!.pid).toBe(process.pid);
  expect(holder!.campaignId).toBe('abc123');
  lock.release();
  expect(readLiveSpendHolder(lockPath)).toBeNull();
  // Default path honors the env, else user-wide.
  process.env['QUORUM_LIVE_SPEND_LOCK'] = '/tmp/custom.lock.d';
  try {
    expect(defaultLiveSpendLockPath()).toBe('/tmp/custom.lock.d');
  } finally {
    delete process.env['QUORUM_LIVE_SPEND_LOCK'];
  }
  expect(defaultLiveSpendLockPath()).toContain('.quorum/live-spend.lock.d');
});

test('two real processes contend for one lease (portable)', async () => {
  const lockPath = tmpLockPath(); // NOT pre-created: the holder child creates it
  // Holder child: acquires via this module, then sleeps holding the lease.
  const holderScript = `
    import { acquireLease } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    import { RealClock } from '${join(import.meta.dir, '..', 'src', 'scheduler', 'clock.ts')}';
    import { realProcessIdentityProbe } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    const lease = acquireLease({ lockPath: '${lockPath}', clock: new RealClock(), identity: realProcessIdentityProbe, label: 'test lease' });
    await Bun.sleep(30_000);
    lease.release();
  `;
  const child = Bun.spawn(['bun', '-e', holderScript], { stdout: 'pipe', stderr: 'pipe' });
  try {
    // Readiness = the owner token exists (guard the poll: the dir itself
    // appears only when the child's mkdir lands).
    let holderPid = 0;
    for (let i = 0; i < 100 && holderPid === 0; i++) {
      const entries = existsSync(lockPath) ? readdirSync(lockPath) : [];
      const owner = entries.find((e) => e.startsWith('owner-'));
      if (owner !== undefined) {
        holderPid = parseLockToken(readFileSync(join(lockPath, owner), 'utf8'))?.pid ?? 0;
      }
      if (holderPid === 0) await Bun.sleep(50);
    }
    expect(holderPid).toBeGreaterThan(0);
    // Contender refuses, naming the live holder. Its OWN birth must be
    // readable too (acquireLease reads it before inspecting the holder).
    const identity = new FakeIdentity();
    identity.set(process.pid, 'alive', BIRTH);
    identity.set(holderPid, 'alive', 1); // live, any birth — live is live
    expect(() =>
      acquireLease({ lockPath, clock: new FakeClock(0), identity, label: 'test lease' }),
    ).toThrow(new RegExp(String(holderPid)));
  } finally {
    child.kill();
    await child.exited.catch(() => {});
  }
});
```

**Note for the implementer:** the two-process test's holder child must acquire before the parent inspects; the owner-token poll above is the synchronization. If the child fails to start in a sandbox, skip nothing — the Linux matrix owns the full two-process matrix; this portable test exercises the same code path on the dev host.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-locks.test.ts`
Expected: FAIL — module `../src/campaign/locks.ts` not found.

- [ ] **Step 3: Implement `src/campaign/locks.ts`**

```ts
// Host-wide locking (kernel D3, R-LCK-1/2): the D2 lock-dir protocol idiom
// (atomic mkdir acquire; unforgeable owner-<uuid> token; release/reclaim
// rename-then-delete, never unlink a locked path in place) extended with
// heartbeat tokens and ESRCH/OS-birth-identity dead-holder staleness —
// mtime-only staleness is forbidden for hours-lived locks (REV-2 P-3).
// Ownership is the dispatcher process only; children are marked covered and
// never acquire.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Stats } from 'node:fs';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../scheduler/clock.ts';
import { clockNowMs } from './host-stats.ts';
import { getEnv } from '../env.ts';

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export interface ProcessIdentityProbe {
  /** kill(pid, 0): success -> 'alive'; ESRCH -> 'esrch'; anything else
   *  (EPERM, other errors) -> 'unknown'. Only 'esrch' proves no process. */
  exists(pid: number): 'alive' | 'esrch' | 'unknown';
  /** The OS-reported process start time in epoch ms; null when unreadable —
   *  identity unknown, never dead. */
  startTimeMs(pid: number): number | null;
}

export const realProcessIdentityProbe: ProcessIdentityProbe = {
  exists(pid: number): 'alive' | 'esrch' | 'unknown' {
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'esrch' : 'unknown';
    }
  },
  startTimeMs(pid: number): number | null {
    // `ps -o lstart=` prints a parseable start time on Linux + Darwin.
    const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return null;
    const ms = Date.parse(res.stdout.trim());
    return Number.isFinite(ms) ? ms : null;
  },
};

export interface LockToken {
  readonly pid: number;
  readonly birth_ts_ms: number;
  readonly last_heartbeat_ts_ms: number;
}

/** Pinned body (R-LCK-2): pid, birth_ts_ms, last_heartbeat_ts_ms. */
export function formatLockToken(token: LockToken): string {
  return `${token.pid}\n${token.birth_ts_ms}\n${token.last_heartbeat_ts_ms}\n`;
}

export function parseLockToken(body: string): LockToken | null {
  const lines = body.split('\n');
  if (lines.length < 3) return null;
  const pid = Number(lines[0]);
  const birth = Number(lines[1]);
  const hb = Number(lines[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(birth) || !Number.isInteger(hb)) {
    return null;
  }
  return { pid, birth_ts_ms: birth, last_heartbeat_ts_ms: hb };
}

export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_STALE_HEARTBEAT_FACTOR = 5;
export const COVERED_BY_LOCK_ENV = 'QUORUM_COVERED_BY_LIVE_SPEND_LOCK';

/** The heartbeat driver seam: acquisition registers exactly one beat at the
 *  pinned cadence; the beat atomically rewrites the holder's own token.
 *  Tests inject a scripted driver (or call heartbeat() manually); production
 *  uses the real timer below. */
export interface HeartbeatScheduler {
  /** Fire cb every `ms` until the returned cancel function is called. */
  every(ms: number, cb: () => void): () => void;
}

/** Production driver (R-LCK-2 heartbeat): an UNREF'D setInterval. unref is
 *  the process-exit semantics — the heartbeat never holds the event loop
 *  open, so a process that exits without release() does not wait on it; the
 *  token simply stops beating, goes stale (default 5 x cadence), and becomes
 *  reclaimable under the stale-heartbeat + dead-holder identity check (the
 *  designed crash path; REV-2 P-3). A beat that throws (our own token lost —
 *  severed underneath us) propagates as an uncaught exception: fail-stop is
 *  correct for a holder that can no longer prove ownership of the lock. */
export const realHeartbeatScheduler: HeartbeatScheduler = {
  every(ms: number, cb: () => void): () => void {
    const timer = setInterval(() => {
      cb();
    }, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};
const CAMPAIGN_ID_FILE = 'campaign-id';
const EMPTY_GRACE_MS = 100;
const POLL_MS = 50;
const OWNER_NAME_RE = /^owner-[0-9a-f-]{36}$/;

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readOwnerToken(lockPath: string): { file: string; token: LockToken } | null {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!OWNER_NAME_RE.test(name)) continue;
    try {
      const token = parseLockToken(readFileSync(join(lockPath, name), 'utf8'));
      if (token !== null) return { file: join(lockPath, name), token };
    } catch {
      // unreadable owner file: fall through to staleness handling
    }
  }
  return null;
}

/** REV-2 P-3 total identity check. Returns 'live' (refuse), 'dead' (reclaim
 *  OK), or throws LockError for identity-unknown. A same-birth live pid is
 *  never reclaimed even against a stale heartbeat; a reused pid (different
 *  birth) means the recorded holder is dead and the replacement is never
 *  signaled. */
function holderDisposition(
  token: LockToken,
  identity: ProcessIdentityProbe,
): 'live' | 'dead' {
  switch (identity.exists(token.pid)) {
    case 'esrch':
      return 'dead';
    case 'unknown':
      throw new LockError(
        `lock holder identity unknown (kill(pid,0) neither succeeded nor returned ESRCH for pid ${token.pid}) — refusing reclamation`,
      );
    case 'alive': {
      const start = identity.startTimeMs(token.pid);
      if (start === null) {
        throw new LockError(
          `lock holder identity unknown (OS start time unreadable for pid ${token.pid}) — refusing reclamation`,
        );
      }
      return start === token.birth_ts_ms ? 'live' : 'dead';
    }
  }
}

function severAndRemove(lockPath: string): void {
  const trash = `${lockPath}.trash-${randomUUID()}`;
  try {
    renameSync(lockPath, trash);
  } catch {
    return; // raced away: nothing of ours to remove
  }
  const st = tryLstat(trash);
  if (st === null) return;
  if (!st.isDirectory()) {
    try {
      rmSync(trash, { force: true }); // a swapped symlink: remove the link itself
    } catch {}
    return;
  }
  for (const name of readdirSync(trash)) {
    try {
      rmSync(join(trash, name), { force: true });
    } catch {}
  }
  try {
    rmdirSync(trash);
  } catch {}
}

export interface LeaseHandle {
  readonly lockPath: string;
  readonly ownerFile: string;
  /** Atomically rewrite this holder's token with a fresh heartbeat
   *  timestamp (pinned cadence lives at the caller). */
  heartbeat(): void;
  release(): void;
}

export interface AcquireLeaseArgs {
  readonly lockPath: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  readonly heartbeatMs?: number;
  readonly staleFactor?: number;
  /** Error-text surface: 'journal lease' | 'live-spend lock'. */
  readonly label: string;
  /** Heartbeat driver; production default is the unref'd setInterval. */
  readonly scheduler?: HeartbeatScheduler;
}

export function acquireLease(args: AcquireLeaseArgs): LeaseHandle {
  if (getEnv(COVERED_BY_LOCK_ENV) !== undefined) {
    throw new LockError(
      `${args.label}: campaign children never acquire — ${COVERED_BY_LOCK_ENV} is set; the holder's accounting covers this process`,
    );
  }
  const heartbeatMs = args.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = (args.staleFactor ?? DEFAULT_STALE_HEARTBEAT_FACTOR) * heartbeatMs;
  const { lockPath, clock, identity } = args;
  const birth = identity.startTimeMs(process.pid);
  if (birth === null) {
    throw new LockError(
      `${args.label}: cannot read this process's OS start time — refusing to take a lock whose ownership token would be unverifiable`,
    );
  }
  const ownerFile = join(lockPath, `owner-${randomUUID()}`);
  let emptySince: number | null = null;
  for (;;) {
    let created = false;
    try {
      mkdirSync(lockPath);
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (created) {
      const token: LockToken = {
        pid: process.pid,
        birth_ts_ms: birth,
        last_heartbeat_ts_ms: clockNowMs(clock),
      };
      writeFileSync(ownerFile, formatLockToken(token), { flag: 'wx' });
      const acquired = tryLstat(lockPath);
      if (acquired === null || !acquired.isDirectory()) {
        throw new LockError(`${args.label}: lock path vanished mid-acquire: ${lockPath}`);
      }
      return makeHandle(
        lockPath,
        ownerFile,
        acquired,
        token,
        clock,
        args.label,
        args.scheduler ?? realHeartbeatScheduler,
        heartbeatMs,
      );
    }
    // Contended: inspect the holder.
    const owner = readOwnerToken(lockPath);
    if (owner === null) {
      const st = tryLstat(lockPath);
      const empty = st?.isDirectory() === true && readdirSync(lockPath).length === 0;
      if (empty) {
        emptySince = emptySince ?? Date.now();
        if (Date.now() - emptySince <= EMPTY_GRACE_MS) {
          Bun.sleepSync(POLL_MS); // contender mid-acquire: poll, never touch
          continue;
        }
        severAndRemove(lockPath); // crashed mid-acquire: sever and retry
        emptySince = null;
        continue;
      }
      throw new LockError(
        `${args.label}: no parseable owner token in ${lockPath} and the dir is not mid-acquire — refusing to touch foreign lock state`,
      );
    }
    const nowMs = clockNowMs(clock);
    const heartbeatAge = nowMs - owner.token.last_heartbeat_ts_ms;
    if (heartbeatAge <= staleAfterMs) {
      throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
    }
    // Stale heartbeat — the dead-holder identity check gates reclamation.
    if (holderDisposition(owner.token, identity) === 'live') {
      throw holderRefusal(args.label, owner.token, heartbeatAge, lockPath);
    }
    severAndRemove(lockPath); // dead/reused holder: sever, retry acquire
  }
}

function holderRefusal(
  label: string,
  token: LockToken,
  heartbeatAgeMs: number,
  lockPath: string,
): LockError {
  const campaignId = readCampaignId(lockPath);
  return new LockError(
    `${label} is held by pid ${token.pid} (heartbeat ${Math.round(heartbeatAgeMs / 1000)}s old${campaignId !== null ? `, campaign ${campaignId}` : ''}) at ${lockPath} — refuse, wait, or inspect the holder`,
  );
}

function readCampaignId(lockPath: string): string | null {
  try {
    return readFileSync(join(lockPath, CAMPAIGN_ID_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function makeHandle(
  lockPath: string,
  ownerFile: string,
  acquired: Stats,
  initialToken: LockToken,
  clock: Clock,
  label: string,
  scheduler: HeartbeatScheduler,
  heartbeatMs: number,
): LeaseHandle {
  let released = false;
  let current = initialToken;
  let cancelHeartbeat: () => void = () => {};
  const handle: LeaseHandle = {
    lockPath,
    ownerFile,
    heartbeat(): void {
      if (released) throw new LockError(`${label}: heartbeat after release`);
      const fresh: LockToken = { ...current, last_heartbeat_ts_ms: clockNowMs(clock) };
      const tmp = `${ownerFile}.hb-${randomUUID()}`;
      writeFileSync(tmp, formatLockToken(fresh), { flag: 'wx' });
      renameSync(tmp, ownerFile); // atomic rewrite of our OWN token
      current = fresh;
    },
    release(): void {
      if (released) return;
      released = true;
      cancelHeartbeat(); // stop the beat BEFORE severance; a beat racing the
      // release observes `released` and does nothing
      // D2 severance discipline: confirm identity (dev+ino), rename to unique
      // trash, delete only beneath the severed name. Anything else at the
      // path (a successor's lock) is left untouched.
      const now = tryLstat(lockPath);
      if (now === null || !now.isDirectory() || now.dev !== acquired.dev || now.ino !== acquired.ino) {
        return;
      }
      severAndRemove(lockPath);
    },
  };
  // Timer lifecycle: ONE beat starts at acquisition, at the pinned cadence.
  // This is the production heartbeat — the journal writer (task 3), the
  // live-spend lock held across campaign dispatch (task 9), and every other
  // holder beat through this driver without any caller-side scheduling. A
  // beat firing after release is a no-op (the released flag guards it); a
  // beat that throws (token severed underneath us) fails the process loud —
  // a holder that cannot prove its lock must not keep spending on it.
  cancelHeartbeat = scheduler.every(heartbeatMs, () => {
    if (released) return;
    handle.heartbeat();
  });
  return handle;
}
```

Then the live-spend lock layer:

```ts
export function defaultLiveSpendLockPath(): string {
  const explicit = getEnv('QUORUM_LIVE_SPEND_LOCK');
  if (explicit !== undefined && explicit !== '') return explicit;
  const home = getEnv('HOME') ?? '';
  return join(home, '.quorum', 'live-spend.lock.d');
}

export interface LiveSpendLock extends LeaseHandle {
  readonly campaignId: string | null;
}

export function acquireLiveSpendLock(args: {
  readonly lockPath?: string;
  readonly campaignId?: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
}): LiveSpendLock {
  const lockPath = args.lockPath ?? defaultLiveSpendLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const lease = acquireLease({
    lockPath,
    clock: args.clock,
    identity: args.identity,
    label: 'live-spend lock',
  });
  if (args.campaignId !== undefined) {
    writeFileSync(join(lockPath, CAMPAIGN_ID_FILE), `${args.campaignId}\n`);
  }
  return { ...lease, campaignId: args.campaignId ?? null };
}

export function readLiveSpendHolder(
  lockPath: string,
): (LockToken & { campaignId: string | null }) | null {
  const owner = readOwnerToken(lockPath);
  if (owner === null) return null;
  return { ...owner.token, campaignId: readCampaignId(lockPath) };
}
```

- [ ] **Run + commit (task 2a)**

Run: `bun test test/campaign-locks.test.ts`
Expected: PASS.

```bash
git add src/campaign/locks.ts test/campaign-locks.test.ts
git commit -m "feat(campaign): D3 locks — journal lease + host-wide live-spend lock

D2 lock-dir idiom extended with heartbeat tokens (unref'd setInterval
driver started at acquisition, cancelled at release) and ESRCH/birth-
identity dead-holder staleness; identity-unknown refuses loudly; children
never acquire (env marker)."
```

#### Task 2b: production host probe, preflight, fingerprint + runbook (Steps 4–8; covers the R-LCK-2 preflight obligation, D-4 fingerprint match, and the runbook implementation obligation)

**Files:** modify `src/campaign/host-stats.ts` (production Linux probe, floors, fingerprint); modify `docs/appliance-runbook.md`; create `test/campaign-host-stats.test.ts`.

- [ ] **Step 4: Write the failing host-probe tests** — create `test/campaign-host-stats.test.ts`:

```ts
import { expect, test } from 'bun:test';
import {
  assertFingerprintMatch,
  DEFAULT_RESOURCE_FLOORS,
  type HostFingerprint,
  type HostStats,
  PreflightError,
  preflightResourceFloors,
} from '../src/campaign/host-stats.ts';

const GiB = 2 ** 30;

function stats(overrides: Partial<HostStats> = {}): HostStats {
  return {
    ts_ms: 0,
    load1: 0.1,
    mem_available_bytes: 8 * GiB,
    mem_total_bytes: 16 * GiB,
    swap_used_bytes: 0,
    swap_total_bytes: 2 * GiB,
    process_count: 200,
    disk_free_bytes: 100 * GiB,
    disk_total_bytes: 494 * GiB,
    ...overrides,
  };
}

test('preflight passes above floors and fails loud beneath each floor', () => {
  expect(() => preflightResourceFloors(stats(), DEFAULT_RESOURCE_FLOORS)).not.toThrow();
  expect(() =>
    preflightResourceFloors(stats({ disk_free_bytes: 1 }), DEFAULT_RESOURCE_FLOORS),
  ).toThrow(PreflightError);
  expect(() =>
    preflightResourceFloors(stats({ mem_available_bytes: 1 }), DEFAULT_RESOURCE_FLOORS),
  ).toThrow(/memory/i);
  expect(() =>
    preflightResourceFloors(
      stats({ process_count: 1_000_000 }),
      { ...DEFAULT_RESOURCE_FLOORS, process_headroom: 256 },
    ),
  ).toThrow(/process|pid/i);
});

const FP: HostFingerprint = {
  cpu_model: 'Apple M1',
  cpu_cores: 8,
  mem_bytes: 16 * GiB,
  disk_total_bytes: 494 * GiB,
};

test('fingerprint match: exact cpu_model + cpu_cores; tolerance bands on mem/disk', () => {
  expect(() => assertFingerprintMatch(FP, { ...FP }, { mem_tolerance_pct: 10, disk_tolerance_pct: 10 })).not.toThrow();
  // CPU drift refuses loudly (names both fingerprints).
  expect(() =>
    assertFingerprintMatch(FP, { ...FP, cpu_model: 'AMD EPYC' }, { mem_tolerance_pct: 10, disk_tolerance_pct: 10 }),
  ).toThrow(/Apple M1.*AMD EPYC|fingerprint/i);
  expect(() =>
    assertFingerprintMatch(FP, { ...FP, cpu_cores: 16 }, { mem_tolerance_pct: 10, disk_tolerance_pct: 10 }),
  ).toThrow(PreflightError);
  // Mem within 10% ok; outside refuses.
  expect(() =>
    assertFingerprintMatch(FP, { ...FP, mem_bytes: 15 * GiB }, { mem_tolerance_pct: 10, disk_tolerance_pct: 10 }),
  ).not.toThrow();
  expect(() =>
    assertFingerprintMatch(FP, { ...FP, mem_bytes: 8 * GiB }, { mem_tolerance_pct: 10, disk_tolerance_pct: 10 }),
  ).toThrow(PreflightError);
});
```

- [ ] **Step 5: Implement the host-stats additions** — extend `src/campaign/host-stats.ts`: add these imports to the file's top import block (the file created in Task 1 imports only `../scheduler/clock.ts`), then append the rest below `clockNowMs`:

```ts
import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** Production probe (Decision D-3 metric sources): load1 via os.loadavg();
 *  memory via os.freemem/totalmem; swap + process count via /proc (Linux);
 *  disk via statfs on the campaign/results volume. The v1 designated host is
 *  the Linux appliance — other platforms fail closed (workstation use of the
 *  blessed bundle is forbidden by policy). */
export function linuxHostStatsProbe(diskPath: string): HostStatsProbe {
  return {
    sample(nowMs: number): HostStats {
      if (process.platform !== 'linux') {
        throw new PreflightError(
          `host stats probe requires the Linux appliance (got ${process.platform}) — portable tests inject a fake probe`,
        );
      }
      const meminfo = readMeminfo();
      const fs = statfsSync(diskPath);
      return {
        ts_ms: nowMs,
        load1: loadavg()[0] ?? 0,
        mem_available_bytes: freemem(),
        mem_total_bytes: totalmem(),
        swap_used_bytes: Math.max(0, meminfo.swapTotal - meminfo.swapFree),
        swap_total_bytes: meminfo.swapTotal,
        process_count: readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n)).length,
        disk_free_bytes: fs.bavail * fs.bsize,
        disk_total_bytes: fs.blocks * fs.bsize,
      };
    },
  };
}

function readMeminfo(): { swapTotal: number; swapFree: number } {
  const text = readFileSync('/proc/meminfo', 'utf8');
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m === null ? 0 : Number(m[1]) * 1024;
  };
  return { swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

export interface ResourceFloors {
  readonly disk_free_bytes: number;
  readonly mem_available_bytes: number;
  readonly process_headroom: number;
}

/** Drafted defaults (flagged for gate challenge — the parent pins the
 *  obligation, not the numbers). */
export const DEFAULT_RESOURCE_FLOORS: ResourceFloors = {
  disk_free_bytes: 2 * 2 ** 30,
  mem_available_bytes: 1 * 2 ** 30,
  process_headroom: 256,
};

/** Drafted PID-table ceiling for the headroom computation (flagged for gate
 *  challenge): refuse when the live process count leaves less than
 *  process_headroom slots beneath this ceiling. */
export const PID_MAX_SLOTS = 1_000_000;

export function preflightResourceFloors(stats: HostStats, floors: ResourceFloors): void {
  const violations: string[] = [];
  if (stats.disk_free_bytes < floors.disk_free_bytes) {
    violations.push(
      `disk free ${stats.disk_free_bytes} < floor ${floors.disk_free_bytes}`,
    );
  }
  if (stats.mem_available_bytes < floors.mem_available_bytes) {
    violations.push(
      `available memory ${stats.mem_available_bytes} < floor ${floors.mem_available_bytes}`,
    );
  }
  if (stats.process_count > PID_MAX_SLOTS - floors.process_headroom) {
    violations.push(
      `process count ${stats.process_count} leaves < ${floors.process_headroom} PID headroom beneath ${PID_MAX_SLOTS}`,
    );
  }
  if (violations.length > 0) {
    throw new PreflightError(
      `resource-floor preflight failed: ${violations.join('; ')} — refuse launch (fail-closed)`,
    );
  }
}

// The fingerprint shape is the contract's (campaign.ts HostFingerprintSchema,
// Task 1) — re-exported here so probes and registration share one type.
export type { HostFingerprint } from '../contracts/campaign/campaign.ts';
import type { HostFingerprint } from '../contracts/campaign/campaign.ts';

export function probeFingerprint(
  probe: HostStatsProbe,
  nowMs: number,
): HostFingerprint {
  const stats = probe.sample(nowMs);
  const cpu = cpus();
  return {
    cpu_model: cpu[0]?.model ?? 'unknown',
    cpu_cores: cpu.length,
    mem_bytes: stats.mem_total_bytes,
    disk_total_bytes: stats.disk_total_bytes,
  };
}

/** Decision D-4 fingerprint-match policy: exact match on cpu_model and
 *  cpu_cores; registered tolerance bands on mem_bytes/disk_total_bytes
 *  (hardware replacement within tolerance is the same host; outside is a
 *  new host → new campaign). */
export function assertFingerprintMatch(
  registered: HostFingerprint,
  live: HostFingerprint,
  tolerances: { mem_tolerance_pct: number; disk_tolerance_pct: number },
): void {
  const mismatches: string[] = [];
  if (registered.cpu_model !== live.cpu_model) {
    mismatches.push(`cpu_model registered=${registered.cpu_model} live=${live.cpu_model}`);
  }
  if (registered.cpu_cores !== live.cpu_cores) {
    mismatches.push(`cpu_cores registered=${registered.cpu_cores} live=${live.cpu_cores}`);
  }
  const memDriftPct =
    (Math.abs(live.mem_bytes - registered.mem_bytes) / registered.mem_bytes) * 100;
  if (memDriftPct > tolerances.mem_tolerance_pct) {
    mismatches.push(
      `mem_bytes drift ${memDriftPct.toFixed(1)}% > tolerance ${tolerances.mem_tolerance_pct}% (registered=${registered.mem_bytes} live=${live.mem_bytes})`,
    );
  }
  const diskDriftPct =
    (Math.abs(live.disk_total_bytes - registered.disk_total_bytes) / registered.disk_total_bytes) * 100;
  if (diskDriftPct > tolerances.disk_tolerance_pct) {
    mismatches.push(
      `disk_total_bytes drift ${diskDriftPct.toFixed(1)}% > tolerance ${tolerances.disk_tolerance_pct}% (registered=${registered.disk_total_bytes} live=${live.disk_total_bytes})`,
    );
  }
  if (mismatches.length > 0) {
    throw new PreflightError(
      `host fingerprint mismatch — registered {${registered.cpu_model}, ${registered.cpu_cores}c} vs live {${live.cpu_model}, ${live.cpu_cores}c}: ${mismatches.join('; ')} — v1 host migration is a new campaign (refuse, fail-closed)`,
    );
  }
}
```

(Replace the `require('node:fs')` line inside `readMeminfo` with the top-level `readFileSync` import already in the import list — the file imports `readdirSync, statfsSync` from `node:fs`; extend that import to include `readFileSync`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/campaign-host-stats.test.ts`
Expected: PASS. Then `bun run check`.

- [ ] **Step 7: Runbook obligation (R-LCK-2)**

Edit `docs/appliance-runbook.md`: in the environment/lock section (read the file first; append to the section that documents appliance env), add:

```markdown
### Host-wide live-spend lock (kernel D3)

`campaign run`, `run-all`, and direct `quorum run` contend for ONE host-wide
lock. `$QUORUM_LIVE_SPEND_LOCK` is authoritative; production appliance
deployments set it to the appliance-owned shared path so containerized jobs
and break-glass host runs share one lock:

    export QUORUM_LIVE_SPEND_LOCK=/var/lib/quorum/live-spend.lock.d

The default (env unset) is user-wide: `$HOME/.quorum/live-spend.lock.d`.
Holder tokens carry `pid`, `birth_ts_ms`, `last_heartbeat_ts_ms` and
heartbeat every 30s; reclamation requires a stale heartbeat (5× cadence)
AND a dead holder under the ESRCH + OS-start-time identity check.
```

- [ ] **Step 8: Commit (task 2b)**

```bash
git add src/campaign/host-stats.ts test/campaign-host-stats.test.ts docs/appliance-runbook.md
git commit -m "feat(campaign): D3 host probe — floors preflight + fingerprint match

Production Linux host-stats probe; resource-floor preflight + D-4
fingerprint match policy (refuse fail-closed, v1 host migration is a new
campaign); QUORUM_LIVE_SPEND_LOCK documented in the appliance runbook."
```

---

### Task 3: journal module + marker-file publication

**Files:**
- Create: `src/campaign/journal.ts`
- Test: create `test/campaign-journal.test.ts`, `test/campaign-journal-replay.test.ts`, `test/campaign-journal-publication.test.ts`

**Interfaces:**
- Consumes: `JournalEvent`, `JournalEventSchema`, `JournalEventType`, `normalizeBlockReplaced`, `readRunAllocatedGrants` from `src/contracts/campaign/journal-events.ts`; `applySampleEvent`, `applyCampaignEvent`, `type SampleState`, `type CampaignState` from `src/contracts/campaign/state-machine.ts`; `type CampaignUniverse` from `src/contracts/campaign/crash-windows.ts`; `type Campaign` from `src/contracts/campaign/campaign.ts`; `jcsCanonicalize` from `src/contracts/campaign/digest.ts`; `acquireLease`, `type ProcessIdentityProbe` from `src/campaign/locks.ts` (Task 2); `clockNowMs`, `Clock` (Tasks 1/2); `Database` from `bun:sqlite`.
- Produces (later tasks rely on these exact names):
  - `export const JOURNAL_SCHEMA_VERSION = 1`; `export const JOURNAL_DB_FILENAME = 'journal.db'`; `export const JOURNAL_LEASE_DIR = 'journal.lease.d'`
  - `export class JournalError extends Error`; `export class WriterDeposedError extends JournalError`; `export class JournalCorruptionError extends JournalError`
  - `export function initJournalDb(campaignDir: string): void` — schema + `meta.schema_version` + `meta.writer_generation = 0`
  - `export interface EventInput { readonly type: JournalEventType; readonly payload: unknown; readonly ts_ms?: number }`
  - `export interface ElectWriterArgs { readonly campaignDir: string; readonly clock: Clock; readonly identity: ProcessIdentityProbe; readonly campaign?: Campaign; readonly restrict?: readonly JournalEventType[] }`
  - `export function electWriter(args: ElectWriterArgs): JournalWriter` — takes the lease, bumps `writer_generation` in-transaction
  - `export class JournalWriter { readonly generation: number; appendEvent(input: EventInput): JournalEvent; appendEvents(inputs: readonly EventInput[]): JournalEvent[]; readEvents(afterSeq?: number): JournalEvent[]; readBudgetPosition(): { spend_usd: number; estimate_inflight_usd: number }; checkpoint(): void; release(): void }` — `release()` checkpoints + releases the lease; `restrict` mode refuses any event type outside the list (sealer: `['adjudication', 'sealed']`, R-JRN-3)
  - `export function openJournalRead(campaignDir: string): { readEvents(afterSeq?: number): JournalEvent[]; close(): void }` — readers never write, never checkpoint
  - `export interface ReplayState { ... }` (below); `export function replayEvents(universe: CampaignUniverse, events: readonly JournalEvent[]): ReplayState` — the pinned routing table (Decision D-7)
  - `export function rebuildMaterialized(writer: JournalWriter, universe: CampaignUniverse): void` — drop + replay (byte-identical, twice)
  - Publication primitives: `export const DEFAULT_BALLAST_BYTES = 8 * 1024 * 1024`; `export function createBallast(campaignDir: string, sizeBytes: number): void`; `export function verifyBallast(campaignDir: string, sizeBytes: number): boolean`; `export function releaseBallast(campaignDir: string): void`; `export function fsyncDir(dir: string): void`; `export function stageAndPublishCampaignJson(campaignDir: string, campaign: unknown): void` (serializes; registration passes the full Campaign)
  - `export function isStorageFullError(err: unknown): boolean` — the D-13 step-1 detection predicate: SQLITE_FULL from a `bun:sqlite` commit or ENOSPC from an fs write (by `code` or message shape). The dispatcher's `appendCritical` and sampler `onSampleError` hook (Task 8) are its two production callers, both entering `performStoragePause`.

Task 3 runs as three executable sub-tasks (3a → 3b → 3c), all growing `src/campaign/journal.ts`; each has its own failing-tests-first cycle, verify command, and commit.

#### Task 3a: journal store + fenced writer (Steps 1–4; covers R-JRN-1/2/3/4/5/6/8/9/12 and R-LCK-1's election use)

**Files:** create `src/campaign/journal.ts` (store, election, fenced append, ordered read, budget position); create `test/campaign-journal.test.ts`.

- [ ] **Step 1: Write the failing journal-core tests** — create `test/campaign-journal.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  electWriter,
  initJournalDb,
  JOURNAL_DB_FILENAME,
  openJournalRead,
  WriterDeposedError,
  type JournalWriter,
} from '../src/campaign/journal.ts';

class LocalIdentity implements ProcessIdentityProbe {
  exists(): 'alive' {
    return 'alive';
  }
  startTimeMs(): number {
    return 1; // stable local birth — single-process tests
  }
}

function camp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'camp-'));
  initJournalDb(dir);
  return dir;
}

function writer(dir: string, clock = new FakeClock(1)): JournalWriter {
  return electWriter({ campaignDir: dir, clock, identity: new LocalIdentity() });
}

const OPENED = {
  type: 'campaign_opened' as const,
  payload: { campaign_id: 'c1', digest: 'd'.repeat(64) },
};

test('initJournalDb creates the db with schema_version and writer_generation rows', () => {
  const dir = camp();
  expect(existsSync(join(dir, JOURNAL_DB_FILENAME))).toBe(true);
  const w = writer(dir);
  expect(w.readEvents()).toEqual([]);
  w.release();
});

test('appendEvent validates against the D1 schemas, assigns seq + ts_ms from the Clock seam', () => {
  const dir = camp();
  const clock = new FakeClock(1);
  const w = writer(dir, clock);
  const first = w.appendEvent(OPENED);
  expect(first).toEqual({ seq: 1, ts_ms: 1000, type: 'campaign_opened', payload: OPENED.payload });
  clock.advance(1);
  const second = w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  expect(second.seq).toBe(2);
  expect(second.ts_ms).toBe(2000);
  // Malformed payload is a loud programming error, never a silent drop.
  expect(() => w.appendEvent({ type: 'block_admitted', payload: { block_id: '' } })).toThrow();
  w.release();
});

test('PRAGMAs on the writer connection are pinned (WAL / FULL / busy_timeout=0)', () => {
  const dir = camp();
  const w = writer(dir);
  // Inspect through a separate read connection sharing the WAL db.
  const { Database } = require('bun:sqlite');
  const db = new Database(join(dir, JOURNAL_DB_FILENAME));
  expect(db.query('PRAGMA journal_mode').get().journal_mode).toBe('wal');
  expect(db.query('PRAGMA synchronous').get().synchronous).toBe(2); // FULL
  db.close();
  w.release();
});

test('deposed-writer fencing: A gen 1, B gen 2 — A fails loudly, B unaffected, sequence gapless', () => {
  const dir = camp();
  const a = writer(dir);
  a.appendEvent(OPENED);
  expect(a.generation).toBe(1);
  // A's lease lapses (crash simulation): B takes the lease and is elected.
  a.abandonLease(); // test helper: releases the lease WITHOUT checkpointing
  const b = writer(dir);
  expect(b.generation).toBe(2);
  const b1 = b.appendEvent({ type: 'block_admitted', payload: { block_id: 'b1', pools: ['p'] } });
  expect(() => a.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } })).toThrow(
    WriterDeposedError,
  );
  const b2 = b.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } });
  expect([b1.seq, b2.seq]).toEqual([2, 3]); // gapless
  b.release();
});

test('readEvents cursor exclusivity: seq > afterSeq, no gaps, no re-reads', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  w.appendEvent({ type: 'block_admitted', payload: { block_id: 'b1', pools: ['p'] } });
  w.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } });
  expect(w.readEvents().map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(w.readEvents(1).map((e) => e.seq)).toEqual([2, 3]);
  expect(w.readEvents(3)).toEqual([]);
  const reader = openJournalRead(dir);
  expect(reader.readEvents(2).map((e) => e.seq)).toEqual([3]);
  reader.close();
  w.release();
});

test('attempts.spawn_gap_ms materializes run_allocated.ts_ms - attempt_created.ts_ms (honest spawn-gap)', () => {
  const dir = camp();
  const clock = new FakeClock(1);
  const w = writer(dir, clock);
  w.appendEvent(OPENED);
  w.appendEvent({ type: 'block_admitted', payload: { block_id: 'b1', pools: ['p'] } });
  w.appendEvent({ type: 'attempt_created', payload: { sample_id: 's1', attempt_id: 'a1' } });
  clock.advance(2.5);
  w.appendEvent({
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 9, key_grants: [{ role: 'subject', env: 'K' }] },
  });
  const row = w.readAttempt('a1');
  expect(row.spawn_gap_ms).toBe(2500); // labeled spawn-gap in every surface (Decision D-2)
  expect(JSON.parse(row.key_grants ?? '[]')).toEqual([{ role: 'subject', env: 'K' }]);
  w.release();
});

test('budget position is absolute-total: latest estimate_inflight supersedes, spend increments', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  w.appendEvent({ type: 'budget_event', payload: { kind: 'estimate_inflight', amount_usd: 10 } });
  w.appendEvent({ type: 'budget_event', payload: { kind: 'spend', amount_usd: 9 } });
  w.appendEvent({ type: 'budget_event', payload: { kind: 'estimate_inflight', amount_usd: 0 } });
  expect(w.readBudgetPosition()).toEqual({ spend_usd: 9, estimate_inflight_usd: 0 });
  w.release();
});

test('sealer restriction: a restricted writer appends only adjudication + sealed', () => {
  const dir = camp();
  const w = writer(dir);
  w.appendEvent(OPENED);
  w.release();
  const sealer = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
    restrict: ['adjudication', 'sealed'],
  });
  expect(() =>
    sealer.appendEvent({ type: 'block_admitted', payload: { block_id: 'b1', pools: ['p'] } }),
  ).toThrow(/sealer|restricted/i);
  sealer.appendEvent({
    type: 'adjudication',
    payload: { cell: 'c1:scn', disposition: 'reserve_exhausted', rationale: 'reserve_exhausted' },
  });
  sealer.release();
});
```

(`abandonLease()` and `readAttempt(attemptId)` are JournalWriter members the implementation exposes — `abandonLease` releases the lease without checkpoint (crash simulation for tests and recovery), `readAttempt` reads one `attempts` row.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-journal.test.ts`
Expected: FAIL — module `../src/campaign/journal.ts` not found.

- [ ] **Step 3: Implement the journal store and writer** — create `src/campaign/journal.ts`:

```ts
// The campaign journal (kernel D3, R-JRN-1..12): SQLite at
// <campaignDir>/journal.db, one writer elected via the journal.lease.d lock
// (Task 2) plus in-transaction writer_generation fencing — a deposed-but-
// alive writer's next append fails loudly. One transaction per event
// (fsync per event): BEGIN IMMEDIATE -> fencing check -> INSERT + projection
// updates -> COMMIT. PRAGMAs pinned on every writer connection. Payloads are
// JCS-canonical JSON of the D1 payload objects; envelopes validate against
// the D1 schemas before append (unknown type / malformed payload = loud
// programming error, never a silent drop).
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../scheduler/clock.ts';
import { clockNowMs } from './host-stats.ts';
import { acquireLease, type LeaseHandle, type ProcessIdentityProbe } from './locks.ts';
import type { Campaign } from '../contracts/campaign/campaign.ts';
import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import {
  type JournalEvent,
  JournalEventSchema,
  type JournalEventType,
} from '../contracts/campaign/journal-events.ts';

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_DB_FILENAME = 'journal.db';
export const JOURNAL_LEASE_DIR = 'journal.lease.d';
export const DEFAULT_BALLAST_BYTES = 8 * 1024 * 1024;

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}
export class WriterDeposedError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = 'WriterDeposedError';
  }
}
export class JournalCorruptionError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks(
  block_id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL,
  state TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'primary',
  instance_of TEXT,
  mint_seq INTEGER,
  reserve_activation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS block_rosters(
  block_id TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  supersedes TEXT,
  PRIMARY KEY(block_id, sample_id)
);
CREATE TABLE IF NOT EXISTS attempts(
  attempt_id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT,
  pgid INTEGER,
  key_grants TEXT,
  spawn_gap_ms INTEGER,
  UNIQUE(run_id)
);
CREATE TABLE IF NOT EXISTS pools(pool_key TEXT PRIMARY KEY, blocked_until_ms INTEGER);
CREATE TABLE IF NOT EXISTS spend(
  seq INTEGER PRIMARY KEY REFERENCES events(seq),
  kind TEXT NOT NULL,
  amount_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS amendments(
  seq INTEGER PRIMARY KEY REFERENCES events(seq),
  amount_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS adjudications(
  seq INTEGER PRIMARY KEY REFERENCES events(seq),
  cell TEXT NOT NULL,
  disposition TEXT NOT NULL,
  rationale TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quarantine(
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT
);
`;

function writerPragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 0');
}

export function initJournalDb(campaignDir: string): void {
  mkdirSync(campaignDir, { recursive: true });
  const db = new Database(join(campaignDir, JOURNAL_DB_FILENAME), { create: true });
  try {
    writerPragmas(db);
    db.exec(SCHEMA_SQL);
    db.exec('BEGIN IMMEDIATE');
    db.query(
      'INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)',
    ).run('schema_version', String(JOURNAL_SCHEMA_VERSION));
    db.query(
      'INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)',
    ).run('writer_generation', '0');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function checkSchemaVersion(db: Database): void {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | null;
  if (row === null || row.value !== String(JOURNAL_SCHEMA_VERSION)) {
    throw new JournalError(
      `journal schema_version ${row === null ? '<missing>' : row.value} != ${JOURNAL_SCHEMA_VERSION} — refusing to open (fail-closed)`,
    );
  }
}

export interface EventInput {
  readonly type: JournalEventType;
  readonly payload: unknown;
  readonly ts_ms?: number;
}

export interface ElectWriterArgs {
  readonly campaignDir: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  /** The frozen campaign document: membership for block fan-out and
   *  attempt->block resolution. Absent only during registration's
   *  publication phase (campaign.json does not exist yet). */
  readonly campaign?: Campaign;
  /** Sealer mode (R-JRN-3): only the listed event types may append. */
  readonly restrict?: readonly JournalEventType[];
}
```

The writer class (lease + fencing + projection maintenance). Projection maintenance shares one router with replay (Step 6 implements `replayEvents`; the writer maintains the SAME projections inline against sqlite):

```ts
/** The materialized attempts row (matches the attempts DDL exactly). */
export interface AttemptRow {
  readonly attempt_id: string;
  readonly sample_id: string;
  readonly block_id: string;
  readonly state: string;
  readonly run_id: string | null;
  readonly pgid: number | null;
  readonly key_grants: string | null;
  readonly spawn_gap_ms: number | null;
}

export class JournalWriter {
  readonly generation: number;
  private readonly db: Database;
  private readonly lease: LeaseHandle;
  private readonly clock: Clock;
  private readonly restrict: readonly JournalEventType[] | undefined;
  private readonly campaign: Campaign | undefined;
  /** Incremental membership: universe blocks ∪ mint rosters (E7). */
  private readonly rosters = new Map<string, string[]>();
  private readonly attemptCreatedTs = new Map<string, number>();
  private readonly blockComparison = new Map<string, string>();
  private released = false;

  private constructor(args: ElectWriterArgs, lease: LeaseHandle, generation: number) {
    this.clock = args.clock;
    this.restrict = args.restrict;
    this.campaign = args.campaign;
    this.lease = lease;
    this.generation = generation;
    this.db = new Database(join(args.campaignDir, JOURNAL_DB_FILENAME));
    writerPragmas(this.db);
    checkSchemaVersion(this.db);
    if (this.campaign !== undefined) {
      for (const block of this.campaign.blocks) {
        this.rosters.set(block.block_id, [...block.sample_ids]);
        this.blockComparison.set(block.block_id, block.comparison_id);
      }
    }
    // Replay existing events to rebuild in-memory membership (resumes).
    for (const event of this.readEvents()) {
      this.foldMembership(event);
    }
  }

  static elect(args: ElectWriterArgs): JournalWriter {
    const lease = acquireLease({
      lockPath: join(args.campaignDir, JOURNAL_LEASE_DIR),
      clock: args.clock,
      identity: args.identity,
      label: 'journal lease',
    });
    const db = new Database(join(args.campaignDir, JOURNAL_DB_FILENAME));
    let generation = 0;
    try {
      writerPragmas(db);
      checkSchemaVersion(db);
      db.exec('BEGIN IMMEDIATE');
      const row = db
        .query('SELECT value FROM meta WHERE key = ?')
        .get('writer_generation') as { value: string };
      generation = Number(row.value) + 1;
      db.query('UPDATE meta SET value = ? WHERE key = ?').run(
        String(generation),
        'writer_generation',
      );
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    return new JournalWriter(args, lease, generation);
  }

  appendEvent(input: EventInput): JournalEvent {
    const appended = this.appendEvents([input]);
    const first = appended[0];
    if (first === undefined) throw new JournalError('appendEvents returned no event for a one-event append');
    return first;
  }

  /** One dispatch critical section: each event keeps R-JRN-4's
   *  one-event transaction, appended in order, nothing interleaving. */
  appendEvents(inputs: readonly EventInput[]): JournalEvent[] {
    if (this.released) throw new JournalError('writer released');
    const out: JournalEvent[] = [];
    for (const input of inputs) {
      if (this.restrict !== undefined && !this.restrict.includes(input.type)) {
        throw new JournalError(
          `restricted writer (sealer) refused event type ${input.type} — only ${this.restrict.join(', ')} may append`,
        );
      }
      out.push(this.appendOne(input));
    }
    return out;
  }

  private appendOne(input: EventInput): JournalEvent {
    const ts_ms = input.ts_ms ?? clockNowMs(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const gen = (
        this.db.query('SELECT value FROM meta WHERE key = ?').get('writer_generation') as {
          value: string;
        }
      ).value;
      if (Number(gen) !== this.generation) {
        this.db.exec('ROLLBACK');
        throw new WriterDeposedError(
          `journal writer deposed: generation ${this.generation} != meta ${gen} — a newer writer holds the lease; refusing to interleave`,
        );
      }
      const seqRow = this.db.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as {
        seq: number;
      };
      const seq = seqRow.seq + 1;
      const envelope = JournalEventSchema.parse({ seq, ts_ms, ...input });
      this.db
        .query('INSERT INTO events(seq, ts_ms, type, payload) VALUES (?, ?, ?, ?)')
        .run(seq, ts_ms, envelope.type, jcsCanonicalize(envelope.payload));
      this.project(envelope);
      this.db.exec('COMMIT');
      this.foldMembership(envelope);
      return envelope;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }
  // ... foldMembership, project, readEvents, readAttempt, readBudgetPosition,
  //     checkpoint, abandonLease, release — below
}

export function electWriter(args: ElectWriterArgs): JournalWriter {
  return JournalWriter.elect(args);
}
```

Membership fold + projection maintenance + read surface (same class, continued):

```ts
  private foldMembership(event: JournalEvent): void {
    switch (event.type) {
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        const roster =
          rec.roster.length > 0
            ? rec.roster.map((entry) => entry.sample_id)
            : (this.rosters.get(rec.replacement_block_id) ?? []);
        this.rosters.set(rec.replacement_block_id, [...roster]);
        const comparison = this.blockComparison.get(rec.block_id);
        if (comparison !== undefined) {
          this.blockComparison.set(rec.replacement_block_id, comparison);
        }
        break;
      }
      case 'attempt_created':
        this.attemptCreatedTs.set(event.payload.attempt_id, event.ts_ms);
        break;
      default:
        break;
    }
  }

  /** Projection maintenance (mirrors replayEvents routing, Decision D-7).
   *  Runs INSIDE the append transaction. */
  private project(event: JournalEvent): void {
    const db = this.db;
    switch (event.type) {
      case 'block_admitted': {
        const comparison = this.blockComparison.get(event.payload.block_id) ?? '';
        db.query(
          `INSERT INTO blocks(block_id, comparison_id, state, slot, instance_of, mint_seq, reserve_activation)
           VALUES (?, ?, 'admitted', 'primary', NULL, NULL, 0)
           ON CONFLICT(block_id) DO UPDATE SET state = 'admitted'`,
        ).run(event.payload.block_id, comparison);
        const roster = this.rosters.get(event.payload.block_id) ?? [];
        for (const sampleId of roster) {
          this.upsertSampleAttemptBlock(sampleId, event.payload.block_id);
        }
        break;
      }
      case 'attempt_created':
        db.query(
          `INSERT INTO attempts(attempt_id, sample_id, block_id, state)
           VALUES (?, ?, ?, 'created')`,
        ).run(
          event.payload.attempt_id,
          event.payload.sample_id,
          this.blockOfSample(event.payload.sample_id) ?? '',
        );
        break;
      case 'run_allocated': {
        const createdTs = this.attemptCreatedTs.get(event.payload.attempt_id);
        const spawnGap = createdTs === undefined ? null : event.ts_ms - createdTs;
        db.query(
          `UPDATE attempts SET state = 'allocated', run_id = ?, pgid = ?, key_grants = ?, spawn_gap_ms = ?
           WHERE attempt_id = ?`,
        ).run(
          event.payload.run_id,
          event.payload.pgid,
          JSON.stringify(readRunAllocatedGrants(event.payload)),
          spawnGap,
          event.payload.attempt_id,
        );
        break;
      }
      case 'exposure_started':
        this.setAttemptStateBySample(event.payload.sample_id, 'exposed');
        break;
      case 'run_completed':
        db.query(`UPDATE attempts SET state = 'completed' WHERE attempt_id = ?`).run(
          event.payload.attempt_id,
        );
        break;
      case 'instrument_failure':
        db.query(`UPDATE attempts SET state = 'instrument_failed' WHERE attempt_id = ?`).run(
          event.payload.attempt_id,
        );
        break;
      case 'sample_disposition':
        if (event.payload.disposition === 'excluded_block_replaced') {
          this.setAttemptStateBySample(event.payload.sample_id, 'excluded_block_replaced');
        }
        break;
      case 'slot_exhausted':
        this.setAttemptStateBySample(event.payload.sample_id, 'exhausted');
        break;
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          this.setAttemptStateBySample(sampleId, 'budget_stopped');
        }
        break;
      case 'aborted':
        this.setBlockState(event.payload.block_id, 'aborted');
        break;
      case 'skew_excluded':
        this.setBlockState(event.payload.block_id, 'skew_excluded');
        break;
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        this.setBlockState(rec.block_id, 'replaced');
        const comparison = this.blockComparison.get(rec.block_id) ?? '';
        const roster = this.rosters.get(rec.replacement_block_id) ?? [];
        db.query(
          `INSERT INTO blocks(block_id, comparison_id, state, slot, instance_of, mint_seq, reserve_activation)
           VALUES (?, ?, 'minted', ?, ?, ?, ?)
           ON CONFLICT(block_id) DO UPDATE SET state = 'minted', mint_seq = excluded.mint_seq`,
        ).run(
          rec.replacement_block_id,
          comparison,
          rec.kind === 'replacement' ? 'reserve' : 'primary',
          rec.block_id,
          event.seq,
          rec.reserve_activation ? 1 : 0,
        );
        for (const entry of rec.roster) {
          db.query(
            `INSERT OR REPLACE INTO block_rosters(block_id, sample_id, arm, supersedes) VALUES (?, ?, ?, ?)`,
          ).run(rec.replacement_block_id, entry.sample_id, entry.arm, entry.supersedes ?? null);
        }
        if (rec.roster.length === 0) {
          for (const sampleId of roster) {
            db.query(
              `INSERT OR REPLACE INTO block_rosters(block_id, sample_id, arm, supersedes) VALUES (?, ?, '', NULL)`,
            ).run(rec.replacement_block_id, sampleId);
          }
        }
        break;
      }
      case 'pool_blocked':
        db.query(
          `INSERT INTO pools(pool_key, blocked_until_ms) VALUES (?, ?)
           ON CONFLICT(pool_key) DO UPDATE SET blocked_until_ms = excluded.blocked_until_ms`,
        ).run(event.payload.pool_key, event.payload.until_ts_ms);
        break;
      case 'budget_event':
        db.query('INSERT INTO spend(seq, kind, amount_usd) VALUES (?, ?, ?)').run(
          event.seq,
          event.payload.kind,
          event.payload.amount_usd,
        );
        break;
      case 'amendment':
        db.query('INSERT INTO amendments(seq, amount_usd) VALUES (?, ?)').run(
          event.seq,
          event.payload.amount_usd,
        );
        break;
      case 'adjudication':
        db.query('INSERT INTO adjudications(seq, cell, disposition, rationale) VALUES (?, ?, ?, ?)').run(
          event.seq,
          event.payload.cell,
          event.payload.disposition,
          event.payload.rationale,
        );
        break;
      case 'quarantined':
        db.query(
          'INSERT OR REPLACE INTO quarantine(run_id, attempt_id, reason) VALUES (?, ?, ?)',
        ).run(event.payload.run_id, event.payload.attempt_id ?? null, event.payload.reason);
        break;
      case 'campaign_opened':
      case 'campaign_cancelled':
      case 'storage_paused':
      case 'sealed':
        break; // campaign-scoped: state-machine carries them; no projection
      default:
        throw new JournalError(`no projection for event type ${(event as JournalEvent).type}`);
    }
  }

  private blockOfSample(sampleId: string): string | undefined {
    for (const [blockId, roster] of this.rosters) {
      if (roster.includes(sampleId)) return blockId;
    }
    return undefined;
  }

  private setBlockState(blockId: string, state: string): void {
    this.db
      .query('UPDATE blocks SET state = ? WHERE block_id = ?')
      .run(state, blockId);
  }

  private setAttemptStateBySample(sampleId: string, state: string): void {
    this.db
      .query(
        `UPDATE attempts SET state = ? WHERE attempt_id = (
           SELECT attempt_id FROM attempts WHERE sample_id = ? ORDER BY rowid DESC LIMIT 1)`,
      )
      .run(state, sampleId);
  }

  private upsertSampleAttemptBlock(_sampleId: string, _blockId: string): void {
    // attempts.block_id resolves at attempt_created time via blockOfSample;
    // admission-time membership is carried by foldMembership/rosters.
  }

  readEvents(afterSeq = 0): JournalEvent[] {
    const rows = this.db
      .query('SELECT seq, ts_ms, type, payload FROM events WHERE seq > ? ORDER BY seq')
      .all(afterSeq) as Array<{ seq: number; ts_ms: number; type: string; payload: string }>;
    return rows.map((row) =>
      JournalEventSchema.parse({
        seq: row.seq,
        ts_ms: row.ts_ms,
        type: row.type,
        payload: JSON.parse(row.payload),
      }),
    );
  }

  readAttempt(attemptId: string): AttemptRow {
    const row = this.db
      .query('SELECT * FROM attempts WHERE attempt_id = ?')
      .get(attemptId);
    if (row === null) throw new JournalError(`unknown attempt ${attemptId}`);
    // DB-boundary cast to the concrete row shape (bun:sqlite returns
    // unknown); the attempts DDL above pins these exact columns.
    return row as AttemptRow;
  }

  /** E7.7: position = Σ spend + latest estimate_inflight (0 before the first
   *  estimate). Deterministic over the event stream. */
  readBudgetPosition(): { spend_usd: number; estimate_inflight_usd: number } {
    const spend = (
      this.db
        .query(`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend WHERE kind = 'spend'`)
        .get() as { total: number }
    ).total;
    const latest = this.db
      .query(
        `SELECT amount_usd FROM spend WHERE kind = 'estimate_inflight' ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { amount_usd: number } | null;
    return { spend_usd: spend, estimate_inflight_usd: latest?.amount_usd ?? 0 };
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Crash simulation / recovery: drop the lease WITHOUT checkpointing. */
  /** Test/crash-simulation helper: give up the LEASE ONLY — the writer does
   *  not learn it was deposed (no released flag, db stays open), so its next
   *  append must fail on the in-transaction generation FENCE, exactly like a
   *  deposed-but-alive writer whose lease a successor reclaimed. */
  abandonLease(): void {
    this.lease.release();
  }

  release(): void {
    if (this.released) return;
    this.checkpoint(); // writers checkpoint at session end (Decision D-7)
    this.released = true;
    this.db.close();
    this.lease.release();
  }
```

The read-only view (R-JRN-3: readers never write, never checkpoint, never take the lease — a live writer keeps its lease while status/cancel polls read):

```ts
export function openJournalRead(campaignDir: string): {
  readEvents(afterSeq?: number): JournalEvent[];
  close(): void;
} {
  const db = new Database(join(campaignDir, JOURNAL_DB_FILENAME), { readonly: true });
  checkSchemaVersion(db);
  return {
    readEvents(afterSeq = 0): JournalEvent[] {
      const rows = db
        .query('SELECT seq, ts_ms, type, payload FROM events WHERE seq > ? ORDER BY seq')
        .all(afterSeq) as Array<{ seq: number; ts_ms: number; type: string; payload: string }>;
      return rows.map((row) =>
        JournalEventSchema.parse({
          seq: row.seq,
          ts_ms: row.ts_ms,
          type: row.type,
          payload: JSON.parse(row.payload),
        }),
      );
    },
    close(): void {
      db.close();
    },
  };
}
```

Add the missing imports used above: `normalizeBlockReplaced`, `readRunAllocatedGrants` from `../contracts/campaign/journal-events.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-journal.test.ts`
Expected: PASS (8 tests).

- [ ] **Commit (task 3a)**

```bash
git add src/campaign/journal.ts test/campaign-journal.test.ts
git commit -m "feat(campaign): D3 journal store — lease-elected fenced writer, one-event transactions"
```

#### Task 3b: routed replay + materialized tables (Steps 5–7; covers R-JRN-7/10/11 and the Decision D-7 routing table)

**Files:** modify `src/campaign/journal.ts` (append `replayEvents` + `rebuildMaterialized`); create `test/campaign-journal-replay.test.ts`.

- [ ] **Step 5: Write the failing replay tests** — create `test/campaign-journal-replay.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  electWriter,
  initJournalDb,
  JournalCorruptionError,
  rebuildMaterialized,
  replayEvents,
} from '../src/campaign/journal.ts';
import type { CampaignUniverse } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';

const UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'], slot: 'primary' }],
};

let SEQ = 0;
function ev(type: JournalEvent['type'], payload: unknown): JournalEvent {
  SEQ += 1;
  return { seq: SEQ, ts_ms: SEQ * 1000, type, payload } as JournalEvent;
}

test('routing table: sample-scoped events apply per named sample; block_replaced never touches the sample reducer', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    }),
  ];
  const state = replayEvents(UNIVERSE, events);
  expect(state.campaignState).toBe('running');
  expect(state.sampleStates.get('s1')).toBe('admitted'); // fan-out admitted it
  // The mint recorded the instance chain + roster without reducer calls:
  expect(state.rosters.get('b1:i1')).toEqual([
    { sample_id: 's1', arm: 'base' },
    { sample_id: 's2', arm: 'treat' },
  ]);
});

test('routing table: cross-machine rejects BY DESIGN are not corruption; misrouted garbage IS', () => {
  // pool_blocked is accounting-class: applying it to a sample would reject in
  // the reducer by design — replay routes it to projections only, no error.
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('pool_blocked', { pool_key: 'p', until_ts_ms: 9 }),
  ];
  expect(() => replayEvents(UNIVERSE, events)).not.toThrow();
  // Corruption: run_allocated naming an attempt that was never created.
  const corrupt = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('run_allocated', { attempt_id: 'ghost', run_id: 'r1', pgid: 1 }),
  ];
  expect(() => replayEvents(UNIVERSE, corrupt)).toThrow(JournalCorruptionError);
});

// The same membership as UNIVERSE in Campaign-document form: the writer's
// incremental projection resolves attempt->block through it exactly as the
// rebuild resolves through UNIVERSE. (Fixture-literal cast justified: only
// the membership fields the writer's fold reads are populated.)
const CAMPAIGN_DOC = {
  blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1', 's2'] }],
  samples: [
    { sample_id: 's1', cell: 'c1:scn', arm: 'base', replicate: 1 },
    { sample_id: 's2', cell: 'c1:scn', arm: 'treat', replicate: 1 },
  ],
} as unknown as import('../src/contracts/campaign/campaign.ts').Campaign;

test('replay determinism: rebuild materialized tables twice — byte-identical; incremental == rebuilt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'camp-'));
  initJournalDb(dir);
  const identity: ProcessIdentityProbe = { exists: () => 'alive', startTimeMs: () => 1 };
  const w = electWriter({ campaignDir: dir, clock: new FakeClock(1), identity, campaign: CAMPAIGN_DOC });
  w.appendEvent({ type: 'campaign_opened', payload: { campaign_id: 'c', digest: 'd'.repeat(64) } });
  w.appendEvent({ type: 'block_admitted', payload: { block_id: 'b1', pools: ['p'] } });
  w.appendEvent({ type: 'attempt_created', payload: { sample_id: 's1', attempt_id: 'a1' } });
  w.appendEvent({
    type: 'run_allocated',
    payload: { attempt_id: 'a1', run_id: 'r1', pgid: 5, key_grants: [] },
  });
  const incremental = w.snapshotTables(); // serialized dump of all projections
  rebuildMaterialized(w, UNIVERSE);
  const rebuiltOnce = w.snapshotTables();
  rebuildMaterialized(w, UNIVERSE);
  const rebuiltTwice = w.snapshotTables();
  expect(rebuiltOnce).toBe(rebuiltTwice); // byte-identical across rebuilds
  expect(rebuiltOnce).toBe(incremental); // incremental == rebuilt
  w.release();
});

test('storage-pause derivation: first activity after storage_paused resumes running (R-JRN-11)', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('storage_paused', {}),
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
  ];
  expect(replayEvents(UNIVERSE, events).campaignState).toBe('running');
});

test('quarantined is binding-only: projection row, no state change, never reject', () => {
  const events = [
    ev('campaign_opened', { campaign_id: 'c', digest: 'd'.repeat(64) }),
    ev('quarantined', { run_id: 'orphan', reason: 'attempt_mismatch' }),
  ];
  const state = replayEvents(UNIVERSE, events);
  expect(state.quarantine.get('orphan')).toEqual({
    run_id: 'orphan',
    attempt_id: undefined,
    reason: 'attempt_mismatch',
  });
});
```

(`snapshotTables()` is a JournalWriter member: a deterministic string dump of every projection table, ordered — used only by tests and rebuild verification.)

- [ ] **Step 6: Implement `replayEvents` + `rebuildMaterialized`** — append to `src/campaign/journal.ts`:

```ts
import {
  applyCampaignEvent,
  applySampleEvent,
  type CampaignState,
  type JournalEventInput,
  type SampleState,
} from '../contracts/campaign/state-machine.ts';
import { normalizeBlockReplaced, readRunAllocatedGrants } from '../contracts/campaign/journal-events.ts';
import type { CampaignUniverse } from '../contracts/campaign/crash-windows.ts';

export interface ReplayState {
  campaignState: CampaignState;
  readonly sampleStates: Map<string, SampleState>;
  readonly blockStates: Map<string, string>;
  readonly rosters: Map<string, { sample_id: string; arm: string; supersedes?: string }[]>;
  readonly mintSeqBySuccessor: Map<string, number>;
  readonly supersededBlocks: Set<string>;
  readonly quarantine: Map<string, { run_id: string; attempt_id?: string; reason: string }>;
  readonly budget: { spend_usd: number; estimate_inflight_usd: number };
}

/** The pinned replay routing table (Decision D-7): a reject is corruption
 *  ONLY after correct routing. Sample-scoped -> applySampleEvent per named
 *  sample; block fan-out over universe blocks ∪ E7 mint rosters; block_
 *  replaced -> instance-chain + roster projections ONLY (never the sample
 *  reducer); campaign-scoped -> applyCampaignEvent; accounting ->
 *  projections only. quarantined -> quarantine projection only. */
export function replayEvents(
  universe: CampaignUniverse,
  events: readonly JournalEvent[],
): ReplayState {
  const sampleStates = new Map<string, SampleState>();
  const blockStates = new Map<string, string>();
  const rosters = new Map<string, { sample_id: string; arm: string; supersedes?: string }[]>();
  const mintSeqBySuccessor = new Map<string, number>();
  const supersededBlocks = new Set<string>();
  const quarantine = new Map<string, { run_id: string; attempt_id?: string; reason: string }>();
  let campaignState: CampaignState = 'registered';
  let spend = 0;
  let estimate = 0;

  const attemptSample = new Map<string, string>(); // attempt_created bindings
  for (const block of universe.blocks) {
    const armBySample = new Map(universe.samples.map((s) => [s.sample_id, s.arm ?? '']));
    rosters.set(
      block.block_id,
      block.sample_ids.map((sampleId) => ({
        sample_id: sampleId,
        arm: armBySample.get(sampleId) ?? '',
      })),
    );
  }
  const ensureSample = (sampleId: string): void => {
    if (!sampleStates.has(sampleId)) sampleStates.set(sampleId, 'planned');
  };
  const stateOf = (sampleId: string): SampleState => sampleStates.get(sampleId) ?? 'planned';
  const membershipOf = (blockId: string): string[] =>
    (rosters.get(blockId) ?? []).map((entry) => entry.sample_id);
  /** Attempt-scoped events name an attempt; the sample rides the binding.
   *  An attempt never created in this stream is corruption (correct
   *  routing already happened). */
  const sampleOfAttempt = (event: JournalEvent, attemptId: string): string => {
    const sampleId = attemptSample.get(attemptId);
    if (sampleId === undefined) {
      throw new JournalCorruptionError(
        `${event.type} (seq ${event.seq}) names attempt ${attemptId} never bound by attempt_created — corruption`,
      );
    }
    return sampleId;
  };

  for (const event of events) {
    const input: JournalEventInput = { type: event.type, payload: event.payload } as JournalEventInput;
    // R-JRN-11 derivation: activity events double as the campaign-state
    // signal (storage_paused -> running on the first activity; running stays
    // running). The SHIPPED campaign reducer owns the edge — no second
    // implementation here.
    if (
      (campaignState === 'storage_paused' || campaignState === 'running') &&
      (event.type === 'block_admitted' || event.type === 'attempt_created' || event.type === 'budget_event')
    ) {
      const derived = applyCampaignEvent(campaignState, event.type);
      if (derived.result === 'apply') campaignState = derived.next;
    }
    switch (event.type) {
      case 'attempt_created':
        attemptSample.set(event.payload.attempt_id, event.payload.sample_id);
        ensureSample(event.payload.sample_id);
        sampleStates.set(
          event.payload.sample_id,
          applyOrCorrupt(event, stateOf(event.payload.sample_id), event.payload.sample_id, input),
        );
        break;
      case 'run_allocated':
      case 'run_completed':
      case 'instrument_failure': {
        const sampleId = sampleOfAttempt(event, event.payload.attempt_id);
        sampleStates.set(sampleId, applyOrCorrupt(event, stateOf(sampleId), sampleId, input));
        break;
      }
      case 'exposure_started':
      case 'sample_disposition':
      case 'slot_exhausted': {
        const sampleId = event.payload.sample_id;
        ensureSample(sampleId);
        sampleStates.set(sampleId, applyOrCorrupt(event, stateOf(sampleId), sampleId, input));
        break;
      }
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          ensureSample(sampleId);
          sampleStates.set(sampleId, applyOrCorrupt(event, stateOf(sampleId), sampleId, input));
        }
        break;
      case 'block_admitted':
      case 'aborted':
      case 'skew_excluded': {
        const members = membershipOf(event.payload.block_id);
        if (members.length === 0) {
          throw new JournalCorruptionError(
            `${event.type} (seq ${event.seq}) names unknown block ${event.payload.block_id} — no frozen or minted membership`,
          );
        }
        for (const sampleId of members) {
          ensureSample(sampleId);
          const outcome = applySampleEvent(stateOf(sampleId), input);
          if (outcome.result === 'apply') sampleStates.set(sampleId, outcome.next);
          if (outcome.result === 'reject') {
            throw new JournalCorruptionError(
              `${event.type} (seq ${event.seq}) REJECT from ${sampleStates.get(sampleId)} for sample ${sampleId} — routed correctly, so this is corruption`,
            );
          }
          // ignore-late: recorded-but-non-mutating (R-JRN-7)
        }
        blockStates.set(
          event.payload.block_id,
          event.type === 'block_admitted' ? 'admitted' : event.type,
        );
        break;
      }
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        supersededBlocks.add(rec.block_id);
        mintSeqBySuccessor.set(rec.replacement_block_id, event.seq);
        if (rec.roster.length > 0) {
          rosters.set(rec.replacement_block_id, [...rec.roster]);
        } else {
          // Legacy round-trip: absent roster -> membership carries over
          // (same samples); supersedes stays underived here (replay derives
          // same-arm pairing where a reader needs it — E7.2 legacy rule).
          const predRoster = rosters.get(rec.block_id) ?? [];
          rosters.set(
            rec.replacement_block_id,
            predRoster.map((entry) => ({ sample_id: entry.sample_id, arm: entry.arm })),
          );
        }
        blockStates.set(rec.block_id, 'replaced');
        blockStates.set(rec.replacement_block_id, 'minted');
        break; // NEVER fanned through applySampleEvent (Decision D-7)
      }
      case 'campaign_opened':
      case 'campaign_cancelled':
      case 'storage_paused':
      case 'sealed': {
        const outcome = applyCampaignEvent(campaignState, event.type);
        if (outcome.result === 'reject') {
          throw new JournalCorruptionError(
            `campaign-scoped ${event.type} (seq ${event.seq}) rejected from ${campaignState} — corruption`,
          );
        }
        campaignState = outcome.next;
        break;
      }
      case 'pool_blocked':
        break; // projections only (accounting class)
      case 'budget_event':
        if (event.payload.kind === 'spend') spend += event.payload.amount_usd;
        else estimate = event.payload.amount_usd; // absolute-total supersession (E7.7)
        break;
      case 'amendment':
      case 'adjudication':
        break; // projections only
      case 'quarantined':
        quarantine.set(event.payload.run_id, {
          run_id: event.payload.run_id,
          ...(event.payload.attempt_id !== undefined
            ? { attempt_id: event.payload.attempt_id }
            : {}),
          reason: event.payload.reason,
        });
        break;
      default:
        throw new JournalCorruptionError(`unknown event type at seq ${event.seq}`);
    }
  }

  return {
    campaignState,
    sampleStates,
    blockStates,
    rosters,
    mintSeqBySuccessor,
    supersededBlocks,
    quarantine,
    budget: { spend_usd: spend, estimate_inflight_usd: estimate },
  };
}

/** apply = advance; ignore-late = unchanged; reject after correct routing is
 *  corruption (R-JRN-7). Returns the state to store. */
function applyOrCorrupt(
  event: JournalEvent,
  state: SampleState,
  sampleId: string,
  input: JournalEventInput,
): SampleState {
  const outcome = applySampleEvent(state, input);
  if (outcome.result === 'reject') {
    throw new JournalCorruptionError(
      `${event.type} (seq ${event.seq}) REJECT from ${state} for sample ${sampleId} — routed correctly, so this is corruption`,
    );
  }
  return outcome.result === 'apply' ? outcome.next : state;
}
```

`rebuildMaterialized` (tests and rebuild verification call the writer's `snapshotTables()` member directly — no wrapper export):

```ts
export function rebuildMaterialized(writer: JournalWriter, universe: CampaignUniverse): void {
  writer.rebuildProjectionsFrom(universe); // DROPs projection tables, re-applies events via project()
}
```

(Implementation note: `rebuildProjectionsFrom(universe)` runs inside one transaction: DELETE FROM each projection table, reset the in-memory membership maps from `universe`, then re-fold + re-project every row of `events` in seq order via `foldMembership` + `project`. `snapshotTables()` dumps each projection table as `table=JSON(rows ordered by primary key)` lines joined by `\n` — deterministic by construction.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/campaign-journal-replay.test.ts test/campaign-journal.test.ts`
Expected: PASS.

- [ ] **Commit (task 3b)**

```bash
git add src/campaign/journal.ts test/campaign-journal-replay.test.ts
git commit -m "feat(campaign): D3 journal replay — pinned D-7 routing, rebuildable materialized tables"
```

#### Task 3c: publication primitives + storage-full detection (Steps 8–11; covers the P-4/S-8 publication order, D-13's ballast + `isStorageFullError` detection predicate)

**Files:** modify `src/campaign/journal.ts` (append ballast/publication primitives + `isStorageFullError`); create `test/campaign-journal-publication.test.ts`.

- [ ] **Step 8: Write the failing publication tests** — create `test/campaign-journal-publication.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
  initJournalDb,
  isStorageFullError,
  JournalError,
  releaseBallast,
  stageAndPublishCampaignJson,
  verifyBallast,
} from '../src/campaign/journal.ts';

function tmpCampaign(): string {
  return mkdtempSync(join(tmpdir(), 'pub-'));
}

test('ballast: non-sparse, fully written, fsynced, allocated blocks cover the length', () => {
  const dir = tmpCampaign();
  createBallast(dir, 64 * 1024);
  const path = join(dir, '.ballast');
  const st = statSync(path);
  expect(st.size).toBe(64 * 1024);
  // Non-sparse: allocated 512-byte blocks cover the length.
  expect(st.blocks * 512).toBeGreaterThanOrEqual(64 * 1024);
  // Content is non-zero buffers (never truncate-only).
  const body = readFileSync(path);
  expect(body.some((b) => b !== 0)).toBe(true);
  expect(verifyBallast(dir, 64 * 1024)).toBe(true);
  expect(verifyBallast(dir, 128 * 1024)).toBe(false); // wrong size refuses
});

test('publication: campaign.json staged as campaign.json.stage.<pid> then renamed LAST', () => {
  const dir = tmpCampaign();
  const doc = { digest: 'd'.repeat(64) }; // the publisher takes unknown and serializes
  stageAndPublishCampaignJson(dir, doc);
  expect(existsSync(join(dir, 'campaign.json'))).toBe(true);
  expect(readdirSync(dir).filter((n) => n.startsWith('campaign.json.stage.'))).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8'))).toEqual(doc);
  // A second publication refuses (publication happens exactly once).
  expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
});

test('the pinned P-4/S-8 order: journal init -> ballast -> campaign.json rename last', () => {
  const dir = tmpCampaign();
  // (1) journal initialized at the final path, campaign_opened journaled;
  initJournalDb(dir);
  // (2) ballast created + fsynced BEFORE publication;
  createBallast(dir, DEFAULT_BALLAST_BYTES);
  // (3) campaign.json renamed LAST = readiness marker.
  stageAndPublishCampaignJson(dir, { schema_version: 1 });
  const order = readdirSync(dir);
  expect(order).toContain('journal.db');
  expect(order).toContain('.ballast');
  expect(order).toContain('campaign.json');
});

test('releaseBallast unlinks and fsyncs the directory (D-13 pause path)', () => {
  const dir = tmpCampaign();
  createBallast(dir, 64 * 1024);
  releaseBallast(dir);
  expect(existsSync(join(dir, '.ballast'))).toBe(false);
  expect(() => releaseBallast(dir)).toThrow(JournalError); // absent ballast is loud
});

test('isStorageFullError: SQLITE_FULL and ENOSPC shapes match; anything else does not (D-13 detection)', () => {
  expect(isStorageFullError(Object.assign(new Error('commit failed'), { code: 'SQLITE_FULL' }))).toBe(true);
  expect(isStorageFullError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true);
  expect(isStorageFullError(new Error('database or disk is full'))).toBe(true); // bun:sqlite message shape
  expect(isStorageFullError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }))).toBe(false);
  expect(isStorageFullError(new Error('locked'))).toBe(false);
  expect(isStorageFullError(null)).toBe(false);
  expect(isStorageFullError('ENOSPC')).toBe(false); // a bare string is not an error shape
});
```

- [ ] **Step 9: Implement the publication primitives** — append to `src/campaign/journal.ts`:

```ts
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

/** Decision D-13 ballast: physically allocated, operator-visible, created +
 *  fsynced BEFORE campaign.json publication. Non-sparse: open exclusively,
 *  write non-zero buffers through the entire length (never truncate-only),
 *  fsync the file, verify allocated blocks cover the length, then fsync the
 *  campaign directory. Failure or an unverifiable allocation refuses
 *  publication. */
export function createBallast(campaignDir: string, sizeBytes: number): void {
  const path = join(campaignDir, '.ballast');
  let fd: number;
  try {
    fd = openSync(path, 'wx'); // O_EXCL: never overwrite an existing ballast
  } catch (err) {
    throw new JournalError(
      `ballast already exists or cannot be created at ${path}: ${(err as Error).message}`,
    );
  }
  try {
    const chunk = Buffer.alloc(64 * 1024, 0xba); // non-zero
    let written = 0;
    while (written < sizeBytes) {
      const n = Math.min(chunk.length, sizeBytes - written);
      writeSync(fd, chunk, 0, n);
      written += n;
    }
    fsyncSync(fd); // durable BEFORE the allocation check
  } finally {
    closeSync(fd);
  }
  if (!verifyBallast(campaignDir, sizeBytes)) {
    try {
      unlinkSync(path);
    } catch {}
    throw new JournalError(
      `ballast allocation unverifiable at ${path} (sparse or short filesystem?) — refusing publication (fail-closed)`,
    );
  }
  fsyncDir(campaignDir);
}

export function verifyBallast(campaignDir: string, sizeBytes: number): boolean {
  try {
    const st = statSync(join(campaignDir, '.ballast'));
    return st.size === sizeBytes && st.blocks * 512 >= sizeBytes;
  } catch {
    return false;
  }
}

/** D-13 pause step 3: release the ballast (unlink, fsync dir) so the freed
 *  blocks land the pause evidence. Absence is loud (the reserve was already
 *  spent — recovery journals that note). */
export function releaseBallast(campaignDir: string): void {
  const path = join(campaignDir, '.ballast');
  if (!existsSync(path)) {
    throw new JournalError(`no ballast to release at ${path} — reserve already spent`);
  }
  unlinkSync(path);
  fsyncDir(campaignDir);
}

/** D-13 step-1 detection predicate: a storage-full failure from either
 *  store — SQLITE_FULL from a bun:sqlite commit, or ENOSPC from an fs write
 *  (the sampler's sidecar append plausibly hits the full volume first).
 *  Matched by error `code` first, message shape as the fallback (bun:sqlite
 *  surfaces "database or disk is full"). Production callers: the
 *  dispatcher's appendCritical and its sampler onSampleError hook (task 8),
 *  both entering performStoragePause. */
export function isStorageFullError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /SQLITE_FULL|database or disk is full|ENOSPC/.test(message);
}

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Decision D-7 publication: stage campaign.json as campaign.json.stage.<pid>
 *  (fsync), rename into place LAST, fsync the campaign directory. The rename
 *  is the readiness marker — a crash before it leaves an explicitly
 *  incomplete, non-runnable directory (Decision D-6/S-8). */
export function stageAndPublishCampaignJson(campaignDir: string, campaign: unknown): void {
  if (existsSync(join(campaignDir, 'campaign.json'))) {
    throw new JournalError(
      `campaign.json already published at ${campaignDir} — publication happens exactly once; re-entry verifies, never republishes`,
    );
  }
  const stage = join(campaignDir, `campaign.json.stage.${process.pid}`);
  const fd = openSync(stage, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(campaign, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, join(campaignDir, 'campaign.json')); // rename last
  fsyncDir(campaignDir); // directory fsync after the publication rename
}
```

(`linkSync` in the import list is unused — drop it from the imports.)

- [ ] **Step 10: Run tests to verify they pass**

Run: `bun test test/campaign-journal-publication.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 11: Full gate + commit (task 3c)**

Run: `bun run check` and `bun run quorum check`.
Expected: green.

```bash
git add src/campaign/journal.ts test/campaign-journal-publication.test.ts
git commit -m "feat(campaign): D3 journal publication — ballast + staged campaign.json + storage-full detection

P-4/S-8 publication order (fsynced non-sparse ballast, campaign.json
staged + renamed last, dir fsync); isStorageFullError (SQLITE_FULL/ENOSPC)
as the D-13 step-1 detection predicate the dispatcher's two sites call."
```

---

### Task 4: snapshot integration, reconstruction + refs cross-check

**Files:**
- Create: `src/campaign/snapshot.ts`
- Test: create `test/campaign-snapshot.test.ts`

**Interfaces:**
- Consumes: `materializeSuperpowersWorktree` from `src/campaign/provisioning.ts`; `materializeEvalsSnapshot`, `reconstructSnapshot`, `verifySnapshot`, `SnapshotDriftError`, `type SnapshotHandle` from `src/campaign/instrument-snapshot.ts` (D2); `type Campaign` from `src/contracts/campaign/campaign.ts`; `CommandRunner` from `src/agents/command-runner.ts`.
- Produces (tasks 5, 8, 9 rely on these exact names):
  - `export class SnapshotIntegrationError extends Error`
  - `export interface MaterializeCampaignSnapshotArgs { readonly campaignDir: string; readonly refs: Campaign['refs']; readonly evalsCheckout: string; readonly gauntletCheckout: string; readonly superpowersCheckout: string; readonly runner: CommandRunner }`
  - `export function materializeCampaignSnapshot(args: MaterializeCampaignSnapshotArgs): SnapshotHandle` — R-DSP-12: evals+gauntlet snapshot with `destDir` = the campaign dir itself (Decision D-6); one worktree per DISTINCT arm superpowers SHA (`destParent` = campaign dir); `superpowersWorktrees` populated
  - `export function reconstructCampaignSnapshot(args: { readonly campaignDir: string; readonly refs: Campaign['refs']; readonly runner: CommandRunner }): SnapshotHandle` — R-RCV-6: shipped `reconstructSnapshot(destDir)` then cross-check the handle against `Campaign.refs` (evals SHA, gauntlet SHA, exact set of arm SHAs); refuses loudly on any mismatch — expected identity never derives from current HEAD alone
  - `export function verifyCampaignSnapshot(handle: SnapshotHandle, runner: CommandRunner): void` — the D2 drift guard at the D2 cadence (per admission wave, block terminal, pre-seal); callers: task 8
  - `export interface DriftWindow { readonly lastCleanVerifyTsMs: number; readonly rematerializedTsMs: number }`; `export interface InFlightBlock { readonly block_id: string; readonly admittedTsMs: number; readonly serviceEndTsMs: number | null }`
  - `export function driftAffectedBlockIds(args: { readonly window: DriftWindow; readonly inFlight: readonly InFlightBlock[]; readonly admittedUnspawned: readonly string[] }): string[]` — Decision D-11 revised mapping (task 8 consumes)
  - `export function repairDriftedTrees(args: MaterializeCampaignSnapshotArgs): SnapshotHandle` — the authorized repair: `git worktree remove --force` + `git worktree prune` on the source checkout through the `CommandRunner` seam (never `rm -rf`), then the D2 materializer re-invoked at the same dest; loud on stderr naming tree + drift

- [ ] **Step 1: Write the failing tests** — create `test/campaign-snapshot.test.ts`. Copy Task 2-of-the-D2-plan `RecordingRunner` pattern (per-dir `heads`/`porcelain` maps; record every call with options):

```ts
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import {
  driftAffectedBlockIds,
  materializeCampaignSnapshot,
  reconstructCampaignSnapshot,
  repairDriftedTrees,
  SnapshotIntegrationError,
} from '../src/campaign/snapshot.ts';

const EVALS = 'e'.repeat(40);
const GAUNTLET = '9'.repeat(40);
const SP_A = 'a'.repeat(40);
const SP_B = 'b'.repeat(40);

class RecordingRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[]; options?: CommandOptions }[] = [];
  readonly heads = new Map<string, string>();
  readonly porcelain = new Map<string, string>();
  run(command: string, args: readonly string[], options?: CommandOptions): CommandResult {
    this.calls.push(options === undefined ? { command, args } : { command, args, options });
    if (command === 'git' && args.includes('rev-parse')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return { status: 0, stdout: `${this.heads.get(dir) ?? EVALS}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('status')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return { status: 0, stdout: this.porcelain.get(dir) ?? '', stderr: '' };
    }
    // Worktree emulation: remove deletes the dest; add recreates it and
    // pins its HEAD to the requested sha — so a repair's remove -> re-add
    // sequence round-trips against the real ensureWorktreeAt validation.
    if (command === 'git' && args.includes('worktree') && args.includes('remove')) {
      const dest = args[args.length - 1] ?? '';
      rmSync(dest, { recursive: true, force: true });
      this.heads.delete(dest);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args.includes('worktree') && args.includes('add')) {
      const dest = args[args.indexOf('--detach') + 1] ?? '';
      const sha = args[args.length - 1] ?? '';
      mkdirSync(dest, { recursive: true });
      this.heads.set(dest, sha);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function refs(sp: Record<string, string | null>) {
  return { superpowers_by_arm: sp, evals: EVALS, gauntlet: GAUNTLET };
}

test('materializes the snapshot at the campaign dir itself + one worktree per DISTINCT arm SHA', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  const handle = materializeCampaignSnapshot({
    campaignDir,
    refs: refs({ arm1: SP_A, arm2: SP_A, arm3: SP_B, arm4: null }),
    evalsCheckout: '/src/evals',
    gauntletCheckout: '/src/gauntlet',
    superpowersCheckout: '/src/sp',
    runner,
  });
  expect(handle.evalsRoot).toBe(join(campaignDir, 'evals')); // destDir = campaign dir (Decision D-6)
  expect(handle.superpowersWorktrees.map((w) => w.sha).sort()).toEqual([SP_A, SP_B]); // distinct only
  const adds = runner.calls.filter((c) => c.args.includes('add'));
  expect(adds.filter((c) => c.args.includes(SP_A))).toHaveLength(1);
  // 'none' arms materialize nothing.
  expect(runner.calls.some((c) => c.args.join(' ').includes('none'))).toBe(false);
});

test('reconstruction cross-checks Campaign.refs and refuses a moved HEAD', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  // A completed snapshot layout with MOVED heads (reconstruction re-reads HEADs).
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  mkdirSync(join(campaignDir, 'bin'), { recursive: true });
  const spRoot = join(campaignDir, `superpowers-${SP_A}`);
  mkdirSync(spRoot, { recursive: true });
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
  writeFileSync(
    join(campaignDir, 'bin', 'gauntlet'),
    `#!/bin/sh\nexec bun '${join(campaignDir, 'gauntlet')}/src/index.ts' "$@"\n`,
  );
  chmodSync(join(campaignDir, 'bin', 'gauntlet'), 0o755); // the completeness probe requires the exec bit
  // Heads match refs -> cross-check passes.
  runner.heads.set(join(campaignDir, 'evals'), EVALS);
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  runner.heads.set(spRoot, SP_A);
  const ok = reconstructCampaignSnapshot({ campaignDir, refs: refs({ arm1: SP_A }), runner });
  expect(ok.evalsSha).toBe(EVALS);
  // Evals HEAD moved -> loud refusal naming both SHAs (R-RCV-6).
  runner.heads.set(join(campaignDir, 'evals'), 'f'.repeat(40));
  expect(() =>
    reconstructCampaignSnapshot({ campaignDir, refs: refs({ arm1: SP_A }), runner }),
  ).toThrow(SnapshotIntegrationError);
  expect(() =>
    reconstructCampaignSnapshot({ campaignDir, refs: refs({ arm1: SP_A }), runner }),
  ).toThrow(/evals/);
});

test('reconstruction refuses an arm-SHA set mismatch (extra or missing worktree)', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  mkdirSync(join(campaignDir, 'bin'), { recursive: true });
  mkdirSync(join(campaignDir, `superpowers-${SP_A}`), { recursive: true });
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
  writeFileSync(
    join(campaignDir, 'bin', 'gauntlet'),
    `#!/bin/sh\nexec bun '${join(campaignDir, 'gauntlet')}/src/index.ts' "$@"\n`,
  );
  chmodSync(join(campaignDir, 'bin', 'gauntlet'), 0o755); // the completeness probe requires the exec bit
  runner.heads.set(join(campaignDir, 'evals'), EVALS);
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  runner.heads.set(join(campaignDir, `superpowers-${SP_A}`), SP_A);
  // Refs expect SP_B too -> mismatch.
  expect(() =>
    reconstructCampaignSnapshot({ campaignDir, refs: refs({ arm1: SP_A, arm2: SP_B }), runner }),
  ).toThrow(SnapshotIntegrationError);
});

test('drift affected-set: in-flight across the window + admitted-unspawned; clean pre-window terminals unaffected', () => {
  const affected = driftAffectedBlockIds({
    window: { lastCleanVerifyTsMs: 100, rematerializedTsMs: 500 },
    inFlight: [
      { block_id: 'live-through', admittedTsMs: 50, serviceEndTsMs: null },
      { block_id: 'started-in-window', admittedTsMs: 300, serviceEndTsMs: null },
      { block_id: 'ended-in-window', admittedTsMs: 50, serviceEndTsMs: 200 },
      { block_id: 'clean-before-window', admittedTsMs: 10, serviceEndTsMs: 90 },
      { block_id: 'after-window', admittedTsMs: 600, serviceEndTsMs: null },
    ],
    admittedUnspawned: ['wave-block'],
  });
  expect(affected.sort()).toEqual(
    ['ended-in-window', 'live-through', 'started-in-window', 'wave-block'].sort(),
  );
});

test('repair: worktree remove --force + prune on the SOURCE checkout, then re-materialize (never rm -rf)', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  // Drift the evals tree's HEAD so re-materialize must remove + recreate.
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  runner.heads.set(join(campaignDir, 'evals'), 'f'.repeat(40));
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  expect(() =>
    repairDriftedTrees({
      campaignDir,
      refs: refs({}),
      evalsCheckout: '/src/evals',
      gauntletCheckout: '/src/gauntlet',
      superpowersCheckout: '/src/sp',
      runner,
    }),
  ).not.toThrow(); // the runner's worktree emulation round-trips remove -> re-add at the right SHA
  const verbs = runner.calls.map((c) => `${c.command} ${c.args.join(' ')}`);
  expect(verbs.some((v) => v.includes('worktree remove --force') && v.includes('/src/evals'))).toBe(true);
  expect(verbs.some((v) => v.includes('worktree prune'))).toBe(true);
  expect(verbs.some((v) => v.includes('rm -rf'))).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-snapshot.test.ts`
Expected: FAIL — module `../src/campaign/snapshot.ts` not found.

- [ ] **Step 3: Implement `src/campaign/snapshot.ts`**

```ts
// Campaign-dir snapshot integration (kernel D3, R-DSP-11/12, R-RCV-6,
// Decision D-11): the D2 materializers called with campaign-dir
// destinations (destDir = the campaign dir itself — Decision D-6),
// reconstruction cross-checked against Campaign.refs (expected identity
// never derives from current HEAD alone), the drift-guard cadence sites,
// the revised affected-block mapping, and the authorized repair operation
// (remove + re-materialize under D2's contracts — never rm -rf).
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import type { Campaign } from '../contracts/campaign/campaign.ts';
import { getEnv } from '../env.ts';
import {
  materializeEvalsSnapshot,
  reconstructSnapshot,
  verifySnapshot,
  type SnapshotHandle,
} from './instrument-snapshot.ts';
import { materializeSuperpowersWorktree } from './provisioning.ts';

export class SnapshotIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotIntegrationError';
  }
}

export interface MaterializeCampaignSnapshotArgs {
  readonly campaignDir: string;
  readonly refs: Campaign['refs'];
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
  readonly runner: CommandRunner;
}

/** R-DSP-12: materialize the evals+gauntlet snapshot (destDir = the campaign
 *  dir) and one immutable worktree per DISTINCT arm superpowers SHA. */
export function materializeCampaignSnapshot(
  args: MaterializeCampaignSnapshotArgs,
): SnapshotHandle {
  const handle = materializeEvalsSnapshot({
    evalsCheckout: args.evalsCheckout,
    evalsSha: args.refs.evals,
    gauntletCheckout: args.gauntletCheckout,
    gauntletSha: args.refs.gauntlet,
    destDir: args.campaignDir,
    runner: args.runner,
  });
  const distinctShas = [
    ...new Set(
      Object.values(args.refs.superpowers_by_arm).filter(
        (sha): sha is string => sha !== null,
      ),
    ),
  ].sort();
  const worktrees = distinctShas.map((sha) => ({
    root: materializeSuperpowersWorktree({
      sourceCheckout: args.superpowersCheckout,
      sha,
      destParent: args.campaignDir,
      runner: args.runner,
    }),
    sha,
  }));
  return { ...handle, superpowersWorktrees: worktrees };
}

/** R-RCV-6: reconstruction reads expected SHAs from current worktree HEADs,
 *  so resume cross-checks the handle against Campaign.refs and refuses
 *  loudly on ANY mismatch — evals SHA, gauntlet SHA, and the exact set of
 *  arm superpowers SHAs. */
export function reconstructCampaignSnapshot(args: {
  readonly campaignDir: string;
  readonly refs: Campaign['refs'];
  readonly runner: CommandRunner;
}): SnapshotHandle {
  const handle = reconstructSnapshot(args.campaignDir, args.runner);
  const mismatches: string[] = [];
  if (handle.evalsSha !== args.refs.evals) {
    mismatches.push(`evals: HEAD ${handle.evalsSha} != registered ${args.refs.evals}`);
  }
  if (handle.gauntletSha !== args.refs.gauntlet) {
    mismatches.push(`gauntlet: HEAD ${handle.gauntletSha} != registered ${args.refs.gauntlet}`);
  }
  const expectedArms = [
    ...new Set(
      Object.values(args.refs.superpowers_by_arm).filter(
        (sha): sha is string => sha !== null,
      ),
    ),
  ].sort();
  const observedArms = handle.superpowersWorktrees.map((w) => w.sha).sort();
  if (JSON.stringify(expectedArms) !== JSON.stringify(observedArms)) {
    mismatches.push(
      `superpowers worktree set: observed [${observedArms.join(', ')}] != registered [${expectedArms.join(', ')}]`,
    );
  }
  if (mismatches.length > 0) {
    throw new SnapshotIntegrationError(
      `snapshot reconstruction failed the Campaign.refs cross-check at ${args.campaignDir}: ${mismatches.join('; ')} — expected identity never derives from current HEAD alone (refuse, fail-closed)`,
    );
  }
  return handle;
}

/** The D2 drift guard at the D2 cadence: per admission wave, at block
 *  terminal, pre-seal (task 8 call sites; D4 invokes pre-seal). */
export function verifyCampaignSnapshot(handle: SnapshotHandle, runner: CommandRunner): void {
  verifySnapshot(handle, runner);
}

export interface DriftWindow {
  readonly lastCleanVerifyTsMs: number;
  readonly rematerializedTsMs: number;
}

export interface InFlightBlock {
  readonly block_id: string;
  readonly admittedTsMs: number;
  /** null = still running. */
  readonly serviceEndTsMs: number | null;
}

/** Decision D-11 revised mapping: affected = every block in flight at any
 *  point during [last clean verify, re-materialization complete], plus every
 *  block admitted-but-unspawned in the failing wave (wave verification runs
 *  before wave admission, so those simply never admit). Blocks whose own
 *  terminal verify was clean BEFORE the window opened are unaffected. */
export function driftAffectedBlockIds(args: {
  readonly window: DriftWindow;
  readonly inFlight: readonly InFlightBlock[];
  readonly admittedUnspawned: readonly string[];
}): string[] {
  const { window } = args;
  const affected = new Set<string>(args.admittedUnspawned);
  for (const block of args.inFlight) {
    if (block.serviceEndTsMs !== null && block.serviceEndTsMs < window.lastCleanVerifyTsMs) {
      continue; // clean terminal before the window: unaffected
    }
    const inFlightDuring =
      block.admittedTsMs <= window.rematerializedTsMs &&
      (block.serviceEndTsMs === null || block.serviceEndTsMs >= window.lastCleanVerifyTsMs);
    if (inFlightDuring) affected.add(block.block_id);
  }
  return [...affected];
}

/** The authorized repair (Decision D-11 step 3): each drifted tree removed
 *  through the CommandRunner seam — git worktree remove --force + prune on
 *  the SOURCE checkout (registrations live in the source's .git/worktrees) —
 *  and re-created by re-invoking the D2 materializer at the same dest. */
export function repairDriftedTrees(args: MaterializeCampaignSnapshotArgs): SnapshotHandle {
  // The D2 minimal-env invariant (PATH/HOME/TMPDIR only), read through
  // src/env.ts — never a direct process.env read outside that boundary.
  const minimalEnv = {
    PATH: getEnv('PATH'),
    HOME: getEnv('HOME'),
    TMPDIR: getEnv('TMPDIR'),
  };
  const removeAndPrune = (checkout: string, dest: string, label: string): void => {
    const remove = args.runner.run(
      'git',
      ['-C', checkout, 'worktree', 'remove', '--force', dest],
      { env: minimalEnv },
    );
    const prune = args.runner.run('git', ['-C', checkout, 'worktree', 'prune'], {
      env: minimalEnv,
    });
    if (remove.status !== 0 || prune.status !== 0) {
      throw new SnapshotIntegrationError(
        `drift repair failed for ${label} at ${dest}: remove ${remove.status} (${remove.stderr.trim()}), prune ${prune.status} (${prune.stderr.trim()})`,
      );
    }
    process.stderr.write(
      `campaign snapshot drift repair: removed + recreating ${label} at ${dest}\n`,
    );
  };
  // Remove drifted trees first (ensureWorktreeAt refuses drifted reuse).
  removeAndPrune(args.evalsCheckout, join(args.campaignDir, 'evals'), 'evals');
  removeAndPrune(args.gauntletCheckout, join(args.campaignDir, 'gauntlet'), 'gauntlet');
  for (const sha of new Set(
    Object.values(args.refs.superpowers_by_arm).filter((s): s is string => s !== null),
  )) {
    removeAndPrune(
      args.superpowersCheckout,
      join(args.campaignDir, `superpowers-${sha}`),
      `superpowers(${sha.slice(0, 12)})`,
    );
  }
  return materializeCampaignSnapshot(args);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-snapshot.test.ts`
Expected: PASS (5 tests). Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/campaign/snapshot.ts test/campaign-snapshot.test.ts
git commit -m "feat(campaign): D3 snapshot integration — campaign-dir destinations + refs cross-check

D2 materializers called with the campaign dir as destDir/destParent (one
worktree per distinct arm SHA); reconstruction cross-checks the handle
against Campaign.refs (moved HEAD refuses); Decision D-11 affected-set
mapping (in-flight across the window + admitted-unspawned, clean
pre-window terminals unaffected); authorized repair is worktree
remove --force + prune + re-materialize, never rm -rf."
```

---

### Task 5: registration from the snapshot

**Files:**
- Create: `src/campaign/registration.ts`
- Modify: `.gitignore` (`campaigns/` entry)
- Test: create `test/campaign-registration.test.ts`; fixture helper functions inline (tmp suite/arm/estimates files)

**Interfaces:**
- Consumes: `SuiteSchema`, `type Suite` from `src/contracts/campaign/suite.ts`; `ArmSchema`, `type Arm` from `src/contracts/campaign/arm.ts`; `CampaignSchema`, `type Campaign`, `ID_COMPONENT_RE`, `type ContentionDeclarationSchema`-inferred types, `type CampaignIdentity` from `src/contracts/campaign/campaign.ts`; `campaignDigest`, `type PreDigestCampaign` from `src/contracts/campaign/digest.ts`; `type EstimatesArtifact`, `EstimatesArtifactSchema` from `src/contracts/estimates.ts`; `lookupEstimate` from `src/campaign/estimates.ts`; `parseCredentialsFile`, `type Credential` from `src/contracts/credential.ts`; `poolKey` from `src/contracts/campaign/pool.ts`; `loadAgentConfigForValidation`, `agentRuntimeFamily` from `src/contracts/agent-config.ts`; `readQuorumTier`, `readRequiresSuperpowers`, `readCoupling` from `src/story-meta.ts`; `scanCouplingDefault` from `src/contracts/campaign/scenario-meta.ts`; `profileParamsSchema` from `src/contracts/campaign/profile-params.ts`; `parse as parseYaml` from `yaml` (existing dependency); `materializeCampaignSnapshot`, `repairDriftedTrees` from `src/campaign/snapshot.ts` (Task 4); `type SnapshotHandle` from `src/campaign/instrument-snapshot.ts`; `initJournalDb`, `electWriter`, `createBallast`, `verifyBallast`, `stageAndPublishCampaignJson`, `DEFAULT_BALLAST_BYTES`, `JournalError` from `src/campaign/journal.ts` (Task 3); `acquireLease`, `type ProcessIdentityProbe` from `src/campaign/locks.ts` (Task 2); `probeFingerprint`, `type HostStatsProbe`, `clockNowMs` from `src/campaign/host-stats.ts` (Tasks 1–2); `resolveSuperpowersRef` from `src/appliance/git.ts`; `type CommandRunner` from `src/agents/command-runner.ts`; `Clock` from `src/scheduler/clock.ts`.
- Produces (tasks 6–9 and the CLI rely on these exact names):
  - `export class RegistrationError extends Error`
  - `export const MINIMUM_CHILD_CONTRACT_SHA = 'f230698e5bb653371bee73d6e3212d6c2e241368'` (D2's implementation merge, hardened — Open items)
  - `export const SURCHARGE_FORMULA_VERSION = 1`; `export const SURCHARGE_RATE_MEDIUM = 0.10`; `export const SURCHARGE_RATE_LOW = 0.25`; `export const DEFAULT_GLOBAL_CAP = 8`; `export const ESTIMATE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000`
  - ID derivation (pinned table, injective by grammar): `export function assertIdComponent(component: string, label: string): void`; `comparisonId(ordinal: number): string`; `cellKeyOf(comparisonId: string, scenario: string): string`; `primarySampleId(cellKey: string, arm: string, replicate: number): string`; `primaryBlockId(cellKey: string, replicate: number): string`; `reserveBlockId(cellKey: string, k: number): string`; `reserveSampleId(cellKey: string, arm: string, k: number): string`; `rerunInstanceId(lineageRootBlockId: string, seq: number): string`; `attemptIdOf(sampleId: string, seq: number): string`
  - `export interface ScenarioIntake`, `export interface RegistrationInput`, `export interface PreparedRegistration` (below); `export function prepareRegistration(input: RegistrationInput): PreparedRegistration` — the pure grid/rejection/pricing core
  - `export function defaultContentionThresholds(args: { mem_bytes: number; swap_total_bytes: number; disk_total_bytes: number }): ContentionThreshold[]` (the five pinned D-4 defaults); `export function buildContentionBlock(args): ContentionDeclaration`
  - `export interface RegisterArgs`, `export interface RegisterResult`, `export function registerCampaign(args: RegisterArgs): RegisterResult`
  - Grader intake interpretation (recorded here for review — see the task's Design notes): `registerCampaign` reads the campaign grader from the suite file's top-level `grader: { credential, model }` block, extracted before the strict `SuiteSchema` parse.

**Design notes (recorded, not silent):**
1. **Grader intake.** R-REG-20 demands `grader: { credential, model }` recorded singular, the pinned CLI table offers no grader flag, `SuiteSchema` is strict, and neither the credentials registry nor the estimates artifact carries a grader identity (verified against `src/contracts/estimates.ts`, `src/contracts/replay.ts`). D1 §Suite says gating suites "carry" the registered grader credential (D1 spec line 368), so registration reads a top-level `grader:` block from the suite YAML file, strips it before `SuiteSchema.parse`, and fails closed when it is absent or malformed. This is the only intake consistent with the pinned CLI table + frozen schema homes.
2. **Grader-match restriction (R-REG-3).** The shipped estimates artifact has no grader identity, so the match is attested by the operator: gating campaigns require a `pricing_overrides` entry with `applies_to_grader: true` + rationale (the spec's escape hatch becomes the attestation); exploratory campaigns warn instead of refusing (exploratory breaches render caveats elsewhere in the spec).
3. **R-REG-21 staleness.** The mechanical half: `registration time − artifact.generated_at > 30 days` refuses, naming the rebuild command (`quorum campaign estimates`). The "rebuild after every sealed gating campaign" half is a process rule registration cannot observe; it is recorded in the refusal text, not checked.

Task 5 runs as four executable sub-tasks (5a → 5b → 5c → 5d), all growing `src/campaign/registration.ts` and its test file; each has its own failing-tests-first cycle, verify command, and commit.

#### Task 5a: ID grammar + module skeleton (Steps 1–4; covers the pinned ID-derivation grammar — injective by construction, `rerunInstanceId` included — that tasks 8/9 reuse)

**Files:** create `src/campaign/registration.ts` (skeleton + ID derivation); create `test/campaign-registration.test.ts`.

- [ ] **Step 1: Write the failing ID-derivation tests** — create `test/campaign-registration.test.ts` (this file grows across the task's cycles):

```ts
import { expect, test } from 'bun:test';
import {
  attemptIdOf,
  assertIdComponent,
  cellKeyOf,
  comparisonId,
  primaryBlockId,
  primarySampleId,
  RegistrationError,
  reserveBlockId,
  reserveSampleId,
  rerunInstanceId,
} from '../src/campaign/registration.ts';

test('the pinned ID derivation table', () => {
  const cmp = comparisonId(1);
  expect(cmp).toBe('c1');
  const cell = cellKeyOf(cmp, 'sdd-escalates');
  expect(cell).toBe('c1:sdd-escalates');
  expect(primarySampleId(cell, 'claude-sp', 3)).toBe('c1:sdd-escalates:claude-sp:r3');
  expect(primaryBlockId(cell, 3)).toBe('c1:sdd-escalates:b3');
  expect(reserveBlockId(cell, 2)).toBe('c1:sdd-escalates:x2');
  expect(reserveSampleId(cell, 'claude-sp', 2)).toBe('c1:sdd-escalates:claude-sp:x2');
  // Rerun lineage: the successor of B:i1 is B:i2, never B:i1:i2 — the root is
  // the first non-rerun block; seq increments across the root.
  expect(rerunInstanceId('c1:sdd-escalates:b3', 1)).toBe('c1:sdd-escalates:b3:i1');
  expect(rerunInstanceId('c1:sdd-escalates:b3', 2)).toBe('c1:sdd-escalates:b3:i2');
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:r3', 2)).toBe(
    'c1:sdd-escalates:claude-sp:r3:a2',
  );
});

test('ID components outside the pinned grammar reject; ":" never passes', () => {
  expect(() => assertIdComponent('ok-name.x_1', 'scenario name')).not.toThrow();
  expect(() => assertIdComponent('has:colon', 'scenario name')).toThrow(RegistrationError);
  expect(() => assertIdComponent('Upper', 'arm name')).toThrow(RegistrationError);
  expect(() => assertIdComponent('-lead', 'scenario name')).toThrow(RegistrationError);
  expect(() => assertIdComponent('', 'suite name')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1', 'bad:scenario')).toThrow(RegistrationError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-registration.test.ts`
Expected: FAIL — module `../src/campaign/registration.ts` not found.

- [ ] **Step 3: Implement the module skeleton + ID derivation** — create `src/campaign/registration.ts`:

```ts
// Registration from the snapshot (kernel D3, R-REG-1..22; REV Blocker C):
// resolve refs -> choose/lock the final campaign-dir path -> materialize the
// evals+gauntlet snapshot at that final path -> read scenarios, agent YAMLs,
// and credentials.yaml FROM the snapshot's evals tree (never the mutable
// host checkout) -> grid expansion, rejection matrix, pricing, digest ->
// final-path init (journal + campaign_opened + sidecar + ballast) ->
// campaign.json staged + renamed LAST. Resume authority = campaign.json +
// the snapshot.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SnapshotHandle } from './instrument-snapshot.ts';
import { parse as parseYaml } from 'yaml';
import { resolveSuperpowersRef } from '../appliance/git.ts';
import type { CommandRunner } from '../agents/command-runner.ts';
import { superpowersCapability } from '../agents/index.ts';
import { ArmSchema, type Arm } from '../contracts/campaign/arm.ts';
import {
  type Campaign,
  CampaignSchema,
  type ContentionThreshold,
  type HostFingerprint,
  ID_COMPONENT_RE,
} from '../contracts/campaign/campaign.ts';
import { campaignDigest, type PreDigestCampaign } from '../contracts/campaign/digest.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import { type Credential, parseCredentialsFile } from '../contracts/credential.ts';
import { EstimatesArtifactSchema, type EstimatesArtifact } from '../contracts/estimates.ts';
import { loadAgentConfigForValidation, agentRuntimeFamily } from '../contracts/agent-config.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { SuiteSchema, type Suite } from '../contracts/campaign/suite.ts';
import { readCoupling, readQuorumTier, readRequiresSuperpowers } from '../story-meta.ts';
import { scanCouplingDefault } from '../contracts/campaign/scenario-meta.ts';
import { lookupEstimate } from './estimates.ts';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
  electWriter,
  initJournalDb,
  JournalError,
  stageAndPublishCampaignJson,
  verifyBallast,
} from './journal.ts';
import { acquireLease, type ProcessIdentityProbe } from './locks.ts';
import { clockNowMs, type HostStatsProbe, probeFingerprint } from './host-stats.ts';
import { materializeCampaignSnapshot, repairDriftedTrees } from './snapshot.ts';
import type { Clock } from '../scheduler/clock.ts';

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

/** D2's implementation merge — the minimum child-contract commit an evals
 *  ref must contain (Child-contract compatibility, REV fable I-12). */
export const MINIMUM_CHILD_CONTRACT_SHA = 'f230698e5bb653371bee73d6e3212d6c2e241368';

export const SURCHARGE_FORMULA_VERSION = 1;
export const SURCHARGE_RATE_MEDIUM = 0.1;
export const SURCHARGE_RATE_LOW = 0.25;
export const DEFAULT_GLOBAL_CAP = 8;
export const ESTIMATE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Round-4 S-11: every external component interpolated into a generated id
 *  matches the pinned grammar; ':' is reserved as the generated delimiter.
 *  A duplicate at construction is a loud programming error. */
export function assertIdComponent(component: string, label: string): void {
  if (!ID_COMPONENT_RE.test(component)) {
    throw new RegistrationError(
      `${label} ${JSON.stringify(component)} is not a valid campaign id component (must match ${ID_COMPONENT_RE}; ':' is reserved as the generated delimiter)`,
    );
  }
}

// The pinned ID derivation table (REV-2 P-7). Injective by grammar — no
// hashing. `<cell-key> = <comparison_id>:<scenario-name>`.
export function comparisonId(ordinal: number): string {
  return `c${ordinal}`;
}
export function cellKeyOf(comparisonId: string, scenario: string): string {
  assertIdComponent(scenario, 'scenario name');
  return `${comparisonId}:${scenario}`;
}
export function primarySampleId(cellKey: string, arm: string, replicate: number): string {
  assertIdComponent(arm, 'arm name');
  return `${cellKey}:${arm}:r${replicate}`;
}
export function primaryBlockId(cellKey: string, replicate: number): string {
  return `${cellKey}:b${replicate}`;
}
export function reserveBlockId(cellKey: string, k: number): string {
  return `${cellKey}:x${k}`;
}
export function reserveSampleId(cellKey: string, arm: string, k: number): string {
  assertIdComponent(arm, 'arm name');
  return `${cellKey}:${arm}:x${k}`;
}
export function rerunInstanceId(lineageRootBlockId: string, seq: number): string {
  return `${lineageRootBlockId}:i${seq}`;
}
export function attemptIdOf(sampleId: string, seq: number): string {
  return `${sampleId}:a${seq}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-registration.test.ts`
Expected: PASS (2 tests).

- [ ] **Commit (task 5a)**

```bash
git add src/campaign/registration.ts test/campaign-registration.test.ts
git commit -m "feat(campaign): D3 registration IDs — injective grammar, rerun instances, component rule"
```

#### Task 5b: `prepareRegistration` — grid, rejection matrix, pricing, digest (Steps 5–8; covers R-REG-1/2/3/4/7/9/10/11/12/13/14/15/16/17/18/20/21 and E1/E2 pricing)

**Files:** modify `src/campaign/registration.ts` (append `prepareRegistration` + helpers); append to `test/campaign-registration.test.ts`.

- [ ] **Step 5: Write the failing prepareRegistration tests** — append to `test/campaign-registration.test.ts`. The fixture builders below are reused by every later cycle in this file:

```ts
import type { Arm } from '../src/contracts/campaign/arm.ts';
import type { Credential } from '../src/contracts/credential.ts';
import type { EstimatesArtifact } from '../src/contracts/estimates.ts';
import type { Suite } from '../src/contracts/campaign/suite.ts';
import {
  prepareRegistration,
  SURCHARGE_FORMULA_VERSION,
  type RegistrationInput,
  type ScenarioIntake,
} from '../src/campaign/registration.ts';

const CAPABLE = () => ({ ref: true, none: true });

// Fixture builders. Some call sites cast their override literal `as never`:
// exactOptionalPropertyTypes rejects an explicit `undefined` override (the
// deletion idiom, e.g. `api_key_env: undefined` to strip a default), and the
// cast admits exactly that — the builders' outputs are still exercised
// against the real zod schemas by the tests themselves.
function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    model: 'test-model',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: 'TEST_KEY',
    compat: {},
    max_concurrency: 15,
    ...overrides,
  } as Credential;
}

function arm(name: string, overrides: Partial<Arm> = {}): Arm {
  return {
    schema_version: 1,
    name,
    agent: 'claude',
    credential: 'cred_a',
    superpowers: 'none',
    ...overrides,
  } as Arm;
}

function scenario(name: string, overrides: Partial<ScenarioIntake> = {}): ScenarioIntake {
  return {
    name,
    tier: 'full',
    requires_superpowers: false,
    coupling: 'arm-independent',
    os: undefined,
    ...overrides,
  };
}

function estimates(overrides: Partial<EstimatesArtifact> = {}): EstimatesArtifact {
  return {
    schema_version: 'quorum.estimates/v1',
    generated_at: '2026-08-20T00:00:00Z',
    corpus: { sources: ['s'], run_count: 10, duplicates_excluded: 0, digest: 'd' },
    entries: [
      {
        scenario: 'scn-a',
        agent: 'claude',
        credential: 'cred_a',
        os: 'linux',
        duration_s_median: 600,
        duration_n: 9,
        cost_subject_usd_median: 1,
        cost_grader_usd_median: 0.5,
        cost_total_usd_median: 1.5,
        priced_n: 9,
        spread_s: { p25: 500, p75: 700 },
        confidence: 'high',
      },
    ],
    fallbacks: {
      scenario_agent: [],
      scenario: [],
      corpus_median: { duration_s: 600, cost_total_usd: 1.5 },
    },
    ...overrides,
  } as EstimatesArtifact;
}

function suite(overrides: Partial<Suite> = {}): Suite {
  return {
    schema_version: 1,
    name: 'testsuite',
    kind: 'exploratory',
    budget_usd: 100,
    comparisons: [
      { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn-a'], n: 2 },
    ],
    ...overrides,
  } as Suite;
}

function input(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    suite: suite(),
    arms: { arm_a: arm('arm_a'), arm_b: arm('arm_b', { credential: 'cred_b' }) },
    credentials: { cred_a: credential(), cred_b: credential({ api_key_env: 'TEST_KEY_B' }) },
    grader: { credential: 'cred_a', model: 'grader-model' },
    estimates: estimates(),
    capability: CAPABLE,
    agentOsSupport: () => ['linux'],
    agentFamily: () => 'claude',
    scenarios: [scenario('scn-a')],
    globalCap: 8,
    campaignOs: 'linux',
    env: () => 'set',
    nowMs: Date.parse('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}
```

Tests:

```ts
test('grid expansion: cells, samples, blocks, deterministic canonical order', () => {
  const prep = prepareRegistration(input());
  expect(prep.comparisons).toEqual([
    { comparison_id: 'c1', baseline: 'arm_a', treatment: 'arm_b' },
  ]);
  expect(prep.cells.map((c) => ({ scenario: c.scenario, comparison_id: c.comparison_id, arms: c.arms, n: c.n }))).toEqual([
    { scenario: 'scn-a', comparison_id: 'c1', arms: ['arm_a', 'arm_b'], n: 2 },
  ]);
  expect(prep.samples.map((s) => s.sample_id)).toEqual([
    'c1:scn-a:arm_a:r1',
    'c1:scn-a:arm_b:r1',
    'c1:scn-a:arm_a:r2',
    'c1:scn-a:arm_b:r2',
  ]);
  expect(prep.blocks.map((b) => b.block_id)).toEqual(['c1:scn-a:b1', 'c1:scn-a:b2']);
  expect(prep.blocks[0]?.sample_ids).toEqual(['c1:scn-a:arm_a:r1', 'c1:scn-a:arm_b:r1']);
  expect(prep.excluded_cells).toEqual([]);
  // Byte-identical on re-run (determinism bundle).
  expect(JSON.stringify(prepareRegistration(input()))).toBe(JSON.stringify(prep));
});

test('tier selectors expand through the intake tier labels', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({
        comparisons: [{ baseline: 'arm_a', treatment: 'arm_b', scenarios: 'tier=sentinel', n: 1 }],
      }),
      scenarios: [scenario('scn-a', { tier: 'sentinel' }), scenario('scn-b', { tier: 'full' })],
    }),
  );
  expect(prep.cells.map((c) => c.scenario)).toEqual(['scn-a']);
});

test('gating suites mint reserve blocks + samples per cell (E7.0 frozen reserve)', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      }),
      // gating + grader-match attestation (Design note 2):
      pricingOverrides: [{ applies_to_grader: true, per_token_usd: 0.00001, rationale: 'attested' }],
    } as never),
  );
  expect(prep.blocks.map((b) => b.block_id)).toContain('c1:scn-a:x1');
  const reserve = prep.blocks.find((b) => b.block_id === 'c1:scn-a:x1');
  expect(reserve?.slot).toBe('reserve');
  expect(reserve?.sample_ids).toEqual(['c1:scn-a:arm_a:x1', 'c1:scn-a:arm_b:x1']);
  expect(prep.samples.find((s) => s.sample_id === 'c1:scn-a:arm_a:x1')?.cell).toBe('c1:scn-a');
});

test('rejection matrix: capability, windows os, unsupported os, requires_superpowers, subscription auth', () => {
  // R-REG-9: a REF arm on an adapter without ref capability (the fixture's
  // default arms are superpowers 'none', which cap.none still permits).
  let prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { superpowers: 'ref', superpowers_ref: 'main' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
      capability: () => ({ ref: false, none: true }),
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/lacks adapter capability/);
  // R-REG-10: os: windows parses, then rejects.
  prep = prepareRegistration(input({ arms: { arm_a: arm('arm_a', { os: 'windows' }), arm_b: arm('arm_b', { credential: 'cred_b' }) } }));
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/windows/);
  // R-REG-14: arm os unsupported by the agent.
  prep = prepareRegistration(
    input({
      arms: { arm_a: arm('arm_a', { os: 'darwin' }), arm_b: arm('arm_b', { credential: 'cred_b' }) },
      agentOsSupport: () => ['linux'],
    }),
  );
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/os .*unsupported/i);
  // R-REG-16: requires_superpowers scenario dropped for none arms.
  prep = prepareRegistration(input({ scenarios: [scenario('scn-a', { requires_superpowers: true })] }));
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/requires_superpowers/);
  // R-REG-15: subscription auth in a gating suite rejects mechanically.
  prep = prepareRegistration(
    input({
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: { alpha: 0.05, determinate_n_floor: 5, completion_divergence_max: 0.2, mde_by_scenario: { 'scn-a': 0.1 } },
      }),
      credentials: { cred_a: credential({ auth: 'subscription', api_key_env: undefined }), cred_b: credential({ api_key_env: 'TEST_KEY_B' }) },
      pricingOverrides: [{ applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' }],
    } as never),
  );
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/api-key/);
});

test('R-REG-13: cap-1 same-pool two-arm demand refuses pre-spend', () => {
  const prep = prepareRegistration(
    input({
      credentials: {
        // SAME quota_pool on both -> one pool with cap 1 facing two-arm demand
        cred_a: credential({ max_concurrency: 1, quota_pool: 'shared' }),
        cred_b: credential({ max_concurrency: 1, api_key_env: 'TEST_KEY_B', quota_pool: 'shared' }),
      },
      suite: suite({ comparisons: [{ baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn-a'], n: 1 }], max_exposure_skew: 60 } as never),
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/infeasible|cap/i);
});

test('pricing: E1/E2 keying through lookupEstimate, surcharge formula v1, priced coverage', () => {
  const prep = prepareRegistration(
    input({
      estimates: estimates({
        entries: [
          {
            scenario: 'scn-a', agent: 'claude', credential: 'cred_a', os: 'linux',
            duration_s_median: 600, duration_n: 4, cost_subject_usd_median: 1, cost_grader_usd_median: 0.5,
            cost_total_usd_median: 1.5, priced_n: 4, spread_s: { p25: 500, p75: 700 },
            confidence: 'medium',
          },
          {
            scenario: 'scn-a', agent: 'claude', credential: 'cred_b', os: 'linux',
            duration_s_median: 700, duration_n: 9, cost_subject_usd_median: 2, cost_grader_usd_median: 0.5,
            cost_total_usd_median: 2.5, priced_n: 9, spread_s: { p25: 600, p75: 800 },
            confidence: 'high',
          },
        ],
      }),
    }),
  );
  const cell = prep.cells[0];
  expect(cell?.estimates_by_arm['arm_a']).toEqual({ duration_s: 600, cost_usd: 1.5, confidence: 'medium' });
  expect(cell?.estimates_by_arm['arm_b']).toEqual({ duration_s: 700, cost_usd: 2.5, confidence: 'high' });
  // Surcharge: worst-arm confidence medium -> (n x (1.5 + 2.5)) x 0.10 = 2 x 4 x 0.10
  expect(prep.budget.surcharge_applied).toBeCloseTo(0.8, 10);
  expect(prep.budget.surcharge_formula_version).toBe(SURCHARGE_FORMULA_VERSION);
  expect(prep.budget.usd_all_in).toBe(100);
  expect(prep.budget.priced_coverage).toBe(1);
});

test('R-REG-11 + R-REG-12: unpriced gating cells reject without an override; usd params reject when unpriceable', () => {
  const unpriced = estimates({
    entries: [],
    fallbacks: {
      scenario_agent: [],
      scenario: [],
      corpus_median: { duration_s: 600, cost_total_usd: null },
    },
  });
  let prep = prepareRegistration(
    input({
      estimates: unpriced,
      suite: suite({ kind: 'gating', profile: 'release_gate_v1', reserve: 1, max_exposure_skew: 60, profile_params: { alpha: 0.05, determinate_n_floor: 5, completion_divergence_max: 0.2, mde_by_scenario: { 'scn-a': 0.1 } } } as never),
      pricingOverrides: [{ applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' }],
    } as never),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/unpriced|pricing override/i);
  // The arm override escapes R-REG-11:
  prep = prepareRegistration(
    input({
      estimates: unpriced,
      suite: suite({ kind: 'gating', profile: 'release_gate_v1', reserve: 1, max_exposure_skew: 60, profile_params: { alpha: 0.05, determinate_n_floor: 5, completion_divergence_max: 0.2, mde_by_scenario: { 'scn-a': 0.1 } } } as never),
      pricingOverrides: [
        { arm: 'arm_a', per_token_usd: 0.00001, rationale: 'r' },
        { arm: 'arm_b', per_token_usd: 0.00001, rationale: 'r' },
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.cells).toHaveLength(1);
});

test('grader-match restriction: gating refuses without the attestation override; exploratory warns', () => {
  expect(() =>
    prepareRegistration(
      input({
        suite: suite({ kind: 'gating', profile: 'release_gate_v1', reserve: 1, max_exposure_skew: 60, profile_params: { alpha: 0.05, determinate_n_floor: 5, completion_divergence_max: 0.2, mde_by_scenario: { 'scn-a': 0.1 } } } as never),
      } as never),
    ),
  ).toThrow(/grader/);
  const prep = prepareRegistration(input()); // exploratory, no attestation
  expect(prep.warnings.join(' ')).toMatch(/grader/);
});

test('warnings: grader cap below 15 in gating; key_pool over-capacity (R-REG-20/7)', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({ kind: 'gating', profile: 'release_gate_v1', reserve: 1, max_exposure_skew: 60, profile_params: { alpha: 0.05, determinate_n_floor: 5, completion_divergence_max: 0.2, mde_by_scenario: { 'scn-a': 0.1 } } } as never),
      credentials: {
        cred_a: credential({ max_concurrency: 20, key_pool: ['K1', 'K2', 'K3'], api_key_env: undefined }),
        cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
      },
      pricingOverrides: [{ applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' }],
    } as never),
  );
  expect(prep.warnings.join(' ')).toMatch(/grader pool cap/);
  expect(prep.warnings.join(' ')).toMatch(/key_pool/); // 20 > 3 keys x 5 = 15 -> over-capacity warning
});
```

(`pricingOverrides` is an optional field on `RegistrationInput` — `readonly pricingOverrides?: PricingOverride[]` — mapped to `campaign.json`'s `pricing_overrides`.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test test/campaign-registration.test.ts`
Expected: FAIL — `prepareRegistration` not found.

- [ ] **Step 7: Implement `prepareRegistration`** — append to `src/campaign/registration.ts`:

```ts
import type { Cell, PricingOverride, Sample, Block } from '../contracts/campaign/campaign.ts';

export interface ScenarioIntake {
  readonly name: string;
  readonly tier: 'sentinel' | 'full' | 'adhoc';
  readonly requires_superpowers: boolean;
  readonly coupling: 'pins-skill-names' | 'embeds-skill-fixtures' | 'arm-independent';
  /** Scenario `# os:` directive; undefined = run-anywhere. */
  readonly os: readonly string[] | undefined;
}

export interface RegistrationInput {
  readonly suite: Suite;
  readonly arms: Readonly<Record<string, Arm>>;
  readonly credentials: Readonly<Record<string, Credential>>;
  readonly grader: { credential: string; model: string };
  readonly estimates: EstimatesArtifact;
  readonly capability: (family: string) => { ref: boolean; none: boolean };
  readonly agentOsSupport: (agent: string) => readonly string[] | undefined;
  readonly agentFamily: (agent: string) => string; // runtime_family ?? name
  readonly scenarios: readonly ScenarioIntake[];
  readonly globalCap: number;
  readonly campaignOs: string;
  /** Effective-environment reader for the R-REG-19 key-env preflight. */
  readonly env: (key: string) => string | undefined;
  /** Registration wall time (ms) for the R-REG-21 staleness check. */
  readonly nowMs: number;
  readonly pricingOverrides?: readonly PricingOverride[];
}

export interface PreparedRegistration {
  readonly comparisons: Campaign['comparisons'];
  readonly cells: Cell[];
  readonly samples: Sample[];
  readonly blocks: Block[];
  readonly excluded_cells: { cell: string; reason: string }[];
  readonly warnings: string[];
  readonly budget: {
    usd_all_in: number;
    surcharge_applied: number;
    priced_coverage: number;
    surcharge_formula_version: number;
  };
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/** The pure registration core: grid expansion, the eligibility rejection
 *  matrix (all fail-closed, all loud-recorded), E7.0 reserve minting, E1/E2
 *  pricing, versioned surcharge. Canonical expansion order (determinism
 *  bundle): comparisons in suite order -> cells by scenario sort order ->
 *  arms in comparison order -> replicate ascending. */
export function prepareRegistration(input: RegistrationInput): PreparedRegistration {
  const { suite, arms, credentials, grader, estimates } = input;
  const gating = suite.kind === 'gating';
  const excluded_cells: { cell: string; reason: string }[] = [];
  const warnings: string[] = [];
  const comparisons: PreparedRegistration['comparisons'] = [];
  const cells: Cell[] = [];
  const samples: Sample[] = [];
  const blocks: Block[] = [];
  const scenarioByName = new Map(input.scenarios.map((s) => [s.name, s]));
  const overrides = input.pricingOverrides ?? [];

  // Registration-level checks (not per-cell):
  checkProfileParams(suite);
  checkKeyEnvPresence(input); // R-REG-19 (registration half)
  checkEstimateStaleness(input); // R-REG-21 — needs nowMs; see registerCampaign
  warnings.push(...graderAndPoolWarnings(input)); // R-REG-20 + R-REG-7
  if (gating) {
    const attested = overrides.some((o) => o.applies_to_grader === true);
    if (!attested) {
      throw new RegistrationError(
        `grader-match restriction: the estimates artifact carries no grader identity, so the registered grader (${grader.credential}, ${grader.model}) must be attested by a pricing_overrides entry with applies_to_grader: true and a rationale (R-REG-3 grader pricing restriction)`,
      );
    }
  } else if (!overrides.some((o) => o.applies_to_grader === true)) {
    warnings.push(
      `grader ${grader.credential}/${grader.model} is unattested against the estimates artifact (exploratory: caveat, not refusal)`,
    );
  }

  suite.comparisons.forEach((comparison, index) => {
    const comparison_id = comparisonId(index + 1);
    const armNames = 'arm' in comparison ? [comparison.arm] : [comparison.baseline, comparison.treatment];
    const scenarios = expandSelector(comparison.scenarios, input);
    comparisons.push(
      'arm' in comparison
        ? { comparison_id, arm: comparison.arm }
        : { comparison_id, baseline: comparison.baseline, treatment: comparison.treatment },
    );
    for (const scenarioName of [...scenarios].sort()) {
      const cellKey = cellKeyOf(comparison_id, scenarioName);
      const scen = scenarioByName.get(scenarioName);
      if (scen === undefined) {
        excluded_cells.push({ cell: cellKey, reason: `scenario ${scenarioName} not in the snapshot intake` });
        continue;
      }
      const rejection = rejectCell(input, scen, armNames, cellKey);
      if (rejection !== null) {
        excluded_cells.push({ cell: cellKey, reason: rejection });
        continue;
      }
      const n = comparison.cells?.[scenarioName]?.n ?? comparison.n;
      const cellClass = comparison.cells?.[scenarioName]?.class ?? 'descriptive';
      // E1/E2 keying: scenario x agent x credential x os through the
      // lookupEstimate fallback chain.
      const estimatesByArm: Record<string, { duration_s: number; cost_usd: number; confidence: 'high' | 'medium' | 'low' }> = {};
      let allPriced = true;
      for (const armName of armNames) {
        const armDef = arms[armName];
        if (armDef === undefined) {
          throw new RegistrationError(`arm ${armName} named by a comparison is not in the intake`);
        }
        const lookup = lookupEstimate(estimates, {
          scenario: scenarioName,
          agent: armDef.agent,
          credential: armDef.credential,
          os: input.campaignOs,
        });
        const armOverride = overrides.find((o) => o.arm === armName && (o.scenario === undefined || o.scenario === scenarioName));
        const priced = lookup.cost_total_usd !== null || armOverride !== undefined;
        if (!priced) allPriced = false;
        estimatesByArm[armName] = {
          duration_s: lookup.duration_s,
          cost_usd: lookup.cost_total_usd ?? 0,
          confidence: lookup.confidence ?? (armOverride !== undefined ? 'high' : 'low'),
        };
      }
      if (gating && !allPriced) {
        excluded_cells.push({
          cell: cellKey,
          reason: 'gating cell on obol-unpriced model without a per-arm pricing override (R-REG-11)',
        });
        continue;
      }
      cells.push({
        scenario: scenarioName,
        comparison_id,
        arms: [...armNames],
        n,
        class: cellClass,
        coupling: scen.coupling,
        estimates_by_arm: estimatesByArm,
      });
      // Primary samples + blocks: replicate ascending; a block holds the
      // cell's replicate across the comparison's arms.
      for (let r = 1; r <= n; r++) {
        const blockSamples: string[] = [];
        for (const armName of armNames) {
          const sample_id = primarySampleId(cellKey, armName, r);
          samples.push({ sample_id, cell: cellKey, arm: armName, replicate: r });
          blockSamples.push(sample_id);
        }
        blocks.push({ block_id: primaryBlockId(cellKey, r), comparison_id, sample_ids: blockSamples });
      }
      // E7.0: reserve blocks are pre-registered, count-hard, priced — frozen
      // blocks with slot: 'reserve' and their own frozen samples.
      const reserve = suite.reserve ?? 0;
      for (let k = 1; k <= reserve; k++) {
        const reserveSamples: string[] = [];
        for (const armName of armNames) {
          const sample_id = reserveSampleId(cellKey, armName, k);
          samples.push({ sample_id, cell: cellKey, arm: armName, replicate: k });
          reserveSamples.push(sample_id);
        }
        blocks.push({
          block_id: reserveBlockId(cellKey, k),
          comparison_id,
          sample_ids: reserveSamples,
          slot: 'reserve',
        });
      }
    }
  });

  // Surcharge formula v1 (versioned): for each cell whose worst-arm
  // confidence < high, estimated cost x (medium ? 0.10 : 0.25).
  let surcharge = 0;
  let pricedCells = 0;
  for (const cell of cells) {
    let worst: 'high' | 'medium' | 'low' = 'high';
    let cellCost = 0;
    let priced = true;
    for (const armName of cell.arms) {
      const est = cell.estimates_by_arm[armName];
      if (est === undefined) continue; // unpriced arm: covered by priced_coverage below
      if (CONFIDENCE_RANK[est.confidence] < CONFIDENCE_RANK[worst]) worst = est.confidence;
      cellCost += est.cost_usd;
      if (est.cost_usd === 0 && est.confidence === 'low') priced = false;
    }
    if (priced) pricedCells += 1;
    if (worst !== 'high') {
      surcharge += cell.n * cellCost * (worst === 'medium' ? SURCHARGE_RATE_MEDIUM : SURCHARGE_RATE_LOW);
    }
  }

  return {
    comparisons,
    cells,
    samples,
    blocks,
    excluded_cells,
    warnings,
    budget: {
      usd_all_in: suite.budget_usd,
      surcharge_applied: surcharge,
      priced_coverage: cells.length === 0 ? 0 : pricedCells / cells.length,
      surcharge_formula_version: SURCHARGE_FORMULA_VERSION,
    },
  };
}

function expandSelector(
  selector: readonly string[] | string,
  input: RegistrationInput,
): string[] {
  if (Array.isArray(selector)) return [...selector];
  const m = /^tier=(sentinel|full|adhoc)$/.exec(selector);
  if (m === null) {
    throw new RegistrationError(`bad scenario selector ${JSON.stringify(selector)}`);
  }
  const tier = m[1] as 'sentinel' | 'full' | 'adhoc';
  // The shipped run-all semantics: exact tier match (src/run-all/matrix.ts).
  return input.scenarios.filter((s) => s.tier === tier).map((s) => s.name);
}

/** The eligibility rejection matrix (R-REG-9/10/12/13/14/15/16) applied per
 *  cell; returns the first reason or null. All fail-closed, loud-recorded. */
function rejectCell(
  input: RegistrationInput,
  scen: ScenarioIntake,
  armNames: readonly string[],
  cellKey: string,
): string | null {
  const { suite, arms, credentials, campaignOs } = input;
  const gating = suite.kind === 'gating';
  // R-REG-16: requires_superpowers conflict drops the scenario for this
  // comparison (both arms), named in excluded_cells.
  if (scen.requires_superpowers && armNames.some((a) => arms[a]?.superpowers === 'none')) {
    return `scenario requires_superpowers conflicts with a superpowers: none arm (R-REG-16)`;
  }
  for (const armName of armNames) {
    const armDef = arms[armName];
    if (armDef === undefined) return `arm ${armName} not in arms/ intake`;
    const cred = credentials[armDef.credential];
    if (cred === undefined) return `arm ${armName} credential ${armDef.credential} not in credentials.yaml`;
    // R-REG-10: os: windows parses, then rejects.
    if (armDef.os === 'windows') {
      return `arm ${armName} targets os windows — a registration error (parent non-goal)`;
    }
    // R-REG-14: arm os unsupported by the agent, credential, or scenario
    // directives.
    const armOs = armDef.os ?? campaignOs;
    const agentOs = input.agentOsSupport(armDef.agent);
    if (agentOs !== undefined && !agentOs.includes(armOs)) {
      return `arm ${armName} os ${armOs} unsupported by agent ${armDef.agent} (supports: ${agentOs.join(', ')})`;
    }
    if (cred.os_support !== undefined && !cred.os_support.includes(armOs)) {
      return `arm ${armName} os ${armOs} unsupported by credential ${armDef.credential}`;
    }
    if (scen.os !== undefined && !scen.os.includes(armOs)) {
      return `arm ${armName} os ${armOs} unsupported by scenario directive (${scen.os.join(', ')})`;
    }
    // R-REG-9: none/ref arms on adapters without the capability.
    const cap = input.capability(input.agentFamily(armDef.agent));
    if (armDef.superpowers === 'none' ? !cap.none : !cap.ref) {
      return `arm ${armName} superpowers mode ${JSON.stringify(armDef.superpowers)} lacks adapter capability (default-deny registry)`;
    }
    // R-REG-15: seat/subscription auth in gating suites — mechanical, no
    // operator override.
    if (gating && cred.auth !== 'api-key') {
      return `arm ${armName} credential ${armDef.credential} auth=${cred.auth} in a gating suite (api-key required, no override)`;
    }
  }
  // R-REG-13: minimum-feasible-launch feasibility — cap-1 pools facing
  // two-arm same-pool demand, spacing that cannot co-launch, and demand
  // exceeding the registered caps.
  if (armNames.length === 2) {
    const [a, b] = armNames as readonly [string, string];
    const armA = arms[a];
    const armB = arms[b];
    const credA = armA !== undefined ? credentials[armA.credential] : undefined;
    const credB = armB !== undefined ? credentials[armB.credential] : undefined;
    if (armA === undefined || armB === undefined || credA === undefined || credB === undefined) {
      return `comparison names an arm or credential missing from the intake (R-REG-2 fail-closed)`;
    }
    const poolA = poolKey(credA, armA.credential);
    const poolB = poolKey(credB, armB.credential);
    if (poolA === poolB) {
      const cap = credA.max_concurrency ?? 1;
      if (cap < 2) {
        return `comparison infeasible pre-spend: cap-${cap} pool ${poolA} faces two-arm same-pool demand (R-REG-13)`;
      }
      if ((credA.launch_spacing_seconds ?? 0) > 0) {
        return `comparison infeasible pre-spend: launch spacing ${credA.launch_spacing_seconds}s on shared pool ${poolA} cannot co-launch both arms (R-REG-13)`;
      }
    }
    if (input.globalCap < 2) {
      return `comparison infeasible pre-spend: global_run_cap ${input.globalCap} < two-sample block demand (R-REG-13)`;
    }
  }
  // R-REG-12: usd-denominated profile parameters when any arm is unpriceable.
  const usdParams = Object.keys(suite.profile_params ?? {}).filter(
    (key) => key.endsWith('_usd') || key.startsWith('usd_'),
  );
  if (usdParams.length > 0) {
    const unpriceable = armNames.some((armName) => {
      const armDef = arms[armName];
      if (armDef === undefined) return true; // unknown arm: unpriceable, fail-closed
      const lookup = lookupEstimate(input.estimates, {
        scenario: scen.name,
        agent: armDef.agent,
        credential: armDef.credential,
        os: campaignOs,
      });
      const hasOverride = (input.pricingOverrides ?? []).some((o) => o.arm === armName);
      return lookup.cost_total_usd === null && !hasOverride;
    });
    if (unpriceable) {
      return `usd-denominated profile parameters (${usdParams.join(', ')}) with an unpriceable arm (R-REG-12)`;
    }
  }
  return null;
}

function checkProfileParams(suite: Suite): void {
  if (suite.profile === undefined) return;
  const schema = profileParamsSchema(suite.profile);
  if (schema === undefined) {
    throw new RegistrationError(`unknown profile ${suite.profile}`);
  }
  const result = schema.safeParse(suite.profile_params ?? {});
  if (!result.success) {
    throw new RegistrationError(`profile_params fail the ${suite.profile} registry schema: ${result.error.message}`);
  }
  // R-REG-18: mde_by_scenario must cover every scenario carrying
  // confirmatory cells (checked after grid expansion would duplicate the
  // loop; the confirmatory set comes from the suite's cell overrides).
  if (suite.profile === 'release_gate_v1') {
    const params = result.data as { mde_by_scenario: Record<string, number> };
    const confirmatoryScenarios = new Set<string>();
    for (const comparison of suite.comparisons) {
      const cells = 'cells' in comparison ? comparison.cells : undefined;
      for (const [scenario, cell] of Object.entries(cells ?? {})) {
        if (cell.class === 'confirmatory') confirmatoryScenarios.add(scenario);
      }
    }
    for (const scenario of confirmatoryScenarios) {
      if (params.mde_by_scenario[scenario] === undefined) {
        throw new RegistrationError(
          `profile_params.mde_by_scenario missing confirmatory scenario ${scenario} (R-REG-18)`,
        );
      }
    }
  }
}

function checkKeyEnvPresence(input: RegistrationInput): void {
  // R-REG-19 (registration half): every arm credential and the grader
  // credential — api_key_env (or every key_pool entry) present in the
  // environment, else registration refuses.
  const missing: string[] = [];
  const checked = new Set<string>();
  const checkOne = (name: string, cred: Credential | undefined) => {
    if (cred === undefined || checked.has(name) || cred.auth !== 'api-key') return;
    checked.add(name);
    const envNames = cred.key_pool ?? (cred.api_key_env !== undefined ? [cred.api_key_env] : []);
    if (envNames.length === 0) {
      missing.push(`${name}: api-key auth with no api_key_env/key_pool`);
      return;
    }
    for (const envName of envNames) {
      const value = input.env(envName);
      if (value === undefined || value === '') missing.push(envName);
    }
  };
  for (const armDef of Object.values(input.arms)) {
    checkOne(armDef.credential, input.credentials[armDef.credential]);
  }
  checkOne(input.grader.credential, input.credentials[input.grader.credential]);
  if (missing.length > 0) {
    throw new RegistrationError(
      `key env preflight failed — unset or missing: ${[...new Set(missing)].join(', ')} (R-REG-19; re-checked at every live-spend-lock acquisition)`,
    );
  }
}
```

(`checkKeyEnvPresence` reads `input.env` and `checkEstimateStaleness` reads `input.nowMs` — both declared on `RegistrationInput` above. The Step 5 fixture builder supplies them; see Step 8.)

```ts
function checkEstimateStaleness(input: RegistrationInput): void {
  // R-REG-21: the mechanical staleness rule — the newest included run is
  // >30 days older than the build; artifact.generated_at IS the newest
  // included run's finished_at (data-derived), so compare it against
  // registration time. The process half (rebuild after every sealed gating
  // campaign) is not observable here and rides the refusal text.
  const generatedMs = Date.parse(input.estimates.generated_at);
  if (!Number.isFinite(generatedMs)) {
    throw new RegistrationError(`estimates artifact generated_at unparseable: ${input.estimates.generated_at}`);
  }
  if (input.nowMs - generatedMs > ESTIMATE_STALE_AFTER_MS) {
    throw new RegistrationError(
      `estimates artifact is stale (generated ${input.estimates.generated_at}, >30 days before registration) — rebuild: quorum campaign acquire + quorum campaign estimates (R-REG-21; rebuild after every sealed gating campaign)`,
    );
  }
}

function graderAndPoolWarnings(input: RegistrationInput): string[] {
  const warnings: string[] = [];
  const gating = input.suite.kind === 'gating';
  const graderCred = input.credentials[input.grader.credential];
  if (graderCred !== undefined) {
    const graderCap =
      graderCred.max_concurrency ??
      (graderCred.key_pool !== undefined ? graderCred.key_pool.length * 5 : 1);
    if (gating && graderCap < 15) {
      warnings.push(
        `grader pool cap ${graderCap} < 15 in a gating suite — every 8h-clearing Phase 0 configuration had cap >= 15 (R-REG-20 warning)`,
      );
    }
  }
  for (const [name, cred] of Object.entries(input.credentials)) {
    if (cred.key_pool !== undefined && cred.max_concurrency !== undefined) {
      if (cred.max_concurrency > cred.key_pool.length * 5) {
        warnings.push(
          `credential ${name}: key_pool max_concurrency ${cred.max_concurrency} exceeds key_pool.length x 5 (${cred.key_pool.length * 5}) — the single-key cap 5 Phase 0 modeled (R-REG-7 warning)`,
        );
      }
    }
  }
  return warnings;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test test/campaign-registration.test.ts`
Expected: PASS (10 tests). The Step 5 fixture `input()` already supplies `env` and `nowMs`.

- [ ] **Commit (task 5b)**

```bash
git add src/campaign/registration.ts test/campaign-registration.test.ts
git commit -m "feat(campaign): D3 registration grid — expansion, rejection matrix, E1/E2 pricing, digest"
```

#### Task 5c: contention declarations (Steps 9–11; covers Decision D-4's declaration digest members + the registered thresholds/cadence the sensors consume)

**Files:** modify `src/campaign/registration.ts` (append the contention-declaration builder); append to `test/campaign-registration.test.ts`.

- [ ] **Step 9: Write the failing contention-declaration tests** — append to `test/campaign-registration.test.ts`:

```ts
import { buildContentionBlock, defaultContentionThresholds } from '../src/campaign/registration.ts';

const GiB = 2 ** 30;

test('the five pinned D-4 threshold defaults derive from the fingerprint', () => {
  const thresholds = defaultContentionThresholds({
    mem_bytes: 16 * GiB,
    swap_total_bytes: 4 * GiB,
    disk_total_bytes: 100 * GiB,
  });
  expect(thresholds).toEqual([
    { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2.0 },
    { metric: 'mem_available_bytes', source: 'host', op: 'lt', value: Math.max(2 * GiB, 0.1 * 16 * GiB), relative_of: 'mem_bytes' },
    { metric: 'swap_used_bytes', source: 'host', op: 'gt', value: 0.25 * 4 * GiB, relative_of: 'swap_total_bytes' },
    { metric: 'disk_free_bytes', source: 'host', op: 'lt', value: Math.max(5 * GiB, 0.15 * 100 * GiB), relative_of: 'disk_total_bytes' },
    { metric: 'process_count', source: 'host', op: 'gt', value: 800_000, relative_of: 'pid_table' },
  ]);
});

test('buildContentionBlock freezes G, thresholds, sampler parameters, tolerances (digest members)', () => {
  const block = buildContentionBlock({
    fingerprint: { cpu_model: 'Apple M1', cpu_cores: 8, mem_bytes: 16 * GiB, disk_total_bytes: 100 * GiB },
    globalCap: 24,
    thresholds: defaultContentionThresholds({ mem_bytes: 16 * GiB, swap_total_bytes: 4 * GiB, disk_total_bytes: 100 * GiB }),
  });
  expect(block).toEqual({
    host_fingerprint: { cpu_model: 'Apple M1', cpu_cores: 8, mem_bytes: 16 * GiB, disk_total_bytes: 100 * GiB },
    global_run_cap: 24,
    thresholds: block.thresholds,
    cadence_ms: 10_000,
    sustain_k: 3,
    coverage_n: 4,
    mem_tolerance_pct: 10,
    disk_tolerance_pct: 10,
  });
});
```

- [ ] **Step 10: Implement the contention declarations** — append to `src/campaign/registration.ts`:

```ts
import { PID_MAX_SLOTS } from './host-stats.ts';
import type { ContentionThreshold, ContentionDeclaration, HostFingerprint } from '../contracts/campaign/campaign.ts';

/** Decision D-4 defaults (drafted for gate challenge; the parent pins the
 *  obligation, not the numbers): absolute floor paired with the relative
 *  band; hysteresis lives solely in the frozen sustain_k. */
export function defaultContentionThresholds(args: {
  mem_bytes: number;
  swap_total_bytes: number;
  disk_total_bytes: number;
}): ContentionThreshold[] {
  return [
    { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2.0 },
    {
      metric: 'mem_available_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(2 * 2 ** 30, 0.1 * args.mem_bytes),
      relative_of: 'mem_bytes',
    },
    {
      metric: 'swap_used_bytes',
      source: 'host',
      op: 'gt',
      value: 0.25 * args.swap_total_bytes,
      relative_of: 'swap_total_bytes',
    },
    {
      metric: 'disk_free_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(5 * 2 ** 30, 0.15 * args.disk_total_bytes),
      relative_of: 'disk_total_bytes',
    },
    {
      metric: 'process_count',
      source: 'host',
      op: 'gt',
      value: 0.8 * PID_MAX_SLOTS,
      relative_of: 'pid_table',
    },
  ];
}

export function buildContentionBlock(args: {
  fingerprint: HostFingerprint;
  globalCap: number;
  thresholds: ContentionThreshold[];
  cadenceMs?: number;
  sustainK?: number;
  coverageN?: number;
  memTolerancePct?: number;
  diskTolerancePct?: number;
}): ContentionDeclaration {
  return {
    host_fingerprint: args.fingerprint,
    global_run_cap: args.globalCap,
    thresholds: args.thresholds,
    cadence_ms: args.cadenceMs ?? 10_000,
    sustain_k: args.sustainK ?? 3,
    coverage_n: args.coverageN ?? 4,
    mem_tolerance_pct: args.memTolerancePct ?? 10,
    disk_tolerance_pct: args.diskTolerancePct ?? 10,
  };
}
```

(`ContentionThreshold` / `ContentionDeclaration` / `HostFingerprint` are the zod-inferred types of the schemas Task 1 added to `campaign.ts`; `HostFingerprint` is also exported as an interface from `host-stats.ts` — use the `host-stats.ts` interface as the value shape and let the zod schema parse it in `buildContentionBlock`'s caller.)

- [ ] **Step 11: Run tests to verify they pass**

Run: `bun test test/campaign-registration.test.ts`
Expected: PASS (12 tests).

**Ordering resolution (Design note 4 — recorded, flagged in the report):** Decision D-6 names the campaign dir `<digest-prefix>-<suite-name>`, P-4 pins materialization AT the final path, and Blocker C pins intake FROM the snapshot — but the digest depends on the grid, which depends on intake. The circle breaks because the frozen-SHA CONTENT is readable before materialization: registration reads scenarios, agent YAMLs (`coding-agents/`), `credentials.yaml`, and `arms/` from the resolved evals SHA through the git object store (`git ls-tree` + `git show <sha>:<path>` via the `CommandRunner` seam — never the mutable working tree, which is Blocker C's point), computes the grid + digest, chooses the final `<digest-prefix>-<suite>` dir with the D-6 collision rules, materializes the snapshot there exactly once (P-4 step 1), then RE-VERIFIES the materialized tree against the intake bytes (fail-closed mismatch = corruption), probes the child contract, and publishes. The spec's Blocker-C order line ("choose/lock the final campaign-dir path → materialize → read ... from the snapshot's evals tree") is satisfied in substance: every intake byte is snapshot-SHA content, and the materialized final-path tree is verified byte-identical for the intake files before publication.

- [ ] **Commit (task 5c)**

```bash
git add src/campaign/registration.ts test/campaign-registration.test.ts
git commit -m "feat(campaign): D3 contention declarations — registered thresholds, cadence, fingerprint digest members"
```

#### Task 5d: `registerCampaign` orchestration + publication (Steps 12–16; covers R-REG-5/6/8/19/22 + the P-4 publication order and snapshot-first intake)

**Files:** modify `src/campaign/registration.ts` (append `registerCampaign` + intake + publication); append to `test/campaign-registration.test.ts`; modify `.gitignore`.

- [ ] **Step 12: Write the failing registerCampaign orchestration tests** — append to `test/campaign-registration.test.ts`. These drive the real flow with REAL tmp git repos (house pattern: `test/provenance.test.ts` tmp-git setup) and injected clock/identity/probe:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultCommandRunner, type CommandOptions, type CommandResult, type CommandRunner } from '../src/agents/command-runner.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { HostStats, HostStatsProbe } from '../src/campaign/host-stats.ts';
import { MINIMUM_CHILD_CONTRACT_SHA, registerCampaign, type RegisterArgs } from '../src/campaign/registration.ts';

const LOCAL_IDENTITY: ProcessIdentityProbe = { exists: () => 'alive', startTimeMs: () => 1 };
const FAKE_STATS: HostStats = {
  ts_ms: 0, load1: 0.1,
  mem_available_bytes: 8 * GiB, mem_total_bytes: 16 * GiB,
  swap_used_bytes: 0, swap_total_bytes: 4 * GiB,
  process_count: 200, disk_free_bytes: 50 * GiB, disk_total_bytes: 100 * GiB,
};
const FAKE_PROBE: HostStatsProbe = { sample: (nowMs) => ({ ...FAKE_STATS, ts_ms: nowMs }) };

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A real tmp evals checkout at one commit: arms/, credentials.yaml,
 *  coding-agents/claude.yaml, scenarios/scn-a, and a stub CLI entrypoint. */
function evalsRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'evals-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'credentials.yaml'), [
    'cred_a:', '  model: test-model', '  harnesses: [claude]', '  api: anthropic',
    '  auth: api-key', '  api_key_env: TEST_KEY',
    'cred_b:', '  model: test-model', '  harnesses: [claude]', '  api: anthropic',
    '  auth: api-key', '  api_key_env: TEST_KEY_B', '',
  ].join('\n'));
  mkdirSync(join(dir, 'arms'), { recursive: true });
  writeFileSync(join(dir, 'arms', 'arm_a.yaml'), [
    'schema_version: 1', 'name: arm_a', 'agent: claude', 'credential: cred_a', 'superpowers: none', '',
  ].join('\n'));
  writeFileSync(join(dir, 'arms', 'arm_b.yaml'), [
    'schema_version: 1', 'name: arm_b', 'agent: claude', 'credential: cred_b', 'superpowers: none', '',
  ].join('\n'));
  mkdirSync(join(dir, 'coding-agents'), { recursive: true });
  writeFileSync(join(dir, 'coding-agents', 'claude.yaml'), [
    'name: claude', 'runtime_family: claude', 'model: claude-test',
    'home_config_subdir: .claude', 'session_log_dir: .claude/projects', 'default_credential: cred_a', '',
  ].join('\n'));
  mkdirSync(join(dir, 'scenarios', 'scn-a'), { recursive: true });
  writeFileSync(join(dir, 'scenarios', 'scn-a', 'story.md'), '---\nquorum_tier: full\n---\nDo the thing.\n');
  writeFileSync(join(dir, 'scenarios', 'scn-a', 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  writeFileSync(join(dir, 'scenarios', 'scn-a', 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cli', 'index.ts'), "if (process.argv.includes('--version')) console.log('quorum-test 0.0.0');\n");
  commitWithLockfile(dir); // the snapshot's bun install --frozen-lockfile needs a committed lockfile
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Give a fixture repo a dependency-less package.json + lockfile and commit
 *  everything — materializeEvalsSnapshot runs `bun install
 *  --frozen-lockfile` in every checked-out tree. */
function commitWithLockfile(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  const installed = spawnSync('bun', ['install'], { cwd: dir, encoding: 'utf8' });
  if (installed.status !== 0) throw new Error(`fixture bun install failed: ${installed.stderr}`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
}

function gauntletRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'gauntlet fixture\n');
  commitWithLockfile(dir);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Real runner everywhere EXCEPT the merge-base child-contract check, which
 *  the fixture repo cannot contain (the real D2 merge SHA). The fake answers
 *  that one call; everything else runs for real. */
function probeRunner(mergeBaseStatus: 0 | 1): CommandRunner {
  return {
    run(command: string, args: readonly string[], options?: CommandOptions): CommandResult {
      if (command === 'git' && args.includes('merge-base')) {
        return { status: mergeBaseStatus, stdout: '', stderr: mergeBaseStatus === 0 ? '' : 'not an ancestor\n' };
      }
      return defaultCommandRunner.run(command, args, options);
    },
  };
}

const SUITE_RAW = [
  'schema_version: 1', 'name: testsuite', 'kind: exploratory', 'budget_usd: 100',
  'grader: { credential: cred_a, model: grader-model }',
  'comparisons:', '  - baseline: arm_a', '    treatment: arm_b',
  '    scenarios: [scn-a]', '    n: 1', '',
].join('\n');

function registerArgs(overrides: Partial<RegisterArgs> = {}): RegisterArgs {
  const evals = evalsRepo();
  const gauntlet = gauntletRepo();
  return {
    suitePath: 'suites/testsuite.yaml',
    suiteRaw: SUITE_RAW,
    campaignsRoot: mkdtempSync(join(tmpdir(), 'campaigns-')),
    estimates: estimates(),
    globalCap: 8,
    confirm: true,
    dryRun: false,
    evalsCheckout: evals.dir,
    evalsRef: evals.sha,
    gauntletCheckout: gauntlet.dir,
    gauntletRef: gauntlet.sha,
    superpowersCheckout: mkdtempSync(join(tmpdir(), 'sp-')),
    runner: probeRunner(0),
    clock: new FakeClock(1),
    identity: LOCAL_IDENTITY,
    probe: FAKE_PROBE,
    env: () => 'set',
    registeredBy: 'test',
    nowMs: Date.parse('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}

test('registerCampaign: snapshot-first intake, digest dir naming, P-4 publication order', () => {
  const result = registerCampaign(registerArgs());
  expect(result.published).toBe(true);
  expect(result.campaign_id).toBe(result.digest);
  // Dir name = first-8 digest hex + suite name (Decision D-6).
  expect(result.campaignDir.endsWith(`${result.digest.slice(0, 8)}-testsuite`)).toBe(true);
  // Publication artifacts all present; campaign.json is the readiness marker.
  for (const f of ['journal.db', 'contention-telemetry.jsonl', '.ballast', 'campaign.json', '.quorum-snapshot-ok']) {
    expect(existsSync(join(result.campaignDir, f))).toBe(true);
  }
  const doc = JSON.parse(readFileSync(join(result.campaignDir, 'campaign.json'), 'utf8'));
  expect(doc.digest).toBe(result.digest);
  expect(doc.contention.global_run_cap).toBe(8);
  expect(doc.grader).toEqual({ credential: 'cred_a', model: 'grader-model' });
  expect(doc.execution_surface.map((a: { name: string }) => a.name).sort()).toEqual(['arm_a', 'arm_b']);
  // Snapshot landed at the campaign dir itself (Decision D-6).
  expect(existsSync(join(result.campaignDir, 'evals', 'credentials.yaml'))).toBe(true);
  // Operator surface: digest + derived max-block reading (Decision D-1).
  expect(result.printed).toMatch(new RegExp(`digest: ${result.digest}`));
  expect(result.printed).toContain('global_run_cap = 8 per-sample slots');
  expect(result.printed).toContain('max contemporaneous two-arm blocks = 4');
});

test('idempotent re-registration: same input -> same digest -> same dir, no republish', () => {
  const args = registerArgs();
  const first = registerCampaign(args);
  const second = registerCampaign(args);
  expect(second.campaignDir).toBe(first.campaignDir);
  expect(second.digest).toBe(first.digest);
  expect(second.published).toBe(false); // re-opening validates digest equality only
});

test('dry-run prints grid + exclusions + digest, never writes', () => {
  const result = registerCampaign(registerArgs({ dryRun: true }));
  expect(result.published).toBe(false);
  expect(result.campaignDir).toBe('');
  expect(result.printed).toMatch(/digest: [0-9a-f]{64}/);
});

test('without --confirm: print-and-exit path, never prompts (noninteractive)', () => {
  const result = registerCampaign(registerArgs({ confirm: false }));
  expect(result.published).toBe(false);
  expect(result.campaignDir).toBe('');
  expect(result.printed).toMatch(/global_run_cap = 8/);
});

test('child-contract probe refuses an evals SHA below the minimum commit', () => {
  expect(() => registerCampaign(registerArgs({ runner: probeRunner(1) }))).toThrow(
    new RegExp(MINIMUM_CHILD_CONTRACT_SHA.slice(0, 12)),
  );
});

test('intake bytes come from the frozen SHA, and the materialized tree is verified against them', () => {
  // Mutate the working tree AFTER the fixture commit: registration must not
  // see the mutation (intake is git-object content at the resolved SHA).
  const args = registerArgs();
  writeFileSync(join(args.evalsCheckout, 'credentials.yaml'), 'corrupted: true\n');
  const result = registerCampaign(args);
  expect(result.published).toBe(true);
  const materialized = readFileSync(join(result.campaignDir, 'evals', 'credentials.yaml'), 'utf8');
  expect(materialized).toContain('cred_a:');
  expect(materialized).not.toContain('corrupted');
});
```

- [ ] **Step 13: Run tests to verify they fail**

Run: `bun test test/campaign-registration.test.ts`
Expected: FAIL — `registerCampaign` not found.

- [ ] **Step 14: Implement `registerCampaign`** — append to `src/campaign/registration.ts`:

```ts
export interface RegisterArgs {
  readonly suitePath: string;
  readonly suiteRaw: string;
  readonly campaignsRoot: string;
  readonly estimates: EstimatesArtifact;
  readonly globalCap: number;
  readonly confirm: boolean;
  readonly dryRun: boolean;
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
  readonly evalsRef: string;
  readonly gauntletRef: string;
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  readonly probe: HostStatsProbe;
  readonly env: (key: string) => string | undefined;
  readonly registeredBy: string;
  readonly nowMs: number;
}

export interface RegisterResult {
  readonly campaign_id: string;
  readonly digest: string;
  /** '' until the dir exists (dry-run / print-and-exit). */
  readonly campaignDir: string;
  readonly published: boolean;
  readonly dryRun: boolean;
  readonly printed: string;
  readonly excluded_cells: { cell: string; reason: string }[];
  readonly warnings: string[];
}

interface SnapshotIntake {
  readonly arms: Record<string, Arm>;
  readonly credentials: Record<string, Credential>;
  readonly scenarios: ScenarioIntake[];
  readonly agentConfigsDir: string;
  /** Relative path -> frozen-SHA content, for post-materialization verify. */
  readonly files: Record<string, string>;
}

function gitOutText(runner: CommandRunner, args: readonly string[]): string {
  const res = runner.run('git', [...args], {
    env: { PATH: getEnv('PATH'), HOME: getEnv('HOME'), TMPDIR: getEnv('TMPDIR') },
  });
  if (res.status !== 0) {
    throw new RegistrationError(`git ${args.join(' ')} failed (${res.status}): ${res.stderr.trim()}`);
  }
  return res.stdout;
}

/** Blocker C intake: scenarios, agent YAMLs, credentials.yaml, and arms read
 *  from the resolved evals SHA through the git OBJECT STORE — never the
 *  mutable working tree. Files land in a scratch dir so the shipped
 *  path-based frontmatter readers (readQuorumTier etc.) apply unchanged. */
function readSnapshotIntake(
  evalsCheckout: string,
  evalsSha: string,
  runner: CommandRunner,
): SnapshotIntake {
  const listing = gitOutText(runner, ['-C', evalsCheckout, 'ls-tree', '-r', '--name-only', evalsSha]);
  const paths = listing.split('\n').filter((p) => p !== '');
  const scratch = mkdtempSync(join(tmpdir(), 'intake-'));
  const files: Record<string, string> = {};
  const readAt = (rel: string): string => {
    const content = gitOutText(runner, ['-C', evalsCheckout, 'show', `${evalsSha}:${rel}`]);
    files[rel] = content;
    const dest = join(scratch, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    return content;
  };
  const arms: Record<string, Arm> = {};
  for (const p of paths.filter((x) => /^arms\/[^/]+\.yaml$/.test(x))) {
    const arm = ArmSchema.parse(parseYaml(readAt(p)));
    arms[arm.name] = arm;
  }
  const credentials = parseCredentialsFile(parseYaml(readAt('credentials.yaml')));
  const scenarios: ScenarioIntake[] = [];
  for (const p of paths.filter((x) => /^scenarios\/[^/]+\/story\.md$/.test(x))) {
    const name = p.split('/')[1] ?? '';
    if (name === '') continue; // unreachable by the path regex; keeps the type sound
    readAt(p);
    const setup = `scenarios/${name}/setup.sh`;
    const checks = `scenarios/${name}/checks.sh`;
    if (paths.includes(setup)) readAt(setup);
    if (paths.includes(checks)) readAt(checks);
    const storyPath = join(scratch, p);
    const tier = readQuorumTier(storyPath);
    const requires = readRequiresSuperpowers(storyPath) ?? false;
    const coupling = readCoupling(storyPath) ?? scanCouplingDefault(join(scratch, 'scenarios', name));
    scenarios.push({ name, tier, requires_superpowers: requires, coupling, os: undefined });
  }
  for (const p of paths.filter((x) => /^coding-agents\/[^/]+\.yaml$/.test(x))) readAt(p);
  return { arms, credentials, scenarios, agentConfigsDir: join(scratch, 'coding-agents'), files };
}

/** Post-materialization guard: the materialized evals tree must be
 *  byte-identical to the intake bytes for every file the grid consumed —
 *  fail-closed mismatch is corruption, never ignored. */
function verifyIntakeMatch(intake: SnapshotIntake, evalsRoot: string): void {
  for (const [rel, content] of Object.entries(intake.files)) {
    const onDisk = readFileSync(join(evalsRoot, rel), 'utf8');
    if (onDisk !== content) {
      throw new RegistrationError(
        `materialized snapshot drifted from intake bytes at ${rel} — refusing publication (fail-closed)`,
      );
    }
  }
}

function probeChildContract(evalsRoot: string, evalsSha: string, args: RegisterArgs): void {
  const minimalEnv = { PATH: getEnv('PATH'), HOME: getEnv('HOME'), TMPDIR: getEnv('TMPDIR') };
  const version = args.runner.run(
    'bun',
    [join(evalsRoot, 'src', 'cli', 'index.ts'), '--version'],
    { cwd: evalsRoot, env: minimalEnv },
  );
  if (version.status !== 0) {
    throw new RegistrationError(
      `child-contract probe failed: bun ${evalsRoot}/src/cli/index.ts --version exited ${version.status}: ${version.stderr.trim()} (REV fable I-12)`,
    );
  }
  const ancestor = args.runner.run(
    'git',
    ['-C', args.evalsCheckout, 'merge-base', '--is-ancestor', MINIMUM_CHILD_CONTRACT_SHA, evalsSha],
    { env: minimalEnv },
  );
  if (ancestor.status !== 0) {
    throw new RegistrationError(
      `evals ref ${evalsSha} predates the minimum child-contract commit ${MINIMUM_CHILD_CONTRACT_SHA} (D2's implementation merge) — refusing registration (REV fable I-12)`,
    );
  }
}

type CandidateClass =
  | { kind: 'absent' }
  | { kind: 'published'; digest: string }
  | { kind: 'incomplete'; openedDigest: string | null }
  | { kind: 'shell' }
  | { kind: 'ambiguous' };

/** Decision D-6 / Round-4 S-8 classification: published campaign.json
 *  supplies the candidate's full digest; an incomplete dir's first
 *  campaign_opened supplies it when readable; a digest-less dir is reusable
 *  only when nothing records spend; else ambiguous (prefix extends, loud
 *  orphan note). */
function classifyCandidate(candidate: string): CandidateClass {
  if (!existsSync(candidate)) return { kind: 'absent' };
  const campaignJson = join(candidate, 'campaign.json');
  if (existsSync(campaignJson)) {
    const doc = JSON.parse(readFileSync(campaignJson, 'utf8')) as { digest?: string };
    if (typeof doc.digest !== 'string') return { kind: 'ambiguous' };
    return { kind: 'published', digest: doc.digest };
  }
  const journalDb = join(candidate, 'journal.db');
  let openedDigest: string | null = null;
  let eventCount = 0;
  if (existsSync(journalDb)) {
    const reader = openJournalRead(candidate);
    try {
      const events = reader.readEvents();
      eventCount = events.length;
      const opened = events[0];
      if (opened !== undefined && opened.type === 'campaign_opened') {
        openedDigest = opened.payload.digest;
      }
    } finally {
      reader.close();
    }
  }
  const spendArtifacts = ['cancel-request', '.storage-paused'].some((f) =>
    existsSync(join(candidate, f)),
  );
  if (openedDigest !== null) return { kind: 'incomplete', openedDigest };
  if (eventCount === 0 && !spendArtifacts) return { kind: 'shell' };
  return { kind: 'ambiguous' };
}

export function registerCampaign(args: RegisterArgs): RegisterResult {
  const printed: string[] = [];
  const emit = (line: string): void => {
    printed.push(line);
  };

  // 1. Suite + grader intake (Design note 1): the grader block is extracted
  //    BEFORE the strict SuiteSchema parse.
  const raw = parseYaml(args.suiteRaw) as Record<string, unknown>;
  const graderRaw = raw['grader'] as { credential?: string; model?: string } | undefined;
  if (
    graderRaw === undefined ||
    typeof graderRaw.credential !== 'string' ||
    typeof graderRaw.model !== 'string'
  ) {
    throw new RegistrationError(
      `${args.suitePath}: suite must declare grader: { credential, model } — the campaign grader is registered singular (R-REG-20)`,
    );
  }
  const graderDecl = { credential: graderRaw.credential, model: graderRaw.model };
  const { grader: _stripped, ...suiteFields } = raw;
  const suite = SuiteSchema.parse(suiteFields);
  assertIdComponent(suite.name, 'suite name');

  // 2. Ref resolution to 40-hex SHAs (R-REG-8).
  const evalsSha = resolveSuperpowersRef(
    { path: args.evalsCheckout, remote: 'origin' },
    args.evalsRef,
    args.runner,
  );
  const gauntletSha = resolveSuperpowersRef(
    { path: args.gauntletCheckout, remote: 'origin' },
    args.gauntletRef,
    args.runner,
  );

  const lease = acquireLease({
    lockPath: join(args.campaignsRoot, 'registration.lock.d'),
    clock: args.clock,
    identity: args.identity,
    label: 'registration lease',
  });
  try {
    // 3. Snapshot-first intake from the frozen evals SHA (Design note 4).
    const intake = readSnapshotIntake(args.evalsCheckout, evalsSha, args.runner);

    // Per-arm superpowers ref resolution (null for 'none').
    const superpowers_by_arm: Record<string, string | null> = {};
    for (const armDef of Object.values(intake.arms)) {
      superpowers_by_arm[armDef.name] =
        armDef.superpowers === 'none'
          ? null
          : resolveSuperpowersRef(
              { path: args.superpowersCheckout, remote: 'origin' },
              armDef.superpowers,
              args.runner,
            );
    }

    // 4. Grid + rejections + pricing (pure core).
    const prepared = prepareRegistration({
      suite,
      arms: intake.arms,
      credentials: intake.credentials,
      grader: graderDecl,
      estimates: args.estimates,
      capability: (family) => superpowersCapability(family),
      agentOsSupport: (agent) =>
        loadAgentConfigForValidation(intake.agentConfigsDir, agent).os_support,
      agentFamily: (agent) =>
        agentRuntimeFamily(loadAgentConfigForValidation(intake.agentConfigsDir, agent)),
      scenarios: intake.scenarios,
      globalCap: args.globalCap,
      campaignOs: 'linux',
      env: args.env,
      nowMs: args.nowMs,
    });

    // 5. Contention declarations (Decision D-3/D-4, task 5 obligation).
    const nowMs = clockNowMs(args.clock);
    const stats = args.probe.sample(nowMs);
    const fingerprint = probeFingerprint(args.probe, nowMs);
    const contention = buildContentionBlock({
      fingerprint,
      globalCap: args.globalCap,
      thresholds: defaultContentionThresholds({
        mem_bytes: stats.mem_total_bytes,
        swap_total_bytes: stats.swap_total_bytes,
        disk_total_bytes: stats.disk_total_bytes,
      }),
    });

    // 6. Execution surface (scrubbed, secret-free — env-var NAMES only).
    const execution_surface = Object.values(intake.arms).map((armDef) => {
      const cred = intake.credentials[armDef.credential];
      return {
        name: armDef.name,
        agent: armDef.agent,
        credential: armDef.credential,
        auth: cred?.auth ?? 'api-key',
        api: cred?.api ?? 'openai-chat',
        ...(cred?.base_url !== undefined ? { base_url: cred.base_url } : {}),
        model: cred?.model ?? '',
        key_env_names: cred?.key_pool ?? (cred?.api_key_env !== undefined ? [cred.api_key_env] : []),
      };
    });

    // 7. Campaign document + digest (R-REG-4).
    const preDigest: PreDigestCampaign = {
      schema_version: 1,
      campaign_id: 'pending',
      suite,
      refs: { superpowers_by_arm, evals: evalsSha, gauntlet: gauntletSha },
      grader: graderDecl,
      cells: prepared.cells,
      excluded_cells: prepared.excluded_cells,
      samples: prepared.samples,
      comparisons: prepared.comparisons,
      blocks: prepared.blocks,
      budget: prepared.budget,
      registered_at: new Date(args.nowMs).toISOString(),
      registered_by: args.registeredBy,
      contention,
      execution_surface,
    };
    const digest = campaignDigest(preDigest);
    const campaign_id = digest; // identity = digest

    // 8. Confirmation output (R-REG-22 + Decision D-1 max-block reading).
    emit(`campaign ${suite.name}`);
    emit(`grid: ${prepared.cells.length} cells, ${prepared.samples.length} samples, ${prepared.blocks.length} blocks`);
    emit(`budget: $${prepared.budget.usd_all_in} all-in (surcharge $${prepared.budget.surcharge_applied}, priced coverage ${prepared.budget.priced_coverage})`);
    for (const exclusion of prepared.excluded_cells) {
      emit(`excluded ${exclusion.cell}: ${exclusion.reason}`);
    }
    for (const warning of prepared.warnings) {
      emit(`warning: ${warning}`);
    }
    emit('reserve is one shared per-cell pool for instrument, skew, exposure-audit, and contention replacements — size for correlated same-window draws');
    if ((suite.reserve ?? 0) === 0) {
      emit('warning: contention invalidation will be shortfall-only');
    }
    emit(`digest: ${digest}`);
    emit(`global_run_cap = ${args.globalCap} per-sample slots; max contemporaneous two-arm blocks = ${Math.floor(args.globalCap / 2)}`);

    const finishUnpublished = (): RegisterResult => ({
      campaign_id,
      digest,
      campaignDir: '',
      published: false,
      dryRun: args.dryRun,
      printed: printed.join('\n'),
      excluded_cells: prepared.excluded_cells,
      warnings: prepared.warnings,
    });
    if (args.dryRun) return finishUnpublished();
    // Noninteractive: no tty prompt, ever — absent --confirm is the
    // print-and-exit path.
    if (!args.confirm) return finishUnpublished();

    // 9. Candidate dir naming + collision extension (Decision D-6).
    let prefixLen = 8;
    let campaignDir = '';
    let reopenOnly = false;
    for (;;) {
      const candidate = join(args.campaignsRoot, `${digest.slice(0, prefixLen)}-${suite.name}`);
      const classification = classifyCandidate(candidate);
      if (classification.kind === 'absent' || classification.kind === 'shell') {
        campaignDir = candidate;
        break;
      }
      if (classification.kind === 'incomplete') {
        if (classification.openedDigest === digest) {
          campaignDir = candidate;
          break;
        }
        emit(`collision: ${candidate} holds a different campaign_opened digest — extending prefix`);
        prefixLen += 4;
        continue;
      }
      if (classification.kind === 'published') {
        if (classification.digest === digest) {
          campaignDir = candidate;
          reopenOnly = true; // R-REG-22: digest equality only, no republish
          break;
        }
        emit(`collision: ${candidate} is published with a different digest — extending prefix`);
        prefixLen += 4;
        continue;
      }
      emit(`orphan: ${candidate} is ambiguous (no identity carrier, spend recorded) — left untouched, extending prefix`);
      prefixLen += 4;
    }

    if (reopenOnly) {
      emit(`re-opening published campaign at ${campaignDir} (digest equality verified)`);
      return {
        campaign_id,
        digest,
        campaignDir,
        published: false,
        dryRun: false,
        printed: printed.join('\n'),
        excluded_cells: prepared.excluded_cells,
        warnings: prepared.warnings,
      };
    }

    // 10. P-4 publication order: snapshot at final path -> journal init ->
    //     ballast -> campaign.json staged + renamed LAST.
    // (1) Materialize at the final path; incomplete-re-entry repair under
    //     the lease when the dest holds drifted/dirty debris (D-7 S-8).
    const snapshotArgs = {
      campaignDir,
      refs: { superpowers_by_arm, evals: evalsSha, gauntlet: gauntletSha },
      evalsCheckout: args.evalsCheckout,
      gauntletCheckout: args.gauntletCheckout,
      superpowersCheckout: args.superpowersCheckout,
      runner: args.runner,
    };
    let handle: SnapshotHandle;
    try {
      handle = materializeCampaignSnapshot(snapshotArgs);
    } catch (err) {
      emit(`repair: snapshot materialization failed (${(err as Error).message}) — removing drifted trees under lease and re-materializing (loud, D-7 S-8)`);
      try {
        handle = repairDriftedTrees(snapshotArgs);
      } catch (repairErr) {
        throw new RegistrationError(
          `snapshot repair failed at ${campaignDir}: ${(repairErr as Error).message} — refusing registration (fail-closed)`,
        );
      }
    }
    verifyIntakeMatch(intake, handle.evalsRoot);
    probeChildContract(handle.evalsRoot, evalsSha, args);

    // (2) Journal init + campaign_opened (first event, committed before
    //     campaign.json exists; never re-journaled on re-entry) + sidecar.
    if (!existsSync(join(campaignDir, 'journal.db'))) initJournalDb(campaignDir);
    const writer = electWriter({ campaignDir, clock: args.clock, identity: args.identity });
    try {
      const events = writer.readEvents();
      if (events.length === 0) {
        writer.appendEvent({ type: 'campaign_opened', payload: { campaign_id, digest } });
      } else {
        const opened = events[0];
        if (opened === undefined || opened.type !== 'campaign_opened' || opened.payload.digest !== digest) {
          throw new RegistrationError(
            `existing journal at ${campaignDir} carries a different campaign_opened digest — refusing (fail-closed)`,
          );
        }
      }
    } finally {
      writer.release();
    }
    const sidecar = join(campaignDir, 'contention-telemetry.jsonl');
    if (!existsSync(sidecar)) writeFileSync(sidecar, '', { flag: 'wx' });

    // (3) Ballast: verify-or-create. Idempotent re-entry VERIFIES the same
    //     properties or RECREATES the ballast before publishing (D-13) — a
    //     crash mid-createBallast leaves a short/unverifiable file, and a
    //     refusal here would brick the directory (createBallast opens
    //     O_EXCL). Publication has not happened yet, so recreation is
    //     legal; the never-recreate rule applies only MID-campaign.
    const ballastPath = join(campaignDir, '.ballast');
    if (!existsSync(ballastPath)) {
      createBallast(campaignDir, DEFAULT_BALLAST_BYTES);
    } else if (!verifyBallast(campaignDir, DEFAULT_BALLAST_BYTES)) {
      process.stderr.write(
        `existing .ballast at ${campaignDir} fails the non-sparse allocation check — recreating before publication (D-13 re-entry)\n`,
      );
      unlinkSync(ballastPath);
      createBallast(campaignDir, DEFAULT_BALLAST_BYTES);
    }

    // (4) campaign.json staged + renamed LAST, directory fsync.
    const finalDoc = { ...preDigest, campaign_id, digest };
    CampaignSchema.parse(finalDoc); // the frozen document shape, validated
    if (!existsSync(join(campaignDir, 'campaign.json'))) {
      stageAndPublishCampaignJson(campaignDir, finalDoc);
    }
    emit(`published ${campaignDir}`);

    return {
      campaign_id,
      digest,
      campaignDir,
      published: true,
      dryRun: false,
      printed: printed.join('\n'),
      excluded_cells: prepared.excluded_cells,
      warnings: prepared.warnings,
    };
  } finally {
    lease.release();
  }
}
```

(Additional imports this step needs at the top of `registration.ts`: `cpus` from `node:os`; `superpowersCapability` from `../agents/index.ts`; `openJournalRead` from `./journal.ts`; `dirname` from `node:path`.)

- [ ] **Step 15: Run tests to verify they pass**

Run: `bun test test/campaign-registration.test.ts`
Expected: PASS (18 tests). Then `bun run check`.

- [ ] **Step 16: Gitignore the campaign dirs + commit (task 5d)**

Append to `.gitignore` (campaign directories are per-host evidence, never committed — spec Artifact layout):

```
campaigns/
```

```bash
git add src/campaign/registration.ts test/campaign-registration.test.ts .gitignore
git commit -m "feat(campaign): D3 registration — snapshot-first intake, grid, publication

Refs resolve to 40-hex SHAs; intake reads scenarios/agent YAMLs/
credentials from the frozen evals SHA through the git object store
(Blocker C); grid expansion + full rejection matrix + E7.0 reserve
minting + E1/E2 pricing with versioned surcharge + grader-match
attestation; digest identity; D-6 dir naming with collision extension;
P-4 publication order (snapshot at final path -> journal init +
campaign_opened -> fsynced ballast -> campaign.json renamed last);
idempotent re-registration; child-contract probe at the D2 merge SHA."
```

---

### Task 6: spawn, campaign-identity intake, key selection + grants

**Files:**
- Modify: `src/campaign/spawn.ts` (production spawner, pgid validation, child argv, `run_allocated` line parsing, grants payload)
- Create: `src/campaign/key-select.ts`
- Modify: `src/runner/index.ts` (`RunScenarioArgs.campaign`; persistence at run-dir allocation; verdict stamping)
- Modify: `src/runner/stopped.ts` (stopped verdicts carry the campaign identity)
- Modify: `src/cli/run-command.ts` (`campaignIdentityJson` option; stamping the stopped path)
- Modify: `src/cli/run-child.ts` + `src/cli/index.ts` (`--campaign-identity` on both parsers; `--gauntlet-bin` on the public parser)
- Test: create `test/campaign-spawn.test.ts`, `test/campaign-key-select.test.ts`, `test/campaign-identity-intake.test.ts`

**Interfaces:**
- Consumes: `ChildSpawner`, `CampaignChildSpec`, `SpawnedCampaignChild`, `ChildExitInfo` from `src/campaign/spawn.ts` (Task 1 seam types); `KeySelector`, `KeyGrant`, `poolKey` from `src/contracts/campaign/pool.ts`; `type Credential` from `src/contracts/credential.ts`; `CampaignIdentitySchema`, `type CampaignIdentity` from `src/contracts/campaign/campaign.ts` (Task 1); `COVERED_BY_LOCK_ENV` from `src/campaign/locks.ts` (Task 2); `readRunAllocatedGrants` types from `src/contracts/campaign/journal-events.ts` (Task 1); `runScenario`, `type RunScenarioArgs` from `src/runner/index.ts`; `executeRunCommand`, `normalizeRunCommandOptions`, `runAllocatedLine` from `src/cli/run-command.ts`; `mockGauntletDir` from `test/mock-gauntlet/shim.ts` (house harness, tests only).
- Produces (tasks 8/9 rely on these exact names):
  - `export class SpawnError extends Error`
  - `export class DetachedChildSpawner implements ChildSpawner` — `node:child_process` `spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })` (R-SPN-1; stdio pinned — journal FDs never reach children)
  - `export function assertProcessGroupExists(pgid: number): void` — `process.kill(-pgid, 0)`; ESRCH throws `SpawnError` (R-SPN-2 pgid validation: detached setsid makes pgid == pid; the group's existence is the check)
  - `export function parseRunAllocatedLine(line: string): string | null` — the parent-pinned `run_allocated: <run_id>` protocol line
  - `export interface CampaignChildArgvArgs { readonly evalsRoot: string; readonly scenarioDir: string; readonly codingAgent: string; readonly codingAgentsDir: string; readonly outRoot: string; readonly os: string; readonly credentialName: string; readonly credentialsFile: string; readonly gauntletBin: string; readonly superpowers: { mode: 'root'; root: string } | { mode: 'none' }; readonly identity: CampaignIdentity }`
  - `export function buildCampaignChildArgv(args: CampaignChildArgvArgs): string[]` — R-SPN-8 snapshot-entrypoint argv; a PATH-resolved or host-checkout quorum binary is forbidden
  - `export function childCoveredEnv(): Record<string, string>` — `{ [COVERED_BY_LOCK_ENV]: '1' }` (children-never-acquire marking channel)
  - `export function keyGrantsPayload(args: { subjectEnv?: string; graderEnv?: string }): { key_grants: { role: 'subject' | 'grader'; env: string }[] }` — E7.5 new emission arm: 0–2 entries, names only
  - From `key-select.ts`: `export class KeySelectionError extends Error`; `export function keyWaitThreshold(cred: Credential): number`; `export function selectKey(cred: Credential, inFlight: Readonly<Record<string, number>>): { kind: 'use'; grant: KeyGrant } | { kind: 'wait' }` (the D1 `KeySelector` contract: least-loaded; wait when every key ≥ `ceil(max_concurrency / key_pool.length)`); `export type SpawnKeyResolution = { kind: 'use'; grant: KeyGrant } | { kind: 'wait' } | { kind: 'native' }`; `export function resolveKeyForSpawn(args: { cred: Credential; credentialName: string; inFlight: Readonly<Record<string, number>> }): SpawnKeyResolution` (R-SPN-7 fail-loud; the harness-conventional-env fallback is forbidden for key_pool credentials); `export function warnKeyWait(stream: { write(s: string): void }, phase: 'entry' | 'resolution', credentialName: string, waitMs?: number): void` (Decision D-2 loud warnings)
  - `RunScenarioArgs.campaign?: CampaignIdentity | undefined`; `<runDir>/campaign-identity.json` persisted atomically at allocation; `RunCommandOptions.campaignIdentityJson?: string`; `StoppedIdentity.campaign?: CampaignIdentity`.

Task 6 runs as three executable sub-tasks (6a → 6b → 6c); each has its own failing-tests-first cycle, verify command, and commit.

#### Task 6a: detached process-group spawn + campaign-child argv (Steps 1–4; covers R-SPN-1/2/3/5/8/9 and the child-covered env marker)

**Files:** modify `src/campaign/spawn.ts` (production spawn over the task-1 seam types); create `test/campaign-spawn.test.ts`.

- [ ] **Step 1: Write the failing spawn tests** — create `test/campaign-spawn.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertProcessGroupExists,
  buildCampaignChildArgv,
  childCoveredEnv,
  DetachedChildSpawner,
  keyGrantsPayload,
  parseRunAllocatedLine,
  SpawnError,
} from '../src/campaign/spawn.ts';
import { COVERED_BY_LOCK_ENV } from '../src/campaign/locks.ts';

test('detached spawn: pid == pgid (setsid), protocol line observed, group exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const script = join(dir, 'child.ts');
  writeFileSync(
    script,
    "console.log('run_allocated: run-abc123');\nawait Bun.sleep(300);\nconsole.log('run-id: run-abc123');\n",
  );
  const spawner = new DetachedChildSpawner();
  const child = spawner.spawn({
    command: 'bun',
    args: [script],
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '' },
  });
  expect(child.pid).toBeGreaterThan(0);
  // Detached setsid: the child IS its process-group leader (R-SPN-1/2).
  expect(() => assertProcessGroupExists(child.pid)).not.toThrow();
  const lines: string[] = [];
  child.onStdoutLine((line) => lines.push(line));
  const exit = await new Promise<{ code: number | null }>((resolve) => {
    child.onExit((info) => resolve({ code: info.code }));
  });
  expect(exit.code).toBe(0);
  expect(lines.some((l) => parseRunAllocatedLine(l) === 'run-abc123')).toBe(true);
});

test('assertProcessGroupExists throws SpawnError for a nonexistent group', () => {
  expect(() => assertProcessGroupExists(999999999)).toThrow(SpawnError);
});

test('parseRunAllocatedLine: exact protocol, nothing else', () => {
  expect(parseRunAllocatedLine('run_allocated: run-x')).toBe('run-x');
  expect(parseRunAllocatedLine('run-id: run-x')).toBeNull();
  expect(parseRunAllocatedLine('run_allocated:run-x')).toBeNull();
});

test('campaign child argv addresses the snapshot entrypoint with identity + threading flags', () => {
  const argv = buildCampaignChildArgv({
    evalsRoot: '/camp/evals',
    scenarioDir: '/camp/evals/scenarios/scn-a',
    codingAgent: 'claude',
    codingAgentsDir: '/camp/evals/coding-agents',
    outRoot: 'results',
    os: 'linux',
    credentialName: 'cred_a',
    credentialsFile: '/camp/evals/credentials.yaml',
    gauntletBin: '/camp/bin/gauntlet',
    superpowers: { mode: 'root', root: '/camp/superpowers-abc' },
    identity: {
      campaign_id: 'c'.repeat(64),
      comparison_id: 'c1',
      block_id: 'c1:scn-a:b1',
      sample_id: 'c1:scn-a:arm_a:r1',
      execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
    },
  });
  expect(argv[0]).toBe('/camp/evals/src/cli/index.ts'); // bun <entry> run ...
  expect(argv[1]).toBe('run');
  expect(argv).toContain('--gauntlet-bin');
  expect(argv).toContain('/camp/bin/gauntlet');
  expect(argv).toContain('--superpowers-root');
  expect(argv).toContain('/camp/superpowers-abc');
  expect(argv).toContain('--campaign-identity');
  const idx = argv.indexOf('--campaign-identity');
  expect(JSON.parse(argv[idx + 1]!)).toEqual({
    campaign_id: 'c'.repeat(64),
    comparison_id: 'c1',
    block_id: 'c1:scn-a:b1',
    sample_id: 'c1:scn-a:arm_a:r1',
    execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
  });
  // A bare 'quorum' or PATH-resolved binary is forbidden (R-SPN-8).
  expect(argv.join(' ')).not.toMatch(/(^| )quorum( |$)/);
});

test('children-never-acquire marking rides the explicit env channel', () => {
  expect(childCoveredEnv()).toEqual({ [COVERED_BY_LOCK_ENV]: '1' });
});

test('keyGrantsPayload: E7.5 emission arm — 0-2 entries, names only, one per role', () => {
  expect(keyGrantsPayload({}).key_grants).toEqual([]);
  expect(keyGrantsPayload({ subjectEnv: 'S' }).key_grants).toEqual([
    { role: 'subject', env: 'S' },
  ]);
  expect(keyGrantsPayload({ graderEnv: 'G' }).key_grants).toEqual([
    { role: 'grader', env: 'G' },
  ]);
  expect(keyGrantsPayload({ subjectEnv: 'S', graderEnv: 'G' }).key_grants).toEqual([
    { role: 'subject', env: 'S' },
    { role: 'grader', env: 'G' },
  ]);
  // The shared-credential case: same env name may appear once per role.
  expect(keyGrantsPayload({ subjectEnv: 'K', graderEnv: 'K' }).key_grants).toEqual([
    { role: 'subject', env: 'K' },
    { role: 'grader', env: 'K' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-spawn.test.ts`
Expected: FAIL — `DetachedChildSpawner`, `buildCampaignChildArgv` etc. not found.

- [ ] **Step 3: Implement the spawn additions** — append to `src/campaign/spawn.ts` (Task 1 created the seam types):

```ts
import { spawn } from 'node:child_process';
import { COVERED_BY_LOCK_ENV } from './locks.ts';
import { CampaignIdentitySchema, type CampaignIdentity } from '../contracts/campaign/campaign.ts';
import type { SuperpowersSpec } from '../agents/superpowers.ts';

export class SpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnError';
  }
}

/** R-SPN-2 pgid validation: detached setsid spawn makes the child its own
 *  process-group leader (pgid == pid, verified under Bun on Darwin); the
 *  group's existence is the check journaled pgids rely on. */
export function assertProcessGroupExists(pgid: number): void {
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      throw new SpawnError(`process group ${pgid} does not exist — pgid validation failed`);
    }
    throw err;
  }
}

/** Production spawner (R-SPN-1): detached process-group-leader spawn. The
 *  stdio pinning is deliberate — journal FDs must never reach campaign
 *  children (O_CLOEXEC debt; the Linux matrix asserts non-inheritance). */
export class DetachedChildSpawner implements ChildSpawner {
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) {
      throw new SpawnError(`spawn failed: no pid for ${spec.command} ${spec.args.join(' ')}`);
    }
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutCbs: ((line: string) => void)[] = [];
    const stderrCbs: ((line: string) => void)[] = [];
    const exitCbs: ((info: ChildExitInfo) => void)[] = [];
    let stdoutBuf = '';
    let stderrBuf = '';
    const deliver = (
      buf: string,
      lines: string[],
      cbs: ((line: string) => void)[],
      chunk: string,
    ): string => {
      const next = buf + chunk;
      const parts = next.split('\n');
      const rest = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        for (const cb of cbs) cb(line);
      }
      return rest;
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf = deliver(stdoutBuf, stdoutLines, stdoutCbs, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = deliver(stderrBuf, stderrLines, stderrCbs, chunk.toString('utf8'));
    });
    child.on('exit', (code, signal) => {
      // Flush any unterminated tail as a final line.
      if (stdoutBuf !== '') {
        stdoutLines.push(stdoutBuf);
        for (const cb of stdoutCbs) cb(stdoutBuf);
      }
      for (const cb of exitCbs) cb({ code, signal });
    });
    child.on('error', () => {
      for (const cb of exitCbs) cb({ code: null, signal: null });
    });
    return {
      pid: child.pid,
      get stdoutLines() {
        return [...stdoutLines];
      },
      get stderrLines() {
        return [...stderrLines];
      },
      onStdoutLine(cb) {
        stdoutCbs.push(cb);
      },
      onStderrLine(cb) {
        stderrCbs.push(cb);
      },
      onExit(cb) {
        exitCbs.push(cb);
      },
    };
  }
}

/** The parent-pinned protocol line (D1 Decision D-3; src/cli/run-command.ts
 *  runAllocatedLine): `run_allocated: <run_id>`. */
export function parseRunAllocatedLine(line: string): string | null {
  const m = /^run_allocated: (.+)$/.exec(line);
  return m === null ? null : (m[1] ?? '').trim() || null;
}

/** Children-never-acquire: campaign children are marked covered by the
 *  holder's accounting via this explicit env channel; locks.ts refuses
 *  acquisition when it is set. */
export function childCoveredEnv(): Record<string, string> {
  return { [COVERED_BY_LOCK_ENV]: '1' };
}

export interface CampaignChildArgvArgs {
  readonly evalsRoot: string;
  readonly scenarioDir: string;
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly os: string;
  readonly credentialName: string;
  readonly credentialsFile: string;
  readonly gauntletBin: string;
  readonly superpowers: SuperpowersSpec;
  readonly identity: CampaignIdentity;
}

/** R-SPN-8: the child argv addresses the SNAPSHOT's own entrypoint
 *  (`bun <evalsRoot>/src/cli/index.ts run …`, cwd inside the snapshot).
 *  A PATH-resolved or host-checkout quorum binary is forbidden. Carries the
 *  explicit superpowers mode, gauntletBin, and the campaign identity block
 *  (R-SPN-9, R-SPN-4). */
export function buildCampaignChildArgv(args: CampaignChildArgvArgs): string[] {
  const identity = CampaignIdentitySchema.parse(args.identity);
  const argv: string[] = [
    `${args.evalsRoot}/src/cli/index.ts`,
    'run',
    args.scenarioDir,
    '--coding-agent',
    args.codingAgent,
    '--coding-agents-dir',
    args.codingAgentsDir,
    '--out-root',
    args.outRoot,
    '--os',
    args.os,
    '--credential',
    args.credentialName,
    '--credentials-file',
    args.credentialsFile,
    '--gauntlet-bin',
    args.gauntletBin,
  ];
  if (args.superpowers.mode === 'root') {
    argv.push('--superpowers-root', args.superpowers.root);
  } else {
    argv.push('--no-superpowers');
  }
  argv.push('--campaign-identity', JSON.stringify(identity));
  return argv;
}

/** E7.5 new emission arm: 0-2 role-tagged grant entries, names only, never
 *  values. Non-API-key roles contribute no entry (the dispatcher supplies
 *  role attribution, not key material). */
export function keyGrantsPayload(args: {
  subjectEnv?: string;
  graderEnv?: string;
}): { key_grants: { role: 'subject' | 'grader'; env: string }[] } {
  const key_grants: { role: 'subject' | 'grader'; env: string }[] = [];
  if (args.subjectEnv !== undefined) key_grants.push({ role: 'subject', env: args.subjectEnv });
  if (args.graderEnv !== undefined) key_grants.push({ role: 'grader', env: args.graderEnv });
  return { key_grants };
}
```

(The seam types — `ChildSpawner`, `CampaignChildSpec`, `SpawnedCampaignChild`, `ChildExitInfo` — are declared IN THIS FILE by Task 1; the production code below references them directly, no import. Add `import type { SuperpowersSpec } from '../agents/superpowers.ts'`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-spawn.test.ts`
Expected: PASS (6 tests).

- [ ] **Commit (task 6a)**

```bash
git add src/campaign/spawn.ts test/campaign-spawn.test.ts
git commit -m "feat(campaign): D3 spawn — detached setsid pgid spawn + snapshot-entrypoint child argv"
```

#### Task 6b: key selection + grants (Steps 5–8; covers R-SPN-6's `KeySelector`, R-SPN-7's fail-loud resolution, and Decision D-2's derive-only wait)

**Files:** create `src/campaign/key-select.ts`; create `test/campaign-key-select.test.ts`.

- [ ] **Step 5: Write the failing key-select tests** — create `test/campaign-key-select.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { Credential } from '../src/contracts/credential.ts';
import {
  keyWaitThreshold,
  KeySelectionError,
  resolveKeyForSpawn,
  selectKey,
  warnKeyWait,
} from '../src/campaign/key-select.ts';

function poolCredential(keys: string[], maxConcurrency?: number): Credential {
  return {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
    key_pool: keys,
    ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {}),
  } as Credential;
}

test('keyWaitThreshold: ceil(max_concurrency / key_pool.length), default cap = len x 5', () => {
  expect(keyWaitThreshold(poolCredential(['k1', 'k2'], 15))).toBe(8); // ceil(15/2)
  expect(keyWaitThreshold(poolCredential(['k1', 'k2', 'k3'], 15))).toBe(5); // ceil(15/3)
  expect(keyWaitThreshold(poolCredential(['k1', 'k2']))).toBe(5); // default cap 10 / 2
});

test('selectKey: least-loaded key wins; wait when every key is at the threshold', () => {
  const cred = poolCredential(['k1', 'k2'], 4); // threshold = 2 per key
  expect(selectKey(cred, {})).toEqual({ kind: 'use', grant: { envName: 'k1' } });
  expect(selectKey(cred, { k1: 1 })).toEqual({ kind: 'use', grant: { envName: 'k2' } });
  expect(selectKey(cred, { k1: 2, k2: 2 })).toEqual({ kind: 'wait' });
  // Least-loaded among equals is deterministic (first in pool order).
  expect(selectKey(cred, { k1: 1, k2: 1 })).toEqual({ kind: 'use', grant: { envName: 'k1' } });
});

test('resolveKeyForSpawn: singular api_key_env uses; non-api-key is native; missing grant fails LOUD (no harness fallback)', () => {
  const singular = { ...poolCredential(['x']), key_pool: undefined, api_key_env: 'SINGLE' } as Credential;
  expect(resolveKeyForSpawn({ cred: singular, credentialName: 'c', inFlight: {} })).toEqual({
    kind: 'use',
    grant: { envName: 'SINGLE' },
  });
  // Deletion overrides (explicit undefined strips the pool fields) — the cast
  // exists only because exactOptionalPropertyTypes rejects them inline.
  const native = { ...poolCredential(['x']), key_pool: undefined, auth: 'oauth', api_key_env: undefined } as unknown as Credential;
  expect(resolveKeyForSpawn({ cred: native, credentialName: 'c', inFlight: {} })).toEqual({
    kind: 'native',
  });
  const broken = {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  } as Credential; // api-key auth, no api_key_env, no key_pool
  expect(() =>
    resolveKeyForSpawn({ cred: broken, credentialName: 'cred_x', inFlight: {} }),
  ).toThrow(KeySelectionError);
  expect(() =>
    resolveKeyForSpawn({ cred: broken, credentialName: 'cred_x', inFlight: {} }),
  ).toThrow(/fallback is forbidden/);
});

test('D-2 loud warnings: entry names the credential; resolution names credential + measured wait', () => {
  const written: string[] = [];
  const stream = { write: (s: string) => written.push(s) };
  warnKeyWait(stream, 'entry', 'cred_a');
  warnKeyWait(stream, 'resolution', 'cred_a', 2500);
  expect(written[0]).toMatch(/cred_a/);
  expect(written[0]).toMatch(/wait/i);
  expect(written[1]).toMatch(/cred_a/);
  expect(written[1]).toMatch(/2500/);
  expect(written[1]).toMatch(/spawn-gap|wait/i);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test test/campaign-key-select.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/campaign/key-select.ts`**

```ts
// KeySelector (kernel D3, R-SPN-6/7; D1 Decision D-1): key selection lives
// STRICTLY BELOW admission. Since len(keys) x ceil(cap / len(keys)) >= cap,
// the wait branch is unreachable under honest admission — it guards
// miscalibration and recovery rebuild, and is implemented exactly as a
// guard, never a second admission authority. Decision D-2: zero journal
// amendments for key-wait; wait surfaces as loud warnings here and as the
// honestly-labeled spawn-gap stat in the journal's attempts table (task 3).
import type { Credential } from '../contracts/credential.ts';
import type { KeyGrant, KeySelector } from '../contracts/campaign/pool.ts';

export class KeySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeySelectionError';
  }
}

/** The pool-level cap: explicit max_concurrency, else the single-key cap 5
 *  Phase 0 modeled, scaled by pool length (R-REG-7's convention). */
function poolCap(cred: Credential): number {
  if (cred.max_concurrency !== undefined) return cred.max_concurrency;
  return (cred.key_pool?.length ?? 1) * 5;
}

export function keyWaitThreshold(cred: Credential): number {
  const len = cred.key_pool?.length ?? 1;
  return Math.ceil(poolCap(cred) / len);
}

/** Least-loaded key; wait when every key's in-flight count is at or above
 *  the threshold. Deterministic ties: first key in pool order. */
export const selectKey: KeySelector = (cred, inFlight) => {
  const pool = cred.key_pool;
  if (pool === undefined || pool.length === 0) {
    throw new KeySelectionError(
      'selectKey called on a credential without key_pool — singular resolution uses resolveKeyForSpawn',
    );
  }
  const threshold = keyWaitThreshold(cred);
  let best: { envName: string; load: number } | undefined;
  for (const envName of pool) {
    const load = inFlight[envName] ?? 0;
    if (load < threshold && (best === undefined || load < best.load)) {
      best = { envName, load };
    }
  }
  return best === undefined
    ? { kind: 'wait' }
    : { kind: 'use', grant: { envName: best.envName } };
};

export type SpawnKeyResolution =
  | { kind: 'use'; grant: KeyGrant }
  | { kind: 'wait' }
  | { kind: 'native' }; // non-api-key auth: no key material projected

/** R-SPN-7 fail-loud: key_pool credentials lacking a selected grant refuse;
 *  the harness-conventional-env fallback (resolveApiKeyEnvName) is FORBIDDEN
 *  for them. Spawn fails loud on an exhausted or unset key. */
export function resolveKeyForSpawn(args: {
  cred: Credential;
  credentialName: string;
  inFlight: Readonly<Record<string, number>>;
}): SpawnKeyResolution {
  const { cred, credentialName, inFlight } = args;
  if (cred.auth !== 'api-key') return { kind: 'native' };
  if (cred.key_pool !== undefined) {
    return selectKey(cred, inFlight);
  }
  if (cred.api_key_env !== undefined) {
    return { kind: 'use', grant: { envName: cred.api_key_env } };
  }
  throw new KeySelectionError(
    `credential ${credentialName} is auth=api-key with no api_key_env and no key_pool — the harness-conventional-env fallback is forbidden for campaign credentials (R-SPN-7); spawn fails loud rather than spend on an unset key`,
  );
}

/** Decision D-2 loud warnings: every wait entry and every resolution names
 *  the credential (resolution adds the measured wait duration). Wait never
 *  journals — the derivable spawn-gap stat is the only record. */
export function warnKeyWait(
  stream: { write(s: string): void },
  phase: 'entry' | 'resolution',
  credentialName: string,
  waitMs?: number,
): void {
  if (phase === 'entry') {
    stream.write(
      `warning: key wait entered for credential ${credentialName} — every key at its in-flight threshold (miscalibration or recovery rebuild; wait is never journaled)\n`,
    );
  } else {
    stream.write(
      `warning: key wait resolved for credential ${credentialName} after ${waitMs ?? 0}ms — measured wait contributes to the spawn-gap stat, not to key-wait attribution\n`,
    );
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test test/campaign-key-select.test.ts`
Expected: PASS (4 tests).

- [ ] **Commit (task 6b)**

```bash
git add src/campaign/key-select.ts test/campaign-key-select.test.ts
git commit -m "feat(campaign): D3 key selection — least-loaded below admission, wait guard, fail-loud resolution"
```

#### Task 6c: campaign-identity intake + stamping (Steps 9–13; covers R-SPN-4's identity-before-first-token persistence at run-dir allocation and every verdict/error/stopped path)

**Files:** modify `src/runner/index.ts`, `src/runner/stopped.ts`, `src/cli/run-command.ts`, `src/cli/run-child.ts`, `src/cli/index.ts`; create `test/campaign-identity-intake.test.ts`.

- [ ] **Step 9: Write the failing identity-intake tests** — create `test/campaign-identity-intake.test.ts`, mirroring the `test/cli-run.test.ts` mock-gauntlet harness (read it first; reuse `mockGauntletDir` and the real `coding-agents/` dir):

```ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const RUN_CHILD = resolve(import.meta.dir, '..', 'src', 'cli', 'run-child.ts');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

const IDENTITY = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:scn-a:b1',
  sample_id: 'c1:scn-a:arm_a:r1',
  execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
};

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(join(scn, 'story.md'), '---\nquorum_max_time: 1m\n---\nDo the thing.');
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function runChild(extraArgs: string[], envExtra: Record<string, string> = {}) {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      RUN_CHILD,
      scenario(),
      '--coding-agent', 'claude',
      '--coding-agents-dir', REAL_CODING_AGENTS,
      '--out-root', outRoot,
      '--credentials-file', resolve(import.meta.dir, 'fixtures', 'serf-campaign-credentials.yaml'),
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        PATH: `${mockGauntletDir('pass')}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
        ...envExtra,
      },
      encoding: 'utf8',
    },
  );
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  return { status: proc.status, stderr: proc.stderr, outRoot, runDir: runs.length === 1 ? join(outRoot, runs[0]!) : null };
}

test('campaign identity: persisted at run-dir allocation and stamped on the verdict', () => {
  const r = runChild(['--campaign-identity', JSON.stringify(IDENTITY)]);
  expect(r.status).toBe(0);
  expect(r.runDir).not.toBeNull();
  // Persisted at allocation — what makes R-RCV-3 quarantine possible.
  const persisted = JSON.parse(readFileSync(join(r.runDir!, 'campaign-identity.json'), 'utf8'));
  expect(persisted).toEqual(IDENTITY);
  // Stamped on the verdict (every verdict path).
  const verdict = JSON.parse(readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'));
  expect(verdict.campaign).toEqual(IDENTITY);
});

test('legacy runs carry no campaign block (byte-identical intake absence)', () => {
  const r = runChild([]);
  expect(r.status).toBe(0);
  expect(existsSync(join(r.runDir!, 'campaign-identity.json'))).toBe(false);
  const verdict = JSON.parse(readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'));
  expect(verdict.campaign).toBeUndefined();
});

test('malformed campaign identity fails loud at the CLI boundary', () => {
  const r = runChild(['--campaign-identity', '{"campaign_id": "x"}']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/campaign-identity|comparison_id|invalid/i);
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `bun test test/campaign-identity-intake.test.ts`
Expected: FAIL — `--campaign-identity` is an unknown option.

- [ ] **Step 11: Implement identity intake + stamping**

`src/runner/index.ts`:

1. `RunScenarioArgs` gains (after `gauntletBin`):

```ts
  // D3 identity intake (R-SPN-4, Decision D-8): the campaign identity block
  // the spawner supplies at launch. Persisted at run-dir allocation and
  // stamped on every verdict/error/stopped path — before the first provider
  // token. Legacy runs leave it undefined.
  readonly campaign?: CampaignIdentity | undefined;
```

(import `type CampaignIdentity` from `../contracts/campaign/campaign.ts`.)

2. Immediately after `a.onRunDir?.(runDir)` (~line 1032), persist:

```ts
  if (a.campaign !== undefined) {
    persistCampaignIdentity(runDir, a.campaign);
  }
```

with the helper (same file):

```ts
/** Decision D-8: persisted at run-dir allocation, atomic (tmp + rename), at
 *  the same seam as the run_allocated: emission. Recovery reads a run dir's
 *  identity without trusting the dispatcher's memory (R-RCV-3). */
function persistCampaignIdentity(runDir: string, identity: CampaignIdentity): void {
  const tmp = join(runDir, `.campaign-identity-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`);
  renameSync(tmp, join(runDir, 'campaign-identity.json'));
}
```

(add `renameSync` to the `node:fs` import).

3. In the `identified: FinalVerdict` construction (~line 1113), add the stamp:

```ts
    ...(a.campaign !== undefined ? { campaign: a.campaign } : {}),
```

`src/runner/stopped.ts` — `StoppedIdentity` gains `readonly campaign?: CampaignIdentity;` and `buildStoppedVerdict` adds `...(id.campaign !== undefined ? { campaign: id.campaign } : {})` to the returned verdict (import the type from `../contracts/campaign/campaign.ts`).

`src/cli/run-command.ts`:

1. `RunCommandOptions` gains `readonly campaignIdentityJson?: string;`.
2. In `executeRunCommand`, before the `runScenario` call:

```ts
  const campaignIdentity: CampaignIdentity | undefined =
    opts.campaignIdentityJson === undefined
      ? undefined
      : CampaignIdentitySchema.parse(JSON.parse(opts.campaignIdentityJson));
```

(import both from `../contracts/campaign/campaign.ts`; a zod parse failure propagates as the CLI-boundary error — loud.) Pass `...(campaignIdentity !== undefined ? { campaign: campaignIdentity } : {})` into the `runScenario` args, and add `...(campaignIdentity !== undefined ? { campaign: campaignIdentity } : {})` to the `writeStoppedVerdict` identity in `onSigint`.

`src/cli/run-child.ts` — add `.option('--campaign-identity <json>', 'campaign identity block (campaign children)')` beside the existing options.

`src/cli/index.ts` — the public `run` command gains `.option('--campaign-identity <json>', 'campaign identity block (campaign children)')` and `.option('--gauntlet-bin <path>', 'snapshot-local gauntlet wrapper (campaign children)')` (R-SPN-9 threading — the campaign child enters through the snapshot's PUBLIC `run` command, so the wrapper flag moves from internal-only to both parsers).

- [ ] **Step 12: Run tests to verify they pass**

Run: `bun test test/campaign-identity-intake.test.ts test/cli-run.test.ts test/cli-run-superpowers.test.ts`
Expected: PASS (the D2 CLI suites stay green — additive flags only). Then `bun run check`.

- [ ] **Step 13: Commit (task 6c)**

```bash
git add src/runner/index.ts src/runner/stopped.ts src/cli/run-command.ts src/cli/run-child.ts src/cli/index.ts test/campaign-identity-intake.test.ts
git commit -m "feat(campaign): D3 campaign-identity intake + stamping

Campaign identity argv -> RunScenarioArgs -> persisted at run-dir
allocation -> stamped on every verdict/error/stopped path (quarantine by
attempt-id mismatch depends on it, R-RCV-3)."
```

---

### Task 7: sensors, contention guard, failure classifier

**Files:**
- Create: `src/campaign/sensors.ts`, `src/campaign/contention.ts`, `src/campaign/classifier.ts`
- Test: create `test/campaign-sensors.test.ts`, `test/campaign-contention.test.ts`, `test/campaign-classifier.test.ts`; fixtures inline (marker streams, fake host-stats series)

**Interfaces:**
- Consumes: `agyLogShowsRateLimit` from `src/agents/agy-watch.ts` (the shipped Antigravity predicate, ported as row 1 verbatim); `type Credential` from `src/contracts/credential.ts`; `RUN_ERROR_STAGES`, `type RunErrorStage` from `src/contracts/verdict.ts`; `type FailureClass`, `type InstrumentCause` from `src/contracts/campaign/typed-failures.ts` (Task 1 vocabulary); `type ContentionThreshold`-inferred shape from `src/contracts/campaign/campaign.ts`; `HostStatsProbe`, `clockNowMs`, `Clock` (Tasks 1–2); `FakeClock` for tests.
- Produces (task 8's dispatcher and D4 rely on these exact names):
  - From `sensors.ts`: `export interface RateLimitMarkerRow` + `export const RATE_LIMIT_MARKERS: readonly RateLimitMarkerRow[]` (the five pinned v1 rows); `export interface RateLimitMatch { readonly family: string; readonly cooldownMs: number }`; `export function classifyRateLimit(args: { api?: string; base_url?: string; runtimeFamily?: string; text: string }): RateLimitMatch | null`; `export function parseRetryAfterMs(text: string): number | null`; `export const RETRY_AFTER_MIN_MS = 5_000`; `export interface ExposureProbe { readonly agent: string; observe(sessionLogPath: string): number | null }`; `export function exposureProbeFromParser(agent: string, parse: (text: string) => readonly number[]): ExposureProbe` (tail-safe: always reads from the file start); `export class ExposureTracker { observe(sampleId: string, tsMs: number): boolean; value(sampleId: string): number | null }` (monotonic single emission — first observed request timestamp wins); `export function exposureWithPrecedence(args: { gauntletMarkTsMs: number | null; probeTsMs: number | null }): number | null` (source (1) wins when a mark exists — the precedence hook)
  - From `contention.ts`: `export const SIDECAR_FILENAME = 'contention-telemetry.jsonl'`; `export interface TelemetrySample`, `export interface TelemetryGap`, `export type SidecarLine`; `export function appendSidecarLine(campaignDir: string, line: SidecarLine): void` (fsync per sample); `export function parseSidecar(campaignDir: string): { lines: SidecarLine[]; truncatedTail: boolean }` (torn tail truncates at the last complete line, loud); `export interface BreachWindow { startTsMs: number; endTsMs: number | null; metrics: readonly string[] }`; `export function breachWindows(lines: readonly SidecarLine[], thresholds: readonly ResolvedThreshold[], sustainK: number): BreachWindow[]` (symmetric K-sustained edges, REV-2 P-6); `export interface ResolvedThreshold { metric: string; op: 'gt' | 'lt'; value: number }`; `export function thresholdViolations(sample: HostStats, thresholds: readonly ResolvedThreshold[]): string[]`; `export class ContentionSampler` (timer-driven over the Clock seam; gap lines on probe failure; fsync-before-closed-window-notification); `export function samplerStaleMs(lines: readonly SidecarLine[], nowMs: number): number` (dead-sampler liveness input); `export type BlockContentionVerdict = 'invalid' | 'unknown' | 'clean'`; `export interface BlockInterval { block_id: string; startTsMs: number; endTsMs: number | null }`; `export interface EvaluateContentionArgs`; `export function evaluateContention(args: EvaluateContentionArgs): Map<string, BlockContentionVerdict>` — **the one pure evaluator shared verbatim with the dispatcher and D4** (Decision D-3/D-5)
  - From `classifier.ts`: `export interface ClassificationInput`, `export interface Classification`, `export function classifyFailure(input: ClassificationInput): Classification` — the closed 14-row table

Task 7 runs as three executable sub-tasks (7a → 7b → 7c), one module each; each has its own failing-tests-first cycle, verify command, and commit.

#### Task 7a: sensors — marker registry + exposure probes (Steps 1–4; covers R-SNS-1/2/3/4/5 and Decisions D-9/D-10)

**Files:** create `src/campaign/sensors.ts`; create `test/campaign-sensors.test.ts`.

- [ ] **Step 1: Write the failing marker-registry tests** — create `test/campaign-sensors.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRateLimit,
  exposureProbeFromParser,
  ExposureTracker,
  exposureWithPrecedence,
  parseRetryAfterMs,
  RATE_LIMIT_MARKERS,
  RETRY_AFTER_MIN_MS,
} from '../src/campaign/sensors.ts';

test('the v1 registry is exactly the five pinned rows', () => {
  expect(RATE_LIMIT_MARKERS.map((r) => r.family)).toEqual([
    'antigravity',
    'anthropic',
    'openai-compatible',
    'gemini',
    'generic-http-429',
  ]);
});

test('row 1 antigravity: shipped truth — bare/prose 429 trips, embedded hex does not', () => {
  const ctx = { runtimeFamily: 'antigravity' };
  expect(classifyRateLimit({ ...ctx, text: 'RESOURCE_EXHAUSTED: quota' })?.family).toBe('antigravity');
  expect(classifyRateLimit({ ...ctx, text: 'ratelimitexceeded' })?.family).toBe('antigravity');
  expect(classifyRateLimit({ ...ctx, text: 'rate limit 429' })?.family).toBe('antigravity'); // prose 429 MATCHES (shipped)
  expect(classifyRateLimit({ ...ctx, text: 'trace id 0xe4291f' })?.family).not.toBe('antigravity'); // embedded hex does not
  expect(classifyRateLimit({ ...ctx, text: 'all good' })).toBeNull();
  // Row 1 requires the antigravity runtime predicate.
  expect(classifyRateLimit({ runtimeFamily: 'claude', api: 'anthropic', text: 'rate limit 429' })?.family).not.toBe('antigravity');
});

test('rows 2-5 require provider-shaped structure; model-authored 429 prose never trips them', () => {
  const anthropic = { api: 'anthropic' };
  expect(classifyRateLimit({ ...anthropic, text: '{"type":"rate_limit_error","message":"..."}' })?.family).toBe('anthropic');
  expect(classifyRateLimit({ ...anthropic, text: 'I kept hitting rate limit 429 in my tests' })).toBeNull(); // no structure
  const openai = { api: 'openai-chat' };
  expect(classifyRateLimit({ ...openai, text: '{"error":{"code":"rate_limit_exceeded"}}' })?.family).toBe('openai-compatible');
  expect(classifyRateLimit({ ...openai, text: 'HTTP 429 Rate limit reached' })?.family).toBe('openai-compatible');
  expect(classifyRateLimit({ ...openai, text: 'HTTP/1.1 429 Rate limit exceeded' })?.family).toBe('openai-compatible'); // status-line shape
  expect(classifyRateLimit({ ...openai, text: '{"status":429,"message":"Rate limit reached"}' })?.family).toBe('openai-compatible'); // JSON status + Rate limit text
  expect(classifyRateLimit({ ...openai, text: 'the model said "rate limit 429"' })).toBeNull(); // model-authored prose: no provider structure
  expect(classifyRateLimit({ ...openai, text: 'HTTP/1.1 429 Too Many Requests' })?.family).toBe('generic-http-429'); // status without Rate-limit text falls through to row 5
  const gemini = { api: 'gemini' };
  expect(classifyRateLimit({ ...gemini, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' })?.family).toBe('gemini');
  expect(classifyRateLimit({ ...gemini, text: '{"error":{"code":"RESOURCE_EXHAUSTED","message":"quota"}}' })?.family).toBe('gemini');
  expect(classifyRateLimit({ ...gemini, text: 'resource notes' })).toBeNull();
  expect(classifyRateLimit({ ...gemini, text: 'the model said RESOURCE_EXHAUSTED happened' })).toBeNull(); // unquoted prose
  expect(classifyRateLimit({ ...gemini, text: 'model said "RESOURCE_EXHAUSTED" once in prose' })).toBeNull(); // quoted but no error-payload field shape
  // Generic row: structured status only, never prose; lowest precedence.
  expect(classifyRateLimit({ api: 'mantle', text: '"status":429' })?.family).toBe('generic-http-429');
  expect(classifyRateLimit({ api: 'mantle', text: '"status_code": 429' })?.family).toBe('generic-http-429');
  expect(classifyRateLimit({ api: 'mantle', text: 'HTTP/1.1 429 Too Many Requests' })?.family).toBe('generic-http-429');
  expect(classifyRateLimit({ api: 'mantle', text: 'rate limit 429 happened' })).toBeNull();
});

test('base_url host predicate: api.anthropic.com matches row 2 below an api match', () => {
  expect(
    classifyRateLimit({ base_url: 'https://api.anthropic.com/v1', text: '{"type":"rate_limit_error"}' })?.family,
  ).toBe('anthropic');
});

test('precedence: the most specific predicate wins', () => {
  // A stream carrying BOTH an anthropic body and a generic status classifies
  // anthropic (api match > generic fallback).
  expect(
    classifyRateLimit({ api: 'anthropic', text: '{"type":"rate_limit_error"} and "status":429' })?.family,
  ).toBe('anthropic');
  // api match (rank 2) beats a base_url HOST match (rank 1): an
  // openai-family credential proxying through api.anthropic.com whose text
  // matches BOTH anchors classifies openai-compatible, never anthropic.
  expect(
    classifyRateLimit({
      api: 'openai-chat',
      base_url: 'https://api.anthropic.com/v1',
      text: '{"type":"rate_limit_error"} {"code":"rate_limit_exceeded"}',
    })?.family,
  ).toBe('openai-compatible');
});

test('retry-after parse + clamp [5s, family max]; absent -> family default', () => {
  // The PARSE is raw; the CLAMP lives in classifyRateLimit — the spec clamps
  // the computed until, not the parsed value.
  expect(parseRetryAfterMs('retry-after: 30')).toBe(30_000);
  expect(parseRetryAfterMs('"retry_after": 2')).toBe(2_000); // raw — clamp applies below
  expect(parseRetryAfterMs('nothing here')).toBeNull();
  // Clamp up to the 5s floor.
  expect(classifyRateLimit({ api: 'anthropic', text: '{"type":"rate_limit_error"} retry-after: 2' })?.cooldownMs).toBe(RETRY_AFTER_MIN_MS);
  // Clamp to the family max: anthropic max is 15min.
  expect(classifyRateLimit({ api: 'anthropic', text: '{"type":"rate_limit_error"} retry-after: 99999' })?.cooldownMs).toBe(15 * 60_000);
  expect(classifyRateLimit({ api: 'anthropic', text: '{"type":"rate_limit_error"}' })?.cooldownMs).toBe(60_000); // default
  expect(classifyRateLimit({ api: 'mantle', text: '"status":429' })?.cooldownMs).toBe(30_000); // generic default
});

test('ExposureProbe: tail-safe re-read from file start; monotonic single emission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expo-'));
  const log = join(dir, 'session.log');
  writeFileSync(log, 'ts:1000 gen\nts:2000 gen\n');
  const probe = exposureProbeFromParser('test-agent', (text) =>
    [...text.matchAll(/ts:(\d+)/g)].map((m) => Number(m[1])),
  );
  expect(probe.agent).toBe('test-agent');
  expect(probe.observe(log)).toBe(1000); // earliest request wins
  // Truncation/rotation: the file shrinks; observe re-reads from the start.
  writeFileSync(log, 'ts:500 gen\n');
  expect(probe.observe(log)).toBe(500);
  // The tracker pins the FIRST observed value per sample — later observations
  // never move it (monotonic single emission).
  const tracker = new ExposureTracker();
  expect(tracker.observe('s1', 1000)).toBe(true);
  expect(tracker.observe('s1', 500)).toBe(false);
  expect(tracker.value('s1')).toBe(1000);
  expect(tracker.value('s2')).toBeNull();
});

test('exposure source precedence: the gauntlet first-generation mark wins when present (precedence hook)', () => {
  expect(exposureWithPrecedence({ gauntletMarkTsMs: 900, probeTsMs: 1000 })).toBe(900);
  expect(exposureWithPrecedence({ gauntletMarkTsMs: null, probeTsMs: 1000 })).toBe(1000);
  expect(exposureWithPrecedence({ gauntletMarkTsMs: null, probeTsMs: null })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-sensors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/campaign/sensors.ts`**

```ts
// Sensors (kernel D3, R-SNS-1..5; Decisions D-9/D-10): provider-broad
// rate-limit classification over a closed, table-driven marker registry —
// the shipped Antigravity predicate preserved EXACTLY as row 1, anchored
// provider-shaped structure mandatory for the new families (rows 2-5) —
// plus the exposure-measurement contract: per-harness tail-safe probes,
// monotonic single emission, source precedence, decision at block terminal.
// Sensors classify; the dispatcher journals (R-JRN emitters).
import { existsSync, readFileSync } from 'node:fs';
import { agyLogShowsRateLimit } from '../agents/agy-watch.ts';

export const RETRY_AFTER_MIN_MS = 5_000;

export interface RateLimitMarkerRow {
  readonly family: string;
  /** Provider/API predicate: returns the SPECIFICITY RANK when this entry
   *  applies to the credential shape, else null. D-10 precedence: runtime
   *  match (3) > credential api match (2) > base_url host match (1) >
   *  generic fallback (0) — the rank is computed per call so one family
   *  with both an api arm and a base_url arm ranks each arm correctly. */
  readonly appliesRank: (ctx: { api?: string; base_url?: string; runtimeFamily?: string }) => number | null;
  /** Structured, case-insensitive where pinned. */
  readonly matches: (text: string) => boolean;
  /** D-10 evidence sources this row is qualified against — registry
   *  metadata for qualification receipts; additions are platform PRs with
   *  per-source fixtures. (Typed cause mapping rides role attribution: the
   *  dispatcher supplies subject|grader by matched credential context, and
   *  classifier rows 1/4 map it to grader_/subject_rate_limited.) */
  readonly evidenceSources: readonly string[];
  readonly retryAfterParsed: boolean;
  readonly defaultCooldownMs: number;
  readonly maxCooldownMs: number;
}

/** The five pinned v1 rows (Decision D-10; REV-2 P-7 literals). Vocabulary
 *  is INITIAL — qualification is the live receipt; additions are platform
 *  PRs with fixtures. */
export const RATE_LIMIT_MARKERS: readonly RateLimitMarkerRow[] = [
  {
    family: 'antigravity',
    appliesRank: (ctx) => (ctx.runtimeFamily === 'antigravity' ? 3 : null),
    // Exact shipped agyLogShowsRateLimit behavior: case-insensitive
    // resource_exhausted | ratelimitexceeded | word-boundaried 429. Bare and
    // prose 429 MATCH; embedded hex (e4291) does not.
    matches: (text) => agyLogShowsRateLimit(text),
    evidenceSources: ['agy.log tail', 'verdict reason', 'gauntlet result'],
    retryAfterParsed: false, // none in signal -> default
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'anthropic',
    // api match ranks ABOVE a base_url host match (D-10 precedence) — the
    // two arms of this family carry different ranks so a foreign-api
    // credential proxying through api.anthropic.com never outranks its own
    // api family's row.
    appliesRank: (ctx) =>
      ctx.api === 'anthropic'
        ? 2
        : ctx.base_url !== undefined && new URL(ctx.base_url).host === 'api.anthropic.com'
          ? 1
          : null,
    matches: (text) => /"type"\s*:\s*"rate_limit_error"/i.test(text),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
    retryAfterParsed: true,
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'openai-compatible',
    appliesRank: (ctx) => (ctx.api === 'openai-chat' || ctx.api === 'openai-responses' ? 2 : null),
    // Anchor (D-10 row 3): JSON error body `"code":"rate_limit_exceeded"`, OR
    // an HTTP payload carrying a provider-shaped 429 status — a status-line
    // token (`HTTP/1.1 429`, `HTTP 429`) or `"status":429` JSON — together
    // with `Rate limit` text. Model-authored prose ("rate limit 429") carries
    // neither status shape and never trips (false-positive discipline).
    matches: (text) =>
      /"code"\s*:\s*"rate_limit_exceeded"/i.test(text) ||
      ((/\bHTTP(?:\/[\d.]+)? 429\b/.test(text) || /"status"\s*:\s*429\b/i.test(text)) &&
        /rate limit/i.test(text)),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
    retryAfterParsed: true,
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'gemini',
    appliesRank: (ctx) => (ctx.api === 'gemini' ? 2 : null),
    // Anchor (D-10 row 4): structured RESOURCE_EXHAUSTED in the error
    // payload — a `"status"`/`"code"` field carrying the enum. Bare or merely
    // quoted prose mentions never trip (false-positive discipline).
    matches: (text) => /"(?:status|code)"\s*:\s*"resource_exhausted"/i.test(text),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
    retryAfterParsed: true,
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'generic-http-429',
    appliesRank: () => 0, // any credential — lowest precedence
    // Structured HTTP status ONLY: never prose.
    matches: (text) =>
      /"status"\s*:\s*429\b/i.test(text) ||
      /"status_code"\s*:\s*429\b/i.test(text) ||
      /^HTTP\/[\d.]+ 429\b/m.test(text),
    evidenceSources: ['child stderr', 'gauntlet result'],
    retryAfterParsed: false, // none -> default (weak signal, conservative)
    defaultCooldownMs: 30_000,
    maxCooldownMs: 5 * 60_000,
  },
];

/** `retry-after: N` / `"retry_after": N` in seconds, or null. */
export function parseRetryAfterMs(text: string): number | null {
  const m = /retry[-_]after"?\s*[:=]\s*"?(\d+)/i.exec(text);
  if (m === null) return null;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export interface RateLimitMatch {
  readonly family: string;
  readonly cooldownMs: number;
}

/** Closed-table classification: the most specific applicable predicate wins
 *  (per-call rank from appliesRank — api match > base_url host match >
 *  generic); one match per event (first in registry order within a rank).
 *  Parsed retry-after clamps to [5s, family max]; absent -> family default. */
export function classifyRateLimit(args: {
  api?: string;
  base_url?: string;
  runtimeFamily?: string;
  text: string;
}): RateLimitMatch | null {
  let best: { row: RateLimitMarkerRow; rank: number } | null = null;
  for (const row of RATE_LIMIT_MARKERS) {
    const rank = row.appliesRank(args);
    if (rank === null) continue;
    if (!row.matches(args.text)) continue;
    if (best === null || rank > best.rank) {
      best = { row, rank };
    }
  }
  if (best === null) return null;
  const { row } = best;
  let cooldownMs = row.defaultCooldownMs;
  if (row.retryAfterParsed) {
    const parsed = parseRetryAfterMs(args.text);
    if (parsed !== null) {
      cooldownMs = Math.min(Math.max(parsed, RETRY_AFTER_MIN_MS), row.maxCooldownMs);
    }
  }
  return { family: row.family, cooldownMs };
}

// ---------------------------------------------------------------------------
// Exposure measurement (Decision D-9; R-SNS-2/3/4/5)
// ---------------------------------------------------------------------------

export interface ExposureProbe {
  readonly agent: string;
  /** The earliest Coding-Agent generation-request ts_ms from the session
   *  log, or null. TAIL-SAFE: truncation or rotation re-reads from the file
   *  start — every observation is a full read, never an offset. */
  observe(sessionLogPath: string): number | null;
}

/** Per-harness probe over an injected parser (the harness's session-log
 *  shape knowledge already encoded in src/normalize). Production wiring
 *  passes each backend's earliest-generation-request extractor; tests use
 *  fixture parsers. */
export function exposureProbeFromParser(
  agent: string,
  parse: (text: string) => readonly number[],
): ExposureProbe {
  return {
    agent,
    observe(sessionLogPath: string): number | null {
      if (!existsSync(sessionLogPath)) return null;
      let text: string;
      try {
        text = readFileSync(sessionLogPath, 'utf8');
      } catch {
        return null;
      }
      const stamps = parse(text);
      return stamps.length === 0 ? null : Math.min(...stamps);
    },
  };
}

/** Monotonic single emission per sample: the FIRST observed request
 *  timestamp wins; later observations never move it. */
export class ExposureTracker {
  private readonly first = new Map<string, number>();
  observe(sampleId: string, tsMs: number): boolean {
    if (this.first.has(sampleId)) return false;
    this.first.set(sampleId, tsMs);
    return true;
  }
  value(sampleId: string): number | null {
    return this.first.get(sampleId) ?? null;
  }
}

/** Source precedence (D1, retained): (1) the gauntlet child's first-
 *  generation mark wins when present; (2) the session-log probe. The v1
 *  fixtures trim to this hook — one synthetic-mark proof, no per-harness
 *  (1)-fixtures until a harness emits real marks. */
export function exposureWithPrecedence(args: {
  gauntletMarkTsMs: number | null;
  probeTsMs: number | null;
}): number | null {
  return args.gauntletMarkTsMs ?? args.probeTsMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-sensors.test.ts`
Expected: PASS (8 tests).

- [ ] **Commit (task 7a)**

```bash
git add src/campaign/sensors.ts test/campaign-sensors.test.ts
git commit -m "feat(campaign): D3 sensors — five-row anchored marker registry + tail-safe exposure probes"
```

#### Task 7b: contention guard — sampler, sidecar, the one pure evaluator (Steps 5–8; covers Decision D-3/D-5's sensors-lead split and the R-DSP-11 halt inputs)

**Files:** create `src/campaign/contention.ts`; create `test/campaign-contention.test.ts`.

- [ ] **Step 5: Write the failing contention tests** — create `test/campaign-contention.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { HostStats, HostStatsProbe } from '../src/campaign/host-stats.ts';
import {
  appendSidecarLine,
  breachWindows,
  ContentionSampler,
  evaluateContention,
  parseSidecar,
  samplerStaleMs,
  SIDECAR_FILENAME,
  thresholdViolations,
  type ResolvedThreshold,
  type SidecarLine,
} from '../src/campaign/contention.ts';

const GiB = 2 ** 30;
const MEM_FLOOR: ResolvedThreshold = { metric: 'mem_available_bytes', op: 'lt', value: 2 * GiB };

function stats(ts: number, memAvailable = 8 * GiB): HostStats {
  return {
    ts_ms: ts, load1: 0.1,
    mem_available_bytes: memAvailable, mem_total_bytes: 16 * GiB,
    swap_used_bytes: 0, swap_total_bytes: 2 * GiB,
    process_count: 100, disk_free_bytes: 50 * GiB, disk_total_bytes: 100 * GiB,
  };
}

test('thresholdViolations: gt/lt semantics over resolved absolute thresholds', () => {
  expect(thresholdViolations(stats(0, 1 * GiB), [MEM_FLOOR])).toEqual(['mem_available_bytes']);
  expect(thresholdViolations(stats(0, 4 * GiB), [MEM_FLOOR])).toEqual([]);
  expect(thresholdViolations(stats(0), [{ metric: 'load1', op: 'gt', value: 0.05 }])).toEqual(['load1']);
});

// The sampler loop resumes from its cadence sleep through a Promise.race —
// each clock.advance needs TWO microtask yields before the next iteration
// has run (the race's internal then, then the loop continuation).
async function tick2(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('sampler: cadence writes one fsynced JSON line per sample; probe failure writes a missing gap line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  const clock = new FakeClock(0);
  let failNext = false;
  const probe: HostStatsProbe = {
    sample(nowMs) {
      if (failNext) throw new Error('probe boom');
      return stats(nowMs);
    },
  };
  const sampler = new ContentionSampler({
    campaignDir: dir,
    probe,
    clock,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    onBreachEntry: () => {},
    onBreachExit: () => {},
    onSampleError: () => {},
  });
  const running = sampler.start(); // the FIRST sample fires at loop entry, t=0
  failNext = true;
  clock.advance(10); // iteration at t=10s: probe fails -> gap line
  await tick2();
  failNext = false;
  clock.advance(10); // iteration at t=20s: sample
  await tick2();
  await sampler.stop();
  await running;
  const { lines } = parseSidecar(dir);
  expect(lines.length).toBe(3); // sample@0, gap@10s, sample@20s
  const gaps = lines.filter((l) => 'missing' in l);
  expect(gaps.length).toBe(1);
  expect(gaps[0]).toEqual({ ts_ms: 10_000, missing: true });
});

test('symmetric K-sustained breach edges: entry after K consecutive crossings, exit after K consecutive in-bounds', () => {
  const lines: SidecarLine[] = [];
  let ts = 0;
  // 3 breached samples (K=3) -> entry; then 3 in-bounds -> exit.
  for (let i = 0; i < 3; i++) { ts += 10_000; lines.push({ ...stats(ts, 1 * GiB), breach: [] }); }
  const windowsMid = breachWindows(lines, [MEM_FLOOR], 3);
  expect(windowsMid).toHaveLength(1);
  expect(windowsMid[0]!.endTsMs).toBeNull(); // still open
  for (let i = 0; i < 3; i++) { ts += 10_000; lines.push({ ...stats(ts, 8 * GiB), breach: [] }); }
  const windows = breachWindows(lines, [MEM_FLOOR], 3);
  expect(windows).toHaveLength(1);
  expect(windows[0]!.startTsMs).toBe(30_000); // third consecutive crossing
  expect(windows[0]!.endTsMs).toBe(60_000);   // third consecutive in-bounds
  // A single in-bounds sample mid-breach does NOT close it (sustain, not flap).
  const flap: SidecarLine[] = [
    { ...stats(10_000, 1 * GiB), breach: [] },
    { ...stats(20_000, 1 * GiB), breach: [] },
    { ...stats(30_000, 8 * GiB), breach: [] }, // one good sample
    { ...stats(40_000, 1 * GiB), breach: [] },
    { ...stats(50_000, 1 * GiB), breach: [] },
    { ...stats(60_000, 1 * GiB), breach: [] },
  ];
  const flapWindows = breachWindows(flap, [MEM_FLOOR], 3);
  expect(flapWindows[0]!.endTsMs).toBeNull();
});

test('gap lines count against coverage but neither extend nor interrupt a sustain run', () => {
  const lines: SidecarLine[] = [
    { ...stats(10_000, 1 * GiB), breach: [] },
    { ts_ms: 20_000, missing: true },
    { ...stats(30_000, 1 * GiB), breach: [] },
    { ...stats(40_000, 1 * GiB), breach: [] },
  ];
  const windows = breachWindows(lines, [MEM_FLOOR], 3);
  expect(windows).toHaveLength(1);
  expect(windows[0]!.startTsMs).toBe(40_000); // the gap did not break the sustain count
});

test('torn tail: parseSidecar truncates at the last complete line, loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  appendSidecarLine(dir, { ...stats(1000), breach: [] });
  // Append a torn (unterminated JSON) tail.
  appendFileSync(join(dir, SIDECAR_FILENAME), '{"ts_ms": 2000, "load1": ');
  const { lines, truncatedTail } = parseSidecar(dir);
  expect(lines).toHaveLength(1);
  expect(truncatedTail).toBe(true);
});

test('the pure evaluator: invalid > unknown > clean precedence, one interpretation', () => {
  // Samples every 10s from t=10..90s, then one at t=250s.
  // Crossings at 10/20/30 -> the K=3 window OPENS at 30s; in-bounds at
  // 40/50/60 -> it CLOSES at 60s. The 90s->250s sample gap (160s > N x
  // cadence = 40s) is the uncovered interval [90s, 250s].
  const lines: SidecarLine[] = [];
  for (let t = 10_000; t <= 90_000; t += 10_000) {
    const breached = t <= 30_000;
    lines.push({ ...stats(t, breached ? 1 * GiB : 8 * GiB), breach: [] });
  }
  lines.push({ ...stats(250_000, 8 * GiB), breach: [] });
  const verdicts = evaluateContention({
    lines,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 250_000,
    blocks: [
      { block_id: 'overlaps-breach', startTsMs: 20_000, endTsMs: 55_000 },
      { block_id: 'in-gap', startTsMs: 100_000, endTsMs: 240_000 },
      { block_id: 'clean', startTsMs: 65_000, endTsMs: 85_000 },
    ],
  });
  expect(verdicts.get('overlaps-breach')).toBe('invalid'); // overlaps [30s, 60s]
  expect(verdicts.get('in-gap')).toBe('unknown'); // uncovered, never contention
  expect(verdicts.get('clean')).toBe('clean'); // covered, outside the window
});

test('evaluator: a still-live block clips to the breach-closure timestamp', () => {
  const lines: SidecarLine[] = [];
  for (let t = 10_000; t <= 60_000; t += 10_000) {
    lines.push({ ...stats(t, t >= 30_000 && t <= 50_000 ? 1 * GiB : 8 * GiB), breach: [] });
  }
  const verdicts = evaluateContention({
    lines,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 60_000,
    blocks: [{ block_id: 'live', startTsMs: 20_000, endTsMs: null }],
  });
  expect(verdicts.get('live')).toBe('invalid');
});

test('dead-sampler liveness: staleness > 2x cadence is detectable', () => {
  const lines: SidecarLine[] = [{ ...stats(10_000), breach: [] }];
  expect(samplerStaleMs(lines, 10_000)).toBe(0);
  expect(samplerStaleMs(lines, 31_000)).toBe(21_000); // > 2 x 10s cadence
  expect(samplerStaleMs([], 5_000)).toBe(Number.POSITIVE_INFINITY);
});

test('fsync-before-notify: the exit sample is durable BEFORE the closed-window callback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  const clock = new FakeClock(0);
  const probe: HostStatsProbe = {
    sample(nowMs) { return stats(nowMs, nowMs >= 10_000 && nowMs <= 30_000 ? 1 * GiB : 8 * GiB); },
  };
  let exitLineCountAtNotify = -1;
  const sampler = new ContentionSampler({
    campaignDir: dir,
    probe,
    clock,
    thresholds: [MEM_FLOOR],
    sustainK: 1, // fast edges for the test
    cadenceMs: 10_000,
    onBreachEntry: () => {},
    onBreachExit: () => {
      exitLineCountAtNotify = readFileSync(join(dir, SIDECAR_FILENAME), 'utf8')
        .split('\n').filter((l) => l !== '').length;
    },
    onSampleError: () => {},
  });
  const running = sampler.start(); // samples at t=0 (in-bounds), then per tick
  for (let i = 0; i < 4; i++) { clock.advance(10); await tick2(); }
  await sampler.stop();
  await running;
  // Iterations at t=0,10,20,30,40: entry at 10s (K=1), exit at 40s. When the
  // exit callback fired, the sidecar ALREADY held all five lines including
  // the exit sample — the pinned fsync-before-notify order.
  expect(exitLineCountAtNotify).toBe(5);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test test/campaign-contention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `src/campaign/contention.ts`**

```ts
// Contention guard (kernel D3, Decision D-3 — sensors lead): the timer-
// driven sampler + fsynced sidecar + ONE pure edge/coverage/interval/
// overlap/tri-state evaluator shared VERBATIM by the dispatcher (task 8)
// and D4's seal-time audit/backstop. Raw telemetry never enters the
// fsync-per-event journal; the sidecar is retained evidence, decision
// evidence for closed-window mints, and NOT replay-required.
import { existsSync, openSync, readFileSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../scheduler/clock.ts';
import { clockNowMs, type HostStats, type HostStatsProbe } from './host-stats.ts';

export const SIDECAR_FILENAME = 'contention-telemetry.jsonl';

export interface TelemetrySample {
  readonly ts_ms: number;
  readonly load1: number;
  readonly mem_available_bytes: number;
  readonly swap_used_bytes: number;
  readonly process_count: number;
  readonly disk_free_bytes: number;
  /** Non-empty while a breach window is open (breached metric names). */
  readonly breach: readonly string[];
}

export interface TelemetryGap {
  readonly ts_ms: number;
  readonly missing: true; // missed sample (probe error, scheduler stall)
}

export type SidecarLine = TelemetrySample | TelemetryGap;

/** Append one JSON line, fsynced per sample (Decision D-3). */
export function appendSidecarLine(campaignDir: string, line: SidecarLine): void {
  const path = join(campaignDir, SIDECAR_FILENAME);
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Torn-tail tolerant parse: truncate at the last COMPLETE line with a loud
 *  flag; the truncated interval counts as uncovered. */
export function parseSidecar(campaignDir: string): { lines: SidecarLine[]; truncatedTail: boolean } {
  const path = join(campaignDir, SIDECAR_FILENAME);
  if (!existsSync(path)) return { lines: [], truncatedTail: false };
  const text = readFileSync(path, 'utf8');
  const rawLines = text.split('\n');
  const lines: SidecarLine[] = [];
  let truncatedTail = false;
  for (const raw of rawLines) {
    if (raw === '') continue;
    try {
      lines.push(JSON.parse(raw) as SidecarLine);
    } catch {
      truncatedTail = true; // crash mid-append: torn tail
    }
  }
  if (truncatedTail) {
    process.stderr.write(
      `contention sidecar at ${path} has a torn tail — truncated at the last complete line; the truncated interval counts as uncovered\n`,
    );
  }
  return { lines, truncatedTail };
}

export interface ResolvedThreshold {
  readonly metric: string;
  readonly op: 'gt' | 'lt';
  readonly value: number;
}

/** The registered threshold -> sample comparison. Metric sources pinned:
 *  load1, mem available, swap used, process count, disk free. */
export function thresholdViolations(
  // The metric subset both HostStats and sidecar TelemetrySample carry —
  // breachWindows re-evaluates persisted lines through the same predicate.
  sample: Pick<HostStats, 'load1' | 'mem_available_bytes' | 'swap_used_bytes' | 'process_count' | 'disk_free_bytes'>,
  thresholds: readonly ResolvedThreshold[],
): string[] {
  const metricValue = (metric: string): number | null => {
    switch (metric) {
      case 'load1':
      case 'load1_per_core':
        return sample.load1;
      case 'mem_available_bytes':
        return sample.mem_available_bytes;
      case 'swap_used_bytes':
        return sample.swap_used_bytes;
      case 'process_count':
        return sample.process_count;
      case 'disk_free_bytes':
        return sample.disk_free_bytes;
      default:
        return null;
    }
  };
  const violated: string[] = [];
  for (const t of thresholds) {
    const v = metricValue(t.metric);
    if (v === null) continue;
    if (t.op === 'gt' ? v > t.value : v < t.value) violated.push(t.metric);
  }
  return violated;
}

export interface BreachWindow {
  readonly startTsMs: number;
  /** null = still open. */
  readonly endTsMs: number | null;
  readonly metrics: readonly string[];
}

/** Symmetric K-sustained edges (REV-2 P-6): entry = sustain_k consecutive
 *  threshold crossings; exit = sustain_k consecutive samples back inside
 *  every breached threshold. sustain_k (samples) is the ONLY hysteresis.
 *  Missing-sample gap lines neither extend nor interrupt a sustain run. */
export function breachWindows(
  lines: readonly SidecarLine[],
  thresholds: readonly ResolvedThreshold[],
  sustainK: number,
): BreachWindow[] {
  const windows: BreachWindow[] = [];
  let crossingRun: { count: number; metrics: string[]; lastTs: number } | null = null;
  let openWindow: { startTsMs: number; metrics: string[] } | null = null;
  let inBoundsRun = 0;
  for (const line of lines) {
    if ('missing' in line) continue; // gaps neither extend nor interrupt
    const violated = thresholdViolations(line, thresholds);
    if (openWindow === null) {
      if (violated.length > 0) {
        if (crossingRun === null) crossingRun = { count: 0, metrics: violated, lastTs: line.ts_ms };
        crossingRun.count += 1;
        crossingRun.metrics = [...new Set([...crossingRun.metrics, ...violated])];
        crossingRun.lastTs = line.ts_ms;
        if (crossingRun.count >= sustainK) {
          openWindow = { startTsMs: crossingRun.lastTs, metrics: crossingRun.metrics };
          crossingRun = null;
          inBoundsRun = 0;
        }
      } else {
        crossingRun = null;
      }
    } else {
      if (violated.length === 0) {
        inBoundsRun += 1;
        if (inBoundsRun >= sustainK) {
          windows.push({ startTsMs: openWindow.startTsMs, endTsMs: line.ts_ms, metrics: openWindow.metrics });
          openWindow = null;
          inBoundsRun = 0;
        }
      } else {
        inBoundsRun = 0; // symmetric: crossings reset the in-bounds run
      }
    }
  }
  if (openWindow !== null) {
    windows.push({ startTsMs: openWindow.startTsMs, endTsMs: null, metrics: openWindow.metrics });
  }
  return windows;
}

/** Dead-sampler liveness input: age of the newest sample (infinity when the
 *  sidecar is empty). The dispatcher halts admission above 2 x cadence. */
export function samplerStaleMs(lines: readonly SidecarLine[], nowMs: number): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const line of lines) newest = Math.max(newest, line.ts_ms);
  if (newest === Number.NEGATIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return nowMs - newest;
}

export type BlockContentionVerdict = 'invalid' | 'unknown' | 'clean';

export interface BlockInterval {
  readonly block_id: string;
  /** Earliest roster attempt_created.ts_ms (journal-reconstructable). */
  readonly startTsMs: number;
  /** Latest service-end terminal ts_ms; null = still live (clipped to the
   *  evaluation horizon for a closed-window evaluation). */
  readonly endTsMs: number | null;
}

export interface EvaluateContentionArgs {
  readonly lines: readonly SidecarLine[];
  readonly thresholds: readonly ResolvedThreshold[];
  readonly sustainK: number;
  readonly cadenceMs: number;
  readonly coverageN: number;
  readonly campaignOpenedTsMs: number;
  readonly lastTerminalTsMs: number;
  readonly blocks: readonly BlockInterval[];
}

/** THE one pure evaluator (Decision D-3/D-5): breach edges, coverage,
 *  journal-derived conservative block intervals, overlap, and the final
 *  tri-state — shared verbatim by the dispatcher and D4. Precedence: known
 *  breach overlap -> invalid; else uncovered overlap -> unknown (NEVER
 *  contention); else clean. */
export function evaluateContention(args: EvaluateContentionArgs): Map<string, BlockContentionVerdict> {
  const windows = breachWindows(args.lines, args.thresholds, args.sustainK);
  // Coverage: [campaign_opened.ts_ms, last sample terminal ts_ms] covered
  // within N x cadence by real samples; gaps + torn tail count uncovered.
  const sampleTs = args.lines.filter((l) => !('missing' in l)).map((l) => l.ts_ms).sort((a, b) => a - b);
  const uncovered: Array<{ start: number; end: number }> = [];
  const horizon = args.lastTerminalTsMs;
  const maxGap = args.coverageN * args.cadenceMs;
  let prev = args.campaignOpenedTsMs;
  for (const ts of sampleTs) {
    if (ts > prev + maxGap) uncovered.push({ start: prev, end: ts });
    prev = ts;
  }
  if (horizon > prev + maxGap) uncovered.push({ start: prev, end: horizon });
  // The newest sample ts bounds the horizon for live-block clipping.
  const newestSampleTs = sampleTs[sampleTs.length - 1] ?? args.campaignOpenedTsMs;
  const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
    aStart <= bEnd && bStart <= aEnd;

  const verdicts = new Map<string, BlockContentionVerdict>();
  for (const block of args.blocks) {
    // Conservative interval; a still-live block clips to the horizon
    // (breach-closure timestamp for a closed-window evaluation).
    const end = block.endTsMs ?? Math.min(newestSampleTs, horizon);
    let verdict: BlockContentionVerdict = 'clean';
    for (const gap of uncovered) {
      if (overlaps(block.startTsMs, end, gap.start, gap.end)) verdict = 'unknown';
    }
    for (const window of windows) {
      const windowEnd = window.endTsMs ?? Math.min(newestSampleTs, horizon);
      if (overlaps(block.startTsMs, end, window.startTsMs, windowEnd)) {
        verdict = 'invalid'; // known breach wins over uncovered
      }
    }
    verdicts.set(block.block_id, verdict);
  }
  return verdicts;
}

export interface SamplerArgs {
  readonly campaignDir: string;
  readonly probe: HostStatsProbe;
  readonly clock: Clock;
  readonly thresholds: readonly ResolvedThreshold[];
  readonly sustainK: number;
  readonly cadenceMs: number;
  readonly onBreachEntry: (metrics: readonly string[]) => void;
  readonly onBreachExit: (window: BreachWindow) => void;
  readonly onSampleError: (err: unknown) => void;
}

/** The timer-driven sampler: reads the host-stats probe at the registered
 *  cadence, appends one fsynced JSON line per sample, detects symmetric
 *  K-sustained breach edges, and hands closed windows to the dispatcher —
 *  fsyncing the exit sample BEFORE notification (pinned order). */
export class ContentionSampler {
  private readonly args: SamplerArgs;
  private stopping = false;
  private stopResolve: (() => void) | null = null;
  // Resolved by stop(): races the parked cadence sleep so the loop observes
  // stopping promptly — a FakeClock never advances on its own, and stop()
  // must not depend on the test driving time forward.
  private readonly stopSignal = new Promise<void>((resolve) => {
    this.stopResolve = resolve;
  });
  private crossedRun = 0;
  private crossedMetrics: string[] = [];
  private openSince: number | null = null;
  private inBoundsRun = 0;

  constructor(args: SamplerArgs) {
    this.args = args;
  }

  /** Returns the run loop's promise (tests await it after stop()). */
  start(): Promise<void> {
    return this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopResolve?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const nowMs = clockNowMs(this.args.clock);
      try {
        const sample = this.args.probe.sample(nowMs);
        const violated = thresholdViolations(sample, this.args.thresholds);
        // Edge tracking is PURE here; the entry/exit notification is
        // deferred until AFTER the sample line is appended + fsynced —
        // the pinned order: the exit sample is DURABLE before the
        // dispatcher's resolution batch re-reads the sidecar.
        const notify = this.trackEdges(nowMs, violated);
        const breach = this.openSince !== null ? this.crossedMetricsAtOpen ?? violated : [];
        appendSidecarLine(this.args.campaignDir, {
          ts_ms: sample.ts_ms,
          load1: sample.load1,
          mem_available_bytes: sample.mem_available_bytes,
          swap_used_bytes: sample.swap_used_bytes,
          process_count: sample.process_count,
          disk_free_bytes: sample.disk_free_bytes,
          breach,
        });
        notify?.();
      } catch (err) {
        // Missing-sample policy: record the gap; the dispatcher sees it via
        // coverage; ENOSPC here reports into the pause path (onSampleError).
        appendSidecarLineSafe(this.args.campaignDir, { ts_ms: nowMs, missing: true }, this.args.onSampleError);
        this.args.onSampleError(err);
      }
      await Promise.race([
        this.args.clock.sleepUntil(this.args.clock.now() + this.args.cadenceMs / 1000),
        this.stopSignal,
      ]);
    }
  }

  private crossedMetricsAtOpen: string[] | null = null;

  /** Pure edge tracking: mutates the runs/window state and returns the
   *  DEFERRED notification (entry or exit) for the caller to fire after the
   *  sample line is durable — never notifies inline. */
  private trackEdges(nowMs: number, violated: string[]): (() => void) | null {
    const { sustainK } = this.args;
    if (this.openSince === null) {
      if (violated.length > 0) {
        this.crossedRun += 1;
        this.crossedMetrics = [...new Set([...this.crossedMetrics, ...violated])];
        if (this.crossedRun >= sustainK) {
          this.openSince = nowMs;
          this.crossedMetricsAtOpen = [...this.crossedMetrics];
          this.inBoundsRun = 0;
          const metrics = this.crossedMetricsAtOpen;
          return () => this.args.onBreachEntry(metrics);
        }
      } else {
        this.crossedRun = 0;
        this.crossedMetrics = [];
      }
      return null;
    }
    if (violated.length === 0) {
      this.inBoundsRun += 1;
      if (this.inBoundsRun >= sustainK) {
        const window: BreachWindow = {
          startTsMs: this.openSince,
          endTsMs: nowMs,
          metrics: this.crossedMetricsAtOpen ?? [],
        };
        this.openSince = null;
        this.crossedMetricsAtOpen = null;
        this.crossedRun = 0;
        this.crossedMetrics = [];
        this.inBoundsRun = 0;
        // Fired by the caller AFTER the exit sample is appended + fsynced
        // (pinned order: fsync-before-closed-window-notify).
        return () => this.args.onBreachExit(window);
      }
    } else {
      this.inBoundsRun = 0;
    }
    return null;
  }
}

function appendSidecarLineSafe(
  campaignDir: string,
  line: SidecarLine,
  onError: (err: unknown) => void,
): void {
  try {
    appendSidecarLine(campaignDir, line);
  } catch (err) {
    onError(err); // the gap could not be recorded — the pause path owns it
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test test/campaign-contention.test.ts`
Expected: PASS (9 tests).

- [ ] **Commit (task 7b)**

```bash
git add src/campaign/contention.ts test/campaign-contention.test.ts
git commit -m "feat(campaign): D3 contention guard — fsynced sidecar, K-sustained edges, one pure evaluator"
```

#### Task 7c: failure classifier — the closed 14-row table (Steps 9–13; covers R-CLS-1/2/3/4/6)

**Files:** create `src/campaign/classifier.ts`; create `test/campaign-classifier.test.ts`.

- [ ] **Step 9: Write the failing classifier tests** — create `test/campaign-classifier.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { RUN_ERROR_STAGES, type RunErrorStage } from '../src/contracts/verdict.ts';
import { classifyFailure, type ClassificationInput } from '../src/campaign/classifier.ts';

const OUTCOMES = ['pass', 'fail', 'indeterminate'] as const;
const EXIT_CLASSES = ['clean', 'signal', 'crash', 'spawn-failed'] as const;
const ROLES = ['subject', 'grader'] as const;
const EVIDENCE = ['none', '429-match', 'billing-exhaustion', 'manifest-mismatch'] as const;

function inputs(): ClassificationInput[] {
  const all: ClassificationInput[] = [];
  const stages: (RunErrorStage | undefined)[] = [undefined, ...RUN_ERROR_STAGES];
  for (const outcome of OUTCOMES) {
    for (const stage of stages) {
      for (const exitClass of EXIT_CLASSES) {
        for (const role of ROLES) {
          for (const sensorEvidence of EVIDENCE) {
            all.push({
              outcome,
              ...(stage !== undefined ? { stage } : {}),
              exitClass,
              role,
              sensorEvidence,
            });
          }
        }
      }
    }
  }
  return all;
}

test('the pinned 14 rows, first-match-wins', () => {
  // Row 1: grader 429 -> grader_rate_limited.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'gauntlet', exitClass: 'clean', role: 'grader', sensorEvidence: '429-match' })).toEqual({ class: 'instrument', cause: 'grader_rate_limited' });
  // Row 2: grader billing exhaustion.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'gauntlet', exitClass: 'clean', role: 'grader', sensorEvidence: 'billing-exhaustion' })).toEqual({ class: 'instrument', cause: 'grader_billing_exhausted' });
  // Row 3: qa-agent-misconfigured.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'qa-agent-misconfigured', exitClass: 'clean', role: 'grader', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'grader_misconfigured' });
  // Row 4: throttled SUBJECT — outcome-independent (a recovered/pass outcome
  // does not condition the instrument fault; ratified Round-4 S-13).
  expect(classifyFailure({ outcome: 'pass', exitClass: 'clean', role: 'subject', sensorEvidence: '429-match' })).toEqual({ class: 'instrument', cause: 'subject_rate_limited' });
  // Row 5: setup.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'setup', exitClass: 'clean', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'setup_failed' });
  // Row 6: spawn-failed.
  expect(classifyFailure({ outcome: 'indeterminate', exitClass: 'spawn-failed', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'subject_spawn_failed' });
  // Row 7: gauntlet stage + signal/crash exit -> grader_crashed.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'gauntlet', exitClass: 'crash', role: 'grader', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'grader_crashed' });
  // Row 8: subject signal/crash without a stage -> subject_crashed.
  expect(classifyFailure({ outcome: 'indeterminate', exitClass: 'signal', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'subject_crashed' });
  // Row 9 + 10: capture, checks.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'capture', exitClass: 'clean', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'capture_failed' });
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'checks', exitClass: 'crash', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'instrument', cause: 'checks_crashed' });
  // Row 11: composer false-pass guard.
  expect(classifyFailure({ outcome: 'pass', stage: 'compose', exitClass: 'clean', role: 'subject', sensorEvidence: 'manifest-mismatch' })).toEqual({ class: 'instrument', cause: 'checks_crashed' });
  // Row 12: stopped -> aborted class.
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'stopped', exitClass: 'clean', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'aborted' });
  // Row 13: determinate outcomes with no stage error -> evidence.
  expect(classifyFailure({ outcome: 'pass', exitClass: 'clean', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'evidence' });
  expect(classifyFailure({ outcome: 'fail', exitClass: 'clean', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'evidence' });
  // Row 14 default: unknown stays evidence — NEVER instrument (R-CLS-4).
  expect(classifyFailure({ outcome: 'indeterminate', stage: 'unknown', exitClass: 'clean', role: 'subject', sensorEvidence: 'none' })).toEqual({ class: 'evidence' });
});

test('exhaustive product: every combination classifies, codomain closed, default never instrument', () => {
  for (const input of inputs()) {
    const result = classifyFailure(input);
    expect(['instrument', 'evidence', 'aborted', 'shortfall']).toContain(result.class);
    if (result.class === 'instrument') expect(result.cause).toBeDefined();
    // R-CLS-4: no stage, clean exit, no sensor evidence -> never instrument.
    if (input.stage === undefined && input.exitClass === 'clean' && input.sensorEvidence === 'none') {
      expect(result.class).toBe('evidence');
    }
  }
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `bun test test/campaign-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 11: Implement `src/campaign/classifier.ts`**

```ts
// Failure classifier (kernel D3, R-CLS-1..6): the CLOSED table-driven map
// ClassificationInput -> { class, cause? }, exhaustive over the product
// verdict outcome x RunErrorStage x exit class x child role x sensor
// evidence. First matching row wins; the final default row makes
// exhaustiveness structural. Unknown stays evidence (indeterminate), NEVER
// instrument — outcome-independence lives or dies on that trigger set.
import type { RunErrorStage } from '../contracts/verdict.ts';
import type { FailureClass, InstrumentCause } from '../contracts/campaign/typed-failures.ts';

export interface ClassificationInput {
  readonly outcome: 'pass' | 'fail' | 'indeterminate';
  readonly stage?: RunErrorStage;
  readonly exitClass: 'clean' | 'signal' | 'crash' | 'spawn-failed';
  readonly role: 'subject' | 'grader';
  readonly sensorEvidence: 'none' | '429-match' | 'billing-exhaustion' | 'manifest-mismatch';
}

export interface Classification {
  readonly class: FailureClass;
  readonly cause?: InstrumentCause;
}

interface Row {
  readonly match: (input: ClassificationInput) => boolean;
  readonly class: FailureClass;
  readonly cause?: InstrumentCause;
}

/** The pinned v1 rows (spec classifier table), first-wins top-down. */
const ROWS: readonly Row[] = [
  { match: (i) => i.role === 'grader' && i.sensorEvidence === '429-match', class: 'instrument', cause: 'grader_rate_limited' },
  { match: (i) => i.role === 'grader' && i.sensorEvidence === 'billing-exhaustion', class: 'instrument', cause: 'grader_billing_exhausted' },
  { match: (i) => i.stage === 'qa-agent-misconfigured', class: 'instrument', cause: 'grader_misconfigured' },
  { match: (i) => i.role === 'subject' && i.sensorEvidence === '429-match', class: 'instrument', cause: 'subject_rate_limited' },
  { match: (i) => i.stage === 'setup', class: 'instrument', cause: 'setup_failed' },
  { match: (i) => i.exitClass === 'spawn-failed', class: 'instrument', cause: 'subject_spawn_failed' },
  {
    match: (i) => i.stage === 'gauntlet' && (i.exitClass === 'signal' || i.exitClass === 'crash'),
    class: 'instrument',
    cause: 'grader_crashed',
  },
  {
    match: (i) =>
      i.role === 'subject' &&
      (i.exitClass === 'signal' || i.exitClass === 'crash') &&
      i.stage === undefined,
    class: 'instrument',
    cause: 'subject_crashed',
  },
  { match: (i) => i.stage === 'capture', class: 'instrument', cause: 'capture_failed' },
  { match: (i) => i.stage === 'checks', class: 'instrument', cause: 'checks_crashed' },
  {
    // Composer false-pass guard (parent Checks).
    match: (i) => i.stage === 'compose' && i.sensorEvidence === 'manifest-mismatch',
    class: 'instrument',
    cause: 'checks_crashed',
  },
  { match: (i) => i.stage === 'stopped', class: 'aborted' },
  { match: (i) => (i.outcome === 'pass' || i.outcome === 'fail') && i.stage === undefined, class: 'evidence' },
  // Default — every other combination: evidence (indeterminate), NEVER
  // instrument (R-CLS-4).
  { match: () => true, class: 'evidence' },
];

export function classifyFailure(input: ClassificationInput): Classification {
  for (const row of ROWS) {
    if (row.match(input)) {
      return row.cause === undefined
        ? { class: row.class }
        : { class: row.class, cause: row.cause };
    }
  }
  // Unreachable: the final row matches everything. Loud, never defaulted.
  throw new Error('classifier table lost exhaustiveness — the default row must match');
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `bun test test/campaign-classifier.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 13: Full gate + commit (task 7c)**

Run: `bun run check` and `bun run quorum check`.
Expected: green.

```bash
git add src/campaign/classifier.ts test/campaign-classifier.test.ts
git commit -m "feat(campaign): D3 failure classifier — the closed 14-row table

Exhaustive over the ClassificationInput product, first-wins rows, the
default arm evidence/indeterminate (unknown NEVER instrument, R-CLS-4);
grader billing/429 become typed instrument causes (R-CLS-3)."
```

---

### Task 8: the dispatcher

**Files:**
- Create: `src/campaign/dispatcher.ts`
- Test: create `test/campaign-dispatcher.test.ts`

**Interfaces:**
- Consumes: `electWriter`, `isStorageFullError`, `releaseBallast`, `type JournalWriter`, `type EventInput` from `src/campaign/journal.ts` (Task 3); `verifyCampaignSnapshot`, `driftAffectedBlockIds`, `type InFlightBlock` from `src/campaign/snapshot.ts` (Task 4); `type SnapshotHandle`, `SnapshotDriftError` from `src/campaign/instrument-snapshot.ts`; `rerunInstanceId` from `src/campaign/registration.ts` (Task 5 — no cycle: registration never imports the dispatcher); `DetachedChildSpawner`, `buildCampaignChildArgv`, `parseRunAllocatedLine`, `assertProcessGroupExists`, `keyGrantsPayload`, `childCoveredEnv`, `type ChildSpawner`, `type SpawnedCampaignChild` from `src/campaign/spawn.ts` (Task 6); `resolveKeyForSpawn`, `warnKeyWait` from `src/campaign/key-select.ts` (Task 6); `classifyFailure` from `src/campaign/classifier.ts` (Task 7); `classifyRateLimit`, `ExposureTracker` from `src/campaign/sensors.ts` (Task 7); `ContentionSampler`, `evaluateContention`, `parseSidecar`, `samplerStaleMs`, `type BlockInterval`, `type BreachWindow`, `type ResolvedThreshold` from `src/campaign/contention.ts` (Task 7); `type Campaign`, `type Block` from `src/contracts/campaign/campaign.ts`; `poolKey` from `src/contracts/campaign/pool.ts`; `GRADER_POOL`, `GLOBAL_POOL` from `src/campaign/simulate.ts` (Phase 0's reserved pool names); `normalizeBlockReplaced` from `src/contracts/campaign/journal-events.ts`; `type RunErrorStage` from `src/contracts/verdict.ts`; `Clock`, `RealClock` from `src/scheduler/clock.ts`; `realProcessIdentityProbe`, `type ProcessIdentityProbe` from `src/campaign/locks.ts` (Task 2); `clockNowMs`, `type HostStatsProbe` from `src/campaign/host-stats.ts`; `defaultCommandRunner`, `type CommandRunner` from `src/agents/command-runner.ts`; `registerCampaign` output shape (`campaign.json` read via `readFileSync` + `CampaignSchema.parse`) from Task 5.
- Produces (task 9's recovery/CLI layer drives this):
  - `export class DispatcherError extends Error`
  - `export interface DispatchRunArgs` (below), `export interface DispatchOutcome { readonly status: 'completed' | 'cancelled' | 'signalled' | 'halted' | 'storage_paused'; readonly reason?: string }`
  - `export function runCampaignDispatch(args: DispatchRunArgs): Promise<DispatchOutcome>`
  - Sampler seam (F-class: typed, production wiring in task 9): `export interface DispatchSamplerHooks { onBreachEntry(metrics: readonly string[]): void; onBreachExit(window: BreachWindow): void; onSampleError(err: unknown): void }`; `export interface DispatchSamplerSeam { start(hooks: DispatchSamplerHooks): () => void | Promise<void> }`; `export function realSamplerSeam(args: { campaignDir: string; contention: Campaign['contention']; probe: HostStatsProbe; clock: Clock }): DispatchSamplerSeam` — constructs the real `ContentionSampler` over the host-stats probe with the dispatcher's hooks; `resumeCampaign` (task 9, the sole production caller) passes it
  - `export function performStoragePause(args: { campaignDir: string; writer: JournalWriter; killAll: () => void; stream: { write(s: string): void } }): void` — the D-13 pinned pause sequence steps 2–6 (defined HERE so the dispatcher's detection sites call it without a recovery-module cycle; task 9 re-exports nothing — D4/tests import it from the dispatcher)
  - `export function nextRerunInstanceId(predecessorId: string): string` (lineage-root instance sequencing, shared with task 9's rerun mints); `export interface TerminalVerdict`; `export function readVerdictSummary(runDir: string): TerminalVerdict | null` (the production verdict reader behind the `readVerdict` seam); `export function trajectoryExposureMs(runDir: string): number | null` (the production D-9 exposure source behind the `observeExposure` seam); `export interface ContentionResolutionResult` + `export function contentionResolutionBatch(...)` (landed by task 9a's refactor — dispatch and recovery share one resolution order)
  - Pure cores (exported for tests + task 9): `export function blockDemandVector(args: { block: Block; sampleArmCredentialPool: (sampleId: string) => string; graderPool: string }): Map<string, number>`; `export function blockPrioritySeconds(args: { block: Block; sampleEstimateSeconds: (sampleId: string) => number }): number` (max across samples — R-DSP-2); `export function compareAdmissionOrder(a: { block_id: string }, b: { block_id: string }): number` (comparison ordinal, cell key, replicate ordinal); `export function estimateInflightTotal(args: { exposureSamples: readonly { sampleId: string }[]; estimateCostUsd: (sampleId: string) => number }): number` (E7.7 absolute-total snapshot value); `export const SPAWN_FAILURE_HALT_N = 3`

Task 8 runs as two executable sub-tasks (8a → 8b) over one module + one test file; each has its own failing-tests-first cycle, verify command, and green commit (8a's commit carries no red orchestrator tests — those are written in 8b).

#### Task 8a: dispatcher pure cores (Steps 1–4; covers R-DSP-1's demand vector, R-DSP-2's priority + deterministic tie-break, E7.7's absolute-total value)

**Files:** create `src/campaign/dispatcher.ts` (pure cores only); create `test/campaign-dispatcher.test.ts` (pure-cores test only).

- [ ] **Step 1: Write the failing pure-cores test** — create `test/campaign-dispatcher.test.ts`:

```ts
import { expect, test } from 'bun:test';
import {
  blockDemandVector,
  blockPrioritySeconds,
  compareAdmissionOrder,
  estimateInflightTotal,
} from '../src/campaign/dispatcher.ts';
import { GRADER_POOL, GLOBAL_POOL } from '../src/campaign/simulate.ts';

test('pure cores: demand vector per sample (subject + grader + global), priority = max sample estimate, deterministic order', () => {
  const demand = blockDemandVector({
    block: { block_id: 'b', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
    sampleArmCredentialPool: () => 'poolA',
    graderPool: 'graderPool',
  });
  expect(demand.get('poolA')).toBe(2); // two samples on one pool
  expect(demand.get(GRADER_POOL)).toBe(2);
  expect(demand.get(GLOBAL_POOL)).toBe(2); // per-sample global slots (Decision D-1)
  const priority = blockPrioritySeconds({
    block: { block_id: 'b', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
    sampleEstimateSeconds: (s) => (s === 's1' ? 100 : 300),
  });
  expect(priority).toBe(300); // max across samples (REV sol #15)
  expect(compareAdmissionOrder({ block_id: 'c1:a:b2' }, { block_id: 'c1:a:b1' })).toBeGreaterThan(0);
  expect(compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c2:a:b1' })).toBeLessThan(0);
  expect(estimateInflightTotal({ exposureSamples: [{ sampleId: 'a' }, { sampleId: 'b' }], estimateCostUsd: () => 1.5 })).toBe(3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/campaign-dispatcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure cores** — create `src/campaign/dispatcher.ts`:

```ts
// The campaign dispatcher (kernel D3, R-DSP-1..13): a THIN dispatcher over
// the shared execution primitive — CLI-argv children of the snapshot's own
// entrypoint, never in-process runScenario, runSchedule not generalized.
// Atomic per-block admission across subject pools + grader pool + the
// per-sample global cap; longest-expected-first + backfill; 429 cooldowns;
// E7 replacement/rerun entry with the ordered mint bundle; absolute-total
// budget snapshots with never-resurrects; the closed-window contention
// resolution batch; wave + block-terminal snapshot verify with the D-11
// drift response; D-13 storage-pause detection; halts; and D-12
// signal handling in the pinned order. This sub-task lands the pure cores;
// task 8b appends the orchestrator (and widens this import block).
import type { Block } from '../contracts/campaign/campaign.ts';
import { GRADER_POOL, GLOBAL_POOL } from './simulate.ts';

export class DispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherError';
  }
}

export const SPAWN_FAILURE_HALT_N = 3;

/** R-DSP-1: a block's demand vector is PER SAMPLE — 1 subject-pool slot +
 *  1 grader slot + 1 global slot (Decision D-1) — aggregated by pool key
 *  (a two-arm block on one credential demands 2 slots from one pool). */
export function blockDemandVector(args: {
  block: Block;
  sampleArmCredentialPool: (sampleId: string) => string;
  graderPool: string;
}): Map<string, number> {
  const demand = new Map<string, number>();
  for (const sampleId of args.block.sample_ids) {
    const subject = args.sampleArmCredentialPool(sampleId);
    demand.set(subject, (demand.get(subject) ?? 0) + 1);
    demand.set(GRADER_POOL, (demand.get(GRADER_POOL) ?? 0) + 1);
    demand.set(GLOBAL_POOL, (demand.get(GLOBAL_POOL) ?? 0) + 1);
  }
  return demand;
}

/** R-DSP-2: dispatch priority = the MAX expected duration across the
 *  block's samples (a two-arm block is as long as its longest arm). */
export function blockPrioritySeconds(args: {
  block: Block;
  sampleEstimateSeconds: (sampleId: string) => number;
}): number {
  let max = 0;
  for (const sampleId of args.block.sample_ids) {
    max = Math.max(max, args.sampleEstimateSeconds(sampleId));
  }
  return max;
}

/** Deterministic admission tie-break: comparison ordinal, cell key,
 *  replicate ordinal. block_id grammar: c<N>:<scenario>:b<R> / :x<K>. */
export function compareAdmissionOrder(
  a: { block_id: string },
  b: { block_id: string },
): number {
  const parse = (id: string): { cmp: number; cell: string; rep: number } => {
    const m = /^c(\d+):(.+):[bx](\d+)(?::|$)/.exec(id);
    if (m === null) return { cmp: Number.MAX_SAFE_INTEGER, cell: id, rep: 0 };
    return { cmp: Number(m[1]), cell: m[2] ?? '', rep: Number(m[3]) };
  };
  const pa = parse(a.block_id);
  const pb = parse(b.block_id);
  if (pa.cmp !== pb.cmp) return pa.cmp - pb.cmp;
  if (pa.cell !== pb.cell) return pa.cell < pb.cell ? -1 : 1;
  return pa.rep - pb.rep;
}

/** E7.7: the absolute-total snapshot value — total remaining estimated
 *  exposure of the current budget-exposure set. */
export function estimateInflightTotal(args: {
  exposureSamples: readonly { sampleId: string }[];
  estimateCostUsd: (sampleId: string) => number;
}): number {
  let total = 0;
  for (const s of args.exposureSamples) total += args.estimateCostUsd(s.sampleId);
  return total;
}
```

- [ ] **Step 4: Run + commit (task 8a)**

Run: `bun test test/campaign-dispatcher.test.ts`
Expected: PASS (1 test).

```bash
git add src/campaign/dispatcher.ts test/campaign-dispatcher.test.ts
git commit -m "feat(campaign): D3 dispatcher pure cores — demand vector, priority, tie-break, E7.7 total"
```

#### Task 8b: the orchestrator (Steps 5–10; covers R-DSP-1/3/4/5/6/7/8/9/10/11/12/13, the D-11 drift sequence, D-13 detection, and the D-12 signal order)

**Files:** modify `src/campaign/dispatcher.ts` (widen imports; append seam types, `realSamplerSeam`, `performStoragePause`, `DispatchRunArgs`, `runCampaignDispatch`); extend `test/campaign-dispatcher.test.ts` (fixture machinery + 12 orchestrator tests).

- [ ] **Step 5: Write the failing orchestrator tests** — extend `test/campaign-dispatcher.test.ts`: REPLACE its import block with the full set below, then append the fixture machinery and tests. The fixture machinery: a published campaign dir built directly on the journal + a FAKE spawner with scripted children (seams carry the fiction; clock is a FakeClock):

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, type Clock } from '../src/scheduler/clock.ts';
import { electWriter, initJournalDb, openJournalRead } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { ChildSpawner, CampaignChildSpec, SpawnedCampaignChild, ChildExitInfo } from '../src/campaign/spawn.ts';
import {
  blockDemandVector,
  blockPrioritySeconds,
  compareAdmissionOrder,
  estimateInflightTotal,
  runCampaignDispatch,
  SPAWN_FAILURE_HALT_N,
  type DispatchRunArgs,
  type DispatchSamplerHooks,
  type DispatchSamplerSeam,
} from '../src/campaign/dispatcher.ts';
import { SnapshotDriftError } from '../src/campaign/instrument-snapshot.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import { GRADER_POOL, GLOBAL_POOL } from '../src/campaign/simulate.ts';

const IDENTITY: ProcessIdentityProbe = { exists: () => 'alive', startTimeMs: () => 1 };

// --- Fake spawner: scripted children --------------------------------------
class FakeChild {
  readonly pid: number;
  stdout: string[] = [];
  stderr: string[] = [];
  exitInfo: ChildExitInfo | null = null;
  private stdoutCbs: ((l: string) => void)[] = [];
  private stderrCbs: ((l: string) => void)[] = [];
  private exitCbs: ((i: ChildExitInfo) => void)[] = [];
  constructor(pid: number) {
    this.pid = pid;
  }
  emitLine(line: string): void {
    this.stdout.push(line);
    for (const cb of this.stdoutCbs) cb(line);
  }
  emitStderr(line: string): void {
    this.stderr.push(line);
    for (const cb of this.stderrCbs) cb(line);
  }
  exit(info: ChildExitInfo): void {
    this.exitInfo = info;
    for (const cb of this.exitCbs) cb(info);
  }
  onStdoutLine(cb: (l: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  onStderrLine(cb: (l: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onExit(cb: (i: ChildExitInfo) => void): void {
    this.exitCbs.push(cb);
  }
}
class FakeSpawner implements ChildSpawner {
  readonly spawned: { spec: CampaignChildSpec; child: FakeChild }[] = [];
  failNext = 0; // spawn-failure injection count
  private nextPid = 1000;
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('injected spawn failure');
    }
    const child = new FakeChild(this.nextPid++);
    this.spawned.push({ spec, child });
    return child;
  }
}

// --- Campaign document fixture --------------------------------------------
function campaignDoc(overrides: Record<string, unknown> = {}): Campaign {
  return {
    schema_version: 1,
    campaign_id: 'c'.repeat(64),
    suite: {
      schema_version: 1,
      name: 'testsuite',
      kind: 'gating',
      budget_usd: 50,
      profile: 'release_gate_v1',
      reserve: 1,
      max_exposure_skew: 60,
      profile_params: { alpha: 0.05, determinate_n_floor: 1, completion_divergence_max: 0.5, mde_by_scenario: {} },
      comparisons: [{ baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn'], n: 1 }],
    },
    refs: { superpowers_by_arm: { arm_a: null, arm_b: null }, evals: 'e'.repeat(40), gauntlet: '9'.repeat(40) },
    grader: { credential: 'grader_cred', model: 'grader-model' },
    cells: [{
      scenario: 'scn', comparison_id: 'c1', arms: ['arm_a', 'arm_b'], n: 1,
      class: 'confirmatory', coupling: 'arm-independent',
      estimates_by_arm: {
        arm_a: { duration_s: 100, cost_usd: 1, confidence: 'high' },
        arm_b: { duration_s: 200, cost_usd: 2, confidence: 'high' },
      },
    }],
    excluded_cells: [],
    samples: [
      { sample_id: 'c1:scn:arm_a:r1', cell: 'c1:scn', arm: 'arm_a', replicate: 1 },
      { sample_id: 'c1:scn:arm_b:r1', cell: 'c1:scn', arm: 'arm_b', replicate: 1 },
      { sample_id: 'c1:scn:arm_a:x1', cell: 'c1:scn', arm: 'arm_a', replicate: 1 },
      { sample_id: 'c1:scn:arm_b:x1', cell: 'c1:scn', arm: 'arm_b', replicate: 1 },
    ],
    comparisons: [{ comparison_id: 'c1', baseline: 'arm_a', treatment: 'arm_b' }],
    blocks: [
      { block_id: 'c1:scn:b1', comparison_id: 'c1', sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'] },
      { block_id: 'c1:scn:x1', comparison_id: 'c1', sample_ids: ['c1:scn:arm_a:x1', 'c1:scn:arm_b:x1'], slot: 'reserve' },
    ],
    budget: { usd_all_in: 50, surcharge_applied: 0, priced_coverage: 1, surcharge_formula_version: 1 },
    registered_at: '2026-08-26T00:00:00Z',
    registered_by: 'test',
    digest: 'c'.repeat(64),
    contention: {
      host_fingerprint: { cpu_model: 'test', cpu_cores: 4, mem_bytes: 16 * 2 ** 30, disk_total_bytes: 100 * 2 ** 30 },
      global_run_cap: 2,
      thresholds: [{ metric: 'load1_per_core', source: 'host', op: 'gt', value: 2 }],
      cadence_ms: 10_000,
      sustain_k: 3,
      coverage_n: 4,
      mem_tolerance_pct: 10,
      disk_tolerance_pct: 10,
    },
    execution_surface: [
      { name: 'arm_a', agent: 'claude', credential: 'cred_a', auth: 'api-key', api: 'anthropic', model: 'm', key_env_names: ['KEY_A'] },
      { name: 'arm_b', agent: 'claude', credential: 'cred_b', auth: 'api-key', api: 'anthropic', model: 'm', key_env_names: ['KEY_B'] },
    ],
    ...overrides,
    // Fixture-literal cast, justified: this is a full valid document already
    // exercised against CampaignSchema in the task 5 registration tests; the
    // cast only bridges the untyped `overrides` spread.
  } as unknown as Campaign;
}

interface HarnessArgs {
  campaignDir: string;
  spawner: FakeSpawner;
  clock: FakeClock;
  credentials: Record<string, import('../src/contracts/credential.ts').Credential>;
}
function harness(overrides: Record<string, unknown> = {}): HarnessArgs & { args: DispatchRunArgs } {
  const campaignDir = mkdtempSync(join(tmpdir(), 'disp-'));
  initJournalDb(campaignDir);
  writeFileSync(join(campaignDir, '.ballast'), 'x'); // ballast presence satisfied
  writeFileSync(join(campaignDir, 'contention-telemetry.jsonl'), '');
  const doc = campaignDoc(overrides);
  writeFileSync(join(campaignDir, 'campaign.json'), JSON.stringify(doc, null, 2));
  const writer = electWriter({ campaignDir, clock: new FakeClock(0), identity: IDENTITY });
  writer.appendEvent({ type: 'campaign_opened', payload: { campaign_id: doc.campaign_id, digest: doc.digest } });
  writer.release();
  const spawner = new FakeSpawner();
  const clock = new FakeClock(1);
  const cred = (env: string) =>
    ({ model: 'm', harnesses: ['claude'], api: 'anthropic', auth: 'api-key', api_key_env: env, compat: {}, max_concurrency: 2 }) as import('../src/contracts/credential.ts').Credential;
  const credentials = { cred_a: cred('KEY_A'), cred_b: cred('KEY_B'), grader_cred: cred('KEY_G') };
  const args: DispatchRunArgs = {
    campaignDir,
    spawner,
    clock,
    identity: IDENTITY,
    credentials,
    resultsRoot: join(campaignDir, 'results'),
    snapshotVerify: () => {},          // task 4 seam: inject clean verify by default
    sampler: 'disabled',               // contention sampler off unless a test enables it
    observeExposure: () => 1_000,      // uniform exposure -> zero skew unless a test overrides
    stream: { write: () => {} },
    installSignals: () => () => {},    // signal seam: no-op by default
  };
  return { campaignDir, spawner, clock, credentials, args };
}

// Read-only journal views (openJournalRead): a live dispatcher HOLDS the
// journal lease for its whole run, so a mid-run electWriter here would
// refuse against the live holder. Readers never write, never take the lease.
function journalTypes(campaignDir: string): string[] {
  const r = openJournalRead(campaignDir);
  try {
    return r.readEvents().map((e) => e.type);
  } finally {
    r.close();
  }
}
function journalEvents(campaignDir: string) {
  const r = openJournalRead(campaignDir);
  try {
    return r.readEvents();
  } finally {
    r.close();
  }
}
```

Tests (the pure-cores test from task 8a stays at the top of the file, unchanged):

```ts
test('admission is atomic per block and capped by the per-sample global cap; release at SERVICE END', async () => {
  const h = harness(); // global_run_cap = 2 -> exactly one two-sample block in flight
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(2); // both samples of b1 spawned
  // Allocate run ids, then hold the children alive: nothing else admits.
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
  }
  await tick(h.clock, 1);
  expect(h.spawner.spawned.length).toBe(2); // cap 2 holds the reserve out
  // Service end: children exit -> slots release -> the reserve block can admit
  // ONLY after replacement obligation (reserve is frozen; no primary remains)
  for (const { child } of h.spawner.spawned) child.exit({ code: 0, signal: null });
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  expect(events.filter((e) => e.type === 'block_admitted').length).toBe(1); // primary only; reserve untouched without obligation
  expect(events.some((e) => e.type === 'budget_event' && e.payload.kind === 'estimate_inflight')).toBe(true);
});

test('longest-expected-first ordering admits the longer block first when the cap forces a choice', async () => {
  // Two primary blocks; global cap 2 admits exactly one two-sample block.
  const h = harness({
    blocks: [
      { block_id: 'c1:scn:b1', comparison_id: 'c1', sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'] },
      { block_id: 'c1:scn:b2', comparison_id: 'c1', sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'] },
    ],
    samples: [
      { sample_id: 'c1:scn:arm_a:r1', cell: 'c1:scn', arm: 'arm_a', replicate: 1 },
      { sample_id: 'c1:scn:arm_b:r1', cell: 'c1:scn', arm: 'arm_b', replicate: 1 },
      { sample_id: 'c1:scn:arm_a:r2', cell: 'c1:scn', arm: 'arm_a', replicate: 2 },
      { sample_id: 'c1:scn:arm_b:r2', cell: 'c1:scn', arm: 'arm_b', replicate: 2 },
    ],
  });
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  // b1's arm_b estimate (200s) > nothing else distinguishes — blocks tie by
  // estimates; the fixture arms give b1 == b2 priority, so the tie-break is
  // replicate ordinal: b1 first.
  const admitted = journalEvents(h.campaignDir).filter((e) => e.type === 'block_admitted');
  expect(admitted[0]?.payload.block_id).toBe('c1:scn:b1');
  for (const { child } of h.spawner.spawned) { child.emitLine(`run_allocated: run-${child.pid}`); child.exit({ code: 0, signal: null }); }
  await tick(h.clock, 1); // b1's slots release -> b2 admits + spawns
  for (const { child } of h.spawner.spawned.slice(2)) { child.emitLine(`run_allocated: run-${child.pid}`); child.exit({ code: 0, signal: null }); }
  await run;
});

test('429 cooldown: classified stderr pools the block, waits the clamped cooldown, then resumes', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [first] = h.spawner.spawned;
  first!.child.emitStderr('{"type":"rate_limit_error"} retry-after: 30');
  first!.child.emitLine(`run_allocated: run-${first!.child.pid}`);
  first!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  // pool_blocked journaled for the subject pool, until = now + 30s.
  const blocked = journalEvents(h.campaignDir).find((e) => e.type === 'pool_blocked');
  expect(blocked).toBeDefined();
  expect(blocked!.payload.pool_key).toBe('cred_a|anthropic|m'); // poolKey(cred, name): base_url ?? name | api | model
  for (const { child } of h.spawner.spawned.slice(1)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  // The crash-classified first child minted the reserve; its block waits out
  // the pool cooldown, then admits and spawns.
  await tick(h.clock, 31); // past the cooldown
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test('instrument replacement: typed failure mints the reserve (block_replaced FIRST, then dispositions), conservation intact', async () => {
  const h = harness();
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  const [childA, childB] = h.spawner.spawned;
  childA!.child.emitLine(`run_allocated: run-${childA!.child.pid}`);
  childB!.child.emitLine(`run_allocated: run-${childB!.child.pid}`);
  // arm_a fails with a typed instrument cause.
  childA!.child.exit({ code: 1, signal: null });
  await tick(h.clock, 1);
  childB!.child.exit({ code: 0, signal: null });
  await tick(h.clock, 1);
  const events = journalEvents(h.campaignDir);
  const replaced = events.find((e) => e.type === 'block_replaced');
  expect(replaced).toBeDefined();
  expect(replaced!.payload).toMatchObject({
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:x1',
    reason: expect.any(String),
    kind: 'replacement',
    reserve_activation: true,
  });
  // Mint order: block_replaced precedes the disposition rows (E7.1 bundle).
  const replacedSeq = replaced!.seq;
  const dispositions = events.filter((e) => e.type === 'sample_disposition');
  expect(dispositions.length).toBeGreaterThanOrEqual(1);
  for (const d of dispositions) expect(d.seq).toBeGreaterThan(replacedSeq);
  // instrument_failure journaled for the failed attempt.
  expect(events.some((e) => e.type === 'instrument_failure')).toBe(true);
  // The minted reserve admits once slots free; finish its children.
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
});

test('budget stop reaches admitted-but-unspawned samples (E3) and never resurrects on a raise', async () => {
  // Two primary blocks; budget 4 admits b1 (exposure 3) and stops at b2
  // (3 + 3 > 4) — the stop reaches b2's admitted-but-unspawned samples.
  const h = harness({
    budget: { usd_all_in: 4, surcharge_applied: 0, priced_coverage: 1, surcharge_formula_version: 1 },
    blocks: [
      { block_id: 'c1:scn:b1', comparison_id: 'c1', sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'] },
      { block_id: 'c1:scn:b2', comparison_id: 'c1', sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'] },
    ],
    samples: [
      { sample_id: 'c1:scn:arm_a:r1', cell: 'c1:scn', arm: 'arm_a', replicate: 1 },
      { sample_id: 'c1:scn:arm_b:r1', cell: 'c1:scn', arm: 'arm_b', replicate: 1 },
      { sample_id: 'c1:scn:arm_a:r2', cell: 'c1:scn', arm: 'arm_a', replicate: 2 },
      { sample_id: 'c1:scn:arm_b:r2', cell: 'c1:scn', arm: 'arm_b', replicate: 2 },
    ],
  });
  const run = runCampaignDispatch(h.args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  await run;
  const events = journalEvents(h.campaignDir);
  expect(events.some((e) => e.type === 'budget_stopped')).toBe(true);
  // Only the first block's two samples ever allocated: the stop reaches
  // admitted-but-not-yet-spawned samples (E3), so no further run_allocated
  // lands beyond the first block's two.
  expect(events.filter((e) => e.type === 'run_allocated').length).toBe(2);
});

test('spawn failure: slots release, subject_spawn_failed journals + mints, pool halt after N=3 consecutive failures', async () => {
  // Both arms on ONE credential so consecutive failures attribute to one
  // pool: b1's two failed spawns (which mint reserve x1) + x1's first failed
  // spawn = 3 consecutive on the cred_a pool -> halt (REV fable I-14).
  const h = harness({
    execution_surface: [
      { name: 'arm_a', agent: 'claude', credential: 'cred_a', auth: 'api-key', api: 'anthropic', model: 'm', key_env_names: ['KEY_A'] },
      { name: 'arm_b', agent: 'claude', credential: 'cred_a', auth: 'api-key', api: 'anthropic', model: 'm', key_env_names: ['KEY_A'] },
    ],
  });
  h.spawner.failNext = SPAWN_FAILURE_HALT_N;
  const written: string[] = [];
  const args: DispatchRunArgs = { ...h.args, stream: { write: (s: string) => written.push(s) } };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1); // wave 1: b1's two spawns fail -> released + minted
  await tick(h.clock, 1); // wave 2: x1 admits; 3rd failure halts the pool; 4th spawn succeeds
  expect(written.join('')).toMatch(/halt: spawn-failure pool halt/);
  const midEvents = journalEvents(h.campaignDir);
  // A spawn-failed sample terminals as instrument (classifier row 6) and
  // releases its slots — never a silently wedged cap.
  expect(
    midEvents.filter((e) => e.type === 'instrument_failure' && e.payload.cause === 'subject_spawn_failed').length,
  ).toBe(3);
  expect(midEvents.some((e) => e.type === 'block_replaced' && e.payload.reason === 'subject_spawn_failed')).toBe(true);
  // Clear the halt (operator resume seam on THIS args object — the
  // dispatcher fills it) and finish the surviving child.
  args.resumeAdmission?.('spawn failures cleared');
  for (const { child } of h.spawner.spawned) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('closed-window contention: breach halts admission, resolution batch mints reason=contention in frozen order, counts print before admission resumed', async () => {
  const h = harness();
  const written: string[] = [];
  // Sidecar fixture through the REAL parseSidecar/evaluateContention path: a
  // sustain_k=3 crossing run (load1 5 > threshold 2) closed by 3 in-bounds
  // samples — the evaluator derives breach window [1020, 1060] from these
  // exact lines, overlapping the block admitted at ~1000ms -> 'invalid'.
  const telemetry = (ts_ms: number, load1: number) =>
    JSON.stringify({ ts_ms, load1, mem_available_bytes: 8 * 2 ** 30, swap_used_bytes: 0, process_count: 100, disk_free_bytes: 90 * 2 ** 30, breach: [] });
  writeFileSync(
    join(h.campaignDir, 'contention-telemetry.jsonl'),
    `${[1000, 1010, 1020].map((t) => telemetry(t, 5)).concat([1040, 1050, 1060].map((t) => telemetry(t, 0))).join('\n')}\n`,
  );
  // Scripted sampler seam — TYPED, no casts: capture the dispatcher's hooks
  // at start(), then drive onBreachExit by hand. This is the same entry
  // point the real ContentionSampler notifies after fsyncing the exit
  // sample; there is no other closed-window path into the dispatcher.
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    sampler: scripted,
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) child.emitLine(`run_allocated: run-${child.pid}`);
  expect(hooks).not.toBeNull();
  // The closed window the sampler would hand over (derived from the same
  // sidecar lines above; exit sample already durable).
  hooks!.onBreachExit({ startTsMs: 1020, endTsMs: 1060, metrics: ['load1_per_core'] });
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) child.exit({ code: 0, signal: null });
  await tick(h.clock, 1); // released slots -> the minted reserve admits + spawns
  expect(h.spawner.spawned.length).toBe(4);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  const contentionMints = events.filter((e) => e.type === 'block_replaced' && e.payload.reason === 'contention');
  expect(contentionMints.length).toBe(1);
  expect(contentionMints[0]!.payload.kind).toBe('replacement'); // never rerun kind
  const text = written.join('');
  expect(text).toMatch(/contention resolution: affected=1 refilled=1 exhausted=0 suppressed=0/);
  expect(text.indexOf('contention resolution')).toBeLessThan(text.indexOf('admission resumed'));
});

test('signal handling: SIGINT stops admission, kills groups, journals aborted, exits resumable', async () => {
  const h = harness();
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) child.emitLine(`run_allocated: run-${child.pid}`);
  expect(signalHandler).not.toBeNull();
  signalHandler!('SIGINT');
  const outcome = await run;
  expect(outcome.status).toBe('signalled');
  const events = journalEvents(h.campaignDir);
  expect(events.some((e) => e.type === 'aborted')).toBe(true);
  expect(events.some((e) => e.type === 'campaign_cancelled')).toBe(false); // resumable, not cancelled
});

test('exposure journals once at terminal; gating skew breach excludes the block and refills via skew_refill with NO dispositions', async () => {
  const h = harness();
  // Per-run exposure through the seam (production reads trajectory.json):
  // b1's two samples land 499s apart — over the registered 60s bound.
  const args: DispatchRunArgs = {
    ...h.args,
    observeExposure: (runDir) => (runDir.endsWith('run-1000') ? 1_000 : 500_000),
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) child.emitLine(`run_allocated: run-${child.pid}`);
  for (const { child } of h.spawner.spawned) child.exit({ code: 0, signal: null });
  await tick(h.clock, 1); // skew decided at block terminal -> the refill admits
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
  const events = journalEvents(h.campaignDir);
  // R-SNS-5: exposure_started { sample_id, ts } — once per terminaled
  // sample (monotonic single emission), payload field `ts`.
  const expo = events.filter((e) => e.type === 'exposure_started');
  expect(expo.length).toBe(4); // b1 pair + refill pair
  expect(expo[0]!.payload).toMatchObject({ sample_id: 'c1:scn:arm_a:r1', ts: 1_000 });
  // R-DSP-9: gating exclusion fans out over the block; the refill is
  // reason 'skew_refill', kind 'replacement'.
  expect(events.some((e) => e.type === 'skew_excluded' && e.payload.block_id === 'c1:scn:b1')).toBe(true);
  const refill = events.find((e) => e.type === 'block_replaced' && e.payload.reason === 'skew_refill');
  expect(refill!.payload.kind).toBe('replacement');
  // E7.2: NO excluded_block_replaced dispositions for a skew refill — the
  // excluded samples keep their skew_excluded terminal.
  expect(events.filter((e) => e.type === 'sample_disposition').length).toBe(0);
});

test('operator cancel: the signalled dispatcher journals aborted then campaign_cancelled LAST and exits cancelled (D-12 live path)', async () => {
  const h = harness();
  let signalHandler: ((signal?: NodeJS.Signals) => void) | null = null;
  const args: DispatchRunArgs = {
    ...h.args,
    installSignals: (handler) => {
      signalHandler = handler;
      return () => {};
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) child.emitLine(`run_allocated: run-${child.pid}`);
  // `quorum campaign cancel` lands the marker FIRST (O_EXCL, D-12), then
  // signals; the marker's second line carries the operator's reason.
  writeFileSync(join(h.campaignDir, 'cancel-request'), '1000\noperator said stop\n', { flag: 'wx' });
  signalHandler!('SIGTERM');
  const outcome = await run;
  expect(outcome.status).toBe('cancelled');
  const types = journalTypes(h.campaignDir);
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // LAST — the cancel verb polls for exactly this
  expect(types.indexOf('aborted')).toBeLessThan(types.indexOf('campaign_cancelled'));
  const cancelled = journalEvents(h.campaignDir).find((e) => e.type === 'campaign_cancelled');
  expect(cancelled!.payload.reason).toBe('operator said stop'); // reason rides the marker body
});

test('snapshot drift at a wave: D-11 in order — halt, kill+abort affected, authorized repair, clean re-verify, rerun re-entry, admission resumes', async () => {
  const h = harness();
  const written: string[] = [];
  // Verify seam: clean on the first wave, DRIFT on the second, clean once
  // the authorized repair has run.
  let verifies = 0;
  let repaired = false;
  const repairedHandle: import('../src/campaign/instrument-snapshot.ts').SnapshotHandle = {
    evalsRoot: join(h.campaignDir, 'evals'),
    gauntletRoot: join(h.campaignDir, 'gauntlet'),
    gauntletBin: join(h.campaignDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [],
    evalsSha: 'e'.repeat(40),
    gauntletSha: '9'.repeat(40),
  };
  const args: DispatchRunArgs = {
    ...h.args,
    stream: { write: (s: string) => written.push(s) },
    snapshotVerify: () => {
      verifies += 1;
      if (verifies >= 2 && !repaired) throw new SnapshotDriftError('worktree HEAD moved');
    },
    repairSnapshot: () => {
      repaired = true;
      return repairedHandle;
    },
  };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  for (const { child } of h.spawner.spawned) child.emitLine(`run_allocated: run-${child.pid}`);
  await tick(h.clock, 1); // wave 2: drift -> the full D-11 sequence runs
  expect(repaired).toBe(true);
  const events = journalEvents(h.campaignDir);
  // (3) affected in-flight block killed + aborted.
  expect(events.some((e) => e.type === 'aborted' && e.payload.block_id === 'c1:scn:b1')).toBe(true);
  // (6) rerun re-entry: reserve- and count-neutral fresh instance.
  const rerun = events.find((e) => e.type === 'block_replaced' && e.payload.kind === 'rerun');
  expect(rerun!.payload).toMatchObject({
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:b1:i1',
    reason: 'snapshot_drift',
    reserve_activation: false,
  });
  // The successor re-admits from aborted via rerun_of (E7.1 edge).
  const readmit = events.find(
    (e) => e.type === 'block_admitted' && e.payload.block_id === 'c1:scn:b1:i1',
  );
  expect(readmit!.payload.rerun_of).toBe('c1:scn:b1');
  // (5)+(banner) admission resumed only after the clean re-verify.
  expect(written.join('')).toMatch(/resume: admission resumed \(snapshot repaired/);
  for (const { child } of h.spawner.spawned.slice(2)) {
    child.emitLine(`run_allocated: run-${child.pid}`);
    child.exit({ code: 0, signal: null });
  }
  const outcome = await run;
  expect(outcome.status).toBe('completed');
});

test('sidecar ENOSPC enters the D-13 storage pause: ballast released, storage_paused journaled, outcome storage_paused', async () => {
  const h = harness();
  // A live sampler seam needs a fresh sidecar sample for the liveness guard.
  writeFileSync(
    join(h.campaignDir, 'contention-telemetry.jsonl'),
    `${JSON.stringify({ ts_ms: 1000, load1: 0, mem_available_bytes: 8 * 2 ** 30, swap_used_bytes: 0, process_count: 100, disk_free_bytes: 90 * 2 ** 30, breach: [] })}\n`,
  );
  let hooks: DispatchSamplerHooks | null = null;
  const scripted: DispatchSamplerSeam = {
    start(captured) {
      hooks = captured;
      return () => {};
    },
  };
  const args: DispatchRunArgs = { ...h.args, sampler: scripted };
  const run = runCampaignDispatch(args);
  await tick(h.clock, 1);
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(true);
  // D-13 step 1, second detector: the sampler hits the full volume first.
  hooks!.onSampleError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }));
  const outcome = await run;
  expect(outcome.status).toBe('storage_paused');
  expect(existsSync(join(h.campaignDir, '.ballast'))).toBe(false); // step 3: ballast released
  const types = journalTypes(h.campaignDir);
  expect(types).toContain('storage_paused'); // step 4 landed (space exists here)
  expect(existsSync(join(h.campaignDir, '.storage-paused'))).toBe(false); // marker only when step 4 cannot land
});
```

Define this helper at the top of the file, beside `harness`:

```ts
async function tick(clock: FakeClock, seconds: number): Promise<void> {
  clock.advance(seconds);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
```

(`h.args.resumeAdmission` is the dispatcher's operator-resume seam, exposed on `DispatchRunArgs` as an optional callback the dispatcher fills in.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test test/campaign-dispatcher.test.ts`
Expected: FAIL — the 12 orchestrator tests fail (missing exports); the task-8a pure-cores test still passes.

- [ ] **Step 7: Widen the dispatcher's import block** — in `src/campaign/dispatcher.ts`, REPLACE the task-8a minimal import block (`Block` + pool names) with the full set the orchestrator consumes:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../scheduler/clock.ts';
import { RealClock } from '../scheduler/clock.ts';
import { clockNowMs, type HostStatsProbe } from './host-stats.ts';
import { GRADER_POOL, GLOBAL_POOL } from './simulate.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import type { Block, Campaign } from '../contracts/campaign/campaign.ts';
import type { Credential } from '../contracts/credential.ts';
import {
  electWriter,
  isStorageFullError,
  releaseBallast,
  type EventInput,
  type JournalWriter,
} from './journal.ts';
import { realProcessIdentityProbe, type ProcessIdentityProbe } from './locks.ts';
import { rerunInstanceId } from './registration.ts';
import {
  assertProcessGroupExists,
  buildCampaignChildArgv,
  childCoveredEnv,
  DetachedChildSpawner,
  keyGrantsPayload,
  parseRunAllocatedLine,
  type CampaignChildSpec,
  type ChildSpawner,
  type SpawnedCampaignChild,
} from './spawn.ts';
import { resolveKeyForSpawn, warnKeyWait } from './key-select.ts';
import { classifyFailure } from './classifier.ts';
import { classifyRateLimit, ExposureTracker } from './sensors.ts';
import {
  ContentionSampler,
  evaluateContention,
  parseSidecar,
  samplerStaleMs,
  type BlockInterval,
  type BreachWindow,
  type ResolvedThreshold,
} from './contention.ts';
import { driftAffectedBlockIds, verifyCampaignSnapshot, type InFlightBlock } from './snapshot.ts';
import { SnapshotDriftError, type SnapshotHandle } from './instrument-snapshot.ts';
import { defaultCommandRunner, type CommandRunner } from '../agents/command-runner.ts';
import { normalizeBlockReplaced } from '../contracts/campaign/journal-events.ts';
import type { RunErrorStage } from '../contracts/verdict.ts';
```

(Also update the module-header comment's last sentence — the "this sub-task lands the pure cores" note — to describe the complete module. `DispatcherError`, `SPAWN_FAILURE_HALT_N`, and the four pure cores from task 8a stay unchanged below the imports.)

- [ ] **Step 8: Implement the orchestrator** — append to `src/campaign/dispatcher.ts`. This is the long core; it keeps one writer for the process lifetime (GC-finalizer debt: the `Database` connection stays reachable), one critical section per admission/mint via `writer.appendEvents`, and releases slots at SERVICE END (child death — Decision D-1 occupancy clarification):

```ts
/** The dispatcher's sampler hooks (Decision D-3: sensors lead — the sampler
 *  detects; the dispatcher halts, resolves, journals). */
export interface DispatchSamplerHooks {
  onBreachEntry(metrics: readonly string[]): void;
  onBreachExit(window: BreachWindow): void;
  onSampleError(err: unknown): void;
}

/** The sampler seam: start() is called once at dispatcher startup with the
 *  dispatcher's hooks and returns the stop function awaited at exit. Tests
 *  inject a scripted seam (capture the hooks, fire them by hand); production
 *  passes realSamplerSeam below. */
export interface DispatchSamplerSeam {
  start(hooks: DispatchSamplerHooks): () => void | Promise<void>;
}

/** Production sampler wiring: the real timer-driven ContentionSampler over
 *  the host-stats probe at the registered cadence. resumeCampaign (task 9,
 *  the sole production caller of runCampaignDispatch) passes this. */
export function realSamplerSeam(args: {
  campaignDir: string;
  contention: Campaign['contention'];
  probe: HostStatsProbe;
  clock: Clock;
}): DispatchSamplerSeam {
  return {
    start(hooks: DispatchSamplerHooks): () => Promise<void> {
      const sampler = new ContentionSampler({
        campaignDir: args.campaignDir,
        probe: args.probe,
        clock: args.clock,
        thresholds: args.contention.thresholds.map((t) => ({
          metric: t.metric,
          op: t.op,
          value: t.value,
        })),
        sustainK: args.contention.sustain_k,
        cadenceMs: args.contention.cadence_ms,
        onBreachEntry: (metrics) => hooks.onBreachEntry(metrics),
        onBreachExit: (window) => hooks.onBreachExit(window),
        onSampleError: (err) => hooks.onSampleError(err),
      });
      const loop = sampler.start();
      return async () => {
        await sampler.stop();
        await loop;
      };
    },
  };
}

/** D-13 pinned pause sequence, steps 2-6 (detection is the dispatcher's two
 *  sites below: a storage-full journal append in appendCritical, a
 *  storage-full sidecar append via the sampler's onSampleError): halt
 *  admission -> release ballast -> journal storage_paused in the freed
 *  space -> kill children -> durable marker if the event did not land.
 *  Defined HERE (not recovery.ts) so those detection sites call it without a
 *  dispatcher<->recovery module cycle; task 9's resume reconciliation and D4
 *  import it from the dispatcher. */
export function performStoragePause(args: {
  campaignDir: string;
  writer: JournalWriter;
  killAll: () => void;
  stream: { write(s: string): void };
}): void {
  args.stream.write('storage pause: ENOSPC — fail-stop (a journal that cannot write cannot record spend)\n');
  // Step 3: release the ballast (unlink + fsync dir) to free the reserved
  // blocks for the pause evidence.
  try {
    releaseBallast(args.campaignDir);
  } catch (err) {
    args.stream.write(`storage pause: ballast release failed: ${(err as Error).message}\n`);
  }
  // Step 4: journal storage_paused in the freed space (best-effort; the
  // marker below is the durable record if it cannot land).
  let landed = false;
  try {
    args.writer.appendEvent({ type: 'storage_paused', payload: {} });
    landed = true;
  } catch {
    landed = false;
  }
  // Step 5: kill the campaign children (group TERM->KILL, verify dead).
  args.killAll();
  // Step 6: durable marker when the event did not land.
  if (!landed) {
    writeFileSync(join(args.campaignDir, '.storage-paused'), '', { flag: 'wx' });
  }
}

/** Successor instance id: B -> B:i1, B:i1 -> B:i2 (never B:i1:i2) —
 *  registration.ts's rerunInstanceId over the lineage root. Shared with
 *  recovery's rerun-mint construction (task 9). */
export function nextRerunInstanceId(predecessorId: string): string {
  const m = /^(.*):i(\d+)$/.exec(predecessorId);
  const root = m !== null ? (m[1] ?? predecessorId) : predecessorId;
  const seq = m !== null ? Number(m[2]) + 1 : 1;
  return rerunInstanceId(root, seq);
}

export interface TerminalVerdict {
  readonly outcome: 'pass' | 'fail' | 'indeterminate';
  readonly stage?: RunErrorStage;
  readonly reason: string;
}

/** Production verdict reader (child exit -> verdict read -> classification,
 *  the R-JRN emitters contract): `<runDir>/verdict.json`, fields
 *  final/final_reason/error.stage per src/contracts/verdict.ts. null =
 *  missing/unreadable — the child died before composing; the exit-code
 *  heuristic classifies (crash/signal rows). */
export function readVerdictSummary(runDir: string): TerminalVerdict | null {
  try {
    const v = JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')) as {
      final?: string;
      final_reason?: string;
      error?: { stage?: string } | null;
    };
    if (v.final !== 'pass' && v.final !== 'fail' && v.final !== 'indeterminate') return null;
    return {
      outcome: v.final,
      ...(v.error?.stage !== undefined ? { stage: v.error.stage as RunErrorStage } : {}),
      reason: v.final_reason ?? '',
    };
  } catch {
    return null;
  }
}

/** Production exposure source (Decision D-9 — the capture-derived value is
 *  permitted by the block-terminal decision point): the run dir's ATIF
 *  trajectory's first step timestamp. Tail-safe by construction: a full
 *  read at decision time, never an offset. */
export function trajectoryExposureMs(runDir: string): number | null {
  try {
    const t = JSON.parse(readFileSync(join(runDir, 'trajectory.json'), 'utf8')) as {
      steps?: { timestamp?: string }[];
    };
    const first = t.steps?.find((s) => s.timestamp !== undefined)?.timestamp;
    if (first === undefined) return null;
    const ms = Date.parse(first);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export interface DispatchRunArgs {
  readonly campaignDir: string;
  readonly spawner?: ChildSpawner;
  readonly clock?: Clock;
  readonly identity?: ProcessIdentityProbe;
  readonly credentials: Readonly<Record<string, Credential>>;
  readonly resultsRoot?: string;
  readonly snapshot?: SnapshotHandle;
  /** CommandRunner for verify/repair; defaults to defaultCommandRunner. */
  readonly runner?: CommandRunner;
  /** Terminal verdict reader; production default readVerdictSummary. Tests
   *  without run dirs fall through to the exit-code heuristic via null. */
  readonly readVerdict?: (runDir: string) => TerminalVerdict | null;
  /** D-9 exposure source at block terminal; production default
   *  trajectoryExposureMs. null = exposure unestablished (fail-closed:
   *  gating blocks skew-breach on absence, R-SNS-4). */
  readonly observeExposure?: (runDir: string) => number | null;
  /** R-DSP-11 verify TEST seam only. Production omits it: the dispatcher
   *  builds the real verify from `snapshot` + `runner`, and REFUSES to start
   *  with neither — the mandated admission gate never rides an injectable
   *  no-op default. */
  readonly snapshotVerify?: () => void;
  /** D-11 authorized repair. Production (resumeCampaign, task 9) passes
   *  repairDriftedTrees over the source checkouts. Absent, a drift performs
   *  steps 1-3 (halt, kill, aborted) and exits 'halted' naming
   *  `quorum campaign run` as the repair verb — fail-closed, never silent. */
  readonly repairSnapshot?: () => SnapshotHandle;
  /** Contention sampler (Decision D-3) — REQUIRED, no default: production
   *  passes realSamplerSeam(...); tests pass 'disabled' or a scripted seam.
   *  Forgetting it is a type error, never a silently sampler-less campaign. */
  readonly sampler: 'disabled' | DispatchSamplerSeam;
  readonly stream?: { write(s: string): void };
  readonly installSignals?: (handler: (signal?: NodeJS.Signals) => void) => () => void;
  /** Operator resume seam, filled by the dispatcher for halt clearance. */
  resumeAdmission?: (reason: string) => void;
}

export interface DispatchOutcome {
  readonly status: 'completed' | 'cancelled' | 'signalled' | 'halted' | 'storage_paused';
  readonly reason?: string;
}

interface LiveSampleState {
  sampleId: string;
  blockId: string;
  arm: string;
  attemptId: string;
  subjectPool: string;
  child?: SpawnedCampaignChild;
  runId?: string;
  serviceEnded: boolean;
}
interface LiveBlockState {
  block: Block;
  slot: 'primary' | 'reserve';
  samples: LiveSampleState[];
  admittedTsMs: number;
  /** Set when the last sample's service ends (D-11 window overlap input). */
  serviceEndTsMs?: number;
}

export async function runCampaignDispatch(args: DispatchRunArgs): Promise<DispatchOutcome> {
  const clock = args.clock ?? new RealClock();
  const stream = args.stream ?? { write: (s: string) => process.stdout.write(s) };
  const spawner = args.spawner ?? new DetachedChildSpawner();
  const campaign: Campaign = JSON.parse(
    readFileSync(join(args.campaignDir, 'campaign.json'), 'utf8'),
  );
  // Production default is the REAL probe — a stub here would let a lease
  // reclamation misjudge a live holder (S4: mandated behavior never rides a
  // fake default; tests inject their own probe).
  const identity: ProcessIdentityProbe = args.identity ?? realProcessIdentityProbe;
  const readVerdict = args.readVerdict ?? readVerdictSummary;
  const observeExposure = args.observeExposure ?? trajectoryExposureMs;
  /** Run-dir path for a protocol-line run id (the runner's allocation names
   *  the run dir after the run id under outRoot — Decision D-8 correlation;
   *  the identity file task 6c persists lives in the same dir). */
  const runDirOf = (runId: string): string => join(args.resultsRoot ?? 'results', runId);
  // The writer carries the frozen membership so its incremental
  // projections resolve attempt->block identically to a rebuild.
  const writer = electWriter({ campaignDir: args.campaignDir, clock, identity, campaign });

  // --- State derived from the journal + frozen document -------------------
  const events = writer.readEvents();
  const armedBlocks = campaign.blocks.filter((b) => (b.slot ?? 'primary') === 'primary');
  const reserveBlocks = campaign.blocks.filter((b) => b.slot === 'reserve');
  const armBySample = new Map<string, string>();
  for (const sample of campaign.samples) armBySample.set(sample.sample_id, sample.arm);
  /** Roster construction refuses unknown samples loudly — a silent '' arm
   *  would only surface later as a zod reject inside a mint critical
   *  section (BlockRosterEntrySchema pins arm min(1)). */
  const armOf = (sampleId: string): string => {
    const arm = armBySample.get(sampleId);
    if (arm === undefined) {
      throw new DispatcherError(`sample ${sampleId} is not in the frozen sample universe — roster construction refused`);
    }
    return arm;
  };
  /** Cell key from a block id: strip a lineage `:i<seq>` suffix first, then
   *  the trailing `:b<N>` / `:x<K>` component. `c1:scn:b1` -> `c1:scn`;
   *  `c1:scn:b3:i2` -> `c1:scn`. */
  const cellKeyOfBlock = (blockId: string): string => {
    let id = blockId;
    const inst = /^(.*):i\d+$/.exec(id);
    if (inst !== null) id = inst[1] ?? id;
    const root = /^(.*):[bx]\d+$/.exec(id);
    return root !== null ? (root[1] ?? id) : id;
  };
  const scenarioOfSample = (sampleId: string): string => {
    const sample = campaign.samples.find((s) => s.sample_id === sampleId);
    if (sample === undefined) return '';
    const cell = campaign.cells.find((c) => `${c.comparison_id}:${c.scenario}` === sample.cell);
    return cell?.scenario ?? '';
  };
  const sampleEstimate = (sampleId: string): number => {
    const sample = campaign.samples.find((s) => s.sample_id === sampleId);
    if (sample === undefined) return 0;
    const cell = campaign.cells.find((c) => c.comparison_id + ':' + c.scenario === sample.cell);
    return cell?.estimates_by_arm[sample.arm]?.cost_usd ?? 0;
  };
  const sampleDurationEstimate = (sampleId: string): number => {
    const sample = campaign.samples.find((s) => s.sample_id === sampleId);
    if (sample === undefined) return 0;
    const cell = campaign.cells.find((c) => c.comparison_id + ':' + c.scenario === sample.cell);
    return cell?.estimates_by_arm[sample.arm]?.duration_s ?? 0;
  };
  const sampleCell = (sampleId: string): string =>
    campaign.samples.find((s) => s.sample_id === sampleId)?.cell ?? '';
  const armCredentialName = (arm: string): string =>
    campaign.execution_surface.find((a) => a.name === arm)?.credential ?? '';
  const credentialOfArm = (arm: string): Credential => {
    const name = armCredentialName(arm);
    const cred = args.credentials[name];
    if (cred === undefined) throw new DispatcherError(`credential ${name} for arm ${arm} not in the registry`);
    return cred;
  };
  const poolOfArm = (arm: string): string => poolKey(credentialOfArm(arm), armCredentialName(arm));
  const graderCred = args.credentials[campaign.grader.credential];
  if (graderCred === undefined) {
    throw new DispatcherError(`grader credential ${campaign.grader.credential} not in the registry`);
  }
  const graderPool = poolKey(graderCred, campaign.grader.credential);
  const capOf = (cred: Credential): number => cred.max_concurrency ?? (cred.key_pool?.length ?? 1) * 5;
  const globalCap = campaign.contention.global_run_cap;

  // Pool accounting (subject pools + grader + global).
  const poolBusy = new Map<string, number>();
  const poolBlockedUntil = new Map<string, number>();
  const poolCapOf = (pool: string): number => {
    if (pool === GRADER_POOL) return capOf(graderCred);
    if (pool === GLOBAL_POOL) return globalCap;
    for (const arm of campaign.execution_surface) {
      if (poolOfArm(arm.name) === pool) return capOf(credentialOfArm(arm.name));
    }
    return 1;
  };

  // Budget accounting (E7.7 absolute totals). The base is the registered
  // all-in budget; R-DSP-10 raises fold in from the journal prefix below
  // (raise-only, never resurrects — the raise widens the predicate, nothing
  // else).
  let budgetStopped = false;
  const budgetPosition = writer.readBudgetPosition();
  let spendUsd = budgetPosition.spend_usd;
  let estimateUsd = budgetPosition.estimate_inflight_usd;
  const exposureSet = new Set<string>(); // sample ids in the budget-exposure set
  let budgetUsd = campaign.budget.usd_all_in;

  // Exposure facts (R-SNS-2: monotonic single emission — rehydrated from the
  // journal prefix so a resume never re-emits a landed exposure_started).
  const tracker = new ExposureTracker();
  // Sensor evidence per sample (feeds classifier rows 1/4 at terminal; the
  // dispatcher supplies the role — D-10). First match wins: when subject and
  // grader share a provider family the attribution is ambiguous and the
  // subject reading is the deterministic choice (both roles classify
  // instrument either way). Billing-exhaustion evidence has no v1 detector
  // row (D-10's vocabulary is initial); the input arm exists for platform-PR
  // additions.
  const sensorEvidenceBySample = new Map<string, { evidence: '429-match'; role: 'subject' | 'grader' }>();

  // Block lifecycle from the journal prefix.
  const admittedBlockIds = new Set<string>();
  const supersededBlockIds = new Set<string>();
  const mintedSuccessors = new Map<string, string>(); // predecessor -> successor
  const terminalAttempts = new Set<string>();
  const reserveActivated = new Set<string>();
  const abortedBlocks = new Set<string>();
  const skewExcludedBlocks = new Set<string>();
  const attemptSeqBySample = new Map<string, number>();
  const attemptSample = new Map<string, string>();
  // Per-sample analytic terminal fact — the E7.1 disposition-source filter:
  // a predecessor already instrument_failed or skew_excluded KEEPS that
  // terminal fact and never receives excluded_block_replaced (whose legal
  // sources are admitted|spawned|exposed|completed only).
  const terminalFactBySample = new Map<string, 'completed' | 'instrument_failed' | 'skew_excluded'>();
  interface FoldedMint {
    readonly predecessor: string;
    readonly successor: string;
    readonly kind: 'replacement' | 'rerun';
    readonly rosterSampleIds: readonly string[];
  }
  const foldedMints: FoldedMint[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'block_admitted':
        admittedBlockIds.add(event.payload.block_id);
        break;
      case 'attempt_created':
        // Attempt ordinals continue across sessions — a resumed dispatcher
        // must never mint a duplicate attempt_id.
        attemptSeqBySample.set(
          event.payload.sample_id,
          (attemptSeqBySample.get(event.payload.sample_id) ?? 0) + 1,
        );
        attemptSample.set(event.payload.attempt_id, event.payload.sample_id);
        break;
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        supersededBlockIds.add(rec.block_id);
        mintedSuccessors.set(rec.block_id, rec.replacement_block_id);
        if (rec.reserve_activation) reserveActivated.add(rec.replacement_block_id);
        foldedMints.push({
          predecessor: rec.block_id,
          successor: rec.replacement_block_id,
          kind: rec.kind,
          rosterSampleIds: rec.roster.map((r) => r.sample_id),
        });
        break;
      }
      case 'budget_stopped':
        budgetStopped = true;
        break;
      case 'amendment':
        // R-DSP-10: raise-only; the raise widens the budget predicate and
        // NEVER resurrects budget_stopped samples (E7.6 — budgetStopped
        // stays folded above regardless of raise order).
        if (event.payload.kind === 'budget_raise') budgetUsd += event.payload.amount_usd;
        break;
      case 'pool_blocked':
        // Cooldowns survive a restart: rehydrate the max-until per pool.
        poolBlockedUntil.set(
          event.payload.pool_key,
          Math.max(poolBlockedUntil.get(event.payload.pool_key) ?? 0, event.payload.until_ts_ms),
        );
        break;
      case 'exposure_started':
        tracker.observe(event.payload.sample_id, event.payload.ts);
        break;
      case 'aborted':
        abortedBlocks.add(event.payload.block_id);
        break;
      case 'skew_excluded':
        skewExcludedBlocks.add(event.payload.block_id);
        break;
      case 'run_completed': {
        terminalAttempts.add(event.payload.attempt_id);
        const s = attemptSample.get(event.payload.attempt_id);
        if (s !== undefined && terminalFactBySample.get(s) !== 'skew_excluded') {
          terminalFactBySample.set(s, 'completed');
        }
        break;
      }
      case 'instrument_failure': {
        terminalAttempts.add(event.payload.attempt_id);
        const s = attemptSample.get(event.payload.attempt_id);
        if (s !== undefined) terminalFactBySample.set(s, 'instrument_failed');
        break;
      }
      default:
        break;
    }
  }
  // skew_excluded fans out per sample of the named block (frozen roster or
  // mint roster) — resolve the fan-out into per-sample facts.
  for (const blockId of skewExcludedBlocks) {
    const roster =
      foldedMints.find((m) => m.successor === blockId)?.rosterSampleIds ??
      campaign.blocks.find((b) => b.block_id === blockId)?.sample_ids ??
      [];
    for (const s of roster) terminalFactBySample.set(s, 'skew_excluded');
  }

  // Live state.
  const liveBlocks = new Map<string, LiveBlockState>();
  const waiting: Block[] = armedBlocks
    .filter((b) => !admittedBlockIds.has(b.block_id) && !supersededBlockIds.has(b.block_id))
    .sort((a, b) => compareAdmissionOrder(a, b));
  waiting.sort(
    (a, b) =>
      blockPrioritySeconds({ block: b, sampleEstimateSeconds: sampleDurationEstimate }) -
      blockPrioritySeconds({ block: a, sampleEstimateSeconds: sampleDurationEstimate }),
  );

  // Rerun lineage bookkeeping: successor block id -> predecessor block id
  // (tryAdmit stamps block_admitted.rerun_of from it — E7.1 re-entry edge).
  const rerunOf = new Map<string, string>();
  /** The lineage-root Block a successor id descends from (`:iN` stripped). */
  const lineageRootBlock = (blockId: string): Block | undefined => {
    const root = blockId.replace(/(:i\d+)+$/, '');
    return campaign.blocks.find((b) => b.block_id === root);
  };

  // R-RCV-2 mint override, dispatcher half: a minted-but-unadmitted
  // successor from an earlier session is admitted AS THAT SUCCESSOR — the
  // mint's reserve/budget decision is durable and is not re-evaluated.
  // Rerun successors (`:iN`) are not in campaign.blocks and are rebuilt from
  // the mint roster; replacement successors are the frozen reserve blocks.
  // (An admitted-then-aborted successor is recovery's to re-mint, task 9 —
  // never silently re-admitted here without its own mint.)
  for (const mint of foldedMints) {
    if (admittedBlockIds.has(mint.successor) || supersededBlockIds.has(mint.successor)) continue;
    if (waiting.some((b) => b.block_id === mint.successor)) continue;
    if (mint.kind === 'rerun') {
      const root = lineageRootBlock(mint.successor);
      if (root === undefined) continue; // unknown lineage: loud elsewhere via replay
      rerunOf.set(mint.successor, mint.predecessor);
      waiting.push({ ...root, block_id: mint.successor, sample_ids: [...mint.rosterSampleIds] });
    } else {
      const reserve = reserveBlocks.find((b) => b.block_id === mint.successor);
      if (reserve !== undefined) waiting.push(reserve);
    }
  }

  // Halts + control flags.
  let admissionHalted = false;
  let haltReason = '';
  let breachActive = false;
  let signalled = false;
  let cancelRequested = false;
  let storagePaused = false;
  let activeSection: Promise<void> = Promise.resolve();
  const spawnFailuresByPool = new Map<string, number>();
  const haltedPools = new Set<string>();
  const tracker = new ExposureTracker();

  // The main loop parks on a 1s fallback clock sleep; service end, signal
  // handling, storage pause, and closed-window resolution wake it directly
  // so completion is observed without an external clock tick.
  let wake: (() => void) | null = null;
  const wakeLoop = (): void => {
    const w = wake;
    wake = null;
    if (w !== null) w();
  };

  const halt = (reason: string): void => {
    if (admissionHalted) return;
    admissionHalted = true;
    haltReason = reason;
    stream.write(`halt: ${reason} — admission stopped\n`);
  };
  args.resumeAdmission = (reason: string): void => {
    if (!admissionHalted) return;
    admissionHalted = false;
    spawnFailuresByPool.clear();
    haltedPools.clear();
    stream.write(`resume: admission resumed (${reason})\n`);
  };

  const snapshotEstimateInput = (): EventInput => ({
    type: 'budget_event',
    payload: {
      kind: 'estimate_inflight',
      amount_usd: estimateInflightTotal({
        exposureSamples: [...exposureSet].map((sampleId) => ({ sampleId })),
        estimateCostUsd: sampleEstimate,
      }),
    },
  });

  const killAllChildren = (): void => {
    for (const lb of liveBlocks.values()) {
      for (const sample of lb.samples) {
        if (sample.child !== undefined && !sample.serviceEnded) tryKillGroup(sample.child.pid);
      }
    }
  };

  /** D-13 detection feeds here from both sites: a storage-full journal
   *  append (appendCritical below) and a storage-full sidecar append (the
   *  sampler's onSampleError hook). Steps 2-6 run once; the loop exits with
   *  status 'storage_paused'; resume reconciliation is task 9's. */
  const enterStoragePause = (origin: string): void => {
    if (storagePaused) return;
    storagePaused = true;
    admissionHalted = true; // step 2: halt admission immediately
    haltReason = `storage pause: ${origin}`;
    stream.write(`storage pause detected (${origin})\n`);
    performStoragePause({
      campaignDir: args.campaignDir,
      writer,
      killAll: killAllChildren,
      stream,
    });
    wakeLoop();
  };

  const appendCritical = (inputs: EventInput[]): void => {
    // Stamp ts_ms up front so a D-13 buffer+retry lands with the ORIGINAL
    // timestamps (the fate table's buffer row: post-fact evidence rides the
    // freed ballast bytes with its original ts_ms).
    const stamped = inputs.map((i) => (i.ts_ms !== undefined ? i : { ...i, ts_ms: clockNowMs(clock) }));
    try {
      writer.appendEvents(stamped);
    } catch (err) {
      if (isStorageFullError(err)) {
        // D-13 step 1 (detect): the journal that cannot write cannot record
        // spend — fail-stop. The pause releases the ballast and journals
        // storage_paused; the interrupted inputs then retry ONCE into the
        // freed extent with their original ts_ms (fate-table buffer row).
        enterStoragePause(`journal append storage-full: ${(err as Error).message}`);
        try {
          writer.appendEvents(stamped);
        } catch {
          stream.write(
            `storage pause: ${stamped.length} event(s) could not land even after ballast release — resume re-derives/buffers them per the D-13 fate table\n`,
          );
        }
        return;
      }
      throw err;
    }
  };

  // --- R-DSP-11 verify + Decision D-11 drift response -----------------------
  const runner = args.runner ?? defaultCommandRunner;
  if (args.snapshotVerify === undefined && args.snapshot === undefined) {
    throw new DispatcherError(
      'no SnapshotHandle and no snapshotVerify seam — the R-DSP-11 admission gate cannot run; `campaign run` passes the reconstructed handle',
    );
  }
  let currentSnapshot = args.snapshot;
  const verifySnapshotNow: () => void =
    args.snapshotVerify ?? (() => verifyCampaignSnapshot(currentSnapshot as SnapshotHandle, runner));
  let lastCleanVerifyTsMs = clockNowMs(clock);
  /** Seal-relevant drift record: the journal rows (aborted + rerun mints
   *  with reason 'snapshot_drift') are what D4 reads into the seal-time
   *  adjudication rationale; this list feeds the halted-outcome reason and
   *  the operator stream. */
  const driftIncidents: string[] = [];

  const handleDrift = (err: SnapshotDriftError): void => {
    // (1) Admission halts (R-DSP-11).
    halt(`snapshot drift: ${err.message}`);
    // (2) Affected set (D-11 revised mapping): every block in flight at any
    // point during [last clean verify, re-materialization complete] plus
    // blocks with admitted-but-unspawned samples. Re-materialization has not
    // happened yet, so the window right edge is the conservative +infinity.
    const inFlight: InFlightBlock[] = [...liveBlocks.values()].map((lb) => ({
      block_id: lb.block.block_id,
      admittedTsMs: lb.admittedTsMs,
      serviceEndTsMs: lb.serviceEndTsMs ?? null,
    }));
    const admittedUnspawned = [...liveBlocks.values()]
      .filter((lb) => lb.samples.some((s) => s.child === undefined && !s.serviceEnded))
      .map((lb) => lb.block.block_id);
    const affected = driftAffectedBlockIds({
      window: { lastCleanVerifyTsMs, rematerializedTsMs: Number.MAX_SAFE_INTEGER },
      inFlight,
      admittedUnspawned,
    });
    // (3) Kill affected in-flight groups (our own child handles — the
    // cross-process R-RCV-1 pgid sanity guard is recovery's, task 9) and
    // journal aborted per affected block; membership change appends the
    // superseding snapshot in the same critical section (E7.7).
    const aborts: EventInput[] = [];
    for (const blockId of affected) {
      const lb = liveBlocks.get(blockId);
      if (lb === undefined) continue;
      for (const sample of lb.samples) {
        if (sample.child !== undefined && !sample.serviceEnded) tryKillGroup(sample.child.pid);
      }
      if (lb.samples.some((s) => !s.serviceEnded)) {
        aborts.push({ type: 'aborted', payload: { block_id: blockId } });
      }
      for (const sample of lb.samples) releaseSample(sample);
    }
    if (aborts.length > 0) appendCritical([...aborts, snapshotEstimateInput()]);
    // (4) Authorized repair through the CommandRunner seam (D2 contracts:
    // worktree remove --force + prune on the source checkout, idempotent
    // re-materialize at the same dest — repairDriftedTrees, task 4).
    if (args.repairSnapshot === undefined) {
      stream.write(
        'snapshot drift: no repair seam in this process — exiting halted; `quorum campaign run` repairs and resumes\n',
      );
      driftIncidents.push(`unrepaired drift: ${err.message}`);
      wakeLoop();
      return;
    }
    let repaired: SnapshotHandle;
    try {
      repaired = args.repairSnapshot();
    } catch (repairErr) {
      stream.write(
        `snapshot drift repair FAILED: ${(repairErr as Error).message} — admission stays halted\n`,
      );
      driftIncidents.push(`failed repair: ${(repairErr as Error).message}`);
      wakeLoop();
      return;
    }
    currentSnapshot = repaired;
    // (5) Admission resumes ONLY after a clean re-verify of the repaired
    // instrument.
    try {
      verifySnapshotNow();
    } catch (reverifyErr) {
      stream.write(
        `snapshot drift: still dirty after repair: ${(reverifyErr as Error).message} — admission stays halted\n`,
      );
      driftIncidents.push(`dirty after repair: ${(reverifyErr as Error).message}`);
      wakeLoop();
      return;
    }
    lastCleanVerifyTsMs = clockNowMs(clock);
    // (6) Affected cells re-enter via E7 rerun instances — reserve- and
    // count-neutral: same samples, fresh block instance, next :i seq.
    const rerunBundle: EventInput[] = [];
    for (const blockId of affected) {
      const lb = liveBlocks.get(blockId);
      if (lb === undefined) continue;
      const successorId = nextRerunInstanceId(blockId);
      rerunBundle.push({
        type: 'block_replaced',
        payload: {
          block_id: blockId,
          replacement_block_id: successorId,
          reason: 'snapshot_drift',
          kind: 'rerun',
          reserve_activation: false,
          roster: lb.block.sample_ids.map((sampleId) => ({
            sample_id: sampleId,
            arm: armOf(sampleId),
          })),
        },
      });
      supersededBlockIds.add(blockId);
      rerunOf.set(successorId, blockId);
      waiting.push({ ...lb.block, block_id: successorId });
      liveBlocks.delete(blockId);
    }
    if (rerunBundle.length > 0) appendCritical(rerunBundle);
    // (7) Incident recorded for the seal-time adjudication (D4 reads the
    // reason-'snapshot_drift' journal rows; the operator sees it now).
    driftIncidents.push(
      `drift repaired; ${affected.length} block(s) re-entered as reruns: ${affected.join(', ')}`,
    );
    args.resumeAdmission?.(`snapshot repaired + clean re-verify (${affected.length} rerun re-entries)`);
    wakeLoop();
  };

  // --- Service-end release (Decision D-1: child death, not the analytical
  //     terminal; retained-evidence exclusions hold slots to process exit) --
  const releaseSample = (sample: LiveSampleState): void => {
    if (sample.serviceEnded) return;
    sample.serviceEnded = true;
    exposureSet.delete(sample.sampleId);
    for (const pool of [sample.subjectPool, GRADER_POOL, GLOBAL_POOL]) {
      poolBusy.set(pool, Math.max(0, (poolBusy.get(pool) ?? 0) - 1));
    }
    const lb = liveBlocks.get(sample.blockId);
    if (lb !== undefined && lb.serviceEndTsMs === undefined && lb.samples.every((s) => s.serviceEnded)) {
      lb.serviceEndTsMs = clockNowMs(clock);
    }
    wakeLoop(); // a released slot is an admission instant + a completion edge
  };

  // --- Replacement obligation (R-DSP-5 + E7.1 ordered mint bundle) --------
  const reserveForCell = (cellKey: string): Block | undefined =>
    reserveBlocks.find(
      (b) => b.block_id.startsWith(`${cellKey}:x`) && !reserveActivated.has(b.block_id),
    );

  const mintReplacement = (
    failedBlock: LiveBlockState,
    reason: string,
  ): void => {
    // Idempotent per block: one mint per predecessor (a two-sample block can
    // fail twice — e.g. both spawns fail — but activates ONE fresh block).
    if (supersededBlockIds.has(failedBlock.block.block_id)) return;
    const cellKey = cellKeyOfBlock(failedBlock.block.block_id);
    const reserve = reserveForCell(cellKey);
    if (budgetStopped) {
      appendCritical([
        {
          type: 'adjudication',
          payload: { cell: cellKey, disposition: 'replacement_suppressed', rationale: 'budget_stopped' },
        },
      ]);
      stream.write(`replacement suppressed for ${cellKey}: budget stopped (named shortfall)\n`);
      return;
    }
    if (reserve === undefined) {
      appendCritical([
        {
          type: 'adjudication',
          payload: { cell: cellKey, disposition: 'reserve_exhausted', rationale: 'reserve_exhausted' },
        },
      ]);
      stream.write(`reserve exhausted for ${cellKey}: named shortfall\n`);
      return;
    }
    // Roster with same-arm supersedes pairing (total: one sample per arm).
    const roster = reserve.sample_ids.map((sampleId) => {
      const arm = armOf(sampleId);
      const predecessor = failedBlock.samples.find((s) => s.arm === arm);
      return {
        sample_id: sampleId,
        arm,
        ...(predecessor !== undefined ? { supersedes: predecessor.sampleId } : {}),
      };
    });
    // E7.1 mint bundle: block_replaced FIRST (durable successor + seal
    // obligation), then exactly the required predecessor dispositions, in
    // serialized roster order — one critical section.
    const bundle: EventInput[] = [
      {
        type: 'block_replaced',
        payload: {
          block_id: failedBlock.block.block_id,
          replacement_block_id: reserve.block_id,
          reason,
          kind: 'replacement',
          reserve_activation: true,
          roster,
        },
      },
    ];
    // Dispositions: NONE for a skew refill (E7.2 — the excluded samples keep
    // their skew_excluded terminal; the block-level event carries the
    // conservation link). Otherwise one per supersedes pair whose
    // predecessor's state immediately before the mint is a LEGAL disposition
    // source (admitted|spawned|exposed|completed) — a predecessor already
    // instrument_failed or skew_excluded keeps that terminal fact instead
    // (replay would reject the disposition from those states, R-JRN-7).
    if (reason !== 'skew_refill') {
      for (const entry of roster) {
        if (entry.supersedes === undefined) continue;
        const fact = terminalFactBySample.get(entry.supersedes);
        if (fact === 'instrument_failed' || fact === 'skew_excluded') continue;
        bundle.push({
          type: 'sample_disposition',
          payload: {
            sample_id: entry.supersedes,
            disposition: 'excluded_block_replaced',
            superseded_by: entry.sample_id,
          },
        });
      }
    }
    appendCritical(bundle);
    reserveActivated.add(reserve.block_id);
    supersededBlockIds.add(failedBlock.block.block_id);
    // The reserve block re-enters the waiting queue.
    waiting.push(reserve);
    stream.write(`replacement minted: ${failedBlock.block.block_id} -> ${reserve.block_id} (reason ${reason})\n`);
  };

  // --- Runtime skew rule (R-DSP-9; R-SNS-4 fail-closed absence) -----------
  // Decided at BLOCK TERMINAL from the tracker's timestamps (Decision D-9
  // decision point). Instrument-failed blocks are the replacement path's;
  // skew owns only determinate blocks.
  const decideBlockSkew = (lb: LiveBlockState): void => {
    if (supersededBlockIds.has(lb.block.block_id)) return;
    if (skewExcludedBlocks.has(lb.block.block_id)) return;
    if (lb.samples.some((s) => terminalFactBySample.get(s.sampleId) === 'instrument_failed')) return;
    const exposures = lb.samples.map((s) => tracker.value(s.sampleId));
    const missing = exposures.some((e) => e === null);
    const known = exposures.filter((e): e is number => e !== null);
    const skewSeconds = known.length > 1 ? (Math.max(...known) - Math.min(...known)) / 1000 : 0;
    const breached = missing || skewSeconds > campaign.suite.max_exposure_skew;
    if (!breached) return;
    const detail = missing
      ? 'exposure unestablished by the decision point (fail-closed, R-SNS-4)'
      : `exposure skew ${Math.round(skewSeconds)}s > registered ${campaign.suite.max_exposure_skew}s`;
    if (campaign.suite.kind !== 'gating') {
      // Exploratory: a rendered caveat, never an exclusion (R-DSP-9).
      stream.write(`exposure-skew caveat (exploratory): block ${lb.block.block_id} — ${detail}\n`);
      return;
    }
    // Gating: excluded from the paired comparison + refilled from reserve.
    // Journal expression is E7.2: skew_excluded fans out over the block's
    // roster; the refill mint carries reason 'skew_refill' and NO
    // dispositions (the samples keep their skew_excluded terminal; the
    // conservation link rides the mint's roster supersedes pairs).
    skewExcludedBlocks.add(lb.block.block_id);
    for (const s of lb.samples) terminalFactBySample.set(s.sampleId, 'skew_excluded');
    appendCritical([{ type: 'skew_excluded', payload: { block_id: lb.block.block_id } }]);
    stream.write(`skew excluded: block ${lb.block.block_id} — ${detail} — refilling from reserve\n`);
    mintReplacement(lb, 'skew_refill');
  };

  // --- Child supervision ----------------------------------------------------
  const superviseSample = (
    sample: LiveSampleState,
    child: SpawnedCampaignChild,
    block: LiveBlockState,
  ): void => {
    sample.child = child;
    child.onStdoutLine((line) => {
      const runId = parseRunAllocatedLine(line);
      if (runId !== null && sample.runId === undefined) {
        sample.runId = runId;
        // R-JRN-8/R-SPN-5: run_allocated immediately after spawn, same
        // dispatch critical section; pgid validated before journaling.
        assertProcessGroupExists(child.pid);
        const subjectGrant = credentialOfArm(sample.arm).api_key_env;
        const graderGrant = graderCred.api_key_env;
        appendCritical([
          {
            type: 'run_allocated',
            payload: {
              attempt_id: sample.attemptId,
              run_id: runId,
              pgid: child.pid,
              ...keyGrantsPayload({
                ...(subjectGrant !== undefined ? { subjectEnv: subjectGrant } : {}),
                ...(graderGrant !== undefined ? { graderEnv: graderGrant } : {}),
              }),
            },
          },
        ]);
      }
    });
    child.onStderrLine((line) => {
      // Sensors classify; the dispatcher journals (R-JRN emitters). ONE
      // campaign child carries BOTH parties' traffic, so the line is
      // classified against both credential contexts and the dispatcher
      // supplies the role (D-10: pool_blocked names the RIGHT pool — a
      // grader throttle blocks GRADER_POOL, never the subject pool; the
      // recorded evidence feeds classifier rows 1/4 at terminal).
      const runtimeFamily = campaign.execution_surface.find((a) => a.name === sample.arm)?.agent;
      const subjectCred = credentialOfArm(sample.arm);
      const contexts: { role: 'subject' | 'grader'; cred: Credential; pool: string }[] = [
        { role: 'subject', cred: subjectCred, pool: sample.subjectPool },
        { role: 'grader', cred: graderCred, pool: GRADER_POOL },
      ];
      for (const ctx of contexts) {
        const match = classifyRateLimit({
          api: ctx.cred.api,
          ...(ctx.cred.base_url !== undefined ? { base_url: ctx.cred.base_url } : {}),
          ...(ctx.role === 'subject' && runtimeFamily !== undefined ? { runtimeFamily } : {}),
          text: line,
        });
        if (match === null) continue;
        if (!sensorEvidenceBySample.has(sample.sampleId)) {
          sensorEvidenceBySample.set(sample.sampleId, { evidence: '429-match', role: ctx.role });
        }
        const nowMs = clockNowMs(clock);
        const until = nowMs + match.cooldownMs;
        const existing = poolBlockedUntil.get(ctx.pool);
        // Duplicate arbitration: coalesce into one pool_blocked, max until.
        if (existing === undefined || until > existing) {
          poolBlockedUntil.set(ctx.pool, until);
          appendCritical([
            { type: 'pool_blocked', payload: { pool_key: ctx.pool, until_ts_ms: until } },
          ]);
        }
      }
    });
    child.onExit((info) => {
      releaseSample(sample);
      // Terminal classification (the R-JRN emitters contract: child exit ->
      // VERDICT READ -> run_completed | instrument_failure). The verdict
      // supplies outcome + RunErrorStage so every classifier row is
      // reachable; a child that died before composing has no verdict and
      // classifies through the exit-code heuristic (crash/signal rows).
      // Sensor evidence recorded during the run feeds rows 1/4.
      const verdict = sample.runId !== undefined ? readVerdict(runDirOf(sample.runId)) : null;
      const sensed = sensorEvidenceBySample.get(sample.sampleId);
      const outcome = verdict?.outcome ?? (info.code === 0 ? 'pass' : 'indeterminate');
      const classification = classifyFailure({
        outcome,
        ...(verdict?.stage !== undefined ? { stage: verdict.stage } : {}),
        exitClass: info.signal !== null ? 'signal' : info.code === 0 ? 'clean' : 'crash',
        role: sensed?.role ?? 'subject',
        sensorEvidence: sensed?.evidence ?? 'none',
      });
      appendCritical([
        {
          type: classification.class === 'instrument' ? 'instrument_failure' : 'run_completed',
          payload:
            classification.class === 'instrument'
              ? { attempt_id: sample.attemptId, cause: classification.cause }
              : { attempt_id: sample.attemptId, outcome },
        },
      ]);
      terminalFactBySample.set(
        sample.sampleId,
        classification.class === 'instrument' ? 'instrument_failed' : 'completed',
      );
      // R-SNS-2/3/5 + D-9: exposure lands at the terminal path — the
      // capture-derived first-generation timestamp (permitted by decision
      // time), monotonic single emission via the tracker; payload field is
      // `ts` (R-JRN-5 field normalization). Absence stays absent — the skew
      // decision below treats it fail-closed (R-SNS-4).
      if (sample.runId !== undefined) {
        const exposureTs = observeExposure(runDirOf(sample.runId));
        if (exposureTs !== null && tracker.observe(sample.sampleId, exposureTs)) {
          appendCritical([
            { type: 'exposure_started', payload: { sample_id: sample.sampleId, ts: exposureTs } },
          ]);
        }
      }
      if (classification.class === 'instrument' && classification.cause !== undefined) {
        mintReplacement(block, classification.cause);
      }
      // Terminal spend + superseding snapshot in ONE critical section (E7.7).
      spendUsd += sampleEstimate(sample.sampleId);
      appendCritical([
        { type: 'budget_event', payload: { kind: 'spend', amount_usd: sampleEstimate(sample.sampleId) } },
        snapshotEstimateInput(),
      ]);
      // The in-memory position tracks the superseding snapshot exactly
      // (R-JRN-12: the budget predicate reads Σ spend + LATEST estimate).
      estimateUsd = estimateInflightTotal({
        exposureSamples: [...exposureSet].map((sampleId) => ({ sampleId })),
        estimateCostUsd: sampleEstimate,
      });
      // Block terminal: the skew decision (R-DSP-9, gating) runs first, then
      // D2 cadence point 2 of 3 (R-DSP-11): verify at BLOCK terminal (the
      // third point, pre-seal, is D4's — the handoff names its call site).
      if (!storagePaused && block.samples.every((s) => s.serviceEnded)) {
        decideBlockSkew(block);
        try {
          verifySnapshotNow();
          lastCleanVerifyTsMs = clockNowMs(clock);
        } catch (err) {
          if (err instanceof SnapshotDriftError) handleDrift(err);
          else throw err;
        }
      }
    });
  };

  // --- Admission -------------------------------------------------------------
  const tryAdmit = (block: Block): boolean => {
    const demand = blockDemandVector({
      block,
      sampleArmCredentialPool: (sampleId) => poolOfArm(armBySample.get(sampleId) ?? ''),
      graderPool,
    });
    for (const [pool, n] of demand) {
      const busy = poolBusy.get(pool) ?? 0;
      const blockedUntil = poolBlockedUntil.get(pool);
      if (blockedUntil !== undefined && clockNowMs(clock) < blockedUntil) return false; // cooldown
      if (haltedPools.has(pool)) return false;
      if (busy + n > poolCapOf(pool)) return false;
    }
    // R-DSP-6 budget gate: counts hard, dollars soft — stop admitting when
    // position + proposed exposure would exceed budget_usd.
    const proposedExposure = block.sample_ids.reduce((sum, s) => sum + sampleEstimate(s), 0);
    if (!budgetStopped && spendUsd + Math.max(estimateUsd, 0) + proposedExposure > budgetUsd) {
      // E3: the stop reaches admitted-but-not-yet-spawned samples too.
      budgetStopped = true;
      const stoppedSamples = [...waiting.flatMap((b) => b.sample_ids)];
      appendCritical([
        { type: 'budget_stopped', payload: { sample_ids: stoppedSamples } },
        snapshotEstimateInput(),
      ]);
      stream.write(`budget stop: $${spendUsd} spent + $${estimateUsd} estimated exceeds $${budgetUsd} — no new admissions (raise never resurrects)\n`);
      return false;
    }
    if (budgetStopped) return false;
    // Commit: pool accounting + block_admitted + exposure membership +
    // superseding snapshot, one critical section, snapshot LAST before
    // handoff.
    for (const [pool, n] of demand) poolBusy.set(pool, (poolBusy.get(pool) ?? 0) + n);
    const attemptSeqs: { sampleId: string; attemptId: string }[] = [];
    for (const sampleId of block.sample_ids) {
      const seq = (attemptSeqBySample.get(sampleId) ?? 0) + 1;
      attemptSeqBySample.set(sampleId, seq);
      attemptSeqs.push({ sampleId, attemptId: `${sampleId}:a${seq}` });
      exposureSet.add(sampleId);
    }
    appendCritical([
      {
        type: 'block_admitted',
        payload: {
          block_id: block.block_id,
          pools: [...demand.keys()],
          // E7.1 re-entry: a rerun successor re-admits from its
          // predecessor's aborted state via rerun_of.
          ...(rerunOf.has(block.block_id) ? { rerun_of: rerunOf.get(block.block_id) } : {}),
        },
      },
      ...attemptSeqs.map((a) => ({
        type: 'attempt_created' as const,
        payload: { sample_id: a.sampleId, attempt_id: a.attemptId },
      })),
      snapshotEstimateInput(),
    ]);
    estimateUsd = estimateInflightTotal({
      exposureSamples: [...exposureSet].map((sampleId) => ({ sampleId })),
      estimateCostUsd: sampleEstimate,
    });
    admittedBlockIds.add(block.block_id);
    const live: LiveBlockState = {
      block,
      slot: block.slot ?? 'primary',
      samples: attemptSeqs.map((a) => ({
        sampleId: a.sampleId,
        blockId: block.block_id,
        arm: armBySample.get(a.sampleId) ?? '',
        attemptId: a.attemptId,
        subjectPool: poolOfArm(armBySample.get(a.sampleId) ?? ''),
        serviceEnded: false,
      })),
      admittedTsMs: clockNowMs(clock),
    };
    liveBlocks.set(block.block_id, live);
    // Spawn each sample (R-SPN): attempt_created already journaled (R-JRN-8).
    for (const sample of live.samples) {
      try {
        const inFlight: Record<string, number> = {};
        const subjectRes = resolveKeyForSpawn({
          cred: credentialOfArm(sample.arm),
          credentialName: armCredentialName(sample.arm),
          inFlight,
        });
        if (subjectRes.kind === 'wait') {
          const enteredMs = clockNowMs(clock);
          warnKeyWait(stream, 'entry', armCredentialName(sample.arm));
          warnKeyWait(stream, 'resolution', armCredentialName(sample.arm), 0);
        }
        const argv = buildCampaignChildArgv({
          evalsRoot: currentSnapshot?.evalsRoot ?? join(args.campaignDir, 'evals'),
          scenarioDir: join(
            currentSnapshot?.evalsRoot ?? join(args.campaignDir, 'evals'),
            'scenarios',
            scenarioOfSample(sample.sampleId),
          ),
          codingAgent: campaign.execution_surface.find((a) => a.name === sample.arm)?.agent ?? '',
          codingAgentsDir: join(currentSnapshot?.evalsRoot ?? join(args.campaignDir, 'evals'), 'coding-agents'),
          outRoot: args.resultsRoot ?? 'results',
          os: 'linux',
          credentialName: armCredentialName(sample.arm),
          credentialsFile: join(currentSnapshot?.evalsRoot ?? join(args.campaignDir, 'evals'), 'credentials.yaml'),
          gauntletBin: currentSnapshot?.gauntletBin ?? join(args.campaignDir, 'bin', 'gauntlet'),
          superpowers:
            campaign.refs.superpowers_by_arm[sample.arm] !== null &&
            campaign.refs.superpowers_by_arm[sample.arm] !== undefined
              ? { mode: 'root', root: join(args.campaignDir, `superpowers-${campaign.refs.superpowers_by_arm[sample.arm]}`) }
              : { mode: 'none' },
          identity: {
            campaign_id: campaign.campaign_id,
            comparison_id: block.comparison_id,
            block_id: block.block_id,
            sample_id: sample.sampleId,
            execution_attempt_id: sample.attemptId,
          },
        });
        const spec: CampaignChildSpec = {
          command: 'bun',
          args: argv,
          cwd: currentSnapshot?.evalsRoot ?? join(args.campaignDir, 'evals'),
          env: { ...childCoveredEnv(), PATH: process.env['PATH'] ?? '' },
        };
        const child = spawner.spawn(spec);
        superviseSample(sample, child, live);
        spawnFailuresByPool.set(sample.subjectPool, 0);
      } catch (err) {
        // Spawn-failure pool halt (REV fable I-14): N consecutive failures
        // attributed to one pool halt admission for that pool.
        const failures = (spawnFailuresByPool.get(sample.subjectPool) ?? 0) + 1;
        spawnFailuresByPool.set(sample.subjectPool, failures);
        stream.write(`spawn failure ${failures}/${SPAWN_FAILURE_HALT_N} for pool ${sample.subjectPool}: ${(err as Error).message}\n`);
        if (failures >= SPAWN_FAILURE_HALT_N) {
          haltedPools.add(sample.subjectPool);
          halt(`spawn-failure pool halt: ${SPAWN_FAILURE_HALT_N} consecutive failures on ${sample.subjectPool} — a lost key env cannot burn the reserve (operator resume clears)`);
        }
        // A spawn-failed sample never ran: release its slots (a held slot
        // would wedge the caps forever) and journal its typed terminal —
        // classifier row 6: exit class spawn-failed -> instrument,
        // subject_spawn_failed — with the superseding snapshot in the same
        // critical section (E7.7 membership change).
        releaseSample(sample);
        const spawnClass = classifyFailure({
          outcome: 'indeterminate',
          exitClass: 'spawn-failed',
          role: 'subject',
          sensorEvidence: 'none',
        });
        appendCritical([
          {
            type: 'instrument_failure',
            payload: { attempt_id: sample.attemptId, cause: spawnClass.cause },
          },
          snapshotEstimateInput(),
        ]);
        terminalFactBySample.set(sample.sampleId, 'instrument_failed');
        // R-DSP-5: the typed instrument failure activates a fresh full block
        // (idempotent per predecessor — a second failed spawn in the same
        // block does not mint twice).
        mintReplacement(live, spawnClass.cause ?? 'subject_spawn_failed');
      }
    }
    return true;
  };

  const admitWave = (): void => {
    if (storagePaused) return;
    // D2 cadence point 1 of 3 (R-DSP-11): verify per admission wave, BEFORE
    // wave admission — a drifted instrument admits nothing. Drift runs the
    // full Decision D-11 sequence (handleDrift); a successful in-wave repair
    // resumes admission and the wave scan below proceeds against the
    // repaired instrument.
    try {
      verifySnapshotNow();
      lastCleanVerifyTsMs = clockNowMs(clock);
    } catch (err) {
      if (err instanceof SnapshotDriftError) {
        handleDrift(err);
        if (admissionHalted) return;
      } else {
        throw err;
      }
    }
    // Dead-sampler liveness (Decision D-3): staleness > 2 x cadence halts.
    if (args.sampler !== 'disabled') {
      const { lines } = parseSidecar(args.campaignDir);
      const stale = samplerStaleMs(lines, clockNowMs(clock));
      if (stale > 2 * campaign.contention.cadence_ms) {
        halt(`dead sampler: sidecar stale ${stale}ms > 2 x cadence — a dead sampler must not look like a quiet host`);
        return;
      }
    }
    if (breachActive) return; // live breach: admission-only halt
    if (admissionHalted) return;
    // R-DSP-4 greedy backfill in longest-expected-first order (R-DSP-2:
    // priority = max expected duration across a block's samples; ties break
    // by the deterministic comparison/cell/replicate ordinal). The scan
    // iterates a sorted snapshot — safe against removal, and blocks pushed
    // since the last wave (reserve activations) re-sort into place, so the
    // scan order is always the pinned one regardless of insertion order.
    const wave = [...waiting].sort(
      (a, b) =>
        blockPrioritySeconds({ block: b, sampleEstimateSeconds: sampleDurationEstimate }) -
          blockPrioritySeconds({ block: a, sampleEstimateSeconds: sampleDurationEstimate }) ||
        compareAdmissionOrder(a, b),
    );
    for (const block of wave) {
      if (tryAdmit(block)) waiting.splice(waiting.indexOf(block), 1);
    }
  };

  // --- Closed-window contention resolution (ratified OQ-11) -----------------
  const resolveClosedWindow = (window: BreachWindow): void => {
    breachActive = false;
    const { lines } = parseSidecar(args.campaignDir);
    const thresholds: ResolvedThreshold[] = campaign.contention.thresholds.map((t) => ({
      metric: t.metric,
      op: t.op,
      value: t.value,
    }));
    const intervals: BlockInterval[] = [...liveBlocks.values()].map((lb) => ({
      block_id: lb.block.block_id,
      startTsMs: lb.admittedTsMs,
      endTsMs: lb.serviceEndTsMs ?? null, // still-live blocks clip to the horizon in the evaluator
    }));
    const verdicts = evaluateContention({
      lines,
      thresholds,
      sustainK: campaign.contention.sustain_k,
      cadenceMs: campaign.contention.cadence_ms,
      coverageN: campaign.contention.coverage_n,
      campaignOpenedTsMs: 0,
      lastTerminalTsMs: window.endTsMs ?? clockNowMs(clock),
      blocks: intervals,
    });
    const invalid = [...liveBlocks.values()]
      .filter((lb) => verdicts.get(lb.block.block_id) === 'invalid' && !supersededBlockIds.has(lb.block.block_id))
      .sort((a, b) => compareAdmissionOrder(a.block, b.block));
    if (invalid.length === 0) {
      stream.write('contention resolution: affected=0 refilled=0 exhausted=0 suppressed=0\n');
      stream.write('admission resumed\n');
      return;
    }
    // One dispatch writer critical section covers the whole batch; frozen
    // comparison/cell/replicate + lineage-mint order; lowest reserve ordinal.
    let refilled = 0;
    let exhausted = 0;
    let suppressed = 0;
    const batch: EventInput[] = [];
    for (const lb of invalid) {
      const cellKey = cellKeyOfBlock(lb.block.block_id);
      const reserve = reserveForCell(cellKey);
      // R-DSP-6 pass-through: contention refill is NOT reserve-neutral — a
      // resolution-time mint must clear the budget predicate against the
      // reserve's priced exposure. A durable stop (pre-existing or fired
      // right here) suppresses this and every later obligation in the
      // frozen order; a later raise never revisits this resolution.
      if (!budgetStopped && reserve !== undefined) {
        const reserveExposure = reserve.sample_ids.reduce((sum, s) => sum + sampleEstimate(s), 0);
        if (spendUsd + Math.max(estimateUsd, 0) + reserveExposure > budgetUsd) {
          budgetStopped = true;
          batch.push(
            { type: 'budget_stopped', payload: { sample_ids: [...waiting.flatMap((b) => b.sample_ids)] } },
            snapshotEstimateInput(),
          );
        }
      }
      if (budgetStopped) {
        batch.push({
          type: 'adjudication',
          payload: { cell: cellKey, disposition: 'replacement_suppressed', rationale: 'budget_stopped' },
        });
        suppressed += 1;
        continue;
      }
      if (reserve === undefined) {
        batch.push({
          type: 'adjudication',
          payload: { cell: cellKey, disposition: 'reserve_exhausted', rationale: 'reserve_exhausted' },
        });
        exhausted += 1;
        continue;
      }
      const roster = reserve.sample_ids.map((sampleId) => {
        const arm = armBySample.get(sampleId) ?? '';
        const predecessor = lb.samples.find((s) => s.arm === arm);
        return {
          sample_id: sampleId,
          arm,
          ...(predecessor !== undefined ? { supersedes: predecessor.sampleId } : {}),
        };
      });
      batch.push({
        type: 'block_replaced',
        payload: {
          block_id: lb.block.block_id,
          replacement_block_id: reserve.block_id,
          reason: 'contention',
          kind: 'replacement', // never rerun kind (Decision D-5)
          reserve_activation: true,
          roster,
        },
      });
      for (const entry of roster) {
        if (entry.supersedes === undefined) continue;
        batch.push({
          type: 'sample_disposition',
          payload: {
            sample_id: entry.supersedes,
            disposition: 'excluded_block_replaced',
            superseded_by: entry.sample_id,
          },
        });
      }
      reserveActivated.add(reserve.block_id);
      supersededBlockIds.add(lb.block.block_id);
      waiting.push(reserve);
      refilled += 1;
    }
    appendCritical(batch);
    // Resolution counts BEFORE the separate admission-resumed line (D-3).
    stream.write(
      `contention resolution: affected=${invalid.length} refilled=${refilled} exhausted=${exhausted} suppressed=${suppressed}\n`,
    );
    stream.write('admission resumed\n');
    wakeLoop(); // minted reserves are admission candidates now
  };

  // --- Signal handling (R-DSP-7 / Decision D-12 pinned order) ---------------
  // The live path never interleaves an E7 mint critical section: the handler
  // awaits the active section, so a partial bundle is unobservable in-process
  // and D-12's "complete any partial mint bundle" is structurally satisfied.
  const uninstallSignals = (args.installSignals ?? defaultInstallSignals)((signalName) => {
    void signalName;
    void activeSection.then(() => {
      if (signalled || storagePaused) return;
      // 1. Stop admitting (`signalled` gates the loop; no further waves).
      signalled = true;
      // 2. Kill every campaign process group (TERM, escalate KILL, verify
      // dead — our own child handles; the cross-process R-RCV-1 sanity
      // guard is recovery's, task 9).
      killAllChildren();
      // 3. Journal aborted per in-flight block; the kill drains the
      // budget-exposure membership, so the superseding snapshot rides the
      // same critical section (E7.7).
      const aborts: EventInput[] = [];
      for (const lb of liveBlocks.values()) {
        if (lb.samples.some((s) => !s.serviceEnded)) {
          aborts.push({ type: 'aborted', payload: { block_id: lb.block.block_id } });
        }
        for (const sample of lb.samples) releaseSample(sample);
      }
      const bundle: EventInput[] = aborts.length > 0 ? [...aborts, snapshotEstimateInput()] : [];
      // 4. Operator cancel (Decision D-12): the cancel-request marker means
      // this signal came from `quorum campaign cancel` — the dispatcher
      // completes the FULL pinned sequence and journals campaign_cancelled
      // LAST (the cancel verb polls the journal for exactly this event). A
      // plain signal journals aborted only and stays resumable (`running`).
      cancelRequested = existsSync(join(args.campaignDir, 'cancel-request'));
      if (cancelRequested) {
        const markerBody = readFileSync(join(args.campaignDir, 'cancel-request'), 'utf8');
        const reason = markerBody.split('\n')[1] ?? '';
        bundle.push({
          type: 'campaign_cancelled',
          payload: reason !== '' ? { reason } : {},
        });
      }
      if (bundle.length > 0) appendCritical(bundle);
      // 5. Exit — resumable on a plain signal, terminal on cancel.
      wakeLoop();
    });
  });

  const tryKillGroup = (pgid: number): void => {
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    // Verify dead; escalate.
    for (let i = 0; i < 10; i++) {
      try {
        process.kill(-pgid, 0);
      } catch {
        return;
      }
      Bun.sleepSync(50);
    }
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // gone
    }
  };

  // --- Sampler start (Decision D-3: sensors lead; the dispatcher consumes
  //     breach entry -> admission-only halt, closed windows -> resolution
  //     batch, sample errors -> the D-13 storage-pause path) ----------------
  const samplerHooks: DispatchSamplerHooks = {
    onBreachEntry: (metrics) => {
      breachActive = true;
      stream.write(
        `contention breach entry: ${metrics.join(', ')} — admission halted, in-flight runs to service end\n`,
      );
    },
    onBreachExit: (window) => {
      // The sampler fsynced the exit sample BEFORE this notification
      // (pinned order); the resolution batch re-reads the durable sidecar.
      resolveClosedWindow(window);
    },
    onSampleError: (err) => {
      if (isStorageFullError(err)) {
        // D-13 step 1, second detector: the sampler plausibly hits the full
        // volume first; the dispatcher enters the same pause path.
        enterStoragePause(`sidecar append storage-full: ${(err as Error).message}`);
      }
      // Other probe errors already produced a sidecar gap line; coverage +
      // the dead-sampler liveness halt make them visible.
    },
  };
  const stopSampler = args.sampler === 'disabled' ? null : args.sampler.start(samplerHooks);

  // --- Main loop ------------------------------------------------------------
  // Parks on a 1s fallback clock sleep OR the wake channel (service end,
  // signal, storage pause, resolution) — completion is observed without an
  // external clock tick.
  admitWave();
  while (!signalled && !storagePaused) {
    const allServed =
      waiting.length === 0 &&
      [...liveBlocks.values()].every((lb) => lb.samples.every((s) => s.serviceEnded));
    if (budgetStopped && waiting.length > 0) {
      // Stopped samples never spawn; they were journaled at the stop.
      waiting.length = 0;
    }
    if (allServed) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      void clock.sleepUntil(clock.now() + 1).then(resolve);
    });
    wake = null;
    if (signalled || storagePaused) break;
    admitWave();
  }
  if (stopSampler !== null) await stopSampler();
  uninstallSignals();
  if (storagePaused) {
    try {
      writer.release();
    } catch {
      // Full volume: release's checkpoint can fail. The lease token stops
      // beating, goes stale, and resume reclaims via the dead-holder check.
    }
    return { status: 'storage_paused', reason: haltReason };
  }
  writer.checkpoint();
  writer.release();
  if (cancelRequested) {
    return { status: 'cancelled', reason: 'operator cancel: aborted journaled, campaign_cancelled last' };
  }
  if (signalled) return { status: 'signalled' };
  if (admissionHalted) {
    return {
      status: 'halted',
      reason: driftIncidents.length > 0 ? `${haltReason}; ${driftIncidents.join('; ')}` : haltReason,
    };
  }
  return { status: 'completed' };
}

function defaultInstallSignals(handler: (signal: NodeJS.Signals) => void): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
```

**Implementer notes (recorded, not silent):** `onExit`'s classification reads the run dir's `verdict.json` through `readVerdict` (production default `readVerdictSummary`) — outcome + `RunErrorStage` make every classifier row reachable; a child with no composed verdict (crash) classifies through the exit-code heuristic, which is exactly the path the scripted fake children exercise. Exposure rides `observeExposure` (production default `trajectoryExposureMs` — D-9's capture-derived value at the block-terminal decision point; because the decision value IS the capture-derived value, no post-hoc audit divergence path exists in v1 and `'exposure_audit'` remains reserved vocabulary). `activeSection` must wrap `mintReplacement`/`appendCritical` call sites so a signal cannot interleave a mint bundle (D-12); the structure above awaits it in the handler before kills. Closed windows reach `resolveClosedWindow` only through `DispatchSamplerHooks.onBreachExit` — production via `realSamplerSeam`'s `ContentionSampler` (fsync-exit-sample-then-notify), tests via a scripted `DispatchSamplerSeam` that captures the hooks at `start()`; there is no other entry point (task 9's recovery re-derives interrupted batches through the same `evaluateContention`, not through the dispatcher).

- [ ] **Step 9: Run tests to verify they pass**

Run: `bun test test/campaign-dispatcher.test.ts`
Expected: PASS (13 tests). Then `bun run check`.

- [ ] **Step 10: Commit (task 8b)**

```bash
git add src/campaign/dispatcher.ts test/campaign-dispatcher.test.ts
git commit -m "feat(campaign): D3 dispatcher — atomic admission, mints, budget, halts

Per-block atomic admission over subject + grader pools + the per-sample
global cap with service-end release (Decision D-1 occupancy); longest-
expected-first + greedy backfill; 429 cooldowns with max-until coalescing;
E7 ordered mint bundles (block_replaced first, dispositions after) for
instrument replacement with shared-reserve ordinals; absolute-total budget
snapshots with the never-resurrects pin and replacement_suppressed
shortfall; closed-window contention resolution batch in frozen order with
counts before admission-resumed; wave + block-terminal snapshot verify and
the full D-11 drift sequence (kill+abort affected, authorized repair,
clean re-verify, rerun re-entry); D-13 storage-pause detection at both
sites (journal append, sidecar append) driving performStoragePause;
dead-sampler/breach/spawn-failure halts with spawn-failure slot release +
typed terminals; pinned signal order (stop -> kill+verify -> aborted ->
resumable) and the D-12 live-cancel branch (campaign_cancelled LAST)."
```

---

### Task 9: recovery, cancellation, CLI + lock threading, D4 handoff

**Files:**
- Create: `src/campaign/recovery.ts`
- Modify: `src/cli/campaign.ts` + `src/cli/index.ts` (`quorum campaign register | run | cancel`)
- Modify: `src/run-all/index.ts` (live-spend-lock acquisition — no other behavior change)
- Modify: `src/cli/run-command.ts` (live-spend-lock acquisition for direct `quorum run`)
- Modify: `src/campaign/dispatcher.ts` (`resolveClosedWindow` rebuilt over the shared `contentionResolutionBatch` — dispatch and recovery stay on one resolution order)
- Test: create `test/campaign-recovery.test.ts`, `test/campaign-cancel.test.ts`, `test/campaign-cli-verbs.test.ts`, `test/campaign-lock-threading.test.ts`

**Interfaces:**
- Consumes: `resolveCrashWindows`, `type CampaignUniverse` from `src/contracts/campaign/crash-windows.ts` (Task 1 E7 rewrite); `electWriter`, `openJournalRead`, `verifyBallast`, `type JournalWriter`, `type EventInput` from `src/campaign/journal.ts` (Task 3); `reconstructCampaignSnapshot`, `verifyCampaignSnapshot`, `repairDriftedTrees` from `src/campaign/snapshot.ts` (Task 4); `runCampaignDispatch`, `realSamplerSeam`, `type DispatchOutcome` from `src/campaign/dispatcher.ts` (Task 8); `acquireLiveSpendLock`, `defaultLiveSpendLockPath`, `readLiveSpendHolder`, `realProcessIdentityProbe`, `type ProcessIdentityProbe` from `src/campaign/locks.ts` (Task 2); `preflightResourceFloors`, `assertFingerprintMatch`, `probeFingerprint`, `DEFAULT_RESOURCE_FLOORS`, `clockNowMs`, `linuxHostStatsProbe` from `src/campaign/host-stats.ts`; `registerCampaign`, `type RegisterArgs` from `src/campaign/registration.ts` (Task 5); `type Campaign`, `type CampaignIdentity` from `src/contracts/campaign/campaign.ts`; `EstimatesArtifactSchema` from `src/contracts/estimates.ts`; `executeRunCommand` from `src/cli/run-command.ts`; `runBatch` from `src/run-all/index.ts`; `RealClock` from `src/scheduler/clock.ts`; `defaultCommandRunner` from `src/agents/command-runner.ts`.
- Produces:
  - `export class RecoveryError extends Error`
  - `export function killJournaledPgids(args: { events: readonly JournalEvent[]; inspectGroup?: (pgid: number) => 'ok' | 'failed'; kill?: (pgid: number, signal: NodeJS.Signals) => void; stream?: { write(s: string): void } }): { killed: number[]; reclaimedWithoutKill: number[] }` — R-RCV-1 identity-guarded kill of every journaled pgid without a journaled terminal; a failed sanity check is recorded reclaimed-without-kill, never signaled blind
  - `export interface RecoveryPlan { readonly kills: { attempt_id: string; pgid: number }[]; readonly dispositionCompletions: { block_id: string; sample_id: string; superseded_by: string }[]; readonly successorReadmissions: { block_id: string; rerun_of?: string }[] }`; `export function planRecovery(args: { universe: CampaignUniverse; events: readonly JournalEvent[] }): RecoveryPlan` — R-RCV-2/R-RCV-5: superseded predecessors suppressed; missing roster dispositions completed; minted-unadmitted successors re-admitted as themselves (the mint's reserve/budget decision is durable, never re-evaluated into a zero-witness suppression)
  - `export function terminalEvidenceActions(args: { events: readonly JournalEvent[]; verdictOf: (runId: string) => { final: string } | null }): { terminals: EventInput[]; rerunBlockIds: string[] }` — Decision D-13 terminal-evidence rule
  - `export function quarantineActions(args: { runDirIdentities: { runId: string; identity: CampaignIdentity }[]; events: readonly JournalEvent[]; campaignId: string }): EventInput[]` — R-RCV-3 `quarantined` events
  - `export function rederiveContentionSuffix(args: { events: readonly JournalEvent[]; sidecarLines: readonly SidecarLine[]; campaign: Campaign }): EventInput[]` — interrupted closed-window batches: landed mints authoritative, only the missing ordered suffix re-derived
  - `export interface ResumeArgs` (below); `export function resumeCampaign(args: ResumeArgs): Promise<DispatchOutcome>` — R-RCV-7 pinned resume order (the sole production caller of `runCampaignDispatch`; it passes the reconstructed snapshot handle, `repairDriftedTrees` as the drift-repair seam, and `realSamplerSeam` — `performStoragePause` lives in the dispatcher, Task 8)
  - `export function cancelCampaign(args: { campaignDir: string; reason?: string; clock: Clock; identity: ProcessIdentityProbe; lockPath?: string; stream?: { write(s: string): void } }): { cancelled: boolean; postCrash: boolean }` — Decision D-12 pinned order, both paths
  - CLI: `campaignRegister(opts)`, `campaignRun(opts)`, `campaignCancel(opts)` in `src/cli/campaign.ts`; verbs registered in `src/cli/index.ts` per the pinned option table

Task 9 runs as three executable sub-tasks (9a → 9b → 9c); each has its own failing-tests-first cycle, verify command, and commit.

#### Task 9a: recovery cores + the shared contention batch (Steps 1–4; covers R-RCV-1/2/3/4/5, the contention-mint recovery amendment, and the dispatcher's `resolveClosedWindow` refactor onto the shared batch)

**Files:** create `src/campaign/recovery.ts` (reconciliation cores through `rederiveContentionSuffix`); modify `src/campaign/dispatcher.ts` (`contentionResolutionBatch` + the `resolveClosedWindow` rebuild); create `test/campaign-recovery.test.ts`.

- [ ] **Step 1: Write the failing recovery tests** — create `test/campaign-recovery.test.ts` (reuse the Task 8 `campaignDoc`/journal fixture style — copy the builders):

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/scheduler/clock.ts';
import { electWriter, initJournalDb, type EventInput } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { CampaignUniverse } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';
import {
  killJournaledPgids,
  planRecovery,
  quarantineActions,
  readRunDirIdentities,
  terminalEvidenceActions,
} from '../src/campaign/recovery.ts';

const IDENTITY: ProcessIdentityProbe = { exists: () => 'alive', startTimeMs: () => 1 };
const UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'] }],
};

let SEQ = 0;
function ev(type: JournalEvent['type'], payload: unknown): JournalEvent {
  SEQ += 1;
  return { seq: SEQ, ts_ms: SEQ * 1000, type, payload } as JournalEvent;
}

test('killJournaledPgids: kills every journaled pgid without a terminal; identity-guarded', () => {
  const events = [
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 111, key_grants: [] }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', { attempt_id: 'a2', run_id: 'r2', pgid: 222, key_grants: [] }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }), // a2 terminaled
  ];
  const killed: number[] = [];
  const report = killJournaledPgids({
    events,
    inspectGroup: () => 'ok',
    kill: (pgid) => killed.push(pgid),
  });
  expect(report.killed).toEqual([111]); // only the non-terminal attempt
  expect(killed).toEqual([111]);
  // A failed sanity check: recorded reclaimed-without-kill, never signaled.
  const loud: string[] = [];
  const guarded = killJournaledPgids({
    events,
    inspectGroup: (pgid) => (pgid === 111 ? 'failed' : 'ok'),
    kill: (pgid) => killed.push(pgid),
    stream: { write: (s) => loud.push(s) },
  });
  expect(guarded.reclaimedWithoutKill).toEqual([111]);
  expect(loud.join('')).toMatch(/reclaimed-without-kill/);
});

test('planRecovery: superseded predecessor gets no action; missing dispositions completed; minted successor re-admitted as itself', () => {
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 111, key_grants: [] }),
    ev('instrument_failure', { attempt_id: 'a1', cause: 'grader_crashed' }),
    // Mint landed, then crash: s2's disposition never journaled, successor never admitted.
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
  ];
  const universe: CampaignUniverse = {
    samples: [
      { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
      { sample_id: 'x1s1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 'x1s2', arm: 'treat', cell: 'c1:scn' },
    ],
    blocks: [
      { block_id: 'b1', sample_ids: ['s1', 's2'] },
      { block_id: 'x1', sample_ids: ['x1s1', 'x1s2'], slot: 'reserve' },
    ],
  };
  const plan = planRecovery({ universe, events });
  // The superseded predecessor's attempt gets NO readmit/rerun action.
  expect(plan.kills.map((k) => k.attempt_id)).toEqual([]);
  // s2 was admitted at mint time -> its disposition is completed from the roster.
  expect(plan.dispositionCompletions).toEqual([
    { block_id: 'x1', sample_id: 's2', superseded_by: 'x1s2' },
  ]);
  // The minted-but-unadmitted successor admits as THAT successor.
  expect(plan.successorReadmissions).toEqual([{ block_id: 'x1' }]);
});

test('terminal-evidence rule: a complete verdict journals terminal; a missing run dir re-enters via rerun', () => {
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 111, key_grants: [] }),
  ];
  const withVerdict = terminalEvidenceActions({
    events,
    verdictOf: (runId) => (runId === 'r1' ? { final: 'pass' } : null),
  });
  expect(withVerdict.terminals).toEqual([
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
  ]);
  const withoutRunDir = terminalEvidenceActions({ events, verdictOf: () => null });
  expect(withoutRunDir.terminals).toEqual([]);
  expect(withoutRunDir.rerunBlockIds).toEqual(['b1']);
});

test('quarantine by attempt-id / campaign mismatch from the persisted identity', () => {
  const events = [
    ev('run_allocated', { attempt_id: 'a1', run_id: 'r1', pgid: 1, key_grants: [] }),
  ];
  const actions = quarantineActions({
    runDirIdentities: [
      { runId: 'r1', identity: { campaign_id: 'OTHER', comparison_id: 'c1', block_id: 'b', sample_id: 's', execution_attempt_id: 'a1' } },
      { runId: 'r2', identity: { campaign_id: 'c'.repeat(64), comparison_id: 'c1', block_id: 'b', sample_id: 's', execution_attempt_id: 'aX' } },
    ],
    events,
    campaignId: 'c'.repeat(64),
  });
  expect(actions).toEqual([
    { type: 'quarantined', payload: { run_id: 'r1', attempt_id: 'a1', reason: 'campaign_mismatch' } },
    { type: 'quarantined', payload: { run_id: 'r2', reason: 'late_terminal' } },
  ]);
});
test('readRunDirIdentities: scans run dirs for persisted identities; non-campaign dirs are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  mkdirSync(join(root, 'run-a'), { recursive: true });
  writeFileSync(
    join(root, 'run-a', 'campaign-identity.json'),
    JSON.stringify({ campaign_id: 'c'.repeat(64), comparison_id: 'c1', block_id: 'b1', sample_id: 's1', execution_attempt_id: 'a1' }),
  );
  mkdirSync(join(root, 'run-b'), { recursive: true }); // no identity file: not campaign evidence
  const found = readRunDirIdentities(root);
  expect(found).toHaveLength(1);
  expect(found[0]!.runId).toBe('run-a');
  expect(found[0]!.identity.execution_attempt_id).toBe('a1');
  expect(readRunDirIdentities(join(root, 'missing'))).toEqual([]);
});

```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-recovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/campaign/recovery.ts`**

```ts
// Recovery (kernel D3, R-RCV-1..7; Decisions D-12/D-13): kill journaled
// pgids FIRST (identity-guarded), reconcile journal vs run dirs, complete
// partial mint bundles BEFORE resolver actions, rerun whole blocks via E7,
// quarantine by attempt-id mismatch, execute the crash windows, cross-check
// the reconstructed handle against Campaign.refs, reconcile ENOSPC, and
// honor cancel-request precedence — in the pinned resume order.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../scheduler/clock.ts';
import { RealClock } from '../scheduler/clock.ts';
import {
  assertFingerprintMatch,
  clockNowMs,
  DEFAULT_RESOURCE_FLOORS,
  linuxHostStatsProbe,
  preflightResourceFloors,
  probeFingerprint,
  type HostStatsProbe,
} from './host-stats.ts';
import {
  acquireLiveSpendLock,
  readLiveSpendHolder,
  realProcessIdentityProbe,
  type LiveSpendLock,
  type ProcessIdentityProbe,
} from './locks.ts';
import {
  electWriter,
  isStorageFullError,
  openJournalRead,
  verifyBallast,
  DEFAULT_BALLAST_BYTES,
  type EventInput,
  type JournalWriter,
} from './journal.ts';
import { replayEvents } from './journal.ts';
import { reconstructCampaignSnapshot, repairDriftedTrees, verifyCampaignSnapshot } from './snapshot.ts';
import {
  contentionResolutionBatch,
  nextRerunInstanceId,
  realSamplerSeam,
  runCampaignDispatch,
  type DispatchOutcome,
} from './dispatcher.ts';
import { parseSidecar, evaluateContention, type ResolvedThreshold, type BlockInterval } from './contention.ts';
import {
  resolveCrashWindows,
  type CampaignUniverse,
} from '../contracts/campaign/crash-windows.ts';
import {
  type JournalEvent,
  normalizeBlockReplaced,
} from '../contracts/campaign/journal-events.ts';
import type { Campaign, CampaignIdentity } from '../contracts/campaign/campaign.ts';

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

/** R-RCV-1: on crash restart, kill every journaled pgid of an attempt
 *  WITHOUT a journaled terminal before any re-admission — an orphaned child
 *  keeps spending and races its replacement (no double spend). Guard: kill
 *  only groups whose sanity check passes; a failed check is recorded
 *  reclaimed-without-kill (loud), never signaled blind. */
export function killJournaledPgids(args: {
  events: readonly JournalEvent[];
  inspectGroup?: (pgid: number) => 'ok' | 'failed';
  kill?: (pgid: number, signal: NodeJS.Signals) => void;
  stream?: { write(s: string): void };
}): { killed: number[]; reclaimedWithoutKill: number[] } {
  const stream = args.stream ?? { write: (s: string) => process.stderr.write(s) };
  const inspect =
    args.inspectGroup ??
    ((pgid: number) => {
      try {
        process.kill(-pgid, 0);
        return 'ok';
      } catch {
        return 'failed';
      }
    });
  const kill =
    args.kill ??
    ((pgid: number, signal: NodeJS.Signals) => {
      try {
        process.kill(-pgid, signal);
      } catch {
        // already gone
      }
    });
  const terminalAttempts = new Set<string>();
  for (const event of args.events) {
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      terminalAttempts.add(event.payload.attempt_id);
    }
  }
  const killed: number[] = [];
  const reclaimedWithoutKill: number[] = [];
  for (const event of args.events) {
    if (event.type !== 'run_allocated') continue;
    if (terminalAttempts.has(event.payload.attempt_id)) continue;
    const pgid = event.payload.pgid;
    if (inspect(pgid) === 'ok') {
      kill(pgid, 'SIGTERM');
      killed.push(pgid);
    } else {
      reclaimedWithoutKill.push(pgid);
      stream.write(
        `reclaimed-without-kill: pgid ${pgid} (attempt ${event.payload.attempt_id}) failed the sanity check — recorded, never signaled blind\n`,
      );
    }
  }
  return { killed, reclaimedWithoutKill };
}

export interface RecoveryPlan {
  readonly kills: { attempt_id: string; pgid: number }[];
  readonly dispositionCompletions: { block_id: string; sample_id: string; superseded_by: string }[];
  readonly successorReadmissions: { block_id: string; rerun_of?: string }[];
}

/** R-RCV-2 / R-RCV-5 with the Round-4 S-2 mint override: fold every
 *  block_replaced BEFORE applying resolver actions. A named predecessor is
 *  superseded and receives no readmit/rerun action; recovery completes the
 *  missing roster dispositions from the mint's pre-mint states, then
 *  continues from the already-minted successor. A minted-but-unadmitted
 *  successor is admitted AS THAT successor — the mint's reserve/budget
 *  decision is already durable and never re-evaluated into a zero-witness
 *  suppression. */
export function planRecovery(args: {
  universe: CampaignUniverse;
  events: readonly JournalEvent[];
}): RecoveryPlan {
  const { universe, events } = args;
  const report = resolveCrashWindows(universe, events); // override baked in (task 1)
  const kills = report.attempts
    .filter((a) => a.resolution === 'kill_pgid_rerun_block' && a.pgid !== undefined)
    .map((a) => ({ attempt_id: a.attempt_id, pgid: a.pgid! }));

  const dispositionCompletions: RecoveryPlan['dispositionCompletions'] = [];
  const successorReadmissions: RecoveryPlan['successorReadmissions'] = [];
  const admittedBlocks = new Set<string>();
  for (const event of events) {
    if (event.type === 'block_admitted') admittedBlocks.add(event.payload.block_id);
  }
  const journaledDispositions = new Set<string>();
  for (const event of events) {
    if (event.type === 'sample_disposition' && event.payload.disposition === 'excluded_block_replaced') {
      journaledDispositions.add(event.payload.sample_id);
    }
  }
  for (const event of events) {
    if (event.type !== 'block_replaced') continue;
    const rec = normalizeBlockReplaced(event.payload);
    // Pre-mint states for the roster's supersedes pairs.
    const preState = replayEvents(universe, events.filter((e) => e.seq < event.seq));
    for (const entry of rec.roster) {
      if (entry.supersedes === undefined) continue;
      if (journaledDispositions.has(entry.supersedes)) continue;
      const state = preState.sampleStates.get(entry.supersedes);
      if (
        state === 'admitted' ||
        state === 'spawned' ||
        state === 'exposed' ||
        state === 'completed'
      ) {
        dispositionCompletions.push({
          block_id: rec.replacement_block_id,
          sample_id: entry.supersedes,
          superseded_by: entry.sample_id,
        });
      }
    }
    if (!admittedBlocks.has(rec.replacement_block_id)) {
      successorReadmissions.push(
        rec.kind === 'rerun'
          ? { block_id: rec.replacement_block_id, rerun_of: rec.block_id }
          : { block_id: rec.replacement_block_id },
      );
    }
  }
  return { kills, dispositionCompletions, successorReadmissions };
}

/** Decision D-13 terminal-evidence rule: every journaled non-terminal
 *  attempt whose run dir holds a complete verdict is journaled terminal from
 *  the evidence (outcome-derived, loud); every journaled attempt with no run
 *  dir at all re-enters via E7 rerun. */
export function terminalEvidenceActions(args: {
  events: readonly JournalEvent[];
  verdictOf: (runId: string) => { final: string } | null;
}): { terminals: EventInput[]; terminalAttemptIds: string[]; rerunBlockIds: string[] } {
  const terminalAttempts = new Set<string>();
  for (const event of args.events) {
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      terminalAttempts.add(event.payload.attempt_id);
    }
  }
  const attemptBlock = new Map<string, string>();
  let currentBlock = '';
  for (const event of args.events) {
    if (event.type === 'block_admitted') currentBlock = event.payload.block_id;
    if (event.type === 'attempt_created') attemptBlock.set(event.payload.attempt_id, currentBlock);
  }
  const terminals: EventInput[] = [];
  const terminalAttemptIds: string[] = [];
  const rerunBlockIds: string[] = [];
  for (const event of args.events) {
    if (event.type !== 'run_allocated') continue;
    if (terminalAttempts.has(event.payload.attempt_id)) continue;
    const verdict = args.verdictOf(event.payload.run_id);
    if (verdict !== null) {
      terminals.push({
        type: 'run_completed',
        payload: { attempt_id: event.payload.attempt_id, outcome: verdict.final },
      });
      terminalAttemptIds.push(event.payload.attempt_id);
    } else {
      const blockId = attemptBlock.get(event.payload.attempt_id);
      if (blockId !== undefined && !rerunBlockIds.includes(blockId)) {
        rerunBlockIds.push(blockId);
      }
    }
  }
  return { terminals, terminalAttemptIds, rerunBlockIds };
}

/** R-RCV-3: quarantine by identity mismatch against the run dir's persisted
 *  campaign identity (Decision D-8) — never a filesystem move. */
export function quarantineActions(args: {
  runDirIdentities: { runId: string; identity: CampaignIdentity }[];
  events: readonly JournalEvent[];
  campaignId: string;
}): EventInput[] {
  const allocatedByRun = new Map<string, string>(); // run_id -> attempt_id
  for (const event of args.events) {
    if (event.type === 'run_allocated') {
      allocatedByRun.set(event.payload.run_id, event.payload.attempt_id);
    }
  }
  const actions: EventInput[] = [];
  for (const { runId, identity } of args.runDirIdentities) {
    if (identity.campaign_id !== args.campaignId) {
      const attemptId = allocatedByRun.get(runId);
      actions.push({
        type: 'quarantined',
        payload: {
          run_id: runId,
          ...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
          reason: 'campaign_mismatch',
        },
      });
      continue;
    }
    const attemptId = allocatedByRun.get(runId);
    if (attemptId === undefined) {
      actions.push({ type: 'quarantined', payload: { run_id: runId, reason: 'late_terminal' } });
      continue;
    }
    if (attemptId !== identity.execution_attempt_id) {
      actions.push({
        type: 'quarantined',
        payload: { run_id: runId, attempt_id: attemptId, reason: 'attempt_mismatch' },
      });
    }
  }
  return actions;
}

/** Scan a results root for run dirs carrying a persisted campaign identity
 *  (`<runDir>/campaign-identity.json`, written at run-dir allocation — task
 *  6c; it is what makes R-RCV-3's mismatch detectable at all). Dirs without
 *  a readable identity file are skipped: a non-campaign run dir is not
 *  campaign evidence. resumeCampaign feeds the result to quarantineActions. */
export function readRunDirIdentities(
  resultsRoot: string,
): { runId: string; identity: CampaignIdentity }[] {
  if (!existsSync(resultsRoot)) return [];
  const out: { runId: string; identity: CampaignIdentity }[] = [];
  for (const entry of readdirSync(resultsRoot)) {
    try {
      const identity = JSON.parse(
        readFileSync(join(resultsRoot, entry, 'campaign-identity.json'), 'utf8'),
      ) as CampaignIdentity;
      out.push({ runId: entry, identity });
    } catch {
      // absent or unreadable identity: skip (not campaign evidence)
    }
  }
  return out;
}

/** Interrupted closed-window contention batches (ratified OQ-11): landed
 *  reason=contention mints stay authoritative; re-derive ONLY the missing
 *  ordered suffix from the durable sidecar under one writer critical
 *  section. Sidecar loss never reverses the landed prefix. */
export function rederiveContentionSuffix(args: {
  events: readonly JournalEvent[];
  sidecarLines: readonly import('./contention.ts').SidecarLine[];
  campaign: Campaign;
}): EventInput[] {
  const { events, sidecarLines, campaign } = args;
  // Fold landed contention mints + cell resolutions: authoritative, never
  // re-derived or duplicated.
  const landedBlocks = new Set<string>();
  const resolvedCells = new Set<string>();
  let budgetStopped = false;
  for (const event of events) {
    if (event.type === 'block_replaced') {
      const rec = normalizeBlockReplaced(event.payload);
      if (rec.reason === 'contention') landedBlocks.add(rec.block_id);
    }
    if (event.type === 'adjudication') resolvedCells.add(event.payload.cell);
    if (event.type === 'budget_stopped') budgetStopped = true;
  }
  // Reconstruct conservative block intervals from the journal
  // (earliest attempt_created -> latest terminal), keyed by block.
  const startTs = new Map<string, number>();
  const endTs = new Map<string, number>();
  const blockOfAttempt = new Map<string, string>();
  let currentBlock = '';
  for (const event of events) {
    if (event.type === 'block_admitted') currentBlock = event.payload.block_id;
    if (event.type === 'attempt_created') blockOfAttempt.set(event.payload.attempt_id, currentBlock);
    if (event.type === 'attempt_created') {
      const blockId = blockOfAttempt.get(event.payload.attempt_id) ?? currentBlock;
      const prev = startTs.get(blockId);
      if (prev === undefined || event.ts_ms < prev) startTs.set(blockId, event.ts_ms);
    }
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      const blockId = blockOfAttempt.get(event.payload.attempt_id);
      if (blockId !== undefined) {
        const prev = endTs.get(blockId);
        if (prev === undefined || event.ts_ms > prev) endTs.set(blockId, event.ts_ms);
      }
    }
  }
  const sampleCellOf = (sampleId: string): string =>
    campaign.samples.find((s) => s.sample_id === sampleId)?.cell ?? '';
  const intervals: BlockInterval[] = [...startTs.entries()].map(([blockId, start]) => ({
    block_id: blockId,
    startTsMs: start,
    endTsMs: endTs.get(blockId) ?? null,
  }));
  // One pure evaluator (task 7): tri-state over the durable sidecar.
  const opened = events.find((e) => e.type === 'campaign_opened');
  const lastTerminal = events.reduce((m, e) => Math.max(m, e.ts_ms), 0);
  const thresholds: ResolvedThreshold[] = campaign.contention.thresholds.map((t) => ({
    metric: t.metric,
    op: t.op,
    value: t.value,
  }));
  const verdicts = evaluateContention({
    lines: sidecarLines,
    thresholds,
    sustainK: campaign.contention.sustain_k,
    cadenceMs: campaign.contention.cadence_ms,
    coverageN: campaign.contention.coverage_n,
    campaignOpenedTsMs: opened?.ts_ms ?? 0,
    lastTerminalTsMs: lastTerminal,
    blocks: intervals,
  });
  // Obligations = invalid blocks not already landed, in the SAME frozen
  // comparison/cell/replicate order dispatch uses.
  const obligations = campaign.blocks
    .filter((b) => verdicts.get(b.block_id) === 'invalid' && !landedBlocks.has(b.block_id))
    .map((b) => b.block_id);
  const reserveActivated = new Set<string>();
  for (const event of events) {
    if (event.type === 'block_replaced' && event.payload.reserve_activation) {
      reserveActivated.add(event.payload.replacement_block_id);
    }
  }
  const reserveBlocks = campaign.blocks.filter((b) => b.slot === 'reserve');
  const reserveFor = (cellKey: string): string | undefined =>
    reserveBlocks.find(
      (b) => b.block_id.startsWith(`${cellKey}:x`) && !reserveActivated.has(b.block_id),
    )?.block_id;
  // E7.1 disposition-source filter, journal-derived: a predecessor already
  // instrument_failed or skew_excluded keeps that terminal fact.
  const attemptToSample = new Map<string, string>();
  const factBySample = new Map<string, 'instrument_failed' | 'skew_excluded'>();
  for (const event of events) {
    if (event.type === 'attempt_created') {
      attemptToSample.set(event.payload.attempt_id, event.payload.sample_id);
    } else if (event.type === 'instrument_failure') {
      const s = attemptToSample.get(event.payload.attempt_id);
      if (s !== undefined) factBySample.set(s, 'instrument_failed');
    } else if (event.type === 'skew_excluded') {
      const roster = campaign.blocks.find((b) => b.block_id === event.payload.block_id)?.sample_ids ?? [];
      for (const s of roster) factBySample.set(s, 'skew_excluded');
    }
  }
  // No budgetGate: the durable stop state was read from the journal above;
  // a fresh stop fires at the first post-resume admission (R-DSP-6).
  return contentionResolutionBatch({
    obligations,
    budgetStopped,
    cellOf: (blockId) => {
      const sample = campaign.blocks.find((b) => b.block_id === blockId)?.sample_ids[0];
      return sample !== undefined ? sampleCellOf(sample) : '';
    },
    reserveFor,
    resolvedCells,
    armBySample: new Map(campaign.samples.map((s) => [s.sample_id, s.arm])),
    blockSamples: new Map(campaign.blocks.map((b) => [b.block_id, b.sample_ids])),
    predecessorTerminalFact: (sampleId) => factBySample.get(sampleId) ?? null,
  }).batch;
}
```

This task also modifies `src/campaign/dispatcher.ts` (Task 8's file) to factor the resolution batch into the shared pure function both call — **one implementation, one obligation order**:

```ts
/** The closed-window resolution batch (dispatch and recovery share this —
 *  one obligation order, one per-obligation resolution). Emits, in the given
 *  obligation order: replacement_suppressed (durable budget stop wins), else
 *  a reason=contention replacement mint + roster dispositions, else
 *  reserve_exhausted. Skips obligations whose cell already carries a
 *  resolution (idempotent re-entry). Returns the batch plus the summary the
 *  dispatcher's bookkeeping and resolution line consume. */
export interface ContentionResolutionResult {
  readonly batch: EventInput[];
  /** predecessor -> activated reserve block id, in obligation order. */
  readonly activated: readonly { predecessor: string; reserve: string }[];
  readonly suppressedCells: readonly string[];
  readonly exhaustedCells: readonly string[];
}
export function contentionResolutionBatch(args: {
  obligations: readonly string[];
  budgetStopped: boolean;
  cellOf: (blockId: string) => string;
  reserveFor: (cellKey: string) => string | undefined;
  resolvedCells: ReadonlySet<string>;
  armBySample: ReadonlyMap<string, string>;
  blockSamples: ReadonlyMap<string, readonly string[]>;
  /** R-DSP-6 pass-through for resolution-time mints (live dispatch only):
   *  called with the reserve about to activate; a non-null return is the
   *  durable-stop bundle (budget_stopped + superseding snapshot) — it is
   *  appended and this and every later obligation suppresses. Recovery
   *  passes undefined: the durable stop state is already in the journal it
   *  read, and a would-be new stop fires at the first post-resume admission
   *  through the same predicate. */
  budgetGate?: (reserveBlockId: string) => EventInput[] | null;
  /** E7.1 disposition-source filter: a predecessor already
   *  instrument_failed or skew_excluded keeps that terminal fact and never
   *  receives excluded_block_replaced (replay rejects it from those states,
   *  R-JRN-7). The dispatcher passes its live fact map; recovery passes a
   *  journal-derived lookup. */
  predecessorTerminalFact: (sampleId: string) => 'instrument_failed' | 'skew_excluded' | null;
}): ContentionResolutionResult {
  const batch: EventInput[] = [];
  const activated: { predecessor: string; reserve: string }[] = [];
  const suppressedCells: string[] = [];
  const exhaustedCells: string[] = [];
  let stopped = args.budgetStopped;
  for (const blockId of args.obligations) {
    const cellKey = args.cellOf(blockId);
    if (args.resolvedCells.has(cellKey)) continue; // already resolved: skip
    const reserve = stopped ? undefined : args.reserveFor(cellKey);
    if (!stopped && reserve !== undefined && args.budgetGate !== undefined) {
      const stopBundle = args.budgetGate(reserve);
      if (stopBundle !== null) {
        batch.push(...stopBundle);
        stopped = true;
      }
    }
    if (stopped) {
      batch.push({
        type: 'adjudication',
        payload: { cell: cellKey, disposition: 'replacement_suppressed', rationale: 'budget_stopped' },
      });
      suppressedCells.push(cellKey);
      continue;
    }
    if (reserve === undefined) {
      batch.push({
        type: 'adjudication',
        payload: { cell: cellKey, disposition: 'reserve_exhausted', rationale: 'reserve_exhausted' },
      });
      exhaustedCells.push(cellKey);
      continue;
    }
    const predSamples = args.blockSamples.get(blockId) ?? [];
    const resSamples = args.blockSamples.get(reserve) ?? [];
    const roster = resSamples.map((sampleId) => {
      const arm = args.armBySample.get(sampleId) ?? '';
      const predecessor = predSamples.find((s) => args.armBySample.get(s) === arm);
      return { sample_id: sampleId, arm, ...(predecessor !== undefined ? { supersedes: predecessor } : {}) };
    });
    batch.push({
      type: 'block_replaced',
      payload: {
        block_id: blockId,
        replacement_block_id: reserve,
        reason: 'contention',
        kind: 'replacement',
        reserve_activation: true,
        roster,
      },
    });
    for (const entry of roster) {
      if (entry.supersedes === undefined) continue;
      const fact = args.predecessorTerminalFact(entry.supersedes);
      if (fact !== null) continue; // keeps its terminal fact (E7.1 legal-source rule)
      batch.push({
        type: 'sample_disposition',
        payload: {
          sample_id: entry.supersedes,
          disposition: 'excluded_block_replaced',
          superseded_by: entry.sample_id,
        },
      });
    }
    activated.push({ predecessor: blockId, reserve });
  }
  return { batch, activated, suppressedCells, exhaustedCells };
}
```

Task 8's `resolveClosedWindow` is rebuilt in this task over the shared function — its inline per-obligation loop (everything between the `invalid` sort and `appendCritical(batch)`) is REPLACED by:

```ts
    // One implementation, one obligation order (shared with recovery's
    // rederiveContentionSuffix): the R-DSP-6 gate rides budgetGate.
    const result = contentionResolutionBatch({
      obligations: invalid.map((lb) => lb.block.block_id),
      budgetStopped,
      cellOf: cellKeyOfBlock,
      reserveFor: (cellKey) => reserveForCell(cellKey)?.block_id,
      resolvedCells: new Set<string>(),
      armBySample,
      blockSamples: new Map(campaign.blocks.map((b) => [b.block_id, b.sample_ids])),
      predecessorTerminalFact: (sampleId) => {
        const fact = terminalFactBySample.get(sampleId);
        return fact === 'instrument_failed' || fact === 'skew_excluded' ? fact : null;
      },
      budgetGate: (reserveBlockId) => {
        const reserve = reserveBlocks.find((b) => b.block_id === reserveBlockId);
        const reserveExposure = (reserve?.sample_ids ?? []).reduce(
          (sum, s) => sum + sampleEstimate(s),
          0,
        );
        if (spendUsd + Math.max(estimateUsd, 0) + reserveExposure > budgetUsd) {
          budgetStopped = true;
          return [
            { type: 'budget_stopped', payload: { sample_ids: [...waiting.flatMap((b) => b.sample_ids)] } },
            snapshotEstimateInput(),
          ];
        }
        return null;
      },
    });
    for (const { predecessor, reserve } of result.activated) {
      const reserveBlock = reserveBlocks.find((b) => b.block_id === reserve);
      if (reserveBlock !== undefined) {
        reserveActivated.add(reserveBlock.block_id);
        supersededBlockIds.add(predecessor);
        waiting.push(reserveBlock);
      }
    }
    appendCritical(result.batch);
    // Resolution counts BEFORE the separate admission-resumed line (D-3).
    stream.write(
      `contention resolution: affected=${invalid.length} refilled=${result.activated.length} exhausted=${result.exhaustedCells.length} suppressed=${result.suppressedCells.length}\n`,
    );
    stream.write('admission resumed\n');
    wakeLoop(); // minted reserves are admission candidates now
```

(The Task 8 tests keep passing unchanged: same events in the same order, same resolution line.)

- [ ] **Step 4: Run tests to verify they pass + commit (task 9a)**

Run: `bun test test/campaign-recovery.test.ts test/campaign-dispatcher.test.ts`
Expected: PASS (5 recovery tests; the 13 dispatcher tests stay green over the shared batch).

```bash
git add src/campaign/recovery.ts src/campaign/dispatcher.ts test/campaign-recovery.test.ts
git commit -m "feat(campaign): D3 recovery cores — identity-guarded kill, mint folding, shared contention batch"
```

#### Task 9b: resume + cancellation (Steps 5–8; covers R-RCV-6/R-RCV-7's pinned resume order and Decision D-12's pinned cancel order, both paths)

**Files:** modify `src/campaign/recovery.ts` (append `ResumeArgs`/`resumeCampaign`/`cancelCampaign`); create `test/campaign-cancel.test.ts`.

- [ ] **Step 5: Write the failing cancellation tests** — create `test/campaign-cancel.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/scheduler/clock.ts';
import { electWriter, initJournalDb } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import { cancelCampaign, resumeCampaign } from '../src/campaign/recovery.ts';

const IDENTITY: ProcessIdentityProbe = { exists: () => 'esrch', startTimeMs: () => null };

function publishedCampaign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-'));
  // Minimal published layout: campaign.json (with the block/sample universe
  // the in-flight derivation and planRecovery read) + journal.
  const doc = {
    digest: 'd'.repeat(64),
    campaign_id: 'd'.repeat(64),
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1'] }],
    samples: [{ sample_id: 's1', cell: 'c1:scn', arm: 'a', replicate: 1 }],
    contention: { host_fingerprint: { cpu_model: 't', cpu_cores: 1, mem_bytes: 1, disk_total_bytes: 1 }, global_run_cap: 1, thresholds: [{ metric: 'load1', source: 'host', op: 'gt', value: 1 }], cadence_ms: 1000, sustain_k: 1, coverage_n: 1, mem_tolerance_pct: 1, disk_tolerance_pct: 1 },
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  initJournalDb(dir);
  const w = electWriter({ campaignDir: dir, clock: new FakeClock(0), identity: { exists: () => 'alive', startTimeMs: () => 1 } });
  w.appendEvent({ type: 'campaign_opened', payload: { campaign_id: doc.campaign_id, digest: doc.digest } });
  w.appendEvent({ type: 'block_admitted', payload: { block_id: 'b1', pools: ['p'] } });
  w.appendEvent({ type: 'attempt_created', payload: { sample_id: 's1', attempt_id: 'a1' } });
  w.appendEvent({ type: 'run_allocated', payload: { attempt_id: 'a1', run_id: 'r1', pgid: 999999999, key_grants: [] } });
  w.release();
  return dir;
}

test('post-crash cancel: marker first, kill, aborted, campaign_cancelled LAST', () => {
  const dir = publishedCampaign();
  const result = cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: IDENTITY, // no live holder
    lockPath: join(mkdtempSync(join(tmpdir(), 'lock-')), 'live.lock.d'),
    stream: { write: () => {} },
  });
  expect(result.cancelled).toBe(true);
  expect(result.postCrash).toBe(true);
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
  const w = electWriter({ campaignDir: dir, clock: new FakeClock(2), identity: { exists: () => 'alive', startTimeMs: () => 1 } });
  const events = w.readEvents();
  w.release();
  const types = events.map((e) => e.type);
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // LAST
  expect(types).toContain('aborted');
  const cancelled = events[events.length - 1]!;
  expect(cancelled.payload.reason).toBe('operator test');
  // aborted precedes campaign_cancelled (pinned crash-consistency order).
  expect(types.indexOf('aborted')).toBeLessThan(types.indexOf('campaign_cancelled'));
});

test('post-crash cancel is idempotent against a partial live sequence: an already-aborted block is never re-aborted', () => {
  const dir = publishedCampaign();
  // The live dispatcher journaled aborted for b1 before dying mid-sequence.
  const w = electWriter({ campaignDir: dir, clock: new FakeClock(1), identity: { exists: () => 'alive', startTimeMs: () => 1 } });
  w.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } });
  w.release();
  cancelCampaign({
    campaignDir: dir,
    reason: 'finish the interrupted cancel',
    clock: new FakeClock(2),
    identity: IDENTITY,
    lockPath: join(mkdtempSync(join(tmpdir(), 'lock-')), 'l3.d'),
    stream: { write: () => {} },
  });
  const r = electWriter({ campaignDir: dir, clock: new FakeClock(3), identity: { exists: () => 'alive', startTimeMs: () => 1 } });
  const types = r.readEvents().map((e) => e.type);
  r.release();
  expect(types.filter((t) => t === 'aborted').length).toBe(1); // never duplicated
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // still LAST
});

test('resume refuses a cancelled campaign (cancel-request precedence)', async () => {
  const dir = publishedCampaign();
  cancelCampaign({ campaignDir: dir, clock: new FakeClock(1), identity: IDENTITY, lockPath: join(mkdtempSync(join(tmpdir(), 'lock-')), 'l.d'), stream: { write: () => {} } });
  const outcome = await resumeCampaign({
    campaignDir: dir,
    credentials: {},
    evalsCheckout: dir,
    gauntletCheckout: dir,
    superpowersCheckout: dir,
    clock: new FakeClock(2),
    identity: IDENTITY,
    lockPath: join(mkdtempSync(join(tmpdir(), 'lock-')), 'l2.d'),
    stream: { write: () => {} },
  });
  expect(outcome.status).toBe('cancelled');
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test test/campaign-cancel.test.ts`
Expected: FAIL — `resumeCampaign`/`cancelCampaign` not exported yet.

- [ ] **Step 7: Implement resume + cancel** — append to `src/campaign/recovery.ts`:

(The D-13 pause sequence itself — `performStoragePause` — is defined and exported by the dispatcher (Task 8), where both detection sites live; recovery only reconciles its aftermath: the `.storage-paused` marker, the retroactive `storage_paused` ordering, and the spent-ballast note below.)

```ts
export interface ResumeArgs {
  readonly campaignDir: string;
  readonly credentials: Readonly<Record<string, import('../contracts/credential.ts').Credential>>;
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
  /** Run-dir root (verdict/terminal-evidence reads + quarantine scan);
   *  default 'results' — the same root the dispatcher spawns into. */
  readonly resultsRoot?: string;
  readonly clock?: Clock;
  readonly identity?: ProcessIdentityProbe;
  readonly probe?: HostStatsProbe;
  readonly lockPath?: string;
  readonly spawner?: import('./spawn.ts').ChildSpawner;
  readonly stream?: { write(s: string): void };
}

/** R-RCV-7 pinned resume order: cancel-request FIRST -> live-spend lock ->
 *  kill/reconcile (identity-guarded; complete partial mint bundles before
 *  resolver actions; fold authoritative contention mints; re-derive
 *  interrupted batch suffixes) -> preflight (floors + fingerprint + key
 *  envs) -> reconstruct handle + refs cross-check + verifySnapshot -> admit.
 *  Every resume prints the one-line state banner. */
export async function resumeCampaign(args: ResumeArgs): Promise<DispatchOutcome> {
  const clock = args.clock ?? new RealClock();
  const identity = args.identity ?? realProcessIdentityProbe;
  const stream = args.stream ?? { write: (s: string) => process.stdout.write(s) };
  // campaign.json is read as-published: registration schema-validates and
  // digests the document BEFORE the publication rename, and the refs
  // cross-check below re-verifies identity — a second full parse here would
  // only re-litigate the frozen document.
  const campaign: Campaign = JSON.parse(
    readFileSync(join(args.campaignDir, 'campaign.json'), 'utf8'),
  );

  // 1. Cancel-request precedence (Decision D-12 I-10b).
  const cancelMarker = join(args.campaignDir, 'cancel-request');
  if (existsSync(cancelMarker)) {
    stream.write('cancel-request present — completing cancellation instead of resuming\n');
    const result = cancelCampaign({
      campaignDir: args.campaignDir,
      clock,
      identity,
      ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
      stream,
    });
    return { status: 'cancelled', reason: result.postCrash ? 'post-crash cancel completed' : 'live cancel completed' };
  }

  // 2. Acquire the live-spend lock (preflight runs at acquisition; recovery
  //    ordering: acquire -> kill/reconcile -> preflight -> admit).
  const lock = acquireLiveSpendLock({
    ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
    campaignId: campaign.campaign_id,
    clock,
    identity,
  });
  try {
    stream.write(`resume: live-spend lock acquired (campaign ${campaign.campaign_id.slice(0, 12)})\n`);

    // 3. Kill/reconcile FIRST — an orphaned child keeps spending while the
    //    floor is debated, so cleanup precedes the preflight gate.
    const writer = electWriter({ campaignDir: args.campaignDir, clock, identity, campaign });
    const events = writer.readEvents();
    const universe: CampaignUniverse = campaign;
    const killReport = killJournaledPgids({ events, stream });
    const plan = planRecovery({ universe, events });
    const resultsRoot = args.resultsRoot ?? 'results';
    const bundle: EventInput[] = [];
    for (const d of plan.dispositionCompletions) {
      bundle.push({
        type: 'sample_disposition',
        payload: {
          sample_id: d.sample_id,
          disposition: 'excluded_block_replaced',
          superseded_by: d.superseded_by,
        },
      });
    }
    // Minted-but-unadmitted successors are NOT block_admitted here: the
    // dispatcher's journal-prefix fold queues them and admits them through
    // real pool accounting with the rerun_of stamp (a bare block_admitted
    // from recovery would mark them admitted without ever spawning them).
    if (plan.successorReadmissions.length > 0) {
      stream.write(
        `resume: ${plan.successorReadmissions.length} minted successor(s) pending — the dispatcher queues and admits them\n`,
      );
    }
    // Terminal-evidence reconciliation (D-13): a journaled non-terminal
    // attempt whose run dir holds a COMPLETE verdict journals terminal from
    // the evidence (outcome-derived, loud); attempts with no run dir at all
    // re-enter via E7 rerun below.
    const evidence = terminalEvidenceActions({
      events,
      verdictOf: (runId) => {
        try {
          const v = JSON.parse(
            readFileSync(join(resultsRoot, runId, 'verdict.json'), 'utf8'),
          ) as { final?: string };
          return v.final === 'pass' || v.final === 'fail' || v.final === 'indeterminate'
            ? { final: v.final }
            : null;
        } catch {
          return null;
        }
      },
    });
    bundle.push(...evidence.terminals);
    // Storage-pause reconciliation: retroactive ordering (REV fable M-6) —
    // if storage_paused never persisted, journal it BEFORE the first buffered
    // activity event; the marker removes only after the first successful
    // commit (below).
    const pauseMarker = join(args.campaignDir, '.storage-paused');
    const lastPauseSeq = events.reduce(
      (m, e) => (e.type === 'storage_paused' ? Math.max(m, e.seq) : m),
      -1,
    );
    const pauseUnresumed =
      lastPauseSeq >= 0 &&
      !events.some(
        (e) =>
          e.seq > lastPauseSeq &&
          (e.type === 'block_admitted' || e.type === 'attempt_created' || e.type === 'budget_event'),
      );
    if (existsSync(pauseMarker) && lastPauseSeq < 0) {
      bundle.unshift({ type: 'storage_paused', payload: {} });
    }
    // Spent-ballast note (D-13): ballast ABSENCE at ANY resume journals the
    // accounting note — once, never per-resume (the normal pause leaves NO
    // marker, so the note cannot be marker-gated).
    const ballastSpentNoted = events.some(
      (e) => e.type === 'adjudication' && e.payload.disposition === 'ballast_spent',
    );
    if (!ballastSpentNoted && !verifyBallast(args.campaignDir, DEFAULT_BALLAST_BYTES)) {
      bundle.push({
        type: 'adjudication',
        payload: {
          cell: 'control-plane',
          disposition: 'ballast_spent',
          rationale: 'the ballast is absent/spent at resume; the control-plane reserve was consumed',
        },
      });
    }
    // Rerun re-entry (R-RCV-2 + the D-13 fate table's journaled-at-resume
    // row): every killed in-flight block and every attempt-with-no-run-dir
    // block re-enters WHOLE via block_replaced { kind: 'rerun' } — reason
    // storage_failure when this resume reconciles a storage pause, else
    // dispatcher_restart. `aborted` lands FIRST (the E7.1 re-entry edge only
    // applies from aborted); a block already superseded by a landed mint is
    // recovery-folded, never re-minted (mint-override, R-RCV-2/R-RCV-5).
    const rerunReason = existsSync(pauseMarker) || pauseUnresumed ? 'storage_failure' : 'dispatcher_restart';
    const supersededR = new Set<string>();
    const abortedR = new Set<string>();
    const attemptSampleR = new Map<string, string>();
    const terminalAttemptsR = new Set<string>(evidence.terminalAttemptIds);
    const admittedSeqR = new Map<string, number>();
    for (const event of events) {
      if (event.type === 'block_replaced') supersededR.add(normalizeBlockReplaced(event.payload).block_id);
      else if (event.type === 'aborted') abortedR.add(event.payload.block_id);
      else if (event.type === 'attempt_created') attemptSampleR.set(event.payload.attempt_id, event.payload.sample_id);
      else if (event.type === 'block_admitted') admittedSeqR.set(event.payload.block_id, event.seq);
      else if (event.type === 'run_completed' || event.type === 'instrument_failure') {
        terminalAttemptsR.add(event.payload.attempt_id);
      }
    }
    const rosterOfBlock = (blockId: string): readonly string[] => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e === undefined || e.type !== 'block_replaced') continue;
        const rec = normalizeBlockReplaced(e.payload);
        if (rec.replacement_block_id === blockId && rec.roster.length > 0) {
          return rec.roster.map((r) => r.sample_id);
        }
      }
      const block = campaign.blocks.find((b) => b.block_id === blockId);
      if (block === undefined) throw new RecoveryError(`block ${blockId} has no frozen or minted roster`);
      return block.sample_ids;
    };
    const armOfSample = (sampleId: string): string => {
      const arm = campaign.samples.find((s) => s.sample_id === sampleId)?.arm;
      if (arm === undefined) throw new RecoveryError(`sample ${sampleId} not in the frozen universe`);
      return arm;
    };
    // The block a sample was running under at a given seq: the most recent
    // prior admission whose (frozen or minted) roster contains it — lineage-
    // aware, so an in-flight :iN successor reruns as ITS OWN successor.
    const blockOfSampleAt = (sampleId: string, atSeq: number): string | null => {
      let best: { id: string; seq: number } | null = null;
      for (const [blockId, seq] of admittedSeqR) {
        if (seq > atSeq) continue;
        if (!rosterOfBlock(blockId).includes(sampleId)) continue;
        if (best === null || seq > best.seq) best = { id: blockId, seq };
      }
      return best?.id ?? null;
    };
    const rerunBlockIds = new Set<string>(evidence.rerunBlockIds);
    for (const event of events) {
      if (event.type !== 'run_allocated') continue;
      if (terminalAttemptsR.has(event.payload.attempt_id)) continue;
      const sampleId = attemptSampleR.get(event.payload.attempt_id);
      if (sampleId === undefined) continue;
      const blockId = blockOfSampleAt(sampleId, event.seq);
      if (blockId !== null) rerunBlockIds.add(blockId);
    }
    for (const blockId of rerunBlockIds) {
      if (supersededR.has(blockId)) continue; // the landed mint is authoritative
      if (!abortedR.has(blockId)) {
        bundle.push({ type: 'aborted', payload: { block_id: blockId } });
      }
      const successorId = nextRerunInstanceId(blockId);
      bundle.push({
        type: 'block_replaced',
        payload: {
          block_id: blockId,
          replacement_block_id: successorId,
          reason: rerunReason,
          kind: 'rerun',
          reserve_activation: false,
          roster: rosterOfBlock(blockId).map((sampleId) => ({
            sample_id: sampleId,
            arm: armOfSample(sampleId),
          })),
        },
      });
      stream.write(`rerun re-entry: ${blockId} -> ${successorId} (${rerunReason})\n`);
    }
    // R-RCV-3/R-RCV-4: quarantine by persisted identity — every run dir
    // carrying <runDir>/campaign-identity.json (written at allocation, task
    // 6c) is checked against the journal; late/orphaned/mismatched dirs are
    // journal-classified via E7's binding-only quarantined event. Nothing
    // moves on disk.
    bundle.push(
      ...quarantineActions({
        runDirIdentities: readRunDirIdentities(resultsRoot),
        events,
        campaignId: campaign.campaign_id,
      }),
    );
    // Interrupted contention batch: fold landed mints (authoritative) and
    // re-derive only the missing suffix.
    const { lines } = parseSidecar(args.campaignDir);
    bundle.push(
      ...rederiveContentionSuffix({ events, sidecarLines: lines, campaign }),
    );
    if (bundle.length > 0) writer.appendEvents(bundle);
    if (existsSync(pauseMarker)) {
      // Marker removed ONLY after the first successful commit (above landed).
      unlinkSync(pauseMarker);
    }
    writer.release();

    // 4. Preflight (after cleanup): resource floors + fingerprint match +
    //    key envs (R-LCK-2 / R-REG-19 second half). ALWAYS runs — the real
    //    Linux probe is the production default (S4: mandated behavior never
    //    rides an absent optional); tests inject a scripted probe. The LIVE
    //    fingerprint comes from probeFingerprint, never from the registered
    //    values (a mismatch must be detectable — Decision D-4).
    const probe = args.probe ?? linuxHostStatsProbe(args.campaignDir);
    const stats = probe.sample(clockNowMs(clock));
    preflightResourceFloors(stats, DEFAULT_RESOURCE_FLOORS);
    assertFingerprintMatch(
      campaign.contention.host_fingerprint,
      probeFingerprint(probe, clockNowMs(clock)),
      {
        mem_tolerance_pct: campaign.contention.mem_tolerance_pct,
        disk_tolerance_pct: campaign.contention.disk_tolerance_pct,
      },
    );
    for (const arm of campaign.execution_surface) {
      const cred = args.credentials[arm.credential];
      if (cred?.auth === 'api-key') {
        for (const envName of arm.key_env_names) {
          if ((args.credentials[arm.credential]?.api_key_env ?? envName) === '') {
            throw new RecoveryError(`key env ${envName} unset at resume (R-REG-19)`);
          }
        }
      }
    }

    // 5. Reconstruct the handle + refs cross-check + verify (R-RCV-6).
    const handle = reconstructCampaignSnapshot({
      campaignDir: args.campaignDir,
      refs: campaign.refs,
      runner: defaultCommandRunner,
    });
    verifyCampaignSnapshot(handle, defaultCommandRunner);

    stream.write(`resume: reconcile complete — kills=${killReport.killed.length}, reclaimed-without-kill=${killReport.reclaimedWithoutKill.length}, dispositions=${plan.dispositionCompletions.length}, readmissions=${plan.successorReadmissions.length}\n`);

    // 6. Admit (the idempotent resume verb drives the dispatcher). This is
    // THE production wiring of the dispatcher's mandated seams: the
    // reconstructed snapshot handle + CommandRunner (R-DSP-11 verify builds
    // from them — no injectable no-op), repairDriftedTrees over the source
    // checkouts (Decision D-11 authorized repair), and the real timer-driven
    // sampler (Decision D-3).
    return runCampaignDispatch({
      campaignDir: args.campaignDir,
      clock,
      identity,
      credentials: args.credentials,
      resultsRoot,
      snapshot: handle,
      runner: defaultCommandRunner,
      repairSnapshot: () =>
        repairDriftedTrees({
          campaignDir: args.campaignDir,
          refs: campaign.refs,
          evalsCheckout: args.evalsCheckout,
          gauntletCheckout: args.gauntletCheckout,
          superpowersCheckout: args.superpowersCheckout,
          runner: defaultCommandRunner,
        }),
      sampler: realSamplerSeam({
        campaignDir: args.campaignDir,
        contention: campaign.contention,
        probe,
        clock,
      }),
      ...(args.spawner !== undefined ? { spawner: args.spawner } : {}),
      stream,
    });
  } finally {
    lock.release();
  }
}

/** Decision D-12 cancellation — one pinned order for both paths: marker
 *  first -> stop admission -> kill + verify dead (SIGTERM first) -> complete
 *  any partial E7 mint bundle -> journal aborted per in-flight block ->
 *  journal campaign_cancelled LAST. cancelled is terminal. */
export function cancelCampaign(args: {
  campaignDir: string;
  reason?: string;
  clock: Clock;
  identity: ProcessIdentityProbe;
  lockPath?: string;
  stream?: { write(s: string): void };
}): { cancelled: boolean; postCrash: boolean } {
  const stream = args.stream ?? { write: (s: string) => process.stdout.write(s) };
  // As-published read (registration validated + digested before the rename).
  const campaign: Campaign = JSON.parse(
    readFileSync(join(args.campaignDir, 'campaign.json'), 'utf8'),
  );
  // Sealed campaigns refuse cancellation loudly.
  const lockPath = args.lockPath ?? defaultLiveSpendLockPathFor(args.campaignDir);
  // 1. Marker first (O_EXCL). Line 2 carries the operator's reason so a
  // live dispatcher can journal campaign_cancelled { reason } itself.
  const marker = join(args.campaignDir, 'cancel-request');
  if (!existsSync(marker)) {
    writeFileSync(marker, `${clockNowMs(args.clock)}\n${args.reason ?? ''}\n`, { flag: 'wx' });
  }
  // Is a dispatcher live? The live-spend lock's owner token names it.
  const holder = readLiveSpendHolder(lockPath);
  let liveDispatcherPid: number | null = null;
  if (holder !== null && holder.campaignId === campaign.campaign_id) {
    // The SAME R-LCK-2 identity check: pid exists AND OS start time equals
    // the token's birth_ts_ms. ESRCH or birth mismatch -> post-crash path;
    // identity unknown refuses loudly.
    switch (args.identity.exists(holder.pid)) {
      case 'esrch':
        break; // dead holder
      case 'unknown':
        throw new RecoveryError(
          `cancel: dispatcher pid ${holder.pid} identity unknown (kill(pid,0) inconclusive) — refusing to signal`,
        );
      case 'alive': {
        const start = args.identity.startTimeMs(holder.pid);
        if (start === null) {
          throw new RecoveryError(
            `cancel: dispatcher pid ${holder.pid} start time unreadable — identity unknown, refusing to signal`,
          );
        }
        if (start === holder.birth_ts_ms) liveDispatcherPid = holder.pid;
        // else: PID reuse — the recorded dispatcher is gone; post-crash path.
        break;
      }
    }
  }
  if (liveDispatcherPid !== null) {
    // Signal the dispatcher; it performs the pinned sequence.
    process.kill(liveDispatcherPid, 'SIGTERM');
    stream.write(`cancel: signalled live dispatcher pid ${liveDispatcherPid}\n`);
    // Poll for campaign_cancelled to land — the signalled dispatcher sees
    // the marker and completes the FULL pinned sequence, journaling
    // campaign_cancelled LAST (task 8's signal handler). READ-ONLY poll:
    // the live dispatcher HOLDS the journal lease for its whole run, so a
    // writer election here would refuse against the live holder.
    for (let i = 0; i < 300; i++) {
      const reader = openJournalRead(args.campaignDir);
      try {
        if (reader.readEvents().some((e) => e.type === 'campaign_cancelled')) {
          return { cancelled: true, postCrash: false };
        }
      } finally {
        reader.close();
      }
      Bun.sleepSync(100);
    }
    stream.write('cancel: dispatcher did not complete the sequence — taking the post-crash path\n');
  }
  // Post-crash path: the command takes writer election itself and performs
  // the sequence, including the aborted journaling (I-10a).
  const writer = electWriter({ campaignDir: args.campaignDir, clock: args.clock, identity: args.identity, campaign });
  try {
    const events = writer.readEvents();
    if (events.some((e) => e.type === 'campaign_cancelled')) {
      return { cancelled: true, postCrash: true };
    }
    if (events.some((e) => e.type === 'sealed')) {
      throw new RecoveryError('cancel refused: campaign is sealed');
    }
    // Kill journaled pgids (SIGTERM first — I-10c) + verify dead.
    killJournaledPgids({ events, stream });
    // Complete any partial mint bundle BEFORE aborted (a kill whose
    // journaling never lands is still a kill recovery can reconcile; aborted
    // would otherwise destroy the disposition's legal source state).
    const universe: CampaignUniverse = campaign;
    const plan = planRecovery({ universe, events });
    const bundle: EventInput[] = [];
    for (const d of plan.dispositionCompletions) {
      bundle.push({
        type: 'sample_disposition',
        payload: {
          sample_id: d.sample_id,
          disposition: 'excluded_block_replaced',
          superseded_by: d.superseded_by,
        },
      });
    }
    // Aborted per in-flight block — idempotent against whatever a live
    // dispatcher already journaled before it died mid-sequence: a block with
    // a landed aborted is never re-aborted.
    const terminalAttempts = new Set<string>();
    const attemptSample = new Map<string, string>();
    const alreadyAborted = new Set<string>();
    for (const event of events) {
      if (event.type === 'run_completed' || event.type === 'instrument_failure') {
        terminalAttempts.add(event.payload.attempt_id);
      }
      if (event.type === 'attempt_created') {
        attemptSample.set(event.payload.attempt_id, event.payload.sample_id);
      }
      if (event.type === 'aborted') {
        alreadyAborted.add(event.payload.block_id);
      }
    }
    const inFlightBlocks = new Set<string>();
    for (const event of events) {
      if (event.type === 'run_allocated' && !terminalAttempts.has(event.payload.attempt_id)) {
        const sampleId = attemptSample.get(event.payload.attempt_id);
        for (const block of campaign.blocks) {
          if (sampleId !== undefined && block.sample_ids.includes(sampleId)) {
            inFlightBlocks.add(block.block_id);
          }
        }
      }
    }
    for (const blockId of inFlightBlocks) {
      if (alreadyAborted.has(blockId)) continue;
      bundle.push({ type: 'aborted', payload: { block_id: blockId } });
    }
    // campaign_cancelled LAST.
    bundle.push({
      type: 'campaign_cancelled',
      payload: args.reason !== undefined ? { reason: args.reason } : {},
    });
    try {
      writer.appendEvents(bundle);
    } catch (err) {
      if (isStorageFullError(err)) {
        // D-13 honest limits: a cancel during pause must land from the freed
        // ballast extent; beyond that envelope (inode/WAL amplification) the
        // result is a LOUD storage-fatal — children are already dead, and no
        // terminal is ever fabricated.
        throw new RecoveryError(
          `cancel storage-fatal: the cancellation evidence could not land even from the freed reserve (${(err as Error).message}) — children are dead; free space in ${args.campaignDir} and re-run the cancel`,
        );
      }
      throw err;
    }
    return { cancelled: true, postCrash: true };
  } finally {
    writer.release();
  }
}

function defaultLiveSpendLockPathFor(_campaignDir: string): string {
  return defaultLiveSpendLockPath();
}
```

(Add `import { defaultLiveSpendLockPath } from './locks.ts';` and the top-level `import { defaultCommandRunner } from '../agents/command-runner.ts';` to the import list.)

- [ ] **Step 8: Run tests to verify they pass + commit (task 9b)**

Run: `bun test test/campaign-cancel.test.ts test/campaign-recovery.test.ts`
Expected: PASS (3 cancel tests + 5 recovery tests).

```bash
git add src/campaign/recovery.ts test/campaign-cancel.test.ts
git commit -m "feat(campaign): D3 resume + cancel — pinned resume order; D-12 both paths, campaign_cancelled LAST"
```

#### Task 9c: CLI verbs + lock threading + handoff docs (Steps 9-13; covers the operator surface `campaign register|run|cancel`, R-LCK-2's run-all/direct-run threading, and the doc/status obligations)

**Files:** modify `src/cli/campaign.ts` + `src/cli/index.ts`, `src/run-all/index.ts`, `src/cli/run-command.ts`, `AGENTS.md` + the D3 spec status line; create `test/campaign-cli-verbs.test.ts` + `test/campaign-lock-threading.test.ts`.

- [ ] **Step 9: Write the failing CLI + lock-threading tests** — `test/campaign-cli-verbs.test.ts` (register/run/cancel verb wiring, hermetic via the Task 5 tmp-git fixtures — reuse `evalsRepo`/`gauntletRepo` copied from `test/campaign-registration.test.ts`) and `test/campaign-lock-threading.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLiveSpendHolder } from '../src/campaign/locks.ts';

test('direct quorum run + run-all contend for ONE live-spend lock (all three verbs take it)', async () => {
  const lockPath = join(mkdtempSync(join(tmpdir(), 'lock-')), 'live.lock.d');
  // Holder: a bun child that acquires the lock and holds it.
  const holder = `
    import { acquireLiveSpendLock } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    import { RealClock } from '${join(import.meta.dir, '..', 'src', 'scheduler', 'clock.ts')}';
    import { realProcessIdentityProbe } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
    const lock = acquireLiveSpendLock({ lockPath: '${lockPath}', campaignId: 'holder', clock: new RealClock(), identity: realProcessIdentityProbe });
    console.log('held');
    await Bun.sleep(30_000);
    lock.release();
  `;
  const child = Bun.spawn(['bun', '-e', holder], { stdout: 'pipe', stderr: 'pipe' });
  try {
    // Wait for the holder to acquire: its owner token becomes readable.
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await Bun.sleep(50);
      ready = readLiveSpendHolder(lockPath) !== null;
    }
    expect(ready).toBe(true);
    // A second acquisition refuses, NAMING the live holder.
    const contender = `
      import { acquireLiveSpendLock } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
      import { RealClock } from '${join(import.meta.dir, '..', 'src', 'scheduler', 'clock.ts')}';
      import { realProcessIdentityProbe } from '${join(import.meta.dir, '..', 'src', 'campaign', 'locks.ts')}';
      try {
        acquireLiveSpendLock({ lockPath: '${lockPath}', campaignId: 'contender', clock: new RealClock(), identity: realProcessIdentityProbe });
        console.log('ACQUIRED');
      } catch (err) {
        console.log('REFUSED: ' + err.message);
      }
    `;
    const res = spawnSync('bun', ['-e', contender], { encoding: 'utf8' });
    expect(res.stdout).toContain('REFUSED');
    expect(res.stdout).toMatch(/held by pid \d+/);
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 10: Implement the CLI verbs** — modify `src/cli/campaign.ts` (append after the simulate verb's functions) and register them in `src/cli/index.ts`:

```ts
// In src/cli/campaign.ts:
import { registerCampaign } from '../campaign/registration.ts';
import { resumeCampaign, cancelCampaign } from '../campaign/recovery.ts';
import { EstimatesArtifactSchema } from '../contracts/estimates.ts';
import { parseCredentialsFile } from '../contracts/credential.ts';
import { RealClock } from '../scheduler/clock.ts';
import { realProcessIdentityProbe } from '../campaign/locks.ts';
import { linuxHostStatsProbe } from '../campaign/host-stats.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import { repoRoot } from '../paths.ts';

export interface CampaignRegisterOptions {
  estimates: string;
  globalCap: string;
  confirm?: boolean;
  dryRun?: boolean;
  evalsRef?: string;
  gauntletRef?: string;
  evalsCheckout?: string;
  gauntletCheckout?: string;
  superpowersCheckout?: string;
}

export function campaignRegister(suitePath: string, opts: CampaignRegisterOptions): void {
  try {
    const estimatesRaw = JSON.parse(readFileSync(opts.estimates, 'utf8'));
    const estimates = EstimatesArtifactSchema.parse(estimatesRaw);
    const root = repoRoot();
    const suiteRaw = readFileSync(suitePath, 'utf8');
    const result = registerCampaign({
      suitePath,
      suiteRaw,
      campaignsRoot: join(root, 'campaigns'),
      estimates,
      globalCap: Number(opts.globalCap),
      confirm: opts.confirm === true,
      dryRun: opts.dryRun === true,
      evalsCheckout: opts.evalsCheckout ?? root,
      gauntletCheckout: opts.gauntletCheckout ?? root,
      superpowersCheckout: opts.superpowersCheckout ?? root,
      evalsRef: opts.evalsRef ?? 'HEAD',
      gauntletRef: opts.gauntletRef ?? 'HEAD',
      runner: defaultCommandRunner,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
      probe: linuxHostStatsProbe(root),
      env: (key) => getEnv(key),
      registeredBy: getEnv('USER') ?? 'unknown',
      nowMs: Date.now(),
    });
    process.stdout.write(`${result.printed}\n`);
  } catch (err) {
    catchCliError(err);
  }
}

export function campaignRun(
  campaignDir: string,
  opts: { evalsCheckout?: string; gauntletCheckout?: string; superpowersCheckout?: string } = {},
): void {
  // The checkouts are the SOURCE repos the drift repair drives `git worktree
  // remove/prune` against (their .git/worktrees hold the registrations) —
  // never the campaign dir itself (that is the worktree DEST). Defaults
  // mirror `campaign register`'s.
  const root = repoRoot();
  resumeCampaign({
    campaignDir,
    credentials: parseCredentialsFile(
      parseYaml(readFileSync(join(campaignDir, 'evals', 'credentials.yaml'), 'utf8')),
    ),
    evalsCheckout: opts.evalsCheckout ?? root,
    gauntletCheckout: opts.gauntletCheckout ?? root,
    superpowersCheckout: opts.superpowersCheckout ?? getEnv('SUPERPOWERS_ROOT') ?? root,
  })
    .then((outcome) => {
      process.stdout.write(`campaign run finished: ${outcome.status}${outcome.reason !== undefined ? ` (${outcome.reason})` : ''}\n`);
    })
    .catch((err) => catchCliError(err));
}

export function campaignCancel(campaignDir: string, opts: { reason?: string }): void {
  try {
    const result = cancelCampaign({
      campaignDir,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    process.stdout.write(
      `campaign cancelled (${result.postCrash ? 'post-crash path' : 'live dispatcher'})\n`,
    );
  } catch (err) {
    catchCliError(err);
  }
}
```

In `src/cli/index.ts`, beside the existing campaign subcommands (acquire/estimates/simulate), register per the pinned CLI table:

```ts
campaign
  .command('register')
  .description('register a suite as a frozen campaign (snapshot-first)')
  .argument('<suite>', 'suite YAML path')
  .option('--estimates <path>', 'estimates artifact', 'estimates/v1.json')
  .option('--global-cap <int>', 'per-sample global slot cap (historical --jobs)', String(DEFAULT_GLOBAL_CAP))
  .option('--confirm', 'required to publish; without it the verb prints and exits 0')
  .option('--dry-run', 'grid + exclusions + digest only, never writes')
  .action((suite: string, opts: CampaignRegisterOptions) => campaignRegister(suite, opts));
campaign
  .command('run')
  .description('start/resume a registered campaign (idempotent resume verb)')
  .argument('<campaign-dir>', 'campaign directory')
  .option('--evals-checkout <path>', 'evals source checkout (drift-repair worktree source)')
  .option('--gauntlet-checkout <path>', 'gauntlet source checkout')
  .option('--superpowers-checkout <path>', 'superpowers source checkout (default: $SUPERPOWERS_ROOT)')
  .action((dir: string, opts: { evalsCheckout?: string; gauntletCheckout?: string; superpowersCheckout?: string }) => campaignRun(dir, opts));
campaign
  .command('cancel')
  .description('cancel a campaign (marker + pinned kill/journal order)')
  .argument('<campaign-dir>', 'campaign directory')
  .option('--reason <text>', 'cancellation reason recorded in campaign_cancelled')
  .action((dir: string, opts: { reason?: string }) => campaignCancel(dir, opts));
```

(`src/cli/index.ts` imports `DEFAULT_GLOBAL_CAP` from `../campaign/registration.ts` for the `--global-cap` default — one owner for the number.)

- [ ] **Step 11: Implement lock threading** — the two remaining spender verbs (surface (a), R-LCK-2):

`src/run-all/index.ts` — at the top of `runBatch`, before scheduling, acquire; release in `finally`:

```ts
import { acquireLiveSpendLock, LockError } from '../campaign/locks.ts';
import { RealClock } from '../scheduler/clock.ts';
import { realProcessIdentityProbe } from '../campaign/locks.ts';

// Inside runBatch(args), wrapping the existing scheduling body:
const spendLock = acquireLiveSpendLock({
  clock: args.clock ?? new RealClock(),
  identity: realProcessIdentityProbe,
});
stream.write?.(`live-spend lock acquired (run-all)\n`);
try {
  // ... existing runBatch body, unchanged ...
} finally {
  spendLock.release();
}
```

(A `LockError` propagates to run-all's existing error surface — refusal names the live holder: pid, heartbeat age, campaign id. No other behavior change.)

`src/cli/run-command.ts` — in `executeRunCommand`, wrap the `runScenario` call:

```ts
import { acquireLiveSpendLock } from '../campaign/locks.ts';
import { RealClock } from '../scheduler/clock.ts';
import { realProcessIdentityProbe } from '../campaign/locks.ts';

// Around the runScenario await:
const spendLock = acquireLiveSpendLock({
  clock: new RealClock(),
  identity: realProcessIdentityProbe,
});
try {
  const { runDir, verdict } = await runScenario({ ... });
  // ... existing post-run output ...
} finally {
  spendLock.release();
}
```

(Campaign children never reach this path holding nothing — the spawner's `QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1` env makes `acquireLiveSpendLock` refuse loudly if a child ever tries; direct `quorum run` and `run-all` are top-level spenders.)

- [ ] **Step 12: Docs + status obligations** — two edits:
- `AGENTS.md` (repo root; read its architecture section first): extend the `src/campaign/` bullet with the D3 modules — locks, journal, snapshot integration, registration, key-select, sensors, contention, classifier, dispatcher, recovery — and the `quorum campaign register | run | cancel` verbs, matching the existing bullet style.
- `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md`: flip the status line to `implemented (main @ <merge commit>)` — the same convention the D2 spec's status line used ("docs: D2 spec status — implemented"). The implementer performs this at implementation time, after the exit criteria pass — it is a status stamp, never a semantic spec edit.

**Open item (DECIDED 2026-08-27 — Drew: defer the append surface to D4):** R-DSP-10 mandates the append-only `amendment { kind: 'budget_raise', amount_usd, ts }` journal event, and this plan lands its full CONSUMER side (schema, materialized `amendments` table, the dispatcher's raise fold into `budgetUsd`, the never-resurrects pin). The spec's pinned CLI table is exactly `campaign register | run | cancel` — no operator surface exists to APPEND a raise, and inventing a fourth verb would contradict the pin. Decision: assign the raise surface to D4's operator tooling; D3 ships the consumer side dormant. Rationale: the operator almost never sets a start budget (hard to guess; registration prices the grid, so the set number is estimate-informed); if hot budget-stops bite in the first campaigns, amend the spec once with operator evidence (possibly bundling estimate-derived budget defaults). Until then the D-13 "amendment refused loudly during pause" row is moot by construction (nothing can append one).

- [ ] **Step 13: Run tests, full gate + commit (task 9c)**

Run: `bun test test/campaign-cli-verbs.test.ts test/campaign-lock-threading.test.ts`
Expected: PASS. Then `bun run check` and `bun run quorum check` — green.

```bash
git add src/cli/campaign.ts src/cli/index.ts src/run-all/index.ts src/cli/run-command.ts test/campaign-cli-verbs.test.ts test/campaign-lock-threading.test.ts AGENTS.md docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md
git commit -m "feat(campaign): D3 CLI verbs + live-spend-lock threading

quorum campaign register|run|cancel per the pinned option table (run
threads the source checkouts to the drift repair); live-spend lock
threaded into run-all and direct quorum run (children never acquire);
AGENTS.md architecture bullets + D3 spec status line updated."
```

---

## Trusted-maintainer validation: Linux-gated integration matrix

**This section is trusted-maintainer only — never public CI** (AGENTS.md safe-checks doctrine: live evals launch agent CLIs in permissive modes and capture sensitive transcripts). It runs on the designated Linux host/appliance, recorded separately. Create `test/integration/campaign-linux-matrix.test.ts` tagged out of the portable suite (the portable `bun test test/` run must not execute it; gate on `process.platform === 'linux'` + an explicit `QUORUM_D3_LINUX_MATRIX=1` env), then run it by hand on the appliance.

Each item below is an **asserted-not-proven debt item** from the spec's Mechanism verification + Open items until its checked-in test here passes:

- [ ] **Real two-process locking on a shared filesystem** — two appliance processes contend for `journal.lease.d` and the live-spend lock; contender refuses naming the live holder; dead holder + stale heartbeat reclaims (R-LCK-1/2).
- [ ] **Production process-start-time reader vs token `birth_ts_ms` under a recycled pid** — reclaim and cancel never signal the replacement process; non-ESRCH probe failures refuse (identity unknown). Covers the Round-4 process-birth-identity debt.
- [ ] **Detached group TERM→KILL escalation against real grandchildren** — spawn a campaign child that spawns its own child; `process.kill(-pgid)` kills the whole group. Covers the **grandchild group membership** debt (observed once in drafting; asserted-not-proven until this passes).
- [ ] **pid-reuse defense end-to-end** — lock reclamation and cancel signaling under a recycled pid (compose the two checks above into the cancel path).
- [ ] **kill -9 of a WAL-mode writer; next process re-acquires** — `kill -9` the journal writer mid-append; a fresh `electWriter` succeeds; the sequence stays gapless. Covers the **kill-9 WAL re-acquire** debt.
- [ ] **GC-finalizer lock release** — a `bun:sqlite` connection released to GC closes and drops its transaction lock; verify a contender proceeds after GC. Covers the **GC-finalizer lock release** debt (the journal writer keeps its `Database` reachable for the process lifetime — this test proves the fail-safe).
- [ ] **`O_CLOEXEC` / FD non-inheritance** — a spawned campaign child does NOT hold the journal lease or lock FDs (inspect `/proc/<child>/fd`). Covers the **O_CLOEXEC child FD non-inheritance** debt. Fallback if it fails: explicit close-on-spawn in the spawner seam (named in the spec, not built speculatively).
- [ ] **Forced `SQLITE_FULL` on a quota-bounded tmpfs campaign dir** — the complete D-13 fail-stop path: ballast release → marker/tail/cancel-evidence landing → kill → retroactive `storage_paused` ordering → resume reconciliation. Sub-cases: publication refusal for sparse/unfsynced ballast; ballast-before-campaign.json ordering; byte exhaustion; inode exhaustion; SQLite WAL amplification beyond the freed extent (honest limits — the pause error and qualification receipt name them). Covers the **ballast ENOSPC sufficiency** debt (no quota-bearing tmpfs exists on the Darwin dev host).
- [ ] **Sidecar-append ENOSPC as the first detector** — the sampler hits the full volume first; the dispatcher enters the same pause path.
- [ ] **Partial sidecar / torn tail truncation** — crash mid-append; recovery truncates at the last complete line, the truncated interval counts uncovered.
- [ ] **Exposure races** — session log appears only at terminal; the capture-derived value decides at block terminal (Decision D-9 decision point).
- [ ] **D2 reconstruction drift** — move a worktree HEAD after registration; resume's refs cross-check refuses (R-RCV-6) on the real filesystem.
- [ ] **All three verbs contend for one lock** — direct `quorum run`, `run-all`, and `campaign run` against one `$QUORUM_LIVE_SPEND_LOCK` on the appliance-owned shared path.

Run (on the designated host only):

```bash
QUORUM_D3_LINUX_MATRIX=1 bun test test/integration/campaign-linux-matrix.test.ts
```

Record results (pass/debt-retained per item) in the D3 experiment-log entry per the repo convention (`docs/experiments/`), negative results at equal billing.

## Final verification (exit criteria — spec §Exit criteria)

- [ ] The full portable hermetic matrix passes: `bun test test/` green (tasks 1–9 test suites).
- [ ] `bun run check` green (biome + tsc + full test suite + dashboard) and `bun run quorum check` green on the merge commit.
- [ ] The Linux-gated integration matrix passes on the designated host (separately recorded, trusted-maintainer — section above).
- [ ] **Three separate live campaigns** (REV sol #18 — the single combined lifecycle is impossible), each trusted-maintainer, nothing to public CI:
  1. **Completion:** a registered small gating suite runs registration → dispatch → all-samples-terminal → the E7 instance-complete seal predicate holds (D4's report act follows on its own deliverable).
  2. **Crash-resume:** kill mid-block; `quorum campaign run` resumes — identity-guarded pgid-kill-before-rerun evidenced, any landed mint reused rather than duplicated, same-id successor witnesses are post-mint, refs cross-check passes, no double spend, replay converges on the same materialized state.
  3. **Cancel-and-refuse-resume:** `quorum campaign cancel` completes the pinned order (marker → stop → kill+verify → complete any partial mint bundle → `aborted` → `campaign_cancelled` last); a subsequent `quorum campaign run` refuses to resume, citing the cancel-request.
- [ ] E7, the ENOSPC fail-stop override (Decision D-13), and the additive D1-schema amendments were RATIFIED 2026-08-26 — the dependent tests are ungated (task 1 landed them ungated).
- [ ] D4 is handed, unblocked: the journal read API (`readEvents`, `openJournalRead`) + instance-aware materialized tables (`rebuildMaterialized`); the sealer-writer API (`electWriter({ restrict: ['adjudication', 'sealed'] })` — R-JRN-3); authoritative landed contention mints + the sidecar (`parseSidecar`) and the shared pure evaluator (`evaluateContention`) for integrity audit and the narrowed open-at-end/unknown-coverage backstop; the frozen sampler parameters (`campaign.json` contention block); the pre-seal `verifyCampaignSnapshot` call site with refuse-to-seal handling; the typed-failure accounting inputs (`classifyFailure`); and the budget/amendment trail with the never-resurrects pin.

## Requirement coverage

Every pinned requirement → the sub-task(s) implementing it. E7 items land in task 1 (1a–1c, contracts) and are consumed wherever named.

| Requirement | Task(s) |
|---|---|
| R-LCK-1 (journal writer election) | 2a (lease + fencing), 3a (writer uses it) |
| R-LCK-2 (host-wide live-spend lock) | 2a (mechanism, heartbeat, identity), 2b (preflight), 9c (run-all + direct-run threading), Linux matrix |
| R-LCK-3 (one designated host) | 2b (fingerprint identity), 5c (fingerprint in digest) |
| R-JRN-1 (SQLite persistence) | 3a |
| R-JRN-2 (schema_version row) | 3a |
| R-JRN-3 (single writer; sealer) | 3a (restrict mode), 9c (D4 handoff) |
| R-JRN-4 (fsync per event) | 3a |
| R-JRN-5 (envelope + replay + ordered read) | 3a |
| R-JRN-6 (20+1 event vocabulary) | 1a (quarantined), 3a (validation) |
| R-JRN-7 (three-valued replay, routing) | 1b (machine edges), 3b (replay routing) |
| R-JRN-8 (journaling order) | 8b (attempt_created before spawn; run_allocated same section) |
| R-JRN-9 (run_allocated payload + grants) | 1a (E7.5 union), 6a (grants payload), 8b (journaling) |
| R-JRN-10 (row coverage) | 3b (projection tables) |
| R-JRN-11 (storage-pause state rule) | 3b (derivation), 9b (resume reconciliation) |
| R-JRN-12 (budget_event kinds + E7.7 netting) | 3a (spend table + position), 8b (atomic snapshots) |
| R-REG-1 (grid expansion + tiers) | 5b |
| R-REG-2 (eligibility filters, loud record) | 5b |
| R-REG-3 (pricing from estimates, E1/E2, surcharge) | 5b |
| R-REG-4 (digest) | 1b (digestInput amendment), 5b (compute) |
| R-REG-5 (final-path init → marker publication) | 3c (publication primitives), 5d (orchestration) |
| R-REG-6 (campaign_opened) | 5d |
| R-REG-7 (key_pool over-capacity warning) | 5b |
| R-REG-8 (ref resolution to SHAs) | 5d |
| R-REG-9 (capability rejection) | 5b |
| R-REG-10 (windows registration error) | 5b |
| R-REG-11 (unpriced gating cells) | 5b |
| R-REG-12 (usd params vs unpriceable arms) | 5b |
| R-REG-13 (minimum feasible launch) | 5b |
| R-REG-14 (arm os unsupported) | 5b |
| R-REG-15 (subscription auth in gating) | 5b |
| R-REG-16 (requires_superpowers conflict) | 5b |
| R-REG-17 (coupling flags) | 5b |
| R-REG-18 (profile parameter validation) | 5b |
| R-REG-19 (key env preflight, twice) | 5d (registration), 9b (resume) |
| R-REG-20 (grader singular + cap warning) | 5b |
| R-REG-21 (estimate staleness) | 5b |
| R-REG-22 (idempotent re-registration) | 5d |
| R-DSP-1 (atomic per-block admission) | 8a (demand vector), 8b (transactional admission) |
| R-DSP-2 (longest-expected-first) | 8a (priority + tie-break), 8b (wave order) |
| R-DSP-3 (429 cooldowns) | 7a (classification), 8b (pool_blocked + wait) |
| R-DSP-4 (backfill) | 8b |
| R-DSP-5 (replacement rule) | 8b (mint bundle + shared reserve) |
| R-DSP-6 (budget enforcement + never-resurrects) | 8b (admission gate + resolution-time pass-through) |
| R-DSP-7 (cancellation signals) | 8b (signal path incl. the live-cancel branch), 9b (operator path) |
| R-DSP-8 (grader pool first-class) | 5b (registration record), 8b (admission accounting) |
| R-DSP-9 (runtime skew rule) | 8b (skew_excluded + skew_refill via mint) |
| R-DSP-10 (budget amendment) | 3a (amendments table), 8b (raise fold into the budget predicate); the append surface is an open NEEDS_DECISION (task 9c note — the pinned CLI table has no amend verb) |
| R-DSP-11 (snapshot-drift gate) | 4 (mapping + repair), 8b (wave + block-terminal verify, D-11 sequence, halts) |
| R-DSP-12 (materializer caller) | 4, 5d (registration materialization), 8b (dispatch call sites) |
| R-DSP-13 (thin dispatcher) | 8b |
| R-SPN-1 (process-group-leader spawn) | 6a |
| R-SPN-2 (pgid validation) | 6a |
| R-SPN-3 (projected credential + per-child root) | 6a (grants payload), 8b (spawn wiring) |
| R-SPN-4 (identity before first token) | 6c (intake + persistence + stamping) |
| R-SPN-5 (run_allocated correlation) | 6a (protocol parse), 8b (once-per-run journaling) |
| R-SPN-6 (KeySelector) | 6b |
| R-SPN-7 (resolution fail-loud) | 6b |
| R-SPN-8 (snapshot-entrypoint argv) | 6a |
| R-SPN-9 (superpowers + gauntletBin threading) | 6a |
| R-SNS-1 (provider-broad classification) | 7a |
| R-SNS-2 (exposure ownership) | 7a |
| R-SNS-3 (source precedence) | 7a |
| R-SNS-4 (absence fail-closed) | 7a (probe null), 8b (skew breach) |
| R-SNS-5 (emission shapes) | 7a (exposure_started/pool_blocked values), 8b (journaling) |
| R-CLS-1 (closed map) | 7c |
| R-CLS-2 (table over full stage enum) | 7c |
| R-CLS-3 (grader causes) | 7c (rows 1–2) |
| R-CLS-4 (unknown stays indeterminate) | 7c (row 14 default) |
| R-CLS-5 (InstrumentCause set of ten) | 1a (vocabulary), 7c (table) |
| R-CLS-6 (acceptance bar context) | 7c (accounting inputs) |
| R-RCV-1 (kill journaled pgids first, guarded) | 9a |
| R-RCV-2 (reconcile + rerun whole) | 9a (+ tasks 1b/1c E7 contracts) |
| R-RCV-3 (quarantine by attempt-id mismatch) | 6c (identity persistence), 9a (quarantineActions + readRunDirIdentities), 9b (resume wiring) |
| R-RCV-4 (residual orphan window) | 9a (quarantine derivation), 9b (reconciliation wiring) |
| R-RCV-5 (crash-window resolutions + override) | 1c (resolver), 9a (execution) |
| R-RCV-6 (reconstruction + refs cross-check) | 4, 9b |
| R-RCV-7 (idempotent resume verb) | 9b |
| E7.0 (frozen reserve slots) | 1b (BlockSchema.slot), 5b (reserve minting) |
| E7.1 (lifecycle core: roster carrier, fan-out, re-entry, mint bundle) | 1a (payload) + 1b (machine), 3b (routing), 8b (mint bundle + rerun_of admission), 9a (completion) |
| E7.2 (reason set + legacy round-trip) | 1a |
| E7.3/E7.3a (seal predicate + superseded_by invariants) | 1c (crash-windows rewrite) |
| E7.4 (quarantined carrier) | 1a, 9a |
| E7.5 (role-tagged grants) | 1a (union), 6a (emission matrix) |
| E7.6 (never-resurrects pin) | 8b (tested), 3b (machine has no edge) |
| E7.7 (absolute-total netting + atomicity) | 3a (position), 8b (same-section snapshots incl. spawn-failure and kill releases) |
| Decision D-1 (per-sample global cap + service-end release) | 5b (freezes G), 8a (per-sample demand), 8b (enforces + releases at service end) |
| Decision D-2 (spawn-gap honesty) | 3b (spawn_gap_ms stat), 6b (wait warnings) |
| Decision D-3 (contention split ownership) | 2b (preflight), 5c (declarations), 7b (sampler/sidecar/evaluator — lead), 8b (closed-window batch + sampler seam wiring), 9a (batch recovery), 9c (D4 handoff) |
| Decision D-4 (contention digest membership) | 1b (schema), 5c (declaration) |
| Decision D-5 (closed-window refill) | 7b (evaluator), 8b (resolution batch) |
| Decision D-6 (campaign-dir layout + naming) | 3c (publication), 5d (naming + collision) |
| Decision D-7 (journal storage + publication order) | 3a/3b/3c, 5d |
| Decision D-8 (spawn mechanics + identity intake) | 6a (spawn), 6c (identity intake) |
| Decision D-9 (exposure observation) | 7a |
| Decision D-10 (marker table) | 7a |
| Decision D-11 (drift mapping) | 4 (mapping + repair), 8b (the full sequence in the dispatcher) |
| Decision D-12 (cancellation) | 8b (signals + live-cancel branch, campaign_cancelled LAST), 9b (cancel verb, post-crash idempotency, resume precedence) |
| Decision D-13 (storage pause fail-stop) | 3c (ballast primitives + isStorageFullError), 8b (both detection sites + performStoragePause), 9b (resume reconciliation), Linux matrix |

---

## Known defects carried into SDD (plan-review rounds 1–2)

This plan passed no further gate after two consecutive NOT-READY reviews; per
the two-bounce rule, gate review stopped and the residual defects ride into
implementation as this addendum. Full findings with locations, pins, and
smallest fixes: `docs/experiments/2026-08-27-kernel-d3-plan-review.md`.
**The architecture is not in question** — every finding cites the ratified
spec as the correct standard; the defects are this document's text drifting
from it. Implementers reconcile against the spec's pinned tables, with the
spec as arbiter.

Rules of engagement for every unit:

- **Compile-first:** each unit's step 0 is transcribing its plan code blocks
  and running `bun run typecheck` + the unit's stated test command; drift is
  fixed in the unit's normal red-first loop and logged in the commit body.
- **The spec outranks this document.** Where they conflict, fix this
  document's code to meet the pin and note it in the commit.

Carried defects, mapped to the units that own them (C# = Critical number in
the review record; M# = minor):

- **Unit 1a/1b** — C1 (partial): `BlockReplacedPayload` exported type is a
  broken intersection (requires legacy `cause` on fresh payloads) while the
  event schema is the correct union — make the type the validated
  legacy/fresh union. C5 (partial): E7 instance-model refinements
  (replacement-vs-rerun roster/reserve rules, unique grant roles, no
  duplicate predecessors/successors, no cycles/cross-cell/cross-arm links).
- **Unit 2a** — C8: heartbeat identity-guard on every write; roll back every
  post-acquisition failure; lease release unconditional even when checkpoint
  fails; lock polling uses the injected `Clock`.
- **Units 3a/3b/3c** — C1 (partial): write the real
  `JournalWriter.rebuildProjectionsFrom()` + `snapshotTables()` method bodies
  (currently prose). C5 (partial): `replayEvents` must model the transient
  `sealing` transition (a valid sealed journal currently replays as
  corruption); implement + test byte-identical incremental-vs-rebuild
  projections (currently prose-only).
- **Unit 4** — C2 (partial): `repairDriftedTrees` must identity-check drifted
  direct children (never remove every tree), remove `.quorum-snapshot-ok`
  before re-materialization, and verify the rebuilt wrapper/tree set.
- **Units 5b/5d** — C2 (partial): registration order must satisfy
  final-path materialization before any intake `git show` reads
  (snapshot-first, D-7/P-4/S-8, R-REG-5). C3: `pricingOverrides` need public
  intake (`RegisterArgs`), persistence into `campaign.json`, and real costing
  (token-volume source; if not already pinned in the spec, escalate to the
  orchestrator before implementing — do not invent).
- **Units 6a/6b/6c** — C4: covered children must bypass lock acquisition at
  the CLI entry (the marker means never acquire); `blockDemandVector` must
  use the real `graderPool`; releases must return actual pool keys; key waits
  must await `Clock`; grader key selection must exist; per-key in-flight
  state must persist across samples; selected key values project into child
  env; `DetachedChildSpawner` must latch/replay pre-subscription output and
  exit.
- **Units 7a/7b/7c** — C6: normalize `load1_per_core` by the frozen core
  count; real `campaign_opened` ts in live evaluation; torn-tail + explicit
  gap lines produce uncovered intervals in the shared evaluator. C7 (the
  largest carried gap): per-harness runtime probe registry; capture
  re-derivation + `exposure_audit` minting (D-9); source/role-tagged
  rate-limit and billing evidence so classifier rows 1/2/4 are reachable
  (D-10, R-SNS-1–5, R-CLS-3). M1: add `/i` to the two HTTP status-line
  matcher branches. M2: fix the suite-name intersection prose (the pinned ID
  grammar permits underscores).
- **Units 8a/8b** — C1 (partial): duplicate `const tracker` (compile
  blocker); whole-input `as never` casts out of production paths. C5
  (partial): shared instance-graph validator used by the folds. C6 (partial):
  the shared resolution batch tracks locally-activated reserves (no
  double-selection within a cell) and applies the resolution-time budget
  gate. C9: failed admission-event append must abort + roll back the
  admission transaction BEFORE spawn (the pausing block is not yet in
  `liveBlocks`); actual terminal costs from run artifacts, not registration
  estimates; reconciled absolute snapshot before resumed admission; every
  replacement mint budget-gated (R-DSP-5/6). C10: one awaited
  identity-guarded TERM→wait→KILL→verify helper; release/mint only after
  verified death; suppress stale callbacks from superseded blocks. C11
  (partial): a REAL serialized control critical section (`activeSection`
  assigned around every mint, currently a no-op).
- **Units 9a/9b/9c** — C11 (partial): post-crash in-flight mapping resolves
  against the admitted instance chain (primary/reserve/rerun), marker reason
  read on both cancel paths, `planRecovery` executes `void_attempt_readmit`,
  crash-cut tests for all three instance kinds. C12: remove the three
  forbidden `campaign run` options; define authoritative non-CLI checkout
  discovery for `register`; lock-threading test must subprocess-launch the
  three spender entrypoints. Also write the promised
  `campaign-cli-verbs.test.ts` bodies (C1 partial).
- **Structural note (all units):** 8b and 9b remain the largest units; if
  they do not fit one implementer pass at implementation time, split them
  further there and record the split in the commit.

**Escalation flag (standing, orchestrator):** units 3b, 7a/7b, 8b, 9a/9b
carry spec-semantics defects (pinned tables, state machines, fate table) —
route them to the escalation implementer rather than the default pool.
