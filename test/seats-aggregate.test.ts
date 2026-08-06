import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRuns, rollup, scanRun } from '../src/seats/aggregate.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'seats');
const CLAUDE_ID =
  'sdd-report-formatter-claude-opus-linux-20260803T000000Z-aaaa';
const CODEX_ID =
  'sdd-report-formatter-codex-codex_sub-linux-20260803T000000Z-bbbb';
const CODEX_NULL_PATH_ID =
  'sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T175954Z-3d50';

test('discoverRuns finds run dirs by their log tree, filtered by scenario prefix', () => {
  expect(discoverRuns(FIXTURES, 'sdd-').map((d) => d.split('/').pop())).toEqual(
    [CODEX_NULL_PATH_ID, CLAUDE_ID, CODEX_ID],
  );
  expect(discoverRuns(FIXTURES, 'sdd-report-formatter-codex')).toHaveLength(1);
  expect(discoverRuns(FIXTURES, 'nope-')).toEqual([]);
});

test('discoverRuns descends one level so batch dirs are not missed', () => {
  // Recorded batches (sdd-e27-stack-*) hold their runs as subdirectories and
  // carry no logs of their own. A depth-1-only scan silently drops 115 runs.
  const root = mkdtempSync(join(tmpdir(), 'seats-'));
  const nested = join(
    root,
    'sdd-batch-20260803T000000Z',
    'sdd-inner-claude-x-aaaa',
  );
  mkdirSync(join(nested, 'coding-agent-config', 'projects', 'slug'), {
    recursive: true,
  });
  writeFileSync(
    join(nested, 'coding-agent-config', 'projects', 'slug', 'sess.jsonl'),
    '',
  );
  expect(discoverRuns(root, 'sdd-')).toEqual([nested]);
});

test('scanRun reads run identity from verdict.json, including superpowers_rev', () => {
  const run = scanRun(join(FIXTURES, CLAUDE_ID));
  expect(run).not.toBeNull();
  expect(run?.runId).toBe(CLAUDE_ID);
  expect(run?.dialect).toBe('claude');
  expect(run?.scenario).toBe('sdd-report-formatter');
  expect(run?.agent).toBe('claude');
  expect(run?.credential).toBe('opus');
  expect(run?.superpowersRev).toBe('c686bb947ab1469bd396e0b691f28f96a3c4ee0c');
  expect(run?.superpowersDirty).toBe(false);
  expect(run?.seats).toHaveLength(4);
  // Redundancy is adjudicated as part of the scan, so seats come out marked.
  const finalSuiteRuns =
    run?.seats
      .find((s) => s.role === 'final_reviewer')
      ?.events.filter((e) => e.isSuiteRun === true) ?? [];
  expect(finalSuiteRuns.map((e) => e.redundant)).toEqual([true, true]);
});

test('scanRun falls back to the log dialect when verdict.json has no agent', () => {
  // Runs recorded before the verdict schema carried scenario/agent/credential
  // still have logs. Inventing a scenario name out of the directory would be a
  // guess, so those stay null and the dialect names the agent.
  const root = mkdtempSync(join(tmpdir(), 'seats-'));
  const runDir = join(root, 'sdd-old-claude-20260609T000000Z-1234');
  const projectDir = join(runDir, 'coding-agent-config', 'projects', 'slug');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'aaaa.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-09T00:00:01.000Z',
      isSidechain: false,
      message: { model: 'claude-opus-4-8', content: [] },
    })}\n`,
  );
  writeFileSync(join(runDir, 'verdict.json'), JSON.stringify({ schema: 1 }));
  const run = scanRun(runDir);
  expect(run?.agent).toBe('claude');
  expect(run?.scenario).toBeNull();
  expect(run?.credential).toBeNull();
  expect(run?.superpowersRev).toBeNull();
});

test('rollup counts seats and reps separately, raw / full / redundant', () => {
  const runs = [
    scanRun(join(FIXTURES, CLAUDE_ID)),
    scanRun(join(FIXTURES, CODEX_ID)),
  ].flatMap((r) => (r === null ? [] : [r]));
  const rows = rollup(runs);
  const finalClaude = rows.find(
    (r) => r.agent === 'claude' && r.role === 'final_reviewer',
  );
  expect(finalClaude).toEqual({
    agent: 'claude',
    role: 'final_reviewer',
    seats: 1,
    seatsWithSuiteRun: 1,
    seatsWithFullSuiteRun: 1,
    seatsWithRedundantSuiteRun: 1,
    seatsWithEvidenceRead: 0,
    seatsWithNoPatches: 1,
    suiteRuns: 2,
    fullSuiteRuns: 1,
    redundantSuiteRuns: 2,
    evidenceReads: 0,
    reps: 1,
    repsWithSuiteRun: 1,
    repsWithFullSuiteRun: 1,
    repsWithRedundantSuiteRun: 1,
  });
  // The Codex final reviewer ran the same two shapes but a patch landed in
  // between, so nothing is redundant there.
  const finalCodex = rows.find(
    (r) => r.agent === 'codex' && r.role === 'final_reviewer',
  );
  expect(finalCodex?.suiteRuns).toBe(2);
  expect(finalCodex?.redundantSuiteRuns).toBe(0);
  expect(finalCodex?.repsWithRedundantSuiteRun).toBe(0);
  // A task reviewer that only re-read the report: no suite runs, one read.
  const reviewers = rows.filter((r) => r.role === 'task_reviewer');
  expect(reviewers.map((r) => r.seatsWithSuiteRun)).toEqual([0, 0]);
  expect(reviewers.map((r) => r.seatsWithEvidenceRead)).toEqual([1, 1]);
  // A row per (agent, role) pair that actually has seats, in a fixed order so
  // the table is stable across runs. Neither fixture has a fix_reviewer seat,
  // so neither gets a fix_reviewer row.
  expect(rows.map((r) => `${r.agent}/${r.role}`)).toEqual([
    'claude/controller',
    'claude/implementer',
    'claude/task_reviewer',
    'claude/final_reviewer',
    'codex/controller',
    'codex/implementer',
    'codex/task_reviewer',
    'codex/final_reviewer',
  ]);
});
