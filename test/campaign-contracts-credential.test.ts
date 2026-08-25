// test/campaign-contracts-credential.test.ts

import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialSchema } from '../src/contracts/credential.ts';
import { checkCredentials } from '../src/credentials/check.ts';

const BASE = {
  model: 'claude-opus-5',
  api: 'anthropic',
  auth: 'api-key',
  api_key_env: 'ANTHROPIC_API_KEY',
  harnesses: ['claude'],
};

test('quota_pool and key_pool are optional additions — existing entries parse unchanged', () => {
  expect(CredentialSchema.parse(BASE)).toMatchObject({
    model: 'claude-opus-5',
  });
});

test('quota_pool accepts pool names and rejects other character sets', () => {
  expect(
    CredentialSchema.parse({ ...BASE, quota_pool: 'openai_responses' })
      .quota_pool,
  ).toBe('openai_responses');
  expect(() =>
    CredentialSchema.parse({ ...BASE, quota_pool: 'pool|with|pipes' }),
  ).toThrow();
});

test('key_pool holds env-var names', () => {
  const pooled = CredentialSchema.parse({
    ...BASE,
    api_key_env: undefined,
    key_pool: ['GRADER_KEY_1', 'GRADER_KEY_2', 'GRADER_KEY_3'],
  });
  expect(pooled.key_pool).toEqual([
    'GRADER_KEY_1',
    'GRADER_KEY_2',
    'GRADER_KEY_3',
  ]);
});

test('key_pool is mutually exclusive with api_key_env', () => {
  expect(() =>
    CredentialSchema.parse({ ...BASE, key_pool: ['K1', 'K2'] }),
  ).toThrow(/key_pool/);
});

test('key_pool requires auth: api-key', () => {
  expect(() =>
    CredentialSchema.parse({
      ...BASE,
      auth: 'oauth',
      api_key_env: undefined,
      key_pool: ['K1'],
    }),
  ).toThrow(/key_pool/);
});

test('key_pool entries must be unique (a duplicated env var is one key, not two)', () => {
  expect(() =>
    CredentialSchema.parse({
      ...BASE,
      api_key_env: undefined,
      key_pool: ['GRADER_KEY_1', 'GRADER_KEY_2', 'GRADER_KEY_1'],
    }),
  ).toThrow(/unique/);
});

test('key_pool rejects empty arrays and invalid env names', () => {
  expect(() =>
    CredentialSchema.parse({ ...BASE, api_key_env: undefined, key_pool: [] }),
  ).toThrow();
  expect(() =>
    CredentialSchema.parse({
      ...BASE,
      api_key_env: undefined,
      key_pool: ['9bad'],
    }),
  ).toThrow();
});

test('checkCredentials surfaces key_pool violations through the parse path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-check-'));
  const agentsDir = join(dir, 'coding-agents');
  const credPath = join(dir, 'credentials.yaml');
  writeFileSync(
    credPath,
    [
      'bad_pool:',
      '  model: claude-opus-5',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: ANTHROPIC_API_KEY',
      '  key_pool: [K1, K2]',
      '  harnesses: [claude]',
    ].join('\n'),
  );
  const { ok, errors } = checkCredentials(credPath, agentsDir);
  expect(ok).toBe(false);
  expect(errors.join('\n')).toMatch(/key_pool/);
});
