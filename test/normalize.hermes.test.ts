import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeHermes } from '../src/normalize/hermes.ts';

// ---------------------------------------------------------------------------
// SAMPLE_SESSION fixture — ported from Harbor's test_hermes_cli.py
// TestHermesAtifConversion.SAMPLE_SESSION (around line 149).
// Hermes session export format: single JSON with a `messages` array.
// ---------------------------------------------------------------------------
const SAMPLE_SESSION = JSON.stringify({
  id: 'session-1',
  source: 'cli',
  messages: [
    { role: 'user', content: 'Complete the task.' },
    {
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [
        {
          id: 'tc-1',
          function: {
            name: 'terminal',
            arguments: JSON.stringify({ command: 'ls' }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'tc-1',
      content: 'file1.txt',
    },
    {
      role: 'assistant',
      content: 'Done.',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    },
  ],
});

// ---------------------------------------------------------------------------
// Basic validity + schema version
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
});

test('schema_version is ATIF_SCHEMA_VERSION constant (not a literal)', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  expect(traj.schema_version).toBe('ATIF-v1.7');
});

test('agent name and version', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '2.3.4');
  expect(traj.agent.name).toBe('hermes');
  expect(traj.agent.version).toBe('2.3.4');
});

// ---------------------------------------------------------------------------
// Step sources — ported from Harbor test_step_sources
// ---------------------------------------------------------------------------

test('step sources: user, agent (tool), agent (text)', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const sources = traj.steps.map((s) => s.source);
  // user message, assistant with tool_call (bundled with tool result), assistant text
  expect(sources).toEqual(['user', 'agent', 'agent']);
});

test('sequential step_ids starting from 1', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  for (let i = 0; i < traj.steps.length; i++) {
    expect(traj.steps[i]?.step_id).toBe(i + 1);
  }
});

// ---------------------------------------------------------------------------
// Tool call and observation — ported from Harbor test_tool_call_and_observation
// ---------------------------------------------------------------------------

test('terminal tool call is canonicalized to Bash', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep).toBeDefined();
  expect(toolStep!.tool_calls![0]!.function_name).toBe('Bash');
});

test('tool call arguments are parsed from JSON string', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.arguments).toEqual({ command: 'ls' });
});

test('tool call id is preserved', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.tool_call_id).toBe('tc-1');
});

test('observation is attached to tool-call step with source_call_id', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep).toBeDefined();
  expect(toolStep!.observation).toBeDefined();
  expect(toolStep!.observation!.results).toHaveLength(1);
  expect(toolStep!.observation!.results[0]!.source_call_id).toBe('tc-1');
  expect(toolStep!.observation!.results[0]!.content).toBe('file1.txt');
});

// ---------------------------------------------------------------------------
// Token usage — per-step metrics, NOT final_metrics (SINGLE-SOURCE rule).
// Harbor accumulates to final_metrics; our convention is per-step for per-message logs.
// Ported from Harbor test_token_counts, but reconciled to OUR convention:
//   prompt_tokens: 100 (no cache split in hermes logs → treat as uncached)
//   completion_tokens: 50
// These ride on the step that has the usage, not on final_metrics.
// ---------------------------------------------------------------------------

test('token usage appears on per-step metrics (not final_metrics)', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  // The assistant message with usage is the last "Done." step
  const usageStep = traj.steps.find((s) => s.metrics !== undefined);
  expect(usageStep).toBeDefined();
  expect(usageStep!.metrics!.prompt_tokens).toBe(100);
  expect(usageStep!.metrics!.completion_tokens).toBe(50);
});

test('no final_metrics token totals (single-source: per-step only)', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  // final_metrics must NOT carry token totals to avoid double-counting
  expect(traj.final_metrics?.total_prompt_tokens).toBeUndefined();
  expect(traj.final_metrics?.total_completion_tokens).toBeUndefined();
});

test('disjoint-bucket conservation: per-step sum equals known session total', () => {
  // Session total from SAMPLE_SESSION: prompt=100, completion=50
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  let totalPrompt = 0;
  let totalCompletion = 0;
  for (const step of traj.steps) {
    totalPrompt += step.metrics?.prompt_tokens ?? 0;
    totalCompletion += step.metrics?.completion_tokens ?? 0;
  }
  // Add final_metrics if present (should be 0 for hermes)
  totalPrompt += traj.final_metrics?.total_prompt_tokens ?? 0;
  totalCompletion += traj.final_metrics?.total_completion_tokens ?? 0;
  expect(totalPrompt).toBe(100);
  expect(totalCompletion).toBe(50);
});

test('no cached_tokens emitted (hermes logs carry no cache-split fields)', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  for (const step of traj.steps) {
    expect(step.metrics?.cached_tokens).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Content fidelity
// ---------------------------------------------------------------------------

test('user message text is emitted', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const userStep = traj.steps.find((s) => s.source === 'user');
  expect(userStep).toBeDefined();
  expect(userStep!.message).toBe('Complete the task.');
});

test('assistant message text is emitted', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  // First agent step has tool call, message "Let me check."
  expect(agentSteps[0]?.message).toBe('Let me check.');
  // Second agent step is text-only "Done."
  expect(agentSteps[1]?.message).toBe('Done.');
});

// ---------------------------------------------------------------------------
// Empty input returns minimal valid trajectory
// ---------------------------------------------------------------------------

test('empty input produces a valid trajectory with one placeholder step', () => {
  const traj = normalizeHermes('', '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  expect(traj.steps.length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// JSONL format (one message object per line) — dual-mode handling
// ---------------------------------------------------------------------------

test('handles JSONL format (one message per line)', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: 'Hi!',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ];
  const jsonl = messages.map((m) => JSON.stringify(m)).join('\n');
  const traj = normalizeHermes(jsonl, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const sources = traj.steps.map((s) => s.source);
  expect(sources).toEqual(['user', 'agent']);
});

test('JSONL format: token usage on per-step metrics', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: 'Hi!',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ];
  const jsonl = messages.map((m) => JSON.stringify(m)).join('\n');
  const traj = normalizeHermes(jsonl, '1.0.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.metrics?.prompt_tokens).toBe(10);
  expect(agentStep?.metrics?.completion_tokens).toBe(5);
});

// ---------------------------------------------------------------------------
// Tool map: unknown tool names pass through unchanged
// ---------------------------------------------------------------------------

test('unknown tool names pass through unchanged', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc-x',
            function: {
              name: 'some_unknown_tool',
              arguments: JSON.stringify({ foo: 'bar' }),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tc-x', content: 'ok' },
    ],
  });
  const traj = normalizeHermes(raw, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('some_unknown_tool');
});

// ---------------------------------------------------------------------------
// Tool map: canonical names
// ---------------------------------------------------------------------------

test('tool map: str_replace_based_edit_tool → Edit', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'user', content: 'edit' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc-e',
            function: {
              name: 'str_replace_based_edit_tool',
              arguments: JSON.stringify({ path: 'a.ts' }),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tc-e', content: 'done' },
    ],
  });
  const traj = normalizeHermes(raw, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('Edit');
});

// ---------------------------------------------------------------------------
// Multiple tool calls in one assistant message: all bundled in one step
// ---------------------------------------------------------------------------

test('multiple tool calls in one message are bundled in one step', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'user', content: 'do stuff' },
      {
        role: 'assistant',
        content: 'Running two tools.',
        tool_calls: [
          {
            id: 'tc-a',
            function: {
              name: 'terminal',
              arguments: JSON.stringify({ command: 'ls' }),
            },
          },
          {
            id: 'tc-b',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'f.txt' }),
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tc-a', content: 'file1' },
      { role: 'tool', tool_call_id: 'tc-b', content: 'contents' },
    ],
  });
  const traj = normalizeHermes(raw, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls).toHaveLength(2);
  // Observation should have two results, each linked to the right call
  expect(toolStep!.observation!.results).toHaveLength(2);
  const callIds = toolStep!.observation!.results.map((r) => r.source_call_id);
  expect(callIds).toContain('tc-a');
  expect(callIds).toContain('tc-b');
});

// ---------------------------------------------------------------------------
// List-form content blocks (user or assistant)
// ---------------------------------------------------------------------------

test('list-form content blocks are joined as text', () => {
  const raw = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' world' },
        ],
      },
      { role: 'assistant', content: 'OK' },
    ],
  });
  const traj = normalizeHermes(raw, '1.0.0');
  const userStep = traj.steps.find((s) => s.source === 'user');
  expect(userStep?.message).toBe('Hello world');
});

// ---------------------------------------------------------------------------
// Session id: taken from the single-object `id` field if present
// ---------------------------------------------------------------------------

test('session_id is extracted from top-level id field', () => {
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  expect(traj.session_id).toBe('session-1');
});

// ---------------------------------------------------------------------------
// Arguments that are already an object (not a JSON string) are handled
// ---------------------------------------------------------------------------

test('tool arguments that are already objects (not strings) are handled', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc-obj',
            function: {
              name: 'terminal',
              arguments: { command: 'pwd' }, // already an object, not a string
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tc-obj', content: '/home/user' },
    ],
  });
  const traj = normalizeHermes(raw, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.arguments).toEqual({ command: 'pwd' });
});

// ---------------------------------------------------------------------------
// Session-level token/cost fields (top-level on the session export object,
// e.g. input_tokens/output_tokens/cache_read_tokens/cache_write_tokens/
// reasoning_tokens/actual_cost_usd) fold into trajectory-level final_metrics.
// Real hermes messages carry no per-message `usage` (verified live: session
// messages have token_count: null), so this is the ONLY token/cost source for
// a real capture — but the fold is still gated on "no per-step metrics
// already present" so a hypothetical log carrying both never double-counts
// (mirrors normalize/kimi.ts's turn-vs-session single-source rule).
//
// Field mapping (obol's atif dialect reads these exact final_metrics paths —
// verified against the obol native lib's embedded string table):
//   input_tokens          -> final_metrics.total_prompt_tokens
//   output_tokens +
//     reasoning_tokens     -> final_metrics.total_completion_tokens (folded,
//                             matching normalize/opencode.ts's output+reasoning
//                             fold convention)
//   cache_read_tokens      -> final_metrics.extra.total_cached_tokens (the
//                             literal key obol's atif dialect looks up)
//   cache_write_tokens     -> final_metrics.extra.cache_write (matches the
//                             per-step extra.cache_write key convention)
//   actual_cost_usd        -> final_metrics.total_cost_usd (only when it is a
//                             real number; estimated_cost_usd is never used —
//                             it is an estimate, not a committed charge)
// ---------------------------------------------------------------------------

function sessionWithTopLevelTokens(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'session-tokens',
    input_tokens: 1000,
    output_tokens: 40,
    cache_read_tokens: 500,
    cache_write_tokens: 20,
    reasoning_tokens: 10,
    actual_cost_usd: 0.0042,
    estimated_cost_usd: 0.0099,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'done' },
    ],
    ...overrides,
  });
}

test('session-level token/cost fields fold into final_metrics', () => {
  const traj = normalizeHermes(sessionWithTopLevelTokens(), '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  expect(traj.final_metrics).toEqual({
    total_prompt_tokens: 1000,
    total_completion_tokens: 50, // output_tokens(40) + reasoning_tokens(10) folded
    total_cost_usd: 0.0042,
    extra: {
      total_cached_tokens: 500,
      cache_write: 20,
    },
  });
});

test('estimated_cost_usd is never carried; only actual_cost_usd maps to total_cost_usd', () => {
  const traj = normalizeHermes(
    sessionWithTopLevelTokens({ actual_cost_usd: null }),
    '1.0.0',
  );
  expect(traj.final_metrics?.total_cost_usd).toBeUndefined();
});

test('session-level totals are omitted entirely when no top-level token fields are present', () => {
  // SAMPLE_SESSION (defined above) carries per-message usage only, no
  // top-level input_tokens/output_tokens.
  const traj = normalizeHermes(SAMPLE_SESSION, '1.0.0');
  expect(traj.final_metrics).toBeUndefined();
});

test('per-step metrics win over session-level totals (single-source: no double count)', () => {
  // A hypothetical log carrying BOTH per-message usage AND top-level session
  // totals: per-step metrics must win so obol never double-counts.
  const raw = JSON.stringify({
    id: 'session-both',
    input_tokens: 9999,
    output_tokens: 9999,
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'done',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    ],
  });
  const traj = normalizeHermes(raw, '1.0.0');
  const usageStep = traj.steps.find((s) => s.metrics !== undefined);
  expect(usageStep!.metrics!.prompt_tokens).toBe(100);
  expect(usageStep!.metrics!.completion_tokens).toBe(50);
  expect(traj.final_metrics).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Real captured session (test/fixtures/hermes-real-session.jsonl) — a live
// `hermes sessions export --format jsonl --session-id <id> -` capture from the
// Task 5 container probe. Locks in the verified-live shape: 3 steps
// (user, agent tool-call+observation, agent text), terminal -> Bash, and the
// session-level token totals folding into final_metrics.
// ---------------------------------------------------------------------------

const realSession = readFileSync(
  new URL('./fixtures/hermes-real-session.jsonl', import.meta.url),
  'utf8',
);

test('real captured session produces a valid ATIF trajectory', () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test('real captured session: 3 steps (user, agent tool-call, agent text)', () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  expect(traj.steps.map((s) => s.source)).toEqual(['user', 'agent', 'agent']);
});

test('real captured session: terminal tool call canonicalizes to Bash', () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(toolStep!.tool_calls![0]!.function_name).toBe('Bash');
});

test('real captured session: session-level totals fold into final_metrics', () => {
  const traj = normalizeHermes(realSession, '1.0.0');
  // Real fixture: input_tokens=11780, output_tokens=33, cache_read_tokens=17856,
  // cache_write_tokens=0, reasoning_tokens=18, actual_cost_usd=null (only
  // estimated_cost_usd is set, so total_cost_usd must be absent).
  expect(traj.final_metrics).toEqual({
    total_prompt_tokens: 11780,
    total_completion_tokens: 51, // 33 + 18 reasoning, folded
    extra: {
      total_cached_tokens: 17856,
      cache_write: 0,
    },
  });
});

test('real captured session: no per-step metrics were fabricated from real messages', () => {
  // Real hermes messages carry token_count: null (no per-message `usage`
  // object), so no step should carry metrics — the totals live only on
  // final_metrics.
  const traj = normalizeHermes(realSession, '1.0.0');
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});
