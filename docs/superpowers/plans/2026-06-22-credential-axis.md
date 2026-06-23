# Credential Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make model+endpoint+credentials a first-class, named, enumerable axis (a "credential") so the eval dimension becomes `(scenario, coding-agent, credential, os)` and you can run one harness against many models/providers.

**Architecture:** A top-level `credentials.yaml` defines named credentials (model + api + endpoint + auth + harness compatibility + per-endpoint caps). Each harness adapter translates a resolved credential into its native provider config. Run identity carries `credential` as an authoritative field in `verdict.json`; the dashboard and cost tools read that field instead of parsing run-dir names (deleting the legacy positional parsers).

**Tech Stack:** TypeScript on Bun ≥1.3, zod schemas, biome (lint/format), `bun test`. Spec: `docs/superpowers/specs/2026-06-22-credential-axis-design.md`.

## Global Constraints

- Run all commands from the repo root (`evals/` tree). Bun ≥1.3.
- `bun run check` (biome + tsc + bun test) and `bun run quorum check` must pass before every commit.
- erasableSyntaxOnly is on: NO `constructor(readonly x)` param properties — assign in the body.
- Read env ONLY via `getEnv`/`envSnapshot` from `src/env.ts`; never `process.env` directly.
- Credential names MUST match `^[a-z0-9_]+$` (spec §3.1).
- `credentials.yaml` lives at the repo top level, never under `coding-agents/` (spec §11).
- No new third-party dependencies. No live evals in CI.
- Migration is backward-incompatible by sign-off (spec §17): `--coding-agent claude-sonnet` is expected to stop resolving; no alias layer.
- Each task ends green and committed.

---

## File Structure

**New files:**
- `src/contracts/credential.ts` — zod `CredentialSchema` + `Credential` type + `CredentialsFile` loader/parse.
- `src/credentials/resolve.ts` — credential lookup, default resolution, api-key resolution (spec §4/§8), `limiterKey` derivation (spec §6.1).
- `src/credentials/index.ts` — barrel for the above.
- `test/credential-schema.test.ts`, `test/credential-resolve.test.ts`, plus per-adapter and matrix tests noted in each task.

**Modified (high-traffic):**
- `src/contracts/agent-config.ts` — add `default_credential`; remove `max_concurrency`/`launch_spacing_seconds`; change claude-family `model`→`default_credential` requirement; drop `codex-api-custom-provider` from `KNOWN_RUNTIME_FAMILIES`.
- `src/contracts/verdict.ts`, `src/contracts/batch.ts`, `src/contracts/grid-manifest.ts`, `packages/dashboard/src/contracts.ts`, `packages/dashboard/src/manifest.ts` — add `credential` to identity.
- `src/runner/index.ts` — credential through provisioning, verdict stamping, run-dir name, launcher model source.
- `src/scheduler/index.ts` — re-key on `limiterKey`.
- `src/run-all/matrix.ts`, `src/run-all/index.ts` — credential expansion + `harnesses`/os skip + `--credential` child arg + cap resolution.
- `src/cli/index.ts` — `--credential`/`--credentials` options; new `quorum check` credential pass.
- `src/cli/costs.ts`, `src/cli/render-batch.ts` — read credential from verdict; add column/cell key.
- `packages/dashboard/src/scan.ts` — read identity from verdict; delete positional parser.
- `src/agents/*.ts` — `provision(home, runner, credential)`; pi/opencode/codex translators; merge `CodexAgent`+`CodexApiAgent`.
- `coding-agents/*.yaml` + new top-level `credentials.yaml`.

**Deleted (spec §14):** `src/agents/codex-api.ts`, `coding-agents/codex-api-custom-provider.yaml`, `coding-agents/codex-api-custom-provider-context/`, the `PI_MODELS_JSON`/`OPENCODE_PROVIDER_JSON`/`CODEX_API_*` reading paths, `parseRunDirName`/`identityFromRunDirName` and the `scan.ts` reconstruction.

---

## PHASE A — Credential schema, loader, resolution (foundation)

### Task A1: Credential schema + loader

**Files:**
- Create: `src/contracts/credential.ts`
- Test: `test/credential-schema.test.ts`

**Interfaces:**
- Produces: `CredentialSchema` (zod), `type Credential`, `loadCredentialsFile(path: string): Record<string, Credential>` (throws on parse/validation error with a clear message).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { CredentialSchema, parseCredentialsFile } from '../src/contracts/credential.ts';

describe('CredentialSchema', () => {
  test('minimal credential needs model + harnesses; defaults applied', () => {
    const c = CredentialSchema.parse({ model: 'gpt-5.5', harnesses: ['opencode'] });
    expect(c.api).toBe('openai-chat');
    expect(c.auth).toBe('api-key');
    expect(c.compat).toEqual({});
  });
  test('rejects empty harnesses', () => {
    expect(() => CredentialSchema.parse({ model: 'm', harnesses: [] })).toThrow();
  });
  test('rejects unknown api', () => {
    expect(() => CredentialSchema.parse({ model: 'm', harnesses: ['pi'], api: 'soap' })).toThrow();
  });
  test('rejects unknown compat key', () => {
    expect(() => CredentialSchema.parse({ model: 'm', harnesses: ['pi'], compat: { nope: 1 } })).toThrow();
  });
  test('parseCredentialsFile enforces name charset', () => {
    expect(() => parseCredentialsFile({ 'bad-name': { model: 'm', harnesses: ['pi'] } })).toThrow(/[a-z0-9_]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/credential-schema.test.ts`
Expected: FAIL (module not found / exports undefined).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/contracts/credential.ts
import { z } from 'zod';

export const CREDENTIAL_APIS = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const;
export const CREDENTIAL_AUTHS = ['api-key', 'subscription', 'oauth'] as const;
const COMPAT_KEYS = ['thinking_format', 'max_tokens_field'] as const;

const CompatSchema = z
  .object({
    thinking_format: z.enum(['zai']).optional(),
    max_tokens_field: z.string().optional(),
  })
  .strict() // unknown compat keys are an error (spec §12)
  .default({});

export const CredentialSchema = z.object({
  model: z.string().min(1),
  harnesses: z.array(z.string().min(1)).min(1),
  api: z.enum(CREDENTIAL_APIS).default('openai-chat'),
  base_url: z.string().url().optional(),
  auth: z.enum(CREDENTIAL_AUTHS).default('api-key'),
  api_key_env: z.string().min(1).optional(),
  compat: CompatSchema,
  max_concurrency: z.number().int().min(1).optional(),
  launch_spacing_seconds: z.number().min(0).optional(),
  os_support: z.array(z.string()).optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;

const NAME_RE = /^[a-z0-9_]+$/;
export function parseCredentialsFile(raw: unknown): Record<string, Credential> {
  const obj = z.record(z.string(), z.unknown()).parse(raw);
  const out: Record<string, Credential> = {};
  for (const [name, value] of Object.entries(obj)) {
    if (!NAME_RE.test(name)) {
      throw new Error(`credential name must match [a-z0-9_]+ : ${name}`);
    }
    out[name] = CredentialSchema.parse(value);
  }
  return out;
}
```

(Note `COMPAT_KEYS` is exported documentation of the closed set; the `.strict()` object enforces it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/credential-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint && bun run typecheck
git add src/contracts/credential.ts test/credential-schema.test.ts
git commit -m "feat(credential): schema + credentials file parser"
```

### Task A2: Credential resolution (default, api-key, limiterKey)

**Files:**
- Create: `src/credentials/resolve.ts`, `src/credentials/index.ts`
- Test: `test/credential-resolve.test.ts`

**Interfaces:**
- Consumes: `Credential` (A1), `getEnv` from `src/env.ts`.
- Produces:
  - `resolveCredentialName(opts: { explicit?: string; agentDefault: string }): string`
  - `resolveApiKey(cred: Credential, harnessConventionalEnv: string | undefined): { kind: 'env'; value: string } | { kind: 'native' }` (throws if `auth: api-key` and the chosen env var is unset)
  - `limiterKey(cred: Credential, name: string): string` — `\`${cred.base_url ?? name}|${cred.api}\``

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { limiterKey, resolveApiKey, resolveCredentialName } from '../src/credentials/resolve.ts';

const base = { model: 'm', harnesses: ['pi'], api: 'openai-chat', auth: 'api-key', compat: {} } as const;

describe('credential resolution', () => {
  test('explicit beats default', () => {
    expect(resolveCredentialName({ explicit: 'glm', agentDefault: 'x' })).toBe('glm');
    expect(resolveCredentialName({ agentDefault: 'x' })).toBe('x');
  });
  test('api_key_env wins; falls back to conventional', () => {
    process.env.GLM_KEY = 'k1'; process.env.PI_API_KEY = 'k2';
    expect(resolveApiKey({ ...base, api_key_env: 'GLM_KEY' }, 'PI_API_KEY')).toEqual({ kind: 'env', value: 'k1' });
    expect(resolveApiKey({ ...base }, 'PI_API_KEY')).toEqual({ kind: 'env', value: 'k2' });
  });
  test('subscription/oauth resolve native', () => {
    expect(resolveApiKey({ ...base, auth: 'subscription' }, undefined)).toEqual({ kind: 'native' });
  });
  test('missing api-key throws', () => {
    delete process.env.NOPE_KEY;
    expect(() => resolveApiKey({ ...base, api_key_env: 'NOPE_KEY' }, undefined)).toThrow();
  });
  test('limiterKey uses base_url then name', () => {
    expect(limiterKey({ ...base, base_url: 'https://e/v1' }, 'glm')).toBe('https://e/v1|openai-chat');
    expect(limiterKey({ ...base }, 'glm')).toBe('glm|openai-chat');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/credential-resolve.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/credentials/resolve.ts
import type { Credential } from '../contracts/credential.ts';
import { getEnv } from '../env.ts';

export function resolveCredentialName(opts: { explicit?: string; agentDefault: string }): string {
  return opts.explicit && opts.explicit !== '' ? opts.explicit : opts.agentDefault;
}

export type ApiKeyResolution = { kind: 'env'; value: string } | { kind: 'native' };

export function resolveApiKey(cred: Credential, harnessConventionalEnv: string | undefined): ApiKeyResolution {
  if (cred.auth !== 'api-key') return { kind: 'native' };
  const envName = cred.api_key_env ?? harnessConventionalEnv;
  if (envName === undefined) {
    throw new Error(`credential auth=api-key but no api_key_env and harness has no conventional key env`);
  }
  const value = getEnv(envName);
  if (value === undefined || value === '') {
    throw new Error(`api key env var ${envName} is unset/empty`);
  }
  return { kind: 'env', value };
}

export function limiterKey(cred: Credential, name: string): string {
  return `${cred.base_url ?? name}|${cred.api}`;
}
```

```ts
// src/credentials/index.ts
export * from './resolve.ts';
export { CredentialSchema, parseCredentialsFile, type Credential } from '../contracts/credential.ts';
```

- [ ] **Step 4: Run to verify it passes** — Run: `bun test test/credential-resolve.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck
git add src/credentials/ test/credential-resolve.test.ts
git commit -m "feat(credential): name/api-key/limiterKey resolution"
```

### Task A3: Author `credentials.yaml` + `default_credential` on agent YAML

**Files:**
- Create: `credentials.yaml` (repo top level)
- Modify: `coding-agents/*.yaml` (add `default_credential`, remove `max_concurrency`/`launch_spacing_seconds`)
- Modify: `src/contracts/agent-config.ts` (add `default_credential`; remove the two cap fields; the claude-family rule — see Task D2 keeps `model` working until migration; here just ADD `default_credential` as optional so nothing breaks yet)
- Test: `test/agent-config.test.ts` (extend existing)

**Interfaces:**
- Produces: `AgentConfig.default_credential?: string`.

- [ ] **Step 1: Write failing test** — add to `test/agent-config.test.ts`:

```ts
test('agent config accepts default_credential', () => {
  const cfg = AgentConfigSchema.parse({
    name: 'pi', binary: 'pi', session_log_dir: 'x', session_log_glob: '*', normalizer: 'pi',
    home_config_subdir: '.pi/agent', default_credential: 'pi_default',
  });
  expect(cfg.default_credential).toBe('pi_default');
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/agent-config.test.ts` — Expected: FAIL (unknown key stripped / type error).

- [ ] **Step 3: Implement** — in `src/contracts/agent-config.ts` `AgentConfigSchema` add `default_credential: z.string().optional(),` and remove `max_concurrency`/`launch_spacing_seconds` from the schema. Author `credentials.yaml`:

```yaml
# credentials.yaml — names match ^[a-z0-9_]+$
pi_default:     { model: gpt-5.5, harnesses: [pi] }       # adjust to pi's real default provider/model
opencode_gpt5:  { model: gpt-5.5, harnesses: [opencode] }
codex_sub:      { model: gpt-5.5, auth: subscription, api: openai-responses, harnesses: [codex] }
sonnet:         { model: claude-sonnet-4-6, api: anthropic, harnesses: [claude] }
haiku:          { model: claude-haiku-4-5, api: anthropic, harnesses: [claude] }
opus:           { model: opus, api: anthropic, harnesses: [claude] }
gemini_default: { model: gemini-2.5-pro, api: gemini, harnesses: [gemini] }
kimi_default:   { model: kimi-k2, harnesses: [kimi] }
glm_5_2:
  model: glm-5.2-fp8
  api: openai-responses
  base_url: https://oak-receiver-hear-homework.trycloudflare.com/v1
  api_key_env: GLM_API_KEY
  harnesses: [pi, opencode, codex]
  max_concurrency: 2
  compat: { thinking_format: zai }
```

Then add `default_credential: <name>` to each `coding-agents/*.yaml` (e.g. `pi.yaml` → `pi_default`) and delete their `max_concurrency`/`launch_spacing_seconds` lines.

(Models above are placeholders to be confirmed against each harness's real current default during execution — read each adapter's current default before finalizing.)

- [ ] **Step 4: Run to verify** — `bun test test/agent-config.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck && bun test test/agent-config.test.ts
git add credentials.yaml coding-agents/ src/contracts/agent-config.ts test/agent-config.test.ts
git commit -m "feat(credential): credentials.yaml + default_credential field"
```

### Task A4: `quorum check` credential/agent validation pass

**Files:**
- Modify: `src/cli/index.ts` (the `check` command), `src/scaffold.ts` (or a new `src/credentials/check.ts`)
- Test: `test/credential-check.test.ts`

**Interfaces:**
- Consumes: `parseCredentialsFile` (A1), agent configs.
- Produces: `checkCredentials(credentialsPath, codingAgentsDir): { ok: boolean; errors: string[] }`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { checkCredentials } from '../src/credentials/check.ts';
// uses a temp fixture dir helper; assert: default_credential must exist and list its harness
```

(Full fixture setup mirrors existing scaffold tests; assert an agent whose `default_credential` is missing → error; a `default_credential` whose `harnesses` omits that agent → error; a bad credential name → error.)

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `checkCredentials` (parse file via A1; for each agent YAML, assert `default_credential` exists in the file and the credential's `harnesses` includes the agent's harness name). Wire it into the `check` command so `bun run quorum check` runs it.
- [ ] **Step 4: Run to verify passes** + `bun run quorum check`.
- [ ] **Step 5: Commit** `feat(credential): quorum check validates credentials.yaml + default_credential`.

---

## PHASE B — Wire credential into a single run + adapters

### Task B1: Thread credential into the runner + `quorum run --credential`

**Files:**
- Modify: `src/runner/index.ts` (resolve credential, pass to provision, stamp on verdict, add to run-dir name), `src/cli/index.ts` (`--credential` option), `src/contracts/verdict.ts` (add `credential`)
- Test: `test/runner-credential.test.ts` (unit around verdict stamping + run-dir name; use existing runner unit-test seams)

**Interfaces:**
- Consumes: `resolveCredentialName` (A2), agent `default_credential`.
- Produces: `FinalVerdict.credential: string`; run-dir name `<scenario>-<agent>-<credential>-<os>-<stamp>-<nonce>`.

- [ ] **Step 1: Write failing test** asserting (a) `FinalVerdict` includes the resolved credential, (b) `allocateRunDir` output contains the credential segment in the documented position.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add `credential` to `VerdictSchema` (`src/contracts/verdict.ts`); in `src/runner/index.ts` resolve the credential name (CLI `--credential` else `cfg.default_credential`), load+validate it, pass the `Credential` into `provision(...)`, stamp `credential` where the four identity fields are written (`runner/index.ts:826-832`), and insert the segment in `allocateRunDir` (`runner/index.ts:106`). Add `--credential <name>` to the `run` command (`src/cli/index.ts`).
- [ ] **Step 4: Run to verify passes** + `bun run check`.
- [ ] **Step 5: Commit** `feat(credential): thread credential through run + verdict + run-dir`.

### Task B2: `provision(home, runner, credential)` signature + pi translator

**Files:**
- Modify: `src/agents/index.ts` (`CodingAgent.provision` signature, `resolveAgent`), `src/agents/pi.ts`
- Test: `test/agent-pi.test.ts` (extend)

**Interfaces:**
- Consumes: `Credential`, `resolveApiKey` (A2).
- Produces: pi writes `models.json` (provider from credential `base_url`/`api`/`compat`), `settings.json`, and `auth.json` with the **resolved key** (promotes the existing `pi.ts:362-366` fix; spec §9.2).

- [ ] **Step 1: Write failing test** — provision pi with a custom-endpoint credential; assert `models.json` provider has the credential's `baseUrl`/`api`/`compat.thinkingFormat`, and `auth.json` contains the resolved key (not the `$PI_API_KEY` placeholder).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — change the `CodingAgent.provision` contract (`src/agents/index.ts:40`) to `provision(home, runner, credential)`; update all adapters' signatures (no behavior change yet except pi). Rewrite `PiAgent.provision` to build `models.json` + `auth.json` from the credential via `resolveApiKey`; delete the `PI_MODELS_JSON` reading path.
- [ ] **Step 4: Run to verify passes.**
- [ ] **Step 5: Commit** `feat(credential): provision(credential) + pi translator (retires PI_MODELS_JSON)`.

### Task B3: opencode translator

**Files:** Modify `src/agents/opencode.ts`; Test `test/agent-opencode.test.ts`.

**Interfaces:** opencode writes `opencode.json` `provider` block from the credential (`@ai-sdk/openai-compatible` for openai-*, `@ai-sdk/anthropic` for anthropic, …) + `model: "<provider>/<model>"`, into both the run config and the preflight throwaway home. Deletes `OPENCODE_PROVIDER_JSON`/`OPENCODE_MODEL` reading.

- [ ] **Step 1:** failing test asserting `opencode.json` provider block + model derive from the credential, in both run + preflight homes.
- [ ] **Step 2:** run, verify fails.
- [ ] **Step 3:** implement; remove the env-var override helpers added during the benchmark.
- [ ] **Step 4:** run, verify passes.
- [ ] **Step 5:** commit `feat(credential): opencode translator (retires OPENCODE_PROVIDER_JSON)`.

### Task B4: codex translator + adapter-class merge

**Files:** Modify `src/agents/index.ts` (`resolveAgent`, `CUSTOM_AGENTS`), `src/agents/codex.ts`; Delete `src/agents/codex-api.ts`; Test `test/agent-codex.test.ts`.

**Interfaces:** one `CodexAgent.provision` branches on `credential.auth`: `subscription` → seed ChatGPT auth (existing path); `api-key` → write `config.toml` `[model_providers.*]` with `wire_api` from `api` + a non-`OPENAI_*` `env_key` (fold in `codex-api.ts` logic). Spec §9.1.

- [ ] **Step 1:** failing tests: subscription credential → `auth.json` seeded, no model_providers; api-key credential → `config.toml` model_providers with correct `wire_api`, no api-key in `auth.json`.
- [ ] **Step 2:** run, verify fails.
- [ ] **Step 3:** merge `CodexApiAgent` into `CodexAgent` (branch on `credential.auth`); delete `codex-api.ts`; remove `codex-api-custom-provider` from `CUSTOM_AGENTS` and `KNOWN_RUNTIME_FAMILIES`; map `api: openai-chat` → `wire_api: chat` and error clearly if the installed codex rejects it (spec §12).
- [ ] **Step 4:** run, verify passes.
- [ ] **Step 5:** commit `feat(credential): codex translator + merge CodexApiAgent`.

### Task B5: claude/gemini launcher model source + credential-aware required_env

**Files:** Modify `src/runner/index.ts` (launcher `$CLAUDE_MODEL` source), `src/agents/index.ts`/`gemini.ts`, `src/contracts/agent-config.ts` + `coding-agents/{claude,gemini}*.yaml` (drop the conventional key from `required_env`); Test `test/runner-credential.test.ts`.

**Interfaces:** the `$CLAUDE_MODEL` substitution (`runner/index.ts:1211-1216`) sources `credential.model`; claude/gemini key presence is owned by `resolveApiKey` (A2), not `required_env`.

- [ ] **Step 1:** failing test: a claude run with credential `sonnet` injects `$CLAUDE_MODEL=claude-sonnet-4-6`; a claude credential with a custom `api_key_env` is not blocked by unset `ANTHROPIC_API_KEY`.
- [ ] **Step 2–4:** implement + verify (remove `ANTHROPIC_API_KEY`/`GEMINI_API_KEY` from those YAMLs' `required_env`; resolve the key via the credential at provision; source `$CLAUDE_MODEL` from the credential).
- [ ] **Step 5:** commit `feat(credential): claude/gemini model+auth from credential`.

---

## PHASE C — Matrix, scheduler, identity consolidation

### Task C1: Scheduler re-key on `limiterKey`

**Files:** Modify `src/scheduler/index.ts`, `src/run-all/index.ts`; Test `test/scheduler.test.ts` (extend).

**Interfaces:** `MatrixEntry`/`Cell` gain `limiterKey: string`; `capFor`/`spacingFor`/the latch key on `limiterKey` (spec §6.1/§6.2). Caps resolve from the credential.

- [ ] **Step 1:** failing test: two cells with the same `limiterKey` but different agents share the cap; the rate-limit latch skips queued cells of the same `limiterKey` (note the deliberate blast-radius change, spec §6.2).
- [ ] **Step 2:** run, verify fails.
- [ ] **Step 3:** add `limiterKey` to `Cell` (`scheduler/index.ts:113-118`) and key `cap`/`spacing`/`skipQueuedForHarness` on it (lines 74-76, 148-149, 308-329); run-all computes per-cell caps from the credential (`run-all/index.ts:452-453`).
- [ ] **Step 4:** run, verify passes.
- [ ] **Step 5:** commit `feat(credential): scheduler keys on per-endpoint limiterKey`.

### Task C2: Matrix credential expansion + `harnesses`/os skip + child arg

**Files:** Modify `src/run-all/matrix.ts`, `src/run-all/index.ts`, `src/cli/index.ts` (`--credentials` csv), `src/contracts/batch.ts` (add `credential` to `MatrixEntry`/`ResultRecord`); Test `test/runner-unit.test.ts`/matrix tests.

**Interfaces:** `buildMatrix` yields `(scenario, agent, credential)` rows (cartesian over selected credentials), skipping `harness ∉ credential.harnesses` and `os ∉ (agent.os_support ∩ credential.os_support)` via the existing `skipped` channel (`matrix.ts:136-155`). `invokeChild` passes `--credential` (`run-all/index.ts:161-185`).

- [ ] **Step 1:** failing test: `--credentials a,b` × 1 agent × 1 scenario → 2 runnable rows; an incompatible credential → a `skipped` row, not an error.
- [ ] **Step 2–4:** implement + verify (add `--credential`/`--credentials` to CLI; default to the agent's `default_credential`).
- [ ] **Step 5:** commit `feat(credential): run-all matrix expands + skips on harnesses/os`.

### Task C3: Grid manifest + dashboard/cost identity from verdict (delete positional parsers)

**Files:** Modify `src/contracts/grid-manifest.ts`, `packages/dashboard/src/manifest.ts`, `packages/dashboard/src/contracts.ts` (cellKey/cellId), `packages/dashboard/src/scan.ts`, `src/cli/costs.ts`, `src/cli/render-batch.ts`; Tests in `packages/dashboard/test/` + `test/`.

**Interfaces:** both `GridManifestCell` copies gain `credential`; `cellKey(scenario, agent, credential, os)`; the dashboard reads identity from `verdict.json` (spec §14) — `parseRunDirName`, `ParsedRunDir`, the `scan.ts:236` reconstruction, and `identityFromRunDirName` are **deleted**; `CostRow`/cost columns/`BatchResultSchema`/`render-batch` cellKey carry `credential`.

- [ ] **Step 1:** failing tests: dashboard scan groups two same-(scenario,agent,os) runs with different credentials into distinct cells (read from verdict); cost rows distinguish credentials.
- [ ] **Step 2:** run, verify fails.
- [ ] **Step 3:** implement — make scan read each run's `verdict.json` identity (it already does in results-only mode, `scan.ts:172-184`); delete the positional parsers; add credential to grid/cost contracts and rendering.
- [ ] **Step 4:** run, verify passes (`bun test`, dashboard tests).
- [ ] **Step 5:** commit `refactor(credential): identity from verdict.json; delete run-dir name parsers`.

---

## PHASE D — Migration + cleanup

### Task D1: Collapse model-named claude agents

**Files:** Delete `coding-agents/claude-sonnet.yaml`, `coding-agents/claude-haiku.yaml`; Modify `coding-agents/claude.yaml` (`default_credential: opus` or chosen default); confirm `sonnet`/`haiku`/`opus` credentials exist (A3). Modify any scenario `# coding-agents:` directives that named `claude-sonnet`/`claude-haiku` (grep first). Test: `bun run quorum check`.

- [ ] **Step 1:** `grep -rn 'claude-sonnet\|claude-haiku' scenarios coding-agents docs` — list every reference (directives, fixtures, docs).
- [ ] **Step 2:** delete the two YAMLs; repoint references to `claude` + the credential, or update directives to harness name.
- [ ] **Step 3:** `bun run quorum check` + `bun run check` — Expected: PASS.
- [ ] **Step 4:** commit `feat(credential)!: collapse claude-sonnet/haiku into claude harness + credentials` (BREAKING per §17).

### Task D2: Claude-family validation rule + final hack/file deletion sweep

**Files:** Modify `src/contracts/agent-config.ts` (claude family now requires `default_credential`, not `model`, `agent-config.ts:110-114`); delete leftover `coding-agents/codex-api-custom-provider*`; grep-sweep for any remaining `PI_MODELS_JSON`/`OPENCODE_PROVIDER_JSON`/`CODEX_API_`/`OPENCODE_MODEL` reads.

- [ ] **Step 1:** failing test: a claude-family agent without `default_credential` fails validation; with it, passes (model no longer required on the YAML).
- [ ] **Step 2–4:** implement; `grep -rn 'PI_MODELS_JSON\|OPENCODE_PROVIDER_JSON\|CODEX_API_\|codex-api-custom-provider' src coding-agents` returns nothing; `bun run check` + `bun run quorum check` pass.
- [ ] **Step 5:** commit `chore(credential): claude validation on default_credential; delete benchmark hacks`.

### Task D3: Docs + experiment log

**Files:** Update `evals/CLAUDE.md` + `README.md` (the new credential axis, `--credentials`, `credentials.yaml`); create `docs/experiments/2026-06-22-glm-5.2-benchmark.md` (the run that motivated this — 8/8 clean passes, endpoint-saturation finding, ~$0.31/run gauntlet cost, per the experiment-log convention).

- [ ] **Step 1:** write the docs + experiment entry.
- [ ] **Step 2:** `bun run quorum check`; invoke `maintaining-documentation` if available.
- [ ] **Step 3:** commit `docs(credential): credential axis usage + GLM-5.2 experiment log`.

---

## Self-Review

- **Spec coverage:** §3 schema→A1; §4/§8 resolution→A2/B5; §5 identity→B1/C3; §6 scheduler+caps→C1; §6.3/§7 matrix skip→C2; §9 adapters→B2-B5; §9.1 codex merge→B4; §9.2 pi→B2; §10 migration→D1/D2; §11 location+check→A3/A4; §12 compat→A1/B4; §13 checklist→all tasks; §14 consolidation→B2/B3/B4/C3/D2; §15 testing→per-task; experiment log→D3. No section unmapped.
- **Placeholders:** the model values in `credentials.yaml` (A3) are flagged for confirmation against each adapter's real current default at execution — the only deliberate "confirm during execution" note; everything else is concrete.
- **Type consistency:** `Credential`, `resolveApiKey`, `limiterKey`, `provision(home, runner, credential)` used consistently A1→D2.
