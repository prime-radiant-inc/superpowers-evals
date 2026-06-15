import { expect, test } from 'bun:test';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeOpencode } from '../src/normalize/opencode.ts';

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

const basicExport = {
  info: { id: 'ses_1', directory: '/tmp/project' },
  messages: [
    {
      info: { role: 'assistant' },
      parts: [
        { type: 'step-start' }, // non-tool part, should be ignored
        {
          type: 'tool',
          tool: 'skill',
          state: { status: 'completed', input: { name: 'brainstorming' } },
        },
        {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'git status' } },
        },
        {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            input: { subagent_type: 'general', prompt: 'review' },
          },
        },
      ],
    },
  ],
};

const allToolsExport = {
  messages: [
    {
      parts: [
        { type: 'tool', tool: 'read', state: { input: { file: 'README.md' } } },
        {
          type: 'tool',
          tool: 'write',
          state: { input: { path: 'app.py', content: 'x' } },
        },
        {
          type: 'tool',
          tool: 'edit',
          state: { input: { filePath: 'src/app.py' } },
        },
        {
          type: 'tool',
          tool: 'apply_patch',
          state: {
            input: {
              patch:
                '*** Begin Patch\n*** Update File: src/app.py\n@@\n-old\n+new\n*** End Patch\n',
            },
          },
        },
        { type: 'tool', tool: 'grep', state: { input: { pattern: 'Skill' } } },
        { type: 'tool', tool: 'glob', state: { input: { pattern: '*.py' } } },
        { type: 'tool', tool: 'todowrite', state: { input: { todos: [] } } },
        {
          type: 'tool',
          tool: 'webfetch',
          state: { input: { url: 'https://example.com' } },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), '0.5.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'opencode', version: '0.5.0' });
});

test('skill maps to Skill with superpowers namespace and name field', () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), '0.5.0');
  const skillStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Skill',
  );
  expect(skillStep).toBeDefined();
  const tc = skillStep!.tool_calls![0]!;
  expect(tc.arguments['skill']).toBe('superpowers:brainstorming');
  expect(tc.arguments['name']).toBe('brainstorming');
});

test('bash maps to Bash with command field', () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), '0.5.0');
  const bashStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(bashStep).toBeDefined();
  expect(bashStep!.tool_calls![0]!.arguments['command']).toBe('git status');
});

test('task maps to Agent', () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), '0.5.0');
  const agentStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Agent',
  );
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls![0]!.arguments['prompt']).toBe('review');
});

test('maps all expected tool names', () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual([
    'Read',
    'Write',
    'Edit',
    'Edit',
    'Grep',
    'Glob',
    'TodoWrite',
    'WebFetch',
  ]);
});

test("read with 'file' key: extracts file_path", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(readStep!.tool_calls![0]!.arguments['file_path']).toBe('README.md');
});

test("write with 'path' key: extracts file_path", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  const writeStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Write',
  );
  expect(writeStep!.tool_calls![0]!.arguments['file_path']).toBe('app.py');
});

test("edit with 'filePath' key: extracts file_path", () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  const editSteps = traj.steps.filter(
    (s) => s.tool_calls?.[0]?.function_name === 'Edit',
  );
  // First edit is from "edit" tool, second from "apply_patch"
  expect(editSteps[0]!.tool_calls![0]!.arguments['file_path']).toBe(
    'src/app.py',
  );
});

test('apply_patch: extracts file_path and file_paths from patch text', () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  const patchStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === 'Edit' &&
      Array.isArray(s.tool_calls[0]?.arguments['file_paths']),
  );
  expect(patchStep).toBeDefined();
  expect(patchStep!.tool_calls![0]!.arguments['file_path']).toBe('src/app.py');
  expect(patchStep!.tool_calls![0]!.arguments['file_paths']).toEqual([
    'src/app.py',
  ]);
});

test('raw_input is always included in arguments', () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  for (const step of traj.steps.filter((s) => s.source === 'agent')) {
    expect('raw_input' in step.tool_calls![0]!.arguments).toBe(true);
  }
});

test('non-tool parts (step-start, text) are ignored', () => {
  const traj = normalizeOpencode(JSON.stringify(basicExport), '0.5.0');
  // basicExport has 1 step-start + 3 tool parts; should be 3 agent steps
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(3);
});

test('invalid JSON returns empty trajectory with user step placeholder', () => {
  const traj = normalizeOpencode('not json', '0.5.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe('user');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeOpencode(JSON.stringify(allToolsExport), '0.5.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

// ---------------------------------------------------------------------------
// ATIF usage metrics (spec: 2026-06-15-atif-usage-unification.md)
//
// OpenCode stamps per-assistant-message usage on `messages[].info`:
// tokens{input,output,reasoning,cache{read,write}} + modelID + providerID + a
// per-message `cost`. Field mapping: input→prompt_tokens, output+reasoning
// folded→completion_tokens, cache.read→cached_tokens, cost→cost_usd. providerID
// →extra.provider; cache.write→extra.cache_write. model→step.model_name.
// ---------------------------------------------------------------------------

// Real-shaped fixture from a live opencode run (gpt-5.5 / openai):
// - msg 0: user (no usage)
// - msg 1: assistant, glob tool, cost 0.05241, cache.read 0, cache.write 0
// - msg 2: assistant, apply_patch tool, cost 0.007978, cache.read 9216
// - msg 3: assistant, text-only final answer, cost 0.007598, cache.read 9216
const usageExport = {
  info: { id: 'ses_1', directory: '/tmp/p' },
  messages: [
    {
      info: {
        role: 'user',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
      },
    },
    {
      info: {
        role: 'assistant',
        modelID: 'gpt-5.5',
        providerID: 'openai',
        cost: 0.05241,
        tokens: {
          total: 9667,
          input: 9504,
          output: 57,
          reasoning: 106,
          cache: { write: 0, read: 0 },
        },
      },
      parts: [
        { type: 'step-start' },
        {
          type: 'tool',
          tool: 'glob',
          state: { input: { pattern: 'hello.txt' } },
        },
      ],
    },
    {
      info: {
        role: 'assistant',
        modelID: 'gpt-5.5',
        providerID: 'openai',
        cost: 0.007978,
        tokens: {
          total: 9715,
          input: 464,
          output: 35,
          reasoning: 0,
          cache: { write: 12, read: 9216 },
        },
      },
      parts: [
        {
          type: 'tool',
          tool: 'apply_patch',
          state: {
            input: {
              patchText:
                '*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch',
            },
          },
        },
      ],
    },
    {
      info: {
        role: 'assistant',
        modelID: 'gpt-5.5',
        providerID: 'openai',
        cost: 0.007598,
        tokens: {
          total: 9749,
          input: 520,
          output: 13,
          reasoning: 0,
          cache: { write: 0, read: 9216 },
        },
      },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Created hello.txt containing hi.' },
      ],
    },
  ],
};

test('usage: maps opencode tokens + cost onto the tool-call step metrics', () => {
  const traj = normalizeOpencode(JSON.stringify(usageExport), '0.5.0');
  expect(validateTrajectory(traj).ok).toBe(true);

  const globStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Glob',
  );
  expect(globStep).toBeDefined();
  expect(globStep!.metrics).toEqual({
    prompt_tokens: 9504,
    completion_tokens: 57 + 106,
    cached_tokens: 0,
    cost_usd: 0.05241,
  });
  expect(globStep!.model_name).toBe('gpt-5.5');
  expect(globStep!.extra?.['provider']).toBe('openai');
});

test('usage: opencode folds reasoning into completion and cache.read into cached', () => {
  const traj = normalizeOpencode(JSON.stringify(usageExport), '0.5.0');
  const patchStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Edit',
  );
  expect(patchStep!.metrics).toEqual({
    prompt_tokens: 464,
    completion_tokens: 35 + 0,
    cached_tokens: 9216,
    cost_usd: 0.007978,
  });
});

test('usage: opencode cache.write is carried in extra.cache_write', () => {
  const traj = normalizeOpencode(JSON.stringify(usageExport), '0.5.0');
  const patchStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Edit',
  );
  expect(patchStep!.extra?.['cache_write']).toBe(12);
  // A zero cache.write is still recorded honestly on the glob step.
  const globStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Glob',
  );
  expect(globStep!.extra?.['cache_write']).toBe(0);
});

test('usage: opencode text-only final message surfaces its tokens + cost', () => {
  // The last assistant message has tokens/cost but no tool part; its usage must
  // not be dropped — it gets a dedicated metrics-only agent step.
  const traj = normalizeOpencode(JSON.stringify(usageExport), '0.5.0');
  const finalStep = traj.steps.find((s) => s.metrics?.cost_usd === 0.007598);
  expect(finalStep).toBeDefined();
  expect(finalStep!.source).toBe('agent');
  expect(finalStep!.tool_calls).toBeUndefined();
  expect(finalStep!.metrics).toEqual({
    prompt_tokens: 520,
    completion_tokens: 13,
    cached_tokens: 9216,
    cost_usd: 0.007598,
  });
});

test('usage: opencode totals across step metrics match per-message sums', () => {
  const traj = normalizeOpencode(JSON.stringify(usageExport), '0.5.0');
  const totals = traj.steps.reduce(
    (acc, s) => {
      if (!s.metrics) return acc;
      acc.prompt += s.metrics.prompt_tokens ?? 0;
      acc.completion += s.metrics.completion_tokens ?? 0;
      acc.cached += s.metrics.cached_tokens ?? 0;
      acc.cost += s.metrics.cost_usd ?? 0;
      return acc;
    },
    { prompt: 0, completion: 0, cached: 0, cost: 0 },
  );
  expect(totals.prompt).toBe(9504 + 464 + 520);
  expect(totals.completion).toBe(57 + 106 + 35 + 13);
  expect(totals.cached).toBe(0 + 9216 + 9216);
  expect(totals.cost).toBeCloseTo(0.05241 + 0.007978 + 0.007598, 6);
});

test('usage: user messages contribute no metrics', () => {
  const traj = normalizeOpencode(JSON.stringify(usageExport), '0.5.0');
  // 3 assistant messages → exactly 3 metrics-bearing steps.
  const withMetrics = traj.steps.filter((s) => s.metrics !== undefined);
  expect(withMetrics.length).toBe(3);
});

test('usage: assistant message without a tokens block leaves metrics unset', () => {
  const noTokens = {
    messages: [
      {
        info: { role: 'assistant', modelID: 'gpt-5.5', providerID: 'openai' },
        parts: [
          { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } },
        ],
      },
    ],
  };
  const traj = normalizeOpencode(JSON.stringify(noTokens), '0.5.0');
  expect(traj.steps.every((s) => s.metrics === undefined)).toBe(true);
});
