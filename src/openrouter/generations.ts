import { z } from 'zod';
import type { AtifTrajectory } from '../atif/types.ts';
import type { CredentialLabels } from '../contracts/credential.ts';

const OPENROUTER_GENERATION_URL = 'https://openrouter.ai/api/v1/generation';

const OpenRouterGenerationFieldsSchema = z
  .object({
    id: z.string().startsWith('gen-'),
    model: z.string().min(1),
    provider_name: z.string().min(1),
    preset_id: z.string().nullable(),
    is_byok: z.boolean(),
    latency: z.number().nullable(),
    generation_time: z.number().nullable(),
    native_tokens_prompt: z.number().nullable(),
    native_tokens_completion: z.number().nullable(),
    native_tokens_reasoning: z.number().nullable(),
    native_tokens_cached: z.number().nullable(),
    total_cost: z.number().nullable(),
    upstream_inference_cost: z.number().nullable(),
  })
  .strict();

const GenerationDataSchema = OpenRouterGenerationFieldsSchema.passthrough();

export const OpenRouterGenerationSchema = z.object({
  data: GenerationDataSchema,
});

// The generation API is forward-compatible, so its response schema preserves
// unknown fields above. The emitted sidecar is not: it is our metadata-only
// artifact and has one complete, stable shape for downstream consumers.
export const OpenRouterAttestationSchema = z
  .object({
    schema_version: z.literal(1),
    expected: z
      .object({
        model: z.string().min(1),
        provider: z.string().min(1),
        preset_version_id: z.string().uuid(),
        is_byok: z.literal(false),
      })
      .strict(),
    generations: z.array(OpenRouterGenerationFieldsSchema),
    charged_cost_usd: z.number().nullable(),
  })
  .strict();

type GenerationData = z.infer<typeof GenerationDataSchema>;

export interface OpenRouterGeneration {
  readonly id: string;
  readonly model: string;
  readonly provider_name: string;
  readonly preset_id: string | null;
  readonly is_byok: boolean;
  readonly latency: number | null;
  readonly generation_time: number | null;
  readonly native_tokens_prompt: number | null;
  readonly native_tokens_completion: number | null;
  readonly native_tokens_reasoning: number | null;
  readonly native_tokens_cached: number | null;
  readonly total_cost: number | null;
  readonly upstream_inference_cost: number | null;
}

export interface OpenRouterAttestation {
  readonly schema_version: 1;
  readonly expected: {
    readonly model: string;
    readonly provider: string;
    readonly preset_version_id: string;
    readonly is_byok: false;
  };
  readonly generations: readonly OpenRouterGeneration[];
  readonly charged_cost_usd: number | null;
}

export interface CaptureOpenRouterGenerationsArgs {
  readonly generationIds: readonly string[];
  readonly apiKey: string;
  readonly labels: CredentialLabels;
  readonly fetchFn: OpenRouterFetch;
}

export type OpenRouterFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export class OpenRouterAttestationError extends Error {
  readonly generationId: string | null;
  readonly status: number | null;

  constructor(
    generationId: string | null,
    status: number | null,
    detail: string,
  ) {
    const id = generationId === null ? 'unknown' : generationId;
    const statusText = status === null ? 'no HTTP status' : `status ${status}`;
    super(
      `OpenRouter generation ${id} attestation failed (${statusText}): ${detail}`,
    );
    this.name = 'OpenRouterAttestationError';
    this.generationId = generationId;
    this.status = status;
  }
}

export function normalizeProviderSlug(provider: string): string {
  return provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function modelMatchesLabel(model: string, label: string): boolean {
  if (model === label) return true;
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedLabel}-\\d{8}$`).test(model);
}

export function openRouterGenerationIds(
  trajectory: AtifTrajectory,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const step of trajectory.steps) {
    if (step.source !== 'agent') continue;
    const responseId = step.extra?.['response_id'];
    if (
      typeof responseId !== 'string' ||
      !responseId.startsWith('gen-') ||
      seen.has(responseId)
    ) {
      continue;
    }
    seen.add(responseId);
    ids.push(responseId);
  }
  return ids;
}

function generationFromData(data: GenerationData): OpenRouterGeneration {
  return {
    id: data.id,
    model: data.model,
    provider_name: data.provider_name,
    preset_id: data.preset_id,
    is_byok: data.is_byok,
    latency: data.latency,
    generation_time: data.generation_time,
    native_tokens_prompt: data.native_tokens_prompt,
    native_tokens_completion: data.native_tokens_completion,
    native_tokens_reasoning: data.native_tokens_reasoning,
    native_tokens_cached: data.native_tokens_cached,
    total_cost: data.total_cost,
    upstream_inference_cost: data.upstream_inference_cost,
  };
}

function validateGenerationIds(generationIds: readonly string[]): void {
  if (generationIds.length === 0) {
    throw new OpenRouterAttestationError(
      null,
      null,
      'no generation ids were available for attestation',
    );
  }

  const seen = new Set<string>();
  for (const generationId of generationIds) {
    if (!generationId.startsWith('gen-')) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'generation id is not an OpenRouter generation id',
      );
    }
    if (seen.has(generationId)) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'duplicate requested generation id',
      );
    }
    seen.add(generationId);
  }
}

async function fetchGeneration(
  generationId: string,
  apiKey: string,
  fetchFn: OpenRouterFetch,
): Promise<GenerationData> {
  let response: Response;
  try {
    response = await fetchFn(
      `${OPENROUTER_GENERATION_URL}?id=${encodeURIComponent(generationId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
  } catch {
    throw new OpenRouterAttestationError(
      generationId,
      null,
      'metadata request failed before a response was received',
    );
  }

  if (!response.ok) {
    throw new OpenRouterAttestationError(
      generationId,
      response.status,
      'metadata request returned a non-success status',
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenRouterAttestationError(
      generationId,
      response.status,
      'metadata response was not valid JSON',
    );
  }

  const parsed = OpenRouterGenerationSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenRouterAttestationError(
      generationId,
      response.status,
      'metadata response did not match the expected schema',
    );
  }
  return parsed.data.data;
}

export async function captureOpenRouterGenerations(
  args: CaptureOpenRouterGenerationsArgs,
): Promise<OpenRouterAttestation> {
  validateGenerationIds(args.generationIds);

  const generations: OpenRouterGeneration[] = [];
  const returnedIds = new Set<string>();
  let chargedCostUsd: number | null = 0;
  const expectedProvider = normalizeProviderSlug(args.labels.provider);

  for (const generationId of args.generationIds) {
    const data = await fetchGeneration(generationId, args.apiKey, args.fetchFn);
    if (returnedIds.has(data.id)) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'duplicate generation metadata response',
      );
    }
    if (data.id !== generationId) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'metadata response did not contain the requested generation',
      );
    }
    if (normalizeProviderSlug(data.provider_name) !== expectedProvider) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'provider did not match the candidate label',
      );
    }
    if (!modelMatchesLabel(data.model, args.labels.model)) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'model did not match the candidate label',
      );
    }
    if (data.is_byok) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'generation unexpectedly used BYOK routing',
      );
    }
    if (data.preset_id !== args.labels.preset_version_id) {
      throw new OpenRouterAttestationError(
        generationId,
        null,
        'preset id did not match the candidate label',
      );
    }

    returnedIds.add(data.id);
    generations.push(generationFromData(data));
    if (data.total_cost === null) {
      chargedCostUsd = null;
    } else if (chargedCostUsd !== null) {
      chargedCostUsd += data.total_cost;
    }
  }

  return {
    schema_version: 1,
    expected: {
      model: args.labels.model,
      provider: args.labels.provider,
      preset_version_id: args.labels.preset_version_id,
      is_byok: false,
    },
    generations,
    charged_cost_usd: chargedCostUsd,
  };
}
