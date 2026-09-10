# Routine-use comparison and native-session doctor smoke

Drew approved the ordinary 36-attempt comparison and a subsequent doctor case
from each of its Claude, Codex and Pi native session histories. The comparison
produces initial behavioral data; the doctor follow-up tests evidence gathering
and reporting on those histories separately. Neither is a general qualification
of the platform or of doctor at this sample size.

## Fixed comparison

Run the committed `suites/conversation_routine_use.yaml` once through the
appliance campaign helper, global cap four. Claude and Codex each cover design,
code review, review feedback and configuration repair; Pi covers code review.
Every cell has stock and Superpowers arms, two repetitions, one attempt per
sample, no reserve and a 900-second outer limit. Treatment pins Superpowers
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; stock has no Superpowers.
Both Gauntlet roles use direct Anthropic `sonnet5` / `claude-sonnet-5`.
Registration records the exact source and pricing identities. Expected cost is
about $75; this is an estimate, not an enforced billing cap.

Read the ordinary sealed report for complete pairs, supported outcomes, time
and all-attempt cost coverage. Inspect role completion, capture, accepted report
coverage, native versus repaired reports, and retries separately from subject
success. Independently check material criterion judgments against the retained
evidence, preserving disagreements. Report wins, losses and no observed benefit
equally. Do not promote prompts or modify rubrics during the run.

Cancel on a confirmed setup/capture/publication defect or unpriced usage; stop
further experiments if two assessments cannot publish accepted reports. A
supported subject failure is data, not an instrument failure. Do not replace
failed samples or rerun cells under the registered identity.

## Doctor follow-up

Select one treatment session per harness from this campaign after inspecting
the retained evidence. Prefer an observable stumble for Claude or Codex and a
clean control for Pi; within that preference select the first chronological
eligible session. If no stumble exists, report that limitation instead of
inventing one. Selection is deliberately diagnostic, not a representative
sample or a doctor accuracy estimate.

Before doctor runs, record a private evidence key for each case: session identity,
the specific question, relevant skill sequence, decisive path/line citations,
supported observations and uncertainties. Pin one doctor revision for all three
cases. Give doctor the question and native history with relevant source evidence,
but withhold the evidence key and Gauntlet assessment reports. Preserve the
source histories unchanged.

Exercise intake through the complete seven-analyst report. Check identification,
citations, numbers, separation of human and injected messages, skill involvement
and unsupported findings. A clean session must not elicit an invented defect.
Record doctor cost and time separately. Export/redaction, issue creation,
similar-session search and a doctor-version comparison are outside this smoke.
Use the existing supported execution path; if it cannot express these cases,
record that constraint before proposing any new runner capability.

## Execution and results

Registered campaign `7fcf1df6-c61a-4615-8854-c0955dc2cb14` on 2026-09-10,
from Quorum `074cff420be2df6c14995a9f3ce170f1c088ac2b` and Gauntlet
`25a2e3e00431f8d8eb63781162ccb974d43d5405`. Prepare receipt
`job-20260910T213338Z-bad6`. Registration froze 36 planned slots, zero excluded
cells and the existing pricing SHA-256
`6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
Private receipts are retained under
`~/.local/share/superpowers-evals/routine-use-7fcf1df6/`.

The campaign stopped at a setup defect and was canceled through the helper.
The final report has `status: cancelled`, `complete: false`,
`behavior_available: true`, and `termination_verified: true`. Elapsed campaign
window: 765.13 seconds (21:35:09Z to 21:47:54Z).

Six attempts were prepared: two code reviews completed, two configuration
repairs failed at setup before model launch, and two design attempts were
interrupted. Thirty planned attempts were never admitted. There are five
published run directories; the interrupted treatment design attempt has no
accepted authenticated observation. Missing observations are not passes.

### Setup failure and bounded correction

Both configuration-repair attempts errored while checking for `oracle.cjs`.
The frozen source correctly contains `oracle.py`, and its `checks.sh` invokes
that Python checker. `runPreparedConversation` incorrectly required a readable
`oracle.cjs` before launching any conversation, coupling the generic runner to
the older scenarios' checker filename. This was not snapshot omission.

PRI-3120 removes that precondition. The existing check execution still owns
checker failures. Two offline regressions exercise the actual configuration
repair fixture/checker: its unfixed loader receives a behavioral fail and reaches
assessment; a missing Python checker produces a checks error and starts no
assessment. Both cases failed before the change and passed after it. No rubric,
fixture, model, prompt, or live retry changed.

Cancellation first returned `unresolved` while the live-spend lease remained
within its stale interval. The operator waited and retried the supported cancel
command without removing ownership files. It then returned `terminated`.

### Retained code-review pair

These are the first Claude stock and treatment replicates only. They cannot
establish a general treatment effect or replace the planned comparison.

| Measure | Stock | Superpowers |
| --- | ---: | ---: |
| Published machine verdict | pass | pass |
| Conversation seconds | 73 | 461 |
| Assessment seconds | 60 | 66 |
| Subject estimated USD | 0.333792 | 4.629540 |
| Both Gauntlet roles estimated USD | 0.200097 | 6.391563 |
| Assessment report submissions | 1 | 1 |
| XML repairs | 0 | 0 |

The treatment history retains its parent and 19 child session files. Its
conversation driver made 232 returned model calls; this is separate from the
assessment report count. These observed costs and activity supply a potential
future doctor case, not an explanation of why the activity occurred.

### Independent semantic audit

Both assessments accepted six passing rows. The operator agreed with the five
required finding/recommendation grades in each review and disagreed with both
grounding grades: 10 agreements and 2 disagreements across 12 criterion rows.
The original machine results remain unchanged.

- Stock: the review claims its tautology query example, combined with the
  identity hash, establishes full authentication bypass. The shown login code
  still compares the returned credential value to the supplied password; that
  particular claimed mechanism does not establish how the check is defeated.
  This does not deny SQL injection or the possibility of other bypass payloads.
- Treatment: the review asserts that logged credential material lands in log
  aggregators and CI outside database controls despite absent deployment context.
  It also presents four established critical defects while its fourth finding
  depends on an unknown driver result shape. The assessor noticed the latter
  certainty mismatch but accepted it as mild tension; the rubric explicitly
  disallows presenting conditional risks as established elsewhere.

Private per-criterion decisions and native evidence locations are in
`semantic-audit.jsonl` alongside the retained run evidence. These are an operator
adjudication, not an independent human panel or an accuracy estimate. The two
machine passes do not establish grounded review quality. Direct strict output
resolved structure on this pair but did not guarantee semantic grading.

### Cost and remaining work

Known campaign cost is **$11.972231**: subject $5.167329 and Gauntlet roles
$6.804902. Coverage is incomplete after cancellation; this is not a final invoice
or proof of zero cost for missing observations. Both setup failures happened
before either role started. Costs from interrupted attempts remain in the
all-attempt accounting rather than being dropped from the report.

The three doctor cases have not run. This campaign produced no Codex or Pi
sessions, so it cannot yet supply the approved three-harness sample. A replacement
comparison requires a fresh registration after the runner fix and an explicit
new live-run decision. The interrupted campaign remains a negative result.


## Authorized restart after PRI-3120

Drew authorized merging PR #58 and a fresh comparison. PR #58 merged as
`a098eb3a156f086de41be6cc315b75ff77d7cf55`; local full checks, independent
patch review and GitHub CI passed. The helper prepared this Quorum revision
with Gauntlet `25a2e3e00431f8d8eb63781162ccb974d43d5405`, receipt
`job-20260910T215830Z-b8e7`.

Fresh campaign `bcc17c8e-6871-4397-b887-106391c7cba1` freezes the same
36-slot suite, arms, skill pin, direct grader, sample counts and finite limits.
The prior campaign's outcomes are not pooled into this comparison. Its semantic
audit disagreements remain open observations; the checker fix does not alter
grading. Private receipts: `~/.local/share/superpowers-evals/routine-use-bcc17c8e/`.

Started through the installed helper over Tailscale SSH at 22:00:15Z. The
restart also hit a stop rule: the first treatment design assessment timed out,
and its fifth physical request had no returned usage. Cancellation completed
through the helper after its live-spend lease expired; ownership files were not
modified.

### What completed before cancellation

The first Claude code-review and configuration-repair pairs completed. The stock
design completed with a passing assessment; the treatment design delivered a
proposal but had no accepted assessment. All five accepted assessments submitted
one native report each, with zero XML repairs or report rejections. The Python
configuration oracle ran successfully in both arms, verifying PRI-3120 live.

| Scenario, first Claude replicate | Stock machine result | Treatment machine result |
| --- | --- | --- |
| Code review | pass | pass |
| Configuration repair | pass | pass |
| Design | pass | indeterminate: assessment deadline |

The assessor for treatment design read evidence in four returned requests over
19 seconds. Request `005` then remained pending for 96 seconds until the work
deadline aborted it. There was no returned report to parse or reject. The
attempt journal records `usage: not_returned`, `usage_unavailable: aborted`, and
the verdict records `unknownUsageAttemptIds: ["005"]`, incomplete assessment
accounting and a null total cost. Known sibling costs remain priced.

The trace establishes deadline cancellation of an outstanding non-streaming
Anthropic request. It does not establish whether the provider spent that time
thinking, generating, queueing, or waiting on transport. No response body was
returned, so a report-format explanation is unsupported. Strict output did not
eliminate latency or guarantee completion inside the fixed assessment bound.

### Semantic audit of the retained deliveries

The operator checked all 30 criterion verdicts in the five accepted reports:
28 agreements and two disagreements. Both disagreements are code-review
grounding passes. Configuration repair contributes eight agreements, and stock
design contributes ten. These are operator judgments against retained native
history and files, not an independent human panel or a general accuracy estimate.

- Stock code review incorrectly states that its tautology query with an arbitrary
  password returns arbitrary-user rows. The shown function still applies a
  password-equality guard. SQL injection remains a valid finding; the particular
  claimed return-value mechanism is not established.
- Treatment code review asserts that passwords are stored in plaintext. The
  fixture shows an identity hash and comparison, but no stored rows or password
  writing code. That storage claim exceeds the supplied evidence.
- Both configuration repairs reproduce before editing, remove the falsy-value
  fallback, preserve precedence, then verify zero, false and overrides. The
  final reports match the native execution and independent checker.
- Stock design explicitly settles local browser use, in-page delivery and
  per-task enrollment, explains the resulting interaction and tradeoffs, and
  leaves the original HTML unchanged.

The ungraded treatment design is audited separately: nine supported criteria,
one unmet clarification. Its conversation explicitly settles in-page delivery
and per-task enrollment, but never explicitly settles local-browser-only use;
the task-population scope answer does not supply that missing fact. This
operator audit does not convert the published indeterminate into a machine grade.

Private per-criterion decisions and native path/line evidence are retained in
`semantic-audit.json`. Missing reports remain missing, and the prior canceled
campaign is not pooled into these counts. The three doctor cases remain unrun
because this comparison did not clear the recorded stop rules.


### Final restart receipt

The report is `cancelled`, `complete: false`, with `termination_verified: true`.
Eight attempts were prepared: six finished before cancellation and the review
feedback pair was interrupted; 28 planned slots were never admitted. Seven run
directories published, including one interrupted treatment review-feedback
attempt; neither interrupted attempt supplies an accepted behavioral result.
Elapsed campaign window: 1,034.869 seconds, 22:00:14.694Z to 22:17:29.563Z.

Known cost subtotal is **$9.000169**: subject $3.269081 and both Gauntlet roles
$5.731088. Accounting is incomplete, including the aborted assessment request;
this subtotal is not a final invoice. The aggregate report's per-arm observed
coverage is not proof that every physical request returned usage: the treatment
design verdict explicitly marks its request accounting incomplete. Read both.

The helper's final health check passed with run and sync locks absent. No further
experiment was launched, no deadline or prompt was changed, and no native-session
fixture was published. The run never reached Codex or Pi, so it cannot supply the
approved three-harness doctor sample. The open next decision concerns completing
assessment within its finite budget and handling unknown usage on timeout; it
is not evidence that another XML repair is needed.
