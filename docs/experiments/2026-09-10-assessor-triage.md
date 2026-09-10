# Assessor triage after the routine-use restart

Drew moved native-session doctor work to another session. This investigation
covers grading and the remaining runner/report issues, using retained campaign
`bcc17c8e-6871-4397-b887-106391c7cba1` and six subsequently authorized
assessor-only diagnostic sessions. No coding-agent runs were launched here.

## Confirmed accounting reader defect

The treatment design verdict records five physical assessment requests, four
returned responses, unknown usage for request `005`, `partial: true` and no
complete total. The campaign report nevertheless marked grader cost complete.

`src/campaign/report-evidence.ts` reconstructed completeness from a non-null
subtotal and the absence of unpriced models. It ignored the runner's separate
`economics.assessment_accounting.complete` marker. Pricing all known usage is
not the same as observing all usage.

The correction honors that existing marker. Known grader spend, independently
complete subject spend and behavioral outcomes remain available. The regression
passes through the real manifest publisher and evidence reader; incomplete
accounting failed before the change, and both complete and incomplete cases
pass afterward. Replay of the authenticated retained verdict preserves the
$2.153251 grader subtotal and changes its completeness from true to false.
The historical published campaign report remains unchanged.

## Grading: evidence reached the assessor, but the verdict does not follow it

Both disputed grounding claims appeared in successful evidence-read results
before the report. Stock: events 26 and 28; treatment: events 14 and 16 in the
respective assessment `run.jsonl`. The final criterion in both original rubrics
explicitly disallows unsupported exploit and stored-data assertions, even when
the required findings are correct. The native criteria submissions themselves
say pass; the parser did not flip their verdicts.

- The stock review asserts that its tautology payload passed to login with an
  arbitrary password returns a user. The supplied login body still checks the
  returned credential value against the password. An offline counterexample
  executed that same body with a supplied database result: lookup returns the
  user, while login with the mismatching password returns null. This is a logical
  counterexample using an injected dependency, not a test of the absent driver.
- The treatment review asserts plaintext storage. The supplied code establishes
  a raw-password comparison, but has no stored rows or password-writing path.
  A database containing digests is also consistent with the supplied code,
  albeit with broken login behavior. The storage assertion is not established.

The assessor explanations discuss other caveats, notably driver result shape,
but do not resolve these specific contrary facts. A caveat about one claim
cannot qualify unrelated assertions elsewhere. This localizes the failure to
semantic judgment of the supplied evidence. The six-case diagnostic below tests
whether those distinctions survive when each claim is isolated. The earlier four
constructed controls did not establish coverage of every claim in a longer review.

## Timeout: observed latency, unresolved cause

Four evidence-reading requests completed in 19 seconds; the fifth request stayed
pending for 96 seconds before the 115-second work deadline aborted it. The
remaining five seconds belong to finalization. Successful report-producing calls
in the same campaign took approximately 20, 37, 64, 65 and 71 seconds.

The client uses non-streaming Messages with adaptive thinking and medium effort.
The assessor gets no remaining-time information in its prompt. This is a bounded
execution policy around a variable-duration generation, not evidence of another
parser failure. The absent response does not distinguish provider queueing,
transport delay, thinking or report generation. Raising the deadline would not
establish the cause or repair incorrect grades.

The campaign was canceled by the operator under the written unknown-usage rule;
the campaign engine did not automatically turn this timeout into a global abort.
That overly broad stop policy is separate from the report-reader defect. Any
change to it must be explicit before another live run.

## Six-case diagnostic

Six private inputs were frozen before execution under
`~/.local/share/superpowers-evals/grading-triage-20260910/`:

| Cases | Purpose | Target expectation |
| --- | --- | --- |
| Two original full evidence bundles and original assessor rubrics | Recheck the observed misses without changing input | Grounding fails |
| Each offending claim isolated with the supplied source | Test the underlying distinction with less material to cover | Grounding fails |
| A supported rewrite of each isolated claim with the same source | Guard against indiscriminate rejection | Grounding passes |

The isolated cases use the same grounding obligation as the full rubric, with
only that criterion. Full inputs preserve the original six-row rubric. Evidence
indexes validate through Gauntlet's real scoped reader; expected judgments stay
outside indexed evidence. Inputs and hashes are private, not committed.

### Execution and outcome

Drew authorized all six cases, with a stop before another case if known spend
reached $3. The run used the unchanged production assessor with direct `sonnet5`
(`claude-sonnet-5`), adaptive thinking, medium effort and a 16,384-token output
limit. Each case had a fresh history, one execution and a 120-second deadline.
Existing report-validation feedback remained enabled; no case was rerun.

- Gauntlet: `25a2e3e00431f8d8eb63781162ccb974d43d5405`.
- Quorum: `a098eb3a156f086de41be6cc315b75ff77d7cf55`.
- Endpoint: `https://api.anthropic.com/v1/messages`; every request carried the
  strict report tool. The report schema was identical across all requests.
- Input-manifest SHA-256:
  `2137350da793a6d478c2d5e06f8b5e6c982ff7b3406ac17c0bab421f049301ac`.
- Pricing: the existing PR 2258 snapshot, SHA-256
  `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
- Time: 2026-09-10 22:37:36–22:41:53 UTC, 257 seconds wall time.
- Known cost: **$0.2389478**, with complete usage accounting for all 18 physical
  requests. All returned HTTP 200. No timeout, unknown usage or XML repair.

The existing private assessor invocation acquired and heartbeated the canonical
shared spend lease and projected only the direct Anthropic key. An earlier launch
refused the occupied lease before any provider call; the successful run acquired
it after that owner exited and released it on completion. This did not add a new
operator command or change the appliance runtime.

Only the grounding criterion is evaluated in this comparison. The other five
criteria in each full assessment are outside this diagnostic's acceptance gate.

| Case | Expected grounding | Reported grounding | Seconds | Cost USD | Run ID suffix |
| --- | --- | --- | ---: | ---: | --- |
| Query: full original review | fail | **pass** | 74.743 | 0.0692573 | `20260910T223736Z_eobc` |
| Query: isolated unsupported claim | fail | fail | 38.060 | 0.0371643 | `20260910T223851Z_hupk` |
| Query: supported rewrite | pass | pass | 15.847 | 0.0154549 | `20260910T223929Z_qtbh` |
| Storage: full original review | fail | **pass** | 85.273 | 0.0767015 | `20260910T223945Z_7v8c` |
| Storage: isolated unsupported claim | fail | fail | 27.711 | 0.0261774 | `20260910T224110Z_3cbh` |
| Storage: supported rewrite | pass | pass | 14.871 | 0.0141924 | `20260910T224138Z_6rl4` |

Run IDs have the prefix `conversation-code-review_`. The private receipt and raw
run artifacts are mirrored under the input directory's `results/`; `readout.json`
contains the derived counts. The remote receipt is
`/tmp/quorum-assessor-triage-eVFZ46/receipt.json`. Expected judgments remained
outside the indexed evidence throughout execution.

There were eight report submissions: six accepted and two rejected for an empty
native `criteria` array. Query-bad corrected this on a subsequent model turn;
storage-bad supplied both its empty and valid reports in the same response.
Thus four of six first submissions were accepted. These were application-level
row-count failures: the strict schema permits an empty array. They did not
prevent completion and are separate from the incorrect full-review grades.

### What this distinguishes

Both full-review grounding misses reproduced. In the fresh assessments, the
disputed claims again reached the model in successful reads before its report:
query events 26/28 and storage events 14/16. Both reports explicitly submitted a
native pass; neither was repaired. Missing capture and parser conversion do not
explain these two misses.

All four isolated decisions matched their frozen expectations. The storage
failure explains precisely that a read/comparison path cannot establish how
passwords were stored. The query failure relies mainly on unestablished driver
and execution behavior, while the supported rewrite explicitly recognizes the
remaining password comparison. Correct labels here do not prove that the model
independently reconstructed every step of the query counterexample.

The full-review explanations discuss other findings and caveats without resolving
the disputed claims. This supports a coverage or integration failure in the full
assessment. It does **not** identify context length as the cause: isolation also
reduces the rubric from six criteria to one, reduces the evidence bundle and
removes neighboring claims. There is one fresh execution per case, so these
results are not a reliability estimate.

This direct-route run completed without XML repair, but that mechanical success
does not qualify the grader's semantic accuracy. Further treatment-versus-stock
comparisons stay on hold. The smallest next discriminator would retain the full
evidence while asking only the existing grounding criterion, to separate rubric competition
from the effects of isolating the claim. That experiment is proposed, not run;
no grader prompt, model, schema or deadline was changed in this investigation.
