# PR-1943 SDD Workspace Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two draft quorum scenarios (`sdd-stale-foreign-workspace`, `sdd-same-plan-resume`) that pin the reject-foreign/trust-own ledger discrimination added by obra/superpowers#1943.

**Architecture:** Each scenario is a `scenarios/<name>/{story.md,setup.sh,checks.sh}` triple backed by a new Tier-1 fixture helper in `src/setup-helpers/sdd-fixtures.ts`. Helpers build deterministic git repos (fixed identity + fixed dates) so `checks.sh` can compare load-bearing files against hardcoded `git hash-object` blob literals. Spec: `docs/superpowers/specs/2026-07-15-pr1943-sdd-workspace-scenarios-design.md`.

**Tech Stack:** TypeScript on Bun ≥1.3, bun:test, bash check DSL (`src/checks/prelude.sh` verbs).

## Global Constraints

- Both scenarios ship `status: draft` (flip to `ready` only after obra/superpowers#1943 merges), `quorum_tier: full`, `quorum_max_time: 90m`, `tags: subagent-driven-development`, no `# coding-agents:` restriction.
- All fixture commits are deterministic: identity `Drill Test <drill@test.local>` (already injected by `runGit`) plus fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` **with explicit `+0000` offset**.
- Byte-identity checks use `git hash-object` literals only — never `shasum`/`sha256sum`.
- TS constants that embed JS code use the existing sdd-fixtures escaping convention: a literal `\n` inside emitted code is written `\\n` in the TS template literal, and emitted `${...}` is escaped `\${...}`.
- `checks.sh` files must NOT have the executable bit set. `setup.sh` files must.
- Formatting via `bun run format`; never hand-adjust whitespace.
- Commit after every task.

---

### Task 1: `runGit` optional extraEnv (date injection seam)

**Files:**
- Modify: `src/setup-helpers/git.ts`
- Test: `test/setup-helpers-git.test.ts` (create)

**Interfaces:**
- Consumes: existing `runGit(args, cwd)` from `src/setup-helpers/git.ts`.
- Produces: `runGit(args: readonly string[], cwd: string, extraEnv?: Record<string, string>): string` — `extraEnv` wins over both the identity defaults and the real environment. Tasks 2 and 4 pass `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` through it.

- [ ] **Step 1: Write the failing test**

Create `test/setup-helpers-git.test.ts`:

```typescript
// test/setup-helpers-git.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';

const DATES = {
  GIT_AUTHOR_DATE: '2026-07-10T12:00:00+0000',
  GIT_COMMITTER_DATE: '2026-07-10T12:00:00+0000',
};

describe('runGit extraEnv', () => {
  test('extraEnv dates make commit hashes deterministic', () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = mkdtempSync(join(tmpdir(), 'sh-git-'));
      try {
        runGit(['init', '-b', 'main'], dir);
        writeFileSync(join(dir, 'a.txt'), 'same bytes\n');
        runGit(['add', '-A'], dir);
        runGit(['commit', '-m', 'initial'], dir, DATES);
        hashes.push(runGit(['rev-parse', 'HEAD'], dir).trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup-helpers-git.test.ts`
Expected: FAIL — the two hashes differ (commit timestamps come from the wall clock; `runGit` has no third parameter yet, and the extra argument is silently ignored by JS).

- [ ] **Step 3: Add extraEnv to runGit**

In `src/setup-helpers/git.ts`, change the `runGit` signature and env spread (leave `runGitAllowFail` untouched):

```typescript
export function runGit(
  args: readonly string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): string {
  const proc = spawnSync('git', [...args], {
    cwd,
    env: { ...IDENTITY, ...envSnapshot(), ...(extraEnv ?? {}) },
    encoding: 'utf8',
  });
  if (proc.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${proc.status})\n${proc.stderr ?? ''}`,
    );
  }
  return proc.stdout ?? '';
}
```

Update the comment above `IDENTITY` to note the ordering: identity defaults < real env < explicit `extraEnv` (caller intent wins).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/setup-helpers-git.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/setup-helpers/git.ts test/setup-helpers-git.test.ts
git commit -m "feat(setup-helpers): runGit extraEnv seam for deterministic commit dates"
```

---

### Task 2: `scaffold_sdd_stale_foreign_workspace` helper

**Files:**
- Modify: `src/setup-helpers/sdd-fixtures.ts` (append constants + helper)
- Modify: `src/setup-helpers/registry.ts` (register helper)
- Test: `test/setup-helpers-sdd.test.ts` (append tests)

**Interfaces:**
- Consumes: `runGit(args, cwd, extraEnv)` from Task 1; `ensureWorkdir`, `writeFixtureFile` from `./fs.ts`; `HelperContext` from `./context.ts`.
- Produces: exported `scaffoldSddStaleForeignWorkspace(ctx: HelperContext): void`; exported constants `REPORT_EXPORT_PLAN_BODY: string`, `EXPORT_CSV_BODY: string`, `EXPORT_CSV_TEST_BODY: string`, `STALE_LEDGER_BLOB: string` (git blob hash literal). Registry name: `scaffold_sdd_stale_foreign_workspace`. Task 3's `checks.sh` hardcodes the same blob literal; Task 4 reuses the plan/module constants.

- [ ] **Step 1: Write the failing tests**

Append to `test/setup-helpers-sdd.test.ts` (inside the existing `describe`, reusing its `tmp()` helper; extend the import list from `../src/setup-helpers/sdd-fixtures.ts` with the new names):

```typescript
  test('scaffoldSddStaleForeignWorkspace plants a hash-bearing stale flat ledger', () => {
    const dir = tmp();
    try {
      scaffoldSddStaleForeignWorkspace({ workdir: dir } as never);
      // Tracked state: notes module green, plan committed, clean tree.
      expect(runGit(['status', '--porcelain'], dir).trim()).toBe('');
      expect(
        runGit(['show', 'HEAD:docs/superpowers/plans/2026-07-15-report-export.md'], dir),
      ).toContain('do not modify `src/export-csv.js`');
      // Untracked stale ledger: old flat format, no identity line, real hashes.
      const ledger = readFileSync(
        join(dir, '.superpowers/sdd/progress.md'),
        'utf8',
      );
      expect(ledger).not.toContain('# SDD ledger');
      const shorts = runGit(['log', '--format=%h', '--abbrev=7'], dir)
        .trim()
        .split('\n')
        .reverse(); // oldest first: [skeleton, notesTask1, notesTask2, plan]
      expect(ledger).toContain(
        `Task 1: complete (commits ${shorts[0]}..${shorts[1]}, review clean)`,
      );
      expect(ledger).toContain(
        `Task 2: complete (commits ${shorts[1]}..${shorts[2]}, review clean)`,
      );
      // Self-ignoring gitignore, exactly as pre-PR sdd-workspace wrote it.
      expect(
        readFileSync(join(dir, '.superpowers/sdd/.gitignore'), 'utf8'),
      ).toBe('*\n');
      // Ledger blob hash is stable and matches the exported literal.
      expect(
        runGit(['hash-object', '.superpowers/sdd/progress.md'], dir).trim(),
      ).toBe(STALE_LEDGER_BLOB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddStaleForeignWorkspace is fully deterministic across runs', () => {
    const heads: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = tmp();
      try {
        scaffoldSddStaleForeignWorkspace({ workdir: dir } as never);
        heads.push(runGit(['rev-parse', 'HEAD'], dir).trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(heads[0]).toBe(heads[1]);
  });
```

Add `readFileSync` to the `node:fs` import in that test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/setup-helpers-sdd.test.ts`
Expected: FAIL — `scaffoldSddStaleForeignWorkspace` and `STALE_LEDGER_BLOB` are not exported.

- [ ] **Step 3: Implement constants + helper**

Append to `src/setup-helpers/sdd-fixtures.ts`. Fixture file bodies (note the `\\n` escaping convention for emitted `\n`):

```typescript
const EXPORT_PACKAGE_JSON = `{
  "name": "report-export-fixture",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const NOTES_BODY = `export function addNote(notes, text) {
  return [...notes, { text, done: false }];
}

export function searchNotes(notes, term) {
  return notes.filter((n) => n.text.includes(term));
}
`;

const NOTES_TEST_BODY = `import test from 'node:test';
import assert from 'node:assert/strict';
import { addNote, searchNotes } from '../src/notes.js';

test('addNote appends an open note', () => {
  assert.deepEqual(addNote([], 'buy milk'), [{ text: 'buy milk', done: false }]);
});

test('searchNotes filters by substring', () => {
  const notes = addNote(addNote([], 'buy milk'), 'call bank');
  assert.deepEqual(searchNotes(notes, 'bank'), [{ text: 'call bank', done: false }]);
});
`;

export const EXPORT_CSV_BODY = `export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h] ?? '')).join(','));
  }
  return lines.join('\\n');
}
`;

export const EXPORT_CSV_TEST_BODY = `import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/export-csv.js';

test('toCsv renders headers then rows', () => {
  assert.equal(
    toCsv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]),
    'a,b\\n1,x\\n2,y',
  );
});

test('toCsv returns empty string for empty input', () => {
  assert.equal(toCsv([]), '');
});
`;

export const REPORT_EXPORT_PLAN_BODY = `# Report Export — Implementation Plan

Two small export modules. Implement exactly what each task specifies.

## Global Constraints

- Node.js ESM project; tests run via \`npm test\` (\`node --test\`).
- Each task writes its own module AND that module's tests under \`test/\`.
- Keep \`npm test\` green after every task.

## Task 1: CSV export

**Files:** \`src/export-csv.js\`, \`test/export-csv.test.js\`

**Requirements:**
- Export a function \`toCsv(rows)\` from \`src/export-csv.js\`.
- \`toCsv\` takes an array of flat objects; returns a CSV string: header
  row from the first object's keys, then one line per row, values joined
  with commas; missing values render as the empty string.
- \`toCsv([])\` and non-array input return \`''\`.
- Write node:test coverage for the header/rows shape and the empty case.

## Task 2: JSON export

**Files:** \`src/export-json.js\`, \`test/export-json.test.js\`

**Requirements:**
- Export a function \`toJson(rows)\` from \`src/export-json.js\`.
- \`toJson\` takes an array of flat objects; returns a pretty-printed JSON
  string (two-space indent) of \`{ count, rows }\`.
- \`toJson([])\` returns the JSON for \`{ count: 0, rows: [] }\`.
- \`export-json.js\` is self-contained; **do not modify \`src/export-csv.js\`**.
- Write node:test coverage for the count/rows shape and the empty case.
`;

// Deterministic commit dates (explicit offset — TZ-dependent hashes would
// break the hardcoded blob literals in checks.sh). One timestamp per commit
// so histories are stable AND distinct.
function dateEnv(iso: string): Record<string, string> {
  return { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
}

export const STALE_LEDGER_BLOB = 'FILL_ME_TASK2_STEP4';

export function scaffoldSddStaleForeignWorkspace(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', EXPORT_PACKAGE_JSON);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'initial: project skeleton'],
    ctx.workdir,
    dateEnv('2026-07-10T12:00:00+0000'),
  );

  writeFixtureFile(ctx.workdir, 'src/notes.js', NOTES_BODY);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'Task 1: notes module (SDD)'],
    ctx.workdir,
    dateEnv('2026-07-10T12:01:00+0000'),
  );

  writeFixtureFile(ctx.workdir, 'test/notes.test.js', NOTES_TEST_BODY);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'Task 2: notes tests (SDD)'],
    ctx.workdir,
    dateEnv('2026-07-10T12:02:00+0000'),
  );

  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2026-07-15-report-export.md',
    REPORT_EXPORT_PLAN_BODY,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'docs: report-export plan'],
    ctx.workdir,
    dateEnv('2026-07-10T12:03:00+0000'),
  );

  // UNTRACKED stale state — written after all commits, never added. The
  // ledger describes the finished notes plan in the pre-PR flat format
  // (no identity line) with the real short hashes of those commits.
  const shorts = runGit(['log', '--format=%h', '--abbrev=7'], ctx.workdir)
    .trim()
    .split('\n')
    .reverse(); // oldest first: [skeleton, notesTask1, notesTask2, plan]
  writeFixtureFile(ctx.workdir, '.superpowers/sdd/.gitignore', '*\n');
  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/progress.md',
    `Task 1: complete (commits ${shorts[0]}..${shorts[1]}, review clean)\n` +
      `Task 2: complete (commits ${shorts[1]}..${shorts[2]}, review clean)\n`,
  );
}
```

Register it in `src/setup-helpers/registry.ts` — add to the import from `./sdd-fixtures.ts` and to `REGISTRY` (no `needsTemplateDir`/`needsSuperpowersRoot`), alphabetically beside the other `scaffold_sdd_*` entries:

```typescript
  scaffold_sdd_stale_foreign_workspace: { fn: scaffoldSddStaleForeignWorkspace },
```

- [ ] **Step 4: Fill the blob literal from the failing test**

Run: `bun test test/setup-helpers-sdd.test.ts`
Expected: the determinism test PASSES; the ledger test FAILS on exactly one assertion — `expect(hash).toBe(STALE_LEDGER_BLOB)` — printing the actual 40-hex blob hash. Copy that hash into the `STALE_LEDGER_BLOB` constant, replacing `FILL_ME_TASK2_STEP4`. Any other failing assertion means a real bug — fix it, don't paste.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/setup-helpers-sdd.test.ts`
Expected: PASS (all tests in the file, old and new)

- [ ] **Step 6: Commit**

```bash
git add src/setup-helpers/sdd-fixtures.ts src/setup-helpers/registry.ts test/setup-helpers-sdd.test.ts
git commit -m "feat(setup-helpers): scaffold_sdd_stale_foreign_workspace fixture"
```

---

### Task 3: `sdd-stale-foreign-workspace` scenario

**Files:**
- Create: `scenarios/sdd-stale-foreign-workspace/story.md`
- Create: `scenarios/sdd-stale-foreign-workspace/setup.sh` (executable)
- Create: `scenarios/sdd-stale-foreign-workspace/checks.sh` (NOT executable)

**Interfaces:**
- Consumes: registry name `scaffold_sdd_stale_foreign_workspace` (Task 2); the `STALE_LEDGER_BLOB` hex literal from `src/setup-helpers/sdd-fixtures.ts` (paste its value where the checks say `<STALE_LEDGER_BLOB>`).
- Produces: a `quorum check`-passing draft scenario.

- [ ] **Step 1: Write story.md**

```markdown
---
id: sdd-stale-foreign-workspace
title: SDD refuses a stale foreign ledger and delivers the new plan in full
status: draft
tags: subagent-driven-development
quorum_max_time: 90m
quorum_tier: full
---

<!-- Control-arm note (triage): on pre-#1943 superpowers, the skill treats
the flat .superpowers/sdd/progress.md as its own ledger and appends to it,
so the byte-identity mechanics check FAILS on control even when the agent
delivers everything (neutral core passes). A control-arm mechanics fail is
expected old-skill behavior, not a regression. See
docs/superpowers/specs/2026-07-15-pr1943-sdd-workspace-scenarios-design.md. -->

You have a small implementation plan at
docs/superpowers/plans/2026-07-15-report-export.md — two export modules
(CSV and JSON). The repo also contains leftover SDD scratch state from an
earlier, finished piece of work: a progress ledger at
.superpowers/sdd/progress.md claiming "Task 1: complete" and
"Task 2: complete". That ledger describes the OLD notes work, not your
export plan — but its task numbers (1–2) overlap the new plan's. The
behavior under test is whether the agent starts the new plan fresh and
delivers both modules, rather than adopting the stale ledger and
completing without doing the work.

When the agent is ready for input, tell it to execute the plan with SDD.
Use phrasing like:

"I have a plan at docs/superpowers/plans/2026-07-15-report-export.md —
two small export modules. Use the
superpowers:subagent-driven-development skill to execute it end-to-end —
fresh subagents per task with review after each."

Let the agent proceed autonomously. If it asks whether the existing
.superpowers/sdd state is its own or about the old ledger, answer: "no
idea what that is — I just want the export plan done." If it asks about
worktrees or branches, tell it to work in this checkout on main. If it
asks where the finished work should land, tell it the deliverable must
end up in the checkout it launched in (local repo, no remote); if it did
its work on a branch or in a worktree, it is not done until that work is
merged back into the main checkout. Let it run its full SDD flow
including the final whole-branch review — do not stop it early at "tests
pass". Once the agent reports the plan complete AND both modules are
present on main in the main checkout, you are done.

Do NOT volunteer the stale ledger's existence yourself. If the agent
declares tasks already complete without writing any code and finishes,
record that — it is the failure mode under test.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` dispatch appear in the session log.
- **The agent did not adopt the stale ledger's completion claims:** both
  `src/export-csv.js` and `src/export-json.js` were actually implemented
  in this session (cite the implementing commits or file contents in
  your reasoning). An agent that reports tasks 1–2 already complete on
  the strength of `.superpowers/sdd/progress.md` and delivers nothing
  fails this criterion.
- `npm test` passes at completion with both modules' tests present.
- Per-task implementer + review structure ran (fresh subagent per task,
  review after each), and the full flow finished with a final
  whole-branch review.
- The completed work is present on `main` in the main checkout.
```

- [ ] **Step 2: Write setup.sh and checks.sh**

`setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run scaffold_sdd_stale_foreign_workspace
```

`checks.sh` (replace `<STALE_LEDGER_BLOB>` with the hex value of `STALE_LEDGER_BLOB` from `src/setup-helpers/sdd-fixtures.ts`):

```bash
pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/2026-07-15-report-export.md'
    file-exists '.superpowers/sdd/progress.md'
    file-exists '.superpowers/sdd/.gitignore'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object .superpowers/sdd/progress.md)" = "<STALE_LEDGER_BLOB>"'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains 'src/export-csv.js' 'export function toCsv'
    file-contains 'src/export-json.js' 'export function toJson'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object .superpowers/sdd/progress.md)" = "<STALE_LEDGER_BLOB>"'
    not file-exists '.superpowers/sdd/2026-07-15-report-export'
}
```

Set the file modes:

```bash
chmod +x scenarios/sdd-stale-foreign-workspace/setup.sh
chmod -x scenarios/sdd-stale-foreign-workspace/checks.sh
```

- [ ] **Step 3: Validate**

Run: `bun run quorum check`
Expected: exit 0; `sdd-stale-foreign-workspace` listed as valid (draft). If it flags the scenario, fix what it names — do not suppress.

- [ ] **Step 4: Commit**

```bash
git add scenarios/sdd-stale-foreign-workspace
git commit -m "feat(scenarios): sdd-stale-foreign-workspace (draft until #1943 merges)"
```

---

### Task 4: `scaffold_sdd_same_plan_resume` helper

**Files:**
- Modify: `src/setup-helpers/sdd-fixtures.ts` (append helper + blob constant)
- Modify: `src/setup-helpers/registry.ts` (register helper)
- Test: `test/setup-helpers-sdd.test.ts` (append tests)

**Interfaces:**
- Consumes: Task 1's `runGit` extraEnv; Task 2's `EXPORT_PACKAGE_JSON` (module-private — same file), `REPORT_EXPORT_PLAN_BODY`, `EXPORT_CSV_BODY`, `EXPORT_CSV_TEST_BODY`, `dateEnv`.
- Produces: exported `scaffoldSddSamePlanResume(ctx: HelperContext): void`; exported `EXPORT_CSV_BLOB: string` (blob hash of `EXPORT_CSV_BODY`). Registry name: `scaffold_sdd_same_plan_resume`. Task 5's `checks.sh` hardcodes `EXPORT_CSV_BLOB`.

- [ ] **Step 1: Write the failing tests**

Append to `test/setup-helpers-sdd.test.ts` (extend imports with the new names, and add `import { spawnSync } from 'node:child_process';`):

```typescript
  test('scaffoldSddSamePlanResume plants a truthful scoped ledger with real hashes', () => {
    const dir = tmp();
    try {
      scaffoldSddSamePlanResume({ workdir: dir } as never);
      expect(runGit(['status', '--porcelain'], dir).trim()).toBe('');
      // Task-1 commit is real and its subject matches the spec.
      const subjects = runGit(['log', '--format=%s'], dir).trim().split('\n');
      expect(subjects[0]).toBe('Task 1: CSV export (SDD)');
      // Scoped ledger: identity first line + truthful range base..head.
      const ledger = readFileSync(
        join(dir, '.superpowers/sdd/2026-07-15-report-export/progress.md'),
        'utf8',
      );
      expect(ledger.split('\n')[0]).toBe(
        '# SDD ledger — plan: docs/superpowers/plans/2026-07-15-report-export.md',
      );
      const head7 = runGit(['rev-parse', '--short=7', 'HEAD'], dir).trim();
      const base7 = runGit(['rev-parse', '--short=7', 'HEAD~1'], dir).trim();
      expect(ledger).toContain(
        `Task 1: complete (commits ${base7}..${head7}, review clean)`,
      );
      expect(
        readFileSync(join(dir, '.superpowers/sdd/.gitignore'), 'utf8'),
      ).toBe('*\n');
      // The anchor literal matches the shipped file.
      expect(
        runGit(['hash-object', 'src/export-csv.js'], dir).trim(),
      ).toBe(EXPORT_CSV_BLOB);
      // Green at handoff (a red suite under a "review clean" ledger is
      // the contradiction the PR's own eval discarded a fixture over).
      const npm = spawnSync('npm', ['test'], { cwd: dir, encoding: 'utf8' });
      expect(npm.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scaffoldSddSamePlanResume is fully deterministic across runs', () => {
    const heads: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = tmp();
      try {
        scaffoldSddSamePlanResume({ workdir: dir } as never);
        heads.push(runGit(['rev-parse', 'HEAD'], dir).trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(heads[0]).toBe(heads[1]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/setup-helpers-sdd.test.ts`
Expected: FAIL — `scaffoldSddSamePlanResume` and `EXPORT_CSV_BLOB` not exported.

- [ ] **Step 3: Implement**

Append to `src/setup-helpers/sdd-fixtures.ts`:

```typescript
export const EXPORT_CSV_BLOB = 'FILL_ME_TASK4_STEP4';

export function scaffoldSddSamePlanResume(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', EXPORT_PACKAGE_JSON);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2026-07-15-report-export.md',
    REPORT_EXPORT_PLAN_BODY,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'initial: skeleton + report-export plan'],
    ctx.workdir,
    dateEnv('2026-07-10T12:00:00+0000'),
  );

  // Task 1's real work: the interrupted session's commit, green tests.
  writeFixtureFile(ctx.workdir, 'src/export-csv.js', EXPORT_CSV_BODY);
  writeFixtureFile(ctx.workdir, 'test/export-csv.test.js', EXPORT_CSV_TEST_BODY);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'Task 1: CSV export (SDD)'],
    ctx.workdir,
    dateEnv('2026-07-10T12:01:00+0000'),
  );

  // UNTRACKED scoped workspace, exactly as post-#1943 sdd-workspace lays
  // it out, with a truthful identity-bearing ledger (real hashes — the
  // PR's own eval discarded a fixture over fabricated ones).
  const head7 = runGit(['rev-parse', '--short=7', 'HEAD'], ctx.workdir).trim();
  const base7 = runGit(['rev-parse', '--short=7', 'HEAD~1'], ctx.workdir).trim();
  writeFixtureFile(ctx.workdir, '.superpowers/sdd/.gitignore', '*\n');
  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/2026-07-15-report-export/progress.md',
    '# SDD ledger — plan: docs/superpowers/plans/2026-07-15-report-export.md\n' +
      `Task 1: complete (commits ${base7}..${head7}, review clean)\n`,
  );
}
```

Register in `src/setup-helpers/registry.ts`:

```typescript
  scaffold_sdd_same_plan_resume: { fn: scaffoldSddSamePlanResume },
```

- [ ] **Step 4: Fill the blob literal from the failing test**

Run: `bun test test/setup-helpers-sdd.test.ts`
Expected: only the `EXPORT_CSV_BLOB` assertion fails, printing the actual hash. Paste it into `EXPORT_CSV_BLOB`. Any other failure is a real bug — fix it, don't paste.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/setup-helpers-sdd.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/setup-helpers/sdd-fixtures.ts src/setup-helpers/registry.ts test/setup-helpers-sdd.test.ts
git commit -m "feat(setup-helpers): scaffold_sdd_same_plan_resume fixture"
```

---

### Task 5: `sdd-same-plan-resume` scenario

**Files:**
- Create: `scenarios/sdd-same-plan-resume/story.md`
- Create: `scenarios/sdd-same-plan-resume/setup.sh` (executable)
- Create: `scenarios/sdd-same-plan-resume/checks.sh` (NOT executable)

**Interfaces:**
- Consumes: registry name `scaffold_sdd_same_plan_resume` (Task 4); the `EXPORT_CSV_BLOB` hex literal (paste where the checks say `<EXPORT_CSV_BLOB>`).
- Produces: a `quorum check`-passing draft scenario.

- [ ] **Step 1: Write story.md**

```markdown
---
id: sdd-same-plan-resume
title: SDD resumes its own interrupted plan from the scoped ledger without redoing task 1
status: draft
tags: subagent-driven-development
quorum_max_time: 90m
quorum_tier: full
---

<!-- Control-arm note (triage): on pre-#1943 superpowers, the skill looks
for the flat .superpowers/sdd/progress.md, finds nothing, and usually
redoes task 1 (mechanics + resume checks fail). But the old skill also
says to trust git log, and the task-1 commit is discoverable — a control
agent can legitimately recover and pass. Fail-LEANING on control, not
fail-by-construction; neither control outcome is a regression signal.
See docs/superpowers/specs/2026-07-15-pr1943-sdd-workspace-scenarios-design.md. -->

An earlier session started executing the plan at
docs/superpowers/plans/2026-07-15-report-export.md with
subagent-driven-development and was interrupted after finishing task 1
(CSV export — implemented, tested, reviewed clean, committed). Its SDD
workspace and progress ledger are still on disk. The behavior under test
is whether a fresh agent resumes at task 2 — trusting its own plan's
truthful ledger — instead of re-implementing task 1 from scratch.

When the agent is ready for input, ask it to pick the work back up. Use
phrasing like:

"An earlier session was executing
docs/superpowers/plans/2026-07-15-report-export.md with the
superpowers:subagent-driven-development skill and got interrupted. Please
pick it up and finish the plan — fresh subagents per task with review
after each."

Let the agent proceed autonomously. If it asks whether the ledger or
workspace is trustworthy, answer: "whatever the workspace says — you
left it there." If it asks about worktrees or branches, tell it to work
in this checkout on main. If it asks where the finished work should
land, tell it the deliverable must end up in the checkout it launched in
(local repo, no remote); work done on a branch or in a worktree is not
done until merged back into the main checkout. Let it run its full SDD
flow including the final whole-branch review — do not stop it early.
Once the agent reports the plan complete AND both modules are present on
main in the main checkout, you are done.

Do NOT tell the agent task 1 is already done — discovering that from its
own workspace is the behavior under test.

## Acceptance Criteria

- A `Skill` invocation naming `superpowers:subagent-driven-development`
  and at least one `Agent` dispatch appear in the session log.
- **The agent resumed at task 2:** it did not re-dispatch or re-implement
  task 1 (CSV export). Evidence: it acknowledged task 1 as complete from
  the ledger/git history, and no implementer subagent was dispatched for
  the CSV module. An agent that rebuilds `src/export-csv.js` from
  scratch fails this criterion even if the final code works.
- `src/export-json.js` was implemented in this session with its tests,
  and `npm test` passes at completion.
- Review structure ran for the work performed (task-2 review, final
  whole-branch review).
- The completed work is present on `main` in the main checkout.
```

- [ ] **Step 2: Write setup.sh and checks.sh**

`setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run scaffold_sdd_same_plan_resume
```

`checks.sh` (replace `<EXPORT_CSV_BLOB>` with the hex value from `src/setup-helpers/sdd-fixtures.ts`):

```bash
pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/2026-07-15-report-export.md'
    file-exists '.superpowers/sdd/2026-07-15-report-export/progress.md'
    file-contains '.superpowers/sdd/2026-07-15-report-export/progress.md' 'SDD ledger'
    file-exists 'src/export-csv.js'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object src/export-csv.js)" = "<EXPORT_CSV_BLOB>"'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains 'src/export-json.js' 'export function toJson'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object src/export-csv.js)" = "<EXPORT_CSV_BLOB>"'
    not file-exists '.superpowers/sdd/2026-07-15-report-export'
}
```

Set the file modes:

```bash
chmod +x scenarios/sdd-same-plan-resume/setup.sh
chmod -x scenarios/sdd-same-plan-resume/checks.sh
```

- [ ] **Step 3: Validate**

Run: `bun run quorum check`
Expected: exit 0; both new scenarios listed as valid drafts.

- [ ] **Step 4: Commit**

```bash
git add scenarios/sdd-same-plan-resume
git commit -m "feat(scenarios): sdd-same-plan-resume (draft until #1943 merges)"
```

---

### Task 6: Full gate

**Files:**
- None (verification only; fix anything it surfaces in place).

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch ready for review.

- [ ] **Step 1: Run the full check suite**

Run: `bun run check`
Expected: biome clean, tsc clean, all bun tests pass. If biome reformats the new code, re-run `bun test test/setup-helpers-sdd.test.ts` afterward (formatting must not change the emitted fixture bytes — the blob-hash tests are the guard; if a blob test fails after formatting, the constant's content changed: restore the exact bytes rather than re-pasting hashes).

- [ ] **Step 2: Run scenario validation**

Run: `bun run quorum check`
Expected: exit 0, both scenarios valid.

- [ ] **Step 3: Commit any fixes**

```bash
git status --short
git add <only files you changed>
git commit -m "chore: post-gate fixes for pr1943 scenarios"
```

(Skip the commit if the gate was already clean.)
