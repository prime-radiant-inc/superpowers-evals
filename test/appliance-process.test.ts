import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
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
  launchLiveCommand,
  liveCommandArgs,
  runWorker,
} from '../src/appliance/process.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

class FakeRunner implements CommandRunner {
  calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];

  liveResult: CommandResult = {
    status: 0,
    stdout: 'artifacts: results/batches/batch-1\n',
    stderr: '',
  };
  onLiveCommand?: () => void;
  dirtyAfterLiveCommand = false;
  private liveCommandSeen = false;
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
    if (command === 'git' && args.includes('status')) {
      if (this.dirtyAfterLiveCommand && this.liveCommandSeen) {
        return { status: 0, stdout: ' M mutated.txt\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'git' &&
      args.includes('rev-parse') &&
      args.some((arg) => arg.startsWith('refs/tags/'))
    ) {
      return { status: 1, stdout: '', stderr: 'missing tag\n' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('cat-file')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command.endsWith('scripts/evals-container') &&
      args.includes('status')
    ) {
      return {
        status: 0,
        stdout: 'quorum-appliance: exists, running\n',
        stderr: '',
      };
    }
    if (
      command.endsWith('scripts/evals-container') &&
      args.join(' ').includes('kill -0 -456')
    ) {
      return this.processGroupAlive
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    }
    if (
      command.endsWith('scripts/evals-container') &&
      args.join(' ').includes('kill -INT -456')
    ) {
      return this.cancelSignalFails
        ? { status: 1, stdout: '', stderr: 'still running\n' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (
      command.endsWith('scripts/evals-container') &&
      args.join(' ').includes('setsid')
    ) {
      this.liveCommandSeen = true;
      this.onLiveCommand?.();
      return this.liveResult;
    }
    if (
      command.endsWith('scripts/evals-container') &&
      args.includes('exec') &&
      args.includes('evals-tool-versions')
    ) {
      return { status: 0, stdout: 'bun 1.3.11\n', stderr: '' };
    }
    if (
      command.endsWith('scripts/evals-container') &&
      args.includes('exec') &&
      args.includes('quorum')
    ) {
      return { status: 0, stdout: 'ok\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-process-'));
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

function writePid(cfg: LoadedApplianceConfig, jobId: string, pid = 456): void {
  const pidDir = join(cfg.config.container.results_root, '.appliance-pids');
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, `${jobId}.pid`), `${pid}\n`);
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
      '-lc',
      'printf "ready\\n"; printf "err-ready\\n" >&2; sleep 0.2; printf "done\\n"',
    ],
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => stderr.push(chunk),
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(stdout.join('')).toContain('ready');
  expect(stderr.join('')).toContain('err-ready');

  const result = await resultPromise;
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('done');
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

test('runWorker preflights, runs live command, records artifacts, and releases locks', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-6' },
  });
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  writePid(cfg, job.job_id);
  let liveLockRefs: unknown = null;
  runner.onLiveCommand = () => {
    liveLockRefs = JSON.parse(
      readFileSync(join(cfg.paths.locks, 'run.lock/lock.json'), 'utf8'),
    ).refs;
  };

  await runWorker(cfg, job.job_id, runner);

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('done');
  expect(updated.artifacts.batch_id).toBe('batch-1');
  expect(updated.result).toEqual({
    exit_code: 0,
    summary: 'live command completed',
  });
  expect(updated.process?.host_pid).toBe(process.pid);
  expect(liveLockRefs).toEqual(updated.refs);
  expect(
    statSync(join(cfg.config.container.results_root, '.appliance-pids')).mode &
      0o777,
  ).toBe(0o700);
  expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
  expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
  expect(
    existsSync(
      join(
        cfg.config.container.results_root,
        'batches/batch-1/appliance-provenance.json',
      ),
    ),
  ).toBe(true);
  expect(readFileSync(updated.artifacts.stdout_log, 'utf8')).toContain(
    'artifacts: results/batches/batch-1',
  );
});

test('runWorker throws and leaves a quarantined record when postflight finds a dirty repo', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.dirtyAfterLiveCommand = true;
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-6' },
  });
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  writePid(cfg, job.job_id);

  await expect(runWorker(cfg, job.job_id, runner)).rejects.toMatchObject({
    code: 'repo_dirty',
    message: `dirty worktree at ${cfg.config.evals.path}: M mutated.txt`,
  });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('quarantined');
  expect(updated.finished_at).not.toBe(null);
  expect(updated.result).toEqual({
    exit_code: 0,
    summary: `postflight dirty check failed: dirty worktree at ${cfg.config.evals.path}: M mutated.txt`,
  });
  expect(updated.error).toMatchObject({
    code: 'repo_dirty',
    message: `dirty worktree at ${cfg.config.evals.path}: M mutated.txt`,
  });
  expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
  expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
});

test('runWorker fails when a nonzero live command only created a batch shell', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.liveResult = {
    status: 1,
    stdout: 'batch batch-1\nartifacts: results/batches/batch-1\n',
    stderr: 'boom\n',
  };
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-6' },
  });
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  writePid(cfg, job.job_id);

  await runWorker(cfg, job.job_id, runner);

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('failed');
  expect(updated.result).toEqual({
    exit_code: 1,
    summary: 'live command exited 1',
  });
});

test('runWorker fails a successful live command without a captured container process group', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-6' },
  });
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });

  await runWorker(cfg, job.job_id, runner);

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('failed');
  expect(updated.result.summary).toBe('container process id was not captured');
  expect(updated.process?.container_pgid).toBe(null);
});

test('cancel sends SIGINT to the recorded in-container process group', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
  }));
  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });
  expect(
    runner.calls.some((call) => call.args.join(' ').includes('kill -INT -456')),
  ).toBe(true);
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
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    started_at: new Date(Date.now() - 2000).toISOString(),
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
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
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    started_at: new Date(Date.now() - 2000).toISOString(),
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
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
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
  }));

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
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
  }));

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
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'stopping',
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
  }));

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(readJob(cfg, job.job_id).status).toBe('lost');
  expect(
    runner.calls.some((call) => call.args.join(' ').includes('kill -INT -456')),
  ).toBe(false);
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
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    process: {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    },
    artifacts: {
      ...current.artifacts,
      batch_id: 'batch-1',
    },
  }));

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(readJob(cfg, job.job_id).status).toBe('cancelled');
});
