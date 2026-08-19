import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
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
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { toErrorJson } from '../src/appliance/errors.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import {
  postflightDirtyCheck,
  preflightForJob,
  prepare,
} from '../src/appliance/preflight.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

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

  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    const configured = this.results.find((entry) => entry.match(command, args));
    if (configured !== undefined) {
      return configured.result;
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
      return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('cat-file')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'docker' &&
      args[0] === 'container' &&
      args[1] === 'inspect'
    ) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { Id: 'container-id-1', Image: 'sha256:image-id-1' },
        ]),
        stderr: '',
      };
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
      args.includes('exec') &&
      args.includes('evals-tool-versions')
    ) {
      return { status: 0, stdout: 'bun 1.3.13\n', stderr: '' };
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
  // Canonical (realpath) fixture root: the appliance boundary validates
  // every absolute path component no-follow, and macOS tmpdir paths
  // traverse the /var symlink.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'appliance-preflight-')),
  );
  for (const dir of [
    'superpowers-evals/scripts',
    'superpowers-evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed/codex',
    'credentials/blessed/gemini',
    'credentials/blessed/kimi-code',
    'credentials/blessed/pi',
    'state/jobs',
    'state/locks',
    'state/provenance',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(
    join(root, 'superpowers-evals/scripts/evals-container'),
    '#!/usr/bin/env bash\n',
  );
  writeFileSync(join(root, 'credentials/blessed/credentials.env'), 'KEY=x\n');
  return {
    configPath: join(root, 'config/appliance.json'),
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
}

function commandSubsequence(
  calls: readonly {
    readonly command: string;
    readonly args: readonly string[];
  }[],
): string[] {
  return calls.map((call) => {
    if (call.command.endsWith('scripts/evals-container')) {
      return call.args[call.args.length - 1] ?? '';
    }
    if (call.command === 'git') {
      return call.args.includes('fetch')
        ? `git fetch ${call.args[1]}`
        : `git ${call.args.at(-1)}`;
    }
    return call.command;
  });
}

test('preflight shells through evals-container with blessed credentials and records provenance', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'prepare',
    superpowersRef: 'main',
    argv: ['evals-appliance', 'prepare', '--superpowers-ref', 'main'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-4' },
  });

  const result = await preflightForJob({
    loaded: cfg,
    jobId: job.job_id,
    superpowersRef: 'main',
    runner,
  });

  const evalsContainerCalls = runner.calls.filter((call) =>
    call.command.endsWith('scripts/evals-container'),
  );
  const buildCall = evalsContainerCalls.find((call) =>
    call.args.includes('build'),
  );
  expect(buildCall?.args).toEqual([
    '--name',
    'quorum-appliance',
    '--gauntlet-root',
    cfg.config.gauntlet.path,
    'build',
  ]);
  expect(evalsContainerCalls.some((call) => call.args.at(-1) === 'up')).toBe(
    true,
  );
  const downCall = evalsContainerCalls.find((call) =>
    call.args.includes('down'),
  );
  expect(downCall?.args).toEqual(['--name', 'quorum-appliance', 'down']);
  expect(
    evalsContainerCalls.some((call) => call.args.at(-1) === 'status'),
  ).toBe(true);
  expect(
    evalsContainerCalls.some(
      (call) =>
        call.args.includes('exec') && call.args.includes('evals-tool-versions'),
    ),
  ).toBe(true);
  expect(
    evalsContainerCalls.some(
      (call) =>
        call.args.includes('exec') &&
        call.args.includes('quorum') &&
        call.args.includes('check'),
    ),
  ).toBe(true);
  expect(commandSubsequence(evalsContainerCalls)).toEqual([
    'build',
    'status',
    'down',
    'up',
    'status',
    'evals-tool-versions',
    'check',
  ]);

  expect(result.credential_bundle.bundle_id).toBe('blessed-2026-06-18-a');
  expect(result.refs.superpowers_resolved_sha).toBe('a'.repeat(40));
  expect(result.container.id).toBe('container-id-1');
  expect(result.container.image_id).toBe('sha256:image-id-1');
  expect(result.container.mount_signature).toMatch(/^[0-9a-f]{64}$/);
  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('preflighting');
  expect(updated.refs?.superpowers_resolved_sha).toBe('a'.repeat(40));
  expect(updated.credential_bundle?.bundle_id).toBe('blessed-2026-06-18-a');
  expect(updated.container?.name).toBe('quorum-appliance');
  expect(updated.container?.id).toBe('container-id-1');
  expect(updated.container?.image_id).toBe('sha256:image-id-1');
  expect(readFileSync(result.tool_versions_path, 'utf8')).toBe('bun 1.3.13\n');
  expect(statSync(result.tool_versions_path).mode & 0o777).toBe(0o600);

  const provenance = JSON.parse(
    readFileSync(updated.artifacts.provenance, 'utf8'),
  );
  expect(provenance.job_id).toBe(job.job_id);
  expect(provenance.container.id).toBe('container-id-1');
  expect(provenance.container.image_id).toBe('sha256:image-id-1');
  expect(provenance.command_argv).toEqual([
    'evals-appliance',
    'prepare',
    '--superpowers-ref',
    'main',
  ]);
  expect(provenance.container.code_mounts_read_only).toBe(false);
});

test('preflight copies provenance beside a known batch artifact when the directory exists', async () => {
  const cfg = loaded();
  mkdirSync(join(cfg.config.container.results_root, 'batches/batch-1'), {
    recursive: true,
  });
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['evals-appliance', 'run-all', '--', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      batch_id: 'batch-1',
    },
  }));

  await preflightForJob({
    loaded: cfg,
    jobId: job.job_id,
    superpowersRef: 'main',
    runner,
  });

  const artifactProvenance = join(
    cfg.config.container.results_root,
    'batches/batch-1/appliance-provenance.json',
  );
  expect(existsSync(artifactProvenance)).toBe(true);
  const jobProvenance = JSON.parse(
    readFileSync(join(cfg.paths.provenance, `${job.job_id}.json`), 'utf8'),
  );
  expect(JSON.parse(readFileSync(artifactProvenance, 'utf8'))).toEqual(
    jobProvenance,
  );
});

test('preflight maps container build failures to image_build_failed', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  runner.results.push({
    match: (command, args) =>
      command.endsWith('scripts/evals-container') && args.includes('build'),
    result: { status: 1, stdout: '', stderr: 'docker build failed' },
  });
  const job = createJob(cfg, {
    kind: 'prepare',
    superpowersRef: 'main',
    argv: ['evals-appliance', 'prepare'],
    requester: { agent: null, thread: null, task: null },
  });

  await expect(
    preflightForJob({
      loaded: cfg,
      jobId: job.job_id,
      superpowersRef: 'main',
      runner,
    }),
  ).rejects.toMatchObject({
    code: 'image_build_failed',
    step: 'container',
  });
});

// Through Tasks 2-4 the production prepare action is frozen behind the scoped
// credential cutover guard: it refuses with the exact typed error BEFORE
// creating a job, acquiring locks, or calling the runner. The lock-busy
// failed-job recording and the postflight quarantine flow this entry point
// used to exercise return in Task 5 with the guard's removal; the postflight
// quarantine contract itself stays covered below through its direct seam.
test('prepare refuses with the typed scoped-cutover error before any state mutation', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();

  let caught: unknown = null;
  try {
    await prepare({
      loaded: cfg,
      superpowersRef: 'main',
      argv: ['prepare'],
      requester: { agent: 'codex', thread: 'thread-1', task: 'task-7' },
      runner,
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    code: 'config_invalid',
    step: 'scoped-cutover',
    message: expect.stringContaining('scoped credential cutover incomplete'),
  });
  expect(toErrorJson(caught)).toMatchObject({
    ok: false,
    error: { code: 'config_invalid', step: 'scoped-cutover' },
  });
  expect(readdirSync(cfg.paths.jobs)).toHaveLength(0);
  expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
  expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
  expect(runner.calls).toHaveLength(0);
});

// Direct seam for the postflight quarantine contract (previously reached via
// prepare()): a dirty managed repo quarantines the job with the typed
// repo_dirty error; a clean tree returns null and leaves the record alone.
test('postflightDirtyCheck quarantines the job on a dirty managed repo', () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'prepare',
    superpowersRef: 'main',
    argv: ['prepare'],
    requester: { agent: 'codex', thread: 'thread-1', task: 'task-7' },
  });

  const clean = postflightDirtyCheck(cfg, job.job_id, runner);
  expect(clean).toBe(null);
  expect(readJob(cfg, job.job_id).status).toBe('preflighting');

  runner.results.push({
    match: (command, args) => command === 'git' && args.includes('status'),
    result: { status: 0, stdout: ' M mutated.txt\n', stderr: '' },
  });
  const dirty = postflightDirtyCheck(cfg, job.job_id, runner);
  expect(dirty).toMatchObject({
    code: 'repo_dirty',
    message: `dirty worktree at ${cfg.config.evals.path}: M mutated.txt`,
  });

  const updated = readJob(cfg, job.job_id);
  expect(updated.status).toBe('quarantined');
  expect(updated.finished_at).not.toBe(null);
  expect(updated.result.summary).toBe(
    `postflight dirty check failed: dirty worktree at ${cfg.config.evals.path}: M mutated.txt`,
  );
  expect(updated.error).toMatchObject({
    code: 'repo_dirty',
    message: `dirty worktree at ${cfg.config.evals.path}: M mutated.txt`,
  });
});
