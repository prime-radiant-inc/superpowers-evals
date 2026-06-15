import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killGauntletTmuxForRun } from '../src/runner/index.ts';

// A-kill-gauntlet-tmux: globs <runDir>/gauntlet-agent/results/*/scratch and
// hands the last one to killRunTmuxServer (parity with Python
// _kill_gauntlet_tmux_for_run). The kill itself is injected so the test stays
// hermetic (no real tmux).

test('killGauntletTmuxForRun passes the run scratch dir to the killer', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const scratch = join(runDir, 'gauntlet-agent', 'results', 'r1', 'scratch');
  mkdirSync(scratch, { recursive: true });

  const killed: string[] = [];
  const result = killGauntletTmuxForRun(runDir, (dir) => {
    killed.push(dir);
    return true;
  });
  expect(result).toBe(true);
  expect(killed).toEqual([scratch]);
});

test('killGauntletTmuxForRun returns false when no scratch dir exists', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  mkdirSync(join(runDir, 'gauntlet-agent', 'results'), { recursive: true });
  let called = false;
  const result = killGauntletTmuxForRun(runDir, () => {
    called = true;
    return true;
  });
  expect(result).toBe(false);
  expect(called).toBe(false);
});

test('killGauntletTmuxForRun picks the last scratch dir when several exist', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const a = join(runDir, 'gauntlet-agent', 'results', 'aaa', 'scratch');
  const z = join(runDir, 'gauntlet-agent', 'results', 'zzz', 'scratch');
  mkdirSync(a, { recursive: true });
  mkdirSync(z, { recursive: true });
  const killed: string[] = [];
  killGauntletTmuxForRun(runDir, (dir) => {
    killed.push(dir);
    return true;
  });
  expect(killed).toEqual([z]);
});
