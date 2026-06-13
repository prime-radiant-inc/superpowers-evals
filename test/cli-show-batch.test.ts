import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { batchJson, isBatchDir, renderBatch } from '../src/cli/render-batch.ts';

// batchJson is print-only `unknown`; narrow with zod rather than asserting a
// shape (coding standard: parse, don't cast).
const PayloadSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable().optional(),
  coding_agents: z.array(z.string()),
  results: z.array(z.record(z.string(), z.unknown())),
});

type FinalStatus = 'pass' | 'fail' | 'indeterminate';

interface Fixture {
  readonly batchDir: string;
  readonly resultsRoot: string;
}

// Build a hermetic batch dir (batch.json + results.jsonl) plus a sibling
// resultsRoot of <run_id>/verdict.json files. The grid is two scenarios ×
// two agents, with one skipped cell and one missing-verdict cell (the
// alpha/codex run_id points at no verdict file).
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'batch-'));
  const batchDir = join(root, 'batch');
  const resultsRoot = join(root, 'results');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(resultsRoot, { recursive: true });

  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'b-001',
      started_at: '2026-06-12T00:00:00Z',
      finished_at: '2026-06-12T00:30:00Z',
      coding_agents: ['claude', 'codex'],
    }),
  );

  const records = [
    { scenario: 'alpha', coding_agent: 'claude', run_id: 'run-alpha-claude' },
    // missing-verdict cell: run_id has no verdict.json on disk.
    { scenario: 'alpha', coding_agent: 'codex', run_id: 'run-missing' },
    { scenario: 'beta', coding_agent: 'claude', run_id: 'run-beta-claude' },
    // skipped cell (directive).
    {
      scenario: 'beta',
      coding_agent: 'codex',
      run_id: null,
      skipped: 'coding-agents directive',
    },
  ];
  writeFileSync(
    join(batchDir, 'results.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );

  const writeVerdict = (runId: string, final: FinalStatus): void => {
    const dir = join(resultsRoot, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'verdict.json'),
      JSON.stringify({
        schema: 1,
        final,
        final_reason: 'because',
        gauntlet: null,
        checks: [],
        error: null,
        economics: null,
      }),
    );
  };
  writeVerdict('run-alpha-claude', 'pass');
  writeVerdict('run-beta-claude', 'fail');
  // run-missing intentionally has no verdict.json.

  return { batchDir, resultsRoot };
}

test('isBatchDir is true for a dir with batch.json, false otherwise', () => {
  const { batchDir, resultsRoot } = makeFixture();
  expect(isBatchDir(batchDir)).toBe(true);
  // resultsRoot has run dirs but no batch.json.
  expect(isBatchDir(resultsRoot)).toBe(false);
});

test('renderBatch (color:false) renders the banner with started + finished', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  expect(out).toContain(
    'batch b-001 · started 2026-06-12T00:00:00Z · finished 2026-06-12T00:30:00Z',
  );
});

test('renderBatch (color:false) renders an agent header row for each agent', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  // Header row carries the scenario label and both agent names.
  const headerLine = out
    .split('\n')
    .find((l) => l.includes('scenario') && l.includes('claude'));
  expect(headerLine).toBeDefined();
  expect(headerLine).toContain('codex');
});

test('renderBatch (color:false) renders the correct glyph+label per cell', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  const lines = out.split('\n');

  const alphaRow = lines.find((l) => l.startsWith('| alpha'));
  expect(alphaRow).toBeDefined();
  // alpha/claude -> pass; alpha/codex -> missing verdict -> "? ?".
  expect(alphaRow).toContain('✓ pass');
  expect(alphaRow).toContain('? ?');

  const betaRow = lines.find((l) => l.startsWith('| beta'));
  expect(betaRow).toBeDefined();
  // beta/claude -> fail; beta/codex -> skipped -> "— skip".
  expect(betaRow).toContain('✗ fail');
  expect(betaRow).toContain('— skip');
});

test('renderBatch (color:false) emits no ANSI escapes', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of the ESC control char is the point.
  expect(out).not.toMatch(/\x1b\[/);
});

test('renderBatch (color:true) wraps cells in truecolor ANSI', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: true });
  // pass uses Dracula green rgb(80,250,123).
  expect(out).toContain('\x1b[38;2;80;250;123m');
  // skipped/unknown use the label gray rgb(122,130,148).
  expect(out).toContain('\x1b[38;2;122;130;148m');
});

test('renderBatch renders the verbatim Legend line', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  expect(out).toContain(
    'Legend: ✓ pass   ✗ fail   ⊘ indeterminate   — skipped (directive)   ? no verdict',
  );
});

test('renderBatch renders the tally counts (including the unknown suffix)', () => {
  const { batchDir, resultsRoot } = makeFixture();
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  // 1 pass, 1 fail, 0 indet, 1 skipped, 1 unknown -> the unknown suffix shows.
  expect(out).toContain('1 ✓ · 1 ✗ · 0 ⊘ · 1 — · 1 ?');
});

test('renderBatch omits the unknown tally suffix when no cell is unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-'));
  const batchDir = join(root, 'batch');
  const resultsRoot = join(root, 'results');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(join(resultsRoot, 'r1'), { recursive: true });
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      id: 'b-002',
      started_at: '2026-06-12T01:00:00Z',
      coding_agents: ['claude'],
    }),
  );
  writeFileSync(
    join(batchDir, 'results.jsonl'),
    `${JSON.stringify({ scenario: 'alpha', coding_agent: 'claude', run_id: 'r1' })}\n`,
  );
  writeFileSync(
    join(resultsRoot, 'r1', 'verdict.json'),
    JSON.stringify({ final: 'pass' }),
  );
  const out = renderBatch({ batchDir, resultsRoot, color: false });
  // No finished_at -> banner has no "finished" segment.
  expect(out).toContain('batch b-002 · started 2026-06-12T01:00:00Z\n');
  expect(out).not.toContain('finished');
  // Tally with zero unknown -> the last line is the bare 4-count tally, no
  // " · N ?" suffix. (The Legend line above still contains "?", so assert on
  // the tally line itself.)
  const tallyLine = out.trimEnd().split('\n').at(-1);
  expect(tallyLine).toBe('1 ✓ · 0 ✗ · 0 ⊘ · 0 —');
});

test('batchJson returns the header spread with a results array', () => {
  const { batchDir } = makeFixture();
  const payload = PayloadSchema.parse(batchJson(batchDir));
  expect(payload.id).toBe('b-001');
  expect(payload.started_at).toBe('2026-06-12T00:00:00Z');
  expect(payload.finished_at).toBe('2026-06-12T00:30:00Z');
  expect(payload.coding_agents).toEqual(['claude', 'codex']);
  expect(payload.results).toHaveLength(4);
  expect(payload.results[0]).toMatchObject({
    scenario: 'alpha',
    coding_agent: 'claude',
    run_id: 'run-alpha-claude',
  });
});
