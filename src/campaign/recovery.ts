// Recovery cores (kernel D3, R-RCV-1..5; the ratified OQ-11 contention-mint
// amendment): kill journaled pgids FIRST (identity-guarded), reconcile the
// journal against run dirs, complete partial mint bundles BEFORE the
// crash-window resolver actions, execute BOTH resolutions (void+re-admit and
// kill+rerun), quarantine by attempt-id mismatch against the run dir's
// persisted campaign identity, and re-derive an interrupted closed-window
// contention batch from the durable sidecar. Every core here is pure over a
// journal prefix plus injected seams; the resume and cancel verbs drive them
// in the pinned order.
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
import {
  type BlockInterval,
  evaluateContention,
  type ResolvedThreshold,
  type SidecarLine,
} from './contention.ts';
import {
  cellKeyOfBlockId,
  compareAdmissionOrder,
  contentionResolutionBatch,
} from './dispatcher.ts';
import { type EventInput, replayEvents } from './journal.ts';

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

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
 *  under the wrong id. */
interface InstanceChain {
  readonly rosterByBlock: Map<string, readonly string[]>;
  readonly admittedSeq: Map<string, number>;
  readonly sampleOfAttempt: Map<string, string>;
  readonly createdSeq: Map<string, number>;
  readonly admissions: { blockId: string; seq: number }[];
}

function admittedInstanceChain(
  events: readonly JournalEvent[],
  universe?: CampaignUniverse,
): InstanceChain {
  const rosterByBlock = new Map<string, readonly string[]>(
    (universe?.blocks ?? []).map((b) => [b.block_id, b.sample_ids]),
  );
  const admittedSeq = new Map<string, number>();
  const sampleOfAttempt = new Map<string, string>();
  const createdSeq = new Map<string, number>();
  const admissions: { blockId: string; seq: number }[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'block_admitted':
        admittedSeq.set(event.payload.block_id, event.seq);
        admissions.push({ blockId: event.payload.block_id, seq: event.seq });
        break;
      case 'attempt_created':
        sampleOfAttempt.set(event.payload.attempt_id, event.payload.sample_id);
        createdSeq.set(event.payload.attempt_id, event.seq);
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
    admissions,
  };
}

/** The instance an attempt belongs to: the latest-admitted instance whose
 *  roster holds the attempt's sample at creation time. Falls back to the
 *  most recent admission when membership is unknown (a caller without the
 *  frozen universe cannot see primary rosters — they are not journaled). */
function blockOfAttempt(
  chain: InstanceChain,
  attemptId: string,
): string | undefined {
  const sampleId = chain.sampleOfAttempt.get(attemptId);
  const createdAt = chain.createdSeq.get(attemptId);
  if (sampleId === undefined || createdAt === undefined) return undefined;
  let best: { blockId: string; seq: number } | undefined;
  for (const [blockId, roster] of chain.rosterByBlock) {
    if (!roster.includes(sampleId)) continue;
    const admitted = chain.admittedSeq.get(blockId);
    if (admitted === undefined || admitted > createdAt) continue;
    if (best === undefined || admitted > best.seq) {
      best = { blockId, seq: admitted };
    }
  }
  if (best !== undefined) return best.blockId;
  let fallback: string | undefined;
  for (const admission of chain.admissions) {
    if (admission.seq <= createdAt) fallback = admission.blockId;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// R-RCV-1: kill journaled pgids first
// ---------------------------------------------------------------------------

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
  const stream = args.stream ?? {
    write: (s: string) => process.stderr.write(s),
  };
  const inspect =
    args.inspectGroup ??
    ((pgid: number) => {
      try {
        process.kill(-pgid, 0);
        return 'ok' as const;
      } catch {
        return 'failed' as const;
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

// ---------------------------------------------------------------------------
// R-RCV-2 / R-RCV-5: the crash-window plan
// ---------------------------------------------------------------------------

export interface RecoveryPlan {
  /** Post-run_allocated without a terminal: kill the pgid, rerun the block. */
  readonly kills: { attempt_id: string; pgid: number }[];
  /** Pre-run_allocated: void the attempt and re-admit its instance. Both
   *  resolutions are EXECUTED — dropping this one leaves a sample whose
   *  attempt is bound but never spawned stuck for the rest of the run. */
  readonly voidReadmissions: {
    attempt_id: string;
    sample_id: string;
    block_id: string;
  }[];
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
  const kills = report.attempts
    .filter(
      (a) => a.resolution === 'kill_pgid_rerun_block' && a.pgid !== undefined,
    )
    .map((a) => ({ attempt_id: a.attempt_id, pgid: a.pgid as number }));
  const voidReadmissions: RecoveryPlan['voidReadmissions'] = [];
  for (const attempt of report.attempts) {
    if (attempt.resolution !== 'void_attempt_readmit') continue;
    const sampleId = chain.sampleOfAttempt.get(attempt.attempt_id);
    const blockId = blockOfAttempt(chain, attempt.attempt_id);
    if (sampleId === undefined || blockId === undefined) {
      // Fail-closed: an unattributable crash window is never dropped
      // silently — the whole point of executing this resolution.
      throw new RecoveryError(
        `attempt ${attempt.attempt_id} has no admitted instance in the journal — its pre-allocation crash window cannot be resolved; ${AUDIT}`,
      );
    }
    voidReadmissions.push({
      attempt_id: attempt.attempt_id,
      sample_id: sampleId,
      block_id: blockId,
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
    dispositionCompletions,
    successorReadmissions,
  };
}

/** The standing tail of every fail-closed recovery refusal. */
const AUDIT =
  'quarantine the campaign directory for manual audit before any rebuild or resume';

// ---------------------------------------------------------------------------
// Decision D-13: terminal evidence without a journaled terminal
// ---------------------------------------------------------------------------

/** Decision D-13 terminal-evidence rule: every journaled non-terminal
 *  attempt whose run dir holds a complete verdict is journaled terminal from
 *  the evidence (outcome-derived, loud); every journaled attempt with no run
 *  dir at all re-enters via E7 rerun — under the id of the instance that
 *  ADMITTED it (primary, reserve, or rerun), never the last block admitted. */
export function terminalEvidenceActions(args: {
  events: readonly JournalEvent[];
  verdictOf: (runId: string) => { final: string } | null;
  /** The frozen universe when the caller holds it (resume always does):
   *  primary rosters are not journaled, so without it a primary attempt
   *  falls back to the most recent admission. */
  universe?: CampaignUniverse;
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
    } else {
      const blockId = blockOfAttempt(chain, event.payload.attempt_id);
      if (blockId !== undefined && !rerunBlockIds.includes(blockId)) {
        rerunBlockIds.push(blockId);
      }
    }
  }
  return { terminals, terminalAttemptIds, rerunBlockIds };
}

// ---------------------------------------------------------------------------
// R-RCV-3 / R-RCV-4: the run-dir identity sweep
// ---------------------------------------------------------------------------

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
      // R-RCV-4's residual: the spawn-to-run_allocated window, and any run
      // whose allocation could no longer be journaled. The identity file is
      // the only surviving evidence — a journaled-pgid sweep cannot see it.
      actions.push({
        type: 'quarantined',
        payload: { run_id: runId, reason: 'late_terminal' },
      });
      continue;
    }
    if (attemptId !== identity.execution_attempt_id) {
      actions.push({
        type: 'quarantined',
        payload: {
          run_id: runId,
          attempt_id: attemptId,
          reason: 'attempt_mismatch',
        },
      });
    }
  }
  return actions;
}

/** Scan a results root for run dirs carrying a persisted campaign identity
 *  (`<runDir>/campaign-identity.json`, written at run-dir allocation — task
 *  6c; it is what makes R-RCV-3's mismatch detectable at all). Dirs without
 *  a readable identity file are skipped: a non-campaign run dir is not
 *  campaign evidence. A malformed identity is NOT skipped — it is kept as
 *  the mismatch it is, so quarantine stays loud. */
export function readRunDirIdentities(
  resultsRoot: string,
): { runId: string; identity: CampaignIdentity }[] {
  if (!existsSync(resultsRoot)) return [];
  const out: { runId: string; identity: CampaignIdentity }[] = [];
  for (const entry of readdirSync(resultsRoot)) {
    try {
      const identity = JSON.parse(
        readFileSync(
          join(resultsRoot, entry, 'campaign-identity.json'),
          'utf8',
        ),
      ) as CampaignIdentity;
      out.push({ runId: entry, identity });
    } catch {
      // absent or unreadable identity: skip (not campaign evidence)
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The interrupted closed-window contention batch (ratified OQ-11)
// ---------------------------------------------------------------------------

/** Interrupted closed-window contention batches (ratified OQ-11): landed
 *  reason=contention mints stay authoritative; re-derive ONLY the missing
 *  ordered suffix from the durable sidecar under one writer critical
 *  section. Sidecar loss never reverses the landed prefix. */
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
  // Fold landed contention mints + cell resolutions: authoritative, never
  // re-derived or duplicated. A block superseded for ANY reason is no
  // longer a live obligation.
  const supersededBlocks = new Set<string>();
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
  // Conservative block intervals, lineage-attributed: earliest roster
  // attempt_created -> latest service-end terminal; a block with an attempt
  // that never terminaled stays OPEN (the evaluator clips it to the
  // horizon), so a breach after a sibling's completion still counts.
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
      if (blockId === undefined) continue;
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
    if (blockId === undefined) continue;
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
  // One pure evaluator (task 7): tri-state over the durable sidecar.
  const lastTerminal = events.reduce((m, e) => Math.max(m, e.ts_ms), 0);
  const thresholds: ResolvedThreshold[] = campaign.contention.thresholds.map(
    (t) => ({ metric: t.metric, op: t.op, value: t.value }),
  );
  const verdicts = evaluateContention({
    lines: sidecarLines,
    truncatedTail: args.truncatedTail,
    thresholds,
    sustainK: campaign.contention.sustain_k,
    cadenceMs: campaign.contention.cadence_ms,
    coverageN: campaign.contention.coverage_n,
    cpuCores: campaign.contention.host_fingerprint.cpu_cores,
    campaignOpenedTsMs: openedTsMs,
    lastTerminalTsMs: lastTerminal,
    blocks: intervals,
  });
  // Obligations = invalid EXECUTED instances (primary, reserve, or rerun)
  // not already superseded or resolved, in the same frozen
  // comparison/cell/replicate + lineage-mint order dispatch uses.
  const obligations = intervals
    .map((i) => i.block_id)
    .filter(
      (blockId) =>
        verdicts.get(blockId) === 'invalid' && !supersededBlocks.has(blockId),
    )
    .sort((a, b) => compareAdmissionOrder({ block_id: a }, { block_id: b }));
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
    obligations,
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
