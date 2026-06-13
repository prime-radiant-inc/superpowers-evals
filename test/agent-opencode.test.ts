import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import { OpenCodeAgent } from '../src/agents/opencode.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// An opencode.yaml-shaped config (mirrors coding-agents/opencode.yaml). The
// fields the adapter reads are agent_config_env (OPENCODE_QUORUM_HOME) and
// required_env (SUPERPOWERS_ROOT).
const OPENCODE_CONFIG: AgentConfig = {
  name: 'opencode',
  binary: 'opencode',
  agent_config_env: 'OPENCODE_QUORUM_HOME',
  session_log_dir: '${OPENCODE_QUORUM_HOME}/.quorum/session-exports',
  session_log_glob: '[0-9]*-ses_*.json',
  normalizer: 'opencode',
  required_env: ['SUPERPOWERS_ROOT'],
  max_time: '10m',
  max_concurrency: 1,
};

const OPENCODE_MODEL = 'openai/gpt-5.5';

// Stage a SUPERPOWERS_ROOT with the exact files _seed_opencode_config requires:
// the .opencode plugin and the two probed SKILL.md files, plus extra skills so
// the copytree carries more than the gate-required pair.
function stageSuperpowers(root: string): void {
  const pluginDir = join(root, '.opencode', 'plugins');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'superpowers.js'),
    'export const plugin = () => {};\n',
  );
  for (const skill of ['using-superpowers', 'brainstorming', 'writing-plans']) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
}

// Set SUPERPOWERS_ROOT (and clear the node-bin override) around `body`,
// restoring prior values even on throw. noProcessEnv is OFF for test/agent-*.
function withEnv(superpowersRoot: string | undefined, body: () => void): void {
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  if (superpowersRoot === undefined) {
    delete process.env['SUPERPOWERS_ROOT'];
  } else {
    process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
  }
  try {
    body();
  } finally {
    if (prevRoot === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prevRoot;
    }
  }
}

// Happy-path responder: node --check succeeds, opencode --version answers, and
// `opencode run` replies "OK". Everything else defaults to success.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command === 'opencode' && args[0] === '--version') {
    return { status: 0, stdout: 'opencode 1.2.3\n', stderr: '' };
  }
  if (command === 'opencode' && args[0] === 'run') {
    return { status: 0, stdout: 'OK\n', stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

// The XDG isolation env the adapter must return and pass to the subprocess.
function expectedXdg(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(home, '.tmp'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
  };
}

test('provision stages Superpowers into the XDG-isolated home and pins the model', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      const env = agent.provision(home, runner);

      const opencodeHome = home.configDir;
      const configDir = join(opencodeHome, '.config', 'opencode');

      // The six XDG / export dirs the Python creates.
      expect(existsSync(configDir)).toBe(true);
      expect(
        existsSync(join(opencodeHome, '.local', 'share', 'opencode')),
      ).toBe(true);
      expect(
        existsSync(join(opencodeHome, '.local', 'state', 'opencode')),
      ).toBe(true);
      expect(existsSync(join(opencodeHome, '.cache'))).toBe(true);
      expect(existsSync(join(opencodeHome, '.tmp'))).toBe(true);
      expect(existsSync(join(opencodeHome, '.quorum', 'session-exports'))).toBe(
        true,
      );

      // opencode.json carries the schema + the pinned model.
      const opencodeJson = JSON.parse(
        readFileSync(join(configDir, 'opencode.json'), 'utf8'),
      );
      expect(opencodeJson).toEqual({
        $schema: 'https://opencode.ai/config.json',
        model: OPENCODE_MODEL,
      });

      // Staged plugin file + copied skills tree.
      const stagedPlugin = join(
        configDir,
        'superpowers',
        '.opencode',
        'plugins',
        'superpowers.js',
      );
      expect(existsSync(stagedPlugin)).toBe(true);
      expect(
        existsSync(
          join(
            configDir,
            'superpowers',
            'skills',
            'using-superpowers',
            'SKILL.md',
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(configDir, 'superpowers', 'skills', 'writing-plans', 'SKILL.md'),
        ),
      ).toBe(true);

      // The plugins/superpowers.js symlink points at the staged plugin.
      const pluginLink = join(configDir, 'plugins', 'superpowers.js');
      expect(lstatSync(pluginLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(pluginLink)).toBe(stagedPlugin);

      // Returned env: agent_config_env -> opencode_home, plus the XDG vars.
      expect(env).toEqual({
        OPENCODE_QUORUM_HOME: opencodeHome,
        ...expectedXdg(opencodeHome),
      });
    });
  } finally {
    cleanup();
  }
});

test('provision runs node --check then the model-pinned preflight', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      agent.provision(home, runner);

      // Calls: node --check <staged plugin>, opencode --version, opencode run.
      expect(runner.calls.length).toBe(3);

      const stagedPlugin = join(
        home.configDir,
        '.config',
        'opencode',
        'superpowers',
        '.opencode',
        'plugins',
        'superpowers.js',
      );
      const nodeCheck = runner.calls[0];
      expect(nodeCheck?.command).toBe('node');
      expect(nodeCheck?.args).toEqual(['--check', stagedPlugin]);

      const version = runner.calls[1];
      expect(version?.command).toBe('opencode');
      expect(version?.args).toEqual(['--version']);

      const run = runner.calls[2];
      expect(run?.command).toBe('opencode');
      expect(run?.args).toEqual([
        'run',
        '-m',
        OPENCODE_MODEL,
        '--dangerously-skip-permissions',
        'Reply with EXACTLY OK.',
      ]);
      // The preflight subprocess env carries the throwaway-home XDG isolation
      // (HOME points into a temp dir, NOT the per-run home).
      const runHome = run?.options?.env?.['HOME'];
      expect(typeof runHome).toBe('string');
      expect(runHome).not.toBe(home.configDir);
      expect(run?.options?.env?.['OPENCODE_CONFIG_DIR']).toBe(
        join(runHome ?? '', '.config', 'opencode'),
      );
      // cwd is the throwaway preflight cwd, not the per-run workdir.
      expect(run?.options?.cwd).not.toBe(home.workdir);
    });
  } finally {
    cleanup();
  }
});

test('provision retries the preflight and accepts a tolerant "OK." reply', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // First `run` returns a non-OK reply; the second returns "OK." (trailing
  // punctuation, accepted by the tolerant normalizer).
  let runAttempts = 0;
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'opencode' && args[0] === '--version') {
      return { status: 0, stdout: 'v1\n', stderr: '' };
    }
    if (command === 'opencode' && args[0] === 'run') {
      runAttempts += 1;
      if (runAttempts === 1) {
        return { status: 0, stdout: 'thinking...\n', stderr: '' };
      }
      return { status: 0, stdout: 'OK.\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      agent.provision(home, runner);
      // node --check + --version + two run attempts.
      expect(runAttempts).toBe(2);
      expect(runner.calls.length).toBe(4);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when the preflight never returns OK', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // `run` always exits non-zero -> the "exit" branch of the error.
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'opencode' && args[0] === 'run') {
      return { status: 1, stdout: '', stderr: 'provider unauthorized' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a non-OK reply persists across 3 tries', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // Exit 0 but a verbose (non-OK) reply on every attempt -> the "did not return
  // OK after 3 attempts" branch.
  let runAttempts = 0;
  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'opencode' && args[0] === 'run') {
      runAttempts += 1;
      return { status: 0, stdout: 'I cannot comply\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // The retry loop ran the full three attempts.
      expect(runAttempts).toBe(3);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when node --check fails', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  const runner = new FakeCommandRunner((command) => {
    if (command === 'node') {
      return { status: 1, stdout: '', stderr: 'SyntaxError: bad plugin' };
    }
    return { status: 0, stdout: 'OK\n', stderr: '' };
  });

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // Aborted at node --check, before any opencode invocation.
      expect(runner.calls.length).toBe(1);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(undefined, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // No subprocess attempted when a required input is missing.
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('provision throws ProvisionError when a required plugin file is missing', () => {
  const { home, cleanup } = makeTempHome();
  // Stage skills but NOT the .opencode/plugins/superpowers.js plugin.
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  for (const skill of ['using-superpowers', 'brainstorming']) {
    mkdirSync(join(spRoot, 'skills', skill), { recursive: true });
    writeFileSync(join(spRoot, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      expect(runner.calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

test('opencode.json is a regular file and leaks no provider key', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG);
      agent.provision(home, runner);
      const opencodeJson = join(
        home.configDir,
        '.config',
        'opencode',
        'opencode.json',
      );
      const st = statSync(opencodeJson);
      expect(st.isFile()).toBe(true);
      // Parity with codex: OpenCode writes NO quorum-authored mode-0600 secret
      // file; provider keys reach opencode only via subprocess env. opencode.json
      // is non-secret config and must not contain a key.
      const body = readFileSync(opencodeJson, 'utf8');
      expect(body).not.toContain('sk-');
      // statSync(path).mode & 0o777 is the mode-check idiom the spec asks for;
      // assert opencode.json is owner-readable/writable (non-secret default).
      expect(st.mode & 0o600).toBe(0o600);
    });
  } finally {
    cleanup();
  }
});
