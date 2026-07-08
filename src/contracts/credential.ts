import { z } from 'zod';

export const CREDENTIAL_APIS = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
  'mantle',
] as const;
export const CREDENTIAL_AUTHS = [
  'api-key',
  'subscription',
  'oauth',
  'bedrock-bearer',
] as const;
const _COMPAT_KEYS = ['thinking_format', 'max_tokens_field'] as const;

const CompatSchema = z
  .object({
    thinking_format: z.enum(['zai']).optional(),
    max_tokens_field: z.string().optional(),
  })
  .strict() // unknown compat keys are an error (spec §12)
  .default({});

export const CredentialSchema = z.object({
  model: z.string().min(1),
  harnesses: z.array(z.string().min(1)).min(1),
  api: z.enum(CREDENTIAL_APIS).default('openai-chat'),
  base_url: z.string().url().optional(),
  auth: z.enum(CREDENTIAL_AUTHS).default('api-key'),
  api_key_env: z.string().min(1).optional(),
  // Explicit pi provider name for the OAuth path (e.g. 'openai-codex'). When set,
  // it overrides the host pi settings.json defaultProvider so eval runs use a
  // reproducible provider instead of inheriting a mutable host setting.
  provider: z.string().min(1).optional(),
  compat: CompatSchema,
  max_concurrency: z.number().int().min(1).optional(),
  launch_spacing_seconds: z.number().min(0).optional(),
  os_support: z.array(z.string()).optional(),
  // AWS region for a Bedrock/Mantle credential (api: 'mantle'). Required for
  // mantle by quorum check; the schema is non-strict, so it must be declared
  // here to survive parsing.
  region: z.string().min(1).optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;

const NAME_RE = /^[a-z0-9_]+$/;
export function parseCredentialsFile(raw: unknown): Record<string, Credential> {
  const obj = z.record(z.string(), z.unknown()).parse(raw);
  const out: Record<string, Credential> = {};
  for (const [name, value] of Object.entries(obj)) {
    if (!NAME_RE.test(name)) {
      throw new Error(`credential name must match [a-z0-9_]+ : ${name}`);
    }
    out[name] = CredentialSchema.parse(value);
  }
  return out;
}
