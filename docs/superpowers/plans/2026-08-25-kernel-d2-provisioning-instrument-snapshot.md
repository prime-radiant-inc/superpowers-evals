# Kernel D2 — Provisioning + Instrument Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two D2 materialization libraries (superpowers worktree provisioning, evals+gauntlet instrument snapshot), the capability registry, and the runner threading primitive (`SuperpowersSpec` / `gauntletBin`) that makes per-child superpowers roots real before D3's dispatcher exists.

**Architecture:** Two library modules in `src/campaign/` (no campaign-dir knowledge — caller-supplied destinations) over the injectable synchronous `CommandRunner` seam; a tri-state `SuperpowersSpec` (`undefined` legacy / `{mode:'root',root}` / `{mode:'none'}`) threaded from both CLI parsers through `RunScenarioArgs` into six explicit-wins consumption sites (adapters, setup/checks projections, context substitution + launcher placeholder, provenance, required-env); a snapshot-local gauntlet wrapper exposed as `gauntletBin`; `verifySnapshot` drift guard over all three tree families.

**Tech Stack:** TypeScript on Bun ≥1.3, zod (existing contracts), Commander (CLI), `bun test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md` (revision 2). **Review record:** `docs/experiments/2026-08-25-kernel-d2-spec-review.md`.

## Global Constraints

- **TDD, red first:** every behavior lands as a failing test before its implementation, per step order. Repo gates (`bun run check`, `bun run quorum check`) green per commit.
- **No new dependencies.** Hand-rolled over `node:fs`/`node:path` + the `CommandRunner` seam only.
- **Hermetic test culture:** no mocked-behavior tests. Fake `CommandRunner` records subprocess calls (pattern: `test/appliance-preflight.test.ts`); real tmp git repos as fixtures where git semantics matter (pattern: `test/provenance.test.ts`).
- **Minimal env invariant:** every `CommandRunner` call inside both materializers passes an explicit minimal env — `PATH`, `HOME`, `TMPDIR` only (the seam's documented invariant: omitted env inherits the full parent env, forbidden).
- **Legacy byte-identity:** when `RunScenarioArgs.superpowers` is `undefined`, every behavior — including substituted launcher bytes — is identical to today. This is the Coexistence regression guard.
- **Fail-closed:** explicit modes never fall back to host env; the registry is default-deny; a raw `$SUPERPOWERS_ROOT` surviving context population under `none` is a loud setup error.
- **`SuperpowersSpec` exactly:** `{ mode: 'none' } | { mode: 'root'; root: string }`, homed in `src/agents/superpowers.ts` (new), with the shared helpers there — no per-adapter open-coded ternaries.
- **Module layout:** no `src/campaign/index.ts` barrel exists — modules import directly by path. Match that.
- **Lowercase `quorum`** in code, CLI, paths, and prose (repo convention).

---

### Task 1: `provisioning` module — superpowers worktree materializer

**Files:**
- Create: `src/campaign/provisioning.ts`
- Test: `test/campaign-provisioning.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `CommandOptions`, `CommandResult` from `src/agents/command-runner.ts`; `getEnv` from `src/env.ts` (tests only — the module itself never reads ambient env).
- Produces (later tasks rely on these exact names):
  - `export class ProvisioningError extends Error` (constructor `(message: string)`, sets `this.name = 'ProvisioningError'`)
  - `export interface MaterializeSuperpowersArgs { readonly sourceCheckout: string; readonly sha: string; readonly destParent: string; readonly runner: CommandRunner }`
  - `export function materializeSuperpowersWorktree(args: MaterializeSuperpowersArgs): string` — returns `<destParent>/superpowers-<sha>`
  - `export function ensureWorktreeAt(args: { readonly sourceCheckout: string; readonly sha: string; readonly dest: string; readonly runner: CommandRunner }): void` — the shared core `instrument-snapshot.ts` (Task 2) consumes for its evals/gauntlet trees.

- [ ] **Step 1: Write the failing tests** (`test/campaign-provisioning.test.ts`). Use a minimal recording fake runner (NOT the appliance one):

```ts
import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { defaultCommandRunner } from '../src/agents/command-runner.ts';
import {
  ensureWorktreeAt,
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
    if (command === 'git' && args.includes('worktree') && args.includes('add')) {
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
```

Tests:

```ts
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
  expect(
    runner.calls.filter((c) => c.args.includes('add')),
  ).toHaveLength(0);
});

test('throws on HEAD drift at a pre-existing path', () => {
  const runner = new RecordingRunner();
  runner.head = SHA_B;
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  expect(() => materializeSuperpowersWorktree(args(runner, destParent))).toThrow(
    ProvisioningError,
  );
});

test('throws on porcelain drift at a pre-existing path', () => {
  const runner = new RecordingRunner();
  runner.porcelain = ' M skills/x.md\n';
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  expect(() => materializeSuperpowersWorktree(args(runner, destParent))).toThrow(
    ProvisioningError,
  );
});

test('a symlinked pre-existing destination is never reused', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(destParent, `superpowers-${SHA_A}`));
  expect(() => materializeSuperpowersWorktree(args(runner, destParent))).toThrow(
    ProvisioningError,
  );
  expect(runner.calls).toHaveLength(0);
});

test('two distinct SHAs yield two worktrees', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const a = materializeSuperpowersWorktree(args(runner, destParent));
  const b = materializeSuperpowersWorktree({ ...args(runner, destParent), sha: SHA_B });
  expect(a).not.toBe(b);
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(2);
});

test('failure cleans up via worktree remove --force + prune, never rm -rf', () => {
  const runner = new RecordingRunner();
  runner.failNextWorktreeAdd = true;
  const destParent = tmp();
  expect(() => materializeSuperpowersWorktree(args(runner, destParent))).toThrow(
    ProvisioningError,
  );
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
```

**Note for the implementer:** the real-git test's fixture repo needs git identity config — if `git init`/`commit` fail in CI sandboxes, follow the exact tmp-git setup in `test/provenance.test.ts` instead of the inline `git()` helper above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-provisioning.test.ts`
Expected: FAIL — module `../src/campaign/provisioning.ts` not found.

- [ ] **Step 3: Implement `src/campaign/provisioning.ts`**

```ts
// The superpowers worktree materializer (kernel D2). A library: it knows
// nothing about runs or campaigns; the caller (D3) supplies the destination.
// Every subprocess call goes through the CommandRunner seam with an explicit
// minimal env — the seam's documented invariant forbids inheriting the parent
// env. Confinement idiom mirrors src/campaign/acquire.ts (lstat, never stat;
// validate components before path construction).
import {
  lstatSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import type { CommandRunner } from '../agents/command-runner.ts';

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

/** The minimal env every materializer subprocess gets — PATH/HOME/TMPDIR only. */
function materializeEnv(): Record<string, string | undefined> {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
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
      gitOk(runner, ['-C', sourceCheckout, 'worktree', 'remove', '--force', dest]);
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
```

(The `utimesSync` import is not needed in the implementation — the stale-lock test uses it; do not import it in the module.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-provisioning.test.ts`
Expected: PASS (10 tests). Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/campaign/provisioning.ts test/campaign-provisioning.test.ts
git commit -m "feat(campaign): D2 provisioning module — superpowers worktree materializer

Hex-SHA validation before path construction, lstat confinement, minimal
CommandRunner env, single-flight lockfile with stale reclaim, failure
cleanup via worktree remove --force + prune."
```

---
### Task 2: `instrument-snapshot` module — evals+gauntlet snapshot, verifySnapshot, crash-resume

**Files:**
- Create: `src/campaign/instrument-snapshot.ts`
- Test: `test/campaign-instrument-snapshot.test.ts`

**Interfaces:**
- Consumes: `ensureWorktreeAt`, `ProvisioningError` from `src/campaign/provisioning.ts` (Task 1); `CommandRunner` from `src/agents/command-runner.ts`.
- Produces:
  - `export interface SuperpowersWorktreeRef { readonly root: string; readonly sha: string }`
  - `export interface SnapshotHandle { readonly evalsRoot: string; readonly gauntletRoot: string; readonly gauntletBin: string; readonly superpowersWorktrees: readonly SuperpowersWorktreeRef[]; readonly evalsSha: string; readonly gauntletSha: string }`
  - `export interface MaterializeEvalsSnapshotArgs { readonly evalsCheckout: string; readonly evalsSha: string; readonly gauntletCheckout: string; readonly gauntletSha: string; readonly destDir: string; readonly runner: CommandRunner }`
  - `export function materializeEvalsSnapshot(args: MaterializeEvalsSnapshotArgs): SnapshotHandle`
  - `export function reconstructSnapshot(destDir: string, runner: CommandRunner): SnapshotHandle` — crash-resume: rebuilds the handle from campaign-dir contents alone
  - `export class SnapshotDriftError extends Error`
  - `export function verifySnapshot(handle: SnapshotHandle, runner: CommandRunner): void` — throws unless all three tree families are HEAD-exact + porcelain-clean

- [ ] **Step 1: Write the failing tests** (`test/campaign-instrument-snapshot.test.ts`)

Reuse the `RecordingRunner` pattern from Task 1's test (copy the class into this file — test files do not share fixtures here). Key tests:

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import {
  materializeEvalsSnapshot,
  reconstructSnapshot,
  SnapshotDriftError,
  verifySnapshot,
  type SnapshotHandle,
} from '../src/campaign/instrument-snapshot.ts';

const EVALS_SHA = 'e'.repeat(40);
const GAUNTLET_SHA = '9'.repeat(40);
const SP_SHA = '5'.repeat(40);

class RecordingRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[]; options?: CommandOptions }[] = [];
  heads = new Map<string, string>(); // dir -> HEAD answer
  porcelain = new Map<string, string>(); // dir -> porcelain answer
  run(command: string, args: readonly string[], options?: CommandOptions): CommandResult {
    this.calls.push(options === undefined ? { command, args } : { command, args, options });
    if (command === 'git' && args.includes('rev-parse')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return { status: 0, stdout: `${this.heads.get(dir) ?? EVALS_SHA}\n`, stderr: '' };
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
```

Tests:

```ts
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
  // Wrapper exists, is executable, and execs the snapshot's gauntlet entrypoint:
  const wrapper = readFileSync(handle.gauntletBin, 'utf8');
  expect(wrapper).toBe(
    `#!/bin/sh\nexec bun ${join(destDir, 'gauntlet')}/src/index.ts "$@"\n`,
  );
  expect(statSync(handle.gauntletBin).mode & 0o111).not.toBe(0);
  expect(existsSync(join(destDir, '.quorum-snapshot-ok'))).toBe(true);
});

test('minimal env on every subprocess call', () => {
  const runner = new RecordingRunner();
  materializeEvalsSnapshot(snapArgs(runner, mkdtempSync(join(tmpdir(), 'snap-'))));
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
    runner.calls.filter((c) => c.command === 'bun' && c.args.includes('--frozen-lockfile')),
  ).toHaveLength(2);
  expect(existsSync(join(destDir, '.quorum-snapshot-ok'))).toBe(true);
});

test('verifySnapshot passes when all three families are exact+clean', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
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

test('reconstructSnapshot rebuilds the handle from the campaign dir alone', () => {
  const runner = new RecordingRunner();
  const destDir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(destDir, 'bin'), { recursive: true });
  mkdirSync(join(destDir, 'evals'), { recursive: true });
  mkdirSync(join(destDir, 'gauntlet'), { recursive: true });
  const spRoot = join(destDir, `superpowers-${SP_SHA}`);
  mkdirSync(spRoot, { recursive: true });
  writeFileSync(join(destDir, 'bin', 'gauntlet'), '#!/bin/sh\n');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/campaign-instrument-snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/campaign/instrument-snapshot.ts`**

```ts
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

function minimalEnv(): Record<string, string | undefined> {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    TMPDIR: process.env['TMPDIR'],
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

/** The snapshot-local gauntlet wrapper, mirroring the container's approach
 *  (container/Dockerfile:33): install deps, then a wrapper that execs the
 *  snapshot's gauntlet entrypoint. GAUNTLET_ROOT stays out of the gauntlet
 *  child env — the wrapper is an absolute path, not an env channel. */
function buildGauntletBin(destDir: string, gauntletRoot: string): string {
  const bin = join(destDir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gauntletBin = join(bin, 'gauntlet');
  writeFileSync(
    gauntletBin,
    `#!/bin/sh\nexec bun ${join(gauntletRoot, 'src', 'index.ts')} "$@"\n`,
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
      throw new SnapshotDriftError(
        `${t.label}: working-tree drift:\n${dirty}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/campaign-instrument-snapshot.test.ts`
Expected: PASS (7 tests). Then `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/campaign/instrument-snapshot.ts test/campaign-instrument-snapshot.test.ts
git commit -m "feat(campaign): D2 instrument snapshot — evals+gauntlet materializer + verifySnapshot

SnapshotHandle carries gauntletBin + superpowersWorktrees; re-entry marker
(.quorum-snapshot-ok) prevents half-installed reuse; reconstructSnapshot
rebuilds the handle from the campaign dir for crash-resume; the drift
guard covers all three tree families."
```

---

### Task 3: `SuperpowersSpec`, shared helpers, capability registry

**Files:**
- Create: `src/agents/superpowers.ts`
- Modify: `src/agents/index.ts` (RunHome field + registry, beside CUSTOM_AGENTS)
- Test: `test/agents-superpowers.test.ts`

**Interfaces:**
- Consumes: `getEnv` from `src/env.ts`; `AgentConfig` from `src/contracts/agent-config.ts`.
- Produces:
  - `export type SuperpowersSpec = { mode: 'none' } | { mode: 'root'; root: string }`
  - `export type ResolvedSuperpowers = { kind: 'none' } | { kind: 'root'; root: string } | { kind: 'missing' }`
  - `export function resolveSuperpowersRoot(home: RunHome): ResolvedSuperpowers` — root → threaded; none → skip staging; undefined → ambient (`missing` when unset)
  - `export function projectSuperpowersEnv(spec: SuperpowersSpec | undefined, projected: Record<string, string | undefined>): void` — root → set; none → delete; undefined → no-op
  - `export function superpowersPluginArgs(family: string, spec: SuperpowersSpec | undefined): string` — the launcher placeholder expansion (Task 5 consumes)
  - `RunHome.superpowers?: SuperpowersSpec | undefined` (new optional field)
  - `export interface SuperpowersCapability { readonly ref: boolean; readonly none: boolean }`
  - `export function superpowersCapability(config: AgentConfig | string): SuperpowersCapability` — keyed by `runtime_family ?? name`, default-deny

**Registry enforcement note (recorded so review doesn't flag it as a gap):**
the registry's read side is **D3 registration** (parent: "Registration rejects
`none`/ref arms for agents whose adapter has not implemented the mode"). D2 does
NOT enforce the registry at ad-hoc run time — the Task 11 smoke is itself the
proof vehicle that earns claude's flip, so an ad-hoc explicit-mode run must be
able to run an unflagged adapter (operator-trusted path). This matches the
spec's D-4 and the circularity finding in the review record.

- [ ] **Step 1: Write the failing tests** (`test/agents-superpowers.test.ts`)

```ts
import { expect, test } from 'bun:test';
import {
  projectSuperpowersEnv,
  resolveSuperpowersRoot,
  superpowersCapability,
  superpowersPluginArgs,
} from '../src/agents/superpowers.ts';
import type { RunHome } from '../src/agents/index.ts';

const home = (superpowers?: RunHome['superpowers']): RunHome => ({
  configDir: '/h/.claude',
  workdir: '/w',
  skeletonRoot: undefined,
  superpowers,
});

test('resolveSuperpowersRoot: root mode returns the threaded root', () => {
  expect(
    resolveSuperpowersRoot(home({ mode: 'root', root: '/wt/abc' })),
  ).toEqual({ kind: 'root', root: '/wt/abc' });
});

test('resolveSuperpowersRoot: none mode suppresses', () => {
  expect(resolveSuperpowersRoot(home({ mode: 'none' }))).toEqual({
    kind: 'none',
  });
});

test('resolveSuperpowersRoot: undefined falls back to ambient', () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    expect(resolveSuperpowersRoot(home(undefined))).toEqual({
      kind: 'root',
      root: '/ambient/sp',
    });
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('resolveSuperpowersRoot: undefined with ambient absent is missing', () => {
  delete process.env['SUPERPOWERS_ROOT'];
  expect(resolveSuperpowersRoot(home(undefined))).toEqual({ kind: 'missing' });
});

test('projectSuperpowersEnv: root overrides, none strips, undefined is a no-op', () => {
  const base: Record<string, string | undefined> = {
    SUPERPOWERS_ROOT: '/ambient/sp',
    PATH: '/usr/bin',
  };
  const rootEnv = { ...base };
  projectSuperpowersEnv({ mode: 'root', root: '/wt/abc' }, rootEnv);
  expect(rootEnv['SUPERPOWERS_ROOT']).toBe('/wt/abc');
  const noneEnv = { ...base };
  projectSuperpowersEnv({ mode: 'none' }, noneEnv);
  expect(noneEnv).not.toHaveProperty('SUPERPOWERS_ROOT');
  const legacyEnv = { ...base };
  projectSuperpowersEnv(undefined, legacyEnv);
  expect(legacyEnv).toEqual(base);
});

test('superpowersPluginArgs: claude root/legacy/none expansion', () => {
  expect(
    superpowersPluginArgs('claude', { mode: 'root', root: '/wt/abc' }),
  ).toBe('--plugin-dir "/wt/abc"');
  expect(superpowersPluginArgs('claude', { mode: 'none' })).toBe('');
  // Legacy byte-identity: today's substituted bytes, ambient set and unset.
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    expect(superpowersPluginArgs('claude', undefined)).toBe(
      '--plugin-dir "/ambient/sp"',
    );
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
  expect(superpowersPluginArgs('claude', undefined)).toBe('--plugin-dir ""');
});

test('superpowersPluginArgs: serf mirrors claude; pi has extension+skill', () => {
  expect(
    superpowersPluginArgs('serf', { mode: 'root', root: '/wt/abc' }),
  ).toBe('--plugin-dir "/wt/abc"');
  expect(superpowersPluginArgs('pi', { mode: 'root', root: '/wt/abc' })).toBe(
    '--extension "/wt/abc" --skill "/wt/abc/skills"',
  );
  expect(superpowersPluginArgs('pi', { mode: 'none' })).toBe('');
});

test('superpowersPluginArgs: families without launcher references expand empty', () => {
  expect(
    superpowersPluginArgs('codex', { mode: 'root', root: '/wt/abc' }),
  ).toBe('');
});

test('superpowersCapability: default-deny for undeclared families', () => {
  expect(superpowersCapability('definitely-not-a-family')).toEqual({
    ref: false,
    none: false,
  });
});

test('superpowersCapability: keyed by runtime_family ?? name', () => {
  expect(
    superpowersCapability({
      name: 'builder-alias',
      runtime_family: 'serf',
    } as never),
  ).toEqual(superpowersCapability('serf'));
});
```

(The `as never` cast on the partial AgentConfig keeps the test focused on key resolution; the registry must not read other fields.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/agents-superpowers.test.ts`
Expected: FAIL — module `../src/agents/superpowers.ts` not found.

- [ ] **Step 3: Implement**

`src/agents/superpowers.ts`:

```ts
// Kernel D2: the tri-state superpowers spec and the shared helpers every
// consumption site uses. The three states are load-bearing and never
// conflated: undefined = legacy ambient behavior (byte-identical to the
// pre-D2 harness); {mode:'none'} = explicit suppression (a stock arm —
// absence-of-env is NOT the none signal); {mode:'root'} = an explicit,
// already-materialized root (refs never reach the runner — Decision D-2).
import { getEnv } from '../env.ts';
import type { RunHome } from './index.ts';

export type SuperpowersSpec =
  | { mode: 'none' }
  | { mode: 'root'; root: string };

export type ResolvedSuperpowers =
  | { kind: 'none' } // explicit suppression — skip all staging
  | { kind: 'root'; root: string } // threaded root (explicit, or ambient legacy)
  | { kind: 'missing' }; // legacy ambient absent — the pre-D2 hard-fail path

/** The one tri-state helper all adapters consume (Decision D-3). */
export function resolveSuperpowersRoot(home: RunHome): ResolvedSuperpowers {
  const spec = home.superpowers;
  if (spec !== undefined) {
    return spec.mode === 'root'
      ? { kind: 'root', root: spec.root }
      : { kind: 'none' };
  }
  const root = getEnv('SUPERPOWERS_ROOT');
  return root === undefined || root === ''
    ? { kind: 'missing' }
    : { kind: 'root', root };
}

/** Explicit-wins projection for the setup/checks child env (threading sites
 *  2-3): root overrides the allowlist read; none strips the key entirely;
 *  undefined leaves the projection untouched. */
export function projectSuperpowersEnv(
  spec: SuperpowersSpec | undefined,
  projected: Record<string, string | undefined>,
): void {
  if (spec === undefined) return;
  if (spec.mode === 'root') {
    projected['SUPERPOWERS_ROOT'] = spec.root;
  } else {
    delete projected['SUPERPOWERS_ROOT'];
  }
}

/** The structured launcher placeholder ($SUPERPOWERS_PLUGIN_ARGS) expansion —
 *  threading site 4. Root → the family-specific flags pointing at the threaded
 *  root; none → the flags are ELIDED (never empty-substituted); undefined →
 *  today's exact expansion (legacy byte-identity, including the absent-env
 *  `--plugin-dir ""` form today's substitution produces). Quoting mirrors the
 *  pre-migration launcher templates exactly — double quotes, this flag order. */
export function superpowersPluginArgs(
  family: string,
  spec: SuperpowersSpec | undefined,
): string {
  if (spec?.mode === 'none') return '';
  const root =
    spec?.mode === 'root' ? spec.root : (getEnv('SUPERPOWERS_ROOT') ?? '');
  switch (family) {
    case 'claude':
    case 'serf':
      return `--plugin-dir "${root}"`;
    case 'pi':
      return `--extension "${root}" --skill "${root}/skills"`;
    default:
      return '';
  }
}
```

`src/agents/index.ts` — two edits:

1. Add the `RunHome` field (after `scenarioDir`):

```ts
  /** Kernel D2 threading: the run's superpowers spec. Undefined = legacy
   *  ambient behavior; {mode:'none'} = explicit suppression; {mode:'root'} =
   *  the threaded, already-materialized root. Adapters consume it through
   *  resolveSuperpowersRoot(home) — never getEnv directly. */
  readonly superpowers?: import('./superpowers.ts').SuperpowersSpec | undefined;
```

2. Add the registry beside `CUSTOM_AGENTS` (Decision D-4 — code-level, default-deny; D1 pinned the seam, D2 fills it):

```ts
/** Per-family superpowers mode capability. Absence means unsupported —
 *  default-deny: a YAML claim could drift from implementation, and a false
 *  "supported" claim is the "up and lying" failure class. D2 flags claude
 *  only, after its two-mode live smoke; each further adapter's flip is a
 *  platform PR carrying the same smoke, landed before the qualification
 *  campaign. */
export interface SuperpowersCapability {
  readonly ref: boolean;
  readonly none: boolean;
}

const SUPERPOWERS_CAPABILITY: Readonly<Record<string, SuperpowersCapability>> =
  {};

/** Registry lookup keyed by `runtime_family ?? name` exactly as resolveAgent()
 *  computes it. Takes the loaded AgentConfig (or an already-resolved family
 *  string) — never a bare name looked up from disk, so a registry read never
 *  triggers ambient required_env or CLI-version probes. */
export function superpowersCapability(
  config: AgentConfig | string,
): SuperpowersCapability {
  const family =
    typeof config === 'string' ? config : (config.runtime_family ?? config.name);
  return SUPERPOWERS_CAPABILITY[family] ?? { ref: false, none: false };
}
```

(Re-export `SuperpowersSpec` from `src/agents/index.ts` for runner-side ergonomics:
`export type { SuperpowersSpec } from './superpowers.ts';`)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/agents-superpowers.test.ts`
Expected: PASS (10 tests). Then `bun run check` green (the `import('./superpowers.ts')` inline type avoids a value-level cycle; tsc accepts it — if biome flags it, switch to a top-level `import type { SuperpowersSpec }` and keep the re-export).

- [ ] **Step 5: Commit**

```bash
git add src/agents/superpowers.ts src/agents/index.ts test/agents-superpowers.test.ts
git commit -m "feat(agents): D2 SuperpowersSpec tri-state + shared helpers + capability registry

resolveSuperpowersRoot (explicit-wins with legacy fallback),
projectSuperpowersEnv (setup/checks projections), superpowersPluginArgs
(launcher placeholder, legacy byte-identical), and the default-deny
capability registry keyed by runtime_family ?? name (empty until the
claude smoke flips it)."
```

---
### Task 4: adapter threading — all nine custom adapters consume `resolveSuperpowersRoot`

**Files:**
- Modify: `src/agents/codex.ts`, `src/agents/gemini.ts`, `src/agents/hermes.ts`, `src/agents/pi.ts`, `src/agents/copilot.ts`, `src/agents/opencode.ts`, `src/agents/kimi.ts`, `src/agents/antigravity.ts`, `src/agents/serf.ts` (one edit each)
- Test: extend each adapter's existing test file (`test/agent-<name>.test.ts`)

**Interfaces:**
- Consumes: `resolveSuperpowersRoot(home)` from `src/agents/superpowers.ts` (Task 3), returning `{kind:'root',root} | {kind:'none'} | {kind:'missing'}`.
- Produces: no new exports. Behavioral contract per adapter: `root` → stage from the threaded root; `none` → zero staging commands/staging writes; `missing` → the adapter's existing `ProvisionError` path, unchanged.

**Per-adapter edit pattern** (identical shape in all nine; shown for codex at `src/agents/codex.ts:101-106`):

Current:

```ts
const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
if (superpowersRoot === undefined || superpowersRoot === '') {
  throw new ProvisionError(
    'SUPERPOWERS_ROOT not set; cannot install codex plugin hooks',
  );
}
// ... staging commands using superpowersRoot ...
```

Becomes:

```ts
const sp = resolveSuperpowersRoot(home);
if (sp.kind === 'none') {
  // Explicit suppression (stock arm): zero superpowers staging.
} else if (sp.kind === 'missing') {
  throw new ProvisionError(
    'SUPERPOWERS_ROOT not set; cannot install codex plugin hooks',
  );
} else {
  const superpowersRoot = sp.root;
  // ... existing staging block, indented one level, unchanged ...
}
```

**Per-adapter ambient-read sites** (panel-verified line numbers; find the exact
read and convert it — the table is the map, not a substitute for reading each
adapter):

| Adapter | Read site | Staging it guards |
|---|---|---|
| codex | `src/agents/codex.ts:101` | codex plugin-hooks install |
| gemini | `src/agents/gemini.ts:216` | extension link |
| hermes | `src/agents/hermes.ts:135` | hermes superpowers staging |
| pi | `src/agents/pi.ts:320-326` | pi extension/skill staging |
| copilot | `src/agents/copilot.ts:531` | copilot superpowers staging |
| opencode | `src/agents/opencode.ts:277` | opencode plugin staging |
| kimi | `src/agents/kimi.ts:137` | kimi plugin staging |
| antigravity | `src/agents/antigravity.ts:155` | agy plugin install |
| serf | `src/agents/serf.ts:87` | serf plugin staging |

Rules:
- The existing `ProvisionError` message text is preserved verbatim per adapter (legacy behavior).
- The staging block's body is unchanged except indentation — only its guard changes.
- `getEnv` imports that become unused are removed; biome must stay clean.
- Some adapters interleave the root read with other provision work — move the `resolveSuperpowersRoot` call to where the old `getEnv('SUPERPOWERS_ROOT')` stood; do not reorder staging steps.
- `copilot` provisions through `provisionCopilot` wrapping `provision` (`src/runner/index.ts` special-case) — the edit is inside the same staging code path that reads the env today (`src/agents/copilot.ts:531` region); find the exact read and convert it.
- `claude` (ClaudeAgent) and `claude-windows` (WindowsClaudeAgent) are NOT touched here — claude's channel is the launcher substitution + required-env + provenance (Tasks 5/7/8); claude-windows keeps its legacy ambient read (Windows non-goal).

- [ ] **Step 1: Write the failing tests** — three new tests per adapter, in that adapter's existing test file. Pattern (shown for codex in `test/agent-codex.test.ts`; replicate per adapter using that file's existing fixtures/helpers):

```ts
test('root mode stages from the threaded root, not ambient env', () => {
  // Build the adapter's standard provision fixture per this file's existing
  // tests, but with home.superpowers = { mode: 'root', root: '<tmpA>' } and
  // process.env.SUPERPOWERS_ROOT = '<tmpB>'. Provision with the fake runner.
  // Assert every recorded call/write references <tmpA>, never <tmpB>.
});

test('none mode runs zero superpowers staging commands', () => {
  // Same fixture with home.superpowers = { mode: 'none' }. Assert the fake
  // runner recorded none of the adapter's superpowers staging calls (for
  // codex: no plugin-hooks install call; per-adapter: the staging commands
  // the existing tests already observe) and no ProvisionError was thrown.
});

test('legacy path unchanged: ambient absent still throws the same ProvisionError', () => {
  // home.superpowers undefined; delete process.env.SUPERPOWERS_ROOT.
  // Assert the adapter's existing error message, verbatim.
});
```

For adapters whose existing tests already cover the ambient-set path, add one assertion there instead of a new test: with `home.superpowers = { mode: 'root', root: X }` and ambient `Y`, staging uses X.

- [ ] **Step 2: Run the nine adapter test files to verify the new tests fail**

Run: `bun test test/agent-codex.test.ts test/agent-gemini.test.ts test/agent-pi.test.ts test/agent-copilot.test.ts test/agent-opencode.test.ts test/agent-kimi.test.ts test/agent-hermes.test.ts` (plus the antigravity/serf equivalents — `ls test/ | grep -E 'agent-(antigravity|serf)'` to confirm names)
Expected: FAIL — `resolveSuperpowersRoot` does not change behavior yet (adapters still read ambient), so the root-mode tests fail.

- [ ] **Step 3: Apply the per-adapter edit** to all nine files per the pattern above.

- [ ] **Step 4: Run tests to verify they pass**

Run: the same adapter test files, then `bun run check`.
Expected: all PASS; typecheck/lint green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/ test/agent-*.test.ts
git commit -m "feat(agents): thread home.superpowers through all nine custom adapters

Each adapter consumes resolveSuperpowersRoot(home): root stages from the
threaded root, none skips staging entirely, missing preserves the existing
ProvisionError. Legacy ambient behavior byte-identical."
```

---

### Task 5: launcher placeholder — `$SUPERPOWERS_PLUGIN_ARGS` + none-mode fail-loud

**Files:**
- Modify: `src/runner/index.ts` (substitution map at ~line 1543-1552; the `populateContextDir` call site(s))
- Modify: `coding-agents/claude-context/launch-agent`, `coding-agents/serf-context/launch-agent`, `coding-agents/pi-context/launch-agent`
- Test: `test/runner-superpowers-launcher.test.ts`

**Interfaces:**
- Consumes: `superpowersPluginArgs(family, spec)` from `src/agents/superpowers.ts` (Task 3); `populateContextDir`'s existing `forbiddenPlaceholders` parameter (`src/runner/context.ts:25-71`).
- Produces: substitution-map keys `$SUPERPOWERS_PLUGIN_ARGS` (always present) and `$SUPERPOWERS_ROOT` (absent under none mode); the runner's `populateContextDir` calls gain `$SUPERPOWERS_PLUGIN_ARGS` as an always-forbidden placeholder and `$SUPERPOWERS_ROOT` as a forbidden placeholder under none mode.

- [ ] **Step 1: Read the three launcher templates** and note the exact text being replaced:
  - `coding-agents/claude-context/launch-agent:106-110` — `--plugin-dir "$SUPERPOWERS_ROOT"` inside the exec line
  - `coding-agents/serf-context/launch-agent` (~line 67) and `coding-agents/pi-context/launch-agent` (~lines 82-85) — read them; record their exact flag text and quoting. The Task 3 helper's expansion strings already mirror claude/pi/serf — if the templates' actual text differs from the helper (quoting, order, extra flags), FIX THE HELPER to match the template, not vice versa.

- [ ] **Step 2: Write the failing tests** (`test/runner-superpowers-launcher.test.ts`)

The substitution map is built inside `runScenario` and consumed by `populateContextDir`; test at the `populateContextDir` level with the real substitution-map builder. The builder is currently inline in `runScenario` — this task extracts it into an exported pure function so it is testable:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// buildContextSubstitutions is extracted from runScenario by this task:
import { buildContextSubstitutions } from '../src/runner/index.ts';
import { populateContextDir } from '../src/runner/context.ts';

test('root mode: launcher placeholder expands to the threaded root flags', () => {
  const subs = buildContextSubstitutions({
    launchCwd: '/w',
    launchAgentPath: '/ctx/launch-agent',
    runHomeDir: '/h',
    family: 'claude',
    superpowers: { mode: 'root', root: '/wt/abc' },
  });
  expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('--plugin-dir "/wt/abc"');
  expect(subs['$SUPERPOWERS_ROOT']).toBe('/wt/abc');
});

test('none mode: placeholder elides flags; raw $SUPERPOWERS_ROOT fails loud in context', () => {
  const subs = buildContextSubstitutions({
    launchCwd: '/w',
    launchAgentPath: '/ctx/launch-agent',
    runHomeDir: '/h',
    family: 'claude',
    superpowers: { mode: 'none' },
  });
  expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('');
  expect(subs).not.toHaveProperty('$SUPERPOWERS_ROOT');
  // The fail-loud half: a populated context still referencing the raw
  // placeholder must raise under none mode.
  const agentsDir = mkdtempSync(join(tmpdir(), 'agents-'));
  mkdirSync(join(agentsDir, 'claude-context'));
  writeFileSync(
    join(agentsDir, 'claude-context', 'launch-agent'),
    'exec claude --plugin-dir "$SUPERPOWERS_ROOT"\n',
  );
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  expect(() =>
    populateContextDir({
      codingAgentsDir: agentsDir,
      codingAgent: 'claude',
      runDir,
      substitutions: subs,
      required: true,
      forbiddenPlaceholders: ['$SUPERPOWERS_PLUGIN_ARGS', '$SUPERPOWERS_ROOT'],
    }),
  ).toThrow(/SUPERPOWERS_ROOT/);
});

test('legacy mode: byte-identical expansion, ambient set and unset', () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    const subs = buildContextSubstitutions({
      launchCwd: '/w',
      launchAgentPath: '/ctx/launch-agent',
      runHomeDir: '/h',
      family: 'claude',
      superpowers: undefined,
    });
    expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('--plugin-dir "/ambient/sp"');
    expect(subs['$SUPERPOWERS_ROOT']).toBe('/ambient/sp');
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
  const subs = buildContextSubstitutions({
    launchCwd: '/w',
    launchAgentPath: '/ctx/launch-agent',
    runHomeDir: '/h',
    family: 'claude',
    superpowers: undefined,
  });
  expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('--plugin-dir ""');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/runner-superpowers-launcher.test.ts`
Expected: FAIL — `buildContextSubstitutions` is not exported/does not exist.

- [ ] **Step 4: Implement**

In `src/runner/index.ts`:

0. **Add the runner channel fields** (no earlier task adds them — this is the
   first runner-side task):
   - `RunScenarioArgs` gains:
     ```ts
     // D2 threading: the run's superpowers spec. Undefined = legacy ambient
     // behavior; {mode:'none'} = explicit suppression; {mode:'root'} = the
     // threaded, already-materialized root. Explicit modes never fall back to
     // host env.
     readonly superpowers?: SuperpowersSpec | undefined;
     ```
     (import the type: `import type { SuperpowersSpec } from '../agents/superpowers.ts';`)
   - At the `RunHome` construction site (grep `configDir,` / `skeletonRoot` in
     `runScenario` to find the object literal), add `superpowers: a.superpowers`
     so Task 4's adapters actually receive the threaded value.

1. Extract the substitution-map construction (~line 1543-1552 plus any family-conditional additions through ~1610) into an exported pure function. Preserve every existing key; add `$SUPERPOWERS_PLUGIN_ARGS`:

```ts
/** The populateContextDir substitution map. Extracted as a pure exported
 *  function so the D2 threading (superpowers spec) is unit-testable. `family`
 *  is `config.runtime_family ?? config.name`. */
export function buildContextSubstitutions(args: {
  readonly launchCwd: string;
  readonly launchAgentPath: string;
  readonly runHomeDir: string;
  readonly family: string;
  readonly superpowers?: SuperpowersSpec | undefined;
}): Record<string, string> {
  const spec = args.superpowers;
  const substitutions: Record<string, string> = {
    $QUORUM_AGENT_CWD: args.launchCwd,
    $QUORUM_AGENT_CWD_SH: shellSingleQuote(args.launchCwd),
    $SUPERPOWERS_PLUGIN_ARGS: superpowersPluginArgs(args.family, spec),
    $QUORUM_LAUNCH_AGENT: args.launchAgentPath,
    $QUORUM_LAUNCH_AGENT_SH: shellSingleQuote(args.launchAgentPath),
    ...homeEnvSubstitutions(args.runHomeDir),
  };
  // $SUPERPOWERS_ROOT: absent under none mode (a surviving raw reference
  // there is an instrument bug — the fail-loud forbiddenPlaceholders rule
  // catches it); the threaded root under root mode; ambient (or today's
  // empty-string form) under legacy.
  if (spec?.mode === 'root') {
    substitutions['$SUPERPOWERS_ROOT'] = spec.root;
  } else if (spec === undefined) {
    substitutions['$SUPERPOWERS_ROOT'] = getEnv('SUPERPOWERS_ROOT') ?? '';
  }
  return substitutions;
}
```

(If the existing map has family-conditional entries beyond those shown, carry them over exactly — read the full construction region before extracting.)

2. At the `runScenario` call site, replace the inline construction with `buildContextSubstitutions({ ..., family: cfg.runtime_family ?? cfg.name, superpowers: a.superpowers })`.

3. At each `populateContextDir` call site, compute:

```ts
const forbidden: string[] = [
  ...existingForbiddenPlaceholders, // e.g. ['$CLAUDE_MODEL'] for claude
  '$SUPERPOWERS_PLUGIN_ARGS',
  ...(a.superpowers?.mode === 'none' ? ['$SUPERPOWERS_ROOT'] : []),
];
```

4. Migrate the three templates — replace the exact flag text with `$SUPERPOWERS_PLUGIN_ARGS`:
   - claude: `--plugin-dir "$SUPERPOWERS_ROOT"` → `$SUPERPOWERS_PLUGIN_ARGS`
   - serf: same
   - pi: `--extension "$SUPERPOWERS_ROOT" --skill "$SUPERPOWERS_ROOT/skills"` (or whatever the exact current text is) → `$SUPERPOWERS_PLUGIN_ARGS`
   Leave the placeholder UNQUOTED in the template (it is a flags splice).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/runner-superpowers-launcher.test.ts` then `bun test test/cli-run.test.ts` (the real-CLI hermetic runs exercise the migrated claude template end-to-end via mock-gauntlet) then `bun run check`.
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runner/index.ts coding-agents/claude-context/launch-agent coding-agents/serf-context/launch-agent coding-agents/pi-context/launch-agent test/runner-superpowers-launcher.test.ts
git commit -m "feat(runner): structured launcher placeholder \$SUPERPOWERS_PLUGIN_ARGS

claude/serf/pi launcher templates migrate off the literal \$SUPERPOWERS_ROOT;
expansion is mode-aware (root → threaded flags, none → elided, legacy →
byte-identical). None mode drops \$SUPERPOWERS_ROOT from the substitution map
and forbids its survival via forbiddenPlaceholders."
```

---

### Task 6: setup + checks projections threading (sites 2-3)

**Files:**
- Modify: `src/setup-step.ts` (`runSetup`)
- Modify: `src/checks/index.ts` (`runPhase`)
- Modify: `src/runner/index.ts` (pass `a.superpowers` at both call sites)
- Test: `test/runner-superpowers-projections.test.ts`

**Interfaces:**
- Consumes: `projectSuperpowersEnv(spec, projected)` from `src/agents/superpowers.ts` (Task 3); `SuperpowersSpec`.
- Produces: `runSetup(scenarioDir, workdir, envExtra?, superpowers?)` and `RunPhaseArgs.superpowers?: SuperpowersSpec | undefined`.

- [ ] **Step 1: Write the failing tests** (`test/runner-superpowers-projections.test.ts`)

Both projections spawn real subprocesses, so test through them with a tiny scenario fixture that records its environment:

```ts
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/setup-step.ts';
import { runPhase } from '../src/checks/index.ts';

function scenarioRecordingEnv(): { dir: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = join(dir, 'env.out');
  writeFileSync(
    join(dir, 'setup.sh'),
    `#!/usr/bin/env bash\nprintf 'SUPERPOWERS_ROOT=%s\\n' "\${SUPERPOWERS_ROOT-<unset>}" > "$QUORUM_SCENARIO_DIR/env.out"\n`,
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return { dir, out };
}

test('setup projection: root mode overrides the allowlist read', () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    const { dir, out } = scenarioRecordingEnv();
    runSetup(dir, mkdtempSync(join(tmpdir(), 'wd-')), {}, {
      mode: 'root',
      root: '/wt/abc',
    });
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=/wt/abc\n');
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('setup projection: none mode strips SUPERPOWERS_ROOT', () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    const { dir, out } = scenarioRecordingEnv();
    runSetup(dir, mkdtempSync(join(tmpdir(), 'wd-')), {}, { mode: 'none' });
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=<unset>\n');
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('setup projection: undefined preserves legacy ambient behavior', () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    const { dir, out } = scenarioRecordingEnv();
    runSetup(dir, mkdtempSync(join(tmpdir(), 'wd-')));
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=/ambient/sp\n');
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('checks projection: root overrides, none strips', async () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    const out = join(dir, 'checks-env.out');
    writeFileSync(
      join(dir, 'checks.sh'),
      `pre() { printf 'SUPERPOWERS_ROOT=%s\\n' "\${SUPERPOWERS_ROOT-<unset>}" > "${out}"; }\npost() { :; }\n`,
    );
    const base = {
      checksSh: join(dir, 'checks.sh'),
      phase: 'pre' as const,
      workdir: mkdtempSync(join(tmpdir(), 'wd-')),
      repoRoot: join(import.meta.dir, '..'),
    };
    const root = await runPhase({ ...base, superpowers: { mode: 'root', root: '/wt/abc' } });
    expect(root.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=/wt/abc\n');
    const none = await runPhase({ ...base, superpowers: { mode: 'none' } });
    expect(none.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=<unset>\n');
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});
```

(If `runPhase`'s record-collection requires the sink plumbing, the checks.sh fixture above emits no records — that is fine: the assertion is on the env file, and an empty-record phase is ok per the crash-band discipline.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/runner-superpowers-projections.test.ts`
Expected: FAIL — `runSetup`/`runPhase` do not accept `superpowers` (tsc error / extra arg ignored → assertions fail on ambient values).

- [ ] **Step 3: Implement**

`src/setup-step.ts` — `runSetup` gains the fourth parameter and applies the helper after the env object is built:

```ts
export function runSetup(
  scenarioDir: string,
  workdir: string,
  envExtra: Record<string, string> = {},
  superpowers?: SuperpowersSpec | undefined,
): void {
  // ... unchanged through the env object construction ...
  const env = {
    ...Object.fromEntries(SETUP_ENV_ALLOWLIST.map((name) => [name, getEnv(name)])),
    BASH_ENV: prelude,
    QUORUM_REPO_ROOT: root,
    QUORUM_WORKDIR: workdir,
    QUORUM_SCENARIO_DIR: scenarioDir,
    ...envExtra,
  };
  projectSuperpowersEnv(superpowers, env);
  // ... spawnSync with env, unchanged ...
}
```

`src/checks/index.ts` — `RunPhaseArgs` gains `readonly superpowers?: SuperpowersSpec | undefined`; after the `env` object literal (~line 108-133) add `projectSuperpowersEnv(args.superpowers, env);`.

`src/runner/index.ts` — find the `runSetup(` and `runPhase(` call sites (`grep -n "runSetup(\|runPhase(" src/runner/index.ts`) and pass `a.superpowers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/runner-superpowers-projections.test.ts` then `bun run check`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/setup-step.ts src/checks/index.ts src/runner/index.ts test/runner-superpowers-projections.test.ts
git commit -m "feat(runner): thread superpowers spec into setup/checks env projections

Root overrides the allowlist read; none strips SUPERPOWERS_ROOT from both
projections; undefined is byte-identical legacy."
```

---

### Task 7: provenance threading + loud-at-start rejections (site 5)

**Files:**
- Modify: `src/runner/provenance.ts` (`collectProvenance`)
- Modify: `src/runner/index.ts` (pass the spec to collectProvenance; the two loud-at-start rejections early in `runScenario`)
- Test: `test/runner-superpowers-provenance.test.ts`

**Interfaces:**
- Consumes: `SuperpowersSpec` from `src/agents/superpowers.ts`.
- Produces: `collectProvenance(args: { repoRoot; agentBinary; runHomeDir; superpowers?: SuperpowersSpec | undefined; gauntletBinary?: string })` — the `gauntletBinary` field is added here and consumed by Task 9.

- [ ] **Step 1: Write the failing tests** (`test/runner-superpowers-provenance.test.ts`)

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectProvenance } from '../src/runner/provenance.ts';

function tmpGitRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'));
  const git = (a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  const sha = (git(['rev-parse', 'HEAD']).stdout ?? '').trim();
  return { dir, sha };
}

const base = { agentBinary: null, runHomeDir: mkdtempSync(join(tmpdir(), 'home-')) };

test('root mode: provenance reads the threaded root, ignoring ambient and the REV override', () => {
  const { dir, sha } = tmpGitRepo();
  process.env['SUPERPOWERS_ROOT'] = '/ambient/elsewhere';
  delete process.env['QUORUM_SUPERPOWERS_REV'];
  try {
    const p = collectProvenance({
      ...base,
      repoRoot: dir,
      superpowers: { mode: 'root', root: dir },
    });
    expect(p.superpowers_rev).toBe(sha);
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('none mode: rev and dirty are null even with ambient set', () => {
  process.env['SUPERPOWERS_ROOT'] = '/ambient/elsewhere';
  try {
    const p = collectProvenance({
      ...base,
      repoRoot: tmpGitRepo().dir,
      superpowers: { mode: 'none' },
    });
    expect(p.superpowers_rev).toBeNull();
    expect(p.superpowers_dirty).toBeNull();
  } finally {
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('legacy: QUORUM_SUPERPOWERS_REV override still wins (unchanged)', () => {
  process.env['QUORUM_SUPERPOWERS_REV'] = 'deadbeef'.repeat(5);
  try {
    const p = collectProvenance({ ...base, repoRoot: tmpGitRepo().dir });
    expect(p.superpowers_rev).toBe('deadbeef'.repeat(5));
  } finally {
    delete process.env['QUORUM_SUPERPOWERS_REV'];
  }
});
```

(The loud-at-start rejections are runner-level and covered by Task 10's CLI tests; the unit surface here is collectProvenance.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/runner-superpowers-provenance.test.ts`
Expected: FAIL — `superpowers` arg unknown (tsc) or assertions fail.

- [ ] **Step 3: Implement**

`src/runner/provenance.ts`:

```ts
export function collectProvenance(args: {
  repoRoot: string;
  agentBinary: string | null;
  runHomeDir: string;
  /** D2 threading: explicit superpowers mode. Undefined = legacy (ambient env
   *  + QUORUM_SUPERPOWERS_REV container override). */
  superpowers?: SuperpowersSpec | undefined;
  /** D2 instrument snapshot: the snapshot-local gauntlet wrapper; when absent
   *  the version probe resolves 'gauntlet' via PATH (legacy). */
  gauntletBinary?: string | undefined;
}): RunProvenance {
  const spec = args.superpowers;
  // Root: the threaded root's real HEAD is authoritative (the REV override is
  // honored only on the legacy path — under an explicit mode it is rejected
  // at run start, so it can never reach here).
  const sproot =
    spec === undefined
      ? getEnv('SUPERPOWERS_ROOT')
      : spec.mode === 'root'
        ? spec.root
        : undefined;
  return {
    superpowers_rev: sproot
      ? spec === undefined
        ? (hostRev() ?? gitRev(sproot))
        : gitRev(sproot)
      : null,
    superpowers_dirty: sproot
      ? spec === undefined
        ? (hostDirty() ?? gitDirty(sproot))
        : gitDirty(sproot)
      : null,
    harness_rev: gitRev(args.repoRoot),
    agent_cli_version: args.agentBinary
      ? versionLine(args.agentBinary, args.runHomeDir)
      : null,
    gauntlet_version: versionLine(args.gauntletBinary ?? 'gauntlet', args.runHomeDir),
    host_platform: process.platform,
  };
}
```

`src/runner/index.ts`:
1. Pass `superpowers: a.superpowers` at the `collectProvenance` call site.
2. Early in `runScenario` (before provisioning — beside the existing args validation), add the two loud-at-start rejections:

```ts
  // Loud-at-start rejections (D2): an explicit superpowers mode is a contract
  // that the run's provenance is exact. The REV override (container path) would
  // stamp a rev the run never used, and the Windows path has no explicit-mode
  // support (parent non-goal).
  if (a.superpowers !== undefined && getEnv('QUORUM_SUPERPOWERS_REV')) {
    throw new RunnerError(
      'QUORUM_SUPERPOWERS_REV is set while an explicit superpowers mode is active — it would stamp a rev the run never used',
      'setup',
    );
  }
  if (a.superpowers !== undefined && (a.os ?? 'linux') !== 'linux') {
    throw new RunnerError(
      'explicit superpowers modes are not supported with --os windows (mixed-state rejection)',
      'setup',
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/runner-superpowers-provenance.test.ts` then `bun run check`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner/provenance.ts src/runner/index.ts test/runner-superpowers-provenance.test.ts
git commit -m "feat(runner): provenance reads the threaded root; loud-at-start rejections

Root mode: git probe of the threaded root is authoritative; none: null.
QUORUM_SUPERPOWERS_REV honored only on the legacy path — its presence under
an explicit mode, and explicit modes under --os windows, error at run start."
```

---
### Task 8: required-env resolution against the effective environment (site 6)

**Files:**
- Modify: `src/contracts/agent-config.ts` (`loadAgentConfig`, ~lines 204-229)
- Modify: `src/runner/index.ts` (the `loadAgentConfig` call at ~line 1245; delete the duplicate required-env loop at ~lines 1336-1343)
- Test: `test/agent-config-effective-env.test.ts`

**Interfaces:**
- Consumes: `SuperpowersSpec`.
- Produces: `loadAgentConfig(codingAgentsDir: string, name: string, opts?: { readonly env?: (key: string) => string | undefined; readonly suppressRequired?: readonly string[] }): AgentConfig` — when `env` is provided it replaces the ambient read in the required_env check; `suppressRequired` names are excluded from that check.

**Design note (the spec's reconciliation):** today required_env is checked twice — inside `loadAgentConfig` (`src/contracts/agent-config.ts:215-224`) and again in the runner loop (`src/runner/index.ts:1336-1343`). This task makes it one validation: `loadAgentConfig` validates against the caller-supplied effective environment, and the runner's duplicate loop is deleted. All non-runner callers keep today's behavior (no opts → ambient check, unchanged).

- [ ] **Step 1: Write the failing tests** (`test/agent-config-effective-env.test.ts`)

The existing config-loader tests use a tmp `coding-agents` dir — mirror their fixture pattern (read one existing test, e.g. `test/agent-config.test.ts`, for the minimal valid YAML shape):

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentConfig } from '../src/contracts/agent-config.ts';

function agentDir(requiredEnv: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(
    join(dir, 'testagent.yaml'),
    [
      'name: testagent',
      'runtime_family: claude',
      'model: claude-test',
      'home_config_subdir: .claude',
      'session_log_dir: .claude/projects',
      `required_env: [${requiredEnv.join(', ')}]`,
      '',
    ].join('\n'),
  );
  return dir;
}

test('effective env satisfies a SUPERPOWERS_ROOT requirement with ambient unset', () => {
  delete process.env['SUPERPOWERS_ROOT'];
  const dir = agentDir(['SUPERPOWERS_ROOT']);
  const cfg = loadAgentConfig(dir, 'testagent', {
    env: (key) => (key === 'SUPERPOWERS_ROOT' ? '/wt/abc' : process.env[key]),
  });
  expect(cfg.name).toBe('testagent');
});

test('suppressRequired excludes SUPERPOWERS_ROOT with ambient unset', () => {
  delete process.env['SUPERPOWERS_ROOT'];
  const dir = agentDir(['SUPERPOWERS_ROOT']);
  const cfg = loadAgentConfig(dir, 'testagent', {
    suppressRequired: ['SUPERPOWERS_ROOT'],
  });
  expect(cfg.name).toBe('testagent');
});

test('other required vars are still enforced against the effective env', () => {
  delete process.env['SUPERPOWERS_ROOT'];
  delete process.env['SOME_OTHER_KEY'];
  const dir = agentDir(['SUPERPOWERS_ROOT', 'SOME_OTHER_KEY']);
  expect(() =>
    loadAgentConfig(dir, 'testagent', {
      env: (key) => (key === 'SUPERPOWERS_ROOT' ? '/wt/abc' : process.env[key]),
      suppressRequired: ['SUPERPOWERS_ROOT'],
    }),
  ).toThrow(/SOME_OTHER_KEY/);
});

test('no opts: ambient check unchanged (legacy)', () => {
  delete process.env['SOME_OTHER_KEY'];
  const dir = agentDir(['SOME_OTHER_KEY']);
  expect(() => loadAgentConfig(dir, 'testagent')).toThrow(/SOME_OTHER_KEY/);
});
```

(The minimal YAML shape above must match what `validateAgentConfigStatic` accepts — read `test/agent-config.test.ts`'s fixtures first and copy their minimal valid YAML exactly, adding only the `required_env` line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/agent-config-effective-env.test.ts`
Expected: FAIL — third argument not accepted (tsc) / assertions fail.

- [ ] **Step 3: Implement**

`src/contracts/agent-config.ts`:

```ts
export function loadAgentConfig(
  codingAgentsDir: string,
  name: string,
  opts?: {
    /** Effective-environment reader for the required_env check (D2 site 6:
     *  the runner validates against the threaded mode, not ambient env). */
    readonly env?: (key: string) => string | undefined;
    /** Required names suppressed by the caller (D2: SUPERPOWERS_ROOT under
     *  {mode:'none'}). */
    readonly suppressRequired?: readonly string[];
  },
): AgentConfig {
  const { path, cfg } = readAgentConfigFile(codingAgentsDir, name);

  // Loader validations, in order: name==stem, runtime_family known, claude
  // requires a non-blank model, then required_env present. Each is a
  // CodingAgentConfigError -> setup indeterminate.
  validateAgentConfigStatic(path, cfg, name);

  // required_env must be set (a present-but-empty value counts as missing).
  // Against the caller's effective environment when supplied.
  const envReader = opts?.env ?? getEnv;
  const suppressed = new Set(opts?.suppressRequired ?? []);
  const missingEnv = cfg.required_env
    .filter((v) => !suppressed.has(v))
    .filter((v) => {
      const value = envReader(v);
      return value === undefined || value === '';
    });
  if (missingEnv.length > 0) {
    throw new CodingAgentConfigError(
      `${path}: required env vars not set: ${missingEnv.join(', ')}`,
    );
  }

  enforceCliVersionPin(path, cfg);

  return resolveProjectPrompt(path, cfg);
}
```

`src/runner/index.ts`:
1. The `loadAgentConfig(a.codingAgentsDir, a.codingAgent)` call (~line 1245) becomes:

```ts
  const cfg = loadAgentConfig(a.codingAgentsDir, a.codingAgent, {
    env: (key) => {
      if (key === 'SUPERPOWERS_ROOT' && a.superpowers?.mode === 'root') {
        return a.superpowers.root;
      }
      return getEnv(key);
    },
    ...(a.superpowers?.mode === 'none'
      ? { suppressRequired: ['SUPERPOWERS_ROOT'] }
      : {}),
  });
```

(If `cfg` is already loaded elsewhere in `runScenario`, adapt — the rule is: exactly one `loadAgentConfig` call, carrying the effective env.)

2. Delete the duplicate loop at ~1336-1343 (`for (const key of cfg.required_env) { if (!getEnv(key)) … }`) — validation now happens once, inside `loadAgentConfig`, against the effective env.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/agent-config-effective-env.test.ts test/agent-config.test.ts test/cli-run.test.ts`
Expected: PASS (the cli-run harness still seeds SUPERPOWERS_ROOT, so legacy behavior is exercised there too). Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/agent-config.ts src/runner/index.ts test/agent-config-effective-env.test.ts
git commit -m "feat(runner): required-env validated once, against the effective environment

loadAgentConfig takes an effective-env reader + suppressRequired; the
runner's duplicate ambient loop is deleted. Root mode satisfies
SUPERPOWERS_ROOT with the threaded root; none mode suppresses it; legacy
ambient behavior unchanged."
```

---

### Task 9: `gauntletBin` threading

**Files:**
- Modify: `src/runner/index.ts` (`RunScenarioArgs`, `InvokeGauntletArgs`, `spawnGauntlet`, the provenance call site)
- Modify: `src/cli/run-child.ts` (the internal parser gains `--gauntlet-bin <path>`)
- Modify: `src/cli/run-command.ts` (`RunCommandOptions.gauntletBin?: string`; passthrough into `RunScenarioArgs`)
- Test: `test/runner-gauntlet-bin.test.ts`

**Interfaces:**
- Consumes: the `gauntletBinary?: string` field on `collectProvenance` (Task 7).
- Produces: `RunScenarioArgs.gauntletBin?: string | undefined`; `RunCommandOptions.gauntletBin?: string`; the run-child flag `--gauntlet-bin`.

**Spec note (completes the D3 hand-off):** revision 2 pins `RunScenarioArgs.gauntletBin` and names the CLI projection for the superpowers flags only; without a run-child flag, D3's CLI-spawned campaign child could not receive the wrapper path at all (the same route gap the panel's fidelity seat found for the superpowers flags). The flag is internal (run-child parser only), additive, and default-off — flagged here so review can see the reasoning.

- [ ] **Step 1: Write the failing test** (`test/runner-gauntlet-bin.test.ts`)

A decoy-PATH test through the internal run-child route, using the mock-gauntlet harness pattern from `test/cli-run.test.ts` (read it first; reuse `mockGauntletDir`):

```ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const RUN_CHILD = resolve(import.meta.dir, '..', 'src', 'cli', 'run-child.ts');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

test('gauntletBin wins over a decoy gauntlet earlier on PATH', () => {
  // Decoy: a gauntlet that, if executed, writes a marker and exits 127.
  const decoyDir = mkdtempSync(join(tmpdir(), 'decoy-'));
  const decoyMarker = join(decoyDir, 'decoy-ran');
  writeFileSync(join(decoyDir, 'gauntlet'), `#!/bin/sh\necho ran > "${decoyMarker}"\nexit 127\n`);
  chmodSync(join(decoyDir, 'gauntlet'), 0o755);

  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(join(scn, 'story.md'), '---\nquorum_max_time: 1m\n---\nDo the thing.');
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');

  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  // The real mock-gauntlet shim is the sentinel binary we expect to run.
  const sentinelGauntlet = join(mockGauntletDir('pass'), 'gauntlet');
  const proc = spawnSync(
    'bun',
    [
      RUN_CHILD,
      scn,
      '--coding-agent', 'claude',
      '--coding-agents-dir', REAL_CODING_AGENTS,
      '--out-root', outRoot,
      '--credentials-file', resolve(import.meta.dir, 'fixtures', 'serf-campaign-credentials.yaml'),
      '--gauntlet-bin', sentinelGauntlet,
    ],
    {
      env: {
        ...process.env,
        PATH: `${decoyDir}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
      },
      encoding: 'utf8',
    },
  );
  expect(existsSync(decoyMarker)).toBe(false);
  expect(proc.status).toBe(0);
  // The run produced a verdict (the sentinel mock gauntlet drove it):
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  expect(runs.length).toBe(1);
  const verdict = JSON.parse(
    readFileSync(join(outRoot, runs[0] ?? '', 'verdict.json'), 'utf8'),
  );
  expect(verdict.run_id).toBe(runs[0]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/runner-gauntlet-bin.test.ts`
Expected: FAIL — `--gauntlet-bin` is an unknown option (Commander exits with usage error).

- [ ] **Step 3: Implement**

1. `src/runner/index.ts`: `RunScenarioArgs` gains

```ts
  // D2 instrument snapshot: the snapshot-local gauntlet wrapper. When present,
  // the gauntlet spawn seam and the gauntlet version probe use it; when absent,
  // legacy PATH resolution, unchanged.
  readonly gauntletBin?: string | undefined;
```

`InvokeGauntletArgs` gains `gauntletBin?: string | undefined`; in `spawnGauntlet`, `spawn(a.gauntletBin ?? 'gauntlet', buildGauntletArgv(a), …)`. Find the `invokeGauntlet`/`spawnGauntlet` call site and pass `a.gauntletBin`; pass `gauntletBinary: a.gauntletBin` at the `collectProvenance` call site.

2. `src/cli/run-child.ts`: add `.option('--gauntlet-bin <path>')` before `.action(...)`.

3. `src/cli/run-command.ts`: `RunCommandOptions` gains `readonly gauntletBin?: string`; in `executeRunCommand`, where options are mapped into `RunScenarioArgs`, add:

```ts
    ...(opts.gauntletBin !== undefined
      ? { gauntletBin: resolve(opts.gauntletBin) }
      : {}),
```

(Commander camel-cases `--gauntlet-bin` to `opts.gauntletBin`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/runner-gauntlet-bin.test.ts test/cli-run.test.ts` then `bun run check`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner/index.ts src/cli/run-child.ts src/cli/run-command.ts test/runner-gauntlet-bin.test.ts
git commit -m "feat(runner): gauntletBin threading — snapshot-local gauntlet wrapper channel

RunScenarioArgs.gauntletBin reaches the spawn seam and the version probe;
the internal run-child parser gains --gauntlet-bin so D3's campaign children
can receive the wrapper path. Absent = legacy PATH resolution."
```

---

### Task 10: CLI projection — both parsers + child-argv pass-through

**Files:**
- Modify: `src/cli/index.ts` (public `quorum run` command)
- Modify: `src/cli/run-child.ts` (internal parser)
- Modify: `src/cli/run-command.ts` (`RunCommandOptions`, `executeRunCommand`)
- Modify: `src/run-all/index.ts` (`buildChildRunArgs` gains optional pass-through fields — additive, defaults preserve legacy)
- Test: `test/cli-run-superpowers.test.ts`

**Interfaces:**
- Consumes: `SuperpowersSpec` from `src/agents/superpowers.ts`.
- Produces: `RunCommandOptions.superpowersRoot?: string`, `RunCommandOptions.noSuperpowers?: boolean`; the `--superpowers-root <path>` / `--no-superpowers` flags on both parsers; `buildChildRunArgs` accepts optional `{ superpowersRoot?: string; noSuperpowers?: boolean }` and forwards the flags when set.

- [ ] **Step 1: Write the failing tests** (`test/cli-run-superpowers.test.ts`)

Mirror `test/cli-run.test.ts`'s harness (copy its `runCli`/`scenario` helpers into this file, adjusted to also accept an env override), plus:

```ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(join(scn, 'story.md'), '---\nquorum_max_time: 1m\n---\nDo the thing.');
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function tmpGitRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'));
  const git = (a: string[]) =>
    spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'SKILL.md'), 'x\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return { dir, sha: (git(['rev-parse', 'HEAD']).stdout ?? '').trim() };
}

function runCli(args: string[], envExtra: Record<string, string> = {}) {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI, 'run', scenario(),
      '--coding-agent', 'claude',
      '--coding-agents-dir', REAL_CODING_AGENTS,
      '--out-root', outRoot,
      ...args,
    ],
    {
      env: {
        ...process.env,
        PATH: `${mockGauntletDir('pass')}:${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
        ...envExtra,
      },
      encoding: 'utf8',
    },
  );
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, outRoot };
}

function readSoleVerdict(outRoot: string) {
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  expect(runs.length).toBe(1);
  return JSON.parse(readFileSync(join(outRoot, runs[0] ?? '', 'verdict.json'), 'utf8'));
}

test('mutual exclusion: both flags is a usage error', () => {
  const r = runCli(['--superpowers-root', '/tmp/x', '--no-superpowers']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/mutually exclusive|cannot be used with|conflict/i);
});

test('--superpowers-root: provenance reads the threaded root, not ambient', () => {
  const { dir, sha } = tmpGitRepo();
  // Ambient SUPERPOWERS_ROOT is empty (present-but-empty counts as missing):
  // proves the root-mode run does not depend on the ambient channel — neither
  // for provenance nor for the required-env gate (threading site 6).
  const r = runCli(['--superpowers-root', dir], { SUPERPOWERS_ROOT: '' });
  expect(r.status).toBe(0);
  const verdict = readSoleVerdict(r.outRoot);
  expect(verdict.provenance.superpowers_rev).toBe(sha);
  // Behavioral: the retained substituted launcher burns in the threaded path.
  const runDir = join(r.outRoot, readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))[0] ?? '');
  const launcher = readFileSync(join(runDir, 'gauntlet-agent', 'context', 'launch-agent'), 'utf8');
  expect(launcher).toContain(`--plugin-dir "${dir}"`);
});

test('--no-superpowers: provenance null, launcher elides plugin flags, no ambient demanded', () => {
  const r = runCli(['--no-superpowers'], { SUPERPOWERS_ROOT: '' });
  // SUPERPOWERS_ROOT='' in envExtra overrides the harness seed with an empty
  // value, proving none mode does not demand the ambient var (site 6).
  expect(r.status).toBe(0);
  const verdict = readSoleVerdict(r.outRoot);
  expect(verdict.provenance.superpowers_rev).toBeNull();
  const runDir = join(r.outRoot, readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))[0] ?? '');
  const launcher = readFileSync(join(runDir, 'gauntlet-agent', 'context', 'launch-agent'), 'utf8');
  expect(launcher).not.toContain('--plugin-dir');
});

test('QUORUM_SUPERPOWERS_REV under an explicit mode errors at run start', () => {
  const { dir } = tmpGitRepo();
  const r = runCli(['--superpowers-root', dir], {
    QUORUM_SUPERPOWERS_REV: 'deadbeef'.repeat(5),
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/QUORUM_SUPERPOWERS_REV/);
});

test('explicit mode with --os windows fails loud', () => {
  const { dir } = tmpGitRepo();
  const r = runCli(['--superpowers-root', dir, '--os', 'windows']);
  expect(r.status).not.toBe(0);
  expect(r.stderr + r.stdout).toMatch(/windows/i);
});

test('legacy: no flags, ambient set — byte-identical behavior', () => {
  const r = runCli([]);
  expect(r.status).toBe(0);
  const verdict = readSoleVerdict(r.outRoot);
  // Ambient seed is a non-git tmpdir → the legacy probe yields null.
  expect(verdict.provenance.superpowers_rev).toBeNull();
  const runDir = join(r.outRoot, readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))[0] ?? '');
  const launcher = readFileSync(join(runDir, 'gauntlet-agent', 'context', 'launch-agent'), 'utf8');
  expect(launcher).toContain('--plugin-dir "');
});

// Decision D-5's hostile test: a child spawned through a DIFFERENT checkout's
// entrypoint must execute that checkout's content, not the originating one —
// the instrument-snapshot mechanism rests on it. Uses a real git worktree of
// this repo at an older SHA (no quorum run; a repoRoot probe is enough).
test('D-5: a child executing another checkout reports THAT checkout as root', () => {
  const repo = resolve(import.meta.dir, '..');
  const wt = mkdtempSync(join(tmpdir(), 'reentry-'));
  const sha = spawnSync('git', ['rev-parse', 'HEAD~20'], { cwd: repo, encoding: 'utf8' })
    .stdout?.trim();
  expect(sha).toBeTruthy();
  const add = spawnSync('git', ['worktree', 'add', '--detach', wt, sha ?? ''], {
    cwd: repo,
    encoding: 'utf8',
  });
  try {
    expect(add.status).toBe(0);
    spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: wt, encoding: 'utf8' });
    const probe = spawnSync(
      'bun',
      ['-e', 'import { repoRoot } from "./src/paths.ts"; console.log(repoRoot());'],
      { cwd: wt, encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    // macOS tmpdir is a symlink (/var → /private/var) and repoRoot() may or may
    // not carry a trailing slash — compare realpath-normalized, slash-trimmed.
    const norm = (p: string) => realpathSync(p.replace(/\/+$/, ''));
    expect(norm(probe.stdout.trim())).toBe(norm(wt));
    expect(norm(probe.stdout.trim())).not.toBe(norm(repo));
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
    spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/cli-run-superpowers.test.ts`
Expected: FAIL — unknown options `--superpowers-root`/`--no-superpowers`.

- [ ] **Step 3: Implement**

1. `src/cli/run-command.ts` — `RunCommandOptions` gains:

```ts
  readonly superpowersRoot?: string;
  readonly noSuperpowers?: boolean;
```

In `executeRunCommand`, construct the spec where options map into `RunScenarioArgs`:

```ts
  // D2 threading: explicit superpowers mode from the CLI projection. Resolved
  // paths only — materialization/verification is the caller's (D3's) job.
  const superpowers: SuperpowersSpec | undefined =
    opts.superpowersRoot !== undefined
      ? { mode: 'root', root: resolve(opts.superpowersRoot) }
      : opts.noSuperpowers === true
        ? { mode: 'none' }
        : undefined;
  if (superpowers?.mode === 'root' && !existsSync(superpowers.root)) {
    throw new RunnerError(
      `--superpowers-root does not exist: ${superpowers.root}`,
      'setup',
    );
  }
```

and pass `superpowers` into the args. (Import `existsSync` from `node:fs`, `resolve` from `node:path`, `RunnerError` from the runner module if not already imported.)

2. `src/cli/index.ts` — the public `run` command gains:

```ts
  .option('--superpowers-root <path>', 'explicit superpowers root (D2; campaign children)')
  .option('--no-superpowers', 'run stock — suppress all superpowers staging (D2)')
```

Commander's `.conflicts` is available: `.option('--superpowers-root <path>', '...').conflicts('noSuperpowers')` — if the commander's version supports `.conflicts` on options use it; otherwise check manually in `executeRunCommand`:

```ts
  if (opts.superpowersRoot !== undefined && opts.noSuperpowers === true) {
    throw new RunnerError('--superpowers-root and --no-superpowers are mutually exclusive', 'setup');
  }
```

(Verify commander version in package.json and pick the mechanism that exists; the test asserts the behavior, not the mechanism.)

3. `src/cli/run-child.ts` — the internal parser gains the same two options (plus the manual/`.conflicts` exclusion — run-child's action calls `executeRunCommand`, so the manual check covers both parsers automatically if placed there).

4. `src/run-all/index.ts` — `buildChildRunArgs` gains an optional pass-through (additive; run-all itself never sets it — D3 will):

```ts
export function buildChildRunArgs(args: {
  // ... existing fields, verbatim ...
  readonly superpowersRoot?: string | undefined;
  readonly noSuperpowers?: boolean | undefined;
}): string[] {
  // ... existing argv construction, verbatim, then before return:
  //   if (args.superpowersRoot !== undefined) argv.push('--superpowers-root', args.superpowersRoot);
  //   if (args.noSuperpowers === true) argv.push('--no-superpowers');
}
```

(Read the existing `buildChildRunArgs` and add the two pushes in its construction order; do not reorder existing argv.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli-run-superpowers.test.ts test/cli-run.test.ts test/cli-run-all.test.ts test/run-all.test.ts`
Expected: PASS. Then `bun run check` and `bun run quorum check`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/run-child.ts src/cli/run-command.ts src/run-all/index.ts test/cli-run-superpowers.test.ts
git commit -m "feat(cli): D2 CLI projection — --superpowers-root / --no-superpowers in both parsers

Mutual exclusion, resolved-paths-only with existence check, passthrough
into RunScenarioArgs; run-all's child-argv builder gains the additive
pass-through D3 will use (run-all behavior unchanged by default)."
```

---

### Task 11: live claude smoke + registry flip + docs

**This is the trusted-maintainer task.** No hermetic TDD; the evidence is the smoke output. Operator prerequisites: `SUPERPOWERS_ROOT` exported (a real superpowers checkout) whose HEAD **differs** from the smoke SHA — the differing-HEAD precondition makes the readback non-vacuous.

**Files:**
- Modify: `src/agents/index.ts` (registry flip)
- Modify: `AGENTS.md` (architecture bullets for the new modules)
- Modify: `docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md` (status → implemented)

- [ ] **Step 1: Precondition check**

```bash
git -C "$SUPERPOWERS_ROOT" rev-parse HEAD
```

Pick a known superpowers tag SHA (e.g. `git -C "$SUPERPOWERS_ROOT" tag | tail -5`, pick one, `git -C "$SUPERPOWERS_ROOT" rev-parse <tag>`); the tag SHA must differ from the ambient HEAD printed above.

- [ ] **Step 2: Smoke run 1 — root mode**

```bash
SMOKE_SHA=$(git -C "$SUPERPOWERS_ROOT" rev-parse <chosen-tag>)
SMOKE_WT=$(mktemp -d)/sp-smoke
git -C "$SUPERPOWERS_ROOT" worktree add --detach "$SMOKE_WT" "$SMOKE_SHA"
bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude --superpowers-root "$SMOKE_WT"
```

Assertions (all must hold):

```bash
RUN_DIR=$(ls -dt results/00-quorum-smoke-hello-world-claude-* | head -1)
python3 - "$RUN_DIR" "$SMOKE_SHA" "$SMOKE_WT" <<'EOF'
import json, sys
run, sha, wt = sys.argv[1], sys.argv[2], sys.argv[3]
v = json.load(open(f"{run}/verdict.json"))
assert v["provenance"]["superpowers_rev"] == sha, v["provenance"]
launcher = open(f"{run}/gauntlet-agent/context/launch-agent").read()
assert f'--plugin-dir "{wt}"' in launcher, launcher[-500:]
print("root-mode smoke: PASS")
EOF
```

- [ ] **Step 3: Smoke run 2 — none mode**

```bash
bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude --no-superpowers
RUN_DIR=$(ls -dt results/00-quorum-smoke-hello-world-claude-* | head -1)
python3 - "$RUN_DIR" <<'EOF'
import json, sys
run = sys.argv[1]
v = json.load(open(f"{run}/verdict.json"))
assert v["provenance"]["superpowers_rev"] is None, v["provenance"]
launcher = open(f"{run}/gauntlet-agent/context/launch-agent").read()
assert "--plugin-dir" not in launcher, launcher[-500:]
print("none-mode smoke: PASS")
EOF
```

- [ ] **Step 4: Teardown** (never `rm -rf` a worktree — registrations live in the source checkout's `.git/worktrees`)

```bash
git -C "$SUPERPOWERS_ROOT" worktree remove --force "$SMOKE_WT"
git -C "$SUPERPOWERS_ROOT" worktree prune
```

- [ ] **Step 5: Flip the registry** in `src/agents/index.ts` with the evidence:

```ts
const SUPERPOWERS_CAPABILITY: Readonly<Record<string, SuperpowersCapability>> =
  {
    // Flipped by the D2 live smoke (2026-08-25): two-mode claude smoke passed
    // — root-mode provenance readback + burned-in launcher path; none-mode
    // null rev + elided plugin flags. Each further adapter's flip is a
    // platform PR carrying the same two-mode live smoke.
    claude: { ref: true, none: true },
  };
```

Then update the registry test (`test/agents-superpowers.test.ts`) to assert `superpowersCapability('claude')` is `{ ref: true, none: true }`.

- [ ] **Step 6: Docs sweep**

`AGENTS.md` — extend the `src/campaign/` architecture bullet: append `provisioning.ts` (superpowers worktree materializer) and `instrument-snapshot.ts` (evals+gauntlet snapshot + `verifySnapshot` drift guard + `gauntletBin` wrapper) to its module list, and add one clause to the `src/agents/` bullet for `superpowers.ts` (the tri-state `SuperpowersSpec` + `resolveSuperpowersRoot` + capability registry). Keep the edits to those two bullets.

Spec status line: `**Status:** proposed — revision 2 …` → `**Status:** implemented (main @ <merge SHA>)`.

- [ ] **Step 7: Verify + commit**

Run: `bun run check` and `bun run quorum check` — both green. Then:

```bash
git add src/agents/index.ts test/agents-superpowers.test.ts AGENTS.md docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md
git commit -m "feat(agents): flag claude superpowers capability after two-mode live smoke

Smoke evidence: root-mode provenance readback == materialized SHA with the
threaded plugin path burned into the retained launcher; none-mode null rev
with plugin flags elided. AGENTS.md architecture bullets updated; D2 spec
marked implemented."
```

---

## Final verification (after the last task)

- `bun run check` green (biome + tsc + full test suite)
- `bun run quorum check` green (scenario validation — the frontmatter/`requires_superpowers` scans from D1 must still pass; the launcher template migration does not touch scenario files)
- Exit criteria from the spec: hermetic matrix green, two-mode claude smoke passed under the differing-HEAD precondition, registry flags claude, D3 hand-off surface present (`materializeSuperpowersWorktree`, `materializeEvalsSnapshot`, `verifySnapshot`, `reconstructSnapshot`, `SnapshotHandle.gauntletBin`/`superpowersWorktrees`, `SuperpowersSpec` channel in both parsers, `gauntletBin` threading, default-deny registry).
