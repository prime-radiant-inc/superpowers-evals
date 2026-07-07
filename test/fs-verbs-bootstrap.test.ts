// Unit tests for the 6 per-harness bootstrap check verbs. Each verb resolves the
// coding-agent's collapsed config dir from QUORUM_AGENT_CONFIG_DIR and appends a
// per-agent subpath. The tests stage the expected files under a temp config dir,
// set QUORUM_AGENT_CONFIG_DIR via the CheckContext, and assert pass when the
// files exist and fail when they are absent (or the env var is unset). Hermetic:
// temp dirs only, no real $HOME.

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CheckContext,
  verbAntigravityPluginInstalled,
  verbBootstrapInstalled,
  verbCodexNativeHookConfigured,
  verbCodexSessionStartHookExecutes,
  verbCopilotPluginInstalled,
  verbGeminiExtensionLinked,
  verbKimiPluginInstalled,
  verbOpencodePluginInstalled,
} from '../src/check/fs-verbs.ts';

function configDir(): string {
  return mkdtempSync(join(tmpdir(), 'bootstrap-cfg-'));
}

// A CheckContext whose env returns the staged config dir (and any extras). cwd is
// the config dir so the codex verb's resolve(ctx.cwd, …) of its absolute config
// path is stable.
function ctxFor(cfg: string, extra: Record<string, string> = {}): CheckContext {
  const env: Record<string, string> = {
    QUORUM_AGENT_CONFIG_DIR: cfg,
    ...extra,
  };
  return { cwd: cfg, env: (k) => env[k] };
}

// Write a file (creating parent dirs) under `root`.
function writeUnder(root: string, rel: string, body = 'x'): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

// ---------------------------------------------------------------------------
// antigravity-plugin-installed: <configDir>/.gemini/config/plugins/superpowers
// ---------------------------------------------------------------------------
const ANTIGRAVITY_SUBPATH = '.gemini/config/plugins/superpowers';
const ANTIGRAVITY_FILES = [
  'plugin.json',
  'hooks.json',
  'skills/using-superpowers/SKILL.md',
];

test('antigravity-plugin-installed passes when the plugin files exist', () => {
  const cfg = configDir();
  for (const rel of ANTIGRAVITY_FILES) {
    writeUnder(cfg, join(ANTIGRAVITY_SUBPATH, rel));
  }
  const out = verbAntigravityPluginInstalled([], ctxFor(cfg));
  expect(out.passed).toBe(true);
});

test('antigravity-plugin-installed fails when a plugin file is missing', () => {
  const cfg = configDir();
  // Stage all but the last required file.
  for (const rel of ANTIGRAVITY_FILES.slice(0, -1)) {
    writeUnder(cfg, join(ANTIGRAVITY_SUBPATH, rel));
  }
  const out = verbAntigravityPluginInstalled([], ctxFor(cfg));
  expect(out.passed).toBe(false);
});

test('antigravity-plugin-installed fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const out = verbAntigravityPluginInstalled([], {
    cwd: '/tmp',
    env: () => undefined,
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});

// ---------------------------------------------------------------------------
// copilot-plugin-installed: <configDir>/plugins/superpowers
// ---------------------------------------------------------------------------
const COPILOT_SUBPATH = 'plugins/superpowers';
const COPILOT_FILES = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/run-hook.cmd',
  'hooks/session-start',
  'skills/using-superpowers/SKILL.md',
  'skills/brainstorming/SKILL.md',
  'skills/using-superpowers/references/copilot-tools.md',
];

test('copilot-plugin-installed passes when the plugin files exist', () => {
  const cfg = configDir();
  for (const rel of COPILOT_FILES) {
    writeUnder(cfg, join(COPILOT_SUBPATH, rel));
  }
  const out = verbCopilotPluginInstalled([], ctxFor(cfg));
  expect(out.passed).toBe(true);
});

test('copilot-plugin-installed fails when a plugin file is missing', () => {
  const cfg = configDir();
  for (const rel of COPILOT_FILES.slice(0, -1)) {
    writeUnder(cfg, join(COPILOT_SUBPATH, rel));
  }
  const out = verbCopilotPluginInstalled([], ctxFor(cfg));
  expect(out.passed).toBe(false);
});

test('copilot-plugin-installed fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const out = verbCopilotPluginInstalled([], {
    cwd: '/tmp',
    env: () => undefined,
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});

// ---------------------------------------------------------------------------
// opencode-plugin-installed: <configDir>/.config/opencode/{plugins/superpowers.js,
//   superpowers/skills/using-superpowers/SKILL.md}
// ---------------------------------------------------------------------------
const OPENCODE_BASE = '.config/opencode';

test('opencode-plugin-installed passes when the plugin + skill exist', () => {
  const cfg = configDir();
  writeUnder(cfg, join(OPENCODE_BASE, 'plugins/superpowers.js'));
  writeUnder(
    cfg,
    join(OPENCODE_BASE, 'superpowers/skills/using-superpowers/SKILL.md'),
  );
  const out = verbOpencodePluginInstalled([], ctxFor(cfg));
  expect(out.passed).toBe(true);
});

test('opencode-plugin-installed fails when the using-superpowers skill is missing', () => {
  const cfg = configDir();
  writeUnder(cfg, join(OPENCODE_BASE, 'plugins/superpowers.js'));
  const out = verbOpencodePluginInstalled([], ctxFor(cfg));
  expect(out.passed).toBe(false);
});

test('opencode-plugin-installed fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const out = verbOpencodePluginInstalled([], {
    cwd: '/tmp',
    env: () => undefined,
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});

// ---------------------------------------------------------------------------
// gemini-extension-linked: <configDir>/.gemini/{extension metadata files}
// ---------------------------------------------------------------------------
const GEMINI_SUBPATH = '.gemini';
const GEMINI_FILES = [
  'extensions/superpowers/.gemini-extension-install.json',
  'extensions/extension-enablement.json',
  'extension_integrity.json',
];

test('gemini-extension-linked passes when the metadata files exist', () => {
  const cfg = configDir();
  for (const rel of GEMINI_FILES) {
    writeUnder(cfg, join(GEMINI_SUBPATH, rel));
  }
  const out = verbGeminiExtensionLinked([], ctxFor(cfg));
  expect(out.passed).toBe(true);
});

test('gemini-extension-linked fails when a metadata file is missing', () => {
  const cfg = configDir();
  for (const rel of GEMINI_FILES.slice(0, -1)) {
    writeUnder(cfg, join(GEMINI_SUBPATH, rel));
  }
  const out = verbGeminiExtensionLinked([], ctxFor(cfg));
  expect(out.passed).toBe(false);
});

test('gemini-extension-linked fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const out = verbGeminiExtensionLinked([], {
    cwd: '/tmp',
    env: () => undefined,
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});

// ---------------------------------------------------------------------------
// kimi-plugin-installed: <configDir>/plugins/installed.json points a single
// enabled local-path Superpowers plugin at SUPERPOWERS_ROOT, which holds the
// required plugin files.
// ---------------------------------------------------------------------------
function stageKimiPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-kimi-sproot-'));
  writeUnder(root, '.kimi-plugin/plugin.json', '{"name":"superpowers"}\n');
  writeUnder(
    root,
    'skills/using-superpowers/SKILL.md',
    '# using-superpowers\n',
  );
  return root;
}

function writeKimiInstalled(cfg: string, pluginRoot: string): void {
  writeUnder(
    cfg,
    'plugins/installed.json',
    JSON.stringify({
      plugins: [
        {
          id: 'superpowers',
          enabled: true,
          source: 'local-path',
          root: pluginRoot,
        },
      ],
    }),
  );
}

test('kimi-plugin-installed passes for a single enabled local-path plugin at SUPERPOWERS_ROOT', () => {
  const cfg = configDir();
  const pluginRoot = stageKimiPluginRoot();
  writeKimiInstalled(cfg, pluginRoot);
  const out = verbKimiPluginInstalled(
    [],
    ctxFor(cfg, { SUPERPOWERS_ROOT: pluginRoot }),
  );
  expect(out.passed).toBe(true);
});

test('kimi-plugin-installed fails when installed.json is missing', () => {
  const cfg = configDir();
  const pluginRoot = stageKimiPluginRoot();
  const out = verbKimiPluginInstalled(
    [],
    ctxFor(cfg, { SUPERPOWERS_ROOT: pluginRoot }),
  );
  expect(out.passed).toBe(false);
});

test('kimi-plugin-installed fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const pluginRoot = stageKimiPluginRoot();
  const out = verbKimiPluginInstalled([], {
    cwd: '/tmp',
    env: (k) => (k === 'SUPERPOWERS_ROOT' ? pluginRoot : undefined),
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});

// Write an installed.json with one enabled Superpowers plugin whose entry
// fields are overridden, so the verb passes the file-existence guard and
// reaches its content-validation branch.
function writeKimiInstalledEntry(
  cfg: string,
  entry: Record<string, unknown>,
): void {
  writeUnder(
    cfg,
    'plugins/installed.json',
    JSON.stringify({
      plugins: [{ id: 'superpowers', enabled: true, ...entry }],
    }),
  );
}

test('kimi-plugin-installed fails when the plugin source is not local-path', () => {
  const cfg = configDir();
  const pluginRoot = stageKimiPluginRoot();
  writeKimiInstalledEntry(cfg, { source: 'registry', root: pluginRoot });
  const out = verbKimiPluginInstalled(
    [],
    ctxFor(cfg, { SUPERPOWERS_ROOT: pluginRoot }),
  );
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('source must be local-path');
});

test('kimi-plugin-installed fails when the plugin root points away from SUPERPOWERS_ROOT', () => {
  const cfg = configDir();
  const pluginRoot = stageKimiPluginRoot();
  const otherRoot = stageKimiPluginRoot();
  writeKimiInstalledEntry(cfg, { source: 'local-path', root: otherRoot });
  const out = verbKimiPluginInstalled(
    [],
    ctxFor(cfg, { SUPERPOWERS_ROOT: pluginRoot }),
  );
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('does not match SUPERPOWERS_ROOT');
});

// ---------------------------------------------------------------------------
// PRI-2506: codex-native-hook-configured checks for plugins-only config (no
// hooks/plugin_hooks/trusted_hash) + staged manifest with hooks:{} and skills.
// ---------------------------------------------------------------------------
const CODEX_PLUGIN_SUBPATH = 'plugins/cache/debug/superpowers/local';
const CODEX_CONFIG_TOML = [
  '[features]',
  'plugins = true',
  '',
  '[plugins."superpowers@debug"]',
  'enabled = true',
  '',
].join('\n');

// PRI-2506: stage a hook-less codex config (plugins-only, manifest with hooks:{} + skills).
function stageCodexConfig(cfg: string): void {
  writeUnder(cfg, 'config.toml', CODEX_CONFIG_TOML);
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, '.codex-plugin/plugin.json'),
    JSON.stringify({ name: 'superpowers', skills: './skills/', hooks: {} }),
  );
}

// PRI-2506 UPDATED: hook-less provisioning tests.
test('codex-native-hook-configured passes for plugins-only config + manifest with hooks:{} + skills', () => {
  const cfg = configDir();
  stageCodexConfig(cfg);
  const out = verbCodexNativeHookConfigured([], ctxFor(cfg));
  expect(out.passed).toBe(true);
  expect(out.detail).toContain('hook-less');
});

test('codex-native-hook-configured fails when the staged plugin manifest is missing', () => {
  const cfg = configDir();
  writeUnder(cfg, 'config.toml', CODEX_CONFIG_TOML);
  const out = verbCodexNativeHookConfigured([], ctxFor(cfg));
  expect(out.passed).toBe(false);
});

test('codex-native-hook-configured fails when QUORUM_AGENT_CONFIG_DIR is unset', () => {
  const out = verbCodexNativeHookConfigured([], {
    cwd: '/tmp',
    env: () => undefined,
  });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_AGENT_CONFIG_DIR');
});

// PRI-2506: Stage the manifest with hooks:{} + skills so file-existence guards pass,
// then write a config.toml body so the verb reaches its content-validation branches.
function stageCodexConfigWithToml(cfg: string, toml: string): void {
  writeUnder(cfg, 'config.toml', toml);
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, '.codex-plugin/plugin.json'),
    JSON.stringify({ name: 'superpowers', skills: './skills/', hooks: {} }),
  );
}

function stageCodexSessionStartHook(
  cfg: string,
  command: string,
  commandWindows?: string,
): void {
  stageCodexConfig(cfg);
  const hook: Record<string, unknown> = {
    type: 'command',
    command,
    async: false,
  };
  if (commandWindows !== undefined) {
    hook['commandWindows'] = commandWindows;
  }
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, 'hooks/hooks-codex.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [hook],
          },
        ],
      },
    }),
  );
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, 'hooks/run-hook.cmd'),
    [
      '@echo off',
      'echo {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You have superpowers"}}',
      '',
    ].join('\r\n'),
  );
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, 'hooks/session-start-codex'),
    '#!/usr/bin/env bash\n',
  );
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, 'skills/using-superpowers/SKILL.md'),
    '# using-superpowers\nYou have superpowers\n',
  );
}

function commandAvailable(binary: string): boolean {
  const proc = spawnSync(binary, [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    'exit 0',
  ]);
  return proc.error === undefined && (proc.status ?? 1) === 0;
}

const windowsPowerShellTest =
  process.platform === 'win32' &&
  (commandAvailable('pwsh') || commandAvailable('powershell'))
    ? test
    : test.skip;

// PRI-2506 UPDATED: test hook-less expectations (no plugin_hooks/trusted_hash).
test('codex-native-hook-configured fails when the debug plugin table is absent', () => {
  const cfg = configDir();
  const toml = CODEX_CONFIG_TOML.split('\n')
    .filter((l) => l !== '[plugins."superpowers@debug"]')
    .join('\n');
  stageCodexConfigWithToml(cfg, toml);
  const out = verbCodexNativeHookConfigured([], ctxFor(cfg));
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('debug Superpowers plugin not enabled');
});

// PRI-2506: new test for manifest hooks validation (must be empty object).
test('codex-native-hook-configured fails when manifest hooks is non-empty', () => {
  const cfg = configDir();
  writeUnder(cfg, 'config.toml', CODEX_CONFIG_TOML);
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: 'superpowers',
      skills: './skills/',
      hooks: { SessionStart: [] },
    }),
  );
  const out = verbCodexNativeHookConfigured([], ctxFor(cfg));
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('hooks');
});

// PRI-2506: new test for manifest skills validation (must be present).
test('codex-native-hook-configured fails when manifest missing skills', () => {
  const cfg = configDir();
  writeUnder(cfg, 'config.toml', CODEX_CONFIG_TOML);
  writeUnder(
    cfg,
    join(CODEX_PLUGIN_SUBPATH, '.codex-plugin/plugin.json'),
    JSON.stringify({ name: 'superpowers', hooks: {} }),
  );
  const out = verbCodexNativeHookConfigured([], ctxFor(cfg));
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('skills');
});

// PRI-2506 UPDATED: codex-session-start-hook-executes always passes (hook-less by design).
test('codex-session-start-hook-executes always passes with hook-less note', () => {
  const cfg = configDir();
  const out = verbCodexSessionStartHookExecutes([], ctxFor(cfg));
  expect(out.passed).toBe(true);
  expect(out.detail).toContain('hook-less');
  expect(out.detail).toContain('no SessionStart bootstrap');
});

windowsPowerShellTest(
  'codex-session-start-hook-executes passes for default command plus Windows override',
  () => {
    const cfg = configDir();
    stageCodexSessionStartHook(
      cfg,
      '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex',
      '& "${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex',
    );
    const out = verbCodexSessionStartHookExecutes([], ctxFor(cfg));
    expect(out.passed).toBe(true);
  },
);

// ---------------------------------------------------------------------------
// bootstrap-installed: dispatch on QUORUM_CODING_AGENT
// ---------------------------------------------------------------------------

test('bootstrap-installed routes to the per-harness delegate (gemini)', () => {
  // Unstaged config -> the gemini delegate fails with its own message, which
  // proves routing without needing to stage the gemini file set.
  const cfg = configDir();
  const out = verbBootstrapInstalled(
    [],
    ctxFor(cfg, { QUORUM_CODING_AGENT: 'gemini' }),
  );
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('Gemini');
});

test('bootstrap-installed passes for claude variants (no dedicated check)', () => {
  for (const agent of ['claude', 'claude-windows']) {
    const out = verbBootstrapInstalled(
      [],
      ctxFor(configDir(), { QUORUM_CODING_AGENT: agent }),
    );
    expect(out.passed).toBe(true);
    expect(out.detail).toContain('no dedicated install check');
  }
});

test('bootstrap-installed passes for pi (no dedicated check)', () => {
  const out = verbBootstrapInstalled(
    [],
    ctxFor(configDir(), { QUORUM_CODING_AGENT: 'pi' }),
  );
  expect(out.passed).toBe(true);
});

test('bootstrap-installed passes for serf (no dedicated check)', () => {
  // serf loads Superpowers via --plugin-dir SUPERPOWERS_ROOT (no staging, like
  // claude), so there is nothing to verify on disk; the bootstrap is proven
  // behaviorally by the scenario.
  const out = verbBootstrapInstalled(
    [],
    ctxFor(configDir(), { QUORUM_CODING_AGENT: 'serf' }),
  );
  expect(out.passed).toBe(true);
  expect(out.detail).toContain('no dedicated install check');
});

test('bootstrap-installed fails for an unrecognized agent', () => {
  const out = verbBootstrapInstalled(
    [],
    ctxFor(configDir(), { QUORUM_CODING_AGENT: 'bogus' }),
  );
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('unrecognized');
});

test('bootstrap-installed fails when QUORUM_CODING_AGENT is unset', () => {
  const out = verbBootstrapInstalled([], { cwd: '/tmp', env: () => undefined });
  expect(out.passed).toBe(false);
  expect(out.detail).toContain('QUORUM_CODING_AGENT');
});
