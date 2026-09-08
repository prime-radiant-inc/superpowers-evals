import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const arms = [
  'writing-plans-source-identity-a',
  'writing-plans-source-identity-b',
] as const;

function read(arm: string, path: string): string {
  return readFileSync(join(root, 'scenarios', arm, path), 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('planner arms freeze the eligible anonymous spec pair', () => {
  expect(
    sha256(
      read(
        arms[0],
        'fixtures/docs/superpowers/specs/cancellable-import-design.md',
      ),
    ),
  ).toBe('9c51a10ba8af6fe33541d5d0e4d13de47bd667ef4c2a68d3e6fd1b53984b5bea');
  expect(
    sha256(
      read(
        arms[1],
        'fixtures/docs/superpowers/specs/cancellable-import-design.md',
      ),
    ),
  ).toBe('e8b9bfbde62eb98dd0109d8c1d5195bc5e97eccd9a59e45975ac1c90bb60b482');
});

test('planner arms differ only in the frozen spec', () => {
  for (const path of [
    'story.md',
    'checks.sh',
    'checks-manifest.json',
    'codex.config.toml',
  ]) {
    expect(read(arms[0], path)).toBe(read(arms[1], path));
  }
  expect(read(arms[0], 'fixtures/README.md')).toBe(
    read(arms[1], 'fixtures/README.md'),
  );
  expect(read(arms[0], 'fixtures/src/import-store.js')).toBe(
    read(arms[1], 'fixtures/src/import-store.js'),
  );
});

test('planner prompt requests an implementation plan and forbids implementation', () => {
  const story = read(arms[0], 'story.md');
  expect(story).toContain('write the executable implementation plan');
  expect(story).toMatch(/Do not\s+implement the feature/);
  expect(story).not.toContain('untreated');
  expect(story).not.toContain('treated');
});

test('planner completion does not invent a commit requirement', () => {
  const checks = read(arms[0], 'checks.sh');
  expect(checks).toContain('file-exists docs/superpowers/plans');
  expect(checks).not.toContain('git-count');
  expect(checks).not.toContain('git-clean');
});

test('actor may not interrupt an actively working planner', () => {
  const story = read(arms[0], 'story.md');
  expect(story).toMatch(/Do not\s+interrupt or exit an active Coding-Agent/);
  expect(story).toContain('35-minute scenario limit');
});

test('workflow checks do not rely on the legacy skill-call detector', () => {
  const checks = read(arms[0], 'checks.sh');
  expect(checks).not.toContain('check-transcript skill-called');
});

test('actor does not confuse standard execution choices with a planning gate', () => {
  const story = read(arms[0], 'story.md');
  expect(story).toContain(
    'Standard execution choices required by `writing-plans` are permitted',
  );
  expect(story).toMatch(/must not\s+affect the workflow verdict/);
});
