import { expect, test } from 'bun:test';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeCopilot } from '../src/normalize/copilot.ts';

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

const basicLine = JSON.stringify({
  type: 'assistant.message',
  data: {
    toolRequests: [
      { name: 'skill', arguments: { skill: 'superpowers:brainstorming' } },
      { name: 'bash', arguments: { cmd: 'git status' } },
      {
        name: 'apply_patch',
        arguments: {
          patch:
            '*** Begin Patch\n*** Update File: src/app.py\n@@\n-old\n+new\n*** End Patch\n',
        },
      },
      { name: 'view', arguments: { file: 'README.md' } },
      { name: 'edit', arguments: { filePath: 'src/edit.py' } },
      { name: 'create', arguments: { path: 'src/new.py' } },
      { name: 'write', arguments: { file_path: 'src/write.py' } },
      { name: 'rg', arguments: { pattern: 'Skill' } },
      { name: 'glob', arguments: { pattern: '*.py' } },
      { name: 'task', arguments: { prompt: 'review' } },
      { name: 'read_agent', arguments: { agent: 'reviewer' } },
      { name: 'list_agents', arguments: {} },
      { name: 'write_agent', arguments: { agent: 'reviewer' } },
      { name: 'update_todo', arguments: { todos: [] } },
      { name: 'web_fetch', arguments: { url: 'https://example.test' } },
      { name: 'web_search', arguments: { query: 'quorum docs' } },
    ],
  },
});

const multiLineLine = [
  JSON.stringify({
    type: 'assistant.message',
    data: {
      toolRequests: [
        { name: 'bash', arguments: { command: 'pwd' } },
        { name: 'skill', arguments: { name: 'brainstorming' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant.message',
    data: {
      toolRequests: [
        { name: 'view', arguments: { path: 'README.md' } },
        { name: 'write', arguments: { file: 'notes.md' } },
      ],
    },
  }),
].join('\n');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'copilot', version: '1.0.0' });
});

test('maps all expected tool names in correct order', () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual([
    'Skill',
    'Bash',
    'Edit',
    'Read',
    'Edit',
    'Write',
    'Write',
    'Grep',
    'Glob',
    'Agent',
    'Agent',
    'Agent',
    'Agent',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
  ]);
});

test("skill with 'skill' arg: normalizes to superpowers:<name> and adds name field", () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  const skillStep = traj.steps[0]!;
  const tc = skillStep.tool_calls![0]!;
  expect(tc.function_name).toBe('Skill');
  expect(tc.arguments['skill']).toBe('superpowers:brainstorming');
  expect(tc.arguments['name']).toBe('brainstorming');
});

test("bash with 'cmd' arg: normalizes to 'command'", () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  const bashStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(bashStep).toBeDefined();
  expect(bashStep!.tool_calls![0]!.arguments['command']).toBe('git status');
});

test('apply_patch: extracts file_path from patch text', () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  const editStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === 'Edit' &&
      Array.isArray(s.tool_calls[0]?.arguments['file_paths']),
  );
  expect(editStep).toBeDefined();
  expect(editStep!.tool_calls![0]!.arguments['file_path']).toBe('src/app.py');
  expect(editStep!.tool_calls![0]!.arguments['file_paths']).toEqual([
    'src/app.py',
  ]);
});

test("view maps to Read with file_path extracted from 'file' key", () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(readStep).toBeDefined();
  expect(readStep!.tool_calls![0]!.arguments['file_path']).toBe('README.md');
});

test('raw_input is always included in arguments', () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  for (const step of traj.steps.filter((s) => s.source === 'agent')) {
    expect('raw_input' in step.tool_calls![0]!.arguments).toBe(true);
  }
});

// D-copilot-null-arguments-default (parity vs quorum/normalizers.py :738):
// request.get("arguments", {}) defaults to {} ONLY when the key is absent. A
// present-but-null `arguments` passes None through, so raw_input is null — not
// {}. (TS previously used `?? {}`, collapsing a present null to {}.)
test('present-but-null arguments yields raw_input: null (not {})', () => {
  const raw = JSON.stringify({
    type: 'assistant.message',
    data: { toolRequests: [{ name: 'bash', arguments: null }] },
  });
  const traj = normalizeCopilot(raw, '1.0.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Bash');
  expect(tc.arguments).toEqual({ raw_input: null });
});

test('multiple assistant.message lines: preserves order across messages', () => {
  const traj = normalizeCopilot(multiLineLine, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(['Bash', 'Skill', 'Read', 'Write']);
});

test("skill with 'name' arg (not 'skill'): normalizes correctly", () => {
  const traj = normalizeCopilot(multiLineLine, '1.0.0');
  const skillStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Skill',
  );
  expect(skillStep).toBeDefined();
  expect(skillStep!.tool_calls![0]!.arguments['skill']).toBe(
    'superpowers:brainstorming',
  );
  expect(skillStep!.tool_calls![0]!.arguments['name']).toBe('brainstorming');
});

test('ignores non-assistant.message events and bad JSON', () => {
  const raw = [
    'not json',
    JSON.stringify([]),
    JSON.stringify({ type: 'tool.execution_complete' }),
    JSON.stringify({
      type: 'assistant.message',
      data: { toolRequests: 'bad' },
    }),
    JSON.stringify({
      type: 'assistant.message',
      data: { toolRequests: [{ name: 'bash', arguments: { command: 'ls' } }] },
    }),
  ].join('\n');
  const traj = normalizeCopilot(raw, '1.0.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);
  expect(agentSteps[0]!.tool_calls![0]!.function_name).toBe('Bash');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeCopilot(multiLineLine, '1.0.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

// ---------------------------------------------------------------------------
// ATIF usage metrics (spec 2026-06-15-atif-usage-unification.md)
// Real shape from /tmp/quorum-live-results4/...-copilot-.../events.jsonl:
//   assistant.message carries `model` + `outputTokens` (a bare completion count;
//   copilot logs no per-message input/cache). The full breakdown lands only at
//   session shutdown: session.shutdown.modelMetrics.<model>.usage{inputTokens,
//   outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens} where
//   inputTokens INCLUDES cacheReadTokens; the non-cached prompt is
//   tokenDetails.input.tokenCount. Session totals → final_metrics + agent.model_name.
// ---------------------------------------------------------------------------

const usageLog = [
  JSON.stringify({
    type: 'assistant.message',
    data: {
      model: 'gpt-5.4',
      outputTokens: 234,
      toolRequests: [{ name: 'bash', arguments: { command: 'ls' } }],
    },
  }),
  JSON.stringify({
    type: 'assistant.message',
    data: {
      model: 'gpt-5.4',
      outputTokens: 55,
      toolRequests: [{ name: 'view', arguments: { file: 'README.md' } }],
    },
  }),
  JSON.stringify({
    type: 'session.shutdown',
    data: {
      currentModel: 'gpt-5.4',
      tokenDetails: {
        input: { tokenCount: 26055 },
        cache_read: { tokenCount: 58880 },
        output: { tokenCount: 571 },
      },
      modelMetrics: {
        'gpt-5.4': {
          usage: {
            inputTokens: 84935,
            outputTokens: 571,
            cacheReadTokens: 58880,
            cacheWriteTokens: 0,
            reasoningTokens: 422,
          },
        },
      },
    },
  }),
].join('\n');

test('assistant.message step carries model_name and completion_tokens from outputTokens', () => {
  const traj = normalizeCopilot(usageLog, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps[0]!.model_name).toBe('gpt-5.4');
  expect(agentSteps[0]!.metrics).toEqual({ completion_tokens: 234 });
  expect(agentSteps[1]!.model_name).toBe('gpt-5.4');
  expect(agentSteps[1]!.metrics).toEqual({ completion_tokens: 55 });
});

test('session.shutdown totals populate final_metrics and agent.model_name', () => {
  const traj = normalizeCopilot(usageLog, '1.0.0');
  // prompt = non-cached input (tokenDetails.input); cache-read carried in
  // final_metrics.extra (no top-level cached field). Completion is NOT carried
  // in final_metrics: it is already accounted per-step (data.outputTokens), so
  // putting it here too would double-count it when downstream sums step.metrics
  // + final_metrics.
  expect(traj.final_metrics).toEqual({
    total_prompt_tokens: 26055,
    extra: { total_cached_tokens: 58880 },
  });
  expect(traj.agent.model_name).toBe('gpt-5.4');
});

// Real shape from /tmp/quorum-live-results4/...-copilot-.../events.jsonl: four
// assistant.message rows (outputTokens 234, 267, 55, 15) — the last has an
// empty toolRequests array — and a shutdown with input 26055, cache_read 58880,
// output 571. The DISJOINT sum (prompt + cached + per-step completion) must
// equal the true session total, with NO completion double-count and NO dropped
// text-only-turn completion.
const realCopilotLog = [
  JSON.stringify({
    type: 'assistant.message',
    data: {
      model: 'gpt-5.4',
      outputTokens: 234,
      toolRequests: [{ name: 'bash', arguments: { command: 'a' } }],
    },
  }),
  JSON.stringify({
    type: 'assistant.message',
    data: {
      model: 'gpt-5.4',
      outputTokens: 267,
      toolRequests: [{ name: 'bash', arguments: { command: 'b' } }],
    },
  }),
  JSON.stringify({
    type: 'assistant.message',
    data: {
      model: 'gpt-5.4',
      outputTokens: 55,
      toolRequests: [{ name: 'view', arguments: { file: 'README.md' } }],
    },
  }),
  JSON.stringify({
    type: 'assistant.message',
    data: { model: 'gpt-5.4', outputTokens: 15, toolRequests: [] },
  }),
  JSON.stringify({
    type: 'session.shutdown',
    data: {
      currentModel: 'gpt-5.4',
      tokenDetails: {
        input: { tokenCount: 26055 },
        cache_read: { tokenCount: 58880 },
        output: { tokenCount: 571 },
      },
    },
  }),
].join('\n');

test('copilot disjoint buckets conserve the session total (no completion double-count, no dropped text-only turn)', () => {
  const traj = normalizeCopilot(realCopilotLog, '1.0.0');
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  for (const s of traj.steps) {
    if (s.metrics) {
      prompt += s.metrics.prompt_tokens ?? 0;
      completion += s.metrics.completion_tokens ?? 0;
      cached += s.metrics.cached_tokens ?? 0;
    }
    const cw = s.extra?.['cache_write'];
    if (typeof cw === 'number') cacheWrite += cw;
  }
  const fm = traj.final_metrics;
  if (fm) {
    prompt += fm.total_prompt_tokens ?? 0;
    completion += fm.total_completion_tokens ?? 0;
    const fc = fm.extra?.['total_cached_tokens'];
    if (typeof fc === 'number') cached += fc;
  }
  // Per-step completion must cover ALL output (234+267+55+15 = 571), including
  // the text-only final turn; the final_metrics must NOT also carry completion.
  expect(completion).toBe(571);
  // Full disjoint sum == prompt(26055) + cached(58880) + completion(571).
  expect(prompt + cached + completion + cacheWrite).toBe(85506);
});

test('copilot text-only assistant message keeps its completion (metrics-only step)', () => {
  const traj = normalizeCopilot(realCopilotLog, '1.0.0');
  const completions = traj.steps
    .map((s) => s.metrics?.completion_tokens)
    .filter((v): v is number => typeof v === 'number');
  // 15-token text-only turn (empty toolRequests) must contribute a step.
  expect(completions).toContain(15);
  expect(completions.reduce((a, b) => a + b, 0)).toBe(571);
});

test('logs without usage produce no metrics or final_metrics', () => {
  const traj = normalizeCopilot(basicLine, '1.0.0');
  expect(traj.final_metrics).toBeUndefined();
  expect(traj.agent.model_name).toBeUndefined();
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

test('multi-toolRequest message: completion_tokens attach to first step only (no double-count)', () => {
  const raw = JSON.stringify({
    type: 'assistant.message',
    data: {
      model: 'gpt-5.4',
      outputTokens: 99,
      toolRequests: [
        { name: 'bash', arguments: { command: 'a' } },
        { name: 'bash', arguments: { command: 'b' } },
      ],
    },
  });
  const traj = normalizeCopilot(raw, '1.0.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);
  expect(agentSteps[0]!.metrics).toEqual({ completion_tokens: 99 });
  expect(agentSteps[0]!.model_name).toBe('gpt-5.4');
  expect(agentSteps[1]!.metrics).toBeUndefined();
});
