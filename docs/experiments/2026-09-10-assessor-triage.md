# Assessor triage after the routine-use restart

Drew moved native-session doctor work to another session. This investigation
covers grading and the remaining runner/report issues, using retained campaign
`bcc17c8e-6871-4397-b887-106391c7cba1`. No new provider calls were made.

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
semantic judgment of the supplied evidence. It does not yet distinguish inability
to reason about either claim from failure to cover every claim in a longer review.
The earlier four constructed controls did not establish that broader ability.

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

## Prepared discriminator, not yet executed

Six private inputs are prepared under
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

A proposed run uses the existing production assessor, unchanged direct `sonnet5`
and Gauntlet `25a2e3e00431f8d8eb63781162ccb974d43d5405`, six fresh histories,
one execution per case, 120 seconds each and no coding-agent runs. This is a
small diagnostic, not a reliability estimate. No prompt change, schema change,
new runner, automatic retry or paid execution is part of this preparation.
