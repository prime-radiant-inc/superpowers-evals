# Routine conversation comparisons: review-team disposition

**Verdict: revise locally before implementation planning. Keep the release scope
and architecture.** Drew requested a fresh review of the committed spec after
the draft review. Four reviewers examined product scope, acceptance design,
grading correctness, and runtime/operations feasibility against actual source
and recorded experiments. Root checked the findings and consolidated them here.

Reviewed [the spec](2026-09-08-conversation-evals-routine-use-design.md) at Quorum
`f45dd692dc4a266fcfc8c7a7904d2682a6567277`, with Gauntlet
`256feaea65ea0016dec4133f2cd031bd72be8754`. All spec line numbers below refer to
that frozen revision. This review changes neither the spec nor runtime code.
No tests, provider calls, or remote operations ran; historical execution claims
were checked against saved evidence rather than rerun.

## Required revisions

### 1. Evidence must reach the assessor before it generates a citing report

Spec lines 149–153 require successfully read paths and imply inspection.
Gauntlet `src/assessment/assess.ts:213–247` processes several tool calls from
one model response before returning their results. A naive successful-read set
could therefore accept a read followed by a citing report in that same response,
although the model generated the report before receiving the file contents.

Require references to content delivered in the model's history before the
report-generating response. Failed reads and newly requested same-response
reads cannot qualify; an earlier successful delivery can. Verify this in the
actual assessment loop, including a rejected submission followed by a valid
one. This proves prior availability, not comprehension or correct inference.
It needs a local loop/parser rule, not a citation framework.

### 2. Qualification must check every decomposed verdict

Spec lines 211–216 freeze expectations for individual criteria, but lines
220–227 explicitly gate on the folded original judgments. Several different
atomic verdict vectors can fold into the same original failure: the grader
could fail the wrong obligation and pass the genuinely missing one.

Require each atomic verdict to match its independently supported expectation,
each folded original verdict to match, and every decisive rationale to be
materially sound. Review the fold's treatment of alternatives and uncertainty.
The original design misses make the distinction concrete: local/channel
successes must remain successes while missing watched-task behavior fails
(`../../experiments/2026-09-08-conversation-grading/results.md:64–69`). Keep this
mapping in finite qualification metadata; production needs no new schema.

### 3. Disposition of discovered expectation defects must be explicit

Spec lines 130–133, 211–216 and 249–255 cover preserved gold and pre-execution
disagreement, but do not resolve independently substantiated defects discovered
after exposure. Preserving historical bytes must not force a wrong expectation
to remain authoritative or allow an easier rubric to masquerade as recovery.

Distinguish candidate semantic misses from independently evidenced expectation
or mapping defects. Preserve the original results and record affected evidence
as unqualified while the issue is resolved from the criterion and primary
evidence. Candidate disagreement alone is insufficient. Substantive corrections
need separately identified rubric/map/gold versions, a reviewed semantic delta,
and the relevant full requalification. They cannot retroactively promote an old
candidate. A material change in what the scenario measures returns to scope
discussion. The fresh audit should save its independent judgments before grade
exposure, then record support or disagreement; unresolved interpretation cannot
establish a treatment effect. No adjudication service is needed.

### 4. Align execution-envelope promises with the existing controller

Spec lines 328–340 promise per-attempt admission checks against the cumulative
time window and settled accounting, while prescribing existing status/costs/
cancellation and excluding new budget machinery. The controller currently
checks ownership, cancellation, credentials and telemetry, then autonomously
admits further work (`src/campaign/controller.ts:350–366,1019–1078,1125–1172`).
The appliance admission callback checks ownership
(`src/appliance/campaign-run.ts:288–292`), not the release's cumulative cutoff
or qualification spending. Polling and cancellation cannot guarantee that no
attempt starts between a boundary crossing and its observation.

Prefer an explicit observed campaign-level policy using bounded appliance-owned
monitoring and existing cancellation. Specify observation/cancellation latency,
when cancellation begins relative to the cutoff, and treatment of active work.
Retain the original cumulative clock, known subtotals and pending coverage;
do not describe this as synchronous per-attempt enforcement. If that stricter
guarantee is essential, a narrow admission check must be explicitly included in
the scope and implementation plan. Do not acquire a budget controller or new
scheduler implicitly.

## What the team supports

- One integrated release covering scenario/driver fidelity, assessment and the
  ordinary comparison report. These changes address observed failures through
  existing interfaces.
- The 36-attempt, 18-pair acceptance matrix and one shared repair round. They
  are bounded product acceptance, not a reliability estimate or a promise that
  every worst-case stage fits the execution allowance.
- Counting established Claude/Codex concurrency and Pi review qualification as
  progress already made. No new first-concurrency proof or smaller launch pilot
  is needed.
- Preserving ordinary result schemas, completed bad subject work, negative
  Superpowers results and all-attempt accounting. Stock must be allowed to pass
  through equivalent behavior.

## Details for the eventual implementation plan

Keep qualification reuse mechanical. Driver controls need the existing private
tmux/process-group cleanup, not only the dated assessment child kill. Driver
completion and assessment results have different terminal artifacts, so share
returned-turn accounting mechanics without inventing an assessment-shaped
driver result. Keep expectations and prior grades outside candidate-readable
evidence. Report complete-pair denominators separately from all-attempt costs.

The structured assessor fields remain a testable hypothesis, not evidence that
the grader is now reliable. The declared semantic gates must establish that.
No additional platform, campaign, ensemble, or statistical subsystem is
recommended by this review.
