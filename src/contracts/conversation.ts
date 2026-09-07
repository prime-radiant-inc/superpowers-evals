import { posix } from 'node:path';
import { z } from 'zod';

const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => {
      if (path.includes('\\') || posix.isAbsolute(path)) return false;
      const parts = path.split('/');
      return parts.every(
        (part) => part !== '' && part !== '.' && part !== '..',
      );
    },
    { message: 'expected a normalized relative path' },
  );

const VisibleEvidenceSchema = z
  .object({
    path: RelativePathSchema,
    quote: z.string().trim().min(1),
  })
  .strict();

export const ConversationRecordSchema = z
  .object({
    status: z.enum(['completed', 'stopped', 'timed_out', 'errored']),
    endpoint: z.enum(['delivery', 'refusal']).nullable(),
    reason: z.string(),
    timestamp: z.string().datetime({ offset: true }),
    evidence: VisibleEvidenceSchema.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.status === 'completed') {
      if (record.endpoint === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoint'],
          message: 'completed conversation requires an endpoint',
        });
      }
      if (record.evidence === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: 'completed conversation requires visible evidence',
        });
      }
    } else if (record.endpoint !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['endpoint'],
        message: 'non-completed conversation cannot have an endpoint',
      });
    }
  });
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;

export const EvidenceIndexSchema = z
  .object({ files: z.array(RelativePathSchema) })
  .strict()
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < index.files.length; i++) {
      const path = index.files[i] as string;
      if (seen.has(path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i],
          message: `duplicate evidence path: ${path}`,
        });
      }
      seen.add(path);
    }
  });
export type EvidenceIndex = z.infer<typeof EvidenceIndexSchema>;

const ProcessExitSchema = z
  .object({
    code: z.number().int().min(0).max(255).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .nullable(),
  })
  .strict()
  .refine((exit) => (exit.code === null) !== (exit.signal === null), {
    message: 'settled role exit requires exactly one code or signal',
  });

export const GauntletRoleRecordSchema = z
  .object({
    out_dir: RelativePathSchema,
    model: z.string().min(1),
    started_at: z.string().datetime({ offset: true }).nullable(),
    finished_at: z.string().datetime({ offset: true }).nullable(),
    process_exit: ProcessExitSchema.nullable(),
    stop_cause: z.enum(['cancelled', 'timed_out']).nullable(),
  })
  .strict();
export type GauntletRoleRecord = z.infer<typeof GauntletRoleRecordSchema>;

export const GauntletRolesSchema = z
  .object({
    conversation: GauntletRoleRecordSchema,
    assessment: GauntletRoleRecordSchema,
  })
  .strict();
export type GauntletRoles = z.infer<typeof GauntletRolesSchema>;
