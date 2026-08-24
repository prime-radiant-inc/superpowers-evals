import { expect, test } from 'bun:test';
import { ArmSchema } from '../src/contracts/campaign/arm.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';

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

function twoArmSuite(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    name: 'harness_compare',
    kind: 'exploratory',
    budget_usd: 150,
    comparisons: [
      {
        baseline: 'claude_superpowers',
        treatment: 'codex_superpowers',
        scenarios: ['sdd-escalates', 'fractals-smoke'],
        n: 5,
        cells: { 'sdd-escalates': { n: 10, class: 'confirmatory' } },
      },
    ],
    ...overrides,
  };
}

test('a two-arm suite round-trips', () => {
  expect(SuiteSchema.parse(twoArmSuite())).toMatchObject({
    name: 'harness_compare',
  });
});

test('a single-arm suite round-trips', () => {
  const suite = twoArmSuite({
    comparisons: [{ arm: 'claude_stock', scenarios: ['fractals-smoke'], n: 2 }],
  });
  expect(SuiteSchema.parse(suite).comparisons[0]).toMatchObject({
    arm: 'claude_stock',
  });
});

test('the tier selector grammar is admitted; no other selector syntax', () => {
  expect(
    SuiteSchema.parse(
      twoArmSuite({
        comparisons: [
          { baseline: 'a', treatment: 'b', scenarios: 'tier=sentinel', n: 1 },
        ],
      }),
    ).comparisons[0],
  ).toMatchObject({ scenarios: 'tier=sentinel' });
  expect(() =>
    SuiteSchema.parse(
      twoArmSuite({
        comparisons: [
          { baseline: 'a', treatment: 'b', scenarios: 'glob=sdd-*', n: 1 },
        ],
      }),
    ),
  ).toThrow();
  expect(() =>
    SuiteSchema.parse(
      twoArmSuite({
        comparisons: [{ baseline: 'a', treatment: 'b', scenarios: [], n: 1 }],
      }),
    ),
  ).toThrow();
});

test('cell classes are the closed 08-08 vocabulary', () => {
  const suite = twoArmSuite({
    comparisons: [
      {
        baseline: 'a',
        treatment: 'b',
        scenarios: ['s'],
        n: 1,
        cells: { s: { class: 'bogus' } },
      },
    ],
  });
  expect(() => SuiteSchema.parse(suite)).toThrow();
});

test('gating tripwire cells must declare tripwire_expect', () => {
  const gating = twoArmSuite({
    kind: 'gating',
    profile: 'release_gate_v1',
    reserve: 1,
    max_exposure_skew: 600,
    comparisons: [
      {
        baseline: 'a',
        treatment: 'b',
        scenarios: ['s'],
        n: 1,
        cells: { s: { class: 'tripwire' } },
      },
    ],
  });
  expect(() => SuiteSchema.parse(gating)).toThrow(/tripwire_expect/);
  const fixed = {
    ...gating,
    comparisons: [
      {
        ...gating.comparisons[0],
        cells: { s: { class: 'tripwire', tripwire_expect: 'fail' } },
      },
    ],
  };
  expect(SuiteSchema.parse(fixed)).toMatchObject({ kind: 'gating' });
});

test('gating suites require profile, reserve, and max_exposure_skew', () => {
  const gating = twoArmSuite({ kind: 'gating' });
  expect(() => SuiteSchema.parse(gating)).toThrow();
});

test('exploratory suites may carry reserve (optional, never rejected)', () => {
  expect(SuiteSchema.parse(twoArmSuite({ reserve: 2 }))).toMatchObject({
    reserve: 2,
  });
});

test('suites are strict and need at least one comparison', () => {
  expect(() => SuiteSchema.parse(twoArmSuite({ comparisons: [] }))).toThrow();
  expect(() => SuiteSchema.parse(twoArmSuite({ rigor: 'high' }))).toThrow();
});
