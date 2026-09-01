// quorum check's arm/suite validation (parent Testing: "quorum check
// validates arm and suite files including profile parameters"). Discovery:
// arms/ and suites/ at the repo root (parent Concepts examples); missing
// dirs are tolerated — v1 ships no documents yet. Scenario frontmatter is
// validated separately over the complete inventory (scenario-meta-check.ts),
// never keyed off suite references.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import { type Arm, ArmSchema } from '../contracts/campaign/arm.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { type Suite, SuiteSchema } from '../contracts/campaign/suite.ts';
import {
  type Credential,
  parseCredentialsFile,
} from '../contracts/credential.ts';

export interface ArmSuiteCheckOptions {
  readonly repoRoot: string;
  readonly codingAgentsDir: string;
  readonly credentialsPath: string;
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

  // The credential registry, when it loads. A missing or unparseable
  // registry is checkCredentials' diagnosis (quorum check reports it once,
  // with the parse detail) — re-reporting the parse error here would
  // duplicate it, and checking arms against an empty registry would cascade
  // one credential-not-found error per arm. Skip credential cross-references
  // and say so with a single marker instead.
  let credentials: Record<string, Credential> | undefined;
  if (existsSync(opts.credentialsPath)) {
    try {
      credentials = parseCredentialsFile(
        parseYaml(readFileSync(opts.credentialsPath, 'utf8')),
      );
    } catch {
      credentials = undefined;
    }
  }

  const armNames = new Set<string>();
  const armFiles = yamlFiles(join(opts.repoRoot, 'arms'));
  for (const file of armFiles) {
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
    let agentConfig:
      | ReturnType<typeof loadAgentConfigForValidation>
      | undefined;
    try {
      agentConfig = loadAgentConfigForValidation(
        opts.codingAgentsDir,
        arm.agent,
      );
    } catch {
      errors.push(
        `arms/${file}: agent '${arm.agent}' has no coding-agents/${arm.agent}.yaml`,
      );
    }
    if (credentials !== undefined) {
      const credential = credentials[arm.credential];
      if (credential === undefined) {
        errors.push(
          `arms/${file}: credential '${arm.credential}' not in credentials.yaml`,
        );
      } else if (agentConfig !== undefined) {
        // Harness compatibility for EVERY explicit arm credential — the
        // same family predicate checkCredentials applies to agent defaults.
        const family = agentRuntimeFamily(agentConfig);
        if (!credential.harnesses.includes(family)) {
          errors.push(
            `arms/${file}: credential '${arm.credential}' does not list harness '${family}'`,
          );
        }
      }
    }
  }
  if (credentials === undefined && armFiles.length > 0) {
    errors.push(
      'arms/: credentials.yaml missing or invalid; arm credential references not checked',
    );
  }

  for (const file of yamlFiles(join(opts.repoRoot, 'suites'))) {
    const path = join(opts.repoRoot, 'suites', file);
    let suite: Suite;
    try {
      const raw = parseYaml(readFileSync(path, 'utf8')) as Record<
        string,
        unknown
      >;
      // Registration's grader intake, mirrored: the grader block is
      // extracted BEFORE the strict SuiteSchema parse and cross-referenced
      // below (R-REG-20 singular grader). The check accepts exactly what
      // registration accepts — a suite without grader is unregistrable,
      // and a suite with grader must not trip the strict unrecognized-key
      // rule.
      const graderRaw =
        raw !== null && typeof raw === 'object'
          ? (raw['grader'] as
              | { credential?: unknown; model?: unknown }
              | undefined)
          : undefined;
      if (
        graderRaw === undefined ||
        typeof graderRaw !== 'object' ||
        typeof graderRaw.credential !== 'string' ||
        typeof graderRaw.model !== 'string'
      ) {
        errors.push(
          `suites/${file}: suite must declare grader: { credential, model } — the campaign grader is registered singular (R-REG-20)`,
        );
      }
      const { grader: _stripped, ...suiteFields } = raw ?? {};
      suite = SuiteSchema.parse(suiteFields);
      if (
        credentials !== undefined &&
        graderRaw !== undefined &&
        typeof graderRaw === 'object' &&
        typeof graderRaw.credential === 'string'
      ) {
        const graderCredential = credentials[graderRaw.credential];
        if (graderCredential === undefined) {
          errors.push(
            `suites/${file}: grader credential '${graderRaw.credential}' not in credentials.yaml`,
          );
        }
        // R-REG-15 (api-key-only gating grader) was rescinded by owner
        // ruling 2026-09-01 — registration accepts any registered grader
        // credential, so the check does too.
      }
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
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
