# Transient-Indeterminate Retry + Startup Hang-Detect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the harness survive transient Bedrock/Mantle capacity blips — detect a wedged Claude fast, and retry the transient-infra indeterminates that result — so a proving run yields pass/fail for every cell.

**Architecture:** Two mechanisms in the runner. (1) A **cell-level retry loop** in `runScenario` wrapping an extracted per-attempt `driveOnce`, gated by a positive `isRetryableIndeterminate` predicate (watcher hang-marker OR grader-`investigate` with `error==null`); each attempt's evidence nests under `<runDir>/attempts/<n>/`, `phase.json`/`verdict.json` stay at the cell root, economics sum across attempts. (2) A **two-phase `StartupLivenessWatcher`** (await launch marker → require a first `assistant`-role transcript entry within a budget → else tear down the gauntlet tmux and stamp the hang marker), replacing the agy watcher's slot for `normalizer==='claude' && os==='linux'`. Then surface `attempts`/`flaked_green` in `show`, run-all, and the dashboard.

**Tech Stack:** TypeScript on Bun (≥1.3.14), zod schemas, `bun:test`, biome, `tsc --noEmit`. The design spec is `docs/superpowers/specs/2026-07-09-transient-indeterminate-retry-hang-detect-design.md` — read it first.

## Global Constraints

- **Runtime:** Bun ≥ 1.3.14; all tests `bun:test`; `bun run check` (biome + `tsc --noEmit` + `bun test`) must be green at every task's end.
- **No new deps.** Reuse existing helpers (`snapshotDir`/`newFilesSince`, `writeIndeterminate`, `killGauntletTmuxForRun`, `resolveSessionLogDir`).
- **Never invent APIs** — every signature below is verbatim from the current tree (line numbers may drift as you edit; re-grep the symbol, don't trust the number).
- **Back-compat:** every new `verdict.json` field is `.optional()` — old verdicts must still parse in `FinalVerdictSchema`, `DashboardVerdictSchema`, run-all `VerdictViewSchema`.
- **Marker discipline:** `CLAUDE_STARTUP_HANG_MARKER` lives in `error.message` of a `stage:'capture'` indeterminate; predicates match via `.includes(MARKER)` (mirror `ANTIGRAVITY_RATE_LIMIT_MARKER`).
- **Never retry** a `fail`, a `stage∈{setup,gauntlet,checks,stopped}` error, a failed pre-check, an agent-skip/missing-`checks.sh`, or an **unmarked** `stage:'capture'` verdict. Only the two positively-marked classes retry.
- **Attempts run sequentially** (`activeGauntletChild` is process-global); never parallelize.
- Commit after every task. `checks.sh` files must not be executable (n/a here — no scenarios added).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/runner/retry.ts` (new) | `isRetryableIndeterminate` predicate | 1 |
| `src/agents/claude.ts` | `CLAUDE_STARTUP_HANG_MARKER` export | 1 |
| `src/contracts/verdict.ts` | `attempts`/`attempt_count`/`flaked_green` optional fields | 2 |
| `src/runner/index.ts` | `driveOnce` extraction (two-dir split); retry loop; watcher wiring + marker intercept; `RunScenarioArgs.maxRetries` | 3,4,7,8 |
| `src/agents/startup-watch.ts` (new) | `StartupLivenessWatcher` (two-phase, fake-clock/fs seams) | 5 |
| `coding-agents/claude-context/launch-agent` | `touch $QUORUM_LAUNCH_MARKER` before `exec` | 6 |
| `src/cli/index.ts` | `--max-retries` on `run` + run-all | 8 |
| `src/run-all/index.ts` | `InvokeChildArgs`/`buildChildRunArgs`; `VerdictViewSchema` + flaked-green tally | 8,10 |
| `src/cli/render.ts` | `formatHeader` attempts line | 9 |
| `packages/dashboard/src/{contracts,scan,view,templates}.ts` | flaked-green badge | 11 |

Test files: colocated `test/*.test.ts` (repo convention — e.g. `test/runner-retry.test.ts`, `test/startup-watch.test.ts`).

---

### Task 1: Retryable predicate + hang marker

**Files:**
- Create: `src/runner/retry.ts`
- Modify: `src/agents/claude.ts` (add the marker export near the top, mirroring `src/agents/antigravity.ts:46`)
- Test: `test/runner-retry.test.ts`

**Interfaces:**
- Produces: `export const CLAUDE_STARTUP_HANG_MARKER = 'Claude startup hang'` (`src/agents/claude.ts`); `export function isRetryableIndeterminate(v: FinalVerdict): boolean` (`src/runner/retry.ts`).
- Consumes: `FinalVerdict` from `../contracts/verdict.ts`; `CLAUDE_STARTUP_HANG_MARKER` from `../agents/claude.ts`.

- [ ] **Step 1: Write the failing test** (`test/runner-retry.test.ts`)

```ts
import { expect, test } from 'bun:test';
import { isRetryableIndeterminate } from '../src/runner/retry.ts';
import { CLAUDE_STARTUP_HANG_MARKER } from '../src/agents/claude.ts';
import type { FinalVerdict } from '../src/contracts/verdict.ts';

const base = { schema: 1 as const, checks: [], economics: null };
const ind = (o: Partial<FinalVerdict>): FinalVerdict =>
  ({ ...base, final: 'indeterminate', final_reason: 'x', gauntlet: null, error: null, ...o });

test('hang-marker capture indeterminate is retryable', () => {
  expect(isRetryableIndeterminate(ind({
    error: { stage: 'capture', message: `${CLAUDE_STARTUP_HANG_MARKER}: wedged` },
  }))).toBe(true);
});
test('grader investigate with null error is retryable', () => {
  expect(isRetryableIndeterminate(ind({
    gauntlet: { status: 'investigate', summary: '', reasoning: '', run_id: 'r' },
  }))).toBe(true);
});
test('investigate WITH a gauntlet-stage error (agy latch) is NOT retryable', () => {
  expect(isRetryableIndeterminate(ind({
    gauntlet: { status: 'investigate', summary: '', reasoning: '', run_id: 'r' },
    error: { stage: 'gauntlet', message: 'Code Assist rate limit: killed' },
  }))).toBe(false);
});
test('unmarked capture indeterminate (deterministic zero-rows) is NOT retryable', () => {
  expect(isRetryableIndeterminate(ind({
    error: { stage: 'capture', message: 'Pi capture normalized to zero rows' },
  }))).toBe(false);
});
test.each([
  ['setup error', ind({ error: { stage: 'setup', message: 'x' } })],
  ['gauntlet-null terminal (pre-check)', ind({ error: null, gauntlet: null })],
  ['pass', { ...base, final: 'pass', final_reason: 'ok', gauntlet: null, error: null } as FinalVerdict],
  ['fail', { ...base, final: 'fail', final_reason: 'no', gauntlet: null, error: null } as FinalVerdict],
])('%s is NOT retryable', (_n, v) => {
  expect(isRetryableIndeterminate(v)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/runner-retry.test.ts`
Expected: FAIL — `Cannot find module '../src/runner/retry.ts'` / `CLAUDE_STARTUP_HANG_MARKER` not exported.

- [ ] **Step 3: Add the marker export** to `src/agents/claude.ts` (near the top, mirroring antigravity's marker at `antigravity.ts:46`)

```ts
// Stamped into a stage:'capture' indeterminate when the StartupLivenessWatcher
// tears down a wedged Claude; isRetryableIndeterminate matches it via .includes().
export const CLAUDE_STARTUP_HANG_MARKER = 'Claude startup hang';
```

- [ ] **Step 4: Write `src/runner/retry.ts`**

```ts
import { CLAUDE_STARTUP_HANG_MARKER } from '../agents/claude.ts';
import type { FinalVerdict } from '../contracts/verdict.ts';

// A verdict is retryable iff it is a *positively-marked* transient indeterminate:
//   - the watcher stamped the Claude startup-hang marker into error.message, OR
//   - the grader self-graded investigate/errored AND there is no error object
//     (the error==null gate excludes the antigravity rate-limit teardown, which
//     carries error.stage='gauntlet' and whose backoff the run-all latch owns).
// Every other indeterminate — setup/pre-check/skip terminals (gauntlet==null),
// and UNMARKED stage:'capture' zero-row/no-transcript verdicts — is terminal,
// as are pass and fail. Never retry a fail. See the design spec, Decisions 2/3.
export function isRetryableIndeterminate(v: FinalVerdict): boolean {
  if (v.final !== 'indeterminate') return false;
  if (v.error?.message?.includes(CLAUDE_STARTUP_HANG_MARKER)) return true;
  const status = v.gauntlet?.status;
  return (status === 'investigate' || status === 'errored') && v.error == null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/runner-retry.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/runner/retry.ts src/agents/claude.ts test/runner-retry.test.ts
git commit -m "feat(runner): isRetryableIndeterminate predicate + Claude startup-hang marker"
```

---

### Task 2: Verdict schema — attempts / attempt_count / flaked_green

**Files:**
- Modify: `src/contracts/verdict.ts:52-81` (add three optional fields to `FinalVerdictSchema`, mirroring the `.optional()` identity block at `:63-68`)
- Test: `test/verdict-attempts.test.ts`

**Interfaces:**
- Produces: `FinalVerdict.attempts?: {final: string, final_reason: string, est_cost_usd: number|null}[]`, `attempt_count?: number`, `flaked_green?: boolean`.

- [ ] **Step 1: Write the failing test** (`test/verdict-attempts.test.ts`)

```ts
import { expect, test } from 'bun:test';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';

const legacy = {
  schema: 1, final: 'pass', final_reason: 'ok',
  gauntlet: null, checks: [], error: null, economics: null,
};

test('a pre-retry verdict lacking the new fields still parses', () => {
  expect(FinalVerdictSchema.parse(legacy).attempt_count).toBeUndefined();
});
test('attempts with null est_cost_usd round-trips', () => {
  const v = FinalVerdictSchema.parse({
    ...legacy, final: 'indeterminate',
    attempts: [{ final: 'indeterminate', final_reason: 'hang', est_cost_usd: null },
               { final: 'pass', final_reason: 'ok', est_cost_usd: 0.24 }],
    attempt_count: 2, flaked_green: true,
  });
  expect(v.attempt_count).toBe(2);
  expect(v.flaked_green).toBe(true);
  expect(v.attempts?.[0]?.est_cost_usd).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/verdict-attempts.test.ts`
Expected: FAIL — `attempts`/`attempt_count`/`flaked_green` stripped (zod object drops unknown keys), so `v.attempt_count` is `undefined` on the second test's parse → `toBe(2)` fails.

- [ ] **Step 3: Add the fields** to `FinalVerdictSchema` in `src/contracts/verdict.ts` (after the `provenance` block, before the closing `})`)

```ts
  // Retry bookkeeping (transient-retry feature). Optional so an old verdict
  // lacking these parses; the runner writes all three on new verdicts
  // (single-attempt: attempt_count=1, flaked_green=false). est_cost_usd is null
  // for a hang-torn-down attempt with no priced trajectory.
  attempts: z
    .array(z.object({
      final: z.string(),
      final_reason: z.string(),
      est_cost_usd: z.number().nullable(),
    }))
    .optional(),
  attempt_count: z.number().optional(),
  flaked_green: z.boolean().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/verdict-attempts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/verdict.ts test/verdict-attempts.test.ts
git commit -m "feat(contracts): optional attempts/attempt_count/flaked_green on FinalVerdict"
```

---

### Task 3: Extract `driveOnce` — split evidence dir from phase.json dir

**This is the largest, purely-structural task.** `runInnerBody` currently threads one `runDir` for both evidence and the three `writePhase` calls. Split it so evidence takes `attemptDir` and only the three `writePhase` sites (`index.ts:1037,1391,1614`) take `cellRunDir`. Then `runScenario` drives attempt 1 into `<runDir>/attempts/1/`. **Behavior-preserving:** a normal single run must still pass end-to-end.

**Files:**
- Modify: `src/runner/index.ts` — `runInnerBody` signature (`:1031-1036`) + the three `writePhase` calls; `runInner` (`:1003`); `runScenario` (`:851-867`) to allocate `attempts/1/` and pass both dirs.
- Test: `test/runner-attempt-layout.test.ts` (new) + the existing `test/runner-e2e.test.ts` must still pass.

**Interfaces:**
- Produces: `async function driveOnce(a: RunScenarioArgs, attemptDir: string, cellRunDir: string, identity: RunIdentity): Promise<FinalVerdict>` (renamed/rewrapped `runInner`); evidence under `<cellRunDir>/attempts/<n>/`, `phase.json` at `<cellRunDir>`.
- Consumes: existing `runInnerBody`, `writePhase`, `cleanupAgentRuntime`.

- [ ] **Step 1: Write the failing test** (`test/runner-attempt-layout.test.ts`) — assert the layout split. Use the existing e2e harness/fixture pattern from `test/runner-e2e.test.ts` (copy its setup: a trivial scenario + a mock gauntlet). The new assertion after a successful `runScenario`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// ... reuse runner-e2e.test.ts scaffolding to run one scenario -> { runDir } ...
test('evidence nests under attempts/1 while phase.json stays at cell root', () => {
  // after runScenario(...) -> runDir
  expect(existsSync(join(runDir, 'phase.json'))).toBe(true);           // cell root
  expect(existsSync(join(runDir, 'verdict.json'))).toBe(true);         // cell root
  expect(existsSync(join(runDir, 'attempts', '1', 'coding-agent-workdir'))).toBe(true);
  expect(existsSync(join(runDir, 'attempts', '1', 'gauntlet-agent'))).toBe(true);
  expect(existsSync(join(runDir, 'coding-agent-workdir'))).toBe(false); // no longer at root
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/runner-attempt-layout.test.ts`
Expected: FAIL — today evidence is at the cell root (`runDir/coding-agent-workdir`), so `attempts/1/...` doesn't exist.

- [ ] **Step 3: Split `runInnerBody`'s dir param.** Change its signature and route the three phase writes to a new `cellRunDir`:

```ts
// index.ts:1031 — add cellRunDir param; everything else keeps using `runDir`
// (which now means "this attempt's dir").
async function runInnerBody(
  a: RunScenarioArgs,
  runDir: string,          // per-attempt evidence dir (renamed meaning, param name kept)
  cellRunDir: string,      // cell root — phase.json + windows guest-dir NAME
  cleanupDirs: string[],
  identity: RunIdentity,
): Promise<FinalVerdict> {
```

(Inside `runInnerBody`, `runDir` now means "this attempt's dir." The only cell-root
consumers are the 3 `writePhase` calls and the 3 windows `basename(...)` sites,
which take `cellRunDir` / `basename(cellRunDir)`.)

Change the three `writePhase(runDir, …)` calls (lines ~1037, ~1391, ~1614) to `writePhase(cellRunDir, …)`. Leave the evidence references untouched — they correctly become the attempt dir (workdir 1141, home 1148, logDir 1258, snapshot 1284, launchAgent 1292, populateContextDir 1370, invokeGauntlet 1419, capture 1526, token-usage 1540, post-checks 1615, economics 1664).

**CRITICAL — the windows guest-dir NAME must stay unique per cell, not per attempt.** Three windows sites derive a remote guest dir from `basename(runDir)`: the teardown Remove-Item (`:1021`), `pushWorkdir(workdir, basename(runDir))` (`:1200`), and `captureBack(..., basename(runDir))` (`:1510`). If these use `basename(attemptDir)`, the name collapses to the attempt number (`"1"`) and **concurrent windows cells collide on the shared guest** (`win_run_root\1`). Change these three sites to `basename(cellRunDir)` (the run_id — globally unique). A windows retry then reuses the same guest dir, which the Remove-Item teardown in the `finally` already cleans — acceptable, since windows runs on `ANTHROPIC_API_KEY` (not Bedrock) and are excluded from hang-detect, so retries are rare. So the split is: **3 writePhase → `cellRunDir`; 3 windows basename sites → `basename(cellRunDir)`; everything else → `attemptDir`.**

- [ ] **Step 4: Thread `cellRunDir` through `runInner` and rename it `driveOnce`.** `runInner` (`:1003`) gains the `cellRunDir` param and passes it to `runInnerBody`:

```ts
async function driveOnce(       // was runInner (index.ts:1003)
  a: RunScenarioArgs,
  attemptDir: string,
  cellRunDir: string,
  identity: RunIdentity,
): Promise<FinalVerdict> {
  const cleanupDirs: string[] = [];
  const os = a.os ?? 'linux';
  try {
    return await runInnerBody(a, attemptDir, cellRunDir, cleanupDirs, identity);
  } finally {
    cleanupAgentRuntime(cleanupDirs);
    if (os !== 'linux') { /* windows guest-dir teardown — uses basename(attemptDir) now */ }
  }
}
```

(The windows teardown block at `:1016-1027` keeps using its local `runDir` name → now `attemptDir`; `basename(attemptDir)` matches `pushWorkdir(workdir, basename(attemptDir))` at `:1201` since both derive from the same attempt dir.)

- [ ] **Step 5: In `runScenario`, allocate `attempts/1/` and call `driveOnce`.** Replace the `runInner(...)` call at `:853`:

```ts
import { mkdirSync } from 'node:fs';           // already imported
// ...
const attemptDir = join(runDir, 'attempts', '1');
mkdirSync(attemptDir, { recursive: true });
verdict = await driveOnce({ ...a, credential: credentialName }, attemptDir, runDir, identity);
```

- [ ] **Step 6: Run the layout test + the full e2e suite**

Run: `bun test test/runner-attempt-layout.test.ts test/runner-e2e.test.ts`
Expected: PASS — new layout holds AND the existing end-to-end behavior is unchanged (verdict.json at cell root, gauntlet/capture/economics all resolve under `attempts/1/`).

- [ ] **Step 7: Run the broader runner suite to catch consumers**

Run: `bun test test/runner-*.test.ts test/cli-run*.test.ts`
Expected: PASS. If any test asserts a path like `runDir/coding-agent-workdir`, update it to `runDir/attempts/1/...` (those assertions are now correct-by-design). Do NOT touch dashboard/run-all here — they read `verdict.json`/`phase.json` at the cell root (verified: shallow scanners, one level).

- [ ] **Step 8: Commit**

```bash
git add src/runner/index.ts test/runner-attempt-layout.test.ts
git commit -m "refactor(runner): extract driveOnce; nest evidence under attempts/<n>/, phase.json at cell root"
```

---

### Task 4: The retry loop

**Files:**
- Modify: `src/runner/index.ts` — `RunScenarioArgs` (`:350-371`, add `maxRetries?`); `runScenario` (`:851-889`, wrap `driveOnce` in the loop, annotate the verdict).
- New helper: `foldAttemptEconomics` (in `src/runner/retry.ts`, colocated with the predicate).
- Test: `test/runner-retry-loop.test.ts`

**Interfaces:**
- Consumes: `isRetryableIndeterminate` (Task 1), `safeBuildRunEconomics` (`index.ts:1674`), `FinalVerdict.attempts` (Task 2).
- Produces: cell verdict = last attempt's, annotated `attempts`/`attempt_count`/`flaked_green` + summed `economics`.

- [ ] **Step 1: Write the failing test** (`test/runner-retry-loop.test.ts`). Test the loop logic by injecting a fake `driveOnce` via a small seam — extract the loop into a testable pure-ish function `runAttempts(drive, maxRetries)`:

```ts
import { expect, test } from 'bun:test';
import { runAttempts } from '../src/runner/retry.ts';
import { CLAUDE_STARTUP_HANG_MARKER } from '../src/agents/claude.ts';

const hang = { schema: 1 as const, final: 'indeterminate' as const, final_reason: 'h',
  gauntlet: null, checks: [], economics: null,
  error: { stage: 'capture' as const, message: `${CLAUDE_STARTUP_HANG_MARKER}: x` } };
const pass = { schema: 1 as const, final: 'pass' as const, final_reason: 'ok',
  gauntlet: null, checks: [], economics: null, error: null };

test('retries a transient indeterminate then returns the passing attempt', async () => {
  const seq = [hang, pass];
  let calls = 0;
  const { verdict, attempts } = await runAttempts(
    async () => seq[calls++]!, 2, async () => null);
  expect(calls).toBe(2);
  expect(verdict.final).toBe('pass');
  expect(attempts).toHaveLength(2);
  expect(verdict.attempt_count).toBe(2);
  expect(verdict.flaked_green).toBe(true);
});
test('folds economics across attempts (both blocks + total)', async () => {
  const seq = [hang, pass]; let i = 0;
  const econ = (n: number) => ({ pricing_asof: null,
    coding_agent: { est_cost_usd: 0.10 * n }, gauntlet: { est_cost_usd: 0.05 * n },
    total_est_cost_usd: 0.15 * n, partial: false });
  const { verdict } = await runAttempts(async () => seq[i++]!, 2, async (n) => econ(n) as any);
  expect((verdict.economics as any).coding_agent.est_cost_usd).toBeCloseTo(0.30); // 0.10+0.20
  expect((verdict.economics as any).gauntlet.est_cost_usd).toBeCloseTo(0.15);     // 0.05+0.10
  expect((verdict.economics as any).total_est_cost_usd).toBeCloseTo(0.45);
});
test('stops immediately on a terminal fail (never retries a fail)', async () => {
  const fail = { ...pass, final: 'fail' as const };
  let calls = 0;
  const { verdict } = await runAttempts(async () => { calls++; return fail; }, 2, async () => null);
  expect(calls).toBe(1);
  expect(verdict.final).toBe('fail');
});
test('exhausts the cap on a persistent transient indeterminate', async () => {
  let calls = 0;
  const { verdict } = await runAttempts(async () => { calls++; return hang; }, 2, async () => null);
  expect(calls).toBe(3);               // 1 + 2 retries
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.attempt_count).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/runner-retry-loop.test.ts`
Expected: FAIL — `runAttempts` not exported.

- [ ] **Step 3: Add `runAttempts` + `foldAttemptEconomics` to `src/runner/retry.ts`**

```ts
import type { FinalVerdict } from '../contracts/verdict.ts';
import type { RunEconomics } from '../economics.ts';
// ... existing isRetryableIndeterminate ...

export interface AttemptRecord {
  final: string;
  final_reason: string;
  est_cost_usd: number | null;   // this attempt's coding-agent cost
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
function sumBlock(
  list: readonly (RunEconomics | null)[],
  pick: (e: RunEconomics) => number | null,
): number | null {
  let any = false, sum = 0;
  for (const e of list) { const v = e ? pick(e) : null; if (v != null) { any = true; sum += v; } }
  return any ? round6(sum) : null;
}

// Sum coding_agent + gauntlet est cost across attempts and recompute total
// (mirrors buildRunEconomics' null/round6 rules). Returned as the opaque
// Record the verdict's `economics` field carries.
export function foldAttemptEconomics(
  list: readonly (RunEconomics | null)[],
): Record<string, unknown> | null {
  const cSum = sumBlock(list, (e) => e.coding_agent?.est_cost_usd ?? null);
  const gSum = sumBlock(list, (e) => e.gauntlet?.est_cost_usd ?? null);
  const last = list[list.length - 1] ?? null;
  if (cSum == null && gSum == null) return last as unknown as Record<string, unknown> | null;
  return {
    ...(last as unknown as Record<string, unknown>),
    coding_agent: { ...(last?.coding_agent ?? {}), est_cost_usd: cSum },
    gauntlet: last?.gauntlet ? { ...last.gauntlet, est_cost_usd: gSum } : null,
    total_est_cost_usd: cSum != null && gSum != null ? round6(cSum + gSum) : (cSum ?? gSum),
  };
}

// Drives up to maxRetries+1 attempts; stops early on the first non-retryable
// verdict. `econOf(n)` returns that attempt's full RunEconomics (or null).
export async function runAttempts(
  drive: (attempt: number) => Promise<FinalVerdict>,
  maxRetries: number,
  econOf: (attempt: number) => Promise<RunEconomics | null>,
): Promise<{ verdict: FinalVerdict; attempts: AttemptRecord[] }> {
  const attempts: AttemptRecord[] = [];
  const econs: (RunEconomics | null)[] = [];
  let verdict!: FinalVerdict;
  for (let n = 1; n <= maxRetries + 1; n++) {
    verdict = await drive(n);
    const econ = await econOf(n);
    econs.push(econ);
    attempts.push({
      final: verdict.final,
      final_reason: verdict.final_reason,
      est_cost_usd: econ?.coding_agent?.est_cost_usd ?? null,
    });
    if (n > maxRetries || !isRetryableIndeterminate(verdict)) break;
  }
  const flaked_green = verdict.final === 'pass' && attempts.length > 1;
  const economics = attempts.length > 1 ? foldAttemptEconomics(econs) : verdict.economics;
  return {
    verdict: { ...verdict, attempts, attempt_count: attempts.length, flaked_green, economics },
    attempts,
  };
}
```

- [ ] **Step 4: Wire `runAttempts` into `runScenario`.** Add `maxRetries?: number | undefined` to `RunScenarioArgs` (`:360`), then replace the single `driveOnce` call (Task 3 Step 5) with:

```ts
const maxRetries = a.maxRetries ?? 2;
const { verdict: driven } = await runAttempts(
  async (n) => {
    const attemptDir = join(runDir, 'attempts', String(n));
    mkdirSync(attemptDir, { recursive: true });
    return driveOnce({ ...a, credential: credentialName }, attemptDir, runDir, identity);
  },
  maxRetries,
  async (n) => safeBuildRunEconomics(join(runDir, 'attempts', String(n))),
);
verdict = driven;
```

(`safeBuildRunEconomics(attemptDir)` reads that attempt's `coding-agent-token-usage.json`
+ `gauntlet-agent/results/` uniformly — works for both the happy path and a
hang-torn-down early return, since the sidecars live under `attemptDir` regardless.)

Keep the surrounding `try/catch` (`:851-867`): a `driveOnce` throw is caught by the existing compose-fallback (setup-stage → non-retryable → the loop is inside the try, so wrap the loop, not each attempt — a thrown setup error composes a terminal indeterminate and the loop is not re-entered). The `identified` spread at `:880` already carries `...verdict`, so `attempts`/`attempt_count`/`flaked_green` flow through to `verdict.json` unchanged.

- [ ] **Step 5: Run the loop + e2e suites**

Run: `bun test test/runner-retry-loop.test.ts test/runner-e2e.test.ts`
Expected: PASS — unit loop logic holds; a normal single run now writes `attempt_count: 1, flaked_green: false` and one `attempts` entry.

- [ ] **Step 6: Commit**

```bash
git add src/runner/index.ts src/runner/retry.ts test/runner-retry-loop.test.ts
git commit -m "feat(runner): cell-level retry loop with per-attempt evidence + summed economics"
```

---

### Task 5: StartupLivenessWatcher (two-phase, injectable clock/fs)

**Files:**
- Create: `src/agents/startup-watch.ts`
- Test: `test/startup-watch.test.ts`

**Interfaces:**
- Produces: `class StartupLivenessWatcher` — constructor `(opts: StartupWatcherOptions)`; `start(): void`; `stop(): Promise<void>`; public `tripped: boolean`. `StartupWatcherOptions = { markerPath, logDir, glob, snapshot: ReadonlySet<string>, teardownTarget, teardown, budgetMs, pollIntervalMs?, clock?, fs? }`.
- **Departure from `AgyRateLimitWatcher`:** that template has no injectable clock/fs; add `clock?: { now(): number; sleep(ms): Promise<void> }` and `fs?: { existsSync; newFiles(): string[]; readText(p): string }` seams (defaulting to real `node:fs` + `newFilesSince`) so the two-phase timing is deterministically testable.

- [ ] **Step 1: Write the failing test** (`test/startup-watch.test.ts`) using a fake clock + fake fs

```ts
import { expect, test } from 'bun:test';
import { StartupLivenessWatcher } from '../src/agents/startup-watch.ts';

// Fake clock. `advance` fires due timers; `tick()` is a REAL macrotask boundary
// that reliably drains the loop's microtasks to its next await (a bare
// `await Promise.resolve()` is NOT enough and makes the test flaky). The watcher
// loop MUST have exactly one `await clock.sleep` per iteration for this to hold.
function fakeClock() {
  let t = 0; const waiters: Array<{ at: number; r: () => void }> = [];
  return { now: () => t, sleep: (ms: number) => new Promise<void>((r) => waiters.push({ at: t + ms, r })),
    advance: (ms: number) => {
      t += ms;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.at <= t) { const [w] = waiters.splice(i, 1); w!.r(); }  // fire + remove due only
      }
    } };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('tears down when no assistant entry appears within the budget after launch', async () => {
  const clock = fakeClock();
  let torn = ''; let launched = false; let assistantLine = false;
  const w = new StartupLivenessWatcher({
    markerPath: '/m', logDir: '/log', glob: '**/*.jsonl', snapshot: new Set(),
    teardownTarget: '/scratch', teardown: (t) => { torn = t; }, budgetMs: 100, pollIntervalMs: 10,
    clock,
    fs: { existsSync: () => launched, newFiles: () => (assistantLine ? ['/log/a.jsonl'] : []),
      readText: () => (assistantLine ? '{"type":"assistant"}\n' : '') },
  });
  w.start(); await tick();
  clock.advance(10); await tick();     // marker absent -> still phase (a)
  launched = true; clock.advance(10); await tick();  // launched, budget starts
  clock.advance(100); await tick();    // budget elapses, no assistant entry
  await w.stop();
  expect(torn).toBe('/scratch');
  expect(w.tripped).toBe(true);
});

test('stands down when a first assistant entry appears in time', async () => {
  const clock = fakeClock();
  let torn = false;
  const w = new StartupLivenessWatcher({
    markerPath: '/m', logDir: '/log', glob: '**/*.jsonl', snapshot: new Set(),
    teardownTarget: '/s', teardown: () => { torn = true; }, budgetMs: 100, pollIntervalMs: 10, clock,
    fs: { existsSync: () => true, newFiles: () => ['/log/a.jsonl'],
      readText: () => '{"type":"user"}\n{"type":"assistant"}\n' },
  });
  w.start(); await tick();
  clock.advance(10); await tick();
  await w.stop();
  expect(torn).toBe(false);
  expect(w.tripped).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/startup-watch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agents/startup-watch.ts`** (mirror `agy-watch.ts` loop/stop discipline; add the two phases + seams)

```ts
import { existsSync as realExists, readFileSync } from 'node:fs';
import { newFilesSince } from '../capture/index.ts';

export type TeardownFn = (target: string) => unknown;
export interface StartupWatcherOptions {
  readonly markerPath: string;
  readonly logDir: string;
  readonly glob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly teardownTarget: string;
  readonly teardown: TeardownFn;
  readonly budgetMs: number;
  readonly pollIntervalMs?: number;
  readonly clock?: { now(): number; sleep(ms: number): Promise<void> };
  readonly fs?: { existsSync(p: string): boolean; newFiles(): string[]; readText(p: string): string };
}

// True iff any new transcript has a first assistant-role JSONL entry. Non-model
// writes (last-prompt/mode/attachment/file-history-snapshot/ai-title/user/system)
// are NOT liveness; only type==='assistant'. Tolerates a partial trailing line.
function hasAssistantEntry(files: string[], read: (p: string) => string): boolean {
  for (const f of files) {
    for (const line of read(f).split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      try { if ((JSON.parse(t) as { type?: string }).type === 'assistant') return true; }
      catch { /* partial/live line */ }
    }
  }
  return false;
}

export class StartupLivenessWatcher {
  tripped = false;
  private stopRequested = false;
  private loop: Promise<void> | null = null;
  private readonly o: StartupWatcherOptions;
  private readonly clock: NonNullable<StartupWatcherOptions['clock']>;
  private readonly fs: NonNullable<StartupWatcherOptions['fs']>;

  constructor(o: StartupWatcherOptions) {
    this.o = o;
    this.clock = o.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    this.fs = o.fs ?? {
      existsSync: realExists,
      newFiles: () => newFilesSince(o.logDir, o.glob, o.snapshot),
      readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } },
    };
  }

  start(): void { if (this.loop === null) { this.stopRequested = false; this.loop = this.run(); } }
  async stop(): Promise<void> { this.stopRequested = true; const p = this.loop; if (p) await p; }

  private async run(): Promise<void> {
    const poll = this.o.pollIntervalMs ?? 500;
    try {
      // Phase (a): await launch marker. No budget — a never-launching grader is
      // bounded by its own --max-time.
      while (!this.stopRequested && !this.fs.existsSync(this.o.markerPath)) {
        await this.clock.sleep(poll);
      }
      if (this.stopRequested) return;
      // Phase (b): liveness budget — require a first assistant entry.
      const deadline = this.clock.now() + this.o.budgetMs;
      while (!this.stopRequested) {
        if (hasAssistantEntry(this.fs.newFiles(), this.fs.readText)) return; // healthy
        if (this.clock.now() >= deadline) {
          this.o.teardown(this.o.teardownTarget);
          this.tripped = true;                                              // flag LAST
          return;
        }
        await this.clock.sleep(poll);
      }
    } finally { this.loop = null; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/startup-watch.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/agents/startup-watch.ts test/startup-watch.test.ts
git commit -m "feat(agents): StartupLivenessWatcher (two-phase launch+liveness, injectable clock/fs)"
```

---

### Task 6: Launch marker in the launcher

**Files:**
- Modify: `coding-agents/claude-context/launch-agent` (touch before `exec`, `:98-102`)
- Modify: `src/runner/index.ts` — add `$QUORUM_LAUNCH_MARKER` to the substitutions map inside the claude-family block (`:1314`), and to `forbiddenPlaceholders` (`:1376`)
- Test: `test/runner-context.test.ts` (extend — it already asserts launcher substitutions)

**Interfaces:**
- Produces: the published launcher contains `touch "$QUORUM_LAUNCH_MARKER"` with `$QUORUM_LAUNCH_MARKER` substituted to `<attemptDir>/launch.marker`.

- [ ] **Step 1: Write the failing test** — extend `test/runner-context.test.ts` (mirror its existing "launcher contains substituted X" assertions):

```ts
test('claude launcher marks $QUORUM_LAUNCH_MARKER before exec', () => {
  // after populateContextDir with a claude-family substitutions map incl.
  // $QUORUM_LAUNCH_MARKER='/attempt/launch.marker'
  expect(launcher).toContain('touch "/attempt/launch.marker"');
  expect(launcher).not.toContain('$QUORUM_LAUNCH_MARKER'); // fully substituted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/runner-context.test.ts`
Expected: FAIL — no `touch` line yet.

- [ ] **Step 3: Add the touch** to `coding-agents/claude-context/launch-agent`, immediately before the `exec env -i` block (`:98`):

```bash
# Mark launch for the StartupLivenessWatcher's phase (a) — must precede exec,
# which replaces this process. Parent dir is the run-scoped attempt dir.
mkdir -p "$(dirname "$QUORUM_LAUNCH_MARKER")" && touch "$QUORUM_LAUNCH_MARKER"

exec env -i \
  ...
```

- [ ] **Step 4: Thread the substitution** in `src/runner/index.ts`, inside the existing `if (family === 'claude' && !isRemote) { ... }` block near `:1314` (alongside `$CLAUDE_MODEL`):

```ts
const launchMarkerPath = join(attemptDir, 'launch.marker'); // attemptDir === runDir param of runInnerBody
substitutions['$QUORUM_LAUNCH_MARKER'] = launchMarkerPath;
```

Add `'$QUORUM_LAUNCH_MARKER'` to the `forbiddenPlaceholders` array passed to `populateContextDir` (`:1376-1381`) so an unsubstituted token fails the run loudly. Because `driveOnce` re-enters `runInnerBody` per attempt with a fresh `attemptDir`, the marker path is per-attempt and never stale (design §79).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/runner-context.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add coding-agents/claude-context/launch-agent src/runner/index.ts test/runner-context.test.ts
git commit -m "feat(runner): claude launcher touches $QUORUM_LAUNCH_MARKER before exec"
```

---

### Task 7: Wire the watcher into the drive + hang-marker intercept

**Files:**
- Modify: `src/runner/index.ts` — construct+start the watcher at the agy-watcher site (`:1400-1416`) under the claude gate; stop it in the `finally` (`:1432`); add the tripped→`writeIndeterminate(CLAUDE_STARTUP_HANG_MARKER, stage:'capture')` intercept right after the agy one (`:1446`).
- Test: `test/runner-hang-intercept.test.ts` (integration-style, or a targeted unit around the intercept).

**Interfaces:**
- Consumes: `StartupLivenessWatcher` (Task 5), `CLAUDE_STARTUP_HANG_MARKER` (Task 1), the resolved `logDir`/`snapshot` (`:1258`/`:1284`), `launchMarkerPath` (Task 6), `killGauntletTmuxForRun`.

- [ ] **Step 1: Write the failing test.** Simulate a hang: with a fake watcher forced `tripped=true`, the composed verdict must carry the marker in `error.message` with `stage:'capture'` and be retryable. The cleanest seam is to assert the intercept block: extract `hangVerdict(gauntlet, checks)` returning the `writeIndeterminate` and unit-test it.

```ts
import { hangVerdict } from '../src/runner/index.ts';   // export the small helper
import { isRetryableIndeterminate } from '../src/runner/retry.ts';
test('hang intercept produces a retryable capture-stage marked verdict', () => {
  const v = hangVerdict(null, []);
  expect(v.error?.stage).toBe('capture');
  expect(isRetryableIndeterminate(v)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/runner-hang-intercept.test.ts`
Expected: FAIL — `hangVerdict` not exported.

- [ ] **Step 3: Add the budget constant, `hangVerdict`, + the claude watcher gate/wiring.** First a module constant near `CAPTURE_RETRY_ATTEMPTS` (`index.ts:98`) — **not** an agent-config field (no such field exists; don't invent one):

```ts
// Phase-(b) liveness budget for the Claude startup-hang watcher. Conservative:
// a healthy launch→first-assistant is « this; calibrate in the live DoD.
const STARTUP_LIVENESS_BUDGET_MS = 120_000;
```

Then the claude gate (mutually exclusive with agy by `cfg.normalizer`):

```ts
const isClaudeHangWatched = cfg.normalizer === 'claude' && os === 'linux';
let startupWatcher: StartupLivenessWatcher | null = null;
if (isClaudeHangWatched) {
  startupWatcher = new StartupLivenessWatcher({
    markerPath: launchMarkerPath, logDir, glob: cfg.session_log_glob, snapshot,
    teardownTarget: runDir,   // the attempt dir; scratch under gauntlet-agent/results
    teardown: (target) => killGauntletTmuxForRun(target, (s) => killRunTmuxServer(s)),
    budgetMs: STARTUP_LIVENESS_BUDGET_MS,
  });
  startupWatcher.start();
}
```

Stop it in the same `finally` that stops the agy watcher (`:1432`): `if (startupWatcher) await startupWatcher.stop();`. Then, immediately after the agy `if (watcher?.tripped)` intercept (`:1446-1458`), add:

```ts
export function hangVerdict(
  gauntlet: GauntletLayer | null, checks: readonly CheckRecord[],
): FinalVerdict {
  return writeIndeterminate({
    finalReason: 'Claude wedged at startup (transient model-access hang); torn down, no usable transcript',
    gauntlet, checks,
    error: { stage: 'capture', message: `${CLAUDE_STARTUP_HANG_MARKER}: watcher tore down a wedged Claude` },
  });
}
// ... in runInnerBody, after the agy intercept:
if (startupWatcher?.tripped) return hangVerdict(gauntlet, pre.records);
```

(This sits BEFORE the strict capture cascade at `:1595`, so a torn-down Claude yields a *marked* capture verdict, not the unmarked zero-row one — design gotcha #6.)

- [ ] **Step 4: Run the test + full runner suite**

Run: `bun test test/runner-hang-intercept.test.ts test/runner-e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runner/index.ts test/runner-hang-intercept.test.ts
git commit -m "feat(runner): wire StartupLivenessWatcher for claude/linux + hang-marker intercept"
```

---

### Task 8: `--max-retries` plumbing (run + run-all)

**Files:**
- Modify: `src/cli/index.ts` — `run` `.option('--max-retries <n>')` (`:157`), `RunOptions` (`:104`), pass into `runScenario` (`:201`); run-all `.option` (`:365`), `RunAllOptions` (`:121`), forward into `runBatch` (`:410`).
- Modify: `src/run-all/index.ts` — `InvokeChildArgs` (`:65`), `buildChildRunArgs` (`:170`), `RunBatchArgs`/destructure/`invokeCell` (`:221`/`:390`/`:497`).
- Test: `test/run-all-child-args.test.ts` (extend — asserts `buildChildRunArgs`).

**Interfaces:**
- Consumes: `RunScenarioArgs.maxRetries` (Task 4), `parseIntegerOption` (`cli/index.ts:84`).

- [ ] **Step 1: Write the failing test** (extend `test/run-all-child-args.test.ts`)

```ts
test('buildChildRunArgs forwards --max-retries', () => {
  const args = buildChildRunArgs({ scenarioDir: '/s', codingAgent: 'claude',
    codingAgentsDir: '/c', outRoot: '/o', maxRetries: 3 });
  expect(args).toContain('--max-retries');
  expect(args[args.indexOf('--max-retries') + 1]).toBe('3');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/run-all-child-args.test.ts`
Expected: FAIL — `maxRetries` not in `InvokeChildArgs` / not appended.

- [ ] **Step 3: Thread it** through the `--grader-model` precedent chain (copy each site):
  - `src/run-all/index.ts:65-84` `InvokeChildArgs`: add `readonly maxRetries?: number;`
  - `buildChildRunArgs` (`:170-189`): `if (args.maxRetries !== undefined) childArgs.push('--max-retries', String(args.maxRetries));`
  - `RunBatchArgs` (`:221`): `readonly maxRetries?: number;`; destructure in `runBatch` (`:390`); `invokeCell` (`:497-505`): `...(maxRetries !== undefined ? { maxRetries } : {}),`
  - `src/cli/index.ts`: `RunOptions` (`:104`) + `RunAllOptions` (`:121`) add `readonly maxRetries?: string;`; both commands add `.option('--max-retries <n>', 'retry transient-infra indeterminates up to <n> times', parseIntegerOption)`; the `run` action (`:201`) passes `maxRetries: opts.maxRetries !== undefined ? Number(opts.maxRetries) : undefined`; the run-all action (`:410`) forwards `...(opts.maxRetries !== undefined ? { maxRetries: Number(opts.maxRetries) } : {})`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/run-all-child-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/run-all/index.ts test/run-all-child-args.test.ts
git commit -m "feat(cli): --max-retries on run + run-all (threads RunScenarioArgs.maxRetries)"
```

---

### Task 9: Surface attempts in `quorum show`

**Files:**
- Modify: `src/cli/render.ts` — `formatHeader` (`:321-336`)
- Test: `test/render.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
test('formatHeader shows an attempts line with flaked-green when retried to pass', () => {
  const v = { schema: 1, final: 'pass', final_reason: 'ok', gauntlet: null, checks: [],
    error: null, economics: null, attempt_count: 2, flaked_green: true } as FinalVerdict;
  expect(formatHeaderForTest(v)).toContain('attempts');
  expect(formatHeaderForTest(v)).toContain('flaked-green');
});
test('formatHeader omits the attempts line for a single-attempt run', () => {
  const v = { /* attempt_count: 1 */ } as FinalVerdict;
  expect(formatHeaderForTest(v)).not.toContain('attempts ');
});
```

(If `formatHeader` is not exported, export it or a thin `formatHeaderForTest` wrapper — match how `render.test.ts` currently reaches internal helpers.)

- [ ] **Step 2: Run test to verify it fails** — `bun test test/render.test.ts` → FAIL (no attempts line).

- [ ] **Step 3: Add the conditional line** to `formatHeader` (before the `return`, append when retried):

```ts
  const retryLine = (verdict.attempt_count ?? 1) > 1
    ? `${label('attempts ', color)} ${verdict.attempt_count}${verdict.flaked_green ? ' (flaked-green)' : ''}\n`
    : '';
  return (
    `${label('run-dir  ', color)} ${runDir}\n` +
    `${label('final    ', color)} ${finalStyled}\n` +
    `${label('reason   ', color)} ${verdict.final_reason}\n` +
    retryLine
  );
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/render.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/render.ts test/render.test.ts
git commit -m "feat(cli): show renders an attempts/flaked-green line for retried cells"
```

---

### Task 10: Surface attempts + flaked-green tally in run-all

**Files:**
- Modify: `src/run-all/index.ts` — `VerdictViewSchema` (`:710-723`) add fields; `counts` accumulator (`:448-456`) add `flaked_green: 0`; increment in the `cell_finished` branch (`:522-540`); footer segment (`:615-625`).
- Test: `test/run-all-summary.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — assert the run-all summary includes a `flaked-green N` segment when a cell verdict has `flaked_green: true`. Reuse the summary-assembly seam the existing `rate_limited`/`stopped` tallies test.

- [ ] **Step 2: Run test to verify it fails** — FAIL (no flaked-green tally).

- [ ] **Step 3: Implement:**
  - `VerdictViewSchema` (`:710`): add `flaked_green: z.boolean().optional()` and `attempt_count: z.number().optional()`.
  - `counts` (`:448`): add `flaked_green: 0`.
  - In `onEvent`'s `cell_finished` branch (`:522`): `if (readVerdict(join(outRoot, event.run_id ?? ''))?.flaked_green) counts.flaked_green++;`
  - Summary (`:615-625`): `if (counts.flaked_green > 0) summary += ` · ${counts.flaked_green} flaked-green`;`

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run-all/index.ts test/run-all-summary.test.ts
git commit -m "feat(run-all): flaked-green tally in the batch summary; VerdictView reads retry fields"
```

---

### Task 11: Surface flaked-green in the dashboard

**Files:**
- Modify: `packages/dashboard/src/contracts.ts` — `DashboardVerdictSchema` (`:71-105`), `RunRecord` (`:113-127`), `CellView` (`:210-238`), `fallbackCell`
- Modify: `packages/dashboard/src/scan.ts` — `records.push({...})` (`:226-243`)
- Modify: `packages/dashboard/src/view.ts` — project `RunRecord.flaked_green` → `CellView.flaked_green`
- Modify: `packages/dashboard/src/templates.ts` — `cellHtml` done-face (`:199-208`), badge like `drift` (`:179`)
- Test: `packages/dashboard/test/*.test.ts` (extend the scan + templates tests)

- [ ] **Step 1: Write the failing test** — (a) `scan` maps `verdict.flaked_green` into the `RunRecord`; (b) `cellHtml` renders a flaked-green badge span when `view.flaked_green`.

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Implement:**
  - `DashboardVerdictSchema` (`:71`): add `flaked_green: z.boolean().optional().catch(undefined)` (every field carries `.catch`, per the schema's contract).
  - `RunRecord` + `scan.ts:226` push: `flaked_green: verdict.flaked_green ?? false,`.
  - `CellView` + `fallbackCell`: add `flaked_green: boolean`; `view.ts` sets it from the newest `RunRecord`.
  - `cellHtml` done-face (`:199`): concat a badge span beside `drift`, e.g. `${view.flaked_green ? '<span class="flaked" title="passed only after a retry">↻</span>' : ''}` (add a `.flaked` CSS rule near `.drift`).

- [ ] **Step 4: Run test to verify it passes** — `bun test packages/dashboard/test/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src packages/dashboard/test
git commit -m "feat(dashboard): flaked-green cell badge from verdict.flaked_green"
```

---

### Task 12: Full-suite gate + live DoD

**Files:** none (verification task).

- [ ] **Step 1: Run the full check** — `bun run check` (biome + tsc + all tests). Expected: green, 0 fail. Fix any biome/tsc drift from the new files.
- [ ] **Step 2: Run scenario validation** — `bun run quorum check`. Expected: ok (no scenario changes, but confirms nothing regressed).
- [ ] **Step 3: Live DoD (trusted-maintainer, appliance).** Per the spec's DoD:
  - Inject a **transient** fault present on attempt 1 only (a hook suppressing just attempt 1's assistant-turn transcript write) on one claude/opus_bedrock scenario; confirm the watcher tears down within ~budget, the cell retries, attempt 2 passes, and the cell verdict shows `attempt_count: 2, flaked_green: true` with summed economics.
  - Re-run the 12-scenario CC sentinel × opus_bedrock × n=3. Bar: no transient-retryable indeterminate resolves within the cap unseen; any residual is `attempt_count == cap+1` with every attempt in a retryable class; flaked-green cells flagged in `show`/run-all/dashboard.
- [ ] **Step 4: File the ticket** and cross-link the spec + this plan.
- [ ] **Step 5: Commit** any doc/cross-link updates.

---

## Self-Review

- **Spec coverage:** Decisions 1 (cap, Task 4/8) · 2/3 predicate (Task 1) · 4 two-phase watcher (Task 5/6/7) · 5 single-run-dir + nested attempts + phase.json-at-root (Task 3) · 6 visibility/economics/flaked-green (Task 4/9/10/11) · Architecture §1-§4 all mapped · DoD (Task 12). No spec section unmapped.
- **Type consistency:** `isRetryableIndeterminate`, `runAttempts`, `hangVerdict`, `StartupLivenessWatcher`, `CLAUDE_STARTUP_HANG_MARKER`, `RunScenarioArgs.maxRetries`, `buildChildRunArgs`+`maxRetries` — names used identically across producing and consuming tasks.
- **Deferred-to-plan items resolved:** driveOnce two-dir split (Task 3), economics summing (Task 4 `runAttempts`/`foldAttemptEconomics`), launch-marker mechanism (Task 6), watcher clock/fs seams (Task 5). Remaining open (spec Open items): the phase-(b) budget **magnitude** (120s default, calibrate in Task 12 live) and the true `investigate` split (out of scope).
</content>
