# Conversation breadth and concurrency proof

Status: declared before launch. Drew authorized preparing and merging the
paired implementation, updating the canonical appliance, and running a broad
set of tasks. Drew explicitly requested direct main merges without PRs.

## Questions

Can the same conversation-to-assessment engine produce useful, standardized
evidence across different kinds of work? Does increasing its worker cap from
one to four improve end-to-end throughput on an otherwise fixed cohort?

The first question is a breadth diagnostic. The second is a separate, small
concurrency comparison. Neither proves sustained capacity or general grader
reliability. Legacy QA gives its driver the grading criteria; conversation mode
separates the user brief and fresh assessment. Comparing those two modes would
change the measurement method along with execution, so this experiment makes
no old/new scheduler-only speedup claim.

## Frozen run plan

Use the ordinary canonical appliance helper, exact merged Q/G snapshots, and
the same image for all three campaigns. Keep Superpowers pinned to
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`, as in the preceding live pilots.
Use existing arms `conversation_claude` (Opus 5 through Bedrock/Mantle, high)
and `conversation_codex` (Sol through Responses, high), plus Sonnet 5 for the
simulated user and assessor. The suite freezes the existing pricing artifact.

| Campaign | Suite | Explicit global cap | Fresh attempts |
| --- | --- | --- | --- |
| Breadth | conversation_broad_signal | 4 | 6 scenarios × 2 harness/model routes × 1 = 12 |
| Serial cohort | conversation_parallel | 1 | pricing × 2 routes × 2 = 4 |
| Parallel cohort | conversation_parallel | 4 | the identical four-cell definition = 4 |

Run these campaigns sequentially. Register each as a fresh identity. The
existing single-arm entries support both cap 1 and cap 4; do not introduce a
paired atomic block that requires two simultaneous slots. Do not rebuild or
retag the image between campaigns. Record source and image identities from the
actual registration/attempt receipts.

The total is **20 attempts**, with no retries or replacement attempts. Each
conversation is bounded to ten minutes and each attempt to 900 seconds.
Observe a $60 operator stopping allocation across the three campaigns, and
do not launch a following campaign if known cost reaches it. Inspect active
cost coverage while running; terminate on an uncontrolled instrumentation
failure rather than buying replacement results. This allocation is not a hard
provider billing cap: unfinished usage remains unknown until capture and
publication, and in-flight requests can exceed an observed threshold.

## Task coverage

| Scenario | Signal and retained output |
| --- | --- |
| conversation-pricing | Implement a pricing repair; independent JS behavior oracle |
| conversation-code-review | Deliver a grounded static review; preserved review target and transcript |
| conversation-design | Clarify and propose notifications before implementation; proposal and preserved page |
| conversation-debugging | Diagnose character loss and repair chunking; independent Python behavior oracle |
| conversation-review-feedback | Fix valid feedback and explain rejecting incorrect/speculative suggestions; limiter output and transcript |
| conversation-verification | Check a false completion claim, disclose the discrepancy, and finish the work; slugify output and transcript |

The variants reuse existing fixtures and helpers. User briefs allow natural
clarification and stop at delivery or refusal, independently of quality.
Acceptance criteria remain private. Post-checks evaluate retained source;
editable subject tests, `.venv`, and `.git` are not independent output oracles.
Verification/commit ordering is assessed from actual calls, results, and
delivered claims rather than requiring a particular harness tool name.

## Readout and interpretation

Retain the ordinary campaign JSON/Markdown reports and per-attempt verdicts,
conversations, criterion results, deterministic checks, transcripts, and role
usage. Record negative outcomes alongside passes. Count completed bad work or
refusals as completed conversations; separate behavior failures from missing
evidence, assessment failures, and instrument failures.

For breadth, report all 12 cells, missingness and cost coverage, then inspect a
small set of representative delivered outputs and every non-pass. This is one
attempt per route/task, not a reliable pass-rate estimate or pure single-model
comparison: subject-chosen subagents remain part of the harness experience and
must retain their own model/cost attribution.

For the dedicated cohort, measure campaign wall time through assessment and
publication drain; completed conversations/hour; assessable reports/hour;
failures, throttling, and cost coverage. Compare the two fresh cohorts only.
The mixed breadth campaign and previous pilots do not substitute for a serial
baseline. Record cold-start/order effects and the small sample size; do not
turn observed overlap into an unmeasured speedup or sustained-capacity claim.

## Results

Pending canonical installation and the declared campaigns.
