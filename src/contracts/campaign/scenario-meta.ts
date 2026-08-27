import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const COUPLING_CLASSES = [
  'pins-skill-names',
  'embeds-skill-fixtures',
  'arm-independent',
] as const;

export const ScenarioMetaSchema = z
  .object({
    requires_superpowers: z.boolean(),
    coupling: z.enum(COUPLING_CLASSES),
  })
  .strict();
export type ScenarioMeta = z.infer<typeof ScenarioMetaSchema>;

// Path-shaped heuristics (pinned): no skill inventory, no SUPERPOWERS_ROOT —
// quorum check must not need either. Conservative: committed frontmatter
// always wins over the scan.
const SKILL_REF_RE =
  /skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md|superpowers:[a-z0-9][a-z0-9-]*/;
const SKILL_FIXTURE_RE = /^skills$/;

function reads(dir: string, name: string): string {
  const path = join(dir, name);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/** Default coupling class from a scenario's CONTENT: skill-shaped references
 *  in the concatenated story+setup+checks text pin skill names; a
 *  skill-shaped fixture subtree embeds skill fixtures; neither is
 *  arm-independent. */
export function couplingDefaultFrom(
  text: string,
  hasSkillsFixtures: boolean,
): (typeof COUPLING_CLASSES)[number] {
  if (SKILL_REF_RE.test(text)) return 'pins-skill-names';
  if (hasSkillsFixtures) return 'embeds-skill-fixtures';
  return 'arm-independent';
}

/** {@link couplingDefaultFrom} over a scenario dir on disk. */
export function scanCouplingDefault(
  scenarioDir: string,
): (typeof COUPLING_CLASSES)[number] {
  const text =
    reads(scenarioDir, 'story.md') +
    reads(scenarioDir, 'setup.sh') +
    reads(scenarioDir, 'checks.sh');

  let hasSkillsFixtures = false;
  const fixturesDir = join(scenarioDir, 'fixtures');
  if (existsSync(fixturesDir) && statSync(fixturesDir).isDirectory()) {
    for (const entry of readdirSync(fixturesDir)) {
      if (
        SKILL_FIXTURE_RE.test(entry) &&
        statSync(join(fixturesDir, entry)).isDirectory()
      ) {
        hasSkillsFixtures = true;
      }
    }
  }
  return couplingDefaultFrom(text, hasSkillsFixtures);
}
