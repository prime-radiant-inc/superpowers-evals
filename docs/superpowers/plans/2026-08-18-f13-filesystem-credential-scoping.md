# F13 Filesystem Credential Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the filesystem half of F13 — the container's shared credential env file and OAuth mounts are readable under the agent's UID — by scoping the appliance container's mounts and env file to the credential scope of the job it serves, so an agent under test can reach only its own credential material by filesystem.

**Architecture:** Compute a **credential scope** per job (the union of the environment names and OAuth mounts its runnable cells require). For an asserted scope, write an agent-only env file that is mounted read-only with only the selected OAuth dirs, plus a separate grader-only env file that remains on the host and is injected only into the live Quorum process through `docker exec --env-file`. The appliance's existing reconcile path recreates the container for every job; the mount signature records the asserted scope, omission alone preserves legacy direct-wrapper behavior, and a supplied empty scope means zero agent credential material.

**Tech Stack:** TypeScript on Bun ≥1.3, zod contracts, `bun test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` — "Order of operations", fix-now item 1, bullet 1 (lines 618–624). Sibling plan (env half, same bullet): `docs/superpowers/plans/2026-08-18-f13-env-credential-scoping.md`.

**Revision checkpoint (before Task 2):** Task 1's original implementation was task-reviewed at `034e980`; its unrelated gate-flake repair was reviewed at `dc6e89a`. This redline's end-to-end adapter trace found one pre-Task-2 correction still required for Claude/Copilot OAuth delivery, documented inside Task 1 below. That correction and Tasks 2–5 have not started. Nothing in this plan authorizes a push.

**Compatibility decision for Drew's review:** Task 4 intentionally keeps existing schema-version-1 appliance job/provenance records readable by defaulting a missing top-level `credential_scope` field to `null` during parsing. New records always persist the field explicitly. This is the smallest safe migration for already-landed appliance state; approving this plan explicitly approves that narrow backward-compatibility behavior.

## Global Constraints

- Bun ≥ 1.3; `bun run check` (biome + tsc + bun test) must be green at every commit.
- All tests hermetic: `bun test` only — no Docker, no live appliance, no network. Container-level verification of the real mounts is a documented manual step (Task 5), not a test.
- Repo rule: never weaken an existing test; test output must be pristine.
- Commit after every task; conventional-commit style (`feat:`, `fix:`, `test:`, `docs:`).
- **Fail closed:** a scoped container that cannot determine a job's scope — or is asked to serve a job wider than its scope — must refuse, never silently serve with the wrong credentials visible.
- **Both derived env files are secret material:** write them mode 0600 via `writePrivateText` under no-follow-validated `<root>/state/credentials-scoped/` (never under the results root or a run dir). The agent file may be mounted; the grader file must never be mounted.
- **No secret values in argv, logs, errors, hashes, or provenance.** The wrapper receives only the grader env-file path; Docker reads the values from that host file for the one exec process.
- **The grader contract is one shared exact list:** `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and optional routing value `ANTHROPIC_BASE_URL`. The runner and appliance projection must import the same constant; no duplicated frozen lists.
- Spec text binding this plan, verbatim (`2026-08-17-quorum-campaign-platform-design.md:618–624`):
  > - Per-agent env **and filesystem** credential scoping (F13, 2026-08-12 adversarial review: 6/12 launchers inherit host env; the Gauntlet subprocess env carries the full provider bundle; the container's credential env file and OAuth mounts are readable under the agent's UID). Done when a per-agent black-box test proves the agent reaches only its own credential, by env and by filesystem.

## Recon facts this plan is built on (verified against source)

1. **The mounts:** `scripts/evals-container:393-407` bind-mounts `--env-file` read-only at `/run/evals/credentials.env` and each `--auth name=<dir>` read-only at `/auth/<name>`; the container runs as the host UID (`:416`), so read-only mounts are still fully READABLE by the agent under test. `container/bin/quorum:8-13` sources that mounted agent file into the Quorum process; `:17-33` exports per-mount `*_OAUTH_HOME` vars conditionally on mount presence.
2. **The appliance mounts the whole blessed bundle for every job:** `baseContainerArgs` (`src/appliance/container.ts:70-84`) passes the full `credentials.env` + every discovered auth dir (`discoveredAuthDirs`, `:63-68`; `AUTH_DIRS` at `:21-29` maps mount names to bundle subdirs: codex→codex, gemini→gemini, kimi→kimi-code, pi→pi).
3. **The recreate path exists, but it is unconditional:** `containerMountSignature` (`container.ts:115-119+`) is recorded in preflight provenance; `reconcileContainer` downs any existing container and brings it up again. Scope must be applied to that up call. This plan does not invent an observed-signature comparator.
4. **The job's scope is known at submission:** `cli.ts:251-264` requires and parses `--coding-agents` for run-all, whose Quorum args may also carry `--credentials`; a single appliance `run` uses the named agent's `default_credential` (e.g. `coding-agents/codex.yaml:14`). Defaults resolve through `resolveCredentialNameForAgent` (`src/credentials/resolve.ts`).
5. **Credential entries carry the needed fields:** `credentials.yaml` entries have `api_key_env` (e.g. `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`) and optional `auth:` (values in the registry: `oauth`, `subscription`, `bedrock-bearer`, `api-key`).
6. **Agent → OAuth mount map** (from the adapters' credential-copy code): codex→`codex` (`codex.ts:191-242`), gemini→`gemini` (`gemini.ts:40-44,143-160`), antigravity→`gemini` (`antigravity.ts:60-113`), kimi→`kimi` (`kimi.ts:410-467`), pi→`pi` (`pi.ts:169-214`). claude, opencode, serf, copilot, hermes → no bundle OAuth mount (their credentials arrive via env-file keys or host-tool auth).
7. **Exec-path mounts are inert, but exec environments are process-local:** `evals-container exec` is currently plain `docker exec` (`scripts/evals-container:465-470`). Docker supports `docker exec --env-file`; those variables apply to the new exec process rather than changing container mounts or the container's configured environment. That is the grader channel. Only the actual live Quorum exec receives it; status, health, cancellation, and shell probes do not.
8. **Multi-agent batches** get the UNION of their cells' scopes — still a real reduction (a claude+codex batch mounts no gemini/kimi/pi OAuth homes) — and consecutive mixed batches may recreate the container as the signature changes. Accepted trade-off, recorded here so reviewers don't flag it.
9. **The grader credential cannot ride in the agent mount:** OAuth-only Coding-Agent jobs can legitimately have an empty agent env file, but Gauntlet still needs its Anthropic grader credential. Keeping the grader names in the mount would leave the filesystem leak open; omitting them entirely would strand Gauntlet. Split delivery is therefore required, not an optional hardening.
10. **The original Task 1 review missed two env-delivered OAuth paths:** `claude` with `opus5_sub` needs `CLAUDE_CODE_OAUTH_TOKEN` (`src/agents/index.ts:246-263`), and every Copilot OAuth credential needs the adapter's canonical `COPILOT_GITHUB_TOKEN` (`src/agents/copilot.ts:264-307`). Neither credential declares `api_key_env`, and neither family has an OAuth mount, so the current resolver returns asserted-empty and would strand both on the appliance. Every other current OAuth/subscription pair resolves to a mapped auth directory.

## File Structure

- `src/credentials/scope.ts` — EXISTING from Task 1: `CredentialScope` + `credentialScopeForAgents`; add env-delivered OAuth mapping before Task 2.
- `src/credentials/grader.ts` — NEW: the shared exact grader credential/routing name contract (Task 2).
- `src/runner/gauntlet-env.ts` — MODIFY: consume the shared grader-name constant instead of owning a duplicate list (Task 2).
- `src/appliance/credential-scope.ts` — NEW: isolated bundle evaluation plus mode-0600 agent/grader projections (Task 2).
- `src/appliance/container.ts` — MODIFY: asserted-scope up args, exec-only grader-file args, and scope-bearing signature (Task 3).
- `scripts/evals-container` — MODIFY: add `--no-default-auth` for asserted mount scopes and `--exec-env-file` for the one grader-bearing exec; never mount the grader file (Task 3).
- `src/appliance/types.ts`, `src/appliance/cli.ts`, `src/appliance/preflight.ts`, `src/appliance/process.ts` — MODIFY: persist the scope, recreate with it, and inject the grader file only into the live Quorum exec (Task 4).
- `test/credential-scope.test.ts` — Task 1 coverage. `test/appliance-credential-scope.test.ts` — NEW in Task 2. `test/appliance-container.test.ts` — NEW in Task 3. `test/evals-container.test.ts` — Task 3. Existing appliance CLI/preflight/process suites — Task 4.
- `docs/appliance-runbook.md` — MODIFY (Task 5).

---

### Task 1: Credential scope resolution — REVIEWED FOUNDATION; OAUTH CORRECTION REQUIRED

**Reviewed commits:** `ce3906e`, `d1efcc7`, `aa144c9`, `034e980`. Separate gate repair: `dc6e89a`. Task report: `.superpowers/sdd/2026-08-18-f13-filesystem-credential-scoping/task-1-report.md`.

**Corrective files:**
- Modify: `src/credentials/scope.ts`
- Test: `test/credential-scope.test.ts`

**Accepted interface (Tasks 2–4 consume this exact contract):**

```typescript
export interface CredentialScope {
  readonly envNames: readonly string[];
  readonly authMounts: readonly string[];
}

export function credentialScopeForAgents(
  agents: readonly string[],
  credentials: readonly string[] | null,
): CredentialScope;
```

- Both arrays are sorted and deduped. A supplied empty shape is asserted zero-material; only an omitted optional scope in later container APIs means legacy/unscoped.
- `credentials === null` resolves each agent's real default. An explicit list is validated using own-property lookups, then unions only agent/credential pairs runnable under the current harness-family matrix.
- API-key credentials use explicit `api_key_env` first, then the reviewed conventional adapter mapping; OAuth/subscription credentials add only their mapped OAuth source.
- Unknown names, prototype-property names, missing API-key mappings, and nonempty selections with zero compatible cells fail closed with named errors.

**Required corrective addendum (not started):** Add this frozen adapter contract:

```typescript
export const CONVENTIONAL_OAUTH_ENV: Readonly<Record<string, string>> = {
  claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  copilot: 'COPILOT_GITHUB_TOKEN',
};
```

For an OAuth/subscription pair, contribute its explicit `api_key_env`, mapped OAuth directory, and mapped conventional OAuth env name as applicable; if none of those three delivery channels exists, throw a named fail-closed error instead of returning zero material.

- [ ] Add RED tests proving `credentialScopeForAgents(['claude'], ['opus5_sub'])` returns only `CLAUDE_CODE_OAUTH_TOKEN`, Copilot default and every explicit Copilot credential return only `COPILOT_GITHUB_TOKEN`, and every current compatible OAuth/subscription pair has at least one delivery channel.
- [ ] Add an exact-map assertion for `CONVENTIONAL_OAUTH_ENV`. Do not edit the credential corpus or add injection hooks merely to reach the guard for a hypothetical future OAuth family; record that presently unreachable branch in the task receipt.
- [ ] Implement the two-name map and delivery-channel guard in `src/credentials/scope.ts`; run `bun test test/credential-scope.test.ts`, `bun run check`, and `bun run quorum check`.
- [ ] Commit only `src/credentials/scope.ts` and `test/credential-scope.test.ts` as `fix: include env-delivered OAuth credentials in job scope (F13)`, append the receipt to the Task 1 report, and obtain a scoped Sol re-review before Task 2 begins.

---

### Task 2: Derive agent-only and grader-only credential files

**Files:**
- Create: `src/credentials/grader.ts`
- Create: `src/appliance/credential-scope.ts`
- Modify: `src/runner/gauntlet-env.ts`
- Test: `test/appliance-credential-scope.test.ts`
- Test: `test/gauntlet-env.test.ts`

**Interfaces:**
- Consumes: Task 1 `CredentialScope`, the blessed `<bundle>/credentials.env`, `ensurePrivateDirNoFollow`, and `writePrivateText`.
- Produces:

```typescript
export const GRADER_CREDENTIAL_ENV_NAMES = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
] as const;

export interface ScopedCredentialFiles {
  readonly agentEnvFile: string;
  readonly graderExecEnvFile: string;
}

export function writeScopedCredentialFiles(
  loaded: LoadedApplianceConfig,
  scope: CredentialScope,
): ScopedCredentialFiles;
```

`GRADER_CREDENTIAL_ENV_NAMES` lives in `src/credentials/grader.ts`. `GAUNTLET_ENV_ALLOWLIST` imports and spreads it so runner and appliance cannot drift.

`writeScopedCredentialFiles` evaluates the trusted shell dotenv in an isolated `/bin/bash --noprofile --norc` child with a minimal non-secret environment, returning only requested names as NUL-delimited name/value pairs. It never prints values. This preserves the existing `source credentials.env` semantics—including quoted values—without passing unrelated host variables or reimplementing shell parsing.

The function then:

1. fails closed if any `scope.envNames` value is missing or empty;
2. fails closed unless at least one of the three grader auth names is nonempty (`ANTHROPIC_BASE_URL` alone is not auth);
3. rejects CR/LF in a grader value because Docker env files are line-oriented;
4. creates `<root>/state/credentials-scoped/` through `ensurePrivateDirNoFollow(loaded.config.root, target, 'state/credentials-scoped')` before either write;
5. writes `<hash-of-sorted-agent-names>.agent.env` as shell-single-quoted assignments for exactly `scope.envNames` (an asserted empty scope produces an empty file);
6. writes `grader.exec.env` in Docker `KEY=value` form for only defined `GRADER_CREDENTIAL_ENV_NAMES`;
7. uses `writePrivateText` for atomic mode-0600 files. Paths/hashes contain names only, never values.

- [ ] **Step 1: Write the failing behavior tests**

Use a fake blessed bundle containing plain, single-quoted, and double-quoted assignments. Add tests proving:

```typescript
test('agent file contains exactly scope.envNames and normalizes shell quoting', () => {
  const files = writeScopedCredentialFiles(loaded, {
    envNames: ['OPENAI_API_KEY'],
    authMounts: [],
  });
  expect(sourceEnvFile(files.agentEnvFile)).toEqual({
    OPENAI_API_KEY: 'agent value with spaces=#',
  });
  expect(readFileSync(files.agentEnvFile, 'utf8')).not.toContain('grader-secret');
  expect(statSync(files.agentEnvFile).mode & 0o777).toBe(0o600);
});

test('grader file contains only the shared grader contract', () => {
  const files = writeScopedCredentialFiles(loaded, {
    envNames: [],
    authMounts: ['codex'],
  });
  expect(parseDockerEnvFile(files.graderExecEnvFile)).toEqual({
    ANTHROPIC_API_KEY: 'grader value with spaces=#',
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
  });
  expect(readFileSync(files.agentEnvFile, 'utf8')).toBe('');
  expect(statSync(files.graderExecEnvFile).mode & 0o777).toBe(0o600);
});
```

Define `sourceEnvFile` as a test-only isolated Bash subprocess that sources the generated file and emits only the specifically requested test key as a NUL-delimited value. Define `parseDockerEnvFile` as a strict test-only parser that splits each nonempty line at its first `=`. Neither helper may dump the child environment or any non-test key.

Also cover: missing requested agent key; no grader auth; CR/LF grader rejection without echoing the value; deterministic paths; repeated writes; exact shared grader-name list; and a symlinked `state/credentials-scoped` directory rejected with external victim bytes/mode/mtime unchanged.

- [ ] **Step 2: Run RED**

```bash
bun test test/appliance-credential-scope.test.ts test/gauntlet-env.test.ts
```

Expected: module/export missing failures.

- [ ] **Step 3: Implement the shared contract and projections**

Use one private bundle-evaluation helper; do not expose a generic arbitrary-env API. The Bash child gets only the source path and the finite requested-name union. Parse its NUL output by pairs; any malformed output, nonzero status, missing file, or missing required name becomes `ApplianceError('config_invalid', 'credential-scope', ...)` naming keys/paths but never values.

- [ ] **Step 4: Run GREEN and the appliance suite**

```bash
bun test test/appliance-credential-scope.test.ts test/gauntlet-env.test.ts
bun test test/appliance-*.test.ts test/evals-container.test.ts
bun run check
bun run quorum check
```

- [ ] **Step 5: Commit**

```bash
git add src/credentials/grader.ts src/runner/gauntlet-env.ts \
  src/appliance/credential-scope.ts test/appliance-credential-scope.test.ts \
  test/gauntlet-env.test.ts
git commit -m "feat: derive separate agent and grader credential files (F13)"
```

---

### Task 3: Scoped container mounts and exec-only grader delivery

**Files:**
- Modify: `src/appliance/container.ts`
- Modify: `scripts/evals-container`
- Create: `test/appliance-container.test.ts`
- Test: `test/evals-container.test.ts`

**Interfaces:**
- Consumes: Task 1 `CredentialScope`; Task 2 `ScopedCredentialFiles`.
- Produces:

```typescript
export interface ScopedContainerMounts {
  readonly scope: CredentialScope;
  readonly agentEnvFile: string;
}

export function baseContainerArgs(
  loaded: LoadedApplianceConfig,
  scoped?: ScopedContainerMounts,
): string[];

export function upContainerArgs(
  loaded: LoadedApplianceConfig,
  scoped?: ScopedContainerMounts,
): string[];

export function execContainerArgs(
  loaded: LoadedApplianceConfig,
  command: readonly string[],
  options?: {
    readonly execEnvFile?: string;
  },
): string[];

export function containerMountSignature(
  loaded: LoadedApplianceConfig,
  scoped?: ScopedContainerMounts,
): string;
```

- Omitted `scoped` preserves today's direct/legacy full-bundle args byte-for-byte.
- Any supplied `scoped`, including a scope with empty arrays, uses `agentEnvFile`, emits `--no-default-auth`, and adds only `scope.authMounts`; it never falls back to the full bundle or the wrapper's host-home auth discovery. A requested mount with no corresponding blessed-bundle directory fails closed. Argument builders remain pure: Task 2/preflight creates the file before calling them.
- Signature payload includes `credential_scope: scoped?.scope ?? null` and the selected agent-file mount source, so omitted legacy and asserted empty differ without hashing secret values.
- New wrapper option: `--exec-env-file <host-file>`. It is valid only with `exec`, must be an existing readable regular file, and every existing path component must pass a no-follow check before physical normalization. It is never passed to `docker run` and is never a bind mount.
- New wrapper flag: `--no-default-auth`. It suppresses all `$HOME/.codex`, `$HOME/.gemini`, `$HOME/.kimi-code`, and `$HOME/.pi` fallback discovery while still accepting explicit `--auth name=dir` values. It is valid for `up` and inert-but-accepted on `exec`; scoped TypeScript args always include it. Omission preserves legacy discovery.
- On `exec`, the wrapper emits `docker exec --env-file "$exec_env_file" "$container_name" ...`. Without the option, existing exec behavior is byte-identical. `shell`, health, status, kill, and cancellation calls never receive it.

- [ ] **Step 1: Write the failing argument and real-wrapper tests**

Add structured assertions for:

```typescript
test('asserted empty scope mounts an empty agent file and no auth dirs', () => {
  const args = upContainerArgs(loaded, {
    scope: { envNames: [], authMounts: [] },
    agentEnvFile: join(loaded.config.root, 'state/credentials-scoped/empty.agent.env'),
  });
  const envFlag = args.indexOf('--env-file');
  expect(args[envFlag + 1]).toContain('credentials-scoped');
  expect(args).toContain('--no-default-auth');
  expect(args).not.toContain('--auth');
  expect(args).not.toContain(join(bundle, 'credentials.env'));
});

test('omitted scope keeps legacy args but differs in mount signature', () => {
  expect(baseContainerArgs(loaded)).toEqual([
    '--name',
    loaded.config.container.name,
    '--superpowers-root',
    loaded.config.superpowers.path,
    '--env-file',
    join(bundle, 'credentials.env'),
    ...expectedDiscoveredAuthArgs,
  ]);
  expect(containerMountSignature(loaded)).not.toBe(
    containerMountSignature(loaded, {
      scope: { envNames: [], authMounts: [] },
      agentEnvFile: join(loaded.config.root, 'state/credentials-scoped/empty.agent.env'),
    }),
  );
});
```

In the new test file, build `expectedDiscoveredAuthArgs` explicitly from the auth directories created by that fixture; do not derive the expected value by calling production `discoveredAuthDirs`.

Through the existing fake-Docker wrapper harness, prove:

1. `up` mounts the agent file and selected auth dirs, and its Docker argv contains no grader path;
2. asserted-empty `up` emits no auth mounts even when all four fallback auth directories exist under hostile `HOME`; selected scope mounts exactly its named blessed directories;
3. a requested auth mount missing from the blessed bundle fails before Docker;
4. scoped `exec` places `--env-file <grader-path>` after Docker's `exec` subcommand and before the container name;
5. the grader path never appears inside `--mount`, the container filesystem, or `docker run` args;
6. no secret value appears in the Docker argv log—only the file path;
7. `--exec-env-file` with `up`, `shell`, or a relative/missing/symlinked/unreadable file fails before Docker;
8. ordinary legacy exec and shell tests remain unchanged, including legacy auth auto-discovery.

- [ ] **Step 2: Run RED**

```bash
bun test test/appliance-container.test.ts test/evals-container.test.ts
```

Expected: missing scope parameters/flag behavior.

- [ ] **Step 3: Implement the wrapper and container arg contracts**

Keep mount selection and exec injection separate. In `baseContainerArgs`, map each asserted `authMounts` name through the existing `AUTH_DIRS` table, require its blessed source directory to exist, and emit `--no-default-auth` before the explicit `--auth` pairs. In the wrapper, guard all four fallback-discovery branches with `no_default_auth != true`. Do not pass the grader file to `baseContainerArgs` or `docker run`; only `execContainerArgs(..., { execEnvFile })` may emit `--exec-env-file`. Require that exec-env path to be absolute, then add a small lexical component walker: starting at `/`, reject `-L` at every existing component, and finally require a regular readable file. Do not use `realpath`/`readlink -f` to hide an alias before validation.

- [ ] **Step 4: Run GREEN and gates**

```bash
bun test test/appliance-container.test.ts test/evals-container.test.ts
bun test test/appliance-*.test.ts
bun run check
bun run quorum check
```

- [ ] **Step 5: Commit**

```bash
git add src/appliance/container.ts scripts/evals-container \
  test/appliance-container.test.ts test/evals-container.test.ts
git commit -m "feat: mount agent scope and inject grader only at exec (F13)"
```

---

### Task 4: Persist and apply scope through the appliance job flow

**Files:**
- Modify: `src/appliance/types.ts`
- Modify: `src/appliance/cli.ts`
- Modify: `src/appliance/preflight.ts`
- Modify: `src/appliance/process.ts`
- Modify: `src/appliance/provenance.ts`
- Test: `test/appliance-contracts.test.ts`
- Test: `test/appliance-cli.test.ts`
- Test: `test/appliance-preflight.test.ts`
- Test: `test/appliance-process.test.ts`

**Interfaces:**
- Consumes: Task 1 scope resolver, Task 2 file writer, Task 3 scoped up/exec args.
- Produces:
  - `CredentialScopeSchema` matching Task 1 exactly;
  - top-level `credential_scope: CredentialScopeSchema.nullable().default(null)` on schema-version-1 `JobRecordSchema` and `ProvenanceRecordSchema`, so old records parse as legacy while every newly written record persists the field explicitly;
  - nullable `job.credential_scope` (`null` only for legacy/import/prepare records; every new live `run`/`run-all` job writes a non-null asserted scope, including empty);
  - preflight's internal `credential_files: ScopedCredentialFiles | null` result;
  - `liveCommandArgs(..., { execEnvFile })` for the one credentialed live exec; all other `execContainerArgs` callers remain uncredentialed;
  - provenance/container evidence containing the asserted `credential_scope` and matching `mount_signature`—never paths or values.

- [ ] **Step 1: Write the failing contract and flow tests**

Cover all of these behaviors against existing fake action/runner seams:

1. `run` and `run-all` compute scope once from parsed agents/credentials and persist it in the job before worker spawn.
2. `run` resolves its agent default; `run-all` parses the single required `--coding-agents` value and optional single `--credentials` value, passing `null` when the latter is omitted. Duplicate `--credentials`, explicit incompatible selections, and unknown selections fail before job creation or any container command.
3. Copilot's default scope persists `COPILOT_GITHUB_TOKEN` with no auth mount; Claude's explicit `opus5_sub` scope persists `CLAUDE_CODE_OAUTH_TOKEN`. Neither may collapse to asserted-empty.
4. Preflight reads the job's stored scope, writes both files, and calls `reconcileContainer(loaded, runner, { scope, agentEnvFile })`; legacy null records keep the existing unscoped path.
5. The live job call uses `liveCommandArgs(..., { execEnvFile: graderExecEnvFile })` and produces `--exec-env-file`; cancellation, liveness, tool-version, and `quorum check` probes do not.
6. A scoped job with missing grader-file preparation fails before the live child spawns.
7. Provenance records names/mounts and signature only; it contains no secret file path or value.
8. A schema-version-1 job/provenance fixture with no `credential_scope` parses to `null`, while newly created prepare/import records persist `null` and live records persist the asserted object. No other missing or malformed field is relaxed.

Pin the core live command contract:

```typescript
const args = liveCommandArgs(loaded, 'job-1', ['quorum', 'run-all'], {
  execEnvFile: '/state/credentials-scoped/grader.exec.env',
});
expect(args).toContain('--exec-env-file');
expect(args).toContain('/state/credentials-scoped/grader.exec.env');

const probeArgs = execContainerArgs(loaded, ['quorum', 'check']);
expect(probeArgs).not.toContain('--exec-env-file');
```

For cancellation, drive the existing `cancelJob` fake-runner test and assert that none of its recorded wrapper calls contains `--exec-env-file`; do not add a test-only production export.

- [ ] **Step 2: Run RED**

```bash
bun test test/appliance-contracts.test.ts test/appliance-cli.test.ts \
  test/appliance-preflight.test.ts test/appliance-process.test.ts
```

Expected: missing schema/threading and live exec-env assertions.

- [ ] **Step 3: Implement narrow one-way threading**

Submission computes once; the record is authoritative afterward. Preflight prepares files and recreates the container with the stored scope. `runWorker` takes the grader path from its own successful preflight result and gives it only to the live Quorum exec. Do not reparse CLI strings, derive an observed mount identity, add a generic environment channel, or inject grader env into probes.

- [ ] **Step 4: Run GREEN and gates**

```bash
bun test test/appliance-contracts.test.ts test/appliance-cli.test.ts \
  test/appliance-preflight.test.ts test/appliance-process.test.ts
bun test test/appliance-*.test.ts test/evals-container.test.ts
bun run check
bun run quorum check
```

- [ ] **Step 5: Commit**

```bash
git add src/appliance/types.ts src/appliance/cli.ts \
  src/appliance/preflight.ts src/appliance/process.ts \
  src/appliance/provenance.ts test/appliance-contracts.test.ts \
  test/appliance-cli.test.ts test/appliance-preflight.test.ts \
  test/appliance-process.test.ts
git commit -m "feat: apply credential scope across appliance jobs (F13)"
```

---

### Task 5: Runbook, manual proof, and residuals

**Files:**
- Modify: `docs/appliance-runbook.md`

- [ ] **Step 1: Document the operator contract**

State that new appliance live jobs always assert a scope; `/run/evals/credentials.env` contains only the job's Coding-Agent keys; `/auth` contains only selected OAuth sources; the grader file remains mode 0600 under host appliance state and is injected only into the live Quorum exec; direct wrapper calls that omit scope remain explicitly legacy/unscoped.

- [ ] **Step 2: Add the no-value manual verification gate**

The checklist must not print secrets:

```bash
# On the configured appliance after a scoped Codex-subscription job:
appliance_config=${EVALS_APPLIANCE_CONFIG:-/srv/quorum/config/appliance.json}
container_name=$(bun -e \
  'const config = await Bun.file(process.argv[1]).json(); console.log(config.container.name)' \
  "$appliance_config")

docker exec "$container_name" sh -lc \
  'find /auth -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort'
# expect: codex only

docker exec "$container_name" sh -lc \
  'sed -n "s/=.*//p" /run/evals/credentials.env | sort'
# expect: no agent env names for the subscription-only cell

docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' \
  "$container_name" | sort
# expect: /run/evals/credentials.env and scoped /auth entries; no grader file
```

Then run one real scoped job through the appliance helper. A successful Gauntlet drive plus the mount inspection is the physical proof that grader auth arrived through exec while its file stayed off the container filesystem. Record the job ID, exact commit, bundle ID, observed key names/mount destinations, and result in the experiment log. Never print values.

- [ ] **Step 3: Record the honest residual**

The Quorum parent/run-all child now carries only the job's scoped Coding-Agent values plus the grader contract—not the full provider bundle. Because Coding-Agent and Quorum still share a UID, the Coding-Agent can inspect those parent/grader values through `/proc/<pid>/environ`; UID separation remains required for full process-boundary closure. Run-home retention remains separate, and claude-windows password/guest isolation remains owned by the Windows trusted-maintainer path.

- [ ] **Step 4: Run docs/static gates and commit**

```bash
bun run check
bun run quorum check
git add docs/appliance-runbook.md
git commit -m "docs: verify appliance credential scope without exposing values (F13)"
```

---

## Self-Review

**Spec coverage:** Task 1 resolves the exact per-job scope. Task 2 creates two disjoint filesystem artifacts and one shared grader-name contract. Task 3 ensures only the agent artifact and selected OAuth dirs become container mounts while the grader artifact is exec-only. Task 4 makes every live appliance job assert and apply that contract. Task 5 supplies the required real-container filesystem proof without printing values.

**Failure-mode coverage:** supplied-empty versus omitted scope; unknown/incompatible cells; missing agent key; missing grader auth; quoted bundle values; CR/LF rejection; symlinked secret directory; grader path accidentally mounted or passed to `docker run`; grader env accidentally injected into probes; scope/provenance disagreement; and no-value operator verification all have named tests or gates.

**Type consistency:** `CredentialScope` is unchanged from reviewed Task 1. `ScopedCredentialFiles` is created in Task 2, consumed by preflight in Task 4, and never persisted. `GRADER_CREDENTIAL_ENV_NAMES` is shared by runner and appliance. `credential_scope: null` means omitted legacy only; `{envNames:[], authMounts:[]}` means asserted zero-material everywhere.

**Placeholder scan:** every remaining task names exact files, interfaces, RED/GREEN commands, failure expectations, and commit boundaries. No dynamic test-file discovery, implementation placeholders, or invented observed-signature API remains.

**Deliberate exclusions:** no UID separation; no run-home retention policy; no automatic Docker test in `bun test`; no grader values in container metadata at `docker run`; no new generic env passthrough; no push. The manual Docker/appliance proof remains a required post-implementation gate before Drew considers publication.
