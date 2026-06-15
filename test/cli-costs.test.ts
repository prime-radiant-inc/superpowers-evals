import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type CostRow,
  costsJson,
  loadCostRows,
  renderCosts,
} from '../src/cli/costs.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

// ── fixtures ────────────────────────────────────────────────────────────

// A fully-priced coding-agent block (claude-shaped): duration, a token split,
// a non-null est_cost_usd, no unpriced model.
function pricedVerdict(opts: {
  scenario: string;
  agent: string;
  costUsd: number;
  total: number;
}): Record<string, unknown> {
  return {
    schema: 1,
    final: 'pass',
    final_reason: 'because',
    gauntlet: null,
    checks: [],
    error: null,
    scenario: opts.scenario,
    coding_agent: opts.agent,
    started_at: '2026-06-12T00:00:00Z',
    finished_at: '2026-06-12T00:05:00Z',
    economics: {
      partial: false,
      total_est_cost_usd: opts.costUsd + 0.5,
      coding_agent: {
        duration_ms: 120_000,
        model: 'claude-opus-4',
        est_cost_usd: opts.costUsd,
        tokens: {
          input: 1000,
          output: 2000,
          cache_create: 300,
          cache_read: 400,
          total: opts.total,
        },
        has_unpriced_model: false,
      },
      gauntlet: {
        duration_ms: 60_000,
        model: 'claude-sonnet-4',
        est_cost_usd: 0.5,
        tokens: {
          input: 50,
          output: 50,
          cache_create: 0,
          cache_read: 0,
          total: 100,
        },
        has_unpriced_model: false,
      },
    },
  };
}

// A partial verdict (gemini-shaped): economics.partial true and
// economics.coding_agent null — no coding-side cost/tokens/duration available.
function partialVerdict(opts: {
  scenario: string;
  agent: string;
}): Record<string, unknown> {
  return {
    schema: 1,
    final: 'pass',
    final_reason: 'because',
    gauntlet: null,
    checks: [],
    error: null,
    scenario: opts.scenario,
    coding_agent: opts.agent,
    started_at: '2026-06-12T00:00:00Z',
    finished_at: '2026-06-12T00:10:00Z',
    economics: {
      partial: true,
      total_est_cost_usd: null,
      coding_agent: null,
      gauntlet: {
        duration_ms: 60_000,
        model: 'claude-sonnet-4',
        est_cost_usd: 0.5,
        tokens: {
          input: 50,
          output: 50,
          cache_create: 0,
          cache_read: 0,
          total: 100,
        },
        has_unpriced_model: false,
      },
    },
  };
}

function writeRunDir(
  resultsRoot: string,
  runId: string,
  verdict: Record<string, unknown>,
): string {
  const dir = join(resultsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
  return dir;
}

// ── extractCostRow / loadCostRows: single run dir ───────────────────────

test('loadCostRows on a priced single run extracts the coding-agent side', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const rows = loadCostRows(dir, root);
  expect(rows).toHaveLength(1);
  const row = rows[0] as CostRow;
  expect(row.scenario).toBe('alpha');
  expect(row.agent).toBe('claude');
  expect(row.coding.estCostUsd).toBe(2.5);
  expect(row.coding.tokensTotal).toBe(3700);
  expect(row.coding.tokensInput).toBe(1000);
  expect(row.coding.tokensOutput).toBe(2000);
  expect(row.coding.tokensCacheCreate).toBe(300);
  expect(row.coding.tokensCacheRead).toBe(400);
  expect(row.coding.durationMs).toBe(120_000);
  expect(row.coding.unpriced).toBe(false);
  expect(row.wallClockMs).toBe(5 * 60_000);
});

test('loadCostRows marks a partial coding block as unpriced (null cost, not $0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-gemini-20260612T000000Z-abcd',
    partialVerdict({ scenario: 'beta', agent: 'gemini' }),
  );
  const rows = loadCostRows(dir, root);
  expect(rows).toHaveLength(1);
  const row = rows[0] as CostRow;
  expect(row.scenario).toBe('beta');
  expect(row.agent).toBe('gemini');
  expect(row.coding.unpriced).toBe(true);
  // Unpriced/missing must be null — never coerced to 0.
  expect(row.coding.estCostUsd).toBeNull();
  expect(row.coding.tokensTotal).toBeNull();
  expect(row.coding.durationMs).toBeNull();
});

test('loadCostRows treats has_unpriced_model coding block as unpriced', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const v = pricedVerdict({
    scenario: 'gamma',
    agent: 'codex',
    costUsd: 1,
    total: 100,
  });
  const econ = v['economics'] as Record<string, unknown>;
  const coding = econ['coding_agent'] as Record<string, unknown>;
  coding['est_cost_usd'] = null;
  coding['has_unpriced_model'] = true;
  const dir = writeRunDir(root, 'scn-codex-20260612T000000Z-abcd', v);
  const rows = loadCostRows(dir, root);
  const row = rows[0] as CostRow;
  expect(row.coding.unpriced).toBe(true);
  expect(row.coding.estCostUsd).toBeNull();
  // tokens are still present even though cost is unpriced.
  expect(row.coding.tokensTotal).toBe(100);
});

// A mixed multi-model run: the side aggregate est_cost_usd is a REAL number,
// but has_unpriced_model is true (one model went unpriced). economics.ts sets
// these two independently (economics.ts:243-253), so this shape is real on
// disk. The cost is not trustworthy → the row must render as unpriced, and the
// table cost cell must NOT print the partial dollar amount, and the aggregate
// and the cell must agree.
function mixedUnpricedVerdict(opts: {
  scenario: string;
  agent: string;
}): Record<string, unknown> {
  const v = pricedVerdict({
    scenario: opts.scenario,
    agent: opts.agent,
    costUsd: 12.34,
    total: 9000,
  });
  const econ = v['economics'] as Record<string, unknown>;
  const coding = econ['coding_agent'] as Record<string, unknown>;
  coding['has_unpriced_model'] = true; // est_cost_usd stays 12.34
  return v;
}

test('a non-null est_cost_usd with has_unpriced_model is unpriced (cost kept for inspection)', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-codex-20260612T000000Z-abcd',
    mixedUnpricedVerdict({ scenario: 'delta', agent: 'codex' }),
  );
  const row = loadCostRows(dir, root)[0] as CostRow;
  expect(row.coding.unpriced).toBe(true);
  // The raw number is preserved on the row (for --json inspection)…
  expect(row.coding.estCostUsd).toBe(12.34);
});

test('renderCosts shows unpriced (not the partial $) for a mixed-unpriced row', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-codex-20260612T000000Z-abcd',
    mixedUnpricedVerdict({ scenario: 'delta', agent: 'codex' }),
  );
  const out = renderCosts(loadCostRows(dir, root), { color: false });
  expect(out).toContain('unpriced');
  // The partial, untrustworthy dollar amount must NOT appear in the table.
  expect(out).not.toContain('$12.34');
  // …and the aggregate counts it unpriced, never inflating the priced total.
  expect(out).toMatch(/0 priced/);
  expect(out).toMatch(/1 unpriced/);
});

test('the --with-gauntlet cost cell also respects the unpriced flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const v = mixedUnpricedVerdict({ scenario: 'delta', agent: 'codex' });
  const econ = v['economics'] as Record<string, unknown>;
  const g = econ['gauntlet'] as Record<string, unknown>;
  g['has_unpriced_model'] = true; // gauntlet est_cost_usd stays 0.5
  const dir = writeRunDir(root, 'scn-codex-20260612T000000Z-abcd', v);
  const out = renderCosts(loadCostRows(dir, root), {
    color: false,
    withGauntlet: true,
  });
  // The QA-driver cost cell must show the marker, not the untrustworthy $0.50.
  expect(out).not.toContain('$0.50');
});

// ── loadCostRows: batch ─────────────────────────────────────────────────

function makeBatch(): { batchDir: string; resultsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'costs-batch-'));
  const resultsRoot = join(root, 'results');
  const batchDir = join(resultsRoot, 'batches', 'b-001');
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'b-001',
      started_at: '2026-06-12T00:00:00Z',
      finished_at: '2026-06-12T00:30:00Z',
      coding_agents: ['claude', 'gemini'],
    }),
  );
  const records = [
    { scenario: 'alpha', coding_agent: 'claude', run_id: 'run-a-claude' },
    { scenario: 'alpha', coding_agent: 'gemini', run_id: 'run-a-gemini' },
    // skipped directive cell — no run produced, no cost row.
    {
      scenario: 'beta',
      coding_agent: 'claude',
      run_id: null,
      skipped: 'directive',
    },
    // missing-verdict cell — run_id points at no verdict file.
    { scenario: 'beta', coding_agent: 'gemini', run_id: 'run-missing' },
  ];
  writeFileSync(
    join(batchDir, 'results.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  writeRunDir(
    resultsRoot,
    'run-a-claude',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2,
      total: 5000,
    }),
  );
  writeRunDir(
    resultsRoot,
    'run-a-gemini',
    partialVerdict({ scenario: 'alpha', agent: 'gemini' }),
  );
  return { batchDir, resultsRoot };
}

test('loadCostRows on a batch dir yields one row per produced run (skips skipped)', () => {
  const { batchDir, resultsRoot } = makeBatch();
  const rows = loadCostRows(batchDir, resultsRoot);
  // 4 records: 1 priced, 1 partial, 1 skipped (no row), 1 missing-verdict.
  // The skipped (run_id null) cell yields no row.
  const keys = rows.map((r) => `${r.scenario}/${r.agent}`).sort();
  expect(keys).toContain('alpha/claude');
  expect(keys).toContain('alpha/gemini');
  expect(keys).toContain('beta/gemini');
  expect(keys).not.toContain('beta/claude');
});

// The real on-disk layout `run-all` produces: run dirs live at
// `<out-root>/<run_id>` and the batch dir at `<out-root>/batches/<id>`. But
// `quorum costs <batchDir>` is invoked with the DEFAULT --results-root, which is
// NOT the out-root. So the run dirs must be resolved against the batch dir's
// grandparent (the out-root), never the passed results-root.
function makeRealisticBatch(): { batchDir: string; outRoot: string } {
  const outRoot = mkdtempSync(join(tmpdir(), 'costs-realbatch-'));
  const batchDir = join(outRoot, 'batches', 'b-real');
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'b-real',
      started_at: '2026-06-12T00:00:00Z',
      finished_at: '2026-06-12T00:30:00Z',
      coding_agents: ['claude', 'gemini'],
    }),
  );
  const records = [
    { scenario: 'alpha', coding_agent: 'claude', run_id: 'run-real-claude' },
    { scenario: 'alpha', coding_agent: 'gemini', run_id: 'run-real-gemini' },
  ];
  writeFileSync(
    join(batchDir, 'results.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  // Run dirs at <out-root>/<run_id>, NOT under <out-root>/batches/.
  writeRunDir(
    outRoot,
    'run-real-claude',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2,
      total: 5000,
    }),
  );
  writeRunDir(
    outRoot,
    'run-real-gemini',
    partialVerdict({ scenario: 'alpha', agent: 'gemini' }),
  );
  return { batchDir, outRoot };
}

test('loadCostRows resolves batch run dirs via the out-root, not the passed results-root', () => {
  const { batchDir } = makeRealisticBatch();
  // A bogus results-root the run dirs do NOT live under — mirrors `quorum
  // costs <batchDir>` with the default --results-root ("results").
  const bogusResultsRoot = mkdtempSync(join(tmpdir(), 'costs-bogus-'));
  const rows = loadCostRows(batchDir, bogusResultsRoot);
  const claude = rows.find(
    (r) => r.scenario === 'alpha' && r.agent === 'claude',
  );
  expect(claude).toBeDefined();
  // The priced run is found (resolved via the batch grandparent) — NOT an
  // unreadable/unpriced row.
  expect((claude as CostRow).coding.unpriced).toBe(false);
  expect((claude as CostRow).coding.estCostUsd).toBe(2);
  expect((claude as CostRow).coding.tokensTotal).toBe(5000);
});

test('loadCostRows resolves a bare batch id under resultsRoot/batches', () => {
  const { resultsRoot } = makeBatch();
  const rows = loadCostRows('b-001', resultsRoot);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(rows.some((r) => r.scenario === 'alpha' && r.agent === 'claude')).toBe(
    true,
  );
});

test('a batch missing-verdict cell renders as an unpriced row, not a crash', () => {
  const { batchDir, resultsRoot } = makeBatch();
  const rows = loadCostRows(batchDir, resultsRoot);
  const missing = rows.find(
    (r) => r.scenario === 'beta' && r.agent === 'gemini',
  );
  expect(missing).toBeDefined();
  expect((missing as CostRow).coding.unpriced).toBe(true);
  expect((missing as CostRow).coding.estCostUsd).toBeNull();
});

test('a truncated/corrupt results.jsonl line is skipped, not a crash', () => {
  const { batchDir, resultsRoot } = makeBatch();
  // Append a half-written final record (a batch killed mid-flush).
  writeFileSync(
    join(batchDir, 'results.jsonl'),
    `${readFileSync(join(batchDir, 'results.jsonl'), 'utf8')}{"scenario":"gamma","coding_ag`,
  );
  // Must not throw; the good rows still load and the corrupt line is dropped.
  const rows = loadCostRows(batchDir, resultsRoot);
  expect(rows.some((r) => r.scenario === 'alpha' && r.agent === 'claude')).toBe(
    true,
  );
  expect(rows.some((r) => r.scenario === 'gamma')).toBe(false);
});

// ── renderCosts: table + aggregate + unpriced marker ────────────────────

test('renderCosts prints a per-eval table with scenario/agent/cost columns', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const out = renderCosts(loadCostRows(dir, root), { color: false });
  expect(out).toContain('alpha');
  expect(out).toContain('claude');
  expect(out).toContain('$2.50');
  // Gauntlet (QA-driver) cost must NOT appear in the default view.
  expect(out).not.toContain('$0.50');
});

test('renderCosts shows an unpriced marker for a partial row, never $0.00', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-gemini-20260612T000000Z-abcd',
    partialVerdict({ scenario: 'beta', agent: 'gemini' }),
  );
  const out = renderCosts(loadCostRows(dir, root), { color: false });
  expect(out).toContain('unpriced');
  expect(out).not.toContain('$0.00');
});

test('renderCosts prints an aggregate: summed coding cost + priced/unpriced counts', () => {
  const { batchDir, resultsRoot } = makeBatch();
  const out = renderCosts(loadCostRows(batchDir, resultsRoot), {
    color: false,
  });
  // alpha/claude is the only priced row -> total coding cost $2.00.
  expect(out).toContain('$2.00');
  // 1 priced, 2 unpriced (alpha/gemini partial + beta/gemini missing).
  expect(out).toMatch(/1 priced/);
  expect(out).toMatch(/2 unpriced/);
});

test('renderCosts --no-color emits no ANSI escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const out = renderCosts(loadCostRows(dir, root), { color: false });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of the ESC control char is the point.
  expect(out).not.toMatch(/\x1b\[/);
});

test('renderCosts --with-gauntlet adds the QA-driver cost column', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const out = renderCosts(loadCostRows(dir, root), {
    color: false,
    withGauntlet: true,
  });
  expect(out).toContain('$0.50');
});

// ── costsJson: machine output ───────────────────────────────────────────

test('costsJson emits rows + aggregate with null (not 0) for unpriced coding cost', () => {
  const { batchDir, resultsRoot } = makeBatch();
  const payload = costsJson(loadCostRows(batchDir, resultsRoot));
  expect(payload.rows.length).toBeGreaterThanOrEqual(3);
  const partial = payload.rows.find(
    (r) => r.scenario === 'alpha' && r.agent === 'gemini',
  );
  expect(partial?.coding.est_cost_usd).toBeNull();
  expect(partial?.coding.unpriced).toBe(true);
  expect(payload.aggregate.coding_cost_usd).toBe(2);
  expect(payload.aggregate.priced).toBe(1);
  expect(payload.aggregate.unpriced).toBe(2);
});

// ── CLI end-to-end (subprocess, mirrors cli-show.test.ts) ───────────────

test('costs <dir> renders the coding-agent table and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const proc = spawnSync('bun', [CLI, 'costs', dir, '--no-color'], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('Coding-agent costs');
  expect(proc.stdout).toContain('alpha');
  expect(proc.stdout).toContain('$2.50');
  // The gauntlet (QA-driver) cost is NOT in the default view.
  expect(proc.stdout).not.toContain('$0.50');
});

test('costs --with-gauntlet includes the QA-driver cost', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const proc = spawnSync(
    'bun',
    [CLI, 'costs', dir, '--no-color', '--with-gauntlet'],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('$0.50');
});

test('costs --json emits machine output and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const dir = writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const proc = spawnSync('bun', [CLI, 'costs', dir, '--json'], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  const parsed = JSON.parse(proc.stdout) as {
    rows: { coding: { est_cost_usd: number | null } }[];
    aggregate: { coding_cost_usd: number; priced: number };
  };
  expect(parsed.rows[0]?.coding.est_cost_usd).toBe(2.5);
  expect(parsed.aggregate.priced).toBe(1);
});

test('costs with no target resolves the newest run under results-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  writeRunDir(
    root,
    'scn-claude-20260612T000000Z-abcd',
    pricedVerdict({
      scenario: 'alpha',
      agent: 'claude',
      costUsd: 2.5,
      total: 3700,
    }),
  );
  const proc = spawnSync(
    'bun',
    [CLI, 'costs', '--results-root', root, '--json'],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
  const parsed = JSON.parse(proc.stdout) as { rows: { scenario: string }[] };
  expect(parsed.rows[0]?.scenario).toBe('alpha');
});

test('costs exits 1 when the target cannot be resolved', () => {
  const root = mkdtempSync(join(tmpdir(), 'costs-'));
  const proc = spawnSync('bun', [CLI, 'costs', '--results-root', root], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(1);
});

test('costs renders a batch matrix as one row per produced run', () => {
  const { resultsRoot } = makeBatch();
  const proc = spawnSync(
    'bun',
    [CLI, 'costs', 'b-001', '--results-root', resultsRoot, '--no-color'],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('alpha');
  expect(proc.stdout).toContain('claude');
  expect(proc.stdout).toContain('gemini');
  expect(proc.stdout).toContain('unpriced');
  expect(proc.stdout).toMatch(/1 priced/);
});
