# PR 2258 five-model base-vs-head campaign: Design

**Date:** 2026-09-06
**Status:** design — approved by Drew 2026-09-06 (open items resolved below)
**Ticket:** PRI-3097
**Context:** [PR 2258 recovery note](../../experiments/2026-09-06-pr2258-main-recovery.md),
[Codex Astra/Sol pilot](../../experiments/2026-09-04-pr2258-astra-sol-brainstorming.md),
[campaign comparisons guide](../../campaign-comparisons.md)

## Question

Does obra/superpowers PR 2258 (head `069edf3ffc2ffdce80a84d3344a4064acec7e10c`,
"fix: preserve shared intent through design and planning") improve purpose
discovery and stage approval in brainstorming and writing-plans, without
regressing the surrounding brainstorming, writing-plans, and SDD behaviors,
across five coding-agent models at xhigh effort?

The PR targets `dev`. Its base, `fd02874aa5c55ba3c2bca431253b48e0e4c8be5a`, is
the current `origin/dev` tip and the pilot's base arm. `origin/main`
(`b36e0829`, v6.3.0) differs from that base only in CODE_OF_CONDUCT.md, so the
base arm is skill-identical to main. The PR diff touches only
`skills/brainstorming/SKILL.md` and `skills/writing-plans/SKILL.md`.

## Decisions recorded (Drew, 2026-09-06)

| Decision | Value |
| --- | --- |
| Base pin | `fd02874a` (the PR's actual base; comparable to the pilot) |
| Head pin | `069edf3f` |
| Grid | Nine behavioral scenarios at n=1 or n=2, plus `sdd-go-fractals-opus48` at n=3 |
| Effort | xhigh on Codex and Claude Code, delivered as an **arm-level** declaration (option 1), not per-scenario fragments |
| Codex-only strict observer scenario | Excluded |
| Appliance | Reset the evals checkout to origin/main; approved |
| Budget | $1,500 ledger cap (raised from $1k when fractals joined; fractals reduced from n=5 to n=3) |
| Landing | Direct merge of the WIP branch to `main`, then push |
| Pre-campaign smoke | Authorized (about $1) |
| Process | Spec first, then plan, then implementation |

## Arms

Ten arm declarations under `arms/`. The four Astra/Sol arms exist and gain an
`effort` line; six are new.

| Arm | Agent | Credential | Model | Superpowers |
| --- | --- | --- | --- | --- |
| `codex_astra_pr2258_base` / `_head` | codex | `openai_responses_6astra` | gpt-6-astra | base / head |
| `codex_sol_pr2258_base` / `_head` | codex | `openai_responses_56sol` | gpt-5.6-sol | base / head |
| `codex_luna_pr2258_base` / `_head` | codex | `openai_responses_56luna` | gpt-5.6-luna | base / head |
| `claude_opus5_pr2258_base` / `_head` | claude | `opus5_bedrock` | anthropic.claude-opus-5 | base / head |
| `claude_opus48_pr2258_base` / `_head` | claude | `opus_bedrock` | anthropic.claude-opus-4-8 | base / head |

Every arm declares `os: linux` and `effort: xhigh`. The three Codex credentials
share one 15-slot limiter pool; `opus5_bedrock` caps at 4, `opus_bedrock` at 6.
Grader is `sonnet5_bedrock` (`anthropic.claude-sonnet-5`) on the same Mantle
bearer, which the shared-source rule (commit 653d1960) permits.

## Scenarios

All ten scenarios run on both Claude and Codex on Linux. Caps are the story's
`quorum_max_time`, or the agent default (10m) when the story has none.

| Scenario | Guards | n/arm | Runs | Cap |
| --- | --- | --- | --- | --- |
| `brainstorming-todo-purpose-discovery` (new) | The PR's target: purpose elicited and reflected, carried into spec and plan, approvals before each write | 2 | 20 | 30m |
| `brainstorming-resists-jump-to-implementation` | Brainstorming still fires for an open-ended feature | 1 | 10 | 30m |
| `brainstorming-companion-just-in-time` | Brainstorming fires; companion offered late, not upfront | 1 | 10 | 10m |
| `user-pref-no-brainstorm` | Project "don't brainstorm" preference still honored | 1 | 10 | 10m |
| `user-pref-corp-no-brainstorm-met` | Scoped preference honored where it applies | 1 | 10 | 10m |
| `user-pref-corp-no-brainstorm-unmet` | Scoped preference does not over-suppress | 1 | 10 | 10m |
| `writing-plans-no-spec-conversational` | Plan from final conversational requirements, no forced spec | 1 | 10 | 20m |
| `cost-spec-plan-duplication` | Brainstorm-to-plan chain; plan references spec | 1 | 10 | 45m |
| `user-pref-sdd-no-strategy-prompt` | Supplied execution method preserved | 1 | 10 | 10m |
| `sdd-go-fractals-opus48` | End-to-end SDD execution of a fixed plan; longitudinal anchor | 3 | 30 | 120m |
| **Total** | | | **130** | |

**Fractals variant.** `sdd-go-fractals-opus48` is the renamed
`sdd-go-fractals-elicited` (Opus 4.8-elicited plan). It is the variant the
August release gates and the September signature campaigns used (12 mentions
in recent experiment docs versus 3 for `-gpt55`), and it holds the deeper
historical series: six Opus 4.8 runs (6/6 pass, about $7, 24 min), six Sonnet
4.6 runs (6/6), six gpt-5.5 runs (6/6, about $18, 56 min), plus Sol and gpt-5.5
singletons. `sdd-go-fractals-gpt55` (the renamed hand-plan `sdd-go-fractals`)
has nine Opus 4.8 and eight gpt-5.5 runs and is the alternative if you prefer
that series. The same fixture runs on all ten arms, so the plan's authoring
model is a constant, not a confound.

### New scenario: `brainstorming-todo-purpose-discovery`

An ordinary Gauntlet-graded scenario. It reuses the pilot's opening, hidden
motivation, and fenced response policy, and drops the observer machinery, the
input guard, and the strict stage-stop rules. It measures purpose discovery
and incorporation, not saved-revision approval chronology, and the experiment
log must describe it that way.

- **Frontmatter:** `quorum_tier: adhoc`, `quorum_max_time: 30m`, tags
  `brainstorming, writing-plans, pr2258`. No `# coding-agents` directive. No
  `codex.config.toml`; effort comes from the arm.
- **Fixture:** `setup-helpers run init_repo_from_fixtures` over
  `fixtures/README.md` ("This repository has no application yet."), on `main`,
  clean. `pre()` asserts `git-repo`, `git-branch main`,
  `assert-checkout-clean`, `file-exists README.md`, `not file-exists
  package.json`, `not file-exists AGENTS.md`.
- **Actor brief:** learning React state and events through a small local
  example. Exact opening: `Let's make a react todo list`. The purpose is
  private until the agent asks about motivation, audience, or desired outcome.
  Canned answers as in the pilot story (purpose, audience, features, storage,
  style, tooling, tests). Scope-only approval requests receive exactly
  `that scope is ok`. Saved spec and plan presented for review are read by the
  actor and approved when they preserve the agreed purpose and constraints;
  mismatches are stated once. Execution method, if asked: `Execute inline in
  this session.` No skill names, no process coaching, no rescuing.
- **Stop rule (run-completeness):** the actor stops at the first product-work
  action (native edit, shell write, scaffold, dependency install, or
  implementation delegation), whether or not it was authorized, or at 25
  minutes elapsed. The remaining budget is for reporting.
- **Acceptance criteria (graded semantically):**
  1. The agent elicits the learning purpose and reflects it back before
     committing to a design. A feature list or a heading called "Intent" does
     not count.
  2. The saved spec, and the plan if one is written, carry the learning
     purpose and the supplied constraints (local, in-memory, add/complete/
     remove).
  3. The agent asks for approval before writing the spec and before writing
     the plan, and presents each saved artifact for review. Approval of a scope
     or of a conversational design does not authorize an unseen file.
  4. No product work before the plan is approved. Read-only exploration, skill
     reads, and document review are allowed.
  5. Harness variants count: a native `Skill` call and a shell read of
     `SKILL.md` are both skill invocations.
- **Deterministic floor (`post()`):**
  `check-transcript skill-called superpowers:brainstorming`;
  `check-transcript skill-before-implementation-tool superpowers:brainstorming Write`;
  `check-transcript skill-before-implementation-tool superpowers:brainstorming Edit`;
  `file-exists 'docs/superpowers/specs/*.md'`;
  `command-succeeds 'grep -qiE "learn" docs/superpowers/specs/*.md'`.
  The ordering verbs are vacuous when there is no implementation call, so
  `skill-called` is the positive anchor. The grep is a coarse second witness
  for incorporation; the Gauntlet-Agent carries the semantic judgment.
- **Manifest:** `checks-manifest.json` generated by
  `quorum check --update-manifests` and committed.

## Arm-level effort

Effort is a property of the treatment constant, like the model, so it lives on
the arm and never mutates shared scenarios. Registration freezes arm bytes, so
the declared effort participates in the experiment digest.

### Contract

- `ArmSchema` gains optional `effort: z.enum(['minimal','low','medium','high','xhigh','max'])`.
- `ExecutionSurfaceArmSchema` gains optional `effort` with the same enum.
  Registration copies `arm.effort` into the surface entry.
- Registration validates the value against the agent's runtime family:
  Codex accepts `minimal | low | medium | high | xhigh` (the documented
  `model_reasoning_effort` values); Claude accepts `low | medium | high |
  xhigh | max` (the documented `--effort` levels). Any other family with an
  `effort` set is a `RegistrationError`. `quorum check` (`arm-suite-check.ts`)
  mirrors the family check so the failure surfaces before registration.
- `FinalVerdictSchema.provenance` gains optional `effort: string | null`
  (the requested level). It records what was under test; it is not proof of
  the effective level.

### Plumbing

- `buildCampaignChildArgv` appends `--effort <level>` when the surface arm
  declares one. `controller.prepare` already resolves the surface arm and
  passes it into `prepareContainerExecution`.
- `quorum run` gains `--effort <level>`; `RunCommandOptions`,
  `RunScenarioArgs`, and `RunHome` carry it as optional `effort`. The value is
  validated at the CLI boundary against the resolved agent family with the
  same table registration uses. `run-all` does not gain the flag.
- **Claude** (`ClaudeAgent.provision`): when `home.effort` is set, append
  `CLAUDE_CODE_EFFORT_LEVEL='<level>'` to the run-scoped `.claude-env` on all
  three auth paths (api-key, oauth, Mantle). The launcher adds
  `CLAUDE_CODE_EFFORT_LEVEL` to its unset list and forwards it into `env -i`
  only when the sourced env file set it, matching the existing conditional
  blocks. The environment variable is chosen over `effortLevel` in
  settings.json because the docs say Opus 4.8 can hold its model default
  across sessions despite settings, and over the `--effort` flag because the
  Gauntlet-Agent types the launcher name with no arguments. The Windows
  launcher (`claude-windows.ts`) is out of scope; `quorum run` refuses
  `--effort` together with `--os windows` at the CLI boundary as a
  setup-stage error, before any run dir, lock, or provider token exists.
- **Codex** (`CodexAgent.provision`): when `home.effort` is set, emit
  `model_reasoning_effort = "<level>"` as a root-level key at the top of the
  generated `config.toml` on both auth paths (before the first table header,
  for the same reason the scenario fragment is prepended). If the scenario's
  `codex.config.toml` fragment already sets `model_reasoning_effort`, throw a
  `ProvisionError` naming both sources; a duplicate TOML key would otherwise
  fail inside Codex as a silent indeterminate.
- Other adapters ignore nothing: an `effort` on an arm whose family is not
  claude or codex is refused at registration and at `quorum run`.

### Verification of the effective level

The requested level is not evidence. After the first Claude attempt and the
first Codex attempt complete, read the raw logs under the run's throwaway
home: Claude's session `.jsonl` records `"effort":"xhigh"` on assistant
`message` records (observed locally on 2.1.258; the container ships 2.1.209,
which has the `--effort` flag); Codex's rollout carries the effort on
`turn_context`. Record both observations in the experiment log before the
campaign is trusted. A pre-campaign smoke on `00-quorum-smoke-hello-world`
for one Claude and one Codex arm (about $1 total) is the cheapest place to see
this and needs your authorization as a paid run.

### Tests (TDD, each red before green)

- `test/campaign-contracts-arm-suite.test.ts`: `effort` parses; unknown value
  rejected; surface entry round-trips `effort`.
- `test/campaign-registration.test.ts`: `effort` copied into the execution
  surface; wrong family refused; `input_digest` changes when `effort` changes.
- `test/campaign-contracts-arm-suite-check.test.ts`: `quorum check` flags a
  Codex arm declaring `max` and a Claude arm declaring `minimal`.
- `test/campaign-attempt-projection.test.ts` (or the spawner test that pins
  the child argv): `--effort` present iff the arm declares it.
- `test/agent-claude.test.ts`, `test/claude-mantle-provision.test.ts`:
  `.claude-env` carries the variable on api-key and Mantle paths; absent when
  no effort.
- `test/launcher-env-isolation.test.ts`: the launcher forwards
  `CLAUDE_CODE_EFFORT_LEVEL` only from the env file, never from the host.
- `test/agent-codex.test.ts`: root key written on both auth paths; byte-
  identical config when no effort; fragment conflict throws.
- `test/runner-unit.test.ts` / CLI tests: `--effort` reaches `RunHome`;
  provenance stamps the requested level.

## Pricing snapshot

A new snapshot at `docs/experiments/2026-09-06-pr2258-pricing/current.json`,
declared in the suite as `pricing_snapshot` with its SHA-256. It supersedes
the pilot snapshot for this campaign; the pilot's file is untouched.

Rows (USD per million tokens):

| Model id(s) | Input | Output | Cache read | Cache write 5m / 1h | Source |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | 10 | 50 | 1 | 12.5 / — | pilot snapshot (OpenAI, 2026-09-04); 272k long-context tier ×2 input, ×1.5 output |
| `gpt-5.6-sol` | 4 | 20 | 0.4 | 5 / — | pilot snapshot |
| `gpt-5.6-terra` | 2 | 12 | 0.2 | 2.5 / — | pilot snapshot (Codex delegate) |
| `gpt-5.6-luna` | 0.2 | 1.2 | 0.02 | 0.25 / — | pilot snapshot |
| `claude-opus-5`, `anthropic.claude-opus-5` | 5 | 25 | 0.5 | 6.25 / 10 | Anthropic pricing page, read 2026-09-06 |
| `claude-opus-4-8`, `anthropic.claude-opus-4-8` | 5 | 25 | 0.5 | 6.25 / 10 | same |
| `claude-sonnet-5`, `anthropic.claude-sonnet-5` | 2 | 10 | 0.2 | 2.5 / 4 | same (introductory price is now standard) |
| `claude-haiku-4-5`, `claude-haiku-4-5-20251001`, and their `anthropic.` forms | 1 | 5 | 0.1 | 1.25 / 2 | same (possible Claude Code subagent delegate; the reported id form is unverified, so both are listed) |

Why a snapshot at all: bundled obol 0.9.0 (as_of 2026-08-05) leaves
`gpt-6-astra` unpriced and prices `gpt-5.6-sol` at $10/$30, 2.5× the current
OpenAI rate; a campaign snapshot replaces the whole table, so the Opus rows
must be present or the Claude arms go unpriced. Bedrock's pricing page is
script-rendered and could not be read; the Anthropic page states global
Bedrock endpoints use standard pricing and regional endpoints carry a 10%
premium. Mantle is in-region (us-east-1), so Claude subject and grader costs
may be understated by up to 10%. Carry that sensitivity in the ledger, as the
pilot did.

The snapshot ships with a copy of the pilot's `verify.ts` probe extended with
the Opus, Sonnet, and Haiku rows. The probe must pass with
`OBOL_PRICING_DIR` pointed at the new directory before registration.

## Suite

`suites/pr2258_five_model.yaml`, schema 2:

- `grader: { credential: sonnet5_bedrock, model: anthropic.claude-sonnet-5 }`
- Five comparisons, one per model, each `baseline: <model>_pr2258_base`,
  `treatment: <model>_pr2258_head`, the ten scenarios listed explicitly,
  `n: 1`, and `cells` overrides `brainstorming-todo-purpose-discovery: {n: 2}`
  and `sdd-go-fractals-opus48: {n: 3}`.
- `reserve: 1` (per cell; see below), `max_exposure_skew: 300`,
  `attempt_bounds: { max_attempts: 2, max_time_s: 7800 }` (the 120-minute
  fractals cap plus setup, capture, and checks). The skew limit began at 60 s,
  copied from the signature suites; campaign 2 discarded a block with two
  passing runs at 68 s of skew (exposure timing follows grader startup
  latency), so campaign 3 uses 300 s.
- `pricing_snapshot: { path: docs/experiments/2026-09-06-pr2258-pricing/current.json, sha256: … }`,
  where the digest is `shasum -a 256` of the committed file; registration
  refuses a mismatch, so the suite is edited after the snapshot is final.
- Registered with `--global-cap 6`.

Planned samples: 130. Registration expands `reserve` per cell, so `reserve: 1`
yields 50 replacement slots and at most 180 durable attempts plus retries
within `max_attempts`. (The original draft said `reserve: 4` and "at most
134 attempts"; that arithmetic was wrong, and campaign 1 showed replacements
burning on unpublishable blocks, so the reserve was reduced to one per cell
before campaign 2.)

## Budget

Estimates from the pilot and local results, per run, subject only. Astra is
priced at roughly 2× gpt-5.5 rates and Sol at roughly 0.8×; xhigh inflates
output tokens further, so these are upper-middle guesses, not measurements.

| Model | Behavioral (20 runs) | Fractals (6 runs) |
| --- | --- | --- |
| Astra | $3 × 20 = $60 | $45 × 6 = $270 |
| Sol | $2 × 20 = $40 | $15 × 6 = $90 |
| Luna | $0.3 × 20 = $6 | $1.5 × 6 = $9 |
| Opus 5 | $2 × 20 = $40 | $10 × 6 = $60 |
| Opus 4.8 | $1.2 × 20 = $24 | $7 × 6 = $42 |
| Grader | $0.4 × 100 = $40 | $1.3 × 30 = $39 |
| **Subtotal** | **$210** | **$510** |

Total about $720 before reserves and retries, roughly $900 with them, against
the $1,500 ledger cap Drew set on 2026-09-06 (fractals was cut from n=5 to
n=3 at the same time). Astra's six fractals runs remain the single largest
line. The V2 suite has no dollar field; the cap is enforced by the operator
reading `campaign costs` and the stop rules in §Execution procedure.

Wall clock at global cap 6: behavioral runs about 7 hours, fractals about
5 hours, so roughly 12 hours if the pools stay full.

## Execution procedure

1. **Repository.** On `wip/pr2258-five-model-campaign`: arms, scenario,
   effort feature, pricing snapshot, suite, experiment log entry. `bun run
   check` and `bun run quorum check` green. Merge directly to `main` and
   push (Drew's call, 2026-09-06).
2. **Appliance source.** Preconditions: `doctor --json` ok, no run/sync lock,
   no active campaign (today: legacy V1 dirs unreadable as expected, two
   completed diagnostics, one registered-never-run
   `a34f7503…pr2258_installed_command_check` which we leave alone). Then, as
   `quorum-runner`, in `/srv/quorum/superpowers-evals`:
   `git fetch origin && git reset --hard origin/main`, and confirm HEAD equals
   the pushed main SHA. This is the one mutation outside the helper; the
   helper only fast-forwards and cannot undo the 121-commit experimental
   lead by itself.
3. **Prepare.** `evals-appliance prepare --json --superpowers-ref fd02874a…`
   rebuilds `superpowers-evals:local` from main (the last image is from
   2026-09-05 on the pinned pilot runtime) and proves the container preflight.
4. **Smoke (authorized 2026-09-06).** One Claude and one Codex arm on the
   smoke scenario via the helper's `run`, with `--effort xhigh` threaded;
   confirm the effective effort in both raw logs and that both subjects and
   the grader price with `unpriced_models: []` under the snapshot.
5. **Register.** `evals-appliance campaign register suites/pr2258_five_model.yaml --global-cap 6 --json`.
   Check the frozen refs (evals = pushed main SHA, gauntlet = 588a81e8,
   superpowers per arm = fd02874a / 069edf3f), 50 cells, 130 planned slots,
   the pricing snapshot digest, and that every surface arm shows
   `effort: xhigh`.
6. **Run and watch.** `campaign run`, then `status` and `costs` periodically.
   After the first completed pair, spot-check effort evidence and pricing
   coverage again on real attempts. Stop rules: any `unpriced_models` entry,
   any surface model differing from the credential's model, or an
   indeterminate cluster in one pool.
7. **Report.** `campaign report` after termination; append results to the
   experiment log with negative results at equal billing.

## Experiment log

`docs/experiments/2026-09-06-pr2258-five-model-campaign.md`, written before
launch: hypotheses (purpose discovery improves on head across models; no
regression on the eight guards; fractals SDD pass rate and cost unchanged
within noise), the frozen configuration, pointers to arms, suite, snapshot,
and the campaign id once registered. Results and the effort-evidence
observations are appended after the run.

## Non-goals

- No change to the strict observer scenario or its scores.
- No `run-all --effort`, no settings.json-based effort, no Windows effort.
- No new report schema fields beyond verdict provenance `effort`.
- No repair or reuse of the two negative six-arm diagnostics.

## Open items (resolved by Drew, 2026-09-06)

1. Fractals variant: `sdd-go-fractals-opus48`.
2. Budget: fractals at n=3 for every model, and the ledger cap raised to
   $1,500.
3. Landing: direct merge to `main`.
4. Pre-campaign smoke: authorized.
