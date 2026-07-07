import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAgent } from '../src/agents/codex.ts';
import type {
  AppServerClient,
  AppServerHook,
  ReadHookArgs,
} from '../src/agents/codex-app-server.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

const CODEX_CONFIG: AgentConfig = {
  name: 'codex',
  binary: 'codex',
  home_config_subdir: '.codex',
  session_log_dir: '${QUORUM_AGENT_HOME}/.codex/sessions',
  session_log_glob: '**/rollout-*.jsonl',
  normalizer: 'codex',
  required_env: ['SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
};

const HAPPY_HOOK: AppServerHook = {
  key: 'superpowers@debug:sessionStart',
  currentHash: 'abc123def456',
};

// Records every readHook call so a test can assert the app-server step was
// reached and returns a canned hook.
class FakeAppServerClient implements AppServerClient {
  readonly calls: ReadHookArgs[] = [];
  readHook(args: ReadHookArgs): AppServerHook {
    this.calls.push(args);
    return HAPPY_HOOK;
  }
}

const SUBSCRIPTION_AUTH = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { refresh_token: 'r' },
} as const;

// Subscription credential for all tests in this file — provision() requires a
// credential since B4; these tests exercise the subscription path.
const SUBSCRIPTION_CRED: Credential = {
  model: 'codex-sub',
  harnesses: ['codex'],
  api: 'openai-responses',
  auth: 'subscription',
  compat: {},
};

// Stage <authParent>/.codex/auth.json, point CODEX_AUTH_HOME + SUPERPOWERS_ROOT
// at the staged dirs, run body, and restore env on throw.
function withHostAuth(
  authParent: string,
  superpowersRoot: string,
  body: () => void,
): void {
  const codexDir = join(authParent, '.codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, 'auth.json'),
    `${JSON.stringify(SUBSCRIPTION_AUTH)}\n`,
  );
  const prevAuthHome = process.env['CODEX_AUTH_HOME'];
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  process.env['CODEX_AUTH_HOME'] = codexDir;
  process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  try {
    body();
  } finally {
    if (prevAuthHome === undefined) delete process.env['CODEX_AUTH_HOME'];
    else process.env['CODEX_AUTH_HOME'] = prevAuthHome;
    if (prevRoot === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prevRoot;
  }
}

const PLUGIN_ROOT_SEGMENTS = [
  'plugins',
  'cache',
  'debug',
  'superpowers',
  'local',
] as const;

// PRI-2506 UPDATED: stages skills (hooks dir is still copied but manifest hooks:{}).
test('provision stages skills and hooks and drops the whole evals subtree', () => {
  const { home, cleanup } = makeTempHome();
  const root = mkdtempSync(join(tmpdir(), 'codex-sproot-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'session-start'), '#!/bin/sh\n');
  // PRI-2506: manifest with skills field is required.
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'superpowers', skills: './skills/', hooks: null }),
  );
  // A realistic evals/ submodule with the artifacts that must never be staged.
  mkdirSync(join(root, 'evals', 'results', 'deep'), { recursive: true });
  writeFileSync(
    join(root, 'evals', 'results', 'deep', 'transcript.json'),
    '{}',
  );
  writeFileSync(join(root, 'evals', 'README.md'), '# evals\n');
  const authParent = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, root, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      agent.provision(home, new FakeCommandRunner(), SUBSCRIPTION_CRED);
      const pluginRoot = join(home.configDir, ...PLUGIN_ROOT_SEGMENTS);
      expect(existsSync(join(pluginRoot, 'skills', 'a-skill.md'))).toBe(true);
      expect(existsSync(join(pluginRoot, 'hooks', 'session-start'))).toBe(true);
      // The entire evals/ subtree is excluded.
      expect(existsSync(join(pluginRoot, 'evals'))).toBe(false);
      // PRI-2506: Zero app-server calls (hook-less).
      expect(appServer.calls.length).toBe(0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authParent, { recursive: true, force: true });
    cleanup();
  }
});

// PRI-2506 UPDATED: add manifest, expect zero app-server calls.
test('provision succeeds when the out-root resolves UNDER SUPERPOWERS_ROOT', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-selfcopy-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  // PRI-2506: manifest with skills field.
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'superpowers', skills: './skills/', hooks: null }),
  );
  // The run home (and thus pluginRoot) lives UNDER the superpowers root — the
  // default results/ out-root. The shared plugin-stage helper skips the evals
  // subtree that holds the dest, so the copy never recurses into itself.
  const configDir = join(root, 'evals', 'run', 'coding-agent-config');
  const workdir = join(root, 'evals', 'run', 'coding-agent-workdir');
  mkdirSync(workdir, { recursive: true });
  const home = { configDir, workdir, skeletonRoot: undefined };
  const authParent = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, root, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() =>
        agent.provision(home, new FakeCommandRunner(), SUBSCRIPTION_CRED),
      ).not.toThrow();
      const pluginRoot = join(configDir, ...PLUGIN_ROOT_SEGMENTS);
      expect(existsSync(join(pluginRoot, 'skills', 'a-skill.md'))).toBe(true);
      // The evals subtree that contains pluginRoot is never staged.
      expect(existsSync(join(pluginRoot, 'evals'))).toBe(false);
      // PRI-2506: Zero app-server calls (hook-less).
      expect(appServer.calls.length).toBe(0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authParent, { recursive: true, force: true });
  }
});

// PRI-2506 UPDATED: add manifest, expect zero app-server calls.
test('provision succeeds when out-root is disjoint from SUPERPOWERS_ROOT', () => {
  const { home, cleanup } = makeTempHome();
  const root = mkdtempSync(join(tmpdir(), 'codex-disjoint-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  // PRI-2506: manifest with skills field.
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'superpowers', skills: './skills/', hooks: null }),
  );
  const authParent = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, root, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      // home from makeTempHome lives under tmpdir(), disjoint from `root`.
      expect(() =>
        agent.provision(home, new FakeCommandRunner(), SUBSCRIPTION_CRED),
      ).not.toThrow();
      // PRI-2506: Zero app-server calls (hook-less).
      expect(appServer.calls.length).toBe(0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authParent, { recursive: true, force: true });
    cleanup();
  }
});
