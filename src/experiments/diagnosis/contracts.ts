import { posix, win32 } from 'node:path';
import { z } from 'zod';

export const DiagnosisHarnessSchema = z.enum(['claude', 'codex', 'pi']);
export type DiagnosisHarness = z.infer<typeof DiagnosisHarnessSchema>;

export const DIMENSIONS = [
  'skill-timeline',
  'plan-adherence',
  'repeated-work',
  'stumbles',
  'quality-evidence',
  'request-conflicts',
  'cost-and-time',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface NativeLocator {
  source: string;
  line: number;
}

export interface FixtureFile {
  path: string;
  destination: 'session-store' | 'workdir';
  relativePath: string;
  sha256: string;
}

export interface FixtureManifest {
  schemaVersion: 1;
  harness: DiagnosisHarness;
  files: FixtureFile[];
}

export interface ExpectedFinding {
  id: string;
  dimension: Dimension;
  statement: string;
  evidence: NativeLocator[];
}

export type DurationMeasurement = 'elapsed-time' | 'native-duration';

export interface QuantityMeasurement {
  value: number | null;
  scope: string;
  evidence: NativeLocator[];
  /** Required for ms quantities; every alternative declares its own convention. */
  measurement?: DurationMeasurement | undefined;
}

export interface ExpectedQuantity extends QuantityMeasurement {
  id: string;
  unit: 'tokens' | 'ms' | 'bytes' | 'count';
  alternatives?: QuantityMeasurement[] | undefined;
}

export interface DiagnosisKey {
  schemaVersion: 1;
  harness: DiagnosisHarness;
  manifestSha256: string;
  sessions: Array<{
    id: string;
    role: 'root' | 'child' | 'decoy';
    source: string;
    parentId: string | null;
    evidence: NativeLocator[];
  }>;
  humanTurns: Array<{
    id: string;
    text: string;
    timestamp: string | null;
    evidence: NativeLocator[];
  }>;
  requiredFindings: ExpectedFinding[];
  negativeControls: ExpectedFinding[];
  quantities: ExpectedQuantity[];
  capabilities: Record<
    string,
    { available: boolean; evidence: NativeLocator[] }
  >;
}

export interface FixtureArgs {
  manifest: FixtureManifest;
  corpusDir: string;
  home: string;
  workdir: string;
}

export interface FilePreservation {
  source: string;
  installedPath: string;
  expectedSha256: string;
  actualSha256: string | null;
  status: 'unchanged' | 'changed' | 'missing';
}

export interface RetainedArtifact {
  originalPath: string;
  retainedPath: string;
  sha256: string;
  bytes: number;
}

export interface DiagnosisArtifacts {
  schemaVersion: 1;
  files: RetainedArtifact[];
  preservation: FilePreservation[];
  errors: string[];
}

export interface CollectDiagnosisArgs extends FixtureArgs {
  runDir: string;
}

const NonEmptyStringSchema = z.string().min(1);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const NormalizedRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !posix.isAbsolute(value) &&
      !win32.isAbsolute(value) &&
      value !== '.' &&
      posix.normalize(value) === value &&
      !value.split('/').includes('..'),
    'must be a normalized relative path',
  );

export const NativeLocatorSchema: z.ZodType<NativeLocator> = z
  .object({
    source: NormalizedRelativePathSchema,
    line: z.number().int().positive(),
  })
  .strict();

export const FixtureFileSchema: z.ZodType<FixtureFile> = z
  .object({
    path: NormalizedRelativePathSchema,
    destination: z.enum(['session-store', 'workdir']),
    relativePath: NormalizedRelativePathSchema,
    sha256: Sha256Schema,
  })
  .strict();

export const FixtureManifestSchema: z.ZodType<FixtureManifest> = z
  .object({
    schemaVersion: z.literal(1),
    harness: DiagnosisHarnessSchema,
    files: z.array(FixtureFileSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const destinations = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      const key = `${file.destination}\0${file.relativePath}`;
      if (destinations.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate destination: ${file.destination}/${file.relativePath}`,
          path: ['files', index, 'relativePath'],
        });
      }
      destinations.add(key);
    }
  });

export const ExpectedFindingSchema: z.ZodType<ExpectedFinding> = z
  .object({
    id: NonEmptyStringSchema,
    dimension: z.enum(DIMENSIONS),
    statement: NonEmptyStringSchema,
    evidence: z.array(NativeLocatorSchema),
  })
  .strict();

const DurationMeasurementSchema = z.enum(['elapsed-time', 'native-duration']);

export const ExpectedQuantitySchema: z.ZodType<ExpectedQuantity> = z
  .object({
    id: NonEmptyStringSchema,
    value: z.number().finite().nullable(),
    unit: z.enum(['tokens', 'ms', 'bytes', 'count']),
    measurement: DurationMeasurementSchema.optional(),
    alternatives: z
      .array(
        z
          .object({
            value: z.number().finite().nullable(),
            scope: NonEmptyStringSchema,
            evidence: z.array(NativeLocatorSchema),
            measurement: DurationMeasurementSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    scope: NonEmptyStringSchema,
    evidence: z.array(NativeLocatorSchema),
  })
  .strict()
  .superRefine((quantity, context) => {
    for (const [index, item] of [
      quantity,
      ...(quantity.alternatives ?? []),
    ].entries()) {
      if ((quantity.unit === 'ms') !== (item.measurement !== undefined))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            quantity.unit === 'ms'
              ? 'ms measurement requires its explicit evidence convention'
              : 'measurement convention is only valid for ms quantities',
          path:
            index === 0
              ? ['measurement']
              : ['alternatives', index - 1, 'measurement'],
        });
    }
  });

const SessionSchema = z
  .object({
    id: NonEmptyStringSchema,
    role: z.enum(['root', 'child', 'decoy']),
    source: NormalizedRelativePathSchema,
    parentId: NonEmptyStringSchema.nullable(),
    evidence: z.array(NativeLocatorSchema),
  })
  .strict();

const HumanTurnSchema = z
  .object({
    id: NonEmptyStringSchema,
    text: NonEmptyStringSchema,
    timestamp: NonEmptyStringSchema.nullable(),
    evidence: z.array(NativeLocatorSchema),
  })
  .strict();

const CapabilitySchema = z
  .object({
    available: z.boolean(),
    evidence: z.array(NativeLocatorSchema),
  })
  .strict();

export const DiagnosisKeySchema: z.ZodType<DiagnosisKey> = z
  .object({
    schemaVersion: z.literal(1),
    harness: DiagnosisHarnessSchema,
    manifestSha256: Sha256Schema,
    sessions: z.array(SessionSchema),
    humanTurns: z.array(HumanTurnSchema),
    requiredFindings: z.array(ExpectedFindingSchema),
    negativeControls: z.array(ExpectedFindingSchema),
    quantities: z.array(ExpectedQuantitySchema),
    capabilities: z.record(NonEmptyStringSchema, CapabilitySchema),
  })
  .strict();

export type AssessmentStatus = 'pass' | 'fail' | 'incomplete';
export interface AssessedClaim {
  id: string;
  reportLines: [number, number];
  text: string;
  citations: Array<{ path: string; line: number; quote: string }>;
  judgment: 'supported' | 'unsupported' | 'uncertain';
  reason: string;
}
export interface AnalystEvidence {
  dimension: Dimension;
  sourceId: string;
  dispatchStepId: number;
  callId: string;
  batchIndex: number | null;
  childSourceId: string;
  completionStepId: number | null;
  casePath: string;
  commonPath: string;
  dimensionPath: string;
}
export interface QuantityObservation {
  id: string;
  claimId: string;
  value: number | null;
  scope: string;
  rounding: null | {
    unit:
      | 'tokens'
      | 'kTokens'
      | 'MTokens'
      | 'ms'
      | 's'
      | 'min'
      | 'bytes'
      | 'KiB'
      | 'MiB'
      | 'count';
    decimalPlaces: number;
    mode: 'nearest' | 'floor' | 'ceil';
  };
}
export interface ReviewItem {
  status: AssessmentStatus;
  reason: string;
  evidence: NativeLocator[];
}
export const RUBRIC = [
  'case',
  'environment',
  'timeline',
  'coverage',
  'involvement',
  'contextSafety',
  'scope',
  'exposure',
  'reportDelivery',
  'negativeControls',
] as const;
export interface DiagnosisReview {
  schemaVersion: 1;
  reportSha256: string;
  keySha256: string;
  /** Original absolute paths, resolved only through retained evidence. */
  reportPath: string;
  targetSessionId: string;
  sourcePath: string;
  historicalSessionIds: string[];
  humanTurnIds: string[];
  recoveredFindingIds: string[];
  quantities: QuantityObservation[];
  claims: AssessedClaim[];
  nonClaimLines: Array<{ start: number; end: number; reason: string }>;
  analysts: AnalystEvidence[];
  dimensions: Record<Dimension, ReviewItem>;
  rubric: Record<(typeof RUBRIC)[number], ReviewItem>;
  reviewer: string;
  blinded: boolean;
  unblindingReason: string | null;
}
export interface DiagnosisAssessment {
  status: AssessmentStatus;
  checks: Array<{ name: string; status: AssessmentStatus; detail: string }>;
}
export interface AssessDiagnosisArgs {
  runDir: string;
  keyPath: string;
  reviewPath: string;
}

const AbsolutePathSchema = NonEmptyStringSchema.refine(
  (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
  'must be an absolute original path',
);
const StatusSchema = z.enum(['pass', 'fail', 'incomplete']);
const PositiveInteger = z.number().int().positive();
const ReviewItemSchema = z
  .object({
    status: StatusSchema,
    reason: NonEmptyStringSchema,
    evidence: z.array(NativeLocatorSchema),
  })
  .strict();
const QuantityObservationSchema = z
  .object({
    id: NonEmptyStringSchema,
    claimId: NonEmptyStringSchema,
    value: z.number().finite().nullable(),
    scope: NonEmptyStringSchema,
    rounding: z
      .object({
        unit: z.enum([
          'tokens',
          'kTokens',
          'MTokens',
          'ms',
          's',
          'min',
          'bytes',
          'KiB',
          'MiB',
          'count',
        ]),
        decimalPlaces: z.number().int().min(0).max(12),
        mode: z.enum(['nearest', 'floor', 'ceil']),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const DiagnosisReviewSchema: z.ZodType<DiagnosisReview> = z
  .object({
    schemaVersion: z.literal(1),
    reportSha256: Sha256Schema,
    keySha256: Sha256Schema,
    reportPath: AbsolutePathSchema,
    targetSessionId: NonEmptyStringSchema,
    sourcePath: AbsolutePathSchema,
    historicalSessionIds: z.array(NonEmptyStringSchema),
    humanTurnIds: z.array(NonEmptyStringSchema),
    recoveredFindingIds: z.array(NonEmptyStringSchema),
    quantities: z.array(QuantityObservationSchema),
    claims: z.array(
      z
        .object({
          id: NonEmptyStringSchema,
          reportLines: z.tuple([PositiveInteger, PositiveInteger]),
          text: NonEmptyStringSchema,
          citations: z.array(
            z
              .object({
                path: NonEmptyStringSchema,
                line: PositiveInteger,
                quote: NonEmptyStringSchema,
              })
              .strict(),
          ),
          judgment: z.enum(['supported', 'unsupported', 'uncertain']),
          reason: NonEmptyStringSchema,
        })
        .strict(),
    ),
    nonClaimLines: z.array(
      z
        .object({
          start: PositiveInteger,
          end: PositiveInteger,
          reason: NonEmptyStringSchema,
        })
        .strict(),
    ),
    analysts: z.array(
      z
        .object({
          dimension: z.enum(DIMENSIONS),
          sourceId: NonEmptyStringSchema,
          dispatchStepId: PositiveInteger,
          callId: NonEmptyStringSchema,
          batchIndex: z.number().int().nonnegative().nullable(),
          childSourceId: NonEmptyStringSchema,
          completionStepId: PositiveInteger.nullable(),
          casePath: AbsolutePathSchema,
          commonPath: AbsolutePathSchema,
          dimensionPath: AbsolutePathSchema,
        })
        .strict(),
    ),
    dimensions: z
      .object(
        Object.fromEntries(
          DIMENSIONS.map((d) => [d, ReviewItemSchema]),
        ) as Record<Dimension, typeof ReviewItemSchema>,
      )
      .strict(),
    rubric: z
      .object(
        Object.fromEntries(RUBRIC.map((d) => [d, ReviewItemSchema])) as Record<
          (typeof RUBRIC)[number],
          typeof ReviewItemSchema
        >,
      )
      .strict(),
    reviewer: NonEmptyStringSchema,
    blinded: z.boolean(),
    unblindingReason: NonEmptyStringSchema.nullable(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (!review.blinded && !review.unblindingReason)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unblinded review requires a reason',
      });
    for (const field of [
      'historicalSessionIds',
      'humanTurnIds',
      'recoveredFindingIds',
    ] as const) {
      if (new Set(review[field]).size !== review[field].length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${field}`,
        });
    }
    for (const field of ['claims', 'quantities'] as const) {
      if (new Set(review[field].map((c) => c.id)).size !== review[field].length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${field} id`,
        });
    }
  });

export const DiagnosisArtifactsSchema: z.ZodType<DiagnosisArtifacts> = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(
      z
        .object({
          originalPath: AbsolutePathSchema,
          retainedPath: NormalizedRelativePathSchema,
          sha256: Sha256Schema,
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    preservation: z.array(
      z
        .object({
          source: NormalizedRelativePathSchema,
          installedPath: AbsolutePathSchema,
          expectedSha256: Sha256Schema,
          actualSha256: Sha256Schema.nullable(),
          status: z.enum(['unchanged', 'changed', 'missing']),
        })
        .strict(),
    ),
    errors: z.array(z.string()),
  })
  .strict();
