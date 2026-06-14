import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gauntletLayerFromRunDir } from '../src/runner/index.ts';

// Region 2 — gauntlet result-parse tolerance (parity with Python
// _build_gauntlet_layer_from_run_dir / _gauntlet_status_from_run_dir).

function makeRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'rundir-'));
}

function writeResult(runDir: string, runId: string, body: string): void {
  const dir = join(runDir, 'gauntlet-agent', 'results', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), body);
}

test('gauntletLayerFromRunDir returns null when no results dir exists', () => {
  expect(gauntletLayerFromRunDir(makeRunDir())).toBe(null);
});

test('gauntletLayerFromRunDir reads a valid result and uses the DIR NAME as run_id', () => {
  const runDir = makeRunDir();
  // result.json omits runId entirely; run_id must come from the directory name.
  writeResult(
    runDir,
    'gauntlet_20260614T000000_aaaa',
    JSON.stringify({ status: 'pass', summary: 'ok', reasoning: 'because' }),
  );
  const layer = gauntletLayerFromRunDir(runDir);
  expect(layer?.status).toBe('pass');
  expect(layer?.summary).toBe('ok');
  expect(layer?.reasoning).toBe('because');
  expect(layer?.run_id).toBe('gauntlet_20260614T000000_aaaa');
});

test('gauntletLayerFromRunDir coerces an unknown status to investigate', () => {
  const runDir = makeRunDir();
  writeResult(
    runDir,
    'r1',
    JSON.stringify({ status: 'errored', summary: 's', reasoning: 'r' }),
  );
  expect(gauntletLayerFromRunDir(runDir)?.status).toBe('investigate');
});

test('gauntletLayerFromRunDir skips a malformed newest result and falls back to an earlier valid one', () => {
  const runDir = makeRunDir();
  // Lexically-earlier valid candidate, lexically-later malformed candidate.
  writeResult(
    runDir,
    'aaa',
    JSON.stringify({ status: 'fail', summary: 'sf', reasoning: 'rf' }),
  );
  writeResult(runDir, 'zzz', '{ this is not json');
  const layer = gauntletLayerFromRunDir(runDir);
  expect(layer?.status).toBe('fail');
  expect(layer?.run_id).toBe('aaa');
});

test('gauntletLayerFromRunDir returns null when every candidate is malformed', () => {
  const runDir = makeRunDir();
  writeResult(runDir, 'aaa', 'not json');
  writeResult(runDir, 'zzz', '{ also bad');
  expect(gauntletLayerFromRunDir(runDir)).toBe(null);
});

test('gauntletLayerFromRunDir defaults missing summary/reasoning to empty strings', () => {
  const runDir = makeRunDir();
  writeResult(runDir, 'r', JSON.stringify({ status: 'pass' }));
  const layer = gauntletLayerFromRunDir(runDir);
  expect(layer?.summary).toBe('');
  expect(layer?.reasoning).toBe('');
});
