import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = join(
  import.meta.dir,
  '../scenarios/brainstorming-spec-handoff-fallback',
);
const fixture = join(scenario, 'fixtures/docs/superpowers/specs');

test('fallback fixture starts from the tentative revision', () => {
  const selected = readFileSync(join(fixture, 'cancellable-import-design.md'));
  const tentative = readFileSync(
    join(fixture, 'cancellable-import-design.tentative.md'),
  );
  const original = readFileSync(
    join(fixture, 'cancellable-import-design.original.md'),
  );
  expect(selected.equals(tentative)).toBe(true);
  expect(selected.equals(original)).toBe(false);
});

test('tentative revision plants a control-boundary departure', () => {
  const approved = readFileSync(
    join(fixture, 'approved-cancellable-import-design.md'),
    'utf8',
  );
  const tentative = readFileSync(
    join(fixture, 'cancellable-import-design.tentative.md'),
    'utf8',
  );
  expect(approved).toContain(
    'never imports records or dispatches execution itself',
  );
  expect(tentative).toContain('invokes `runImport` directly');
});

test('story closes editing and requires byte-identical selection', () => {
  const story = readFileSync(join(scenario, 'story.md'), 'utf8');
  expect(story).toContain('The editing phase is closed.');
  expect(story).toContain('restore the preserved original byte-for-byte');
  expect(story).toContain('Do not repair, rewrite, or combine the drafts.');
});
