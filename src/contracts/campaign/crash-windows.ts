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
  /** Active roster samples whose current attempt/fact has no terminal. */
  readonly samplesLackingTerminals: string[];
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
  /** Latest RE-ENTERABLE terminal-fact seq per sample — the aborted
   *  roster fan-out only, the one fact a rerun re-entry lifts (E7.1's
   *  re-entry sources are aborted | completed | instrument_failed; the
   *  attempt-level two live via currentAttempt). Dispositions never arm
   *  this: a superseded sample accounts only through its chain (E7.3a). */
  readonly sampleTerminalSeq: Map<string, number>;
  /** Samples holding a PERMANENT terminal fact (slot_exhausted,
   *  budget_stopped, skew_excluded roster fan-out) — E7.1's REJECT set: a
   *  rerun re-entry never lifts these and a budget raise never resurrects
   *  budget_stopped (E7.6). */
  readonly permanentTerminalSamples: Set<string>;
  /** Latest rerun re-admission seq per sample (block_admitted with
   *  rerun_of). A terminal fact older than the re-entry is
   *  predecessor-era: the re-entry edge restored the sample to admitted,
   *  so the stale fact never retires the re-entered instance (E7.1). */
  readonly reentrySeq: Map<string, number>;
  /** Samples whose excluded_block_replaced disposition MATCHED a mint
   *  roster pair — resolver retirement (their evidence moved to a
   *  successor; recovery must not kill or re-admit around it). An orphan
   *  disposition retires nothing here: absent from the canonical roster
   *  graph it is replay corruption, not moved evidence (E7.3a). */
  readonly excludedSamples: Set<string>;
  /** E7.3a conservation, armed at mint time: `pred, succ` keys for
   *  every roster supersedes pair whose predecessor was disposable
   *  (source set admitted | spawned | exposed | completed) and whose
   *  excluded_block_replaced disposition has not yet landed. Non-empty at
   *  seal = incomplete mint bundle — seal refuses. */
  readonly pendingRequiredDispositions: Set<string>;
  /** Count of excluded_block_replaced dispositions matching no mint
   *  roster pair — replay corruption (E7.3a); any orphan refuses seal. */
  readonly orphanDispositions: number;
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

/** One conservation key per (predecessor, superseding successor) pair. */
function dispositionKey(predecessor: string, supersededBy: string): string {
  return JSON.stringify([predecessor, supersededBy]);
}

/** A standing terminal FACT for the sample: any permanent terminal, or a
 *  re-enterable (aborted) fact no rerun re-entry has lifted. Callable
 *  mid-fold (the block_replaced arm asks it about pre-mint state). */
function factTerminal(
  fold: Pick<
    PrefixFold,
    'permanentTerminalSamples' | 'sampleTerminalSeq' | 'reentrySeq'
  >,
  sampleId: string,
): boolean {
  if (fold.permanentTerminalSamples.has(sampleId)) return true;
  const factSeq = fold.sampleTerminalSeq.get(sampleId);
  const reentry = fold.reentrySeq.get(sampleId);
  return factSeq !== undefined && (reentry === undefined || factSeq > reentry);
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
  const instrumentFailedAttempts = new Set<string>();
  const sampleTerminalSeq = new Map<string, number>();
  const permanentTerminalSamples = new Set<string>();
  const reentrySeq = new Map<string, number>();
  const excludedSamples = new Set<string>();
  const pendingRequiredDispositions = new Set<string>();
  let orphanDispositions = 0;
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

  // Facts and re-entries keep the LATEST seq per key; the journal is
  // monotonic but never trust caller ordering.
  const noteSeq = (map: Map<string, number>, key: string, seq: number) => {
    const prev = map.get(key);
    if (prev === undefined || seq > prev) map.set(key, seq);
  };

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
          instrumentFailedAttempts.add(event.payload.attempt_id);
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
      case 'sample_disposition': {
        if (event.payload.disposition !== 'excluded_block_replaced') break;
        const disposed = event.payload.sample_id;
        const supersededBy = event.payload.superseded_by;
        // E7.3a: the roster is the canonical supersession graph. A matched
        // disposition completes its mint bundle and retires the sample for
        // recovery (mints are durable-first, so the mint always precedes
        // its dispositions). An unmatched disposition is replay corruption:
        // it accounts nothing, retires nothing, and refuses seal.
        const matched = mints.some((m) =>
          m.roster.some(
            (entry) =>
              entry.supersedes === disposed && entry.sample_id === supersededBy,
          ),
        );
        if (matched) {
          excludedSamples.add(disposed);
          pendingRequiredDispositions.delete(
            dispositionKey(disposed, supersededBy),
          );
        } else {
          orphanDispositions += 1;
        }
        break;
      }
      // Validity/shortfall terminals are E7.1's re-entry REJECT set — a
      // rerun admission never lifts them, and budget_stopped in particular
      // is never resurrected (E7.6).
      case 'slot_exhausted':
        permanentTerminalSamples.add(event.payload.sample_id);
        break;
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          permanentTerminalSamples.add(sampleId);
        }
        break;
      case 'aborted': {
        noteSeq(blockTerminalSeq, event.payload.block_id, event.seq);
        // The one RE-ENTERABLE fact: a rerun admission restores aborted
        // roster samples to admitted (E7.1), so the fan-out keeps its seq
        // for the re-entry comparison instead of a permanent mark.
        for (const sampleId of rosterByBlock.get(event.payload.block_id) ??
          []) {
          noteSeq(sampleTerminalSeq, sampleId, event.seq);
        }
        break;
      }
      case 'skew_excluded': {
        noteSeq(blockTerminalSeq, event.payload.block_id, event.seq);
        for (const sampleId of rosterByBlock.get(event.payload.block_id) ??
          []) {
          permanentTerminalSamples.add(sampleId);
        }
        break;
      }
      case 'block_admitted': {
        noteSeq(blockAdmittedSeq, event.payload.block_id, event.seq);
        // E7.1 re-entry edge: a rerun admission restores the instance's
        // roster samples to admitted — predecessor-era terminal facts stop
        // counting for the re-entered samples.
        if (event.payload.rerun_of !== undefined) {
          for (const sampleId of rosterByBlock.get(event.payload.block_id) ??
            []) {
            noteSeq(reentrySeq, sampleId, event.seq);
          }
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
        // E7.3a conservation, judged on pre-mint state: every supersedes
        // pair whose predecessor sits in the disposition source set
        // (admitted | spawned | exposed | completed) must gain exactly its
        // excluded_block_replaced disposition before seal. A predecessor
        // keeping a terminal instead — a standing fact, or a CURRENT-ERA
        // instrument-failed attempt (the cause consumed the activation) —
        // requires none; a never-admitted predecessor block leaves its
        // samples planned, outside the source set. The instrument-failed
        // exemption is era-scoped like the facts: a rerun re-entry lifts
        // instrument_failed back to admitted (E7.1), so only an attempt
        // created AFTER any re-entry exempts — a stale predecessor-era
        // failure leaves the re-entered sample disposition-eligible.
        const predecessorAdmitted =
          blockAdmittedSeq.get(rec.block_id) !== undefined;
        for (const entry of roster) {
          if (entry.supersedes === undefined) continue;
          supersededSamples.set(entry.supersedes, entry.sample_id);
          if (!predecessorAdmitted) continue;
          const current = currentAttempt.get(entry.supersedes);
          const reentry = reentrySeq.get(entry.supersedes);
          const currentEraInstrumentFailed =
            current !== undefined &&
            instrumentFailedAttempts.has(current) &&
            (reentry === undefined ||
              (attemptCreatedSeq.get(current) ?? Number.NEGATIVE_INFINITY) >
                reentry);
          const keepsTerminal =
            factTerminal(
              { permanentTerminalSamples, sampleTerminalSeq, reentrySeq },
              entry.supersedes,
            ) || currentEraInstrumentFailed;
          if (!keepsTerminal) {
            pendingRequiredDispositions.add(
              dispositionKey(entry.supersedes, entry.sample_id),
            );
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
    sampleTerminalSeq,
    permanentTerminalSamples,
    reentrySeq,
    excludedSamples,
    pendingRequiredDispositions,
    orphanDispositions,
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

/** A sample is terminal when it holds a standing terminal FACT (permanent,
 *  or re-enterable and not lifted — factTerminal), or when its CURRENT
 *  (latest-created) attempt reached a terminal event. A stale terminal for
 *  a superseded attempt never retires the newer attempt (parent Identity:
 *  late events are quarantined by attempt-id mismatch). */
function sampleTerminal(fold: PrefixFold, sampleId: string): boolean {
  if (factTerminal(fold, sampleId)) return true;
  const current = fold.currentAttempt.get(sampleId);
  return current !== undefined && fold.terminalAttempts.has(current);
}

/** Active roster samples with no current terminal fact. The resolver and the
 * report diagnostic both use this derived set: frozen reserves stay inactive
 * until their block is minted, while mint rosters add replacement/rerun
 * instances that are absent from the frozen document's block list. */
function samplesLackingTerminals(
  fold: PrefixFold,
  universe: CampaignUniverse,
): string[] {
  const slotByBlock = new Map(
    universe.blocks.map((block) => [block.block_id, block.slot]),
  );
  const activeSamples = new Set<string>();

  for (const sample of universe.samples) {
    const homes = universe.blocks.filter((block) =>
      block.sample_ids.includes(sample.sample_id),
    );
    if (
      homes.length === 0 ||
      homes.some(
        (block) =>
          block.slot !== 'reserve' || fold.mintBySuccessor.has(block.block_id),
      )
    ) {
      activeSamples.add(sample.sample_id);
    }
  }

  for (const [blockId, roster] of fold.rosterByBlock) {
    if (
      slotByBlock.get(blockId) === 'reserve' &&
      !fold.mintBySuccessor.has(blockId)
    ) {
      continue;
    }
    for (const sampleId of roster) activeSamples.add(sampleId);
  }

  return [...activeSamples].filter(
    (sampleId) =>
      !sampleTerminal(fold, sampleId) && !fold.excludedSamples.has(sampleId),
  );
}

/** Successor-local post-mint terminal witness (E7.1): the sample's CURRENT
 *  attempt — created after the mint AND after the successor's own
 *  block_admitted, and attributable to THIS successor instance (the latest
 *  block admitted for the sample at the attempt's creation; an attempt of a
 *  later rerun instance never discharges this one) — that reached a
 *  terminal event; or a post-mint block-terminal event naming the
 *  successor. Predecessor-era terminals never count. `includedOnly`
 *  narrows the witness to completed (run_completed) terminals — the E7.3
 *  "included terminal" property the supersession chain must end at. */
function successorSampleDischarged(
  fold: PrefixFold,
  mint: MintRecord,
  sampleId: string,
  includedOnly: boolean,
): boolean {
  if (!includedOnly) {
    // A post-mint block-terminal (aborted/skew_excluded) discharges the
    // clause-2 obligation, but it is never an INCLUDED (completed) leaf —
    // an aborted successor cannot terminate a supersession chain (E7.3a).
    const blockTerminal = fold.blockTerminalSeq.get(mint.successor);
    if (blockTerminal !== undefined && blockTerminal > mint.mintSeq) {
      return true;
    }
  }
  const admitted = fold.blockAdmittedSeq.get(mint.successor);
  if (admitted === undefined) return false; // minted-but-unadmitted: zero witnesses
  const current = fold.currentAttempt.get(sampleId);
  if (current === undefined) return false;
  const createdSeq =
    fold.attemptCreatedSeq.get(current) ?? Number.NEGATIVE_INFINITY;
  if (createdSeq <= mint.mintSeq || createdSeq <= admitted) return false;
  if (
    includedOnly
      ? !fold.completedAttempts.has(current)
      : !fold.terminalAttempts.has(current)
  ) {
    return false;
  }
  return blockOfSampleFor(fold, sampleId, createdSeq) === mint.successor;
}

/** The derived E7.3 "included terminal sample": completed (never a bare
 *  instrument_failure — that is a chained failure, not an included
 *  outcome), non-superseded (the chain leaf is reached only when
 *  supersededSamples has no entry), and successor-local (post-mint where a
 *  mint applies). Rerun instances reuse sample ids, so the witness is
 *  judged against the LATEST mint naming the sample — the current
 *  instance; an earlier instance's attribution would refuse a legitimately
 *  completed rerun forever. */
function includedTerminal(fold: PrefixFold, sampleId: string): boolean {
  let mint: MintRecord | undefined;
  for (const candidate of fold.mints) {
    if (!candidate.roster.some((entry) => entry.sample_id === sampleId)) {
      continue;
    }
    if (mint === undefined || candidate.mintSeq > mint.mintSeq) {
      mint = candidate;
    }
  }
  if (mint !== undefined) {
    return successorSampleDischarged(fold, mint, sampleId, true);
  }
  const current = fold.currentAttempt.get(sampleId);
  return current !== undefined && fold.completedAttempts.has(current);
}

function chainResolvesToIncludedTerminal(
  fold: PrefixFold,
  sampleId: string,
  depth = 0,
): boolean {
  if (depth > 64) return false; // cyclic graph is replay corruption; fail seal
  const next = fold.supersededSamples.get(sampleId);
  if (next !== undefined) {
    return chainResolvesToIncludedTerminal(fold, next, depth + 1);
  }
  return includedTerminal(fold, sampleId);
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
  const cellBySample = new Map<string, string | undefined>(
    universe.samples.map((s) => [s.sample_id, s.cell]),
  );
  // Clause 1 (+5): every frozen primary sample and every activated reserve
  // sample is accounted; budget_stopped terminals count forever (E7.6).
  for (const sample of universe.samples) {
    // E7.0 every-sample-in-exactly-one-block, validated BEFORE any
    // exemption: malformed membership (no block, or more than one) is a
    // loud rejection — never a silent skip and never an attempt-accounted
    // pass.
    const home = universe.blocks.filter((b) =>
      b.sample_ids.includes(sample.sample_id),
    );
    const block = home[0];
    if (block === undefined || home.length !== 1) return false;
    if (block.slot === 'reserve' && !fold.mintBySuccessor.has(block.block_id)) {
      continue; // clause 4: an unactivated reserve block is capacity, not a promise
    }
    // E7.3a: for a superseded sample the chain check is the BINDING arm of
    // clause 1 — generic terminality (facts, current attempt) never
    // accounts it; only its chain or a typed cell resolution does.
    const accounted = fold.supersededSamples.has(sample.sample_id)
      ? chainResolvesToIncludedTerminal(fold, sample.sample_id) ||
        adjudicationCovers(fold, cellBySample.get(sample.sample_id))
      : sampleTerminal(fold, sample.sample_id) ||
        chainResolvesToIncludedTerminal(fold, sample.sample_id) ||
        adjudicationCovers(fold, cellBySample.get(sample.sample_id));
    if (!accounted) return false;
  }
  // E7.3a conservation: supersession chains are fully paired — every
  // roster supersedes pair whose predecessor was disposable at mint time
  // gained its excluded_block_replaced disposition (resume completes the
  // bundle before sealing), and every disposition paired with a roster
  // entry (an orphan is replay corruption). Either failure refuses seal.
  if (fold.pendingRequiredDispositions.size > 0) return false;
  if (fold.orphanDispositions > 0) return false;
  // Clause 2: every activated successor discharged by successor-local,
  // post-mint witnesses regardless of admission state.
  for (const mint of fold.mints) {
    for (const entry of mint.roster) {
      if (!successorSampleDischarged(fold, mint, entry.sample_id, false)) {
        return false;
      }
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
      // Resolver retirement: a terminal sample, or a roster-matched
      // disposition that moved its evidence to a successor (recovery never
      // kills or re-admits around moved evidence). An orphan disposition
      // matches no roster pair — corruption, not moved evidence — so it
      // retires nothing and the live attempt still resolves.
      if (
        sampleTerminal(fold, sampleId) ||
        fold.excludedSamples.has(sampleId)
      ) {
        continue;
      }
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
  return {
    attempts,
    samplesLackingTerminals: samplesLackingTerminals(fold, universe),
    campaign,
  };
}
