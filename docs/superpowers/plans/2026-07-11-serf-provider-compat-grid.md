# Serf Provider Compatibility Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry an allowlisted Serf tool-choice compatibility setting from an external campaign credential into an isolated per-run provider config, then run a strictly pinned hello grid with attested economics.

**Architecture:** Extend the existing closed credential `compat` object, and let `SerfAgent.provision` materialize a credential-free `providers.toml` only for the exact Serf/OpenRouter campaign profile. Keep launcher isolation unchanged. Pin the appliance to the Serf commit that restores streamed response IDs before the paid grid.

**Tech Stack:** TypeScript, Bun test, Zod, TOML text generation, Bash launcher/scenario fixtures, Docker.

## Global Constraints

- The public repository must contain no API key value, private hostname, private product name, prompt/response content, preset payload, or private campaign file.
- Every preset pins exactly one provider with `allow_fallbacks: false`.
- A strict cell passes only with deterministic hello completion and route, token, cache, cost, and timing evidence.
- Existing credentials without `compat.tool_choice_auto_only` preserve current behavior.
- The launcher keeps `env -i` and forwards only the selected API key.

---

### Task 1: Materialize Serf model compatibility from campaign credentials

**Files:**
- Modify: `src/contracts/credential.ts`
- Modify: `src/agents/serf.ts`
- Modify: `coding-agents/serf-context/launch-agent`
- Test: `test/credential-schema.test.ts`
- Test: `test/agent-serf.test.ts`

**Interfaces:**
- Consumes: `Credential.compat`, `isSerfOpenRouterCampaignCredentialV1(credential)`, and `RunHome.configDir`.
- Produces: optional `compat.tool_choice_auto_only: boolean` and `<configDir>/providers.toml` with no secret value.

- [ ] **Step 1: Write the failing schema test**

Add assertions that the closed schema accepts a boolean and rejects a string:

```ts
expect(
  CredentialSchema.parse({
    model: 'openrouter/@preset/example-version',
    harnesses: ['serf'],
    compat: { tool_choice_auto_only: true },
  }).compat.tool_choice_auto_only,
).toBe(true);
expect(() =>
  CredentialSchema.parse({
    model: 'openrouter/@preset/example-version',
    harnesses: ['serf'],
    compat: { tool_choice_auto_only: 'yes' },
  }),
).toThrow();
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `bun test test/credential-schema.test.ts`

Expected: FAIL because `tool_choice_auto_only` is rejected as an unknown key.

- [ ] **Step 3: Add the closed boolean field**

Add this property to `CompatSchema`:

```ts
tool_choice_auto_only: z.boolean().optional(),
```

- [ ] **Step 4: Run the schema test and verify GREEN**

Run: `bun test test/credential-schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing Serf provisioning tests**

Create a complete labeled campaign credential with
`compat: { tool_choice_auto_only: true }`. Provision it with a throwaway
`OPENROUTER_API_KEY`, then assert:

```ts
const configPath = join(home.configDir, 'providers.toml');
expect(readFileSync(configPath, 'utf8')).toBe(
  'default = "openrouter"\n\n' +
    '[instances.openrouter]\n' +
    'type = "openrouter"\n' +
    'api_key = "$OPENROUTER_API_KEY"\n\n' +
    '[instances.openrouter.models."@preset/serf-test".compat]\n' +
    'tool_choice_auto_only = true\n',
);
expect(statSync(configPath).mode & 0o777).toBe(0o600);
expect(readFileSync(configPath, 'utf8')).not.toContain(apiKey);
```

Also assert that an otherwise valid credential with empty `compat` leaves the
file absent, and that setting the field on a non-campaign Serf credential throws
`ProvisionError`.

- [ ] **Step 6: Run the Serf agent test and verify RED**

Run: `bun test test/agent-serf.test.ts`

Expected: FAIL because provisioning does not write `providers.toml`.

- [ ] **Step 7: Implement the minimal provider-config materialization**

In `SerfAgent.provision`, after credential/key validation:

```ts
if (credential.compat.tool_choice_auto_only === true) {
  if (!isSerfOpenRouterCampaignCredentialV1(credential)) {
    throw new ProvisionError(
      'serf: compat.tool_choice_auto_only requires the Serf OpenRouter campaign profile',
    );
  }
  const wireModel = credential.model.slice('openrouter/'.length);
  const body =
    'default = "openrouter"\n\n' +
    '[instances.openrouter]\n' +
    'type = "openrouter"\n' +
    'api_key = "$OPENROUTER_API_KEY"\n\n' +
    `[instances.openrouter.models."${wireModel}".compat]\n` +
    'tool_choice_auto_only = true\n';
  writeFileSync(join(home.configDir, 'providers.toml'), body, { mode: 0o600 });
}
```

Import `writeFileSync` and `isSerfOpenRouterCampaignCredentialV1`. Update the
launcher comment to say the per-run config may be provisioned; do not change the
launcher command.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `bun test test/credential-schema.test.ts test/agent-serf.test.ts test/runner-context.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 9: Commit**

```bash
git add src/contracts/credential.ts src/agents/serf.ts coding-agents/serf-context/launch-agent test/credential-schema.test.ts test/agent-serf.test.ts
git commit -m "feat(serf): materialize campaign model compat"
```

### Task 2: Enforce one Coding-Agent invocation in the hello smoke

**Files:**
- Modify: `scenarios/00-quorum-smoke-hello-world/story.md`
- Test: `test/scenario-fixture-language.test.ts`

**Interfaces:**
- Consumes: Gauntlet's public scenario instructions.
- Produces: one Serf invocation per grid cell, with no evaluator retry.

- [ ] **Step 1: Write the failing story-contract test**

Extend the existing hello-story test:

```ts
expect(story).toContain('Invoke the Coding-Agent exactly once.');
expect(story).toContain('Do not retry the Coding-Agent if it fails.');
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test test/scenario-fixture-language.test.ts`

Expected: FAIL because the story lacks the exact one-attempt contract.

- [ ] **Step 3: Add the explicit one-attempt instruction**

Add before the acceptance criteria:

```markdown
Invoke the Coding-Agent exactly once. Do not retry the Coding-Agent if it
fails; report the first attempt's outcome.
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun test test/scenario-fixture-language.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scenarios/00-quorum-smoke-hello-world/story.md test/scenario-fixture-language.test.ts
git commit -m "test(smoke): require one coding-agent attempt"
```

### Task 3: Pin the repaired Serf build and verify the appliance

**Files:**
- Modify: `container/Dockerfile`
- Test: `test/container-dockerfile.test.ts`
- Private runtime only: external campaign YAML and OpenRouter preset versions

**Interfaces:**
- Consumes: the pushed Serf commit produced by the streamed-response-ID plan.
- Produces: an immutable appliance image containing that exact Serf source revision.

- [ ] **Step 1: Record the exact Serf commit**

Run: `git -C /Users/drewritter/prime-rad/serf rev-parse HEAD`

Expected: a 40-character commit that is present on `origin/main`.

- [ ] **Step 2: Update the failing container contract first**

Replace the old expected `ARG SERF_REF=<sha>` string in
`test/container-dockerfile.test.ts` with the exact commit from Step 1.

- [ ] **Step 3: Run the container test and verify RED**

Run: `bun test test/container-dockerfile.test.ts`

Expected: FAIL because `container/Dockerfile` still pins the prior commit.

- [ ] **Step 4: Update the Dockerfile pin**

Replace only the `ARG SERF_REF` value with the same exact commit.

- [ ] **Step 5: Run focused and full local verification**

Run:

```bash
bun test test/container-dockerfile.test.ts test/credential-schema.test.ts test/agent-serf.test.ts test/runner-context.test.ts test/scenario-fixture-language.test.ts
bun test
bun run --cwd packages/dashboard test
git diff --check
```

Expected: all tests pass; only the repository's documented existing skip may remain.

- [ ] **Step 6: Commit and push the evals changes**

```bash
git add container/Dockerfile test/container-dockerfile.test.ts
git commit -m "build(serf): pin streamed response ID fix"
git push origin main
```

- [ ] **Step 7: Update private provider policy**

Update the MiniMax preset to exactly:

```json
{"model":"minimax/minimax-m3","provider":{"order":["parasail"],"allow_fallbacks":false}}
```

Update the private campaign label to provider `parasail`, quantization `fp8`,
and the new designated preset version. Add
`compat.tool_choice_auto_only: true` only to the Kimi credential. Keep the file
mode `0600` and run `quorum check` before any paid launch.

- [ ] **Step 8: Prepare and verify the appliance**

Use the managed appliance helper to build/pull the intended evals ref and
reconcile the long-lived container. Verify the reported harness SHA, Serf source
SHA, Serf binary digest, and `quorum check` output before launching models.

- [ ] **Step 9: Run the strict hello grid**

Launch one serial batch with `--jobs 1`, four explicit credentials, and one
scenario. Do not start Fractals unless all four cells are final `pass` with
complete route/economics evidence.

- [ ] **Step 10: Report and ticket handoff**

Report each cell's final verdict, effective provider/model, quantization label,
wall time, LLM time, token/cache counters, and cost. Preserve failed or
indeterminate artifacts for diagnosis. Move PRI-2425 to In Review only after the
strict grid is complete and add the required reflective comment.
