# Quorum Dashboard — TypeScript Port (Spec 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Python `quorum/dashboard/` web UI (PRI-2185) to TypeScript/Bun, reaching semantic parity with the build + visual specs while consuming the already-ported TS scheduler.

**Architecture:** A new `src/dashboard/` package — read-side (`scan` + pure `view`) over `results/`, typed template-literal HTML renderers (no Jinja, no templating dep), an in-process SSE `EventBus`, and an `Orchestrator` that drives `runSchedule` (Spec 4) with pid-tracked children for graceful stop. Served by native `Bun.serve` (no FastAPI/uvicorn equivalent). Three small additive changes to the TS runner — `phase.json`, verdict self-identity, graceful-SIGINT verdict — provide the liveness + identity signals the read-side and Stop depend on.

**Tech Stack:** TypeScript on Bun (`Bun.serve`, `ReadableStream` SSE), zod at JSON boundaries, vanilla htmx + CSS copied verbatim from the Python reference. Full-strict tsc per `docs/superpowers/specs/2026-06-12-typescript-coding-standard.md`. Gate = `bun run check`.

---

## Reference & Altitude

This is a **port with a working reference**, not greenfield. The Python lives in the read-only worktree `.worktrees/dashboard-ref/quorum/dashboard/` (app.py 321, data.py 566, orchestrator.py 200, templates/*.j2, static/*). The authoritative specs are `.worktrees/dashboard-ref/docs/superpowers/specs/2026-06-11-quorum-dashboard-{build,visual}-design.md`.

Because the reference exists, task bodies give **exact files, complete public signatures, parity-critical constants/formulas verbatim, and complete test code** — but for mechanical bodies (scan loop, route wiring, CSS) they say *"port from `<ref>:<lines>`, preserving X"* rather than transcribing. **Semantic parity, not byte-for-byte:** reproduce routes, the SSE event contract, cell-state semantics, the launch/stop/409 behavior, scanner cadence, and the read-side math exactly; HTML/CSS markup ports ~1:1 (copy the static assets verbatim — appearance is a deliverable), but server-side wording/whitespace may vary where it doesn't affect htmx wiring.

**Parity-critical invariants (must match the Python exactly):**
- Cell id format: `cell-<scenario>-<agent>`; the `<td>` carries `id` + `sse-swap` both equal to it, `hx-swap="outerHTML"`.
- Cell states: `'empty' | 'done' | 'running' | 'queued'`. Slot kinds: `'pass' | 'fail' | 'indeterminate' | 'unknown' | 'ghost' | 'running'`.
- Window = 5 newest runs per cell, newest **rightmost**, left-padded with `ghost` slots.
- Authority rule: once `verdict.json` exists for a dir, `phase.json` is **ignored** for it.
- Liveness: a dir with `phase.json` + no verdict shows running **iff its recorded `pid` is alive**; dead/absent pid ⇒ abandoned, excluded from display.
- `stale_opacity(age_days) = 0.34 + 0.66 * exp(-age_days / 6.0)`; queued cell opacity = `0.5`; running = `1.0`.
- `drift_flag(costs)` (costs oldest..newest): `true` iff `costs.length >= 1` **and** `priors = costs.slice(0, -1)` has `length >= 2` **and** `last > 1.5 * median(priors)`.
- `cost_bar_heights(costs)`: `peak = max(...costs, 0)`; `h = peak > 0 ? c / peak : 0`; ghost/running slot height floor = `0.18`.
- `launch_estimate`: cell-window mean → that agent's grid-wide latest-cost mean → global latest-cost mean → `undefined` (chip shows `~$—`).
- `format_age(days)`: `<60s → "Ns"`, `<60m → "Nm"`, `<24h → "Nh"`, else `"Nd"` (integer floor each).
- Run-dir parse: `/-(\d{8}T\d{6}Z)-([0-9a-f]{4})$/`, agent via **longest-suffix** match over the known-agent list (try `claude-haiku` before `haiku`); unparseable dirs and `batches/` are skipped.
- SSE per-client queue bound = **256**, drop-oldest on overflow (idempotent full-state partials make lossy delivery safe).
- Scanner cadence ≈ **1s**, only while ≥1 SSE client is connected.
- `/launch` returns **409** when a session is already active. `/stop` sends **SIGINT** (never SIGTERM) to in-flight children.
- Phase vocabulary is `setup → agent → checks` (build spec drops `grade`; the read-side renders whatever string `phase.json` carries).

**Coding-standard reminders:** no `any`/`as any`/non-null `!`; bracket-access index signatures; `import type`; `//` comments only; `src/env.ts` is the only `process.env` reader; assign class fields in the body (no constructor parameter properties). Use `assertNever` (`src/invariant.ts`) on closed unions.

---

## File Structure

**New — `src/dashboard/`:**
- `contracts.ts` — zod schemas + inferred types: `PhaseJson`, `DashboardVerdict` (narrow read-side view), `RunRecord`, `RunningRun`, `Cell`, `Grid`, `SlotView`, `CardRow`, `CardView`, `CellView`, `HeaderTally`. The cell-state and slot-kind literal unions live here.
- `scan.ts` — `parseRunDirName`, `pidAlive`, `readDashboardVerdict` (cached), `scanResults(resultsRoot, knownAgents) → Grid`. All read-side IO.
- `view.ts` — pure functions: `staleOpacity`, `driftFlag`, `costBarHeights`, `median`, `formatAge`, `latestAgeDays`, `launchEstimate`, `headerTally`, `cellView`, `diffGrids`. No IO.
- `templates.ts` — `esc`, `cellHtml(view)`, `gridHtml(...)`, `tallyHtml(tally)`, `runStripHtml(...)`, `layoutHtml(...)`. Typed template-literal renderers; `cellHtml` is the single source of truth for first paint **and** SSE swaps.
- `event-bus.ts` — `BoundedQueue<T>` (cap 256, drop-oldest) + `EventBus` (subscribe/unsubscribe/publish over `{event, data}` messages).
- `orchestrator.ts` — `LaunchBusyError`, `Orchestrator` (launch / stop / `active` / `runnableTotal`), pid tracking, drives `runSchedule`.
- `server.ts` — `createDashboard(args) → { fetch, start, stop }`: `Bun.serve` routes (`GET /`, `POST /launch`, `POST /stop`, `GET /events`, `GET /static/*`) + the scanner loop.
- `index.ts` — `startDashboard({ port, resultsRoot, scenariosRoot, codingAgentsDir, jobs })`.
- `static/` — copied verbatim from the reference: `styles.css`, `app.js`, `htmx.min.js`, `htmx-ext-sse.js`, `fonts/Inter-Regular.woff2`, `fonts/Inter-SemiBold.woff2`, `fonts/OFL.txt`.

**Modify:**
- `src/contracts/verdict.ts` — add four optional identity fields to `FinalVerdictSchema`.
- `src/runner/index.ts` — write identity fields + `started_at`/`finished_at`; write `phase.json` at boundaries; `invokeGauntlet` → async.
- `src/runner/phase.ts` *(new)* — `writePhase(runDir, phase)`.
- `src/runner/stopped.ts` *(new)* — `buildStoppedVerdict()` + `writeStoppedVerdict(runDir, identity)`.
- `src/cli/index.ts` — install the `run`-command SIGINT handler; add the `dashboard` command.
- `src/run-all/index.ts` — add `onPid?(pid)` to `InvokeChildArgs`/`invokeChild` so the orchestrator can track child pids.

**Tests (Bun `test/`):** `test/runner-identity.test.ts`, `test/runner-phase.test.ts`, `test/runner-stopped.test.ts`, `test/dashboard-scan.test.ts`, `test/dashboard-view.test.ts`, `test/dashboard-diff.test.ts`, `test/dashboard-templates.test.ts`, `test/dashboard-event-bus.test.ts`, `test/dashboard-orchestrator.test.ts`, `test/dashboard-server.test.ts`.

---

## Phase A — Runner core changes

The dashboard read-side tolerates their absence on old runs (it falls back to dir-name parsing and drops verdict-less abandoned dirs), but new runs must emit them so live cells render correctly.

### Task 1: verdict.json self-identity

**Files:**
- Modify: `src/contracts/verdict.ts:59-67`
- Modify: `src/runner/index.ts:184-207` (`runScenario`)
- Test: `test/runner-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';

// The schema accepts the four additive identity fields, all optional.
test('FinalVerdictSchema accepts identity fields', () => {
  const v = {
    schema: 1, final: 'pass', final_reason: 'ok',
    gauntlet: null, checks: [], error: null, economics: null,
    scenario: 'demo', coding_agent: 'claude',
    started_at: '2026-06-12T00:00:00.000Z', finished_at: '2026-06-12T00:01:00.000Z',
  };
  expect(FinalVerdictSchema.parse(v).scenario).toBe('demo');
});

// A verdict with no identity fields still parses (old runs).
test('FinalVerdictSchema identity fields are optional', () => {
  const v = { schema: 1, final: 'pass', final_reason: 'ok', gauntlet: null, checks: [], error: null, economics: null };
  expect(FinalVerdictSchema.parse(v).scenario).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/runner-identity.test.ts` → FAIL (unknown keys / undefined).

- [ ] **Step 3: Extend the schema.** In `src/contracts/verdict.ts`, add to the `FinalVerdictSchema` object (after `economics`):

```ts
  // Self-identity (dashboard read-side). Additive + optional: runs predating
  // PRI-2185 fall back to run-dir-name parsing. The runner writes all four.
  scenario: z.string().optional(),
  coding_agent: z.string().optional(),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
```

- [ ] **Step 4: Thread identity through `runScenario`.** In `src/runner/index.ts`, capture timestamps and merge them into every verdict write path (happy + caught). Replace the body of `runScenario` so a `startedAt` ISO string is stamped right after `allocateRunDir`, and the final write spreads identity onto the verdict:

```ts
export async function runScenario(a: RunScenarioArgs): Promise<RunScenarioResult> {
  const scenario = scenarioName(a.scenarioDir);
  const runDir = allocateRunDir(a.outRoot, scenario, a.codingAgent);
  const startedAt = new Date().toISOString();
  let verdict: FinalVerdict;
  try {
    verdict = await runInner(a, runDir);
  } catch (err: unknown) {
    const stage = errorStage(err);
    const message = err instanceof Error ? err.message : String(err);
    verdict = compose({ gauntlet: null, checks: [], captureEmpty: false, error: { stage, message } });
  }
  const identified: FinalVerdict = {
    ...verdict,
    scenario,
    coding_agent: a.codingAgent,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  writeFileSync(join(runDir, 'verdict.json'), `${JSON.stringify(identified, null, 2)}\n`);
  return { runDir, verdict: identified };
}
```

- [ ] **Step 5: Add an integration assertion.** Append to `test/runner-identity.test.ts` a test that runs a stubbed scenario is out of scope (live gauntlet); instead assert the merge shape with a unit on a hand-built verdict + the spread above is covered by Step 1. Run `bun run check`.

- [ ] **Step 6: Commit** — `git commit -m "feat(quorum-ts): verdict.json self-identity fields (scenario/agent/timestamps) (PRI-2207)"`

### Task 2: phase.json at run-dir boundaries

**Files:**
- Create: `src/runner/phase.ts`
- Modify: `src/runner/index.ts` (`runInner` — write at setup/agent/checks boundaries)
- Test: `test/runner-phase.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePhase } from '../src/runner/phase.ts';

test('writePhase writes {phase, updated_at, pid}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-'));
  writePhase(dir, 'agent');
  const j = JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'));
  expect(j.phase).toBe('agent');
  expect(typeof j.pid).toBe('number');
  expect(j.pid).toBe(process.pid);
  expect(typeof j.updated_at).toBe('string');
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/runner-phase.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/runner/phase.ts`:**

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The live phase vocabulary the runner owns. `grade` is intentionally absent
// (build spec: the gauntlet event stream carries no grade-start marker; done is
// signalled by verdict.json appearing, not a phase).
export type RunPhase = 'setup' | 'agent' | 'checks';

// Write <runDir>/phase.json at a boundary the runner owns. `pid` is the
// `quorum run` process id; the dashboard uses it for liveness (phase mtime is
// not a liveness signal — a phase can last tens of minutes). The file stops
// updating once verdict.json is written (verdict.json is the done signal).
export function writePhase(runDir: string, phase: RunPhase): void {
  const body = { phase, updated_at: new Date().toISOString(), pid: process.pid };
  writeFileSync(join(runDir, 'phase.json'), `${JSON.stringify(body)}\n`);
}
```

- [ ] **Step 4: Wire boundaries into `runInner`** (`src/runner/index.ts`). Import `writePhase` and call it at three points: at the very top of `runInner` (`writePhase(runDir, 'setup')`); immediately before the `invokeGauntlet(...)` call (`writePhase(runDir, 'agent')`); immediately before the post-checks `runPhase({ ... phase: 'post' ...})` block (`writePhase(runDir, 'checks')`). Do not write a phase after `compose`/economics — verdict.json is the terminal signal.

- [ ] **Step 5: Run** — `bun test test/runner-phase.test.ts` → PASS. `bun run check` green.

- [ ] **Step 6: Commit** — `git commit -m "feat(quorum-ts): phase.json at setup/agent/checks boundaries (PRI-2207)"`

### Task 3: graceful SIGINT → stopped verdict

The riskiest task. `invokeGauntlet` uses **`spawnSync`**, which blocks the event loop — a `process.on('SIGINT')` handler cannot fire while gauntlet runs. **Decision: convert `invokeGauntlet` to async `spawn` + `await`**, track the child handle, and install a SIGINT handler in the `run` command that forwards SIGINT to the gauntlet child and writes a stopped verdict. This keeps the loop responsive (the correct, idiomatic fix) and removes a latent "sync spawn blocks everything" smell. (Fallback if async conversion proves too invasive: spawn the `quorum run` child `detached` from the orchestrator and signal its process group so gauntlet dies and unblocks `spawnSync`, then a post-return flag check writes the verdict. Prefer the async path.)

**Files:**
- Create: `src/runner/stopped.ts`
- Modify: `src/runner/index.ts` (`invokeGauntlet` → async; export a child-handle hook)
- Modify: `src/cli/index.ts` (`run` action — SIGINT handler)
- Test: `test/runner-stopped.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStoppedVerdict, writeStoppedVerdict } from '../src/runner/stopped.ts';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';

test('buildStoppedVerdict is indeterminate with stage=stopped', () => {
  const v = buildStoppedVerdict({ scenario: 'demo', codingAgent: 'claude', startedAt: '2026-06-12T00:00:00.000Z' });
  const parsed = FinalVerdictSchema.parse(v);
  expect(parsed.final).toBe('indeterminate');
  expect(parsed.error?.stage).toBe('stopped');
  expect(parsed.scenario).toBe('demo');
});

test('writeStoppedVerdict lands verdict.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stopped-'));
  writeStoppedVerdict(dir, { scenario: 'demo', codingAgent: 'claude', startedAt: '2026-06-12T00:00:00.000Z' });
  const j = FinalVerdictSchema.parse(JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')));
  expect(j.final).toBe('indeterminate');
  expect(j.error?.stage).toBe('stopped');
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/runner-stopped.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/runner/stopped.ts`:**

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalVerdict } from '../contracts/verdict.ts';

export interface StoppedIdentity {
  readonly scenario: string;
  readonly codingAgent: string;
  readonly startedAt: string;
}

// The verdict written when a run is interrupted by SIGINT (dashboard Stop).
// indeterminate + error.stage "stopped" (a valid RUN_ERROR_STAGES member). The
// cell resolves to indeterminate instead of vanishing under the dead-pid rule.
export function buildStoppedVerdict(id: StoppedIdentity): FinalVerdict {
  return {
    schema: 1,
    final: 'indeterminate',
    final_reason: 'run stopped before completion',
    gauntlet: null,
    checks: [],
    error: { stage: 'stopped', message: 'run interrupted by SIGINT' },
    economics: null,
    scenario: id.scenario,
    coding_agent: id.codingAgent,
    started_at: id.startedAt,
    finished_at: new Date().toISOString(),
  };
}

export function writeStoppedVerdict(runDir: string, id: StoppedIdentity): void {
  writeFileSync(join(runDir, 'verdict.json'), `${JSON.stringify(buildStoppedVerdict(id), null, 2)}\n`);
}
```

- [ ] **Step 4: Make `invokeGauntlet` async.** In `src/runner/index.ts`, change `invokeGauntlet` from `spawnSync` to async `spawn` (`node:child_process`), awaiting child exit (collect stdout/stderr, resolve status). Keep the same `InvokeGauntletResult` shape. Expose the live child via a module-level setter so the SIGINT handler can forward to it, e.g. a small registry:

```ts
// The gauntlet child currently in flight for this process (one run per process),
// so the run-command SIGINT handler can forward the signal to it before writing
// the stopped verdict. Set on spawn, cleared on exit.
let activeGauntletChild: import('node:child_process').ChildProcess | null = null;
export function currentGauntletChild(): import('node:child_process').ChildProcess | null {
  return activeGauntletChild;
}
```

Set `activeGauntletChild` immediately after `spawn(...)`, clear it in the exit handler. `invokeGauntlet` becomes `async` and `runInner`/`runScenario` already `await` down the chain — update the one call site to `await invokeGauntlet(...)`.

- [ ] **Step 5: Install the SIGINT handler in the `run` command.** In `src/cli/index.ts`, the `run` action wraps `runScenario`. Before calling it, register a one-shot handler that, on SIGINT: forwards SIGINT to `currentGauntletChild()` (if any), writes a stopped verdict to the run dir, and exits `2`. The run dir + identity must be known to the handler — restructure so the `run` action allocates the run dir (or learns it) before the await. Simplest: have `runScenario` accept an optional `onRunDir?(dir: string): void` callback fired right after `allocateRunDir`, so the CLI captures the dir for the handler:

```ts
let runDirForStop: string | null = null;
const onSigint = (): void => {
  currentGauntletChild()?.kill('SIGINT');
  if (runDirForStop !== null) {
    writeStoppedVerdict(runDirForStop, { scenario, codingAgent: opts.codingAgent, startedAt });
  }
  process.exit(2);
};
process.once('SIGINT', onSigint);
```

Add `onRunDir` + `startedAt` exposure to `RunScenarioArgs`/result as needed (smallest surface: `runScenario` returns `runDir` already; capture `scenario`/`startedAt` in the CLI by deriving `scenario` from the resolved dir and stamping `startedAt` before the call, passing `startedAt` into `runScenario` so the handler and the happy path agree). Keep the change minimal and typed.

- [ ] **Step 6: Run** — `bun test test/runner-stopped.test.ts` → PASS. `bun run check` green. Manually verify (no live gauntlet) by sending SIGINT to a `bun src/cli/index.ts run <missing-scn>` is not representative; rely on the unit tests + a follow-up live smoke in Phase E.

- [ ] **Step 7: Commit** — `git commit -m "feat(quorum-ts): graceful SIGINT writes a stopped verdict; async gauntlet spawn (PRI-2207)"`

---

## Phase B — Dashboard read-side (pure + IO, no server)

### Task 4: dashboard contracts

**Files:** Create `src/dashboard/contracts.ts`; Test `test/dashboard-scan.test.ts` (shared; first assertions here).

- [ ] **Step 1: Write the failing test** (parse round-trips)

```ts
import { expect, test } from 'bun:test';
import { PhaseJsonSchema, DashboardVerdictSchema } from '../src/dashboard/contracts.ts';

test('PhaseJsonSchema parses runner output', () => {
  const p = PhaseJsonSchema.parse({ phase: 'agent', updated_at: '2026-06-12T00:00:00Z', pid: 42 });
  expect(p.phase).toBe('agent');
});

test('DashboardVerdictSchema narrows to the fields the read-side reads', () => {
  const v = DashboardVerdictSchema.parse({
    final: 'pass', economics: { total_est_cost_usd: 1.25 }, finished_at: '2026-06-12T00:01:00Z',
  });
  expect(v.final).toBe('pass');
  expect(v.economics?.total_est_cost_usd).toBe(1.25);
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/contracts.ts`.** Define the literal unions and zod schemas. Types are inferred from schemas where a JSON boundary exists; view-model types are plain interfaces (no IO):

```ts
import { z } from 'zod';

export const CELL_STATES = ['empty', 'done', 'running', 'queued'] as const;
export type CellState = (typeof CELL_STATES)[number];
export const SLOT_KINDS = ['pass', 'fail', 'indeterminate', 'unknown', 'ghost', 'running'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];
export type RunFinal = 'pass' | 'fail' | 'indeterminate' | 'unknown';

// phase.json (runner Task 2). pid is required for liveness.
export const PhaseJsonSchema = z.object({
  phase: z.string(),
  updated_at: z.string(),
  pid: z.number(),
});
export type PhaseJson = z.infer<typeof PhaseJsonSchema>;

// Narrow read-side view of verdict.json — only the fields the grid needs.
// Everything optional/nullable so a partial/old verdict still parses.
export const DashboardVerdictSchema = z.object({
  final: z.string().optional(),
  economics: z.object({ total_est_cost_usd: z.number().nullable().optional() }).nullable().optional(),
  finished_at: z.string().nullable().optional(),
  scenario: z.string().optional(),
  coding_agent: z.string().optional(),
  started_at: z.string().optional(),
});
export type DashboardVerdict = z.infer<typeof DashboardVerdictSchema>;

// Read-side data model (no IO past scan).
export interface RunRecord {
  readonly run_id: string;
  readonly started_at: string; // YYYYMMDDTHHMMSSZ (from dir name)
  readonly final: RunFinal;
  readonly cost_usd: number | null;
  readonly finished_at: string | null; // ISO8601 or null
}
export interface RunningRun { readonly run_id: string; readonly phase: string; }
export interface Cell {
  readonly scenario: string;
  readonly agent: string;
  readonly window: readonly RunRecord[]; // oldest..newest, <=5
  readonly running: RunningRun | null;
  queued: boolean; // ephemeral, set by orchestrator events only
}
export interface Grid { readonly cells: Map<string, Cell>; } // key = `${scenario}\t${agent}`

export interface SlotView { readonly kind: SlotKind; readonly height: number; } // 0..1
export interface CardRow { readonly verdict: RunFinal; readonly cost: string; readonly timestamp: string; readonly run_id: string; }
export interface CardView { readonly age: string; readonly rows: readonly CardRow[]; readonly drift_line: string | null; }
export interface CellView {
  readonly cell_id: string; readonly scenario: string; readonly agent: string;
  readonly state: CellState; readonly slots: readonly SlotView[]; // length 5
  readonly bottom: string; readonly drift: boolean; readonly opacity: number; readonly card: CardView | null;
}
export interface HeaderTally {
  readonly scenarios: number; readonly agents: number;
  readonly passed: number; readonly failed: number; readonly indeterminate: number; readonly not_run: number;
}
```

- [ ] **Step 4: Run** — schema tests PASS. `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard contracts (zod + view-model types) (PRI-2207)"`

### Task 5: `scan.ts` — results enumeration → Grid

**Files:** Create `src/dashboard/scan.ts`; Test `test/dashboard-scan.test.ts`.

- [ ] **Step 1: Write failing tests** against a fixture results tree built in `tmpdir` (helper writes dirs named `<scenario>-<agent>-<stamp>-<nonce>/verdict.json`):

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunDirName, scanResults } from '../src/dashboard/scan.ts';

const AGENTS = ['claude', 'claude-haiku', 'codex'];

test('parseRunDirName uses longest-suffix agent match', () => {
  const p = parseRunDirName('my-scn-claude-haiku-20260612T000000Z-1a2b', AGENTS);
  expect(p?.scenario).toBe('my-scn');
  expect(p?.agent).toBe('claude-haiku');
  expect(p?.started_at).toBe('20260612T000000Z');
});

test('parseRunDirName returns null for unparseable dirs', () => {
  expect(parseRunDirName('batches', AGENTS)).toBeNull();
  expect(parseRunDirName('weird-name', AGENTS)).toBeNull();
});

test('scanResults buckets runs into cells and windows to 5 newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  for (let i = 0; i < 7; i++) {
    const d = join(root, `s-claude-2026061${i}T000000Z-00${i}a`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'verdict.json'), JSON.stringify({ final: 'pass', economics: { total_est_cost_usd: i } }));
  }
  const grid = scanResults(root, AGENTS);
  const cell = grid.cells.get('s\tclaude');
  expect(cell?.window.length).toBe(5); // newest 5
  expect(cell?.window[4]?.cost_usd).toBe(6); // newest rightmost
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/scan.ts`.** Port `scan_results`/`parse_run_dir_name`/liveness from `.worktrees/dashboard-ref/quorum/dashboard/data.py`, preserving the parity invariants. Public surface:

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DashboardVerdictSchema, PhaseJsonSchema } from './contracts.ts';
import type { Cell, DashboardVerdict, Grid, RunFinal, RunningRun, RunRecord } from './contracts.ts';

export interface ParsedRunDir { readonly scenario: string; readonly agent: string; readonly started_at: string; readonly nonce: string; }

const RUN_DIR_RE = /-(\d{8}T\d{6}Z)-([0-9a-f]{4})$/;

// Longest-suffix agent match: agents sorted by length DESC so `claude-haiku`
// wins over `haiku`. Returns null for `batches`, names not matching the
// timestamp/nonce tail, or a head with no known-agent suffix.
export function parseRunDirName(name: string, knownAgents: readonly string[]): ParsedRunDir | null { /* ... */ }

// pid liveness: process.kill(pid, 0) throws ESRCH when dead, EPERM when alive
// (signal-but-no-permission). Treat EPERM as alive, everything else as dead.
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err: unknown) { return err instanceof Error && 'code' in err && err.code === 'EPERM'; }
}

// Cached verdict read — verdict.json is immutable once written, so the cache by
// run-dir path never invalidates. Returns null when missing/unparseable.
export function readDashboardVerdict(runDir: string): DashboardVerdict | null { /* existsSync + JSON.parse + safeParse */ }

// Enumerate results/, skip batches/, bucket by (scenario, agent), window to the
// 5 newest by (started_at, nonce). For each windowed dir: verdict.json present
// ⇒ a RunRecord (authority rule); absent + live pid ⇒ the cell's `running`;
// absent + dead/no pid ⇒ abandoned (excluded). cells with nothing to show are
// omitted from the Grid.
export function scanResults(resultsRoot: string, knownAgents: readonly string[]): Grid { /* ... */ }
```

The cell key is `` `${scenario}\t${agent}` `` (tab-separated; tab is absent from names). `final` is read from verdict (`pass`/`fail`/`indeterminate`, else `unknown`); `cost_usd` from `economics.total_est_cost_usd ?? null`; `finished_at` from the verdict (fallback null). The running phase is the live dir's `phase.json.phase` (any string), default `'setup'`.

- [ ] **Step 4: Run** — scan tests PASS. Add tests for: the authority rule (verdict present ⇒ not running even if phase.json exists), and abandoned exclusion (dead pid ⇒ cell omitted). `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard read-side scan (results -> Grid) (PRI-2207)"`

### Task 6: `view.ts` — pure derivations + cellView

**Files:** Create `src/dashboard/view.ts`; Test `test/dashboard-view.test.ts`.

- [ ] **Step 1: Write failing tests** pinning the parity formulas verbatim:

```ts
import { expect, test } from 'bun:test';
import { costBarHeights, driftFlag, formatAge, launchEstimate, median, staleOpacity } from '../src/dashboard/view.ts';

test('staleOpacity hits the spec anchors', () => {
  expect(staleOpacity(0)).toBeCloseTo(1.0, 2);
  expect(staleOpacity(7)).toBeCloseTo(0.34 + 0.66 * Math.exp(-7 / 6), 6);
  expect(staleOpacity(1000)).toBeGreaterThanOrEqual(0.34);
});
test('driftFlag needs >=2 priors and last > 1.5x median', () => {
  expect(driftFlag([1, 1, 3])).toBe(true);    // median(prior=[1,1])=1; 3>1.5
  expect(driftFlag([1, 1, 1])).toBe(false);
  expect(driftFlag([1, 3])).toBe(false);       // only 1 prior
});
test('costBarHeights normalizes to window peak', () => {
  expect(costBarHeights([1, 2, 4])).toEqual([0.25, 0.5, 1]);
  expect(costBarHeights([0, 0])).toEqual([0, 0]);
});
test('formatAge boundaries', () => {
  expect(formatAge(0.5 / 86400)).toBe('0s'); // sub-second floors to 0s... see note
  expect(formatAge(30 / 86400)).toBe('30s');
  expect(formatAge(90 / 86400)).toBe('1m');
  expect(formatAge(2 / 24)).toBe('2h');
  expect(formatAge(21)).toBe('21d');
});
```

(Confirm the exact `format_age` rounding against `data.py` and adjust the `0s` edge if the Python floors differently — match the reference.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/view.ts`** — port the formulas from `data.py` verbatim. Functions: `median(xs)`, `staleOpacity(ageDays)`, `driftFlag(costs)`, `costBarHeights(costs)`, `formatAge(days)`, `latestAgeDays(cell, now?)`, `launchEstimate(grid, scenario, agent)`, `headerTally(grid, scenarios, agents)`, `cellView(cell, scenario, agent, now?)`. `cellView` assembles the 5-slot ribbon (left-pad ghost, newest rightmost), bottom label (`$X.XX` / `—` / `queued` / phase word), `opacity` (running→1, queued→0.5, else `staleOpacity`), `drift`, and the `CardView`. Ghost/running slot height floor `0.18`.

- [ ] **Step 4: Run + add `cellView`/`headerTally`/`launchEstimate` tests** (empty cell → `—`/state `empty`; running cell → shimmer slot + phase bottom; done cell → cost bottom + stale opacity; tally counts latest verdict per cell). `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard view derivations + cellView (PRI-2207)"`

### Task 7: `diffGrids`

**Files:** Modify `src/dashboard/view.ts` (add `diffGrids`); Test `test/dashboard-diff.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { expect, test } from 'bun:test';
import { diffGrids } from '../src/dashboard/view.ts';
import type { Grid } from '../src/dashboard/contracts.ts';

function grid(cells: [string, { latest: string | null; phase: string | null }][]): Grid { /* build minimal cells */ }

test('diffGrids returns changed cell ids (advisory reason)', () => {
  // appeared, vanished, verdict-appeared, phase-changed — all yield the cell id.
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `diffGrids(old, new) → { cell_id: string; reason: string }[]`.** Compare per-cell **signatures** — `(latest run_id, running phase, is_running, window length)`. A signature change yields a `{cell_id, reason}` where reason ∈ `appeared|vanished|verdict-appeared|phase-changed` (advisory only; consumers re-render regardless). Port from `data.py:diff_grids`.

- [ ] **Step 4: Run** — diff tests PASS. `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard diffGrids for incremental SSE (PRI-2207)"`

---

## Phase C — Templating + static assets

### Task 8: `templates.ts` — typed HTML renderers

**Decision:** typed template-literal functions, no templating dependency (keeps the no-build-step + full-strict properties). `cellHtml` is the single source of truth for first paint and SSE swaps — exactly the Jinja `cell` macro's role.

**Files:** Create `src/dashboard/templates.ts`; Test `test/dashboard-templates.test.ts`.

- [ ] **Step 1: Write failing tests** (the parity-critical wiring, not exact whitespace):

```ts
import { expect, test } from 'bun:test';
import { cellHtml, esc, tallyHtml } from '../src/dashboard/templates.ts';
import type { CellView } from '../src/dashboard/contracts.ts';

test('esc escapes HTML metacharacters', () => {
  expect(esc('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
});
test('cellHtml emits id + sse-swap = cell-<scenario>-<agent> and hx-swap outerHTML', () => {
  const view: CellView = { cell_id: 'cell-s-claude', scenario: 's', agent: 'claude', state: 'done', slots: Array(5).fill({ kind: 'ghost', height: 0.18 }), bottom: '$1.00', drift: false, opacity: 1, card: null };
  const html = cellHtml(view);
  expect(html).toContain('id="cell-s-claude"');
  expect(html).toContain('sse-swap="cell-s-claude"');
  expect(html).toContain('hx-swap="outerHTML"');
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/templates.ts`.** Port the markup from `.worktrees/dashboard-ref/quorum/dashboard/templates/{cell,grid,layout}.html.j2`, matching every class name and data attribute that `styles.css` and `app.js` rely on (read both to confirm the exact contract — e.g. `data-launch`, `data-card`, `.runbar`, `.stop`, the `--h` inline cost-bar var, sticky header classes). Functions: `esc(s)`, `cellHtml(view)`, `gridHtml({ scenarios, agents, views, estimates })`, `tallyHtml(tally)`, `runStripHtml({ running, inFlight, done, spent })`, `layoutHtml({ tallyHtml, gridHtml })`. The layout references `/static/...` for htmx, the SSE extension, `styles.css`, and `app.js`, and wires `hx-ext="sse"` + `sse-connect="/events"`. Bottom slot, fail hatch, shimmer, drift `▲`, and the detail card markup all live in `cellHtml`. Escape every interpolated scenario/agent/run_id/cost string with `esc`.

- [ ] **Step 4: Run + add a cell-state smoke matrix test** — render `empty`, `done` (with/without drift), `running` (each phase), `queued`, and a padded `<5` window; assert each carries its expected marker (ghost count, shimmer class, `queued` text, `▲`, cost vs `—`). Port the reference's smoke matrix intent. `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard template-literal renderers (cell/grid/layout/strip/tally) (PRI-2207)"`

### Task 9: copy static assets verbatim

**Files:** Create `src/dashboard/static/{styles.css,app.js,htmx.min.js,htmx-ext-sse.js,fonts/Inter-Regular.woff2,fonts/Inter-SemiBold.woff2,fonts/OFL.txt}`.

- [ ] **Step 1: Copy from the reference worktree** (binary-safe for fonts):

```bash
mkdir -p src/dashboard/static/fonts
cp .worktrees/dashboard-ref/quorum/dashboard/static/styles.css src/dashboard/static/styles.css
cp .worktrees/dashboard-ref/quorum/dashboard/static/app.js src/dashboard/static/app.js
cp .worktrees/dashboard-ref/quorum/dashboard/static/htmx.min.js src/dashboard/static/htmx.min.js
cp .worktrees/dashboard-ref/quorum/dashboard/static/htmx-ext-sse.js src/dashboard/static/htmx-ext-sse.js
cp .worktrees/dashboard-ref/quorum/dashboard/static/fonts/Inter-Regular.woff2 src/dashboard/static/fonts/
cp .worktrees/dashboard-ref/quorum/dashboard/static/fonts/Inter-SemiBold.woff2 src/dashboard/static/fonts/
cp .worktrees/dashboard-ref/quorum/dashboard/static/fonts/OFL.txt src/dashboard/static/fonts/
```

- [ ] **Step 2: Confirm** `app.js` references only `/static/...` paths and the `data-*` / class contract the templates emit; if `htmx.min.js` is a 0-byte placeholder in the reference (the recon showed 0 LOC), vendor the real `htmx.min.js` + `htmx-ext-sse.js` from the pinned htmx release the visual spec names, and note the version in a `src/dashboard/static/VENDOR.md`. Biome should not lint vendored JS — add `src/dashboard/static/**` to `biome.json` `files.ignore` if needed.

- [ ] **Step 3: Commit** — `git commit -m "chore(quorum-ts): vendor dashboard static assets (css/js/fonts) (PRI-2207)"`

---

## Phase D — Write-side + server

### Task 10: `event-bus.ts` — bounded SSE fan-out

**Files:** Create `src/dashboard/event-bus.ts`; Test `test/dashboard-event-bus.test.ts`.

- [ ] **Step 1: Write failing tests**

```ts
import { expect, test } from 'bun:test';
import { BoundedQueue, EventBus } from '../src/dashboard/event-bus.ts';

test('BoundedQueue drops oldest past capacity', () => {
  const q = new BoundedQueue<number>(2);
  q.push(1); q.push(2); q.push(3);
  expect(q.drain()).toEqual([2, 3]);
});
test('EventBus fans a message to every subscriber', () => {
  const bus = new EventBus();
  const a = bus.subscribe(); const b = bus.subscribe();
  bus.publish({ event: 'strip', data: '<x/>' });
  expect(a.drain().length).toBe(1);
  expect(b.drain().length).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** `BoundedQueue<T>(capacity)` — array-backed FIFO; `push` drops the oldest (`shift`) when at capacity; `drain()` empties and returns. `EventBus` — a `Set<BoundedQueue<SseMessage>>`; `subscribe() → queue`, `unsubscribe(q)`, `publish(msg)` pushes to all, `subscriberCount`. `SseMessage = { event: string; data: string }`. No threads, no async — single loop, scheduler `onEvent` fires synchronously. Cap default `256`.

- [ ] **Step 4: Run** — PASS. `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard SSE EventBus (bounded, drop-oldest) (PRI-2207)"`

### Task 11: `invokeChild` pid hook

**Files:** Modify `src/run-all/index.ts` (`InvokeChildArgs` + `invokeChild`); Test extend `test/` run-all fake.

- [ ] **Step 1: Write failing test** — a test that passes `onPid` and asserts it receives the spawned child's numeric pid (use a fast child like `process.execPath -e ''` indirectly is hard; instead unit-test that `invokeChild` calls `onPid` with `child.pid` by spawning the real CLI `run` against a missing scenario and asserting `onPid` fired with a number). Keep it light:

```ts
import { expect, test } from 'bun:test';
import { invokeChild } from '../src/run-all/index.ts';

test('invokeChild reports the child pid via onPid', async () => {
  let pid: number | null = null;
  await invokeChild({
    scenarioDir: '/nonexistent', codingAgent: 'nope',
    codingAgentsDir: '/nonexistent', outRoot: '/tmp', onPid: (p) => { pid = p; },
  });
  expect(typeof pid).toBe('number');
});
```

- [ ] **Step 2: Run to verify it fails** (unknown `onPid`).

- [ ] **Step 3: Implement.** Add `readonly onPid?: (pid: number) => void;` to `InvokeChildArgs`. In `invokeChild`, after `const child = spawn(...)`, call `if (child.pid !== undefined) args.onPid?.(child.pid);`. No other behavior change.

- [ ] **Step 4: Run** — PASS. `bun run check` green. Confirm existing run-all tests still green (`bun test`).

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): invokeChild onPid hook for dashboard stop (PRI-2207)"`

### Task 12: `orchestrator.ts`

**Files:** Create `src/dashboard/orchestrator.ts`; Test `test/dashboard-orchestrator.test.ts`.

- [ ] **Step 1: Write failing tests** (launch/409/stop with a stub invoke — no live children):

```ts
import { expect, test } from 'bun:test';
import { LaunchBusyError, Orchestrator } from '../src/dashboard/orchestrator.ts';

test('second launch while active throws LaunchBusyError', async () => { /* stub invoke that blocks on a gate; first launch holds active; second throws */ });
test('stop() requests scheduler stop and SIGINTs tracked pids', async () => { /* stub invoke records onPid; stop() calls process.kill on them (spy) */ });
test('runnableTotal is set from the matrix before children run', async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/orchestrator.ts`.** Port `orchestrator.py`. Class `Orchestrator` (fields assigned in the body — no parameter properties). Constructor args `{ resultsRoot, scenariosRoot, codingAgentsDir, jobs, invoke?, onEvent? }` (`invoke` defaults to `invokeChild`, `onEvent` is the SSE sink). `launch({ kind, scenario?, agent? })`:
  - throw `LaunchBusyError` if `this.active`;
  - set active; build the matrix via `buildMatrix` with the kind→filter mapping (`row`⇒scenarioFilter, `column`⇒agentFilter, `all`⇒none), same directive/draft/tier prefilter as run-all;
  - `this.runnableTotal = entries.filter(runnable).length`;
  - allocate a real batch dir (`allocateBatchDir`), `writeBatchHeader`;
  - call `runSchedule({ cells, jobs, capFor: agentMaxConcurrency, spacingFor: agentLaunchSpacingSeconds, clock: RealClock, invoke: wrapped, isRateLimited, onEvent: handle, shouldAbort: () => this.stopRequested })` where `wrapped` injects `onPid: (pid) => this.childPids.add(pid)` and removes the pid on settle;
  - keep the `ScheduleHandle`; on `done`, `writeBatchFooter`, set active false;
  - `handle` event: `appendResultRecord` for finished/skipped (parity with run-all) **and** publish the cell partial + run-strip via `onEvent`.
  - `stop()`: set `this.stopRequested`, call `handle.requestStop()`, and `for (const pid of this.childPids) process.kill(pid, 'SIGINT')` (catch ESRCH).
  - `active` getter; `runnableTotal` field.
  - `LaunchBusyError extends Error`.

- [ ] **Step 4: Run** — orchestrator tests PASS. `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard orchestrator (launch/409/stop over scheduler) (PRI-2207)"`

### Task 13: `server.ts` — Bun.serve + scanner loop

**Files:** Create `src/dashboard/server.ts`; Test `test/dashboard-server.test.ts`.

- [ ] **Step 1: Write failing tests** (drive `fetch` against an in-process `Bun.serve` on an ephemeral port):

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDashboard } from '../src/dashboard/server.ts';
// build a tiny results/ fixture; start the server on port 0; fetch GET / etc.

test('GET / renders the grid with the tally header', async () => { /* expect 200 + "quorum" + cell ids */ });
test('GET /static/styles.css serves text/css', async () => { /* expect content-type text/css */ });
test('POST /launch then POST /launch again returns 409', async () => { /* stub orchestrator invoke that blocks */ });
test('GET /events responds with text/event-stream', async () => { /* expect content-type */ });
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/server.ts`.** `createDashboard({ resultsRoot, scenariosRoot, codingAgentsDir, jobs, knownAgents })` returns `{ fetch(req): Response | Promise<Response>, startScanner(), stopScanner() }`. Routes:
  - `GET /` — warm `scanResults`, store as `lastGrid`, render `layoutHtml({ tallyHtml(headerTally(...)), gridHtml(...) })`, `text/html`.
  - `POST /launch` — parse `req.formData()` (`kind`/`scenario`/`agent`); `orchestrator.launch(...)`; on success return `runStripHtml(...)`; on `LaunchBusyError` return `new Response(runbarBusyHtml, { status: 409 })`; on other error 4xx/5xx with the message in a runbar.
  - `POST /stop` — `orchestrator.stop()`; return the "Stopping…" runbar.
  - `GET /events` — `new Response(new ReadableStream({ start(controller) { subscribe; pump } }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })`. The pump drains the client's `BoundedQueue` and writes `event: <name>\ndata: <html-one-line>\n\n` frames; unsubscribe on cancel.
  - `GET /static/*` — serve `Bun.file(join(staticDir, rest))` with the right `content-type` (css/js/woff2); 404 outside the dir.
  - The **scanner loop**: a recursive `setTimeout(tick, 1000)` (guard `if (bus.subscriberCount === 0) return reschedule`), each tick `scanResults` → `diffGrids(lastGrid, next)` → for each changed cell `bus.publish({ event: cell_id, data: oneLine(cellHtml(cellView(...))) })`, plus a `strip` publish reflecting the orchestrator's live session counts; set `lastGrid = next`. SSE data must be single-line (replace newlines) so each frame is one `data:` line.
  - The orchestrator's `onEvent` also publishes (cell_started ⇒ mark cell queued/running and push; cell_finished ⇒ re-derive; strip update). Reconcile orchestrator pushes + scanner pushes through the same `bus`.

- [ ] **Step 4: Run** — server tests PASS. `bun run check` green.

- [ ] **Step 5: Commit** — `git commit -m "feat(quorum-ts): dashboard Bun.serve routes + scanner loop + SSE (PRI-2207)"`

### Task 14: `index.ts` entry + `dashboard` CLI command

**Files:** Create `src/dashboard/index.ts`; Modify `src/cli/index.ts`; Test `test/dashboard-server.test.ts` (extend with the start helper).

- [ ] **Step 1: Write failing test** — `startDashboard` returns a handle exposing the bound port and a `stop()`; assert it serves `GET /` then stops.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/dashboard/index.ts`:**

```ts
import { resolve } from 'node:path';
import { knownAgentNames } from '../run-all/matrix.ts'; // or derive from coding-agents/*.yaml
import { createDashboard } from './server.ts';

export interface StartDashboardArgs {
  readonly port: number;
  readonly resultsRoot: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly jobs: number;
}
export interface DashboardHandle { readonly port: number; stop(): void; }

export function startDashboard(a: StartDashboardArgs): DashboardHandle {
  const dash = createDashboard({ /* resolved roots + knownAgents */ });
  const server = Bun.serve({ port: a.port, fetch: dash.fetch });
  dash.startScanner();
  return { port: server.port, stop: () => { dash.stopScanner(); server.stop(true); } };
}
```

(Derive `knownAgents` from `coding-agents/*.yaml` names — the same list `buildMatrix` uses. If no exported helper exists, add `knownAgentNames(codingAgentsDir)` to `src/run-all/matrix.ts`.)

- [ ] **Step 4: Add the CLI command.** In `src/cli/index.ts`:

```ts
program
  .command('dashboard')
  .option('--port <n>', 'port', '8787')
  .option('--scenarios-root <dir>', 'scenarios root', 'scenarios')
  .option('--coding-agents-dir <dir>', 'agents dir', 'coding-agents')
  .option('--results-root <dir>', 'results root', 'results')
  .action((opts: { port: string; scenariosRoot: string; codingAgentsDir: string; resultsRoot: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 0) { process.stderr.write('error: --port must be an integer >= 0\n'); process.exit(1); }
    const h = startDashboard({
      port,
      resultsRoot: resolve(opts.resultsRoot),
      scenariosRoot: resolve(opts.scenariosRoot),
      codingAgentsDir: resolve(opts.codingAgentsDir),
      jobs: DEFAULT_JOBS,
    });
    process.stdout.write(`quorum dashboard on http://localhost:${h.port}\n`);
    // keep the process alive; Bun.serve holds the loop. Ctrl-C stops.
  });
```

- [ ] **Step 5: Run** — `bun src/cli/index.ts dashboard --port 0` prints a URL; `bun run check` + `bun test` green.

- [ ] **Step 6: Commit** — `git commit -m "feat(quorum-ts): quorum dashboard [--port] command + startDashboard entry (PRI-2207)"`

---

## Phase E — Integration, docs, parity

### Task 15: end-to-end smoke + cell-state matrix

**Files:** `test/dashboard-server.test.ts` (extend); optional `test/dashboard-e2e.test.ts`.

- [ ] **Step 1:** Build a representative `results/` fixture (a few scenarios × agents, some pass/fail/indeterminate, one in-flight dir with a live-pid `phase.json` pointing at `process.pid`, one abandoned dir with a dead pid, one drift cell). Start the server; assert: `GET /` renders all expected cell ids with correct state classes; the in-flight cell shows running+phase; the abandoned dir is absent; the drift cell carries `▲`; the tally counts are correct.

- [ ] **Step 2:** Assert the SSE frame contract: connect to `/events`, trigger a scanner tick after mutating a dir (write a verdict.json into the previously-running dir), and read one `event: cell-<id>` frame whose `data:` is the cell partial.

- [ ] **Step 3:** Run `bun test` (whole suite) + `bun run check`. All green.

- [ ] **Step 4: Commit** — `git commit -m "test(quorum-ts): dashboard end-to-end smoke + cell-state matrix (PRI-2207)"`

### Task 16: docs + final gate

**Files:** Modify `CLAUDE.md` (Commands + Architecture); optional `docs/experiments` note is N/A.

- [ ] **Step 1:** Add to `CLAUDE.md` Commands: `- **dashboard**: \`uv run quorum dashboard [--port N]\`` — keep the lowercase `quorum`, note it's the TS path now. Add an Architecture bullet for `src/dashboard/` mirroring the Python entry. (The CLAUDE.md on this branch lacks the dashboard rows the reference branch added — add the TS equivalents.)

- [ ] **Step 2:** Run the full safe-check gate: `bun run check` (tsc strict + Biome + `bun test`). All green. Run `uv run quorum check` is Python — skip; the TS gate is authoritative for this branch.

- [ ] **Step 3 (optional live smoke, trusted-maintainer only):** `bun src/cli/index.ts dashboard --port 8787`, open it, click Run All on a one-cell filter, watch a cell go queued→running→done, click Stop mid-run and confirm the cell resolves indeterminate (graceful SIGINT). Do **not** add this to CI.

- [ ] **Step 4: Commit** — `git commit -m "docs(quorum-ts): CLAUDE.md dashboard command + architecture (PRI-2207)"`

---

## Self-Review

**Spec coverage (build + visual specs):**
- Routes `GET /` / `POST /launch` / `POST /stop` / `GET /events` → Tasks 13–14. ✅
- Static serving → Task 13 (`/static/*`) + Task 9 (assets). ✅
- `phase.json` (core change 1) → Task 2. ✅
- graceful SIGINT (core change 1b) → Task 3. ✅
- verdict self-identity (core change 2) → Task 1. ✅
- scheduler reuse (the "extract the scheduler" refactor) → already done (Spec 4); orchestrator consumes it → Task 12. ✅
- read-side scan/window/liveness/authority rule → Task 5. ✅
- derived values (stale-fade, drift, cost-bar, launch estimate, age) → Task 6. ✅
- diff_grids → Task 7. ✅
- cell macro single-source / first-paint + SSE swap → Task 8. ✅
- SSE bus bounded/drop-oldest → Task 10. ✅
- launch 409 single-session + runnable_total + batch-dir first-class → Task 12. ✅
- stop SIGINT + queued cancel → Task 12 (+ scheduler requestStop). ✅
- header tally / sticky header / cell anatomy / fail hatch / shimmer / hover card → Tasks 6, 8, 9. ✅
- error handling (malformed dir skip, child crash → indeterminate, launch failure surface, SSE reconnect → full refresh) → Tasks 5, 13. ✅
- dark-theme-only, no auth, localhost dev box → in scope as-is; light theme deferred (spec). ✅

**Gaps / deferred (explicit, not silent):**
- The Python's thread→asyncio bridge has **no TS equivalent** — single-loop Bun makes it unnecessary (documented in Task 10/13). Not a gap; a simplification.
- The visual spec's confirm-dialog / hover-chip JS is in the copied `app.js` (Task 9) — no server work; verify the data-attribute contract in Task 8.
- If the reference `htmx.min.js` is a placeholder, Task 9 Step 2 vendors the real release — flagged, not silent.

**Type consistency:** `Cell`/`CellView`/`SlotView`/`RunRecord`/`Grid`/`HeaderTally` are defined once in Task 4 and used unchanged in Tasks 5–8, 12–13. Cell-state union (`empty|done|running|queued`) and slot-kind union (`pass|fail|indeterminate|unknown|ghost|running`) are the Task-4 literals throughout. `SseMessage = {event, data}` defined in Task 10, used in Tasks 12–13. `LaunchBusyError` defined in Task 12, caught in Task 13. ✅

**Risk ranking (verify hardest first):** Task 3 (SIGINT/async-gauntlet) > Task 13 (SSE/scanner reconciliation) > Task 12 (orchestrator pid tracking) > Task 5 (liveness/authority rule). The rest is mechanical port + pure math.
