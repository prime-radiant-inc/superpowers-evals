import { expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import type { ContainerLease } from '../src/appliance/container.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  cancelJob,
  detachedWorkerEnv,
  launchLiveCommand,
  liveCommandArgs,
  runWorker,
} from '../src/appliance/process.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import {
  FIXTURE_LIVE_SCOPE,
  liveJobRequest,
} from './appliance-job-fixtures.ts';

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

// The live Quorum exec is lease-bound: it names the immutable container id it
// was preflighted against and carries the worker-only supervisor env file.
const SUPERVISOR_FILE = '/srv/quorum/state/credentials-scoped/active/x.env';

function liveLease(overrides: Partial<ContainerLease> = {}): ContainerLease {
  return {
    name: 'quorum-appliance',
    id: CONTAINER_ID,
    imageId: 'sha256:img-1',
    mountSignature: 'f'.repeat(64),
    credentialScope: FIXTURE_LIVE_SCOPE,
    ...overrides,
  };
}

test('liveCommandArgs launches quorum in a signalable in-container process group', () => {
  const cfg = loaded();
  const args = liveCommandArgs(
    cfg,
    'job-1',
    ['quorum', 'run-all', '--tier', 'sentinel'],
    liveLease(),
    SUPERVISOR_FILE,
  );
  expect(args.slice(0, 6)).toEqual([
    '--name',
    'quorum-appliance',
    '--expected-container-id',
    CONTAINER_ID,
    '--exec-env-file',
    SUPERVISOR_FILE,
  ]);
  expect(args[6]).toBe('exec');
  expect(args).toContain('bash');
  expect(args.join(' ')).toContain('setsid');
  expect(args.join(' ')).toContain('appliance-pids/job-1.pid');
  expect(args.join(' ')).toContain('quorum run-all --tier sentinel');
  // Never the wrapper's full-bundle argument path.
  expect(args).not.toContain('--env-file');
  expect(args).not.toContain('--auth');
});

test('liveCommandArgs refuses a lease that does not name the configured container', () => {
  const cfg = loaded();
  let caught: unknown = null;
  try {
    liveCommandArgs(
      cfg,
      'job-1',
      ['quorum', 'run'],
      liveLease({ name: 'someone-elses-container' }),
      SUPERVISOR_FILE,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).step).toBe('container');
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
  const runAllArgs = liveCommandArgs(
    cfg,
    'job-run-all',
    ['quorum', 'run-all', '--tier', 'sentinel'],
    liveLease(),
    SUPERVISOR_FILE,
  );
  const singleRunArgs = liveCommandArgs(
    cfg,
    'job-run',
    ['quorum', 'run', 'scenario-a', '--coding-agent', 'claude'],
    liveLease(),
    SUPERVISOR_FILE,
  );

  expect(runAllArgs.join('\n')).toContain(
    'export QUORUM_RUN_ALL_SIGNAL_MODE=detached',
  );
  expect(singleRunArgs.join('\n')).not.toContain(
    'QUORUM_RUN_ALL_SIGNAL_MODE=detached',
  );
});

// --- the live worker runs inside the scoped lease (F13 Task 5) --------------
// runWorker preflights (empty probes, then the scoped live container) and
// hands the supervisor exec env file to exactly one thing: the live Quorum
// exec. Nothing else in the worker ever sees that host path.

const PROBE_ID =
  'ba5eba110000000000000000000000000000000000000000000000000000cafe';
const LIVE_ID =
  'c0de0000000000000000000000000000000000000000000000000000deadbeef';
const RESOLVED_SHA = 'a'.repeat(40);
const RUN_ID = 'writing-plans-gemini-linux-20260818T000000Z-abcd';
const CORPUS_CREDENTIAL = 'gemini_oauth_fx';

const CORPUS_SCOPE = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'gemini',
  runtimeFamily: 'gemini',
  credential: CORPUS_CREDENTIAL,
  agentEnv: [],
  geminiAuthType: 'oauth-personal',
  oauth: { kind: 'gemini', mountName: 'gemini' },
} as const;

// Seed the trusted corpus and blessed bundle the live scope resolves against.
function seedLiveAppliance(cfg: LoadedApplianceConfig): void {
  const evalsPath = cfg.config.evals.path;
  mkdirSync(join(evalsPath, 'coding-agents'), { recursive: true });
  copyFileSync(
    join(resolve(import.meta.dir, '..'), 'coding-agents', 'gemini.yaml'),
    join(evalsPath, 'coding-agents/gemini.yaml'),
  );
  writeFileSync(
    join(evalsPath, 'credentials.yaml'),
    `# minimal corpus-derived registry (name -> record at the top level)\n  ${CORPUS_CREDENTIAL}:\n    model: gemini-2.5-pro\n    api: gemini\n    auth: oauth\n    harnesses: [gemini]\n`,
  );
  const bundle = cfg.config.credential_bundle.path;
  mkdirSync(join(bundle, 'gemini'), { recursive: true });
  writeFileSync(
    join(bundle, 'credentials.env'),
    "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'\n",
  );
  writeFileSync(
    join(bundle, 'gemini/oauth_creds.json'),
    JSON.stringify({ access_token: 'gem-access' }),
  );
  writeFileSync(
    join(bundle, 'gemini/google_accounts.json'),
    JSON.stringify({ accounts: [] }),
  );
  writeFileSync(
    join(cfg.config.container.results_root, `${RUN_ID}-placeholder`),
    '',
  );
  mkdirSync(join(cfg.config.container.results_root, RUN_ID), {
    recursive: true,
  });
  writeFileSync(
    join(cfg.config.container.results_root, RUN_ID, 'verdict.json'),
    JSON.stringify({
      schema: 1,
      final: 'pass',
      final_reason: 'ok',
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
      scenario: 'writing-plans',
      coding_agent: 'gemini',
      started_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: new Date().toISOString(),
    }),
  );
}

// Drives a whole live worker: git plumbing, the docker capability probe, both
// scoped container generations, and the live Quorum exec.
class WorkerRunner implements CommandRunner {
  calls: { command: string; args: readonly string[] }[] = [];
  ups = 0;
  activeDir: string;

  constructor(activeDir: string) {
    this.activeDir = activeDir;
  }

  private mountsFor(id: string) {
    const env = {
      Type: 'bind',
      Source: join(this.activeDir, 'agent.env'),
      Destination: '/run/evals/credentials.env',
      RW: false,
    };
    return id === LIVE_ID
      ? [
          env,
          {
            Type: 'bind',
            Source: join(this.activeDir, 'auth/gemini'),
            Destination: '/auth/gemini',
            RW: false,
          },
        ]
      : [env];
  }

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args });
    if (command === 'docker' && args[0] === 'exec' && args[1] === '--help') {
      return {
        status: 0,
        stdout: 'Usage: docker exec\n  --env-file list\n',
        stderr: '',
      };
    }
    if (
      command === 'docker' &&
      args[0] === 'container' &&
      args[1] === 'inspect'
    ) {
      const target = args[2] ?? '';
      return {
        status: 0,
        stdout: JSON.stringify([
          { Id: target, Image: 'sha256:img-1', Mounts: this.mountsFor(target) },
        ]),
        stderr: '',
      };
    }
    if (command === 'git') {
      if (args.includes('status')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        args.includes('rev-parse') &&
        args.some((arg) => arg.startsWith('refs/tags/main'))
      ) {
        return { status: 1, stdout: '', stderr: 'missing tag\n' };
      }
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: `${RESOLVED_SHA}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    const last = args[args.length - 1] ?? '';
    if (last === 'status') {
      return {
        status: 0,
        stdout:
          this.ups === 0
            ? 'quorum-appliance: missing\n'
            : 'quorum-appliance: exists, running\n',
        stderr: '',
      };
    }
    if (last === 'up') {
      const id = this.ups === 0 ? PROBE_ID : LIVE_ID;
      this.ups += 1;
      return { status: 0, stdout: `${id}\n`, stderr: '' };
    }
    if (args.includes('evals-tool-versions')) {
      return { status: 0, stdout: 'bun 1.3.13\n', stderr: '' };
    }
    if (args.includes('--exec-env-file')) {
      return { status: 0, stdout: `run-id: ${RUN_ID}\n`, stderr: '' };
    }
    return { status: 0, stdout: 'ok\n', stderr: '' };
  }
}

test('runWorker hands the supervisor env file to the live Quorum exec only', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const activeDir = join(cfg.config.root, 'state/credentials-scoped/active');
  const runner = new WorkerRunner(activeDir);
  const job = createJob(
    cfg,
    liveJobRequest('run', {
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'gemini',
      ],
      selection: { agent: 'gemini', credential: CORPUS_CREDENTIAL },
      scope: CORPUS_SCOPE,
      sourceEvalsSha: RESOLVED_SHA,
    }),
  );
  // The in-container process group the live command reports.
  mkdirSync(join(cfg.config.container.results_root, '.appliance-pids'), {
    recursive: true,
  });
  writeFileSync(
    join(
      cfg.config.container.results_root,
      '.appliance-pids',
      `${job.job_id}.pid`,
    ),
    '456\n',
  );

  await runWorker(cfg, job.job_id, runner);

  const supervisor = join(activeDir, 'supervisor.exec.env');
  const withSupervisor = runner.calls.filter((call) =>
    call.args.includes('--exec-env-file'),
  );
  expect(withSupervisor).toHaveLength(1);
  const live = withSupervisor[0];
  expect(live?.args.slice(0, 7)).toEqual([
    '--name',
    'quorum-appliance',
    '--expected-container-id',
    LIVE_ID,
    '--exec-env-file',
    supervisor,
    'exec',
  ]);
  // The probe execs used the probe lease and no supervisor file.
  const probeExecs = runner.calls.filter(
    (call) =>
      call.args.includes('--expected-container-id') &&
      call.args[call.args.indexOf('--expected-container-id') + 1] === PROBE_ID,
  );
  expect(probeExecs).toHaveLength(2);

  const record = readJob(cfg, job.job_id);
  expect(record.status).toBe('done');
  expect(record.container?.id).toBe(LIVE_ID);
  expect(record.credential_scope).toEqual(CORPUS_SCOPE);
  const jobJson = readFileSync(
    join(cfg.paths.jobs, job.job_id, 'job.json'),
    'utf8',
  );
  expect(jobJson).not.toContain(supervisor);
  expect(jobJson).not.toContain('credentials-scoped');
  const provenance = readFileSync(
    join(cfg.paths.provenance, `${job.job_id}.json`),
    'utf8',
  );
  expect(provenance).not.toContain(supervisor);
  expect(JSON.parse(provenance).credential_scope).toEqual(CORPUS_SCOPE);
});

test('cancel sends one fixed SIGINT to the recorded container id only', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, liveJobRequest('run-all'));
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
  const job = createJob(cfg, liveJobRequest('run-all'));
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
  const job = createJob(cfg, liveJobRequest('run-all'));
  markRunning(cfg, job.job_id, { containerId: null });

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(runner.interruptCalls()).toBe(0);
  expect(readJob(cfg, job.job_id).status).toBe('lost');
});

// A record written before the credential triple existed: the fields are
// absent on disk, so the read defaults make the scope null. It cannot execute,
// but safe cancellation still reaches Task 2's fixed recorded-container seam
// without anyone fabricating a runnable lease for it.
function demoteToLegacyRecord(cfg: LoadedApplianceConfig, jobId: string): void {
  const path = join(cfg.paths.jobs, jobId, 'job.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  delete record.credential_selection;
  delete record.credential_scope;
  delete record.credential_scope_source_evals_sha;
  writeFileSync(path, JSON.stringify(record, null, 2));
}

test('cancel of a legacy null-scope record still reaches the recorded-container seam', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, liveJobRequest('run-all'));
  markRunning(cfg, job.job_id);
  demoteToLegacyRecord(cfg, job.job_id);
  expect(readJob(cfg, job.job_id).credential_scope).toBe(null);

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  const interrupt = runner.calls.find((call) =>
    call.args.join(' ').includes('kill -INT'),
  );
  expect(interrupt).toEqual({
    command: 'docker',
    args: ['exec', CONTAINER_ID, 'bash', '-c', 'kill -INT -- -456'],
  });
});

test('cancel of a scoped job with tampered container evidence emits no signal', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.processGroupAlive = true;
  const job = createJob(cfg, liveJobRequest('run-all'));
  markRunning(cfg, job.job_id);
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    container:
      current.container === null
        ? null
        : { ...current.container, mount_signature: '' },
  }));

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(runner.interruptCalls()).toBe(0);
  expect(readJob(cfg, job.job_id).status).toBe('lost');
});

test('cancel records cancelled for a stopped single-run verdict discovered after SIGINT', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(
    cfg,
    liveJobRequest('run', {
      argv: ['quorum', 'run', 'scenario-a', '--coding-agent', 'codex'],
    }),
  );
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
  const job = createJob(
    cfg,
    liveJobRequest('run', {
      argv: ['quorum', 'run', 'scenario-a', '--coding-agent', 'codex'],
    }),
  );
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
  const job = createJob(cfg, liveJobRequest('run-all'));
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
  const job = createJob(cfg, liveJobRequest('run-all'));
  markRunning(cfg, job.job_id);

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('stopping');
  expect(updated.finished_at).toBe(null);
});

test('cancel retry classifies an exited stopping process without sending another SIGINT', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, liveJobRequest('run-all'));
  markRunning(cfg, job.job_id, { status: 'stopping' });

  await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

  expect(readJob(cfg, job.job_id).status).toBe('lost');
  expect(runner.interruptCalls()).toBe(0);
});

test('cancel records cancelled when a terminal batch footer is visible', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, liveJobRequest('run-all'));
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
