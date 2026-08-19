import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  cancelJob,
  detachedWorkerEnv,
  launchLiveCommand,
  liveCommandArgs,
  runWorker,
} from '../src/appliance/process.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

const CONTAINER_ID =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// Recorded-container fake: liveness and cancellation of recorded containers
// go through docker inspect + one fixed docker exec, never the wrapper.
class FakeRunner implements CommandRunner {
  calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];

  currentContainerId: string | null = CONTAINER_ID;
  processGroupAlive = false;
  cancelSignalFails = false;

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
      if (this.currentContainerId === null) {
        return { status: 1, stdout: '', stderr: 'no such container\n' };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ Id: this.currentContainerId, Image: 'i' }]),
        stderr: '',
      };
    }
    if (command === 'docker' && args[0] === 'exec') {
      const script = args.join(' ');
      if (script.includes('kill -0 -- -456')) {
        return this.processGroupAlive
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      if (script.includes('kill -INT -- -456')) {
        return this.cancelSignalFails
          ? { status: 1, stdout: '', stderr: 'still running\n' }
          : { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected exec\n' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }

  interruptCalls(): number {
    return this.calls.filter((call) =>
      call.args.join(' ').includes('kill -INT'),
    ).length;
  }
}

function loaded(): LoadedApplianceConfig {
  // Canonical (realpath) fixture root: the appliance boundary validates
  // every absolute path component no-follow, and macOS tmpdir paths
  // traverse the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-process-')));
  for (const dir of [
    'superpowers-evals/scripts',
    'superpowers-evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
    'state/jobs',
    'state/locks',
    'state/provenance',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: {
        path: join(root, 'superpowers-evals'),
        remote: 'origin',
        ref: 'main',
      },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'superpowers-evals/results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: '',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

// Mark a job running with a recorded in-container process group AND the
// recorded container identity the safe signal seam verifies against.
function markRunning(
  cfg: LoadedApplianceConfig,
  jobId: string,
  opts: {
    status?: 'running' | 'stopping';
    containerId?: string | null;
  } = {},
): void {
  updateJob(cfg, jobId, (current) => ({
    ...current,
    status: opts.status ?? 'running',
    container:
      opts.containerId === null
        ? null
        : {
            name: 'quorum-appliance',
            id: opts.containerId ?? CONTAINER_ID,
            image_id: null,
            mount_signature: 'sig',
          },
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
  }));
}

test('liveCommandArgs launches quorum in a signalable in-container process group', () => {
  const cfg = loaded();
  const args = liveCommandArgs(cfg, 'job-1', [
    'quorum',
    'run-all',
    '--tier',
    'sentinel',
  ]);
  expect(args).toContain('exec');
  expect(args).toContain('bash');
  expect(args.join(' ')).toContain('setsid');
  expect(args.join(' ')).toContain('appliance-pids/job-1.pid');
  expect(args.join(' ')).toContain('quorum run-all --tier sentinel');
});

test('launchLiveCommand delegates to the injected runner', async () => {
  const runner = new FakeRunner();

  const result = await launchLiveCommand({
    command: 'container',
    args: ['exec', 'quorum', 'run-all'],
    runner,
  });

  expect(result.status).toBe(0);
  expect(result.process.host_pid).toBe(process.pid);
  expect(runner.calls).toEqual([
    {
      command: 'container',
      args: ['exec', 'quorum', 'run-all'],
    },
  ]);
});

test('launchLiveCommand streams stdout and stderr before process close', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const resultPromise = launchLiveCommand({
    command: 'bash',
    args: [
      '-c',
      'printf "ready\\n"; printf "err-ready\\n" >&2; sleep 0.2; printf "done\\n"',
    ],
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => stderr.push(chunk),
  });

  // Poll until the first chunks land rather than guessing a fixed delay: shell
  // startup latency varies by machine (a login shell sourcing a heavy profile
  // can take hundreds of ms). "ready"/"err-ready" are emitted during the 0.2s
  // sleep that precedes "done", so observing them while "done" is still absent
  // proves chunks stream incrementally instead of buffering until close.
  const deadline = Date.now() + 5000;
  while (
    !(
      stdout.join('').includes('ready') && stderr.join('').includes('err-ready')
    )
  ) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for streamed chunks');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(stdout.join('')).not.toContain('done');

  const result = await resultPromise;
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('done');
});

test('detachedWorkerEnv only carries the minimal appliance worker contract', () => {
  const cfg = loaded();
  const env = detachedWorkerEnv(cfg, 'job-7', {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/Users/drew',
    TMPDIR: '/tmp/caller',
    OPENAI_API_KEY: 'sk-test',
    BASH_ENV: '/tmp/evil.sh',
    GIT_CONFIG_GLOBAL: '/tmp/gitconfig',
    EVALS_APPLIANCE_AGENT: 'codex',
  });

  expect(env).toEqual({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: cfg.config.root,
    EVALS_APPLIANCE_CONFIG: cfg.configPath,
    EVALS_APPLIANCE_JOB_ID: 'job-7',
  });
});

test('detachedWorkerEnv falls back to a stable PATH when the caller did not provide one', () => {
  const cfg = loaded();
  const env = detachedWorkerEnv(cfg, 'job-8', {
    HOME: '/Users/drew',
    GIT_DIR: '/tmp/git-dir',
  });

  expect(env).toEqual({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: cfg.config.root,
    EVALS_APPLIANCE_CONFIG: cfg.configPath,
    EVALS_APPLIANCE_JOB_ID: 'job-8',
  });
});

test('launchLiveCommand interrupts the host process group when spawn setup fails', async () => {
  const started = Date.now();

  const result = await launchLiveCommand({
    command: 'bash',
    args: ['-lc', 'sleep 5'],
    onSpawn: () => {
      throw new Error('missing container pid');
    },
  });

  expect(Date.now() - started).toBeLessThan(2000);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('missing container pid');
});

test('liveCommandArgs exports detached signal mode for appliance run-all', () => {
  const cfg = loaded();
  const runAllArgs = liveCommandArgs(cfg, 'job-run-all', [
    'quorum',
    'run-all',
    '--tier',
    'sentinel',
  ]);
  const singleRunArgs = liveCommandArgs(cfg, 'job-run', [
    'quorum',
    'run',
    'scenario-a',
    '--coding-agent',
    'claude',
  ]);

  expect(runAllArgs.join('\n')).toContain(
    'export QUORUM_RUN_ALL_SIGNAL_MODE=detached',
  );
  expect(singleRunArgs.join('\n')).not.toContain(
    'QUORUM_RUN_ALL_SIGNAL_MODE=detached',
  );
});

// Through Tasks 2-4 the detached worker resume path is frozen behind the
// scoped credential cutover guard: it must refuse with the exact typed error
// BEFORE acquiring locks, mutating the job record, or calling the runner.
// Task 5 replaces these expectations with the scoped end-state behavior in
// the same commit that deletes the guard.
test('runWorker refuses with the typed scoped-cutover error', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-6' },
  });

  await expect(runWorker(cfg, job.job_id, runner)).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'scoped-cutover',
    message: expect.stringContaining('scoped credential cutover incomplete'),
  });

  const after = readJob(cfg, job.job_id);
  expect(after.status).toBe('preflighting');
  expect(after.started_at).toBe(null);
  expect(runner.calls).toEqual([]);
  expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
  expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
});

test('cancel sends one fixed SIGINT to the recorded container id only', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  markRunning(cfg, job.job_id);

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  const interrupt = runner.calls.find((call) =>
    call.args.join(' ').includes('kill -INT'),
  );
  expect(interrupt).toEqual({
    command: 'docker',
    args: ['exec', CONTAINER_ID, 'bash', '-c', 'kill -INT -- -456'],
  });
  // The safe signal seam is the ONLY container access: docker inspect/exec,
  // never the wrapper, never bundle env-files or auth mounts.
  for (const call of runner.calls) {
    expect(call.command).toBe('docker');
    expect(call.args.join(' ')).not.toContain('--env-file');
    expect(call.args.join(' ')).not.toContain('--auth');
    expect(call.args.join(' ')).not.toContain('evals-container');
  }
  expect(readJob(cfg, job.job_id).status).toBe('lost');
});

test('cancel of a replaced container emits no signal and reports lost', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.currentContainerId = 'replacement-container-id';
  runner.processGroupAlive = true;
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  markRunning(cfg, job.job_id);

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(runner.interruptCalls()).toBe(0);
  expect(runner.calls.every((call) => call.command === 'docker')).toBe(true);
  expect(readJob(cfg, job.job_id).status).toBe('lost');
});

test('cancel of a job with no recorded container identity emits no signal', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.processGroupAlive = true;
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  markRunning(cfg, job.job_id, { containerId: null });

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(runner.interruptCalls()).toBe(0);
  expect(readJob(cfg, job.job_id).status).toBe('lost');
});

test('cancel records cancelled for a stopped single-run verdict discovered after SIGINT', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run', 'scenario-a', '--coding-agent', 'codex'],
    requester: { agent: null, thread: null, task: null },
  });
  const runId = 'scenario-a-codex-linux-20260618T000000Z-abcd';
  mkdirSync(join(cfg.config.container.results_root, runId), {
    recursive: true,
  });
  writeFileSync(
    join(cfg.config.container.results_root, runId, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'indeterminate',
      final_reason: 'run stopped by SIGINT',
      gauntlet: null,
      checks: [],
      error: { stage: 'stopped', message: 'run stopped by SIGINT' },
      economics: null,
      scenario: 'scenario-a',
      coding_agent: 'codex',
      started_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: new Date().toISOString(),
    }),
  );
  markRunning(cfg, job.job_id);
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    started_at: new Date(Date.now() - 2000).toISOString(),
  }));

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('cancelled');
  expect(updated.artifacts.run_id).toBe(runId);
});

test('cancel records done for a completed single-run verdict discovered after SIGINT', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run',
    superpowersRef: 'main',
    argv: ['quorum', 'run', 'scenario-a', '--coding-agent', 'codex'],
    requester: { agent: null, thread: null, task: null },
  });
  const runId = 'scenario-a-codex-linux-20260618T000000Z-abcd';
  mkdirSync(join(cfg.config.container.results_root, runId), {
    recursive: true,
  });
  writeFileSync(
    join(cfg.config.container.results_root, runId, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      final_reason: 'ok',
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
      scenario: 'scenario-a',
      coding_agent: 'codex',
      started_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: new Date().toISOString(),
    }),
  );
  markRunning(cfg, job.job_id);
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    started_at: new Date(Date.now() - 2000).toISOString(),
  }));

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('done');
  expect(updated.artifacts.run_id).toBe(runId);
});

test('cancel leaves a running job retryable when SIGINT fails and the process is alive', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.cancelSignalFails = true;
  runner.processGroupAlive = true;
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  markRunning(cfg, job.job_id);

  let message = '';
  try {
    await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  const updated = readJob(cfg, job.job_id);
  expect(message).toContain('cancel signal failed');
  expect(updated.status).toBe('running');
});

test('cancel keeps a job stopping when the process group is still alive after grace', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.processGroupAlive = true;
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  markRunning(cfg, job.job_id);

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('stopping');
  expect(updated.finished_at).toBe(null);
});

test('cancel retry classifies an exited stopping process without sending another SIGINT', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  markRunning(cfg, job.job_id, { status: 'stopping' });

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(readJob(cfg, job.job_id).status).toBe('lost');
  expect(runner.interruptCalls()).toBe(0);
});

test('cancel records cancelled when a terminal batch footer is visible', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  writeFileSync(
    join(cfg.config.container.results_root, 'batches/batch-1/batch.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'batch-1',
      started_at: '2026-06-18T00:00:00.000Z',
      finished_at: '2026-06-18T00:01:00.000Z',
      coding_agents: ['codex'],
      jobs: 1,
    }),
  );
  markRunning(cfg, job.job_id);
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      batch_id: 'batch-1',
    },
  }));

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(readJob(cfg, job.job_id).status).toBe('cancelled');
});
