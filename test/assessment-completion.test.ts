import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAssessmentStop,
  readAssessmentCompletion,
} from '../src/runner/assessment-completion.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const runId = 'demo_20260909T120000Z_ab12';
function fixture(status = 'pass', verdict = 'pass') {
  const root = mkdtempSync(join(tmpdir(), 'completion-'));
  dirs.push(root);
  const outDir = join(root, runId);
  mkdirSync(outDir);
  const result = {
    runId,
    scenario: 'demo',
    status,
    summary: 'Inspected',
    reasoning: 'Retained evidence',
    criteria: [{ criterion: 'Works', verdict, evidence: 'output/a.ts' }],
  };
  const bytes = `${JSON.stringify(result)}\n`;
  writeFileSync(join(outDir, 'result.json'), bytes);
  const marker = {
    schema_version: 1 as const,
    run_id: runId,
    status: 'completed' as const,
    reason: 'Accepted report',
    terminal_at: '2026-09-09T12:00:01.000Z',
    accepted_report_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const write = (value: unknown = marker) =>
    writeFileSync(
      join(outDir, 'assessment-completion.json'),
      JSON.stringify(value),
    );
  return { outDir, runId, marker, write, result };
}
test('a completed child cannot undo an existing parent stop', () => {
  expect(applyAssessmentStop('cancelled', 'completed')).toBe('cancelled');
  expect(applyAssessmentStop('timed_out', 'cancelled')).toBe('timed_out');
  expect(applyAssessmentStop(null, 'timed_out')).toBe('timed_out');
  expect(applyAssessmentStop(null, 'completed')).toBeNull();
});
test('missing completion is an operational failure', () => {
  const f = fixture();
  expect(() => readAssessmentCompletion(f)).toThrow();
});
for (const patch of [
  { schema_version: 2 },
  { run_id: 'other_20260909T120000Z_ab12' },
  { run_id: 'bad' },
  { reason: '  ' },
  { terminal_at: '2026-09-09' },
  { terminal_at: 'invalid' },
  { accepted_report_sha256: null },
  { accepted_report_sha256: 'A'.repeat(64) },
  { status: 'cancelled' },
  { status: 'unknown' },
])
  test(`rejects invalid marker ${JSON.stringify(patch)}`, () => {
    const f = fixture();
    f.write({ ...f.marker, ...patch });
    expect(() => readAssessmentCompletion(f)).toThrow();
  });
test('digest binds exact bytes, including whitespace', () => {
  const f = fixture();
  f.write();
  writeFileSync(join(f.outDir, 'result.json'), JSON.stringify(f.result));
  expect(() => readAssessmentCompletion(f)).toThrow('digest');
});
for (const [status, verdict] of [
  ['pass', 'pass'],
  ['fail', 'fail'],
  ['investigate', 'unclear'],
])
  test(`accepts completed semantic ${status}`, () => {
    const f = fixture(status, verdict);
    f.write();
    expect(readAssessmentCompletion(f)).toEqual(f.marker);
  });
for (const [status, verdict] of [
  ['pass', 'fail'],
  ['fail', 'pass'],
  ['investigate', 'pass'],
])
  test(`rejects contradictory ${status}/${verdict} result even with matching digest`, () => {
    const f = fixture(status, verdict);
    f.write();
    expect(() => readAssessmentCompletion(f)).toThrow();
  });
test('rejects a result for another run even with a matching digest', () => {
  const f = fixture();
  const bytes = JSON.stringify({
    ...f.result,
    runId: 'other_20260909T120000Z_ab12',
  });
  writeFileSync(join(f.outDir, 'result.json'), bytes);
  f.write({
    ...f.marker,
    accepted_report_sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  expect(() => readAssessmentCompletion(f)).toThrow();
});
for (const status of ['timed_out', 'cancelled', 'errored'] as const)
  test(`reads operational ${status} without requiring a result`, () => {
    const f = fixture();
    rmSync(join(f.outDir, 'result.json'));
    f.write({ ...f.marker, status, accepted_report_sha256: null });
    expect(readAssessmentCompletion(f).status).toBe(status);
  });
