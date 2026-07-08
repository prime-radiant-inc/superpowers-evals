import { expect, test } from 'bun:test';
import { CredentialSchema } from '../src/contracts/credential.ts';

test('mantle credential parses with api=mantle, auth=bedrock-bearer, region', () => {
  const cred = CredentialSchema.parse({
    model: 'anthropic.claude-opus-4-8',
    harnesses: ['claude'],
    api: 'mantle',
    auth: 'bedrock-bearer',
    api_key_env: 'AWS_BEARER_TOKEN_BEDROCK',
    region: 'us-east-1',
  });
  expect(cred.api).toBe('mantle');
  expect(cred.auth).toBe('bedrock-bearer');
  expect(cred.region).toBe('us-east-1');
});
