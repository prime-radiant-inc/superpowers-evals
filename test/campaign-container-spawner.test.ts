import { expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  AttemptContainerSpawnError,
  buildAttemptMounts,
  ContainerAttemptSpawner,
  containerNameForAttempt,
} from '../src/campaign/container-spawner.ts';
import type {
  CampaignChildSpec,
  ChildExitInfo,
} from '../src/campaign/spawn.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const campaignId = 'c'.repeat(64);
const evalsSha = 'd'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const containerId = 'f'.repeat(64);

class FakeDocker implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  readonly inspect: { value: unknown } = { value: null };
  readonly results: (() => CommandResult)[] = [];
  createdId = containerId;
  startStatus = 0;
  rmStatus = 0;

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    if (command !== 'docker') return { status: 0, stdout: '', stderr: '' };
    if (this.results.length > 0) return this.results.shift()!();
    switch (args[0]) {
      case 'create':
        return { status: 0, stdout: `${this.createdId}\n`, stderr: '' };
      case 'inspect':
        return {
          status: 0,
          stdout: JSON.stringify([this.inspect.value]),
          stderr: '',
        };
      case 'start':
        return { status: this.startStatus, stdout: '', stderr: 'secret=never' };
      case 'rm':
        return {
          status: this.rmStatus,
          stdout: '',
          stderr: 'rm failed=secret',
        };
      default:
        return { status: 0, stdout: '', stderr: '' };
    }
  }
}

interface FollowHarness {
  readonly attempt: NonNullable<CampaignChildSpec['attempt']>;
  readonly clock: FakeClock;
  readonly runner: FakeDocker;
  readonly child: ReturnType<ContainerAttemptSpawner['spawn']>;
  readonly endWait: (code: unknown) => void;
  readonly tick: () => Promise<void>;
}

function followHarness(
  opts: {
    exitCode?: number;
    oomKilled?: boolean;
    inspectState?: unknown;
    inspectId?: string;
    wait?: Promise<unknown>;
    waitFactory?: () => Promise<unknown>;
  } = {},
): FollowHarness {
  const attemptDir = mkdtempSync(join(tmpdir(), 'spawner-follow-'));
  const attempt = {
    attemptId: 'c1:s:arm_a:r1:a1',
    attemptDir,
    stdoutLog: join(attemptDir, 'stdout.log'),
    stderrLog: join(attemptDir, 'stderr.log'),
    homeDir: join(attemptDir, 'home'),
    entrypoint: '/camp/evals/container/attempt-entrypoint.sh',
    mounts: [],
  } as const;
  writeFileSync(attempt.stdoutLog, '');
  writeFileSync(attempt.stderrLog, '');
  const clock = new FakeClock();
  let endWait: (code: unknown) => void = () => {};
  const waited =
    opts.wait ?? new Promise<unknown>((resolve) => (endWait = resolve));
  const runner = new FakeDocker();
  const id = '1'.repeat(64);
  runner.createdId = id;
  const state = opts.inspectState ?? {
    Running: false,
    ExitCode: opts.exitCode ?? 0,
    OOMKilled: opts.oomKilled ?? false,
    StartedAt: '2026-09-02T00:00:00Z',
    FinishedAt: '2026-09-02T00:01:00Z',
  };
  const inspectRecord = {
    Id: id,
    Name: `/${containerNameForAttempt(campaignId, attempt.attemptId)}`,
    Image: imageDigest,
    Config: {
      Image: imageDigest,
      Labels: {
        'quorum.campaign_id': campaignId,
        'quorum.attempt_id': attempt.attemptId,
        'quorum.evals_sha': evalsSha,
        'quorum.image_digest': imageDigest,
      },
    },
    Mounts: [],
  };
  runner.inspect.value = { ...inspectRecord, State: state };
  runner.results.push(
    () => ({ status: 0, stdout: `${id}\n`, stderr: '' }),
    () => ({
      status: 0,
      stdout: JSON.stringify([inspectRecord]),
      stderr: '',
    }),
    () => ({ status: 0, stdout: '', stderr: '' }),
    () => ({
      status: 0,
      stdout: JSON.stringify([
        { ...inspectRecord, Id: opts.inspectId ?? id, State: state },
      ]),
      stderr: '',
    }),
  );
  const spawner = new ContainerAttemptSpawner({
    runner,
    clock,
    stream: { write: () => {} },
    campaignId,
    campaignDir: '/camp',
    imageRef: 'superpowers-evals:local',
    imageDigest,
    evalsSha,
    bundleDir: '/bundle',
    uid: 1,
    gid: 1,
    dockerWait: () =>
      opts.waitFactory !== undefined
        ? (opts.waitFactory() as Promise<number>)
        : waited.then((code) => code as number),
  });
  const child = spawner.spawn({
    command: 'bun',
    args: [],
    cwd: '/camp/evals',
    env: {},
    attempt,
  });
  const tick = async (): Promise<void> => {
    clock.advance(0.05);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { attempt, clock, runner, child, endWait, tick };
}

function fixture(): {
  readonly runner: FakeDocker;
  readonly spec: CampaignChildSpec;
  readonly expectedMounts: ReturnType<typeof buildAttemptMounts>;
} {
  const attemptDir = mkdtempSync(join(tmpdir(), 'container-spawner-'));
  const expectedMounts = buildAttemptMounts({
    evalsRoot: '/camp/evals',
    gauntletRoot: '/camp/gauntlet',
    binRoot: '/camp/bin',
    superpowersTree: '/camp/superpowers-snapshot',
    attemptDir,
    subjectEnvFile: join(attemptDir, '.stage/subject.env'),
    graderEnvFile: join(attemptDir, '.stage/grader.env'),
    passwdFile: join(attemptDir, '.stage/passwd'),
    groupFile: join(attemptDir, '.stage/group'),
  });
  const attempt = {
    attemptId: 'c1:s:arm_a:r1:a1',
    attemptDir,
    stdoutLog: join(attemptDir, 'stdout.log'),
    stderrLog: join(attemptDir, 'stderr.log'),
    homeDir: join(attemptDir, 'home'),
    entrypoint: '/camp/evals/container/attempt-entrypoint.sh',
    mounts: expectedMounts,
  } as const;
  return {
    runner: new FakeDocker(),
    expectedMounts,
    spec: {
      // The container path intentionally ignores this host command and uses
      // the fixed in-image entrypoint with these dispatcher arguments.
      command: 'bun',
      args: ['/camp/evals/src/cli/index.ts', 'run', 'scenarios/s'],
      cwd: '/camp/evals',
      env: {
        SECRET_SHOULD_NOT_BE_COPIED: 'sk-ant-secret',
        QUORUM_GRADER_API_KEY: 'grader-secret',
      },
      attempt,
    },
  };
}

function makeSpawner(runner: FakeDocker): ContainerAttemptSpawner {
  return new ContainerAttemptSpawner({
    runner,
    clock: new FakeClock(),
    stream: { write: () => {} },
    campaignId,
    campaignDir: '/camp',
    imageRef: 'superpowers-evals:local',
    imageDigest,
    evalsSha,
    bundleDir: '/camp/credential-bundle-secret-path',
    uid: 1000,
    gid: 1000,
  });
}

function inspected(
  attemptId: string,
  mounts: readonly { source: string; target: string; mode: 'ro' | 'rw' }[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Id: containerId,
    Name: `/${containerNameForAttempt(campaignId, attemptId)}`,
    Image: imageDigest,
    Config: {
      Labels: {
        'quorum.campaign_id': campaignId,
        'quorum.attempt_id': attemptId,
        'quorum.evals_sha': evalsSha,
        'quorum.image_digest': imageDigest,
      },
    },
    Mounts: mounts.map((mount) => ({
      Type: 'bind',
      Source: mount.source,
      Destination: mount.target,
      RW: mount.mode === 'rw',
    })),
    ...over,
  };
}

test('creates with pinned digest and immutable identity, verifies, then starts', () => {
  const fx = fixture();
  fx.runner.inspect.value = inspected(
    fx.spec.attempt!.attemptId,
    fx.expectedMounts,
  );

  const child = makeSpawner(fx.runner).spawn(fx.spec);
  const dockerCalls = fx.runner.calls.filter(
    (call) => call.command === 'docker',
  );
  expect(dockerCalls.map((call) => call.args[0])).toEqual([
    'create',
    'inspect',
    'start',
  ]);
  const createArgs = [...dockerCalls[0]!.args];
  const name = containerNameForAttempt(campaignId, fx.spec.attempt!.attemptId);
  expect(createArgs[createArgs.indexOf('--name') + 1]).toBe(name);
  expect(createArgs).toContain(imageDigest);
  expect(createArgs).not.toContain('superpowers-evals:local');
  expect(createArgs).toContain(`quorum.campaign_id=${campaignId}`);
  expect(createArgs).toContain(
    `quorum.attempt_id=${fx.spec.attempt!.attemptId}`,
  );
  expect(createArgs).toContain(`quorum.evals_sha=${evalsSha}`);
  expect(createArgs).toContain(`quorum.image_digest=${imageDigest}`);
  expect(createArgs).toContain('QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1');
  expect(createArgs).toContain(
    `QUORUM_ATTEMPT_DIR=${fx.spec.attempt!.attemptDir}`,
  );
  expect(createArgs).toContain('QUORUM_SUBJECT_FILE=/run/quorum/subject.env');
  expect(createArgs).toContain('QUORUM_GRADER_FILE=/run/quorum/grader.env');
  expect(createArgs).not.toContain('sk-ant-secret');
  expect(createArgs).not.toContain('grader-secret');
  expect(createArgs).not.toContain('/camp/credential-bundle-secret-path');
  expect(child.handle).toEqual({
    kind: 'container',
    containerName: name,
    containerId,
    imageDigest,
  });
});

test('rejects a non-canonical create id before trusting it', () => {
  const fx = fixture();
  fx.runner.createdId = 'ABC' as never;
  expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/container id/i);
  expect(fx.runner.calls.map((call) => call.args[0])).toEqual(['create']);
});

test('removes the exact container and never starts for every identity mismatch', () => {
  const mismatches: Record<string, unknown>[] = [
    { Id: '0'.repeat(64) },
    { Name: '/wrong-name' },
    { Image: `sha256:${'a'.repeat(64)}` },
    {
      Config: {
        Labels: {
          'quorum.campaign_id': 'wrong-campaign',
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.attempt_id': 'other-attempt',
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.evals_sha': 'wrong-sha',
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.image_digest': `sha256:${'a'.repeat(64)}`,
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.campaign_id': campaignId,
          'quorum.attempt_id': 'c1:s:arm_a:r1:a1',
          'quorum.evals_sha': evalsSha,
        },
      },
    },
  ];
  for (const mismatch of mismatches) {
    const fx = fixture();
    fx.runner.inspect.value = inspected(
      fx.spec.attempt!.attemptId,
      fx.expectedMounts,
      mismatch,
    );
    expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(
      /identity|label|image|name/i,
    );
    expect(fx.runner.calls.map((call) => call.args[0])).toEqual([
      'create',
      'inspect',
      'rm',
    ]);
    expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
  }
});

test('rejects the legacy Target/ReadOnly mount shape as malformed', () => {
  const fx = fixture();
  fx.runner.inspect.value = {
    ...inspected(fx.spec.attempt!.attemptId, fx.expectedMounts),
    Mounts: fx.expectedMounts.map((mount) => ({
      Type: 'bind',
      Source: mount.source,
      Target: mount.target,
      ReadOnly: mount.mode === 'ro',
    })),
  };
  expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/mount/i);
  expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
});

test('removes the exact container and never starts for missing, extra, writable, or cross-attempt mounts', () => {
  const fxBase = fixture();
  const expected = fxBase.expectedMounts;
  const cases = [
    expected.slice(1),
    [
      ...expected,
      { source: '/etc/shadow', target: '/leak', mode: 'rw' as const },
    ],
    expected.map((mount, index) =>
      index === 0 ? { ...mount, mode: 'rw' as const } : mount,
    ),
    expected.map((mount, index) =>
      index === 0 ? { ...mount, source: '/camp/attempts/other/source' } : mount,
    ),
    expected.map((mount, index) =>
      index === 0 ? { ...mount, target: '/camp/attempts/other/target' } : mount,
    ),
  ];
  for (const observedMounts of cases) {
    const fx = fixture();
    fx.runner.inspect.value = inspected(
      fx.spec.attempt!.attemptId,
      observedMounts,
    );
    expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/mount/i);
    expect(fx.runner.calls.map((call) => call.args[0])).toEqual([
      'create',
      'inspect',
      'rm',
    ]);
    expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
  }
});

test('removes a created container when start fails', () => {
  const fx = fixture();
  fx.runner.inspect.value = inspected(
    fx.spec.attempt!.attemptId,
    fx.expectedMounts,
  );
  fx.runner.startStatus = 1;
  let thrown: unknown;
  try {
    makeSpawner(fx.runner).spawn(fx.spec);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AttemptContainerSpawnError);
  expect(thrown).toMatchObject({
    containerId,
    cleanup: 'verified-absent',
  });
  expect((thrown as Error).message).toMatch(/start/i);
  expect(fx.runner.calls.map((call) => call.args[0])).toEqual([
    'create',
    'inspect',
    'start',
    'rm',
  ]);
  expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
});

test('reports both the original verification failure and failed exact-ID cleanup', () => {
  const fx = fixture();
  fx.runner.inspect.value = inspected(
    fx.spec.attempt!.attemptId,
    fx.expectedMounts,
    {
      Id: '0'.repeat(64),
    },
  );
  fx.runner.rmStatus = 1;
  let thrown: unknown;
  try {
    makeSpawner(fx.runner).spawn(fx.spec);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AttemptContainerSpawnError);
  expect(thrown).toMatchObject({
    containerId,
    cleanup: 'unverified',
  });
  expect((thrown as Error).message).toMatch(
    /identity.*cleanup|cleanup.*identity/i,
  );
  expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);

  const startFx = fixture();
  startFx.runner.inspect.value = inspected(
    startFx.spec.attempt!.attemptId,
    startFx.expectedMounts,
  );
  startFx.runner.startStatus = 1;
  startFx.runner.rmStatus = 1;
  let startThrown: unknown;
  try {
    makeSpawner(startFx.runner).spawn(startFx.spec);
  } catch (error) {
    startThrown = error;
  }
  expect(startThrown).toBeInstanceOf(AttemptContainerSpawnError);
  expect(startThrown).toMatchObject({
    containerId,
    cleanup: 'unverified',
  });
  expect((startThrown as Error).message).toMatch(
    /start.*cleanup|cleanup.*start/i,
  );
  expect(startFx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
});

async function exitWithin(
  child: ReturnType<ContainerAttemptSpawner['spawn']>,
): Promise<ChildExitInfo> {
  return await Promise.race([
    new Promise<ChildExitInfo>((resolve) => child.onExit(resolve)),
    new Promise<ChildExitInfo>((_, reject) =>
      setTimeout(() => reject(new Error('child did not exit')), 250),
    ),
  ]);
}

test('follows durable logs, latches lines, and replays them to late subscribers', async () => {
  const h = followHarness();
  appendFileSync(h.attempt.stdoutLog, 'run_allocated: run-9\npartial');
  await h.tick();
  appendFileSync(h.attempt.stdoutLog, '-tail\n');
  h.endWait(0);
  await h.tick();
  await h.tick();
  const seen: string[] = [];
  h.child.onStdoutLine((line) => seen.push(line));
  expect(seen).toEqual(['run_allocated: run-9', 'partial-tail']);
  expect(await exitWithin(h.child)).toEqual({ code: 0, signal: null });
  expect(readFileSync(h.attempt.stdoutLog, 'utf8')).toBe(
    'run_allocated: run-9\npartial-tail\n',
  );
});

test('waits for both durable log files, flushes final fragments, and settles once', async () => {
  const h = followHarness();
  appendFileSync(h.attempt.stderrLog, 'err-1\nerr-2');
  const errSeen: string[] = [];
  let exitFired = 0;
  h.child.onStderrLine((line) => errSeen.push(line));
  h.child.onExit(() => {
    exitFired += 1;
  });
  h.endWait(0);
  await h.tick();
  expect(exitFired).toBe(0);
  await h.tick();
  await h.tick();
  expect(errSeen).toEqual(['err-1', 'err-2']);
  expect(exitFired).toBe(1);
  await h.tick();
  expect(exitFired).toBe(1);
});

test('writes exit.json with the inspected exit, OOM flag, and timestamps', async () => {
  const h = followHarness({ exitCode: 137, oomKilled: true });
  writeFileSync(join(h.attempt.attemptDir, 'exit.json'), 'old\n');
  chmodSync(join(h.attempt.attemptDir, 'exit.json'), 0o644);
  h.endWait(137);
  await h.tick();
  await h.tick();
  expect(await exitWithin(h.child)).toEqual({ code: 137, signal: 'SIGKILL' });
  const recorded = JSON.parse(
    readFileSync(join(h.attempt.attemptDir, 'exit.json'), 'utf8'),
  ) as {
    code: number | null;
    signal: string | null;
    oom_killed: boolean;
    started_at: string | null;
    finished_at: string | null;
  };
  expect(recorded).toEqual({
    code: 137,
    signal: 'SIGKILL',
    oom_killed: true,
    started_at: '2026-09-02T00:00:00Z',
    finished_at: '2026-09-02T00:01:00Z',
  });
  expect(statSync(join(h.attempt.attemptDir, 'exit.json')).mode & 0o777).toBe(
    0o600,
  );
  expect(
    readdirSync(h.attempt.attemptDir).filter((name) =>
      name.startsWith('.exit.json.'),
    ),
  ).toEqual([]);
});

test('reports a rejected docker wait as a typed failed exit without hanging', async () => {
  const h = followHarness({
    waitFactory: () => Promise.reject(new Error('wait failed')),
  });
  appendFileSync(h.attempt.stdoutLog, 'durable-before-rejection');
  await h.tick();
  await h.tick();
  const exit = await exitWithin(h.child);
  expect(exit).toEqual({ code: null, signal: null });
  expect(readFileSync(h.attempt.stdoutLog, 'utf8')).toBe(
    'durable-before-rejection',
  );
});

test('reports malformed docker wait output as a failed exit', async () => {
  const h = followHarness({ wait: Promise.resolve('not-a-code') });
  h.endWait(0);
  await h.tick();
  await h.tick();
  expect(await exitWithin(h.child)).toEqual({ code: null, signal: null });
});

test('fails closed when final inspect says the exact container is still running', async () => {
  const h = followHarness({
    inspectState: {
      Running: true,
      ExitCode: 0,
      OOMKilled: false,
      StartedAt: '2026-09-02T00:00:00Z',
      FinishedAt: '',
    },
  });
  h.endWait(0);
  await h.tick();
  await h.tick();
  expect(await exitWithin(h.child)).toEqual({ code: null, signal: null });
  const inspectCalls = h.runner.calls.filter(
    (call) => call.args[0] === 'inspect',
  );
  expect(inspectCalls.at(-1)!.args).toEqual(['inspect', '1'.repeat(64)]);
});

test('fails closed when final inspect returns a stopped state for another container', async () => {
  const h = followHarness({ inspectId: '2'.repeat(64) });
  h.endWait(0);
  await h.tick();
  await h.tick();
  expect(await exitWithin(h.child)).toEqual({ code: null, signal: null });
});

class StopDocker implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  readonly inspectResults: (() => CommandResult)[] = [];
  running = true;
  readonly id: string;
  stopResult: CommandResult = { status: 0, stdout: '', stderr: '' };
  killResult: CommandResult = { status: 0, stdout: '', stderr: '' };
  killStops = true;
  stopCount = 0;
  killCount = 0;

  constructor(id: string) {
    this.id = id;
  }

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    if (command !== 'docker') return { status: 0, stdout: '', stderr: '' };
    switch (args[0]) {
      case 'stop':
        this.stopCount += 1;
        return this.stopResult;
      case 'kill':
        this.killCount += 1;
        if (this.killResult.status === 0 && this.killStops)
          this.running = false;
        return this.killResult;
      case 'inspect':
        return (
          this.inspectResults.shift()?.() ?? {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: this.id,
                State: {
                  Running: this.running,
                  ExitCode: 0,
                  OOMKilled: false,
                  StartedAt: 's',
                  FinishedAt: this.running ? '' : 'f',
                },
              },
            ]),
            stderr: '',
          }
        );
      default:
        return { status: 0, stdout: '', stderr: '' };
    }
  }
}

function stopSpawner(
  runner: StopDocker,
  clock: FakeClock,
  writes: string[] = [],
): ContainerAttemptSpawner {
  return new ContainerAttemptSpawner({
    runner,
    clock,
    stream: { write: (value) => writes.push(value) },
    campaignId,
    campaignDir: '/camp',
    imageRef: 'r',
    imageDigest,
    evalsSha,
    bundleDir: '/bundle',
    uid: 1,
    gid: 1,
  });
}

async function settleStop(
  verdict: Promise<'dead' | 'alive'>,
  clock: FakeClock,
): Promise<'dead' | 'alive'> {
  let settled = false;
  const result = verdict.then((value) => {
    settled = true;
    return value;
  });
  for (let i = 0; i < 200 && !settled; i += 1) {
    await Promise.resolve();
    if (settled) break;
    const next = clock.earliestWaiter();
    clock.setTo(next ?? clock.now() + 0.05);
  }
  return await result;
}

test('stop refuses a non-canonical container identifier before Docker access', async () => {
  const runner = new StopDocker('1'.repeat(64));
  runner.running = false;
  const clock = new FakeClock();

  await expect(
    stopSpawner(runner, clock).stopContainer('short-id', 1),
  ).rejects.toThrow(/canonical full container id/i);
  expect(runner.calls).toEqual([]);
});

test('stop exposes the ContainerStopper interface through the exact-ID routine', async () => {
  const id = '2'.repeat(64);
  const runner = new StopDocker(id);
  runner.running = false;
  const clock = new FakeClock();

  expect(await settleStop(stopSpawner(runner, clock).stop(id, 1), clock)).toBe(
    'dead',
  );
});

test('stop requests graceful exact-ID termination, escalates, and verifies death without tmux', async () => {
  const id = '9'.repeat(64);
  const runner = new StopDocker(id);
  const clock = new FakeClock();
  const verdict = stopSpawner(runner, clock).stopContainer(id, 1);

  expect(await settleStop(verdict, clock)).toBe('dead');
  expect(runner.calls.map((call) => call.args[0])).toEqual([
    'stop',
    ...Array.from({ length: 21 }, () => 'inspect'),
    'kill',
    'inspect',
  ]);
  expect(runner.calls[0]!.args).toEqual(['stop', '--time', '1', id]);
  expect(runner.calls[22]!.args).toEqual(['kill', id]);
  expect(
    runner.calls
      .filter((call) => call.args[0] === 'inspect')
      .every((call) => call.args[1] === id),
  ).toBe(true);
  expect(runner.calls.some((call) => call.command === 'tmux')).toBe(false);
});

test('stop accepts an exact stopped inspect as verified death without KILL', async () => {
  const id = 'a'.repeat(64);
  const runner = new StopDocker(id);
  runner.running = false;
  const clock = new FakeClock();

  expect(
    await settleStop(stopSpawner(runner, clock).stopContainer(id, 5), clock),
  ).toBe('dead');
  expect(runner.killCount).toBe(0);
  expect(
    runner.calls.filter((call) => call.args[0] === 'inspect'),
  ).toHaveLength(1);
});

test('stop treats an exact inspect absence as already dead', async () => {
  const id = 'b'.repeat(64);
  const runner = new StopDocker(id);
  runner.stopResult = {
    status: 1,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${id}`,
  };
  runner.inspectResults.push(() => ({
    status: 1,
    stdout: '',
    stderr: `Error: No such object: ${id}`,
  }));
  const clock = new FakeClock();

  expect(
    await settleStop(stopSpawner(runner, clock).stopContainer(id, 5), clock),
  ).toBe('dead');
  expect(runner.killCount).toBe(0);
});

test('stop never treats malformed or mismatched inspect as proof of death', async () => {
  const id = 'c'.repeat(64);
  const runner = new StopDocker(id);
  runner.inspectResults.push(
    () => ({ status: 0, stdout: '{malformed', stderr: '' }),
    () => ({
      status: 0,
      stdout: JSON.stringify([
        {
          Id: 'd'.repeat(64),
          State: {
            Running: false,
            ExitCode: 0,
            OOMKilled: false,
            StartedAt: 's',
            FinishedAt: 'f',
          },
        },
      ]),
      stderr: '',
    }),
  );
  const clock = new FakeClock();

  expect(
    await settleStop(stopSpawner(runner, clock).stopContainer(id, 0.1), clock),
  ).toBe('dead');
  expect(runner.killCount).toBe(1);
  expect(
    runner.calls
      .filter((call) => call.args[0] === 'inspect')
      .every((call) => call.args[1] === id),
  ).toBe(true);
});

test('stop reports alive after bounded verification when KILL fails and the container survives', async () => {
  const id = 'e'.repeat(64);
  const runner = new StopDocker(id);
  runner.killResult = {
    status: 1,
    stdout: '',
    stderr: 'permission denied',
  };
  const clock = new FakeClock();
  const writes: string[] = [];

  expect(
    await settleStop(
      stopSpawner(runner, clock, writes).stopContainer(id, 0.1),
      clock,
    ),
  ).toBe('alive');
  expect(runner.killCount).toBe(1);
  expect(runner.calls.filter((call) => call.args[0] === 'inspect').length).toBe(
    6,
  );
  expect(writes.join('')).toMatch(/FAILED/);
  expect(writes.join('')).toContain(id);
});

test('stop does not infer absence from unrelated stop or inspect stderr', async () => {
  const id = 'f'.repeat(64);
  const runner = new StopDocker(id);
  runner.stopResult = {
    status: 1,
    stdout: '',
    stderr: 'No such container: other-container',
  };
  runner.inspectResults.push(() => ({
    status: 1,
    stdout: '',
    stderr: 'No such object: other-container',
  }));
  runner.killResult = {
    status: 1,
    stdout: '',
    stderr: 'No such container: other-container',
  };
  const clock = new FakeClock();
  const writes: string[] = [];

  expect(
    await settleStop(
      stopSpawner(runner, clock, writes).stopContainer(id, 0.1),
      clock,
    ),
  ).toBe('alive');
  expect(runner.killCount).toBe(1);
  expect(writes.join('')).toMatch(/docker stop .*failed/);
  expect(writes.join('')).toMatch(/docker kill .*failed/);
});

test('stop reports alive when a successful KILL still leaves the exact container running', async () => {
  const id = '0'.repeat(64);
  const runner = new StopDocker(id);
  runner.killStops = false;
  const clock = new FakeClock();
  const writes: string[] = [];

  expect(
    await settleStop(
      stopSpawner(runner, clock, writes).stopContainer(id, 0.1),
      clock,
    ),
  ).toBe('alive');
  expect(runner.killCount).toBe(1);
  expect(writes.join('')).toMatch(/verify-death FAILED/);
});
