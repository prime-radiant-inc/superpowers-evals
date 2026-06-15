import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from '../src/agents/command-runner.ts';
import { ProvisionError } from '../src/agents/index.ts';
import { OpenCodeAgent } from '../src/agents/opencode.ts';
import {
  OpenCodeTimeoutError,
  type SpawnFn,
  type SpawnResult,
} from '../src/agents/opencode-capture.ts';
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

// Happy-path CommandRunner responder. The runner now drives only the PATH
// probes (`command -v opencode`, `command -v node`) and the staged-plugin
// `node --check`; opencode invocations go through the injected SpawnFn. A
// `command -v` probe must answer with a non-empty resolved path (parity with
// shutil.which returning a path), and node --check exits 0.
function happyResponder(
  command: string,
  args: readonly string[],
): CommandResult {
  if (command === 'command' && args[0] === '-v') {
    return { status: 0, stdout: `/usr/local/bin/${args[1]}\n`, stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

// One recorded SpawnFn invocation, for preflight assertions.
interface RecordedSpawn {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

// Happy-path SpawnFn: opencode --version answers, `opencode run` replies "OK".
function makeHappySpawn(): { spawn: SpawnFn; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const spawn: SpawnFn = (opts) => {
    calls.push({ args: opts.args, cwd: opts.cwd, env: opts.env });
    if (opts.args[1] === '--version') {
      return { stdout: 'opencode 1.2.3\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      return { stdout: 'OK\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { spawn, calls };
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
  const { spawn } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
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
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner);

      const stagedPlugin = join(
        home.configDir,
        '.config',
        'opencode',
        'superpowers',
        '.opencode',
        'plugins',
        'superpowers.js',
      );

      // The CommandRunner drives the PATH probes + node --check (NOT opencode).
      const nodeCheck = runner.calls.find((c) => c.command === 'node');
      expect(nodeCheck?.args).toEqual(['--check', stagedPlugin]);
      expect(runner.calls.some((c) => c.command === 'opencode')).toBe(false);

      // opencode --version then opencode run are SpawnFn calls (file-stdout +
      // allowlisted env path).
      const version = calls.find((c) => c.args[1] === '--version');
      expect(version?.args).toEqual(['opencode', '--version']);

      const run = calls.find((c) => c.args[1] === 'run');
      expect(run?.args).toEqual([
        'opencode',
        'run',
        '-m',
        OPENCODE_MODEL,
        '--dangerously-skip-permissions',
        'Reply with EXACTLY OK.',
      ]);
      // The preflight subprocess env carries the throwaway-home XDG isolation
      // (HOME points into a temp dir, NOT the per-run home).
      const runHome = run?.env['HOME'];
      expect(typeof runHome).toBe('string');
      expect(runHome).not.toBe(home.configDir);
      expect(run?.env['OPENCODE_CONFIG_DIR']).toBe(
        join(runHome ?? '', '.config', 'opencode'),
      );
      // cwd is the throwaway preflight cwd, not the per-run workdir.
      expect(run?.cwd).not.toBe(home.workdir);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-preflight-env-not-allowlisted: the preflight subprocess env must
// be the strict allowlist (no leaked host vars), not the full host env.
test('preflight env is the strict allowlist, not the full host env', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();

  const prevLeak = process.env['OPENCODE_CONFIG_DIR'];
  const prevProxy = process.env['HTTP_PROXY'];
  process.env['OPENCODE_CONFIG_DIR'] = '/ambient/opencode';
  process.env['HTTP_PROXY'] = 'http://leak';
  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner);
      const run = calls.find((c) => c.args[1] === 'run');
      // Non-allowlisted ambient vars must NOT leak into the preflight.
      expect('HTTP_PROXY' in (run?.env ?? {})).toBe(false);
      expect('SUPERPOWERS_ROOT' in (run?.env ?? {})).toBe(false);
      // The ambient OPENCODE_CONFIG_DIR is overridden by the throwaway home's.
      const runHome = run?.env['HOME'];
      expect(run?.env['OPENCODE_CONFIG_DIR']).toBe(
        join(runHome ?? '', '.config', 'opencode'),
      );
    });
  } finally {
    if (prevLeak === undefined) delete process.env['OPENCODE_CONFIG_DIR'];
    else process.env['OPENCODE_CONFIG_DIR'] = prevLeak;
    if (prevProxy === undefined) delete process.env['HTTP_PROXY'];
    else process.env['HTTP_PROXY'] = prevProxy;
    cleanup();
  }
});

test('provision retries the preflight and accepts a tolerant "OK." reply', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  // First `run` returns a non-OK reply; the second returns "OK." (trailing
  // punctuation, accepted by the tolerant normalizer).
  let runAttempts = 0;
  const spawn: SpawnFn = (opts) => {
    if (opts.args[1] === '--version') {
      return { stdout: 'v1\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      runAttempts += 1;
      if (runAttempts === 1) {
        return { stdout: 'thinking...\n', stderr: '', exitCode: 0 };
      }
      return { stdout: 'OK.\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      agent.provision(home, runner);
      expect(runAttempts).toBe(2);
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
  const runner = new FakeCommandRunner(happyResponder);

  // `run` always exits non-zero -> the "exit" branch of the error.
  const spawn: SpawnFn = (opts): SpawnResult => {
    if (opts.args[1] === 'run') {
      return { stdout: '', stderr: 'provider unauthorized', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
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
  const runner = new FakeCommandRunner(happyResponder);

  // Exit 0 but a verbose (non-OK) reply on every attempt -> the "did not return
  // OK after 3 attempts" branch.
  let runAttempts = 0;
  const spawn: SpawnFn = (opts): SpawnResult => {
    if (opts.args[1] === 'run') {
      runAttempts += 1;
      return { stdout: 'I cannot comply\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // The retry loop ran the full three attempts.
      expect(runAttempts).toBe(3);
    });
  } finally {
    cleanup();
  }
});

// M1-opencode-timeout-swallowed-as-success (preflight): a preflight timeout must
// ABORT immediately with a timeout-typed ProvisionError — Python raises on the
// FIRST TimeoutExpired at 90s — NOT be masked as a non-OK reply and retried 3x.
test('provision aborts the preflight on the first timeout (no retry)', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);
  const runner = new FakeCommandRunner(happyResponder);

  // `run` always times out (the live defaultSpawn throws OpenCodeTimeoutError when
  // Bun.spawnSync kills the child). The loop must NOT swallow + retry.
  let runAttempts = 0;
  const spawn: SpawnFn = (opts): SpawnResult => {
    if (opts.args[1] === '--version') {
      return { stdout: 'v1\n', stderr: '', exitCode: 0 };
    }
    if (opts.args[1] === 'run') {
      runAttempts += 1;
      throw new OpenCodeTimeoutError('opencode run timed out after 90s');
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      expect(() => agent.provision(home, runner)).toThrow(
        /timed out after 90s/,
      );
      // Aborted on the FIRST timeout — Python raises immediately, no 3x retry.
      // Two provision() calls above, one run attempt each => exactly 2.
      expect(runAttempts).toBe(2);
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

  const runner = new FakeCommandRunner((command, args) => {
    if (command === 'command' && args[0] === '-v') {
      return { status: 0, stdout: `/usr/local/bin/${args[1]}\n`, stderr: '' };
    }
    if (command === 'node') {
      return { status: 1, stdout: '', stderr: 'SyntaxError: bad plugin' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // Aborted at node --check, before any opencode preflight invocation.
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-node-check-unconditional: when node is absent on PATH, the
// node --check is silently skipped (Python guards with shutil.which("node")).
// The probe is real Bun.which over PATH, so we point PATH at a bin dir holding
// ONLY a fake opencode binary => Bun.which('opencode') resolves, 'node' is null.
test('provision skips node --check when node is absent on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  const binDir = join(home.workdir, '..', 'opencode-only-bin');
  mkdirSync(binDir, { recursive: true });
  const fakeOpencode = join(binDir, 'opencode');
  writeFileSync(fakeOpencode, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeOpencode, 0o755);

  // The runner must NOT be asked to run node --check when node is off PATH.
  const runner = new FakeCommandRunner((command) => {
    if (command === 'node') {
      throw new Error('node --check must not run when node is absent');
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const { spawn } = makeHappySpawn();

  const prevPath = process.env['PATH'];
  process.env['PATH'] = binDir;
  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      // Provisioning proceeds (no node --check, preflight still runs OK).
      expect(() => agent.provision(home, runner)).not.toThrow();
      expect(runner.calls.some((c) => c.command === 'node')).toBe(false);
    });
  } finally {
    if (prevPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = prevPath;
    cleanup();
  }
});

// H3-opencode-command-v-probe-false-not-found / B2-opencode-which-guard-dropped:
// a missing opencode binary fails fast with a clear setup-stage error before any
// staging or preflight work. The probe is real Bun.which over PATH (NOT a faked
// `command -v` shell builtin, which ENOENTs on Linux and falsely reports
// not-found); the test makes opencode genuinely absent by pointing PATH at an
// empty dir.
test('provision throws ProvisionError when opencode is not on PATH', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // An empty bin dir as the ONLY PATH entry => Bun.which('opencode') is null.
  const emptyBin = join(home.workdir, '..', 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });

  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();

  const prevPath = process.env['PATH'];
  process.env['PATH'] = emptyBin;
  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(/opencode/);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // No preflight invocation when the binary is missing.
      expect(calls.length).toBe(0);
    });
  } finally {
    if (prevPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = prevPath;
    cleanup();
  }
});

test('provision throws ProvisionError when SUPERPOWERS_ROOT is unset', () => {
  const { home, cleanup } = makeTempHome();
  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(undefined, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      // No preflight attempted when a required input is missing.
      expect(calls.length).toBe(0);
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
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(ProvisionError);
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-stale-export-guard-dropped: pre-existing session-export files
// under the export dir before the capture snapshot are rejected.
test('provision throws ProvisionError on a pre-existing stale session export', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // Plant a stale export matching [0-9]*-ses_*.json under the export dir.
  const exportDir = join(home.configDir, '.quorum', 'session-exports');
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, '0000000000000001-ses_stale.json'), '{}');

  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(
        /pre-existing OpenCode session exports/,
      );
      // No preflight when staging aborts on a dirty home.
      expect(calls.length).toBe(0);
    });
  } finally {
    cleanup();
  }
});

// B2-opencode-symlink-and-home-containment-dropped: a symlink under
// SUPERPOWERS_ROOT/skills is rejected before copying.
test('provision rejects a symlink under SUPERPOWERS_ROOT/skills', () => {
  const { home, cleanup } = makeTempHome();
  const spRoot = join(home.workdir, '..', 'superpowers-src');
  mkdirSync(spRoot, { recursive: true });
  stageSuperpowers(spRoot);

  // Plant a symlink inside the skills tree.
  const target = join(spRoot, 'skills', 'using-superpowers', 'SKILL.md');
  const link = join(spRoot, 'skills', 'using-superpowers', 'evil-link.md');
  symlinkSync(target, link);

  const runner = new FakeCommandRunner(happyResponder);
  const { spawn, calls } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
      expect(() => agent.provision(home, runner)).toThrow(
        /unsupported symlink/,
      );
      expect(calls.length).toBe(0);
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
  const { spawn } = makeHappySpawn();

  try {
    withEnv(spRoot, () => {
      const agent = new OpenCodeAgent(OPENCODE_CONFIG, spawn);
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
