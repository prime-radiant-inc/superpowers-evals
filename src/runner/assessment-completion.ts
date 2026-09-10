import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

const CompletionSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().regex(/^[a-zA-Z0-9-]+_\d{8}T\d{6}Z_[a-z0-9]{4}$/),
  status: z.enum(['completed', 'timed_out', 'cancelled', 'errored']),
  reason: z.string().refine((value) => value.trim().length > 0),
  terminal_at: z
    .string()
    .refine(
      (value) =>
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value,
    ),
  accepted_report_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

export function readAssessmentCompletion(input: {
  outDir: string;
  runId: string;
}): z.infer<typeof CompletionSchema> {
  const completion = CompletionSchema.parse(
    JSON.parse(
      readFileSync(join(input.outDir, 'assessment-completion.json'), 'utf8'),
    ),
  );
  if (
    completion.run_id !== input.runId ||
    basename(input.outDir) !== input.runId
  )
    throw new Error('assessment completion run identity mismatch');
  if (
    (completion.status === 'completed') !==
    (completion.accepted_report_sha256 !== null)
  )
    throw new Error('assessment completion digest contradicts status');
  if (completion.status === 'completed') {
    const bytes = readFileSync(join(input.outDir, 'result.json'));
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      completion.accepted_report_sha256
    )
      throw new Error('assessment completion digest mismatch');
    const result = z
      .object({
        runId: z.literal(input.runId),
        scenario: z.literal(input.runId.split('_')[0]),
        status: z.enum(['pass', 'fail', 'investigate']),
        summary: z.string(),
        reasoning: z.string(),
        criteria: z.unknown(),
      })
      .parse(JSON.parse(bytes.toString('utf8')));
    const criteria = z
      .array(
        z.object({
          criterion: z.string().trim().min(1),
          verdict: z.enum(['pass', 'fail', 'unclear']),
          evidence: z.string().trim().min(1),
        }),
      )
      .min(1)
      .safeParse(result.criteria);
    if (!criteria.success)
      throw new Error(
        'Assessment inconclusive: missing or inconsistent criteria',
      );
    const expected = criteria.data.some((c) => c.verdict === 'fail')
      ? 'fail'
      : criteria.data.every((c) => c.verdict === 'pass')
        ? 'pass'
        : 'investigate';
    if (result.status !== expected)
      throw new Error(
        'Assessment inconclusive: missing or inconsistent criteria',
      );
  }
  return completion;
}

export function applyAssessmentStop(
  existing: 'cancelled' | 'timed_out' | null,
  child: 'completed' | 'timed_out' | 'cancelled' | 'errored',
): 'cancelled' | 'timed_out' | null {
  return (
    existing ??
    (child === 'timed_out'
      ? 'timed_out'
      : child === 'cancelled'
        ? 'cancelled'
        : null)
  );
}
