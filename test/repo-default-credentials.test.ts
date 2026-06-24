import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgentConfigForValidation } from '../src/contracts/agent-config.ts';
import { parseCredentialsFile } from '../src/contracts/credential.ts';
import { repoRoot } from '../src/paths.ts';

test('pi defaults to OpenRouter GLM 5.2 via checked-in credentials', () => {
  const root = repoRoot();
  const cfg = loadAgentConfigForValidation(join(root, 'coding-agents'), 'pi');
  const credentials = parseCredentialsFile(
    parseYaml(readFileSync(join(root, 'credentials.yaml'), 'utf8')),
  );

  expect(cfg.default_credential).toBe('openrouter_glm_5_2');

  const cred = credentials['openrouter_glm_5_2'];
  if (cred === undefined) {
    throw new Error('openrouter_glm_5_2 credential is missing');
  }
  expect(cred.model).toBe('z-ai/glm-5.2');
  expect(cred.api).toBe('openai-chat');
  expect(cred.base_url).toBe('https://openrouter.ai/api/v1');
  expect(cred.api_key_env).toBe('OPENROUTER_API_KEY');
  expect(cred.harnesses).toContain('pi');
  expect(cred.compat.thinking_format).toBe('zai');
});
