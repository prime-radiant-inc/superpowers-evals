import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeMimo } from '../src/normalize/mimo.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvents(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A minimal mimo JSONL log: one step_start → text → tool_use → step_finish.
// Mirrors mimo.py _convert_events_to_trajectory grouping.
const stepStartEvent = {
  type: 'step_start',
  sessionID: 'mimo-ses-001',
  timestamp: 1750000000000,
};

const textPartEvent = {
  type: 'text',
  part: { type: 'text', text: 'I will read the file.' },
};

const toolUseEvent = {
  type: 'tool_use',
  part: {
    type: 'tool',
    tool: 'read',
    callID: 'call-read-1',
    state: {
      input: { file_path: 'README.md' },
      output: '# My Project\nA sample project.',
    },
  },
};

const reasoningPartEvent = {
  type: 'reasoning',
  part: { type: 'reasoning', text: 'I need to check the README first.' },
};

// step_finish with full token fields + cost
const stepFinishEvent = {
  type: 'step_finish',
  part: {
    tokens: {
      input: 200,
      output: 50,
      reasoning: 10,
      cache: { read: 100, write: 20 },
    },
    cost: 0.005,
  },
};

const basicLog = makeEvents([
  stepStartEvent,
  textPartEvent,
  toolUseEvent,
  stepFinishEvent,
]);

// Two-step log: step1 has a tool call, step2 is text-only (final answer).
const twoStepLog = makeEvents([
  stepStartEvent,
  toolUseEvent,
  {
    type: 'step_finish',
    part: {
      tokens: {
        input: 300,
        output: 80,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0.003,
    },
  },
  { type: 'step_start', sessionID: 'mimo-ses-001', timestamp: 1750000001000 },
  { type: 'text', part: { type: 'text', text: 'Here is the summary.' } },
  {
    type: 'step_finish',
    part: {
      tokens: {
        input: 120,
        output: 30,
        reasoning: 0,
        cache: { read: 50, write: 0 },
      },
      cost: 0.001,
    },
  },
]);

// Log with explicit reasoning block.
const reasoningLog = makeEvents([
  stepStartEvent,
  reasoningPartEvent,
  textPartEvent,
  toolUseEvent,
  stepFinishEvent,
]);

// Log with an unknown tool name (should pass through).
const unknownToolLog = makeEvents([
  stepStartEvent,
  {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'my_custom_tool',
      callID: 'call-custom-1',
      state: { input: { arg: 'val' }, output: 'result' },
    },
  },
  {
    type: 'step_finish',
    part: {
      tokens: {
        input: 50,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  },
]);

// Log where tool input is a non-dict (string).
const nonDictInputLog = makeEvents([
  stepStartEvent,
  {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'call-bash-1',
      state: { input: 'echo hello', output: 'hello\n' },
    },
  },
  {
    type: 'step_finish',
    part: {
      tokens: {
        input: 40,
        output: 8,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  },
]);

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.agent.name).toBe('mimo');
  expect(traj.agent.version).toBe('0.1.0');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeMimo(twoStepLog, '0.1.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test('empty log yields a valid trajectory with a placeholder user step', () => {
  const traj = normalizeMimo('', '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe('user');
});

test('invalid JSON lines are skipped gracefully', () => {
  const raw =
    'not json\n' +
    JSON.stringify(stepStartEvent) +
    '\n{bad}\n' +
    JSON.stringify(stepFinishEvent);
  const traj = normalizeMimo(raw, '0.1.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Session ID
// ---------------------------------------------------------------------------

test('session_id extracted from first event with sessionID field', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  expect(traj.session_id).toBe('mimo-ses-001');
});

test('session_id absent when no event carries sessionID', () => {
  const noSession = makeEvents([
    { type: 'step_start', timestamp: 1750000000000 },
    toolUseEvent,
    stepFinishEvent,
  ]);
  const traj = normalizeMimo(noSession, '0.1.0');
  expect(traj.session_id).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Tool name canonicalization
// ---------------------------------------------------------------------------

test('tool-name canonicalization: read → Read', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  const names = traj.steps.flatMap((s) =>
    (s.tool_calls ?? []).map((tc) => tc.function_name),
  );
  expect(names).toContain('Read');
});

test('tool-name canonicalization: full canonical sequence across all tool types', () => {
  const allToolsLog = makeEvents([
    stepStartEvent,
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'c1',
        state: { input: { command: 'ls' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'c2',
        state: { input: { file_path: 'f.ts' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'write',
        callID: 'c3',
        state: { input: { file_path: 'out.ts', content: 'x' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'edit',
        callID: 'c4',
        state: { input: { file_path: 'out.ts' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'grep',
        callID: 'c5',
        state: { input: { pattern: 'foo' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'glob',
        callID: 'c6',
        state: { input: { pattern: '*.ts' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'todowrite',
        callID: 'c7',
        state: { input: { todos: [] } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'webfetch',
        callID: 'c8',
        state: { input: { url: 'https://x.com' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'websearch',
        callID: 'c9',
        state: { input: { query: 'bun' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'task',
        callID: 'c10',
        state: { input: { prompt: 'review PR' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'skill',
        callID: 'c11',
        state: { input: { name: 'brainstorming' } },
      },
    },
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  ]);
  const traj = normalizeMimo(allToolsLog, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps.flatMap((s) =>
    (s.tool_calls ?? []).map((tc) => tc.function_name),
  );
  expect(names).toEqual([
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
    'Agent',
    'Skill',
  ]);
});

test('unknown tool names pass through unchanged', () => {
  const traj = normalizeMimo(unknownToolLog, '0.1.0');
  const names = traj.steps.flatMap((s) =>
    (s.tool_calls ?? []).map((tc) => tc.function_name),
  );
  expect(names).toEqual(['my_custom_tool']);
});

// ---------------------------------------------------------------------------
// Token metrics — disjoint buckets
// ---------------------------------------------------------------------------
//
// mimo.py token-extraction logic (lines 248-254):
//   input_tok = tokens.get("input", 0)     ← EXCLUSIVE of cache (Harbor's
//     running total tallies: total_input_tokens += input_tok + cache_read,
//     confirming input_tok is already the uncached portion)
//   output_tok = tokens.get("output", 0)
//   reasoning_tok = tokens.get("reasoning", 0)
//   cache_read = cache.get("read", 0)
//   cache_write = cache.get("write", 0)
//
// Our disjoint mapping:
//   metrics.prompt_tokens     = input_tok              (already uncached)
//   metrics.cached_tokens     = cache.read
//   step.extra.cache_write    = cache.write            (only when > 0)
//   metrics.completion_tokens = output_tok + reasoning_tok  (folded)
//   metrics.cost_usd          = cost                   (only when > 0)
//
// Harbor emits BOTH per-step metrics AND final_metrics totals; we follow the
// SINGLE-SOURCE rule and emit per-step metrics ONLY (no final_metrics).

test('token buckets are DISJOINT: prompt=input, cached=cache.read, completion=output+reasoning', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  // basicLog step_finish: input=200, output=50, reasoning=10, cache.read=100, cache.write=20, cost=0.005
  const step = traj.steps.find((s) => s.metrics !== undefined);
  expect(step).toBeDefined();
  const m = step!.metrics!;
  expect(m.prompt_tokens).toBe(200); // input (exclusive of cache)
  expect(m.cached_tokens).toBe(100); // cache.read
  expect(m.completion_tokens).toBe(60); // output(50) + reasoning(10)
  expect(m.cost_usd).toBe(0.005);
});

test('cache_write rides in step.extra.cache_write when > 0', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  const step = traj.steps.find((s) => s.metrics !== undefined);
  expect(step!.extra?.['cache_write']).toBe(20);
});

test('cache_write absent from extra when zero', () => {
  const traj = normalizeMimo(twoStepLog, '0.1.0');
  // Both steps in twoStepLog have cache.write=0
  for (const step of traj.steps.filter((s) => s.metrics !== undefined)) {
    expect(step.extra?.['cache_write']).toBeUndefined();
  }
});

test('disjoint-bucket conservation: sum across steps equals session total', () => {
  // twoStepLog:
  //   step1: input=300, output=80, reasoning=0, cache.read=0, cache.write=0
  //   step2: input=120, output=30, reasoning=0, cache.read=50, cache.write=0
  // expected totals: prompt=420, cached=50, completion=110, cache_write=0
  const traj = normalizeMimo(twoStepLog, '0.1.0');
  let prompt = 0,
    cached = 0,
    completion = 0,
    cacheWrite = 0;
  for (const step of traj.steps) {
    prompt += step.metrics?.prompt_tokens ?? 0;
    cached += step.metrics?.cached_tokens ?? 0;
    completion += step.metrics?.completion_tokens ?? 0;
    cacheWrite += (step.extra?.['cache_write'] as number) ?? 0;
  }
  expect(prompt).toBe(420);
  expect(cached).toBe(50);
  expect(completion).toBe(110);
  expect(cacheWrite).toBe(0);
});

test('step without token data leaves metrics unset', () => {
  const noTokens = makeEvents([
    stepStartEvent,
    toolUseEvent,
    { type: 'step_finish', part: {} },
  ]);
  const traj = normalizeMimo(noTokens, '0.1.0');
  expect(traj.steps.every((s) => s.metrics === undefined)).toBe(true);
});

test('step with all-zero tokens leaves metrics unset', () => {
  const zeroTokens = makeEvents([
    stepStartEvent,
    toolUseEvent,
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  ]);
  const traj = normalizeMimo(zeroTokens, '0.1.0');
  expect(traj.steps.every((s) => s.metrics === undefined)).toBe(true);
});

test('SINGLE-SOURCE invariant: no final_metrics emitted (per-step only)', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  // Harbor emits both; we emit per-step only to avoid double-counting in obol.
  expect(traj.final_metrics).toBeUndefined();
});

test('cost_usd absent when cost is zero', () => {
  const noCost = makeEvents([
    stepStartEvent,
    toolUseEvent,
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
      },
    },
  ]);
  const traj = normalizeMimo(noCost, '0.1.0');
  const step = traj.steps.find((s) => s.metrics !== undefined);
  expect(step!.metrics!.cost_usd).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Full-fidelity content
// ---------------------------------------------------------------------------

test('message: text parts accumulated and joined into step.message', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  const step = traj.steps.find((s) => s.message !== undefined);
  expect(step).toBeDefined();
  expect(step!.message).toBe('I will read the file.');
});

test('message: multiple text parts joined with newline', () => {
  const multiText = makeEvents([
    stepStartEvent,
    { type: 'text', part: { type: 'text', text: 'First.' } },
    { type: 'text', part: { type: 'text', text: 'Second.' } },
    toolUseEvent,
    stepFinishEvent,
  ]);
  const traj = normalizeMimo(multiText, '0.1.0');
  const step = traj.steps.find((s) => s.message !== undefined);
  expect(step!.message).toBe('First.\nSecond.');
});

test('reasoning_content: single reasoning part', () => {
  const traj = normalizeMimo(reasoningLog, '0.1.0');
  const step = traj.steps.find((s) => s.reasoning_content !== undefined);
  expect(step).toBeDefined();
  expect(step!.reasoning_content).toBe('I need to check the README first.');
});

test('reasoning_content: multiple reasoning parts joined with double newline', () => {
  const multiReason = makeEvents([
    stepStartEvent,
    { type: 'reasoning', part: { type: 'reasoning', text: 'Thought A.' } },
    { type: 'reasoning', part: { type: 'reasoning', text: 'Thought B.' } },
    toolUseEvent,
    stepFinishEvent,
  ]);
  const traj = normalizeMimo(multiReason, '0.1.0');
  const step = traj.steps.find((s) => s.reasoning_content !== undefined);
  expect(step!.reasoning_content).toBe('Thought A.\n\nThought B.');
});

test('observation: tool output → observation.results[0].content + source_call_id', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  const step = traj.steps.find((s) => s.observation !== undefined);
  expect(step).toBeDefined();
  const obs = step!.observation!;
  expect(obs.results).toHaveLength(1);
  expect(obs.results[0]!.content).toBe('# My Project\nA sample project.');
  expect(obs.results[0]!.source_call_id).toBe('call-read-1');
});

test('observation source_call_id matches tool_call_id in same step (ATIF valid)', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

test('observation absent when tool has no output in state', () => {
  const noOutput = makeEvents([
    stepStartEvent,
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call-bash-1',
        state: { input: { command: 'ls' } },
      },
    },
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 50,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  ]);
  const traj = normalizeMimo(noOutput, '0.1.0');
  const step = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(step!.observation).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

test('timestamp: step_start timestamp (epoch ms) converted to ISO-8601', () => {
  const traj = normalizeMimo(basicLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  expect(agentStep!.timestamp).toBe(new Date(1750000000000).toISOString());
});

// ---------------------------------------------------------------------------
// Non-dict tool input handling (mirrors mimo.py lines 225-226)
// ---------------------------------------------------------------------------

test('non-dict tool input is wrapped in {value: ...}', () => {
  const traj = normalizeMimo(nonDictInputLog, '0.1.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(step).toBeDefined();
  const args = step!.tool_calls![0]!.arguments;
  expect(args['value']).toBe('echo hello');
});

// ---------------------------------------------------------------------------
// call_id / fallback to part.id
// ---------------------------------------------------------------------------

test('call_id falls back to part.id when callID absent', () => {
  const noCallId = makeEvents([
    stepStartEvent,
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'read',
        id: 'fallback-id-1',
        state: { input: { file_path: 'x.ts' }, output: 'content' },
      },
    },
    stepFinishEvent,
  ]);
  const traj = normalizeMimo(noCallId, '0.1.0');
  const step = traj.steps.find((s) => s.tool_calls !== undefined);
  expect(step!.tool_calls![0]!.tool_call_id).toBe('fallback-id-1');
  expect(step!.observation!.results[0]!.source_call_id).toBe('fallback-id-1');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// No dedup needed (mimo does not re-emit events by message id)
// ---------------------------------------------------------------------------

test('each step_start..step_finish boundary produces exactly one agent step', () => {
  const threeStepLog = makeEvents([
    // Turn 1
    stepStartEvent,
    toolUseEvent,
    stepFinishEvent,
    // Turn 2
    { type: 'step_start', sessionID: 'mimo-ses-001', timestamp: 1750000001000 },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'c2',
        state: { input: { command: 'ls' } },
      },
    },
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 50,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
    // Turn 3 (text only)
    { type: 'step_start', sessionID: 'mimo-ses-001', timestamp: 1750000002000 },
    { type: 'text', part: { type: 'text', text: 'Done.' } },
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 30,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  ]);
  const traj = normalizeMimo(threeStepLog, '0.1.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(3);
});

// ---------------------------------------------------------------------------
// Error events are not collected as parts (they appear outside step boundaries
// in Harbor's converter design; we simply skip unknown types)
// ---------------------------------------------------------------------------

test('error events produce no extra steps', () => {
  const withError = makeEvents([
    stepStartEvent,
    toolUseEvent,
    { type: 'error', error: { name: 'SomeError', data: { message: 'oops' } } },
    stepFinishEvent,
  ]);
  const traj = normalizeMimo(withError, '0.1.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);
});
