import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ANTIGRAVITY_RATE_LIMIT_MARKER,
  ANTIGRAVITY_VISIBLE_LAUNCH_RECORD,
  ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV,
  AntigravityAgent,
  excludeAntigravityProjectMarker,
  prepareAntigravityLaunchCwd,
  seedAgyOauthCredentials,
  setAgyWhichForTesting,
  stageAntigravityPluginSource,
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
//
// Also pin AGY_OAUTH_HOME to an isolated dir seeded with both C1 OAuth creds, so
// provision tests exercise the seed WITHOUT reading the operator's real
// ~/.gemini (which would be a test-isolation violation and emit the "creds not
// seeded" warning -> non-pristine output). The dedicated C1 seed tests override
// AGY_OAUTH_HOME within their own bodies via withAgyOauthHome.
let agyOauthHomeFixture: string | undefined;
let prevAgyOauthHome: string | undefined;
beforeEach(() => {
  setAgyWhichForTesting(() => true);
  agyOauthHomeFixture = mkdtempSync(join(tmpdir(), 'agy-oauth-home-'));
  writeFileSync(
    join(agyOauthHomeFixture, 'oauth_creds.json'),
    '{"access_token":"test"}',
  );
  writeFileSync(
    join(agyOauthHomeFixture, 'google_accounts.json'),
    '{"active":"test@example.com"}',
  );
  prevAgyOauthHome = process.env['AGY_OAUTH_HOME'];
  process.env['AGY_OAUTH_HOME'] = agyOauthHomeFixture;
});
afterEach(() => {
  setAgyWhichForTesting(null);
  if (prevAgyOauthHome === undefined) {
    delete process.env['AGY_OAUTH_HOME'];
  } else {
    process.env['AGY_OAUTH_HOME'] = prevAgyOauthHome;
  }
  if (agyOauthHomeFixture !== undefined) {
    rmSync(agyOauthHomeFixture, { recursive: true, force: true });
    agyOauthHomeFixture = undefined;
  }
});

// An antigravity.yaml-shaped config (mirrors coding-agents/antigravity.yaml).
// The fields the adapter reads are home_config_subdir and required_env.
const ANTIGRAVITY_CONFIG: AgentConfig = {
  name: 'antigravity',
  binary: 'agy',
  home_config_subdir: '.',
  session_log_dir: '${QUORUM_AGENT_HOME}/.gemini/antigravity-cli/brain',
  session_log_glob: '**/transcript.jsonl',
  normalizer: 'antigravity',
  required_env: ['SUPERPOWERS_ROOT'],
  os_support: ['linux'],
  max_time: '10m',
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

// Create a minimal on-disk SUPERPOWERS_ROOT so provision's plugin staging (a
// real cpSync of the source tree) has something to copy. The fake agy still
// simulates the installed-plugin output separately via writeInstalledPlugin.
function makeSpRoot(home: { workdir: string }): string {
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(join(spRoot, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(
    join(spRoot, 'gemini-extension.json'),
    '{"name":"superpowers"}',
  );
  return spRoot;
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
  const spRoot = makeSpRoot(home);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(spRoot, () => {
      const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
      const env = agent.provision(home, runner);

      // Returned env is empty: agy finds its isolated state via the launcher's
      // --gemini_dir flag (= $QUORUM_AGENT_HOME/.gemini), not via an env var.
      expect(env).toEqual({});

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
  const spRoot = makeSpRoot(home);
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
      // The install SOURCE is a CLEAN staged copy (excludes evals/.git/
      // node_modules), NOT the raw SUPERPOWERS_ROOT — so agy's deep-copy never
      // recurses into nested eval output.
      const install = runner.calls[1];
      expect(install?.command).toBe('agy');
      const installArgs = install?.args ?? [];
      expect(installArgs[0]).toBe(
        `--gemini_dir=${join(home.configDir, '.gemini')}`,
      );
      expect(installArgs[1]).toBe('plugin');
      expect(installArgs[2]).toBe('install');
      expect(installArgs[3]).not.toBe(spRoot);
      expect(installArgs[3]).toContain('quorum-agy-plugin-');
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
  const spRoot = makeSpRoot(home);
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
      expect(env).toEqual({});
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = makeSpRoot(home);
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
  const spRoot = makeSpRoot(home);
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
  const spRoot = makeSpRoot(home);
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
  const spRoot = makeSpRoot(home);
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
  const spRoot = makeSpRoot(home);
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
  const spRoot = makeSpRoot(home);
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
  const spRoot = makeSpRoot(home);
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

// agy `plugin install <path>` deep-copies whatever path it is handed. When evals
// run from within a superpowers checkout, SUPERPOWERS_ROOT nests the entire
// evals/ submodule (results/, worktrees, node_modules) — not part of the plugin —
// which recursively explodes the copy. Stage a clean copy and install from that.
test('stageAntigravityPluginSource copies the plugin without the evals subtree', () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-root-'));
  try {
    mkdirSync(join(root, 'skills', 'using-superpowers'), { recursive: true });
    writeFileSync(join(root, 'skills', 'using-superpowers', 'SKILL.md'), '# s');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'gemini-extension.json'),
      '{"name":"superpowers"}',
    );
    // eval output + cruft that must NOT be copied into the plugin.
    mkdirSync(join(root, 'evals', 'results', 'old-run', 'deep'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'evals', 'results', 'old-run', 'deep', 'x'),
      'junk',
    );
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    // dev worktrees under .claude (each a full checkout with nested evals/results)
    mkdirSync(join(root, '.claude', 'worktrees', 'wt', 'evals', 'results'), {
      recursive: true,
    });
    writeFileSync(
      join(root, '.claude', 'worktrees', 'wt', 'evals', 'results', 'r.jsonl'),
      'junk',
    );
    // the plugin manifest dir must survive (different name than .claude).
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}');

    const staged = stageAntigravityPluginSource(root);
    try {
      expect(
        existsSync(join(staged, 'skills', 'using-superpowers', 'SKILL.md')),
      ).toBe(true);
      expect(existsSync(join(staged, 'hooks'))).toBe(true);
      expect(existsSync(join(staged, 'gemini-extension.json'))).toBe(true);
      expect(existsSync(join(staged, '.claude-plugin', 'plugin.json'))).toBe(
        true,
      );
      expect(existsSync(join(staged, 'evals'))).toBe(false);
      expect(existsSync(join(staged, '.claude'))).toBe(false);
      expect(existsSync(join(staged, '.git'))).toBe(false);
      expect(existsSync(join(staged, 'node_modules'))).toBe(false);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// C1 OAuth-creds seed (per-run-home-isolation spec §5C). agy reads its live
// OAuth token from $HOME/.gemini/oauth_creds.json at runtime; once the agent
// runs under the throwaway $HOME (home_config_subdir "."), provisioning must
// copy the operator's creds from the REAL ~/.gemini (via AGY_OAUTH_HOME) into
// configDir/.gemini (== $HOME/.gemini) or agy can't authenticate.

// Set AGY_OAUTH_HOME around `body`, restoring the prior value even on throw.
function withAgyOauthHome(
  oauthHome: string | undefined,
  body: () => void,
): void {
  const prev = process.env['AGY_OAUTH_HOME'];
  if (oauthHome === undefined) {
    delete process.env['AGY_OAUTH_HOME'];
  } else {
    process.env['AGY_OAUTH_HOME'] = oauthHome;
  }
  try {
    body();
  } finally {
    if (prev === undefined) {
      delete process.env['AGY_OAUTH_HOME'];
    } else {
      process.env['AGY_OAUTH_HOME'] = prev;
    }
  }
}

test('seedAgyOauthCredentials copies both creds into configDir/.gemini at 0600', () => {
  const { home, cleanup } = makeTempHome();
  const { home: srcHome, cleanup: srcCleanup } = makeTempHome();
  const oauthSource = srcHome.configDir;
  mkdirSync(oauthSource, { recursive: true });
  writeFileSync(
    join(oauthSource, 'oauth_creds.json'),
    '{"access_token":"tok"}',
  );
  writeFileSync(
    join(oauthSource, 'google_accounts.json'),
    '{"active":"me@example.com"}',
  );

  try {
    withAgyOauthHome(oauthSource, () => {
      const missing = seedAgyOauthCredentials(home.configDir);
      // Both creds present at source -> nothing flagged missing.
      expect(missing).toEqual([]);
      for (const name of ['oauth_creds.json', 'google_accounts.json']) {
        const dst = join(home.configDir, '.gemini', name);
        expect(existsSync(dst)).toBe(true);
        expect(readFileSync(dst, 'utf8')).toBe(
          readFileSync(join(oauthSource, name), 'utf8'),
        );
        expect(statSync(dst).mode & 0o777).toBe(0o600);
      }
    });
  } finally {
    cleanup();
    srcCleanup();
  }
});

test('seedAgyOauthCredentials tolerates a missing source (returns the absent names, no throw)', () => {
  const { home, cleanup } = makeTempHome();
  const { home: srcHome, cleanup: srcCleanup } = makeTempHome();
  // Source dir exists but only carries oauth_creds.json (google_accounts.json
  // absent) — agy may still authenticate via the per-login-user keyring, so a
  // missing cred is flagged, not fatal.
  const oauthSource = srcHome.configDir;
  mkdirSync(oauthSource, { recursive: true });
  writeFileSync(
    join(oauthSource, 'oauth_creds.json'),
    '{"access_token":"tok"}',
  );

  try {
    withAgyOauthHome(oauthSource, () => {
      let missing: string[] | undefined;
      expect(() => {
        missing = seedAgyOauthCredentials(home.configDir);
      }).not.toThrow();
      expect(missing).toEqual(['google_accounts.json']);
      // The present cred was still copied at 0600.
      const copied = join(home.configDir, '.gemini', 'oauth_creds.json');
      expect(existsSync(copied)).toBe(true);
      expect(statSync(copied).mode & 0o777).toBe(0o600);
      // The absent cred was not fabricated.
      expect(
        existsSync(join(home.configDir, '.gemini', 'google_accounts.json')),
      ).toBe(false);
    });
  } finally {
    cleanup();
    srcCleanup();
  }
});

test('seedAgyOauthCredentials tolerates an entirely-missing source dir', () => {
  const { home, cleanup } = makeTempHome();
  try {
    // Point AGY_OAUTH_HOME at a path that does not exist at all.
    withAgyOauthHome(join(home.workdir, 'no-such-gemini'), () => {
      let missing: string[] | undefined;
      expect(() => {
        missing = seedAgyOauthCredentials(home.configDir);
      }).not.toThrow();
      // Both creds flagged; nothing written.
      expect(missing).toEqual(['oauth_creds.json', 'google_accounts.json']);
      expect(existsSync(join(home.configDir, '.gemini'))).toBe(false);
    });
  } finally {
    cleanup();
  }
});

test('provision seeds the C1 OAuth creds into configDir/.gemini', () => {
  const { home, cleanup } = makeTempHome();
  const { home: srcHome, cleanup: srcCleanup } = makeTempHome();
  const spRoot = makeSpRoot(home);
  const oauthSource = srcHome.configDir;
  mkdirSync(oauthSource, { recursive: true });
  writeFileSync(
    join(oauthSource, 'oauth_creds.json'),
    '{"access_token":"tok"}',
  );
  writeFileSync(
    join(oauthSource, 'google_accounts.json'),
    '{"active":"me@example.com"}',
  );
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withRoot(spRoot, () => {
      withAgyOauthHome(oauthSource, () => {
        const agent = new AntigravityAgent(ANTIGRAVITY_CONFIG);
        agent.provision(home, runner);
        // The creds land under the SAME .gemini the plugin/settings seed used —
        // which, with home_config_subdir ".", is the throwaway $HOME/.gemini agy
        // reads at runtime.
        for (const name of ['oauth_creds.json', 'google_accounts.json']) {
          const dst = join(home.configDir, '.gemini', name);
          expect(existsSync(dst)).toBe(true);
          expect(statSync(dst).mode & 0o777).toBe(0o600);
        }
      });
    });
  } finally {
    cleanup();
    srcCleanup();
  }
});
