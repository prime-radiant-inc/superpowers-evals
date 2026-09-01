// The seal act (kernel D4a, task 5 — spec
// docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md
// §The seal act): the terminus sequence `campaign run` performs when the E7
// instance-complete seal predicate holds — pre-seal snapshot verify, the
// seal-time integrity audit + contention backstop (D3 Decision D-5's two
// seal-time roles), the descriptive fold, the ONE `sealed { report_digest }`
// append, and atomic md-then-json publication.
//
// Atomicity boundary: the single `sealed` append through the ONE
// restrict-mode sealer-writer (R-JRN-3: `electWriter({ restrict:
// ['adjudication', 'sealed'] })`, elected lazily at the first journal need,
// released on every path). Any storage-full condition at a sealer append —
// including the election itself — leaves NOTHING sealed (`sealed` is one
// transaction) and returns `storage_failed` so resume re-attempts (D-13
// inheritance). Publication runs AFTER the sealed append: a failure there
// propagates loudly instead (the campaign IS sealed; the R-RCV-5 resume path
// completes publication digest-verified — returning storage_failed at that
// point would deny a sealed campaign its report).
//
// The cancel marker is re-checked before every step: a cancel requested
// mid-terminus wins — the campaign never seals.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import type { Campaign } from '../contracts/campaign/campaign.ts';
import { sealPredicateHolds } from '../contracts/campaign/crash-windows.ts';
import {
  type JournalEvent,
  type JournalEventType,
  normalizeBlockReplaced,
} from '../contracts/campaign/journal-events.ts';
import type { Report } from '../contracts/campaign/report.ts';
import type { Clock } from '../scheduler/clock.ts';
import { loadFrozenCampaign } from './campaign-document.ts';
import { evaluateContention, parseSidecar } from './contention.ts';
import {
  type ElectWriterArgs,
  type EventInput,
  electWriter,
  isStorageFullError,
  openJournalRead,
} from './journal.ts';
import type { ProcessIdentityProbe } from './locks.ts';
import { universeOf } from './recovery.ts';
import {
  canonicalReportBytes,
  digestReportBytes,
  foldDescriptiveReport,
  publishReport,
  renderReportMd,
} from './report.ts';
import { readSampleEvidence } from './report-evidence.ts';
import { resolveCampaignResultsRoot } from './results-root.ts';
import {
  reconstructCampaignSnapshot,
  verifyCampaignSnapshot,
} from './snapshot.ts';

/** D-12's cancel marker (the cancellation verb's own durable record). */
const CANCEL_MARKER = 'cancel-request';

/** The typed gating refusal (spec §Refusal table, Decision D-5/D-7). */
export const GATING_REFUSAL_MESSAGE = 'sealing gating campaigns awaits D4b';

/** Campaign-scoped incidents (the drift refusal) ride the control plane. */
const CONTROL_PLANE_CELL = 'control-plane';

/** The block identity encoding pinned by the attemptScopedRationale
 *  convention (`block=<block_id>; <detail>`, journal-events.ts) — a reader
 *  never has to guess which block a seal-time adjudication belongs to. */
const BLOCK_RATIONALE = /^block=([^;]+);/;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

/** Internal: a sealer append (or the election) failed with a D-13
 *  storage-full condition — mapped to the typed `storage_failed` outcome at
 *  the sequence boundary. Never escapes this module. */
class SealerStorageFull extends Error {}

export type TerminusResult =
  | { readonly outcome: 'sealed'; readonly digest: string }
  | { readonly outcome: 'refused_gating' }
  | { readonly outcome: 'refused_drift'; readonly trees: readonly string[] }
  | { readonly outcome: 'cancel_in_force' }
  | { readonly outcome: 'storage_failed'; readonly reason: string };

/** The sealer surface the terminus needs — a declared subset of D3's
 *  JournalWriter, so the storage-failure crash window (SQLITE_FULL at the
 *  sealed append) is scriptable through an injected election without the
 *  class's private-field structural barrier. Production is `electWriter`. */
export interface SealerWriter {
  appendEvent(input: EventInput): JournalEvent;
  release(): void;
}

export interface TerminusArgs {
  readonly campaignDir: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  /** Run-dir root for the evidence reader; default
   *  `resolveCampaignResultsRoot(undefined)` (`src/campaign/results-root.ts`). */
  readonly resultsRoot?: string;
  readonly runner?: CommandRunner; // default: production runner
  readonly stream?: { write(s: string): void };
  /** The sealer election seam; default D3's electWriter in restrict mode.
   *  Injectable so the SQLITE_FULL-at-the-sealed-append crash window is
   *  scriptable without mocking the journal away. */
  readonly electSealer?: (args: ElectWriterArgs) => SealerWriter;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One block's conservative service interval, journal-derived exactly the way
 *  the shared evaluator's BlockInterval contract pins: earliest roster
 *  attempt_created ts; latest service-end terminal ts (null when any member
 *  still lacks one — clipped to the horizon by the evaluator). */
interface ServiceInterval {
  readonly startTsMs: number;
  readonly endTsMs: number | null;
}

/** Everything the audit and backstop derive from the journal in one scan:
 * membership (universe blocks ∪ mint rosters, E7), per-block service
 * intervals, the supersession set, and the landed contention mints. */
interface JournalMembership {
  readonly rosterByBlock: ReadonlyMap<string, readonly string[]>;
  readonly intervals: ReadonlyMap<string, ServiceInterval>;
  readonly supersededBlocks: ReadonlySet<string>;
  readonly mintedSuccessors: ReadonlySet<string>;
  /** Predecessor block ids of landed closed-window contention mints
   *  (block_replaced with reason 'contention') — D3's resolution batch. */
  readonly contentionMintPredecessors: readonly string[];
}

function journalMembership(
  campaign: Campaign,
  events: readonly JournalEvent[],
): JournalMembership {
  // Frozen rosters seed membership (reserve blocks included — they are
  // pre-registered); fresh-roster mints overlay their successor's roster.
  const rosterByBlock = new Map<string, readonly string[]>(
    campaign.blocks.map((block) => [block.block_id, [...block.sample_ids]]),
  );
  const supersededBlocks = new Set<string>();
  const mintedSuccessors = new Set<string>();
  const contentionMintPredecessors: string[] = [];
  for (const event of events) {
    if (event.type !== 'block_replaced') continue;
    const rec = normalizeBlockReplaced(event.payload);
    supersededBlocks.add(rec.block_id);
    mintedSuccessors.add(rec.replacement_block_id);
    if (rec.reason === 'contention') {
      contentionMintPredecessors.push(rec.block_id);
    }
    if (rec.roster.length > 0) {
      rosterByBlock.set(
        rec.replacement_block_id,
        rec.roster.map((entry) => entry.sample_id),
      );
    }
    // A legacy empty roster leaves the successor's frozen roster standing
    // (E7.2: same-arm pairing is derivable from membership).
  }

  // Attribute every attempt to the most recently admitted instance whose
  // roster contains its sample, matching recovery.ts's instance-chain rule.
  // This is essential for reruns: their successor deliberately reuses the
  // predecessor sample IDs, so sample-wide clocks merge two instances.
  const admittedSeq = new Map<string, number>();
  const attempts: Array<{
    readonly attemptId: string;
    readonly sampleId: string;
    readonly createdSeq: number;
    readonly startTsMs: number;
  }> = [];
  const attemptsBySample = new Map<string, Array<(typeof attempts)[number]>>();
  for (const event of events) {
    switch (event.type) {
      case 'block_admitted':
        admittedSeq.set(event.payload.block_id, event.seq);
        break;
      case 'attempt_created':
        {
          const attempt = {
            attemptId: event.payload.attempt_id,
            sampleId: event.payload.sample_id,
            createdSeq: event.seq,
            startTsMs: event.ts_ms,
          };
          attempts.push(attempt);
          const sampleAttempts = attemptsBySample.get(attempt.sampleId) ?? [];
          sampleAttempts.push(attempt);
          attemptsBySample.set(attempt.sampleId, sampleAttempts);
        }
        break;
      default:
        break;
    }
  }

  const blockOfAttempt = new Map<string, string>();
  for (const attempt of attempts) {
    let best: { blockId: string; seq: number } | undefined;
    for (const [blockId, members] of rosterByBlock) {
      if (!members.includes(attempt.sampleId)) continue;
      const seq = admittedSeq.get(blockId);
      if (seq === undefined || seq > attempt.createdSeq) continue;
      if (best === undefined || seq > best.seq) best = { blockId, seq };
    }
    if (best === undefined) {
      throw new SealError(
        `attempt ${attempt.attemptId} (sample ${attempt.sampleId}) belongs to no instance admitted at or before its creation — the journal's admitted instance chain does not explain it`,
      );
    }
    blockOfAttempt.set(attempt.attemptId, best.blockId);
  }

  const firstAttemptTs = new Map<string, number>();
  const lastTerminalTs = new Map<string, number>();
  const terminalSamples = new Map<string, Set<string>>();
  const noteStart = (blockId: string, ts: number): void => {
    const prev = firstAttemptTs.get(blockId);
    if (prev === undefined || ts < prev) firstAttemptTs.set(blockId, ts);
  };
  const noteTerminal = (
    blockId: string,
    sampleId: string,
    ts: number,
  ): void => {
    const prev = lastTerminalTs.get(blockId);
    if (prev === undefined || ts > prev) lastTerminalTs.set(blockId, ts);
    const samples = terminalSamples.get(blockId) ?? new Set<string>();
    samples.add(sampleId);
    terminalSamples.set(blockId, samples);
  };
  const attemptForSampleAt = (
    sampleId: string,
    seq: number,
  ): string | undefined => {
    const sampleAttempts = attemptsBySample.get(sampleId) ?? [];
    for (let i = sampleAttempts.length - 1; i >= 0; i -= 1) {
      const attempt = sampleAttempts[i];
      if (attempt !== undefined && attempt.createdSeq <= seq)
        return blockOfAttempt.get(attempt.attemptId);
    }
    return undefined;
  };
  for (const attempt of attempts) {
    const blockId = blockOfAttempt.get(attempt.attemptId);
    if (blockId === undefined) {
      throw new SealError(
        `attempt ${attempt.attemptId} has no admitted instance association — the journal's attempt lineage is incomplete`,
      );
    }
    noteStart(blockId, attempt.startTsMs);
  }
  for (const event of events) {
    switch (event.type) {
      case 'run_completed':
      case 'instrument_failure': {
        const attempt = attempts.find(
          (candidate) => candidate.attemptId === event.payload.attempt_id,
        );
        const blockId = blockOfAttempt.get(event.payload.attempt_id);
        if (attempt !== undefined && blockId !== undefined)
          noteTerminal(blockId, attempt.sampleId, event.ts_ms);
        break;
      }
      case 'slot_exhausted': {
        const blockId = attemptForSampleAt(event.payload.sample_id, event.seq);
        if (blockId !== undefined)
          noteTerminal(blockId, event.payload.sample_id, event.ts_ms);
        break;
      }
      case 'budget_stopped':
        for (const sampleId of event.payload.sample_ids) {
          const blockId = attemptForSampleAt(sampleId, event.seq);
          if (blockId !== undefined)
            noteTerminal(blockId, sampleId, event.ts_ms);
        }
        break;
      case 'aborted':
      case 'skew_excluded':
        for (const sampleId of rosterByBlock.get(event.payload.block_id) ?? [])
          noteTerminal(event.payload.block_id, sampleId, event.ts_ms);
        break;
      default:
        break;
    }
  }

  const intervals = new Map<string, ServiceInterval>();
  for (const [blockId, members] of rosterByBlock) {
    const startTsMs = firstAttemptTs.get(blockId);
    if (startTsMs === undefined) continue; // never attempted: no service interval
    const ended = terminalSamples.get(blockId)?.size === members.length;
    // A member without a terminal keeps the interval open (conservative):
    // the evaluator clips it to the evaluation horizon.
    intervals.set(blockId, {
      startTsMs,
      endTsMs: ended ? (lastTerminalTs.get(blockId) ?? null) : null,
    });
  }
  return {
    rosterByBlock,
    intervals,
    supersededBlocks,
    mintedSuccessors,
    contentionMintPredecessors,
  };
}

/** Seal-time adjudications already journaled, keyed by the block named in the
 *  encoded rationale. Backstop dispositions use the block identity alone so
 *  either verdict suppresses a second backstop event; integrity dispositions
 *  retain their disposition prefix so their distinct classes remain separate.
 */
function existingBlockAdjudications(
  events: readonly JournalEvent[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event.type !== 'adjudication') continue;
    const isBackstop =
      event.payload.disposition === 'contention_invalidated' ||
      event.payload.disposition === 'unknown_coverage';
    const isIntegrity =
      event.payload.disposition === 'integrity_finding' ||
      event.payload.disposition === 'integrity_caveat';
    if (!isBackstop && !isIntegrity) continue;
    const blockId = BLOCK_RATIONALE.exec(event.payload.rationale)?.[1];
    if (blockId !== undefined) {
      out.add(
        isBackstop ? blockId : `${event.payload.disposition}\0${blockId}`,
      );
    }
  }
  return out;
}

/** The journal's real campaign_opened ts (C6: never 0, never a placeholder). */
function campaignOpenedTsMsOf(events: readonly JournalEvent[]): number {
  const opened = events.find((event) => event.type === 'campaign_opened');
  if (opened === undefined) {
    throw new SealError(
      'journal carries no campaign_opened event — the terminus cannot anchor contention coverage (the document loader anchors identity against exactly this event; its absence here is corruption)',
    );
  }
  return opened.ts_ms;
}

const TERMINAL_EVENT_TYPES: ReadonlySet<JournalEventType> = new Set([
  'run_completed',
  'instrument_failure',
  'slot_exhausted',
  'budget_stopped',
  'aborted',
  'skew_excluded',
]);

/** lastTerminalTsMs = the final terminal ts (D-4): the evaluation horizon.
 *  Adjudications the terminus itself appends never move it. */
function lastTerminalTsMs(
  events: readonly JournalEvent[],
  fallback: number,
): number {
  let horizon = fallback;
  for (const event of events) {
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      horizon = Math.max(horizon, event.ts_ms);
    }
  }
  return horizon;
}

/** Name the drifted trees after a failed pre-seal verify — re-reading each
 *  expected tree's HEAD and porcelain through the same runner seam and
 *  comparing against the registered refs (identity never derives from
 *  HEAD alone). Empty = nothing nameable as drift (the failure was not a
 *  tree drift; the caller rethrows the original error). */
function driftedTreeNames(
  campaign: Campaign,
  campaignDir: string,
  runner: CommandRunner,
): string[] {
  const drifted: string[] = [];
  const check = (label: string, dest: string, sha: string): void => {
    const head = runner.run('git', ['-C', dest, 'rev-parse', 'HEAD']);
    if (head.status !== 0 || head.stdout.trim() !== sha) {
      drifted.push(label);
      return;
    }
    const porcelain = runner.run('git', ['-C', dest, 'status', '--porcelain']);
    if (porcelain.status !== 0 || porcelain.stdout !== '') drifted.push(label);
  };
  check('evals', join(campaignDir, 'evals'), campaign.refs.evals);
  check('gauntlet', join(campaignDir, 'gauntlet'), campaign.refs.gauntlet);
  for (const sha of new Set(
    Object.values(campaign.refs.superpowers_by_arm).filter(
      (s): s is string => s !== null,
    ),
  )) {
    check(`superpowers-${sha}`, join(campaignDir, `superpowers-${sha}`), sha);
  }
  return drifted;
}

export function runTerminusSeal(args: TerminusArgs): TerminusResult {
  const campaignDir = args.campaignDir;
  const runner = args.runner ?? defaultCommandRunner;
  const stream = args.stream ?? {
    write: (s: string) => process.stdout.write(s),
  };
  const resultsRoot = resolveCampaignResultsRoot(args.resultsRoot);
  const cancelInForce = (): boolean =>
    existsSync(join(campaignDir, CANCEL_MARKER));

  // 0. Cancel marker — re-checked before EVERY subsequent step (a cancel
  //  requested mid-terminus wins: the campaign never seals).
  if (cancelInForce()) return { outcome: 'cancel_in_force' };

  // 1. Load the campaign + journal read handle. An inauthentic or missing
  //  document refuses loudly here (the not-registered/published refusal row).
  const campaign = loadFrozenCampaign(campaignDir);
  const reader = openJournalRead(campaignDir);
  let openedEvents: JournalEvent[];
  try {
    openedEvents = reader.readEvents(0);
  } finally {
    reader.close();
  }
  if (cancelInForce()) return { outcome: 'cancel_in_force' };
  if (campaign.suite.profile === 'release_gate_v1') {
    stream.write(`${GATING_REFUSAL_MESSAGE}\n`);
    return { outcome: 'refused_gating' };
  }

  // 2. The seal predicate MUST hold. The caller (D-3: the dispatch loop /
  //  R-RCV-5 resume) invokes the terminus only at predicate-holds — a
  //  violation is corruption, loud; so is a re-invocation over an
  //  already-sealed journal (the seal act runs exactly once).
  const universe = universeOf(campaign);
  if (openedEvents.some((event) => event.type === 'sealed')) {
    throw new SealError(
      `journal at ${campaignDir} already carries a sealed event — the seal act runs exactly once; this invocation is a caller-contract violation (the R-RCV-5 resume completes publication instead of re-sealing)`,
    );
  }
  if (!sealPredicateHolds(universe, openedEvents)) {
    throw new SealError(
      `the E7 instance-complete seal predicate does not hold over the journal at ${campaignDir} — the terminus seals only predicate-holds campaigns; a violation is corruption, never a silent partial seal`,
    );
  }

  const elect = args.electSealer ?? electWriter;
  let sealer: SealerWriter | null = null;
  const ensureSealer = (): SealerWriter => {
    if (sealer === null) {
      // THE sealer-writer (step 7's single-writer pin): elected at the first
      // journal need, restricted to the seal's two event types.
      sealer = elect({
        campaignDir,
        clock: args.clock,
        identity: args.identity,
        campaign,
        restrict: ['adjudication', 'sealed'],
      });
    }
    return sealer;
  };
  const appendThroughSealer = (input: EventInput): void => {
    try {
      ensureSealer().appendEvent(input);
    } catch (err) {
      if (isStorageFullError(err)) {
        throw new SealerStorageFull(
          `sealer append (${input.type}) hit a storage-full condition: ${errorMessage(err)}`,
        );
      }
      throw err;
    }
  };
  /** Release the sealer-writer on every path. `quiet` on the storage-failed
   *  path: a teardown failure there must not mask the D-13 outcome. */
  const releaseSealer = (quiet: boolean): void => {
    if (sealer === null) return;
    const writer = sealer;
    sealer = null;
    try {
      writer.release();
    } catch (err) {
      if (!quiet) throw err;
    }
  };

  const contention = campaign.contention;
  const thresholds = contention.thresholds.map((t) => ({
    metric: t.metric,
    op: t.op,
    value: t.value,
  }));
  const openedTsMs = campaignOpenedTsMsOf(openedEvents);
  const horizon = lastTerminalTsMs(openedEvents, openedTsMs);
  const membership = journalMembership(campaign, openedEvents);
  const adjudicated = existingBlockAdjudications(openedEvents);
  const cellBySample = new Map(
    campaign.samples.map((sample) => [sample.sample_id, sample.cell]),
  );
  const cellOfBlock = (blockId: string): string => {
    for (const sampleId of membership.rosterByBlock.get(blockId) ?? []) {
      const cell = cellBySample.get(sampleId);
      if (cell !== undefined) return cell;
    }
    throw new SealError(
      `block ${blockId} resolves to no registered cell — its seal-time adjudication is classifiable into no cell`,
    );
  };

  let report: Report;
  let jsonBytes: Buffer;
  let digest: string;
  // Quiet only on the storage-failed path: a release failure there (the same
  // full volume) must not mask the D-13 outcome. Every other path releases
  // loudly — before publication on the success path, so a teardown failure
  // leaves the sealed-without-report crash window the resume path completes,
  // never a completed publication with a leaked lease.
  let quietRelease = false;
  try {
    // 3. Pre-seal snapshot verify over the campaign-local materialization
    //  against the registered digests. Drift ⇒ journal the incident FIRST
    //  (the durable record — the re-run after repair is the operator's
    //  acknowledgement act, and the incident never vanishes from the sealed
    //  record), then refuse naming the drifted trees.
    if (cancelInForce()) return { outcome: 'cancel_in_force' };
    try {
      const handle = reconstructCampaignSnapshot({
        campaignDir,
        refs: campaign.refs,
        runner,
      });
      verifyCampaignSnapshot(handle, runner);
    } catch (err) {
      const trees = driftedTreeNames(campaign, campaignDir, runner);
      if (trees.length === 0) throw err; // not a nameable tree drift
      appendThroughSealer({
        type: 'adjudication',
        payload: {
          cell: CONTROL_PLANE_CELL,
          disposition: 'snapshot_drift_refused',
          rationale: `pre-seal verify at terminus: drifted trees: ${trees.join(', ')}`,
        },
      });
      stream.write(
        `refused to seal — snapshot drift at the terminus: ${trees.join(', ')}; the re-run after authorized repair is the acknowledgement act\n`,
      );
      return { outcome: 'refused_drift', trees };
    }

    const sidecar = parseSidecar(campaignDir);

    // 4. Seal-time integrity audit (D3 D-5 role one): re-compare available
    //  sidecar evidence against landed closed-window contention mints via
    //  the shared evaluator over the predecessor's service interval —
    //  'invalid' corroborates the mint; 'clean' contradicts it (evidence
    //  present, no breach window: a corruption-class finding);
    //  'unknown' means the evidence is lost (an attribution caveat — the
    //  mint cannot be re-verified). Either record is an adjudication, NEVER
    //  a reversal: the mint, its dispositions, and the replacement's
    //  accounting all stand.
    if (cancelInForce()) return { outcome: 'cancel_in_force' };
    for (const predecessor of membership.contentionMintPredecessors) {
      const interval = membership.intervals.get(predecessor);
      if (interval === undefined) continue; // never attempted: nothing to audit
      const verdict = evaluateContention({
        lines: sidecar.lines,
        truncatedTail: sidecar.truncatedTail,
        thresholds,
        sustainK: contention.sustain_k,
        cadenceMs: contention.cadence_ms,
        coverageN: contention.coverage_n,
        cpuCores: contention.host_fingerprint.cpu_cores,
        campaignOpenedTsMs: interval.startTsMs,
        lastTerminalTsMs: horizon,
        blocks: [
          {
            block_id: predecessor,
            startTsMs: interval.startTsMs,
            endTsMs: interval.endTsMs,
          },
        ],
      }).get(predecessor);
      if (verdict === 'invalid' || verdict === undefined) continue;
      const disposition =
        verdict === 'unknown' ? 'integrity_caveat' : 'integrity_finding';
      if (adjudicated.has(`${disposition}\0${predecessor}`)) continue;
      const detail =
        verdict === 'unknown'
          ? `integrity audit attribution caveat: sidecar evidence lost over the predecessor interval [${interval.startTsMs}, ${interval.endTsMs ?? 'clipped to campaign end'}] — the contention mint cannot be re-verified`
          : `integrity audit recompute mismatch: the landed contention mint has no corroborating breach window over the predecessor interval [${interval.startTsMs}, ${interval.endTsMs ?? 'clipped to campaign end'}] (evidence present)`;
      appendThroughSealer({
        type: 'adjudication',
        payload: {
          cell: cellOfBlock(predecessor),
          disposition,
          rationale: `block=${predecessor}; ${detail}`,
        },
      });
    }

    // 5. Seal-time contention backstop (D-4, D3 D-5 role two): the shared
    //  evaluator with the journal's REAL campaign_opened ts and the final
    //  terminal ts as horizon, over every live block's service interval.
    //  'invalid' (breach still open at campaign end) mints
    //  contention_invalidated; 'unknown' (uncovered overlap) mints
    //  unknown_coverage — one adjudication per affected block, deduped
    //  against what already sits in the journal (crash-resume idempotence).
    //  Superseded blocks (resolved mid-run) and never-activated frozen
    //  reserves are skipped: neither has exposure to re-judge.
    if (cancelInForce()) return { outcome: 'cancel_in_force' };
    const registeredBlock = new Map(
      campaign.blocks.map((block) => [block.block_id, block]),
    );
    const backstopBlocks = [...membership.rosterByBlock.keys()].filter(
      (blockId) => {
        if (membership.supersededBlocks.has(blockId)) return false;
        const frozen = registeredBlock.get(blockId);
        if (
          frozen?.slot === 'reserve' &&
          !membership.mintedSuccessors.has(blockId)
        ) {
          return false;
        }
        return membership.intervals.has(blockId);
      },
    );
    const verdicts = evaluateContention({
      lines: sidecar.lines,
      truncatedTail: sidecar.truncatedTail,
      thresholds,
      sustainK: contention.sustain_k,
      cadenceMs: contention.cadence_ms,
      coverageN: contention.coverage_n,
      cpuCores: contention.host_fingerprint.cpu_cores,
      campaignOpenedTsMs: openedTsMs,
      lastTerminalTsMs: horizon,
      blocks: backstopBlocks.map((blockId) => ({
        block_id: blockId,
        ...(membership.intervals.get(blockId) as ServiceInterval),
      })),
    });
    for (const blockId of backstopBlocks) {
      const verdict = verdicts.get(blockId);
      if (verdict === undefined || verdict === 'clean') continue;
      const disposition =
        verdict === 'invalid' ? 'contention_invalidated' : 'unknown_coverage';
      if (adjudicated.has(blockId)) continue; // dedupe by block identity
      const interval = membership.intervals.get(blockId) as ServiceInterval;
      const detail =
        verdict === 'invalid'
          ? `seal-time contention backstop verdict invalid (breach window still open at campaign end overlaps the block interval [${interval.startTsMs}, ${interval.endTsMs ?? 'clipped to campaign end'}])`
          : `seal-time contention backstop verdict unknown (uncovered interval overlaps the block interval [${interval.startTsMs}, ${interval.endTsMs ?? 'clipped to campaign end'}])`;
      appendThroughSealer({
        type: 'adjudication',
        payload: {
          cell: cellOfBlock(blockId),
          disposition,
          rationale: `block=${blockId}; ${detail}`,
        },
      });
    }

    // 6. Fold → canonical bytes → digest. Fold input: every event before
    //  `sealed` — which includes the adjudications just appended (the
    //  backstop's blocks must leave the denominators) and excludes the
    //  digest-bearing event (no cycle).
    if (cancelInForce()) return { outcome: 'cancel_in_force' };
    const foldReader = openJournalRead(campaignDir);
    let foldEvents: JournalEvent[];
    try {
      foldEvents = foldReader.readEvents(0);
    } finally {
      foldReader.close();
    }
    report = foldDescriptiveReport({
      campaign,
      events: foldEvents,
      evidenceOf: (runId, sampleId) =>
        readSampleEvidence({
          runDir: join(resultsRoot, runId),
          sampleId,
        }),
    });
    jsonBytes = canonicalReportBytes(report);
    digest = digestReportBytes(jsonBytes);

    // 7. THE sealed append — one journal append is the seal's atomicity
    //  boundary; any storage error before it leaves nothing sealed.
    if (cancelInForce()) return { outcome: 'cancel_in_force' };
    appendThroughSealer({
      type: 'sealed',
      payload: { report_digest: digest },
    });
  } catch (err) {
    if (err instanceof SealerStorageFull) {
      quietRelease = true;
      stream.write(
        `storage failure at the terminus (nothing sealed) — remediate storage, then resume re-attempts: ${err.message}\n`,
      );
      return { outcome: 'storage_failed', reason: err.message };
    }
    throw err;
  } finally {
    releaseSealer(quietRelease);
  }

  // 8. Publish: cleanupOrphanTemps → md first → json last (the completion
  //  marker) — publishReport performs exactly that staged sequence. Post-
  //  sealed failures propagate loudly: the campaign IS sealed, and the
  //  resume path completes publication digest-verified.
  if (cancelInForce()) return { outcome: 'cancel_in_force' };
  const md = renderReportMd({ report, campaign });
  publishReport({ campaignDir, md, jsonBytes });
  stream.write(md); // the human rendering also goes to stdout

  // 9. Done.
  return { outcome: 'sealed', digest };
}
