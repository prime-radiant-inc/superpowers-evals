import { z } from 'zod';

// Shape of coding-agent-token-usage.json (duration_ms added at capture time).
export const PerModelUsageSchema = z.object({
  total_input: z.number(),
  total_cache_create: z.number(),
  total_cache_read: z.number(),
  total_output: z.number(),
  total_tokens: z.number(),
  provider: z.string(),
  est_cost_usd: z.number().nullable(),
});

export const TokenUsageSchema = z.object({
  total_input: z.number(),
  total_cache_create: z.number(),
  total_cache_read: z.number(),
  total_output: z.number(),
  total_tokens: z.number(),
  model: z.string().nullable(),
  models: z.record(PerModelUsageSchema),
  est_cost_usd: z.number().nullable(),
  unpriced_models: z.array(z.string()),
  approximations: z.array(
    z.object({ kind: z.string(), detail: z.string().nullable() }),
  ),
  pricing_as_of: z.string().nullable(),
  duration_ms: z.number().nullable().optional(),
  tool_result_total_bytes: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
