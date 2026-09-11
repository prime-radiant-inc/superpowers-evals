import { z } from 'zod';
import { ManifestEntrySchema } from '../check-manifest.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const EvidenceClassSchema = z.enum([
  'native_session',
  'normalized_trace',
  'visible_delivery',
  'output',
  'check_dispositions',
]);
export const CriterionRequirementSchema = z
  .object({
    id: z.string().min(1),
    requires_assessment_qualification: z.boolean().optional(),
    ordinal: z.number().int().positive(),
    text: z.string().min(1),
    required_artifact_classes: z.array(EvidenceClassSchema),
    check_refs: z.array(
      z
        .object({
          ordinal: z.number().int().nonnegative(),
          scope: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export const CheckRequirementSchema = ManifestEntrySchema.extend({
  ordinal: z.number().int().nonnegative(),
  authority: z
    .object({
      kind: z.enum([
        'unclassified',
        'precondition',
        'process_check',
        'output_check',
        'source_preservation',
        'independent_behavior',
      ]),
      sources: z.array(z.string().min(1)),
    })
    .strict(),
}).strict();
export const ScenarioMeasurementSchema = z
  .object({
    mode: z.enum(['qa', 'conversation']),
    story_sha256: Digest,
    rubric_sha256: Digest,
    check_manifest_sha256: Digest,
    criteria: z.array(CriterionRequirementSchema),
    checks: z.array(CheckRequirementSchema),
  })
  .strict();
export const MeasurementRequirementsSchema = z.record(
  z.string(),
  ScenarioMeasurementSchema,
);
export type ScenarioMeasurement = z.infer<typeof ScenarioMeasurementSchema>;
export type MeasurementRequirements = z.infer<
  typeof MeasurementRequirementsSchema
>;

const FileReferenceSchema = z
  .object({ path: z.string().min(1), sha256: Digest })
  .strict();
const ActorCostCoverageSchema = z
  .object({
    known_subtotal: z.number().finite().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
const QualificationObservationSchema = z
  .object({
    case_id: z.string().min(1),
    replicate: z.number().int().positive(),
    completed: z.boolean(),
    criteria: z.array(
      z
        .object({
          criterion: z.number().int().positive(),
          verdict: z.enum(['pass', 'fail', 'unclear']).nullable(),
          reason_support: z.enum(['supported', 'unsupported', 'unavailable']),
        })
        .strict(),
    ),
    cost: z
      .object({
        subject: ActorCostCoverageSchema,
        grader: ActorCostCoverageSchema,
      })
      .strict(),
  })
  .strict();
export const AssessmentQualificationRecordSchema = z
  .object({
    schema_version: z.literal(1),
    gauntlet_sha: z.string().regex(/^[a-f0-9]{40}$/),
    grader: z
      .object({
        credential: z.string().min(1),
        model: z.string().min(1),
        configuration_sha256: Digest,
      })
      .strict(),
    evidence_semantics_sha256: Digest,
    scopes: z.array(
      z
        .object({
          scenario: z.string().min(1),
          rubric_sha256: Digest,
          criterion_ids: z.array(z.string().min(1)).min(1),
          assessment_ms: z.number().int().positive(),
          report_grace_ms: z.number().int().positive(),
          case_manifest: FileReferenceSchema,
          private_receipt_sha256: Digest,
          observations: z.array(QualificationObservationSchema),
        })
        .strict(),
    ),
  })
  .strict();
export const QualificationCoverageSchema = z
  .object({
    reference: FileReferenceSchema,
    scopes: z.array(
      z
        .object({
          scenario: z.string(),
          criterion_ids: z.array(z.string()),
          status: z.enum(['qualified', 'unverified']),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type QualificationCoverage = z.infer<typeof QualificationCoverageSchema>;
