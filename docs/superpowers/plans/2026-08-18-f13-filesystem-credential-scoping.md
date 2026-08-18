# F13 Filesystem Credential Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Close the filesystem half of F13 for Phase 1 appliance jobs: one live job represents one Coding-Agent plus one resolved credential, and its container can read only that credential's exact env/file projection while the Gauntlet-Agent credential remains host-only until the live exec.

**Architecture:** Replace the former job-wide union with a single live credential selection, resolve that selection into a closed adapter-owned delivery contract, and project exact files or structured entries into one fixed active credential generation. Preflight first runs in an asserted-empty probe container, then recreates a scoped live container and returns an immutable container lease; live, liveness, and cancellation operations bind to that lease rather than the mutable container name.

**Tech Stack:** TypeScript on Bun >=1.3, zod contracts, Bash 3.2-compatible wrapper code, Docker CLI with docker exec --env-file support, bun test, biome. No new dependencies.

**Spec:** docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md, fix-now item 1, F13 lines 618-624. Sibling env plan: docs/superpowers/plans/2026-08-18-f13-env-credential-scoping.md.

**Approved architecture and compatibility rulings (Drew, 2026-08-18):**

1. Phase 1 appliance live jobs permit exactly one Coding-Agent and zero or one explicit credential. Omission selects that agent's default. Mixed-agent or multi-credential run-all requests are rejected until the execution layer supplies a separate container or mount namespace per cell.
2. Missing schema-version-1 scope fields remain readable by status, show, costs, and safe cancellation, but a live run/run-all record with a missing/null scope cannot resume or execute. It fails with a resubmit-required error. Prepare uses an explicit empty scope; import is non-executing and records null.
3. OAuth sources are projected by exact adapter-owned files or structured entries. Whole shared bundle directories are never mounted by scoped appliance jobs.
4. Submission records the source evals SHA and normalized selection. After fast-forward, any SHA drift fails before credential evaluation or Docker; when the SHA matches, preflight recomputes the scope and requires exact equality.
5. Grader credentials come from distinct QUORUM_GRADER_* bundle source names. The host-only supervisor exec file retains those aliases; gauntletEnvBase translates them to canonical runtime names only while constructing the Gauntlet child environment, so the Quorum parent can simultaneously retain the Coding-Agent's canonical credential. If any selected agent secret value equals any nonempty grader auth secret value, projection fails closed regardless of their environment-variable names instead of falsely claiming separation. Endpoint and network-routing values are not secret values for this comparison.

**Revision checkpoint:** Task 1's initial foundation is committed through 034e980; the unrelated focused-test timeout repair is dc6e89a. The 2026-08-18 five-seat adversarial review rejected plan-redline 1c0bd6f. This revision supersedes that plan text; Tasks 2-6 and the reopened Task 1 interface correction have not started. Nothing authorizes a push.

**Compatibility decision requiring Drew's approval before execution:** Trusted
local Quorum runs outside the appliance currently supply canonical grader
environment names directly. Preserve that supported path behind an explicit
source-mode branch: an absent mode uses the existing local canonical contract;
`QUORUM_GRADER_SOURCE_MODE=appliance-scoped` reads only the distinct appliance
aliases and never falls back to canonical values. This is not a null/optional
appliance scope path. Task 2 must not begin until Drew approves this narrowly
scoped compatibility behavior while reviewing the plan.

## Global Constraints

- Bun >=1.3; bun run check and bun run quorum check must pass at each task boundary.
- Hermetic automated tests only: no Docker daemon, network, live eval, or real credential access. Real Docker/appliance proof is Task 6 and occurs only after code review.
- Never print, serialize, persist, hash, or place secret values in paths, argv, logs, errors, job records, provenance, or experiment notes.
- Every credential source and destination path is validated component-by-component with no-follow lstat checks before reading, writing, activation, or mounting. Do not realpath an alias before validating it.
- Scoped credential state and the blessed bundle must be disjoint from every code/results source bind-mounted into the container.
- Scoped appliance container APIs require an asserted CredentialScope. Omission remains a direct-wrapper legacy mode only; no appliance preflight path may invoke it.
- Every appliance job recreates the container. No job inherits a previous job's mounts. Reconcile must down the old container before activating the next fixed credential generation.
- Probe commands run only in an asserted-empty container. Agent credentials and grader credentials are introduced only after probes pass.
- The live process, liveness probes, and cancellation target an immutable recorded container ID. A replacement under the configured name is never executed in or signalled.
- All new secret files are mode 0600 and directories mode 0700. One fixed active generation is swapped through recoverable directory renames under run.lock; historical scope files do not accumulate.
- The agent file is mounted read-only. The supervisor exec file is never mounted and is passed only as a host path to docker exec --env-file for the live Quorum process.
- The supervisor file carries the source names below. gauntletEnvBase alone maps them to the canonical runtime names in the Gauntlet child:
  - QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN -> CLAUDE_CODE_OAUTH_TOKEN
  - QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN -> ANTHROPIC_AUTH_TOKEN
  - QUORUM_GRADER_ANTHROPIC_API_KEY -> ANTHROPIC_API_KEY
  - QUORUM_GRADER_ANTHROPIC_BASE_URL -> ANTHROPIC_BASE_URL
- The same-UID process-inspection residual remains: filesystem isolation does not prevent /proc peer-environment inspection. This plan must not claim UID separation.

## Verified Process Facts

1. scripts/evals-container currently mounts the complete credentials.env and every discovered OAuth directory; read-only is still readable by the agent UID.
2. container/bin/quorum sources the mounted env file into every quorum subcommand and conditionally sets OAuth home variables, while the image can retain inherited OAuth-home variables unless the shim explicitly unsets absent mounts.
3. reconcileContainer currently downs and ups unconditionally. containerMountSignature is descriptive evidence, not a reconcile comparator.
4. credentialScopeForAgents currently returns a union and loses adapter/file identity. Gemini and Antigravity share the gemini bundle directory but consume disjoint files; Pi auth.json can carry multiple provider tokens.
5. A mixed run-all uses one container for the whole batch. A union therefore cannot satisfy the spec's per-agent isolation requirement.
6. Claude subscription requires CLAUDE_CODE_OAUTH_TOKEN; Copilot accepts COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN and canonicalizes to COPILOT_GITHUB_TOKEN. The current Task 1 resolver strands both.
7. Gemini's current GEMINI_AUTH_TYPE host env can override credential.auth. The scoped contract must derive the mode from the selected credential and reject a contradictory bundle override.
8. Submission executes from the current checkout; preflight then fast-forwards evals. A Bun process does not reload changed resolver code merely because files changed on disk.
9. docker exec --env-file is process-local, but support must be capability-probed on the target Docker CLI before credential material is evaluated.
10. Preflight probes currently run after the credential-bearing container is reconciled. This plan deliberately creates an empty probe container first and a scoped live container second.

## File Structure

- src/credentials/scope.ts: single-selection CredentialScope and closed adapter delivery contracts.
- src/credentials/grader.ts: distinct grader source-to-runtime mapping and supervisor operational-name contracts.
- src/agents/copilot.ts: Copilot Gauntlet projection composes the shared alias translation before its extra routing projection.
- src/appliance/credential-scope.ts: trusted bundle evaluation, exact OAuth projection, staging, activation, and retirement.
- src/appliance/container.ts: scoped up args, immutable ContainerLease, identity-bound exec, and reconcile ordering.
- src/appliance/safe-fs.ts: no-follow/disjoint path boundary helpers reused by credential state.
- scripts/evals-container: no-default-auth, expected-container-id, and exec-env-file wrapper behavior.
- container/bin/quorum: explicit absent-mount unsets before conditional OAuth-home exports.
- src/appliance/types.ts, jobs.ts, cli.ts, git.ts: atomic normalized selection/scope/source-SHA persistence.
- src/appliance/preflight.ts: scope freshness, empty probe container, live scoped container, private worker result.
- src/appliance/process.ts: lease-bound live/liveness/cancellation.
- src/appliance/provenance.ts and import.ts: job-authoritative live provenance and explicit null imported provenance.
- docs/appliance-runbook.md and docs/experiments/2026-08-18-f13-filesystem-credential-scoping.md: operator contract and physical proof.

---

### Task 1: Replace the union with one closed credential delivery contract

**Status:** Reopens the reviewed foundation. Preserve ce3906e, d1efcc7, aa144c9, 034e980, and dc6e89a; add one corrective commit.

**Files:**
- Modify: src/credentials/scope.ts
- Test: test/credential-scope.test.ts

**Interfaces:**

~~~typescript
export interface CredentialSelection {
  readonly agent: string;
  readonly credential: string | null;
}

export interface AgentEnvProjection {
  readonly destinationName: string;
  readonly sourceNames: readonly string[];
}

export type OAuthProjection =
  | { readonly kind: 'codex'; readonly mountName: 'codex' }
  | { readonly kind: 'gemini'; readonly mountName: 'gemini' }
  | { readonly kind: 'antigravity'; readonly mountName: 'gemini' }
  | { readonly kind: 'kimi'; readonly mountName: 'kimi' }
  | {
      readonly kind: 'pi';
      readonly mountName: 'pi';
      readonly provider: string;
    };

export interface EmptyCredentialScope {
  readonly schemaVersion: 1;
  readonly kind: 'empty';
  readonly agent: null;
  readonly runtimeFamily: null;
  readonly credential: null;
  readonly agentEnv: readonly [];
  readonly geminiAuthType: null;
  readonly oauth: null;
}

export interface LiveCredentialScope {
  readonly schemaVersion: 1;
  readonly kind: 'live';
  readonly agent: string;
  readonly runtimeFamily: string;
  readonly credential: string;
  readonly agentEnv: readonly AgentEnvProjection[];
  readonly geminiAuthType: 'gemini-api-key' | 'oauth-personal' | null;
  readonly oauth: OAuthProjection | null;
}

export type CredentialScope = EmptyCredentialScope | LiveCredentialScope;

export const EMPTY_CREDENTIAL_SCOPE: EmptyCredentialScope;

export function credentialScopeForSelection(
  evalsRoot: string,
  selection: CredentialSelection,
): LiveCredentialScope;
~~~

The schema later mirrors this discriminated union exactly. Persisted OAuth kinds are literals, never record-controlled source paths.

Binding adapter contracts:

| Agent/family and auth | Agent env projection | OAuth projection |
|---|---|---|
| API-key credential | explicit api_key_env, else reviewed conventional family destination; source is the same name | none |
| Claude OAuth | CLAUDE_CODE_OAUTH_TOKEN from the same source name | none |
| Copilot OAuth | destination COPILOT_GITHUB_TOKEN from ordered sources COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN | none |
| Codex subscription | none | codex |
| Gemini API key | GEMINI_API_KEY | none; geminiAuthType=gemini-api-key |
| Gemini OAuth | none | gemini; geminiAuthType=oauth-personal |
| Antigravity OAuth | none | antigravity |
| Kimi OAuth | none | kimi |
| Pi OAuth | none | pi with credential.provider |

Any missing default, incompatible pair, missing Pi provider, unsupported auth form, or pair without an audited delivery channel fails with a named credential-scope error.

- [ ] **Step 1: Replace the stale tests and write RED coverage**

Replace the existing "copilot default is a valid zero-material default scope" assertion; it freezes the bug. Add table-driven tests for every current compatible agent/credential pair and exact tests for:

~~~typescript
expect(
  credentialScopeForSelection(root, {
    agent: 'copilot',
    credential: 'copilot_default',
  }).agentEnv,
).toEqual([
  {
    destinationName: 'COPILOT_GITHUB_TOKEN',
    sourceNames: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
]);

expect(
  credentialScopeForSelection(root, {
    agent: 'claude',
    credential: 'opus5_sub',
  }).agentEnv,
).toEqual([
  {
    destinationName: 'CLAUDE_CODE_OAUTH_TOKEN',
    sourceNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
  },
]);
~~~

Also assert exact Codex, Gemini, Antigravity, Kimi, and Pi OAuth kinds; Gemini mode derived from credential.auth; default resolution persists the concrete credential name; and prototype-property names retain named errors.

- [ ] **Step 2: Run RED**

Run: bun test test/credential-scope.test.ts

Expected: old union interface and zero-material Copilot behavior fail.

- [ ] **Step 3: Implement the minimal closed resolver**

Remove credentialScopeForAgents, AGENT_OAUTH_MOUNT, and the array union behavior. Keep own-property lookup. Resolve exactly one selection from evalsRoot/coding-agents and evalsRoot/credentials.yaml. For Gemini, ignore ambient GEMINI_AUTH_TYPE and derive the mode from credential.auth. Do not add compatibility wrappers for the deleted API.

- [ ] **Step 4: Run GREEN and gates**

Run:

~~~bash
bun test test/credential-scope.test.ts
bun run check
bun run quorum check
~~~

- [ ] **Step 5: Commit and review**

~~~bash
git add src/credentials/scope.ts test/credential-scope.test.ts
git commit -m "fix: resolve one exact appliance credential scope (F13)"
~~~

Append the receipt to task-1-report.md and obtain a scoped Sol review before Task 2.

---

### Task 2: Stage one exact active credential generation

**Files:**
- Create: src/credentials/grader.ts
- Create: src/appliance/credential-scope.ts
- Modify: src/appliance/safe-fs.ts
- Modify: src/runner/gauntlet-env.ts
- Modify: src/agents/copilot.ts
- Test: test/appliance-credential-scope.test.ts
- Test: test/appliance-safe-fs.test.ts
- Test: test/gauntlet-env.test.ts
- Test: test/agent-copilot.test.ts

**Interfaces:**

~~~typescript
export const GRADER_SOURCE_ENV_BY_RUNTIME_NAME = {
  CLAUDE_CODE_OAUTH_TOKEN: 'QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN',
  ANTHROPIC_AUTH_TOKEN: 'QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN',
  ANTHROPIC_API_KEY: 'QUORUM_GRADER_ANTHROPIC_API_KEY',
  ANTHROPIC_BASE_URL: 'QUORUM_GRADER_ANTHROPIC_BASE_URL',
} as const;

export const QUORUM_GRADER_SOURCE_MODE = 'QUORUM_GRADER_SOURCE_MODE';
export const APPLIANCE_SCOPED_GRADER_MODE = 'appliance-scoped';

export const SUPERVISOR_NETWORK_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export const COPILOT_SUPERVISOR_ENV_NAMES = [
  'GH_HOST',
  'COPILOT_GH_HOST',
  'COPILOT_MODEL',
  'COPILOT_OFFLINE',
  'ALL_PROXY',
  'all_proxy',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

export interface ProjectedAuthMount {
  readonly name: 'codex' | 'gemini' | 'kimi' | 'pi';
  readonly path: string;
}

export interface StagedCredentialMaterial {
  readonly stageDir: string;
  readonly agentEnvFile: string;
  readonly supervisorExecEnvFile: string | null;
  readonly authMounts: readonly ProjectedAuthMount[];
}

export interface ActiveCredentialMaterial {
  readonly root: string;
  readonly agentEnvFile: string;
  readonly supervisorExecEnvFile: string | null;
  readonly authMounts: readonly ProjectedAuthMount[];
}

export function stageProbeCredentialMaterial(
  loaded: LoadedApplianceConfig,
): StagedCredentialMaterial;

export function stageLiveCredentialMaterial(
  loaded: LoadedApplianceConfig,
  scope: LiveCredentialScope,
): StagedCredentialMaterial;

export function activateScopedCredentialMaterial(
  loaded: LoadedApplianceConfig,
  staged: StagedCredentialMaterial,
): ActiveCredentialMaterial;

export function recoverScopedCredentialActivation(
  loaded: LoadedApplianceConfig,
): void;

export function retireScopedCredentialMaterial(
  loaded: LoadedApplianceConfig,
): void;

export function assertScopedCredentialStateBoundary(
  loaded: LoadedApplianceConfig,
): void;

export function assertCredentialBundleBoundary(
  loaded: LoadedApplianceConfig,
): void;
~~~

The active paths are fixed:

- state/credentials-scoped/active/agent.env
- state/credentials-scoped/active/supervisor.exec.env for live scopes only
- state/credentials-scoped/active/auth/<mount-name>/...

Stage beneath a fresh sibling directory whose name carries no secret or scope
data. `assertScopedCredentialStateBoundary` validates every existing component
no-follow and rejects any ancestor/descendant overlap between
`state/credentials-scoped` and evals, Superpowers, Gauntlet, or results; probe
staging calls only this helper and never inspects the blessed bundle.
`assertCredentialBundleBoundary` separately requires a real no-follow bundle
directory and rejects the same code/results overlaps; live staging calls both
helpers before evaluation. Activation cannot rename over a nonempty directory:
if active exists, rename it to one fixed recovery slot, rename the complete
stage to the now-absent active path, then remove the recovery slot. If the
second rename fails, restore the old active directory before returning the
error. Staging never mutates `active` or the recovery slot.
`recoverScopedCredentialActivation` may run only from
`reconcileScopedContainer` after the configured container is confirmed down;
it resolves an interrupted swap before the new activation, never guesses
between two complete generations, and fails closed on an ambiguous shape.

Exact OAuth projections:

| Kind | Blessed source | Active destination |
|---|---|---|
| codex | codex/auth.json | auth/codex/auth.json |
| gemini | gemini/oauth_creds.json and gemini/google_accounts.json | auth/gemini with exactly those files |
| antigravity | gemini/antigravity-cli/antigravity-oauth-token | auth/gemini/antigravity-cli/antigravity-oauth-token only |
| kimi | kimi-code/config.toml and kimi-code/credentials/kimi-code.json required; kimi-code/oauth/kimi-code optional | auth/kimi with the same relative paths |
| pi | parse pi/agent/auth.json and select only the own-property scope.oauth.provider entry | auth/pi/agent/auth.json containing exactly that entry |

Agent env behavior:

- Evaluate the trusted bundle once in isolated /bin/bash --noprofile --norc with a minimal non-secret environment.
- For each AgentEnvProjection, select the first nonempty source in order and emit only destinationName.
- Emit GEMINI_AUTH_TYPE from scope.geminiAuthType; a nonempty contradictory bundle value is config_invalid.
- Agent output is shell-single-quoted assignments. Supervisor output is Docker KEY=value lines.

Supervisor behavior:

- Emit `QUORUM_GRADER_SOURCE_MODE=appliance-scoped`, read grader credentials only from QUORUM_GRADER_* aliases, and emit those aliases into supervisor.exec.env. Canonical grader names never appear in the host file.
- Require at least one nonempty grader auth source; base URL alone is not auth.
- Include defined network/TLS names, and include Copilot routing names only for a Copilot scope.
- Reject CR/LF in Docker env-file values.
- Compare every emitted agent secret value against every nonempty grader auth
  value. Any equality fails closed even when the source/destination names
  differ. Do not include base URLs, proxies, TLS paths, or routing values in
  this secret-equality comparison.
- Never emit QUORUM_GRADER_* aliases into agent.env.

Runner behavior:

- In `appliance-scoped` mode, gauntletEnvBase projects the existing non-secret
  contract, reads each QUORUM_GRADER_* source, and writes only its mapped
  canonical name into the returned Gauntlet child env. Missing aliases fail;
  canonical values are never a fallback in this mode.
- With the source-mode marker absent, gauntletEnvBase preserves the existing
  trusted-local canonical grader input contract. Unknown or empty explicit
  mode values fail closed rather than choosing a source implicitly.
- Canonical agent credentials in the Quorum parent are ignored by the grader projection.
- Copilot's projection begins with gauntletEnvBase(hostEnv), then adds only its evidenced routing names and retains credentialed-proxy rejection. It does not loop over canonical grader names itself.
- QUORUM_GRADER_* aliases remain absent from the child env.

- [ ] **Step 1: Write RED tests for projections and atomic generations**

Use a synthetic hostile bundle. Pin:

~~~typescript
expect(readProjectedTree(gemini.authMounts[0].path)).toEqual([
  'google_accounts.json',
  'oauth_creds.json',
]);
expect(readProjectedTree(antigravity.authMounts[0].path)).toEqual([
  'antigravity-cli/antigravity-oauth-token',
]);
expect(JSON.parse(readFileSync(piAuthPath, 'utf8'))).toEqual({
  'openai-codex': sourcePiAuth['openai-codex'],
});
~~~

Cover each projection, ordered Copilot aliases, separate grader aliases,
the exact appliance mode marker, the unchanged local canonical mode, refusal
of unknown/empty explicit modes, and absence of canonical fallback in scoped
mode. Also cover
all-pairs distinct-value enforcement (including differently named agent and
grader auth channels), hostile unrelated provider/AWS names, missing values,
contradictory Gemini mode, CR/LF, symlink/FIFO/device inputs, malformed Pi
JSON, traversal, permissions, rotation, and forced first/second rename
failures. Add a parent-env test containing distinct agent
ANTHROPIC_API_KEY and QUORUM_GRADER_ANTHROPIC_API_KEY values: the ordinary
agent adapter input remains the agent value, gauntletEnvBase returns the grader
value under ANTHROPIC_API_KEY, and neither child projection contains the
alias. The second-rename failure must restore the prior active tree
byte-for-byte and metadata-for-metadata; an interrupted-swap fixture must
recover deterministically before a new stage is activated.

Add hostile topology fixtures for final and intermediate symlinks plus every
ancestor/descendant overlap. Probe fixtures prove an invalid or unreadable
blessed bundle is not touched; live fixtures prove the same bundle fault is
typed before shell evaluation or file creation.

- [ ] **Step 2: Run RED**

Run: bun test test/appliance-credential-scope.test.ts \
  test/appliance-safe-fs.test.ts test/gauntlet-env.test.ts \
  test/agent-copilot.test.ts

Expected: modules and shared constants are missing.

- [ ] **Step 3: Implement staging and activation**

Use no-follow helpers and writePrivateText. Project source files through regular-file reads and destination writes; never recursive-copy a bundle directory. activateScopedCredentialMaterial is called only after the previous container is down and performs the recoverable active-to-recovery, stage-to-active swap above. gauntletEnvBase imports the source-to-runtime map from grader.ts; Copilot composes that function before its own routing projection.

- [ ] **Step 4: Run GREEN and gates**

~~~bash
bun test test/appliance-credential-scope.test.ts \
  test/appliance-safe-fs.test.ts test/gauntlet-env.test.ts \
  test/agent-copilot.test.ts
bun test test/appliance-*.test.ts
bun run check
bun run quorum check
~~~

- [ ] **Step 5: Commit and review**

~~~bash
git add src/credentials/grader.ts src/runner/gauntlet-env.ts \
  src/agents/copilot.ts src/appliance/credential-scope.ts \
  src/appliance/safe-fs.ts test/appliance-credential-scope.test.ts \
  test/appliance-safe-fs.test.ts test/gauntlet-env.test.ts \
  test/agent-copilot.test.ts
git commit -m "feat: project exact agent and supervisor credentials (F13)"
~~~

---

### Task 3: Reconcile a scoped container and return an immutable lease

**Files:**
- Modify: src/appliance/container.ts
- Modify: src/appliance/safe-fs.ts
- Modify: src/appliance/doctor.ts
- Modify: scripts/evals-container
- Modify: container/bin/quorum
- Create: test/appliance-container.test.ts
- Modify: test/appliance-safe-fs.test.ts
- Modify: test/appliance-doctor.test.ts
- Modify: test/evals-container.test.ts
- Modify: test/container-shims.test.ts

**Interfaces:**

~~~typescript
export interface ScopedContainerMounts {
  readonly credentialScope: CredentialScope;
  readonly material: StagedCredentialMaterial;
}

export interface ContainerLease {
  readonly name: string;
  readonly id: string;
  readonly imageId: string | null;
  readonly mountSignature: string;
  readonly credentialScope: CredentialScope;
}

export function scopedUpContainerArgs(
  loaded: LoadedApplianceConfig,
  active: ActiveCredentialMaterial,
): string[];

export function reconcileScopedContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  scoped: ScopedContainerMounts,
): ContainerLease;

export function scopedExecContainerArgs(
  loaded: LoadedApplianceConfig,
  lease: ContainerLease,
  command: readonly string[],
  options?: { readonly execEnvFile?: string },
): string[];

export function runInLeasedContainer(
  loaded: LoadedApplianceConfig,
  runner: CommandRunner,
  lease: ContainerLease,
  command: readonly string[],
  code: ApplianceErrorCode,
  action: string,
): CommandResult;

export function requireDockerExecEnvFile(
  runner: CommandRunner,
): void;
~~~

reconcileScopedContainer always:

1. inspects the existing configured container;
2. downs it when present;
3. recovers any interrupted prior activation, then activates the staged generation;
4. ups with active agent.env, --no-default-auth, and only exact projected auth directories;
5. captures a non-null container ID and mount signature;
6. returns a lease containing the asserted scope.

The wrapper adds --no-default-auth, --exec-env-file, and --expected-container-id:

- --no-default-auth is valid for up, joins mount_config_explicit(), and disables every host-home fallback.
- exec args do not call baseContainerArgs and do not rediscover bundle paths. They contain only configured name, expected immutable ID, optional exec env file, exec, and the command.
- Before exec, the wrapper requires the configured name to resolve to the expected ID, then targets that immutable ID.
- --exec-env-file is valid only for exec, validated no-follow as an absolute readable regular file, and emitted after docker exec and before the immutable ID.

container/bin/quorum first unsets CODEX_AUTH_HOME, GEMINI_OAUTH_HOME, AGY_OAUTH_HOME, KIMI_OAUTH_HOME, and PI_OAUTH_HOME, then exports only variables whose projected mount exists. Extract only the auth-root selection into a sourceable shell helper if necessary for behavior testing; do not assert large rendered script strings.

requireDockerExecEnvFile inspects docker exec --help for --env-file. Doctor reports the capability; preflight later requires it before credential evaluation, build, or container mutation.

Task 3 adds these closed scoped primitives beside the current production
helpers; it does not change the existing `preflight.ts` or `process.ts` call
sites and does not add overloads or optional-scope fallbacks. That keeps this
commit type-correct without pretending the migration is complete. Task 5 owns
the single caller cutover and deletes the old TypeScript full-bundle
`baseContainerArgs` / `upContainerArgs` / `execContainerArgs` /
`reconcileContainer` / `runInContainer` path in the same commit. No appliance
live job or manual Docker gate may run from the intermediate Task 3 commit.

- [ ] **Step 1: Write RED argument, wrapper, shim, and capability tests**

Behavior tests prove asserted empty creates an empty file and no auth mounts; explicit projected mounts are exact; hostile host auth dirs remain absent; --no-default-auth refuses stale-container reuse; supervisor path appears only in exec argv; configured-name replacement fails before child execution; and absent projected mounts remove hostile image-baked OAuth vars.

Add hostile topology fixtures showing that symlinked/intermediate-symlink paths or credential state/bundle beneath code/results mounts fail with zero Docker calls.

- [ ] **Step 2: Run RED**

~~~bash
bun test test/appliance-container.test.ts test/appliance-safe-fs.test.ts \
  test/appliance-doctor.test.ts test/evals-container.test.ts \
  test/container-shims.test.ts
~~~

- [ ] **Step 3: Implement the boundary**

Keep up-time mount construction separate from exec-time process injection.
Validate exact projected paths under the active credential root.
mountSignature describes the asserted scope and active destinations, never
secret values. Existing direct wrapper invocation without --no-default-auth
remains legacy. The existing appliance TypeScript production path remains
unchanged only until Task 5's atomic cutover; the new scoped primitives do not
offer an omission mode.

- [ ] **Step 4: Run GREEN and gates**

~~~bash
bun test test/appliance-container.test.ts test/appliance-safe-fs.test.ts \
  test/appliance-doctor.test.ts test/evals-container.test.ts \
  test/container-shims.test.ts
bun test test/appliance-*.test.ts
bun run check
bun run quorum check
~~~

- [ ] **Step 5: Commit and review**

~~~bash
git add src/appliance/container.ts src/appliance/safe-fs.ts \
  src/appliance/doctor.ts scripts/evals-container container/bin/quorum \
  test/appliance-container.test.ts test/appliance-safe-fs.test.ts \
  test/appliance-doctor.test.ts test/evals-container.test.ts \
  test/container-shims.test.ts
git commit -m "feat: bind scoped containers to immutable leases (F13)"
~~~

---

### Task 4: Persist normalized selection, scope, and source identity atomically

**Files:**
- Modify: src/appliance/types.ts
- Modify: src/appliance/cli.ts
- Modify: src/appliance/jobs.ts
- Modify: src/appliance/git.ts
- Modify: src/appliance/import.ts
- Modify: src/appliance/provenance.ts
- Test: test/appliance-contracts.test.ts
- Test: test/appliance-cli.test.ts
- Test: test/appliance-jobs.test.ts
- Test: test/appliance-import.test.ts
- Create: test/appliance-provenance.test.ts

**Interfaces:**

~~~typescript
export interface LiveCredentialRequest {
  readonly selection: CredentialSelection;
  readonly scope: LiveCredentialScope;
  readonly sourceEvalsSha: string;
}

export interface CreateJobRequest {
  readonly kind: ApplianceCommandKind;
  readonly superpowersRef: string;
  readonly argv: readonly string[];
  readonly runId?: string;
  readonly credentialSelection: CredentialSelection | null;
  readonly credentialScope: CredentialScope | null;
  readonly credentialScopeSourceEvalsSha: string | null;
  readonly requester: {
    readonly agent: string | null;
    readonly thread?: string | null;
    readonly task?: string | null;
  };
}
~~~

`RunCommandArgs` also gains `readonly credential: string | null`; the normalized
value is part of the observable `ApplianceActions.run` input and the generated
Quorum argv.

Add exact zod schemas and these defaulted read fields to job and provenance:

~~~typescript
credential_selection: CredentialSelectionSchema.nullable().default(null),
credential_scope: CredentialScopeSchema.nullable().default(null),
credential_scope_source_evals_sha: z.string().nullable().default(null),
~~~

Every new writer supplies all three explicitly:

- run/run-all: non-null selection, live scope, and source SHA;
- prepare: null selection, EMPTY_CREDENTIAL_SCOPE, null source SHA;
- import: all null.

Missing fields remain read-compatible. Live preflight must reject null scope; this task does not provide a legacy execution path.

The appliance CLI restriction is exact:

- run has one required agent and accepts omitted --credential or exactly one
  nonempty --credential; omission resolves and persists the agent default;
- run-all requires exactly one CSV agent and accepts omitted --credentials or exactly one nonempty CSV credential;
- duplicate selection flags, multiple CSV entries, bare/blank/comma-only/option-looking values, run with --credentials, run-all with --credential, and --credentials-file fail before job creation;
- raw Quorum argv remains preserved separately.

The program action computes LiveCredentialRequest using the configured evals checkout and its current HEAD. It passes the request through ApplianceActions so fake-action tests observe it. submitLiveJob and createJob only persist the request; they never reparse argv or patch scope after worker spawn.

writeProvenance rereads the authoritative job and derives scope plus lease evidence from it. Callers cannot pass an independent scope. ImportedProvenanceRecordSchema and its writer persist credential_scope: null explicitly.

- [ ] **Step 1: Write RED parser, initial-record, and provenance tests**

Cover direct-run default, direct-run explicit credential, run-all default,
run-all one credential, every invalid optional-value shape, forbidden
cross-command/custom-registry flags, initial on-disk record contents, old
missing-field read compatibility, live-null refusal ownership, explicit-empty
prepare, explicit-null import, and job-authoritative provenance. Prove the
normalized direct-run credential reaches both `ApplianceActions.run` and the
persisted Quorum argv; no later layer reparses it.

Pin that serialized job/provenance/CLI output contains neither credential paths nor the string credentials-scoped.

- [ ] **Step 2: Run RED**

~~~bash
bun test test/appliance-contracts.test.ts test/appliance-cli.test.ts \
  test/appliance-jobs.test.ts test/appliance-import.test.ts \
  test/appliance-provenance.test.ts
~~~

- [ ] **Step 3: Implement atomic request persistence**

Add a current managed-checkout HEAD helper through CommandRunner in git.ts. Put all three fields in createJob's initial JobRecordSchema.parse call. Do not implement fallback from null live records. Preserve read-side parsing and safe cancellation compatibility only.

- [ ] **Step 4: Run GREEN and gates**

~~~bash
bun test test/appliance-contracts.test.ts test/appliance-cli.test.ts \
  test/appliance-jobs.test.ts test/appliance-import.test.ts \
  test/appliance-provenance.test.ts
bun test test/appliance-*.test.ts
bun run check
bun run quorum check
~~~

- [ ] **Step 5: Commit and review**

~~~bash
git add src/appliance/types.ts src/appliance/cli.ts src/appliance/jobs.ts \
  src/appliance/git.ts src/appliance/import.ts src/appliance/provenance.ts \
  test/appliance-contracts.test.ts test/appliance-cli.test.ts \
  test/appliance-jobs.test.ts test/appliance-import.test.ts \
  test/appliance-provenance.test.ts
git commit -m "feat: persist one authoritative credential request (F13)"
~~~

---

### Task 5: Run empty probes, then bind live execution to the scoped lease

**Files:**
- Modify: src/appliance/preflight.ts
- Modify: src/appliance/process.ts
- Modify: src/appliance/container.ts
- Modify: src/appliance/provenance.ts
- Modify: src/appliance/types.ts
- Test: test/appliance-preflight.test.ts
- Test: test/appliance-process.test.ts
- Test: test/appliance-container.test.ts
- Test: test/appliance-provenance.test.ts

**Interfaces:**

~~~typescript
export interface PreflightResult {
  readonly refs: RefSnapshot;
  readonly credential_bundle: {
    readonly name: 'blessed';
    readonly bundle_id: string;
  };
  readonly container: ContainerLease;
  readonly tool_versions_path: string;
  readonly tool_versions_text: string;
  readonly provenance_path: string;
}

export interface LivePreflightResult {
  readonly evidence: PreflightResult;
  readonly lease: ContainerLease;
  readonly supervisorExecEnvFile: string;
}

export async function preflightLiveJob(
  args: PreflightArgs,
): Promise<LivePreflightResult>;

export async function prepare(args: PrepareArgs): Promise<PreflightResult>;
~~~

Live ordering is binding:

1. update status and verify clean repos;
2. fetch and fast-forward;
3. before credential evaluation or Docker, require persisted source SHA to equal evals_resolved_sha;
4. recompute scope from persisted selection and require exact equality with the stored scope;
5. require docker exec --env-file capability;
6. build the image;
7. stage asserted-empty probe material and reconcile the empty probe container;
8. run evals-tool-versions and quorum check through the probe lease with no supervisor file;
9. stage live material and reconcile again, which downs the probe before activating and mounting the live generation;
10. atomically update the job with refs, bundle, live lease, and the unchanged authoritative scope;
11. write provenance from the reread job;
12. return the worker-only supervisor path.

prepare stops after the empty probe evidence. It never evaluates the blessed env values, creates a supervisor file, or mounts OAuth material.

PreflightResult is public evidence and contains no credential path. LivePreflightResult is private to runWorker and is never spread into CLI output, job JSON, or provenance.

runWorker passes supervisorExecEnvFile only to the live Quorum exec. live, liveness, and cancellation reconstruct or consume the recorded immutable lease:

- live name/ID mismatch fails before spawn;
- liveness mismatch reports lost;
- cancellation mismatch never signals a replacement container;
- a readable legacy record may cancel only when its recorded immutable container ID can be verified;
- null-scope live jobs cannot preflight or resume.

This task switches every production container call site to
`reconcileScopedContainer`, `runInLeasedContainer`, and
`scopedExecContainerArgs`, then deletes the superseded TypeScript full-bundle
helpers named in Task 3. A repository-wide call-site test/grep must show no
appliance production import can construct a container exec without a
`ContainerLease`. The shell wrapper's explicitly documented direct legacy mode
is not a TypeScript fallback and remains outside appliance execution.

- [ ] **Step 1: Write RED ordering, freshness, privacy, and replacement tests**

Use FakeRunner to prove:

~~~text
fast-forward -> SHA/scope gates -> capability -> build ->
empty up -> probe execs -> empty down -> scoped up -> identity ->
job evidence -> provenance -> live exec with supervisor file
~~~

Add separate failures for SHA drift and recomputed-scope mismatch, both with zero credential evaluation and zero Docker calls. Replace the configured-name inspect result between preflight and live/liveness/cancel and assert no child execution or replacement-container signal. Fault provenance after job evidence; retry must heal from the job without changing scope.

- [ ] **Step 2: Run RED**

~~~bash
bun test test/appliance-preflight.test.ts test/appliance-process.test.ts \
  test/appliance-container.test.ts test/appliance-provenance.test.ts
~~~

- [ ] **Step 3: Implement one-way private threading**

Do not expose a generic env map or arbitrary exec options. Do not serialize
private credential paths. Keep plan-time empty/live scope distinctions
explicit, require a lease at every container exec call site, and delete the
old TypeScript full-bundle helpers rather than leaving two production paths.

- [ ] **Step 4: Run GREEN and gates**

~~~bash
bun test test/appliance-preflight.test.ts test/appliance-process.test.ts \
  test/appliance-container.test.ts test/appliance-provenance.test.ts
bun test test/appliance-*.test.ts test/evals-container.test.ts
bun run check
bun run quorum check
~~~

- [ ] **Step 5: Commit and final whole-branch review**

~~~bash
git add src/appliance/preflight.ts src/appliance/process.ts \
  src/appliance/container.ts src/appliance/provenance.ts \
  src/appliance/types.ts \
  test/appliance-preflight.test.ts test/appliance-process.test.ts \
  test/appliance-container.test.ts test/appliance-provenance.test.ts
git commit -m "feat: run live jobs through scoped container leases (F13)"
~~~

Run a fresh adversarial whole-branch review before any manual Docker or appliance action.

---

### Task 6: Document and physically prove the boundary

**Files:**
- Modify: docs/appliance-runbook.md
- Create after the gate: docs/experiments/2026-08-18-f13-filesystem-credential-scoping.md

- [ ] **Step 1: Update the operator contract**

Document:

- one agent and at most one credential per Phase 1 live job;
- mixed-scope batches are rejected pending per-cell containers;
- any missing selected env/file material refuses the whole single-scope job before live execution, with names/remediation but no values;
- missing scope is read-compatible but not execution-compatible;
- prepare is asserted-empty and import is non-executing/null;
- the empty-probe then scoped-live recreate sequence;
- exact OAuth projections rather than whole source directories;
- immutable container-ID behavior for live/liveness/cancel;
- docker exec --env-file capability diagnostics;
- fixed active generation lifecycle, interrupted-swap recovery, and bundle-retirement procedure: down the container, then remove state/credentials-scoped;
- the required bundle migration to distinct QUORUM_GRADER_* sources, with no fallback to the agent's canonical secret names and a named error when the migration is incomplete;
- the explicit grader source-mode boundary: appliance-scoped mode is
  alias-only, while trusted local runs with no marker retain the canonical
  host contract; unknown or empty explicit modes are errors;
- no-follow/disjointness errors and repair guidance;
- mount signatures are not comparable across this upgrade;
- same-UID /proc inspection remains outside filesystem closure.

- [ ] **Step 2: Run a synthetic no-secret Docker canary matrix**

After Drew explicitly authorizes the manual gate, use a temporary synthetic bundle containing unique non-secret marker names/files for every declared delivery class (including the currently trusted-maintainer-only Antigravity projector). For each scope, execute a fake agent reader in the real container and record only marker presence booleans:

- API-key env projection;
- Claude OAuth env projection;
- Copilot alias canonicalization;
- Codex auth.json only;
- Gemini personal files without Antigravity token;
- Antigravity token without Gemini personal files;
- Kimi required files plus optional marker behavior;
- Pi selected provider without the hostile second provider;
- grader source marker present only in the Quorum supervisor process, translated to its runtime name only in the Gauntlet child, and absent from mounts/agent file.

Every scope must observe its own marker and reject every disallowed marker by env and filesystem. Do not print file contents or real bundle values.

- [ ] **Step 3: Run one real disjoint Codex-subscription appliance job**

Verify doctor first. Run through evals-appliance, not raw quorum. Inspect resolved Docker mount sources/destinations and agent env key names only. Confirm:

- only projected Codex auth is mounted;
- agent.env has no grader runtime/source names;
- supervisor.exec.env is absent from all container mounts;
- the recorded immutable ID matches the running container during the live process;
- Gauntlet drives the Coding-Agent successfully.

- [ ] **Step 4: Record the experiment honestly**

Create docs/experiments/2026-08-18-f13-filesystem-credential-scoping.md with hypothesis, exact commit, job ID, bundle ID, Docker client/server versions, container lease ID/signature, marker/key/mount names only, result, and negative findings at equal billing. Do not claim this file exists or the gate passed before the physical run occurs.

- [ ] **Step 5: Run final gates and commit docs/evidence separately**

~~~bash
bun run check
bun run quorum check
git add docs/appliance-runbook.md
git commit -m "docs: define scoped appliance credential operations (F13)"

git add docs/experiments/2026-08-18-f13-filesystem-credential-scoping.md
git commit -m "docs: record F13 filesystem credential gate"
~~~

No push without Drew's explicit approval after he reviews the final evidence.

---

## Self-Review

**Spec coverage:** The isolation unit now equals one agent plus one credential, so no cell shares a union with another. Env delivery is exact, OAuth delivery is exact by adapter file/entry, probes are empty, the grader file is host-only, and live execution binds to the scoped container that preflight recorded.

**Failure-mode coverage:** Unknown/prototype names; missing defaults; mixed selections; bare/blank/duplicate/custom-registry flags; stale source SHA; recomputed-scope disagreement; missing or equal agent/grader values; contradictory Gemini mode; whole-directory overexposure; Pi multi-provider overexposure; symlinks/nonregular inputs; staging interruption; stale active generation; missing Docker capability; replacement containers; private path serialization; null live records; and probe credential exposure all have explicit behavior tests.

**Type consistency:** Task 1 defines CredentialSelection and CredentialScope.
Task 2 produces staged/active material. Task 3 adds independently testable
scoped container primitives that consume staged material and produce
ContainerLease without changing production callers. Task 4 persists
selection/scope/source SHA atomically. Task 5 performs the one-time production
cutover, deletes the old TypeScript full-bundle path, and produces a private
LivePreflightResult without serializing credential paths.

**Compatibility:** Drew approved read-only parsing of old missing fields and explicit refusal to execute old/null live records. No compatibility wrapper preserves the deleted union resolver. Direct wrapper omission remains break-glass legacy; appliance calls always assert a scope.

**Secret lifecycle:** One fixed active generation exists. New material is staged while the old container may still reference active; after the container is down, a recoverable two-rename swap installs the staged tree and the new container mounts it. Interrupted or failed swaps restore/fail closed before a later job. Rotation downs the container before clearing active. No secret value or value-derived hash appears outside the files.

**Deliberate exclusions:** No mixed-scope Phase 1 jobs, per-cell containers, UID separation, Windows guest/password remediation, or automated live eval in CI. These exclusions are stated as limitations, not claimed as F13 closure.

**Placeholder scan:** Every task names files, interfaces, RED/GREEN commands, expected failures, and commit boundaries. No TODO/TBD, generic "add tests," source-string-heavy shell assertions, or invented optional legacy execution path remains.
