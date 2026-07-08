import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedClaudeMantle } from '../src/agents/index.ts';
import { CredentialSchema } from '../src/contracts/credential.ts';
import { setProcessEnv } from '../src/env.ts';

const CRED = CredentialSchema.parse({
  model: 'anthropic.claude-opus-4-8',
  harnesses: ['claude'],
  api: 'mantle',
  auth: 'bedrock-bearer',
  api_key_env: 'A2_TEST_MANTLE_BEARER',
  region: 'us-east-1',
});

test('seedClaudeMantle writes only the Bedrock env, no ANTHROPIC_API_KEY/apiKeyHelper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  setProcessEnv('A2_TEST_MANTLE_BEARER', 'bedrock-key-xyz');
  seedClaudeMantle(dir, CRED);
  const env = readFileSync(join(dir, '.claude-env'), 'utf8');
  expect(env).toContain('CLAUDE_CODE_USE_MANTLE=1');
  expect(env).toContain("AWS_REGION='us-east-1'");
  expect(env).toContain("AWS_BEARER_TOKEN_BEDROCK='bedrock-key-xyz'");
  expect(env).not.toContain('ANTHROPIC_API_KEY');
  expect(existsSync(join(dir, 'api-key-helper.sh'))).toBe(false);
  expect(existsSync(join(dir, 'settings.json'))).toBe(false);
});

test('seedClaudeMantle throws when the bearer env var is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  // Use a name we never set so getEnv returns undefined (see
  // test/credential-mantle.test.ts's "resolveBedrockBearer throws" for the
  // established pattern) — zero process.env mutation, no save/restore needed.
  const cred = CredentialSchema.parse({
    ...CRED,
    api_key_env: 'A2_TEST_MANTLE_BEARER_NEVER_SET',
  });
  expect(() => seedClaudeMantle(dir, cred)).toThrow(
    'A2_TEST_MANTLE_BEARER_NEVER_SET',
  );
});

test('seedClaudeMantle throws when the credential has no region', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  setProcessEnv('A2_TEST_MANTLE_BEARER', 'bedrock-key-xyz');
  const cred = CredentialSchema.parse({
    ...CRED,
    region: undefined,
  });
  expect(() => seedClaudeMantle(dir, cred)).toThrow('region');
});
