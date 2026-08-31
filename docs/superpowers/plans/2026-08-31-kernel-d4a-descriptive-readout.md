# Kernel D4a — Descriptive Readout (seal act + report engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the D4a increment — campaigns seal themselves (`render → digest → sealed → publish`) and `quorum campaign report` renders a byte-stable descriptive readout — per `docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md` (revision 2).

**Architecture:** Three new modules over D3's shipped seams. `src/campaign/report-evidence.ts` reads the pinned per-run evidence files (fail-closed). `src/campaign/report.ts` folds journal + evidence into the amended `ReportSchema`, serializes canonically, digests, and publishes `report.md` then `report.json` (stage+fsync+rename). `src/campaign/seal.ts` owns the terminus sequence and is invoked from `resumeCampaign` (one wiring point serves both the live-completion and R-RCV-5 resume paths, because a dispatch with everything terminal exits `completed` immediately). `quorum campaign report` is a journal-read-only verb over the same fold.

**Tech Stack:** TypeScript on Bun (≥1.3), zod contracts, `bun:sqlite` journal (via D3's `electWriter`), `node:crypto` SHA-256, existing `Clock`/`CommandRunner` seams. Tests: `bun test`, no mocked behavior.

## Global Constraints

- The spec's ratified decisions D-1…D-9 are binding; where this plan says "spec §X", that text governs.
- Repo gate: `bun run check` (biome + tsc + full suite) and `bun run quorum check` green after every task; every sub-task commits green.
- No mocked-behavior tests (PAR §Testing): fixtures are real journals/run-dir trees on tmpdirs through the production seams.
- Byte-stability: `REPORT_RENDERING` constants only (`src/contracts/campaign/report.ts`) — sorted keys, shortest-round-trip doubles, LF. Per-host claim, never cross-host.
- The seal act journals ONLY through `electWriter({ restrict: ['adjudication', 'sealed'] })` (R-JRN-3 hand-off). Dispatch events are never appended at the terminus.
- The fold's journal input is every event BEFORE `sealed` (fold excludes the digest-bearing event — no cycle).
- Adjudication block identity rides the rationale: `block=<block_id>; <detail>` (the `attemptScopedRationale` convention, `src/contracts/campaign/journal-events.ts`).
- Fail-closed everywhere: missing/malformed evidence joins a typed class and is counted; nothing is invented.
- Commit style: `feat(campaign): …` / `fix(campaign): …` / `test(campaign): …`, one logical unit per commit.

**Review-process note:** the D3 plan-review record (`docs/experiments/2026-08-27-kernel-d3-plan-review.md`) fired its two-bounce rule against uncompiled code-as-prose. Every task here therefore starts by compiling what exists (`bun run typecheck`) and every code block in this plan is the intended final shape, not pseudocode — an implementer who finds a block that does not compile fixes it at the compiler, then records the deviation in the task's commit body.

---

### Task 1: `ReportSchema` amendment (Decision D-8)

**Files:**
- Modify: `src/contracts/campaign/report.ts`
- Test: `test/campaign-contracts-report.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `FiniteNumberSchema` (`src/contracts/finite.ts`), `CELL_CLASSES` (`src/contracts/campaign/suite.ts`).
- Produces: amended `ReportSchema` — cells carry `pass`/`fail`/`coverage`; comparisons carry `medians`; accounting carries `contention_invalidated`/`unknown_coverage`; provenance carries `failed_cells` and nullable `grader.observed`. Every later task's fixtures build against this exact shape.

- [ ] **Step 1a: Write the failing amendment tests** — append to `test/campaign-contracts-report.test.ts` (read the file first; its existing builder must gain the new required fields so the whole file stays green):

```typescript
test('D-8: cells carry pass/fail counts and coverage', () => {
  const report = descriptiveReport({
    cells: [
      {
        scenario: 'scn',
        class: 'descriptive',
        n: 5,
        pass: 3,
        fail: 1,
        coverage: 0.8,
      },
    ],
  });
  expect(ReportSchema.parse(report).comparisons[0].cells[0].pass).toBe(3);
});

test('D-8: negative counts and coverage outside [0,1] reject', () => {
  expect(() =>
    ReportSchema.parse(descriptiveReport({ cells: [cell({ pass: -1 })] })),
  ).toThrow();
  expect(() =>
    ReportSchema.parse(descriptiveReport({ cells: [cell({ coverage: 1.2 })] })),
  ).toThrow();
});

test('D-8: comparisons carry a (possibly empty) medians object', () => {
  const parsed = ReportSchema.parse(
    descriptiveReport({ medians: { tokens: 1234, usd: 5.6 } }),
  );
  expect(parsed.comparisons[0].medians).toEqual({ tokens: 1234, usd: 5.6 });
  const empty = ReportSchema.parse(descriptiveReport({}));
  expect(empty.comparisons[0].medians).toEqual({});
});

test('D-8: accounting names both contention dispositions', () => {
  const parsed = ReportSchema.parse(
    descriptiveReport({
      accounting: { contention_invalidated: 2, unknown_coverage: 1 },
    }),
  );
  expect(parsed.accounting.contention_invalidated).toBe(2);
  expect(parsed.accounting.unknown_coverage).toBe(1);
});

test('D-8: provenance carries failed_cells; grader.observed is nullable', () => {
  const parsed = ReportSchema.parse(
    descriptiveReport({
      provenance: {
        failed_cells: [
          { comparison_id: 'c1', scenario: 'scn', reason: 'arm model absent from observed set' },
        ],
        grader_observed: undefined,
      },
    }),
  );
  expect(parsed.provenance.failed_cells).toHaveLength(1);
  expect(parsed.provenance.grader.observed).toBeUndefined();
});

test('D-8: strictness survives — unknown keys still reject', () => {
  expect(() =>
    ReportSchema.parse(descriptiveReport({ extra_top_level: 1 } as never)),
  ).toThrow();
});
```

(`descriptiveReport`, `cell`, and the overrides argument are the file's existing test-builder pattern, extended: `cells`, `medians`, `accounting`, `provenance` overrides deep-merge into a minimal valid descriptive report. If the existing file builds reports inline instead, refactor to a builder FIRST in this same step, commit-neutral, then add the tests.)

- [ ] **Step 1b: Run tests to verify they fail**

Run: `bun test test/campaign-contracts-report.test.ts`
Expected: FAIL — unknown keys rejected by the current `.strict()` schema / missing required fields.

- [ ] **Step 1c: Implement the amendment** — modify `src/contracts/campaign/report.ts`:

```typescript
// cells: after the existing n/delta/fisher_p/mde fields —
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    coverage: FiniteNumberSchema.min(0).max(1),

// comparisons: alongside cells —
    medians: z
      .object({
        tokens: FiniteNumberSchema.optional(),
        usd: FiniteNumberSchema.optional(),
      })
      .strict(),

// accounting: alongside the existing eight counters —
    contention_invalidated: z.number().int().nonnegative(),
    unknown_coverage: z.number().int().nonnegative(),

// provenance: alongside arms/grader —
    failed_cells: z.array(
      z
        .object({
          comparison_id: z.string().min(1),
          scenario: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict(),
    ),

// grader: observed becomes optional —
    observed: z.string().min(1).optional(),
```

Update the file's header comment: the amendment is Decision D-8 of the D4a spec (`docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md`); `REPORT_RENDERING` is unchanged.

- [ ] **Step 1d: Fix every existing report fixture in the repo for the new required fields**

Run: `bun run typecheck && bun test test/ | grep -i report` (then the full suite)
Expected: the contract tests above PASS; any other fixture using `ReportSchema` (search: `grep -rn "ReportSchema\|profile: 'descriptive_v1'" test src`) updated to carry `pass/fail/coverage/medians/contention counters/failed_cells`. No unrelated behavior changes.

- [ ] **Step 1e: Full gate + commit (task 1)**

```bash
bun run check
git add src/contracts/campaign/report.ts test/campaign-contracts-report.test.ts
git commit -m "feat(campaign): D-8 ReportSchema amendment — counts, medians, contention counters, provenance findings"
```

---

### Task 2: Run-dir evidence reader (`report-evidence.ts`)

**Files:**
- Create: `src/campaign/report-evidence.ts`
- Test: `test/campaign-report-evidence.test.ts`

**Interfaces:**
- Consumes: the pinned evidence files per run dir — `verdict.json` and costs via the EXISTING exported readers `readVerdictSummary`/`runCostFromArtifacts` (`src/campaign/dispatcher.ts:903/939`), `trajectory.json` (`ATIF_TRAJECTORY_FILENAME`, `src/capture/index.ts:70`; exposure discipline `trajectoryExposureMs`, `src/campaign/sensors.ts:661`), `coding-agent-token-usage.json` (`src/capture/index.ts:740`), and the Gauntlet `result.json` (`config.model`, `src/contracts/gauntlet.ts:14`; locate the read the same way `readRunSensorEvidence`/capture locate gauntlet artifacts — grep `gauntlet-agent` in `src/campaign/sensors.ts` for the production path). Reuse the exported readers; do not re-parse their files.
- Produces:

```typescript
export interface SampleEvidence {
  /** null outcome = the sample's class comes from the journal (instrument
   *  failure, indeterminate) — the reader returns what the run dir holds. */
  readonly outcome: 'pass' | 'fail' | 'indeterminate' | null;
  readonly observedModels: readonly string[]; // trajectory step model_name set, ordered
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly graderModel: string | null; // gauntlet result.json config.model
}

export function readSampleEvidence(args: {
  readonly runDir: string;
  readonly sampleId: string;
}): SampleEvidence;
```

Malformed file ⇒ that FIELD is null/empty (fail-closed per field), never a throw — the fold counts the sample by its journal class. Absent run dir ⇒ all-null evidence.

- [ ] **Step 2a: Write the failing tests** — create `test/campaign-report-evidence.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSampleEvidence } from '../src/campaign/report-evidence.ts';

function runDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(body));
  }
  return dir;
}

describe('readSampleEvidence', () => {
  test('reads outcome, observed models, tokens, cost, grader identity', () => {
    // build the four pinned artifacts with their real on-disk names and
    // shapes (verdict.json, trajectory.json steps carrying model_name,
    // coding-agent-token-usage.json, the gauntlet result.json path)
    const dir = runDir({ /* … real artifact tree … */ });
    const ev = readSampleEvidence({ runDir: dir, sampleId: 'c1:scn:arm_a:r1' });
    expect(ev.outcome).toBe('pass');
    expect(ev.observedModels).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5']);
    expect(ev.totalTokens).toBe(48200);
    expect(ev.costUsd).toBeCloseTo(1.23);
    expect(ev.graderModel).toBe('claude-sonnet-4-6');
  });

  test('absent run dir is all-null evidence, not a throw', () => {
    const ev = readSampleEvidence({ runDir: '/nonexistent/x', sampleId: 's' });
    expect(ev.outcome).toBeNull();
    expect(ev.observedModels).toEqual([]);
    expect(ev.totalTokens).toBeNull();
  });

  test('a malformed trajectory fails closed per field, not per sample', () => {
    const dir = runDir({ 'trajectory.json': { not: 'a trajectory' }, /* verdict valid */ });
    const ev = readSampleEvidence({ runDir: dir, sampleId: 's' });
    expect(ev.outcome).toBe('pass'); // verdict still reads
    expect(ev.observedModels).toEqual([]); // trajectory field fails closed
  });

  test('observed model set is ordered and deduplicated', () => { /* two steps, same model twice + one different */ });
});
```

Fill the artifact bodies from the REAL shapes — read `src/capture/index.ts` (trajectory emission + token-usage write) and `src/contracts/gauntlet.ts` first; do not invent field names. The gauntlet `result.json` lives under the run dir's gauntlet-agent results subtree — confirm the exact relative path from `src/campaign/sensors.ts`'s gauntlet-artifact reads and pin it in a comment.

- [ ] **Step 2b: Run tests to verify they fail**

Run: `bun test test/campaign-report-evidence.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2c: Implement `src/campaign/report-evidence.ts`** — parse each artifact with its existing zod schema (`VerdictSchema` subset via the recovery reader's discipline, `TrajectorySchema` from `src/atif/validate.ts`, the economics `TokenUsageSchema`, `GauntletResultSchema`), each in its own try/catch returning the field default on failure. `observedModels`: walk trajectory steps, collect `model_name` where present, dedupe, sort. Order and names exactly as the interface above.

- [ ] **Step 2d: Run tests to verify they pass**

Run: `bun test test/campaign-report-evidence.test.ts`
Expected: PASS.

- [ ] **Step 2e: Full gate + commit (task 2)**

```bash
bun run check
git add src/campaign/report-evidence.ts test/campaign-report-evidence.test.ts
git commit -m "feat(campaign): run-dir evidence reader — the report fold's pinned source table, fail-closed per field"
```

---

### Task 3: The descriptive fold (`report.ts`, fold half)

**Files:**
- Create: `src/campaign/report.ts`
- Test: `test/campaign-report.test.ts`
- Modify: `test/campaign-recovery-fixtures.ts` (extend the campaign-doc/journal builders for report fixtures)

**Interfaces:**
- Consumes: `Campaign` (`src/contracts/campaign/campaign.ts`), `JournalEvent` (`src/contracts/campaign/journal-events.ts`), `replayEvents`/materialized state (`src/campaign/journal.ts`), `SampleEvidence` (task 2), `ReportSchema` (task 1).
- Produces:

```typescript
export class ReportFoldError extends Error {}

export function foldDescriptiveReport(args: {
  readonly campaign: Campaign;
  /** Every journal event BEFORE `sealed` (the fold never sees the digest
   *  event — no cycle). */
  readonly events: readonly JournalEvent[];
  readonly evidenceOf: (runId: string, sampleId: string) => SampleEvidence;
}): Report;
```

Throws `ReportFoldError` (typed, loud) when the campaign's registered profile is `release_gate_v1` — "sealing/reporting gating campaigns awaits D4b" — and when a required quantity is neither computable nor classifiable (never silent).

Fold rules (spec §The report engine — the implementer reads that section before coding):

1. **Included set from materialized state** — replay the events; one included outcome per primary slot: successors where a replacement landed, superseded instances excluded via `superseded_by` cross-check. `sample_disposition { included }` is never journaled (derivation only).
2. **Rates** per cell per arm: `n` (included samples), `pass`/`fail` counts over determinate evidence, `coverage` = determinate/total; delta (treatment − baseline) for two-arm cells; single-arm cells render without delta.
3. **Medians** per comparison over matched determinate cells: tokens and dollars from evidence; unpriced arms contribute tokens only (the caveat is named in `report.md`, task 4).
4. **Provenance per run**: an included sample whose observed set lacks its arm's registered model marks its cell — `failed_cells` entry + exclusion from rate/median aggregation; the arm-level union renders in `provenance.arms`. Grader: registered model vs evidence `graderModel` across graded samples; any mismatch fails every graded cell. All-null grader evidence ⇒ `grader.observed` absent + a failed_cells-style loud caveat entry naming the empty-evidence case.
5. **Accounting**: instrument errors, indeterminates, replacements (`block_replaced`), reserve draws, skew caveats/exclusions from skew events (exclusions 0 in exploratory — caveat-only per R-DSP-9; the fold still reads the events), `contention_invalidated`/`unknown_coverage` from adjudication dispositions, budget events, amendments (0 in D4a), denominators per cell.

- [ ] **Step 3a: Extend the fixture builders** — in `test/campaign-recovery-fixtures.ts` add: `reportCampaign(overrides)` (a small exploratory two-arm suite: one comparison, one cell, two arms, n=2, `profile: 'descriptive_v1'` or absent) and `reportEvents(...)` helpers that synthesize a replay-legal event prefix (campaign_opened → block_admitted → attempt_created → run_allocated → exposure_started → run_completed per sample, envelope ts from the fixtures' `FakeClock` convention). Keep builders in the fixtures file, tests in the test file.

- [ ] **Step 3b: Write the failing fold tests** — create `test/campaign-report.test.ts`:

```typescript
describe('foldDescriptiveReport', () => {
  test('happy path: rates, delta, medians, accounting, provenance', () => {
    // n=2 cell: baseline 2 pass, treatment 1 pass 1 fail
    const report = foldDescriptiveReport({ campaign, events, evidenceOf });
    const cell = report.comparisons[0].cells[0];
    expect(cell.pass).toBe(/* … */); expect(cell.fail).toBe(/* … */);
    expect(cell.delta).toBeCloseTo(-0.5);
    expect(report.accounting.denominators['c1:scn']).toBe(4);
    expect(report.stamp).toBe('DESCRIPTIVE');
  });

  test('replaced block: successor included, superseded excluded, replacement counted', () => { /* … */ });
  test('instrument-failed sample: counted in accounting, never in rates', () => { /* … */ });
  test('contention adjudications land in the two counters by disposition', () => { /* … */ });
  test('provenance mismatch fails the cell, excludes it, names it in failed_cells', () => { /* … */ });
  test('grader mismatch fails every graded cell loudly', () => { /* … */ });
  test('empty grader evidence renders observed absent with a loud caveat', () => { /* … */ });
  test('single-arm comparison renders rates without delta', () => { /* … */ });
  test('exploratory suite without a declared profile folds as descriptive_v1', () => { /* … */ });
  test('gating campaign refuses with the D4b-awaiting typed error', () => {
    expect(() => foldDescriptiveReport({ campaign: gatingCampaign, events, evidenceOf }))
      .toThrow(/awaits D4b/);
  });
  test('skew caveat events count as caveats; exclusions render 0 in exploratory', () => { /* … */ });
});
```

Each test builds its fixture with the builders from step 3a — full event prefixes, no shorthand. The expected values are computed by hand in the test body and commented.

- [ ] **Step 3c: Run tests to verify they fail**

Run: `bun test test/campaign-report.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3d: Implement the fold** in `src/campaign/report.ts` per the five rules above, one function per rule, the top-level `foldDescriptiveReport` composing them. Median helper: sort, middle value (even count: mean of the two middles — pin this in a comment). Every fail-closed branch names its class in the accounting. Validate the final object with `ReportSchema.parse` inside the fold (schema-invalid fold output is a `ReportFoldError`, spec §Refusal table).

- [ ] **Step 3e: Run tests to verify they pass**

Run: `bun test test/campaign-report.test.ts`
Expected: PASS.

- [ ] **Step 3f: Full gate + commit (task 3)**

```bash
bun run check
git add src/campaign/report.ts test/campaign-report.test.ts test/campaign-recovery-fixtures.ts
git commit -m "feat(campaign): the descriptive fold — journal + evidence into the amended ReportSchema, fail-closed"
```

---

### Task 4: Canonical serialization, digest, publication (`report.ts`, render half)

**Files:**
- Modify: `src/campaign/report.ts`
- Test: `test/campaign-report.test.ts` (extend)

**Interfaces:**
- Consumes: `Report` (task 3), `REPORT_RENDERING` (`src/contracts/campaign/report.ts`).
- Produces:

```typescript
export function canonicalReportBytes(report: Report): Buffer; // sorted keys, shortest-round-trip doubles, LF, trailing newline
export function digestReportBytes(bytes: Buffer): string;      // sha256 lowercase hex (64 chars — the SealedEvent grammar)
export function renderReportMd(args: { report: Report; campaign: Campaign }): string;
export function publishReport(args: { campaignDir: string; md: string; jsonBytes: Buffer }): void;
export function cleanupOrphanTemps(campaignDir: string): void; // removes .report-*.tmp leftovers of a crashed publication
export const REPORT_MD_NAME = 'report.md';
export const REPORT_JSON_NAME = 'report.json';
```

`renderReportMd` renders: the `DESCRIPTIVE` stamp first; per-comparison rates with n/denominator/coverage on every number; medians; the accounting block in full; provenance findings; the named empty section "tags/declared metrics — deferred to D4b (no aggregation registry pinned)" (Decision D-9); unpriced-arm coverage caveats. Deterministic for identical inputs.

`publishReport`: `report.md` FIRST, `report.json` LAST as the completion marker (PAR §Execution → Sealing); each artifact written as `<name>.tmp.<pid>` → fsync file → fsync dir → rename over the final name (the D3 marker discipline — see `link(2)`/stage-fsync-rename in `src/campaign/dispatcher.ts` for the house pattern).

- [ ] **Step 4a: Write the failing byte-stability + publication tests** — append to `test/campaign-report.test.ts`:

```typescript
test('canonical bytes: sorted keys, LF, trailing newline, stable across repeated renders', () => {
  const report = /* fixture report */;
  const a = canonicalReportBytes(report);
  const b = canonicalReportBytes(report);
  expect(a.equals(b)).toBe(true);
  expect(a.toString('utf8').endsWith('\n')).toBe(true);
  const parsed = JSON.parse(a.toString('utf8'));
  expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
});

test('digest is the 64-hex sha256 of the canonical bytes', () => {
  const bytes = canonicalReportBytes(/* … */);
  expect(digestReportBytes(bytes)).toMatch(/^[0-9a-f]{64}$/);
  // cross-check against node:crypto directly in the test
});

test('golden oracle: the full fixture report renders byte-exact', () => {
  const bytes = canonicalReportBytes(goldenReport);
  expect(bytes.toString('utf8')).toBe(GOLDEN_REPORT_JSON); // committed fixture string
});

test('publishReport writes md first, json last, both atomic; orphans cleaned', () => {
  // stage a fake orphan .report.json.tmp.999 first; publish; assert orphan
  // gone, both files present, contents byte-exact
});
```

The golden fixture (`GOLDEN_REPORT_JSON`) is committed inline in the test file — generated ONCE by hand from the fixture report and then frozen; any serializer change breaks it loudly.

- [ ] **Step 4b: Run tests to verify they fail**, implement, run to pass, full gate + commit:

```bash
bun test test/campaign-report.test.ts   # FAIL, then PASS after implementation
bun run check
git add src/campaign/report.ts test/campaign-report.test.ts
git commit -m "feat(campaign): canonical report bytes, sha256 digest, atomic md-then-json publication"
```

---

### Task 5: The seal act (`seal.ts`)

**Files:**
- Create: `src/campaign/seal.ts`
- Test: `test/campaign-seal.test.ts`

**Interfaces:**
- Consumes: `readPublishedCampaign` (`src/campaign/campaign-document.ts`), `openJournalRead`/`electWriter` (`src/campaign/journal.ts`), `sealPredicateHolds` + `resolveCrashWindows` (`src/contracts/campaign/crash-windows.ts`), `reconstructCampaignSnapshot` + `verifyCampaignSnapshot` (`src/campaign/snapshot.ts`), `parseSidecar` + `evaluateContention` (`src/campaign/contention.ts`), `foldDescriptiveReport`/`canonicalReportBytes`/`digestReportBytes`/`renderReportMd`/`publishReport` (tasks 3–4), `readSampleEvidence` (task 2), `universeOf` (`src/campaign/recovery.ts`).
- Produces:

```typescript
export type TerminusResult =
  | { readonly outcome: 'sealed'; readonly digest: string }
  | { readonly outcome: 'refused_gating' }
  | { readonly outcome: 'refused_drift'; readonly trees: readonly string[] }
  | { readonly outcome: 'cancel_in_force' }
  | { readonly outcome: 'storage_failed'; readonly reason: string };

export interface TerminusArgs {
  readonly campaignDir: string;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  /** Run-dir root for the evidence reader; default
   *  `resolveCampaignResultsRoot(undefined)` (`src/campaign/results-root.ts`). */
  readonly resultsRoot?: string;
  readonly runner?: CommandRunner;      // default: production runner
  readonly stream?: { write(s: string): void };
}

export function runTerminusSeal(args: TerminusArgs): TerminusResult;
```

Terminus sequence (spec §The seal act — pinned order; the implementer reads it first):

0. Cancel marker check (`<campaignDir>/cancel-request` exists ⇒ `cancel_in_force`) — re-checked before EVERY subsequent step.
1. Load campaign + journal read handle. Profile `release_gate_v1` ⇒ `refused_gating` (typed stream message "sealing gating campaigns awaits D4b").
2. `sealPredicateHolds(universe, events)` MUST hold — else a typed `SealError` (the caller only invokes the terminus at predicate-holds; a violation is corruption, loud).
3. Snapshot reconstruct + `verifyCampaignSnapshot`. Drift ⇒ journal the incident FIRST (`adjudication { cell: 'control-plane', disposition: 'snapshot_drift_refused', rationale: 'pre-seal verify at terminus: drifted trees: <names>' }` via the sealer) then return `refused_drift` with the tree names — the journaled adjudication is the durable incident record (spec: the re-run after repair is the acknowledgement; the incident never vanishes).
4. **Integrity audit** (D3 D-5 role one): `parseSidecar` + the shared evaluator over landed closed-window mints — recompute mismatch ⇒ a corruption-class integrity finding collected for `report.md` + an `adjudication { disposition: 'integrity_finding', rationale }`; sidecar evidence lost after a mint ⇒ an attribution caveat (same carrier, distinct disposition string `integrity_caveat`). Never a reversal.
5. **Contention backstop** (D3 D-5 role two): `evaluateContention` with `campaignOpenedTsMs` from the journal's `campaign_opened` and `lastTerminalTsMs` = final terminal ts. Verdict `invalid` ⇒ adjudication disposition `contention_invalidated`; verdict `unknown` ⇒ `unknown_coverage`. One event per affected block, rationale `block=<block_id>; <detail>`; DEDUPE: skip any block whose encoded adjudication already exists (crash-resume idempotence). Skips blocks already resolved mid-run (superseded/replaced).
6. Fold → `canonicalReportBytes` → `digestReportBytes`. Fold input: events before the sealed append.
7. Append `sealed { report_digest }` via the ONE sealer-writer (`electWriter({ campaignDir, clock, identity, campaign, restrict: ['adjudication', 'sealed'] })`, elected at step 3's first journal need, released in `finally`).
8. `cleanupOrphanTemps` → `publishReport` (md first, json last).
9. Return `{ outcome: 'sealed', digest }`.

Storage failure: any sealer append throwing SQLITE_FULL/ENOSPC ⇒ `storage_failed` with the reason (D-13 inheritance — resume re-attempts; nothing partial is sealed because `sealed` is one append).

- [ ] **Step 5a: Write the failing seal tests** — create `test/campaign-seal.test.ts` on tmpdir campaigns (fixtures file builders; a REAL journal via `electWriter` + `initJournalDb` per the recovery-fixtures convention; a sidecar file written by hand in the D3 sidecar line shape — read `src/campaign/contention.ts`'s parser for the exact shape; snapshot verify stubbed through the `runner` seam with a scripted `CommandRunner` like D2's `RecordingRunner` pattern, D3P Task 4):

```typescript
describe('runTerminusSeal', () => {
  test('seals an exploratory campaign: adjudications, sealed(report_digest), md+json published', () => { /* full happy path; digest verified against recomputed bytes; file order asserted via mtimes + content */ });
  test('gating campaign refuses typed, journal untouched', () => { /* … */ });
  test('predicate not holding is a loud SealError', () => { /* … */ });
  test('snapshot drift: incident journaled, refused_drift returned, no sealed event', () => { /* … */ });
  test('drift re-run after repair seals and the incident stays in the journal', () => { /* … */ });
  test('open-at-end breach mints contention_invalidated; coverage gap mints unknown_coverage', () => { /* sidecar with a breach crossing campaign end; sidecar with a gap */ });
  test('backstop dedupe: re-running the terminus appends no duplicate adjudications', () => { /* invoke twice (second via the resume wiring in task 6) */ });
  test('integrity audit: recomputed mismatch is a finding, sidecar loss a caveat, never a reversal', () => { /* … */ });
  test('cancel marker before any step: cancel_in_force, nothing journaled', () => { /* … */ });
  test('SQLITE_FULL at the sealed append: storage_failed, no sealed event on disk', () => { /* scripted-failure journal seam */ });
});
```

- [ ] **Step 5b: Run to fail, implement `src/campaign/seal.ts`, run to pass**

Run: `bun test test/campaign-seal.test.ts`

- [ ] **Step 5c: Full gate + commit (task 5)**

```bash
bun run check
git add src/campaign/seal.ts test/campaign-seal.test.ts
git commit -m "feat(campaign): the seal act — verify, audit, backstop, digest, sealed, atomic publication"
```

---

### Task 6: Resume wiring (`recovery.ts`)

**Files:**
- Modify: `src/campaign/recovery.ts` (`resumeCampaign`, ≈ lines 1833–2280)
- Test: `test/campaign-resume.test.ts` (extend)

**Interfaces:**
- Consumes: `runTerminusSeal` (task 5), `openJournalRead` (`src/campaign/journal.ts`).
- Produces: `resumeCampaign` gains the sealed-tail handling and the post-dispatch terminus; `DispatchOutcome` reasons carry the terminus results.

Wiring (three pins):

1. **Sealed tail, before kill/reconcile** (after cancel-marker precedence, before the live-spend lock): read the journal via `openJournalRead`. If a `sealed` event exists:
   - artifacts present (`report.md` + `report.json` in the campaign dir) ⇒ throw `RecoveryError('campaign already sealed — resume refused; `quorum campaign report` regenerates or verifies the readout')`;
   - artifacts missing ⇒ complete publication: re-fold from events-before-sealed, re-render, digest-verify against the journaled `report_digest` (divergence = loud `RecoveryError` naming it), `publishReport`, return `{ status: 'completed', reason: 'sealed campaign: report regenerated' }`.
2. **The R-RCV-5 notice stays** (predicate holds, no `sealed`) — the existing stream line remains; the terminus after dispatch now actually performs the owed act.
3. **After `runCampaignDispatch` returns** (the final `return await runCampaignDispatch(...)`): capture the outcome; if `outcome.status === 'completed'`, run `runTerminusSeal({ campaignDir, clock, identity, stream })` and map:
   - `sealed` ⇒ `{ status: 'completed', reason: 'sealed; report published (digest <12 chars>)' }`
   - `refused_gating` ⇒ throw `RecoveryError('campaign complete to the seal predicate; sealing gating campaigns awaits D4b — the campaign stays at predicate-holds (D3 exit criteria item 1 closes here)')`
   - `refused_drift` ⇒ throw `RecoveryError` naming the drifted trees + the operator path (resolve source, re-run)
   - `cancel_in_force` ⇒ `{ status: 'cancelled', reason: 'cancel won at the terminus; campaign never sealed' }`
   - `storage_failed` ⇒ `{ status: 'storage_paused', reason }`

- [ ] **Step 6a: Write the failing resume tests** — extend `test/campaign-resume.test.ts` with a terminus-capable fixture campaign (all samples terminal, predicate holds, small two-arm exploratory suite + run dirs with real evidence):

```typescript
test('resume at predicate-holds seals: sealed event + artifacts, second resume refuses citing sealed', () => { /* … */ });
test('resume at sealed-without-artifacts regenerates byte-identical publication', () => { /* delete report.json; resume; digest-equal */ });
test('resume at sealed-with-artifacts refuses with the report-verb guidance', () => { /* expect RecoveryError message */ });
test('resume of a completed gating campaign refuses with the D4b-awaiting message and stays at predicate-holds', () => { /* … */ });
test('drift at the terminus refuses naming trees; repair then resume seals', () => { /* scripted runner seam */ });
test('cancel marker landing mid-terminus wins: no sealed event', () => { /* … */ });
```

- [ ] **Step 6b: Run to fail, implement the wiring, run to pass**

Run: `bun test test/campaign-resume.test.ts`

- [ ] **Step 6c: Full gate + commit (task 6)**

```bash
bun run check
git add src/campaign/recovery.ts test/campaign-resume.test.ts
git commit -m "feat(campaign): resume wires the terminus — sealed tail, post-dispatch seal act, refusal rows"
```

---

### Task 7: The `campaign report` verb

**Files:**
- Modify: `src/cli/campaign.ts` (add `campaignReport` after `campaignCancel`)
- Modify: `src/cli/index.ts` (register the verb in the campaign command group)
- Test: `test/cli-campaign.test.ts` (extend) and/or `test/campaign-cli-verbs.test.ts` (extend — match whichever file owns the existing verb tests; read both first)

**Interfaces:**
- Consumes: `openJournalRead`, `sealPredicateHolds`/`resolveCrashWindows` (for the blocking-samples diagnostic), tasks 2–5.
- Produces: `export async function campaignReport(rawCampaignDir: string): Promise<number>` — exit codes: 0 sealed + verified; 1 every refusal.

Behavior (spec §CLI + §Refusal table):

- Missing/non-dir ⇒ the existing `CampaignVerbError` pattern.
- Unsealed ⇒ **print exactly which samples block sealing and why** (derive from `resolveCrashWindows(universe, events)`: non-terminal attempts with their resolution, plus samples lacking terminals), then exit 1 with "seal first via `quorum campaign run`".
- Gating ⇒ typed refusal "sealing/reporting gating campaigns awaits D4b", exit 1.
- Sealed ⇒ re-fold + re-render from events-before-sealed; digest-compare against `sealed.report_digest`: divergence ⇒ "evidence tampering" incident message naming the divergence, exit 1, never overwrite. Artifacts missing ⇒ publish; present ⇒ byte-compare as well. Then print `report.md` to stdout, exit 0.

- [ ] **Step 7a: Write the failing verb tests** — subprocess-style per the existing CLI verb tests (they invoke the CLI entry through the repo's test harness — read `test/cli-campaign.test.ts` first and copy its invocation pattern; dotenv isolation per `1b89130`):

```typescript
test('report on unsealed campaign prints the blocking samples and exits 1', () => { /* … */ });
test('report on sealed campaign regenerates digest-equal and prints the md', () => { /* … */ });
test('report republishes missing artifacts', () => { /* … */ });
test('report on a tampered run dir exits 1 naming the divergence, never overwriting', () => { /* mutate a trajectory model after sealing */ });
test('report on a gating campaign refuses with the D4b message', () => { /* … */ });
```

- [ ] **Step 7b: Register the verb** — in `src/cli/index.ts`, inside the campaign group next to `run`/`cancel`:

```typescript
  .addCommand(
    new Command('report')
      .description('render/verify the sealed campaign report (digest-checked regeneration)')
      .argument('<campaign-dir>', 'campaign directory')
      .action(async (campaignDir: string) => {
        process.exitCode = await campaignReport(campaignDir);
      }),
  );
```

(Match the file's actual import/action conventions exactly — read the neighboring registrations first.)

- [ ] **Step 7c: Run to fail, implement, run to pass, full gate + commit (task 7)**

```bash
bun run check
git add src/cli/campaign.ts src/cli/index.ts test/cli-campaign.test.ts test/campaign-cli-verbs.test.ts
git commit -m "feat(campaign): quorum campaign report — digest-verified regeneration + the blocking-samples diagnostic"
```

---

### Task 8: Crash-window and concurrency matrix

**Files:**
- Test: `test/campaign-seal.test.ts` (extend) and `test/campaign-resume.test.ts` (extend)

Every cut of the terminus sequence resumes to the SAME journal suffix and byte-identical artifacts (spec §The seal act, crash windows):

- [ ] **Step 8a: Write the matrix tests**

```typescript
test('crash after verify, before adjudications: resume re-verifies and seals', () => { /* kill seam: run the terminus through a scripted failure after step 3, then resumeCampaign */ });
test('crash mid-adjudications: resume dedupes by rationale encoding and seals', () => { /* fail the sealer append after the first adjudication lands */ });
test('crash after sealed, before publication: resume publishes digest-equal', () => { /* covered in task 6 — re-assert here from the terminus seam */ });
test('crash mid-publication: orphan temps cleaned, resume republishes byte-exact', () => { /* plant a half-written report.json.tmp.*, resume */ });
test('cancel requested at each terminus step wins: five cuts, zero sealed events', () => { /* loop over the five inter-step windows */ });
test('ENOSPC mid-terminus: storage_failed, no sealed; remediated resume seals', () => { /* scripted journal failure then healthy */ });
test('post-sealed journal rejects dispatch events (state-machine proof)', () => { /* append a run_allocated after sealed via a raw writer; replay throws */ });
```

- [ ] **Step 8b: Run, fix any seam gaps the matrix exposes (implementation changes go to `seal.ts`/`recovery.ts` with the tests), full gate + commit (task 8)**

```bash
bun run check
git add test/campaign-seal.test.ts test/campaign-resume.test.ts src/campaign/seal.ts src/campaign/recovery.ts
git commit -m "test(campaign): the terminus crash-window and concurrency matrix — every cut resumes byte-identical"
```

---

### Task 9: Docs + status obligations + final gate

**Files:**
- Modify: `AGENTS.md` (architecture bullets)
- Modify: `docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md` (status stamp ONLY after exit criteria pass)

- [ ] **Step 1: AGENTS.md** — extend the `src/campaign/` bullet with the D4a modules (`report-evidence.ts`, `report.ts`, `seal.ts`) and the `quorum campaign report` verb, matching the bullet's existing style; extend the `campaigns/` CLI line: `register|run|cancel|report`.

- [ ] **Step 2: Full gate + commit**

```bash
bun run check && bun run quorum check
git add AGENTS.md
git commit -m "docs(campaign): D4a architecture bullets — report engine, seal act, report verb"
```

- [ ] **Step 3: Status stamp — ONLY after the exit criteria below pass** (never before): flip the D4a spec status line to `implemented (main @ <merge commit>)` and commit `docs(campaign): D4a spec status — implemented`.

## Trusted-maintainer validation: live runs (exit criteria — spec §Exit criteria)

**Trusted-maintainer only — never public CI** (AGENTS.md safe-checks doctrine). On the designated appliance, one session, recorded in a dated `docs/experiments/` entry:

- [ ] **Live run 1 — exploratory lifecycle:** register a small exploratory suite → `campaign run` → all-samples-terminal → terminus → `sealed` + published artifacts; then `campaign report` twice, proving digest-verified regeneration byte-identical.
- [ ] **Live run 2 — gating completion (closes D3 exit-criteria item 1 as pinned):** register a small GATING suite → run to predicate-holds → the typed D4b-awaiting refusal; journal shows the predicate state, no `sealed` event.
- [ ] **Live run 3 — terminus crash:** kill `campaign run` mid-terminus (after adjudications, before publication); `campaign run` resumes; same journal suffix; digest-equal artifacts. Run back-to-back with D3's owed crash-resume campaign (D3 item 2) — different windows, separate records.

Record results (pass/debt-retained per item) in the experiment entry, negative results at equal billing.

## Final verification (exit criteria — spec §Exit criteria)

- [ ] `bun run check` and `bun run quorum check` green on the merge commit.
- [ ] Golden-oracle + digest-round-trip suites green in the portable matrix (tasks 4–5).
- [ ] Live runs 1–3 above pass, recorded.
- [ ] D3 debt ledger updated in the experiment entry: item 1 CLOSED by live run 2; items 2–3, the Linux matrix, and the D3 status stamp still owed (spec §Exit criteria).
- [ ] D4a spec status stamped (task 9, step 3).

## Requirement coverage

| Spec section/pin | Task(s) |
|---|---|
| D-8 ReportSchema amendment | 1 |
| Evidence authorities table + fail-closed | 2 |
| Included-set derivation, rates, medians, provenance per-run, accounting, single-arm, missing-profile | 3 |
| Canonical bytes, digest, `report.md`-first atomic publication, D-9 deferral section | 4 |
| Seal act: gating refusal, verify + drift incident, integrity audit, two-disposition backstop + dedupe, render→digest→sealed→publish, cancel precedence, storage failure | 5 |
| Resume semantics: sealed tail, post-dispatch terminus, R-RCV-5 act, refusal rows | 6 |
| `campaign report` verb: digest-verified regeneration, blocking-samples diagnostic, gating refusal | 7 |
| Crash-window + concurrency matrix, post-sealed rejection proof | 8 |
| Docs + status stamp | 9 |
| Live campaigns (trusted-maintainer) | §Trusted-maintainer validation |
