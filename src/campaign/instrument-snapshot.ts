// The instrument snapshot (kernel D2): a campaign-local materialization of the
// registered evals + gauntlet SHAs so story/checks/prelude/configs/lockfile and
// the gauntlet build can't drift mid-campaign. verifySnapshot is the drift
// guard over all three tree families (evals, gauntlet, and each superpowers
// worktree — the treatment variable of the platform's headline questions).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import { getEnv } from '../env.ts';
import { ensureWorktreeAt } from './provisioning.ts';

export class SnapshotDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotDriftError';
  }
}

export interface SuperpowersWorktreeRef {
  readonly root: string;
  readonly sha: string;
}

export interface SnapshotHandle {
  readonly evalsRoot: string; // <destDir>/evals
  readonly gauntletRoot: string; // <destDir>/gauntlet
  /** Absolute path to the snapshot-local gauntlet wrapper. */
  readonly gauntletBin: string; // <destDir>/bin/gauntlet
  /** Superpowers worktrees verifySnapshot guards; empty for library-only
   *  use — D3 populates one entry per distinct arm SHA. */
  readonly superpowersWorktrees: readonly SuperpowersWorktreeRef[];
  readonly evalsSha: string;
  readonly gauntletSha: string;
}

export interface MaterializeEvalsSnapshotArgs {
  readonly evalsCheckout: string;
  readonly evalsSha: string;
  readonly gauntletCheckout: string;
  readonly gauntletSha: string;
  /** Campaign-local destination (D3: the campaign directory). */
  readonly destDir: string;
  readonly runner: CommandRunner;
}

const MARKER = '.quorum-snapshot-ok';
const SUPERPOWERS_DIR_RE = /^superpowers-((?:[0-9a-f]{40}|[0-9a-f]{64}))$/;

/** The minimal env every snapshot subprocess gets — PATH/HOME/TMPDIR only.
 *  Read through src/env.ts (§6.5): the gate forbids direct process.env reads
 *  outside that boundary. */
function minimalEnv(): Record<string, string | undefined> {
  return {
    PATH: getEnv('PATH'),
    HOME: getEnv('HOME'),
    TMPDIR: getEnv('TMPDIR'),
  };
}

function headOf(runner: CommandRunner, dir: string): string {
  const res = runner.run('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    env: minimalEnv(),
  });
  if (res.status !== 0) {
    throw new SnapshotDriftError(
      `git rev-parse HEAD in ${dir} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

function porcelainOf(runner: CommandRunner, dir: string): string {
  const res = runner.run('git', ['-C', dir, 'status', '--porcelain'], {
    env: minimalEnv(),
  });
  if (res.status !== 0) {
    throw new SnapshotDriftError(
      `git status in ${dir} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

function bunInstall(runner: CommandRunner, cwd: string): void {
  const res = runner.run('bun', ['install', '--frozen-lockfile'], {
    cwd,
    env: minimalEnv(),
  });
  if (res.status !== 0) {
    throw new SnapshotDriftError(
      `bun install --frozen-lockfile in ${cwd} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
}

/** POSIX single-quote a literal for interpolation into the wrapper: each
 *  `'` becomes `'\''`. destDir is caller-supplied and the interface imposes
 *  no safe-path restriction — whitespace and shell metacharacters are all
 *  valid — so the embedded entrypoint path is always quoted, never
 *  interpolated bare. */
function shellQuote(literal: string): string {
  return `'${literal.replaceAll("'", "'\\''")}'`;
}

/** The snapshot-local gauntlet wrapper, mirroring the container's approach
 *  (container/Dockerfile:33): install deps, then a wrapper that execs the
 *  snapshot's gauntlet entrypoint (path shell-quoted — see shellQuote).
 *  GAUNTLET_ROOT stays out of the gauntlet child env — the wrapper is an
 *  absolute path, not an env channel. */
function buildGauntletBin(destDir: string, gauntletRoot: string): string {
  const bin = join(destDir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gauntletBin = join(bin, 'gauntlet');
  writeFileSync(
    gauntletBin,
    `#!/bin/sh\nexec bun ${shellQuote(join(gauntletRoot, 'src', 'index.ts'))} "$@"\n`,
  );
  chmodSync(gauntletBin, 0o755);
  return gauntletBin;
}

export function materializeEvalsSnapshot(
  args: MaterializeEvalsSnapshotArgs,
): SnapshotHandle {
  const { destDir, runner } = args;
  mkdirSync(destDir, { recursive: true });
  const evalsRoot = join(destDir, 'evals');
  const gauntletRoot = join(destDir, 'gauntlet');
  ensureWorktreeAt({
    sourceCheckout: args.evalsCheckout,
    sha: args.evalsSha,
    dest: evalsRoot,
    runner,
  });
  ensureWorktreeAt({
    sourceCheckout: args.gauntletCheckout,
    sha: args.gauntletSha,
    dest: gauntletRoot,
    runner,
  });
  const gauntletBin = join(destDir, 'bin', 'gauntlet');
  const marker = join(destDir, MARKER);
  // Re-entry: the success marker proves install + wrapper completed. Absent
  // marker (crash mid-materialize): re-run those steps — they are idempotent —
  // so a half-installed snapshot is never silently reused.
  if (!existsSync(marker)) {
    bunInstall(runner, evalsRoot);
    bunInstall(runner, gauntletRoot);
    buildGauntletBin(destDir, gauntletRoot);
    writeFileSync(marker, '');
  }
  return {
    evalsRoot,
    gauntletRoot,
    gauntletBin,
    superpowersWorktrees: [],
    evalsSha: args.evalsSha,
    gauntletSha: args.gauntletSha,
  };
}

/** Crash-resume: rebuild the handle from the campaign-dir contents alone.
 *  Roots and gauntletBin re-derive from the destDir layout; SHAs are re-read
 *  from each tree's worktree HEAD; superpowers worktrees are the
 *  `superpowers-<sha>` siblings (name-suffix shape checked, SHA re-read). */
export function reconstructSnapshot(
  destDir: string,
  runner: CommandRunner,
): SnapshotHandle {
  const evalsRoot = join(destDir, 'evals');
  const gauntletRoot = join(destDir, 'gauntlet');
  const gauntletBin = join(destDir, 'bin', 'gauntlet');
  const superpowersWorktrees: SuperpowersWorktreeRef[] = readdirSync(destDir)
    .map((name) => SUPERPOWERS_DIR_RE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const root = join(destDir, m[0]);
      return { root, sha: headOf(runner, root) };
    })
    .sort((a, b) => a.root.localeCompare(b.root));
  return {
    evalsRoot,
    gauntletRoot,
    gauntletBin,
    superpowersWorktrees,
    evalsSha: headOf(runner, evalsRoot),
    gauntletSha: headOf(runner, gauntletRoot),
  };
}

/** The drift guard: HEAD-exact + porcelain-clean on every tree — evals,
 *  gauntlet, and each superpowers worktree. Porcelain is blind to ignored-path
 *  mutation; materialization keeps its outputs in gitignored paths (or, for
 *  the wrapper, outside the worktrees entirely under <destDir>/bin). */
export function verifySnapshot(
  handle: SnapshotHandle,
  runner: CommandRunner,
): void {
  const trees = [
    { root: handle.evalsRoot, sha: handle.evalsSha, label: 'evals' },
    { root: handle.gauntletRoot, sha: handle.gauntletSha, label: 'gauntlet' },
    ...handle.superpowersWorktrees.map((w) => ({
      root: w.root,
      sha: w.sha,
      label: `superpowers(${w.sha.slice(0, 12)})`,
    })),
  ];
  for (const t of trees) {
    const head = headOf(runner, t.root);
    if (head !== t.sha) {
      throw new SnapshotDriftError(
        `${t.label}: HEAD drift — expected ${t.sha}, got ${head}`,
      );
    }
    const dirty = porcelainOf(runner, t.root);
    if (dirty !== '') {
      throw new SnapshotDriftError(`${t.label}: working-tree drift:\n${dirty}`);
    }
  }
}
