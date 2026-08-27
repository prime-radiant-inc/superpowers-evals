// KeySelector (kernel D3, R-SPN-6/7; D1 Decision D-1): key selection lives
// STRICTLY BELOW admission. Since len(keys) x ceil(cap / len(keys)) >= cap,
// the wait branch is unreachable under honest admission — it guards
// miscalibration and recovery rebuild, and is implemented exactly as a
// guard, never a second admission authority. Decision D-2: zero journal
// amendments for key-wait; wait surfaces as loud warnings here and as the
// honestly-labeled spawn-gap stat in the journal's attempts table (task 3).

import type { KeyGrant, KeySelector } from '../contracts/campaign/pool.ts';
import type { Credential } from '../contracts/credential.ts';

export class KeySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeySelectionError';
  }
}

/** The pool-level cap: explicit max_concurrency, else the single-key cap 5
 *  Phase 0 modeled, scaled by pool length (R-REG-7's convention). */
function poolCap(cred: Credential): number {
  if (cred.max_concurrency !== undefined) return cred.max_concurrency;
  return (cred.key_pool?.length ?? 1) * 5;
}

export function keyWaitThreshold(cred: Credential): number {
  const len = cred.key_pool?.length ?? 1;
  return Math.ceil(poolCap(cred) / len);
}

/** Least-loaded key; wait when every key's in-flight count is at or above
 *  the threshold. Deterministic ties: first key in pool order. */
export const selectKey: KeySelector = (cred, inFlight) => {
  const pool = cred.key_pool;
  if (pool === undefined || pool.length === 0) {
    throw new KeySelectionError(
      'selectKey called on a credential without key_pool — singular resolution uses resolveKeyForSpawn',
    );
  }
  const threshold = keyWaitThreshold(cred);
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
  credentialName: string;
  inFlight: Readonly<Record<string, number>>;
}): SpawnKeyResolution {
  const { cred, credentialName, inFlight } = args;
  if (cred.auth !== 'api-key') return { kind: 'native' };
  if (cred.key_pool !== undefined) {
    return selectKey(cred, inFlight);
  }
  if (cred.api_key_env !== undefined) {
    return { kind: 'use', grant: { envName: cred.api_key_env } };
  }
  throw new KeySelectionError(
    `credential ${credentialName} is auth=api-key with no api_key_env and no key_pool — the harness-conventional-env fallback is forbidden for campaign credentials (R-SPN-7); spawn fails loud rather than spend on an unset key`,
  );
}

/** Decision D-2 loud warnings: every wait entry and every resolution names
 *  the credential (resolution adds the measured wait duration). Wait never
 *  journals — the derivable spawn-gap stat is the only record. */
export function warnKeyWait(
  stream: { write(s: string): void },
  phase: 'entry' | 'resolution',
  credentialName: string,
  waitMs?: number,
): void {
  if (phase === 'entry') {
    stream.write(
      `warning: key wait entered for credential ${credentialName} — every key at its in-flight threshold (miscalibration or recovery rebuild; wait is never journaled)\n`,
    );
  } else {
    stream.write(
      `warning: key wait resolved for credential ${credentialName} after ${waitMs ?? 0}ms — measured wait contributes to the spawn-gap stat, not to key-wait attribution\n`,
    );
  }
}
