import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  quorumModeFromStory,
  readQuorumMaxTime,
  readQuorumMode,
  readQuorumTier,
  readStoryStatus,
  StoryMetaError,
} from '../src/story-meta.ts';

function story(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'story-')), 'story.md');
  writeFileSync(p, body);
  return p;
}

test('reads quorum_max_time, tier, status with quote tolerance + defaults', () => {
  const p = story(
    `---\nquorum_max_time: "90m"\nquorum_tier: sentinel\n---\nbody`,
  );
  expect(readQuorumMaxTime(p)).toBe('90m');
  expect(readQuorumTier(p)).toBe('sentinel');
  expect(readStoryStatus(p)).toBe('ready');
});

test('defaults when frontmatter absent', () => {
  const p = story('no frontmatter here');
  expect(readQuorumMaxTime(p)).toBeNull();
  expect(readQuorumTier(p)).toBe('full');
  expect(readStoryStatus(p)).toBe('ready');
  expect(readQuorumMode(p)).toBe('qa');
});

test('conversation mode is opt-in and rejects every explicit alternative', () => {
  const conversation = '---\nquorum_mode: conversation\n---\nbody';
  expect(quorumModeFromStory(conversation)).toBe('conversation');
  expect(readQuorumMode(story(conversation))).toBe('conversation');
  expect(quorumModeFromStory('body without frontmatter')).toBe('qa');
  expect(() => quorumModeFromStory('---\nquorum_mode: qa\n---\nbody')).toThrow(
    StoryMetaError,
  );
  expect(() =>
    quorumModeFromStory('---\nquorum_mode: unknown\n---\nbody'),
  ).toThrow(StoryMetaError);
});

test('tolerates single quotes and explicit status', () => {
  const p = story(`---\nquorum_max_time: '30s'\nstatus: 'draft'\n---\nbody`);
  expect(readQuorumMaxTime(p)).toBe('30s');
  expect(readStoryStatus(p)).toBe('draft');
});

test('accepts bare numeric max_time without unit', () => {
  const p = story('---\nquorum_max_time: 120\n---\nbody');
  expect(readQuorumMaxTime(p)).toBe('120');
});

test('rejects malformed quorum_max_time', () => {
  const p = story('---\nquorum_max_time: soon\n---\nbody');
  expect(() => readQuorumMaxTime(p)).toThrow(StoryMetaError);
});

test('rejects unknown quorum_tier', () => {
  const p = story('---\nquorum_tier: turbo\n---\nbody');
  expect(() => readQuorumTier(p)).toThrow(StoryMetaError);
});

// K-frontmatter-trailing-newline: Python's regex requires a newline AFTER the
// closing fence (\n---\n). A body-less file ending exactly in '\n---' (no
// trailing newline) must therefore be treated as having NO frontmatter, so
// every field falls to its default.
test('frontmatter-only file with no trailing newline has no frontmatter', () => {
  // Closing fence present but NO trailing newline after it. Python's regex
  // (\n---\n) requires the trailing newline, so it sees NO frontmatter.
  const p = story('---\nquorum_tier: sentinel\nstatus: draft\n---');
  expect(readQuorumTier(p)).toBe('full');
  expect(readStoryStatus(p)).toBe('ready');
  expect(readQuorumMaxTime(p)).toBeNull();
});

test('frontmatter with trailing newline after closing fence parses', () => {
  const p = story('---\nquorum_tier: sentinel\n---\n');
  expect(readQuorumTier(p)).toBe('sentinel');
});

// K-frontmatter-quote-stripping: Python strips ALL surrounding double quotes
// then ALL single quotes (greedy, both types), handling double-double, mixed,
// and mismatched quoting. TS stripped exactly one matched same-char pair.
test('strips greedily: doubled double-quotes', () => {
  const p = story('---\nstatus: ""draft""\n---\nbody');
  expect(readStoryStatus(p)).toBe('draft');
});

test('strips greedily: mixed double-then-single quotes', () => {
  const p = story(`---\nstatus: "'draft'"\n---\nbody`);
  expect(readStoryStatus(p)).toBe('draft');
});

test('strips greedily: mismatched leading/trailing quotes', () => {
  // Python: v.strip().strip('"').strip("'") on `'draft"` => strip('"') removes
  // the trailing ", then strip("'") removes the leading ' => 'draft'.
  const p = story(`---\nstatus: 'draft"\n---\nbody`);
  expect(readStoryStatus(p)).toBe('draft');
});

test('single clean-quoted value behaves identically', () => {
  const p = story(`---\nstatus: "draft"\n---\nbody`);
  expect(readStoryStatus(p)).toBe('draft');
});

// L5: Python's _frontmatter_field iterates group(1).splitlines(), which breaks
// on the full Unicode line-boundary set (bare \r, \v, etc.). A bare carriage
// return between two fields keeps both visible to Python. TS's split('\n')
// only breaks on \n, so the field AFTER a bare \r gets folded into the prior
// line and becomes invisible — readQuorumMaxTime would return null where Python
// returns the value.
test('resolves a field separated from the prior one by a bare carriage return', () => {
  const p = story(
    '---\nquorum_tier: sentinel\rquorum_max_time: 90m\n---\nbody',
  );
  expect(readQuorumMaxTime(p)).toBe('90m');
});
