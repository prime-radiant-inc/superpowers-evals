import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ANTIGRAVITY_RATE_LIMIT_MARKER,
  ANTIGRAVITY_VISIBLE_LAUNCH_RECORD,
  ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV,
  AntigravityAgent,
  excludeAntigravityProjectMarker,
  prepareAntigravityLaunchCwd,
  setAgyWhichForTesting,
  writeAntigravitySettings,
} from '../src/agents/antigravity.ts';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The provision() which-guard probes PATH for `agy`. CI has no agy binary, so
// stub the probe to "present" for the provisioning tests; the dedicated
// which-guard test overrides it to "absent".
beforeEach(() => {
  setAgyWhichForTesting(() => true);
});
afterEach(() => {
  setAgyWhichForTesting(null);
});

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

// B2-antigravity-which-guard-dropped: provision must fail fast with the precise
// "agy not found on PATH" diagnostic when the binary is absent, before any work.
test('provision throws ProvisionError when agy is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(spRoot, () => {
      setAgyWhichForTesting(() => false); // agy absent
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      let caught: unknown;
      try {
        agent.provision(home, runner);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProvisionError);
      expect((caught as ProvisionError).message).toContain(
        'agy not found on PATH',
      );
      // The guard precedes all subprocess work and the configDir mkdir.
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-antigravity-exclude-project-marker-missing: when launch_cwd is inside a git
// work tree, append `.antigravitycli/` to info/exclude idempotently.
test('excludeAntigravityProjectMarker adds .antigravitycli/ to a git work tree info/exclude', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const repo = join(home.workdir, 'repo');
    mkdirSync(repo, { recursive: true });
    // A real git repo so the rev-parse checks pass via the default runner.
    Bun.spawnSync(['git', 'init', '-q', repo]);
    excludeAntigravityProjectMarker(repo);
    const excludePath = join(repo, '.git', 'info', 'exclude');
    const lines = readFileSync(excludePath, 'utf8').split('\n');
    expect(lines).toContain('.antigravitycli/');
    // Idempotent: a second call must not duplicate the entry.
    excludeAntigravityProjectMarker(repo);
    const occurrences = readFileSync(excludePath, 'utf8')
      .split('\n')
      .filter((l) => l === '.antigravitycli/').length;
    expect(occurrences).toBe(1);
  } finally {
    cleanup();
  }
});

// L6: the git-path probe's exit status must not be discarded. Python runs it
// with check=True (raises on non-zero); a silently-ignored failure makes
// gitPath "" and collapses excludePath to launchCwd, so writeFileSync targets a
// directory (EISDIR). Inject a fake probe whose second call fails.
test('excludeAntigravityProjectMarker throws when the git-path probe fails', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const repo = join(home.workdir, 'repo');
    mkdirSync(repo, { recursive: true });
    const fakeGitProbe = (_cwd: string, args: readonly string[]) => {
      if (args.includes('--is-inside-work-tree')) {
        return { status: 0, stdout: 'true' };
      }
      // The --git-path info/exclude probe fails (e.g. corrupt repo state).
      return { status: 128, stdout: '' };
    };
    expect(() => excludeAntigravityProjectMarker(repo, fakeGitProbe)).toThrow();
    // Must not have silently written into the repo directory itself.
    expect(existsSync(join(repo, '.antigravitycli/'))).toBe(false);
  } finally {
    cleanup();
  }
});

test('excludeAntigravityProjectMarker is a noop outside a git work tree', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const plain = join(home.workdir, 'plain');
    mkdirSync(plain, { recursive: true });
    // Must not throw and must not create a .git tree.
    excludeAntigravityProjectMarker(plain);
    expect(existsSync(join(plain, '.git'))).toBe(false);
  } finally {
    cleanup();
  }
});

// B2-antigravity-prepare-launch-cwd-missing: a launch cwd with a hidden path
// component (e.g. under .codex/) gets a visible temp symlink alias.
test('prepareAntigravityLaunchCwd returns a visible symlink alias for a hidden-component cwd', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const hidden = join(home.workdir, '.codex', 'project');
    mkdirSync(hidden, { recursive: true });
    const runDir = join(home.workdir, 'run-001');
    mkdirSync(runDir, { recursive: true });
    const visibleRoot = join(home.workdir, 'visible-ws');

    const prev = process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV];
    process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV] = visibleRoot;
    try {
      const alias = prepareAntigravityLaunchCwd(hidden, runDir);
      expect(alias).not.toBe(hidden);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      // The symlink target is the realpath'd launch cwd (Python .resolve()).
      expect(readlinkSync(alias)).toBe(realpathSync(hidden));
      // No hidden component in the alias path.
      expect(
        alias.split('/').some((p) => p.startsWith('.') && p.length > 1),
      ).toBe(false);
      // A record of the substitution lands under run_dir.
      const record = JSON.parse(
        readFileSync(join(runDir, ANTIGRAVITY_VISIBLE_LAUNCH_RECORD), 'utf8'),
      );
      expect(record.launch_cwd).toBe(hidden);
      expect(record.visible_launch_cwd).toBe(alias);
      // Idempotent: a second call reuses the same alias.
      expect(prepareAntigravityLaunchCwd(hidden, runDir)).toBe(alias);
    } finally {
      if (prev === undefined) {
        delete process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV];
      } else {
        process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV] = prev;
      }
    }
  } finally {
    cleanup();
  }
});

test('prepareAntigravityLaunchCwd returns the cwd unchanged when it has no hidden component', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const visible = join(home.workdir, 'visible', 'project');
    mkdirSync(visible, { recursive: true });
    const runDir = join(home.workdir, 'run-002');
    mkdirSync(runDir, { recursive: true });
    expect(prepareAntigravityLaunchCwd(visible, runDir)).toBe(visible);
    expect(existsSync(join(runDir, ANTIGRAVITY_VISIBLE_LAUNCH_RECORD))).toBe(
      false,
    );
  } finally {
    cleanup();
  }
});

test('prepareAntigravityLaunchCwd rejects a hidden visible-workspace root', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const hidden = join(home.workdir, '.codex', 'project');
    mkdirSync(hidden, { recursive: true });
    const runDir = join(home.workdir, 'run-003');
    mkdirSync(runDir, { recursive: true });
    // A visible root that itself has a hidden component must be rejected.
    const badRoot = join(home.workdir, '.hidden-root');

    const prev = process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV];
    process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV] = badRoot;
    try {
      expect(() => prepareAntigravityLaunchCwd(hidden, runDir)).toThrow(
        ProvisionError,
      );
    } finally {
      if (prev === undefined) {
        delete process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV];
      } else {
        process.env[ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV] = prev;
      }
    }
  } finally {
    cleanup();
  }
});

// B2-x-antigravity-settings-launch-cwd-not-trusted: the runner re-writes
// settings with the RESOLVED launch cwd so trustedWorkspaces includes it.
test('writeAntigravitySettings re-trust adds the launch cwd to an existing settings.json', () => {
  const { home, cleanup } = makeTempHome();
  try {
    const configDir = home.configDir;
    const workdir = join(home.workdir, 'wd');
    mkdirSync(workdir, { recursive: true });
    const launchCwd = join(home.workdir, 'launch-cwd');
    mkdirSync(launchCwd, { recursive: true });

    // First write (provision-time) trusts the workdir.
    writeAntigravitySettings(configDir, workdir);
    // Second write (runner-time) with the resolved launch cwd.
    writeAntigravitySettings(configDir, launchCwd);

    const settingsPath = join(
      configDir,
      '.gemini',
      'antigravity-cli',
      'settings.json',
    );
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.trustedWorkspaces).toContain(workdir);
    expect(settings.trustedWorkspaces).toContain(launchCwd);
    expect(settings.trustedWorkspaces).toContain(resolve(launchCwd));
  } finally {
    cleanup();
  }
});
