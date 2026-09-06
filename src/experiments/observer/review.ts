import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RelativeArtifactPathSchema } from '../../contracts/campaign/execution.ts';
import { Sha256Schema } from '../../contracts/campaign/experiment.ts';
import {
  type ObserverSupportingFile,
  RawAnchorSchema,
  type RawPrefix,
  RawPrefixSchema,
} from './contracts.ts';
export const SupportingPrefixSchema = z
  .object({
    root_id: z.string().min(1),
    relative_path: RelativeArtifactPathSchema,
    bytes: z.number().int().safe().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();
export type SupportingPrefix = z.infer<typeof SupportingPrefixSchema>;
const supportingKey = (file: { root_id: string; relative_path: string }) =>
  JSON.stringify([file.root_id, file.relative_path]);
export function createSupportingPrefixes(
  files: readonly ObserverSupportingFile[],
): SupportingPrefix[] {
  const prefixes = files
    .map((file) =>
      SupportingPrefixSchema.parse({
        root_id: file.root_id,
        relative_path: file.relative_path,
        bytes: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      }),
    )
    .sort((a, b) => supportingKey(a).localeCompare(supportingKey(b)));
  if (new Set(prefixes.map(supportingKey)).size !== prefixes.length)
    throw new Error('Supporting member identities must be unique.');
  return prefixes;
}
/** Observations retain earlier bytes; final reviews cover the complete supporting snapshot. */
export function verifySupportingPrefixes(
  files: readonly ObserverSupportingFile[],
  prefixes: readonly SupportingPrefix[],
  complete: boolean,
): void {
  const inventory = createSupportingPrefixes(files);
  const parsed = z.array(SupportingPrefixSchema).parse(prefixes);
  if (
    new Set(parsed.map(supportingKey)).size !== parsed.length ||
    (complete && inventory.length !== parsed.length)
  )
    throw new Error('Supporting prefix inventory differs.');
  for (const prefix of parsed) {
    const file = files.find(
      (file) => supportingKey(file) === supportingKey(prefix),
    );
    if (
      !file ||
      file.bytes.length < prefix.bytes ||
      (complete && file.bytes.length !== prefix.bytes) ||
      createHash('sha256')
        .update(file.bytes.subarray(0, prefix.bytes))
        .digest('hex') !== prefix.sha256
    )
      throw new Error('Supporting member prefix changed or is missing.');
  }
}

export interface ArtifactReceipt {
  schema_version: 2;
  observation_id: string;
  source_prefix: RawPrefix;
  supporting_prefixes: SupportingPrefix[];
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
    supporting_prefixes: z.array(SupportingPrefixSchema),
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

const NoteSchema = z.string().min(1);
const ArtifactStageSchema = z.enum(['spec', 'plan']);
const ReviewEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('understanding'),
      anchor: RawAnchorSchema,
      aligned: z.boolean(),
      note: NoteSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('design_approval'),
      anchor: RawAnchorSchema,
      presented_anchor: RawAnchorSchema,
      note: NoteSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact_approval'),
      stage: ArtifactStageSchema,
      anchor: RawAnchorSchema,
      presented_anchor: RawAnchorSchema,
      receipt: z.string().min(1),
      aligned: z.boolean(),
      note: NoteSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('execution_choice'),
      anchor: RawAnchorSchema,
      method: z.enum(['inline', 'subagent_driven']),
      note: NoteSchema,
    })
    .strict(),
]);
const ReviewActionSchema = z
  .object({
    anchor: RawAnchorSchema,
    call_id: z.string().min(1),
    effects: z
      .array(
        z.enum([
          'read_only',
          'process',
          'spec_write',
          'plan_write',
          'implementation',
          'delegation',
          'unknown',
        ]),
      )
      .nonempty()
      .refine(
        (effects) => new Set(effects).size === effects.length,
        'Duplicate effect',
      ),
    result_anchors: z.array(RawAnchorSchema),
    success: z.boolean().nullable(),
    changed_artifacts: z
      .array(ArtifactStageSchema)
      .refine(
        (stages) => new Set(stages).size === stages.length,
        'Duplicate changed artifact',
      ),
    delegation: z.enum(['advisory', 'implementation', 'unresolved']).nullable(),
    note: NoteSchema,
  })
  .strict();

export const ActorReviewSchema = z
  .object({
    schema_version: z.literal(2),
    source_prefixes: z.array(RawPrefixSchema),
    supporting_prefixes: z.array(SupportingPrefixSchema),
    reviewer: NoteSchema,
    stop_reason: z.enum([
      'endpoint',
      'violation',
      'timeout',
      'infrastructure',
      'assisted',
    ]),
    events: z.array(ReviewEventSchema),
    actions: z.array(ReviewActionSchema),
  })
  .strict();

export type ActorReview = z.infer<typeof ActorReviewSchema>;
export type ReviewEvent = ActorReview['events'][number];
export type ReviewAction = ActorReview['actions'][number];

export function validateActorReview(value: unknown): ActorReview {
  return ActorReviewSchema.parse(value);
}
