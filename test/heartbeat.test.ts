import { expect, test } from 'bun:test';
import type { MatrixEntry } from '../src/contracts/batch.ts';
import { HeartbeatTracker, heartbeatLine } from '../src/run-all/heartbeat.ts';

function entry(scenario: string, agent: string): MatrixEntry {
  return {
    scenario,
    codingAgent: agent,
    scenarioDir: `/x/${scenario}`,
    skippedReason: null,
    tier: 'sentinel',
    status: 'ready',
    credential: '',
    limiterKey: agent,
  };
}

const AT = new Date('2026-06-16T03:53:10.000Z');

test('heartbeatLine formats counts, UTC time, and running labels', () => {
  expect(
    heartbeatLine({
      running: ['claude:alpha', 'codex:beta'],
      jobs: 4,
      done: 12,
      queued: 18,
      now: AT,
    }),
  ).toBe(
    '⋯ 03:53:10Z · running 2/4 · done 12 · queued 18 · [claude:alpha, codex:beta]',
  );
});

test('heartbeatLine shows an empty bracket when nothing runs (the stall signature)', () => {
  const line = heartbeatLine({
    running: [],
    jobs: 4,
    done: 5,
    queued: 7,
    now: AT,
  });
  expect(line).toContain('running 0/4');
  expect(line).toContain('· []');
});

test('HeartbeatTracker tracks running, done, and queued across events', () => {
  const t = new HeartbeatTracker(3);
  t.onEvent({ kind: 'cell_started', idx: 1, entry: entry('a', 'claude') });
  t.onEvent({ kind: 'cell_started', idx: 2, entry: entry('b', 'codex') });

  let s = t.snapshot(AT, 4);
  expect(s.running).toEqual(['claude:a', 'codex:b']);
  expect(s.done).toBe(0);
  expect(s.queued).toBe(1); // 3 total - 0 done - 2 running

  t.onEvent({
    kind: 'cell_finished',
    idx: 1,
    entry: entry('a', 'claude'),
    result: { run_id: 'r', exit_code: 0, error: null },
    run_id: 'r',
    elapsed_s: 1,
  });
  s = t.snapshot(AT, 4);
  expect(s.running).toEqual(['codex:b']);
  expect(s.done).toBe(1);
  expect(s.queued).toBe(1); // 3 - 1 done - 1 running
});

test('HeartbeatTracker counts a runtime skip as terminal', () => {
  const t = new HeartbeatTracker(2);
  t.onEvent({ kind: 'cell_started', idx: 1, entry: entry('a', 'claude') });
  t.onEvent({
    kind: 'cell_skipped',
    idx: 2,
    entry: entry('b', 'claude'),
    skipped_reason: 'stopped',
  });
  const s = t.snapshot(AT, 4);
  expect(s.done).toBe(1);
  expect(s.running).toEqual(['claude:a']);
  expect(s.queued).toBe(0); // 2 - 1 terminal - 1 running
});

test('HeartbeatTracker ignores cell_queued and batch_done', () => {
  const t = new HeartbeatTracker(1);
  t.onEvent({ kind: 'cell_queued', idx: 1, entry: entry('a', 'claude') });
  t.onEvent({ kind: 'batch_done' });
  const s = t.snapshot(AT, 4);
  expect(s.running).toEqual([]);
  expect(s.done).toBe(0);
  expect(s.queued).toBe(1);
});
