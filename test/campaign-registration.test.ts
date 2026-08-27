import { expect, test } from 'bun:test';
import {
  assertIdComponent,
  attemptIdOf,
  cellKeyOf,
  comparisonId,
  prepareRegistration,
  primaryBlockId,
  primarySampleId,
  RegistrationError,
  type RegistrationInput,
  rerunInstanceId,
  reserveBlockId,
  reserveSampleId,
  type ScenarioIntake,
  SURCHARGE_FORMULA_VERSION,
} from '../src/campaign/registration.ts';
import type { Arm } from '../src/contracts/campaign/arm.ts';
import type { Suite } from '../src/contracts/campaign/suite.ts';
import type { Credential } from '../src/contracts/credential.ts';
import type { EstimatesArtifact } from '../src/contracts/estimates.ts';

test('the pinned ID derivation table', () => {
  const cmp = comparisonId(1);
  expect(cmp).toBe('c1');
  const cell = cellKeyOf(cmp, 'sdd-escalates');
  expect(cell).toBe('c1:sdd-escalates');
  expect(primarySampleId(cell, 'claude-sp', 3)).toBe(
    'c1:sdd-escalates:claude-sp:r3',
  );
  expect(primaryBlockId(cell, 3)).toBe('c1:sdd-escalates:b3');
  expect(reserveBlockId(cell, 2)).toBe('c1:sdd-escalates:x2');
  expect(reserveSampleId(cell, 'claude-sp', 2)).toBe(
    'c1:sdd-escalates:claude-sp:x2',
  );
  // Rerun lineage: the successor of B:i1 is B:i2, never B:i1:i2 — the root is
  // the first non-rerun block; seq increments across the root.
  expect(rerunInstanceId('c1:sdd-escalates:b3', 1)).toBe(
    'c1:sdd-escalates:b3:i1',
  );
  expect(rerunInstanceId('c1:sdd-escalates:b3', 2)).toBe(
    'c1:sdd-escalates:b3:i2',
  );
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:r3', 2)).toBe(
    'c1:sdd-escalates:claude-sp:r3:a2',
  );
});

test('ID components outside the pinned grammar reject; ":" never passes', () => {
  expect(() => assertIdComponent('ok-name.x_1', 'scenario name')).not.toThrow();
  expect(() => assertIdComponent('has:colon', 'scenario name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('Upper', 'arm name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('-lead', 'scenario name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('', 'suite name')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1', 'bad:scenario')).toThrow(RegistrationError);
});

test('numeric parameters outside the 1-based positive-integer domain reject', () => {
  expect(() => comparisonId(0)).toThrow(RegistrationError);
  expect(() => comparisonId(-1)).toThrow(RegistrationError);
  expect(() => comparisonId(1.5)).toThrow(RegistrationError);
  expect(() => comparisonId(Number.NaN)).toThrow(RegistrationError);
  expect(() => comparisonId(Number.POSITIVE_INFINITY)).toThrow(
    RegistrationError,
  );
  expect(() => primaryBlockId('c1:sdd-escalates', -1)).toThrow(
    RegistrationError,
  );
  expect(() => reserveBlockId('c1:sdd-escalates', 0)).toThrow(
    RegistrationError,
  );
  expect(() =>
    primarySampleId('c1:sdd-escalates', 'claude-sp', Number.NaN),
  ).toThrow(RegistrationError);
  expect(() => reserveSampleId('c1:sdd-escalates', 'claude-sp', 1.5)).toThrow(
    RegistrationError,
  );
  expect(() => rerunInstanceId('c1:sdd-escalates:b3', 0)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:r3', -2)).toThrow(
    RegistrationError,
  );
});

test('prebuilt id inputs are shape-validated before interpolation', () => {
  // comparison id into a cell key: must be c<N>, N 1-based, single component.
  expect(() => cellKeyOf('1', 'sdd-escalates')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c0', 'sdd-escalates')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1:extra', 'sdd-escalates')).toThrow(
    RegistrationError,
  );
  // cell key into block/sample constructors: exactly c<N>:<scenario>.
  expect(() => primaryBlockId('c1', 3)).toThrow(RegistrationError);
  expect(() =>
    primarySampleId('c1:sdd-escalates:extra', 'claude-sp', 3),
  ).toThrow(RegistrationError);
  expect(() => reserveSampleId('c1:', 'claude-sp', 2)).toThrow(
    RegistrationError,
  );
  // lineage root: the first NON-rerun block — b<N> or x<N>, never :i<N>.
  expect(() => rerunInstanceId('c1:sdd-escalates:b3:i1', 1)).toThrow(
    RegistrationError,
  );
  expect(() => rerunInstanceId('c1:sdd-escalates:q3', 1)).toThrow(
    RegistrationError,
  );
  // sample id into an attempt: cell:arm:r<N> or cell:arm:x<N>.
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp', 2)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:q3', 2)).toThrow(
    RegistrationError,
  );
  // reserve lineage roots and reserve-sample attempts stay in-grammar.
  expect(rerunInstanceId('c1:sdd-escalates:x2', 1)).toBe(
    'c1:sdd-escalates:x2:i1',
  );
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:x2', 1)).toBe(
    'c1:sdd-escalates:claude-sp:x2:a1',
  );
});

const CAPABLE = () => ({ ref: true, none: true });

// Fixture builders. Some call sites cast their override literal `as never`:
// exactOptionalPropertyTypes rejects an explicit `undefined` override (the
// deletion idiom, e.g. `api_key_env: undefined` to strip a default), and the
// cast admits exactly that — the builders' outputs are still exercised
// against the real zod schemas by the tests themselves.
function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    model: 'test-model',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: 'TEST_KEY',
    compat: {},
    max_concurrency: 15,
    ...overrides,
  } as Credential;
}

function arm(name: string, overrides: Partial<Arm> = {}): Arm {
  return {
    schema_version: 1,
    name,
    agent: 'claude',
    credential: 'cred_a',
    superpowers: 'none',
    ...overrides,
  } as Arm;
}

function scenario(
  name: string,
  overrides: Partial<ScenarioIntake> = {},
): ScenarioIntake {
  return {
    name,
    tier: 'full',
    requires_superpowers: false,
    coupling: 'arm-independent',
    os: undefined,
    ...overrides,
  };
}

function estimates(
  overrides: Partial<EstimatesArtifact> = {},
): EstimatesArtifact {
  return {
    schema_version: 'quorum.estimates/v1',
    generated_at: '2026-08-20T00:00:00Z',
    corpus: {
      sources: ['s'],
      run_count: 10,
      duplicates_excluded: 0,
      digest: 'd',
    },
    entries: [
      {
        scenario: 'scn-a',
        agent: 'claude',
        credential: 'cred_a',
        os: 'linux',
        duration_s_median: 600,
        duration_n: 9,
        cost_subject_usd_median: 1,
        cost_grader_usd_median: 0.5,
        cost_total_usd_median: 1.5,
        priced_n: 9,
        spread_s: { p25: 500, p75: 700 },
        confidence: 'high',
      },
    ],
    fallbacks: {
      scenario_agent: [],
      scenario: [],
      corpus_median: { duration_s: 600, cost_total_usd: 1.5 },
    },
    ...overrides,
  } as EstimatesArtifact;
}

function suite(overrides: Partial<Suite> = {}): Suite {
  return {
    schema_version: 1,
    name: 'testsuite',
    kind: 'exploratory',
    budget_usd: 100,
    comparisons: [
      { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn-a'], n: 2 },
    ],
    ...overrides,
  } as Suite;
}

function input(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    suite: suite(),
    arms: {
      arm_a: arm('arm_a'),
      arm_b: arm('arm_b', { credential: 'cred_b' }),
    },
    credentials: {
      cred_a: credential(),
      cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
    },
    grader: { credential: 'cred_a', model: 'grader-model' },
    estimates: estimates(),
    capability: CAPABLE,
    agentOsSupport: () => ['linux'],
    agentFamily: () => 'claude',
    scenarios: [scenario('scn-a')],
    globalCap: 8,
    campaignOs: 'linux',
    env: () => 'set',
    nowMs: Date.parse('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}

test('grid expansion: cells, samples, blocks, deterministic canonical order', () => {
  const prep = prepareRegistration(input());
  expect(prep.comparisons).toEqual([
    { comparison_id: 'c1', baseline: 'arm_a', treatment: 'arm_b' },
  ]);
  expect(
    prep.cells.map((c) => ({
      scenario: c.scenario,
      comparison_id: c.comparison_id,
      arms: c.arms,
      n: c.n,
    })),
  ).toEqual([
    { scenario: 'scn-a', comparison_id: 'c1', arms: ['arm_a', 'arm_b'], n: 2 },
  ]);
  expect(prep.samples.map((s) => s.sample_id)).toEqual([
    'c1:scn-a:arm_a:r1',
    'c1:scn-a:arm_b:r1',
    'c1:scn-a:arm_a:r2',
    'c1:scn-a:arm_b:r2',
  ]);
  expect(prep.blocks.map((b) => b.block_id)).toEqual([
    'c1:scn-a:b1',
    'c1:scn-a:b2',
  ]);
  expect(prep.blocks[0]?.sample_ids).toEqual([
    'c1:scn-a:arm_a:r1',
    'c1:scn-a:arm_b:r1',
  ]);
  expect(prep.excluded_cells).toEqual([]);
  // Byte-identical on re-run (determinism bundle).
  expect(JSON.stringify(prepareRegistration(input()))).toBe(
    JSON.stringify(prep),
  );
});

test('tier selectors expand through the intake tier labels', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({
        comparisons: [
          {
            baseline: 'arm_a',
            treatment: 'arm_b',
            scenarios: 'tier=sentinel',
            n: 1,
          },
        ],
      }),
      scenarios: [
        scenario('scn-a', { tier: 'sentinel' }),
        scenario('scn-b', { tier: 'full' }),
      ],
    }),
  );
  expect(prep.cells.map((c) => c.scenario)).toEqual(['scn-a']);
});

test('gating suites mint reserve blocks + samples per cell (E7.0 frozen reserve)', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      }),
      // gating + grader-match attestation (Design note 2):
      pricingOverrides: [
        {
          applies_to_grader: true,
          per_token_usd: 0.00001,
          rationale: 'attested',
        },
      ],
    } as never),
  );
  expect(prep.blocks.map((b) => b.block_id)).toContain('c1:scn-a:x1');
  const reserve = prep.blocks.find((b) => b.block_id === 'c1:scn-a:x1');
  expect(reserve?.slot).toBe('reserve');
  expect(reserve?.sample_ids).toEqual([
    'c1:scn-a:arm_a:x1',
    'c1:scn-a:arm_b:x1',
  ]);
  expect(
    prep.samples.find((s) => s.sample_id === 'c1:scn-a:arm_a:x1')?.cell,
  ).toBe('c1:scn-a');
});

test('rejection matrix: capability, windows os, unsupported os, requires_superpowers, subscription auth', () => {
  // R-REG-9: a REF arm on an adapter without ref capability (the fixture's
  // default arms are superpowers 'none', which cap.none still permits).
  let prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { superpowers: 'ref' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
      capability: () => ({ ref: false, none: true }),
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /lacks adapter capability/,
  );
  // R-REG-10: os: windows parses, then rejects.
  prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { os: 'windows' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
    }),
  );
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/windows/);
  // R-REG-14: arm os unsupported by the agent.
  prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { os: 'darwin' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
      agentOsSupport: () => ['linux'],
    }),
  );
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /os .*unsupported/i,
  );
  // R-REG-16: requires_superpowers scenario dropped for none arms.
  prep = prepareRegistration(
    input({ scenarios: [scenario('scn-a', { requires_superpowers: true })] }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /requires_superpowers/,
  );
  // R-REG-15: subscription auth in a gating suite rejects mechanically.
  prep = prepareRegistration(
    input({
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      }),
      credentials: {
        cred_a: credential({ auth: 'subscription', api_key_env: undefined }),
        cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
      },
      pricingOverrides: [
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(/api-key/);
});

test('R-REG-13: cap-1 same-pool two-arm demand refuses pre-spend', () => {
  const prep = prepareRegistration(
    input({
      credentials: {
        // SAME quota_pool on both -> one pool with cap 1 facing two-arm demand
        cred_a: credential({ max_concurrency: 1, quota_pool: 'shared' }),
        cred_b: credential({
          max_concurrency: 1,
          api_key_env: 'TEST_KEY_B',
          quota_pool: 'shared',
        }),
      },
      suite: suite({
        comparisons: [
          { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn-a'], n: 1 },
        ],
        max_exposure_skew: 60,
      } as never),
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /infeasible|cap/i,
  );
});

test('pricing: E1/E2 keying through lookupEstimate, surcharge formula v1, priced coverage', () => {
  const prep = prepareRegistration(
    input({
      estimates: estimates({
        entries: [
          {
            scenario: 'scn-a',
            agent: 'claude',
            credential: 'cred_a',
            os: 'linux',
            duration_s_median: 600,
            duration_n: 4,
            cost_subject_usd_median: 1,
            cost_grader_usd_median: 0.5,
            cost_total_usd_median: 1.5,
            priced_n: 4,
            spread_s: { p25: 500, p75: 700 },
            confidence: 'medium',
          },
          {
            scenario: 'scn-a',
            agent: 'claude',
            credential: 'cred_b',
            os: 'linux',
            duration_s_median: 700,
            duration_n: 9,
            cost_subject_usd_median: 2,
            cost_grader_usd_median: 0.5,
            cost_total_usd_median: 2.5,
            priced_n: 9,
            spread_s: { p25: 600, p75: 800 },
            confidence: 'high',
          },
        ],
      }),
    }),
  );
  const cell = prep.cells[0];
  expect(cell?.estimates_by_arm['arm_a']).toEqual({
    duration_s: 600,
    cost_usd: 1.5,
    confidence: 'medium',
  });
  expect(cell?.estimates_by_arm['arm_b']).toEqual({
    duration_s: 700,
    cost_usd: 2.5,
    confidence: 'high',
  });
  // Surcharge: worst-arm confidence medium -> (n x (1.5 + 2.5)) x 0.10 = 2 x 4 x 0.10
  expect(prep.budget.surcharge_applied).toBeCloseTo(0.8, 10);
  expect(prep.budget.surcharge_formula_version).toBe(SURCHARGE_FORMULA_VERSION);
  expect(prep.budget.usd_all_in).toBe(100);
  expect(prep.budget.priced_coverage).toBe(1);
});

test('R-REG-11 + R-REG-12: unpriced gating cells reject without an override; usd params reject when unpriceable', () => {
  const unpriced = estimates({
    entries: [],
    fallbacks: {
      scenario_agent: [],
      scenario: [],
      // C3 (2026-08-27 operator ruling): the override prices off the token
      // volume median, so the escape case needs a resolvable volume here.
      corpus_median: {
        duration_s: 600,
        cost_total_usd: null,
        tokens_total_median: 1_500_000,
      },
    },
  });
  let prep = prepareRegistration(
    input({
      estimates: unpriced,
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      } as never),
      pricingOverrides: [
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /unpriced|pricing override/i,
  );
  // The arm override escapes R-REG-11:
  prep = prepareRegistration(
    input({
      estimates: unpriced,
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      } as never),
      pricingOverrides: [
        { arm: 'arm_a', per_token_usd: 0.00001, rationale: 'r' },
        { arm: 'arm_b', per_token_usd: 0.00001, rationale: 'r' },
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.cells).toHaveLength(1);
  // Override costing (C3): cost_usd = per_token_usd x tokens_total_median.
  expect(prep.cells[0]?.estimates_by_arm['arm_a']?.cost_usd).toBeCloseTo(15, 9);
  expect(prep.cells[0]?.estimates_by_arm['arm_b']?.cost_usd).toBeCloseTo(15, 9);
});

test('C3 fail-closed: an override without a resolvable tokens_total_median cannot price (R-REG-11 stands)', () => {
  const noTokens = estimates({
    entries: [],
    fallbacks: {
      scenario_agent: [],
      scenario: [],
      corpus_median: { duration_s: 600, cost_total_usd: null },
    },
  });
  const prep = prepareRegistration(
    input({
      estimates: noTokens,
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      } as never),
      pricingOverrides: [
        { arm: 'arm_a', per_token_usd: 0.00001, rationale: 'r' },
        { arm: 'arm_b', per_token_usd: 0.00001, rationale: 'r' },
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /tokens_total_median/,
  );
  // Never silently admitted at cost_usd: 0.
  expect(prep.cells).toEqual([]);
});

test('R-REG-12: usd-denominated profile params reject when an arm is unpriceable; a priceable override rescues', () => {
  const base = {
    estimates: estimates({
      entries: [],
      fallbacks: {
        scenario_agent: [],
        scenario: [],
        corpus_median: {
          duration_s: 600,
          cost_total_usd: null,
          tokens_total_median: 1_500_000,
        },
      },
    }),
    suite: suite({ profile_params: { max_exposure_usd: 50 } }),
  };
  // No override: unpriceable arm + usd params -> rejected pre-spend.
  let prep = prepareRegistration(input(base));
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /usd-denominated/,
  );
  // An override that can actually price (token volume resolvable) rescues.
  prep = prepareRegistration(
    input({
      ...base,
      pricingOverrides: [
        { arm: 'arm_a', per_token_usd: 0.000002, rationale: 'r' },
        { arm: 'arm_b', per_token_usd: 0.000002, rationale: 'r' },
      ],
    }),
  );
  expect(prep.cells).toHaveLength(1);
});

test('grader-match restriction: gating refuses without the attestation override; exploratory warns', () => {
  expect(() =>
    prepareRegistration(
      input({
        suite: suite({
          kind: 'gating',
          profile: 'release_gate_v1',
          reserve: 1,
          max_exposure_skew: 60,
          profile_params: {
            alpha: 0.05,
            determinate_n_floor: 5,
            completion_divergence_max: 0.2,
            mde_by_scenario: { 'scn-a': 0.1 },
          },
        } as never),
      } as never),
    ),
  ).toThrow(/grader/);
  const prep = prepareRegistration(input()); // exploratory, no attestation
  expect(prep.warnings.join(' ')).toMatch(/grader/);
});

test('warnings: grader cap below 15 in gating; key_pool over-capacity (R-REG-20/7)', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({
        kind: 'gating',
        profile: 'release_gate_v1',
        reserve: 1,
        max_exposure_skew: 60,
        profile_params: {
          alpha: 0.05,
          determinate_n_floor: 5,
          completion_divergence_max: 0.2,
          mde_by_scenario: { 'scn-a': 0.1 },
        },
      } as never),
      credentials: {
        // max_concurrency 12 > 2 keys x 5 = 10 -> over-capacity warning; the
        // grader pool cap (12, this credential) < 15 -> R-REG-20 warning.
        cred_a: credential({
          max_concurrency: 12,
          key_pool: ['K1', 'K2'],
          api_key_env: undefined,
        }),
        cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
      },
      pricingOverrides: [
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.warnings.join(' ')).toMatch(/grader pool cap/);
  expect(prep.warnings.join(' ')).toMatch(/key_pool/); // 12 > 2 keys x 5 = 10 -> over-capacity warning
});
