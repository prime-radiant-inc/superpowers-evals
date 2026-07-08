# Bedrock/Mantle eval auth — design (PRI-2517)

**Status:** design approved 2026-07-08; implementation not started.
**Supersedes the scope of** [PRI-2517] (originally "opt-in Bedrock credential, coding-agent only").
**Related:** PRI-2494 (launcher `env -i` isolation — must not regress).

## Motivation

We hold abundant AWS Bedrock credits but pay the direct Anthropic API by credit
card. Moving the eval harness's Anthropic consumers onto Bedrock makes eval
inference nearly free. Both Anthropic consumers move:

- the **Claude coding-agent** under test (Claude Code CLI), and
- the **Gauntlet-Agent** (the QA driver / grader, a Node service on `@anthropic-ai/sdk`).

The direct-API path still works; this is *add-a-path-and-make-it-default*, not
*lost-the-key*.

## Locked decisions

1. **Endpoint = Mantle.** Bedrock's Mantle endpoint serves Claude via the native
   Anthropic Messages shape and accepts a Bedrock API key with **no SigV4**, so
   neither consumer needs request signing. Mantle-only; we build no Invoke/SigV4
   path (see Non-goals).
2. **Bedrock is the default; direct-API is the opt-out.** An opt-in nobody
   remembers to pass saves no money. The Claude coding-agent and the grader
   default to Mantle; `--credential opus` (the existing direct-API credential) is
   the explicit escape hatch.
3. **Auth = a long-lived Amazon Bedrock API key** (`AWS_BEARER_TOKEN_BEDROCK`),
   IAM-backed, in the blessed bundle. Matches every other provider's static-secret
   shape; is governed by an IAM principal + scoped policy. (Rejected: IAM access
   keys — the odd provider-out, and they force gauntlet into SigV4; instance-role
   via IMDS — the appliance deliberately blocks container IMDS, and opening it
   would hand the host role to the permissive agent-under-test.)
4. **Grader = Sonnet 5 on both paths.** Sonnet 4.6 is not served on Mantle, and it
   is the current grader + sonnet control model. We move the sonnet slot (grader
   and sonnet control coding-agent) to Sonnet 5, on **both** the direct-API and
   Bedrock paths, so cost comparisons use one grader. This re-baselines the
   sentinel corpus; the Bedrock + Sonnet 5 numbers become canonical.
5. **Cost visibility via obol.** obol is the shared cost source; teach it the new
   model rates once (Step 0) so both paths report dollars. No local override.

## Models and region

All three are served on Mantle with **bare** `anthropic.claude-*` ids (no version
suffix). Sources: the per-model AWS Bedrock model cards + `code.claude.com`.

| Role | Model id (Mantle) | On Mantle? | obol prices today? |
|---|---|---|---|
| Coding-agent default | `anthropic.claude-opus-4-8` | yes | **yes** ($ == direct rate) |
| Grader + sonnet control | `anthropic.claude-sonnet-5` | yes | **no** — Step 0 must add it |
| Small-fast slot | `anthropic.claude-haiku-4-5` | yes | **no** (obol has only the dated runtime key) — Step 0 must add the bare id |
| ~~old sonnet~~ | `anthropic.claude-sonnet-4-6` | **no** | n/a |

- **Region:** the box's region if Mantle serves all three there, else the nearest
  that does. **us-west-2** or **us-east-1** are both acceptable; pin whichever the
  region probe confirms. (Note: the `us-east-1` preference in earlier notes came
  from the Invoke/`us.*` geo-profile path, which we do not use.)
- **Mantle host is `*.api.aws`** (`bedrock-mantle.{region}.api.aws`), not
  `amazonaws.com` — the appliance egress allowlist must include it.
- Requests must send the HTTP header `anthropic-version: 2023-06-01`.

## Non-goals

- No Invoke API / `us.*` inference-profile / SigV4 path. If a Claude model that
  isn't on Mantle is ever needed (e.g. an old sonnet-4-6 scenario), it uses the
  direct-API `opus` opt-out.
- No WebSearch/server-side-tool scenarios on Bedrock (unavailable on all of
  Bedrock). Zero active scenarios use WebSearch today, so this is a doc note in
  `docs/scenario-authoring.md`, not a gating mechanism (correcting PRI-2517's
  "small" sizing — the gate is either 0 now or a new feature later).
- No per-consumer credentials yet; one shared bearer key (below).

## Architecture

One new credential kind drives both consumers through Mantle. The two consumers
are switched by **different mechanisms that never cross**:

- **Coding-agent:** activated per-run by `CLAUDE_CODE_USE_MANTLE=1` seeded into the
  run-scoped `.claude-env` and forwarded through the launcher's `env -i` allowlist.
  Global host vars are stripped from it.
- **Gauntlet grader:** activated by `ANTHROPIC_BASE_URL` + bearer + model in the
  gauntlet subprocess env (gauntlet inherits the host env). Global — but the
  coding-agent's `env -i` wall makes it invisible to the agent under test.

This split is the core isolation invariant: global env → grader; per-run
`.claude-env` behind `env -i` → coding-agent.

### Credential contract (`src/contracts/credential.ts`)

- Add `api: 'mantle'` to `CREDENTIAL_APIS` and `auth: 'bedrock-bearer'` to
  `CREDENTIAL_AUTHS`.
- Add optional `region` field (the schema is non-`.strict()`, so an untyped
  `region:` in YAML is silently dropped — it must be added to the schema to take
  effect).
- `credentials.yaml`: `opus_bedrock` = `{api: mantle, auth: bedrock-bearer,
  api_key_env: AWS_BEARER_TOKEN_BEDROCK, region: <probe result>, model:
  anthropic.claude-opus-4-8, harnesses: [claude]}`. Distinct `api` gives it its own
  `limiterKey` bucket (its own concurrency latch against the Bedrock account quota).
  The existing `opus` credential (`api: anthropic, auth: api-key`) remains the
  direct-API opt-out; only `default_credential` changes.
- `coding-agents/claude.yaml`: `default_credential: opus_bedrock`.
- `quorum check` (`src/credentials/check.ts`) needs no new rejection logic once the
  enums include the new values.

### Coding-agent path

- **Provision** (`ClaudeAgent.provision`, `src/agents/index.ts`): a new branch for
  the mantle credential seeds the run-scoped `.claude-env` (mode 0600) with
  `CLAUDE_CODE_USE_MANTLE=1`, `AWS_REGION=<region>`, and `AWS_BEARER_TOKEN_BEDROCK`
  (read via `getEnv(credential.api_key_env)`). The model rides `--model
  $CLAUDE_MODEL` from `credential.model`. It **skips `seedClaudeAuth`** entirely (no
  `ANTHROPIC_API_KEY`, no `apiKeyHelper` in `settings.json`, no
  `customApiKeyResponses` fingerprint) but **still writes** the `.claude-env` file,
  because the launcher sources it unconditionally under `set -e`.
- **Launcher** (`coding-agents/claude-context/launch-agent`):
  - `unset CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_BEDROCK AWS_REGION
    AWS_BEARER_TOKEN_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    AWS_SESSION_TOKEN AWS_PROFILE` **before** `source "$CLAUDE_ENV_FILE"`, so the
    gate and values come only from the seeded file, never host inheritance (the
    PRI-2494-safe fix — a bare `$AWS_x` reinjection would otherwise forward host
    creds, and `CLAUDE_CODE_USE_*` is host-settable).
  - Conditionally append `CLAUDE_CODE_USE_MANTLE`, `AWS_REGION`,
    `AWS_BEARER_TOKEN_BEDROCK` to the `env -i` allowlist (only when the sourced file
    set them). Mirror the opencode launcher's `${!name-}` guard pattern.
  - Make the `ANTHROPIC_API_KEY=` line conditional — present on the `opus`
    path, absent on Mantle (so `set -euo pipefail` does not abort on an unbound var).
  - Keep `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`.
- Claude Code version floor: **≥ 2.1.200** (Mantle ≥2.1.94, `/context` ≥2.1.196,
  `--model`/`ANTHROPIC_MODEL` routing ≥2.1.200; the appliance container is 2.1.202).
  Leave `CLAUDE_CODE_SKIP_MANTLE_AUTH` unset (that is only for gateways injecting
  creds server-side).

### Gauntlet grader path

- **Harness** (`src/runner`): by default set the gauntlet subprocess env to
  `ANTHROPIC_BASE_URL=https://bedrock-mantle.<region>.api.aws/anthropic`, the bearer
  in the header Mantle accepts, and `GAUNTLET_AGENT_MODEL=anthropic.claude-sonnet-5`.
  Direct-API grader is the opt-out.
- **Gauntlet code patch** (cross-repo, `github.com/prime-radiant-inc/gauntlet`):
  - `resolveProvider` must map `anthropic.claude-*` → the anthropic provider
    (today it throws unless the id starts with `claude`).
  - `maxOutputTokensForModel` must match Sonnet 5 (today its regex is
    `/^claude-(opus|sonnet|haiku)-4/`, so a 5-series or `anthropic.`-prefixed id
    silently drops to the 4096 cap — a known run-killer).
  - Send only the header Mantle accepts. The base `@anthropic-ai/sdk` sends
    `x-api-key` for `apiKey` and `Authorization: Bearer` for `authToken`, and
    **both** if both are set; gauntlet currently forces `ANTHROPIC_API_KEY`
    (→ always `x-api-key`). The ops probe decides whether Mantle wants `x-api-key`,
    `Bearer`, or tolerates both; if it rejects the dual-header, relax the guard.
- **Isolation invariant:** the coding-agent must switch via `CLAUDE_CODE_USE_MANTLE`
  in its own `.claude-env`, **never** via `ANTHROPIC_BASE_URL` in provision
  `extraEnv` — `extraEnv` is overlaid onto the gauntlet subprocess and would
  silently route the grader too. A test asserts neither path bleeds into the other.

### Shared key

One long-lived Bedrock API key serves both consumers (scoped Bedrock-only;
trusted-operator box). Per-consumer keys are a future option requiring harness
plumbing to inject different bearers per subprocess; not now (YAGNI).

## Cost / pricing

- **Step 0 (obol update)** adds current list-price rates for the three bare Mantle
  ids (`anthropic.claude-opus-4-8` already present; add `anthropic.claude-sonnet-5`
  and `anthropic.claude-haiku-4-5`), cuts an obol release, and bumps
  `@primeradianthq/obol` here. obol is not checked out locally; this is cross-repo
  work and the first thing done. It fixes Sonnet 5 cost visibility on the direct API
  too (a pre-existing gap — obol's bundled table is `as_of 2026-06-08`, before
  Sonnet 5).
- **Smoke gate:** the exact string Claude Code writes to `message.model` on Mantle
  is undocumented. A single smoke run captures it (the ops `jq` on the session
  JSONL). If it matches the pinned bare id, obol prices it; if it differs, add that
  exact string to obol. Cost figures are not trusted until this passes.
- Result: `est_cost_usd` non-null for all three models on both paths → apples-to-
  apples direct-vs-Bedrock comparison. obol reports a *list-price estimate* (tokens
  × rate), which is exactly the "value of what we'd otherwise have paid" metric we
  want, independent of the near-zero credit spend.

## Tests / DoD

- Extend `test/launcher-env-isolation.test.ts` HOSTILE set with the six `AWS_*`
  vars + `CLAUDE_CODE_USE_MANTLE`; assert they are scrubbed on the `opus`
  path (host cannot force Mantle or leak AWS creds into a direct run).
- Positive Mantle case: a mantle `.claude-env` yields `CLAUDE_CODE_USE_MANTLE` +
  bearer + region in the agent env, **no** `ANTHROPIC_API_KEY`, host `AWS_*` still
  scrubbed.
- Unit: the provision mantle branch writes the expected `.claude-env` and skips
  `seedClaudeAuth`; existing api-key provisioning is byte-identical.
- Gauntlet-repo units: `resolveProvider('anthropic.claude-sonnet-5')` → anthropic;
  `maxOutputTokensForModel` returns the full cap for Sonnet 5.
- obol regression guard: the three pinned ids price non-null.
- **Live DoD (gates merge):** a real Mantle round-trip — `--credential opus_bedrock`
  composes a verdict, the session log shows `anthropic.claude-opus-4-8`, capture is
  non-empty, `est_cost_usd` is non-null; **and** `opus` still passes
  unchanged. Recorded in `docs/experiments/`.

## Appliance / ops

- `credentials.env` (blessed bundle, global `set -a; source`): add
  `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`, and for the grader `ANTHROPIC_BASE_URL`
  + `GAUNTLET_AGENT_MODEL`. **Never** put `CLAUDE_CODE_USE_MANTLE` here — it stays
  per-run in the coding-agent's `.claude-env`. Keep gauntlet's existing key material.
- **Egress:** allow `*.api.aws` or Mantle is unreachable even with a valid key.
- **IAM:** mint the key with `aws iam create-service-specific-credential
  --service-name bedrock.amazonaws.com`, omitting the age flag so it never expires
  (max finite 36600 days); attach `AmazonBedrockMantleInferenceAccess` (Mantle needs
  `bedrock-mantle:CallWithBearerToken` + `bedrock-mantle:CreateInference`, a
  namespace distinct from `bedrock:*`), then tighten. Confirm no SCP imposes
  `iam:ServiceSpecificCredentialAgeDays`. The value is shown once; max 2 creds per
  user (clean rotation).
- The full copy-pasteable ops checklist (grant discovery, key minting, region +
  header + model probes) lives in the research output (task `w3z1mu7u1`).

## Rollout sequence

1. **Step 0** — update obol (release + bump); Sonnet 5 / haiku / opus price.
2. Confirm account grants, mint the key, run the region probe *(needs AWS access)*.
3. **Smoke run** — capture the logged model id; reconcile obol if it differs.
4. **Phase 1** — coding-agent Mantle default + `opus` opt-out + schema /
   provision / launcher changes + isolation tests + live DoD; re-baseline the Claude
   coding-agent sentinels on Bedrock.
5. **Phase 2** — gauntlet grader → Mantle (harness subprocess env + gauntlet patch +
   Sonnet 5); re-baseline the grader. The Sonnet 4.6→5 grader change may land on the
   direct API first to decouple it from the endpoint move.

## Open items needing live-account confirmation

These cannot be settled from docs or code; they gate implementation and are the
ops checklist's job (account **<AWS_ACCOUNT_ID>**):

- Which region has opus-4-8 + sonnet-5 + haiku-4-5 granted on Mantle (us-west-2 vs
  us-east-1), and whether the box's region is among them.
- Whether one long-term key authenticates Mantle (single credential + the
  `bedrock-mantle:*` actions), and which managed-policy version actually grants them.
- Which auth header Mantle accepts (`x-api-key`, `Bearer`, or both) — decides
  zero-code vs a one-line gauntlet auth patch.
- The literal `message.model` string Claude Code records on Mantle (the obol pricing
  gate).
- Whether prompt caching works in the chosen region (cost comparability).
- No SCP cap on service-specific-credential age (the never-expire assumption).

## References

- Review workflow `wf_a13967d9-dec` (task `w55rf075h`) — validated the original
  PRI-2517 plan against the code.
- Research workflow `wf_3e7d6f08-e8d` (task `w3z1mu7u1`) — all Mantle / API-key /
  model-region / SDK / ops facts, cited.
- PRI-2494 launcher `env -i` isolation invariant.
