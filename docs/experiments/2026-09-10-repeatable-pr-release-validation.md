# Repeatable PR and release validation — 2026-09-10

Status: declarations and fixture freeze complete; implementation integration,
grading qualification, capacity verification and live acceptance **pending**.
No model calls, deployment or live workload was performed by this freeze.

## Questions and frozen declarations

Focused: does dev improve or regress discovery, resistance to premature
implementation, user-preference compliance and plan generation?
Release: does the same candidate regress the representative supported workflow,
including substantial implementation?

Both compare baseline `v6.3.0` at peeled commit
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797` against `dev` at
`3a8bdc11e1db42955350d6d6f063f7a8e89aef58`. Do not silently refresh dev.

Versioned declarations: [workloads and constraints](../../examples/campaigns/validation/README.md),
[focused](../../examples/campaigns/validation/focused.yaml),
[release](../../examples/campaigns/validation/release.yaml), and
[per-criterion requirements](../../examples/campaigns/validation/requirements.json).
Focused: seven scenarios, Claude/Codex, two revisions, three repetitions,
84 samples, four-hour target. Release: 22 scenarios, Claude/Codex/Pi, two
revisions, three repetitions except five fractals repetitions, 366 samples,
24-hour target. The seven existing Pi exclusions are declared in the README.
Both use the frozen direct Anthropic Sonnet 5 grader and retain the committed
pricing snapshot pending Task 9 coverage verification. Eight-way capacity is a
target pending verification, not a throughput result.

## Grading regression and held-out freeze

[Case declarations](../../test/fixtures/assessment-validation/README.md) retain
eight full deliveries with the full six-row rubric, three assessments each:
24 assessments, 144 criterion judgments. Grounding denominators: 12 positive,
12 negative. The omitted credential finding separately requires failures on
criteria 3 and 5 in its three assessments. No disputed label is counted as gold.

Case-manifest SHA-256: `11b273a535f878a12ed1b075949b4e4f353b625636144b533b7f12a351782459`.
Requirements SHA-256: `4bef2871b9890dbc5246bdb2e30607522975ff00b4631ea17daf25af0a856af1`.
Focused-template SHA-256: `b51ba2c8e3bf66c12bbfdd083bc3fda485253d15394e303c48f05931d2dbe91f`.
Release-template SHA-256: `bf932e993c0b77680b7b62145ce7d2d94ff7a3d62c47be6517db7290ece37db3`.

The requirements digest includes explicit assessment-qualification scope metadata
for the six conversation-code-review obligations; the rubric and case-manifest
bytes are unchanged. Templates now bind that requirements file. No completed
qualification record is attached before Task 9 produces its evidence.

Private originals and corrected complete copies remain private. All 261
original files were hash-verified before copying. Additional unsupported
material assertions in the original reviews required factual corrections
beyond the initially named bypass/storage claim to make sound positive
controls. The complete rubric remains unchanged. Corrected controls are
synthetic, with private correction/provenance receipts; they are not new
executions. Public indexes contain only fresh constructed review/source data. Both exact
before/current source versions are supplied to establish the rubric's required
parameterized-to-concatenated regression without inventing history.

Offline checks establish hash fidelity, evidence isolation and executable
counterexamples, not assessor accuracy. The retained query and storage false
claims are deliberate negative cases with equal reporting weight. Mutation
checks confirm that removing the password comparison, altering review bytes,
or indexing labels fails the focused tests. Gauntlet's existing validator
accepted all eight case indexes in private local verification.

## Pending measurements

Record final implementation identities and image digest at registration.
Report workload dispositions, all declared repetitions, native/visible
capture, trusted executable-check dispositions, every applicable rubric row,
qualification scope, actor-specific known costs and missingness, full turnaround
and coverage. Cost unknown is not zero and does not discard behavioral evidence.
No detected difference at n=3/5 establishes equivalence. No automatic release
decision follows. Model assessments, paid runs, operational capacity, four-hour
and 24-hour targets, and live comparison results remain pending.

## Independent-measurement integration boundary

Task 6 introduced independent interaction, check, criterion and quantity
observations with unverified assessment scope labeled explicitly. Task 8's
production QA capture/publication fixture now proves selected native logs survive
private-home removal, valid QA criterion rows survive the producer projection,
and the exact Gauntlet event stream plus authenticated capture twins can support
visible-evidence dependencies. Normalized traces are validated at the two exact
producer paths; candidate-created nested aliases supply no such authority.

QA still has no independent authenticated conversation endpoint record, so its
interaction-completion measurement remains unavailable. That does not gate valid
QA check or criterion comparisons: delivery readiness is recorded separately for
each measurement. Capture presence does not establish complete delivery or the
correctness of an interpretation. A report receipt does not imply that every
release obligation is complete, and these offline gates do not establish the
84/366-sample live acceptance coverage or instrument accuracy.

Task 8's cross-task review also found that current Gauntlet QA reports deliberately
use ordered short criterion labels. The Evals mapping now requires the complete
frozen row count and attributes by ordinal, preserving native labels/evidence.
Missing or extra rows cannot shift attribution. Conversation assessment continues
to require canonical full text and authenticated acceptance. This changes neither
criterion judgments nor their uncalibrated provenance or evidence dependencies.
