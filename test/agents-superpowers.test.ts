import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunHome } from '../src/agents/index.ts';
import {
  superpowersCapability,
  withSuperpowersCapabilityForTesting,
} from '../src/agents/index.ts';
import {
  projectSuperpowersEnv,
  resolveSuperpowersRoot,
  superpowersPluginArgs,
} from '../src/agents/superpowers.ts';

const home = (superpowers?: RunHome['superpowers']): RunHome => ({
  configDir: '/h/.claude',
  workdir: '/w',
  skeletonRoot: undefined,
  superpowers,
});

// Set (or clear) ambient SUPERPOWERS_ROOT around `body`, snapshotting and
// restoring the prior host value even on throw — the withRoot pattern from
// test/agent-antigravity.test.ts. This file sits outside biome's
// test/agent-*.test.ts noProcessEnv exemption glob, so each direct process.env
// line carries a suppression comment.
function withRoot(superpowersRoot: string | undefined, body: () => void): void {
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prev = process.env['SUPERPOWERS_ROOT'];
  try {
    if (superpowersRoot === undefined) {
      // biome-ignore lint/style/noProcessEnv: clear ambient for the assertions
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      // biome-ignore lint/style/noProcessEnv: set ambient for the assertions
      process.env['SUPERPOWERS_ROOT'] = superpowersRoot;
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

test('resolveSuperpowersRoot: root mode returns the threaded root', () => {
  expect(
    resolveSuperpowersRoot(home({ mode: 'root', root: '/wt/abc' })),
  ).toEqual({ kind: 'root', root: '/wt/abc' });
});

test('resolveSuperpowersRoot: none mode suppresses', () => {
  expect(resolveSuperpowersRoot(home({ mode: 'none' }))).toEqual({
    kind: 'none',
  });
});

test('resolveSuperpowersRoot: undefined falls back to ambient', () => {
  withRoot('/ambient/sp', () => {
    expect(resolveSuperpowersRoot(home(undefined))).toEqual({
      kind: 'root',
      root: '/ambient/sp',
    });
  });
});

test('resolveSuperpowersRoot: undefined with ambient absent is missing', () => {
  withRoot(undefined, () => {
    expect(resolveSuperpowersRoot(home(undefined))).toEqual({
      kind: 'missing',
    });
  });
});

test('projectSuperpowersEnv: root overrides, none strips, undefined is a no-op', () => {
  const base: Record<string, string | undefined> = {
    SUPERPOWERS_ROOT: '/ambient/sp',
    PATH: '/usr/bin',
  };
  const rootEnv = { ...base };
  projectSuperpowersEnv({ mode: 'root', root: '/wt/abc' }, rootEnv);
  expect(rootEnv['SUPERPOWERS_ROOT']).toBe('/wt/abc');
  const noneEnv = { ...base };
  projectSuperpowersEnv({ mode: 'none' }, noneEnv);
  expect(noneEnv).not.toHaveProperty('SUPERPOWERS_ROOT');
  const legacyEnv = { ...base };
  projectSuperpowersEnv(undefined, legacyEnv);
  expect(legacyEnv).toEqual(base);
});

test('superpowersPluginArgs: claude root/legacy/none expansion', () => {
  expect(
    superpowersPluginArgs('claude', { mode: 'root', root: '/wt/abc' }),
  ).toBe("--plugin-dir '/wt/abc'");
  expect(superpowersPluginArgs('claude', { mode: 'none' })).toBe('');
  // Legacy byte-identity: today's substituted bytes, ambient set and unset.
  withRoot('/ambient/sp', () => {
    expect(superpowersPluginArgs('claude', undefined)).toBe(
      '--plugin-dir "/ambient/sp"',
    );
  });
  withRoot(undefined, () => {
    expect(superpowersPluginArgs('claude', undefined)).toBe('--plugin-dir ""');
  });
});

test('superpowersPluginArgs: serf mirrors claude; pi has extension+skill', () => {
  expect(superpowersPluginArgs('serf', { mode: 'root', root: '/wt/abc' })).toBe(
    "--plugin-dir '/wt/abc'",
  );
  expect(superpowersPluginArgs('pi', { mode: 'root', root: '/wt/abc' })).toBe(
    "--extension '/wt/abc' --skill '/wt/abc/skills'",
  );
  expect(superpowersPluginArgs('pi', { mode: 'none' })).toBe('');
});

// Root-mode expansions are spliced UNQUOTED into executable launcher text
// (populateContextDir substitutes the rendered string straight into the exec
// line, which bash then evaluates). A hostile explicit root must therefore
// reach the agent CLI as literal argv bytes — never word-split, expanded, or
// executed. Proven against real bash argv, not the rendered string.
test('superpowersPluginArgs: root mode is bash-inert for hostile paths', () => {
  const base = mkdtempSync(join(tmpdir(), 'sp-quote-'));
  const markerA = join(base, 'PROBE_SUBST');
  const markerB = join(base, 'PROBE_BACKTICK');
  const hostileRoots = [
    join(base, 'sp dir with spaces'),
    join(base, "sp'single"),
    join(base, 'sp"double'),
    join(base, `sp$(touch ${markerA})`),
    join(base, `sp\`touch ${markerB}\``),
    join(base, 'sp\\back\\\\slash'),
  ];
  // Run `printf '%s\n' <rendered>` through real bash — the same unquoted
  // splice position the launcher uses — and return the argv it produced.
  const argvOf = (rendered: string): string[] => {
    const out = join(base, `argv-${randomUUID()}`);
    const script = join(base, `probe-${randomUUID()}.sh`);
    writeFileSync(
      script,
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' ${rendered} > '${out}'\n`,
    );
    const res = spawnSync('bash', [script], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    return readFileSync(out, 'utf8').split('\n').slice(0, -1);
  };
  for (const root of hostileRoots) {
    for (const family of ['claude', 'serf'] as const) {
      expect(
        argvOf(superpowersPluginArgs(family, { mode: 'root', root })),
      ).toEqual(['--plugin-dir', root]);
    }
    expect(argvOf(superpowersPluginArgs('pi', { mode: 'root', root }))).toEqual(
      ['--extension', root, '--skill', `${root}/skills`],
    );
  }
  // The command-substitution and backtick payloads never executed.
  expect(existsSync(markerA)).toBe(false);
  expect(existsSync(markerB)).toBe(false);
});

test('superpowersPluginArgs: families without launcher references expand empty', () => {
  expect(
    superpowersPluginArgs('codex', { mode: 'root', root: '/wt/abc' }),
  ).toBe('');
});

test('superpowersCapability: default-deny for undeclared families', () => {
  expect(superpowersCapability('definitely-not-a-family')).toEqual({
    ref: false,
    none: false,
  });
});

test('superpowersCapability: claude flagged by the D2 two-mode live smoke', () => {
  expect(superpowersCapability('claude')).toEqual({ ref: true, none: true });
});

test('superpowersCapability: keyed by runtime_family ?? name', () => {
  // Seed one entry so key selection is OBSERVABLE: when both candidate keys
  // are undeclared both arms return the identical default-deny value, so an
  // always-`name` mutant would pass. With serf flagged, the alias config must
  // resolve through its runtime_family, and the bare alias name must NOT
  // inherit the family's entry.
  withSuperpowersCapabilityForTesting(
    { serf: { ref: true, none: true } },
    () => {
      expect(
        superpowersCapability({
          name: 'builder-alias',
          runtime_family: 'serf',
        } as never),
      ).toEqual(superpowersCapability('serf'));
      expect(superpowersCapability('serf')).toEqual({ ref: true, none: true });
      expect(superpowersCapability('builder-alias')).toEqual({
        ref: false,
        none: false,
      });
    },
  );
  // The seam restores the prior registry afterward; serf stays default-deny.
  expect(superpowersCapability('serf')).toEqual({ ref: false, none: false });
});
