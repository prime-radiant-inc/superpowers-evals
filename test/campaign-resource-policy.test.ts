import { expect, test } from 'bun:test';
import {
  assertFeasible,
  blockDemandVector,
  compileResourcePolicy,
} from '../src/campaign/resource-policy.ts';
import { GLOBAL_POOL } from '../src/campaign/simulate.ts';
import {
  type Credential,
  CredentialSchema,
} from '../src/contracts/credential.ts';

function credential(overrides: Partial<Credential> = {}): Credential {
  return CredentialSchema.parse({
    model: 'model',
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: 'TEST_KEY',
    harnesses: ['claude'],
    max_concurrency: 8,
    ...overrides,
  });
}

test('all aliases constrain one active pool independent of registry order', () => {
  const loose = credential({
    quota_pool: 'shared',
    max_concurrency: 9,
    launch_spacing_seconds: 1,
  });
  const tight = credential({
    quota_pool: 'shared',
    max_concurrency: 3,
    launch_spacing_seconds: 4,
  });
  const first = compileResourcePolicy({ subject: loose, unused_alias: tight }, [
    'subject',
  ]);
  const second = compileResourcePolicy(
    { unused_alias: tight, subject: loose },
    ['subject'],
  );

  expect([...first.values()]).toEqual([
    {
      pool_id: 'shared',
      max_concurrency: 3,
      launch_spacing_seconds: 4,
    },
  ]);
  expect([...second.values()]).toEqual([...first.values()]);

  const fits = new Map([
    ['shared', 3],
    [GLOBAL_POOL, 1],
  ]);
  expect(() => assertFeasible(fits, first, 1)).not.toThrow();
  expect(() => assertFeasible(fits, second, 1)).not.toThrow();
  const exceeds = new Map([
    ['shared', 4],
    [GLOBAL_POOL, 1],
  ]);
  expect(() => assertFeasible(exceeds, first, 1)).toThrow(/shared.*4.*3/);
  expect(() => assertFeasible(exceeds, second, 1)).toThrow(/shared.*4.*3/);
});

test('shared grader and subject consume the same compiled pool', () => {
  const policy = compileResourcePolicy(
    {
      subject: credential({ quota_pool: 'shared', max_concurrency: 2 }),
      grader: credential({ quota_pool: 'shared', max_concurrency: 1 }),
    },
    ['subject', 'grader'],
  );
  const demand = blockDemandVector({
    block: { sample_ids: ['baseline', 'treatment'] },
    sampleArmCredentialPool: () => 'shared',
    graderPool: 'shared',
  });

  expect(demand).toEqual(
    new Map([
      ['shared', 4],
      [GLOBAL_POOL, 2],
    ]),
  );
  expect(() => assertFeasible(demand, policy, 8)).toThrow(/shared.*4.*1/);
});

test('global feasibility is checked independently of credential pools', () => {
  const policy = compileResourcePolicy(
    { subject: credential({ max_concurrency: 8 }) },
    ['subject'],
  );
  const poolId = [...policy.keys()][0]!;
  const demand = new Map([
    [poolId, 2],
    [GLOBAL_POOL, 2],
  ]);

  expect(() => assertFeasible(demand, policy, 1)).toThrow(/global.*2.*1/i);
});

test('an active pool needs at least one explicit concurrency declaration', () => {
  const registry = {
    subject: credential({ max_concurrency: undefined }),
  };
  expect(() => compileResourcePolicy(registry, ['subject'])).toThrow(
    /needs an explicit concurrency limit/,
  );
});

test('a credential pool cannot collide with the reserved global pool', () => {
  const registry = {
    subject: credential({ quota_pool: GLOBAL_POOL }),
  };

  expect(() => compileResourcePolicy(registry, ['subject'])).toThrow(
    /reserved global pool/,
  );
});
