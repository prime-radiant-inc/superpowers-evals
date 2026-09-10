# Conversation code-review smoke — 2026-09-10

**Status:** Declared. Not yet registered or run.
**Suite:** `suites/conversation_code_review_smoke.yaml` (12 attempts).
**Purpose:** First live pass through main after the 2026-09-10 consolidation
(#50, #51, #52), and the first measurement of Gauntlet assessor reliability
since the completion contract and malformed-call correction landed.

## Questions

1. **Platform.** Do all twelve attempts complete through `evals-appliance
   campaign` on main: conversation role, capture, assessment role, completion
   record, publication, seal? Is every Pi attempt priced above zero?
2. **Judge, mechanical.** Per assessment: was the first submitted report
   accepted, how many physical requests were needed, and for every rejection,
   what did the model actually emit?
3. **Judge, semantic.** Per assessment and per criterion, does an independent
   reading of the retained transcript agree with the assessor's verdict?

The treatment-versus-stock effect on code review is recorded but is not a
question this run can answer at n=2; it seeds the full routine-use suite.

## Frozen configuration

One scenario, `conversation-code-review`, on the committed arms:
Claude (`opus5_bedrock`, effort high), Codex (`openai_responses_56sol`, effort
high), Pi (`pi_gpt56_sol`); treatment pins superpowers
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`, stock is `superpowers: none`.
Grader `sonnet5_bedrock` / `anthropic.claude-sonnet-5`. Two repetitions per
arm, one attempt each, 900-second bound, no reserve, global cap four. Evals
source is whatever main resolves to at registration; the campaign report
records the exact commit. Expected cost about $25 (six assessments at roughly
$0.20 each; six conversations per harness pair at roughly $1 to $3).

## Readout method

- Platform: the campaign report and each attempt's `verdict.json`,
  `assessment-completion.json`, and `coding-agent-token-usage.json`.
- Judge, mechanical: `assessment-attempts.jsonl` and the Gauntlet event stream
  (`run.jsonl`) for each assessment role; rejected submissions are quoted in
  this record with provider content redacted to structure only.
- Judge, semantic: the operator reads each retained conversation transcript and
  the assessor's `result.md`, and records agree / disagree per criterion with
  the transcript line that decides it. Twelve assessments, six criteria each.

## Stop rules

Any attempt that fails at setup, capture, or publication stops the campaign
readout at the platform question; the defect is fixed on main before any
further spend. If two or more of the twelve assessments end without an
accepted report, the judge question is answered "still failing" and the next
step is root cause from the retained model output, not the full suite.

## Result

_Pending._
