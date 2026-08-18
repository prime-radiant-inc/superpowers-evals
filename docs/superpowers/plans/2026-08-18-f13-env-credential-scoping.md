# F13 Env Credential Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the env half of F13 — the Coding-Agent under test and every quorum-spawned subprocess currently inherit the full host credential bundle — by converting the six unscoped launchers to `env -i` allowlists, scoping `setup.sh` and adapter provisioning subprocesses, and projecting the Gauntlet child's env onto an allowlist.

**Architecture:** Follow the PRI-2494 pattern that already scoped the claude/codex launchers: secrets ride mode-0600 per-run env files (written by provisioning, sourced by the launcher before the `env -i` wall, forwarded selectively); the launcher wall passes an explicit allowlist. For the TS side, project `envSnapshot()` onto small per-surface allowlists (`CHECK_ENV_ALLOWLIST` is the existing in-repo pattern). Black-box launcher tests extend `test/launcher-env-isolation.test.ts`'s hostile-env harness per agent.

**Scope line (explicit):** this plan is the **env** half of the spec's F13 done-when ("a per-agent black-box test proves the agent reaches only its own credential, by env and by filesystem"). The **filesystem** half — container `/auth/*` mount selection, per-agent `credentials.env` subsetting, UID separation, run-home credential retention — is the follow-on plan (its recon is done; same fix-now bullet). claude-windows gets a documented exception (see Task 4).

**Tech Stack:** TypeScript on Bun ≥1.3, bash launcher templates, `bun test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` — "Order of operations", fix-now item 1, bullet 1 (lines 618–624), quoted verbatim in Global Constraints.

## Global Constraints

- Bun ≥ 1.3; `bun run check` (biome + tsc + bun test) must be green at every commit.
- All tests hermetic: `bun test` only, no live agent launches (launcher tests use fake env-dumping binaries per the existing harness), no network, no Docker.
- Repo rule: never weaken an existing test; test output must be pristine.
- Commit after every task; conventional-commit style (`feat:`, `fix:`, `test:`, `docs:`).
- **Fail loud on unknowns:** an allowlist that is too tight fails loudly (the agent CLI errors on a missing var) and is extended on evidence; an allowlist that is too loose leaks silently. When in doubt, leave a var OUT.
- **Corpus-governed:** before freezing each allowlist, empirically scan what the surface actually reads (the setup.sh corpus, each adapter's env-file writer) and include exactly that — the scan method and results go in the task report.
- **No bash-4-isms in launcher templates** (macOS ships bash 3.2 and runs these): no `${!prefix@}` expansion, no associative arrays. Arrays, `[[ ]]`, and conditional appends (the codex pattern) are fine.
- Spec text binding this plan, verbatim (`2026-08-17-quorum-campaign-platform-design.md:618–624`):
  > - Per-agent env **and filesystem** credential scoping (F13, 2026-08-12 adversarial review: 6/12 launchers inherit host env; the Gauntlet subprocess env carries the full provider bundle; the container's credential env file and OAuth mounts are readable under the agent's UID). Done when a per-agent black-box test proves the agent reaches only its own credential, by env and by filesystem.

## Recon corrections this plan is built on (verified against source @ `fa45a9a`)

1. **The launch env is built by 11 substituted bash templates** (`coding-agents/*-context/launch-agent`), not by `src/agents/*.ts`. Exactly 5 use `env -i` allowlists (claude, codex, opencode, serf, copilot); **6 do not** (gemini, kimi, pi, hermes, antigravity, claude-windows). The 6 are the fix surface.
2. **The Gauntlet child's env base is the full host snapshot** (`src/runner/index.ts:320-326`, `a.envBase ?? envSnapshot()`); only copilot overrides it (`index.ts:1544-1545` → `copilotGauntletEnv`, `src/agents/copilot.ts:96-128`). Threat note: the agent shares the gauntlet child's UID, and a same-UID process can read a peer's env (`/proc/<pid>/environ` on Linux, `ps eww` on macOS) — the launcher's `env -i` wall alone does not stop the agent reading the *gauntlet* process env.
3. **`setup.sh` inherits the full host env** (`src/setup-step.ts:38-45`). The checks phase already does this correctly (`CHECK_ENV_ALLOWLIST`, `src/checks/index.ts:26-38,107-132`) — the pattern to copy.
4. **Provisioning subprocesses** of antigravity (`src/agents/antigravity.ts:183-190,254-268`), gemini (`gemini.ts:313-319`), hermes (`hermes.ts:221-227`), opencode (`opencode.ts:398-400`), and copilot (`copilot.ts:254-256`) run with full `envSnapshot()`. Kimi's `buildKimiSubprocessEnv` (`kimi.ts:748-793`) is the existing TS-side allowlist builder; the capture side (`opencode-capture.ts:59-104`, `hermes-capture.ts:73-105`) has the same shape.
5. **Each launcher's secret delivery is already a per-run env file** written mode-0600 by provisioning: gemini `.gemini-env` (`gemini.ts:294-299`, sets `GEMINI_API_KEY` in api-key mode, empty in OAuth mode), kimi runtime env file (`kimi.ts:200-227`, allowlist-built: PATH/TERM/LANG/SHELL + `LC_*` + proxy names + `KIMI_MODEL_*`, placed outside the artifact root and deleted after sourcing), pi `pi.env` (`pi.ts:58-81`, `PI_PROVIDER`/`PI_MODEL`/optional `PI_API_KEY` + sorted extras). hermes and antigravity have NO env file — their credentials are files inside the throwaway home, so their launchers forward nothing.
6. **claude-windows** delegates env to the Windows guest's `launch.cmd`, which uses additive `set` (`src/agents/claude-windows.ts:96-108`); meaningful isolation there is guest-side work on the separate Windows trusted-maintainer path. Its wrapper also burns the SSH password into argv (`sshpass -p`) and into the installed launcher file — recorded as a known residual owned by the filesystem/Windows follow-up, not this plan.

## File Structure

- `src/setup-step.ts` — MODIFY: `SETUP_ENV_ALLOWLIST` projection (Task 1).
- `src/checks/index.ts` — MODIFY: export `CHECK_ENV_ALLOWLIST` (one keyword; Task 1).
- `src/agents/subprocess-env.ts` — NEW: `PROVISION_ENV_ALLOWLIST` + `provisionSubprocessEnv` (Task 2).
- `src/agents/{antigravity,gemini,hermes,opencode,copilot}.ts` (+ `windows-host.ts` if it passes env) — MODIFY: swap `envSnapshot()` spreads for `provisionSubprocessEnv(...)` (Task 2).
- `coding-agents/{gemini,kimi,pi}-context/launch-agent` — MODIFY: `env -i` conversion (Task 3).
- `coding-agents/{hermes,antigravity}-context/launch-agent` — MODIFY: `env -i` conversion (Task 4).
- `test/launcher-env-isolation.test.ts` — MODIFY: generalize the harness beyond claude/codex; per-agent hostile-env tests (Tasks 3–4).
- `src/runner/gauntlet-env.ts` — NEW: `GAUNTLET_ENV_ALLOWLIST` + `gauntletEnvBase` (Task 5).
- `src/runner/index.ts` — MODIFY: default `envBase` for all agents (Task 5, lines 1544–1545).
- `test/setup-step-env.test.ts` — NEW (Task 1). `test/agent-subprocess-env.test.ts` — NEW (Task 2). `test/gauntlet-env.test.ts` — NEW (Task 5). Per-adapter `test/agent-*.test.ts` — MODIFY (Task 2).

---

### Task 1: `setup.sh` env allowlist

**Files:**
- Modify: `src/setup-step.ts` (env construction at lines 38–45)
- Modify: `src/checks/index.ts` (export the existing allowlist, line 26)
- Test: `test/setup-step-env.test.ts` (new)

**Interfaces:**
- Consumes: `CHECK_ENV_ALLOWLIST` (`src/checks/index.ts:26-38` — add the `export` keyword), `getEnv`/`envSnapshot` (`src/env.ts`).
- Produces: `SETUP_ENV_ALLOWLIST` (exported from `src/setup-step.ts`); `runSetup`'s child env becomes the allowlist projection + quorum-owned vars + `envExtra`, with NO full-snapshot spread.

- [ ] **Step 1: Corpus scan (do first; results in the task report)**

Enumerate what setup actually reads: `grep -rhoE '\$\{?[A-Z_][A-Z0-9_]*' scenarios/*/setup.sh | sort -u` and `getEnv(`/`process.env` reads in `src/setup-helpers/`. Cross off quorum-owned vars (`QUORUM_*`, `BASH_ENV`) and shell specials; what remains is the candidate host-var set. Expect tool-config names (e.g. git/npm/uv config); anything credential-shaped (`*_API_KEY`, `*_TOKEN`, `AWS_*`) stays OUT — if a scenario genuinely needs a secret at setup, report it as a concern instead of allowlisting it.

- [ ] **Step 2: Write the failing test**

```typescript
// test/setup-step-env.test.ts
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup, SETUP_ENV_ALLOWLIST } from '../src/setup-step.ts';

const HOSTILE = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'SOME_RANDOM_HOST_VAR'];

function runHostileSetup(): Record<string, string> {
  const scenarioDir = mkdtempSync(join(tmpdir(), 'setup-scn-'));
  const workdir = mkdtempSync(join(tmpdir(), 'setup-wd-'));
  writeFileSync(
    join(scenarioDir, 'setup.sh'),
    '#!/usr/bin/env bash\nenv > "$QUORUM_WORKDIR/env-dump.txt"\n',
  );
  const saved: Record<string, string | undefined> = {};
  for (const name of HOSTILE) {
    saved[name] = process.env[name];
    process.env[name] = `hostile-${name}`;
  }
  try {
    runSetup(scenarioDir, workdir);
  } finally {
    for (const name of HOSTILE) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(workdir, 'env-dump.txt'), 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

test('setup.sh never sees host credentials; quorum-owned and allowlisted vars survive', () => {
  const env = runHostileSetup();
  for (const name of HOSTILE) expect(env[name]).toBeUndefined();
  expect(env['QUORUM_WORKDIR']).toContain('setup-wd-');
  expect(env['QUORUM_SCENARIO_DIR']).toContain('setup-scn-');
  expect(env['QUORUM_REPO_ROOT']).toBeTruthy();
  expect(env['PATH']).toBeTruthy();
  expect(env['HOME']).toBeTruthy();
});

test('SETUP_ENV_ALLOWLIST contains no credential-shaped names', () => {
  for (const name of SETUP_ENV_ALLOWLIST) {
    expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
  }
});

afterEach(() => {
  for (const name of HOSTILE) delete process.env[name];
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/setup-step-env.test.ts`
Expected: FAIL — hostile vars present in the dump (full inheritance today).

- [ ] **Step 4: Implement**

`src/checks/index.ts` line 26: `const CHECK_ENV_ALLOWLIST` → `export const CHECK_ENV_ALLOWLIST`.

`src/setup-step.ts`:

```typescript
import { CHECK_ENV_ALLOWLIST } from './checks/index.ts';
import { getEnv } from './env.ts';

// setup.sh executes scenario-authored shell — the same untrusted-author
// boundary as checks.sh, so it gets the same treatment: a non-secret
// allowlist projection of the host env plus quorum-owned vars, never the full
// snapshot. The base list is the checks allowlist plus the tool-config vars
// fixture creation needs (git/bun/uv read HOME, proxies, CA bundles); the
// corpus scan in this task's report justifies every name beyond the checks
// list. A var setup.sh turns out to need fails loudly (tool error) and is
// added on evidence; a var it doesn't need never leaks in.
export const SETUP_ENV_ALLOWLIST: readonly string[] = [
  ...CHECK_ENV_ALLOWLIST,
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // …plus exactly the non-secret names the Step 1 corpus scan found
  // (list them, each justified by a scan hit; remove any the scan disproves).
];
```

Replace the `env: { ...envSnapshot(), … }` block (lines 38–45) with:

```typescript
    env: {
      ...Object.fromEntries(
        SETUP_ENV_ALLOWLIST.map((name) => [name, getEnv(name)]),
      ),
      BASH_ENV: prelude,
      QUORUM_REPO_ROOT: root,
      QUORUM_WORKDIR: workdir,
      QUORUM_SCENARIO_DIR: scenarioDir,
      ...envExtra,
    },
```

(`envSnapshot` import may become unused — remove it if so.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/setup-step-env.test.ts` → PASS, pristine. Then `bun test` (whole suite — setup-helpers tests exercise `runSetup` paths).

- [ ] **Step 6: Commit**

```bash
git add src/setup-step.ts src/checks/index.ts test/setup-step-env.test.ts
git commit -m "feat: setup.sh runs on a non-secret env allowlist (checks-phase pattern)"
```

---

### Task 2: Adapter provisioning subprocess env allowlists

**Files:**
- Create: `src/agents/subprocess-env.ts`
- Modify: `src/agents/antigravity.ts:183-190,254-268`, `src/agents/gemini.ts:313-319`, `src/agents/hermes.ts:221-227`, `src/agents/opencode.ts:398-400`, `src/agents/copilot.ts:254-256`; inspect `src/agents/windows-host.ts:53-81` and scope it too if it passes an env
- Test: `test/agent-subprocess-env.test.ts` (new); append per-adapter assertions to `test/agent-gemini.test.ts`, `test/agent-antigravity.test.ts`, `test/agent-hermes.test.ts`, `test/agent-opencode.test.ts`, `test/agent-copilot.test.ts`

**Interfaces:**
- Consumes: `getEnv` (`src/env.ts`); the `CommandRunner` seam (`src/agents/command-runner.ts:20-48`) and `FakeCommandRunner` (`test/fake-command-runner.ts:23-39` — records `options.env`).
- Produces:
  - `PROVISION_ENV_ALLOWLIST: readonly string[]`
  - `provisionSubprocessEnv(extra?: Record<string, string>): Record<string, string>` — base allowlist projection, `extra` overlays. Per-adapter extras: antigravity `{ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }`; gemini `{ GEMINI_CLI_TRUST_WORKSPACE, GEMINI_DEFAULT_AUTH_TYPE, GEMINI_CLI_HOME }` (values as constructed at gemini.ts:313-319 today); hermes `{ HOME: runHomeDir, HERMES_HOME: configDir }`; opencode `{}`; copilot `{}`.

- [ ] **Step 1: Write the failing helper test**

```typescript
// test/agent-subprocess-env.test.ts
import { afterEach, expect, test } from 'bun:test';
import { PROVISION_ENV_ALLOWLIST, provisionSubprocessEnv } from '../src/agents/subprocess-env.ts';

const HOSTILE = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'KIMI_MODEL_API_KEY', 'AWS_SECRET_ACCESS_KEY'];

test('provisionSubprocessEnv projects the allowlist and overlays extras', () => {
  const saved: Record<string, string | undefined> = {};
  for (const name of HOSTILE) {
    saved[name] = process.env[name];
    process.env[name] = `hostile-${name}`;
  }
  try {
    const env = provisionSubprocessEnv({ MY_EXTRA: 'x' });
    for (const name of HOSTILE) expect(env[name]).toBeUndefined();
    expect(env['MY_EXTRA']).toBe('x');
    expect(env['PATH']).toBe(process.env['PATH']);
    // extras override base names:
    expect(provisionSubprocessEnv({ HOME: '/run/home' })['HOME']).toBe('/run/home');
  } finally {
    for (const name of HOSTILE) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test('PROVISION_ENV_ALLOWLIST contains no credential-shaped names', () => {
  for (const name of PROVISION_ENV_ALLOWLIST) {
    expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
  }
});

afterEach(() => {
  for (const name of HOSTILE) delete process.env[name];
});
```

- [ ] **Step 2: Write the failing per-adapter tests**

Append to each listed `test/agent-*.test.ts`, using its existing FakeCommandRunner provisioning harness (e.g. `test/agent-gemini.test.ts:99+`): drive the adapter's `provision()` with a hostile `process.env` set (save/restore as above), then assert the recorded `options.env` of each subprocess call **lacks** every hostile name and **contains** the adapter's expected extras (e.g. gemini's `GEMINI_CLI_HOME`). One test per adapter.

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/agent-subprocess-env.test.ts test/agent-gemini.test.ts`
Expected: FAIL — helper missing; adapter envs contain hostile names.

- [ ] **Step 4: Implement**

```typescript
// src/agents/subprocess-env.ts
// Base non-secret allowlist for adapter provisioning subprocesses (agent CLIs
// running plugin installs / auth preflights / syntax checks). These CLIs are
// third-party code with host reach; the full provider bundle has no business
// in their environment. Caller extras overlay the base. Fail-loud rule: a
// missing var breaks the subprocess loudly and is added on evidence; a
// leaked var is silent.
import { getEnv } from '../env.ts';

export const PROVISION_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HOME',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'TZ',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
];

export function provisionSubprocessEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROVISION_ENV_ALLOWLIST) {
    const value = getEnv(name);
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...extra };
}
```

Swap each adapter call site: `env: { ...envSnapshot(), X }` (or `env: envSnapshot()`) → `env: provisionSubprocessEnv({ X })` with the per-adapter extras listed in Interfaces. For `windows-host.ts`: read how the SSH password reaches sshpass/scp; if it passes an env, scope it the same way, preserving exactly the vars its auth mechanism needs (e.g. `SSHPASS` if `-e` is used) — and note in the report which mechanism it is. Remove now-unused `envSnapshot` imports per file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/agent-subprocess-env.test.ts test/agent-gemini.test.ts test/agent-antigravity.test.ts test/agent-hermes.test.ts test/agent-opencode.test.ts test/agent-copilot.test.ts` → PASS.

- [ ] **Step 6: Full check and commit**

Run: `bun run check` → green.

```bash
git add src/agents/subprocess-env.ts src/agents/antigravity.ts src/agents/gemini.ts src/agents/hermes.ts src/agents/opencode.ts src/agents/copilot.ts src/agents/windows-host.ts test/agent-subprocess-env.test.ts test/agent-gemini.test.ts test/agent-antigravity.test.ts test/agent-hermes.test.ts test/agent-opencode.test.ts test/agent-copilot.test.ts
git commit -m "feat: adapter provisioning subprocesses run on a non-secret env allowlist"
```

---

### Task 3: Launcher `env -i` conversions — gemini, kimi, pi

**Files:**
- Modify: `coding-agents/gemini-context/launch-agent`, `coding-agents/kimi-context/launch-agent`, `coding-agents/pi-context/launch-agent`
- Test: `test/launcher-env-isolation.test.ts` (generalize + three new tests)

**Interfaces:**
- Consumes: the codex launcher as the reference pattern (`coding-agents/codex-context/launch-agent:64-76`); each adapter's env-file contract (recon fact 5 in this plan's preamble).
- Produces: the three launchers exec through `env -i` with explicit allowlists; `test/launcher-env-isolation.test.ts`'s harness generalized beyond `'claude' | 'codex'`.

Conversion pattern (identical shape in all three): source the env file FIRST (it is mode-0600, per-run, and already minimal), then build `env_args` from the base trio + exactly the vars that file can set, then `exec env -i`. Base trio with fallbacks: `PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}`, `TERM=${TERM:-xterm-256color}`, `LANG=${LANG:-C.UTF-8}`.

**gemini** — replace lines 8–15 with:

```bash
set -a
. $GEMINI_ENV_FILE_SH
set +a

# Host-env isolation (F13): env -i + explicit allowlist, matching the
# codex/claude launchers. The sourced .gemini-env sets GEMINI_API_KEY in
# api-key mode (empty in OAuth mode — OAuth creds are files in the throwaway
# home), so forward it only when set.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
if [[ -n "${GEMINI_API_KEY-}" ]]; then
  env_args+=("GEMINI_API_KEY=$GEMINI_API_KEY")
fi

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  GEMINI_DEFAULT_AUTH_TYPE=$GEMINI_AUTH_TYPE_SH \
  GEMINI_CLI_TRUST_WORKSPACE=true \
  gemini --skip-trust --approval-mode=yolo "$@"
```

**kimi** — the sourced env file is already allowlist-built by `buildKimiSubprocessEnv` (`src/agents/kimi.ts:748-793`). Read that function and forward exactly the names it can emit (expected: PATH/TERM/LANG/SHELL, `LC_*`, the proxy names, `KIMI_MODEL_*`) as a STATIC forward list — no bash-4 `${!prefix@}`. Add a sync comment in both files (`kimi.ts` builder and this launcher): "the launcher's forward list must name every var this file can set." Replace lines 32's `exec env …` with:

```bash
# Host-env isolation (F13): env -i + explicit allowlist. The env file is
# allowlist-built by buildKimiSubprocessEnv (src/agents/kimi.ts) and already
# sourced above (and deleted); forward exactly those names — keep this list
# in sync with that builder.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
for name in SHELL LC_ALL LC_CTYPE http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY <KIMI_MODEL_* names from the builder>; do
  if [[ -n "${!name-}" ]]; then
    env_args+=("$name=${!name}")
  fi
done

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  $KIMI_BINARY --yolo "$@"
```

**pi** — the sourced `pi.env` sets `PI_PROVIDER`/`PI_MODEL` (consumed as CLI flags in the same script — no env forwarding needed for those), optional `PI_API_KEY`, and sorted extras. Read `writePiEnvFile`'s call sites in `src/agents/pi.ts` for the exact extra names; forward each by name. Replace lines 43–55's `exec env …` with:

```bash
# Host-env isolation (F13): env -i + explicit allowlist. The sourced pi.env
# sets PI_PROVIDER/PI_MODEL (used as flags below), optional PI_API_KEY, and
# the extras provision wrote — forward exactly those.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
for name in PI_PROVIDER PI_MODEL PI_API_KEY <extra names from pi.ts>; do
  if [[ -n "${!name-}" ]]; then
    env_args+=("$name=${!name}")
  fi
done

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  PI_OFFLINE=1 \
  PI_TELEMETRY=0 \
  pi \
    --provider "$PI_PROVIDER" \
    --model "$PI_MODEL" \
    --no-extensions \
    --extension "$SUPERPOWERS_ROOT" \
    --extension "$PI_SUBAGENTS_PKG" \
    --no-skills \
    --skill "$SUPERPOWERS_ROOT/skills" \
    --tools read,bash,edit,write,grep,find,ls,subagent \
    "$@"
```

(Everything above the `exec` in each launcher — cd, env-file sourcing/deletion, pi-subagents resolution — stays as-is.)

- [ ] **Step 1: Generalize the test harness**

In `test/launcher-env-isolation.test.ts`, widen `installLauncher`'s `agent` union to `'claude' | 'codex' | 'gemini' | 'kimi' | 'pi' | 'hermes' | 'antigravity'` and replace the hardcoded claude/codex branches with a per-agent fixture table. Read `src/runner/context.ts:41-99` (`populateContextDir` + `copyWithSubstitutions`) for how substitutions are matched and quoted — `required: true` throws on a template placeholder with no substitution, so a missing entry in your table fails loudly. The table needs, per agent: fake binary name; env-file substitution key + fixture content (where the agent has an env file); any additional substitutions the template references (`$GEMINI_ENV_FILE_SH`, `$GEMINI_AUTH_TYPE_SH`, `$KIMI_ENV_FILE`, `$KIMI_BINARY`, `$PI_ENV_FILE`, `$SUPERPOWERS_ROOT`, `$QUORUM_AGENT_HOME`, plus `homeEnvSubstitutions(home)` for all); extra fake binaries (pi needs a fake `npm` that prints a dir containing a `pi-subagents/` subdir, since the launcher resolves `$(npm root -g)/pi-subagents` and exits if absent). kimi note: the launcher DELETES `$KIMI_ENV_FILE` after sourcing — the fixture file must be disposable (it is: a tmpdir file). kimi's `$KIMI_BINARY` substitutes the fake-binary path directly.

- [ ] **Step 2: Write the failing per-agent tests**

One test per converted launcher, mirroring the existing claude/codex tests: launch under HOSTILE (extend the HOSTILE map with `GEMINI_API_KEY: 'sk-host-gemini'`, `KIMI_MODEL_API_KEY: 'sk-host-kimi'`, `PI_API_KEY: 'sk-host-pi'`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`) → assert every HOSTILE key is absent-or-overridden in the dump. The override case matters: when the env file sets a name the hostile env also sets (e.g. `GEMINI_API_KEY`), the dump must carry the FILE's value (`'sk-gemini-test'`), not the hostile one. Assert the deliberate vars arrive: gemini → `GEMINI_DEFAULT_AUTH_TYPE`, `GEMINI_CLI_TRUST_WORKSPACE=true`; kimi → `KIMI_MODEL_API_KEY='sk-kimi-test'` (from the fixture file); pi → `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_API_KEY='sk-pi-test'`. All agents: `HOME` is the throwaway home, `PATH` present.

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/launcher-env-isolation.test.ts`
Expected: FAIL for the three new agents (hostile vars leak through plain `env`).

- [ ] **Step 4: Convert the launchers** (per the code blocks above)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/launcher-env-isolation.test.ts` → PASS, pristine (including the pre-existing claude/codex tests).

- [ ] **Step 6: Commit**

```bash
git add coding-agents/gemini-context/launch-agent coding-agents/kimi-context/launch-agent coding-agents/pi-context/launch-agent test/launcher-env-isolation.test.ts
git commit -m "feat: env -i allowlists for gemini/kimi/pi launchers (F13)"
```

---

### Task 4: Launcher `env -i` conversions — hermes, antigravity; claude-windows exception

**Files:**
- Modify: `coding-agents/hermes-context/launch-agent`, `coding-agents/antigravity-context/launch-agent`
- Test: `test/launcher-env-isolation.test.ts` (two new tests)
- Docs: `coding-agents/claude-windows-context/HOWTO.md` (exception note); any `coding-agents/*-context/HOWTO.md` that documents env inheritance — grep for `env` claims and align

**Interfaces:**
- Consumes: the Task 3 harness and pattern. hermes and antigravity have NO env file — credentials are files inside the throwaway home (`~/.hermes/.env`; `~/.gemini/oauth_creds.json`), so their launchers forward nothing beyond the base trio.
- Produces: all six remaining Linux-local launchers scoped; claude-windows documented as the exception.

**hermes** — replace line 28 with:

```bash
# Host-env isolation (F13): env -i + explicit allowlist. hermes reads its
# provider key from ~/.hermes/.env inside the throwaway home (seeded by
# provisioning) — nothing secret rides the environment.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  hermes --yolo "$@"
```

**antigravity** — replace lines 37–45 with:

```bash
# Host-env isolation (F13): env -i + explicit allowlist. agy reads its OAuth
# creds from the throwaway home's .gemini (seeded by provisioning) — nothing
# secret rides the environment.
env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)

exec env -i \
  "${env_args[@]}" \
  $QUORUM_HOME_ENV \
  ANTIGRAVITY_CONFIG_DIR="$QUORUM_AGENT_HOME" \
  AGY_CLI_DISABLE_AUTO_UPDATE=true \
  agy \
    --gemini_dir="$QUORUM_AGENT_HOME/.gemini" \
    --add-dir="$QUORUM_AGENT_CWD" \
    --dangerously-skip-permissions \
    --log-file "$QUORUM_AGENT_HOME/agy.log" \
    "$@"
```

- [ ] **Step 1: Write the failing tests** — two more table entries + tests per the Task 3 pattern (no env file for either; antigravity needs `$QUORUM_AGENT_HOME` substituted; assert `ANTIGRAVITY_CONFIG_DIR` and `AGY_CLI_DISABLE_AUTO_UPDATE=true` arrive, HOSTILE absent, `HOME` is the throwaway).

- [ ] **Step 2: Run to verify failure** — `bun test test/launcher-env-isolation.test.ts` → FAIL on the two new agents.

- [ ] **Step 3: Convert the launchers** (code blocks above).

- [ ] **Step 4: Run to verify pass + full check** — `bun test test/launcher-env-isolation.test.ts` then `bun run check` → green.

- [ ] **Step 5: Docs + commit**

In `coding-agents/claude-windows-context/HOWTO.md`, add an "Env isolation exception" note: the local wrapper delegates env to the Windows guest's `launch.cmd`, which applies additive `set` — host-env isolation on that path is guest-side work owned by the Windows trusted-maintainer path (per the platform spec's Windows carve-out), and the wrapper burns the SSH password into argv/`sshpass -p` and the installed launcher file, a known residual tracked by the F13 filesystem follow-up. Grep the other converted agents' HOWTOs for env-inheritance claims and align them to the `env -i` reality.

```bash
git add coding-agents/hermes-context/launch-agent coding-agents/antigravity-context/launch-agent test/launcher-env-isolation.test.ts coding-agents/claude-windows-context/HOWTO.md coding-agents/*-context/HOWTO.md
git commit -m "feat: env -i allowlists for hermes/antigravity launchers; claude-windows exception documented (F13)"
```

---

### Task 5: Gauntlet child env allowlist

**Files:**
- Create: `src/runner/gauntlet-env.ts`
- Modify: `src/runner/index.ts` (lines 1540–1545)
- Test: `test/gauntlet-env.test.ts` (new)

**Interfaces:**
- Consumes: `envSnapshot` (`src/env.ts`), the existing `envBase`/`extraEnv` threading (`src/runner/index.ts:290-295,320-326`), `copilotGauntletEnv` (`src/agents/copilot.ts:96-128` — copilot keeps its stricter list and credentialed-proxy rejection).
- Produces:
  - `GAUNTLET_ENV_ALLOWLIST: readonly string[]`
  - `gauntletEnvBase(host: Readonly<Record<string, string | undefined>>): Record<string, string | undefined>` — pure projection, exported for tests.
  - `src/runner/index.ts:1544-1545` becomes: `const gauntletEnvBaseValue = cfg.name === 'copilot' ? copilotGauntletEnv(envSnapshot()) : gauntletEnvBase(envSnapshot());` threaded as `envBase: gauntletEnvBaseValue` (line 1586). `spawnGauntlet`'s `...(a.envBase ?? envSnapshot())` fallback (line 322) becomes `...a.envBase` — every caller now passes one (there is one caller); delete the full-snapshot default.

The allowlist (base system + network/TLS + tmux + gauntlet runtime + the grader/driver model credential):

```typescript
// src/runner/gauntlet-env.ts
// The gauntlet child is quorum's own QA driver, but the agent under test
// shares its UID — and a same-UID process can read a peer's environment
// (/proc/<pid>/environ on Linux, `ps eww` on macOS). The child therefore gets
// an allowlist projection of the host env, never the full snapshot. The
// adapter-curated extraEnv passthrough (launch substitutions like
// KIMI_ENV_FILE; claude-windows' SSH values by design) is applied by
// spawnGauntlet after this base and is unaffected.
//
// KNOWN RESIDUAL (owned by the F13 filesystem follow-up plan / UID work):
// the allowlist above bounds what quorum's own CHILDREN inherit — but
// same-UID process inspection is not bounded by it. A same-UID agent can
// read a peer process's environment (/proc/<pid>/environ on Linux, `ps eww`
// on macOS), and the quorum parent (and the run-all child) still carry the
// operator's FULL host provider bundle in-process until parent env scoping /
// UID separation lands — so same-UID inspection can still surface every host
// credential, not just the grader's. Technical closure needs UID separation
// in the container, not env scoping alone.
export const GAUNTLET_ENV_ALLOWLIST: readonly string[] = [
  // base system
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HOME',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'TZ',
  'CI',
  'NO_COLOR',
  // network / TLS
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // tmux (the gauntlet TUI adapter drives the agent through a private server)
  'TMUX_TMPDIR',
  // gauntlet runtime
  'GAUNTLET_ROOT',
  // the grader/driver model credential — the ONLY secret the child may see.
  // Verify against the gauntlet CLI's actual env reads (GAUNTLET_ROOT repo)
  // before freezing this list; a too-tight list fails the grader loudly
  // (auth error), never silently.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
];

export function gauntletEnvBase(
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    GAUNTLET_ENV_ALLOWLIST.map((name) => [name, host[name]]),
  );
}
```

- [ ] **Step 1: Verify the grader's env reads (report the method)**

In the gauntlet checkout (`$GAUNTLET_ROOT` / `bun link`ed gauntlet), grep its model/auth resolution for env reads and confirm which of `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (or others) it needs for the configured grader/driver models. Adjust the allowlist's credential section to exactly that set and record the evidence in the task report.

- [ ] **Step 2: Write the failing test**

```typescript
// test/gauntlet-env.test.ts
import { expect, test } from 'bun:test';
import { GAUNTLET_ENV_ALLOWLIST, gauntletEnvBase } from '../src/runner/gauntlet-env.ts';

test('gauntletEnvBase drops the provider bundle and keeps the grader credential', () => {
  const hostile: Record<string, string> = {
    OPENAI_API_KEY: 'sk-host-openai',
    OPENAI_BASE_URL: 'http://evil.example',
    GEMINI_API_KEY: 'sk-host-gemini',
    KIMI_MODEL_API_KEY: 'sk-host-kimi',
    AWS_SECRET_ACCESS_KEY: 'host-aws',
    ANTHROPIC_API_KEY: 'sk-grader',
    PATH: '/usr/bin:/bin',
    TMUX_TMPDIR: '/tmp/tmux',
  };
  const env = gauntletEnvBase(hostile);
  expect(env['OPENAI_API_KEY']).toBeUndefined();
  expect(env['GEMINI_API_KEY']).toBeUndefined();
  expect(env['KIMI_MODEL_API_KEY']).toBeUndefined();
  expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  expect(env['OPENAI_BASE_URL']).toBeUndefined();
  expect(env['ANTHROPIC_API_KEY']).toBe('sk-grader');
  expect(env['PATH']).toBe('/usr/bin:/bin');
  expect(env['TMUX_TMPDIR']).toBe('/tmp/tmux');
});

test('GAUNTLET_ENV_ALLOWLIST carries at most the grader credential names', () => {
  const secretish = GAUNTLET_ENV_ALLOWLIST.filter((n) =>
    /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(n),
  );
  expect(secretish.sort()).toEqual(
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].sort(),
  );
});
```

(If Step 1 revises the credential section, update the second test to match — the point is the credential names are enumerated deliberately, never by pattern.)

- [ ] **Step 3: Run to verify failure** — `bun test test/gauntlet-env.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** `src/runner/gauntlet-env.ts` + the `src/runner/index.ts` wiring (Interfaces above). Note the runner's existing `envBase` doc comment (lines 291–294) describes the old default — update it to describe the allowlist default.

- [ ] **Step 5: Run tests to verify they pass, then full check** — `bun test test/gauntlet-env.test.ts && bun run check` → green.

- [ ] **Step 6: Commit**

```bash
git add src/runner/gauntlet-env.ts src/runner/index.ts test/gauntlet-env.test.ts
git commit -m "feat: gauntlet child env projected onto an allowlist for every agent (F13)"
```

---

## Self-Review

**Spec coverage** (fix-now item 1, bullet 1): "6/12 launchers inherit host env" → Tasks 3–4 (5 conversions + claude-windows documented exception; the count correction to 11 launchers is recorded in recon corrections). "The Gauntlet subprocess env carries the full provider bundle" → Task 5. "Done when a per-agent black-box test proves the agent reaches only its own credential, by env" → the generalized `launcher-env-isolation.test.ts` per-agent hostile-env tests (Tasks 3–4). The "and by filesystem" half is explicitly the follow-on plan (container mount selection + `credentials.env` subsetting + UID separation + run-home retention) — this plan's Scope line says so up front so F13 is not mis-closed. setup.sh + provisioning surfaces (recon findings 3–4) → Tasks 1–2.

**Placeholder scan:** kimi's forward list and pi's extras are discovery-then-freeze items with exact read locations (`kimi.ts:748-793`, `pi.ts` call sites) and a fail-loud backstop (a missed var breaks the launcher loudly, caught by the per-agent test asserting the env-file value arrives); Task 1's corpus scan and Task 5's grader-env verification are named steps with the evidence going in the task reports. No TBDs; every code block is complete except the two explicitly bracketed discovery slots.

**Type consistency:** `provisionSubprocessEnv(extra?)` signature identical in Tasks 2's helper, call sites, and tests; `SETUP_ENV_ALLOWLIST`/`GAUNTLET_ENV_ALLOWLIST`/`gauntletEnvBase` names used consistently; the harness generalization keeps `installLauncher(agent, opts)` shape with a widened union.

**Deliberate scope exclusions (recorded so reviewers don't flag them):** claude-windows guest-side isolation (exception, Task 4); container mounts / `credentials.env` subsetting / UID separation / run-home retention (follow-on plan); `run-all`'s `invokeChild` env spread (`src/run-all/index.ts:202-208`) — the child is `quorum run`, which re-derives everything scoped here at its own seams; deferring the parent-spread scoping is therefore not a child-boundary gap, BUT it is not a free residual: the run-all child (and the quorum parent itself) still carry the operator's FULL host provider bundle in-process, so a same-UID agent can still inspect them and surface every host credential until parent scoping / UID separation (Plan 4 / UID work, same as the Task 5 same-UID residual).
