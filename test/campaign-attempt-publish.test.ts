import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('publish tolerates empty placeholder directories beside listed files', () => {
  // Gauntlet leaves screenshots/ and artifacts/ under its results dir; git
  // leaves refs/tags, objects/pack and objects/info. Their parents are listed
  // through real files; the leaves are empty and carry no evidence bytes.
  const paths = staged('run-pub-17', {
    files: [
      { path: 'verdict.json', body: '{"final":"pass"}\n' },
      { path: 'gauntlet-agent/results/r1/run.jsonl', body: '{"event":"x"}\n' },
      { path: 'coding-agent-workdir/.git/refs/heads/main', body: 'abc\n' },
    ],
  });
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-17');
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', 'r1', 'screenshots'));
  mkdirSync(join(runDir, 'gauntlet-agent', 'results', 'r1', 'artifacts'));
  mkdirSync(join(runDir, 'coding-agent-workdir', '.git', 'refs', 'tags'));
  try {
    const published = publishAttempt({
      ...paths,
      expectedAttemptId: expectedAttemptId(),
    });
    expect(published.runId).toBe('run-pub-17');
    expect(
      existsSync(join(paths.resultsRoot, 'run-pub-17', 'verdict.json')),
    ).toBe(true);
    expect(
      existsSync(
        join(
          paths.resultsRoot,
          'run-pub-17',
          'gauntlet-agent',
          'results',
          'r1',
          'screenshots',
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(paths.attemptDir, 'staging', 'run-pub-17'))).toBe(
      false,
    );
  } finally {
    clean(paths);
  }
});

test('publish still rejects an unlisted directory that holds anything', () => {
  const paths = staged('run-pub-18');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-18');
  mkdirSync(join(runDir, 'scratch', 'nested'), { recursive: true });
  writeFileSync(join(runDir, 'scratch', 'nested', 'marker'), 'no\n');
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(/unlisted artifact refused: scratch/);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-18'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish still rejects an unlisted symlink even when it points at an empty directory', () => {
  const paths = staged('run-pub-19');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-19');
  const outside = mkdtempSync(join(tmpdir(), 'empty-target-'));
  symlinkSync(outside, join(runDir, 'linked'));
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(/unlisted artifact refused: linked/);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-19'))).toBe(false);
  } finally {
    clean(paths);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('publish accepts a listed symlink whose target matches exactly', () => {
  const paths = staged('run-pub-20', {
    files: [
      { path: 'verdict.json', body: '{"final":"pass"}\n' },
      { path: 'coding-agent-workdir/node_modules/vite-bin.js', body: 'x\n' },
    ],
  });
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-20');
  mkdirSync(join(runDir, 'coding-agent-workdir', 'node_modules', '.bin'));
  symlinkSync(
    '../vite-bin.js',
    join(runDir, 'coding-agent-workdir', 'node_modules', '.bin', 'vite'),
  );
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.symlinks = [
    {
      path: 'coding-agent-workdir/node_modules/.bin/vite',
      target: '../vite-bin.js',
    },
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const published = publishAttempt({
      ...paths,
      expectedAttemptId: expectedAttemptId(),
    });
    expect(published.runId).toBe('run-pub-20');
    const moved = join(
      paths.resultsRoot,
      'run-pub-20',
      'coding-agent-workdir',
      'node_modules',
      '.bin',
      'vite',
    );
    expect(lstatSync(moved).isSymbolicLink()).toBe(true);
    expect(readlinkSync(moved)).toBe('../vite-bin.js');
  } finally {
    clean(paths);
  }
});

test('publish refuses a listed symlink whose target changed', () => {
  const paths = staged('run-pub-21', {
    files: [
      { path: 'verdict.json', body: '{"final":"pass"}\n' },
      { path: 'coding-agent-workdir/node_modules/vite-bin.js', body: 'x\n' },
    ],
  });
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-21');
  mkdirSync(join(runDir, 'coding-agent-workdir', 'node_modules', '.bin'));
  symlinkSync(
    '../other.js',
    join(runDir, 'coding-agent-workdir', 'node_modules', '.bin', 'vite'),
  );
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.symlinks = [
    {
      path: 'coding-agent-workdir/node_modules/.bin/vite',
      target: '../vite-bin.js',
    },
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(
      /altered symlink refused: coding-agent-workdir\/node_modules\/\.bin\/vite/,
    );
    expect(existsSync(join(paths.resultsRoot, 'run-pub-21'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish still refuses an unlisted symlink', () => {
  const paths = staged('run-pub-22');
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-22');
  symlinkSync('present-target', join(runDir, 'linked'));
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(/unlisted artifact refused: linked/);
    expect(existsSync(join(paths.resultsRoot, 'run-pub-22'))).toBe(false);
  } finally {
    clean(paths);
  }
});

test('publish refuses a manifest-listed symlink that is missing from staging', () => {
  const paths = staged('run-pub-23', {
    files: [
      { path: 'verdict.json', body: '{"final":"pass"}\n' },
      { path: 'coding-agent-workdir/node_modules/vite-bin.js', body: 'x\n' },
    ],
  });
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-23');
  mkdirSync(join(runDir, 'coding-agent-workdir', 'node_modules', '.bin'));
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.symlinks = [
    {
      path: 'coding-agent-workdir/node_modules/.bin/vite',
      target: '../vite-bin.js',
    },
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(
      /manifest lists a missing or non-symlink entry: coding-agent-workdir\/node_modules\/\.bin\/vite/,
    );
    expect(existsSync(join(paths.resultsRoot, 'run-pub-23'))).toBe(false);
    expect(existsSync(runDir)).toBe(true);
  } finally {
    clean(paths);
  }
});

test('publish refuses a manifest-listed symlink path that is a regular file', () => {
  const paths = staged('run-pub-24', {
    files: [
      { path: 'verdict.json', body: '{"final":"pass"}\n' },
      { path: 'coding-agent-workdir/node_modules/vite-bin.js', body: 'x\n' },
    ],
  });
  const runDir = join(paths.attemptDir, 'staging', 'run-pub-24');
  mkdirSync(join(runDir, 'coding-agent-workdir', 'node_modules', '.bin'));
  writeFileSync(
    join(runDir, 'coding-agent-workdir', 'node_modules', '.bin', 'vite'),
    'not a symlink\n',
  );
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.symlinks = [
    {
      path: 'coding-agent-workdir/node_modules/.bin/vite',
      target: '../vite-bin.js',
    },
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    expect(() =>
      publishAttempt({ ...paths, expectedAttemptId: expectedAttemptId() }),
    ).toThrow(
      /manifest lists a missing or non-symlink entry: coding-agent-workdir\/node_modules\/\.bin\/vite/,
    );
    expect(existsSync(join(paths.resultsRoot, 'run-pub-24'))).toBe(false);
    expect(existsSync(runDir)).toBe(true);
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
  blockActivation,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

test('V2 publication authenticates full identity and returns immutable byte references only after death', () => {
  const paths = staged('run-v2');
  const intent = blockActivation(twoArmExperiment()).attempts[0]!;
  intent.identity = identity;
  intent.output_root = paths.attemptDir;
  const bound = { intent, container_id: 'a'.repeat(64) };
  const stopped = {
    execution_attempt_id: identity.execution_attempt_id,
    container_id: bound.container_id,
    proof: 'inspected_stopped' as const,
    observed_at: new Date().toISOString(),
  };
  expect(() =>
    publishExecution({
      bound,
      stopped: { ...stopped, container_id: 'b'.repeat(64) },
      resultsRoot: paths.resultsRoot,
    }),
  ).toThrow();
  const published = publishExecution({
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
      bound,
      stopped: {
        execution_attempt_id: identity.execution_attempt_id,
        container_id: bound.container_id,
        proof: 'inspected_stopped',
        observed_at: new Date().toISOString(),
      },
      resultsRoot: paths.resultsRoot,
    }),
  ).toThrow('identity');
  expect(existsSync(join(paths.attemptDir, 'staging', 'foreign'))).toBe(true);
  clean(paths);
});
