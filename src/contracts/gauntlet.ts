import { z } from 'zod';
import { GAUNTLET_STATUSES } from './verdict.ts';

// Gauntlet writes result.json (schemaVersion 5). We read only the fields quorum
// needs; unknown fields pass through, so gauntlet can evolve without breaking us.
export const GauntletResultSchema = z
  .object({
    schemaVersion: z.number().optional(),
    runId: z.string().optional(),
    status: z.enum(GAUNTLET_STATUSES),
    summary: z.string().default(''),
    reasoning: z.string().default(''),
    duration_ms: z.number().optional(),
    config: z.object({ model: z.string().optional() }).passthrough().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type GauntletResultJson = z.infer<typeof GauntletResultSchema>;
