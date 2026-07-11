import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtifTrajectory } from '../src/atif/types.ts';
import type { OpenRouterFetch } from '../src/openrouter/generations.ts';
import {
  captureOpenRouterGenerations,
  modelMatchesLabel,
  normalizeProviderSlug,
  openRouterGenerationIds,
} from '../src/openrouter/generations.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const API_KEY = 'openrouter-key-must-not-persist';
const LABELS = {
  model: 'example/model-a',
  provider: 'example-provider',
  quantization: 'fp8',
  preset_id: '00000000-0000-4000-8000-000000000004',
  preset_version_id: '00000000-0000-4000-8000-000000000005',
  is_byok: false,
  catalog_as_of: '2026-07-10',
} as const;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

function generationResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function trajectory(responseIds: readonly unknown[]): AtifTrajectory {
  return {
    schema_version: 'ATIF-v1.7',
    agent: { name: 'serf', version: 'test' },
    steps: responseIds.map((responseId, index) => ({
      step_id: index + 1,
      source: 'agent',
      extra: { response_id: responseId },
    })),
  };
}

function captureArgs(
  generationIds: readonly string[],
  responses: readonly Response[],
): {
  readonly generationIds: readonly string[];
  readonly apiKey: string;
  readonly labels: typeof LABELS;
  readonly fetchFn: OpenRouterFetch;
} {
  let responseIndex = 0;
  const fetchFn: OpenRouterFetch = async () => {
    const response = responses[responseIndex];
    responseIndex += 1;
    if (response === undefined) throw new Error('unexpected fetch');
    return response;
  };
  return { generationIds, apiKey: API_KEY, labels: LABELS, fetchFn };
}

describe('OpenRouter generation helpers', () => {
  test('collects unique first-seen gen ids from assistant ATIF steps only', () => {
    const withNonAgent: AtifTrajectory = {
      ...trajectory(['gen-first', 'not-a-generation', 'gen-first', 'gen-last']),
      steps: [
        { step_id: 1, source: 'user', extra: { response_id: 'gen-user' } },
        { step_id: 2, source: 'agent', extra: { response_id: 'gen-first' } },
        { step_id: 3, source: 'agent', extra: { response_id: 42 } },
        {
          step_id: 4,
          source: 'agent',
          extra: { response_id: 'not-a-generation' },
        },
        { step_id: 5, source: 'agent', extra: { response_id: 'gen-first' } },
        { step_id: 6, source: 'agent', extra: { response_id: 'gen-last' } },
      ],
    };

    expect(openRouterGenerationIds(withNonAgent)).toEqual([
      'gen-first',
      'gen-last',
    ]);
  });

  test('normalizes provider slugs and only accepts exact or dated model labels', () => {
    expect(normalizeProviderSlug('Example Provider')).toBe('example-provider');
    expect(normalizeProviderSlug('Example.Provider!')).toBe('example-provider');
    expect(modelMatchesLabel('example/model-a', LABELS.model)).toBe(true);
    expect(modelMatchesLabel('example/model-a-20260710', LABELS.model)).toBe(
      true,
    );
    expect(modelMatchesLabel('example/model-a-preview', LABELS.model)).toBe(
      false,
    );
    expect(modelMatchesLabel('example/model-aa', LABELS.model)).toBe(false);
  });
});

describe('captureOpenRouterGenerations', () => {
  test('attests content-free metadata through the generation endpoint only', async () => {
    const generationId = 'gen-valid/1';
    const calls: Array<{
      readonly url: string;
      readonly init: Parameters<OpenRouterFetch>[1] | undefined;
    }> = [];
    const valid = fixture('openrouter-generation-valid.json');
    (valid['data'] as Record<string, unknown>)['id'] = generationId;
    const fetchFn: OpenRouterFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return generationResponse(valid);
    };

    const attestation = await captureOpenRouterGenerations({
      generationIds: [generationId],
      apiKey: API_KEY,
      labels: LABELS,
      fetchFn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen-valid%2F1',
    );
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(attestation).toEqual({
      schema_version: 1,
      expected: {
        model: LABELS.model,
        provider: LABELS.provider,
        preset_id: LABELS.preset_id,
        preset_version_id: LABELS.preset_version_id,
        is_byok: LABELS.is_byok,
      },
      generations: [
        {
          id: generationId,
          model: 'example/model-a',
          provider_name: 'Example Provider',
          preset_id: LABELS.preset_id,
          is_byok: false,
          latency: 125.5,
          generation_time: 2.75,
          native_tokens_prompt: 1200,
          native_tokens_completion: 340,
          native_tokens_reasoning: 56,
          native_tokens_cached: 800,
          total_cost: 0.0125,
          upstream_inference_cost: 0.01,
        },
      ],
      charged_cost_usd: 0.0125,
    });
    const serialized = JSON.stringify(attestation);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('must never persist');
    expect(Object.keys(attestation.generations[0] ?? {})).toEqual([
      'id',
      'model',
      'provider_name',
      'preset_id',
      'is_byok',
      'latency',
      'generation_time',
      'native_tokens_prompt',
      'native_tokens_completion',
      'native_tokens_reasoning',
      'native_tokens_cached',
      'total_cost',
      'upstream_inference_cost',
    ]);
  });

  test('accepts a dated served model and sums every charged generation cost', async () => {
    const attestation = await captureOpenRouterGenerations(
      captureArgs(
        ['gen-valid-1', 'gen-dated-2'],
        [
          generationResponse(fixture('openrouter-generation-valid.json')),
          generationResponse(fixture('openrouter-generation-dated-model.json')),
        ],
      ),
    );

    expect(attestation.generations).toHaveLength(2);
    expect(attestation.charged_cost_usd).toBeCloseTo(0.02);
  });

  test('accepts an explicitly labeled BYOK route', async () => {
    const payload = fixture('openrouter-generation-valid.json');
    const data = payload['data'] as Record<string, unknown>;
    data['preset_id'] = LABELS.preset_id;
    data['is_byok'] = true;

    const attestation = await captureOpenRouterGenerations({
      ...captureArgs(['gen-valid-1'], [generationResponse(payload)]),
      labels: { ...LABELS, is_byok: true },
    });

    expect(attestation.expected.is_byok).toBe(true);
    expect(attestation.generations[0]?.is_byok).toBe(true);
  });

  test('fetches generation metadata sequentially', async () => {
    let active = 0;
    let maximumActive = 0;
    let responseIndex = 0;
    const responses = [
      fixture('openrouter-generation-valid.json'),
      fixture('openrouter-generation-dated-model.json'),
    ];
    const fetchFn: OpenRouterFetch = async (_input, _init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      const response = responses[responseIndex];
      responseIndex += 1;
      if (response === undefined) throw new Error('unexpected fetch');
      return generationResponse(response);
    };

    await captureOpenRouterGenerations({
      generationIds: ['gen-valid-1', 'gen-dated-2'],
      apiKey: API_KEY,
      labels: LABELS,
      fetchFn,
    });
    expect(maximumActive).toBe(1);
  });

  test('sets charged cost to null when any generation omits total_cost', async () => {
    const missingCost = fixture('openrouter-generation-dated-model.json');
    const data = missingCost['data'] as Record<string, unknown>;
    data['total_cost'] = null;

    const attestation = await captureOpenRouterGenerations(
      captureArgs(
        ['gen-valid-1', 'gen-dated-2'],
        [
          generationResponse(fixture('openrouter-generation-valid.json')),
          generationResponse(missingCost),
        ],
      ),
    );

    expect(attestation.charged_cost_usd).toBeNull();
  });

  test.each([
    ['wrong provider', { provider_name: 'Another Provider' }],
    ['wrong model', { model: 'example/model-b' }],
    ['BYOK mismatch', { is_byok: true }],
    ['null preset', { preset_id: null }],
    ['absent preset', { preset_id: undefined }],
  ])('rejects %s metadata', async (_name, overrides) => {
    const payload = fixture('openrouter-generation-valid.json');
    Object.assign(payload['data'] as Record<string, unknown>, overrides);

    await expect(
      captureOpenRouterGenerations(
        captureArgs(['gen-valid-1'], [generationResponse(payload)]),
      ),
    ).rejects.toThrow(/gen-valid-1/i);
  });

  test('rejects duplicate requested ids and missing returned generations', async () => {
    let calls = 0;
    const duplicateFetch: OpenRouterFetch = async () => {
      calls += 1;
      return generationResponse(fixture('openrouter-generation-valid.json'));
    };
    await expect(
      captureOpenRouterGenerations({
        generationIds: ['gen-valid-1', 'gen-valid-1'],
        apiKey: API_KEY,
        labels: LABELS,
        fetchFn: duplicateFetch,
      }),
    ).rejects.toThrow(/gen-valid-1.*duplicate|duplicate.*gen-valid-1/i);
    expect(calls).toBe(0);

    const missing = fixture('openrouter-generation-valid.json');
    (missing['data'] as Record<string, unknown>)['id'] = 'gen-someone-else';
    await expect(
      captureOpenRouterGenerations(
        captureArgs(['gen-valid-1'], [generationResponse(missing)]),
      ),
    ).rejects.toThrow(/gen-valid-1/i);
  });

  test.each([
    401, 404, 429, 500, 503,
  ])('rejects HTTP status %d with the generation id and status', async (status) => {
    await expect(
      captureOpenRouterGenerations(
        captureArgs(
          ['gen-status'],
          [generationResponse({ error: 'nope' }, status)],
        ),
      ),
    ).rejects.toThrow(new RegExp(`gen-status.*${status}`));
  });

  test('rejects malformed JSON and schema drift with the generation id and status', async () => {
    const malformed = new Response('not json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await expect(
      captureOpenRouterGenerations(captureArgs(['gen-malformed'], [malformed])),
    ).rejects.toThrow(/gen-malformed.*200/i);

    await expect(
      captureOpenRouterGenerations(
        captureArgs(
          ['gen-schema'],
          [generationResponse({ data: { id: 'gen-schema' } })],
        ),
      ),
    ).rejects.toThrow(/gen-schema.*200/i);
  });
});
