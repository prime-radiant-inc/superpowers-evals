# Conversation assessment grading contract

Date: 2026-09-08 Pacific
Status: design accepted for implementation planning after the
[staff whiteboard review](../../experiments/2026-09-08-conversation-grading-whiteboard.md).
Writing the plan does not launch the proposed provider allocation or reopen a
closed experiment.

## Goal and evidence

Make the assessment's overall judgment follow its criterion judgments, then
test the existing clause-level grading treatment on five retained conversations.
Keep the current conversation engine, scenario format, appliance ownership and
standard reports.

The starting sources are Quorum `6dc628490c8e6cd563404bbeddce5b0b53274101`
and Gauntlet `f5d66447ce4234fd5c0901fad372935332003491`. Their startup and Pi
evidence changes passed the [three live engine gates](../../experiments/2026-09-08-conversation-startup-evidence/live-results.md).
That establishes usable evidence for the declared cells, not grading accuracy.

The [closed reliability experiment](../../experiments/2026-09-08-conversation-reliability/results.md)
identified two distinct grading defects:

- The held assessor produced a valid review assessment with criteria
  `pass/pass/pass/fail` and overall `investigate`. Independent adjudication
  accepted its alternative grounding rationale. The contradictory overall
  judgment was the failure.
- Two completed design conversations received `pass/pass/pass` despite settled
  independent judgments of `fail/fail/pass`. The assessor treated choosing a
  task-list scope as choosing which tasks to watch, and generic completion
  alerts as selective watched-task behavior. Changing the overall reducer
  cannot correct those criterion judgments.

The existing held treatment already asks for evidence for every material clause
and inspection of contradictory evidence. Its design-case behavior was never
tested because the first retained call stopped. We should evaluate that one
treatment before inventing another prompt or grading subsystem.

## Approach

Three approaches were considered:

1. Keep asking the assessor for an overall status and reject contradictions.
   This retains redundant model work and spends turns repairing an answer
   that code can derive.
2. Give conversation assessment its own reporting-tool contract and derive
   status from validated criterion rows. This is the recommended approach.
   It changes the model-facing assessment boundary while preserving the
   existing persisted report shape.
3. Change the generic Gauntlet QA validator or add more grading agents.
   Generic QA deliberately permits findings outside the listed criteria;
   multiple judges introduce cost and coordination without resolving the
   demonstrated contract defect. Neither belongs in this increment.

The rubric defines what the conversation assessment grades. Observations and
narrative do not independently override the rubric's criterion outcomes.
A requirement that should affect the grade must be represented in the rubric.
Quorum's deterministic checks and execution-error handling remain separate.

## Assessment result contract

Only `gauntlet assess` changes its `report_result` tool. Generic Gauntlet QA
keeps its current tool and validator behavior.

The assessor supplies required `summary` and `reasoning` strings, plus a required
`criteria` array with one ordered row per rubric criterion containing `verdict`
and `evidence`. `observations` retains its existing content validation and is
optional, defaulting to an empty array when omitted.
It does not supply an overall `status` or restate the criterion as a substitute
requirement. The assessment code attaches each original rubric criterion to
its row when constructing the existing result document.

Use the existing criterion vocabulary: `pass`, `fail`, `unclear`. Validate a
nonempty rubric, an actual `criteria` array of object rows, exact row count,
valid verdict values and nonempty evidence. Reject string-encoded criteria,
top-level `status`, row-level `criterion`, missing rows and malformed rows
through the existing typed tool-error path. Keep the existing
deadline and repair loop; do not add whole-assessment retries. An empty rubric
is an input error before the first model request, never an automatic pass.

After validation, code derives the persisted assessment status:

| Criterion judgments | Assessment status |
| --- | --- |
| At least one `fail`, including a mixture with `unclear` | `fail` |
| Every criterion is `pass` | `pass` |
| Otherwise: at least one `unclear`, no `fail` | `investigate` |

The standard result still contains `status`, `summary`, `reasoning`,
`observations` and `criteria`. Preserve its writer, log, usage and evidence
references. No result-schema migration or new compatibility path is needed.
Historical results retain their original bytes and judgments.

The existing assessment exit convention stays: pass is exit 0; fail and
investigate are exit 1. A completed uncertain assessment with valid criterion
rows remains an assessment outcome, with no invented execution error. A crash,
timeout, cancellation or failure to produce a valid complete report remains
distinguishable through existing role records, missing/invalid criteria and
Quorum's error fields. Preserve all available evidence and usage in either case.

Quorum's conversation consumer validates the criterion vocabulary and nonempty
evidence, derives the expected status with the same precedence, and rejects any
unequal stored status without rewriting the received report. Extend its existing
guard only as needed.
Preserve current deterministic-check, error and final-verdict precedence,
including the existing handling of an uncertain assessment with a failed
post-check. This proposal does not redefine overall campaign validity.

## One semantic treatment

Use the held reliability candidate's general instructions about checking every
material clause, inspecting the delivered response and contradictory evidence,
distinguishing an observed unmet obligation from insufficient evidence, and
keeping verification claims tied to their actual scope and chronology.
Start from current main and select that assessor-only instruction delta;
do not merge a held branch wholesale. Update its tool-call wording to the new
assessment contract and freeze the exact resulting prompt before execution.

Keep using the existing criterion `evidence` string. Require support for each
material obligation before awarding that criterion a pass. Do not add a new
structured citation format, rubric-rewriting stage, second judge, per-criterion
model calls, scenario-specific answer hints or another candidate during the run.

For evaluation, distinguish evidence for the required relationship from
evidence for adjacent behavior. A real watch choice may be expressed in many
ways; no particular field name, UI control, prose or template is required.
The positive case explicitly states unresolved assumptions, which its rubric
permits. The gate must accept those rather than impose unrequested design rules.

## Retained acceptance set

Use these five full-evidence conversations and their already-adjudicated
expectations. The two new design cases use their exact retained private rubric,
not a newly projected or edited scenario. Both known review cases use the settled
[clarified review rubric](../../experiments/2026-09-08-conversation-release/controls/rubrics/code-review-revised.md),
whose criterion 3 separates the supported merge recommendation from unsupported
additional findings. Do not substitute that package's original rubric, which
belongs to the preserved historical disagreement. Freeze the clarified rubric's
exact bytes in the execution manifest. Each row below gets one fresh assessment
in the listed order; inspect each result before starting the next assessment.
The positive review protects against penalizing conditional risks and accurately
scoped verification that the rubric permits.

| Order | Retained case | Required criterion vector | Required overall |
| --- | --- | --- | --- |
| 1 | `conversation-design-claude-opus5_bedrock-linux-20260908T195051Z-874b` | fail/fail/pass | fail |
| 2 | `known-claude-design`: `conversation-design-claude-opus5_bedrock-linux-20260908T055800Z-5f07` | pass/pass/pass | pass |
| 3 | `known-codex-review`: `conversation-code-review-codex-openai_responses_56sol-linux-20260908T060413Z-d5ed` | pass/pass/pass/pass | pass |
| 4 | `conversation-design-codex-openai_responses_56sol-linux-20260908T195053Z-0d17` | fail/fail/pass | fail |
| 5 | `known-claude-review`: `conversation-code-review-claude-opus5_bedrock-linux-20260908T055758Z-190d` | pass/pass/pass/fail | fail |

The review and positive-design expectations are recorded in
[the frozen release judgments](../../experiments/2026-09-08-conversation-release/expected.json).
The two later design judgments and alternative review rationale are documented
in the reliability experiment and its private `driver-grader-adjudication.md`
and `retained-candidate-adjudication.md` receipts. Those judgments are settled;
do not change gold to fit a candidate response.

All five evidence packages are locally available. Earlier known packages are
under the `conversation-assessment` worktree's private
`results/conversation-release/known/`; the later designs are under the
`conversation-reliability` worktree's private
`results/conversation-reliability/driver-final-evidence/results/`.
Prepare a dated manifest identifying exact evidence/index/rubric/judgment bytes
and source hashes before execution. Verify the existing evidence against its
retained authentication records. Keep gold judgments and old assessor results
out of the new assessor's input.

The case judgments and materially decisive reasoning must agree in all five
rows. Accept independently supported alternative evidence and wording; do not
require an identical rationale. Record minor citation imprecision separately
when the decisive facts remain supported. A material unsupported claim or an
incorrect criterion permanently fails prompt promotion even if the derived
overall happens to match. Complete the remaining fixed cases for diagnosis,
subject to the operational stopping rules below.

## Validation and proposed execution limits

First prove the mechanical contract offline:

- Reducer cases cover all pass → pass, pass/fail → fail, pass/unclear →
  investigate, unclear alone → investigate, and fail/unclear → fail.
  Replay the retained contradictory report's criterion vector without altering
  the original artifact. Empty rubrics fail before any provider request.
- Exercise the actual assessment loop with a scripted provider: canonical
  rubric labels, rejection and typed repair of missing, short, extra,
  forbidden-field and malformed submissions, and no further model call after a
  valid result. Persisted JSON/Markdown status and process exit must reflect the
  derived result.
- Exercise Quorum's real assessment boundary for pass, fail, completed unclear,
  malformed report and timeout. Explicitly reject pass/pass/pass/fail with
  stored investigate. Check role/accounting/evidence preservation and preserve
  final indeterminate for completed unclear with a failed post-check. Retain a
  regression showing generic QA still permits its independently authored
  overall status under its existing policy.
- Run the existing paired CLI suite explicitly with `GAUNTLET_ROOT` pointing at
  the assembled candidate; it otherwise skips. Exercise the outer child deadline
  as well as the assessor's internal timeout fallback.
- Run the affected tests, required repository checks and independent source
  review. Existing baseline receipts are not new candidate verification.

The proposed new live allocation is **$4 total observed spend**, **five
assessment calls maximum**, **45 minutes from the first launch**, concurrency
one and 120 seconds per assessment. There are no new Coding-Agent conversations,
replacements, second candidates or transfers from previous allocations.
These are operator stopping limits, not hard provider billing caps.

Use `sonnet5_bedrock` / `anthropic.claude-sonnet-5` and the existing frozen
2026-09-06 pricing snapshot, SHA-256
`6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
Freeze clean candidate sources, exact inputs, model, pricing, case order and
absolute cutoff before the first request. Use a short dated entrypoint that runs
one declared assessment through existing child, credential, lease, timeout,
cleanup and pricing helpers. The appliance owns each bounded child while the
coordinator polls and reviews the completed result before requesting the next
declared row. Keep one fixed five-row allocation record and cutoff. This does
not require another permission from Drew between rows. The closed reliability
stage operator hardcodes different cases and limits; do not clone it or claim
case declarations alone can reuse it unchanged. Do not create a production
replay CLI or a new scheduler. A closed experiment identity remains closed.

Before declaring accounting complete, verify usage covers every returned
provider turn and all retained usage is priced. A repriceable partial sidecar
does not establish complete accounting; interrupted or uncovered usage remains
unknown. Prove that narrow coverage check with behavioral tests. Authenticate
the later designs against their campaign report and retained inventory as well
as checking the earlier known packages against their release corpus records.

Stop before another call at an invalid or incomplete assessment,
missing/unpriced settled usage, source/input
mismatch, ownership loss, cancellation, observed allocation limit or insufficient
remaining time for a bounded child and cleanup. Preserve the failure and stop;
do not edit the prompt or rubric and continue. Also stop on a newly substantiated
independent disagreement about the gold judgment. A candidate's valid semantic
mismatch alone does not reopen settled gold: it permanently fails promotion,
but the remaining predeclared cases continue solely for diagnosis. Normal
repair within the same bounded assessment is not a replacement call.

## Completion and promotion

Keep the mechanical contract and semantic instructions in independently
reviewable changes. The contract can qualify on offline behavioral proof and
source review; semantic instruction promotion additionally requires all five
retained assessments to pass this gate. A semantic failure does not invalidate a
correct deterministic reducer, and it does not authorize a new treatment.

Report execution, per-criterion judgments, derived overall and accounting
separately using the standard assessment artifacts plus a short dated experiment
record. This candidate-only acceptance exercise provides bounded known-case
evidence. One assessment per case does not establish repeatability. It is not a
fresh baseline comparison, population error-rate estimate or proof of general
grader reliability; debugging/test-history grading remains outside this gate.

After approval and the applicable gates, integrate eligible changes directly to
main and verify canonical installation separately. Preserve original evidence,
held driver changes and any failed semantic candidate. Broader harness coverage,
parallel capacity, feedback-driver endpoint policy and QA scenario migration
remain separate work.
