# Campaign comparisons

The supported comparison journey is `evals-appliance campaign` on one configured
Linux appliance. One controller owns one finite execution. A fresh registration
creates a fresh UUID even for identical inputs. There is no resume, restart,
controller replacement, adoption, budget amendment, or historical-state reader.

## Prepare the question

Choose a template under `examples/campaigns/`. Copy its arm declarations into the
configured evals source checkout's top-level `arms/`, replace every
`REPLACE_WITH_*_COMMIT` with a real 40-character commit present in the configured
superpowers checkout, and commit the declarations. Point the appliance's evals
ref at that commit. The source must include the current child contract and a
clean, usable Gauntlet source with its declared dependencies. `superpowers: none`
needs no skill checkout ref; a ref arm must resolve from the configured checkout.
Registration freezes the resolved refs and source bytes, including arm and
credential declarations. Merely editing uncommitted arms does not change the
registered question. The suite is read from the supplied path and frozen too.

Run `bun run quorum check` in that evals source before registration. It checks
active top-level arms/suites; example directories are templates. Registration
also checks actual source refs, scenario eligibility, Linux support, adapter
capabilities, credential models and resource limits. It does not require secret
values or authorize a provider call.

| Example | Controlled inputs and prerequisites |
|---|---|
| `pr-base` | Claude and `opus_bedrock` on both arms; supply real base and PR skill commits. Only the skill revision changes. |
| `harnesses` | Claude/`opus_bedrock` and Codex/`openai_responses_56sol`, both stock. This is an **end-to-end stack comparison**: model, endpoint and harness differ. The current registry has no credential accepted by both Claude and Codex. |
| `skill-stock` | Claude/`opus_bedrock`, explicit stock baseline and supplied skill commit treatment. Claude supports both ref and none. |
| `models` | Codex stock with `openai_responses` (gpt-5.5) and `openai_responses_56sol` (gpt-5.6-sol). The credential selects the model; do not add an arm model override. |

These examples use the smoke scenario to check the journey, not to establish a
useful behavioral model ranking. Replace it with scenarios suited to the
question, preserving explicit baseline and treatment roles. A one-arm declaration
uses `arm:` and reports a single-arm measurement without a comparison delta.
Claude, Codex, Pi and Copilot support ref and none. Kimi supports ref only; the
fake adapter supports none only. Other adapters require their declared capability;
registration refuses unsupported combinations rather than assuming support.

## Credentials and machine prerequisites

Use the prepared Linux container runtime and the installed helper/configuration
from [the appliance runbook](appliance-runbook.md). Ensure the configured absolute
`container.results_root` directory exists and is writable by the runtime. The
helper pins `superpowers-evals:local` to its resolved image digest before attempts
are prepared. No campaign can bypass source, credential, host-ownership or
platform checks through a CLI flag or environment variable.

The general comparison examples select `sonnet5` as grader: direct Anthropic
`claude-sonnet-5`, using `ANTHROPIC_API_KEY` and an explicit two-slot campaign cap. This source
capacity is not a claim about an account's verified provider quota. Claude Mantle subjects require
`AWS_BEARER_TOKEN_BEDROCK`; Codex/Pi OpenAI subjects require `OPENAI_API_KEY`;
Kimi requires `KIMI_MODEL_API_KEY`. The source cap of two graders (versus six in the Mantle declaration) and
Kimi's one subject slot intentionally limit throughput. They do not establish
same-workday readiness or measured quotas. A separately keyed Mantle grader
remains configuration-only: declare its supported `api: mantle`,
`auth: bedrock-bearer`, region, model, distinct `api_key_env`, and explicit
concurrency cap, then select it in the suite. No auth bridge is needed.
These are prerequisite names, not supplied
credentials. Keep actual values in the configured blessed bundle, never Git.
The grader key must differ in value from every selected subject secret. Missing
keys and aliasing the same secret under different names refuse preparation.
Those examples' direct Anthropic grading route differs from historical Mantle
grading: do not infer numerical continuity with those historical runs. No auth
bridge or expanded harness allowlist is implied by an example.

## One execution

```bash
evals-appliance campaign register /path/to/suite.yaml --global-cap 4 --json
evals-appliance campaign list --json
evals-appliance campaign status <campaign-id> --json
evals-appliance campaign run <campaign-id> --json
evals-appliance campaign status <campaign-id> --json
evals-appliance campaign costs <campaign-id> --json
evals-appliance campaign report <campaign-id> --json
```

Use `experiment.campaign_id` from registration, or the exact published directory
basename. The UUID and directory basename are different. `run` consumes exactly
one start and launches the fixed private controller through its gate. Repeating
`run` cannot restart ended or interrupted work. One host admits one spender;
attempts may run concurrently within the frozen global and credential caps.
Admission checks live resource floors and the registered CPU/memory/disk fingerprint.
Stale host telemetry refuses further activation or worker launch, including after
slow preparation; it does not prevent termination of already owned workers.
Credential aliases share key loads by logical pool and public key environment name.
Within a pool, an overlapping key must have the same derived per-key limit
(`ceil(frozen pool capacity / inventory size)`) for every alias. Different or
reordered inventories are allowed when shared-key limits agree; conflicting
pooled, singular or bearer-key allowances fail registration.
Ordinary appliance job IDs are not campaign selectors: generic job
status/show/costs/cancel and detached workers refuse campaign invocation receipts.
Raw `quorum campaign register|run|cancel|report` directs operators to the helper.

`n` fixes planned samples per arm and scenario. `reserve` provides finite
whole-block replacement capacity without increasing planned samples.
`attempt_bounds.max_attempts` and `max_time_s` bound execution count and each
attempt's runtime. `max_exposure_skew` bounds acceptable within-block start
exposure difference. These are work limits, not a dollar ceiling. Missing prices
do not stop behavioral measurement. Unknown actor failures remain indeterminate;
unsupported subject signals do not authorize provider retry/latch, and coordinated
subject lifecycle is deferred. Qualified grader process facts retain their
existing failure precedence and provider policy.

## Read and stop

Status and costs use the canonical journal/ownership readout. While active they
hide behavioral outcomes. Costs include every durable attempt, including excluded,
failed and replacement work, with subject/grader known subtotals and explicit
missing/unpriced coverage. Unknown cost is not zero and totals are estimates,
not an invoice. Behavioral reports require a terminal prefix or conclusively
lost controller; unknown ownership does not unlock them.

Unsealed report commands preserve immutable JSON and Markdown snapshots under
`<campaignDir>/report-snapshots/<journal-sequence>-<report-content-digest>/`.
Repeated identical readouts reuse that location; a newer prefix or changed evidence
availability produces another snapshot. Earlier snapshots are never overwritten.
Only a complete, completed, termination-verified report command publishes canonical
`<campaignDir>/report.json`, `report.md` and `report-seal.json` after rederivation.
Reading after controller loss before cancellation cannot occupy those final paths.

Per-arm pass rates use selected usable determinate outcomes, with a separate
explicit denominator. Per-arm cost/token/wall means use those same determinate
outcomes and independent available counts; a partial role-cost subtotal is excluded
from its descriptive mean. Paired quantities retain their distinct complete-pair
cohorts. All-attempt accounting is also grouped by arm, retaining discarded,
indeterminate, unaccepted and replacement work exactly once per attempt. Partial
known role costs stay in accounting even when a complete mean is unavailable.
Campaign elapsed seconds span the frozen start claim (`claimed_at`) to the `ended`
transition timestamp. This includes admission/wait time, excludes subsequent
termination work, and is not the sum of overlapping worker durations. Without both
endpoints, elapsed remains missing rather than advancing with report read time.

```bash
evals-appliance campaign cancel <campaign-id> --json
evals-appliance campaign status <campaign-id> --json
evals-appliance campaign report <campaign-id> --json
# A new attempt at the question always gets a new identity:
evals-appliance campaign register /path/to/suite.yaml --global-cap 4 --json
```

Cancellation writes durable intent and verifies exact controller and worker
termination. After controller loss, cancel reconciles termination only. A freshly
dead holder's lease can remain unreclaimable for 150 seconds (30-second heartbeat,
five missed intervals). An immediate cancel can return `unresolved` with status
`stopping` and next action `cancel`; inspect its reason, allow the lease to become
stale, then retry cancellation. Unknown process identity or unsettled starts
retain ownership. Do not delete locks or launch another identity around them.

An interrupted report is explicitly incomplete. For a complete, terminated execution, the `report` command
publishes and canonically seals its report; incomplete reports are unsealed.
Publication is immutable: an accounting-prefix conflict is an error, not an
overwrite. Attempt artifact refs are `<runId>/<file>` under the configured results
root; control refs are under the campaign directory. Keep both roots with the
journal and frozen document when retaining evidence. Do not move or migrate old
campaigns/results to make them readable by V2.

Phase 0 `quorum campaign acquire|estimates|simulate` remains available for corpus
analysis. Ordinary direct `quorum run`/`run-all` remain development workflows with
actual platform checks. Portable fake-command tests establish source behavior;
they do not establish Linux container isolation, installed cutover or provider
readiness. Gated Linux fake-provider qualification and any paid run need separate
operational authorization.

## PR 2258 shared observer comparison

The experiment-specific suites are `suites/pr2258_parallel_diagnostic.yaml`
and `suites/pr2258_parallel_measured.yaml`. They compare base/head within
Codex Astra, Codex Sol and Claude Opus 5 on
`brainstorming-todo-shared-intent`. The diagnostic plans six fresh attempts
(one pair per stack); measured plans twelve different attempts (two pairs per
stack). Both use global cap six, zero reserves, one attempt per slot, a
2,400-second attempt ceiling and a 60-second exposure-skew bound.

These suites select Mantle `sonnet5_bedrock_pr2258_grader`, whose public key
variable is `QUORUM_PR2258_GRADER_BEARER`. The actual secret must be distinct
from the Opus subject bearer. Public configuration alone does not establish
that separation, quota, native CLI support or installed readiness.

Before registration and execution, run the non-launching preflight against the
approved private qualification root containing `receipt-set.json`:

```bash
bun scripts/pr2258-preflight.ts diagnostic /absolute/approved/qualification
bun scripts/pr2258-preflight.ts measured /absolute/approved/qualification
```

The loader authenticates explicit reviewed receipts, their referenced evidence,
pricing bytes and the observer source inventory. Reviewed claims still require
human or independent agent judgment; a digest proves byte identity, not semantic
truth. Diagnostic readiness requires qualified capability evidence. Measured
readiness additionally requires a reviewed diagnostic GO with the same pins,
three valid pairs, six subject exposures, exact served roles, complete accounting
and acceptable overlap/skew. Missing evidence refuses readiness.

The observer freezes raw sources, artifact receipts, review input and strict
score together. After exact container shutdown, publication accepts the unchanged
candidate only if its final bound source inventory still matches. A telemetry
append is a mismatch. Independent review sidecars live outside sealed runs;
cosmetic annotations do not change strict scores. The strict cohort uses
authenticated valid block pairs and determinate strict scores independently of
the general composed cohort. Missing independent review withholds interpretation
and cosmetic labels while retaining authenticated sealed scores.

Follow the [completion plan](superpowers/plans/2026-09-05-pr2258-completion.md)
for concrete Linux, installed and spending gates and the
[execution receipts](experiments/2026-09-05-pr2258-completion-receipts.md) for
current completion status. Source tests and declarations do not close these
gates. Historical diagnostic runs are excluded from both fresh campaigns.
