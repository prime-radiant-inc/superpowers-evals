import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  type RecordedLifecycleOperation,
  runRecordedContainerLifecycle,
} from '../src/appliance/container.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import type { LoadedApplianceStateConfig } from '../src/appliance/types.ts';

const CURRENT_ID =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

class FakeRunner implements CommandRunner {
  calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];

  inspectId: string | null = CURRENT_ID;
  inspectStatus = 0;
  execResult: CommandResult = { status: 0, stdout: '', stderr: '' };

  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    if (
      command === 'docker' &&
      args[0] === 'container' &&
      args[1] === 'inspect'
    ) {
      if (this.inspectStatus !== 0 || this.inspectId === null) {
        return { status: 1, stdout: '', stderr: 'no such container\n' };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ Id: this.inspectId, Image: 'img-1' }]),
        stderr: '',
      };
    }
    if (command === 'docker' && args[0] === 'exec') {
      return this.execResult;
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

// A structural state config literal — the recorded lifecycle primitive must
// compile and run against a value that carries NO bundle metadata at all.
function stateLoaded(): LoadedApplianceStateConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-cont-')));
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('current-ID probe issues exactly one inspect and one fixed docker exec', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();
  runner.execResult = { status: 0, stdout: '', stderr: '' };

  const result = runRecordedContainerLifecycle(
    loaded,
    runner,
    { name: 'quorum-appliance', id: CURRENT_ID },
    'probe-process-group',
    456,
  );

  expect(result.status).toBe(0);
  expect(runner.calls).toEqual([
    { command: 'docker', args: ['container', 'inspect', 'quorum-appliance'] },
    {
      command: 'docker',
      args: ['exec', CURRENT_ID, 'bash', '-c', 'kill -0 -- -456'],
    },
  ]);
});

test('current-ID interrupt issues the fixed SIGINT exec against the immutable id', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();

  runRecordedContainerLifecycle(
    loaded,
    runner,
    { name: 'quorum-appliance', id: CURRENT_ID },
    'interrupt-process-group',
    456,
  );

  expect(runner.calls[1]).toEqual({
    command: 'docker',
    args: ['exec', CURRENT_ID, 'bash', '-c', 'kill -INT -- -456'],
  });
  // No bundle, env-file, mount, or wrapper arguments anywhere near this seam.
  for (const call of runner.calls) {
    expect(call.command).toBe('docker');
    expect(call.args.join(' ')).not.toContain('--env-file');
    expect(call.args.join(' ')).not.toContain('--auth');
    expect(call.args.join(' ')).not.toContain('evals-container');
    expect(call.options).toBeUndefined();
  }
});

test('a replacement container id is refused after inspect with no exec', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();
  runner.inspectId = 'replacement-id';

  const caught = captureError(() =>
    runRecordedContainerLifecycle(
      loaded,
      runner,
      { name: 'quorum-appliance', id: CURRENT_ID },
      'interrupt-process-group',
      456,
    ),
  );

  expect(caught).toBeInstanceOf(ApplianceError);
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.args).toEqual([
    'container',
    'inspect',
    'quorum-appliance',
  ]);
});

test('a missing or uninspectable configured container is refused with no exec', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();
  runner.inspectStatus = 1;

  const caught = captureError(() =>
    runRecordedContainerLifecycle(
      loaded,
      runner,
      { name: 'quorum-appliance', id: CURRENT_ID },
      'probe-process-group',
      456,
    ),
  );

  expect(caught).toBeInstanceOf(ApplianceError);
  expect(runner.calls).toHaveLength(1);
});

test('invalid identity, pgid, or operation is refused before any runner call', () => {
  const loaded = stateLoaded();
  const invalid: {
    name: string;
    id: string;
    op: RecordedLifecycleOperation;
    pgid: number;
  }[] = [
    // Blank and whitespace-only recorded IDs.
    { name: 'quorum-appliance', id: '', op: 'probe-process-group', pgid: 456 },
    {
      name: 'quorum-appliance',
      id: '   ',
      op: 'interrupt-process-group',
      pgid: 456,
    },
    // Recorded/configured name mismatch.
    {
      name: 'other-container',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 456,
    },
    // Unsafe process group ids.
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 0,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 1,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'interrupt-process-group',
      pgid: -456,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 456.5,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: Number.NaN,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'interrupt-process-group',
      pgid: Number.POSITIVE_INFINITY,
    },
    // A cast unknown operation fails the runtime-exhaustive switch.
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'kill-everything' as RecordedLifecycleOperation,
      pgid: 456,
    },
  ];

  for (const { name, id, op, pgid } of invalid) {
    const runner = new FakeRunner();
    const caught = captureError(() =>
      runRecordedContainerLifecycle(loaded, runner, { name, id }, op, pgid),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
  }
});
