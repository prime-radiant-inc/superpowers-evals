import { expect, test } from 'bun:test';
import {
  PROFILE_PARAM_SCHEMAS,
  profileParamsSchema,
  ReleaseGateV1ParamsSchema,
} from '../src/contracts/campaign/profile-params.ts';

const VALID = {
  alpha: 0.05,
  determinate_n_floor: 4,
  completion_divergence_max: 0.2,
  mde_by_scenario: { 'sdd-escalates': 0.15, 'fractals-smoke': 0.2 },
};

test('release_gate_v1 parameters (alphas, floors, deltas) validate', () => {
  expect(ReleaseGateV1ParamsSchema.parse(VALID)).toEqual(VALID);
});

test('parameter ranges are enforced', () => {
  expect(() =>
    ReleaseGateV1ParamsSchema.parse({ ...VALID, alpha: 1 }),
  ).toThrow();
  expect(() =>
    ReleaseGateV1ParamsSchema.parse({ ...VALID, alpha: 0 }),
  ).toThrow();
  expect(() =>
    ReleaseGateV1ParamsSchema.parse({ ...VALID, determinate_n_floor: 0 }),
  ).toThrow();
  expect(() =>
    ReleaseGateV1ParamsSchema.parse({
      ...VALID,
      completion_divergence_max: 1.5,
    }),
  ).toThrow();
  expect(() =>
    ReleaseGateV1ParamsSchema.parse({ ...VALID, mde_by_scenario: { s: -1 } }),
  ).toThrow();
});

test('the registry is a frozen built-in map, not a mutable global', () => {
  expect(Object.isFrozen(PROFILE_PARAM_SCHEMAS)).toBe(true);
  expect(profileParamsSchema('release_gate_v1')).toBe(
    ReleaseGateV1ParamsSchema,
  );
  expect(profileParamsSchema('descriptive_v1')).toBeDefined();
  expect(profileParamsSchema('invented_v9')).toBeUndefined();
});

test('descriptive_v1 takes no parameters', () => {
  expect(profileParamsSchema('descriptive_v1')?.parse({})).toEqual({});
  expect(() =>
    profileParamsSchema('descriptive_v1')?.parse({ alpha: 0.1 }),
  ).toThrow();
});

test('unknown parameter keys reject (strict)', () => {
  expect(() =>
    ReleaseGateV1ParamsSchema.parse({ ...VALID, p_hacking: true }),
  ).toThrow();
});

test('prototype-key lookups miss, returning undefined', () => {
  // Unknown names must never surface inherited Object.prototype values
  // (a caller treating a truthy miss as a schema would TypeError on .parse).
  expect(profileParamsSchema('toString')).toBeUndefined();
  expect(profileParamsSchema('constructor')).toBeUndefined();
  expect(profileParamsSchema('__proto__')).toBeUndefined();
  expect(profileParamsSchema('hasOwnProperty')).toBeUndefined();
});
