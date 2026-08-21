import type {
  EstimateEntry,
  EstimateStats,
  EstimatesArtifact,
  ScenarioAgentStats,
  ScenarioStats,
} from '../contracts/estimates.ts';
import type { ReplayRecord } from '../contracts/replay.ts';

export interface EstimateInput {
  record: ReplayRecord;
  finished_at: string;
}

export type EstimateTier =
  | 'scenario_agent_credential_os'
  | 'scenario_agent'
  | 'scenario'
  | 'corpus';

export interface EstimateLookup {
  duration_s: number;
  cost_total_usd: number | null;
  tier: EstimateTier;
  confidence: 'high' | 'medium' | 'low' | null;
}

/** Joins multi-part group keys. NUL cannot appear in scenario/agent/
 *  credential/os identifiers, so the split round-trips each part exactly. */
const KEY_SEP = '\u0000';

type EntryFields = Pick<
  ReplayRecord,
  'scenario' | 'agent' | 'credential' | 'os'
>;
type ScenarioAgentFields = Pick<ReplayRecord, 'scenario' | 'agent'>;

const entryKey = (r: EntryFields): string =>
  [r.scenario, r.agent, r.credential, r.os].join(KEY_SEP);

const saKey = (r: ScenarioAgentFields): string =>
  [r.scenario, r.agent].join(KEY_SEP);

/** Code-unit comparison, deliberately not localeCompare: the artifact must
 *  serialize byte-identically on any host, and locale collation is
 *  ICU-dependent. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
function statsOf(records: ReplayRecord[]): EstimateStats {
  const durations = records.map((r) => r.wall_ms / 1000).sort((a, b) => a - b);
  const n = durations.length;
  const mid = Math.floor(n / 2);
  const lower = durations.slice(0, mid);
  const upper = durations.slice(n % 2 === 1 ? mid + 1 : mid);
  return {
    duration_s_median: median(durations),
    duration_n: n,
    cost_subject_usd_median: medianOrNull(
      records.map((r) => r.cost_subject_usd),
    ),
    cost_grader_usd_median: medianOrNull(records.map((r) => r.cost_grader_usd)),
    cost_total_usd_median: medianOrNull(records.map((r) => r.cost_total_usd)),
    priced_n: records.filter((r) => r.cost_total_usd !== null).length,
    spread_s:
      n < 4
        ? { p25: durations[0] as number, p75: durations[n - 1] as number }
        : { p25: median(lower), p75: median(upper) },
    confidence: confidence(n),
  };
}

function byKey<K>(
  records: ReplayRecord[],
  keyOf: (r: ReplayRecord) => K,
): Map<K, ReplayRecord[]> {
  const groups = new Map<K, ReplayRecord[]>();
  for (const r of records) {
    const k = keyOf(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

export function buildEstimates(
  inputs: EstimateInput[],
  opts: { sources: string[] },
): EstimatesArtifact {
  // Merge rule: union by run_id, first input wins; duplicates counted out.
  const seen = new Set<string>();
  const records: ReplayRecord[] = [];
  const finishedAts: string[] = [];
  for (const { record, finished_at } of inputs) {
    if (seen.has(record.run_id)) continue;
    seen.add(record.run_id);
    records.push(record);
    finishedAts.push(finished_at);
  }
  if (records.length === 0) throw new Error('buildEstimates: no inputs');

  const entries: EstimateEntry[] = [...byKey(records, entryKey).entries()]
    .map(([key, rs]): EstimateEntry => {
      const [scenario, agent, credential, os] = key.split(KEY_SEP);
      return {
        scenario: scenario as string,
        agent: agent as string,
        credential: credential as string,
        os: os as string,
        ...statsOf(rs),
      };
    })
    .sort((a, b) => cmp(entryKey(a), entryKey(b)));

  const scenarioAgent: ScenarioAgentStats[] = [
    ...byKey(records, saKey).entries(),
  ]
    .map(([key, rs]): ScenarioAgentStats => {
      const [scenario, agent] = key.split(KEY_SEP);
      return {
        scenario: scenario as string,
        agent: agent as string,
        ...statsOf(rs),
      };
    })
    .sort((a, b) => cmp(saKey(a), saKey(b)));

  const scenario: ScenarioStats[] = [
    ...byKey(records, (r) => r.scenario).entries(),
  ]
    .map(([sc, rs]): ScenarioStats => ({ scenario: sc, ...statsOf(rs) }))
    .sort((a, b) => cmp(a.scenario, b.scenario));

  const digest = Bun.SHA256.hash([...seen].sort().join('\n'), 'hex');
  const generatedAt = finishedAts.sort().at(-1);
  // records is non-empty here, so finishedAts is too.
  if (generatedAt === undefined) throw new Error('buildEstimates: no inputs');

  return {
    schema_version: 'quorum.estimates/v1',
    generated_at: generatedAt,
    corpus: { sources: opts.sources, run_count: records.length, digest },
    entries,
    fallbacks: {
      scenario_agent: scenarioAgent,
      scenario,
      corpus_median: {
        duration_s: statsOf(records).duration_s_median,
        cost_total_usd: medianOrNull(records.map((r) => r.cost_total_usd)),
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
      tier: 'scenario',
      confidence: sc.confidence,
    };
  }
  return {
    duration_s: artifact.fallbacks.corpus_median.duration_s,
    cost_total_usd: artifact.fallbacks.corpus_median.cost_total_usd,
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
