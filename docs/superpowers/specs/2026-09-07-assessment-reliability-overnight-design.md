# Overnight assessment reliability

Status: draft for Drew's approval. No implementation or live execution is
authorized by this document until Drew approves it.

## Outcome

Test one small correction to the existing independent assessor, then promote
it only if it grades a bounded set of retained and fresh outputs correctly.
By the morning, leave either a verified change on main and the canonical
appliance, or a preserved candidate and a precise explanation of the failed
gate. A negative experiment is a useful outcome; an overnight tuning loop is
not part of this scope.

The starting revisions are Quorum
`debc8011ec442f249766bfbeb01aace01f12e2cb` and Gauntlet
`6dac4bfcb16042cb277067bb4535f9f22b9bb5df`. Superpowers remains
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.

## Evidence and hypothesis

The completed breadth/concurrency experiment demonstrated useful execution
and cap-four parallelism. Its twelve breadth grades included two false passes:
Claude's review asserted an unsupported exploit outcome, and Codex's design
substituted task-state membership for choosing which tasks to watch.

Quorum supplied the full criteria and retained evidence in both cases. The
assessor prompt asks it to read evidence and cite files; its validators check
report structure and verdict consistency. The failures demonstrate incorrect
judgment, not a confirmed capture, rubric-projection, or scheduler defect.
The earlier grounding-rubric calibration did not generalize to the new review.

Hypothesis: explicitly checking every original obligation and contrary
evidence will reduce these errors. Prompt causality is unproven; the experiment
must test the hypothesis rather than describe the change as an established fix.

## One candidate change

Change the assessment instructions in Gauntlet's
`src/assessment/assess.ts`. They should direct the assessor to:

- Check every material obligation in each original criterion, including
  conjunctions, explicit choices and required ordering. Accept equivalent
  demonstrated behavior without substituting a different requirement.
- Inspect the delivered work and relevant conversation, source and execution
  evidence. Subject summaries and completion claims are claims to verify.
- Examine contrary evidence and missing obligations before assigning pass.
  Correct portions do not compensate for a required omission or an unsupported
  material assertion. A qualification elsewhere does not automatically qualify
  an unconditional claim.
- Explain decisive support, contradiction or absence in the existing criterion
  evidence field. Distinguish observed task failure from evidence that is
  genuinely unavailable for assessment.
- Read indexed independent-check receipts when relevant and respect their
  scope. Preserving review input does not prove review quality; editable subject
  tests do not establish an independent oracle pass.

Keep the assessor model, scenario rubrics, report schema, tools, validators and
execution path fixed. No additional grader, voting, citation grammar, keyword
rules, model replacement or orchestration layer. This isolates one candidate.

The missing check-receipt read in one supported verification result does not
justify a new runtime gate: Quorum already supplies post-check records and
independently prevents a final pass when a post-check fails.

Splitting compound rubric criteria is a possible later alternative. It changes
the measurement and does not directly address the already separate grounding
criterion, so it is excluded from this comparison.

## Frozen retained-evidence experiment

Use fresh assessor histories with the existing Sonnet 5 Mantle route. Compare
the baseline and one committed candidate, with identical rubric and evidence
bytes for each case. Freeze source identities, cases, ordering and criterion
expectations before calls. Alternate baseline/candidate order across cases;
record the exact order. Do not alter the candidate after observing results.

| Stage | Cases | Calls |
| --- | --- | ---: |
| Known regressions | Two breadth false passes and the supported opposite-harness review/design outputs | 4 cases × 2 versions × 2 repetitions = 16 |
| Separately prepared controls | Three positive/negative pairs, below | 6 cases × 2 versions × 2 repetitions = 24 |

The four real cases use their complete original evidence indexes. They are
known development evidence, not unseen tests. Original grades and artifacts
remain unchanged.

A separate curator prepares six constructed controls, and another reviewer
checks their expected criterion outcomes and decisive evidence. The prompt
implementer must not inspect their contents, expectations or results until the
candidate is frozen. Cover these three distinctions:

- Supported review conclusions with correctly scoped uncertainty versus a
  material unsupported consequence asserted despite a separate qualification.
- A proposal that implements selective watching and its notification semantics
  versus a superficially similar state/filter mechanism that omits them.
- Corrected and verified work after an initial failure versus confident
  completion contradicted by retained output and a real failing check.

Label these as constructed evidence controls, not live or native sessions.
Include complete constructed dialogue and delivery, ordinary output files, and
real offline check receipts where relevant. Keep expected answers and all prior
assessor reports outside the evidence index. Do not fabricate execution logs.

After each stage, independent reviewers inspect criterion results, evidence
reads and decisive reasoning. Do not require reading every duplicate capture.
The candidate must match every specified criterion expectation in both
repetitions, preserve supported passes, and reject the known false passes for
the right reasons. A correct final grade with materially invented reasoning
fails the gate. Disputed expectations block promotion rather than being edited
after seeing the result.

If the known-case stage fails, stop before the separate controls. If those
controls fail, preserve the result and stop. No second candidate, retries,
majority vote, replacement cases or tuning after control exposure. Baseline
errors are observations, not required outcomes. If both versions pass all
controls, report no additional improvement on those controls; improvement may
still appear on the known cases. If the baseline meets every expectation and
reasoning requirement across both stages, stop without fresh confirmation or
promotion: this experiment has shown no benefit from the candidate. Otherwise,
promotion requires a baseline semantic error corrected by the candidate while
the candidate meets every expectation.

Forty calls estimate roughly $3.79 at the observed breadth assessment mean,
or $7.23 at its observed maximum. These are estimates, not billing bounds.
Two repetitions expose inconsistency; they do not establish general grader
reliability or a population error rate.

## Conditional fresh confirmation and promotion

Only after the retained-evidence and offline checks pass, run four fresh
attempts: review and design, each on Claude/Opus 5 and Codex/Sol, at global cap
four. Keep high subject effort, Sonnet 5 driver/assessor, original rubrics, and
the pinned Superpowers revision. Register one fresh campaign identity with one
attempt per cell and no replacements. The previous corresponding four cells
cost approximately $7.02; that is an estimate for planning.

Use the existing isolated pilot appliance configuration and helper for campaign
execution. Recheck its source, configuration, idle state and image before use;
the recorded pilot is historical state, not proof it is still ready. Its Quorum
checkout must contain the current runtime and committed four-cell suite on its
configured clean branch. Set only the pilot's Gauntlet path/ref to the owned
candidate checkout and full SHA. Registration mounts the frozen Gauntlet source
snapshot, so a candidate image rebuild is unnecessary. Pin the available runtime
image `sha256:2ee3e07dff9f2bb98d2e427da98ec73ab6efc077f4561f516b0a6130d0478d4e`.
Do not update the canonical appliance while testing the candidate. Use ordinary
standard reports, transcripts, outputs, independent checks and both-role usage.

Independently audit all four deliveries before using their grades as evidence.
Record the auditors' criterion judgments from the rubric and retained evidence
before revealing the assessor's grades to them.
Success means correct assessment of the observed work, complete usable
publication and cost coverage, and verified termination. Four behavioral passes
are not required: a completed bad delivery correctly graded fail is valid
signal. A false pass, false fail, materially unsupported rationale, inconclusive
assessment or instrument failure blocks promotion. No repeat of this campaign
to obtain a convenient result.

Before merging, require the semantic gates, independent code review, passing
required repository checks on the exact candidate, and any existing CI checks
triggered for that candidate. Then integrate directly to main without PRs,
update the canonical appliance through its helper, verify installed refs and
doctor, and record final-main CI. A pre-merge gate failure leaves the candidate
unpromoted. If deployment or final-main verification fails after merge, stop
and report the actual merged and installed revisions; do not claim main stayed
unchanged or perform an unreviewed rollback. Preserve the branch and evidence
in either case. Do not expand scope to force completion.

## Execution boundaries

- One coordinator in this Codex task owns launches and cancellation. Workers
  and campaigns remain appliance-owned; never duplicate an existing launch
  when resuming. Preserve exact owned identities and reconcile before proceeding.
- Retained assessment: at most 40 calls, sequential, two-minute external
  deadline per call, and a 90-minute execution window.
- Fresh confirmation: at most four attempts, ten-minute conversations and
  900-second attempt bounds, global cap four.
- Provider allocation: $12 for retained assessment plus $13 for fresh
  confirmation, **$25 total**. Stop before the next call or campaign once its
  allocation is reached. Stop if required usage is missing or unpriced. An
  in-flight request can exceed the observed threshold; this is not a hard
  provider billing cap. Preserve partial costs as unknown, never zero.
- Overall cutoff: **07:00 America/Los_Angeles on September 8, 2026**. Do not
  begin work that cannot fit its bounded execution and cleanup time. At cutoff,
  cancel active owned live work and reconcile termination; necessary cleanup
  may continue beyond the cutoff.
- Stop on instrument failure, lost ownership, cancellation, failed quality
  gates, or a required architectural decision. Do not remove locks manually,
  change timeouts to hide failures, or replace failed runs.

Reuse the previous assessor-only operator approach: existing `gauntlet assess`,
scoped grader credentials, shared spend lease, external deadline and ordinary
Gauntlet artifacts. Narrowly update its experiment-specific source pins, paths,
case limit and scenario-derived run IDs. The appliance helper has no assessor-only
verb; this is the explicitly approved retained-evidence operator path, not a new
runner or a raw scenario-launch workaround. Real scenario runs use the helper.

Preserve the old dated operator and use a new experiment path. Baseline and
candidate assessments use separate checkouts with frozen dependencies. Require
an explicitly completed summary, all forty unique expected rows graded and
priced, and the quality gates before starting fresh work: the previous operator
can exit zero after a budget stop or cancellation. Remove only an owned temporary
staged operator file before invoking a helper that requires a clean checkout.
Set the pinned pricing environment before starting Bun and enforce both the
90-minute stage window and absolute cutoff in the operator.

Run normal affected tests and required repository checks. Do not add prompt
wording assertions or claim scripted clients prove semantic improvement. Keep
the previously unexplained integration timeout visible; diagnose a recurrence
before attributing it to load or increasing limits.

## Overnight handoff and morning result

After Drew approves, use a heartbeat attached to this task to resume or inspect
owned work every twenty minutes. It must read the committed spec and current
experiment progress before acting, remain quiet on unchanged state, and stop
itself at completion, a blocking result, or the cutoff. Record progress and
launch identities in the experiment directory before yielding. A heartbeat is
coordination, not permission to rerun a campaign.

Keep this local coordinator awake for the bounded night using an owned sleep
inhibitor; release it on completion or cutoff. This does not provide execution
while the Mac is powered off or closed in a mode that forces sleep. Paid work
continues under appliance ownership if the coordinator disconnects.

The final report must state the candidate and deployed refs, gates passed or
failed, criterion disagreements and decisive evidence, all costs and missingness,
standard report pointers, CI status, and final process/lock state. Negative
findings receive equal treatment. No new dashboard or bespoke report product.

Driver performance edits are deferred: current evidence shows expense but no
demonstrated defect. A future read-only inspection of existing driver traces can
test screen-change and history-growth hypotheses before any optimization.

References: `docs/experiments/2026-09-07-conversation-broad-signal.md`,
`docs/experiments/2026-09-07-review-calibration/README.md`,
`docs/experiments/2026-09-07-conversation-assessment-pilot.md`.
