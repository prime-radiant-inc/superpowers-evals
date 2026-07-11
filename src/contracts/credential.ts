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
const LABEL_VALUE_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const DISPLAY_LABEL_RE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const API_KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CANONICAL_BASE_URL_RE = /^https?:\/\//i;

const BaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!CANONICAL_BASE_URL_RE.test(value)) {
      return false;
    }
    const url = new URL(value);
    const schemeDelimiter = value.indexOf('://');
    const authority =
      schemeDelimiter >= 0
        ? (value.slice(schemeDelimiter + 3).split(/[/?#]/, 1)[0] ?? '')
        : '';
    return (
      url.username === '' &&
      url.password === '' &&
      !authority.includes('@') &&
      !value.includes('?') &&
      !value.includes('#')
    );
  }, 'base_url must use canonical HTTP(S) syntax without userinfo, query parameters, or a fragment');

const CompatSchema = z
  .object({
    thinking_format: z.enum(['zai']).optional(),
    max_tokens_field: z.string().optional(),
    tool_choice_auto_only: z.boolean().optional(),
  })
  .strict() // unknown compat keys are an error (spec §12)
  .default({});

export const CredentialLabelsSchema = z
  .object({
    model: z.string().min(1).regex(DISPLAY_LABEL_RE),
    provider: z.string().regex(LABEL_VALUE_RE),
    quantization: z
      .string()
      .regex(LABEL_VALUE_RE)
      .refine(
        (value) => !['unknown', 'unverified'].includes(value.toLowerCase()),
      ),
    preset_version_id: z.string().uuid(),
    catalog_as_of: z.string().date(),
  })
  .strict();
export type CredentialLabels = z.infer<typeof CredentialLabelsSchema>;

export const CredentialSchema = z
  .object({
    model: z.string().min(1),
    harnesses: z.array(z.string().min(1)).min(1),
    api: z.enum(CREDENTIAL_APIS).default('openai-chat'),
    base_url: BaseUrlSchema.optional(),
    auth: z.enum(CREDENTIAL_AUTHS).default('api-key'),
    api_key_env: z.string().regex(API_KEY_ENV_RE).optional(),
    // Explicit pi provider name for the OAuth path (e.g. 'openai-codex'). When set,
    // it overrides the host pi settings.json defaultProvider so eval runs use a
    // reproducible provider instead of inheriting a mutable host setting.
    provider: z.string().min(1).optional(),
    compat: CompatSchema,
    max_concurrency: z.number().int().min(1).optional(),
    launch_spacing_seconds: z.number().min(0).optional(),
    os_support: z.array(z.string()).optional(),
    // AWS region for a Bedrock/Mantle credential (api: 'mantle'). Required for
    // mantle by quorum check; it must be declared here to survive strict parsing.
    region: z.string().min(1).optional(),
    labels: CredentialLabelsSchema.optional(),
  })
  .strict();
export type Credential = z.infer<typeof CredentialSchema>;

const NAME_RE = /^[a-z0-9_]+$/;
const RESERVED_CREDENTIAL_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function parseCredentialsFile(raw: unknown): Record<string, Credential> {
  if (raw !== null && typeof raw === 'object') {
    for (const name of Object.getOwnPropertyNames(raw)) {
      if (RESERVED_CREDENTIAL_NAMES.has(name)) {
        throw new Error(`credential name is reserved: ${name}`);
      }
    }
  }
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
