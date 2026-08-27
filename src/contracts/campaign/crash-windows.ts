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

interface MintRosterEntry {
  sample_id: string;
  arm?: string | undefined;
  // zod infers optional fields as `T | undefined`; explicit-undefined
  // compatibility keeps BlockReplacedRecord rosters assignable here.
  supersedes?: string | undefined;
}

interface MintRecord {
  readonly mintSeq: number;
  readonly predecessor: string;
  readonly successor: string;
  readonly kind: 'replacement' | 'rerun';
  readonly reason: string;
  readonly reserveActivation: boolean;
  readonly roster: readonly MintRosterEntry[];
}

interface InstrumentFailureRecord {
  readonly attemptId: string;
  readonly sampleId: string;
  readonly blockId: string;
  readonly seq: number;
}

interface AdjudicationRecord {
  readonly cell: string;
  readonly disposition: string;
  readonly seq: number;
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
  readonly instrumentFailures: readonly InstrumentFailureRecord[];
  readonly adjudications: readonly AdjudicationRecord[];
}

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
    if (best === undefined || admitted > best.seq)
      best = { blockId, seq: admitted };
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
  const instrumentFailures: InstrumentFailureRecord[] = [];
  const adjudications: AdjudicationRecord[] = [];
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
              blockOfSampleFor(
                { rosterByBlock, blockAdmittedSeq },
                sampleId,
                event.seq,
              ) ?? '',
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
        for (const sampleId of rosterByBlock.get(event.payload.block_id) ??
          []) {
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
          roster = succSamples.map((sampleId) => {
            const arm = armBySample.get(sampleId);
            const pred = predSamples.find((p) => armBySample.get(p) === arm);
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
    const createdSeq =
      fold.attemptCreatedSeq.get(attemptId) ?? Number.NEGATIVE_INFINITY;
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
  if (next !== undefined)
    return chainResolvesToIncludedTerminal(fold, next, depth + 1);
  // Not superseded: included terminal = completed via a successor-local
  // witness (post-mint where a mint applies).
  const mint = [...fold.mintBySuccessor.values()].find((m) =>
    m.roster.some((entry) => entry.sample_id === sampleId),
  );
  if (mint !== undefined)
    return successorSampleDischarged(fold, mint, sampleId);
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
  // Activated reserve membership derives per-block below via mintBySuccessor.
  const cellBySample = new Map<string, string | undefined>(
    universe.samples.map((s) => [s.sample_id, s.cell]),
  );
  // Clause 1 (+5): every frozen primary sample and every activated reserve
  // sample is accounted; budget_stopped terminals count forever (E7.6).
  for (const sample of universe.samples) {
    // Clause 4 exempts unactivated RESERVE BLOCK members only. A frozen
    // sample belonging to no block at all is document-invalid (E7.0's
    // every-sample-in-exactly-one-block) and fails closed: it must be
    // accounted like a primary or the predicate refuses.
    const inUnactivatedReserve = universe.blocks.some(
      (b) =>
        b.slot === 'reserve' &&
        !fold.mintBySuccessor.has(b.block_id) &&
        b.sample_ids.includes(sample.sample_id),
    );
    if (inUnactivatedReserve) continue; // clause 4: reserve is capacity, not a promise
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
        attempts.push({
          attempt_id: attemptId,
          resolution: 'void_attempt_readmit',
        });
      }
    }
  }

  const campaign =
    !fold.sealed && !fold.cancelled && sealPredicateHolds(universe, events)
      ? 'regenerate_report'
      : 'none';
  return { attempts, campaign };
}
