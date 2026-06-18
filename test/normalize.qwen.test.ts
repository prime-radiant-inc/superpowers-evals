import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeQwen } from '../src/normalize/qwen.ts';

// ---------------------------------------------------------------------------
// Helper builders — qwen-code JSONL event format (Gemini-style fork)
// ---------------------------------------------------------------------------

function makeUserEvent(
  text: string,
  opts: { timestamp?: string; sessionId?: string } = {},
): string {
  const ev: Record<string, unknown> = {
    type: 'user',
    message: { parts: [{ text }] },
  };
  if (opts.timestamp) ev['timestamp'] = opts.timestamp;
  if (opts.sessionId) ev['sessionId'] = opts.sessionId;
  return JSON.stringify(ev);
}

function makeAssistantEvent(
  opts: {
    text?: string;
    functionCalls?: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
    usageMetadata?: Record<string, unknown>;
    timestamp?: string;
    model?: string;
    version?: string;
  } = {},
): string {
  const parts: unknown[] = [];
  if (opts.text) parts.push({ text: opts.text });
  for (const fc of opts.functionCalls ?? []) {
    parts.push({ functionCall: { id: fc.id, name: fc.name, args: fc.args } });
  }
  const ev: Record<string, unknown> = {
    type: 'assistant',
    message: { parts },
  };
  if (opts.usageMetadata) ev['usageMetadata'] = opts.usageMetadata;
  if (opts.timestamp) ev['timestamp'] = opts.timestamp;
  if (opts.model) ev['model'] = opts.model;
  if (opts.version) ev['version'] = opts.version;
  return JSON.stringify(ev);
}

function makeToolResultEvent(
  responses: Array<{ id: string; output: string }>,
): string {
  const parts = responses.map((r) => ({
    functionResponse: { id: r.id, response: { output: r.output } },
  }));
  return JSON.stringify({ type: 'tool_result', message: { parts } });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Minimal representative log: user turn, assistant with tool call + text,
// tool result, then a text-only assistant turn (no tool calls).
const BASIC_LOG = [
  JSON.stringify({
    sessionId: 'sess-qwen-1',
    version: '1.2.3',
    model: 'qwen3-coder-plus',
  }),
  makeUserEvent('implement the feature', { sessionId: 'sess-qwen-1' }),
  makeAssistantEvent({
    text: 'I will read the file first.',
    functionCalls: [
      { id: 'call-1', name: 'read_file', args: { file_path: 'src/main.ts' } },
    ],
    usageMetadata: {
      promptTokenCount: 1200,
      candidatesTokenCount: 80,
      cachedContentTokenCount: 200,
      thoughtsTokenCount: 0,
    },
    model: 'qwen3-coder-plus',
    timestamp: '2026-06-17T10:00:00.000Z',
  }),
  makeToolResultEvent([{ id: 'call-1', output: 'file contents here' }]),
  makeAssistantEvent({
    text: 'Done! The feature is implemented.',
    usageMetadata: {
      promptTokenCount: 1400,
      candidatesTokenCount: 30,
      cachedContentTokenCount: 400,
      thoughtsTokenCount: 50,
    },
    model: 'qwen3-coder-plus',
    timestamp: '2026-06-17T10:00:05.000Z',
  }),
].join('\n');

// Multi-tool-name fixture for tool-map coverage
const TOOL_MAP_LOG = [
  makeUserEvent('do tasks'),
  makeAssistantEvent({
    functionCalls: [
      { id: 't1', name: 'run_shell_command', args: { command: 'git status' } },
      { id: 't2', name: 'read_file', args: { file_path: 'README.md' } },
      {
        id: 't3',
        name: 'write_file',
        args: { file_path: 'out.txt', content: 'x' },
      },
      {
        id: 't4',
        name: 'replace',
        args: { file_path: 'out.txt', old_string: 'x', new_string: 'y' },
      },
      { id: 't5', name: 'grep_search', args: { pattern: 'foo', path: '.' } },
      { id: 't6', name: 'glob', args: { pattern: '**/*.ts' } },
      { id: 't7', name: 'list_directory', args: { path: 'src' } },
      { id: 't8', name: 'google_web_search', args: { query: 'bun js' } },
      { id: 't9', name: 'web_fetch', args: { url: 'https://example.com' } },
      { id: 't10', name: 'write_todos', args: { todos: [] } },
      { id: 't11', name: 'invoke_agent', args: { prompt: 'do subtask' } },
      { id: 't12', name: 'custom_unknown_tool', args: { x: 1 } },
    ],
  }),
].join('\n');

// ---------------------------------------------------------------------------
// Tests — schema / agent identity
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent.name).toBe('qwen-code');
  expect(traj.agent.version).toBe('1.2.3');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test('session_id is populated from the log metadata', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  expect(traj.session_id).toBe('sess-qwen-1');
});

test('session_id is absent when not in the log', () => {
  const log = [makeUserEvent('hello'), makeAssistantEvent({ text: 'hi' })].join(
    '\n',
  );
  const traj = normalizeQwen(log, '1.0.0');
  expect(traj.session_id).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Tests — tool-name canonicalization
// ---------------------------------------------------------------------------

test('run_shell_command maps to Bash', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(findTc(traj, 't1')?.function_name).toBe('Bash');
});

// Helper: find a tool call by id across all steps
function findTc(
  traj: ReturnType<typeof normalizeQwen>,
  id: string,
):
  | NonNullable<
      ReturnType<typeof normalizeQwen>['steps'][number]['tool_calls']
    >[number]
  | undefined {
  for (const step of traj.steps) {
    const tc = (step.tool_calls ?? []).find((t) => t.tool_call_id === id);
    if (tc) return tc;
  }
  return undefined;
}

test('read_file maps to Read', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't2')?.function_name).toBe('Read');
});

test('write_file maps to Write', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't3')?.function_name).toBe('Write');
});

test('replace maps to Edit', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't4')?.function_name).toBe('Edit');
});

test('grep_search maps to Grep', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't5')?.function_name).toBe('Grep');
});

test('glob maps to Glob', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't6')?.function_name).toBe('Glob');
});

test('list_directory maps to Glob', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't7')?.function_name).toBe('Glob');
});

test('google_web_search maps to WebSearch', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't8')?.function_name).toBe('WebSearch');
});

test('web_fetch maps to WebFetch', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't9')?.function_name).toBe('WebFetch');
});

test('write_todos maps to TodoWrite', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't10')?.function_name).toBe('TodoWrite');
});

test('invoke_agent maps to Agent', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't11')?.function_name).toBe('Agent');
});

test('unknown tool names pass through verbatim', () => {
  const traj = normalizeQwen(TOOL_MAP_LOG, '1.0.0');
  expect(findTc(traj, 't12')?.function_name).toBe('custom_unknown_tool');
});

// ---------------------------------------------------------------------------
// Tests — token bucket disjoint conservation
// ---------------------------------------------------------------------------

test('disjoint bucket conservation: per-step prompt+cached+completion equals raw Gemini total', () => {
  // Turn 1: promptTokenCount=1200, cachedContentTokenCount=200, candidatesTokenCount=80
  //   → uncached prompt=1000, cached=200, completion=80, total=1280
  // Turn 2: promptTokenCount=1400, cachedContentTokenCount=400, candidatesTokenCount=30, thoughtsTokenCount=50
  //   → uncached prompt=1000, cached=400, completion=80, total=1480
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  expect(validateTrajectory(traj).ok).toBe(true);

  const metricSteps = traj.steps.filter((s) => s.metrics !== undefined);
  expect(metricSteps.length).toBe(2);

  // Turn 1 metrics
  const t1 = metricSteps[0]!;
  expect(t1.metrics!.prompt_tokens).toBe(1200 - 200); // 1000 (uncached)
  expect(t1.metrics!.cached_tokens).toBe(200);
  expect(t1.metrics!.completion_tokens).toBe(80 + 0); // candidatesTokenCount + thoughtsTokenCount

  // Turn 2 metrics
  const t2 = metricSteps[1]!;
  expect(t2.metrics!.prompt_tokens).toBe(1400 - 400); // 1000 (uncached)
  expect(t2.metrics!.cached_tokens).toBe(400);
  expect(t2.metrics!.completion_tokens).toBe(30 + 50); // candidatesTokenCount + thoughtsTokenCount folded
});

test('disjoint bucket conservation: summed buckets match known session total', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const totals = traj.steps.reduce(
    (acc, s) => {
      if (!s.metrics) return acc;
      acc.prompt += s.metrics.prompt_tokens ?? 0;
      acc.cached += s.metrics.cached_tokens ?? 0;
      acc.completion += s.metrics.completion_tokens ?? 0;
      return acc;
    },
    { prompt: 0, cached: 0, completion: 0 },
  );

  // Turn 1: uncached=1000, cached=200, completion=80
  // Turn 2: uncached=1000, cached=400, completion=80
  expect(totals.prompt).toBe(1000 + 1000);
  expect(totals.cached).toBe(200 + 400);
  expect(totals.completion).toBe(80 + 80);
});

test('promptTokenCount inclusive of cached: subtracts cachedContentTokenCount for disjoint prompt', () => {
  const log = [
    makeUserEvent('hi'),
    makeAssistantEvent({
      text: 'hello',
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 100,
        thoughtsTokenCount: 5,
      },
    }),
  ].join('\n');
  const traj = normalizeQwen(log, '1.0.0');
  const step = traj.steps.find((s) => s.metrics !== undefined)!;
  expect(step.metrics!.prompt_tokens).toBe(500 - 100); // 400 uncached
  expect(step.metrics!.cached_tokens).toBe(100);
  expect(step.metrics!.completion_tokens).toBe(20 + 5); // thoughts folded
});

test('no cost_usd emitted (no per-event cost in qwen-code logs)', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  for (const step of traj.steps) {
    expect(step.metrics?.cost_usd).toBeUndefined();
  }
  expect(traj.final_metrics?.total_cost_usd).toBeUndefined();
});

test('no usageMetadata → no metrics emitted', () => {
  const log = [
    makeUserEvent('hi'),
    makeAssistantEvent({
      functionCalls: [
        { id: 'x1', name: 'read_file', args: { file_path: 'a.ts' } },
      ],
    }),
  ].join('\n');
  const traj = normalizeQwen(log, '1.0.0');
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Tests — content fidelity: message, observation, model_name
// ---------------------------------------------------------------------------

test('assistant text surfaces as step.message', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.message === 'I will read the file first.',
  );
  expect(agentStep).toBeDefined();
});

test('user text surfaces as user step.message', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const userStep = traj.steps.find((s) => s.source === 'user');
  expect(userStep).toBeDefined();
  expect(userStep!.message).toBe('implement the feature');
});

test('tool result output surfaces as observation on the assistant step', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const readStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(readStep).toBeDefined();
  expect(readStep!.observation).toBeDefined();
  const result = readStep!.observation!.results[0]!;
  expect(result.content).toBe('file contents here');
  // same-step ATIF invariant: source_call_id must match a tool_call_id in this step
  expect(result.source_call_id).toBe('call-1');
  expect(readStep!.tool_calls![0]!.tool_call_id).toBe('call-1');
});

test('model_name from usageMetadata events propagates to step', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const metricSteps = traj.steps.filter((s) => s.metrics !== undefined);
  for (const step of metricSteps) {
    expect(step.model_name).toBe('qwen3-coder-plus');
  }
});

test('timestamp from event propagates to step', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const step = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls !== undefined,
  );
  expect(step?.timestamp).toBe('2026-06-17T10:00:00.000Z');
});

test('text-only assistant turn (no tool calls) gets a step', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  const doneStep = traj.steps.find(
    (s) =>
      s.source === 'agent' && s.message === 'Done! The feature is implemented.',
  );
  expect(doneStep).toBeDefined();
  expect(doneStep!.tool_calls).toBeUndefined();
});

// qwen-code has no reasoning/thinking blocks in its log format
// (Gemini-cli's thoughts are not present in qwen-code JSONL events).
test('no reasoning_content emitted (qwen-code log carries no thinking blocks)', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  for (const step of traj.steps) {
    expect(step.reasoning_content).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Tests — observation ATIF invariant (source_call_id must match same-step tool_call)
// ---------------------------------------------------------------------------

test('observation source_call_id matches a tool_call in the same step', () => {
  const traj = normalizeQwen(BASIC_LOG, '1.2.3');
  expect(validateTrajectory(traj).ok).toBe(true); // validator enforces this
  for (const step of traj.steps) {
    if (!step.observation) continue;
    const callIds = new Set(
      (step.tool_calls ?? []).map((tc) => tc.tool_call_id),
    );
    for (const result of step.observation.results) {
      if (result.source_call_id != null) {
        expect(callIds.has(result.source_call_id)).toBe(true);
      }
    }
  }
});

test('multiple functionResponses attach to correct assistant steps', () => {
  const log = [
    makeUserEvent('do two things'),
    makeAssistantEvent({
      functionCalls: [
        { id: 'a1', name: 'read_file', args: { file_path: 'a.ts' } },
        { id: 'a2', name: 'run_shell_command', args: { command: 'ls' } },
      ],
    }),
    makeToolResultEvent([
      { id: 'a1', output: 'content of a.ts' },
      { id: 'a2', output: 'file1.ts\nfile2.ts' },
    ]),
  ].join('\n');
  const traj = normalizeQwen(log, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const agentStep = traj.steps.find((s) => s.source === 'agent')!;
  expect(agentStep.observation?.results).toHaveLength(2);
  const resultA1 = agentStep.observation!.results.find(
    (r) => r.source_call_id === 'a1',
  );
  const resultA2 = agentStep.observation!.results.find(
    (r) => r.source_call_id === 'a2',
  );
  expect(resultA1?.content).toBe('content of a.ts');
  expect(resultA2?.content).toBe('file1.ts\nfile2.ts');
});

// ---------------------------------------------------------------------------
// Tests — edge cases
// ---------------------------------------------------------------------------

test('tolerates blank lines and bad JSON', () => {
  const raw = [
    '',
    '{not valid json}',
    makeUserEvent('hi'),
    makeAssistantEvent({
      functionCalls: [
        { id: 'x', name: 'read_file', args: { file_path: 'f.ts' } },
      ],
    }),
    '',
  ].join('\n');
  const traj = normalizeQwen(raw, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls![0]!.function_name).toBe('Read');
});

test('empty log produces a placeholder step (ATIF requires at least one step)', () => {
  const traj = normalizeQwen('', '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps).toHaveLength(1);
  expect(traj.steps[0]!.source).toBe('user');
});

test('user event with empty text is skipped', () => {
  const log = [
    JSON.stringify({
      type: 'user',
      message: { parts: [{ text: '' }] },
    }),
    makeAssistantEvent({ text: 'done' }),
  ].join('\n');
  const traj = normalizeQwen(log, '1.0.0');
  // Empty user part → no user step; only agent step
  const userSteps = traj.steps.filter((s) => s.source === 'user');
  expect(userSteps).toHaveLength(0);
});

test('non-dict functionCall args wrapped as raw_args', () => {
  const log = [
    makeUserEvent('hi'),
    JSON.stringify({
      type: 'assistant',
      message: {
        parts: [
          {
            functionCall: {
              id: 'q1',
              name: 'run_shell_command',
              args: 'git status',
            },
          },
        ],
      },
    }),
  ].join('\n');
  const traj = normalizeQwen(log, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const tc = traj.steps.find((s) => s.tool_calls)?.tool_calls?.[0];
  expect(tc?.function_name).toBe('Bash');
  expect(tc?.arguments).toEqual({ raw_args: 'git status' });
});

test('model metadata from log header is captured on metrics steps', () => {
  const log = [
    JSON.stringify({ model: 'qwen3-coder-480b', version: '2.0.0' }),
    makeUserEvent('hi'),
    makeAssistantEvent({
      text: 'done',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
      },
    }),
  ].join('\n');
  const traj = normalizeQwen(log, '2.0.0');
  const step = traj.steps.find((s) => s.metrics !== undefined)!;
  expect(step.model_name).toBe('qwen3-coder-480b');
});

// ---------------------------------------------------------------------------
// No dedup needed — qwen-code events are not re-emitted with the same id
// (Each event is distinct; no running-snapshot pattern like gemini-cli)
// ---------------------------------------------------------------------------

test('distinct assistant events produce distinct steps (no unexpected dedup)', () => {
  const log = [
    makeUserEvent('start'),
    makeAssistantEvent({
      functionCalls: [
        { id: 'c1', name: 'read_file', args: { file_path: 'a.ts' } },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
      },
    }),
    makeToolResultEvent([{ id: 'c1', output: 'content' }]),
    makeAssistantEvent({
      functionCalls: [
        {
          id: 'c2',
          name: 'write_file',
          args: { file_path: 'b.ts', content: 'x' },
        },
      ],
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 50,
        thoughtsTokenCount: 0,
      },
    }),
    makeToolResultEvent([{ id: 'c2', output: 'ok' }]),
  ].join('\n');

  const traj = normalizeQwen(log, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);

  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);

  // Both steps have metrics (no dedup collapsed them)
  expect(agentSteps[0]!.metrics?.prompt_tokens).toBe(100);
  expect(agentSteps[1]!.metrics?.prompt_tokens).toBe(150); // 200 - 50 uncached

  // Each step has its own observation
  expect(agentSteps[0]!.observation?.results[0]?.content).toBe('content');
  expect(agentSteps[1]!.observation?.results[0]?.content).toBe('ok');
});

// ---------------------------------------------------------------------------
// I5: Harbor fixture file test
// Loads the real harbor fixture from test/fixtures/harbor/qwen/qwen-sessions/session.jsonl
// and asserts it normalizes to a valid trajectory with token conservation.
// ---------------------------------------------------------------------------

test('I5: harbor qwen fixture file normalizes to a valid ATIF trajectory', () => {
  const raw = readFileSync(
    new URL(
      '../test/fixtures/harbor/qwen/qwen-sessions/session.jsonl',
      import.meta.url,
    ),
    'utf8',
  );
  const traj = normalizeQwen(raw, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
});

test('I5: harbor qwen fixture file token conservation — per-step disjoint buckets', () => {
  // Fixture assistant turns:
  //   turn1: promptTokenCount=500, cachedContentTokenCount=100, candidatesTokenCount=60, thoughtsTokenCount=0
  //          → uncached_prompt=400, cached=100, completion=60
  //   turn2: promptTokenCount=620, cachedContentTokenCount=200, candidatesTokenCount=20, thoughtsTokenCount=5
  //          → uncached_prompt=420, cached=200, completion=25
  // Totals: prompt=820, cached=300, completion=85
  const raw = readFileSync(
    new URL(
      '../test/fixtures/harbor/qwen/qwen-sessions/session.jsonl',
      import.meta.url,
    ),
    'utf8',
  );
  const traj = normalizeQwen(raw, '1.0.0');
  let totalPrompt = 0,
    totalCached = 0,
    totalCompletion = 0;
  for (const step of traj.steps) {
    totalPrompt += step.metrics?.prompt_tokens ?? 0;
    totalCached += step.metrics?.cached_tokens ?? 0;
    totalCompletion += step.metrics?.completion_tokens ?? 0;
  }
  expect(totalPrompt).toBe(820); // 400+420
  expect(totalCached).toBe(300); // 100+200
  expect(totalCompletion).toBe(85); // 60+25 (candidates+thoughts folded)
});
