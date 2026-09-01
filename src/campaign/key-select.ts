// KeySelector (kernel D3, R-SPN-6/7; D1 Decision D-1): key selection lives
// STRICTLY BELOW admission. Since len(keys) x ceil(cap / len(keys)) >= cap,
// the wait branch is unreachable under honest admission — it guards
// miscalibration and recovery rebuild, and is implemented exactly as a
// guard, never a second admission authority. Decision D-2: zero journal
// amendments for key-wait; wait surfaces as loud warnings here and as the
// honestly-labeled spawn-gap stat in the journal's attempts table (task 3).
import type { KeyGrant, KeySelector } from '../contracts/campaign/pool.ts';
import type { Credential } from '../contracts/credential.ts';
import type { Clock } from '../scheduler/clock.ts';

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
    return selectKey(cred, inFlight);
  }
  if (cred.api_key_env !== undefined) {
    return { kind: 'use', grant: { envName: cred.api_key_env } };
  }
  throw new KeySelectionError(
    `credential ${credentialName} is auth=api-key with no api_key_env and no key_pool — the harness-conventional-env fallback is forbidden for campaign credentials (R-SPN-7); spawn fails loud rather than spend on an unset key`,
  );
}

/** A resolution the wait guard has settled: a usable grant or native auth.
 *  `wait` is absent by construction — the guard either resolves or fails. */
export type SettledKeyResolution = Exclude<
  SpawnKeyResolution,
  { kind: 'wait' }
>;

export interface ResolveKeyWithWaitArgs {
  readonly cred: Credential;
  readonly credentialName: string;
  /** The dispatcher's PERSISTENT per-key in-flight counters (env NAME ->
   *  live children holding it). Passed by reference and sampled on every
   *  re-check: the wait loop never creates, resets, or owns it. */
  readonly inFlight: Readonly<Record<string, number>>;
  /** The injected Clock — the wait branch NEVER touches wall time, and the
   *  resolution warning's measured duration is read off it (Decision D-2). */
  readonly clock: Clock;
  /** Operator-visible warning sink for the entry/resolution notices. */
  readonly warn: { write(s: string): void };
  /** Total wait budget (seconds) before failing loud (R-SPN-7). */
  readonly waitSeconds: number;
  /** Clock slice between re-checks; default 1s. */
  readonly pollSeconds?: number;
}

/** The converged wait guard: the ONLY selection path is the pinned
 *  selector above (resolveKeyForSpawn -> selectKey:
 *  least-loaded, ceil(cap/pool-length) threshold, pool-order ties). When it
 *  answers `wait`, this loop emits the D-2 entry warning, parks on the
 *  injected Clock, re-samples the persistent counter map each wake, and on
 *  resolution emits the measured-wait warning; once the budget is spent it
 *  fails loud (R-SPN-7). The pool-level admission cap stays authoritative —
 *  the wait branch is the miscalibration/recovery-rebuild guard, never a
 *  second admission authority (D1 Decision D-1). */
export async function resolveKeyForSpawnWithWait(
  args: ResolveKeyWithWaitArgs,
): Promise<SettledKeyResolution> {
  const pollSeconds = args.pollSeconds ?? 1;
  const deadline = args.clock.now() + args.waitSeconds;
  let waitEnteredAt: number | undefined;
  for (;;) {
    const resolution = resolveKeyForSpawn({
      cred: args.cred,
      credentialName: args.credentialName,
      inFlight: args.inFlight,
    });
    if (resolution.kind !== 'wait') {
      if (waitEnteredAt !== undefined) {
        warnKeyWait(args.warn, {
          phase: 'resolution',
          credentialName: args.credentialName,
          waitMs: (args.clock.now() - waitEnteredAt) * 1000,
        });
      }
      return resolution;
    }
    if (waitEnteredAt === undefined) {
      waitEnteredAt = args.clock.now();
      warnKeyWait(args.warn, {
        phase: 'entry',
        credentialName: args.credentialName,
      });
    }
    const target = args.clock.now() + pollSeconds;
    if (target > deadline) {
      throw new KeySelectionError(
        `credential ${args.credentialName}: every key at/over its in-flight threshold for the full ${args.waitSeconds}s wait budget — failing loud (R-SPN-6/7 wait guard; admission miscalibration or recovery rebuild)`,
      );
    }
    await args.clock.sleepUntil(target);
  }
}

/** Decision D-2 warning notices. Entry carries no duration (nothing has
 *  been measured yet); resolution MUST carry the measured wait — a finite,
 *  nonnegative number of milliseconds read off the injected Clock. Any
 *  other shape is a fabricated measurement and refuses to report
 *  (fail-closed: an unmeasured wait is never reported as a measured one). */
export type KeyWaitNotice =
  | { phase: 'entry'; credentialName: string }
  | { phase: 'resolution'; credentialName: string; waitMs: number };

/** Decision D-2 loud warnings: every wait entry and every resolution names
 *  the credential (resolution adds the measured wait duration). Wait never
 *  journals — the derivable spawn-gap stat is the only record. */
export function warnKeyWait(
  stream: { write(s: string): void },
  notice: KeyWaitNotice,
): void {
  if (notice.phase === 'entry') {
    stream.write(
      `warning: key wait entered for credential ${notice.credentialName} — every key at its in-flight threshold (miscalibration or recovery rebuild; wait is never journaled)\n`,
    );
    return;
  }
  const { waitMs } = notice;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new KeySelectionError(
      `key wait resolution for credential ${notice.credentialName} has no valid measured duration (${waitMs}) — D-2 requires the measured wait read off the injected Clock, never a fabricated default; refusing to report (fail-closed)`,
    );
  }
  stream.write(
    `warning: key wait resolved for credential ${notice.credentialName} after ${waitMs}ms — measured wait contributes to the spawn-gap stat, not to key-wait attribution\n`,
  );
}
