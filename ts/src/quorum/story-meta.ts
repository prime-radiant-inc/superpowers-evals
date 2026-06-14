/**
 * Quorum-level overrides read from a scenario's story.md frontmatter.
 *
 * Mirrors quorum/story_meta.py — quorum orchestration hints only, not gauntlet
 * card fields. The `quorum_` prefix makes ownership explicit.
 */

import * as fs from "fs";

// Frontmatter is the block between the leading `---` fences. Mirrors gauntlet's
// own lenient splitFrontmatter — s flag is the JS equivalent of Python re.DOTALL.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

// A gauntlet duration: bare integer (seconds) or integer with ms/s/m/h suffix.
const DURATION = /^\d+(ms|s|m|h)?$/;

// Valid values for the quorum_tier field.
const VALID_TIERS = ["sentinel", "full", "adhoc"] as const;

export class StoryMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryMetaError";
  }
}

function frontmatterField(text: string, key: string): string | undefined {
  const m = FRONTMATTER.exec(text);
  if (!m) return undefined;
  const block = m[1] ?? "";
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const k = line.slice(0, colonIdx).trim();
    const v = line.slice(colonIdx + 1).trim();
    if (k === key) {
      return v.replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/**
 * Return the `quorum_max_time` override from story.md frontmatter, or undefined.
 *
 * Strict-override semantics: when present, the caller uses this in place of
 * the coding-agent default. The value is a gauntlet duration string (e.g.
 * "90m", "600s", or bare "1800" seconds). Raises StoryMetaError on a malformed
 * value.
 */
export function readQuorumMaxTime(storyPath: string): string | undefined {
  const text = fs.readFileSync(storyPath, "utf-8");
  const value = frontmatterField(text, "quorum_max_time");
  if (value === undefined) return undefined;
  if (!DURATION.test(value)) {
    throw new StoryMetaError(
      `${storyPath}: quorum_max_time=${JSON.stringify(value)} is not a valid ` +
        `duration (expected like 90m, 600s, or bare seconds 1800)`
    );
  }
  return value;
}

/**
 * Return the `quorum_tier` from story.md frontmatter, defaulting to "full".
 *
 * Valid values: "sentinel", "full", "adhoc". Raises StoryMetaError on an
 * unknown value.
 */
export function readQuorumTier(storyPath: string): string {
  const text = fs.readFileSync(storyPath, "utf-8");
  const value = frontmatterField(text, "quorum_tier");
  if (value === undefined) return "full";
  if (!(VALID_TIERS as readonly string[]).includes(value)) {
    throw new StoryMetaError(
      `${storyPath}: quorum_tier=${JSON.stringify(value)} is not valid ` +
        `(expected one of: ${VALID_TIERS.join(", ")})`
    );
  }
  return value;
}

/**
 * Return the `status` from story.md frontmatter, defaulting to "ready".
 */
export function readStoryStatus(storyPath: string): string {
  const text = fs.readFileSync(storyPath, "utf-8");
  const value = frontmatterField(text, "status");
  return value !== undefined ? value : "ready";
}
