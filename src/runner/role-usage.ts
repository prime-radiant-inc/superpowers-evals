import { z } from 'zod';

const tokens = z.number().finite().nonnegative();
const UsageSchema = z
  .object({
    type: z.literal('obol.usage'),
    v: z.literal('2026-06-08'),
    provider: z.literal('anthropic'),
    model: z.literal('anthropic.claude-sonnet-5'),
    usage: z
      .object({
        input_tokens: tokens,
        output_tokens: tokens,
        cache_read_input_tokens: tokens.optional(),
        cache_creation_input_tokens: tokens.optional(),
        cache_creation: z.record(tokens).optional(),
      })
      .passthrough(),
  })
  .passthrough();
function jsonLines(text: string): Record<string, unknown>[] {
  if (!text.endsWith('\n')) throw new Error('truncated JSONL');
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => z.record(z.unknown()).parse(JSON.parse(line)));
}
/** Returned-turn coverage only; pricing and started/settled role authority belong to the caller. */
export function verifyReturnedTurns(input: {
  runJsonl: string;
  usageJsonl: string;
  model: 'anthropic.claude-sonnet-5';
}): { returnedTurns: number; runEndTurns: number | null } {
  let responses = 0,
    pending = false;
  let runEndTurns: number | null = null;
  for (const event of jsonLines(input.runJsonl)) {
    if (event['type'] === 'llm_request') {
      if (runEndTurns !== null || pending || event['turn'] !== responses + 1)
        throw new Error('nonsequential request');
      pending = true;
    } else if (event['type'] === 'llm_response') {
      if (runEndTurns !== null || !pending || event['turn'] !== responses + 1)
        throw new Error('nonsequential response');
      responses++;
      pending = false;
    } else if (event['type'] === 'run_end') {
      const end = z
        .object({ usage: z.object({ turns: z.number().int().positive() }) })
        .parse(event);
      if (runEndTurns !== null || pending || end.usage.turns !== responses)
        throw new Error('incomplete or duplicate run end');
      runEndTurns = end.usage.turns;
    }
  }
  if (pending || responses === 0)
    throw new Error('incomplete returned-turn coverage');
  const rows = jsonLines(input.usageJsonl);
  for (const row of rows) {
    const parsed = UsageSchema.parse(row);
    if (parsed.model !== input.model) throw new Error('unexpected role model');
    for (const [key, value] of Object.entries(parsed.usage))
      if (key.endsWith('_tokens')) tokens.parse(value);
  }
  if (rows.length !== responses)
    throw new Error('usage rows do not cover all returned turns');
  return { returnedTurns: responses, runEndTurns };
}

type AssessmentAccountingInput = {
  runJsonl: string;
  usageJsonl: string;
  attemptsJsonl: string;
};
type AssessmentAccounting = {
  logicalResponses: number;
  physicalAttempts: number;
  unknownUsageAttemptIds: string[];
};
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({
  assessment_request_id: z.string().min(1),
  assessment_attempt_id: z.string().min(1),
});
const admissionSchema = identity.extend({
  schema_version: z.literal(1),
  event: z.literal('admission'),
  timestamp_ms: count,
  outcome: z.literal('admitted'),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1),
});
const settlementSchema = identity.extend({
  schema_version: z.literal(1),
  event: z.literal('settlement'),
  timestamp_ms: count,
  aborted_at_ms: count.optional(),
  outcome: z.enum([
    'response',
    'transport_error',
    'aborted',
    'capture_failure',
    'incomplete',
  ]),
  usage: z.enum(['recorded', 'not_returned', 'invalid']),
  usage_unavailable: z
    .enum([
      'api_error',
      'missing_usage',
      'invalid_usage',
      'invalid_json',
      'observation_failed',
      'transport_error',
      'aborted',
      'incomplete',
      'usage_write_failed',
    ])
    .optional(),
  accounting_failure: z.boolean(),
  capture: z.enum(['disabled', 'complete', 'failed', 'incomplete']),
});
const physicalUsageSchema = identity
  .extend({
    type: z.literal('obol.usage'),
    v: z.literal('2026-06-08'),
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().min(1),
    usage: z
      .object({ input_tokens: count, output_tokens: count })
      .passthrough(),
  })
  .passthrough();

function validateNativeTokens(usage: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(usage)) {
    // Optional native null counters/details are absent in the producer's
    // normalization. Required input/output counters were checked by the schema.
    if (value === null) continue;
    if (key.endsWith('_tokens')) count.parse(value);
    else if (key === 'cache_creation') z.record(count).parse(value);
    else if (key.endsWith('_tokens_details'))
      validateNativeTokens(z.record(z.unknown()).parse(value));
  }
}

/** Strict validation and a conservative pricing projection share the same row
 * checks. Invalid evidence remains invalid even if obol could price it. The
 * projection retains valid physical usage on interrupted/publication failures;
 * it never rewrites the producer's sidecars or prices logical response usage. */
export function reconcileAssessmentAccounting(
  input: AssessmentAccountingInput,
): {
  accounting: AssessmentAccounting;
  reportEligible: boolean;
  complete: boolean;
  error: string | null;
  knownUsageJsonl: string;
} {
  const errors: string[] = [];
  const check = (action: () => void) => {
    try {
      action();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };
  const readLines = (text: string, label: string) => {
    if (text === '') return [];
    if (!text.endsWith('\n')) errors.push(`truncated ${label} JSONL`);
    const rows: Record<string, unknown>[] = [];
    // A truncated tail supplies no settled row; earlier complete rows survive.
    for (const line of text.split('\n').slice(0, -1))
      check(() => {
        rows.push(z.record(z.unknown()).parse(JSON.parse(line)));
      });
    return rows;
  };
  const requests = new Set<string>();
  const responses = new Set<string>();
  const abandoned = new Map<string, string>();
  let pending: string | null = null;
  let ended = false;
  for (const event of readLines(input.runJsonl, 'run'))
    check(() => {
      if (event['type'] === 'llm_request' || event['type'] === 'llm_response') {
        const turn = count.parse(event['turn']);
        const id = String(turn).padStart(3, '0');
        if (turn === 0 || event['assessment_request_id'] !== id || ended)
          throw new Error('invalid assessment logical identity');
        if (event['type'] === 'llm_request') {
          if (turn !== requests.size + 1 || requests.has(id))
            throw new Error('duplicate or nonsequential assessment request');
          if (pending !== null) abandoned.set(pending, id);
          requests.add(id);
          pending = id;
        } else {
          if (pending !== id || !requests.has(id) || responses.has(id))
            throw new Error('missing or duplicate assessment response link');
          responses.add(id);
          pending = null;
        }
      } else if (event['type'] === 'run_end') {
        const end = z
          .object({ usage: z.object({ turns: count }) })
          .parse(event);
        if (ended || end.usage.turns !== responses.size)
          throw new Error('inconsistent assessment run end');
        ended = true;
      }
    });
  const admissions = new Map<string, z.infer<typeof admissionSchema>>();
  const settlements = new Map<string, z.infer<typeof settlementSchema>>();
  for (const event of readLines(input.attemptsJsonl, 'attempts'))
    check(() => {
      if (event['event'] === 'admission') {
        const row = admissionSchema.parse(event);
        const id = row.assessment_attempt_id;
        if (admissions.has(id)) throw new Error('duplicate physical admission');
        if (id !== String(admissions.size + 1).padStart(3, '0'))
          errors.push('nonsequential physical admission');
        if (!requests.has(row.assessment_request_id))
          throw new Error('physical admission missing logical request');
        admissions.set(id, row);
      } else {
        const row = settlementSchema.parse(event);
        const id = row.assessment_attempt_id;
        const admitted = admissions.get(id);
        if (
          !admitted ||
          admitted.assessment_request_id !== row.assessment_request_id ||
          settlements.has(id) ||
          row.timestamp_ms < admitted.timestamp_ms
        )
          throw new Error('missing or duplicate physical settlement link');
        settlements.set(id, row);
        if (
          (row.usage === 'recorded') !==
          (row.usage_unavailable === undefined)
        )
          throw new Error('contradictory physical usage coverage');
        if (row.accounting_failure || row.usage === 'invalid')
          throw new Error(`physical accounting failure: ${id}`);
      }
    });
  const known = new Map<string, string>();
  const seenRows = new Set<string>();
  for (const row of readLines(input.usageJsonl, 'usage'))
    check(() => {
      const parsed = physicalUsageSchema.parse(row);
      const id = parsed.assessment_attempt_id;
      if (seenRows.has(id)) throw new Error('duplicate physical usage row');
      seenRows.add(id);
      const admitted = admissions.get(id);
      if (
        !admitted ||
        admitted.assessment_request_id !== parsed.assessment_request_id ||
        admitted.provider !== parsed.provider ||
        admitted.model !== parsed.model
      )
        throw new Error('physical usage identity/provider/model mismatch');
      validateNativeTokens(parsed.usage);
      if (parsed.provider === 'openai') {
        const details = parsed.usage['input_tokens_details'];
        const cached =
          details == null
            ? 0
            : (z.object({ cached_tokens: count.nullish() }).parse(details)
                .cached_tokens ?? 0);
        if (cached > parsed.usage.input_tokens)
          throw new Error('cached tokens exceed input tokens');
      }
      known.set(id, JSON.stringify(row));
    });
  for (const [id, admitted] of admissions)
    check(() => {
      const settled = settlements.get(id);
      if (!settled) throw new Error(`missing physical settlement: ${id}`);
      if ((settled.usage === 'recorded') !== known.has(id))
        throw new Error(`physical usage row/settlement mismatch: ${id}`);
      if (
        responses.has(admitted.assessment_request_id) &&
        settled.usage === 'invalid'
      )
        throw new Error('logical response has invalid physical usage');
    });
  for (const id of responses)
    check(() => {
      if (
        ![...admissions.values()].some(
          (a) =>
            a.assessment_request_id === id &&
            settlements.get(a.assessment_attempt_id)?.usage === 'recorded' &&
            known.has(a.assessment_attempt_id),
        )
      )
        throw new Error('logical response missing recorded physical response');
    });
  // A phase change may abandon an SDK request, including retry backoff after
  // a settled error. Physical work must settle before successor admission;
  // cancellation need not leave a marker after the physical response settles.
  for (const [predecessor, successor] of abandoned)
    check(() => {
      const before = [...admissions.values()].filter(
        (a) => a.assessment_request_id === predecessor,
      );
      const after = [...admissions.values()].filter(
        (a) => a.assessment_request_id === successor,
      );
      const nextAt = Math.min(...after.map((a) => a.timestamp_ms));
      if (
        !before.length ||
        !after.length ||
        before.some((a) => {
          const settled = settlements.get(a.assessment_attempt_id);
          return (
            !settled ||
            settled.timestamp_ms < a.timestamp_ms ||
            settled.timestamp_ms > nextAt
          );
        })
      )
        throw new Error(
          'abandoned assessment request lacks settlement before successor admission',
        );
    });
  const unknownUsageAttemptIds = [...admissions.keys()].filter(
    (id) => !known.has(id),
  );
  // Routine report acceptance needs valid accounting and completed logical
  // history. Honest unknown retry usage limits cost coverage independently.
  const reportEligible =
    errors.length === 0 && ended && pending === null && responses.size > 0;
  return {
    accounting: {
      logicalResponses: responses.size,
      physicalAttempts: admissions.size,
      unknownUsageAttemptIds,
    },
    reportEligible,
    complete: reportEligible && unknownUsageAttemptIds.length === 0,
    error: errors.length ? errors.join('; ') : null,
    knownUsageJsonl: [...known.values()].map((row) => `${row}\n`).join(''),
  };
}

/** Identity/token validity only. Honest interrupted coverage is not proof of a
 * completed assessment or qualification; lifecycle authority stays with quorum. */
export function verifyAssessmentAccounting(
  input: AssessmentAccountingInput,
): AssessmentAccounting {
  const result = reconcileAssessmentAccounting(input);
  if (result.error !== null) throw new Error(result.error);
  return result.accounting;
}
