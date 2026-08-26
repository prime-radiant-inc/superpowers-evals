import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { defaultCommandRunner } from '../src/agents/command-runner.ts';
import {
  materializeEvalsSnapshot,
  reconstructSnapshot,
  SnapshotDriftError,
  type SnapshotHandle,
  verifySnapshot,
} from '../src/campaign/instrument-snapshot.ts';

const EVALS_SHA = 'e'.repeat(40);
const GAUNTLET_SHA = '9'.repeat(40);
const SP_SHA = '5'.repeat(40);

class RecordingRunner implements CommandRunner {
  readonly calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];
  heads = new Map<string, string>(); // dir -> HEAD answer
  porcelain = new Map<string, string>(); // dir -> porcelain answer
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    if (command === 'git' && args.includes('rev-parse')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return {
        status: 0,
        stdout: `${this.heads.get(dir) ?? EVALS_SHA}\n`,
        stderr: '',
      };
    }
    if (command === 'git' && args.includes('status')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return { status: 0, stdout: this.porcelain.get(dir) ?? '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function snapArgs(runner: RecordingRunner, destDir: string) {
  return {
    evalsCheckout: '/src/evals',
    evalsSha: EVALS_SHA,
    gauntletCheckout: '/src/gauntlet',
    gauntletSha: GAUNTLET_SHA,
    destDir,
    runner,
  };
}

test('materializes both trees, installs, builds the gauntlet wrapper, writes the marker', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  const handle = materializeEvalsSnapshot(snapArgs(runner, destDir));
  expect(handle.evalsRoot).toBe(join(destDir, 'evals'));
  expect(handle.gauntletRoot).toBe(join(destDir, 'gauntlet'));
  expect(handle.gauntletBin).toBe(join(destDir, 'bin', 'gauntlet'));
  expect(handle.superpowersWorktrees).toEqual([]);
  // Two worktree adds at the registered SHAs:
  const adds = runner.calls.filter((c) => c.args.includes('add'));
  expect(adds).toHaveLength(2);
  expect(adds[0]?.args).toContain(EVALS_SHA);
  expect(adds[1]?.args).toContain(GAUNTLET_SHA);
  // bun install --frozen-lockfile in each tree:
  const installs = runner.calls.filter(
    (c) => c.command === 'bun' && c.args.includes('--frozen-lockfile'),
  );
  expect(installs).toHaveLength(2);
  expect(installs.map((c) => c.options?.cwd).sort()).toEqual(
    [handle.evalsRoot, handle.gauntletRoot].sort(),
  );
  // Wrapper exists, is executable, and execs the snapshot's gauntlet
  // entrypoint (POSIX single-quoted — destDir is not restricted to
  // shell-safe paths; the spaces-and-quote regression below covers the
  // metacharacter case behaviorally):
  const wrapper = readFileSync(handle.gauntletBin, 'utf8');
  expect(wrapper).toBe(
    `#!/bin/sh\nexec bun '${join(destDir, 'gauntlet', 'src', 'index.ts')}' "$@"\n`,
  );
  expect(statSync(handle.gauntletBin).mode & 0o111).not.toBe(0);
  expect(existsSync(join(destDir, '.quorum-snapshot-ok'))).toBe(true);
});

// Regression (review round 1): the wrapper interpolates the gauntlet
// entrypoint path, and destDir may legally contain whitespace and shell
// metacharacters — the interface imposes no safe-path restriction. The path
// must arrive POSIX single-quoted (' -> '\''), and /bin/sh must parse the
// wrapper into exactly ONE entrypoint argv element. Both are asserted: the
// expected wrapper text below hand-writes the quoting of the
// metacharacter-bearing suffix (not derived from the implementation's own
// transform), and a stub `bun` first on PATH records the argv the shell
// actually produced.
test('wrapper survives a destination containing spaces and a single quote', () => {
  const runner = new RecordingRunner();
  const base = mkdtempSync(join(tmpdir(), 'snap-'));
  const destDir = join(base, "campaign dir with space's and a 'quote'");
  const handle = materializeEvalsSnapshot(snapArgs(runner, destDir));
  expect(readFileSync(handle.gauntletBin, 'utf8')).toBe(
    `#!/bin/sh\nexec bun '${base}/campaign dir with space'\\''s and a '\\''quote'\\''/gauntlet/src/index.ts' "$@"\n`,
  );
  const stubDir = mkdtempSync(join(tmpdir(), 'snap-stub-'));
  const stubBun = join(stubDir, 'bun');
  const recFile = join(stubDir, 'argv');
  writeFileSync(stubBun, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ARGV_RECORD"\n');
  chmodSync(stubBun, 0o755);
  const res = spawnSync(handle.gauntletBin, ['--version'], {
    env: { PATH: stubDir, ARGV_RECORD: recFile },
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
  expect(readFileSync(recFile, 'utf8')).toBe(
    `${join(handle.gauntletRoot, 'src', 'index.ts')}\n--version\n`,
  );
});

test('minimal env on every subprocess call', () => {
  const runner = new RecordingRunner();
  materializeEvalsSnapshot(
    snapArgs(runner, mkdtempSync(join(tmpdir(), 'snap-'))),
  );
  for (const call of runner.calls) {
    const env = call.options?.env ?? {};
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TMPDIR']);
  }
});

test('re-entry with marker present: reuse trees, no reinstall', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  writeFileSync(join(destDir, '.quorum-snapshot-ok'), '');
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  materializeEvalsSnapshot(snapArgs(runner, destDir));
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(0);
  expect(runner.calls.filter((c) => c.command === 'bun')).toHaveLength(0);
});

test('re-entry with marker absent: trees reused, install + wrapper re-run', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  materializeEvalsSnapshot(snapArgs(runner, destDir));
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(0);
  expect(
    runner.calls.filter(
      (c) => c.command === 'bun' && c.args.includes('--frozen-lockfile'),
    ),
  ).toHaveLength(2);
  expect(existsSync(join(destDir, '.quorum-snapshot-ok'))).toBe(true);
});

// Write the completion artifacts the completion guard demands — the exact
// wrapper bytes for this destDir plus the regular-file success marker — into
// an already-shaped campaign dir.
function completeSnapshotFixture(destDir: string): void {
  mkdirSync(join(destDir, 'bin'), { recursive: true });
  writeFileSync(
    join(destDir, 'bin', 'gauntlet'),
    `#!/bin/sh\nexec bun '${join(destDir, 'gauntlet', 'src', 'index.ts')}' "$@"\n`,
  );
  chmodSync(join(destDir, 'bin', 'gauntlet'), 0o755);
  writeFileSync(join(destDir, '.quorum-snapshot-ok'), '');
}

test('verifySnapshot passes when all three families are exact+clean', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  completeSnapshotFixture(destDir);
  const spRoot = join(destDir, `superpowers-${SP_SHA}`);
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  runner.heads.set(spRoot, SP_SHA);
  const handle: SnapshotHandle = {
    evalsRoot: join(destDir, 'evals'),
    gauntletRoot: join(destDir, 'gauntlet'),
    gauntletBin: join(destDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [{ root: spRoot, sha: SP_SHA }],
    evalsSha: EVALS_SHA,
    gauntletSha: GAUNTLET_SHA,
  };
  expect(() => verifySnapshot(handle, runner)).not.toThrow();
});

test('verifySnapshot throws on HEAD drift in the evals tree', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  completeSnapshotFixture(destDir);
  runner.heads.set(join(destDir, 'evals'), 'f'.repeat(40));
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  const handle: SnapshotHandle = {
    evalsRoot: join(destDir, 'evals'),
    gauntletRoot: join(destDir, 'gauntlet'),
    gauntletBin: join(destDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [],
    evalsSha: EVALS_SHA,
    gauntletSha: GAUNTLET_SHA,
  };
  expect(() => verifySnapshot(handle, runner)).toThrow(SnapshotDriftError);
});

test('verifySnapshot throws on porcelain drift in a superpowers worktree', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  completeSnapshotFixture(destDir);
  const spRoot = join(destDir, `superpowers-${SP_SHA}`);
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  runner.heads.set(spRoot, SP_SHA);
  runner.porcelain.set(spRoot, ' M skills/x.md\n');
  const handle: SnapshotHandle = {
    evalsRoot: join(destDir, 'evals'),
    gauntletRoot: join(destDir, 'gauntlet'),
    gauntletBin: join(destDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [{ root: spRoot, sha: SP_SHA }],
    evalsSha: EVALS_SHA,
    gauntletSha: GAUNTLET_SHA,
  };
  expect(() => verifySnapshot(handle, runner)).toThrow(SnapshotDriftError);
});

// Reconstruction accepts only a COMPLETED snapshot: the success marker and
// the exact wrapper must be in place (the completion contract below refuses
// anything less).
test('reconstructSnapshot rebuilds the handle from a completed campaign dir', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  const spRoot = join(destDir, `superpowers-${SP_SHA}`);
  mkdirSync(spRoot, { recursive: true });
  completeSnapshotFixture(destDir);
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  runner.heads.set(spRoot, SP_SHA);
  const handle = reconstructSnapshot(destDir, runner);
  expect(handle).toEqual({
    evalsRoot: join(destDir, 'evals'),
    gauntletRoot: join(destDir, 'gauntlet'),
    gauntletBin: join(destDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [{ root: spRoot, sha: SP_SHA }],
    evalsSha: EVALS_SHA,
    gauntletSha: GAUNTLET_SHA,
  });
});

// The crash-reconstruction probe (final review): a campaign dir holding only
// empty evals/ + gauntlet/ trees — no success marker, no wrapper — is a
// snapshot that was NEVER completed. Reconstruction must refuse to hand out
// a handle over it, and verification of a hand-built handle must fail, not
// verify green.
test('an incomplete snapshot (no marker, no wrapper) fails reconstruct and verify', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  expect(() => reconstructSnapshot(destDir, runner)).toThrow(
    SnapshotDriftError,
  );
  expect(() => reconstructSnapshot(destDir, runner)).toThrow(/never completed/);
  const handle: SnapshotHandle = {
    evalsRoot: join(destDir, 'evals'),
    gauntletRoot: join(destDir, 'gauntlet'),
    gauntletBin: join(destDir, 'bin', 'gauntlet'),
    superpowersWorktrees: [],
    evalsSha: EVALS_SHA,
    gauntletSha: GAUNTLET_SHA,
  };
  expect(() => verifySnapshot(handle, runner)).toThrow(SnapshotDriftError);
});

// The wrapper is part of the completion contract: tampered bytes or a
// symlink standing in for it (even one resolving to the exact expected
// bytes) fail both reconstruction and verification.
test('a tampered or symlinked wrapper fails reconstruct and verify', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  completeSnapshotFixture(destDir);
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  const wrapper = join(destDir, 'bin', 'gauntlet');
  const expectedBytes = readFileSync(wrapper, 'utf8');
  const handle = reconstructSnapshot(destDir, runner);
  // Tampered bytes:
  writeFileSync(wrapper, '#!/bin/sh\nexec gauntlet "$@"\n');
  chmodSync(wrapper, 0o755);
  expect(() => reconstructSnapshot(destDir, runner)).toThrow(
    SnapshotDriftError,
  );
  expect(() => verifySnapshot(handle, runner)).toThrow(SnapshotDriftError);
  // A symlink resolving to the exact expected bytes is still refused:
  const aside = join(destDir, 'aside-wrapper');
  writeFileSync(aside, expectedBytes);
  chmodSync(aside, 0o755);
  rmSync(wrapper);
  symlinkSync(aside, wrapper);
  expect(() => reconstructSnapshot(destDir, runner)).toThrow(
    SnapshotDriftError,
  );
  expect(() => verifySnapshot(handle, runner)).toThrow(SnapshotDriftError);
});

// The success marker must be a regular file observed without following: a
// symlinked marker (whose target exists) is corruption, not completion —
// reconstruction, verification, AND re-entry all refuse it loudly.
test('a symlinked marker is refused by reconstruct, verify, and materialize', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  completeSnapshotFixture(destDir);
  runner.heads.set(join(destDir, 'evals'), EVALS_SHA);
  runner.heads.set(join(destDir, 'gauntlet'), GAUNTLET_SHA);
  const handle = reconstructSnapshot(destDir, runner);
  const marker = join(destDir, '.quorum-snapshot-ok');
  const target = join(destDir, 'marker-target');
  writeFileSync(target, '');
  rmSync(marker);
  symlinkSync(target, marker);
  expect(() => reconstructSnapshot(destDir, runner)).toThrow(
    SnapshotDriftError,
  );
  expect(() => verifySnapshot(handle, runner)).toThrow(SnapshotDriftError);
  expect(() => materializeEvalsSnapshot(snapArgs(runner, destDir))).toThrow(
    SnapshotDriftError,
  );
});

// Safe wrapper creation: a symlink planted at bin/gauntlet before
// materialization must never receive the wrapper bytes (a follow-capable
// write would land them — and the 0755 chmod — in the link's target). The
// wrapper must end up a regular executable with the exact bytes and the
// victim untouched.
test('materialize never writes the wrapper through a planted symlink', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  const victim = join(mkdtempSync(join(tmpdir(), 'victim-')), 'precious.sh');
  writeFileSync(victim, 'keep\n');
  mkdirSync(join(destDir, 'bin'), { recursive: true });
  symlinkSync(victim, join(destDir, 'bin', 'gauntlet'));
  const handle = materializeEvalsSnapshot(snapArgs(runner, destDir));
  expect(readFileSync(victim, 'utf8')).toBe('keep\n');
  expect(lstatSync(handle.gauntletBin).isFile()).toBe(true);
  expect(lstatSync(handle.gauntletBin).isSymbolicLink()).toBe(false);
  expect(readFileSync(handle.gauntletBin, 'utf8')).toBe(
    `#!/bin/sh\nexec bun '${join(destDir, 'gauntlet', 'src', 'index.ts')}' "$@"\n`,
  );
  expect(statSync(handle.gauntletBin).mode & 0o111).not.toBe(0);
  expect(lstatSync(join(destDir, '.quorum-snapshot-ok')).isFile()).toBe(true);
});

// Real-git end-to-end (the provenance.test.ts pattern): actual worktrees at
// real SHAs, a real offline `bun install --frozen-lockfile`, and the real
// marker/wrapper on the real filesystem — through the real SpawnCommandRunner,
// recorded by a pass-through wrapper so re-entry is asserted by what it did
// NOT re-run. The fixture .gitignore carries node_modules/ because
// materialization's outputs must live in gitignored paths for the porcelain
// leg of the drift guard (see verifySnapshot's doc comment).
class RecordingRealRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push({ command, args });
    return defaultCommandRunner.run(command, args, options);
  }
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-src-'));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(
    join(dir, 'package.json'),
    '{"name":"fixture","version":"0.0.0"}\n',
  );
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  return dir;
}

function realHead(dir: string): string {
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
}

test('real git + real bun: materialize, re-enter, verify, drift', () => {
  const evalsSrc = makeSourceRepo();
  const gauntletSrc = makeSourceRepo();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-real-'));
  const evalsSha = realHead(evalsSrc);
  const gauntletSha = realHead(gauntletSrc);
  const runner = new RecordingRealRunner();
  const handle = materializeEvalsSnapshot({
    evalsCheckout: evalsSrc,
    evalsSha,
    gauntletCheckout: gauntletSrc,
    gauntletSha,
    destDir,
    runner,
  });
  expect(realHead(handle.evalsRoot)).toBe(evalsSha);
  expect(realHead(handle.gauntletRoot)).toBe(gauntletSha);
  expect(statSync(handle.gauntletBin).mode & 0o111).not.toBe(0);
  expect(readFileSync(handle.gauntletBin, 'utf8')).toBe(
    `#!/bin/sh\nexec bun '${join(handle.gauntletRoot, 'src', 'index.ts')}' "$@"\n`,
  );
  expect(existsSync(join(destDir, '.quorum-snapshot-ok'))).toBe(true);
  // Re-entry with the marker present: trees reused, nothing re-installed.
  const reentry = new RecordingRealRunner();
  materializeEvalsSnapshot({
    evalsCheckout: evalsSrc,
    evalsSha,
    gauntletCheckout: gauntletSrc,
    gauntletSha,
    destDir,
    runner: reentry,
  });
  expect(reentry.calls.filter((c) => c.args.includes('add'))).toHaveLength(0);
  expect(reentry.calls.filter((c) => c.command === 'bun')).toHaveLength(0);
  // The drift guard over the real trees, then real working-tree drift.
  expect(() => verifySnapshot(handle, reentry)).not.toThrow();
  writeFileSync(join(handle.evalsRoot, 'README.md'), 'dirty\n');
  expect(() => verifySnapshot(handle, reentry)).toThrow(SnapshotDriftError);
});
