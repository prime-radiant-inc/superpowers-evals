# Scenario-local Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move each scenario's on-disk fixtures into the scenario's own directory, read by a single generic `init_repo_from_fixtures` helper, so adding a fixture-based scenario needs zero TypeScript.

**Architecture:** Add one more "declared need" (`needsScenarioDir`, fed by a new `QUORUM_SCENARIO_DIR` env var) mirroring the existing `needsTemplateDir`/`QUORUM_REPO_ROOT` pattern. A generic `initRepoFromFixtures(workdir, fixturesDir)` git-inits a repo and mirrors the scenario's `fixtures/` tree into it. The four bespoke `scaffoldSdd*` file-reading helpers and the shared `FIXTURES_DIR` constant are deleted; the shared `fixtures/template-repo` stays put.

**Tech Stack:** TypeScript on Bun (≥1.3), biome (lint/format), `bun test`, Node `fs`/`child_process`, git.

## Global Constraints

- `bun run check` (biome + tsc + `bun test`) must pass and be **pristine** — no stray error output.
- `bun run quorum check` (scenario validation) must pass.
- Match surrounding code style; biome owns formatting (`bun run format`). Do not hand-edit whitespace.
- Git fixtures commit under the Drill identity: `user.email=drill@test.local`, `user.name=Drill Test`.
- Do **not** touch `fixtures/template-repo/` — it is the shared base-repo template, not per-scenario.
- The generic helper's seed commit message is `seed scenario fixtures`. No check asserts a seed commit message; the SDD scenarios' `commits gte 4` post-check is about the agent's later work and is unaffected.
- This is a refactor of existing behavior: every migrated scenario must still land a clean `main` with `design.md` + `plan.md` at the workdir root (the `pre()` `file-exists` checks).

---

### Task 1: Generic `initRepoFromFixtures` helper (pure function)

Adds the seed-from-a-fixtures-tree function next to `createBaseRepo` (its shared-template counterpart). No dispatch wiring yet — proven by unit tests alone.

**Files:**
- Modify: `src/setup-helpers/base.ts` (add `cpSync` to the `node:fs` import; add the function)
- Test: `test/setup-helpers-base.test.ts`

**Interfaces:**
- Produces: `initRepoFromFixtures(workdir: string, fixturesDir: string): void` — git-inits `workdir` on `main`, mirrors the entire `fixturesDir` tree in, makes one `seed scenario fixtures` commit. Throws if `fixturesDir` does not exist.

- [ ] **Step 1: Write the failing tests**

Append to `test/setup-helpers-base.test.ts`. First add `mkdirSync` and `writeFileSync` to the `node:fs` import and `initRepoFromFixtures` to the base import:

```typescript
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createBaseRepo,
  initRepoFromFixtures,
  recordHead,
} from '../src/setup-helpers/base.ts';
```

Then add this block at the end of the file:

```typescript
describe('initRepoFromFixtures', () => {
  test('mirrors the fixtures tree into the workdir with one commit on main', () => {
    const scenario = tmp();
    const work = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'design.md'), 'DESIGN\n');
      writeFileSync(join(fixtures, 'plan.md'), 'PLAN\n');

      initRepoFromFixtures(work, fixtures);

      expect(existsSync(join(work, 'design.md'))).toBe(true);
      expect(existsSync(join(work, 'plan.md'))).toBe(true);
      expect(runGit(['log', '--format=%s'], work).trim()).toBe(
        'seed scenario fixtures',
      );
      expect(runGit(['rev-list', '--count', 'HEAD'], work).trim()).toBe('1');
      expect(runGit(['branch', '--show-current'], work).trim()).toBe('main');
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('copies nested subdirectories verbatim', () => {
    const scenario = tmp();
    const work = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(join(fixtures, 'docs', 'superpowers', 'plans'), {
        recursive: true,
      });
      writeFileSync(join(fixtures, 'package.json'), '{"name":"x"}\n');
      writeFileSync(
        join(fixtures, 'docs', 'superpowers', 'plans', 'p.md'),
        'PLAN\n',
      );

      initRepoFromFixtures(work, fixtures);

      expect(existsSync(join(work, 'package.json'))).toBe(true);
      expect(
        existsSync(join(work, 'docs', 'superpowers', 'plans', 'p.md')),
      ).toBe(true);
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('creates the workdir when it does not exist', () => {
    const scenario = tmp();
    const base = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'design.md'), 'D\n');
      const missing = join(base, 'nested', 'workdir');

      initRepoFromFixtures(missing, fixtures);

      expect(runGit(['rev-parse', 'HEAD'], missing).trim().length).toBe(40);
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws when the fixtures dir is missing', () => {
    const work = tmp();
    try {
      expect(() => initRepoFromFixtures(work, join(work, 'nope'))).toThrow(
        /fixtures dir not found/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/setup-helpers-base.test.ts`
Expected: FAIL — `initRepoFromFixtures` is not exported (import/type error).

- [ ] **Step 3: Implement the function**

In `src/setup-helpers/base.ts`, add `cpSync` to the `node:fs` import:

```typescript
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
```

Add this function directly after `createBaseRepo` (after its closing brace, before `recordHead`):

```typescript
// Seeds a fresh repo from a per-scenario fixtures directory: git init on `main`
// under the Drill identity, mirror the entire fixtures tree into the workdir,
// and make a single commit. The per-scenario counterpart to createBaseRepo,
// which seeds from the shared template-repo. Throws when fixturesDir is absent
// so a mis-wired scenario fails loudly instead of committing an empty repo.
export function initRepoFromFixtures(
  workdir: string,
  fixturesDir: string,
): void {
  if (!existsSync(fixturesDir)) {
    throw new Error(
      `init_repo_from_fixtures: fixtures dir not found: ${fixturesDir}`,
    );
  }
  mkdirSync(workdir, { recursive: true });
  runGit(['init', '-b', 'main'], workdir);
  runGit(['config', 'user.email', 'drill@test.local'], workdir);
  runGit(['config', 'user.name', 'Drill Test'], workdir);
  cpSync(fixturesDir, workdir, { recursive: true });
  runGit(['add', '-A'], workdir);
  runGit(['commit', '-m', 'seed scenario fixtures'], workdir);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/setup-helpers-base.test.ts`
Expected: PASS (all `initRepoFromFixtures` tests plus the existing `createBaseRepo`/`recordHead` tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/base.ts test/setup-helpers-base.test.ts
git commit -m "feat(setup-helpers): add generic initRepoFromFixtures"
```

---

### Task 2: Plumb `QUORUM_SCENARIO_DIR` and register the helper

Additive: wires the new helper into the `setup-helpers run` DSL via a `needsScenarioDir` declared need. The four old helpers still exist; nothing is migrated yet.

**Files:**
- Modify: `src/setup-helpers/context.ts` (add `scenarioDir` to `HelperContext`)
- Modify: `src/setup-helpers/registry.ts` (import `join` + `initRepoFromFixtures`; add `needsScenarioDir` to `RegistryEntry`; add wrapper + REGISTRY entry)
- Modify: `src/setup-helpers/cli.ts` (add `scenarioDir` to `HelperEnv`; fill+guard in `runHelpers`; read env in `main`)
- Modify: `src/setup-step.ts` (forward `QUORUM_SCENARIO_DIR`)
- Test: `test/setup-helpers-cli.test.ts`, `test/setup-helpers-registry.test.ts`

**Interfaces:**
- Consumes: `initRepoFromFixtures` (Task 1).
- Produces: registry name `init_repo_from_fixtures` (`needsScenarioDir: true`); `HelperContext.scenarioDir: string | undefined`; `HelperEnv.scenarioDir: string | undefined`. `runHelpers` throws `setup-helpers: QUORUM_SCENARIO_DIR is not set` when a `needsScenarioDir` helper runs without it.

- [ ] **Step 1: Write the failing dispatch tests**

In `test/setup-helpers-cli.test.ts`, add `mkdirSync`/`writeFileSync` to the `node:fs` import:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
```

Add `scenarioDir: undefined` to each of the three existing `runHelpers` call sites (they pass `workdir`/`repoRoot`/`superpowersRoot` today). Then add two tests inside the `describe('runHelpers', ...)` block:

```typescript
  test('init_repo_from_fixtures throws when QUORUM_SCENARIO_DIR is missing', async () => {
    const dir = tmp();
    try {
      await expect(
        runHelpers(['init_repo_from_fixtures'], {
          workdir: dir,
          repoRoot: repoRoot(),
          superpowersRoot: undefined,
          scenarioDir: undefined,
        }),
      ).rejects.toThrow(/QUORUM_SCENARIO_DIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('init_repo_from_fixtures seeds the workdir from the scenario fixtures dir', async () => {
    const scenario = tmp();
    const work = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'plan.md'), 'PLAN\n');

      await runHelpers(['init_repo_from_fixtures'], {
        workdir: work,
        repoRoot: repoRoot(),
        superpowersRoot: undefined,
        scenarioDir: scenario,
      });

      expect(runGit(['show', 'HEAD:plan.md'], work)).toContain('PLAN');
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/setup-helpers-cli.test.ts`
Expected: FAIL — `scenarioDir` is not a valid `HelperEnv` key (type error) and `init_repo_from_fixtures` is an unknown helper.

- [ ] **Step 3: Add `scenarioDir` to `HelperContext`**

In `src/setup-helpers/context.ts`, add the field (and note it in the comment):

```typescript
export interface HelperContext {
  readonly workdir: string;
  readonly templateDir: string | undefined;
  readonly superpowersRoot: string | undefined;
  readonly scenarioDir: string | undefined;
  readonly run: CommandRunner;
}
```

Update the leading comment's parenthetical to include `scenarioDir`:

```typescript
// The uniform argument every dispatchable helper receives. Replaces Python's
// signature-introspection: templateDir/superpowersRoot/scenarioDir are filled by
// the CLI ONLY for helpers whose registry entry declares the need, and are
// undefined otherwise. `run` is the subprocess seam for Tier-2 helpers.
```

- [ ] **Step 4: Register the helper**

In `src/setup-helpers/registry.ts`:

Add a `node:path` import at the top of the import block:

```typescript
import { join } from 'node:path';
```

Add `initRepoFromFixtures` to the base import:

```typescript
import { createBaseRepo, initRepoFromFixtures, recordHead } from './base.ts';
```

Add the declared-need field to `RegistryEntry`:

```typescript
export interface RegistryEntry {
  readonly fn: Helper;
  readonly needsTemplateDir?: boolean;
  readonly needsSuperpowersRoot?: boolean;
  readonly needsScenarioDir?: boolean;
}
```

Add a wrapper next to `createBaseRepoHelper` (mirrors its undefined-guard):

```typescript
// scenarioDir is filled by runHelpers for needsScenarioDir helpers; the guard is
// parity with createBaseRepoHelper's templateDir check.
const initRepoFromFixturesHelper: Helper = (c: HelperContext): void => {
  if (c.scenarioDir === undefined) {
    throw new Error('scenarioDir is required for init_repo_from_fixtures');
  }
  initRepoFromFixtures(c.workdir, join(c.scenarioDir, 'fixtures'));
};
```

Add the REGISTRY entry (place it next to `create_base_repo`):

```typescript
  init_repo_from_fixtures: {
    fn: initRepoFromFixturesHelper,
    needsScenarioDir: true,
  },
```

- [ ] **Step 5: Fill and guard `scenarioDir` in the CLI**

In `src/setup-helpers/cli.ts`, add the field to `HelperEnv`:

```typescript
export interface HelperEnv {
  readonly workdir: string;
  readonly repoRoot: string | undefined;
  readonly superpowersRoot: string | undefined;
  readonly scenarioDir: string | undefined;
}
```

In `runHelpers`, after the `superpowersRoot` block and before the `entry.fn({...})` call, add:

```typescript
    let scenarioDir: string | undefined;
    if (entry.needsScenarioDir === true) {
      if (
        helperEnv.scenarioDir === undefined ||
        helperEnv.scenarioDir === ''
      ) {
        throw new Error('setup-helpers: QUORUM_SCENARIO_DIR is not set');
      }
      scenarioDir = helperEnv.scenarioDir;
    }
```

Add `scenarioDir,` to the `entry.fn({...})` context object:

```typescript
    await entry.fn({
      workdir: helperEnv.workdir,
      templateDir,
      superpowersRoot,
      scenarioDir,
      run: defaultCommandRunner,
    });
```

In `main()`, add the env read to the `runHelpers` call:

```typescript
    await runHelpers(argv.slice(1), {
      workdir,
      repoRoot: getEnv('QUORUM_REPO_ROOT'),
      superpowersRoot: getEnv('SUPERPOWERS_ROOT'),
      scenarioDir: getEnv('QUORUM_SCENARIO_DIR'),
    });
```

- [ ] **Step 6: Forward `QUORUM_SCENARIO_DIR` from the runner**

In `src/setup-step.ts`, add the var to the `spawnSync` `env` object (next to `QUORUM_WORKDIR`):

```typescript
    env: {
      ...envSnapshot(),
      BASH_ENV: prelude,
      QUORUM_REPO_ROOT: root,
      QUORUM_WORKDIR: workdir,
      QUORUM_SCENARIO_DIR: scenarioDir,
      ...envExtra,
    },
```

- [ ] **Step 7: Add the registry declared-need assertion**

In `test/setup-helpers-registry.test.ts`, inside the existing declared-needs test (next to the `create_base_repo`/`symlink_superpowers` assertions), add:

```typescript
    expect(REGISTRY['init_repo_from_fixtures']?.needsScenarioDir).toBe(true);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/setup-helpers-cli.test.ts test/setup-helpers-registry.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add src/setup-helpers/context.ts src/setup-helpers/registry.ts src/setup-helpers/cli.ts src/setup-step.ts test/setup-helpers-cli.test.ts test/setup-helpers-registry.test.ts
git commit -m "feat(setup-helpers): plumb QUORUM_SCENARIO_DIR + register init_repo_from_fixtures"
```

---

### Task 3: Migrate the 4 SDD scenarios; delete the old helpers

Cutover. Moves the fixtures into the scenario dirs, points each `setup.sh` at the generic helper, and removes the four `scaffoldSdd*` functions, their registry entries, and `FIXTURES_DIR`.

**Files:**
- Move: `fixtures/sdd-*/` → `scenarios/sdd-*/fixtures/` (4 dirs)
- Modify: 4 × `scenarios/sdd-*/setup.sh`
- Modify: `src/setup-helpers/sdd-fixtures.ts` (remove `FIXTURES_DIR`, `scaffoldFromFixture`, the 4 functions, now-unused imports)
- Modify: `src/setup-helpers/registry.ts` (remove the 4 imports + 4 entries; de-numberize the header comment)
- Test: `test/setup-helpers-sdd.test.ts` (drop the go-fractals test + the go-fractals case)

**Interfaces:**
- Consumes: `init_repo_from_fixtures` (Task 2).
- Removes: `scaffoldSddGoFractalsGpt55`, `scaffoldSddGoFractalsOpus48`, `scaffoldSddSvelteTodo`, `scaffoldSddSvelteTodoOpus48`, `scaffoldFromFixture`, `FIXTURES_DIR`, and registry names `scaffold_sdd_go_fractals_gpt55`, `scaffold_sdd_go_fractals_opus48`, `scaffold_sdd_svelte_todo`, `scaffold_sdd_svelte_todo_opus48`.

- [ ] **Step 1: Move the four fixture dirs into their scenarios**

```bash
git mv fixtures/sdd-go-fractals-gpt55 scenarios/sdd-go-fractals-gpt55/fixtures
git mv fixtures/sdd-go-fractals-opus48 scenarios/sdd-go-fractals-opus48/fixtures
git mv fixtures/sdd-svelte-todo scenarios/sdd-svelte-todo/fixtures
git mv fixtures/sdd-svelte-todo-opus48 scenarios/sdd-svelte-todo-opus48/fixtures
```

Verify `fixtures/` now holds only `template-repo`:

Run: `ls fixtures/`
Expected: `template-repo`

- [ ] **Step 2: Point each scenario's setup.sh at the generic helper**

Set the body of all four files — `scenarios/sdd-go-fractals-gpt55/setup.sh`, `scenarios/sdd-go-fractals-opus48/setup.sh`, `scenarios/sdd-svelte-todo/setup.sh`, `scenarios/sdd-svelte-todo-opus48/setup.sh` — to exactly:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run init_repo_from_fixtures
```

Keep the executable bit (these files are already `0755`; editing in place preserves it — confirm in Step 6).

- [ ] **Step 3: Remove the dead code from `sdd-fixtures.ts`**

In `src/setup-helpers/sdd-fixtures.ts`:

Replace the import block (drop `copyFileSync`, `join`, `repoRoot`, which were only used by the deleted code):

```typescript
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';
```

Delete the `FIXTURES_DIR` constant (line 14), the entire `scaffoldFromFixture` function, and the four exported functions `scaffoldSddGoFractalsGpt55`, `scaffoldSddGoFractalsOpus48`, `scaffoldSddSvelteTodo`, `scaffoldSddSvelteTodoOpus48` (the block through the `scaffoldSddSvelteTodoOpus48` closing brace, immediately before the `AUTH_PLAN_BODY` constant).

Replace the file's top-of-file comment (lines 1–6) so it no longer references the removed fixture-reading helpers:

```typescript
// SDD-fixture helpers. Five embedded-body helpers (auth/broken/quality/yagni/
// spec-constraint) write their plan bodies inline. The PLAN_BODY constants carry
// literal backslash-n sequences and literal ${...} interpolations that must reach
// the file unchanged. (Per-scenario file fixtures now live under
// scenarios/<name>/fixtures/ and are read by init_repo_from_fixtures.)
```

- [ ] **Step 4: Remove the four registry entries**

In `src/setup-helpers/registry.ts`:

Drop the four names from the `./sdd-fixtures.ts` import (keep `addSddAuthPlan`, `scaffoldSddBrokenPlan`, `scaffoldSddQualityDefectPlan`, `scaffoldSddSpecConstraintPlan`, `scaffoldSddYagniPlan`):

```typescript
import {
  addSddAuthPlan,
  scaffoldSddBrokenPlan,
  scaffoldSddQualityDefectPlan,
  scaffoldSddSpecConstraintPlan,
  scaffoldSddYagniPlan,
} from './sdd-fixtures.ts';
```

Delete these four REGISTRY entries:

```typescript
  scaffold_sdd_go_fractals_gpt55: { fn: scaffoldSddGoFractalsGpt55 },
  scaffold_sdd_go_fractals_opus48: { fn: scaffoldSddGoFractalsOpus48 },
  scaffold_sdd_svelte_todo: { fn: scaffoldSddSvelteTodo },
  scaffold_sdd_svelte_todo_opus48: { fn: scaffoldSddSvelteTodoOpus48 },
```

Replace the count-bearing header comment (lines 1–5) with a count-free version — the counts bitrot and `KNOWN_HELPER_NAMES` is asserted by relationship, not number:

```typescript
// The dispatch table for `setup-helpers run <helper>`. Holds only the
// dispatchable (workdir-style) helpers; the two library-only entries
// addWorktree/detachHead are intentionally absent (no scenario dispatches them).
// KNOWN_HELPER_NAMES re-adds those two so `quorum check` validates against the
// full set.
```

- [ ] **Step 5: Update the SDD helper tests**

In `test/setup-helpers-sdd.test.ts`:

Remove `scaffoldSddGoFractalsGpt55` from the import. Delete the test `scaffoldSddGoFractalsGpt55 reads fixtures/ and commits design+plan`. In the test `each scratch sdd helper creates the workdir when it does not exist`, remove the `['go-fractals', scaffoldSddGoFractalsGpt55],` entry from the `cases` array (the remaining four embedded-body helpers stay).

- [ ] **Step 6: Validate scenarios, run checks, sweep for leftovers**

Run: `bun run quorum check`
Expected: PASS — the four migrated scenarios validate (`init_repo_from_fixtures` is a known helper and each has a non-empty `fixtures/`).

Run: `bun run check`
Expected: PASS, pristine.

Confirm setup.sh stayed executable:

Run: `git ls-files -s scenarios/sdd-svelte-todo/setup.sh`
Expected: mode `100755`.

Sweep for any dangling reference to the removed names:

Run: `grep -rn "scaffold_sdd_go_fractals\|scaffold_sdd_svelte_todo\|scaffoldSddGoFractals\|scaffoldSddSvelteTodo\|FIXTURES_DIR" src/ test/ scenarios/ docs/`
Expected: no matches (docs are updated in Task 5; if any doc line matches, note it for Task 5).

- [ ] **Step 7: Commit**

```bash
git add fixtures scenarios/sdd-go-fractals-gpt55 scenarios/sdd-go-fractals-opus48 scenarios/sdd-svelte-todo scenarios/sdd-svelte-todo-opus48 src/setup-helpers/sdd-fixtures.ts src/setup-helpers/registry.ts test/setup-helpers-sdd.test.ts
git commit -m "refactor(scenarios): move SDD fixtures into scenario dirs via init_repo_from_fixtures"
```

---

### Task 4: `quorum check` guard for missing fixtures

Catches "switched the verb, forgot the files" at validation time.

**Files:**
- Modify: `src/scaffold.ts` (add `readdirSync` import; add the guard in `checkScenario`)
- Test: `test/scaffold.test.ts`

**Interfaces:**
- Consumes: registry name `init_repo_from_fixtures` (Task 2 — must be a known helper so a present-fixtures scenario yields zero problems).
- Produces: `checkScenario` emits `setup.sh calls init_repo_from_fixtures but fixtures/ is missing or empty` when a scenario references the helper without a non-empty `fixtures/`.

- [ ] **Step 1: Write the failing tests**

In `test/scaffold.test.ts`, add `mkdirSync` to the `node:fs` import. Then add:

```typescript
test('checkScenario flags init_repo_from_fixtures with no fixtures dir', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 'needs-fixtures');
  writeFileSync(
    join(dir, 'setup.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nsetup-helpers run init_repo_from_fixtures\n',
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  expect(checkScenario(dir)).toContain(
    'setup.sh calls init_repo_from_fixtures but fixtures/ is missing or empty',
  );
});

test('checkScenario passes init_repo_from_fixtures when fixtures/ is present', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 'has-fixtures');
  writeFileSync(
    join(dir, 'setup.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nsetup-helpers run init_repo_from_fixtures\n',
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  writeFileSync(join(dir, 'fixtures', 'plan.md'), 'PLAN\n');
  expect(checkScenario(dir)).toEqual([]);
});
```

(`scenario(root, name)` is the existing helper that calls `newScenario`; `scenariosRoot()` is the existing temp-dir helper.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/scaffold.test.ts`
Expected: FAIL — the missing-fixtures problem is not yet emitted.

- [ ] **Step 3: Implement the guard**

In `src/scaffold.ts`, add `readdirSync` to the `node:fs` import:

```typescript
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
```

In `checkScenario`, inside the existing `if (existsSync(setup)) { ... }` block (where `setupText` is in scope), after the `setup-helpers run` unknown-helper loop, add:

```typescript
    if (setupText.includes('init_repo_from_fixtures')) {
      const fixturesDir = join(scenarioDir, 'fixtures');
      const present =
        existsSync(fixturesDir) && readdirSync(fixturesDir).length > 0;
      if (!present) {
        problems.push(
          'setup.sh calls init_repo_from_fixtures but fixtures/ is missing or empty',
        );
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/scaffold.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scaffold.ts test/scaffold.test.ts
git commit -m "feat(quorum-check): require fixtures/ for init_repo_from_fixtures scenarios"
```

---

### Task 5: Documentation

Update the authoring guide and the eval CLAUDE.md to describe scenario-local fixtures.

**Files:**
- Modify: `docs/scenario-authoring.md` (helper catalog `sdd` row; the "Declared needs" paragraph; the "`fixtures/` vs inline constants" subsection)
- Modify: `evals/CLAUDE.md` (Scenario Conventions: add the scenario-local fixtures bullet)

- [ ] **Step 1: Update the helper catalog and declared-needs note**

In `docs/scenario-authoring.md`, change the `sdd` catalog row so it no longer lists the removed file-reading helpers:

```markdown
| sdd (`sdd-fixtures.ts`) | `add_sdd_auth_plan`, `scaffold_sdd_broken_plan`, `scaffold_sdd_quality_defect_plan`, `scaffold_sdd_yagni_plan`, `scaffold_sdd_spec_constraint_plan` | Embedded-body helpers that write their plan inline. SDD file fixtures (`design.md`/`plan.md`) now live in `scenarios/<name>/fixtures/` and are seeded by `init_repo_from_fixtures`. |
```

In the `base` catalog row, append a mention of the generic helper (it lives in `base.ts`):

```markdown
| base (`base.ts`) | `create_base_repo` (`needsTemplateDir`), `init_repo_from_fixtures` (`needsScenarioDir`), `record_head` | `create_base_repo` does `git init` and seeds from `fixtures/template-repo`. `init_repo_from_fixtures` git-inits and mirrors `scenarios/<name>/fixtures/` into the workdir. `record_head` writes the `assert-checkout-clean` sentinel. |
```

In the **Declared needs** paragraph, add a sentence:

```markdown
`needsScenarioDir` resolves `scenarios/<name>/fixtures` (requires
`QUORUM_SCENARIO_DIR`, which the runner sets to the scenario directory).
```

- [ ] **Step 2: Rewrite the "`fixtures/` vs inline constants" subsection**

Replace the body of that subsection with:

```markdown
Per-scenario static or skill-generated content (elicited `plan.md` / `design.md`,
planted source trees) lives in the scenario's own `scenarios/<name>/fixtures/`
directory and is seeded by `init_repo_from_fixtures`, which mirrors the whole
tree into the workdir and makes one commit. **Shared** content used across many
scenarios — the base template repo — stays under top-level
`fixtures/template-repo/` and is read by `create_base_repo`. Small fixed strings
live as inline constants in the helper. Hand-authoring a big plan inline
reintroduces the elicited-vs-handwritten cost trap (§2).
```

- [ ] **Step 3: Add the CLAUDE.md bullet**

In `evals/CLAUDE.md`, under **Scenario Conventions**, add a bullet after the `setup.sh builds the fixture…` bullet:

```markdown
- Per-scenario file fixtures live in `scenarios/<name>/fixtures/`; seed them with
  `setup-helpers run init_repo_from_fixtures` (reads `$QUORUM_SCENARIO_DIR/fixtures/`).
  The shared base template stays at `fixtures/template-repo/`.
```

- [ ] **Step 4: Verify docs reference nothing removed, then commit**

Run: `grep -rn "scaffold_sdd_go_fractals\|scaffold_sdd_svelte_todo\|FIXTURES_DIR" docs/scenario-authoring.md evals/CLAUDE.md`
Expected: no matches.

Run: `bun run quorum check`
Expected: PASS.

```bash
git add docs/scenario-authoring.md CLAUDE.md
git commit -m "docs: describe scenario-local fixtures and init_repo_from_fixtures"
```

(The edited `evals/CLAUDE.md` is `CLAUDE.md` from the `evals/` working directory.)

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Keystone (`needsScenarioDir` + `QUORUM_SCENARIO_DIR`, mirroring `needsTemplateDir`) → Task 2.
- Generic `init_repo_from_fixtures` (recursive mirror + one commit) → Task 1 (function) + Task 2 (registration).
- `fixtures/` subdir layout + the 4 `git mv`s + setup.sh cutover + deletion of `scaffoldSdd*`/`FIXTURES_DIR` → Task 3.
- `quorum check` guard → Task 4.
- `template-repo` stays shared → enforced by Global Constraints + Task 3 Step 1 verification.
- Inline `*_PLAN_BODY` constants stay inline → out of scope; Task 3 keeps the five embedded-body helpers and their tests.
- Docs (scenario-authoring §3, catalog, CLAUDE.md) → Task 5.

**2. Placeholder scan** — no `TBD`/`handle edge cases`/"similar to Task N"; every code step shows complete code and every command states expected output.

**3. Type consistency** — `initRepoFromFixtures(workdir, fixturesDir)` is defined in Task 1 and consumed unchanged in Task 2's `initRepoFromFixturesHelper`. `HelperContext.scenarioDir` / `HelperEnv.scenarioDir` / `RegistryEntry.needsScenarioDir` names are identical across Tasks 2–4. Registry name `init_repo_from_fixtures` is identical across the registry entry (Task 2), the 4 setup.sh files (Task 3), and the guard (Task 4).
