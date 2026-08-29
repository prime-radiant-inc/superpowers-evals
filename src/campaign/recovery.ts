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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Campaign,
  CampaignIdentity,
} from '../contracts/campaign/campaign.ts';
import {
  type CampaignUniverse,
  resolveCrashWindows,
} from '../contracts/campaign/crash-windows.ts';
import {
  type JournalEvent,
  normalizeBlockReplaced,
} from '../contracts/campaign/journal-events.ts';
import { type Clock, RealClock } from '../scheduler/clock.ts';
import {
  type BlockInterval,
  breachWindows,
  evaluateContention,
  type ResolvedThreshold,
  type SidecarLine,
} from './contention.ts';
import {
  cellKeyOfBlockId,
  compareAdmissionOrder,
  contentionResolutionBatch,
  type GroupSignaler,
  killGroupVerified,
  realGroupSignaler,
} from './dispatcher.ts';
import { type EventInput, replayEvents } from './journal.ts';
import {
  type ProcessIdentityProbe,
  realProcessIdentityProbe,
} from './locks.ts';

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
function universeOf(campaign: Campaign): CampaignUniverse {
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
  /** Provably gone before we signaled (ESRCH, or a reused pid — the
   *  recorded process is dead either way). */
  readonly alreadyDead: number[];
  /** Identity could not be established: recorded loudly, NEVER signaled. */
  readonly reclaimedWithoutKill: number[];
  /** Signaled but survived TERM+KILL — the caller must refuse to proceed. */
  readonly survived: number[];
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
  const reclaimedWithoutKill: number[] = [];
  const survived: number[] = [];
  const reclaim = (pgid: number, attemptId: string, why: string): void => {
    reclaimedWithoutKill.push(pgid);
    stream.write(
      `reclaimed-without-kill: pgid ${pgid} (attempt ${attemptId}) ${why} — recorded, never signaled blind (R-RCV-1)\n`,
    );
  };
  for (const event of args.events) {
    if (event.type !== 'run_allocated') continue;
    const attemptId = event.payload.attempt_id;
    if (terminalAttempts.has(attemptId)) continue;
    const pgid = event.payload.pgid;
    const exists = identity.exists(pgid);
    if (exists === 'esrch') {
      alreadyDead.push(pgid);
      continue;
    }
    if (exists === 'unknown') {
      reclaim(
        pgid,
        attemptId,
        'process identity unknown (neither alive nor ESRCH)',
      );
      continue;
    }
    const commandLine = child.commandLine(pgid);
    if (commandLine === null) {
      reclaim(
        pgid,
        attemptId,
        'command line unreadable — campaign-child shape uninspectable',
      );
      continue;
    }
    if (!isCampaignChild(commandLine, args.campaignId, attemptId)) {
      reclaim(
        pgid,
        attemptId,
        'group leader is not this campaign child (pid reuse)',
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
        alreadyDead.push(pgid); // reused pid: the recorded child is gone
        break;
      case 'unknown':
        reclaim(pgid, attemptId, 'OS start time unreadable at kill time');
        break;
      case 'alive':
        survived.push(pgid);
        stream.write(
          `orphan pgid ${pgid} (attempt ${attemptId}) survived TERM+KILL — operator action: kill this process group manually before resuming; it is still spending\n`,
        );
        break;
    }
  }
  return { killed, alreadyDead, reclaimedWithoutKill, survived };
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

/** Decision D-13 terminal-evidence rule: every journaled non-terminal
 *  attempt whose run dir holds a complete verdict is journaled terminal from
 *  the evidence (outcome-derived, loud); every journaled attempt with no run
 *  dir at all re-enters via E7 rerun — under the id of the instance that
 *  ADMITTED it (primary, reserve, or rerun), never the last block admitted.
 *  An attempt the instance chain cannot explain refuses (blockOfAttempt). */
export function terminalEvidenceActions(args: {
  events: readonly JournalEvent[];
  universe: CampaignUniverse;
  verdictOf: (runId: string) => { final: string } | null;
}): {
  terminals: EventInput[];
  terminalAttemptIds: string[];
  rerunBlockIds: string[];
} {
  const terminalAttempts = new Set<string>();
  for (const event of args.events) {
    if (event.type === 'run_completed' || event.type === 'instrument_failure') {
      terminalAttempts.add(event.payload.attempt_id);
    }
  }
  const chain = admittedInstanceChain(args.events, args.universe);
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
        payload: {
          attempt_id: event.payload.attempt_id,
          outcome: verdict.final,
        },
      });
      terminalAttemptIds.push(event.payload.attempt_id);
      continue;
    }
    const blockId = blockOfAttempt(chain, event.payload.attempt_id);
    if (!rerunBlockIds.includes(blockId)) rerunBlockIds.push(blockId);
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
    const identity = parsed as Partial<CampaignIdentity> | null;
    if (
      identity === null ||
      typeof identity !== 'object' ||
      typeof identity.campaign_id !== 'string' ||
      typeof identity.execution_attempt_id !== 'string'
    ) {
      malformed.push({
        runId: entry,
        detail:
          'not a campaign identity (campaign_id/execution_attempt_id missing)',
      });
      continue;
    }
    identities.push({ runId: entry, identity: identity as CampaignIdentity });
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
