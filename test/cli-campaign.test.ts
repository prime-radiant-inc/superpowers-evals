// test/cli-campaign.test.ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
  // Skew is carried on every row: both fixture arms carry pre_exposure
  // 30,000ms → exactly one measured pair, delta 0.
  expect(first.skew.measured_pairs).toBe(1);
  expect(first.skew.dropped_pairs).toBe(0);
  expect(first.skew.p50_ms).toBe(0);
  expect(first.skew.p90_ms).toBe(0);
  expect(first.skew.max_ms).toBe(0);
  const table = readFileSync(join(out, 'sweep-table.md'), 'utf8');
  expect(table).toContain('8h verdict');
  // +stress+allowance column: stress duplicates the fixture's single block
  // (ceil(20%·1)=1), both copies co-fit under every cap, so stress makespan
  // = 660,000ms; + 15min allowance = 1,560,000ms = 0.43h.
  expect(table).toContain('+stress+allowance');
  expect(table).toContain('| 0.43h |');
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign acquire pulls a runs-file-selected corpus and writes selection-manifest.json', () => {
  const results = mkdtempSync(join(tmpdir(), 'cli-acq-results-'));
  writeRun(join(results, 'run-a'), BASE, 600_000);
  const work = mkdtempSync(join(tmpdir(), 'cli-acq-work-'));
  const runsFile = join(work, 'runs.txt');
  // Comment + blank lines are filtered; only run-a is selected.
  writeFileSync(runsFile, '# one run\nrun-a\n\n');
  const out = mkdtempSync(join(tmpdir(), 'cli-acq-out-'));
  const acq = run([
    'campaign',
    'acquire',
    '--runs-file',
    runsFile,
    '--results-root',
    results,
    '--out',
    out,
  ]);
  expect(acq.status).toBe(0);
  expect(acq.stdout).toContain('acquired 1 runs');
  expect(existsSync(join(out, 'selection-manifest.json'))).toBe(true);
  const sel = JSON.parse(
    readFileSync(join(out, 'selection-manifest.json'), 'utf8'),
  );
  expect(sel.runs).toHaveLength(1);
  expect(sel.runs[0].run_id).toBe('run-a');
  expect(sel.missing_run_ids).toEqual([]);
  expect(existsSync(join(out, 'run-a', 'verdict.json'))).toBe(true);
  rmSync(results, { recursive: true });
  rmSync(work, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign estimates --scan-results alone prints an inclusion manifest (no corpus needed)', () => {
  const results = mkdtempSync(join(tmpdir(), 'cli-scan-'));
  writeRun(join(results, 'run-good'), BASE, 600_000);
  // Invalid wall (finished before started) → excluded from inclusion.
  mkdirSync(join(results, 'run-bad'), { recursive: true });
  writeFileSync(
    join(results, 'run-bad', 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      scenario: 's',
      coding_agent: 'claude',
      credential: 'opus_bedrock',
      os: 'linux',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: '2026-08-07T00:00:00.000Z',
      provenance: {},
      economics: {},
    }),
  );
  const out = run(['campaign', 'estimates', '--scan-results', results]);
  expect(out.status).toBe(0);
  const printed = JSON.parse(out.stdout);
  expect(printed.run_ids).toEqual(['run-good']);
  expect(Object.keys(printed.hashes)).toEqual(['run-good']);
  expect(printed.hashes['run-good']).toBe(
    Bun.SHA256.hash(
      readFileSync(join(results, 'run-good', 'verdict.json')),
      'hex',
    ),
  );
  rmSync(results, { recursive: true });
});

test('campaign estimates --inclusion verifies committed hashes (mismatch is a loud error)', () => {
  const { corpus, manifest } = fixture();
  const results = mkdtempSync(join(tmpdir(), 'cli-incl-'));
  writeRun(join(results, 'run-extra'), BASE, 600_000);
  const goodHash = Bun.SHA256.hash(
    readFileSync(join(results, 'run-extra', 'verdict.json')),
    'hex',
  );
  const estimatesPath = join(corpus, 'estimates.json');

  // Mismatched committed hash → non-zero exit naming the run.
  const inclBad = join(corpus, 'inclusion-bad.json');
  writeFileSync(
    inclBad,
    JSON.stringify({
      run_ids: ['run-extra'],
      hashes: { 'run-extra': '0'.repeat(64) },
    }),
  );
  const bad = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--scan-results',
    results,
    '--inclusion',
    inclBad,
    '--out',
    estimatesPath,
  ]);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('run-extra');

  // Run listed without a committed hash entry → loud error naming the run.
  const inclNoHash = join(corpus, 'inclusion-nohash.json');
  writeFileSync(
    inclNoHash,
    JSON.stringify({ run_ids: ['run-extra'], hashes: {} }),
  );
  const noHash = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--scan-results',
    results,
    '--inclusion',
    inclNoHash,
    '--out',
    estimatesPath,
  ]);
  expect(noHash.status).not.toBe(0);
  expect(noHash.stderr).toContain('run-extra');

  // Missing run dir → loud error naming the run (no silent skip).
  const inclAbsent = join(corpus, 'inclusion-absent.json');
  writeFileSync(
    inclAbsent,
    JSON.stringify({
      run_ids: ['run-absent'],
      hashes: { 'run-absent': goodHash },
    }),
  );
  const absent = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--scan-results',
    results,
    '--inclusion',
    inclAbsent,
    '--out',
    estimatesPath,
  ]);
  expect(absent.status).not.toBe(0);
  expect(absent.stderr).toContain('run-absent');

  // Matching hash + credential_pools → merged artifact (corpus 2 + inclusion 1).
  const inclGood = join(corpus, 'inclusion-good.json');
  writeFileSync(
    inclGood,
    JSON.stringify({
      run_ids: ['run-extra'],
      hashes: { 'run-extra': goodHash },
      credential_pools: { opus_bedrock: 'bedrock|anthropic|claude-opus-4-8' },
    }),
  );
  const good = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--scan-results',
    results,
    '--inclusion',
    inclGood,
    '--out',
    estimatesPath,
  ]);
  expect(good.status).toBe(0);
  expect(good.stdout).not.toContain('skipped');
  const artifact = JSON.parse(readFileSync(estimatesPath, 'utf8'));
  expect(artifact.corpus.run_count).toBe(3);
  // Median of [600, 600, 660] seconds.
  expect(artifact.entries[0].duration_s_median).toBe(600);
  rmSync(results, { recursive: true });
  rmSync(corpus, { recursive: true });
});

test('campaign simulate --sweep oracle labels every row (target identity, 36 configs)', () => {
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
  const out = mkdtempSync(join(tmpdir(), 'cli-sweep-oracle-'));
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
    'oracle',
    '--out',
    out,
  ]);
  expect(sim.status).toBe(0);
  const lines = readFileSync(join(out, 'sweep-results.jsonl'), 'utf8')
    .trim()
    .split('\n');
  expect(lines).toHaveLength(36);
  for (const line of lines) {
    const row = JSON.parse(line);
    expect(row.label).toBe('oracle');
    expect(row.config.pool_identity).toBe('target');
    expect(row.config.ordering).toBe('oracle');
  }
  const table = readFileSync(join(out, 'sweep-table.md'), 'utf8');
  expect(table).toContain('| label |');
  expect(table).toContain('oracle');
  expect(table).toContain('8h verdict');
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign simulate --sweep grader-active never renders an 8h-verdict PASS (all rows ≤8h)', () => {
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
  const out = mkdtempSync(join(tmpdir(), 'cli-sweep-grader-active-'));
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
    'grader-active',
    '--out',
    out,
  ]);
  expect(sim.status).toBe(0);
  const lines = readFileSync(join(out, 'sweep-results.jsonl'), 'utf8')
    .trim()
    .split('\n');
  expect(lines).toHaveLength(36);
  for (const line of lines) {
    const row = JSON.parse(line);
    expect(row.label).toBe('grader-active');
    expect(row.config.pool_identity).toBe('target');
    expect(row.config.grader_occupancy).toBe('gauntlet-active');
    // Every row is well under 8h allowance-inclusive — a PASS here would be
    // exactly the I1 bug (sensitivity rows are never 8h-verdict-eligible).
    expect(row.allowance_inclusive_makespan_ms).toBeLessThan(8 * 3_600_000);
  }
  const table = readFileSync(join(out, 'sweep-table.md'), 'utf8');
  expect(table).not.toContain('PASS');
  // The 8h-verdict cell of every data row is the em dash, not PASS.
  const tableLines = table.split('\n').filter((l) => l.startsWith('|'));
  const headerCells = tableLines[0]!.split('|').map((c) => c.trim());
  const verdictCol = headerCells.indexOf('8h verdict');
  expect(verdictCol).toBeGreaterThan(0);
  for (const rowLine of tableLines.slice(2)) {
    const cells = rowLine.split('|').map((c) => c.trim());
    expect(cells[1]).toBe('grader-active');
    expect(cells[verdictCol]).toBe('—');
  }
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign simulate rejects --sweep together with --config', () => {
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
  const out = mkdtempSync(join(tmpdir(), 'cli-sweep-conflict-'));
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
    '--config',
    '{"subject_caps":{"*":2},"grader_cap":2,"global_cap":4,"ordering":"estimates","grader_occupancy":"gauntlet"}',
    '--out',
    out,
  ]);
  expect(sim.status).not.toBe(0);
  expect(sim.stderr).toContain('mutually exclusive');
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign simulate rejects --pool-identity outside --config (e.g. with --sweep)', () => {
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
  const out = mkdtempSync(join(tmpdir(), 'cli-sweep-poolid-'));
  // --pool-identity would be silently ignored by the sweep path — loud error.
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
    '--pool-identity',
    'legacy',
    '--out',
    out,
  ]);
  expect(sim.status).not.toBe(0);
  expect(sim.stderr).toContain('--pool-identity');
  expect(sim.stderr).toContain('--config');
  rmSync(corpus, { recursive: true });
  rmSync(out, { recursive: true });
});

test('campaign estimates --inclusion aborts when a committed run fails to load (ReplayLoadError is fatal)', () => {
  const { corpus, manifest } = fixture();
  const results = mkdtempSync(join(tmpdir(), 'cli-incl-fatal-'));
  // Valid identity + matching committed hash, but finished_at is missing,
  // so recordFromRunDir throws ReplayLoadError. The committed set must not
  // quietly shrink: exit non-zero naming the run, no artifact written.
  const badDir = join(results, 'run-nofinish');
  mkdirSync(join(badDir, 'gauntlet-agent', 'results', 'g1'), {
    recursive: true,
  });
  writeFileSync(
    join(badDir, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      scenario: 's',
      coding_agent: 'claude',
      credential: 'opus_bedrock',
      os: 'linux',
      started_at: '2026-08-08T00:00:00.000Z',
      provenance: {},
      economics: {},
    }),
  );
  writeFileSync(join(badDir, 'trajectory.json'), JSON.stringify({ steps: [] }));
  writeFileSync(join(badDir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(
    join(badDir, 'gauntlet-agent', 'results', 'g1', 'result.json'),
    '{}',
  );
  const hash = Bun.SHA256.hash(
    readFileSync(join(badDir, 'verdict.json')),
    'hex',
  );
  const incl = join(corpus, 'inclusion-nofinish.json');
  writeFileSync(
    incl,
    JSON.stringify({
      run_ids: ['run-nofinish'],
      hashes: { 'run-nofinish': hash },
    }),
  );
  const estimatesPath = join(corpus, 'estimates.json');
  const res = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--scan-results',
    results,
    '--inclusion',
    incl,
    '--out',
    estimatesPath,
  ]);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain('run-nofinish');
  expect(res.stderr).toContain('finished_at');
  expect(res.stdout).not.toContain('skipped');
  expect(existsSync(estimatesPath)).toBe(false); // no partial artifact
  rmSync(results, { recursive: true });
  rmSync(corpus, { recursive: true });
});

test('campaign estimates --inclusion rejects malformed entries loudly (non-string run_id names its index)', () => {
  const { corpus, manifest } = fixture();
  const results = mkdtempSync(join(tmpdir(), 'cli-incl-malformed-'));
  writeRun(join(results, 'run-extra'), BASE, 600_000);
  const incl = join(corpus, 'inclusion-malformed.json');
  writeFileSync(
    incl,
    JSON.stringify({ run_ids: ['run-extra', 42], hashes: {} }),
  );
  const estimatesPath = join(corpus, 'estimates.json');
  const res = run([
    'campaign',
    'estimates',
    '--corpus',
    corpus,
    '--manifest',
    manifest,
    '--scan-results',
    results,
    '--inclusion',
    incl,
    '--out',
    estimatesPath,
  ]);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain('run_ids[1]');
  expect(existsSync(estimatesPath)).toBe(false);
  rmSync(results, { recursive: true });
  rmSync(corpus, { recursive: true });
});

test('campaign estimates reads token volumes from the coding-agent sidecar (C3 pricing source)', () => {
  const { corpus, manifest } = fixture();
  // Both corpus runs share one estimates group; give each a real token
  // volume (writeRun seeds an unreadable '{}' sidecar — tolerance case).
  writeFileSync(
    join(corpus, 'run-base', 'coding-agent-token-usage.json'),
    JSON.stringify({
      total_input: 90_000,
      total_output: 10_000,
      total_tokens: 100_000,
    }),
  );
  writeFileSync(
    join(corpus, 'run-treat', 'coding-agent-token-usage.json'),
    JSON.stringify({ total_tokens: 300_000 }),
  );
  const estimatesPath = join(corpus, 'estimates-tokens.json');
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
  const art = JSON.parse(readFileSync(estimatesPath, 'utf8'));
  // One entry group: median of the two observed volumes.
  expect(art.entries).toHaveLength(1);
  expect(art.entries[0].tokens_total_median).toBe(200_000);
  expect(art.fallbacks.corpus_median.tokens_total_median).toBe(200_000);
  rmSync(corpus, { recursive: true });
});
