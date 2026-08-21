// test/campaign-acquire.test.ts
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCorpus, PAYLOAD_RUN_FILES } from '../src/campaign/acquire.ts';

function makeResultsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'acquire-src-'));
  const run = 'sdd-escalates-claude-opus_bedrock-linux-20260808T000000Z-ab12';
  const runDir = join(root, run);
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', 'g1'), {
    recursive: true,
  });
  writeFileSync(join(runDir, 'verdict.json'), '{"final":"pass"}');
  writeFileSync(join(runDir, 'trajectory.json'), '{"steps":[]}');
  writeFileSync(join(runDir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(
    join(runDir, 'gauntlet-agent', 'results', 'g1', 'result.json'),
    '{"duration_ms":56000}',
  );
  // home/ must never be copied:
  mkdirSync(join(runDir, 'home', '.claude'), { recursive: true });
  writeFileSync(join(runDir, 'home', '.claude', 'oauth'), 'SECRET');
  // batches: one batch references the run, one does not
  mkdirSync(join(root, 'batches', 'batch-20260808T000000Z-aaaa'), {
    recursive: true,
  });
  writeFileSync(
    join(root, 'batches', 'batch-20260808T000000Z-aaaa', 'batch.json'),
    '{"id":"batch-20260808T000000Z-aaaa"}',
  );
  writeFileSync(
    join(root, 'batches', 'batch-20260808T000000Z-aaaa', 'results.jsonl'),
    `${JSON.stringify({ scenario: 'sdd-escalates', coding_agent: 'claude', run_id: run })}\n`,
  );
  mkdirSync(join(root, 'batches', 'batch-other'), { recursive: true });
  writeFileSync(
    join(root, 'batches', 'batch-other', 'batch.json'),
    '{"id":"batch-other"}',
  );
  writeFileSync(
    join(root, 'batches', 'batch-other', 'results.jsonl'),
    '{"run_id":"someone-else"}\n',
  );
  return root;
}

test('acquireCorpus copies the payload, never homes, and writes the selection manifest', async () => {
  const src = makeResultsRoot();
  const out = mkdtempSync(join(tmpdir(), 'acquire-out-'));
  const run = 'sdd-escalates-claude-opus_bedrock-linux-20260808T000000Z-ab12';
  const manifest = await acquireCorpus({
    resultsRoot: src,
    runIds: [run, 'missing-run'],
    outDir: out,
    sourceHost: 'quorum-appliance',
    now: '2026-08-20T00:00:00.000Z',
    command: 'quorum campaign acquire --runs-file runs.txt',
  });
  expect(manifest.runs).toHaveLength(1);
  expect(manifest.runs[0]!.run_id).toBe(run);
  expect(manifest.missing_run_ids).toEqual(['missing-run']);
  for (const f of PAYLOAD_RUN_FILES) {
    expect(manifest.runs[0]!.files.some((x) => x.path === f)).toBe(true);
  }
  // gauntlet result.json present, home absent
  expect(
    manifest.runs[0]!.files.some(
      (x) => x.path === 'gauntlet-agent/results/g1/result.json',
    ),
  ).toBe(true);
  expect(manifest.runs[0]!.files.some((x) => x.path.startsWith('home/'))).toBe(
    false,
  );
  // batch metadata: only the batch that references the run
  expect(manifest.batches.map((b) => b.batch_id)).toEqual([
    'batch-20260808T000000Z-aaaa',
  ]);
  // files actually landed
  const landed = readFileSync(join(out, run, 'verdict.json'), 'utf8');
  expect(landed).toBe('{"final":"pass"}');
  const sel = JSON.parse(
    readFileSync(join(out, 'selection-manifest.json'), 'utf8'),
  );
  expect(sel.schema_version).toBe('quorum.corpus-selection/v1');
  expect(sel.source_host).toBe('quorum-appliance');
  expect(sel.pulled_at).toBe('2026-08-20T00:00:00.000Z');
  expect(sel.runs[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  rmSync(src, { recursive: true });
  rmSync(out, { recursive: true });
});

test('a symlinked payload file fails the run and copies nothing', async () => {
  const src = mkdtempSync(join(tmpdir(), 'acquire-src-'));
  const out = mkdtempSync(join(tmpdir(), 'acquire-out-'));
  const run = 'run-sym-payload-linux-20260820T000000Z-aa';
  const runDir = join(src, run);
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', 'g1'), {
    recursive: true,
  });
  writeFileSync(join(runDir, 'trajectory.json'), '{"steps":[]}');
  writeFileSync(join(runDir, 'coding-agent-token-usage.json'), '{}');
  writeFileSync(
    join(runDir, 'gauntlet-agent', 'results', 'g1', 'result.json'),
    '{}',
  );
  // verdict.json is a symlink to a secret-bearing file outside the payload:
  writeFileSync(join(src, 'secret'), 'TOPSECRET');
  symlinkSync(join(src, 'secret'), join(runDir, 'verdict.json'));
  const manifest = await acquireCorpus({
    resultsRoot: src,
    runIds: [run],
    outDir: out,
    sourceHost: 'quorum-appliance',
    now: '2026-08-20T00:00:00.000Z',
    command: 'quorum campaign acquire --runs-file runs.txt',
  });
  expect(manifest.missing_run_ids).toEqual([run]);
  const entry = manifest.runs.find((r) => r.run_id === run);
  expect(entry).toBeDefined();
  expect(entry!.files).toHaveLength(0);
  expect(entry!.notes.length).toBeGreaterThan(0);
  expect(existsSync(join(out, run))).toBe(false);
  rmSync(src, { recursive: true });
  rmSync(out, { recursive: true });
});

test("a run id of '../escape' is rejected, not copied", async () => {
  const src = mkdtempSync(join(tmpdir(), 'acquire-src-'));
  const out = mkdtempSync(join(tmpdir(), 'acquire-out-'));
  const manifest = await acquireCorpus({
    resultsRoot: src,
    runIds: ['../escape'],
    outDir: out,
    sourceHost: 'quorum-appliance',
    now: '2026-08-20T00:00:00.000Z',
    command: 'quorum campaign acquire --runs-file runs.txt',
  });
  expect(manifest.missing_run_ids).toEqual(['../escape']);
  const entry = manifest.runs.find((r) => r.run_id === '../escape');
  expect(entry).toBeDefined();
  expect(entry!.files).toHaveLength(0);
  expect(entry!.notes.length).toBeGreaterThan(0);
  expect(readdirSync(out)).toEqual(['selection-manifest.json']);
  rmSync(src, { recursive: true });
  rmSync(out, { recursive: true });
});

test('a run with two gauntlet result dirs is failed, nothing copied', async () => {
  const src = mkdtempSync(join(tmpdir(), 'acquire-src-'));
  const out = mkdtempSync(join(tmpdir(), 'acquire-out-'));
  const run = 'run-ambiguous-claude-opus_anthropic-linux-20260820T000000Z-bb';
  const runDir = join(src, run);
  for (const g of ['g1', 'g2']) {
    mkdirSync(join(runDir, 'gauntlet-agent', 'results', g), {
      recursive: true,
    });
    writeFileSync(
      join(runDir, 'gauntlet-agent', 'results', g, 'result.json'),
      '{}',
    );
  }
  writeFileSync(join(runDir, 'verdict.json'), '{"final":"pass"}');
  writeFileSync(join(runDir, 'trajectory.json'), '{"steps":[]}');
  writeFileSync(join(runDir, 'coding-agent-token-usage.json'), '{}');
  const manifest = await acquireCorpus({
    resultsRoot: src,
    runIds: [run],
    outDir: out,
    sourceHost: 'quorum-appliance',
    now: '2026-08-20T00:00:00.000Z',
    command: 'quorum campaign acquire --runs-file runs.txt',
  });
  expect(manifest.missing_run_ids).toEqual([run]);
  const entry = manifest.runs.find((r) => r.run_id === run);
  expect(entry).toBeDefined();
  expect(entry!.files).toHaveLength(0);
  expect(entry!.notes[0]).toContain('2');
  expect(existsSync(join(out, run))).toBe(false);
  rmSync(src, { recursive: true });
  rmSync(out, { recursive: true });
});

test('batch selection requires exact run_id equality, not substring', async () => {
  const src = mkdtempSync(join(tmpdir(), 'acquire-src-'));
  const out = mkdtempSync(join(tmpdir(), 'acquire-out-'));
  const run = 'sdd-run-x';
  // substring-only match: must NOT be selected
  mkdirSync(join(src, 'batches', 'batch-substring'), { recursive: true });
  writeFileSync(
    join(src, 'batches', 'batch-substring', 'batch.json'),
    '{"id":"batch-substring"}',
  );
  writeFileSync(
    join(src, 'batches', 'batch-substring', 'results.jsonl'),
    `${JSON.stringify({ run_id: `prefix-${run}-suffix` })}\n`,
  );
  // exact match on the second line, with an unparseable first line: selected
  mkdirSync(join(src, 'batches', 'batch-exact'), { recursive: true });
  writeFileSync(
    join(src, 'batches', 'batch-exact', 'batch.json'),
    '{"id":"batch-exact"}',
  );
  writeFileSync(
    join(src, 'batches', 'batch-exact', 'results.jsonl'),
    `not json at all\n${JSON.stringify({ scenario: 'sdd', coding_agent: 'claude', run_id: run })}\n`,
  );
  const manifest = await acquireCorpus({
    resultsRoot: src,
    runIds: [run],
    outDir: out,
    sourceHost: 'quorum-appliance',
    now: '2026-08-20T00:00:00.000Z',
    command: 'quorum campaign acquire --runs-file runs.txt',
  });
  expect(manifest.batches.map((b) => b.batch_id)).toEqual(['batch-exact']);
  rmSync(src, { recursive: true });
  rmSync(out, { recursive: true });
});
