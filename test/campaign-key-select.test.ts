import { expect, test } from 'bun:test';
import {
  KeySelectionError,
  keyWaitThreshold,
  resolveKeyForSpawn,
  selectKey,
} from '../src/campaign/key-select.ts';
import type { Credential } from '../src/contracts/credential.ts';

function poolCredential(keys: string[], maxConcurrency?: number): Credential {
  return {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
    key_pool: keys,
    ...(maxConcurrency !== undefined
      ? { max_concurrency: maxConcurrency }
      : {}),
  } as Credential;
}

test('keyWaitThreshold divides the frozen capacity across keys', () => {
  expect(keyWaitThreshold(poolCredential(['k1', 'k2'], 100), 15)).toBe(8); // ceil(15/2)
  expect(keyWaitThreshold(poolCredential(['k1', 'k2', 'k3'], 100), 15)).toBe(5); // ceil(15/3)
  expect(keyWaitThreshold(poolCredential(['k1', 'k2']), 2)).toBe(1);
});

test('selectKey: least-loaded key wins; wait when every key is at the threshold', () => {
  const cred = poolCredential(['k1', 'k2'], 4); // threshold = 2 per key
  expect(selectKey(cred, {}, 4)).toEqual({
    kind: 'use',
    grant: { envName: 'k1' },
  });
  expect(selectKey(cred, { k1: 1 }, 4)).toEqual({
    kind: 'use',
    grant: { envName: 'k2' },
  });
  expect(selectKey(cred, { k1: 2, k2: 2 }, 4)).toEqual({ kind: 'wait' });
  // Least-loaded among equals is deterministic (first in pool order).
  expect(selectKey(cred, { k1: 1, k2: 1 }, 4)).toEqual({
    kind: 'use',
    grant: { envName: 'k1' },
  });
});

test('resolveKeyForSpawn: singular api_key_env uses; non-api-key is native; missing grant fails LOUD (no harness fallback)', () => {
  const singular = {
    ...poolCredential(['x']),
    key_pool: undefined,
    api_key_env: 'SINGLE',
  } as Credential;
  expect(
    resolveKeyForSpawn({
      poolCapacity: 4,
      cred: singular,
      credentialName: 'c',
      inFlight: {},
    }),
  ).toEqual({
    kind: 'use',
    grant: { envName: 'SINGLE' },
  });
  // Deletion overrides (explicit undefined strips the pool fields) — the cast
  // exists only because exactOptionalPropertyTypes rejects them inline.
  const native = {
    ...poolCredential(['x']),
    key_pool: undefined,
    auth: 'oauth',
    api_key_env: undefined,
  } as unknown as Credential;
  expect(
    resolveKeyForSpawn({
      poolCapacity: 4,
      cred: native,
      credentialName: 'c',
      inFlight: {},
    }),
  ).toEqual({
    kind: 'native',
  });
  const broken = {
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    compat: {},
  } as Credential; // api-key auth, no api_key_env, no key_pool
  expect(() =>
    resolveKeyForSpawn({
      poolCapacity: 4,
      cred: broken,
      credentialName: 'cred_x',
      inFlight: {},
    }),
  ).toThrow(KeySelectionError);
  expect(() =>
    resolveKeyForSpawn({
      poolCapacity: 4,
      cred: broken,
      credentialName: 'cred_x',
      inFlight: {},
    }),
  ).toThrow(/fallback is forbidden/);
});

test('resolveKeyForSpawn: bedrock-bearer grants its bearer env name (campaign children seed Mantle auth from it)', () => {
  const bearer = {
    ...poolCredential(['x']),
    key_pool: undefined,
    api: 'mantle',
    auth: 'bedrock-bearer',
    api_key_env: 'AWS_BEARER_TOKEN_BEDROCK',
  } as unknown as Credential;
  expect(
    resolveKeyForSpawn({
      poolCapacity: 4,
      cred: bearer,
      credentialName: 'opus_bedrock',
      inFlight: {},
    }),
  ).toEqual({
    kind: 'use',
    grant: { envName: 'AWS_BEARER_TOKEN_BEDROCK' },
  });
  // Without an explicit api_key_env the bearer falls back to the
  // registry-conventional name, matching resolveBedrockBearer.
  const bareBearer = {
    ...bearer,
    api_key_env: undefined,
  } as unknown as Credential;
  expect(
    resolveKeyForSpawn({
      poolCapacity: 4,
      cred: bareBearer,
      credentialName: 'opus_bedrock',
      inFlight: {},
    }),
  ).toEqual({
    kind: 'use',
    grant: { envName: 'AWS_BEARER_TOKEN_BEDROCK' },
  });
});

test('key grants obey the frozen aggregate capacity rather than an alias-local cap', () => {
  const cred = poolCredential(['k1', 'k2'], 100);
  expect(
    resolveKeyForSpawn({
      cred,
      credentialName: 'alias',
      inFlight: { k1: 1, k2: 1 },
      poolCapacity: 2,
    }),
  ).toEqual({ kind: 'wait' });
  expect(
    resolveKeyForSpawn({
      cred,
      credentialName: 'alias',
      inFlight: { k1: 1 },
      poolCapacity: 2,
    }),
  ).toEqual({ kind: 'use', grant: { envName: 'k2' } });
});
