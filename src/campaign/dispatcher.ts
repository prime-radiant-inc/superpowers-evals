// The campaign dispatcher (kernel D3, R-DSP-1..13): a THIN dispatcher over
// the shared execution primitive — CLI-argv children of the snapshot's own
// entrypoint, never in-process runScenario, runSchedule not generalized.
// Atomic per-block admission across subject pools + grader pool + the
// per-sample global cap; longest-expected-first + backfill; 429 cooldowns;
// E7 replacement/rerun entry with the ordered mint bundle; absolute-total
// budget snapshots with never-resurrects; the closed-window contention
// resolution batch; wave + block-terminal snapshot verify with the D-11
// drift response; D-13 storage-pause detection; halts; and D-12 signal
// handling in the pinned order. The pure cores sit first; the orchestrator
// (runCampaignDispatch and its seams) completes the module.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CommandRunner,
  defaultCommandRunner,
} from '../agents/command-runner.ts';
import type {
  Block,
  Campaign,
  Cell,
  ExecutionSurfaceArm,
} from '../contracts/campaign/campaign.ts';
import {
  attemptScopedRationale,
  type BlockReplacedRecord,
  type BlockRosterEntry,
  type JournalEvent,
  JournalEventSchema,
  normalizeBlockReplaced,
  SPEND_RECOVERED,
  UNPRICED_TERMINAL,
} from '../contracts/campaign/journal-events.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import {
  applySampleEvent,
  type SampleState,
} from '../contracts/campaign/state-machine.ts';
import type { BlockReplacementReason } from '../contracts/campaign/typed-failures.ts';
import type { Credential } from '../contracts/credential.ts';
import { RUN_ERROR_STAGES, type RunErrorStage } from '../contracts/verdict.ts';
import { getEnv } from '../env.ts';
import {
  type CancellableSleep,
  type Clock,
  RealClock,
} from '../scheduler/clock.ts';
import { loadFrozenCampaign } from './campaign-document.ts';
import { classifyFailure } from './classifier.ts';
import {
  type BlockInterval,
  type BreachWindow,
  ContentionSampler,
  evaluateContention,
  parseSidecar,
  type ResolvedThreshold,
  samplerStaleMs,
} from './contention.ts';
import { clockNowMs, type HostStatsProbe } from './host-stats.ts';
import {
  SnapshotDriftError,
  type SnapshotHandle,
} from './instrument-snapshot.ts';
import {
  createDurableMarker,
  type EventInput,
  electWriter,
  isStorageFullError,
  type JournalFsOps,
  releaseBallast,
} from './journal.ts';
import { resolveKeyForSpawnWithWait } from './key-select.ts';
import {
  type ProcessIdentityProbe,
  realProcessIdentityProbe,
} from './locks.ts';
import { attemptIdOf, rerunInstanceId } from './registration.ts';
import { resolveCampaignResultsRoot } from './results-root.ts';
import {
  auditExposure,
  type CredentialShape,
  decideExposureAtTerminal,
  ExposureTracker,
  gauntletEventStreamTexts,
  roleOfEvidenceSource,
  type SensorEvidenceSource,
  type SensorRole,
  senseEvidence,
  sensorAttributionRank,
  terminalEvidenceTexts,
  trajectoryExposureMs,
} from './sensors.ts';
import { GLOBAL_POOL } from './simulate.ts';
import {
  driftAffectedBlockIds,
  type InFlightBlock,
  verifyCampaignSnapshot,
} from './snapshot.ts';
import {
  buildCampaignChildArgv,
  type CampaignChildSpec,
  type ChildSpawner,
  composeCampaignChildEnv,
  DetachedChildSpawner,
  keyGrantsPayload,
  parseRunAllocatedLine,
  type SpawnedCampaignChild,
} from './spawn.ts';

export class DispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherError';
  }
}

export const SPAWN_FAILURE_HALT_N = 3;

/** R-DSP-1 + R-DSP-8: a block's demand vector is PER SAMPLE — 1 slot in
 *  the sample-arm's subject pool + 1 slot in the REAL registered grader
 *  credential's pool key + 1 global slot (Decision D-1) — aggregated by
 *  pool key (a two-arm block on one credential demands 2 slots from one
 *  subject pool). The grader pool is the registered credential's own key,
 *  never the simulator-reserved '__grader__' abstraction. */
export function blockDemandVector(args: {
  block: Block;
  sampleArmCredentialPool: (sampleId: string) => string;
  graderPool: string;
}): Map<string, number> {
  const demand = new Map<string, number>();
  for (const sampleId of args.block.sample_ids) {
    const subject = args.sampleArmCredentialPool(sampleId);
    demand.set(subject, (demand.get(subject) ?? 0) + 1);
    demand.set(args.graderPool, (demand.get(args.graderPool) ?? 0) + 1);
    demand.set(GLOBAL_POOL, (demand.get(GLOBAL_POOL) ?? 0) + 1);
  }
  return demand;
}

/** R-DSP-2: dispatch priority = the MAX expected duration across the
 *  block's samples (a two-arm block is as long as its longest arm).
 *  Fail-closed: estimates must be finite and non-negative — a NaN or
 *  negative estimate must never silently order a block. */
export function blockPrioritySeconds(args: {
  block: Block;
  sampleEstimateSeconds: (sampleId: string) => number;
}): number {
  if (args.block.sample_ids.length === 0) {
    throw new DispatcherError('blockPrioritySeconds: block has no samples');
  }
  let max = 0;
  for (const sampleId of args.block.sample_ids) {
    const seconds = args.sampleEstimateSeconds(sampleId);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new DispatcherError(
        `blockPrioritySeconds: invalid estimate for sample ${sampleId}: ${seconds}`,
      );
    }
    max = Math.max(max, seconds);
  }
  return max;
}

/** Deterministic admission tie-break (R-DSP-2): comparison ordinal,
 *  cell key, replicate ordinal, block kind (primary b before reserve x),
 *  rerun-lineage seq, then the raw id as the final arbiter — a TOTAL
 *  order over every valid block id (primary c<N>:<cell>:b<R>, reserve
 *  c<N>:<cell>:x<K>, rerun instance <root>:i<seq>; spec ID table).
 *  Ids outside the grammar sort last, ordered by raw id. */
export function compareAdmissionOrder(
  a: { block_id: string },
  b: { block_id: string },
): number {
  const parse = (
    id: string,
  ): {
    cmp: number;
    cell: string;
    rep: number;
    kind: string;
    lineage: number;
  } => {
    const m = /^c(\d+):([a-z0-9][a-z0-9._-]*):([bx])(\d+)(?::i(\d+))?$/.exec(
      id,
    );
    if (m === null) {
      return {
        cmp: Number.MAX_SAFE_INTEGER,
        cell: id,
        rep: 0,
        kind: '',
        lineage: 0,
      };
    }
    return {
      cmp: Number(m[1]),
      cell: m[2] ?? '',
      rep: Number(m[4]),
      kind: m[3] ?? '',
      lineage: m[5] === undefined ? 0 : Number(m[5]),
    };
  };
  const pa = parse(a.block_id);
  const pb = parse(b.block_id);
  if (pa.cmp !== pb.cmp) return pa.cmp - pb.cmp;
  if (pa.cell !== pb.cell) return pa.cell < pb.cell ? -1 : 1;
  if (pa.rep !== pb.rep) return pa.rep - pb.rep;
  if (pa.kind !== pb.kind) return pa.kind < pb.kind ? -1 : 1;
  if (pa.lineage !== pb.lineage) return pa.lineage - pb.lineage;
  return a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0;
}

/** E7.7: the absolute-total snapshot value — total remaining estimated
 *  exposure of the current budget-exposure set. Fail-closed: every cost
 *  must be finite and non-negative; an invalid cost must never silently
 *  enter a budget predicate. */
export function estimateInflightTotal(args: {
  exposureSamples: readonly { sampleId: string }[];
  estimateCostUsd: (sampleId: string) => number;
}): number {
  let total = 0;
  for (const s of args.exposureSamples) {
    const cost = args.estimateCostUsd(s.sampleId);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new DispatcherError(
        `estimateInflightTotal: invalid cost for sample ${s.sampleId}: ${cost}`,
      );
    }
    total += cost;
  }
  return total;
}

export interface ContentionResolutionResult {
  readonly batch: EventInput[];
  /** Predecessor -> the reserve it activated, with the mint record the
   *  instance-graph validator and the caller's bookkeeping consume, in
   *  obligation order. */
  readonly activated: readonly {
    predecessor: string;
    reserve: string;
    record: BlockReplacedRecord;
  }[];
  readonly suppressedCells: readonly string[];
  readonly exhaustedCells: readonly string[];
}

/** The closed-window resolution batch (dispatch and recovery share this —
 *  one obligation order, one per-obligation resolution). Emits, in the given
 *  obligation order: replacement_suppressed (durable budget stop wins), else
 *  a reason=contention replacement mint + roster dispositions, else
 *  reserve_exhausted. Skips obligations whose cell already carries a
 *  resolution (idempotent re-entry). Returns the batch plus the summary the
 *  dispatcher's bookkeeping and resolution line consume. */
export function contentionResolutionBatch(args: {
  obligations: readonly string[];
  budgetStopped: boolean;
  cellOf: (blockId: string) => string;
  /** Lowest still-unactivated reserve ordinal of the cell (R-DSP-5).
   *  `activatedInBatch` is the C6 batch-local activation set — two
   *  obligations in one cell can never select the same reserve. */
  reserveFor: (
    cellKey: string,
    activatedInBatch: ReadonlySet<string>,
  ) => string | undefined;
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
  /** E7.1 disposition-source filter: a predecessor already holding a
   *  standing terminal fact (instrument_failed, skew_excluded, …) keeps it
   *  and never receives excluded_block_replaced — replay rejects the
   *  disposition from those states (R-JRN-7). Non-null names the standing
   *  fact; null means a legal disposition source. The dispatcher passes its
   *  live state mirror; recovery passes a journal-derived lookup. */
  predecessorTerminalFact: (sampleId: string) => string | null;
}): ContentionResolutionResult {
  const batch: EventInput[] = [];
  const activated: ContentionResolutionResult['activated'][number][] = [];
  const suppressedCells: string[] = [];
  const exhaustedCells: string[] = [];
  const activatedInBatch = new Set<string>();
  /** Roster construction refuses unknown samples loudly — a silent '' arm
   *  would only surface later as a zod reject inside a mint critical
   *  section (BlockRosterEntrySchema pins arm min(1)). */
  const armOf = (sampleId: string): string => {
    const arm = args.armBySample.get(sampleId);
    if (arm === undefined) {
      throw new DispatcherError(
        `sample ${sampleId} is not in the frozen sample universe — roster construction refused`,
      );
    }
    return arm;
  };
  let stopped = args.budgetStopped;
  for (const blockId of args.obligations) {
    const cellKey = args.cellOf(blockId);
    if (args.resolvedCells.has(cellKey)) continue; // already resolved: skip
    const reserve = stopped
      ? undefined
      : args.reserveFor(cellKey, activatedInBatch);
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
        payload: {
          cell: cellKey,
          disposition: 'replacement_suppressed',
          rationale: 'budget_stopped',
        },
      });
      suppressedCells.push(cellKey);
      continue;
    }
    if (reserve === undefined) {
      batch.push({
        type: 'adjudication',
        payload: {
          cell: cellKey,
          disposition: 'reserve_exhausted',
          rationale: 'reserve_exhausted',
        },
      });
      exhaustedCells.push(cellKey);
      continue;
    }
    activatedInBatch.add(reserve);
    const predSamples = args.blockSamples.get(blockId) ?? [];
    const resSamples = args.blockSamples.get(reserve) ?? [];
    const roster: BlockRosterEntry[] = resSamples.map((sampleId) => {
      const arm = armOf(sampleId);
      const supersedes = predSamples.find((s) => armOf(s) === arm);
      return {
        sample_id: sampleId,
        arm,
        ...(supersedes !== undefined ? { supersedes } : {}),
      };
    });
    const record: BlockReplacedRecord = {
      block_id: blockId,
      replacement_block_id: reserve,
      reason: 'contention',
      kind: 'replacement',
      reserve_activation: true,
      roster,
    };
    // E7.1 mint bundle: block_replaced FIRST (durable successor + seal
    // obligation), then exactly the required predecessor dispositions in
    // roster order.
    batch.push({
      type: 'block_replaced',
      payload: {
        block_id: record.block_id,
        replacement_block_id: record.replacement_block_id,
        reason: record.reason,
        kind: record.kind,
        reserve_activation: record.reserve_activation,
        roster,
      },
    });
    for (const entry of roster) {
      if (entry.supersedes === undefined) continue;
      if (args.predecessorTerminalFact(entry.supersedes) !== null) continue;
      batch.push({
        type: 'sample_disposition',
        payload: {
          sample_id: entry.supersedes,
          disposition: 'excluded_block_replaced',
          superseded_by: entry.sample_id,
        },
      });
    }
    activated.push({ predecessor: blockId, reserve, record });
  }
  return { batch, activated, suppressedCells, exhaustedCells };
}

// ---------------------------------------------------------------------------
// The orchestrator (task 8b): seams, kill primitive, instance-graph
// validator, and runCampaignDispatch.
// ---------------------------------------------------------------------------

/** The wait-guard budget for key selection (R-SPN-6/7): the wait branch is
 *  unreachable under honest admission (len(keys) x ceil(cap/len) >= cap),
 *  so this bounds only miscalibration/recovery-rebuild before failing loud
 *  through the spawn-failure path. */
const KEY_WAIT_BUDGET_SECONDS = 300;
/** R-JRN-8: how long a disposition (mint) waits for a spawned sibling's
 *  `run_allocated:` line before dispositioning it from 'admitted'. The
 *  runner allocates its run dir before setup, so the wait is normally
 *  sub-second; the budget only bounds a child stuck pre-allocation. No
 *  pinned value exists — recorded, not silent. */
export const ALLOCATION_WAIT_BUDGET_SECONDS = 300;

/** TERM->KILL escalation grace per phase (Decision D-12 kill order). */
const KILL_GRACE_SECONDS = 5;

/** Cell key from a block id: strip lineage `:i<seq>` suffixes first, then
 *  the trailing `:b<N>` / `:x<K>` slot component. `c1:scn:b1` -> `c1:scn`;
 *  `c1:scn:b3:i2` -> `c1:scn`. */
export function cellKeyOfBlockId(blockId: string): string {
  const noLineage = blockId.replace(/(:i\d+)+$/, '');
  const m = /^(.*):[bx]\d+$/.exec(noLineage);
  return m !== null ? (m[1] ?? noLineage) : noLineage;
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

// --- C10: the ONE verified-kill primitive ----------------------------------

/** The group-signal seam: one channel for TERM/KILL and the 0-probe, so a
 *  fake pid in tests never reaches a real process group. 'esrch' is the
 *  only proof of death (the locks.ts identity discipline). */
export type GroupSignaler = (
  pgid: number,
  signal: NodeJS.Signals | 0,
) => 'ok' | 'esrch';

export const realGroupSignaler: GroupSignaler = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'esrch';
    // EPERM proves the group exists (it is just not signalable by us).
    if (code === 'EPERM') return 'ok';
    throw err;
  }
};

export interface KillGroupArgs {
  readonly pgid: number;
  /** OS start time captured at spawn (R-RCV-1 identity guard); null =
   *  unreadable at capture time — identity is then UNKNOWN and the helper
   *  refuses to signal blind (fail-closed). */
  readonly birthTsMs: number | null;
  readonly identity: ProcessIdentityProbe;
  readonly signal: GroupSignaler;
  readonly clock: Clock;
  readonly stream: { write(s: string): void };
  readonly graceSeconds: number;
}

/** THE awaited identity-guarded kill (C10; Decisions D-11/D-12/D-13 step
 *  5): identity guard -> TERM the group -> poll for death on the injected
 *  Clock -> escalate KILL after the grace -> verify again. Verified death
 *  is a HARD precondition for every caller's release/journal/mint: 'dead'
 *  (or 'stale' — the pid was reused, so the original process is provably
 *  gone; a reused pid is never signaled) are the only permitting results,
 *  and BOTH require the process GROUP to answer ESRCH — a dead leader whose
 *  group still holds live descendants is never permitting;
 *  'unknown' means the identity could not be established and NOTHING was
 *  signaled (fail-closed, never signal blind); 'alive' means the group
 *  survived TERM+KILL — the caller must abort its enclosing operation
 *  loudly. */
export async function killGroupVerified(
  args: KillGroupArgs,
): Promise<'dead' | 'stale' | 'alive' | 'unknown'> {
  /** Death is judged on the GROUP, never on the leader alone: a leaderless
   *  group can still hold live descendants that keep spending. For a leader
   *  that is provably gone (ESRCH outright, or a reused pid), only an ESRCH
   *  on the group permits; a group that still answers has no identifiable
   *  leader — identity UNKNOWN, nothing signaled (R-RCV-1 fail-closed). */
  const groupGoneWith = (
    permitting: 'dead' | 'stale',
    why: string,
  ): 'dead' | 'stale' | 'unknown' => {
    if (args.signal(args.pgid, 0) === 'esrch') return permitting;
    args.stream.write(
      `kill: pid ${args.pgid} ${why}, but its process group still answers — live descendants without an identifiable leader; identity UNKNOWN, nothing signaled (R-RCV-1 fail-closed)\n`,
    );
    return 'unknown';
  };
  if (args.identity.exists(args.pgid) === 'esrch') {
    return groupGoneWith('dead', 'leader is gone (ESRCH)');
  }
  const current = args.identity.startTimeMs(args.pgid);
  if (args.birthTsMs === null || current === null) {
    args.stream.write(
      `kill: pid ${args.pgid} identity UNKNOWN (recorded birth ${args.birthTsMs ?? 'unreadable'}, current start ${current ?? 'unreadable'}) — refusing to signal blind (R-RCV-1 fail-closed)\n`,
    );
    return 'unknown';
  }
  if (current !== args.birthTsMs) {
    args.stream.write(
      `kill: pid ${args.pgid} start time ${current} != recorded ${args.birthTsMs} — reused pid, never signaled (R-RCV-1)\n`,
    );
    return groupGoneWith('stale', 'leader pid was reused');
  }
  const pollSeconds = 0.05;
  const waitForDeath = async (deadline: number): Promise<boolean> => {
    for (;;) {
      if (args.signal(args.pgid, 0) === 'esrch') return true;
      const target = args.clock.now() + pollSeconds;
      if (target > deadline) return false;
      await args.clock.sleepUntil(target);
    }
  };
  if (args.signal(args.pgid, 'SIGTERM') === 'esrch') return 'dead';
  if (await waitForDeath(args.clock.now() + args.graceSeconds)) return 'dead';
  if (args.signal(args.pgid, 'SIGKILL') === 'esrch') return 'dead';
  if (await waitForDeath(args.clock.now() + args.graceSeconds)) return 'dead';
  args.stream.write(
    `kill: process group ${args.pgid} survived TERM+KILL past ${args.graceSeconds}s grace — verify-death FAILED\n`,
  );
  return 'alive';
}

// --- C5: the shared instance-graph validator -------------------------------

export interface InstanceGraphArgs {
  readonly campaign: Campaign;
  readonly mints: readonly BlockReplacedRecord[];
}

function refuse(message: string): never {
  throw new DispatcherError(`instance graph refused: ${message}`);
}

/** C5: THE instance-graph validator, shared by the dispatcher's mint path
 *  and the journal folds (E7.1 mint-bundle step 1 + E7.3a's frozen-document
 *  checks): replacement-vs-rerun roster/reserve rules, duplicate
 *  predecessors/successors (double reserve selection), cycles, and
 *  cross-cell/cross-arm links all refuse with a typed error. Mints are
 *  validated in seq order; a legacy empty replacement roster derives its
 *  same-arm pairing from the frozen membership (E7.2 round-trip). */
export function assertInstanceGraph(args: InstanceGraphArgs): void {
  const armBySample = new Map(
    args.campaign.samples.map((s) => [s.sample_id, s.arm]),
  );
  const cellBySample = new Map(
    args.campaign.samples.map((s) => [s.sample_id, s.cell]),
  );
  const blockById = new Map(args.campaign.blocks.map((b) => [b.block_id, b]));
  const rosterOf = new Map<string, readonly string[]>(
    args.campaign.blocks.map((b) => [b.block_id, b.sample_ids]),
  );
  const predecessors = new Set<string>();
  const successors = new Set<string>();
  for (const mint of args.mints) {
    const label = `${mint.block_id} -> ${mint.replacement_block_id} (${mint.reason})`;
    if (mint.block_id === mint.replacement_block_id) {
      refuse(`${label}: self-cycle`);
    }
    if (predecessors.has(mint.block_id)) {
      refuse(
        `${label}: duplicate predecessor — ${mint.block_id} is already superseded`,
      );
    }
    if (successors.has(mint.replacement_block_id)) {
      refuse(
        `${label}: duplicate successor — ${mint.replacement_block_id} is already activated (double selection)`,
      );
    }
    if (predecessors.has(mint.replacement_block_id)) {
      refuse(
        `${label}: successor ${mint.replacement_block_id} was already superseded — a mint into a replaced block is a cycle`,
      );
    }
    const cell = cellKeyOfBlockId(mint.block_id);
    if (cellKeyOfBlockId(mint.replacement_block_id) !== cell) {
      refuse(
        `${label}: cross-cell link (${cell} vs ${cellKeyOfBlockId(mint.replacement_block_id)})`,
      );
    }
    const predecessorRoster = rosterOf.get(mint.block_id);
    if (predecessorRoster === undefined) {
      refuse(
        `${label}: predecessor ${mint.block_id} has no frozen or minted membership`,
      );
    }
    let roster: readonly BlockRosterEntry[] = mint.roster;
    if (roster.length === 0) {
      if (mint.kind !== 'rerun') {
        // E7.2 legacy round-trip: derive the total same-arm pairing from
        // frozen membership; an underivable pairing refuses.
        const reserve = blockById.get(mint.replacement_block_id);
        if (reserve === undefined || reserve.slot !== 'reserve') {
          refuse(
            `${label}: legacy roster derivation needs a frozen reserve successor`,
          );
        }
        const predecessorByArm = new Map(
          predecessorRoster.map((s) => [armBySample.get(s) ?? '', s]),
        );
        roster = reserve.sample_ids.map((sampleId) => {
          const arm = armBySample.get(sampleId) ?? '';
          const supersedes = predecessorByArm.get(arm);
          if (supersedes === undefined) {
            refuse(
              `${label}: legacy roster derivation: no same-arm predecessor for ${sampleId}`,
            );
          }
          return { sample_id: sampleId, arm, supersedes };
        });
      } else {
        refuse(`${label}: a rerun mint must carry its roster`);
      }
    }
    const multiset = (ids: readonly string[]): string =>
      JSON.stringify([...ids].sort());
    if (mint.kind === 'replacement') {
      if (!mint.reserve_activation) {
        refuse(`${label}: a replacement must activate a reserve`);
      }
      const reserve = blockById.get(mint.replacement_block_id);
      if (reserve === undefined || reserve.slot !== 'reserve') {
        refuse(
          `${label}: replacement successor must be a frozen reserve block of the cell`,
        );
      }
      if (
        multiset(roster.map((e) => e.sample_id)) !==
        multiset(reserve.sample_ids)
      ) {
        refuse(
          `${label}: roster must be exactly the reserve block's frozen samples`,
        );
      }
      for (const entry of roster) {
        if (entry.supersedes === undefined) {
          refuse(
            `${label}: replacement roster entry ${entry.sample_id} lacks supersedes`,
          );
        }
        if (armBySample.get(entry.sample_id) !== entry.arm) {
          refuse(
            `${label}: roster arm ${entry.arm} != the frozen arm of ${entry.sample_id}`,
          );
        }
        if (armBySample.get(entry.supersedes) !== entry.arm) {
          refuse(
            `${label}: cross-arm link — ${entry.sample_id} (${entry.arm}) supersedes ${entry.supersedes} (${armBySample.get(entry.supersedes) ?? 'unknown arm'})`,
          );
        }
        if (!predecessorRoster.includes(entry.supersedes)) {
          refuse(
            `${label}: supersedes ${entry.supersedes} is not a sample of predecessor ${mint.block_id}`,
          );
        }
        if (
          cellBySample.get(entry.sample_id) !==
          cellBySample.get(entry.supersedes)
        ) {
          refuse(`${label}: cross-cell sample link on ${entry.sample_id}`);
        }
      }
    } else {
      if (mint.reserve_activation) {
        refuse(`${label}: a rerun is reserve-neutral`);
      }
      if (nextRerunInstanceId(mint.block_id) !== mint.replacement_block_id) {
        refuse(
          `${label}: rerun successor must be ${nextRerunInstanceId(mint.block_id)} (lineage rule)`,
        );
      }
      if (roster.some((e) => e.supersedes !== undefined)) {
        refuse(`${label}: rerun roster entries must not supersede`);
      }
      if (
        multiset(roster.map((e) => e.sample_id)) !== multiset(predecessorRoster)
      ) {
        refuse(
          `${label}: rerun roster must be count-neutral (the predecessor's own samples)`,
        );
      }
      for (const entry of roster) {
        if (armBySample.get(entry.sample_id) !== entry.arm) {
          refuse(
            `${label}: roster arm ${entry.arm} != the frozen arm of ${entry.sample_id}`,
          );
        }
      }
    }
    predecessors.add(mint.block_id);
    successors.add(mint.replacement_block_id);
    rosterOf.set(
      mint.replacement_block_id,
      roster.map((e) => e.sample_id),
    );
  }
}

// --- Seams ------------------------------------------------------------------

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
 *  the host-stats probe at the registered cadence, normalizing
 *  load1_per_core by the REGISTERED fingerprint's cpu_cores (C6).
 *  resumeCampaign (task 9, the sole production caller of
 *  runCampaignDispatch) passes this. */
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
        cpuCores: args.contention.host_fingerprint.cpu_cores,
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

/** The journal surface the dispatcher consumes (structurally satisfied by
 *  JournalWriter). Injectable as a TEST seam only (DispatchRunArgs.journal)
 *  so a failed/partially-landed append is drivable hermetically; production
 *  always elects the real writer. */
export interface DispatchJournal {
  appendEvent(input: EventInput): JournalEvent;
  appendEvents(inputs: readonly EventInput[]): JournalEvent[];
  readEvents(afterSeq?: number): JournalEvent[];
  readBudgetPosition(): { spend_usd: number; estimate_inflight_usd: number };
  release(): void;
}

export interface StoragePauseArgs {
  readonly campaignDir: string;
  readonly writer: DispatchJournal;
  /** D-13 step 5: verified kill of the campaign children; returns the
   *  UNVERIFIED groups (empty = all verified dead). */
  readonly killAll: () => Promise<readonly string[]>;
  readonly stream: { write(s: string): void };
  /** Durability seam for the step-6 marker (the publication primitives'
   *  JournalFsOps): production always writes through the real fs; a test
   *  recorder observes the fsync ORDER without mocking the write away. */
  readonly fsOps?: JournalFsOps;
}

/** D-13 pinned pause sequence, steps 2-6 (detection is the dispatcher's two
 *  sites: a storage-full journal append in appendCritical, a storage-full
 *  sidecar append via the sampler's onSampleError): halt admission ->
 *  release ballast -> journal storage_paused in the freed space -> kill
 *  children (verified) -> durable marker if the event did not land. Defined
 *  HERE (not recovery.ts) so those detection sites call it without a
 *  dispatcher<->recovery module cycle; task 9's resume reconciliation and D4
 *  import it from the dispatcher. */
export async function performStoragePause(
  args: StoragePauseArgs,
): Promise<void> {
  args.stream.write(
    'storage pause: ENOSPC — fail-stop (a journal that cannot write cannot record spend)\n',
  );
  // Step 3: release the ballast (unlink + fsync dir) to free the reserved
  // blocks for the pause evidence.
  try {
    releaseBallast(args.campaignDir);
  } catch (err) {
    args.stream.write(
      `storage pause: ballast release failed: ${(err as Error).message}\n`,
    );
  }
  // Step 4: journal storage_paused in the freed space (best-effort; the
  // marker below is the durable record if it cannot land).
  let journalFailure: string | null = null;
  try {
    args.writer.appendEvent({ type: 'storage_paused', payload: {} });
  } catch (err) {
    journalFailure = (err as Error).message;
  }
  // Step 5: kill the campaign children (verified TERM->KILL through the
  // C10 primitive) — AFTER the pause journal, so the pause is durable
  // before the evidence producers die. Verified death is a HARD
  // precondition here exactly as on every other kill path (Critical): an
  // unverified group is a storage-fatal outcome below, never a normal
  // return — a surviving child spends unrecorded on a full volume.
  const killFailures = await args.killAll();
  if (killFailures.length > 0) {
    args.stream.write(
      `storage pause: kill UNVERIFIED for ${killFailures.join(', ')} — operator action: verify and kill these process groups manually before resuming; a surviving child spends unrecorded on a full volume\n`,
    );
  }
  const killState =
    killFailures.length === 0
      ? 'children verified killed'
      : `surviving process groups (kill UNVERIFIED): ${killFailures.join(', ')}`;
  // Step 6: durable marker when the event did not land. A marker that is
  // already present and readable IS the durable record — EEXIST is a
  // success arm for this carrier (an earlier pause or a racing writer
  // landed it), never a failure.
  let markerFailure: string | null = null;
  if (journalFailure !== null) {
    const marker = join(args.campaignDir, '.storage-paused');
    try {
      // The marker is the ONLY durable record of this pause once the journal
      // append failed: file fsync + directory fsync, or a crash loses it.
      createDurableMarker(marker, '', args.fsOps);
    } catch (err) {
      markerFailure = markerCarrierFailure(marker, err);
      if (markerFailure === null) {
        args.stream.write(
          'storage pause: .storage-paused marker already present — it is the durable record\n',
        );
      }
    }
  }
  const reconcile = 'then run `quorum campaign run` to reconcile';
  // D-13: with NEITHER durable carrier landed, the pause has no record at
  // all — that is a storage-fatal outcome, thrown loudly, never a quiet
  // return (Important 5). The kill state is reported as it actually is.
  if (journalFailure !== null && markerFailure !== null) {
    throw new DispatcherError(
      `storage pause FATAL: neither durable carrier landed — the storage_paused journal event failed (${journalFailure}) AND the .storage-paused marker failed (${markerFailure}); the pause has NO durable record (D-13). ${killState}. Operator action: free space on the volume${killFailures.length > 0 ? ', verify and kill the surviving process groups manually' : ''}, ${reconcile}`,
    );
  }
  if (killFailures.length > 0) {
    throw new DispatcherError(
      `storage pause FATAL: kill UNVERIFIED for ${killFailures.join(', ')} — a surviving child spends unrecorded on a full volume (D-13 step 5). The pause record landed (${journalFailure === null ? 'storage_paused journaled' : '.storage-paused marker'}). Operator action: verify and kill these process groups manually, ${reconcile}`,
    );
  }
}

/** D-13 step 6, the EEXIST arm: the O_EXCL create lost to an existing path.
 *  A readable marker file supplies the durable record (null = carrier
 *  satisfied); any other error, or a present-but-unreadable path, is the
 *  carrier's failure text. */
/** null = the pause HAS a durable record after all (the O_EXCL create hit
 *  EEXIST and the marker already at that path is readable). Safe to bless
 *  because a FAILED durable creation removes the final name — an existing
 *  marker is one whose write completed, never a half-written residue. */
function markerCarrierFailure(marker: string, err: unknown): string | null {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? err.code
      : undefined;
  if (code !== 'EEXIST') return (err as Error).message;
  try {
    readFileSync(marker); // a directory or an unreadable file throws
    return null;
  } catch (readErr) {
    return `${(err as Error).message}; marker present but unreadable: ${(readErr as Error).message}`;
  }
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
    const v = JSON.parse(
      readFileSync(join(runDir, 'verdict.json'), 'utf8'),
    ) as {
      final?: string;
      final_reason?: string;
      error?: { stage?: string } | null;
    };
    if (
      v.final !== 'pass' &&
      v.final !== 'fail' &&
      v.final !== 'indeterminate'
    ) {
      return null;
    }
    const stageRaw = v.error?.stage;
    const stage =
      stageRaw !== undefined &&
      (RUN_ERROR_STAGES as readonly string[]).includes(stageRaw)
        ? (stageRaw as RunErrorStage)
        : undefined;
    return {
      outcome: v.final,
      ...(stage !== undefined ? { stage } : {}),
      reason: v.final_reason ?? '',
    };
  } catch {
    return null;
  }
}

/** C9: the ACTUAL terminal cost from run artifacts — the verdict's
 *  assembled economics block (src/economics.ts total_est_cost_usd). null =
 *  absent/invalid; the caller falls back to the registration estimate (the
 *  honest available number), never silently zero. */
export function runCostFromArtifacts(runDir: string): number | null {
  try {
    const v = JSON.parse(
      readFileSync(join(runDir, 'verdict.json'), 'utf8'),
    ) as {
      economics?: { total_est_cost_usd?: unknown } | null;
    };
    const cost = v.economics?.total_est_cost_usd;
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? cost
      : null;
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
   *  trajectoryExposureMs (sensors). null = exposure unestablished
   *  (fail-closed: gating blocks skew-breach on absence, R-SNS-4). */
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
  readonly installSignals?: (
    handler: (signal?: NodeJS.Signals) => void,
  ) => () => void;
  /** C10 kill seam; production default realGroupSignaler. */
  readonly signalGroup?: GroupSignaler;
  /** TERM->KILL escalation grace per phase; default KILL_GRACE_SECONDS.
   *  TEST seam (deterministic escalation under a FakeClock). */
  readonly killGraceSeconds?: number;
  /** Journal TEST seam only (see DispatchJournal); production elects the
   *  real writer with the frozen campaign document. */
  readonly journal?: DispatchJournal;
  /** Operator resume seam, filled by the dispatcher for halt clearance. */
  resumeAdmission?: (reason: string) => void;
  /** TEST seam only, filled by the dispatcher: a read-only view of the
   *  in-memory admission state, so a test can prove a failed admission
   *  left NO local residue (C9 mutate-after-append). Production never
   *  reads it. */
  inspect?: () => DispatchInspection;
}

export interface DispatchInspection {
  readonly liveBlockIds: readonly string[];
  readonly poolBusy: Readonly<Record<string, number>>;
  readonly exposureSampleIds: readonly string[];
}

export interface DispatchOutcome {
  readonly status:
    | 'completed'
    | 'cancelled'
    | 'signalled'
    | 'halted'
    | 'storage_paused';
  readonly reason?: string;
}

interface KeyGrants {
  subjectEnv?: string;
  graderEnv?: string;
}

interface LiveSampleState {
  readonly sampleId: string;
  readonly blockId: string;
  readonly arm: string;
  readonly attemptId: string;
  readonly subjectPool: string;
  grants: KeyGrants;
  child?: SpawnedCampaignChild;
  childBirthTsMs: number | null;
  runId?: string;
  serviceEnded: boolean;
  /** Force-killed (drift/signal/storage): later child callbacks are stale
   *  and never journal against the superseded block (C10). */
  abandoned: boolean;
}

interface LiveBlockState {
  readonly block: Block;
  readonly slot: 'primary' | 'reserve';
  readonly samples: LiveSampleState[];
  readonly admittedTsMs: number;
  /** Set when the last sample's service ends (D-11 window overlap input). */
  serviceEndTsMs?: number;
  /** Any sample classified instrument (whether or not an instrument_failure
   *  event was legal to land): the replacement path owns this block; the
   *  skew rule owns only determinate blocks (R-DSP-9). */
  instrumentFailed: boolean;
}

export async function runCampaignDispatch(
  args: DispatchRunArgs,
): Promise<DispatchOutcome> {
  const clock = args.clock ?? new RealClock();
  const stream = args.stream ?? {
    write: (s: string) => void process.stdout.write(s),
  };
  const spawner = args.spawner ?? new DetachedChildSpawner();
  // Production default is the REAL probe — a stub here would let a lease
  // reclamation misjudge a live holder (mandated behavior never rides a
  // fake default; tests inject their own probe).
  const identity: ProcessIdentityProbe =
    args.identity ?? realProcessIdentityProbe;
  const signalGroup = args.signalGroup ?? realGroupSignaler;
  const readVerdict = args.readVerdict ?? readVerdictSummary;
  const observeExposure = args.observeExposure ?? trajectoryExposureMs;
  const runner = args.runner ?? defaultCommandRunner;
  const killGrace = args.killGraceSeconds ?? KILL_GRACE_SECONDS;
  // Fail-closed intake: the frozen document is AUTHENTICATED, not merely
  // schema-parsed — recomputed digest, identity = digest, and closure over
  // cells/arms/refs (C1: no production-path cast bridges this read). Every
  // derivation below reads the document as an authority, so an unclosed
  // document would resolve to zero estimates and empty credential names.
  const campaign: Campaign = loadFrozenCampaign(args.campaignDir);
  if (args.snapshotVerify === undefined && args.snapshot === undefined) {
    throw new DispatcherError(
      'no SnapshotHandle and no snapshotVerify seam — the R-DSP-11 admission gate cannot run; `campaign run` passes the reconstructed handle',
    );
  }
  // ONE absolute results root for the whole run: the controller's run-dir
  // reads and the child's --out-root must name the same directory, and they
  // do not share a working directory (the child's cwd is the evals worktree).
  const resultsRoot = resolveCampaignResultsRoot(args.resultsRoot);
  /** Run-dir path for a protocol-line run id (the runner's allocation names
   *  the run dir after the run id under outRoot — Decision D-8 correlation;
   *  the identity file task 6c persists lives in the same dir). */
  const runDirOf = (runId: string): string => join(resultsRoot, runId);

  // The writer carries the frozen membership so its incremental projections
  // resolve attempt->block identically to a rebuild. It is held for the
  // whole run; readers (status/cancel polls) never take the lease. The
  // journal seam exists for tests only (failed-append injection, C9).
  const writer: DispatchJournal =
    args.journal ??
    electWriter({
      campaignDir: args.campaignDir,
      clock,
      identity,
      campaign,
    });

  let stopSampler: (() => void | Promise<void>) | null = null;
  let uninstallSignals: (() => void) | null = null;
  let storagePaused = false;

  try {
    // --- Frozen-document derivations --------------------------------------
    const armedBlocks = campaign.blocks.filter(
      (b) => (b.slot ?? 'primary') === 'primary',
    );
    const reserveBlocks = campaign.blocks.filter((b) => b.slot === 'reserve');
    const armBySample = new Map(
      campaign.samples.map((s) => [s.sample_id, s.arm]),
    );
    const sampleById = new Map(campaign.samples.map((s) => [s.sample_id, s]));
    const cellByKey = new Map(
      campaign.cells.map((c) => [`${c.comparison_id}:${c.scenario}`, c]),
    );
    /** Roster construction refuses unknown samples loudly — a silent '' arm
     *  would only surface later as a zod reject inside a mint critical
     *  section (BlockRosterEntrySchema pins arm min(1)). */
    const armOf = (sampleId: string): string => {
      const arm = armBySample.get(sampleId);
      if (arm === undefined) {
        throw new DispatcherError(
          `sample ${sampleId} is not in the frozen sample universe — roster construction refused`,
        );
      }
      return arm;
    };
    /** The frozen cell a sample belongs to. The authenticated document
     *  guarantees it resolves; an unresolvable one is corruption, and a
     *  substituted zero estimate or empty scenario name would spend real
     *  money against a fabricated figure. */
    const cellOfSample = (sampleId: string): Cell => {
      const sample = sampleById.get(sampleId);
      const cell =
        sample === undefined ? undefined : cellByKey.get(sample.cell);
      if (sample === undefined || cell === undefined) {
        throw new DispatcherError(
          `sample ${sampleId} does not resolve to a frozen cell — refusing to substitute an estimate for it`,
        );
      }
      return cell;
    };
    const estimateOfSample = (sampleId: string) => {
      const arm = armOf(sampleId);
      const estimate = cellOfSample(sampleId).estimates_by_arm[arm];
      if (estimate === undefined) {
        throw new DispatcherError(
          `sample ${sampleId} has no frozen estimate for arm ${arm} — refusing to price it as zero`,
        );
      }
      return estimate;
    };
    const sampleEstimate = (sampleId: string): number =>
      estimateOfSample(sampleId).cost_usd;
    const sampleDurationEstimate = (sampleId: string): number =>
      estimateOfSample(sampleId).duration_s;
    const scenarioOfSample = (sampleId: string): string =>
      cellOfSample(sampleId).scenario;
    const surfaceOfArm = (arm: string): ExecutionSurfaceArm => {
      const surface = campaign.execution_surface.find((a) => a.name === arm);
      if (surface === undefined) {
        throw new DispatcherError(
          `arm ${arm} is not in the frozen execution surface — refusing to dispatch it without a credential`,
        );
      }
      return surface;
    };
    const armCredentialName = (arm: string): string =>
      surfaceOfArm(arm).credential;
    const credentialOfArm = (arm: string): Credential => {
      const name = armCredentialName(arm);
      const cred = args.credentials[name];
      if (cred === undefined) {
        throw new DispatcherError(
          `credential ${name} for arm ${arm} not in the registry`,
        );
      }
      return cred;
    };
    const poolOfArm = (arm: string): string =>
      poolKey(credentialOfArm(arm), armCredentialName(arm));
    const graderCred = args.credentials[campaign.grader.credential];
    if (graderCred === undefined) {
      throw new DispatcherError(
        `grader credential ${campaign.grader.credential} not in the registry`,
      );
    }
    // R-DSP-8: the grader pool is the REAL registered credential's pool key
    // everywhere — demand, busy accounting, release, and sensor attribution
    // (never the simulator-reserved constant).
    const graderPool = poolKey(graderCred, campaign.grader.credential);
    /** The registered exposure-skew bound. Gating suites always carry one
     *  (SuiteSchema refinement); an exploratory suite without a bound can
     *  breach only on absence (fail-closed either way, R-SNS-4). */
    const maxSkewSeconds =
      campaign.suite.max_exposure_skew ?? Number.POSITIVE_INFINITY;
    const capOf = (cred: Credential): number =>
      cred.max_concurrency ?? (cred.key_pool?.length ?? 1) * 5;
    const globalCap = campaign.contention.global_run_cap;

    // Pool accounting (subject pools + grader + global).
    const poolBusy = new Map<string, number>();
    const poolBlockedUntil = new Map<string, number>();
    const poolCapOf = (pool: string): number => {
      if (pool === graderPool) return capOf(graderCred);
      if (pool === GLOBAL_POOL) return globalCap;
      for (const arm of campaign.execution_surface) {
        if (poolOfArm(arm.name) === pool)
          return capOf(credentialOfArm(arm.name));
      }
      throw new DispatcherError(`no capacity known for pool ${pool}`);
    };

    // KeySelector state (6b carry-forward): ONE persistent per-key in-flight
    // map per credential pool, sampled by reference on every resolution —
    // never recreated per sample.
    const inFlightByCred = new Map<string, Record<string, number>>();
    const inFlightFor = (credName: string): Record<string, number> => {
      let m = inFlightByCred.get(credName);
      if (m === undefined) {
        m = {};
        inFlightByCred.set(credName, m);
      }
      return m;
    };
    const incrementInFlight = (credName: string, envName: string): void => {
      const m = inFlightFor(credName);
      m[envName] = (m[envName] ?? 0) + 1;
    };
    const decrementInFlight = (credName: string, envName: string): void => {
      const m = inFlightFor(credName);
      m[envName] = Math.max(0, (m[envName] ?? 0) - 1);
    };

    // --- Journal mirror (replay parity) ------------------------------------
    // The dispatcher never appends what replay would refuse: a per-sample
    // state mirror driven by the SAME frozen reducer (applySampleEvent)
    // previews every bundle before it lands and commits from the appended
    // envelopes — one source of truth, no drift (C5's fold discipline).
    const mirrorStates = new Map<string, SampleState>();
    const attemptSample = new Map<string, string>();
    const rosterByBlock = new Map<string, readonly string[]>(
      campaign.blocks.map((b) => [b.block_id, b.sample_ids]),
    );
    const mirrorStateOf = (sampleId: string): SampleState =>
      mirrorStates.get(sampleId) ?? 'planned';
    const applyEventToMirror = (
      states: Map<string, SampleState>,
      bindings: Map<string, string>,
      rosters: Map<string, readonly string[]>,
      event: JournalEvent,
    ): void => {
      const advance = (sampleId: string): void => {
        const outcome = applySampleEvent(
          states.get(sampleId) ?? 'planned',
          event,
        );
        if (outcome.result === 'reject') {
          throw new DispatcherError(
            `refusing to journal ${event.type} for sample ${sampleId} from state ${states.get(sampleId) ?? 'planned'} — the frozen sample machine rejects it (replay corruption)`,
          );
        }
        if (outcome.result === 'apply') states.set(sampleId, outcome.next);
      };
      switch (event.type) {
        case 'attempt_created':
          bindings.set(event.payload.attempt_id, event.payload.sample_id);
          advance(event.payload.sample_id);
          break;
        case 'run_allocated':
        case 'run_completed':
        case 'instrument_failure': {
          const sampleId = bindings.get(event.payload.attempt_id);
          if (sampleId === undefined) {
            throw new DispatcherError(
              `${event.type} names attempt ${event.payload.attempt_id} never bound by attempt_created`,
            );
          }
          advance(sampleId);
          break;
        }
        case 'exposure_started':
        case 'slot_exhausted':
        case 'sample_disposition':
          advance(event.payload.sample_id);
          break;
        case 'budget_stopped':
          for (const sampleId of event.payload.sample_ids) advance(sampleId);
          break;
        case 'block_admitted':
        case 'aborted':
        case 'skew_excluded': {
          const roster = rosters.get(event.payload.block_id);
          if (roster === undefined) {
            throw new DispatcherError(
              `${event.type} names block ${event.payload.block_id} with no frozen or minted membership`,
            );
          }
          for (const sampleId of roster) advance(sampleId);
          break;
        }
        case 'block_replaced': {
          const rec = normalizeBlockReplaced(event.payload);
          const roster =
            rec.roster.length > 0
              ? rec.roster.map((e) => e.sample_id)
              : (campaign.blocks.find(
                  (b) => b.block_id === rec.replacement_block_id,
                )?.sample_ids ?? []);
          rosters.set(rec.replacement_block_id, [...roster]);
          break;
        }
        default:
          break; // campaign-scoped + accounting events: no sample transitions
      }
    };
    let lastSeq = 0;
    const commitMirror = (appended: readonly JournalEvent[]): void => {
      for (const event of appended) {
        applyEventToMirror(mirrorStates, attemptSample, rosterByBlock, event);
        lastSeq = event.seq;
      }
    };
    const previewMirror = (inputs: readonly EventInput[]): void => {
      const states = new Map(mirrorStates);
      const bindings = new Map(attemptSample);
      const rosters = new Map(rosterByBlock);
      let seq = 1;
      for (const input of inputs) {
        const event = JournalEventSchema.parse({
          seq: seq,
          ts_ms: input.ts_ms ?? 0,
          type: input.type,
          payload: input.payload,
        });
        seq += 1;
        applyEventToMirror(states, bindings, rosters, event);
      }
    };

    // --- Fold the journal prefix -------------------------------------------
    const events = writer.readEvents();
    const tracker = new ExposureTracker();
    const admittedBlockIds = new Set<string>();
    const supersededBlockIds = new Set<string>();
    const reserveActivated = new Set<string>();
    const skewExcludedBlocks = new Set<string>();
    const attemptSeqBySample = new Map<string, number>();
    const mintRecords: BlockReplacedRecord[] = [];
    /** E7.6 never-resurrects: samples SELECTED by a budget_stopped event are
     *  terminal forever — they never admit/spawn, and a reserve containing
     *  one can never activate. The stop does NOT latch the campaign: a
     *  raise (amendment fold below) widens the predicate and later blocks
     *  admit against the raised ceiling (Important 2). */
    const stoppedSamples = new Set<string>();
    let budgetUsd = campaign.budget.usd_all_in;
    let campaignOpenedTsMs: number | null = null;
    for (const event of events) {
      applyEventToMirror(mirrorStates, attemptSample, rosterByBlock, event);
      lastSeq = event.seq;
      switch (event.type) {
        case 'campaign_opened':
          campaignOpenedTsMs = event.ts_ms;
          break;
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
          break;
        case 'block_replaced': {
          const rec = normalizeBlockReplaced(event.payload);
          supersededBlockIds.add(rec.block_id);
          if (rec.reserve_activation)
            reserveActivated.add(rec.replacement_block_id);
          mintRecords.push(rec);
          break;
        }
        case 'budget_stopped':
          for (const sampleId of event.payload.sample_ids) {
            stoppedSamples.add(sampleId);
          }
          break;
        case 'amendment':
          // R-DSP-10: raise-only; the raise widens the budget predicate for
          // LATER work and NEVER resurrects budget_stopped samples (E7.6 —
          // stoppedSamples stays folded regardless of raise order).
          if (event.payload.kind === 'budget_raise') {
            budgetUsd += event.payload.amount_usd;
          }
          break;
        case 'pool_blocked':
          // Cooldowns survive a restart: rehydrate the max-until per pool.
          poolBlockedUntil.set(
            event.payload.pool_key,
            Math.max(
              poolBlockedUntil.get(event.payload.pool_key) ?? 0,
              event.payload.until_ts_ms,
            ),
          );
          break;
        case 'exposure_started':
          // R-SNS-2: monotonic single emission — a resume never re-emits a
          // landed exposure_started.
          tracker.observe(event.payload.sample_id, event.payload.ts);
          break;
        case 'skew_excluded':
          skewExcludedBlocks.add(event.payload.block_id);
          break;
        default:
          break;
      }
    }
    if (campaignOpenedTsMs === null) {
      throw new DispatcherError(
        'journal has no campaign_opened — not a published campaign (C6: the real opened timestamp anchors coverage, never a placeholder)',
      );
    }
    const openedTsMs = campaignOpenedTsMs;
    // C5: the folded prefix must itself satisfy the frozen instance model.
    assertInstanceGraph({ campaign, mints: mintRecords });

    // --- Budget position (E7.7 absolute totals) ----------------------------
    // The exposure set rehydrates from the mirror: admitted samples not yet
    // terminal per the journal (the crashed-session residue recovery, task
    // 9, aborts before production dispatch re-enters).
    const exposureSet = new Set<string>();
    for (const [sampleId, state] of mirrorStates) {
      if (state === 'admitted' || state === 'spawned' || state === 'exposed') {
        exposureSet.add(sampleId);
      }
    }
    const currentEstimateTotal = (): number =>
      estimateInflightTotal({
        exposureSamples: [...exposureSet].map((sampleId) => ({ sampleId })),
        estimateCostUsd: sampleEstimate,
      });
    let spendUsd = writer.readBudgetPosition().spend_usd;
    let estimateUsd = currentEstimateTotal();
    const snapshotEstimateInput = (): EventInput => ({
      type: 'budget_event',
      payload: {
        kind: 'estimate_inflight',
        amount_usd: currentEstimateTotal(),
      },
    });

    // --- Live state ---------------------------------------------------------
    const liveBlocks = new Map<string, LiveBlockState>();
    const waiting: Block[] = armedBlocks.filter(
      (b) =>
        !admittedBlockIds.has(b.block_id) &&
        !supersededBlockIds.has(b.block_id) &&
        // E7.6: a block holding a budget-stopped sample never admits.
        !b.sample_ids.some((s) => stoppedSamples.has(s)),
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
    // Rerun successors (`:iN`) are not in campaign.blocks and are rebuilt
    // from the mint roster; replacement successors are the frozen reserve
    // blocks. (An admitted-then-aborted successor is recovery's to re-mint,
    // task 9 — never silently re-admitted here without its own mint.)
    for (const mint of mintRecords) {
      if (
        admittedBlockIds.has(mint.replacement_block_id) ||
        supersededBlockIds.has(mint.replacement_block_id)
      ) {
        continue;
      }
      if (waiting.some((b) => b.block_id === mint.replacement_block_id))
        continue;
      if (mint.roster.some((r) => stoppedSamples.has(r.sample_id))) continue;
      if (mint.kind === 'rerun') {
        const root = lineageRootBlock(mint.replacement_block_id);
        if (root === undefined) continue; // unknown lineage: loud in replay
        rerunOf.set(mint.replacement_block_id, mint.block_id);
        waiting.push({
          ...root,
          block_id: mint.replacement_block_id,
          sample_ids: mint.roster.map((r) => r.sample_id),
        });
      } else {
        const reserve = reserveBlocks.find(
          (b) => b.block_id === mint.replacement_block_id,
        );
        if (reserve !== undefined) waiting.push(reserve);
      }
    }

    // --- Halts + control flags ---------------------------------------------
    let admissionHalted = false;
    let haltReason = '';
    let breachActive = false;
    /** Which breach entry `breachActive` belongs to: a deferred contention
     *  resolution may clear only the generation it was resolving — a newer
     *  live breach survives an older resolution's re-entry. */
    let breachGeneration = 0;
    let signalled = false;
    /** The stale-work guard for deferred re-entries: every control terminal
     *  (signal, storage pause, teardown) advances it; a re-entry captured
     *  under an older epoch is dropped AT EXECUTION inside the serialized
     *  section, so work queued before a terminal never journals after it
     *  (D-12: campaign_cancelled stays LAST). */
    let controlEpoch = 0;
    let cancelRequested = false;
    /** Session-local budget-stop state: once the R-DSP-6 predicate fails,
     *  no further admission happens THIS session (a raise cannot land
     *  mid-run — the dispatcher holds the writer); the durable facts are
     *  the budget_stopped events' selected samples. Unselected waiting
     *  blocks stay planned and admit next session under a raise (E7.6). */
    let stopInForce = false;
    /** One durable resolution per predecessor obligation (E7.1: once a
     *  mint/suppressed/exhausted resolution lands, later observations never
     *  add another). Session-local; recovery folds the durable rows. */
    const resolvedObligations = new Set<string>();
    const spawnFailuresByPool = new Map<string, number>();
    const haltedPools = new Set<string>();
    const driftIncidents: string[] = [];
    const sensorEvidenceBySample = new Map<
      string,
      { evidence: '429-match' | 'billing-exhaustion'; role: SensorRole }
    >();

    // The main loop parks on a 1s fallback clock sleep; service end, signal
    // handling, storage pause, and closed-window resolution wake it directly
    // so completion is observed without an external clock tick.
    let wake: (() => void) | null = null;
    const wakeLoop = (): void => {
      const w = wake;
      wake = null;
      if (w !== null) w();
    };

    // C11: THE serialized control critical section — every mint, terminal,
    // admission wave, sensor append, signal, and pause runs on this chain,
    // so a signal can never observe a partial mint bundle (D-12) and no two
    // control operations interleave. Section failures are fatal, loud, and
    // rethrown by the main loop — never swallowed.
    let activeSection: Promise<void> = Promise.resolve();
    let fatalError: unknown = null;
    const runExclusive = (op: () => void | Promise<void>): Promise<void> => {
      const next = activeSection.then(async () => {
        if (fatalError !== null) return;
        try {
          await op();
        } catch (err) {
          fatalError = err;
          wakeLoop();
        }
      });
      activeSection = next;
      return next;
    };

    const halt = (reason: string): void => {
      if (admissionHalted) return;
      admissionHalted = true;
      haltReason = reason;
      stream.write(`halt: ${reason} — admission stopped\n`);
    };
    /** Halt clearance. Called ONLY from inside the serialized control
     *  section (the drift repair path) or via the operator seam below —
     *  which routes through runExclusive, so no control state ever mutates
     *  off the section (Minor 2). */
    const clearAdmissionHalt = (reason: string): void => {
      if (!admissionHalted) return;
      admissionHalted = false;
      spawnFailuresByPool.clear();
      haltedPools.clear();
      stream.write(`resume: admission resumed (${reason})\n`);
      wakeLoop();
    };
    args.resumeAdmission = (reason: string): void => {
      void runExclusive(() => clearAdmissionHalt(reason));
    };
    args.inspect = (): DispatchInspection => ({
      liveBlockIds: [...liveBlocks.keys()],
      poolBusy: Object.fromEntries(poolBusy),
      exposureSampleIds: [...exposureSet],
    });

    // --- Verified kill over the live child handles (C10) --------------------
    /** C10 HARD precondition: journaling/release/mint happen ONLY after a
     *  group is verified dead through the one identity-guarded primitive.
     *  Returns the failures (identity-unknown / alive-after-KILL); a failed
     *  sample keeps its slots, its callbacks stay LIVE (its spend keeps
     *  being recorded honestly), and the caller must abort its enclosing
     *  operation loudly. Abandoned is set only AFTER verified death, so a
     *  surviving child's output is never suppressed. */
    const killBlockChildren = async (
      lb: LiveBlockState,
    ): Promise<{ failures: string[]; released: number }> => {
      const failures: string[] = [];
      // Every verified death is an exposure-membership change the caller
      // must journal (E7.7) — whether or not the whole block aborts.
      let released = 0;
      for (const sample of lb.samples) {
        if (sample.serviceEnded) continue;
        if (sample.child === undefined) {
          // Never spawned: nothing to kill; the release is trivially safe.
          sample.abandoned = true;
          releaseSample(sample);
          released += 1;
          continue;
        }
        const result = await killGroupVerified({
          pgid: sample.child.pid,
          birthTsMs: sample.childBirthTsMs,
          identity,
          signal: signalGroup,
          clock,
          stream,
          graceSeconds: killGrace,
        });
        if (result === 'alive' || result === 'unknown') {
          failures.push(
            `pgid ${sample.child.pid} (${sample.attemptId}: ${result})`,
          );
          continue;
        }
        // Verified dead ('dead', or 'stale' — the pid was reused, so the
        // original child is provably gone): suppress the now-stale
        // callbacks and release the slots.
        sample.abandoned = true;
        releaseSample(sample);
        released += 1;
      }
      return { failures, released };
    };
    const killAllChildren = async (): Promise<string[]> => {
      const failures: string[] = [];
      for (const lb of liveBlocks.values()) {
        failures.push(...(await killBlockChildren(lb)).failures);
      }
      return failures;
    };

    /** D-13 detection feeds here from both sites: a storage-full journal
     *  append (appendCritical) and a storage-full sidecar append (the
     *  sampler's onSampleError hook). Steps 2-6 run once; the loop exits
     *  with status 'storage_paused'; resume reconciliation is task 9's. */
    const enterStoragePause = async (origin: string): Promise<void> => {
      if (storagePaused) return;
      storagePaused = true;
      controlEpoch += 1; // deferred work captured before this is stale
      admissionHalted = true; // step 2: halt admission immediately
      haltReason = `storage pause: ${origin}`;
      stream.write(`storage pause detected (${origin})\n`);
      await performStoragePause({
        campaignDir: args.campaignDir,
        writer,
        killAll: killAllChildren,
        stream,
      });
      wakeLoop();
    };

    /** One dispatch critical section (E7.7/R-JRN-4): mirror-preview first
     *  (nothing replay-illegal ever lands — C9's abort-before-spawn rides
     *  this), then append; on a storage-full failure the landed prefix is
     *  committed to the mirror, the D-13 pause runs, and ONLY the unlanded
     *  suffix retries once into the freed extent with its ORIGINAL ts_ms
     *  (fate-table buffer row). Returns null when events could not land. */
    const appendCritical = async (
      inputs: readonly EventInput[],
    ): Promise<JournalEvent[] | null> => {
      const stamped = inputs.map((i) =>
        i.ts_ms !== undefined ? i : { ...i, ts_ms: clockNowMs(clock) },
      );
      previewMirror(stamped);
      const before = lastSeq;
      try {
        const appended = writer.appendEvents(stamped);
        commitMirror(appended);
        return appended;
      } catch (err) {
        // appendEvents lands one event per transaction: recover the durable
        // prefix so the mirror never diverges from the journal.
        const landedPrefix = writer.readEvents(before);
        commitMirror(landedPrefix);
        if (!isStorageFullError(err)) throw err;
        await enterStoragePause(
          `journal append storage-full: ${(err as Error).message}`,
        );
        const remaining = stamped.slice(landedPrefix.length);
        try {
          const appended = writer.appendEvents(remaining);
          commitMirror(appended);
          return [...landedPrefix, ...appended];
        } catch {
          stream.write(
            `storage pause: ${remaining.length} event(s) could not land even after ballast release — resume re-derives/buffers them per the D-13 fate table\n`,
          );
          return null;
        }
      }
    };

    // --- Service-end release (Decision D-1: child death, not the analytical
    //     terminal; retained-evidence exclusions hold slots to service end) --
    function releaseSample(sample: LiveSampleState): void {
      if (sample.serviceEnded) return;
      sample.serviceEnded = true;
      for (const pool of [sample.subjectPool, graderPool, GLOBAL_POOL]) {
        poolBusy.set(pool, Math.max(0, (poolBusy.get(pool) ?? 0) - 1));
      }
      if (sample.grants.subjectEnv !== undefined) {
        decrementInFlight(
          armCredentialName(sample.arm),
          sample.grants.subjectEnv,
        );
      }
      if (sample.grants.graderEnv !== undefined) {
        decrementInFlight(campaign.grader.credential, sample.grants.graderEnv);
      }
      exposureSet.delete(sample.sampleId);
      const lb = liveBlocks.get(sample.blockId);
      if (
        lb !== undefined &&
        lb.serviceEndTsMs === undefined &&
        lb.samples.every((s) => s.serviceEnded)
      ) {
        lb.serviceEndTsMs = clockNowMs(clock);
      }
      wakeLoop(); // a released slot is an admission instant + a completion edge
    }

    // --- Replacement obligations (R-DSP-5/6 + E7.1 ordered mint bundle) -----
    /** Lowest unactivated reserve ordinal of the cell (R-DSP-5 shared-reserve
     *  rule); `alsoActivated` is the C6 batch-local activation set. */
    const reserveForCell = (
      cellKey: string,
      alsoActivated?: ReadonlySet<string>,
    ): Block | undefined =>
      reserveBlocks
        .filter(
          (b) =>
            b.block_id.startsWith(`${cellKey}:x`) &&
            !reserveActivated.has(b.block_id) &&
            // E7.6: a reserve holding a budget-stopped sample never
            // activates — never resurrects.
            !b.sample_ids.some((s) => stoppedSamples.has(s)) &&
            !(alsoActivated?.has(b.block_id) ?? false),
        )
        .sort(compareAdmissionOrder)[0];
    /** E3's pinned reach: admitted-but-not-yet-spawned samples — spawning
     *  them after a stop would add a second spend wave. */
    const admittedUnspawnedSampleIds = (): string[] =>
      [...liveBlocks.values()].flatMap((lb) =>
        lb.samples
          .filter((s) => s.child === undefined && !s.serviceEnded)
          .map((s) => s.sampleId),
      );
    /** budget_stopped may only select planned|admitted samples (the frozen
     *  machine's edges) not already stopped. */
    const stoppableSelection = (candidates: readonly string[]): string[] =>
      [...new Set(candidates)].filter((s) => {
        const state = mirrorStateOf(s);
        return (
          (state === 'planned' || state === 'admitted') &&
          !stoppedSamples.has(s)
        );
      });

    type ObligationResolution =
      | {
          outcome: 'minted';
          events: EventInput[];
          reserve: Block;
          record: BlockReplacedRecord;
        }
      | { outcome: 'suppressed'; events: EventInput[] }
      | { outcome: 'exhausted'; events: EventInput[] };

    /** The SHARED resolution core (C6/C9): precedence per R-DSP-11's batch —
     *  a durable budget stop -> replacement_suppressed; no unactivated
     *  reserve -> reserve_exhausted (the sole carrier); otherwise the mint
     *  must first clear the R-DSP-6 dollar predicate against the reserve's
     *  priced exposure (EVERY replacement is budget-gated — a predicate
     *  failure fires the durable stop and suppresses this and every later
     *  obligation). The mint bundle is E7.1's: block_replaced FIRST, then
     *  exactly the required predecessor dispositions in roster order. */
    /** R-DSP-6 pass-through: a resolution-time mint must clear the dollar
     *  predicate against the reserve's priced exposure. Failure fires the
     *  durable stop (selection: E3's admitted-unspawned — planned waiting
     *  blocks stay unselected so a later raise admits them, E7.6) and
     *  returns its bundle; null means the mint may proceed. Shared by the
     *  single-obligation path and the closed-window batch's budgetGate. */
    const resolutionBudgetStop = (
      cellKey: string,
      reserve: Block,
    ): EventInput[] | null => {
      const reserveExposure = reserve.sample_ids.reduce(
        (sum, s) => sum + sampleEstimate(s),
        0,
      );
      if (spendUsd + Math.max(estimateUsd, 0) + reserveExposure <= budgetUsd) {
        return null;
      }
      stopInForce = true;
      const selected = stoppableSelection(admittedUnspawnedSampleIds());
      for (const s of selected) stoppedSamples.add(s);
      stream.write(
        `budget stop: replacement for ${cellKey} would exceed $${budgetUsd} — obligation suppressed; stopped samples never resurrect, a raise permits later work\n`,
      );
      return [
        { type: 'budget_stopped', payload: { sample_ids: selected } },
        snapshotEstimateInput(),
      ];
    };

    const resolveReplacementObligation = (params: {
      predecessorBlockId: string;
      predecessorSamples: readonly { sampleId: string; arm: string }[];
      reason: BlockReplacementReason;
      activatedInBatch?: ReadonlySet<string>;
    }): ObligationResolution => {
      const cellKey = cellKeyOfBlockId(params.predecessorBlockId);
      const reserve = reserveForCell(cellKey, params.activatedInBatch);
      const eventInputs: EventInput[] = [];
      if (!stopInForce && reserve !== undefined) {
        const stopBundle = resolutionBudgetStop(cellKey, reserve);
        if (stopBundle !== null) eventInputs.push(...stopBundle);
      }
      if (stopInForce) {
        eventInputs.push({
          type: 'adjudication',
          payload: {
            cell: cellKey,
            disposition: 'replacement_suppressed',
            rationale: 'budget_stopped',
          },
        });
        return { outcome: 'suppressed', events: eventInputs };
      }
      if (reserve === undefined) {
        eventInputs.push({
          type: 'adjudication',
          payload: {
            cell: cellKey,
            disposition: 'reserve_exhausted',
            rationale: 'reserve_exhausted',
          },
        });
        return { outcome: 'exhausted', events: eventInputs };
      }
      // Roster with same-arm supersedes pairing (total: one sample per arm).
      const predecessorByArm = new Map(
        params.predecessorSamples.map((s) => [s.arm, s.sampleId]),
      );
      const roster: BlockRosterEntry[] = reserve.sample_ids.map((sampleId) => {
        const arm = armOf(sampleId);
        const supersedes = predecessorByArm.get(arm);
        return {
          sample_id: sampleId,
          arm,
          ...(supersedes !== undefined ? { supersedes } : {}),
        };
      });
      const record: BlockReplacedRecord = {
        block_id: params.predecessorBlockId,
        replacement_block_id: reserve.block_id,
        reason: params.reason,
        kind: 'replacement',
        reserve_activation: true,
        roster,
      };
      // E7.1 mint bundle: block_replaced FIRST (durable successor + seal
      // obligation), then exactly the required predecessor dispositions, in
      // serialized roster order — one critical section.
      eventInputs.push({
        type: 'block_replaced',
        payload: {
          block_id: record.block_id,
          replacement_block_id: record.replacement_block_id,
          reason: record.reason,
          kind: record.kind,
          reserve_activation: record.reserve_activation,
          roster,
        },
      });
      // Dispositions: NONE for a skew refill (E7.2 — the excluded samples
      // keep their skew_excluded terminal; the block-level event carries the
      // conservation link). Otherwise one per supersedes pair whose
      // predecessor's state immediately before the mint is a LEGAL
      // disposition source (admitted|spawned|exposed|completed) — a
      // predecessor already instrument_failed or skew_excluded keeps that
      // terminal fact instead (R-JRN-7 / E7.3a).
      if (params.reason !== 'skew_refill') {
        for (const entry of roster) {
          if (entry.supersedes === undefined) continue;
          const state = mirrorStateOf(entry.supersedes);
          if (
            state === 'admitted' ||
            state === 'spawned' ||
            state === 'exposed' ||
            state === 'completed'
          ) {
            eventInputs.push({
              type: 'sample_disposition',
              payload: {
                sample_id: entry.supersedes,
                disposition: 'excluded_block_replaced',
                superseded_by: entry.sample_id,
              },
            });
          }
        }
      }
      return { outcome: 'minted', events: eventInputs, reserve, record };
    };

    /** R-JRN-8/R-SPN-5: run_allocated exactly once per run, pgid validated
     *  through the kill seam's 0-probe. Shared by the live stdout handler
     *  and the pre-mint allocation drain. A run whose allocation can no
     *  longer be journaled (the sample already holds a terminal — no legal
     *  run_allocated edge remains) keeps its run id in-memory and is LOUD:
     *  recovery's orphan sweep rides the run-dir identity file (6c). */
    const recordAllocation = async (
      sample: LiveSampleState,
      child: SpawnedCampaignChild,
      runId: string,
    ): Promise<void> => {
      if (sample.runId !== undefined) return;
      sample.runId = runId;
      const state = mirrorStateOf(sample.sampleId);
      if (state !== 'admitted') {
        // Unreachable by construction (the R-JRN-8 invariant): every
        // disposition or kill of a spawned-but-unallocated sample first
        // journals its latched allocation or verifies the child dead
        // (settlePendingAllocations / drainLatchedAllocations), and a dead
        // child's callbacks are abandoned — so no allocation can arrive
        // after a terminal. Reaching this is a broken invariant, not a
        // residual to log around.
        throw new DispatcherError(
          `invariant violated: allocation for ${sample.attemptId} (run ${runId}) arrived in state ${state} — a spawned sample is dispositioned only after its allocation is journaled or its child is verified dead (R-JRN-8)`,
        );
      }
      if (signalGroup(child.pid, 0) === 'esrch') {
        stream.write(
          `run_allocated for ${sample.attemptId} but process group ${child.pid} is gone — not journaling a dead pgid (R-SPN-2)\n`,
        );
        return;
      }
      await appendCritical([
        {
          type: 'run_allocated',
          payload: {
            attempt_id: sample.attemptId,
            run_id: runId,
            pgid: child.pid,
            ...keyGrantsPayload(sample.grants),
          },
        },
      ]);
    };
    /** Out-of-section allocation waits: the control section is never held
     *  while a child is slow to allocate (ENOSPC and signals must not queue
     *  behind a stuck child). Each wait is cancellable, so an early line or
     *  exit never leaves a budget timer holding the process, and teardown
     *  abandons whatever is still parked. */
    const pendingWaits = new Set<() => void>();
    let tearingDown = false;
    /** A live child's `run_allocated:` line: the latch first, then the
     *  subscription, bounded by the child's exit or the wait budget on the
     *  injectable clock. Resolves the run id, or null on exit / expiry /
     *  abandon. */
    const awaitAllocationLine = (
      child: SpawnedCampaignChild,
    ): Promise<string | null> =>
      new Promise((resolve) => {
        let settled = false;
        let budget: CancellableSleep | null = null;
        const abandon = (): void => settle(null);
        function settle(runId: string | null): void {
          if (settled) return;
          settled = true;
          budget?.cancel();
          pendingWaits.delete(abandon);
          resolve(runId);
        }
        for (const line of child.stdoutLines) {
          const runId = parseRunAllocatedLine(line);
          if (runId !== null) {
            settle(runId);
            return;
          }
        }
        child.onStdoutLine((line) => {
          const runId = parseRunAllocatedLine(line);
          if (runId !== null) settle(runId);
        });
        child.onExit(() => settle(null));
        if (settled) return; // a replayed latch or exit already won
        budget = clock.sleepUntilCancellable(
          clock.now() + ALLOCATION_WAIT_BUDGET_SECONDS,
        );
        void budget.expired.then((expired) => {
          if (expired) settle(null);
        });
        pendingWaits.add(abandon);
      });
    /** Spawned samples whose child is live and has not allocated (no run
     *  id, no latched line): the ones a disposition must wait for. */
    const pendingAllocationSamples = (lb: LiveBlockState): LiveSampleState[] =>
      lb.samples.filter(
        (s) =>
          s.child !== undefined &&
          !s.abandoned &&
          !s.serviceEnded &&
          s.runId === undefined &&
          !s.child.stdoutLines.some((l) => parseRunAllocatedLine(l) !== null),
      );
    /** Leave the control section, wait for every pending child concurrently
     *  (never serialized), then re-enter through runExclusive to apply. The
     *  re-entry is revalidated AT EXECUTION inside the section against the
     *  control epoch captured here: a signal, storage pause, or teardown
     *  section queued before it has run by then and advanced the epoch, so
     *  stale work journals nothing. */
    const deferUntilAllocated = (
      pending: readonly LiveSampleState[],
      label: string,
      reenter: () => Promise<void>,
    ): void => {
      const epoch = controlEpoch;
      const waits = pending.map((s) =>
        s.child === undefined
          ? Promise.resolve(null)
          : awaitAllocationLine(s.child),
      );
      void Promise.all(waits).then(() => {
        if (tearingDown) return; // nothing re-enters after the loop exited
        void runExclusive(async () => {
          if (controlEpoch !== epoch) {
            stream.write(
              `${label} dropped: stale control epoch (a signal, storage pause, or teardown landed during the wait)\n`,
            );
            return;
          }
          await reenter();
        });
      });
    };
    /** Blocks whose pending allocations were already waited for once: the
     *  re-entry settles them (journal or verified kill) instead of waiting
     *  again. */
    const waitedBlocks = new Set<string>();
    /** R-JRN-8 (Important 1): journal every LATCHED allocation of a block's
     *  spawned samples — the record lands exactly once, from 'admitted', so
     *  a following disposition applies from 'spawned' and a following kill
     *  journals a live pgid (R-SPN-2), never a dead one. Latch only: the
     *  kill paths never wait. */
    const drainLatchedAllocations = async (
      lb: LiveBlockState,
    ): Promise<void> => {
      if (storagePaused) return; // a full journal takes no allocation record
      for (const sample of lb.samples) {
        if (sample.abandoned || sample.runId !== undefined) continue;
        const child = sample.child;
        if (child === undefined) continue;
        for (const line of child.stdoutLines) {
          const runId = parseRunAllocatedLine(line);
          if (runId !== null) {
            await recordAllocation(sample, child, runId);
            break;
          }
        }
      }
    };
    /** The R-JRN-8 invariant a disposition relies on: after the
     *  out-of-section wait, every spawned sample of the block is either
     *  journaled allocated (latched line) or its child is VERIFIED DEAD
     *  before the disposition lands — no allocation can follow a terminal,
     *  which is what makes recordAllocation's post-terminal branch
     *  unreachable. A child that would not die is a failure the caller
     *  aborts on loudly (C10); every verified death is a released exposure
     *  the caller snapshots (E7.7). */
    const settlePendingAllocations = async (
      lb: LiveBlockState,
    ): Promise<{ failures: string[]; released: number }> => {
      await drainLatchedAllocations(lb);
      const failures: string[] = [];
      let released = 0;
      for (const sample of lb.samples) {
        const child = sample.child;
        if (
          child === undefined ||
          sample.abandoned ||
          sample.serviceEnded ||
          sample.runId !== undefined
        ) {
          continue;
        }
        stream.write(
          `allocation wait for ${sample.attemptId} expired (${ALLOCATION_WAIT_BUDGET_SECONDS}s budget, no run_allocated line) — killing the unallocated child before its disposition (R-JRN-8: no allocation can follow a terminal)\n`,
        );
        const result = await killGroupVerified({
          pgid: child.pid,
          birthTsMs: sample.childBirthTsMs,
          identity,
          signal: signalGroup,
          clock,
          stream,
          graceSeconds: killGrace,
        });
        if (result === 'alive' || result === 'unknown') {
          failures.push(`pgid ${child.pid} (${sample.attemptId}: ${result})`);
          continue;
        }
        sample.abandoned = true;
        releaseSample(sample);
        released += 1;
        if (child.stdoutLines.some((l) => parseRunAllocatedLine(l) !== null)) {
          // The line landed in the instant between the latch check and the
          // signal: an allocated run dir with no journal binding — R-RCV-4's
          // documented orphan, quarantined at reconciliation by its identity
          // file. Loud; never journaled against a dead pgid.
          stream.write(
            `${sample.attemptId}: run_allocated line latched moments before verified death — orphan run dir; recovery quarantines it by identity file (R-RCV-4)\n`,
          );
        }
        stream.write(
          `${sample.attemptId}: unallocated child verified dead before its disposition\n`,
        );
      }
      return { failures, released };
    };

    const mintReplacement = async (
      failedBlock: LiveBlockState,
      reason: BlockReplacementReason,
    ): Promise<void> => {
      // Idempotent per block: one mint per predecessor (a two-sample block
      // can fail twice — e.g. both spawns fail — but activates ONE fresh
      // block), and one durable resolution per obligation (a suppressed or
      // exhausted adjudication is never re-emitted, E7.1).
      if (supersededBlockIds.has(failedBlock.block.block_id)) return;
      if (resolvedObligations.has(failedBlock.block.block_id)) return;
      const blockId = failedBlock.block.block_id;
      // R-JRN-8: a spawned sibling still allocating defers the mint — its
      // allocation is awaited OUTSIDE the control section, then the mint
      // re-enters and settles every pending sample (journal or verified
      // kill) before any disposition lands.
      if (!waitedBlocks.has(blockId)) {
        const pending = pendingAllocationSamples(failedBlock);
        if (pending.length > 0) {
          waitedBlocks.add(blockId);
          stream.write(
            `replacement for ${blockId} deferred: waiting outside the control section (up to ${ALLOCATION_WAIT_BUDGET_SECONDS}s) for ${pending.map((s) => s.attemptId).join(', ')} to allocate (R-JRN-8)\n`,
          );
          deferUntilAllocated(pending, `replacement for ${blockId}`, () =>
            mintReplacement(failedBlock, reason),
          );
          return;
        }
      }
      const settled = await settlePendingAllocations(failedBlock);
      // E7.7 order: kills -> superseding snapshot -> budget reads. The
      // snapshot lands BEFORE the resolution reads the budget position, and
      // lands for the verified deaths even when a sibling's kill failed.
      // D-13: a snapshot that could not land (or landed only through the
      // storage pause) is the fail-stop terminal — no refresh, no budget
      // read, no resolution follows; the pause owns what happens next.
      if (settled.released > 0) {
        const snapshot = await appendCritical([snapshotEstimateInput()]);
        if (snapshot === null || storagePaused) {
          stream.write(
            `replacement for ${blockId} stopped: storage pause (D-13 fail-stop) — no resolution after the pause; resume re-derives the obligation\n`,
          );
          return;
        }
        estimateUsd = currentEstimateTotal();
      }
      if (settled.failures.length > 0) {
        stream.write(
          `replacement for ${blockId} REFUSED: kill unverified for ${settled.failures.join(', ')} — operator action: verify and kill these process groups manually, then resume; the obligation re-derives at \`quorum campaign run\`\n`,
        );
        halt(`unverified kill blocks the replacement of ${blockId}`);
        return;
      }
      const res = resolveReplacementObligation({
        predecessorBlockId: failedBlock.block.block_id,
        predecessorSamples: failedBlock.samples.map((s) => ({
          sampleId: s.sampleId,
          arm: s.arm,
        })),
        reason,
      });
      if (res.outcome === 'minted') {
        // C5: the mint path validates against the full instance graph
        // BEFORE anything lands.
        assertInstanceGraph({ campaign, mints: [...mintRecords, res.record] });
      }
      const appended = await appendCritical(res.events);
      if (appended === null) return;
      resolvedObligations.add(blockId);
      const cellKey = cellKeyOfBlockId(blockId);
      if (res.outcome === 'suppressed') {
        stream.write(
          `replacement suppressed for ${cellKey}: budget stopped (named shortfall)\n`,
        );
      } else if (res.outcome === 'exhausted') {
        stream.write(`reserve exhausted for ${cellKey}: named shortfall\n`);
      } else {
        mintRecords.push(res.record);
        reserveActivated.add(res.reserve.block_id);
        supersededBlockIds.add(blockId);
        waiting.push(res.reserve);
        stream.write(
          `replacement minted: ${blockId} -> ${res.reserve.block_id} (reason ${reason})\n`,
        );
        wakeLoop();
      }
      // D-11/R-DSP-11: a settle-kill that terminalized the block's last
      // child reaches the pinned block-terminal verification here — the
      // killed child's own exit callback is abandoned and would skip it.
      if (settled.released > 0) await onBlockTerminal(failedBlock);
    };

    // --- R-DSP-11 verify + Decision D-11 drift response ---------------------
    let currentSnapshot = args.snapshot;
    const verifySnapshotNow: () => void =
      args.snapshotVerify ??
      ((): void => {
        if (currentSnapshot === undefined) {
          throw new DispatcherError(
            'no SnapshotHandle to verify — the R-DSP-11 gate cannot run',
          );
        }
        verifyCampaignSnapshot(currentSnapshot, runner);
      });
    let lastCleanVerifyTsMs = clockNowMs(clock);

    const handleDrift = async (err: SnapshotDriftError): Promise<void> => {
      // (1) Admission halts (R-DSP-11).
      halt(`snapshot drift: ${err.message}`);
      // (2) Affected set (D-11 revised mapping): every block in flight at
      // any point during [last clean verify, re-materialization complete]
      // plus blocks with admitted-but-unspawned samples. Re-materialization
      // has not happened yet, so the window right edge is the conservative
      // +infinity.
      const inFlight: InFlightBlock[] = [...liveBlocks.values()].map((lb) => ({
        block_id: lb.block.block_id,
        admittedTsMs: lb.admittedTsMs,
        serviceEndTsMs: lb.serviceEndTsMs ?? null,
      }));
      const admittedUnspawned = [...liveBlocks.values()]
        .filter((lb) =>
          lb.samples.some((s) => s.child === undefined && !s.serviceEnded),
        )
        .map((lb) => lb.block.block_id);
      const affected = driftAffectedBlockIds({
        window: {
          lastCleanVerifyTsMs,
          rematerializedTsMs: Number.MAX_SAFE_INTEGER,
        },
        inFlight,
        admittedUnspawned,
      });
      // (3) Kill affected in-flight groups — the ONE identity-guarded
      // verified-kill primitive; verified death is a HARD precondition
      // (C10): aborted is journaled ONLY for blocks whose groups verified
      // dead, and any failure aborts the whole drift response loudly with a
      // named operator action — no repair, no rerun mint, no resume over a
      // possibly-live child. The membership change appends the superseding
      // snapshot in the same critical section (E7.7).
      const aborts: EventInput[] = [];
      const killFailures: string[] = [];
      let released = 0;
      for (const blockId of affected) {
        const lb = liveBlocks.get(blockId);
        if (lb === undefined) continue;
        const hadLive = lb.samples.some((s) => !s.serviceEnded);
        await drainLatchedAllocations(lb);
        const kill = await killBlockChildren(lb);
        released += kill.released;
        if (kill.failures.length > 0) {
          killFailures.push(...kill.failures);
          continue;
        }
        if (hadLive) {
          aborts.push({ type: 'aborted', payload: { block_id: blockId } });
        }
      }
      // E7.7: every verified death changed the exposure membership — the
      // superseding absolute snapshot lands whether or not a whole block
      // aborted (a mixed block journals no aborted but still released).
      if (aborts.length > 0 || released > 0) {
        const bundle = await appendCritical([
          ...aborts,
          snapshotEstimateInput(),
        ]);
        if (bundle === null || storagePaused) {
          // D-13 fail-stop: no repair, no rerun mint, no resume after the
          // pause; resume journals the aborts it re-derives (fate table).
          stream.write(
            'drift response stopped: storage pause (D-13 fail-stop) — no repair/rerun after the pause\n',
          );
          wakeLoop();
          return;
        }
        estimateUsd = currentEstimateTotal();
      }
      if (killFailures.length > 0) {
        stream.write(
          `drift response ABORTED: kill unverified for ${killFailures.join(', ')} — operator action: verify and kill these process groups manually, then re-run \`quorum campaign run\`; admission stays halted and no repair/rerun was performed for unverified blocks\n`,
        );
        driftIncidents.push(`unverified kills: ${killFailures.join(', ')}`);
        wakeLoop();
        return;
      }
      // A pause entered during the kill sweep's own appends (a latched
      // allocation, the abort bundle) owns what follows: no repair, no
      // rerun, no resume after it (D-13 fail-stop).
      if (storagePaused) {
        stream.write(
          'drift response stopped: storage pause (D-13 fail-stop) — no repair/rerun after the pause\n',
        );
        wakeLoop();
        return;
      }
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
        driftIncidents.push(
          `dirty after repair: ${(reverifyErr as Error).message}`,
        );
        wakeLoop();
        return;
      }
      lastCleanVerifyTsMs = clockNowMs(clock);
      // (6) Affected cells re-enter via E7 rerun instances — reserve- and
      // count-neutral: same samples, fresh block instance, next :i seq.
      const rerunRecords: BlockReplacedRecord[] = [];
      const rerunBundle: EventInput[] = [];
      for (const blockId of affected) {
        const lb = liveBlocks.get(blockId);
        if (lb === undefined || supersededBlockIds.has(blockId)) continue;
        const successorId = nextRerunInstanceId(blockId);
        const roster: BlockRosterEntry[] = lb.block.sample_ids.map(
          (sampleId) => ({ sample_id: sampleId, arm: armOf(sampleId) }),
        );
        const record: BlockReplacedRecord = {
          block_id: blockId,
          replacement_block_id: successorId,
          reason: 'snapshot_drift',
          kind: 'rerun',
          reserve_activation: false,
          roster,
        };
        rerunRecords.push(record);
        rerunBundle.push({
          type: 'block_replaced',
          payload: {
            block_id: record.block_id,
            replacement_block_id: record.replacement_block_id,
            reason: record.reason,
            kind: record.kind,
            reserve_activation: record.reserve_activation,
            roster,
          },
        });
      }
      if (rerunBundle.length > 0) {
        assertInstanceGraph({
          campaign,
          mints: [...mintRecords, ...rerunRecords],
        });
        const appended = await appendCritical(rerunBundle);
        if (appended === null) {
          wakeLoop();
          return;
        }
        for (const record of rerunRecords) {
          mintRecords.push(record);
          supersededBlockIds.add(record.block_id);
          rerunOf.set(record.replacement_block_id, record.block_id);
          const lb = liveBlocks.get(record.block_id);
          if (lb !== undefined) {
            waiting.push({
              ...lb.block,
              block_id: record.replacement_block_id,
            });
          }
          liveBlocks.delete(record.block_id);
        }
      }
      // (7) Incident recorded for the seal-time adjudication (D4 reads the
      // reason-'snapshot_drift' journal rows; the operator sees it now).
      driftIncidents.push(
        `drift repaired; ${affected.length} block(s) re-entered as reruns: ${affected.join(', ')}`,
      );
      // In-section clearance (the operator seam would defer to a later
      // section; the wave that detected the drift continues immediately).
      clearAdmissionHalt(
        `snapshot repaired + clean re-verify (${affected.length} rerun re-entries)`,
      );
      wakeLoop();
    };

    // --- Sensor evidence intake (D-10: the dispatcher supplies role +
    //     credential context; senseEvidence enforces per-source rows) -------
    const recordSensorText = async (
      sample: LiveSampleState,
      source: SensorEvidenceSource,
      text: string,
    ): Promise<void> => {
      // ONE campaign child carries both parties' traffic, but a single TEXT
      // belongs to exactly one of them: its source names the producer
      // (roleOfEvidenceSource). Classifying one text against both credential
      // contexts is what let a subject 429 attribute to the grader whenever
      // the two credentials share a provider.
      const role = roleOfEvidenceSource(source);
      const subjectCred = credentialOfArm(sample.arm);
      const runtimeFamily = surfaceOfArm(sample.arm).agent;
      const ctx: { credential: CredentialShape; pool: string } =
        role === 'subject'
          ? {
              credential: {
                api: subjectCred.api,
                ...(subjectCred.base_url !== undefined
                  ? { base_url: subjectCred.base_url }
                  : {}),
                runtimeFamily,
              },
              pool: sample.subjectPool,
            }
          : {
              credential: {
                api: graderCred.api,
                ...(graderCred.base_url !== undefined
                  ? { base_url: graderCred.base_url }
                  : {}),
              },
              pool: graderPool,
            };
      const signal = senseEvidence({
        source,
        role,
        credential: ctx.credential,
        text,
      });
      if (signal === null) return;
      const candidate = { evidence: signal.evidence, role: signal.role };
      const existingEv = sensorEvidenceBySample.get(sample.sampleId);
      if (
        existingEv === undefined ||
        sensorAttributionRank(candidate) < sensorAttributionRank(existingEv)
      ) {
        sensorEvidenceBySample.set(sample.sampleId, candidate);
      }
      if (signal.evidence === '429-match') {
        // R-DSP-3: journaled cooldown, D-10 clamped retry-after; duplicate
        // arbitration coalesces into one pool_blocked with the max until.
        const until = clockNowMs(clock) + signal.cooldownMs;
        const existing = poolBlockedUntil.get(ctx.pool);
        if (existing === undefined || until > existing) {
          poolBlockedUntil.set(ctx.pool, until);
          await appendCritical([
            {
              type: 'pool_blocked',
              payload: { pool_key: ctx.pool, until_ts_ms: until },
            },
          ]);
        }
      }
    };

    // --- Runtime skew + exposure audit (R-DSP-9; R-SNS-4; Decision D-9) ----
    const decideBlockSkew = async (lb: LiveBlockState): Promise<void> => {
      if (supersededBlockIds.has(lb.block.block_id)) return;
      if (skewExcludedBlocks.has(lb.block.block_id)) return;
      // Instrument-failed blocks are the replacement path's; skew owns only
      // determinate blocks.
      if (lb.instrumentFailed) return;
      // A sample still 'admitted' at block terminal never allocated (its
      // child was settle-killed or died pre-allocation): the machine pins
      // skew_excluded from spawned|exposed only, so there is no exclusion
      // edge to journal. The block's fate belongs to the obligation that
      // killed it (an aborted contention batch re-derives at resume) or to
      // recovery's pre-run_allocated window (attempt void, re-admit). Loud,
      // never a fabricated exclusion.
      const unallocated = lb.samples.filter(
        (s) => mirrorStateOf(s.sampleId) === 'admitted',
      );
      if (unallocated.length > 0) {
        stream.write(
          `block terminal: ${lb.block.block_id} has unallocated sample(s) ${unallocated.map((s) => s.attemptId).join(', ')} — skew undecidable (no exclusion edge from admitted); left to its pending obligation or recovery\n`,
        );
        return;
      }
      if (campaign.suite.kind === 'gating') {
        // D-9 exposure audit at the decision point: the decided value vs the
        // capture re-derivation; an inclusion-flipping divergence invalidates
        // the block through the reserved reason (sensors classify; the
        // dispatcher journals).
        for (const s of lb.samples) {
          const decided = tracker.value(s.sampleId);
          const rederived =
            s.runId !== undefined ? observeExposure(runDirOf(s.runId)) : null;
          const others = lb.samples
            .filter((o) => o.sampleId !== s.sampleId)
            .map((o) => tracker.value(o.sampleId));
          const includedAt = (tsMs: number): boolean => {
            const known = others.filter((o): o is number => o !== null);
            if (known.length !== others.length) return false; // absence: fail-closed
            const all = [tsMs, ...known];
            return (
              (Math.max(...all) - Math.min(...all)) / 1000 <= maxSkewSeconds
            );
          };
          const audit = auditExposure({
            decidedTsMs: decided,
            rederivedTsMs: rederived,
            includedAt,
          });
          if (audit.invalidationReason !== null) {
            stream.write(
              `exposure audit: sample ${s.sampleId} decided ${decided ?? 'absent'} vs re-derived ${rederived ?? 'absent'} flips inclusion — invalidating block ${lb.block.block_id} (D-9)\n`,
            );
            await mintReplacement(lb, audit.invalidationReason);
            return;
          }
        }
      }
      const exposures = lb.samples.map((s) => tracker.value(s.sampleId));
      const missing = exposures.some((e) => e === null);
      const known = exposures.filter((e): e is number => e !== null);
      const skewSeconds =
        known.length > 1 ? (Math.max(...known) - Math.min(...known)) / 1000 : 0;
      const breached = missing || skewSeconds > maxSkewSeconds;
      if (!breached) return;
      const detail = missing
        ? 'exposure unestablished by the decision point (fail-closed, R-SNS-4)'
        : `exposure skew ${Math.round(skewSeconds)}s > registered ${maxSkewSeconds}s`;
      if (campaign.suite.kind !== 'gating') {
        // Exploratory: a rendered caveat, never an exclusion (R-DSP-9).
        stream.write(
          `exposure-skew caveat (exploratory): block ${lb.block.block_id} — ${detail}\n`,
        );
        return;
      }
      // Gating: excluded from the paired comparison + refilled from reserve.
      // Journal expression is E7.2: skew_excluded fans out over the block's
      // roster; the refill mint carries reason 'skew_refill' and NO
      // dispositions (the samples keep their skew_excluded terminal; the
      // conservation link rides the mint's roster supersedes pairs).
      skewExcludedBlocks.add(lb.block.block_id);
      const excluded = await appendCritical([
        { type: 'skew_excluded', payload: { block_id: lb.block.block_id } },
      ]);
      if (excluded === null || storagePaused) return; // D-13 fail-stop: the refill re-derives at resume
      stream.write(
        `skew excluded: block ${lb.block.block_id} — ${detail} — refilling from reserve\n`,
      );
      await mintReplacement(lb, 'skew_refill');
    };

    /** D2 cadence point 2 of 3 (R-DSP-11): the block-terminal skew decision
     *  (R-DSP-9, gating) then the snapshot verification, reached from EVERY
     *  way a block's last child ends — its exit callback, or a settle-kill
     *  whose abandoned callback never runs. */
    const onBlockTerminal = async (block: LiveBlockState): Promise<void> => {
      if (storagePaused || !block.samples.every((s) => s.serviceEnded)) return;
      await decideBlockSkew(block);
      // The skew decision may itself have entered the D-13 pause (its
      // skew_excluded row could not land): the pause owns what follows — no
      // verification, no drift repair after it.
      if (storagePaused) return;
      try {
        verifySnapshotNow();
        lastCleanVerifyTsMs = clockNowMs(clock);
        stream.write(
          `block terminal: ${block.block.block_id} — snapshot verified (R-DSP-11 cadence point 2)\n`,
        );
      } catch (err) {
        if (err instanceof SnapshotDriftError) await handleDrift(err);
        else throw err;
      }
    };

    // --- Child supervision --------------------------------------------------
    const superviseSample = (
      sample: LiveSampleState,
      child: SpawnedCampaignChild,
      block: LiveBlockState,
    ): void => {
      sample.child = child;
      child.onStdoutLine((line) => {
        void runExclusive(async () => {
          if (sample.abandoned) return;
          const runId = parseRunAllocatedLine(line);
          if (runId === null) return;
          // R-JRN-8: journaled exactly once per run in the dispatch
          // critical section, grants payload names only (E7.5); the shared
          // helper is also the pre-mint drain's path (Important 1).
          await recordAllocation(sample, child, runId);
        });
      });
      child.onStderrLine((line) => {
        void runExclusive(async () => {
          if (sample.abandoned) return;
          await recordSensorText(sample, 'child_stderr', line);
        });
      });
      child.onExit((info) => {
        void runExclusive(async () => {
          if (sample.abandoned) return;
          releaseSample(sample);
          const runDir =
            sample.runId !== undefined ? runDirOf(sample.runId) : null;
          // Terminal evidence sweep (R-SNS-1: verdict reason, gauntlet
          // result, event stream — ALWAYS read at terminal): every source is
          // evaluated and the classifier-rank arbitration lets the
          // strongest/most-specific terminal evidence override an earlier
          // weaker live match (Important 4).
          if (runDir !== null) {
            for (const t of [
              ...terminalEvidenceTexts(runDir),
              ...gauntletEventStreamTexts(runDir),
            ]) {
              await recordSensorText(sample, t.source, t.text);
            }
          }
          // Terminal classification (the R-JRN emitters contract: child exit
          // -> VERDICT READ -> run_completed | instrument_failure). A child
          // that died before composing has no verdict and classifies through
          // the exit-code heuristic (crash/signal rows).
          const verdict = runDir !== null ? readVerdict(runDir) : null;
          const sensed = sensorEvidenceBySample.get(sample.sampleId);
          const outcome =
            verdict?.outcome ?? (info.code === 0 ? 'pass' : 'indeterminate');
          const classification = classifyFailure({
            outcome,
            ...(verdict?.stage !== undefined ? { stage: verdict.stage } : {}),
            exitClass:
              info.signal !== null
                ? 'signal'
                : info.code === 0
                  ? 'clean'
                  : 'crash',
            role: sensed?.role ?? 'subject',
            sensorEvidence: sensed?.evidence ?? 'none',
          });
          if (classification.class === 'instrument') {
            block.instrumentFailed = true;
          }
          // R-SNS-2/3/5 + D-9 + R-SNS-4: the exposure terminal decision —
          // the runtime-pinned value wins, the capture re-derivation fills
          // a silent probe, and absence resolves to the suite-kind-enforced
          // outcome (sensors decide; the dispatcher journals). Exposure
          // lands BEFORE the terminal event (spawned -> exposed -> terminal
          // is the machine's only legal order); monotonic single emission
          // via the tracker; payload field is `ts`. Absence stays absent —
          // never fabricated. A disposed sample has no legal exposure edge
          // and is not re-journaled.
          const exposure = decideExposureAtTerminal({
            runtimeTsMs: tracker.value(sample.sampleId),
            captureTsMs: runDir !== null ? observeExposure(runDir) : null,
            suiteKind: campaign.suite.kind,
          });
          if (
            exposure.established &&
            mirrorStateOf(sample.sampleId) === 'spawned' &&
            tracker.observe(sample.sampleId, exposure.tsMs)
          ) {
            await appendCritical([
              {
                type: 'exposure_started',
                payload: { sample_id: sample.sampleId, ts: exposure.tsMs },
              },
            ]);
          }
          // The terminal event — only where the frozen machine has a legal
          // edge (nothing replay-illegal ever lands):
          const state = mirrorStateOf(sample.sampleId);
          // R-SNS-4 exploratory arm (operator amendment 2026-08-27): a
          // determinate child whose exposure never established completes
          // from spawned with the caveat recorded on the event — never
          // withheld, never a dangling nonterminal. Gating absence is a
          // skew breach the block-terminal decision resolves instead.
          const exposureCaveat =
            state === 'spawned' &&
            !exposure.established &&
            exposure.resolution === 'render_caveat';
          // The terminal evidence and its spend are ONE critical section
          // (the D-13 fate table pairs them): a crash between two appends
          // would leave a terminal attempt that recovery skips, after which
          // startup re-snapshots exposure without ever recording its spend.
          const terminalEvents: EventInput[] = [];
          if (classification.class === 'instrument') {
            if (
              (state === 'spawned' || state === 'exposed') &&
              classification.cause !== undefined
            ) {
              terminalEvents.push({
                type: 'instrument_failure',
                payload: {
                  attempt_id: sample.attemptId,
                  cause: classification.cause,
                },
              });
            } else {
              // Never-allocated ('admitted') or already-disposed samples
              // carry the typed cause on the MINT; a late instrument_failure
              // would be replay-illegal or demand a second mint (seal
              // clause 3).
              stream.write(
                `typed instrument evidence for ${sample.attemptId} (${classification.cause ?? 'unknown'}) carried by the mint — state ${state} has no legal instrument_failure edge\n`,
              );
            }
          } else {
            if (
              state === 'exposed' ||
              state === 'completed' ||
              state === 'excluded_block_replaced' ||
              state === 'skew_excluded' ||
              state === 'aborted' ||
              exposureCaveat
            ) {
              // Determinate/aborted evidence: legal from exposed; late-legal
              // (retained evidence) from analytic terminals; from spawned
              // only under the exploratory caveat.
              terminalEvents.push({
                type: 'run_completed',
                payload: {
                  attempt_id: sample.attemptId,
                  outcome,
                  ...(exposureCaveat
                    ? { caveat: 'exploratory_exposure_unestablished' as const }
                    : {}),
                },
              });
              if (exposureCaveat) {
                stream.write(
                  `exposure caveat (exploratory): ${sample.attemptId} completed with exposure unestablished by the decision point (R-SNS-4) — caveat recorded on run_completed\n`,
                );
              }
            } else {
              stream.write(
                `run_completed for ${sample.attemptId} withheld from state ${state}: exposure unestablished (fail-closed, R-SNS-4 — gating resolves it at the block-terminal skew decision)\n`,
              );
            }
          }
          // Terminal spend: the ACTUAL run cost from the run artifacts.
          // R-JRN-12 pins that spend rows carry actuals, so an unreadable
          // cost is journaled as an accounting gap, never as the
          // registration estimate — fabricating one would put a number that
          // was never spent into the sealed accounting.
          const spendAmount =
            runDir !== null ? runCostFromArtifacts(runDir) : null;
          const cell = cellOfSample(sample.sampleId);
          if (spendAmount !== null) {
            spendUsd += spendAmount;
            // EVERY journaled spend — live or recovery — is immediately
            // preceded by the receipt naming its attempt. That is what lets
            // a later resume tell "already paid" per attempt instead of
            // positionally: without it, a terminal-less live spend (the
            // exposure-absent gating path below withholds run_completed)
            // leaves recovery no way to know the attempt was charged, and
            // it charges again.
            terminalEvents.push(
              {
                type: 'adjudication',
                payload: {
                  cell: `${cell.comparison_id}:${cell.scenario}`,
                  disposition: SPEND_RECOVERED,
                  rationale: attemptScopedRationale(
                    sample.attemptId,
                    `actual cost of run ${sample.runId ?? '<unallocated>'} at terminal`,
                  ),
                },
              },
              {
                type: 'budget_event',
                payload: { kind: 'spend', amount_usd: spendAmount },
              },
            );
          } else {
            // Fail-closed accounting gap. No spend row may be invented, but
            // continuing would admit further work against a position that
            // has silently dropped a real cost — permanently understating
            // the budget. So the gap is journaled durably (the pinned
            // machine-disposition convention on `adjudication`) and the
            // campaign fail-stops, D-13 style: the operator resolves it.
            terminalEvents.push({
              type: 'adjudication',
              payload: {
                cell: `${cell.comparison_id}:${cell.scenario}`,
                disposition: UNPRICED_TERMINAL,
                rationale: attemptScopedRationale(
                  sample.attemptId,
                  `run ${sample.runId ?? '<unallocated>'} terminaled with no readable actual cost in its run artifacts; R-JRN-12 forbids journaling an estimate as spend`,
                ),
              },
            });
          }
          terminalEvents.push(snapshotEstimateInput());
          const spendBundle = await appendCritical(terminalEvents);
          // D-13 fail-stop: a spend bundle that could not land (or landed
          // only through the storage pause) ends this terminal here — no
          // refresh, no replacement resolution, no block-terminal work; the
          // pause owns what happens next and resume re-derives the rest.
          if (spendBundle === null || storagePaused) {
            stream.write(
              `terminal for ${sample.attemptId} stopped: storage pause (D-13 fail-stop) — no resolution after the pause\n`,
            );
            return;
          }
          if (spendAmount === null) {
            const runName = sample.runId ?? '<unallocated>';
            halt(
              `accounting gap: attempt ${sample.attemptId} terminaled with no readable actual cost (run ${runName})`,
            );
            stream.write(
              `operator action: the budget position cannot account for run ${runName}. Restore its verdict economics at ${runDirOf(runName)}, then re-run \`quorum campaign run\` — the resume re-reads that run dir, journals the restored actual spend, and continues. While it stays unpriced every resume refuses; if the cost is unrecoverable the campaign's accounting must be adjudicated at seal. Nothing further is admitted and no replacement is resolved for this terminal.\n`,
            );
            return;
          }
          estimateUsd = currentEstimateTotal();
          // R-DSP-5: a typed instrument failure activates a fresh full block
          // (budget-gated inside the shared resolution core).
          if (
            classification.class === 'instrument' &&
            classification.cause !== undefined
          ) {
            await mintReplacement(block, classification.cause);
          }
          // Block terminal: the skew decision (R-DSP-9, gating) runs first,
          // then D2 cadence point 2 of 3 (R-DSP-11): verify at BLOCK
          // terminal (the third point, pre-seal, is D4's).
          await onBlockTerminal(block);
        });
      });
    };

    // --- Spawn (R-SPN; 6a/6b carry-forwards) --------------------------------
    /** Launch one admitted sample. 'fail-stop' tells the enclosing spawn
     *  loop that the D-13 storage pause landed inside this launch (its
     *  release snapshot could not land): nothing further may be launched —
     *  the pause's kill sweep already abandoned the block's unspawned
     *  siblings, and a child spawned after it would spend unjournaled. */
    const spawnSample = async (
      live: LiveBlockState,
      sample: LiveSampleState,
    ): Promise<'spawned' | 'failed' | 'fail-stop'> => {
      try {
        const subjectCred = credentialOfArm(sample.arm);
        const subjectName = armCredentialName(sample.arm);
        // Key selection strictly below admission (Decision D-1), through the
        // converged wait guard over the persistent per-pool counters; both
        // roles resolve (C4) and the selected VALUES project into the child
        // env (R-SPN-3/7).
        const subjectRes = await resolveKeyForSpawnWithWait({
          cred: subjectCred,
          credentialName: subjectName,
          inFlight: inFlightFor(subjectName),
          clock,
          warn: stream,
          waitSeconds: KEY_WAIT_BUDGET_SECONDS,
        });
        const graderRes = await resolveKeyForSpawnWithWait({
          cred: graderCred,
          credentialName: campaign.grader.credential,
          inFlight: inFlightFor(campaign.grader.credential),
          clock,
          warn: stream,
          waitSeconds: KEY_WAIT_BUDGET_SECONDS,
        });
        const grants: KeyGrants = {
          ...(subjectRes.kind === 'use'
            ? { subjectEnv: subjectRes.grant.envName }
            : {}),
          ...(graderRes.kind === 'use'
            ? { graderEnv: graderRes.grant.envName }
            : {}),
        };
        sample.grants = grants;
        const evalsRoot =
          currentSnapshot?.evalsRoot ?? join(args.campaignDir, 'evals');
        const superpowersSha = campaign.refs.superpowers_by_arm[sample.arm];
        const argv = buildCampaignChildArgv({
          evalsRoot,
          scenarioDir: join(
            evalsRoot,
            'scenarios',
            scenarioOfSample(sample.sampleId),
          ),
          codingAgent: surfaceOfArm(sample.arm).agent,
          codingAgentsDir: join(evalsRoot, 'coding-agents'),
          outRoot: resultsRoot,
          os: 'linux',
          credentialName: subjectName,
          credentialsFile: join(evalsRoot, 'credentials.yaml'),
          gauntletBin:
            currentSnapshot?.gauntletBin ??
            join(args.campaignDir, 'bin', 'gauntlet'),
          superpowers:
            superpowersSha !== null && superpowersSha !== undefined
              ? {
                  mode: 'root',
                  root: join(args.campaignDir, `superpowers-${superpowersSha}`),
                }
              : { mode: 'none' },
          identity: {
            campaign_id: campaign.campaign_id,
            comparison_id: live.block.comparison_id,
            block_id: live.block.block_id,
            sample_id: sample.sampleId,
            execution_attempt_id: sample.attemptId,
          },
        });
        const spec: CampaignChildSpec = {
          command: 'bun',
          args: argv,
          cwd: evalsRoot,
          // 6a composition: covered marker + the selected key VALUES resolve
          // through the env seam (fail-loud on unset, R-SPN-7); the parent
          // env is never inherited wholesale (R-SPN-3).
          env: composeCampaignChildEnv({
            base: {
              PATH: getEnv('PATH'),
              HOME: getEnv('HOME'),
              TMPDIR: getEnv('TMPDIR'),
            },
            grants,
          }),
        };
        const child = spawner.spawn(spec);
        sample.childBirthTsMs = identity.startTimeMs(child.pid);
        if (grants.subjectEnv !== undefined) {
          incrementInFlight(subjectName, grants.subjectEnv);
        }
        if (grants.graderEnv !== undefined) {
          incrementInFlight(campaign.grader.credential, grants.graderEnv);
        }
        superviseSample(sample, child, live);
        spawnFailuresByPool.set(sample.subjectPool, 0);
        return 'spawned';
      } catch (err) {
        // Spawn-failure pool halt (REV fable I-14): N consecutive failures
        // attributed to one pool halt admission for that pool.
        const failures = (spawnFailuresByPool.get(sample.subjectPool) ?? 0) + 1;
        spawnFailuresByPool.set(sample.subjectPool, failures);
        stream.write(
          `spawn failure ${failures}/${SPAWN_FAILURE_HALT_N} for pool ${sample.subjectPool}: ${(err as Error).message}\n`,
        );
        if (failures >= SPAWN_FAILURE_HALT_N) {
          haltedPools.add(sample.subjectPool);
          halt(
            `spawn-failure pool halt: ${SPAWN_FAILURE_HALT_N} consecutive failures on ${sample.subjectPool} — a lost key env cannot burn the reserve (operator resume clears)`,
          );
        }
        // A spawn-failed sample never ran: release its slots (a held slot
        // would wedge the caps forever) with the superseding snapshot in the
        // same critical section (E7.7 membership change). The frozen machine
        // has NO instrument_failure edge from 'admitted' (never allocated),
        // so the typed record is classifier row 6 as the MINT reason and the
        // sample resolves via the E7.1 roster disposition from 'admitted'.
        releaseSample(sample);
        const snapshot = await appendCritical([snapshotEstimateInput()]);
        if (snapshot === null || storagePaused) {
          // D-13 fail-stop: no resolution after the pause, and the loop
          // that called us launches nothing further.
          stream.write(
            `spawn loop for ${live.block.block_id} stopped: storage pause (D-13 fail-stop) — no further launch, no resolution\n`,
          );
          return 'fail-stop';
        }
        estimateUsd = currentEstimateTotal();
        const spawnClass = classifyFailure({
          outcome: 'indeterminate',
          exitClass: 'spawn-failed',
          role: 'subject',
          sensorEvidence: 'none',
        });
        live.instrumentFailed = true;
        await mintReplacement(live, spawnClass.cause ?? 'subject_spawn_failed');
        return 'failed';
      }
    };

    // --- Admission ----------------------------------------------------------
    const tryAdmit = async (block: Block): Promise<boolean> => {
      const demand = blockDemandVector({
        block,
        sampleArmCredentialPool: (sampleId) => poolOfArm(armOf(sampleId)),
        graderPool,
      });
      for (const [pool, n] of demand) {
        const blockedUntil = poolBlockedUntil.get(pool);
        if (blockedUntil !== undefined && clockNowMs(clock) < blockedUntil) {
          return false; // cooldown
        }
        if (haltedPools.has(pool)) return false;
        if ((poolBusy.get(pool) ?? 0) + n > poolCapOf(pool)) return false;
      }
      // E7.6: a block holding an already-stopped sample never admits.
      if (block.sample_ids.some((s) => stoppedSamples.has(s))) return false;
      if (stopInForce) return false;
      // R-DSP-6 budget gate: counts hard, dollars soft — stop admitting when
      // position + proposed exposure would exceed budget_usd.
      const proposedExposure = block.sample_ids.reduce(
        (sum, s) => sum + sampleEstimate(s),
        0,
      );
      if (spendUsd + Math.max(estimateUsd, 0) + proposedExposure > budgetUsd) {
        // The stop selects the DENIED block's samples (the overshoot work
        // this stop prevents) + E3's admitted-but-unspawned reach. Other
        // waiting blocks stay planned: they never admit this session (the
        // in-force flag) but a raised ceiling admits them next session —
        // the raise unblocks the campaign, never the stopped samples
        // (E7.6/Important 2).
        stopInForce = true;
        const selected = stoppableSelection([
          ...block.sample_ids,
          ...admittedUnspawnedSampleIds(),
        ]);
        for (const s of selected) stoppedSamples.add(s);
        await appendCritical([
          {
            type: 'budget_stopped',
            payload: { sample_ids: selected },
          },
          snapshotEstimateInput(),
        ]);
        stream.write(
          `budget stop: $${spendUsd} spent + $${estimateUsd} estimated + $${proposedExposure} proposed exceeds $${budgetUsd} — stopped samples never resurrect; a raise admits the remaining planned blocks\n`,
        );
        return false;
      }
      // Commit: the admission bundle lands FIRST — block_admitted +
      // attempt_created (R-JRN-8: before spawn) + the superseding snapshot
      // LAST before handoff (R-DSP-1) — and local state mutates only after
      // the append succeeds, so a failed append aborts the admission
      // transaction before any spawn (C9): the pausing block never reaches
      // liveBlocks half-made.
      const attemptSeqs = block.sample_ids.map((sampleId) => {
        const seq = (attemptSeqBySample.get(sampleId) ?? 0) + 1;
        return { sampleId, seq, attemptId: attemptIdOf(sampleId, seq) };
      });
      const proposedSet = new Set([...exposureSet, ...block.sample_ids]);
      const bundle: EventInput[] = [
        {
          type: 'block_admitted',
          payload: {
            block_id: block.block_id,
            pools: [...demand.keys()],
            // E7.1 re-entry: a rerun successor re-admits from its
            // predecessor's aborted state via rerun_of.
            ...(rerunOf.has(block.block_id)
              ? { rerun_of: rerunOf.get(block.block_id) }
              : {}),
          },
        },
        ...attemptSeqs.map((a) => ({
          type: 'attempt_created' as const,
          payload: { sample_id: a.sampleId, attempt_id: a.attemptId },
        })),
        {
          type: 'budget_event',
          payload: {
            kind: 'estimate_inflight',
            amount_usd: estimateInflightTotal({
              exposureSamples: [...proposedSet].map((sampleId) => ({
                sampleId,
              })),
              estimateCostUsd: sampleEstimate,
            }),
          },
        },
      ];
      const appended = await appendCritical(bundle);
      if (appended === null || storagePaused) return false;
      for (const [pool, n] of demand) {
        poolBusy.set(pool, (poolBusy.get(pool) ?? 0) + n);
      }
      for (const a of attemptSeqs) {
        attemptSeqBySample.set(a.sampleId, a.seq);
        exposureSet.add(a.sampleId);
      }
      estimateUsd = currentEstimateTotal();
      admittedBlockIds.add(block.block_id);
      // The contention surface's block interval starts at the EARLIEST
      // roster attempt_created.ts_ms (contention.ts BlockInterval contract,
      // Important 3) — read off the appended envelopes, never a later fresh
      // clock read.
      const attemptTs = appended
        .filter((e) => e.type === 'attempt_created')
        .map((e) => e.ts_ms);
      const live: LiveBlockState = {
        block,
        slot: block.slot ?? 'primary',
        samples: attemptSeqs.map((a) => ({
          sampleId: a.sampleId,
          blockId: block.block_id,
          arm: armOf(a.sampleId),
          attemptId: a.attemptId,
          subjectPool: poolOfArm(armOf(a.sampleId)),
          grants: {},
          childBirthTsMs: null,
          serviceEnded: false,
          abandoned: false,
        })),
        admittedTsMs:
          attemptTs.length > 0 ? Math.min(...attemptTs) : clockNowMs(clock),
        instrumentFailed: false,
      };
      liveBlocks.set(block.block_id, live);
      for (const sample of live.samples) {
        // Nothing launches after a fail-stop: the D-13 pause's kill sweep
        // already abandoned and released every unspawned sibling (a child
        // spawned now would have its callbacks ignored and its spend
        // unjournaled), and a mint's dispositions may have ended a sample's
        // service. Each launch re-checks the live state.
        if (storagePaused) break;
        if (sample.abandoned || sample.serviceEnded) continue;
        // A mint earlier in this spawn loop (the spawn-failure path) may
        // have superseded the block and disposed the remaining samples: an
        // excluded sample never spawns — its slots release instead
        // (Important 1: no child exists whose allocation could strand).
        if (
          supersededBlockIds.has(block.block_id) ||
          mirrorStateOf(sample.sampleId) !== 'admitted'
        ) {
          releaseSample(sample);
          continue;
        }
        if ((await spawnSample(live, sample)) === 'fail-stop') break;
      }
      return true;
    };

    const admitWave = async (): Promise<void> => {
      if (storagePaused || signalled) return;
      // D2 cadence point 1 of 3 (R-DSP-11): verify per admission wave,
      // BEFORE wave admission — a drifted instrument admits nothing. Drift
      // runs the full Decision D-11 sequence (handleDrift); a successful
      // in-wave repair resumes admission and the scan below proceeds against
      // the repaired instrument.
      try {
        verifySnapshotNow();
        lastCleanVerifyTsMs = clockNowMs(clock);
      } catch (err) {
        if (err instanceof SnapshotDriftError) {
          await handleDrift(err);
          if (admissionHalted || storagePaused) return;
        } else {
          throw err;
        }
      }
      // Dead-sampler liveness (Decision D-3): staleness > 2 x cadence halts.
      if (args.sampler !== 'disabled') {
        const { lines } = parseSidecar(args.campaignDir);
        const stale = samplerStaleMs(lines, clockNowMs(clock));
        if (stale > 2 * campaign.contention.cadence_ms) {
          halt(
            `dead sampler: sidecar stale ${Math.round(stale)}ms > 2 x cadence — a dead sampler must not look like a quiet host`,
          );
          return;
        }
      }
      if (breachActive) return; // live breach: admission-only halt
      if (admissionHalted) return;
      // R-DSP-4 greedy backfill in longest-expected-first order (R-DSP-2:
      // priority = max expected duration across a block's samples; ties
      // break by the deterministic comparison/cell/replicate ordinal). The
      // scan iterates a sorted snapshot; blocks pushed since the last wave
      // (reserve activations) re-sort into place next wave.
      const wave = [...waiting].sort(
        (a, b) =>
          blockPrioritySeconds({
            block: b,
            sampleEstimateSeconds: sampleDurationEstimate,
          }) -
            blockPrioritySeconds({
              block: a,
              sampleEstimateSeconds: sampleDurationEstimate,
            }) || compareAdmissionOrder(a, b),
      );
      for (const block of wave) {
        if (storagePaused || signalled || admissionHalted || breachActive)
          return;
        if (!waiting.includes(block)) continue;
        if (await tryAdmit(block)) waiting.splice(waiting.indexOf(block), 1);
      }
    };

    // --- Closed-window contention resolution (ratified OQ-11) ---------------
    /** Clear the breach ONLY if it is still the generation this resolution
     *  belongs to; a newer live breach keeps admission halted until its own
     *  resolution clears it. */
    const clearBreach = (generation: number): void => {
      if (breachGeneration === generation) {
        breachActive = false;
        stream.write('admission resumed\n');
        return;
      }
      stream.write(
        `admission stays halted: a newer contention breach (generation ${breachGeneration}) is live; its own resolution clears it\n`,
      );
    };
    const resolveClosedWindow = async (
      window: BreachWindow,
      generation: number = breachGeneration,
    ): Promise<void> => {
      // The sampler fsynced the exit sample BEFORE this notification (pinned
      // order); the resolution batch re-reads the durable sidecar through
      // THE shared evaluator with the required inputs (C6): registered
      // cpu_cores, the journal's real campaign_opened ts, and the torn-tail
      // flag.
      const { lines, truncatedTail } = parseSidecar(args.campaignDir);
      const thresholds: ResolvedThreshold[] =
        campaign.contention.thresholds.map((t) => ({
          metric: t.metric,
          op: t.op,
          value: t.value,
        }));
      const intervals: BlockInterval[] = [...liveBlocks.values()].map((lb) => ({
        block_id: lb.block.block_id,
        startTsMs: lb.admittedTsMs,
        endTsMs: lb.serviceEndTsMs ?? null, // live blocks clip in the evaluator
      }));
      const verdicts = evaluateContention({
        lines,
        truncatedTail,
        thresholds,
        sustainK: campaign.contention.sustain_k,
        cadenceMs: campaign.contention.cadence_ms,
        coverageN: campaign.contention.coverage_n,
        cpuCores: campaign.contention.host_fingerprint.cpu_cores,
        campaignOpenedTsMs: openedTsMs,
        lastTerminalTsMs: window.endTsMs ?? clockNowMs(clock),
        blocks: intervals,
      });
      const invalid = [...liveBlocks.values()]
        .filter(
          (lb) =>
            verdicts.get(lb.block.block_id) === 'invalid' &&
            !supersededBlockIds.has(lb.block.block_id) &&
            !resolvedObligations.has(lb.block.block_id),
        )
        .sort((a, b) => compareAdmissionOrder(a.block, b.block));
      // R-JRN-8: a spawned sibling still allocating defers the WHOLE batch —
      // its allocation is awaited outside the control section while
      // admission stays halted (breachActive), then the batch re-enters and
      // settles every pending sample before any disposition lands.
      const pending = invalid
        .filter((lb) => !waitedBlocks.has(lb.block.block_id))
        .flatMap((lb) => pendingAllocationSamples(lb));
      if (pending.length > 0) {
        for (const lb of invalid) waitedBlocks.add(lb.block.block_id);
        stream.write(
          `contention resolution deferred: waiting outside the control section (up to ${ALLOCATION_WAIT_BUDGET_SECONDS}s) for ${pending.map((s) => s.attemptId).join(', ')} to allocate (R-JRN-8)\n`,
        );
        deferUntilAllocated(pending, 'contention resolution', () =>
          resolveClosedWindow(window, generation),
        );
        return;
      }
      if (invalid.length === 0) {
        stream.write(
          'contention resolution: affected=0 refilled=0 exhausted=0 suppressed=0\n',
        );
        clearBreach(generation);
        return;
      }
      // One dispatch writer critical section covers the whole batch; frozen
      // comparison/cell/replicate order; lowest reserve ordinal; the batch
      // tracks its own local activations (C6: two obligations in one cell
      // can never select the same reserve) and applies the resolution-time
      // budget gate (R-DSP-6 pass-through — contention refill is NOT
      // reserve-neutral).
      // Important 1 / R-JRN-8: every pending allocation settles (journaled,
      // or its child verified dead) before any disposition in the batch; a
      // child that would not die aborts the whole batch loudly (C10) — the
      // durable sidecar re-derives it at resume.
      let released = 0;
      const terminalizedByKill: LiveBlockState[] = [];
      const killFailures: string[] = [];
      for (const lb of invalid) {
        const settled = await settlePendingAllocations(lb);
        released += settled.released;
        if (settled.released > 0) terminalizedByKill.push(lb);
        if (settled.failures.length > 0) {
          killFailures.push(...settled.failures);
          break;
        }
      }
      // E7.7 order: kills -> superseding snapshot -> budget reads. The
      // verified deaths' release lands even when the batch aborts below.
      // D-13: a snapshot that could not land (or landed only through the
      // storage pause) stops the batch here — no refresh, no budget read,
      // no resolution; the pause owns what happens next and the durable
      // sidecar re-derives the batch at resume.
      if (released > 0) {
        const snapshot = await appendCritical([snapshotEstimateInput()]);
        if (snapshot === null || storagePaused) {
          stream.write(
            'contention resolution stopped: storage pause (D-13 fail-stop) — no resolution after the pause; the batch re-derives from the durable sidecar at resume\n',
          );
          return;
        }
        estimateUsd = currentEstimateTotal();
      }
      if (killFailures.length > 0) {
        stream.write(
          `contention resolution ABORTED: kill unverified for ${killFailures.join(', ')} — operator action: verify and kill these process groups manually, then resume; the batch re-derives from the durable sidecar at \`quorum campaign run\`\n`,
        );
        if (breachGeneration === generation) breachActive = false; // the halt below owns admission now
        halt('unverified kill blocks the contention resolution batch');
        for (const lb of terminalizedByKill) await onBlockTerminal(lb);
        return;
      }
      // One implementation, one obligation order (shared with recovery's
      // rederiveContentionSuffix): the R-DSP-6 gate rides budgetGate, and
      // the C6 batch-local reserve set rides reserveFor. Membership comes
      // from the LIVE blocks as well as the frozen document, so a rerun
      // instance resolves under its own roster.
      const result = contentionResolutionBatch({
        obligations: invalid.map((lb) => lb.block.block_id),
        budgetStopped: stopInForce,
        cellOf: cellKeyOfBlockId,
        reserveFor: (cellKey, activatedInBatch) =>
          reserveForCell(cellKey, activatedInBatch)?.block_id,
        resolvedCells: new Set<string>(),
        armBySample,
        blockSamples: new Map<string, readonly string[]>([
          ...campaign.blocks.map(
            (b) => [b.block_id, b.sample_ids] as [string, readonly string[]],
          ),
          ...[...liveBlocks.values()].map(
            (lb) =>
              [lb.block.block_id, lb.samples.map((s) => s.sampleId)] as [
                string,
                readonly string[],
              ],
          ),
        ]),
        predecessorTerminalFact: (sampleId) => {
          const state = mirrorStateOf(sampleId);
          // The disposition's legal sources (R-JRN-7 / E7.3a); every other
          // state is a standing fact the predecessor keeps.
          return state === 'admitted' ||
            state === 'spawned' ||
            state === 'exposed' ||
            state === 'completed'
            ? null
            : state;
        },
        budgetGate: (reserveBlockId) => {
          const reserve = reserveBlocks.find(
            (b) => b.block_id === reserveBlockId,
          );
          return reserve === undefined
            ? null
            : resolutionBudgetStop(cellKeyOfBlockId(reserveBlockId), reserve);
        },
      });
      assertInstanceGraph({
        campaign,
        mints: [...mintRecords, ...result.activated.map((a) => a.record)],
      });
      const appended = await appendCritical(result.batch);
      if (appended === null) {
        // Nothing durable landed: announce NOTHING — no planned counts, no
        // resumed receipt; the storage-pause path is the only announcement
        // and recovery re-derives the batch (Important 3).
        return;
      }
      for (const { reserve, record } of result.activated) {
        const reserveBlock = reserveBlocks.find((b) => b.block_id === reserve);
        if (reserveBlock === undefined) continue;
        mintRecords.push(record);
        reserveActivated.add(reserveBlock.block_id);
        supersededBlockIds.add(record.block_id);
        waiting.push(reserveBlock);
      }
      for (const lb of invalid) resolvedObligations.add(lb.block.block_id);
      // Resolution counts BEFORE the separate admission-resumed line (D-3),
      // and only once the batch is durable.
      stream.write(
        `contention resolution: affected=${invalid.length} refilled=${result.activated.length} exhausted=${result.exhaustedCells.length} suppressed=${result.suppressedCells.length}\n`,
      );
      clearBreach(generation);
      wakeLoop(); // minted reserves are admission candidates now
      // D-11/R-DSP-11: blocks whose last child the settle-kill terminalized
      // reach the pinned block-terminal verification here.
      for (const lb of terminalizedByKill) await onBlockTerminal(lb);
    };

    // --- Signal handling (R-DSP-7 / Decision D-12 pinned order) -------------
    // The handler runs on the serialized control section, so it can never
    // interleave an E7 mint critical section — a queued mint completes
    // before the signal is handled (D-12's "complete any partial mint
    // bundle" is structurally satisfied on the live path).
    uninstallSignals = (args.installSignals ?? defaultInstallSignals)(
      (signalName) => {
        void signalName;
        void runExclusive(async () => {
          if (signalled || storagePaused) return;
          // 1. Stop admitting (`signalled` gates the loop; no further waves).
          signalled = true;
          controlEpoch += 1; // deferred work captured before this is stale
          // 2. Kill every campaign process group (TERM -> wait -> KILL ->
          // verify dead, identity-guarded — the ONE C10 primitive).
          // Verified death is a HARD precondition (Critical): aborted is
          // journaled ONLY for blocks whose groups verified dead; ANY
          // failure aborts the sequence loudly — no aborted for the failed
          // block, no campaign_cancelled, a named operator action, and a
          // resumable exit.
          const aborts: EventInput[] = [];
          const killFailures: string[] = [];
          let released = 0;
          for (const lb of liveBlocks.values()) {
            const hadLive = lb.samples.some((s) => !s.serviceEnded);
            await drainLatchedAllocations(lb);
            const kill = await killBlockChildren(lb);
            released += kill.released;
            if (kill.failures.length > 0) {
              killFailures.push(...kill.failures);
              continue;
            }
            if (hadLive) {
              aborts.push({
                type: 'aborted',
                payload: { block_id: lb.block.block_id },
              });
            }
          }
          // 3. Journal aborted per VERIFIED in-flight block; every verified
          // death drained the budget-exposure membership, so the superseding
          // snapshot rides the same critical section (E7.7) — also for a
          // mixed block that released without aborting.
          const bundle: EventInput[] =
            aborts.length > 0 || released > 0
              ? [...aborts, snapshotEstimateInput()]
              : [];
          if (killFailures.length > 0) {
            const cancelPending = existsSync(
              join(args.campaignDir, 'cancel-request'),
            );
            stream.write(
              `signal kill FAILED for ${killFailures.join(', ')} — operator action: verify and kill these process groups manually${cancelPending ? ', then re-run `quorum campaign cancel` (cancel incomplete: campaign_cancelled NOT journaled)' : ''}; exit stays resumable\n`,
            );
            if (bundle.length > 0) await appendCritical(bundle);
            wakeLoop();
            return;
          }
          // 4. Operator cancel (Decision D-12): the cancel-request marker
          // means this signal came from `quorum campaign cancel` — the
          // dispatcher completes the FULL pinned sequence and journals
          // campaign_cancelled LAST (the cancel verb polls the journal for
          // exactly this event). A plain signal journals aborted only and
          // stays resumable (`running`).
          cancelRequested = existsSync(
            join(args.campaignDir, 'cancel-request'),
          );
          if (cancelRequested) {
            const markerBody = readFileSync(
              join(args.campaignDir, 'cancel-request'),
              'utf8',
            );
            const reason = (markerBody.split('\n')[1] ?? '').trim();
            bundle.push({
              type: 'campaign_cancelled',
              payload: reason !== '' ? { reason } : {},
            });
          }
          if (bundle.length > 0) await appendCritical(bundle);
          // 5. Exit — resumable on a plain signal, terminal on cancel.
          wakeLoop();
        });
      },
    );

    // --- Sampler start (Decision D-3: sensors lead; the dispatcher consumes
    //     breach entry -> admission-only halt, closed windows -> resolution
    //     batch, sample errors -> the D-13 storage-pause path) --------------
    const samplerHooks: DispatchSamplerHooks = {
      onBreachEntry: (metrics) => {
        void runExclusive(() => {
          breachActive = true;
          breachGeneration += 1;
          stream.write(
            `contention breach entry: ${metrics.join(', ')} — admission halted, in-flight runs to service end\n`,
          );
        });
      },
      onBreachExit: (window) => {
        void runExclusive(async () => {
          await resolveClosedWindow(window);
        });
      },
      onSampleError: (err) => {
        void runExclusive(async () => {
          if (isStorageFullError(err)) {
            // D-13 step 1, second detector: the sampler plausibly hits the
            // full volume first; the dispatcher enters the same pause path.
            await enterStoragePause(
              `sidecar append storage-full: ${(err as Error).message}`,
            );
          }
          // Other probe errors already produced a sidecar gap line; coverage
          // + the dead-sampler liveness halt make them visible.
        });
      },
    };
    stopSampler =
      args.sampler === 'disabled' ? null : args.sampler.start(samplerHooks);

    // --- Resume reconciliation (C9 / R-DSP-1): a crash mid-admission is
    //     re-snapshotted before ANY admission — the reconciled absolute
    //     position lands first, so the budget predicate never reads a stale
    //     estimate. -------------------------------------------------------
    if (admittedBlockIds.size > 0) {
      await runExclusive(async () => {
        const snapshot = await appendCritical([snapshotEstimateInput()]);
        if (snapshot === null || storagePaused) return; // D-13 fail-stop: the loop exits paused
        estimateUsd = currentEstimateTotal();
      });
    }

    // --- Main loop ----------------------------------------------------------
    // Parks on a 1s fallback clock sleep OR the wake channel (service end,
    // signal, storage pause, resolution) — completion is observed without an
    // external clock tick.
    await runExclusive(admitWave);
    while (!signalled && !storagePaused && fatalError === null) {
      const allServed =
        waiting.length === 0 &&
        [...liveBlocks.values()].every((lb) =>
          lb.samples.every((s) => s.serviceEnded),
        );
      if (stopInForce && waiting.length > 0) {
        // Nothing else admits THIS session (a raise cannot land mid-run —
        // the dispatcher holds the writer). Unselected blocks are dropped
        // from the session queue WITHOUT a terminal: they stay planned in
        // the journal and admit next session under a raise (E7.6).
        // Re-evaluate immediately — the cleared queue may complete the run.
        waiting.length = 0;
        continue;
      }
      if (allServed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        void clock.sleepUntil(clock.now() + 1).then(resolve);
      });
      wake = null;
      if (signalled || storagePaused || fatalError !== null) break;
      await runExclusive(admitWave);
    }
    // Abandon every out-of-section allocation wait: no budget timer may
    // outlive the run, and no deferred re-entry may run after the writer
    // is released.
    tearingDown = true;
    controlEpoch += 1;
    for (const abandon of [...pendingWaits]) abandon();
    await activeSection; // drain queued handler sections before teardown
    if (fatalError !== null) {
      throw fatalError instanceof Error
        ? fatalError
        : new DispatcherError(String(fatalError));
    }

    if (storagePaused) return { status: 'storage_paused', reason: haltReason };
    if (cancelRequested) {
      return {
        status: 'cancelled',
        reason: 'operator cancel: aborted journaled, campaign_cancelled last',
      };
    }
    if (signalled) return { status: 'signalled' };
    if (admissionHalted) {
      return {
        status: 'halted',
        reason:
          driftIncidents.length > 0
            ? `${haltReason}; ${driftIncidents.join('; ')}`
            : haltReason,
      };
    }
    return { status: 'completed' };
  } finally {
    if (stopSampler !== null) {
      try {
        await stopSampler();
      } catch (err) {
        stream.write(`sampler stop failed: ${(err as Error).message}\n`);
      }
    }
    if (uninstallSignals !== null) uninstallSignals();
    try {
      // release() checkpoints, closes, and severs the lease UNCONDITIONALLY.
      writer.release();
    } catch (err) {
      // Full volume: release's checkpoint can fail; the lease token stops
      // beating, goes stale, and resume reclaims via the dead-holder check.
      // Loud either way — never silently masked over a body error.
      stream.write(`journal release failed: ${(err as Error).message}\n`);
    }
  }
}

function defaultInstallSignals(
  handler: (signal?: NodeJS.Signals) => void,
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
