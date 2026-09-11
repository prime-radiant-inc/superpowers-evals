# Repeatable PR and Release Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare Superpowers dev with v6.3.0 through reusable appliance inputs and deliver trustworthy focused and release reports within four and 24 hours, respectively.

### Dated execution amendment — 2026-09-10

Drew amended the execution counts after implementation merged. The current
data-only validation is F28/R118 with n=1 for every eligible scenario, harness
and arm; qualification24, scenario selection, exclusions, frozen refs, prices,
role allowances and outer time budgets remain unchanged. Plan approximately
$500. The original 84/366 live acceptance and statistical/scale claims are
deferred and are not satisfied by the reduced workflow validation. No software
behavior, Gauntlet change or appliance change is authorized by this amendment.

### Focused launch amendment — 2026-09-11

Drew authorized the existing F28 comparison after a bounded team review,
without successful conversation-code-review qualification. This supersedes
Task 9's qualification-before-F sequencing. The pack's failed outcomes and
scope remain unchanged; no successful qualification record is created or
attached. F28 contains no code-review scenario. Its six fused-QA scenarios and
conversation-design still use uncalibrated assessment, and conversation-design
shares the assessor and checks unsupported claims. Inspect decisive evidence
for assessor-derived findings; do not infer accuracy from a published report.

Record the amendment, prepare and freeze the final source identity, register
exactly 28 samples, then execute F through the existing helper and read its
ordinary report. Preserve existing refs, pairings, n=1, budgets, caps, pricing,
zero reserves and all missing/error outcomes. R118 and its acceptance remain
held; the alternate-candidate registration demonstration remains deferred.
No further prompt/model experiment or runtime change is part of this amendment.

**Architecture:** Extend ordinary campaign registration, role execution and report publication. Preserve the controller, isolated workers, immutable evidence and separate simulated-user/assessor histories. Measurement availability is derived from authenticated artifacts; it is not inherited from the aggregate verdict.

**Tech Stack:** Bun (evals requires ≥1.3.13; Gauntlet requires ≥1.3.14), TypeScript, existing Zod/YAML contracts, Gauntlet's existing Anthropic client, Linux appliance containers. No new dependencies.

**Spec:** [Approved design](../specs/2026-09-10-repeatable-pr-release-validation-design.md), commit `8e69b1f2`.

## Global Constraints

- “Parallelism is the primary throughput mechanism. Subject and grading budgets follow the work.”
- “Do not shorten them, reduce coverage or lower grading standards to manufacture a faster result.”
- “Keep test definitions versioned; supply comparison-specific inputs at submission.”
- “Resolve refs once and freeze their exact commits.”
- “A citation proves access to evidence, not correctness of interpretation.”
- “Grounding stays mandatory wherever the scenario claims credible review quality.”
- “Missing price data alone does not cancel behavioral measurement.”
- “Unknown is not zero.”
- “No new controller, fleet, artifact migration, standalone regrading system, grader ensemble, endpoint experiment or docs-hosted runtime is part of this increment.”
- “The separate doctor work remains separate.”
- Existing QA scenarios remain usable. Do not convert the catalog or introduce historical-format compatibility readers.
- Tests exercise behavior through structured seams, not large generated-command/string matches. Do not disable hooks or publish private transcripts, credentials or evidence indexes.
- This plan does not authorize deployment or paid calls. Complete the reviewable implementation and offline checks before requesting authorization for the concrete live workload.

---

## Frozen acceptance declarations

Drew selected **dev versus v6.3.0 for both workloads**. The focused run tests an actual development change, not the already-merged PR #2258.

| Input | Frozen selection |
|---|---|
| Baseline label / commit | `v6.3.0` / `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Candidate label / commit | `dev` / `3a8bdc11e1db42955350d6d6f063f7a8e89aef58` |
| Coding-Agent Claude | `claude:opus_bedrock`; Opus 4.8 through its existing provisioned route |
| Coding-Agent Codex | `codex:openai_responses_56sol`; gpt-5.6-sol |
| Coding-Agent Pi | `pi:pi_gpt56_sol`; gpt-5.6-sol |
| Gauntlet-Agent, both roles | `sonnet5`, `claude-sonnet-5`, direct Anthropic; freeze resolved adapter/settings |
| Effort | No runtime effort override; freeze the effective harness configuration and disclose provider defaults |
| OS | Linux; existing adapter/credential eligibility applies |
| Replacements | `reserve: 0`, `max_attempts: 1`; invalid samples remain visible |
| Exposure | Existing `max_exposure_skew: 60`; preserve paired admission and validity checks |
| Initial capacity target | Global eight attempts; grader pool eight only after capacity verification in Task 9 |
| Final source identities | Freeze implementation evals/Gauntlet SHAs and image digest at registration, after their checks and integration |

The baseline is the **peeled commit**, not the annotated tag object. These SHAs were checked while writing this plan. Do not refresh dev silently before acceptance. A later dev is another request.

### Workload F: focused development comparison

Question: does dev's brainstorming/writing-plans change improve or regress discovery, resistance to premature implementation, respect for user preferences and plan generation?

Run the first seven scenarios in the table below on Claude and Codex, baseline/candidate, **three repetitions: 7 × 2 × 2 × 3 = 84 primary samples**. Target **four hours** from durable execution acceptance to the usable report. The frozen Superpowers source diff changes brainstorming and writing-plans plus repository community documents; this is the relevant behavioral selection.

### Workload R: representative release comparison

Question: does the same dev candidate regress the supported workflow relative to released v6.3.0, including substantial implementation work?

Run all 22 scenarios below across Claude, Codex and Pi, both revisions. Use **three repetitions**, except **five** for `sdd-go-fractals-opus48`. Claude and Codex each contribute 136 samples; Pi contributes 94. **Total: 366 primary samples**, target **24 hours**.

| Scenario | F | Subject / fused-QA allowance | Pi in R |
|---|---|---:|---|
| `brainstorming-todo-purpose-discovery` | yes | 30m | yes |
| `brainstorming-resists-jump-to-implementation` | yes | 30m | yes |
| `brainstorming-companion-just-in-time` | yes | 10m | yes |
| `user-pref-no-brainstorm` | yes | 10m | excluded by scenario |
| `writing-plans-no-spec-conversational` | yes | 20m | yes |
| `cost-spec-plan-duplication` | yes | 45m | yes |
| `conversation-design` | yes | 10m | excluded by scenario |
| `superpowers-bootstrap` | no | 20m | yes |
| `triggering-test-driven-development` | no | 20m | yes |
| `verification-phantom-completion` | no | 20m | yes |
| `triggering-finishing-a-development-branch` | no | 20m | yes |
| `worktree-no-drift-to-main` | no | 20m | excluded by scenario |
| `sdd-escalates-broken-plan` | no | 60m | yes |
| `sdd-breaker-rules-and-continues` | no | 45m | yes |
| `sdd-go-fractals-opus48` | no | 120m | yes |
| `receiving-code-review-pushback` | no | 10m | yes |
| `tdd-holds-under-tests-later-pressure` | no | 10m | excluded by scenario |
| `conversation-code-review` | no | 10m | yes |
| `conversation-review-feedback` | no | 10m | excluded by scenario |
| `conversation-config-repair` | no | 10m | excluded by scenario |
| `conversation-pricing` | no | 10m | yes |
| `conversation-debugging` | no | 10m | excluded by scenario |

During plan verification, the existing pure `prepareRegistration` compiler expanded the real public registry, agent configs and scenario intake to 84 and 366, with zero reserves and exactly the exclusions listed. Task 2 must preserve those results through the new runtime-input registration path. These seven scenario/pairing exclusions are declared before launch. Any additional exclusion fails the declared coverage gate.

Sizing reference: August's 388-run release corpus took 32.64 hours, with 69.16 summed run-hours and mean overlap 2.12. This declaration has 22 fewer samples, three harness/model pairings and 30 substantial fractals runs. It includes fresh conversation coverage and omits unsupported Pi combinations and other historical models/platforms. It is representative of these three supported Linux pairings, not every model or operating system. Historical throughput is a sizing reference; it does not prove eight-way capacity or the 24-hour target.

### Budget and measurement gates

- Preserve the table's subject/fused-QA allowances. An absent `quorum_max_time` resolves to the frozen agent's existing 10m; show that resolution.
- Conversation assessments: **10m total** for design, code-review and review-feedback; **5m total** for pricing, config-repair, debugging and verification. Each total includes **60s report grace** and **5s publication reserve**. These are explicit engineering allowances, not measured optimal limits. The prior 115s censoring and observed 64–96s requests do not justify a universal two-minute cap.
- Outer attempt limit: **5400s for F**, **10800s for R**. Reserve 15m within that envelope for setup/capture/checks/publication/cleanup and include Gauntlet's existing legacy final-turn allowance when validating QA-mode bounds. Do not increase the subject allowance to consume spare outer time.
- Require all 84/366 samples to have a truthful disposition and every required comparison cell to retain its declared repetitions. Subject failure is valid; absent required judgments/checks/capture is incomplete acceptance.
- Required: authenticated identities, delivered native/visible evidence, executable-check dispositions, all applicable rubric rows, grading-qualification scope, actor-specific known cost and missingness, full turnaround and coverage. Missing exact cost leaves cost conclusions incomplete without discarding behavioral conclusions.
- Descriptive deltas at n=3/5 are useful; “no detected difference” does not establish equivalence. No automatic release decision.

## File and task boundaries

Use the existing spec branch for this plan. At execution, isolate the implementation with `using-git-worktrees`; keep evals and Gauntlet changes reviewable in their respective repositories. Paths below are relative to their named repo. Each task ends with focused verification and a commit naming the intent and this plan. Merge order is Gauntlet capability, then evals caller. No model calls in Tasks 1–8.

| Task | Deliverable | Depends on |
|---|---|---|
| 1 | Frozen workload and full-delivery regression data | none |
| 2 | Runtime comparison input compilation and authenticated registration | 1 |
| 3 | Frozen role budgets and outer-envelope validation | 2 |
| 4 | Assessor deadline communication and bounded report grace | 3's interface |
| 5 | Scoped range reading/search and full-delivery inspection | 1 |
| 6 | Independent measurement cohorts and criterion reporting | 2, 3 |
| 7 | Automatic report publication and turnaround receipts | 6 |
| 8 | Integrated failure checks and operator documentation | 2–7 |
| 9 | Verified capacity, instrument qualification and live comparisons | 1–8 |

### Task 1: Freeze the two workloads and the grader regression set

**Files (evals):**
- Create: `examples/campaigns/validation/focused.yaml`, `examples/campaigns/validation/release.yaml`, `examples/campaigns/validation/README.md`.
- Create: `examples/campaigns/validation/requirements.json`; `test/fixtures/assessment-validation/manifest.json`, `test/fixtures/assessment-validation/README.md` and `constructed/{supported-complete,unsupported-query,unsupported-storage,missing-credential}/{review.md,db.js,index.json,rubric.md}`.
- Create: `test/assessment-validation-fixtures.test.ts`.
- Create: `docs/experiments/2026-09-10-repeatable-pr-release-validation.md` (declarations and pending status only).
- Private, untracked: `~/.local/share/superpowers-evals/assessment-validation-20260910/` for original full bundles, corrected full copies and hashes.

**Interfaces:** `requirements.json` maps scenario names to criterion ordinals, required artifact classes and existing oracle authority, as consumed by Task 6; its hash travels with the template. The YAML uses existing `Suite` fields with symbolic arms `baseline` and `candidate`; Task 2 supplies them. The verification manifest contains `{id, partition, rubric_sha256, evidence_sha256, expected: [{criterion, verdict, required_reason}], location}`. `location` is a public relative fixture path or a private case ID, never an absolute private path or credential. It is data for a test/verification invocation, not an executable suite or a new CLI product.

- [ ] Create both suite files using this complete shape and the exact table above. F contains its seven names. R contains all 22 and the fractals override. Retain the currently committed pricing-snapshot reference; verify its coverage in Task 9 rather than quietly treating its rate date as current.

```yaml
schema_version: 2
name: validation_focused
reserve: 0
max_exposure_skew: 60
attempt_bounds:
  max_attempts: 1
  max_time_s: 5400
grader:
  credential: sonnet5
  model: claude-sonnet-5
pricing_snapshot:
  path: docs/experiments/2026-09-06-pr2258-pricing/current.json
  sha256: 6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b
comparisons:
  - baseline: baseline
    treatment: candidate
    scenarios: [brainstorming-todo-purpose-discovery, brainstorming-resists-jump-to-implementation, brainstorming-companion-just-in-time, user-pref-no-brainstorm, writing-plans-no-spec-conversational, cost-spec-plan-duplication, conversation-design]
    n: 3
```

R's name is `validation_release`, `max_time_s: 10800`; its comparison adds `cells: {sdd-go-fractals-opus48: {n: 5}}` and the remaining table rows. No arm files are created.

- [ ] Freeze **eight full-delivery cases, three independent assessments each: 24 assessments**. Use the full six-row code-review rubric in every case. Expected labels remain outside evidence indexes.

| Case / partition | Expected grounding | Additional expectation and reason |
|---|---|---|
| `query-full` / regression | fail | Original complete retained review; tautology lookup does not remove the subsequent password comparison |
| `storage-full` / regression | fail | Original complete retained review; comparison code does not establish stored rows or a writing path |
| `query-full-corrected` / regression | pass | Full original review with only its unsupported bypass claim corrected to distinguish lookup from authentication |
| `storage-full-corrected` / regression | pass | Full original review with only its storage claim corrected to state comparison behavior and uncertainty about storage |
| `supported-complete` / held-out | pass | Fresh full review finds both required defects, withholds merge and keeps every material claim within the supplied source |
| `unsupported-query` / held-out | fail | Fresh full review adds an unconditional successful-login claim, while its fixture retains the password comparison |
| `unsupported-storage` / held-out | fail | Fresh full review asserts a persistence format absent from its fixture; use different wording and claim position |
| `missing-credential` / held-out | pass | A grounded full review omits the required credential finding: that distinct criterion must fail, not grounding |

Freeze the complete six-criterion expected vectors too: the four unsupported-claim cases are `[pass, pass, pass, pass, pass, fail]`; the three complete supported cases are `[pass, pass, pass, pass, pass, pass]`; `missing-credential` is `[pass, pass, fail, pass, fail, pass]`, because its recommendation also lacks the required credential finding. This is 144 criterion judgments across 24 sessions. Grounding has 12 positive and 12 negative observations; report those denominators separately from the omitted-finding obligations.

The originals are `query-full` and `storage-full` under `~/.local/share/superpowers-evals/grading-triage-20260910/`, whose existing input manifest digest is `2137350da793a6d478c2d5e06f8b5e6c982ff7b3406ac17c0bab421f049301ac`. Verify individual hashes before copying. Preserve complete bundles, not isolated claims. Corrected copies must keep native/visible representations consistent where the delivered review is duplicated; document every changed artifact. Never edit the originals.

- [ ] Construct held-out reviews before assessor changes. Each is 600–1000 words with all required positive findings except the deliberate omission, ordinary neighboring observations and no instructions to the judge. Freeze bytes and their digest before Task 5. Do not use held-out outputs to tune a fix and continue calling them held out.
- [ ] Add a meaningful counterexample test using the fixture's actual login body and an injected database result. The public constructed `db.js` is the byte-identical planted file in `src/setup-helpers/behavior-fixtures.ts`; it imports `./database-driver.js`. The test supplies only that missing dependency:

```ts
import {expect, test} from 'bun:test';
import {copyFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('lookup success does not imply authentication or a storage format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-counterexample-'));
  try {
    copyFileSync('test/fixtures/assessment-validation/constructed/supported-complete/db.js', join(root, 'db.js'));
    writeFileSync(join(root, 'database-driver.js'),
      'export class Database { query() { return {id: 1, password_hash: "stored-digest"}; } }');
    const {login, findUserByEmail} = await import(pathToFileURL(join(root, 'db.js')).href);
    expect(await findUserByEmail("\' OR 1=1 --")).toMatchObject({id: 1});
    expect(await login("\' OR 1=1 --", 'wrong-password')).toBeNull();
    expect(await login('alice', 'correct-password')).toBeNull();
  } finally { rmSync(root, {recursive: true, force: true}); }
});
```

Do not rewrite the login implementation to make the test true. This is a logical counterexample, not a claim about the absent driver's behavior. Keep labels and the injected dependency outside the assessor's indexed evidence. Validate indexes with Gauntlet's existing `validateEvidenceIndex`; assert all manifest hashes match and no expected-label file is listed. These tests establish the intended counterexamples, not model accuracy.
- [ ] Run `bun test test/assessment-validation-fixtures.test.ts`. A broken password-comparison counterexample, changed bytes or leaked label must fail. Record any disputed expected label as disputed and resolve it before freezing; never count it as gold.
- [ ] Commit the public configuration/data, fixture tests and pending experiment entry. Private full bundles stay private. Record the final case-manifest digest in the public entry without transcript content. Tasks 4–5 cannot begin before this freeze.

### Task 2: Compile runtime revisions and pairings through ordinary registration

**Files (evals):**
- Create: `src/campaign/comparison-input.ts`, `test/campaign-comparison-input.test.ts`.
- Modify: `src/appliance/cli.ts`, `src/appliance/campaign.ts`, `src/campaign/registration.ts`, `src/contracts/campaign/experiment.ts`.
- Test: `test/campaign-registration.test.ts`, `test/appliance-campaign-cutover.test.ts`, `test/fixtures/core-comparison/registration.ts`.

**Interfaces:** Add the following types/functions in `comparison-input.ts`. Use existing `Arm`, `Suite`, and `EffortLevel` types. `CampaignRegisterArgs`/`RegisterArgs` gain optional `comparisonInput: ComparisonInput`. The frozen experiment gains optional `comparison_request: ResolvedComparisonInput & {suite_path: string; suite_sha256: string}` inside its authenticated digest. Explicit arm registrations do not acquire synthetic comparison metadata.

```ts
export type PairingInput = {
  agent: string; credential: string; effort?: EffortLevel;
};
export type ComparisonInput = {
  baseline: string; candidate: string; pairs: PairingInput[];
  baselineLabel?: string; candidateLabel?: string;
};
export type ResolvedComparisonInput = {
  baseline: { label: string; sha: string };
  candidate: { label: string; sha: string };
  pairs: PairingInput[];
};
export function parsePairing(value: string): PairingInput;
export function materializeComparison(
  suite: Suite, input: ResolvedComparisonInput,
): { suite: Suite; arms: Record<string, Arm> };
```

- [ ] Write the pure expansion test with a one-scenario suite. Expected arm names use pairing ordinal, not refs or credential text, so names remain valid and stable:

```ts
test('expands each pairing while preserving scenario repetitions', () => {
  const suite: Suite = {
    schema_version: 2, name: 'review', reserve: 0, max_exposure_skew: 60,
    attempt_bounds: { max_attempts: 1, max_time_s: 1800 },
    comparisons: [{baseline: 'baseline', treatment: 'candidate', scenarios: ['review'], n: 3}],
  };
  const input: ResolvedComparisonInput = {
    baseline: {label: 'release', sha: 'a'.repeat(40)},
    candidate: {label: 'dev', sha: 'b'.repeat(40)},
    pairs: [{agent: 'claude', credential: 'cred_a'}, {agent: 'codex', credential: 'cred_b'}],
  };
  const result = materializeComparison(suite, input);
  expect(result.suite.comparisons).toEqual([
    {baseline: 'p1_baseline', treatment: 'p1_candidate', scenarios: ['review'], n: 3},
    {baseline: 'p2_baseline', treatment: 'p2_candidate', scenarios: ['review'], n: 3},
  ]);
  expect(result.arms.p2_candidate).toMatchObject({agent: 'codex', credential: 'cred_b', superpowers: 'b'.repeat(40)});
  expect(suite.comparisons).toHaveLength(1);
});
```

- [ ] Run `bun test test/campaign-comparison-input.test.ts`; expect missing exports before implementation.
- [ ] Implement expansion with existing schema validation. Reject empty/duplicate pairings, incomplete runtime input, extra colon segments, unsupported effort, mixed symbolic/explicit comparisons and symbolic single-arm templates. Existing registration performs credential/harness/OS capability checks. Do not duplicate those rules.

```ts
const arms: Record<string, Arm> = {};
const comparisons: Suite['comparisons'] = [];
input.pairs.forEach((pair, i) => {
  const baseline = `p${i + 1}_baseline`, treatment = `p${i + 1}_candidate`;
  arms[baseline] = ArmSchema.parse({schema_version: 1, name: baseline, ...pair, superpowers: input.baseline.sha});
  arms[treatment] = ArmSchema.parse({schema_version: 1, name: treatment, ...pair, superpowers: input.candidate.sha});
  for (const comparison of suite.comparisons) {
    if (!('baseline' in comparison) || comparison.baseline !== 'baseline' || comparison.treatment !== 'candidate')
      throw new RegistrationError('runtime comparison requires baseline/candidate template roles');
    comparisons.push({...comparison, baseline, treatment});
  }
});
return {suite: SuiteSchema.parse({...suite, comparisons}), arms};
```

- [ ] Add CLI flags `--baseline <ref>`, `--candidate <ref>`, repeatable `--pair <agent:credential[:effort]>`, and optional display-only `--baseline-label`/`--candidate-label`. Labels default to the supplied ref strings; they cannot change resolution. Pass structured input to `registerCampaign`. Resolve both refs **once before** its two `compile(intake)` calls. Reuse the resolved object for object-store intake and snapshot intake. Compile temporary arms in memory; never write them into the immutable evals tree.
- [ ] Authenticate the suite's repository-relative bytes against the frozen evals commit for runtime templates. Reject outside-repo paths, untracked/dirty substitution and snapshot mismatch. Include raw labels, resolved SHAs, pair order, effort and suite digest in `experimentDigest`; changing any changes the identity. Keep explicit-arm registration's existing contract.
- [ ] In `test/campaign-registration.test.ts`, extend the existing temporary-Git-repository fixture to register a template, move its candidate branch between the two intake passes, and assert both use the initially resolved SHA. Assert a changed pair/ref/template byte changes the digest, unknown credentials fail, and unsupported pairings remain explicit exclusions.
- [ ] Compile the actual F/R templates with public registry/config intake using `prepareRegistration` and existing fake host/identity seams. Assert **84/366 planned slots**, the exact seven R Pi exclusions, zero reserve slots, and the expected repetition counts. These tests make no provider calls and create no real appliance registration.
- [ ] Make registration JSON/readable output show labels/SHAs, coverage, exclusions, effective effort, role budgets after Task 3 and the **effective** pool/global caps. Run the new test and `bun test test/campaign-registration.test.ts test/appliance-campaign-cutover.test.ts`; commit.

### Task 3: Resolve and freeze workload budgets

**Files (evals):**
- Modify: `src/story-meta.ts`, `src/scaffold.ts`, `src/campaign/registration.ts`, `src/contracts/campaign/experiment.ts`, `src/runner/index.ts`, `src/runner/conversation.ts`.
- Modify: `scenarios/conversation-design/story.md`, `scenarios/conversation-code-review/story.md`, `scenarios/conversation-review-feedback/story.md`, `scenarios/conversation-pricing/story.md`, `scenarios/conversation-config-repair/story.md`, `scenarios/conversation-debugging/story.md`, `scenarios/conversation-verification/story.md`.
- Test: `test/story-meta.test.ts`, `test/campaign-registration.test.ts`, `test/runner-conversation.test.ts`, `test/fixtures/conversation-role.ts`.

**Interfaces:** Add `assessmentBudgetFromStory(story: string): {totalMs: number; reportGraceMs: number} | null` in `story-meta.ts`. Conversation stories declare `quorum_assessment_max_time` and `quorum_assessment_report_grace`. Add frozen `role_budgets: Record<string, Record<string, {subject_ms: number; assessment_ms: number | null; assessment_report_grace_ms: number | null; overhead_ms: number}>>` keyed first by **cell ID**, then **arm name**, to the experiment. Subject resolution follows existing story → agent fallback. Validate each arm separately; different agent defaults cannot become a misleading shared allowance.

- [ ] Add a parser test using real frontmatter:

```ts
expect(assessmentBudgetFromStory('---\nquorum_mode: conversation\nquorum_assessment_max_time: 10m\nquorum_assessment_report_grace: 60s\n---\n')).toEqual({totalMs: 600000, reportGraceMs: 60000});
expect(() => assessmentBudgetFromStory('---\nquorum_mode: conversation\nquorum_assessment_max_time: 60s\nquorum_assessment_report_grace: 60s\n---\n')).toThrow();
```

Require both fields for conversation mode; reject malformed, nonpositive or unsafe durations and `totalMs <= reportGraceMs + 5000`. QA mode returns null when both are absent. Reject assessment fields in QA mode to prevent a declaration that will be ignored. Use the existing frontmatter/duration machinery, not another parser.
- [ ] Run `bun test test/story-meta.test.ts`; expect the missing parser/validation to fail. Implement parser and the seven story values from the budget declaration. Update the scaffold's conversation defaults to 10m/60s, explicitly labeled as editable author-selected allowances.
- [ ] Freeze budgets from authenticated story and agent bytes in registration. Reject insufficient outer bounds using:

```ts
const assessmentMs = budget?.totalMs ?? 0;
const neededMs = subjectMs + assessmentMs + overheadMs;
if (suite.attempt_bounds.max_time_s * 1000 < neededMs)
  throw new RegistrationError(`attempt bound cannot accommodate ${scenario.name}'s role budgets and overhead`);
```

`overheadMs` is the declared 900000ms allowance for setup/capture/checks/final publication, legacy final-report work and cleanup. The current legacy `finalReportTurn` is outside its main loop budget and has no separate local allowance; it shares this outer headroom. Do not claim that summing declared periods bounds provider latency. The outer process deadline supplies that guarantee; exhaustion remains a recorded failure and slow setup must appear as such.
- [ ] Thread `assessmentBudget` from `runScenario`'s resolved story into `runPreparedConversation`. Replace the literal `--max-time 2m`/`120000` with the same resolved total, and pass `--report-grace <milliseconds>ms` to Gauntlet. `invokeGauntletRole` continues to own the absolute outer role deadline. Do not allow subprocess flags to override it.
- [ ] Extend the existing fake role fixture to record parsed argument fields as JSON. A runner test with a 10m declaration must observe `deadlineMs=600000`, `max-time=600000ms`, `report-grace=60000ms`; a 5m scenario must observe 300000ms. Test through the process seam, not a regex over the rendered command. QA routing and its budget must remain unchanged.
- [ ] Run touched suites, scenario validation, lint and typecheck. Commit the caller and declarations; do not deploy until Task 4 supplies the CLI capability.

### Task 4: Give the assessor a real work period and bounded report opportunity

**Files (Gauntlet):**
- Modify: `src/assessment/lifecycle.ts`, `src/assessment/assess.ts`, `src/cli/args.ts`, `src/cli/assess.ts`, `src/models/assessment-request.ts` only where request deadlines are wired.
- Test: `test/assessment/lifecycle.test.ts`, `test/assessment/assess.test.ts`, `test/assessment/cli-lifecycle.test.ts`, `test/models/assessment-request.test.ts`, `test/cli/args.test.ts`.

**Interfaces:** `AssessArgs` and `AssessOptions` gain `reportGraceMs: number`. `assessmentDeadline` consumes it and returns `{workDeadlineAtMs, reportDeadlineAtMs, hardDeadlineAtMs}`. `createAssessmentDecision`'s acceptance cutoff becomes `reportDeadlineAtMs`. The public CLI accepts optional `--report-grace`, parsed to zero when absent; its parsed `AssessArgs` always carries a number. Existing programmatic `AssessOptions` callers gain explicit `reportGraceMs: 0` (including the shared test fixture), while evals supplies its declared 60000ms. No hidden default in the deadline calculation. This is one additive capability, not a second legacy execution path.

- [ ] Add exact deadline behavior tests:

```ts
expect(assessmentDeadline({nowMs: 1000, maxTimeMs: 600000, reportGraceMs: 60000})).toEqual({
  workDeadlineAtMs: 536000, reportDeadlineAtMs: 596000, hardDeadlineAtMs: 601000,
});
expect(assessmentDeadline({nowMs: 1000, maxTimeMs: 600000, reportGraceMs: 60000, hardDeadlineAtMs: 301000})).toEqual({
  workDeadlineAtMs: 236000, reportDeadlineAtMs: 296000, hardDeadlineAtMs: 301000,
});
```

- [ ] Run `bun test test/assessment/lifecycle.test.ts`; expect absent fields/wrong cutoff. Implement the calculation:

```ts
const hardDeadlineAtMs = Math.min(input.nowMs + input.maxTimeMs, input.hardDeadlineAtMs ?? Infinity);
const reportDeadlineAtMs = hardDeadlineAtMs - 5000;
const workDeadlineAtMs = reportDeadlineAtMs - input.reportGraceMs;
return {hardDeadlineAtMs, reportDeadlineAtMs, workDeadlineAtMs};
```

Validate finite safe durations and grace smaller than the total minus publication reserve. If startup has already consumed the work window, go directly to the bounded report opportunity; if the report window is gone, finalize timed-out without a provider call.
- [ ] In `assess.test.ts`, use the existing `fixture`, `ScriptedClient`, `readVisible` and `report` helpers with its injected clock. Advance the clock past `workDeadlineAtMs` after a delivered read, return a report in the next request, and assert:

```ts
expect(client.toolLists.at(-1)?.map(t => t.name)).toEqual(['report_result']);
expect(JSON.parse(readFileSync(join(f.outDir, 'assessment-completion.json'), 'utf8')).status).toBe('completed');
```

Also test report-window expiry → timed_out; external cancel → cancelled with no grace request; unread references still reject; a late work response cannot replace the final decision. Existing fixture writes a real event stream/completion artifact. Do not satisfy these tests solely through a mocked deadline helper.
- [ ] Replace the single “work timer decides terminal timeout” behavior with an explicit local phase `work | report | done`. Work expiry aborts the current work request and transitions once to report. Create a **fresh request AbortController** for grace; an already-aborted controller cannot be reused. The external cancellation signal spans both phases. A generation token/phase guard rejects responses belonging to an expired phase, even if the client ignores abort. Terminal decision/publication remain exactly once.
- [ ] Before each ordinary model request append remaining work seconds and report-grace seconds. At grace send: `The inspection period has ended. Use only evidence already delivered. Submit report_result now; mark unsupported or uninspected obligations unclear. No further evidence tools are available.` Mount only `ASSESSMENT_REPORT_TOOL`. Make at most one logical final-report request; existing bounded transport retry accounting remains within the same deadline. A malformed grace report finalizes unresolved rather than starting another loop.
- [ ] Fix the **physical request ceiling** too. `src/cli/assess.ts` currently initializes `createAssessmentAttemptJournal` with the work cutoff. Its permissible request window must end at `reportDeadlineAtMs`; individual work requests still abort at the earlier work cutoff. Test the actual SDK/journal seam with a grace response and a late response so retries cannot escape the total or become free/unaccounted calls.
- [ ] Run `bun test test/assessment/ test/models/assessment-request.test.ts test/cli/args.test.ts` and typecheck. Existing repaired/native completion reasons and accounting remain observable. Commit.

### Task 5: Bound evidence inspection and verify full-delivery claim coverage

**Files (Gauntlet):**
- Modify: `src/context/scoped-read.ts`, `src/assessment/assess.ts`.
- Test: `test/context/scoped-read.test.ts`, `test/assessment/assess.test.ts`.

**Interfaces:** Keep `readEvidenceFile` for internal callers. Add these scoped functions; results are JSON-serializable tool values. Search is literal text, case-sensitive, over listed UTF-8 regular files. No regex engine, shell or filesystem glob supplied by the model.

```ts
export type EvidenceRange = {
  path: string; startLine: number; endLine: number; totalLines: number;
  text: string; truncated: boolean; nextLine: number | null; nextColumn?: number;
};
export function readEvidenceRange(root: string, index: EvidenceIndex,
  request: {path: string; startLine?: number; maxLines?: number; startColumn?: number}): EvidenceRange;
export function searchEvidence(root: string, index: EvidenceIndex,
  request: {query: string; path?: string; maxMatches?: number}): {
    matches: {path: string; line: number; text: string}[];
    truncated: boolean; unavailable: {path: string; reason: string}[];
  };
```

- [ ] Add real temporary-file tests in the scoped-reader suite. With `visible/review.md` containing four lines `one\ntwo\nthree\nfour`, assert:

```ts
expect(readEvidenceRange(root, {files: ['visible/review.md']}, {
  path: 'visible/review.md', startLine: 2, maxLines: 2,
})).toEqual({path: 'visible/review.md', startLine: 2, endLine: 3, totalLines: 4,
  text: 'two\nthree', truncated: true, nextLine: 4});
expect(searchEvidence(root, {files: ['visible/review.md']}, {query: 'three'}).matches)
  .toEqual([{path: 'visible/review.md', line: 3, text: 'three'}]);
```

Use existing temp-root cleanup. Test traversal, absolute paths, symlink escapes, unindexed private files, invalid UTF-8, missing files, empty query, bad line/count values and bounded output on large files.
- [ ] Run `bun test test/context/scoped-read.test.ts`; expect missing functions. Implement through the same index validation and realpath confinement as `readEvidenceFile`. Range defaults/caps: 200 lines, maximum 1000 lines and 64KiB returned text. Search defaults/caps: 20/100 matches, 512 characters per matching-line excerpt, at most 64KiB output. A single long line must support continued inspection rather than permanently hiding its suffix: use the optional `startColumn` and `nextColumn` fields for that case, with tested 1-based UTF-16 character positions. Cut only at complete Unicode code points within the byte limit; `nextLine` stays on a partially returned line until its suffix is consumed. Omitted fields retain whole-line semantics.
The range implementation starts from the existing authority check and keeps location accounting independent of display text:

```ts
const source = readEvidenceFile(root, index, request.path);
const lines = source.split('\n');
const startLine = request.startLine ?? 1;
const maxLines = request.maxLines ?? 200;
if (!Number.isSafeInteger(startLine) || startLine < 1 ||
    !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 1000)
  throw new Error('invalid evidence range');
const endLine = Math.min(lines.length, startLine + maxLines - 1);
const selected = lines.slice(startLine - 1, endLine).join('\n');
```

Finish this function's bounded-output branch by iterating Unicode code points of `selected`, stopping before 65536 UTF-8 bytes. Advance line/column positions over the characters actually emitted, return the next unconsumed position, and set `truncated` when any requested/following text remains. Reject a start beyond EOF except line 1 of an empty file. For search, iterate `request.path ? [request.path] : index.files`, call the same confined reader, and use `line.includes(request.query)`; enforce match/excerpt/byte caps before appending results. Catch per-file read failures into `unavailable`, not empty successful matches. Decode UTF-8 with `TextDecoder(..., {fatal: true})` at the file-read seam so corrupt bytes cannot silently become replacement characters.

- [ ] Mount `search_evidence` and extend `read_evidence` with range parameters. Show exact source positions and truncation in every tool result. Search does **not** add a path to the report's read-before-cite set. A successful range read does, once its result reaches a later request; its limited coverage remains visible. Failed reads/searches provide no citation authority. During Task 4 grace, neither tool is mounted.
- [ ] Add loop tests where search locates a claim, a range read exposes it, and a subsequent report cites that path. Reporting from search alone or alongside the first read must reject. Read all chunks of a long single-line JSON artifact in the reader test and reconstruct the original bytes; this prevents bounded reading from becoming another information-loss bug.
- [ ] Add one general instruction to the existing assessor prompt for full-delivery coverage; preserve every rubric and report schema:

```text
When an obligation applies to the entire delivery, inspect the entire relevant
delivery, continuing through truncated ranges. Check each material claim and
each required finding against its actual conditions. A correct finding or a
caveat about one claim cannot justify another claim. In the criterion's basis,
identify the decisive support or counterexample; if complete coverage was not
possible, state that limitation and do not claim whole-delivery grounding.
```

This is a scoped response to the reproduced coverage/integration failure, not a claim that a prompt sentence fixes it. Do not add a second judge, per-claim tool schema, new workflow or fixture-specific answer hints. Task 9 measures whether the unchanged rubric is now judged correctly on full deliveries.
- [ ] Run both touched suites and typecheck; commit. Keep the Task 1 held-out outputs unseen until the final instrument is frozen.

### Task 6: Report each measurement from its own authenticated evidence

**Files (evals):**
- Modify: `src/contracts/campaign/report.ts`, `src/campaign/report-evidence.ts`, `src/campaign/report.ts`, `src/campaign/report-publication.ts`.
- Modify: `src/contracts/campaign/suite.ts`, `src/contracts/campaign/experiment.ts`, `src/campaign/registration.ts` for frozen criterion/check requirements and qualification reference; the two validation templates for their data references.
- Test: `test/campaign-comparison-evidence.test.ts`, `test/campaign-comparison-report.test.ts`, `test/appliance-campaign-render.test.ts`, `test/fixtures/core-comparison/report-fixture.ts`, `test/fixtures/core-comparison/expected-report.json`.

**Interfaces:** Extend `AttemptEvidence` with authenticated `conversation: ConversationRecord | null` and `roles: GauntletRoles | null`, using existing schemas. Add per-arm `measurements` with interaction counts, check counts and criterion counts. A counted obligation has `{id, planned, pass, fail, unclear, unavailable, evidence: ArtifactRef[]}`; criterion IDs are frozen rubric ordinals plus rubric hash, check IDs are frozen manifest ordinals. Per-comparison paired criterion deltas carry their own `n`. Existing aggregate outcome and all-attempt accounting remain.

Add `measurement_requirements` to the frozen experiment by reading each selected scenario's rubric and check manifest from the same authenticated intake. For the acceptance scenarios, declare each criterion's evidence dependencies explicitly in the versioned validation data: full-review grounding requires complete visible delivery plus supplied source; invocation/process claims require the relevant native/normalized trace; output checks depend on their authenticated check artifact, not the trajectory. A known normalizer defect invalidates only dependent trace claims. Do not attempt to infer these dependencies from free-form evidence prose. Add optional `measurement_requirements` and `assessment_qualification` path/SHA-256 references to `SuiteSchema`, using the existing path/digest shape. The former points to Task 1’s requirements JSON; the latter is added to the templates only after Task 9 produces its record. Verify these source bytes during both registration intake passes, resolve requirements into the frozen experiment and retain the original references. The requirements list stable obligation IDs/text, mode and required evidence classes. It does not prescribe the verdict. Extend intake byte verification to include these consumed files. Attach an optional hash-verified `assessment_qualification` reference to a versioned JSON record produced by Task 9. Bind it to exact Gauntlet code, model/adapter configuration, affected rubric and evidence-semantics hashes; absent/mismatched coverage is explicitly unverified, never silently qualified.

- [ ] Add a regression using `singleArmComparisonFixture()`, whose three subject costs are 2, 8 and 100 and outcomes pass/fail/indeterminate:

```ts
const f = singleArmComparisonFixture();
const result = foldComparisonReport(f);
const arm = result.comparisons[0]!.arms[0]!;
expect(arm.pass_rate.n).toBe(2);
expect(arm.available.subject_cost_usd).toBe(3);
expect(arm.means.subject_cost_usd).toBeCloseTo(110 / 3);
```

Run `bun test test/campaign-comparison-report.test.ts`; expect the current successful-grading denominator to fail. Implement independent quantity cohorts: authenticated selected observations with that quantity present and its dependencies valid. Complete price means require complete actor cost; partial known subtotals stay in all-attempt accounting. Pair cost/duration/token observations only when **both quantities** are available and pair validity holds, regardless of aggregate grading determinacy. Pass-rate pairs still require two determinate outcomes. Change the schema refinement `n <= pass_rate.n` to the relevant planned/eligible denominator, not an unconstrained count. Do not reuse the current `analysis_usable` flag where it includes aggregate grading determinacy; derive source/pair validity separately before testing availability of the individual quantity.
- [ ] Through `test/campaign-comparison-evidence.test.ts`'s real manifest publisher, create a completed conversation, successful post-check and timed-out assessment. Assert interaction/check/cost observations survive and every missing criterion remains unavailable. Corrupt only trajectory bytes and assert trajectory-dependent claims become unavailable while the independently authenticated check remains. Corrupt the manifest identity and assert all candidate attribution fails. Missing usage must preserve its known subtotal and `complete: false`.
- [ ] Read `conversation.json` and `gauntlet-roles.json` from the reader's authenticated `bodies` map, never directly from a sibling path. Map accepted `gauntlet.criteria` by frozen rubric order/text; do not infer missing rows from a summary. For conversation assessments also require the authenticated completed assessment marker and matching accepted-report digest. Legacy QA rows can be retained when present, with their existing evidence text; absent detail remains unavailable.
- [ ] Preserve rich reasoning by linking the authenticated accepted report/event stream rather than inventing observation/basis fields that Quorum's current flattened `GauntletLayer` does not contain. Each claim links to the source that actually supports it. Do not parse a timed-out model's partial text into accepted criteria.
- [ ] Implement obligation counts independently of the final verdict. Use the manifest's expected-check multiset to distinguish absent/crashed checkers from behavioral false records; a missing/crashed check must not become a candidate fail. Preserve a recorded genuine failing check even if assessment failed. Source/identity and pairing invalidity still exclude attributed comparison claims.
- [ ] Render baseline/candidate labels, source SHAs, each cell's planned/available counts, criterion/check differences, missingness and links in `renderReportMd`. Include legacy “detail unavailable” and qualification scope. A full-review grounding pass with known unresolved qualification is labeled unverified and cannot support a quality conclusion. Keep active-campaign behavior hidden, including every new field.
- [ ] Bump the comparison fold version from 1 to 2 because denominators change. Update expected fixture quantities deliberately. Do not rewrite historical reports or add a historical conversion path. Run the three touched suites and typecheck; commit.

### Task 7: Publish automatically and measure the actual request-to-report interval

**Files (evals):**
- Create: `src/campaign/report-delivery.ts`, `test/campaign-report-delivery.test.ts`.
- Modify: `src/appliance/campaign.ts`, `src/appliance/campaign-run.ts`, `src/campaign/report-publication.ts`, `src/campaign/seal.ts` only to reuse publication, `src/appliance/campaign-render.ts`, `src/appliance/cli.ts`, `src/contracts/campaign/execution.ts`, `src/campaign/execution-state.ts`.
- Test: `test/appliance-campaign-run.test.ts`, `test/appliance-campaign-cutover.test.ts`.

**Interfaces:** Export `deliverComparisonReport(input: Parameters<typeof readComparisonReport>[0] & {processes: Parameters<typeof readComparisonReport>[1]; now: () => number}): {report: Report; delivery: ReportDelivery}` using existing report read/seal/snapshot functions. `now` is injected. `ReportDelivery` is an immutable, digest-bound receipt containing `{report_digest, registered_at, request_accepted_at, execution_started_at, artifacts_published_at, measurement_readiness}`. Readiness lists complete/incomplete **measurement obligations**, not an automatic release verdict. Null timestamps mean unavailable, never zero duration.

- [ ] Write a file-backed publication test using an existing completed core-comparison fixture and fake clock. Set durable request acceptance to 1000, execution start to 3000 and completed durable report publication to 11000. Assert request-to-publication is 10000ms, admission delay is 2000ms, and reading/publishing again at 21000 preserves the first receipt and digest. A report-write failure must leave no successful delivery receipt.
- [ ] Run `bun test test/campaign-report-delivery.test.ts`; expect missing service. Implement by extracting the current `campaign.ts` report handler's choice between `sealReport` and `publishReportSnapshot` into the shared service. Preserve canonical byte checking and termination requirements. Do not duplicate the report fold.

```ts
const report = readComparisonReport(input, input.processes);
const terminal = report.report.status === 'completed' &&
  report.report.complete && report.report.termination_verified;
const {digest} = terminal
  ? sealReport({campaignDir: input.campaignDir, report})
  : publishReportSnapshot({campaignDir: input.campaignDir, report});
const artifactsPublishedAt = new Date(input.now()).toISOString();
```

Extend the publisher's return to include its existing actual output directory, so snapshot receipts cannot accidentally be written at the campaign root. Build the receipt from `digest`, committed start/registration timestamps and Task 6's obligation availability; write it through `publishReportFile`. On repeat calls read the first receipt, verify its report digest and return its timestamps unchanged. A conflicting digest is an immutable-publication error.
- [ ] Reuse the existing durable `started` transition: it is committed before child launch, and its `at`/`claimed_at` supplies `request_accepted_at`. Add optional `requested_at` to `ExecutionStartSchema`, captured at entry to `startCampaignOnce`, so request-to-admission delay is visible; enforce `registered_at <= requested_at <= claimed_at` when present. Absence on retained evidence stays unavailable. A refused request has no accepted-start clock. Derive `execution_started_at` from the first recorded attempt preparation, leaving it null when no attempt started. The changed turnaround endpoint is durable report delivery, not the existing `ended` timestamp; do not add another launch authority or queue.
- [ ] After report JSON/Markdown (and seal when applicable) have been durably published, write the immutable `report-delivery.json` receipt with their digest and observed completion time. This separate receipt avoids a self-referential digest or inventing a publication timestamp before writes succeed. For snapshots, put its receipt beside that snapshot. Extend `publishReportFile`'s exact name union rather than creating a generic file writer.
- [ ] Call the shared service from the existing controller-hosted `runGatedCampaignController` completion path after controller settlement and writer release, while retaining sufficient ownership to prevent a conflicting start. Call it on terminal cancellation/error too when readable termination evidence permits a snapshot; never seal unsettled work. If publication fails, preserve terminal execution and surface `report_pending`; ordinary `campaign report` can complete publication without re-execution. No new background service or adoption authority.
- [ ] Expose the receipt from `campaign report/status --json` and ordinary readable output. Report `artifacts_published_at` as the usable endpoint only for obligations whose required evidence and qualification are complete. Incomplete grading does not make a timely artifact publication a successful release-validation receipt. Bot's interpretation and any later correction are recorded in the experiment entry with their actual timestamps; a material unresolved interpretive defect leaves acceptance incomplete.
- [ ] Test automatic publication without a caller subsequently invoking `report`, duplicate invocation, crash between publication/receipt, cancellation snapshot, and missing required criteria. Run delivery and appliance suites; commit.

### Task 8: Verify the integrated failure behavior and document one operator path

**Files (evals):**
- Modify: `src/campaign/controller.ts` for missing wait observations; `test/runner-conversation-gauntlet-integration.test.ts`, `test/campaign-controller-gate.test.ts`, `test/campaign-resource-policy.test.ts`, `test/campaign-comparison-report.test.ts`, `docs/campaign-comparisons.md`, `docs/appliance-runbook.md`, `examples/campaigns/validation/README.md`.
- Modify Gauntlet's focused tests only if a cross-repo contract failure requires it.

**Interfaces:** No new runtime interface. Exercise the production role → manifest → evidence reader → report fold → delivery service with existing scripted SDK and fake container/process seams. Extend an existing fixture helper where necessary; do not build another test launcher.

- [ ] Add the following independent fault cases. Each uses a complete interaction and the same source/identity binding; assertions are on structured reports and real retained files.

| Injected condition | Required report behavior |
|---|---|
| Assessment work expires, final report succeeds | One accepted report, grace observable, no erased conversation/check facts |
| Assessment total expires | No accepted criteria; interaction/checks remain; required quality measurement incomplete |
| Checker executable missing/crashes | Checker obligation unavailable/instrument failure; independently valid assessment retained |
| Completed subject produces a real failing check | Check fail counted as subject behavior |
| One physical assessment request has unknown usage | Known grader subtotal retained, incomplete cost coverage, no global cancellation |
| Subject trajectory unavailable but output oracle valid | Trace-dependent claims unavailable; oracle outcome remains |
| Source identity mismatch | No candidate-attributed results from that attempt |

- [ ] Use the existing fixture's real `readAttemptEvidence` return as `evidenceByAttempt` input, then assert `pass + fail + unclear + unavailable === planned` for each obligation; actor cost coverage must have its own denominator. Test active prefixes still hide behavior. Run the listed integration/report/admission suites; their failures must reflect contract violations rather than string layout.
- [ ] Document these commands as the ordinary interface. They are documentation now; **do not execute the paid commands during implementation**. Use the full pinned SHAs in acceptance so branch movement cannot change it; labels in metadata remain the declared `v6.3.0` and `dev` through Task 2’s display-label flags.

```sh
/srv/quorum/bin/evals-appliance campaign register /srv/quorum/superpowers-evals/examples/campaigns/validation/focused.yaml --baseline b36e0829c6d0140e93cfef2ca599b1b07d4a7797 --candidate 3a8bdc11e1db42955350d6d6f063f7a8e89aef58 --baseline-label v6.3.0 --candidate-label dev --pair claude:opus_bedrock --pair codex:openai_responses_56sol --global-cap 8 --json
```

R changes the suite path to `release.yaml` and adds `--pair pi:pi_gpt56_sol`. The registration receipt supplies the campaign identity for existing `campaign run`, `status`, `cancel`, `costs` and `report`. Do not use shell substitution to launch a paid run from an unreviewed registration response.
- [ ] Document finite failure handling: retain every completed subject; do not cancel merely for missing price/one assessment timeout; preserve real authentication/billing/ownership/host stop policies. No replacement is automatically admitted under these declarations. A necessary fresh comparison has a new identity and keeps the failed acceptance receipt visible.
- [ ] Exercise the real admission seam offline with two pairs occupying four slots and a third unrelated eligible pair. It must start before the deliberately long first pair stops when subject/grader/global capacity allows it. The same test with the grader cap two must wait. Never release the grader reservation merely because the subject is running: the simulated user consumes that credential then too.
- [ ] Use existing controller/journal timestamps for attempt overlap and role files for role durations. Where limiting-pool waits lack attribution, add a bounded observation to the existing campaign telemetry stream when the wait reason changes: `{at, block_id, reason: 'pool_capacity' | 'launch_spacing' | 'host', pool_id, reserved, capacity}`. No event per polling tick, no authoritative scheduling transition. Unknown active-provider concurrency stays unknown; do not relabel attempt reservations as active requests. Cover admission reason changes in `test/campaign-controller-gate.test.ts` before deployment.
- [ ] Run evals `bun run check` and `bun run quorum check`; run Gauntlet `bun run check`. Record exact tested heads and summaries. Review the resulting diff against the spec, then create the two concrete PRs. Integrate Gauntlet first and evals second after their required checks. Do not report live acceptance from these gates.

### Task 9: Verify capacity and instrument, then execute the two real comparisons

**Files:** Update the single evals experiment entry from Task 1. Add the small versioned qualification JSON beside that record and only justified public quota/pricing configuration changes. No new runtime script under `docs/` and no infrastructure project.

**Interfaces:** Existing installed appliance `doctor`, `prepare`, `campaign register/run/status/costs/report`; existing `gauntlet assess` for the 24 regression assessments. Use the `quorum-appliance-remote-run` and access skill when operating the appliance. Tailscale SSH is the routine transport.

- [ ] Verify current host resources and actual direct-Anthropic/provider quota using authenticated read-only control-plane evidence. Historical comments are not current quota proof. Confirm shared OpenAI aliases are one pool. Check peak memory/disk/process demand from retained heavy runs and leave the existing host guards active. Choose eight-way operation only when these constraints support it; otherwise report the limiting fact and do not silently shrink the workload or lower budgets.
- [ ] If supported, change `sonnet5.max_concurrency` from 2 to 8 with the dated capacity rationale. Keep the global cap eight; subject caps remain the verified registry values (Claude six and the shared OpenAI pool 15 unless current evidence contradicts them). Freeze cap changes before registration and run `test/campaign-resource-policy.test.ts` plus controller admission tests. Quota in tokens/minute must be checked against observed request/token demand; it is not automatically an eight-request guarantee.
- [ ] Verify pricing-snapshot coverage and effective rate date for all selected actor models. Correct a stale rate snapshot explicitly if required and freeze its new digest; known usage plus outdated rate tables is not verified dollar cost. Recompute the **estimate** from retained relevant scenario durations/token distributions, including the heavy tail and all roles. Preserve estimate uncertainty; include the resulting estimate in the authorization step below.
- [ ] After the read-only capacity checks and any reviewed quota/pricing-data corrections, present the tested heads, exact 84/366 declarations, 24 assessor sessions, capacity evidence and spend estimate. Obtain deployment/live authorization for this concrete sequence, with comparison execution conditional on the frozen grading gate. Earlier six-case/smoke authorization does not cover it. Do not ask again for already-authorized steps unless the scope or expected spending materially changes.
- [ ] Prepare the approved exact evals/Gauntlet refs on the appliance. Run the **24 full-delivery assessments**, no Coding-Agent sessions, through ordinary `gauntlet assess` using the existing trusted private invocation/spend lease. Use the frozen 10m/60s budget and one execution per replicate; no hidden best-of selection. The private invocation must call the installed production binary with exact frozen rubric/index paths and normal publication/accounting. Do not resurrect the deleted operator runners.
- [ ] Record false passes, false failures, unavailable judgments and reason support separately. All 24 must match their frozen six-row verdict vectors and required reasons; the omission control must fail both the omitted-finding and recommendation-support criteria while passing grounding. Bot inspects every targeted basis against its constructed counterexample and links private evidence; Drew receives counts and decisive excerpts only when suitable for publication. This is bounded coverage of these obligations, not universal accuracy.
- [ ] If a regression fails, preserve its output and fix only the supported cause within Tasks 4–5. Recheck affected regressions. If a held-out case informed a fix, mark it consumed; it no longer proves held-out performance. Stop and report that qualification is incomplete rather than silently selecting easier cases or repeatedly buying passes. No semantic fix is assumed to follow automatically from more time, search or the prompt instruction.
- [ ] On successful verification, freeze a qualification record with exact model, adapter, Gauntlet SHA, rubric/evidence-semantics/case-manifest hashes, all replicate outcomes, reason-support disposition, cost coverage and private receipt digest. Commit that data-only record and refresh the evals snapshot before comparison registration; qualification is tied to the unchanged code/config/rubric hashes, not to a circular hash of its own containing commit. Mark its scope as conversation code-review obligations exercised by this pack. Other scenarios' claims retain their own executable-check or existing assessment provenance; do not label their unmeasured judge accuracy as calibrated. Register both workloads against this final instrument/qualification identity.
- [ ] Confirm registration reports **84 and 366**, zero reserves, pinned commits, budgets, effective caps and exactly the declared exclusions. Demonstrate another **registration only** with a different candidate SHA through the same templates; its identity must differ without editing arm files. Do not launch this third registration.
- [ ] Execute F through `campaign run` and let the appliance own completion/publication. Read the ordinary report. Record elapsed request-to-usable-report, per-cell counts, criterion/check differences, all-attempt known spend, paired quantities and missingness. F succeeds if it supplies its required credible findings within four hours; candidate regression is a valid successful result.
- [ ] Execute R through the same path once F's integrated-path defects are resolved. Its clock is independent; target 24 hours. Preserve its substantial tasks and all repetitions. If source/instrument changes after F, report that change and reverify the affected F acceptance; do not imply both demonstrations used one frozen instrument.
- [ ] Complete the one experiment record with positive and negative findings, exact IDs/digests, ordinary report links, capacity/wait/overlap evidence, both turnaround gates and measurement-specific limitations. A late or materially incomplete report is **acceptance unmet**, even if execution sealed. Record later corrections visibly. Commit the record/qualification metadata through the ordinary PR process.

## Completion and scope check

Implementation is finished when Tasks 1–8 pass on the reviewed heads. The approved objective is finished only when Task 9 supplies both real demonstrations with their required evidence and turnaround. Do not substitute another smoke, a simulation or a table of green parser tests.

If whole-attempt reservations demonstrably prevent the target despite available host/provider resources, report the measured bottleneck to Drew. Finer-grained admission is a conditional design decision in the spec, not permission to build another scheduler during this plan. Likewise, a failure to qualify whole-review grounding remains a real unresolved measurement; it cannot be fixed by changing the benchmark's meaning.

Plan self-review: operator reuse/freezing → Task 2; explicit budgets/grace → Tasks 3–4; inspection/semantic verification → Tasks 1, 5, 9; independent validity/cohorts → Task 6; unattended delivery/clock → Task 7; integrated faults → Task 8; capacity and actual focused/release proof → Task 9. Private evidence remains outside Git and runtime code remains outside docs.
