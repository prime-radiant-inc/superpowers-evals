# Frozen validation workloads

These versioned Suite V2 templates declare repeatable comparisons. They are not
launch authorization. Supply the symbolic `baseline` and `candidate` arms at
registration; no comparison-specific arm files belong here.

| Input | Frozen selection |
| --- | --- |
| Baseline | `v6.3.0`, peeled commit `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Candidate | `dev`, commit `3a8bdc11e1db42955350d6d6f063f7a8e89aef58` |
| Claude | `claude:opus_bedrock`, Opus 4.8 through the provisioned route |
| Codex | `codex:openai_responses_56sol`, gpt-5.6-sol |
| Pi | `pi:pi_gpt56_sol`, gpt-5.6-sol |
| Gauntlet-Agent, both roles | `sonnet5`, `claude-sonnet-5`, direct Anthropic |
| Effort | No runtime override; record effective harness settings and provider defaults at registration |
| OS | Linux, existing scenario/adapter/credential eligibility |
| Replacements | Zero reserves, one attempt; retain invalid samples |
| Admission | Existing paired admission, maximum exposure skew 60 |
| Capacity target | Eight global attempts; quota-supported grader cap eight, sustained throughput unproven |
| Implementation identity | Freeze final evals/Gauntlet commits and image digest at registration |

`focused.yaml` covers the first seven declared scenarios on Claude and Codex,
one repetition on both revisions: **28 primary samples**, a **four-hour**
target from durable execution acceptance to a usable report, and a 5400-second
outer attempt bound. `release.yaml` covers all 22 scenarios on the three
pairings, one repetition everywhere: **118 primary samples** (Claude 44,
Codex 44, Pi 30), a **24-hour** target, and a 10800-second outer bound. These
are reduced workflow-validation counts, not measured throughput or the original
full-scale acceptance.

Drew's September 11 amendment authorizes F28 without successful code-review
qualification, after a bounded team review. None of its seven scenarios is
conversation-code-review. The failed qualification is retained, no success
record is attached, and R118 remains held. This does not calibrate the focused
graders: conversation-design shares the assessor and checks unsupported claims;
the other six scenarios use fused QA. Report judgments with their evidence and
uncalibrated status, checks within their declared authority, and cost/coverage
separately. Publication completeness does not establish semantic accuracy.

Pi is excluded from exactly these seven release scenarios by their existing
eligibility: `user-pref-no-brainstorm`, `conversation-design`,
`worktree-no-drift-to-main`, `tdd-holds-under-tests-later-pressure`,
`conversation-review-feedback`, `conversation-config-repair`, and
`conversation-debugging`. Any additional exclusion misses declared coverage.

New registrations freeze `role_budgets` by cell and arm from the authenticated
story and agent configuration. Retained campaigns without this metadata have
unavailable role-budget declarations; no allowances are synthesized for them.
They retain their existing frozen source and execution rules. Acceptance work
uses fresh registrations.

The exact subject/fused-QA allowances are in `requirements.json`. An absent
scenario allowance resolves to the frozen agent's existing ten-minute default.
Do not consume spare outer time by increasing those allowances. Reserve 15
minutes for setup/capture/checks/publication/cleanup and account for the existing
legacy QA final-turn allowance when validating bounds. Conversation assessment
totals are ten minutes for design, code-review and review-feedback; five minutes
for pricing, config-repair, debugging and verification. Each total includes 60
seconds of report grace and five seconds of publication reserve. These budgets
are engineering declarations, not measurements of optimal limits.

The templates bind the acceptance-specific
[pricing snapshot](../../../docs/experiments/2026-09-10-repeatable-pr-release-validation-pricing/current.json)
with SHA-256 `b4f9e5512b4a62adcf2b47bbe96f5972fc9c5d6fdc313f4d95f965f6343be780`.
The [September 10 capacity and forecast record](../../../docs/experiments/2026-09-10-repeatable-pr-release-validation.md#capacity-and-pricing-preflight)
documents current source checks, six regional Opus/Haiku alias corrections,
unchanged direct Sonnet/OpenAI rates and the remaining route/accounting limits.
This snapshot applies to this acceptance's Mantle regional route; it is not a
universal correction to canonical model rates. Missing prices leave costs
unknown rather than zero and do not erase behavioral measurement.

Drew's current console reports support grader cap eight. Subject Claude cap six,
the shared OpenAI pool 15 and all host guards remain unchanged. Historical host
load reached 24.98, exceeding the current 16 guard: sustainable eight-way
throughput and the four/24-hour targets remain unproven. Quotas and retained
returned-usage samples do not measure active request concurrency or retries.

The reduced forecast is $40.11 standard / $55.62 upper mean for focused and
$193.44 / $295.83 for release; summed cell p90 estimates are $52.58 / $73.35
and $248.65 / $378.18. The separate 24-assessment qualification has a $1–$10
planning allowance. Combined planning arithmetic is approximately $235–$462
(exactly $234.55–$461.53), neither a spending ceiling nor a guaranteed final
cost. These reweight retained per-cell cohorts; unknown physical usage, retries,
proxy-filled historical samples and the reduced n=1 design remain limitations.
The original 84/366 full-scale proposal is deferred and is not satisfied by this
reduced validation. No qualification is attached, and this data preflight does
not authorize deployment or live acceptance.

## Requirements data contract

`requirements.json` is frozen data for report verification, not a new executable
suite or runtime service. Its SHA-256 must travel with the chosen template.
`scenarios` maps names to `mode` (`qa` or `conversation`), source hashes,
allowances, eligibility, oracle authority and `criteria` objects:

- `id`: stable `<scenario>:<ordinal>` obligation ID.
- `ordinal`: one-based acceptance-criterion position in the story.
- `text`: the existing criterion text, joining its wrapped lines with spaces.
- `required_artifact_classes`: unconditional evidence needed to judge this obligation.
- `check_refs`: explicit `{ordinal, scope}` references into the scenario's `checks` array; an empty array means no executable check establishes the obligation.

The scenario-wide `required_artifact_classes` is the union of its criterion
requirements. The deliberately small vocabulary is:

| Class | Meaning |
| --- | --- |
| `native_session` | Coding-Agent native session evidence, including tool invocations and outcomes |
| `normalized_trace` | The corresponding normalized trajectory for ordering and process claims |
| `visible_delivery` | Complete user-visible interaction and delivered response or explicitly delivered report |
| `output` | Preserved supplied source and final delivered files relevant to the obligation |
| `check_dispositions` | Structured executable-check records and their trusted oracle results |

An executable output obligation uses check evidence independently of trajectory
availability. Static code-review grounding unconditionally requires only complete
`visible_delivery` and supplied `output` (including before/current source).
Missing or corrupt process capture does not make a source-only grounding judgment
unavailable. Supplied source can establish development history such as the query
regression without a process trace. Claims of execution or other history not
established by supplied source still require supporting context under the existing
assessor grounding/limitations obligation. The consumer must not promote those
conditional needs into unconditional capture dependencies: the assessor judges
unsupported claims against the unchanged rubric. This declaration introduces no
per-claim parser, condition evaluator or additional judge. Actual process criteria
continue to require process evidence.

Each scenario's `checks` array enumerates the exact manifest entries as
`{ordinal, phase, check, args, negated, count, authority}`. Ordinals are zero-based
positions in the existing manifest's `entries` array. Preserve `args: null` as the
manifest's dynamic-argument identity; do not fabricate resolved commands. Keep
multiplicity `count` intact. `authority` identifies a kind (`precondition`,
`process_check`, `output_check`, `source_preservation`, or `independent_behavior`)
and the existing source files implementing that check. `oracle_authority` retains
the manifest identity/hash and source pointers; no new oracle is introduced.

Criterion `check_refs` explicitly state the limited part of each obligation the
referenced check supports. The consumer must not infer missing associations from
text or treat a check as establishing more than its declared scope. For example,
configuration repair criterion 2 references the independent behavior oracle;
its process/history criteria do not. Code-review criteria have no check refs:
source preservation does not prove prose findings or grounding. Composite oracle
success supports its listed behavior checks; composite failure alone does not
identify which individual behavior failed. Preserve the check disposition and
let the existing assessment account for that limitation. Evidence presence is
not a passing judgment.

`story_sha256` hashes the exact story bytes. For conversation mode,
`rubric_sha256` hashes the existing `projectConversationStory(story).rubric`;
for fused QA it hashes the complete story presented to the Gauntlet-Agent.
`check_manifest_sha256` hashes the exact existing check-manifest bytes. A source
change requires explicit re-freezing of affected inputs, not silent refresh.
The YAML's `grader` is parsed separately using the existing `GraderSchema`, as
registration already does, and the remaining fields use `SuiteSchema`.

Require truthful dispositions for all 28/118 primary samples, every declared
repetition, required judgments/checks/capture and authenticated source identity.
Report actor-specific cost coverage separately. One repetition per cell provides
initial behavioral observations only; it does not establish equivalence,
run-to-run variability or the original full-scale acceptance. These reports make
no automatic release decision.

## Qualification and independent measurements

The six conversation-code-review criteria explicitly set
`requires_assessment_qualification: true`. This is measurement scope metadata;
it does not alter their text, expected labels or evidence requirements. Other
criteria retain their own assessment/check provenance with accuracy not
calibrated by this pack. An accepted judgment remains visible independently of
qualification. An unverified scoped pass cannot support a quality conclusion.

Suite `measurement_requirements` and optional `assessment_qualification` use
repository-relative `{path, sha256}` references. Both registration intake
passes verify the consumed bytes. Registration freezes rubric/check ordinals,
text, hashes, evidence dependencies and declared check-support scope into the
experiment. Templates attach qualification only after Task 9 produces its
versioned public record.

Qualification records use `schema_version: 1`, `gauntlet_sha`,
`grader: {credential, model, configuration_sha256}` and
`evidence_semantics_sha256`. Grader configuration hashes JCS of the complete
normalized public `CredentialSchema` value; environment variable names are
included but no resolved secret values are used. Evidence semantics hash JCS
of a sorted mapping from every authenticated `src/` file plus `package.json`
and `bun.lock` to its exact-byte SHA-256. Registration recomputes this from the
object-store and materialized intake. It excludes docs and qualification data,
avoiding a circular reference to the evals commit containing the record.

Each record scope carries `scenario`, `rubric_sha256`, `criterion_ids`,
`assessment_ms`, `report_grace_ms`, `case_manifest: {path, sha256}` and
`private_receipt_sha256`. Its `observations` contain `case_id`, one-based
`replicate`, `completed`, criterion rows `{criterion, verdict, reason_support}`
and `cost: {subject, grader}`, each actor having `{known_subtotal, complete}`.
Verdict may be null; reason support is `supported`, `unsupported` or
`unavailable`. No private path or raw response belongs in this record.

The consumer authenticates the referenced public case manifest and requires
its entire case/replicate inventory, expected verdict vectors and supported
reason judgments, plus exact source, grader, rubric and role-budget bindings.
Unknown price coverage alone does not invalidate semantic qualification.
Missing or mismatched scope is unverified; malformed or hash-corrupt consumed
files reject registration. Source changes conservatively require new
qualification. Fold version 2 reports independent quantity cohorts and never
rewrites historical reports.

## Ordinary operator path

Register the focused acceptance with full pinned commits and declared display
labels. This prepares a receipt; it does not authorize or start a paid run.

```sh
/srv/quorum/bin/evals-appliance campaign register /srv/quorum/superpowers-evals/examples/campaigns/validation/focused.yaml --baseline b36e0829c6d0140e93cfef2ca599b1b07d4a7797 --candidate 3a8bdc11e1db42955350d6d6f063f7a8e89aef58 --baseline-label v6.3.0 --candidate-label dev --pair claude:opus_bedrock --pair codex:openai_responses_56sol --global-cap 8 --json
```

For release acceptance, change `focused.yaml` to `release.yaml` and add
`--pair pi:pi_gpt56_sol`. Review the registration receipt, including source,
role budgets, credential pools and frozen workload. Copy its campaign identity
into the existing `campaign run`, `status`, `cancel`, `costs` and `report`
commands as needed; never launch through shell substitution of an unreviewed
registration response. Deployment and paid execution require separate approval.

Keep every completed subject even when assessment expires or price is missing.
Those faults leave the corresponding quality or cost measurement incomplete;
they do not cancel the entire comparison. Authentication, billing, ownership,
host and operator stop policies still apply. These declarations admit no
replacement. A necessary fresh comparison receives a new identity, with the
failed acceptance receipt retained alongside it.

The controller journal supplies attempt overlap timestamps, while role files
supply role durations. `contention-telemetry.jsonl` also retains bounded
`admission_wait` observations when a block's limiting reason or pool changes.
Their `reserved` and `capacity` values describe admission reservations. Host
waits use pool `host` and zero reservation/capacity placeholders. They do not
measure active provider requests or refresh host sample coverage. Unknown
provider concurrency remains unknown.

QA native logs are selected by the capture adapter and retained outside the
private home. Bound QA event streams and valid terminal capture twins can
support visible-evidence dependencies; they establish neither conversation
completion nor the correctness of a judgment. QA interaction completion remains
unavailable without an independent endpoint record.

QA interaction readiness is separate from check and criterion readiness. An
unavailable independent QA endpoint record does not gate otherwise supported
check/criterion comparisons. Inspect the readiness of each conclusion; the mere
presence of a delivery receipt never establishes that every release obligation
is complete.

Native QA reports supply one criterion row per frozen criterion, in order, with
short labels. Evals attributes them by frozen ordinal only when the complete row
count matches; missing or extra rows leave all affected criterion judgments
unavailable. Retained labels and evidence remain verbatim native report data,
without claiming label or interpretation accuracy. Conversation assessment keeps
its exact canonical criterion text and accepted-report digest checks.
