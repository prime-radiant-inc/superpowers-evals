# Serf Builder Bake-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one strict Quorum cell per selected Serf/OpenRouter
model-provider credential, prove the runtime route, and compare only completed
Fractals builds on cost, speed, tokens, and caching.

**Architecture:** Keep Serf as one Coding-Agent and express market candidates as
strict credentials in an external YAML file. Quorum snapshots that file before
dispatch, resolves the selected model and exactly one API-key environment
variable, captures content-free OpenRouter generation metadata after ATIF
capture, and carries immutable labels plus charged economics through verdicts,
batch records, and the existing cost renderer. A new Serf-only scenario seeds a
hash-verified, public-safe Superpowers spec/plan pair and gates the completed Go
CLI with deterministic checks.

**Tech Stack:** TypeScript 5.9 on Bun 1.3+, Zod 3, YAML, Commander, Bash,
OpenRouter's generation metadata API, Go 1.21+ for the scenario fixture.

## Global Constraints

- The design at
  `docs/superpowers/specs/2026-07-10-serf-builder-bakeoff-design.md` is
  authoritative.
- `superpowers-evals` is public. Repository content must not contain private
  product names, private repository identities, workstation paths, service
  addresses, run ids, private candidate lists, API keys, or key values.
- Candidate YAML, real preset ids, key creation, raw results, and promotion
  decisions stay outside Git. Checked-in credential fixtures use inert example
  values only.
- Never serialize, log, bake, or pass a secret value through substitutions.
  Only the selected environment-variable name may appear in generated context.
- OpenRouter capture may call only `GET /api/v1/generation?id=...`; it must not
  call or persist generation content.
- A route-attestation or required-economics gap is `indeterminate`, never a
  pass, zero, or partial score.
- Old unlabeled verdicts and batch records must continue to parse. Do not add a
  compatibility alias for the old `quorum check --credentials` path flag; the
  canonical path flag becomes `--credentials-file`, while `run-all
  --credentials` remains the existing CSV candidate selector.
- Preserve default behavior when `--credentials-file` is omitted: read the
  repository's top-level `credentials.yaml`.
- Use TDD: focused red test, smallest implementation, focused green test, then
  commit. Run `bun run format` only on touched files when formatting is needed.
- Every task must end with clean output from its focused tests. The final task
  runs `bun run check`, `bun run quorum check`, and `git diff --check`.
- Live OpenRouter calls and paid Serf runs are trusted-maintainer acceptance
  steps only; they never run in public CI.

---

### Task 1: Make campaign credentials strict, labeled, and canonically serializable

**Files:**

- Modify: `src/contracts/credential.ts`
- Create: `src/credentials/file.ts`
- Modify: `src/credentials/index.ts`
- Test: `test/credential-schema.test.ts`
- Create: `test/credential-file.test.ts`
- Create: `test/fixtures/serf-campaign-credentials.yaml`

**Interfaces:**

- `CredentialLabelsSchema` is a closed object with required `model`,
  `provider`, `quantization`, `preset_version_id`, and `catalog_as_of` fields.
- `loadCredentialsFile(path: string): LoadedCredentials` reads and validates a
  required file and never silently converts errors to `{}`.
- `serializeCredentials(credentials: Record<string, Credential>): string`
  returns stable, sorted YAML ending in one newline.
- `writeCredentialsSnapshot(args): string` writes the canonical YAML and
  returns its absolute path.

- [ ] **Step 1: Add failing strict-schema tests**

In `test/credential-schema.test.ts`, add cases proving:

```typescript
const labeled = {
  model: 'openrouter/@preset/example-version',
  api: 'openai-chat',
  base_url: 'https://openrouter.ai/api/v1',
  api_key_env: 'OPENROUTER_API_KEY',
  harnesses: ['serf'],
  labels: {
    model: 'example/model',
    provider: 'example-provider',
    quantization: 'fp8',
    preset_version_id: '00000000-0000-4000-8000-000000000001',
    catalog_as_of: '2026-07-10',
  },
};

expect(CredentialSchema.parse(labeled).labels?.provider).toBe(
  'example-provider',
);
expect(() => CredentialSchema.parse({ ...labeled, unexpected: true })).toThrow();
expect(() =>
  CredentialSchema.parse({
    ...labeled,
    labels: { ...labeled.labels, extra: 'rejected' },
  }),
).toThrow();
expect(() =>
  CredentialSchema.parse({
    ...labeled,
    labels: { ...labeled.labels, quantization: 'unknown' },
  }),
).toThrow();
expect(() =>
  CredentialSchema.parse({ ...labeled, api_key_env: 'BAD-NAME' }),
).toThrow();
```

Use `z.string().date()` for `catalog_as_of`, `z.string().uuid()` for the preset
version, and reject `unknown` and `unverified` quantization values explicitly.

- [ ] **Step 2: Run the schema tests and verify red**

Run: `bun test test/credential-schema.test.ts`

Expected: FAIL because `labels` is discarded and the outer credential object
accepts unknown keys.

- [ ] **Step 3: Implement the closed labels contract**

In `src/contracts/credential.ts`, export:

```typescript
export const CredentialLabelsSchema = z
  .object({
    model: z.string().min(1),
    provider: z.string().min(1),
    quantization: z
      .string()
      .min(1)
      .refine((value) => !['unknown', 'unverified'].includes(value)),
    preset_version_id: z.string().uuid(),
    catalog_as_of: z.string().date(),
  })
  .strict();
export type CredentialLabels = z.infer<typeof CredentialLabelsSchema>;
```

Require provider and quantization labels to match
`^[a-z0-9]+(?:[-_.][a-z0-9]+)*$`; reject `unknown` and `unverified`
case-insensitively. Require `api_key_env` to match
`^[A-Za-z_][A-Za-z0-9_]*$`. Add
`labels: CredentialLabelsSchema.optional()` to `CredentialSchema`, then end the
outer `z.object(...)` with `.strict()`.

- [ ] **Step 4: Prove the canonical repository credentials remain valid**

Run:

```bash
bun test test/credential-schema.test.ts test/repo-default-credentials.test.ts
bun run quorum check
```

Expected: both tests pass and `quorum check` prints `ok   credentials`. If the
canonical file contains an undeclared field, add that real field to the schema
with its actual type; do not weaken `.strict()`.

- [ ] **Step 5: Add failing loader and serializer tests**

Create `test/credential-file.test.ts` covering:

- missing and malformed files throw with the path;
- `test/fixtures/serf-campaign-credentials.yaml` parses;
- serialization sorts credential names and object keys deterministically;
- snapshot output parses back to the same typed object;
- the serialized snapshot contains `OPENROUTER_API_KEY` but not the test secret
  value stored in that environment variable.

Use this inert fixture:

```yaml
serf_example_a:
  model: openrouter/@preset/example-a
  harnesses: [serf]
  api: openai-chat
  base_url: https://openrouter.ai/api/v1
  auth: api-key
  api_key_env: OPENROUTER_API_KEY
  labels:
    model: example/model-a
    provider: example-provider
    quantization: fp8
    preset_version_id: 00000000-0000-4000-8000-000000000001
    catalog_as_of: 2026-07-10
```

- [ ] **Step 6: Run the loader test and verify red**

Run: `bun test test/credential-file.test.ts`

Expected: FAIL because `src/credentials/file.ts` does not exist.

- [ ] **Step 7: Implement fail-closed loading and stable YAML**

Create `src/credentials/file.ts` with:

```typescript
export interface LoadedCredentials {
  readonly path: string;
  readonly credentials: Record<string, Credential>;
}

export function loadCredentialsFile(path: string): LoadedCredentials;
export function serializeCredentials(
  credentials: Record<string, Credential>,
): string;
export function writeCredentialsSnapshot(args: {
  readonly credentials: Record<string, Credential>;
  readonly destination: string;
}): string;
```

Use `parseYaml`, `parseCredentialsFile`, `stringify` from `yaml`, a recursive
key-sort over schema-known parsed values, `mkdirSync`, and `writeFileSync` with
mode `0o600`. Wrap read, YAML, and schema failures once as
`cannot load credentials file <path>: <reason>`.

Re-export these functions from `src/credentials/index.ts`.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
bun test test/credential-schema.test.ts test/credential-file.test.ts test/repo-default-credentials.test.ts
git diff --check
```

Expected: PASS with no diff errors.

Commit: `git commit -am "feat(credentials): add strict campaign snapshots"`
after explicitly staging the two new files and fixture too.

---

### Task 2: Expose `--credentials-file` and freeze every batch before dispatch

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `src/run-all/index.ts`
- Modify: `src/run-all/batch-index.ts`
- Test: `test/cli-run.test.ts`
- Test: `test/cli-run-all.test.ts`
- Test: `test/cli-list-check.test.ts`
- Test: `test/run-all.test.ts`
- Test: `test/run-all-batch-index.test.ts`

**Interfaces:**

- `quorum run`, `quorum run-all`, and `quorum check` accept
  `--credentials-file <path>`.
- `RunOptions`, `RunAllOptions`, `RunScenarioArgs`, `RunBatchArgs`, and
  `InvokeChildArgs` carry `credentialsFile`/`credentialsPath` explicitly.
- `run-all` writes `<batch-dir>/credentials.snapshot.yaml` before it invokes a
  child, and every child receives that path.
- A direct run writes `<run-dir>/credentials.snapshot.yaml` before selecting a
  credential and resolves from the snapshot.

- [ ] **Step 1: Add failing CLI forwarding tests**

Extend the CLI tests to assert these exact argument paths:

```text
quorum run ... --credentials-file test/fixtures/serf-campaign-credentials.yaml
quorum run-all ... --credentials-file test/fixtures/serf-campaign-credentials.yaml
quorum check ... --credentials-file test/fixtures/serf-campaign-credentials.yaml
```

For `buildChildRunArgs`, expect:

```typescript
expect(args).toContain('--credentials-file');
expect(args[args.indexOf('--credentials-file') + 1]).toBe(snapshotPath);
```

Also assert that `run-all --credentials serf_example_a` remains the CSV filter,
not a file path.

- [ ] **Step 2: Run CLI tests and verify red**

Run:

```bash
bun test test/cli-run.test.ts test/cli-run-all.test.ts test/cli-list-check.test.ts
```

Expected: FAIL on the unknown `--credentials-file` option.

- [ ] **Step 3: Wire the canonical option through all three commands**

Add `.option('--credentials-file <path>', 'credentials YAML path')` to the
three commands so Commander preserves whether the caller supplied the option.
Rename the `check` action's current path property from `credentials` to
`credentialsFile`; for `check` only, pass
`resolve(opts.credentialsFile ?? 'credentials.yaml')`. Pass optional resolved
paths to `runScenario` and `runBatch`.

In `InvokeChildArgs`, add `readonly credentialsPath?: string`, and append:

```typescript
if (args.credentialsPath !== undefined) {
  childArgs.push('--credentials-file', args.credentialsPath);
}
```

- [ ] **Step 4: Add failing snapshot immutability tests**

In `test/run-all.test.ts`, inject an `invoke` that:

1. records every `credentialsPath`;
2. mutates the source YAML after the first invocation begins; and
3. asserts both invocations received the same batch snapshot path and the
   snapshot still contains the original model.

Add a missing-file case that expects `runBatch` to reject before `invoke` is
called. Add a direct-run test proving its run-local snapshot exists and contains
no secret value.

- [ ] **Step 5: Run snapshot tests and verify red**

Run:

```bash
bun test test/run-all.test.ts test/run-all-batch-index.test.ts test/runner-credential.test.ts
```

Expected: FAIL because `runBatch` silently ignores bad credentials and children
still receive the mutable source path or no path.

- [ ] **Step 6: Implement batch and direct-run snapshots**

Replace the permissive private `loadCredentials` in `src/run-all/index.ts`.
When an explicit path is present, load it fail-closed before matrix
construction. When omitted, read the repository's canonical
`credentials.yaml`; preserve the existing empty-map behavior only when that
default file is absent, while malformed canonical YAML remains an error.
Allocate the batch, write its snapshot, build the matrix from the parsed
credentials, and pass the snapshot path through `invokeCell`.

For a direct run, allocate the run directory first, load the requested/default
credentials file, write `credentials.snapshot.yaml`, and resolve the selected
credential from that snapshot object. Do not re-read the source file later.

Preserve `writeBatchHeader` ordering and ensure a failure before batch
allocation leaves no half-created batch directory. A failure after allocation
must leave an inspectable batch with no dispatched results.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
bun test test/cli-run.test.ts test/cli-run-all.test.ts test/cli-list-check.test.ts test/run-all.test.ts test/run-all-batch-index.test.ts test/runner-credential.test.ts
git diff --check
```

Expected: PASS.

Commit: `feat(cli): freeze external campaign credentials`

---

### Task 3: Make Serf resolve the selected model and forward exactly one key

**Files:**

- Modify: `src/credentials/resolve.ts`
- Modify: `src/agents/serf.ts`
- Modify: `src/runner/index.ts`
- Modify: `coding-agents/serf.yaml`
- Modify: `coding-agents/serf-context/launch-agent`
- Test: `test/credential-resolve.test.ts`
- Test: `test/agent-serf.test.ts`
- Test: `test/runner-credential.test.ts`
- Test: `test/runner-context.test.ts`

**Interfaces:**

- `resolveApiKeyEnvName(cred, conventionalEnv): string | null` returns the
  selected variable name for `auth: api-key`, or `null` for native auth.
- `SerfAgent.provision(home, runner, credential?)` rejects non-api-key campaign
  auth and validates the selected key without returning its value.
- `$SERF_MODEL` is `resolvedCredential?.model ?? cfg.model ?? ''`.
- `$SERF_API_KEY_ENV` contains only the selected variable name.

- [ ] **Step 1: Add failing resolver and provisioning tests**

Cover these cases:

- `serf_default` resolves `ANTHROPIC_API_KEY`;
- an OpenRouter credential resolves `OPENROUTER_API_KEY`;
- missing/empty selected env fails before launch;
- subscription/OAuth credentials are rejected for Serf v1;
- a preset model string survives substitution byte-for-byte;
- generated context contains the selected env name and does not contain the
  secret value;
- unrelated ambient provider keys are absent from the launched clean env.

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
bun test test/credential-resolve.test.ts test/agent-serf.test.ts test/runner-credential.test.ts test/runner-context.test.ts
```

Expected: FAIL because Serf ignores the credential model and the launcher scans
five ambient key variables.

- [ ] **Step 3: Separate key-name resolution from key-value validation**

Implement:

```typescript
export function resolveApiKeyEnvName(
  cred: Credential,
  harnessConventionalEnv: string | undefined,
): string | null {
  if (cred.auth !== 'api-key') return null;
  const envName = cred.api_key_env ?? harnessConventionalEnv;
  if (envName === undefined) {
    throw new Error(
      'credential auth=api-key but no api_key_env and harness has no conventional key env',
    );
  }
  return envName;
}
```

Refactor `resolveApiKey` to call it, then read and validate only that variable.

- [ ] **Step 4: Make provisioning credential-aware**

Change `SerfAgent.provision` to accept the same runner/credential arguments as
other adapters. If a credential is selected and `auth !== 'api-key'`, throw a
`ProvisionError`. Call `resolveApiKey(credential, 'ANTHROPIC_API_KEY')` to fail
fast, but continue returning `{}` so the secret is never overlaid onto the QA
agent environment.

- [ ] **Step 5: Narrow launcher forwarding**

Remove `ANTHROPIC_API_KEY` from `coding-agents/serf.yaml` `required_env`; keep
`SUPERPOWERS_ROOT`.

Replace the five-key loop in `launch-agent` with:

```bash
selected_name="$SERF_API_KEY_ENV"
if [[ -z "$selected_name" ]]; then
  echo 'launch-agent: selected Serf API key env name is empty' >&2
  exit 1
fi
selected_value="${!selected_name-}"
if [[ -z "$selected_value" ]]; then
  echo "launch-agent: selected Serf API key env $selected_name is unset/empty" >&2
  exit 1
fi
env_args+=("$selected_name=$selected_value")
```

Continue using `env -i`. Add `$SERF_API_KEY_ENV` to required Serf context
substitutions and the unresolved-substitution guard.

- [ ] **Step 6: Resolve model and key name in the runner**

For `family === 'serf'`:

```typescript
const serfModel = resolvedCredential?.model ?? cfg.model ?? '';
const serfKeyEnv = resolvedCredential
  ? resolveApiKeyEnvName(resolvedCredential, 'ANTHROPIC_API_KEY')
  : 'ANTHROPIC_API_KEY';
substitutions['$SERF_MODEL'] = serfModel;
substitutions['$SERF_MODEL_SH'] = shellSingleQuote(serfModel);
substitutions['$SERF_API_KEY_ENV'] = serfKeyEnv ?? '';
substitutions['$SERF_API_KEY_ENV_SH'] = shellSingleQuote(serfKeyEnv ?? '');
```

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
bun test test/credential-resolve.test.ts test/agent-serf.test.ts test/runner-credential.test.ts test/runner-context.test.ts
git diff --check
```

Expected: PASS and the secret-value fixture never appears in a generated file.

Commit: `feat(serf): isolate selected model and API key`

---

### Task 4: Carry candidate labels through matrix, results, and verdicts

**Files:**

- Modify: `src/contracts/batch.ts`
- Modify: `src/contracts/verdict.ts`
- Modify: `src/run-all/matrix.ts`
- Modify: `src/run-all/batch-index.ts`
- Modify: `src/run-all/index.ts`
- Modify: `src/runner/index.ts`
- Test: `test/run-all-matrix.test.ts`
- Test: `test/run-all-batch-index.test.ts`
- Test: `test/runner-identity.test.ts`

**Interfaces:**

- Optional `labels: CredentialLabels` appears on `MatrixEntry`,
  `ResultRecord`, and `FinalVerdict`.
- Old JSON without `labels` remains valid.
- Labels come only from the parsed snapshot credential; no caller can supply an
  independent label object.

- [ ] **Step 1: Add failing round-trip tests**

Assert a labeled credential produces identical labels in the matrix entry,
`results.jsonl`, and `verdict.json`. Parse an old fixture without labels and
assert success.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test test/run-all-matrix.test.ts test/run-all-batch-index.test.ts test/runner-identity.test.ts
```

Expected: FAIL because contracts and writers do not include labels.

- [ ] **Step 3: Add optional typed fields and writer plumbing**

Import `CredentialLabelsSchema` into both contracts. Add
`labels: CredentialLabelsSchema.optional()` to the Zod records and
`readonly labels?: CredentialLabels` to `MatrixEntry`.

`buildMatrix` copies `credential.labels`. `appendResultRecord` and the runner's
final verdict identity copy the selected credential's labels. Stopped verdicts
may omit labels because they can occur before credential parsing finishes.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
bun test test/run-all-matrix.test.ts test/run-all-batch-index.test.ts test/runner-identity.test.ts test/cli-render-batch-tolerance.test.ts
git diff --check
```

Expected: PASS, including old unlabeled artifacts.

Commit: `feat(results): preserve candidate labels`

---

### Task 5: Add a content-free OpenRouter generation attestation client

**Files:**

- Create: `src/openrouter/generations.ts`
- Create: `test/openrouter-generations.test.ts`
- Create: `test/fixtures/openrouter-generation-valid.json`
- Create: `test/fixtures/openrouter-generation-dated-model.json`

**Interfaces:**

- `OpenRouterGenerationSchema` narrows the documented metadata response.
- `captureOpenRouterGenerations(args): Promise<OpenRouterAttestation>` accepts
  generation ids and an injectable `fetchFn`.
- `normalizeProviderSlug`, `modelMatchesLabel`, and
  `openRouterGenerationIds(trajectory)` are pure exported helpers.
- Output schema version is `1` and contains metadata only.

- [ ] **Step 1: Add failing pure-helper and HTTP tests**

Cover:

- de-duplicated `gen-` ids from assistant-step `extra.response_id` in first-seen
  order; ignore non-`gen-` ids;
- provider normalization such as `Example Provider` → `example-provider`;
- exact labeled model and an OpenRouter dated suffix both match;
- wrong provider, wrong model, `is_byok: true`, absent `preset_id`, duplicate or
  missing generations reject;
- 401, 404, 429, 5xx, malformed JSON, and schema mismatch reject with the id and
  status;
- summed `total_cost` ignores no records and becomes `null` if any generation's
  charged cost is absent;
- the requested URL is exactly
  `https://openrouter.ai/api/v1/generation?id=<encoded-id>`;
- serialized output contains no prompt, completion, messages, or content keys.

- [ ] **Step 2: Run and verify red**

Run: `bun test test/openrouter-generations.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement documented response narrowing**

The response schema must accept the documented fields used by the design:

```typescript
const GenerationDataSchema = z
  .object({
    id: z.string().startsWith('gen-'),
    model: z.string().min(1),
    provider_name: z.string().min(1),
    preset_id: z.string().nullable(),
    is_byok: z.boolean(),
    latency: z.number().nullable(),
    generation_time: z.number().nullable(),
    native_tokens_prompt: z.number().nullable(),
    native_tokens_completion: z.number().nullable(),
    native_tokens_reasoning: z.number().nullable(),
    native_tokens_cached: z.number().nullable(),
    total_cost: z.number().nullable(),
    upstream_inference_cost: z.number().nullable(),
  })
  .passthrough();
```

Parse `{ data: GenerationDataSchema }`; persist only the listed keys. Send
`Authorization: Bearer <key>` and no request body. Fetch sequentially to avoid
turning attestation into a second burst against the provider API.

Use this result contract:

```typescript
export interface OpenRouterAttestation {
  readonly schema_version: 1;
  readonly expected: {
    readonly model: string;
    readonly provider: string;
    readonly preset_version_id: string;
    readonly is_byok: false;
  };
  readonly generations: readonly OpenRouterGeneration[];
  readonly charged_cost_usd: number | null;
}
```

Require `preset_id === labels.preset_version_id`; this converts the snapshot's
claimed designated preset version into runtime proof rather than provenance
only.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
bun test test/openrouter-generations.test.ts
git diff --check
```

Expected: PASS with no network access.

Commit: `feat(openrouter): attest generation routes`

---

### Task 6: Integrate route attestation and charged cost into run composition

**Files:**

- Modify: `src/runner/index.ts`
- Modify: `src/contracts/economics.ts`
- Modify: `src/economics.ts`
- Test: `test/runner-credential.test.ts`
- Test: `test/runner-phase.test.ts`
- Test: `test/economics.test.ts`

**Interfaces:**

- OpenRouter-labeled Serf runs must attest every `gen-` response id after ATIF
  and token capture.
- `<run-dir>/openrouter-generations.json` is written atomically.
- `economics.coding_agent.openrouter` carries charged cost, estimated cost,
  cost delta, generation count, and attested provider/model.
- Missing generation ids, fetch errors, route mismatch, missing charged cost,
  or missing token evidence produces capture-stage `indeterminate`.

- [ ] **Step 1: Add failing runner tests around an injectable fetch seam**

Extend `RunScenarioArgs`/the internal runner dependencies with optional
`openRouterFetch?: typeof fetch`. Use fake ATIF and fake generation responses to
prove:

- non-OpenRouter and unlabeled runs never fetch;
- a labeled OpenRouter Serf run writes the sidecar and can pass;
- wrong provider/model/preset, unexpected BYOK, no `gen-` ids, HTTP failure,
  missing token usage, and null charged cost all write `indeterminate` with
  `error.stage === 'capture'`;
- a failed attestation never runs post-checks as if evidence were complete;
- the sidecar text does not contain the injected key or transcript content.

- [ ] **Step 2: Run runner tests and verify red**

Run:

```bash
bun test test/runner-credential.test.ts test/runner-phase.test.ts
```

Expected: FAIL because no attestation phase exists.

- [ ] **Step 3: Add the attestation phase after generic capture**

After `captureToolCallsWithRetry` and `captureTokenUsage` have produced
`trajectory.json` and `coding-agent-token-usage.json`, detect an OpenRouter
campaign by all of:

```typescript
family === 'serf'
resolvedCredential?.base_url === 'https://openrouter.ai/api/v1'
resolvedCredential?.labels !== undefined
```

Resolve the selected key with `resolveApiKey`, extract `gen-` ids from the
captured trajectory, fetch metadata, and atomically write the attestation.
Catch the module's typed error and return `writeIndeterminate` with a concise,
content-free message.

- [ ] **Step 4: Extend economics without weakening legacy tolerance**

Add an optional `openrouter` object to the coding-agent economics schema:

```typescript
{
  charged_cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_delta_usd: number | null;
  generation_count: number;
  model: string;
  provider: string;
}
```

`buildRunEconomics` reads `openrouter-generations.json`, uses the charged sum as
the authoritative campaign cost, and computes
`round6(charged - estimated)` only when both values exist. Legacy runs without
the file retain their current economics shape.

- [ ] **Step 5: Add economics tests and run focused green**

Test multi-generation sum, explicit delta, missing sidecar, malformed sidecar,
and legacy behavior.

Run:

```bash
bun test test/runner-credential.test.ts test/runner-phase.test.ts test/economics.test.ts
git diff --check
```

Expected: PASS.

Commit: `feat(economics): capture OpenRouter charged cost`

---

### Task 7: Turn `quorum costs` into the labeled builder comparison grid

**Files:**

- Modify: `src/cli/costs.ts`
- Test: `test/cli-costs.test.ts`
- Test: `test/cli-render-economics.test.ts`
- Test: `test/cli-render-batch-tolerance.test.ts`

**Interfaces:**

- Labeled rows add model, provider, quantization, final verdict, charged cost,
  estimated cost, cost delta, and cache-read percentage.
- Unlabeled rows retain the existing compact columns.
- Missing metrics display `—`/`unpriced`, never numeric zero.
- Only `final === 'pass'` rows receive a comparable marker; fail and
  indeterminate remain visible but unranked.

- [ ] **Step 1: Add failing row and formatting tests**

Use one pass, one fail, one indeterminate, and one legacy unlabeled verdict.
Assert:

```typescript
cacheReadPercent({ input: 800, cacheRead: 200 }) === 20
cacheReadPercent({ input: 0, cacheRead: 0 }) === null
```

The denominator is `input + cache_read`; `cache_create` is not part of the
ratio. Verify the table includes `quant`, `final`, `charged`, `estimated`, and
`delta`, and does not show missing values as `$0.00` or `0%`.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test test/cli-costs.test.ts test/cli-render-economics.test.ts test/cli-render-batch-tolerance.test.ts
```

Expected: FAIL because labels and charged economics are ignored.

- [ ] **Step 3: Extend tolerant verdict and batch views**

Add optional `.passthrough()` views for `final`, `labels`, and the OpenRouter
economics block. Extend `CostRow` with nullable fields; prefer the verdict's
labels and fall back to the batch record's labels for old/partial verdicts.

Export this pure helper for direct tests:

```typescript
export function cacheReadPercent(args: {
  readonly input: number | null;
  readonly cacheRead: number | null;
}): number | null {
  if (args.input === null || args.cacheRead === null) return null;
  const denominator = args.input + args.cacheRead;
  return denominator === 0 ? null : (args.cacheRead / denominator) * 100;
}
```

Do not add a composite score or sort winner. Preserve input/result order so the
grid matches the batch matrix.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
bun test test/cli-costs.test.ts test/cli-render-economics.test.ts test/cli-render-batch-tolerance.test.ts
git diff --check
```

Expected: PASS for labeled and legacy rows.

Commit: `feat(costs): render builder comparison metrics`

---

### Task 8: Validate content-addressed scenario baselines

**Files:**

- Create: `src/scenario-manifest.ts`
- Modify: `src/scaffold.ts`
- Modify: `src/check/dispatch.ts`
- Modify: `src/cli/check-tool.ts`
- Test: `test/scenario-manifest.test.ts`
- Test: `test/scaffold.test.ts`

**Interfaces:**

- Optional `baseline-manifest.json` schema version `1` declares spec/plan role
  paths plus every file under `fixtures/`, with Git mode and SHA-256.
- `validateBaselineManifest(scenarioDir): string[]` returns deterministic
  problems for structural validation.
- A `baseline-manifest` check verb verifies the seeded worktree before paid
  execution using the same contract.
- `parseBaselineManifest(path): BaselineManifest` owns JSON/Zod narrowing.
- `verifyBaselineTree(args: { manifest: BaselineManifest; rootDir: string;
  ignoreGitDir?: boolean }): string[]` owns path, mode, and digest comparison.
- `validateBaselineManifest(scenarioDir): string[]` compares the manifest to
  `<scenarioDir>/fixtures`; the runtime check compares the same manifest to the
  seeded worktree with only `.git/` ignored.

- [ ] **Step 1: Add failing manifest tests**

Create temp scenarios covering valid input, missing declared file, extra
undeclared fixture, changed bytes, wrong mode, path traversal, duplicate path,
unsorted path list, and spec/plan roles not present in `files`.

Use this exact public schema:

```json
{
  "schema_version": 1,
  "roles": {
    "spec": "docs/superpowers/specs/2026-07-01-fractals-cli-design.md",
    "plan": "docs/superpowers/plans/2026-07-01-fractals-cli.md"
  },
  "files": [
    {
      "path": "docs/superpowers/plans/2026-07-01-fractals-cli.md",
      "mode": "100644",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

The test hash above is generated as `'a'.repeat(64)` in test code. A committed
scenario manifest always contains the real file hash.

- [ ] **Step 2: Run and verify red**

Run: `bun test test/scenario-manifest.test.ts test/scaffold.test.ts`

Expected: FAIL because the validator and check verb do not exist.

- [ ] **Step 3: Implement one shared validator**

Use Zod `.strict()`, `lstatSync`, `readdirSync`, `createHash('sha256')`, and
POSIX-normalized relative paths. Reject symlinks, directories in `files`,
absolute paths, `..`, backslashes, non-regular files, extra files, and any mode
other than `100644` or `100755`.

`checkScenario` calls the validator only when `baseline-manifest.json` exists.
The check verb reads `$QUORUM_SCENARIO_DIR`; add `scenarioDir?: string` to
`RunPhaseArgs`, export it as `QUORUM_SCENARIO_DIR`, and pass `a.scenarioDir` in
both runner phase invocations. Runtime verification uses the scenario manifest
against the phase cwd and ignores only cwd's `.git/` directory.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
bun test test/scenario-manifest.test.ts test/scaffold.test.ts test/runner-phase.test.ts
git diff --check
```

Expected: PASS.

Commit: `feat(scenarios): verify content-addressed fixtures`

---

### Task 9: Add the public Serf Fractals scenario and neutral smoke wording

**Files:**

- Create: `scenarios/serf-builder-fractals/story.md`
- Create: `scenarios/serf-builder-fractals/setup.sh`
- Create: `scenarios/serf-builder-fractals/checks.sh`
- Create: `scenarios/serf-builder-fractals/baseline-manifest.json`
- Create: `scenarios/serf-builder-fractals/fixtures/docs/superpowers/specs/2026-07-01-fractals-cli-design.md`
- Create: `scenarios/serf-builder-fractals/fixtures/docs/superpowers/plans/2026-07-01-fractals-cli.md`
- Modify: `scenarios/00-quorum-smoke-hello-world/story.md`
- Test: `test/scenario-fixture-language.test.ts`
- Test: `test/scenario-pinning.test.ts`

**Fixture contract:**

- Approved source design SHA-256:
  `7d7e963333e562103bace8c27281d69a0ada2511b269db180412e75796d0c5be`.
- Approved source plan SHA-256:
  `3155d25b1a7744ba0591a300a72f9b6ce9c569dd27c95e43f7dc5df54f14682f`.
- The only release sanitization is replacing every absolute path ending in the
  source checkout directory with `.` while preserving the rest byte-for-byte.
- Sanitized plan SHA-256:
  `927f9ed4a0ef20c29c8232899c7ae13af01620a0931c18f2fa46f0f4ed2c5dd6`.
- The design needs no transformation and retains its source hash.
- The implementation session obtains the approved source pair through the
  secure workspace handoff; it must verify the two source hashes before
  transforming or copying anything.

**Interfaces:**

- The scenario is runnable only by `serf` on Linux and uses the existing
  `init_repo_from_fixtures` setup helper.
- Static `quorum check` and runtime `pre()` both verify the same two-file
  baseline manifest.
- `post()` requires the SDD workflow evidence, all six CLI render paths,
  documented invalid-input behavior, fourteen task commits plus the seed
  commit, and a clean `main` checkout.

- [ ] **Step 1: Add failing public-safety and scenario tests**

Extend language/pinning tests to require:

- `# coding-agents: serf` and `# os: linux` directives;
- story status `ready`, tier `full`, and one neutral SDD instruction;
- no individual task names in the story;
- exact manifest role paths and hashes;
- the new scenario text contains no absolute workstation path, source
  repository identity, IPv4 service URL, query-string run id, API-key
  assignment, or known secret-value test marker;
- the hello-world story says `Coding-Agent`, not a vendor model name.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test test/scenario-fixture-language.test.ts test/scenario-pinning.test.ts
```

Expected: FAIL because the scenario is absent and smoke prose is agent-specific.

- [ ] **Step 3: Build and hash the sanitized fixture pair**

Verify the secure source hashes first. Copy the design unchanged. Transform the
plan's source-checkout absolute prefix to `.` only. Then verify the sanitized
hashes above and run the prohibited-string scan from Step 1. Do not copy `.git`,
completed source code, a run artifact, or any other file.

Write `baseline-manifest.json` with exactly two sorted `100644` entries: plan
first, spec second, using the two sanitized hashes above.

- [ ] **Step 4: Add setup, story, and deterministic checks**

`setup.sh` is:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run init_repo_from_fixtures
```

The story tells the QA agent once to ask Serf to execute the implementation
plan using the design context and
`superpowers:subagent-driven-development`, dispatching implementer,
spec-compliance, and code-quality roles. It answers ordinary workflow questions
consistently and requires delivery on the main checkout.

`checks.sh` starts with the Serf/Linux directives. Its `pre()` runs:

```bash
baseline-manifest
git-repo
git-branch main
file-exists 'docs/superpowers/specs/2026-07-01-fractals-cli-design.md'
file-exists 'docs/superpowers/plans/2026-07-01-fractals-cli.md'
requires-tool go
```

Its `post()` transcribes the emitted plan's acceptance surface:

```bash
check-transcript skill-called superpowers:subagent-driven-development
check-transcript tool-called Agent
git-branch main
file-exists '**/*_test.go'
file-exists 'cmd/fractals/main.go'
command-succeeds 'go test ./...'
command-succeeds 'go build -o "$QUORUM_RUN_DIR/fractals-bin" ./cmd/fractals'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" --help'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" sierpinski --size 8 --depth 3 --char "#"'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" mandelbrot --width 20 --height 8 --iterations 20'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" julia --width 20 --height 8 --iterations 20'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" burningship --width 20 --height 8 --iterations 20'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" newton --width 20 --height 8 --iterations 20'
command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" fern --width 20 --height 8 --points 1000 --seed 42 --char "*"'
not command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" sierpinski --size 0'
git-count commits gte 15
git-clean
```

Verify the representative commands against the emitted plan before committing;
correct shell quoting while preserving the plan's documented argument values.

- [ ] **Step 5: Neutralize the existing smoke story**

Change only vendor-specific actor wording to `Coding-Agent`. Preserve the task,
message, stop condition, and acceptance criteria.

- [ ] **Step 6: Run static scenario checks and commit**

Run:

```bash
bun test test/scenario-fixture-language.test.ts test/scenario-pinning.test.ts test/scenario-manifest.test.ts
bun run quorum check scenarios/serf-builder-fractals --credentials-file test/fixtures/serf-campaign-credentials.yaml
git diff --check
```

Expected: all tests pass; Quorum prints `ok   serf-builder-fractals` and
`ok   credentials`.

Commit: `feat(scenarios): add Serf builder Fractals bake-off`

---

### Task 10: Verify the complete public implementation and document trusted acceptance

**Files:**

- Modify: `README.md`
- Modify: `docs/scenario-authoring.md`
- Test: relevant existing CLI/documentation checks

**Interfaces:**

- README documents the generic external campaign and comparison commands.
- Scenario-authoring guidance documents content-addressed baselines, public
  release review, and the existing dated `docs/experiments/` convention.
- No real candidate, preset version, key, raw artifact, or private conclusion
  appears in either document.

- [ ] **Step 1: Document the generic operator flow**

Document `--credentials-file`, batch snapshot location, labeled `quorum costs`,
and the rule that real campaign inputs and raw results stay outside Git. Use
only inert names such as `serf_example_a`; do not publish a candidate list or a
real preset id. State that campaign presets pin exactly one model and provider,
disable fallbacks, and contain no prompt or sampling overrides. The dedicated
campaign key must enforce the intended data policy, have no BYOK binding for a
shared-capacity campaign, and carry a campaign spend cap.

Document the generic sequence:

```bash
quorum run-all \
  --scenarios 00-quorum-smoke-hello-world \
  --coding-agents serf \
  --credentials-file /secure/campaign.yaml \
  --credentials serf_example_a \
  --jobs 1

quorum run-all \
  --scenarios serf-builder-fractals \
  --coding-agents serf \
  --credentials-file /secure/campaign.yaml \
  --credentials serf_example_a \
  --jobs 1
```

State that only smoke-pass candidates proceed, one cell means one attempt, no
automatic retry or repeat occurs, and only final `pass` cells are comparable.
Charged and estimated columns are Coding-Agent cost; existing
`--with-gauntlet` reporting remains separate harness overhead. Sanitized public
experiment notes record failures as well as wins.

- [ ] **Step 2: Run the full hermetic verification**

Run from the repository root:

```bash
bun run check
bun run quorum check
git diff --check
rg -n '/(Users|home)/[^/[:space:]]+|https?://([0-9]{1,3}\.){3}[0-9]{1,3}|[?&]r[u]n=[^&[:space:]]+|[A-Z0-9_]*API_[K]EY=' \
  docs/superpowers/specs/2026-07-10-serf-builder-bakeoff-design.md \
  docs/superpowers/plans/2026-07-10-serf-builder-bakeoff.md \
  scenarios/serf-builder-fractals \
  test/fixtures/serf-campaign-credentials.yaml
```

Expected: all three gates pass and the final `rg` prints nothing. Also inspect
every new public fixture plus the README/scenario-authoring diff manually. If
the scan finds a false positive, document it; do not disable the scan.

- [ ] **Step 3: Review against every design requirement**

Confirm explicitly:

- one cell per credential with no automatic repetition;
- immutable direct-run and batch snapshots;
- selected model and exactly one selected key;
- provider/model/preset/BYOK attestation for every generation;
- charged and estimated costs both visible with delta;
- quantization label and catalog date preserved;
- fail/indeterminate visible but unranked;
- missing metrics never rendered as zero;
- legacy unlabeled artifacts parse;
- no private identifiers or secret values entered Git.

- [ ] **Step 4: Commit documentation and hermetic completion**

Commit: `docs: explain Serf builder campaign workflow`

- [ ] **Step 5: Trusted live acceptance — do not automate in public CI**

On the trusted server, with a dedicated policy-enforced OpenRouter key and an
external candidate file:

1. Run one known-good hello-world cell with `--jobs 1`.
2. Inspect `verdict.json`, `trajectory.json`,
   `openrouter-generations.json`, `coding-agent-token-usage.json`, and
   `quorum costs <batch>`; verify model, provider, preset version, BYOK false,
   token/cache buckets, duration, charged cost, estimate, delta, and labels.
3. Run one Fractals cell with `--jobs 1`; require final `pass`, all deterministic
   checks, committed main-checkout delivery, and a complete comparison row.
4. Run two hello-world candidates with `--jobs 2`; verify distinct attribution
   and no cross-contaminated keys, generations, labels, or economics.
5. Only then run one sequential Fractals cell per smoke-passing candidate.

Record only release-reviewed, sanitized conclusions in a dated public
experiment log. Keep external YAML and raw run artifacts outside Git.

## Spec Coverage

- Scenario package, frozen artifact pair, deterministic checks, and
  content-addressed baseline: Tasks 8–9.
- External strict credentials, optional labels, default behavior, and immutable
  direct/batch snapshots: Tasks 1–2.
- Selected Serf model, api-key validation, and exactly-one-key clean launcher:
  Task 3.
- OpenRouter preset intent, generation route proof, BYOK/provider/model/preset
  enforcement, content-free storage, and charged cost: Tasks 5–6 and Task 10
  operator guidance.
- Label propagation, three-valued verdict preservation, pass-only comparison,
  quantization, cache effectiveness, charged/estimated delta, and legacy
  artifact tolerance: Tasks 4, 6, and 7.
- Agent-neutral smoke, sequential baseline, parallel contention smoke, strict
  one-attempt policy, and full trusted acceptance sequence: Tasks 9–10.
- Public-repository confidentiality, secret handling, negative-result logging,
  and exclusion of live paid runs from CI: global constraints plus Tasks 1–3,
  5–6, 9, and 10.
