# Conversation code-review smoke — 2026-09-10

**Status:** Executed once and read out. Campaign `688fccf6-5d44-43bc-9dfd-c9ac5624439c`, sealed 2026-09-10 17:30Z, complete with termination verified. Stage two is **not** run: the judge stop rule fired.
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

Registered from evals `1139abd8`, gauntlet `89df1f7`, superpowers `b36e0829`
(v6.3.0) for treatment and `none` for stock; prepared and run through the
installed appliance helper over Tailscale SSH. Elapsed 772 seconds. Known cost
**$8.38** (subject $4.10, grader $4.28), 12 of 12 attempts observed and
complete. Attempt run ids are `conversation-code-review-<agent>-<credential>-linux-20260910T17*`
under the appliance results root; the sealed comparison report and cost readout
are published under the campaign directory.

### Platform: pass

All twelve conversations completed at the delivery endpoint. Every attempt
captured a trajectory, priced its subject above zero (Pi: $0.06 to $0.63),
recorded both Gauntlet roles with completion digests, and published. The
campaign sealed with `complete: true`, `behavior_available: true`, and
`termination_verified: true`. No setup, capture, or publication failure. This
is the first live pass through the 2026-09-10 main.

### Judge, mechanical: still failing

| Attempt | Report submissions | Valid on | Outcome |
|---|---:|---|---|
| claude_stock r1 | 5 | never | timed out, indeterminate |
| claude r1 | 3 | never | timed out, indeterminate |
| claude_stock r2 | 1 | 1st | accepted |
| claude r2 | 4 | never | timed out, indeterminate |
| codex_stock r1 | 5 | 5th | accepted |
| codex r1 | 4 | 4th | accepted |
| codex_stock r2 | 1 | 1st | accepted |
| codex r2 | 1 | 1st | accepted |
| pi_stock r1 | 1 | 1st | accepted |
| pi r1 | 1 | 1st | accepted |
| pi_stock r2 | 1 | 1st | accepted |
| pi r2 | 4 | never | timed out, indeterminate |

31 submissions for 12 assessments: 8 valid, 23 rejected. First submission
valid in 6 of 12. Accepted after retries in 2 of 12. Never accepted within the
120-second work deadline (`src/runner/conversation.ts`, `deadlineMs`) in
**4 of 12**, which compose `indeterminate`. The stop rule (two or more) fired.

**Shape of every rejection.** 22 of the 23 rejected submissions carried
`summary` and `reasoning` and no `criteria`; one carried only `summary`. The
`reasoning` strings ran 4,300 to 7,500 characters and ended in
`</parameter> </invoke>` or `</criteria>`: the model wrote the criteria array as
well-formed JSON rows wrapped in Claude's XML function-call markup
(`<parameter name="criteria">[ ... ]</parameter>`) inside the reasoning string,
instead of as the native `criteria` argument. Accepted submissions had
`reasoning` of 294 to 1,544 characters and a native array. Not truncation:
every report turn stopped on `tool_use`, at 1,068 to 4,822 output tokens.

**What the harness already does.** The tool schema requires `criteria` and its
description says "Pass as a native array here, not as JSON text or tags inside
reasoning." Each rejection returned "criteria: expected array, got undefined.
criteria must be a top-level array alongside summary and reasoning. XML tags or
JSON text inside a string do not provide tool arguments. Your resubmission must
contain exactly 6 criteria rows." The model repeated the same shape three to
four times against that feedback. Each rejected attempt cost 20 to 45 seconds
of generation, so the 120-second deadline admits at most three or four tries.

**Not explained by transcript size.** Both timed-out and first-try-accepted
assessments occur at 137k subject tokens (the two Claude stock replicates); the
failure is stochastic with a bias toward long reasoning, not determined by
input length. Grader: `anthropic.claude-sonnet-5` via Bedrock.

### Judge, semantic: 48 of 48 agree

For every accepted assessment I read the delivered review against the
planted `src/db.js` (SQL concatenation at line 7 with `password_hash` added to
the exported lookup, validation removed at lines 5 to 8, identity `hash` at
line 20, `password_hash` logged at line 14 and returned at line 15, and an
import of a `./database-driver.js` absent from the repo). All eight reviews
identified the query defect with its mechanism, labeled it Critical or P1,
identified at least one credential defect with consequence, withheld merge
approval in a delivered review, justified it with the required findings, and
made no materially unsupported claim: the extra findings (removed validation,
hash returned to callers, missing driver module, no tests) are true of the
fixture, and the one speculative point (`db.query` return shape) was framed as
conditional with a request to confirm. Every assessor verdict, observation, and
basis matches. No false pass and no false fail among accepted reports.

Limits: every accepted report was pass on all six criteria, because all three
harnesses handle this scenario well; the sample cannot test the assessor's
fail-side discrimination. The four rejected assessments' embedded rows were
also all pass, so their loss is a format failure, not a judgment failure.

### Behavior

Not interpretable at n=2 and with 3 of 4 Claude cells indeterminate. Codex 4 of
4 pass, Pi 3 of 4 pass with 1 indeterminate, Claude 1 of 4 pass with 3
indeterminate. Nothing here separates treatment from stock.

## Next

1. Fix the report shape at the source, in Gauntlet's assessment role, before
   any further spend on conversation suites. Two candidates, cheapest first:
   a tolerant repair that lifts a well-formed criteria array out of the XML
   wrapper inside `reasoning` and records that it did so; or shortening the
   accepted `reasoning` so the model has nowhere to put the array but the
   native argument. Verify against the 23 retained rejected submissions from
   this campaign before any live run.
2. A/B the grader credential (`sonnet5` direct versus `sonnet5_bedrock`) on
   this same suite only if the source fix does not reach first-submission
   validity above 90 percent on the retained submissions.
3. Stage two (the full 36-attempt routine-use suite) only after 1.

### Follow-up: offline repair check

Gauntlet's criteria repair
(`docs/superpowers/specs/2026-09-10-assessment-report-criteria-repair-design.md`
in the gauntlet repo) was run against this campaign's 23 rejected submissions
with each submission's exposed evidence paths reconstructed from its event
stream: 22 of 23 now parse as valid reports; 1 remains rejected (`criteria:
expected array, got undefined`, the summary-only submission). The submissions
stay private; the check is reproducible from the retained run streams.
