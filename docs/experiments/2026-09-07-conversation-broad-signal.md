# Conversation breadth and concurrency proof

Status: initial wave aborted for instrument defects; repairs and a fresh wave
are in progress. Drew authorized preparing and merging the
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

### Initial breadth wave: aborted

Campaign `5e3f46dc-502a-4796-a98a-b7d5f09e828e` froze Quorum
`8aefc97320816149c041fd85c069deb50f0e98ce`, Gauntlet
`74d2037aed14f413db482b7635783e4e0498c316`, the declared Superpowers ref,
and image `sha256:4a47a6daafc7bb73271b0bb6b6ef41fb0c6ba272012209bd32b352d6c8e931bb`.
Canonical prepare job `job-20260908T053509Z-de37` passed.

Nine of twelve attempts were prepared before cancellation. Python setup failed
because the generated `/etc/passwd` home contained the colons in an attempt ID.
Setup intentionally strips HOME/XDG variables; uv used the malformed passwd
entry and tried to create its cache under the unwritable `attempts/c1` prefix.
This was a container identity projection defect, not a Python scenario failure.

The Claude review driver sent repeated Enter against a stale security-notes
screen. The next Enter selected the permissions screen's default **No, exit**.
It then called this a refusal despite never submitting the task. A successful
prior pilot used the same Claude 2.1.209 and launcher: it waited for the changed
screen and selected **Yes, I accept**. This is a driver navigation and outcome
classification failure, not established evidence of a Claude crash or CLI
regression. The strict native-capture requirement kept it from becoming a
behavioral pass.

Codex produced retained review and design outputs, but the cancelled campaign
has no usable selected outcomes. Do not count these as a completed breadth
comparison. The standard report is cancelled, incomplete, and termination
verified. It records $0.8119028 known cost with incomplete coverage across nine
attempts; missing and unpublished usage is not zero. Cancellation verified the
controller was dead, then had to wait for the existing 150-second stale-lock
threshold before it could finish reconciling workers. No locks were manually
deleted. No attempt containers remained running afterward.

The immutable report snapshot and original artifacts remain under
`/srv/quorum/superpowers-evals/campaigns/5e3f46dc-502a-4796-a98a-b7d5f09e828e-conversation_broad_signal/`.
Local helper receipts are in the ignored
`results/conversation-broad-signal/breadth-*.json` files. The report returned at
`2026-09-08T05:40:20.146344Z`; campaign elapsed was 244.935 seconds, including
the cancellation interval, so it is not a useful throughput baseline.

### Repair and fresh sequence

Keep the aborted wave intact. Repair the passwd home with a colon-free
in-container alias to the same private home; retain the existing launcher and
capture paths. Clarify startup navigation and provide an explicit conversation
error outcome instead of forcing a launch failure into delivery or refusal.
Verify both fixes before registering fresh identities for the same 12 + 4 + 4
sequence. These are new runs after instrument repair, not replacements hidden
inside the cancelled campaign. Report the nine initial attempts separately
from the twenty planned fresh attempts. The original $60 operator allocation
includes both waves. Do not count the aborted wave toward either concurrency
cohort or revise its original results.

Fresh campaign identities and results are pending.

Repair verification: the real offline Linux probe ran as UID/GID 1001 with
HOME/XDG absent, no network, no credentials, and a read-only rootfs. The old
passwd layout selected the truncated cache path and uv venv exited 2 (EROFS,
not the original campaign's EACCES). The fixed alias returned the valid home,
created a venv successfully, and shared the intended private-home inode. Both
probe containers and temporary fixtures were removed.

Quorum's full check passed 3,698 core tests with 14 environment skips and 144
dashboard tests; scenario validation passed. Gauntlet's runtime change passed
1,348 tests with two provider integration skips. Final prompt-only corrections
and removal of wording assertions were followed by 17 passing conversation
tests and a clean typecheck. The operative startup instruction is in Gauntlet's
conversation prompt; Quorum's HOWTO is also corrected but is not supplied to
the conversation role.
