# PR 2258 Campaign Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make checks-bearing attempts publish safely, admit the first repetition across comparisons, list mixed campaign directories without changing execution selection, and deliver explicitly pinned pricing to workers.

**Architecture:** Keep the existing runner, manifest, publisher, controller and V2 reader. Repair their narrow seams and exercise the real behavior through existing injected runtime/clock fixtures. These four tasks may run in separate worktrees; root integrates their changes to shared contract consumers.

**Tech Stack:** TypeScript, Bun >=1.3.13, existing node filesystem APIs and Zod.

**Spec:** `docs/superpowers/specs/2026-09-05-pr2258-parallel-comparison-design.md` at `99206154`.

## Global Constraints

- Checks HOME is fresh, non-credential-bearing scratch outside subject home and staged publication.
- Preserve private-home exclusion, strict publisher inventory, V2 document authentication and exact/ambiguous-prefix execution lookup.
- No V1 reader, migration, backward-compatibility layer, resume, budget controller, automatic replacement, live eval, credential issuance, deployment, push or merge.
- Longest-duration priority remains primary; the comparator remains a deterministic total order including primary, reserve, lineage and malformed IDs.
- This experiment has three base/head comparisons, n=2, reserve=0, max_attempts=1, six target slots, and a 60-second within-pair skew bound.
- Tests exercise structured behavior or real subprocess/filesystem contracts; do not match rendered scripts with regexes. Record RED and GREEN evidence.
- Address the partner as Drew. Make the smallest coherent changes, preserve unrelated work, commit only assigned files, never skip hooks. No worker-created subagents or reviewers.
- Root owns cross-task integration and the final full suite. Each worker runs focused tests plus lint/typecheck; the root runs the full suite once on the integrated branch, avoiding concurrent whole-suite contention.

---

### Task 1: Isolate check HOME and publish a real runner result

**Files:**
- Modify: `src/checks/index.ts`
- Test: `test/checks.test.ts`
- Test: `test/runner-unit.test.ts`, `test/campaign-attempt-publish.test.ts`; a dedicated `test/runner-campaign-publication.test.ts` may hold the cross-boundary fixture.

**Interfaces:**
- Consumes: existing `runPhase(args: RunPhaseArgs): Promise<RunPhaseResult>`, `runScenario`, `writeAttemptManifest`, `publishAttempt` and mock-Gauntlet runner fixtures.
- Produces: unchanged public signatures; checks use owned scratch HOME and a checks-bearing campaign runner output satisfies the existing publication contract.

- [x] **Step 1: Add a failing isolation test.** Execute a real check phase that writes `$HOME/marker` and records HOME in an artifact under the fixture workdir. Give it both `runDir` and a subject `configDir` containing a sentinel credential file. Assert:

```ts
expect(result.exitCode).toBe(0);
expect(existsSync(join(runDir, 'home'))).toBe(false);
expect(checkHome.startsWith(`${runDir}/`)).toBe(false);
expect(checkHome.startsWith(`${subjectHome}/`)).toBe(false);
expect(existsSync(checkHome)).toBe(false); // owned scratch cleaned on return
expect(readFileSync(subjectCredential, 'utf8')).toBe('subject-only');
```

Use the existing phase fixture to obtain `result`, `checkHome`, `runDir`, `subjectHome`, and `subjectCredential`; the shell writes only the observed path, never a secret. Include failure-path cleanup. Existing bootstrap checks continue receiving `QUORUM_AGENT_CONFIG_DIR` explicitly.

- [x] **Step 2: Run the focused phase tests and retain the expected failure.**

```sh
bun run test test/checks.test.ts
```

Record the command and failure. The regression must fail because HOME is inside publication, not because a fixture cannot launch.

- [x] **Step 3: Implement the isolated HOME.** Reuse the already-owned `sinkDir` lifetime:

```ts
const home = join(sinkDir, 'home');
const checkTmp = join(sinkDir, 'tmp');
mkdirSync(home, { recursive: true });
```

Keep existing env allowlist/config-dir projection and cleanup. Do not pass subject HOME into checks, change manifest exclusions, or weaken publication inventory.

- [x] **Step 4: Add the real publication regression.** Reuse the existing `runScenario` mock-Gauntlet fixture in campaign layout (`campaignAttemptDir/home`, `campaignAttemptDir/staging/runId`). Run a scenario with real pre/post phases and a valid campaign identity. Pass its returned staged result through real `publishAttempt` and authenticated evidence reading. Assert:

```ts
expect(existsSync(join(runResult.runDir, 'home'))).toBe(false);
const publishedDir = join(resultsRoot, published.runId);
expect(existsSync(publishedDir)).toBe(true);
expect(JSON.parse(readFileSync(join(publishedDir, 'verdict.json'), 'utf8')))
  .toMatchObject({ scenario: scenarioName });
```

Delete the fixture's original subject home and staging after publication and confirm published verdict/check artifacts remain readable and authenticated. This task proves ordinary publication; observer bundle replay is owned by the evidence plan. Prove an intentionally unlisted file is still refused with the existing publisher regression.

- [x] **Step 5: Run focused checks, self-review and commit.**

```sh
bun run test test/runner-unit.test.ts test/campaign-attempt-publish.test.ts
bun run lint
bun run typecheck
git diff --check
git add src/checks/index.ts test/runner-campaign-publication.test.ts
git commit -m 'Isolate check homes from campaign publication (PRI-3097)'
```

Stage the actual assigned test files, not nonexistent example paths. Report exact commands, outputs and files.

### Task 2: Admit equal-priority repetitions across comparisons

**Files:**
- Modify: `src/campaign/admission.ts`
- Test: `test/campaign-session.test.ts` and existing admission comparator tests
- Modify: the R-DSP-2 admission-order clause in `docs/superpowers/specs/2026-09-04-campaign-consolidation-design.md` only if it states the superseded order.

**Interfaces:**
- Consumes/produces: `compareAdmissionOrder(a: { block_id: string }, b: { block_id: string }): number` unchanged.
- Integration: `runCampaignDispatch` keeps descending `blockPrioritySeconds` before this comparator.

- [x] **Step 1: Add a failing ordering regression and total-order cases.**

```ts
const blocks = ['c1:case:b2', 'c2:case:b1', 'c3:case:b1', 'c1:case:b1']
  .map((block_id) => ({ block_id }));
expect(blocks.sort(compareAdmissionOrder).map((b) => b.block_id))
  .toEqual(['c1:case:b1', 'c2:case:b1', 'c3:case:b1', 'c1:case:b2']);
expect(compareAdmissionOrder({ block_id: 'invalid' }, { block_id: 'c1:case:b99' }))
  .toBeGreaterThan(0);
```

Include b/x kind at equal ordinal, lineage, different cells and IDs parsing to equal numeric values. Malformed IDs stay last even after replicate moves first.

- [x] **Step 2: Run the focused comparator test, then reorder the tuple.**

```ts
// First compare grammar validity, then:
if (pa.rep !== pb.rep) return pa.rep - pb.rep;
if (pa.cmp !== pb.cmp) return pa.cmp - pb.cmp;
if (pa.cell !== pb.cell) return pa.cell < pb.cell ? -1 : 1;
if (pa.kind !== pb.kind) return pa.kind < pb.kind ? -1 : 1;
if (pa.lineage !== pb.lineage) return pa.lineage - pb.lineage;
return a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0;
```

Use a validity discriminator or malformed sentinel tuple that preserves malformed-last ordering. Update the actual contract comment and preserve existing duration priority.

- [x] **Step 3: Add a real controller activation regression.** Extend the injected session fixture with three comparisons, two paired repetitions each, canonical block IDs, global/grader caps six and adequate subject caps. Hold fake attempts open. Assert the first six starts have block IDs:

```ts
expect(firstSix.map((a) => a.block_id).sort()).toEqual([
  'c1:case:b1', 'c1:case:b1',
  'c2:case:b1', 'c2:case:b1',
  'c3:case:b1', 'c3:case:b1',
]);
```

Map the real fixture's runtime identity into `firstSix`. No b2 starts before capacity frees. Preserve the existing longest-duration regression; cover unequal estimates and capacity backfill without imposing a six-arm barrier.

- [x] **Step 4: Verify and commit.**

```sh
bun run test test/campaign-session.test.ts
bun run lint
bun run typecheck
git diff --check
git add src/campaign/admission.ts test/campaign-session.test.ts
git commit -m 'Admit comparison repetitions before later repeats (PRI-3097)'
```

Include actual comparator-test/doc files changed in the explicit stage list.

### Task 3: List unreadable campaigns without changing execution lookup

**Files:**
- Modify: `src/appliance/campaign.ts`
- Test: `test/appliance-campaign-cutover.test.ts`

**Interfaces:**
- Consumes: `campaignCommands(deps: CampaignCommandDeps).list()` and `loadFrozenCampaign(campaignDir)`.
- Produces: existing readable rows plus `{ selector: string, state: 'unreadable', reason: { code: 'unsafe_path' | 'invalid_campaign' | 'unavailable', message: string } }`.
- Unchanged: `resolveCampaignDirectory(loaded, selector): string`, status/run/cancel/costs/report resolution.

- [x] **Step 1: Add failing mixed-directory tests using `helperFixture`.** Register a real V2 fixture, add V1 and malformed JSON neighbors, a bad journal, and a symlink candidate. Preserve before/after document bytes. Assertions:

```ts
const rows = commands.list();
expect(rows.some((row) => 'campaign_id' in row && row.campaign_id === id)).toBe(true);
expect(rows.find((row) => row.selector === 'historical'))
  .toMatchObject({ state: 'unreadable', reason: { code: 'invalid_campaign' } });
expect(readFileSync(historicalPath, 'utf8')).toBe(before);
```

Also create prefix-related basenames: listing must examine each listed basename directly, rather than invoking execution prefix resolution. Execution ambiguity/path escape/symlink tests must retain their refusals.

- [x] **Step 2: Run RED and implement per-entry isolation.** Keep the root no-follow check outside entry catches. For each candidate, validate its basename and no-follow containment, load the frozen V2 document, and observe status using that exact directory. Catch only that entry's failure into the typed unreadable row. Do not derive `campaign_id` from rejected JSON.

```ts
return names.map((selector) => {
  try {
    return readListedCampaign(selector); // exact safe directory, existing V2/status readers
  } catch (error) {
    return unreadableCampaign(selector, error); // typed reason, no artifact writes
  }
});
```

Define these helpers locally if used. Keep successful row shape unchanged; root failures remain command failures. Do not change the supported command list.

- [x] **Step 3: Verify and commit.**

```sh
bun run test test/appliance-campaign-cutover.test.ts
bun run lint
bun run typecheck
git diff --check
git add src/appliance/campaign.ts test/appliance-campaign-cutover.test.ts
git commit -m 'Report unreadable campaign entries independently (PRI-3097)'
```

### Task 4: Carry a selected pricing snapshot into the worker

**Files:**
- Modify: `src/contracts/campaign/suite.ts`, `src/contracts/campaign/execution.ts`, `src/campaign/registration.ts`, `src/campaign/container-spawner.ts`, `src/campaign/controller.ts`, `src/campaign/arm-suite-check.ts`
- Create: `src/campaign/pricing-snapshot.ts`, `test/campaign-pricing-snapshot.test.ts`
- Test: existing suite-contract, registration and container-spawner test files owning the touched seams

**Interfaces:**

```ts
export interface PricingSnapshot {
  path: string;
  sha256: string;
}
export function verifyPricingSnapshot(args: {
  evalsRoot: string;
  snapshot: PricingSnapshot;
}): { file: string; directory: string; sha256: string };
```

Export `PricingSnapshotSchema` and infer the type from it. `SuiteSchema` gains
`pricing_snapshot: PricingSnapshotSchema.optional()`. Existing `Experiment.suite`
and the digest of the entire suite carry its identity; do not add a second field
or legacy-format conversion. `PrepareContainerExecutionArgs` gains
`pricingSnapshot?: PricingSnapshot`; the controller passes the frozen selection.
The strict `AttemptRuntimeSpecSchema.public_env` gains only
`OBOL_PRICING_DIR: AbsoluteRuntimePathSchema.optional()`; arbitrary environment
keys remain rejected. Test runtime schema round-trip and nonabsolute path refusal.

- [x] **Step 1: Add RED tests for selection and source integrity.** Create a
temporary Evals root with a small real obol `current.json` table. Parse an explicit
selection and verify:

```ts
const snapshot = { path: 'pricing/current.json', sha256: sha256Hex(tableBytes) };
expect(verifyPricingSnapshot({ evalsRoot, snapshot })).toEqual({
  file: join(evalsRoot, 'pricing/current.json'),
  directory: join(evalsRoot, 'pricing'),
  sha256: snapshot.sha256,
});
expect(() => verifyPricingSnapshot({
  evalsRoot,
  snapshot: { ...snapshot, sha256: '0'.repeat(64) },
})).toThrow();
```

Also reject absolute/traversing/backslash paths, missing file, symlink file or
ancestor, nonregular source, and a basename other than `current.json`. Changing
the path or digest changes the experiment digest. An absent selection retains
ordinary bundled pricing; PR2258 readiness will explicitly require a selection.

- [x] **Step 2: Implement shared strict validation.** Validate a portable
Evals-relative path ending in `current.json`, use the existing pinned no-follow
file read primitive, compare SHA-256 of raw bytes, and return the verified
absolute file/directory. No network, environment lookup, refresh or fallback.
The table is accounting input and does not add budget/admission semantics.

- [x] **Step 3: Wire registration and worker preparation.** Validate after
frozen Evals materialization/intake and before journal registration. Run the same
validator in `prepareContainerExecution` before private stage creation. The
controller supplies `context.experiment.suite.pricing_snapshot`. Set:

```ts
...(verifiedPricing === undefined ? {} : {
  OBOL_PRICING_DIR: verifiedPricing.directory,
})
```

inside the prepared runtime's public environment. The existing read-only Evals
mount carries the exact file; do not copy the host HOME, add a new mount, or
special-case PR2258. Scenario/arm suite checks use the same verifier against the
checked source tree. Registration failure must not publish a campaign; preparation
failure must precede credential-stage creation.

- [x] **Step 4: Prove actual worker pricing selection.** Extend the prepared
runtime fixture with a selected table and run a fresh Bun subprocess using its
public environment and a clean HOME to price synthetic ATIF and grader sidecar
records through the real Quorum/obol functions. Put a deliberately wrong table in
the host environment; selected bytes must win. Verify known input/output/cache
arithmetic and explicit unknown-model cost, without any provider calls. Obol reads
its pricing environment at process startup; do not mutate it after import.
Deleting or changing selected bytes must fail preparation rather than fall back.

- [x] **Step 5: Verify, self-review and commit.**

```sh
bun run test test/campaign-pricing-snapshot.test.ts
bun run lint
bun run typecheck
git diff --check
git add src/campaign/pricing-snapshot.ts test/campaign-pricing-snapshot.test.ts
git commit -m 'Pin campaign worker pricing to explicit snapshot bytes (PRI-3097)'
```

Include the explicit assigned wiring/test files actually changed. Run their
focused regression suites too. Report exact RED/GREEN evidence; no live prices or
new production rates are invented by this task.

## Integration acceptance

- [x] Task-specific spec/quality reviews pass before integrating each branch.
- [x] Run `bun run check` and `bun run quorum check` once on the integrated branch.
- [x] Preserve explicit skipped Linux/Gauntlet receipts as remaining qualification gates.
- [x] Record this foundation slice in the experiment log without claiming observer support or live readiness.

The evidence, measurement, six-arm configuration and no-spend preflight plans follow this slice. No source task authorizes installed changes or paid execution.
