# Repeatable Superpowers PR and release validation

Status: written design for Drew's review. The operator, execution, grading and
reporting contracts were agreed in conversation. Implementation and live
acceptance have not started under this design.

## Purpose and success

Given a Superpowers baseline and candidate, run a declared comparison across
selected harness/model combinations and deliver an evidence-backed report within
hours for PRs and experiments, and within 24 hours for releases. Routine use must
not require Drew to inspect transcripts, supervise execution, edit arm files or
commission another evals development project.

Parallelism is the primary throughput mechanism. Subject and grading budgets
follow the work. Do not shorten them, reduce coverage or lower grading standards
to manufacture a faster result.

Success is a useful comparison delivered on time. A valid finding that the
candidate regresses is a successful use of the lab. A timely report whose
required measurements remain untrustworthy is an honest incomplete result, not
successful release validation. The report informs Drew's release decision;
Quorum does not merge or publish a Superpowers release.

## Evidence and prior decisions

The September 10 read-only appliance inventory found 4,243 canonical verdicts,
281 additional archived run identities, 335 batches and 37 readable campaign
registrations. The earliest retained verdict found was June 23. This is a
metadata inventory with representative readouts, not a semantic audit of every
transcript or six complete months of appliance evidence.

| Existing workload | Evidence relevant to this design |
|---|---|
| [June 25 full-suite snapshot](../../experiments/2026-06-25-dev-full-suite-5agent.md) | 252 runs over five harnesses in roughly four hours. Useful behavioral observations survived incomplete pricing. This was an absolute snapshot, not a paired release comparison. |
| [July PR #1998](../../experiments/2026-07-17-pr1998-fix-loop-validation.md) | 93 measured runs supported merging while leaving two motivating claims unconfirmed or underpowered. The useful output explained the change and its limits. |
| [August release gate](../../experiments/2026-08-09-fresh-release-gate-readout.md) | The retained 388-run corpus spans 32.64 hours from first start to last completion, with 69.16 summed run-hours, mean overlap 2.12 and peak overlap four. Later normalizer corrections retracted descriptive model findings. Execution time and trustworthy interpretation both matter. |
| [September 4 multiharness comparison](../../experiments/2026-09-04-multiharness-signature.md) | 150 mostly shorter runs completed in 121 minutes. This demonstrates useful throughput, not the capacity of a heavy release workload. A preceding pricing failure also stopped otherwise useful work. |

The August timing above was recomputed from the 388 verdicts under the
appliance's `corpus/gate-20260808`: first start `2026-08-08T04:27:29.550Z`, last
finish `2026-08-09T13:05:54.202Z`. Overlap counts complete run intervals, not
simultaneous provider requests. These historical values do not establish current
scheduler capacity.

This design consolidates the existing direction rather than starting a platform
replacement:

- The [August overhaul](2026-08-12-quorum-overhaul-program-design.md) and
  [campaign platform](2026-08-17-quorum-campaign-platform-design.md) already
  targeted submission-to-report turnaround. Drew's current release target is
  24 hours; the historical eight-hour target is not this increment's gate.
- Retain the [September 4 finite campaign core](2026-09-04-campaign-consolidation-design.md):
  one controller, isolated attempts, frozen comparisons, ordinary reports and
  termination ownership. Campaign replacement, adoption and historical artifact
  migration remain outside this work.
- Retain the separate simulated-user and assessor roles from the
  [September 7 interaction design](2026-09-07-quorum-conversation-assessment-design.md).
  Its two-minute pilot assessment limit does not remain a universal policy.
- Retain the [September 8 routine-use goal](2026-09-08-conversation-evals-routine-use-design.md)
  that ordinary defects belong inside one delivery. Its small stock comparison
  is not the acceptance substitute for a real PR and representative release.
- Report-shape recovery establishes that a submission can be parsed. It does
  not establish that its judgments are correct. Model audit agreement likewise
  cannot serve as independent ground truth.

## Operator contract

Keep test definitions versioned; supply comparison-specific inputs at submission.
A reusable suite defines scenarios, repetitions, evaluation requirements and
finite replacement policy. The operator supplies baseline and candidate refs,
selected harness/credential combinations and declared effort settings. Explicit
experiment arms remain supported by the ordinary campaign path.

PR comparisons use the intended PR base. Release comparisons use the intended
previous release. Do not silently substitute the local checkout or a floating
default. Resolve refs once and freeze their exact commits. The request's labels
and resolved identities both appear in the report.

Extend existing appliance registration to materialize these inputs into the
existing frozen experiment. It must retain the versioned suite, resolved arm
declarations and source identities without requiring a new committed arm file
for every PR. Runtime choices use validated fields and registered credentials;
they do not edit fixture or rubric bytes or supply secrets. Preserve existing
source authentication, eligibility, isolation and credential rules.

Before execution, show the expanded sample count, included harness/model
combinations, exclusions, repetitions, budgets and capacity limits. Unsupported
combinations receive an explicit reason. Changing the requested coverage requires
a new declaration; silently shrinking it is invalid.

One execution request then uses the existing controller and produces the normal
report without a bespoke operator script. The appliance owns execution after
submission. Repeating a comparison with new revisions creates a fresh identity
and reuses its test definitions. Existing `status`, `cancel`, `costs` and `report`
remain the inspection and control surfaces.

The smaller implementation alternative is to keep committing arm YAML for each
comparison. We reject that as the routine interface because it imposes recurring
repository work on every PR. The selected convenience belongs in the existing
registration path, not a second launcher or scheduling service.

## Execution and throughput

Reuse concurrent workers and the existing admission policy. Schedule eligible
work across scenarios and harnesses while preserving frozen pairing and exposure
requirements. A long-running sample must not prevent unrelated eligible work
from using available capacity. Host resources and actual shared provider limits
remain constraints; credential aliases do not create additional quota.

The current direct-Anthropic declaration has `max_concurrency: 2`.
`blockDemandVector` reserves a subject, grader and global slot per sample;
the controller counts those reservations until the attempt stops. A paired block
therefore consumes both grader slots for its whole attempt. This source setting
is not evidence of a provider quota. The same credential also powers the
simulated user during conversation, so treating it as idle until final assessment
would undercount real demand.

First size the existing pools against verified provider and host capacity, then
exercise that operating point in the declared comparisons. Do not assume raising
the global worker cap raises effective parallelism. Finer-grained capacity
allocation is warranted only if measured whole-attempt reservations prevent the
target despite available resources. Any such change must account for both
simulated-user and assessment requests and preserve attempt ownership; a
distributed scheduler is not a prerequisite.

Subject and assessment budgets are explicit and frozen with the workload. Use
retained task durations, observed tails and the required work to justify them.
Validation checks that the outer attempt bound accommodates setup, conversation,
capture/checks, assessment, finalization and cleanup. Waiting consumes elapsed
time and is visible; it must not be disguised as a shortened work allowance.

Remove the hardcoded two-minute assessment setting from the shared runner.
Communicate the assessor's remaining time and reserve a bounded report-only
grace opportunity within the frozen total limit. The enclosing process deadline
still terminates unresponsive work. Grace can yield an incomplete assessment or
no report; it does not guarantee a determinate judgment. Longer time alone does
not fix semantic false passes.

Use existing timestamps and event streams to report active attempt overlap,
role durations and admission waits by limiting pool or host resource. Add only
the missing observations needed to explain throughput. Distinguish reservations
from active provider requests; no new telemetry service is required.

## Assessment authority and verification

Keep the simulated user isolated from the private rubric. The independent
assessor judges the completed interaction against frozen evidence, using direct
Anthropic for this increment. Preserve the existing native logs, normalized
trajectory, delivered output, fixture/source evidence and check records.

Allow indexed inspection and search of that retained evidence, including bounded
file ranges for large files. Every result identifies its source and range and
discloses truncation or unavailable content. Search results are navigation aids,
not proof that omitted text contains no contrary evidence. The assessor must be
able to inspect the full delivery relevant to an obligation. It cannot modify
the subject work or read another attempt's evidence. Executable checks remain
the authority for the behavior they actually exercise.

Grade each stated criterion independently. Preserve its conditions and distinguish
an unmet requirement in a complete delivery from evidence that is missing.
Observations, inferences, limitations and source references remain separate.
Grounding stays mandatory wherever the scenario claims credible review quality;
finding required defects does not establish that every material review claim is
supported. A citation proves access to evidence, not correctness of interpretation.

Verify the instrument with a small frozen set of full deliveries containing
supported conclusions, omissions and deliberate unsupported claims. Include the
known full-review misses and both supported and unsupported controls. Expected
outcomes must identify concrete fixture facts and rubric obligations. Ambiguous
cases retain their disagreement and cannot be silently labeled gold. Drew is not
required to adjudicate transcripts.

The implementation plan fixes this set, repetitions and acceptance expectations
before changing the assessor. Report false passes, false failures, unresolved
assessments and reasoning support separately. Known regression cases must receive
the expected criterion verdict for the stated reason. Include full deliveries
not used to tune a fix; passing remembered examples alone does not qualify it.
Passing this bounded set establishes evidence for the exercised obligations,
not general grader accuracy.

Use the ordinary assessment path for this verification. Re-assessing retained
evidence is supporting verification, not a new campaign product or a mandatory
standing calibration campaign before each PR. The frozen instrument's identity
and applicable qualification accompany subsequent comparisons. Changed rubric,
model, adapter or evidence semantics require the affected verification again.

## Measurement validity and reports

Validity attaches to a measurement and its dependencies, not indiscriminately
to an entire run. Preserve the existing summary verdict while exposing:

| Measurement | Meaning and failure handling |
|---|---|
| Interaction | Whether the subject interaction completed and its artifacts are available. Delivery does not prove correctness. |
| Executable check | The recorded behavior of that check. Failed output is a subject result; a crashed or absent checker leaves its obligation unresolved. |
| Criterion judgment | The assessor's verdict, basis and evidence for that obligation. A timeout or invalid report supplies no accepted judgment. |
| Cost and usage | Known amounts plus explicit missing/unpriced coverage for each actor. Unknown is not zero. |
| Comparison | Differences derived only from measurements whose dependencies and frozen inclusion rules hold. Show the eligible and observed denominators. |

An assessment failure preserves completed interactions, check results and known
costs. A broken normalizer invalidates claims depending on its missing events;
it need not invalidate independently exercised output behavior. A source or
identity mismatch can invalidate all candidate-attributed measurements. Missing
price data alone does not cancel behavioral measurement. Preserve the existing
response to real authentication, billing, ownership and host failures.

For every scenario and harness/model pairing, the ordinary report shows baseline
and candidate counts, criterion differences, repetitions, unavailable results,
coverage gaps and links to decisive evidence. Label descriptive differences at
small sample sizes; lack of a detected difference is not equivalence. A known
unreliable criterion cannot support a release claim even when its emitted verdict
is pass. Separate checked facts from assessor judgments and unvalidated claims.

Each quantity has its own available count and inclusion rule. Do not filter all
cost or completion observations through successful grading. Retain all-attempt
spend, including failures and replacements; distinguish those totals from paired
efficiency comparisons. Show how excluded or missing samples affect a comparison
instead of hiding them in a successful-only denominator.

Publish machine-readable and readable reports through the existing report path.
The readable report must convey the result without an external analysis script.
Bot supplies interpretation and targeted evidence review when required; Drew
receives findings and links rather than a transcript-reading assignment. A
headline that still needs unresolved manual investigation remains qualified.

Freeze grading configuration, rubric, budgets and inclusion rules throughout a
comparison. A correction produces a new instrument or analysis identity and
retains prior results; it cannot silently replace unfavorable evidence. No
automatic merge decision or new statistical inference service is introduced.

## Acceptance through actual comparisons

The implementation plan begins by fixing two real workload declarations before
feature implementation. This is input selection within this delivery, not
another platform-design milestone. Each declaration names its real question,
source refs, scenarios, harness/model combinations, repetitions, planned sample
total, replacement rules, role budgets, required evidence coverage and numerical
turnaround target. Exact resolved identities and declarations are frozen before
provider calls.

1. **PR or experiment:** test an actual Superpowers change against its intended
   baseline, with relevant scenarios and regression coverage. Declare a target
   in hours appropriate to its harness set. Reuse the input interface to register
   another candidate without editing or committing new arms; registration itself
   requires no paid rerun.
2. **Release:** compare a real release candidate with its intended previous
   release, with a target of at most 24 hours. Include broader skill coverage,
   multiple harness/model combinations, repetitions and substantial end-to-end
   coding tasks. Use the August gate's declared workload and observed cost/time
   distribution as the sizing reference. Explain differences in coverage and
   sample count before execution. Neither a small conversation smoke nor linear
   extrapolation from cheap scenarios satisfies this proof.

The clock starts when the appliance durably accepts the execution request and
ends when it publishes the usable comparison report. It includes subsequent
queueing, preparation, execution, retries, cleanup and report production.
Registration may happen earlier without starting execution. Report registration
and request timestamps too, so admission delay is not hidden. Existing
`claimed_at`-to-`ended` duration remains execution telemetry, not an end-to-end
turnaround claim. A process exit or a report with a known unresolved material
defect does not establish the usable-report endpoint for an affected conclusion.
Discovering a defect later requires a visible correction to the affected claims
and acceptance evidence, not a promise that reports can never need correction.

Acceptance requires truthful disposition of every planned sample, the frozen
coverage needed to answer the question, applicable grading verification,
inspectable evidence and the declared turnaround. Subject failures are valid
observations. Missing required judgments, inadequate coverage or missed time
targets leave the corresponding acceptance criterion unmet. Publish the useful
partial results and the reason anyway.

Offline checks exercise registration substitution and freezing, concurrency at
real admission seams, deadline/grace behavior, evidence inspection and independent
measurement denominators. Integrated failure cases cover assessment timeout,
checker failure and missing usage without discarding unrelated measurements.
Run repository checks for touched components. Live verification then uses the
ordinary appliance path and the two declared workloads. Test output, simulated
capacity and accepted report shapes cannot substitute for that live evidence.

## Implementation boundary and completion

| Surface | Retain | Targeted change |
|---|---|---|
| Appliance registration | Source snapshots, eligibility and frozen experiments | Materialize runtime comparison inputs from reusable definitions |
| Campaign execution | Controller, concurrent workers, ownership and admission | Size verified pools and expose missing wait/overlap observations |
| Conversation and assessment | Separate roles, captures, check records and usage | Explicit role budgets, reporting grace and scoped evidence inspection |
| Campaign reporting | Immutable reports and all-attempt accounting | Criterion-level evidence, independent measurement validity and full turnaround |
| Scenarios | Existing catalog and authoring conventions | Fixed acceptance workloads and focused grading verification cases |

Changes stay in the existing appliance/campaign paths, story budget resolution,
runner role invocation and Gauntlet assessor. Existing QA scenarios remain
usable; absent criterion detail stays explicitly unavailable rather than being
invented. Converting the entire catalog to conversation mode is not required.

No new controller, fleet, artifact migration, standalone regrading system,
grader ensemble, endpoint experiment or docs-hosted runtime is part of this
increment. The separate doctor work remains separate. A measured capacity
shortfall must be reported; it does not silently authorize infrastructure changes
or reducing the declared workload.

Deliver the changes and their checks as one implementation plan, followed by
actual comparisons and one experiment record containing both successes and
failures. Ordinary defects discovered on this path are handled within that plan;
they do not each become a new spec or microprobe campaign. Material changes to
architecture, workload scope or spending still require an explicit decision.

Completion means the two declared demonstrations have produced useful reports
at their stated targets with the required measurement evidence. If a gate fails,
retain that result, fix its supported cause within scope, and verify the affected
path without erasing prior attempts or endlessly re-running unaffected work.
Do not call a spec, a green code check, a small smoke or an unrun capacity estimate
the final iteration's success.

This document authorizes no live spend or deployment. Its next step after Drew's
written-spec review is the implementation plan.
