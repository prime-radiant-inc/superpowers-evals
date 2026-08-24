import type { Credential } from '../credential.ts';

/** The campaign v1 quota-pool derivation (parent Execution): per-model
 *  splitting without merging distinct endpoints or orgs; the explicit
 *  quota_pool key covers entries genuinely sharing one provider bucket.
 *  Legacy run-all keeps limiterKey — the two derivations coexist until
 *  run-all retirement is decided. */
export function poolKey(cred: Credential, name: string): string {
  return (
    cred.quota_pool ?? `${cred.base_url ?? name}|${cred.api}|${cred.model}`
  );
}

/** Key selection is a spawn-time concern strictly below admission
 *  (Decision D-1). D3 implements it; D1 pins the contract. */
export interface KeyGrant {
  readonly envName: string;
}

export type KeySelector = (
  cred: Credential,
  inFlight: Readonly<Record<string, number>>,
) => { kind: 'use'; grant: KeyGrant } | { kind: 'wait' };

// Authority relationship (pinned): the pool-level admission cap is
// authoritative. Since len(keys) * ceil(cap / len(keys)) >= cap, `wait` is
// unreachable under honest admission and guards miscalibration and recovery
// rebuild only. Resolution must fail loud for key_pool credentials lacking a
// grant — the harness-conventional-env fallback is forbidden for them.
