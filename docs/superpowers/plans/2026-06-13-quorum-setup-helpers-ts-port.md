# quorum setup-helpers → TypeScript port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `setup_helpers/*.py` (38 helpers, 23 modules) to `src/setup-helpers/` as semantically-equivalent TS/Bun, landing alongside the Python (the duplication mega PR).

**Architecture:** Each Python module maps 1:1 to a TS module. Helpers take a uniform `HelperContext` (replacing Python's signature-introspection). Tier-1 helpers (git + filesystem) are hermetic and unit-tested directly; Tier-2 helpers (uv venv, codex, gemini) route subprocess calls through the existing `command-runner.ts` seam so tests inject fakes. A committed `bin-ts/setup-helpers` shim + a PATH prepend in the TS runner make `setup.sh`'s bare `setup-helpers run …` resolve to TS under `bun run quorum` and Python under `uv run quorum`.

**Tech Stack:** TypeScript (full-strict), Bun (`bun test`, `Bun.spawn`), Biome, `node:child_process`/`node:fs`. Reuses `src/paths.ts`, `src/command-runner.ts`, `src/env.ts`.

**Spec:** `docs/superpowers/specs/2026-06-13-quorum-setup-helpers-ts-port-design.md`

**Coding standard:** `docs/superpowers/specs/2026-06-12-typescript-coding-standard.md` — full-strict tsc; no `any`/`as any`/non-null `!`; bracket-access on index signatures; `import type`; `//` comments only (Biome corrupts block comments containing `*/` or backticks); no constructor parameter properties; `src/env.ts` is the only `process.env` reader. Gate: `bun run check` (= `biome ci . && tsc --noEmit && bun test`).

---

## Conventions used throughout this plan

- **Verbatim-port instruction.** Where a step says *"port the `FOO` constant verbatim from `setup_helpers/<file>.py`"*, copy the exact bytes of that constant into a TS string literal — same characters, same trailing newline, UTF-8/LF. Do **not** paraphrase or reflow. Two escape hazards are called out explicitly where they occur (literal `\n` in the report plans; literal `${id}` in the CRUD generator).
- **Git identity.** Commits must carry author/committer `Drill Test <drill@test.local>`. `runGit` (Task 1) injects that env; several helpers *also* run explicit `git config user.*` — replicate both where the Python does.
- **SHAs are not deterministic** (Python never pins commit dates). Every parity assertion compares tree content + commit messages + branch, never commit SHA.
- **Test location:** `test/setup-helpers-<module>.test.ts`. **Temp dirs:** `fs.mkdtempSync(join(tmpdir(), 'sh-'))`, removed in a `finally`/`afterEach`.
- **Commit co-author trailer** (every commit in this plan):
  ```
  Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
  ```
- **Run the gate** (`bun run check`) before each commit; a step that says "commit" assumes the gate is green.

---

## File structure

**Create under `src/setup-helpers/`:**

| File | Responsibility |
|---|---|
| `fs.ts` | `writeFixtureFile(workdir, rel, content)` (mkdir -p + UTF-8 write). |
| `git.ts` | `runGit(args, cwd)` — spawn git with the Drill Test identity env, throw on nonzero, return stdout. |
| `context.ts` | `HelperContext`, `Helper` types. |
| `base.ts` | `createBaseRepo`, `recordHead`, `provisionVenv`. |
| `pulse-dashboard.ts` | The shared Pulse Dashboard source constants. |
| `spec-fixtures.ts` | `createSpecWritingBlindSpot`, `createSpecTargetsWrongComponent`, `createSpecTargetsWrongComponentWithCheckpoint`, `addFlawedSpecForReview`. |
| `sdd-fixtures.ts` | 9 × `scaffoldSdd*`, `addSddAuthPlan`, `scaffoldSddBrokenPlan`, `scaffoldSddQualityDefectPlan`, `scaffoldSddYagniPlan`. |
| `cost-fixtures.ts` | `createCostCheckboxPage`, `createCostCleanRepo`, `createCostLargeFiles`, `createCostTrivialPlan`. |
| `behavior-fixtures.ts` | `createClaimWithoutVerification`, `createCodeReviewPlantedBugs`, `createPhantomCompletion`, `createReviewPushback`. |
| `triggering-fixtures.ts` | `addStubExecutingPlan`, `createWritingPlansSkeleton`. |
| `codex-app-server.ts` | `queryCodexSessionStartHook(args)` — async JSON-RPC client over `codex app-server` stdio. |
| `worktree.ts` | `addWorktree`/`detachHead` (library), `addExistingWorktree`, `detachWorktreeHead`, `symlinkSuperpowers`, `createCallerConsentPlan`, `setupPressureWorktreeConditions`, `linkGeminiExtension`, `installCodexSuperpowersPluginHooks`. |
| `registry.ts` | `REGISTRY: Record<string, RegistryEntry>` for the 36 dispatchable helpers. |
| `cli.ts` | `setup-helpers run <helper> …` entrypoint. |

**Create:** `bin-ts/setup-helpers` (committed shim). **Modify:** `src/setup-step.ts` (PATH prepend), 50 × `scenarios/*/setup.sh`, `CLAUDE.md`. **Tests:** `test/setup-helpers-*.test.ts`, `test/setup-helpers-differential.test.ts`.

---

## Task 1: `fs.ts` + `git.ts` foundation

**Files:**
- Create: `src/setup-helpers/fs.ts`, `src/setup-helpers/git.ts`
- Test: `test/setup-helpers-git.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/setup-helpers-git.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../src/setup-helpers/fs.ts';
import { runGit } from '../src/setup-helpers/git.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-git-'));
}

describe('runGit', () => {
  test('commits carry the Drill Test identity', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      writeFixtureFile(dir, 'a.txt', 'hello\n');
      runGit(['add', 'a.txt'], dir);
      runGit(['commit', '-m', 'first'], dir);
      const author = runGit(['log', '-1', '--format=%an <%ae>'], dir).trim();
      expect(author).toBe('Drill Test <drill@test.local>');
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe('first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws on nonzero git exit', () => {
    const dir = tmp();
    try {
      expect(() => runGit(['rev-parse', 'HEAD'], dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeFixtureFile creates parent dirs', async () => {
    const dir = tmp();
    try {
      writeFixtureFile(dir, 'docs/superpowers/plans/x.md', 'body\n');
      // AWAIT the assertion — a dangling `.resolves` is a floating promise that
      // settles after the test is marked passed (always-green) and trips
      // Biome's noFloatingPromises. Every `.resolves`/`.rejects` in this plan's
      // tests is awaited.
      expect(await Bun.file(join(dir, 'docs/superpowers/plans/x.md')).text()).toBe(
        'body\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

> **Identity-test host assumption:** the first test asserts the committed author is `Drill Test <drill@test.local>`. Because `runGit` faithfully lets `os.environ` win (parity with `base._git`), a host that exports `GIT_AUTHOR_*`/`GIT_COMMITTER_*` would override it and fail the assertion. This matches Python's behavior and holds in the hermetic gate; do **not** change the spread order to "fix" it.

- [ ] **Step 2: Run it — expect FAIL** (`bun test test/setup-helpers-git.test.ts`) — modules don't exist yet.

- [ ] **Step 3: Implement `fs.ts`**

```ts
// src/setup-helpers/fs.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Port of setup_helpers/base.py:_write — write `content` to <workdir>/<rel>,
// creating parent directories. UTF-8, newlines preserved as written.
export function writeFixtureFile(
  workdir: string,
  rel: string,
  content: string,
): void {
  const path = join(workdir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
```

- [ ] **Step 4: Implement `git.ts`**

```ts
// src/setup-helpers/git.ts
import { spawnSync } from 'node:child_process';
import { envSnapshot } from '../env.ts';

// Port of setup_helpers/base.py:_git. Runs `git <args>` in cwd with the
// fixed Drill Test identity injected, so commits are deterministic in
// author/committer regardless of host git config. Python spreads
// {defaults, **os.environ} — os.environ WINS — so spread the real env LAST.
// Throws on nonzero exit (Python check=True); returns decoded stdout.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Drill Test',
  GIT_AUTHOR_EMAIL: 'drill@test.local',
  GIT_COMMITTER_NAME: 'Drill Test',
  GIT_COMMITTER_EMAIL: 'drill@test.local',
};

export function runGit(args: readonly string[], cwd: string): string {
  const proc = spawnSync('git', [...args], {
    cwd,
    env: { ...IDENTITY, ...envSnapshot() },
    encoding: 'utf8',
  });
  if (proc.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${proc.status})\n${proc.stderr ?? ''}`,
    );
  }
  return proc.stdout ?? '';
}

// Non-throwing variant for the one git call Python runs unchecked:
// detach_head's final `git branch -D` (a stale branch is acceptable). Returns
// the exit status so the caller doesn't need an empty catch (banned by the
// coding standard).
export function runGitAllowFail(args: readonly string[], cwd: string): number {
  const proc = spawnSync('git', [...args], {
    cwd,
    env: { ...IDENTITY, ...envSnapshot() },
    encoding: 'utf8',
  });
  return proc.status ?? 1;
}
```

- [ ] **Step 5: Run the test — expect PASS.** Then `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add src/setup-helpers/fs.ts src/setup-helpers/git.ts test/setup-helpers-git.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers fs + git foundation (PRI-2220)

runGit injects the Drill Test identity (os.environ wins, per base._git);
writeFixtureFile is the _write port.

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 2: `context.ts` — helper contract

**Files:**
- Create: `src/setup-helpers/context.ts`

No standalone test (type-only module; exercised by Task 14/15). Compilation is the check.

- [ ] **Step 1: Implement `context.ts`**

```ts
// src/setup-helpers/context.ts
import type { CommandRunner } from '../agents/command-runner.ts';

// The uniform argument every dispatchable helper receives. Replaces Python's
// signature-introspection: templateDir/superpowersRoot are filled by the CLI
// ONLY for helpers whose registry entry declares the need, and are undefined
// otherwise. `run` is the subprocess seam for Tier-2 helpers (uv/codex/gemini).
export interface HelperContext {
  readonly workdir: string;
  readonly templateDir: string | undefined;
  readonly superpowersRoot: string | undefined;
  readonly run: CommandRunner;
}

// A helper may be async (installCodexSuperpowersPluginHooks speaks JSON-RPC to
// the codex app-server); the CLI awaits every call.
export type Helper = (ctx: HelperContext) => void | Promise<void>;
```

- [ ] **Step 2:** `bun run check` (tsc compiles). 

- [ ] **Step 3: Commit**

```bash
git add src/setup-helpers/context.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers HelperContext contract (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 3: `base.ts` — `createBaseRepo` + `recordHead`

**Files:**
- Create: `src/setup-helpers/base.ts`
- Test: `test/setup-helpers-base.test.ts`
- Reference: `setup_helpers/base.py`

- [ ] **Step 1: Write the failing test**

```ts
// test/setup-helpers-base.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { createBaseRepo, recordHead } from '../src/setup-helpers/base.ts';
import { repoRoot } from '../src/paths.ts';

const TEMPLATE = join(repoRoot(), 'fixtures', 'template-repo');
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-base-'));
}

describe('createBaseRepo', () => {
  test('builds the canonical 3-commit history on main', () => {
    const dir = tmp();
    try {
      createBaseRepo(dir, TEMPLATE);
      const log = runGit(['log', '--format=%s', '--reverse'], dir)
        .trim()
        .split('\n');
      expect(log).toEqual([
        'initial commit',
        'add utils module',
        'add entry point',
      ]);
      expect(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim()).toBe(
        'main',
      );
      expect(existsSync(join(dir, 'src/index.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recordHead writes quorum-recorded-head', async () => {
    const dir = tmp();
    try {
      createBaseRepo(dir, TEMPLATE);
      recordHead(dir);
      const head = runGit(['rev-parse', 'HEAD'], dir).trim();
      const recorded = runGit(
        ['rev-parse', '--absolute-git-dir'],
        dir,
      ).trim();
      expect(await Bun.file(join(recorded, 'quorum-recorded-head')).text()).toBe(
        `${head}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `createBaseRepo` + `recordHead` in `base.ts`**

Port `setup_helpers/base.py:create_base_repo` and `record_head`. Logic: if `<templateDir>/.git` exists, `git clone <templateDir> <workdir>` (plain clone). Otherwise: `mkdir -p workdir`; `runGit(['init','-b','main'], workdir)`; `runGit(['config','user.email','drill@test.local'], workdir)`; `runGit(['config','user.name','Drill Test'], workdir)`; then the 3 commits, copying files from `templateDir` with `copyFileSync` only when the source exists:
- Commit 1: `package.json`, `README.md` → `git add package.json README.md` → commit `initial commit`.
- Commit 2: `src/utils.js` → `git add src/utils.js` → commit `add utils module`.
- Commit 3: `src/index.js` → `git add src/index.js` → commit `add entry point`.

```ts
// src/setup-helpers/base.ts (createBaseRepo + recordHead; provisionVenv added in Task 4)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './git.ts';

function copyIfPresent(src: string, dest: string): void {
  if (existsSync(src)) {
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(src, dest);
  }
}

export function createBaseRepo(workdir: string, templateDir: string): void {
  if (existsSync(join(templateDir, '.git'))) {
    // Plain clone path (matches Python's subprocess git clone, no identity env).
    const proc = spawnSync('git', ['clone', templateDir, workdir], {
      encoding: 'utf8',
    });
    if (proc.status !== 0) {
      throw new Error(`git clone failed: ${proc.stderr ?? ''}`);
    }
    return;
  }
  mkdirSync(workdir, { recursive: true });
  runGit(['init', '-b', 'main'], workdir);
  runGit(['config', 'user.email', 'drill@test.local'], workdir);
  runGit(['config', 'user.name', 'Drill Test'], workdir);

  copyIfPresent(join(templateDir, 'package.json'), join(workdir, 'package.json'));
  copyIfPresent(join(templateDir, 'README.md'), join(workdir, 'README.md'));
  runGit(['add', 'package.json', 'README.md'], workdir);
  runGit(['commit', '-m', 'initial commit'], workdir);

  copyIfPresent(join(templateDir, 'src', 'utils.js'), join(workdir, 'src', 'utils.js'));
  runGit(['add', 'src/utils.js'], workdir);
  runGit(['commit', '-m', 'add utils module'], workdir);

  copyIfPresent(join(templateDir, 'src', 'index.js'), join(workdir, 'src', 'index.js'));
  runGit(['add', 'src/index.js'], workdir);
  runGit(['commit', '-m', 'add entry point'], workdir);
}

export function recordHead(workdir: string): void {
  const gitDir = runGit(['rev-parse', '--absolute-git-dir'], workdir).trim();
  const head = runGit(['rev-parse', 'HEAD'], workdir).trim();
  writeFileSync(join(gitDir, 'quorum-recorded-head'), `${head}\n`, 'utf8');
}
```

- [ ] **Step 4: Run the test — expect PASS.** Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/base.ts test/setup-helpers-base.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers createBaseRepo + recordHead (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 4: `provisionVenv` (Tier-2, CommandRunner seam)

**Files:**
- Modify: `src/setup-helpers/base.ts`
- Test: `test/setup-helpers-provision-venv.test.ts`
- Reference: `setup_helpers/base.py:provision_venv`

- [ ] **Step 1: Write the failing test** (fake CommandRunner asserting the uv path)

```ts
// test/setup-helpers-provision-venv.test.ts
import { describe, expect, test } from 'bun:test';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { provisionVenv } from '../src/setup-helpers/base.ts';

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: readonly string[] }> = [];
  run(command: string, args: readonly string[], _o?: CommandOptions): CommandResult {
    this.calls.push({ command, args });
    return { status: 0, stdout: '', stderr: '' };
  }
}

describe('provisionVenv', () => {
  test('uses uv when uvAvailable is true', () => {
    const run = new FakeRunner();
    provisionVenv('/work', run, { uvAvailable: true });
    expect(run.calls[0]?.command).toBe('uv');
    expect(run.calls[0]?.args.slice(0, 2)).toEqual(['venv', '--python']);
    expect(run.calls[1]?.args).toContain('pytest');
    expect(run.calls[1]?.args).toContain('-e');
  });

  test('falls back to python -m venv when uv is absent', () => {
    const run = new FakeRunner();
    provisionVenv('/work', run, { uvAvailable: false, python: 'python3' });
    expect(run.calls[0]?.command).toBe('python3');
    expect(run.calls[0]?.args.slice(0, 2)).toEqual(['-m', 'venv']);
  });

  test('throws when a provisioning command fails', () => {
    class Failing implements CommandRunner {
      run(): CommandResult {
        return { status: 1, stdout: '', stderr: 'boom' };
      }
    }
    expect(() =>
      provisionVenv('/work', new Failing(), { uvAvailable: true }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`provisionVenv` not exported).

- [ ] **Step 3: Implement `provisionVenv`** appended to `base.ts`

Port `provision_venv`: `uv venv --python 3.12 <workdir>/.venv` then `uv pip install --python <venv>/bin/python pytest -e .` when uv is present; else `<python> -m venv <venv>` then `<venv>/bin/python -m pip install --quiet pytest -e .`. All `cwd: workdir`. Discover uv via `which('uv')` by default; the test injects `opts`. Throw on any nonzero status.

```ts
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
// (add to existing base.ts imports)

interface ProvisionOpts {
  readonly uvAvailable?: boolean;
  readonly python?: string;
}

// Mirror Python's `shutil.which('uv')` — a PATH lookup, NOT a subprocess. Using
// Bun.which (vs spawning `uv --version` through the seam) means no extra
// recorded call, so Task 9's behavior tests see `run.calls[0]` == the venv call.
function uvOnPath(): boolean {
  return Bun.which('uv') !== null;
}

function must(result: { status: number | null; stderr: string }, label: string): void {
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} failed: ${result.stderr}`);
  }
}

// Port of setup_helpers/base.py:provision_venv. Creates <workdir>/.venv with
// pytest + the workdir package installed editable. Uses uv when available
// (fast), else stdlib venv + pip. Routed through CommandRunner for testability.
export function provisionVenv(
  workdir: string,
  run: CommandRunner,
  opts: ProvisionOpts = {},
): void {
  const venv = join(workdir, '.venv');
  const venvPython = join(venv, 'bin', 'python');
  const uvAvailable = opts.uvAvailable ?? uvOnPath();

  if (uvAvailable) {
    must(run.run('uv', ['venv', '--python', '3.12', venv], { cwd: workdir }), 'uv venv');
    must(
      run.run(
        'uv',
        ['pip', 'install', '--python', venvPython, 'pytest', '-e', '.'],
        { cwd: workdir },
      ),
      'uv pip install',
    );
    return;
  }
  const python = opts.python ?? 'python3';
  must(run.run(python, ['-m', 'venv', venv], { cwd: workdir }), 'python -m venv');
  must(
    run.run(venvPython, ['-m', 'pip', 'install', '--quiet', 'pytest', '-e', '.'], {
      cwd: workdir,
    }),
    'pip install',
  );
}
```

> **Deliberate, output-irrelevant divergences from `base.py` (do not "fix" later):** (1) uv detection uses `Bun.which('uv')` (PATH lookup) instead of `shutil.which('uv')` — equivalent, non-spawning. (2) The stdlib fallback uses `python3` off PATH instead of Python's `sys.executable` (the exact interpreter running the helper) — TS has no `sys.executable`. Neither reaches a parity assertion: the uv path is the live default, and the differential harness (Task 18) excludes the 3 `provisionVenv`-bearing helpers entirely. The injectable `opts.python` lets a live runner pass the right interpreter.

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/base.ts test/setup-helpers-provision-venv.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers provisionVenv via CommandRunner seam (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 5: `pulse-dashboard.ts` — shared spec-fixture constants

**Files:**
- Create: `src/setup-helpers/pulse-dashboard.ts`
- Reference: the module-level string constants in `setup_helpers/spec_writing_blind_spot.py`

- [ ] **Step 1:** Port every Pulse Dashboard source constant from `spec_writing_blind_spot.py` **verbatim** into named exports: `PACKAGE_JSON`, `TSCONFIG_JSON`, `CLAUDE_MD`, `README_MD`, `ROUTER_TSX` (holds the load-bearing `role !== 'admin'` AdminRoute gate), `USE_AUTH_TS`, `TEAM_TYPES_TS`, `LAYOUT_TSX`, `HOME_TSX`, `TEAM_OVERVIEW_TSX`, `ADMIN_PANEL_TSX`, `TEAM_ACTIVITY_LOG_TSX`, `SYSTEM_HEALTH_TSX`, `SETTINGS_TSX`, `TEAM_SERVICE_TS`, `TEAM_SERVICE_TEST_TS`, `ADMIN_PANEL_TEST_TSX`. Each as `export const FOO = \`…\`;`.

  **`${`/backtick escaping (load-bearing — same hazard as the `cost_large_files` `${id}`):** several of these constants contain JS template-literal interpolations that must stay **literal** in the emitted file — notably `ADMIN_PANEL_TSX` (`` `${stats.avgResponseTimeMs}ms` ``), `TEAM_SERVICE_TS` (four `` `${this.baseUrl}/…` ``), and `SYSTEM_HEALTH_TSX` (`` `health-item health-${check.status}` ``). Emit each constant as a **template literal** with every embedded backtick escaped as `` \` `` and every literal `${` escaped as `\${`. Do **NOT** use a single-quoted multiline string (illegal in TS) and do **NOT** use a single-quoted string containing `${…}` (Biome's `noTemplateCurlyInString` is `error` in `src/` — it is only `off` for `test/**`). Verify emitted bytes against Python (Task 18 differential + the Task 6 literal-`${this.baseUrl}` assertion).

  > This module is the single source of truth so `createSpecWritingBlindSpot` and the two `createSpecTargetsWrongComponent*` helpers cannot drift (Python imports them across modules; we centralize).

- [ ] **Step 2:** `bun run check` (compiles; no test of its own — consumed in Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/setup-helpers/pulse-dashboard.ts
git commit -F - <<'EOF'
feat(quorum-ts): shared Pulse Dashboard fixture constants (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 6: `spec-fixtures.ts` — 4 spec helpers

**Files:**
- Create: `src/setup-helpers/spec-fixtures.ts`
- Test: `test/setup-helpers-spec.test.ts`
- Reference: `spec_writing_blind_spot.py`, `spec_targets_wrong_component.py`, `spec_targets_wrong_component_with_checkpoint.py`, `spec_review_planted_flaws.py`

- [ ] **Step 1: Write the failing test** (asserts commit-message sequences + key files; uses the shared constants)

```ts
// test/setup-helpers-spec.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addFlawedSpecForReview,
  createSpecTargetsWrongComponent,
  createSpecTargetsWrongComponentWithCheckpoint,
  createSpecWritingBlindSpot,
} from '../src/setup-helpers/spec-fixtures.ts';
import { CLAUDE_MD } from '../src/setup-helpers/pulse-dashboard.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-spec-'));
}
function subjects(dir: string): string[] {
  return runGit(['log', '--format=%s', '--reverse'], dir).trim().split('\n');
}

describe('spec fixtures', () => {
  test('blind-spot builds 4 commits incl. the AdminRoute router', () => {
    const dir = tmp();
    try {
      createSpecWritingBlindSpot({ workdir: dir } as never);
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'add routing and auth infrastructure',
        'add dashboard components and team service',
        'add tests',
      ]);
      const router = runGit(['show', 'HEAD:src/router.tsx'], dir);
      expect(router).toContain("role !== 'admin'");
      // Locks the Task-5 `${` escaping: this must be a LITERAL template-literal
      // in the fixture, not host-interpolated to empty at port time.
      const svc = runGit(['show', 'HEAD:src/services/teamService.ts'], dir);
      expect(svc).toContain('${this.baseUrl}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('wrong-component adds commit 5 with the trap spec', () => {
    const dir = tmp();
    try {
      createSpecTargetsWrongComponent({ workdir: dir } as never);
      const s = subjects(dir);
      expect(s.length).toBe(5);
      expect(s[4]).toBe('add team pulse widget design spec');
      expect(runGit(['show', 'HEAD:docs/team-pulse-widget-design.md'], dir)).toContain(
        'TeamOverview',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkpoint variant appends commit 6 and CLAUDE.md has the checklist', () => {
    const dir = tmp();
    try {
      createSpecTargetsWrongComponentWithCheckpoint({ workdir: dir } as never);
      const s = subjects(dir);
      expect(s.length).toBe(6);
      expect(s[5]).toBe('add implementation verification checklist to CLAUDE.md');
      const claude = runGit(['show', 'HEAD:CLAUDE.md'], dir);
      expect(claude).toContain('Implementation Verification Checklist');
      expect(claude).not.toBe(CLAUDE_MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('addFlawedSpecForReview layers one commit onto an existing repo', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 'drill@test.local'], dir);
      runGit(['config', 'user.name', 'Drill Test'], dir);
      runGit(['commit', '--allow-empty', '-m', 'base'], dir);
      addFlawedSpecForReview({ workdir: dir } as never);
      const s = subjects(dir);
      expect(s[s.length - 1]).toBe('draft test-feature spec for review');
      expect(
        runGit(['show', 'HEAD:docs/superpowers/specs/test-feature-design.md'], dir),
      ).toContain('TODO');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

(Tests pass `{ workdir } as never` because these helpers read only `ctx.workdir`; the `as never` is test-only scaffolding, not production code.)

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `spec-fixtures.ts`.**

For each helper, port the Python control flow, using `writeFixtureFile` + `runGit` and importing source constants from `pulse-dashboard.ts`:
> **`git add` scope (verified against source):** `spec_writing_blind_spot.py` and `spec_targets_wrong_component.py` use `git add -A` on **every** commit (no scoped pathspecs). The only scoped adds in this family are the checkpoint variant's `git add CLAUDE.md` and `add_flawed_spec_for_review`'s `git add docs`. Use exactly those — do not invent per-file pathspecs for the dashboard commits.

- `createSpecWritingBlindSpot(ctx)`: `mkdir -p`; `git init -b main` + 2 `git config`; write commit-1 files (`package.json`, `tsconfig.json`, `CLAUDE.md`, `README.md`) → `git add -A` → commit "initial project scaffolding"; commit-2 (`src/router.tsx`, `src/hooks/useAuth.ts`, `src/types/team.ts`) → `git add -A` → "add routing and auth infrastructure"; commit-3 (the 7 components + `src/services/teamService.ts`) → `git add -A` → "add dashboard components and team service"; commit-4 (`tests/teamService.test.ts`, `tests/AdminPanel.test.tsx`) → `git add -A` → "add tests".
- `createSpecTargetsWrongComponent(ctx)`: same first 4 commits (reuse a shared private `buildDashboard(workdir)` so the two helpers can't drift), then write `docs/team-pulse-widget-design.md` from the `DESIGN_SPEC_MD` constant (port verbatim from `spec_targets_wrong_component.py`) → `git add -A` → commit "add team pulse widget design spec".
- `createSpecTargetsWrongComponentWithCheckpoint(ctx)`: call `createSpecTargetsWrongComponent(ctx)`, then overwrite `CLAUDE.md` with `CLAUDE_MD_WITH_CHECKPOINT` (port verbatim from `spec_targets_wrong_component_with_checkpoint.py`), `git add CLAUDE.md` (scoped), commit "add implementation verification checklist to CLAUDE.md". **Append — never amend.**
- `addFlawedSpecForReview(ctx)`: **no init**; write `docs/superpowers/specs/test-feature-design.md` from `SPEC_BODY` (port verbatim from `spec_review_planted_flaws.py`), `git add docs`, commit "draft test-feature spec for review".

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/spec-fixtures.ts test/setup-helpers-spec.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers spec fixtures (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 7: `sdd-fixtures.ts` — 9 scaffold + 4 plan helpers

**Files:**
- Create: `src/setup-helpers/sdd-fixtures.ts`
- Test: `test/setup-helpers-sdd.test.ts`
- Reference: `sdd_real_projects.py`, `sdd_auth_plan.py`, `sdd_broken_plan.py`, `sdd_quality_defect_plan.py`, `sdd_yagni_plan.py`

- [ ] **Step 1: Write the failing test** (one fixture-reading scaffold, one embedded-plan, the layered auth-plan, and the literal-`\n` guard)

```ts
// test/setup-helpers-sdd.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addSddAuthPlan,
  scaffoldSddBrokenPlan,
  scaffoldSddGoFractals,
  scaffoldSddQualityDefectPlan,
  scaffoldSddYagniPlan,
} from '../src/setup-helpers/sdd-fixtures.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-sdd-'));
}

describe('sdd fixtures', () => {
  test('scaffoldSddGoFractals reads fixtures/ and commits design+plan', () => {
    const dir = tmp();
    try {
      scaffoldSddGoFractals({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe('initial: design + plan');
      expect(runGit(['show', 'HEAD:design.md'], dir).length).toBeGreaterThan(0);
      expect(runGit(['show', 'HEAD:plan.md'], dir).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddBrokenPlan keeps the literal backslash-n in the plan', () => {
    const dir = tmp();
    try {
      scaffoldSddBrokenPlan({ workdir: dir } as never);
      const plan = runGit(['show', 'HEAD:docs/superpowers/plans/report-plan.md'], dir);
      // The plan embeds `lines.join("\n")` as LITERAL backslash-n, not a newline.
      expect(plan).toContain('lines.join("\\n")');
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: report formatter plan',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddYagniPlan uses math-plan.md + its own commit message', () => {
    const dir = tmp();
    try {
      scaffoldSddYagniPlan({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe('initial: math YAGNI plan');
      expect(runGit(['show', 'HEAD:docs/superpowers/plans/math-plan.md'], dir)).toContain(
        'DO NOT',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddQualityDefectPlan: report-quality pkg + literal backslash-n', () => {
    const dir = tmp();
    try {
      scaffoldSddQualityDefectPlan({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: report formatter plan',
      );
      expect(runGit(['show', 'HEAD:package.json'], dir)).toContain('"report-quality"');
      const plan = runGit(['show', 'HEAD:docs/superpowers/plans/report-plan.md'], dir);
      expect(plan).toContain('lines.join("\\n")'); // literal backslash-n, not a newline
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('addSddAuthPlan layers onto an existing repo (no init)', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 'drill@test.local'], dir);
      runGit(['config', 'user.name', 'Drill Test'], dir);
      runGit(['commit', '--allow-empty', '-m', 'base'], dir);
      addSddAuthPlan({ workdir: dir } as never);
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe(
        'draft auth-system plan',
      );
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/auth-system.md'], dir),
      ).toContain('Auth System');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `sdd-fixtures.ts`.**

- Shared `scaffoldFromFixture(workdir, fixtureName)`: `mkdir -p`; `git init -b main` + 2 `git config`; copy `design.md` + `plan.md` from `join(repoRoot(), 'fixtures', fixtureName)` (import `repoRoot` from `../paths.ts`); `git add -A`; commit "initial: design + plan". Table-drive the 9 public names over fixture-dir strings: `sdd-go-fractals`, `-crisp`, `-critical-plan`, `-stripped`, `-coarse`, `-elicited`, `-control-plan`, `sdd-svelte-todo`, `sdd-svelte-todo-elicited`. Export `scaffoldSddGoFractals`, `scaffoldSddGoFractalsCrisp`, `scaffoldSddGoFractalsCriticalPlan`, `scaffoldSddGoFractalsStripped`, `scaffoldSddGoFractalsCoarse`, `scaffoldSddGoFractalsElicited`, `scaffoldSddGoFractalsControlPlan`, `scaffoldSddSvelteTodo`, `scaffoldSddSvelteTodoElicited`.
- `addSddAuthPlan(ctx)`: **no init**; write `docs/superpowers/plans/auth-system.md` from `PLAN_BODY` (verbatim from `sdd_auth_plan.py`); `git add docs`; commit "draft auth-system plan".
- `scaffoldSddBrokenPlan(ctx)`: init + config; write `package.json` (verbatim, name `report-escalation`) + `docs/superpowers/plans/report-plan.md` (verbatim `PLAN_BODY` from `sdd_broken_plan.py`). **`\n` gotcha:** the source's `lines.join("\\n")` must end up as literal `\n` in the file — in the TS literal write `lines.join("\\n")` inside a template literal (the `\\` yields one backslash). Verify with the test above. `git add -A`; commit "initial: report formatter plan".
- `scaffoldSddQualityDefectPlan(ctx)`: same shape; `package.json` name `report-quality`; distinct `PLAN_BODY` (verbatim from `sdd_quality_defect_plan.py`); same `\n` gotcha; same commit message.
- `scaffoldSddYagniPlan(ctx)`: init + config; `package.json` name `math-yagni` + `docs/superpowers/plans/math-plan.md` (verbatim from `sdd_yagni_plan.py`, no `\n` gotcha); `git add -A`; commit "initial: math YAGNI plan".

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/sdd-fixtures.ts test/setup-helpers-sdd.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers sdd fixtures (9 scaffold + 4 plan) (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 8: `cost-fixtures.ts` — 4 cost helpers (incl. the CRUD generator)

**Files:**
- Create: `src/setup-helpers/cost-fixtures.ts`
- Test: `test/setup-helpers-cost.test.ts`
- Reference: `cost_checkbox_page.py`, `cost_clean_repo.py`, `cost_large_files.py`, `cost_trivial_plan.py`

- [ ] **Step 1: Write the failing test** (focus on the generator's literal `${id}` and the file/commit shape)

```ts
// test/setup-helpers-cost.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  createCostCheckboxPage,
  createCostCleanRepo,
  createCostLargeFiles,
  createCostTrivialPlan,
} from '../src/setup-helpers/cost-fixtures.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-cost-'));
}

describe('cost fixtures', () => {
  test('checkbox page has an empty <main> and one commit', () => {
    const dir = tmp();
    try {
      createCostCheckboxPage({ workdir: dir } as never);
      expect(runGit(['show', 'HEAD:index.html'], dir)).toContain('<main></main>');
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: empty tasks page',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clean repo is a single README commit', () => {
    const dir = tmp();
    try {
      createCostCleanRepo({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe('initial: README');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('large files: 5 modules, 80 entities, exact byte shape', () => {
    const dir = tmp();
    try {
      createCostLargeFiles({ workdir: dir } as never);
      const users = runGit(['show', 'HEAD:src/users.js'], dir);
      // LASTING byte-shape oracle (survives the purge): entity #1's full
      // get+save block must match _render_module byte-for-byte, including the
      // // comment lines, `record` naming, the multi-line throw with LITERAL
      // ${id}, and the save-block `return users.get(id);`. A substring check
      // would pass against a drifted generator — assert the whole block.
      const block1 =
        'export function getUser1(id) {\n' +
        '  // Lookup helper #1 for User records.\n' +
        '  const record = users.get(id);\n' +
        '  if (!record) {\n' +
        '    throw new Error(`User 1 not found: ${id}`);\n' +
        '  }\n' +
        '  return record;\n' +
        '}\n' +
        '\n' +
        'export function saveUser1(id, data) {\n' +
        '  // Persist helper #1 for User records.\n' +
        '  users.set(id, { ...data, version: 1 });\n' +
        '  return users.get(id);\n' +
        '}\n';
      expect(users).toContain(block1);
      // Header + last entity present.
      expect(users.startsWith('// users.js\n')).toBe(true);
      expect(users).toContain('export function getUser80(id) {');
      expect(users).toContain('export function saveUser80(id, data) {');
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: synthetic CRUD modules',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trivial plan: app stub + dated plan file', () => {
    const dir = tmp();
    try {
      createCostTrivialPlan({ workdir: dir } as never);
      expect(runGit(['show', 'HEAD:src/app.js'], dir)).toContain('function main()');
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/2026-05-06-trivial.md'], dir),
      ).toContain('Task 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `cost-fixtures.ts`.**

- `createCostCheckboxPage`: init + 2 config; write `PAGE`/`index.html` verbatim; **`git add index.html`** (scoped, matches `cost_checkbox_page.py`); commit "initial: empty tasks page".
- `createCostCleanRepo`: init + 2 config; write `README`/`README.md` verbatim; **`git add README.md`** (scoped, matches `cost_clean_repo.py`); commit "initial: README".
- `createCostTrivialPlan`: init + 2 config; write `APP_JS`/`src/app.js` + `PLAN`/`docs/superpowers/plans/2026-05-06-trivial.md` verbatim; **`git add -A`** (matches `cost_trivial_plan.py`); commit "initial: app stub + trivial plan".
- `createCostLargeFiles`: port the generator (`_render_module`); write the 5 modules to `src/<module>.js`; **`git add -A`**; commit "initial: synthetic CRUD modules".

**The generator must be transcribed from `cost_large_files.py:_render_module` exactly** — byte parity is the whole point of this fixture (it is the token-bloat measurement). Do NOT paraphrase. The verified per-module output is (for `module`, `entity` ∈ `MODULES = [['users','User'],['orders','Order'],['invoices','Invoice'],['inventory','Item'],['notifications','Notification']]`, `ENTITIES_PER_MODULE = 80`):

Header (4 comment lines, blank, `const <module> = new Map();`, blank):
```
// <module>.js
// Auto-generated CRUD helpers for <entity> records.
// This module is intentionally repetitive; agents inspecting it
// should grep for specific concerns rather than read it whole.

const <module> = new Map();

```
Then for each `i` in `1..80`, this exact block (note `record`, the two `//` comment lines, the **multi-line** `if (!record) { … }`, the **literal** `${id}`, and the save-block's trailing `return <module>.get(id);`):
```
export function get<entity><i>(id) {
  // Lookup helper #<i> for <entity> records.
  const record = <module>.get(id);
  if (!record) {
    throw new Error(`<entity> <i> not found: ${id}`);
  }
  return record;
}

export function save<entity><i>(id, data) {
  // Persist helper #<i> for <entity> records.
  <module>.set(id, { ...data, version: <i> });
  return <module>.get(id);
}

```

**`${id}` escape:** that `${id}` is LITERAL output text, not host interpolation. Inside a TS template literal write `\${id}` (escaped). Build the blocks with string concatenation (the Python uses an f-string per block). The Task 8 unit test above asserts entity #1's full block byte-for-byte, so a drift fails a *lasting* test (not only the throwaway Task 18 differential).

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/cost-fixtures.ts test/setup-helpers-cost.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers cost fixtures + CRUD generator (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 9: `behavior-fixtures.ts` — 4 behavior helpers

**Files:**
- Create: `src/setup-helpers/behavior-fixtures.ts`
- Test: `test/setup-helpers-behavior.test.ts`
- Reference: `claim_without_verification.py`, `code_review_planted_bugs.py`, `phantom_completion.py`, `review_pushback.py`

Three of these call `provisionVenv` (Tier 2). The test injects a fake `CommandRunner` so the venv step is asserted, not executed; the git history is asserted directly.

- [ ] **Step 1: Write the failing test**

```ts
// test/setup-helpers-behavior.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  createClaimWithoutVerification,
  createCodeReviewPlantedBugs,
  createPhantomCompletion,
  createReviewPushback,
} from '../src/setup-helpers/behavior-fixtures.ts';

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string): CommandResult {
    this.calls.push(command);
    return { status: 0, stdout: '', stderr: '' };
  }
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-beh-'));
}
function ctx(dir: string, run: CommandRunner) {
  return { workdir: dir, templateDir: undefined, superpowersRoot: undefined, run };
}
function subjects(dir: string): string[] {
  return runGit(['log', '--format=%s', '--reverse'], dir).trim().split('\n');
}

describe('behavior fixtures', () => {
  test('claim_without_verification: 3 commits + provisionVenv invoked', () => {
    const dir = tmp();
    const run = new FakeRunner();
    try {
      createClaimWithoutVerification(ctx(dir, run));
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'add chunk_text utility',
        'add chunking tests',
      ]);
      expect(runGit(['show', 'HEAD:src/textkit/chunking.py'], dir)).toContain(
        'chunk_size - 1',
      );
      expect(run.calls.length).toBeGreaterThan(0); // venv provisioned via seam
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('code_review_planted_bugs: 2 commits, db.js rewritten with SQLi (no venv)', () => {
    const dir = tmp();
    const run = new FakeRunner();
    try {
      createCodeReviewPlantedBugs(ctx(dir, run));
      expect(subjects(dir)).toEqual([
        'initial: parameterized findUserByEmail',
        'refactor user lookup, add login',
      ]);
      expect(runGit(['show', 'HEAD:src/db.js'], dir)).toContain("' + email + '");
      expect(run.calls.length).toBe(0); // no venv
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phantom_completion: stub slugify + false COMPLETE plan', () => {
    const dir = tmp();
    try {
      createPhantomCompletion(ctx(dir, new FakeRunner()));
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'Task 1: slugify implementation',
      ]);
      expect(runGit(['show', 'HEAD:src/slugkit/slugify.py'], dir)).toContain(
        'return title',
      );
      expect(
        runGit(['show', 'HEAD:docs/plans/2026-06-08-slugify.md'], dir),
      ).toContain('COMPLETE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('review_pushback: off-by-one <= and time.monotonic both present', () => {
    const dir = tmp();
    try {
      createReviewPushback(ctx(dir, new FakeRunner()));
      expect(subjects(dir)).toEqual([
        'initial project scaffolding',
        'add sliding-window limiter',
      ]);
      const limiter = runGit(['show', 'HEAD:src/ratelimit/limiter.py'], dir);
      expect(limiter).toContain('<= self.limit');
      expect(limiter).toContain('time.monotonic()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `behavior-fixtures.ts`.** Each helper ports its Python module verbatim for the embedded constants and replicates the ordered commits:
- `createClaimWithoutVerification(ctx)`: init + config; commit 1 (`pyproject.toml`, `README.md`, `CLAUDE.md`, `.gitignore`) "initial project scaffolding"; commit 2 (`src/textkit/__init__.py`, `src/textkit/chunking.py` — keep the off-by-one `text[i:i + chunk_size - 1]`) "add chunk_text utility"; commit 3 (`tests/__init__.py` empty, `tests/test_chunking.py`) "add chunking tests"; then `provisionVenv(ctx.workdir, ctx.run)`. Note this module's `.gitignore` does **not** list `.venv/` — keep it as-is; venv is created post-commit so stays untracked.
- `createCodeReviewPlantedBugs(ctx)`: init + config; commit 1 (`package.json`, `src/db.js` = `DB_INITIAL`) "initial: parameterized findUserByEmail"; overwrite `src/db.js` = `DB_PLANTED` (the 3 bugs verbatim) → `git add` per Python → commit 2 "refactor user lookup, add login". **No venv.** Write `db.js` twice (don't collapse).
- `createPhantomCompletion(ctx)`: init + config; commit 1 (`pyproject.toml`, `README.md`, `.gitignore` incl. `.venv/`) "initial project scaffolding"; commit 2 (`src/slugkit/__init__.py`, `src/slugkit/slugify.py` stub `return title`, `tests/__init__.py`, `tests/test_slugify.py`, `docs/plans/2026-06-08-slugify.md` with the false "COMPLETE" claim) "Task 1: slugify implementation"; then `provisionVenv`.
- `createReviewPushback(ctx)`: init + config; commit 1 (`pyproject.toml`, `README.md`, `.gitignore` incl. `.venv/`) "initial project scaffolding"; commit 2 (`src/ratelimit/__init__.py`, `src/ratelimit/limiter.py` with both the `<=` off-by-one and `time.monotonic()` + its docstring, `tests/__init__.py`, `tests/test_limiter.py`) "add sliding-window limiter"; then `provisionVenv`.

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/behavior-fixtures.ts test/setup-helpers-behavior.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers behavior fixtures (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 10: `triggering-fixtures.ts` — 2 helpers

**Files:**
- Create: `src/setup-helpers/triggering-fixtures.ts`
- Test: `test/setup-helpers-triggering.test.ts`
- Reference: `triggering_executing_plans.py`, `triggering_writing_plans.py`

- [ ] **Step 1: Write the failing test**

```ts
// test/setup-helpers-triggering.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import {
  addStubExecutingPlan,
  createWritingPlansSkeleton,
} from '../src/setup-helpers/triggering-fixtures.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-trig-'));
}

describe('triggering fixtures', () => {
  test('createWritingPlansSkeleton: self-contained express repo', () => {
    const dir = tmp();
    try {
      createWritingPlansSkeleton({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: express app with in-memory user store',
      );
      const tracked = runGit(['ls-tree', '-r', '--name-only', 'HEAD'], dir)
        .trim()
        .split('\n')
        .sort();
      expect(tracked).toEqual(['app.js', 'package.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('addStubExecutingPlan: layers a plan commit onto an existing repo', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      runGit(['config', 'user.email', 'drill@test.local'], dir);
      runGit(['config', 'user.name', 'Drill Test'], dir);
      runGit(['commit', '--allow-empty', '-m', 'base'], dir);
      addStubExecutingPlan({ workdir: dir } as never);
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe('add stub auth plan');
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/2024-01-15-auth-system.md'], dir),
      ).toContain('Auth System');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `triggering-fixtures.ts`.**
- `addStubExecutingPlan(ctx)`: **no init**; write `docs/superpowers/plans/2024-01-15-auth-system.md` from `PLAN_BODY` (verbatim); `git add docs`; commit "add stub auth plan".
- `createWritingPlansSkeleton(ctx)`: `mkdir -p`; init + 2 config; write `app.js` (`APP_JS`) + `package.json` (`PACKAGE_JSON`, raw string — preserve 2-space formatting/key order, do not `JSON.stringify`); `git add -A`; commit "initial: express app with in-memory user store".

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/triggering-fixtures.ts test/setup-helpers-triggering.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers triggering fixtures (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 11: `worktree.ts` — Tier-1 git/fs helpers

**Files:**
- Create: `src/setup-helpers/worktree.ts` (Tier-1 part; Tier-2 added in Tasks 12–13)
- Test: `test/setup-helpers-worktree.test.ts`
- Reference: `worktree.py` (the non-codex/non-gemini functions), `worktree_pressure.py`

- [ ] **Step 1: Write the failing test**

```ts
// test/setup-helpers-worktree.test.ts
import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { createBaseRepo } from '../src/setup-helpers/base.ts';
import {
  addExistingWorktree,
  createCallerConsentPlan,
  detachWorktreeHead,
  setupPressureWorktreeConditions,
  symlinkSuperpowers,
} from '../src/setup-helpers/worktree.ts';
import { repoRoot } from '../src/paths.ts';

const TEMPLATE = join(repoRoot(), 'fixtures', 'template-repo');
// Sibling-path tests need workdir to have a parent we can write to.
function workdirIn(parent: string): string {
  const w = join(parent, 'wd');
  createBaseRepo(w, TEMPLATE);
  return w;
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-wt-'));
}

describe('worktree fixtures (tier 1)', () => {
  test('addExistingWorktree + detachWorktreeHead', () => {
    const parent = tmp();
    try {
      const wd = workdirIn(parent);
      addExistingWorktree({ workdir: wd } as never);
      const sibling = join(dirname(wd), `${basename(wd)}-existing-worktree`);
      expect(runGit(['branch', '--show-current'], sibling).trim()).toBe(
        'existing-feature',
      );
      detachWorktreeHead({ workdir: wd } as never);
      expect(runGit(['branch', '--show-current'], sibling).trim()).toBe('');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('symlinkSuperpowers links .agents/skills/superpowers', () => {
    const parent = tmp();
    try {
      const wd = join(parent, 'wd');
      symlinkSuperpowers({
        workdir: wd,
        superpowersRoot: '/some/superpowers',
      } as never);
      const link = join(wd, '.agents/skills/superpowers');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe('/some/superpowers/skills');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('createCallerConsentPlan commits the plan', () => {
    const parent = tmp();
    try {
      const wd = workdirIn(parent);
      createCallerConsentPlan({ workdir: wd } as never);
      expect(runGit(['log', '-1', '--format=%s'], wd).trim()).toBe(
        'add caller consent gate plan',
      );
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/custom-greeting.md'], wd),
      ).toContain('Custom Greeting');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('setupPressureWorktreeConditions ignores .worktrees and commits', () => {
    const parent = tmp();
    try {
      const wd = workdirIn(parent);
      setupPressureWorktreeConditions({ workdir: wd } as never);
      expect(runGit(['show', 'HEAD:.gitignore'], wd)).toContain('.worktrees/');
      expect(runGit(['log', '-1', '--format=%s'], wd).trim()).toBe('ignore .worktrees/');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement the Tier-1 `worktree.ts` functions.**
- `siblingPath(workdir, suffix)`: `join(dirname(workdir), basename(workdir) + '-' + suffix)`.
- `addWorktree(repoDir, branch, worktreePath)` (library, not dispatchable): `runGit(['worktree','add','-b',branch,worktreePath], repoDir)`. *(Python uses a bare `subprocess.run` without the identity env here; reusing `runGit` is intentional — the identity env is inert for non-committing git ops, so the output is identical.)*
- `detachHead(worktreePath)` (library): `git rev-parse HEAD` → commit; `git branch --show-current` → branch; `git checkout --detach <commit>`; if branch non-empty, run `runGitAllowFail(['branch','-D',branch], worktreePath)` — Python runs this final delete **unchecked**, so use the non-throwing variant (no empty try/catch).
- `addExistingWorktree(ctx)`: `addWorktree(ctx.workdir, 'existing-feature', siblingPath(ctx.workdir, 'existing-worktree'))`.
- `detachWorktreeHead(ctx)`: `detachHead(siblingPath(ctx.workdir, 'existing-worktree'))`.
- `symlinkSuperpowers(ctx)`: `mkdir -p <workdir>/.agents/skills`; `symlinkSync(join(superpowersRoot,'skills'), join(workdir,'.agents/skills/superpowers'))` — do **not** stat the target first. Read `ctx.superpowersRoot` (throw if undefined).
- `createCallerConsentPlan(ctx)`: write `docs/superpowers/plans/custom-greeting.md` from `CALLER_CONSENT_PLAN` (verbatim from `worktree.py`); `git add docs/superpowers/plans/custom-greeting.md`; commit "add caller consent gate plan".
- `setupPressureWorktreeConditions(ctx)`: `mkdir -p <workdir>/.worktrees`; read `.gitignore` if present — membership test is the **bare substring `'.worktrees'`** (no trailing slash, matching `'.worktrees' not in contents`); if absent, write `content.replace(/\s+$/,'') + '\n.worktrees/\n'` (Python `contents.rstrip() + '\n.worktrees/\n'`); if the file doesn't exist, create it with `'.worktrees/\n'`; `git add .gitignore`; commit "ignore .worktrees/".

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/worktree.ts test/setup-helpers-worktree.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers worktree tier-1 fixtures (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 12: `linkGeminiExtension` (Tier-2, gemini CLI)

**Files:**
- Modify: `src/setup-helpers/worktree.ts`
- Test: extend `test/setup-helpers-worktree.test.ts`
- Reference: `worktree.py:link_gemini_extension`

- [ ] **Step 1: Add the failing test** (fake runner; assert GEMINI.md content + the two gemini calls)

```ts
// add to test/setup-helpers-worktree.test.ts
import { linkGeminiExtension } from '../src/setup-helpers/worktree.ts';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';

class GeminiRunner implements CommandRunner {
  calls: Array<readonly string[]> = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push([command, ...args]);
    return { status: 0, stdout: '', stderr: '' };
  }
}

test('linkGeminiExtension writes GEMINI.md and calls gemini twice', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'sh-gem-'));
  const run = new GeminiRunner();
  try {
    const wd = join(parent, 'wd');
    linkGeminiExtension({
      workdir: wd,
      superpowersRoot: '/sp',
      run,
    } as never);
    expect(await Bun.file(join(wd, 'GEMINI.md')).text()).toContain(
      '@/sp/skills/using-superpowers/SKILL.md',
    );
    expect(run.calls[0]).toEqual(['gemini', 'extensions', 'uninstall', 'superpowers']);
    expect(run.calls[1]?.slice(0, 3)).toEqual(['gemini', 'extensions', 'link']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `linkGeminiExtension(ctx)`.** Read `ctx.superpowersRoot` (throw if undefined). Resolve the extension name to match Python exactly: default `'superpowers'`; **only if** `<root>/gemini-extension.json` exists, `JSON.parse` it inside a try/catch that returns `'superpowers'` on parse failure (Python suppresses `JSONDecodeError` only), then take `parsed.name ?? 'superpowers'` (Python `.get('name', default)`). `ctx.run.run('gemini', ['extensions','uninstall',name])` (status ignored). `ctx.run.run('gemini', ['extensions','link',root], { input: 'y\n' })` (throw if status nonzero). Then `mkdir -p workdir`; write `GEMINI.md`:
```
@<root>/skills/using-superpowers/SKILL.md
@<root>/skills/using-superpowers/references/gemini-tools.md
```
(absolute paths, trailing newline — match `link_gemini_extension`).

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/worktree.ts test/setup-helpers-worktree.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers linkGeminiExtension via CommandRunner (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 13: `codex-app-server.ts` + `installCodexSuperpowersPluginHooks` (Tier-2, hardest)

**Files:**
- Create: `src/setup-helpers/codex-app-server.ts`
- Modify: `src/setup-helpers/worktree.ts`, `src/env.ts` (add a one-line `setProcessEnv(key, value)` writer — `env.ts` is the sanctioned `process.env` boundary)
- Test: `test/setup-helpers-codex.test.ts`
- Reference: `worktree.py:install_codex_superpowers_plugin_hooks` and its helpers (`_ignore_codex_plugin_copy`, `_write_codex_plugin_hooks_config`, `_append_codex_trusted_hook`, `_toml_basic_string`, `_select_codex_superpowers_hook`).

Split the hermetic parts (testable) from the live app-server query (injected/faked).

- [ ] **Step 1: Write the failing test** — copytree-ignore, config.toml shape, TOML escaping, DRILL_CODEX_HOME, with a faked hook query.

```ts
// test/setup-helpers-codex.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { installCodexSuperpowersPluginHooks } from '../src/setup-helpers/worktree.ts';

class CodexRunner implements CommandRunner {
  run(): CommandResult {
    return { status: 0, stdout: '', stderr: '' };
  }
}

function fakeSuperpowers(): string {
  const root = mkdtempSync(join(tmpdir(), 'sh-sp-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'x.md'), 'hi\n');
  mkdirSync(join(root, '.git'), { recursive: true }); // must be IGNORED everywhere
  writeFileSync(join(root, '.git', 'HEAD'), 'ref\n');
  // A nested dir literally named `evals` with a `results/` child: copytree
  // prunes `results` ONLY inside a dir whose basename is `evals`, at any depth.
  mkdirSync(join(root, 'evals', 'results'), { recursive: true });
  writeFileSync(join(root, 'evals', 'results', 'junk.txt'), 'x\n'); // pruned
  writeFileSync(join(root, 'evals', 'keep.txt'), 'y\n'); // copied
  return root;
}

describe('installCodexSuperpowersPluginHooks', () => {
  test('copies plugin (ignore filter), writes config, trusts hook, sets DRILL_CODEX_HOME', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sh-cx-'));
    const sp = fakeSuperpowers();
    const wd = join(parent, 'wd');
    mkdirSync(wd, { recursive: true });
    const captured: Record<string, string> = {}; // capture, not process.env (noProcessEnv)
    try {
      await installCodexSuperpowersPluginHooks(
        { workdir: wd, superpowersRoot: sp, run: new CodexRunner() } as never,
        {
          login: () => {},
          queryHook: async () => ({ key: 'k"1', currentHash: 'h\\2' }),
          setEnv: (k, v) => {
            captured[k] = v;
          },
        },
      );
      const home = join(dirname(wd), `${basename(wd)}-codex-home`);
      const pluginRoot = join(home, 'plugins/cache/debug/superpowers/local');
      expect(existsSync(join(pluginRoot, 'skills/x.md'))).toBe(true);
      expect(existsSync(join(pluginRoot, '.git'))).toBe(false); // ignored everywhere
      expect(existsSync(join(pluginRoot, 'evals/keep.txt'))).toBe(true); // evals/ copied
      expect(existsSync(join(pluginRoot, 'evals/results'))).toBe(false); // results/ pruned in evals/
      const config = await Bun.file(join(home, 'config.toml')).text();
      expect(config).toContain('plugin_hooks = true');
      expect(config).toContain('[plugins."superpowers@debug"]');
      // _toml_basic_string escapes `\`->`\\` then `"`->`\"`. Cover BOTH branches:
      expect(config).toContain('[hooks.state."k\\"1"]'); // quote in key escaped
      expect(config).toContain('trusted_hash = "h\\\\2"'); // backslash in hash escaped
      expect(captured['DRILL_CODEX_HOME']).toBe(home);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(sp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `codex-app-server.ts`** — the async JSON-RPC client. `queryCodexSessionStartHook({ codexHome, workdir }): Promise<{ key: string; currentHash: string }>` spawns `codex app-server --listen stdio://` (env `CODEX_HOME=codexHome`, cwd `workdir`) via `Bun.spawn`. **Strict interleaved handshake, matching `_read_codex_superpowers_hook` exactly:** send `initialize` (id 1, `clientInfo` drill/0.0.0, `capabilities.experimentalApi=true`) as `JSON.stringify(req)+'\n'`, **await the id=1 response**, THEN send `hooks/list` (id 2, `params.cwds=[workdir]`), then await the id=2 response. Do **not** pipeline both writes — the app-server may require `initialize` to be acknowledged before accepting `hooks/list`. Each read drains stdout+stderr line-by-line with a 15s deadline, matching by `id` (reject on timeout or JSON-RPC `error`). Then terminate (SIGTERM → 3s → SIGKILL). Port `_select_codex_superpowers_hook` validation exactly (single `superpowers@debug`/`plugin`/`sessionStart` hook; `startup` in `matcher.split('|')`; `run-hook.cmd` in command; trustStatus ∈ {untrusted,trusted}; non-empty key+currentHash; each failure throws a specific Error).

- [ ] **Step 4: Implement `installCodexSuperpowersPluginHooks(ctx, deps?)`** in `worktree.ts`. Define a concrete deps interface and accept a partial override (the test injects all three). Resolve to a full object once so there are no `??` fallbacks and no exactOptionalPropertyTypes hazard:

```ts
interface CodexDeps {
  login(codexHome: string): void;
  queryHook(a: { codexHome: string; workdir: string }): Promise<{ key: string; currentHash: string }>;
  setEnv(key: string, value: string): void;
}
// inside the function:
const d: CodexDeps = {
  login: (home) => { /* ctx.run.run('codex',['login','--with-api-key'],{ input: <OPENAI_API_KEY>+'\n', env: {…, CODEX_HOME: home} }); throw if the key is missing */ },
  queryHook: queryCodexSessionStartHook,
  setEnv: (k, v) => setProcessEnv(k, v), // the ONE production process.env writer; see note
  ...deps,
};
```

  Steps (isolated-home branch — the CLI never fills `codex_home`). Read `ctx.superpowersRoot` (throw if undefined). Make the function `async`:
  1. `codexHome = siblingPath(workdir, 'codex-home')`; `rm -rf` if exists; `mkdir -p`; `d.login(codexHome)`.
  2. `copyTreeWithIgnore(superpowersRoot, join(codexHome,'plugins/cache/debug/superpowers/local'))` — port `_ignore_codex_plugin_copy` as a **per-directory** predicate invoked during the recursive walk with the directory's absolute path + its entry names (mirrors shutil.copytree's `ignore(src, names)` contract): skip `.git`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.ty`, `.venv`, `__pycache__`, `node_modules` in **every** directory, **plus** `results` **only when `basename(currentDir) === 'evals'`** (at any depth). Do not key on the top-level basename or the full relative path.
  3. Write `config.toml` (the `[features] … [plugins."superpowers@debug"] enabled = true` block, verbatim).
  4. `const hook = await d.queryHook({ codexHome, workdir });`
  5. Append `\n[hooks.state."<escaped key>"]\ntrusted_hash = "<escaped hash>"\n` where escaping is `tomlBasicString` = replace `\` → `\\` then `"` → `\"` (port of `_toml_basic_string`).
  6. `d.setEnv('DRILL_CODEX_HOME', codexHome)`.

  > **`setEnv` / process.env:** the production `setEnv` is the one place this module writes the environment. `env.ts` is the only sanctioned `process.env` reader, but writes (`process.env[k] = v`) aren't covered by `noProcessEnv` reads — still, to keep the rule clean, route the write through a tiny `setProcessEnv(k, v)` helper in `env.ts` (a one-line addition) rather than touching `process.env` here. The unit test injects a capture `setEnv`, so the gate never executes the production writer.

- [ ] **Step 5: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add src/setup-helpers/codex-app-server.ts src/setup-helpers/worktree.ts test/setup-helpers-codex.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers codex plugin-hook install + app-server client (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 14: `registry.ts` — the dispatch table

**Files:**
- Create: `src/setup-helpers/registry.ts`
- Modify: `src/scaffold.ts` (replace the duplicated `KNOWN_HELPERS` literal with `KNOWN_HELPER_NAMES`)
- Test: `test/setup-helpers-registry.test.ts`

- [ ] **Step 1: Write the failing test** — the table has exactly the 36 dispatchable names, and the two library fns are absent.

```ts
// test/setup-helpers-registry.test.ts
import { describe, expect, test } from 'bun:test';
import { KNOWN_HELPER_NAMES, REGISTRY } from '../src/setup-helpers/registry.ts';

describe('registry', () => {
  test('has 36 dispatchable helpers', () => {
    expect(Object.keys(REGISTRY).length).toBe(36);
  });
  test('library-only fns are not dispatchable', () => {
    expect(REGISTRY['add_worktree']).toBeUndefined();
    expect(REGISTRY['detach_head']).toBeUndefined();
  });
  test('KNOWN_HELPER_NAMES has all 38 keys incl. the 2 library names', () => {
    // Validation parity with Python HELPER_REGISTRY (used by `quorum check`).
    expect(KNOWN_HELPER_NAMES.size).toBe(38);
    expect(KNOWN_HELPER_NAMES.has('add_worktree')).toBe(true);
    expect(KNOWN_HELPER_NAMES.has('detach_head')).toBe(true);
    for (const k of Object.keys(REGISTRY)) {
      expect(KNOWN_HELPER_NAMES.has(k)).toBe(true);
    }
  });
  test('declares template/superpowers needs correctly', () => {
    expect(REGISTRY['create_base_repo']?.needsTemplateDir).toBe(true);
    expect(REGISTRY['symlink_superpowers']?.needsSuperpowersRoot).toBe(true);
    expect(REGISTRY['link_gemini_extension']?.needsSuperpowersRoot).toBe(true);
    expect(REGISTRY['install_codex_superpowers_plugin_hooks']?.needsSuperpowersRoot).toBe(
      true,
    );
    expect(REGISTRY['create_cost_clean_repo']?.needsTemplateDir).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `registry.ts`.** Map the 36 snake_case names (exactly as in Python `HELPER_REGISTRY`, **minus** `add_worktree` and `detach_head`) to `{ fn, needsTemplateDir?, needsSuperpowersRoot? }`. Declared needs: `create_base_repo` → `needsTemplateDir`; `symlink_superpowers`, `link_gemini_extension`, `install_codex_superpowers_plugin_hooks` → `needsSuperpowersRoot`. All others: neither.

```ts
// src/setup-helpers/registry.ts (shape)
import type { Helper } from './context.ts';
// …import every helper…

export interface RegistryEntry {
  readonly fn: Helper;
  readonly needsTemplateDir?: boolean;
  readonly needsSuperpowersRoot?: boolean;
}

export const REGISTRY: Record<string, RegistryEntry> = {
  create_base_repo: { fn: createBaseRepoHelper, needsTemplateDir: true },
  record_head: { fn: (c) => recordHead(c.workdir) },
  symlink_superpowers: { fn: symlinkSuperpowers, needsSuperpowersRoot: true },
  // … all 36 …
};

// The full Python HELPER_REGISTRY key set (38) — the 36 dispatchable plus the
// two library-only names. This is the validation set `quorum check` uses, so it
// must match Python's keys exactly (which include add_worktree/detach_head).
export const KNOWN_HELPER_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(REGISTRY),
  'add_worktree',
  'detach_head',
]);
```

> `createBaseRepo`/`recordHead` have non-`HelperContext` signatures; wrap them as thin `Helper` adapters here (e.g. `createBaseRepoHelper = (c) => { if (c.templateDir === undefined) throw …; createBaseRepo(c.workdir, c.templateDir); }`).
>
> **Deliberate error-message collapse:** Python's CLI gives a distinct "`<name>` is not a workdir-style helper" error for `add_worktree`/`detach_head` (registered but non-`workdir` first param). Here they're simply absent from `REGISTRY`, so the CLI returns the generic "unknown helper" error instead. This is safe — both are library-only and **no scenario dispatches them** (verified) — and is documented intent, not a defect.

- [ ] **Step 3b: Rewire `src/scaffold.ts` off its duplicated helper list.** `scaffold.ts` currently hardcodes a `KNOWN_HELPERS` set with a `keep-in-sync-until-Spec-6` TODO. Replace that literal `Set` with `import { KNOWN_HELPER_NAMES } from './setup-helpers/registry.ts';` and use it in `validateScenario` (rename the local usage). This removes the duplication the in-code comment asked to remove and keeps `quorum check` validating against the same 38 names. Add an assertion to an existing scaffold/check test (or the registry test) that a known helper name (e.g. `create_base_repo`) is accepted and a bogus one is rejected, confirming the wiring.

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/registry.ts src/scaffold.ts test/setup-helpers-registry.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers dispatch registry (36) + rewire scaffold.ts (PRI-2220)

KNOWN_HELPER_NAMES (38) becomes the single source for `quorum check`,
removing scaffold.ts's keep-in-sync-until-Spec-6 duplication.

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 15: `cli.ts` — `setup-helpers run <helper> …`

**Files:**
- Create: `src/setup-helpers/cli.ts`
- Test: `test/setup-helpers-cli.test.ts`
- Reference: `setup_helpers/cli.py`

- [ ] **Step 1: Write the failing test** — exercises dispatch, env fills, and the error messages.

```ts
// test/setup-helpers-cli.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { runHelpers } from '../src/setup-helpers/cli.ts';
import { repoRoot } from '../src/paths.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-cli-'));
}

describe('runHelpers', () => {
  test('chains create_base_repo + create_caller_consent_plan', async () => {
    const dir = tmp();
    try {
      await runHelpers(['create_base_repo', 'create_caller_consent_plan'], {
        workdir: dir,
        repoRoot: repoRoot(),
        superpowersRoot: undefined,
      });
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe(
        'add caller consent gate plan',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unknown helper throws with the known list', async () => {
    const dir = tmp();
    try {
      await expect(
        runHelpers(['nope'], { workdir: dir, repoRoot: repoRoot(), superpowersRoot: undefined }),
      ).rejects.toThrow(/unknown helper/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a needsSuperpowersRoot helper throws when root is missing', async () => {
    const dir = tmp();
    try {
      await expect(
        runHelpers(['symlink_superpowers'], {
          workdir: dir,
          repoRoot: repoRoot(),
          superpowersRoot: undefined,
        }),
      ).rejects.toThrow(/SUPERPOWERS_ROOT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement `cli.ts`.** Export `runHelpers(names, env)` where `env = { workdir, repoRoot, superpowersRoot }` (testable seam; the real `main` reads them from `env.ts`/`process.env` via `getEnv`). For each name: look up `REGISTRY[name]` (throw `unknown helper '<name>'; known: <sorted>` on miss); build `templateDir = needsTemplateDir ? join(repoRoot,'fixtures','template-repo') : undefined` (throw if `repoRoot` missing → matches the `QUORUM_REPO_ROOT` Python error); `superpowersRoot = needsSuperpowersRoot ? (env.superpowersRoot ?? throw 'SUPERPOWERS_ROOT …') : undefined`; `await entry.fn({ workdir, templateDir, superpowersRoot, run: defaultCommandRunner })`.

  **Exit codes (mirror `sys.exit(main())`):** add a `main()` that parses `process.argv`. On a usage error (`argv[0] !== 'run'` or no helper names) print usage to stderr and `process.exit(2)`. Read `QUORUM_WORKDIR`/`QUORUM_REPO_ROOT`/`SUPERPOWERS_ROOT` via `getEnv` (so `SUPERPOWERS_ROOT` is taken from the **inherited** environment — the runner injects only `QUORUM_REPO_ROOT` via `envExtra`; `SUPERPOWERS_ROOT` rides `envSnapshot()`); a missing `QUORUM_WORKDIR` is a `process.exit(1)` with the Python message. `await runHelpers(...)`; on rejection print the error and `process.exit(1)`; on success `process.exit(0)`. Guard the `main()` call with `if (import.meta.main)`. The `bin-ts/setup-helpers` shim's `exec bun run` inherits this exit code, preserving the Python CLI's 2-vs-1 distinction.

- [ ] **Step 4: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/cli.ts test/setup-helpers-cli.test.ts
git commit -F - <<'EOF'
feat(quorum-ts): setup-helpers CLI dispatch entrypoint (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 16: `bin-ts/setup-helpers` shim + runner PATH prepend

**Files:**
- Create: `bin-ts/setup-helpers` (executable)
- Modify: `src/setup-step.ts`
- Test: `test/setup-helpers-shim.test.ts`
- Reference: `src/checks/index.ts` (the `PATH: ${quorumBin}:${path}` precedent)

- [ ] **Step 1: Create the shim** `bin-ts/setup-helpers`:

```bash
#!/usr/bin/env bash
# Resolve setup-helpers to the TS implementation. Repo root is one dir up
# from bin-ts/. `exec` so signals propagate.
here="$(cd "$(dirname "$0")/.." && pwd)"
exec bun run "$here/src/setup-helpers/cli.ts" "$@"
```
`chmod +x bin-ts/setup-helpers`.

- [ ] **Step 2: Write the failing test** — `runSetup` prepends `bin-ts/` so a `setup.sh` calling bare `setup-helpers` hits the TS impl.

```ts
// test/setup-helpers-shim.test.ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { runSetup } from '../src/setup-step.ts';

describe('bin-ts shim via runSetup', () => {
  test('bare `setup-helpers` resolves to the TS impl', () => {
    const scenarioDir = mkdtempSync(join(tmpdir(), 'sh-scn-'));
    const workdir = mkdtempSync(join(tmpdir(), 'sh-work-'));
    try {
      writeFileSync(
        join(scenarioDir, 'setup.sh'),
        '#!/usr/bin/env bash\nset -euo pipefail\nsetup-helpers run create_cost_clean_repo\n',
      );
      chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
      runSetup(scenarioDir, workdir, { QUORUM_REPO_ROOT: process.cwd() });
      expect(runGit(['log', '--format=%s'], workdir).trim()).toBe('initial: README');
    } finally {
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('shim propagates CLI exit codes (2 usage, 1 error)', () => {
    const shim = join(process.cwd(), 'bin-ts', 'setup-helpers');
    const workdir = mkdtempSync(join(tmpdir(), 'sh-ec-'));
    try {
      const env = { ...process.env, QUORUM_WORKDIR: workdir, QUORUM_REPO_ROOT: process.cwd() };
      // Usage error: missing `run` subcommand -> exit 2.
      expect(spawnSync(shim, [], { env, encoding: 'utf8' }).status).toBe(2);
      // Unknown helper -> exit 1.
      expect(spawnSync(shim, ['run', 'nope'], { env, encoding: 'utf8' }).status).toBe(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (bare `setup-helpers` not on PATH).

- [ ] **Step 4: Modify `runSetup`** in `src/setup-step.ts` to prepend the repo's `bin-ts/` to `PATH`. `setup-step.ts` **already imports** `join` (from `node:path`) and `envSnapshot` (from `./env.ts`) — do NOT re-import them (a duplicate import fails the gate). Add only `import { repoRoot } from './paths.ts';` and `getEnv` to the existing `./env.ts` import, then weave `PATH` into the existing env object:

```ts
// existing imports already include join, envSnapshot; ADD:
import { getEnv } from './env.ts'; // (merge into the existing ./env.ts import)
import { repoRoot } from './paths.ts';
// …inside runSetup, replace the env object:
const proc = spawnSync(script, [], {
  cwd: workdir,
  env: {
    ...envSnapshot(),
    PATH: `${join(repoRoot(), 'bin-ts')}:${getEnv('PATH') ?? ''}`,
    QUORUM_WORKDIR: workdir,
    ...envExtra,
  },
  encoding: 'utf8',
});
```

> The bin-ts shim's child (`cli.ts`) reads `QUORUM_REPO_ROOT` (injected by the runner via `envExtra`) and `SUPERPOWERS_ROOT` (**inherited** from this `envSnapshot()`, not injected). The `exec bun run` shim inherits `cli.ts`'s exit code, so the Python CLI's 2-vs-1 exit semantics survive.

- [ ] **Step 4b: Allow `process.env` in the shim test.** `biome.json`'s `noProcessEnv` is `error` and the `test/**` override does **not** disable it (only an explicit allow-list does). Add `test/setup-helpers-shim.test.ts` to the existing `noProcessEnv: off` override `includes` list (alongside `test/cli-run.test.ts` etc.), since the shim exit-code test spreads `process.env` into the child env.

- [ ] **Step 5: Run the test — expect PASS.** `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add bin-ts/setup-helpers src/setup-step.ts test/setup-helpers-shim.test.ts biome.json
git commit -F - <<'EOF'
feat(quorum-ts): bin-ts/setup-helpers shim + runner PATH prepend (PRI-2220)

So setup.sh's bare `setup-helpers run` resolves to the TS impl under
`bun run quorum`; Python keeps answering under `uv run quorum`.

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 17: Flip the 50 scenario `setup.sh` to bare `setup-helpers`

**Files:**
- Modify: every `scenarios/*/setup.sh` containing `uv run setup-helpers`

- [ ] **Step 1: Rewrite the invocation** in all 50 files: `uv run setup-helpers run` → `setup-helpers run`. Use a scripted, reviewable edit:

```bash
grep -rl 'uv run setup-helpers' scenarios/*/setup.sh \
  | xargs sed -i '' -e 's/uv run setup-helpers run/setup-helpers run/g'
```
(macOS `sed -i ''`; on Linux use `sed -i`.)

- [ ] **Step 2: Verify** none remain and the count of converted lines is right:

```bash
grep -rc 'uv run setup-helpers' scenarios/*/setup.sh | grep -v ':0' || echo "none remain"
grep -rl 'setup-helpers run' scenarios/*/setup.sh | wc -l   # expect 50
```

- [ ] **Step 3: Smoke one converted scenario end-to-end under the TS runner** (pick a hermetic one, e.g. `cost-clean-repo`): run its `setup.sh` via `runSetup` (a tiny `bun -e` or an existing runner path) and confirm the fixture builds. Confirms the shim + edit work together.

- [ ] **Step 4: `bun run check`** (no TS changed, but keep the gate ritual), then **Commit**

```bash
git add scenarios
git commit -F - <<'EOF'
refactor(quorum-ts): scenario setup.sh -> runner-agnostic `setup-helpers run` (PRI-2220)

Drop the `uv run` prefix so each runner resolves its own setup-helpers
(TS under bun, Python under uv). End-state form; unchanged by the purge.

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 18: Transitional differential harness (throwaway)

**Files:**
- Create: `test/setup-helpers-differential.test.ts`
- Modify: `biome.json` (add the differential test to the `noProcessEnv: off` list)
- Reference: the Python `setup-helpers` CLI (`uv run setup-helpers run <name>`)

This is the throwaway oracle: for each hermetic helper, run Python and TS into separate temp dirs and diff fixture trees + git-log subjects. Skipped when Python isn't available; deleted in the purge PR.

- [ ] **Step 1: Implement the harness.** A helper `buildBoth(name)` that:
  - Python: `spawnSync('uv', ['run','setup-helpers','run',name], { cwd: repoRoot(), env: {…, QUORUM_WORKDIR: tmpA, QUORUM_REPO_ROOT: repoRoot(), SUPERPOWERS_ROOT: superpowersRoot()} })`.
  - TS: `await runHelpers([name], { workdir: tmpB, repoRoot: repoRoot(), superpowersRoot: superpowersRoot() })`.
  - Compare: recursive file list + bytes under each workdir **excluding `.git/`**; and `git log --format=%s --reverse` for each. Assert equal. Skip the test (`test.skipIf`) when `uv`/the Python package is absent.
  - Run over the **hermetic** dispatchable names only (exclude the 5 Tier-2 + `create_base_repo` if template parity is environment-sensitive — include it if the template repo is present). Include `create_cost_large_files` explicitly (byte-diff at least `src/users.js`).

```ts
// test/setup-helpers-differential.test.ts (shape)
import { describe, expect, test } from 'bun:test';
// …mkdtemp, walk, runGit, runHelpers, repoRoot, superpowersRoot…

const HERMETIC: readonly string[] = [
  'create_cost_checkbox_page',
  'create_cost_clean_repo',
  'create_cost_large_files',
  'create_cost_trivial_plan',
  'create_writing_plans_skeleton',
  'create_code_review_planted_bugs',
  'create_spec_writing_blind_spot',
  'create_spec_targets_wrong_component',
  'create_spec_targets_wrong_component_with_checkpoint',
  'scaffold_sdd_go_fractals',
  'scaffold_sdd_broken_plan',
  'scaffold_sdd_quality_defect_plan',
  'scaffold_sdd_yagni_plan',
  // …the rest of the fixture-reading scaffolds…
];

// Harden against uv's own error codes (uv-missing -> status null; uv-error
// also returns 2). Require the REAL Python console script to have run by
// matching its 'unknown helper' message on a bogus name.
function pythonAvailable(): boolean {
  const probe = spawnSync('uv', ['run', 'setup-helpers', 'run', '__nonexistent__'], {
    encoding: 'utf8',
  });
  if (probe.status === null) {
    return false; // uv not on PATH
  }
  return probe.status !== 0 && (probe.stderr ?? '').includes('unknown helper');
}

describe('differential parity (transitional)', () => {
  for (const name of HERMETIC) {
    test.skipIf(!pythonAvailable())(`${name}: TS tree == Python tree`, async () => {
      // build both, walk + diff non-.git files, diff git-log subjects
    });
  }
});
```

> **Notes:** (1) `fixtures/template-repo` has **no `.git`**, so `create_base_repo` deterministically takes the init+3-commit branch (the clone branch is unreachable here) — safe to include in the differential. (2) This test spreads `process.env` into the Python subprocess env, so add `test/setup-helpers-differential.test.ts` to `biome.json`'s `noProcessEnv: off` override list.

- [ ] **Step 2: Run it** (`bun test test/setup-helpers-differential.test.ts`) where Python is available — expect PASS (this surfaces any byte drift, especially the `\n` and `${id}` gotchas and the generator whitespace). Fix any mismatch in the corresponding helper, re-run.

- [ ] **Step 3: Commit**

```bash
git add test/setup-helpers-differential.test.ts biome.json
git commit -F - <<'EOF'
test(quorum-ts): transitional Python<->TS differential parity harness (PRI-2220)

Throwaway oracle for the duplication window; deleted in the purge PR.

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Task 19: Docs + final gate

**Files:**
- Modify: `CLAUDE.md` (Architecture section)

- [ ] **Step 1: Add a `src/setup-helpers/` architecture bullet** to `CLAUDE.md` near the existing `src/dashboard/` entry, naming the module layout, the `HelperContext` dispatch, the Tier-1/Tier-2 split, and the `bin-ts/setup-helpers` shim + `setup.sh` runner-agnostic invocation. Note that Python `setup_helpers/` remains until the purge PR.

- [ ] **Step 2: Full gate**

```bash
bun run check
```
Expected: Biome clean, tsc clean, all tests pass (new `setup-helpers-*` suites green; differential suite green where Python is present, else skipped).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -F - <<'EOF'
docs(quorum-ts): CLAUDE.md src/setup-helpers architecture entry (PRI-2220)

Co-Authored-By: Scotty@2a8a33ad (Opus 4.8 (1M context))
EOF
```

---

## Self-review notes (coverage map)

- **Vertical split / runner-agnostic setup.sh** → Tasks 16 (shim + PATH), 17 (the 50 edits).
- **HelperContext dispatch replacing introspection** → Tasks 2 (types), 14 (registry + declared needs), 15 (CLI fills).
- **Tier-1 hermetic helpers (31)** → Tasks 3, 5–11.
- **Tier-2 via CommandRunner seam (5)** → Tasks 4 (provisionVenv), 12 (gemini), 13 (codex).
- **Shared Pulse Dashboard constants** → Task 5, consumed in Task 6.
- **Every gotcha:** git identity env spread-order (Task 1); `git init -b main` (every init helper); no-init layered helpers — `add_flawed_spec_for_review` (6), `add_sdd_auth_plan` (7), `add_stub_executing_plan` (10), `create_caller_consent_plan`/`setup_pressure_worktree_conditions` (11); literal `\n` (Task 7); generated `${id}` (Task 8); db.js-written-twice (Task 9); append-never-amend checkpoint (Task 6); copytree ignore incl. `results`-in-`evals` + TOML escaping + DRILL_CODEX_HOME (Task 13); `git branch -D` unchecked (Task 11).
- **Parity (lasting unit + throwaway differential)** → per-module unit tests in every task + Task 18.
- **Out of scope (purge)** → not in this plan, by design.

## Hardening folded in from BobReview (PRI-2220)

A 6-lens adversarial review (3 blockers, 12 majors, 20 minors, 12 nits) was applied to this plan:

- **Blockers (Task 8):** the `cost_large_files` generator sketch was transcribed exactly from `_render_module` (the `// Lookup`/`// Persist` comments, `record` naming, multi-line throw with literal `${id}`, save-block `return`); the tautological substring test was replaced with a **lasting byte-exact entity-#1 block assertion** so byte parity survives the purge (not just the throwaway differential).
- **`git add` scope** (Tasks 6, 8): stated per-helper from source — dashboard/large/trivial use `-A`; checkbox→`index.html`, clean→`README.md`; scoped adds reserved for checkpoint/layered helpers. Removed the misleading "scoped per Python" phrasing.
- **Tests:** every un-awaited `.resolves` made awaited (floating-promise false-greens + Biome `noFloatingPromises`); added missing `scaffoldSddQualityDefectPlan` test and phantom/pushback commit-message assertions (those Tier-2 helpers are excluded from the differential).
- **Codex (Task 13):** interleaved JSON-RPC handshake (not pipelined); per-directory copytree predicate with the `results`-in-`evals` case tested via a nested fixture; concrete `CodexDeps` interface (removes the dead `??` + exactOptionalPropertyTypes hazard); capture-object `setEnv` (biome `noProcessEnv`) + `setProcessEnv` in `env.ts`; both TOML escape branches asserted.
- **`provisionVenv` (Task 4):** uv detection via non-spawning `Bun.which` (mirrors `shutil.which`, no recorded call); `python3`-vs-`sys.executable` flagged as an intentional, parity-irrelevant divergence.
- **CLI/wiring:** `main()` exit codes mirror `sys.exit(main())` (shim propagates); `SUPERPOWERS_ROOT` documented as inherited, not injected; `runSetup` snippet avoids the duplicate `join` import and uses `getEnv('PATH')`; `pythonAvailable()` hardened against uv's own error codes; `scaffold.ts` rewired off its duplicated `KNOWN_HELPERS` onto `KNOWN_HELPER_NAMES` (38).
- **Constants (Task 5):** named the `${`-bearing Pulse Dashboard constants and required escaped template literals (not illegal single-quoted multiline / `noTemplateCurlyInString`-tripping strings), locked by a Task-6 literal-`${this.baseUrl}` assertion.
