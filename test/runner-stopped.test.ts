import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';
import {
  buildStoppedVerdict,
  writeStoppedVerdict,
} from '../src/runner/stopped.ts';

test('buildStoppedVerdict is indeterminate with stage=stopped', () => {
  const v = buildStoppedVerdict({
    scenario: 'demo',
    codingAgent: 'claude',
    startedAt: '2026-06-12T00:00:00.000Z',
  });
  const parsed = FinalVerdictSchema.parse(v);
  expect(parsed.final).toBe('indeterminate');
  expect(parsed.error?.stage).toBe('stopped');
  expect(parsed.scenario).toBe('demo');
});

test('writeStoppedVerdict lands verdict.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stopped-'));
  writeStoppedVerdict(dir, {
    scenario: 'demo',
    codingAgent: 'claude',
    startedAt: '2026-06-12T00:00:00.000Z',
  });
  const j = FinalVerdictSchema.parse(
    JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')),
  );
  expect(j.final).toBe('indeterminate');
  expect(j.error?.stage).toBe('stopped');
});
