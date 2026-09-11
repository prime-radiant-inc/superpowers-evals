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
Requirements SHA-256: `26f9a96ad285dc307f7e38c5dc088b5dfe0d13bdf00a6075f6bc8594ab206247`.
Focused-template SHA-256: `f81f46f1862933d007e5e6321892597d195722b53120b45b576bef980cc23393`.
Release-template SHA-256: `c833bc18b0bd49fd8ad957b6a24ec975cddb4c817dbe2d20c3297acace08c648`.

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
