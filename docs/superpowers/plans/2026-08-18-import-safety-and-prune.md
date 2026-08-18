# Import Safety Contract + Guarded Prune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make appliance import evidence-safe — a landed run directory is never deleted or modified by tooling — and add a guarded, quarantine-only `prune` for incomplete run dirs.

**Architecture:** Rewrite `importLocked`'s per-entry landing to stage → compare → atomic-rename with a typed conflict rejection (the spec's exact contract: absent → stage/verify/atomic-rename; byte-identical → idempotent skip; conflict → typed rejection, committed evidence untouched; quarantine applies only to the incoming staged payload). Add `evals-appliance prune` (dry-run by default; `--apply` moves candidates to `state/quarantine/` via rename — never a recursive delete) for run dirs that are incomplete (no `verdict.json`), older than an age floor, and unreferenced by batches, appliance job records, or campaign dirs.

**Tech Stack:** TypeScript on Bun ≥1.3, zod contracts, commander CLI, `bun test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` — "Order of operations", fix-now item 1, bullets 3–4 (lines 628–638), quoted verbatim in Global Constraints below.

## Global Constraints

- Bun ≥ 1.3; `bun run check` (biome + tsc + bun test) must be green at every commit.
- All tests hermetic: real filesystem via `mkdtempSync` tmpdirs only (the existing `test/appliance-import.test.ts` pattern), no network, no SSH, no live evals.
- **The plan's own invariant: tooling never recursive-deletes and never overwrites anything under `results_root`.** The only mutation primitives permitted on landed data are `renameSync` into place (absent destination) and `renameSync` into `state/quarantine/`.
- Repo rule: never weaken an existing test. One existing test encodes semantics this plan removes by spec mandate — `'--force replaces an already-imported run'` (`test/appliance-import.test.ts:227–241` at `fa45a9a`). It is REPLACED by the conflict-contract test in Task 2 with the inverse expectation; this is a contract change, not a weakening, and is called out for reviewers here.
- Commit after every task; conventional-commit style (`feat:`, `fix:`, `test:`, `docs:`).
- The runbook is updated in the same commit as the behavior it describes (recon found the runbook already overstates today's code — do not ship new behavior with stale docs).
- Spec text binding this plan, verbatim (`2026-08-17-quorum-campaign-platform-design.md:628–638`):
  > - `import --force`'s unconditional recursive destination delete (`src/appliance/import.ts`) replaced by the exact contract: absent → stage/verify/atomic-rename; byte-identical → idempotent skip; conflict → typed rejection, committed evidence untouched; quarantine applies only to the incoming staged payload.
  > - Results volume growth + guarded `prune --dry-run/--apply` that never touches runs referenced by **any campaign, sealed or unsealed** (sealed reports are deterministic over their run dirs; pruning them kills regeneration and the post-hoc re-inspection the 08-06 discreditation required). Campaign-run deletion waits for an explicit archive/retention contract.

## Recon corrections this plan is built on (verified against source @ `fa45a9a`)

1. **The delete is not gated by `--force`.** `rmSync(destRun, { recursive: true, force: true })` at `src/appliance/import.ts:210` runs for every entry that proceeds; `--force` only disables the job-record skip at `:202`. The worst case needs no flag: `alreadyImported` (`import.ts:133–143`) probes **job records, not the filesystem**, so a committed run dir with a colliding `run_id` and no job record is silently destroyed by a plain import.
2. **Latent path-traversal hazard:** `destRun = join(resultsRoot, entry.run_id)` (`import.ts:201`) with no `run_id` validation — a bundle entry whose `run_id` contains `..` would `rmSync` outside the results root. This plan adds a whole-bundle `run_id` safety check to `validateBundle` (before any path use), thrown as `config_invalid`.
3. **No temp-dir-then-rename exists**; per-entry failures are swallowed (`catch { failed += 1 }` at `:255–256`, error discarded).
4. **The runbook already lies:** "runs already present are skipped" (line 217) is false for dir-present/job-record-absent; "rejected whole rather than partially applied" (lines 213–215) holds for validation only. Task 2 rewrites that paragraph.
5. **No prune/retention/disk code exists anywhere**; `import.ts:210` is the only delete under `results_root`. Local datapoint for motivation: this workstation's `results/` is 78 GB / 939 run dirs. (The panel's "3–8 days headroom" figure is NOT sourced in-repo — do not cite it.)
6. **Campaigns do not exist in code yet.** The prune guard scans today's reference set (batches' `results.jsonl`, appliance job records) plus a fail-closed substring scan of `<evals.path>/campaigns/` when that dir exists, so campaign-referenced runs are protected the day the kernel lands without a prune change.

## File Structure

- `src/appliance/safe-fs.ts` — NEW: `assertInsideRoot`, `dirsEquivalent`, `moveToQuarantine`.
- `src/appliance/errors.ts` — MODIFY: add `'import_conflict'` to `ApplianceErrorCodeSchema`.
- `src/appliance/import.ts` — MODIFY: landing-loop rewrite per the contract; `run_id` safety check in `validateBundle`; `recordImportJob` factored out; `ImportArgs` loses `force`; `ImportResult` gains `healed` + `failures`.
- `src/appliance/prune.ts` — NEW: `planPrune` (pure enumeration) + `prune` (dry-run report / lock-holding apply) + `collectReferencedRunIds` + `collectCampaignProtected`.
- `src/appliance/cli.ts` — MODIFY: remove `--force` from `import`; add the `prune` command.
- `test/appliance-safe-fs.test.ts` — NEW.
- `test/appliance-import.test.ts` — MODIFY (mechanical arg updates + contract tests).
- `test/appliance-cli.test.ts` — MODIFY (import args test; prune wiring test).
- `test/appliance-prune.test.ts` — NEW.
- `docs/appliance-runbook.md` — MODIFY (import section rewrite in Task 2; prune section in Task 3).

---

### Task 1: Safe filesystem primitives

**Files:**
- Create: `src/appliance/safe-fs.ts`
- Test: `test/appliance-safe-fs.test.ts`

**Interfaces:**
- Consumes: `ApplianceError` (`src/appliance/errors.ts`), `mkdirPrivate` (`src/appliance/fs.ts:15–18`), `LoadedApplianceConfig` (`src/appliance/types.ts`).
- Produces (Tasks 2 and 3 rely on these exact signatures):
  - `assertInsideRoot(root: string, target: string): void` — throws `ApplianceError('config_invalid', ...)` when `target` is the root itself or escapes it (lexically, or via symlink through the nearest existing ancestor).
  - `dirsEquivalent(a: string, b: string, opts?: { exclude?: readonly string[] }): boolean` — same relative file set (minus exclusions, matched against the relative path exactly) AND same `Bun.SHA256` hex per file.
  - `moveToQuarantine(loaded: LoadedApplianceConfig, sourcePath: string, name: string): string` — `assertInsideRoot(results_root, sourcePath)`, then `renameSync` into `state/quarantine/<stamp>-<name>/` (suffix `-2`, `-3`… on collision), returning the destination. `EXDEV` → typed `ApplianceError('config_invalid', 'quarantine', ...)`, never a copy-delete fallback.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/appliance-safe-fs.test.ts
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplianceError } from '../src/appliance/errors.ts';
import {
  assertInsideRoot,
  dirsEquivalent,
  moveToQuarantine,
} from '../src/appliance/safe-fs.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
}

// Minimal LoadedApplianceConfig shape: moveToQuarantine reads
// config.container.results_root and config.root only.
function fakeLoaded(root: string): LoadedApplianceConfig {
  mkdirSync(join(root, 'evals/results'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'q', results_root: join(root, 'evals/results') },
    },
    bundle: { bundle_id: 'b', rotated_at: 'x', providers: [], note: 't' },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  } as LoadedApplianceConfig;
}

test('assertInsideRoot accepts a child and rejects the root itself and escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-root-'));
  assertInsideRoot(root, join(root, 'a/b.txt')); // does not throw
  expect(() => assertInsideRoot(root, root)).toThrow(ApplianceError);
  expect(() => assertInsideRoot(root, join(root, '..', 'outside'))).toThrow(ApplianceError);
});

test('assertInsideRoot rejects a symlink escape through an existing ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'safe-outside-'));
  symlinkSync(outside, join(root, 'link'));
  expect(() => assertInsideRoot(root, join(root, 'link', 'x.txt'))).toThrow(ApplianceError);
});

test('dirsEquivalent: identical trees true; drift, missing, extra false; exclusion honored', () => {
  const a = mkdtempSync(join(tmpdir(), 'tree-a-'));
  const b = mkdtempSync(join(tmpdir(), 'tree-b-'));
  tree(a, { 'verdict.json': '{"final":"pass"}', 'sub/x.txt': 'x' });
  tree(b, { 'verdict.json': '{"final":"pass"}', 'sub/x.txt': 'x' });
  expect(dirsEquivalent(a, b)).toBe(true);
  writeFileSync(join(b, 'verdict.json'), '{"final":"fail"}');
  expect(dirsEquivalent(a, b)).toBe(false);
  tree(b, { 'verdict.json': '{"final":"pass"}', 'extra.txt': 'e' });
  expect(dirsEquivalent(a, b)).toBe(false);
  // The import-provenance exclusion case: b gains ONLY the excluded file:
  tree(a, { 'appliance-provenance.json': '{"kind":"imported"}' });
  expect(dirsEquivalent(a, b, { exclude: ['appliance-provenance.json', 'extra.txt'] })).toBe(true);
});

test('moveToQuarantine renames (never copies) into state/quarantine and returns the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const src = join(loaded.config.container.results_root, 'run-1');
  tree(src, { 'verdict.json': 'v' });
  const dest = moveToQuarantine(loaded, src, 'prune-run-1');
  expect(existsSync(src)).toBe(false);
  expect(readFileSync(join(dest, 'verdict.json'), 'utf8')).toBe('v');
  expect(dest).toContain(join('state', 'quarantine'));
});

test('moveToQuarantine suffixes on collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const mk = (name: string) => {
    const src = join(loaded.config.container.results_root, name);
    tree(src, { 'v.txt': name });
    return src;
  };
  // Same logical name twice within one stamp second → second gets a suffix.
  const d1 = moveToQuarantine(loaded, mk('run-a'), 'prune-run-a');
  const d2 = moveToQuarantine(loaded, mk('run-b'), 'prune-run-a');
  expect(d1).not.toBe(d2);
  expect(existsSync(d1)).toBe(true);
  expect(existsSync(d2)).toBe(true);
});

test('moveToQuarantine refuses a source outside the results root', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-'));
  const loaded = fakeLoaded(root);
  const outside = mkdtempSync(join(tmpdir(), 'not-results-'));
  expect(() => moveToQuarantine(loaded, outside, 'x')).toThrow(ApplianceError);
  expect(existsSync(outside)).toBe(true); // untouched
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/appliance-safe-fs.test.ts`
Expected: FAIL — `src/appliance/safe-fs.ts` does not exist.

- [ ] **Step 3: Implement `src/appliance/safe-fs.ts`**

```typescript
// src/appliance/safe-fs.ts
// Path-validated, delete-free filesystem moves for landed evidence. The only
// mutation primitive here is renameSync: into place, or into quarantine.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ApplianceError } from './errors.ts';
import { mkdirPrivate } from './fs.ts';
import type { LoadedApplianceConfig } from './types.ts';

// Resolve target against root and refuse the root itself or any escape —
// lexically, and via symlink through the nearest existing ancestor.
export function assertInsideRoot(root: string, target: string): void {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r || !t.startsWith(r + sep)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `refusing path outside root: ${target}`,
    );
  }
  let cursor = t;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const realBase = realpathSync(r);
  const realCursor = realpathSync(cursor);
  if (realCursor !== realBase && !realCursor.startsWith(realBase + sep)) {
    throw new ApplianceError(
      'config_invalid',
      'safe-fs',
      `refusing symlink escape: ${target}`,
    );
  }
}

function listFiles(root: string, exclude: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>(); // rel -> abs
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(p);
      } else if (entry.isFile()) {
        const rel = relative(root, p);
        if (!exclude.has(rel)) out.set(rel, p);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

// Byte-identity over relative file sets: same paths (minus exclusions) and the
// same sha-256 per file. Exclusions match relative paths exactly — import adds
// 'appliance-provenance.json' to a landed run dir, so the bundle payload and
// the landed dir compare equal only with that file excluded.
export function dirsEquivalent(
  a: string,
  b: string,
  opts?: { exclude?: readonly string[] },
): boolean {
  const exclude = new Set(opts?.exclude ?? []);
  const fa = listFiles(a, exclude);
  const fb = listFiles(b, exclude);
  if (fa.size !== fb.size) return false;
  for (const [rel, pa] of fa) {
    const pb = fb.get(rel);
    if (pb === undefined) return false;
    if (
      Bun.SHA256.hash(readFileSync(pa), 'hex') !==
      Bun.SHA256.hash(readFileSync(pb), 'hex')
    ) {
      return false;
    }
  }
  return true;
}

// O(1) rename into state/quarantine/ — never a recursive copy, never a delete.
// state/ sits beside the results root under the appliance root, so this is
// same-volume by construction; a cross-volume surprise is a typed error, not a
// copy-delete fallback.
export function moveToQuarantine(
  loaded: LoadedApplianceConfig,
  sourcePath: string,
  name: string,
): string {
  assertInsideRoot(loaded.config.container.results_root, sourcePath);
  const qroot = join(loaded.config.root, 'state', 'quarantine');
  mkdirPrivate(qroot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = join(qroot, `${stamp}-${name}`);
  for (let n = 2; existsSync(dest); n += 1) {
    dest = join(qroot, `${stamp}-${name}-${n}`);
  }
  try {
    renameSync(sourcePath, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new ApplianceError(
        'config_invalid',
        'quarantine',
        `quarantine is cross-volume for ${sourcePath}; refusing copy-delete fallback`,
      );
    }
    throw error;
  }
  return dest;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/appliance-safe-fs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full check and commit**

Run: `bun run check` → green.

```bash
git add src/appliance/safe-fs.ts test/appliance-safe-fs.test.ts
git commit -m "feat: path-validated quarantine move + directory byte-identity helpers"
```

---

### Task 2: Import landing contract (stage → compare → atomic rename; typed conflict)

**Files:**
- Modify: `src/appliance/errors.ts` (enum)
- Modify: `src/appliance/import.ts`
- Modify: `src/appliance/cli.ts` (`--force` removal)
- Test: `test/appliance-import.test.ts`, `test/appliance-cli.test.ts`
- Docs: `docs/appliance-runbook.md` (Step 3 paragraph, lines 213–218)

**Interfaces:**
- Consumes: `dirsEquivalent`, `moveToQuarantine` (Task 1); existing `alreadyImported`, `createJob`/`updateJob`/`readJob`, `writeImportedProvenance`, `acquireLock` (all unchanged).
- Produces:
  - `ImportArgs` = `{ readonly bundleDir: string }` (**`force` removed**).
  - `ImportResult` = `{ imported, skipped, healed, failed, failures: readonly ImportFailure[], run_ids }` where `ImportFailure = { readonly run_id: string; readonly code: ApplianceErrorCode | 'unknown'; readonly message: string }`.
  - `ApplianceErrorCodeSchema` gains `'import_conflict'`.
  - New per-entry semantics: stage to a sibling tmp dir → if destination absent, `renameSync` into place and record the job; if destination byte-identical (excluding `appliance-provenance.json`), discard the stage and skip — creating (healing) the job record when none exists; if different, quarantine the STAGED payload and record an `import_conflict` failure — **the landed directory is never touched**. Per-entry failures keep their error message (no more swallowed `catch`).

- [ ] **Step 1: Write the failing tests** (edit `test/appliance-import.test.ts`)

Mechanical: every `importBundle(cfg, { bundleDir: X, force: false })` call becomes `importBundle(cfg, { bundleDir: X })`.

REPLACE the test `'--force replaces an already-imported run'` (lines 227–241) with (this is the sanctioned contract-change replacement per Global Constraints — the new test asserts the INVERSE of the old one):

```typescript
test('a conflicting destination is rejected: landed run untouched, payload quarantined', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  importBundle(cfg, { bundleDir: bundle });
  const landed = join(cfg.config.container.results_root, RUN_ID, 'verdict.json');
  writeFileSync(landed, 'STALE');

  const second = importBundle(cfg, { bundleDir: bundle });
  expect(second.imported).toBe(0);
  expect(second.failed).toBe(1);
  expect(second.failures[0]?.code).toBe('import_conflict');
  // The landed evidence is byte-for-byte what it was:
  expect(readFileSync(landed, 'utf8')).toBe('STALE');
  // The incoming payload was quarantined intact, not deleted:
  const qroot = join(cfg.config.root, 'state', 'quarantine');
  const qdirs = readdirSync(qroot);
  const qname = qdirs.find((d) => d.includes(RUN_ID));
  expect(qname).toBeDefined();
  expect(
    readFileSync(join(qroot, qname as string, 'verdict.json'), 'utf8'),
  ).not.toBe('STALE');
});
```

ADD (new coverage):

```typescript
test('a pre-existing identical run dir with no job record is record-healed, not overwritten', () => {
  const cfg = loaded();
  const bundle = makeBundle();
  // A run dir that predates appliance records (e.g. committed locally):
  const destRun = join(cfg.config.container.results_root, RUN_ID);
  mkdirSync(destRun, { recursive: true });
  // Byte-identical to makeBundle's payload (same body string as makeBundle uses):
  writeFileSync(join(destRun, 'verdict.json'), JSON.stringify({ schema: 1, final: 'pass' }));

  const result = importBundle(cfg, { bundleDir: bundle });
  expect(result.imported).toBe(0);
  expect(result.healed).toBe(1);
  expect(readJob(cfg, RUN_ID).artifacts.run_id).toBe(RUN_ID);
});

test('a manifest run_id with path traversal is rejected before anything lands', () => {
  const cfg = loaded();
  const dir = makeBundle();
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].run_id = '../../evil';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expectCode(() => importBundle(cfg, { bundleDir: dir }), 'config_invalid');
  expect(existsSync(join(cfg.config.container.results_root, 'evil'))).toBe(false);
});
```

Keep the double-import idempotency test (lines 214–225) — its expectations (`imported: 0`, `skipped: 1`, one job record) still hold under the new mechanism; update only its call signature.

In `test/appliance-cli.test.ts`, update the import wiring test (~line 184: `'import forwards the bundle dir and defaults force to false'`) to the new args shape — assert the fake action receives `{ bundleDir }` with no `force` key.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/appliance-import.test.ts test/appliance-cli.test.ts`
Expected: FAIL — `force` still in `ImportArgs` (tsc), no `healed`/`failures` on the result, no `import_conflict` code.

- [ ] **Step 3: Implement**

`src/appliance/errors.ts` — add to the enum:

```typescript
  'artifact_missing',
  'import_conflict',
]);
```

`src/appliance/import.ts`:

Reshape the public types:

```typescript
export interface ImportArgs {
  readonly bundleDir: string;
}

export interface ImportFailure {
  readonly run_id: string;
  readonly code: ApplianceErrorCode | 'unknown';
  readonly message: string;
}

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly healed: number;
  readonly failed: number;
  readonly failures: readonly ImportFailure[];
  readonly run_ids: readonly string[];
}
```

Add the `run_id` safety check at the TOP of `validateBundle`'s entry loop (before the payload-dir existence check, so traversal is a `config_invalid`, never an `artifact_missing`):

```typescript
const RUN_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// inside validateBundle's entry loop, first statement:
if (!RUN_ID_SAFE.test(entry.run_id) || entry.run_id.includes('..')) {
  throw new ApplianceError(
    'config_invalid',
    'import',
    `unsafe run_id in manifest: ${JSON.stringify(entry.run_id)}`,
  );
}
```

Factor the existing job-record block (current lines 215–252: origin build → `createJob` → `updateJob` → `writeImportedProvenance`) unchanged into:

```typescript
function recordImportJob(
  loaded: LoadedApplianceConfig,
  entry: BundleManifest['entries'][number],
  manifest: BundleManifest,
  importedAt: string,
  destRun: string,
): void { /* the existing block, verbatim */ }
```

Rewrite the `importLocked` per-entry loop (replacing current lines 200–258, including the `rmSync`/`cpSync`-over-live and the swallowing catch):

```typescript
  const failures: ImportFailure[] = [];
  let healed = 0;
  for (const entry of manifest.entries) {
    const destRun = join(resultsRoot, entry.run_id);
    // Stage beside the destination, then decide. The landed dir is never
    // deleted or copied over by this command.
    const staged = join(
      resultsRoot,
      `.importing-${entry.run_id}.${process.pid}.tmp`,
    );
    try {
      rmSync(staged, { recursive: true, force: true }); // a crashed import's stale stage
      cpSync(join(args.bundleDir, 'runs', entry.run_id), staged, { recursive: true });

      if (!existsSync(destRun)) {
        renameSync(staged, destRun);
        recordImportJob(loaded, entry, manifest, importedAt, destRun);
        runIds.push(entry.run_id);
        imported += 1;
        continue;
      }

      if (dirsEquivalent(staged, destRun, { exclude: ['appliance-provenance.json'] })) {
        rmSync(staged, { recursive: true, force: true });
        if (alreadyImported(loaded, entry.run_id)) {
          skipped += 1;
        } else {
          // The run dir predates appliance records: heal the record so
          // status/show see it. The dir's bytes are already correct.
          recordImportJob(loaded, entry, manifest, importedAt, destRun);
          healed += 1;
        }
        continue;
      }

      const quarantined = moveToQuarantine(loaded, staged, `import-conflict-${entry.run_id}`);
      failures.push({
        run_id: entry.run_id,
        code: 'import_conflict',
        message: `destination exists with different content; staged payload quarantined to ${quarantined}; landed run untouched`,
      });
      failed += 1;
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      failures.push({
        run_id: entry.run_id,
        code: error instanceof ApplianceError ? error.code : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
      failed += 1;
    }
  }
  return { imported, skipped, healed, failed, failures, run_ids: runIds };
```

New imports needed in `import.ts`: `renameSync` from `node:fs`; `dirsEquivalent`, `moveToQuarantine` from `./safe-fs.ts`; `type ApplianceErrorCode` from `./errors.ts`. Delete the old `// Land the payload first…` comment; the ordering rationale is now structural (stage-then-rename).

`src/appliance/cli.ts`:
- `ImportCommandArgs` (lines 46–49) loses `force`: `{ readonly bundleDir: string }`.
- The default `import` action (lines 382–388) calls `importBundle(loaded, { bundleDir: args.bundleDir })`.
- The command definition (lines 588–601): remove the `.option('--force', ...)` line and the `force: options.force ?? false` arg; update the description to `'ingest a scrubbed bundle built by quorum export-runs (never modifies landed runs; conflicts are quarantined)'`. Commander rejects a passed `--force` as an unknown option — loud, which is what we want.

`docs/appliance-runbook.md` — replace the Step 3 paragraph (lines 213–218) with:

> Import verifies every checksum in the manifest and re-runs the credential
> denylist against what is actually on disk before anything lands, so a
> tampered or mis-built bundle is rejected whole. It holds `run.lock` for the
> duration; if a live job holds it, import returns `lock_busy` and does
> nothing. Each run then lands by staging the payload beside the results root
> and atomically renaming it into place — import never modifies or deletes a
> landed run directory. Re-running is safe: a run whose landed content already
> matches the bundle is skipped, and if the run dir predates appliance job
> records the record is healed so `status`/`show` see it. If the landed run
> differs from the bundle, that entry is rejected as `import_conflict`: the
> landed run stays byte-for-byte untouched and the incoming payload is moved
> to `state/quarantine/` for comparison. Per-entry failures are reported with
> `run_id`, code, and message in the JSON result. There is no `--force`: if a
> landed run is wrong, move the bad directory aside yourself after inspection
> and re-import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/appliance-import.test.ts test/appliance-cli.test.ts`
Expected: PASS, including the replaced conflict test and the new heal/traversal tests.

- [ ] **Step 5: Full check and commit**

Run: `bun run check` → green.

```bash
git add src/appliance/errors.ts src/appliance/import.ts src/appliance/cli.ts test/appliance-import.test.ts test/appliance-cli.test.ts docs/appliance-runbook.md
git commit -m "feat: import never touches landed runs — stage/compare/atomic-rename with typed conflict quarantine"
```

---

### Task 3: Guarded `prune` (dry-run default, quarantine-only apply)

**Files:**
- Create: `src/appliance/prune.ts`
- Modify: `src/appliance/cli.ts` (command + args + action)
- Test: `test/appliance-prune.test.ts`, `test/appliance-cli.test.ts`
- Docs: `docs/appliance-runbook.md` (new subsection after the Import section)

**Interfaces:**
- Consumes: `moveToQuarantine` (Task 1), `acquireLock` (`src/appliance/locks.ts`), `readJsonFile` (`src/appliance/fs.ts`), `JobRecordSchema` (`src/appliance/types.ts:128`).
- Produces:
  - `PruneArgs` = `{ readonly apply: boolean; readonly olderThanDays: number }`.
  - `PruneCandidate` = `{ readonly name: string; readonly reason: 'incomplete' | 'stale_stage'; readonly bytes: number; readonly mtime: string }`.
  - `PruneResult` = `{ readonly dry_run: boolean; readonly scanned: number; readonly protected: number; readonly candidates: readonly PruneCandidate[]; readonly reclaimable_bytes: number; readonly quarantined: readonly { readonly name: string; readonly to: string }[]; readonly failures: readonly { readonly name: string; readonly message: string }[] }`.
  - `collectReferencedRunIds(loaded: LoadedApplianceConfig): Set<string>` — batches' `results.jsonl` + appliance job records.
  - `collectCampaignProtected(loaded: LoadedApplianceConfig, names: readonly string[]): Set<string>` — fail-closed substring scan of `<evals.path>/campaigns/` (no-op when the dir is absent).
  - `planPrune(loaded: LoadedApplianceConfig, olderThanDays: number): PruneResult` — pure enumeration, no mutation.
  - `prune(loaded: LoadedApplianceConfig, args: PruneArgs): PruneResult` — dry-run returns the plan; `--apply` re-plans under `run.lock` and `moveToQuarantine`s each candidate.
  - CLI: `evals-appliance prune [--json] [--apply] [--older-than-days <n>]` (defaults: dry-run, 7).

Candidate rule (all must hold): entry directly under `results_root`, is a directory, not `batches`; EITHER basename starts with `.importing-` (reason `stale_stage`) OR has no `verdict.json` (reason `incomplete` — a completed run is never a candidate); dir mtime older than the age floor; basename not in `collectReferencedRunIds`; basename not campaign-protected. Completed runs keep waiting for the explicit archive/retention contract (spec).

- [ ] **Step 1: Write the failing tests** (`test/appliance-prune.test.ts`)

Reuse the `loaded()` fixture pattern from `test/appliance-import.test.ts` (copy it — each test file owns its fixtures in this repo). Helpers:

```typescript
function makeRunDir(root: string, name: string, opts: { verdict: boolean; ageDays: number }): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (opts.verdict) writeFileSync(join(dir, 'verdict.json'), '{"final":"pass"}');
  writeFileSync(join(dir, 'trajectory.json'), '{}');
  const past = new Date(Date.now() - opts.ageDays * 86_400_000);
  utimesSync(dir, past, past);
}

function makeBatch(resultsRoot: string, batchId: string, runIds: readonly string[]): void {
  const dir = join(resultsRoot, 'batches', batchId);
  mkdirSync(dir, { recursive: true });
  const lines = runIds.map((id) =>
    `{"scenario": "s", "coding_agent": "a", "run_id": ${JSON.stringify(id)}}`,
  );
  writeFileSync(join(dir, 'results.jsonl'), `${lines.join('\n')}\n`);
}
```

Tests:

```typescript
test('dry-run reports incomplete unreferenced old dirs and moves nothing', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.dry_run).toBe(true);
  expect(result.candidates.map((c) => c.name)).toEqual(['old-partial']);
  expect(result.candidates[0]?.reason).toBe('incomplete');
  expect(result.reclaimable_bytes).toBeGreaterThan(0);
  expect(existsSync(join(root, 'old-partial'))).toBe(true); // dry-run moves nothing
});

test('completed runs (verdict.json) are never candidates', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, 'done-run', { verdict: true, ageDays: 90 });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(1);
});

test('batch-referenced and job-record-referenced incomplete dirs are protected', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'in-batch', { verdict: false, ageDays: 30 });
  makeRunDir(root, 'in-jobs', { verdict: false, ageDays: 30 });
  makeBatch(root, 'b1', ['in-batch']);
  const job = createJob(cfg, {
    kind: 'import', superpowersRef: 'x', argv: ['test'],
    requester: { agent: null, thread: null, task: null },
  });
  updateJob(cfg, job.job_id, (cur) => ({
    ...cur,
    artifacts: { ...cur.artifacts, run_id: 'in-jobs' },
  }));
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(2);
});

test('a run mentioned under campaigns/ is protected (fail-closed substring scan)', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'in-campaign', { verdict: false, ageDays: 30 });
  const campaigns = join(cfg.config.evals.path, 'campaigns', 'abc1-some-suite');
  mkdirSync(campaigns, { recursive: true });
  writeFileSync(join(campaigns, 'campaign.json'), '{"samples": ["in-campaign"]}');
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
  expect(result.protected).toBe(1);
});

test('dirs younger than the age floor are protected', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, 'fresh-partial', { verdict: false, ageDays: 2 });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates).toHaveLength(0);
});

test('stale import stage dirs are candidates with reason stale_stage', () => {
  const cfg = loaded();
  makeRunDir(cfg.config.container.results_root, '.importing-run-9.123.tmp', { verdict: false, ageDays: 10 });
  const result = prune(cfg, { apply: false, olderThanDays: 7 });
  expect(result.candidates[0]?.reason).toBe('stale_stage');
});

test('apply moves candidates to state/quarantine and reports destinations', () => {
  const cfg = loaded();
  const root = cfg.config.container.results_root;
  makeRunDir(root, 'old-partial', { verdict: false, ageDays: 30 });
  const result = prune(cfg, { apply: true, olderThanDays: 7 });
  expect(result.dry_run).toBe(false);
  expect(result.quarantined).toHaveLength(1);
  expect(existsSync(join(root, 'old-partial'))).toBe(false);
  expect(readFileSync(join(result.quarantined[0]?.to as string, 'trajectory.json'), 'utf8')).toBe('{}');
});

test('apply refuses while a live job holds run.lock', () => {
  const cfg = loaded();
  const held = acquireLock({ loaded: cfg, name: 'run.lock', jobId: 'job-live', command: 'run-all' });
  try {
    expectCode(() => prune(cfg, { apply: true, olderThanDays: 7 }), 'lock_busy');
  } finally {
    held.release();
  }
});
```

(`expectCode` is copied from `test/appliance-import.test.ts`; `createJob`/`updateJob` come from `src/appliance/jobs.ts`; `utimesSync` from `node:fs`.)

In `test/appliance-cli.test.ts`, add next to the import wiring test:

```typescript
test('prune defaults to a dry-run with a 7-day floor and forwards --apply', async () => {
  // Follow the file's existing injected-actions pattern: capture the args the
  // fake prune action receives for (a) bare `prune` and (b) `prune --apply`.
  // Assert (a) { apply: false, olderThanDays: 7 } and (b) { apply: true, olderThanDays: 7 }.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/appliance-prune.test.ts`
Expected: FAIL — `src/appliance/prune.ts` does not exist.

- [ ] **Step 3: Implement `src/appliance/prune.ts`**

```typescript
// src/appliance/prune.ts
// Guarded prune for incomplete run dirs. Apply never deletes: candidates are
// renamed into state/quarantine/ for operator inspection. Completed runs
// (verdict.json present) are never candidates — their retention waits for the
// explicit archive/retention contract (2026-08-17 platform spec, fix-now).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile } from './fs.ts';
import { acquireLock } from './locks.ts';
import { moveToQuarantine } from './safe-fs.ts';
import { JobRecordSchema, type LoadedApplianceConfig } from './types.ts';

export interface PruneArgs {
  readonly apply: boolean;
  readonly olderThanDays: number;
}

export interface PruneCandidate {
  readonly name: string;
  readonly reason: 'incomplete' | 'stale_stage';
  readonly bytes: number;
  readonly mtime: string;
}

export interface PruneResult {
  readonly dry_run: boolean;
  readonly scanned: number;
  readonly protected: number;
  readonly candidates: readonly PruneCandidate[];
  readonly reclaimable_bytes: number;
  readonly quarantined: readonly { readonly name: string; readonly to: string }[];
  readonly failures: readonly { readonly name: string; readonly message: string }[];
}

const BatchResultLineSchema = z
  .object({ run_id: z.string().nullable() })
  .passthrough();

// Everything that can legally point at a run dir: batch cell records and
// appliance job artifacts. (verdict.json, capture sidecars, provenance live
// INSIDE the run dir and move with it; grid-manifest references cells, not
// runs.)
export function collectReferencedRunIds(loaded: LoadedApplianceConfig): Set<string> {
  const refs = new Set<string>();
  const resultsRoot = loaded.config.container.results_root;
  const batches = join(resultsRoot, 'batches');
  if (existsSync(batches)) {
    for (const entry of readdirSync(batches, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jsonl = join(batches, entry.name, 'results.jsonl');
      if (!existsSync(jsonl)) continue;
      for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        const parsed = BatchResultLineSchema.safeParse(JSON.parse(s));
        if (parsed.success && parsed.data.run_id !== null) {
          refs.add(parsed.data.run_id);
        }
      }
    }
  }
  if (existsSync(loaded.paths.jobs)) {
    for (const entry of readdirSync(loaded.paths.jobs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobJson = join(loaded.paths.jobs, entry.name, 'job.json');
      if (!existsSync(jobJson)) continue;
      const job = readJsonFile(jobJson, JobRecordSchema, `job record ${jobJson}`);
      if (job.artifacts.run_id !== null) refs.add(job.artifacts.run_id);
    }
  }
  return refs;
}

// Fail-closed campaign guard: campaigns don't exist in code yet, so instead of
// parsing a format that would drift, substring-scan every file under
// <evals.path>/campaigns/ (when it exists) for each candidate name. A hit
// protects the run regardless of how the kernel ends up storing references.
export function collectCampaignProtected(
  loaded: LoadedApplianceConfig,
  names: readonly string[],
): Set<string> {
  const protectedNames = new Set<string>();
  const campaignsRoot = join(loaded.config.evals.path, 'campaigns');
  if (names.length === 0 || !existsSync(campaignsRoot)) return protectedNames;
  const texts: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) texts.push(readFileSync(p, 'utf8'));
    }
  };
  visit(campaignsRoot);
  for (const name of names) {
    if (texts.some((t) => t.includes(name))) protectedNames.add(name);
  }
  return protectedNames;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) total += statSync(p).size;
    }
  };
  visit(dir);
  return total;
}

export function planPrune(
  loaded: LoadedApplianceConfig,
  olderThanDays: number,
): PruneResult {
  const resultsRoot = loaded.config.container.results_root;
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const refs = collectReferencedRunIds(loaded);
  const candidates: PruneCandidate[] = [];
  let scanned = 0;

  const names: string[] = [];
  const entries: { name: string; path: string; reason: 'incomplete' | 'stale_stage' }[] = [];
  for (const entry of readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'batches') continue;
    scanned += 1;
    const p = join(resultsRoot, entry.name);
    const stat = statSync(p);
    if (stat.mtimeMs >= cutoff) continue;
    if (entry.name.startsWith('.importing-')) {
      entries.push({ name: entry.name, path: p, reason: 'stale_stage' });
    } else if (!existsSync(join(p, 'verdict.json')) && !refs.has(entry.name)) {
      entries.push({ name: entry.name, path: p, reason: 'incomplete' });
    }
    names.push(entry.name);
  }

  const campaignProtected = collectCampaignProtected(loaded, names);
  for (const e of entries) {
    if (campaignProtected.has(e.name)) continue;
    candidates.push({
      name: e.name,
      reason: e.reason,
      bytes: dirSizeBytes(e.path),
      mtime: statSync(e.path).mtime.toISOString(),
    });
  }

  return {
    dry_run: true,
    scanned,
    protected: scanned - candidates.length,
    candidates,
    reclaimable_bytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
    quarantined: [],
    failures: [],
  };
}

export function prune(loaded: LoadedApplianceConfig, args: PruneArgs): PruneResult {
  if (!args.apply) {
    // Read-only report; lockless by design (the age floor is the conservative
    // guard against in-flight runs, which hold no artifacts yet).
    return planPrune(loaded, args.olderThanDays);
  }
  // Apply mutates the results root, so it serializes with imports and live
  // batches exactly the way import does — and re-plans under the lock.
  const lock = acquireLock({
    loaded,
    name: 'run.lock',
    jobId: `prune-${Date.now().toString(36)}`,
    command: 'prune',
  });
  try {
    const plan = planPrune(loaded, args.olderThanDays);
    const quarantined: { name: string; to: string }[] = [];
    const failures: { name: string; message: string }[] = [];
    for (const c of plan.candidates) {
      try {
        const to = moveToQuarantine(
          loaded,
          join(loaded.config.container.results_root, c.name),
          `prune-${c.name}`,
        );
        quarantined.push({ name: c.name, to });
      } catch (error) {
        failures.push({
          name: c.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ...plan, dry_run: false, quarantined, failures };
  } finally {
    lock.release();
  }
}
```

`src/appliance/cli.ts`:
- Args type next to `ImportCommandArgs` (lines 46–49):

```typescript
export interface PruneCommandArgs extends BaseCommandArgs {
  readonly apply: boolean;
  readonly olderThanDays: number;
}
```

- `ApplianceActions` (after `import`, lines 78–80):

```typescript
  readonly prune: (
    args: PruneCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
```

- Default action (after the import action, lines 382–388) — alias the import to avoid method-name shadowing: `import { prune as pruneResults } from './prune.ts';` then:

```typescript
    prune: async (args) => {
      const loaded = loadApplianceConfig(undefined, { ensureState: true });
      return pruneResults(loaded, {
        apply: args.apply,
        olderThanDays: args.olderThanDays,
      });
    },
```

- Command (after the import command, lines 588–601):

```typescript
  program
    .command('prune')
    .description('quarantine incomplete, unreferenced run dirs (dry-run unless --apply)')
    .option('--json', 'emit JSON')
    .option('--apply', 'move candidates to state/quarantine instead of just reporting')
    .option(
      '--older-than-days <days>',
      'only consider directories untouched for at least this many days',
      (v: string) => Number.parseInt(v, 10),
      7,
    )
    .action((options: JsonOption & { apply?: boolean; olderThanDays?: number }) => {
      const args = {
        ...commandOptions(options),
        apply: options.apply ?? false,
        olderThanDays: options.olderThanDays ?? 7,
      };
      return handleAction(args, resolvedDeps, () => actions.prune(args));
    });
```

`docs/appliance-runbook.md` — add a subsection immediately after the Import section (before `## Dashboard`, line 234):

```markdown
## Pruning Incomplete Run Dirs

Interrupted or abandoned runs leave directories with no `verdict.json` that
nothing can read — the dashboard and `quorum show` both ignore them. Prune
quarantines them:

```bash
evals-appliance prune --json                 # dry-run report (default)
evals-appliance prune --apply --json         # move candidates to state/quarantine/
evals-appliance prune --apply --older-than-days 14
```

A directory is a candidate only when ALL of these hold: it sits directly under
the results root, it has no `verdict.json` (completed runs are never pruned —
their retention waits for an explicit archive/retention contract), its mtime is
older than the age floor (default 7 days), and nothing references it — no batch
`results.jsonl` record, no appliance job record, and no mention anywhere under
`campaigns/` (a fail-closed substring scan, so campaign-referenced runs stay
protected as the campaign kernel lands). Stale `.importing-*` stage dirs from
crashed imports are candidates too.

`--apply` holds `run.lock` (it refuses with `lock_busy` while a batch or import
is live) and **moves** candidates to `state/quarantine/` — it never deletes.
Inspect quarantined dirs there; restore one by moving it back. Final deletion
of a quarantined directory is a manual operator decision, after inspection,
with `rm -rf` typed by a human who has looked at it.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/appliance-prune.test.ts test/appliance-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `bun run check` → green.

```bash
git add src/appliance/prune.ts src/appliance/cli.ts test/appliance-prune.test.ts test/appliance-cli.test.ts docs/appliance-runbook.md
git commit -m "feat: guarded prune — dry-run report, quarantine-only apply, reference-aware"
```

---

## Self-Review

**Spec coverage** (fix-now item 1, bullets 3–4 of the campaign-platform spec):
- "absent → stage/verify/atomic-rename" — Task 2 (stage via `cpSync` to a sibling tmp, whole-bundle verify up front in the existing `validateBundle`, `renameSync` into place).
- "byte-identical → idempotent skip" — Task 2 (`dirsEquivalent` with the provenance exclusion; skip when a job record exists, record-heal when it doesn't).
- "conflict → typed rejection, committed evidence untouched" — Task 2 (`import_conflict` failure record; landed dir never written; runbook documents the manual path).
- "quarantine applies only to the incoming staged payload" — Task 2 (`moveToQuarantine(loaded, staged, …)`; the destination is never moved).
- "guarded `prune --dry-run/--apply` that never touches runs referenced by any campaign, sealed or unsealed" — Task 3 (`collectCampaignProtected` substring scan; batches + job records; completed runs categorically excluded, satisfying "campaign-run deletion waits for an explicit archive/retention contract").
- Bonus hazard closed within scope: `run_id` path traversal into the old `rmSync` (recon correction #2) — Task 2's `RUN_ID_SAFE` check in `validateBundle`.

**Placeholder scan:** Task 3's CLI test step describes the assertion against the file's injected-actions pattern without literal code (the harness's helper names must be read from the file — same accepted pattern as the composer plan's Task 5); assertion content is fully specified. No TBDs elsewhere.

**Type consistency:** `ImportArgs { bundleDir }` / `ImportResult { imported, skipped, healed, failed, failures, run_ids }` identical across Tasks 2's code, tests, and CLI wiring; `PruneCandidate.name` (not `run_id` — stage dirs aren't run ids) used consistently across `PruneResult`, tests, and the apply loop; `moveToQuarantine(loaded, sourcePath, name): string` signature identical in Tasks 1/2/3; `import_conflict` added to the enum in Task 2 and referenced only there; `protected` is a legal property name and matches the JSON snake_case style of sibling payloads.

**Deliberate scope exclusions (YAGNI, recorded so reviewers don't flag them):** no `quorum prune` workstation wiring (the library takes explicit paths, so a future local CLI is ~30 lines — the spec's volume pain is the appliance); no volume-free-space check (`statfs`) — the dry-run's `reclaimable_bytes` report is the accounting the spec item asks for; no restore command (restore = `mv`, documented in the runbook); no cross-volume copy-delete fallback (typed error instead, by design).
