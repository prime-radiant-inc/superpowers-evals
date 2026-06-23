# Credential Axis — Design Specification

**Status:** Draft for review (revision 3). Not yet implemented.
**Date:** 2026-06-22
**Origin:** the 2026-06-22 GLM-5.2 benchmark attempt. Pointing three harnesses
(pi, opencode, codex) at one custom OpenAI-compatible endpoint required three
bespoke per-agent env-var hacks plus a whole new agent. That pain motivated this
design.

**Revision history.**
- *rev1* — first draft. Adversarially reviewed; under-specified identity
  threading and made unverified code claims.
- *rev2* — addressed rev1 findings; re-reviewed. The architecture held, but the
  reviewers found more integration sites and ~8 imprecise code citations (the
  spec had been written from memory).
- *rev3 (this)* — every code citation below is taken from the cross-verified
  reviewer findings, not memory. Fixes the factual errors (§8 codex scrub
  location, §9 adapter signature, §9.2 "already implemented", §12 over-hardening,
  the §6.4 dangling reference), folds the full integration-site list into §13 as
  the implementation backbone, and adds §14 (code consolidation).

---

## 1. Problem

A `coding-agents/<name>.yaml` entry conflates three independent concerns:
the **harness** (the CLI under test + its capture + normalizer), the **model**,
and the **endpoint + credentials**. Each harness invents its own way to learn
model and auth (opencode hardcodes `openai/gpt-5.5`; pi reads
`PI_PROVIDER`/`PI_MODEL`/`PI_API_KEY`; codex is locked to subscription auth);
model variants are encoded in the *agent name* (`claude-sonnet` vs `claude-haiku`
are two agents that are one harness). You cannot say "run pi against these five
models" without authoring five agents. The GLM benchmark needed four parallel
mechanisms (`PI_MODELS_JSON`, `OPENCODE_PROVIDER_JSON`, `CODEX_API_*`, and a new
`codex-api-custom-provider` agent) for one idea.

## 2. Goal

Make **model + endpoint + credentials** a first-class, named, enumerable axis —
a **credential** — composing with any compatible harness. The eval dimension
changes from `(scenario, coding-agent, os)` to
`(scenario, coding-agent, credential, os)`.

Driving use case: `run pi against credentials A, B, C, D, E`.

## 3. The credential

A **credential** is a named bundle defined in a committable top-level
`credentials.yaml` (§11) that *references* secrets, never contains them. Only
`model` and `harnesses` are required.

| field           | required | default                                | meaning |
|-----------------|----------|----------------------------------------|---------|
| `model`         | yes      | —                                      | model id sent to the provider |
| `harnesses`     | yes      | —                                      | harnesses allowed to run this credential (§7) |
| `api`           | no       | `openai-chat`                          | wire shape: `openai-chat` \| `openai-responses` \| `anthropic` \| `gemini` (§12) |
| `base_url`      | no       | the api's standard base URL            | endpoint; set for custom servers |
| `auth`          | no       | `api-key`                              | `api-key` \| `subscription` \| `oauth` (§8) |
| `api_key_env`   | no       | the harness's conventional key env var | env var holding the key (when `auth: api-key`) |
| `compat`        | no       | `{}`                                   | provider quirks; closed key set (§12) |
| `max_concurrency` | no     | unbounded                              | per-endpoint in-flight cap (§6) |
| `launch_spacing_seconds` | no | 0                                  | per-endpoint start-to-start spacing (§6) |
| `os_support`    | no       | inherit the harness's `os_support`     | environments this endpoint is reachable from (§6.3) |

```yaml
# credentials.yaml  (top-level)
sonnet: { model: claude-sonnet-4-6, api: anthropic, harnesses: [claude] }
haiku:  { model: claude-haiku-4-5,  api: anthropic, harnesses: [claude] }
opencode_gpt5: { model: gpt-5.5, harnesses: [opencode] }
glm_5_2:
  model: glm-5.2-fp8
  api: openai-responses
  base_url: https://oak-receiver-hear-homework.trycloudflare.com/v1
  api_key_env: GLM_API_KEY
  harnesses: [pi, opencode, codex]
  max_concurrency: 2            # fragile dev endpoint — throttle it
  compat: { thinking_format: zai }
```

### 3.1 Credential name charset

A credential name MUST match `^[a-z0-9_]+$` (no hyphens). Run-dir names are
hyphen-delimited (§5); banning hyphens keeps the new segment unambiguous.
Enforced by `quorum check` (§11).

## 4. Secrets are ordinary env vars

No secret subsystem. When `auth: api-key`, a credential optionally names the env
var holding its key (`api_key_env`). Resolution order:

1. `api_key_env` set → read that env var.
2. absent → the harness's conventional key env var (pi → `PI_API_KEY`,
   claude → `ANTHROPIC_API_KEY`).
3. `auth: subscription | oauth` → the harness's native host-login seeding
   (codex subscription, gemini/pi OAuth), no env key.

Real keys come from env / `.env.container` / the appliance bundle. This forces
the `required_env` gate to become credential-aware (§8).

## 5. Identity: threading the credential through the codebase

The credential is a fourth identity dimension. Identity is currently a
`(scenario, agent, os)` triple, encoded/parsed positionally in **four** places.
§14 consolidates those four into one; this section enumerates what must carry the
new field regardless.

**Authoritative identity field** — add `credential` to:
`FinalVerdict` (`src/contracts/verdict.ts`; stamped at `src/runner/index.ts:826-832`),
`MatrixEntry` + `ResultRecord` (`src/contracts/batch.ts:19-41`),
the dashboard `cellKey`/`cellId` (`packages/dashboard/src/contracts.ts:134-142`),
and **both** copies of `GridManifestCell` — the harness write-side
(`src/contracts/grid-manifest.ts:4-10`) and the deliberately-decoupled dashboard
read-side (`packages/dashboard/src/manifest.ts:11-27`). The duplication of that
type is intentional (the dashboard is zero-harness-dep) and is **not** removed
(§14).

**Run-dir / run-id** becomes `<scenario>-<agent>-<credential>-<os>-<stamp>-<nonce>`
(`allocateRunDir`, `src/runner/index.ts:106`; uniqueness already from
stamp+nonce, so the credential segment is for *attribution*, not collision
avoidance).

**Positional sites that must change (or be retired by §14):**
- `parseRunDirName` + the `ParsedRunDir` interface
  (`packages/dashboard/src/scan.ts:24-73`). NB: this parser recovers the agent by
  **longest-suffix match against a `knownAgents` vocabulary**, not pure position.
  To split agent from credential it needs a **`knownCredentials` vocabulary**,
  which the dashboard does not have (it bootstraps agents from the grid manifest /
  `verdict.json`, never from `credentials.yaml`). §14's "read identity from the
  authoritative field" resolves this; otherwise the grid manifest must also
  publish a `credentials` list.
- The run-dir **reconstruction** at `packages/dashboard/src/scan.ts:236`
  (`${scenario}-${agent}-${os}-${started_at}-${nonce}` → `readDashboardVerdict`) —
  a third positional site rev2 missed; with a wrong template it reads a
  nonexistent dir and renders every run verdict-less.
- `identityFromRunDirName` (`src/cli/costs.ts:241-258`, purely positional:
  agent = `parts[len-4]`, os = `parts[len-3]`).

**Cost pipeline beyond the parser:** `CostRow` (`src/cli/costs.ts:85`), the cost
table columns (`costs.ts:367`), `BatchResultSchema` (`costs.ts:186-193`), and
`render-batch`'s `cellKey` (`src/cli/render-batch.ts:133-138`,
`${scenario}\t${agent}`) all carry only `(scenario, agent)`. Without the
dimension a `pi × {A..E}` sweep collapses to one indistinguishable cost row / one
batch cell. The whole chain gains `credential`.

## 6. Scheduling and per-endpoint caps

The scheduler caps **inflight, launch-spacing, and the rate-limit latch** all on
one key, `cell.harness = entry.codingAgent` (`src/scheduler/index.ts:148-149`;
hooks `capFor(harness: string)` / `spacingFor(harness: string)` at lines 74-76;
latch `skipQueuedForHarness` at 308-329). The scheduler is intentionally **pure
of file I/O** (`scheduler/index.ts:16-21`), so it cannot itself read
`credentials.yaml`.

### 6.1 Caps move onto the credential (endpoint)

`max_concurrency`/`launch_spacing_seconds` become optional **credential** fields;
the agent YAML loses them (`agentMaxConcurrency`/`agentLaunchSpacingSeconds`,
`src/run-all/matrix.ts:166-209`, are removed/repointed). Because the scheduler is
pure, the **endpoint key must be resolved in run-all and threaded in**: add a
`limiterKey` to `MatrixEntry`/`Cell` (`src/scheduler/index.ts:113-118`) computed
as the credential's `base_url`+`api` (fall back to credential name when no
`base_url`), and key `capFor`/`spacingFor`/the latch on `limiterKey` instead of
the harness string. run-all's wiring (`src/run-all/index.ts:452-453`) resolves
caps from the credential, not the agent YAML.

### 6.2 Latch blast-radius is a deliberate consequence

Re-keying from harness to endpoint means a 429 latch now skips queued cells for
that **endpoint** (across harnesses sharing it), not for one harness. This is the
desired behavior for the credential axis (the rate limit is the endpoint's), but
it changes the existing antigravity-style latch semantics and must be called out
in tests.

### 6.3 run-all matrix expansion + os × credential

`buildMatrix` (`src/run-all/matrix.ts:84-164`) and `buildGridManifest`
(`matrix.ts:235-264`) produce `(scenario, agent, credential, os)` cells. An
`(agent, credential, os)` cell is eligible only if
`os ∈ (agent.os_support ∩ credential.os_support)` (`readOsSupport`,
`matrix.ts:218-234`, now also reads the credential). `invokeChild`
(`src/run-all/index.ts:161-185`) adds `--credential <name>` to the child
`quorum run` (today it passes neither credential nor `--os`).

## 7. Compatibility via the credential's `harnesses` list

Each credential declares the harnesses that can run it. A `(harness, credential)`
cell is valid iff `harness ∈ credential.harnesses`; otherwise the matrix **skips**
it via the existing `skipped`/directive channel (`buildMatrix`,
`matrix.ts:136-155`) — exactly like `# coding-agents:`. No scenario directive
currently names a model-named agent, so this does not collide with existing
directives. A direct `quorum run` with `harness ∉ credential.harnesses` is a fast
pre-flight error.

## 8. Auth-mode and `required_env`

- **The conventional-key gate is NOT universal.** `required_env` is a flat
  `z.array(z.string())` (`src/contracts/agent-config.ts:38`) checked uniformly in
  `loadAgentConfig` (`agent-config.ts:161-169`) and the runner
  (`src/runner/index.ts:1032-1039`). Only **claude and gemini** list their API
  key in `required_env`; pi/opencode/codex list only `SUPERPOWERS_ROOT` (they
  validate auth at provision time). So the fix is narrow: for claude/gemini, the
  key gate must check the *resolved credential key* (§4), not the hardcoded
  conventional var, so a credential with a custom `api_key_env` is not blocked by
  an unset conventional var. Since `required_env` cannot self-identify which
  entries are auth keys, the implementation removes the conventional-key entries
  from `required_env` and lets credential resolution (§4) own key presence;
  non-auth entries (`SUPERPOWERS_ROOT`) stay hard gates.
- **codex forbids API-key auth.** `seedCodexAuth` rejects any `~/.codex/auth.json`
  carrying an API key (requires `auth_mode === 'chatgpt'`,
  `src/agents/codex.ts:143-151`); separately, the codex launcher scrubs `OPENAI_*`
  (`coding-agents/codex-context/launch-agent:34-40` — *the launcher, not the
  adapter*). So a codex credential is either `auth: subscription`, or
  `auth: api-key` routed through codex `model_providers` with a non-`OPENAI_*`
  `env_key`. The adapter validates the `(auth, api)` pair it receives.

## 9. Provisioning: per-adapter translation

Adapters keep their real signature `provision(home: RunHome, runner:
CommandRunner)` (`src/agents/index.ts:40`) and gain the resolved credential —
i.e. `provision(home, runner, credential)` (the `CommandRunner` seam stays; the
config-writing adapters need it). Two shapes:

- **Config-writing harnesses** (pi, opencode, codex) write native provider config
  from the credential (pi `models.json`+`auth.json`, opencode `opencode.json`
  `provider`, codex `config.toml` `[model_providers.*]`). Retires the GLM env-var
  hacks.
- **Launcher-placeholder harnesses** (claude, gemini): the model is injected via
  launcher substitution (`$CLAUDE_MODEL`, `src/runner/index.ts:1211-1216`),
  currently from `cfg.model`; it now sources from the credential. Custom
  endpoints for these (`ANTHROPIC_BASE_URL`, gemini) do **not** exist today and
  are **out of scope for v1** (§14 lists them as future).

### 9.1 codex: adapter-class + launcher merge

`resolveAgent` dispatches the adapter *class* by family
(`src/agents/index.ts:226-234`; `CUSTOM_AGENTS` at line 190): subscription →
`CodexAgent` (writes `auth.json`), api-key → `CodexApiAgent` (writes
`config.toml` + provider env). Collapsing to one `codex` harness (§10) means
**merging the two adapter classes into one that branches on the credential's
`auth`** — the bulk of the work, not just the launcher. The two launcher
templates (selected by `contextDirName`, `src/runner/index.ts:870-880`;
substitution leaves unresolved `$VARS` verbatim under `set -u`,
`src/runner/context.ts:90-96`) merge into one that sources the provider env-file
only for `api-key` credentials — implemented by providing the
`$CODEX_API_ENV_FILE` substitution conditionally and guarding the `source` line
(`[ -n "${CODEX_API_ENV_FILE:-}" ]`) so a subscription run does not abort under
`set -u`. The `cfg.name === 'codex-api-custom-provider'` gate
(`src/runner/index.ts:1233-1237`) becomes credential-driven.

### 9.2 pi: promote the existing fix

The pi 401 (placeholder `auth.json` shadowing the inline `models.json` key) is
real and documented at `src/agents/pi.ts:359-361`. The fix **already exists** for
the `PI_MODELS_JSON` path (`pi.ts:362-366` rewrites `auth.json` with the resolved
key) — it is this session's benchmark hack. This design **promotes that existing
behavior** into the credential translator (and removes the env-var hack itself,
§14); it is not new work. (rev1's "pi never expands the placeholder" was an
over-claim; the verified statement is the shadowing failure above.)

## 10. Migration: one harness per CLI name — NEEDS SIGN-OFF

Model-named agents collapse to one harness + credential profiles:
`claude-sonnet`/`claude-haiku` are removed; the `claude` harness gains a
`default_credential` and `sonnet`/`haiku` credentials carry the model. (Note the
existing model values differ meaningfully — `claude.yaml` model is the `opus`
alias, `claude-sonnet.yaml` is `sonnet`, `claude-haiku.yaml` is a pinned
`claude-haiku-4-5-20251001` — each becomes a credential.) Single-model harnesses
gain a `default_credential` naming their current model/endpoint.

Coupled changes this requires (rev2 omitted these):
- `validateAgentConfigStatic` currently **requires** `model` on the claude family
  (`src/contracts/agent-config.ts:110-114`); that rule changes to require
  `default_credential` instead.
- `codex-api-custom-provider` is removed from `KNOWN_RUNTIME_FAMILIES`
  (`agent-config.ts:13-23`) and the `CUSTOM_AGENTS` dispatch (`agents/index.ts:190`).
- its context dir merges into `codex-context/` (§9.1).

This is **backward-incompatible**: `--coding-agent claude-sonnet` stops resolving
and historical model-named result/dashboard keys no longer match. Needs explicit
sign-off (§15).

## 11. `credentials.yaml` location and validation

Top-level, **not** under `coding-agents/`: `discoverAgents` globs
`coding-agents/*.yaml` as the agent universe (`src/run-all/matrix.ts:42-51`), so a
file there becomes a phantom `credentials` agent.

`quorum check` today validates **scenarios only** (`src/cli/index.ts:236-283`,
`checkScenario`); it has no agent-config validation path. This design adds a
**new** static pass (CI-safe, no live calls): `credentials.yaml` parses; every
credential has `model` + non-empty `harnesses`, name matches §3.1, `api`/`auth`
are enumerated, `compat` keys are in the §12 set; every agent's
`default_credential` exists and lists that harness.

## 12. `compat` schema (closed key set)

`compat` is a closed set for v1, each key with a defined per-adapter mapping;
unknown keys are a `quorum check` error.

| key               | values           | pi | opencode | codex |
|-------------------|------------------|----|----------|-------|
| `thinking_format` | `zai`            | `models.json` `compat.thinkingFormat` | provider `options` passthrough | n/a |
| `max_tokens_field`| string           | `models.json` `compat.maxTokensField` | n/a | n/a |

`api` is not in `compat`; it maps to the wire protocol per adapter. **codex
`api`:** installed codex 0.141 defaults `wire_api` to `responses` and gates
`chat` behind `CODEX_API_WIRE_API` for older codex
(`src/agents/codex-api.ts:40-58`). So `api: openai-chat` is **not** statically
invalid for codex (rev2 wrongly forbade it); it is *valid against an older codex*.
The adapter maps `api` → `wire_api` and, if it cannot honor it on the installed
codex, errors at provision with a clear message. `quorum check` does not reject
the combination.

## 13. Integration sites — implementation checklist

The two adversarial reviews enumerated every site the new dimension touches. This
is the implementation backbone (writing-plans turns it into ordered tasks):

1. **Schema** — `credential` field + `credentials.yaml` loader/validator;
   `default_credential` on agent YAML; remove agent-level
   `max_concurrency`/`launch_spacing_seconds`.
2. **Identity (§5)** — `verdict.ts`, `batch.ts`, dashboard `contracts.ts`, both
   `GridManifestCell` copies; run-dir name (`runner:106`); `scan.ts:24-73` +
   `scan.ts:236` + `costs.ts:241-258`; cost chain (`costs.ts:85/186-193/367`,
   `render-batch.ts:133-138`).
3. **Scheduler (§6)** — `limiterKey` into `MatrixEntry`/`Cell`; re-key
   cap/spacing/latch (`scheduler:74-76,148-149,308-329`); run-all wiring
   (`run-all:452-453`).
4. **Matrix (§6.3, §7)** — credential expansion + `harnesses`/os skip in
   `buildMatrix`/`buildGridManifest`; `--credential` in `invokeChild`.
5. **Auth (§8)** — credential-aware key gate for claude/gemini.
6. **Adapters (§9)** — `provision(home, runner, credential)`; pi/opencode/codex
   translators; codex class+launcher merge; claude/gemini launcher model source.
7. **Migration (§10)** — collapse model-named agents; family-set + dispatch +
   context-dir + claude `model`-validation changes.
8. **Validation (§11)** — new `quorum check` credential/agent pass.
9. **Dashboard parse vocabulary** — resolved by §14 (read authoritative field).

## 14. Code consolidation (remove duplication this enables)

The change is a chance to delete duplication, not add to it:

- **Run-id identity → one source of truth.** The identity string is encoded once
  (`allocateRunDir`, `runner:106`) and independently re-derived in three other
  places (`scan.ts` parse `24-73`, `scan.ts` reconstruct `236`, `costs.ts` parse
  `241-258`). Adding `credential` to four positional parsers is fragile. Instead:
  the dashboard and costs **read identity from the authoritative `verdict.json`
  field** (`scenario`/`coding_agent`/`credential`/`os`) rather than parsing the
  dir name. The dir name stays human-readable + unique but is **no longer
  parsed** — eliminating `parseRunDirName`, `ParsedRunDir`, the `scan.ts:236`
  reconstruction guesswork, and `identityFromRunDirName`, and dissolving the
  "dashboard needs a `knownCredentials` vocabulary" problem (§13.9). (scan already
  reads `verdict.json` in its results-only path, `scan.ts:172-184`, so this is a
  consolidation toward existing behavior, with a small per-run file read.)
- **codex: two adapters → one.** `CodexAgent` + `CodexApiAgent` merge into a
  single credential-branching adapter (§9.1); the `codex-api-custom-provider`
  family/agent/context/launcher are deleted.
- **GLM env-var hacks deleted.** `PI_MODELS_JSON`, `OPENCODE_PROVIDER_JSON`,
  `CODEX_API_*` reading paths are removed once their logic lives in the credential
  translators (§9).
- **Not removed (intentional duplication):** the two `GridManifestCell`
  declarations across the harness/dashboard package boundary stay — the dashboard
  is deliberately zero-harness-dep. Both gain the field independently.

## 15. Testing

Hermetic Tier-1 unit tests for: `credentials.yaml` parse/validation; §4/§8
resolution order; §7 `harnesses` skip; each adapter's credential→native-config
translation (assert exact files); the pi `auth.json` behavior (§9.2); the §6.2
latch re-key; and run-id encode + authoritative-field read round-trip (§14). The
new `quorum check` pass (§11). No live evals in CI.

## 16. Out of scope (YAGNI / future)

- Custom endpoints for locked harnesses (claude `ANTHROPIC_BASE_URL`, gemini) —
  v1 is native-endpoint only for those.
- A model axis separate from credential; credential inheritance/templating; a
  gitignored inline-secret file; a back-compat alias layer for removed
  model-named agents (§10).

## 17. Decisions (signed off 2026-06-22)

1. **APPROVED** — Migration §10 (collapse to one harness per CLI name) proceeds,
   accepting the backward-incompatible break (`--coding-agent claude-sonnet`
   stops resolving; historical model-named result keys shift). No alias layer.
2. **APPROVED** — §14 run-id consolidation reads identity from the authoritative
   `verdict.json` field and **deletes** the positional parsers
   (`parseRunDirName`, the `scan.ts:236` reconstruction, `identityFromRunDirName`).
   The run-dir name remains human-readable + unique but is no longer parsed.
