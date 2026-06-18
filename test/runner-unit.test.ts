import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  allocateRunDir,
  buildGauntletArgv,
  contextDirName,
} from '../src/runner/index.ts';

test('allocateRunDir names <scenario>-<agent>-<os>-<stamp>-<nonce> and creates it', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, '00-quorum-smoke-hello-world', 'claude');
  expect(basename(dir)).toMatch(
    /^00-quorum-smoke-hello-world-claude-linux-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
  expect(existsSync(dir)).toBe(true);
});

test('allocateRunDir with os=windows id contains -claude-windows-', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, 'sc', 'claude', 'windows');
  expect(basename(dir)).toMatch(/^sc-claude-windows-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
});

test('allocateRunDir is unique across calls (distinct nonces)', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const a = allocateRunDir(out, 'scn', 'codex');
  const b = allocateRunDir(out, 'scn', 'codex');
  expect(a).not.toBe(b);
});

test('contextDirName: linux (default) returns the family context dir', () => {
  expect(contextDirName({ name: 'claude', runtime_family: 'claude' })).toBe(
    'claude',
  );
});

test('contextDirName(cfg, os): linux returns runtime_family', () => {
  expect(
    contextDirName({ name: 'claude', runtime_family: 'claude' }, 'linux'),
  ).toBe('claude');
});

test('contextDirName(cfg, os): windows returns runtime_family-windows', () => {
  expect(
    contextDirName({ name: 'claude', runtime_family: 'claude' }, 'windows'),
  ).toBe('claude-windows');
});

test('buildGauntletArgv is exact and order-stable with all optional flags', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    maxTime: '10m',
    projectPrompt: '/r/p.md',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--max-time',
    '10m',
    '--project-prompt',
    '/r/p.md',
  ]);
});

test('buildGauntletArgv omits optional flags when absent', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'codex',
    runDir: '/r',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'codex',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
  ]);
});

test('buildGauntletArgv appends only --max-time when projectPrompt is absent', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    maxTime: '5m',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--max-time',
    '5m',
  ]);
});
