import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimatePath } from '@primeradianthq/obol';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeCursor } from '../src/normalize/cursor.ts';

// ---------------------------------------------------------------------------
// Fixtures — inline JSONL strings representing cursor-cli.txt stream-json output.
// Event types handled: system(init), user, assistant, thinking(delta|completed),
// tool_call(started|completed), result, interaction_query.
// ---------------------------------------------------------------------------

/** Minimal event stream: system init + user message + assistant reply + usage. */
const minimalLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-abc',
    model: 'anthropic/claude-sonnet-4-5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Hello, agent!' }],
    },
    session_id: 'session-abc',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-abc',
    model_call_id: 'call-m1',
    timestamp_ms: 1700000001000,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'I will help you.' }],
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    result: 'I will help you.',
    session_id: 'session-abc',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 30,
    },
  }),
].join('\n');

/** Tool call event stream: assistant with two tool calls attached via model_call_id. */
const toolCallLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-tool',
    model: 'cursor/composer-2.5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'List files.' }] },
    session_id: 'session-tool',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-tool',
    model_call_id: 'mcall-1',
    timestamp_ms: 1700000002000,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me check.' }],
    },
  }),
  // started events are skipped; only completed carries args + result
  JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'tc-1',
    session_id: 'session-tool',
    model_call_id: 'mcall-1',
    timestamp_ms: 1700000002100,
    tool_call: {
      run_terminal_cmd: { args: { command: 'ls -la' }, result: null },
    },
  }),
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-1',
    session_id: 'session-tool',
    model_call_id: 'mcall-1',
    timestamp_ms: 1700000002500,
    tool_call: {
      run_terminal_cmd: {
        args: { command: 'ls -la' },
        result: 'total 0\ndrwxr-xr-x 2 user user 40 Jan 1 00:00 .',
      },
    },
  }),
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-2',
    session_id: 'session-tool',
    model_call_id: 'mcall-1',
    timestamp_ms: 1700000003000,
    tool_call: {
      read_file: {
        args: { target_file: 'README.md' },
        result: '# Project\nSome content.',
      },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 2000,
    duration_api_ms: 1500,
    is_error: false,
    result: 'Done.',
    session_id: 'session-tool',
    usage: {
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  }),
].join('\n');

/** Tool name canonicalization fixture: exercises the CURSOR_TOOL_MAP. */
const toolMapLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-tools',
    model: 'cursor/composer-2.5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Working.' }],
    },
  }),
  // run_terminal_cmd → Bash
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-bash',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000010000,
    tool_call: {
      run_terminal_cmd: { args: { command: 'echo hi' }, result: 'hi' },
    },
  }),
  // read_file → Read
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-read',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000011000,
    tool_call: {
      read_file: { args: { target_file: 'x.ts' }, result: 'content' },
    },
  }),
  // edit_file → Edit
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-edit',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000012000,
    tool_call: {
      edit_file: {
        args: { target_file: 'x.ts', instructions: 'fix' },
        result: 'ok',
      },
    },
  }),
  // write_file → Write
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-write',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000013000,
    tool_call: {
      write_file: {
        args: { target_file: 'new.ts', contents: 'x' },
        result: 'written',
      },
    },
  }),
  // list_dir → Glob
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-glob',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000014000,
    tool_call: {
      list_dir: { args: { relative_workspace_path: '.' }, result: 'a\nb' },
    },
  }),
  // grep_search → Grep
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-grep',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000015000,
    tool_call: {
      grep_search: {
        args: { query: 'TODO', search_path: '.' },
        result: 'file.ts:1:TODO',
      },
    },
  }),
  // file_search → Glob (file pattern search)
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-filesearch',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000016000,
    tool_call: {
      file_search: { args: { query: '*.ts' }, result: 'src/a.ts\nsrc/b.ts' },
    },
  }),
  // web_search → WebSearch
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-websearch',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000017000,
    tool_call: {
      web_search: { args: { query: 'atif spec' }, result: 'link1' },
    },
  }),
  // unknown tool passes through unchanged
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tc-unknown',
    session_id: 'session-tools',
    model_call_id: 'mcall-tools',
    timestamp_ms: 1700000018000,
    tool_call: { mark_done: { args: {}, result: null } },
  }),
].join('\n');

/** Token usage with cost reported by the CLI via totalCost field. */
const costLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-cost',
    model: 'anthropic/claude-sonnet-4-5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Go.' }] },
    session_id: 'session-cost',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-cost',
    model_call_id: 'mcall-cost',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: false,
    result: 'Done.',
    session_id: 'session-cost',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0.42,
    },
  }),
].join('\n');

/** Multiple result events — each attaches usage to the preceding agent step. */
const multiResultLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-multi',
    model: 'anthropic/claude-sonnet-4-5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Step 1.' }] },
    session_id: 'session-multi',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-multi',
    model_call_id: 'mcall-a',
    message: { role: 'assistant', content: [{ type: 'text', text: 'First.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: false,
    result: 'First.',
    session_id: 'session-multi',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Step 2.' }] },
    session_id: 'session-multi',
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-multi',
    model_call_id: 'mcall-b',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Second.' }],
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 600,
    duration_api_ms: 500,
    is_error: false,
    result: 'Second.',
    session_id: 'session-multi',
    usage: {
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    },
  }),
].join('\n');

/** Thinking blocks accumulate on the assistant step as reasoning_content. */
const thinkingLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-think',
    model: 'cursor/composer-2.5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'thinking',
    subtype: 'delta',
    text: 'First thought.',
    session_id: 'session-think',
    timestamp_ms: 1700000001000,
  }),
  JSON.stringify({
    type: 'thinking',
    subtype: 'completed',
    text: ' Second thought.',
    session_id: 'session-think',
    timestamp_ms: 1700000002000,
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-think',
    model_call_id: 'mcall-think',
    timestamp_ms: 1700000003000,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Answer.' }],
    },
  }),
].join('\n');

/** Interaction query events are skipped without crashing. */
const interactionQueryLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-iq',
    model: 'cursor/composer-2.5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'interaction_query',
    subtype: 'request',
    query_type: 'webSearchRequestQuery',
    query: { id: 0, webSearchRequestQuery: { args: { searchTerm: 'test' } } },
    session_id: 'session-iq',
    timestamp_ms: 1700000000000,
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-iq',
    model_call_id: 'mcall-iq',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  }),
].join('\n');

/** Unknown event types are silently skipped. */
const unknownEventLog = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-unk',
    model: 'cursor/composer-2.5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'future_event',
    session_id: 'session-unk',
    payload: { value: 'ignored' },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-unk',
    model_call_id: 'mcall-unk',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Still here.' }],
    },
  }),
].join('\n');

// ---------------------------------------------------------------------------
// Helper: write a trajectory to a temp file and price it via obol
// ---------------------------------------------------------------------------
async function priceTrajectory(
  traj: ReturnType<typeof normalizeCursor>,
): Promise<import('@primeradianthq/obol').CostEstimate> {
  const file = join(
    tmpdir(),
    `cursor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(file, JSON.stringify(traj), 'utf8');
  return estimatePath(file, 'atif');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.agent.name).toBe('cursor');
  expect(traj.agent.version).toBe('0.1.0');
});

test('session_id captured from system init event', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  expect(traj.session_id).toBe('session-abc');
});

test('model captured from system init event and set on traj.agent.model_name', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  expect(traj.agent.model_name).toBe('anthropic/claude-sonnet-4-5');
});

test('user and assistant steps have correct sources', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const sources = traj.steps.map((s) => s.source);
  expect(sources).toContain('user');
  expect(sources).toContain('agent');
});

test('user message content is set', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const userStep = traj.steps.find((s) => s.source === 'user');
  expect(userStep?.message).toBe('Hello, agent!');
});

test('assistant message content is set', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.message).toBe('I will help you.');
});

test('per-step metrics: prompt=inputTokens (exclusive of cache), cached=cacheReadTokens', () => {
  // inputTokens=100, cacheReadTokens=50, cacheWriteTokens=30, outputTokens=20
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  const m = agentStep!.metrics;
  expect(m).toBeDefined();
  expect(m!.prompt_tokens).toBe(100);
  expect(m!.completion_tokens).toBe(20);
  expect(m!.cached_tokens).toBe(50);
  // No final_metrics token totals (single-source rule)
  expect(traj.final_metrics).toBeUndefined();
});

test('cache_write goes to step.extra.cache_write (not metrics.extra)', () => {
  // cacheWriteTokens=30 in minimalLog
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep!.extra?.['cache_write']).toBe(30);
  // metrics.extra must NOT carry cache_write (obol ignores metrics.extra)
  expect(agentStep!.metrics?.extra?.['cache_write']).toBeUndefined();
});

test('step.model_name set on metrics-bearing agent step', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep!.model_name).toBe('anthropic/claude-sonnet-4-5');
});

test('single-source invariant: no final_metrics token totals', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  expect(traj.final_metrics?.total_prompt_tokens).toBeUndefined();
  expect(traj.final_metrics?.total_completion_tokens).toBeUndefined();
});

test('per-step metrics attached to agent step (not absent)', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.metrics).toBeDefined();
});

test('tool calls attached to the assistant step via model_call_id', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls && s.tool_calls.length > 0,
  );
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls).toHaveLength(2);
});

test('tool call observations are attached with source_call_id', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls && s.tool_calls.length > 0,
  );
  expect(agentStep!.observation).toBeDefined();
  const results = agentStep!.observation!.results;
  expect(results.length).toBeGreaterThanOrEqual(2);
  const callIds = new Set(agentStep!.tool_calls!.map((tc) => tc.tool_call_id));
  for (const r of results) {
    expect(callIds.has(r.source_call_id!)).toBe(true);
  }
});

test('started tool_call events are skipped (only completed carry args + result)', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  // tc-1 appears as both started and completed; it should appear exactly once
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls && s.tool_calls.length > 0,
  );
  const callIds = agentStep!.tool_calls!.map((tc) => tc.tool_call_id);
  const tcOneCount = callIds.filter((id) => id === 'tc-1').length;
  expect(tcOneCount).toBe(1);
});

test('maps all expected tool names in correct order', () => {
  const traj = normalizeCursor(toolMapLog, '0.1.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls && s.tool_calls.length > 0,
  );
  expect(agentStep).toBeDefined();
  const names = agentStep!.tool_calls!.map((tc) => tc.function_name);
  expect(names).toEqual([
    'Bash', // run_terminal_cmd
    'Read', // read_file
    'Edit', // edit_file
    'Write', // write_file
    'Glob', // list_dir
    'Grep', // grep_search
    'Glob', // file_search
    'WebSearch', // web_search
    'mark_done', // unknown → pass through unchanged
  ]);
});

test('observation content is the tool result string', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls && s.tool_calls.length > 0,
  );
  const obs = agentStep!.observation!;
  const bashResult = obs.results.find((r) => r.source_call_id === 'tc-1');
  expect(bashResult?.content).toContain('total 0');
});

test('null tool result maps to null content (ported from Harbor test_tool_call_result_preserves_plain_strings_and_none)', () => {
  const fixture = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'env',
      cwd: '/workspace',
      session_id: 'null-test',
      model: 'cursor/composer-2.5',
      permissionMode: 'default',
    }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'null-test',
      model_call_id: 'mcall-null',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
    }),
    JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tc-null',
      session_id: 'null-test',
      model_call_id: 'mcall-null',
      timestamp_ms: 1700000001000,
      tool_call: { mark_done: { args: {}, result: null } },
    }),
  ].join('\n');
  const traj = normalizeCursor(fixture, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  const result = agentStep!.observation!.results[0];
  expect(result?.content).toBeNull();
});

test('cost_usd passed through when totalCost is in the log', () => {
  const traj = normalizeCursor(costLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.metrics?.cost_usd).toBe(0.42);
});

test('no cost fabricated when totalCost is absent (no litellm/pricing)', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  // minimalLog usage has no totalCost/cost; we do not fabricate
  expect(
    traj.steps.find((s) => s.source === 'agent')?.metrics?.cost_usd,
  ).toBeUndefined();
});

test('multiple result events: each attaches to its preceding agent step', () => {
  // Turn 1: input=100, output=20, cacheRead=10, cacheWrite=5
  // Turn 2: input=200, output=30, cacheRead=20, cacheWrite=0
  const traj = normalizeCursor(multiResultLog, '0.1.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);
  const s1 = agentSteps[0]!;
  const s2 = agentSteps[1]!;
  expect(s1.metrics?.prompt_tokens).toBe(100);
  expect(s1.metrics?.completion_tokens).toBe(20);
  expect(s1.metrics?.cached_tokens).toBe(10);
  expect(s1.extra?.['cache_write']).toBe(5);
  expect(s2.metrics?.prompt_tokens).toBe(200);
  expect(s2.metrics?.completion_tokens).toBe(30);
  expect(s2.metrics?.cached_tokens).toBe(20);
  expect(s2.extra?.['cache_write']).toBeUndefined();
});

test('thinking blocks become reasoning_content on the following assistant step', () => {
  const traj = normalizeCursor(thinkingLog, '0.1.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.reasoning_content).toBe('First thought. Second thought.');
});

test('thinking blocks are cleared after being consumed by an assistant step', () => {
  const traj = normalizeCursor(thinkingLog, '0.1.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps).toHaveLength(1);
  // The single agent step should have the concatenated thinking
  expect(agentSteps[0]!.reasoning_content).toBe(
    'First thought. Second thought.',
  );
});

test('interaction_query events are skipped without crashing', () => {
  const traj = normalizeCursor(interactionQueryLog, '0.1.0');
  expect(traj.session_id).toBe('session-iq');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep?.message).toBe('Done.');
});

test('unknown event types are silently skipped', () => {
  const traj = normalizeCursor(unknownEventLog, '0.1.0');
  expect(traj.steps).toHaveLength(1);
  expect(traj.steps[0]?.message).toBe('Still here.');
});

test('tool_call with no preceding assistant message creates an implicit agent step', () => {
  const fixture = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'env',
      cwd: '/workspace',
      session_id: 'orphan-call',
      model: 'cursor/composer-2.5',
      permissionMode: 'default',
    }),
    JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tc-orphan',
      session_id: 'orphan-call',
      model_call_id: 'mcall-orphan',
      timestamp_ms: 1700000001000,
      tool_call: {
        run_terminal_cmd: { args: { command: 'ls' }, result: 'out' },
      },
    }),
  ].join('\n');
  const traj = normalizeCursor(fixture, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  const agentStep = traj.steps.find(
    (s) => s.source === 'agent' && s.tool_calls && s.tool_calls.length > 0,
  );
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls![0]!.function_name).toBe('Bash');
});

test('empty raw string returns a minimal valid trajectory', () => {
  const traj = normalizeCursor('', '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe('user');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  traj.steps.forEach((step, i) => {
    expect(step.step_id).toBe(i + 1);
  });
});

test('full trajectory validates as ATIF v1.7', () => {
  const traj = normalizeCursor(toolCallLog, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test('I2: multi-entry tool_call event assigns unique call_ids (no duplicate tool_call_id)', () => {
  // A single tool_call completed event with two entries in the dict
  const fixture = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'env',
      cwd: '/workspace',
      session_id: 'multi-entry',
      model: 'cursor/composer-2.5',
      permissionMode: 'default',
    }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'multi-entry',
      model_call_id: 'mcall-me',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    }),
    JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'shared-id',
      session_id: 'multi-entry',
      model_call_id: 'mcall-me',
      timestamp_ms: 1700000001000,
      tool_call: {
        run_terminal_cmd: { args: { command: 'ls' }, result: 'a' },
        read_file: { args: { target_file: 'x.ts' }, result: 'content' },
      },
    }),
  ].join('\n');
  const traj = normalizeCursor(fixture, '0.1.0');
  const r = validateTrajectory(traj);
  // Must not fail with "duplicate tool_call_id"
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  const callIds = agentStep!.tool_calls!.map((tc) => tc.tool_call_id);
  // Both ids must be distinct
  expect(new Set(callIds).size).toBe(callIds.length);
  expect(callIds[0]).toBe('shared-id');
  expect(callIds[1]).toBe('shared-id#1');
});

// ---------------------------------------------------------------------------
// I3: Pricing tests — prove obol prices the trajectory non-zero (C1 fix)
// and that cache_write is reflected in the cost (C2 fix).
// Note: 'anthropic/claude-sonnet-4-5' is NOT in obol's rate table (unpriced).
// These fixtures use 'claude-sonnet-4-5' (without provider prefix) which IS priced.
// ---------------------------------------------------------------------------

// Fixture with cache_write for pricing test (uses a priced model)
const pricingLogWith = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-price-with',
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Go.' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-price-with',
    model_call_id: 'mcall-pw',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'session-price-with',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 30, // cache_write present
    },
  }),
].join('\n');

// Same fixture but without cache_write
const pricingLogWithout = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'env',
    cwd: '/workspace',
    session_id: 'session-price-without',
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Go.' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-price-without',
    model_call_id: 'mcall-pwo',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'session-price-without',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0, // no cache_write
    },
  }),
].join('\n');

test('I3: traj.agent.model_name is set from the system init model field', () => {
  const traj = normalizeCursor(minimalLog, '0.1.0');
  // minimalLog uses 'anthropic/claude-sonnet-4-5'
  expect(traj.agent.model_name).toBe('anthropic/claude-sonnet-4-5');
});

test('I3: pricing via obol returns non-null, non-zero cost (model_name present)', async () => {
  // Uses claude-sonnet-4-5 (priced in obol's rate table)
  const traj = normalizeCursor(pricingLogWith, '0.1.0');
  expect(traj.agent.model_name).toBe('claude-sonnet-4-5');
  const est = await priceTrajectory(traj);
  expect(est).toBeDefined();
  // Should have at least one per_model entry with real tokens
  expect(est.per_model.length).toBeGreaterThan(0);
  const totalSubtotal = est.per_model.reduce(
    (sum, m) => sum + m.subtotal_usd,
    0,
  );
  expect(totalSubtotal).toBeGreaterThan(0);
});

test('I3: fixture WITH cacheWriteTokens produces more cost than fixture WITHOUT (cache_write is priced)', async () => {
  // Both use claude-sonnet-4-5 (priced). pricingLogWith has cacheWriteTokens=30;
  // pricingLogWithout has cacheWriteTokens=0. cache_write on step.extra is priced by obol.
  const trajWith = normalizeCursor(pricingLogWith, '0.1.0');
  const trajWithout = normalizeCursor(pricingLogWithout, '0.1.0');

  const [estWith, estWithout] = await Promise.all([
    priceTrajectory(trajWith),
    priceTrajectory(trajWithout),
  ]);

  const costWith = estWith.per_model.reduce((s, m) => s + m.subtotal_usd, 0);
  const costWithout = estWithout.per_model.reduce(
    (s, m) => s + m.subtotal_usd,
    0,
  );

  // cache_write on step.extra is priced by obol; costWith must exceed costWithout
  expect(costWith).toBeGreaterThan(costWithout);
});
