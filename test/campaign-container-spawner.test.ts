import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../src/agents/command-runner.ts';
import {
  containerNameForAttempt,
  type DockerWaitProcess,
  realDockerWait,
} from '../src/campaign/container-spawner.ts';

const _campaignId = 'c'.repeat(64);
const _evalsSha = 'd'.repeat(40);
const _imageDigest = `sha256:${'b'.repeat(64)}`;
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
