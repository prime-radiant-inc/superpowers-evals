import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialSchema } from '../src/contracts/credential.ts';
import { checkCredentials } from '../src/credentials/check.ts';
import { resolveBedrockBearer } from '../src/credentials/resolve.ts';
import { getEnv, setProcessEnv } from '../src/env.ts';

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

test('quorum check rejects a mantle credential with no region', () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'));
  const credsPath = join(dir, 'credentials.yaml');
  writeFileSync(
    credsPath,
    'opus_bedrock:\n  model: anthropic.claude-opus-4-8\n  api: mantle\n  auth: bedrock-bearer\n  api_key_env: AWS_BEARER_TOKEN_BEDROCK\n  harnesses: [claude]\n',
  );
  const agentsDir = mkdtempSync(join(tmpdir(), 'agents-'));
  const res = checkCredentials(credsPath, agentsDir);
  expect(res.ok).toBe(false);
  expect(res.errors.join('\n')).toContain('opus_bedrock');
  expect(res.errors.join('\n')).toContain('region');
});

test('quorum check accumulates the region error even when the coding-agents dir cannot be read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'));
  const credsPath = join(dir, 'credentials.yaml');
  writeFileSync(
    credsPath,
    'opus_bedrock:\n  model: anthropic.claude-opus-4-8\n  api: mantle\n  auth: bedrock-bearer\n  api_key_env: AWS_BEARER_TOKEN_BEDROCK\n  harnesses: [claude]\n',
  );
  const missingAgentsDir = join(dir, 'does-not-exist');
  const res = checkCredentials(credsPath, missingAgentsDir);
  expect(res.ok).toBe(false);
  expect(res.errors.join('\n')).toContain('region');
  expect(res.errors.join('\n')).toContain('cannot read coding-agents dir');
});

test('resolveBedrockBearer throws naming the env var when unset', () => {
  const cred = CredentialSchema.parse({
    model: 'anthropic.claude-opus-4-8',
    harnesses: ['claude'],
    api: 'mantle',
    auth: 'bedrock-bearer',
    api_key_env: 'AWS_BEARER_TOKEN_BEDROCK',
    region: 'us-east-1',
  });
  // Biome's noProcessEnv gate keeps env.ts the sole process.env boundary (see
  // test/credential-resolve.test.ts for the established pattern); resolveBedrockBearer
  // treats '' the same as unset, so setting it empty exercises the same fail-fast branch
  // without reaching for raw process.env.
  const prev = getEnv('AWS_BEARER_TOKEN_BEDROCK');
  setProcessEnv('AWS_BEARER_TOKEN_BEDROCK', '');
  try {
    expect(() => resolveBedrockBearer(cred)).toThrow(
      'AWS_BEARER_TOKEN_BEDROCK',
    );
  } finally {
    setProcessEnv('AWS_BEARER_TOKEN_BEDROCK', prev ?? '');
  }
});
