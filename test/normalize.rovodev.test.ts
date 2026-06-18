import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeRovodev } from '../src/normalize/rovodev.ts';

// ---------------------------------------------------------------------------
// Minimal session fixture — one request (user-prompt), one response (agent),
// one tool call + tool-return pair. Usage per response message (per-step).
// Derived from Harbor's test_rovodev_cli.py fixture data.
// ---------------------------------------------------------------------------

function makeSession(overrides: Record<string, unknown> = {}): string {
  const session = {
    id: 'test-session-123',
    message_history: [
      {
        kind: 'request',
        timestamp: '2024-01-01T00:00:00Z',
        parts: [
          {
            part_kind: 'user-prompt',
            content: 'List files in current directory',
            timestamp: '2024-01-01T00:00:01Z',
          },
        ],
      },
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:10Z',
        model_name: 'claude-3-5-sonnet-20241022',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 25,
          cache_write_tokens: 10,
        },
        parts: [
          {
            part_kind: 'tool-call',
            tool_name: 'Shell',
            tool_call_id: 'tc-1',
            args: JSON.stringify({ command: 'ls -la' }),
          },
          {
            part_kind: 'text',
            content: 'I will list the files for you.',
          },
        ],
      },
      {
        kind: 'request',
        timestamp: '2024-01-01T00:00:20Z',
        parts: [
          {
            part_kind: 'tool-return',
            tool_call_id: 'tc-1',
            tool_name: 'Shell',
            content: 'file1.txt\nfile2.txt',
            timestamp: '2024-01-01T00:00:15Z',
          },
        ],
      },
    ],
    usage: {
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 40,
      cache_write_tokens: 15,
    },
    ...overrides,
  };
  return JSON.stringify(session);
}

// ---------------------------------------------------------------------------
// schema_version + agent identity
// ---------------------------------------------------------------------------

test('rovodev: schema_version is ATIF_SCHEMA_VERSION', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
});

test('rovodev: agent name and version', () => {
  const traj = normalizeRovodev(makeSession(), '1.2.3');
  expect(traj.agent.name).toBe('rovodev');
  expect(traj.agent.version).toBe('1.2.3');
});

// ---------------------------------------------------------------------------
// validateTrajectory passes
// ---------------------------------------------------------------------------

test('rovodev: validateTrajectory passes on minimal session', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// session_id
// ---------------------------------------------------------------------------

test('rovodev: session_id from session.id', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  expect(traj.session_id).toBe('test-session-123');
});

// ---------------------------------------------------------------------------
// Tool-name canonicalization
// ---------------------------------------------------------------------------

test('rovodev: Shell → Bash canonical tool name', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  const toolCallStep = agentSteps.find(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  expect(toolCallStep).toBeDefined();
  expect(toolCallStep?.tool_calls?.[0]?.function_name).toBe('Bash');
});

test('rovodev: ReadFile → Read canonical tool name', () => {
  const session = JSON.parse(makeSession()) as {
    message_history: Array<{
      kind: string;
      parts: Array<Record<string, unknown>>;
    }>;
  };
  const responseMsg = session.message_history[1];
  if (responseMsg) {
    responseMsg.parts = [
      {
        part_kind: 'tool-call',
        tool_name: 'ReadFile',
        tool_call_id: 'tc-rf',
        args: JSON.stringify({ path: '/tmp/test.txt' }),
      },
    ];
  }
  const traj = normalizeRovodev(JSON.stringify(session), '1.0.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(step).toBeDefined();
});

test('rovodev: WriteFile → Write canonical tool name', () => {
  const session = JSON.parse(makeSession()) as {
    message_history: Array<{
      kind: string;
      parts: Array<Record<string, unknown>>;
    }>;
  };
  const responseMsg = session.message_history[1];
  if (responseMsg) {
    responseMsg.parts = [
      {
        part_kind: 'tool-call',
        tool_name: 'WriteFile',
        tool_call_id: 'tc-wf',
        args: JSON.stringify({ path: '/tmp/out.txt', content: 'hello' }),
      },
    ];
  }
  const traj = normalizeRovodev(JSON.stringify(session), '1.0.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Write',
  );
  expect(step).toBeDefined();
});

test('rovodev: unknown tool names pass through unchanged', () => {
  const session = JSON.parse(makeSession()) as {
    message_history: Array<{
      kind: string;
      parts: Array<Record<string, unknown>>;
    }>;
  };
  const responseMsg = session.message_history[1];
  if (responseMsg) {
    responseMsg.parts = [
      {
        part_kind: 'tool-call',
        tool_name: 'SomeCustomTool',
        tool_call_id: 'tc-custom',
        args: '{}',
      },
    ];
  }
  const traj = normalizeRovodev(JSON.stringify(session), '1.0.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'SomeCustomTool',
  );
  expect(step).toBeDefined();
});

// ---------------------------------------------------------------------------
// Disjoint-bucket token mapping
// The log carries per-response-message usage:
//   input_tokens: 100 (EXCLUSIVE of cache — already uncached)
//   cache_read_tokens: 25 → cached_tokens
//   cache_write_tokens: 10 → extra.cache_write
//   output_tokens: 50 → completion_tokens
//
// OUR disjoint contract:
//   prompt_tokens = input_tokens (100) — NOT input + cache_read
//   cached_tokens = cache_read_tokens (25)
//   extra.cache_write = cache_write_tokens (10)
//   completion_tokens = output_tokens (50)
//
// Conservation: prompt(100) + cached(25) + cache_write(10) + completion(50) = 185
//   (sum of all token fields in the usage dict = 100 + 25 + 10 + 50 = 185 ✓)
// ---------------------------------------------------------------------------

test('rovodev: disjoint bucket — prompt is input_tokens only (not input+cache_read)', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep).toBeDefined();
  // prompt_tokens must be 100 (input_tokens), NOT 125 (input + cache_read)
  expect(agentStep?.metrics?.prompt_tokens).toBe(100);
});

test('rovodev: disjoint bucket — cached_tokens = cache_read_tokens', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep?.metrics?.cached_tokens).toBe(25);
});

test('rovodev: disjoint bucket — completion_tokens = output_tokens', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep?.metrics?.completion_tokens).toBe(50);
});

test('rovodev: cache_write_tokens > 0 → step.extra.cache_write', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep?.extra?.['cache_write']).toBe(10);
});

test('rovodev: no final_metrics (per-step usage only — single-source invariant)', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  expect(traj.final_metrics).toBeUndefined();
});

test('rovodev: disjoint conservation — per-step sum equals raw token total', () => {
  // Raw usage: input=100 + cache_read=25 + cache_write=10 + output=50 = 185
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  let totalPrompt = 0;
  let totalCached = 0;
  let totalCacheWrite = 0;
  let totalCompletion = 0;
  for (const step of traj.steps) {
    totalPrompt += step.metrics?.prompt_tokens ?? 0;
    totalCached += step.metrics?.cached_tokens ?? 0;
    totalCacheWrite +=
      typeof step.extra?.['cache_write'] === 'number'
        ? (step.extra['cache_write'] as number)
        : 0;
    totalCompletion += step.metrics?.completion_tokens ?? 0;
  }
  expect(totalPrompt + totalCached + totalCacheWrite + totalCompletion).toBe(
    185,
  );
});

// ---------------------------------------------------------------------------
// Content fidelity: message + reasoning_content + observation
// ---------------------------------------------------------------------------

test('rovodev: user message content emitted', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const userStep = traj.steps.find((s) => s.source === 'user');
  expect(userStep).toBeDefined();
  expect(userStep?.message).toBe('List files in current directory');
});

test('rovodev: agent text content emitted as message', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentStep = traj.steps.find(
    (s) =>
      s.source === 'agent' &&
      typeof s.message === 'string' &&
      (s.message as string).length > 0,
  );
  expect(agentStep).toBeDefined();
  expect(agentStep?.message).toBe('I will list the files for you.');
});

test('rovodev: tool observation with source_call_id and content', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const stepWithObs = traj.steps.find(
    (s) =>
      s.source === 'agent' && s.observation && s.observation.results.length > 0,
  );
  expect(stepWithObs).toBeDefined();
  expect(stepWithObs?.observation?.results[0]?.source_call_id).toBe('tc-1');
  expect(stepWithObs?.observation?.results[0]?.content).toBe(
    'file1.txt\nfile2.txt',
  );
});

// ---------------------------------------------------------------------------
// Thinking blocks → reasoning_content
// ---------------------------------------------------------------------------

test('rovodev: thinking blocks emitted as reasoning_content', () => {
  const session = JSON.parse(makeSession()) as {
    message_history: Array<{
      kind: string;
      parts: Array<Record<string, unknown>>;
    }>;
  };
  const responseMsg = session.message_history[1];
  if (responseMsg) {
    responseMsg.parts = [
      {
        part_kind: 'thinking',
        content: 'Let me think about this carefully...',
      },
      {
        part_kind: 'text',
        content: 'Here is my answer.',
      },
    ];
  }
  const traj = normalizeRovodev(JSON.stringify(session), '1.0.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.reasoning_content).toBe(
    'Let me think about this carefully...',
  );
  expect(agentStep?.message).toBe('Here is my answer.');
});

// ---------------------------------------------------------------------------
// model_name from response message
// ---------------------------------------------------------------------------

test('rovodev: model_name extracted from response message', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep?.model_name).toBe('claude-3-5-sonnet-20241022');
});

// ---------------------------------------------------------------------------
// Harbor fixture parity — from test_rovodev_cli.py lines ~209–225
// Harbor _build_rovodev_metrics: prompt_tokens = input + cache_read = 125 (INCLUSIVE)
// OUR contract: prompt_tokens = 100 (input only), cached_tokens = 25 (DISJOINT)
// ---------------------------------------------------------------------------

test('rovodev: Harbor fixture parity — disjoint buckets from Harbor test usage', () => {
  const session = JSON.stringify({
    id: 'harbor-test-session',
    message_history: [
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:00Z',
        model_name: 'claude-3-sonnet',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 25,
          cache_write_tokens: 10,
        },
        parts: [{ part_kind: 'text', content: 'response text' }],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 25,
      cache_write_tokens: 10,
    },
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);

  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep).toBeDefined();
  // OUR disjoint buckets (not Harbor's inclusive prompt=125):
  expect(agentStep?.metrics?.prompt_tokens).toBe(100); // input_tokens only
  expect(agentStep?.metrics?.cached_tokens).toBe(25); // cache_read_tokens
  expect(agentStep?.metrics?.completion_tokens).toBe(50); // output_tokens
  expect(agentStep?.extra?.['cache_write']).toBe(10); // cache_write_tokens
  // NO final_metrics (single-source: per-step only)
  expect(traj.final_metrics).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Harbor fixture parity — from test_rovodev_cli.py lines ~226–245
// Harbor _build_final_metrics: total_prompt = 500+100=600 (inclusive).
// OUR normalizer: no final_metrics (single-source invariant), per-step only.
// ---------------------------------------------------------------------------

test('rovodev: Harbor _build_final_metrics fixture — we emit per-step only, no final_metrics', () => {
  const session = JSON.stringify({
    id: 'final-metrics-test',
    message_history: [
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:00Z',
        model_name: 'claude-3-sonnet',
        usage: {
          input_tokens: 500,
          output_tokens: 200,
          cache_read_tokens: 100,
          cache_write_tokens: 50,
        },
        parts: [{ part_kind: 'text', content: 'answer' }],
      },
    ],
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_read_tokens: 100,
      cache_write_tokens: 50,
    },
  });
  const traj = normalizeRovodev(session, '1.0.0');
  // No final_metrics — per-step is the single source
  expect(traj.final_metrics).toBeUndefined();
  // Per-step disjoint bucket check
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep?.metrics?.prompt_tokens).toBe(500);
  expect(agentStep?.metrics?.cached_tokens).toBe(100);
  expect(agentStep?.metrics?.completion_tokens).toBe(200);
  expect(agentStep?.extra?.['cache_write']).toBe(50);
});

// ---------------------------------------------------------------------------
// Tool call with JSON args (Harbor test_create_tool_call_with_valid_json)
// ---------------------------------------------------------------------------

test('rovodev: tool call JSON args parsed correctly', () => {
  const session = JSON.stringify({
    id: 'tool-args-test',
    message_history: [
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:00Z',
        parts: [
          {
            part_kind: 'tool-call',
            tool_name: 'Shell',
            tool_call_id: 'tc-1',
            args: JSON.stringify({ command: 'ls -la' }),
          },
        ],
      },
    ],
    usage: {},
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  const step = traj.steps.find((s) => s.tool_calls && s.tool_calls.length > 0);
  expect(step?.tool_calls?.[0]?.function_name).toBe('Bash');
  expect(step?.tool_calls?.[0]?.arguments).toEqual({ command: 'ls -la' });
});

// ---------------------------------------------------------------------------
// Tool call with invalid JSON args falls back gracefully
// (Harbor test_create_tool_call_with_invalid_json)
// ---------------------------------------------------------------------------

test('rovodev: invalid JSON tool args — raw_args fallback', () => {
  const session = JSON.stringify({
    id: 'invalid-args-test',
    message_history: [
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:00Z',
        parts: [
          {
            part_kind: 'tool-call',
            tool_name: 'ReadFile',
            tool_call_id: 'tc-bad',
            args: 'not valid json {',
          },
        ],
      },
    ],
    usage: {},
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  const step = traj.steps.find((s) => s.tool_calls && s.tool_calls.length > 0);
  expect(step?.tool_calls?.[0]?.arguments).toHaveProperty('raw_args');
});

// ---------------------------------------------------------------------------
// Empty / missing usage → no metrics emitted
// ---------------------------------------------------------------------------

test('rovodev: missing usage in response → no metrics on that step', () => {
  const session = JSON.stringify({
    id: 'no-usage-test',
    message_history: [
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:00Z',
        parts: [{ part_kind: 'text', content: 'hello' }],
        // no usage field
      },
    ],
    usage: {},
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.metrics).toBeUndefined();
});

// ---------------------------------------------------------------------------
// System prompt → system step (only on first request message)
// ---------------------------------------------------------------------------

test('rovodev: system-prompt part → system step', () => {
  const session = JSON.stringify({
    id: 'sys-prompt-test',
    message_history: [
      {
        kind: 'request',
        timestamp: '2024-01-01T00:00:00Z',
        parts: [
          {
            part_kind: 'system-prompt',
            content: 'You are a helpful assistant.',
            timestamp: '2024-01-01T00:00:00Z',
          },
          {
            part_kind: 'user-prompt',
            content: 'Hello',
            timestamp: '2024-01-01T00:00:01Z',
          },
        ],
      },
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:10Z',
        parts: [{ part_kind: 'text', content: 'Hi there!' }],
      },
    ],
    usage: {},
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  const sysStep = traj.steps.find((s) => s.source === 'system');
  expect(sysStep).toBeDefined();
  expect(sysStep?.message).toBe('You are a helpful assistant.');
});

// ---------------------------------------------------------------------------
// Empty session → single minimal step (no crash)
// ---------------------------------------------------------------------------

test('rovodev: empty message_history → valid trajectory with at least one step', () => {
  const session = JSON.stringify({
    id: 'empty-session',
    message_history: [],
    usage: {},
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  expect(traj.steps.length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// No cost_usd — rovodev does not carry cost in logs
// ---------------------------------------------------------------------------

test('rovodev: no cost_usd on metrics (not fabricated)', () => {
  const traj = normalizeRovodev(makeSession(), '1.0.0');
  for (const step of traj.steps) {
    expect(step.metrics?.cost_usd).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// cache_write = 0 → no step.extra.cache_write emitted
// ---------------------------------------------------------------------------

test('rovodev: cache_write_tokens = 0 → no extra.cache_write on step', () => {
  const session = JSON.stringify({
    id: 'no-cache-write-test',
    message_history: [
      {
        kind: 'response',
        timestamp: '2024-01-01T00:00:00Z',
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_read_tokens: 5,
          cache_write_tokens: 0,
        },
        parts: [{ part_kind: 'text', content: 'answer' }],
      },
    ],
    usage: {},
  });
  const traj = normalizeRovodev(session, '1.0.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.metrics !== undefined,
  );
  expect(agentStep?.extra?.['cache_write']).toBeUndefined();
});
