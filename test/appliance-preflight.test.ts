import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  postflightDirtyCheck,
  preflightLiveJob,
  prepare,
} from '../src/appliance/preflight.ts';
import { writeProvenance } from '../src/appliance/provenance.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import {
  EMPTY_CREDENTIAL_SCOPE,
  type LiveCredentialScope,
} from '../src/credentials/scope.ts';
import { liveJobRequest, prepareJobRequest } from './appliance-job-fixtures.ts';

const REPO = resolve(import.meta.dir, '..');

// The two container generations one live preflight creates: the asserted-empty
// probe first, the scoped live container second. Distinct ids, so evidence
// derived from the live lease can never be the probe's.
const PROBE_ID =
  'ba5eba110000000000000000000000000000000000000000000000000000cafe';
const LIVE_ID =
  'c0de0000000000000000000000000000000000000000000000000000deadbeef';

// The evals HEAD the fake git resolves every rev-parse to.
const RESOLVED_SHA = 'a'.repeat(40);

const CORPUS_CREDENTIAL = 'gemini_oauth_fx';
const CORPUS_CREDENTIAL_BODY =
  '    model: gemini-2.5-pro\n    api: gemini\n    auth: oauth\n    harnesses: [gemini]\n';

const BUNDLE_ENV_LINES: readonly string[] = [
  "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
  "QUORUM_GRADER_ANTHROPIC_BASE_URL='https://gateway.example/v1'",
  "HTTPS_PROXY='http://proxy.example:8080'",
];

// The exact live scope the fixture corpus rederives for gemini x
// gemini_oauth_fx. Preflight recomputes this from the persisted selection and
// requires exact equality before it evaluates any credential.
function corpusScope(): LiveCredentialScope {
  return {
    schemaVersion: 1,
    kind: 'live',
    agent: 'gemini',
    runtimeFamily: 'gemini',
    credential: CORPUS_CREDENTIAL,
    agentEnv: [],
    geminiAuthType: 'oauth-personal',
    oauth: { kind: 'gemini', mountName: 'gemini' },
  };
}

const CORPUS_SELECTION = {
  agent: 'gemini',
  credential: CORPUS_CREDENTIAL,
};

interface FakeInspectMount {
  readonly Type: 'bind';
  readonly Source: string;
  readonly Destination: string;
  readonly RW: boolean;
}

class FakeRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly options?: CommandOptions;
  }[] = [];

  readonly results: {
    readonly match: (command: string, args: readonly string[]) => boolean;
    readonly result: CommandResult;
  }[] = [];

  execEnvFileSupported = true;
  // The mount topology `docker container inspect` reports per captured id.
  mounts = new Map<string, readonly FakeInspectMount[]>();
  upIds: string[] = [PROBE_ID, LIVE_ID];
  ups = 0;
  beforeRun: ((command: string, args: readonly string[]) => void) | null = null;

  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    this.beforeRun?.(command, args);
    const configured = this.results.find((entry) => entry.match(command, args));
    if (configured !== undefined) {
      return configured.result;
    }
    if (command === 'docker' && args[0] === 'exec' && args[1] === '--help') {
      return {
        status: 0,
        stdout: this.execEnvFileSupported
          ? 'Usage: docker exec\n  --env-file list\n'
          : 'Usage: docker exec\n  --env list\n',
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
          {
            Id: target,
            Image: `sha256:image-${target.slice(0, 4)}`,
            Mounts: this.mounts.get(target) ?? [],
          },
        ]),
        stderr: '',
      };
    }
    if (command === 'git' && args.includes('status')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'git' &&
      args.includes('rev-parse') &&
      args.some((arg) => arg.startsWith('refs/tags/main'))
    ) {
      return { status: 1, stdout: '', stderr: 'missing tag\n' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: `${RESOLVED_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('cat-file')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command.endsWith('scripts/evals-container')) {
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
        const id = this.upIds[this.ups] ?? PROBE_ID;
        this.ups += 1;
        return { status: 0, stdout: `${id}\n`, stderr: '' };
      }
      if (args.includes('evals-tool-versions')) {
        return { status: 0, stdout: 'bun 1.3.13\n', stderr: '' };
      }
      return { status: 0, stdout: 'ok\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

interface Fixture {
  readonly loaded: LoadedApplianceConfig;
  readonly root: string;
  readonly bundleDir: string;
  readonly scopedRoot: string;
  readonly activeDir: string;
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(base, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

// Canonical (realpath) fixture root: the appliance boundary validates every
// absolute path component no-follow, and macOS tmpdir paths traverse the /var
// symlink.
function fixture(): Fixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'appliance-preflight-')),
  );
  for (const dir of [
    'superpowers-evals/scripts',
    'superpowers-evals/results',
    'superpowers-evals/coding-agents',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
    'state/jobs',
    'state/locks',
    'state/provenance',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const evalsPath = join(root, 'superpowers-evals');
  writeFileSync(
    join(evalsPath, 'scripts/evals-container'),
    '#!/usr/bin/env bash\n',
  );
  copyFileSync(
    join(REPO, 'coding-agents', 'gemini.yaml'),
    join(evalsPath, 'coding-agents/gemini.yaml'),
  );
  writeFileSync(
    join(evalsPath, 'credentials.yaml'),
    `# minimal corpus-derived registry (name -> record at the top level)\n  ${CORPUS_CREDENTIAL}:\n${CORPUS_CREDENTIAL_BODY}`,
  );
  const bundleDir = join(root, 'credentials/blessed');
  writeTree(bundleDir, {
    'metadata.json': JSON.stringify({
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['anthropic'],
    }),
    'credentials.env': `${BUNDLE_ENV_LINES.join('\n')}\n`,
    'gemini/oauth_creds.json': JSON.stringify({
      access_token: 'gem-access',
      refresh_token: 'gem-refresh',
    }),
    'gemini/google_accounts.json': JSON.stringify({
      accounts: [{ email: 'user@example.com' }],
    }),
  });
  const loaded: LoadedApplianceConfig = {
    configPath: join(root, 'config/appliance.json'),
    config: {
      root,
      evals: { path: evalsPath, remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: bundleDir },
      container: {
        name: 'quorum-appliance',
        results_root: join(evalsPath, 'results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['anthropic'],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
  const scopedRoot = join(root, 'state/credentials-scoped');
  return {
    loaded,
    root,
    bundleDir,
    scopedRoot,
    activeDir: join(scopedRoot, 'active'),
  };
}

// The mount topology a correct scoped up produces for each generation.
function seedMounts(fx: Fixture, runner: FakeRunner): void {
  const envMount: FakeInspectMount = {
    Type: 'bind',
    Source: join(fx.activeDir, 'agent.env'),
    Destination: '/run/evals/credentials.env',
    RW: false,
  };
  runner.mounts.set(PROBE_ID, [envMount]);
  runner.mounts.set(LIVE_ID, [
    envMount,
    {
      Type: 'bind',
      Source: join(fx.activeDir, 'auth/gemini'),
      Destination: '/auth/gemini',
      RW: false,
    },
  ]);
}

function liveJob(
  fx: Fixture,
  overrides: Parameters<typeof liveJobRequest>[1] = {},
) {
  return createJob(
    fx.loaded,
    liveJobRequest('run', {
      argv: [
        'quorum',
        'run',
        'scenarios/writing-plans',
        '--coding-agent',
        'gemini',
      ],
      selection: CORPUS_SELECTION,
      scope: corpusScope(),
      sourceEvalsSha: RESOLVED_SHA,
      ...overrides,
    }),
  );
}

// Every container-touching call, in order, with the git plumbing elided.
function containerTrace(runner: FakeRunner): string[] {
  return runner.calls.flatMap((call) => {
    if (call.command === 'docker') {
      if (call.args[0] === 'exec' && call.args[1] === '--help') {
        return ['docker exec --help'];
      }
      if (call.args[0] === 'container' && call.args[1] === 'inspect') {
        return [`docker inspect ${call.args[2]}`];
      }
      return [`docker ${call.args[0]}`];
    }
    if (call.command.endsWith('scripts/evals-container')) {
      const execAt = call.args.indexOf('exec');
      return execAt >= 0
        ? [`wrapper exec ${call.args.slice(execAt + 1).join(' ')}`]
        : [`wrapper ${call.args[call.args.length - 1]}`];
    }
    return [];
  });
}

function dockerCalls(runner: FakeRunner): readonly unknown[] {
  return runner.calls.filter(
    (call) =>
      call.command === 'docker' ||
      call.command.endsWith('scripts/evals-container'),
  );
}

function exactContainerRemovals(runner: FakeRunner): readonly string[][] {
  return runner.calls.flatMap((call) =>
    call.command === 'docker' && call.args[0] === 'rm' ? [[...call.args]] : [],
  );
}

test('preflightLiveJob probes empty, then binds live execution to the scoped lease', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);

  const result = await preflightLiveJob({
    loaded: fx.loaded,
    jobId: job.job_id,
    superpowersRef: 'main',
    runner,
  });

  expect(containerTrace(runner)).toEqual([
    'docker exec --help',
    'wrapper build',
    'wrapper status',
    'wrapper up',
    `docker inspect ${PROBE_ID}`,
    'wrapper exec evals-tool-versions',
    'wrapper exec quorum check',
    'wrapper status',
    'wrapper down',
    'wrapper up',
    `docker inspect ${LIVE_ID}`,
  ]);

  const wrapperCalls = runner.calls.filter((call) =>
    call.command.endsWith('scripts/evals-container'),
  );
  expect(
    wrapperCalls.find((call) => call.args.includes('build'))?.args,
  ).toEqual([
    '--name',
    'quorum-appliance',
    '--gauntlet-root',
    fx.loaded.config.gauntlet.path,
    'build',
  ]);
  expect(wrapperCalls.find((call) => call.args.includes('down'))?.args).toEqual(
    ['--name', 'quorum-appliance', 'down'],
  );

  // The probes ran through the PROBE lease with no supervisor file at all.
  const probeExecs = runner.calls.filter(
    (call) =>
      call.command.endsWith('scripts/evals-container') &&
      call.args.includes('exec'),
  );
  expect(probeExecs).toHaveLength(2);
  for (const call of probeExecs) {
    expect(call.args).toContain('--expected-container-id');
    expect(call.args[call.args.indexOf('--expected-container-id') + 1]).toBe(
      PROBE_ID,
    );
    expect(call.args).not.toContain('--exec-env-file');
  }

  // Durable evidence comes from the LIVE lease and carries no scope of its own.
  expect(result.evidence.container).toEqual({
    name: 'quorum-appliance',
    id: LIVE_ID,
    image_id: `sha256:image-${LIVE_ID.slice(0, 4)}`,
    mount_signature: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(Object.keys(result.evidence.container).sort()).toEqual([
    'id',
    'image_id',
    'mount_signature',
    'name',
  ]);
  // The resolved superpowers revision is what a run is reproducible against,
  // so it must survive verbatim from the ref resolution into the result, the
  // durable job, and provenance.
  expect(result.evidence.refs.superpowers_requested_ref).toBe('main');
  expect(result.evidence.refs.superpowers_resolved_sha).toBe(RESOLVED_SHA);
  expect(result.evidence.refs.evals_resolved_sha).toBe(RESOLVED_SHA);
  expect(result.evidence.credential_bundle).toEqual({
    name: 'blessed',
    bundle_id: 'blessed-2026-06-18-a',
  });
  expect(readFileSync(result.evidence.tool_versions_path, 'utf8')).toBe(
    'bun 1.3.13\n',
  );
  expect(statSync(result.evidence.tool_versions_path).mode & 0o777).toBe(0o600);

  // The lease IS the source of that evidence, not a separate recomputation.
  expect(result.lease.id).toBe(LIVE_ID);
  expect(result.lease.mountSignature).toBe(
    result.evidence.container.mount_signature,
  );
  expect(result.lease.credentialScope).toEqual(corpusScope());
  expect(result.supervisorExecEnvFile).toBe(
    join(fx.activeDir, 'supervisor.exec.env'),
  );

  // The job carries the same evidence and its ORIGINAL authoritative scope.
  const updated = readJob(fx.loaded, job.job_id);
  expect(updated.container).toEqual(result.evidence.container);
  expect(updated.refs).toEqual(result.evidence.refs);
  expect(updated.refs?.superpowers_requested_ref).toBe('main');
  expect(updated.refs?.superpowers_resolved_sha).toBe(RESOLVED_SHA);
  expect(updated.refs?.evals_resolved_sha).toBe(RESOLVED_SHA);
  expect(updated.credential_bundle?.bundle_id).toBe('blessed-2026-06-18-a');
  expect(updated.credential_scope).toEqual(corpusScope());
  expect(updated.credential_scope_source_evals_sha).toBe(RESOLVED_SHA);

  // Provenance is derived from the reread job.
  const provenance = JSON.parse(
    readFileSync(result.evidence.provenance_path, 'utf8'),
  );
  expect(provenance.job_id).toBe(job.job_id);
  expect(provenance.credential_scope).toEqual(corpusScope());
  expect(provenance.container).toEqual({
    ...result.evidence.container,
    code_mounts_read_only: false,
  });
  expect(provenance.refs).toEqual(updated.refs);
  expect(provenance.refs.superpowers_resolved_sha).toBe(RESOLVED_SHA);
  expect(provenance.command_argv).toEqual(updated.command.argv);
});

test('the worker-only supervisor path never reaches the job record or provenance', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);

  const result = await preflightLiveJob({
    loaded: fx.loaded,
    jobId: job.job_id,
    superpowersRef: 'main',
    runner,
  });

  const supervisor = result.supervisorExecEnvFile;
  const jobJson = readFileSync(
    join(fx.loaded.paths.jobs, job.job_id, 'job.json'),
    'utf8',
  );
  const provenanceJson = readFileSync(result.evidence.provenance_path, 'utf8');
  for (const serialized of [
    jobJson,
    provenanceJson,
    JSON.stringify(result.evidence),
  ]) {
    expect(serialized).not.toContain(supervisor);
    expect(serialized).not.toContain('supervisor.exec.env');
    expect(serialized).not.toContain('credentials-scoped');
    expect(serialized).not.toContain(fx.bundleDir);
  }
});

test('preflight copies provenance beside a known batch artifact when the directory exists', async () => {
  const fx = fixture();
  mkdirSync(join(fx.loaded.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = createJob(
    fx.loaded,
    liveJobRequest('run-all', {
      argv: ['quorum', 'run-all', '--coding-agents', 'gemini'],
      selection: CORPUS_SELECTION,
      scope: corpusScope(),
      sourceEvalsSha: RESOLVED_SHA,
    }),
  );
  updateJob(fx.loaded, job.job_id, (current) => ({
    ...current,
    artifacts: { ...current.artifacts, batch_id: 'batch-1' },
  }));

  await preflightLiveJob({
    loaded: fx.loaded,
    jobId: job.job_id,
    superpowersRef: 'main',
    runner,
  });

  const artifactProvenance = join(
    fx.loaded.config.container.results_root,
    'batches/batch-1/appliance-provenance.json',
  );
  expect(existsSync(artifactProvenance)).toBe(true);
  const jobProvenance = JSON.parse(
    readFileSync(
      join(fx.loaded.paths.provenance, `${job.job_id}.json`),
      'utf8',
    ),
  );
  expect(JSON.parse(readFileSync(artifactProvenance, 'utf8'))).toEqual(
    jobProvenance,
  );
});

test('preflightLiveJob refuses a source SHA that drifted from the fast-forwarded checkout', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  const job = liveJob(fx, { sourceEvalsSha: 'b'.repeat(40) });

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'preflight',
    message: expect.stringContaining('evals checkout'),
  });

  // Refused before credential evaluation and before any Docker work.
  expect(dockerCalls(runner)).toEqual([]);
  expect(existsSync(fx.scopedRoot)).toBe(false);
  expect(readJob(fx.loaded, job.job_id).status).toBe('failed');
});

test('preflightLiveJob refuses a persisted scope the corpus no longer produces', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  const job = liveJob(fx, {
    scope: { ...corpusScope(), geminiAuthType: 'gemini-api-key' },
  });

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'preflight',
    message: expect.stringContaining('recomputed'),
  });

  expect(dockerCalls(runner)).toEqual([]);
  expect(existsSync(fx.scopedRoot)).toBe(false);
});

test('preflightLiveJob requires docker exec --env-file before build or staging', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  runner.execEnvFileSupported = false;
  const job = liveJob(fx);

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'container_unhealthy',
    message: expect.stringContaining('--env-file'),
  });

  expect(containerTrace(runner)).toEqual(['docker exec --help']);
  expect(existsSync(fx.scopedRoot)).toBe(false);
});

test('a live-staging failure removes the exact probe container before retiring its material', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);
  rmSync(join(fx.bundleDir, 'credentials.env'));

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'credential-scope',
  });

  expect(exactContainerRemovals(runner)).toEqual([['rm', '-f', PROBE_ID]]);
  expect(runner.ups).toBe(1);
  expect(existsSync(fx.activeDir)).toBe(false);
  expect(readJob(fx.loaded, job.job_id).status).toBe('failed');
});

test('a live-up failure retires activated material only after reconciliation proves the new container absent', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);
  runner.results.push(
    {
      match: (command, args) =>
        command.endsWith('scripts/evals-container') &&
        args[args.length - 1] === 'up' &&
        runner.ups === 1,
      result: { status: 1, stdout: '', stderr: 'live up failed\n' },
    },
    {
      match: (command, args) =>
        command.endsWith('scripts/evals-container') &&
        args[args.length - 1] === 'status' &&
        runner.calls.filter(
          (call) =>
            call.command.endsWith('scripts/evals-container') &&
            call.args[call.args.length - 1] === 'status',
        ).length >= 3,
      result: {
        status: 0,
        stdout: 'quorum-appliance: missing\n',
        stderr: '',
      },
    },
  );

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'container_unhealthy',
    step: 'container',
    message: expect.stringContaining('scoped container up failed'),
  });

  expect(exactContainerRemovals(runner)).toEqual([]);
  expect(runner.ups).toBe(1);
  expect(existsSync(fx.activeDir)).toBe(false);
  expect(readJob(fx.loaded, job.job_id).status).toBe('failed');
});

test('a leased-container cleanup failure is appended and keeps material that may still be mounted', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);
  rmSync(join(fx.bundleDir, 'credentials.env'));
  runner.results.push({
    match: (command, args) =>
      command === 'docker' &&
      args[0] === 'rm' &&
      args[1] === '-f' &&
      args[2] === PROBE_ID,
    result: { status: 1, stdout: '', stderr: 'cleanup failed' },
  });

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'config_invalid',
    step: 'credential-scope',
    message: expect.stringContaining(
      `cleanup of leased container ${PROBE_ID} failed with exit 1`,
    ),
  });

  expect(exactContainerRemovals(runner)).toEqual([['rm', '-f', PROBE_ID]]);
  expect(existsSync(fx.activeDir)).toBe(true);
  expect(readJob(fx.loaded, job.job_id).status).toBe('failed');
});

test('an evidence-commit failure removes the exact live container before retiring its material', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);
  const jobPath = join(fx.loaded.paths.jobs, job.job_id, 'job.json');
  runner.beforeRun = (command, args) => {
    if (
      command === 'docker' &&
      args[0] === 'container' &&
      args[1] === 'inspect' &&
      args[2] === LIVE_ID
    ) {
      const record = JSON.parse(readFileSync(jobPath, 'utf8'));
      writeFileSync(
        jobPath,
        JSON.stringify({ ...record, job_id: 'different-job' }),
      );
    }
  };

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({ code: 'config_invalid', step: 'job' });

  expect(exactContainerRemovals(runner)).toEqual([['rm', '-f', LIVE_ID]]);
  expect(existsSync(fx.activeDir)).toBe(false);
});

// Records written before the credential triple existed read back with a null
// scope. They stay readable and cancellable, but they can never execute: there
// is no legacy full-bundle path to fall back to.
test('preflightLiveJob refuses null and asserted-empty live scopes', async () => {
  const fx = fixture();
  const runner = new FakeRunner();

  // Both live kinds, demoted to the shape an old record has on disk: the
  // credential fields are absent, not null-valued, so the read defaults apply.
  for (const kind of ['run', 'run-all'] as const) {
    const legacy = createJob(
      fx.loaded,
      liveJobRequest(kind, {
        selection: CORPUS_SELECTION,
        scope: corpusScope(),
        sourceEvalsSha: RESOLVED_SHA,
      }),
    );
    const legacyPath = join(fx.loaded.paths.jobs, legacy.job_id, 'job.json');
    const legacyRecord = JSON.parse(readFileSync(legacyPath, 'utf8'));
    delete legacyRecord.credential_selection;
    delete legacyRecord.credential_scope;
    delete legacyRecord.credential_scope_source_evals_sha;
    writeFileSync(legacyPath, JSON.stringify(legacyRecord, null, 2));

    await expect(
      preflightLiveJob({
        loaded: fx.loaded,
        jobId: legacy.job_id,
        superpowersRef: 'main',
        runner,
      }),
    ).rejects.toMatchObject({
      code: 'config_invalid',
      step: 'preflight',
      message: expect.stringContaining('no credential scope'),
    });
    expect(readJob(fx.loaded, legacy.job_id).status).toBe('failed');
  }

  const emptyPath = join(fx.loaded.paths.jobs, liveJob(fx).job_id, 'job.json');
  const emptyRecord = JSON.parse(readFileSync(emptyPath, 'utf8'));
  emptyRecord.credential_scope = EMPTY_CREDENTIAL_SCOPE;
  writeFileSync(emptyPath, JSON.stringify(emptyRecord, null, 2));

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: emptyRecord.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({ code: 'config_invalid', step: 'preflight' });

  expect(runner.calls).toEqual([]);
});

test('a provenance fault leaves committed job evidence a retry heals without changing scope', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = liveJob(fx);

  // Fault the derived file only: the provenance namespace is a regular file,
  // so the atomic write cannot create its parent.
  rmSync(fx.loaded.paths.provenance, { recursive: true });
  writeFileSync(fx.loaded.paths.provenance, 'not a directory\n');

  await expect(
    preflightLiveJob({
      loaded: fx.loaded,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({ step: 'preflight' });

  // Job evidence was committed FIRST, and the authoritative scope is intact.
  const failed = readJob(fx.loaded, job.job_id);
  expect(failed.container?.id).toBe(LIVE_ID);
  expect(failed.refs?.evals_resolved_sha).toBe(RESOLVED_SHA);
  expect(failed.credential_bundle?.bundle_id).toBe('blessed-2026-06-18-a');
  expect(failed.credential_scope).toEqual(corpusScope());
  expect(exactContainerRemovals(runner)).toEqual([['rm', '-f', LIVE_ID]]);
  expect(existsSync(fx.activeDir)).toBe(false);

  // The retry heals only the derived file, from the job.
  rmSync(fx.loaded.paths.provenance);
  const path = writeProvenance(fx.loaded, job.job_id, {
    path: null,
    text: 'bun 1.3.13\n',
  });
  const provenance = JSON.parse(readFileSync(path, 'utf8'));
  expect(provenance.container.id).toBe(LIVE_ID);
  expect(provenance.credential_scope).toEqual(corpusScope());
  expect(readJob(fx.loaded, job.job_id).credential_scope).toEqual(
    corpusScope(),
  );
});

test('prepare stops after the empty probe and never evaluates the blessed bundle', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  // A bundle whose credential payload is unusable: prepare must never read it.
  rmSync(join(fx.bundleDir, 'credentials.env'));
  rmSync(join(fx.bundleDir, 'gemini'), { recursive: true });

  const result = await prepare({
    loaded: fx.loaded,
    superpowersRef: 'main',
    argv: ['prepare'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-4' },
    runner,
  });

  expect(containerTrace(runner)).toEqual([
    'docker exec --help',
    'wrapper build',
    'wrapper status',
    'wrapper up',
    `docker inspect ${PROBE_ID}`,
    'wrapper exec evals-tool-versions',
    'wrapper exec quorum check',
  ]);
  expect(result.container.id).toBe(PROBE_ID);

  // One asserted-empty generation: an empty agent env, no supervisor file, no
  // auth material at all.
  expect(readFileSync(join(fx.activeDir, 'agent.env'), 'utf8')).toBe('');
  expect(existsSync(join(fx.activeDir, 'supervisor.exec.env'))).toBe(false);
  expect(existsSync(join(fx.activeDir, 'auth'))).toBe(false);

  const jobs = readdirSync(fx.loaded.paths.jobs);
  expect(jobs).toHaveLength(1);
  const jobId = jobs[0] ?? '';
  const job = readJob(fx.loaded, jobId);
  expect(job.status).toBe('done');
  expect(job.credential_scope).toEqual(EMPTY_CREDENTIAL_SCOPE);
  const provenance = JSON.parse(readFileSync(result.provenance_path, 'utf8'));
  expect(provenance.credential_scope).toEqual(EMPTY_CREDENTIAL_SCOPE);
  expect(provenance.container.id).toBe(PROBE_ID);
});

test('a prepare provenance failure removes the exact probe container before retiring its material', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = createJob(fx.loaded, prepareJobRequest());
  rmSync(fx.loaded.paths.provenance, { recursive: true });
  writeFileSync(fx.loaded.paths.provenance, 'not a directory\n');

  await expect(
    prepare({
      loaded: fx.loaded,
      superpowersRef: 'main',
      argv: ['prepare'],
      requester: { agent: null },
      runner,
      jobId: job.job_id,
    }),
  ).rejects.toMatchObject({ code: 'config_invalid' });

  expect(exactContainerRemovals(runner)).toEqual([['rm', '-f', PROBE_ID]]);
  expect(existsSync(fx.activeDir)).toBe(false);
  expect(readJob(fx.loaded, job.job_id).status).toBe('failed');
});

test('prepare refuses a live job record instead of probing it', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  const job = liveJob(fx);

  await expect(
    prepare({
      loaded: fx.loaded,
      superpowersRef: 'main',
      argv: ['prepare'],
      requester: { agent: null },
      runner,
      jobId: job.job_id,
    }),
  ).rejects.toMatchObject({ code: 'config_invalid' });
  expect(dockerCalls(runner)).toEqual([]);
});

// A resumed prepare is identified by its whole credential triple, not by its
// kind alone: prepare asserts zero material and pins no cell, so a record
// claiming kind 'prepare' while carrying a selection, a scope, or a source
// SHA is not a prepare record. The triple is immutable through updateJob, so
// such a record can only arrive as a hand-edited, restored, or corrupted
// job.json — which is exactly what a resumed prepare reads back.
function rewritePrepareRecordRaw(
  fx: Fixture,
  jobId: string,
  patch: Record<string, unknown>,
): void {
  const path = join(fx.loaded.paths.jobs, jobId, 'job.json');
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(path, JSON.stringify({ ...record, ...patch }));
}

test('prepare refuses a resumed record that does not carry the exact prepare triple', async () => {
  const mutations: readonly {
    readonly what: string;
    readonly patch: Record<string, unknown>;
  }[] = [
    {
      what: 'a legacy record predating scoped delivery',
      patch: { credential_scope: null },
    },
    {
      what: 'a live scope smuggled onto a prepare record',
      patch: { credential_scope: corpusScope() },
    },
    {
      what: 'a credential selection',
      patch: { credential_selection: CORPUS_SELECTION },
    },
    {
      what: 'a pinned source evals SHA',
      patch: { credential_scope_source_evals_sha: RESOLVED_SHA },
    },
  ];

  for (const mutation of mutations) {
    const fx = fixture();
    const runner = new FakeRunner();
    seedMounts(fx, runner);
    const job = createJob(fx.loaded, prepareJobRequest());
    rewritePrepareRecordRaw(fx, job.job_id, mutation.patch);

    await expect(
      prepare({
        loaded: fx.loaded,
        superpowersRef: 'main',
        argv: ['prepare'],
        requester: { agent: null },
        runner,
        jobId: job.job_id,
      }),
    ).rejects.toMatchObject({ code: 'config_invalid', step: 'preflight' });

    // Refused before the probe: no container, and no scoped state at all.
    expect(`${mutation.what}: ${dockerCalls(runner).length}`).toBe(
      `${mutation.what}: 0`,
    );
    expect(existsSync(fx.scopedRoot)).toBe(false);
    expect(readJob(fx.loaded, job.job_id).status).toBe('failed');
  }
});

test('prepare probes a resumed record that carries the exact prepare triple', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  const job = createJob(fx.loaded, prepareJobRequest());

  const result = await prepare({
    loaded: fx.loaded,
    superpowersRef: 'main',
    argv: ['prepare'],
    requester: { agent: null },
    runner,
    jobId: job.job_id,
  });

  expect(result.container.id).toBe(PROBE_ID);
  const record = readJob(fx.loaded, job.job_id);
  expect(record.status).toBe('done');
  expect(record.credential_scope).toEqual(EMPTY_CREDENTIAL_SCOPE);
  expect(record.credential_selection).toBe(null);
  expect(record.credential_scope_source_evals_sha).toBe(null);
});

test('preflight maps container build failures to image_build_failed', async () => {
  const fx = fixture();
  const runner = new FakeRunner();
  seedMounts(fx, runner);
  runner.results.push({
    match: (command, args) =>
      command.endsWith('scripts/evals-container') && args.includes('build'),
    result: { status: 1, stdout: '', stderr: 'docker build failed' },
  });
  const job = createJob(fx.loaded, prepareJobRequest());

  await expect(
    prepare({
      loaded: fx.loaded,
      superpowersRef: 'main',
      argv: ['prepare'],
      requester: { agent: null },
      runner,
      jobId: job.job_id,
    }),
  ).rejects.toMatchObject({
    code: 'image_build_failed',
    step: 'container',
  });
  // prepare records the failure on the job it owns.
  const failed = readJob(fx.loaded, job.job_id);
  expect(failed.status).toBe('failed');
  expect(failed.error?.code).toBe('image_build_failed');
});

// Direct seam for the postflight quarantine contract: a dirty managed repo
// quarantines the job with the typed repo_dirty error; a clean tree returns
// null and leaves the record alone.
test('postflightDirtyCheck quarantines the job on a dirty managed repo', () => {
  const fx = fixture();
  const runner = new FakeRunner();
  const job = createJob(
    fx.loaded,
    prepareJobRequest({
      requester: { agent: 'codex', thread: 'thread-1', task: 'task-7' },
    }),
  );

  const clean = postflightDirtyCheck(fx.loaded, job.job_id, runner);
  expect(clean).toBe(null);
  expect(readJob(fx.loaded, job.job_id).status).toBe('preflighting');

  runner.results.push({
    match: (command, args) => command === 'git' && args.includes('status'),
    result: { status: 0, stdout: ' M mutated.txt\n', stderr: '' },
  });
  const dirty = postflightDirtyCheck(fx.loaded, job.job_id, runner);
  expect(dirty).toMatchObject({
    code: 'repo_dirty',
    message: `dirty worktree at ${fx.loaded.config.evals.path}: M mutated.txt`,
  });

  const updated = readJob(fx.loaded, job.job_id);
  expect(updated.status).toBe('quarantined');
  expect(updated.finished_at).not.toBe(null);
  expect(updated.result.summary).toBe(
    `postflight dirty check failed: dirty worktree at ${fx.loaded.config.evals.path}: M mutated.txt`,
  );
  expect(updated.error).toMatchObject({
    code: 'repo_dirty',
    message: `dirty worktree at ${fx.loaded.config.evals.path}: M mutated.txt`,
  });
});
