// src/contracts/campaign/journal-events.ts
import { z } from 'zod';
import { EnvVarNameSchema } from '../credential.ts';
import { FiniteNumberSchema } from '../finite.ts';
import { INSTRUMENT_CAUSES } from './typed-failures.ts';

/** Envelope (pinned here): single writer under flock makes seq monotonic;
 *  replay in seq order deterministically reconstructs state. Strict: an
 *  unknown top-level key on a journal row is corruption, never stripped.
 *  The literal `type` parameter keeps JournalEventType a closed union so
 *  transition tables stay statically exhaustive. The SQLite store's
 *  schema_version row is D3's storage obligation, not part of the per-event
 *  envelope. */
function envelope<Type extends string, T extends z.ZodTypeAny>(
  type: Type,
  payload: T,
) {
  return z
    .object({
      seq: z.number().int().positive(),
      ts_ms: z.number().int().nonnegative(),
      type: z.literal(type),
      payload,
    })
    .strict();
}

const DigestStr = z.string().regex(/^[0-9a-f]{64}$/);

export const CampaignOpenedEvent = envelope(
  'campaign_opened',
  z.object({ campaign_id: z.string().min(1), digest: DigestStr }).strict(),
);
export const BlockAdmittedEvent = envelope(
  'block_admitted',
  z
    .object({ block_id: z.string().min(1), pools: z.array(z.string().min(1)) })
    .strict(),
);
export const AttemptCreatedEvent = envelope(
  'attempt_created',
  z
    .object({ sample_id: z.string().min(1), attempt_id: z.string().min(1) })
    .strict(),
);
export const RunAllocatedEvent = envelope(
  'run_allocated',
  z
    .object({
      attempt_id: z.string().min(1),
      run_id: z.string().min(1),
      pgid: z.number().int().positive(),
      // Key grant (Decision D-1): name only, never the value, so key-grant
      // accounting is reconstructable from the journal. The shared env-name
      // schema rejects secret-shaped strings outright.
      key_env: EnvVarNameSchema.optional(),
    })
    .strict(),
);
export const ExposureStartedEvent = envelope(
  'exposure_started',
  // ts IS analysis_exposure_started_at: the sample's first Coding-Agent
  // generation request (never spawn, never Gauntlet boot).
  z
    .object({
      sample_id: z.string().min(1),
      ts: z.number().int().nonnegative(),
    })
    .strict(),
);
export const RunCompletedEvent = envelope(
  'run_completed',
  z
    .object({ attempt_id: z.string().min(1), outcome: z.string().min(1) })
    .strict(),
);
export const InstrumentFailureEvent = envelope(
  'instrument_failure',
  z
    .object({
      attempt_id: z.string().min(1),
      cause: z.enum(INSTRUMENT_CAUSES),
    })
    .strict(),
);
export const BlockReplacedEvent = envelope(
  'block_replaced',
  z
    .object({
      block_id: z.string().min(1),
      replacement_block_id: z.string().min(1),
      cause: z.enum(INSTRUMENT_CAUSES),
    })
    .strict(),
);
export const SampleDispositionEvent = envelope(
  'sample_disposition',
  // superseded_by is required exactly for the replacement disposition (the
  // innocent arm's override names its superseding sample) and forbidden for
  // included — the strict shapes enforce the iff.
  z.discriminatedUnion('disposition', [
    z
      .object({
        sample_id: z.string().min(1),
        disposition: z.literal('included'),
      })
      .strict(),
    z
      .object({
        sample_id: z.string().min(1),
        disposition: z.literal('excluded_block_replaced'),
        superseded_by: z.string().min(1),
      })
      .strict(),
  ]),
);
export const SlotExhaustedEvent = envelope(
  'slot_exhausted',
  z.object({ sample_id: z.string().min(1) }).strict(),
);
export const BudgetStoppedEvent = envelope(
  'budget_stopped',
  z.object({ sample_ids: z.array(z.string().min(1)) }).strict(),
);
export const SkewExcludedEvent = envelope(
  'skew_excluded',
  z.object({ block_id: z.string().min(1) }).strict(),
);
export const PoolBlockedEvent = envelope(
  'pool_blocked',
  z
    .object({
      pool_key: z.string().min(1),
      until_ts_ms: z.number().int().nonnegative(),
    })
    .strict(),
);
export const BudgetEventEvent = envelope(
  'budget_event',
  z
    .object({
      kind: z.enum(['spend', 'estimate_inflight']),
      amount_usd: FiniteNumberSchema.nonnegative(),
    })
    .strict(),
);
export const AmendmentEvent = envelope(
  'amendment',
  z
    .object({
      kind: z.literal('budget_raise'),
      amount_usd: FiniteNumberSchema.positive(),
      ts: z.number().int().nonnegative(),
    })
    .strict(),
);
export const AdjudicationEvent = envelope(
  'adjudication',
  z
    .object({
      cell: z.string().min(1),
      disposition: z.string().min(1),
      rationale: z.string().min(1),
    })
    .strict(),
);
export const AbortedEvent = envelope(
  'aborted',
  z.object({ block_id: z.string().min(1) }).strict(),
);
export const StoragePausedEvent = envelope(
  'storage_paused',
  z.object({}).strict(),
);
export const CampaignCancelledEvent = envelope(
  'campaign_cancelled',
  z.object({ reason: z.string().min(1).optional() }).strict(),
);
export const SealedEvent = envelope(
  'sealed',
  z.object({ report_digest: DigestStr }).strict(),
);

export const JournalEventSchema = z.discriminatedUnion('type', [
  CampaignOpenedEvent,
  BlockAdmittedEvent,
  AttemptCreatedEvent,
  RunAllocatedEvent,
  ExposureStartedEvent,
  RunCompletedEvent,
  InstrumentFailureEvent,
  BlockReplacedEvent,
  SampleDispositionEvent,
  SlotExhaustedEvent,
  BudgetStoppedEvent,
  SkewExcludedEvent,
  PoolBlockedEvent,
  BudgetEventEvent,
  AmendmentEvent,
  AdjudicationEvent,
  AbortedEvent,
  StoragePausedEvent,
  CampaignCancelledEvent,
  SealedEvent,
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;
export type JournalEventType = JournalEvent['type'];

export const JOURNAL_EVENT_TYPES: readonly JournalEventType[] = [
  'campaign_opened',
  'block_admitted',
  'attempt_created',
  'run_allocated',
  'exposure_started',
  'run_completed',
  'instrument_failure',
  'block_replaced',
  'sample_disposition',
  'slot_exhausted',
  'budget_stopped',
  'skew_excluded',
  'pool_blocked',
  'budget_event',
  'amendment',
  'adjudication',
  'aborted',
  'storage_paused',
  'campaign_cancelled',
  'sealed',
];
