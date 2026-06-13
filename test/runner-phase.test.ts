import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePhase } from '../src/runner/phase.ts';

test('writePhase writes {phase, updated_at, pid}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-'));
  writePhase(dir, 'agent');
  const j = JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'));
  expect(j.phase).toBe('agent');
  expect(typeof j.pid).toBe('number');
  expect(j.pid).toBe(process.pid);
  expect(typeof j.updated_at).toBe('string');
});
