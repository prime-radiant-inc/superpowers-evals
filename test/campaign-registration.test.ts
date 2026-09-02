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
    coding_agents: undefined,
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
  // R-REG-15 rescinded (owner ruling 2026-09-01): a subscription-auth arm
  // in a gating suite is no longer excluded on auth class — gating gates on
  // completed runs, not credential formalism.
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
      grader: { credential: 'cred_b', model: 'grader-model' },
      pricingOverrides: [
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).not.toMatch(
    /api-key/,
  );
  expect(prep.cells.length).toBeGreaterThan(0);
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

function gatingSuite(overrides: Partial<Suite> = {}): Suite {
  return suite({
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
    ...overrides,
  } as never);
}

const UNPRICED_WITH_TOKENS = () =>
  estimates({
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
  });

test('R-REG-13: shared-pool feasibility is order-independent (constraints from every credential on the pool)', () => {
  const asymmetric = {
    credentials: {
      // arm_a's declaration alone would admit; arm_b's tightens the pool.
      cred_a: credential({ max_concurrency: 15, quota_pool: 'shared' }),
      cred_b: credential({
        max_concurrency: 1,
        launch_spacing_seconds: 10,
        api_key_env: 'TEST_KEY_B',
        quota_pool: 'shared',
      }),
    },
  };
  // a -> b: must reject, not just the b -> a order.
  let prep = prepareRegistration(input(asymmetric));
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /infeasible/,
  );
  // b -> a: same pool, same verdict.
  prep = prepareRegistration(
    input({
      ...asymmetric,
      suite: suite({
        comparisons: [
          { baseline: 'arm_b', treatment: 'arm_a', scenarios: ['scn-a'], n: 1 },
        ],
      }),
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /infeasible/,
  );
  // Every registry credential mapped to the pool constrains it — an unused
  // cap-1 member tightens the shared bucket below two-arm demand.
  prep = prepareRegistration(
    input({
      credentials: {
        cred_a: credential({ max_concurrency: 2, quota_pool: 'shared' }),
        cred_b: credential({
          max_concurrency: 2,
          api_key_env: 'TEST_KEY_B',
          quota_pool: 'shared',
        }),
        cred_c: credential({
          max_concurrency: 1,
          api_key_env: 'TEST_KEY_C',
          quota_pool: 'shared',
        }),
      },
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /infeasible/,
  );
  // Accept pair: every pool member cap >= 2 and no spacing -> admitted.
  prep = prepareRegistration(
    input({
      credentials: {
        cred_a: credential({ max_concurrency: 2, quota_pool: 'shared' }),
        cred_b: credential({
          max_concurrency: 2,
          api_key_env: 'TEST_KEY_B',
          quota_pool: 'shared',
        }),
      },
    }),
  );
  expect(prep.cells).toHaveLength(1);
});

test('grader eligibility: missing credential refuses (R-REG-20); auth class no longer gates (R-REG-15 rescinded)', () => {
  expect(() =>
    prepareRegistration(
      input({ grader: { credential: 'grader_cred', model: 'g' } }),
    ),
  ).toThrow(/grader_cred/);
  // A subscription grader in a gating suite now registers (owner ruling
  // 2026-09-01): gating gates on completed runs, not credential auth class.
  const gatingPrep = prepareRegistration(
    input({
      suite: gatingSuite(),
      credentials: {
        cred_a: credential({ auth: 'subscription', api_key_env: undefined }),
        cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
      },
      grader: { credential: 'cred_a', model: 'g' },
      pricingOverrides: [
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(gatingPrep.cells.length).toBeGreaterThan(0);
  // The exploratory seat-auth caveat warning went with the rule.
  const prep = prepareRegistration(
    input({
      credentials: {
        cred_a: credential({ auth: 'subscription', api_key_env: undefined }),
        cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
      },
    }),
  );
  expect(prep.warnings.join(' ')).not.toMatch(/api-key grader credential/);
});

test('R-REG-19: key-env preflight refuses naming every unset env (api_key_env and key_pool members)', () => {
  expect(() => prepareRegistration(input({ env: () => undefined }))).toThrow(
    /TEST_KEY/,
  );
  expect(() =>
    prepareRegistration(
      input({
        credentials: {
          cred_a: credential({
            max_concurrency: 12,
            key_pool: ['K1', 'K2'],
            api_key_env: undefined,
          }),
          cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
        },
        env: (key) => (key === 'K2' ? undefined : 'set'),
      }),
    ),
  ).toThrow(/K2/);
  // A DISTINCT grader credential's missing env refuses independently of
  // the arm credentials (R-REG-19 grader half).
  expect(() =>
    prepareRegistration(
      input({
        credentials: {
          cred_a: credential(),
          cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
          grader_cred: credential({ api_key_env: 'GRADER_KEY' }),
        },
        grader: { credential: 'grader_cred', model: 'g' },
        env: (key) => (key === 'GRADER_KEY' ? undefined : 'set'),
      }),
    ),
  ).toThrow(/GRADER_KEY/);
});

test('R-REG-13 branches isolated: spacing-only rejection (cap sufficient) and global_run_cap < 2', () => {
  // Spacing-only: every pool member's cap serves two-arm demand, but a
  // declared spacing makes the atomic two-arm launch impossible.
  let prep = prepareRegistration(
    input({
      credentials: {
        cred_a: credential({ max_concurrency: 2, quota_pool: 'shared' }),
        cred_b: credential({
          max_concurrency: 2,
          launch_spacing_seconds: 30,
          api_key_env: 'TEST_KEY_B',
          quota_pool: 'shared',
        }),
      },
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /launch spacing/,
  );
  // Global cap: pools are fine (separate pools), but G < 2 cannot serve a
  // two-sample block.
  prep = prepareRegistration(input({ globalCap: 1 }));
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /global_run_cap 1/,
  );
});

test('R-REG-14 legs: credential os_support and scenario os directive rejections', () => {
  // Credential os_support excludes the campaign os.
  let prep = prepareRegistration(
    input({
      credentials: {
        cred_a: credential({ os_support: ['darwin'] }),
        cred_b: credential({ api_key_env: 'TEST_KEY_B' }),
      },
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /unsupported by credential cred_a/,
  );
  // Scenario os directive excludes the campaign os.
  prep = prepareRegistration(
    input({ scenarios: [scenario('scn-a', { os: ['darwin'] })] }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells.map((e) => e.reason).join(' ')).toMatch(
    /unsupported by scenario directive/,
  );
});

// PAR §Suites: a scenario dropped by its `# coding-agents:` directive is
// dropped within its comparison for BOTH arms, loudly in excluded_cells.
test('scenario coding-agents directive: an arm agent outside it drops the cell for both arms; inside admits; [] drops all', () => {
  const codexArmB = {
    arm_a: arm('arm_a'),
    arm_b: arm('arm_b', { agent: 'codex', credential: 'cred_b' }),
  };
  let prep = prepareRegistration(
    input({
      arms: codexArmB,
      scenarios: [scenario('scn-a', { coding_agents: ['claude'] })],
    }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.samples).toEqual([]);
  expect(prep.excluded_cells).toHaveLength(1);
  expect(prep.excluded_cells[0]?.cell).toBe('c1:scn-a');
  expect(prep.excluded_cells[0]?.reason).toMatch(
    /arm arm_b agent codex outside the scenario's coding-agents directive \(claude\)/,
  );
  // Both agents listed: admitted.
  prep = prepareRegistration(
    input({
      arms: codexArmB,
      scenarios: [scenario('scn-a', { coding_agents: ['claude', 'codex'] })],
    }),
  );
  expect(prep.cells).toHaveLength(1);
  expect(prep.excluded_cells).toEqual([]);
  // No directive: any agent.
  prep = prepareRegistration(input({ arms: codexArmB }));
  expect(prep.cells).toHaveLength(1);
  // A matched-but-empty directive (`# coding-agents: ,`) admits no agent —
  // the run-all matrix reading of [].
  prep = prepareRegistration(
    input({ scenarios: [scenario('scn-a', { coding_agents: [] })] }),
  );
  expect(prep.cells).toEqual([]);
  expect(prep.excluded_cells[0]?.reason).toMatch(
    /coding-agents directive \(\)/,
  );
});

test('override pricing preserves the fallback tier confidence — no manufactured high, surcharge still applies (R-REG-3)', () => {
  const prep = prepareRegistration(
    input({
      estimates: UNPRICED_WITH_TOKENS(),
      pricingOverrides: [
        { arm: 'arm_a', per_token_usd: 0.00001, rationale: 'r' },
        { arm: 'arm_b', per_token_usd: 0.00001, rationale: 'r' },
      ],
    }),
  );
  // Corpus tier + override: priced (cost 15) but the tier's own confidence
  // (none) reads low — an override prices, it does not manufacture high.
  expect(prep.cells[0]?.estimates_by_arm['arm_a']?.confidence).toBe('low');
  expect(prep.cells[0]?.estimates_by_arm['arm_a']?.cost_usd).toBeCloseTo(15, 9);
  // 2 primary blocks x (15 + 15) x 0.25 (low) — surcharge not suppressed.
  expect(prep.budget.surcharge_applied).toBeCloseTo(15, 9);
  expect(prep.budget.priced_coverage).toBe(1);
});

test('E7.0: surcharge prices frozen reserve capacity — (n + reserve) blocks per cell', () => {
  const prep = prepareRegistration(
    input({
      suite: suite({
        reserve: 1,
        comparisons: [
          { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn-a'], n: 1 },
        ],
      }),
      estimates: UNPRICED_WITH_TOKENS(),
      pricingOverrides: [
        { arm: 'arm_a', per_token_usd: 0.00001, rationale: 'r' },
        { arm: 'arm_b', per_token_usd: 0.00001, rationale: 'r' },
      ],
    }),
  );
  expect(prep.blocks.filter((b) => b.slot === 'reserve')).toHaveLength(1);
  // (n=1 primary + 1 reserve) x (15 + 15) x 0.25 = 15 — reserve priced.
  expect(prep.budget.surcharge_applied).toBeCloseTo(15, 9);
});

test('zero-reserve suites warn: contention invalidation will be shortfall-only', () => {
  const prep = prepareRegistration(input());
  expect(prep.warnings.join(' ')).toContain(
    'contention invalidation will be shortfall-only',
  );
});

test('R-REG-21: stale estimates artifact refuses registration naming the rebuild', () => {
  expect(() =>
    prepareRegistration(input({ nowMs: Date.parse('2026-10-15T00:00:00Z') })),
  ).toThrow(/stale/);
  expect(() =>
    prepareRegistration(input({ nowMs: Date.parse('2026-10-15T00:00:00Z') })),
  ).toThrow(/quorum campaign estimates/);
});

test('R-REG-18: tripwire_expect correlates to tripwire cells', () => {
  const tripwire = (cell: Record<string, unknown>): Suite =>
    gatingSuite({
      comparisons: [
        {
          baseline: 'arm_a',
          treatment: 'arm_b',
          scenarios: ['scn-a'],
          n: 1,
          cells: { 'scn-a': cell },
        },
      ],
    } as never);
  // Gating needs the grader attestation independent of cell overrides.
  const attested = {
    pricingOverrides: [
      { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
    ],
  };
  // tripwire WITH expectation: admitted.
  expect(
    prepareRegistration(
      input({
        ...attested,
        suite: tripwire({ class: 'tripwire', tripwire_expect: 'fail' }),
      }),
    ).cells,
  ).toHaveLength(1);
  // gating tripwire without expectation: refused (no firing criterion).
  expect(() =>
    prepareRegistration(
      input({ ...attested, suite: tripwire({ class: 'tripwire' }) }),
    ),
  ).toThrow(/tripwire_expect/);
  // tripwire_expect on a non-tripwire cell: refused (miscorrelation).
  expect(() =>
    prepareRegistration(
      input({
        ...attested,
        suite: tripwire({ class: 'confirmatory', tripwire_expect: 'fail' }),
      }),
    ),
  ).toThrow(/tripwire_expect/);
});
test('rejection-matrix accept pairs: capability, arm os, requires_superpowers, gating auth (R-REG-9/14/16/15)', () => {
  // R-REG-9 accept: a ref arm on a ref-capable adapter.
  let prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { superpowers: 'ref' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
      capability: () => ({ ref: true, none: true }),
    }),
  );
  expect(prep.cells).toHaveLength(1);
  // R-REG-14 accept: arm os supported by the agent.
  prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { os: 'darwin' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
      agentOsSupport: () => ['linux', 'darwin'],
    }),
  );
  expect(prep.cells).toHaveLength(1);
  // R-REG-16 accept: requires_superpowers scenario, both arms carry superpowers.
  prep = prepareRegistration(
    input({
      arms: {
        arm_a: arm('arm_a', { superpowers: 'ref' }),
        arm_b: arm('arm_b', { credential: 'cred_b', superpowers: 'ref' }),
      },
      scenarios: [scenario('scn-a', { requires_superpowers: true })],
    }),
  );
  expect(prep.cells).toHaveLength(1);
  // Gating accepts any registered credential auth class (R-REG-15 rescinded).
  prep = prepareRegistration(
    input({
      suite: gatingSuite(),
      pricingOverrides: [
        { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
      ],
    } as never),
  );
  expect(prep.cells).toHaveLength(1);
});

test('every exclusion reason names the operator next step', () => {
  const cases: Array<[Partial<RegistrationInput>, RegExp]> = [
    [
      {
        arms: {
          arm_a: arm('arm_a', { superpowers: 'ref' }),
          arm_b: arm('arm_b', { credential: 'cred_b' }),
        },
        capability: () => ({ ref: false, none: true }),
      },
      /R-REG-9/,
    ],
    [
      {
        arms: {
          arm_a: arm('arm_a', { os: 'windows' }),
          arm_b: arm('arm_b', { credential: 'cred_b' }),
        },
      },
      /R-REG-10/,
    ],
    [
      {
        arms: {
          arm_a: arm('arm_a', { os: 'darwin' }),
          arm_b: arm('arm_b', { credential: 'cred_b' }),
        },
        agentOsSupport: () => ['linux'],
      },
      /R-REG-14/,
    ],
    [
      { scenarios: [scenario('scn-a', { requires_superpowers: true })] },
      /R-REG-16/,
    ],
    [
      { scenarios: [scenario('scn-a', { coding_agents: ['codex'] })] },
      /coding-agents directive/,
    ],
    [
      {
        credentials: {
          cred_a: credential({ max_concurrency: 1, quota_pool: 'shared' }),
          cred_b: credential({
            max_concurrency: 1,
            api_key_env: 'TEST_KEY_B',
            quota_pool: 'shared',
          }),
        },
      },
      /R-REG-13/,
    ],
    [
      {
        arms: { arm_a: arm('arm_a') },
      },
      /R-REG-2/,
    ],
    [
      {
        estimates: estimates({
          entries: [],
          fallbacks: {
            scenario_agent: [],
            scenario: [],
            corpus_median: { duration_s: 600, cost_total_usd: null },
          },
        }),
        suite: gatingSuite(),
        grader: { credential: 'cred_b', model: 'g' },
        pricingOverrides: [
          { applies_to_grader: true, per_token_usd: 0.00001, rationale: 'r' },
        ],
      },
      /R-REG-11/,
    ],
    [
      {
        estimates: estimates({
          entries: [],
          fallbacks: {
            scenario_agent: [],
            scenario: [],
            corpus_median: { duration_s: 600, cost_total_usd: null },
          },
        }),
        suite: suite({ profile_params: { max_exposure_usd: 50 } }),
      },
      /R-REG-12/,
    ],
    [
      {
        suite: suite({
          comparisons: [
            {
              baseline: 'arm_a',
              treatment: 'arm_b',
              scenarios: ['scn-x'],
              n: 1,
            },
          ],
        }),
      },
      /not in the snapshot intake/,
    ],
  ];
  for (const [overrides, row] of cases) {
    const prep = prepareRegistration(input(overrides));
    expect(prep.cells).toEqual([]);
    expect(prep.excluded_cells.length).toBeGreaterThan(0);
    for (const { reason } of prep.excluded_cells) {
      expect(reason).toMatch(
        /—.*(drop|switch|raise|remove|fix|align|re-register|add|price|rebuild|move|provision|split)/,
      );
      expect(reason).toMatch(row);
    }
  }
});

import {
  buildContentionBlock,
  defaultContentionThresholds,
} from '../src/campaign/registration.ts';

const GiB = 2 ** 30;

test('the five pinned D-4 threshold defaults derive from the fingerprint', () => {
  const thresholds = defaultContentionThresholds({
    mem_bytes: 16 * GiB,
    swap_total_bytes: 4 * GiB,
    disk_total_bytes: 100 * GiB,
  });
  expect(thresholds).toEqual([
    { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2.0 },
    {
      metric: 'mem_available_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(2 * GiB, 0.1 * 16 * GiB),
      relative_of: 'mem_bytes',
    },
    {
      metric: 'swap_used_bytes',
      source: 'host',
      op: 'gt',
      value: 0.25 * 4 * GiB,
      relative_of: 'swap_total_bytes',
    },
    {
      metric: 'disk_free_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(5 * GiB, 0.15 * 100 * GiB),
      relative_of: 'disk_total_bytes',
    },
    {
      metric: 'process_count',
      source: 'host',
      op: 'gt',
      value: 800_000,
      relative_of: 'pid_table',
    },
  ]);
});

test('a swapless host omits the swap threshold (0 would refuse the positive-value schema)', () => {
  // First-contact evidence: containerized campaign hosts report
  // swap_total_bytes 0; a 0.25 x 0 threshold value violates the
  // ContentionThreshold positive-value schema, and a swapless host cannot
  // experience swap contention — the evaluator judges only declared
  // thresholds, so omission is the honest declaration.
  const thresholds = defaultContentionThresholds({
    mem_bytes: 16 * GiB,
    swap_total_bytes: 0,
    disk_total_bytes: 100 * GiB,
  });
  expect(thresholds.map((t) => t.metric)).toEqual([
    'load1_per_core',
    'mem_available_bytes',
    'disk_free_bytes',
    'process_count',
  ]);
});

test('buildContentionBlock freezes G, thresholds, sampler parameters, tolerances (digest members)', () => {
  const block = buildContentionBlock({
    fingerprint: {
      cpu_model: 'Apple M1',
      cpu_cores: 8,
      mem_bytes: 16 * GiB,
      disk_total_bytes: 100 * GiB,
    },
    globalCap: 24,
    thresholds: defaultContentionThresholds({
      mem_bytes: 16 * GiB,
      swap_total_bytes: 4 * GiB,
      disk_total_bytes: 100 * GiB,
    }),
  });
  expect(block).toEqual({
    host_fingerprint: {
      cpu_model: 'Apple M1',
      cpu_cores: 8,
      mem_bytes: 16 * GiB,
      disk_total_bytes: 100 * GiB,
    },
    global_run_cap: 24,
    thresholds: block.thresholds,
    cadence_ms: 10_000,
    sustain_k: 3,
    coverage_n: 4,
    mem_tolerance_pct: 10,
    disk_tolerance_pct: 10,
  });
});

// ── registerCampaign orchestration + publication (task 5d) ────────────────
// Real tmp git repos (house pattern), real bun installs, injected
// clock/identity/probe; the CommandRunner fake answers ONLY the merge-base
// child-contract check (the fixture cannot contain the real D2 merge SHA).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  defaultCommandRunner,
} from '../src/agents/command-runner.ts';
import type { HostStats, HostStatsProbe } from '../src/campaign/host-stats.ts';
import { type JournalFsOps, openJournalRead } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  MINIMUM_CHILD_CONTRACT_SHA,
  type RegisterArgs,
  type RegisterResult,
  registerCampaign,
} from '../src/campaign/registration.ts';
import type { PricingOverride } from '../src/contracts/campaign/campaign.ts';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const LOCAL_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};
const FAKE_STATS: HostStats = {
  ts_ms: 0,
  load1: 0.1,
  pid_max: 1_000_000,
  mem_available_bytes: 8 * GiB,
  mem_total_bytes: 16 * GiB,
  swap_used_bytes: 0,
  swap_total_bytes: 4 * GiB,
  process_count: 200,
  disk_free_bytes: 50 * GiB,
  disk_total_bytes: 100 * GiB,
};
const FAKE_PROBE: HostStatsProbe = {
  sample: (nowMs) => ({ ...FAKE_STATS, ts_ms: nowMs }),
};

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A real tmp evals checkout at one commit: arms/, credentials.yaml,
 *  coding-agents/claude.yaml, scenarios/scn-a, and a stub CLI entrypoint. */
function evalsRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'evals-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(
    join(dir, 'credentials.yaml'),
    [
      'cred_a:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY',
      'cred_b:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_B',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'arms'), { recursive: true });
  writeFileSync(
    join(dir, 'arms', 'arm_a.yaml'),
    [
      'schema_version: 1',
      'name: arm_a',
      'agent: claude',
      'credential: cred_a',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'arms', 'arm_b.yaml'),
    [
      'schema_version: 1',
      'name: arm_b',
      'agent: claude',
      'credential: cred_b',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'coding-agents'), { recursive: true });
  writeFileSync(
    join(dir, 'coding-agents', 'claude.yaml'),
    [
      'name: claude',
      'runtime_family: claude',
      'binary: claude',
      'model: claude-test',
      'home_config_subdir: .claude',
      'session_log_dir: .claude/projects',
      "session_log_glob: '**/*.jsonl'",
      'normalizer: claude',
      'default_credential: cred_a',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'scenarios', 'scn-a'), { recursive: true });
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'story.md'),
    '---\nquorum_tier: full\n---\nDo the thing.\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'setup.sh'),
    '#!/usr/bin/env bash\n:\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'cli', 'index.ts'),
    "if (process.argv.includes('--version')) console.log('quorum-test 0.0.0');\n",
  );
  commitWithLockfile(dir); // the snapshot's bun install --frozen-lockfile needs a committed lockfile
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Give a fixture repo a dependency-less package.json + lockfile and commit
 *  everything — materializeEvalsSnapshot runs `bun install
 *  --frozen-lockfile` in every checked-out tree. */
function commitWithLockfile(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  const installed = spawnSync('bun', ['install'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (installed.status !== 0)
    throw new Error(`fixture bun install failed: ${installed.stderr}`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
}

function gauntletRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'gauntlet fixture\n');
  commitWithLockfile(dir);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Real runner everywhere EXCEPT the merge-base child-contract check, which
 *  the fixture repo cannot contain (the real D2 merge SHA). The fake answers
 *  that one call; everything else runs for real. */
function probeRunner(mergeBaseStatus: 0 | 1): CommandRunner {
  return {
    run(
      command: string,
      args: readonly string[],
      options?: CommandOptions,
    ): CommandResult {
      if (command === 'git' && args.includes('merge-base')) {
        return {
          status: mergeBaseStatus,
          stdout: '',
          stderr: mergeBaseStatus === 0 ? '' : 'not an ancestor\n',
        };
      }
      return defaultCommandRunner.run(command, args, options);
    },
  };
}

const SUITE_RAW = [
  'schema_version: 1',
  'name: testsuite',
  'kind: exploratory',
  'budget_usd: 100',
  'grader: { credential: cred_a, model: grader-model }',
  'comparisons:',
  '  - baseline: arm_a',
  '    treatment: arm_b',
  '    scenarios: [scn-a]',
  '    n: 1',
  '',
].join('\n');

function registerArgs(overrides: Partial<RegisterArgs> = {}): RegisterArgs {
  const evals = evalsRepo();
  const gauntlet = gauntletRepo();
  return {
    suitePath: 'suites/testsuite.yaml',
    suiteRaw: SUITE_RAW,
    campaignsRoot: mkdtempSync(join(tmpdir(), 'campaigns-')),
    estimates: estimates(),
    globalCap: 8,
    confirm: true,
    dryRun: false,
    evalsCheckout: evals.dir,
    evalsRef: evals.sha,
    gauntletCheckout: gauntlet.dir,
    gauntletRef: gauntlet.sha,
    superpowersCheckout: mkdtempSync(join(tmpdir(), 'sp-')),
    runner: probeRunner(0),
    clock: new FakeClock(1),
    identity: LOCAL_IDENTITY,
    probe: FAKE_PROBE,
    env: () => 'set',
    registeredBy: 'test',
    nowMs: Date.parse('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}

test('registerCampaign: snapshot-first intake, digest dir naming, P-4 publication order', () => {
  const result = registerCampaign(registerArgs());
  expect(result.published).toBe(true);
  expect(result.campaign_id).toBe(result.digest);
  // Dir name = first-8 digest hex + suite name (Decision D-6).
  expect(
    result.campaignDir.endsWith(`${result.digest.slice(0, 8)}-testsuite`),
  ).toBe(true);
  // Publication artifacts all present; campaign.json is the readiness marker.
  for (const f of [
    'journal.db',
    'contention-telemetry.jsonl',
    '.ballast',
    'campaign.json',
    '.quorum-snapshot-ok',
  ]) {
    expect(existsSync(join(result.campaignDir, f))).toBe(true);
  }
  const doc = JSON.parse(
    readFileSync(join(result.campaignDir, 'campaign.json'), 'utf8'),
  );
  expect(doc.digest).toBe(result.digest);
  expect(doc.contention.global_run_cap).toBe(8);
  expect(doc.grader).toEqual({ credential: 'cred_a', model: 'grader-model' });
  expect(
    doc.execution_surface.map((a: { name: string }) => a.name).sort(),
  ).toEqual(['arm_a', 'arm_b']);
  // Snapshot landed at the campaign dir itself (Decision D-6).
  expect(
    existsSync(join(result.campaignDir, 'evals', 'credentials.yaml')),
  ).toBe(true);
  // Operator surface: digest + derived max-block reading (Decision D-1).
  expect(result.printed).toMatch(new RegExp(`digest: ${result.digest}`));
  expect(result.printed).toContain('global_run_cap = 8 per-sample slots');
  expect(result.printed).toContain('max contemporaneous two-arm blocks = 4');
});
test('idempotent re-registration: same input -> same digest -> same dir, no republish', () => {
  const args = registerArgs();
  const first = registerCampaign(args);
  const markerBytes = readFileSync(
    join(first.campaignDir, 'campaign.json'),
    'utf8',
  );
  const second = registerCampaign(args);
  expect(second.campaignDir).toBe(first.campaignDir);
  expect(second.digest).toBe(first.digest);
  expect(second.published).toBe(false); // re-opening validates digest equality only
  // The marker is byte-identical and campaign_opened is never re-journaled
  // (R-REG-22): exactly one event in the journal.
  expect(readFileSync(join(second.campaignDir, 'campaign.json'), 'utf8')).toBe(
    markerBytes,
  );
  const reader = openJournalRead(second.campaignDir);
  const events = reader.readEvents();
  reader.close();
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('campaign_opened');
});

/** Freeze every write surface, then register: TMPDIR is redirected to a
 *  read-only dir (any scratch write — even one cleaned up before returning —
 *  throws EACCES and fails the run) and the campaigns root sits under a
 *  read-only holder (creating it throws). Post-hoc listing diffs cannot see
 *  transient writes; frozen surfaces turn them into loud failures. */
function registerWithWriteSurfacesFrozen(overrides: Partial<RegisterArgs>): {
  result: RegisterResult;
  campaignsRoot: string;
  frozenTmp: string;
} {
  const args = registerArgs(overrides); // fixtures land in the REAL tmpdir first
  const holder = mkdtempSync(join(tmpdir(), 'no-writes-'));
  const frozenTmp = mkdtempSync(join(tmpdir(), 'no-writes-tmp-'));
  const campaignsRoot = join(holder, 'campaigns'); // never created by the flow
  const prevTmp = getEnv('TMPDIR');
  chmodSync(holder, 0o555);
  chmodSync(frozenTmp, 0o555);
  setProcessEnv('TMPDIR', frozenTmp);
  try {
    const result = registerCampaign({ ...args, campaignsRoot });
    return { result, campaignsRoot, frozenTmp };
  } finally {
    if (prevTmp === undefined) deleteProcessEnv('TMPDIR');
    else setProcessEnv('TMPDIR', prevTmp);
    chmodSync(holder, 0o755);
    chmodSync(frozenTmp, 0o755);
  }
}

test('dry-run prints grid + exclusions + digest, never writes', () => {
  const { result, campaignsRoot, frozenTmp } = registerWithWriteSurfacesFrozen({
    dryRun: true,
  });
  expect(result.published).toBe(false);
  expect(result.campaignDir).toBe('');
  expect(result.printed).toMatch(/digest: [0-9a-f]{64}/);
  // No writes AT ALL (finding 2, round-2 finding 3a): the campaigns root is
  // never created and no scratch — transient or not — ever landed in TMPDIR.
  expect(existsSync(campaignsRoot)).toBe(false);
  expect(readdirSync(frozenTmp)).toEqual([]);
});

test('without --confirm: print-and-exit path, never prompts (noninteractive)', () => {
  const { result, campaignsRoot, frozenTmp } = registerWithWriteSurfacesFrozen({
    confirm: false,
  });
  expect(result.published).toBe(false);
  expect(result.campaignDir).toBe('');
  expect(result.printed).toMatch(/global_run_cap = 8/);
  expect(existsSync(campaignsRoot)).toBe(false);
  expect(readdirSync(frozenTmp)).toEqual([]);
});

test('child-contract probe refuses an evals SHA below the minimum commit', () => {
  expect(() =>
    registerCampaign(registerArgs({ runner: probeRunner(1) })),
  ).toThrow(new RegExp(MINIMUM_CHILD_CONTRACT_SHA.slice(0, 12)));
});

test('intake bytes come from the frozen SHA, and the materialized tree is verified against them', () => {
  // Mutate the working tree AFTER the fixture commit: registration must not
  // see the mutation (intake is git-object content at the resolved SHA).
  const args = registerArgs();
  writeFileSync(
    join(args.evalsCheckout, 'credentials.yaml'),
    'corrupted: true\n',
  );
  const result = registerCampaign(args);
  expect(result.published).toBe(true);
  const materialized = readFileSync(
    join(result.campaignDir, 'evals', 'credentials.yaml'),
    'utf8',
  );
  expect(materialized).toContain('cred_a:');
  expect(materialized).not.toContain('corrupted');
});

// Both intake readers (object store for the digest, materialized tree for
// the authoritative recompute) must read the scenario directives, or a tier
// selector spends on cells the arm's agent cannot run. A published
// registration exercises both and their digest agreement.
test('scenario `# coding-agents:` and `# os:` directives reach the intake at the frozen SHA and drop cells loudly', () => {
  const evals = evalsRepo();
  const directiveScenarios = [
    ['scn-codex', '# coding-agents: codex\n'],
    ['scn-win', '# os: windows\n'],
  ] as const;
  for (const [name, header] of directiveScenarios) {
    mkdirSync(join(evals.dir, 'scenarios', name), { recursive: true });
    writeFileSync(
      join(evals.dir, 'scenarios', name, 'story.md'),
      '---\nquorum_tier: full\n---\nDo the thing.\n',
    );
    writeFileSync(
      join(evals.dir, 'scenarios', name, 'checks.sh'),
      `${header}pre() { :; }\npost() { :; }\n`,
    );
  }
  git(evals.dir, ['add', '.']);
  git(evals.dir, ['commit', '-qm', 'directive scenarios']);
  const result = registerCampaign(
    registerArgs({
      evalsCheckout: evals.dir,
      evalsRef: git(evals.dir, ['rev-parse', 'HEAD']),
      suiteRaw: SUITE_RAW.replace('scenarios: [scn-a]', 'scenarios: tier=full'),
    }),
  );
  expect(result.published).toBe(true);
  expect(result.printed).toMatch(/grid: 1 cells, 2 samples, 1 blocks/);
  expect(result.excluded_cells.map((e) => e.cell).sort()).toEqual([
    'c1:scn-codex',
    'c1:scn-win',
  ]);
  const reasonOf = (cell: string): string =>
    result.excluded_cells.find((e) => e.cell === cell)?.reason ?? '';
  expect(reasonOf('c1:scn-codex')).toMatch(
    /arm arm_a agent claude outside the scenario's coding-agents directive \(codex\)/,
  );
  expect(reasonOf('c1:scn-win')).toMatch(
    /os linux unsupported by scenario directive \(windows\)/,
  );
});

test('C3 public intake: pricingOverrides persist into campaign.json pricing_overrides', () => {
  const overrides: PricingOverride[] = [
    {
      applies_to_grader: true,
      per_token_usd: 0.000002,
      rationale:
        'operator ruling 2026-08-27: grader priced per-token (tokens_total_median)',
    },
  ];
  const result = registerCampaign(
    registerArgs({ pricingOverrides: overrides }),
  );
  expect(result.published).toBe(true);
  const doc = JSON.parse(
    readFileSync(join(result.campaignDir, 'campaign.json'), 'utf8'),
  );
  expect(doc.pricing_overrides).toEqual(overrides);
  // The attested grader silences the exploratory unattested-grader caveat.
  expect(result.printed).not.toContain('unattested');
});

test('R-REG-19 registration preflight: a missing arm key env refuses, naming it', () => {
  const env = (key: string) => (key === 'TEST_KEY_B' ? undefined : 'set');
  expect(() => registerCampaign(registerArgs({ env }))).toThrow(/TEST_KEY_B/);
  // Refusal happens before anything lands under the campaigns root.
});

// ── fix round 1 (findings 1–5) ─────────────────────────────────────────────

/** Pass-through JournalFsOps (every call hits the real fs) — the seam the
 *  publication primitives run through, so a test can observe intermediate
 *  publication states without mocking behavior away. */
function passthroughFsOps(): JournalFsOps {
  return {
    openExclusive: (path) => openSync(path, 'wx'),
    openRead: (path) => openSync(path, 'r'),
    close: closeSync,
    write: (fd, data) =>
      typeof data === 'string' ? writeSync(fd, data) : writeSync(fd, data),
    fsync: fsyncSync,
    rename: renameSync,
    link: linkSync,
    unlink: unlinkSync,
    stat: (path) => statSync(path),
    exists: existsSync,
  };
}

test('P-4 order observable: snapshot complete at child-probe time; campaign_opened backs the marker', () => {
  const args = registerArgs();
  let probedDir = '';
  // Observed at child-probe time (false until the probe runs).
  let journalAtProbe = false;
  let markerAtProbe = false;
  let ballastAtProbe = false;
  const wrapped: CommandRunner = {
    run(
      command: string,
      cargs: readonly string[],
      options?: CommandOptions,
    ): CommandResult {
      const res = probeRunner(0).run(command, cargs, options);
      if (
        command === 'bun' &&
        cargs.includes('--version') &&
        options?.cwd?.endsWith('/evals')
      ) {
        probedDir = dirname(options.cwd);
        journalAtProbe = existsSync(join(probedDir, 'journal.db'));
        markerAtProbe = existsSync(join(probedDir, 'campaign.json'));
        ballastAtProbe = existsSync(join(probedDir, '.ballast'));
      }
      return res;
    },
  };
  // Round-2 finding 3b: observe the INTERMEDIATE publication state through
  // the publication-primitive fs seam — at the instant the marker rename
  // fires, campaign.json must not exist yet while campaign_opened is already
  // COMMITTED in the journal (P-4: the journal precedes the marker).
  let markerExistedAtRename = true;
  let openedDigestAtRename: string | undefined;
  const realOps = passthroughFsOps();
  const fsOps: JournalFsOps = {
    ...realOps,
    rename: (from, to) => {
      if (basename(to) === 'campaign.json') {
        markerExistedAtRename = existsSync(to);
        const atRename = openJournalRead(dirname(to));
        try {
          const first = atRename.readEvents()[0];
          openedDigestAtRename =
            first !== undefined && first.type === 'campaign_opened'
              ? first.payload.digest
              : undefined;
        } finally {
          atRename.close();
        }
      }
      realOps.rename(from, to);
    },
  };
  const result = registerCampaign({ ...args, runner: wrapped, fsOps });
  expect(probedDir).toBe(result.campaignDir);
  // Materialization completed FIRST (snapshot marker present) and none of
  // journal/ballast/campaign.json existed yet at child-probe time.
  expect(existsSync(join(probedDir, '.quorum-snapshot-ok'))).toBe(true);
  expect(journalAtProbe).toBe(false);
  expect(ballastAtProbe).toBe(false);
  expect(markerAtProbe).toBe(false);
  // The intermediate state was observed: committed campaign_opened while
  // campaign.json was still absent.
  expect(markerExistedAtRename).toBe(false);
  expect(openedDigestAtRename).toBe(result.digest);
  // Post-state: campaign_opened is the first committed event and the
  // readiness marker exists — the publication helper gates the rename on
  // exactly that journal content (P-4/S-8).
  const reader = openJournalRead(result.campaignDir);
  const events = reader.readEvents();
  reader.close();
  expect(events[0]?.type).toBe('campaign_opened');
  expect(events[0]?.payload).toEqual({
    campaign_id: result.digest,
    digest: result.digest,
  });
  expect(existsSync(join(result.campaignDir, 'campaign.json'))).toBe(true);
});

test('materialized tree byte-mismatch vs the object-store intake refuses publication', () => {
  const args = registerArgs();
  const tamper: CommandRunner = {
    run(
      command: string,
      cargs: readonly string[],
      options?: CommandOptions,
    ): CommandResult {
      const res = probeRunner(0).run(command, cargs, options);
      if (
        command === 'bun' &&
        cargs.includes('install') &&
        options?.cwd?.startsWith(args.campaignsRoot) &&
        options.cwd.endsWith('/evals')
      ) {
        // Corrupt the materialized FINAL-path tree after the real install:
        // verifyIntakeMatch must refuse (fail-closed), naming the path.
        writeFileSync(
          join(options.cwd, 'credentials.yaml'),
          'tampered: true\n',
        );
      }
      return res;
    },
  };
  expect(() => registerCampaign({ ...args, runner: tamper })).toThrow(
    /drifted from intake bytes/,
  );
});

test('an unexpected existing campaign.json at the publish step fails closed', () => {
  const args = registerArgs();
  const interloper: CommandRunner = {
    run(
      command: string,
      cargs: readonly string[],
      options?: CommandOptions,
    ): CommandResult {
      const res = probeRunner(0).run(command, cargs, options);
      if (
        command === 'bun' &&
        cargs.includes('--version') &&
        options?.cwd?.endsWith('/evals')
      ) {
        // Simulate a campaign.json landing between classification and the
        // publish step: the publication helper's already-published refusal
        // must fire — never a silent skip past the marker.
        writeFileSync(
          join(dirname(options.cwd), 'campaign.json'),
          JSON.stringify({ digest: 'e'.repeat(64) }),
        );
      }
      return res;
    },
  };
  expect(() => registerCampaign({ ...args, runner: interloper })).toThrow(
    /already published/,
  );
});

test('D-6 collision with a published foreign digest extends the prefix, never overwrites', () => {
  const args = registerArgs();
  const dry = registerCampaign({ ...args, dryRun: true });
  const foreign = join(
    args.campaignsRoot,
    `${dry.digest.slice(0, 8)}-testsuite`,
  );
  mkdirSync(foreign, { recursive: true });
  writeFileSync(
    join(foreign, 'campaign.json'),
    JSON.stringify({ digest: 'e'.repeat(64) }),
  );
  const result = registerCampaign(args);
  expect(result.campaignDir).toBe(
    join(args.campaignsRoot, `${dry.digest.slice(0, 12)}-testsuite`),
  );
  expect(result.printed).toContain('collision:');
  // The foreign published dir is untouched (verified prefix extension).
  expect(
    JSON.parse(readFileSync(join(foreign, 'campaign.json'), 'utf8')).digest,
  ).toBe('e'.repeat(64));
});

test('D-6 prefix extension is bounded: full-digest collisions refuse loudly', () => {
  const args = registerArgs();
  const dry = registerCampaign({ ...args, dryRun: true });
  const occupantDigest = 'f'.repeat(64);
  const dirs: string[] = [];
  for (let len = 8; len <= dry.digest.length; len += 4) {
    const dir = join(
      args.campaignsRoot,
      `${dry.digest.slice(0, len)}-testsuite`,
    );
    mkdirSync(dir, { recursive: true });
    // Digest-BEARING occupants: published campaign.json with a foreign digest.
    writeFileSync(
      join(dir, 'campaign.json'),
      JSON.stringify({ digest: occupantDigest }),
    );
    dirs.push(dir);
  }
  let refusal: Error | undefined;
  try {
    registerCampaign(args);
  } catch (err) {
    refusal = err as Error;
  }
  // The diagnostic names the exact exhausted candidate dir AND the occupant's
  // conflicting digest, read from its campaign.json (round-2 finding 2).
  const exhaustedCandidate = join(
    args.campaignsRoot,
    `${dry.digest}-testsuite`,
  );
  expect(refusal).toBeInstanceOf(RegistrationError);
  expect(refusal?.message).toContain('collision exhausted');
  expect(refusal?.message).toContain(exhaustedCandidate);
  expect(refusal?.message).toContain(occupantDigest);
  // Nothing was overwritten or removed while extending.
  for (const dir of dirs) {
    expect(
      JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8')).digest,
    ).toBe(occupantDigest);
  }

  // Digest-LESS ambiguous occupants (spend artifact, no identity carrier)
  // exhaust with the no-readable-digest wording, still naming the candidate.
  const ambiguousRoot = mkdtempSync(join(tmpdir(), 'campaigns-'));
  for (let len = 8; len <= dry.digest.length; len += 4) {
    const dir = join(ambiguousRoot, `${dry.digest.slice(0, len)}-testsuite`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cancel-request'), 'spend recorded\n');
  }
  let ambiguousRefusal: Error | undefined;
  try {
    registerCampaign({ ...args, campaignsRoot: ambiguousRoot });
  } catch (err) {
    ambiguousRefusal = err as Error;
  }
  expect(ambiguousRefusal?.message).toContain('no readable digest');
  expect(ambiguousRefusal?.message).toContain(
    join(ambiguousRoot, `${dry.digest}-testsuite`),
  );
}, 30_000);
