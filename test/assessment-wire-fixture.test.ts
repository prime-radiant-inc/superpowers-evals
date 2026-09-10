import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssessmentFixtureEvidence } from './assessment-wire-fixture.ts';

test('fixture releases strongly retained handlers and awaits native server drain without GC', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures/assessment-handler-drain.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({
    blockedBeforeRelease: true,
    retainedHandlers: 1,
    explicitlySettled: true,
    nativeStopCompleted: true,
    pendingRequests: 0,
  });
}, 5000);

for (const phase of ['assertions', 'cleanup'] as const)
  test(`late ${phase} retains fixture evidence even if the watchdog was delayed`, () => {
    const runDir = mkdtempSync(join(tmpdir(), 'retention-regression-'));
    let elapsed = 0;
    const evidence = new AssessmentFixtureEvidence(
      runDir,
      phase,
      () => elapsed,
    );
    if (phase === 'assertions') elapsed = 15001;
    evidence.phase('assertions-completed');
    elapsed = 15002;
    expect(() => evidence.finish(true, true)).toThrow(
      'evidence retention boundary',
    );
    expect(existsSync(runDir)).toBe(true);
    expect(
      readFileSync(join(runDir, 'fixture-phases.jsonl'), 'utf8'),
    ).toContain('retained-after-deadline');
    rmSync(runDir, { recursive: true, force: true });
  });

test('a pre-bound watchdog preserves the fixture through eventual successful cleanup', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'retention-watchdog-'));
  const evidence = new AssessmentFixtureEvidence(
    runDir,
    'watchdog',
    () => 0,
    5,
  );
  await Bun.sleep(20);
  expect(readFileSync(join(runDir, 'fixture-phases.jsonl'), 'utf8')).toContain(
    'pre-bound-watchdog',
  );
  expect(() => evidence.finish(true, true)).toThrow(
    'evidence retention boundary',
  );
  expect(existsSync(runDir)).toBe(true);
  rmSync(runDir, { recursive: true, force: true });
});

test('cleanup failure preserves metadata; prompt assertions and cleanup permit deletion', () => {
  const failed = mkdtempSync(join(tmpdir(), 'retention-cleanup-'));
  new AssessmentFixtureEvidence(failed, 'cleanup').finish(true, false);
  expect(readFileSync(join(failed, 'fixture-phases.jsonl'), 'utf8')).toContain(
    'cleanup-failed',
  );
  rmSync(failed, { recursive: true, force: true });
  const passed = mkdtempSync(join(tmpdir(), 'retention-passed-'));
  new AssessmentFixtureEvidence(passed, 'passed').finish(true, true);
  expect(existsSync(passed)).toBe(false);
});
