import { expect, test } from 'bun:test';
import {
  KeySelectionError,
  type KeyWaitNotice,
  keyWaitThreshold,
  resolveKeyForSpawn,
  resolveKeyForSpawnWithWait,
  selectKey,
  warnKeyWait,
} from '../src/campaign/key-select.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

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
      cred: bareBearer,
      credentialName: 'opus_bedrock',
      inFlight: {},
    }),
  ).toEqual({
    kind: 'use',
    grant: { envName: 'AWS_BEARER_TOKEN_BEDROCK' },
  });
});

test('D-2 warnings: entry names the credential; resolution carries the MEASURED wait; invalid measurements fail closed', () => {
  const written: string[] = [];
  const stream = { write: (s: string) => written.push(s) };
  warnKeyWait(stream, { phase: 'entry', credentialName: 'cred_a' });
  warnKeyWait(stream, {
    phase: 'resolution',
    credentialName: 'cred_a',
    waitMs: 2500,
  });
  expect(written[0]).toMatch(/cred_a/);
  expect(written[0]).toMatch(/wait/i);
  expect(written[1]).toMatch(/cred_a/);
  expect(written[1]).toMatch(/2500/);
  expect(written[1]).toMatch(/spawn-gap|wait/i);
  // Boundary: a measured zero is finite and nonnegative — reportable.
  warnKeyWait(stream, {
    phase: 'resolution',
    credentialName: 'cred_b',
    waitMs: 0,
  });
  expect(written[2]).toMatch(/0ms/);
  // Fail-closed (D-2): the measured duration is required, never defaulted.
  // Omission, NaN, negative, and infinite all refuse to report.
  expect(() =>
    warnKeyWait(stream, {
      phase: 'resolution',
      credentialName: 'c',
    } as unknown as KeyWaitNotice),
  ).toThrow(KeySelectionError);
  expect(() =>
    warnKeyWait(stream, {
      phase: 'resolution',
      credentialName: 'c',
      waitMs: Number.NaN,
    }),
  ).toThrow(KeySelectionError);
  expect(() =>
    warnKeyWait(stream, {
      phase: 'resolution',
      credentialName: 'c',
      waitMs: -1,
    }),
  ).toThrow(KeySelectionError);
  expect(() =>
    warnKeyWait(stream, {
      phase: 'resolution',
      credentialName: 'c',
      waitMs: Number.POSITIVE_INFINITY,
    }),
  ).toThrow(KeySelectionError);
  expect(written).toHaveLength(3); // refused reports write nothing
});

test('withWait: key wait rides the injected Clock — entry/resolution warnings carry the measured wait', async () => {
  const clock = new FakeClock();
  const written: string[] = [];
  const cred = poolCredential(['K1', 'K2'], 4); // per-key threshold 2
  const inFlight: Record<string, number> = { K1: 2, K2: 2 };
  const pending = resolveKeyForSpawnWithWait({
    cred,
    credentialName: 'cred_pool',
    inFlight,
    clock,
    warn: { write: (s) => written.push(s) },
    waitSeconds: 30,
    pollSeconds: 2.5,
  });
  // A dispatcher-side release on the SAME persistent map frees K2 mid-wait.
  inFlight['K2'] = 1;
  clock.advance(2.5);
  const resolution = await pending;
  expect(resolution).toEqual({ kind: 'use', grant: { envName: 'K2' } });
  expect(clock.now()).toBe(2.5); // zero wall time — FakeClock moved only when driven
  expect(written).toHaveLength(2);
  expect(written[0]).toMatch(/key wait entered for credential cred_pool/);
  expect(written[1]).toMatch(
    /key wait resolved for credential cred_pool after 2500ms/,
  );
});

test('withWait: bounded exhaustion — fails LOUD (KeySelectionError) once the full budget is spent; no resolution warning', async () => {
  const clock = new FakeClock();
  const written: string[] = [];
  const cred = poolCredential(['K1'], 1); // threshold 1
  const pending = resolveKeyForSpawnWithWait({
    cred,
    credentialName: 'cred_stuck',
    inFlight: { K1: 9 }, // pinned at/over cap for the whole budget
    clock,
    warn: { write: (s) => written.push(s) },
    waitSeconds: 10,
    pollSeconds: 2,
  });
  const start = clock.now();
  // Drive each parked poll step straight to its wake time until the budget is spent.
  const driver = (async () => {
    for (;;) {
      const next = clock.earliestWaiter();
      if (next === null) return;
      clock.setTo(next);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  await expect(pending).rejects.toBeInstanceOf(KeySelectionError);
  await expect(pending).rejects.toThrow(/failing loud/);
  await driver;
  expect(clock.now() - start).toBeGreaterThanOrEqual(10);
  expect(written).toHaveLength(1); // entry only — an exhausted wait never resolves
  expect(written[0]).toMatch(/cred_stuck/);
});

test('withWait: subject and grader resolve independently — separate credentials and counter maps, no cross-talk', async () => {
  const clock = new FakeClock();
  const written: string[] = [];
  const warn = { write: (s: string) => written.push(s) };
  const subject = poolCredential(['S1', 'S2'], 2); // threshold 1
  const grader = poolCredential(['G1', 'G2'], 2);
  const subjectInFlight: Record<string, number> = { S1: 1 };
  const graderInFlight: Record<string, number> = { G1: 0, G2: 1 };
  const [subjectRes, graderRes] = await Promise.all([
    resolveKeyForSpawnWithWait({
      cred: subject,
      credentialName: 'subject_arm',
      inFlight: subjectInFlight,
      clock,
      warn,
      waitSeconds: 5,
    }),
    resolveKeyForSpawnWithWait({
      cred: grader,
      credentialName: 'grader_arm',
      inFlight: graderInFlight,
      clock,
      warn,
      waitSeconds: 5,
    }),
  ]);
  expect(subjectRes).toEqual({ kind: 'use', grant: { envName: 'S2' } });
  expect(graderRes).toEqual({ kind: 'use', grant: { envName: 'G1' } });
  expect(written).toHaveLength(0); // neither role waited
  expect(clock.now()).toBe(0);
});

test('withWait: the dispatcher-owned counter map persists across samples — never recreated', async () => {
  const clock = new FakeClock();
  const written: string[] = [];
  const warn = { write: (s: string) => written.push(s) };
  const cred = poolCredential(['K1', 'K2'], 4); // threshold 2
  const inFlight: Record<string, number> = {}; // ONE map for the pool's whole life
  const resolve = () =>
    resolveKeyForSpawnWithWait({
      cred,
      credentialName: 'c',
      inFlight,
      clock,
      warn,
      waitSeconds: 5,
    });
  expect(await resolve()).toEqual({ kind: 'use', grant: { envName: 'K1' } });
  inFlight['K1'] = (inFlight['K1'] ?? 0) + 1; // dispatcher books sample 1's grant
  expect(await resolve()).toEqual({ kind: 'use', grant: { envName: 'K2' } }); // sees K1's load
  inFlight['K2'] = (inFlight['K2'] ?? 0) + 1;
  expect(await resolve()).toEqual({ kind: 'use', grant: { envName: 'K1' } }); // 1-1 tie: pool order
  expect(written).toHaveLength(0); // honest admission never waits
  expect(clock.now()).toBe(0);
});
