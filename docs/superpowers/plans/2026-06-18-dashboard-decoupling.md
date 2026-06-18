# Dashboard Decoupling + OS Axis + Grid Manifest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard a read-only, filesystem-only viewer in its own
`packages/dashboard` workspace (zero harness imports), add the OS grid axis + rich
5-state cells, and have the harness emit the grid manifest the dashboard reads.

**Architecture:** Three phases. Phase 0 adds a harness-emitted `grid-manifest.json`
(the authoritative `scenario × agent × os` eligibility matrix). Phase 1 rebuilds the
dashboard **in place** to read manifest + `results/` only — severing every harness
import, adding 3-part `(scenario, agent, os)` cells, the 5-state taxonomy, the
two-line cell face, and the UX fixes. Phase 2 relocates it into a workspace package.
Each phase keeps `bun run check` green.

**Tech Stack:** TypeScript on Bun (≥1.3); zod for read-schemas; Bun.serve + HTMX SSE
for the dashboard; biome + tsc + `bun test` via `bun run check`.

**Spec:** `docs/superpowers/specs/2026-06-18-dashboard-decoupling-design.md`.

## Global Constraints

- The dashboard's only contracts are the filesystem: `results/` (per-run
  `verdict.json`) and `grid-manifest.json`. After phase 1, `src/dashboard/` imports
  **nothing** from `../` harness modules; after phase 2 it's a package with no quorum
  dependency. Verify with `grep -rE "from '\.\./(run-all|scheduler|agents|contracts|invariant)" src/dashboard` → empty.
- Read defensively: every `verdict.json`/manifest field read is guarded; a
  missing/wrong-typed field degrades one datum to `—`, never throws. Unknowns render
  `—`, never `$0`/`0 tok`/`0s`.
- Metrics on the **cell face are agent-scoped** (`economics.coding_agent.*`); run-total
  figures appear only in the hover card, labeled.
- Cell identity is 3-part `(scenario, agent, os)` everywhere (key, DOM id, SSE event).
- No new launch capability; no OS filter UI; no metrics beyond time/cost/tokens.
- Do not change `verdict.json` or how the runner writes it. Every consumed field
  already exists.
- `bun run check` (biome ci + tsc + bun test) and `bun run quorum check` green at the
  end of every task.

---

## Phase 0 — Harness grid manifest

### Task 1: Grid-manifest contract + OS-aware eligibility

**Files:**
- Create: `src/contracts/grid-manifest.ts`
- Modify: `src/run-all/matrix.ts` (add `buildGridManifest` beside `buildMatrix`)
- Test: `test/grid-manifest.test.ts`

**Interfaces:**
- Consumes: `buildMatrix(args: BuildMatrixArgs): MatrixEntry[]` and `MatrixEntry`
  (`{ scenario, agent, skippedReason: 'directive'|'draft'|'tier'|null, tier }`) from
  `src/run-all/matrix.ts` + `src/contracts/batch.ts`; each agent's `os_support`
  (read `coding-agents/<agent>.yaml`; default `['linux']` when the key is absent —
  follow the existing agent-config loader in `src/contracts/agent-config.ts`).
- Produces: `GridManifest` + `GridManifestCell` types and
  `buildGridManifest(args: BuildMatrixArgs): GridManifest`.

- [ ] **Step 1: Write the failing test** in `test/grid-manifest.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { buildGridManifest } from '../src/run-all/matrix.ts';

test('grid manifest fans agents across os_support and carries skip reasons', () => {
  const m = buildGridManifest({
    scenariosRoot: 'test/fixtures/grid/scenarios',
    codingAgentsDir: 'test/fixtures/grid/coding-agents',
  });
  // claude supports [linux, windows]; codex supports [linux] only:
  const claudeWin = m.cells.find(
    (c) => c.agent === 'claude' && c.os === 'windows' && c.scenario === 's1',
  );
  const codexWin = m.cells.find((c) => c.agent === 'codex' && c.os === 'windows');
  expect(claudeWin).toBeDefined();
  expect(codexWin).toBeUndefined(); // codex has no windows sub-column
  // s2 has `# coding-agents: codex` → claude is directive-excluded there:
  const claudeS2 = m.cells.find(
    (c) => c.scenario === 's2' && c.agent === 'claude' && c.os === 'linux',
  );
  expect(claudeS2?.eligible).toBe(false);
  expect(claudeS2?.skipped_reason).toBe('directive');
  expect(m.scenarios).toContain('s1');
});
```

Build the fixture dirs the test references: `test/fixtures/grid/scenarios/s1/`,
`s2/` (each with a `story.md` + `checks.sh`; `s2/checks.sh` first lines include
`# coding-agents: codex`), and `test/fixtures/grid/coding-agents/{claude,codex}.yaml`
(`claude.yaml` has `os_support: [linux, windows]`; `codex.yaml` omits `os_support`).
Mirror the shapes of the real `scenarios/*/` and `coding-agents/*.yaml`.

- [ ] **Step 2: Run it; expect FAIL** — `bun test test/grid-manifest.test.ts`
  (FAIL: `buildGridManifest is not a function`).

- [ ] **Step 3: Implement.** In `src/contracts/grid-manifest.ts`:

```ts
export interface GridManifestCell {
  readonly scenario: string;
  readonly agent: string;
  readonly os: string;
  readonly eligible: boolean;
  readonly skipped_reason: 'directive' | 'draft' | 'tier' | null;
}
export interface GridManifest {
  readonly generated_at: string;
  readonly scenarios: readonly string[];
  readonly agents: readonly string[];
  readonly cells: readonly GridManifestCell[];
}
```

In `src/run-all/matrix.ts`, add `buildGridManifest`: call the existing
`buildMatrix` to get per-`(scenario, agent)` `skippedReason`, then for each entry
fan it across that agent's `os_support` (load via the agent-config loader; default
`['linux']`). One `GridManifestCell` per `(scenario, agent, os)` with
`eligible = skippedReason === null`. `generated_at` is passed in by the caller (do
NOT call `new Date()` here if it complicates testing — accept it as a param or stamp
in the command; the test above ignores it).

- [ ] **Step 4: Run it; expect PASS** — `bun test test/grid-manifest.test.ts`.
- [ ] **Step 5: `bun run check`** green.
- [ ] **Step 6: Commit** — `git add src/contracts/grid-manifest.ts src/run-all/matrix.ts test/grid-manifest.test.ts test/fixtures/grid && git commit -m "feat(grid-manifest): OS-aware eligibility matrix contract + builder"`

### Task 2: `quorum grid-manifest` command + run-all write

**Files:**
- Modify: `src/cli/index.ts` (register a `grid-manifest` command)
- Modify: `src/run-all/index.ts` (write the manifest at batch start)
- Create: `src/run-all/write-grid-manifest.ts` (shared writer)
- Test: `test/write-grid-manifest.test.ts`

**Interfaces:**
- Consumes: `buildGridManifest` (Task 1).
- Produces: `writeGridManifest(args: { scenariosRoot, codingAgentsDir, outPath, now: string }): void`
  writing `grid-manifest.json`.

- [ ] **Step 1: Write the failing test**:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeGridManifest } from '../src/run-all/write-grid-manifest.ts';

test('writeGridManifest emits parseable JSON with cells', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'gm-')), 'grid-manifest.json');
  writeGridManifest({
    scenariosRoot: 'test/fixtures/grid/scenarios',
    codingAgentsDir: 'test/fixtures/grid/coding-agents',
    outPath: out,
    now: '2026-06-18T00:00:00Z',
  });
  const m = JSON.parse(readFileSync(out, 'utf8'));
  expect(m.generated_at).toBe('2026-06-18T00:00:00Z');
  expect(Array.isArray(m.cells)).toBe(true);
  expect(m.cells.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run; expect FAIL** (`writeGridManifest is not a function`).
- [ ] **Step 3: Implement** `src/run-all/write-grid-manifest.ts` (`buildGridManifest`
  + `writeFileSync(outPath, JSON.stringify(manifest, null, 2))`). Wire a
  `grid-manifest [--out <path>]` command into `src/cli/index.ts` (commander; default
  out `grid-manifest.json` at repo root; `now` = `new Date().toISOString()` at the
  command layer). In `src/run-all/index.ts`, call `writeGridManifest` once at batch
  start (default out alongside the results root).
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5:** `bun run check` + `bun run quorum check` green.
- [ ] **Step 6: Commit** — `git commit -m "feat(cli): quorum grid-manifest + run-all writes grid-manifest.json"`

---

## Phase 1 — Decouple + rebuild the dashboard (in place, in `src/dashboard/`)

### Task 3: Remove the launch path + dead state + launch UI

**Files:**
- Delete: `src/dashboard/orchestrator.ts`
- Modify: `src/dashboard/server.ts` (drop `POST /launch`, `POST /stop`, the `InvokeFn`
  param, `launchInfo()`), `src/dashboard/index.ts` (drop `InvokeFn`/`jobs` from
  `StartDashboardArgs`), `src/dashboard/contracts.ts` (drop the `queued` cell state +
  `RunningRun`/`Cell` fields that only the orchestrator set), `src/dashboard/view.ts`
  (drop the `queued` branch + `QUEUED_OPACITY`), `src/dashboard/templates.ts` (drop
  `data-launch`, the "▶" run buttons, `#runbar`), `src/dashboard/static/app.js` (drop
  the `/launch` + `/stop` fetches + `washColumn`/`washRow` for now if launch-only),
  `src/dashboard/static/*.css` (drop `.queued`, `#runbar`, launch-button styles),
  `src/cli/index.ts` (remove the `dashboard` subcommand + `startDashboard` import)
- Modify (split): `test/dashboard-server.test.ts` — delete the `POST /launch`/`/stop`
  tests, the `invoke` stub, the `jobs` arg, and the `InvokeChildArgs`/`ChildResult`
  imports from `src/run-all`/`src/contracts/batch`.

- [ ] **Step 1:** Delete `orchestrator.ts`; delete its test(s).
- [ ] **Step 2:** Remove `POST /launch`/`/stop` + `launchInfo()` from `server.ts`;
  remove `invoke`/`jobs` from `StartDashboardArgs` and `startDashboard`. Remove the
  `queued` `CellState` (leave `['empty','done','running']`) and the `queued` view
  branch. Remove the launch controls from `templates.ts` + `app.js` + CSS.
- [ ] **Step 3:** Remove the `dashboard` subcommand + `startDashboard` import from
  `src/cli/index.ts`. (Re-added as a standalone entrypoint in Task 8.)
- [ ] **Step 4:** In `test/dashboard-server.test.ts`, delete the launch-path tests +
  the harness imports + the `invoke`/`jobs` setup, keeping the read-path tests
  (`GET /`, `/events`, `/static/*`, SSE) compiling against the slimmed
  `startDashboard`.
- [ ] **Step 5:** `bun run check` green. Confirm no `/launch` references remain:
  `grep -rn "/launch\|/stop\|orchestrator\|queued\|InvokeFn" src/dashboard` → empty.
- [ ] **Step 6: Commit** — `git commit -m "refactor(dashboard): remove launch path, queued state, launch UI, quorum dashboard subcommand"`

### Task 4: 3-part cells + grid from manifest + results (sever read-path coupling)

**Files:**
- Modify: `src/dashboard/contracts.ts` (`Cell`/`CellView` gain `readonly os: string`;
  `cellKey(scenario, agent, os)`, `cellId(scenario, agent, os)`), `src/dashboard/scan.ts`
  (read `grid-manifest.json`; key the window by `(scenario, agent, os)`; parse the os
  segment from run-dir names — preserve the existing parser; results-only bootstrap of
  `knownAgents` from `verdict.json` `coding_agent`), `src/dashboard/view.ts` (build the
  grid from manifest cells overlaid with results), add `src/dashboard/manifest.ts`
  (local read-type + loader for `grid-manifest.json`), add `src/dashboard/invariant.ts`
  (one-line local `assertNever`)
- Remove imports: `run-all/matrix.ts` (`buildMatrix`/`knownAgentNames`),
  `contracts/batch.ts`, `../invariant.ts` from all dashboard files.
- Test: `test/dashboard-scan.test.ts` (extend/rename existing scan test)

**Interfaces:**
- Consumes: `GridManifest` JSON shape (Task 1) read from disk; `verdict.json` (its
  `coding_agent` field for the bootstrap).
- Produces: `cellKey(scenario, agent, os): string`, `cellId(scenario, agent, os): string`,
  `loadGridManifest(path: string): GridManifest | null`, and a `scanResults` that
  returns cells keyed `(scenario, agent, os)`.

- [ ] **Step 1: Write failing tests** in `test/dashboard-scan.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { cellKey } from '../src/dashboard/contracts.ts';
import { scanResults } from '../src/dashboard/scan.ts';

test('cellKey is 3-part', () => {
  expect(cellKey('s1', 'claude', 'windows')).toBe('s1\tclaude\twindows');
});

test('different-os runs of the same scenario/agent are distinct cells', () => {
  // fixture: two run dirs s1-claude-linux-… and s1-claude-windows-…
  const grid = scanResults({ resultsDir: 'test/fixtures/scan/results',
    knownAgents: ['claude'], manifest: null });
  expect(grid.cells.has(cellKey('s1', 'claude', 'linux'))).toBe(true);
  expect(grid.cells.has(cellKey('s1', 'claude', 'windows'))).toBe(true);
});

test('results-only bootstraps agents from verdict.json coding_agent', () => {
  // fixture run dir whose verdict.json has coding_agent:"claude"; knownAgents empty
  const grid = scanResults({ resultsDir: 'test/fixtures/scan/results',
    knownAgents: [], manifest: null });
  expect([...grid.cells.values()].some((c) => c.agent === 'claude')).toBe(true);
});
```

Build `test/fixtures/scan/results/` with run dirs named
`s1-claude-linux-<stamp>-<nonce>/` and `s1-claude-windows-<stamp>-<nonce>/`, each
containing a minimal `verdict.json` (`{ final:"pass", coding_agent:"claude", … }`).

- [ ] **Step 2: Run; expect FAIL** (cellKey arity / scanResults signature).
- [ ] **Step 3: Implement.** `cellKey`/`cellId`/`Cell`/`CellView` become 3-part
  (`os`). `src/dashboard/manifest.ts` exports `loadGridManifest(path)` (defensive zod
  parse → `GridManifest | null`). `scanResults({resultsDir, knownAgents, manifest})`:
  parse each run dir's `(scenario, agent, os)` (existing run-dir parser, os segment);
  when `knownAgents` is empty, first pass over completed `verdict.json`s to collect
  `coding_agent` values into `knownAgents`; window keyed `(scenario, agent, os)`. When
  `manifest` is present, the full cell set is the manifest's cells (overlaid with
  results); when null (results-only), the cell set is the observed runs. Replace the
  `buildMatrix`/`knownAgentNames`/`contracts/batch`/`../invariant` imports throughout
  the dashboard with `manifest.ts` + the local `invariant.ts`.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5:** `bun run check` green. Verify severance:
  `grep -rE "from '\.\./(run-all|scheduler|agents|contracts|invariant)" src/dashboard` → empty.
- [ ] **Step 6: Commit** — `git commit -m "refactor(dashboard): 3-part (scenario,agent,os) cells; grid from manifest + results; sever harness imports"`

### Task 5: 5-state cell taxonomy

**Files:**
- Modify: `src/dashboard/contracts.ts` (widen `DashboardVerdictSchema` to read
  `error.stage`; add a `CellStatus` = `'pass'|'failed'|'incomplete'|'not_run'|'ineligible'`),
  `src/dashboard/view.ts` (map each cell to a `CellStatus`), `src/dashboard/templates.ts`
  (distinct rendering per status; `ineligible` shows the manifest reason on hover)
- Test: `test/dashboard-view.test.ts`

**Interfaces:**
- Consumes: `verdict.final` (`pass|fail|indeterminate`), `verdict.error.stage`, and the
  manifest cell's `eligible`/`skipped_reason`.
- Produces: `cellStatus(cell, manifestCell): CellStatus`.

- [ ] **Step 1: Write failing tests**:

```ts
import { expect, test } from 'bun:test';
import { cellStatus } from '../src/dashboard/view.ts';

test('fail verdict = failed-grading (ran to completion)', () => {
  expect(cellStatus({ window: [{ final: 'fail' }] }, null)).toBe('failed');
});
test('indeterminate verdict = incomplete', () => {
  expect(cellStatus({ window: [{ final: 'indeterminate' }] }, null)).toBe('incomplete');
});
test('no runs + manifest ineligible = ineligible', () => {
  expect(cellStatus({ window: [] }, { eligible: false, skipped_reason: 'directive' }))
    .toBe('ineligible');
});
test('no runs + eligible = not_run', () => {
  expect(cellStatus({ window: [] }, { eligible: true, skipped_reason: null })).toBe('not_run');
});
```

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** `cellStatus`: newest run's `final` → `pass`/`failed`
  (`fail`)/`incomplete` (`indeterminate`); empty window → `ineligible` if the manifest
  cell is `eligible:false`, else `not_run`. Render each status with a distinct class +
  a shape glyph (✓/✗/~/·) so the triad isn't color-only; `incomplete` surfaces
  `error.stage`; `ineligible` is dimmed with `skipped_reason` in its tooltip.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5:** `bun run check` green.
- [ ] **Step 6: Commit** — `git commit -m "feat(dashboard): 5-state cells (pass/failed/incomplete/not_run/ineligible)"`

### Task 6: Rich cells — two-line face + tokens, agent-scoped

**Files:**
- Modify: `src/dashboard/contracts.ts` (`RunRecord` gains `duration_ms: number|null`,
  `total_tokens: number|null`; widen the verdict read to
  `economics.coding_agent.{est_cost_usd, duration_ms, tokens.total}` +
  `economics.total_est_cost_usd`; `CardRow` gains `time`/`tokens`),
  `src/dashboard/view.ts` (compute the face's time headline + cost line, agent-scoped;
  card rows carry time/cost/tokens + run-total cost labeled),
  `src/dashboard/templates.ts` (two-line cell face; tokens only in the card),
  `src/dashboard/static/*.css` (two-line face + widened card-row grid template)
- Test: `test/dashboard-view.test.ts`

**Interfaces:**
- Consumes: `verdict.economics`.
- Produces: `RunRecord` with `duration_ms`/`total_tokens`; `formatDuration(ms): string`,
  `formatTokens(n): string` (both → `—` for null).

- [ ] **Step 1: Write failing tests** (`formatDuration(161000) === '2m41s'`;
  `formatDuration(null) === '—'`; `formatTokens(48200) === '48.2k'`;
  a `RunRecord` parsed from a verdict with `economics.coding_agent.duration_ms` reads
  it; missing → `null`).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the formatters + the widened reads (defensive); face shows
  `formatDuration` as the headline line + agent-scoped cost (`coding_agent.est_cost_usd`,
  fall back to `total_est_cost_usd` only if agent cost absent — but label scope in the
  card); `duration_ms` falls back to `finished_at − started_at` when null. Card rows
  add time/tokens beside verdict/timestamp + run-total cost labeled. Tokens are
  card-only.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5:** `bun run check` green.
- [ ] **Step 6: Commit** — `git commit -m "feat(dashboard): two-line cell face (time/cost) + tokens in card, agent-scoped"`

### Task 7: Layout + UX fixes

**Files:**
- Modify: `src/dashboard/templates.ts` (always render the two-tier header — agent row
  spanning OS sub-columns + an OS-label row; `data-agent`+`data-os` on each
  sub-column `<th>`; tally counts OS sub-columns + a separate `ineligible` count; mode
  banner; empty-state message), `src/dashboard/static/*.css` (collapse the OS-label
  row via `visibility:hidden`/zero-height when the displayed OS set is `{linux}`;
  `position:sticky;left:0` on the scenario-label `td`; agent-group left border; SSE
  swap flash via `.htmx-added`), `src/dashboard/static/app.js` (rewrite the
  column-highlight to select by `[data-agent][data-os]`, not positional index),
  `src/dashboard/view.ts` (compute the displayed OS set + mode + tally)
- Test: `test/dashboard-templates.test.ts`

**Interfaces:**
- Consumes: the grid (Task 4) + statuses (Task 5).
- Produces: header/tally HTML asserted by the template tests.

- [ ] **Step 1: Write failing tests**: a grid with a `[linux,windows]` agent renders
  two sub-columns + a visible OS-label row; an all-linux grid renders the two-tier
  structure but with the OS row CSS-collapsed (assert the row is present in the DOM,
  class marks it collapsed); the tally string reports OS-column count + an `ineligible`
  count distinct from `not_run`; results-only mode renders the mode banner.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** per Files above.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5:** `bun run check` green.
- [ ] **Step 6: Commit** — `git commit -m "feat(dashboard): OS two-tier header, sticky scenario column, mode banner, attribute-keyed highlight, a11y glyphs"`

### Task 8: Standalone CLI entrypoint

**Files:**
- Modify: `src/dashboard/index.ts` (add `main()` arg parsing — `--results <dir>`
  default `results/`, `--port N`, `--manifest <path>` default `<root>/grid-manifest.json`,
  `--root <repo>` default cwd; resolve manifest+results; call `startDashboard`)
- Modify: `package.json` (root) — add `"dashboard": "bun src/dashboard/index.ts"`
  (re-pointed to the package path in Phase 2)
- Test: `test/dashboard-cli.test.ts`

- [ ] **Step 1: Write a failing test** for the arg parser (`parseArgs(['--results','r','--port','9'])`
  → `{ resultsDir:'r', port:9, manifestPath:…, root:… }`; defaults when omitted).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** `parseArgs` + `main()` (guarded `import.meta.main`).
- [ ] **Step 4: Run; expect PASS.** Manually: `bun run dashboard --results test/fixtures/scan/results`
  serves the grid.
- [ ] **Step 5:** `bun run check` green.
- [ ] **Step 6: Commit** — `git commit -m "feat(dashboard): standalone CLI entrypoint + root 'dashboard' script"`

---

## Phase 2 — Extract to `packages/dashboard`

### Task 9: Relocate into a zero-harness-dep workspace package

**Files:**
- Move: `src/dashboard/` → `packages/dashboard/src/`; the dashboard tests →
  `packages/dashboard/test/`
- Create: `packages/dashboard/package.json` (`@quorum/dashboard`, private, deps: only
  what the dashboard uses — zod, bun types; **no** quorum dep), `packages/dashboard/tsconfig.json`,
  `packages/dashboard/biome.json` (or extend root)
- Modify: root `package.json` (`"workspaces": ["packages/dashboard"]`; repoint
  `"dashboard"` script to `bun packages/dashboard/src/index.ts`; `"check"` runs root
  biome+tsc+test **and** the package's — e.g. append
  `&& cd packages/dashboard && bun run check`), root `biome.json` (move the
  `noConsole`-off override path; or rely on the package biome), root `tsconfig.json`
  (drop `src/dashboard` if listed)
- Modify docs: `CLAUDE.md`, `AGENTS.md` (`quorum dashboard` → `bun run dashboard`;
  document `grid-manifest.json` + `quorum grid-manifest`); fix the stale dashboard
  comment in `src/run-all/matrix.ts`.

- [ ] **Step 1:** `git mv src/dashboard packages/dashboard/src`; move the dashboard
  test files under `packages/dashboard/test/`; fix their relative import paths.
- [ ] **Step 2:** Add `packages/dashboard/{package.json,tsconfig.json,biome.json}`
  (no quorum dependency). Add root `workspaces` + repoint the `dashboard` script +
  extend root `check`.
- [ ] **Step 3:** `bun install` (link the workspace). Run the package's tests:
  `cd packages/dashboard && bun test` → green.
- [ ] **Step 4:** Root `bun run check` green (covers both). Verify structural
  enforcement: the package has no quorum dep, so importing a harness module fails —
  `grep -rE "from '\.\./\.\./src" packages/dashboard` → empty.
- [ ] **Step 5:** Update `CLAUDE.md`/`AGENTS.md` + the `matrix.ts` comment.
- [ ] **Step 6: Commit** — `git commit -m "refactor(dashboard): extract to packages/dashboard (zero harness deps)"`

---

## Self-Review

**Spec coverage:** grid manifest (Tasks 1–2) ✓; decouple/sever imports (Tasks 3–4) ✓;
3-part OS cells + bucketing fix (Task 4) ✓; 5-state taxonomy (Task 5) ✓; two-line
agent-scoped face + tokens-in-card (Task 6) ✓; two-tier header / sticky column /
mode banner / attribute-keyed highlight / tally+ineligible / a11y / SSE flash /
empty-state (Task 7) ✓; CLI entrypoint + `dashboard` script + `quorum dashboard`
removal (Tasks 3, 8) ✓; package extraction + tooling + docs (Task 9) ✓; results-only
bootstrap (Task 4) ✓.

**Placeholder scan:** code shown for new components (manifest types/builder/writer,
formatters, cellStatus, parseArgs); modifications name exact files/functions + the
precise change (a refactor's implementer reads the current code). No "TBD"/"handle
edge cases".

**Type consistency:** `cellKey`/`cellId`/`Cell`/`CellView` are 3-part from Task 4 on;
`CellStatus` (Task 5) is used by Task 7; `RunRecord.duration_ms`/`total_tokens` (Task 6)
match the formatters; `GridManifest`/`GridManifestCell` (Task 1) are the same shape
read in Task 4 (`loadGridManifest`) and written in Task 2.

**Sequencing note:** Phase 0 is independent and can land first. Within Phase 1, Task 3
(remove launch) must precede Task 4 (it removes the `InvokeFn`/`queued` surface Task 4
would otherwise trip on); Tasks 5–7 build on Task 4's 3-part grid; Task 8 is last in
Phase 1. Phase 2 is a no-logic move.
