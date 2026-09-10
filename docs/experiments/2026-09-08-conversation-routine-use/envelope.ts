export type ReleaseEnvelope = {
  firstPaidAtMs: number;
  qualificationKnownUsd: number;
  campaigns: ReadonlyMap<string, number>;
};
export type CampaignObservation = {
  campaignId: string;
  knownUsd: number;
  pendingAttempts: number;
  settledFault: string | null;
  ownership: 'safe' | 'unsafe';
  terminal: boolean;
};
const valid = (n: number) => Number.isFinite(n) && n >= 0;
export function qualificationFits(
  firstPaidAtMs: number,
  nowMs: number,
): boolean {
  if (![firstPaidAtMs, nowMs].every(valid)) throw new Error('invalid clock');
  return nowMs + 122_000 <= firstPaidAtMs + 21_600_000 - 60_000;
}
/** One observed snapshot replaces that campaign's subtotal, never earlier cohorts. */
export function campaignDecision(
  e: ReleaseEnvelope,
  now: number,
  o: CampaignObservation,
): {
  action: 'observe' | 'cancel' | 'done';
  reason: string | null;
  knownUsd: number;
} {
  if (![e.firstPaidAtMs, now].every(valid)) throw new Error('invalid clock');
  if (!Number.isInteger(o.pendingAttempts) || o.pendingAttempts < 0)
    throw new Error('invalid pending attempts');
  if (
    ![e.qualificationKnownUsd, ...e.campaigns.values(), o.knownUsd].every(valid)
  )
    throw new Error('invalid known subtotal');
  const costs = new Map(e.campaigns);
  costs.set(o.campaignId, Math.max(costs.get(o.campaignId) ?? 0, o.knownUsd));
  const knownUsd = Number(
    (
      e.qualificationKnownUsd + [...costs.values()].reduce((a, b) => a + b, 0)
    ).toPrecision(15),
  );
  if (!valid(knownUsd)) throw new Error('invalid cumulative subtotal');
  const reason =
    o.ownership === 'unsafe'
      ? 'ownership'
      : o.settledFault !== null
        ? 'settled accounting'
        : knownUsd >= 150
          ? 'observed cost'
          : now >= e.firstPaidAtMs + 21_600_000 - 60_000
            ? 'cutoff'
            : null;
  return {
    action: o.terminal ? 'done' : reason === null ? 'observe' : 'cancel',
    reason,
    knownUsd,
  };
}
