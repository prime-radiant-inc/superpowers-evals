import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { RunnerError } from '../src/runner/errors.ts';
import { runScenario } from '../src/runner/index.ts';
import {
  ATTEMPT_MANIFEST_FS,
  type AttemptManifestFsOps,
  parseAttemptManifest,
  writeAttemptManifest,
} from '../src/runner/manifest.ts';

const identity = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:s:b1',
  sample_id: 'c1:s:arm_a:r1',
  execution_attempt_id: 'c1:s:arm_a:r1:a1',
};

function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'manifest-'));
}

function manifestFs(
  overrides: Partial<AttemptManifestFsOps>,
): AttemptManifestFsOps {
  return { ...ATTEMPT_MANIFEST_FS, ...overrides };
}

test('manifest lists sorted artifacts with exact digests and derived run id', () => {
  const runDir = tempRunDir();
  writeFileSync(join(runDir, 'z-last.txt'), 'last\n');
  writeFileSync(join(runDir, 'verdict.json'), '{"final":"pass"}\n');
  mkdirSync(join(runDir, 'home'));
  writeFileSync(join(runDir, 'home', 'secret.env'), 'KEY=v\n');
  mkdirSync(join(runDir, 'gauntlet-agent', 'nested'), { recursive: true });
  writeFileSync(
    join(runDir, 'gauntlet-agent', 'nested', 'result.json'),
    '{}\n',
  );
  writeFileSync(join(runDir, '.manifest.json.tmp'), 'stale stage\n');

  try {
    writeAttemptManifest(runDir, identity);
    const manifestPath = join(runDir, 'manifest.json');
    const manifest = parseAttemptManifest(readFileSync(manifestPath, 'utf8'));

    expect(manifest.run_id).toBe(basename(runDir));
    expect(manifest.schema_version).toBe(1);
    expect(manifest.campaign).toEqual(identity);
    expect(manifest.files.map((file) => file.path)).toEqual([
      'gauntlet-agent/nested/result.json',
      'verdict.json',
      'z-last.txt',
    ]);
    expect(manifest.files.map((file) => file.path)).toEqual(
      [...manifest.files.map((file) => file.path)].sort(),
    );
    for (const file of manifest.files) {
      const bytes = readFileSync(join(runDir, file.path));
      expect(file.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(file.size).toBe(bytes.byteLength);
    }
    expect(manifest.files.some((file) => file.path.startsWith('home/'))).toBe(
      false,
    );
    expect(
      manifest.files.some((file) => file.path === '.manifest.json.tmp'),
    ).toBe(false);
    expect(manifest.files.some((file) => file.path === 'manifest.json')).toBe(
      false,
    );
    expect(existsSync(join(runDir, '.manifest.json.tmp'))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('manifest publication replaces stale output privately and removes its stage', () => {
  const runDir = tempRunDir();
  const manifestPath = join(runDir, 'manifest.json');
  const stagePath = join(runDir, '.manifest.json.tmp');
  writeFileSync(join(runDir, 'verdict.json'), 'new bytes\n');
  writeFileSync(manifestPath, 'old bytes\n');
  chmodSync(manifestPath, 0o644);
  writeFileSync(stagePath, 'stale bytes\n');
  chmodSync(stagePath, 0o644);

  try {
    writeAttemptManifest(runDir, identity);
    const manifest = parseAttemptManifest(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]?.path).toBe('verdict.json');
    expect(lstatSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(existsSync(stagePath)).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).run_id).toBe(
      basename(runDir),
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('pre-publication validation removes a stale final manifest before refusing', () => {
  const runDir = tempRunDir();
  const outside = join(tmpdir(), `manifest-secret-${process.pid}`);
  writeFileSync(join(runDir, 'manifest.json'), 'old blessed output\n');
  writeFileSync(outside, 'secret\n');
  symlinkSync(outside, join(runDir, 'verdict.json'));

  try {
    expect(() => writeAttemptManifest(runDir, identity)).toThrow(
      'symlinked artifact refused: verdict.json',
    );
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('a failure after rename removes the installed final and preserves the original error', () => {
  const runDir = tempRunDir();
  writeFileSync(join(runDir, 'verdict.json'), 'bytes\n');
  const events: string[] = [];
  const ops = manifestFs({
    renameSync(oldPath, newPath) {
      renameSync(oldPath, newPath);
      throw new Error('rename reported failure after committing');
    },
    unlinkSync(path) {
      events.push(`unlink:${basename(path)}`);
      ATTEMPT_MANIFEST_FS.unlinkSync(path);
    },
    fsyncSync(fd) {
      if (ATTEMPT_MANIFEST_FS.fstatSync(fd).isDirectory()) {
        events.push('fsync-dir');
      }
      ATTEMPT_MANIFEST_FS.fsyncSync(fd);
    },
  });

  try {
    expect(() => writeAttemptManifest(runDir, identity, ops)).toThrow(
      'rename reported failure after committing',
    );
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
    const finalCleanupIndex = events.indexOf('unlink:manifest.json');
    expect(finalCleanupIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(finalCleanupIndex + 1)).toContain('fsync-dir');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('artifact replacement after discovery cannot redirect the pinned digest', () => {
  const runDir = tempRunDir();
  const verdict = join(realpathSync(runDir), 'verdict.json');
  const outside = join(tmpdir(), `manifest-secret-${process.pid}`);
  writeFileSync(verdict, 'original bytes\n');
  writeFileSync(outside, 'outside secret\n');
  const ops = manifestFs({
    openSync(path, flags, mode) {
      const fd = ATTEMPT_MANIFEST_FS.openSync(path, flags, mode);
      if (path.endsWith('/verdict.json')) {
        rmSync(path);
        symlinkSync(outside, path);
      }
      return fd;
    },
  });

  try {
    expect(() => writeAttemptManifest(runDir, identity, ops)).toThrow(
      'artifact changed while it was being read',
    );
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('outside secret\n');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('intermediate directory replacement cannot redirect artifact traversal', () => {
  const runDir = tempRunDir();
  const nested = join(realpathSync(runDir), 'nested');
  const outside = join(tmpdir(), `manifest-outside-${process.pid}`);
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(join(nested, 'verdict.json'), 'original\n');
  writeFileSync(join(outside, 'verdict.json'), 'outside\n');
  const ops = manifestFs({
    openSync(path, flags, mode) {
      if (path.endsWith('/nested')) {
        renameSync(nested, `${nested}.real`);
        symlinkSync(outside, nested);
      }
      return ATTEMPT_MANIFEST_FS.openSync(path, flags, mode);
    },
  });

  try {
    expect(() => writeAttemptManifest(runDir, identity, ops)).toThrow();
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('nested directory entries are fsynced before manifest publication', () => {
  const runDir = tempRunDir();
  const nested = join(runDir, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'verdict.json'), 'bytes\n');
  const directoryInodes = new Set([
    Number(lstatSync(runDir).ino),
    Number(lstatSync(nested).ino),
  ]);
  const syncedDirectories: number[] = [];
  const ops = manifestFs({
    fsyncSync(fd) {
      const stat = ATTEMPT_MANIFEST_FS.fstatSync(fd);
      if (stat.isDirectory()) syncedDirectories.push(Number(stat.ino));
      ATTEMPT_MANIFEST_FS.fsyncSync(fd);
    },
  });

  try {
    writeAttemptManifest(runDir, identity, ops);
    expect(new Set(syncedDirectories)).toEqual(directoryInodes);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('failed stage cleanup is followed by run-directory fsync', () => {
  const runDir = tempRunDir();
  writeFileSync(join(runDir, 'verdict.json'), 'bytes\n');
  const events: string[] = [];
  const ops = manifestFs({
    writeSync() {
      throw new Error('stage write failed');
    },
    unlinkSync(path) {
      events.push(`unlink:${path}`);
      ATTEMPT_MANIFEST_FS.unlinkSync(path);
    },
    fsyncSync(fd) {
      if (ATTEMPT_MANIFEST_FS.fstatSync(fd).isDirectory())
        events.push('fsync-dir');
      ATTEMPT_MANIFEST_FS.fsyncSync(fd);
    },
  });

  try {
    expect(() => writeAttemptManifest(runDir, identity, ops)).toThrow(
      'stage write failed',
    );
    const cleanupIndex = events.findIndex((event) =>
      event.endsWith('.manifest.json.tmp'),
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(cleanupIndex + 1)).toContain('fsync-dir');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('manifest refuses symlinked artifacts without publishing a manifest', () => {
  const runDir = tempRunDir();
  const outside = join(tmpdir(), `manifest-secret-${process.pid}`);
  writeFileSync(outside, 'secret\n');
  symlinkSync(outside, join(runDir, 'verdict.json'));

  try {
    expect(() => writeAttemptManifest(runDir, identity)).toThrow(RunnerError);
    expect(() => writeAttemptManifest(runDir, identity)).toThrow(
      'symlinked artifact refused: verdict.json',
    );
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('manifest refuses non-regular artifacts without publishing a manifest', () => {
  const runDir = tempRunDir();
  const fifo = join(runDir, 'pipe');
  execFileSync('mkfifo', [fifo]);

  try {
    expect(() => writeAttemptManifest(runDir, identity)).toThrow(
      'non-regular artifact refused: pipe',
    );
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('parseAttemptManifest rejects malformed, non-strict, absolute, and traversal input', () => {
  const valid = {
    schema_version: 1,
    run_id: 'run-1',
    campaign: identity,
    files: [{ path: 'verdict.json', size: 1, sha256: 'a'.repeat(64) }],
  };
  expect(() => parseAttemptManifest('{')).toThrow();
  expect(() =>
    parseAttemptManifest(JSON.stringify({ ...valid, extra: true })),
  ).toThrow();
  expect(() =>
    parseAttemptManifest(
      JSON.stringify({
        ...valid,
        files: [{ ...valid.files[0], path: '/absolute' }],
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAttemptManifest(
      JSON.stringify({
        ...valid,
        files: [{ ...valid.files[0], path: '../outside' }],
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAttemptManifest(
      JSON.stringify({
        ...valid,
        files: [{ ...valid.files[0], path: 'nested/../../outside' }],
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAttemptManifest(
      JSON.stringify({
        ...valid,
        files: [{ ...valid.files[0], path: 'nested\\outside' }],
      }),
    ),
  ).toThrow();
});

test('ordinary runScenario runs do not gain an attempt manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-manifest-ordinary-'));
  try {
    const { runDir } = await runScenario({
      scenarioDir: join(root, 'missing-scenario'),
      codingAgent: 'pi',
      codingAgentsDir: resolve(import.meta.dir, '..', 'coding-agents'),
      outRoot: join(root, 'results'),
    });
    expect(existsSync(join(runDir, 'verdict.json'))).toBe(true);
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('campaign runScenario writes the attempt manifest after its verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-manifest-campaign-'));
  try {
    const { runDir, verdict } = await runScenario({
      scenarioDir: join(root, 'missing-scenario'),
      codingAgent: 'pi',
      codingAgentsDir: resolve(import.meta.dir, '..', 'coding-agents'),
      outRoot: join(root, 'results'),
      campaign: identity,
    });
    expect(verdict.campaign).toEqual(identity);
    const manifest = parseAttemptManifest(
      readFileSync(join(runDir, 'manifest.json'), 'utf8'),
    );
    expect(manifest.run_id).toBe(basename(runDir));
    expect(manifest.campaign).toEqual(identity);
    expect(manifest.files.map((file) => file.path)).toContain('verdict.json');
    expect(manifest.files.map((file) => file.path)).not.toContain(
      'home/.pi/agent',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
