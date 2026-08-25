import { expect, test } from 'bun:test';
import type { RunHome } from '../src/agents/index.ts';
import { superpowersCapability } from '../src/agents/index.ts';
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
  // biome-ignore lint/style/noProcessEnv: set ambient SUPERPOWERS_ROOT for this one assertion (this file is outside the test/agent-*.test.ts noProcessEnv exemption)
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    expect(resolveSuperpowersRoot(home(undefined))).toEqual({
      kind: 'root',
      root: '/ambient/sp',
    });
  } finally {
    // biome-ignore lint/style/noProcessEnv: clear ambient after the assertion
    delete process.env['SUPERPOWERS_ROOT'];
  }
});

test('resolveSuperpowersRoot: undefined with ambient absent is missing', () => {
  // biome-ignore lint/style/noProcessEnv: clear ambient to exercise the missing arm
  delete process.env['SUPERPOWERS_ROOT'];
  expect(resolveSuperpowersRoot(home(undefined))).toEqual({ kind: 'missing' });
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
  ).toBe('--plugin-dir "/wt/abc"');
  expect(superpowersPluginArgs('claude', { mode: 'none' })).toBe('');
  // Legacy byte-identity: today's substituted bytes, ambient set and unset.
  // biome-ignore lint/style/noProcessEnv: set ambient for the legacy-expansion assertion
  process.env['SUPERPOWERS_ROOT'] = '/ambient/sp';
  try {
    expect(superpowersPluginArgs('claude', undefined)).toBe(
      '--plugin-dir "/ambient/sp"',
    );
  } finally {
    // biome-ignore lint/style/noProcessEnv: clear ambient after the assertion
    delete process.env['SUPERPOWERS_ROOT'];
  }
  expect(superpowersPluginArgs('claude', undefined)).toBe('--plugin-dir ""');
});

test('superpowersPluginArgs: serf mirrors claude; pi has extension+skill', () => {
  expect(superpowersPluginArgs('serf', { mode: 'root', root: '/wt/abc' })).toBe(
    '--plugin-dir "/wt/abc"',
  );
  expect(superpowersPluginArgs('pi', { mode: 'root', root: '/wt/abc' })).toBe(
    '--extension "/wt/abc" --skill "/wt/abc/skills"',
  );
  expect(superpowersPluginArgs('pi', { mode: 'none' })).toBe('');
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

test('superpowersCapability: keyed by runtime_family ?? name', () => {
  expect(
    superpowersCapability({
      name: 'builder-alias',
      runtime_family: 'serf',
    } as never),
  ).toEqual(superpowersCapability('serf'));
});
