# Shared Eval Appliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 `evals-appliance` helper so agents can run shared Linux quorum evals on a trusted appliance with explicit repo sync, locks, job records, provenance, status, cancellation, and safe summary reads.

**Architecture:** Add a repo-owned TypeScript appliance helper under `src/appliance/` and install it through a tiny host wrapper at `/srv/quorum/bin/evals-appliance`. The helper reads host-local config, gates all checkout/container mutations behind `run.lock` then `sync.lock`, shells out to the existing `scripts/evals-container` and `quorum` surfaces, and writes file-backed job/provenance records under `/srv/quorum/state`. Detached runs spawn a host-side worker process that owns preflight, live command execution, signalable in-container process groups, and terminal job state.

**Tech Stack:** Bun/TypeScript, Commander, Zod, existing `CommandRunner` subprocess seam, existing `scripts/evals-container`, existing `quorum show`/`costs` renderers, Bash for the installed host wrapper.

**Spec:** `docs/superpowers/specs/2026-06-18-shared-eval-appliance-design.md`

## Global Constraints

- Phase 1 implements the shared eval appliance only; the Phase 2 SQLite supervisor is a separate plan.
- Bun is `>=1.3`.
- Phase 1 uses exactly one credential bundle named `blessed`.
- Phase 1 shared `run-all` is Linux-container-only.
- Antigravity is not supported on the appliance until a live container auth smoke proves `agy`.
- Windows `run-all` is not supported on the appliance in Phase 1.
- `doctor`, `status`, `show`, and `costs` are read-only and must not source the blessed credential env.
- All mutating commands acquire locks in this order: `run.lock` first, then `sync.lock`.
- Live `run`/`run-all` hold `run.lock` until terminal job state.
- `prepare` holds `run.lock` only for its preflight window.
- `quorum run` and `quorum run-all` must not learn implicit git-sync or credential behavior.
- Raw `results/`, job records, provenance, and run homes are sensitive; helper-created files use mode `0600` or directories mode `0700`.
- No public CI live evals, no untrusted PR/scenario execution, no dashboard launch/stop UI.

---

## File Structure

Create:

- `src/appliance/types.ts` - Zod schemas and TypeScript types for config, locks, jobs, provenance, command requests, and JSON responses.
- `src/appliance/errors.ts` - stable `ApplianceErrorCode`, `ApplianceError`, and JSON error serialization.
- `src/appliance/fs.ts` - `mkdirPrivate`, `atomicWriteJson`, `readJsonFile`, `writePrivateText`, and timestamp/id helpers.
- `src/appliance/config.ts` - load `/srv/quorum/config/appliance.json` or `EVALS_APPLIANCE_CONFIG`, validate host paths, read bundle metadata.
- `src/appliance/locks.ts` - `run.lock`/`sync.lock` acquisition, release, stale inspection, and lock-free read inspection.
- `src/appliance/git.ts` - clean-worktree checks, fetch, configured fast-forward, exact Superpowers ref resolution, detached checkout.
- `src/appliance/container.ts` - calls to `scripts/evals-container build/up/status/exec`, mount-signature calculation, tool-version and `quorum check` preflight.
- `src/appliance/jobs.ts` - file-backed job creation, atomic updates, terminal-state helpers, log path allocation.
- `src/appliance/provenance.ts` - job-scoped provenance creation and artifact-side copy/link.
- `src/appliance/preflight.ts` - lock-aware prepare/live preflight orchestration.
- `src/appliance/summary.ts` - status/show/costs payloads over job records, batch artifacts, and existing quorum renderers.
- `src/appliance/process.ts` - detached worker spawn, in-container process-group launch, cancellation, and process probing.
- `src/appliance/cli.ts` - Commander CLI for `doctor`, `prepare`, `run`, `run-all`, `status`, `cancel`, `show`, and `costs`.
- `scripts/install-evals-appliance` - host install script that writes `/srv/quorum/bin/evals-appliance` outside the mutable repo.
- `test/appliance-contracts.test.ts`
- `test/appliance-locks.test.ts`
- `test/appliance-git.test.ts`
- `test/appliance-preflight.test.ts`
- `test/appliance-jobs.test.ts`
- `test/appliance-summary.test.ts`
- `test/appliance-process.test.ts`
- `test/appliance-cli.test.ts`

Modify:

- `package.json` - add an `appliance` script and optional `bin` entry for local `evals-appliance` invocation.
- `docs/appliance-runbook.md` - align examples with final CLI behavior and add install/bootstrap notes.
- `README.md` - keep the existing shared-appliance section aligned with the final command names.
- `docs/coding-agent-care-and-feeding.md` - align appliance examples if the CLI parser requires changes.

Do not modify:

- `src/runner/`, `src/run-all/`, or the dashboard package unless a test proves a missing public read helper is required.
- `scripts/evals-container` except for a narrow process-control affordance proven by Task 6. Prefer driving it through `exec bash -lc ...`.

## Interfaces

These names are shared across tasks. Keep them stable once introduced.

```ts
// src/appliance/types.ts
export type ApplianceCommandKind = 'prepare' | 'run' | 'run-all';
export type JobStatus =
  | 'preflighting'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'lost'
  | 'quarantined';

export interface ApplianceConfig {
  readonly root: string;
  readonly evals: { readonly path: string; readonly remote: string; readonly ref: string };
  readonly superpowers: { readonly path: string; readonly remote: string };
  readonly gauntlet: { readonly path: string; readonly remote: string; readonly ref: string };
  readonly credential_bundle: { readonly name: 'blessed'; readonly path: string };
  readonly container: { readonly name: string; readonly results_root: string };
}

export interface RefSnapshot {
  readonly superpowers_requested_ref: string;
  readonly superpowers_resolved_sha: string;
  readonly evals_ref: string;
  readonly evals_resolved_sha: string;
  readonly gauntlet_ref: string;
  readonly gauntlet_built_sha: string;
}

export interface PreflightResult {
  readonly refs: RefSnapshot;
  readonly credential_bundle: { readonly name: 'blessed'; readonly bundle_id: string };
  readonly container: {
    readonly name: string;
    readonly id: string | null;
    readonly image_id: string | null;
    readonly mount_signature: string;
  };
  readonly provenance_path: string;
  readonly tool_versions_path: string;
}
```

```ts
// src/appliance/errors.ts
export type ApplianceErrorCode =
  | 'config_invalid'
  | 'lock_busy'
  | 'repo_dirty'
  | 'fetch_failed'
  | 'ref_ambiguous'
  | 'ref_not_found'
  | 'checkout_failed'
  | 'image_build_failed'
  | 'container_recreate_required'
  | 'container_unhealthy'
  | 'tool_versions_failed'
  | 'quorum_check_failed'
  | 'unsupported_os'
  | 'job_not_found'
  | 'job_not_running'
  | 'cancel_failed'
  | 'artifact_missing';
```

---

### Task 1: Contracts, Config, and JSON Error Surface

**Files:**

- Create: `src/appliance/types.ts`
- Create: `src/appliance/errors.ts`
- Create: `src/appliance/fs.ts`
- Create: `src/appliance/config.ts`
- Test: `test/appliance-contracts.test.ts`

**Interfaces:**

- Produces: `ApplianceConfig`, `JobRecord`, `LockRecord`, `ProvenanceRecord`, `loadConfig(configPath?: string): LoadedApplianceConfig`, `toErrorJson(err: unknown): ErrorJson`, `atomicWriteJson(path, value): void`.
- Consumes: existing `zod`, `node:fs`, `node:path`.

- [ ] **Step 1: Write failing config and error tests**

Create `test/appliance-contracts.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/appliance/config.ts';
import { ApplianceError, toErrorJson } from '../src/appliance/errors.ts';
import { atomicWriteJson } from '../src/appliance/fs.ts';

function fixture(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'appliance-config-'));
  for (const dir of [
    'superpowers-evals',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(
    join(root, 'credentials/blessed/metadata.json'),
    JSON.stringify({
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['anthropic', 'openai'],
      note: 'test bundle',
    }),
  );
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: { path: join(root, 'superpowers-evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'superpowers-evals/results') },
    }),
  );
  return { root, configPath };
}

describe('appliance config', () => {
  test('loads host config and bundle metadata', () => {
    const { root, configPath } = fixture();
    const loaded = loadConfig(configPath);
    expect(loaded.config.root).toBe(root);
    expect(loaded.bundle.bundle_id).toBe('blessed-2026-06-18-a');
    expect(loaded.paths.jobs).toBe(join(root, 'state/jobs'));
    expect(loaded.paths.locks).toBe(join(root, 'state/locks'));
    expect(loaded.paths.provenance).toBe(join(root, 'state/provenance'));
  });

  test('rejects a credential bundle name other than blessed', () => {
    const { configPath } = fixture();
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    raw.credential_bundle.name = 'personal';
    writeFileSync(configPath, JSON.stringify(raw));
    expect(() => loadConfig(configPath)).toThrow(/blessed/);
  });
});

describe('appliance error json', () => {
  test('serializes stable machine-readable failures', () => {
    const err = new ApplianceError('lock_busy', 'preflight', 'run.lock is held');
    expect(toErrorJson(err)).toEqual({
      ok: false,
      error: {
        code: 'lock_busy',
        step: 'preflight',
        message: 'run.lock is held',
      },
    });
  });
});

describe('atomicWriteJson', () => {
  test('writes parseable json without leaving temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appliance-json-'));
    const path = join(dir, 'record.json');
    atomicWriteJson(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
bun test test/appliance-contracts.test.ts
```

Expected: fail with module-not-found errors for `src/appliance/config.ts`, `errors.ts`, and `fs.ts`.

- [ ] **Step 3: Add contracts and config loader**

Implement `src/appliance/types.ts` with Zod schemas matching the spec. Use `z.literal('blessed')` for `credential_bundle.name`. Define `LoadedApplianceConfig` as:

```ts
export interface LoadedApplianceConfig {
  readonly config: ApplianceConfig;
  readonly bundle: CredentialBundleMetadata;
  readonly configPath: string;
  readonly paths: {
    readonly jobs: string;
    readonly locks: string;
    readonly provenance: string;
  };
}
```

Implement `src/appliance/errors.ts`:

```ts
export class ApplianceError extends Error {
  constructor(
    readonly code: ApplianceErrorCode,
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApplianceError';
  }
}

export function toErrorJson(err: unknown): ErrorJson {
  if (err instanceof ApplianceError) {
    return {
      ok: false,
      error: { code: err.code, step: err.step, message: err.message },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: { code: 'config_invalid', step: 'unknown', message },
  };
}
```

Implement `src/appliance/fs.ts`:

```ts
export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirPrivate(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
```

Implement `src/appliance/config.ts` so `loadConfig()`:

- defaults to `process.env.EVALS_APPLIANCE_CONFIG ?? '/srv/quorum/config/appliance.json'`;
- parses config and `credentials/blessed/metadata.json`;
- creates `state/jobs`, `state/locks`, and `state/provenance` with `0700`;
- verifies configured repo and bundle paths exist;
- throws `new ApplianceError('config_invalid', 'config', message)` on parse/path failures.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun test test/appliance-contracts.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/appliance/types.ts src/appliance/errors.ts src/appliance/fs.ts src/appliance/config.ts test/appliance-contracts.test.ts
git commit -m "appliance: add config and contract types"
```

---

### Task 2: Locking and File-Backed Job Records

**Files:**

- Create: `src/appliance/locks.ts`
- Create: `src/appliance/jobs.ts`
- Test: `test/appliance-locks.test.ts`
- Test: `test/appliance-jobs.test.ts`

**Interfaces:**

- Consumes: `LoadedApplianceConfig`, `atomicWriteJson`, `ApplianceError`.
- Produces:
  - `acquireLock(args: AcquireLockArgs): LockHandle`
  - `inspectLock(path: string): LockInspection`
  - `withMutationLocks<T>(loaded, jobId, command, fn): Promise<T>`
  - `createJob(loaded, request): JobRecord`
  - `updateJob(loaded, jobId, patcher): JobRecord`
  - `readJob(loaded, jobOrArtifactId): JobRecord`

- [ ] **Step 1: Write failing lock-order and busy-lock tests**

Create `test/appliance-locks.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { acquireLock, inspectLock, withMutationLocks } from '../src/appliance/locks.ts';

function loaded(root = mkdtempSync(join(tmpdir(), 'appliance-locks-'))): LoadedApplianceConfig {
  mkdirSync(join(root, 'state/locks'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'evals/results') },
    },
    bundle: {
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

describe('appliance locks', () => {
  test('withMutationLocks acquires run.lock before sync.lock and releases both', async () => {
    const cfg = loaded();
    const seen: string[] = [];
    await withMutationLocks(cfg, 'job-1', 'prepare', async () => {
      seen.push(JSON.parse(readFileSync(join(cfg.paths.locks, 'run.lock/lock.json'), 'utf8')).name);
      seen.push(JSON.parse(readFileSync(join(cfg.paths.locks, 'sync.lock/lock.json'), 'utf8')).name);
    });
    expect(seen).toEqual(['run.lock', 'sync.lock']);
    expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
    expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
  });

  test('existing run.lock fails before sync.lock is created', async () => {
    const cfg = loaded();
    acquireLock({ loaded: cfg, name: 'run.lock', jobId: 'other', command: 'run-all' });
    await expect(
      withMutationLocks(cfg, 'job-2', 'prepare', async () => undefined),
    ).rejects.toThrow(/run.lock/);
    expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
  });

  test('inspectLock reports stale when pid is not alive', () => {
    const cfg = loaded();
    const lockDir = join(cfg.paths.locks, 'run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock.json'),
      JSON.stringify({
        name: 'run.lock',
        job_id: 'job-dead',
        host: 'test-host',
        pid: 99999999,
        pgid: 99999999,
        started_at: '2026-06-18T00:00:00.000Z',
        command: 'run-all',
        refs: null,
      }),
    );
    expect(inspectLock(join(cfg.paths.locks, 'run.lock')).state).toBe('stale');
  });
});
```

- [ ] **Step 2: Write failing job-record tests**

Create `test/appliance-jobs.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-jobs-'));
  mkdirSync(join(root, 'state/jobs'), { recursive: true });
  mkdirSync(join(root, 'state/locks'), { recursive: true });
  mkdirSync(join(root, 'state/provenance'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'evals/results') },
    },
    bundle: {
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

test('createJob writes a preflighting job with private log paths', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'feature/ref',
    argv: ['quorum', 'run-all', '--tier', 'sentinel'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  expect(job.job_id).toMatch(/^job-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  expect(job.status).toBe('preflighting');
  expect(job.artifacts.stdout_log).toEndWith('/stdout.log');
  expect(readJob(cfg, job.job_id).command.argv).toEqual(['quorum', 'run-all', '--tier', 'sentinel']);
});

test('updateJob applies atomic patches and preserves immutable ids', () => {
  const cfg = loaded();
  const job = createJob(cfg, {
    kind: 'prepare',
    superpowersRef: 'main',
    argv: ['prepare'],
    requester: { agent: null, thread: null, task: null },
  });
  const updated = updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'done',
    finished_at: '2026-06-18T01:00:00.000Z',
    result: { exit_code: 0, summary: 'preflight ok' },
  }));
  expect(updated.job_id).toBe(job.job_id);
  expect(readJob(cfg, job.job_id).status).toBe('done');
});
```

- [ ] **Step 3: Run the failing tests**

Run:

```bash
bun test test/appliance-locks.test.ts test/appliance-jobs.test.ts
```

Expected: fail with module-not-found errors for `locks.ts` and `jobs.ts`.

- [ ] **Step 4: Implement locks**

Implement `src/appliance/locks.ts` with directory locks:

- lock path is `<loaded.paths.locks>/<name>`;
- acquire by `mkdirSync(lockDir, { mode: 0o700 })`;
- write `lock.json` with mode `0600`;
- release removes only the directory owned by the handle's `jobId`;
- existing lock throws `new ApplianceError('lock_busy', 'lock', '<name> is held by <job>')`;
- `inspectLock` returns `{ state: 'missing' | 'active' | 'stale', record }`;
- stale detection uses `process.kill(pid, 0)` and treats `ESRCH` as stale.

The core helper must keep this shape:

```ts
export async function withMutationLocks<T>(
  loaded: LoadedApplianceConfig,
  jobId: string,
  command: ApplianceCommandKind,
  fn: () => Promise<T>,
): Promise<T> {
  const run = acquireLock({ loaded, name: 'run.lock', jobId, command });
  let sync: LockHandle | null = null;
  try {
    sync = acquireLock({ loaded, name: 'sync.lock', jobId, command });
    return await fn();
  } finally {
    sync?.release();
    run.release();
  }
}
```

Task 4 changes live launch to release only `sync.lock` while keeping `run.lock`; keep this generic helper for `prepare` and unit tests.

- [ ] **Step 5: Implement jobs**

Implement `src/appliance/jobs.ts` so every job lives at `<jobs>/<job-id>/job.json`, with sibling `stdout.log` and `stderr.log`. `createJob` initializes:

```ts
{
  schema_version: 1,
  status: 'preflighting',
  started_at: null,
  finished_at: null,
  refs: null,
  credential_bundle: null,
  container: null,
  process: null,
  artifacts: {
    run_id: null,
    batch_id: null,
    stdout_log,
    stderr_log,
    provenance: join(loaded.paths.provenance, `${jobId}.json`),
  },
  progress: null,
  result: { exit_code: null, summary: null },
  error: null,
}
```

Use `atomicWriteJson` for every write.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
bun test test/appliance-locks.test.ts test/appliance-jobs.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/appliance/locks.ts src/appliance/jobs.ts test/appliance-locks.test.ts test/appliance-jobs.test.ts
git commit -m "appliance: add locks and job records"
```

---

### Task 3: Git Sync and Exact Ref Resolution

**Files:**

- Create: `src/appliance/git.ts`
- Test: `test/appliance-git.test.ts`

**Interfaces:**

- Consumes: `CommandRunner`, `LoadedApplianceConfig`, `ApplianceError`.
- Produces:
  - `ensureCleanWorktree(path: string, runner: CommandRunner): void`
  - `fetchRepo(path: string, remote: string, runner: CommandRunner): void`
  - `fastForwardManagedRepo(repo, runner): string`
  - `resolveSuperpowersRef(config, requestedRef, runner): string`
  - `checkoutDetached(repoPath, sha, runner): void`

- [ ] **Step 1: Write failing git tests**

Create `test/appliance-git.test.ts` using real temporary git repos:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpawnCommandRunner } from '../src/agents/command-runner.ts';
import {
  ensureCleanWorktree,
  fastForwardManagedRepo,
  resolveSuperpowersRef,
} from '../src/appliance/git.ts';

const runner = new SpawnCommandRunner();

function git(cwd: string, args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (proc.status !== 0) throw new Error(proc.stderr);
  return proc.stdout.trim();
}

function repo(): { root: string; bare: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'appliance-git-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, ['init', '--bare', bare]);
  git(root, ['clone', bare, work]);
  git(work, ['config', 'user.email', 'drill@test.local']);
  git(work, ['config', 'user.name', 'Drill Test']);
  writeFileSync(join(work, 'README.md'), 'one\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-m', 'initial']);
  git(work, ['push', 'origin', 'HEAD:main']);
  git(work, ['checkout', '-B', 'main', 'origin/main']);
  return { root, bare, work };
}

describe('appliance git helpers', () => {
  test('ensureCleanWorktree rejects dirty files', () => {
    const { work } = repo();
    writeFileSync(join(work, 'dirty.txt'), 'dirty\n');
    expect(() => ensureCleanWorktree(work, runner)).toThrow(/dirty/);
  });

  test('fastForwardManagedRepo moves configured branch by ff-only', () => {
    const { bare, work } = repo();
    const other = join(mkdtempSync(join(tmpdir(), 'appliance-git-other-')), 'other');
    git(join(other, '..'), ['clone', bare, other]);
    git(other, ['config', 'user.email', 'drill@test.local']);
    git(other, ['config', 'user.name', 'Drill Test']);
    git(other, ['checkout', '-B', 'main', 'origin/main']);
    writeFileSync(join(other, 'README.md'), 'two\n');
    git(other, ['commit', '-am', 'second']);
    git(other, ['push', 'origin', 'HEAD:main']);

    const sha = fastForwardManagedRepo(
      { path: work, remote: 'origin', ref: 'main', label: 'evals' },
      runner,
    );
    expect(sha).toBe(git(work, ['rev-parse', 'HEAD']));
    expect(git(work, ['status', '--porcelain'])).toBe('');
  });

  test('resolveSuperpowersRef fails closed on branch tag ambiguity', () => {
    const { work } = repo();
    git(work, ['tag', 'same']);
    git(work, ['push', 'origin', 'same']);
    git(work, ['checkout', '-B', 'same']);
    git(work, ['push', 'origin', 'same']);
    expect(() =>
      resolveSuperpowersRef({ path: work, remote: 'origin' }, 'same', runner),
    ).toThrow(/ambiguous/);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
bun test test/appliance-git.test.ts
```

Expected: fail with module-not-found for `src/appliance/git.ts`.

- [ ] **Step 3: Implement git helpers**

Use `CommandRunner.run('git', ['-C', repoPath, ...])` for all operations. Implement these exact commands:

- clean: `git -C <path> status --porcelain`, fail if stdout is non-empty;
- fetch: `git -C <path> fetch --prune --tags <remote>`;
- managed ff: `git -C <path> checkout <ref>`, then `git -C <path> merge --ff-only <remote>/<ref>`, then `git -C <path> rev-parse HEAD`;
- branch candidate: `git -C <path> rev-parse --verify refs/remotes/<remote>/<ref>`;
- tag candidate: `git -C <path> rev-parse --verify refs/tags/<ref>`;
- SHA candidate: accept only a full 40-character hex string that `git -C <path> cat-file -e <sha>^{commit}` accepts;
- ambiguity: if more than one branch/tag/SHA candidate exists, throw `ref_ambiguous`;
- missing: if no candidate exists, throw `ref_not_found`;
- checkout: `git -C <path> checkout --detach <sha>`, then verify `git -C <path> rev-parse HEAD` equals the SHA.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun test test/appliance-git.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/appliance/git.ts test/appliance-git.test.ts
git commit -m "appliance: add git ref preflight"
```

---

### Task 4: Container Preflight and Provenance

**Files:**

- Create: `src/appliance/container.ts`
- Create: `src/appliance/provenance.ts`
- Create: `src/appliance/preflight.ts`
- Test: `test/appliance-preflight.test.ts`

**Interfaces:**

- Consumes: config, locks, jobs, git helpers, existing `CommandRunner`.
- Produces:
  - `preflightForJob(args: PreflightArgs): Promise<PreflightResult>`
  - `prepare(args: PrepareArgs): Promise<PreflightResult>`
  - `writeProvenance(loaded, job, result, command): string`
  - `containerMountSignature(loaded): string`

- [ ] **Step 1: Write failing preflight orchestration tests**

Create `test/appliance-preflight.test.ts` with a fake runner:

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { createJob, readJob } from '../src/appliance/jobs.ts';
import { preflightForJob } from '../src/appliance/preflight.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: readonly string[]; options?: CommandOptions }[] = [];
  run(command: string, args: readonly string[], options?: CommandOptions): CommandResult {
    this.calls.push({ command, args, options });
    if (command === 'git' && args.includes('status')) return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
    if (command === 'git' && args.includes('cat-file')) return { status: 0, stdout: '', stderr: '' };
    if (command.endsWith('scripts/evals-container') && args.includes('status')) {
      return { status: 0, stdout: 'quorum-appliance: exists, running\n', stderr: '' };
    }
    if (command.endsWith('scripts/evals-container') && args.includes('exec') && args.includes('evals-tool-versions')) {
      return { status: 0, stdout: 'bun 1.3.13\n', stderr: '' };
    }
    if (command.endsWith('scripts/evals-container') && args.includes('exec') && args.includes('quorum')) {
      return { status: 0, stdout: 'ok\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-preflight-'));
  for (const dir of [
    'superpowers-evals/scripts',
    'superpowers-evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed/codex',
    'state/jobs',
    'state/locks',
    'state/provenance',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'superpowers-evals/scripts/evals-container'), '#!/usr/bin/env bash\n');
  return {
    configPath: join(root, 'config/appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'superpowers-evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'superpowers-evals/results') },
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

test('preflight shells through evals-container with blessed credentials and records provenance', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'prepare',
    superpowersRef: 'main',
    argv: ['prepare'],
    requester: { agent: 'codex', thread: null, task: null },
  });

  const result = await preflightForJob({ loaded: cfg, jobId: job.job_id, superpowersRef: 'main', runner });

  const evalsContainerCalls = runner.calls.filter((c) => c.command.endsWith('scripts/evals-container'));
  expect(evalsContainerCalls.some((c) => c.args.includes('--env-file'))).toBe(true);
  expect(evalsContainerCalls.some((c) => c.args.includes('--auth'))).toBe(true);
  expect(evalsContainerCalls.some((c) => c.args.includes('evals-tool-versions'))).toBe(true);
  expect(evalsContainerCalls.some((c) => c.args.includes('quorum') && c.args.includes('check'))).toBe(true);
  expect(result.credential_bundle.bundle_id).toBe('blessed-2026-06-18-a');
  expect(readJob(cfg, job.job_id).refs?.superpowers_resolved_sha).toBe('a'.repeat(40));
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
bun test test/appliance-preflight.test.ts
```

Expected: fail with module-not-found for `preflight.ts`.

- [ ] **Step 3: Implement container and provenance helpers**

`src/appliance/container.ts` must construct all wrapper calls from the loaded config:

```ts
export function evalsContainerPath(loaded: LoadedApplianceConfig): string {
  return join(loaded.config.evals.path, 'scripts/evals-container');
}

export function baseContainerArgs(loaded: LoadedApplianceConfig): string[] {
  const bundle = loaded.config.credential_bundle.path;
  const args = [
    '--name', loaded.config.container.name,
    '--superpowers-root', loaded.config.superpowers.path,
    '--env-file', join(bundle, 'credentials.env'),
  ];
  for (const [name, dir] of [
    ['codex', 'codex'],
    ['gemini', 'gemini'],
    ['kimi', 'kimi-code'],
    ['pi', 'pi'],
  ] as const) {
    const path = join(bundle, dir);
    if (existsSync(path)) args.push('--auth', `${name}=${path}`);
  }
  return args;
}
```

Build uses `--gauntlet-root <gauntlet> build`. Up uses `baseContainerArgs(...), 'up'`. Exec uses `baseContainerArgs(...), 'exec', ...command`.

`containerMountSignature` hashes this JSON with SHA-256:

```ts
{
  evals: loaded.config.evals.path,
  superpowers: loaded.config.superpowers.path,
  results_root: loaded.config.container.results_root,
  bundle: loaded.config.credential_bundle.path,
  auth_dirs: discoveredAuthDirs,
}
```

`src/appliance/provenance.ts` writes `state/provenance/<job-id>.json` with the spec fields and copies the same JSON to `results/batches/<batch-id>/appliance-provenance.json` or `results/<run-id>/appliance-provenance.json` once the artifact id is known.

- [ ] **Step 4: Implement preflight**

`preflightForJob` must:

1. update job status to `preflighting`;
2. clean-check all three repos;
3. fetch all three repos;
4. fast-forward evals and gauntlet;
5. resolve and detached-checkout Superpowers;
6. call container build/up/status;
7. run `evals-tool-versions` and write stdout to `<job-dir>/evals-tool-versions.txt`;
8. run `quorum check`;
9. write provenance;
10. patch job with refs, credential bundle, container, and provenance path.

Do not acquire locks inside `preflightForJob`; callers own lock order.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
bun test test/appliance-preflight.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/appliance/container.ts src/appliance/provenance.ts src/appliance/preflight.ts test/appliance-preflight.test.ts
git commit -m "appliance: add container preflight and provenance"
```

---

### Task 5: Read-Only Status, Show, and Costs

**Files:**

- Create: `src/appliance/summary.ts`
- Test: `test/appliance-summary.test.ts`

**Interfaces:**

- Consumes: `readJob`, existing `resolveTarget`, `renderBatch`, `batchJson`, `loadCostRows`, `renderCosts`, `costsJson`.
- Produces:
  - `statusPayload(loaded, id): StatusPayload`
  - `showPayload(loaded, id, json: boolean): string | unknown`
  - `costsPayload(loaded, id, json: boolean): string | unknown`

- [ ] **Step 1: Write failing summary tests**

Create `test/appliance-summary.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { createJob, updateJob } from '../src/appliance/jobs.ts';
import { costsPayload, showPayload, statusPayload } from '../src/appliance/summary.ts';

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-summary-'));
  for (const dir of ['state/jobs', 'state/locks', 'state/provenance', 'superpowers-evals/results/batches/batch-1', 'superpowers-evals/results/run-1']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'superpowers-evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'superpowers-evals/results') },
    },
    bundle: { bundle_id: 'blessed-x', rotated_at: '2026-06-18T00:00:00Z', providers: [], note: '' },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

test('status derives a completed batch summary from artifacts', () => {
  const cfg = loaded();
  const batchDir = join(cfg.config.container.results_root, 'batches/batch-1');
  writeFileSync(join(batchDir, 'batch.json'), JSON.stringify({
    id: 'batch-1',
    started_at: '2026-06-18T00:00:00Z',
    finished_at: '2026-06-18T00:10:00Z',
    coding_agents: ['codex'],
  }));
  writeFileSync(join(batchDir, 'results.jsonl'), JSON.stringify({
    scenario: 'alpha',
    coding_agent: 'codex',
    run_id: 'run-1',
    skipped: null,
  }) + '\n');
  writeFileSync(join(cfg.config.container.results_root, 'run-1/verdict.json'), JSON.stringify({
    schema: 1,
    final: 'fail',
    final_reason: 'deterministic check failed',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
  }));
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: 'codex', thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'done',
    artifacts: { ...current.artifacts, batch_id: 'batch-1' },
  }));

  const status = statusPayload(cfg, job.job_id);
  expect(status.status).toBe('done');
  expect(status.summary).toEqual({ pass: 0, fail: 1, indeterminate: 0, unknown: 0, skipped: 0 });
  expect(status.appliance_failed).toBe(false);
});

test('show and costs do not require credential env', () => {
  const cfg = loaded();
  const batchDir = join(cfg.config.container.results_root, 'batches/batch-1');
  writeFileSync(join(batchDir, 'batch.json'), JSON.stringify({
    id: 'batch-1',
    started_at: '2026-06-18T00:00:00Z',
    finished_at: null,
    coding_agents: ['codex'],
  }));
  writeFileSync(join(batchDir, 'results.jsonl'), '');
  expect(showPayload(cfg, 'batch-1', false)).toContain('batch batch-1');
  expect(costsPayload(cfg, 'batch-1', true)).toHaveProperty('aggregate');
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
bun test test/appliance-summary.test.ts
```

Expected: fail with module-not-found for `summary.ts`.

- [ ] **Step 3: Implement summary reads**

Implement `resolveJobArtifact(loaded, id)`:

- if `id` is a job id, read job and prefer `batch_id`, then `run_id`;
- if `id` starts with `batch-`, resolve to `<results_root>/batches/<id>`;
- otherwise resolve through existing `resolveTarget(id, results_root)`.

For `statusPayload`:

- read job status when id is a job;
- derive batch counts by reading `batch.json`, `results.jsonl`, and each `verdict.json`;
- report completed batches with failing cells as `status: 'done'` and `appliance_failed: false`;
- report missing artifact as `artifact_missing`.

For `showPayload`:

- batch JSON uses existing `batchJson`;
- batch text uses existing `renderBatch({ batchDir, resultsRoot, color: false })`;
- run JSON reads the raw `verdict.json`;
- run text uses existing `renderVerdict` from `src/cli/render.ts`; export a small helper there only if needed.

For `costsPayload`:

- use `loadCostRows` and `costsJson` for JSON;
- use `renderCosts` for text.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun test test/appliance-summary.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/appliance/summary.ts test/appliance-summary.test.ts src/cli/render.ts
git commit -m "appliance: add read-only summary commands"
```

If `src/cli/render.ts` was not modified, omit it from `git add`.

---

### Task 6: Detached Worker, Process Groups, and Cancel

**Files:**

- Create: `src/appliance/process.ts`
- Test: `test/appliance-process.test.ts`

**Interfaces:**

- Consumes: `preflightForJob`, job store, container helpers, `CommandRunner`.
- Produces:
  - `spawnDetachedWorker(loaded, jobId): void`
  - `runWorker(loaded, jobId, runner): Promise<void>`
  - `launchLiveCommand(args): Promise<LiveCommandResult>`
  - `cancelJob(loaded, jobId, runner): Promise<JobRecord>`

- [ ] **Step 1: Write failing process-control tests**

Create `test/appliance-process.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { createJob, readJob, updateJob } from '../src/appliance/jobs.ts';
import { cancelJob, liveCommandArgs } from '../src/appliance/process.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: readonly string[]; options?: CommandOptions }[] = [];
  run(command: string, args: readonly string[], options?: CommandOptions): CommandResult {
    this.calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  }
}

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-process-'));
  for (const dir of ['superpowers-evals/scripts', 'superpowers-evals/results', 'state/jobs', 'state/locks', 'state/provenance']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'superpowers-evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'superpowers-evals/results') },
    },
    bundle: { bundle_id: 'blessed-x', rotated_at: '2026-06-18T00:00:00Z', providers: [], note: '' },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

test('liveCommandArgs launches quorum in a signalable in-container process group', () => {
  const cfg = loaded();
  const args = liveCommandArgs(cfg, 'job-1', ['quorum', 'run-all', '--tier', 'sentinel']);
  expect(args).toContain('exec');
  expect(args).toContain('bash');
  expect(args.join(' ')).toContain('setsid');
  expect(args.join(' ')).toContain('appliance-pids/job-1.pid');
  expect(args.join(' ')).toContain('quorum run-all --tier sentinel');
});

test('cancel sends SIGINT to the recorded in-container process group', async () => {
  const cfg = loaded();
  const runner = new FakeRunner();
  const job = createJob(cfg, {
    kind: 'run-all',
    superpowersRef: 'main',
    argv: ['quorum', 'run-all'],
    requester: { agent: null, thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (current) => ({
    ...current,
    status: 'running',
    process: { host_pid: 123, host_pgid: 123, container_pid: 456, container_pgid: 456 },
  }));
  await cancelJob(cfg, job.job_id, runner);
  expect(runner.calls.some((c) => c.args.join(' ').includes('kill -INT -456'))).toBe(true);
  expect(readJob(cfg, job.job_id).status).toBe('cancelled');
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
bun test test/appliance-process.test.ts
```

Expected: fail with module-not-found for `process.ts`.

- [ ] **Step 3: Implement process launch**

Implement `liveCommandArgs` to call:

```bash
scripts/evals-container ... exec bash -lc '
  set -euo pipefail
  mkdir -p /workspace/evals/results/.appliance-pids
  setsid bash -lc '"'"'
    echo "$$" > "/workspace/evals/results/.appliance-pids/<job-id>.pid"
    exec "$@"
  '"'"' appliance-live quorum run-all ...
'
```

After launch starts, poll the host-visible file `<results_root>/.appliance-pids/<job-id>.pid` for up to 10 seconds. Store that integer as both `container_pid` and `container_pgid`, because `setsid` makes the shell the process-group leader before `exec`.

Implement `runWorker`:

1. acquire `run.lock`;
2. acquire `sync.lock`;
3. call `preflightForJob`;
4. release `sync.lock`;
5. update job to `running`;
6. launch live command while still holding `run.lock`;
7. parse stdout for `batch <batch-id>` and `artifacts: results/batches/<batch-id>` or single-run artifact output;
8. update job `done` when exit code is 0 or when a batch artifact exists after graceful stop;
9. update job `failed` for appliance/preflight crashes;
10. run postflight dirty checks and mark `quarantined` if any managed checkout is dirty;
11. release `run.lock` only after terminal status is recorded.

Implement `cancelJob`:

- require job status `running` or `stopping`;
- set status `stopping`;
- run `scripts/evals-container ... exec bash -lc 'kill -INT -<container_pgid>'`;
- poll the job/batch artifact for up to the configured grace period, default 120 seconds;
- set `cancelled` when batch footer or stopped verdicts are visible;
- set `lost` if the process disappears without terminal artifacts.

- [ ] **Step 4: Run local process proof**

This is the first non-unit proof. It uses a harmless `sleep`, not a live eval:

```bash
scripts/evals-container up
mkdir -p results/.appliance-pids
scripts/evals-container exec bash -lc 'setsid bash -lc '"'"'echo "$$" > /workspace/evals/results/.appliance-pids/proof.pid; trap "exit 130" INT; sleep 120'"'"'' &
sleep 2
scripts/evals-container exec bash -lc 'kill -INT -$(cat /workspace/evals/results/.appliance-pids/proof.pid)'
wait
```

Expected: the background command exits after SIGINT; no live quorum run starts.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
bun test test/appliance-process.test.ts
```

Expected: all tests pass.

Commit:

```bash
git add src/appliance/process.ts test/appliance-process.test.ts
git commit -m "appliance: add detached worker and cancellation"
```

---

### Task 7: CLI Surface and Host Install Wrapper

**Files:**

- Create: `src/appliance/cli.ts`
- Create: `scripts/install-evals-appliance`
- Test: `test/appliance-cli.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: all previous appliance modules.
- Produces:
  - `createApplianceProgram(deps): Command`
  - local command `bun run appliance -- ...`
  - installed command `/srv/quorum/bin/evals-appliance`

- [ ] **Step 1: Write failing CLI tests**

Create `test/appliance-cli.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { createApplianceProgram } from '../src/appliance/cli.ts';

test('run-all keeps appliance flags before separator and passes quorum args verbatim', async () => {
  const calls: unknown[] = [];
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async (args) => {
        calls.push(args);
        return { ok: true, job_id: 'job-1', status: 'preflighting' };
      },
      status: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--detach',
    '--superpowers-ref',
    'feature/x',
    '--',
    '--tier',
    'sentinel',
    '--coding-agents',
    'codex,kimi',
  ]);
  expect(calls).toEqual([
    {
      json: true,
      detach: true,
      superpowersRef: 'feature/x',
      quorumArgs: ['--tier', 'sentinel', '--coding-agents', 'codex,kimi'],
    },
  ]);
  expect(stdout.join('\n')).toContain('job-1');
});

test('status accepts --json before the id', async () => {
  const ids: string[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async ({ id }) => {
        ids.push(id);
        return { ok: true };
      },
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });
  await program.parseAsync(['node', 'evals-appliance', 'status', '--json', 'job-1']);
  expect(ids).toEqual(['job-1']);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
bun test test/appliance-cli.test.ts
```

Expected: fail with module-not-found for `src/appliance/cli.ts`.

- [ ] **Step 3: Implement CLI**

Use Commander and keep the public surface exactly:

```text
doctor    [--json]
prepare   [--json] --superpowers-ref <ref>
run       [--json] [--detach] --superpowers-ref <ref> --scenario <name> --coding-agent <agent>
run-all   [--json] [--detach] --superpowers-ref <ref> -- <quorum run-all args...>
status    [--json] <job-id>
cancel    [--json] <job-id>
show      [--json] <job-id-or-artifact-id>
costs     [--json] <job-id-or-artifact-id>
```

Rules:

- `--json` belongs to `evals-appliance`, never to forwarded `quorum run-all`;
- `run-all` forwards all args after `--` unchanged;
- `run` constructs `['quorum', 'run', scenario, '--coding-agent', agent]`;
- detached `run`/`run-all` creates a job and spawns the worker;
- foreground `run`/`run-all` calls the same worker inline;
- JSON success responses include `ok: true`;
- JSON failures use `toErrorJson`.

Add to `package.json`:

```json
{
  "scripts": {
    "appliance": "bun run src/appliance/cli.ts"
  },
  "bin": {
    "quorum": "./src/cli/index.ts",
    "evals-appliance": "./src/appliance/cli.ts"
  }
}
```

- [ ] **Step 4: Implement host install script**

Create `scripts/install-evals-appliance`:

```bash
#!/usr/bin/env bash
set -euo pipefail

root="${1:-/srv/quorum}"
evals="$root/superpowers-evals"
bin_dir="$root/bin"
target="$bin_dir/evals-appliance"

mkdir -p "$bin_dir"
tmp="$target.$$"
cat > "$tmp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
config="${EVALS_APPLIANCE_CONFIG:-/srv/quorum/config/appliance.json}"
evals_path="$(jq -r '.evals.path' "$config")"
expected_ref="$(jq -r '.evals.ref' "$config")"

git -C "$evals_path" diff --quiet
git -C "$evals_path" diff --cached --quiet
current="$(git -C "$evals_path" rev-parse --abbrev-ref HEAD)"
if [[ "$current" != "$expected_ref" ]]; then
  printf 'evals-appliance: evals checkout on %s, expected %s\n' "$current" "$expected_ref" >&2
  exit 1
fi

cd "$evals_path"
exec bun run src/appliance/cli.ts "$@"
SH
chmod 0755 "$tmp"
mv "$tmp" "$target"
printf '%s\n' "$target"
```

Keep this installer idempotent. It writes only the wrapper, not `appliance.json` or credentials.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
bun test test/appliance-cli.test.ts
bash -n scripts/install-evals-appliance
```

Expected: tests pass; shell syntax check exits 0.

Commit:

```bash
git add src/appliance/cli.ts scripts/install-evals-appliance test/appliance-cli.test.ts package.json
git commit -m "appliance: add CLI and host wrapper"
```

---

### Task 8: Docs, Static Gates, and Appliance Smoke

**Files:**

- Modify: `docs/appliance-runbook.md`
- Modify: `README.md`
- Modify: `docs/coding-agent-care-and-feeding.md`

**Interfaces:**

- Consumes: final CLI from Task 7.
- Produces: operator-facing instructions matching implemented behavior.

- [ ] **Step 1: Update docs with exact installed-helper workflow**

Update the docs so all examples use:

```bash
evals-appliance doctor --json
evals-appliance prepare --json --superpowers-ref <branch-tag-or-sha>
evals-appliance run-all --json --detach \
  --superpowers-ref <branch-tag-or-sha> \
  -- --tier sentinel \
     --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
     --jobs 4
evals-appliance status --json <job-id>
evals-appliance show --json <job-id>
evals-appliance costs --json <job-id>
evals-appliance cancel --json <job-id>
```

State that `prepare` fails with `lock_busy` during active live jobs and that `doctor` is read-only.

- [ ] **Step 2: Run targeted test suite**

Run:

```bash
bun test \
  test/appliance-contracts.test.ts \
  test/appliance-locks.test.ts \
  test/appliance-jobs.test.ts \
  test/appliance-git.test.ts \
  test/appliance-preflight.test.ts \
  test/appliance-summary.test.ts \
  test/appliance-process.test.ts \
  test/appliance-cli.test.ts
```

Expected: all appliance tests pass.

- [ ] **Step 3: Run repo gates**

Run:

```bash
bun run check
bun run quorum check
```

Expected: both commands exit 0. If unrelated existing failures appear, record the exact failure and stop before claiming the appliance is ready.

- [ ] **Step 4: Run local non-live appliance smoke**

Use a temp config pointing at local throwaway repos and a fake credential bundle. Do not run live agents.

```bash
tmp="$(mktemp -d)"
mkdir -p "$tmp"/{superpowers-evals,superpowers,gauntlet,credentials/blessed,state}
cp -R . "$tmp/superpowers-evals"
git -C "$tmp/superpowers-evals" status --short
cat > "$tmp/credentials/blessed/metadata.json" <<'JSON'
{"bundle_id":"blessed-local-smoke","rotated_at":"2026-06-18T00:00:00Z","providers":[],"note":"local smoke"}
JSON
: > "$tmp/credentials/blessed/credentials.env"
cat > "$tmp/appliance.json" <<JSON
{
  "root": "$tmp",
  "evals": {"path": "$tmp/superpowers-evals", "remote": "origin", "ref": "main"},
  "superpowers": {"path": "$tmp/superpowers", "remote": "origin"},
  "gauntlet": {"path": "$tmp/gauntlet", "remote": "origin", "ref": "main"},
  "credential_bundle": {"name": "blessed", "path": "$tmp/credentials/blessed"},
  "container": {"name": "quorum-appliance-smoke", "results_root": "$tmp/superpowers-evals/results"}
}
JSON
EVALS_APPLIANCE_CONFIG="$tmp/appliance.json" bun run appliance -- doctor --json
```

Expected: `doctor --json` returns `ok: true` or a precise `config_invalid` pointing at missing git remotes in the throwaway fixture. If the smoke cannot create valid remotes cheaply, record that as a local-smoke limitation and rely on unit/static gates until the real appliance exists.

- [ ] **Step 5: Run trusted appliance sentinel smoke**

Only run this on the configured shared host with Drew's approval and the blessed credential bundle installed:

```bash
evals-appliance doctor --json
evals-appliance prepare --json --superpowers-ref main
evals-appliance run-all --json --detach \
  --superpowers-ref main \
  -- --tier sentinel \
     --coding-agents claude-haiku,codex \
     --jobs 2
evals-appliance status --json <job-id>
evals-appliance show --json <job-id>
evals-appliance costs --json <job-id>
```

Expected:

- `doctor` passes without sourcing credentials.
- `prepare` records exact evals, Superpowers, and Gauntlet SHAs.
- detached `run-all` returns a job id while `preflighting`.
- `status` recovers the job after a new shell session.
- `show` and `costs` work without raw transcript access.
- a completed batch with failing cells reports appliance status `done`, not `failed`.

- [ ] **Step 6: Commit docs and final verification notes**

Commit:

```bash
git add docs/appliance-runbook.md README.md docs/coding-agent-care-and-feeding.md
git commit -m "docs: update appliance helper workflow"
```

Then run:

```bash
git status --short
```

Expected: clean worktree except for deliberately untracked local smoke artifacts outside the repo.

---

## Self-Review Checklist

- [ ] Spec coverage: Phase 1 host config, blessed bundle, explicit repo sync, exact refs, locks, job records, provenance, detached recovery, cancellation, safe summary reads, docs, and verification are covered above.
- [ ] Out of scope: Phase 2 SQLite supervisor, named credential bundles, Antigravity appliance support, Windows `run-all`, public CI live evals, and dashboard launch/stop UI are not implemented by this plan.
- [ ] Placeholder scan: search this plan for the banned filler phrases from the writing-plans skill and fix any match before execution.
- [ ] Type consistency: `LoadedApplianceConfig`, `PreflightResult`, `JobRecord`, `ApplianceErrorCode`, and `withMutationLocks` names match across tasks.
- [ ] Verification: every task has a targeted test command and a commit command.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-18-shared-eval-appliance.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.
