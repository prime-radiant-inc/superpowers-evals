import { expect, test } from 'bun:test';
import { ArmSchema } from '../src/contracts/campaign/arm.ts';
import { SuiteSchema as ExperimentSuiteSchema } from '../src/contracts/campaign/suite.ts';

const ARM = {
  schema_version: 1,
  name: 'claude_superpowers',
  agent: 'claude',
  credential: 'opus_bedrock',
  superpowers: 'v6.1.0',
} as const;

test('an arm document round-trips', () => {
  expect(ArmSchema.parse(ARM)).toEqual(ARM);
  const full = { ...ARM, os: 'linux', labels: { role: 'baseline' } };
  expect(ArmSchema.parse(full)).toEqual(full);
});

test('arm names match the credential-name discipline', () => {
  expect(() =>
    ArmSchema.parse({ ...ARM, name: 'Claude-Superpowers' }),
  ).toThrow();
});

test('arm superpowers accepts none, tags, and full SHAs', () => {
  expect(ArmSchema.parse({ ...ARM, superpowers: 'none' }).superpowers).toBe(
    'none',
  );
  expect(
    ArmSchema.parse({ ...ARM, superpowers: 'a'.repeat(40) }).superpowers,
  ).toBe('a'.repeat(40));
  expect(() => ArmSchema.parse({ ...ARM, superpowers: '' })).toThrow();
});

test('arm documents are strict (unknown keys reject)', () => {
  expect(() => ArmSchema.parse({ ...ARM, model: 'claude-opus-5' })).toThrow();
});

test('V2 suite requires finite attempt and exposure bounds', () => {
  const base = {
    schema_version: 2 as const,
    name: 'finite_suite',
    comparisons: [
      {
        baseline: 'baseline',
        treatment: 'treatment',
        scenarios: ['scenario'],
        n: 1,
      },
    ],
    reserve: 0,
    max_exposure_skew: 10,
    attempt_bounds: { max_attempts: 1, max_time_s: 60 },
  };

  expect(ExperimentSuiteSchema.parse(base)).toEqual(base);
  expect(() =>
    ExperimentSuiteSchema.parse({ ...base, attempt_bounds: undefined }),
  ).toThrow();
  expect(() =>
    ExperimentSuiteSchema.parse({
      ...base,
      attempt_bounds: { max_attempts: 1, max_time_s: Number.POSITIVE_INFINITY },
    }),
  ).toThrow();
  expect(() =>
    ExperimentSuiteSchema.parse({ ...base, max_exposure_skew: Number.NaN }),
  ).toThrow();
});

test('V2 suite rejects removed budget and profile fields', () => {
  const base = {
    schema_version: 2 as const,
    name: 'finite_suite',
    comparisons: [
      {
        arm: 'baseline',
        scenarios: ['scenario'],
        n: 1,
      },
    ],
    reserve: 0,
    max_exposure_skew: 10,
    attempt_bounds: { max_attempts: 1, max_time_s: 60 },
  };
  expect(() =>
    ExperimentSuiteSchema.parse({ ...base, budget_usd: 100 }),
  ).toThrow();
  expect(() =>
    ExperimentSuiteSchema.parse({ ...base, profile: 'descriptive_v1' }),
  ).toThrow();
});
