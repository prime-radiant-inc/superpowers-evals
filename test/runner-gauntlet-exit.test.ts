import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose } from '../src/composer.ts';
import {
  type GauntletLayer,
  GauntletProcessExitSchema,
} from '../src/contracts/verdict.ts';
import { getEnv } from '../src/env.ts';
import { gauntletEnvBase } from '../src/runner/gauntlet-env.ts';
import { invokeGauntlet } from '../src/runner/index.ts';
import { gauntletProcessExit } from './fixtures/core-comparison/gauntlet-process.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

// A gauntlet that dies before writing a result still composes as the
// documented synthesized `investigate` layer (-> composer indeterminate), but
// the layer must carry HOW it died: the exit status or signal, and the first
// line of what it said. Without that, a grader that cannot start (an
// unroutable model id, a missing credential) is indistinguishable from an
// agent that ran and left no transcript — the campaign that first hit this
// read "no Claude transcript appeared" for a grader that never launched the
// agent at all.

async function driveMock(fixture: string): Promise<GauntletLayer> {
  const runDir = mkdtempSync(join(tmpdir(), 'run-gexit-'));
  const home = mkdtempSync(join(tmpdir(), 'home-gexit-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-gexit-'));
  const shimDir = mockGauntletDir(fixture);
  try {
    const { gauntlet } = await invokeGauntlet({
      storyPath: join(runDir, 'story.md'),
      targetBinary: 'noop-target',
      runDir,
      launchCwd: cwd,
      runHomeDir: home,
      envBase: gauntletEnvBase({
        PATH: `${shimDir}:${getEnv('PATH') ?? ''}`,
      }),
    });
    // The mock wrote nothing: this is the synthesized path, not a parsed
    // result.json.
    expect(existsSync(join(runDir, 'gauntlet-agent'))).toBe(false);
    return gauntlet;
  } finally {
    for (const dir of [shimDir, runDir, home, cwd]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test('a gauntlet that exits non-zero without a result names the exit and its error line', async () => {
  const gauntlet = await driveMock('startup-error');
  expect(gauntlet.status).toBe('investigate');
  expect(gauntlet.run_id).toBeNull();
  expect(gauntlet.summary).toBe('gauntlet exited 1 without writing a result');
  // Gauntlet's startup errors are one JSON line on stderr; the layer carries
  // the human message, not the envelope.
  expect(gauntlet.reasoning).toBe(
    'Model not supported. Supported prefixes: claude*, gpt*, o1*, o3*',
  );
});

test('a gauntlet killed by a signal without a result names the signal', async () => {
  const gauntlet = await driveMock('killed');
  expect(gauntlet.status).toBe('investigate');
  expect(gauntlet.run_id).toBeNull();
  expect(gauntlet.summary).toBe(
    'gauntlet was killed by SIGKILL without writing a result',
  );
  expect(gauntlet.reasoning).toBe('');
});

test('settled Gauntlet processes preserve exit facts without replacing valid results', async () => {
  const fatal = await gauntletProcessExit({ signal: 'SIGABRT' });
  expect(fatal.process_exit).toEqual({ code: null, signal: 'SIGABRT' });
  expect(fatal.run_id).toBeNull();
  const valid = await gauntletProcessExit({ code: 137, result: 'pass' });
  expect(valid.process_exit).toEqual({ code: 137, signal: null });
  expect(
    compose({
      gauntlet: valid,
      checks: [],
      captureEmpty: false,
      error: null,
      expected: null,
    }).final,
  ).toBe('pass');
  const interrupted = await gauntletProcessExit({ signal: 'SIGTERM' });
  expect(interrupted.process_exit).toEqual({ code: null, signal: 'SIGTERM' });
});

test('Gauntlet process exit evidence rejects incomplete and contradictory facts', () => {
  for (const facts of [
    {},
    { code: null, signal: null },
    { code: 137, signal: 'SIGABRT' },
    { code: -1, signal: null },
    { code: 1.5, signal: null },
    { code: null, signal: 'SIGABRT', stderr: 'not part of this contract' },
  ])
    expect(GauntletProcessExitSchema.safeParse(facts).success).toBe(false);
});
