import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePhase } from '../src/runner/phase.ts';

const IDENTITY = {
  scenario: 'demo',
  agent: 'claude',
  credential: 'none',
  os: 'linux',
};

test('writePhase writes {phase, updated_at, pid, identity}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-'));
  writePhase(dir, 'agent', IDENTITY);
  const j = JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'));
  expect(j.phase).toBe('agent');
  expect(typeof j.pid).toBe('number');
  expect(j.pid).toBe(process.pid);
  expect(typeof j.updated_at).toBe('string');
});

test('writePhase writes the run self-identity into phase.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-'));
  writePhase(dir, 'setup', {
    scenario: 'my-scn',
    agent: 'claude-haiku',
    credential: 'opus',
    os: 'windows',
  });
  const j = JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'));
  expect(j.identity.scenario).toBe('my-scn');
  expect(j.identity.agent).toBe('claude-haiku');
  expect(j.identity.credential).toBe('opus');
  expect(j.identity.os).toBe('windows');
});
