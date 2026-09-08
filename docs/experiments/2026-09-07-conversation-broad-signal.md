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

Fresh breadth results and the audit are recorded below. The serial and parallel
cohorts are still in progress.

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

One local paired integration rerun timed out in its fourth case and failed the
following case. An unchanged isolated rerun passed, then all five paired cases
passed against integrated Gauntlet `e5d2efeeeed7e78e01e8e14bc35be159b49cc17e`
in 14.47 seconds. The original timeout remains unexplained; no timeout or code
change was made to make that check pass. This is retained as a local test
reliability limitation, not attributed to host load without evidence.

### Fresh breadth: complete execution, two false passes

Campaign `f4f42c37-3a00-4c1d-b5df-e76766a568fc` completed all twelve attempts
with authenticated publications, completed delivery records, native coding
transcripts, independent checks, and fresh assessments. The standard report is
complete and termination verified. All twelve published grades are **pass**.
Elapsed time was 847.058 seconds (14m 7s), from
`2026-09-08T05:57:57.101Z` through `2026-09-08T06:12:04.159Z`.

The frozen source pair is Quorum
`7def77c1a41e46c511fe9bee0f4dd9742f479a55` and Gauntlet
`6dac4bfcb16042cb277067bb4535f9f22b9bb5df`, with the declared Superpowers ref.
The authenticated journal confirms all twelve attempts used image
`sha256:2ee3e07dff9f2bb98d2e427da98ec73ab6efc077f4561f516b0a6130d0478d4e`.
Final prepare job was `job-20260908T055638Z-37ae`.

| Cost coverage | Estimate |
| --- | ---: |
| Coding agents, 12/12 complete | $7.6319425 |
| Simulated user plus assessor, 12/12 complete | $7.9184970 |
| Combined, 12/12 complete | $15.5504395 |

The role metadata attributes $6.782869 to driving and $1.135626 to fresh
assessment (a $0.0000019 rounding difference from the aggregate grader subtotal).
Driving accounts for 85.66% of these evaluation-role costs. Its elapsed time
includes the coding agent's work and waiting; it is not all driver overhead.
The twelve driver intervals sum to 2,487.684 seconds and assessor intervals to
450.438 seconds. Their 2,938.122-second sum is 23.374 seconds below the sum of
worker wall times. This bounds only the in-worker time outside those roles;
container startup and final publication require their own accounting.

Timestamp sweeps confirm a maximum of four concurrent roles, including four
conversations or three assessments. Both harnesses were active for 99.128
seconds; simultaneous conversations across harnesses lasted 32.491 seconds.
Drivers and assessors overlapped across attempts for 312.590 seconds. These
are observed process intervals, not simultaneous provider computation. Both
completed deliveries and conclusive official reports were produced at 51.00
per campaign hour. This mixed-task wave is not the serial/parallel baseline.

Read-only audits of all twelve cells support ten published passes and identify
two false passes. These are completed runs with useful negative signal; the
original reports and grades remain unchanged.

| Task | Claude audit | Codex audit |
| --- | --- | --- |
| Code review | False pass: unsupported exploit outcome | Pass supported |
| Debugging | Pass supported; minor evidence attribution error | Pass supported |
| Design | Pass supported | False pass: watch-selection requirement omitted |
| Pricing | Pass supported | Pass supported |
| Review feedback | Pass supported | Pass supported after clarification |
| Verification | Pass supported | Pass supported |

**Claude code review:** the delivered review asserted an arbitrary-user
authentication bypass from a UNION payload even though the database driver and
its result shape were absent. A separate finding acknowledged that uncertainty;
it did not qualify the exploit claim. The frozen grounding criterion explicitly
disallows unsupported material exploit outcomes, yet the assessor passed it.
Evidence, under the canonical results root:
`conversation-code-review-claude-opus5_bedrock-linux-20260908T055758Z-190d/evidence/visible/captures/126.ansi`
lines 9–11 and 20–23; `evidence/output/src/db.js` lines 6–15;
`conversation-input/rubric.md` line 20; and
`gauntlet-agent/results/conversation-code-review_20260908T055759Z_7xjc/result.json`
lines 31–33. This reproduces the grounding weakness after the earlier calibration;
the calibration cases did not establish general grader reliability.

**Codex design:** the conversation asked about where completed tasks should go,
then delivered generic completion toasts. It did not clarify which tasks to
watch or include watch selection in the proposal. The assessor incorrectly
treated membership in the Active section as equivalent to watching a task.
Evidence under
`conversation-design-codex-openai_responses_56sol-linux-20260908T060519Z-87cf/`:
`conversation-input/rubric.md` lines 14–15, `trajectory.json` line 358,
`evidence/visible/captures/032.ansi` lines 16–35, and
`gauntlet-agent/results/conversation-design_20260908T060519Z_1odw/result.json`
lines 13 and 18.

The supported cells include real failure reproduction, corrective edits,
independent output checks, and fresh verification before completion/commit.
Two qualifications remain: Claude debugging's size-1 edge case was checked by
a direct Python command rather than its six-test suite, despite the assessor's
wording; Codex initially proposed a storage protocol in review feedback, then
dropped it after clarification. The latter demonstrates correct delivered
judgment, not an unprompted initial rejection. The Claude verification assessor
did not read the independent check receipt, although the audit confirmed that
it passed. None of these three qualifications invalidates those final passes.

The canonical standard report is
`/srv/quorum/superpowers-evals/campaigns/f4f42c37-3a00-4c1d-b5df-e76766a568fc-conversation_broad_signal/report.md`
with adjacent `report.json` and `report-seal.json`. Private retained outputs are
under `/srv/quorum/superpowers-evals/results/`. Local copies of the ordinary
readout and hash-verified role/verdict metadata are in ignored
`results/conversation-broad-signal/breadth-fresh-*` files.
