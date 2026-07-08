# Bedrock/Mantle eval auth — design (PRI-2517)

**Status:** design approved 2026-07-08; revised the same day after an adversarial
review (workflow `wf_5993aa3e-239`, verdict *revise-spec*); implementation not
started.
**Supersedes the scope of** [PRI-2517] (originally "opt-in Bedrock credential,
coding-agent only").
**Related:** PRI-2494 (launcher `env -i` isolation — must not regress).

## Motivation

We hold abundant AWS Bedrock credits but pay the direct Anthropic API by credit
card. Moving the eval harness's Anthropic consumers onto Bedrock makes eval
inference nearly free. The **two Claude-Code Anthropic consumers** move:

- the **Claude coding-agent** under test (Claude Code CLI), and
- the **Gauntlet-Agent** (the QA driver / grader, a Node service on `@anthropic-ai/sdk`).

`serf` and the direct-API control credentials (`sonnet`/`sonnet46`/`haiku`) stay
on the direct API by design (sonnet-4-6 is not on Mantle; the controls are the
deliberate comparison baseline). The direct-API path still works; this is
*add-a-path-and-make-it-default*, not *lost-the-key*.

## Locked decisions

1. **Endpoint = Mantle.** Bedrock's Mantle endpoint serves Claude via the native
   Anthropic Messages shape and accepts a Bedrock API key with **no SigV4**, so
   neither consumer needs request signing. Mantle-only; we build no Invoke/SigV4
   path (see Non-goals).
2. **Bedrock is the default; direct-API is the opt-out.** An opt-in nobody
   remembers to pass saves no money. The Claude coding-agent defaults to Mantle;
   `--credential opus` (the existing direct-API credential) is the explicit escape
   hatch. **The grader endpoint is controlled globally by the bundle/config,
   independently of `--credential`** (it is not a resolved credential — see the
   grader path); `--credential opus` reverts only the coding-agent, not the grader.
3. **Auth = a long-lived Amazon Bedrock API key** (`AWS_BEARER_TOKEN_BEDROCK`),
   IAM-backed, in the blessed bundle. Matches every other provider's static-secret
   shape; is governed by an IAM principal + scoped policy. (Rejected: IAM access
   keys — the odd provider-out, and they force gauntlet into SigV4; instance-role
   via IMDS — the appliance deliberately blocks container IMDS, and opening it
   would hand the host role to the permissive agent-under-test.)
4. **Grader = Sonnet 5, moved in two governed steps.** Sonnet 4.6 is not on Mantle
   and is the current grader + sonnet control model. The **grader-model change
   (Sonnet 4.6 → 5) lands first, on the direct API, as a separately-baselined rung
   with a recorded verdict-flip rate**, *before* the endpoint move — so grader
   drift is isolated from the endpoint change and not misattributed to the coding
   agents. Only then does the grader move to Mantle. The Bedrock + Sonnet 5 numbers
   become canonical after both rungs.
5. **Cost visibility via obol.** obol is the shared cost source; teach it the new
   model rates (Step 0) so both paths report dollars. No local `OBOL_PRICING_DIR`
   override: that overlay *replaces the whole snapshot* (not a delta), so it would
   have to mirror the entire table — worse to maintain than a hand-add in obol. It
   remains the emergency fast path for a surprise model string.

## Models and region

All three are served on Mantle with **bare** `anthropic.claude-*` ids (no version
suffix). Sources: the per-model AWS Bedrock model cards + `code.claude.com`.

| Role | Model id (Mantle) | On Mantle? | obol prices today? |
|---|---|---|---|
| Coding-agent default | `anthropic.claude-opus-4-8` | ✅ probed 200 | **yes** — logs as `claude-opus-4-8` ($0.0176, == direct rate) |
| Grader + sonnet control | `anthropic.claude-sonnet-5` | ✅ probed 200 | **no** — logs as `claude-sonnet-5`; **only this one** needs Step 0 |
| Small-fast slot | `anthropic.claude-haiku-4-5` | ✅ probed 200 | **yes** — logs as `claude-haiku-4-5-20251001` ($0.0035) |

Mantle returns the **bare native** id in `response.model` (not the `anthropic.claude-*` request id), which is the obol pricing key. All rows probed live 2026-07-08 against account <AWS_ACCOUNT_ID> (see `docs/experiments/2026-07-08-bedrock-mantle-probe.md`).
| ~~old sonnet~~ | `anthropic.claude-sonnet-4-6` | **no** | n/a |

- **Region — `us-east-1` (US), CONFIRMED by live probe** (2026-07-08, account
  <AWS_ACCOUNT_ID>). **Mantle is In-Region-only** (no geo/global profile). Probed:
  us-east-1 Mantle serves opus-4-8 / sonnet-5 / haiku-4-5 (HTTP 200); **us-west-2
  Mantle returns 404 "model does not exist"** for opus-4-8 and sonnet-5. `us-west-2`
  is therefore **not viable** for these models on Mantle.
  Consequence for co-location: if the appliance box is in a west region, hitting
  Mantle means a cross-region call to `us-east-1` — co-locating on Mantle is not
  possible unless/until west In-Region coverage exists. **The region probe MUST do
  a real per-model Mantle round-trip and fail fast if any of the three ids is not
  In-Region.** Box placement (us-east-1) is a rollout precondition, not just an
  open item.
- **Mantle host is `*.api.aws`** (`bedrock-mantle.{region}.api.aws`), not
  `amazonaws.com` — the appliance egress allowlist must include it.
- Requests must send the HTTP header `anthropic-version: 2023-06-01`.

## Non-goals

- No Invoke API / `us.*` inference-profile / SigV4 path. A Claude model not on
  Mantle uses the direct-API `opus`-style opt-out.
- No WebSearch/server-side-tool scenarios on Bedrock (unavailable on all of
  Bedrock). Zero active scenarios use WebSearch, so this is a doc note in
  `docs/scenario-authoring.md`, not a gating mechanism.
- **`os=windows` is out of scope for the Mantle default** (see Windows subsection).
- No per-consumer credentials yet; one shared bearer key.

## Architecture

One new credential kind drives the coding-agent through Mantle; the grader is
switched by the global bundle. The two are activated by **different mechanisms
that never cross**:

- **Coding-agent:** activated per-run by `CLAUDE_CODE_USE_MANTLE=1` seeded into the
  run-scoped `.claude-env` and forwarded through the launcher's `env -i` allowlist.
  Global host vars are stripped from it.
- **Gauntlet grader:** activated by `ANTHROPIC_BASE_URL` + a bearer mapped to an
  SDK-readable var + model in the gauntlet subprocess env (gauntlet inherits the
  host env). Global — but the coding-agent's `env -i` wall makes it invisible to
  the agent under test.

Core isolation invariant: global env → grader; per-run `.claude-env` behind
`env -i` → coding-agent.

### Credential contract (`src/contracts/credential.ts`)

- Add `api: 'mantle'` to `CREDENTIAL_APIS` and `auth: 'bedrock-bearer'` to
  `CREDENTIAL_AUTHS`.
- Add optional `region` field (the schema is non-`.strict()`, so an untyped
  `region:` is silently dropped — it must be added to the schema). Add a
  `quorum check` rule: **`api: mantle` requires a non-empty `region`.**
- `credentials.yaml`: `opus_bedrock` = `{api: mantle, auth: bedrock-bearer,
  api_key_env: AWS_BEARER_TOKEN_BEDROCK, region: us-east-1, model:
  anthropic.claude-opus-4-8, harnesses: [claude], max_concurrency: 2}`. Distinct
  `api` gives it its own `limiterKey` bucket. `max_concurrency: 2` until the Bedrock
  account quota is probed (see Concurrency).
- `coding-agents/claude.yaml`: `default_credential: opus_bedrock`.
- The existing `opus` credential remains the direct-API opt-out; **pin its `model`
  to `claude-opus-4-8`** (not the floating `opus` alias) so the direct-vs-Bedrock
  comparison partner cannot drift, matching the sonnet5/sonnet46 pinning convention.
- Add a harness-membership guard in `runScenario` (the break-glass direct path):
  reject a credential whose `harnesses` excludes the agent's runtime family, so
  `--coding-agent gemini --credential opus_bedrock` fails at setup rather than
  silently mis-provisioning. (`run-all` already skips on `harnesses`.)

### Coding-agent path

- **Provision** (`ClaudeAgent.provision`, `src/agents/index.ts`): a new branch for
  the mantle credential seeds the run-scoped `.claude-env` (mode 0600) with
  `CLAUDE_CODE_USE_MANTLE=1`, `AWS_REGION=<credential.region>`, and
  `AWS_BEARER_TOKEN_BEDROCK`. Resolve the bearer through a helper that **throws
  `ProvisionError` naming `credential.api_key_env` when unset/empty** (do not write
  an empty bearer). Model rides `--model $CLAUDE_MODEL` from `credential.model`.
  **Skip `seedClaudeAuth`** (no `ANTHROPIC_API_KEY` / `apiKeyHelper` / fingerprint)
  but still write the `.claude-env` file (the launcher sources it unconditionally).
- **Launcher** (`coding-agents/claude-context/launch-agent`):
  - `unset CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_BEDROCK AWS_REGION
    AWS_DEFAULT_REGION AWS_BEARER_TOKEN_BEDROCK AWS_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE` **before**
    `source "$CLAUDE_ENV_FILE"`, so the gate and values come only from the seeded
    file, never host inheritance.
  - Append **exactly** `CLAUDE_CODE_USE_MANTLE`, `AWS_REGION`,
    `AWS_BEARER_TOKEN_BEDROCK` to the `env -i` allowlist, conditionally (only when
    the sourced file set them). **Invariant: the forward list MUST be a subset of
    the unset list** — assert this in the launcher test so a future widening cannot
    forward a non-unset (host-inherited) var. Do not copy opencode's forward loop
    (it forwards host AWS creds with no unset).
  - Make the `ANTHROPIC_API_KEY=` line conditional (present on `opus`, absent on
    Mantle, so `set -u` does not abort).
- Claude Code version floor **≥ 2.1.200**; container is 2.1.202. Leave
  `CLAUDE_CODE_SKIP_MANTLE_AUTH` unset.

#### Windows / claude-windows (out of scope for the Mantle default)

`WindowsClaudeAgent` is credential-blind (it bakes `config.model`, ignores the
resolved credential), so a Mantle default would silently run Windows on the direct
API while labeling artifacts Mantle, or `ProvisionError`. **Decision: exclude
`os=windows` from the Mantle default.** Windows Claude stays pinned to the direct
`opus` credential; the run-all matrix and `grid-manifest` mark the
`claude × windows × opus_bedrock` cell **ineligible** (a `skipped_reason`), not
eligible. Bringing Windows onto Bedrock is a later, separate effort.

### Gauntlet grader path (Phase 2)

The grader runs on `@anthropic-ai/sdk` directly (not Claude Code). Route (c): point
it at Mantle + bearer + Sonnet 5.

- **Bearer → SDK var (critical).** The base `@anthropic-ai/sdk` reads
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, **never** `AWS_BEARER_TOKEN_BEDROCK`.
  So the harness must map the bearer into the SDK-readable var on the grader env
  (`ANTHROPIC_API_KEY=<bearer>` if Mantle accepts `x-api-key`, else
  `ANTHROPIC_AUTH_TOKEN=<bearer>`), **replacing** the direct key on the Mantle
  grader path (not co-present). The accepted-header probe (`x-api-key` vs `Bearer`)
  is a **hard prerequisite** decided before the grader patch.
- **Harness** (`src/runner`): the exact code path that builds the gauntlet
  subprocess env sets, by default, `ANTHROPIC_BASE_URL=https://bedrock-mantle.<region>.api.aws/anthropic`
  (region **single-sourced** from the mantle credential, not a duplicated literal),
  the SDK-readable bearer var, and `GAUNTLET_AGENT_MODEL=anthropic.claude-sonnet-5`.
  **Fail fast** when a Mantle coding-agent run has no grader endpoint configured
  (so a bundle-less local run refuses rather than silently splitting the two
  consumers across endpoints). The grader endpoint is bundle-controlled and has no
  per-run opt-out.
- **Gauntlet code patch** (cross-repo, `github.com/prime-radiant-inc/gauntlet`):
  - `resolveProvider` maps `anthropic.claude-*` → the anthropic provider.
  - `maxOutputTokensForModel` matches Sonnet 5 (else the 4096 cap kills runs).
  - **Relax BOTH `ANTHROPIC_API_KEY`-presence guards** (`config.ts:413` and
    `anthropic.ts:27`) on the bearer path, and send only the header Mantle accepts.
- **Isolation invariant:** the coding-agent switches via `CLAUDE_CODE_USE_MANTLE` in
  its own `.claude-env` (behind `env -i`), **never** via `ANTHROPIC_BASE_URL` in
  provision `extraEnv` — `extraEnv` overlays onto the gauntlet subprocess and would
  double-route the grader. A test asserts neither path bleeds into the other.

### Shared key

One long-lived Bedrock API key serves both consumers (scoped Bedrock-only;
trusted-operator box). Per-consumer keys are a future option requiring harness
plumbing to inject different bearers per subprocess; not now.

## Concurrency and account quota

- `opus_bedrock` gets `max_concurrency: 2` (mirroring the appliance proxied-endpoint
  cap) until the account quota is probed. New-account Bedrock quotas are often
  2–3 RPM.
- The **grader is a distinct per-cell Bedrock consumer** hitting the same account
  via host env, *not* under the credential limiter. Cap total Bedrock exposure
  across all cells (a grader ceiling independent of the coding-agent credential),
  or the coding-agent + grader streams stack unbounded against one quota.
- Add Bedrock/Mantle throttle detection (`429` / `ThrottlingException` /
  `RESOURCE_EXHAUSTED`) to `isRateLimited` so the scheduler latch fires and backs
  off. Without it a throttle never latches and cascades into mass indeterminates
  that poison the re-baseline.

## Cost / pricing

- **Step 0 (obol update) — narrowed by the live probe.** Mantle returns the bare
  native id in `response.model`, which is the obol key. Probed: obol **already
  prices** `claude-opus-4-8` ($0.0176) and `claude-haiku-4-5-20251001` ($0.0035);
  **only `claude-sonnet-5` is missing** (null). So Step 0 = add `claude-sonnet-5`
  to `crates/obol-core/prices/bundled.json` (obol repo now at `../obol`; use
  `scripts/update-bundled-prices.sh`, which pulls from LiteLLM), release, bump
  `@primeradianthq/obol`. Same id fixes Sonnet 5 cost on the direct API too
  (pre-existing gap — obol's table is `as_of 2026-06-08`, before Sonnet 5). Add a
  regression guard asserting `claude-sonnet-5` prices non-null.
- **Smoke gate:** the exact string Claude logs to `message.model` on Mantle is
  undocumented. A single smoke run captures it. If it matches a taught id → priced;
  if it differs (even an opaque ARN) → add that exact string to obol, or use the
  `OBOL_PRICING_DIR` overlay as the emergency path. Cost figures are not trusted
  until this passes.
- obol reports a **list-price estimate** (tokens × rate), i.e. the value we would
  otherwise have paid — a *notional* figure, not the near-zero credit spend. Frame
  it as such; it is the right metric for "what we stopped paying," not for the AWS
  bill.

## Tests / DoD

- Extend `test/launcher-env-isolation.test.ts` HOSTILE set with the `AWS_*`
  vars (incl. `AWS_DEFAULT_REGION`) + `CLAUDE_CODE_USE_MANTLE`; assert scrubbed on
  the `opus` (direct) path. Assert the **forward-list ⊆ unset-list** invariant
  directly, not only by enumerating vars.
- Positive Mantle case: a mantle `.claude-env` yields `CLAUDE_CODE_USE_MANTLE` +
  bearer + region in the agent env, **no** `ANTHROPIC_API_KEY`, host `AWS_*` still
  scrubbed.
- Unit: the provision mantle branch writes the expected `.claude-env`, throws on an
  empty bearer, and skips `seedClaudeAuth`; existing api-key provisioning is
  byte-identical.
- Gauntlet-repo units: `resolveProvider('anthropic.claude-sonnet-5')` → anthropic;
  `maxOutputTokensForModel` returns the full cap for Sonnet 5; the two key-presence
  guards accept the bearer path.
- obol regression guard: the three Mantle ids **and** the direct-API `claude-*-5`
  ids price non-null.
- **Live DoD (gates merge):**
  - `--credential opus_bedrock` composes a verdict, session log shows
    `anthropic.claude-opus-4-8`, capture non-empty; **and** `opus` still passes.
  - **`unpriced_models` is empty** (not merely `est_cost_usd` non-null) on the
    priced runs — a background/secondary model obol can't price must fail the gate.
  - **The grader composes a verdict on Mantle** (proves the bearer reaches the SDK).
  - **`cache_read_input_tokens > 0` on both the direct and Bedrock smoke runs**
    before any direct-vs-Bedrock dollar figure is trusted or canonized; if caching
    differs, compare **token buckets**, not dollars.
  - Recorded in `docs/experiments/`. (Windows is not exercised — it is excluded.)

## Appliance / ops

- `credentials.env` (blessed bundle, global `set -a; source`): add
  `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`, and for the grader `ANTHROPIC_BASE_URL`
  + the SDK-readable bearer var + `GAUNTLET_AGENT_MODEL`. **Never** put
  `CLAUDE_CODE_USE_MANTLE` there — it stays per-run in the coding-agent's
  `.claude-env`. Keep gauntlet's key material.
- **Egress:** allow `*.api.aws` or Mantle is unreachable even with a valid key. Add
  a **preflight Mantle-reachability check** — with Bedrock now the default, a
  missing allowlist entry silently fails every run.
- **Fail-fast preflight** when the resolved credential's `api_key_env` is unset
  (`claude.yaml` `required_env` and/or a `quorum check --live` / appliance
  preflight), so a bearer-less host fails loudly instead of `quorum check` staying
  green while the claude column dies.
- **IAM:** mint the key with `aws iam create-service-specific-credential
  --service-name bedrock.amazonaws.com`, omitting the age flag (never expires; max
  finite 36600 days); attach a **custom least-privilege policy** (Mantle needs
  `bedrock-mantle:CallWithBearerToken` + `bedrock-mantle:CreateInference`; drop the
  managed policy's marketplace grant) **before** the default flip; confirm no SCP
  imposes `iam:ServiceSpecificCredentialAgeDays`. Value shown once; max 2 creds per
  user (clean rotation).
- The full copy-pasteable ops checklist (grant discovery, key minting, region +
  header + model probes) is in the research output (task `w3z1mu7u1`).

## Rollout sequence

1. **Step 0** — update obol (both spellings + release + bump); Sonnet 5 / haiku /
   opus price on both paths.
2. **Grader-model rung (direct API):** move the grader to Sonnet 5 on the *direct*
   API, separately baseline it, and record the verdict-flip rate (grader drift),
   before any endpoint change.
3. **Account prep** *(needs AWS access — the ops checklist):* confirm grants, mint
   the key with the scoped policy, run the per-model In-Region region probe, probe
   the RPM/TPM quota, add `*.api.aws` egress.
4. **Smoke run** — capture the logged model id; reconcile obol if it differs;
   confirm caching parity.
5. **Phase 1** — land the `credentials.env` bearer + region as **hard prerequisites**
   before flipping `default_credential` (or ship the flip behind a toggle that
   activates only once the bearer is confirmed present). Then: coding-agent Mantle
   default + `opus` opt-out + schema/provision/launcher + concurrency cap + isolation
   tests + live DoD; re-baseline the Claude coding-agent sentinels on Bedrock.
6. **Phase 2** — grader → Mantle (harness subprocess env + gauntlet patch); the
   Sonnet 5 grader already exists from step 2, so this is only the endpoint move.
   Canonize the Bedrock + Sonnet 5 numbers.

### Rollback

The design is additive (direct `opus` opt-out preserved), so the coding-agent
revert is one line (`default_credential: opus`). A rollback still needs: the
per-phase revert steps (default flip, bundle env removal, launcher unset-list, the
grader endpoint env), the **disposition of the Bedrock + Sonnet 5 canonical
baselines on revert** (retain + mark historical, do not silently overwrite), and an
**abort trigger** (e.g. indeterminate rate > N%, or caching absent in-region).

## Open items needing live-account confirmation

Account **<AWS_ACCOUNT_ID>**; these gate implementation (the ops checklist's job):

- ✅ **RESOLVED (probed 2026-07-08):** Mantle serves the three models In-Region in
  **us-east-1** (us-west-2 404s them); a long-term Bedrock API key authenticates
  Mantle under the `AmazonBedrockMantleInferenceAccess` policy; **both `x-api-key`
  and `Authorization: Bearer` are accepted** — so the grader maps the bearer to
  `ANTHROPIC_API_KEY` (x-api-key) with **no** gauntlet auth-guard change needed.
- The literal `message.model` string **Claude Code** records on Mantle — still needs
  one real Claude Code run to confirm the CLI surfaces the raw Mantle
  `response.model` (`claude-*`, which obol prices) rather than the request id. Raw
  Mantle API is confirmed; only the CLI's logging layer is unverified.
- **Mantle RPM/TPM account throughput quota** for `CallWithBearerToken` /
  `CreateInference` (the concurrency cap depends on it).
- Whether prompt caching works in the chosen region (cost comparability).
- No SCP cap on service-specific-credential age (the never-expire assumption).

## References

- Review workflow `wf_a13967d9-dec` (task `w55rf075h`) — validated the original
  PRI-2517 plan against the code.
- Research workflow `wf_3e7d6f08-e8d` (task `w3z1mu7u1`) — all Mantle / API-key /
  model-region / SDK / ops facts, cited.
- Adversarial spec review `wf_5993aa3e-239` (task `w0vvfpgth`) — 43 flaws raised, 23
  survived; verdict *revise-spec*; drove this revision.
- PRI-2494 launcher `env -i` isolation invariant.
