# Repeatable PR and release validation — 2026-09-10

Status: declarations and fixture freeze complete; Task 9 capacity/pricing data
preflight recorded below. Final implementation verification, grading qualification
and live acceptance **pending**. No model calls, deployment or live workload was
performed by this data preflight.

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
Focused-template SHA-256: `2bd7ce9b5b19738ceca9aaa8535588e52feef6b7ce1636860a95bb6bb132dc61`.
Release-template SHA-256: `fae792e3d7249c6b5173850a8e9238ebb4a52a5751206f2e1e3767d598ea1f67`.

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

### Planning forecast, not spending limits

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
Gauntlet heads, unchanged 84/366 declarations, these estimates and limitations,
and the exact 24-assessment sequence. Then qualify the frozen grading gate,
freeze its data and instrument identity, register both comparisons plus the
registration-only alternate candidate demonstration, and measure both ordinary
reports against their turnaround and completeness obligations. This preflight
completes none of those live gates and makes no release decision.
