import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { populateContextDir } from '../src/runner/context.ts';
import { buildContextSubstitutions } from '../src/runner/index.ts';

const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// Pin (or clear) ambient SUPERPOWERS_ROOT around `body`, snapshotting and
// restoring the prior host value even on throw — the withRoot pattern from
// test/agents-superpowers.test.ts. This file sits outside biome's
// noProcessEnv exemption globs, so each direct process.env line carries a
// suppression comment.
function withAmbientRoot(value: string | undefined, body: () => void): void {
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prev = process.env['SUPERPOWERS_ROOT'];
  try {
    if (value === undefined) {
      // biome-ignore lint/style/noProcessEnv: clear ambient for the assertions
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      // biome-ignore lint/style/noProcessEnv: pin ambient for the assertions
      process.env['SUPERPOWERS_ROOT'] = value;
    }
    body();
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/style/noProcessEnv: restore the snapshotted host value
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      // biome-ignore lint/style/noProcessEnv: restore the snapshotted host value
      process.env['SUPERPOWERS_ROOT'] = prev;
    }
  }
}

test('root mode: launcher placeholder expands to the threaded root flags', () => {
  const subs = buildContextSubstitutions({
    launchCwd: '/w',
    launchAgentPath: '/ctx/launch-agent',
    runHomeDir: '/h',
    family: 'claude',
    superpowers: { mode: 'root', root: '/wt/abc' },
  });
  expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('--plugin-dir "/wt/abc"');
  expect(subs['$SUPERPOWERS_ROOT']).toBe('/wt/abc');
});

test('none mode: placeholder elides flags; raw $SUPERPOWERS_ROOT fails loud in context', () => {
  const subs = buildContextSubstitutions({
    launchCwd: '/w',
    launchAgentPath: '/ctx/launch-agent',
    runHomeDir: '/h',
    family: 'claude',
    superpowers: { mode: 'none' },
  });
  expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('');
  expect(subs).not.toHaveProperty('$SUPERPOWERS_ROOT');
  // The fail-loud half: a populated context still referencing the raw
  // placeholder must raise under none mode.
  const agentsDir = mkdtempSync(join(tmpdir(), 'agents-'));
  mkdirSync(join(agentsDir, 'claude-context'));
  writeFileSync(
    join(agentsDir, 'claude-context', 'launch-agent'),
    'exec claude --plugin-dir "$SUPERPOWERS_ROOT"\n',
  );
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  expect(() =>
    populateContextDir({
      codingAgentsDir: agentsDir,
      codingAgent: 'claude',
      runDir,
      substitutions: subs,
      required: true,
      forbiddenPlaceholders: ['$SUPERPOWERS_PLUGIN_ARGS', '$SUPERPOWERS_ROOT'],
    }),
  ).toThrow(/SUPERPOWERS_ROOT/);
});

test('legacy mode: byte-identical expansion, ambient set and unset', () => {
  withAmbientRoot('/ambient/sp', () => {
    const subs = buildContextSubstitutions({
      launchCwd: '/w',
      launchAgentPath: '/ctx/launch-agent',
      runHomeDir: '/h',
      family: 'claude',
      superpowers: undefined,
    });
    expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('--plugin-dir "/ambient/sp"');
    expect(subs['$SUPERPOWERS_ROOT']).toBe('/ambient/sp');
  });
  withAmbientRoot(undefined, () => {
    const subs = buildContextSubstitutions({
      launchCwd: '/w',
      launchAgentPath: '/ctx/launch-agent',
      runHomeDir: '/h',
      family: 'claude',
      superpowers: undefined,
    });
    expect(subs['$SUPERPOWERS_PLUGIN_ARGS']).toBe('--plugin-dir ""');
  });
});

// The claude/serf/pi launcher templates splice $SUPERPOWERS_PLUGIN_ARGS on
// their exec lines (a flags splice: unquoted, expanding to the family's
// superpowers flags — or to nothing when superpowers is suppressed). The
// tests below substitute the REAL templates through the real builder and pin
// the populated bytes per mode.

// The raw template text each family's splice stands in for — the byte-identity
// oracle for the undefined (legacy) arm. pi's pair is contiguous at one
// position: the canonical arrangement the single splice reproduces (pi's
// parser is order-inert across these flags — --skill appends to the CLI skill
// list while --no-skills only gates discovery — so contiguity fixes the bytes
// without touching behavior).
const RAW_SUPERPOWERS_FLAGS = {
  claude: '--plugin-dir "$SUPERPOWERS_ROOT"',
  serf: '--plugin-dir "$SUPERPOWERS_ROOT"',
  pi: '--extension "$SUPERPOWERS_ROOT" --skill "$SUPERPOWERS_ROOT/skills"',
} as const;

// The exec-block flag order each launcher bakes under the legacy arm — the
// canonical arrangement pinned on the populated bytes, independently of the
// splice, so a template edit that interleaves other flags with the superpowers
// pair (or moves it) fails here even though the splice itself still expands.
// pi's $PI_SUBAGENTS_PKG resolves at launch time, so its token survives
// substitution literally.
const EXEC_FLAG_ORDER = {
  claude: ['--dangerously-skip-permissions', '--plugin-dir', '--model'],
  serf: ['--model', '--plugin-dir', '--export-atif', '--dir', '--state-dir'],
  pi: [
    '--provider',
    '--model',
    '--no-extensions',
    '--extension "/ambient/sp"',
    '--skill "/ambient/sp/skills"',
    '--extension "$PI_SUBAGENTS_PKG"',
    '--no-skills',
    '--tools',
  ],
} as const;

test('legacy arm: the populated launcher is byte-identical to the raw reference template', () => {
  for (const agent of ['claude', 'serf', 'pi'] as const) {
    withAmbientRoot('/ambient/sp', () => {
      // Both sides bake the same concrete paths, so the only permitted
      // difference between them is the splice's own expansion.
      const actualRunDir = mkdtempSync(join(tmpdir(), 'run-'));
      const launchCwd = join(actualRunDir, 'coding-agent-workdir');
      const launchAgentPath = join(
        actualRunDir,
        'gauntlet-agent',
        'context',
        'launch-agent',
      );
      const runHomeDir = join(actualRunDir, 'home');
      const substitutions = buildContextSubstitutions({
        launchCwd,
        launchAgentPath,
        runHomeDir,
        family: agent,
        superpowers: undefined,
      });
      populateContextDir({
        codingAgentsDir: REAL_CODING_AGENTS,
        codingAgent: agent,
        runDir: actualRunDir,
        substitutions,
        required: true,
      });
      const actual = readFileSync(launchAgentPath, 'utf8');

      // Reference: the committed template with the splice token replaced by
      // the pinned raw fragment — the raw template the splice must reproduce
      // — populated with the same map minus the splice key (the legacy arm's
      // $SUPERPOWERS_ROOT entry resolves the raw flags).
      const refAgentsDir = mkdtempSync(join(tmpdir(), 'agents-'));
      mkdirSync(join(refAgentsDir, `${agent}-context`), { recursive: true });
      writeFileSync(
        join(refAgentsDir, `${agent}-context`, 'launch-agent'),
        readFileSync(
          join(REAL_CODING_AGENTS, `${agent}-context`, 'launch-agent'),
          'utf8',
        ).replaceAll('$SUPERPOWERS_PLUGIN_ARGS', RAW_SUPERPOWERS_FLAGS[agent]),
      );
      const refRunDir = mkdtempSync(join(tmpdir(), 'run-'));
      const refSubstitutions: Record<string, string> = { ...substitutions };
      delete refSubstitutions['$SUPERPOWERS_PLUGIN_ARGS'];
      populateContextDir({
        codingAgentsDir: refAgentsDir,
        codingAgent: agent,
        runDir: refRunDir,
        substitutions: refSubstitutions,
        required: true,
      });
      const expected = readFileSync(
        join(refRunDir, 'gauntlet-agent', 'context', 'launch-agent'),
        'utf8',
      );

      // Whole-body equality: the splice reproduces the raw reference bytes.
      expect(actual).toBe(expected);
      expect(actual).not.toContain('$SUPERPOWERS_PLUGIN_ARGS');
      expect(actual).not.toContain('$SUPERPOWERS_ROOT');

      // The canonical exec-block arrangement holds on the populated bytes
      // (the exec block, not the prose comments, which may name the flags).
      const execBlock = actual.slice(actual.indexOf('exec env'));
      const positions = EXEC_FLAG_ORDER[agent].map((flag) =>
        execBlock.indexOf(flag),
      );
      for (const position of positions) {
        expect(position).toBeGreaterThanOrEqual(0);
      }
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
  }
});

test('none mode: populated launchers elide the flags with no raw superpowers placeholder left', () => {
  for (const agent of ['claude', 'serf', 'pi'] as const) {
    const runDir = mkdtempSync(join(tmpdir(), 'run-'));
    // The runner's none-mode forbidden set: neither placeholder may survive
    // context population (a raw one is an instrument bug).
    expect(() =>
      populateContextDir({
        codingAgentsDir: REAL_CODING_AGENTS,
        codingAgent: agent,
        runDir,
        substitutions: buildContextSubstitutions({
          launchCwd: join(runDir, 'coding-agent-workdir'),
          launchAgentPath: join(
            runDir,
            'gauntlet-agent',
            'context',
            'launch-agent',
          ),
          runHomeDir: join(runDir, 'home'),
          family: agent,
          superpowers: { mode: 'none' },
        }),
        required: true,
        forbiddenPlaceholders: [
          '$SUPERPOWERS_PLUGIN_ARGS',
          '$SUPERPOWERS_ROOT',
        ],
      }),
    ).not.toThrow();
    const launcher = readFileSync(
      join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
      'utf8',
    );
    // The exec block (not the prose comments, which may name the flags)
    // carries no superpowers flags under none mode.
    const execBlock = launcher.slice(launcher.indexOf('exec env'));
    if (agent === 'pi') {
      expect(execBlock).not.toContain('--skill');
    } else {
      expect(execBlock).not.toContain('--plugin-dir');
    }
    expect(launcher).not.toContain('$SUPERPOWERS_PLUGIN_ARGS');
    expect(launcher).not.toContain('$SUPERPOWERS_ROOT');
    // The elided splice must leave a syntactically valid script: the empty
    // expansion turns the splice line into a bare continuation, and the
    // claude/pi mid-line splice into a double space — both fine for bash,
    // proven here so a none-mode launcher can never ship unparseable.
    const syntax = spawnSync('bash', [
      '-n',
      join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
    ]);
    expect(syntax.status).toBe(0);
  }
});
