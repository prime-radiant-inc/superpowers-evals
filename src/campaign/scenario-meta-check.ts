// quorum check's per-scenario campaign-frontmatter validation, run over the
// COMPLETE scenario inventory (not only scenarios referenced by suites):
// malformed requires_superpowers/coupling values are problems (they would
// break every runtime reader); explicit overrides contradicting the static
// scan default are warnings (committed frontmatter always wins, but the
// contradiction is worth an operator's eye). The scan is path-shaped only —
// no skill inventory and no SUPERPOWERS_ROOT.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scanCouplingDefault } from '../contracts/campaign/scenario-meta.ts';
import {
  type CouplingValue,
  readCoupling,
  readRequiresSuperpowers,
  StoryMetaError,
} from '../story-meta.ts';

export interface ScenarioMetaFindings {
  readonly problems: string[];
  readonly warnings: string[];
}

export function checkScenarioMeta(
  scenarioDir: string,
  scenarioName: string,
): ScenarioMetaFindings {
  const problems: string[] = [];
  const warnings: string[] = [];
  const storyPath = join(scenarioDir, 'story.md');
  // A missing story.md is checkScenario's structural problem, not a meta one.
  if (!existsSync(storyPath)) return { problems, warnings };

  let declaredRequires: boolean | null = null;
  let declaredCoupling: CouplingValue | null = null;
  try {
    declaredRequires = readRequiresSuperpowers(storyPath);
  } catch (err) {
    if (!(err instanceof StoryMetaError)) throw err;
    problems.push(`story.md ${err.message}`);
  }
  try {
    declaredCoupling = readCoupling(storyPath);
  } catch (err) {
    if (!(err instanceof StoryMetaError)) throw err;
    problems.push(`story.md ${err.message}`);
  }

  const scanDefault = scanCouplingDefault(scenarioDir);
  if (declaredCoupling !== null && declaredCoupling !== scanDefault) {
    warnings.push(
      `scenarios/${scenarioName}: declared coupling '${declaredCoupling}' contradicts the static scan default`,
    );
  }
  // Skill references or embedded skill fixtures imply the scenario needs
  // superpowers; only arm-independent scans read as false.
  const scanRequires = scanDefault !== 'arm-independent';
  if (declaredRequires !== null && declaredRequires !== scanRequires) {
    warnings.push(
      `scenarios/${scenarioName}: declared requires_superpowers ${declaredRequires} contradicts the static scan default`,
    );
  }
  return { problems, warnings };
}
