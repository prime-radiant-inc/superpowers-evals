import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  session_log_dir: '${QUORUM_AGENT_HOME}/.hermes/sessions-export',
  session_log_glob: '*.json',
  normalizer: 'hermes',
  required_env: ['SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
};

const OPENROUTER_CRED: Credential = {
  model: 'z-ai/glm-5.2',
  api: 'openai-chat',
  auth: 'api-key',
  base_url: 'https://openrouter.ai/api/v1',
  api_key_env: 'OPENROUTER_API_KEY',
  harnesses: ['hermes'],
} as Credential;

// Stage a SUPERPOWERS_ROOT carrying the four Hermes support files.
function stageSuperpowers(root: string): void {
  mkdirSync(join(root, '.hermes-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.hermes-plugin', 'plugin.yaml'),
    'name: superpowers\n',
  );
  writeFileSync(
    join(root, '.hermes-plugin', '__init__.py'),
    'def register(ctx): pass\n',
  );
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

test('provision stages the plugin clone-faithfully (.hermes-plugin/ + skills/ siblings)', () => {
  const { home, cleanup } = provisionOk();
  const plug = join(home.configDir, 'plugins', 'superpowers');
  expect(existsSync(join(plug, '.hermes-plugin', 'plugin.yaml'))).toBe(true);
  expect(existsSync(join(plug, '.hermes-plugin', '__init__.py'))).toBe(true);
  expect(
    existsSync(join(plug, 'skills', 'using-superpowers', 'SKILL.md')),
  ).toBe(true);
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

test('provision rejects a symlink inside SUPERPOWERS_ROOT/skills before staging', () => {
  const { home, cleanup } = makeTempHome();
  const sproot = join(home.workdir, 'superpowers-src');
  stageSuperpowers(sproot);
  // Plant a symlink inside the skills tree; staging must refuse to copy it.
  symlinkSync(
    join(sproot, 'skills', 'using-superpowers', 'SKILL.md'),
    join(sproot, 'skills', 'using-superpowers', 'SKILL-link.md'),
  );
  const agent = new HermesAgent(HERMES_CONFIG);
  expect(() =>
    withEnvVars(
      { SUPERPOWERS_ROOT: sproot, OPENROUTER_API_KEY: 'or-key-123' },
      () => agent.provision(home, new FakeCommandRunner(), OPENROUTER_CRED),
    ),
  ).toThrow(ProvisionError);
  cleanup();
});

test('provision expands a ~-prefixed SUPERPOWERS_ROOT via HOME', () => {
  const { home, cleanup } = makeTempHome();
  const sproot = join(home.workdir, 'superpowers-src');
  stageSuperpowers(sproot);
  const runner = new FakeCommandRunner();
  const agent = new HermesAgent(HERMES_CONFIG);
  withEnvVars(
    {
      SUPERPOWERS_ROOT: '~/superpowers-src',
      OPENROUTER_API_KEY: 'or-key-123',
      HOME: home.workdir,
    },
    () => agent.provision(home, runner, OPENROUTER_CRED),
  );
  const plug = join(home.configDir, 'plugins', 'superpowers');
  expect(existsSync(join(plug, '.hermes-plugin', 'plugin.yaml'))).toBe(true);
  expect(
    existsSync(join(plug, 'skills', 'using-superpowers', 'SKILL.md')),
  ).toBe(true);
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

// Guards the HOME isolation + HERMES_HOME collapse: the hermes launch-agent
// template pins HOME/XDG/TMPDIR via $QUORUM_HOME_ENV but does NOT set
// HERMES_HOME. Hermes defaults HERMES_HOME to $HOME/.hermes, which is where
// HermesAgent.provision seeds config.yaml/.env/plugins/superpowers — so
// Hermes finds it all via the isolated $HOME. Verified live (Task 5 container
// probe): `--yes` and `--no-memory` do NOT exist on the real CLI and crash it
// with "unrecognized arguments"; the real approval-bypass flag is `--yolo`.
// Memory isolation comes from the throwaway per-run $HOME (a fresh
// ~/.hermes/state.db every run), not from a flag. Without this launcher,
// hand-typing `hermes --yolo` runs against the operator's real ~/.hermes and
// bypasses everything provision() seeded.
test('hermes launch-agent isolates HOME via $QUORUM_HOME_ENV, omits HERMES_HOME, and launches with --yolo', () => {
  const launcher = readFileSync(
    join(
      import.meta.dir,
      '..',
      'coding-agents',
      'hermes-context',
      'launch-agent',
    ),
    'utf8',
  );
  // HOME/XDG/TMPDIR isolation comes from the shared $QUORUM_HOME_ENV token.
  expect(launcher).toContain('$QUORUM_HOME_ENV');
  // HERMES_HOME is collapsed into $HOME — the launcher must NOT set it as an
  // env assignment on the exec line (the comment block may still mention it).
  expect(launcher).not.toContain('HERMES_HOME="$HERMES_HOME"');
  expect(launcher).not.toMatch(/\bHERMES_HOME=/);
  // The exec line itself: launches hermes (not a bare, unisolated invocation)
  // with the real approval-bypass flag, and the nonexistent --yes/--no-memory
  // flags (which would crash the real CLI) must never appear on it — the
  // comment block above may still mention them as history.
  const execLine = launcher
    .split('\n')
    .find((line) => line.startsWith('exec '));
  expect(execLine).toBe('exec env $QUORUM_HOME_ENV hermes --yolo "$@"');
  expect(execLine).not.toContain('--yes');
  expect(execLine).not.toContain('--no-memory');
  // cd into the prepared workdir before launch, like every other launcher.
  expect(launcher).toContain('cd "$QUORUM_AGENT_CWD"');
});
