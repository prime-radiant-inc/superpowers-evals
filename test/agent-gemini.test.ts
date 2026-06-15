import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { GeminiAgent } from '../src/agents/gemini.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The gemini.yaml surface the adapter depends on (agent_config_env + required_env).
// home_config_subdir "." collapses the config dir into the throwaway $HOME; the
// adapter writes under home.configDir regardless, so it is carried here only to
// mirror the real YAML.
const CONFIG: AgentConfig = {
  name: 'gemini',
  binary: 'gemini',
  agent_config_env: 'GEMINI_CLI_HOME',
  home_config_subdir: '.',
  session_log_dir: '${GEMINI_CLI_HOME}/.gemini/tmp',
  session_log_glob: '**/chats/**/*.json*',
  normalizer: 'gemini',
  required_env: ['GEMINI_API_KEY', 'SUPERPOWERS_ROOT'],
};

const API_KEY = 'gem-test-key';

// Files _require_gemini_superpowers_root asserts under SUPERPOWERS_ROOT.
const REQUIRED_SUPERPOWERS_FILES = [
  'gemini-extension.json',
  'GEMINI.md',
  'skills/using-superpowers/SKILL.md',
  'skills/using-superpowers/references/gemini-tools.md',
];

// Manifest files a successful `gemini extensions link` writes into GEMINI_CLI_HOME.
const EXTENSION_MANIFESTS = [
  join(
    '.gemini',
    'extensions',
    'superpowers',
    '.gemini-extension-install.json',
  ),
  join('.gemini', 'extensions', 'extension-enablement.json'),
  join('.gemini', 'extension_integrity.json'),
];

// Build a fake SUPERPOWERS_ROOT carrying the required extension files so
// _require_gemini_superpowers_root passes.
function seedSuperpowersRoot(root: string): void {
  for (const rel of REQUIRED_SUPERPOWERS_FILES) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'fixture\n');
  }
}

// Build an isolated directory to use as PATH. When `withGemini` is true it lays
// down an executable `gemini` shim so Bun.which('gemini') resolves there; when
// false the dir is empty so the binary is genuinely absent. Returns the dir plus
// a cleanup(). Used by the PATH-probe tests, which exercise the real Bun.which
// lookup rather than faking it through the runner.
function makePathDir(withGemini: boolean): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-gemini-path-'));
  if (withGemini) {
    const shim = join(dir, 'gemini');
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);
  }
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The adapter resolves `gemini` via Bun.which against the PATH snapshot. To make
// every "binary present" test hermetic (independent of whether a real gemini is
// installed on the host), prepend a dir holding a `gemini` shim to PATH for the
// whole file. The genuinely-absent test overrides PATH to an empty dir.
let geminiShimDir: { dir: string; cleanup: () => void };
let savedPath: string | undefined;
beforeAll(() => {
  geminiShimDir = makePathDir(true);
  savedPath = process.env['PATH'];
  process.env['PATH'] = `${geminiShimDir.dir}:${savedPath ?? ''}`;
});
afterAll(() => {
  if (savedPath === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = savedPath;
  }
  geminiShimDir.cleanup();
});

// The adapter probes `command -v gemini` to confirm the binary is on PATH
// (Python: shutil.which("gemini")). A responder must resolve it for any later
// step to run. Returns a CommandResult when the call is the probe, else null.
function geminiPathProbe(
  command: string,
  args: readonly string[],
): CommandResult | null {
  if (command === 'command' && args[0] === '-v' && args[1] === 'gemini') {
    return { status: 0, stdout: '/usr/local/bin/gemini\n', stderr: '' };
  }
  return null;
}

// A responder that only resolves the PATH probe; every other call returns the
// default success. Used by the "before any subprocess" guards: the PATH probe
// must succeed so the test exercises the auth/key guard rather than the PATH
// check, while still proving no `gemini extensions` subprocess ran.
function probeOnlyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  return (
    geminiPathProbe(command, args) ?? { status: 0, stdout: '', stderr: '' }
  );
}

// A responder that succeeds and, on `extensions link`, lays down the manifest
// files the adapter asserts exist (the real CLI writes them on a successful
// link). `extensions list` returns a superpowers row.
function successResponder(configDir: string) {
  return (command: string, args: readonly string[]): CommandResult => {
    const probe = geminiPathProbe(command, args);
    if (probe) {
      return probe;
    }
    if (
      command === 'gemini' &&
      args[0] === 'extensions' &&
      args[1] === 'link'
    ) {
      for (const rel of EXTENSION_MANIFESTS) {
        const path = join(configDir, rel);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '{}\n');
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'gemini' &&
      args[0] === 'extensions' &&
      args[1] === 'list'
    ) {
      return {
        status: 0,
        stdout: 'superpowers (link) -> /sp/root\n',
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

// Set (or, for an undefined value, delete) the env vars the adapter reads via
// env.ts -> process.env, run `body`, then restore every mutated var even on
// throw (mirrors runner-e2e.test.ts). env.ts has no setter, so the test must
// touch process.env directly; this helper is the only place it does, and
// noProcessEnv is suppressed here just as biome.json exempts the other
// env-mutating test files.
function withEnv(
  vars: Record<string, string | undefined>,
  body: () => void,
): void {
  const keys = Object.keys(vars);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const key of keys) {
      const original = prev[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

test('provision seeds config dir, settings, env file, manifests, and returns env', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        const runner = new FakeCommandRunner(successResponder(home.configDir));
        const agent = new GeminiAgent(CONFIG);
        const env = agent.provision(home, runner);

        // configDir + expected subdirs exist.
        expect(existsSync(home.configDir)).toBe(true);
        expect(existsSync(join(home.configDir, '.gemini'))).toBe(true);

        // .gemini/settings.json: parsed deep-equal with auth selectedType set.
        const settingsPath = join(home.configDir, '.gemini', 'settings.json');
        expect(existsSync(settingsPath)).toBe(true);
        const settings: unknown = JSON.parse(
          readFileSync(settingsPath, 'utf8'),
        );
        expect(settings).toEqual({
          security: { auth: { selectedType: 'gemini-api-key' } },
        });

        // .gemini-env: secret content shell-quoted, mode 0600.
        const envFile = join(home.configDir, '.gemini-env');
        expect(existsSync(envFile)).toBe(true);
        expect(readFileSync(envFile, 'utf8')).toBe(
          `GEMINI_API_KEY='${API_KEY}'\n`,
        );
        expect(statSync(envFile).mode & 0o777).toBe(0o600);

        // Manifest files the link wrote are present.
        for (const rel of EXTENSION_MANIFESTS) {
          expect(existsSync(join(home.configDir, rel))).toBe(true);
        }

        // Returned env: agent_config_env + trust/auth vars.
        expect(env).toEqual({
          GEMINI_CLI_HOME: home.configDir,
          GEMINI_CLI_TRUST_WORKSPACE: 'true',
          GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key',
        });

        // Subprocess calls: link then list with trust env. The PATH probe goes
        // through Bun.which now, not the runner, so it records no call.
        expect(runner.calls.length).toBe(2);
        const linkCall = runner.calls[0];
        const listCall = runner.calls[1];
        if (linkCall === undefined || listCall === undefined) {
          throw new Error('expected two recorded calls');
        }
        expect(linkCall.command).toBe('gemini');
        expect(linkCall.args).toEqual([
          'extensions',
          'link',
          superpowersRoot,
          '--consent',
        ]);
        expect(linkCall.options?.cwd).toBe(home.configDir);
        expect(linkCall.options?.env?.['GEMINI_CLI_HOME']).toBe(home.configDir);
        expect(linkCall.options?.env?.['GEMINI_CLI_TRUST_WORKSPACE']).toBe(
          'true',
        );
        expect(linkCall.options?.env?.['GEMINI_DEFAULT_AUTH_TYPE']).toBe(
          'gemini-api-key',
        );
        expect(listCall.command).toBe('gemini');
        expect(listCall.args).toEqual(['extensions', 'list']);
        expect(listCall.options?.cwd).toBe(home.configDir);
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision accepts a decorated superpowers row printed to stderr', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        // Newer gemini prints the extensions list to stderr and decorates the
        // row with a checkmark + version (Python: merge stdout+stderr, regex
        // tolerates a leading non-word glyph). stdout is empty.
        const runner = new FakeCommandRunner((command, args) => {
          const probe = geminiPathProbe(command, args);
          if (probe) {
            return probe;
          }
          if (
            command === 'gemini' &&
            args[0] === 'extensions' &&
            args[1] === 'link'
          ) {
            for (const rel of EXTENSION_MANIFESTS) {
              const path = join(home.configDir, rel);
              mkdirSync(join(path, '..'), { recursive: true });
              writeFileSync(path, '{}\n');
            }
            return { status: 0, stdout: '', stderr: '' };
          }
          if (
            command === 'gemini' &&
            args[0] === 'extensions' &&
            args[1] === 'list'
          ) {
            return {
              status: 0,
              stdout: '',
              stderr: '✓ superpowers (5.1.0)\n',
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        });
        // Must not throw despite stdout being empty.
        new GeminiAgent(CONFIG).provision(home, runner);
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision merges into an existing settings.json without clobbering', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        // Pre-seed settings.json with unrelated keys the adapter must preserve.
        mkdirSync(join(home.configDir, '.gemini'), { recursive: true });
        writeFileSync(
          join(home.configDir, '.gemini', 'settings.json'),
          JSON.stringify({ theme: 'dark', security: { other: true } }),
        );

        const runner = new FakeCommandRunner(successResponder(home.configDir));
        new GeminiAgent(CONFIG).provision(home, runner);

        const settings: unknown = JSON.parse(
          readFileSync(
            join(home.configDir, '.gemini', 'settings.json'),
            'utf8',
          ),
        );
        expect(settings).toEqual({
          theme: 'dark',
          security: { other: true, auth: { selectedType: 'gemini-api-key' } },
        });
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision throws ProvisionError when extensions link exits non-zero', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        // PATH probe resolves; the `extensions link` itself exits non-zero.
        const runner = new FakeCommandRunner((command, args) => {
          const probe = geminiPathProbe(command, args);
          if (probe) {
            return probe;
          }
          return { status: 1, stdout: '', stderr: 'boom' };
        });
        const agent = new GeminiAgent(CONFIG);
        let message = '';
        try {
          agent.provision(home, runner);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('gemini extensions link failed');
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision redacts GEMINI_API_KEY from the link-failure stderr excerpt', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        // The CLI echoes the API key into its stderr on failure; the excerpt
        // baked into the error must not leak it (Python: _gemini_stderr_excerpt).
        const runner = new FakeCommandRunner((command, args) => {
          const probe = geminiPathProbe(command, args);
          if (probe) {
            return probe;
          }
          if (command === 'gemini' && args[1] === 'link') {
            return {
              status: 1,
              stdout: '',
              stderr: `auth failed using key ${API_KEY} aborting`,
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        });
        const agent = new GeminiAgent(CONFIG);
        let message = '';
        try {
          agent.provision(home, runner);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('gemini extensions link failed');
        expect(message).not.toContain(API_KEY);
        expect(message).toContain('[redacted]');
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision redacts GEMINI_API_KEY from the list-failure stderr excerpt', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        // link succeeds (manifests written) but `list` fails with the key in
        // stderr; the list-failure excerpt must redact it too.
        const runner = new FakeCommandRunner((command, args) => {
          const probe = geminiPathProbe(command, args);
          if (probe) {
            return probe;
          }
          if (command === 'gemini' && args[1] === 'link') {
            for (const rel of EXTENSION_MANIFESTS) {
              const path = join(home.configDir, rel);
              mkdirSync(join(path, '..'), { recursive: true });
              writeFileSync(path, '{}\n');
            }
            return { status: 0, stdout: '', stderr: '' };
          }
          if (command === 'gemini' && args[1] === 'list') {
            return {
              status: 1,
              stdout: '',
              stderr: `listing failed using key ${API_KEY}`,
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        });
        const agent = new GeminiAgent(CONFIG);
        let message = '';
        try {
          agent.provision(home, runner);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('gemini extensions list failed');
        expect(message).not.toContain(API_KEY);
        expect(message).toContain('[redacted]');
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision throws ProvisionError when a manifest file is missing', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        // Both subprocesses succeed and `list` shows superpowers, but `link`
        // never writes the manifests -> the post-link assertion must fire.
        const runner = new FakeCommandRunner((command, args) => {
          const probe = geminiPathProbe(command, args);
          if (probe) {
            return probe;
          }
          if (command === 'gemini' && args[1] === 'list') {
            return { status: 0, stdout: 'superpowers\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        });
        const agent = new GeminiAgent(CONFIG);
        let message = '';
        try {
          agent.provision(home, runner);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('expected metadata files are missing');
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision throws ProvisionError when extensions list omits superpowers', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        const runner = new FakeCommandRunner((command, args) => {
          const probe = geminiPathProbe(command, args);
          if (probe) {
            return probe;
          }
          if (
            command === 'gemini' &&
            args[0] === 'extensions' &&
            args[1] === 'link'
          ) {
            for (const rel of EXTENSION_MANIFESTS) {
              const path = join(home.configDir, rel);
              mkdirSync(join(path, '..'), { recursive: true });
              writeFileSync(path, '{}\n');
            }
            return { status: 0, stdout: '', stderr: '' };
          }
          // list succeeds but shows an unrelated extension.
          return { status: 0, stdout: 'some-other-ext\n', stderr: '' };
        });
        const agent = new GeminiAgent(CONFIG);
        let message = '';
        try {
          agent.provision(home, runner);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain('did not show Superpowers extension');
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision in oauth mode copies credentials and omits the api key', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const { home: oauthHome, cleanup: oauthCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  // Seed the OAuth credential files the adapter copies (Python:
  // _copy_gemini_oauth_credentials reads from GEMINI_OAUTH_HOME).
  const oauthSource = oauthHome.configDir;
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
    withEnv(
      {
        SUPERPOWERS_ROOT: superpowersRoot,
        GEMINI_AUTH_TYPE: 'oauth-personal',
        GEMINI_OAUTH_HOME: oauthSource,
        GEMINI_API_KEY: undefined,
      },
      () => {
        const runner = new FakeCommandRunner(successResponder(home.configDir));
        const env = new GeminiAgent(CONFIG).provision(home, runner);

        // settings.json selects oauth-personal.
        const settings: unknown = JSON.parse(
          readFileSync(
            join(home.configDir, '.gemini', 'settings.json'),
            'utf8',
          ),
        );
        expect(settings).toEqual({
          security: { auth: { selectedType: 'oauth-personal' } },
        });

        // Credentials copied at 0600 into the run's .gemini dir.
        for (const name of ['oauth_creds.json', 'google_accounts.json']) {
          const dst = join(home.configDir, '.gemini', name);
          expect(existsSync(dst)).toBe(true);
          expect(readFileSync(dst, 'utf8')).toBe(
            readFileSync(join(oauthSource, name), 'utf8'),
          );
          expect(statSync(dst).mode & 0o777).toBe(0o600);
        }

        // .gemini-env is empty in oauth mode (no GEMINI_API_KEY line), 0600.
        const envFile = join(home.configDir, '.gemini-env');
        expect(readFileSync(envFile, 'utf8')).toBe('');
        expect(statSync(envFile).mode & 0o777).toBe(0o600);

        // Returned env advertises the oauth auth type.
        expect(env['GEMINI_DEFAULT_AUTH_TYPE']).toBe('oauth-personal');
      },
    );
  } finally {
    cleanup();
    spCleanup();
    oauthCleanup();
  }
});

test('provision throws on a bogus GEMINI_AUTH_TYPE before any subprocess', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: superpowersRoot,
        GEMINI_API_KEY: API_KEY,
        GEMINI_AUTH_TYPE: 'totally-bogus',
      },
      () => {
        const runner = new FakeCommandRunner(probeOnlyResponder);
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        // The auth-type guard fires after the Bun.which PATH probe but before
        // any `gemini extensions` subprocess, so the runner records nothing.
        expect(runner.calls.length).toBe(0);
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision in oauth mode throws when a credential file is missing', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const { home: oauthHome, cleanup: oauthCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  // Only seed one of the two required credential files.
  const oauthSource = oauthHome.configDir;
  mkdirSync(oauthSource, { recursive: true });
  writeFileSync(
    join(oauthSource, 'oauth_creds.json'),
    '{"access_token":"tok"}',
  );

  try {
    withEnv(
      {
        SUPERPOWERS_ROOT: superpowersRoot,
        GEMINI_AUTH_TYPE: 'oauth-personal',
        GEMINI_OAUTH_HOME: oauthSource,
        GEMINI_API_KEY: undefined,
      },
      () => {
        const runner = new FakeCommandRunner(successResponder(home.configDir));
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      },
    );
  } finally {
    cleanup();
    spCleanup();
    oauthCleanup();
  }
});

test('provision throws ProvisionError when GEMINI_API_KEY is unset', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);

  try {
    // Explicitly clear GEMINI_API_KEY (undefined) so the adapter's empty-key
    // guard fires regardless of the ambient environment.
    withEnv(
      { SUPERPOWERS_ROOT: superpowersRoot, GEMINI_API_KEY: undefined },
      () => {
        const runner = new FakeCommandRunner(probeOnlyResponder);
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        // The empty-key guard fires after the Bun.which PATH probe but before
        // any `gemini extensions` subprocess, so the runner records nothing.
        expect(runner.calls.length).toBe(0);
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is missing files', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  // Create the dir but do NOT seed the required extension files.
  mkdirSync(superpowersRoot, { recursive: true });

  try {
    withEnv(
      { GEMINI_API_KEY: API_KEY, SUPERPOWERS_ROOT: superpowersRoot },
      () => {
        const runner = new FakeCommandRunner();
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        expect(runner.calls.length).toBe(0);
      },
    );
  } finally {
    cleanup();
    spCleanup();
  }
});

// H3: the PATH probe must use Bun.which, not `command -v` through the runner —
// `command` is a shell builtin and the runner's spawnSync has no shell, so on
// Linux the probe ENOENTs and falsely reports "not found". This test points PATH
// at an empty dir (gemini genuinely absent) and does NOT fake any probe; the
// adapter must fail fast with the precise message before any extensions call.
test('provision throws when gemini is genuinely absent from PATH (Bun.which)', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);
  const path = makePathDir(false);

  try {
    withEnv(
      {
        GEMINI_API_KEY: API_KEY,
        SUPERPOWERS_ROOT: superpowersRoot,
        PATH: path.dir,
      },
      () => {
        // Responder would happily succeed on every call; the point is that the
        // PATH check must fire from Bun.which, so no extensions subprocess runs.
        const runner = new FakeCommandRunner(successResponder(home.configDir));
        const agent = new GeminiAgent(CONFIG);
        let message = '';
        expect(() => {
          try {
            agent.provision(home, runner);
          } catch (err) {
            message = err instanceof Error ? err.message : String(err);
            throw err;
          }
        }).toThrow(ProvisionError);
        expect(message).toContain('gemini not found on PATH');
        // The Bun.which probe does not touch the runner; the SUPERPOWERS_ROOT
        // check passed, so the only thing that could have run is extensions —
        // and it must not have.
        expect(runner.calls.length).toBe(0);
      },
    );
  } finally {
    cleanup();
    spCleanup();
    path.cleanup();
  }
});

// H3 positive: a real `gemini` executable on PATH resolves via Bun.which and
// provisioning proceeds to the extensions link/list calls (no probe faking).
test('provision resolves a real gemini on PATH via Bun.which', () => {
  const { home, cleanup } = makeTempHome();
  const { home: spHome, cleanup: spCleanup } = makeTempHome();
  const superpowersRoot = spHome.configDir;
  mkdirSync(superpowersRoot, { recursive: true });
  seedSuperpowersRoot(superpowersRoot);
  const path = makePathDir(true);

  try {
    withEnv(
      {
        GEMINI_API_KEY: API_KEY,
        SUPERPOWERS_ROOT: superpowersRoot,
        PATH: path.dir,
      },
      () => {
        const runner = new FakeCommandRunner(successResponder(home.configDir));
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).not.toThrow();
        // Bun.which handled the probe; the runner only saw link + list.
        expect(runner.calls.map((c) => c.command)).toEqual([
          'gemini',
          'gemini',
        ]);
        expect(runner.calls[0]?.args).toEqual([
          'extensions',
          'link',
          superpowersRoot,
          '--consent',
        ]);
        expect(runner.calls[1]?.args).toEqual(['extensions', 'list']);
      },
    );
  } finally {
    cleanup();
    spCleanup();
    path.cleanup();
  }
});

// L2: SUPERPOWERS_ROOT is tilde-expanded before existsSync / `gemini extensions
// link` (Python: Path(superpowers_root).expanduser()). A `~`-prefixed value must
// resolve under HOME for the required-files check to pass and the link arg to
// carry the absolute path.
test('provision expands a ~-prefixed SUPERPOWERS_ROOT under HOME', () => {
  const { home, cleanup } = makeTempHome();
  // Seed the required extension files under an absolute subdir of HOME, then
  // hand provision() the ~-relative form of that same dir.
  const home0 = homedir();
  const rel = `quorum-gemini-tilde-${process.pid}-${Date.now()}`;
  const absRoot = join(home0, rel);
  mkdirSync(absRoot, { recursive: true });
  seedSuperpowersRoot(absRoot);
  const path = makePathDir(true);

  try {
    withEnv(
      {
        GEMINI_API_KEY: API_KEY,
        SUPERPOWERS_ROOT: `~/${rel}`,
        PATH: path.dir,
      },
      () => {
        const runner = new FakeCommandRunner(successResponder(home.configDir));
        const agent = new GeminiAgent(CONFIG);
        // Must not throw: the required-files check sees the expanded path.
        expect(() => agent.provision(home, runner)).not.toThrow();
        // The `extensions link` arg is the expanded absolute path, not `~/...`.
        const linkCall = runner.calls.find((c) => c.args[1] === 'link');
        expect(linkCall?.args[2]).toBe(absRoot);
      },
    );
  } finally {
    cleanup();
    rmSync(absRoot, { recursive: true, force: true });
    path.cleanup();
  }
});
