import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = join(
  import.meta.dir,
  '../scenarios/brainstorming-spec-handoff-cancel',
);

test('workflow actor does not score the artifact', () => {
  const story = readFileSync(join(scenario, 'story.md'), 'utf8');
  expect(story).not.toContain('Independent rating contract');
  expect(story).not.toContain('HANDOFF_READINESS_SCORE');
  expect(story).toContain(
    'Artifact quality is evaluated later by a separate blind judge',
  );
});

test('workflow actor does not require producer review diagnostics', () => {
  const story = readFileSync(join(scenario, 'story.md'), 'utf8');
  for (const field of [
    'INITIAL_RATING:',
    'INITIAL_BURDENS:',
    'FINAL_RATING:',
    'FINAL_BURDENS:',
    'NEW_MAJOR_BURDENS:',
    'CONTRADICTIONS:',
    'DESIGN_DRIFT:',
    'DECISION:',
  ]) {
    expect(story).not.toContain(field);
  }
  expect(story).toContain('Do not grade the format of its private self-review');
});

test('blind judge reports burden without readiness scores or treatment labels', () => {
  const judge = readFileSync(join(scenario, 'pairwise-judge.md'), 'utf8');
  expect(judge).toContain('A_UNIQUE_MAJOR_BURDENS:');
  expect(judge).toContain('B_UNIQUE_MINOR_BURDENS:');
  expect(judge).not.toContain('A_SCORE:');
  expect(judge).not.toContain('final artifact');
});
