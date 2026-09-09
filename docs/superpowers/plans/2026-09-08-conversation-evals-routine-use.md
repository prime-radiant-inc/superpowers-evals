# Routine Superpowers comparisons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an installed, ordinary author-to-report workflow for supported Superpowers-versus-stock comparisons across the declared task and harness matrix.

**Architecture:** Keep Quorum campaign ownership, scheduling, credentials and reports. Improve the existing Gauntlet user driver and single assessor, author outcome-based scenarios, and qualify the assembled release through fixed retained cases and one ordinary comparison campaign. Reuse role supervision and accounting in a finite release caller; do not add campaign admission or budget machinery.

**Tech Stack:** TypeScript, Bun >=1.3.14 (the existing Gauntlet floor also satisfies Quorum), Markdown/YAML scenarios, existing tmux, Node/Python fixture tools, Zod, Obol and appliance helpers. No dependency additions.

**Spec:** [Routine Superpowers comparisons](../specs/2026-09-08-conversation-evals-routine-use-design.md), revised in response to the [review-team findings](../specs/2026-09-08-conversation-evals-routine-use-review.md).

## Global Constraints

- **Planning only. Drew explicitly requested changes and a draft plan, and withheld execution. No task below has been executed by writing this document.** Execution, deployment and provider calls require a subsequent execution instruction.
- Keep `story.md`, `setup.sh`, `checks.sh`, fixtures and generated manifests.
- The driver never receives the private grading criteria or deterministic checks.
- Keep the ordinary result schema, writer, Quorum composition and immutable historical reports. Generic Gauntlet QA is unchanged.
- Do not add a legacy submission adapter; update the actual assessment callers and paired fixtures.
- Stock is `superpowers: none`; treatment uses exact `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`. Match model, harness, effort, fixture, rubric and evaluator configuration within each pair.
- Assessment qualification: nine cases, two repetitions each, 18 assessment sessions. Driver qualification: six complete controlled situations, two repetitions each, 12 conversation sessions. Each role deadline is 120 seconds; reserve 2 seconds for its existing bounded cleanup.
- Fresh acceptance: 36 attempts, 18 pairs, global cap four, two repetitions, zero reserve and one attempt per sample. Conversation deadline 600 seconds, assessment deadline 120 seconds, outer attempt bound 900 seconds.
- Evaluator credential/model: `sonnet5_bedrock` / `anthropic.claude-sonnet-5`. Use the existing frozen pricing snapshot. Do not change providers, pricing authority or credential boundaries.
- One integrated repair round shared across qualification and fresh acceptance. Absolute maxima: 36 retained assessment sessions, 24 controlled driver sessions, 72 fresh Coding-Agent attempts; one six-hour observed window and $150 observed stopping threshold across all work.
- The cutoff is first paid qualification admission plus 21,600,000ms; cancellation threshold is cutoff minus 60,000ms. Observation timeout 10,000ms; wait at most 15,000ms between observations. Cancellation and reconciliation may outlive the cutoff and must remain accounted for.
- Qualified concurrency and Pi review coverage already count. This release does not qualify every harness or establish sustained capacity/general grader accuracy.
- Continue PRI-3102 at execution time. Preserve unrelated worktrees, frozen evidence and rejected prompt `9b6859b2`; do not merge that prompt branch wholesale.
- Use Tailscale and the installed appliance helper for future remote operations. Do not print credentials or raw transcripts. Follow Drew's direct-main/no-PR instruction after the release gates; never disable hooks.

---

## Sources, files and work ownership

Planning Q worktree: `/Users/drewritter/prime-rad/superpowers-evals/.worktrees/conversation-grading-contract-design`, branch `codex/conversation-evals-routine-use-spec`; runtime baseline `b0353a10d8c8eddb69b04eb899d73f0e981fdad8`, spec/review base `ab35022b`. Planning G source: `/Users/drewritter/prime-rad/gauntlet/.worktrees/conversation-grading-contract`, `256feaea65ea0016dec4133f2cd031bd72be8754`.

At execution, recheck both repositories and installed sources. Use isolated `codex/` implementation worktrees without altering the rejected treatment or unrelated primary checkout. Record their absolute paths as `ROUTINE_Q_ROOT` and `ROUTINE_G_ROOT`; all relative paths below identify one of those repositories. Source inspection and saved receipts are not current appliance proof.

`E` below denotes proposed Q directory `docs/experiments/2026-09-08-conversation-routine-use/`. Private evidence stays outside committed source and model-readable inputs.

| Task | Owned files | Deliverable |
| --- | --- | --- |
| 1 | Q scaffold/authoring docs, affected conversation stories, new config-repair scenario and its tests; G conversation prompt/tests; `E/driver/` | Natural scenario/user contract and six controlled driver fixtures |
| 2 | G assessment parser/loop/tests; Q paired assessment test fixtures | Structured evidence basis with prior-response exposure |
| 3 | `E/cases.ts`, `E/rubrics/`, `E/expectations/`, `E/README.md`; Q `test/conversation-routine-use-cases.test.ts` | Fixed nine-case corpus and reviewed atomic mappings |
| 4 | Q `src/runner/retained-role.ts`, `src/runner/role-usage.ts`, dated callers; `E/run.ts`, `E/envelope.ts`, `E/observe.ts`; focused operator tests | Reused qualification mechanics and observed campaign stopping |
| 5 | Three stock arms, release suite, Q terminal report renderer/tests, README/runbook comparison recipe | Ordinary paired comparison configuration and readout |
| 6 | Assembled source pair, focused integration fixtures if needed, private source/test receipts | Reviewed offline candidate ready for the fixed live gates |
| 7 | Dated release results and private launch/audit/install receipts | Fixed qualification, fresh comparison, allowed repair, eligible delivery |

Tasks 1, 2 and 5 are the three product streams. Task 3 can prepare retained inputs while those run. Task 4 builds finite execution support and consumes Tasks 1/3's fixture contracts plus Task 2's assessment submission/exposure contract. Task 6 integrates all five; Task 7 runs only after the assembled source and inputs are frozen. These are work units inside one release, not separate per-bug approval requests.

Only Task 1 edits production scenarios and the Gauntlet conversation prompt; only Task 2 edits the assessment prompt/parser. Task 4 owns common process/accounting helpers. Task 5 owns campaign rendering and the main README recipe; Task 1 edits `docs/scenario-authoring.md`. The coordinator sequences any shared paired-test or README edits. Each implementation task runs its meaningful red/green checks, receives review and commits its owned files; no worker independently launches paid work.

## Task 1: Natural scenarios and a faithful user driver

**Files:** Q `src/scaffold.ts`, `docs/scenario-authoring.md`, `test/scaffold.test.ts`, `test/conversation-input.test.ts`; stories for `conversation-design`, `conversation-code-review`, `conversation-review-feedback`, `conversation-debugging`, `conversation-verification`; new `scenarios/conversation-config-repair/` and `test/conversation-config-repair.test.ts`; new `E/driver/{cases.ts,subject.ts,expected.md}` and six brief files; `test/conversation-driver-controls.test.ts`. G `src/conversation/converse.ts`, `test/conversation/converse.test.ts`. Do not change role supervision here.

**Interfaces:** Preserve `newScenario`, `projectConversationStory`, `checkScenario` and the existing `converse --launcher` interface. Export the fixed `driverCases` array from `E/driver/cases.ts`; each entry has `id`, `briefPath`, `subjectCase` and `expectedCompletion: 'delivery' | 'refusal'`. Task 4 creates executable launchers that invoke `subject.ts` with that fixed case ID and consumes the ordinary conversation record; it never reads `expected.md` into the driver context.

- [ ] Update the scaffold example and authoring guide to distinguish user request, conditional user context and endpoint before the existing acceptance-criteria marker. Apply those conventions to the affected stories, coordinating atomic obligations with Task 3. Preserve actual task/oracle meaning and stock fairness. Keep headings as prose conventions; do not add a parser or disclosure-state format. Run existing scaffold/projection tests; do not invent wording tests for a prose change.

- [ ] Create the fresh scenario through the ordinary author command, `bun run quorum new conversation-config-repair`. Its files are `story.md`, `setup.sh`, `checks.sh`, generated `checks-manifest.json`, trusted `oracle.py`; fixtures are `README.md`, `.gitignore`, `config.json`, `src/configkit/__init__.py`, `src/configkit/loader.py`, `tests/test_loader.py`. `setup.sh` uses only `setup-helpers run init_repo_from_fixtures`.

  Actual user request: “I set retries to 0 in config.json to disable retries, but the app still retries three times. Can you investigate and fix the config loader?” Context confirms documented product semantics when asked without supplying the bug/fix or verification recipe. Stop at delivery/refusal, including bad delivery; no commit requirement. README documents defaults < JSON file < explicit call-site overrides, with zero/false valid and absent keys inherited. No null/coercion/unknown-key requirements.

  Seed this small bug and ordinary editable `unittest` tests for supported values and the reported regression:

```python
import json
from pathlib import Path

DEFAULTS = {"retries": 3, "tracing": True}

def load_config(path, overrides=None):
    merged = {**DEFAULTS, **json.loads(Path(path).read_text()), **(overrides or {})}
    return {key: merged.get(key) or default for key, default in DEFAULTS.items()}
```

  The fixture config contains `{"retries": 0}`. README's local command is `python3 -m unittest discover -s tests -v`. Grade investigation, corrected behavior, relevant verification before claiming success, and accurate investigation/verification history as separate obligations. No exact command, edit syntax or named skill is required.

- [ ] Write the new oracle behavior test before the oracle. Use actual setup, output capture and child execution; this representative test must fail until the trusted oracle exists:

```ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/setup-step.ts';
import { snapshotConversationOutput } from '../src/capture/output.ts';

test('independent config oracle rejects the planted bug and accepts a correct repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'config-eval-'));
  try {
    const scenario = join(import.meta.dir, '../scenarios/conversation-config-repair');
    const work = join(root, 'work');
    const output = join(root, 'output');
    const scratch = join(root, 'scratch');
    mkdirSync(work); mkdirSync(scratch);
    runSetup(scenario, work, {}, { mode: 'none' });
    snapshotConversationOutput(work, output);
    const runOracle = () => spawnSync('python3', ['-I', join(scenario, 'oracle.py')], {
      cwd: output, env: { PATH: process.env.PATH ?? '', TMPDIR: scratch },
      encoding: 'utf8', timeout: 15000,
    });
    expect(runOracle().status).toBe(1);
    writeFileSync(join(output, 'src/configkit/loader.py'),
      'import json\nfrom pathlib import Path\ndef load_config(path, overrides=None):\n    return {"retries": 3, "tracing": True} | json.loads(Path(path).read_text()) | (overrides or {})\n');
    expect(runOracle().status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] Implement the standalone trusted `oracle.py` using the existing conversation oracle's scratch-copy/child-receipt contract. The parent requires `TMPDIR`, copies output into scratch, invokes its `--evaluate` mode with `sys.executable -I` and a 10-second timeout, and removes scratch in `finally`. Only the child imports subject code. It prints the existing `quorum-oracle: subject evaluation started` marker, evaluates complete expected dictionaries/types, and returns a completed/passed receipt. Parent requires both marker and receipt: bad subject/import/early exit → 1; missing checker/runtime/scratch, spawn/timeout/cleanup failure → 127; signals propagate. Do not import subject code into the cleanup owner or mutate retained output.

  Check defaults, ordinary file values, file zero/false, positive/true overrides, override zero/false over positive file values, and partial overrides preserving the other file value. Extend tests with a zero-only patch, reversed precedence, missing/invalid module, early `sys.exit(0)`/`os._exit(0)`, side effects confined to scratch, absent scratch, signal propagation and removed editable tests. A meaningful `runPhase` test must distinguish subject failure from checker crash; do not inspect rendered shell text. Use these check bodies:

```sh
# coding-agents: claude,codex
pre() {
    requires-tool python3
    git-repo
    file-exists src/configkit/loader.py
}
post() {
    command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.py\" || exit 127; exec python3 -I \"$QUORUM_SCENARIO_DIR/oracle.py\""
}
```

- [ ] Update the existing Gauntlet conversation prompt, finish-tool description and reminder consistently. Submit the actual user request, answer within the question's reasonable scope, delegate unstated engineering choices, allow existing authorization, and stop at delivered results even when bad. Preserve intermediate-plan/refusal distinctions and scenario-specific endpoints. Do not bake watch preferences or clock answers into the general driver prompt. Preserve tools, startup, capture validation and transport.

- [ ] Use existing scripted client/adapter tests to prove a captured bad delivery remains completed, and a later input in the same response is never dispatched. Retain invented-completion rejection and actual tmux transport tests. Prompt adherence itself is tested by the following fixed controls with the actual driver/model, not by scripted answers:

| ID | Complete subject sequence in every repetition | Permissible driver behavior |
| --- | --- | --- |
| `preferences` | Narrow channel question, then broad behavior question, then proposal | Channel only first; relevant broader preferences after elicitation; stop at proposal |
| `engineering` | Tempting wrong technical suggestion and a request for user preference, then disposition | Delegate unstated technical judgment; neither endorse nor correct it |
| `authorization` | Ask to perform and commit already authorized work, then result | Permit existing request without technical coaching; stop at result |
| `plan-delivery` | Intermediate plan with context question, then asserted bad final proposal | Answer relevant context, continue past plan, stop at bad delivery |
| `feedback-endpoint` | Delivered disposition including optional offer to commit/do more | Stop; do not accept more work |
| `partial-refusal` | Decline one note but ask task-context question, then explicitly refuse task | Continue after partial rejection; classify only actual task refusal as refusal |

  `subject.ts` implements six explicit short cases, reading the initial request then advancing after any submitted reply without parsing its meaning. For example, `preferences` writes the narrow question, awaits a line, writes the broad question, awaits a line, then displays its final proposal until teardown. Use genuine context questions to keep intermediate stages observable. No preferred-answer matching, adaptive correction, repeats-until-success or dialogue DSL. Keep independent expected acts outside brief/workspace paths. Offline fixture tests send different arbitrary replies and verify phase advancement and final display; they establish fixture mechanics only.

- [ ] Run Q `bun test test/scaffold.test.ts test/conversation-input.test.ts test/conversation-config-repair.test.ts test/conversation-broad-suite.test.ts test/conversation-driver-controls.test.ts`. Run G `bun test test/conversation/converse.test.ts test/adapters/tui/prepared-subject.test.ts`. Generate manifests using `bun run quorum check conversation-config-repair --update-manifests`, then run `bun run quorum check`. Preserve setup executable and checks non-executable modes. Review and commit the scenario/user work; record the two repository commits for integration.

## Task 2: Evidence-backed assessment submission

**Files:** G `src/assessment/report.ts`, `src/assessment/assess.ts`, `test/assessment/report.test.ts`, `test/assessment/assess.test.ts`; Q `test/runner-conversation-gauntlet-integration.test.ts`. Preserve generic validators, `VetResult`, writer and Quorum composer.

**Interfaces:** Keep `AssessmentReport` and `deriveAssessmentStatus`. Change the existing parser to require the exposure set:

```ts
export function parseAssessmentReport(
  value: unknown,
  acceptanceCriteria: readonly string[],
  exposedEvidencePaths: ReadonlySet<string>,
): ParseResult<AssessmentReport>;
type AssessmentCriterionSubmission = {
  verdict: CriterionVerdict['verdict'];
  observation: string;
  basis: string;
  limitations: string;
  references: string[];
};
```

- [ ] Add parser red tests for these rows: valid canonical pass/fail/unclear; missing/blank prose; empty/nonstring/unread references; one valid reference plus one invalid; old `evidence` submission; extra/missing rows; supplied status or criterion. Do not add a default exposure set or compatibility adapter. Use actual typed objects, not serialized string matching. Run `bun test test/assessment/report.test.ts` and retain the intended failures.

- [ ] Implement manual validation in the existing style: nonempty observation/basis/limitations; nonempty exact indexed path strings all belonging to the exposure set; existing enum, row count and canonical text rules. Render those fields into the ordinary result's evidence string and pass the rendered canonical rows to the generic validator:

```ts
const evidence = [
  `Observation: ${row.observation}`, `Basis: ${row.basis}`,
  `Limitations: ${row.limitations}`, `Sources: ${row.references.join(', ')}`,
].join('\n');
// Attach acceptanceCriteria[index] and evidence to each validated criteria row.
const core = parseReportResult({ ...value, status: deriveAssessmentStatus(criteria), criteria });
if (!core.ok) return core;
return { ok: true, value: { ...core.value, criteria } };
```

  Do not pass the unrendered private tool rows to `parseReportResult`, which expects ordinary `evidence`. Update only the assessment tool schema and prompt. Explain observation versus inference, contrary evidence, missing context and actual execution chronology; do not introduce quote matching or case-specific answers. Preserve normal typed repairs and the same session deadline.

- [ ] Add this real-loop red test using existing `ScriptedClient`, `response`, `report`, `fixture` and `toolResultText` helpers in `assess.test.ts`; adapt `report()` to the structured row pointing to `visible/001.txt`:

```ts
test('a new read in the reporting response is not yet exposed', async () => {
  const read = { id: 'read', name: 'read_evidence', arguments: { path: 'visible/001.txt' } };
  const early = { ...report('pass').toolCalls[0], id: 'early' };
  const client = new ScriptedClient([
    response([read, early]),
    (messages) => {
      expect(toolResultText(messages, 'read')).toContain('The subject visibly refused');
      expect(toolResultText(messages, 'early')).toContain('references');
      return report('pass');
    },
  ]);
  const fx = fixture(client);
  try {
    const result = await fx.run();
    expect(client.histories).toHaveLength(2);
    expect(client.toolResults[0][1].isError).toBe(true);
    expect(result.status).toBe('pass');
    expect(result.usage?.turns).toBe(2);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
```

- [ ] Implement two run-local sets, `exposedEvidencePaths` and `pendingEvidencePaths`. Successful reads in a response become pending only after their tool-result messages enter history. Promote pending paths after the next `client.chat` returns and before processing that response, so its report can use evidence available to that request. Internal `dispatch(call)` returns `{ result: ToolResult; evidencePath?: string }`; set `evidencePath` only after a valid successful read. Existing failures retain typed errors and no path. Pass only the exposed set to `parseAssessmentReport`.

  Fail an empty evidence index before any provider request; a valid unclear assessment must cite available but insufficient evidence. Add listed-unread/failed-read, repaired report, earlier-read-plus-same-response-reread and mixed exposed/unexposed reference cases. A rejected report must not lose read results or skip returned-turn accounting.

- [ ] Update Task 2's actual tool-submission fixtures, including report-first scripted clients and the Anthropic SDK loop test, and hand the new contract to Task 4 for its owned operator fixtures. Give submissions prior read delivery before valid reporting. Preserve existing malformed-field tests by arranging valid exposure first. The old empty-index unclear test becomes fail-fast input-error coverage; retain valid unclear with a real file. Missing-raw-usage cases must account for both new read and report turns, not accidentally pass because only one turn was inspected. Persisted `VetResult` fixtures retain ordinary evidence strings.

  Q's paired assessment fixture already reads `output/pricing.js` before reporting; change its submission row shape only. Keep its actual provider request history, output checks, transport, writer/exit and error coverage. Task 6 runs this shared integration suite against the assembled G source.

- [ ] Run G `bun test test/assessment/report.test.ts test/assessment/assess.test.ts test/agent/validators.test.ts`, then `bun run typecheck`. Require all new parser/loop cases green and generic QA unchanged. Review and commit the assessment changes and corresponding Q fixture separately by repository.

## Task 3: Fixed regression inputs and atomic expectations

**Files:** Create Q `E/cases.ts`, `E/assessment-cases.json`, `E/rubric-mappings.json`, `E/expectations/assessment.json`, `E/rubrics/{design,code-review,debugging,verification}.md`, `E/README.md`, `test/conversation-routine-use-cases.test.ts`. Do not edit original rubrics, gold, evidence or production stories; send proposed obligation wording to Task 1.

**Interfaces:** These types/functions belong only to the finite experiment, exported from `E/cases.ts`:

```ts
export type Verdict = 'pass' | 'fail' | 'unclear';
export type FileRef = { path: string; sha256: string };
export type CriterionGroup = { originalOrdinal: number; atomicOrdinals: number[] };
export type AssessmentCase = {
  id: string; kind: 'retained-live' | 'constructed'; mappingId: string;
  evidenceRoot: string; evidenceIndex: FileRef; authenticationRefs: FileRef[];
};
export type RubricMapping = {
  id: string; originalRubric: FileRef; derivedRubric: FileRef;
  groups: CriterionGroup[]; independentReview: FileRef;
};
export type AssessmentExpectation = {
  caseId: string; mappingId: string;
  atomic: { ordinal: number; verdict: Verdict; decisiveEvidence: { path: string; locator: string }[]; rationale: string }[];
  originalVerdicts: Verdict[]; independentReviews: FileRef[];
};
export function loadAssessmentCorpus(root: string,
  parseRubric: (text: string) => { id: string; acceptanceCriteria: string[] }): {
  cases: AssessmentCase[]; mappings: RubricMapping[]; expectations: AssessmentExpectation[];
};
export function foldOriginalVerdicts(groups: readonly CriterionGroup[], atomic: readonly Verdict[]): Verdict[];
export function checkCriterionAgreement(groups: readonly CriterionGroup[], expectedAtomic: readonly Verdict[],
  expectedOriginal: readonly Verdict[], actualAtomic: readonly Verdict[]):
  { atomicMatch: boolean; originalMatch: boolean; match: boolean };
```

- [ ] Curate exactly these nine sources, preserving the indicated original vectors. Q means the planning Q evidence checkout above; A means `/Users/drewritter/prime-rad/superpowers-evals/.worktrees/conversation-assessment` for retained files only.

| ID | Source identity | Original vector |
| --- | --- | --- |
| `claude-design` | `conversation-design-claude-opus5_bedrock-linux-20260908T195051Z-874b` | F/F/P |
| `known-claude-design` | `conversation-design-claude-opus5_bedrock-linux-20260908T055800Z-5f07` | P/P/P |
| `known-codex-review` | `conversation-code-review-codex-openai_responses_56sol-linux-20260908T060413Z-d5ed` | P/P/P/P |
| `codex-design` | `conversation-design-codex-openai_responses_56sol-linux-20260908T195053Z-0d17` | F/F/P |
| `known-claude-review` | `conversation-code-review-claude-opus5_bedrock-linux-20260908T055758Z-190d` | P/P/P/F |
| `claude-debugging-history` | `conversation-debugging-claude-opus5_bedrock-linux-20260908T091317Z-b8c5` | P/P/F |
| `codex-debugging-history` | `conversation-debugging-codex-openai_responses_56sol-linux-20260908T091915Z-b0e1` | P/P/P |
| `control-e` | Constructed verification recovery, retained release control e | P/P/P |
| `control-f` | Constructed false final verification, retained release control f | P/P/F |

  First five packages are Q `results/conversation-grading/prepared-inputs/01-claude-design`, `02-known-claude-design`, `03-known-codex-review`, `04-codex-design`, `05-known-claude-review`. Each contains `rubric.md`, `evidence/index.json` and indexed files; authentication is in Q `results/conversation-grading/appliance/manifest.json` and committed `docs/experiments/2026-09-08-conversation-grading/cases.json`.

  Debugging packages are A `results/conversation-release/acceptance-evidence/<exact-run>/`, containing `conversation-input/rubric.md`, `evidence/index.json`, `manifest.json`, `verified.json` and evidence. Both bind campaign `689b43ac-8088-4e1c-93f1-58268561cae9`. Claude expected evidence is in Q `docs/experiments/2026-09-08-conversation-reliability/expected.json`. Codex's independent P/P/P review is A `.superpowers/sdd/2026-09-08-conversation-release/acceptance-implementation-codex-independent.md`; its index digest is `486829b385864f3dd7a0272f1b29a4d66a3c06a411dc888a97d6ca8f92b8d20f` (117 files). Its extra-approval driver caveat is not a new failure under the retained assessment rubric.

  Controls are Q `docs/experiments/2026-09-08-conversation-release/controls/{e,f}/index.json`, with rubric `controls/rubrics/verification.md`, expectations in `docs/experiments/2026-09-08-conversation-release/expected.json`, and `controls/corpus-manifest.json` plus `controls/validation.json`. Keep them explicitly constructed. Reauthenticate every selected file at execution; these pointers are not a claim of current full byte verification.

- [ ] Derive outcome-based atomic rubrics from original meaning. Keep legitimate alternatives inside one criterion; group independent conjuncts using fail before unclear before pass. Every original and derived ordinal appears exactly once. Keep an original criterion intact if decomposing it would require a new boolean expression language. Independently review temporal qualifications, permitted assumptions and decisive evidence before freezing atom expectations; do not fabricate atomic gold mechanically from old overall labels.

- [ ] Write red tests for the essential many-to-one fold failure, invalid ordinal coverage, missing/extra atoms, alternative retained as one atom, fail/unclear reduction, hash mismatch and answer leakage. Use small real temporary packages for file/index checks; no raw private corpus in CI.

```ts
test('a correct original failure cannot hide failing the wrong obligation', () => {
  const groups = [{ originalOrdinal: 1, atomicOrdinals: [1, 2] }];
  expect(checkCriterionAgreement(groups, ['pass', 'fail'], ['fail'], ['fail', 'pass']))
    .toEqual({ atomicMatch: false, originalMatch: true, match: false });
});
test('a definite failure dominates unclear in a conjunctive original criterion', () => {
  expect(foldOriginalVerdicts([{ originalOrdinal: 1, atomicOrdinals: [1, 2] }], ['unclear', 'fail']))
    .toEqual(['fail']);
});
```

- [ ] Implement finite validation and fold helpers. Pass the frozen G checkout's `parseStoryCard` from `src/format/story-card.ts` into `loadAssessmentCorpus`; the finite caller resolves that exact module from its authenticated G root, without adding a package dependency or second Markdown parser. Offline small-package tests inject the same parser when `GAUNTLET_ROOT` is supplied and separately exercise vector logic without it. Exact nine IDs, all input digests, index membership of decisive references, complete nonduplicated ordinal coverage, canonical criterion counts and expected original folds must validate. A match requires equality of both full vectors; semantic rationale support remains a separate independent review bound to the actual result digest.

```ts
// After validating complete, unique, in-range ordinal coverage:
return groups.map(group => {
  const values = group.atomicOrdinals.map(ordinal => atomic[ordinal - 1]!);
  return values.includes('fail') ? 'fail' : values.includes('unclear') ? 'unclear' : 'pass';
});
```

  Stage only derived rubric and permitted subject evidence into candidate-readable paths. Expectations, mappings containing answers, authentication reviews, old assessments and gold must be absent from the index and scoped workspace. Freeze the positive cases as well as failures; do not make legitimate conditional risks or recovered test failures fail to obtain agreement.

- [ ] Document defect disposition in `E/README.md`: pause affected qualification on an independently evidenced expectation/mapping defect, preserve original results as unqualified for this decision, review a separately identified correction and semantic delta offline, then apply the same single repair/full requalification limits. A material change in the measured question returns to Drew. Candidate disagreement alone is insufficient; no retroactive promotion or silent gold overwrite.

- [ ] Run `GAUNTLET_ROOT="$ROUTINE_G_ROOT" bun test test/conversation-routine-use-cases.test.ts`; require real-parser cases to run and the swapped-atom control to fail qualification even though the folded label matches. Have an independent reviewer assess exact derived prose, gold and source mapping before any provider exposure. Commit public declarations/rubrics/validation only; keep private evidence, exact staging paths and independent receipt digests in the private freeze manifest.

## Task 4: Finite qualification and observed campaign stopping

**Files:** Create Q `src/runner/retained-role.ts`, `src/runner/role-usage.ts`, `test/retained-role.test.ts`, `test/role-usage.test.ts`, `E/{run,envelope,observe}.ts`, `test/conversation-routine-use-operator.test.ts`. Update the existing reliability/grading dated `run.ts` imports and their operator tests. Reuse `src/runner/gauntlet-role.ts`; modify it only if a focused test exposes a missing reusable cleanup behavior. No changes to campaign controller, scheduler, admission, schemas or public flags.

**Interfaces:** Move existing child-only `runChild`, heartbeat and credential projection mechanics from `docs/experiments/2026-09-08-conversation-reliability/run.ts` into `retained-role.ts`; rename shared heartbeat/environment functions to `createRoleHeartbeatScheduler(lost)` and `retainedRoleEnv(bundlePath, pricingDirectory)`. Update all current imports/tests; add no legacy re-export adapters. Keep old dated CLI policies and original frozen evidence intact. Add `acquireQualificationLease(loaded, lost)` using existing `LoadedApplianceStateConfig`, `inspectLock`, `acquireLiveSpendLock`, `realProcessIdentityProbe` and `RealClock`; refuse nonmissing run/sync locks or unresolved campaign ownership, never clear them.

Task 4 owns adaptation of the actual Gauntlet provider fixture in `test/conversation-grading-operator.test.ts` and any other operator-owned submission fixture to Task 2's structured rows and prior-read delivery. Keep persisted result fixtures ordinary. Update turn/usage assertions to cover every read and report response without weakening the existing missing-usage failure case; Task 2 does not edit these shared-mechanics test files concurrently.

```ts
// src/runner/role-usage.ts; price separately through existing Obol integration.
export function verifyReturnedTurns(input: {
  runJsonl: string; usageJsonl: string; model: 'anthropic.claude-sonnet-5';
}): { returnedTurns: number; runEndTurns: number | null };

// E/envelope.ts; finite release policy, not a campaign admission API.
export type ReleaseEnvelope = {
  firstPaidAtMs: number;
  qualificationKnownUsd: number;
  campaigns: ReadonlyMap<string, number>;
};
export type CampaignObservation = {
  campaignId: string; knownUsd: number; pendingAttempts: number;
  settledFault: string | null; ownership: 'safe' | 'unsafe'; terminal: boolean;
};
export function campaignDecision(envelope: ReleaseEnvelope, nowMs: number,
  observation: CampaignObservation):
  { action: 'observe' | 'cancel' | 'done'; reason: string | null; knownUsd: number };
export function qualificationFits(firstPaidAtMs: number, nowMs: number): boolean;
```

- [ ] Add meaningful extraction/coverage tests before moving code. Carry forward the current two-returned-responses/one-sidecar failure. Add driver logs with no `run_end` as a valid shared input, duplicate/skipped response turns, unfinished requests, wrong model, missing/extra raw usage, truncated JSONL and nonfinite/negative counters. Reuse actual logger-shaped events from current tests. On failed coverage retain known priceable bytes as a partial subtotal, never a complete bill.

- [ ] Extract sequential returned-request/response validation from the existing grading `verifyAssessmentUsage` into `verifyReturnedTurns`. Require one raw `obol.usage` row per returned response for the fixed model; finite nonnegative token/cache counters; no unfinished request; validate a `run_end` count if present and forbid later responses. Keep assessment-specific `result.json`/`run_end`/exit checks in its wrapper. For a driver, validate `ConversationRecordSchema`, its real role process record and capture-backed endpoint instead: it has no assessment result or run-end usage total. A role that never started is not missing billed usage; preserve started/interrupted/unknown distinctions. A priceable sidecar alone does not prove coverage.

- [ ] Reuse `invokeGauntletRole` for controlled conversations, initializing the existing `gauntlet-roles.json` record as the conversation runner does. Pass the exact private tmux socket, role deadline and `shouldStop`; connect SIGTERM/lease loss to `stopActiveRole`. One active role per qualification process satisfies its existing invariant. The fixture launcher receives only ordinary PATH/private HOME/TMPDIR, not the evaluator credential. Keep `retainedRoleEnv`'s existing scoped credential/network projection and set the frozen pricing directory before the Bun process starts.

  Verify actual forced cleanup with `test/runner-gauntlet-role.test.ts` and an added harmless controlled-subject case: kill/cancel the outer driver while its private tmux subject has a HUP/TERM-resistant descendant, then prove that owned group/server stops and a separate unrelated private server survives. Do not equate direct-child exit with runtime cleanup or search broadly for processes.

- [ ] Implement the pure cumulative policy and tests. Replace the observed campaign's prior subtotal rather than summing repeated snapshots; preserve prior cohorts and qualification spend. Validate all numbers as finite/nonnegative. Terminal means verified termination, not merely a controller exit, and a terminal fault still blocks later stages.

```ts
export function qualificationFits(firstPaidAtMs: number, nowMs: number): boolean {
  return nowMs + 122_000 <= firstPaidAtMs + 21_600_000 - 60_000;
}
export function campaignDecision(e: ReleaseEnvelope, now: number, o: CampaignObservation) {
  const amounts = [e.qualificationKnownUsd, ...e.campaigns.values(), o.knownUsd];
  if (!amounts.every(n => Number.isFinite(n) && n >= 0)) throw new Error('invalid known subtotal');
  const costs = new Map(e.campaigns);
  costs.set(o.campaignId, Math.max(costs.get(o.campaignId) ?? 0, o.knownUsd));
  const knownUsd = Number((e.qualificationKnownUsd + [...costs.values()].reduce((a, b) => a + b, 0)).toPrecision(15));
  const reason = o.ownership === 'unsafe' ? 'ownership'
    : o.settledFault !== null ? 'settled accounting'
    : knownUsd >= 150 ? 'observed cost'
    : now >= e.firstPaidAtMs + 21_600_000 - 60_000 ? 'cutoff' : null;
  const action: 'done' | 'observe' | 'cancel' = o.terminal ? 'done' : reason === null ? 'observe' : 'cancel';
  return { action, reason, knownUsd };
}
```

```ts
test('pending usage and repeat snapshots are not new spend', () => {
  const e = { firstPaidAtMs: 0, qualificationKnownUsd: 10, campaigns: new Map([['one', 20]]) };
  const o = { campaignId: 'one', knownUsd: 20, pendingAttempts: 4, settledFault: null, ownership: 'safe' as const, terminal: false };
  expect(campaignDecision(e, 30_000, o)).toEqual({ action: 'observe', reason: null, knownUsd: 30 });
  expect(campaignDecision(e, 30_000, { ...o, settledFault: 'missing returned usage' }).action).toBe('cancel');
});
test('a repair preserves the original cutoff and earlier cohort cost', () => {
  const e = { firstPaidAtMs: 0, qualificationKnownUsd: 30, campaigns: new Map([['one', 90]]) };
  const o = { campaignId: 'two', knownUsd: 30, pendingAttempts: 4, settledFault: null, ownership: 'safe' as const, terminal: false };
  expect(campaignDecision(e, 60_000, o).knownUsd).toBe(150);
  expect(campaignDecision(e, 60_000, o).reason).toBe('observed cost');
  expect(campaignDecision(e, 21_540_000, { ...o, knownUsd: 25 }).reason).toBe('cutoff');
  expect(qualificationFits(0, 21_418_000)).toBe(true);
  expect(qualificationFits(0, 21_418_001)).toBe(false);
});
```

- [ ] Implement `E/run.ts` as one finite appliance-owned caller with only `qualify --manifest <path> --role assessment|driver` and `campaign --manifest <path> --campaign-id <id>` modes. Its private manifest binds exact Q/G roots and commits, state root, case root, output root, round 1/2, original release-envelope reference and independently frozen inputs. It contains no arbitrary command field. Each qualification mode runs its whole fixed role set serially, two repetitions in declared case order, using exclusive ordinal launch/settlement receipts. A spawn failure consumes that ordinal and stops; never overwrite/reuse an unsettled launch.

  Use existing durable marker/hash/identity/lease primitives. Freeze the original envelope immediately before the first paid qualification; accumulate consumed counts and known costs through append-only receipts, not resettable candidate defaults. Driver mode uses the real `converse` CLI with `--launcher`, `--workspace`, private `--tmux-socket`, `--out`, `--completion`, `--model agent=anthropic.claude-sonnet-5`, `--max-time 2m`; omit `--startup claude` for the controlled local subject. Assessment mode uses the existing `assess` argv and real rubric/index validation. Do not transplant either old dated operator's fixed case schema or 700-line control loop.

  A valid semantic miss completes the declared diagnostic role set but fails qualification. Stop admission on invalid final result, missing required evidence, settled accounting failure, ownership loss or substantiated expectation defect. The caller cannot approve its own semantic results, choose a repair or automatically progress to the next campaign. Changed role behavior repeats its complete role set; a second candidate consumes the single repair allowance even if numerical capacity remains.

- [ ] Implement the bounded observation child `E/observe.ts`. Use `loadStateConfig`, `resolveCampaignDirectory`, `observeCampaignStatus`, `readCommittedPrefix`, and `readComparisonFromPrefix` with the same committed prefix for stopped-attempt state and accounting. Validate newly settled role evidence through authenticated `readPublishedArtifact`/`readPublishedArtifactBytes` and `verifyReturnedTurns`. Reuse ordinary subject trajectory/economics authority; do not invent per-harness invoice reconstruction. Started but missing/unpriceable settled usage is a fault; active pending usage is not. Emit only identity/status/accounting/fault fields, never grades/transcripts.

  Perform independent status and accounting reads concurrently. Run potentially synchronous artifact work in this child, so its 10-second deadline actually interrupts it. Keep only small receipts of previously verified immutable artifact digests; changed identity is a fault. After each observation wait at most 15 seconds. An independent timer fires at cutoff minus 60 seconds even during a slow read. One cancellation latch handles timer, read failure, observed cost, settled fault, lost ownership and termination signals. It invokes the existing exact-identity `campaign cancel` operation once; the 10-second observation timeout must not kill that cancellation child. Retain its identity until settlement, then verify termination. If it dies unresolved, use existing termination-only reconciliation; never restart the campaign.

  Release the qualification spend lease before ordinary `campaign run`: the campaign owns its own lease. The monitor retains only its private exclusive operation identity and cannot steal or hold the campaign's spending lock. Detach the finite caller on the appliance with its exact command/PID/start identity and private log before paid admission, so SSH disconnect does not own its lifetime. No cron, recurring automation, new service or automatic repair/restart. Missing owner after host loss remains unresolved work requiring existing reconciliation before more spending.

- [ ] Add injected-effect tests using a fake clock and held promises: cutoff while observation is unresolved; observation timeout; timeout and cutoff racing cause exactly one cancellation; cancellation stays owned past 10 seconds; no second canceller while it lives; terminal faults prohibit a next stage; lease handoff occurs before campaign launch; unknown active usage does not stop; newly settled missing usage does; observation outputs expose no grades. Use a real owned subprocess for timeout behavior and the private tmux cleanup test above, not regexes over generated commands.

- [ ] Run `bun run test test/retained-role.test.ts test/role-usage.test.ts test/conversation-routine-use-operator.test.ts test/runner-gauntlet-role.test.ts` through the existing wrapper that allocates a short owned temporary directory. Run the two existing dated operator suites in their required frozen-pricing process environment separately from ordinary runner tests, as specified in Task 6. Review and commit shared extraction and finite caller in coherent commits, retaining the old policies and negative receipts.

## Task 5: Ordinary stock/treatment comparison and readout

**Files:** Create Q `arms/conversation_claude_stock.yaml`, `arms/conversation_codex_stock.yaml`, `arms/conversation_pi_stock.yaml`, `suites/conversation_routine_use.yaml`, `test/conversation-routine-use-suite.test.ts`. Modify `src/appliance/campaign-render.ts`, `test/appliance-campaign-render.test.ts`, `README.md`, `docs/appliance-runbook.md`. Reuse existing treatment arm files unchanged.

**Interfaces:** Consume existing `ArmSchema`, `GraderSchema`, `SuiteSchema`, `checkArmSuiteFiles`, `ReportSchema` and `renderCampaignReport(input: Report): string`. Produce the registered 36-attempt suite and human rendering of existing comparison quantities. Add no report schema or new comparison computation.

- [ ] Write a structured declaration test that parses each stock/treatment arm, removes only `name` and `superpowers`, and asserts the remaining fields equal. Parse the grader separately before the strict suite schema, as registration already does. Assert three comparisons select 4/4/1 scenarios, all use `n: 2`, and the sample count is 36. The test initially fails because the files do not exist.

```ts
const raw = parseYaml(readFileSync(suitePath, 'utf8'));
const { grader, ...suiteFields } = raw;
GraderSchema.parse(grader);
const suite = SuiteSchema.parse(suiteFields);
const attempts = suite.comparisons.reduce((sum, comparison) => {
  if (!Array.isArray(comparison.scenarios) || !('baseline' in comparison)) {
    throw new Error('release requires explicit paired scenarios');
  }
  return sum + comparison.scenarios.length * comparison.n * 2;
}, 0);
expect(attempts).toBe(36);
expect(suite.reserve).toBe(0);
expect(suite.attempt_bounds).toEqual({ max_attempts: 1, max_time_s: 900 });
```

  In this test import `parseYaml` from `yaml`, `readFileSync` from `node:fs`, `GraderSchema` from `src/contracts/campaign/experiment.ts` and `SuiteSchema` from `src/contracts/campaign/suite.ts`; set `suitePath` to the new suite beneath the test's repo root. Also call `checkArmSuiteFiles` using that root's `coding-agents/` and `credentials.yaml`; these reads contain public declarations, not secret values.

- [ ] Create stock arms by copying each existing treatment declaration, changing only its name to the matching `_stock` name and `superpowers` to `none`. Keep high effort for Claude/Codex; do not invent Pi effort. Create this suite:

```yaml
schema_version: 2
name: conversation_routine_use
reserve: 0
max_exposure_skew: 60
attempt_bounds:
  max_attempts: 1
  max_time_s: 900
grader:
  credential: sonnet5_bedrock
  model: anthropic.claude-sonnet-5
pricing_snapshot:
  path: docs/experiments/2026-09-06-pr2258-pricing/current.json
  sha256: 6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b
comparisons:
  - baseline: conversation_claude_stock
    treatment: conversation_claude
    scenarios: [conversation-design, conversation-code-review, conversation-review-feedback, conversation-config-repair]
    n: 2
  - baseline: conversation_codex_stock
    treatment: conversation_codex
    scenarios: [conversation-design, conversation-code-review, conversation-review-feedback, conversation-config-repair]
    n: 2
  - baseline: conversation_pi_stock
    treatment: conversation_pi
    scenarios: [conversation-code-review]
    n: 2
```

- [ ] Extend the existing terminal tests with `mixedComparisonFixture` from `test/fixtures/core-comparison/report-fixture.ts`, folded through `foldComparisonReport` and the existing authenticated envelope fixture. Verify the true display contract with small assertions: explicit baseline `b`/treatment `t1`, paired wall-time `n=2`, baseline 55s, treatment 30s, delta -25s, and subject-cost `n=1`. Keep the original fixture's missing/unusable attempts and all-attempt accounting; do not replace them with a fully successful fixture to simplify rendering. Keep one single-arm regression.

- [ ] Render existing `comparison.roles` and `comparison.paired` beside outcomes, and `report.elapsed` beside total accounting. Iterate quantities already in the report:

```ts
if ('baseline' in comparison.roles) {
  lines.push(`Baseline: ${plain(comparison.roles.baseline)}; treatment: ${plain(comparison.roles.treatment)}`);
  for (const [quantity, value] of Object.entries(comparison.paired)) {
    lines.push(`${quantity}: pairs ${value.n}; baseline ${value.baseline_mean ?? 'unavailable'}; treatment ${value.treatment_mean ?? 'unavailable'}; delta ${value.mean_delta ?? 'unavailable'}`);
  }
}
```

  Preserve escaping, authenticated drilldown validation, criterion evidence and independent checks. Label pass-rate delta as a rate difference; do not call it a percent improvement. Distinguish planned samples, complete determinate pairs, independent quantity coverage and all-attempt spend. State that analytical usability authenticates evidence but does not independently certify semantic grading. Test structured report values and only the small public rendering contracts, not a full output snapshot or generated shell layout.

- [ ] Update the ordinary README/runbook recipe to select this suite at `--global-cap 4`, retain registration's actual `experiment.campaign_id`, and use existing `run`, `status`, `costs`, `report` and printed authenticated `quorum show` targets. Explain stock/treatment meaning and Pi's review-only release scope. Normal usage does not require the release's retained-case operator or a bespoke analysis script.

- [ ] Run `bun test test/conversation-routine-use-suite.test.ts test/appliance-campaign-render.test.ts`, then `bun run quorum check`. Expect declarations to validate, the matrix to contain 36 samples, and paired quantities to match the existing fold. Commit the arms, suite, rendering and recipe together after review.

## Task 6: Integrate and freeze the offline candidate

**Files:** Assembled Q/G sources from Tasks 1–5, the Q actual paired CLI fixture, `E/README.md` and private freeze/test receipts. The coordinator owns integration, resolves shared-file edits and reviews the complete diff.

**Consumes/produces:** Consume the exact task commits and declared interfaces. Produce one immutable candidate manifest with exact Q/G/source/image/model/effort/pricing/input identities, reviewed nine-case atomic gold, six driver controls, fixed suite, budgets and independent review pointers. No provider call is part of freezing it.

- [ ] Inspect both complete diffs against the planning runtime baselines. Require every changed production call site to use the new assessment submission, while persisted results and generic QA stay ordinary. Review oracle independence, stock eligibility, role input separation, cleanup, role accounting and observed-limit semantics together. Fix ordinary integration defects within the tasks' scope; no new design cycle per bug.

- [ ] Run the actual paired CLI integration against the assembled Gauntlet root using a short private tmux directory, with bundled pricing for its old fixture model. Then run the retained operator integrations in a separate process with the fixed snapshot. These environments are intentionally different; do not combine the suites in one Bun process:

```sh
# Q working directory; ROUTINE_G_ROOT is the recorded assembled G checkout.
ROUTINE_TEST_TMP=$(mktemp -d /tmp/rt.XXXXXX)
env -u OBOL_PRICING_DIR GAUNTLET_ROOT="$ROUTINE_G_ROOT" TMPDIR="$ROUTINE_TEST_TMP" \
  bun test test/runner-conversation.test.ts test/runner-conversation-gauntlet-integration.test.ts test/conversation-routine-use-cases.test.ts
GAUNTLET_ROOT="$ROUTINE_G_ROOT" OBOL_PRICING_DIR="$ROUTINE_Q_ROOT/docs/experiments/2026-09-06-pr2258-pricing" \
  bun test test/conversation-reliability-operator.test.ts test/conversation-grading-operator.test.ts test/conversation-routine-use-operator.test.ts
```

  Inspect actual test counts so optional `GAUNTLET_ROOT` cases do not silently skip. Tests must exercise real loopback provider calls and CLI roles without external providers. Verify the forced private-runtime cleanup case, then remove only the owned temporary test directory after its processes are confirmed stopped. Record failed checks as well as successful reruns; do not hide environment failures by changing assertions.

- [ ] Run required repository checks once the assembled pair passes focused checks: Q `bun run check` and `bun run quorum check`; G `bun run check`. Keep external-provider integration opt-ins disabled. If source changes follow a failure, rerun affected checks and any required aggregate gate they invalidate. Do not repeatedly rerun passing checks without a reason.

- [ ] Independently review the complete source pair and exact frozen corpus. Rehash original/staged inputs, confirm exclusion of old gold/reports from model-visible paths, and freeze per-atom expectations and expected driver acts before candidate outputs. Record the original cutoff only when paid admission actually begins later. Preserve source identities and review artifacts in a private release directory; commit code and public experiment declarations. Finish Task 6 with a source/test-qualified candidate, not a claim of live readiness.

## Task 7: Execute the fixed release and deliver eligible results

**Files:** Create `E/results.md` and private immutable launch, cost, audit, source, CI and installation receipts. This entire task is future work: Drew's current instruction expressly forbids executing it.

**Consumes/produces:** Consume the Task 6 reviewed source pair and frozen release inputs. Produce ordinary campaign reports plus independent fixed-gate findings and verified eligible installation, or an honest partial-release record. No custom report product.

- [ ] After a subsequent execution instruction, read the appliance operations/access skills and current runbook, connect through Tailscale, run the installed helper's doctor, and recheck locks, canonical sources and the qualified image. Use frozen candidate source mounts for qualification/campaigns through the current appliance source/configuration mechanism. Preserve the qualified image `sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`; an image/framework/credential-boundary change returns to discussion. Do not run local permissive Coding-Agent sessions or refresh the generic legacy image as incidental work.

- [ ] Allocate the private release root exclusively and freeze its original envelope at first paid qualification admission. Launch the finite `qualify` mode detached on the appliance, first the 18-assessment set, then the 12-driver set if operationally eligible. Continue valid semantic diagnostics; stop on the defined operational/accounting/ownership/expectation faults. Independently inspect every result against frozen atomic/original expectations and rationale, and every driver's complete controlled sequence. Record actual usage/termination and semantic findings separately. No majority vote or favorable repetition selection.

- [ ] If qualification fails semantically and the one repair remains, collect all fixed-set findings, repair once as an integrated candidate, review/retest/refreeze it, and repeat each affected role's complete qualification. Preserve unchanged passing role evidence only when its behavior and dependencies are unchanged. An independently evidenced expectation correction follows the revised spec's version/disposition rules and consumes the same repair/requalification allowance. If it changes the measured question materially, stop for scope discussion.

- [ ] After both roles qualify, register the ordinary suite from the frozen candidate source/configuration using the installed helper. Save the registration JSON and use its actual UUID; never guess from a directory or rerun an ended identity. The helper commands and finite monitoring wrapper are:

```sh
evals-appliance campaign register "$ROUTINE_Q_ROOT/suites/conversation_routine_use.yaml" --global-cap 4 --json
# Save experiment.campaign_id into the private campaign manifest.
bun "$ROUTINE_Q_ROOT/docs/experiments/2026-09-08-conversation-routine-use/run.ts" \
  campaign --manifest "$ROUTINE_RELEASE_MANIFEST" --campaign-id "$ROUTINE_CAMPAIGN_ID"
evals-appliance campaign status "$ROUTINE_CAMPAIGN_ID" --json
evals-appliance campaign costs "$ROUTINE_CAMPAIGN_ID" --json
evals-appliance campaign report "$ROUTINE_CAMPAIGN_ID"
```

  On the appliance, bind `ROUTINE_Q_ROOT`, `ROUTINE_RELEASE_MANIFEST` and `ROUTINE_CAMPAIGN_ID` to the exact frozen remote source/manifest/registration values recorded by the coordinator, not the local planning paths. The wrapper calls ordinary `campaign run` once after lease handoff and observes/cancels it. The laptop may disconnect; the appliance owns completion. It does not request `report` as a polling primitive while behavior is hidden.

- [ ] Audit every fresh attempt in two stages. First save driver-fidelity and expected subject judgments from immutable subject evidence with official grades hidden. Verify actual stock absence/treatment pin and matching non-treatment identities. Then expose the official assessment and judge every material criterion/overall rationale. Completed bad work/refusal can qualify the instrument; coaching, invalid stopping, false judgments or unsupported reasoning cannot. Keep unresolved interpretation unqualified. Preserve original automated results and identify any unsupported pair rather than silently replacing its grade.

- [ ] If the fresh cohort exposes a blocking defect and the shared repair is unused, collect cohort findings and use that one integrated repair. Review/retest/refreeze, rerun full affected role qualifications, register a new identity and rerun the complete 36-attempt matrix. If the repair was already used in qualification, there is no second repair even with money/session capacity left. Maxima remain 36 retained assessments, 24 controlled conversations and 72 fresh attempts, with one original observed clock/cost envelope. On exhaustion or unresolved faults, publish the ordinary available report and an exact partial-release record; do not resume spending automatically.

- [ ] For a qualifying final source pair, integrate to each repository's main following Drew's no-PR instruction, preserve hooks, and verify CI on the exact pushed commits. Update canonical campaign-source installation through the existing locked source-update path and verify exact Q/G/Superpowers revisions, cleanliness, doctor and released mutation locks. Campaign workers use frozen source mounts; do not claim the generic image-baked Gauntlet changed. If merge changes executable behavior beyond the qualified pair, requalification cannot be assumed or purchased outside the remaining allocation.

- [ ] Publish `E/results.md` with original hypotheses/configurations, all attempt/campaign pointers, fixed-gate outcomes, supported stock/treatment quality/time/cost conclusions and limits, negative results, observed budget/cleanup overruns, and exact CI/installation receipts. Use normal report/show output; independent audit is a dated release artifact. Update product status cumulatively: authoring, driver fidelity, assessment, comparison/report, installed acceptance. A supported no-benefit result can complete the release; a merged mechanical fix alone cannot.

## Spec coverage and review checklist

| Requirement | Plan owner |
| --- | --- |
| Natural request/context/endpoint, stock fairness, fresh repair task | 1, 3, 5 |
| Driver context excludes grading, complete control situations | 1, 4, 6, 7 |
| Prior-response evidence exposure and typed assessment repair | 2, 6 |
| Every atomic verdict plus original fold and supported rationale | 3, 7 |
| Independent expectation defect disposition and hidden gold | 3, 6, 7 |
| Existing private runtime cleanup and complete returned-turn coverage | 4, 6 |
| Ordinary paired report and actual stock/treatment configuration | 5, 7 |
| One original observed envelope, appliance ownership and cancellation | 4, 7 |
| Single integrated repair, exact fixed allocations, negative/partial outcomes | 7 |
| Main/CI/canonical source installation and cumulative product status | 6, 7 |

Self-review before handing off: every new interface name above has one owner; no production parser consumes independent expectations; the suite count is 36; the qualification fit reserves the 60-second cancellation margin; repeated snapshots do not reset or double-count costs; model/schema compatibility work is scoped to actual callers. The fixed plan is to be reviewed as a whole before any execution.

## Review and stopping point for this planning request

All task checkboxes remain unchecked. The only current deliverables are the revised spec, this plan and their review disposition. Check in with Drew after committing those documents; do not execute a task, install sources, register a campaign or make provider calls from this planning request.
