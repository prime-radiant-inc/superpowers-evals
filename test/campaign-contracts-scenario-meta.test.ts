import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ScenarioMetaSchema,
  scanCouplingDefault,
} from '../src/contracts/campaign/scenario-meta.ts';
import {
  readCoupling,
  readRequiresSuperpowers,
  StoryMetaError,
} from '../src/story-meta.ts';

function scenario(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-meta-'));
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

test('frontmatter readers: requires_superpowers and coupling', () => {
  const dir = scenario({
    'story.md':
      '---\nrequires_superpowers: true\ncoupling: pins-skill-names\n---\nBody.',
  });
  expect(readRequiresSuperpowers(join(dir, 'story.md'))).toBe(true);
  expect(readCoupling(join(dir, 'story.md'))).toBe('pins-skill-names');
});

test('absent frontmatter yields null (scan defaults apply downstream)', () => {
  const dir = scenario({ 'story.md': 'No frontmatter here.' });
  expect(readRequiresSuperpowers(join(dir, 'story.md'))).toBeNull();
  expect(readCoupling(join(dir, 'story.md'))).toBeNull();
});

test('malformed values throw StoryMetaError', () => {
  const dir = scenario({
    'story.md':
      '---\nrequires_superpowers: maybe\ncoupling: sideways\n---\nBody.',
  });
  expect(() => readRequiresSuperpowers(join(dir, 'story.md'))).toThrow(
    StoryMetaError,
  );
  expect(() => readCoupling(join(dir, 'story.md'))).toThrow(StoryMetaError);
});

test('scan: skill path shapes pin skill names', () => {
  const dir = scenario({
    'story.md': 'Use skills/test-driven-development/SKILL.md discipline.',
    'checks.sh': 'pre() { :; }',
  });
  expect(scanCouplingDefault(dir)).toBe('pins-skill-names');
  const superpowersRef = scenario({
    'story.md': 'Invoke superpowers:brainstorming before coding.',
    'checks.sh': 'pre() { :; }',
  });
  expect(scanCouplingDefault(superpowersRef)).toBe('pins-skill-names');
});

test('scan: skill-shaped fixture files embed skill fixtures', () => {
  const dir = scenario({
    'story.md': 'Plain story.',
    'checks.sh': 'pre() { :; }',
    'fixtures/skills/writing-plans/plan.md': 'fixture body',
  });
  mkdirSync(join(dir, 'fixtures/skills/writing-plans'), { recursive: true });
  writeFileSync(
    join(dir, 'fixtures/skills/writing-plans/plan.md'),
    'fixture body',
  );
  expect(scanCouplingDefault(dir)).toBe('embeds-skill-fixtures');
});

test('scan: neither signal is arm-independent', () => {
  const dir = scenario({
    'story.md': 'Plain story.',
    'setup.sh': '#!/usr/bin/env bash\n:\n',
    'checks.sh': 'pre() { :; }',
  });
  chmodSync(join(dir, 'setup.sh'), 0o755);
  expect(scanCouplingDefault(dir)).toBe('arm-independent');
});

test('the schema validates the resolved pair', () => {
  expect(
    ScenarioMetaSchema.parse({
      requires_superpowers: false,
      coupling: 'arm-independent',
    }),
  ).toBeTruthy();
  expect(() =>
    ScenarioMetaSchema.parse({ requires_superpowers: false, coupling: 'nope' }),
  ).toThrow();
});
