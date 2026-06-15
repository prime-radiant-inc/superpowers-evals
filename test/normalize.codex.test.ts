import { expect, test } from 'bun:test';
import { flattenToolCalls } from '../src/atif/project.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { isImplementationPath } from '../src/detect/implementation.ts';
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

test('spawn_agent maps to Agent', () => {
  const traj = normalizeCodex(spawnAgentLine, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Agent');
  expect(tc.arguments['task']).toBe('review the PR');
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
// delta. Codex rollout steps are tool-call steps with no turn/message
// structure, so the session total maps to final_metrics, not per-step metrics.
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

test('final cumulative token_count maps to final_metrics (reasoning folded into completion)', () => {
  const raw = [
    turnContextLine,
    tokenCountEarly,
    functionCallLine,
    tokenCountFinal,
  ].join('\n');
  const traj = normalizeCodex(raw, '1.0.0');
  expect(traj.final_metrics).toBeDefined();
  // prompt = input_tokens; completion = output + reasoning_output; cached.
  expect(traj.final_metrics!.total_prompt_tokens).toBe(378285);
  expect(traj.final_metrics!.total_completion_tokens).toBe(9437 + 4970);
  expect(traj.final_metrics!.extra?.['total_cached_tokens']).toBe(330752);
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
