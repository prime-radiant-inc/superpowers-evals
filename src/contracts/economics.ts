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

/** Charged route evidence for a labeled OpenRouter campaign. This is optional
 *  on the coding-agent economics block so frozen artifacts from before route
 *  attestation retain their original shape. */
export const OpenRouterEconomicsSchema = z.object({
  charged_cost_usd: z.number().nullable(),
  estimated_cost_usd: z.number().nullable(),
  cost_delta_usd: z.number().nullable(),
  generation_count: z.number().int().nonnegative(),
  model: z.string().min(1),
  provider: z.string().min(1),
});
export type OpenRouterEconomics = z.infer<typeof OpenRouterEconomicsSchema>;
