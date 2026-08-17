import { z } from 'zod';
import { CHECK_PHASES } from './verdict.ts';

export const ManifestEntrySchema = z.object({
  phase: z.enum(CHECK_PHASES),
  check: z.string(),
  // null = wildcard: matches records with any args (used when the checks.sh
  // token contains `$`, whose runtime expansion the extractor cannot predict).
  args: z.array(z.string()).nullable(),
  negated: z.boolean(),
  count: z.number().int().positive(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const CheckManifestSchema = z.object({
  schema_version: z.literal(1),
  entries: z.array(ManifestEntrySchema),
});
export type CheckManifest = z.infer<typeof CheckManifestSchema>;
