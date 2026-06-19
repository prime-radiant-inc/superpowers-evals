# Grok Build Quorum Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `grok` as a first-class Quorum Coding-Agent target for normal Grok Build CLI operation.

**Architecture:** Grok gets its own runtime family, provisioning adapter, context launcher, cwd filter, normalizer, and private debug usage bridge. Transcript capture remains ATIF-first: Grok `chat_history.jsonl` normalizes to `trajectory.json`, sanitized debug token buckets merge into ATIF final metrics before pricing, and obol remains the only cost path.

**Tech Stack:** TypeScript on Bun, Quorum runner/capture APIs, ATIF v1.7, `@primeradianthq/obol`, Grok CLI `grok`, xAI `XAI_API_KEY`, shell launchers.

## Global Constraints

- Baseline launcher is normal Grok Build CLI: `grok`; do not add `--agent`, `--model`, or `-m`.
- Auth is API-key-first: require `XAI_API_KEY` and do not copy host `~/.grok/auth.json`.
- Superpowers v1 provisioning uses `.grok/config.toml` with `[plugins].paths = ["${SUPERPOWERS_ROOT}"]`.
- Raw Grok debug logs are secret-bearing and must never live under the run artifact tree.
- Token usage enters Quorum exactly once through ATIF `trajectory.json`; no raw-log cost calculator.
- Grok v1 OS support is Linux only: `os_support: [linux]`.
- Do not add Quorum-maintained Grok price math. Grok Build rates belong in obol.
- Use TDD for each task: write the failing test, prove it fails, implement the smallest change, prove it passes.
- Before code execution starts, inspect `git status --short`; never overwrite unrelated user changes.

---

## File Structure

- Create `coding-agents/grok.yaml`: declarative target config.
- Create `coding-agents/grok-context/HOWTO.md`: Gauntlet-facing launch instructions.
- Create `coding-agents/grok-context/launch-agent`: shell launcher for normal `grok`.
- Create `src/agents/grok.ts`: Grok provisioning adapter and private runtime-file helpers.
- Create `src/normalize/grok.ts`: `chat_history.jsonl` to ATIF normalizer.
- Create `src/capture/grok-usage.ts`: debug-log token parser, final-metrics merger, and cleanup guard.
- Create `test/agent-grok.test.ts`: provisioning tests.
- Create `test/normalize.grok.test.ts`: normalizer tests.
- Create `test/grok-usage.test.ts`: private debug usage tests.
- Modify `src/contracts/agent-config.ts`: register `grok` runtime family.
- Modify `src/agents/index.ts`: export and resolve `GrokAgent`.
- Modify `src/runner/index.ts`: Grok substitutions, context requirement, cleanup dirs, env redaction, capture args, strict capture.
- Modify `src/capture/index.ts`: register normalizer, pass source-log context, merge Grok debug usage before writing `trajectory.json`.
- Modify `src/capture/cwd-filter.ts`: filter Grok logs by encoded cwd path segment.
- Modify `src/check/fs-verbs.ts` and `src/check/dispatch.ts`: add Grok bootstrap check.
- Modify `docs/superpowers/reference/atif-normalizers.md`: add Grok row.
- Modify existing tests: `test/agent-config.test.ts`, `test/agents-resolve.test.ts`, `test/runner-context.test.ts`, `test/runner-cleanup.test.ts`, `test/cwd-filter.test.ts`, `test/fs-verbs-bootstrap.test.ts`, `test/capture.test.ts`, `test/obol.test.ts`.
- Add sanitized fixtures under `test/fixtures/grok/`.

---

### Task 1: Static Target Registration

**Files:**
- Create: `coding-agents/grok.yaml`
- Create: `src/agents/grok.ts`
- Modify: `src/contracts/agent-config.ts`
- Modify: `src/agents/index.ts`
- Modify: `src/check/fs-verbs.ts`
- Modify: `src/check/dispatch.ts`
- Modify: `test/agent-config.test.ts`
- Modify: `test/agents-resolve.test.ts`
- Modify: `test/fs-verbs-bootstrap.test.ts`

**Interfaces:**
- Produces: `GrokAgent implements CodingAgent`
- Produces: `verbGrokPluginConfigured(args: string[], ctx: CheckContext): CheckOutcome`
- Produces: `coding-agents/grok.yaml` with `home_config_subdir: ".grok"`
- Consumes: existing `AgentConfigSchema`, `resolveAgent`, `verbBootstrapInstalled`

- [ ] **Step 1: Write failing config and resolver tests**

Add to `test/agent-config.test.ts`:

```ts
function withEnvVars(
  vars: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('loads grok yaml-shaped config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeYaml(dir, 'grok', [
    'name: grok',
    'binary: grok',
    'home_config_subdir: ".grok"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.grok/sessions"',
    'session_log_glob: "**/chat_history.jsonl"',
    'normalizer: grok',
    'required_env:',
    '  - XAI_API_KEY',
    '  - SUPERPOWERS_ROOT',
    'max_time: 10m',
    'os_support: [linux]',
  ]);
  withEnvVars(
    { XAI_API_KEY: 'xai-test', SUPERPOWERS_ROOT: '/tmp/superpowers' },
    () => {
      const cfg = loadAgentConfig(dir, 'grok');
      expect(cfg.name).toBe('grok');
      expect(cfg.home_config_subdir).toBe('.grok');
      expect(cfg.normalizer).toBe('grok');
      expect(cfg.required_env).toEqual(['XAI_API_KEY', 'SUPERPOWERS_ROOT']);
      expect(cfg.os_support).toEqual(['linux']);
    },
  );
});
```

Add to `test/agents-resolve.test.ts`:

```ts
import { GrokAgent } from '../src/agents/grok.ts';

test('resolveAgent dispatches grok to GrokAgent', () => {
  expect(resolveAgent(cfg('grok'))).toBeInstanceOf(GrokAgent);
});
```

- [ ] **Step 2: Write failing bootstrap tests**

Add to `test/fs-verbs-bootstrap.test.ts`:

```ts
test('grok-plugin-configured accepts plugins.paths pointing at SUPERPOWERS_ROOT', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'grok-home-'));
  const spRoot = mkdtempSync(join(tmpdir(), 'superpowers-'));
  mkdirSync(join(spRoot, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(
    join(spRoot, 'skills', 'using-superpowers', 'SKILL.md'),
    '# using-superpowers\n',
  );
  writeFileSync(
    join(configDir, 'config.toml'),
    `[plugins]\npaths = ["${spRoot}"]\n`,
  );

  const out = verbGrokPluginConfigured([], {
    cwd: '/tmp',
    env: (key) =>
      key === 'QUORUM_AGENT_CONFIG_DIR'
        ? configDir
        : key === 'SUPERPOWERS_ROOT'
          ? spRoot
          : undefined,
  });

  expect(out.passed).toBe(true);
});

test('bootstrap-installed routes to the grok plugin check', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'grok-home-'));
  const spRoot = mkdtempSync(join(tmpdir(), 'superpowers-'));
  mkdirSync(join(spRoot, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(
    join(spRoot, 'skills', 'using-superpowers', 'SKILL.md'),
    '# using-superpowers\n',
  );
  writeFileSync(
    join(configDir, 'config.toml'),
    `[plugins]\npaths = ["${spRoot}"]\n`,
  );

  const out = verbBootstrapInstalled([], {
    cwd: '/tmp',
    env: (key) =>
      ({
        QUORUM_CODING_AGENT: 'grok',
        QUORUM_AGENT_CONFIG_DIR: configDir,
        SUPERPOWERS_ROOT: spRoot,
      })[key],
  });

  expect(out.passed).toBe(true);
});
```

Also add `verbGrokPluginConfigured` to the imports in that file.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
bun test test/agent-config.test.ts test/agents-resolve.test.ts test/fs-verbs-bootstrap.test.ts
```

Expected: failures mention unknown runtime family `grok`, missing `GrokAgent`, missing `verbGrokPluginConfigured`, or unrecognized coding-agent `grok`.

- [ ] **Step 4: Add static Grok config**

Create `coding-agents/grok.yaml`:

```yaml
name: grok
binary: grok
home_config_subdir: ".grok"
session_log_dir: "${QUORUM_AGENT_HOME}/.grok/sessions"
session_log_glob: "**/chat_history.jsonl"
normalizer: grok
required_env:
  - XAI_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
os_support: [linux]
```

- [ ] **Step 5: Add minimal Grok agent registration**

In `src/contracts/agent-config.ts`, add `grok` to `KNOWN_RUNTIME_FAMILIES`.

Create `src/agents/grok.ts`:

```ts
import { mkdirSync } from 'node:fs';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { CommandRunner } from './command-runner.ts';
import type { CodingAgent, RunHome } from './index.ts';

export class GrokAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome, _runner: CommandRunner): Record<string, string> {
    mkdirSync(home.configDir, { recursive: true });
    return {};
  }
}
```

In `src/agents/index.ts`, import `GrokAgent` and add it to `CUSTOM_AGENTS`:

```ts
import { GrokAgent } from './grok.ts';

const CUSTOM_AGENTS: Readonly<
  Record<string, (config: AgentConfig) => CodingAgent>
> = {
  codex: (config) => new CodexAgent(config),
  gemini: (config) => new GeminiAgent(config),
  pi: (config) => new PiAgent(config),
  copilot: (config) => new CopilotAgent(config),
  opencode: (config) => new OpenCodeAgent(config),
  kimi: (config) => new KimiAgent(config),
  antigravity: (config) => new AntigravityAgent(config),
  grok: (config) => new GrokAgent(config),
};
```

- [ ] **Step 6: Add Grok bootstrap check**

In `src/check/fs-verbs.ts`, add:

```ts
// grok-plugin-configured
export function verbGrokPluginConfigured(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const configDir = ctx.env('QUORUM_AGENT_CONFIG_DIR');
  if (!configDir) {
    return fail('QUORUM_AGENT_CONFIG_DIR is not set');
  }
  const superpowersRoot = ctx.env('SUPERPOWERS_ROOT');
  if (!superpowersRoot) {
    return fail('SUPERPOWERS_ROOT is not set');
  }
  const config = join(configDir, 'config.toml');
  if (!isFile(config)) {
    return fail(`missing Grok config at ${config}`);
  }
  const toml = readFileSync(config, 'utf8');
  if (!toml.includes('[plugins]')) {
    return fail('Grok config missing [plugins] table');
  }
  if (!toml.includes(superpowersRoot)) {
    return fail('Grok config plugins.paths does not include SUPERPOWERS_ROOT');
  }
  if (!isFile(join(superpowersRoot, 'skills/using-superpowers/SKILL.md'))) {
    return fail('SUPERPOWERS_ROOT missing skills/using-superpowers/SKILL.md');
  }
  return pass(`Grok Superpowers path configured from ${superpowersRoot}`);
}
```

Add `grok: verbGrokPluginConfigured` to `BOOTSTRAP_DELEGATES`.

In `src/check/dispatch.ts`, import `verbGrokPluginConfigured` and add:

```ts
'grok-plugin-configured': verbGrokPluginConfigured,
```

- [ ] **Step 7: Run registration tests**

Run:

```bash
bun test test/agent-config.test.ts test/agents-resolve.test.ts test/fs-verbs-bootstrap.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```bash
git add coding-agents/grok.yaml src/contracts/agent-config.ts src/agents/index.ts src/agents/grok.ts src/check/fs-verbs.ts src/check/dispatch.ts test/agent-config.test.ts test/agents-resolve.test.ts test/fs-verbs-bootstrap.test.ts
git commit -m "feat: register grok target"
```

---

### Task 2: Grok Provisioning And Private Runtime Files

**Files:**
- Modify: `src/agents/grok.ts`
- Create: `test/agent-grok.test.ts`

**Interfaces:**
- Produces: `GrokAgent.provision(home, runner): Record<string, string>`
- Produces: `GROK_RUNTIME_ENV_FILE_NAME`
- Produces: `writeGrokRuntimeEnvFile(env, opts): { envFile: string; debugFile: string }`
- Produces extra env keys: `GROK_ENV_FILE`, `GROK_DEBUG_FILE`
- Consumes: `writePrivateFileNoFollow`, `getEnv`, `CommandRunner`

- [ ] **Step 1: Write failing provisioner tests**

Create `test/agent-grok.test.ts`:

```ts
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
} from '../src/agents/command-runner.ts';
import { GrokAgent } from '../src/agents/grok.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

const GROK_CONFIG: AgentConfig = {
  name: 'grok',
  binary: 'grok',
  home_config_subdir: '.grok',
  session_log_dir: '${QUORUM_AGENT_HOME}/.grok/sessions',
  session_log_glob: '**/chat_history.jsonl',
  normalizer: 'grok',
  required_env: ['XAI_API_KEY', 'SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
};

function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const [key, value] of prev.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function stageSuperpowers(root: string): void {
  for (const skill of [
    'using-superpowers',
    'brainstorming',
    'test-driven-development',
    'writing-plans',
  ]) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
}

function inspectOk(command: string, args: readonly string[], options?: CommandOptions): CommandResult {
  expect(command).toBe('grok');
  expect(args).toEqual(['inspect', '--json']);
  expect(options?.cwd).toBeTruthy();
  const env = options?.env ?? {};
  expect(env['XAI_API_KEY']).toBeUndefined();
  return {
    status: 0,
    stdout: JSON.stringify({
      skills: [
        { name: 'using-superpowers' },
        { name: 'brainstorming' },
        { name: 'test-driven-development' },
        { name: 'writing-plans' },
      ],
    }),
    stderr: '',
  };
}

test('provision writes Grok config and private runtime files', () => {
  const { home, cleanup } = makeTempHome({
    configDir: join(mkdtempSync(join(tmpdir(), 'run-')), 'home', '.grok'),
  });
  const spRoot = mkdtempSync(join(tmpdir(), 'superpowers-'));
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(inspectOk);
  try {
    withEnv({ SUPERPOWERS_ROOT: spRoot, XAI_API_KEY: 'xai-secret' }, () => {
      const env = new GrokAgent(GROK_CONFIG).provision(home, runner);
      expect(env['GROK_ENV_FILE']).toBeTruthy();
      expect(env['GROK_DEBUG_FILE']).toBeTruthy();
      expect(env['XAI_API_KEY']).toBeUndefined();

      const configToml = readFileSync(join(home.configDir, 'config.toml'), 'utf8');
      expect(configToml).toContain('[plugins]');
      expect(configToml).toContain(spRoot);

      const envFile = env['GROK_ENV_FILE']!;
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(envFile, 'utf8')).toBe("XAI_API_KEY='xai-secret'\n");
      expect(dirname(env['GROK_DEBUG_FILE']!)).toBe(dirname(envFile));

      const runRoot = dirname(dirname(home.configDir));
      expect(realpathSync(dirname(envFile)).startsWith(`${realpathSync(runRoot)}/`)).toBe(false);
    });
  } finally {
    cleanup();
  }
});

test('provision fails when required skills are absent from grok inspect', () => {
  const { home, cleanup } = makeTempHome({
    configDir: join(mkdtempSync(join(tmpdir(), 'run-')), 'home', '.grok'),
  });
  const spRoot = mkdtempSync(join(tmpdir(), 'superpowers-'));
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(() => ({
    status: 0,
    stdout: JSON.stringify({ skills: [{ name: 'using-superpowers' }] }),
    stderr: '',
  }));
  try {
    withEnv({ SUPERPOWERS_ROOT: spRoot, XAI_API_KEY: 'xai-secret' }, () => {
      expect(() => new GrokAgent(GROK_CONFIG).provision(home, runner)).toThrow(
        /missing Grok Superpowers skills: brainstorming, test-driven-development, writing-plans/,
      );
    });
  } finally {
    cleanup();
  }
});

test('provision fails without XAI_API_KEY', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = mkdtempSync(join(tmpdir(), 'superpowers-'));
  stageSuperpowers(spRoot);
  try {
    withEnv({ SUPERPOWERS_ROOT: spRoot, XAI_API_KEY: undefined }, () => {
      expect(() =>
        new GrokAgent(GROK_CONFIG).provision(home, new FakeCommandRunner(inspectOk)),
      ).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test test/agent-grok.test.ts
```

Expected: failures because `GrokAgent.provision` does not write config, env, debug paths, or inspect skills yet.

- [ ] **Step 3: Implement Grok provisioning**

Replace `src/agents/grok.ts` with:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { xdgHomeEnv } from './home-env.ts';
import {
  type CodingAgent,
  ProvisionError,
  type RunHome,
  shellSingleQuote,
} from './index.ts';
import type { CommandRunner } from './command-runner.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

export const GROK_RUNTIME_ENV_FILE_NAME = 'grok-runtime.env';
export const GROK_DEBUG_FILE_NAME = 'grok-debug.log';

const REQUIRED_GROK_SKILLS = [
  'using-superpowers',
  'brainstorming',
  'test-driven-development',
  'writing-plans',
] as const;

export class GrokAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const superpowersRoot = requireSuperpowersRoot();
    const apiKey = requireXaiApiKey();
    mkdirSync(home.configDir, { recursive: true });
    writeGrokConfig(home.configDir, superpowersRoot);
    verifyGrokSkills(home, runner);
    const runDir = runDirFromConfigDir(home.configDir);
    const runtime = writeGrokRuntimeEnvFile(
      { XAI_API_KEY: apiKey },
      { runDir },
    );
    return {
      GROK_ENV_FILE: runtime.envFile,
      GROK_DEBUG_FILE: runtime.debugFile,
    };
  }
}

function requireSuperpowersRoot(): string {
  const raw = getEnv('SUPERPOWERS_ROOT') ?? '';
  if (raw === '') {
    throw new ProvisionError('SUPERPOWERS_ROOT not set; cannot configure Grok');
  }
  const resolved = resolve(expanduser(raw));
  const missing = REQUIRED_GROK_SKILLS.filter(
    (skill) =>
      !existsSync(join(resolved, 'skills', skill, 'SKILL.md')) ||
      !statSync(join(resolved, 'skills', skill, 'SKILL.md')).isFile(),
  );
  if (missing.length > 0) {
    throw new ProvisionError(
      `SUPERPOWERS_ROOT missing Grok skill files: ${missing.join(', ')}`,
    );
  }
  return resolved;
}

function requireXaiApiKey(): string {
  const value = getEnv('XAI_API_KEY') ?? '';
  if (value === '') {
    throw new ProvisionError('XAI_API_KEY not set; cannot seed Grok auth');
  }
  return value;
}

function expanduser(path: string): string {
  if (path === '~' || path.startsWith('~/')) {
    const home = getEnv('HOME');
    if (home !== undefined && home !== '') {
      return path === '~' ? home : join(home, path.slice(2));
    }
  }
  return path;
}

function writeGrokConfig(configDir: string, superpowersRoot: string): void {
  writeFileSync(
    join(configDir, 'config.toml'),
    `[plugins]\npaths = [${JSON.stringify(superpowersRoot)}]\n`,
  );
}

function runHomeFromConfigDir(configDir: string): string {
  return dirname(configDir);
}

function runDirFromConfigDir(configDir: string): string {
  return dirname(runHomeFromConfigDir(configDir));
}

function verifyGrokSkills(home: RunHome, runner: CommandRunner): void {
  const runHome = runHomeFromConfigDir(home.configDir);
  const result = runner.run('grok', ['inspect', '--json'], {
    cwd: home.workdir,
    env: {
      PATH: envSnapshot()['PATH'],
      TERM: envSnapshot()['TERM'],
      LANG: envSnapshot()['LANG'],
      ...xdgHomeEnv(runHome),
    },
  });
  if (result.status !== 0) {
    throw new ProvisionError(
      `grok inspect --json failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ProvisionError('grok inspect --json did not return valid JSON');
  }
  const seen = inspectSkillNames(parsed);
  const missing = REQUIRED_GROK_SKILLS.filter((skill) => !seen.has(skill));
  if (missing.length > 0) {
    throw new ProvisionError(
      `missing Grok Superpowers skills: ${missing.join(', ')}`,
    );
  }
}

function inspectSkillNames(value: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ['name', 'id', 'skill']) {
      const field = obj[key];
      if (typeof field === 'string') {
        out.add(field);
      }
    }
    for (const child of Object.values(obj)) {
      visit(child);
    }
  };
  visit(value);
  return out;
}

interface GrokRuntimeFiles {
  readonly envFile: string;
  readonly debugFile: string;
}

export function writeGrokRuntimeEnvFile(
  env: Readonly<Record<string, string>>,
  opts: { readonly runDir: string; readonly tmpDirOverride?: string },
): GrokRuntimeFiles {
  const tempParent = grokRuntimeTempParent(opts.runDir, opts.tmpDirOverride);
  const secretDir = mkdtempSync(
    join(tempParent, `quorum-grok-runtime-${basenameForTemp(opts.runDir)}-`),
  );
  const envFile = join(secretDir, GROK_RUNTIME_ENV_FILE_NAME);
  const body = Object.keys(env)
    .sort()
    .map((key) => `${key}=${shellSingleQuote(env[key] ?? '')}\n`)
    .join('');
  writePrivateFileNoFollow(envFile, body);
  return { envFile, debugFile: join(secretDir, GROK_DEBUG_FILE_NAME) };
}

function basenameForTemp(path: string): string {
  return resolve(path).split(sep).filter(Boolean).pop() ?? 'run';
}

function grokRuntimeTempParent(
  runDir: string,
  tmpDirOverride?: string,
): string {
  const runDirResolved = realpathSync(resolve(runDir));
  const artifactRootResolved = dirname(runDirResolved);
  let tempParent = realpathSync(resolve(tmpDirOverride ?? tmpdir()));
  if (isInsideOrEqual(tempParent, artifactRootResolved)) {
    tempParent = dirname(artifactRootResolved);
  }
  mkdirSync(tempParent, { recursive: true });
  if (isInsideOrEqual(realpathSync(tempParent), artifactRootResolved)) {
    throw new ProvisionError(
      'Grok runtime temp directory resolved inside artifact root',
    );
  }
  return tempParent;
}

function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}${sep}`);
}
```

- [ ] **Step 4: Run provisioner tests**

Run:

```bash
bun test test/agent-grok.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/grok.ts test/agent-grok.test.ts
git commit -m "feat: provision grok runtime"
```

---

### Task 3: Runner Context, Cleanup, And Env Redaction

**Files:**
- Create: `coding-agents/grok-context/HOWTO.md`
- Create: `coding-agents/grok-context/launch-agent`
- Modify: `src/runner/index.ts`
- Modify: `test/runner-context.test.ts`
- Modify: `test/runner-cleanup.test.ts`

**Interfaces:**
- Produces: `grokLaunchSubstitutions(extraEnv): Record<string, string>`
- Produces: `grokGauntletEnv(env): Readonly<Record<string, string | undefined>>`
- Produces: `runtimeCleanupDirs` support for `GROK_ENV_FILE`
- Consumes: `GROK_ENV_FILE`, `GROK_DEBUG_FILE` from `GrokAgent.provision`

- [ ] **Step 1: Write failing runner tests**

Add to `test/runner-cleanup.test.ts`:

```ts
test('runtimeCleanupDirs: GROK_ENV_FILE -> its parent temp dir', () => {
  const envFile = '/tmp/quorum-grok-runtime-abc/grok-runtime.env';
  expect(runtimeCleanupDirs({ GROK_ENV_FILE: envFile })).toEqual([
    dirname(envFile),
  ]);
});

test('grokLaunchSubstitutions requires env and debug files', () => {
  expect(() =>
    grokLaunchSubstitutions({ GROK_ENV_FILE: '/tmp/grok.env' }),
  ).toThrow(/GROK_DEBUG_FILE/);
  expect(() =>
    grokLaunchSubstitutions({ GROK_DEBUG_FILE: '/tmp/grok-debug.log' }),
  ).toThrow(/GROK_ENV_FILE/);
  expect(
    grokLaunchSubstitutions({
      GROK_ENV_FILE: '/tmp/grok.env',
      GROK_DEBUG_FILE: '/tmp/grok-debug.log',
    }),
  ).toEqual({
    $GROK_ENV_FILE: '/tmp/grok.env',
    $GROK_DEBUG_FILE: '/tmp/grok-debug.log',
  });
});

test('grokGauntletEnv removes XAI_API_KEY from inherited env', () => {
  expect(
    grokGauntletEnv({
      PATH: '/bin',
      XAI_API_KEY: 'xai-secret',
      HOME: '/Users/example',
    }),
  ).toEqual({ PATH: '/bin', HOME: '/Users/example' });
});
```

Add imports:

```ts
import {
  grokGauntletEnv,
  grokLaunchSubstitutions,
} from '../src/runner/index.ts';
```

Add to `test/runner-context.test.ts`:

```ts
function grokSubstitutions(opts: {
  readonly launchCwd: string;
  readonly runDir: string;
  readonly superpowersRoot: string;
  readonly envFile: string;
  readonly debugFile: string;
}): Record<string, string> {
  const launchAgentPath = join(
    opts.runDir,
    'gauntlet-agent',
    'context',
    'launch-agent',
  );
  return {
    $QUORUM_AGENT_CWD: opts.launchCwd,
    $QUORUM_AGENT_CWD_SH: shellSingleQuote(opts.launchCwd),
    $SUPERPOWERS_ROOT: opts.superpowersRoot,
    $QUORUM_LAUNCH_AGENT: launchAgentPath,
    $QUORUM_LAUNCH_AGENT_SH: shellSingleQuote(launchAgentPath),
    $GROK_ENV_FILE: opts.envFile,
    $GROK_DEBUG_FILE: opts.debugFile,
    ...homeEnvSubstitutions(join(opts.runDir, 'home')),
  };
}

test('populateContextDir substitutes every placeholder in the grok context', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const launchCwd = join(runDir, 'coding-agent-workdir');
  mkdirSync(launchCwd, { recursive: true });
  const envFile = join(tmpdir(), 'grok-runtime.env');
  const debugFile = join(tmpdir(), 'grok-debug.log');
  const subs = grokSubstitutions({
    launchCwd,
    runDir,
    superpowersRoot: '/tmp/sproot',
    envFile,
    debugFile,
  });

  populateContextDir({
    codingAgentsDir: REAL_CODING_AGENTS,
    codingAgent: 'grok',
    runDir,
    substitutions: subs,
    required: true,
    forbiddenPlaceholders: ['$GROK_ENV_FILE', '$GROK_DEBUG_FILE'],
  });

  const ctxDir = join(runDir, 'gauntlet-agent', 'context');
  const howto = readFileSync(join(ctxDir, 'HOWTO.md'), 'utf8');
  const launcher = readFileSync(join(ctxDir, 'launch-agent'), 'utf8');
  assertNoLeftoverSubPlaceholders(howto, subs);
  assertNoLeftoverSubPlaceholders(launcher, subs);
  expect(launcher).toContain('grok --cwd');
  expect(launcher).toContain('--debug-file');
  expect(launcher).not.toContain('-m grok-build');
  expect(launcher).not.toContain('--agent grok-build-plan');
  expect(howto).toContain(join(ctxDir, 'launch-agent'));
  expect(statSync(join(ctxDir, 'launch-agent')).mode & 0o111).not.toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test test/runner-cleanup.test.ts test/runner-context.test.ts
```

Expected: failures for missing Grok helper exports and missing `coding-agents/grok-context`.

- [ ] **Step 3: Add Grok context files**

Create `coding-agents/grok-context/launch-agent`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cleanup_grok_env() {
  rm -f "$GROK_ENV_FILE"
}
trap cleanup_grok_env EXIT HUP INT TERM

cd "$QUORUM_AGENT_CWD" || {
  echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2
  exit 1
}

: "${GROK_ENV_FILE:?}"
: "${GROK_DEBUG_FILE:?}"
set -a
. "$GROK_ENV_FILE"
set +a
cleanup_grok_env
trap - EXIT HUP INT TERM
unset GROK_ENV_FILE
unset -f cleanup_grok_env

exec env $QUORUM_HOME_ENV \
  grok --cwd "$QUORUM_AGENT_CWD" \
    --always-approve \
    --no-alt-screen \
    --no-auto-update \
    --debug-file "$GROK_DEBUG_FILE" \
    "$@"
```

Create `coding-agents/grok-context/HOWTO.md`:

```markdown
# How to drive Grok Build

You are driving Grok Build in a bash shell inside tmux. Grok Build is itself an AI coding agent; what appears on screen is its work.

## Launch Grok with one command

Your bash starts in a scratch directory, not the workdir quorum prepared. quorum has generated a launcher that cds into the prepared workdir, pins a throwaway `$HOME`, sources API-key auth, and starts Grok with automatic approvals. Type this one line, verbatim, as your first action:

```bash
"$QUORUM_LAUNCH_AGENT"
```

Do not hand-type `grok`, provider env vars, `--agent`, `--model`, or `-m`. Use the generated launcher.

## Observing what Grok is doing

Grok writes session logs under:

```text
$QUORUM_AGENT_HOME/.grok/sessions/**/chat_history.jsonl
```

The session log is the ground truth for Grok tool calls and agent actions. When the screen and logs disagree, trust the log.

## Waiting for Grok to work

Register the log glob once after launch, then block-wait:

```text
watch_logs(glob="$QUORUM_AGENT_HOME/.grok/sessions/**/chat_history.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
```

- [ ] **Step 4: Implement runner helpers and wiring**

In `src/runner/index.ts`, update `runtimeCleanupDirs`:

```ts
export function runtimeCleanupDirs(
  extraEnv: Readonly<Record<string, string>>,
): string[] {
  const dirs = new Set<string>();
  const kimiEnvFile = extraEnv['KIMI_ENV_FILE'];
  const grokEnvFile = extraEnv['GROK_ENV_FILE'];
  if (kimiEnvFile !== undefined) {
    dirs.add(dirname(kimiEnvFile));
  }
  if (grokEnvFile !== undefined) {
    dirs.add(dirname(grokEnvFile));
  }
  return [...dirs];
}
```

Add:

```ts
export function grokLaunchSubstitutions(
  extraEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const envFile = extraEnv['GROK_ENV_FILE'];
  const debugFile = extraEnv['GROK_DEBUG_FILE'];
  if (envFile === undefined) {
    throw new RunnerError(
      'grok provisioning missing GROK_ENV_FILE before context setup',
      'setup',
    );
  }
  if (debugFile === undefined) {
    throw new RunnerError(
      'grok provisioning missing GROK_DEBUG_FILE before context setup',
      'setup',
    );
  }
  return {
    $GROK_ENV_FILE: envFile,
    $GROK_DEBUG_FILE: debugFile,
  };
}

export function grokGauntletEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'XAI_API_KEY') {
      out[key] = value;
    }
  }
  return out;
}
```

In the context substitution section, add:

```ts
if (cfg.name === 'grok') {
  Object.assign(substitutions, grokLaunchSubstitutions(extraEnv));
}
```

Change the `populateContextDir` call to require Grok context and forbid Grok placeholders:

```ts
const forbiddenPlaceholders =
  family === 'claude' && !isRemote
    ? ['$CLAUDE_MODEL']
    : cfg.name === 'grok'
      ? ['$GROK_ENV_FILE', '$GROK_DEBUG_FILE']
      : [];

populateContextDir({
  codingAgentsDir: a.codingAgentsDir,
  codingAgent: contextDirName(cfg, os),
  runDir,
  substitutions,
  required: family === 'claude' || cfg.name === 'grok',
  forbiddenPlaceholders,
});
```

Change `gauntletEnvBase`:

```ts
const gauntletEnvBase =
  cfg.name === 'copilot'
    ? copilotGauntletEnv(envSnapshot())
    : cfg.name === 'grok'
      ? grokGauntletEnv(envSnapshot())
      : undefined;
```

- [ ] **Step 5: Run runner tests**

Run:

```bash
bun test test/runner-cleanup.test.ts test/runner-context.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add coding-agents/grok-context src/runner/index.ts test/runner-cleanup.test.ts test/runner-context.test.ts
git commit -m "feat: wire grok launcher context"
```

---

### Task 4: Grok Cwd Filter And Transcript Normalizer

**Files:**
- Create: `src/normalize/grok.ts`
- Create: `test/normalize.grok.test.ts`
- Add fixtures: `test/fixtures/grok/chat_history-basic.jsonl`, `test/fixtures/grok/summary.json`
- Modify: `src/capture/index.ts`
- Modify: `src/capture/cwd-filter.ts`
- Modify: `test/cwd-filter.test.ts`
- Modify: `test/capture.test.ts`

**Interfaces:**
- Produces: `normalizeGrok(raw: string, version: string, context?: NormalizeContext): AtifTrajectory`
- Produces: `NormalizeContext` with `sourceLog?: string`
- Consumes: ATIF `AtifTrajectory`, `validateTrajectory`, `filterLogsByCwd`

- [ ] **Step 1: Add sanitized Grok fixtures**

Create `test/fixtures/grok/chat_history-basic.jsonl`:

```jsonl
{"type":"system","content":"You are Grok Build."}
{"type":"user","content":[{"type":"text","text":"Read the skill file and list files."}]}
{"type":"reasoning","summary":"Need inspect repository files."}
{"type":"assistant","model_id":"grok-composer-2.5-fast","content":"I'll inspect the files.","tool_calls":[{"id":"call-read","name":"read_file","arguments":"{\"target_file\":\"skills/using-superpowers/SKILL.md\"}"},{"id":"call-shell","name":"Shell","arguments":"{\"command\":\"ls\"}"}]}
{"type":"tool_result","tool_call_id":"call-read","content":"# using-superpowers\n"}
{"type":"tool_result","tool_call_id":"call-shell","content":"README.md\nskills\n"}
{"type":"assistant","model_id":"grok-composer-2.5-fast","tool_calls":[{"id":"call-write","name":"Write","arguments":{"file_path":"notes.txt","content":"done\n"}}]}
```

Create `test/fixtures/grok/summary.json`:

```json
{
  "session_id": "grok-session-1",
  "agent_name": "cursor",
  "current_model_id": "grok-composer-2.5-fast"
}
```

- [ ] **Step 2: Write failing cwd-filter tests**

Add to `test/cwd-filter.test.ts`:

```ts
function encodeGrokCwd(path: string): string {
  return encodeURIComponent(path);
}

test('grok filter keeps logs whose encoded cwd segment matches target', () => {
  const home = tmp('grok-home-');
  const target = tmp('grok-target with spaces-');
  const other = tmp('grok-target-old-');
  const matchDir = join(home, '.grok', 'sessions', encodeGrokCwd(target), 's1');
  const otherDir = join(home, '.grok', 'sessions', encodeGrokCwd(other), 's2');
  mkdirSync(matchDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const match = join(matchDir, 'chat_history.jsonl');
  const mismatch = join(otherDir, 'chat_history.jsonl');
  writeFileSync(match, '{}\n');
  writeFileSync(mismatch, '{}\n');

  expect(filterLogsByCwd('grok', [match, mismatch], target)).toEqual([match]);
});

test('grok filter rejects malformed encoded cwd segments', () => {
  const home = tmp('grok-home-');
  const target = tmp('grok-target-');
  const badDir = join(home, '.grok', 'sessions', '%E0%A4%A', 's1');
  mkdirSync(badDir, { recursive: true });
  const bad = join(badDir, 'chat_history.jsonl');
  writeFileSync(bad, '{}\n');
  expect(filterLogsByCwd('grok', [bad], target)).toEqual([]);
});
```

- [ ] **Step 3: Write failing normalizer tests**

Create `test/normalize.grok.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeGrok } from '../src/normalize/grok.ts';

const fixture = readFileSync(
  join(import.meta.dir, 'fixtures/grok/chat_history-basic.jsonl'),
  'utf8',
);

test('grok normalizer produces valid ATIF', () => {
  const traj = normalizeGrok(fixture, '0.2.56');
  expect(validateTrajectory(traj).errors).toEqual([]);
  expect(traj.agent.name).toBe('grok');
  expect(traj.schema_version).toBe('ATIF-v1.7');
});

test('grok maps observed tool dialects to canonical tools', () => {
  const traj = normalizeGrok(fixture, '0.2.56');
  const tools = traj.steps.flatMap((s) =>
    (s.tool_calls ?? []).map((t) => t.function_name),
  );
  expect(tools).toEqual(['Read', 'Bash', 'Write']);
});

test('grok parses stringified args and canonicalizes Read file_path', () => {
  const traj = normalizeGrok(fixture, '0.2.56');
  const read = traj.steps
    .flatMap((s) => s.tool_calls ?? [])
    .find((t) => t.function_name === 'Read')!;
  expect(read.arguments['file_path']).toBe(
    'skills/using-superpowers/SKILL.md',
  );
  expect(read.extra?.['raw_arguments']).toEqual({
    target_file: 'skills/using-superpowers/SKILL.md',
  });
});

test('grok attaches delayed tool results to the owning step', () => {
  const traj = normalizeGrok(fixture, '0.2.56');
  const readStep = traj.steps.find((s) =>
    s.tool_calls?.some((t) => t.tool_call_id === 'call-read'),
  )!;
  expect(readStep.observation?.results).toContainEqual({
    source_call_id: 'call-read',
    content: '# using-superpowers\n',
  });
});

test('grok uses adjacent summary metadata when sourceLog is provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-session-'));
  const sourceLog = join(dir, 'chat_history.jsonl');
  writeFileSync(sourceLog, fixture);
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      session_id: 'session-from-summary',
      current_model_id: 'grok-composer-2.5-fast',
    }),
  );
  const traj = normalizeGrok(fixture, '0.2.56', { sourceLog });
  expect(traj.session_id).toBe('session-from-summary');
  expect(traj.agent.model_name).toBe('grok-composer-2.5-fast');
});

test('grok invalid JSONL throws so capture fails closed', () => {
  expect(() => normalizeGrok('{not json}\n', '0.2.56')).toThrow(/invalid Grok JSONL/);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
bun test test/cwd-filter.test.ts test/normalize.grok.test.ts
```

Expected: failures for missing Grok cwd filter and missing normalizer.

- [ ] **Step 5: Extend capture normalizer context**

In `src/capture/index.ts`, change the normalizer type:

```ts
export interface NormalizeContext {
  readonly sourceLog?: string;
}

type AtifNormalizer = (
  raw: string,
  version: string,
  context?: NormalizeContext,
) => AtifTrajectory;
```

Change `emitTrajectory`:

```ts
function emitTrajectory(
  sourceLog: string,
  normalize: AtifNormalizer,
): AtifTrajectory | null {
  let raw: string;
  try {
    raw = readFileSync(sourceLog, 'utf8');
  } catch {
    return null;
  }
  try {
    return normalize(raw, ATIF_AGENT_VERSION, { sourceLog });
  } catch {
    return null;
  }
}
```

Existing normalizers keep compiling because TypeScript allows functions with fewer parameters.

- [ ] **Step 6: Implement Grok cwd filter**

In `src/capture/cwd-filter.ts`, add:

```ts
function grokEncodedCwdForLog(path: string): string | undefined {
  const parts = resolve(path).split(sep);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'sessions' && parts[i - 1] === '.grok') {
      return parts[i + 1];
    }
  }
  return undefined;
}

function filterGrokLogsByCwd(paths: string[], targetCwd: string): string[] {
  const target = realPath(targetCwd);
  const matched: string[] = [];
  for (const path of paths) {
    const encoded = grokEncodedCwdForLog(path);
    if (encoded === undefined || encoded === '') {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    if (realPath(decoded) === target) {
      matched.push(path);
    }
  }
  return matched;
}
```

Add `grok: filterGrokLogsByCwd` to `CWD_FILTERS`.

- [ ] **Step 7: Implement Grok normalizer**

Create `src/normalize/grok.ts` with:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ATIF_SCHEMA_VERSION,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
} from '../atif/types.ts';
import type { NormalizeContext } from '../capture/index.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonl(raw: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid Grok JSONL at line ${lineNo}`);
    }
    if (!isObject(parsed)) {
      throw new Error(`invalid Grok JSONL row at line ${lineNo}`);
    }
    rows.push(parsed);
  }
  return rows;
}

function stringContent(value: unknown): string | unknown[] | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  }
  return isObject(value) ? value : {};
}

function canonicalTool(name: string): string {
  const map: Record<string, string> = {
    run_terminal_command: 'Bash',
    Shell: 'Bash',
    read_file: 'Read',
    write: 'Write',
    Write: 'Write',
    search_replace: 'Edit',
    list_dir: 'Glob',
  };
  return map[name] ?? name;
}

function canonicalArgs(
  functionName: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; extra?: Record<string, unknown> } {
  if (functionName !== 'Read') {
    return { args };
  }
  const path =
    args['target_file'] ?? args['filePath'] ?? args['path'] ?? args['file_path'];
  if (typeof path !== 'string') {
    return { args };
  }
  return {
    args: { ...args, file_path: path },
    extra: { raw_arguments: args },
  };
}

function readSummary(sourceLog: string | undefined): Record<string, unknown> {
  if (sourceLog === undefined) {
    return {};
  }
  const path = join(dirname(sourceLog), 'summary.json');
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeGrok(
  raw: string,
  version: string,
  context?: NormalizeContext,
): AtifTrajectory {
  const rows = parseJsonl(raw);
  const summary = readSummary(context?.sourceLog);
  const steps: AtifStep[] = [];
  const owners = new Map<string, AtifStep>();
  let modelName =
    typeof summary['current_model_id'] === 'string'
      ? summary['current_model_id']
      : undefined;
  let sessionId =
    typeof summary['session_id'] === 'string' ? summary['session_id'] : undefined;

  const nextStepId = () => steps.length + 1;

  for (const row of rows) {
    const type = row['type'];
    if (type === 'system' || type === 'user') {
      const content = stringContent(row['content']);
      if (content !== undefined) {
        steps.push({ step_id: nextStepId(), source: type, message: content });
      }
      continue;
    }
    if (type === 'reasoning') {
      const summaryText = row['summary'];
      if (typeof summaryText === 'string' && summaryText !== '') {
        steps.push({
          step_id: nextStepId(),
          source: 'agent',
          reasoning_content: summaryText,
        });
      }
      continue;
    }
    if (type === 'assistant') {
      if (typeof row['model_id'] === 'string') {
        modelName = row['model_id'];
      }
      const step: AtifStep = {
        step_id: nextStepId(),
        source: 'agent',
        ...(modelName ? { model_name: modelName } : {}),
      };
      const content = stringContent(row['content']);
      if (content !== undefined) {
        step.message = content;
      }
      const rawCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : [];
      const calls: AtifToolCall[] = [];
      for (const rawCall of rawCalls) {
        if (!isObject(rawCall)) {
          continue;
        }
        const id = rawCall['id'];
        const name = rawCall['name'];
        if (typeof id !== 'string' || typeof name !== 'string') {
          continue;
        }
        const functionName = canonicalTool(name);
        const parsedArgs = parseArgs(rawCall['arguments']);
        const canonical = canonicalArgs(functionName, parsedArgs);
        const call: AtifToolCall = {
          tool_call_id: id,
          function_name: functionName,
          arguments: canonical.args,
          ...(canonical.extra ? { extra: canonical.extra } : {}),
        };
        calls.push(call);
        owners.set(id, step);
      }
      if (calls.length > 0) {
        step.tool_calls = calls;
      }
      if (step.message !== undefined || step.tool_calls !== undefined) {
        steps.push(step);
      }
      continue;
    }
    if (type === 'tool_result') {
      const id = row['tool_call_id'];
      if (typeof id !== 'string') {
        continue;
      }
      const owner = owners.get(id);
      if (owner === undefined) {
        continue;
      }
      const result = {
        source_call_id: id,
        content: row['content'] ?? null,
      };
      owner.observation = {
        results: [...(owner.observation?.results ?? []), result],
      };
    }
  }

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    ...(sessionId ? { session_id: sessionId } : {}),
    agent: {
      name: 'grok',
      version,
      ...(modelName ? { model_name: modelName } : {}),
    },
    steps,
  };
}
```

- [ ] **Step 8: Register normalizer**

In `src/capture/index.ts`, import and register:

```ts
import { normalizeGrok } from '../normalize/grok.ts';

const NORMALIZERS: Record<string, AtifNormalizer> = {
  ...
  grok: normalizeGrok,
  ...
};
```

- [ ] **Step 9: Run normalizer and cwd-filter tests**

Run:

```bash
bun test test/cwd-filter.test.ts test/normalize.grok.test.ts test/capture.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/normalize/grok.ts src/capture/index.ts src/capture/cwd-filter.ts test/fixtures/grok test/normalize.grok.test.ts test/cwd-filter.test.ts test/capture.test.ts
git commit -m "feat: normalize grok transcripts"
```

---

### Task 5: Private Debug Usage And ATIF Final Metrics

**Files:**
- Create: `src/capture/grok-usage.ts`
- Create: `test/grok-usage.test.ts`
- Modify: `src/capture/index.ts`
- Modify: `src/runner/index.ts`
- Modify: `test/capture.test.ts`
- Modify: `test/obol.test.ts`

**Interfaces:**
- Produces: `GrokUsageSpan`
- Produces: `parseGrokUsageSpans(raw: string): GrokUsageSpan[]`
- Produces: `mergeGrokUsage(trajectory, spans): AtifTrajectory`
- Produces: `attachGrokUsageFromDebug(trajectory, debugFile): AtifTrajectory`
- Consumes: `CaptureArgs.grokDebugFile?: string`

- [ ] **Step 1: Write failing Grok usage parser tests**

Create `test/grok-usage.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AtifTrajectory } from '../src/atif/types.ts';
import {
  attachGrokUsageFromDebug,
  mergeGrokUsage,
  parseGrokUsageSpans,
} from '../src/capture/grok-usage.ts';

const baseTrajectory: AtifTrajectory = {
  schema_version: 'ATIF-v1.7',
  agent: { name: 'grok', version: '0.2.56' },
  steps: [
    {
      step_id: 1,
      source: 'agent',
      tool_calls: [
        {
          tool_call_id: 'call-1',
          function_name: 'Bash',
          arguments: { command: 'ls' },
        },
      ],
    },
  ],
};

test('parseGrokUsageSpans extracts allowlisted token fields', () => {
  const spans = parseGrokUsageSpans(
    [
      JSON.stringify({
        request_id: 'req-1',
        model_id: 'grok-composer-2.5-fast',
        input_tokens: 100,
        output_tokens: 25,
        cache_read_tokens: 40,
      }),
    ].join('\n'),
  );
  expect(spans).toEqual([
    {
      request_id: 'req-1',
      model_id: 'grok-composer-2.5-fast',
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
    },
  ]);
});

test('parseGrokUsageSpans accepts camelCase fields', () => {
  const spans = parseGrokUsageSpans(
    JSON.stringify({
      requestId: 'req-1',
      modelId: 'grok-composer-2.5-fast',
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 40,
    }),
  );
  expect(spans[0]?.request_id).toBe('req-1');
  expect(spans[0]?.cache_read_tokens).toBe(40);
});

test('parseGrokUsageSpans rejects conflicting duplicate request ids', () => {
  const raw = [
    JSON.stringify({
      request_id: 'req-1',
      model_id: 'grok',
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
    }),
    JSON.stringify({
      request_id: 'req-1',
      model_id: 'grok',
      input_tokens: 101,
      output_tokens: 25,
      cache_read_tokens: 40,
    }),
  ].join('\n');
  expect(() => parseGrokUsageSpans(raw)).toThrow(/conflicting Grok usage span/);
});

test('parseGrokUsageSpans rejects new nonzero billable fields', () => {
  const raw = JSON.stringify({
    request_id: 'req-1',
    model_id: 'grok',
    input_tokens: 100,
    output_tokens: 25,
    cache_read_tokens: 40,
    reasoning_tokens: 12,
  });
  expect(() => parseGrokUsageSpans(raw)).toThrow(/unsupported Grok billing field/);
});

test('mergeGrokUsage writes final_metrics only', () => {
  const merged = mergeGrokUsage(baseTrajectory, [
    {
      request_id: 'req-1',
      model_id: 'grok-composer-2.5-fast',
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
    },
  ]);
  expect(merged.steps.some((s) => s.metrics)).toBe(false);
  expect(merged.final_metrics).toEqual({
    total_prompt_tokens: 60,
    total_completion_tokens: 25,
    extra: {
      total_cached_tokens: 40,
      grok_usage_source: 'debug-file',
    },
  });
  expect(merged.agent.model_name).toBe('grok-composer-2.5-fast');
});

test('attachGrokUsageFromDebug deletes the raw debug file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-debug-'));
  const debug = join(dir, 'grok-debug.log');
  writeFileSync(
    debug,
    JSON.stringify({
      request_id: 'req-1',
      model_id: 'grok',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
    }),
  );
  const merged = attachGrokUsageFromDebug(baseTrajectory, debug);
  expect(merged.final_metrics?.total_prompt_tokens).toBe(8);
  expect(existsSync(debug)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test test/grok-usage.test.ts
```

Expected: failure because `src/capture/grok-usage.ts` does not exist.

- [ ] **Step 3: Implement Grok usage helpers**

Create `src/capture/grok-usage.ts`:

```ts
import { readFileSync, rmSync } from 'node:fs';
import type { AtifTrajectory } from '../atif/types.ts';

export interface GrokUsageSpan {
  readonly request_id: string;
  readonly model_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
}

export class GrokUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokUsageError';
  }
}

const BILLABLE_DRIFT_FIELDS = [
  'reasoning_tokens',
  'reasoningTokens',
  'image_tokens',
  'imageTokens',
  'server_tool_cost',
  'serverToolCost',
  'cache_write_tokens',
  'cacheWriteTokens',
  'service_tier',
  'serviceTier',
  'cost_in_usd_ticks',
  'costInUsdTicks',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(obj: Record<string, unknown>, snake: string, camel: string): number {
  const value = obj[snake] ?? obj[camel];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new GrokUsageError(`invalid Grok usage field ${snake}`);
  }
  return value as number;
}

function stringField(obj: Record<string, unknown>, snake: string, camel: string): string {
  const value = obj[snake] ?? obj[camel];
  if (typeof value !== 'string' || value === '') {
    throw new GrokUsageError(`invalid Grok usage field ${snake}`);
  }
  return value;
}

function rejectBillableDrift(obj: Record<string, unknown>): void {
  for (const field of BILLABLE_DRIFT_FIELDS) {
    const value = obj[field];
    if (
      value !== undefined &&
      value !== null &&
      value !== 0 &&
      value !== '' &&
      value !== false
    ) {
      throw new GrokUsageError(`unsupported Grok billing field: ${field}`);
    }
  }
}

function parseSpan(obj: Record<string, unknown>): GrokUsageSpan | null {
  const hasRequired =
    (obj['request_id'] !== undefined || obj['requestId'] !== undefined) &&
    (obj['model_id'] !== undefined || obj['modelId'] !== undefined) &&
    (obj['input_tokens'] !== undefined || obj['inputTokens'] !== undefined) &&
    (obj['output_tokens'] !== undefined || obj['outputTokens'] !== undefined) &&
    (obj['cache_read_tokens'] !== undefined ||
      obj['cacheReadTokens'] !== undefined);
  if (!hasRequired) {
    rejectBillableDrift(obj);
    return null;
  }
  rejectBillableDrift(obj);
  const span = {
    request_id: stringField(obj, 'request_id', 'requestId'),
    model_id: stringField(obj, 'model_id', 'modelId'),
    input_tokens: numberField(obj, 'input_tokens', 'inputTokens'),
    output_tokens: numberField(obj, 'output_tokens', 'outputTokens'),
    cache_read_tokens: numberField(obj, 'cache_read_tokens', 'cacheReadTokens'),
  };
  if (span.input_tokens < span.cache_read_tokens) {
    throw new GrokUsageError('Grok input_tokens is smaller than cache_read_tokens');
  }
  return span;
}

export function parseGrokUsageSpans(raw: string): GrokUsageSpan[] {
  const byRequest = new Map<string, GrokUsageSpan>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(parsed)) {
      continue;
    }
    const span = parseSpan(parsed);
    if (span === null) {
      continue;
    }
    const existing = byRequest.get(span.request_id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(span)) {
        throw new GrokUsageError(
          `conflicting Grok usage span for request ${span.request_id}`,
        );
      }
      continue;
    }
    byRequest.set(span.request_id, span);
  }
  return [...byRequest.values()];
}

export function mergeGrokUsage(
  trajectory: AtifTrajectory,
  spans: readonly GrokUsageSpan[],
): AtifTrajectory {
  if (spans.length === 0) {
    return trajectory;
  }
  const prompt = spans.reduce(
    (sum, span) => sum + span.input_tokens - span.cache_read_tokens,
    0,
  );
  const completion = spans.reduce((sum, span) => sum + span.output_tokens, 0);
  const cached = spans.reduce((sum, span) => sum + span.cache_read_tokens, 0);
  const models = [...new Set(spans.map((span) => span.model_id))];
  const extra: Record<string, unknown> = {
    total_cached_tokens: cached,
    grok_usage_source: 'debug-file',
  };
  if (models.length > 1) {
    extra['grok_usage_models'] = models;
  }
  return {
    ...trajectory,
    agent: {
      ...trajectory.agent,
      ...(models.length === 1 ? { model_name: models[0] } : {}),
    },
    steps: trajectory.steps.map((step) => {
      const { metrics: _metrics, ...rest } = step;
      return rest;
    }),
    final_metrics: {
      total_prompt_tokens: prompt,
      total_completion_tokens: completion,
      extra,
    },
  };
}

export function attachGrokUsageFromDebug(
  trajectory: AtifTrajectory,
  debugFile: string,
): AtifTrajectory {
  const raw = readFileSync(debugFile, 'utf8');
  try {
    return mergeGrokUsage(trajectory, parseGrokUsageSpans(raw));
  } finally {
    rmSync(debugFile, { force: true });
  }
}
```

- [ ] **Step 4: Thread debug usage through capture**

In `src/capture/index.ts`, import:

```ts
import { attachGrokUsageFromDebug, GrokUsageError } from './grok-usage.ts';
```

Extend `CaptureArgs`:

```ts
export interface CaptureArgs {
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly normalizer: string;
  readonly runDir: string;
  readonly launchCwd: string;
  readonly grokDebugFile?: string;
}
```

Before writing `trajectory.json` in `captureToolCalls`, merge Grok usage:

```ts
const withUsage =
  merged !== null && args.normalizer === 'grok' && args.grokDebugFile !== undefined
    ? attachGrokUsageFromDebug(merged, args.grokDebugFile)
    : merged;
const rowCount = withUsage === null ? 0 : flattenToolCalls(withUsage).length;
if (withUsage !== null && rowCount > 0) {
  writeFileSync(outPath, `${JSON.stringify(withUsage, null, 2)}\n`);
} else {
  rmSync(outPath, { force: true });
}
```

In `src/runner/index.ts`, pass `grokDebugFile` into both capture calls:

```ts
const grokDebugFile =
  cfg.name === 'grok' ? extraEnv['GROK_DEBUG_FILE'] : undefined;

const capture = captureToolCallsWithRetry(
  {
    logDir,
    logGlob: cfg.session_log_glob,
    snapshot,
    normalizer: cfg.normalizer,
    runDir,
    launchCwd,
    grokDebugFile,
  },
  { attempts: CAPTURE_RETRY_ATTEMPTS, delayMs: CAPTURE_RETRY_DELAY_MS },
);
await captureTokenUsage({
  logDir,
  logGlob: cfg.session_log_glob,
  snapshot,
  normalizer: cfg.normalizer,
  runDir,
  launchCwd,
  grokDebugFile,
});
```

If TypeScript reports `GrokUsageError` is unused, do not import it in this task. If a later run needs a specialized indeterminate message, add the catch at that point with a test.

- [ ] **Step 5: Add capture test for final metrics**

Add to `test/capture.test.ts`:

```ts
test('captureToolCalls merges grok debug usage into trajectory final_metrics', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'grok-logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'grok-run-'));
  const snap = snapshotDir(logDir, '**/chat_history.jsonl');
  const session = join(logDir, encodeURIComponent(runDir), 'session-1');
  mkdirSync(session, { recursive: true });
  writeFileSync(
    join(session, 'chat_history.jsonl'),
    JSON.stringify({
      type: 'assistant',
      model_id: 'grok',
      tool_calls: [
        {
          id: 'call-1',
          name: 'Shell',
          arguments: '{"command":"ls"}',
        },
      ],
    }),
  );
  const debugFile = join(mkdtempSync(join(tmpdir(), 'grok-debug-')), 'debug.log');
  writeFileSync(
    debugFile,
    JSON.stringify({
      request_id: 'req-1',
      model_id: 'grok',
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 40,
    }),
  );
  const res = captureToolCalls({
    logDir,
    logGlob: '**/chat_history.jsonl',
    snapshot: snap,
    normalizer: 'grok',
    runDir,
    launchCwd: runDir,
    grokDebugFile: debugFile,
  });
  expect(res.rowCount).toBe(1);
  const traj = readTrajectory(runDir);
  expect(traj.steps.some((s) => s.metrics)).toBe(false);
  expect(traj.final_metrics).toEqual({
    total_prompt_tokens: 60,
    total_completion_tokens: 25,
    extra: {
      total_cached_tokens: 40,
      grok_usage_source: 'debug-file',
    },
  });
});
```

- [ ] **Step 6: Add obol unpriced guard**

Add to `test/obol.test.ts`:

```ts
test('estimateTrajectory keeps grok final_metrics tokens even when model is unpriced', async () => {
  const f = writeTrajectory({
    schema_version: 'ATIF-v1.7',
    agent: {
      name: 'grok',
      version: '0.2.56',
      model_name: 'grok-composer-2.5-fast',
    },
    steps: [
      {
        step_id: 1,
        source: 'agent',
        tool_calls: [
          {
            tool_call_id: 'call-1',
            function_name: 'Bash',
            arguments: { command: 'ls' },
          },
        ],
      },
    ],
    final_metrics: {
      total_prompt_tokens: 60,
      total_completion_tokens: 25,
      extra: { total_cached_tokens: 40 },
    },
  });
  const usage = await estimateTrajectory(f);
  expect(usage).not.toBeNull();
  const u = usage as NonNullable<typeof usage>;
  expect(u.total_input).toBe(60);
  expect(u.total_cache_read).toBe(40);
  expect(u.total_output).toBe(25);
  expect(u.est_cost_usd).toBeNull();
  expect(u.unpriced_models).toContain('grok-composer-2.5-fast');
});
```

- [ ] **Step 7: Run usage and capture tests**

Run:

```bash
bun test test/grok-usage.test.ts test/capture.test.ts test/obol.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/capture/grok-usage.ts src/capture/index.ts src/runner/index.ts test/grok-usage.test.ts test/capture.test.ts test/obol.test.ts
git commit -m "feat: capture grok token usage"
```

---

### Task 6: Strict Capture, Docs, And Live Smoke Gate

**Files:**
- Modify: `src/runner/index.ts`
- Modify: `docs/superpowers/reference/atif-normalizers.md`
- Create: `docs/experiments/2026-06-19-grok-build-smoke.md`
- Modify or create: `coding-agents/grok-context/HOWTO.md`

**Interfaces:**
- Produces: strict capture entry for `grok`
- Produces: Grok ATIF normalizer reference row
- Produces: experiment log for the first live smoke

- [ ] **Step 1: Add strict-capture registration**

In `src/runner/index.ts`, add Grok:

```ts
const STRICT_CAPTURE_NAMES: Readonly<Record<string, string>> = {
  antigravity: 'Antigravity',
  claude: 'Claude',
  copilot: 'Copilot',
  gemini: 'Gemini',
  grok: 'Grok',
};
```

- [ ] **Step 2: Update ATIF normalizer reference**

Add this row to `docs/superpowers/reference/atif-normalizers.md` under "Per-agent":

```markdown
### grok (`normalize/grok.ts`) — transcript log + debug final metrics
- Log: `.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl`; cwd attribution comes from decoding the `<encoded-cwd>` segment and realpath-comparing it to the launch cwd.
- Tool rows: assistant `tool_calls[]` map to ATIF tool calls; later `tool_result.tool_call_id` rows attach back to the owning step to satisfy ATIF's same-step observation invariant.
- Tool quirks: Grok has emitted lower-case tool names (`read_file`, `write`, `run_terminal_command`) and composer-shaped names (`Write`, `Shell`). `Read` canonicalizes `target_file`/`filePath`/`path` to `file_path`.
- Usage: private `--debug-file` spans are parsed outside the artifact tree, deduped by request id, then folded into `final_metrics` only: `input_tokens - cache_read_tokens`→`total_prompt_tokens`, `output_tokens`→`total_completion_tokens`, `cache_read_tokens`→`final_metrics.extra.total_cached_tokens`. Tool steps carry no `metrics`.
- Cost: priced only by obol from ATIF. Until obol knows the observed Grok model ids, costs remain token-present and unpriced.
- Full-fidelity: emits system/user content, assistant messages, reasoning summaries, observations, `trajectory.session_id` from adjacent `summary.json` when present, and `agent.model_name` from usage or summary metadata.
```

- [ ] **Step 3: Create live smoke experiment template**

After the live smoke in Step 6, create
`docs/experiments/2026-06-19-grok-build-smoke.md` with the actual command,
run directory, verdict, and secrecy results. Use this structure:

```markdown
# Grok Build smoke

Date: 2026-06-19

## Hypothesis

The normal-user Grok Build CLI launcher (`grok`, no `--agent`, no `--model`, no `-m`) can run under Quorum with API-key auth, Superpowers skill discovery, transcript capture, and token-present ATIF economics.

## Command

```bash
test -n "$XAI_API_KEY"
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
bun run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent grok \
  --out-root /tmp/quorum-grok-smoke
```

## Acceptance checklist

- Final verdict is `pass`.
- `trajectory.json` exists and has nonempty Grok tool calls.
- `coding-agent-token-usage.json` has nonzero Grok coding-agent tokens.
- Grok model keys are visible and either priced by obol or explicitly listed as unpriced.
- No raw Grok debug log exists under the run artifact tree.
- The full `XAI_API_KEY` value appears nowhere in the run artifact tree.
- Structural auth/debug markers such as `Authorization`, `Bearer`, `access_token`, `refresh_token`, `auth.json`, and raw debug-log-only markers do not appear in run artifacts except expected redacted diagnostics.
- `grok inspect --json` in the isolated home sees `using-superpowers`, `brainstorming`, `test-driven-development`, and `writing-plans`.

## Result

- Run directory: record the absolute run directory printed by Quorum.
- Verdict: record `bun run quorum show <run-dir>` output summary.
- Usage: record whether `coding-agent-token-usage.json` has nonzero tokens and whether the model is priced or unpriced.
- Artifact secrecy: record the exact four secrecy commands from this plan and their exit status.
```

- [ ] **Step 4: Run routine gates**

Run:

```bash
bun run check
bun run quorum check
```

Expected: both commands exit 0.

- [ ] **Step 5: Run a dry CLI manifest check**

Run:

```bash
bun run quorum list | rg 'grok|00-quorum-smoke-hello-world'
bun run quorum grid-manifest --out /tmp/quorum-grid-manifest.json
rg '"grok"' /tmp/quorum-grid-manifest.json
```

Expected: `grok` appears as a coding-agent option and Linux matrix cell; Windows is absent or unsupported for Grok.

- [ ] **Step 6: Run live maintainer smoke**

Run only on a trusted maintainer machine with a real xAI key:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
test -n "$XAI_API_KEY"
bun run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent grok \
  --out-root /tmp/quorum-grok-smoke
```

Expected: final verdict `pass` or a specific setup/capture indeterminate whose reason identifies the failed acceptance item.

- [ ] **Step 7: Verify artifact secrecy after smoke**

Replace `$RUN_DIR` with the run directory printed by Quorum:

```bash
test -n "$XAI_API_KEY"
! rg -F "$XAI_API_KEY" "$RUN_DIR"
! find "$RUN_DIR" -name '*debug*' -print | rg .
! rg 'Authorization|Bearer|access_token|refresh_token|auth\.json' "$RUN_DIR"
```

Expected: all four commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/runner/index.ts docs/superpowers/reference/atif-normalizers.md docs/experiments/2026-06-19-grok-build-smoke.md coding-agents/grok-context/HOWTO.md
git commit -m "docs: document grok target verification"
```

---

### Task 7: Final Verification Sweep

**Files:**
- Modify only files needed to fix failures from the verification commands.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: a clean, implementation-ready branch.

- [ ] **Step 1: Run full checks**

Run:

```bash
bun run check
bun run quorum check
```

Expected: both commands exit 0.

- [ ] **Step 2: Run focused Grok tests**

Run:

```bash
bun test test/agent-grok.test.ts test/normalize.grok.test.ts test/grok-usage.test.ts test/cwd-filter.test.ts test/runner-context.test.ts test/runner-cleanup.test.ts test/fs-verbs-bootstrap.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 3: Review Grok launcher for forbidden flags**

Run:

```bash
! rg -- '--agent grok-build-plan|-m grok-build|--model grok' coding-agents/grok-context/launch-agent docs/superpowers/plans/2026-06-19-grok-build-quorum-target.md
```

Expected: command exits 0, proving the actual launcher and this plan do not instruct workers to pin Grok mode.

- [ ] **Step 4: Review status**

Run:

```bash
git status --short
git log --oneline -7
```

Expected: only intentional files are modified or committed. No generated run artifacts are present.

- [ ] **Step 5: Commit final fixes if Step 1 or Step 2 required changes**

```bash
git status --short
```

When `git status --short` is clean after Step 4, skip this step. When it shows
files changed by verification fixes, stage only those exact paths with
`git add path/from/status` and commit with:

```bash
git commit -m "fix: stabilize grok target"
```

---

## Self-Review Checklist

- Spec coverage: Tasks 1-3 cover target config, registration, provisioning, auth, Superpowers path config, launcher, and context requirements. Task 4 covers transcript capture, cwd filtering, metadata fallback, and normalizer behavior. Task 5 covers private debug usage and ATIF single-source economics. Task 6 covers strict capture, docs, live smoke, and secret checks. Task 7 covers final verification.
- Placeholder scan: the plan has been searched for forbidden placeholder terms and explicit fake path markers.
- Type consistency: `GROK_ENV_FILE`, `GROK_DEBUG_FILE`, `GrokUsageSpan`, `NormalizeContext`, `normalizeGrok`, `grokLaunchSubstitutions`, and `grokGauntletEnv` are introduced before they are consumed.
- Scope check: Windows support and obol rate-table changes are intentionally outside this Quorum plan. Grok tokens can be captured before obol prices observed model ids.
