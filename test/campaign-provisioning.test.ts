import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
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
  materializeSuperpowersWorktree,
  ProvisioningError,
} from '../src/campaign/provisioning.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

class RecordingRunner implements CommandRunner {
  readonly calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];
  failNextWorktreeAdd = false;
  head = SHA_A;
  porcelain = '';
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('add')
    ) {
      if (this.failNextWorktreeAdd) {
        return { status: 1, stdout: '', stderr: 'fatal: boom\n' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: `${this.head}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('status')) {
      return { status: 0, stdout: this.porcelain, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'prov-'));
}

function args(runner: RecordingRunner, destParent: string) {
  return { sourceCheckout: '/src/sp', sha: SHA_A, destParent, runner };
}

test('materializes with the exact git argv and minimal env', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const root = materializeSuperpowersWorktree(args(runner, destParent));
  expect(root).toBe(join(destParent, `superpowers-${SHA_A}`));
  const add = runner.calls.find(
    (c) => c.command === 'git' && c.args.includes('add'),
  );
  expect(add?.args).toEqual([
    '-C',
    '/src/sp',
    'worktree',
    'add',
    '--detach',
    join(destParent, `superpowers-${SHA_A}`),
    SHA_A,
  ]);
  const env = add?.options?.env ?? {};
  expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TMPDIR']);
  expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
});

test('rejects a non-hex sha before any path construction or subprocess', () => {
  const runner = new RecordingRunner();
  expect(() =>
    materializeSuperpowersWorktree({
      sourceCheckout: '/src/sp',
      sha: '../../../tmp/evil',
      destParent: tmp(),
      runner,
    }),
  ).toThrow(ProvisioningError);
  expect(runner.calls).toHaveLength(0);
});

test('accepts 64-char hex sha256 SHAs', () => {
  const runner = new RecordingRunner();
  const sha256 = 'c'.repeat(64);
  const root = materializeSuperpowersWorktree({
    sourceCheckout: '/src/sp',
    sha: sha256,
    destParent: tmp(),
    runner,
  });
  expect(root).toContain(`superpowers-${sha256}`);
});

test('reuses a pre-existing path only when HEAD==sha and porcelain-clean', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  const root = materializeSuperpowersWorktree(args(runner, destParent));
  expect(root).toBe(join(destParent, `superpowers-${SHA_A}`));
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(0);
});

test('throws on HEAD drift at a pre-existing path', () => {
  const runner = new RecordingRunner();
  runner.head = SHA_B;
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
});

test('throws on porcelain drift at a pre-existing path', () => {
  const runner = new RecordingRunner();
  runner.porcelain = ' M skills/x.md\n';
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
});

test('a symlinked pre-existing destination is never reused', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(destParent, `superpowers-${SHA_A}`));
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
  expect(runner.calls).toHaveLength(0);
});

test('two distinct SHAs yield two worktrees', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const a = materializeSuperpowersWorktree(args(runner, destParent));
  const b = materializeSuperpowersWorktree({
    ...args(runner, destParent),
    sha: SHA_B,
  });
  expect(a).not.toBe(b);
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(2);
});

test('failure cleans up via worktree remove --force + prune, never rm -rf', () => {
  const runner = new RecordingRunner();
  runner.failNextWorktreeAdd = true;
  const destParent = tmp();
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
  const verbs = runner.calls.map((c) => c.args.join(' '));
  expect(verbs.some((v) => v.includes('worktree remove --force'))).toBe(true);
  expect(verbs.some((v) => v.includes('worktree prune'))).toBe(true);
});

test('a stale lockfile is reclaimed by mtime', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const lock = join(destParent, `superpowers-${SHA_A}.lock`);
  writeFileSync(lock, '');
  utimesSync(lock, new Date(0), new Date(0));
  const root = materializeSuperpowersWorktree(args(runner, destParent));
  expect(root).toBe(join(destParent, `superpowers-${SHA_A}`));
});

test('real tmp git repo: materialize, reuse, then drift rejection', () => {
  const src = tmp();
  const git = (gargs: string[], cwd: string) =>
    spawnSync('git', gargs, { cwd, encoding: 'utf8' });
  git(['init', '-q'], src);
  git(['config', 'user.email', 't@t'], src);
  git(['config', 'user.name', 't'], src);
  writeFileSync(join(src, 'README.md'), 'x\n');
  git(['add', '.'], src);
  git(['commit', '-qm', 'init'], src);
  const sha = (git(['rev-parse', 'HEAD'], src).stdout ?? '').trim();
  const destParent = tmp();
  // RecordingRunner's canned git answers would lie for a real repo, so this
  // test uses the real SpawnCommandRunner via defaultCommandRunner (imported
  // at the top of this file).
  const first = materializeSuperpowersWorktree({
    sourceCheckout: src,
    sha,
    destParent,
    runner: defaultCommandRunner,
  });
  const second = materializeSuperpowersWorktree({
    sourceCheckout: src,
    sha,
    destParent,
    runner: defaultCommandRunner,
  });
  expect(second).toBe(first);
  writeFileSync(join(first, 'DIRTY.md'), 'drift\n');
  expect(() =>
    materializeSuperpowersWorktree({
      sourceCheckout: src,
      sha,
      destParent,
      runner: defaultCommandRunner,
    }),
  ).toThrow(ProvisioningError);
});
