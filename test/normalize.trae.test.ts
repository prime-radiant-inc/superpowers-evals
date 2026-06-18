import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeTrae } from '../src/normalize/trae.ts';

// ---------------------------------------------------------------------------
// Fixture helpers (mirror _make_interaction / _make_agent_step / _make_trajectory
// from the Harbor test suite, translated to inline TS objects)
// ---------------------------------------------------------------------------

function makeInteraction({
  timestamp = '2026-01-01T00:00:00Z',
  content = '',
  toolCalls = null as Array<{
    call_id: string;
    name: string;
    arguments: Record<string, unknown> | string;
    id: null;
  }> | null,
  inputTokens = 100,
  outputTokens = 50,
  cacheReadInputTokens = 0,
  model = 'claude-sonnet-4-20250514',
}: {
  timestamp?: string;
  content?: string;
  toolCalls?: Array<{
    call_id: string;
    name: string;
    arguments: Record<string, unknown> | string;
    id: null;
  }> | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  model?: string;
} = {}): Record<string, unknown> {
  return {
    timestamp,
    provider: 'anthropic',
    model,
    input_messages: [],
    response: {
      content,
      model,
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheReadInputTokens,
        reasoning_tokens: 0,
      },
      tool_calls: toolCalls,
    },
  };
}

function makeAgentStep({
  stepNumber = 1,
  toolResults = [] as Array<{
    call_id: string;
    success: boolean;
    result: string;
    error: string;
    id: null;
  }>,
}: {
  stepNumber?: number;
  toolResults?: Array<{
    call_id: string;
    success: boolean;
    result: string;
    error: string;
    id: null;
  }>;
} = {}): Record<string, unknown> {
  return {
    step_number: stepNumber,
    timestamp: '2026-01-01T00:00:00Z',
    state: 'completed',
    llm_messages: [],
    llm_response: {},
    tool_calls: [],
    tool_results: toolResults,
    reflection: null,
    error: null,
  };
}

function makeTrajectory(
  interactions: Record<string, unknown>[],
  agentSteps: Record<string, unknown>[] = [],
  model = 'claude-sonnet-4-20250514',
): string {
  return JSON.stringify({
    task: 'test task',
    start_time: '2026-01-01T00:00:00Z',
    end_time: '2026-01-01T00:01:00Z',
    provider: 'anthropic',
    model,
    max_steps: 200,
    llm_interactions: interactions,
    agent_steps: agentSteps,
    success: true,
    final_result: '',
    execution_time: 60.0,
  });
}

// ---------------------------------------------------------------------------
// Schema, agent identity, and validate
// ---------------------------------------------------------------------------

test('schema_version is ATIF_SCHEMA_VERSION (v1.7)', () => {
  const raw = makeTrajectory([makeInteraction({ content: 'hello' })]);
  const traj = normalizeTrae(raw, '1.0.0');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
});

test('agent name and version are set', () => {
  const raw = makeTrajectory([makeInteraction({ content: 'hello' })]);
  const traj = normalizeTrae(raw, '2.3.1');
  expect(traj.agent.name).toBe('trae-agent');
  expect(traj.agent.version).toBe('2.3.1');
});

test('validateTrajectory passes for a minimal trajectory', () => {
  const raw = makeTrajectory([makeInteraction({ content: 'hello' })]);
  const traj = normalizeTrae(raw, '1.0.0');
  const result = validateTrajectory(traj);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Content fidelity — mirrors Harbor's test_content_message_step
// ---------------------------------------------------------------------------

test('content message step: step.message matches response.content', () => {
  const raw = makeTrajectory([
    makeInteraction({ content: 'I will fix the bug now.' }),
  ]);
  const traj = normalizeTrae(raw, '1.0.0');
  expect(traj.steps).toHaveLength(1);
  const step = traj.steps[0];
  expect(step).toBeDefined();
  if (!step) throw new Error('step undefined');
  expect(step.message).toBe('I will fix the bug now.');
  expect(step.tool_calls).toBeUndefined();
  expect(step.observation).toBeUndefined();
});

test('empty response content produces fallback message [empty response]', () => {
  const raw = makeTrajectory([makeInteraction({ content: '' })]);
  const traj = normalizeTrae(raw, '1.0.0');
  const step = traj.steps[0];
  expect(step).toBeDefined();
  if (!step) throw new Error('step undefined');
  expect(step.message).toBe('[empty response]');
});

// ---------------------------------------------------------------------------
// Cross-array call_id join — mirrors Harbor's test_single_tool_call_step
// ---------------------------------------------------------------------------

test('single tool call + result joined by call_id across arrays', () => {
  const interaction = makeInteraction({
    toolCalls: [
      {
        call_id: 'call_abc',
        name: 'bash',
        arguments: { command: 'ls -la' },
        id: null,
      },
    ],
  });
  const step = makeAgentStep({
    toolResults: [
      {
        call_id: 'call_abc',
        success: true,
        result: 'file1.txt\nfile2.txt',
        error: '',
        id: null,
      },
    ],
  });
  const raw = makeTrajectory([interaction], [step]);
  const traj = normalizeTrae(raw, '1.0.0');

  expect(traj.steps).toHaveLength(1);
  const s = traj.steps[0];
  expect(s).toBeDefined();
  if (!s) throw new Error('step undefined');
  expect(s.source).toBe('agent');
  expect(s.tool_calls).toHaveLength(1);

  const tc = s.tool_calls?.[0];
  expect(tc).toBeDefined();
  if (!tc) throw new Error('tc undefined');
  expect(tc.tool_call_id).toBe('call_abc');
  // Canonical name: bash → Bash
  expect(tc.function_name).toBe('Bash');
  expect(tc.arguments).toEqual({ command: 'ls -la' });

  expect(s.observation).toBeDefined();
  if (!s.observation) throw new Error('observation undefined');
  expect(s.observation.results).toHaveLength(1);
  const obs = s.observation.results[0];
  expect(obs).toBeDefined();
  if (!obs) throw new Error('obs undefined');
  expect(obs.source_call_id).toBe('call_abc');
  expect(
    typeof obs.content === 'string' && obs.content.includes('file1.txt'),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Fallback message when no content but there are tool calls
// (mirrors Harbor's test_tool_call_without_content_uses_fallback_message)
// ---------------------------------------------------------------------------

test('tool call without content produces [tool call: <name>] fallback', () => {
  const interaction = makeInteraction({
    content: '',
    toolCalls: [{ call_id: 'call_1', name: 'bash', arguments: {}, id: null }],
  });
  const raw = makeTrajectory([interaction]);
  const traj = normalizeTrae(raw, '1.0.0');
  const s = traj.steps[0];
  expect(s).toBeDefined();
  if (!s) throw new Error('step undefined');
  // Canonical tool name is Bash, so message uses canonical form
  expect(s.message).toBe('[tool call: Bash]');
});

// ---------------------------------------------------------------------------
// Multiple tool calls in one interaction (cross-array join for each)
// (mirrors Harbor's test_multiple_tool_calls_in_one_interaction)
// ---------------------------------------------------------------------------

test('multiple tool calls in one interaction, all joined by call_id', () => {
  const interaction = makeInteraction({
    toolCalls: [
      {
        call_id: 'call_1',
        name: 'bash',
        arguments: { command: 'pwd' },
        id: null,
      },
      {
        call_id: 'call_2',
        name: 'str_replace_based_edit_tool',
        arguments: { file: 'a.py' },
        id: null,
      },
    ],
  });
  const step = makeAgentStep({
    toolResults: [
      {
        call_id: 'call_1',
        success: true,
        result: '/testbed',
        error: '',
        id: null,
      },
      { call_id: 'call_2', success: true, result: 'ok', error: '', id: null },
    ],
  });
  const raw = makeTrajectory([interaction], [step]);
  const traj = normalizeTrae(raw, '1.0.0');

  const s = traj.steps[0];
  expect(s).toBeDefined();
  if (!s) throw new Error('step undefined');
  expect(s.tool_calls).toHaveLength(2);

  const tc0 = s.tool_calls?.[0];
  const tc1 = s.tool_calls?.[1];
  expect(tc0).toBeDefined();
  expect(tc1).toBeDefined();
  if (!tc0 || !tc1) throw new Error('tc undefined');

  expect(tc0.function_name).toBe('Bash');
  // str_replace_based_edit_tool → Edit
  expect(tc1.function_name).toBe('Edit');

  expect(s.observation?.results).toHaveLength(2);
  // Fallback message uses canonical names
  expect(s.message).toBe('[tool call: Bash, Edit]');
});

// ---------------------------------------------------------------------------
// Tool result error path (mirrors Harbor's test_tool_result_with_error_uses_error_string)
// ---------------------------------------------------------------------------

test('tool result with error field uses error string as content', () => {
  const interaction = makeInteraction({
    toolCalls: [
      {
        call_id: 'call_err',
        name: 'bash',
        arguments: { command: 'bad' },
        id: null,
      },
    ],
  });
  const step = makeAgentStep({
    toolResults: [
      {
        call_id: 'call_err',
        success: false,
        result: '',
        error: 'command not found',
        id: null,
      },
    ],
  });
  const raw = makeTrajectory([interaction], [step]);
  const traj = normalizeTrae(raw, '1.0.0');

  const s = traj.steps[0];
  expect(s).toBeDefined();
  if (!s) throw new Error('step undefined');
  const obs = s.observation?.results[0];
  expect(obs).toBeDefined();
  if (!obs) throw new Error('obs undefined');
  expect(obs.content).toBe('command not found');
});

// ---------------------------------------------------------------------------
// Missing tool result omits observation
// (mirrors Harbor's test_missing_tool_result_omits_observation)
// ---------------------------------------------------------------------------

test('tool call without matching result produces no observation', () => {
  const interaction = makeInteraction({
    toolCalls: [
      { call_id: 'call_orphan', name: 'bash', arguments: {}, id: null },
    ],
  });
  const raw = makeTrajectory([interaction], []);
  const traj = normalizeTrae(raw, '1.0.0');

  const s = traj.steps[0];
  expect(s).toBeDefined();
  if (!s) throw new Error('step undefined');
  expect(s.tool_calls).toBeDefined();
  expect(s.observation).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Step ids are sequential (mirrors Harbor's test_step_ids_are_sequential)
// ---------------------------------------------------------------------------

test('step ids are 1-based sequential', () => {
  const interactions = [
    makeInteraction({ content: 'step one' }),
    makeInteraction({ content: 'step two' }),
    makeInteraction({ content: 'step three' }),
  ];
  const raw = makeTrajectory(interactions);
  const traj = normalizeTrae(raw, '1.0.0');
  expect(traj.steps.map((s) => s.step_id)).toEqual([1, 2, 3]);
});

// ---------------------------------------------------------------------------
// model_name from trajectory (mirrors Harbor's test_model_name_from_trajectory)
// ---------------------------------------------------------------------------

test('model_name from top-level trajectory.model is reflected on agent and steps', () => {
  const interaction = makeInteraction({ content: 'hello' });
  const raw = makeTrajectory([interaction], [], 'gpt-5');
  const traj = normalizeTrae(raw, '1.0.0');
  expect(traj.agent.model_name).toBe('gpt-5');
  const step = traj.steps[0];
  expect(step).toBeDefined();
  if (!step) throw new Error('step undefined');
  expect(step.model_name).toBe('gpt-5');
});

// ---------------------------------------------------------------------------
// Error step without interactions
// (mirrors Harbor's test_error_step_without_interactions)
// ---------------------------------------------------------------------------

test('error in agent_steps with no llm_interactions produces error step', () => {
  const errorStep = {
    step_number: 1,
    timestamp: '2026-03-31T16:11:59.203754',
    state: 'completed',
    llm_messages: [],
    llm_response: null,
    tool_calls: null,
    tool_results: null,
    reflection: null,
    error: "Expecting ',' delimiter: line 1 column 94 (char 93)",
  };
  const rawObj = {
    task: 'test task',
    start_time: '2026-01-01T00:00:00Z',
    end_time: '2026-01-01T00:01:00Z',
    provider: 'openrouter',
    model: 'deepseek-v3.2',
    max_steps: 200,
    llm_interactions: [],
    agent_steps: [errorStep],
    success: false,
    final_result: '',
    execution_time: 60.0,
  };
  const traj = normalizeTrae(JSON.stringify(rawObj), '1.0.0');

  expect(traj.steps).toHaveLength(1);
  const s = traj.steps[0];
  expect(s).toBeDefined();
  if (!s) throw new Error('step undefined');
  expect(s.step_id).toBe(1);
  expect(s.source).toBe('agent');
  expect(typeof s.message === 'string' && s.message.includes('[error]')).toBe(
    true,
  );
  expect(
    typeof s.message === 'string' && s.message.includes("Expecting ','"),
  ).toBe(true);
  expect(s.tool_calls).toBeUndefined();
  expect(s.observation).toBeUndefined();

  // Must pass validation
  const result = validateTrajectory(traj);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Empty both arrays → throw or empty fallback
// ---------------------------------------------------------------------------

test('empty interactions and steps throws (no steps to produce)', () => {
  const raw = makeTrajectory([], []);
  expect(() => normalizeTrae(raw, '1.0.0')).toThrow();
});

// ---------------------------------------------------------------------------
// Tool name canonicalization
// ---------------------------------------------------------------------------

test('tool name map: known names are canonicalized', () => {
  const toolPairs: Array<[string, string]> = [
    ['bash', 'Bash'],
    ['str_replace_based_edit_tool', 'Edit'],
    ['sequentialthinking', 'sequentialthinking'], // unknown → pass through
    ['task_done', 'task_done'], // unknown → pass through
  ];
  for (const [native, canonical] of toolPairs) {
    const interaction = makeInteraction({
      toolCalls: [{ call_id: 'c1', name: native, arguments: {}, id: null }],
    });
    const raw = makeTrajectory([interaction]);
    const traj = normalizeTrae(raw, '1.0.0');
    const tc = traj.steps[0]?.tool_calls?.[0];
    expect(tc).toBeDefined();
    if (!tc) throw new Error('tc undefined');
    expect(tc.function_name).toBe(canonical);
  }
});

// ---------------------------------------------------------------------------
// Token metrics — per-step ONLY (no final_metrics token totals = single source)
// (mirrors Harbor's test_per_step_metrics, reconciled to our disjoint buckets)
// ---------------------------------------------------------------------------

test('per-step metrics: input_tokens → prompt_tokens (already uncached; exclusive)', () => {
  const interaction = makeInteraction({
    content: 'hi',
    inputTokens: 500,
    outputTokens: 120,
    cacheReadInputTokens: 50,
  });
  const raw = makeTrajectory([interaction]);
  const traj = normalizeTrae(raw, '1.0.0');

  const m = traj.steps[0]?.metrics;
  expect(m).toBeDefined();
  if (!m) throw new Error('metrics undefined');
  // input_tokens is already EXCLUSIVE of cache (disjoint bucket = no subtraction)
  expect(m.prompt_tokens).toBe(500);
  expect(m.completion_tokens).toBe(120);
  expect(m.cached_tokens).toBe(50);
});

test('zero cache_read produces undefined cached_tokens on step', () => {
  const interaction = makeInteraction({
    content: 'hi',
    cacheReadInputTokens: 0,
  });
  const raw = makeTrajectory([interaction]);
  const traj = normalizeTrae(raw, '1.0.0');
  expect(traj.steps[0]?.metrics?.cached_tokens).toBeUndefined();
});

// ---------------------------------------------------------------------------
// SINGLE-SOURCE rule: per-step metrics → no final_metrics token totals
// ---------------------------------------------------------------------------

test('final_metrics has no token totals (per-step is the single source)', () => {
  const interactions = [
    makeInteraction({
      content: 'a',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 10,
    }),
    makeInteraction({
      content: 'b',
      inputTokens: 200,
      outputTokens: 30,
      cacheReadInputTokens: 0,
    }),
    makeInteraction({
      content: 'c',
      inputTokens: 300,
      outputTokens: 50,
      cacheReadInputTokens: 5,
    }),
  ];
  const raw = makeTrajectory(interactions);
  const traj = normalizeTrae(raw, '1.0.0');

  // Per-step is the single source — final_metrics must carry NO token totals
  // (absent or undefined), to prevent obol double-counting.
  const fm = traj.final_metrics;
  if (fm !== undefined) {
    expect(fm.total_prompt_tokens).toBeUndefined();
    expect(fm.total_completion_tokens).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Disjoint-bucket conservation: sum of per-step buckets = sum of raw logs
// No cache_write field in trae logs, so conservation is:
//   Σ(prompt_tokens) + Σ(cached_tokens) + Σ(completion_tokens) == Σ(input + cache_read + output)
// ---------------------------------------------------------------------------

test('disjoint-bucket conservation across multiple turns', () => {
  const interactions = [
    makeInteraction({
      content: 'a',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 10,
    }),
    makeInteraction({
      content: 'b',
      inputTokens: 200,
      outputTokens: 30,
      cacheReadInputTokens: 0,
    }),
    makeInteraction({
      content: 'c',
      inputTokens: 300,
      outputTokens: 50,
      cacheReadInputTokens: 5,
    }),
  ];
  const raw = makeTrajectory(interactions);
  const traj = normalizeTrae(raw, '1.0.0');

  let totalPrompt = 0;
  let totalCached = 0;
  let totalCompletion = 0;
  for (const step of traj.steps) {
    totalPrompt += step.metrics?.prompt_tokens ?? 0;
    totalCached += step.metrics?.cached_tokens ?? 0;
    totalCompletion += step.metrics?.completion_tokens ?? 0;
  }

  // Known raw totals from our fixture:
  // input:  100+200+300 = 600
  // cache:   10+  0+  5 =  15
  // output:  20+ 30+ 50 = 100
  // Total: 715
  expect(totalPrompt).toBe(600);
  expect(totalCached).toBe(15);
  expect(totalCompletion).toBe(100);
  expect(totalPrompt + totalCached + totalCompletion).toBe(715);
});

// ---------------------------------------------------------------------------
// session_id from raw trajectory (if present)
// ---------------------------------------------------------------------------

test('session_id is propagated from raw trajectory when present', () => {
  const rawObj = {
    session_id: 'sess-abc-123',
    task: 'test',
    start_time: '2026-01-01T00:00:00Z',
    end_time: '2026-01-01T00:01:00Z',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    max_steps: 200,
    llm_interactions: [makeInteraction({ content: 'hello' })],
    agent_steps: [],
    success: true,
    final_result: '',
    execution_time: 5.0,
  };
  const traj = normalizeTrae(JSON.stringify(rawObj), '1.0.0');
  expect(traj.session_id).toBe('sess-abc-123');
});

test('session_id is absent when not in raw trajectory', () => {
  const raw = makeTrajectory([makeInteraction({ content: 'hello' })]);
  const traj = normalizeTrae(raw, '1.0.0');
  expect(traj.session_id).toBeUndefined();
});

// ---------------------------------------------------------------------------
// JSON string arguments are parsed (mirrors Harbor's _parse_tool_args)
// ---------------------------------------------------------------------------

test('tool arguments as JSON string are parsed into a dict', () => {
  const interaction = makeInteraction({
    toolCalls: [
      {
        call_id: 'c1',
        name: 'bash',
        arguments: '{"command": "echo hi"}',
        id: null,
      },
    ],
  });
  const raw = makeTrajectory([interaction]);
  const traj = normalizeTrae(raw, '1.0.0');
  const tc = traj.steps[0]?.tool_calls?.[0];
  expect(tc).toBeDefined();
  if (!tc) throw new Error('tc undefined');
  expect(tc.arguments).toEqual({ command: 'echo hi' });
});

test('plain string arguments wrapped as {input: <string>}', () => {
  const interaction = makeInteraction({
    toolCalls: [
      { call_id: 'c1', name: 'bash', arguments: 'just a string', id: null },
    ],
  });
  const raw = makeTrajectory([interaction]);
  const traj = normalizeTrae(raw, '1.0.0');
  const tc = traj.steps[0]?.tool_calls?.[0];
  expect(tc).toBeDefined();
  if (!tc) throw new Error('tc undefined');
  expect(tc.arguments).toEqual({ input: 'just a string' });
});

// ---------------------------------------------------------------------------
// Validate full trajectory with tool + observation passes
// (mirrors Harbor's test_trajectory_passes_validation)
// ---------------------------------------------------------------------------

test('full trajectory with tool call and observation passes validateTrajectory', () => {
  const interaction = makeInteraction({
    content: 'thinking...',
    toolCalls: [
      {
        call_id: 'c1',
        name: 'bash',
        arguments: { command: 'echo hi' },
        id: null,
      },
    ],
  });
  const step = makeAgentStep({
    toolResults: [
      { call_id: 'c1', success: true, result: 'hi', error: '', id: null },
    ],
  });
  const raw = makeTrajectory([interaction], [step]);
  const traj = normalizeTrae(raw, '1.0.0');

  const result = validateTrajectory(traj);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});
