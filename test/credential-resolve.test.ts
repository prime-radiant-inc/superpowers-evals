import { describe, expect, test } from 'bun:test';
import type { Credential } from '../src/contracts/credential.ts';
import {
  limiterKey,
  resolveApiKey,
  resolveCredentialName,
} from '../src/credentials/resolve.ts';
import { setProcessEnv } from '../src/env.ts';

const base: Credential = {
  model: 'm',
  harnesses: ['pi'],
  api: 'openai-chat',
  auth: 'api-key',
  compat: {},
};

describe('credential resolution', () => {
  test('explicit beats default', () => {
    expect(resolveCredentialName({ explicit: 'glm', agentDefault: 'x' })).toBe(
      'glm',
    );
    expect(resolveCredentialName({ agentDefault: 'x' })).toBe('x');
  });
  test('api_key_env wins; falls back to conventional', () => {
    setProcessEnv('A2_TEST_GLM_KEY', 'k1');
    setProcessEnv('A2_TEST_CONV_KEY', 'k2');
    expect(
      resolveApiKey(
        { ...base, api_key_env: 'A2_TEST_GLM_KEY' },
        'A2_TEST_CONV_KEY',
      ),
    ).toEqual({ kind: 'env', value: 'k1' });
    expect(resolveApiKey({ ...base }, 'A2_TEST_CONV_KEY')).toEqual({
      kind: 'env',
      value: 'k2',
    });
  });
  test('subscription/oauth resolve native', () => {
    expect(resolveApiKey({ ...base, auth: 'subscription' }, undefined)).toEqual(
      { kind: 'native' },
    );
  });
  test('missing api-key throws', () => {
    // Use a name we never set so getEnv returns undefined
    expect(() =>
      resolveApiKey(
        { ...base, api_key_env: 'A2_TEST_MISSING_NEVER_SET' },
        undefined,
      ),
    ).toThrow();
  });
  test('limiterKey uses base_url then name', () => {
    expect(limiterKey({ ...base, base_url: 'https://e/v1' }, 'glm')).toBe(
      'https://e/v1|openai-chat',
    );
    expect(limiterKey({ ...base }, 'glm')).toBe('glm|openai-chat');
  });
});
