import { readFileSync } from 'node:fs';

/** Raised when a story's frontmatter holds a value that fails validation. */
export class StoryMetaError extends Error {}

/**
 * Lenient frontmatter parse (not full YAML): match a leading `---\n...\n---`
 * block, split each line on its first `:`, and strip whitespace plus a single
 * pair of surrounding quotes. Missing or malformed frontmatter yields an empty
 * map rather than an error.
 */
function frontmatter(storyPath: string): Map<string, string> {
  const text = readFileSync(storyPath, 'utf8');
  const body = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const out = new Map<string, string>();
  if (body === undefined) return out;
  for (const line of body.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
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
