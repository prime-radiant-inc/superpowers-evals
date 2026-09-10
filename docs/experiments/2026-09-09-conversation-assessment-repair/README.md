# Conversation assessment repair

This follow-up investigated and implemented a bounded repair for the two assessor
failures preserved by the [September 8 routine-use run](../2026-09-08-conversation-routine-use/results.md).
It follows the [repair plan](../../superpowers/plans/2026-09-09-conversation-assessment-repair.md)
and the existing [routine-use qualification design](../2026-09-08-conversation-routine-use/README.md).
The original operation remains stopped. Drew approved a separate live window for
the reviewed candidate; that operation also stopped, after its first assessment
timed out without a valid report. The repair is **not live-qualified**. See the
[negative live result](results.md#approved-live-follow-up--terminal-failure); no
driver qualification or fresh comparison ran.

## Repair hypotheses

The retained failures support two narrow hypotheses.

1. For a validly shaped report, requiring each judgment to preserve the
   criterion's entities, conditions and relationships may reduce false passes
   caused by substituting a plausible but unstated default. Complete inspected
   delivery that omits an obligation must remain distinct from unavailable or
   partial evidence. An explicitly permitted unresolved choice and nonessential
   uncertainty must remain compatible with pass.
2. For a rejected native tool call, actionable feedback that identifies the
   required top-level `criteria` array and asks for a complete native
   resubmission may let the same assessor correct its next call. Strict rejection
   remains the contract; embedded XML or JSON text is never salvaged from a
   reasoning string.

The provider record does not distinguish model generation from an internal
provider tool-parsing fault. Extra trajectory context is also a possible but
unestablished contributor to the semantic miss. Neither hypothesis is qualified
until actual model sessions and independent rationale review exercise the frozen
inputs.

## Evidence and competing explanations

Ordinal 01 received the complete decisive evidence at the inspected application
boundary and accurately described the delivered proposal. It nevertheless
treated generic all-task completion notices as satisfying the required
watched-task relationship. Its own limitations acknowledged that no distinct
watching concept had been established. The original expectation and atomic fold
were independently rechecked and no defect was found. The simpler explanations
that decisive evidence was absent, that a parser changed the accepted verdict,
or that the gold invented a new obligation are therefore unsupported by the
inspected record. The application-boundary finding cannot prove how the provider
internally attended to every supplied byte.

Ordinal 03 returned three `report_result` inputs containing only `summary` and
`reasoning`; all ten judgments were serialized inside `reasoning` after
XML-like tags. Each call stopped for tool use, each rejection was delivered to
the next request as an error identifying the missing array, and the role timed
out without an accepted result. A real-SDK replay showed that Gauntlet did not
receive and discard a valid top-level array. Increasing output tokens or parsing
the embedded prose does not address the observed boundary failure.

The [September 8 grading diagnostic](../2026-09-08-conversation-grading/results.md)
already tested broader clause and grounding reminders. It produced only 3/5
matching criterion vectors and 2/5 supported assessments, including false
passes on both designs that omitted selective task watching. Repeating those
broad reminders alone is a recorded failed treatment.

## Candidate and offline proof boundary

The reviewed repair is Gauntlet commit
`a9e320fe88b75d16627255540e179dd642f052e0`, based on
`690432bd295acd199595f875abf9eda25ee06ce0`. It preserves the report schema,
strict parser, read scope, result shape, status derivation, role separation,
timeouts and returned-turn accounting. Its focused assessment/report/model
suite recorded 83 passes, one external-provider skip, zero failures and 246
assertions. The corrected Gauntlet aggregate recorded 1,395 passes, two
provider-gated skips, zero failures and 3,663 assertions.

The paired Quorum check used the actual Gauntlet CLI at that commit and the
unchanged private nine-case corpus: 23 passes, zero skips, zero failures and 204
assertions. It exercised all seven CLI cases and authenticated all nine retained
cases and 896 evidence files. A separate no-provider check loaded the eight new
controls through Gauntlet's actual story parser, evidence-index validator and
scoped reader: eight IDs, 16 criteria and 13 indexed evidence files. These tests
prove source integration, native correction delivery, strict result handling,
input parsing and read scope. Scripted replies and loopback transport do not
prove semantic accuracy or repeatability.

The executed source pair was quorum
`f48c1f8d83e12416c9d135819178aa0759411aed` and Gauntlet
`a9e320fe88b75d16627255540e179dd642f052e0`. Its private source, config,
image and input bindings were authenticated before admission. This later
documentation update records the outcome; it does not replace the executed
source identity or promote the candidate.

## Frozen qualification data

The unchanged nine-case corpus remains retained development and regression
evidence. Its original private manifest SHA-256 is
`63dac509cc81e3cbf8965aa36ea9b79eecd5c792d38db2135d58e6d50475f6b4`;
the source/corpus review receipts remain
`bd829c5ab13e19d85fe6e1b8655da0d99b4624f69e94b1974b7b436c98624d15`
and `9d4c96d5ce6a407697ae05f3bd2c39b6615760002fc43d230b8007ba8b637bfd`.
Its nine cases, 90 atomic expectations, original folds, rubrics, evidence,
mappings and gold are unchanged.

Eight additional synthetic controls were authored independently of the runtime
prompt and blind-reviewed before expectations were disclosed. Their 16
criterion judgments matched 16/16: 10 pass, five fail and one unclear; derived
statuses were two pass, five fail and one investigate. They cover:

- equivalent requirements already supplied by the user;
- an omitted obligation in a complete artifact;
- partial or unavailable evidence;
- an explicitly permitted unresolved choice;
- independent clarification and delivery judgments in both directions;
- qualified uncertainty versus an unsupported categorical claim; and
- chronology established by timestamps despite misleading file order.

Each control contains primary evidence, an exact two-criterion rubric and a
private expected judgment with material rationale. The controls are concise
synthetic evidence, so their offline 8-case / 16-criterion denominator is
reported separately from the retained corpus. They do not establish broad
performance by themselves and were not added to the approved paid gate.
The assessor may receive only a case's rubric, evidence index and indexed files;
expectations, manifests and review records remain outside its input.

The private freeze receipt is
`.superpowers/sdd/2026-09-09-conversation-assessment-repair/heldout-freeze-receipt.json`,
SHA-256 `b82bb719f6b9963d2dab92e77b7457eb722d3abb32f6fb64c74731de4d92ab81`.
It binds manifest
`ee8fb0f4622b608dec9e53224e4d67a82b63fa8952b5adc8a5a4b814111e9f4d`,
blind input
`e3db2965594d35d69a253a217286a9efefb6450969665be22289f364916e043f`,
blind review
`83f6a97288f9ef51c8ff1d647cef24957733f1ac01bb256ec76fd990c963981c`
and comparison review
`12bfc0cf92970884e21d157053785dfb02cd576982be5b692afe57cebc4ad544`.
The runtime parser receipt at
`.superpowers/sdd/2026-09-09-conversation-assessment-repair/heldout-runtime-parser-check.json`
has SHA-256
`5abfbeddb84dceb3632ceb2b00019c262707feac328a790e04501823019cc2da`.
Raw evidence, expectations, provider content and private reviews remain ignored.

## Approved execution boundary and terminal stop

Drew explicitly approved the concrete follow-up proposal on September 9. The
private `followup-execution-proposal.md` remains unchanged at SHA-256
`65da15ac48c39dddf883c1828e6862b25dea9a642ddb737941665874c06b317a`;
separate approval and admission records bind its one candidate, new six-hour
window and USD 150 observed stopping threshold. The threshold is not a final
invoice cap. The original stopped identity and expired clock were preserved.

The approved live order was fixed:

1. 18 retained assessment sessions: nine unchanged cases, two repetitions, 180
   atomic judgments plus their original folds and material rationales.
2. Only if assessment qualifies, 12 previously unrun driver sessions: six
   controlled situations, two repetitions.
3. Only if both roles qualify, one fresh 36-attempt campaign: 16 Claude, 16
   Codex and four Pi attempts across the existing matched stock/treatment arms.

The new private execution root is `/srv/quorum/pilots/car-20260909/r`.
First paid admission at `2026-09-09T18:32:35.627Z` fixed the absolute cutoff at
`2026-09-10T00:32:35.627Z`, with cancellation reserve beginning one minute
before it. The first role instead reached its 120-second deadline with no
accepted report. The operator settled incomplete after **1/18 assessments** and
barred later admissions. Driver sessions and fresh attempts remain **0/12** and
**0/36**. Remaining time and unused slots cannot resume this terminal identity.

Both malformed report submissions put the required array inside a reasoning
string. The second repeated the defect after receiving the candidate's native
argument correction. This is a negative result for the repair hypothesis, not
an SDK test failure or evidence of a supported semantic assessment. The eight
additional controls remain offline only. No second candidate, automatic repair
round, majority-vote escape or new operator/recovery service was authorized.

The original model and credential route, qualified image
`sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`,
pricing digest
`6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`
and existing appliance ownership and cancellation mechanisms were retained.
The operator is gone, scoped process checks found no remaining candidate
process, and both operation and shared spend locks are absent. Exact receipts,
returned usage, unfinished-request coverage and remaining release gates are
recorded in [results.md](results.md).
