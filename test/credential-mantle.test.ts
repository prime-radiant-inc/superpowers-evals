import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '../src/contracts/credential.ts';
import { CredentialSchema } from '../src/contracts/credential.ts';
import { checkCredentials } from '../src/credentials/check.ts';
import {
  mantleGraderEnv,
  resolveBedrockBearer,
} from '../src/credentials/resolve.ts';
import { deleteProcessEnv, setProcessEnv } from '../src/env.ts';
import { gauntletEnvBase } from '../src/runner/gauntlet-env.ts';

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

test('mantleGraderEnv projects the bearer as the grader API key over the grader-only alias channel', () => {
  setProcessEnv('MANTLE_GRADER_TEST_BEARER', 'fixture-bearer');
  try {
    const cred = CredentialSchema.parse({
      model: 'anthropic.claude-opus-4-8',
      harnesses: ['claude'],
      api: 'mantle',
      auth: 'bedrock-bearer',
      api_key_env: 'MANTLE_GRADER_TEST_BEARER',
      region: 'us-east-1',
    });
    // Mantle accepts x-api-key, so the bearer travels as an ordinary API
    // key: gauntlet stays in plain api-key mode (an ANTHROPIC_AUTH_TOKEN
    // would put it in OAuth mode — oauth beta header + Claude Code identity
    // block). The alias names keep it off the canonical ANTHROPIC_API_KEY,
    // which belongs to the agent under test in the same child env.
    expect(mantleGraderEnv(cred)).toEqual({
      QUORUM_GRADER_SOURCE_MODE: 'appliance-scoped',
      QUORUM_GRADER_ANTHROPIC_API_KEY: 'fixture-bearer',
      QUORUM_GRADER_ANTHROPIC_BASE_URL:
        'https://bedrock-mantle.us-east-1.api.aws/anthropic',
    });
  } finally {
    deleteProcessEnv('MANTLE_GRADER_TEST_BEARER');
  }
});

test('a mantle grader reaches gauntlet as an API key without displacing a direct-API subject key', () => {
  setProcessEnv('MANTLE_GRADER_TEST_BEARER', 'fixture-bearer');
  try {
    const grader = CredentialSchema.parse({
      model: 'anthropic.claude-opus-4-8',
      harnesses: ['claude'],
      api: 'mantle',
      auth: 'bedrock-bearer',
      api_key_env: 'MANTLE_GRADER_TEST_BEARER',
      region: 'us-east-1',
    });
    const childEnv = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'fixture-subject-key',
      ...mantleGraderEnv(grader),
    };
    expect(childEnv['ANTHROPIC_API_KEY']).toBe('fixture-subject-key');
    const gauntletEnv = gauntletEnvBase(childEnv);
    expect(gauntletEnv['ANTHROPIC_API_KEY']).toBe('fixture-bearer');
    expect(gauntletEnv['ANTHROPIC_BASE_URL']).toBe(
      'https://bedrock-mantle.us-east-1.api.aws/anthropic',
    );
    expect(gauntletEnv['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(gauntletEnv['MANTLE_GRADER_TEST_BEARER']).toBeUndefined();
    expect(gauntletEnv['QUORUM_GRADER_SOURCE_MODE']).toBeUndefined();
  } finally {
    deleteProcessEnv('MANTLE_GRADER_TEST_BEARER');
  }
});

test('mantleGraderEnv is empty for non-mantle credentials and loud on a missing region', () => {
  const direct = CredentialSchema.parse({
    model: 'm',
    harnesses: ['claude'],
    api: 'anthropic',
    api_key_env: 'X',
  });
  expect(mantleGraderEnv(direct)).toEqual({});
  // quorum check enforces region at parse time; the helper still fails
  // closed on a hand-built mantle credential that lacks it.
  const noRegion = {
    ...direct,
    api: 'mantle',
    region: undefined,
  } as unknown as Credential;
  expect(() => mantleGraderEnv(noRegion)).toThrow(/region/);
});

test('resolveBedrockBearer throws naming the env var when unset', () => {
  // Use a name we never set so getEnv returns undefined (see
  // test/credential-resolve.test.ts's "missing api-key throws" for the
  // established pattern) — zero process.env mutation, no save/restore needed.
  const cred = CredentialSchema.parse({
    model: 'anthropic.claude-opus-4-8',
    harnesses: ['claude'],
    api: 'mantle',
    auth: 'bedrock-bearer',
    api_key_env: 'AWS_BEARER_TOKEN_BEDROCK_TEST_NEVER_SET',
    region: 'us-east-1',
  });
  expect(() => resolveBedrockBearer(cred)).toThrow(
    'AWS_BEARER_TOKEN_BEDROCK_TEST_NEVER_SET',
  );
});
