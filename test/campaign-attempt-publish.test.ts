import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AttemptPublicationStorageError,
  AttemptPublishError,
  publishAttempt,
} from '../src/campaign/attempt-publish.ts';

const sha = (body: string): string =>
  createHash('sha256').update(body).digest('hex');

const identity = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:s:b1',
  sample_id: 'c1:s:arm_a:r1',
  execution_attempt_id: 'c1:s:arm_a:r1:a1',
};

function staged(
  runId: string,
  opts: {
    files?: { path: string; body: string }[];
    campaign?: typeof identity;
  } = {},
): { attemptDir: string; resultsRoot: string } {
  const attemptDir = realpathSync(mkdtempSync(join(tmpdir(), 'publish-')));
  const resultsRoot = mkdtempSync(join(tmpdir(), 'results-'));
  const runDir = join(attemptDir, 'staging', runId);
  mkdirSync(runDir, { recursive: true });
  const files = opts.files ?? [
    { path: 'verdict.json', body: '{"final":"pass"}\n' },
  ];
  for (const file of files) {
    const parent = join(runDir, file.path, '..');
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(runDir, file.path), file.body);
  }
  const campaign = opts.campaign ?? identity;
  const manifest = {
    schema_version: 1,
    run_id: runId,
    campaign,
    files: files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.body),
      sha256: sha(file.body),
    })),
  };
  writeFileSync(
    join(runDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { attemptDir, resultsRoot };
}

function expectedAttemptId(): string {
  return identity.execution_attempt_id;
}

function clean(paths: { attemptDir: string; resultsRoot: string }): void {
  rmSync(paths.attemptDir, { recursive: true, force: true });
  rmSync(paths.resultsRoot, { recursive: true, force: true });
}

test('publish verifies the manifest and atomically moves the sole run directory', () => {
  const paths = staged('run-pub-1');
  try {
    const published = publishAttempt({
      ...paths,
      expectedAttemptId: expectedAttemptId(),
    });
    expect(published.runId).toBe('run-pub-1');
    expect(
      existsSync(join(paths.resultsRoot, 'run-pub-1', 'verdict.json')),
    ).toBe(true);
    expect(existsSync(join(paths.attemptDir, 'staging', 'run-pub-1'))).toBe(
      false,
    );
    expect(readdirSync(paths.resultsRoot)).toEqual(['run-pub-1']);
  } finally {
    clean(paths);
  }
});

test('publish rejects a missing or malformed manifest without moving staging', () => {
  const paths = staged('run-pub-2');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-2');
  try {
    rmSync(join(runDir, 'manifest.json'));
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(AttemptPublishError);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-2'))).toBe(false);

    writeFileSync(join(runDir, 'manifest.json'), '{not-json');
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(AttemptPublishError);
  } finally {
    clean(paths);
  }
});

test('publish rejects run-id and expected attempt-id mismatches', () => {
  const runIdPaths = staged('run-pub-3');
  const runIdManifest = JSON.parse(
    readFileSync(
      join(runIdPaths.attemptDir, 'staging', 'run-pub-3', 'manifest.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  runIdManifest['run_id'] = 'different-run';
  writeFileSync(
    join(runIdPaths.attemptDir, 'staging', 'run-pub-3', 'manifest.json'),
    JSON.stringify(runIdManifest),
  );
  try {
    expect(() =>
      publishAttempt({ ...runIdPaths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(/run.?id mismatch/);
    expect(
      existsSync(join(runIdPaths.attemptDir, 'staging', 'run-pub-3')),
    ).toBe(true);
  } finally {
    clean(runIdPaths);
  }

  const attemptPaths = staged('run-pub-4');
  try {
    expect(() =>
      publishAttempt({ ...attemptPaths, expectedAttemptId: 'wrong-attempt' }),
    ).toThrow(/attempt.?id mismatch/);
    expect(
      existsSync(join(attemptPaths.attemptDir, 'staging', 'run-pub-4')),
    ).toBe(true);
  } finally {
    clean(attemptPaths);
  }
});

test('publish rejects an unexpected allocated run before moving staging', () => {
  const paths = staged('run-pub-correlated');
  try {
    expect(() =>
      publishAttempt({
        ...paths,
        expectedAttemptId: expectedAttemptId(),
        expectedRunId: 'run-pub-observed',
      }),
    ).toThrow(/disagrees with the journaled allocation/);
    expect(
      existsSync(join(paths.attemptDir, 'staging', 'run-pub-correlated')),
    ).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-correlated'))).toBe(
      false,
    );
  } finally {
    clean(paths);
  }
});

test('publish does not retry or overwrite after the post-rename fsync cut', () => {
  const paths = staged('run-pub-fsync-cut');
  let renameCount = 0;
  const diskFull = new Error('opaque storage failure');
  try {
    let caught: unknown;
    expect(() => {
      try {
        publishAttempt({
          ...paths,
          expectedAttemptId: expectedAttemptId(),
          fsOps: {
            renameSync: (oldPath, newPath) => {
              renameCount += 1;
              renameSync(oldPath, newPath);
            },
            openSync,
            fsyncSync: () => {
              throw diskFull;
            },
            closeSync,
          },
        });
      } catch (error) {
        caught = error;
        throw error;
      }
    }).toThrow(/publication directory sync failed/);
    expect((caught as Error).cause).toBe(diskFull);
    expect(caught).toBeInstanceOf(AttemptPublicationStorageError);
    expect(renameCount).toBe(1);
    expect(
      existsSync(join(paths.resultsRoot, 'run-pub-fsync-cut', 'verdict.json')),
    ).toBe(true);
    expect(
      existsSync(join(paths.attemptDir, 'staging', 'run-pub-fsync-cut')),
    ).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish rejects tampering, unsafe paths, symlinks, and special files', () => {
  const digestPaths = staged('run-pub-5');
  writeFileSync(
    join(digestPaths.attemptDir, 'staging', 'run-pub-5', 'verdict.json'),
    '{"final":"fail"}\n',
  );
  try {
    expect(() =>
      publishAttempt({
        ...digestPaths,
        expectedAttemptId: expectedAttemptId(),
      }),
    ).toThrow(/digest mismatch/);
  } finally {
    clean(digestPaths);
  }

  const unsafePaths = staged('run-pub-6');
  writeFileSync(
    join(unsafePaths.attemptDir, 'staging', 'run-pub-6', 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: 'run-pub-6',
      campaign: identity,
      files: [{ path: '../escape', size: 1, sha256: sha('x') }],
    }),
  );
  try {
    expect(() =>
      publishAttempt({
        ...unsafePaths,
        expectedAttemptId: expectedAttemptId(),
      }),
    ).toThrow(AttemptPublishError);
  } finally {
    clean(unsafePaths);
  }

  const symlinkPaths = staged('run-pub-7');
  const outside = join(symlinkPaths.attemptDir, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  rmSync(join(symlinkPaths.attemptDir, 'staging', 'run-pub-7', 'verdict.json'));
  symlinkSync(
    outside,
    join(symlinkPaths.attemptDir, 'staging', 'run-pub-7', 'link.txt'),
  );
  writeFileSync(
    join(symlinkPaths.attemptDir, 'staging', 'run-pub-7', 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: 'run-pub-7',
      campaign: identity,
      files: [{ path: 'link.txt', size: 8, sha256: sha('outside\n') }],
    }),
  );
  try {
    expect(() =>
      publishAttempt({
        ...symlinkPaths,
        expectedAttemptId: expectedAttemptId(),
      }),
    ).toThrow(/non-regular|missing/);
  } finally {
    clean(symlinkPaths);
  }
});

test('publish rejects a symlinked intermediate path to an external artifact', () => {
  const paths = staged('run-pub-12', {
    files: [{ path: 'nested/result.json', body: '{"final":"pass"}\n' }],
  });
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-12');
  const outside = join(paths.attemptDir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'result.json'), '{"final":"pass"}\n');
  rmSync(join(runDir, 'nested'), { recursive: true });
  symlinkSync(outside, join(runDir, 'nested'));
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(AttemptPublishError);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-12'))).toBe(false);
    expect(readFileSync(join(outside, 'result.json'), 'utf8')).toBe(
      '{"final":"pass"}\n',
    );
  } finally {
    clean(paths);
  }
});

test('publish rejects a size mismatch without moving staging', () => {
  const paths = staged('run-pub-13');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-13');
  writeFileSync(join(runDir, 'verdict.json'), 'short\n');
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(/size mismatch/);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-13'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish rejects a listed FIFO as a non-regular artifact', () => {
  const paths = staged('run-pub-14');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-14');
  const fifo = join(runDir, 'pipe');
  rmSync(join(runDir, 'verdict.json'));
  execFileSync('mkfifo', [fifo]);
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: 'run-pub-14',
      campaign: identity,
      files: [{ path: 'pipe', size: 0, sha256: sha('') }],
    }),
  );
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(/non-regular/);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-14'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish rejects multiple staging entries and an existing destination', () => {
  const multiplePaths = staged('run-pub-8');
  mkdirSync(join(multiplePaths.attemptDir, 'staging', 'run-pub-8b'));
  try {
    expect(() =>
      publishAttempt({
        ...multiplePaths,
        expectedAttemptId: expectedAttemptId(),
      }),
    ).toThrow(/exactly one/);
  } finally {
    clean(multiplePaths);
  }

  const existingPaths = staged('run-pub-9');
  mkdirSync(join(existingPaths.resultsRoot, 'run-pub-9'));
  try {
    expect(() =>
      publishAttempt({
        ...existingPaths,
        expectedAttemptId: expectedAttemptId(),
      }),
    ).toThrow(AttemptPublishError);
    expect(
      existsSync(join(existingPaths.attemptDir, 'staging', 'run-pub-9')),
    ).toBe(true);
    expect(
      lstatSync(join(existingPaths.resultsRoot, 'run-pub-9')).isDirectory(),
    ).toBe(true);
  } finally {
    clean(existingPaths);
  }
});

test('publish rejects a symlinked manifest without moving staging', () => {
  const paths = staged('run-pub-11');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-11');
  const outside = join(paths.attemptDir, 'manifest.json');
  try {
    writeFileSync(outside, readFileSync(join(runDir, 'manifest.json')));
    rmSync(join(runDir, 'manifest.json'));
    symlinkSync(outside, join(runDir, 'manifest.json'));
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(AttemptPublishError);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-11'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish rejects a symlinked staging anchor without moving its source', () => {
  const paths = staged('run-pub-16');
  const staging = join(paths.attemptDir, 'staging');
  const movedStaging = join(paths.attemptDir, 'home');
  renameSync(staging, movedStaging);
  symlinkSync(movedStaging, staging);
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(AttemptPublishError);
    expect(existsSync(join(movedStaging, 'run-pub-16', 'verdict.json'))).toBe(
      true,
    );
    expect(existsSync(join(paths.resultsRoot, 'run-pub-16'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish rejects every unlisted artifact, including a home marker', () => {
  const paths = staged('run-pub-15');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-15');
  mkdirSync(join(runDir, 'home'), { recursive: true });
  writeFileSync(join(runDir, 'home', 'marker'), 'must not publish\n');
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(AttemptPublishError);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-15'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish requires the explicit expected attempt id', () => {
  const paths = staged('run-pub-10');
  try {
    expect(() => publishAttempt({ ...paths, expectedAttemptId: '' })).toThrow(
      AttemptPublishError,
    );
  } finally {
    clean(paths);
  }
});

import { publishExecution } from '../src/campaign/attempt-publish.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import type { ObserverBinding } from '../src/experiments/observer/binding.ts';
import {
  freezeObserverBundle,
  readObserverBundle,
} from '../src/experiments/observer/bundle.ts';
import { writeAttemptManifest } from '../src/runner/manifest.ts';
import {
  blockActivation,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

test('V2 publication authenticates full identity and returns immutable byte references only after death', () => {
  const experiment = twoArmExperiment();
  const intent = blockActivation(experiment).attempts[0]!;
  const paths = staged('run-v2', { campaign: intent.identity });
  intent.output_root = paths.attemptDir;
  const bound = { intent, container_id: 'a'.repeat(64) };
  const stopped = {
    execution_attempt_id: intent.identity.execution_attempt_id,
    container_id: bound.container_id,
    proof: 'inspected_stopped' as const,
    observed_at: new Date().toISOString(),
  };
  expect(() =>
    publishExecution({
      experiment: twoArmExperiment(),
      bound,
      stopped: { ...stopped, container_id: 'b'.repeat(64) },
      resultsRoot: paths.resultsRoot,
    }),
  ).toThrow();
  const published = publishExecution({
    experiment,
    bound,
    stopped,
    resultsRoot: paths.resultsRoot,
  });
  for (const ref of published.artifacts) {
    const bytes = readFileSync(join(paths.resultsRoot, ref.path));
    expect(bytes.length).toBe(ref.bytes);
    expect(sha(bytes.toString())).toBe(ref.sha256);
  }
  expect(published.runId).toBe('run-v2');
  expect(published.artifacts).toContainEqual({
    path: 'run-v2/verdict.json',
    sha256: sha('{"final":"pass"}\n'),
    bytes: 17,
  });
  expect(
    published.artifacts.some((a) => a.path === 'run-v2/manifest.json'),
  ).toBe(true);
  clean(paths);
});

test('V2 publication refuses a foreign campaign with a matching attempt id', () => {
  const paths = staged('foreign', {
    campaign: { ...identity, campaign_id: 'foreign' },
  });
  const intent = blockActivation(twoArmExperiment()).attempts[0]!;
  intent.identity = identity;
  intent.output_root = paths.attemptDir;
  const bound = { intent, container_id: 'a'.repeat(64) };
  expect(() =>
    publishExecution({
      experiment: twoArmExperiment(),
      bound,
      stopped: {
        execution_attempt_id: identity.execution_attempt_id,
        container_id: bound.container_id,
        proof: 'inspected_stopped',
        observed_at: new Date().toISOString(),
      },
      resultsRoot: paths.resultsRoot,
    }),
  ).toThrow();
  expect(existsSync(join(paths.attemptDir, 'staging', 'foreign'))).toBe(true);
  clean(paths);
});

function observerPublication(
  empty = false,
  options: {
    nativeTrace?: boolean;
    configureBinding?: (binding: ObserverBinding) => void;
  } = {},
) {
  const cliVersion = options.nativeTrace ? '0.146.0' : '0.144.3';
  const experiment = twoArmExperiment();
  for (const arm of experiment.execution_surface) arm.agent = 'codex';
  const scenario = 'brainstorming-todo-shared-intent';
  experiment.suite.comparisons[0]!.scenarios = [scenario];
  experiment.cells[0]!.scenario = scenario;
  for (const slot of experiment.planned_slots) slot.scenario = scenario;
  experiment.reserve_slots = [];
  experiment.suite.reserve = 0;
  experiment.suite.attempt_bounds.max_attempts = 1;
  const intent = blockActivation(experiment).attempts[0]!;
  intent.identity.execution_attempt_id = `${intent.identity.sample_id}:a1`;
  const paths = staged('observed', { campaign: intent.identity });
  const original = intent.output_root;
  Object.assign(
    intent,
    JSON.parse(JSON.stringify(intent).replaceAll(original, paths.attemptDir)),
  );
  intent.runtime_spec_digest = sha256Hex(jcsCanonicalize(intent.runtime_spec));
  const runDir = join(paths.attemptDir, 'staging', 'observed');
  const workdir = join(runDir, 'coding-agent-workdir');
  const home = join(paths.attemptDir, 'home');
  const transcripts = join(home, '.codex', 'sessions');
  const evidenceDir = join(runDir, 'brainstorming-evidence');
  for (const dir of [
    workdir,
    transcripts,
    evidenceDir,
    join(runDir, 'gauntlet-agent'),
  ])
    mkdirSync(dir, { recursive: true });
  for (const path of [
    '.git/branches',
    '.git/refs/empty',
    'node_modules/package/empty',
  ])
    mkdirSync(join(workdir, path), { recursive: true });
  if (empty) mkdirSync(join(workdir, 'empty', 'nested'), { recursive: true });
  else writeFileSync(join(workdir, 'artifact.txt'), 'terminal artifact');
  const sourcePath = join(transcripts, 'parent.jsonl');
  writeFileSync(
    sourcePath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'session',
        cwd: workdir,
        cli_version: cliVersion,
        source: 'cli',
        originator: 'codex-tui',
        thread_source: 'user',
      },
    })}\n`,
  );
  const stats = statSync(sourcePath, { bigint: true });
  const binding: ObserverBinding = {
    schema_version: 2,
    run_id: 'observed',
    campaign: intent.identity,
    runtime: 'codex',
    dialect: `codex-response-items-${cliVersion}`,
    cli_version: cliVersion,
    home,
    workdir,
    launch_cwd: workdir,
    phase: 'bound',
    parent_source_id: 'parent',
    roots: [
      { id: 'transcripts', kind: 'transcripts', path: transcripts },
      { id: 'artifacts', kind: 'artifacts', path: workdir },
    ],
    sources: [
      {
        source: {
          source_id: 'parent',
          runtime: 'codex',
          expected_session_id: 'session',
          expected_cwd: workdir,
          expected_cli_version: cliVersion,
        },
        root_id: 'transcripts',
        relative_path: 'parent.jsonl',
        device: stats.dev.toString(),
        inode: stats.ino.toString(),
        parent_link: null,
      },
    ],
  };
  if (options.nativeTrace) {
    const traceRoot = join(home, '.codex', 'rollout-traces');
    binding.roots.push({
      id: 'tool-trace',
      kind: 'tool_trace',
      path: traceRoot,
    });
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          './fixtures/observer/codex-0.146.0-trace-text.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      manifest: string;
      trace: string;
      payloads: Record<string, string>;
    };
    const nativeSession: string = JSON.parse(fixture.manifest).root_thread_id;
    for (const [path, content] of Object.entries({
      'manifest.json': fixture.manifest,
      'trace.jsonl': fixture.trace,
      ...fixture.payloads,
    })) {
      const member = join(traceRoot, 'bundle', path);
      mkdirSync(dirname(member), { recursive: true });
      writeFileSync(
        member,
        content
          .replaceAll(nativeSession, 'session')
          .replaceAll('/capture/codex-parent/workdir', workdir),
      );
    }
  }
  options.configureBinding?.(binding);
  const bindingPath = join(runDir, 'gauntlet-agent', 'observer-binding.json');
  writeFileSync(bindingPath, JSON.stringify(binding));
  freezeObserverBundle(binding, evidenceDir);
  writeAttemptManifest(runDir, intent.identity);
  const bound = { intent, container_id: 'a'.repeat(64) };
  const stopped = {
    execution_attempt_id: intent.identity.execution_attempt_id,
    container_id: bound.container_id,
    proof: 'inspected_stopped' as const,
    observed_at: new Date().toISOString(),
  };
  return {
    ...paths,
    runDir,
    bindingPath,
    binding,
    evidenceDir,
    sourcePath,
    args: { experiment, bound, stopped, resultsRoot: paths.resultsRoot },
  };
}

test('required observer publication accepts unchanged external HOME without publishing home', () => {
  const f = observerPublication();
  try {
    const published = publishExecution(f.args);
    expect(published.runId).toBe('observed');
    expect(existsSync(join(f.resultsRoot, 'observed', 'home'))).toBe(false);
    expect(existsSync(f.sourcePath)).toBe(true);
  } finally {
    clean(f);
  }
});
test.each([
  'source-append',
  'candidate-missing',
  'binding-missing',
  'forged-root',
  'mount-mismatch',
  'manifest-missing',
  'partial-freeze',
])('required observer publication refuses %s without repairing evidence', (change) => {
  const f = observerPublication();
  try {
    const manifest = readFileSync(join(f.runDir, 'manifest.json'));
    const candidate = join(f.evidenceDir, 'bundle', 'observer-bundle.json');
    const before = readFileSync(candidate);
    if (change === 'source-append') appendFileSync(f.sourcePath, '{}\n');
    if (change === 'candidate-missing')
      rmSync(join(f.evidenceDir, 'bundle'), { recursive: true });
    if (change === 'binding-missing') rmSync(f.bindingPath);
    if (change === 'forged-root') {
      f.binding.home = join(f.attemptDir, 'foreign');
      f.binding.roots[0]!.path = join(f.binding.home, '.codex', 'sessions');
      writeFileSync(f.bindingPath, JSON.stringify(f.binding));
    }
    if (change === 'mount-mismatch') {
      f.args.bound.intent.runtime_spec.mounts[0]!.source = '/outside';
      f.args.bound.intent.runtime_spec_digest = sha256Hex(
        jcsCanonicalize(f.args.bound.intent.runtime_spec),
      );
    }
    if (change === 'manifest-missing') rmSync(join(f.runDir, 'manifest.json'));
    if (change === 'partial-freeze')
      renameSync(
        join(f.evidenceDir, 'bundle'),
        join(f.evidenceDir, '.bundle-stage'),
      );
    expect(() => publishExecution(f.args)).toThrow();
    expect(existsSync(f.runDir)).toBe(true);
    expect(readdirSync(f.resultsRoot)).toEqual([]);
    if (existsSync(candidate)) expect(readFileSync(candidate)).toEqual(before);
    if (change !== 'manifest-missing')
      expect(readFileSync(join(f.runDir, 'manifest.json'))).toEqual(manifest);
  } finally {
    clean(f);
  }
});

test('authenticated empty artifact directories survive publication', () => {
  const f = observerPublication(true);
  try {
    publishExecution(f.args);
    expect(
      existsSync(
        join(
          f.resultsRoot,
          'observed',
          'coding-agent-workdir',
          'empty',
          'nested',
        ),
      ),
    ).toBe(true);
  } finally {
    clean(f);
  }
});
test.each([
  'add',
  'delete',
])('changed empty artifact directory %s refuses publication', (change) => {
  const f = observerPublication(true);
  try {
    if (change === 'add') mkdirSync(join(f.binding.workdir, 'added'));
    else rmSync(join(f.binding.workdir, 'empty'), { recursive: true });
    expect(() => publishExecution(f.args)).toThrow();
    expect(existsSync(f.runDir)).toBe(true);
  } finally {
    clean(f);
  }
});
test('direct directory inventory cannot authorize paths outside artifact workdir', () => {
  for (const path of [
    '../escape',
    'home',
    'coding-agent-workdir/../escape',
    '/absolute',
  ]) {
    const f = staged('directory-path');
    try {
      expect(() =>
        publishAttempt({
          ...f,
          expectedAttemptId: expectedAttemptId(),
          artifactDirectories: [path],
        }),
      ).toThrow();
      expect(readdirSync(f.resultsRoot)).toEqual([]);
    } finally {
      clean(f);
    }
  }
});

test('observer runtime must match the frozen arm selection', () => {
  const f = observerPublication();
  try {
    f.args.experiment.execution_surface[0]!.agent = 'claude';
    expect(() => publishExecution(f.args)).toThrow();
    expect(existsSync(f.runDir)).toBe(true);
  } finally {
    clean(f);
  }
});

test.each([
  'added',
  'deleted',
  'replaced',
  'symlink',
  'file-added',
])('excluded tree %s refuses publication without changing immutable evidence', (change) => {
  const f = observerPublication();
  try {
    const path = join(f.binding.workdir, 'node_modules/package/empty');
    const manifest = readFileSync(join(f.runDir, 'manifest.json'));
    const candidatePath = join(f.evidenceDir, 'bundle/observer-bundle.json');
    const candidate = readFileSync(candidatePath);
    if (change === 'added') mkdirSync(join(path, 'late'));
    else if (change === 'file-added')
      writeFileSync(join(path, 'unlisted.js'), 'unlisted bytes');
    else {
      renameSync(path, join(f.attemptDir, 'old-directory'));
      if (change === 'replaced') mkdirSync(path);
      if (change === 'symlink')
        symlinkSync(join(f.attemptDir, 'old-directory'), path);
    }
    expect(() => publishExecution(f.args)).toThrow();
    expect(readFileSync(candidatePath)).toEqual(candidate);
    expect(readFileSync(join(f.runDir, 'manifest.json'))).toEqual(manifest);
    expect(readdirSync(f.resultsRoot)).toEqual([]);
  } finally {
    clean(f);
  }
});

test('Codex 0.146 publication retains authenticated native trace members without publishing HOME', () => {
  const f = observerPublication(false, { nativeTrace: true });
  try {
    const sourceTrace = join(
      f.binding.home,
      '.codex/rollout-traces/bundle/trace.jsonl',
    );
    const traceBytes = readFileSync(sourceTrace);
    const published = publishExecution(f.args);
    expect(published.runId).toBe('observed');
    expect(existsSync(join(f.resultsRoot, 'observed', 'home'))).toBe(false);
    expect(readFileSync(sourceTrace)).toEqual(traceBytes);
    const bundle = readObserverBundle(
      realpathSync(
        join(f.resultsRoot, 'observed', 'brainstorming-evidence/bundle'),
      ),
    );
    const member = bundle.supporting_files.find(
      (file) =>
        file.root_id === 'tool-trace' &&
        file.relative_path === 'bundle/trace.jsonl',
    );
    expect(member).toBeDefined();
    expect(
      readFileSync(
        join(
          f.resultsRoot,
          'observed',
          'brainstorming-evidence/bundle',
          member!.path,
        ),
      ),
    ).toEqual(traceBytes);
  } finally {
    clean(f);
  }
});

test.each([
  'missing-trace',
  'extra-transcripts',
] as const)('native observer publication rejects %s from an otherwise frozen candidate', (change) => {
  const f = observerPublication(false, {
    nativeTrace: true,
    configureBinding(binding) {
      if (change === 'missing-trace')
        binding.roots = binding.roots.filter(
          (root) => root.kind !== 'tool_trace',
        );
      else {
        const path = join(binding.home, '.codex/other-sessions');
        mkdirSync(path, { recursive: true });
        binding.roots.push({
          id: 'extra-transcripts',
          kind: 'transcripts',
          path,
        });
      }
    },
  });
  try {
    expect(() => publishExecution(f.args)).toThrow();
    expect(existsSync(f.runDir)).toBe(true);
    expect(readdirSync(f.resultsRoot)).toEqual([]);
  } finally {
    clean(f);
  }
});

test('native observer publication rejects a forged trace root without moving staging', () => {
  const f = observerPublication(false, { nativeTrace: true });
  try {
    f.binding.roots.find((root) => root.kind === 'tool_trace')!.path = join(
      f.binding.home,
      'foreign-traces',
    );
    writeFileSync(f.bindingPath, JSON.stringify(f.binding));
    expect(() => publishExecution(f.args)).toThrow();
    expect(existsSync(f.runDir)).toBe(true);
    expect(readdirSync(f.resultsRoot)).toEqual([]);
  } finally {
    clean(f);
  }
});
