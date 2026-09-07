import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('stopped writer retains completed conversation and existing assessment/check evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stopped-completed-'));
  const conversation = {
    status: 'completed',
    endpoint: 'refusal',
    reason: 'refused',
    timestamp: '2026-09-07T00:00:00Z',
    evidence: { path: 'conversation-agent/demo/captures/1.txt', quote: 'No' },
  };
  const existing = {
    ...buildStoppedVerdict({
      scenario: 'demo',
      codingAgent: 'claude',
      startedAt: '2026-09-07T00:00:00Z',
    }),
    gauntlet: {
      status: 'pass',
      summary: 'assessed',
      reasoning: '',
      run_id: 'demo',
    },
    economics: { retained: true },
    conversation,
  };
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(existing));
  writeFileSync(join(dir, 'conversation.json'), JSON.stringify(conversation));
  writeStoppedVerdict(dir, {
    scenario: 'demo',
    codingAgent: 'claude',
    startedAt: '2026-09-07T00:00:00Z',
  });
  const actual = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
  expect(actual.conversation).toEqual(conversation);
  expect(actual.gauntlet).toEqual(existing.gauntlet);
  expect(actual.economics).toEqual(existing.economics);
  rmSync(dir, { recursive: true, force: true });
});
