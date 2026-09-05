# PR 2258: Astra and Sol brainstorming evaluation

**Status:** The eight-run pilot is running with a $500 total allowance under
[PRI-3097](https://linear.app/prime-radiant/issue/PRI-3097/evaluate-pr-2258-brainstorming-with-astra-and-sol).
Both subjects use the direct OpenAI Responses API at xhigh; the grader uses
Sonnet 5 through Mantle. The cancelled pre-verification attempt is retained
separately, and the first Astra pair must pass evidence review before the
remaining six runs. No behavioral outcome is claimed yet. Fractals and the
broader screen remain subsequent work.

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
