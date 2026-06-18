import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeCline } from '../src/normalize/cline.ts';

// ---------------------------------------------------------------------------
// Helper — build a minimal Cline messages.json document
// ---------------------------------------------------------------------------

function makeDoc(
  messages: Record<string, unknown>[],
  sessionId = 'sess-1',
): string {
  return JSON.stringify({ sessionId, messages });
}

// ---------------------------------------------------------------------------
// Harbor fixture 1 (ported from test_cline_trajectory.py test_converts_simple_text_exchange)
// inputTokens: 100, cacheReadTokens: 80, outputTokens: 10
// Harbor passes inputTokens → prompt_tokens unchanged (already exclusive of cache).
// OUR disjoint mapping: prompt=100, cached=80, completion=10, cost=0.001
// ---------------------------------------------------------------------------

const simpleExchangeDoc = JSON.stringify({
  sessionId: 'sess-1',
  messages: [
    { role: 'user', content: 'What is 2 + 2?', ts: 1776890894000 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '4.' }],
      ts: 1776890895000,
      modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
      metrics: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        cost: 0.001,
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Harbor fixture 2 (ported from test_folds_tool_result_into_agent_step_observation)
// ---------------------------------------------------------------------------

const toolResultDoc = JSON.stringify({
  sessionId: 'sess-1',
  messages: [
    { role: 'user', content: 'List files.', ts: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll list them." },
        {
          type: 'tool_use',
          id: 'call_abc',
          name: 'run_commands',
          input: { commands: ['ls'] },
        },
      ],
      ts: 2,
      modelInfo: { id: 'm' },
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_abc',
          content: 'file1\nfile2',
        },
      ],
      ts: 3,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      ts: 4,
      modelInfo: { id: 'm' },
    },
  ],
});

// ---------------------------------------------------------------------------
// Tests — Harbor fixture 1: simple text exchange
// ---------------------------------------------------------------------------

test('schema_version is ATIF_SCHEMA_VERSION (v1.7) and agent metadata correct', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent.name).toBe('cline');
  expect(traj.agent.version).toBe('1.0.0');
});

test('validateTrajectory passes on simple exchange', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test('session_id extracted from top-level sessionId', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  expect(traj.session_id).toBe('sess-1');
});

test('simple exchange: step sources and step_ids', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  expect(traj.steps.map((s) => s.step_id)).toEqual([1, 2]);
  expect(traj.steps[0]!.source).toBe('user');
  expect(traj.steps[1]!.source).toBe('agent');
});

test('simple exchange: user message text', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  expect(traj.steps[0]!.message).toBe('What is 2 + 2?');
});

test('simple exchange: agent message text', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  expect(traj.steps[1]!.message).toBe('4.');
});

test('simple exchange: model_name from modelInfo.id', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  expect(traj.steps[1]!.model_name).toBe('claude-sonnet-4-6');
  // agent.model_name comes from first assistant message
  expect(traj.agent.model_name).toBe('claude-sonnet-4-6');
});

// Harbor fixture 1: token buckets (OUR disjoint mapping)
// inputTokens(100) is EXCLUSIVE of cache → prompt_tokens = 100 (no subtraction needed)
// cacheReadTokens(80) → cached_tokens = 80
// cacheWriteTokens(0) → NOT set in extra (only when > 0)
// outputTokens(10) → completion_tokens = 10
// cost(0.001) → cost_usd = 0.001 (passthrough)
test('simple exchange: disjoint token buckets on agent step', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  const step = traj.steps[1]!;
  expect(step.metrics).toBeDefined();
  expect(step.metrics!.prompt_tokens).toBe(100);
  expect(step.metrics!.cached_tokens).toBe(80);
  expect(step.metrics!.completion_tokens).toBe(10);
  expect(step.metrics!.cost_usd).toBeCloseTo(0.001, 6);
  // cacheWriteTokens is 0 → NOT set in extra
  expect(step.extra?.['cache_write']).toBeUndefined();
});

test('simple exchange: final_metrics totals', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  const fm = traj.final_metrics;
  expect(fm).toBeDefined();
  expect(fm!.total_steps).toBe(2);
  expect(fm!.total_prompt_tokens).toBe(100);
  expect(fm!.total_completion_tokens).toBe(10);
  expect(fm!.total_cost_usd).toBeCloseTo(0.001, 6);
});

// ---------------------------------------------------------------------------
// Tests — Harbor fixture 2: tool result folded into agent step observation
// ---------------------------------------------------------------------------

test('validateTrajectory passes on tool-result fixture', () => {
  const traj = normalizeCline(toolResultDoc, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test('tool result: step sources are [user, agent, agent]', () => {
  const traj = normalizeCline(toolResultDoc, '1.0.0');
  expect(traj.steps.map((s) => s.source)).toEqual(['user', 'agent', 'agent']);
});

test('tool result: agent step has tool_call with correct id and name', () => {
  const traj = normalizeCline(toolResultDoc, '1.0.0');
  const agentStep = traj.steps[1]!;
  expect(agentStep.tool_calls).toBeDefined();
  expect(agentStep.tool_calls![0]!.tool_call_id).toBe('call_abc');
  // run_commands → canonical Bash (via CLINE_TOOL_MAP)
  expect(agentStep.tool_calls![0]!.function_name).toBe('Bash');
  expect(agentStep.tool_calls![0]!.arguments).toEqual({ commands: ['ls'] });
});

test('tool result: observation attached to agent step with source_call_id', () => {
  const traj = normalizeCline(toolResultDoc, '1.0.0');
  const agentStep = traj.steps[1]!;
  expect(agentStep.observation).toBeDefined();
  expect(agentStep.observation!.results[0]!.source_call_id).toBe('call_abc');
  expect(agentStep.observation!.results[0]!.content).toBe('file1\nfile2');
});

test('tool result: user message with only tool_result does not emit a user step', () => {
  // The user message containing only tool_result should NOT produce a user step
  const traj = normalizeCline(toolResultDoc, '1.0.0');
  // 4 raw messages but only 3 steps (user step skipped for tool_result-only user message)
  expect(traj.steps.length).toBe(3);
});

// ---------------------------------------------------------------------------
// Harbor fixture: thinking → reasoning_content
// (ported from test_extracts_thinking_as_reasoning_content)
// ---------------------------------------------------------------------------

const thinkingDoc = makeDoc([
  { role: 'user', content: 'hi', ts: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'let me think' },
      { type: 'text', text: 'hello' },
    ],
    ts: 2,
    modelInfo: { id: 'm' },
  },
]);

test('thinking block → reasoning_content', () => {
  const traj = normalizeCline(thinkingDoc, '1.0.0');
  expect(traj.steps[1]!.reasoning_content).toBe('let me think');
  expect(traj.steps[1]!.message).toBe('hello');
});

test('validateTrajectory passes on thinking fixture', () => {
  const traj = normalizeCline(thinkingDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Harbor fixture: sequential step IDs
// (ported from test_sequential_step_ids_and_validation_passes)
// ---------------------------------------------------------------------------

const multiTurnDoc = makeDoc([
  { role: 'user', content: 'a' },
  { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
  { role: 'user', content: 'c' },
  { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
]);

test('sequential step_ids from 1', () => {
  const traj = normalizeCline(multiTurnDoc, '1.0.0');
  expect(traj.steps.map((s) => s.step_id)).toEqual([1, 2, 3, 4]);
});

test('validateTrajectory passes on multi-turn fixture', () => {
  const traj = normalizeCline(multiTurnDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Harbor fixture: missing metrics produces no totals
// (ported from test_missing_metrics_produces_no_totals)
// ---------------------------------------------------------------------------

const noMetricsDoc = makeDoc([
  { role: 'user', content: 'a' },
  { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
]);

test('missing metrics: no final_metrics token fields', () => {
  const traj = normalizeCline(noMetricsDoc, '1.0.0');
  const fm = traj.final_metrics;
  expect(fm).toBeDefined();
  expect(fm!.total_steps).toBe(2);
  expect(fm!.total_prompt_tokens).toBeUndefined();
  expect(fm!.total_cost_usd).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Harbor fixture: mixed user message (tool_result + text)
// (ported from test_user_message_with_mixed_text_and_tool_result_preserves_both)
// ---------------------------------------------------------------------------

const mixedUserDoc = makeDoc([
  { role: 'user', content: 'Do it.', ts: 1 },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'run',
        input: { cmd: 'ls' },
      },
    ],
    ts: 2,
    modelInfo: { id: 'm' },
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'file1',
      },
      { type: 'text', text: 'btw keep going' },
    ],
    ts: 3,
  },
]);

test('mixed user message: tool_result attached to agent, text becomes user step', () => {
  const traj = normalizeCline(mixedUserDoc, '1.0.0');
  expect(traj.steps.map((s) => s.source)).toEqual(['user', 'agent', 'user']);
  const agentStep = traj.steps[1]!;
  expect(agentStep.observation).toBeDefined();
  expect(agentStep.observation!.results[0]!.source_call_id).toBe('call_1');
  expect(agentStep.observation!.results[0]!.content).toBe('file1');
  expect(traj.steps[2]!.message).toBe('btw keep going');
});

test('validateTrajectory passes on mixed-user-message fixture', () => {
  const traj = normalizeCline(mixedUserDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Harbor fixture: orphan tool_result + text preserves both
// (ported from test_user_message_with_orphan_tool_result_and_text_preserves_both)
// ---------------------------------------------------------------------------

const orphanDoc = makeDoc([
  { role: 'user', content: 'hi', ts: 1 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    ts: 2,
    modelInfo: { id: 'm' },
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_missing',
        content: 'stray',
      },
      { type: 'text', text: 'continue' },
    ],
    ts: 3,
  },
]);

test('orphan tool_result + text: both preserved in user step message', () => {
  const traj = normalizeCline(orphanDoc, '1.0.0');
  expect(traj.steps.map((s) => s.source)).toEqual(['user', 'agent', 'user']);
  const last = traj.steps[2]!.message;
  expect(typeof last).toBe('string');
  expect(last as string).toContain('continue');
  expect(last as string).toContain('call_missing');
  expect(last as string).toContain('stray');
});

test('validateTrajectory passes on orphan-tool-result fixture', () => {
  const traj = normalizeCline(orphanDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Tool name canonicalization tests
// ---------------------------------------------------------------------------

const toolNamesDoc = makeDoc([
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tc1',
        name: 'execute_command',
        input: { command: 'ls' },
      },
      {
        type: 'tool_use',
        id: 'tc2',
        name: 'read_file',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_use',
        id: 'tc3',
        name: 'write_to_file',
        input: { path: 'b.ts', content: 'x' },
      },
      {
        type: 'tool_use',
        id: 'tc4',
        name: 'replace_in_file',
        input: { path: 'c.ts', diff: '...' },
      },
      {
        type: 'tool_use',
        id: 'tc5',
        name: 'search_files',
        input: { path: '.', regex: 'foo' },
      },
      { type: 'tool_use', id: 'tc6', name: 'list_files', input: { path: '.' } },
      {
        type: 'tool_use',
        id: 'tc7',
        name: 'browser_action',
        input: { action: 'launch' },
      },
      {
        type: 'tool_use',
        id: 'tc8',
        name: 'new_task',
        input: { task: 'do something' },
      },
      {
        type: 'tool_use',
        id: 'tc9',
        name: 'run_commands',
        input: { commands: ['ls'] },
      },
      { type: 'tool_use', id: 'tc10', name: 'unknown_tool_xyz', input: {} },
    ],
    modelInfo: { id: 'm' },
  },
]);

test('tool names canonicalized per CLINE_TOOL_MAP', () => {
  const traj = normalizeCline(toolNamesDoc, '1.0.0');
  const step = traj.steps[0]!;
  const names = step.tool_calls!.map((tc) => tc.function_name);
  expect(names).toEqual([
    'Bash', // execute_command
    'Read', // read_file
    'Write', // write_to_file
    'Edit', // replace_in_file
    'Grep', // search_files
    'Glob', // list_files
    'WebFetch', // browser_action
    'Agent', // new_task
    'Bash', // run_commands
    'unknown_tool_xyz', // unknown → passthrough
  ]);
});

test('validateTrajectory passes on tool-names fixture', () => {
  const traj = normalizeCline(toolNamesDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// cache_write: only set when > 0
// ---------------------------------------------------------------------------

const cacheWriteDoc = makeDoc([
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'thinking...' }],
    modelInfo: { id: 'm' },
    metrics: {
      inputTokens: 500,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 1024,
      cost: 0.005,
    },
  },
]);

test('cacheWriteTokens > 0 → step.extra.cache_write', () => {
  const traj = normalizeCline(cacheWriteDoc, '1.0.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  expect(agentStep!.extra?.['cache_write']).toBe(1024);
  expect(agentStep!.metrics!.prompt_tokens).toBe(500);
  expect(agentStep!.metrics!.cached_tokens).toBe(0);
  expect(agentStep!.metrics!.completion_tokens).toBe(20);
});

// ---------------------------------------------------------------------------
// Disjoint-bucket conservation: sum of per-step (prompt + cached + completion
// + cache_write) equals known session totals. Proves no double-count and no
// dropped turn.
// ---------------------------------------------------------------------------

const multiTurnMetricsDoc = JSON.stringify({
  sessionId: 'sess-multi',
  messages: [
    { role: 'user', content: 'First question.', ts: 1000 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'First answer.' }],
      ts: 2000,
      modelInfo: { id: 'claude-sonnet-4-6' },
      metrics: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 200,
        cost: 0.002,
      },
    },
    { role: 'user', content: 'Second question.', ts: 3000 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Second answer.' }],
      ts: 4000,
      modelInfo: { id: 'claude-sonnet-4-6' },
      metrics: {
        inputTokens: 150,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        cost: 0.003,
      },
    },
  ],
});

test('disjoint-bucket conservation: per-step sums match known totals', () => {
  const traj = normalizeCline(multiTurnMetricsDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);

  let totalPrompt = 0;
  let totalCached = 0;
  let totalCompletion = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const step of traj.steps) {
    if (step.metrics) {
      totalPrompt += step.metrics.prompt_tokens ?? 0;
      totalCached += step.metrics.cached_tokens ?? 0;
      totalCompletion += step.metrics.completion_tokens ?? 0;
      totalCost += step.metrics.cost_usd ?? 0;
    }
    if (step.extra?.['cache_write']) {
      totalCacheWrite += step.extra['cache_write'] as number;
    }
  }

  // Turn 1: prompt=100, cached=50, completion=10, cache_write=200, cost=0.002
  // Turn 2: prompt=150, cached=80, completion=20, cache_write=0, cost=0.003
  expect(totalPrompt).toBe(250);
  expect(totalCached).toBe(130);
  expect(totalCompletion).toBe(30);
  expect(totalCacheWrite).toBe(200);
  expect(totalCost).toBeCloseTo(0.005, 6);
});

test('disjoint-bucket conservation: final_metrics totals match per-step sums', () => {
  const traj = normalizeCline(multiTurnMetricsDoc, '1.0.0');
  const fm = traj.final_metrics!;
  // Harbor sums inputTokens which are EXCLUSIVE of cache → same as our prompt_tokens
  expect(fm.total_prompt_tokens).toBe(250);
  expect(fm.total_completion_tokens).toBe(30);
  expect(fm.total_cost_usd).toBeCloseTo(0.005, 6);
});

// ---------------------------------------------------------------------------
// Dedup: Cline's messages.json is a persisted final history — no re-emission
// by message id. Verify no dedup mechanism is needed (each message processed once).
// ---------------------------------------------------------------------------

test('no dedup needed: each message is processed exactly once', () => {
  // Cline's messages.json is the final persisted history, not a streaming log.
  // There is no re-emission of messages by id in this format.
  // Confirmed by reading harbor/agents/installed/cline/trajectory.py:
  // the converter has no seen_message_ids guard — it processes each message once.
  const traj = normalizeCline(multiTurnMetricsDoc, '1.0.0');
  // Exactly 4 steps: user, agent, user, agent
  expect(traj.steps.length).toBe(4);
  // Exactly 2 metrics-bearing agent steps
  expect(traj.steps.filter((s) => s.metrics !== undefined).length).toBe(2);
});

// ---------------------------------------------------------------------------
// Content fidelity: timestamp extraction from ms
// ---------------------------------------------------------------------------

test('timestamps extracted from ms field', () => {
  const traj = normalizeCline(simpleExchangeDoc, '1.0.0');
  // ts: 1776890894000 ms → ISO string
  expect(traj.steps[0]!.timestamp).toBe(new Date(1776890894000).toISOString());
  expect(traj.steps[1]!.timestamp).toBe(new Date(1776890895000).toISOString());
});

test('missing ts → no timestamp on step', () => {
  const traj = normalizeCline(noMetricsDoc, '1.0.0');
  expect(traj.steps[0]!.timestamp).toBeUndefined();
  expect(traj.steps[1]!.timestamp).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('invalid JSON returns valid fallback trajectory', () => {
  const traj = normalizeCline('not-json', '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe('user');
});

test('user-only message with no text (tool_result-only) is skipped', () => {
  // A user message with ONLY tool_results and no remaining text → no user step
  const traj = normalizeCline(toolResultDoc, '1.0.0');
  const userSteps = traj.steps.filter((s) => s.source === 'user');
  // Only the first "List files." user message should produce a user step
  expect(userSteps.length).toBe(1);
  expect(userSteps[0]!.message).toBe('List files.');
});

test('image block in content → placeholder text', () => {
  const imageDoc = makeDoc([
    {
      role: 'assistant',
      content: [
        { type: 'image', mediaType: 'image/png' },
        { type: 'text', text: 'See image above.' },
      ],
      modelInfo: { id: 'm' },
    },
  ]);
  const traj = normalizeCline(imageDoc, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const step = traj.steps[0]!;
  expect(step.message as string).toContain('image/png');
  expect(step.message as string).toContain('See image above.');
});
