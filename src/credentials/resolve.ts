import type { Credential } from '../contracts/credential.ts';
import { getEnv } from '../env.ts';

export function resolveCredentialName(opts: {
  explicit?: string;
  agentDefault: string;
}): string {
  return opts.explicit && opts.explicit !== ''
    ? opts.explicit
    : opts.agentDefault;
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
