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

An arm may declare `effort: <level>` to pin the coding agent's effort for
every run of that arm. Codex accepts `minimal | low | medium | high | xhigh`
and receives it as the root `model_reasoning_effort` in its generated
config; Claude accepts `low | medium | high | xhigh | max` and receives it
as `CLAUDE_CODE_EFFORT_LEVEL` through the run-scoped env file its launcher
forwards. Any other harness refuses `effort` at `quorum check` and at
registration. The declared level is frozen with the arm bytes and stamped
into each verdict's `provenance.effort`; the effective level is only proven
by the raw session log. A scenario `codex.config.toml` that also sets
`model_reasoning_effort` makes the attempt a setup error rather than a
duplicate-key TOML failure inside Codex.

## Credentials and machine prerequisites

Use the prepared Linux container runtime and the installed helper/configuration
from [the appliance runbook](appliance-runbook.md). Ensure the configured absolute
`container.results_root` directory exists and is writable by the runtime. The
helper pins `superpowers-evals:local` to its resolved image digest before attempts
are prepared. No campaign can bypass source, credential, host-ownership or
platform checks through a CLI flag or environment variable.

The examples and active suites select `sonnet5` as grader: direct Anthropic
`claude-sonnet-5`, using `ANTHROPIC_API_KEY` and an explicit two-slot campaign cap. This source
capacity is not a claim about an account's verified provider quota. Claude Mantle subjects require
`AWS_BEARER_TOKEN_BEDROCK`; Codex/Pi OpenAI subjects require `OPENAI_API_KEY`;
Kimi requires `KIMI_MODEL_API_KEY`. The source cap of two graders (versus six in the Mantle declaration) and
Kimi's one subject slot intentionally limit throughput. They do not establish
same-workday readiness or measured quotas. Select the existing
`sonnet5_bedrock` grader to use Mantle. A Mantle subject and grader may share
provider authority when both declarations select `api: mantle`,
`auth: bedrock-bearer`, the same region, and the same `api_key_env` name.
This uses the existing blessed bundle; no additional key or auth bridge is needed.
These are prerequisite names, not supplied
credentials. Keep actual values in the configured blessed bundle, never Git.
Outside that explicit shared Mantle source, the grader key must differ in value
from every selected subject secret. Missing keys and aliasing the same secret
under different names refuse preparation.
The active suites' direct Anthropic grading route differs from historical Mantle
grading: do not infer numerical continuity with those historical runs. No auth
bridge or expanded harness allowlist is implied by an example.

## Optional pricing snapshot

For models whose prices need an explicit table, a suite can declare
`pricing_snapshot: { path: <Evals-relative current.json>, sha256: <SHA-256> }`.
Commit the file with the arm declarations. Registration freezes its identity
with the experiment, and worker preparation verifies those bytes before
creating credential files. The worker uses that directory through the existing
read-only Evals mount. Credential delivery cannot override `OBOL_PRICING_DIR`.
Suites without a snapshot retain normal bundled pricing behavior.

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
When dispatch priorities tie, the scheduler considers the first repetition
across comparisons and scenarios before later repetitions. Resource and
credential limits still determine which blocks can actually start.
Admission checks live resource floors and the registered CPU/memory/disk fingerprint.
Stale host telemetry pauses further activation or worker launch, including after
slow preparation: a slow controller stretch, such as publishing a large run,
holds launches until the next host sample lands, and a sampler silent for six
cadences ends the campaign as before. It does not prevent termination of already
owned workers.
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

The check phase's scratch (the checks' private `HOME`/`TMPDIR`) is rooted at the
attempt container's `/tmp`, which the spawner mounts as a separate tmpfs with
`exec` (Docker's tmpfs default is `noexec`), because the attempt scratch tmpfs
is mounted `noexec` and a check that builds a binary there (`go test`) could not
run it.

Campaign runs prune dependency trees (`node_modules`, `.venv`, at any depth
under the coding-agent workdir) before the attempt manifest is written, since
they are reproducible from the project's dependency declarations (lockfiles,
`pyproject`) and not behavioral evidence; development `quorum run` results keep
them. Post checks run before the prune, so a published workdir cannot re-run a
check that invokes a pruned tree (for example `./.venv/bin/pytest`); the frozen
check records in `verdict.json` remain the authoritative evidence of check
outcomes.

Phase 0 `quorum campaign acquire|estimates|simulate` remains available for corpus
analysis. Ordinary direct `quorum run`/`run-all` remain development workflows with
actual platform checks. Portable fake-command tests establish source behavior;
they do not establish Linux container isolation, installed cutover or provider
readiness. Gated Linux fake-provider qualification and any paid run need separate
operational authorization.
