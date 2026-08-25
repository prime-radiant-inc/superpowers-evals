// The superpowers worktree materializer (kernel D2). A library: it knows
// nothing about runs or campaigns; the caller (D3) supplies the destination.
// Every subprocess call goes through the CommandRunner seam with an explicit
// minimal env — the seam's documented invariant forbids inheriting the parent
// env. Confinement idiom mirrors src/campaign/acquire.ts (lstat, never stat;
// validate components before path construction).

import type { Stats } from 'node:fs';
import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import { getEnv } from '../env.ts';

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export interface MaterializeSuperpowersArgs {
  /** Local superpowers checkout to source the worktree from. */
  readonly sourceCheckout: string;
  /** Resolved full SHA (refs never reach here — Decision D-2); validated as
   *  full hex (40/64) before any path construction. */
  readonly sha: string;
  /** Parent dir; D3 passes the campaign dir, tests/smoke pass a tmpdir. */
  readonly destParent: string;
  readonly runner: CommandRunner;
}

const FULL_HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

/** The minimal env every materializer subprocess gets — PATH/HOME/TMPDIR only.
 *  Read through src/env.ts (§6.5): the gate forbids direct process.env reads
 *  outside that boundary. */
function materializeEnv(): Record<string, string | undefined> {
  return {
    PATH: getEnv('PATH'),
    HOME: getEnv('HOME'),
    TMPDIR: getEnv('TMPDIR'),
  };
}

/** lstat — does NOT follow symlinks — so a symlink never passes the reuse
 *  checks. Returns null when missing. (Idiom: acquire.ts's tryLstat.) */
function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function gitOk(runner: CommandRunner, args: readonly string[]): boolean {
  return runner.run('git', args, { env: materializeEnv() }).status === 0;
}

function gitOut(runner: CommandRunner, args: readonly string[]): string {
  const res = runner.run('git', args, { env: materializeEnv() });
  if (res.status !== 0) {
    throw new ProvisioningError(
      `git ${args.join(' ')} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

/** Single-flight per destination: O_EXCL lockfile; a fresh lock means another
 *  caller is mid-materialize — poll until it finishes, then the locked section
 *  re-checks reuse. A lock older than LOCK_STALE_MS is reclaimed (crash). */
function withDestLock<T>(lockPath: string, fn: () => T): T {
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = tryLstat(lockPath);
      if (st !== null && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        continue;
      }
      Bun.sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

export function ensureWorktreeAt(args: {
  readonly sourceCheckout: string;
  readonly sha: string;
  readonly dest: string;
  readonly runner: CommandRunner;
}): void {
  const { sourceCheckout, sha, dest, runner } = args;
  if (!FULL_HEX_SHA_RE.test(sha)) {
    throw new ProvisioningError(
      `refusing to materialize non-SHA ref ${JSON.stringify(sha)} (expected full 40/64 hex)`,
    );
  }
  withDestLock(`${dest}.lock`, () => {
    const st = tryLstat(dest);
    if (st !== null) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ProvisioningError(
          `refusing to reuse non-directory or symlinked destination: ${dest}`,
        );
      }
      const head = gitOut(runner, ['-C', dest, 'rev-parse', 'HEAD']);
      const porcelain = gitOut(runner, ['-C', dest, 'status', '--porcelain']);
      if (head === sha && porcelain === '') {
        return; // exact + clean: reuse (idempotent per SHA within destParent)
      }
      throw new ProvisioningError(
        `refusing to reuse drifted worktree at ${dest}: HEAD=${head} (want ${sha}), porcelain=${JSON.stringify(porcelain)}`,
      );
    }
    const added = gitOk(runner, [
      '-C',
      sourceCheckout,
      'worktree',
      'add',
      '--detach',
      dest,
      sha,
    ]);
    if (!added) {
      // Failure cleanup: remove the half-created worktree and prune the
      // registration — never rm -rf (registrations live in the source
      // checkout's .git/worktrees).
      gitOk(runner, [
        '-C',
        sourceCheckout,
        'worktree',
        'remove',
        '--force',
        dest,
      ]);
      gitOk(runner, ['-C', sourceCheckout, 'worktree', 'prune']);
      throw new ProvisioningError(
        `git worktree add ${dest} @ ${sha} failed (half-created tree removed + pruned)`,
      );
    }
  });
}

/** Materialize `<destParent>/superpowers-<sha>`; idempotent per SHA. */
export function materializeSuperpowersWorktree(
  args: MaterializeSuperpowersArgs,
): string {
  const dest = join(args.destParent, `superpowers-${args.sha}`);
  ensureWorktreeAt({ ...args, dest });
  return dest;
}
