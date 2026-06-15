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
import {
  CodexAgent,
  isCodexPluginCopyExcluded,
  isUnderDir,
} from '../src/agents/codex.ts';
import type {
  AppServerClient,
  AppServerHook,
  ReadHookArgs,
} from '../src/agents/codex-app-server.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

const CODEX_CONFIG: AgentConfig = {
  name: 'codex',
  binary: 'codex',
  agent_config_env: 'CODEX_HOME',
  session_log_dir: '${CODEX_HOME}/sessions',
  session_log_glob: '**/rollout-*.jsonl',
  normalizer: 'codex',
  required_env: ['SUPERPOWERS_ROOT'],
  max_time: '10m',
};

const HAPPY_HOOK: AppServerHook = {
  key: 'superpowers@debug:sessionStart',
  currentHash: 'abc123def456',
};

// Records every readHook call so a test can assert the app-server step was
// reached (or, for the self-copy guard, never reached) and returns a canned hook.
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

// === Change 2: the entire evals/ subtree at the superpowers root is excluded ===

test('isCodexPluginCopyExcluded excludes <root>/evals (basename evals, parent is root)', () => {
  const root = '/some/superpowers';
  expect(isCodexPluginCopyExcluded(join(root, 'evals'), root)).toBe(true);
});

test('isCodexPluginCopyExcluded keeps <root>/skills, <root>/hooks, <root>/docs', () => {
  const root = '/some/superpowers';
  expect(isCodexPluginCopyExcluded(join(root, 'skills'), root)).toBe(false);
  expect(isCodexPluginCopyExcluded(join(root, 'hooks'), root)).toBe(false);
  expect(isCodexPluginCopyExcluded(join(root, 'docs'), root)).toBe(false);
});

test('isCodexPluginCopyExcluded does not exclude a nested evals dir whose parent is not the root', () => {
  const root = '/some/superpowers';
  expect(
    isCodexPluginCopyExcluded(join(root, 'skills', 'foo', 'evals'), root),
  ).toBe(false);
});

test('isCodexPluginCopyExcluded still excludes the always-ignored set anywhere', () => {
  const root = '/some/superpowers';
  expect(isCodexPluginCopyExcluded(join(root, '.git'), root)).toBe(true);
  expect(isCodexPluginCopyExcluded(join(root, 'node_modules'), root)).toBe(
    true,
  );
  expect(
    isCodexPluginCopyExcluded(join(root, 'skills', 'node_modules'), root),
  ).toBe(true);
});

test('provision drops the whole evals subtree but copies skills and hooks', () => {
  const { home, cleanup } = makeTempHome();
  const root = mkdtempSync(join(tmpdir(), 'codex-sproot-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'session-start'), '#!/bin/sh\n');
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
      agent.provision(home, new FakeCommandRunner());
      const pluginRoot = join(
        home.configDir,
        'plugins',
        'cache',
        'debug',
        'superpowers',
        'local',
      );
      expect(existsSync(join(pluginRoot, 'skills', 'a-skill.md'))).toBe(true);
      expect(existsSync(join(pluginRoot, 'hooks', 'session-start'))).toBe(true);
      // The entire evals/ subtree is excluded.
      expect(existsSync(join(pluginRoot, 'evals'))).toBe(false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authParent, { recursive: true, force: true });
    cleanup();
  }
});

// === Change 3: self-copy fail-fast guard ===

test('isUnderDir is true when child is strictly under parent', () => {
  expect(isUnderDir('/a/b/c', '/a/b')).toBe(true);
  expect(isUnderDir('/a/b/c/d', '/a/b')).toBe(true);
});

test('isUnderDir is true when child equals parent', () => {
  expect(isUnderDir('/a/b', '/a/b')).toBe(true);
});

test('isUnderDir is false for disjoint and prefix-but-not-child paths', () => {
  expect(isUnderDir('/a/x', '/a/b')).toBe(false);
  // "/a/bc" must NOT count as under "/a/b" (no false prefix match).
  expect(isUnderDir('/a/bc', '/a/b')).toBe(false);
});

test('provision throws a clear ProvisionError when the out-root is under SUPERPOWERS_ROOT', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-selfcopy-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  // The run home (and thus pluginRoot) lives UNDER the superpowers root — the
  // self-copy condition cpSync rejects cryptically.
  const configDir = join(root, 'evals', 'run', 'coding-agent-config');
  const workdir = join(root, 'evals', 'run', 'coding-agent-workdir');
  mkdirSync(workdir, { recursive: true });
  const home = { configDir, workdir, skeletonRoot: undefined };
  const authParent = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, root, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      expect(() => agent.provision(home, new FakeCommandRunner())).toThrow(
        ProvisionError,
      );
      expect(() => agent.provision(home, new FakeCommandRunner())).toThrow(
        /SUPERPOWERS_ROOT/,
      );
      // The guard fires before the app-server read.
      expect(appServer.calls.length).toBe(0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authParent, { recursive: true, force: true });
  }
});

test('provision does not throw the self-copy guard when out-root is disjoint from SUPERPOWERS_ROOT', () => {
  const { home, cleanup } = makeTempHome();
  const root = mkdtempSync(join(tmpdir(), 'codex-disjoint-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'a-skill.md'), '# skill\n');
  const authParent = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  const appServer = new FakeAppServerClient();

  try {
    withHostAuth(authParent, root, () => {
      const agent = new CodexAgent(CODEX_CONFIG, appServer);
      // home from makeTempHome lives under tmpdir(), disjoint from `root`.
      expect(() =>
        agent.provision(home, new FakeCommandRunner()),
      ).not.toThrow();
      expect(appServer.calls.length).toBe(1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authParent, { recursive: true, force: true });
    cleanup();
  }
});
