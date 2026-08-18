# F13 Filesystem Credential Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the filesystem half of F13 — the container's shared credential env file and OAuth mounts are readable under the agent's UID — by scoping the appliance container's mounts and env file to the credential scope of the job it serves, so an agent under test can reach only its own credential material by filesystem.

**Architecture:** Compute a **credential scope** per job (the union of the api_key_env names and OAuth mounts its agents' credentials require), write a subsetted credentials env file, and mount only the scoped OAuth dirs. The appliance already recreates the container when the mount signature changes (`containerMountSignature`, `reconcileContainer`), so scoping rides the existing recreate path. Unscoped behavior stays the default outside job flow; a scoped container refuses to serve a wider job (fail-closed).

**Tech Stack:** TypeScript on Bun ≥1.3, zod contracts, `bun test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` — "Order of operations", fix-now item 1, bullet 1 (lines 618–624). Sibling plan (env half, same bullet): `docs/superpowers/plans/2026-08-18-f13-env-credential-scoping.md`.

## Global Constraints

- Bun ≥ 1.3; `bun run check` (biome + tsc + bun test) must be green at every commit.
- All tests hermetic: `bun test` only — no Docker, no live appliance, no network. Container-level verification of the real mounts is a documented manual step (Task 4), not a test.
- Repo rule: never weaken an existing test; test output must be pristine.
- Commit after every task; conventional-commit style (`feat:`, `fix:`, `test:`, `docs:`).
- **Fail closed:** a scoped container that cannot determine a job's scope — or is asked to serve a job wider than its scope — must refuse, never silently serve with the wrong credentials visible.
- **The subsetted env file is secret material:** written mode 0600 via the existing `writePrivateText` (`src/appliance/fs.ts:47-73`), under `state/` (never under the results root or any run dir).
- Spec text binding this plan, verbatim (`2026-08-17-quorum-campaign-platform-design.md:618–624`):
  > - Per-agent env **and filesystem** credential scoping (F13, 2026-08-12 adversarial review: 6/12 launchers inherit host env; the Gauntlet subprocess env carries the full provider bundle; the container's credential env file and OAuth mounts are readable under the agent's UID). Done when a per-agent black-box test proves the agent reaches only its own credential, by env and by filesystem.

## Recon facts this plan is built on (verified against source)

1. **The mounts:** `scripts/evals-container:393-407` bind-mounts `--env-file` read-only at `/run/evals/credentials.env` and each `--auth name=<dir>` read-only at `/auth/<name>`; the container runs as the host UID (`:416`), so read-only mounts are still fully READABLE by the agent under test. `container/bin/quorum:8-13` sources the whole env file into the quorum process env; `:17-33` exports per-mount `*_OAUTH_HOME` vars conditionally on the mount's presence (so a subset just works — no shim change needed).
2. **The appliance mounts the whole blessed bundle for every job:** `baseContainerArgs` (`src/appliance/container.ts:70-84`) passes the full `credentials.env` + every discovered auth dir (`discoveredAuthDirs`, `:63-68`; `AUTH_DIRS` at `:21-29` maps mount names to bundle subdirs: codex→codex, gemini→gemini, kimi→kimi-code, pi→pi).
3. **The recreate path exists:** `containerMountSignature` (`container.ts:115-119+`) is recorded in preflight provenance (`preflight.ts:265`); `reconcileContainer` (`container.ts:192+`) recreates on drift (`container_recreate_required`, `errors.ts:12`). Preflight calls reconcile per job (`preflight.ts:233`).
4. **The job's scope is known at submission:** `cli.ts:251-264` requires and parses `--coding-agents` for run-all; `--credential`/`--credentials` and each agent's `default_credential` (e.g. `coding-agents/codex.yaml:14`) resolve via `resolveCredentialNameForAgent` (`src/credentials/resolve.ts`).
5. **Credential entries carry the needed fields:** `credentials.yaml` entries have `api_key_env` (e.g. `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`) and optional `auth:` (values in the registry: `oauth`, `subscription`, `bedrock-bearer`, `api-key`).
6. **Agent → OAuth mount map** (from the adapters' credential-copy code): codex→`codex` (`codex.ts:191-242`), gemini→`gemini` (`gemini.ts:40-44,143-160`), antigravity→`gemini` (`antigravity.ts:60-113`), kimi→`kimi` (`kimi.ts:410-467`), pi→`pi` (`pi.ts:169-214`). claude, opencode, serf, copilot, hermes → no bundle OAuth mount (their credentials arrive via env-file keys or host-tool auth).
7. **Exec-path mounts are inert:** `evals-container exec` is a plain `docker exec` (`scripts/evals-container:465-470`) — mounts are fixed at `up` time. The scope must therefore be applied at container bring-up (`up`/reconcile), with exec-time mismatch detection as the fail-closed backstop.
8. **Multi-agent batches** get the UNION of their cells' scopes — still a real reduction (a claude+codex batch mounts no gemini/kimi/pi OAuth homes) — and consecutive mixed batches may recreate the container as the signature changes. Accepted trade-off, recorded here so reviewers don't flag it.

## File Structure

- `src/credentials/scope.ts` — NEW: `CredentialScope` + `credentialScopeForAgents` (Task 1).
- `src/appliance/credential-scope.ts` — NEW: `writeScopedCredentialsEnv` + `scopedContainerArgs` (Task 2).
- `src/appliance/container.ts` — MODIFY: optional scope params on `baseContainerArgs` / `upContainerArgs` / `execContainerArgs`; signature includes the scope (Task 2).
- `src/appliance/cli.ts` — MODIFY: compute the scope at `run`/`run-all` submission, thread it into preflight (Task 3).
- `src/appliance/preflight.ts` — MODIFY: accept + apply the scope; fail-closed mismatch check (Task 3).
- `test/credential-scope.test.ts` — NEW (Task 1). `test/appliance-container.test.ts` — MODIFY or create (Task 2). Preflight wiring test wherever preflight is covered today (Task 3 — locate with `grep -l preflight test/`).
- `docs/appliance-runbook.md` — MODIFY (Task 4).

---

### Task 1: Credential scope resolution

**Files:**
- Create: `src/credentials/scope.ts`
- Test: `test/credential-scope.test.ts`

**Interfaces:**
- Consumes: `resolveCredentialNameForAgent` (`src/credentials/resolve.ts`), the credential registry loader (`src/credentials/index.ts`), `CredentialSchema` fields (`src/contracts/credential.ts`: `api_key_env`, `auth`).
- Produces (Tasks 2–3 rely on these exact shapes):
  - `CredentialScope = { readonly envNames: readonly string[]; readonly authMounts: readonly string[] }` — both sorted, deduped; empty = unconscoped (see semantics below).
  - `credentialScopeForAgents(agents: readonly string[], credentials: readonly string[] | null): CredentialScope` — `credentials` null = each agent's default credential. Throws a plain `Error` naming the agent/credential on an unknown name. **Empty-agents → `{ envNames: [], authMounts: [] }` (means "unscoped"; the container layer treats empty as the legacy full bundle — the fail-closed rule applies only when a scope is asserted).**
  - `AGENT_OAUTH_MOUNT: Readonly<Record<string, string>>` — `{ codex: 'codex', gemini: 'gemini', antigravity: 'gemini', kimi: 'kimi', pi: 'pi' }`.

Semantics: `envNames` = the union of `api_key_env` for every selected credential (regardless of auth type — it names the env var the credential needs when present). `authMounts` = the union of `AGENT_OAUTH_MOUNT[agent]` over agents whose selected credential's `auth` contains `oauth` or `subscription` AND the agent has a map entry.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/credential-scope.test.ts
import { expect, test } from 'bun:test';
import { AGENT_OAUTH_MOUNT, credentialScopeForAgents } from '../src/credentials/scope.ts';

test('single agent, api-key credential → env name only, no mounts', () => {
  // codex with an api-key credential (openai_responses_* family per credentials.yaml)
  const scope = credentialScopeForAgents(['codex'], ['openai_responses_56sol']);
  expect(scope.envNames).toEqual(['OPENAI_API_KEY']);
  expect(scope.authMounts).toEqual([]);
});

test('single agent, subscription credential → its OAuth mount only', () => {
  const scope = credentialScopeForAgents(['codex'], ['codex_sub']);
  expect(scope.authMounts).toEqual(['codex']);
});

test('antigravity maps to the gemini mount; kimi/pi to their own', () => {
  expect(AGENT_OAUTH_MOUNT['antigravity']).toBe('gemini');
  expect(AGENT_OAUTH_MOUNT['kimi']).toBe('kimi');
  expect(AGENT_OAUTH_MOUNT['pi']).toBe('pi');
});

test('multi-agent batch unions and dedupes; claude contributes no mount', () => {
  const scope = credentialScopeForAgents(['claude', 'codex'], null); // default credentials
  expect(scope.authMounts).toEqual(['codex']); // claude has none; sorted+deduped
  expect(scope.envNames.length).toBeGreaterThan(0);
  expect(new Set(scope.envNames).size).toBe(scope.envNames.length);
});

test('empty agent list means unscoped', () => {
  expect(credentialScopeForAgents([], null)).toEqual({ envNames: [], authMounts: [] });
});

test('unknown agent or credential throws a named error', () => {
  expect(() => credentialScopeForAgents(['nosuchagent'], null)).toThrow(/nosuchagent/);
  expect(() => credentialScopeForAgents(['codex'], ['nosuchcred'])).toThrow(/nosuchcred/);
});
```

(Adjust the concrete credential names above to the real registry entries the implementation reads — the assertions on semantics must stand. If `codex_sub`'s `auth` is `subscription`, the second test stands as written; verify against `credentials.yaml` and say what you verified in the report.)

- [ ] **Step 2: Run to verify failure** — `bun test test/credential-scope.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/credentials/scope.ts`**

```typescript
// src/credentials/scope.ts
// Per-job credential scoping (F13 filesystem half): which env-var names and
// bundle OAuth mounts does a job's agent/credential set actually need? The
// appliance container mounts only these, so the agent under test can reach
// only its own credential material by filesystem. Empty scope = unscoped
// (legacy full-bundle behavior); the container layer fails closed only when
// a scope is asserted.
import { loadCredentials } from './index.ts'; // verify the real export name
import { resolveCredentialNameForAgent } from './resolve.ts'; // verify signature

export const AGENT_OAUTH_MOUNT: Readonly<Record<string, string>> = {
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'gemini',
  kimi: 'kimi',
  pi: 'pi',
};

export interface CredentialScope {
  readonly envNames: readonly string[];
  readonly authMounts: readonly string[];
}

export function credentialScopeForAgents(
  agents: readonly string[],
  credentials: readonly string[] | null,
): CredentialScope {
  const envNames = new Set<string>();
  const authMounts = new Set<string>();
  const registry = loadCredentials(); // however src/credentials/index.ts exposes it
  for (const agent of agents) {
    const credName = resolveCredentialNameForAgent(agent, credentials); // per existing resolver semantics: explicit list or the agent's default_credential
    const entry = registry[credName];
    if (entry === undefined) {
      throw new Error(`credential scope: unknown credential ${credName} for agent ${agent}`);
    }
    if (entry.api_key_env !== undefined) envNames.add(entry.api_key_env);
    const auth = entry.auth ?? 'api-key';
    if ((auth.includes('oauth') || auth.includes('subscription')) && AGENT_OAUTH_MOUNT[agent] !== undefined) {
      authMounts.add(AGENT_OAUTH_MOUNT[agent]);
    }
  }
  return { envNames: [...envNames].sort(), authMounts: [...authMounts].sort() };
}
```

The resolver/loader call shapes above are sketches against the documented exports — read `src/credentials/resolve.ts` and `index.ts` and call them the way they actually work (including how `--credentials` csv interacts with per-agent resolution in `run-all` today; mirror that). Do not change their behavior.

- [ ] **Step 4: Run tests to verify they pass** — `bun test test/credential-scope.test.ts` → PASS.

- [ ] **Step 5: Full check and commit**

```bash
git add src/credentials/scope.ts test/credential-scope.test.ts
git commit -m "feat: per-job credential scope resolution (F13 filesystem)"
```

---

### Task 2: Scoped container args + the subsetted env file

**Files:**
- Create: `src/appliance/credential-scope.ts`
- Modify: `src/appliance/container.ts`
- Test: `test/appliance-container.test.ts` (create, or modify the existing file covering `baseContainerArgs` — locate with `grep -l baseContainerArgs test/`)

**Interfaces:**
- Consumes: `CredentialScope` (Task 1); `AUTH_DIRS`/`discoveredAuthDirs`/`baseContainerArgs` (`src/appliance/container.ts:21-84`); `writePrivateText` (`src/appliance/fs.ts:47-73`); `loaded.config.credential_bundle.path`, `loaded.config.root`.
- Produces:
  - `writeScopedCredentialsEnv(loaded: LoadedApplianceConfig, scope: CredentialScope): string` — reads `<bundle>/credentials.env`, keeps only `KEY=...` lines whose key is in `scope.envNames` (comments/blank lines dropped; unparseable lines dropped — they are not env assignments), writes mode-0600 via `writePrivateText` to `<root>/state/credentials-scoped/<sha256-of-sorted-envNames>.env` (idempotent: same scope, same path), returns the path.
  - `scopedContainerArgs(loaded, scope): string[]` — like `baseContainerArgs` but the `--env-file` is the scoped file and `--auth` only for `discoveredAuthDirs()` whose `name ∈ scope.authMounts`.
  - `baseContainerArgs(loaded, scope?: CredentialScope)` — optional param; absent or empty scope = exactly today's behavior (full bundle). `upContainerArgs` / `execContainerArgs` gain the same optional param and pass it through.
  - `containerMountSignature` — when a non-empty scope is supplied, the signature payload gains `{ credential_scope: { envNames, authMounts } }` so a scope change reads as drift and the existing reconcile path recreates the container.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/appliance-container.test.ts (or the existing covering file)
import { expect, test } from 'bun:test';
// reuse the loaded() fixture pattern from test/appliance-import.test.ts, plus a
// credentials.env fixture in a fake bundle dir:
//   OPENAI_API_KEY=sk-openai\nANTHROPIC_API_KEY=sk-anth\nGEMINI_API_KEY=sk-gem\n

test('writeScopedCredentialsEnv keeps only scoped keys, mode 0600, idempotent path', () => {
  const p1 = writeScopedCredentialsEnv(loaded, { envNames: ['OPENAI_API_KEY'], authMounts: [] });
  const body = readFileSync(p1, 'utf8');
  expect(body).toContain('OPENAI_API_KEY=sk-openai');
  expect(body).not.toContain('ANTHROPIC_API_KEY');
  expect(body).not.toContain('GEMINI_API_KEY');
  expect(statSync(p1).mode & 0o777).toBe(0o600);
  expect(writeScopedCredentialsEnv(loaded, { envNames: ['OPENAI_API_KEY'], authMounts: [] })).toBe(p1);
});

test('scopedContainerArgs mounts the scoped env file and only the scoped auth dirs', () => {
  const args = scopedContainerArgs(loaded, { envNames: ['OPENAI_API_KEY'], authMounts: ['codex'] });
  const envFileIdx = args.indexOf('--env-file');
  expect(args[envFileIdx + 1]).toContain('credentials-scoped');
  const authArgs = args.filter((_a, i) => args[i - 1] === '--auth');
  expect(authArgs).toEqual([expect.stringContaining('codex=')]);
});

test('absent or empty scope preserves the legacy full-bundle args byte-for-byte', () => {
  expect(baseContainerArgs(loaded)).toEqual(baseContainerArgs(loaded, { envNames: [], authMounts: [] }));
});

test('a non-empty scope changes the mount signature (recreate on scope change)', () => {
  expect(containerMountSignature(loaded, scopeA)).not.toBe(containerMountSignature(loaded, scopeB));
  expect(containerMountSignature(loaded, scopeA)).not.toBe(containerMountSignature(loaded)); // unscoped
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/appliance-container.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/appliance/credential-scope.ts`:

```typescript
// src/appliance/credential-scope.ts
// Applies a job's CredentialScope to the container surface: a subsetted
// credentials env file (0600, under state/, never the results root) and a
// reduced --auth mount set. Empty scope = legacy full-bundle behavior.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialScope } from '../credentials/scope.ts';
import { writePrivateText } from './fs.ts';
import type { LoadedApplianceConfig } from './types.ts';

export function writeScopedCredentialsEnv(
  loaded: LoadedApplianceConfig,
  scope: CredentialScope,
): string {
  const source = join(loaded.config.credential_bundle.path, 'credentials.env');
  const wanted = new Set(scope.envNames);
  const kept: string[] = [];
  for (const line of readFileSync(source, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match !== null && wanted.has(match[1] as string)) kept.push(line);
  }
  const key = createHash('sha256')
    .update(JSON.stringify([...scope.envNames].sort()))
    .digest('hex')
    .slice(0, 16);
  const dest = join(loaded.config.root, 'state', 'credentials-scoped', `${key}.env`);
  writePrivateText(dest, `${kept.join('\n')}\n`);
  return dest;
}
```

`src/appliance/container.ts` — add the optional `scope` param to `baseContainerArgs`/`upContainerArgs`/`execContainerArgs`/`containerMountSignature`; when `scope` is present AND non-empty, use `writeScopedCredentialsEnv` for the `--env-file` and filter `discoveredAuthDirs()` to `scope.authMounts`; when absent/empty, byte-identical behavior to today. (Circular-import note: `credential-scope.ts` imports nothing from `container.ts`, so `container.ts` importing `credential-scope.ts` is acyclic.)

- [ ] **Step 4: Run tests to verify they pass** — `bun test test/appliance-container.test.ts` → PASS; then the full appliance suite.

- [ ] **Step 5: Full check and commit**

```bash
git add src/appliance/credential-scope.ts src/appliance/container.ts test/appliance-container.test.ts
git commit -m "feat: scoped container mounts — subsetted credentials.env + selected OAuth dirs (F13)"
```

---

### Task 3: Job-flow wiring with fail-closed mismatch

**Files:**
- Modify: `src/appliance/cli.ts` (run/run-all submission, ~lines 238-270 and the `run` parser)
- Modify: `src/appliance/preflight.ts` (reconcile call at :233; provenance record at :261-267)
- Test: append to the preflight/CLI coverage located via `grep -l 'preflight\|run-all' test/ | head`

**Interfaces:**
- Consumes: `credentialScopeForAgents` (Task 1), scoped `container.ts` params (Task 2).
- Produces: `run`/`run-all` submission computes the scope from its parsed `--coding-agents` + `--credential`/`--credentials`, passes it into preflight's container calls, and records it in the job record (new optional field `credential_scope`, nullable; schema in `src/appliance/types.ts` — additive, defaults null = unscoped legacy). Preflight passes the scope to `reconcileContainer`/`upContainerArgs` and records `credential_scope` in the provenance container block alongside `mount_signature`. **Fail-closed:** when a job asserts a non-empty scope and the running container's identity shows a different scope, the job must NOT proceed against the mismatched container — reuse the existing `container_recreate_required` flow (reconcile on signature drift) rather than adding a new error path; if reconcile cannot converge, that existing error surfaces.

- [ ] **Step 1: Write the failing test** — in the located test file: a `run-all --coding-agents claude,codex` submission (fake actions / fake runner per that file's pattern) results in preflight receiving scope `{ authMounts: ['codex'], … }`; a submission with no resolvable scope fails before any container call. Write it against the file's existing harness.

- [ ] **Step 2: Run to verify failure** — FAIL (no scope threading).

- [ ] **Step 3: Implement** the wiring above. Keep the threading narrow: submission computes once; the job record carries it; preflight consumes it from the job (not re-parsed). `process.ts`'s `execContainerArgs` calls are mount-inert (docker exec) and need no changes — verify that claim and state the evidence in the report.

- [ ] **Step 4: Run tests to verify they pass, then `bun run check`** → green.

- [ ] **Step 5: Commit**

```bash
git add src/appliance/cli.ts src/appliance/preflight.ts src/appliance/types.ts test/
git commit -m "feat: appliance jobs mount only their credential scope (F13)"
```

---

### Task 4: Docs, manual verification, and the residual record

**Files:**
- Modify: `docs/appliance-runbook.md`

- [ ] **Step 1: Runbook section** — add to the security/credential material: jobs mount only their credential scope (`credentials.env` subsetted to the job's `api_key_env` names; only the scoped OAuth bundle dirs mounted); scope changes recreate the container via the existing signature/reconcile path; consecutive mixed-scope jobs may recreate more often (accepted trade-off); the scoped env files live mode-0600 under `state/credentials-scoped/` and are pruned with the bundle on rotation.

- [ ] **Step 2: Manual verification checklist** (to run at the next appliance job — paste into the runbook as an operator step):

```bash
# After the next appliance run-all with scope {codex}:
scripts/evals-container exec -- ls /auth            # expect: only codex
scripts/evals-container exec -- cat /run/evals/credentials.env   # expect: only the scoped key names
```

- [ ] **Step 3: The residual record** — add to the runbook: the gauntlet child's grader credential remains readable by a same-UID agent via `/proc/<pid>/environ` (env plan, Task 5 residual); full closure needs UID separation, deferred to the post-Phase-0 appliance decision. claude-windows guest-side isolation and the SSH-password-on-argv residual remain owned by the Windows trusted-maintainer path.

- [ ] **Step 4: Commit**

```bash
git add docs/appliance-runbook.md
git commit -m "docs: appliance credential scoping — operator contract, verification, residuals (F13)"
```

---

## Self-Review

**Spec coverage** (fix-now item 1, bullet 1 — the "by filesystem" half): "the container's credential env file and OAuth mounts are readable under the agent's UID" → Tasks 1–3 (scope resolution, subsetted env file + selected mounts, job wiring with recreate-on-scope-change); "Done when a per-agent black-box test proves the agent reaches only its own credential, by … filesystem" → the hermetic arg-construction/env-subset tests (Tasks 1–3) plus the in-container manual verification step (Task 4) — a fully automated in-container proof would require Docker in tests, which the hermetic constraint forbids; this is the honest split and is stated as such. The env half is the sibling plan; both together close the bullet.

**Placeholder scan:** Task 1's resolver/loader call shapes are marked as read-then-call-correctly (the exports exist per AGENTS.md's architecture notes; their exact signatures must be read — same accepted pattern as prior plans' harness steps); Task 3's test step targets the located preflight/CLI test file by grep. No TBDs; all implementation code blocks complete.

**Type consistency:** `CredentialScope` shape identical across Tasks 1–3; `AGENT_OAUTH_MOUNT` values are container mount names (matching `AUTH_DIRS` `name` field — kimi→`kimi`, NOT the bundle subdir `kimi-code`); `writeScopedCredentialsEnv(loaded, scope): string` and `scopedContainerArgs(loaded, scope): string[]` used consistently; optional-scope back-compat (absent/empty = legacy) asserted byte-for-byte in Task 2's tests.

**Deliberate scope exclusions (recorded so reviewers don't flag them):** no `evals-container` UX flags for direct local use (the appliance computes scopes; direct users can already pass explicit `--auth` flags); no UID separation (deferred to the post-Phase-0 appliance decision, recorded as the residual); no run-home credential retention policy (owned by the scrub-at-capture backlog item); no changes to `process.ts` exec probes (mount-inert per recon fact 7).
