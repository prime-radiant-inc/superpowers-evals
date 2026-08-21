// test/cli-campaign.test.ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

function run(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const p = spawnSync('bun', [CLI, ...args], { encoding: 'utf8' });
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

const BASE = 'a'.repeat(40);
const TREAT = 'b'.repeat(40);

function writeRun(dir: string, rev: string, wallMs: number) {
  mkdirSync(join(dir, 'gauntlet-agent', 'results', 'g1'), { recursive: true });
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      scenario: 'sdd-escalates',
      coding_agent: 'claude',
      credential: 'opus_bedrock',
      os: 'linux',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: new Date(
        Date.parse('2026-08-08T00:00:00.000Z') + wallMs,
      ).toISOString(),
      provenance: { superpowers_rev: rev },
      economics: {
        coding_agent: { duration_ms: wallMs - 100_000, est_cost_usd: 1.0 },
        gauntlet: { duration_ms: wallMs - 40_000, est_cost_usd: 0.1 },
        total_est_cost_usd: 1.1,
      },
    }),
  );
  writeFileSync(
    join(dir, 'trajectory.json'),
    JSON.stringify({ steps: [{ timestamp: '2026-08-08T00:00:30.000Z' }] }),
  );
  writeFileSync(join(dir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(
    join(dir, 'gauntlet-agent', 'results', 'g1', 'result.json'),
    JSON.stringify({ duration_ms: wallMs - 40_000 }),
  );
}

function fixture(): { corpus: string; manifest: string } {
  const corpus = mkdtempSync(join(tmpdir(), 'cli-corpus-'));
  writeRun(join(corpus, 'run-base'), BASE, 600_000);
  writeRun(join(corpus, 'run-treat'), TREAT, 660_000);
  const manifest = join(corpus, 'manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      schema_version: 'quorum.replay-manifest/v1',
      name: 'fixture',
      source_docs: ['docs/experiments/2026-08-08-fresh-release-gate.md'],
      arms: { baseline_sha: BASE, treatment_sha: TREAT },
      comparisons: [
        {
          comparison_id: 'opus_bedrock',
          credential: 'opus_bedrock',
          pool_id: 'poolP',
          legacy_pool_id: 'poolLegacy',
          cells: [
            {
              scenario: 'sdd-escalates',
              class: 'confirmatory',
              samples: [
                {
                  run_id: 'run-base',
                  arm: 'baseline',
                  replicate: 1,
                  block_id: 'c/1',
                  historical_job: 'j1',
                  role: 'scored',
                },
                {
                  run_id: 'run-treat',
                  arm: 'treatment',
                  replicate: 1,
                  block_id: 'c/1',
                  historical_job: 'j1',
                  role: 'scored',
                },
              ],
            },
          ],
        },
      ],
      excluded_run_ids: [],
    }),
  );
  return { corpus, manifest };
}

test('campaign estimates then campaign simulate --config end-to-end', () => {
  const { corpus, manifest } = fixture();
  const estimatesPath = join(corpus, 'estimates.json');
  const est = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--out',
    estimatesPath,
  ]);
  expect(est.status).toBe(0);
  const artifact = JSON.parse(readFileSync(estimatesPath, 'utf8'));
  expect(artifact.schema_version).toBe('quorum.estimates/v1');
  expect(artifact.entries[0].duration_s_median).toBe(630);

  const out = mkdtempSync(join(tmpdir(), 'cli-sim-'));
  const sim = run([
    'campaign',
    'simulate',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--estimates',
    estimatesPath,
    '--config',
    '{"subject_caps":{"*":2},"grader_cap":2,"global_cap":4,"ordering":"estimates","grader_occupancy":"gauntlet"}',
    '--out',
    out,
  ]);
  expect(sim.status).toBe(0);
  const result = JSON.parse(sim.stdout);
  expect(result.makespan_ms).toBe(660_000);
  expect(result.per_pool.poolP.busy_slot_ms).toBe(1_260_000);
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign simulate --sweep default emits results.jsonl + table.md with 8h verdicts', () => {
  const { corpus, manifest } = fixture();
  const estimatesPath = join(corpus, 'estimates.json');
  expect(
    run([
      'campaign',
      'estimates',
      '--corpus',
      corpus,
      '--manifest',
      manifest,
      '--out',
      estimatesPath,
    ]).status,
  ).toBe(0);
  const out = mkdtempSync(join(tmpdir(), 'cli-sweep-'));
  const sim = run([
    'campaign',
    'simulate',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--estimates',
    estimatesPath,
    '--sweep',
    'default',
    '--out',
    out,
  ]);
  expect(sim.status).toBe(0);
  const lines = readFileSync(join(out, 'sweep-results.jsonl'), 'utf8')
    .trim()
    .split('\n');
  expect(lines).toHaveLength(72); // 36 configs × 2 pool identities
  const first = JSON.parse(lines[0]!);
  expect(first.config.pool_identity).toBeDefined();
  expect(typeof first.allowance_inclusive_makespan_ms).toBe('number');
  expect(readFileSync(join(out, 'sweep-table.md'), 'utf8')).toContain(
    '8h verdict',
  );
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});
