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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCredentials } from '../src/credentials/check.ts';

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
