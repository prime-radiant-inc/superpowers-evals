# Repeatable PR and release validation — 2026-09-10

Status: implementation, reduced F28/R118 declarations and the prompt amendment
are merged and deployed at Evals `ec6bdbb7` and Gauntlet `aa08b729`. After the
initial failed qualification, the corrected-control prompt retry yielded
16/24 supported vectors for Sonnet and 15/24 for Opus. Both still miss the
required full-review grounding failures; three Opus sessions ended on API errors.
**Grading qualification remains unmet.** No focused or release comparison was
launched. Implementation verification is complete; live comparison acceptance
remains unmet. The original failed qualification below is retained unchanged.
Drew's approximately $500 reduced scope remains F28/R118, conditional on grading
qualification; original 84/366 full-scale acceptance is deferred.

## Prompt-first retry — 2026-09-11

Drew authorized correcting the assessor prompt, retrying Sonnet, then trying
Opus if needed. The bounded Gauntlet amendment directs source facts first,
material-claim coverage at the claim's stated scope, then criterion verdicts.
It changes prompt and tool descriptions only. Sonnet remains on the direct
Anthropic API at medium effort, with ten minutes total including 60 seconds
of report grace. Schema, validation, tools and runtime flow are unchanged.

Before retrying, a new synthetic `storage-full-corrected` copy corrects two
unqualified consequences left in 22 wrapped terminal capture artifacts. Its
complete delivery was separately reviewed against the unchanged six-row
rubric. All eight evidence indexes, hashes and label isolation pass the real
Gauntlet validator; all 261 retained original bundle files remain unchanged.
The other seven cases and all expected labels are unchanged.

Retry case-manifest SHA-256:
`908e70cba4fb1bc7c575f8c6ff4bff1017b3884d4938bdf6a74733652f5e1b4b`.
The prior manifest and failed results below remain intact. This is a regression
retry on observed cases, not fresh held-out qualification; the manifest's
partition labels describe the original split. Each case again gets three
independent assessments, 24 total, at concurrency eight. Record every outcome
and cost; no selection of successful repetitions. A changed model receives a
separate result identity. The roughly $500 overall allowance is unchanged.

### Sonnet prompt retry

Gauntlet PR #22 merged at `aa08b72989fe59c57362c42f5d1bfe2c26417253`;
Evals PR #64 froze the corrected control at
`ec6bdbb74e6c2238bd5a7d23a88403c63ec17b12`. Scoped source review approved;
Gauntlet's full check passed 1,601 tests with two skips, plus typechecks and
UI build. Evals fixture/fence checks passed nine tests; both PRs passed CI.
Prepare job `job-20260911T073155Z-417a` built these exact revisions after a
separate doctor operation released the shared spend lock. Installed-source
inventory SHA-256 was
`d7f5305522f15cad15b94878981687040548252dcf70aae9ca8ad5c76dc8e136`.

The Sonnet retry completed all **24 sessions in 491.345 seconds**, for
**$2.2147657 estimated**, with complete accounting for 116 physical and
116 logical requests. Every event stream contains the exact committed prompt.
All 24 eventually published accepted native reports, without XML repair,
deadline or grace events. Only 13 were accepted on their first submission:
47 submissions included 17 empty-criteria arrays and six unread-citation
rejections. The empty arrays are valid JSON that the report validator rejects;
none was truncation or the earlier XML-inside-reasoning failure.

**Qualification still fails:** 16/24 complete vectors have supported required
reasons, seven grounding judgments are false passes, and one is unjustifiably
unclear. No false failures or disputed controls remain. Of the 12 expected
grounding failures, four fail correctly, seven pass and one is unclear; all
12 expected grounding passes pass. The omission control correctly fails
criteria 3 and 5 in every repetition. Minor wording/citation inaccuracies in
matching reports are retained in the private reason audit.

| Case | Sonnet grounding, repetitions 1 / 2 / 3 | Opus grounding, repetitions 1 / 2 / 3 |
| --- | --- | --- |
| query-full; expected fail | unclear / pass / pass | pass / pass / pass |
| storage-full; expected fail | pass / pass / pass | pass / pass / pass |
| query-full-corrected | pass / pass / pass | unavailable / unavailable / pass |
| storage-full-corrected, new control | pass / pass / pass | pass / pass / pass |
| supported-complete | pass / pass / pass | pass / pass / pass |
| unsupported-query; expected fail | pass / pass / fail | fail / fail / fail |
| unsupported-storage; expected fail | fail / fail / fail | fail / fail / unavailable |
| missing-credential | pass / pass / pass | pass / pass / pass |

The new prompt elicited more explicit claim lists but did not reliably prevent
the faulty lookup-implies-authentication inference or crediting unrelated
caveats against unsupported full-review claims. One unclear report had decisive
counterevidence in the delivery it had already read. This is not evidence of
a time-budget failure. The prior control was defective, so the whole 24-case
total must not be treated as an unchanged-input before/after accuracy estimate.

Private Sonnet receipt ID: `assessment-qualification-IgBqjg`; exact receipt
SHA-256: `0f8f0450864d0973fb7874af761a5ea4eed3b7be5ee5fa3dcf8d080914691842`.
The finite invocation now sets the frozen pricing directory through obol's
native API before pricing; all costs carry the September 10 pricing date.

### Opus with the same prompt and settings

All 24 scheduled pairs ran exactly once with `claude-opus-5`, changing only
the model from the Sonnet setup above. Both used the existing **medium effort**
setting; high effort was not tested. All 48 event streams contain the exact
same system prompt, SHA-256
`2ef4d21fbb002345ecf39a5c9d3f2ec1a80758427b817df4698c235ca2ded75d`.

Opus published **21 accepted reports: 15 supported complete vectors and six
grounding false passes**. Three sessions produced no report because the API
returned errors. The 12 expected grounding negatives yielded five correct
failures, six false passes and one unavailable judgment. The 12 expected
positives yielded ten passes and two unavailable judgments. There were no
semantic unclear judgments or false failures. The omission control correctly
failed criteria 3 and 5 in all three repetitions. One matching control report
misstates timing behavior as directly observed, while its decisive basis
correctly recognizes the delivery's qualification; the private audit records
this reason defect separately.

All original full-review negatives still falsely pass. Opus explicitly excuses
unsupported storage/bypass assertions as reasonable inferences or as hedged
elsewhere. That fails the unchanged whole-delivery grounding obligation.
Available constructed-negative judgments all correctly fail. This supports a
specific full-delivery interpretation failure, not a claim of general model
accuracy or that an Opus upgrade qualifies the instrument.

Seventeen sessions were accepted on the first submission. There were 26 report
submissions and five unread-citation rejections; no empty criteria arrays,
XML repairs, truncations, deadline decisions or grace events. All 117 returned
model responses stopped with `tool_use`. The longest session took 171.557
seconds under its unchanged 600-second total allowance.

The API returned HTTP 500 for `query-full-corrected` repetitions 1 and 2, and
HTTP 400 (`Invalid request data`) for `unsupported-storage` repetition 3.
Each error response omitted usage. Across 120 physical requests, 117 have
returned usage and three remain unknown; known estimated Opus spend is
**$9.11327175 plus those unreported requests**. This is not complete cost
coverage. The API status and request linkage are retained; the underlying
cause of those errors is not established here.

The finite invocation stopped after each of the first two active batches.
After inspection, fresh invocation identities admitted only the remaining
scheduled pairs: repetitions 2–3, then repetition 3. All failed sessions remain
included; no case was replaced, retried as a new session, or dropped. The exact
24 distinct `(case, repetition)` pairs were verified. Active invocation time
totaled 461.787 seconds; first start to last finish, including inspection and
new-invocation gaps, was 666.857 seconds. These are not controlled latency
comparisons with Sonnet.

| Private Opus receipt ID | Exact receipt SHA-256 |
| --- | --- |
| assessment-qualification-HbL1MD | `b1e5b03ab3e82d47b12b4e6338fa8557c394d78d6d634f97e31a8cb14fa5a687` |
| assessment-qualification-Ja0QEN | `9d050c3f9b8c46155708b09955233a4535e254016359af27b8a74a9c730d27d9` |
| assessment-qualification-gD18TQ | `88d860a094395421f4e7222e845e1f53f5c266d805edf97fdd8efe7a783fef79` |

Known estimated spend for this prompt/model comparison is **$11.32803745 plus
three unknown-usage requests**. Both reason audits and all original receipts
are retained privately. **Neither model qualifies on the required full-review
grounding cases.** F28/R118 and alternate-candidate registration remain
unstarted. No further model calls are queued.

## Current reduced execution amendment — 2026-09-10

The current templates use F28/R118 (seven focused scenarios and 22 release
scenarios, Claude/Codex/Pi eligibility unchanged, both arms, one repetition
everywhere). The four-hour and 24-hour outer targets, per-role allowances,
scenario selection, frozen refs, prices, exclusions and qualification24 remain
unchanged. The retained forecast is $40.11/$55.62 standard/upper mean for F and
$193.44/$295.83 for R; summed-cell p90 is $52.58/$73.35 and $248.65/$378.18.
With qualification's $1–$10 allowance, combined planning arithmetic is
$234.55–$461.53 (approximately $235–$462), not a spending ceiling or guaranteed
final cost. Historical cohort proxies, unknown physical usage/retries and the
one-repetition design limit interpretation.

The original 84/366 declaration is a dated superseded full-scale proposal. It is
deferred and is not satisfied by this reduced workflow validation; n=1 supplies
initial behavioral observations and cannot establish equivalence or run-to-run
variability. The current templates and this amendment are data-only; no Gauntlet
or product behavior changed.

## Live qualification — 2026-09-10 Pacific

Drew authorized the reduced sequence after the final heads and spending estimate
were presented. [Evals PR #62](https://github.com/prime-radiant-inc/superpowers-evals/pull/62)
merged after its full local check and CI. Tailscale `prepare` job
`job-20260911T064252Z-0ed1` deployed Evals
`c024c27da2ff2eb2bf18f09fdf40be2c6c18a978` and Gauntlet
`9e5511e719f06cca42f7a7a93fa872ac2ddc46a8`. Container image:
`sha256:a89305b4784bf0fa88247601da4a467ab28f3ad32b364a36d8cbc8e50dd3b360`.
Installed Gauntlet source was checked against that managed revision before any
model call. The case-manifest and rubric/evidence bytes stayed frozen.

All 24 sessions used the installed production `gauntlet assess`, direct
Anthropic `sonnet5` / `claude-sonnet-5`, ten minutes including 60 seconds of
report grace, and batches of eight under the existing live-spend lease. There
were no Coding-Agent sessions. Start/end: `2026-09-11T06:45:09.303Z` /
`2026-09-11T06:50:36.240Z`, **326.937 seconds** elapsed. Individual assessments
lasted 35.109–122.211 seconds. All 24 published accepted native reports; 23 were
accepted on the first submission. One unread citation was rejected, read, and
resubmitted successfully: **25 submissions**, no XML repair or deadline decision.
This proves this assessment path completed, not campaign throughput or release
validation.

| Case, three repetitions each | Expected grounding | Observed grounding | Reason audit |
| --- | --- | --- | --- |
| query-full | fail | pass ×3 | Confirmed false passes |
| storage-full | fail | pass ×3 | Confirmed false passes |
| query-full-corrected | pass | pass ×3 | Required reasons supported |
| storage-full-corrected | pass | pass ×3 | Disputed positive control; exclude from semantic qualification |
| supported-complete | pass | pass ×3 | Required reasons supported |
| unsupported-query | fail | pass ×3 | Confirmed false passes |
| unsupported-storage | fail | fail ×3 | Unsupported persistence assertion detected |
| missing-credential | pass | pass ×3 | Grounding supported; criteria 3 and 5 correctly fail |

**15/24 complete vectors match the original manifest; only 12 have supported
complete vectors and reasons after the audit.** Nine confirmed false passes are
all grounding judgments. A separate read-only reviewer and Bot checked the
required bases against the full delivered reviews and supplied source. On the
21 sessions with nondisputed controls, grounding has **9 false passes among 12
expected failures**, **0 false failures among 9 expected passes**, and **0
unavailable judgments**. Repetitions of eight cases do not estimate general
judge accuracy; the raw 135/144 row agreement must not be used to obscure the
nine decisive errors or count disputed controls as correct.

The public [unsupported-query review](../../test/fixtures/assessment-validation/constructed/unsupported-query/review.md)
asserts that a successful lookup unconditionally authenticates any supplied
password. The [actual login body](../../test/fixtures/assessment-validation/constructed/unsupported-query/db.js)
still requires password equality. All three assessors read the entire review
and source without truncation. One explicitly treated the false deduction as
necessary; the others overlooked or excused it. The existing executable
counterexample again passes: a successful lookup still returns no login for a
mismatching password. Additional time and inspection tools did not resolve
this semantic error; these observations do not isolate a general root cause.

**Our positive-control preparation was also defective.** In
`storage-full-corrected`, structured report text qualifies caller exposure and
timing claims, but visible terminal captures retain unconditional versions. The
final delivery incorporates that visible report. These three vector matches
cannot qualify the instrument under the unchanged whole-delivery rubric. Keep
the original control, manifest and outputs intact and record the disagreement;
no label or input was silently changed after seeing results. The other nine
false passes are independently supported and remain failures. Held-out cases
have now been observed; tuning on them would consume their held-out status.

Usage accounting reconciles **90 physical requests and 90 logical responses**,
with complete coverage for all 24 sessions. The original private invocation
incorrectly changed `OBOL_PRICING_DIR` at runtime under Bun, which does not reach
obol's native environment; its cost provenance therefore named August 5.
Offline reconciliation used obol's `setPricingDir` with the frozen September 10
snapshot and the same retained usage: **every per-case cost and the total
$1.6580323 are unchanged**. The separate reconciliation retains the corrected
pricing provenance without overwriting the original receipt or making more
model calls. Dollars are rate-based estimates, not billing receipts.

Private receipt ID: `assessment-qualification-hSQC7O`; exact original receipt
SHA-256: `193c49ab8deb4ed1adfa0e9f2289f4f613529456bcc91d47b169349b3975937a`.
All inputs, 24 result/event/completion/usage records, the reason audit and pricing
reconciliation remain in private local storage and on the appliance. No raw
private transcript or successful qualification artifact is published here.
The spend lease was released and appliance doctor was healthy afterward.

**Stop: qualification remains unmet.** F28, R118 and the alternate-candidate
registration demonstration have not started. No prompt/model change, replacement
case, extra live repetition or additional comparison spend follows this result.
Both turnaround demonstrations remain pending; PRI-2874 stays open. The reduced
spend declaration is complete, but the intended live validation is not.

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
Focused: seven scenarios, Claude/Codex, two revisions, one repetition, 28
samples, four-hour target. Release: 22 scenarios, Claude/Codex/Pi, two
revisions, one repetition everywhere, 118 samples, 24-hour target. The seven
existing Pi exclusions are declared in the README. The earlier 84/366 counts
remain below as a dated superseded proposal.
Both use the frozen direct Anthropic Sonnet 5 grader and retain the committed
acceptance-specific pricing snapshot described below. Eight-way capacity is a
quota-supported configuration proposal, not a throughput result.

## Grading regression and held-out freeze

[Case declarations](../../test/fixtures/assessment-validation/README.md) retain
eight full deliveries with the full six-row rubric, three assessments each:
24 assessments, 144 criterion judgments. Grounding denominators: 12 positive,
12 negative. The omitted credential finding separately requires failures on
criteria 3 and 5 in its three assessments. No disputed label is counted as gold.

Case-manifest SHA-256: `11b273a535f878a12ed1b075949b4e4f353b625636144b533b7f12a351782459`.
Requirements SHA-256: `4bef2871b9890dbc5246bdb2e30607522975ff00b4631ea17daf25af0a856af1`.
Focused-template SHA-256: `9c72e7e8b0e5f6dfa04af9741a6d4914b4bdc204559b068bb4fc220397b0becd`.
Release-template SHA-256: `fb956890b0946512ef5a34e91bd431f080d9524170b82ca05f1ca855cd651032`.

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
The superseded n=3/5 proposal's “no detected difference” condition would not
establish equivalence. The current n=1 amendment supplies initial observations
only. No automatic release decision follows. Qualification assessments are recorded above. Coding-Agent campaigns,
operational campaign capacity, four-hour and 24-hour targets, and live comparison
results remain pending.

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


## Capacity and pricing preflight

Evidence date: **2026-09-10 Pacific** (some receipts are dated September 11 UTC).
The read-only investigations and public-source checks were performed by the
coordinating agent; this data preflight consumes its permitted metadata receipts
without rerunning provider, host or transcript investigations. Private receipts
remain outside Git. No account identifiers, private paths or transcripts are
published here.

### Provider and host evidence

Drew supplied current console limits: direct Anthropic Sonnet 5 **10,000 RPM,
10M input TPM excluding cache reads, 2M output TPM**; OpenAI project Sol, Astra,
Terra and 5.5 **15,000 RPM / 40M TPM** each, Luna **30,000 RPM / 180M TPM**, all
**15B TPD**. These are attributed console reports, not independently successful
API reads. The earlier Anthropic rate-limit API attempt returned 401 with the
inference key; the [rate-limit API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api)
requires administrative access. No new quota question or inference probe is
needed for this data correction.

Authenticated Mantle control-plane evidence reports Opus 4.8 **20M input / 4M
output TPM** for the current account; no request-quota row was returned. The
exact blessed bearer's association with that account was not independently
established. Existing Claude subject cap six has extensive retained usage and
remains unchanged. Missing request-quota rows do not establish unlimited
capacity; [Mantle quota documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-mantle.html)
describes separate input/output limits. Codex and Pi retain the same shared
OpenAI pool of 15; aliases do not add independent capacity.

Retained returned-usage samples support these conservative synchronizations:

| Actor reservation scenario | Logical requests/min | Input tokens/min | Output tokens/min |
| --- | ---: | ---: | ---: |
| Eight Sonnet 5 grader roles | 232 | 2,064,248 uncached plus cache writes | 66,664 |
| Six Claude subject roles | Unavailable | 1,344,138 uncached plus cache writes | 159,432 |
| Eight OpenAI subject roles | Unavailable | 4,422,752 cache-inclusive | 57,280 |

The grader extraction found 84 role logs from 88 selected run directories,
including 68 Sonnet 5 logs. Eight simultaneous adapter maximum-output
reservations add up to 131,072 tokens. Subject extraction produced 86 rows with
two parse/missing-file errors; usage was available for 38 Claude, 19 Codex and
eight Pi records. Claude demand pools returned ATIF steps and child models;
Codex uses deduplicated native cumulative-usage deltas with negative resets
excluded; Pi uses ATIF. These incomplete historical samples describe returned
usage, not request-start/physical-retry counts, active overlap or future worst
cases. Quota supports changing only `sonnet5.max_concurrency` from two to eight;
it does not establish measured performance or eliminate unknown usage.

The host has eight CPUs, approximately 32 GiB RAM and 141.8 GB free disk at the
reported check. Of 38 retained campaign directories, 34 had matching-memory
fingerprints and samples: minimum whole-host available memory was 26,845,814,784
bytes and no sampled swap was used. **Peak load1 was 24.98, above the current
16 admission guard**, on a campaign with declared cap eight. These extrema do
not measure eight active requests or isolate per-attempt memory. All 56 selected
p90-duration run directories were measured for disk: median allocated size
15,654,912 bytes, maximum 193,884,160. Historical versions/pruning differ; these
sizes cannot guarantee the heavy release workload's growth. Preserve every
current host guard, global cap eight, Claude six and shared OpenAI 15.
Sustainable eight-way throughput remains an outstanding live measurement.

### Rate scope and provenance

The new [acceptance pricing data](2026-09-10-repeatable-pr-release-validation-pricing/current.json)
has exact-byte SHA-256
`b4f9e5512b4a62adcf2b47bbe96f5972fc9c5d6fdc313f4d95f965f6343be780`.
It copies the reviewed draft unchanged, preserving every other rate from source
snapshot `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
Only six aliases change: `claude-opus-4-8`, `anthropic.claude-opus-4-8`,
`claude-haiku-4-5`, `claude-haiku-4-5-20251001`,
`anthropic.claude-haiku-4-5` and `anthropic.claude-haiku-4-5-20251001`.
Historical snapshots are untouched. The draft sets `as_of` to `2026-09-10`
for this acceptance correction; all rates outside these aliases remain inherited
from the September 6 source snapshot.

The selected Mantle us-east-1 route is
[In-Region only](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-8.html).
Anthropic documents the [10% regional premium](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock).
Its [official list effective May 27, 2026](https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf),
pages five and six, gives these USD/MTok regional rates:

| Model | Input | Output | Cache read | Cache write 5m | Cache write 1h |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opus 4.8 | 5.50 | 27.50 | 0.55 | 6.875 | 11.00 |
| Haiku 4.5 | 1.10 | 5.50 | 0.11 | 1.375 | 2.20 |

This is an acceptance-specific regional assumption for primary and child model
aliases, not a universal canonical-model correction. Exact child-route and
embedded `cost_usd` provenance/precedence still need integrated accounting
verification; editing a rate table alone does not establish all-attempt dollar
coverage.

Direct Sonnet 5 remains **$2 input / $10 output per MTok**, cache writes
$2.50/$4 for 5m/1h and reads $0.20. The planned September 1 increase was cancelled,
as verified in the [current pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing)
and [Sonnet 5 announcement](https://www.anthropic.com/news/claude-sonnet-5).
The stale credential comment is corrected; the snapshot's Sonnet rates already
match. OpenAI Sol remains **$4 input / $20 output**, read $0.40, cache write
1.25 times input; over 272k input, input doubles and output is 1.5 times standard.
These promotional rates are stated through at least November 21 in the
[Sol model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
The [official OpenAI pricing table](https://developers.openai.com/api/docs/pricing)
also confirmed the existing Terra, Luna and Astra standard/long-context rates.
Retained forecasting cohorts include 97 Codex Terra, 40 Luna, one Astra and
90 Claude Haiku model records. No OpenAI rate correction is made.

### Current reduced planning forecast, not spending limits

The reduced forecast reweights the existing per-cell cohorts to one repetition
per declared cell. It is $40.11/$55.62 standard/upper mean for focused and
$193.44/$295.83 for release; summed-cell p90 estimates are $52.58/$73.35 and
$248.65/$378.18. With the unchanged qualification24 allowance of $1–$10, the
combined planning arithmetic is $234.55–$461.53. It is neither a spending
ceiling nor a confidence interval, and does not account for unknown physical
usage or retries.

### Superseded full-scale planning forecast, not current authorization

The forecast selects each quantity's first populated cohort: exact scenario,
harness and primary model; then the same scenario/harness with another model
repriced; then the same scenario/primary model with another harness; finally
the same scenario with another harness/model repriced. Grader tokens are repriced
at direct Sonnet 5 and child-model rates remain explicit. Focused has **78/84
exact primary slots and six model proxy slots**; release has **272/366 exact
primary slots and 94 model/harness proxy slots**. This is forecast population,
not complete actual-cost coverage. Standard versus upper uses standard versus
maximum rate tiers because retained aggregate usage does not always resolve
actual context length or cache TTL. Public rate-table coverage does not prove
exact billed cost when those usage details are missing.

| Workload | Subject mean standard / upper | Grader mean standard / upper | Combined mean standard / upper | Summed cell p90 standard / upper |
| --- | ---: | ---: | ---: | ---: |
| Focused, 84 | $82.87 / $122.96 | $37.47 / $43.91 | **$120.34 / $166.87** | **$157.74 / $220.05** |
| Release, 366 | $567.81 / $934.36 | $137.98 / $161.87 | **$705.79 / $1,096.23** | **$890.70 / $1,374.44** |

Cell p90 sums are descriptive planning quantities, not a campaign p90 or a
statistical confidence interval. Unknown physical usage/retries, future activity,
workload drift and the longer assessment allowance are not measured by this
forecast; the upper column is not a guaranteed ceiling or measured final cost.

Qualification is separate: the old six-case assessor run cost **$0.2389478**
with complete accounting and took 15–85 seconds per case. The frozen new workload
is **24 full-case assessments with a ten-minute total allowance**, including
60 seconds of report grace; its changed inspection burden prevents direct
extrapolation. Carry **$1–$10** as a broad planning allowance, not a spending cap.
No qualification record is attached before those executions.

Proxy-filled wall-work totals are 38,207/48,868 seconds (mean/summed cell p90)
for focused and 183,936/229,547 seconds for release. Dividing by eight yields
optimistic capacity arithmetic of 1.33/1.70 hours and 6.39/7.97 hours, **not a
schedule or throughput result**. At the previous grader cap two, the same
arithmetic is 5.31/6.79 and 25.55/31.88 hours: that cap cannot establish the
four/24-hour targets. Paired reservations, shared pools, host guards, workload
drift and actual overlap still constrain delivery. Preserve this negative
capacity evidence without promising the proposed cap will meet either target.

Before any deployment/live authorization, present the final tested evals and
Gauntlet heads, the current F28/R118 declarations, these estimates and
limitations, and the exact 24-assessment sequence. The original 84/366 counts
remain deferred historical scope. Then qualify the frozen grading gate,
freeze its data and instrument identity, register both comparisons plus the
registration-only alternate candidate demonstration, and measure both ordinary
reports against their turnaround and completeness obligations. This preflight
completes none of those live gates and makes no release decision.
