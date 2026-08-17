# Composer False-Pass Hardening (Expected-Check Manifests + Planted Negatives) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the composer false-pass hole — a Gauntlet pass with zero (or silently vanished) deterministic post-checks composes to `pass` today — by freezing an expected-check manifest per scenario, enforcing it in the composer, and proving every check verb can actually fail on its target defect.

**Architecture:** A generated, committed `checks-manifest.json` per scenario (exact multiset of `{phase, check, args, negated, count}` extracted statically from `checks.sh`); `quorum check` validates manifest freshness; `compose()` returns a typed `checks`-stage error (→ `indeterminate`, never `pass`) when runtime records don't match the manifest; verb-level planted-negative tests prove each fs and transcript verb fails on its target defect (mutated-ATIF fixtures for the transcript family).

**Tech Stack:** TypeScript on Bun ≥1.3, zod contracts, `bun test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` — "Checks: adopting smevals' check-result extensions" (expected-check manifest paragraph) and "Order of operations" fix-now item 1, bullet 2. This is fix-now work: it precedes the campaign kernel and is a prerequisite for any gating suite.

## Global Constraints

- Bun ≥ 1.3; `bun run check` (biome + tsc + bun test) must be green at every commit.
- No live evals in tests — all tests hermetic (`bun test` only); transcript-verb tests use committed ATIF fixture files, never captured run homes.
- `checks.sh` stays functions-only with bare verbs (already enforced by `src/scaffold.ts` `validateChecksSh`); this plan adds NO new checks.sh syntax.
- Verified empirical facts this plan relies on: zero `checks.sh` files contain `if`/`case`/`while`/`for` (checked 2026-08-17 across all 85 scenarios), so the manifest format has no conditional/alternate mechanism; 11 scenarios use `$` only inside single-quoted `command-succeeds '...'` args (not expanded by bash).
- Commit after every task; conventional-commit style messages matching repo history (`feat:`, `fix:`, `test:`, `docs:`).
- Repo rule: never weaken an existing test; test output must be pristine.

## File Structure

- `src/contracts/check-manifest.ts` — NEW: zod schema for the manifest document (`CheckManifestSchema`, `ManifestEntrySchema`).
- `src/check/manifest.ts` — NEW: static extractor over `checks.sh` (`extractManifest`), multiset comparison (`compareRecords`), read/write helpers (`readManifest`, `writeManifest`, `manifestPath`).
- `src/composer.ts` — MODIFY: `ComposeArgs` gains `expected: CheckManifest | null`; mismatch short-circuits to `indeterminate` with a `checks`-stage `RunError`.
- `src/runner/index.ts` — MODIFY: load the scenario's manifest once, thread it through the five `compose()` call sites (lines 987, 1341, 1352, 1918, 1947 at `8cd0e80`).
- `src/scaffold.ts` — MODIFY: `checkScenario` validates manifest presence + freshness (extraction equality).
- `src/cli/index.ts` — MODIFY: `quorum check --update-manifests` regeneration flag.
- `scenarios/<name>/checks-manifest.json` × 85 — NEW, generated, committed.
- `test/check-manifest.test.ts` — NEW: characterization + extractor + compare tests.
- `test/composer-manifest.test.ts` — NEW: composer enforcement tests.
- `test/check-tool.test.ts`, `test/check-transcript.test.ts` — MODIFY: planted-negative fill (only where a verb lacks a fails-on-target-defect case).
- `docs/scenario-authoring.md`, `CLAUDE.md` — MODIFY: manifest convention.

---

### Task 1: Manifest contract + record-emission characterization

**Files:**
- Create: `src/contracts/check-manifest.ts`
- Create: `test/check-manifest.test.ts`

**Interfaces:**
- Produces: `CheckManifestSchema` / `CheckManifest` = `{ schema_version: 1, entries: ManifestEntry[] }`; `ManifestEntry` = `{ phase: 'pre'|'post', check: string, args: string[] | null, negated: boolean, count: number }` (`args: null` = wildcard, matches any args). Task 2's extractor and Task 4's composer consume these exact names.

The extractor must mirror what the runtime dispatcher actually records. The composer's own comments (`src/composer.ts:8-17`) state the rules — plain transcript checks record under the inner **verb** name, negated ones under the wrapper name `check-transcript` — but this task pins them empirically with `runPhase` (`src/checks/index.ts`) before any extractor code exists. If the characterization disagrees with the rules stated here, the characterization wins and Task 2's `RECORD_NAME_RULES` constants change to match — that is the point of doing this first.

- [ ] **Step 1: Write the contract**

```typescript
// src/contracts/check-manifest.ts
import { z } from 'zod';
import { CHECK_PHASES } from './verdict.ts';

export const ManifestEntrySchema = z.object({
  phase: z.enum(CHECK_PHASES),
  check: z.string(),
  // null = wildcard: matches records with any args (used when the checks.sh
  // token contains `$`, whose runtime expansion the extractor cannot predict).
  args: z.array(z.string()).nullable(),
  negated: z.boolean(),
  count: z.number().int().positive(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const CheckManifestSchema = z.object({
  schema_version: z.literal(1),
  entries: z.array(ManifestEntrySchema),
});
export type CheckManifest = z.infer<typeof CheckManifestSchema>;
```

- [ ] **Step 2: Write the failing characterization test**

```typescript
// test/check-manifest.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from '../src/checks/index.ts';

const REPO_ROOT = join(import.meta.dir, '..');

function phaseRecords(body: { pre: string; post: string }, opts: { transcriptPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-char-'));
  const checksSh = join(dir, 'checks.sh');
  writeFileSync(checksSh, `pre() {\n${body.pre}\n}\n\npost() {\n${body.post}\n}\n`);
  const workdir = mkdtempSync(join(tmpdir(), 'manifest-wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const pre = runPhase({ checksSh, phase: 'pre', workdir, repoRoot: REPO_ROOT, ...opts });
  const post = runPhase({ checksSh, phase: 'post', workdir, repoRoot: REPO_ROOT, ...opts });
  return { pre: pre.records, post: post.records };
}

describe('record-emission characterization (pins extractor rules)', () => {
  test('plain fs verb records under the verb name with literal args', () => {
    const { post } = phaseRecords({ pre: '    file-exists present.txt', post: '    file-exists present.txt' });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({ check: 'file-exists', args: ['present.txt'], negated: false, phase: 'post' });
  });

  test('`not <fs-verb>` records under the verb name with negated=true', () => {
    const { post } = phaseRecords({ pre: '    file-exists present.txt', post: '    not file-exists absent.txt' });
    expect(post[0]).toMatchObject({ check: 'file-exists', negated: true });
  });

  test('single-quoted $ args are NOT expanded (literal in the record)', () => {
    const { post } = phaseRecords({
      pre: '    file-exists present.txt',
      post: `    command-succeeds 'test -n "$PWD"'`,
    });
    expect(post[0]?.args).toEqual(['test -n "$PWD"']);
  });

  test('plain transcript check records under the inner VERB name', () => {
    // Reuse the fixture trajectory pattern from test/check-transcript.test.ts:
    // write a minimal ATIF trajectory with one Write tool call.
    const tdir = mkdtempSync(join(tmpdir(), 'manifest-atif-'));
    const trajectoryPath = join(tdir, 'trajectory.json');
    writeFileSync(trajectoryPath, JSON.stringify({
      schema_version: 'ATIF-v1.7', agent: { name: 'test', version: '0' },
      steps: [{ index: 0, source: 'agent', tool_calls: [{ tool_name: 'Write', arguments: { file_path: 'a' } }] }],
    }));
    const { post } = phaseRecords(
      { pre: '    file-exists present.txt', post: '    check-transcript tool-called Write' },
      { transcriptPath: trajectoryPath },
    );
    expect(post[0]).toMatchObject({ check: 'tool-called', args: ['Write'], negated: false });
  });

  test('negated transcript check records under the WRAPPER name check-transcript', () => {
    const tdir = mkdtempSync(join(tmpdir(), 'manifest-atif2-'));
    const trajectoryPath = join(tdir, 'trajectory.json');
    writeFileSync(trajectoryPath, JSON.stringify({
      schema_version: 'ATIF-v1.7', agent: { name: 'test', version: '0' },
      steps: [{ index: 0, source: 'agent', tool_calls: [{ tool_name: 'Write', arguments: {} }] }],
    }));
    const { post } = phaseRecords(
      { pre: '    file-exists present.txt', post: '    not check-transcript tool-called Bash' },
      { transcriptPath: trajectoryPath },
    );
    expect(post[0]).toMatchObject({ check: 'check-transcript', negated: true });
  });
});
```

If the minimal inline trajectory shape above does not satisfy `src/atif/validate.ts`, copy the smallest committed fixture used by `test/check-transcript.test.ts` instead of hand-writing one — do not weaken the assertion.

- [ ] **Step 3: Run the characterization tests**

Run: `bun test test/check-manifest.test.ts`
Expected: contract import passes; characterization tests PASS if the stated rules are right, FAIL if reality differs. **Either way, record the actual `check`/`args`/`negated` values in the test expectations (fix the expectations to reality) — reality is authoritative.**

- [ ] **Step 4: Commit**

```bash
git add src/contracts/check-manifest.ts test/check-manifest.test.ts
git commit -m "feat: check-manifest contract + record-emission characterization"
```

---

### Task 2: Static extractor + multiset compare

**Files:**
- Create: `src/check/manifest.ts`
- Modify: `test/check-manifest.test.ts` (extractor + compare tests appended)

**Interfaces:**
- Consumes: `CheckManifest`, `ManifestEntry` (Task 1); the verb vocabulary from `src/check/fs-verbs.ts` (`FS_VERBS`) and `src/check/transcript-dispatch.ts` (its verb table export — reuse the same source `src/cli/list-check-verbs.ts` reads).
- Produces (Tasks 3–5 rely on these exact signatures):
  - `manifestPath(scenarioDir: string): string` → `<scenarioDir>/checks-manifest.json`
  - `extractManifest(checksShPath: string): CheckManifest` — throws `ManifestExtractionError` (exported class) on an unknown verb or unparseable line
  - `readManifest(scenarioDir: string): CheckManifest | null` — null when the file is absent; throws on unparseable/invalid JSON
  - `writeManifest(scenarioDir: string, m: CheckManifest): void` — stable key order, trailing newline, 2-space indent
  - `compareRecords(expected: CheckManifest, records: readonly CheckRecord[]): { missing: string[]; unexpected: string[] }` — empty arrays = match

- [ ] **Step 1: Write failing extractor tests** (append to `test/check-manifest.test.ts`)

```typescript
import { compareRecords, extractManifest, ManifestExtractionError } from '../src/check/manifest.ts';

function writeChecksSh(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-ex-'));
  const p = join(dir, 'checks.sh');
  writeFileSync(p, content);
  return p;
}

describe('extractManifest', () => {
  test('extracts plain verbs with args, phases, and multiplicity', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    file-exists a.txt\n    file-exists a.txt\n    file-contains a.txt hello\n}\n',
    );
    const m = extractManifest(p);
    expect(m.entries).toContainEqual({ phase: 'pre', check: 'git-repo', args: [], negated: false, count: 1 });
    expect(m.entries).toContainEqual({ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 2 });
    expect(m.entries).toContainEqual({ phase: 'post', check: 'file-contains', args: ['a.txt', 'hello'], negated: false, count: 1 });
  });

  test('encodes `not` and transcript naming per the Task 1 characterization', () => {
    const p = writeChecksSh(
      'pre() {\n    git-repo\n}\n\npost() {\n    not file-exists gone.txt\n    check-transcript skill-called superpowers:brainstorming\n    not check-transcript tool-called Bash\n}\n',
    );
    const m = extractManifest(p);
    expect(m.entries).toContainEqual({ phase: 'post', check: 'file-exists', args: ['gone.txt'], negated: true, count: 1 });
    expect(m.entries).toContainEqual({ phase: 'post', check: 'skill-called', args: ['superpowers:brainstorming'], negated: false, count: 1 });
    // Wrapper-name rule from Task 1 characterization:
    expect(m.entries).toContainEqual({ phase: 'post', check: 'check-transcript', args: ['tool-called', 'Bash'], negated: true, count: 1 });
  });

  test('any token containing $ makes args a wildcard (null)', () => {
    const p = writeChecksSh(`pre() {\n    git-repo\n}\n\npost() {\n    command-succeeds 'test -n "$PWD"'\n}\n`);
    const m = extractManifest(p);
    expect(m.entries).toContainEqual({ phase: 'post', check: 'command-succeeds', args: null, negated: false, count: 1 });
  });

  test('unknown verb throws ManifestExtractionError', () => {
    const p = writeChecksSh('pre() {\n    file-exsts a.txt\n}\n\npost() {\n    git-repo\n}\n');
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });

  test('setup-helpers lines are rejected (never valid in checks.sh)', () => {
    const p = writeChecksSh('pre() {\n    setup-helpers run init_repo\n}\n\npost() {\n    git-repo\n}\n');
    expect(() => extractManifest(p)).toThrow(ManifestExtractionError);
  });
});

describe('compareRecords', () => {
  const rec = (over: Partial<import('../src/contracts/verdict.ts').CheckRecord>) => ({
    check: 'file-exists', args: ['a.txt'], negated: false, passed: true, detail: null,
    phase: 'post' as const, ...over,
  });
  const manifest = (entries: import('../src/contracts/check-manifest.ts').ManifestEntry[]) =>
    ({ schema_version: 1 as const, entries });

  test('exact multiset match → empty diffs', () => {
    const m = manifest([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 2 }]);
    const d = compareRecords(m, [rec({}), rec({})]);
    expect(d).toEqual({ missing: [], unexpected: [] });
  });

  test('vanished record → missing; extra record → unexpected', () => {
    const m = manifest([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 2 }]);
    expect(compareRecords(m, [rec({})]).missing).toHaveLength(1);
    expect(compareRecords(m, [rec({}), rec({}), rec({ check: 'git-repo', args: [] })]).unexpected).toHaveLength(1);
  });

  test('wildcard entry matches any args but still counts multiplicity', () => {
    const m = manifest([{ phase: 'post', check: 'command-succeeds', args: null, negated: false, count: 1 }]);
    expect(compareRecords(m, [rec({ check: 'command-succeeds', args: ['whatever expanded'] })]))
      .toEqual({ missing: [], unexpected: [] });
    expect(compareRecords(m, []).missing).toHaveLength(1);
  });

  test('a FAILED record still satisfies its manifest entry (pass/fail is the composer verdict axis, presence is the manifest axis)', () => {
    const m = manifest([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]);
    expect(compareRecords(m, [rec({ passed: false })])).toEqual({ missing: [], unexpected: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/check-manifest.test.ts`
Expected: FAIL — `src/check/manifest.ts` does not exist.

- [ ] **Step 3: Implement `src/check/manifest.ts`**

```typescript
// src/check/manifest.ts
// Static expected-check extraction from checks.sh, and the runtime multiset
// comparison the composer enforces. The extraction rules mirror the record
// emission pinned by test/check-manifest.test.ts's characterization block.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CheckManifest,
  CheckManifestSchema,
  type ManifestEntry,
} from '../contracts/check-manifest.ts';
import type { CheckPhase, CheckRecord } from '../contracts/verdict.ts';
import { FS_VERBS } from './fs-verbs.ts';
import { TRANSCRIPT_VERBS } from './transcript-dispatch.ts'; // reuse the dispatch table's exported verb names; if the export is named differently, use the same symbol src/cli/list-check-verbs.ts imports

export class ManifestExtractionError extends Error {}

export function manifestPath(scenarioDir: string): string {
  return join(scenarioDir, 'checks-manifest.json');
}

const FS_VERB_NAMES = new Set(Object.keys(FS_VERBS));
const TRANSCRIPT_VERB_NAMES = new Set(TRANSCRIPT_VERBS);

// Minimal bash tokenizer for functions-only checks.sh bodies: handles
// whitespace splitting, single quotes (no expansion), double quotes, and
// backslash escapes. Anything fancier (pipes, subshells at top level) is a
// scaffold lint violation before it ever reaches us.
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === "'" ) {
      started = true;
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new ManifestExtractionError(`unterminated quote: ${line}`);
      cur += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      started = true;
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 2; }
        else { cur += line[i]; i += 1; }
      }
      if (line[i] !== '"') throw new ManifestExtractionError(`unterminated quote: ${line}`);
      i += 1;
    } else if (c === '\\' && i + 1 < line.length) {
      started = true; cur += line[i + 1]; i += 2;
    } else if (/\s/.test(c)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
      i += 1;
    } else {
      started = true; cur += c; i += 1;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

interface RawLine { phase: CheckPhase; tokens: string[]; rawArgsHaveDollar: boolean }

function functionBodies(text: string): RawLine[] {
  const lines: RawLine[] = [];
  let phase: CheckPhase | null = null;
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const decl = /^(pre|post)\s*\(\)/.exec(s);
    if (decl) { phase = decl[1] as CheckPhase; depth += (s.match(/{/g) ?? []).length - (s.match(/}/g) ?? []).length; continue; }
    if (s === '{') { depth += 1; continue; }
    if (s === '}') { depth -= 1; if (depth <= 0) phase = null; continue; }
    if (phase && depth > 0) {
      lines.push({ phase, tokens: tokenize(s), rawArgsHaveDollar: s.includes('$') });
    }
  }
  return lines;
}

function toEntryKeyParts(tokens: string[]): { check: string; args: string[]; negated: boolean } {
  let negated = false;
  let rest = tokens;
  if (rest[0] === 'not') { negated = true; rest = rest.slice(1); }
  const head = rest[0];
  if (head === undefined) throw new ManifestExtractionError('empty check line');
  if (head === 'setup-helpers') {
    throw new ManifestExtractionError('setup-helpers is a setup.sh function, not a check');
  }
  if (head === 'check-transcript') {
    const verb = rest[1];
    if (verb === undefined || !TRANSCRIPT_VERB_NAMES.has(verb)) {
      throw new ManifestExtractionError(`unknown transcript verb: ${verb ?? '(none)'}`);
    }
    // Emission rule (Task 1 characterization): plain → inner verb name;
    // negated → wrapper name with the full wrapped argv as args.
    return negated
      ? { check: 'check-transcript', args: rest.slice(1), negated: true }
      : { check: verb, args: rest.slice(2), negated: false };
  }
  if (!FS_VERB_NAMES.has(head)) {
    throw new ManifestExtractionError(`unknown check verb: ${head}`);
  }
  return { check: head, args: rest.slice(1), negated };
}

export function extractManifest(checksShPath: string): CheckManifest {
  const text = readFileSync(checksShPath, 'utf8');
  const counted = new Map<string, ManifestEntry>();
  for (const line of functionBodies(text)) {
    const { check, args, negated } = toEntryKeyParts(line.tokens);
    const wild = line.rawArgsHaveDollar;
    const entryArgs = wild ? null : args;
    const key = JSON.stringify([line.phase, check, negated, entryArgs]);
    const prev = counted.get(key);
    if (prev) prev.count += 1;
    else counted.set(key, { phase: line.phase, check, args: entryArgs, negated, count: 1 });
  }
  return { schema_version: 1, entries: [...counted.values()] };
}

export function readManifest(scenarioDir: string): CheckManifest | null {
  const p = manifestPath(scenarioDir);
  if (!existsSync(p)) return null;
  return CheckManifestSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
}

export function writeManifest(scenarioDir: string, m: CheckManifest): void {
  writeFileSync(manifestPath(scenarioDir), `${JSON.stringify(m, null, 2)}\n`);
}

function recordKey(r: CheckRecord): string {
  return JSON.stringify([r.phase, r.check, r.negated, r.args]);
}

export function compareRecords(
  expected: CheckManifest,
  records: readonly CheckRecord[],
): { missing: string[]; unexpected: string[] } {
  const remaining = [...records];
  const missing: string[] = [];
  const take = (pred: (r: CheckRecord) => boolean): boolean => {
    const i = remaining.findIndex(pred);
    if (i === -1) return false;
    remaining.splice(i, 1);
    return true;
  };
  // Exact-args entries consume first so wildcards can't steal their records.
  const [exact, wild] = [
    expected.entries.filter((e) => e.args !== null),
    expected.entries.filter((e) => e.args === null),
  ];
  for (const e of exact) {
    for (let k = 0; k < e.count; k++) {
      const key = JSON.stringify([e.phase, e.check, e.negated, e.args]);
      if (!take((r) => recordKey(r) === key)) {
        missing.push(`${e.phase}:${e.negated ? 'not ' : ''}${e.check} ${e.args?.join(' ') ?? ''}`.trim());
      }
    }
  }
  for (const e of wild) {
    for (let k = 0; k < e.count; k++) {
      if (!take((r) => r.phase === e.phase && r.check === e.check && r.negated === e.negated)) {
        missing.push(`${e.phase}:${e.negated ? 'not ' : ''}${e.check} <wildcard>`);
      }
    }
  }
  const unexpected = remaining.map(
    (r) => `${r.phase}:${r.negated ? 'not ' : ''}${r.check} ${r.args.join(' ')}`.trim(),
  );
  return { missing, unexpected };
}
```

If `src/check/transcript-dispatch.ts` does not export a plain verb-name list, add `export const TRANSCRIPT_VERBS = Object.keys(<its dispatch table>);` there (one line, no behavior change) rather than duplicating the vocabulary.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/check-manifest.test.ts`
Expected: PASS (all characterization + extractor + compare tests).

- [ ] **Step 5: Run the full check and commit**

Run: `bun run check`
Expected: green.

```bash
git add src/check/manifest.ts src/check/transcript-dispatch.ts test/check-manifest.test.ts
git commit -m "feat: expected-check manifest extractor and multiset compare"
```

---

### Task 3: `quorum check` validation + `--update-manifests` + generate all 85 manifests

**Files:**
- Modify: `src/scaffold.ts` (inside `checkScenario`'s problem collection, alongside `validateChecksSh`)
- Modify: `src/cli/index.ts` (the `check` subcommand arg parsing)
- Create: `scenarios/*/checks-manifest.json` (generated)
- Test: `test/scaffold.test.ts` (append; if the file has another name, e.g. the one covering `checkScenario` today, append there — locate with `grep -l checkScenario test/`)

**Interfaces:**
- Consumes: `extractManifest`, `readManifest`, `writeManifest`, `manifestPath`, `ManifestExtractionError` (Task 2).
- Produces: `quorum check` fails a scenario when its manifest is missing or stale; `quorum check --update-manifests` writes/refreshes every scenario's manifest then re-validates. Scenario authoring flow becomes: edit `checks.sh` → run `bun run quorum check --update-manifests` → commit both files.

- [ ] **Step 1: Write failing tests** (append to the test file that covers `checkScenario`)

```typescript
test('checkScenario flags a missing manifest', () => {
  const dir = makeValidScenarioDir(); // use the file's existing scenario-fixture helper
  const problems = checkScenario(dir);
  expect(problems.some((p) => p.includes('checks-manifest.json missing'))).toBe(true);
});

test('checkScenario flags a stale manifest and passes a fresh one', () => {
  const dir = makeValidScenarioDir();
  writeManifest(dir, extractManifest(join(dir, 'checks.sh')));
  expect(checkScenario(dir).filter((p) => p.includes('manifest'))).toHaveLength(0);
  // Edit checks.sh without regenerating:
  appendFileSync(join(dir, 'checks.sh'), '\n'); // whitespace-only must NOT go stale
  expect(checkScenario(dir).filter((p) => p.includes('manifest'))).toHaveLength(0);
  const text = readFileSync(join(dir, 'checks.sh'), 'utf8');
  writeFileSync(join(dir, 'checks.sh'), text.replace('post() {', 'post() {\n    git-repo'));
  expect(checkScenario(dir).some((p) => p.includes('stale'))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test <that test file>`
Expected: FAIL (`checkScenario` knows nothing about manifests).

- [ ] **Step 3: Implement validation in `src/scaffold.ts`**

Add to the problems pipeline (after `validateChecksSh` returns clean — a manifest can only be judged against a parseable checks.sh):

```typescript
import { extractManifest, ManifestExtractionError, manifestPath, readManifest } from './check/manifest.ts';

function validateManifest(scenarioDir: string): string[] {
  try {
    const expected = extractManifest(join(scenarioDir, 'checks.sh'));
    const committed = readManifest(scenarioDir);
    if (committed === null) return ['checks-manifest.json missing (run: quorum check --update-manifests)'];
    if (JSON.stringify(committed) !== JSON.stringify(expected)) {
      return ['checks-manifest.json stale — checks.sh changed (run: quorum check --update-manifests)'];
    }
    return [];
  } catch (e) {
    if (e instanceof ManifestExtractionError) return [`manifest extraction: ${e.message}`];
    throw e;
  }
}
```

Entry-order determinism note: `extractManifest` iterates `checks.sh` top-to-bottom, so equality-by-stringify is stable for an unchanged file; a pure reorder of checks.sh lines legitimately reads as stale — acceptable, regeneration is one command.

In `src/cli/index.ts`, the `check` subcommand: parse `--update-manifests`; when set, before validation loop over every scenario dir run `writeManifest(dir, extractManifest(join(dir, 'checks.sh')))`, printing one line per written file; then run normal validation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test <that test file>`
Expected: PASS.

- [ ] **Step 5: Generate all 85 manifests and validate**

```bash
bun run quorum check --update-manifests
bun run quorum check
```

Expected: 85 `checks-manifest.json` files created; `quorum check` fully green. If any scenario's extraction throws (unknown verb it actually uses), STOP — that is a real vocabulary gap; add the verb name to the extractor's source-of-truth import (never hardcode) and re-run.

- [ ] **Step 6: Full check and commit**

Run: `bun run check`

```bash
git add src/scaffold.ts src/cli/index.ts test/ scenarios/*/checks-manifest.json
git commit -m "feat: quorum check validates expected-check manifests; generate all 85"
```

---

### Task 4: Composer enforcement

**Files:**
- Modify: `src/composer.ts`
- Create: `test/composer-manifest.test.ts`

**Interfaces:**
- Consumes: `CheckManifest` (Task 1), `compareRecords` (Task 2).
- Produces: `ComposeArgs` gains `expected: CheckManifest | null` (REQUIRED field — every call site must decide; `null` = legacy/no-manifest, current behavior). Task 5 threads it from the runner.

Enforcement position: after the existing error / failed-pre / no-gauntlet / gauntlet-incomplete / empty-capture gates, BEFORE the pass path — those earlier gates already yield `indeterminate`, and an empty-capture trace situation is already handled; the manifest catches the remaining hole (records that vanished or appeared while everything else looks healthy).

- [ ] **Step 1: Write failing tests**

```typescript
// test/composer-manifest.test.ts
import { describe, expect, test } from 'bun:test';
import { compose } from '../src/composer.ts';
import type { CheckManifest } from '../src/contracts/check-manifest.ts';

const gauntletPass = { status: 'pass' as const, summary: 's', reasoning: 'r', run_id: 'x' };
const rec = (over = {}) => ({
  check: 'file-exists', args: ['a.txt'], negated: false, passed: true, detail: null,
  phase: 'post' as const, ...over,
});
const m = (entries: CheckManifest['entries']): CheckManifest => ({ schema_version: 1, entries });

describe('composer manifest enforcement', () => {
  test('gauntlet pass + zero records + manifest expecting post-checks → indeterminate, never pass', () => {
    const v = compose({ gauntlet: gauntletPass, checks: [], captureEmpty: false, error: null,
      expected: m([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]) });
    expect(v.final).toBe('indeterminate');
    expect(v.error?.stage).toBe('checks');
    expect(v.final_reason).toContain('manifest');
  });

  test('matching records compose exactly as before', () => {
    const v = compose({ gauntlet: gauntletPass, checks: [rec()], captureEmpty: false, error: null,
      expected: m([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]) });
    expect(v.final).toBe('pass');
  });

  test('a failed-but-present record is a FAIL verdict, not a manifest error', () => {
    const v = compose({ gauntlet: gauntletPass, checks: [rec({ passed: false })], captureEmpty: false, error: null,
      expected: m([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]) });
    expect(v.final).toBe('fail');
    expect(v.error).toBeNull();
  });

  test('unexpected extra record → indeterminate manifest error', () => {
    const v = compose({ gauntlet: gauntletPass, checks: [rec(), rec({ check: 'git-repo', args: [] })],
      captureEmpty: false, error: null,
      expected: m([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]) });
    expect(v.final).toBe('indeterminate');
  });

  test('expected: null preserves legacy behavior (zero checks still pass)', () => {
    const v = compose({ gauntlet: gauntletPass, checks: [], captureEmpty: false, error: null, expected: null });
    expect(v.final).toBe('pass');
    expect(v.final_reason).toContain('no deterministic checks');
  });

  test('manifest with legitimately empty post entries + zero post records → pass (empty-post is legal until gating suites police it)', () => {
    const v = compose({ gauntlet: gauntletPass, checks: [rec({ phase: 'pre' })], captureEmpty: false, error: null,
      expected: m([{ phase: 'pre', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]) });
    expect(v.final).toBe('pass');
  });

  test('prior gates still win: gauntlet investigate short-circuits before manifest check', () => {
    const v = compose({ gauntlet: { ...gauntletPass, status: 'investigate' }, checks: [], captureEmpty: false,
      error: null, expected: m([{ phase: 'post', check: 'file-exists', args: ['a.txt'], negated: false, count: 1 }]) });
    expect(v.final_reason).toContain('did not complete');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/composer-manifest.test.ts`
Expected: FAIL — `expected` is not a known `ComposeArgs` field (tsc error is the failure).

- [ ] **Step 3: Implement in `src/composer.ts`**

```typescript
import type { CheckManifest } from './contracts/check-manifest.ts';
import { compareRecords } from './check/manifest.ts';

export interface ComposeArgs {
  gauntlet: GauntletLayer | null;
  checks: CheckRecord[];
  captureEmpty: boolean;
  error: RunError | null;
  /** Frozen expected-check manifest; null = no manifest (legacy behavior). */
  expected: CheckManifest | null;
}
```

Insert after the `captureEmpty` gate (composer line 90 at `8cd0e80`), before the pass path:

```typescript
  if (expected) {
    const diff = compareRecords(expected, checks);
    if (diff.missing.length || diff.unexpected.length) {
      const parts = [
        diff.missing.length ? `missing: ${diff.missing.join('; ')}` : null,
        diff.unexpected.length ? `unexpected: ${diff.unexpected.join('; ')}` : null,
      ].filter((x): x is string => x !== null);
      return {
        ...base,
        final: 'indeterminate',
        final_reason: `expected-check manifest mismatch (${parts.join(' | ')})`,
        error: { stage: 'checks', message: `expected-check manifest mismatch (${parts.join(' | ')})` },
      };
    }
  }
```

- [ ] **Step 4: Run tests — the new file AND the existing composer/checks suites**

Run: `bun test test/composer-manifest.test.ts test/checks.test.ts && bun run typecheck`
Expected: composer-manifest PASS; typecheck will FAIL at every existing `compose(` call site missing `expected` — that is Task 5, so for THIS commit run only `bun test test/composer-manifest.test.ts` after adding `expected: null` at the five `src/runner/index.ts` call sites mechanically (real wiring replaces them in Task 5). Full `bun run check` must be green before committing.

- [ ] **Step 5: Commit**

```bash
git add src/composer.ts src/runner/index.ts test/composer-manifest.test.ts
git commit -m "feat: composer enforces expected-check manifest (typed checks-stage error)"
```

---

### Task 5: Runner wiring

**Files:**
- Modify: `src/runner/index.ts` (manifest load + the five call sites: 987, 1341, 1352, 1918, 1947 at `8cd0e80`)
- Test: `test/runner-unit.test.ts` (append; it is the runner's existing unit seam)

**Interfaces:**
- Consumes: `readManifest` (Task 2), `ComposeArgs.expected` (Task 4).
- Produces: every composed verdict for a scenario with a committed manifest is manifest-enforced; scenarios without one (none, after Task 3, but the code path must not crash) compose legacy.

- [ ] **Step 1: Write the failing test** (append to `test/runner-unit.test.ts`, using its existing scenario-dir fixture helpers)

```typescript
test('runner loads the scenario manifest and passes it to compose', () => {
  // Arrange a scenario dir with checks.sh + generated manifest, then exercise
  // the runner's compose path the way this file already does for verdict
  // composition (reuse its existing minimal-run harness). Assert that a
  // vanished post-check record composes indeterminate with a checks-stage
  // error mentioning "manifest".
});
```

Write it concretely against the file's existing harness — the harness already fabricates `pre`/`post` `runPhase` results; the new test fabricates records missing one manifest entry.

- [ ] **Step 2: Run to verify failure** — `bun test test/runner-unit.test.ts` → FAIL (compose sites still pass `expected: null`).

- [ ] **Step 3: Implement**

At the point where the runner resolves `scenarioDir` for checks (same place `checksSh` is derived), load once:

```typescript
const expectedChecks = readManifest(scenarioDir); // null-safe: absent file = null
```

Replace `expected: null` with `expected: expectedChecks` at all five call sites. On the early-error sites (987, 1341, 1352, 1918) the value is inert — `compose` short-circuits on `error` first — but threading the real value everywhere keeps the call sites uniform and future-proof.

- [ ] **Step 4: Run the full suite** — `bun run check` → green.

- [ ] **Step 5: Commit**

```bash
git add src/runner/index.ts test/runner-unit.test.ts
git commit -m "feat: runner threads scenario expected-check manifest into verdict composition"
```

---

### Task 6: Verb-level planted negatives (both check families)

**Files:**
- Modify: `test/check-tool.test.ts` (fs verbs), `test/check-transcript.test.ts` (transcript verbs)
- Create: `test/fixtures/atif-mutations/` — only if the existing transcript-test fixtures aren't reusable inline (prefer the file's existing fixture style)

**Interfaces:**
- Consumes: the verb vocabularies (`FS_VERBS`, `TRANSCRIPT_VERBS`).
- Produces: for EVERY verb in both vocabularies, at least one test proving the verb **fails (passed=false, negated=false) on its target defect**. This is the "a check that returns the wrong boolean" insurance at the verb level; per-scenario planted fixtures arrive later with gating-suite registration (per the spec).

- [ ] **Step 1: Write the coverage-gate test first** (append to each file)

```typescript
// test/check-tool.test.ts
import { FS_VERBS } from '../src/check/fs-verbs.ts';
import { NEGATIVE_COVERED } from './helpers/planted-negative-registry.ts';

test('every fs verb has a planted-negative case', () => {
  for (const verb of Object.keys(FS_VERBS)) {
    expect(NEGATIVE_COVERED.fs, `fs verb lacks planted negative: ${verb}`).toContain(verb);
  }
});
```

Create `test/helpers/planted-negative-registry.ts` exporting `NEGATIVE_COVERED = { fs: [...], transcript: [...] }`; each planted-negative test registers its verb there (a literal string list kept adjacent to the tests — the gate test makes omissions loud). Mirror the same gate in `test/check-transcript.test.ts` over `TRANSCRIPT_VERBS`.

- [ ] **Step 2: Run both files** — the gate tests FAIL, printing exactly which verbs lack negatives (many may already be covered; the failure list is the work queue).

- [ ] **Step 3: Fill the gaps.** For each uncovered fs verb: a case with a real defect fixture (e.g. `file-contains` against a file lacking the needle; `git-clean` against a dirty tree; `command-succeeds` with a false command) asserting `passed: false`. For each uncovered transcript verb: a mutated trajectory per the spec's three mutation classes, e.g.:

```typescript
test('skill-before-tool fails when the tool call precedes the skill (reorder mutation)', () => {
  const t = trajectoryWith([toolCall('Write'), skillLoad('superpowers:brainstorming')]); // reuse this file's builders
  expect(runVerb('skill-before-tool', ['superpowers:brainstorming', 'Write'], t).passed).toBe(false);
});
test('tool-not-called fails when the prohibited call is present (insertion mutation)', () => {
  const t = trajectoryWith([toolCall('Bash')]);
  expect(runVerb('tool-not-called', ['Bash'], t).passed).toBe(false);
});
test('tool-called fails when the call was dropped (deletion mutation)', () => {
  const t = trajectoryWith([]);
  expect(runVerb('tool-called', ['Write'], t).passed).toBe(false);
});
```

Use the two files' existing invocation helpers (`check-tool.test.ts` and `check-transcript.test.ts` both already spawn the real CLIs); do not invent new harness machinery.

- [ ] **Step 4: Run the full suite** — `bun run check` → green, gate tests included.

- [ ] **Step 5: Commit**

```bash
git add test/check-tool.test.ts test/check-transcript.test.ts test/helpers/planted-negative-registry.ts test/fixtures/
git commit -m "test: planted-negative coverage gate for every fs and transcript check verb"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/scenario-authoring.md` (the checks.sh section), `CLAUDE.md` (Scenario Conventions + `src/check/` architecture bullets)

**Interfaces:** none — prose only.

- [ ] **Step 1: `docs/scenario-authoring.md`** — add a "Expected-check manifests" subsection to the checks.sh material: what `checks-manifest.json` is (frozen expected multiset; the composer refuses to compose a verdict whose records don't match it), the authoring loop (`edit checks.sh → bun run quorum check --update-manifests → commit both files`), the wildcard rule for `$`-bearing args, and that `quorum check` fails on missing/stale manifests.

- [ ] **Step 2: `CLAUDE.md`** — one line in Scenario Conventions ("`checks-manifest.json` is generated (`quorum check --update-manifests`), committed, and enforced by the composer — a run whose check records don't match it composes `indeterminate`, never `pass`") and extend the `src/check/` architecture bullet with `manifest.ts`.

- [ ] **Step 3: Run `bun run check`** (docs shouldn't break anything; pristine-output rule) and commit:

```bash
git add docs/scenario-authoring.md CLAUDE.md
git commit -m "docs: expected-check manifest convention"
```

---

## Self-Review

**Spec coverage** (fix-now item 1, bullet 2 of the campaign-platform spec): expected-check manifest as exact multiset of `{phase, check, args, negated, multiplicity}` — Tasks 1–3; composer returns typed instrument failure, never pass, on mismatch — Task 4 (stage `checks`, the real enum's member; the spec's fix-now bullet is satisfied without new enum members); planted negatives covering BOTH families with mutated-ATIF transcript fixtures — Task 6; conditional-check caveat (K3 A) — resolved by verified fact (zero conditionals) + extractor throws on anything it can't tokenize; "empty expected post set illegal for gating scenarios" — deliberately deferred to gating-suite registration (kernel scope), with legacy empty-post behavior preserved and tested (Task 4, test 6). Gap check: the spec's `phase`-preserving CheckRecord note is honored (manifest keys on phase); the five-key CheckRecord extension is kernel scope, not this plan.

**Placeholder scan:** Task 5 step 1 describes its test against the existing harness rather than shipping literal code — acceptable because the harness's helper names must be read from the file, but the assertion content is fully specified. No TBDs remain elsewhere.

**Type consistency:** `expected: CheckManifest | null` (Tasks 4/5) matches Task 1's export; `compareRecords(expected, records)` signature identical in Tasks 2 and 4; `ManifestEntry.count` used consistently; `TRANSCRIPT_VERBS` export introduced once (Task 2) and consumed in Task 6.
