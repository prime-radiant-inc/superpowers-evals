import { type Arm, ArmSchema } from '../contracts/campaign/arm.ts';
import {
  PairingSchema,
  ResolvedComparisonInputSchema,
} from '../contracts/campaign/experiment.ts';
import { type Suite, SuiteSchema } from '../contracts/campaign/suite.ts';
import type { EffortLevel } from '../contracts/effort.ts';

export { ComparisonInputSchema } from '../contracts/campaign/experiment.ts';

import { RegistrationError } from './registration.ts';

export type PairingInput = {
  agent: string;
  credential: string;
  effort?: EffortLevel;
};
export type ComparisonInput = {
  baseline: string;
  candidate: string;
  pairs: PairingInput[];
  baselineLabel?: string;
  candidateLabel?: string;
};
export type ResolvedComparisonInput = {
  baseline: { label: string; sha: string };
  candidate: { label: string; sha: string };
  pairs: PairingInput[];
};

export function parsePairing(value: string): PairingInput {
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3)
    throw new RegistrationError('pair must be agent:credential[:effort]');
  return PairingSchema.parse({
    agent: parts[0],
    credential: parts[1],
    ...(parts.length === 3 ? { effort: parts[2] } : {}),
  });
}

export function materializeComparison(
  suite: Suite,
  input: ResolvedComparisonInput,
): { suite: Suite; arms: Record<string, Arm> } {
  const resolved = ResolvedComparisonInputSchema.parse(input);
  const arms: Record<string, Arm> = {};
  const comparisons: Suite['comparisons'] = [];
  resolved.pairs.forEach((pair, i) => {
    const baseline = `p${i + 1}_baseline`,
      treatment = `p${i + 1}_candidate`;
    arms[baseline] = ArmSchema.parse({
      schema_version: 1,
      name: baseline,
      ...pair,
      superpowers: resolved.baseline.sha,
    });
    arms[treatment] = ArmSchema.parse({
      schema_version: 1,
      name: treatment,
      ...pair,
      superpowers: resolved.candidate.sha,
    });
    for (const comparison of suite.comparisons) {
      if (
        !('baseline' in comparison) ||
        comparison.baseline !== 'baseline' ||
        comparison.treatment !== 'candidate'
      )
        throw new RegistrationError(
          'runtime comparison requires baseline/candidate template roles',
        );
      comparisons.push({ ...comparison, baseline, treatment });
    }
  });
  return { suite: SuiteSchema.parse({ ...suite, comparisons }), arms };
}
