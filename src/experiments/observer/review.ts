import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RelativeArtifactPathSchema } from '../../contracts/campaign/execution.ts';
import { Sha256Schema } from '../../contracts/campaign/experiment.ts';
import { type RawPrefix, RawPrefixSchema } from './contracts.ts';
export interface ArtifactReceipt {
  schema_version: 2;
  observation_id: string;
  source_prefix: RawPrefix;
  artifact_path: string;
  bytes: number;
  sha256: string;
  content_base64: string;
}

export const ArtifactReceiptSchema: z.ZodType<ArtifactReceipt> = z
  .object({
    schema_version: z.literal(2),
    observation_id: z.string().min(1),
    source_prefix: RawPrefixSchema,
    artifact_path: RelativeArtifactPathSchema,
    bytes: z.number().int().safe().nonnegative(),
    sha256: Sha256Schema,
    content_base64: z.string(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const content = Buffer.from(receipt.content_base64, 'base64');
    if (
      content.toString('base64') !== receipt.content_base64 ||
      content.length !== receipt.bytes ||
      createHash('sha256').update(content).digest('hex') !== receipt.sha256
    )
      context.addIssue({
        code: 'custom',
        message:
          'Receipt content must exactly match its byte count and digest.',
      });
  });

export function validateArtifactReceipt(value: unknown): ArtifactReceipt {
  return ArtifactReceiptSchema.parse(value);
}
