import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { GeminiAgent } from '../src/agents/gemini.ts';
import { ProvisionError } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// The gemini.yaml surface the adapter depends on (agent_config_env + required_env).
const CONFIG: AgentConfig = {
  name: 'gemini',
  binary: 'gemini',
  agent_config_env: 'GEMINI_CLI_HOME',
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

// A responder that succeeds and, on `extensions link`, lays down the manifest
// files the adapter asserts exist (the real CLI writes them on a successful
// link). `extensions list` returns a superpowers row.
function successResponder(configDir: string) {
  return (command: string, args: readonly string[]): CommandResult => {
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

        // Subprocess calls: link then list, with the trust/auth env.
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
        const runner = new FakeCommandRunner(() => ({
          status: 1,
          stdout: '',
          stderr: 'boom',
        }));
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
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
          if (command === 'gemini' && args[1] === 'list') {
            return { status: 0, stdout: 'superpowers\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        });
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
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
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
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
        const runner = new FakeCommandRunner();
        const agent = new GeminiAgent(CONFIG);
        expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
        // No subprocess should run if the key is missing.
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
