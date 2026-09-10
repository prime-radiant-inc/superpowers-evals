import { expect, spyOn, test } from 'bun:test';
import {
  classifyDiagnosticResponse,
  serializeDiagnosticRequest,
} from '../docs/experiments/2026-09-09-conversation-assessor-reliability/diagnostic.ts';
import { hash } from '../docs/experiments/2026-09-09-conversation-assessor-reliability/reconstruct.ts';
import { getEnv } from '../src/env.ts';

test('does not salvage embedded report syntax', () => {
  const result = classifyDiagnosticResponse({
    sdkContent: [],
    arguments: {
      summary: 'x',
      reasoning: 'x</reasoning><criteria>[]</criteria>',
    },
    criterionCount: 3,
    exposedPaths: new Set(),
    validate: (args) => ({
      ok: Array.isArray((args as { criteria?: unknown }).criteria),
      reason: 'missing native criteria',
    }),
  });
  expect(result.kind).toBe('invalid_report');
});
const report = {
  summary: 'Observed',
  reasoning: 'Evidence',
  criteria: [
    {
      verdict: 'pass',
      observation: 'seen',
      basis: 'direct',
      limitations: 'none',
      references: ['a'],
    },
  ],
};
test('classifier never accepts arguments without a native report or after adapter replacement', () => {
  const classify = (sdkContent: unknown, args: unknown) =>
    classifyDiagnosticResponse({
      sdkContent,
      arguments: args,
      criterionCount: 1,
      exposedPaths: new Set(['a']),
      validate: () => ({ ok: true }),
    });
  expect(classify([], report).kind).toBe('invalid_report');
  expect(
    classify(
      [
        {
          type: 'tool_use',
          name: 'report_result',
          input: { ...report, criteria: [] },
        },
      ],
      report,
    ).kind,
  ).toBe('invalid_report');
});

const gRoot = getEnv('ASSESSMENT_G_ROOT');
test.skipIf(!gRoot)(
  'offline SDK serialization uses its fenced transport even when ambient fetch refuses all requests',
  async () => {
    const body = {
      model: 'anthropic.claude-sonnet-5',
      max_tokens: 16384,
      messages: [{ role: 'user', content: 'synthetic offline prefix' }],
      output_config: { effort: 'medium' },
      thinking: { type: 'adaptive' },
    };
    const ambient = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async () => {
          throw Error('Production network denied');
        },
        {
          preconnect() {
            throw Error('Production network denied');
          },
        },
      ),
    );
    try {
      expect(
        await serializeDiagnosticRequest({
          gRoot: gRoot!,
          reconstruction: {
            schemaVersion: 1,
            label: 'logical-prefix-reconstruction',
            source: {
              qSha: 'a'.repeat(40),
              gSha: 'b'.repeat(40),
              sdkVersion: '0.78.0',
            },
            model: body.model,
            endpoint: 'https://example.invalid',
            body,
            bodySha256: hash(JSON.stringify(body)),
            sourceRefs: [],
          },
        }),
      ).toBe(JSON.stringify(body));
    } finally {
      ambient.mockRestore();
    }
  },
);
