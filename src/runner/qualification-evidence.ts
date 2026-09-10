import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { readPinnedNoFollowBytes } from '../appliance/credential-scope.ts';
import { createDurableMarker } from '../campaign/journal.ts';

export const QualificationRefSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type QualificationRef = z.infer<typeof QualificationRefSchema>;
export function readQualificationFile(path: string): Buffer {
  const bytes = readPinnedNoFollowBytes(
    dirname(path),
    [basename(path)],
    'qualification evidence',
    true,
  );
  if (bytes === null) throw Error('qualification evidence missing');
  return bytes;
}
export function qualificationRef(path: string): QualificationRef {
  return {
    path,
    sha256: createHash('sha256')
      .update(readQualificationFile(path))
      .digest('hex'),
  };
}
export function authenticateQualificationRef(ref: QualificationRef): Buffer {
  const bytes = readQualificationFile(ref.path);
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
    throw Error('qualification evidence digest mismatch');
  return bytes;
}
export function writeQualificationJson(
  path: string,
  value: unknown,
): QualificationRef {
  createDurableMarker(path, `${JSON.stringify(value)}\n`);
  return qualificationRef(path);
}
const count = z.number().int().nonnegative();
export const QualificationMeasurementSchema = z.object({
  kind: z.enum(['assessment', 'driver']),
  accepted: z.boolean(),
  actual: z.array(z.enum(['pass', 'fail', 'unclear'])).nullable(),
  result: QualificationRefSchema.nullable(),
  inputs: z.array(QualificationRefSchema),
  artifacts: z.array(QualificationRefSchema),
  expectation: QualificationRefSchema,
  firstReportValid: z.boolean().nullable(),
  eventualReportCompletion: z.boolean(),
  logicalAttempts: count.nullable(),
  logicalResponses: count.nullable(),
  physicalAttempts: count.nullable(),
  corrections: count.nullable(),
  unknownUsageAttemptIds: z.array(z.string()).nullable(),
  costComplete: z.boolean(),
  knownUsd: z.number().finite().nonnegative(),
  totalUsd: z.number().finite().nonnegative().nullable(),
  latencyMs: z.number().finite().nonnegative(),
});
export type QualificationMeasurement = z.infer<
  typeof QualificationMeasurementSchema
>;
