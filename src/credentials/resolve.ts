import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentConfigForValidation } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { getEnv } from '../env.ts';

export function resolveCredentialName(opts: {
  explicit?: string;
  agentDefault: string;
}): string {
  return opts.explicit || opts.agentDefault;
}

// Resolve the credential name for a coding agent run. Returns the explicit name
// when provided and non-empty; otherwise looks up the agent yaml's
// default_credential. Returns undefined when the agent yaml is missing (so the
// runner can emit its canonical "unknown agent" error) or when the yaml has no
// default_credential field.
export function resolveCredentialNameForAgent(
  codingAgentsDir: string,
  codingAgent: string,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit;
  const path = join(codingAgentsDir, `${codingAgent}.yaml`);
  if (!existsSync(path)) return undefined;
  return loadAgentConfigForValidation(codingAgentsDir, codingAgent)
    .default_credential;
}

export type ApiKeyResolution =
  | { kind: 'env'; value: string }
  | { kind: 'native' };

export function resolveApiKey(
  cred: Credential,
  harnessConventionalEnv: string | undefined,
): ApiKeyResolution {
  if (cred.auth !== 'api-key') return { kind: 'native' };
  const envName = cred.api_key_env ?? harnessConventionalEnv;
  if (envName === undefined) {
    throw new Error(
      `credential auth=api-key but no api_key_env and harness has no conventional key env`,
    );
  }
  const value = getEnv(envName);
  if (value === undefined || value === '') {
    throw new Error(`api key env var ${envName} is unset/empty`);
  }
  return { kind: 'env', value };
}

export function limiterKey(cred: Credential, name: string): string {
  return `${cred.base_url ?? name}|${cred.api}`;
}

// Resolve the Amazon Bedrock API key (bearer) for a mantle credential from its
// api_key_env. Fail fast (never seed an empty bearer, which fails Mantle auth
// cryptically at runtime).
export function resolveBedrockBearer(cred: Credential): string {
  const envName = cred.api_key_env ?? 'AWS_BEARER_TOKEN_BEDROCK';
  const value = getEnv(envName);
  if (value === undefined || value === '') {
    throw new Error(`bedrock bearer env var ${envName} is unset/empty`);
  }
  return value;
}
