# Conversation grading contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make conversation assessment statuses deterministic and evaluate one existing grading treatment on five settled retained cases.

**Architecture:** Gauntlet validates anonymous ordered criterion rows, attaches canonical rubric text and derives the overall status. Quorum checks the received status at its existing assessment boundary. A dated single-assessment entrypoint reuses current appliance ownership and child execution for one fixed diagnostic set.

**Tech Stack:** TypeScript, Bun >=1.3.14 (covers both repositories), existing tmux/local-provider integration tests, existing appliance credentials and Obol pricing; no new dependencies.

**Spec:** [Conversation assessment grading contract](../specs/2026-09-08-conversation-grading-contract-design.md), incorporating the [staff whiteboard recommendations](../../experiments/2026-09-08-conversation-grading-whiteboard.md).

## Global Constraints

- Only `gauntlet assess` changes its `report_result` tool. Generic Gauntlet QA keeps its current tool and validator behavior.
- The standard result still contains `status`, `summary`, `reasoning`, `observations` and `criteria`.
- An empty rubric is an input error before the first model request, never an automatic pass.
- No result-schema migration or new compatibility path is needed. Historical results retain their original bytes and judgments.
- Preserve current deterministic-check, error and final-verdict precedence.
- Five assessments maximum; $4 observed stopping threshold; 45 minutes from the first launch; serial; 120-second outer child deadline and existing two-second termination cleanup. These are stopping limits, not hard provider billing caps.
- A valid semantic mismatch permanently fails prompt promotion; complete the remaining predeclared cases solely for diagnosis. Operational failure or newly substantiated independent gold disagreement stops further launches. Candidate disagreement alone does not reopen gold.
- No new Coding-Agent conversations, replacement calls, second candidate, rubric edits, gold changes or transferred allocations.
- Keep the mechanical contract and semantic instructions independently reviewable and selectable. No whole held-branch merge.
- No production replay CLI, new scheduler, waiting service, persistent criterion IDs, structured citation subsystem, grader ensemble or generic reporting rewrite.
- Preserve unrelated worktrees and original evidence. Continue the existing PRI-3102 umbrella at execution time; do not create a parallel project.
- Tasks 1–4 are offline preparation. Task 5 makes provider calls only when Drew has authorized execution including this fixed allocation. A request to write the plan alone is not an execution request. Once authorized, the coordinator can launch the declared rows without asking Drew between rows.
- Use Tailscale for appliance operations, existing scoped credentials and ownership; do not print secrets or raw transcripts. Direct main integration follows the relevant gates; no PRs and no disabled local hooks.

## Sources, files and ownership

Planning baseline: Quorum `6dc628490c8e6cd563404bbeddce5b0b53274101`, Gauntlet `f5d66447ce4234fd5c0901fad372935332003491`. The coordinator worktree contains the accepted documentation beyond the Quorum baseline. Recheck source state at execution; do not overwrite unrelated changes.

| Task | Owned files | Responsibility |
| --- | --- | --- |
| 1, Gauntlet | New `src/assessment/report.ts`, new `test/assessment/report.test.ts`; existing `src/assessment/assess.ts`, `test/assessment/assess.test.ts`; criterion comment in `src/types.ts` | Assessment tool, parsing, reduction and real assessment-loop behavior |
| 2, Quorum | `src/runner/conversation.ts`, `test/fixtures/conversation-role.ts`, `test/runner-conversation.test.ts`, `test/runner-conversation-gauntlet-integration.test.ts`, `test/runner-gauntlet-role.test.ts` | Received-report consistency and actual paired integration |
| 3, Quorum dated experiment | New `docs/experiments/2026-09-08-conversation-grading/run.ts`, new `test/conversation-grading-operator.test.ts` | One declared child, fixed allocation checks, complete usage coverage; no automatic next launch |
| 4, Gauntlet and experiment | Assessor prompt only in `src/assessment/assess.ts`; new dated `cases.json`, `README.md`; private frozen manifest and receipts | Separately selectable prompt and authenticated five-case inputs |
| 5, coordinator | Dated `results.md`; private result/review/installation receipts | Fixed diagnostic execution and eligible delivery |

Tasks 1 and 3 can run independently. Task 2 consumes Task 1's Gauntlet candidate. Task 4 depends on the reviewed mechanical pair and Task 3's interface. Task 5 consumes the frozen assembled candidate. Only the coordinator changes experiment declarations or selects commits. Task 4 must not overlap edits to Task 1's `assess.ts`.

Use the existing Quorum design worktree or an isolated descendant for execution, and a new Gauntlet worktree/`codex/` branch. Record the actual paths as `GRADING_Q_ROOT` and `GRADING_G_ROOT` in the private execution ledger. Run each command below in the repository stated. Use a short owned temporary directory for tmux tests. Record source/test receipts; do not infer test completion from the plan's expected outcomes.

### Task 1: Give assessment its own report contract

**Files:** Gauntlet files in the ownership table. Read `src/agent/validators.ts`, `src/agent/agent.ts`, `src/evidence/writer.ts`, `src/cli/assess.ts`; do not change generic validator/tool behavior.

**Interfaces:** New `AssessmentReport` contains `status: Exclude<VetStatus, "errored">`, `summary`, `reasoning`, `observations: Observation[]`, `criteria: CriterionVerdict[]`. Export `ASSESSMENT_REPORT_TOOL: ToolDefinition`, `parseAssessmentReport(args: unknown, acceptanceCriteria: readonly string[]): ParseResult<AssessmentReport>`, and `deriveAssessmentStatus(criteria: readonly CriterionVerdict[]): AssessmentReport["status"]` from `src/assessment/report.ts`.

- [ ] Add `test/assessment/report.test.ts` with real contract inputs. This representative test defines its own fixture and must initially fail because the assessment parser does not exist:

```ts
import { expect, test } from "bun:test";
import { parseAssessmentReport } from "../../src/assessment/report";

test("canonical rubric rows determine a failed overall result", () => {
  const parsed = parseAssessmentReport({
    summary: "Review delivered",
    reasoning: "The additional consequence was unsupported.",
    criteria: [
      { verdict: "pass", evidence: "visible/review.txt: required defect identified" },
      { verdict: "fail", evidence: "visible/review.txt: unsupported deployment claim" },
    ],
  }, ["Identify the required defect", "Keep all material findings grounded"]);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.value.status).toBe("fail");
  expect(parsed.value.observations).toEqual([]);
  expect(parsed.value.criteria.map(row => row.criterion)).toEqual([
    "Identify the required defect", "Keep all material findings grounded",
  ]);
});
```

  Extend the same fixture with the truth table: all pass → pass; pass/fail → fail;
  pass/unclear → investigate; unclear alone → investigate; fail/unclear → fail;
  pass/pass/pass/fail → fail. Assert rejection of zero criteria, absent/short/extra
  arrays, string-encoded arrays, nonobject rows, invalid verdict, blank evidence,
  top-level `status` (even when correct), and row-level `criterion`. Repeated
  valid verdicts/evidence are allowed; do not invent a duplicate-content rule.

- [ ] Run the new file and retain the red receipt: `bun test test/assessment/report.test.ts`.

- [ ] Implement the new module. Import `ParseResult` and `parseReportResult`
  from existing validators; reuse the real derived status when delegating
  summary/reasoning/observation validation. Do not duplicate their decoder or
  supply a fake placeholder status. The reduction and successful parsing tail
  are:

```ts
export function deriveAssessmentStatus(
  criteria: readonly CriterionVerdict[],
): AssessmentReport["status"] {
  if (criteria.length === 0) throw new Error("Assessment requires criteria");
  if (criteria.some(row => row.verdict === "fail")) return "fail";
  return criteria.every(row => row.verdict === "pass") ? "pass" : "investigate";
}

// After rejecting supplied status and validating/mapping the actual row array:
const core = parseReportResult({ ...args, status: deriveAssessmentStatus(criteria) });
if (!core.ok) return core;
return { ok: true, value: { ...core.value, criteria } };
```

  `parseAssessmentReport` returns `{ok:false, reason:string}` for malformed input.
  Check `typeof value === "object" && value !== null && !Array.isArray(value)`
  before reading object fields. Require `Array.isArray(args.criteria)` and exact
  positive cardinality. Reject `Object.hasOwn(args, "status")` and
  `Object.hasOwn(row, "criterion")`. Preserve each valid evidence string and
  attach `acceptanceCriteria[index]` verbatim. Summary/reasoning and optional
  observations retain existing validation.

  Define an assessment-only `report_result` tool with required `summary`,
  `reasoning`, `criteria`; optional observations; and rows with required
  `verdict`/`evidence`, the existing verdict enum, and no model criterion/status.
  Reuse the generic tool's immutable summary/reasoning/observation property
  definitions if useful; never mutate them. The parser must enforce forbidden
  fields itself because the generic tool validator is not a full JSON Schema
  implementation.

- [ ] In `assess.ts`, replace the generic reporting tool and report parsers
  with `ASSESSMENT_REPORT_TOOL` and `parseAssessmentReport`. After input identity
  checks and before any client request, reject `rubric.acceptanceCriteria.length
  === 0`. Feed a successful parsed report directly to existing `finish`:

```ts
const parsed = parseAssessmentReport(call.arguments, rubric.acceptanceCriteria);
if (!parsed.ok) {
  return { ok: false, result: textResult(`Error: report_result rejected: ${parsed.reason}`) };
}
return { ok: true, result: finish(parsed.value) };
```

  Keep the existing outer typed-error handling, deadline, history and logger.
  Keep timeout fallback `investigate` without complete criteria. In `types.ts`,
  clarify only the criterion comment: QA uses a model restatement; assessment
  attaches canonical text. No type/schema or writer behavior changes.

- [ ] Update the existing `report()` and actual Anthropic SDK fixtures in
  `test/assessment/assess.test.ts` to submit only `{verdict,evidence}` rows and
  omit status. Keep a malformed-first/valid-second response sequence and assert
  typed `is_error`, retained history, both turns' usage, correct persisted
  JSON/Markdown status and `assessmentExitCode`, and no extra request after the
  valid result. Add zero-rubric coverage that asserts the scripted client's
  `histories.length === 0`. Retain the generic QA regression in
  `test/agent/validators.test.ts` that permits independently authored status.

- [ ] Run `bun test test/assessment test/agent/validators.test.ts`, then
  `bun run typecheck`. Expect the contract/loop cases to pass and generic QA
  behavior to remain the same. Commit this mechanical Gauntlet change with the
  failing/passing receipts and precise scope in the commit body. Do not include
  the held semantic instructions in this commit.

### Task 2: Enforce Quorum consistency and prove the actual boundary

**Files:** Quorum files in the ownership table. No composer/schema/render changes.

**Interfaces:** `runPreparedConversation` and `invokeGauntletRole` retain their
existing signatures. Gauntlet's persisted report has canonical rows and a
derived status; generic QA reports are unaffected. Quorum independently checks
row shape/status equality, while exact rubric coverage remains Gauntlet-owned.

- [ ] Extend the existing fake-report cases in `test/runner-conversation.test.ts`
  and its executable `test/fixtures/conversation-role.ts`
  with contradictory all-pass/fail, all-pass/investigate, and
  pass/pass/pass/fail/investigate reports. Each must yield final indeterminate
  with a Gauntlet-stage error and retained evidence. Keep completed valid
  unclear distinct from malformed or absent criteria. Run the affected test to
  demonstrate the existing one-way guard accepts a contradictory case.
  The fake executable writes persisted reports, so it retains `status` and
  `criterion`; only actual model tool submissions lose those fields.

- [ ] Replace only the current one-way consistency predicate after validating
  nonempty criterion rows in `src/runner/conversation.ts`. Use this expected
  status expression and the existing failure return; never rewrite the report:

```ts
const expectedAssessmentStatus = criteria.some(c => c.verdict === 'fail')
  ? 'fail'
  : criteria.every(c => c.verdict === 'pass') ? 'pass' : 'investigate';
if (gauntlet.status !== expectedAssessmentStatus)
  return fail('gauntlet', 'Assessment inconclusive: missing or inconsistent criteria');
```

- [ ] Update the assessment tool submissions in
  `test/runner-conversation-gauntlet-integration.test.ts` to the new anonymous
  row contract. Preserve its actual CLI, real tmux and finite localhost
  Anthropic provider. Keep all five existing outcome cases, including valid
  investigate with failed post-check → final indeterminate and `error:null`.
  Retain both role usage records and output/trajectory evidence assertions.

- [ ] Parameterize the real hung-child deadline test in
  `test/runner-gauntlet-role.test.ts` for both roles, using its existing `setup`:

```ts
for (const role of ['conversation', 'assessment'] as const)
  test(`parent deadline settles a hung ${role}`, async () => {
    const args = { ...setup(), role };
    const result = await invokeGauntletRole(args);
    expect(result.stop_cause).toBe('timed_out');
    expect(result.process_exit?.signal).toBeTruthy();
    expect(currentRoleChild()).toBeNull();
    const records = JSON.parse(readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'));
    expect(records[role]).toEqual(result);
  });
```

  Add the actual timeout-shaped assessment report (`investigate`, absent
  criteria) to the existing runner fixture and verify error classification and
  retained evidence. Together these prove the real bounded role and boundary
  handling; do not call them a full 120-second end-to-end timeout test or add a
  production timeout seam solely for testing.

- [ ] Run focused Quorum tests and explicitly run the paired suite on the
  assembled Gauntlet worktree. Use a short temporary root:

```sh
bun run test test/runner-conversation.test.ts test/runner-gauntlet-role.test.ts
GAUNTLET_ROOT="$GRADING_G_ROOT" bun run test test/runner-conversation-gauntlet-integration.test.ts
```

  The existing `test/run.ts` wrapper owns its short temporary directory.
  Record all actual paired cases as executed, not skipped. Commit Quorum separately.
  Obtain independent review of the combined mechanical diff. These changes
  qualify for selection after full checks in Task 4 even if the prompt fails.

### Task 3: Implement one bounded retained-assessment launch

**Files:** New dated `run.ts` and `test/conversation-grading-operator.test.ts`.
Read the old dated reliability operator; do not modify or clone its closed
stage/corpus logic. Keep the new entrypoint specific to this five-case plan.

**Interfaces:** Export `verifyAssessmentUsage(out: string): number`, returning
the number of fully covered returned turns or throwing on incomplete/malformed
coverage. Export `runAssessmentCase(manifestPath: string, ordinal: number,
deps: CaseDependencies): Promise<void>`. Its CLI accepts only
`--execute <absolute-manifest.json> <ordinal-1-through-5>` and launches one child.
The dependency seam supplies existing operations, not a new runtime abstraction:

```ts
type CaseDependencies = {
  now(): number;
  signal: AbortSignal;
  acquireLease(onLost: () => void): Pick<LiveSpendLock, 'heartbeat' | 'release'>;
  graderEnv(): Record<string, string | undefined>;
  child: typeof runChild;
  priceUsage: typeof estimateUsageSidecar;
};
```

  Source/input validation and filesystem receipts remain real code in tests.
  The CLI's production dependency construction loads the pilot config; its
  `acquireLease` checks run/sync locks and acquires shared ownership. Injected
  offline dependencies never read the appliance's live configuration or bundle.
  Use these existing exports:

```ts
import { runChild, gitHead } from '../2026-09-08-conversation-reliability/run.ts';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import { inspectLock } from '../../../src/appliance/locks.ts';
import { readBundleEnvForProjection } from '../../../src/appliance/credential-scope.ts';
import { acquireLiveSpendLock, realProcessIdentityProbe, type LiveSpendLock } from '../../../src/campaign/locks.ts';
import { createDurableMarker } from '../../../src/campaign/journal.ts';
import { verifyPricingSnapshot } from '../../../src/campaign/pricing-snapshot.ts';
import { estimateUsageSidecar } from '../../../src/obol/index.ts';
import { gauntletEnvBase } from '../../../src/runner/gauntlet-env.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';
```

- [ ] Write fixture data for the fixed manifest and receipts described here;
  implement their closed Zod validation after the failing admission tests. The
  manifest has absolute `q_root`, `g_root`, `experiment_dir`, Q/G full
  SHAs, an absolute `cutoff_at`, fixed model/pricing, authentication reference
  hashes, and exactly five ordered case rows. Each row has `ordinal`, `id`,
  `rubric`, `evidence_root`, `evidence_index`, `scenario_id`, and SHA-256 hashes
  for its rubric/index/every indexed file. The independently settled judgment
  references stay outside the assessor index. Validate the exact five IDs and
  order in Task 4, not an arbitrary-length matrix or user-provided command.

  The private experiment directory contains only the following coordination
  receipts, alongside normal Gauntlet output:

  | File | Required content and behavior |
  | --- | --- |
  | `window.json` | Manifest digest, first launch timestamp, effective deadline = min(frozen cutoff, first launch + 45 minutes); exclusive creation |
  | `01/launch.json` through `05/launch.json` | Ordinal/case/input identity, allocated output path, manifest digest and launch timestamp; persist before child; never overwrite |
  | `01/settled.json` through `05/settled.json` | Actual process outcome, result/usage digests, coverage, priced subtotal or unknown, finish time; exclusive terminal receipt |
  | `01/review.json` through `05/review.json` | Exact result digest, `match` or `semantic_miss`, short evidence-based rationale; coordinator writes after review |
  | `stopped.json` | Terminal operational or independently substantiated gold stop; excludes further launches |

  `createDurableMarker` supplies exclusive durable creation. There is no resume:
  a launch without settlement, missing review, duplicate/skipped ordinal, changed
  frozen input, or terminal stop refuses the next invocation. A valid
  `semantic_miss` review permits the next declared row while permanently
  disqualifying prompt promotion. No automatic review or next-child loop.

- [ ] Add a usage-coverage regression using actual logger-shaped files. This
  complete fixture must be rejected because one returned turn has no sidecar:

```ts
test('one priced row cannot cover a two-turn assessment', () => {
  const out = mkdtempSync(join(tmpdir(), 'grade-usage-'));
  try {
    writeFileSync(join(out, 'result.json'), JSON.stringify({ usage: { turns: 2 } }));
    const events = [
      { type: 'llm_request', turn: 1 }, { type: 'llm_response', turn: 1 },
      { type: 'llm_request', turn: 2 }, { type: 'llm_response', turn: 2 },
      { type: 'run_end', usage: { turns: 2 } },
    ];
    writeFileSync(join(out, 'run.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n');
    const usage = {
      type: 'obol.usage', v: '2026-06-08', provider: 'anthropic',
      model: 'anthropic.claude-sonnet-5',
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    writeFileSync(join(out, 'usage.jsonl'), JSON.stringify(usage) + '\n');
    expect(() => verifyAssessmentUsage(out)).toThrow();
    appendFileSync(join(out, 'usage.jsonl'), JSON.stringify(usage) + '\n');
    expect(verifyAssessmentUsage(out)).toBe(2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
```

  Import the named Bun test and node filesystem/path/os functions in the test.
  Run `bun run test test/conversation-grading-operator.test.ts` and retain red.

- [ ] Implement `verifyAssessmentUsage`: parse the actual result, run log and
  sidecar. Require positive N returned responses, sequential request and
  response turns 1..N, exactly one completed `run_end`, matching result/end turn
  counts, and exactly N `obol.usage` rows for the fixed provider/model. Validate
  numeric nonnegative input/output tokens and any supplied cache counters.
  Reject truncated lines, missing/extra/invalid usage rows and a request without
  its response. Then price through the real existing estimator; unknown models
  or failed pricing cannot become complete accounting. This establishes
  returned-turn coverage, not invoice reconciliation or visibility into provider
  retries. Preserve priced partial usage on interrupted executions as a known
  subtotal with incomplete coverage.

- [ ] Before implementing admission, add failing temporary-filesystem tests for
  missing review, duplicate/skipped ordinal, unfinished prior launch, changed
  input, exhausted spend/time, and semantic-miss continuation. Inject a child
  spy through `CaseDependencies` and assert zero calls for refused admissions
  and one call for the permitted next ordinal. Keep the fixture's source repos,
  manifest and receipt files real. Run the focused test and retain its red
  receipt before adding `runAssessmentCase`.

- [ ] Implement `runAssessmentCase` admission and one-child execution in this
  order. Keep the same small path for every ordinal:

  1. Parse the fixed manifest, verify current Q/G full SHAs and ordinary clean
     `git status --porcelain`, then import `parseStoryCard` and `makeRunId` only
     from that verified Gauntlet root. Rehash frozen input files and referenced
     authentication records. Reject unsafe paths/symlinks using the existing
     retained evidence validation rules.
  2. Call `deps.acquireLease`. In production this uses the already loaded pilot
     config, refuses occupied run/sync locks, and calls `acquireLiveSpendLock`
     using `RealClock` and the real process probe.
     Preserve its refusal of unresolved durable campaign claims. Catch heartbeat
     failure in the scheduler callback and abort the child; never clear a lock
     to obtain admission.
  3. Verify preceding receipts/reviews bind to unchanged output hashes; reprice
     settled usage and sum the fixed allocation. Refuse cumulative spend >= $4,
     ordinal outside 1..5, duplicate/skipped/incomplete work, terminal stop or
     less than 122 seconds before the effective deadline. Acquire/create the
     first `window.json` once; later invocations cannot reset its clock.
  4. Allocate an exclusive ordinal directory and normal output basename with
     `makeRunId(rubric.id)`. Create private `home` and `tmp`; write launch receipt
     before calling the child. A failed launch consumes that ordinal and stops
     the diagnostic; never reuse it. Revalidate source/input hashes after lease
     acquisition and immediately before recording the launch.
  5. Build the scoped environment using the same source aliases as the old
     operator: `QUORUM_GRADER_SOURCE_MODE=appliance-scoped` via its exported
     constants, blessed `AWS_BEARER_TOKEN_BEDROCK` mapped to
     `QUORUM_GRADER_ANTHROPIC_API_KEY`, the frozen Mantle Anthropic URL, and
     `SUPERVISOR_NETWORK_ENV_NAMES`. Pass through `gauntletEnvBase`, then set
     private HOME/TMPDIR. Do not inherit other provider credentials.

```ts
const outcome = await deps.child({
  args: [
    join(manifest.g_root, 'src/index.ts'), 'assess', entry.rubric,
    '--evidence-root', entry.evidence_root,
    '--evidence-index', entry.evidence_index,
    '--out', out,
    '--model', 'agent=anthropic.claude-sonnet-5',
    '--max-time', '2m',
  ],
  cwd: out,
  env: { ...deps.graderEnv(), HOME: join(out, 'home'), TMPDIR: join(out, 'tmp') },
  signal: controller.signal,
  timeoutMs: 120_000,
});
```

  `manifest`, `entry` and `out` are the validated values allocated above;
  `controller` forwards caller cancellation, lease loss and allocation cutoff.
  Construct production dependencies with the imported helpers. Reuse the
  existing `runChild` SIGTERM/SIGKILL cleanup rather than creating another
  subprocess supervisor.

  6. Retain process outcome and all available logs even on failure. Validate
     the standard report's identity, canonical criterion count/content,
     derived status and expected exit (pass 0, fail/investigate 1); use existing
     report schemas and the verified rubric. Complete unclear is a valid
     semantic miss, not an instrument error. Check returned-turn coverage and
     price usage. Write settlement and any operational stop, and release the
     lease in `finally`. The CLI exits after this one case; it never decides
     the semantic review or launches another case.

- [ ] Exercise real temporary files and an injected child/clock/lease. Record
  meaningful admission tests: missing previous review; duplicate/skipped/sixth
  ordinal; changed inputs or result digest; unfinished prior launch; $4 already
  spent; $3.99 plus a $0.20 settled call retained as $4.19 followed by refusal;
  121 seconds remaining; previous semantic miss permits exactly one next child;
  explicit gold stop refuses it. Assert zero child calls on refusal. Exercise
  lease loss with the real `runChild` on a hung temporary Bun program and confirm
  cancellation/log retention. No generated-command-string matching.

- [ ] Run the focused operator test and Quorum lint/typecheck. Independently
  review the actual entrypoint and its scope before freezing inputs. Commit
  dated operator/tests separately from production runtime. Do not alter old
  operator semantics, campaign schemas or public commands.

### Task 4: Select the prompt and freeze the five inputs

**Files:** Gauntlet `src/assessment/assess.ts` in a separate prompt commit;
Quorum dated `cases.json` and `README.md`; private manifest, test receipts and
source/evidence inventories under ignored `results/conversation-grading/`.

**Interfaces:** Tasks 1–3 supply the reviewed mechanical source pair and
`run.ts --execute <manifest> <ordinal>`. This task produces clean source commits,
five fixed case declarations and a verified manifest for Task 5. Its candidate
prompt remains independently removable without changing the mechanical tool.

- [ ] Select only these substantive instructions from held Gauntlet
  `2d3c18cef537425d2d1765bfc0c3002723b30e30:src/assessment/assess.ts` onto the
  mechanical candidate's existing system prompt:

```text
Evaluate every clause in each original criterion and cite evidence for every clause in the criterion's verdict.
Inspect the actual delivered response and any contradictory transcript or output before assigning credit.
Distinguish observed behavior from asserted consequences. Missing evidence is uncertainty, not proof that behavior was absent; use fail for observed unmet obligations and unclear when evidence is genuinely insufficient.
Treat local tests as evidence only for the exact claims they exercised, distinguish them from independent checks, and preserve the chronology of before-and-after results.
```

  Keep permitted alternatives, conditional statements and explicitly unresolved
  assumptions governed by the actual rubric. Replace the held candidate's
  obsolete final tool-call instruction with:

```text
Finish only by calling the real report_result tool with summary, reasoning, and one structured criteria row per rubric criterion in its original order. Each row contains verdict and evidence. Do not supply status or criterion text. Do not substitute XML or prose for structured tool arguments.
```

  Do not add watch-specific hints, new grading categories or another candidate.
  Commit this prompt delta separately. Preserve the exact mechanical-only
  Gauntlet ref for independent selection.

- [ ] Create the dated five-case declarations from these exact records. The
  `known` family resolves beneath the existing release corpus; `driver` resolves
  beneath the later retained driver evidence. Those source roots are inputs to
  manifest preparation, not model-visible paths to unrelated evidence:

```ts
const cases = [
  { ordinal: 1, id: 'claude-design', family: 'driver', run: 'conversation-design-claude-opus5_bedrock-linux-20260908T195051Z-874b', expected: ['fail', 'fail', 'pass'] },
  { ordinal: 2, id: 'known-claude-design', family: 'known', run: 'conversation-design-claude-opus5_bedrock-linux-20260908T055800Z-5f07', expected: ['pass', 'pass', 'pass'] },
  { ordinal: 3, id: 'known-codex-review', family: 'known', run: 'conversation-code-review-codex-openai_responses_56sol-linux-20260908T060413Z-d5ed', expected: ['pass', 'pass', 'pass', 'pass'] },
  { ordinal: 4, id: 'codex-design', family: 'driver', run: 'conversation-design-codex-openai_responses_56sol-linux-20260908T195053Z-0d17', expected: ['fail', 'fail', 'pass'] },
  { ordinal: 5, id: 'known-claude-review', family: 'known', run: 'conversation-code-review-claude-opus5_bedrock-linux-20260908T055758Z-190d', expected: ['pass', 'pass', 'pass', 'fail'] },
] as const;
```

  Store the equivalent JSON in `cases.json`, with explicit gold/rubric
  references. Both known reviews use
  `docs/experiments/2026-09-08-conversation-release/controls/rubrics/code-review-revised.md`.
  Known design uses that release's `controls/rubrics/design.md`; later designs
  use their exact `conversation-input/rubric.md`. The known gold is the release
  `expected.json`; later gold is the frozen blind audit and
  `driver-grader-adjudication.md`, not a newly written judgment.

- [ ] Prepare full evidence from these existing local directories, whose five
  evidence indexes were found during planning; this existence check is not
  authentication:

  - `/Users/drewritter/prime-rad/superpowers-evals/.worktrees/conversation-assessment/results/conversation-release/known/`
  - `/Users/drewritter/prime-rad/superpowers-evals/.worktrees/conversation-reliability/results/conversation-reliability/driver-final-evidence/results/`

  Reuse the release corpus's authentication records for the known cases.
  Authenticate later designs against their campaign report anchor and retained
  `driver-artifact-inventory.json`. The private adjudication/receipt source is
  `.superpowers/sdd/2026-09-08-conversation-reliability/` in the reliability
  worktree. Independently compare the actual selected rubric bytes to the
  settled criterion text before freezing. Preserve the complete existing
  evidence index; do not cherry-pick decisive captures or supply old assessments.

- [ ] Generate the private manifest by reading the validated files, computing
  SHA-256 over exact bytes and using full Q/G `git rev-parse HEAD` identities.
  Record the fixed model `anthropic.claude-sonnet-5`, credential route
  `sonnet5_bedrock`, Mantle URL
  `https://bedrock-mantle.us-east-1.api.aws/anthropic`, and pricing reference:

```json
{
  "path": "docs/experiments/2026-09-06-pr2258-pricing/current.json",
  "sha256": "6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b"
}
```

  Complete staged absolute paths and the absolute cutoff immediately before
  execution. The manifest freezes before the first provider request; the
  exclusive first-launch window can only shorten its remaining time. Keep gold
  and source/ownership metadata outside all five assessor evidence indexes.
  README documents the five IDs/order, manifest/receipt format, fixed limits,
  diagnostic continuation and operator invocation. No raw transcripts or
  credential material enter git.

- [ ] Run required checks on the assembled candidate and record actual results:

```sh
# In the Gauntlet candidate:
bun run check
# In the Quorum candidate:
bun run check
bun run quorum check
GAUNTLET_ROOT="$GRADING_G_ROOT" bun run test test/runner-conversation-gauntlet-integration.test.ts
```

  Also run the dated gate against a real Gauntlet CLI with the existing
  localhost-provider pattern and dummy credentials. Assert it consumes the
  actual result/exit/log/usage files. Add this case to
  `test/conversation-grading-operator.test.ts`, guarded by `GAUNTLET_ROOT`, and
  execute it explicitly with that variable set. Internal malformed-tool repair
  must contribute both returned turns to coverage/accounting. Do not infer this
  coverage from a child spy or skip the real paired tests.

- [ ] Independently review the exact production/operator/prompt diffs and
  frozen case/rubric selections, then resolve material findings. Record the
  mechanical-only G ref, combined G candidate, Q ref and test receipts. Commit
  dated declarations/docs. A source change after checks requires the affected
  checks/review again; documentation-only receipts do not require another broad
  test run. Keep final source worktrees clean before staging.

### Task 5: Execute the fixed diagnostic and deliver eligible changes

**Files:** Private staged sources, manifest and five receipt/output directories;
dated `docs/experiments/2026-09-08-conversation-grading/results.md`.

**Interfaces:** Task 4 supplies exact reviewed sources and authenticated inputs.
Task 3 owns each assessment child and settlement; the coordinator supplies
semantic reviews and requests each next ordinal. No new scenario or provider
call is implicit in a source/installation check.

- [ ] Confirm execution authorization includes the five-assessment allocation.
  Use Tailscale SSH as `quorum-runner@quorum-appliance` and the installed pilot
  helper for read-only health/ownership preflight:

```sh
ssh -o BatchMode=yes quorum-runner@quorum-appliance '/srv/quorum/pilots/conversation-assessment/bin/evals-appliance doctor --json'
```

  Respect active jobs, shared-spend ownership and durable campaign claims. Do
  not clear locks or start an unrelated smoke run. These retained assessments
  use the established dated exact-source path; there is no appliance `assess`
  verb to invent.

- [ ] Stage new clean Q/G worktrees by verified git bundles over Tailscale,
  using the already documented bundle/fetch/worktree sequence in
  `conversation-startup-evidence-design/.superpowers/sdd/2026-09-08-conversation-startup-evidence/pilot-stage-preflight.md`.
  Create uniquely named directories under
  `/srv/quorum/pilots/conversation-assessment/`; preserve all existing source
  and result directories. Derive bundle/source names from the reviewed SHAs,
  record exact paths in the manifest, install frozen dependencies, and verify
  the actual child source path. Direct retained assessment does not require
  changing pilot source selections, `prepare`, registration, image build or
  retagging. Keep the existing pilot config as the credential/ownership source.

- [ ] On the appliance, authenticate staged evidence and source/pricing bytes
  again, finalize the absolute manifest cutoff and record the approved fixed
  diagnostic. Set `OBOL_PRICING_DIR` before starting Bun, since pricing imports
  initialize in-process. Use the existing detached launch pattern from
  `conversation-reliability/.superpowers/sdd/2026-09-08-conversation-reliability/launch-retained.py`:
  sanitized environment, detached `Popen`, exclusive private log and receipt
  recording PID, Linux start ticks and boot ID. Adapt only its fixed command
  arguments to the new one-case entrypoint. From a prepared launcher where
  `q`, `manifest`, `ordinal`, and `env` come from the verified freeze:

```python
args = ['bun', str(q / 'docs/experiments/2026-09-08-conversation-grading/run.ts'),
        '--execute', str(manifest), str(ordinal)]
child = subprocess.Popen(args, cwd=q, env=env, stdin=subprocess.DEVNULL,
                         stdout=stream, stderr=stream, start_new_session=True)
```

  `stream` is an exclusively created private operator log. Preserve the
  established PID/start-ticks/boot receipt for polling/cancellation; no polling
  daemon or automation. The caller disconnecting must not own the assessment's
  lifetime. Any actual launch counts toward five, including a failed attempt.

- [ ] Poll the first child's immutable settlement and exact process identity.
  Verify termination, valid result, complete returned-turn accounting and
  frozen pricing. Have an independent reviewer compare the criterion vector
  and decisive rationale with settled gold while preserving raw result bytes.
  Write the coordinator review bound to its exact result digest. A valid wrong
  grade or complete unclear gets `semantic_miss`; proceed only with the next
  declared row. Invalid/incomplete output, unknown usage, operational failure,
  exhausted limit or substantiated gold ambiguity ends the diagnostic.

- [ ] Repeat that launch/poll/review action for ordinals 2–5 only. Do not
  substitute cases, add repetitions, edit the candidate, or erase failures.
  After the last allowed child, verify no owned process remains and record
  total known spend, coverage and stop/completion reason. Five completed cases
  means diagnostic completion; promotion requires five supported matches.

- [ ] Write `results.md` with exact Q/G/model/pricing identities, case pointers,
  each execution outcome, each criterion vector, derived status, semantic review
  and accounting. Report negative results equally. State that this is a
  candidate-only five-case regression exercise; do not claim repeatability,
  causal improvement, general grading reliability or debugging/test-history
  qualification.

- [ ] Select the independently reviewed mechanical changes for direct main
  integration after their offline gates. Include the prompt commit only if all
  five semantic reviews match. If it fails, preserve its branch/results and
  select the mechanical-only G ref; do not weaken the gate or begin another
  treatment. Keep dated experiment material separate from the runtime selection.
  Recheck current main, integrate with ordinary non-force git operations, run
  required checks on any materially changed assembled tree, and let local hooks
  run normally. Record exact selected/pushed refs and actual CI outcomes.

- [ ] Verify canonical campaign installation independently using the existing
  source-update path. Confirm clean configured Q/G sources at the selected refs,
  healthy helper, unchanged qualified Superpowers/image and no owned children
  or locks. A campaign worker mounts frozen source snapshots; the generic
  legacy path's image-baked Gauntlet remains a separate deployment surface.
  Do not rebuild that image or claim its update. Commit the concise delivery
  record and update the existing task ledger/ticket with source, test, semantic
  and installed proof kept distinct.

## Completion checklist

- [ ] Mechanical criterion/status contract and actual Q/G boundary verified.
- [ ] Generic QA, persisted schema, composer and original evidence preserved.
- [ ] Five distinct inputs authenticated with settled rubric/gold; one prompt frozen.
- [ ] Diagnostic executed only within its authorized fixed limits, or explicitly stopped with preserved evidence.
- [ ] Prompt selected only for five supported matches; mechanical delivery independent.
- [ ] Main/CI/canonical campaign source state reported from actual verification.
- [ ] Further work returns to the ordinary author-to-report workflow on a useful
  non-pricing scenario and mixed harness matrix; it is not authorized by this plan.
