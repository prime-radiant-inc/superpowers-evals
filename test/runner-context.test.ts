import { expect, test } from 'bun:test';
import {
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

// The REAL coding-agents/ dir (sibling of test/). It carries claude-context/
// {HOWTO.md, launch-agent}, the templates populateContextDir substitutes.
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// Build the claude context substitutions exactly as the runner does
// (quorum/runner.py 1885-1916 for the runtime_family == claude path). configDir
// is the per-run agent-config dir; launchCwd the prepared workdir.
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
    $CLAUDE_CONFIG_DIR: configDir,
    $CLAUDE_CONFIG_DIR_SH: shellSingleQuote(configDir),
    $CLAUDE_ENV_FILE: claudeEnvFile,
    $CLAUDE_ENV_FILE_SH: shellSingleQuote(claudeEnvFile),
    $CLAUDE_MODEL: model,
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

test('populateContextDir applies longer placeholders before their prefixes', () => {
  // $FOO_SH must be replaced before $FOO (length-desc ordering), or the longer
  // key would be corrupted by the shorter one's replacement.
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const srcAgents = mkdtempSync(join(tmpdir(), 'agents-'));
  const ctxSrc = join(srcAgents, 'demo-context');
  mkdirSync(ctxSrc, { recursive: true });
  writeFileSync(join(ctxSrc, 'file.txt'), 'a=$FOO b=$FOO_SH\n');

  populateContextDir({
    codingAgentsDir: srcAgents,
    codingAgent: 'demo',
    runDir,
    substitutions: { $FOO: 'X', $FOO_SH: 'Y' },
  });

  const out = readFileSync(
    join(runDir, 'gauntlet-agent', 'context', 'file.txt'),
    'utf8',
  );
  expect(out).toBe('a=X b=Y\n');
});
