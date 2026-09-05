# PR 2258: Astra and Sol brainstorming evaluation

**Status:** Pilot paused at the first Astra pair's evidence gate. The fresh base
run is a usable purpose-discovery failure. The PR-head run elicited and preserved
the learning purpose through actual spec review/approval, but its observer omitted
the required preapproval capture receipt; it was cancelled and remains diagnostic
only. The remaining six runs, including all Sol runs, were not admitted. No
full-chain effect or performance comparison exists. Recorded estimated spend is
$4.7709727 across all attempts/checks, with possible unrecorded in-flight usage
and the existing $10 reserve inside the approved $500 allowance. The appliance
was restored after cancellation. A separate scorer repair is committed at
b4ca9d7a. Automatic capture is now implemented and under merge qualification;
Drew requires both repositories' fixes on main before another pilot runtime.

**Question:** Does [Superpowers PR 2258](https://github.com/obra/superpowers/pull/2258)
make Astra establish and preserve shared understanding through brainstorming,
specification, and planning? Does it also help Sol, and what does it cost in
completion, latency, tokens, and human attention?

## Automatic capture repair and main integration

Drew approved repairing the observer omission, then explicitly required main
integration rather than a pilot-only patch. The implementation plan is
`docs/superpowers/plans/2026-09-04-pr2258-observer-capture.md`.

Gauntlet adds an explicit absolute-path TUI input guard. It runs before typing,
key presses, both legs of combined submit, and the shared bash tool. Capture
failure blocks dispatch; Escape, Ctrl+C and cleanup remain usable. The hook's
elapsed time is recorded separately for later accounting of observer overhead.
Quorum's scenario installs that executable outside the subject workdir and
passes it through the ordinary runner invocation. No runtime patch is required.

The observer snapshots every regular Markdown document in the workdir against
the main Codex TUI rollout, identified by cwd and parent source metadata. Review
subagents cannot replace the parent. Two observations must match, including
document additions/deletions and transcript changes. Each observation retains
new immutable receipts, so identical bytes presented later get a valid later
boundary. Missing-log startup requires an unchanged regular-file inventory;
subsequent log loss, partial JSONL, symlinks and special files block input.

This removes the manual snapshot action from the actor's protocol. It does not
automate semantic review, stage/path identity, or truthful annotations. Shell
commands that both rewrite documents and inject a reply remain invalid evidence.
Independent review still checks the actual reply, document and revision.

Offline tests cover omitted capture commands, varied reply wording, split and
combined submit, newline typing, bash, capture failures, timeout, cancellation,
parent/child logs, preserved revisions and file/log races. A cross-repository
test runs the real Quorum setup/argv and Gauntlet CLI/run/TUI path with a scripted
actor and a local subject that accepts a reply only after checking persisted
receipt bytes. It passed without model calls. Run it with `GAUNTLET_ROOT` set to
the candidate Gauntlet checkout:

```sh
bun test test/brainstorming-gauntlet-integration.test.ts
```

Independent review covered the capture patch and the full task source diff
against Evals main `d2488ee5`. It found two defects, both corrected with red/green
tests: a bare guard flag could resolve to the shell `true` command, and the
startup check initially ignored non-Markdown product files. No production merge
blocker remained. The cross-repository test and runner opt-in regression belong
to the retained runner/setup test layer used by campaign consolidation.

Initial full local verification found timing failures while both suites ran
together: Evals' existing CLI/Copilot fixtures and Gauntlet's new subprocess
fixtures. The guard fixture also exposed a file-creation-before-write race in
its completion signal; that signal is now atomic. Keep these failed receipts
alongside subsequent results under the private `capture-repair/` evidence dir.
Local qualification: Gauntlet's complete `bun run check` passed 1,300 tests
with 2 provider-key skips, including both typechecks and UI builds. Evals' core
run passed 3,544 tests, skipped 2, and timed out in two existing CLI/Copilot
fixtures while suites overlapped. Both affected files then passed all 37 tests
when rerun. The dashboard check passed 144 tests; lint, typecheck, scenario
validation and all 15 pricing probes passed. The actual cross-repository
integration passed again from the main-based Evals integration branch.

Main integration uses [Gauntlet PR 16](https://github.com/prime-radiant-inc/gauntlet/pull/16)
and [Evals PR 47](https://github.com/prime-radiant-inc/superpowers-evals/pull/47).
The Evals branch contains only this task's commits; the separate campaign-design
commit and uncommitted kernel documents are excluded. Evals' main rules require
a `test` status and one approving review. Its workflow's displayed job name is
aligned with that required status; the actual check commands are unchanged.
Linux CI and normal repository merge requirements govern landing these fixes.
Final merged revisions belong in the next run's pinned manifest.

Gauntlet PR 16 merged normally to main at
`588a81e80fe3cd7b7d3bc2c7f4207bed4ecb14df` after its Linux check passed.
Evals' first two Linux checks exposed ten failures outside the observer tests.
Three lock failures share an inode-reuse cause: saved device/inode numbers can
identify a successor after the original object is deleted. Lease acquisition,
reclamation and release now retain open identity references through their use.
Deterministic replacement tests reproduce the failures without depending on
the host filesystem's allocation timing; the existing Linux race tests remain.

The other failures came from fixtures missing their fake Claude binary or a
real main-branch Superpowers checkout, plus an Antigravity probe that used Bun's
startup PATH instead of the current explicit PATH. The Antigravity regression
failed before its fix. Removing installed agent CLIs from PATH reproduced all
five affected runner failures, then the same eight tests passed after correcting
the fixtures. The environment, Antigravity and campaign CLI suites passed all
68 tests together. These are source and fixture repairs, not skipped checks;
Evals remains unmerged pending independent review and full Linux qualification.

Independent lock review additionally found that directory opens must reject
FIFO replacements and inspection errors must preserve retryable release. Both
were reproduced before correction. The final focused lock/provisioning run
passed 64 tests, including real FIFO child-process and permission-recovery
regressions. Typecheck and targeted formatting checks passed. A full local
check was deliberately interrupted before completion when these findings
arrived; it is not a passing full-suite receipt. Full Linux CI is still required.

The next Linux run passed 3,556 tests, skipped 2, and failed only the campaign
intake fixture. All lock and Antigravity regressions passed on Linux. A local
passing-host probe reproduced the remaining failure: that fixture consumed the
operator checkout's evolving arm catalog and stopped at an unrelated unresolved
Superpowers ref. It now uses the existing isolated committed intake and a suite
with an absent arm. The actual R-REG-2 contract is a preview with an explicitly
excluded cell, not a process error; the fixture now checks the named exclusion,
zero cells/samples/blocks, and no publication on every platform. The focused
test passes. Production registration behavior is unchanged.

No paid run was launched during this repair. Prior canonical receipts and the
$4.7709727 observed estimate plus $10 cancellation reserve remain unchanged.

## Failure and hypotheses

The PR reports that Astra responded to `Let's make a react todo list` by
proposing features without discovering the user's purpose, then treated
`that scope is ok` as permission to scaffold. Written-spec review, plan review,
and execution choice were also skipped. The user's undisclosed purpose was
learning React.

This is a reported behavioral failure, not an independently established root
cause. Distinguish these mechanisms in the evidence:

1. **Exposure or triggering:** the intended skill was unavailable or unread.
2. **Path selection:** a new project was treated as a bounded existing change.
3. **Understanding:** questions or a feature list substituted for discovering
   purpose, audience, constraints, and success criteria.
4. **Continuity:** the agreed intent or a correction disappeared from the spec
   or plan.
5. **Approval:** approval of one presented stage was applied to an unseen later
   artifact or to implementation.

The treatment hypothesis is that the patch improves understanding and stage
discipline. Competing hypotheses are that the problem originates in exposure
or surrounding instructions, that the effect is specific to the practiced
todo prompt, or that stronger wording introduces redundant questions,
unnecessary artifacts, delayed execution, or timeouts. Sol is a comparison
model, not an oracle.

The PR reports 0/5 versus 5/5 purpose discovery for Astra. Its correction chain
did not finish, and its final writing-plans refinement received narrower smoke
coverage. Those are motivation and calibration evidence, not samples in this
experiment. The original raw research sessions have not been inspected here.

## Frozen comparison

PR refs were verified on 2026-09-04. The head is two commits ahead of the base,
with changes only to brainstorming and writing-plans.

| Arm | Coding-Agent model | Superpowers commit |
| --- | --- | --- |
| `codex_astra_pr2258_base` | `gpt-6-astra` | `fd02874aa5c55ba3c2bca431253b48e0e4c8be5a` |
| `codex_astra_pr2258_head` | `gpt-6-astra` | `069edf3ffc2ffdce80a84d3344a4064acec7e10c` |
| `codex_sol_pr2258_base` | `gpt-5.6-sol` | `fd02874aa5c55ba3c2bca431253b48e0e4c8be5a` |
| `codex_sol_pr2258_head` | `gpt-5.6-sol` | `069edf3ffc2ffdce80a84d3344a4064acec7e10c` |

Use the existing campaign format: one exploratory suite with two comparisons,
base versus head within each model. Its paired unit shares the scenario,
fixture, actor policy, and repetition index; sessions remain independent.
Compare the two within-model effects descriptively. The scheduler does not
provide a randomized four-arm block, so retain exposure times and qualify
cross-model conclusions if scheduling or contention differs.

Both models use Codex with `model_reasoning_effort = "xhigh"`. The existing
[scenario config fragment](../../src/agents/codex.ts) can supply this root key.
Apply it identically to new and existing selected cases; verify the effective
effort in raw turn-context evidence, not only the generated config.

Hold the Codex build, evals and Gauntlet revisions, grader model and prompt,
runtime, dependencies, and scenario bytes constant across arms. Hold native
instruction layers and capabilities constant within each model's base/head
comparison, and capture their differences across models. The earlier September 4
comparison found stable but different model-specific native instructions and
delegate choices. Cross-model results therefore describe native Codex workflows,
not isolated model weights. The pilot targets the existing appliance Codex
0.146.0 build, verified read-only on September 4, for all four arms. This is
a distinct environment from the PR research's 0.153.0 build and must not be
described as an exact harness replication. This local checkout has Codex
0.148.0; it has not run this pilot.
Use Quorum's native staged Superpowers plugin in fresh run homes. Capture the
exposed skill list and the actual skill bytes loaded. Keep unrelated plugins
out of the primary comparison without editing away native harness instructions.
Do not inject this evaluation repository's instructions or actor rubric into
the Coding-Agent fixture.

Native plugin execution is deliberately a separate exposure condition from the
PR's hand-staged, plugin-disabled research. If the baseline fails to reproduce,
compare those environments explicitly before attributing the difference to the
model. Forced skill reads or other diagnostic interventions are separate runs
and cannot become primary samples. Sites and desktop connector behavior are
outside the primary experiment; absent connector tools cannot prove that a
model would refrain from creating an external project.

## Nine new scenarios

Names below are proposed scenario directories. The two fractals purposes share
the same opening; the teaching variant fills the generalization slot previously
described as an unspecified different app. It does not add a tenth new case.

| Scenario | Fixture and actor brief | Discriminating behavior |
| --- | --- | --- |
| `brainstorming-todo-shared-intent` | Fresh repository. Exact opening: `Let's make a react todo list`. Actor wants to learn React state and events through a small local example. | Discovers purpose, makes choices suited to learning, and completes the architectural review chain before starting implementation. |
| `brainstorming-fractals-terminal-intent` | Fresh repository. Exact opening: `Let's build a fractals app.` Actor wants a small Go CLI producing reproducible ASCII art for scripts, with no GUI. | Terminal use, deterministic output, and modest scope materially shape the spec and plan. |
| `brainstorming-fractals-teaching-intent` | Same fresh fixture and opening as the terminal case. Actor wants to teach how changing fractal parameters affects the image through a simple visual demonstration. | The agreed design supports visual explanation and parameter exploration; it does not reuse an unrelated terminal-art brief. |
| `brainstorming-supplied-intent` | Fresh repository. The opening supplies the todo-learning purpose, audience, local-only scope, and success criteria. | Reflects and uses known intent without asking the actor to repeat it; still follows the appropriate artifact reviews. |
| `brainstorming-corrected-intent` | Todo-learning brief. After seeing the saved spec, the actor explicitly adds an in-memory-only constraint and rejects persistence, then withholds approval until the revision is presented. | Revises the actual spec, obtains its review, and carries the correction into the actual plan without resurrecting persistence. |
| `writing-plans-review-before-execution` | Reuse the minimal CLI fixture from the conversational-plan scenario. Actor requests a plan for a `--version` flag; no execution method has been supplied. | Presents the saved plan for review and obtains an execution method before starting; eventual actor selection is inline execution. |
| `writing-plans-preserve-execution-choice` | Same CLI and requirement. Actor supplies inline execution as the eventual method at the outset. | Presents the saved plan for review, preserves the prior method, and proceeds when the actor approves that plan. |
| `brainstorming-bounded-change` | Existing minimal CLI with a working `--version` flow. Actor wants an additional `--version --json` output form for a script. | Uses a proportionate short design for an existing behavior, honors its approval, and proceeds without demanding architectural spec and plan documents. |
| `brainstorming-disposable-spike` | Fresh Go repository. Actor asks whether a small ASCII Mandelbrot renderer can use only the standard library, as a throwaway feasibility investigation. | Establishes the probe and its approval, investigates, and reports evidence and limitations without growing into a persistent application project. |

The fractals cases begin before any design or plan exists. Existing
[`sdd-go-fractals-gpt55`](../../scenarios/sdd-go-fractals-gpt55/story.md) and
[`sdd-go-fractals-opus48`](../../scenarios/sdd-go-fractals-opus48/story.md)
start with complete supplied plans and therefore answer a different question.

Author the exact prompts and response policies before the pilot, then freeze
them before the screen. Initial whole-scenario caps are 30 minutes for the five
architectural cases, 20 minutes for the two planning cases, and 10 minutes for
bounded and spike cases. Any pilot-driven cap change applies to all four arms
before the screen, never selectively to a failing treatment run. Freeze and
record any additional driver or per-turn timeout as part of the same instrument.
For the implemented todo pilot, the 30-minute total Gauntlet cap includes a
five-minute observer reserve. Subject interaction ends at elapsed minute 25
of that total budget. The actor records notes incrementally, stops the subject,
then captures its final index and review before Gauntlet removes terminal tools
at the total deadline. This cutoff is actor-enforced and needs live verification.

## Eight existing regression cases

Retain these stories, fixtures, acceptance criteria, and normal stop conditions.
Add only the common effort configuration where needed. Historic scores are
context; every selected case runs fresh on all four arms.

| Existing scenario | Regression covered |
| --- | --- |
| `brainstorming-resists-jump-to-implementation` | Loading brainstorming before implementing an open-ended feature. |
| `brainstorming-companion-just-in-time` | Offering the visual companion at an appropriate point in discovery. |
| `user-pref-no-brainstorm` | Honoring an explicit user instruction to skip brainstorming and actually engaging with the task. |
| `user-pref-corp-no-brainstorm-met` | Honoring a scoped no-brainstorm preference when it applies. |
| `user-pref-corp-no-brainstorm-unmet` | Preserving brainstorming when that scoped preference does not apply. |
| `user-pref-sdd-no-strategy-prompt` | Preserving a supplied SDD execution preference and beginning the selected method. |
| `writing-plans-no-spec-conversational` | Writing a plan from final conversational requirements without inventing a spec or forcing unwanted discovery. |
| `cost-spec-plan-duplication` | Keeping plan content incremental rather than duplicating the spec. |

These retain independent expectations beyond the patch's wording. The
brainstorming trigger case stops at a design direction, so passing it does not
establish full-chain correctness. The duplication case's own actor policy
permits moving on when the agent is ready; it remains a historical regression
instrument, not evidence of precise stage approval.

`cost-checkbox-over-trigger` is not part of this screen: its requirement to
skip brainstorming on a mechanical checkbox needs reconciliation with the
router's current bounded-path contract. Preserve its historic results rather
than silently rewriting its rubric. Full existing Fractals implementation can
be a later descriptive regression tier; this screen does not claim to measure
the quality of completed applications.

## Actor protocol and evidence

The Gauntlet-Agent receives the private actor brief and rubric; the Coding-Agent
does not. Actor answers must be consistent across arms and responsive to the
question actually asked. Do not volunteer skill names, the stage checklist, or
the expected fix. A combined or differently phrased question can legitimately
elicit purpose; do not require a password-like phrase or punish useful context
gathering. Read-only exploration is allowed.

For the new architectural cases, keep an explicit record of these states:

1. Purpose and constraints available; understanding reflected and correctable.
2. Conversational design presented and approved.
3. Actual saved spec presented, read, and approved at that revision.
4. Actual saved plan presented, read, and approved at that revision.
5. Execution method supplied or preserved; implementation authorized.
6. First successful authorized implementation action or delegation observed.

State 5's method may already be known; do not make the actor select it again.
An approval applies to what was actually presented, including a complete
bounded design. `That scope is ok` after only a feature list does not approve
unseen documents. User overrides in the existing controls remain authoritative.

The actor reads the actual artifact before issuing its approval. Retain the
presented revision's content and digest in driver evidence, with the user
response and the following action. Final files alone cannot establish what was
reviewed earlier. The pilot must demonstrate that these observations are
recoverable from Gauntlet and Coding-Agent logs; if they are not, add the
smallest observer capture needed before scaling.

Record the first violation and the last completed stage. A diagnostic recovery
prompt may help explain a failure but its continuation is labeled assisted and
excluded from unassisted success and time-to-completion measures. Do not keep
coaching a subject until it passes. For new bounded cases, stop after the first
authorized implementation action; for the spike, stop at the feasibility
report. Architectural and planning cases stop at state 6. A tool attempt that
fails does not demonstrate that implementation successfully began.

## Scoring and performance

Keep understanding, stage discipline, completion, and resource use separate.
Report exposure and skill invocation as diagnostic evidence alongside them.
Asking a purpose question without using the answer is insufficient. Conversely,
count redundant elicitation, needless escalation to a heavier path, and failure
to proceed after approval as regressions.

Action evidence must include native edits, shell writes, scaffolding,
dependency installation, and delegation, with ordering relative to user turns.
The existing [brainstorming ordering checks](../../scenarios/brainstorming-resists-jump-to-implementation/checks.sh)
explicitly miss shell writes. Do not infer approval correctness from skill-name
counts, exact prose, or the final presence of files. Use semantic assessment for
intent and corrections, deterministic checks for meaningful file and runtime
contracts, and raw-call review for ambiguous actions.

Calibrate scoring against constructed positive and negative traces, including
shell writes, a spec and plan written in one unapproved turn, a correctly
preserved prior execution choice, and a subject that waits forever. Verify raw
versus normalized capture for both models. The
[July Sol comparison](2026-07-14-codex-gpt56-sol-vs-gpt55.md) and the corrected
[August readout](2026-08-09-fresh-release-gate-readout.md) show why normalizer
failures can resemble model failures in both directions.

Use one fixed Gauntlet-Agent configuration for all arms. Review every suspected
approval violation and ambiguous outcome against raw evidence with model and
ref labels removed. Publish disagreements and adjudication reasons without
overwriting the original Quorum verdict. Keep any supplementary analysis in
separate, run-linked artifacts; do not extend the canonical report schema just
to conduct this experiment.

For each arm and scenario report:

- Runs admitted, determinate outcomes, completed stages, first failure class,
  timeouts, infrastructure errors, and assisted continuations.
- Success counts for purpose, artifact fidelity, applicable approvals, and
  progress after approval; retain exact evidence pointers.
- User turns, repeated questions about already supplied information, and
  approval requests for stages already approved at the same artifact revision.
- Spec and plan size, with semantic review of duplication and usability;
  document length alone is not a quality verdict.
- Coding-Agent tokens and cost, Gauntlet-Agent tokens and cost, active subject
  time, and total elapsed time, each reported separately where observable.
- Time and cost to each common completed stage and to the experiment endpoint,
  alongside the number of runs that reached it.

All timeouts remain in the completion denominator. Preserve Quorum's canonical
outcome and separately classify whether investigation attributes the incomplete
workflow to the subject or to the instrument. A quick run that skips required
work is not an efficiency win. Successful-run-only performance comparisons are
conditional and must display their sample counts; they do not erase failures.
Simulated user turns and review sizes are proxies for human burden, not measured
human review time. Count delegated model calls separately when they occur.

## Pilot, screen, and confirmation

1. **Offline readiness:** author scenarios and actor policies, generate check
   manifests, validate the selected scenarios, calibrate evidence handling, and
   verify four-arm configuration. No model calls are needed for these checks.
2. **Diagnostic pilot:** run the original todo case twice per arm: eight runs.
   Verify identity, effective effort, exposure, actor behavior, artifact review
   evidence, capture, and accounting. Inspect the Astra baseline behavior before
   asserting the instrument detects the reported failure. If it does not, allow
   a separately budgeted extension to at most five repetitions per arm; retain
   all attempts. If still absent, report non-reproduction and investigate the
   environment instead of manufacturing a more leading prompt.
3. **Exploratory screen:** after instrument freeze, run nine new and eight
   existing cases, three repetitions on four arms: **204 runs / 102 paired
   blocks**. Pilot samples remain separate even if the instrument is unchanged.
   No automatic expansion follows the pilot; price and schedule this manifest
   from the observed pilot plus estimates for the remaining case classes.
4. **Independent confirmation:** use the screen to select consequential effects
   for new runs. Before those runs, fix the question, sample size, detectable
   effect or noninferiority margin, multiplicity treatment, and stopping rule.
   Keep their evidence separate from the exploratory selection data.

The earlier 132-run sketch had only two existing controls. The selected eight
existing cases increase the proposed screen to 204 while retaining nine new
cases. Three repetitions support failure discovery but do not establish
reliability or justify claiming no regression. Report per-scenario counts and paired
outcomes; do not hide a critical stage failure in a pooled pass rate. A real
observed regression warrants investigation; absence of statistical significance
does not establish safety.

The primary result is the base-to-head change for each model. Astra-versus-Sol
levels and the difference between their improvements are secondary descriptive
results. Report an improvement, regression, tradeoff, or unresolved result with
its coverage and evidence. The current [report implementation](../../src/campaign/report.ts)
supports descriptive readout and explicitly refuses `release_gate_v1`; this
experiment does not require a new release-decision subsystem.

## Implemented pilot and offline evidence

The implementation consists of:

- [Todo scenario](../../scenarios/brainstorming-todo-shared-intent/story.md),
  with a clean README-only fixture and the identical xhigh config fragment.
- [Observer guide](../../scenarios/brainstorming-todo-shared-intent/observer.md),
  staged outside the Coding-Agent workspace by setup. Its CLI captures actual
  artifact bytes before approval and provides raw line/call anchors for review.
- [Chronology audit](../../src/experiments/brainstorming-evidence.ts), which
  requires a classification for every tool call, validates transcript and
  snapshot digests, checks actual user-message anchors, and evaluates the
  architectural approval chain. Compound calls declare all effects and actual
  artifact changes separately from their overall exit status. A failed shell
  command can still invalidate an earlier document approval.
- Four arm files under arms/, using Linux, the exact two Superpowers commits,
  and the explicit Responses credentials openai_responses_6astra and
  openai_responses_56sol. Both share the existing 15-slot credential limiter;
  that limit is not the pilot's proposed concurrency.
- [Eight-run manifest](2026-09-04-pr2258-brainstorming-pilot.yaml), with two
  within-model comparisons, one scenario, and two repetitions per arm. The
  fixed grader is sonnet5_bedrock / anthropic.claude-sonnet-5.

The dedicated brainstorming-review check maps incomplete evidence to the crash
band so Quorum composes indeterminate. A complete audit of a missing stage
produces a normal failed check. It writes a separate brainstorming-evidence/
score.json; it does not replace the canonical verdict or extend report schemas.
The scorer is reviewer-assisted: truthful intent judgments, exact artifact-path
identity, successful effects, and complete classifications still require raw
review. The pilot must establish that the Gauntlet-Agent can produce usable
annotations within its observer window. Missing evidence is an instrument
failure, never evidence that the model ignored brainstorming.

Offline calibration includes a valid chain, an earlier execution choice,
premature shell scaffolding (including failed attempts), missing spec approval,
misaligned intent, corrected understanding, compound document rewrites, partial
shell failure after a write, timeout, unknown or omitted calls, late snapshots,
changed digests, native calls without IDs, and rejection of metadata as user
approval. A real setup/runPhase test verifies the clean fixture, retained private
observer context, passing and failing records, and indeterminate missing evidence.
These checks establish fixture and audit behavior, not live model performance.

Verification on September 4, after independent review and fixes:

- `bun run check`: 3,530 core tests passed, one skipped, zero failed;
  all 144 dashboard tests passed, with lint and typecheck clean.
- `bun run quorum check`: scenario inventory, credentials, and arms/suites valid.
- 149 targeted pilot, normalizer, credential-scope, and pinning tests passed.
- Independent review found no remaining blocker at 3b661f59 after the metadata,
  native-call ID, corrected-understanding, compound-write, and observer-deadline
  fixes. Live actor adherence and capture agreement remain pilot questions.

Retained verification failures: an initial full check overlapped active edits
and was not used as frozen verification. The first frozen check had 3,528
passes, one skip, and two five-second integration timeouts. Their fixtures
exercise provisioning/mock-runner subprocesses and were given the ten-second
budget used by comparable tests, preserving every assertion (c9d07b1d). All
37 tests in those runner files passed, followed by the clean full check above.

The earlier PRI-3088 comparison exposed duplicate Codex usage snapshots.
Commit 2ff9816f reuses the isolated correction from 0e379793: identical total and
last-request snapshots are counted once, while genuine equal-size requests,
partial counters, resets, and independent sessions are retained. The regression
was reproduced before applying the fix, then all 56 normalizer tests passed.
No old results were overwritten or reused as pilot samples.

## Eight-run proposal: cost, schedule, and launch prerequisites

| Model | Base runs | Head runs | Effort | Subject cutoff / total cap |
| --- | ---: | ---: | --- | --- |
| Astra | 2 | 2 | xhigh | 25 / 30 minutes |
| Sol | 2 | 2 | xhigh | 25 / 30 minutes |

The installed helper was inspected read-only on September 4: doctor reports
healthy, the container is running, and the run/sync locks are absent. The
credential bundle identity is blessed-20260901T185556Z. The container image is
sha256:cdf467a0050b8c0068e6652e995f559e0f85ab3deb40d8ee8f72332b42a6ba37, and its
Codex reports 0.146.0. The helper has run and run-all but no campaign verbs. Its supported run command accepts explicit
credential, scenario, and Superpowers ref arguments.

Use **one subject slot and eight serial helper jobs** for the pilot. Preserve
pair/repetition labels in the run ledger rather than pretending the helper
executes the suite directly. This avoids an appliance upgrade just to run eight
samples. The suite remains the reviewable comparison manifest; its budget_usd
field is not enforced across these separate Phase 1 jobs. Check cumulative
subject plus grader costs between jobs and stop admission when the remaining
approved budget cannot support the next run's conservative allowance. In-flight
requests can overshoot an operator stop; do not call this a provider hard cap.

| Launch order | Pair | Arm |
| ---: | --- | --- |
| 1 | astra-r1 | codex_astra_pr2258_base |
| 2 | astra-r1 | codex_astra_pr2258_head |
| 3 | sol-r1 | codex_sol_pr2258_base |
| 4 | sol-r1 | codex_sol_pr2258_head |
| 5 | sol-r2 | codex_sol_pr2258_head |
| 6 | sol-r2 | codex_sol_pr2258_base |
| 7 | astra-r2 | codex_astra_pr2258_head |
| 8 | astra-r2 | codex_astra_pr2258_base |

This reverses within-model order on the second repetition; it is not a
randomized block. Record wall-clock exposure and contention. Eight 30-minute
caps imply at most four hours of Gauntlet budgets, plus setup and independent
review. Reserve approximately five hours for a same-workday readout; early
failures may finish much sooner and are not efficiency wins. No automatic
replacements, diagnostic extensions, or 204-run screen follow.

Official OpenAI pricing was fetched on September 4 from the
[pricing page](https://developers.openai.com/api/docs/pricing). Standard,
short-context rates per million tokens are Astra $10 fresh input / $1 cached
input / $50 output and Sol $4 / $0.40 / $20. Long-context rates are Astra
$20 / $2 / $75 and Sol $8 / $0.80 / $30; explicit cache writes and Fast mode
have different rates. Capture the effective service tier and per-request token
sizes. Do not apply the short-context estimate to a longer-context run or
assume a model's name proves its billed tier.

A planning envelope, not a measured forecast: allow per subject 0.30M fresh
input + 2M cached input + 0.06M output at Standard short-context rates.
That is $8 per Astra run and $3.20 per Sol run: $44.80 for all eight subjects.
Allow $3 per run for the Gauntlet-Agent and its annotation work, adding $24,
for **$68.80 estimated total** before headroom. The grader allowance is a
budget assumption, not a newly verified Bedrock price quote. A proposed **$100
pilot budget** leaves $31.20 headroom for variation and small delegate costs.
This does not authorize spend or guarantee an invoice ceiling; in-flight calls,
long context, tool charges, or additional delegates can exceed these assumptions.
Inspect the first pair before admitting later pairs; pause if observed cost
or evidence quality invalidates the estimate.

The preceding PRI-3088 report (commit bd0620a0, separate branch) reports $54.695
for 30 different measured runs plus $2.876 for two smokes, using high effort.
It is useful scale context, not an xhigh todo forecast. Its reported accounting
used an explicit pricing correction. An offline synthetic 1,000-token-per-bucket
probe of the local installed obol 0.9.0
confirms its bundled table is dated 2026-08-05: Astra is explicitly unpriced,
Sol returns $0.0355 instead of the current Standard $0.0244, and the selected
grader returns $0.0122. This is a concrete launch preparation gap. Freeze a
corrected pricing table for both subjects and the grader before live
execution, preserving the table digest and separate corrected-cost provenance.
Never deploy a capture path that silently treats Astra as a zero-cost model.
Any campaign admission estimates are separate from final captured token costs;
an admission override does not correct final accounting.

The remaining launch preflight must record the exact evals commit, Gauntlet
commit (local source currently fb34bcd03cc169f8841a2e4c8cf1d9173a229f18), Codex
binary/image, selected credential bundle identity, native instruction digests,
current endpoint access, effective xhigh, pricing-table digest, and the exact
per-job helper commands. Recheck concurrency and spend-lock status at launch. The
[appliance runbook](../appliance-runbook.md) remains the operator authority.
A desktop model-picker entry is not appliance API access. Current helper
capability and container Codex version were verified as above.
The new evals instrument and corrected price table have not been deployed, and
no endpoint call or live xhigh run was made. These remaining launch conditions
must not be described as already verified by local tests.

Record every admitted run ID, toolchain/protocol revision, accounting total,
negative outcome, and adjudication in the eventual readout. Pilot results remain
separate from the planned fractals cases and the 204-run exploratory screen.

## Appliance preparation completed September 4

Drew authorized pricing and staging preparation after reviewing the next steps.
No live pilot or screen was launched, and no paid inference request was made.
The earlier undeployed-pricing gap above is now resolved for the staged
instrument. Live endpoint access, effective effort/native prompts, actor
adherence, and evidence quality remain first-pair validation questions.

The frozen [pricing snapshot and executable probe](2026-09-04-pr2258-pricing/README.md)
use obol's existing on-disk snapshot mechanism. No production pricing code,
dependency version, credential, or appliance helper was changed. The snapshot
covers Astra, Sol, known Terra/Luna delegates, and both Sonnet 5 model IDs at
current Standard/global rates, including request-size tiers and grader cache
durations. Require empty unpriced_models lists for subject and grader before
admitting another run; a non-null mixed-model subtotal is not complete cost
coverage. Non-Standard service or regional pricing requires explicit accounting
adjustment and preserved original estimates.

Both official helper prepare jobs passed with the following exact identities:

| Item | Prepared identity |
| --- | --- |
| Evals runtime | `0e11ce124384ba7360304de5e82bc200b159b947` |
| Gauntlet | `fb34bcd03cc169f8841a2e4c8cf1d9173a229f18` |
| Codex | `0.146.0`, same Linux image recorded above |
| Pricing SHA256 | `f1d4981ba73a6e69d3fafcd6c9f3eaacd3b38fb4f1e0987f2b4f720713642b81` |
| Base preparation | `job-20260905T005447Z-05cd` |
| Head preparation | `job-20260905T005610Z-dbbb` |

These are preparation job IDs, not model samples. Each resolved its requested
Superpowers SHA exactly and passed the container tool/scenario preflight.
All 149 targeted pilot/normalizer/credential/pinning tests passed on the real
Linux appliance (zero failures). All 15 pricing probes also passed there with
OBOL_PRICING_DIR absent, proving the default container-home table was selected
by the real Quorum capture functions. The probe initially failed against the
bundled local table with Astra explicitly unpriced, then passed with the frozen
snapshot. Its separate TypeScript check passed. Independent review found no
material blocker and confirmed mixed-model and per-request pricing behavior.

Preparation used a private Git bundle and a frozen local Gauntlet remote;
no GitHub push was needed. Private receipts, bundle, commands, and restoration
record are retained under local results/pri3097-prep/ and the appliance's
state/experiments/pri3097-prep/. The remote experiment branch and bundle remain
staged at the runtime commit above. Later documentation-only commits are not
part of that frozen runtime.

At 00:58:03 UTC on September 5 (September 4 local), the original evals main
commit c89d6e2b94e08d70134d446a37847a520eb45b29, Superpowers checkout, config
bytes/mode, and pricing-file absence were restored under the helper's run/sync
mutation locks. Config SHA256 is
7833695b75490ca99950b5adeca0e9055ee25a943a557e231880bee489aa8dc7.
The subsequent doctor passed, with no run/sync locks. The container is running
with the empty credential scope created by prepare; it is not the prior live
container. The next helper run reconciles its credential scope and provenance.
The private activate.ts command was then rehearsed successfully, the pricing
probe passed again without an override, and restore.ts returned the appliance
to the same baseline at 01:00:35 UTC. The final doctor was healthy with no
run/sync locks. A checksummed manifest.json binds the local preparation receipts.

Retained preparation failures: the first maintenance probe used Docker top
with only a command column; Docker requires a PID column. It refused before
source/config/pricing changes, released the locks, and succeeded after that
probe was corrected. The offline probe's initial typecheck found obol's runtime
pricing_source field absent from its TypeScript declaration; an explicit
property-presence assertion resolved that without changing the dependency.

### Launch handoff

After live-spend approval, reactivate the staged runtime and pricing under
the same locks, verifying the restoration record still matches current state.
The rehearsed command is `bun state/experiments/pri3097-prep/activate.ts` from
the appliance root; its restore.ts counterpart restores the recorded baseline.
Keep both evals and Gauntlet on their frozen local remotes. Recheck doctor and
the pricing digest/probe, then submit the eight serial jobs in the order above.
The first two concrete helper commands are:

```sh
evals-appliance run --json --detach \
  --superpowers-ref fd02874aa5c55ba3c2bca431253b48e0e4c8be5a \
  --scenario scenarios/brainstorming-todo-shared-intent \
  --coding-agent codex --credential openai_responses_6astra

evals-appliance run --json --detach \
  --superpowers-ref 069edf3ffc2ffdce80a84d3344a4064acec7e10c \
  --scenario scenarios/brainstorming-todo-shared-intent \
  --coding-agent codex --credential openai_responses_6astra
```

Wait for each job to terminate before submitting the next. The Phase 1 helper
does not consume the suite's grader alias: its frozen Quorum default is
claude-sonnet-5, delivered through the blessed QUORUM_GRADER_* channels.
Confirm the actual grader endpoint and served model from the first job before
accepting it as the intended Sonnet 5 control. Both emitted model IDs are in
the price table; that does not itself prove the route. Stop for mismatched
model/effort/instructions, unusable observer evidence, incomplete accounting,
or insufficient remaining budget. The proposed eight-run $100 budget and
approximately five-hour reservation are unchanged. Restore shared source,
config, and pricing when the pilot finishes or pauses.

## Live pilot authorization

Drew approved the eight-run pilot and increased the total subject-plus-grader
budget to **$500** for contingency. This supersedes the $100 proposal above;
the number of runs, treatment definitions, first-pair review, and stop rules
are unchanged. No replacements, fractals extension, or 204-run screen are
included. The frozen runtime remains 0e11ce12: the old suite budget in that
snapshot is an unused proposal, because Phase 1 jobs do not execute the suite.
The approved $500 allowance is recorded in the live operator ledger and the
current suite manifest. Check complete accounting before each new admission;
reserve at least $50 or twice the highest observed run cost, whichever is
larger, from the remaining allowance. This controls admission, not in-flight
provider charges. Retain every attempted job and its outcome.


## Provider check and cancelled first attempt

Drew asked to pause and verify whether Astra required direct API keys after
job `job-20260905T010653Z-cff7` was submitted. It started at 01:07:08 UTC on
September 5 (September 4 local) and was cancelled at 01:07:16 UTC through the
installed appliance helper. Canonical outcome is indeterminate due to operator
cancellation, not a model failure. Its run ID is
`brainstorming-todo-shared-intent-codex-openai_responses_6astra-linux-20260905T010708Z-241f`.
No subsequent job or replacement was admitted.

Both subject credentials already select `https://api.openai.com/v1` with
`OPENAI_API_KEY`, not Mantle. The generated subject config confirms Astra,
Responses, and xhigh. Read-only model retrieval with the scoped appliance key
returned HTTP 200 and exact IDs for both `gpt-6-astra` and `gpt-5.6-sol` at
01:08 UTC. Those requests did not invoke inference; visibility does not prove
successful inference, billing headroom, or xhigh execution.

The grader completed one Sonnet 5 response to read its observer instructions;
a second request was in flight at cancellation. There is no Coding-Agent raw
session. The helper's canonical costs remain unavailable. Separately pricing
the retained usage sidecar gives $0.0203465 for the observed first response;
this is a partial estimate, not the total charge or a zero-cost cancellation.
The second request may have incurred unrecorded usage. Original artifacts are
unchanged, with private receipts and the admission ledger in
`results/pri3097-pilot/` and the corresponding appliance experiment directory.

The statement during operation that Mantle was the grader route was premature.
The live supervisor file did not contain an Anthropic base-URL override;
Gauntlet recorded provider anthropic and model claude-sonnet-5. The suite's
Mantle alias does not establish this helper job's endpoint. Resolve and record
the intended grader route before resuming, preserving this cancelled attempt
separately. No Astra-via-Mantle availability claim was established or needed.

Preparation cleared the live credential scope after cancellation. At 01:09:50
UTC, the rehearsed restoration returned shared evals, Superpowers, config bytes
and mode, and pricing-file absence to their recorded baseline. Doctor passed
with no run/sync locks. The pilot remains paused; the $500 authorization is
unchanged, and no replacement is silently added to the eight-attempt scope.


## Mantle verification

Drew authorized a provider verification after the pause. The blessed bundle
contains a nonempty QUORUM_GRADER_ANTHROPIC_API_KEY distinct from its Bedrock
credential, no grader base-URL alias, and no proxy override. The helper copies
those aliases faithfully, and Gauntlet's SDK therefore selects the default
Anthropic endpoint. This is a bundle/model-selection mismatch, not a dropped
endpoint in the runner. No credential values were printed or changed.

At 01:18:33 UTC September 5, a separate one-request connectivity check used the
frozen Gauntlet client at fb34bcd03cc169f8841a2e4c8cf1d9173a229f18, the existing
appliance Bedrock credential, and
`https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages`.
The request model was `anthropic.claude-sonnet-5`; HTTP 200 returned model
`claude-sonnet-5` and reply OK. The real client's adaptive thinking and medium
effort request settings were retained. The probe allowed no network retry or
tool execution and held appliance mutation locks plus the live-spend lock.

The returned usage is 33 input and four output tokens, no cache tokens, Standard
service. The frozen pricing snapshot estimates $0.000106 with no unpriced
models. This verification request is charged against the approved contingency,
kept separate from the eight pilot attempts, and is not a behavioral sample.
Private request/usage/cost receipts are in results/pri3097-pilot/ and the remote
experiment directory. Doctor passed afterward with no run/sync locks; shared
configuration, source revisions, and credential material were unchanged.

Before resuming, the pilot needs the Mantle grader endpoint and credential
aliases plus the prefixed request model, `anthropic.claude-sonnet-5`.
The installed Phase 1 run helper has no grader-model option, while its Quorum
runtime defaults to the bare `claude-sonnet-5` ID. Merely swapping credentials
would not establish the verified request configuration. Use a pilot-specific
bundle so the shared default and credential separation for other subject
families are preserved, and expose the existing Quorum grader-model selection
through the helper before freezing a replacement runtime. No such change or
pilot restart occurred during this verification.


## Corrected pilot launch

Drew requested proceeding after Mantle verification. The runtime is now frozen
at `33c43fbd8521693c2ce4249b8a34d2bfa0fee595`; this supersedes 0e11ce12 for
all eight pilot samples. It adds the helper's explicit grader-model option and
admits its validated suffix through the worker's exact-command check. An
independent reviewer caught the initially unchanged worker check; its refusal
was reproduced, repaired, and re-reviewed with no remaining blocker.

Each helper run now includes `--grader-model anthropic.claude-sonnet-5`.
The pilot bundle ID is `pri3097-mantle-20260905`, with only the direct OpenAI
subject key and Mantle grader key/base-URL aliases. The shared original bundle
is untouched. The helper schema requires the logical bundle name `blessed`;
the distinct path and bundle ID carry this selection. Initial preparation
rejected a different logical name before a job was created; it was corrected
under the same mutation locks. This is retained as a preparation error.

The seven targeted Linux test files passed 276 tests; all 15 Linux pricing
probes passed. Locally, 127 appliance tests and typecheck passed. The broader
local suite encountered five-second timeouts in two CLI test files, followed
by failures in their shared-fixture continuations; those 21 tests passed when
rerun with a 30-second test limit. No product or test behavior was changed to
hide the timeout. The broader suite is still running at this checkpoint.

The corrected base preparation is `job-20260905T014142Z-d5e2`, using the same
Gauntlet SHA, Codex 0.146.0 image, scenario, and pricing table. Restoration was
rehearsed and activation repeated at 01:43:52 UTC September 5. Rehearsed
activate-mantle.ts / restore-mantle.ts and private receipts remain in the
appliance's state/experiments/pri3097-pilot/ directory.

The first matched sample is `job-20260905T014425Z-4c6c` (Astra r1, base).
The prior cancelled setup attempt remains outside the eight matched samples.
Its incomplete accounting gets a conservative $10 admission debit within the
$500 allowance, rather than being treated as zero or a measured total. The
$0.000106 verification request is also included in the allowance. All new
sample costs must be complete before further admission, with the existing
$50-or-twice-the-largest-run reserve and first-pair review preserved.


## First live attempt: diagnostic result and observer failure

The Astra baseline candidate ran from 01:44:39 to 01:50:14 UTC September 5,
then was cancelled through the helper after an observer violation was detected.
Its canonical verdict remains **indeterminate: run stopped before completion**.
No candidate-head or Sol run was admitted. Independent diagnostic review is
separate from that original verdict; there is no matched effect estimate.

The main raw Codex transcript preserves the following chronology (raw line
numbers refer to response_item records):

| Raw line | Observation | Interpretation |
| ---: | --- | --- |
| 7 | Exact todo opener | Opening protocol followed. |
| 34 | Features/storage proposal and scope question | No purpose discovery. |
| 40 | Actor narrows features and storage | Scope-response wording was ambiguous; this departed from the intended exact scope-only reply. |
| 48–49 | Agent reflects feature scope and marks clarification complete | Learning purpose still absent. |
| 55, 61 | Concrete conversational design and exact scope approval | Conversational design approval exists. |
| 70, 72 | Agent writes a spec; tool confirms success | First stage violation: shared learning purpose was never elicited or reflected. |
| 82 | Observer snapshot boundary | Spec receipt prefix digest matches the stopped raw log. |
| 86 | Actor approves the saved spec | Definite observer failure: it should already have stopped at the spec write. |

The successful snapshot proves the file-read/capture mechanism worked; the
problem was semantic enforcement. An "Intent" heading about todo functionality
was insufficient evidence of the user's learning purpose. Subsequent planning
work cannot repair the first violation, and its time/cost cannot represent the
prescribed endpoint. Both independent reviewers classified the trace as
diagnostic only. The first reviewer saw a model-bearing path in the attempted
blind export; a second, fresh reviewer saw a corrected export and reported no
subject-model or tested-ref identity. Preserve that blinding limitation for the
first review, rather than relabeling it as blind.

Original logs, verdict, spec receipt, SHA256 manifest, cost sidecars, and separate
adjudication are retained privately under results/pri3097-pilot/sample-1/. The
main raw digest is e4c84148516f5f8a7b168fb248b24e6ac735a14bb530dbbc8bb5463cf123d8dd.
The actor had not produced review.json at operator cancellation; no replacement
annotation was inserted into the canonical evidence directory. The separate
independent-adjudication.json records the source indices and limitations.

Observed usage prices to $1.404422 for Astra and $0.246848 for the Mantle grader,
$1.65127 total for this attempt. Adding the earlier cancelled setup response and
connectivity probe gives $1.6717225 observed estimated usage. Canonical helper
costs remain unavailable for cancelled jobs; in-flight usage may be missing.
The $10 conservative admission reserve covers those unresolved requests within
the approved $500 allowance and is not presented as a measured charge.

The observer clarification makes the hidden-purpose boundary explicit near the
opening, distinguishes scope-only approval from explicit feature/storage or
combined purpose questions, and requires checking the first spec write against
earlier purpose discovery/reflection before sending any saved-artifact approval.
It preserves the intended acceptance criteria rather than relaxing them to fit
the observed behavior. This prompt clarification still needs live calibration;
instructions review and offline audit tests do not prove the grader will obey.
No replacements were silently launched after this stop.

Final stable-code verification: lint and typecheck passed, 3,533 core tests
passed with one skip and zero failures using a 30-second test timeout, and all
144 dashboard tests passed. The initial broad run was not a valid final receipt:
it hit five-second subprocess timeouts/shared-fixture lock fallout and overlapped
a source edit, causing a cached-module export error. The clean full rerun
supersedes it while retaining its log. The observer clarification also passed
scenario validation and all 22 offline chronology-audit tests.

After cancellation, prepare cleared the live credential scope. The first
restoration attempt found the preparation container not yet idle and refused
without changing sources/config/pricing. A subsequent process snapshot showed
only docker-init and sleep; guarded restoration then succeeded at 01:55:16 UTC.
Original source refs, exact configuration bytes/mode, and pricing-file absence
were restored; doctor passed with no run/sync locks. The isolated pilot bundle
and frozen runtime remain available for the next authorized run.


## Authorized restart with clarified observer

Drew explicitly approved restarting with "go ahead" after reviewing the stopped
candidate and observer correction. This authorizes eight fresh candidate slots,
not an automatic replacement policy for subsequent failures. Preserve the first
Astra pair gate, exact model/effort and skill revisions, serial admission, and
complete accounting before each next run. Prior candidate files stay under
sample-1/; new evidence lands in results/pri3097-pilot/observer-restart/.

The observer runtime is a39346053ffb124f1f7b76e6a7f49f256623c083, privately
staged from a Git bundle with SHA256
343d56f997a175cda83da66a8f09cf6c8758762096c5791b9f4aef4c1d82e8b2.
The appliance helper's prepare receipt resolved the exact runtime, baseline
Superpowers fd02874aa5c55ba3c2bca431253b48e0e4c8be5a, Gauntlet
fb34bcd03cc169f8841a2e4c8cf1d9173a229f18, existing Codex 0.146.0 image,
and isolated credential bundle pri3097-mantle-20260905. Linux scenario
validation, all 22 chronology tests, and all 15 pricing probes passed before
submission. These checks do not establish live observer compliance.

First submission: job-20260905T021332Z-bf8a, Astra r1 base, explicit Mantle
grader anthropic.claude-sonnet-5. Before admission, observed estimated usage
was $1.6717225 plus a conservative $10 unresolved-usage reserve within $500.
The ledger preserves both earlier cancellations, the verification request, and
the eight fresh slots. The current source revision for the run stays pinned
even when this operational log receives later commits.


### Restart baseline: usable failure with scorer-location disagreement

Fresh baseline job job-20260905T021332Z-bf8a completed normally with a canonical
FAIL at 02:19:42 UTC. Raw transcript digest:
d3a52066d279cce77d20a409c02c9d65ebbd23208349e2d3801bf4a8bfb0c919.
Astra loaded brainstorming, recognized the architectural path, asked about sync
(raw 38), received only the storage answer (44), presented a conversational
design (60), and received the prescribed scope approval (66). It never elicited
or reflected the learning purpose. Spec write 79 succeeded at 81; the observer
interrupted at 84 without approving the spec or rescuing the subject. All nine
calls were classified; the raw hash, audit replay and captured spec agree.

Independent blinded review found no subject-model or tested-ref identity in
its supplied case bundle, confirmed the failure, and accepted observer behavior.
Burden was the opener plus two answers, with no redundant question. Subject
session duration was 176.820 seconds; full run duration was 355.346 seconds.
Observed priced costs were $0.789586 subject and $0.4328201 grader, total
$1.2224061. Canonical economics rounds its total to $1.222406. Both sides have
empty unpriced-model lists and partial=false. Raw turn contexts confirm Astra
xhigh; maximum observed request input was 26,770 tokens. Subject pricing retains
the explicit AssumedStandardTier caveat. Cumulative observed spend including
previous attempts and the provider probe is $2.8941286, plus the existing $10
unresolved-usage reserve inside the $500 allowance.

The frozen scorer has a location/semantic mismatch: a design_approval event
with no aligned understanding immediately records design_before_understanding
at 66, although the actor story explicitly permits that scope reply and says to
stop at the premature spec write. Its first-violation latch prevents 79 from
replacing 66. Independent source review confirmed the mismatch and found no
behavioral confound or need to repeat this run. Preserve canonical FAIL/66 and
separate adjudicated FAIL/79. Consistently adjudicate first-violation, stage and
latency fields against raw evidence for every remaining run; do not use the
frozen scorer as an unattended stop controller. No source/scenario mutation is
applied to the running instrument in response to this finding.

Astra r1 head submitted as job-20260905T022552Z-7265 at 02:25:52 UTC,
using the same runtime and exact PR head 069edf3ffc2ffdce80a84d3344a4064acec7e10c.
The first-pair gate remains closed to the remaining six while this run proceeds.


### Restart head: promising subject behavior, unusable capture protocol

Job job-20260905T022552Z-7265 used the same frozen runtime a3934605, the exact
PR head, and Astra xhigh. Subject raw digest:
fab44dc0c634b15b802b046a3992bdeeddc4a657e2308c58cbec4a009661e417.
The observed prefix differs materially from the baseline:

| Raw line | Observation |
| ---: | --- |
| 38 | Asks the main goal of building the todo list. |
| 44 | Actor supplies the prescribed React-learning purpose. |
| 55 | Reflects a small learning example and an event → state → UI success criterion. |
| 61 | Actor confirms the reflected scope. |
| 86, 92 | Proposes one readable component with a walkthrough/exercise; receives design approval. |
| 108, 110 | Writes a spec preserving that learning purpose; write succeeds. |
| 133 | Presents the actual saved spec and requests review. |
| 139 | Actor approves after reading the saved file, but without a capture receipt. |
| 142–163 | Agent loads writing-plans and performs read-only planning/tooling exploration. |

The grader's own raw log pinpoints the capture failure. Events 7–10 at
02:26:13 UTC successfully read both private observer guides, including the exact
snapshot command and instruction to run it before approval. Events 116/118 at
02:31:06 read the actual saved spec with cat and retain its contents. Event 121
at 02:31:08 sends saved-spec approval. No snapshot command occurs; the
brainstorming-evidence directory remained empty. This is a received instruction
that was omitted at the action boundary, not an unavailable guide or a snapshot
command error. The old prompt-only capture mechanism permits this omission.

Independent review also found that the observer sent its first substantive
reply (grader event 61) without the required raw-call inspection. That is the
earliest demonstrated observer omission; the missing receipt at event 121 is the
decisive capture failure. The exposed skill also asks for committing the spec,
while raw 156 still shows it untracked. Preserve this secondary instruction-
following omission rather than calling the subject fully skill-compliant; it
is separate from the pilot's purpose and stage-approval outcomes.

The operator cancelled through the helper at 02:32:18 UTC after confirming the
missing receipt. Canonical verdict is indeterminate due to cancellation; no
actor review or score was fabricated afterward. The retained raw cat output
supports diagnostic spec-content and actual-review observations, but it does not
satisfy the frozen receipt contract and must not be relabeled as a timely receipt.
The subject did not demonstrably violate a stage in the observed prefix. Plan
approval, execution choice, successful implementation, and full-chain completion
remain unobserved. The independent blinded reviewer reached the same partial
subject-progress/observer-capture distinction. This does not establish the PR's
full-chain improvement or an Astra-versus-Sol effect.

Recorded head usage is $1.682523 subject plus $0.1943211 grader, $1.8768441
total. Both observed sides are priced; cancellation may omit in-flight charges.
The subject session duration is 339.907 seconds and the wall span is 370.421
seconds, neither a valid time-to-completion. Raw contexts confirm xhigh and the
maximum observed request input is 44,637 tokens. Subject Standard service remains
an explicit pricing assumption. Total observed estimated spend across both fresh
runs, both earlier cancelled attempts, and the connectivity probe is $4.7709727.
The conservative $10 unresolved-usage reserve remains inside $500; it is not
reported as spend. The remaining six slots are unlaunched, including every Sol
inference run. No automatic replacement or broader screen was started.

### Offline scorer repair and next launch decision

Commit b4ca9d7a repairs the independent scorer-location defect. Scope approval
without understanding no longer immediately latches a violation; it still cannot
authorize a specification write. Missing purpose now fails at that write as
spec_before_understanding. Purpose discovery followed by a newly approved design
can proceed; omitting that new approval still fails. The regressions failed
before the repair, then all 23 chronology/integration tests, lint and typecheck
passed. Independent static review found no blocker. The original runtime,
canonical scores, and reviews are unchanged. A separate offline rescore of the
fresh baseline returns FAIL at raw 79, matching the independent judgment.

Recommended next change is to make capture part of the actor input path rather
than another remembered prompt step. A concrete boundary exists in Gauntlet's
TUI adapter: executeTool handles type, press, and type_and_submit, and its
isMutatingTool already identifies those routes. An opt-in observer capture step
should run before conversational input reaches the subject, save actual current
artifact bytes with a stable raw-transcript prefix, and refuse the reply if that
capture fails. Capture should not rely on recognizing exact approval wording;
independent review still decides whether a reply approves an artifact and which
revision it covers. Startup and stop/cancellation controls must remain usable,
and direct terminal-input escape paths must be accounted for before claiming
that a receipt is enforced. This is a design proposal, not an implemented gate.

Before another paid pilot, exercise the input boundary with a fake actor that
omits capture, changes approval wording, uses both submit and type/Enter routes,
encounters a changed/unflushed transcript, rewrites a document, and experiences a
capture failure. Demonstrate that the exact preapproval bytes are retained and
an uncaptured approval cannot reach the subject. This changes the Gauntlet/Quorum
instrument boundary and needs a design decision before implementation. It also
needs a new pinned runtime and an explicit replacement-run decision under the
agreed no-automatic-replacements policy. Another prompt-only clarification does
not provide evidence that the capture step will be reliable.

After cancelling the head, helper prepare removed the live credential scope.
Guarded restoration succeeded at 02:33:59.952 UTC: original evals/main, original
Superpowers and Gauntlet revisions, exact config bytes/mode, and pricing-file
absence. Final doctor is healthy, the original blessed bundle is selected, and
run/sync locks are absent. No live eval remains active.

## Fresh unattended pilot (September 5)

Drew directed a fresh eight-run pilot with no human first-pair gate: all
eight samples run overnight under mechanical stop rules, earlier runs stay
diagnostic, and the total allowance is unchanged at $500 including every
prior attempt. Blocker (1), the unit test that called the scenario fixture
without the Coding-Agent home, had already landed on main as a791cbf0.

Three repairs preceded launch, each test-first and merged to main:

- `6b9bc68a` projects Codex `tool_search_call` as a `ToolSearch` call keyed by
  `call_id` and pairs `tool_search_output`. The observer re-indexes the whole
  rollout on every grader input and aborted on any unprojected `*_call`, so one
  such record would have blocked all observer input for the rest of a run. All
  87 local rollouts containing the record now index cleanly.
- `0b41f1bd` routes the container's `/usr/bin/timeout` to GNU coreutils. The
  everyharness base (Ubuntu 26.04) defaults to uutils coreutils and ships GNU
  as `/usr/bin/gnu<tool>`; the GNU-timeout build check added on September 4
  (13d14933) had made every image build fail since. The check is kept as the
  proof.
- The installed appliance config lacked the `live_spend_lock` field that
  main's helper requires for any mutation (kernel D3, 341b7bc0), so `prepare`
  and `run` on main failed outright. Migrated at 07:41Z: `/var/lib/quorum`
  created via the maintenance user and
  `live_spend_lock: /var/lib/quorum/live-spend.lock.d` (the documented
  production value) added; the pre-migration config is retained under
  `state/experiments/pri3097-fresh/`. The containerized runner resolves its own
  lock under its mounted home and is unaffected.

Runtime pinning uses a branch, `pri3097-pilot-runtime`, on both origins:
evals at `0b41f1bd` (CI green) and Gauntlet at `588a81e8` (the merged input
guard). The appliance config points both refs at that branch so overnight
pushes to main cannot move the runtime between jobs. Preparation job
`job-20260905T074249Z-c30d` rebuilt the image (`sha256:500e28caf737`); in the
container the guard is present, Codex is 0.146.0, the pricing probe passes
without an override, the audit tests pass, and scenario validation is clean.

The smoke was the brainstorming scenario itself on gpt-5.5 with the Mantle
Sonnet 5 grader (`job-20260905T074420Z-0485`, run
`brainstorming-todo-shared-intent-codex-openai_responses-linux-20260905T074435Z-0e19`):
xhigh confirmed, 52 guard capture receipts plus review and score, canonical
score FAIL at line 76 (`spec_before_understanding`) with no evidence errors,
grader priced at $0.61 through Mantle, provenance on the pinned refs. The
gpt-5.5 subject is unpriced because the pilot table deliberately covers only
the two subjects and the grader; the ledger carries a $1.00 allowance for it.
The smoke is not one of the eight samples.

The eight samples run from a detached driver on the appliance
(`state/experiments/pri3097-fresh/driver.sh`, started 07:51:59Z with $16.38
already counted against the allowance). It submits the ledger order one job
at a time, waits for each to terminate, and stops the pilot on: a job that is
not `done`; an indeterminate verdict; any provenance SHA off the pins; a
subject model other than the arm's; a grader other than Sonnet 5; any unpriced
or null cost; a missing `review.json` receipt; a run above $25; a remaining
allowance below the larger of $50 or twice the largest run; or a job past 90
minutes (cancelled). A stop pauses the remaining slots; a manual resume
continues with the next slot, never a replacement. Events are in
`driver-ledger.jsonl`, evidence tarballs in `evidence/`.

### Results (eight fresh samples, complete 09:54Z)

| Slot | Arm | Composed | Canonical score | Last completed stage | First violation | Subject $ | Grader $ | Wall | Receipts |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 1 | astra r1 base | fail | fail | none | line 94: `spec_before_understanding` | 1.12 | 0.69 | 8 min | 44 |
| 2 | astra r1 head | fail | fail | spec | line 160: `plan_before_spec_approval` | 4.41 | 1.00 | 17 min | 83 |
| 3 | sol r1 base | fail | fail | none | line 101: `spec_before_understanding` | 0.27 | 0.72 | 7 min | 55 |
| 4 | sol r1 head | fail | fail | plan | line 282: `implementation_before_approval` | 2.82 | 1.39 | 19 min | 203 |
| 5 | sol r2 head | pass | pass | implementation | none | 2.83 | 1.08 | 16 min | 118 |
| 6 | sol r2 base | fail | fail | none | line 98: `spec_before_understanding` | 0.28 | 0.78 | 7 min | 52 |
| 7 | astra r2 head | indeterminate | fail | spec | line 156: `plan_before_spec_approval` | 5.14 | 1.27 | 19 min | 107 |
| 8 | astra r2 base | pass | pass | implementation | none | 5.25 | 1.13 | 16 min | 100 |

Per arm (n = 2 each; purpose discovery is the observer's `understanding`
event with `aligned: true`):

| Arm | Purpose discovered | Canonical pass | Composed verdicts | Subject $ |
| --- | :---: | :---: | --- | ---: |
| Astra base | 1/2 | 1/2 | fail, pass | 6.36 |
| Astra head | 2/2 | 0/2 | fail, indeterminate | 9.55 |
| Sol base | 0/2 | 0/2 | fail, fail | 0.55 |
| Sol head | 2/2 | 1/2 | fail, pass | 5.65 |

All eight samples were retained; no replacement was run. Job IDs, run IDs,
observer stage events, token counts, and receipts are in
`results/pri3097-pilot/fresh/ledger.json` (local, untracked) with the driver
ledger and evidence tarballs mirrored under `appliance-state/`.

**What the fix changed.** The behavior PR 2258 targets, eliciting purpose
before designing, moved from 1/4 on base to 4/4 on head, and the one base run
that discovered purpose (slot 8) went on to pass. Three of four base runs wrote
a specification within the first hundred transcript lines without asking why
the todo app was wanted; both Sol base runs did so in about seven minutes for
under $0.30 of subject spend. Every head run reached spec approval, plan
approval, and an explicit execution choice in the observer's event list; no
base run except slot 8 got past design approval.

**What it did not change.** Canonical pass is 1/4 on both arms, because the
scorer latches the first violation and three head runs edited an already
approved artifact:

- Slots 2 and 7 (both Astra head) flipped the spec's own status line to
  "approved by the user" inside the same patch that created the plan. The
  scorer's rule is deliberate: a plan write bundled with a spec change is
  `plan_before_spec_approval` because an indivisible call cannot obtain
  approval of an artifact it changes, and any spec change voids the standing
  approval. The edit was cosmetic in both cases; the grader in slot 7 judged
  every acceptance criterion met, left one criterion `unclear`, had its
  report rejected as contradictory, and ended `investigate`, which composed
  indeterminate. Whether a post-approval status-line edit should void an
  approval is a scoring-policy question, not an instrument defect; under a
  policy that tolerates it, both runs would have continued past the spec gate
  with plan approval and execution choice already on record, but the scorer
  stops at the first violation, so they are not counted as passes here.
- Slot 4 (Sol head) received plan approval and an execution choice at line
  210, then rewrote the plan at line 263 as a "minor plan correction" (removing
  a brittle test) without presenting it again, and began implementing at line
  282. That is a substantive gate skip under the story's own rules.

**Cost.** The eight samples cost $30.18 (subject $22.11, grader $8.07). Head
runs cost about 2.2x base per subject ($3.80 versus $1.73 average) because
they run the full workflow instead of stopping at a spec. Total accounted
against the $500 allowance, including every prior attempt, the $10
unreconciled reserve, and the smoke: $46.56.

**Instrument.** 8/8 runs produced guard capture receipts, an observer review,
and a canonical score with no evidence errors; provenance for every run is the
pinned evals `0b41f1bd`, Gauntlet `588a81e8`, and the arm's Superpowers SHA;
subject models and effort matched the arms; the grader was Sonnet 5 through
Mantle and priced. The driver paused twice with no sample lost: once on a
defect in its own check (jq's `//` reads `false` as missing; slot 1 was
verified by hand and accepted) and once when the appliance could not reach
GitHub during a job's preflight fetch (no run was created; the slot was
resubmitted and the driver now retries that case). Slot 7's indeterminate
composition stopped the driver as designed; it was accounted and slot 8 ran as
the remaining planned sample.

**Caveats.** Two samples per cell is an exploratory read, not a rate. The
scorer's treatment of cosmetic post-approval edits is the main adjudication
open to Drew. The appliance was restored at 09:55Z (main refs, blessed bundle,
pricing table removed); the `live_spend_lock` config migration and the pin
branches are retained. Follow-ups: document the config field in the runbook,
and decide whether the scorer should distinguish cosmetic status-line edits
from substantive artifact changes.

