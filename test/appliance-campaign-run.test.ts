import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import {
  imageDigestOf,
  runCampaignWorker,
} from '../src/appliance/campaign-run.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  cancelJob,
  detachedWorkerEnv,
  dispatchDetachedWorker,
  spawnDetachedWorker,
} from '../src/appliance/process.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { EMPTY_CREDENTIAL_SCOPE } from '../src/credentials/scope.ts';
import { prepareJobRequest } from './appliance-job-fixtures.ts';

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

function fixture(): { loaded: LoadedApplianceConfig; jobId: string } {
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

test('campaign worker runs with one lock and explicit controller seams', async () => {
  const fx = fixture();
  const runner = new ImageRunner(`${DIGEST}\n`);
  const priorLockEnv = Bun.env['QUORUM_LIVE_SPEND_LOCK'];
  let ready = false;
  let credentialsRead = 0;
  let sameSpawner = false;
  await runCampaignWorker(fx.loaded, fx.jobId, runner, {
    runCampaign: async (_dir, opts) => {
      expect(readdirSync(fx.loaded.paths.locks)).toEqual(['run.lock']);
      opts.onReady?.();
      ready = readJob(fx.loaded, fx.jobId).status === 'running';
      const values = opts.credentialEnvReader?.(['KEY']);
      credentialsRead = values?.get('KEY') === 'secret' ? 1 : 0;
      sameSpawner = opts.spawner === opts.containerStop;
      expect(readJob(fx.loaded, fx.jobId).status).toBe('running');
      return 0;
    },
  });
  expect(ready).toBe(true);
  expect(credentialsRead).toBe(1);
  expect(sameSpawner).toBe(true);
  expect(readJob(fx.loaded, fx.jobId).status).toBe('done');
  expect(readdirSync(fx.loaded.paths.locks)).toEqual([]);
  expect(Bun.env['QUORUM_LIVE_SPEND_LOCK']).toBe(priorLockEnv);
});

test('campaign worker never promotes a stopping job during readiness or completion', async () => {
  const fx = fixture();
  let sawStoppingAtReady = false;
  await runCampaignWorker(fx.loaded, fx.jobId, new ImageRunner(`${DIGEST}\n`), {
    runCampaign: async (_dir, opts) => {
      updateJob(fx.loaded, fx.jobId, (current) => ({
        ...current,
        status: 'stopping',
      }));
      opts.onReady?.();
      sawStoppingAtReady = readJob(fx.loaded, fx.jobId).status === 'stopping';
      return 0;
    },
  });
  expect(sawStoppingAtReady).toBe(true);
  expect(readJob(fx.loaded, fx.jobId).status).toBe('stopping');
});

test('campaign worker never replaces a concurrently cancelled job with failed', async () => {
  const fx = fixture();
  const original = new Error('controller failed');
  await expect(
    runCampaignWorker(fx.loaded, fx.jobId, new ImageRunner(`${DIGEST}\n`), {
      runCampaign: async () => {
        updateJob(fx.loaded, fx.jobId, (current) => ({
          ...current,
          status: 'cancelled',
        }));
        throw original;
      },
    }),
  ).rejects.toBe(original);
  expect(readJob(fx.loaded, fx.jobId).status).toBe('cancelled');
});

test('campaign worker resolves its image before taking run.lock', async () => {
  const fx = fixture();
  const runner = new ImageRunner(`${DIGEST}\n`);
  runner.run = () => {
    expect(existsSync(join(fx.loaded.paths.locks, 'run.lock'))).toBe(false);
    return { status: 0, stdout: `${DIGEST}\n`, stderr: '' };
  };
  await runCampaignWorker(fx.loaded, fx.jobId, runner, {
    runCampaign: async () => 0,
  });
});

test('campaign worker records image movement and controller failures without stranding its lock', async () => {
  const moved = fixture();
  await expect(
    runCampaignWorker(
      moved.loaded,
      moved.jobId,
      new ImageRunner(`sha256:${'b'.repeat(64)}\n`),
      {
        runCampaign: async () => 0,
      },
    ),
  ).rejects.toThrow(/image moved/);
  expect(readJob(moved.loaded, moved.jobId).status).toBe('failed');

  const thrown = fixture();
  const original = new Error('controller exploded');
  await expect(
    runCampaignWorker(
      thrown.loaded,
      thrown.jobId,
      new ImageRunner(`${DIGEST}\n`),
      {
        runCampaign: async () => {
          throw original;
        },
      },
    ),
  ).rejects.toBe(original);
  expect(readJob(thrown.loaded, thrown.jobId).status).toBe('failed');
  expect(existsSync(join(thrown.loaded.paths.locks, 'run.lock'))).toBe(false);

  const nonzero = fixture();
  await runCampaignWorker(
    nonzero.loaded,
    nonzero.jobId,
    new ImageRunner(`${DIGEST}\n`),
    {
      runCampaign: async () => 17,
    },
  );
  expect(readJob(nonzero.loaded, nonzero.jobId).status).toBe('failed');
  expect(existsSync(join(nonzero.loaded.paths.locks, 'run.lock'))).toBe(false);
});

test('detached dispatch chooses one worker by persisted kind', async () => {
  const fx = fixture();
  const calls: string[] = [];
  await dispatchDetachedWorker(fx.loaded, fx.jobId, {
    runCampaignWorker: async () => {
      calls.push('campaign');
    },
    runWorker: async () => {
      calls.push('ordinary');
    },
  });
  expect(calls).toEqual(['campaign']);

  const ordinary = createJob(fx.loaded, prepareJobRequest());
  await dispatchDetachedWorker(fx.loaded, ordinary.job_id, {
    runCampaignWorker: async () => {
      calls.push('wrong-campaign');
    },
    runWorker: async () => {
      calls.push('ordinary');
    },
  });
  expect(calls).toEqual(['campaign', 'ordinary']);
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  const job = readJob(fx.loaded, fx.jobId);
  expect(job.status).toBe('failed');
  expect(job.error?.message).not.toContain('hostile raw detail');
  expect(() => writeSync(stdoutFd, 'after-close')).toThrow();
  expect(() => writeSync(stderrFd, 'after-close')).toThrow();
});

test('campaign cancellation settles only on verified controller death', async () => {
  const fx = fixture();
  updateJob(fx.loaded, fx.jobId, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 4242,
      host_pgid: 4242,
      container_pid: null,
      container_pgid: null,
    },
  }));
  let signalled = false;
  const processKill = (pid: number, signal?: NodeJS.Signals | number): void => {
    expect(pid).toBe(-4242);
    if (signal === 'SIGINT') {
      signalled = true;
      return;
    }
    if (signal === 0 && signalled) {
      const error = Object.assign(new Error('gone'), { code: 'ESRCH' });
      throw error;
    }
  };
  const cancelled = await cancelJob(fx.loaded, fx.jobId, new ImageRunner(), {
    graceMs: 10,
    pollIntervalMs: 1,
    processKill,
  });
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.result.summary).toContain('campaign journal');
});

test('campaign cancellation remains stopping when host liveness is unknown', async () => {
  const fx = fixture();
  updateJob(fx.loaded, fx.jobId, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 4242,
      host_pgid: 4242,
      container_pid: null,
      container_pgid: null,
    },
  }));
  const processKill = (
    _pid: number,
    signal?: NodeJS.Signals | number,
  ): void => {
    if (signal === 0)
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };
  const stopping = await cancelJob(fx.loaded, fx.jobId, new ImageRunner(), {
    graceMs: 0,
    pollIntervalMs: 1,
    processKill,
  });
  expect(stopping.status).toBe('stopping');
  expect(stopping.result.summary).toContain('still live');
});
