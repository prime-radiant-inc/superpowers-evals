# Bedrock/Mantle Phase 1 — Claude coding-agent, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `opus_bedrock` credential that runs the Claude coding-agent on AWS Bedrock via Mantle (native Anthropic shape, bearer key, no SigV4), isolated behind the launcher's `env -i` wall, and make it the default — with the direct-API `opus` credential as the opt-out.

**Architecture:** A new `api: mantle` / `auth: bedrock-bearer` credential. `ClaudeAgent.provision` seeds the Bedrock env into the run-scoped mode-0600 `.claude-env` (never into the returned extra-env, so it can't leak into the gauntlet subprocess); the launcher `unset`s the Bedrock/AWS vars before sourcing that file, then conditionally forwards only the seeded ones through `env -i`. Unit tests + the PRI-2494 isolation test gate correctness; the default flip is gated on a live Mantle round-trip.

**Tech Stack:** TypeScript on Bun (≥1.3), zod schemas, biome, `bun test`. The Claude Code CLI is the agent under test.

## Global Constraints

- Claude Code version floor **≥ 2.1.200** (`--model`/Mantle routing); the appliance container is 2.1.202.
- Region **us-east-1** (Mantle is In-Region-only; probe-confirmed — see the spec). Model id is the **bare** `anthropic.claude-opus-4-8` (no version suffix).
- **Mantle-only, bearer auth (`AWS_BEARER_TOKEN_BEDROCK`), no SigV4.** No Invoke/`us.*`/SigV4 path.
- **Isolation invariant:** the coding-agent's Bedrock vars live ONLY in the run-scoped `.claude-env` (behind `env -i`). `ClaudeAgent.provision` MUST return `{}` (no extra-env) so nothing overlays the gauntlet subprocess. The launcher's forwarded-var list MUST be a subset of its unset list.
- The **default flip (Task 9) is gated** on: Tasks 1–8 merged, obol Step 0 (separate plan) done so `anthropic.claude-opus-4-8` prices, AWS account prep + region probe + the bearer materialized in the bundle, and the live DoD passing.
- Commit after each task. Run `bun run check` (biome + tsc + `bun test`) before every commit.

---

### Task 1: Credential contract — `mantle` api, `bedrock-bearer` auth, `region` field

**Files:**
- Modify: `src/contracts/credential.ts:3-9,20-35`
- Test: `test/credential-mantle.test.ts` (create)

**Interfaces:**
- Produces: `CREDENTIAL_APIS` now includes `'mantle'`; `CREDENTIAL_AUTHS` includes `'bedrock-bearer'`; `Credential.region?: string`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/credential-mantle.test.ts
import { expect, test } from 'bun:test';
import { CredentialSchema } from '../src/contracts/credential.ts';

test('mantle credential parses with api=mantle, auth=bedrock-bearer, region', () => {
  const cred = CredentialSchema.parse({
    model: 'anthropic.claude-opus-4-8',
    harnesses: ['claude'],
    api: 'mantle',
    auth: 'bedrock-bearer',
    api_key_env: 'AWS_BEARER_TOKEN_BEDROCK',
    region: 'us-east-1',
  });
  expect(cred.api).toBe('mantle');
  expect(cred.auth).toBe('bedrock-bearer');
  expect(cred.region).toBe('us-east-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/credential-mantle.test.ts`
Expected: FAIL — zod rejects `api: 'mantle'` / `auth: 'bedrock-bearer'` (invalid enum value).

- [ ] **Step 3: Add the enum values and the region field**

In `src/contracts/credential.ts`:

```typescript
export const CREDENTIAL_APIS = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
  'mantle',
] as const;
export const CREDENTIAL_AUTHS = [
  'api-key',
  'subscription',
  'oauth',
  'bedrock-bearer',
] as const;
```

And inside `CredentialSchema` (after the `os_support` line):

```typescript
  os_support: z.array(z.string()).optional(),
  // AWS region for a Bedrock/Mantle credential (api: 'mantle'). Required for
  // mantle by quorum check; the schema is non-strict, so it must be declared
  // here to survive parsing.
  region: z.string().min(1).optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/credential-mantle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/contracts/credential.ts test/credential-mantle.test.ts
git commit -m "feat(credential): add mantle api + bedrock-bearer auth + region"
```

---

### Task 2: `quorum check` — `api: mantle` requires a non-empty `region`

**Files:**
- Modify: `src/credentials/check.ts:22,31` (widen the parsed type; add the rule)
- Test: `test/credential-mantle.test.ts` (append) or `test/check-credentials.test.ts` if present — append here.

**Interfaces:**
- Consumes: `parseCredentialsFile` → `Record<string, Credential>` (Task 1's `region`).
- Produces: `checkCredentials` returns an error for a `mantle` credential missing `region`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/credential-mantle.test.ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCredentials } from '../src/credentials/check.ts';

test('quorum check rejects a mantle credential with no region', () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'));
  const credsPath = join(dir, 'credentials.yaml');
  writeFileSync(
    credsPath,
    'opus_bedrock:\n  model: anthropic.claude-opus-4-8\n  api: mantle\n  auth: bedrock-bearer\n  api_key_env: AWS_BEARER_TOKEN_BEDROCK\n  harnesses: [claude]\n',
  );
  const agentsDir = mkdtempSync(join(tmpdir(), 'agents-'));
  const res = checkCredentials(credsPath, agentsDir);
  expect(res.ok).toBe(false);
  expect(res.errors.join('\n')).toContain('opus_bedrock');
  expect(res.errors.join('\n')).toContain('region');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/credential-mantle.test.ts`
Expected: FAIL — no region rule exists; `res.ok` is true.

- [ ] **Step 3: Add the rule**

In `src/credentials/check.ts`, widen the parsed type and add a loop after the parse (Step 1 block). Change the declared type at line 22 from `Record<string, { harnesses: string[] }>` to the full credential type, and add the mantle-region check before the agent loop:

```typescript
  let credentials: Record<string, import('../contracts/credential.ts').Credential>;
  try {
    const raw: unknown = parseYaml(readFileSync(credentialsPath, 'utf8'));
    credentials = parseCredentialsFile(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`credentials file error: ${message}`] };
  }

  const errors: string[] = [];

  // Every mantle credential must declare a region (the Mantle endpoint URL is
  // built from it; an omitted region would seed a malformed host).
  for (const [credName, cred] of Object.entries(credentials)) {
    if (cred.api === 'mantle' && (cred.region === undefined || cred.region === '')) {
      errors.push(`credential '${credName}' has api: mantle but no region`);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/credential-mantle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/credentials/check.ts test/credential-mantle.test.ts
git commit -m "feat(check): require region for api: mantle credentials"
```

---

### Task 3: `resolveBedrockBearer` helper (fail-fast on empty)

**Files:**
- Modify: `src/credentials/resolve.ts:53` (add after `limiterKey`)
- Test: `test/credential-mantle.test.ts` (append)

**Interfaces:**
- Consumes: `Credential.api_key_env`, `getEnv`.
- Produces: `resolveBedrockBearer(cred: Credential): string` — returns the bearer or throws `` `bedrock bearer env var ${name} is unset/empty` ``.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/credential-mantle.test.ts
import { resolveBedrockBearer } from '../src/credentials/resolve.ts';

test('resolveBedrockBearer throws naming the env var when unset', () => {
  const cred = CredentialSchema.parse({
    model: 'anthropic.claude-opus-4-8', harnesses: ['claude'],
    api: 'mantle', auth: 'bedrock-bearer',
    api_key_env: 'AWS_BEARER_TOKEN_BEDROCK', region: 'us-east-1',
  });
  const prev = process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  try {
    expect(() => resolveBedrockBearer(cred)).toThrow('AWS_BEARER_TOKEN_BEDROCK');
  } finally {
    if (prev !== undefined) process.env.AWS_BEARER_TOKEN_BEDROCK = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/credential-mantle.test.ts`
Expected: FAIL — `resolveBedrockBearer` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/credentials/resolve.ts`, append:

```typescript
// Resolve the Amazon Bedrock API key (bearer) for a mantle credential from its
// api_key_env. Fail fast (never seed an empty bearer, which fails Mantle auth
// cryptically at runtime).
export function resolveBedrockBearer(cred: Credential): string {
  const envName = cred.api_key_env ?? 'AWS_BEARER_TOKEN_BEDROCK';
  const value = getEnv(envName);
  if (value === undefined || value === '') {
    throw new Error(`bedrock bearer env var ${envName} is unset/empty`);
  }
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/credential-mantle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/credentials/resolve.ts test/credential-mantle.test.ts
git commit -m "feat(credential): resolveBedrockBearer with fail-fast on empty"
```

---

### Task 4: `credentials.yaml` — add `opus_bedrock`, pin `opus.model`

**Files:**
- Modify: `credentials.yaml:6-10` (pin `opus.model`) and append `opus_bedrock`

- [ ] **Step 1: Pin the direct opt-out and add the Bedrock credential**

Change the `opus` entry's model from the floating alias to the pinned generation (matching the sonnet5/sonnet46 pinning convention), and append `opus_bedrock`:

```yaml
opus:
  # Direct-API opt-out. Pinned to claude-opus-4-8 (not the floating `opus` alias)
  # so the direct-vs-Bedrock comparison partner can't drift when Anthropic
  # repoints the alias, matching the sonnet5/sonnet46 pinning convention.
  model: claude-opus-4-8
  api: anthropic
  api_key_env: ANTHROPIC_API_KEY
  harnesses: [claude]

opus_bedrock:
  # Default Claude coding-agent path: Opus 4.8 via the Bedrock Mantle endpoint
  # (native Anthropic shape, bearer key, no SigV4). Region us-east-1 (Mantle is
  # In-Region-only; only us-east-1 serves opus-4-8/sonnet-5 in the US). Bare id
  # `anthropic.claude-opus-4-8` is the canonical Mantle model id. max_concurrency
  # 2 until the Bedrock account RPM/TPM quota is probed.
  model: anthropic.claude-opus-4-8
  api: mantle
  auth: bedrock-bearer
  api_key_env: AWS_BEARER_TOKEN_BEDROCK
  region: us-east-1
  harnesses: [claude]
  max_concurrency: 2
```

- [ ] **Step 2: Verify the registry still validates**

Run: `bun run quorum check`
Expected: PASS (no credential errors). `opus_bedrock` parses; the Task 2 region rule is satisfied.

- [ ] **Step 3: Commit**

```bash
git add credentials.yaml
git commit -m "feat(credentials): add opus_bedrock (Mantle); pin opus.model to claude-opus-4-8"
```

---

### Task 5: Provision — seed the Bedrock `.claude-env` (skip `seedClaudeAuth`)

**Files:**
- Modify: `src/agents/index.ts:141-155` (provision branch) + add `seedClaudeMantle` (export it) near `seedClaudeAuth:169`
- Test: `test/claude-mantle-provision.test.ts` (create)

**Interfaces:**
- Consumes: `resolveBedrockBearer` (Task 3), `CLAUDE_ENV_FILE_NAME`, `writePrivateFileNoFollow`, `shellSingleQuote` (all already imported in `index.ts`).
- Produces: `seedClaudeMantle(configDir: string, credential: Credential): void` — writes `.claude-env` with `CLAUDE_CODE_USE_MANTLE=1` + `AWS_REGION` + `AWS_BEARER_TOKEN_BEDROCK`, nothing else. `ClaudeAgent.provision` still returns `{}`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/claude-mantle-provision.test.ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialSchema } from '../src/contracts/credential.ts';
import { seedClaudeMantle } from '../src/agents/index.ts';

const CRED = CredentialSchema.parse({
  model: 'anthropic.claude-opus-4-8', harnesses: ['claude'],
  api: 'mantle', auth: 'bedrock-bearer',
  api_key_env: 'AWS_BEARER_TOKEN_BEDROCK', region: 'us-east-1',
});

test('seedClaudeMantle writes only the Bedrock env, no ANTHROPIC_API_KEY/apiKeyHelper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-key-xyz';
  seedClaudeMantle(dir, CRED);
  const env = readFileSync(join(dir, '.claude-env'), 'utf8');
  expect(env).toContain('CLAUDE_CODE_USE_MANTLE=1');
  expect(env).toContain("AWS_REGION='us-east-1'");
  expect(env).toContain("AWS_BEARER_TOKEN_BEDROCK='bedrock-key-xyz'");
  expect(env).not.toContain('ANTHROPIC_API_KEY');
  expect(existsSync(join(dir, 'api-key-helper.sh'))).toBe(false);
  expect(existsSync(join(dir, 'settings.json'))).toBe(false);
});

test('seedClaudeMantle throws when the bearer env var is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  process.env.AWS_BEARER_TOKEN_BEDROCK = '';
  expect(() => seedClaudeMantle(dir, CRED)).toThrow('AWS_BEARER_TOKEN_BEDROCK');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/claude-mantle-provision.test.ts`
Expected: FAIL — `seedClaudeMantle` is not exported.

- [ ] **Step 3: Add `seedClaudeMantle` and wire the provision branch**

In `src/agents/index.ts`, import the helper at the top with the other `../credentials/resolve.ts` imports:

```typescript
import { resolveApiKey, resolveBedrockBearer } from '../credentials/resolve.ts';
```

Extend the provision credential handling (replace the single `if` at line 141):

```typescript
    if (credential !== undefined && credential.auth === 'api-key') {
      let resolution: ApiKeyResolution;
      try {
        resolution = resolveApiKey(credential, 'ANTHROPIC_API_KEY');
      } catch (e) {
        throw new ProvisionError(e instanceof Error ? e.message : String(e));
      }
      if (resolution.kind !== 'env') {
        throw new ProvisionError('claude: could not resolve api key from credential');
      }
      seedClaudeAuth(configDir, claudeJsonPath, resolution.value);
    } else if (credential !== undefined && credential.api === 'mantle') {
      try {
        seedClaudeMantle(configDir, credential);
      } catch (e) {
        throw new ProvisionError(e instanceof Error ? e.message : String(e));
      }
    }
    return {};
```

Add the exported helper next to `seedClaudeAuth`:

```typescript
/** Seed the run-scoped .claude-env for the Bedrock/Mantle path: enable Mantle +
 *  region + the bearer. Deliberately does NOT seed ANTHROPIC_API_KEY, the
 *  apiKeyHelper, or the approval fingerprint — none apply on Bedrock. The vars
 *  live ONLY in this file (behind the launcher's env -i wall); provision returns
 *  {} so they never overlay the gauntlet subprocess. */
export function seedClaudeMantle(configDir: string, credential: Credential): void {
  const region = credential.region;
  if (region === undefined || region === '') {
    throw new Error('claude mantle credential requires a region');
  }
  const bearer = resolveBedrockBearer(credential);
  const envFile = join(configDir, CLAUDE_ENV_FILE_NAME);
  writePrivateFileNoFollow(
    envFile,
    `CLAUDE_CODE_USE_MANTLE=1\nAWS_REGION=${shellSingleQuote(region)}\nAWS_BEARER_TOKEN_BEDROCK=${shellSingleQuote(bearer)}\n`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/claude-mantle-provision.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/index.ts test/claude-mantle-provision.test.ts
git commit -m "feat(claude): provision Bedrock/Mantle .claude-env, skip seedClaudeAuth"
```

---

### Task 6: Launcher — unset before source, conditional forward, conditional key

**Files:**
- Modify: `coding-agents/claude-context/launch-agent:43-63`

- [ ] **Step 1: Rewrite the source + env-args + exec block**

Replace the block from `source "$CLAUDE_ENV_FILE"` through the `exec env -i ...` (lines 45–63) with:

```bash
# Scrub any host-inherited Bedrock/AWS/gate vars, and ANTHROPIC_API_KEY, BEFORE
# sourcing, so the gate and values below come ONLY from the run-scoped
# .claude-env, never host inheritance (PRI-2494). The ANTHROPIC_API_KEY unset in
# particular stops a host-exported key from being forwarded on the Mantle path.
# The forward list further down MUST stay a subset of this unset list.
unset CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_BEDROCK \
  AWS_REGION AWS_DEFAULT_REGION AWS_BEARER_TOKEN_BEDROCK \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE \
  ANTHROPIC_API_KEY
source "$CLAUDE_ENV_FILE"

# Host-env isolation (PRI-2494): env -i + explicit allowlist, matching the
# opencode/serf launchers. Host ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
# CLAUDE_CODE_* feature flags must not reconfigure the agent under test.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)

# Bedrock/Mantle: forwarded ONLY when the sourced .claude-env set them (the
# Bedrock credential path). provision writes all three together, so referencing
# them here under set -u is safe. Subset of the unset list above.
if [[ -n "${CLAUDE_CODE_USE_MANTLE:-}" ]]; then
  env_args+=("CLAUDE_CODE_USE_MANTLE=$CLAUDE_CODE_USE_MANTLE")
  env_args+=("AWS_REGION=$AWS_REGION")
  env_args+=("AWS_BEARER_TOKEN_BEDROCK=$AWS_BEARER_TOKEN_BEDROCK")
fi

# Direct-API key: forwarded ONLY on the api-key path (the Mantle path omits it, so
# the unconditional line would abort under set -u).
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  env_args+=("ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
fi

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 \
  claude --dangerously-skip-permissions --plugin-dir "$SUPERPOWERS_ROOT" --model "$CLAUDE_MODEL" "$@"
```

Also update the header comment block (lines 16–20, 35) to note the Mantle path (the `.claude-env` may carry `CLAUDE_CODE_USE_MANTLE`/`AWS_REGION`/`AWS_BEARER_TOKEN_BEDROCK` instead of `ANTHROPIC_API_KEY`).

- [ ] **Step 2: Syntax-check the launcher**

Run: `bash -n coding-agents/claude-context/launch-agent`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add coding-agents/claude-context/launch-agent
git commit -m "feat(launcher): Mantle-aware env -i (unset-before-source, conditional forward)"
```

(The behavioral verification is Task 7's isolation tests.)

---

### Task 7: Isolation tests — AWS scrub on direct, seeded values on Mantle

**Files:**
- Modify: `test/launcher-env-isolation.test.ts:19-71,84-95` (extend `installLauncher` + HOSTILE) and append a Mantle test.

**Interfaces:**
- Consumes: the Task 6 launcher.

- [ ] **Step 1: Extend HOSTILE and add an env-file-content option to installLauncher**

Add the AWS/Mantle vars to `HOSTILE` (lines 84–95):

```typescript
const HOSTILE = {
  ANTHROPIC_BASE_URL: 'http://evil.example',
  ANTHROPIC_AUTH_TOKEN: 'evil-token',
  ANTHROPIC_MODEL: 'evil-model',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  AWS_ACCESS_KEY_ID: 'AKIA-host',
  AWS_SECRET_ACCESS_KEY: 'host-secret',
  AWS_SESSION_TOKEN: 'host-session-token',
  AWS_PROFILE: 'host-profile',
  AWS_REGION: 'eu-evil-1',
  AWS_DEFAULT_REGION: 'eu-evil-1',
  AWS_BEARER_TOKEN_BEDROCK: 'host-bearer-EVIL',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session',
  OPENAI_API_KEY: 'sk-host-openai',
  OPENAI_BASE_URL: 'http://evil-openai.example',
  OPENAI_ORG_ID: 'evil-org',
  SOME_RANDOM_HOST_VAR: 'leaked',
};
```

Give `installLauncher` an `envFileContent` option (line 22 opts + lines 42–49):

```typescript
function installLauncher(
  agent: 'claude' | 'codex',
  opts: { omitEnvFile?: boolean; envFileContent?: string } = {},
): { launcher: string; binDir: string; envDump: string } {
```

and the write block:

```typescript
  const envFile = join(runDir, `${agent}.env`);
  if (!opts.omitEnvFile) {
    const dflt =
      agent === 'claude'
        ? "ANTHROPIC_API_KEY='sk-test-launcher'\n"
        : "CODEX_PROVIDER_API_KEY='sk-codex-test'\n";
    writeFileSync(envFile, opts.envFileContent ?? dflt);
  }
```

- [ ] **Step 2: Run the existing direct-path test to confirm the AWS vars are now scrubbed**

Run: `bun test test/launcher-env-isolation.test.ts -t "claude launcher: hostile"`
Expected: PASS — the existing test asserts every HOSTILE key (now including the AWS/Mantle vars) is `undefined` in the agent env, proving the direct path scrubs them.

- [ ] **Step 3: Add the Mantle positive-path test**

```typescript
test('claude launcher: Mantle .claude-env forwards seeded vars, drops the key, scrubs host AWS', () => {
  const { launcher, binDir, envDump } = installLauncher('claude', {
    envFileContent:
      "CLAUDE_CODE_USE_MANTLE=1\nAWS_REGION='us-east-1'\nAWS_BEARER_TOKEN_BEDROCK='seeded-bearer-OK'\n",
  });
  const proc = spawnSync('bash', [launcher], {
    encoding: 'utf8',
    env: { ...HOSTILE, PATH: `${binDir}:/usr/bin:/bin`, HOME: '/host/home' },
  });
  expect(proc.status).toBe(0);
  const env = parseEnvDump(envDump);
  // Seeded values reach the agent — NOT the hostile host values.
  expect(env['CLAUDE_CODE_USE_MANTLE']).toBe('1');
  expect(env['AWS_REGION']).toBe('us-east-1');
  expect(env['AWS_BEARER_TOKEN_BEDROCK']).toBe('seeded-bearer-OK');
  // The direct key is absent on the Mantle path.
  expect(env['ANTHROPIC_API_KEY']).toBe(undefined);
  // Host AWS creds the .claude-env did NOT set are still scrubbed.
  expect(env['AWS_ACCESS_KEY_ID']).toBe(undefined);
  expect(env['AWS_SESSION_TOKEN']).toBe(undefined);
  expect(env['AWS_PROFILE']).toBe(undefined);
});
```

- [ ] **Step 4: Run the full isolation suite**

Run: `bun test test/launcher-env-isolation.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add test/launcher-env-isolation.test.ts
git commit -m "test(launcher): assert AWS scrub on direct + seeded Mantle vars"
```

---

### Task 8: Reject a Mantle credential on Windows (credential-blind adapter)

**Files:**
- Modify: `src/agents/index.ts:274-289` (`resolveAgent` — add a `credentialApi` param + guard)
- Test: `test/agents-resolve.test.ts` (append; mirror the existing windows case)

**Interfaces:**
- `resolveAgent(config, os?, osTarget?, credentialApi?)` — new optional 4th param; throws `ProvisionError` when `os === 'windows'`, family `claude`, and `credentialApi === 'mantle'`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/agents-resolve.test.ts (mirror the existing windows resolveAgent case
// for the claude config + OsTarget fixture used there)
import { resolveAgent } from '../src/agents/index.ts';
// ...reuse this file's claude AgentConfig + osTarget fixtures...

test('resolveAgent rejects a mantle credential on windows', () => {
  expect(() =>
    resolveAgent(claudeConfig, 'windows', { remote: WINDOWS_REMOTE }, 'mantle'),
  ).toThrow(/Mantle/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/agents-resolve.test.ts -t "mantle credential on windows"`
Expected: FAIL — `resolveAgent` takes no 4th param and does not guard.

- [ ] **Step 3: Add the param + guard**

In `src/agents/index.ts`, extend `resolveAgent`:

```typescript
export function resolveAgent(
  config: AgentConfig,
  os: string = 'linux',
  osTarget?: OsTarget,
  credentialApi?: string,
): CodingAgent {
  if (os !== 'linux') {
    const family = config.runtime_family ?? config.name;
    if (family === 'claude') {
      if (credentialApi === 'mantle') {
        throw new ProvisionError(
          `agent ${config.name}: Windows Claude does not support the Mantle credential; use --credential opus`,
        );
      }
      if (osTarget === undefined || osTarget.remote === undefined) {
        throw new ProvisionError(
          `agent ${config.name}: windows provisioner requires osTarget.remote`,
        );
      }
      return new WindowsClaudeAgent(config, osTarget.remote);
    }
    throw new ProvisionError(`agent ${config.name} has no ${os} provisioner`);
  }
  // ...unchanged linux resolution...
```

Then thread the resolved credential's api at the runner call site (search `resolveAgent(` in `src/runner/index.ts`) — pass `resolvedCredential?.api` as the 4th argument.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/agents-resolve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/index.ts src/runner/index.ts test/agents-resolve.test.ts
git commit -m "feat(agents): reject Mantle credential on Windows Claude (credential-blind adapter)"
```

---

### Task 9: Flip the default — `claude.yaml` default_credential → `opus_bedrock` (GATED)

**Do NOT start this task until all prerequisites hold:**
- Tasks 1–8 merged and `bun run check` green.
- **Step 0 (obol) done** (separate plan): `anthropic.claude-opus-4-8` prices non-null in the installed obol.
- **AWS account prep done** (ops checklist, task `w3z1mu7u1`): grants confirmed, key minted with the scoped policy, region probe passed for us-east-1, `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` in the blessed bundle, `*.api.aws` egress allowed.
- **Live DoD passes** (see below).

**Files:**
- Modify: `coding-agents/claude.yaml:12-13`

- [ ] **Step 1: Run the live DoD (manual gate, trusted-maintainer host with the bundle)**

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
bun run quorum run scenarios/<cheap-scenario> --coding-agent claude --credential opus_bedrock
bun run quorum show <run>      # verdict composes
bun run quorum costs <run>     # est_cost_usd non-null AND unpriced_models empty; cache_read_input_tokens > 0
```
Confirm: the session log shows `anthropic.claude-opus-4-8`; capture is non-empty; and a direct run (`--credential opus`) still passes unchanged. Record the run in `docs/experiments/`.
Expected: `opus_bedrock` PASS with non-null priced cost; `opus` PASS.

- [ ] **Step 2: Flip the default**

In `coding-agents/claude.yaml`:

```yaml
model: claude-opus-4-8
default_credential: opus_bedrock
```

(Update `model:` from `opus` to `claude-opus-4-8` too, so the agent-config default matches the credential.)

- [ ] **Step 3: Validate**

Run: `bun run quorum check && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add coding-agents/claude.yaml
git commit -m "feat(claude): default to opus_bedrock (Mantle); opus is the direct opt-out"
```

---

## Follow-on (separate plans / tasks — out of scope for this plan)

These are deliberately not code-specified here; each needs its own read/plan:

1. **Rate-limit-429 hardening** — extend `isRateLimitedVerdict` (`src/run-all/index.ts:722`) to recognize Bedrock/Mantle throttle signatures (`429` / `ThrottlingException` / `RESOURCE_EXHAUSTED`) so the scheduler latch fires on an account-quota throttle. Needs a read of that function + a live throttle sample. Add a Bedrock account RPM/TPM quota probe to the ops checklist before the first `run-all`.
2. **Live DoD + re-baseline** — the sentinel-corpus re-baseline on Bedrock (needs AWS account access). Records the canonical Bedrock baseline.
3. **Step 0 — obol update** (separate plan) — add `anthropic.claude-{opus-4-8,sonnet-5,haiku-4-5}` + the bare `claude-*-5` spellings to obol's table, release, bump the dep. Needs the obol repo (not checked out locally).
4. **Phase 2 — grader on Mantle** (separate plan) — the runner grader-subprocess env (bearer → `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` mapping) + the cross-repo gauntlet patch (`resolveProvider` accepts `anthropic.claude-*`; `maxOutputTokensForModel` matches Sonnet 5; relax the two key-presence guards). Gated on the auth-header probe. The `gauntlet` repo IS checked out at `/Users/drewritter/prime-rad/gauntlet`.

## Self-review notes

- **Spec coverage:** contract (T1), region rule (T2), bearer resolve (T3), credential + opus pin (T4), provision skip-seedClaudeAuth (T5), launcher unset+forward+conditional-key (T6), isolation AWS-scrub + Mantle positive (T7), Windows exclusion (T8), gated default flip + DoD gates unpriced_models-empty & cache_read>0 (T9). Concurrency cap = `max_concurrency: 2` in T4; 429 detection + re-baseline + obol + grader deferred to Follow-on with pointers.
- **Isolation invariant** preserved: provision returns `{}`; Bedrock vars only in `.claude-env`; launcher forward-list ⊆ unset-list (asserted in T7).
- **Type consistency:** `seedClaudeMantle(configDir, credential)`, `resolveBedrockBearer(cred): string`, `resolveAgent(config, os?, osTarget?, credentialApi?)` — names match across tasks.
