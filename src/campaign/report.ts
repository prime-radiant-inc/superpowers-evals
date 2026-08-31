// The descriptive fold (kernel D4a, task 3 — spec
// docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md
// §The report engine): journal events (every event BEFORE `sealed`) plus
// per-sample run-dir evidence → the D-8-amended ReportSchema.
//
// Purity by construction: the evidence reader is an INJECTED callback — the
// seam the seal act wires to task 2's readSampleEvidence. report-evidence.ts
// is deliberately not imported here (not even as a type edge): the fold
// states its own structural demand and any reader satisfying it plugs in.
//
// Fail-closed everywhere: a sample whose evidence is missing or malformed
// keeps its journal class (instrument error via instrument_failure,
// everything else non-determinate joins the indeterminate class) and is
// counted in the accounting — never silently dropped, never fabricated. A
// quantity that is neither computable nor classifiable throws
// ReportFoldError (spec §Refusal table), and schema-invalid output is
// refused before it leaves the fold.
import type { Campaign } from '../contracts/campaign/campaign.ts';
import type { CampaignUniverse } from '../contracts/campaign/crash-windows.ts';
import {
  type JournalEvent,
  normalizeBlockReplaced,
} from '../contracts/campaign/journal-events.ts';
import { type Report, ReportSchema } from '../contracts/campaign/report.ts';
import type { SampleState } from '../contracts/campaign/state-machine.ts';
import { type ReplayState, replayEvents } from './journal.ts';

export class ReportFoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportFoldError';
  }
}

/** The fold's evidence demand — structurally task 2's `SampleEvidence`
 *  (src/campaign/report-evidence.ts), restated here so the fold owns its
 *  seam without importing the reader. */
interface FoldEvidence {
  readonly outcome: 'pass' | 'fail' | 'indeterminate' | null;
  readonly observedModels: readonly string[];
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly graderModel: string | null;
}

/** Evidence for a sample no run was ever allocated for: the reader's own
 *  absent-run-dir contract, stated fold-locally. */
const NO_EVIDENCE: FoldEvidence = {
  outcome: null,
  observedModels: [],
  totalTokens: null,
  costUsd: null,
  graderModel: null,
};

/** One included sample, joined to its cell and evidence. */
interface IncludedSample {
  readonly sampleId: string;
  readonly arm: string;
  readonly cellId: string;
  readonly blockId: string;
  readonly journalState: SampleState;
  readonly evidence: FoldEvidence;
  /** 'pass' | 'fail' exactly when journal-completed AND determinate
   *  evidence; otherwise null (the sample keeps its journal class). */
  readonly determinate: 'pass' | 'fail' | null;
}

/** Rule 1's output: the included samples plus the live (non-superseded,
 *  non-invalidated) block instances the median pass iterates. */
interface IncludedSet {
  readonly samples: readonly IncludedSample[];
  /** block_id → its included member sample ids, insertion-ordered by the
   *  replay's roster order (campaign blocks, then minted successors). */
  readonly liveBlocks: ReadonlyMap<string, readonly string[]>;
}

/** Rule 4's output. `excludes` marks failure classes that pull the cell out
 *  of delta/median aggregation; the empty-grader caveat renders loud but
 *  never wedges the terminus (spec §The report engine, item 4). */
interface FailedCell {
  readonly comparisonId: string;
  readonly scenario: string;
  readonly reasons: Set<string>;
  excludes: boolean;
}

/** The single-pass journal scan: accounting raw counts, the attempt→run
 *  bindings the evidence join needs, and the contention blocks whose
 *  adjudications drop them from the denominators (D-4). */
interface JournalScan {
  readonly instrumentFailures: number;
  readonly replacements: number;
  readonly reserveDraws: number;
  readonly skewExclusions: number;
  readonly skewCaveats: number;
  readonly budgetEvents: number;
  readonly amendments: number;
  readonly contentionInvalidated: number;
  readonly unknownCoverage: number;
  readonly contentionBlocks: ReadonlyMap<string, string>;
  /** The run a sample's evidence lives in: its last TERMINAL attempt's run,
   *  else its last allocated run (rerun instances re-run the same samples,
   *  so latest-wins is the live evidence). */
  readonly evidenceRunBySample: ReadonlyMap<string, string>;
}

export function foldDescriptiveReport(args: {
  readonly campaign: Campaign;
  /** Every journal event BEFORE `sealed` (the fold never sees the digest
   *  event — no cycle). */
  readonly events: readonly JournalEvent[];
  readonly evidenceOf: (runId: string, sampleId: string) => FoldEvidence;
}): Report {
  if (args.events.some((event) => event.type === 'sealed')) {
    throw new ReportFoldError(
      'fold input includes the sealed event — the fold runs over events BEFORE sealed only (no digest cycle); slice the journal at the sealed row',
    );
  }
  if (args.campaign.suite.profile === 'release_gate_v1') {
    throw new ReportFoldError(
      `campaign ${args.campaign.campaign_id} registers release_gate_v1 — sealing/reporting gating campaigns awaits D4b`,
    );
  }
  const state = replayEvents(universeForReport(args.campaign), args.events);
  const scan = scanJournal(args.events);

  const included = deriveIncludedSamples(args.campaign, state, scan); // rule 1
  const evidenceBySample = readEvidence(state, scan, args.evidenceOf);
  const samples = included.samples.map((sample) => ({
    ...sample,
    evidence: evidenceBySample.get(sample.sampleId) ?? NO_EVIDENCE,
  }));
  const withDeterminate = classifyDeterminate(samples);

  const failedCells = deriveProvenanceFindings(args.campaign, withDeterminate); // rule 4 (findings half)
  const rates = computeRates(args.campaign, withDeterminate, failedCells); // rule 2
  const medians = computeMedians(
    args.campaign,
    included.liveBlocks,
    withDeterminate,
    failedCells,
  ); // rule 3
  const provenance = renderProvenance(
    args.campaign,
    evidenceBySample,
    state,
    failedCells,
  ); // rule 4 (render half)
  const accounting = computeAccounting(
    scan,
    rates.denominators,
    withDeterminate,
  ); // rule 5

  const report = {
    schema_version: 1 as const,
    campaign_id: args.campaign.campaign_id,
    profile: args.campaign.suite.profile ?? 'descriptive_v1',
    stamp: 'DESCRIPTIVE' as const,
    cannot_answer: [] as Report['cannot_answer'],
    comparisons: rates.comparisons.map((comparison) => ({
      comparison_id: comparison.comparison_id,
      cells: comparison.cells,
      medians: medians.get(comparison.comparison_id) ?? {},
    })),
    accounting,
    provenance,
    errata: [] as Report['errata'],
  };
  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new ReportFoldError(
      `fold output failed ReportSchema validation — refusing to write: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** The frozen document's replay view (recovery.ts's universeOf, restated
 *  fold-locally: report.ts must not depend on the recovery module that
 *  tasks 5–6 wire back against this fold). */
function universeForReport(campaign: Campaign): CampaignUniverse {
  return {
    samples: campaign.samples.map((sample) => ({
      sample_id: sample.sample_id,
      arm: sample.arm,
      cell: sample.cell,
    })),
    blocks: campaign.blocks.map((block) => ({
      block_id: block.block_id,
      sample_ids: [...block.sample_ids],
      ...(block.slot !== undefined ? { slot: block.slot } : {}),
    })),
  };
}

function scanJournal(events: readonly JournalEvent[]): JournalScan {
  const sampleOfAttempt = new Map<string, string>();
  const runOfAttempt = new Map<string, string>();
  const lastRunBySample = new Map<string, string>();
  const terminalRunBySample = new Map<string, string>();
  const contentionBlocks = new Map<string, string>();
  let instrumentFailures = 0;
  let replacements = 0;
  let reserveDraws = 0;
  let skewExclusions = 0;
  let skewCaveats = 0;
  let budgetEvents = 0;
  let amendments = 0;
  let contentionInvalidated = 0;
  let unknownCoverage = 0;
  for (const event of events) {
    switch (event.type) {
      case 'attempt_created':
        sampleOfAttempt.set(event.payload.attempt_id, event.payload.sample_id);
        break;
      case 'run_allocated': {
        const sampleId = sampleOfAttempt.get(event.payload.attempt_id);
        if (sampleId !== undefined) {
          runOfAttempt.set(event.payload.attempt_id, event.payload.run_id);
          lastRunBySample.set(sampleId, event.payload.run_id);
        }
        break;
      }
      case 'run_completed':
      case 'instrument_failure': {
        const sampleId = sampleOfAttempt.get(event.payload.attempt_id);
        if (sampleId !== undefined) {
          const runId = runOfAttempt.get(event.payload.attempt_id);
          if (runId !== undefined) terminalRunBySample.set(sampleId, runId);
        }
        if (event.type === 'instrument_failure') instrumentFailures += 1;
        // The journaled exploratory skew expression (R-SNS-4): a determinate
        // completion whose exposure never established carries the caveat on
        // the terminal. Exploratory skew NEVER journals skew_excluded
        // (R-DSP-9 caveat-only), so this is the caveat counter's source.
        if (
          event.type === 'run_completed' &&
          event.payload.caveat !== undefined
        )
          skewCaveats += 1;
        break;
      }
      case 'block_replaced': {
        replacements += 1;
        if (normalizeBlockReplaced(event.payload).reserve_activation) {
          reserveDraws += 1;
        }
        break;
      }
      case 'skew_excluded':
        skewExclusions += 1;
        break;
      case 'budget_event':
        budgetEvents += 1;
        break;
      case 'amendment':
        amendments += 1;
        break;
      case 'adjudication': {
        // D-4's two ratified dispositions; every other adjudication
        // vocabulary (spend_recovered, integrity findings, …) is not the
        // contention backstop's and is not counted here.
        const disposition = event.payload.disposition;
        if (
          disposition !== 'contention_invalidated' &&
          disposition !== 'unknown_coverage'
        )
          break;
        if (disposition === 'contention_invalidated')
          contentionInvalidated += 1;
        else unknownCoverage += 1;
        // Block identity rides the rationale in the pinned encoding
        // `block=<block_id>; <detail>` (the attemptScopedRationale
        // convention, journal-events.ts) — a reader never has to guess.
        const blockId = /^block=([^;]+);/.exec(event.payload.rationale)?.[1];
        if (blockId === undefined) {
          throw new ReportFoldError(
            `adjudication (disposition ${disposition}) does not carry the pinned block identity encoding 'block=<block_id>; <detail>' in its rationale — cannot classify which block leaves the denominators: ${event.payload.rationale}`,
          );
        }
        contentionBlocks.set(blockId, disposition);
        break;
      }
      default:
        break;
    }
  }
  const evidenceRunBySample = new Map<string, string>();
  for (const [sampleId, runId] of lastRunBySample) {
    evidenceRunBySample.set(
      sampleId,
      terminalRunBySample.get(sampleId) ?? runId,
    );
  }
  return {
    instrumentFailures,
    replacements,
    reserveDraws,
    skewExclusions,
    skewCaveats,
    budgetEvents,
    amendments,
    contentionInvalidated,
    unknownCoverage,
    contentionBlocks,
    evidenceRunBySample,
  };
}

/** Rule 1 — the included set, from materialized replay state: one included
 *  outcome per primary slot. Superseded instances drop via their
 *  `superseded_by` refs (roster cross-check) and journaled dispositions;
 *  frozen reserves that never activated never ran; contention-adjudicated
 *  blocks leave the denominators (D-4). `sample_disposition { included }`
 *  is never journaled — inclusion is derived here, exactly once. */
function deriveIncludedSamples(
  campaign: Campaign,
  state: ReplayState,
  scan: JournalScan,
): IncludedSet {
  const armBySample = new Map(
    campaign.samples.map((sample) => [sample.sample_id, sample.arm]),
  );
  const cellBySample = new Map(
    campaign.samples.map((sample) => [sample.sample_id, sample.cell]),
  );
  const registeredBlock = new Map(
    campaign.blocks.map((block) => [block.block_id, block]),
  );
  // The superseded_by cross-check: every roster supersedes ref names a
  // predecessor whose outcome the successor replaces.
  const supersededSamples = new Set<string>();
  for (const roster of state.rosters.values()) {
    for (const entry of roster) {
      if (entry.supersedes !== undefined)
        supersededSamples.add(entry.supersedes);
    }
  }
  const samples: IncludedSample[] = [];
  const liveBlocks = new Map<string, readonly string[]>();
  const includedIds = new Set<string>();
  for (const [blockId, roster] of state.rosters) {
    if (state.supersededBlocks.has(blockId)) continue; // a replacement landed
    const frozen = registeredBlock.get(blockId);
    if (frozen?.slot === 'reserve' && !state.mintSeqBySuccessor.has(blockId)) {
      continue; // frozen reserve, never activated
    }
    if (scan.contentionBlocks.has(blockId)) continue; // D-4: out of the denominators
    const members: string[] = [];
    for (const entry of roster) {
      const sampleId = entry.sample_id;
      const journalState = state.sampleStates.get(sampleId) ?? 'planned';
      if (
        supersededSamples.has(sampleId) ||
        journalState === 'excluded_block_replaced' ||
        journalState === 'skew_excluded'
      ) {
        continue;
      }
      members.push(sampleId);
      if (includedIds.has(sampleId)) continue; // rerun instance: same sample once
      includedIds.add(sampleId);
      const arm = armBySample.get(sampleId) ?? entry.arm;
      const cellId = cellBySample.get(sampleId);
      if (arm === undefined || cellId === undefined) {
        throw new ReportFoldError(
          `sample ${sampleId} of block ${blockId} resolves to no arm/cell in the frozen campaign — its outcome is classifiable into no cell`,
        );
      }
      samples.push({
        sampleId,
        arm,
        cellId,
        blockId,
        journalState,
        evidence: NO_EVIDENCE, // joined by the caller
        determinate: null, // classified by the caller
      });
    }
    if (members.length > 0) liveBlocks.set(blockId, members);
  }
  // Conservation (the report proves it): every two-arm cell's same-arm
  // pairing is total, so per-arm included counts must agree — a mismatch is
  // neither computable (which n?) nor classifiable (no counter exists).
  for (const cell of campaign.cells) {
    if (cell.arms.length < 2) continue;
    const byArm = new Map<string, number>();
    for (const sample of samples) {
      if (sample.cellId !== `${cell.comparison_id}:${cell.scenario}`) continue;
      byArm.set(sample.arm, (byArm.get(sample.arm) ?? 0) + 1);
    }
    const counts = cell.arms.map((arm) => byArm.get(arm) ?? 0);
    if (new Set(counts).size > 1) {
      throw new ReportFoldError(
        `cell ${cell.comparison_id}:${cell.scenario} violates same-arm pairing conservation — included counts ${cell.arms
          .map((arm, i) => `${arm}=${counts[i]}`)
          .join(
            ', ',
          )} disagree; the report proves one included outcome per primary slot`,
      );
    }
  }
  return { samples, liveBlocks };
}

/** The evidence join: one callback per sample that ever allocated a run
 *  (included or not — invalidated-but-ran samples still ran and still prove
 *  the arm union, spec §The report engine item 4). */
function readEvidence(
  state: ReplayState,
  scan: JournalScan,
  evidenceOf: (runId: string, sampleId: string) => FoldEvidence,
): ReadonlyMap<string, FoldEvidence> {
  const out = new Map<string, FoldEvidence>();
  for (const roster of state.rosters.values()) {
    for (const entry of roster) {
      if (out.has(entry.sample_id)) continue;
      const runId = scan.evidenceRunBySample.get(entry.sample_id);
      if (runId === undefined) continue; // never allocated: no run dir exists
      out.set(entry.sample_id, evidenceOf(runId, entry.sample_id));
    }
  }
  return out;
}

/** Determinate ⇔ the journal says completed AND the verdict evidence says
 *  pass/fail. Everything else keeps its journal class: instrument failures
 *  are counted by their own event counter, and the remainder joins the
 *  indeterminate class in the accounting. */
function classifyDeterminate(
  samples: readonly IncludedSample[],
): IncludedSample[] {
  return samples.map((sample) => ({
    ...sample,
    determinate:
      sample.journalState === 'completed' &&
      (sample.evidence.outcome === 'pass' || sample.evidence.outcome === 'fail')
        ? sample.evidence.outcome
        : null,
  }));
}

/** Rule 4's findings: per-run arm-model validation over included samples,
 *  plus the campaign-global grader check over graded (determinate) samples. */
function deriveProvenanceFindings(
  campaign: Campaign,
  samples: readonly IncludedSample[],
): Map<string, FailedCell> {
  const failed = new Map<string, FailedCell>();
  const cellById = new Map(
    campaign.cells.map((cell) => [
      `${cell.comparison_id}:${cell.scenario}`,
      cell,
    ]),
  );
  const fail = (cellId: string, reason: string, excludes: boolean): void => {
    const cell = cellById.get(cellId);
    if (cell === undefined) {
      throw new ReportFoldError(
        `sample evidence resolves to cell ${cellId} that the frozen campaign does not register — the finding is classifiable into no cell`,
      );
    }
    const entry = failed.get(cellId) ?? {
      comparisonId: cell.comparison_id,
      scenario: cell.scenario,
      reasons: new Set<string>(),
      excludes: false,
    };
    entry.reasons.add(reason);
    entry.excludes = entry.excludes || excludes;
    failed.set(cellId, entry);
  };

  // Per-run arm-model validation (an included sample with no run has an
  // empty observed set and therefore fails — nothing is invented).
  const registeredModelByArm = new Map(
    campaign.execution_surface.map((arm) => [arm.name, arm.model]),
  );
  for (const sample of samples) {
    const registered = registeredModelByArm.get(sample.arm);
    if (registered === undefined) {
      throw new ReportFoldError(
        `arm ${sample.arm} has no registered execution-surface model — sample ${sample.sampleId}'s provenance is neither computable nor classifiable`,
      );
    }
    const observed = sample.evidence.observedModels;
    if (!observed.includes(registered)) {
      fail(
        sample.cellId,
        `arm model absent from observed set: arm ${sample.arm} registered ${registered}, observed [${[...observed].sort().join(', ')}]`,
        true,
      );
    }
  }

  // Grader: registered model vs the observed gauntlet identity across
  // graded samples (determinateness ⇔ a verdict exists ⇔ graded).
  const graded = samples.filter((sample) => sample.determinate !== null);
  const observedGraders = new Set<string>();
  for (const sample of graded) {
    const model = sample.evidence.graderModel;
    if (model !== null) observedGraders.add(model);
  }
  if (graded.length > 0) {
    if (observedGraders.size === 0) {
      // The pinned empty-evidence case: observed ABSENT + a loud caveat —
      // never a terminus wedge (the descriptive quantities still render).
      for (const cellId of new Set(graded.map((sample) => sample.cellId))) {
        fail(
          cellId,
          'grader evidence empty: no gauntlet identity observed for any graded sample (empty-evidence case)',
          false,
        );
      }
    } else if (
      [...observedGraders].some((model) => model !== campaign.grader.model)
    ) {
      // A grader identity is campaign-global: one mismatch fails every
      // graded cell.
      const observed = [...observedGraders].sort().join(', ');
      for (const cellId of new Set(graded.map((sample) => sample.cellId))) {
        fail(
          cellId,
          `grader mismatch: observed ${observed} vs registered ${campaign.grader.model}`,
          true,
        );
      }
    }
  }
  return failed;
}

/** Rule 2 — rates per cell. JUDGMENT PIN (spec §The report engine item 2 vs
 *  the single cell object the D-1/D-8 schema carries): the schema has no
 *  arm dimension on a cell, so the cell object renders the counts POOLED
 *  across its arms while `delta` (treatment − baseline) is computed from
 *  the per-arm rates; `n` is the per-arm included count (equal across arms
 *  by the conservation the fold proves) and the accounting's per-cell
 *  denominator is the cell's total included samples. PAR's "every number
 *  carries n, denominator, coverage" reads n ≠ denominator exactly this
 *  way. Task 4's renderer carries the same split. */
function computeRates(
  campaign: Campaign,
  samples: readonly IncludedSample[],
  failedCells: ReadonlyMap<string, FailedCell>,
): {
  readonly comparisons: ReadonlyArray<{
    readonly comparison_id: string;
    readonly cells: Report['comparisons'][number]['cells'];
  }>;
  readonly denominators: Record<string, number>;
} {
  const denominators: Record<string, number> = {};
  const out = campaign.comparisons.map((comparison) => {
    const cells = campaign.cells
      .filter((cell) => cell.comparison_id === comparison.comparison_id)
      .map((cell) => {
        const cellId = `${cell.comparison_id}:${cell.scenario}`;
        const ofCell = samples.filter((sample) => sample.cellId === cellId);
        const perArm = cell.arms.map((arm) => {
          const ofArm = ofCell.filter((sample) => sample.arm === arm);
          return {
            arm,
            total: ofArm.length,
            pass: ofArm.filter((s) => s.determinate === 'pass').length,
            fail: ofArm.filter((s) => s.determinate === 'fail').length,
          };
        });
        const total = perArm.reduce((sum, a) => sum + a.total, 0);
        const pass = perArm.reduce((sum, a) => sum + a.pass, 0);
        const fail = perArm.reduce((sum, a) => sum + a.fail, 0);
        const determinate = pass + fail;
        // Pinned convention: an empty denominator renders coverage 0 (the
        // counts render the emptiness; there is no 0/0 to invent).
        const coverage = total === 0 ? 0 : determinate / total;
        denominators[cellId] = total;
        const base = {
          scenario: cell.scenario,
          class: cell.class,
          n: perArm[0]?.total ?? 0,
          pass,
          fail,
          coverage,
        };
        const delta = rateDelta(comparison, perArm, failedCells.get(cellId));
        return delta === undefined ? base : { ...base, delta };
      });
    return { comparison_id: comparison.comparison_id, cells };
  });
  return { comparisons: out, denominators };
}

/** Signed delta (treatment − baseline) over per-arm determinate rates
 *  (rate = pass/determinate): two-arm cells only, never on an excluded
 *  cell, and only when both arms have determinate evidence to divide by —
 *  otherwise the counts + coverage render the reason it is absent. */
function rateDelta(
  comparison: Campaign['comparisons'][number],
  perArm: ReadonlyArray<{
    readonly arm: string;
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
  }>,
  failed: FailedCell | undefined,
): number | undefined {
  if (!('treatment' in comparison)) return undefined; // single-arm: no delta
  if (failed?.excludes === true) return undefined;
  const rateOf = (arm: string): number | undefined => {
    const entry = perArm.find((a) => a.arm === arm);
    if (entry === undefined || entry.pass + entry.fail === 0) return undefined;
    return entry.pass / (entry.pass + entry.fail);
  };
  const baseline = rateOf(comparison.baseline);
  const treatment = rateOf(comparison.treatment);
  if (baseline === undefined || treatment === undefined) return undefined;
  return treatment - baseline;
}

/** Rule 3 — token and dollar medians per comparison over matched determinate
 *  cells (PAR's wording; the pairing unit is the BLOCK: one replicate of
 *  the cell, both arms matched by co-admission). A block contributes when
 *  every included member is determinate and its cell is not
 *  provenance-excluded; a sample missing tokens or cost contributes to
 *  neither median (unpriced arms therefore contribute tokens only — the
 *  caveat renders in report.md, task 4). */
function computeMedians(
  campaign: Campaign,
  liveBlocks: ReadonlyMap<string, readonly string[]>,
  samples: readonly IncludedSample[],
  failedCells: ReadonlyMap<string, FailedCell>,
): ReadonlyMap<string, { readonly tokens?: number; readonly usd?: number }> {
  const bySample = new Map(samples.map((sample) => [sample.sampleId, sample]));
  // A block's comparison rides its members' cell (a block is one replicate
  // of one cell — registered blocks and minted instances alike).
  const comparisonOfCell = new Map(
    campaign.cells.map((cell) => [
      `${cell.comparison_id}:${cell.scenario}`,
      cell.comparison_id,
    ]),
  );
  const tokensByComparison = new Map<string, number[]>();
  const usdByComparison = new Map<string, number[]>();
  for (const [blockId, members] of liveBlocks) {
    const memberSamples = members.flatMap((id) => bySample.get(id) ?? []);
    if (
      memberSamples.length !== members.length || // an unknown member: no guess
      memberSamples.some((sample) => sample.determinate === null) ||
      memberSamples.some((sample) => failedCells.get(sample.cellId)?.excludes)
    ) {
      continue;
    }
    const firstMember = memberSamples[0];
    const comparisonId =
      firstMember === undefined
        ? undefined
        : comparisonOfCell.get(firstMember.cellId);
    if (comparisonId === undefined) {
      throw new ReportFoldError(
        `block ${blockId} resolves to no registered comparison — its median contribution is classifiable into no comparison`,
      );
    }
    for (const sample of memberSamples) {
      if (sample.evidence.totalTokens !== null) {
        push(tokensByComparison, comparisonId, sample.evidence.totalTokens);
      }
      if (sample.evidence.costUsd !== null) {
        push(usdByComparison, comparisonId, sample.evidence.costUsd);
      }
    }
  }
  const out = new Map<string, { tokens?: number; usd?: number }>();
  for (const comparison of campaign.comparisons) {
    const tokens = median(tokensByComparison.get(comparison.comparison_id));
    const usd = median(usdByComparison.get(comparison.comparison_id));
    const entry: { tokens?: number; usd?: number } = {};
    if (tokens !== undefined) entry.tokens = tokens;
    if (usd !== undefined) entry.usd = usd;
    out.set(comparison.comparison_id, entry);
  }
  return out;
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Median convention (pinned): sort ascending, take the middle value; an
 *  even count takes the mean of the two middles. An empty set has no
 *  median. */
function median(values: readonly number[] | undefined): number | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const at = (index: number): number => {
    const value = sorted[index];
    if (value === undefined) {
      throw new ReportFoldError(
        `median index ${index} out of range over ${sorted.length} sorted values — unreachable (the non-empty length check bounds it), refusing to fabricate a middle`,
      );
    }
    return value;
  };
  return sorted.length % 2 === 1
    ? at(middle)
    : (at(middle - 1) + at(middle)) / 2;
}

/** Rule 4's render half: the per-arm observed model UNION (a set, never a
 *  singular field — codex parents routinely invoke subagent models) drawn
 *  from every sample with a trajectory, included or not; the grader's
 *  observed identity (absent in the empty-evidence case); failed_cells
 *  sorted for byte-stability. */
function renderProvenance(
  campaign: Campaign,
  evidenceBySample: ReadonlyMap<string, FoldEvidence>,
  state: ReplayState,
  failedCells: ReadonlyMap<string, FailedCell>,
): Report['provenance'] {
  const armOfSample = new Map(
    campaign.samples.map((sample) => [sample.sample_id, sample.arm]),
  );
  const observedByArm = new Map<string, Set<string>>();
  for (const roster of state.rosters.values()) {
    for (const entry of roster) {
      const evidence = evidenceBySample.get(entry.sample_id);
      if (evidence === undefined) continue; // no run: no trajectory
      const arm = armOfSample.get(entry.sample_id) ?? entry.arm;
      const set = observedByArm.get(arm) ?? new Set<string>();
      for (const model of evidence.observedModels) set.add(model);
      observedByArm.set(arm, set);
    }
  }
  const arms = campaign.execution_surface.map((surface) => ({
    arm: surface.name,
    registered_model: surface.model,
    observed_model_set: [
      ...(observedByArm.get(surface.name) ?? new Set()),
    ].sort(),
  }));
  // The observed grader identity: the distinct non-null gauntlet models
  // across graded runs, rendered as one sorted display string (multiple
  // identities is itself the grader-mismatch finding, named in failed_cells).
  const observedGraders = new Set<string>();
  for (const evidence of evidenceBySample.values()) {
    if (evidence.graderModel !== null)
      observedGraders.add(evidence.graderModel);
  }
  const failedCellEntries = [...failedCells.values()].flatMap((cell) =>
    [...cell.reasons].map((reason) => ({
      comparison_id: cell.comparisonId,
      scenario: cell.scenario,
      reason,
    })),
  );
  const sortKey = (entry: {
    comparison_id: string;
    scenario: string;
    reason: string;
  }) => `${entry.comparison_id}\0${entry.scenario}\0${entry.reason}`;
  failedCellEntries.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return {
    arms,
    grader: {
      credential: campaign.grader.credential,
      model: campaign.grader.model,
      ...(observedGraders.size > 0
        ? { observed: [...observedGraders].sort().join(', ') }
        : {}),
    },
    failed_cells: failedCellEntries,
  };
}

/** Rule 5 — the accounting block, always rendered, never elidable. Bases
 *  named per counter: the event-counted classes (instrument errors,
 *  replacements, reserve draws, skew, budget, amendments, contention) count
 *  JOURNAL EVENTS — replaced-or-not, honest to the trail; the
 *  indeterminate class counts INCLUDED samples whose outcome is neither
 *  determinate nor instrument-classed (missing/malformed evidence lands
 *  here, fail-closed). */
function computeAccounting(
  scan: JournalScan,
  denominators: Record<string, number>,
  samples: readonly IncludedSample[],
): Report['accounting'] {
  return {
    instrument_errors: scan.instrumentFailures,
    indeterminates: samples.filter(
      (sample) =>
        sample.determinate === null &&
        sample.journalState !== 'instrument_failed',
    ).length,
    replacements: scan.replacements,
    reserve_draws: scan.reserveDraws,
    skew_exclusions: scan.skewExclusions,
    skew_caveats: scan.skewCaveats,
    budget_events: scan.budgetEvents,
    amendments: scan.amendments,
    contention_invalidated: scan.contentionInvalidated,
    unknown_coverage: scan.unknownCoverage,
    denominators,
  };
}
