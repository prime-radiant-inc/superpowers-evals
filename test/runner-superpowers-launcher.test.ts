import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { populateContextDir } from '../src/runner/context.ts';
// buildContextSubstitutions is extracted from runScenario by this task:
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

// The migrated claude/serf/pi templates splice $SUPERPOWERS_PLUGIN_ARGS (a
// flags splice: unquoted) where they used to bake a literal $SUPERPOWERS_ROOT.
// These tests substitute the REAL templates through the real builder and pin
// the resulting bytes per mode.

// The exact flag text the pre-migration templates baked from $SUPERPOWERS_ROOT
// — the non-circular byte-identity oracle for the undefined (legacy) arm.
const LEGACY_FLAG_TEXT = {
  claude: '--plugin-dir "/ambient/sp"',
  serf: '--plugin-dir "/ambient/sp"',
  pi: '--extension "/ambient/sp" --skill "/ambient/sp/skills"',
} as const;

test('migrated templates: legacy ambient expansion lands the exact pre-migration flag bytes', () => {
  for (const agent of ['claude', 'serf', 'pi'] as const) {
    withAmbientRoot('/ambient/sp', () => {
      const runDir = mkdtempSync(join(tmpdir(), 'run-'));
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
          superpowers: undefined,
        }),
        required: true,
      });
      const launcher = readFileSync(
        join(runDir, 'gauntlet-agent', 'context', 'launch-agent'),
        'utf8',
      );
      expect(launcher).toContain(LEGACY_FLAG_TEXT[agent]);
      expect(launcher).not.toContain('$SUPERPOWERS_PLUGIN_ARGS');
      expect(launcher).not.toContain('$SUPERPOWERS_ROOT');
    });
  }
});

test('migrated templates: none mode elides the flags with no raw superpowers placeholder left', () => {
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
    const execBlock = launcher.slice(launcher.indexOf('exec '));
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
