import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSuperpowersPlugin } from '../src/setup-helpers/plugin-stage.ts';

// Build a realistic superpowers checkout: plugin payload (skills/hooks/manifest)
// plus the cruft every consumer must drop (evals submodule, .git, node_modules,
// python caches, dev-worktree .claude).
function makeFakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sproot-'));
  mkdirSync(join(root, 'skills', 'brainstorming'), { recursive: true });
  writeFileSync(join(root, 'skills', 'brainstorming', 'SKILL.md'), '# skill\n');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'session-start'), '#!/bin/sh\n');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}\n');
  // cruft:
  mkdirSync(join(root, 'evals', 'results', 'deep'), { recursive: true });
  writeFileSync(
    join(root, 'evals', 'results', 'deep', 'transcript.json'),
    '{}',
  );
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
  writeFileSync(join(root, '.claude', 'state.json'), '{}');
  mkdirSync(join(root, '.worktrees', 'pri-0000-stale', 'skills'), {
    recursive: true,
  });
  writeFileSync(
    join(root, '.worktrees', 'pri-0000-stale', 'skills', 'SKILL.md'),
    '# stale\n',
  );
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(root, 'node_modules', 'commander'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'commander', 'index.js'), '\n');
  mkdirSync(join(root, 'skills', '__pycache__'), { recursive: true });
  writeFileSync(join(root, 'skills', '__pycache__', 'x.pyc'), '\n');
  return root;
}

test('copies the plugin payload into a dest UNDER the source root without throwing', () => {
  const root = makeFakeRoot();
  // The codex case: the destination lives inside SUPERPOWERS_ROOT (the default
  // results/ out-root). Node's cpSync rejects this as dest-under-src; the manual
  // walk must not.
  const dest = join(root, 'evals', 'results', 'run', 'home', 'plugin', 'local');
  try {
    expect(() => stageSuperpowersPlugin(root, dest)).not.toThrow();
    expect(
      readFileSync(join(dest, 'skills', 'brainstorming', 'SKILL.md'), 'utf8'),
    ).toBe('# skill\n');
    expect(existsSync(join(dest, 'hooks', 'session-start'))).toBe(true);
    // The evals subtree (which CONTAINS dest) must never be staged.
    expect(existsSync(join(dest, 'evals'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('excludes top-level evals/ and .claude/ but keeps .claude-plugin/', () => {
  const root = makeFakeRoot();
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  try {
    stageSuperpowersPlugin(root, dest);
    expect(existsSync(join(dest, 'evals'))).toBe(false);
    expect(existsSync(join(dest, '.claude'))).toBe(false);
    expect(existsSync(join(dest, '.claude-plugin', 'plugin.json'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('excludes top-level .worktrees/ — dev worktrees are full checkouts, not plugin payload', () => {
  const root = makeFakeRoot();
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  try {
    stageSuperpowersPlugin(root, dest);
    expect(existsSync(join(dest, '.worktrees'))).toBe(false);
    expect(existsSync(join(dest, 'skills', 'brainstorming', 'SKILL.md'))).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('stages a file symlink as its target contents (self-contained, no links back into root)', () => {
  const root = makeFakeRoot();
  writeFileSync(join(root, 'skills', 'brainstorming', 'REAL.md'), 'real\n');
  symlinkSync('REAL.md', join(root, 'skills', 'brainstorming', 'LINK.md'));
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  try {
    stageSuperpowersPlugin(root, dest);
    expect(
      readFileSync(join(dest, 'skills', 'brainstorming', 'LINK.md'), 'utf8'),
    ).toBe('real\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('skips directory-target and broken symlinks without throwing', () => {
  const root = makeFakeRoot();
  // Directory-target link (the real-world crash: fixtures -> ../fixtures in a
  // stale worktree) and a dangling link.
  symlinkSync('brainstorming', join(root, 'skills', 'dirlink'));
  symlinkSync('no-such-file', join(root, 'skills', 'dangling'));
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  try {
    expect(() => stageSuperpowersPlugin(root, dest)).not.toThrow();
    expect(existsSync(join(dest, 'skills', 'dirlink'))).toBe(false);
    expect(existsSync(join(dest, 'skills', 'dangling'))).toBe(false);
    expect(existsSync(join(dest, 'skills', 'brainstorming', 'SKILL.md'))).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('excludes .git, node_modules, and python caches at any depth', () => {
  const root = makeFakeRoot();
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  try {
    stageSuperpowersPlugin(root, dest);
    expect(existsSync(join(dest, '.git'))).toBe(false);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    // __pycache__ nested under skills/ is dropped, skills/ itself is kept.
    expect(existsSync(join(dest, 'skills', '__pycache__'))).toBe(false);
    expect(existsSync(join(dest, 'skills', 'brainstorming', 'SKILL.md'))).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('keeps a nested (non-top-level) evals/ and .claude/ — only the root ones are cruft', () => {
  const root = makeFakeRoot();
  mkdirSync(join(root, 'skills', 'demo', 'evals'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'evals', 'keep.md'), 'keep\n');
  mkdirSync(join(root, 'skills', 'demo', '.claude'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', '.claude', 'keep.json'), '{}');
  const dest = mkdtempSync(join(tmpdir(), 'dest-'));
  try {
    stageSuperpowersPlugin(root, dest);
    expect(existsSync(join(dest, 'skills', 'demo', 'evals', 'keep.md'))).toBe(
      true,
    );
    expect(
      existsSync(join(dest, 'skills', 'demo', '.claude', 'keep.json')),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
