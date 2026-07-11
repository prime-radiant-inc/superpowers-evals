import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shellSingleQuote } from '../src/agents/index.ts';
import { populateContextDir } from '../src/runner/context.ts';
import { RunnerError } from '../src/runner/errors.ts';
import { homeEnvSubstitutions } from '../src/runner/index.ts';

// The REAL coding-agents/ dir (sibling of test/). It carries claude-context/
// {HOWTO.md, launch-agent}, the templates populateContextDir substitutes.
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// Build the claude context substitutions exactly as the runner does for the
// runtime_family == claude path (src/runner/index.ts). configDir is the per-run
// agent-config dir; launchCwd the prepared workdir.
function claudeSubstitutions(opts: {
  readonly launchCwd: string;
  readonly configDir: string;
  readonly runDir: string;
  readonly superpowersRoot: string;
  readonly model: string;
}): Record<string, string> {
  const { launchCwd, configDir, runDir, superpowersRoot, model } = opts;
  const launchAgentPath = join(
    runDir,
    'gauntlet-agent',
    'context',
    'launch-agent',
  );
  const claudeEnvFile = join(configDir, '.claude-env');
  return {
    $QUORUM_AGENT_CWD: launchCwd,
    $QUORUM_AGENT_CWD_SH: shellSingleQuote(launchCwd),
    $SUPERPOWERS_ROOT: superpowersRoot,
    $QUORUM_LAUNCH_AGENT: launchAgentPath,
    $QUORUM_LAUNCH_AGENT_SH: shellSingleQuote(launchAgentPath),
    $CLAUDE_ENV_FILE: claudeEnvFile,
    $CLAUDE_ENV_FILE_SH: shellSingleQuote(claudeEnvFile),
    $CLAUDE_MODEL: model,
    // The runner always adds throwaway-$HOME isolation for the coding agent.
    ...homeEnvSubstitutions(join(runDir, 'home')),
  };
}

// Sub-set placeholder keys that MUST NOT survive substitution. ($ANTHROPIC_API_KEY
// and $@ in the launcher are runtime shell expansions, NOT in the sub set, so we
// only assert that OUR substitution keys are fully consumed.)
function assertNoLeftoverSubPlaceholders(
  text: string,
  subs: Readonly<Record<string, string>>,
): void {
  for (const key of Object.keys(subs)) {
    expect(text.includes(key)).toBe(false);
  }
}

test('populateContextDir substitutes every placeholder in the claude context', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const configDir = join(runDir, 'coding-agent-config');
  const launchCwd = join(runDir, 'coding-agent-workdir');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(launchCwd, { recursive: true });
  const subs = claudeSubstitutions({
    launchCwd,
    configDir,
    runDir,
    superpowersRoot: '/tmp/sproot',
    model: 'opus',
  });

  populateContextDir({
    codingAgentsDir: REAL_CODING_AGENTS,
    codingAgent: 'claude',
    runDir,
    substitutions: subs,
    required: true,
    forbiddenPlaceholders: ['$CLAUDE_MODEL'],
  });

  const ctxDir = join(runDir, 'gauntlet-agent', 'context');
  const howto = readFileSync(join(ctxDir, 'HOWTO.md'), 'utf8');
  const launcher = readFileSync(join(ctxDir, 'launch-agent'), 'utf8');

  // Every $… key from the sub set is gone from both files.
  assertNoLeftoverSubPlaceholders(howto, subs);
  assertNoLeftoverSubPlaceholders(launcher, subs);

  // Concrete resolved paths landed in the launcher.
  expect(launcher).toContain(launchCwd);
  expect(launcher).toContain(join(configDir, '.claude-env'));
  expect(launcher).toContain('opus');
  // The HOWTO points at the generated launcher's absolute path.
  expect(howto).toContain(join(ctxDir, 'launch-agent'));

  // Nested-session capture defenses survive substitution (oracle da4846d/ea6a231).
  // The launcher uses env -i (superseding the old -u strips) and forces transcript
  // persistence; losing either empties capture -> indeterminate(capture).
  expect(launcher).toContain('env -i');
  expect(launcher).toContain('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1');

  // Throwaway-$HOME isolation: HOME + the XDG dirs are pinned under <runDir>/home
  // in the launcher's exec env line, so the coding agent never touches the
  // operator's real ~/.claude, ~/.config, ~/.cache, etc.
  const runHomeDir = join(runDir, 'home');
  expect(launcher).toContain(`HOME='${runHomeDir}'`);
  expect(launcher).toContain(
    `XDG_CONFIG_HOME='${join(runHomeDir, '.config')}'`,
  );
  expect(launcher).toContain(`XDG_CACHE_HOME='${join(runHomeDir, '.cache')}'`);

  // The shebang'd launcher is executable after substitution (mode & 0o111).
  const mode = statSync(join(ctxDir, 'launch-agent')).mode;
  expect(mode & 0o111).not.toBe(0);
});

test('populateContextDir raises when a required context dir is missing', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  // An empty coding-agents dir: no claude-context/ inside it.
  const emptyAgents = mkdtempSync(join(tmpdir(), 'agents-'));
  expect(() =>
    populateContextDir({
      codingAgentsDir: emptyAgents,
      codingAgent: 'claude',
      runDir,
      substitutions: {},
      required: true,
    }),
  ).toThrow(RunnerError);
});

test('populateContextDir is a no-op when a non-required context dir is missing', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const emptyAgents = mkdtempSync(join(tmpdir(), 'agents-'));
  // required defaults to false: missing dir is silently skipped.
  expect(() =>
    populateContextDir({
      codingAgentsDir: emptyAgents,
      codingAgent: 'nope',
      runDir,
      substitutions: {},
    }),
  ).not.toThrow();
});

test('populateContextDir raises when a forbidden placeholder survives', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const configDir = join(runDir, 'coding-agent-config');
  const launchCwd = join(runDir, 'coding-agent-workdir');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(launchCwd, { recursive: true });
  // Build the full sub set, then DROP $CLAUDE_MODEL so it cannot be substituted
  // — the forbidden-placeholder guard must then fire.
  const subs = claudeSubstitutions({
    launchCwd,
    configDir,
    runDir,
    superpowersRoot: '/tmp/sproot',
    model: 'opus',
  });
  delete subs['$CLAUDE_MODEL'];

  expect(() =>
    populateContextDir({
      codingAgentsDir: REAL_CODING_AGENTS,
      codingAgent: 'claude',
      runDir,
      substitutions: subs,
      required: true,
      forbiddenPlaceholders: ['$CLAUDE_MODEL'],
    }),
  ).toThrow(/CLAUDE_MODEL/);
});

test('populateContextDir resolves $SERF_MODEL_SH before $SERF_MODEL', () => {
  // The Serf launcher needs the single-quoted token intact. Replacing the raw
  // placeholder first would turn $SERF_MODEL_SH into raw-model_SH.
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const srcAgents = mkdtempSync(join(tmpdir(), 'agents-'));
  const ctxSrc = join(srcAgents, 'demo-context');
  mkdirSync(ctxSrc, { recursive: true });
  writeFileSync(
    join(ctxSrc, 'file.txt'),
    'raw=$SERF_MODEL quoted=$SERF_MODEL_SH\n',
  );

  populateContextDir({
    codingAgentsDir: srcAgents,
    codingAgent: 'demo',
    runDir,
    substitutions: {
      $SERF_MODEL: 'raw-model',
      $SERF_MODEL_SH: "'quoted model'",
    },
  });

  const out = readFileSync(
    join(runDir, 'gauntlet-agent', 'context', 'file.txt'),
    'utf8',
  );
  expect(out).toBe("raw=raw-model quoted='quoted model'\n");
});

test('populateContextDir does not rewrite placeholder-like replacement content', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const srcAgents = mkdtempSync(join(tmpdir(), 'agents-'));
  const ctxSrc = join(srcAgents, 'demo-context');
  mkdirSync(ctxSrc, { recursive: true });
  writeFileSync(join(ctxSrc, 'file.txt'), 'quoted=$SERF_MODEL_SH\n');

  populateContextDir({
    codingAgentsDir: srcAgents,
    codingAgent: 'demo',
    runDir,
    substitutions: {
      $SERF_MODEL: 'raw-model',
      $SERF_MODEL_SH: "'literal $SERF_MODEL_LITERAL'",
    },
  });

  const out = readFileSync(
    join(runDir, 'gauntlet-agent', 'context', 'file.txt'),
    'utf8',
  );
  expect(out).toBe("quoted='literal $SERF_MODEL_LITERAL'\n");
});

const DEFAULT_SERF_MODEL = 'openrouter/anthropic/claude-sonnet-4-6';

function installSerfLauncher(
  selectedName: string,
  invoked?: string,
  model = DEFAULT_SERF_MODEL,
): {
  readonly launcher: string;
  readonly binDir: string;
  readonly envDump: string;
  readonly argvDump: string;
} {
  const runDir = mkdtempSync(join(tmpdir(), 'serf-launcher-'));
  const home = join(runDir, 'home');
  const workdir = join(runDir, 'workdir');
  const binDir = mkdtempSync(join(tmpdir(), 'serf-bin-'));
  const envDump = join(runDir, 'serf-env.txt');
  const argvDump = join(runDir, 'serf-argv.txt');
  mkdirSync(home, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  const fakeSerf = join(binDir, 'serf');
  writeFileSync(
    fakeSerf,
    `#!/bin/sh\n${
      invoked === undefined ? `/usr/bin/env > '${envDump}'` : `: > '${invoked}'`
    }\nprintf '%s\\n' "$@" > '${argvDump}'\n`,
  );
  chmodSync(fakeSerf, 0o755);

  populateContextDir({
    codingAgentsDir: REAL_CODING_AGENTS,
    codingAgent: 'serf',
    runDir,
    substitutions: {
      $QUORUM_AGENT_CWD: workdir,
      $SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'serf-superpowers-')),
      $SERF_MODEL: model,
      $SERF_MODEL_SH: shellSingleQuote(model),
      $SERF_API_KEY_ENV: selectedName,
      $SERF_API_KEY_ENV_SH: shellSingleQuote(selectedName),
      ...homeEnvSubstitutions(home),
    },
    required: true,
    forbiddenPlaceholders: ['$SERF_MODEL', '$SERF_API_KEY_ENV'],
  });

  return {
    launcher: join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    binDir,
    envDump,
    argvDump,
  };
}

function parseEnvDump(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return values;
}

test('Serf launcher forwards only the selected indirect API-key value into its clean environment', () => {
  const selectedName = 'SERF_TEST_SELECTED_API_KEY';
  const selectedValue = crypto.randomUUID();
  const unrelatedValues = {
    ANTHROPIC_API_KEY: crypto.randomUUID(),
    OPENAI_API_KEY: crypto.randomUUID(),
    GEMINI_API_KEY: crypto.randomUUID(),
    GOOGLE_API_KEY: crypto.randomUUID(),
    OPENROUTER_API_KEY: crypto.randomUUID(),
  };
  const { launcher, binDir, envDump } = installSerfLauncher(selectedName);
  const generated = readFileSync(launcher, 'utf8');

  expect(generated).toContain(selectedName);
  expect(generated).not.toContain(selectedValue);

  const proc = spawnSync('bash', [launcher, 'do work'], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      [selectedName]: selectedValue,
      ...unrelatedValues,
    },
  });
  expect(proc.status).toBe(0);

  const env = parseEnvDump(envDump);
  expect(env[selectedName]).toBe(selectedValue);
  for (const name of Object.keys(unrelatedValues)) {
    expect(env[name]).toBe(undefined);
  }
});

test('Serf launcher preserves a shell-significant model as one exact argv without interpolation', () => {
  const selectedName = 'SERF_TEST_SELECTED_API_KEY';
  const interpolationProbe = join(
    mkdtempSync(join(tmpdir(), 'serf-model-interpolation-')),
    'executed',
  );
  const model = `openrouter/acme $SERF_MODEL_LITERAL \`touch ${interpolationProbe}\` with "double" and 'single' quotes`;
  const { launcher, binDir, argvDump } = installSerfLauncher(
    selectedName,
    undefined,
    model,
  );

  const proc = spawnSync('bash', [launcher, 'do work'], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      [selectedName]: crypto.randomUUID(),
    },
  });

  expect(proc.status).toBe(0);
  expect(existsSync(interpolationProbe)).toBe(false);
  const argv = readFileSync(argvDump, 'utf8').trimEnd().split('\n');
  const modelFlag = argv.indexOf('--model');
  expect(modelFlag).toBeGreaterThanOrEqual(0);
  expect(argv[modelFlag + 1]).toBe(model);
});

test('Serf launcher rejects missing and empty selected API-key values before it invokes Serf', () => {
  const selectedName = 'SERF_TEST_SELECTED_API_KEY';
  for (const selectedValue of [undefined, '']) {
    const invoked = join(mkdtempSync(join(tmpdir(), 'serf-invoked-')), 'serf');
    const { launcher, binDir } = installSerfLauncher(selectedName, invoked);
    const proc = spawnSync('bash', [launcher, 'do work'], {
      encoding: 'utf8',
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        ...(selectedValue === undefined
          ? {}
          : { [selectedName]: selectedValue }),
      },
    });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain(`${selectedName} is unset/empty`);
    expect(existsSync(invoked)).toBe(false);
  }
});

test('Serf launcher rejects an empty selected API-key name before it invokes Serf', () => {
  const invoked = join(mkdtempSync(join(tmpdir(), 'serf-invoked-')), 'serf');
  const { launcher, binDir } = installSerfLauncher('', invoked);
  const proc = spawnSync('bash', [launcher, 'do work'], {
    encoding: 'utf8',
    env: { PATH: `${binDir}:/usr/bin:/bin` },
  });

  expect(proc.status).toBe(1);
  expect(proc.stderr).toContain('selected Serf API key env name is empty');
  expect(existsSync(invoked)).toBe(false);
});
