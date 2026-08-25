// test/campaign-contracts-scenario-meta-check.test.ts
// quorum check's unconditional per-scenario frontmatter validation: malformed
// requires_superpowers/coupling are problems for EVERY scenario in the
// inventory (not only suite-referenced ones); explicit overrides that
// contradict the static scan default warn. No skill inventory and no
// SUPERPOWERS_ROOT are ever needed.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkScenarioMeta } from '../src/campaign/scenario-meta-check.ts';

function scenario(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-meta-check-'));
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

test('malformed frontmatter values are problems, not silently swallowed', () => {
  const dir = scenario({
    'story.md':
      '---\nrequires_superpowers: maybe\ncoupling: sideways\n---\nBody.',
  });
  const { problems, warnings } = checkScenarioMeta(dir, 'scn_bad');
  expect(problems.join('\n')).toMatch(/invalid requires_superpowers: maybe/);
  expect(problems.join('\n')).toMatch(/invalid coupling: sideways/);
  expect(warnings).toEqual([]);
});

test('declared coupling contradicting the scan default warns', () => {
  const dir = scenario({
    'story.md':
      '---\ncoupling: pins-skill-names\n---\nPlain story with no skill refs.',
    'checks.sh': 'pre() { :; }\npost() { :; }\n',
  });
  const { problems, warnings } = checkScenarioMeta(dir, 'scn_a');
  expect(problems).toEqual([]);
  expect(warnings.join('\n')).toMatch(
    /scn_a.*declared coupling 'pins-skill-names' contradicts/,
  );
});

test('declared requires_superpowers contradicting the scan default warns', () => {
  const dir = scenario({
    'story.md':
      '---\nrequires_superpowers: false\n---\nStory citing skills/writing-plans/SKILL.md.',
    'checks.sh': 'pre() { :; }\npost() { :; }\n',
  });
  const { problems, warnings } = checkScenarioMeta(dir, 'scn_b');
  expect(problems).toEqual([]);
  expect(warnings.join('\n')).toMatch(
    /scn_b.*declared requires_superpowers false contradicts/,
  );
});

test('consistent declarations and absent frontmatter produce no findings', () => {
  const consistent = scenario({
    'story.md':
      '---\nrequires_superpowers: true\ncoupling: pins-skill-names\n---\nUse superpowers:brainstorming first.',
    'checks.sh': 'pre() { :; }\npost() { :; }\n',
  });
  expect(checkScenarioMeta(consistent, 'scn_c')).toEqual({
    problems: [],
    warnings: [],
  });
  const bare = scenario({
    'story.md': 'No frontmatter at all.',
    'checks.sh': 'pre() { :; }\npost() { :; }\n',
  });
  expect(checkScenarioMeta(bare, 'scn_d')).toEqual({
    problems: [],
    warnings: [],
  });
});

test('a missing story.md yields no meta findings (structural check owns it)', () => {
  const dir = scenario({ 'checks.sh': 'pre() { :; }\npost() { :; }\n' });
  expect(checkScenarioMeta(dir, 'scn_e')).toEqual({
    problems: [],
    warnings: [],
  });
});
