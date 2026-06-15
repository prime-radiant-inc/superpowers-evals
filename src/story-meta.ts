import { readFileSync } from 'node:fs';
import { pySplitlines } from './scaffold.ts';

/** Raised when a story's frontmatter holds a value that fails validation. */
export class StoryMetaError extends Error {}

/** Strip every leading/trailing occurrence of `ch`. */
function stripChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/**
 * Lenient frontmatter parse (not full YAML): match a leading `---\n...\n---\n`
 * block (the closing fence must be followed by a newline), split the body into
 * lines on the full Unicode line-boundary set (so a bare `\r` separating two
 * fields keeps both visible), split each line on its first `:`, then strip
 * whitespace and greedily strip ALL surrounding double quotes followed by ALL
 * surrounding single quotes. Missing or malformed frontmatter yields an empty
 * map rather than an error.
 */
function frontmatter(storyPath: string): Map<string, string> {
  const text = readFileSync(storyPath, 'utf8');
  const body = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  const out = new Map<string, string>();
  if (body === undefined) return out;
  for (const line of pySplitlines(body)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = stripChar(stripChar(line.slice(i + 1).trim(), '"'), "'");
    if (key) out.set(key, val);
  }
  return out;
}

/**
 * The story's `quorum_max_time` (e.g. `90m`, `30s`, `120`), or `null` when the
 * frontmatter omits it. Throws {@link StoryMetaError} on a malformed value.
 */
export function readQuorumMaxTime(storyPath: string): string | null {
  const v = frontmatter(storyPath).get('quorum_max_time');
  if (v === undefined) return null;
  if (!/^\d+(ms|s|m|h)?$/.test(v)) {
    throw new StoryMetaError(`invalid quorum_max_time: ${v}`);
  }
  return v;
}

/**
 * The story's `quorum_tier`, defaulting to `full`. Throws
 * {@link StoryMetaError} on any value outside the closed set.
 */
export function readQuorumTier(
  storyPath: string,
): 'sentinel' | 'full' | 'adhoc' {
  const v = frontmatter(storyPath).get('quorum_tier') ?? 'full';
  if (v !== 'sentinel' && v !== 'full' && v !== 'adhoc') {
    throw new StoryMetaError(`invalid quorum_tier: ${v}`);
  }
  return v;
}

/** The story's `status`, defaulting to `ready`. */
export function readStoryStatus(storyPath: string): string {
  return frontmatter(storyPath).get('status') ?? 'ready';
}
