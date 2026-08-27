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
function frontmatterOf(text: string): Map<string, string> {
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

function frontmatter(storyPath: string): Map<string, string> {
  return frontmatterOf(readFileSync(storyPath, 'utf8'));
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
 * The story's `quorum_tier` from its TEXT, defaulting to `full`. Throws
 * {@link StoryMetaError} on any value outside the closed set.
 */
export function quorumTierFromStory(
  story: string,
): 'sentinel' | 'full' | 'adhoc' {
  const v = frontmatterOf(story).get('quorum_tier') ?? 'full';
  if (v !== 'sentinel' && v !== 'full' && v !== 'adhoc') {
    throw new StoryMetaError(`invalid quorum_tier: ${v}`);
  }
  return v;
}

/** {@link quorumTierFromStory} over the story file at `storyPath`. */
export function readQuorumTier(
  storyPath: string,
): 'sentinel' | 'full' | 'adhoc' {
  return quorumTierFromStory(readFileSync(storyPath, 'utf8'));
}

/** The story's `status`, defaulting to `ready`. */
export function readStoryStatus(storyPath: string): string {
  return frontmatter(storyPath).get('status') ?? 'ready';
}

/** The story's `requires_superpowers` from its TEXT, or `null` when omitted
 *  (the scan default applies downstream). Throws {@link StoryMetaError}
 *  outside true/false. */
export function requiresSuperpowersFromStory(story: string): boolean | null {
  const v = frontmatterOf(story).get('requires_superpowers');
  if (v === undefined) return null;
  if (v !== 'true' && v !== 'false') {
    throw new StoryMetaError(`invalid requires_superpowers: ${v}`);
  }
  return v === 'true';
}

/** {@link requiresSuperpowersFromStory} over the story file at `storyPath`. */
export function readRequiresSuperpowers(storyPath: string): boolean | null {
  return requiresSuperpowersFromStory(readFileSync(storyPath, 'utf8'));
}

export const COUPLING_VALUES = [
  'pins-skill-names',
  'embeds-skill-fixtures',
  'arm-independent',
] as const;
export type CouplingValue = (typeof COUPLING_VALUES)[number];

/** The story's `coupling` override from its TEXT, or `null` when omitted.
 *  Throws {@link StoryMetaError} outside the closed vocabulary. */
export function couplingFromStory(story: string): CouplingValue | null {
  const v = frontmatterOf(story).get('coupling');
  if (v === undefined) return null;
  if (
    v !== 'pins-skill-names' &&
    v !== 'embeds-skill-fixtures' &&
    v !== 'arm-independent'
  ) {
    throw new StoryMetaError(`invalid coupling: ${v}`);
  }
  return v;
}

/** {@link couplingFromStory} over the story file at `storyPath`. */
export function readCoupling(storyPath: string): CouplingValue | null {
  return couplingFromStory(readFileSync(storyPath, 'utf8'));
}
