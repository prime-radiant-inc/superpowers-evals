# Code-review assessor calibration

This is an eight-assessment diagnostic, not a new eval runner or a reliability
benchmark. It reuses the completed Claude and Codex reviews from campaign
`6b066da6-66c6-4672-9887-c3db958b64f7`. No coding agent runs again. The original
campaign, its evidence, and its reports remain unchanged.

The original rubric rewarded required defect detection but did not separately
grade unsupported additional claims. The Claude review found real defects and
also asserted facts about stored data, database behavior, and execution history
that the supplied files did not establish. Both original reports passed all
three criteria. The hypothesis is that a separate material-grounding criterion
will distinguish these reviews without penalizing clearly conditional risks.

## Frozen inputs and expected results

`rubric-baseline.md` is the exact private rubric projected from the existing
scenario. `rubric-grounding.md` adds one criterion; the first three are unchanged.
`cases.json` declares execution inputs. `expected.json` records human expectations
before any new assessment. A null criterion expectation allows either outcome;
the old merge criterion can also reject unsupported claims or omitted defects.
The fresh Claude baseline is observational: reproducing its original erroneous
pass is not a success condition.

The four constructed controls share the real fixture's before/after source.
They are represented as plain review text, not fabricated native sessions:

| Sample | Review | Expected revised result |
| --- | --- | --- |
| a | Required findings, supported consequences | Pass all four |
| b | Same findings plus clearly conditional external logging risk | Pass all four |
| c | Same findings plus asserted external logging exposure without deployment evidence | Fail grounding |
| d | Supported credential finding, query finding omitted | Fail query detection; pass grounding |

Each control has a separate evidence root and an index containing only the
request, its review, and the two source files. The assessor cannot read this
protocol, the expected answers, other samples, or prior assessment results
through its indexed evidence reader. The two real cases use their original
full evidence indexes, including transcripts and output files.

## Execution

Run one fresh assessor history per case, sequentially, using the existing
Gauntlet `assess` command and `anthropic.claude-sonnet-5` on Mantle in us-east-1.
Retain ordinary Gauntlet `result.json`, `result.md`, `run.jsonl`, and `usage.jsonl`
under a new calibration directory. Assessors have indexed read access and the
report tool; they have no terminal or subject-control tool.

The installed appliance helper has no assessor-only verb. Use the documented
trusted-maintainer path for this approved retained-evidence diagnostic, after
checking the ordinary run lock. The one-off `run.ts` uses the canonical shared
spend lease and existing scoped credential reader. It does not launch a quorum
scenario or pretend to create a helper-owned job. Record this reason and run
the appliance doctor afterward. Do not change canonical checkouts, images,
credentials, original campaign files, or source evidence.

For its relative imports, stage only the one-off `run.ts` as an untracked file
under the owned pilot Quorum checkout at this same relative path. Execute it
with a separate committed-input directory and a new output directory. Reject
tracked Q/G changes, and remove this staged file after the process exits; retain
its committed copy with the experiment. This temporary operator file does not
alter the pinned runner implementation. Set `OBOL_PRICING_DIR` to the pinned
pricing directory before starting Bun, so the parent cost reader uses it too.

Run at most eight cases, with a two-minute external deadline per case and no
automatic retries. Stop on instrument failure, missing/unpriced usage, loss of
the spend lease, cancellation, or after cumulative cost reaches $3. This is a
stop-before-next-case threshold, not a hard provider billing cap: an in-flight
request can exceed it. A valid failed assessment is a result and does not stop
the diagnostic. The expected cost is well below the threshold given the
original two assessments cost about $0.10 together.

Pin Quorum `5ec5784fb06655c07b8cd3f9d7c4390a987e9155`, Gauntlet
`74d2037aed14f413db482b7635783e4e0498c316`, and the existing pricing artifact
with SHA-256 `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
Record the calibration-input commit and file hashes before launching.

## Decision

Compare criterion results and the cited reasoning with the frozen expectations.
Inspect whether the assessor actually identifies a material unsupported claim,
rather than rejecting a review for an unrelated reason. Any mismatched revised
case blocks promotion of this rubric change in this diagnostic. Record failures
and do not tune repeatedly against these examples with unbounded reruns.

Even eight matching results would establish only that this narrow correction
works on these retained reviews and controls once. They would not establish
repeatability, independence from the assessor model, calibrated probabilities,
or general review quality. The original subject outcomes remain completed runs;
their original reported grades are not silently replaced.

## Observed result

Drew approved this calibration after the review pilot. All eight fresh
assessments completed on 2026-09-08 UTC (September 7 Pacific), with no retries,
timeouts, instrument failures, or missing/unpriced usage. The frozen input
commit was `c4dba2c9a9f45c3edc62f8df5280cc61c3bb6bc5`.

| Case | Query | Credential | Merge | Grounding | Overall |
| --- | --- | --- | --- | --- | --- |
| Claude, baseline | Pass | Pass | Pass | — | Pass |
| Codex, baseline | Pass | Pass | Pass | — | Pass |
| Claude, revised | Pass | Pass | Pass | Fail | Fail |
| Codex, revised | Pass | Pass | Pass | Pass | Pass |
| a: supported findings | Pass | Pass | Pass | Pass | Pass |
| b: conditional risk | Pass | Pass | Pass | Pass | Pass |
| c: unsupported assertion | Pass | Pass | Pass | Fail | Fail |
| d: omitted SQL finding | Fail | Pass | Pass | Pass | Fail |

All six revised cases matched the frozen expectations. The fresh Claude
baseline reproduced the original permissive pass. The revised assessment
retained credit for its required findings and merge recommendation, but rejected
the asserted leakage through existing callers: the delivered review says those
callers now leak credential material without evidence establishing their
existence or behavior. Independent inspection confirmed this wording in the
original visible capture 093. Control c was rejected specifically for asserting
third-party log forwarding; control b's explicitly conditional version passed.
Control d failed required detection while retaining credit for its supported
credential finding and accurate uncertainty.

The assessor's reasoning was not wholly accurate. Its account-data criticism
includes an ambiguously conditional SSO phrase. It praises a driver hedge even
though the review later says the defect stands regardless, and repeats
unsupported storage and login-outcome claims elsewhere. The definite
existing-callers assertion is sufficient for the grounding failure without
relying on those weaker explanations. This caught a material grounding defect;
it did not identify every unsupported claim correctly. Control b also uses
conspicuous conditional wording and does not test subtler hedges.

The narrow promotion gate is met. Added exactly the calibrated fourth criterion
to the active `conversation-code-review/story.md`; no assessor system prompt,
runtime, generic grading interface, or original report changed. The constructed
controls ran only under the revised rubric, so they establish the intended
distinctions once, not improvement over baseline on those controls or general
assessor reliability.

Total priced assessment cost was **$0.3931902**. Summed assessment duration was
225.446 seconds, running sequentially. The revised pair of real reviews cost
$0.1810025 versus $0.0785168 for the fresh baseline pair. Those are one-shot
observations, not a performance estimate; clearer grading was not free.

Standard Gauntlet results, evidence logs, and usage sidecars remain under:
`/srv/quorum/pilots/conversation-assessment/calibration/review-grounding-20260908T041449Z/out/`.
`outcomes.json` maps each case to its standard run ID and records costs and
criterion grades. The sibling appliance directory retains the input receipt,
owner record, operator log, and before/after doctor receipts. Selected results
are copied to ignored local `results/review-grounding-calibration/` for review.
No raw transcripts or credential material were committed.

After completion, all original evidence-index bytes, indexed evidence, verdicts,
and private rubrics matched their recorded hashes; calibration inputs also
matched their pre-launch hashes. No calibration process or shared spend lock
remained. The temporary operator file was removed. Both appliance doctors were
healthy, and canonical and pilot Q/G/S checkouts were clean at the same refs.
No new coding-agent run was launched. The promoted scenario remains a local,
unpushed branch change; the installed pilot source was not updated.

Local validation after promotion: `bun run quorum check` passed scenarios,
credentials, and arms/suites; all three conversation-input tests passed; the
projected private rubric matched the calibrated rubric byte for byte; and
`git diff --check` passed. The one-off operator script separately passed strict
TypeScript checking and Bun import bundling before execution. Independent
reviews accepted the frozen case design, operator safeguards, and narrow
promotion decision after inspecting the delivered Claude capture.
