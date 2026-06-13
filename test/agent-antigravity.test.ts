import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ANTIGRAVITY_RATE_LIMIT_MARKER,
  AntigravityAgent,
} from '../src/agents/antigravity.ts';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// An antigravity.yaml-shaped config (mirrors coding-agents/antigravity.yaml).
// The fields the adapter reads are agent_config_env and required_env.
const ANTIGRAVITY_CONFIG: AgentConfig = {
  name: 'antigravity',
  binary: 'agy',
  agent_config_env: 'ANTIGRAVITY_CONFIG_DIR',
  session_log_dir: '${ANTIGRAVITY_CONFIG_DIR}/.gemini/antigravity-cli/brain',
  session_log_glob: '**/transcript.jsonl',
  normalizer: 'antigravity',
  required_env: ['SUPERPOWERS_ROOT'],
  max_time: '10m',
  max_concurrency: 1,
};

// Pull the throwaway --gemini_dir=<path> out of a preflight argv. The real agy
// writes its state (including the brain transcript) under this dir; the fake
// simulates that so the preflight's isolation assertion has something to find.
function geminiDirArg(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--gemini_dir=')) {
      return arg.slice('--gemini_dir='.length);
    }
  }
  return undefined;
}

// Did this argv carry the `plugin install` subcommand?
function isPluginInstall(args: readonly string[]): boolean {
  return args.includes('plugin') && args.includes('install');
}

// Write the transcript the real agy would drop under the isolated --gemini_dir
// during the auth preflight, proving the --gemini_dir isolation seam took hold.
function writePreflightTranscript(geminiDir: string): void {
  const transcript = join(
    geminiDir,
    'antigravity-cli',
    'brain',
    'session-001',
    'transcript.jsonl',
  );
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, '{"role":"model","text":"OK"}\n');
}

// Stage the Superpowers plugin files the real `agy plugin install` would copy
// into <configDir>/.gemini/config/plugins/superpowers/.
function writeInstalledPlugin(geminiDir: string): void {
  const pluginRoot = join(geminiDir, 'config', 'plugins', 'superpowers');
  mkdirSync(join(pluginRoot, 'skills', 'using-superpowers'), {
    recursive: true,
  });
  writeFileSync(join(pluginRoot, 'plugin.json'), '{"name":"superpowers"}\n');
  writeFileSync(join(pluginRoot, 'hooks.json'), '{"hooks":[]}\n');
  writeFileSync(
    join(pluginRoot, 'skills', 'using-superpowers', 'SKILL.md'),
    '# using-superpowers\n',
  );
}

// Happy-path responder: the preflight replies "OK" and drops an isolated
// transcript; plugin install stages the required plugin files; everything else
// is a default success.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command !== 'agy') {
    return { status: 0, stdout: '', stderr: '' };
  }
  const geminiDir = geminiDirArg(args);
  if (isPluginInstall(args)) {
    if (geminiDir !== undefined) {
      writeInstalledPlugin(geminiDir);
    }
    return { status: 0, stdout: '', stderr: '' };
  }
  // Preflight (--print).
  if (geminiDir !== undefined) {
    writePreflightTranscript(geminiDir);
  }
  return { status: 0, stdout: 'OK\n', stderr: '' };
}

// Set SUPERPOWERS_ROOT around `body`, restoring the prior value even on throw.
// getEnv reads process.env; biome noProcessEnv is OFF for test/agent-*.test.ts.
function withRoot(superpowersRoot: string | undefined, body: () => void): void {
  const prev = process.env['SUPERPOWERS_ROOT'];
  if (superpowersRoot === undefined) {
    delete process.env['SUPERPOWERS_ROOT'];
  } else {
    process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  }
  try {
    body();
  } finally {
    if (prev === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prev;
    }
  }
}

test('provision seeds the .gemini tree, preflights, installs the plugin, and writes settings', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      const env = agent.provision(home, runner);

      // Returned env: ANTIGRAVITY_CONFIG_DIR -> configDir, nothing else.
      expect(env).toEqual({ ANTIGRAVITY_CONFIG_DIR: home.configDir });

      // Config dir + the installed plugin tree exist.
      expect(existsSync(home.configDir)).toBe(true);
      const pluginRoot = join(
        home.configDir,
        '.gemini',
        'config',
        'plugins',
        'superpowers',
      );
      expect(existsSync(join(pluginRoot, 'plugin.json'))).toBe(true);
      expect(existsSync(join(pluginRoot, 'hooks.json'))).toBe(true);
      expect(
        existsSync(join(pluginRoot, 'skills', 'using-superpowers', 'SKILL.md')),
      ).toBe(true);

      // settings.json: no-prompt posture, deep-equal the exact Python payload.
      const settingsPath = join(
        home.configDir,
        '.gemini',
        'antigravity-cli',
        'settings.json',
      );
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // trustedWorkspaces carries the workdir in both literal and resolved
      // forms, de-duplicated (they coincide for an already-normalized temp
      // path), matching the Python setdefault+dedup loop.
      const expectedTrusted = [
        ...new Set([home.workdir, resolve(home.workdir)]),
      ];
      expect(settings).toEqual({
        trustedWorkspaces: expectedTrusted,
        toolPermission: 'always-proceed',
        artifactReviewPolicy: 'always-proceed',
        permissions: {
          allow: [
            'command(*)',
            'unsandboxed(*)',
            'read_file(*)',
            'write_file(*)',
            'read_url(*)',
            'execute_url(*)',
            'mcp(*)',
          ],
          ask: [],
          deny: [],
        },
      });
    });
  } finally {
    cleanup();
  }
});

test('provision drives the expected agy subprocess calls (preflight then install)', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      agent.provision(home, runner);

      expect(runner.calls.length).toBe(2);

      // 1. Preflight: --print "Reply with EXACTLY OK." against a throwaway
      //    --gemini_dir, with auto-update disabled.
      const preflight = runner.calls[0];
      expect(preflight?.command).toBe('agy');
      expect(preflight?.args).toContain('--dangerously-skip-permissions');
      expect(preflight?.args).toContain('--print');
      expect(preflight?.args).toContain('Reply with EXACTLY OK.');
      expect(preflight?.args).toContain('--print-timeout');
      expect(preflight?.args).toContain('60s');
      expect(preflight?.options?.env?.['AGY_CLI_DISABLE_AUTO_UPDATE']).toBe(
        'true',
      );
      // The preflight --gemini_dir is throwaway: NOT the run config dir.
      const preflightGeminiDir = geminiDirArg(preflight?.args ?? []);
      expect(preflightGeminiDir).toBeDefined();
      expect(preflightGeminiDir).not.toBe(join(home.configDir, '.gemini'));

      // 2. Plugin install against the real per-run --gemini_dir, cwd=configDir.
      const install = runner.calls[1];
      expect(install?.command).toBe('agy');
      expect(install?.args).toEqual([
        `--gemini_dir=${join(home.configDir, '.gemini')}`,
        'plugin',
        'install',
        spRoot,
      ]);
      expect(install?.options?.cwd).toBe(home.configDir);
      expect(install?.options?.env?.['AGY_CLI_DISABLE_AUTO_UPDATE']).toBe(
        'true',
      );
    });
  } finally {
    cleanup();
  }
});

test('preflight tolerates punctuation/case/whitespace in the OK reply', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  // Reply "  ok.!  " — normalizes to OK.
  const runner = new FakeCommandRunner((command, args) => {
    if (command !== 'agy') {
      return { status: 0, stdout: '', stderr: '' };
    }
    const geminiDir = geminiDirArg(args);
    if (isPluginInstall(args)) {
      if (geminiDir !== undefined) {
        writeInstalledPlugin(geminiDir);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (geminiDir !== undefined) {
      writePreflightTranscript(geminiDir);
    }
    return { status: 0, stdout: '  ok.!  \n', stderr: '' };
  });

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      const env = agent.provision(home, runner);
      expect(env).toEqual({ ANTIGRAVITY_CONFIG_DIR: home.configDir });
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  // Preflight fails; the adapter must abort before the plugin-install step.
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'agy' && !isPluginInstall(args)) {
      return { status: 1, stdout: '', stderr: 'keyring auth missing' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // Only the preflight was attempted (no plugin install after the failure).
      expect(runner.calls.length).toBe(1);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight reply is not OK', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  // Exit 0 but a verbose, non-OK reply.
  const runner = new FakeCommandRunner((command, args) => {
    if (command !== 'agy') {
      return { status: 0, stdout: '', stderr: '' };
    }
    const geminiDir = geminiDirArg(args);
    if (!isPluginInstall(args) && geminiDir !== undefined) {
      writePreflightTranscript(geminiDir);
    }
    if (isPluginInstall(args)) {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: 'Sure, here is OK and more.\n', stderr: '' };
  });

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      let caught: unknown;
      try {
        agent.provision(home, runner);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProvisionError);
      expect((caught as ProvisionError).message).toContain('did not return OK');
      expect(runner.calls.length).toBe(1);
    });
  } finally {
    cleanup();
  }
});

test('a throttled preflight surfaces the Code Assist rate-limit marker', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  // Empty reply + a RESOURCE_EXHAUSTED log: the rate-limit diagnosis must win.
  const runner = new FakeCommandRunner((command, args) => {
    if (command !== 'agy') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (isPluginInstall(args)) {
      return { status: 0, stdout: '', stderr: '' };
    }
    const geminiDir = geminiDirArg(args);
    // Write the agy log the adapter reads for rate-limit signals. The --log-file
    // path sits beside the throwaway --gemini_dir (both under the temp root).
    if (geminiDir !== undefined) {
      const logPath = join(dirname(geminiDir), 'agy.log');
      writeFileSync(logPath, 'error: rpc Code Assist RESOURCE_EXHAUSTED\n');
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      let caught: unknown;
      try {
        agent.provision(home, runner);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProvisionError);
      expect((caught as ProvisionError).message).toContain(
        ANTIGRAVITY_RATE_LIMIT_MARKER,
      );
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(undefined, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // No subprocess attempted: the env guard precedes the preflight.
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when an expected plugin file is missing', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  // Preflight OK, but plugin install stages an INCOMPLETE tree (no SKILL.md).
  const runner = new FakeCommandRunner((command, args) => {
    if (command !== 'agy') {
      return { status: 0, stdout: '', stderr: '' };
    }
    const geminiDir = geminiDirArg(args);
    if (isPluginInstall(args)) {
      if (geminiDir !== undefined) {
        const pluginRoot = join(geminiDir, 'config', 'plugins', 'superpowers');
        mkdirSync(pluginRoot, { recursive: true });
        writeFileSync(join(pluginRoot, 'plugin.json'), '{}\n');
        writeFileSync(join(pluginRoot, 'hooks.json'), '{}\n');
        // SKILL.md intentionally omitted.
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (geminiDir !== undefined) {
      writePreflightTranscript(geminiDir);
    }
    return { status: 0, stdout: 'OK\n', stderr: '' };
  });

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      let caught: unknown;
      try {
        agent.provision(home, runner);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProvisionError);
      expect((caught as ProvisionError).message).toContain('SKILL.md');
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when agy plugin install exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  const runner = new FakeCommandRunner((command, args) => {
    if (command !== 'agy') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (isPluginInstall(args)) {
      return { status: 1, stdout: '', stderr: 'install blew up' };
    }
    const geminiDir = geminiDirArg(args);
    if (geminiDir !== undefined) {
      writePreflightTranscript(geminiDir);
    }
    return { status: 0, stdout: 'OK\n', stderr: '' };
  });

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      let caught: unknown;
      try {
        agent.provision(home, runner);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProvisionError);
      expect((caught as ProvisionError).message).toContain(
        'agy plugin install failed',
      );
      // Both calls ran (preflight succeeded, install failed).
      expect(runner.calls.length).toBe(2);
    });
  } finally {
    cleanup();
  }
});

test('settings.json secret-free config is a regular file (mode parity guard)', () => {
  // antigravity has no quorum-written secret file (agy auth lives in the
  // keyring / agy state, not a quorum-authored env file), so there is no
  // 0o600 file to assert. This guards that settings.json is a normal config
  // file; if a secret ever lands here, the mode contract becomes visible.
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      agent.provision(home, runner);
      const settingsPath = join(
        home.configDir,
        '.gemini',
        'antigravity-cli',
        'settings.json',
      );
      const st = statSync(settingsPath);
      expect(st.isFile()).toBe(true);
      // Sanity: the always-proceed posture exposes no API key on disk.
      expect(readFileSync(settingsPath, 'utf8')).not.toContain('sk-');
    });
  } finally {
    cleanup();
  }
});
