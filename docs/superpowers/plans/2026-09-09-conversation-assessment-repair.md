# Conversation assessment repair implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Execute tasks with independent review. Steps use checkbox syntax.

**Execution status (September 9):** Tasks 1 and 2 completed and passed independent
source/input review. Drew approved the concrete new allocation for Task 3. Its
first assessment timed out without an accepted report, so the finite caller
stopped at 1/18; driver 0/12 and fresh comparison 0/36 remain unrun. The live
candidate and overall routine-use milestone are not qualified. See
[results](../../experiments/2026-09-09-conversation-assessment-repair/results.md).
The original and new terminal identities are preserved; no further candidate or
paid retry is authorized by this plan's completed allocation.

**Goal:** Repair the two observed assessment failures and establish what the repaired candidate actually supports before continuing routine-use acceptance.

**Architecture:** Preserve the existing independent assessment loop and typed, read-backed report contract. Give rejected submissions actionable native argument guidance and make the existing observation/basis/limitations contract address unsupported substitutions. Qualify actual behavior against immutable retained evidence; preserve the stopped release.

**Tech Stack:** TypeScript, Bun, existing Anthropic SDK and appliance qualification caller.

**Spec:** `docs/superpowers/specs/2026-09-08-conversation-evals-routine-use-design.md`, with the user's September 9 follow-up instruction to investigate and fix both failures. The original paid operation is stopped and its absolute cutoff has elapsed.

## Global constraints

- Work only in the paired `conversation-routine-use-repair` worktrees, based on quorum `20c67925a06d8428a46006d6e3cc99182a8a5444` and Gauntlet `690432bd295acd199595f875abf9eda25ee06ce0`.
- Preserve all original source freezes, raw results, rubric, mappings and expected judgments. No retroactive promotion, resumed stopped operation, gold rewriting, answer leakage or majority-vote qualification.
- Preserve the existing assessment schema and ordinary persisted result shape, cardinality and prior-request evidence exposure, derived status, role separation, read scope, timeout and returned-turn accounting.
- No XML/prose salvage, hidden retries, increased timeouts, provider/model/credential boundary change, framework replacement or image rebuild.
- Prompt/schema descriptions remain domain independent: no case names, task-watch examples, expected answers, criterion indices or private gold.
- Scripted clients and actual SDK loopback prove the runtime boundary, never semantic accuracy. Actual model qualification plus independent rationale review is required.
- No provider or remote mutation in implementation tasks. A concrete source/data/limit freeze and valid follow-up execution authority precede paid admission. The old six-hour clock is not silently reset.
- Retain negative results and costs at equal billing. Do not call routine use complete unless all original gates are actually met.

### Task 1: Repair assessment report correction and obligation judgment

**Files (Gauntlet):**
- Modify: `src/assessment/report.ts`.
- Modify: `src/assessment/assess.ts`.
- Test: `test/assessment/assess.test.ts`, `test/assessment/report.test.ts`.
- Private investigation record: the current plan workspace, never committed raw provider output.

**Interfaces:**
- Keep `parseAssessmentReport(value, acceptanceCriteria, exposedEvidencePaths)` and `ASSESSMENT_REPORT_TOOL` compatible.
- Add a small assessment-only formatter for rejected report feedback if needed. It consumes the parser's reason and criterion count, returns text, and never interprets or repairs submitted argument strings.
- `runAssessment` continues to deliver rejected calls as failed tool results and accepts only newly submitted valid native arguments.

- [ ] Reproduce the three malformed native responses through the actual installed SDK, using a private replay that only intercepts loopback fetch. Record source hashes, native argument keys, array-in-reasoning character locations, received schema, rejection/error delivery, stop reasons and usage counts. Keep exact private content out of committed fixtures. Demonstrate that the SDK does not drop a valid top-level array: the array was already absent in the returned native input.
- [ ] Add a portable regression before production edits. Feed a small independently written counterpart through the real SDK/assessment loop:

```ts
const malformedArguments = {
  summary: "Submission with misplaced arguments",
  reasoning: 'Analysis.</reasoning>\\n<criteria>[{"verdict":"pass"}]</criteria>\\n</invoke>',
};
```

Use the existing SDK test seam. The next actual request must contain the same rejected input unchanged, a failed tool result with the specific parser reason, the required top-level native argument shape and correct dynamic row count. Parse the shape example as JSON and independently check its types/required fields, without claiming a dummy example is a valid assessment. Then return an independently constructed valid correction with a deliberately different verdict and verify only that correction is persisted, canonical criterion text/status are attached, and all returned usage is accounted. Include a repeated malformed reply (including the observed malformed closing-tag variant), proving neither is salvaged and both feedback events/usage survive. Keep the existing unread-path, same-response read, invalid enum and generic agent tests intact.
- [ ] Run the new focused regression and record its expected RED failure (missing actionable repair guidance), distinguishing the already-correct strict rejection from the missing correction guidance.
- [ ] Implement the smallest assessment-only correction message. Preserve `Error: report_result rejected: <parser reason>`, explain that criteria is a top-level array alongside summary/reasoning, that XML tags or JSON text inside a string do not provide arguments, and that the assessor must resubmit the complete object through the tool. Include one clearly illustrative JSON row using neutral placeholders and all required fields, with the rubric-derived row count stated separately. Do not echo arbitrary malformed content or prefill a real verdict/reference.
- [ ] Keep the tool schema's fields/types intact. Clarify that reasoning is a concise overall synthesis while criterion judgments belong in the native criteria array. Tighten basis/limitations descriptions and the existing system instruction so each judgment preserves the stated obligation, entities, conditions and relationships; an unsupported default or alternate author intention cannot fill a required fact. Decisive contrary evidence must affect the verdict, complete inspected delivery omitting a requirement differs from unavailable evidence, and nonessential uncertainty or an explicitly permitted unresolved choice need not defeat pass. Each criterion remains independent. Avoid reintroducing only the broad clause-checking reminders already disproved by the September 8 grading experiment.
- [ ] Run focused assessment/model tests, then the normal Gauntlet aggregate once after changes. Install `ui` dependencies with the frozen lockfile if required. Record observed counts and any pre-existing limitations. No semantic pass claim from these tests.
- [ ] Self-review, commit scoped Gauntlet changes and report RED/GREEN commands/results, private replay evidence and unresolved live hypothesis. Controller dispatches independent task review.

### Task 2: Freeze meaningful repair qualification and record the investigation

**Files (quorum):**
- Create: `docs/experiments/2026-09-09-conversation-assessment-repair/README.md`.
- Create: `docs/experiments/2026-09-09-conversation-assessment-repair/results.md`.
- Private artifacts: current plan workspace and a fresh results identity.

**Interfaces:**
- Consume the exact reviewed Task 1 Gauntlet revision; existing `2026-09-08-conversation-routine-use` case loader, read scope and assessment qualification mechanisms remain production authority.
- Reuse the frozen nine-case corpus and expectations at their recorded hashes. Distinguish development cases from independently authored generalization controls.

- [ ] Publish a concise source-based diagnosis: ordinal 01 fully saw the decisive evidence but substituted an unstated default; ordinal 03 returned all judgments inside a reasoning string on three attempts, received correct errors and timed out. Record original 20 returned turns, USD 0.5339251 known, and one unfinished request of unknown invoice cost. Cite the private authenticated receipts by hash/path without publishing raw transcripts.
- [ ] Record competing hypotheses and the historical failed broad semantic prompt. Explain precisely what Task 1 tests prove and what remains to be measured.
- [ ] Freeze an independent small set of generalization controls before inspecting candidate outputs. Cover equivalent already-supplied requirements, omitted obligations in a complete artifact, partial/unavailable evidence, explicitly permitted choices, independent clarification/delivery judgments, qualified versus unsupported categorical claims, and chronology. Each control must have self-contained primary evidence, exact rubric, expected per-criterion judgment and material rationale. Authoring/review is independent of the runtime prompt; no answers enter runtime inputs.
- [ ] Prepare the concrete follow-up source/data identity and bounded execution proposal using the existing appliance runner, original model/credentials/image and full unchanged nine-case qualification. Reconcile the expired original clock with explicit follow-up execution authority before any paid call; never mutate the stopped envelope. Do not add a new general operator/recovery service.
- [ ] Review the source/data freeze independently. Commit only public methodology/results/status prose and the plan; private retained evidence stays ignored. Continue to actual qualified execution when authorized; if a genuinely new allocation requires approval, the tested source pair, frozen data and exact proposal must already be reviewable.

### Task 3: Verify actual behavior and finish the authorized release scope

**Files:** fresh private qualification/result records; the new dated results document; ordinary campaign/acceptance records if all preceding gates pass.

**Interfaces:** reviewed source pair and frozen controls from Tasks 1–2; existing finite appliance execution and accounting.

- [ ] Run only within explicit follow-up authority, with the original stopped identity preserved. Use actual model sessions, all declared repetitions, full rationale/atom/original-fold review and accounting for all returned turns.
- [ ] Retain the eight independently frozen additional controls as offline diagnostic coverage. They have not tested candidate behavior. The live proposal uses the original fixed18assessment gate, including its existing controls, through the unchanged finite caller. Do not introduce a bespoke extra-control operator or claim live generalization from the eight new files.
- [ ] If assessment qualifies, continue the original uncompleted driver qualification and fresh comparison gates within authorized limits. Every new candidate identity requires the applicable full gate, never replacement of unfavorable samples.
- [ ] Preserve and report any negative result at the allocation boundary. No further repair rounds or renewed clocks are implicit. Source correctness and evidence honesty remain necessary even if semantic reliability is unqualified.
- [ ] Run appropriate fresh verification on the final source changes, get whole-branch independent review and report exact revisions, tests, live outcomes, costs/coverage and remaining integration/installation state. Complete the routine-use milestone only when its original definition of done is satisfied.
