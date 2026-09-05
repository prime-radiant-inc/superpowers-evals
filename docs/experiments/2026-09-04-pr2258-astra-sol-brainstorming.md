# PR 2258: Astra and Sol brainstorming evaluation

**Status:** Core pilot instrument implemented under
[PRI-3097](https://linear.app/prime-radiant/issue/PRI-3097/evaluate-pr-2258-brainstorming-with-astra-and-sol):
the original todo reproduction, observer receipts and offline chronology audit,
four pinned arms, and an eight-run suite. No live runs or model calls have been
performed for this experiment. Drew approved both models at `xhigh`, fractals,
and focused new cases plus existing regressions. The remaining eight new cases
and broader screen are subsequent work, not part of this first implementation.
The proposed budget and run counts are not live-spend authorization.

**Question:** Does [Superpowers PR 2258](https://github.com/obra/superpowers/pull/2258)
make Astra establish and preserve shared understanding through brainstorming,
specification, and planning? Does it also help Sol, and what does it cost in
completion, latency, tokens, and human attention?

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
not isolated model weights. Prefer Codex CLI 0.153.0 to match the reported research;
using the previously exercised appliance's 0.146.0 build is a distinct environment
that must be fixed for all four arms and recorded before launch. This local
checkout currently has Codex 0.148.0; it has not run this pilot.
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
- [Eight-run suite](../../suites/pr2258_brainstorming_pilot.yaml), with two
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

Propose two subject slots, admitting one baseline/treatment pair at a time,
with the same resource conditions for each model. The nominal envelope is four
30-minute pair waves, approximately two hours plus setup and independent review;
allow roughly three hours for a same-workday pilot readout. If the approved
appliance helper only supports serial jobs, the eight-run cap becomes four
hours plus overhead. Verify its supported surface before choosing that venue;
do not bypass the helper or imply that a suite file configures host concurrency.
No automatic replacements, diagnostic extensions, or 204-run screen follow.

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
The first pair must be inspected before admitting later pairs if observed
cost or evidence quality invalidates the estimate.

The preceding PRI-3088 report (commit bd0620a0, separate branch) reports $54.695
for 30 different measured runs plus $2.876 for two smokes, using high effort.
It is useful scale context, not an xhigh todo forecast. Its reported accounting
used an explicit pricing correction. Installed obol 0.9.0 alone does not prove
Astra/current Sol price coverage. Before live authorization, verify or freeze
price tables for both subjects and the grader, and validate any campaign
admission estimates separately from final captured token costs. Never price
an unknown model as zero or treat an admission override as final accounting.

The remaining launch preflight must record the exact evals commit, Gauntlet
commit (local source currently fb34bcd03cc169f8841a2e4c8cf1d9173a229f18), Codex
binary/image, selected credential bundle identity, native instruction digests,
current endpoint access, effective xhigh, pricing-table digest, supported helper
command, concurrency, and spend-lock status. The
[appliance runbook](../appliance-runbook.md) remains the operator authority.
A desktop model-picker entry is not appliance API access. The earlier helper
had no campaign verbs; current support has not been verified in this task.
These are explicitly unverified launch conditions, not reasons to claim that
the locally validated suite is already deployed or running.

Record every admitted run ID, toolchain/protocol revision, accounting total,
negative outcome, and adjudication in the eventual readout. Pilot results remain
separate from the planned fractals cases and the 204-run exploratory screen.
