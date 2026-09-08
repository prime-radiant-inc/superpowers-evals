# Conversation release assessment corpus

This corpus implements the approved retained-evidence experiment in
`docs/superpowers/specs/2026-09-07-assessment-reliability-overnight-design.md`.
It contains four complete retained breadth cases and six explicitly constructed
evidence controls. It contains no new live assessments or reliability result.

**Status: grading gate blocked before calls.** Independent reviewers disagree on
the known Claude review's third criterion. The coordinator stopped all retained
grading calls with $0 spent and retained baseline Gauntlet for independently
authorized live work. This corpus preserves the disagreement and is not approved
for replay or prompt promotion.

`cases.json` declares ten base cases using the existing
`{ id, rubric, evidence_root, evidence_index }` interface. The coordinator expands
them into the frozen baseline/candidate order and two repetitions: 16 known-case
calls first, then 24 control calls only if the independent known-case gate passes.
The corpus does not authorize calls; deadlines, spending and semantic promotion
remain governed by the approved spec and coordinator-owned operator.

`expected.json` contains all 34 criterion judgments, each with the original
criterion text, expected verdict, decisive indexed paths and rationale. Criterion
ordinals are one-based within the unchanged rubric. These are curator judgments
requiring independent review before calls; a disputed expectation blocks its
control. Neither expectations nor prior assessments appear in any evidence index.

## Source and construction

The four real cases come from breadth campaign
`f4f42c37-3a00-4c1d-b5df-e76766a568fc`, with frozen Quorum
`7def77c1a41e46c511fe9bee0f4dd9742f479a55`, Gauntlet
`6dac4bfcb16042cb277067bb4535f9f22b9bb5df` and Superpowers
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`. Their original full evidence indexes
remain at the canonical `/srv/quorum/superpowers-evals/results/` paths declared
in `cases.json`. No original index, source, rubric or grade is rewritten. The
committed review/design rubrics exactly match the original projected rubrics
from both harnesses. The verification rubric is the unchanged projection of the
existing conversation-verification story. No criterion is split or relaxed.

Private local copies used for curation are under the coordinator worktree's
ignored `results/conversation-release/known/<run-id>/`. They are not committed.
The manifest records original index and indexed-file hashes so that staging on
another host can verify the same bytes. Known-case judgments use the visible
delivery, full dialogue, actual source and execution/check receipts; the previous
published pass is not treated as proof. The existing breadth audit identifies
these as development evidence, not unseen cases.

The three constructed pairs are `controls/a`–`b` (review conclusions and scoped
uncertainty), `c`–`d` (watch choices and notification semantics), and `e`–`f`
(verification after an initial failure). Every index includes its provenance
label, complete authored dialogue, complete delivery and ordinary before/output
files. There are no fabricated native sessions, terminals or provider calls.

Review source is copied unchanged from the original review fixture retained in
the earlier calibration; the review prose is newly authored. Design source is
the actual empty Tasks page fixture. Verification before files are the existing
slugify stub, tests and checked-off plan. The original scenario oracles ran
locally against the included source; `execution/*.json` preserves actual argv,
timestamps, exit codes, stdout and stderr. The review/design oracle establishes
source preservation only. It cannot establish review or proposal quality.

For each verification control, the curator ran the initial oracle, changed the
source, ran the same final oracle, and staged/committed that version in a real
temporary local Git repository. The commit and committed-source receipts are
actual command output. These actions are part of constructed control preparation,
not evidence that a live Coding-Agent took them. Temporary repositories and
oracle scratch copies were removed. The fixture tests are unchanged, and the
independent oracle comes from the scenario outside the output tree. The authored
completion statement must be judged against the actual final receipt and source.

## Validation and freezing

The curator used Gauntlet's existing `parseEvidenceIndex` and
`validateEvidenceIndex` directly: all ten indexes and 632 indexed files validate.
Every decisive expected-evidence path is indexed, all 34 original criterion
strings match their rubrics, and no expectation, rubric, private assessment
input, or prior assessor report is indexed. The constructed indexes contain
every file in their respective case directory except the index itself.
All 582 fetched known-case evidence/index/input files match the SHA-256 and byte
length in the retained standard campaign report's artifact references.

`controls/validation.json` retains the separate read-only offline rerun results
and validator source identity. Original constructed command receipts remain
unchanged. `controls/corpus-manifest.json` hashes all corpus files except itself,
plus each original full evidence index, rubric and indexed evidence file. Its
`corpus_sha256` is SHA-256 of the compact JSON encoding of its `payload` object
in the recorded key order. These hashes establish byte identity, not semantic
correctness. Recheck them before provider calls and after staging.

The curator did not read the candidate assessor prompt or its commit. The
coordinator confirmed its freeze before any control content was returned.
Constructed-control expectation review is not complete; paid assessment gates
are stopped by the known-case dispute. Negative work is intentionally retained
at equal scope to supported work; these controls do not estimate population
reliability.

Before paid results, an independent known-case audit flagged an interpretation
question for the Claude review's third criterion. The curator independently
judges pass because directly supported blockers establish the recommendation;
the independent known-case auditor judges fail because the unsupported exploit
chain also forms part of its cited mechanism. The auditor records medium
interpretation confidence. Both readings and their decisive evidence are
preserved in `expected.json`, including the corresponding scope question for
the constructed review pair. No expectation was changed to force agreement.
Observed assessor output must never select the answer.
