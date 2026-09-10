import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { snapshotConversationOutput } from '../src/capture/output.ts';
import { runPhase } from '../src/checks/index.ts';
import { getEnv } from '../src/env.ts';
import { runSetup } from '../src/setup-step.ts';

const REPO = resolve(import.meta.dir, '..');
const SCENARIO = join(
  import.meta.dir,
  '../scenarios/conversation-config-repair',
);

setDefaultTimeout(15_000);

function preparedOutput(): {
  root: string;
  output: string;
  scratch: string;
  runOracle: () => ReturnType<typeof spawnSync>;
} {
  const root = mkdtempSync(join(tmpdir(), 'config-eval-'));
  const work = join(root, 'work');
  const output = join(root, 'output');
  const scratch = join(root, 'scratch');
  mkdirSync(work);
  mkdirSync(scratch);
  runSetup(SCENARIO, work, {}, { mode: 'none' });
  snapshotConversationOutput(work, output);
  return {
    root,
    output,
    scratch,
    runOracle: () =>
      spawnSync('python3', ['-I', join(SCENARIO, 'oracle.py')], {
        cwd: output,
        env: { PATH: getEnv('PATH') ?? '', TMPDIR: scratch },
        encoding: 'utf8',
        timeout: 15000,
      }),
  };
}

function replaceLoader(output: string, source: string): void {
  writeFileSync(join(output, 'src/configkit/loader.py'), source);
}

const CORRECT_LOADER =
  'import json\nfrom pathlib import Path\ndef load_config(path, overrides=None):\n    return {"retries": 3, "tracing": True} | json.loads(Path(path).read_text()) | (overrides or {})\n';

test('independent config oracle rejects the planted bug and accepts a correct repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'config-eval-'));
  try {
    const scenario = join(
      import.meta.dir,
      '../scenarios/conversation-config-repair',
    );
    const work = join(root, 'work');
    const output = join(root, 'output');
    const scratch = join(root, 'scratch');
    mkdirSync(work);
    mkdirSync(scratch);
    runSetup(scenario, work, {}, { mode: 'none' });
    snapshotConversationOutput(work, output);
    const runOracle = () =>
      spawnSync('python3', ['-I', join(scenario, 'oracle.py')], {
        cwd: output,
        env: { PATH: getEnv('PATH') ?? '', TMPDIR: scratch },
        encoding: 'utf8',
        timeout: 15000,
      });
    expect(runOracle().status).toBe(1);
    writeFileSync(
      join(output, 'src/configkit/loader.py'),
      'import json\nfrom pathlib import Path\ndef load_config(path, overrides=None):\n    return {"retries": 3, "tracing": True} | json.loads(Path(path).read_text()) | (overrides or {})\n',
    );
    expect(runOracle().status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config oracle rejects fixes that preserve zero only or reverse override precedence', () => {
  const fixture = preparedOutput();
  try {
    replaceLoader(
      fixture.output,
      'import json\nfrom pathlib import Path\ndef load_config(path, overrides=None):\n    merged = {"retries": 3, "tracing": True} | json.loads(Path(path).read_text()) | (overrides or {})\n    return {"retries": merged["retries"], "tracing": merged["tracing"] or True}\n',
    );
    expect(fixture.runOracle().status).toBe(1);

    replaceLoader(
      fixture.output,
      'import json\nfrom pathlib import Path\ndef load_config(path, overrides=None):\n    return {"retries": 3, "tracing": True} | (overrides or {}) | json.loads(Path(path).read_text())\n',
    );
    expect(fixture.runOracle().status).toBe(1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('config oracle treats missing, invalid, and early-exiting subject modules as failures', () => {
  const fixture = preparedOutput();
  try {
    const loader = join(fixture.output, 'src/configkit/loader.py');
    rmSync(loader);
    expect(fixture.runOracle().status).toBe(1);

    writeFileSync(loader, 'this is not valid python !\n');
    expect(fixture.runOracle().status).toBe(1);

    writeFileSync(loader, 'raise SystemExit(0)\n');
    expect(fixture.runOracle().status).toBe(1);

    writeFileSync(loader, 'import os\nos._exit(0)\n');
    expect(fixture.runOracle().status).toBe(1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('config oracle confines subject side effects to scratch and ignores editable tests', () => {
  const fixture = preparedOutput();
  try {
    replaceLoader(
      fixture.output,
      `from pathlib import Path\nPath('subject-side-effect').write_text('created')\n${CORRECT_LOADER}`,
    );
    rmSync(join(fixture.output, 'tests'), { recursive: true });
    expect(fixture.runOracle().status).toBe(0);
    expect(existsSync(join(fixture.output, 'subject-side-effect'))).toBe(false);
    expect(existsSync(join(fixture.output, 'tests'))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('config oracle classifies an evaluation child with no start marker as checker failure', () => {
  const fixture = preparedOutput();
  try {
    const fakeRuntime = join(fixture.root, 'no-marker-runtime');
    writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeRuntime, 0o755);
    const checker = join(SCENARIO, 'oracle.py');
    const invokeParent = [
      'import runpy, sys',
      `sys.argv = [${JSON.stringify(checker)}]`,
      `sys.executable = ${JSON.stringify(fakeRuntime)}`,
      `runpy.run_path(${JSON.stringify(checker)}, run_name="__main__")`,
    ].join('\n');
    const result = spawnSync('python3', ['-I', '-c', invokeParent], {
      cwd: fixture.output,
      env: { PATH: getEnv('PATH') ?? '', TMPDIR: fixture.scratch },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status).toBe(127);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('config oracle reports absent scratch as checker failure and propagates subject signals', () => {
  const fixture = preparedOutput();
  try {
    const noScratch = spawnSync(
      'python3',
      ['-I', join(SCENARIO, 'oracle.py')],
      {
        cwd: fixture.output,
        env: { PATH: getEnv('PATH') ?? '' },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(noScratch.status).toBe(127);

    replaceLoader(
      fixture.output,
      'import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n',
    );
    const signalled = fixture.runOracle();
    expect(signalled.status).toBeNull();
    expect(signalled.signal).toBe('SIGTERM');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('config post-check records subject failure but crashes when the checker is unavailable', async () => {
  const fixture = preparedOutput();
  const scenarioCopy = join(fixture.root, 'scenario');
  mkdirSync(scenarioCopy);
  copyFileSync(join(SCENARIO, 'checks.sh'), join(scenarioCopy, 'checks.sh'));
  copyFileSync(join(SCENARIO, 'oracle.py'), join(scenarioCopy, 'oracle.py'));
  try {
    const failed = await runPhase({
      checksSh: join(scenarioCopy, 'checks.sh'),
      phase: 'post',
      workdir: fixture.output,
      repoRoot: REPO,
      scenarioDir: scenarioCopy,
      scratchRoot: fixture.scratch,
    });
    expect(failed.exitCode).toBe(0);
    expect(failed.records).toHaveLength(1);
    expect(failed.records[0]).toMatchObject({
      check: 'command-succeeds',
      passed: false,
    });

    rmSync(join(scenarioCopy, 'oracle.py'));
    const crashed = await runPhase({
      checksSh: join(scenarioCopy, 'checks.sh'),
      phase: 'post',
      workdir: fixture.output,
      repoRoot: REPO,
      scenarioDir: scenarioCopy,
      scratchRoot: fixture.scratch,
    });
    expect(crashed.exitCode).toBe(127);
    expect(crashed.records).toHaveLength(1);
    expect(crashed.records[0]).toMatchObject({
      check: 'command-succeeds',
      passed: false,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 15_000);
