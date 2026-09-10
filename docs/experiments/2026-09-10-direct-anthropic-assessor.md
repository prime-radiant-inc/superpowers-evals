# Direct Anthropic assessor qualification

Drew selected direct Anthropic as the interim grader route and deferred further
funded AWS route work to PRI-3118. PRI-3119 tracks this change. The immediate
question is whether the production assessor can submit native structured reports
and distinguish known pass/fail controls with the existing rubric.

## Frozen setup

- Gauntlet: `25a2e3e00431f8d8eb63781162ccb974d43d5405` (PR #20).
- Quorum and control inputs: `7375863fbf632d794dfdec052982382587167c81`.
- Credential: `sonnet5`, model `claude-sonnet-5`, direct Anthropic Messages API.
- Adaptive thinking, medium effort, existing 120-second assessment allowance.
- Strict report tool; report fields, rubric, evidence validation and counted XML
  repair preserved. Every outgoing request must target the direct endpoint and
  carry `strict: true` on `report_result`.
- Four existing controls from `2026-09-07-review-calibration`, one assessment each,
  using `rubric-grounding.md` and the previously frozen `expected.json`.
- Stop before the next case on instrument failure, unpriced usage, semantic
  mismatch, loss of the spend lease, or cumulative estimated cost reaching $3.
  A valid expected fail is a successful control result.

| Control | Required result |
| --- | --- |
| a: supported findings | All four criteria pass |
| b: explicitly conditional logging risk | All four criteria pass |
| c: asserted external exposure without evidence | Grounding fails |
| d: required query finding omitted | Query detection fails; grounding passes |

Null expectations for the merge criterion in c/d remain unconstrained. Neither
other controls nor expected answers are available through the indexed evidence
reader. These are constructed review controls over retained source, not new
coding-agent conversations.

## Execution

The helper prepared the merged Gauntlet via Tailscale SSH (job
`job-20260910T204550Z-0b54`). The helper has no assessor-only verb, so the check
uses the existing production `gauntlet assess` entrypoint and the documented
trusted-maintainer path: canonical shared spend lease, scoped blessed credential
reader, private artifacts, and a temporary script outside the repositories.
No coding agent, new runner subsystem, or helper-owned campaign is created.

An initial invocation failed the assessor's card-ID check before making any
provider request. The temporary invocation was corrected to use the rubric's
`conversation-code-review` ID; production code was unchanged.

## Results

All four controls completed and matched all 14 fixed criterion expectations.
The two unconstrained merge judgments were also pass. Inspection of the accepted
reports confirmed that c failed for its unsupported third-party logging claim,
while b's explicitly conditional version passed; d failed for omitting query
injection detection while retaining credit for its grounded logging finding.

| Control | Query / credential / merge / grounding | Report submissions | Time | Estimated cost |
| --- | --- | --- | --- | --- |
| a | pass / pass / pass / pass | 3 | 60.7s | $0.057990 |
| b | pass / pass / pass / pass | 1 | 17.5s | $0.020041 |
| c | pass / pass / pass / fail | 1 | 23.6s | $0.026531 |
| d | fail / pass / pass / pass | 1 | 22.7s | $0.025389 |

- Ten provider requests, all HTTP 200, using the direct endpoint with strict
  report inputs. Six report submissions; all six contained native criteria arrays.
- Three of four assessments accepted their first report. Control a first sent
  an empty criteria array twice, then supplied four valid rows after the existing
  criterion-count rejection. Empty arrays conform to the static schema; strict
  output does not replace rubric coverage or evidence validation.
- Zero XML repairs, timeouts or missing/unpriced usage. All four completion files
  record `valid native report` and an accepted-report digest.
- Total estimated cost: $0.1299502, using the existing pinned pricing snapshot.
  Total assessment duration: about 124 seconds. No coding-agent spend.
- The spend lease was released and appliance doctor returned healthy afterward.

This establishes the interim route works on these four constructed controls
once. It does not establish general judge calibration or eliminate content-level
retries. No additional prompt/schema tuning or comparison runs were performed.
The empty-array observation is retained for the deferred reporting follow-up.

## Artifacts and application

Private appliance artifacts: `/tmp/quorum-direct-assessor-controls-3686oL/`.
Preserved on Drew's machine under
`~/.local/share/superpowers-evals/pri3119-direct-assessor/`, including the receipt,
exact temporary probe, input hashes, per-case result/event/usage/completion files,
prepare receipt and post-run doctor. The zero-request card-ID failure is retained
on the appliance at `/tmp/quorum-direct-assessor-controls-LC0cF7/`.

The conversation smoke and routine-use suites select direct `sonnet5` with
`claude-sonnet-5`. This changes both Gauntlet roles; subject arms and models remain
as declared. Existing campaigns keep their frozen Mantle settings. The full
36-attempt comparison has not been launched by this change.
