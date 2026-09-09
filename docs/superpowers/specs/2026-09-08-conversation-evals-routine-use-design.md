# Conversation evals: routine Superpowers comparisons

Status: revised after the committed review-team findings; implementation plan
requested for review only. Drew explicitly withheld execution. Continue the
existing PRI-3102 work.

## The next stage

A maintainer can answer a concrete question through the ordinary eval workflow:
**what changes when this pinned Superpowers revision is installed, compared with
stock, for the same task, coding harness and model?** They can author a scenario,
select the existing arms, submit an appliance-owned comparison, leave it running,
and inspect quality, elapsed time, cost and the evidence through normal reports.

This increment delivers that workflow for a declared useful task set, with the
scenario, simulated-user, grading and readout improvements needed to interpret
it. Routine hardening belongs inside this release. Individual bugs do not each
become another design project or another request to approve continuing.

The default first question is current Superpowers versus stock. Drew may select
a particular change or a model/harness question during spec review; that changes
the experiment's arms, not the implementation architecture. The default skill
revision is the currently qualified `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.
Use an exact commit, never a floating `main` reference inside a registered run.

Success does not require Superpowers to win. A well-supported negative result
is a successful evaluation. An invalid interaction or unsupported grade is a
defect in the instrument and cannot establish the treatment's effect.

## Starting point: preserve the progress

The implementation baseline is Quorum
`b0353a10d8c8eddb69b04eb899d73f0e981fdad8` and Gauntlet
`256feaea65ea0016dec4133f2cd031bd72be8754`, already on main and installed for
canonical campaign execution. The held grading prompt `9b6859b2` is rejected.

| Capability | Existing evidence | What this release adds |
| --- | --- | --- |
| Natural-language scenario authoring | Conversation scaffolding, brief/private-rubric projection, setup/check helpers and documented recipe | Clear authoring conventions and one newly authored repair scenario |
| Live user-driven execution | Two completed twelve-cell Claude/Codex batches across six task families | Faithful clarification, engineering delegation and stopping behavior |
| Pi | Pricing and code-review engine qualification completed | Stock/treatment code-review comparison within this qualified surface |
| Appliance ownership and reports | Register/run/status/costs/report and authenticated `quorum show` targets work | A useful comparison readable through those commands |
| Concurrency | Two Claude and two Codex conversations overlapped; matched four-cell pricing cohorts took 1062.797s serially and 331.414s at cap four | Exercise existing concurrency during acceptance; no new capacity study |
| Assessment | Canonical criterion text, complete ordered rows and derived status are enforced | Individually visible obligations and supported decisive reasoning |

The observed 3.21 throughput ratio is a historical small-cohort result, not
sustained capacity or a measured improvement over the old engine. The latest
grading candidate matched three of five criterion vectors, but only two
assessments had supported decisive reasoning. That is a failed bounded
diagnostic, not an estimate that the whole product is 40% accurate.

The prior proposal to make another first concurrency proof the next milestone
is superseded by this spec. Existing scenarios and qualified behavior are not
removed when the release acceptance matrix is narrower than the whole catalog.

## Scope and approach

Deliver four connected parts as one release:

1. Outcome-based scenarios with explicit user context and individually graded
   obligations.
2. A faithful simulated user using the current live terminal driver.
3. One assessor with an evidence-backed submission contract and a fixed
   regression set.
4. A normal comparison report and a fresh Superpowers-versus-stock campaign.

Three implementation streams can proceed together: scenario/driver fidelity,
assessment/qualification, and comparison/readout. They converge on one reviewed
source pair and one release acceptance matrix. The implementation plan assigns
shared files explicitly; it must not let independent workers edit the same
scenario or Gauntlet entry point concurrently.

We considered another instruction-only grader experiment: it is cheaper but
does not expose the hidden conjuncts or unsupported evidence bases responsible
for the observed misses. A general evaluation platform, dialogue state machine,
grading ensemble or adjudication service adds larger interfaces before this
workflow needs them. Use the current Quorum workers, Gauntlet roles, credentials,
source snapshots, scheduler and standard report schemas.

All-harness qualification, wholesale legacy QA migration, sustained high-load
capacity, new credential mechanisms, automatic model rankings and deeper
statistics remain later work. Fixing an ordinary defect in the included flow
is in scope; replacing an orchestrator or expanding a security boundary is not.

## Scenario and user contract

Keep `story.md`, `setup.sh`, `checks.sh`, fixtures and generated manifests.
Authors describe intent and facts in prose; they do not prescribe dialogue
turns, tool sequences, skill invocations or model answers.

Before `## Acceptance Criteria`, use clear prose sections for the actual user
request, context available when relevant, and when the user is finished. These
are authoring conventions within the existing projection, not a new parser or
fact/state DSL. The Coding-Agent receives the actual request and subsequent
natural answers, not the full simulator brief. The driver never receives the
private grading criteria or deterministic checks.

The driver must:

- Answer questions within their reasonable scope. A channel question can
  elicit an in-page notification preference; it does not automatically elicit
  which tasks to watch. A broad question about desired behavior can elicit
  several relevant preferences. Equivalent questions are valid.
- Supply product facts and authorized choices, while leaving unstated
  engineering decisions to the Coding-Agent. Review suggestions are proposals
  to evaluate, not commands to obey. Neither push `time.time()` nor coach the
  agent toward `time.monotonic()`.
- Preserve missing clarification and bad decisions as observable behavior.
  Do not rescue a proposal with unsolicited requirements, demand a missing
  test, identify the defect, or prolong a bad delivery to improve its grade.
- Distinguish an intermediate plan or clarification from delivery. Stop when
  the requested result is presented for use or review, even if incomplete or
  wrong. A refusal declines the actual task; a failed command or rejection of
  one review note is not a refusal.

Scenario endpoints resolve the known ambiguities. Design ends at the delivered
proposal without authorizing application edits. Review-feedback ends at the
delivered disposition, including an incomplete disposition; an optional offer
to commit does not reopen it. Verification permits authorization already in
the initial request, but an asserted final delivery missing a commit is retained
as bad work, not coached into success. Terminal/startup failures remain execution
errors. Preserve the existing capture-backed completion record and deadlines.

Split independently failing obligations into separate top-level acceptance
criteria using the existing Markdown format. In particular, separate watch
selection from notification channel, watch-to-notice behavior from generic
proposal quality, and actual verification from truthful reporting of its history.
Do not mechanically split every conjunction: legitimate alternatives and
qualifications must retain their meaning.

For existing regression cases, author separately identified decomposed rubrics
with an independently reviewed mapping to each original obligation, preserving
alternatives and fail/unclear semantics. Require each atomic judgment to match
its independently supported expectation and the folded judgments to reproduce
the settled original results. Matching original results alone cannot establish
that the decomposition preserves meaning.
Keep original rubrics, gold and evidence unchanged. Every acceptance scenario,
including existing ones, must allow stock agents to pass through equivalent
good behavior. Setup and checks must support both conditions; using a named
skill is not the behavioral oracle for this comparison.

## Assessment contract

Retain one independent assessor, indexed evidence reads, the existing repair
loop, canonical criterion text and fail/unclear/pass reduction. The change is
what the assessor must submit for each criterion:

- `verdict`: pass, fail or unclear;
- `observation`: the decisive delivered claim, behavior or identified omission;
- `basis`: why that observation satisfies or violates this criterion;
- `limitations`: material contrary evidence or uncertainty, including an
  explicit statement when none was found;
- `references`: nonempty indexed paths whose contents were successfully delivered
  in the assessor's history before the report-generating response, supporting
  the observation and its limits.

Failed reads and newly requested reads in the same response as the report do
not qualify; an earlier successful delivery of the path can. Reference validation
establishes prior availability to the model, not comprehension or semantic
correctness. An empty evidence index is an input error before the first provider
request; a valid unclear judgment can cite available but insufficient evidence.
An omission can cite the inspected question sequence and complete proposal. An exploit claim must be considered
alongside the actual source and missing driver contract. A test-history claim
must be compared with the relevant command results and their order, preserving
the difference between initial failure and final recovery.

Reject structurally invalid submissions through the normal typed tool-error
repair path. Do not require a quotation of absent text, a special citation
grammar, exact gold wording or identical reasoning. Literal quote matching
would not establish that a cited fact supports the inference, so it is not a
new gate here.

Render the accepted basis into the existing persisted criterion `evidence`
string with readable observation, basis, limitations and source labels.
Keep the ordinary result schema, writer, Quorum composition and immutable
historical reports. Generic Gauntlet QA is unchanged. Do not add a legacy
submission adapter; update the actual assessment callers and paired fixtures.

## Comparison and ordinary readout

Use explicit stock/treatment pairs within each harness/model route. Only
Superpowers installation differs within a pair. Pin the subject credential,
effort where supported, fixture, rubric, driver/assessor configuration, source
revisions and image. Stock is `superpowers: none`; treatment is the selected
skill commit. Credential-backed model selection and existing compatibility
validation remain authoritative. Cross-harness results describe different
stacks and must not be mislabeled as an isolated model comparison.

The standard command journey remains:

`quorum new` → edit → `quorum check` → commit scenario/arms/suite →
`evals-appliance campaign register` → `run` → `status`/`costs` → `report` →
the authenticated `quorum show` targets printed by the report.

The terminal report must expose baseline/treatment roles, planned and usable
pair counts, quality outcomes, existing comparison deltas, elapsed times, costs
and coverage using data already in the report. Preserve every failed,
indeterminate or unpublished attempt in its proper denominator and accounting.
`quorum show` retains completion, independent checks and each assessment basis
as separate facts, with usable pointers to the conversation and delivered output.

Make the existing validity boundary explicit: authenticated/analytically usable
evidence is not a certification that the driver or grader was semantically
correct. Original automated judgments are never silently overwritten by a
release reviewer. A dated release audit may bind independent findings to exact
report/attempt identities, but the normal comparison must be understandable
without a bespoke parser or a parallel reporting product.

## Fixed release acceptance

### Before provider execution

Complete source review and meaningful offline checks together. Exercise actual
brief/rubric separation through the paired CLI, independent checks, report
rejection/repair, prior-response evidence delivery, writer/exit/consumer behavior,
refusal/error distinctions and no further subject input after completion. Test
report data and behavior rather than large generated strings or prompt wording.
Preserve completed bad work.

Freeze the source pair, case identities, derived-rubric mapping and independent
expectations before qualification. An independent reviewer establishes expected
judgments without reading candidate outputs. Disagreement needs resolution from
the criterion and primary evidence before that case runs; candidate disagreement
alone never changes gold. Freeze input/evidence digests and expected judgments
for each decomposed criterion, not just the original overall result.

### Instrument qualification

**Assessment: nine cases, two repetitions each, 18 assessment sessions.** Use
the latest five retained grading cases, the real Claude debugging false-history
case, its passing Codex debugging counterpart, and verification controls e/f
from the release corpus. These distinguish required omissions, conditional
security risks, unsupported exploit assertions, correct recovery, false accounts
of original tests, and false final success. Require every atomic verdict to
match its frozen expectation, every folded original verdict to match, and all
decisive rationale to be materially sound, including the overall explanation.
Alternative supported explanations are acceptable.

**Driver: six controlled subject situations, two repetitions each, 12 conversation
sessions.** Exercise narrow versus broad preference questions; an unstated
engineering choice with a tempting wrong suggestion; authorization already in
the request; intermediate plan versus bad final delivery; feedback disposition
with an optional offer of more work; and partial-note rejection versus actual
task refusal. Score permissible acts, not exact response text. Use the actual
driver/model path against short controlled subject exchanges. Each repetition
exercises the complete named situation, including both contrasting acts where
listed. The controlled subject must not coach, parse for a preferred answer or
repeat until the driver succeeds; keep these fixtures outside the ordinary
scenario catalog. Scripted-provider unit tests establish plumbing, not semantic
compliance. Each qualification session has a two-minute role deadline plus the
existing bounded process cleanup.

Reuse the existing child process, lease, credential projection, scoped reads
and returned-turn accounting for these finite qualifications. Factor shared
mechanics out of dated callers only where necessary to avoid copying another
operator. Historical experiment policies and frozen results stay intact. There
is no new admission, recovery, journaling or general replay service.

Run the complete declared qualification set for diagnosis after a valid semantic
miss. Missing required evidence, an unrepaired invalid final result, settled
accounting failure or lost ownership stops further admission. Normal typed
submission repairs stay within their original session. A miss fails that
candidate's qualification; a later candidate requires a new frozen source
identity and the integrated repair round below, never an in-place prompt or
gold edit.

An independently substantiated expectation or mapping defect is distinct from
a candidate semantic miss. Preserve the original judgments, candidate results
and review history; mark the affected qualification unqualified and pause its
remaining admissions while primary evidence resolves the issue. Candidate
output or disagreement alone cannot establish a defect. A substantive correction
gets separately identified rubric/map/gold versions and an independently reviewed
semantic delta, then requires the relevant full qualification within the same
repair and allocation limits. It cannot retroactively promote an old candidate
or be described as lossless decomposition. A material change in what the scenario
measures returns to scope discussion; unresolved interpretation cannot establish
a treatment effect. No adjudication service is introduced.

### Fresh decision campaign

After instrument qualification, use one ordinary campaign with the following
matrix. Every pair has two predeclared repetitions, zero reserve and one attempt
per planned sample. Existing credential and resource caps still apply.

| Harness / subject route | Scenarios | Conditions | Repetitions | Attempts |
| --- | --- | --- | ---: | ---: |
| Claude / `opus5_bedrock`, high | design, code-review, review-feedback, new config repair | stock / pinned Superpowers | 2 | 16 |
| Codex / `openai_responses_56sol`, high | same four | stock / pinned Superpowers | 2 | 16 |
| Pi / `pi_gpt56_sol` | code-review | stock / pinned Superpowers | 2 | 4 |
| Total | | | | **36** |

The new repair scenario uses a small local config loader: explicit `retries: 0`
is incorrectly replaced by a default. The natural request asks for investigation
and repair. An independent oracle checks the documented override precedence
and preservation of explicit zero/false values; grading also checks whether
the agent's account of investigation and verification matches its evidence.
Author it with the normal scaffold and fixture/check helpers. It provides fresh
outputs rather than another replay of the same known answers; it is not claimed
to be a statistically independent held-out benchmark.

Use global cap four, the existing ten-minute conversation and two-minute
assessment bounds, and a 900-second outer attempt bound. Use
`sonnet5_bedrock` / `anthropic.claude-sonnet-5` for both evaluation roles and the
existing frozen pricing snapshot. The declared Pi scope is code review;
do not silently extend its scenario allowlist to the other families.

Independently inspect every fresh interaction and delivered result, and save
driver-fidelity findings and expected subject judgments before exposing the
official grade to that reviewer. Then inspect the grade and save assessment
support or disagreement against the same immutable evidence. Unresolved
independent interpretation remains unqualified, not automatically a grader error.
Use existing registration and retained launch/provisioning evidence to verify
the intended source/model/effort/image identities, stock absence of Superpowers
and treatment installation of the pinned revision. Record any unexpected
configuration difference before interpreting a pair. Reuse existing artifacts
and capability checks; this does not add a separate qualification campaign.
Completed bad implementations, reviews or refusals may pass the instrument
gate when faithfully driven and correctly graded. Coaching, material premature
or late stopping, false passes, or materially unsupported decisive reasoning
fail the release's qualification for routine comparisons.

Publish the ordinary report even when the release gate fails. Interpret the
stock/treatment results only to the extent supported by the audited evidence;
an unsupported or contaminated pair cannot establish a benefit or regression.
Do not convert its original automated grade into a silently corrected result.
Two repetitions and this task set establish bounded acceptance, not a general
accuracy rate, significance claim, all-harness coverage or sustained capacity.

## Hardening and execution envelope

The release has an initial integrated candidate and **one integrated repair
round**, not a succession of independently scoped single fixes. Collect findings
across the declared scope, repair them together, run affected offline checks,
and freeze the next candidate. Existing passing evidence can be retained for
unchanged components; changed role behavior must repeat its full qualification
set. Changes to a role's rubric, prompt, model/configuration, evidence projection
or shared dependencies count when they affect its behavior. Do not select
favorable repetitions or majority-vote a candidate through.

If fresh acceptance exposes a release-blocking defect, the same one repair
round can be used there instead. A changed final candidate requires a fresh
registration and the whole fixed 36-attempt cohort, not replacement of only
unfavorable cells. This is the same repair allowance, not an additional round.

For later execution approval, the maximum allocation is **two instrument
qualification sets (36 assessment and 24 driver sessions), two complete fresh
cohorts (72 coding-agent attempts), six hours, and a $150 observed stopping
threshold across all work**. Use only the stages needed; passing unchanged
stages are not repeated to consume the allowance. A role session may make
multiple provider requests; account for every returned turn and both evaluation
roles as well as coding agents. These are work/time bounds and an observed
cost threshold, not a hard provider invoice cap. Freeze one absolute cutoff
six hours after the first paid qualification admission. Intervening review,
repair and waiting time count; source freezes and new registrations never reset
the clock. These ceilings do not promise that every maximum stage will fit.

The appliance owns running work. Use existing status/costs/cancellation and
ownership paths through one finite appliance-owned release caller:

- Directly owned qualification sessions check remaining time and cumulative
  settled costs before each launch. Their role bound and cleanup must fit before
  the cancellation threshold, 60 seconds before the original cutoff.
- Ordinary campaigns keep their autonomous dispatcher. While a campaign runs,
  read status/costs and newly settled evidence, then wait at most 15 seconds
  before the next observation. Bound each observation to 10 seconds, with
  independent reads concurrent. Under a responsive owner, a boundary can take
  up to 25 seconds to be observed. Read failure or timeout requests cancellation.
  The cancellation-threshold timer runs independently of slow observations.
- Request existing cancellation when the $150 known subtotal is observed, a
  settled accounting/evidence failure is observed, ownership becomes unsafe,
  scope changes, or time reaches the 60-second cancellation threshold. Cancel
  active work as well; do not wait for it to consume its normal attempt bound.
  Admit no further qualification session or campaign after this stop decision.
  The 10-second read timeout does not kill an in-progress cancellation operation;
  retain ownership until it settles and verify termination through existing paths.
- Expected pending usage while a role runs is not an accounting failure. Missing
  or unpriceable returned usage after its role/attempt settles, lost required
  evidence or inability to reconcile an owned execution is. Preserve known
  subtotals and pending coverage rather than inventing zero cost.

This is observed campaign-level stopping, not a synchronous per-attempt release
budget guard. A campaign may start an intervening attempt before cancellation
is observed. Host stalls, cancellation and termination reconciliation can
overrun the cutoff; retain their duration, spend and termination evidence and
report the limit breach. The cutoff and reserve are stopping policy, not a
guarantee of a six-hour last-process exit or a hard invoice cap. Use existing
termination reconciliation rather than introducing new admission, scheduler,
budget-control or recovery mechanisms. Preserve all stopped and failed work.

Approval to execute the eventual plan includes these predeclared stages and
the integrated repair allowance; it does not require Drew to approve each bug,
case or supported source update. A framework replacement, new credential
boundary, another repair round or increased allocation returns to discussion.

## Delivery and definition of done

The stage is complete when a maintainer can use the documented ordinary journey,
the fixed instrument and fresh-comparison gates pass, and the exact reviewed
source pair is on main with passing CI and verified canonical campaign-source
installation. The final report answers the stock/treatment question with
explicit denominators and limits, including a supported no-benefit outcome.

Deliver the scenario conventions and new fixture, the driver/assessment
improvements, comparison readout, release suite, standard reports, bounded
independent acceptance findings and one updated product-status summary in the
release record. Show this checklist cumulatively in progress updates: authoring,
driver fidelity, assessment, comparison/report, installed acceptance. Do not
report an individual merged fix as completion of this whole milestone.

If the allocation closes before those gates pass, report a partial release,
the exact failed requirement and the preserved evidence. Independently useful
mechanical fixes may ship after their own gates; do not describe the routine
comparison milestone as complete or resume spending automatically.

## Code boundaries and evidence

- Quorum: `src/scaffold.ts`, `src/runner/conversation-input.ts` (preserve role
  separation), affected conversation stories/checks/fixtures, arms/suites,
  `src/appliance/campaign-render.ts`, existing CLI renderers and focused tests.
- Gauntlet: `src/conversation/converse.ts`, `src/assessment/{assess,report}.ts`,
  their tests and actual paired CLI fixtures. Preserve transport, startup fixes,
  evidence capture, result writer and generic QA.
- Qualifications reuse existing operator mechanics; implementation planning
  must name the necessary shared extraction rather than clone dated runners.
- [Original overnight milestone](2026-09-07-assessment-reliability-overnight-design.md)
- [Completed breadth and concurrency](../../experiments/2026-09-07-conversation-broad-signal.md)
- [Authoring/report release and fidelity failures](../../experiments/2026-09-08-conversation-release-results.md)
- [Driver endpoint and evidence findings](../../experiments/2026-09-08-conversation-reliability/results.md)
- [Completed Claude/Pi engine qualification](../../experiments/2026-09-08-conversation-startup-evidence/live-results.md)
- [Grading diagnostic and selected mechanics](../../experiments/2026-09-08-conversation-grading/results.md)
