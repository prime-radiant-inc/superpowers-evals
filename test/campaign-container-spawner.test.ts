import { expect, spyOn, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  type DockerWaitProcess,
  realDockerWait,
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

function fakeDockerWaitProcess(
  stdout: string,
  exited: number,
  stderr = '',
): DockerWaitProcess {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(exited),
  };
}

test('realDockerWait asynchronously validates docker wait results', async () => {
  const id = '1'.repeat(64);
  const launch = (stdout: string, exited: number, stderr = '') =>
    realDockerWait(id, () => fakeDockerWaitProcess(stdout, exited, stderr));

  await expect(launch('17\n', 0)).resolves.toBe(17);
  await expect(launch('17\r\n', 0)).resolves.toBe(17);
  const failed = launch('17\n', 2, 'secret=must-not-escape');
  await expect(failed).rejects.toThrow('docker wait failed');
  await failed.catch((error: unknown) => {
    expect(String(error)).not.toContain('secret=must-not-escape');
  });
  await expect(launch('not-a-code\n', 0)).rejects.toThrow(
    /docker wait returned malformed exit code/,
  );
  await expect(launch('-1\n', 0)).rejects.toThrow(
    /docker wait returned malformed exit code/,
  );
  await expect(launch('17\n\n', 0)).rejects.toThrow(
    /docker wait returned malformed exit code/,
  );
  await expect(launch('17', 0)).rejects.toThrow(
    /docker wait returned malformed exit code/,
  );
});

test('realDockerWait starts both pipe drains before waiting for process exit', async () => {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  let stdoutPulled = false;
  let stderrPulled = false;
  const trackedStream = (
    markPulled: () => void,
    contents: string,
  ): ReadableStream<Uint8Array> =>
    new ReadableStream(
      {
        pull(controller) {
          markPulled();
          controller.enqueue(new TextEncoder().encode(contents));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

  const result = realDockerWait('2'.repeat(64), () => ({
    stdout: trackedStream(() => {
      stdoutPulled = true;
    }, '17\n'),
    stderr: trackedStream(() => {
      stderrPulled = true;
    }, ''),
    exited,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stdoutPulled).toBe(true);
  expect(stderrPulled).toBe(true);
  resolveExited(0);
  await expect(result).resolves.toBe(17);
});

test('realDockerWait rejects a process launch failure', async () => {
  await expect(
    realDockerWait('3'.repeat(64), () => {
      throw new Error('launch failed');
    }),
  ).rejects.toThrow('docker wait failed');
});

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

import { ContainerAttemptRuntime } from '../src/campaign/container-spawner.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import type { PreparedExecution } from '../src/contracts/campaign/execution.ts';
import {
  blockActivation,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

function runtimeFixture() {
  const intent = blockActivation(twoArmExperiment()).attempts[0]!;
  const spec = intent.runtime_spec;
  const projectionRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'runtime-credentials-')),
  );
  const credentials = join(projectionRoot, 'credentials.yaml');
  writeFileSync(credentials, '{}\n');
  spec.credential_projection = {
    path: '/run/quorum/credentials.yaml',
    sha256: sha256Hex('{}\n'),
  };
  spec.mounts.push({
    source: credentials,
    target: spec.credential_projection.path,
    mode: 'ro',
  });
  spec.args.push('--credentials-file', spec.credential_projection.path);
  spec.command = '/snapshot/container/attempt-entrypoint.sh';
  spec.entrypoint = ['/usr/bin/timeout'];
  spec.public_env.QUORUM_ATTEMPT_AUTHORITY_FILE =
    '/run/quorum/attempt-authority.json';
  spec.mounts.push({
    source: '/private/control/authority.json',
    target: '/run/quorum/attempt-authority.json',
    mode: 'ro',
  });
  intent.container_name = containerNameForAttempt(
    intent.identity.campaign_id,
    intent.identity.execution_attempt_id,
  );
  intent.runtime_spec_digest = sha256Hex(jcsCanonicalize(spec));
  const prepared: PreparedExecution = { intent };
  let committed = false;
  let admitted = true;
  let cancelled = false;
  let exists = false;
  let startError = false;
  let unknown = false;
  let waitResolve!: (n: number) => void;
  let waitReject!: (e: Error) => void;
  const wait = new Promise<number>((resolve, reject) => {
    waitResolve = resolve;
    waitReject = reject;
  });
  const observed = {
    Id: containerId,
    Name: `/${intent.container_name}`,
    Image: spec.image_digest,
    Path: '/usr/bin/timeout',
    Args: [
      '--signal=TERM',
      '--kill-after=5s',
      `${spec.max_time_s}s`,
      spec.command,
      ...spec.args,
    ],
    Config: {
      Image: spec.image_digest,
      Env: [
        'PATH=/usr/bin',
        ...Object.entries(spec.public_env).map(([k, v]) => `${k}=${v}`),
      ],
      Labels: { ...spec.labels, 'image.label': 'fixed' },
      Entrypoint: ['/usr/bin/timeout'],
      Cmd: [
        '--signal=TERM',
        '--kill-after=5s',
        `${spec.max_time_s}s`,
        spec.command,
        ...spec.args,
      ],
      User: '1000:1000',
      WorkingDir: spec.cwd,
    },
    HostConfig: {
      Init: true,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      PidMode: '',
      IpcMode: 'private',
      Privileged: false,
      SecurityOpt: ['no-new-privileges'],
      Tmpfs: {
        '/run/quorum/attempt': `rw,noexec,nosuid,size=${spec.tmpfs_bytes}`,
        '/tmp': `rw,size=${spec.tmpfs_bytes}`,
      },
      CapAdd: null,
      CapDrop: null,
      Devices: [],
      DeviceRequests: null,
      Binds: null,
      VolumesFrom: null,
      NetworkMode: 'default',
      ReadonlyRootfs: false,
    },
    Mounts: spec.mounts.map((m) => ({
      Type: 'bind',
      Source: m.source,
      Destination: m.target,
      RW: m.mode === 'rw',
      Propagation: 'rprivate',
    })),
    State: {
      Status: 'created',
      Running: false,
      Pid: 0,
      ExitCode: 0,
      Dead: false,
      Restarting: false,
    },
  };
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(command, args, options) {
      expect(command).toBe('docker');
      expect(options?.timeoutMs).toBeGreaterThan(0);
      calls.push([...args]);
      if (args[0] === 'image')
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: spec.image_digest,
              Config: {
                Env: ['PATH=/usr/bin'],
                Labels: { 'image.label': 'fixed' },
                Volumes: null,
                Entrypoint: null,
                Cmd: ['sleep', 'infinity'],
              },
            },
          ]),
          stderr: '',
        };
      if (args[0] === 'create') {
        exists = true;
        return { status: 0, stdout: containerId, stderr: '' };
      }
      if (args[0] === 'start') {
        if (startError) throw new Error('client timeout');
        observed.State.Running = true;
        observed.State.Status = 'running';
        observed.State.Pid = 42;
      }
      if (args[0] === 'stop') {
        observed.State.Running = false;
        observed.State.Status = 'exited';
        observed.State.Pid = 0;
      }
      if (args[0] === 'inspect') {
        if (unknown)
          return { status: 1, stdout: '', stderr: 'daemon unavailable' };
        if (!exists)
          return {
            status: 1,
            stdout: '',
            stderr: `Error: No such object: ${args[1]}`,
          };
        return { status: 0, stdout: JSON.stringify([observed]), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const options = {
    runner,
    dockerWait: () => wait,
    assertCreateAuthorized: () => {
      if (!admitted) throw new Error('intent not committed');
    },
    assertStartAuthorized: () => {
      if (!committed) throw new Error('binding not committed');
      if (cancelled) throw new Error('cancelled');
    },
    startSettlement: () => 'uncertain' as const,
  };
  const runtime = new ContainerAttemptRuntime(options);
  return {
    runtime,
    prepared,
    observed,
    calls,
    runner,
    options,
    commit: () => {
      committed = true;
    },
    denyCreate: () => {
      admitted = false;
    },
    cancel: () => {
      cancelled = true;
    },
    startTimeout: () => {
      startError = true;
    },
    unknown: () => {
      unknown = true;
    },
    resolve: waitResolve,
    reject: waitReject,
  };
}

test('V2 runtime cannot create without committed intent or start without committed binding', async () => {
  const f = runtimeFixture();
  f.denyCreate();
  await expect(f.runtime.create(f.prepared)).rejects.toThrow(
    'intent not committed',
  );
  expect(f.calls.some((c) => c[0] === 'create')).toBe(false);
  const g = runtimeFixture();
  const bound = await g.runtime.create(g.prepared);
  await expect(g.runtime.start(bound)).rejects.toThrow('binding not committed');
  expect(g.calls.some((c) => c[0] === 'start')).toBe(false);
  g.commit();
  g.cancel();
  await expect(g.runtime.start(bound)).rejects.toThrow('cancelled');
});

test('V2 runtime separates monitor failure from death and replays terminal notifications', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  f.commit();
  const monitor = await f.runtime.start(bound);
  f.unknown();
  f.reject(new Error('follower failed'));
  await new Promise((r) => setTimeout(r, 0));
  const deaths: unknown[] = [];
  const failures: string[] = [];
  monitor.onStopped((s) => deaths.push(s));
  monitor.onMonitorFailure((s) => failures.push(s));
  expect(deaths).toHaveLength(0);
  expect(failures).toHaveLength(1);
  expect((await f.runtime.stop(bound, 1)).kind).toBe('unresolved');
});

test('V2 runtime never settles an uncertain start from stopped snapshots or delayed daemon start', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  f.commit();
  f.startTimeout();
  await expect(f.runtime.start(bound)).rejects.toThrow();
  expect((await f.runtime.stop(bound, 1)).kind).toBe('unresolved');
  f.observed.State.Running = true;
  f.observed.State.Status = 'running';
  f.observed.State.Pid = 42;
  expect((await f.runtime.inspectOwned(f.prepared)).kind).toBe('unresolved');
  const recovered = new ContainerAttemptRuntime(f.options);
  expect((await recovered.stop(bound, 1)).kind).toBe('unresolved');
});

test('V2 runtime discovers create-before-binding by full exact specification', async () => {
  const f = runtimeFixture();
  await f.runtime.create(f.prepared);
  const discovery = await new ContainerAttemptRuntime(f.options).inspectOwned(
    f.prepared,
  );
  expect(discovery).toEqual({
    kind: 'matching-created',
    container_id: containerId,
    runtime_spec_digest: f.prepared.intent.runtime_spec_digest,
  });
  f.observed.Config.Env.push('UNEXPECTED=secret');
  expect((await f.runtime.inspectOwned(f.prepared)).kind).toBe('unresolved');
});

test('V2 runtime validates complete configuration and latched namespace death after settled start', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  f.commit();
  const monitor = await f.runtime.start(bound);
  f.observed.State.Running = false;
  f.observed.State.Status = 'exited';
  f.observed.State.Pid = 0;
  f.resolve(0);
  await new Promise((r) => setTimeout(r, 0));
  const deaths: unknown[] = [];
  monitor.onStopped((s) => deaths.push(s));
  expect(deaths).toHaveLength(1);
  expect(await f.runtime.stop(bound, 1)).toMatchObject({
    kind: 'dead',
    stopped: { container_id: containerId, proof: 'inspected_stopped' },
  });
});

test('V2 runtime refuses changed hardening, argv, image defaults and extra mounts before start', async () => {
  for (const mutate of [
    (f: ReturnType<typeof runtimeFixture>) => {
      f.observed.HostConfig.Init = false;
    },
    (f: ReturnType<typeof runtimeFixture>) => {
      f.observed.Config.Cmd.push('extra');
    },
    (f: ReturnType<typeof runtimeFixture>) => {
      f.observed.Config.Env[0] = 'PATH=/evil';
    },
    (f: ReturnType<typeof runtimeFixture>) => {
      f.observed.Mounts.push({
        Type: 'bind',
        Source: '/evil',
        Destination: '/evil',
        RW: true,
        Propagation: 'rprivate',
      });
    },
  ]) {
    const f = runtimeFixture();
    const bound = await f.runtime.create(f.prepared);
    f.commit();
    mutate(f);
    await expect(f.runtime.start(bound)).rejects.toThrow();
    expect(f.calls.some((c) => c[0] === 'start')).toBe(false);
  }
});

test('V2 monitor failure requests a stop without publication or slot release when inspect is unknown', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  f.commit();
  const monitor = await f.runtime.start(bound);
  const publications: unknown[] = [];
  let released = 0;
  let stop: Promise<unknown> | undefined;
  monitor.onStopped((s) => {
    publications.push(s);
    released++;
  });
  monitor.onMonitorFailure(() => {
    stop = f.runtime.stop(bound, 1);
  });
  f.unknown();
  f.reject(new Error('lost follower'));
  await new Promise((r) => setTimeout(r, 0));
  await stop;
  expect(publications).toHaveLength(0);
  expect(released).toBe(0);
  expect(f.calls.filter((c) => c[0] === 'stop')).toHaveLength(1);
});

test('V2 uncertain start remains unresolved when the daemon reports exact absence', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  f.commit();
  f.startTimeout();
  await expect(f.runtime.start(bound)).rejects.toThrow();
  const run = f.runner.run.bind(f.runner);
  f.runner.run = (command, args, options) =>
    args[0] === 'inspect'
      ? { status: 1, stdout: '', stderr: `Error: No such object: ${args[1]}` }
      : run(command, args, options);
  expect((await f.runtime.inspectOwned(f.prepared)).kind).toBe('unresolved');
  expect((await f.runtime.stop(bound, 1)).kind).toBe('unresolved');
});

test('V2 runtime refuses changed selected registry bytes before create and again before start', async () => {
  for (const moment of ['create', 'start']) {
    const f = runtimeFixture();
    const spec = f.prepared.intent.runtime_spec;
    const mount = spec.mounts.find(
      (m) => m.target === spec.credential_projection.path,
    )!;
    const bound =
      moment === 'start' ? await f.runtime.create(f.prepared) : undefined;
    f.commit();
    writeFileSync(mount.source, 'changed: true\n');
    await expect(
      bound ? f.runtime.start(bound) : f.runtime.create(f.prepared),
    ).rejects.toThrow('digest');
    expect(f.calls.some((c) => c[0] === moment)).toBe(false);
  }
});

test('V2 cancellation of a durably unbound creation can establish never-started death', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  const cancellation = new ContainerAttemptRuntime({
    ...f.options,
    startSettlement: () => 'never-issued',
  });
  expect(await cancellation.stop(bound, 1)).toMatchObject({
    kind: 'dead',
    stopped: { container_id: bound.container_id, proof: 'inspected_stopped' },
  });
});

test('V2 Docker inputs place timeout directly beneath init and preserve complete structured overrides', async () => {
  const f = runtimeFixture();
  await f.runtime.create(f.prepared);
  const argv = f.calls.find((c) => c[0] === 'create')!;
  expect(argv).toContain('--init');
  expect(argv).toContain('--restart=no');
  expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/usr/bin/timeout');
  const command = argv.slice(
    argv.indexOf(f.prepared.intent.runtime_spec.image_digest) + 1,
  );
  expect(command.slice(0, 2)).toEqual(['--signal=TERM', '--kill-after=5s']);
  expect(command[2]).toBe(`${f.prepared.intent.runtime_spec.max_time_s}s`);
  expect(command[3]).toBe('/snapshot/container/attempt-entrypoint.sh');
  const env = argv.flatMap((v, i) => (v === '--env' ? [argv[i + 1]] : []));
  expect(env).toContain(
    'QUORUM_ATTEMPT_AUTHORITY_FILE=/run/quorum/attempt-authority.json',
  );
  expect(env).toHaveLength(
    Object.keys(f.prepared.intent.runtime_spec.public_env).length,
  );
});

test('V2 create client failure leaves an exact discoverable creation for cancellation', async () => {
  const f = runtimeFixture();
  const run = f.runner.run.bind(f.runner);
  f.runner.run = (command, args, options) => {
    const result = run(command, args, options);
    if (args[0] === 'create') throw new Error('create client lost');
    return result;
  };
  await expect(f.runtime.create(f.prepared)).rejects.toThrow(
    'create client lost',
  );
  const cancellation = new ContainerAttemptRuntime({
    ...f.options,
    startSettlement: () => 'never-issued',
  });
  const observed = await cancellation.inspectOwned(f.prepared);
  expect(observed).toMatchObject({
    kind: 'matching-created',
    container_id: containerId,
  });
  expect(
    await cancellation.stop({ ...f.prepared, container_id: containerId }, 1),
  ).toMatchObject({ kind: 'dead' });
});

test('V2 monitor isolates throwing subscribers and reports errors without changing latched outcomes', async () => {
  for (const outcome of ['stopped', 'failure'] as const) {
    const f = runtimeFixture();
    const bound = await f.runtime.create(f.prepared);
    f.commit();
    const monitor = await f.runtime.start(bound);
    const delivered: string[] = [];
    const diagnostics: string[] = [];
    const stderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk) => {
        diagnostics.push(String(chunk));
        return true;
      },
    );
    try {
      const subscribe =
        outcome === 'stopped'
          ? (cb: () => void) => monitor.onStopped(cb)
          : (cb: () => void) => monitor.onMonitorFailure(cb);
      const unexpected =
        outcome === 'stopped'
          ? (cb: () => void) => monitor.onMonitorFailure(cb)
          : (cb: () => void) => monitor.onStopped(cb);
      subscribe(() => {
        throw new Error(`${outcome} subscriber error`);
      });
      subscribe(() => {
        delivered.push('second');
      });
      unexpected(() => {
        delivered.push('contradictory');
      });
      if (outcome === 'stopped') {
        f.observed.State.Running = false;
        f.observed.State.Status = 'exited';
        f.observed.State.Pid = 0;
        f.resolve(0);
      } else {
        f.reject(new Error('Docker follower lost'));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(delivered).toEqual(['second']);
      expect(() =>
        subscribe(() => {
          throw { secret: 'subscriber-secret-must-not-escape' };
        }),
      ).not.toThrow();
      subscribe(() => {
        delivered.push('late');
      });
      unexpected(() => {
        delivered.push('late-contradictory');
      });
      expect(delivered).toEqual(['second', 'late']);
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]).toContain(
        `${outcome} notification had 1 throwing subscriber`,
      );
      expect(diagnostics[1]).toContain(
        `${outcome} notification had 1 throwing subscriber`,
      );
      expect(diagnostics.join('')).not.toContain(
        'subscriber-secret-must-not-escape',
      );
      expect(diagnostics.join('')).not.toContain(`${outcome} subscriber error`);
    } finally {
      stderr.mockRestore();
    }
  }
});

test('current runtime termination assertion retains settled-client start uncertainty', async () => {
  const f = runtimeFixture();
  const bound = await f.runtime.create(f.prepared);
  expect(() => f.runtime.assertNoUnsettledStarts()).not.toThrow();
  f.commit();
  f.startTimeout();
  await expect(f.runtime.start(bound)).rejects.toThrow();
  expect(() => f.runtime.assertNoUnsettledStarts()).toThrow(/uncertain/);
});
