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
  return quorumMaxTimeFromStory(readFileSync(storyPath, 'utf8'));
}

export function quorumMaxTimeFromStory(story: string): string | null {
  const v = frontmatterOf(story).get('quorum_max_time');
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

/** The scenario execution mode. Omission preserves the existing QA flow. */
export function quorumModeFromStory(story: string): 'qa' | 'conversation' {
  const v = frontmatterOf(story).get('quorum_mode');
  if (v === undefined) return 'qa';
  if (v !== 'conversation') {
    throw new StoryMetaError(`invalid quorum_mode: ${v}`);
  }
  return v;
}

/** {@link quorumModeFromStory} over the story file at `storyPath`. */
export function readQuorumMode(storyPath: string): 'qa' | 'conversation' {
  return quorumModeFromStory(readFileSync(storyPath, 'utf8'));
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

/** Resolve the role-duration grammar within the process timer's signed 32-bit range. */
export function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new StoryMetaError(`invalid role duration: ${value}`);
  const milliseconds =
    Number(match[1]) *
    ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 's'] ?? 1000);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 2147483647
  )
    throw new StoryMetaError(`invalid role duration: ${value}`);
  return milliseconds;
}

export type AssessmentBudget = { totalMs: number; reportGraceMs: number };

/** Assessment totals include report grace and Gauntlet's 5s publication reserve. */
export function assessmentBudgetFromStory(
  story: string,
): AssessmentBudget | null {
  const fields = frontmatterOf(story);
  const total = fields.get('quorum_assessment_max_time');
  const grace = fields.get('quorum_assessment_report_grace');
  if (quorumModeFromStory(story) === 'qa') {
    if (total !== undefined || grace !== undefined)
      throw new StoryMetaError(
        'assessment budgets require quorum_mode: conversation',
      );
    return null;
  }
  if (total === undefined || grace === undefined)
    throw new StoryMetaError(
      'conversation requires quorum_assessment_max_time and quorum_assessment_report_grace',
    );
  const totalMs = durationMs(total);
  const reportGraceMs = durationMs(grace);
  if (totalMs <= reportGraceMs + 5000)
    throw new StoryMetaError(
      'assessment budget must exceed report grace plus 5000ms publication reserve',
    );
  return { totalMs, reportGraceMs };
}
