import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentConfigForValidation } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { getEnv } from '../env.ts';
import {
  APPLIANCE_SCOPED_GRADER_MODE,
  GRADER_SOURCE_ENV_BY_RUNTIME_NAME,
  QUORUM_GRADER_SOURCE_MODE,
} from './grader.ts';

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

export function resolveApiKeyEnvName(
  cred: Credential,
  harnessConventionalEnv: string | undefined,
): string | null {
  if (cred.auth !== 'api-key') return null;
  const envName = cred.api_key_env ?? harnessConventionalEnv;
  if (envName === undefined) {
    throw new Error(
      `credential auth=api-key but no api_key_env and harness has no conventional key env`,
    );
  }
  return envName;
}

export function resolveApiKey(
  cred: Credential,
  harnessConventionalEnv: string | undefined,
): ApiKeyResolution {
  const envName = resolveApiKeyEnvName(cred, harnessConventionalEnv);
  if (envName === null) return { kind: 'native' };
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

/** The Mantle endpoint base URL for a region (the 2026-07-08 live probe
 *  pinned the shape: bedrock-mantle.{region}.api.aws with the Anthropic
 *  surface under /anthropic, In-Region-only — the SDK appends
 *  /v1/messages). */
export function mantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/anthropic`;
}

/** The grader env for a Mantle credential. Mantle accepts `x-api-key`, so
 *  the bearer travels as the grader's ordinary API key and gauntlet stays in
 *  plain api-key mode (as ANTHROPIC_AUTH_TOKEN it would run in OAuth mode:
 *  oauth beta header + Claude Code identity block). It rides the grader-only
 *  QUORUM_GRADER_* alias channel with the regional base URL: the campaign
 *  child's runner maps the aliases onto the names gauntlet reads, while the
 *  canonical ANTHROPIC_API_KEY in that same child env stays the agent under
 *  test's. Campaign children project this overlay alongside the key grants;
 *  non-Mantle credentials contribute nothing. */
export function mantleGraderEnv(cred: Credential): Record<string, string> {
  if (cred.api !== 'mantle') return {};
  const region = cred.region;
  if (region === undefined || region === '') {
    throw new Error(
      'mantle credential requires a region to derive the grader base URL',
    );
  }
  return {
    [QUORUM_GRADER_SOURCE_MODE]: APPLIANCE_SCOPED_GRADER_MODE,
    [GRADER_SOURCE_ENV_BY_RUNTIME_NAME.ANTHROPIC_API_KEY]:
      resolveBedrockBearer(cred),
    [GRADER_SOURCE_ENV_BY_RUNTIME_NAME.ANTHROPIC_BASE_URL]:
      mantleBaseUrl(region),
  };
}
