import type {
  EstimateEntry,
  EstimateStats,
  EstimatesArtifact,
  ScenarioAgentStats,
  ScenarioStats,
} from '../contracts/estimates.ts';
import type { ReplayRecord } from '../contracts/replay.ts';
import type { FinalStatus, RunErrorStage } from '../contracts/verdict.ts';

/** Error stages at which the coding agent never ran: the run died in
 *  fixture/provisioning (setup), the grader was misconfigured before the
 *  drive (qa-agent-misconfigured), or quorum itself crashed outside any
 *  named stage (unknown — observed as copyfile ENOTSUP during worktree
 *  materialization). Such runs last well under a second and would drag a
 *  cell's median toward zero. Every other indeterminate (capture, checks,
 *  compose, gauntlet, stopped) ran the subject and keeps its real wall. */
const NEVER_RAN_STAGES: ReadonlySet<RunErrorStage> = new Set<RunErrorStage>([
  'setup',
  'qa-agent-misconfigured',
  'unknown',
]);

export interface EstimateInput {
  record: ReplayRecord;
  finished_at: string;
  /** The run's composed outcome and, when indeterminate, its error stage
   *  (null when the verdict carries no RunError). Drives the never-ran
   *  exclusion. */
  outcome: { final: FinalStatus; error_stage: RunErrorStage | null };
  /** The run's coding-agent token volume (coding-agent-token-usage.json
   *  total_tokens) — the C3 pricing-override volume source. Null when the
   *  sidecar is absent or unreadable: pre-token corpora are legitimate
   *  history, never an error. */
  tokens_total?: number | null;
}

export type EstimateTier =
  | 'scenario_agent_credential_os'
  | 'scenario_agent'
  | 'scenario'
  | 'corpus';

export interface EstimateLookup {
  duration_s: number;
  cost_total_usd: number | null;
  /** Token-volume median at the resolved tier; null when that tier
   *  observed no volumes. A per-token pricing override needs this to
   *  price (fail-closed when absent). */
  tokens_total_median: number | null;
  tier: EstimateTier;
  confidence: 'high' | 'medium' | 'low' | null;
}

/** A record plus its observed token volume — the grouping input. */
type EstimateRow = ReplayRecord & { tokens_total: number | null };

type EntryFields = Pick<
  ReplayRecord,
  'scenario' | 'agent' | 'credential' | 'os'
>;
type ScenarioAgentFields = Pick<ReplayRecord, 'scenario' | 'agent'>;

type EntryTuple = [
  scenario: string,
  agent: string,
  credential: string,
  os: string,
];
type ScenarioAgentTuple = [scenario: string, agent: string];

const entryTuple = (r: EntryFields): EntryTuple => [
  r.scenario,
  r.agent,
  r.credential,
  r.os,
];

const saTuple = (r: ScenarioAgentFields): ScenarioAgentTuple => [
  r.scenario,
  r.agent,
];

/** Code-unit comparison, deliberately not localeCompare: the artifact must
 *  serialize byte-identically on any host, and locale collation is
 *  ICU-dependent. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Fieldwise code-unit comparison of key tuples: compare each field in
 *  turn rather than a concatenated string, which would conflate field
 *  boundaries. */
function cmpTuple(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) throw new Error('median of empty');
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    // n is odd, so mid is in range.
    return sorted[mid] as number;
  }
  // n is even, so mid - 1 and mid are in range.
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function medianOrNull(values: (number | null)[]): number | null {
  const present = values
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return present.length === 0 ? null : median(present);
}

function confidence(durationN: number): 'high' | 'medium' | 'low' {
  if (durationN >= 8) return 'high';
  if (durationN >= 3) return 'medium';
  return 'low';
}

/** statsOf is only ever called on non-empty record groups, so the indexed
 *  reads below are in range. */
function statsOf(rows: EstimateRow[]): EstimateStats {
  const durations = rows.map((r) => r.wall_ms / 1000).sort((a, b) => a - b);
  const n = durations.length;
  const mid = Math.floor(n / 2);
  const lower = durations.slice(0, mid);
  const upper = durations.slice(n % 2 === 1 ? mid + 1 : mid);
  const tokensMedian = medianOrNull(rows.map((r) => r.tokens_total));
  return {
    duration_s_median: median(durations),
    duration_n: n,
    cost_subject_usd_median: medianOrNull(rows.map((r) => r.cost_subject_usd)),
    cost_grader_usd_median: medianOrNull(rows.map((r) => r.cost_grader_usd)),
    cost_total_usd_median: medianOrNull(rows.map((r) => r.cost_total_usd)),
    priced_n: rows.filter((r) => r.cost_total_usd !== null).length,
    // Omitted when unobserved — absent, never 0, so an override can never
    // price at $0 off a missing volume.
    ...(tokensMedian !== null ? { tokens_total_median: tokensMedian } : {}),
    spread_s:
      n < 4
        ? { p25: durations[0] as number, p75: durations[n - 1] as number }
        : { p25: median(lower), p75: median(upper) },
    confidence: confidence(n),
  };
}

/** A structural group: the original key tuple plus its records, so no
 *  field is ever recovered by splitting a packed string. */
interface Group<K extends string[]> {
  tuple: K;
  records: EstimateRow[];
}

/** Groups records by an arbitrary string tuple. The Map id is the tuple's
 *  JSON encoding — injective for string tuples, so distinct tuples (even
 *  ones containing NUL or boundary-blurring characters) can never collapse
 *  into one group. */
function byKey<K extends string[]>(
  rows: EstimateRow[],
  keyOf: (r: EstimateRow) => K,
): Map<string, Group<K>> {
  const groups = new Map<string, Group<K>>();
  for (const r of rows) {
    const tuple = keyOf(r);
    const id = JSON.stringify(tuple);
    const g = groups.get(id);
    if (g) g.records.push(r);
    else groups.set(id, { tuple, records: [r] });
  }
  return groups;
}

export function buildEstimates(
  inputs: EstimateInput[],
  opts: { sources: string[] },
): EstimatesArtifact {
  // Merge rule: union by run_id, first input wins; duplicates counted out.
  const seen = new Set<string>();
  const rows: EstimateRow[] = [];
  const excluded: EstimatesArtifact['corpus']['excluded'] = [];
  const finishedAts: string[] = [];
  let duplicatesExcluded = 0;
  for (const { record, finished_at, tokens_total, outcome } of inputs) {
    if (seen.has(record.run_id)) {
      duplicatesExcluded++;
      continue;
    }
    seen.add(record.run_id);
    // generated_at (R-REG-21 staleness) sees every unique run, excluded
    // or not: an excluded run is still evidence the corpus was refreshed.
    finishedAts.push(finished_at);
    if (
      outcome.final === 'indeterminate' &&
      outcome.error_stage !== null &&
      NEVER_RAN_STAGES.has(outcome.error_stage)
    ) {
      excluded.push({
        run_id: record.run_id,
        scenario: record.scenario,
        agent: record.agent,
        credential: record.credential,
        os: record.os,
        stage: outcome.error_stage,
      });
      continue;
    }
    rows.push({ ...record, tokens_total: tokens_total ?? null });
  }
  if (rows.length === 0) throw new Error('buildEstimates: no inputs');
  excluded.sort((a, b) => cmp(a.run_id, b.run_id));

  const entries: EstimateEntry[] = [...byKey(rows, entryTuple).values()]
    .map(({ tuple, records: rs }): EstimateEntry => {
      const [scenario, agent, credential, os] = tuple;
      return { scenario, agent, credential, os, ...statsOf(rs) };
    })
    .sort((a, b) => cmpTuple(entryTuple(a), entryTuple(b)));

  const scenarioAgent: ScenarioAgentStats[] = [...byKey(rows, saTuple).values()]
    .map(({ tuple, records: rs }): ScenarioAgentStats => {
      const [scenario, agent] = tuple;
      return { scenario, agent, ...statsOf(rs) };
    })
    .sort((a, b) => cmpTuple(saTuple(a), saTuple(b)));

  const scenario: ScenarioStats[] = [
    ...byKey(rows, (r): [string] => [r.scenario]).values(),
  ]
    .map(
      ({ tuple, records: rs }): ScenarioStats => ({
        scenario: tuple[0],
        ...statsOf(rs),
      }),
    )
    .sort((a, b) => cmp(a.scenario, b.scenario));

  const digest = Bun.SHA256.hash([...seen].sort().join('\n'), 'hex');
  const generatedAt = finishedAts.sort().at(-1);
  // rows is non-empty here, so finishedAts is too.
  if (generatedAt === undefined) throw new Error('buildEstimates: no inputs');

  const corpusStats = statsOf(rows);
  return {
    schema_version: 'quorum.estimates/v1',
    generated_at: generatedAt,
    corpus: {
      sources: opts.sources,
      run_count: rows.length,
      duplicates_excluded: duplicatesExcluded,
      excluded,
      digest,
    },
    entries,
    fallbacks: {
      scenario_agent: scenarioAgent,
      scenario,
      corpus_median: {
        duration_s: corpusStats.duration_s_median,
        cost_total_usd: medianOrNull(rows.map((r) => r.cost_total_usd)),
        ...(corpusStats.tokens_total_median !== undefined
          ? { tokens_total_median: corpusStats.tokens_total_median }
          : {}),
      },
    },
  };
}
export function lookupEstimate(
  artifact: EstimatesArtifact,
  key: { scenario: string; agent: string; credential: string; os: string },
): EstimateLookup {
  const direct = artifact.entries.find(
    (e) =>
      e.scenario === key.scenario &&
      e.agent === key.agent &&
      e.credential === key.credential &&
      e.os === key.os,
  );
  if (direct) {
    return {
      duration_s: direct.duration_s_median,
      cost_total_usd: direct.cost_total_usd_median,
      tokens_total_median: direct.tokens_total_median ?? null,
      tier: 'scenario_agent_credential_os',
      confidence: direct.confidence,
    };
  }
  const sa = artifact.fallbacks.scenario_agent.find(
    (e) => e.scenario === key.scenario && e.agent === key.agent,
  );
  if (sa) {
    return {
      duration_s: sa.duration_s_median,
      cost_total_usd: sa.cost_total_usd_median,
      tokens_total_median: sa.tokens_total_median ?? null,
      tier: 'scenario_agent',
      confidence: sa.confidence,
    };
  }
  const sc = artifact.fallbacks.scenario.find(
    (e) => e.scenario === key.scenario,
  );
  if (sc) {
    return {
      duration_s: sc.duration_s_median,
      cost_total_usd: sc.cost_total_usd_median,
      tokens_total_median: sc.tokens_total_median ?? null,
      tier: 'scenario',
      confidence: sc.confidence,
    };
  }
  return {
    duration_s: artifact.fallbacks.corpus_median.duration_s,
    cost_total_usd: artifact.fallbacks.corpus_median.cost_total_usd,
    tokens_total_median:
      artifact.fallbacks.corpus_median.tokens_total_median ?? null,
    tier: 'corpus',
    confidence: null,
  };
}

/** Pinned serialization: 2-space JSON, LF, trailing newline. The artifact's
 *  field order is fixed by construction in buildEstimates; regeneration
 *  from identical inputs is byte-identical (tested). */
export function serializeEstimates(artifact: EstimatesArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
