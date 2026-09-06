import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RelativeArtifactPathSchema } from '../../contracts/campaign/execution.ts';
import { Sha256Schema } from '../../contracts/campaign/experiment.ts';
import {
  RawAnchorSchema,
  type RawPrefix,
  RawPrefixSchema,
} from './contracts.ts';
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
