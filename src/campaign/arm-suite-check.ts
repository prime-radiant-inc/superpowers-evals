// quorum check's arm/suite validation (parent Testing: "quorum check
// validates arm and suite files including profile parameters"). Discovery:
// arms/ and suites/ at the repo root (parent Concepts examples); missing
// dirs are tolerated — v1 ships no documents yet.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgentConfigForValidation } from '../contracts/agent-config.ts';
import { type Arm, ArmSchema } from '../contracts/campaign/arm.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { scanCouplingDefault } from '../contracts/campaign/scenario-meta.ts';
import { type Suite, SuiteSchema } from '../contracts/campaign/suite.ts';
import { parseCredentialsFile } from '../contracts/credential.ts';
import {
  type CouplingValue,
  readCoupling,
  readRequiresSuperpowers,
} from '../story-meta.ts';

export interface ArmSuiteCheckOptions {
  readonly repoRoot: string;
  readonly codingAgentsDir: string;
  readonly credentialsPath: string;
  readonly scenariosRoot: string;
}

export interface ArmSuiteCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();
}

export function checkArmSuiteFiles(
  opts: ArmSuiteCheckOptions,
): ArmSuiteCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const credentialNames = new Set<string>();
  if (existsSync(opts.credentialsPath)) {
    try {
      const parsed = parseCredentialsFile(
        parseYaml(readFileSync(opts.credentialsPath, 'utf8')),
      );
      for (const name of Object.keys(parsed)) credentialNames.add(name);
    } catch (err) {
      errors.push(
        `credentials file error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const armNames = new Set<string>();
  for (const file of yamlFiles(join(opts.repoRoot, 'arms'))) {
    const path = join(opts.repoRoot, 'arms', file);
    let arm: Arm;
    try {
      arm = ArmSchema.parse(parseYaml(readFileSync(path, 'utf8')));
    } catch (err) {
      errors.push(
        `arms/${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    armNames.add(arm.name);
    try {
      loadAgentConfigForValidation(opts.codingAgentsDir, arm.agent);
    } catch {
      errors.push(
        `arms/${file}: agent '${arm.agent}' has no coding-agents/${arm.agent}.yaml`,
      );
    }
    if (!credentialNames.has(arm.credential)) {
      errors.push(
        `arms/${file}: credential '${arm.credential}' not in credentials.yaml`,
      );
    }
  }

  for (const file of yamlFiles(join(opts.repoRoot, 'suites'))) {
    const path = join(opts.repoRoot, 'suites', file);
    let suite: Suite;
    try {
      suite = SuiteSchema.parse(parseYaml(readFileSync(path, 'utf8')));
    } catch (err) {
      errors.push(
        `suites/${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (suite.profile !== undefined) {
      const schema = profileParamsSchema(suite.profile);
      if (schema === undefined) {
        errors.push(`suites/${file}: unknown profile '${suite.profile}'`);
      } else {
        // Omitted profile_params parse as {} so required release_gate_v1
        // fields (alpha, floors, deltas) cannot be skipped by omission.
        const result = schema.safeParse(suite.profile_params ?? {});
        if (!result.success) {
          errors.push(
            `suites/${file}: profile_params for ${suite.profile}: ${result.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          );
        }
      }
    } else if (suite.profile_params !== undefined) {
      errors.push(
        `suites/${file}: profile_params set without a profile (suite.profile is unset)`,
      );
    }
    for (const comparison of suite.comparisons) {
      const refs =
        'arm' in comparison
          ? [comparison.arm]
          : [comparison.baseline, comparison.treatment];
      for (const ref of refs) {
        if (!armNames.has(ref)) {
          errors.push(
            `suites/${file}: comparison references unknown arm '${ref}'`,
          );
        }
      }
      // Frontmatter-vs-scan contradiction warnings for explicit scenario
      // lists (tier selectors expand at registration, D3).
      if (Array.isArray(comparison.scenarios)) {
        for (const scenarioName of comparison.scenarios) {
          const scenarioDir = join(opts.scenariosRoot, scenarioName);
          const storyPath = join(scenarioDir, 'story.md');
          if (!existsSync(storyPath)) continue;
          let declaredCoupling: CouplingValue | null;
          let declaredRequires: boolean | null;
          try {
            declaredCoupling = readCoupling(storyPath);
            declaredRequires = readRequiresSuperpowers(storyPath);
          } catch {
            continue; // malformed frontmatter is scenario validation's job
          }
          const scanDefault = scanCouplingDefault(scenarioDir);
          if (declaredCoupling !== null && declaredCoupling !== scanDefault) {
            warnings.push(
              `scenarios/${scenarioName}: declared coupling '${declaredCoupling}' contradicts the static scan default`,
            );
          }
          // Skill references or embedded skill fixtures imply the scenario
          // needs superpowers; only arm-independent scans read as false.
          const scanRequires = scanDefault !== 'arm-independent';
          if (declaredRequires !== null && declaredRequires !== scanRequires) {
            warnings.push(
              `scenarios/${scenarioName}: declared requires_superpowers ${declaredRequires} contradicts the static scan default`,
            );
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
