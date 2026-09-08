# Conversation release assessment corpus

This corpus implements the approved retained-evidence experiment in
`docs/superpowers/specs/2026-09-07-assessment-reliability-overnight-design.md`.
It contains four complete retained breadth cases and six explicitly constructed
evidence controls. It contains no new live assessments or reliability result.

**Status: revised-rubric replay prepared; independent control review pending.**
Drew authorized clarifying only review criterion 3 after the original pre-call
dispute stopped grading at $0. The reviewed clarification separates the supported
merge recommendation from whole-review grounding. Curator and reported
independent known-case judgments agree on revised C3; this is not approval of the
full corpus or permission to replay. The original dispute remains historical.

`cases.json` declares ten base cases using the existing
`{ id, rubric, evidence_root, evidence_index }` interface. The coordinator expands
them into the frozen baseline/candidate order and two repetitions: 16 known-case
calls first, then 24 control calls only if the independent known-case gate passes.
The corpus does not authorize calls; deadlines, spending and semantic promotion
remain governed by the approved spec and coordinator-owned operator.

`expected.json` contains all 34 criterion judgments, each with the applicable
criterion text, expected verdict, decisive indexed paths and rationale. Criterion
ordinals are one-based within its rubric. These are curator judgments
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
existing conversation-verification story. The separate revised review rubric
changes only C3 as authorized below; C1, C2 and C4 remain byte-identical.

## Revised review rubric

`controls/rubrics/code-review.md` remains the original full review rubric.
`controls/rubrics/code-review-revised.md` is derived independently from each
known review's complete original rubric by replacing only C3 with the reviewed
paragraph from source commit `cccfe260c213e6673e655630cfbe0861b07a7a89`.
Both derivations produce identical bytes. The active cases redirect exactly
`known-claude-review`, `known-codex-review`, `control-a` and `control-b` to this
shared derived rubric; both assessor versions receive those same bytes. The
other six case rows and all original evidence/index bytes stay unchanged.

This is a revised-rubric replay, not a reproduction of the original grades.
`controls/revised-review/derivation.json` records original and derived hashes,
both known-source mappings, source identity and the exact single-paragraph
difference in `rubric.diff`. The original corpus/dispute commit
`6664a7ac868b13740dc4580865db21209951a85f` remains available, and
`expected.json` retains the original criterion judgments and dispute under
`original_rubric_history` on each affected case.

The curator independently judges revised C3 pass in all four affected cases:
each withholds merge based on the supported required query and credential
defects. Claude's unsupported exploit assertion and control-b's unsupported
exposure assertion still fail unchanged C4, so both overall judgments stay fail.
The coordinator reports independent known-case agreement on revised C3; the six
constructed controls still require independent expectation review. No paid
assessment result influenced the clarification or these judgments.

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
Every decisive expected-evidence path is indexed, all 34 applicable criterion
strings match their rubrics, and no expectation, rubric, private assessment
input, or prior assessor report is indexed. The constructed indexes contain
every file in their respective case directory except the index itself.
All 582 fetched known-case evidence/index/input files match the SHA-256 and byte
length in the retained standard campaign report's artifact references.

`controls/validation.json` retains the original read-only offline rerun results
and validator source identity. `controls/revised-review/validation.json` verifies
the changed rubric contract and unchanged corpus evidence after derivation.
Original constructed command receipts remain unchanged.
`controls/corpus-manifest.json` hashes all corpus files except itself,
plus each original full evidence index, rubric and indexed evidence file. Its
`corpus_sha256` is SHA-256 of the compact JSON encoding of its `payload` object
in the recorded key order. These hashes establish byte identity, not semantic
correctness. Recheck them before provider calls and after staging.

The curator did not read the candidate assessor prompt or its commit. The
coordinator confirmed its freeze before any control content was returned.
Constructed-control expectation review is not complete; paid assessment gates
remain coordinator-owned. Negative work is intentionally retained
at equal scope to supported work; these controls do not estimate population
reliability.

Before paid results, an independent known-case audit flagged an interpretation
question for the original Claude review's third criterion. The curator independently
judged pass because directly supported blockers establish the recommendation;
the independent known-case auditor judged fail because the unsupported exploit
chain also forms part of its cited mechanism. The auditor records medium
interpretation confidence. Both readings and their decisive evidence are
preserved in `expected.json` as original-rubric history, including the corresponding
scope question for the constructed review pair. The clarification changes the
replay rubric before calls; it does not rewrite either original judgment.
Observed assessor output must never select the answer.
