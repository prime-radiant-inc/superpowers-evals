import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgentConfigForValidation } from '../src/contracts/agent-config.ts';
import { parseCredentialsFile } from '../src/contracts/credential.ts';
import { repoRoot } from '../src/paths.ts';

test('pi defaults to OpenAI gpt-5.5 (openai-codex) via checked-in credentials', () => {
  const root = repoRoot();
  const cfg = loadAgentConfigForValidation(join(root, 'coding-agents'), 'pi');
  const credentials = parseCredentialsFile(
    parseYaml(readFileSync(join(root, 'credentials.yaml'), 'utf8')),
  );

  expect(cfg.default_credential).toBe('pi_default');

  const cred = credentials['pi_default'];
  if (cred === undefined) {
    throw new Error('pi_default credential is missing');
  }
  expect(cred.provider).toBe('openai-codex');
  expect(cred.model).toBe('gpt-5.5');
  expect(cred.auth).toBe('oauth');
  expect(cred.harnesses).toContain('pi');
});
