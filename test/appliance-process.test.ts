import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
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
import type {
  JobRecord,
  LoadedApplianceConfig,
} from '../src/appliance/types.ts';
import { EMPTY_CREDENTIAL_SCOPE } from '../src/credentials/scope.ts';
import {
  FIXTURE_LIVE_SCOPE,
  FIXTURE_LIVE_SELECTION,
  importJobRequest,
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

  // Liveness probes: the ONLY way a job asks whether its recorded in-container
  // process group is still alive.
  probeCalls(): number {
    return this.calls.filter((call) => call.args.join(' ').includes('kill -0'))
      .length;
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
      live_spend_lock: join(root, 'live-spend.lock.d'),
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

// The exact commands the CLI generates for the fixture cell
// (codex x codex_sub). The live exec seam takes the job RECORD, so the command
// it launches is always re-derived against that record's own kind and
// selection rather than trusted because an argv was handed in.
const LEGAL_RUN_ARGV: readonly string[] = [
  'quorum',
  'run',
  'scenarios/writing-plans',
  '--coding-agent',
  'codex',
  '--credential',
  'codex_sub',
];
const LEGAL_RUN_ALL_ARGV: readonly string[] = [
  'quorum',
  'run-all',
  '--coding-agents',
  'codex',
  '--credentials',
  'codex_sub',
];

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

// A persisted live job carrying a real record, so the command seam reads the
// same authority production does.
function liveRecord(
  cfg: LoadedApplianceConfig,
  kind: 'run' | 'run-all',
  argv: readonly string[],
  options: Parameters<typeof liveJobRequest>[1] = {},
): JobRecord {
  return createJob(cfg, liveJobRequest(kind, { argv, ...options }));
}

// An out-of-band rewrite of the durable record. The credential triple is
// immutable through updateJob, so a scope re-point can only arrive this way:
// a hand-edited, restored, or corrupted job.json underneath a running worker.
function rewriteJobRecordRaw(
  cfg: LoadedApplianceConfig,
  jobId: string,
  patch: Record<string, unknown>,
): void {
  const path = join(cfg.paths.jobs, jobId, 'job.json');
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(path, JSON.stringify({ ...record, ...patch }));
}

// Rewrites only the durable command, the way a tampered or hand-edited record
// would.
function tamperCommand(
  cfg: LoadedApplianceConfig,
  jobId: string,
  argv: readonly string[],
): JobRecord {
  return updateJob(cfg, jobId, (current) => ({
    ...current,
    command: { ...current.command, argv: [...argv] },
  }));
}

// A live record already bound to the lease its preflight attested. The live
// exec re-proves that binding against the record it rereads, so any case that
// is meant to get past it has to state both halves.
function leaseBoundRecord(
  cfg: LoadedApplianceConfig,
  kind: 'run' | 'run-all',
  argv: readonly string[],
  options: {
    readonly lease?: ContainerLease;
    readonly request?: Parameters<typeof liveJobRequest>[1];
  } = {},
): JobRecord {
  const lease = options.lease ?? liveLease();
  const job = liveRecord(cfg, kind, argv, options.request ?? {});
  return updateJob(cfg, job.job_id, (current) => ({
    ...current,
    container: {
      name: lease.name,
      id: lease.id,
      image_id: lease.imageId,
      mount_signature: lease.mountSignature,
    },
  }));
}

test('liveCommandArgs launches quorum in a signalable in-container process group', () => {
  const cfg = loaded();
  const job = leaseBoundRecord(cfg, 'run-all', [
    ...LEGAL_RUN_ALL_ARGV,
    '--tier',
    'sentinel',
  ]);
  const args = liveCommandArgs(cfg, job, liveLease(), SUPERVISOR_FILE);
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
  expect(args.join(' ')).toContain(`appliance-pids/${job.job_id}.pid`);
  expect(args.join(' ')).toContain(
    'quorum run-all --coding-agents codex --credentials codex_sub --tier sentinel',
  );
  // Never the wrapper's full-bundle argument path.
  expect(args).not.toContain('--env-file');
  expect(args).not.toContain('--auth');
});

test('liveCommandArgs refuses a lease that does not name the configured container', () => {
  const cfg = loaded();
  // Bound to that lease, so the refusal is the lease-vs-config check rather
  // than the record-vs-lease one.
  const lease = liveLease({ name: 'someone-elses-container' });
  const job = leaseBoundRecord(cfg, 'run', LEGAL_RUN_ARGV, { lease });
  let caught: unknown = null;
  try {
    liveCommandArgs(cfg, job, lease, SUPERVISOR_FILE);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).step).toBe('container');
});

// --- the live command is the job's OWN Quorum command (F13 Task 5) ----------
// command.argv is durable, mutable job state, and this exec is the single
// place the worker-only supervisor env file crosses into a process. A record
// naming any other program, subcommand, or (agent, credential) cell must be
// refused typed at that attachment point, never launched with the selected
// credential's environment attached.

test('liveCommandArgs refuses every command that is not this record kind Quorum command', () => {
  const cfg = loaded();
  const refused: readonly {
    readonly what: string;
    readonly kind: 'run' | 'run-all';
    readonly argv: readonly string[];
  }[] = [
    { what: 'a bare environment dump', kind: 'run', argv: ['env'] },
    { what: 'an empty command', kind: 'run', argv: [] },
    {
      what: 'a shell reading the projected credential file',
      kind: 'run',
      argv: ['bash', '-lc', 'cat /run/evals/credentials.env'],
    },
    { what: 'quorum with no subcommand', kind: 'run', argv: ['quorum'] },
    {
      what: 'quorum run with no scenario',
      kind: 'run',
      argv: ['quorum', 'run'],
    },
    {
      what: 'quorum run whose scenario slot is an option',
      kind: 'run',
      argv: ['quorum', 'run', '--coding-agent', 'codex'],
    },
    {
      // Submission normalizes every scenario to a path under the trusted
      // scenarios root; an absolute one never came from that normalizer.
      what: 'quorum run naming an absolute path',
      kind: 'run',
      argv: [
        'quorum',
        'run',
        '/etc',
        '--coding-agent',
        'codex',
        '--credential',
        'codex_sub',
      ],
    },
    {
      what: 'quorum run escaping the scenarios root',
      kind: 'run',
      argv: [
        'quorum',
        'run',
        'scenarios/../../etc',
        '--coding-agent',
        'codex',
        '--credential',
        'codex_sub',
      ],
    },
    {
      what: 'quorum run omitting the selected credential',
      kind: 'run',
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'codex',
      ],
    },
    {
      what: 'quorum run naming another agent',
      kind: 'run',
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'claude',
        '--credential',
        'codex_sub',
      ],
    },
    {
      what: 'quorum run naming another credential',
      kind: 'run',
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'codex',
        '--credential',
        'opus',
      ],
    },
    {
      what: 'quorum run with a trailing extra argument',
      kind: 'run',
      argv: [...LEGAL_RUN_ARGV, '--out-root', '/tmp/elsewhere'],
    },
    {
      what: 'a run record carrying the run-all command',
      kind: 'run',
      argv: LEGAL_RUN_ALL_ARGV,
    },
    {
      what: 'a run-all record carrying the run command',
      kind: 'run-all',
      argv: LEGAL_RUN_ARGV,
    },
    {
      what: 'quorum run-all with no selected agent',
      kind: 'run-all',
      argv: ['quorum', 'run-all'],
    },
    {
      what: 'quorum run-all naming another agent',
      kind: 'run-all',
      argv: [
        'quorum',
        'run-all',
        '--coding-agents',
        'claude',
        '--credentials',
        'codex_sub',
      ],
    },
    {
      what: 'quorum run-all widening to two agents',
      kind: 'run-all',
      argv: [
        'quorum',
        'run-all',
        '--coding-agents',
        'codex,claude',
        '--credentials',
        'codex_sub',
      ],
    },
    {
      what: 'quorum run-all repeating the agent option',
      kind: 'run-all',
      argv: [
        'quorum',
        'run-all',
        '--coding-agents',
        'codex',
        '--coding-agents',
        'claude',
        '--credentials',
        'codex_sub',
      ],
    },
    {
      what: 'quorum run-all omitting the selected credential',
      kind: 'run-all',
      argv: ['quorum', 'run-all', '--coding-agents', 'codex'],
    },
    {
      what: 'quorum run-all naming another credential',
      kind: 'run-all',
      argv: [
        'quorum',
        'run-all',
        '--coding-agents',
        'codex',
        '--credentials',
        'opus',
      ],
    },
    {
      // The appliance forbids these on run-all: they would relocate the
      // trusted roots or swap the blessed registry out from under the job.
      what: 'quorum run-all relocating a trusted root',
      kind: 'run-all',
      argv: [...LEGAL_RUN_ALL_ARGV, '--out-root', '/tmp/elsewhere'],
    },
    {
      what: 'quorum run-all smuggling the singular run credential flag',
      kind: 'run-all',
      argv: [...LEGAL_RUN_ALL_ARGV, '--credential', 'opus'],
    },
    {
      what: 'quorum run-all hiding its selection after end-of-options',
      kind: 'run-all',
      argv: ['quorum', 'run-all', '--', ...LEGAL_RUN_ALL_ARGV.slice(2)],
    },
    {
      what: 'quorum run-all consuming its agent flag as another option value',
      kind: 'run-all',
      argv: [
        'quorum',
        'run-all',
        '--tier',
        '--coding-agents',
        'codex',
        '--credentials',
        'codex_sub',
      ],
    },
  ];

  for (const entry of refused) {
    const job = tamperCommand(
      cfg,
      liveRecord(cfg, entry.kind, ['quorum', entry.kind]).job_id,
      entry.argv,
    );
    let caught: unknown = null;
    try {
      liveCommandArgs(cfg, job, liveLease(), SUPERVISOR_FILE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect((caught as ApplianceError).step).toBe('live-command');
  }
});

test('liveCommandArgs preserves the legitimate arguments of an unmodified command', () => {
  const cfg = loaded();
  const accepted: readonly {
    readonly kind: 'run' | 'run-all';
    readonly argv: readonly string[];
    readonly options?: Parameters<typeof liveJobRequest>[1];
  }[] = [
    { kind: 'run', argv: LEGAL_RUN_ARGV },
    {
      kind: 'run',
      argv: [...LEGAL_RUN_ARGV, '--grader-model', 'anthropic.claude-sonnet-5'],
    },
    {
      // An omitted --credential is the agent default, preserved verbatim.
      kind: 'run',
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'codex',
      ],
      options: { selection: { agent: 'codex', credential: null } },
    },
    {
      // Scenario paths nest, so the trusted-root rule is a prefix rule, not a
      // single-segment one.
      kind: 'run',
      argv: [
        'quorum',
        'run',
        'scenarios/family/writing-plans-elicited',
        '--coding-agent',
        'codex',
        '--credential',
        'codex_sub',
      ],
    },
    {
      kind: 'run-all',
      argv: [...LEGAL_RUN_ALL_ARGV, '--jobs', '2', '--tier', 'sentinel'],
    },
    {
      // The equals form the submission parser also accepts.
      kind: 'run-all',
      argv: [
        'quorum',
        'run-all',
        '--coding-agents=codex',
        '--credentials=codex_sub',
      ],
    },
    {
      // An omitted --credentials is the agent default here too.
      kind: 'run-all',
      argv: ['quorum', 'run-all', '--coding-agents', 'codex'],
      options: { selection: { agent: 'codex', credential: null } },
    },
  ];

  for (const entry of accepted) {
    const job = leaseBoundRecord(cfg, entry.kind, entry.argv, {
      request: entry.options ?? {},
    });
    const args = liveCommandArgs(cfg, job, liveLease(), SUPERVISOR_FILE);
    for (const token of entry.argv) {
      expect(args).toContain(token);
    }
    expect(
      args.slice(args.indexOf('exec') + 1).slice(-entry.argv.length),
    ).toEqual([...entry.argv]);
  }
});

test('liveCommandArgs refuses malformed or repeated grader overrides', () => {
  const cfg = loaded();
  for (const tail of [
    ['--grader-model'],
    ['--grader-model', ''],
    ['--grader-model', '   '],
    ['--grader-model', '--out-root'],
    [
      '--grader-model',
      'anthropic.claude-sonnet-5',
      '--grader-model',
      'another-model',
    ],
    [
      '--grader-model',
      'anthropic.claude-sonnet-5',
      '--out-root',
      '/tmp/elsewhere',
    ],
  ]) {
    const job = leaseBoundRecord(cfg, 'run', [...LEGAL_RUN_ARGV, ...tail]);
    expect(() =>
      liveCommandArgs(cfg, job, liveLease(), SUPERVISOR_FILE),
    ).toThrow(ApplianceError);
  }
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
    QUORUM_LIVE_SPEND_LOCK: cfg.config.live_spend_lock!,
    GAUNTLET_ROOT: cfg.config.gauntlet.path,
    SUPERPOWERS_ROOT: cfg.config.superpowers.path,
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
    QUORUM_LIVE_SPEND_LOCK: cfg.config.live_spend_lock!,
    GAUNTLET_ROOT: cfg.config.gauntlet.path,
    SUPERPOWERS_ROOT: cfg.config.superpowers.path,
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
    leaseBoundRecord(cfg, 'run-all', [
      ...LEGAL_RUN_ALL_ARGV,
      '--tier',
      'sentinel',
    ]),
    liveLease(),
    SUPERVISOR_FILE,
  );
  const singleRunArgs = liveCommandArgs(
    cfg,
    leaseBoundRecord(cfg, 'run', LEGAL_RUN_ARGV),
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

// The terminal single-run verdict the live command is supposed to leave
// behind. Written at seed time for the tests whose subject is elsewhere, and
// from inside the live command for the ones whose subject is discovery.
function writeRunVerdict(cfg: LoadedApplianceConfig, runId = RUN_ID): void {
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
      scenario: 'writing-plans',
      coding_agent: 'gemini',
      started_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: new Date().toISOString(),
    }),
  );
}

// A batch whose header already carries a finished_at, the terminal artifact a
// run-all job is waiting for.
function writeFinishedBatch(
  cfg: LoadedApplianceConfig,
  batchId = 'batch-1',
): void {
  const batchDir = join(cfg.config.container.results_root, 'batches', batchId);
  const now = Date.now();
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({
      schema_version: 1,
      id: batchId,
      started_at: new Date(now - 1_000).toISOString(),
      finished_at: new Date(now).toISOString(),
      coding_agents: ['gemini'],
      jobs: 1,
    }),
  );
}

// The in-container process group the live command reports through the pid
// file the worker polls for.
function writeContainerPid(
  cfg: LoadedApplianceConfig,
  jobId: string,
  pid = 456,
): void {
  const pidDir = join(cfg.config.container.results_root, '.appliance-pids');
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, `${jobId}.pid`), `${pid}\n`);
}

// Seed the trusted corpus and blessed bundle the live scope resolves against.
// `seedTerminalVerdict: false` leaves the results root without a terminal
// artifact, so a test can prove the worker discovers one that appears later.
function seedLiveAppliance(
  cfg: LoadedApplianceConfig,
  options: { readonly seedTerminalVerdict?: boolean } = {},
): void {
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
  if (options.seedTerminalVerdict !== false) {
    writeRunVerdict(cfg);
  }
}

// Drives a whole live worker: git plumbing, the docker capability probe, both
// scoped container generations, and the live Quorum exec.
class WorkerRunner implements CommandRunner {
  calls: { command: string; args: readonly string[] }[] = [];
  ups = 0;
  activeDir: string;

  // What the live Quorum exec itself reports, and a hook that fires while it
  // is "running" so a test can act on the state the worker sees mid-flight.
  liveResult: CommandResult = {
    status: 0,
    stdout: `run-id: ${RUN_ID}\n`,
    stderr: '',
  };
  onLiveCommand?: () => void;
  // Fires as the LIVE scoped generation comes up, the moment preflight is
  // about to attest its lease.
  onLiveUp?: () => void;
  // A managed repo the live command left dirty, observed by postflight only.
  dirtyAfterLiveCommand = false;
  private liveCommandSeen = false;
  // Whether the recorded in-container process group answers a liveness probe.
  processGroupAlive = false;

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
      // The recorded-container lifecycle seam inspects the configured NAME;
      // scoped capture inspects the immutable ID it just created.
      if (target === 'quorum-appliance') {
        return this.ups < 2
          ? { status: 1, stdout: '', stderr: 'no such container\n' }
          : {
              status: 0,
              stdout: JSON.stringify([{ Id: LIVE_ID, Image: 'sha256:img-1' }]),
              stderr: '',
            };
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          { Id: target, Image: 'sha256:img-1', Mounts: this.mountsFor(target) },
        ]),
        stderr: '',
      };
    }
    if (command === 'docker' && args[0] === 'exec') {
      return args.join(' ').includes('kill -0 -- -456') &&
        this.processGroupAlive
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    }
    if (command === 'git') {
      if (args.includes('status')) {
        return this.dirtyAfterLiveCommand && this.liveCommandSeen
          ? { status: 0, stdout: ' M mutated.txt\n', stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
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
      if (id === LIVE_ID) {
        this.onLiveUp?.();
      }
      return { status: 0, stdout: `${id}\n`, stderr: '' };
    }
    if (args.includes('evals-tool-versions')) {
      return { status: 0, stdout: 'bun 1.3.13\n', stderr: '' };
    }
    if (args.includes('--exec-env-file')) {
      this.liveCommandSeen = true;
      this.onLiveCommand?.();
      return this.liveResult;
    }
    return { status: 0, stdout: 'ok\n', stderr: '' };
  }
}

// A submitted live job for the fixture cell (gemini x gemini_oauth_fx),
// exactly as the CLI persists one: the argv names the selected credential
// because the selection names it, and an explicit selection is never carried
// beside a command that omits it.
function seededLiveJob(cfg: LoadedApplianceConfig) {
  return createJob(
    cfg,
    liveJobRequest('run', {
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'gemini',
        '--credential',
        CORPUS_CREDENTIAL,
      ],
      selection: { agent: 'gemini', credential: CORPUS_CREDENTIAL },
      scope: CORPUS_SCOPE,
      sourceEvalsSha: RESOLVED_SHA,
    }),
  );
}

// The run-all half of the same fixture cell, whose terminal artifact is a
// batch header rather than a verdict.
function seededLiveRunAllJob(cfg: LoadedApplianceConfig) {
  return createJob(
    cfg,
    liveJobRequest('run-all', {
      argv: [
        'quorum',
        'run-all',
        '--coding-agents',
        'gemini',
        '--credentials',
        CORPUS_CREDENTIAL,
      ],
      selection: { agent: 'gemini', credential: CORPUS_CREDENTIAL },
      scope: CORPUS_SCOPE,
      sourceEvalsSha: RESOLVED_SHA,
    }),
  );
}

test('runWorker hands the supervisor env file to the live Quorum exec only', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const activeDir = join(cfg.config.root, 'state/credentials-scoped/active');
  const runner = new WorkerRunner(activeDir);
  const job = seededLiveJob(cfg);
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

// The same command boundary, reached the way an operator does: through the
// whole worker. A record whose durable command was rewritten after submission
// must be refused before the worker touches git, Docker, or the blessed
// bundle — so no credential is ever staged, mounted, or attached for it.

test('runWorker refuses a tampered command before any runner call or credential staging', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  const job = seededLiveJob(cfg);
  tamperCommand(cfg, job.job_id, ['env']);

  await expect(runWorker(cfg, job.job_id, runner)).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'live-command',
  });

  expect(runner.calls).toEqual([]);
  expect(existsSync(join(cfg.config.root, 'state/credentials-scoped'))).toBe(
    false,
  );
  const record = readJob(cfg, job.job_id);
  expect(record.status).toBe('failed');
  expect(record.error?.step).toBe('live-command');
  expect(record.container).toBe(null);
});

test('runWorker refuses a kind/argv mismatch before any runner call', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  const job = seededLiveJob(cfg);
  tamperCommand(cfg, job.job_id, [
    'quorum',
    'run-all',
    '--coding-agents',
    'gemini',
    '--credentials',
    CORPUS_CREDENTIAL,
  ]);

  await expect(runWorker(cfg, job.job_id, runner)).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'live-command',
  });

  expect(runner.calls).toEqual([]);
  expect(existsSync(join(cfg.config.root, 'state/credentials-scoped'))).toBe(
    false,
  );
  expect(readJob(cfg, job.job_id).status).toBe('failed');
});

// --- the executed record is the preflighted one (F13 Task 5) ----------------
// Preflight attests ONE (scope, lease) pair; the worker then rereads the job
// before executing. The record it reads back is durable, mutable state, so the
// live exec must prove that reread record is still the one the lease was built
// for — otherwise a job can be re-pointed at another cell's credentials
// between attestation and execution.

test('liveCommandArgs refuses a job whose credential scope is not the lease scope', () => {
  const cfg = loaded();
  const job = liveRecord(cfg, 'run', LEGAL_RUN_ARGV);
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    container: {
      name: 'quorum-appliance',
      id: CONTAINER_ID,
      image_id: 'sha256:img-1',
      mount_signature: 'f'.repeat(64),
    },
  }));
  // The record still selects codex x codex_sub, but its authoritative scope
  // now names another cell entirely.
  rewriteJobRecordRaw(cfg, job.job_id, { credential_scope: CORPUS_SCOPE });
  const repointed = readJob(cfg, job.job_id);

  let caught: unknown = null;
  try {
    liveCommandArgs(cfg, repointed, liveLease(), SUPERVISOR_FILE);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
  expect((caught as ApplianceError).step).toBe('live-command');
});

test('liveCommandArgs refuses every drift between recorded container evidence and the lease', () => {
  const cfg = loaded();
  const lease = liveLease();
  const evidence = {
    name: lease.name,
    id: lease.id,
    image_id: lease.imageId,
    mount_signature: lease.mountSignature,
  };
  const drifts: readonly {
    readonly what: string;
    readonly container: typeof evidence | null;
  }[] = [
    { what: 'no recorded container at all', container: null },
    {
      what: 'another container id',
      container: { ...evidence, id: 'b'.repeat(64) },
    },
    {
      what: 'another container name',
      container: { ...evidence, name: 'someone-elses-container' },
    },
    {
      what: 'another image id',
      container: { ...evidence, image_id: 'sha256:img-2' },
    },
    {
      what: 'another mount signature',
      container: { ...evidence, mount_signature: 'a'.repeat(64) },
    },
  ];

  for (const drift of drifts) {
    const job = liveRecord(cfg, 'run', LEGAL_RUN_ARGV);
    const drifted = updateJob(cfg, job.job_id, (current) => ({
      ...current,
      container: drift.container,
    }));

    let caught: unknown = null;
    try {
      liveCommandArgs(cfg, drifted, lease, SUPERVISOR_FILE);
    } catch (error) {
      caught = error;
    }
    expect(`${drift.what}: ${caught instanceof ApplianceError}`).toBe(
      `${drift.what}: true`,
    );
    expect((caught as ApplianceError).step).toBe('live-command');
  }

  // The exact evidence the lease produces is accepted.
  const job = liveRecord(cfg, 'run', LEGAL_RUN_ARGV);
  const bound = updateJob(cfg, job.job_id, (current) => ({
    ...current,
    container: evidence,
  }));
  expect(liveCommandArgs(cfg, bound, lease, SUPERVISOR_FILE)).toContain('exec');
});

test('runWorker refuses a scope re-pointed after preflight attested its lease', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  const job = seededLiveJob(cfg);
  writeContainerPid(cfg, job.job_id);
  // The live generation is up and attested; only now does the durable record
  // start naming a different cell's credentials.
  runner.onLiveUp = () => {
    rewriteJobRecordRaw(cfg, job.job_id, {
      credential_scope: FIXTURE_LIVE_SCOPE,
    });
  };

  await expect(runWorker(cfg, job.job_id, runner)).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'live-command',
  });

  // The live exec — the one place the supervisor env file crosses into a
  // process — never happened.
  expect(
    runner.calls.filter((call) => call.args.includes('--exec-env-file')),
  ).toEqual([]);
  const record = readJob(cfg, job.job_id);
  expect(record.status).toBe('failed');
  expect(record.error?.step).toBe('live-command');
});

// --- the worker's terminal lifecycle ----------------------------------------
// What the worker does around the live command: hold and release both locks,
// discover the terminal artifact the command left (from stdout, or by
// discovery when the wrapper exits early with none), copy provenance beside
// that artifact, classify a nonzero exit, refuse a run with no captured
// in-container process group, and quarantine a run that left a managed repo
// dirty. Every case goes through runWorker, because that ordering IS the
// contract.

test('runWorker preflights, runs the live command, records artifacts, and releases locks', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  runner.liveResult = {
    status: 0,
    stdout: 'artifacts: results/batches/batch-1\n',
    stderr: '',
  };
  const job = seededLiveRunAllJob(cfg);
  writeFinishedBatch(cfg);
  writeContainerPid(cfg, job.job_id);
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
  // The run lock carried the preflighted refs while the command was live.
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

test('runWorker waits for a terminal single-run artifact after an early zero wrapper exit', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg, { seedTerminalVerdict: false });
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  runner.liveResult = { status: 0, stdout: '', stderr: '' };
  runner.processGroupAlive = true;
  const job = seededLiveJob(cfg);
  writeContainerPid(cfg, job.job_id);
  runner.onLiveCommand = () => {
    setTimeout(() => writeRunVerdict(cfg), 10);
  };

  await runWorker(cfg, job.job_id, runner);

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('done');
  expect(updated.artifacts.run_id).toBe(RUN_ID);
  expect(
    existsSync(
      join(
        cfg.config.container.results_root,
        RUN_ID,
        'appliance-provenance.json',
      ),
    ),
  ).toBe(true);
});

test('runWorker discovers a terminal batch after an early zero wrapper exit without stdout', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg, { seedTerminalVerdict: false });
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  runner.liveResult = { status: 0, stdout: '', stderr: '' };
  runner.processGroupAlive = true;
  const job = seededLiveRunAllJob(cfg);
  writeContainerPid(cfg, job.job_id);
  runner.onLiveCommand = () => {
    setTimeout(() => writeFinishedBatch(cfg, 'batch-detached'), 10);
  };

  await runWorker(cfg, job.job_id, runner);

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('done');
  expect(updated.artifacts.batch_id).toBe('batch-detached');
  expect(
    existsSync(
      join(
        cfg.config.container.results_root,
        'batches/batch-detached/appliance-provenance.json',
      ),
    ),
  ).toBe(true);
});

test('runWorker fails when a nonzero live command only created a batch shell', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg, { seedTerminalVerdict: false });
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  runner.liveResult = {
    status: 1,
    stdout: 'batch batch-1\nartifacts: results/batches/batch-1\n',
    stderr: 'boom\n',
  };
  const job = seededLiveRunAllJob(cfg);
  // A batch directory with no header: nothing terminal was ever written.
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  writeContainerPid(cfg, job.job_id);

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
  seedLiveAppliance(cfg, { seedTerminalVerdict: false });
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  const job = seededLiveRunAllJob(cfg);
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  // No pid file: the in-container process group was never reported.

  await runWorker(cfg, job.job_id, runner);

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('failed');
  expect(updated.result.summary).toBe('container process id was not captured');
  expect(updated.process?.container_pgid).toBe(null);
});

test('runWorker throws and leaves a quarantined record when postflight finds a dirty repo', async () => {
  const cfg = loaded();
  seedLiveAppliance(cfg);
  const runner = new WorkerRunner(
    join(cfg.config.root, 'state/credentials-scoped/active'),
  );
  runner.liveResult = {
    status: 0,
    stdout: 'artifacts: results/batches/batch-1\n',
    stderr: '',
  };
  runner.dirtyAfterLiveCommand = true;
  const job = seededLiveRunAllJob(cfg);
  writeFinishedBatch(cfg);
  writeContainerPid(cfg, job.job_id);
  const dirty = `dirty worktree at ${cfg.config.evals.path}: M mutated.txt`;

  await expect(runWorker(cfg, job.job_id, runner)).rejects.toMatchObject({
    code: 'repo_dirty',
    message: dirty,
  });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('quarantined');
  expect(updated.finished_at).not.toBe(null);
  expect(updated.result).toEqual({
    exit_code: 0,
    summary: `postflight dirty check failed: ${dirty}`,
  });
  expect(updated.error).toMatchObject({ code: 'repo_dirty', message: dirty });
  expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
  expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
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

// Edits job.json directly, which is the only way to model a record the
// appliance itself could not have written: updateJob refuses any patch that
// moves the credential triple.
function rewriteRawRecord(
  cfg: LoadedApplianceConfig,
  jobId: string,
  edit: (record: Record<string, unknown>) => void,
): void {
  const path = join(cfg.paths.jobs, jobId, 'job.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  edit(record);
  writeFileSync(path, JSON.stringify(record, null, 2));
}

// Removes fields from the raw record so they are ABSENT on disk — the shape a
// record written before those fields existed has, which the read defaults then
// fill in as null. Partial removal models a partially tampered record.
function stripRecordFields(
  cfg: LoadedApplianceConfig,
  jobId: string,
  fields: readonly string[],
): void {
  rewriteRawRecord(cfg, jobId, (record) => {
    for (const field of fields) {
      delete record[field];
    }
  });
}

// A record written before the credential triple existed: the fields are
// absent on disk, so the read defaults make the scope null. It cannot execute,
// but safe cancellation still reaches Task 2's fixed recorded-container seam
// without anyone fabricating a runnable lease for it.
function demoteToLegacyRecord(cfg: LoadedApplianceConfig, jobId: string): void {
  stripRecordFields(cfg, jobId, [
    'credential_selection',
    'credential_scope',
    'credential_scope_source_evals_sha',
  ]);
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
  expect(runner.probeCalls()).toBe(0);
  expect(readJob(cfg, job.job_id).status).toBe('lost');
});

// --- which records may prove a recorded identity (F13 Task 5) ---------------
// Liveness and cancellation both reach the fixed recorded-container seam only
// through an identity the record can PROVE. A scoped record proves one by
// rebuilding its immutable lease. The single raw-evidence exception is a
// genuine legacy live record: kind run or run-all whose whole credential
// triple is absent on disk, because it predates scoped delivery entirely.
// Every other shape — asserted-empty, partially stripped, or a kind that never
// executed live — yields no identity, so no docker call is made at all.

interface LifecycleCase {
  readonly what: string;
  readonly create: (cfg: LoadedApplianceConfig) => JobRecord;
  readonly demote: (cfg: LoadedApplianceConfig, jobId: string) => void;
  readonly reachesSeam: boolean;
}

const LIFECYCLE_CASES: readonly LifecycleCase[] = [
  {
    what: 'a genuine legacy run record',
    create: (cfg) => createJob(cfg, liveJobRequest('run')),
    demote: demoteToLegacyRecord,
    reachesSeam: true,
  },
  {
    what: 'a genuine legacy run-all record',
    create: (cfg) => createJob(cfg, liveJobRequest('run-all')),
    demote: demoteToLegacyRecord,
    reachesSeam: true,
  },
  {
    what: 'a record that kept its credential selection',
    create: (cfg) => createJob(cfg, liveJobRequest('run-all')),
    demote: (cfg, jobId) => {
      stripRecordFields(cfg, jobId, [
        'credential_scope',
        'credential_scope_source_evals_sha',
      ]);
      expect(readJob(cfg, jobId).credential_selection).toEqual(
        FIXTURE_LIVE_SELECTION,
      );
    },
    reachesSeam: false,
  },
  {
    what: 'a record that kept its source evals SHA',
    create: (cfg) => createJob(cfg, liveJobRequest('run-all')),
    demote: (cfg, jobId) => {
      stripRecordFields(cfg, jobId, [
        'credential_selection',
        'credential_scope',
      ]);
      expect(readJob(cfg, jobId).credential_scope_source_evals_sha).not.toBe(
        null,
      );
    },
    reachesSeam: false,
  },
  {
    what: 'a record asserting an empty scope',
    create: (cfg) => createJob(cfg, liveJobRequest('run-all')),
    demote: (cfg, jobId) =>
      rewriteRawRecord(cfg, jobId, (record) => {
        record['credential_selection'] = null;
        record['credential_scope'] = EMPTY_CREDENTIAL_SCOPE;
        record['credential_scope_source_evals_sha'] = null;
      }),
    reachesSeam: false,
  },
  {
    what: 'an imported record, which never executed live',
    create: (cfg) => createJob(cfg, importJobRequest()),
    demote: () => {},
    reachesSeam: false,
  },
];

test('only a genuine legacy live record reads its recorded identity raw', async () => {
  for (const entry of LIFECYCLE_CASES) {
    const cfg = loaded();
    const runner = new FakeRunner();
    const job = entry.create(cfg);
    markRunning(cfg, job.job_id);
    entry.demote(cfg, job.job_id);

    await cancelJob(cfg, job.job_id, runner, { graceMs: 0 });

    // Cancellation: one fixed SIGINT through the seam, or none at all.
    expect(runner.interruptCalls()).toBe(entry.reachesSeam ? 1 : 0);
    // Liveness rides the same identity gate: a record that cannot prove one
    // is never probed either, and therefore reports lost.
    expect(runner.probeCalls()).toBe(entry.reachesSeam ? 1 : 0);
    for (const call of runner.calls) {
      expect(call.command).toBe('docker');
    }
    expect(readJob(cfg, job.job_id).status).toBe('lost');
  }
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
