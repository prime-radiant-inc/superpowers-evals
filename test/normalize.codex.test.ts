import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { flattenToolCalls } from '../src/atif/project.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { isImplementationPath } from '../src/detect/implementation.ts';
import { isSkillInvocation } from '../src/detect/skill.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';

test('codex apply_patch (function_call) exposes file paths for implementation-path checks', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'apply_patch',
      arguments: JSON.stringify({
        patch:
          '*** Begin Patch\n*** Update File: src/auth.js\n@@\n-old\n+new\n*** End Patch\n',
      }),
      call_id: 'c1',
    },
  });
  const traj = normalizeCodex(line, 'test');
  expect(validateTrajectory(traj).ok).toBe(true);
  const call = flattenToolCalls(traj).find((c) => c.tool === 'Edit')!;
  expect(call.args['file_path']).toBe('src/auth.js');
  expect(call.args['file_paths']).toEqual(['src/auth.js']);
  // The whole point: codex implementation edits are no longer invisible.
  expect(isImplementationPath(call)).toBe(true);
});

test('codex apply_patch (custom_tool_call) also exposes file paths', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'apply_patch',
      input:
        '*** Begin Patch\n*** Add File: src/new.ts\n+content\n*** End Patch\n',
      call_id: 'c2',
    },
  });
  const call = flattenToolCalls(normalizeCodex(line, 'test')).find(
    (c) => c.tool === 'Edit',
  )!;
  expect(call.args['file_path']).toBe('src/new.ts');
  expect(isImplementationPath(call)).toBe(true);
});

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

// Codex rollout format: response_item with payload.type = function_call
const functionCallLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({
      cmd: 'git worktree add .worktrees/feature',
      workdir: '/tmp',
    }),
    call_id: 'call_123',
  },
});

const applyPatchLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'apply_patch',
    arguments: JSON.stringify({ patch: '--- a/file\n+++ b/file' }),
    call_id: 'call_456',
  },
});

const spawnAgentLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'spawn_agent',
    arguments: JSON.stringify({ task: 'review the PR' }),
    call_id: 'call_1',
  },
});

const waitAgentLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'wait_agent',
    arguments: '{}',
    call_id: 'call_2',
  },
});

const closeAgentLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'close_agent',
    arguments: '{}',
    call_id: 'call_3',
  },
});

// custom_tool_call variant (current Codex runs)
const customApplyPatchLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'apply_patch',
    input:
      '*** Begin Patch\n*** Add File: foo.go\n+package main\n*** End Patch\n',
    call_id: 'call_4',
  },
});

// local_shell_call variant (as produced in test_normalizers.py item key form)
const localShellLine = JSON.stringify({
  type: 'response_item',
  item: {
    type: 'local_shell_call',
    action: { command: ['git', 'worktree', 'add', 'feature'] },
    status: 'completed',
  },
});

const raw2Lines = [functionCallLine, applyPatchLine].join('\n');
const rawFull = [functionCallLine, applyPatchLine, customApplyPatchLine].join(
  '\n',
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeCodex(raw2Lines, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'codex', version: '1.0.0' });
});

test('exec_command maps to Bash with args.command from cmd field', () => {
  const traj = normalizeCodex(functionCallLine, '1.0.0');
  const step = traj.steps.find((s) => s.source === 'agent');
  expect(step).toBeDefined();
  const tc = step!.tool_calls![0]!;
  expect(tc.function_name).toBe('Bash');
  expect(tc.arguments['command']).toBe('git worktree add .worktrees/feature');
});

test('apply_patch (function_call) maps to Edit', () => {
  const traj = normalizeCodex(applyPatchLine, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Edit');
  expect(typeof tc.arguments['patch']).toBe('string');
});

test('spawn_agent maps to Agent and canonicalizes the task arg to prompt', () => {
  const traj = normalizeCodex(spawnAgentLine, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Agent');
  // ATIF arguments are free-form; we canonicalize the dispatch instruction to
  // `prompt` (the key claude/gemini/etc. already use) so cross-harness
  // transcript checks (`tool-arg-match Agent --matches prompt=…`) are portable.
  expect(tc.arguments['prompt']).toBe('review the PR');
  expect(tc.arguments['task']).toBeUndefined();
});

test('wait_agent and close_agent are kept verbatim (not aliased)', () => {
  const traj = normalizeCodex(
    [waitAgentLine, closeAgentLine].join('\n'),
    '1.0.0',
  );
  const names = traj.steps.map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(['wait_agent', 'close_agent']);
});

test('apply_patch (custom_tool_call) maps to Edit with patch string', () => {
  const traj = normalizeCodex(customApplyPatchLine, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Edit');
  expect(typeof tc.arguments['patch']).toBe('string');
  expect(String(tc.arguments['patch'])).toContain('Begin Patch');
});

test('local_shell_call maps to Bash with joined command string', () => {
  const traj = normalizeCodex(localShellLine, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Bash');
  expect(String(tc.arguments['command'])).toContain('git worktree add');
});

test('non-response_item lines are ignored', () => {
  const raw = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp' } }),
    JSON.stringify({
      type: 'response_item',
      item: { type: 'message', content: [] },
    }),
    functionCallLine,
  ].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const agentSteps = traj.steps.filter(
    (s) => s.source === 'agent' && s.tool_calls?.length,
  );
  expect(agentSteps.length).toBe(1);
  expect(agentSteps[0]!.tool_calls![0]!.function_name).toBe('Bash');
});

test('tolerates blank lines and unparseable JSON', () => {
  const raw = `\n{not json}\n${functionCallLine}\n`;
  const traj = normalizeCodex(raw, '1.0.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeCodex(rawFull, '1.0.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test('each tool call gets its own step', () => {
  const traj = normalizeCodex(raw2Lines, '1.0.0');
  expect(traj.steps.length).toBe(2);
});

// ---------------------------------------------------------------------------
// ATIF usage metrics (spec: 2026-06-15-atif-usage-unification.md)
// ---------------------------------------------------------------------------

// Codex rollout token usage lives in event_msg rows with payload.type
// "token_count". info.total_token_usage is the running session cumulative;
// the LAST one is the session total. info.last_token_usage is the per-turn
// delta. The session total is recorded both as final_metrics AND on the last
// agent step (per-step metrics tagged with the session model) so a merged
// multi-session run prices per-model — see the per-step test below.
const tokenCountEarly = JSON.stringify({
  timestamp: '2026-06-13T17:31:26.732Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 15175,
        cached_input_tokens: 3456,
        output_tokens: 188,
        reasoning_output_tokens: 66,
        total_tokens: 15363,
      },
      last_token_usage: {
        input_tokens: 15175,
        cached_input_tokens: 3456,
        output_tokens: 188,
        reasoning_output_tokens: 66,
        total_tokens: 15363,
      },
    },
  },
});

const tokenCountFinal = JSON.stringify({
  timestamp: '2026-06-13T17:34:19.825Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 378285,
        cached_input_tokens: 330752,
        output_tokens: 9437,
        reasoning_output_tokens: 4970,
        total_tokens: 387722,
      },
      last_token_usage: {
        input_tokens: 44017,
        cached_input_tokens: 39808,
        output_tokens: 1530,
        reasoning_output_tokens: 1034,
        total_tokens: 45547,
      },
    },
  },
});

const turnContextLine = JSON.stringify({
  timestamp: '2026-06-13T17:31:23.141Z',
  type: 'turn_context',
  payload: { model: 'gpt-5.5', effort: 'high' },
});

test('final cumulative token_count maps to final_metrics (reasoning already inside output)', () => {
  const raw = [
    turnContextLine,
    tokenCountEarly,
    functionCallLine,
    tokenCountFinal,
  ].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  expect(traj.final_metrics).toBeDefined();
  // ATIF buckets are DISJOINT: codex input_tokens INCLUDES cached, so prompt =
  // UNCACHED input (input − cached); cached rides in extra.
  expect(traj.final_metrics!.total_prompt_tokens).toBe(378285 - 330752);
  // QUIRK (verified against real rollout 2026-06-13): codex output_tokens ALREADY
  // INCLUDES reasoning_output_tokens (total_tokens == input + output, and
  // reasoning <= output in every row). So completion = output_tokens; folding
  // reasoning in again double-counts it. completion is NOT output + reasoning.
  expect(traj.final_metrics!.total_completion_tokens).toBe(9437);
  expect(traj.final_metrics!.extra?.['total_cached_tokens']).toBe(330752);
});

test('codex disjoint buckets conserve the log total (no reasoning double-count)', () => {
  // Real rollout invariant: total_tokens == input_tokens + output_tokens, with
  // cached ⊂ input and reasoning ⊂ output. The DISJOINT ATIF sum
  // (prompt + cached + completion) must equal the log's own total_tokens.
  const raw = [turnContextLine, tokenCountFinal].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const fm = traj.final_metrics!;
  const prompt = fm.total_prompt_tokens ?? 0;
  const completion = fm.total_completion_tokens ?? 0;
  const cached = (fm.extra?.['total_cached_tokens'] as number | undefined) ?? 0;
  expect(prompt + cached + completion).toBe(387722); // == log total_tokens
});

test('agent.model_name comes from turn_context.payload.model', () => {
  const raw = [turnContextLine, functionCallLine, tokenCountFinal].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  expect(traj.agent.model_name).toBe('gpt-5.5');
});

test('no total_cost_usd (codex rollout logs no cost; priced downstream)', () => {
  const raw = [tokenCountFinal].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  expect(traj.final_metrics?.total_cost_usd).toBeUndefined();
});

test('no token_count events => no final_metrics, no model_name', () => {
  const traj = normalizeCodex(functionCallLine, '1.0.0');
  expect(traj.final_metrics).toBeUndefined();
  expect(traj.agent.model_name).toBeUndefined();
});

// Codex spawns each subagent as its OWN rollout file, and capture merges every
// session's steps into one trajectory. obol's atif dialect prices per-step
// metrics when present (and only falls back to final_metrics when no step
// carries usage), so the session total must ALSO ride on a step tagged with the
// session model — otherwise a merged multi-session run collapses every
// subagent's tokens onto the orchestrator's single envelope model.
test('session usage rides on the last agent step tagged with the session model', () => {
  const raw = [turnContextLine, functionCallLine, tokenCountFinal].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const metricSteps = traj.steps.filter((s) => s.metrics !== undefined);
  expect(metricSteps).toHaveLength(1);
  const s = metricSteps[0]!;
  expect(s.source).toBe('agent');
  expect(s.model_name).toBe('gpt-5.5');
  // Same disjoint buckets as final_metrics: prompt = uncached input.
  expect(s.metrics!.prompt_tokens).toBe(378285 - 330752);
  expect(s.metrics!.completion_tokens).toBe(9437);
  expect(s.metrics!.cached_tokens).toBe(330752);
});

// ---------------------------------------------------------------------------
// Full-fidelity adds: messages, reasoning, observations, web_search_call,
// session_id, agent.version, agent.extra
// ---------------------------------------------------------------------------

// session_meta event — real format from rollout logs
const sessionMetaLine = JSON.stringify({
  timestamp: '2026-06-16T05:26:32.929Z',
  type: 'session_meta',
  payload: {
    id: 'session-abc-123',
    cwd: '/workspace/proj',
    originator: 'codex-tui',
    cli_version: '0.140.0',
    git: { branch: 'main' },
    instructions: 'You are a coding agent.',
  },
});

test('session_meta populates session_id, agent.version, and agent.extra', () => {
  const raw = [sessionMetaLine, functionCallLine].join('\n');
  const traj = normalizeCodex(raw, 'fallback-ver');
  expect(traj.session_id).toBe('session-abc-123');
  expect(traj.agent.version).toBe('0.140.0');
  expect(traj.agent.extra).toBeDefined();
  expect(traj.agent.extra!['cwd']).toBe('/workspace/proj');
  expect(traj.agent.extra!['originator']).toBe('codex-tui');
  expect(traj.agent.extra!['git']).toEqual({ branch: 'main' });
  expect(traj.agent.extra!['instructions']).toBe('You are a coding agent.');
});

test('agent.version falls back to passed version when cli_version absent', () => {
  const metaNoVersion = JSON.stringify({
    type: 'session_meta',
    payload: { id: 'sid-1', cwd: '/tmp' },
  });
  const traj = normalizeCodex(
    [metaNoVersion, functionCallLine].join('\n'),
    'v1.2.3',
  );
  expect(traj.agent.version).toBe('v1.2.3');
  expect(traj.session_id).toBe('sid-1');
});

// message events
const userMessageLine = JSON.stringify({
  timestamp: '2026-06-16T05:26:32.966Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Let’s make a react todo list' }],
  },
});

const assistantMessageLine = JSON.stringify({
  timestamp: '2026-06-16T05:26:34.793Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Using brainstorming first.' }],
  },
});

const developerMessageLine = JSON.stringify({
  timestamp: '2026-06-16T05:26:32.965Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'system prompt text' }],
  },
});

test('response_item:message (user) becomes a user step with message text', () => {
  const traj = normalizeCodex(userMessageLine, '1.0.0');
  const step = traj.steps.find((s) => s.source === 'user');
  expect(step).toBeDefined();
  expect(step!.message).toBe('Let’s make a react todo list');
});

test('response_item:message (assistant) becomes an agent step with message text', () => {
  const traj = normalizeCodex(assistantMessageLine, '1.0.0');
  const step = traj.steps.find((s) => s.source === 'agent');
  expect(step).toBeDefined();
  expect(step!.message).toBe('Using brainstorming first.');
  expect(step!.tool_calls).toBeUndefined();
});

test('response_item:message (developer) becomes a system step', () => {
  const traj = normalizeCodex(developerMessageLine, '1.0.0');
  const step = traj.steps.find((s) => s.source === 'system');
  expect(step).toBeDefined();
  expect(step!.message).toBe('system prompt text');
});

test('message steps are emitted before tool steps when interleaved', () => {
  const raw = [userMessageLine, functionCallLine, assistantMessageLine].join(
    '\n',
  );
  const traj = normalizeCodex(raw, '1.0.0');
  const sources = traj.steps.map((s) => s.source);
  expect(sources[0]).toBe('user');
  expect(sources[1]).toBe('agent'); // tool call (function_call)
  expect(sources[2]).toBe('agent'); // message
});

// reasoning events — real traces have summary:[] with substance in encrypted_content
const reasoningLine = JSON.stringify({
  timestamp: '2026-06-16T05:26:59.398Z',
  type: 'response_item',
  payload: {
    type: 'reasoning',
    summary: [],
    encrypted_content: 'gAAAAA...',
  },
});

const reasoningWithSummaryLine = JSON.stringify({
  timestamp: '2026-06-16T05:26:59.000Z',
  type: 'response_item',
  payload: {
    type: 'reasoning',
    summary: ['First thought.', 'Second thought.'],
  },
});

test('reasoning with empty summary produces null reasoning_content on next step', () => {
  // summary:[] (encrypted_content only) → Harbor emits None → we emit undefined
  const raw = [reasoningLine, assistantMessageLine].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  expect(agentStep!.reasoning_content).toBeUndefined();
});

test('reasoning with non-empty summary attaches reasoning_content to next assistant step', () => {
  const raw = [reasoningWithSummaryLine, assistantMessageLine].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  expect(agentStep!.reasoning_content).toBe('First thought.\nSecond thought.');
});

test('reasoning is carried forward to next tool-call step too', () => {
  const raw = [reasoningWithSummaryLine, functionCallLine].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const toolStep = traj.steps.find((s) => s.tool_calls?.length);
  expect(toolStep).toBeDefined();
  expect(toolStep!.reasoning_content).toBe('First thought.\nSecond thought.');
});

test('reasoning is cleared after being attached to a step', () => {
  // reasoning → tool_call → another tool_call: only the first tool gets reasoning
  const secondCallLine = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'ls', workdir: '/' }),
      call_id: 'call_second',
    },
  });
  const raw = [reasoningWithSummaryLine, functionCallLine, secondCallLine].join(
    '\n',
  );
  const traj = normalizeCodex(raw, '1.0.0');
  const [first, second] = traj.steps.filter((s) => s.tool_calls?.length);
  expect(first!.reasoning_content).toBe('First thought.\nSecond thought.');
  expect(second!.reasoning_content).toBeUndefined();
});

// observations — function_call_output paired to call by call_id
const callId = 'call_zdg6vGxF';
const functionCallWithIdLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'git status', workdir: '/workspace' }),
    call_id: callId,
  },
});

const functionCallOutputLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: callId,
    output: 'On branch main\nnothing to commit',
  },
});

test('function_call_output is attached as observation on the call step', () => {
  const raw = [functionCallWithIdLine, functionCallOutputLine].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  // Should produce exactly 1 step (output merges into the call)
  expect(traj.steps.length).toBe(1);
  const step = traj.steps[0]!;
  expect(step.tool_calls![0]!.function_name).toBe('Bash');
  expect(step.observation).toBeDefined();
  expect(step.observation!.results[0]!.source_call_id).toBe(callId);
  expect(step.observation!.results[0]!.content).toContain('On branch main');
});

test('function_call_output output parsed as JSON blob (output key)', () => {
  const outputWithMeta = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({
        output: 'file contents here',
        metadata: { size: 42 },
      }),
    },
  });
  const raw = [functionCallWithIdLine, outputWithMeta].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  const step = traj.steps[0]!;
  expect(step.observation!.results[0]!.content).toBe('file contents here');
});

test('orphan function_call_output (no matching call) creates its own step', () => {
  // Output arrives before or without the call — should not crash, creates a step
  const raw = functionCallOutputLine;
  const traj = normalizeCodex(raw, '1.0.0');
  expect(traj.steps.length).toBeGreaterThan(0);
  // The orphan step has an observation
  const stepWithObs = traj.steps.find((s) => s.observation);
  expect(stepWithObs).toBeDefined();
});

// custom_tool_call_output paired by call_id
const customCallId = 'call_custom_1';
const customToolCallLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'apply_patch',
    input: '*** Begin Patch\n*** Add File: foo.ts\n+hello\n*** End Patch\n',
    call_id: customCallId,
  },
});
const customToolCallOutputLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    call_id: customCallId,
    output: 'Patch applied successfully',
  },
});

test('custom_tool_call_output is attached as observation on the custom call step', () => {
  const raw = [customToolCallLine, customToolCallOutputLine].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  expect(traj.steps.length).toBe(1);
  const step = traj.steps[0]!;
  expect(step.tool_calls![0]!.function_name).toBe('Edit');
  expect(step.observation).toBeDefined();
  expect(step.observation!.results[0]!.content).toBe(
    'Patch applied successfully',
  );
});

test('repeated output for same call_id is handled gracefully (idempotency)', () => {
  const raw = [
    functionCallWithIdLine,
    functionCallOutputLine,
    functionCallOutputLine,
  ].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  // Should not crash; first output wins (or second is attached gracefully)
  expect(validateTrajectory(traj).ok).toBe(true);
});

// web_search_call
const webSearchCallLine = JSON.stringify({
  timestamp: '2026-06-16T05:30:00.000Z',
  type: 'response_item',
  payload: {
    type: 'web_search_call',
    action: {
      type: 'search',
      query: 'react todo list typescript',
    },
    status: 'completed',
  },
});

test('web_search_call payload becomes a tool-call step with WebSearch function_name', () => {
  const traj = normalizeCodex(webSearchCallLine, '1.0.0');
  const step = traj.steps.find((s) => s.tool_calls?.length);
  expect(step).toBeDefined();
  expect(step!.tool_calls![0]!.function_name).toBe('WebSearch');
  expect(step!.tool_calls![0]!.arguments['action_type']).toBe('search');
  expect(step!.tool_calls![0]!.arguments['query']).toBe(
    'react todo list typescript',
  );
});

test('web_search_call with url action type', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'web_search_call',
      action: { type: 'open_url', url: 'https://react.dev' },
    },
  });
  const traj = normalizeCodex(line, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('WebSearch');
  expect(tc.arguments['action_type']).toBe('open_url');
  expect(tc.arguments['url']).toBe('https://react.dev');
});

test('full trajectory with all new features validates against ATIF schema', () => {
  const raw = [
    sessionMetaLine,
    turnContextLine,
    userMessageLine,
    reasoningWithSummaryLine,
    functionCallWithIdLine,
    functionCallOutputLine,
    assistantMessageLine,
    webSearchCallLine,
    tokenCountFinal,
  ].join('\n');
  const traj = normalizeCodex(raw, 'fallback');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.session_id).toBe('session-abc-123');
  expect(traj.agent.version).toBe('0.140.0');
});

// ---------------------------------------------------------------------------
// codex ≥0.144 driving the gpt-5.6 family: ALL tool use arrives as one custom
// tool named `exec` whose input is a JavaScript program invoking
// tools.exec_command / tools.apply_patch / tools.update_plan / … (PRI-2584).
// The normalizer must unpack those into the same canonical calls the 5.5-era
// function_call rollouts produce, or every transcript verb goes blind.
// ---------------------------------------------------------------------------

function execScriptLine(input: string, callId = 'exec-1'): string {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', input, call_id: callId },
  });
}

test('56-exec: plain-literal exec_command surfaces the exact cmd as Bash', () => {
  const traj = normalizeCodex(
    execScriptLine(
      'const r=await tools.exec_command({cmd:"npm test",workdir:"/w",yield_time_ms:10000});\ntext(r.output);\n',
    ),
    'test',
  );
  expect(validateTrajectory(traj).ok).toBe(true);
  const call = flattenToolCalls(traj).find((c) => c.tool === 'Bash')!;
  expect(call.args['command']).toBe('npm test');
});

test('56-exec: template-literal cmd keeps the whole segment so variable-referenced skill paths stay visible', () => {
  const input =
    'const p="/x/skills/writing-plans/SKILL.md";\n' +
    "const r=await tools.exec_command({cmd:`sed -n '1,320p' '" +
    '${p}' +
    '\'`,workdir:"/w"});\ntext(r.output);\n';
  const call = flattenToolCalls(
    normalizeCodex(execScriptLine(input), 'test'),
  ).find((c) => c.tool === 'Bash')!;
  expect(
    isSkillInvocation(call, 'superpowers:writing-plans', 'writing-plans'),
  ).toBe(true);
});

test('56-exec: multiple tools.* invocations unpack into ordered canonical calls in one step', () => {
  const input =
    'const r=await tools.exec_command({cmd:"git status"});\n' +
    'await tools.update_plan({plan:[{step:"a",status:"in_progress"}]});\n';
  const traj = normalizeCodex(execScriptLine(input, 'multi-1'), 'test');
  const step = traj.steps.find((s) => s.tool_calls)!;
  expect(step.tool_calls?.map((c) => c.function_name)).toEqual([
    'Bash',
    'update_plan',
  ]);
  // First sub-call keeps the rollout call_id (outputs pair to it); later
  // sub-calls get derived unique ids.
  expect(step.tool_calls?.[0]?.tool_call_id).toBe('multi-1');
  expect(step.tool_calls?.[1]?.tool_call_id).toBe('multi-1#1');
});

test('56-exec: apply_patch with the patch in a JS variable exposes file paths', () => {
  const input =
    'const patch = `*** Begin Patch\n*** Update File: src/auth.js\n@@\n-a\n+b\n*** End Patch`;\n' +
    'await tools.apply_patch(patch);\n';
  const call = flattenToolCalls(
    normalizeCodex(execScriptLine(input), 'test'),
  ).find((c) => c.tool === 'Edit')!;
  expect(call.args['file_path']).toBe('src/auth.js');
  expect(isImplementationPath(call)).toBe(true);
});

test('56-exec: apply_patch with an escaped string literal still yields paths', () => {
  const input =
    'await tools.apply_patch("*** Begin Patch\\n*** Add File: hello.txt\\n+hi\\n*** End Patch");\n';
  const call = flattenToolCalls(
    normalizeCodex(execScriptLine(input), 'test'),
  ).find((c) => c.tool === 'Edit')!;
  expect(call.args['file_path']).toBe('hello.txt');
});

test('56-exec: JS with no tools.* falls back to one Bash call carrying the input', () => {
  const input = 'const x = 1 + 1;\ntext(String(x));\n';
  const calls = flattenToolCalls(normalizeCodex(execScriptLine(input), 'test'));
  expect(calls.map((c) => c.tool)).toEqual(['Bash']);
  expect(calls[0]?.args['command']).toBe(input);
});

test('56-exec: custom_tool_call_output pairs onto the exec step', () => {
  const raw = [
    execScriptLine('await tools.exec_command({cmd:"ls"});', 'pair-1'),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'pair-1',
        output: 'ok',
      },
    }),
  ].join('\n');
  const traj = normalizeCodex(raw, 'test');
  const step = traj.steps.find((s) => s.tool_calls)!;
  expect(step.observation?.results[0]?.source_call_id).toBe('pair-1');
  expect(step.observation?.results[0]?.content).toBe('ok');
});

test('56-exec: every unpacked call carries the composite provenance convention in extra', () => {
  const input =
    'const r=await tools.exec_command({cmd:"npm test",workdir:"/w"});\n' +
    'await tools.update_plan({plan:[{step:"a",status:"in_progress"}]});\ntext(r.output);\n';
  const traj = normalizeCodex(execScriptLine(input, 'prov-1'), 'test');
  const step = traj.steps.find((s) => s.tool_calls)!;
  const [bash, plan] = step.tool_calls!;
  // Physical grouping is machine-recoverable: both sub-calls name the rollout
  // call that actually executed.
  expect(bash?.extra?.['composite_call_id']).toBe('prov-1');
  expect(plan?.extra?.['composite_call_id']).toBe('prov-1');
  // Verbatim-script fidelity: the exact JS segment that produced each call,
  // even when the command was extracted to a plain literal.
  expect(bash?.arguments['command']).toBe('npm test');
  expect(String(bash?.extra?.['script'])).toContain('workdir:"/w"');
  expect(String(plan?.extra?.['script'])).toContain('tools.update_plan');
  expect(String(plan?.extra?.['script'])).not.toContain('exec_command');
});

test('56-exec: the no-verb fallback call is also stamped with provenance', () => {
  const input = 'const x = 1 + 1;\ntext(String(x));\n';
  const traj = normalizeCodex(execScriptLine(input, 'prov-2'), 'test');
  const call = traj.steps.find((s) => s.tool_calls)!.tool_calls![0]!;
  expect(call.extra?.['composite_call_id']).toBe('prov-2');
  expect(call.extra?.['script']).toBe(input);
});

test('56-exec: real gpt-5.6-sol rollout slice — skill read via JS variable is detected', () => {
  const raw = readFileSync(
    new URL('./fixtures/codex-56-exec.slice.jsonl', import.meta.url),
    'utf8',
  );
  const traj = normalizeCodex(raw, 'fallback');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.agent.model_name).toBe('gpt-5.6-sol');
  const calls = flattenToolCalls(traj);
  expect(
    calls.some((c) =>
      isSkillInvocation(c, 'superpowers:writing-plans', 'writing-plans'),
    ),
  ).toBe(true);
  expect(calls.some((c) => c.tool === 'update_plan')).toBe(true);
  // The whole point of PRI-2584: no raw `exec` calls survive normalization.
  expect(calls.some((c) => c.tool === 'exec')).toBe(false);
});
