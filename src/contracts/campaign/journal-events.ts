// src/contracts/campaign/journal-events.ts
import { z } from 'zod';
import { EnvVarNameSchema } from '../credential.ts';
import { FiniteNumberSchema } from '../finite.ts';
import {
  BLOCK_REPLACEMENT_REASONS,
  type BlockReplacementReason,
  INSTRUMENT_CAUSES,
} from './typed-failures.ts';

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
    .object({
      block_id: z.string().min(1),
      pools: z.array(z.string().min(1)),
      // E7.1 re-entry edge: present exactly when this admission re-enters a
      // rerun instance; absent keeps the shipped planned→admitted semantics.
      rerun_of: z.string().min(1).optional(),
    })
    .strict(),
);
export const AttemptCreatedEvent = envelope(
  'attempt_created',
  z
    .object({ sample_id: z.string().min(1), attempt_id: z.string().min(1) })
    .strict(),
);
export const KeyGrantEntrySchema = z
  .object({
    role: z.enum(['subject', 'grader']),
    env: EnvVarNameSchema,
  })
  .strict();
export type KeyGrantEntry = z.infer<typeof KeyGrantEntrySchema>;

const RunAllocatedLegacyPayload = z
  .object({
    attempt_id: z.string().min(1),
    run_id: z.string().min(1),
    pgid: z.number().int().positive(),
    // Key grant (Decision D-1): name only, never the value, so key-grant
    // accounting is reconstructable from the journal. The shared env-name
    // schema rejects secret-shaped strings outright.
    key_env: EnvVarNameSchema.optional(),
  })
  .strict();
const RunAllocatedGrantPayload = z
  .object({
    attempt_id: z.string().min(1),
    run_id: z.string().min(1),
    pgid: z.number().int().positive(),
    key_grants: z.array(KeyGrantEntrySchema).max(2),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const roles = payload.key_grants.map((g) => g.role);
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key_grants'],
        message: 'at most one grant entry per role',
      });
    }
  });
export type RunAllocatedPayload =
  | z.infer<typeof RunAllocatedLegacyPayload>
  | z.infer<typeof RunAllocatedGrantPayload>;
export const RunAllocatedEvent = envelope(
  'run_allocated',
  // E7.5 two-arm union. Strict objects make the union key-discriminable: a
  // fresh payload carries key_grants (legacy arm rejects the unknown key),
  // a legacy payload may carry key_env (fresh arm rejects without
  // key_grants). D3 never emits the legacy arm after E7.
  z.union([RunAllocatedGrantPayload, RunAllocatedLegacyPayload]),
);

/** E7.5 reader rule: prefer key_grants; fall back to legacy key_env as the
 * subject grant. Names only, never values. */
export function readRunAllocatedGrants(
  payload: RunAllocatedPayload,
): readonly KeyGrantEntry[] {
  if ('key_grants' in payload) return payload.key_grants;
  return payload.key_env === undefined
    ? []
    : [{ role: 'subject' as const, env: payload.key_env }];
}
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
/** R-SNS-4 exploratory caveat (operator amendment 2026-08-27): the one
 *  condition under which run_completed is legal from `spawned` — an
 *  exploratory-suite sample whose exposure never established by the
 *  decision point. Gating never carries it: absence there is a skew breach
 *  (skew_excluded + refill), not a completion. */
export const RUN_COMPLETED_CAVEATS = [
  'exploratory_exposure_unestablished',
] as const;
export type RunCompletedCaveat = (typeof RUN_COMPLETED_CAVEATS)[number];
export const RunCompletedEvent = envelope(
  'run_completed',
  z
    .object({
      attempt_id: z.string().min(1),
      outcome: z.string().min(1),
      caveat: z.enum(RUN_COMPLETED_CAVEATS).optional(),
    })
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
export const BlockRosterEntrySchema = z
  .object({
    sample_id: z.string().min(1),
    arm: z.string().min(1),
    supersedes: z.string().min(1).optional(),
  })
  .strict();
export type BlockRosterEntry = z.infer<typeof BlockRosterEntrySchema>;

// E7.2 legacy round-trip: shipped D1 rows parse unchanged on this arm. The
// self-cycle rule is locally detectable and holds here too — a successor is
// never the replaced block itself.
const BlockReplacedLegacyPayload = z
  .object({
    block_id: z.string().min(1),
    replacement_block_id: z.string().min(1),
    cause: z.enum(INSTRUMENT_CAUSES),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.block_id === payload.replacement_block_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replacement_block_id'],
        message:
          'replacement_block_id must differ from block_id (no self-cycle)',
      });
    }
  });
// E7.2 reason/kind partition, both directions. R-DSP-5: instrument
// replacement, skew_refill, exposure_audit, and contention consume the
// registered per-cell reserve ordinals (kind 'replacement'; contention is
// never rerun kind). R-RCV-2: the rerun entry exists only for
// dispatcher_restart, snapshot_drift, and storage_failure.
const RERUN_REASONS: readonly BlockReplacementReason[] = [
  'dispatcher_restart',
  'snapshot_drift',
  'storage_failure',
];
const BlockReplacedFreshPayload = z
  .object({
    block_id: z.string().min(1),
    replacement_block_id: z.string().min(1),
    reason: z.enum(BLOCK_REPLACEMENT_REASONS),
    kind: z.enum(['replacement', 'rerun']),
    reserve_activation: z.boolean(),
    roster: z.array(BlockRosterEntrySchema).min(1),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (payload.kind === 'replacement') {
      if (!payload.reserve_activation) {
        issue(
          'reserve_activation',
          "kind 'replacement' must activate a reserve block (reserve_activation: true)",
        );
      }
      // Same-arm pairing is total (one sample per arm per cell), so every
      // roster entry names its predecessor.
      if (payload.roster.some((entry) => entry.supersedes === undefined)) {
        issue(
          'roster',
          "kind 'replacement' roster entries must each carry supersedes",
        );
      }
    } else {
      // Rerun re-executes the predecessor's own samples: reserve- and
      // count-neutral, never a supersession.
      if (payload.reserve_activation) {
        issue(
          'reserve_activation',
          "kind 'rerun' is reserve-neutral (reserve_activation: false)",
        );
      }
      if (payload.roster.some((entry) => entry.supersedes !== undefined)) {
        issue(
          'roster',
          "kind 'rerun' roster entries must not carry supersedes",
        );
      }
    }
    const isRerunReason = RERUN_REASONS.includes(payload.reason);
    if (payload.kind === 'rerun' && !isRerunReason) {
      issue('kind', `reason '${payload.reason}' is always kind 'replacement'`);
    } else if (payload.kind === 'replacement' && isRerunReason) {
      issue('kind', `reason '${payload.reason}' is always kind 'rerun'`);
    }
    if (payload.block_id === payload.replacement_block_id) {
      issue(
        'replacement_block_id',
        'replacement_block_id must differ from block_id (no self-cycle)',
      );
    }
    // E7.3a graph-structural rules expressible within one roster: successor
    // one-to-one, predecessor uniqueness, one sample per arm (E7.1 — the
    // same-arm pairing is total), no intra-roster cycles. Same-cell/same-arm
    // preservation against the frozen Campaign belongs to the replay-time
    // instance-graph validator.
    const arms = payload.roster.map((entry) => entry.arm);
    if (new Set(arms).size !== arms.length) {
      issue('roster', 'roster arm values must be unique (one sample per arm)');
    }
    const successorIds = payload.roster.map((entry) => entry.sample_id);
    if (new Set(successorIds).size !== successorIds.length) {
      issue('roster', 'roster sample_id values must be unique');
    }
    const predecessors = payload.roster
      .map((entry) => entry.supersedes)
      .filter((id): id is string => id !== undefined);
    if (new Set(predecessors).size !== predecessors.length) {
      issue('roster', 'roster supersedes values must be unique');
    }
    const successorSet = new Set(successorIds);
    if (predecessors.some((id) => successorSet.has(id))) {
      issue(
        'roster',
        'a supersedes value must not name a roster sample_id (successors are fresh samples)',
      );
    }
  });
export type BlockReplacedPayload =
  | z.infer<typeof BlockReplacedLegacyPayload>
  | z.infer<typeof BlockReplacedFreshPayload>;
export const BlockReplacedEvent = envelope(
  'block_replaced',
  z.union([BlockReplacedLegacyPayload, BlockReplacedFreshPayload]),
);

export interface BlockReplacedRecord {
  readonly block_id: string;
  readonly replacement_block_id: string;
  readonly reason: BlockReplacementReason;
  readonly kind: 'replacement' | 'rerun';
  readonly reserve_activation: boolean;
  /** Empty for legacy rows: replay derives same-arm pairing from
   *  membership (E7.2 round-trip rule). */
  readonly roster: readonly BlockRosterEntry[];
}

/** E7.2 legacy round-trip: shipped rows parse as
 *  { reason: cause, kind: 'replacement' }, reserve_activation defaults to
 *  kind === 'replacement', absent roster stays empty (replay derives). */
export function normalizeBlockReplaced(
  payload: BlockReplacedPayload,
): BlockReplacedRecord {
  if ('cause' in payload) {
    return {
      block_id: payload.block_id,
      replacement_block_id: payload.replacement_block_id,
      reason: payload.cause,
      kind: 'replacement',
      reserve_activation: true,
      roster: [],
    };
  }
  return {
    block_id: payload.block_id,
    replacement_block_id: payload.replacement_block_id,
    reason: payload.reason,
    kind: payload.kind,
    reserve_activation: payload.reserve_activation,
    roster: payload.roster,
  };
}
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
// E7.4 quarantine carrier: binding-only (no state-machine edges, like
// attempt_created); routed to the quarantine projection only.
/** The machine disposition for a terminal whose ACTUAL cost the run
 *  artifacts cannot supply. R-JRN-12 pins that `spend` rows carry actuals,
 *  so no spend may be journaled — but a budget position that silently drops
 *  a real cost is worse than no position at all, so the gap is recorded and
 *  the campaign fail-stops. Carried on the existing `adjudication` event:
 *  the pinned machine-disposition convention (the same one that carries
 *  `replacement_suppressed`, `reserve_exhausted`, and `ballast_spent`), no
 *  vocabulary change. */
export const UNPRICED_TERMINAL = 'unpriced_terminal';

/** The machine disposition recovery stamps when it journals an attempt's
 *  ACTUAL spend from the run artifacts — a suffix a crash truncated, a
 *  withheld-terminal run whose spend never landed, or a resolved
 *  `unpriced_terminal` gap.
 *
 *  It exists because `budget_event` carries no attempt identity and E7.7
 *  pins that it never will ("Deterministic over the event stream with the
 *  shipped payload; no additive field. Per-sample spend attribution still
 *  derives at seal from run-dir evidence … not the journal"). Repair must
 *  nevertheless be judged PER ATTEMPT and be idempotent, so the receipt
 *  carries the identity the spend row cannot, on the existing `adjudication`
 *  event under the same pinned machine-disposition convention. The receipt
 *  is appended IMMEDIATELY BEFORE the spend it records: a receipt with no
 *  spend after it recorded nothing, so an interrupted repair simply runs
 *  again. */
export const SPEND_RECOVERED = 'spend_recovered';

/** `attempt=<id>; <detail>` — the attempt identity encoded into the only
 *  free field the event has. Shared by every attempt-scoped machine
 *  disposition (`spend_recovered`, `unpriced_terminal`) so a reader never
 *  has to guess which attempt a resolution belongs to, and never has to
 *  infer it from an adjacent event that may not exist. */
export function attemptScopedRationale(
  attemptId: string,
  detail: string,
): string {
  return `attempt=${attemptId}; ${detail}`;
}

/** The attempt an attempt-scoped rationale names, or null if unparseable. */
export function attemptOfRationale(rationale: string): string | null {
  return /^attempt=([^;]+);/.exec(rationale)?.[1] ?? null;
}

export const QUARANTINE_REASONS = [
  'attempt_mismatch',
  'late_terminal',
  'campaign_mismatch',
] as const;
export const QuarantinedEvent = envelope(
  'quarantined',
  z
    .object({
      run_id: z.string().min(1),
      attempt_id: z.string().min(1).optional(),
      reason: z.enum(QUARANTINE_REASONS),
    })
    .strict(),
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
  QuarantinedEvent,
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
  'quarantined',
  'sealed',
];
