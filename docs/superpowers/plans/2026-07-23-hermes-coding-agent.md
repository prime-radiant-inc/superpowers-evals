# Hermes Coding-Agent Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `hermes` as a quorum Coding-Agent target that stages the real `.hermes-plugin/` + stock `skills/` from `SUPERPOWERS_ROOT` and runs Hermes Agent against OpenRouter GLM 5.2.

**Architecture:** One YAML config + one provisioning adapter (`HermesAgent`) over the `CommandRunner` seam + one bootstrap-check verb, reusing the already-ported Harbor `normalizeHermes` and the generic `superpowers-bootstrap` scenario. Live smoke validates the undocumented session-log format against the normalizer.

**Tech Stack:** TypeScript on Bun ≥1.3, zod, bun:test. Repo: superpowers-evals (`evals/`).

**Spec:** `docs/superpowers/specs/2026-07-23-hermes-coding-agent-design.md`

**Plan-level refinement of the spec (flagged for maintainer):** the spec called for a new `scenarios/hermes-superpowers-bootstrap`; the repo already has the agent-generic `scenarios/superpowers-bootstrap` whose `pre()` calls the per-harness `bootstrap-installed` dispatcher. Adding a hermes delegate to that dispatcher serves the spec's intent DRY-ly — no new scenario. Everything else follows the spec.

## Global Constraints

- Live evals are trusted-maintainer operations; add nothing live to public CI.
- Per-run state stays under `<run>/home`; never read the operator's real `~/.hermes`.
- Secret-bearing files are written with `writePrivateFileNoFollow` (mode 0600).
- `SUPERPOWERS_ROOT` is the only plugin/skill source; provisioning fails closed when it lacks Hermes support files.
- Subprocesses go through `src/agents/command-runner.ts` so tests inject fakes.
- Verification gate for every task: `bun run check` (biome + tsc + bun test) green.

---

### Task 1: Register the hermes runtime family and agent YAML

**Files:**
- Modify: `src/contracts/agent-config.ts` (KNOWN_RUNTIME_FAMILIES, ~line 13)
- Create: `coding-agents/hermes.yaml`
- Modify: `credentials.yaml` (`openrouter_glm_5_2.harnesses`)
- Test: `test/agent-config.test.ts` (add a load case following the file's existing per-agent cases)

**Interfaces:**
- Consumes: `AgentConfigSchema`, `loadAgentConfig` (existing).
- Produces: a loadable `hermes` `AgentConfig` with `normalizer: 'hermes'`, `default_credential: 'openrouter_glm_5_2'` — Task 2's adapter and Task 5's live run depend on these exact values.

- [ ] **Step 1: Write the failing test** — in `test/agent-config.test.ts`, following the existing "loads <agent> config" cases:

```ts
test('loads hermes config', () => {
  const cfg = loadAgentConfig('coding-agents', 'hermes');
  expect(cfg.name).toBe('hermes');
  expect(cfg.binary).toBe('hermes');
  expect(cfg.home_config_subdir).toBe('.hermes');
  expect(cfg.normalizer).toBe('hermes');
  expect(cfg.default_credential).toBe('openrouter_glm_5_2');
  expect(cfg.required_env).toEqual(['SUPERPOWERS_ROOT']);
});
```

(Match the file's actual loader import/name — if the existing cases call a different helper than `loadAgentConfig`, use that one.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/agent-config.test.ts`
Expected: FAIL (`coding-agents/hermes.yaml` missing).

- [ ] **Step 3: Create `coding-agents/hermes.yaml`**

```yaml
name: hermes
binary: hermes
# Hermes keeps everything under ~/.hermes (config.yaml, .env, plugins/,
# sessions/, logs/); HERMES_HOME can override but quorum's $HOME pinning makes
# the default land inside the throwaway run home.
home_config_subdir: ".hermes"
# Session export format is a single JSON with a `messages` array (Harbor pin
# v0.14.0, src/normalize/hermes.ts). The glob is deliberately wide until the
# Task 5 live smoke confirms the current CLI's layout; tighten it there if the
# observed layout allows.
session_log_dir: "${QUORUM_AGENT_HOME}/.hermes/sessions"
session_log_glob: "**/*.json"
normalizer: hermes
required_env:
  - SUPERPOWERS_ROOT
max_time: 10m
# Mechanism/skill-compliance target: GLM 5.2 via OpenRouter, same credential as
# pi/opencode (spec decision 2). Alternatives via --credential.
default_credential: openrouter_glm_5_2
```

- [ ] **Step 4: Add `'hermes'` to `KNOWN_RUNTIME_FAMILIES`** in `src/contracts/agent-config.ts`, keeping the set alphabetical:

```ts
const KNOWN_RUNTIME_FAMILIES: ReadonlySet<string> = new Set([
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'gemini',
  'hermes',
  'kimi',
  'opencode',
  'pi',
  'serf',
]);
```

- [ ] **Step 5: Add `hermes` to the credential's harness list** in `credentials.yaml` under `openrouter_glm_5_2`:

```yaml
  harnesses: [pi, opencode, hermes]
```

- [ ] **Step 6: Run the test and full static gate**

Run: `bun test test/agent-config.test.ts && bun run check`
Expected: PASS, check green.

- [ ] **Step 7: Commit**

```bash
git add coding-agents/hermes.yaml src/contracts/agent-config.ts credentials.yaml test/agent-config.test.ts
git commit -m "feat(hermes): register hermes runtime family, agent yaml, credential harness"
```

---

### Task 2: HermesAgent provisioning adapter

**Files:**
- Create: `src/agents/hermes.ts`
- Modify: `src/agents/index.ts` (import + `CUSTOM_AGENTS` entry)
- Test: `test/agent-hermes.test.ts`

**Interfaces:**
- Consumes: `CodingAgent`, `RunHome`, `ProvisionError` from `./index.ts`; `CommandRunner` from `./command-runner.ts`; `Credential`; `resolveApiKey` from `../credentials/resolve.ts`; `writePrivateFileNoFollow(path, data)`; `getEnv`/`envSnapshot` from `../env.ts`.
- Produces: `class HermesAgent implements CodingAgent` with `provision(home, runner, credential): Record<string, string>` returning `{}` (all config is file-seeded; no extra launcher env). Registered as `hermes` in `CUSTOM_AGENTS`.

- [ ] **Step 1: Write the failing tests** — `test/agent-hermes.test.ts`. Real helper APIs (verified): `makeTempHome(overrides?)` returns `{home: RunHome, cleanup}` with `home.configDir = <tmp>/coding-agent-config` (NOT pre-created); `FakeCommandRunner(responder?)` records `calls: RecordedCommand[]` (`{command, args, options}`) and returns `{status: 0, stdout: '', stderr: ''}` unless the responder says otherwise; env values are read live from `process.env` via `src/env.ts`, so tests mutate `process.env` with save/restore (the pattern `test/agent-pi.test.ts` uses):

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HermesAgent } from '../src/agents/hermes.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// Save/mutate/restore process.env around a provision call. env.ts reads live,
// so direct mutation with restoration is the established pattern (agent-pi).
function withEnvVars<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// hermes.yaml-shaped config; binary is a real on-PATH executable so the
// Bun.which preflight resolves (mirrors the kimi test's approach).
const HERMES_CONFIG: AgentConfig = {
  name: 'hermes',
  binary: 'sh',
  home_config_subdir: '.hermes',
  session_log_dir: '${QUORUM_AGENT_HOME}/.hermes/sessions',
  session_log_glob: '**/*.json',
  normalizer: 'hermes',
  required_env: ['SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
};

const OPENROUTER_CRED: Credential = {
  model: 'z-ai/glm-5.2',
  api: 'openai-chat',
  base_url: 'https://openrouter.ai/api/v1',
  api_key_env: 'OPENROUTER_API_KEY',
  harnesses: ['hermes'],
} as Credential;

// Stage a SUPERPOWERS_ROOT carrying the four Hermes support files.
function stageSuperpowers(root: string): void {
  mkdirSync(join(root, '.hermes-plugin'), { recursive: true });
  writeFileSync(join(root, '.hermes-plugin', 'plugin.yaml'), 'name: superpowers\n');
  writeFileSync(join(root, '.hermes-plugin', '__init__.py'), 'def register(ctx): pass\n');
  mkdirSync(join(root, 'skills', 'using-superpowers', 'references'), {
    recursive: true,
  });
  writeFileSync(
    join(root, 'skills', 'using-superpowers', 'SKILL.md'),
    '---\nname: using-superpowers\n---\n',
  );
  writeFileSync(
    join(root, 'skills', 'using-superpowers', 'references', 'hermes-tools.md'),
    '# hermes tools\n',
  );
}

function provisionOk() {
  const { home, cleanup } = makeTempHome();
  const sproot = join(home.workdir, 'superpowers-src');
  stageSuperpowers(sproot);
  const runner = new FakeCommandRunner();
  const agent = new HermesAgent(HERMES_CONFIG);
  const extra = withEnvVars(
    { SUPERPOWERS_ROOT: sproot, OPENROUTER_API_KEY: 'or-key-123' },
    () => agent.provision(home, runner, OPENROUTER_CRED),
  );
  return { home, runner, extra, cleanup };
}

test('provision seeds config.yaml with the openrouter provider and model', () => {
  const { home, cleanup } = provisionOk();
  const cfg = readFileSync(join(home.configDir, 'config.yaml'), 'utf8');
  expect(cfg).toContain('provider: "openrouter"');
  expect(cfg).toContain('default: "z-ai/glm-5.2"');
  expect(cfg).toContain('base_url: "https://openrouter.ai/api/v1"');
  cleanup();
});

test('provision writes .env mode 0600 with the credential key', () => {
  const { home, cleanup } = provisionOk();
  const envPath = join(home.configDir, '.env');
  expect(readFileSync(envPath, 'utf8')).toBe('OPENROUTER_API_KEY=or-key-123\n');
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
  cleanup();
});

test('provision stages the plugin + stock skills co-located', () => {
  const { home, cleanup } = provisionOk();
  const plug = join(home.configDir, 'plugins', 'superpowers');
  expect(existsSync(join(plug, 'plugin.yaml'))).toBe(true);
  expect(existsSync(join(plug, '__init__.py'))).toBe(true);
  expect(existsSync(join(plug, 'skills', 'using-superpowers', 'SKILL.md'))).toBe(true);
  cleanup();
});

test('provision enables the plugin through the runner with HOME pinned', () => {
  const { home, runner, cleanup } = provisionOk();
  expect(runner.calls.length).toBe(1);
  const call = runner.calls[0];
  expect(call?.command).toBe('sh');
  expect(call?.args).toEqual(['plugins', 'enable', 'superpowers']);
  // The adapter pins HOME to the parent of configDir (the run home).
  expect(call?.options?.env?.['HOME']).toBe(dirname(home.configDir));
  expect(call?.options?.env?.['HERMES_HOME']).toBe(home.configDir);
  cleanup();
});

test('provision fails closed when SUPERPOWERS_ROOT lacks .hermes-plugin', () => {
  const { home, cleanup } = makeTempHome();
  const sproot = join(home.workdir, 'bare-src');
  mkdirSync(join(sproot, 'skills', 'using-superpowers'), { recursive: true });
  const agent = new HermesAgent(HERMES_CONFIG);
  expect(() =>
    withEnvVars({ SUPERPOWERS_ROOT: sproot, OPENROUTER_API_KEY: 'k' }, () =>
      agent.provision(home, new FakeCommandRunner(), OPENROUTER_CRED),
    ),
  ).toThrow(ProvisionError);
  cleanup();
});

test('provision fails when the enable subprocess exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const sproot = join(home.workdir, 'superpowers-src');
  stageSuperpowers(sproot);
  const runner = new FakeCommandRunner(() => ({
    status: 1,
    stdout: '',
    stderr: 'no such plugin',
  }));
  const agent = new HermesAgent(HERMES_CONFIG);
  expect(() =>
    withEnvVars({ SUPERPOWERS_ROOT: sproot, OPENROUTER_API_KEY: 'k' }, () =>
      agent.provision(home, runner, OPENROUTER_CRED),
    ),
  ).toThrow(ProvisionError);
  cleanup();
});

test('provision requires a credential', () => {
  const { home, cleanup } = makeTempHome();
  const sproot = join(home.workdir, 'superpowers-src');
  stageSuperpowers(sproot);
  const agent = new HermesAgent(HERMES_CONFIG);
  expect(() =>
    withEnvVars({ SUPERPOWERS_ROOT: sproot, OPENROUTER_API_KEY: 'k' }, () =>
      agent.provision(home, new FakeCommandRunner(), undefined),
    ),
  ).toThrow(ProvisionError);
  cleanup();
});
```

One remaining verify-at-write point: `resolveApiKey`'s exact return shape — mirror how `src/agents/pi.ts` consumes `ApiKeyResolution` and match the field names in both the adapter and, if the tests exercise the failure leg, the test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/agent-hermes.test.ts`
Expected: FAIL (`src/agents/hermes.ts` does not exist).

- [ ] **Step 3: Implement `src/agents/hermes.ts`**

```ts
import { cpSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { resolveApiKey } from '../credentials/resolve.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

// Hermes support files a usable SUPERPOWERS_ROOT must contain. The plugin dir
// and the using-superpowers skill + hermes-tools reference are what make a
// Hermes run actually load Superpowers; a checkout missing any of them (e.g.
// dev before the hermes-harness branch merges) must fail loudly at setup.
const HERMES_SUPPORT_FILES = [
  join('.hermes-plugin', 'plugin.yaml'),
  join('.hermes-plugin', '__init__.py'),
  join('skills', 'using-superpowers', 'SKILL.md'),
  join('skills', 'using-superpowers', 'references', 'hermes-tools.md'),
] as const;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function requireHermesEnv(name: string, purpose: string): string {
  const value = getEnv(name);
  if (value === undefined || value === '') {
    throw new ProvisionError(`${name} not set; cannot ${purpose}`);
  }
  return value;
}

function requireHermesSuperpowersSource(superpowersRoot: string): void {
  const missing = HERMES_SUPPORT_FILES.map((rel) =>
    join(superpowersRoot, rel),
  ).filter((path) => !isFile(path));
  if (missing.length > 0) {
    throw new ProvisionError(
      `SUPERPOWERS_ROOT is missing Hermes support files (needs a checkout ` +
        `containing .hermes-plugin/, e.g. the hermes-harness branch): ` +
        missing.join(', '),
    );
  }
}

// Provider selection: OpenRouter endpoints use hermes' first-class
// `openrouter` provider and read OPENROUTER_API_KEY; any other
// OpenAI-compatible base_url uses provider `custom` and reads OPENAI_API_KEY.
// (Hermes config reference: user-guide/configuration.)
function hermesProviderFor(baseUrl: string): {
  provider: string;
  keyEnvName: string;
} {
  if (new URL(baseUrl).hostname.endsWith('openrouter.ai')) {
    return { provider: 'openrouter', keyEnvName: 'OPENROUTER_API_KEY' };
  }
  return { provider: 'custom', keyEnvName: 'OPENAI_API_KEY' };
}

/** Hermes provisioning: seed config.yaml + .env under <runHome>/.hermes, stage
 *  the Superpowers plugin + stock skills from SUPERPOWERS_ROOT co-located at
 *  plugins/superpowers/, and enable it via `hermes plugins enable` with HOME
 *  pinned to the run home. Returns no extra launcher env. */
export class HermesAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(
    home: RunHome,
    runner: CommandRunner,
    credential?: Credential,
  ): Record<string, string> {
    const superpowersRoot = requireHermesEnv(
      'SUPERPOWERS_ROOT',
      'stage the Superpowers plugin for Hermes',
    );
    requireHermesSuperpowersSource(superpowersRoot);

    if (Bun.which(this.config.binary, { PATH: envSnapshot()['PATH'] ?? '' }) === null) {
      throw new ProvisionError(
        `${this.config.binary} not found on PATH; cannot run Hermes evals`,
      );
    }

    if (credential === undefined) {
      throw new ProvisionError(
        'hermes requires a credential (default: openrouter_glm_5_2)',
      );
    }
    if (credential.api !== 'openai-chat' || credential.base_url === undefined) {
      throw new ProvisionError(
        `hermes supports only openai-chat credentials with a base_url; got ` +
          `api=${credential.api}`,
      );
    }
    const apiKey = resolveApiKey(credential);
    if (apiKey.kind !== 'ok') {
      throw new ProvisionError(
        `hermes: could not resolve api key from credential: ${apiKey.detail}`,
      );
    }

    const configDir = home.configDir;
    mkdirSync(configDir, { recursive: true });

    const { provider, keyEnvName } = hermesProviderFor(credential.base_url);
    const configYaml = [
      '# Generated by quorum HermesAgent.provision — per-run throwaway config.',
      'model:',
      `  default: "${credential.model}"`,
      `  provider: "${provider}"`,
      `  base_url: "${credential.base_url}"`,
      '',
    ].join('\n');
    writePrivateFileNoFollow(join(configDir, 'config.yaml'), configYaml);
    writePrivateFileNoFollow(
      join(configDir, '.env'),
      `${keyEnvName}=${apiKey.value}\n`,
    );

    // Stage the plugin: .hermes-plugin/* plus the stock skills tree, co-located
    // the way the plugin loader expects (plugins/superpowers/{plugin.yaml,
    // __init__.py, skills/...}).
    const pluginDir = join(configDir, 'plugins', 'superpowers');
    mkdirSync(pluginDir, { recursive: true });
    cpSync(join(superpowersRoot, '.hermes-plugin'), pluginDir, {
      recursive: true,
    });
    cpSync(join(superpowersRoot, 'skills'), join(pluginDir, 'skills'), {
      recursive: true,
      dereference: true,
    });

    // Enable through the CLI (documented: `hermes plugins enable <name>`),
    // with HOME pinned to the run home so it edits the throwaway config.
    const runHomeDir = dirname(configDir);
    const result = runner.run(
      this.config.binary,
      ['plugins', 'enable', 'superpowers'],
      {
        env: { ...envSnapshot(), HOME: runHomeDir, HERMES_HOME: configDir },
      },
    );
    if (result.status !== 0) {
      throw new ProvisionError(
        `hermes plugins enable failed (status ${String(result.status)}): ` +
          `${result.stderr || result.stdout}`,
      );
    }

    return {};
  }
}
```

Implementation notes (resolve against the real code, not by guessing):
- `resolveApiKey`'s return shape — mirror how `src/agents/pi.ts` consumes `ApiKeyResolution` (kind/value/detail names must match the actual type).
- If `Credential`'s zod type marks `base_url` optional-nullable differently, adjust the guard to the real field type.
- Keep the `HERMES_HOME` env explicit even though HOME pinning implies it — belt and suspenders against hermes resolving `~` differently in subprocesses. Drop it only if the live smoke shows it confuses the CLI.

- [ ] **Step 4: Register in `src/agents/index.ts`**

```ts
import { HermesAgent } from './hermes.ts';
// ... in CUSTOM_AGENTS:
  hermes: (config) => new HermesAgent(config),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/agent-hermes.test.ts && bun run check`
Expected: PASS, check green.

- [ ] **Step 6: Commit**

```bash
git add src/agents/hermes.ts src/agents/index.ts test/agent-hermes.test.ts
git commit -m "feat(hermes): HermesAgent provisioning adapter — config, .env, plugin staging, enable"
```

---

### Task 3: `bootstrap-installed` delegate for hermes

**Files:**
- Modify: `src/check/fs-verbs.ts` (new verb function + `BOOTSTRAP_DELEGATES` entry, ~line 993)
- Test: `test/fs-verbs-bootstrap.test.ts` (add hermes cases following the file's existing per-harness cases)

**Interfaces:**
- Consumes: `CheckContext` (`ctx.env('QUORUM_AGENT_CONFIG_DIR')`), `filesExistUnder`, `pass`/`fail` — all existing in `fs-verbs.ts`.
- Produces: `verbHermesPluginStaged` wired as `BOOTSTRAP_DELEGATES.hermes`, so the generic `superpowers-bootstrap` scenario's `pre()` gains a hermes leg.

- [ ] **Step 1: Write the failing test** — in `test/fs-verbs-bootstrap.test.ts`, using the file's existing `configDir()`, `writeUnder()`, and `ctxFor()` helpers exactly as the antigravity cases do:

```ts
// ---------------------------------------------------------------------------
// hermes-plugin-staged: <configDir>/plugins/superpowers
// ---------------------------------------------------------------------------
const HERMES_SUBPATH = 'plugins/superpowers';
const HERMES_FILES = [
  'plugin.yaml',
  '__init__.py',
  'skills/using-superpowers/SKILL.md',
];

test('hermes-plugin-staged passes when the plugin files exist', () => {
  const cfg = configDir();
  for (const rel of HERMES_FILES) {
    writeUnder(cfg, join(HERMES_SUBPATH, rel));
  }
  const out = verbHermesPluginStaged([], ctxFor(cfg));
  expect(out.passed).toBe(true);
});

test('hermes-plugin-staged fails when a plugin file is missing', () => {
  const cfg = configDir();
  for (const rel of HERMES_FILES.slice(0, -1)) {
    writeUnder(cfg, join(HERMES_SUBPATH, rel));
  }
  const out = verbHermesPluginStaged([], ctxFor(cfg));
  expect(out.passed).toBe(false);
});

test('hermes-plugin-staged fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const out = verbHermesPluginStaged([], {
    cwd: '/tmp',
    env: () => undefined,
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});
```

Import `verbHermesPluginStaged` alongside the file's existing verb imports.

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/fs-verbs-bootstrap.test.ts`
Expected: FAIL (unknown delegate `hermes` → the dispatcher's unknown-agent fail path, or missing function).

- [ ] **Step 3: Implement the verb** in `src/check/fs-verbs.ts`, next to the other `*-plugin-installed` verbs:

```ts
// hermes-plugin-staged — the Superpowers plugin dir HermesAgent.provision
// stages under the run home: plugin manifest, loader, and the stock skills.
export function verbHermesPluginStaged(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const configDir = ctx.env('QUORUM_AGENT_CONFIG_DIR');
  if (!configDir) {
    return fail('QUORUM_AGENT_CONFIG_DIR is not set');
  }
  const root = join(configDir, 'plugins/superpowers');
  const result = filesExistUnder(root, [
    'plugin.yaml',
    '__init__.py',
    'skills/using-superpowers/SKILL.md',
  ]);
  if (result.passed) {
    return pass(`Superpowers plugin staged at ${root}`);
  }
  return fail(`missing Hermes Superpowers plugin files: ${result.detail}`);
}
```

And in `BOOTSTRAP_DELEGATES` (alphabetical):

```ts
  hermes: verbHermesPluginStaged,
```

- [ ] **Step 4: Run tests**

Run: `bun test test/fs-verbs-bootstrap.test.ts && bun run check`
Expected: PASS, check green.

- [ ] **Step 5: Commit**

```bash
git add src/check/fs-verbs.ts test/fs-verbs-bootstrap.test.ts
git commit -m "feat(hermes): bootstrap-installed delegate checks the staged plugin"
```

---

### Task 4: HOWTO + docs

**Files:**
- Create: `coding-agents/hermes-context/HOWTO.md`
- Modify: `docs/coding-agent-care-and-feeding.md` (add a Hermes section following the per-agent section pattern)
- Modify: `README.md` (agent lists: the intro sentence, the "Live Eval Risk" list, and the agent-config-collapse list)

**Interfaces:**
- Consumes: Task 1's yaml values (paths, credential); Task 2's provisioning behavior (what is already seeded — the HOWTO must not re-do provisioning).
- Produces: the Gauntlet-Agent-facing launch contract for hermes.

- [ ] **Step 1: Write `coding-agents/hermes-context/HOWTO.md`**

```markdown
# Driving Hermes Agent

Hermes Agent is a terminal REPL. Provisioning has already seeded
`$HOME/.hermes/` (config.yaml with the OpenRouter model, `.env` with the API
key) and staged + enabled the Superpowers plugin — do not install or
configure anything yourself.

## Launch

From the scenario workdir, run:

    hermes --yes --no-memory

- `--yes` auto-approves command execution so the run never blocks on an
  approval prompt.
- `--no-memory` disables cross-session memory; each eval run must be
  memoryless.

Wait for the input prompt before typing. Type the story's message exactly and
press Enter.

## Observing progress

- The session transcript accumulates under `$HOME/.hermes/sessions/`.
- Errors and gateway traces: `$HOME/.hermes/logs/errors.log` and
  `$HOME/.hermes/logs/gateway.log`.

## Completion

The turn is complete when Hermes returns to its input prompt with no spinner
or streaming output. When the story's task is done, exit the REPL (`/exit`,
or Ctrl-D at the prompt) so the session file is finalized before capture.

## Quirks

(Record real quirks discovered during live smokes here — startup banner
noise, prompt-detection strings, plugin-load messages worth waiting for.)
```

Verify the exit command against the real CLI during the Task 5 smoke (`/exit` vs `/quit` vs Ctrl-D) and correct this file — do not leave an unverified exit instruction.

- [ ] **Step 2: Add the care-and-feeding section** to `docs/coding-agent-care-and-feeding.md`, following the existing per-agent shape (auth, config collapse, capture, gotchas):

```markdown
## Hermes Agent

- **Auth:** OpenRouter API key only (`OPENROUTER_API_KEY`, via the
  `openrouter_glm_5_2` credential). No OAuth path is wired.
- **Config collapse:** everything under `<run>/home/.hermes/` — config.yaml,
  `.env` (0600), `plugins/superpowers/` (staged from `SUPERPOWERS_ROOT`),
  `sessions/`, `logs/`.
- **Superpowers source:** provisioning requires `.hermes-plugin/` in
  `SUPERPOWERS_ROOT` and fails closed without it. Until that branch merges to
  superpowers dev, point `SUPERPOWERS_ROOT` at a `hermes-harness-rebase`
  checkout.
- **Known state:** the shipped plugin's `on_session_start` +
  `ctx.inject_message` mechanism is unverified against the documented plugin
  API; the bootstrap scenario's RED result on the unfixed plugin is the
  expected baseline, not a harness bug. See the design spec
  (2026-07-23-hermes-coding-agent-design.md).
- **Capture:** session export JSON (`messages` array) from
  `~/.hermes/sessions/`, normalized by the Harbor-ported `normalizeHermes`
  (pin v0.14.0). If the current CLI's session layout drifts from the pin,
  fix the normalizer with a captured fixture — do not loosen the strict
  empty-trace failure.
```

- [ ] **Step 3: Update `README.md` agent lists** — add Hermes to the intro list of driven CLIs, the Live Eval Risk bullet list (`Hermes uses --yes and API-key auth in the run-local .env`), and the config-collapse parenthetical (`Hermes .hermes`).

- [ ] **Step 4: Static gate**

Run: `bun run check`
Expected: green (docs changes don't break lint).

- [ ] **Step 5: Commit**

```bash
git add coding-agents/hermes-context/HOWTO.md docs/coding-agent-care-and-feeding.md README.md
git commit -m "docs(hermes): HOWTO, care-and-feeding entry, README agent lists"
```

---

### Task 5: Container session-format smoke (live, trusted-maintainer)

**Files:**
- Possibly modify: `coding-agents/hermes.yaml` (`session_log_glob` tightening), `src/normalize/hermes.ts` + `test/normalize.hermes.test.ts` (only if the real format drifted from the Harbor pin), `coding-agents/hermes-context/HOWTO.md` (exit command, quirks)

**Interfaces:**
- Consumes: the built container (hermes CLI already installed), `OPENROUTER_API_KEY`.
- Produces: a verified `session_log_dir`/`session_log_glob` pair and a captured real-session fixture committed into `test/normalize.hermes.test.ts` (as a new test case) if and only if the format differs from the Harbor pin.

- [ ] **Step 1: Build the container**

Run: `orb start && scripts/evals-container build`
Expected: build succeeds (hermes install layer already exists; `hermes version` gate passes).

- [ ] **Step 2: One-turn live probe inside the container**

Run (with the key exported; scratch HOME inside the container):

```bash
docker run --rm -e OPENROUTER_API_KEY superpowers-evals:local bash -lc '
  export HOME=/tmp/hermes-probe && mkdir -p $HOME/.hermes
  printf "model:\n  default: \"z-ai/glm-5.2\"\n  provider: \"openrouter\"\n  base_url: \"https://openrouter.ai/api/v1\"\n" > $HOME/.hermes/config.yaml
  printf "OPENROUTER_API_KEY=%s\n" "$OPENROUTER_API_KEY" > $HOME/.hermes/.env
  cd /tmp && hermes chat "Reply with the single word: pong" || true
  echo "--- sessions ---"; find $HOME/.hermes/sessions -type f | head
  echo "--- first file head ---"; find $HOME/.hermes/sessions -type f | head -1 | xargs head -c 2000
'
```

Expected: a completed one-turn chat; at least one session file; its head shows the JSON shape.

- [ ] **Step 3: Compare against the normalizer's expectations**

The Harbor pin expects a single JSON object with `id` and a `messages` array (`role`/`content`/`tool_calls`). If the observed file matches: tighten `session_log_glob` in `coding-agents/hermes.yaml` to the observed layout (e.g. `*.json` if flat) and record the observed path shape in the HOWTO. If it does NOT match: save the (secret-scrubbed) observed file as a fixture-based test case in `test/normalize.hermes.test.ts`, adjust `src/normalize/hermes.ts` to parse the real format (keeping the Harbor-pin test cases passing if the old shape remains parseable), and re-run `bun test test/normalize.hermes.test.ts`.

- [ ] **Step 4: Verify the plugin-enable command headlessly**

```bash
docker run --rm superpowers-evals:local bash -lc '
  export HOME=/tmp/hermes-probe2 && mkdir -p $HOME/.hermes/plugins/superpowers
  printf "name: superpowers\nversion: 6.0.3\ndescription: x\n" > $HOME/.hermes/plugins/superpowers/plugin.yaml
  printf "def register(ctx):\n    pass\n" > $HOME/.hermes/plugins/superpowers/__init__.py
  hermes plugins enable superpowers && hermes plugins list
'
```

Expected: enable succeeds and list shows `superpowers` enabled. If the CLI wants different arguments, fix `HermesAgent.provision`'s runner call and `test/agent-hermes.test.ts` accordingly.

- [ ] **Step 5: Commit whatever the smoke corrected**

```bash
git add -u coding-agents src/normalize test docs
git commit -m "fix(hermes): align session glob / normalizer / enable command with observed CLI behavior"
```

(Skip the commit if nothing needed correction — say so in the task report.)

---

### Task 6: Live bootstrap smoke + experiment log

**Files:**
- Create: `docs/experiments/2026-07-23-hermes-target-bringup.md`

**Interfaces:**
- Consumes: everything above; a `hermes-harness-rebase` checkout of superpowers as `SUPERPOWERS_ROOT`.
- Produces: the recorded RED (expected) or GREEN verdict for the shipped plugin mechanism — the empirical answer the spec asks for.

- [ ] **Step 1: Run the generic bootstrap scenario against hermes**

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers-hermes-rebase-checkout
bun run quorum run scenarios/superpowers-bootstrap --coding-agent hermes
bun run quorum show
```

Expected: the run completes with a verdict (not a setup-stage indeterminate). Verify per the adding-a-coding-agent checklist: CLI launched under `<run>/home`; plugin staged from `SUPERPOWERS_ROOT`; raw session evidence under `<run>/home/.hermes/sessions/`; `<run>/trajectory.json` non-empty; secrets confined to `results/`.

- [ ] **Step 2: Record the outcome** in `docs/experiments/2026-07-23-hermes-target-bringup.md`: hypothesis (shipped `inject_message` mechanism does not fire → bootstrap RED), config (credential, SUPERPOWERS_ROOT ref, container digest), run pointers, verdict, and next step (the superpowers-side `pre_llm_call`/`register_skill` fix validated by re-running this same scenario). Negative results at equal billing.

- [ ] **Step 3: Commit**

```bash
git add docs/experiments/2026-07-23-hermes-target-bringup.md
git commit -m "docs(experiments): hermes target bring-up — bootstrap verdict on the shipped plugin"
```
