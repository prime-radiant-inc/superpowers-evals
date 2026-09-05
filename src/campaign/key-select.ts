import type { KeyGrant, KeySelector } from '../contracts/campaign/pool.ts';
import type { Credential } from '../contracts/credential.ts';

export class KeySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeySelectionError';
  }
}

/** The frozen aggregate pool policy is the sole capacity authority. */
export function keyWaitThreshold(
  cred: Credential,
  poolCapacity: number,
): number {
  if (!Number.isSafeInteger(poolCapacity) || poolCapacity < 1)
    throw new KeySelectionError('positive frozen pool capacity required');
  return Math.ceil(poolCapacity / (cred.key_pool?.length ?? 1));
}

/** Least-loaded key; wait when every key's in-flight count is at or above
 *  the threshold. Deterministic ties: first key in pool order. */
export const selectKey: KeySelector = (cred, inFlight, poolCapacity) => {
  const pool = cred.key_pool;
  if (pool === undefined || pool.length === 0) {
    throw new KeySelectionError(
      'selectKey called on a credential without key_pool — singular resolution uses resolveKeyForSpawn',
    );
  }
  const threshold = keyWaitThreshold(cred, poolCapacity);
  let best: { envName: string; load: number } | undefined;
  for (const envName of pool) {
    const load = inFlight[envName] ?? 0;
    if (load < threshold && (best === undefined || load < best.load)) {
      best = { envName, load };
    }
  }
  return best === undefined
    ? { kind: 'wait' }
    : { kind: 'use', grant: { envName: best.envName } };
};

export type SpawnKeyResolution =
  | { kind: 'use'; grant: KeyGrant }
  | { kind: 'wait' }
  | { kind: 'native' }; // non-api-key auth: no key material projected

/** R-SPN-7 fail-loud: key_pool credentials lacking a selected grant refuse;
 *  the harness-conventional-env fallback (resolveApiKeyEnvName) is FORBIDDEN
 *  for them. Spawn fails loud on an exhausted or unset key. */
export function resolveKeyForSpawn(args: {
  cred: Credential;
  poolCapacity: number;
  credentialName: string;
  inFlight: Readonly<Record<string, number>>;
}): SpawnKeyResolution {
  const { cred, credentialName, inFlight } = args;
  // Bedrock-bearer credentials grant their single bearer env name: campaign
  // children seed Mantle auth from it (seedClaudeMantle for the subject,
  // the dispatcher's mantle grader projection for gauntlet). The fallback
  // name matches resolveBedrockBearer's convention.
  if (cred.auth === 'bedrock-bearer') {
    return {
      kind: 'use',
      grant: { envName: cred.api_key_env ?? 'AWS_BEARER_TOKEN_BEDROCK' },
    };
  }
  if (cred.auth !== 'api-key') return { kind: 'native' };
  if (cred.key_pool !== undefined) {
    return selectKey(cred, inFlight, args.poolCapacity);
  }
  if (cred.api_key_env !== undefined) {
    return { kind: 'use', grant: { envName: cred.api_key_env } };
  }
  throw new KeySelectionError(
    `credential ${credentialName} is auth=api-key with no api_key_env and no key_pool — the harness-conventional-env fallback is forbidden for campaign credentials (R-SPN-7); spawn fails loud rather than spend on an unset key`,
  );
}
