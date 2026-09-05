import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { imageDigestOf } from '../src/appliance/campaign-run.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  DETACHED_SPAWN_ACK,
  type DetachedSpawnIdentityCallback,
  detachedWorkerEnv,
  spawnDetachedWorker,
} from '../src/appliance/process.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { EMPTY_CREDENTIAL_SCOPE } from '../src/credentials/scope.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

class ImageRunner implements CommandRunner {
  readonly outputs: string[];
  constructor(...outputs: string[]) {
    this.outputs = [...outputs];
  }
  run(): CommandResult {
    return {
      status: 0,
      stdout: this.outputs.shift() ?? DIGEST,
      stderr: '',
    };
  }
}

function fixture(withJob = true): {
  loaded: LoadedApplianceConfig;
  jobId: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'campaign-worker-')));
  const evals = join(root, 'evals');
  for (const path of [
    evals,
    join(evals, 'campaigns', 'campaign-a'),
    join(root, 'superpowers'),
    join(root, 'gauntlet'),
    join(root, 'credentials', 'blessed'),
    join(root, 'state', 'jobs'),
    join(root, 'state', 'locks'),
    join(root, 'state', 'provenance'),
  ])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    join(root, 'credentials', 'blessed', 'credentials.env'),
    'KEY=secret\n',
  );
  const loaded: LoadedApplianceConfig = {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: evals, remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials', 'blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(evals, 'results'),
      },
      live_spend_lock: join(root, 'live-spend.lock.d'),
    },
    bundle: {
      bundle_id: 'bundle-a',
      rotated_at: '2026-01-01T00:00:00Z',
      providers: [],
    },
    paths: {
      jobs: join(root, 'state', 'jobs'),
      locks: join(root, 'state', 'locks'),
      provenance: join(root, 'state', 'provenance'),
    },
  };
  if (!withJob) return { loaded, jobId: '' };
  const job = createJob(loaded, {
    kind: 'campaign-run',
    superpowersRef: 'e'.repeat(40),
    argv: ['evals-appliance', 'campaign', 'run', 'campaign-a'],
    requester: { agent: null, thread: null, task: null },
    credentialSelection: null,
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    credentialScopeSourceEvalsSha: null,
    campaign: {
      campaign_id: 'campaign-a',
      campaign_dir: join(evals, 'campaigns', 'campaign-a'),
      evals_sha: 'e'.repeat(40),
      helper_sha: 'f'.repeat(40),
      image_ref: 'superpowers-evals:local',
      image_digest: DIGEST,
    },
  });
  return { loaded, jobId: job.job_id };
}

test('imageDigestOf accepts exactly one canonical digest line', () => {
  expect(
    imageDigestOf(new ImageRunner(`${DIGEST}\n`), 'superpowers-evals:local'),
  ).toBe(DIGEST);
});

test('imageDigestOf refuses multiline or noncanonical output', () => {
  expect(() =>
    imageDigestOf(
      new ImageRunner(`${DIGEST}\nextra\n`),
      'superpowers-evals:local',
    ),
  ).toThrow();
  expect(() =>
    imageDigestOf(new ImageRunner('sha256:ABC'), 'superpowers-evals:local'),
  ).toThrow();
  const failed = new ImageRunner(DIGEST);
  failed.run = () => ({ status: 1, stdout: DIGEST, stderr: 'missing' });
  expect(() => imageDigestOf(failed, 'superpowers-evals:local')).toThrow();
});

test('detached worker env carries configured non-secret roots and lock only', () => {
  const fx = fixture();
  const env = detachedWorkerEnv(fx.loaded, fx.jobId, {
    CALLER_ONLY: 'ignored',
    OPENAI_API_KEY: 'secret',
  });
  expect(env['GAUNTLET_ROOT']).toBe(fx.loaded.config.gauntlet.path);
  expect(env['SUPERPOWERS_ROOT']).toBe(fx.loaded.config.superpowers.path);
  expect(env['QUORUM_LIVE_SPEND_LOCK']).toBe(fx.loaded.config.live_spend_lock);
  expect(env['CALLER_ONLY']).toBeUndefined();
  expect(env['OPENAI_API_KEY']).toBeUndefined();
});

test('detached spawn returns pid identity and appends child output to private logs', () => {
  const fx = fixture();
  let unrefCount = 0;
  let stdoutFd = -1;
  let stderrFd = -1;
  const identity = spawnDetachedWorker(
    fx.loaded,
    fx.jobId,
    (_command, _args, options) => {
      const stdio = options?.stdio as [unknown, number, number];
      stdoutFd = stdio[1];
      stderrFd = stdio[2];
      writeSync(stdoutFd, 'stdout-bytes');
      writeSync(stderrFd, 'stderr-bytes');
      return {
        pid: 4242,
        once: () => undefined,
        unref: () => {
          unrefCount += 1;
        },
      } as never;
    },
  );
  const job = readJob(fx.loaded, fx.jobId);
  expect(identity).toEqual({ host_pid: 4242, host_pgid: 4242 });
  expect(unrefCount).toBe(1);
  expect(readFileSync(job.artifacts.stdout_log, 'utf8')).toContain(
    'stdout-bytes',
  );
  expect(readFileSync(job.artifacts.stderr_log, 'utf8')).toContain(
    'stderr-bytes',
  );
  expect(() => writeSync(stdoutFd, 'after-close')).toThrow();
  expect(() => writeSync(stderrFd, 'after-close')).toThrow();
});

test('detached spawn invokes identity persistence before unref', () => {
  const fx = fixture();
  const order: string[] = [];
  const identity = spawnDetachedWorker(
    fx.loaded,
    fx.jobId,
    () =>
      ({
        pid: 4242,
        once: () => undefined,
        unref: () => order.push('unref'),
      }) as never,
    (processInfo) => {
      order.push('callback');
      expect(processInfo).toEqual({ host_pid: 4242, host_pgid: 4242 });
      return DETACHED_SPAWN_ACK;
    },
  );
  expect(identity).toEqual({ host_pid: 4242, host_pgid: 4242 });
  expect(order).toEqual(['callback', 'unref']);
});

test('detached spawn rejects a thenable identity acknowledgement before unref', () => {
  const fx = fixture();
  let unrefCount = 0;
  let terminationCount = 0;
  const child = {
    pid: 4242,
    once: () => undefined,
    unref: () => {
      unrefCount += 1;
    },
  };
  const thenableCallback = ((): Promise<typeof DETACHED_SPAWN_ACK> =>
    Promise.resolve(
      DETACHED_SPAWN_ACK,
    )) as unknown as DetachedSpawnIdentityCallback;
  expect(() =>
    spawnDetachedWorker(
      fx.loaded,
      fx.jobId,
      () => child as never,
      thenableCallback,
      () => {
        terminationCount += 1;
      },
    ),
  ).toThrow('detached worker spawn failed');
  expect(unrefCount).toBe(0);
  expect(terminationCount).toBe(1);
});

test('detached spawn terminates and keeps a referenced child when identity persistence throws', () => {
  const fx = fixture();
  let unrefCount = 0;
  let terminationCount = 0;
  let thrown: unknown;
  try {
    spawnDetachedWorker(
      fx.loaded,
      fx.jobId,
      () =>
        ({
          pid: 4242,
          once: () => undefined,
          unref: () => {
            unrefCount += 1;
          },
        }) as never,
      () => {
        throw new Error('persistence secret');
      },
      () => {
        terminationCount += 1;
      },
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApplianceError);
  expect((thrown as Error).message).toBe('detached worker spawn failed');
  expect((thrown as Error).message).not.toContain('persistence secret');
  expect(unrefCount).toBe(0);
  expect(terminationCount).toBe(1);
});

test('detached spawn records an asynchronous child error without an unhandled event', async () => {
  const fx = fixture();
  let stdoutFd = -1;
  let stderrFd = -1;
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref(): void;
  };
  child.pid = 4242;
  child.unref = () => {};
  spawnDetachedWorker(fx.loaded, fx.jobId, (_command, _args, options) => {
    const stdio = options?.stdio as [unknown, number, number];
    stdoutFd = stdio[1];
    stderrFd = stdio[2];
    queueMicrotask(() => child.emit('error', new Error('hostile raw detail')));
    return child as never;
  });
  updateJob(fx.loaded, fx.jobId, (current) => ({
    ...current,
    status: 'stopping',
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const job = readJob(fx.loaded, fx.jobId);
  expect(job.status).toBe('stopping');
  expect(job.error?.message ?? '').not.toContain('hostile raw detail');
  expect(() => writeSync(stdoutFd, 'after-close')).toThrow();
  expect(() => writeSync(stderrFd, 'after-close')).toThrow();
});

test('detached spawn records a stable asynchronous failure for a nonterminal job', async () => {
  const fx = fixture();
  let stdoutFd = -1;
  let stderrFd = -1;
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref(): void;
  };
  child.pid = 4242;
  child.unref = () => {};
  spawnDetachedWorker(fx.loaded, fx.jobId, (_command, _args, options) => {
    const stdio = options?.stdio as [unknown, number, number];
    stdoutFd = stdio[1];
    stderrFd = stdio[2];
    queueMicrotask(() =>
      child.emit('error', new Error('hostile asynchronous secret')),
    );
    return child as never;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const job = readJob(fx.loaded, fx.jobId);
  expect(job.status).toBe('failed');
  expect(job.error).toEqual({
    code: 'config_invalid',
    step: 'spawn',
    message: 'detached worker spawn failed',
  });
  expect(job.error?.message ?? '').not.toContain('hostile asynchronous secret');
  expect(() => writeSync(stdoutFd, 'after-close')).toThrow();
  expect(() => writeSync(stderrFd, 'after-close')).toThrow();
});

test('detached spawn sanitizes synchronous hostile errors and closes descriptors', () => {
  const fx = fixture();
  let stdoutFd = -1;
  let stderrFd = -1;
  const hostileDetail = 'hostile synchronous secret';
  let thrown: unknown;

  try {
    spawnDetachedWorker(fx.loaded, fx.jobId, (_command, _args, options) => {
      const stdio = options?.stdio as [unknown, number, number];
      stdoutFd = stdio[1];
      stderrFd = stdio[2];
      throw new ApplianceError('config_invalid', 'spawn', hostileDetail);
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ApplianceError);
  expect((thrown as Error).message).toBe('detached worker spawn failed');
  expect((thrown as Error).message).not.toContain(hostileDetail);

  const job = readJob(fx.loaded, fx.jobId);
  const persisted = readFileSync(
    join(fx.loaded.paths.jobs, fx.jobId, 'job.json'),
    'utf8',
  );
  const logs =
    readFileSync(job.artifacts.stdout_log, 'utf8') +
    readFileSync(job.artifacts.stderr_log, 'utf8');
  expect(persisted).not.toContain(hostileDetail);
  expect(logs).not.toContain(hostileDetail);
  expect(() => writeSync(stdoutFd, 'after-close')).toThrow();
  expect(() => writeSync(stderrFd, 'after-close')).toThrow();
});

test('imageDigestOf always bounds its Docker client request', () => {
  let timeout: number | undefined;
  imageDigestOf(
    {
      run(_command, _args, options) {
        timeout = options?.timeoutMs;
        return { status: 0, stdout: `${DIGEST}\n`, stderr: '' };
      },
    },
    'superpowers-evals:local',
  );
  expect(timeout).toBeGreaterThan(0);
  expect(timeout).toBeLessThanOrEqual(30_000);
});
