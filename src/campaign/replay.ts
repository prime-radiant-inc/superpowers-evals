import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ReplayManifest,
  ReplayManifestSchema,
  type ReplayRecord,
} from '../contracts/replay.ts';

export class ReplayLoadError extends Error {}

export interface SimBlockInput {
  block_id: string;
  comparison_id: string;
  cell: string;
  replicate: number;
  order_key: string;
  historical_job: string;
  samples: Array<{ run_id: string; subject_pool: string }>;
}

export interface LoadedCorpus {
  records: Map<string, ReplayRecord>;
  blocks: SimBlockInput[];
  coverage: {
    listed_runs: number;
    excluded_runs_present: number;
    missing_listed_runs: string[];
    surplus_corpus_dirs: string[];
    null_coding_ms: number;
    null_gauntlet_ms: number;
    null_pre_exposure_ms: number;
    gauntlet_lt_coding_anomalies: string[];
  };
}

export function loadManifest(path: string): ReplayManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ReplayLoadError(`manifest unreadable: ${path}: ${String(err)}`);
  }
  const parsed = ReplayManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplayLoadError(
      `manifest invalid: ${path}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Guard-cast: manifest bookkeeping is keyed by run_id, so a miss here is an
 *  internal invariant violation — still loud, never silently dropped. */
function expectEntry<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) {
    throw new ReplayLoadError(`internal: no ${what} entry for this run`);
  }
  return v;
}

/** Identity fields are validated loudly (a missing/empty one is a
 *  ReplayLoadError naming the run_id); only the economics block stays
 *  tolerant (the src/cli/costs.ts pattern — opaque in FinalVerdictSchema,
 *  picked defensively, nulls are legitimate data). */
export function recordFromRunDir(runDir: string, runId: string): ReplayRecord {
  const verdict = readJson(join(runDir, 'verdict.json'));
  if (!verdict)
    throw new ReplayLoadError(`${runId}: verdict.json missing/unparseable`);
  const scenario = str(verdict['scenario']);
  const agent = str(verdict['coding_agent']);
  const credential = str(verdict['credential']);
  const os = str(verdict['os']);
  for (const [field, value] of [
    ['scenario', scenario],
    ['coding_agent', agent],
    ['credential', credential],
    ['os', os],
  ] as Array<[string, string | null]>) {
    if (value === null) {
      throw new ReplayLoadError(
        `${runId}: verdict.json identity field ${field} missing/empty`,
      );
    }
  }
  const startedAt = Date.parse(str(verdict['started_at']) ?? '');
  const finishedAt = Date.parse(str(verdict['finished_at']) ?? '');
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt
  ) {
    throw new ReplayLoadError(`${runId}: invalid started_at/finished_at`);
  }
  const economics = (verdict['economics'] ?? {}) as Record<string, unknown>;
  const coding = (economics['coding_agent'] ?? {}) as Record<string, unknown>;
  const gauntlet = (economics['gauntlet'] ?? {}) as Record<string, unknown>;

  // gauntlet_ms precedence: the grader-side result.json is the source of
  // truth; economics.gauntlet is only a cached copy, consulted as fallback.
  let gauntletMs: number | null = null;
  const gResultsDir = join(runDir, 'gauntlet-agent', 'results');
  if (existsSync(gResultsDir)) {
    for (const id of readdirSync(gResultsDir)) {
      const result = readJson(join(gResultsDir, id, 'result.json'));
      const d = result ? num(result['duration_ms']) : null;
      if (d !== null) {
        gauntletMs = d;
        break;
      }
    }
  }
  if (gauntletMs === null) {
    gauntletMs = num(gauntlet['duration_ms']);
  }

  let preExposureMs: number | null = null;
  const trajectory = readJson(join(runDir, 'trajectory.json'));
  const steps = trajectory?.['steps'];
  if (Array.isArray(steps)) {
    const stamps = steps
      .map((s) =>
        Date.parse(str((s as Record<string, unknown>)['timestamp']) ?? ''),
      )
      .filter((t) => Number.isFinite(t));
    if (stamps.length > 0) {
      const first = Math.min(...stamps);
      if (first < startedAt) {
        throw new ReplayLoadError(
          `${runId}: first trajectory step predates started_at`,
        );
      }
      preExposureMs = first - startedAt;
    }
  }

  return {
    run_id: runId,
    scenario: scenario ?? '?',
    agent: agent ?? '?',
    credential: credential ?? '?',
    os: os ?? 'linux',
    pool_id: '', // assigned by loadCorpus from the manifest
    arm: 'single', // assigned by loadCorpus
    wall_ms: finishedAt - startedAt,
    coding_ms: num(coding['duration_ms']),
    gauntlet_ms: gauntletMs,
    pre_exposure_ms: preExposureMs,
    cost_subject_usd: num(coding['est_cost_usd']),
    cost_grader_usd: num(gauntlet['est_cost_usd']),
    cost_total_usd: num(economics['total_est_cost_usd']),
  };
}

export function loadCorpus(
  corpusDir: string,
  manifest: ReplayManifest,
): LoadedCorpus {
  const listed = new Map<
    string,
    { arm: 'baseline' | 'treatment'; poolId: string }
  >();
  const sampleMeta = new Map<
    string,
    {
      comparisonId: string;
      cell: string;
      replicate: number;
      blockId: string;
      historicalJob: string;
      role: 'scored' | 'retry-load';
    }
  >();
  for (const comparison of manifest.comparisons) {
    for (const cell of comparison.cells) {
      for (const sample of cell.samples) {
        listed.set(sample.run_id, {
          arm: sample.arm,
          poolId: comparison.pool_id,
        });
        sampleMeta.set(sample.run_id, {
          comparisonId: comparison.comparison_id,
          cell: cell.scenario,
          replicate: sample.replicate,
          blockId: sample.block_id,
          historicalJob: sample.historical_job,
          role: sample.role,
        });
      }
    }
  }
  const excluded = new Set(manifest.excluded_run_ids.map((x) => x.run_id));

  const onDisk = existsSync(corpusDir)
    ? readdirSync(corpusDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'batches')
        .map((e) => e.name)
    : [];
  const surplus = onDisk
    .filter((d) => !listed.has(d) && !excluded.has(d))
    .sort();
  if (surplus.length > 0) {
    throw new ReplayLoadError(
      `surplus corpus run dirs not in manifest: ${surplus.join(', ')}`,
    );
  }
  const missing = [...listed.keys()]
    .filter((id) => !onDisk.includes(id))
    .sort();
  if (missing.length > 0) {
    throw new ReplayLoadError(
      `manifest runs missing from corpus: ${missing.join(', ')}`,
    );
  }

  const coverage = {
    listed_runs: listed.size,
    excluded_runs_present: onDisk.filter((d) => excluded.has(d)).length,
    missing_listed_runs: [] as string[],
    surplus_corpus_dirs: [] as string[],
    null_coding_ms: 0,
    null_gauntlet_ms: 0,
    null_pre_exposure_ms: 0,
    gauntlet_lt_coding_anomalies: [] as string[],
  };

  const records = new Map<string, ReplayRecord>();
  for (const [runId, meta] of listed) {
    const runDir = join(corpusDir, runId);
    if (!statSync(runDir).isDirectory()) continue;
    const rec = recordFromRunDir(runDir, runId);
    // Arm verification against the frozen SHAs.
    const verdict = expectEntry(
      readJson(join(runDir, 'verdict.json')),
      'verdict.json',
    );
    const provenance = (verdict['provenance'] ?? {}) as Record<string, unknown>;
    const rev = str(provenance['superpowers_rev']);
    const expected =
      meta.arm === 'baseline'
        ? manifest.arms.baseline_sha
        : manifest.arms.treatment_sha;
    if (rev !== expected) {
      throw new ReplayLoadError(
        `${runId}: superpowers_rev ${rev ?? 'null'} does not match ${meta.arm} SHA ${expected}`,
      );
    }
    if (provenance['superpowers_dirty'] === true) {
      throw new ReplayLoadError(
        `${runId}: superpowers_dirty is true — corpus contamination`,
      );
    }
    records.set(runId, { ...rec, pool_id: meta.poolId, arm: meta.arm });
    if (rec.coding_ms === null) coverage.null_coding_ms++;
    if (rec.gauntlet_ms === null) coverage.null_gauntlet_ms++;
    if (rec.pre_exposure_ms === null) coverage.null_pre_exposure_ms++;
    if (
      rec.gauntlet_ms !== null &&
      rec.coding_ms !== null &&
      rec.gauntlet_ms < rec.coding_ms
    ) {
      coverage.gauntlet_lt_coding_anomalies.push(runId);
    }
  }

  // Blocks: scored pairs grouped by block_id; retry-load → single-sample.
  const scoredGroups = new Map<string, string[]>();
  const blocks: SimBlockInput[] = [];
  for (const [runId, meta] of sampleMeta) {
    if (!records.has(runId)) continue;
    if (meta.role === 'retry-load') {
      blocks.push({
        block_id: `${meta.blockId}/retry-${runId}`,
        comparison_id: meta.comparisonId,
        cell: meta.cell,
        replicate: meta.replicate,
        order_key: `${meta.comparisonId}|${meta.cell}|${String(meta.replicate).padStart(4, '0')}|${meta.blockId}/retry-${runId}`,
        historical_job: meta.historicalJob,
        samples: [
          {
            run_id: runId,
            subject_pool: expectEntry(listed.get(runId), 'manifest').poolId,
          },
        ],
      });
      continue;
    }
    const group = scoredGroups.get(meta.blockId) ?? [];
    group.push(runId);
    scoredGroups.set(meta.blockId, group);
  }
  for (const [blockId, runIds] of scoredGroups) {
    if (runIds.length !== 2) {
      throw new ReplayLoadError(
        `scored block ${blockId} has ${runIds.length} samples (expected 2): [${runIds.join(', ')}]`,
      );
    }
    const arms = new Set(
      runIds.map((id) => expectEntry(listed.get(id), 'manifest').arm),
    );
    if (arms.size !== 2) {
      throw new ReplayLoadError(
        `scored block ${blockId} does not hold one baseline + one treatment: [${runIds.join(', ')}]`,
      );
    }
    const firstId = runIds[0];
    const meta = expectEntry(
      firstId !== undefined ? sampleMeta.get(firstId) : undefined,
      'sample metadata',
    );
    blocks.push({
      block_id: blockId,
      comparison_id: meta.comparisonId,
      cell: meta.cell,
      replicate: meta.replicate,
      order_key: `${meta.comparisonId}|${meta.cell}|${String(meta.replicate).padStart(4, '0')}|${blockId}`,
      historical_job: meta.historicalJob,
      samples: runIds.sort().map((id) => ({
        run_id: id,
        subject_pool: expectEntry(listed.get(id), 'manifest').poolId,
      })),
    });
  }
  blocks.sort((a, b) => a.order_key.localeCompare(b.order_key));

  return { records, blocks, coverage };
}
