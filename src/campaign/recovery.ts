// Recovery cores (kernel D3, R-RCV-1..5; the ratified OQ-11 contention-mint
// amendment): kill journaled pgids FIRST (identity-guarded, verified dead),
// reconcile the journal against run dirs, complete partial mint bundles
// BEFORE the crash-window resolver actions, execute ALL THREE resolutions
// (void+re-admit, kill+rerun, regenerate report), quarantine by attempt-id
// correlation against the run dir's persisted campaign identity, and
// re-derive an interrupted CLOSED-window contention batch from the durable
// sidecar. Every core is pure over a journal prefix plus injected seams; the
// resume and cancel verbs drive them in the pinned order. Fail-closed
// throughout: unattributable evidence refuses loudly, it is never dropped.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  type Campaign,
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import {
  type CampaignUniverse,
  resolveCrashWindows,
} from '../contracts/campaign/crash-windows.ts';
import {
  attemptOfRationale,
  attemptScopedRationale,
  type JournalEvent,
  JournalEventSchema,
  normalizeBlockReplaced,
  SPEND_RECOVERED,
  UNPRICED_TERMINAL,
} from '../contracts/campaign/journal-events.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import type { SampleState } from '../contracts/campaign/state-machine.ts';
import type { Credential } from '../contracts/credential.ts';
import type { RunErrorStage } from '../contracts/verdict.ts';
import { getEnv } from '../env.ts';
import { type Clock, RealClock } from '../scheduler/clock.ts';
import { loadFrozenCampaign } from './campaign-document.ts';
import { classifyFailure } from './classifier.ts';
import {
  type BlockInterval,
  breachWindows,
  evaluateContention,
  parseSidecar,
  type ResolvedThreshold,
  type SidecarLine,
} from './contention.ts';
import {
  cellKeyOfBlockId,
  compareAdmissionOrder,
  contentionResolutionBatch,
  type DispatchOutcome,
  estimateInflightTotal,
  type GroupSignaler,
  killGroupVerified,
  nextRerunInstanceId,
  readVerdictSummary,
  realGroupSignaler,
  realSamplerSeam,
  runCampaignDispatch,
  runCostFromArtifacts,
} from './dispatcher.ts';
import {
  assertFingerprintMatch,
  clockNowMs,
  DEFAULT_RESOURCE_FLOORS,
  type HostStatsProbe,
  linuxHostStatsProbe,
  preflightResourceFloors,
  probeFingerprint,
} from './host-stats.ts';
import {
  createDurableMarker,
  DEFAULT_BALLAST_BYTES,
  type EventInput,
  electWriter,
  isStorageFullError,
  type JournalFsOps,
  openJournalRead,
  replayEvents,
  verifyBallast,
} from './journal.ts';
import {
  acquireLiveSpendLock,
  defaultLiveSpendLockPath,
  type ProcessIdentityProbe,
  readLiveSpendHolder,
  realProcessIdentityProbe,
} from './locks.ts';
import { resolveCampaignResultsRoot } from './results-root.ts';
import {
  decideExposureAtTerminal,
  gauntletEventStreamTexts,
  roleOfEvidenceSource,
  type SensorRole,
  type SuiteKind,
  senseEvidence,
  sensorAttributionRank,
  terminalEvidenceTexts,
  trajectoryExposureMs,
} from './sensors.ts';
import {
  reconstructCampaignSnapshot,
  repairDriftedTrees,
  verifyCampaignSnapshot,
} from './snapshot.ts';
import type { ChildSpawner } from './spawn.ts';

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

/** The standing tail of every fail-closed recovery refusal. */
const AUDIT =
  'quarantine the campaign directory for manual audit before any rebuild or resume';

/** TERM->KILL escalation grace per phase, matching the dispatcher's own
 *  kill order (Decision D-12). */
const KILL_GRACE_SECONDS = 5;

/** The frozen document's replay/resolver view: samples with their arm+cell,
 *  blocks with their roster and slot. */
export function universeOf(campaign: Campaign): CampaignUniverse {
  return {
    samples: campaign.samples.map((s) => ({
      sample_id: s.sample_id,
      arm: s.arm,
      cell: s.cell,
    })),
    blocks: campaign.blocks.map((b) => ({
      block_id: b.block_id,
      sample_ids: b.sample_ids,
      ...(b.slot !== undefined ? { slot: b.slot } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// The admitted instance chain
// ---------------------------------------------------------------------------

/** Membership of every ADMITTED instance — frozen blocks UNION the mint
 *  rosters (E7 reserve and rerun instances exist only in the journal) —
 *  plus the admission and attempt-creation ordinals lineage attribution
 *  needs. A post-crash in-flight attempt maps to the instance whose roster
 *  holds its sample and whose admission most recently precedes it; "the
 *  most recently admitted block" would abort a reserve or rerun instance
 *  under the wrong id. The frozen universe is REQUIRED: primary rosters are
 *  not journaled, so without it membership is not derivable and recovery
 *  must not guess. */
interface InstanceChain {
  readonly rosterByBlock: Map<string, readonly string[]>;
  readonly admittedSeq: Map<string, number>;
  readonly sampleOfAttempt: Map<string, string>;
  readonly createdSeq: Map<string, number>;
  /** Latest attempt created per sample — the sample's CURRENT attempt. */
  readonly currentAttempt: Map<string, string>;
}

function admittedInstanceChain(
  events: readonly JournalEvent[],
  universe: CampaignUniverse,
): InstanceChain {
  const rosterByBlock = new Map<string, readonly string[]>(
    universe.blocks.map((b) => [b.block_id, b.sample_ids]),
  );
  const admittedSeq = new Map<string, number>();
  const sampleOfAttempt = new Map<string, string>();
  const createdSeq = new Map<string, number>();
  const currentAttempt = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case 'block_admitted':
        admittedSeq.set(event.payload.block_id, event.seq);
        break;
      case 'attempt_created':
        sampleOfAttempt.set(event.payload.attempt_id, event.payload.sample_id);
        createdSeq.set(event.payload.attempt_id, event.seq);
        currentAttempt.set(event.payload.sample_id, event.payload.attempt_id);
        break;
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        if (rec.roster.length > 0) {
          rosterByBlock.set(
            rec.replacement_block_id,
            rec.roster.map((entry) => entry.sample_id),
          );
        }
        break;
      }
      default:
        break;
    }
  }
  return {
    rosterByBlock,
    admittedSeq,
    sampleOfAttempt,
    createdSeq,
    currentAttempt,
  };
}

/** The instance an attempt belongs to: the latest-admitted instance whose
 *  roster holds the attempt's sample at creation time. An attempt whose
 *  membership cannot be established REFUSES recovery — a fallback guess
 *  would rerun or abort the wrong instance, and silently dropping the
 *  attempt would strand a live child (C11, fail-closed). */
function blockOfAttempt(chain: InstanceChain, attemptId: string): string {
  const sampleId = chain.sampleOfAttempt.get(attemptId);
  if (sampleId === undefined) {
    throw new RecoveryError(
      `attempt ${attemptId} has no attempt_created in the journal — its sample binding is unknown, so it cannot be attributed to an instance; ${AUDIT}`,
    );
  }
  const createdAt = chain.createdSeq.get(attemptId) ?? 0;
  let best: { blockId: string; seq: number } | undefined;
  for (const [blockId, roster] of chain.rosterByBlock) {
    if (!roster.includes(sampleId)) continue;
    const admitted = chain.admittedSeq.get(blockId);
    if (admitted === undefined || admitted > createdAt) continue;
    if (best === undefined || admitted > best.seq) {
      best = { blockId, seq: admitted };
    }
  }
  if (best === undefined) {
    throw new RecoveryError(
      `attempt ${attemptId} (sample ${sampleId}) belongs to no instance admitted at or before its creation — the journal's admitted instance chain does not explain it; ${AUDIT}`,
    );
  }
  return best.blockId;
}

// ---------------------------------------------------------------------------
// R-RCV-1: kill journaled pgids first
// ---------------------------------------------------------------------------

/** The campaign-child sanity probe (R-RCV-1's "its leader matches the
 *  campaign-child shape where inspectable"): the process group leader's
 *  command line, or null when it cannot be read — identity is then UNKNOWN
 *  and the group is never signaled. */
export interface CampaignChildProbe {
  commandLine(pgid: number): string | null;
}

export const realCampaignChildProbe: CampaignChildProbe = {
  commandLine(pgid: number): string | null {
    const res = spawnSync('ps', ['-o', 'command=', '-p', String(pgid)], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return null;
    const line = res.stdout.trim();
    return line === '' ? null : line;
  },
};

/** The campaign child carries its identity on argv (`--campaign-identity`,
 *  spawn.ts): a group whose leader shows this campaign's id AND this
 *  attempt's id is provably our child, not a recycled pgid. */
function isCampaignChild(
  commandLine: string,
  campaignId: string,
  attemptId: string,
): boolean {
  return (
    commandLine.includes('--campaign-identity') &&
    commandLine.includes(campaignId) &&
    commandLine.includes(attemptId)
  );
}

export interface KillJournaledPgidsReport {
  /** Signaled and VERIFIED dead. */
  readonly killed: number[];
  /** Provably gone before we signaled: the process GROUP answered ESRCH,
   *  with its leader dead outright or its leader pid reused. A dead leader
   *  alone never qualifies — a group that still answers holds live
   *  descendants and takes the reclaim path instead. */
  readonly alreadyDead: number[];
  /** Reclaimed WITHOUT a kill, with no live campaign child left behind: the
   *  recorded leader pid was reused by an unrelated process AND the process
   *  group answered ESRCH. Recorded loudly (nothing was signaled), but it
   *  holds no unrecorded spend, so callers may proceed past it. */
  readonly reclaimedBenign: number[];
  /** Reclaimed WITHOUT a kill and NOT provably dead: the process group still
   *  answers (live descendants without an inspectable leader), or identity
   *  could not be established at all. Nothing was signaled, so the group may
   *  still be spending — callers must REFUSE to proceed, exactly as for
   *  `survived` (R-RCV-1 no-double-spend; Decision D-12 verified death). */
  readonly reclaimedUnsafe: number[];
  /** Signaled but survived TERM+KILL — the caller must refuse to proceed. */
  readonly survived: number[];
}

/** Every group the report could not prove dead. Both verbs gate on this:
 *  resume refuses to re-admit, cancel refuses to journal a terminal. */
export function unverifiedGroups(report: KillJournaledPgidsReport): number[] {
  return [...report.survived, ...report.reclaimedUnsafe];
}

/** R-RCV-1: on crash restart, kill every journaled pgid of an attempt
 *  WITHOUT a journaled terminal before any re-admission — an orphaned child
 *  keeps spending and races its replacement (no double spend). The guard is
 *  NOT optional: the group must exist AND its leader must match the
 *  campaign-child shape, and the kill is the ONE verified
 *  TERM->wait->KILL->verify primitive (killGroupVerified, C10) — a group
 *  that fails the guard is recorded reclaimed-without-kill (loud), never
 *  signaled blind, and a group that survives is reported, never counted
 *  killed. Signal errors propagate; nothing is swallowed. */
export async function killJournaledPgids(args: {
  events: readonly JournalEvent[];
  campaignId: string;
  identity?: ProcessIdentityProbe;
  child?: CampaignChildProbe;
  signal?: GroupSignaler;
  clock?: Clock;
  stream?: { write(s: string): void };
  graceSeconds?: number;
}): Promise<KillJournaledPgidsReport> {
  const stream = args.stream ?? {
    write: (s: string) => process.stderr.write(s),
  };
  const identity = args.identity ?? realProcessIdentityProbe;
  const child = args.child ?? realCampaignChildProbe;
  const signal = args.signal ?? realGroupSignaler;
  const clock = args.clock ?? new RealClock();
  const graceSeconds = args.graceSeconds ?? KILL_GRACE_SECONDS;

  const terminalAttempts = new Set<string>();
  for (const event of args.events) {
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      terminalAttempts.add(event.payload.attempt_id);
    }
  }
  const killed: number[] = [];
  const alreadyDead: number[] = [];
  const reclaimedBenign: number[] = [];
  const reclaimedUnsafe: number[] = [];
  const survived: number[] = [];
  /** A reclamation is BENIGN only when no campaign child can still be
   *  running under this pgid; every other reclamation leaves live spend on
   *  the table and blocks the caller. */
  const reclaim = (
    pgid: number,
    attemptId: string,
    why: string,
    safety: 'benign' | 'unsafe',
  ): void => {
    (safety === 'benign' ? reclaimedBenign : reclaimedUnsafe).push(pgid);
    stream.write(
      `reclaimed-without-kill (${safety}): pgid ${pgid} (attempt ${attemptId}) ${why} — recorded, never signaled blind (R-RCV-1)${
        safety === 'unsafe'
          ? '; live spend is NOT excluded — operator action: identify and kill this process group by hand'
          : ''
      }\n`,
    );
  };
  /** R-RCV-1: the LEADER's death is not the GROUP's death — a leaderless
   *  group can still hold live descendants that keep spending, and a
   *  leaderless group has no inspectable campaign-child shape. Only an
   *  ESRCH on the group is evidence of death; a group that still answers
   *  takes the UNSAFE reclaim path (identity unknown, never signaled
   *  blind). `permitting` is where a proven-dead group is recorded: outright
   *  (alreadyDead) or as a benign reclamation of a reused pid. */
  const groupDisposition = (
    pgid: number,
    attemptId: string,
    why: string,
    permitting: 'already-dead' | 'benign-reclaim',
  ): void => {
    if (signal(pgid, 0) === 'esrch') {
      if (permitting === 'already-dead') alreadyDead.push(pgid);
      else {
        reclaim(
          pgid,
          attemptId,
          `${why} and the process group is provably gone (ESRCH)`,
          'benign',
        );
      }
      return;
    }
    reclaim(
      pgid,
      attemptId,
      `${why} but the process group still answers — live descendants without its leader, identity unknown`,
      'unsafe',
    );
  };
  for (const event of args.events) {
    if (event.type !== 'run_allocated') continue;
    const attemptId = event.payload.attempt_id;
    if (terminalAttempts.has(attemptId)) continue;
    const pgid = event.payload.pgid;
    const exists = identity.exists(pgid);
    if (exists === 'esrch') {
      groupDisposition(
        pgid,
        attemptId,
        'the recorded leader is gone (ESRCH)',
        'already-dead',
      );
      continue;
    }
    if (exists === 'unknown') {
      reclaim(
        pgid,
        attemptId,
        'process identity unknown (neither alive nor ESRCH)',
        'unsafe',
      );
      continue;
    }
    const commandLine = child.commandLine(pgid);
    if (commandLine === null) {
      reclaim(
        pgid,
        attemptId,
        'command line unreadable — campaign-child shape uninspectable',
        'unsafe',
      );
      continue;
    }
    if (!isCampaignChild(commandLine, args.campaignId, attemptId)) {
      // Pid reuse is not, by itself, proof that OUR child is gone: the same
      // group-level evidence killGroupVerified demands for its 'stale' arm
      // decides. ESRCH on the group -> benign; a group that answers ->
      // unsafe.
      groupDisposition(
        pgid,
        attemptId,
        'group leader is not this campaign child (pid reuse)',
        'benign-reclaim',
      );
      continue;
    }
    // Identity established: the verified kill re-reads the OS start time and
    // refuses on any drift between this check and the signal.
    const outcome = await killGroupVerified({
      pgid,
      birthTsMs: identity.startTimeMs(pgid),
      identity,
      signal,
      clock,
      stream,
      graceSeconds,
    });
    switch (outcome) {
      case 'dead':
        killed.push(pgid);
        break;
      case 'stale':
        // The leader pid was reused AND the group answered ESRCH (the
        // helper's own group-level evidence) — nothing was signaled and
        // nothing survives.
        alreadyDead.push(pgid);
        break;
      case 'unknown':
        reclaim(
          pgid,
          attemptId,
          'OS start time unreadable at kill time',
          'unsafe',
        );
        break;
      case 'alive':
        survived.push(pgid);
        stream.write(
          `orphan pgid ${pgid} (attempt ${attemptId}) survived TERM+KILL — operator action: kill this process group manually before resuming; it is still spending\n`,
        );
        break;
    }
  }
  return {
    killed,
    alreadyDead,
    reclaimedBenign,
    reclaimedUnsafe,
    survived,
  };
}

// ---------------------------------------------------------------------------
// R-RCV-2 / R-RCV-5: the crash-window plan
// ---------------------------------------------------------------------------

export interface RecoveryPlan {
  /** Post-run_allocated without a terminal: kill the pgid, rerun the block. */
  readonly kills: { attempt_id: string; pgid: number }[];
  /** Pre-run_allocated: void the attempt and re-admit its instance. Both
   *  attempt resolutions are EXECUTED — dropping this one leaves a sample
   *  whose attempt is bound but never spawned stuck for the rest of the
   *  run. */
  readonly voidReadmissions: {
    attempt_id: string;
    sample_id: string;
    block_id: string;
  }[];
  /** The campaign-level window: 'regenerate_report' when the E7.3
   *  instance-complete seal predicate holds but no `sealed` event exists
   *  (the process died post-predicate, pre-report). D4 owns the act; this
   *  is the resolver's hand-off. */
  readonly campaign: 'regenerate_report' | 'none';
  readonly dispositionCompletions: {
    block_id: string;
    sample_id: string;
    superseded_by: string;
  }[];
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
  const chain = admittedInstanceChain(events, universe);
  const kills: RecoveryPlan['kills'] = [];
  const voidReadmissions: RecoveryPlan['voidReadmissions'] = [];
  for (const attempt of report.attempts) {
    if (attempt.resolution === 'kill_pgid_rerun_block') {
      if (attempt.pgid === undefined) {
        throw new RecoveryError(
          `attempt ${attempt.attempt_id} resolved to kill_pgid_rerun_block without a journaled pgid — the crash window cannot be executed; ${AUDIT}`,
        );
      }
      kills.push({ attempt_id: attempt.attempt_id, pgid: attempt.pgid });
      continue;
    }
    const sampleId = chain.sampleOfAttempt.get(attempt.attempt_id) ?? '';
    voidReadmissions.push({
      attempt_id: attempt.attempt_id,
      sample_id: sampleId,
      block_id: blockOfAttempt(chain, attempt.attempt_id),
    });
  }

  const dispositionCompletions: RecoveryPlan['dispositionCompletions'] = [];
  const successorReadmissions: RecoveryPlan['successorReadmissions'] = [];
  const admittedBlocks = new Set<string>();
  for (const event of events) {
    if (event.type === 'block_admitted')
      admittedBlocks.add(event.payload.block_id);
  }
  const journaledDispositions = new Set<string>();
  for (const event of events) {
    if (
      event.type === 'sample_disposition' &&
      event.payload.disposition === 'excluded_block_replaced'
    ) {
      journaledDispositions.add(event.payload.sample_id);
    }
  }
  for (const event of events) {
    if (event.type !== 'block_replaced') continue;
    const rec = normalizeBlockReplaced(event.payload);
    // Pre-mint states for the roster's supersedes pairs.
    const preState = replayEvents(
      universe,
      events.filter((e) => e.seq < event.seq),
    );
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
  return {
    kills,
    voidReadmissions,
    campaign: report.campaign,
    dispositionCompletions,
    successorReadmissions,
  };
}

// ---------------------------------------------------------------------------
// Decision D-13: terminal evidence without a journaled terminal
// ---------------------------------------------------------------------------

/** Everything a crashed attempt's run dir still says about it. The D-13
 *  fate table's "buffer + retry" row is what recovery has to rebuild from
 *  disk: the exposure the sensors observed, the terminal outcome, the pool
 *  cooldowns the classifier declared, and the ACTUAL spend. A run dir that
 *  cannot answer all of it is not complete evidence — the reader returns
 *  null and the attempt re-enters via E7 rerun instead. */
export interface TerminalRunEvidence {
  readonly outcome: 'pass' | 'fail' | 'indeterminate';
  readonly stage?: RunErrorStage;
  /** Actual cost read from the run artifacts. Never an estimate. */
  readonly costUsd: number;
  /** Capture-re-derived exposure (epoch ms); null = unestablished. */
  readonly exposureTsMs: number | null;
  /** The strongest sensor attribution the run dir carries. */
  readonly sensor: {
    readonly role: SensorRole;
    readonly evidence: '429-match' | 'billing-exhaustion';
  } | null;
  /** Pool cooldowns the rate-limit evidence re-declares. */
  readonly poolBlocks: readonly { poolKey: string; cooldownMs: number }[];
}

/** The frozen per-sample cost estimate. The authenticated document
 *  guarantees the lookup resolves; a gap refuses rather than pricing at
 *  zero (the same rule the dispatcher applies). */
function frozenSampleEstimate(campaign: Campaign, sampleId: string): number {
  const sample = campaign.samples.find((s) => s.sample_id === sampleId);
  const cell =
    sample === undefined
      ? undefined
      : campaign.cells.find(
          (c) => `${c.comparison_id}:${c.scenario}` === sample.cell,
        );
  const estimate =
    sample === undefined ? undefined : cell?.estimates_by_arm[sample.arm];
  if (estimate === undefined) {
    throw new RecoveryError(
      `sample ${sampleId} has no frozen estimate in the campaign document — refusing to reconcile the budget position against a substituted zero; ${AUDIT}`,
    );
  }
  return estimate.cost_usd;
}

/** Envelope the pending bundle so the reducer can fold it: replay reads
 *  full journal events, and the bundle is still un-appended inputs. The seq
 *  numbers continue the durable prefix; ts_ms is this resume's reading. */
function synthesizeEnvelopes(
  bundle: readonly EventInput[],
  events: readonly JournalEvent[],
  nowMs: number,
): JournalEvent[] {
  let seq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  return bundle.map((input) => {
    seq += 1;
    return JournalEventSchema.parse({
      seq,
      ts_ms: input.ts_ms ?? nowMs,
      type: input.type,
      payload: input.payload,
    });
  });
}

/** The attempts whose actual spend recovery has already journaled: a
 *  `spend_recovered` receipt IMMEDIATELY followed by the spend row it
 *  records. A receipt with nothing after it (a crash between the two
 *  appends) recorded no money, so it does not count and the repair simply
 *  runs again — repair is idempotent without ever paying twice. */
export function completedSpendRecoveries(args: {
  events: readonly JournalEvent[];
  /** attempt -> sample, from the instance chain: a receipt naming an attempt
   *  this campaign never created is corruption, not a no-op. */
  sampleOfAttempt: ReadonlyMap<string, string>;
  cellOfSample: (sampleId: string) => string;
}): Set<string> {
  const done = new Set<string>();
  for (let i = 0; i < args.events.length; i += 1) {
    const event = args.events[i];
    if (
      event?.type !== 'adjudication' ||
      event.payload.disposition !== SPEND_RECOVERED
    ) {
      continue;
    }
    // Fail-closed identity: a receipt is a claim that an attempt was PAID,
    // so an unreadable or cross-named one must never be silently trusted or
    // silently ignored — either way the budget position would be wrong.
    const attemptId = attemptOfRationale(event.payload.rationale);
    if (attemptId === null) {
      throw corruptReceipt(
        event.seq,
        `its rationale does not name an attempt (${event.payload.rationale})`,
      );
    }
    const sampleId = args.sampleOfAttempt.get(attemptId);
    if (sampleId === undefined) {
      throw corruptReceipt(
        event.seq,
        `it names attempt ${attemptId}, which this campaign never created`,
      );
    }
    const cell = args.cellOfSample(sampleId);
    if (event.payload.cell !== cell) {
      throw corruptReceipt(
        event.seq,
        `it names attempt ${attemptId} (sample ${sampleId}, cell ${cell}) but is filed under cell ${event.payload.cell}`,
      );
    }
    const next = args.events[i + 1];
    if (next?.type !== 'budget_event' || next.payload.kind !== 'spend')
      continue;
    done.add(attemptId);
  }
  return done;
}

function corruptReceipt(seq: number, detail: string): RecoveryError {
  return new RecoveryError(
    `spend_recovered receipt at seq ${seq} is corrupt: ${detail} — a receipt asserts that an attempt's actual spend was journaled, so it is never trusted or skipped on a guess; ${AUDIT}`,
  );
}

/** Every unresolved accounting gap, by attempt. Gaps are read from the
 *  adjudication itself, NOT from an adjacent terminal: the live path emits a
 *  FREE-STANDING gap whenever the terminal was withheld too (a gating child
 *  with neither exposure nor a composed verdict), and a scan that only walks
 *  terminals would miss exactly those and let a paid rerun through. */
export function unresolvedAccountingGaps(args: {
  events: readonly JournalEvent[];
  recovered: ReadonlySet<string>;
}): Set<string> {
  const gaps = new Set<string>();
  for (const event of args.events) {
    if (
      event.type !== 'adjudication' ||
      event.payload.disposition !== UNPRICED_TERMINAL
    ) {
      continue;
    }
    const attemptId = attemptOfRationale(event.payload.rationale);
    if (attemptId === null) {
      throw new RecoveryError(
        `unpriced_terminal adjudication at seq ${event.seq} does not name an attempt (${event.payload.rationale}) — the accounting gap cannot be attributed, so nothing may be admitted; ${AUDIT}`,
      );
    }
    if (!args.recovered.has(attemptId)) gaps.add(attemptId);
  }
  return gaps;
}

/** One spend-recovery pair, receipt FIRST. The pair is emitted contiguously
 *  and nothing interleaves inside a writer critical section, so the
 *  adjacency the recognizer reads is the adjacency this writes. */
function spendRecovery(args: {
  attemptId: string;
  cell: string;
  amountUsd: number;
  detail: string;
  /** Stamped explicitly so the receipt's DURABLE timestamp is a figure this
   *  resume already knows — a cooldown anchored on it then recomputes to the
   *  same value on every later resume. */
  tsMs: number;
}): EventInput[] {
  return [
    {
      type: 'adjudication',
      ts_ms: args.tsMs,
      payload: {
        cell: args.cell,
        disposition: SPEND_RECOVERED,
        rationale: attemptScopedRationale(args.attemptId, args.detail),
      },
    },
    {
      type: 'budget_event',
      ts_ms: args.tsMs,
      payload: { kind: 'spend', amount_usd: args.amountUsd },
    },
  ];
}

/** The sensor attribution a run dir still carries: the strongest signal, and
 *  the pool cooldowns its rate-limit evidence declares. Read WITHOUT the
 *  verdict/cost gate, so an attempt that is already paid and resolved can
 *  still have its D-13 cooldown suffix restored without the resume refusing
 *  over economics it no longer needs. */
export function readRunSensorEvidence(args: {
  runDir: string;
  runId: string;
  sampleId: string;
  campaign: Campaign;
  credentials: Readonly<Record<string, Credential>>;
}): {
  sensor: {
    role: SensorRole;
    evidence: '429-match' | 'billing-exhaustion';
  } | null;
  poolBlocks: { poolKey: string; cooldownMs: number }[];
} {
  const sample = args.campaign.samples.find(
    (s) => s.sample_id === args.sampleId,
  );
  const surface =
    sample === undefined
      ? undefined
      : args.campaign.execution_surface.find((a) => a.name === sample.arm);
  if (sample === undefined || surface === undefined) {
    throw new RecoveryError(
      `run ${args.runId} binds to sample ${args.sampleId}, which the frozen document does not place on an execution-surface arm — refusing to attribute its evidence; ${AUDIT}`,
    );
  }
  const subjectCred = args.credentials[surface.credential];
  const graderCred = args.credentials[args.campaign.grader.credential];
  if (subjectCred === undefined || graderCred === undefined) {
    throw new RecoveryError(
      `run ${args.runId} needs credentials ${surface.credential} and ${args.campaign.grader.credential} to attribute its sensor evidence, and the registry supplies ${subjectCred === undefined ? surface.credential : args.campaign.grader.credential} for neither — refusing; ${AUDIT}`,
    );
  }
  // Sensor evidence, attributed by source provenance exactly as the live
  // path does: the child's own channels are the subject's, the
  // Gauntlet-Agent's artifacts are the grader's.
  let best: {
    role: SensorRole;
    evidence: '429-match' | 'billing-exhaustion';
  } | null = null;
  const poolBlocks: { poolKey: string; cooldownMs: number }[] = [];
  for (const text of [
    ...terminalEvidenceTexts(args.runDir),
    ...gauntletEventStreamTexts(args.runDir),
  ]) {
    const role = roleOfEvidenceSource(text.source);
    const cred = role === 'subject' ? subjectCred : graderCred;
    const pool = poolKey(
      cred,
      role === 'subject' ? surface.credential : args.campaign.grader.credential,
    );
    const signal = senseEvidence({
      source: text.source,
      role,
      credential: {
        api: cred.api,
        ...(cred.base_url !== undefined ? { base_url: cred.base_url } : {}),
        ...(role === 'subject' ? { runtimeFamily: surface.agent } : {}),
      },
      text: text.text,
    });
    if (signal === null) continue;
    const candidate = { role: signal.role, evidence: signal.evidence };
    if (
      best === null ||
      sensorAttributionRank(candidate) < sensorAttributionRank(best)
    ) {
      best = candidate;
    }
    if (signal.evidence === '429-match') {
      const existing = poolBlocks.find((b) => b.poolKey === pool);
      if (existing === undefined) {
        poolBlocks.push({ poolKey: pool, cooldownMs: signal.cooldownMs });
      } else if (signal.cooldownMs > existing.cooldownMs) {
        existing.cooldownMs = signal.cooldownMs;
      }
    }
  }
  return { sensor: best, poolBlocks };
}

/** Read one crashed attempt's run dir as D-13 terminal evidence. `null`
 *  means the run dir supplies NO evidence — no composed verdict — which is
 *  the D-13 rule's rerun branch.
 *
 *  A composed verdict whose ACTUAL cost is unreadable is a different thing
 *  entirely: the run RAN and spent, so it is not rerun fodder (a rerun pays
 *  twice for evidence already held) and it is not journalable either
 *  (R-JRN-12 forbids an estimate in a spend row). It REFUSES, naming the run
 *  dir and the operator action. */
export function readTerminalRunEvidence(args: {
  runDir: string;
  runId: string;
  sampleId: string;
  campaign: Campaign;
  credentials: Readonly<Record<string, Credential>>;
  stream: { write(s: string): void };
}): TerminalRunEvidence | null {
  const verdict = readVerdictSummary(args.runDir);
  if (verdict === null) return null; // no run dir / no composed verdict
  const costUsd = runCostFromArtifacts(args.runDir);
  if (costUsd === null) {
    throw new RecoveryError(
      `run ${args.runId} composed a verdict but its artifacts carry no readable actual cost — refusing to resume: journaling an estimate as spend is forbidden (R-JRN-12) and rerunning a run that already spent would pay twice. Inspect ${args.runDir} and restore its verdict economics, then re-run \`quorum campaign run\`; if the cost is unrecoverable the campaign's accounting must be adjudicated at seal. Nothing was journaled; ${AUDIT}`,
    );
  }
  const { sensor, poolBlocks } = readRunSensorEvidence({
    runDir: args.runDir,
    runId: args.runId,
    sampleId: args.sampleId,
    campaign: args.campaign,
    credentials: args.credentials,
  });
  return {
    outcome: verdict.outcome,
    ...(verdict.stage !== undefined ? { stage: verdict.stage } : {}),
    costUsd,
    exposureTsMs: trajectoryExposureMs(args.runDir),
    sensor,
    poolBlocks,
  };
}

/** Decision D-13 terminal-evidence rule: every journaled non-terminal
 *  attempt whose run dir holds COMPLETE evidence is journaled terminal from
 *  that evidence (outcome-derived, loud); every journaled attempt whose run
 *  dir cannot supply it re-enters via E7 rerun — under the id of the
 *  instance that ADMITTED it (primary, reserve, or rerun), never the last
 *  block admitted. An attempt the instance chain cannot explain refuses
 *  (blockOfAttempt).
 *
 *  The reconstruction emits the WHOLE fate-table bundle per attempt, in
 *  replay-legal order: exposure_started (spawned -> exposed, so the terminal
 *  has a legal edge — a bare run_completed from `spawned` is illegal),
 *  the terminal itself (run_completed or instrument_failure), the pool
 *  cooldowns the sensor evidence declares, and the actual spend. The caller
 *  appends the one superseding estimate_inflight snapshot last, in the same
 *  critical section (E7.7). */
export function terminalEvidenceActions(args: {
  events: readonly JournalEvent[];
  universe: CampaignUniverse;
  evidenceOf: (runId: string, sampleId: string) => TerminalRunEvidence | null;
  /** Pool cooldowns a run dir still declares, read WITHOUT the verdict/cost
   *  gate so an already-paid attempt's lost D-13 suffix can be restored. */
  cooldownsOf: (
    runId: string,
    sampleId: string,
  ) => readonly { poolKey: string; cooldownMs: number }[];
  suiteKind: SuiteKind;
  /** Resume-time clock reading for the re-declared cooldown windows. */
  nowMs: number;
  stream?: { write(s: string): void };
}): {
  terminals: EventInput[];
  terminalAttemptIds: string[];
  rerunBlockIds: string[];
} {
  const stream = args.stream ?? { write: () => {} };
  // R-JRN-4 pins ONE TRANSACTION PER EVENT, so a bundle is not crash-atomic:
  // a death inside one leaves a durable prefix. The spec's crash model for a
  // batched writer critical section is that recovery appends the missing
  // suffix, so recovery must be able to SEE what already landed.
  //
  // It reads that PER ATTEMPT, never positionally. Every journaled spend —
  // live or recovery — is immediately preceded by a `spend_recovered`
  // receipt naming its attempt, so "already paid" is a property of the
  // attempt rather than of an adjacency that a later, unrelated append can
  // destroy. (budget_event cannot carry the identity itself: E7.7 pins "no
  // additive field … per-sample spend attribution still derives at seal from
  // run-dir evidence, not the journal", so the receipt carries it on the
  // existing adjudication event under the pinned machine-disposition
  // convention.) A receipt with no spend after it recorded no money, so an
  // interrupted repair simply runs again — exactly once, never twice.
  const chain0 = admittedInstanceChain(args.events, args.universe);
  const cellOfSample = (sampleId: string): string =>
    args.universe.samples.find((s) => s.sample_id === sampleId)?.cell ??
    'control-plane';
  const recovered = completedSpendRecoveries({
    events: args.events,
    sampleOfAttempt: chain0.sampleOfAttempt,
    cellOfSample,
  });
  // Gaps are attempt-scoped and read from the adjudication itself, so a
  // FREE-STANDING gap (the live path withheld the terminal too) is seen.
  const unpricedGaps = unresolvedAccountingGaps({
    events: args.events,
    recovered,
  });
  const terminaled = new Set<string>();
  const allocatedAttempts = new Set<string>();
  for (const event of args.events) {
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      terminaled.add(event.payload.attempt_id);
    } else if (event.type === 'run_allocated') {
      allocatedAttempts.add(event.payload.attempt_id);
    }
  }

  const chain = chain0;
  // Folded LAZILY: an attempt the instance chain cannot explain must refuse
  // through blockOfAttempt (C11) rather than through the reducer's
  // corruption error, and a resume with no reconstructable evidence never
  // needs the fold at all.
  let foldedStates: Map<string, SampleState> | null = null;
  const stateOf = (sampleId: string): SampleState => {
    foldedStates ??= replayEvents(args.universe, args.events).sampleStates;
    return foldedStates.get(sampleId) ?? 'planned';
  };
  const cellOf = cellOfSample;
  const terminals: EventInput[] = [];
  const terminalAttemptIds: string[] = [];
  const rerunBlockIds: string[] = [];
  const rerun = (attemptId: string): void => {
    const blockId = blockOfAttempt(chain, attemptId);
    if (!rerunBlockIds.includes(blockId)) rerunBlockIds.push(blockId);
  };
  /** The timestamp a restored cooldown is measured from: the EARLIEST
   *  durable record of this attempt's fate, in a fixed precedence, so the
   *  anchor cannot move as later repairs append and every resume recomputes
   *  the identical `until`.
   *
   *  terminal → the gap that fail-stopped it → the receipt that paid it →
   *  this resume's own reading (a fresh reconstruction, whose terminal and
   *  receipt are stamped with exactly that reading below, so the next resume
   *  reads the same number back out of the journal). */
  const anchorTsOf = new Map<string, number>();
  const remember = (attemptId: string, tsMs: number): void => {
    if (!anchorTsOf.has(attemptId)) anchorTsOf.set(attemptId, tsMs);
  };
  for (const event of args.events) {
    if (event.type !== 'run_completed' && event.type !== 'instrument_failure')
      continue;
    remember(event.payload.attempt_id, event.ts_ms);
  }
  /** When each attempt's run was allocated — the earliest moment its own
   *  sensor evidence could have been observed. */
  const allocatedTsOf = new Map<string, number>();
  for (const event of args.events) {
    if (event.type === 'run_allocated') {
      allocatedTsOf.set(event.payload.attempt_id, event.ts_ms);
    }
  }
  for (const event of args.events) {
    if (event.type !== 'adjudication') continue;
    const { disposition, rationale } = event.payload;
    if (disposition !== UNPRICED_TERMINAL && disposition !== SPEND_RECOVERED)
      continue;
    const attemptId = attemptOfRationale(rationale);
    if (attemptId !== null) remember(attemptId, event.ts_ms);
  }
  /** The effective cooldown a pool already carries: D-10 coalesces repeated
   *  matches into ONE pool_blocked whose until is the MAX, so the journal's
   *  (and this bundle's) maximum is what a candidate must beat. */
  const journaledUntil = new Map<string, number>();
  for (const event of args.events) {
    if (event.type !== 'pool_blocked') continue;
    const pool = event.payload.pool_key;
    journaledUntil.set(
      pool,
      Math.max(journaledUntil.get(pool) ?? 0, event.payload.until_ts_ms),
    );
  }
  /** Restore the D-13 cooldown suffix for one attempt.
   *
   *  `pool_blocked` carries no attempt identity (E7.7), and it is the LAST
   *  leg of a reconstruction bundle — so a crash after the spend leaves a
   *  legal durable prefix whose cooldown is simply gone, and the attempt
   *  still reads as paid and resolved. Repair-on-resume is the legal
   *  mechanism (R-JRN-4 forbids widening the transaction), and correlation
   *  is by VALUE rather than position:
   *
   *  - the restored `until` is `terminal.ts_ms + cooldownMs`, a figure
   *    derived entirely from durable evidence, so every resume computes the
   *    same number and a re-repair can never EXTEND a cooldown;
   *  - candidates are coalesced per pool to their max (D-10) before any
   *    append, so two attempts in the same pool crash-cutting together
   *    produce ONE row, never two;
   *  - a candidate is appended only if it strictly exceeds what the pool
   *    already carries, so a cooldown that did land restores nothing;
   *  - a candidate already in the past restores nothing — an expired
   *    cooldown blocks no admission and is not resurrected. */
  const candidateUntil = new Map<
    string,
    { until: number; minJustified: number; by: string }
  >();
  const restoreCooldowns = (args2: {
    attemptId: string;
    sampleId: string;
    runId: string;
  }): void => {
    const anchorTsMs = anchorTsOf.get(args2.attemptId) ?? args.nowMs;
    // The EARLIEST until this evidence could possibly justify. The live path
    // anchors a cooldown when the 429 is OBSERVED, which is somewhere inside
    // the run — so any genuine live row for this evidence already reaches at
    // least `run_allocated.ts_ms + cooldownMs`. A journaled row that reaches
    // that floor therefore already accounts for this evidence, however much
    // earlier its own anchor was; restoration must not "top it up" to the
    // terminal's later stamp.
    const observedFloorTsMs = allocatedTsOf.get(args2.attemptId) ?? anchorTsMs;
    for (const block of args.cooldownsOf(args2.runId, args2.sampleId)) {
      const until = anchorTsMs + block.cooldownMs;
      const minJustified = observedFloorTsMs + block.cooldownMs;
      const best = candidateUntil.get(block.poolKey);
      candidateUntil.set(block.poolKey, {
        until: Math.max(until, best?.until ?? 0),
        // The most demanding justification across the attempts sharing this
        // pool: a landed row must cover ALL of them to count as complete.
        minJustified: Math.max(minJustified, best?.minJustified ?? 0),
        by:
          best !== undefined && best.until >= until ? best.by : args2.attemptId,
      });
    }
  };
  /** Emit the coalesced cooldowns ONCE, after every attempt has been
   *  considered — so two attempts in the same pool produce one row carrying
   *  the max (D-10), never one each. */
  const emitRestoredCooldowns = (): void => {
    for (const [pool, candidate] of candidateUntil) {
      if (candidate.until <= args.nowMs) continue; // expired: nothing to block
      // Already accounted for: some journaled row for this pool reaches the
      // floor this evidence justifies, so the suffix is not missing — it is
      // simply anchored earlier than the terminal, as the live path anchors
      // it. Only a pool whose journaled cooldown falls SHORT of that floor
      // (none at all, or an older window that closed before this run began)
      // is genuinely owed one.
      if ((journaledUntil.get(pool) ?? 0) >= candidate.minJustified) continue;
      journaledUntil.set(pool, candidate.until);
      terminals.push({
        type: 'pool_blocked',
        payload: { pool_key: pool, until_ts_ms: candidate.until },
      });
      stream.write(
        `restored the D-13 cooldown attempt ${candidate.by} declared for pool ${pool} (blocked until ${candidate.until}) — R-DSP-3\n`,
      );
    }
  };
  for (const event of args.events) {
    if (event.type !== 'run_allocated') continue;
    const attemptId = event.payload.attempt_id;
    // Accounting completion is NOT lifecycle completion. A receipt says the
    // attempt's money is recorded; only a legal terminal says the attempt is
    // resolved. The live exposure-absent gating path journals the spend and
    // WITHHOLDS run_completed, so a recovered attempt can still be sitting
    // in `spawned` — and nothing downstream rescues it: the dispatcher never
    // re-queues an already-admitted original block, so the sample would stay
    // spawned forever and its block would never re-enter.
    const sampleOfThis = chain.sampleOfAttempt.get(attemptId);
    if (recovered.has(attemptId)) {
      if (terminaled.has(attemptId)) {
        // Paid AND resolved — but the cooldown is the LAST leg of the
        // bundle, so it can still be missing. Restoring it is the only
        // repair this attempt can still owe.
        if (sampleOfThis !== undefined) {
          restoreCooldowns({
            attemptId,
            sampleId: sampleOfThis,
            runId: event.payload.run_id,
          });
        }
        continue;
      }
      stream.write(
        `attempt ${attemptId} is already accounted but has no legal terminal — its block re-enters via rerun (the receipt keeps the spend from being charged twice)\n`,
      );
      // This path owes the cooldown suffix too: the gap-resolution leg
      // queues receipt+spend and emits its coalesced pool_blocked only after
      // the whole attempt loop, so a crash between them lands here on the
      // next resume — recovered, terminal-less, and the last chance to
      // restore the cooldown.
      if (sampleOfThis !== undefined) {
        restoreCooldowns({
          attemptId,
          sampleId: sampleOfThis,
          runId: event.payload.run_id,
        });
      }
      rerun(attemptId);
      continue;
    }
    const sampleId = chain.sampleOfAttempt.get(attemptId);
    if (sampleId === undefined) {
      throw new RecoveryError(
        `attempt ${attemptId} allocated run ${event.payload.run_id} but binds to no sample — refusing to journal a terminal for it; ${AUDIT}`,
      );
    }
    const evidence = args.evidenceOf(event.payload.run_id, sampleId);
    if (unpricedGaps.has(attemptId)) {
      // The gap's remediation loop: the operator was told to restore the run
      // dir's economics, so the artifacts are re-read HERE rather than
      // refused sight-unseen. Still unreadable -> the refusal stands (the
      // reader raises it, naming the run dir and the action).
      if (evidence === null) {
        throw new RecoveryError(
          `attempt ${attemptId} fail-stopped on an unpriced terminal and run ${event.payload.run_id} still supplies no composed verdict to price it — the budget position cannot account for that run, so nothing further may be admitted. Restore ${event.payload.run_id}'s verdict economics and re-run \`quorum campaign run\`, or adjudicate the accounting at seal; ${AUDIT}`,
        );
      }
      stream.write(
        `accounting gap for ${attemptId} RESOLVED: run ${event.payload.run_id} now prices at ${evidence.costUsd} — journaling the actual spend and resuming\n`,
      );
      terminals.push(
        ...spendRecovery({
          attemptId,
          cell: cellOf(sampleId),
          amountUsd: evidence.costUsd,
          detail: `resolves the ${UNPRICED_TERMINAL} gap; actual cost restored in run ${event.payload.run_id}`,
          tsMs: args.nowMs,
        }),
      );
      restoreCooldowns({
        attemptId,
        sampleId,
        runId: event.payload.run_id,
      });
      terminalAttemptIds.push(attemptId);
      // The live fail-stop promises the resume journals the spend and
      // CONTINUES. For a free-standing gap (the terminal was withheld too)
      // continuing means the block re-enters — resolving the dollars alone
      // would leave the sample stranded exactly as above.
      if (!terminaled.has(attemptId)) {
        stream.write(
          `attempt ${attemptId} has no legal terminal after its gap resolved — its block re-enters via rerun\n`,
        );
        rerun(attemptId);
      }
      continue;
    }
    if (terminaled.has(attemptId)) {
      // The terminal is durable; only its accounting tail was lost. Append
      // exactly the missing suffix — never a second terminal, never a rerun
      // of paid work whose evidence is already journaled.
      if (evidence === null) {
        throw new RecoveryError(
          `attempt ${attemptId} has a durable terminal whose spend never landed, and run ${event.payload.run_id} no longer supplies the actual cost — refusing to resume against a budget position that cannot be reconciled; inspect ${event.payload.run_id}'s run dir, restore its verdict economics, then re-run \`quorum campaign run\`; ${AUDIT}`,
        );
      }
      stream.write(
        `terminal bundle for ${attemptId} was truncated by a crash — completing its missing spend (${evidence.costUsd}) from the run artifacts\n`,
      );
      terminals.push(
        ...spendRecovery({
          attemptId,
          cell: cellOf(sampleId),
          amountUsd: evidence.costUsd,
          detail: `terminal bundle truncated by a crash; actual cost read from run ${event.payload.run_id}`,
          tsMs: args.nowMs,
        }),
      );
      restoreCooldowns({
        attemptId,
        sampleId,
        runId: event.payload.run_id,
      });
      terminalAttemptIds.push(attemptId);
      continue;
    }
    if (evidence === null) {
      rerun(attemptId);
      continue;
    }
    const bundle: EventInput[] = [];
    let state = stateOf(sampleId);
    // Exposure first: the machine's only legal path to a determinate
    // terminal is spawned -> exposed -> completed.
    if (state === 'spawned' && evidence.exposureTsMs !== null) {
      bundle.push({
        type: 'exposure_started',
        payload: { sample_id: sampleId, ts: evidence.exposureTsMs },
      });
      state = 'exposed';
    }
    // The run dir holds a composed verdict, so the runner reached
    // composition: the exit class is 'clean' and the typed cause (if any)
    // comes from the recorded stage and sensor evidence.
    const classification = classifyFailure({
      outcome: evidence.outcome,
      ...(evidence.stage !== undefined ? { stage: evidence.stage } : {}),
      exitClass: 'clean',
      role: evidence.sensor?.role ?? 'subject',
      sensorEvidence: evidence.sensor?.evidence ?? 'none',
    });
    const decision = decideExposureAtTerminal({
      runtimeTsMs: null,
      captureTsMs: evidence.exposureTsMs,
      suiteKind: args.suiteKind,
    });
    const exposureCaveat =
      state === 'spawned' &&
      !decision.established &&
      decision.resolution === 'render_caveat';
    if (
      classification.class === 'instrument' &&
      classification.cause !== undefined &&
      (state === 'spawned' || state === 'exposed')
    ) {
      bundle.push({
        type: 'instrument_failure',
        ts_ms: args.nowMs,
        payload: { attempt_id: attemptId, cause: classification.cause },
      });
    } else if (state === 'exposed' || exposureCaveat) {
      bundle.push({
        type: 'run_completed',
        ts_ms: args.nowMs,
        payload: {
          attempt_id: attemptId,
          outcome: evidence.outcome,
          ...(exposureCaveat
            ? { caveat: 'exploratory_exposure_unestablished' as const }
            : {}),
        },
      });
    } else {
      // No legal terminal edge (gating, exposure never established): the
      // block re-enters whole rather than carrying an illegal terminal.
      // But the run RAN and SPENT — the live path withholds the terminal in
      // exactly this case and still appends the actual spend, so a crash
      // before that append leaves priced evidence with no terminal. The
      // money is accounted first (accounting-class, legal from any state);
      // only then does the instance re-enter.
      if (!recovered.has(attemptId)) {
        stream.write(
          `terminal evidence for ${attemptId} withheld: exposure was never established and the suite is ${args.suiteKind} — accounting its actual spend (${evidence.costUsd}) before the instance re-enters via rerun (D-13, fail-closed)\n`,
        );
        terminals.push(
          ...spendRecovery({
            attemptId,
            cell: cellOf(sampleId),
            amountUsd: evidence.costUsd,
            detail: `run ${event.payload.run_id} is priced but has no legal terminal edge (exposure unestablished, ${args.suiteKind} suite); the instance re-enters via rerun`,
            tsMs: args.nowMs,
          }),
        );
        terminalAttemptIds.push(attemptId);
      }
      rerun(attemptId);
      continue;
    }
    // The ACTUAL spend, with its receipt — the universal shape, so a later
    // resume reads "already paid" off the attempt rather than off a
    // position in the stream. The cooldowns ride after it.
    bundle.push(
      ...spendRecovery({
        attemptId,
        cell: cellOf(sampleId),
        amountUsd: evidence.costUsd,
        detail: `reconstructed terminal evidence from run ${event.payload.run_id}`,
        tsMs: args.nowMs,
      }),
    );
    // The cooldown rides the same coalescing restore as every other path,
    // so a re-repair after a mid-bundle crash cannot double-declare it.
    terminals.push(...bundle);
    restoreCooldowns({
      attemptId,
      sampleId,
      runId: event.payload.run_id,
    });
    terminalAttemptIds.push(attemptId);
  }
  emitRestoredCooldowns();
  // A gap whose attempt never reached the run_allocated walk (no allocation
  // journaled at all) cannot be priced from a run dir — but it still records
  // money the position cannot account for, so it blocks just as loudly.
  for (const attemptId of unpricedGaps) {
    if (terminalAttemptIds.includes(attemptId)) continue;
    if (allocatedAttempts.has(attemptId)) continue;
    throw new RecoveryError(
      `attempt ${attemptId} carries an unresolved ${UNPRICED_TERMINAL} accounting gap and journaled no run allocation to price it from — the budget position cannot account for it, so nothing may be admitted; adjudicate the accounting at seal before resuming; ${AUDIT}`,
    );
  }
  return { terminals, terminalAttemptIds, rerunBlockIds };
}

// ---------------------------------------------------------------------------
// R-RCV-3 / R-RCV-4: the run-dir identity sweep
// ---------------------------------------------------------------------------

export interface RunDirScan {
  readonly identities: { runId: string; identity: CampaignIdentity }[];
  /** Run dirs whose identity file EXISTS but cannot be read as an identity —
   *  evidence that cannot be attributed to any campaign. Never dropped:
   *  quarantined campaign_mismatch, loudly. */
  readonly malformed: { runId: string; detail: string }[];
}

/** Scan a results root for run dirs carrying a persisted campaign identity
 *  (`<runDir>/campaign-identity.json`, written at run-dir allocation — task
 *  6c; it is what makes R-RCV-3's mismatch detectable at all). An ABSENT
 *  identity file means the dir is not campaign evidence and is skipped; an
 *  unreadable or non-identity-shaped file is reported as malformed. */
export function readRunDirIdentities(resultsRoot: string): RunDirScan {
  const identities: RunDirScan['identities'] = [];
  const malformed: RunDirScan['malformed'] = [];
  if (!existsSync(resultsRoot)) return { identities, malformed };
  for (const entry of readdirSync(resultsRoot)) {
    const path = join(resultsRoot, entry, 'campaign-identity.json');
    if (!existsSync(path)) continue; // not campaign evidence
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      malformed.push({ runId: entry, detail: `unreadable: ${String(err)}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      malformed.push({ runId: entry, detail: `invalid JSON: ${String(err)}` });
      continue;
    }
    // The WHOLE Decision D-8 shape or nothing: an identity missing any
    // member cannot be correlated against the journal (block/sample/
    // comparison included), so a partial file is malformed evidence, never
    // a usable identity.
    const identity = CampaignIdentitySchema.safeParse(parsed);
    if (!identity.success) {
      malformed.push({
        runId: entry,
        detail: `not a campaign identity: ${identity.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      });
      continue;
    }
    identities.push({ runId: entry, identity: identity.data });
  }
  return { identities, malformed };
}

/** R-RCV-3 / R-RCV-4: classify late or orphaned run dirs against the
 *  journal — never a filesystem move, always the binding-only `quarantined`
 *  event. The precedence ladder, in order:
 *
 *  1. `campaign_mismatch` — the identity names another campaign, or could
 *     not be read at all (unclassifiable evidence is never OURS by default).
 *  2. `attempt_mismatch` — the journal binds this run id to a DIFFERENT
 *     attempt, or (R-RCV-4's residual spawn-to-`run_allocated` window) the
 *     run dir names a journaled attempt whose `run_allocated` never landed.
 *  3. `late_terminal` — the run dir's attempt is not the sample's current
 *     attempt (predecessor-era evidence that must never retire the
 *     re-entered attempt), or names no journaled attempt at all.
 *
 *  A run dir matching its journaled binding on the sample's current attempt
 *  is legitimate evidence and is not quarantined. */
export function quarantineActions(args: {
  runDirIdentities: { runId: string; identity: CampaignIdentity }[];
  malformed?: { runId: string; detail: string }[];
  events: readonly JournalEvent[];
  campaignId: string;
  stream?: { write(s: string): void };
}): EventInput[] {
  const stream = args.stream ?? {
    write: (s: string) => process.stderr.write(s),
  };
  const allocatedByRun = new Map<string, string>(); // run_id -> attempt_id
  const createdAttempts = new Set<string>();
  const sampleOfAttempt = new Map<string, string>();
  const currentAttempt = new Map<string, string>();
  for (const event of args.events) {
    if (event.type === 'run_allocated') {
      allocatedByRun.set(event.payload.run_id, event.payload.attempt_id);
    } else if (event.type === 'attempt_created') {
      createdAttempts.add(event.payload.attempt_id);
      sampleOfAttempt.set(event.payload.attempt_id, event.payload.sample_id);
      currentAttempt.set(event.payload.sample_id, event.payload.attempt_id);
    }
  }
  const actions: EventInput[] = [];
  for (const { runId, detail } of args.malformed ?? []) {
    stream.write(
      `run dir ${runId} carries an unreadable campaign identity (${detail}) — quarantined campaign_mismatch: it cannot be attributed to this campaign\n`,
    );
    actions.push({
      type: 'quarantined',
      payload: { run_id: runId, reason: 'campaign_mismatch' },
    });
  }
  for (const { runId, identity } of args.runDirIdentities) {
    const claimed = identity.execution_attempt_id;
    const bound = allocatedByRun.get(runId);
    if (identity.campaign_id !== args.campaignId) {
      actions.push({
        type: 'quarantined',
        payload: {
          run_id: runId,
          ...(bound !== undefined ? { attempt_id: bound } : {}),
          reason: 'campaign_mismatch',
        },
      });
      continue;
    }
    if (bound !== undefined && bound !== claimed) {
      actions.push({
        type: 'quarantined',
        payload: {
          run_id: runId,
          attempt_id: bound,
          reason: 'attempt_mismatch',
        },
      });
      continue;
    }
    if (!createdAttempts.has(claimed)) {
      // No journaled attempt to attribute this run dir to at all.
      actions.push({
        type: 'quarantined',
        payload: { run_id: runId, reason: 'late_terminal' },
      });
      continue;
    }
    if (bound === undefined) {
      // R-RCV-4: the attempt was journaled and the child allocated its run
      // dir, but the dispatcher died before `run_allocated` — the bounded
      // orphan window, reconciled by attempt-id correlation.
      actions.push({
        type: 'quarantined',
        payload: {
          run_id: runId,
          attempt_id: claimed,
          reason: 'attempt_mismatch',
        },
      });
      continue;
    }
    const sampleId = sampleOfAttempt.get(claimed);
    if (sampleId !== undefined && currentAttempt.get(sampleId) !== claimed) {
      // Predecessor-era evidence: a stale terminal never retires the
      // sample's current attempt.
      actions.push({
        type: 'quarantined',
        payload: {
          run_id: runId,
          attempt_id: claimed,
          reason: 'late_terminal',
        },
      });
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// The interrupted closed-window contention batch (ratified OQ-11)
// ---------------------------------------------------------------------------

/** Interrupted CLOSED-window contention batches (ratified OQ-11): landed
 *  reason=contention mints stay authoritative; re-derive ONLY the missing
 *  ordered suffix from the durable sidecar under one writer critical
 *  section. Restrictions the resolution depends on:
 *
 *  - only a genuinely CLOSED breach window resolves; a breach still open at
 *    the crash is D4's `contention_invalidated` backstop, never an
 *    immediate reserve activation;
 *  - the evaluation is the one the closure would have made: the evidence up
 *    to the closure instant, horizon at the closure (the same inputs the
 *    live path passes at `onBreachExit`);
 *  - the landed resolutions must form a PREFIX of the obligation order —
 *    one critical section appends in order, so an interior hole is not a
 *    crash cut and recovery refuses rather than filling it.
 *
 *  Sidecar loss never reverses the landed prefix. */
export function rederiveContentionSuffix(args: {
  events: readonly JournalEvent[];
  sidecarLines: readonly SidecarLine[];
  /** parseSidecar's torn-tail flag — a truncated tail is uncovered evidence
   *  (C6), never silently dropped. */
  truncatedTail: boolean;
  campaign: Campaign;
}): EventInput[] {
  const { events, sidecarLines, campaign } = args;
  const universe = universeOf(campaign);
  const chain = admittedInstanceChain(events, universe);
  // Fold landed mints + cell resolutions + the CURRENT budget stop state.
  const supersededBlocks = new Set<string>();
  const contentionSuperseded = new Set<string>();
  const resolvedCells = new Set<string>();
  const reserveActivated = new Set<string>();
  const stoppedSamples = new Set<string>();
  let budgetStopped = false;
  let openedTsMs: number | null = null;
  for (const event of events) {
    switch (event.type) {
      case 'campaign_opened':
        openedTsMs = event.ts_ms;
        break;
      case 'block_replaced': {
        const rec = normalizeBlockReplaced(event.payload);
        supersededBlocks.add(rec.block_id);
        if (rec.reason === 'contention') contentionSuperseded.add(rec.block_id);
        if (rec.reserve_activation)
          reserveActivated.add(rec.replacement_block_id);
        break;
      }
      case 'adjudication':
        // The two resolution carriers (the same pair the crash-window
        // resolver treats as covering a cell).
        if (
          event.payload.disposition === 'replacement_suppressed' ||
          event.payload.disposition === 'reserve_exhausted'
        ) {
          resolvedCells.add(event.payload.cell);
        }
        break;
      case 'budget_stopped':
        budgetStopped = true;
        for (const sampleId of event.payload.sample_ids) {
          stoppedSamples.add(sampleId); // E7.6: never resurrects
        }
        break;
      case 'amendment':
        // R-DSP-10/E7.6: a raise widens the ceiling for LATER work, so the
        // durable stop is no longer in force; the SELECTED samples stay
        // terminal forever. A fresh stop fires at the first post-resume
        // admission through the live predicate (R-DSP-6).
        if (event.payload.kind === 'budget_raise') budgetStopped = false;
        break;
      default:
        break;
    }
  }
  if (openedTsMs === null) {
    // C6: head coverage is anchored on the REAL campaign_opened ts; a
    // journal without it cannot be evaluated, and guessing is never an
    // option here.
    throw new RecoveryError(
      `journal holds no campaign_opened event — the contention evaluation window has no anchor; ${AUDIT}`,
    );
  }
  const thresholds: ResolvedThreshold[] = campaign.contention.thresholds.map(
    (t) => ({ metric: t.metric, op: t.op, value: t.value }),
  );
  const cpuCores = campaign.contention.host_fingerprint.cpu_cores;
  // The resolution instant: the LAST closed breach closure. No closure means
  // no closed-window batch was ever owed (an open breach is D4's backstop).
  let closureTsMs: number | null = null;
  for (const window of breachWindows(
    sidecarLines,
    thresholds,
    campaign.contention.sustain_k,
    cpuCores,
  )) {
    if (window.endTsMs === null) continue;
    closureTsMs =
      closureTsMs === null
        ? window.endTsMs
        : Math.max(closureTsMs, window.endTsMs);
  }
  if (closureTsMs === null) return [];
  // Conservative block intervals, lineage-attributed: earliest roster
  // attempt_created -> latest service-end terminal; a block with an attempt
  // that never terminaled stays OPEN (the evaluator clips it to the
  // closure), so a breach after a sibling's completion still counts.
  const startTs = new Map<string, number>();
  const endTs = new Map<string, number>();
  const openBlocks = new Set<string>();
  const terminaledAttempts = new Set<string>();
  for (const event of events) {
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      terminaledAttempts.add(event.payload.attempt_id);
    }
  }
  for (const event of events) {
    if (event.type === 'attempt_created') {
      const blockId = blockOfAttempt(chain, event.payload.attempt_id);
      const prev = startTs.get(blockId);
      if (prev === undefined || event.ts_ms < prev)
        startTs.set(blockId, event.ts_ms);
      if (!terminaledAttempts.has(event.payload.attempt_id))
        openBlocks.add(blockId);
      continue;
    }
    if (event.type !== 'run_completed' && event.type !== 'instrument_failure') {
      continue;
    }
    const blockId = blockOfAttempt(chain, event.payload.attempt_id);
    const prev = endTs.get(blockId);
    if (prev === undefined || event.ts_ms > prev)
      endTs.set(blockId, event.ts_ms);
  }
  const intervals: BlockInterval[] = [...startTs.entries()].map(
    ([blockId, start]) => ({
      block_id: blockId,
      startTsMs: start,
      endTsMs: openBlocks.has(blockId) ? null : (endTs.get(blockId) ?? null),
    }),
  );
  // The evaluation the closure would have made: evidence up to the closure,
  // horizon at the closure — the same shared evaluator, same inputs.
  const verdicts = evaluateContention({
    lines: sidecarLines.filter((l) => l.ts_ms <= closureTsMs),
    truncatedTail: args.truncatedTail,
    thresholds,
    sustainK: campaign.contention.sustain_k,
    cadenceMs: campaign.contention.cadence_ms,
    coverageN: campaign.contention.coverage_n,
    cpuCores,
    campaignOpenedTsMs: openedTsMs,
    lastTerminalTsMs: closureTsMs,
    blocks: intervals,
  });
  // Obligations = invalid EXECUTED instances (primary, reserve, or rerun)
  // that were live for this batch, in the same frozen
  // comparison/cell/replicate + lineage-mint order dispatch uses. A block
  // superseded for a NON-contention reason left the live set before the
  // batch and was never an obligation of it.
  const obligations = intervals
    .map((i) => i.block_id)
    .filter(
      (blockId) =>
        verdicts.get(blockId) === 'invalid' &&
        (!supersededBlocks.has(blockId) || contentionSuperseded.has(blockId)),
    )
    .sort((a, b) => compareAdmissionOrder({ block_id: a }, { block_id: b }));
  // The landed resolutions must be a PREFIX: the batch appends in obligation
  // order inside one critical section, so a resolved obligation after an
  // unresolved one is not a crash cut — it is a corrupt or non-prefix
  // journal, and recovery refuses instead of filling the hole.
  const resolved = obligations.map(
    (blockId) =>
      contentionSuperseded.has(blockId) ||
      resolvedCells.has(cellKeyOfBlockId(blockId)),
  );
  const lastResolved = resolved.lastIndexOf(true);
  for (let i = 0; i < lastResolved; i += 1) {
    if (!resolved[i]) {
      throw new RecoveryError(
        `contention resolution ${obligations[lastResolved]} landed while the earlier obligation ${obligations[i]} did not — the journal is not a batch prefix, so the missing suffix cannot be re-derived; ${AUDIT}`,
      );
    }
  }
  const suffix = obligations.slice(lastResolved + 1);
  const reserveBlocks = campaign.blocks.filter((b) => b.slot === 'reserve');
  const reserveFor = (
    cellKey: string,
    activatedInBatch: ReadonlySet<string>,
  ): string | undefined =>
    reserveBlocks
      .filter(
        (b) =>
          b.block_id.startsWith(`${cellKey}:x`) &&
          !reserveActivated.has(b.block_id) &&
          // E7.6: a reserve holding a budget-stopped sample never activates.
          !b.sample_ids.some((s) => stoppedSamples.has(s)) &&
          !activatedInBatch.has(b.block_id),
      )
      .sort(compareAdmissionOrder)[0]?.block_id;
  // E7.1 disposition-source filter, journal-derived: only admitted |
  // spawned | exposed | completed are legal sources; every other replayed
  // state is a standing fact the predecessor keeps (R-JRN-7).
  const sampleStates = replayEvents(universe, events).sampleStates;
  // No budgetGate: the durable stop state was read from the journal above;
  // a fresh stop fires at the first post-resume admission (R-DSP-6).
  return contentionResolutionBatch({
    obligations: suffix,
    budgetStopped,
    cellOf: cellKeyOfBlockId,
    reserveFor,
    resolvedCells,
    armBySample: new Map(campaign.samples.map((s) => [s.sample_id, s.arm])),
    blockSamples: chain.rosterByBlock,
    predecessorTerminalFact: (sampleId) => {
      const state = sampleStates.get(sampleId) ?? 'planned';
      return state === 'admitted' ||
        state === 'spawned' ||
        state === 'exposed' ||
        state === 'completed'
        ? null
        : state;
    },
  }).batch;
}

// ---------------------------------------------------------------------------
// R-RCV-7: the idempotent resume verb
// ---------------------------------------------------------------------------

export interface ResumeArgs {
  readonly campaignDir: string;
  readonly credentials: Readonly<Record<string, Credential>>;
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
  readonly spawner?: ChildSpawner;
  /** THE group-signal seam for the whole verb (C10): the R-RCV-1 orphan kill
   *  AND, once the dispatcher takes over, its own kills and R-SPN-5 pgid
   *  probes. Production omits it (realGroupSignaler); tests drive surviving
   *  or scripted groups through it without touching a real process. */
  readonly signal?: GroupSignaler;
  /** R-RCV-1 campaign-child shape probe; production default is `ps`. */
  readonly child?: CampaignChildProbe;
  readonly graceSeconds?: number;
  readonly stream?: { write(s: string): void };
}

/** Fail-closed intake of the frozen document (C1: no production-path cast
 *  bridges this read). Both verbs derive campaign identity, the block/sample
 *  universe, and rerun rosters from it BEFORE anything re-validates, so a
 *  corrupt document must refuse here rather than shape kills and journal
 *  bundles. */
function readPublishedCampaign(campaignDir: string): Campaign {
  // Authenticated, not merely schema-parsed: recovery derives campaign
  // identity, membership, kill targets, and budget position from this
  // document, so a digest that does not match its content — or a sample
  // naming a cell or arm that does not exist — refuses here rather than
  // resolving to a zero/empty value downstream.
  try {
    return loadFrozenCampaign(campaignDir);
  } catch (err) {
    throw new RecoveryError(
      `${err instanceof Error ? err.message : String(err)}; ${AUDIT}`,
    );
  }
}

/** R-REG-19 (second occurrence, REV fable I-14): every api-key arm's
 *  registered key env NAMES plus the grader credential's env names must be
 *  present and non-empty at resume, so a key lost between registration and
 *  resume fails BEFORE any spend. Env is read only through src/env.ts. */
function assertKeyEnvsPresent(
  campaign: Campaign,
  credentials: Readonly<Record<string, Credential>>,
): void {
  const missing: string[] = [];
  const require = (envNames: readonly string[]): void => {
    for (const envName of envNames) {
      const value = getEnv(envName);
      if (value === undefined || value === '') missing.push(envName);
    }
  };
  for (const arm of campaign.execution_surface) {
    if (arm.auth !== 'api-key') continue;
    if (arm.key_env_names.length === 0) {
      missing.push(`${arm.name}: api-key arm with no registered key env name`);
      continue;
    }
    require(arm.key_env_names);
  }
  // The grader credential is MANDATORY: an incomplete registry must refuse
  // here, not slip past the preflight and surface later as a dispatch error
  // (R-REG-19 covers "every arm credential AND the grader credential").
  const grader = credentials[campaign.grader.credential];
  if (grader === undefined) {
    missing.push(
      `${campaign.grader.credential}: the grader credential is not in the registry`,
    );
  } else if (grader.auth === 'api-key') {
    const names =
      grader.key_pool ??
      (grader.api_key_env !== undefined ? [grader.api_key_env] : []);
    if (names.length === 0) {
      missing.push(
        `${campaign.grader.credential}: api-key auth with no api_key_env/key_pool`,
      );
    }
    require(names);
  }
  if (missing.length > 0) {
    throw new RecoveryError(
      `key env preflight failed at resume — unset or missing: ${[
        ...new Set(missing),
      ].join(
        ', ',
      )} (R-REG-19, re-checked at every live-spend-lock acquisition) — export the missing env vars and re-run \`quorum campaign run\`; refusing before any spend`,
    );
  }
}

/** R-RCV-7 pinned resume order: cancel-request FIRST -> live-spend lock ->
 *  kill/reconcile (identity-guarded; complete partial mint bundles before
 *  resolver actions; fold authoritative contention mints; re-derive
 *  interrupted batch suffixes) -> preflight (floors + fingerprint + key
 *  envs) -> reconstruct handle + refs cross-check + verifySnapshot -> admit.
 *  Every resume prints the one-line state banner. */
export async function resumeCampaign(
  args: ResumeArgs,
): Promise<DispatchOutcome> {
  const clock = args.clock ?? new RealClock();
  const identity = args.identity ?? realProcessIdentityProbe;
  const stream = args.stream ?? {
    write: (s: string) => process.stdout.write(s),
  };
  const campaign = readPublishedCampaign(args.campaignDir);

  // 1. Cancel-request precedence (Decision D-12 I-10b).
  const cancelMarker = join(args.campaignDir, 'cancel-request');
  if (existsSync(cancelMarker)) {
    stream.write(
      'cancel-request present — completing cancellation instead of resuming\n',
    );
    const result = await cancelCampaign({
      campaignDir: args.campaignDir,
      clock,
      identity,
      ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      ...(args.child !== undefined ? { child: args.child } : {}),
      ...(args.graceSeconds !== undefined
        ? { graceSeconds: args.graceSeconds }
        : {}),
      stream,
    });
    if (!result.cancelled) {
      throw new RecoveryError(
        'cancel-request present but the cancellation could not complete — resume refused; finish the operator action named above, then re-run `quorum campaign cancel`',
      );
    }
    return {
      status: 'cancelled',
      reason: result.postCrash
        ? 'post-crash cancel completed'
        : 'live cancel completed',
    };
  }

  // 2. Acquire the live-spend lock (recovery ordering: acquire ->
  //    kill/reconcile -> preflight -> admit; preflight deliberately does NOT
  //    ride the acquisition, R-LCK-2).
  const lock = acquireLiveSpendLock({
    ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
    campaignId: campaign.campaign_id,
    clock,
    identity,
  });
  try {
    stream.write(
      `resume: live-spend lock acquired (campaign ${campaign.campaign_id.slice(0, 12)})\n`,
    );

    // 3. Kill/reconcile FIRST — an orphaned child keeps spending while the
    //    floor is debated, so cleanup precedes the preflight gate.
    const universe = universeOf(campaign);
    const resultsRoot = resolveCampaignResultsRoot(args.resultsRoot);
    const writer = electWriter({
      campaignDir: args.campaignDir,
      clock,
      identity,
      campaign,
    });
    let killReport: KillJournaledPgidsReport;
    let plan: RecoveryPlan;
    try {
      const events = writer.readEvents();
      // A durable accounting gap is resolved, not refused sight-unseen: the
      // terminal-evidence pass re-reads the named run dir and either
      // journals the restored actual spend or raises the refusal itself.
      // Refusing here, before re-reading, would make the operator action the
      // live fail-stop advertises impossible to carry out.
      killReport = await killJournaledPgids({
        events,
        campaignId: campaign.campaign_id,
        identity,
        clock,
        stream,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
        ...(args.child !== undefined ? { child: args.child } : {}),
        ...(args.graceSeconds !== undefined
          ? { graceSeconds: args.graceSeconds }
          : {}),
      });
      // Live spend that was NOT excluded — a survivor of TERM+KILL, or a
      // group we could never prove dead (still answering, or identity
      // unknown, so nothing was ever signaled). Journaling a rerun re-entry
      // now would race that group against its replacement (the
      // no-double-spend invariant), so nothing is journaled and nothing is
      // admitted (R-RCV-1).
      const unverified = unverifiedGroups(killReport);
      if (unverified.length > 0) {
        throw new RecoveryError(
          `resume refused: process group(s) ${unverified.join(
            ', ',
          )} could not be verified dead (${killReport.survived.length} survived TERM+KILL, ${killReport.reclaimedUnsafe.length} reclaimed without a verifiable identity) — they may still be spending; identify and kill them by hand, then re-run \`quorum campaign run\`; nothing was journaled and nothing was admitted`,
        );
      }
      plan = planRecovery({ universe, events });
      const bundle: EventInput[] = [];
      // Partial mint bundles complete BEFORE any resolver action (E7.1 /
      // R-RCV-2 mint override): aborted would otherwise destroy the
      // disposition's legal source state.
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
      // R-RCV-5's campaign-level window is D4's act; recovery hands it off
      // loudly rather than swallowing it.
      if (plan.campaign === 'regenerate_report') {
        stream.write(
          'resume: the instance-complete seal predicate holds with no `sealed` event — report regeneration is owed (D4 hand-off, R-RCV-5)\n',
        );
      }
      // Terminal-evidence reconciliation (D-13): a journaled non-terminal
      // attempt whose run dir holds a COMPLETE verdict journals terminal from
      // the evidence (outcome-derived, loud); attempts with no run dir at all
      // re-enter via E7 rerun below.
      const evidence = terminalEvidenceActions({
        events,
        universe,
        suiteKind: campaign.suite.kind,
        nowMs: clockNowMs(clock),
        stream,
        evidenceOf: (runId, sampleId) =>
          readTerminalRunEvidence({
            runDir: join(resultsRoot, runId),
            runId,
            sampleId,
            campaign,
            credentials: args.credentials,
            stream,
          }),
        cooldownsOf: (runId, sampleId) =>
          readRunSensorEvidence({
            runDir: join(resultsRoot, runId),
            runId,
            sampleId,
            campaign,
            credentials: args.credentials,
          }).poolBlocks,
      });
      bundle.push(...evidence.terminals);
      // Storage-pause reconciliation (R-JRN-11 + D-13 step 7): retroactive
      // ordering (REV fable M-6) — if storage_paused never persisted, journal
      // it BEFORE the first buffered activity event; the marker removes only
      // after the first successful commit (below).
      const pauseMarker = join(args.campaignDir, '.storage-paused');
      const markerPresent = existsSync(pauseMarker);
      const lastPauseSeq = events.reduce(
        (m, e) => (e.type === 'storage_paused' ? Math.max(m, e.seq) : m),
        -1,
      );
      // R-JRN-11's derivation rule, read backwards: a pause is still in force
      // when no block_admitted/attempt_created/budget_event followed it.
      const pauseUnresumed =
        lastPauseSeq >= 0 &&
        !events.some(
          (e) =>
            e.seq > lastPauseSeq &&
            (e.type === 'block_admitted' ||
              e.type === 'attempt_created' ||
              e.type === 'budget_event'),
        );
      if (markerPresent && lastPauseSeq < 0) {
        bundle.unshift({ type: 'storage_paused', payload: {} });
      }
      // Spent-ballast note (D-13): ballast ABSENCE at ANY resume journals the
      // accounting note — once, never per-resume (the normal pause leaves NO
      // marker, so the note cannot be marker-gated).
      const ballastSpentNoted = events.some(
        (e) =>
          e.type === 'adjudication' &&
          e.payload.disposition === 'ballast_spent',
      );
      if (
        !ballastSpentNoted &&
        !verifyBallast(args.campaignDir, DEFAULT_BALLAST_BYTES)
      ) {
        bundle.push({
          type: 'adjudication',
          payload: {
            cell: 'control-plane',
            disposition: 'ballast_spent',
            rationale:
              'the ballast is absent/spent at resume; the control-plane reserve was consumed',
          },
        });
      }
      // Rerun re-entry (R-RCV-2 + the D-13 fate table's journaled-at-resume
      // row): every killed in-flight block, every attempt-with-no-run-dir
      // block, and every pre-run_allocated void+re-admit block re-enters
      // WHOLE via block_replaced { kind: 'rerun' } — reason storage_failure
      // when this resume reconciles a storage pause, else dispatcher_restart.
      // `aborted` lands FIRST (the E7.1 re-entry edge only applies from
      // aborted); a block already superseded by a landed mint is
      // recovery-folded, never re-minted (mint override, R-RCV-2/R-RCV-5).
      const rerunReason =
        markerPresent || pauseUnresumed
          ? 'storage_failure'
          : 'dispatcher_restart';
      const superseded = new Set<string>();
      const alreadyAborted = new Set<string>();
      for (const event of events) {
        if (event.type === 'block_replaced') {
          superseded.add(normalizeBlockReplaced(event.payload).block_id);
        } else if (event.type === 'aborted') {
          alreadyAborted.add(event.payload.block_id);
        }
      }
      const chain = admittedInstanceChain(events, universe);
      const armBySample = new Map(
        campaign.samples.map((s) => [s.sample_id, s.arm]),
      );
      const armOfSample = (sampleId: string): string => {
        const arm = armBySample.get(sampleId);
        if (arm === undefined) {
          throw new RecoveryError(
            `sample ${sampleId} is not in the frozen sample universe — refusing to invent a rerun roster arm; ${AUDIT}`,
          );
        }
        return arm;
      };
      const rerunBlockIds = new Set<string>(evidence.rerunBlockIds);
      // R-RCV-5's pre-run_allocated resolution is EXECUTED too: the recovery
      // unit is the validity unit, so voiding a bound-but-never-spawned
      // attempt re-admits its instance as a whole-block rerun. Dropping it
      // would strand the sample for the rest of the run.
      for (const readmit of plan.voidReadmissions) {
        rerunBlockIds.add(readmit.block_id);
      }
      for (const blockId of rerunBlockIds) {
        if (superseded.has(blockId)) continue; // the landed mint is authoritative
        if (!alreadyAborted.has(blockId)) {
          bundle.push({ type: 'aborted', payload: { block_id: blockId } });
        }
        const successorId = nextRerunInstanceId(blockId);
        const roster = chain.rosterByBlock.get(blockId);
        if (roster === undefined) {
          throw new RecoveryError(
            `block ${blockId} has no frozen or minted roster — its rerun instance cannot be constructed; ${AUDIT}`,
          );
        }
        bundle.push({
          type: 'block_replaced',
          payload: {
            block_id: blockId,
            replacement_block_id: successorId,
            reason: rerunReason,
            kind: 'rerun',
            reserve_activation: false,
            roster: roster.map((sampleId) => ({
              sample_id: sampleId,
              arm: armOfSample(sampleId),
            })),
          },
        });
        stream.write(
          `rerun re-entry: ${blockId} -> ${successorId} (${rerunReason})\n`,
        );
      }
      // R-RCV-3/R-RCV-4: quarantine by persisted identity — every run dir
      // carrying <runDir>/campaign-identity.json (written at allocation, task
      // 6c) is checked against the journal; late/orphaned/mismatched dirs are
      // journal-classified via E7's binding-only quarantined event. Nothing
      // moves on disk. A malformed identity file is unattributable evidence,
      // never dropped.
      const scan = readRunDirIdentities(resultsRoot);
      bundle.push(
        ...quarantineActions({
          runDirIdentities: scan.identities,
          malformed: scan.malformed,
          events,
          campaignId: campaign.campaign_id,
          stream,
        }),
      );
      // Interrupted contention batch: fold landed mints (authoritative) and
      // re-derive only the missing suffix.
      const sidecar = parseSidecar(args.campaignDir);
      bundle.push(
        ...rederiveContentionSuffix({
          events,
          sidecarLines: sidecar.lines,
          truncatedTail: sidecar.truncatedTail,
          campaign,
        }),
      );
      // E7.7: the superseding absolute estimate_inflight snapshot rides the
      // SAME critical section, last — recovery writes the reconciled
      // position before anything evaluates the budget. Its value is the
      // total remaining exposure of the post-bundle state, computed the way
      // the dispatcher's own startup fold computes it.
      // …and it is emitted whenever the reconciled position DIFFERS from
      // the journal's latest, not merely when the bundle happens to be
      // non-empty. A crash after the last repaired spend but before its
      // snapshot leaves an otherwise-empty bundle on the next resume, and
      // "no bundle, no snapshot" would strand that stale figure forever.
      // Comparing values makes the emission idempotent by construction:
      // once it lands, the two agree and nothing more is appended.
      {
        const reconciled = replayEvents(universe, [
          ...events,
          ...synthesizeEnvelopes(bundle, events, clockNowMs(clock)),
        ]).sampleStates;
        const stillExposed: string[] = [];
        for (const [sampleId, state] of reconciled) {
          if (
            state === 'admitted' ||
            state === 'spawned' ||
            state === 'exposed'
          )
            stillExposed.push(sampleId);
        }
        const amount_usd = estimateInflightTotal({
          exposureSamples: stillExposed.map((sampleId) => ({ sampleId })),
          estimateCostUsd: (sampleId) =>
            frozenSampleEstimate(campaign, sampleId),
        });
        // E7.7: absent reads as 0.
        let latest = 0;
        for (const e of events) {
          if (
            e.type === 'budget_event' &&
            e.payload.kind === 'estimate_inflight'
          )
            latest = e.payload.amount_usd;
        }
        if (bundle.length > 0 || amount_usd !== latest) {
          bundle.push({
            type: 'budget_event',
            payload: { kind: 'estimate_inflight', amount_usd },
          });
        }
      }
      let committed = false;
      if (bundle.length > 0) {
        writer.appendEvents(bundle);
        committed = true;
      }
      // D-13 step 7: the marker removes ONLY after this resume's first
      // SUCCESSFUL commit. An already-journaled storage_paused records that
      // a pause happened; it proves nothing about storage accepting a write
      // now, and an empty bundle proves nothing at all — so the durable
      // marker stays until a recovery write has actually landed.
      if (markerPresent && committed) {
        unlinkSync(pauseMarker);
      }
    } finally {
      writer.release();
    }

    // 4. Preflight (after cleanup): resource floors + fingerprint match +
    //    key envs (R-LCK-2 / R-REG-19 second half). ALWAYS runs — the real
    //    Linux probe is the production default (S4: mandated behavior never
    //    rides an absent optional); tests inject a scripted probe. The LIVE
    //    fingerprint comes from probeFingerprint, never from the registered
    //    values (a mismatch must be detectable — Decision D-4).
    const probe = args.probe ?? linuxHostStatsProbe(args.campaignDir);
    preflightResourceFloors(
      probe.sample(clockNowMs(clock)),
      DEFAULT_RESOURCE_FLOORS,
    );
    assertFingerprintMatch(
      campaign.contention.host_fingerprint,
      probeFingerprint(probe, clockNowMs(clock)),
      {
        mem_tolerance_pct: campaign.contention.mem_tolerance_pct,
        disk_tolerance_pct: campaign.contention.disk_tolerance_pct,
      },
    );
    assertKeyEnvsPresent(campaign, args.credentials);

    // 5. Reconstruct the handle + refs cross-check + verify (R-RCV-6).
    const handle = reconstructCampaignSnapshot({
      campaignDir: args.campaignDir,
      refs: campaign.refs,
      runner: defaultCommandRunner,
    });
    verifyCampaignSnapshot(handle, defaultCommandRunner);

    stream.write(
      `resume: reconcile complete — kills=${killReport.killed.length}, already-dead=${killReport.alreadyDead.length}, reclaimed-benign=${killReport.reclaimedBenign.length}, dispositions=${plan.dispositionCompletions.length}, readmissions=${plan.successorReadmissions.length}, report=${plan.campaign}\n`,
    );

    // 6. Admit (the idempotent resume verb drives the dispatcher). This is
    // THE production wiring of the dispatcher's mandated seams: the
    // reconstructed snapshot handle + CommandRunner (R-DSP-11 verify builds
    // from them — no injectable no-op), repairDriftedTrees over the source
    // checkouts (Decision D-11 authorized repair), and the real timer-driven
    // sampler (Decision D-3).
    return await runCampaignDispatch({
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
      // One C10 seam for the verb: the dispatcher's kills and pgid probes
      // ride the same signaler recovery just killed the orphans with.
      ...(args.signal !== undefined ? { signalGroup: args.signal } : {}),
      ...(args.graceSeconds !== undefined
        ? { killGraceSeconds: args.graceSeconds }
        : {}),
      stream,
    });
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Decision D-12: cancellation, one pinned order for both paths
// ---------------------------------------------------------------------------

export interface CancelArgs {
  readonly campaignDir: string;
  readonly reason?: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  readonly lockPath?: string;
  /** R-RCV-1 kill seams (see ResumeArgs). */
  readonly signal?: GroupSignaler;
  readonly child?: CampaignChildProbe;
  readonly graceSeconds?: number;
  readonly stream?: { write(s: string): void };
  /** Durability seam for the cancel-request marker (see StoragePauseArgs). */
  readonly fsOps?: JournalFsOps;
}

export interface CancelResult {
  /** false = the sequence did NOT complete (a group survived TERM+KILL): the
   *  marker stays, nothing was journaled, the operator action is on the
   *  stream, and re-running the cancel finishes it. */
  readonly cancelled: boolean;
  readonly postCrash: boolean;
}

/** How long the command waits for a signalled live dispatcher to journal
 *  campaign_cancelled before taking the post-crash path itself. */
const LIVE_CANCEL_POLL_SECONDS = 0.1;
const LIVE_CANCEL_POLLS = 300;

/** The operator's reason for THIS cancellation: the marker's line 2 is
 *  authoritative (C11 — a marker left by an interrupted cancel carries the
 *  original operator's words on BOTH paths), falling back to this
 *  invocation's argument only when the marker carries none. A marker that
 *  EXISTS but cannot be read REFUSES: silently substituting a later
 *  --reason would destroy the original operator's attribution, and that
 *  attribution is the whole point of the carrier. */
function markerReason(markerPath: string, argReason?: string): string {
  let body: string;
  try {
    body = readFileSync(markerPath, 'utf8');
  } catch (err) {
    throw new RecoveryError(
      `cancel-request marker at ${markerPath} exists but cannot be read (${(err as Error).message}) — refusing rather than replacing the original operator's cancellation reason; fix the marker's permissions (or remove it if the campaign should keep running) and re-run the cancel`,
    );
  }
  const fromMarker = (body.split('\n')[1] ?? '').trim();
  return fromMarker !== '' ? fromMarker : (argReason ?? '').trim();
}

/** Decision D-12 cancellation — one pinned order for both paths: marker
 *  first -> stop admission -> kill + verify dead (SIGTERM first) -> complete
 *  any partial E7 mint bundle -> journal aborted per in-flight block ->
 *  journal campaign_cancelled LAST. cancelled is terminal. */
export async function cancelCampaign(args: CancelArgs): Promise<CancelResult> {
  const stream = args.stream ?? {
    write: (s: string) => process.stdout.write(s),
  };
  const lockPath = args.lockPath ?? defaultLiveSpendLockPath();
  // 1. Marker first (O_EXCL), BEFORE the document is read: marker-first is
  // the D-12 intent, and admission must stop even when campaign.json is
  // unusable — resume refuses while the marker is present. Line 2 carries
  // the operator's reason so a live dispatcher can journal
  // campaign_cancelled { reason } itself.
  const marker = join(args.campaignDir, 'cancel-request');
  if (!existsSync(marker)) {
    // Durable before campaign_cancelled is journaled: a crash between the
    // two must still leave the operator's cancellation on disk, so the
    // marker is fsynced along with its directory entry. Skipping on presence
    // is safe because a failed durable creation removes the final name — a
    // marker that exists is one whose write completed.
    createDurableMarker(
      marker,
      `${clockNowMs(args.clock)}\n${args.reason ?? ''}\n`,
      args.fsOps,
    );
  }
  const reason = markerReason(marker, args.reason);
  // Only now the fail-closed parse: everything below derives campaign
  // identity, membership, and journal bundles from this document.
  const campaign = readPublishedCampaign(args.campaignDir);
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
    // Signal the dispatcher; it performs the pinned sequence. The identity
    // probe above is not atomic with this signal: a dispatcher that exits in
    // between raises ESRCH, which is proof it is gone — take the post-crash
    // path rather than failing the cancel. Every other signal error stays a
    // loud refusal (an unsignalable LIVE dispatcher is not a crash).
    let signalled = true;
    try {
      process.kill(liveDispatcherPid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new RecoveryError(
          `cancel: signalling dispatcher pid ${liveDispatcherPid} failed (${(err as Error).message}) — refusing to continue against a dispatcher that may still be live`,
        );
      }
      signalled = false;
      stream.write(
        `cancel: dispatcher pid ${liveDispatcherPid} exited before the signal (ESRCH) — taking the post-crash path\n`,
      );
    }
    if (signalled) {
      stream.write(
        `cancel: signalled live dispatcher pid ${liveDispatcherPid}\n`,
      );
    }
    // Poll for campaign_cancelled to land — the signalled dispatcher sees
    // the marker and completes the FULL pinned sequence, journaling
    // campaign_cancelled LAST (task 8's signal handler). READ-ONLY poll:
    // the live dispatcher HOLDS the journal lease for its whole run, so a
    // writer election here would refuse against the live holder.
    for (let i = 0; signalled && i < LIVE_CANCEL_POLLS; i += 1) {
      const reader = openJournalRead(args.campaignDir);
      try {
        if (reader.readEvents().some((e) => e.type === 'campaign_cancelled')) {
          return { cancelled: true, postCrash: false };
        }
      } finally {
        reader.close();
      }
      await args.clock.sleepUntil(args.clock.now() + LIVE_CANCEL_POLL_SECONDS);
    }
    if (signalled) {
      stream.write(
        'cancel: dispatcher did not complete the sequence — taking the post-crash path\n',
      );
    }
  }
  // Post-crash path: the command takes writer election itself and performs
  // the sequence, including the aborted journaling (I-10a).
  const writer = electWriter({
    campaignDir: args.campaignDir,
    clock: args.clock,
    identity: args.identity,
    campaign,
  });
  try {
    const events = writer.readEvents();
    // Idempotent re-entry: a landed campaign_cancelled is the whole sequence
    // already done (it journals LAST, and it only journals once every group
    // verified dead), so a re-run adds nothing.
    if (events.some((e) => e.type === 'campaign_cancelled')) {
      return { cancelled: true, postCrash: true };
    }
    if (events.some((e) => e.type === 'sealed')) {
      throw new RecoveryError('cancel refused: campaign is sealed');
    }
    // Kill journaled pgids (SIGTERM first — I-10c) + verify dead.
    const killReport = await killJournaledPgids({
      events,
      campaignId: campaign.campaign_id,
      identity: args.identity,
      clock: args.clock,
      stream,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      ...(args.child !== undefined ? { child: args.child } : {}),
      ...(args.graceSeconds !== undefined
        ? { graceSeconds: args.graceSeconds }
        : {}),
    });
    // Verified death is a HARD precondition, exactly as on the live path: a
    // group that survived TERM+KILL — or one we could never prove dead, so
    // nothing was signaled — means NO aborted for its block, NO
    // campaign_cancelled, a named operator action, and a marker that keeps
    // the cancel pending (admission stays stopped until it completes).
    const unverified = unverifiedGroups(killReport);
    if (unverified.length > 0) {
      stream.write(
        `cancel: process group(s) ${unverified.join(
          ', ',
        )} could not be verified dead (${killReport.survived.length} survived TERM+KILL, ${killReport.reclaimedUnsafe.length} reclaimed without a verifiable identity) — operator action: identify and kill them by hand, then re-run \`quorum campaign cancel\`; cancel incomplete (campaign_cancelled NOT journaled), the cancel-request marker stays, and the campaign may still be spending\n`,
      );
      return { cancelled: false, postCrash: true };
    }
    // Complete any partial mint bundle BEFORE aborted (a kill whose
    // journaling never lands is still a kill recovery can reconcile; aborted
    // would otherwise destroy the disposition's legal source state).
    const universe = universeOf(campaign);
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
    // Aborted per in-flight block — the instance that ADMITTED each
    // non-terminal attempt (primary, reserve, or rerun), never "the last
    // block admitted". Idempotent against whatever a live dispatcher already
    // journaled before it died mid-sequence: a block with a landed aborted is
    // never re-aborted, and a superseded predecessor is the mint's business.
    const terminalAttempts = new Set<string>();
    const alreadyAborted = new Set<string>();
    const superseded = new Set<string>();
    for (const event of events) {
      if (
        event.type === 'run_completed' ||
        event.type === 'instrument_failure'
      ) {
        terminalAttempts.add(event.payload.attempt_id);
      } else if (event.type === 'aborted') {
        alreadyAborted.add(event.payload.block_id);
      } else if (event.type === 'block_replaced') {
        superseded.add(normalizeBlockReplaced(event.payload).block_id);
      }
    }
    const chain = admittedInstanceChain(events, universe);
    const inFlightBlocks = new Set<string>();
    for (const event of events) {
      if (event.type !== 'attempt_created') continue;
      if (terminalAttempts.has(event.payload.attempt_id)) continue;
      inFlightBlocks.add(blockOfAttempt(chain, event.payload.attempt_id));
    }
    for (const blockId of inFlightBlocks) {
      if (alreadyAborted.has(blockId) || superseded.has(blockId)) continue;
      bundle.push({ type: 'aborted', payload: { block_id: blockId } });
    }
    // campaign_cancelled LAST.
    bundle.push({
      type: 'campaign_cancelled',
      payload: reason !== '' ? { reason } : {},
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
