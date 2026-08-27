import { expect, test } from 'bun:test';
import {
  KeySelectionError,
  keyWaitThreshold,
  resolveKeyForSpawn,
  selectKey,
  warnKeyWait,
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

test('keyWaitThreshold: ceil(max_concurrency / key_pool.length), default cap = len x 5', () => {
  expect(keyWaitThreshold(poolCredential(['k1', 'k2'], 15))).toBe(8); // ceil(15/2)
  expect(keyWaitThreshold(poolCredential(['k1', 'k2', 'k3'], 15))).toBe(5); // ceil(15/3)
  expect(keyWaitThreshold(poolCredential(['k1', 'k2']))).toBe(5); // default cap 10 / 2
});

test('selectKey: least-loaded key wins; wait when every key is at the threshold', () => {
  const cred = poolCredential(['k1', 'k2'], 4); // threshold = 2 per key
  expect(selectKey(cred, {})).toEqual({
    kind: 'use',
    grant: { envName: 'k1' },
  });
  expect(selectKey(cred, { k1: 1 })).toEqual({
    kind: 'use',
    grant: { envName: 'k2' },
  });
  expect(selectKey(cred, { k1: 2, k2: 2 })).toEqual({ kind: 'wait' });
  // Least-loaded among equals is deterministic (first in pool order).
  expect(selectKey(cred, { k1: 1, k2: 1 })).toEqual({
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
    resolveKeyForSpawn({ cred: singular, credentialName: 'c', inFlight: {} }),
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
    resolveKeyForSpawn({ cred: native, credentialName: 'c', inFlight: {} }),
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
      cred: broken,
      credentialName: 'cred_x',
      inFlight: {},
    }),
  ).toThrow(KeySelectionError);
  expect(() =>
    resolveKeyForSpawn({
      cred: broken,
      credentialName: 'cred_x',
      inFlight: {},
    }),
  ).toThrow(/fallback is forbidden/);
});

test('D-2 loud warnings: entry names the credential; resolution names credential + measured wait', () => {
  const written: string[] = [];
  const stream = { write: (s: string) => written.push(s) };
  warnKeyWait(stream, 'entry', 'cred_a');
  warnKeyWait(stream, 'resolution', 'cred_a', 2500);
  expect(written[0]).toMatch(/cred_a/);
  expect(written[0]).toMatch(/wait/i);
  expect(written[1]).toMatch(/cred_a/);
  expect(written[1]).toMatch(/2500/);
  expect(written[1]).toMatch(/spawn-gap|wait/i);
});
