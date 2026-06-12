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
