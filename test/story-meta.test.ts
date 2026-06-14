import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readQuorumMaxTime,
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
