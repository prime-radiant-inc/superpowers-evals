/**
 * Unit tests for the OpenClaw ATIF normalizer.
 *
 * Ported from Harbor's tests/unit/agents/installed/test_openclaw.py
 * (lines 48 and 235), covering both the envelope layout and the
 * JSONL session layout.
 *
 * Conventions tested:
 *   - validateTrajectory passes
 *   - ATIF_SCHEMA_VERSION and agent.name/version
 *   - Tool-name canonicalization via OPENCLAW_TOOL_MAP
 *   - Disjoint-bucket conservation (prompt + cached + completion + cache_write)
 *   - Content fidelity: message, reasoning_content, observation
 *   - Per-step metrics only (no final_metrics) — single-source rule
 */

import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import {
  normalizeOpenclaw,
  normalizeOpenclawJsonl,
} from '../src/normalize/openclaw.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumStepTokens(
  steps: {
    metrics?:
      | {
          prompt_tokens?: number;
          cached_tokens?: number;
          completion_tokens?: number;
          extra?: Record<string, unknown>;
        }
      | undefined;
    extra?: Record<string, unknown>;
  }[],
): {
  prompt: number;
  cached: number;
  completion: number;
  cacheWrite: number;
} {
  let prompt = 0;
  let cached = 0;
  let completion = 0;
  let cacheWrite = 0;
  for (const step of steps) {
    const m = step.metrics;
    if (!m) continue;
    prompt += m.prompt_tokens ?? 0;
    cached += m.cached_tokens ?? 0;
    completion += m.completion_tokens ?? 0;
    cacheWrite += Number((m.extra?.['cache_write'] as number | undefined) ?? 0);
  }
  return { prompt, cached, completion, cacheWrite };
}

// ---------------------------------------------------------------------------
// Envelope layout tests (ported from test_convert_envelope_basic)
// ---------------------------------------------------------------------------

test('envelope: basic text + reasoning + session_id + per-step metrics', () => {
  // Mirrors test_convert_envelope_basic from test_openclaw.py (around line 48)
  const envelope = {
    payloads: [
      { text: 'hello', isReasoning: false },
      { text: 'think', isReasoning: true },
    ],
    meta: {
      agentMeta: {
        sessionId: 'sess-abc',
        usage: { input: 10, output: 5, cacheRead: 2 },
      },
    },
  };
  const raw = JSON.stringify(envelope);
  const traj = normalizeOpenclaw(raw, '1.0.0');

  expect(validateTrajectory(traj).errors).toEqual([]);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.agent.name).toBe('openclaw');
  expect(traj.agent.version).toBe('1.0.0');
  expect(traj.session_id).toBe('sess-abc');
  expect(traj.steps).toHaveLength(2);

  const userStep = traj.steps[0];
  expect(userStep?.source).toBe('user');

  const agentStep = traj.steps[1];
  expect(agentStep?.source).toBe('agent');
  expect(agentStep?.message).toBe('hello');
  expect(agentStep?.reasoning_content).toBe('think');

  // Per-step metrics (disjoint buckets)
  // Harbor (inclusive): prompt = input + cacheRead = 12; ours: prompt = input = 10
  expect(agentStep?.metrics?.prompt_tokens).toBe(10);
  expect(agentStep?.metrics?.completion_tokens).toBe(5);
  expect(agentStep?.metrics?.cached_tokens).toBe(2);

  // Single-source rule: no final_metrics token totals
  expect(traj.final_metrics).toBeUndefined();
});

test('envelope: prefix noise (trailing-JSON envelope parser)', () => {
  // Mirrors test_load_json_object_trailing_noise + test_load_json_object_stale_brace_before_envelope
  const noise =
    '[tools] raw_params={"path": "/x"}\n' +
    JSON.stringify({
      payloads: [{ text: 'ok', isReasoning: false }],
      meta: { agentMeta: { sessionId: 's', usage: {} } },
    }) +
    '\n';
  const traj = normalizeOpenclaw(noise, '0.1.0');
  expect(validateTrajectory(traj).errors).toEqual([]);
  expect(traj.session_id).toBe('s');
  expect(traj.steps[1]?.message).toBe('ok');
});

test('envelope: schema_version is ATIF_SCHEMA_VERSION constant', () => {
  const raw = JSON.stringify({
    payloads: [],
    meta: { agentMeta: { sessionId: 's1', usage: {} } },
  });
  const traj = normalizeOpenclaw(raw, '0.0.1');
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
});

test('envelope: no final_metrics (single-source rule)', () => {
  const raw = JSON.stringify({
    payloads: [{ text: 'hi', isReasoning: false }],
    meta: {
      agentMeta: {
        sessionId: 'x',
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      },
    },
  });
  const traj = normalizeOpenclaw(raw, '1.0.0');
  expect(traj.final_metrics).toBeUndefined();
});

test('envelope: disjoint-bucket conservation', () => {
  // input=10, cacheRead=2, cacheWrite=3, output=5
  // Disjoint: prompt=10, cached=2, cache_write=3, completion=5 → total=20
  // Harbor inclusive: prompt=10+2=12 (NOT our convention)
  const raw = JSON.stringify({
    payloads: [{ text: 'hello', isReasoning: false }],
    meta: {
      agentMeta: {
        sessionId: 'q',
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 },
      },
    },
  });
  const traj = normalizeOpenclaw(raw, '1.0.0');
  const { prompt, cached, completion, cacheWrite } = sumStepTokens(traj.steps);
  expect(prompt).toBe(10); // uncached input only
  expect(cached).toBe(2);
  expect(completion).toBe(5);
  expect(cacheWrite).toBe(3);
  // Sum = uncached + cached + completion + cacheWrite = 10+2+5+3 = 20
  expect(prompt + cached + completion + cacheWrite).toBe(20);
});

test('envelope: tool call canonicalization', () => {
  // "exec" → "Bash", "read_file" → "Read"
  const raw = JSON.stringify({
    payloads: [],
    meta: {
      agentMeta: { sessionId: 's', usage: {} },
      pendingToolCalls: [
        {
          id: 'c1',
          name: 'exec',
          arguments: JSON.stringify({ command: 'ls' }),
        },
        {
          id: 'c2',
          name: 'read_file',
          arguments: JSON.stringify({ path: '/etc' }),
        },
      ],
    },
  });
  const traj = normalizeOpenclaw(raw, '1.0.0');
  expect(validateTrajectory(traj).errors).toEqual([]);
  const toolNames = traj.steps[1]?.tool_calls?.map((tc) => tc.function_name);
  expect(toolNames).toEqual(['Bash', 'Read']);
});

test('envelope: unknown tool names pass through', () => {
  const raw = JSON.stringify({
    payloads: [],
    meta: {
      agentMeta: { sessionId: 's', usage: {} },
      pendingToolCalls: [{ id: 'c1', name: 'my_custom_tool', arguments: '{}' }],
    },
  });
  const traj = normalizeOpenclaw(raw, '1.0.0');
  expect(traj.steps[1]?.tool_calls?.[0]?.function_name).toBe('my_custom_tool');
});

test('envelope: finalAssistantVisibleText fallback when payloads empty', () => {
  const raw = JSON.stringify({
    payloads: [],
    meta: {
      finalAssistantVisibleText: 'fallback text',
      agentMeta: { sessionId: 's', usage: {} },
    },
  });
  const traj = normalizeOpenclaw(raw, '1.0.0');
  expect(traj.steps[1]?.message).toBe('fallback text');
});

test('envelope: empty usage produces no metrics', () => {
  const raw = JSON.stringify({
    payloads: [{ text: 'hi', isReasoning: false }],
    meta: { agentMeta: { sessionId: 's', usage: {} } },
  });
  const traj = normalizeOpenclaw(raw, '1.0.0');
  expect(traj.steps[1]?.metrics).toBeUndefined();
});

// ---------------------------------------------------------------------------
// JSONL layout tests (ported from test_openclaw_session_jsonl_to_atif_steps_minimal)
// ---------------------------------------------------------------------------

function makeJsonlRaw(lines: object[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

const minimalJsonl = makeJsonlRaw([
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    },
  },
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello ' },
        {
          type: 'toolCall',
          id: 'c1',
          name: 'exec',
          arguments: { command: 'x' },
        },
      ],
      usage: { input: 1, output: 2, cacheRead: 0 },
    },
  },
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'exec',
      content: [{ type: 'text', text: 'out' }],
      details: { aggregated: 'out' },
    },
  },
  {
    type: 'message',
    timestamp: '2026-01-01T00:00:03Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      usage: { input: 3, output: 4, cacheRead: 0 },
    },
  },
]);

test('jsonl: basic multi-turn steps (mirrors test_openclaw_session_jsonl_to_atif_steps_minimal)', () => {
  const traj = normalizeOpenclaw(minimalJsonl, '1.0.0');
  expect(validateTrajectory(traj).errors).toEqual([]);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.agent.name).toBe('openclaw');
  // 3 steps: user, assistant+toolCall, assistant
  expect(traj.steps).toHaveLength(3);
  expect(traj.steps[0]?.source).toBe('user');
  expect(traj.steps[0]?.message).toBe('hi');
  expect(traj.steps[1]?.source).toBe('agent');
  expect(traj.steps[1]?.tool_calls).toBeDefined();
  expect(traj.steps[1]?.observation).toBeDefined();
  expect(traj.steps[2]?.source).toBe('agent');
  expect(traj.steps[2]?.message).toBe('done');
});

test('jsonl: tool-name canonicalization (exec → Bash)', () => {
  const traj = normalizeOpenclaw(minimalJsonl, '1.0.0');
  const toolName = traj.steps[1]?.tool_calls?.[0]?.function_name;
  expect(toolName).toBe('Bash');
});

test('jsonl: observation links source_call_id to tool call', () => {
  const traj = normalizeOpenclaw(minimalJsonl, '1.0.0');
  expect(validateTrajectory(traj).errors).toEqual([]); // source_call_id validated
  const obs = traj.steps[1]?.observation;
  expect(obs?.results[0]?.source_call_id).toBe('c1');
  expect(obs?.results[0]?.content).toBe('out');
});

test('jsonl: disjoint-bucket conservation across turns', () => {
  // Turn 1: input=1, output=2, cacheRead=0
  // Turn 2: input=3, output=4, cacheRead=0
  // Total uncached prompt = 1+3=4, completion = 2+4=6
  const traj = normalizeOpenclaw(minimalJsonl, '1.0.0');
  const { prompt, cached, completion, cacheWrite } = sumStepTokens(traj.steps);
  expect(prompt).toBe(4);
  expect(cached).toBe(0);
  expect(completion).toBe(6);
  expect(cacheWrite).toBe(0);
  // No final_metrics: single-source rule
  expect(traj.final_metrics).toBeUndefined();
});

test('jsonl: no final_metrics (single-source rule)', () => {
  const traj = normalizeOpenclaw(minimalJsonl, '1.0.0');
  expect(traj.final_metrics).toBeUndefined();
});

test('jsonl: instruction overrides first user message', () => {
  const envelope = JSON.stringify({
    payloads: [{ text: 'summary' }],
    meta: { agentMeta: { sessionId: 's1', usage: { input: 9, output: 9 } } },
  });
  const traj = normalizeOpenclawJsonl(
    minimalJsonl,
    envelope,
    'task from instruction',
    'anthropic/claude-sonnet-4-20250514',
    '1.0.0',
  );
  expect(validateTrajectory(traj).errors).toEqual([]);
  expect(traj.steps[0]?.message).toBe('task from instruction');
});

test('jsonl: session_id pulled from envelope agentMeta', () => {
  const envelope = JSON.stringify({
    payloads: [],
    meta: { agentMeta: { sessionId: 'sess-from-envelope', usage: {} } },
  });
  const traj = normalizeOpenclawJsonl(
    minimalJsonl,
    envelope,
    'instr',
    'openai/gpt-4.1',
    '2.0.0',
  );
  expect(traj.session_id).toBe('sess-from-envelope');
  expect(traj.agent.model_name).toBe('openai/gpt-4.1');
});

test('jsonl: timestamps preserved on steps', () => {
  const traj = normalizeOpenclaw(minimalJsonl, '1.0.0');
  expect(traj.steps[0]?.timestamp).toBe('2026-01-01T00:00:00Z');
  expect(traj.steps[1]?.timestamp).toBe('2026-01-01T00:00:01Z');
});

test('jsonl: cacheWrite goes to step.metrics.extra.cache_write', () => {
  const withCacheWrite = makeJsonlRaw([
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 7 },
      },
    },
  ]);
  const traj = normalizeOpenclaw(withCacheWrite, '1.0.0');
  expect(validateTrajectory(traj).errors).toEqual([]);
  const m = traj.steps[1]?.metrics;
  expect(m?.prompt_tokens).toBe(10);
  expect(m?.cached_tokens).toBe(3);
  expect(m?.completion_tokens).toBe(5);
  expect(m?.extra?.['cache_write']).toBe(7);
});

test('jsonl: fewer than 2 usable steps falls back to envelope', () => {
  // Only one "message" line → parseJsonlSteps returns undefined → envelope fallback
  const singleLine = JSON.stringify({
    type: 'message',
    message: { role: 'user', content: [] },
  });
  const envelope = JSON.stringify({
    payloads: [{ text: 'envelope answer', isReasoning: false }],
    meta: {
      agentMeta: { sessionId: 'env-sid', usage: { input: 5, output: 3 } },
    },
  });
  const traj = normalizeOpenclawJsonl(
    singleLine,
    envelope,
    'task',
    'openai/gpt-4.1',
    '1.0.0',
  );
  expect(validateTrajectory(traj).errors).toEqual([]);
  // Falls back to 2-step envelope trajectory
  expect(traj.steps).toHaveLength(2);
  expect(traj.steps[1]?.message).toBe('envelope answer');
  expect(traj.session_id).toBe('env-sid');
});

test('jsonl: toolCall with object arguments (not JSON string)', () => {
  const raw = makeJsonlRaw([
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'u' }] },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc1',
            name: 'bash',
            arguments: { command: 'echo hi' },
          },
        ],
        usage: { input: 2, output: 1, cacheRead: 0 },
      },
    },
  ]);
  const traj = normalizeOpenclaw(raw, '1.0.0');
  expect(validateTrajectory(traj).errors).toEqual([]);
  const tc = traj.steps[1]?.tool_calls?.[0];
  expect(tc?.function_name).toBe('Bash');
  expect(tc?.arguments?.['command']).toBe('echo hi');
});

test('jsonl: toolResult content from details.aggregated preferred', () => {
  const raw = makeJsonlRaw([
    {
      type: 'message',
      message: { role: 'user', content: [] },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c2', name: 'exec', arguments: {} }],
        usage: { input: 1, output: 1, cacheRead: 0 },
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'c2',
        content: [{ type: 'text', text: 'content-text' }],
        details: { aggregated: 'aggregated-text' },
      },
    },
  ]);
  const traj = normalizeOpenclaw(raw, '1.0.0');
  // details.aggregated wins over content text
  expect(traj.steps[1]?.observation?.results[0]?.content).toBe(
    'aggregated-text',
  );
});

// ---------------------------------------------------------------------------
// normalizeOpenclawJsonl: populate_context_optional_session_jsonl parity
// Mirrors test_populate_context_optional_session_jsonl (line 309 in test_openclaw.py)
// ---------------------------------------------------------------------------

test('normalizeOpenclawJsonl: prefers jsonl steps over envelope summary', () => {
  const session = makeJsonlRaw([
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'u' }] },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        usage: { input: 1, output: 1, cacheRead: 0 },
      },
    },
  ]);
  const envelopeRaw = JSON.stringify({
    payloads: [{ text: 'summary' }],
    meta: { agentMeta: { sessionId: 's1', usage: { input: 9, output: 9 } } },
  });
  const traj = normalizeOpenclawJsonl(
    session,
    envelopeRaw,
    'instr',
    'openai/gpt-4.1',
    '1.0.0',
  );
  expect(validateTrajectory(traj).errors).toEqual([]);
  // 2 steps from JSONL, not the 2-step envelope summary
  expect(traj.steps).toHaveLength(2);
  expect(traj.steps[1]?.message).toBe('a');
  // session_id from envelope
  expect(traj.session_id).toBe('s1');
  // instruction replaces first user message
  expect(traj.steps[0]?.message).toBe('instr');
});
