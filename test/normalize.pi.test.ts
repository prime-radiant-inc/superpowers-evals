import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizePi } from '../src/normalize/pi.ts';

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

function makeMessage(content: unknown[]): string {
  return JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content },
  });
}

const sessionHeader = JSON.stringify({ type: 'session', cwd: '/tmp/project' });

const basicLines = [
  sessionHeader,
  makeMessage([
    { type: 'text', text: 'I will inspect this.' },
    { type: 'toolCall', name: 'read', arguments: { path: 'README.md' } },
    { type: 'toolCall', name: 'bash', arguments: { command: 'git status' } },
    { type: 'toolCall', name: 'subagent', arguments: { agent: 'reviewer' } },
  ]),
].join('\n');

// Comprehensive tool mapping test (derived from test_normalizes_live_style_pi_session)
const allToolsLines = [
  JSON.stringify({
    type: 'session',
    version: 3,
    id: 'session-1',
    cwd: '/tmp/project',
  }),
  JSON.stringify({
    type: 'model_change',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
  }),
  makeMessage([
    {
      type: 'toolCall',
      id: 'call-read',
      name: 'read',
      arguments: { path: 'README.md' },
    },
  ]),
  makeMessage([
    {
      type: 'toolCall',
      id: 'call-write',
      name: 'write',
      arguments: { path: 'out.md', content: 'ok' },
    },
    {
      type: 'toolCall',
      id: 'call-edit',
      name: 'edit',
      arguments: { path: 'out.md', oldString: 'ok', newString: 'done' },
    },
    {
      type: 'toolCall',
      id: 'call-bash',
      name: 'bash',
      arguments: { command: 'git status --short' },
    },
    {
      type: 'toolCall',
      id: 'call-find',
      name: 'find',
      arguments: { path: '.', pattern: '*.md' },
    },
    { type: 'toolCall', id: 'call-ls', name: 'ls', arguments: { path: '.' } },
    {
      type: 'toolCall',
      id: 'call-custom',
      name: 'custom_tool',
      arguments: { x: 1 },
    },
  ]),
  // tool_result row — should be ignored (role is toolResult, not assistant)
  JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 'call-read',
      content: [{ type: 'text', text: 'README' }],
    },
  }),
  makeMessage([{ type: 'text', text: 'done' }]),
].join('\n');

// subagent aliasing test
function makeSubagentLine(args: Record<string, unknown>): string {
  return makeMessage([{ type: 'toolCall', name: 'subagent', arguments: args }]);
}

const subagentLines = [
  sessionHeader,
  makeSubagentLine({ agent: 'reviewer', task: 'review the diff' }), // execution → Agent
  makeSubagentLine({ chain: [{ agent: 'scout' }, { agent: 'planner' }] }), // execution → Agent
  makeSubagentLine({
    tasks: [{ agent: 'reviewer', count: 3 }],
    concurrency: 3,
  }), // execution → Agent
  makeSubagentLine({ action: 'list' }), // management → subagent
  makeSubagentLine({ action: 'status', id: 'run-1' }), // management → subagent
].join('\n');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizePi(basicLines, '0.3.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'pi', version: '0.3.0' });
});

test('read maps to Read', () => {
  const traj = normalizePi(basicLines, '0.3.0');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Read');
  expect(tc.arguments['path']).toBe('README.md');
});

test('bash maps to Bash', () => {
  const traj = normalizePi(basicLines, '0.3.0');
  const bashStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(bashStep).toBeDefined();
  expect(bashStep!.tool_calls![0]!.arguments['command']).toBe('git status');
});

test('subagent (execution, no action key) maps to Agent', () => {
  const traj = normalizePi(basicLines, '0.3.0');
  const agentStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Agent',
  );
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls![0]!.arguments['agent']).toBe('reviewer');
});

test('subagent dispatch canonicalizes the task arg to prompt', () => {
  const lines = [
    sessionHeader,
    makeSubagentLine({ agent: 'reviewer', task: 'review the diff' }),
  ].join('\n');
  const traj = normalizePi(lines, '0.3.0');
  const tc = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Agent',
  )!.tool_calls![0]!;
  // task → prompt (the canonical, cross-harness dispatch-instruction key)
  expect(tc.arguments['prompt']).toBe('review the diff');
  expect(tc.arguments['task']).toBeUndefined();
  expect(tc.arguments['agent']).toBe('reviewer'); // other args preserved
});

test('all standard Pi tool names map correctly', () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.tool_calls)
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual([
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Glob', // find
    'Glob', // ls
    'custom_tool',
  ]);
});

test('find maps to Glob', () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  const findStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === 'Glob' &&
      'pattern' in (s.tool_calls[0]?.arguments ?? {}),
  );
  expect(findStep).toBeDefined();
  expect(findStep!.tool_calls![0]!.arguments['path']).toBe('.');
  expect(findStep!.tool_calls![0]!.arguments['pattern']).toBe('*.md');
});

test('ls maps to Glob', () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  const lsStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === 'Glob' &&
      !('pattern' in (s.tool_calls[0]?.arguments ?? {})),
  );
  expect(lsStep).toBeDefined();
  expect(lsStep!.tool_calls![0]!.arguments['path']).toBe('.');
});

test('unknown tool names are preserved verbatim', () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  const customStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'custom_tool',
  );
  expect(customStep).toBeDefined();
  expect(customStep!.tool_calls![0]!.arguments['x']).toBe(1);
});

test('subagent execution calls alias to Agent, management calls stay subagent', () => {
  const traj = normalizePi(subagentLines, '0.3.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(['Agent', 'Agent', 'Agent', 'subagent', 'subagent']);
});

test('toolResult messages attach as observations on their owning call step', () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  // allToolsLines has a toolResult row for call-read → it links to the Read
  // step as an observation, not a separate step.
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.tool_call_id === 'call-read',
  )!;
  expect(readStep.observation!.results[0]!.source_call_id).toBe('call-read');
  expect(readStep.observation!.results[0]!.content).toContain('README');
  // A toolResult never produces a step with a tool-less, content-less shape.
  const orphanSteps = traj.steps.filter(
    (s) => s.source === 'agent' && !s.tool_calls && !s.message && !s.metrics,
  );
  expect(orphanSteps.length).toBe(0);
});

test('text-only assistant message becomes a content-only agent step', () => {
  const lines = [
    sessionHeader,
    makeMessage([{ type: 'text', text: 'done' }]),
  ].join('\n');
  const traj = normalizePi(lines, '0.3.0');
  // Full fidelity: the assistant text is captured as a content-only agent step.
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);
  expect(agentSteps[0]!.message).toBe('done');
  expect(agentSteps[0]!.tool_calls).toBeUndefined();
});

test('session and model_change rows are ignored', () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  // session and model_change rows should not produce steps
  expect(traj.steps.every((s) => s.source === 'agent')).toBe(true);
});

test('tolerates blank lines and bad JSON', () => {
  const raw = `\n{not json}\n${makeMessage([{ type: 'toolCall', name: 'read', arguments: { path: 'x' } }])}\n`;
  const traj = normalizePi(raw, '0.3.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps[0]!.tool_calls![0]!.function_name).toBe('Read');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizePi(basicLines, '0.3.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test("tool_call_id is taken from block's id field when present", () => {
  const traj = normalizePi(allToolsLines, '0.3.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(readStep!.tool_calls![0]!.tool_call_id).toBe('call-read');
});

// ---------------------------------------------------------------------------
// ATIF usage metrics (spec 2026-06-15-atif-usage-unification.md)
// Real shape from /tmp/quorum-live-results5/...-pi-.../sessions/*.jsonl:
//   each assistant message carries message.{model, provider, usage} where
//   usage = {input, output, cacheRead, cacheWrite, totalTokens,
//            cost{input,output,cacheRead,cacheWrite,total}}.
//   Map input→prompt_tokens, output→completion_tokens, cacheRead→cached_tokens,
//   cost.total→cost_usd, provider→extra.provider, cacheWrite→extra.cache_write.
// ---------------------------------------------------------------------------

function makeUsageMessage(content: unknown[], usage: unknown): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      usage,
      content,
    },
  });
}

const usageLines = [
  sessionHeader,
  makeUsageMessage(
    [
      { type: 'thinking', text: 'thinking...' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.md' } },
    ],
    {
      input: 9958,
      output: 137,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10095,
      cost: {
        input: 0.04979,
        output: 0.00411,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.0539,
      },
    },
  ),
  makeUsageMessage(
    [
      {
        type: 'toolCall',
        id: 'c2',
        name: 'bash',
        arguments: { command: 'ls' },
      },
    ],
    {
      input: 461,
      output: 21,
      cacheRead: 10752,
      cacheWrite: 8,
      totalTokens: 11234,
      cost: {
        input: 0.002305,
        output: 0.00063,
        cacheRead: 0.005376,
        cacheWrite: 0.001,
        total: 0.008311,
      },
    },
  ),
].join('\n');

test('toolCall step carries model_name, provider, and full usage metrics', () => {
  const traj = normalizePi(usageLines, '0.3.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  )!;
  expect(readStep.model_name).toBe('gpt-5.5');
  expect(readStep.metrics).toEqual({
    prompt_tokens: 9958,
    completion_tokens: 137,
    cached_tokens: 0,
    cost_usd: 0.0539,
  });
  expect(readStep.extra).toEqual({ provider: 'openai-codex' });
});

test('cacheRead → cached_tokens, cacheWrite → extra.cache_write, cost.total → cost_usd', () => {
  const traj = normalizePi(usageLines, '0.3.0');
  const bashStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  )!;
  expect(bashStep.metrics).toEqual({
    prompt_tokens: 461,
    completion_tokens: 21,
    cached_tokens: 10752,
    cost_usd: 0.008311,
  });
  expect(bashStep.extra).toEqual({
    provider: 'openai-codex',
    cache_write: 8,
  });
});

test('text-only assistant message with usage still records a metrics step', () => {
  const lines = [
    sessionHeader,
    makeUsageMessage([{ type: 'text', text: 'done' }], {
      input: 100,
      output: 21,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 121,
      cost: { total: 0.001 },
    }),
  ].join('\n');
  const traj = normalizePi(lines, '0.3.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const metricSteps = traj.steps.filter((s) => s.metrics);
  expect(metricSteps.length).toBe(1);
  expect(metricSteps[0]!.metrics).toEqual({
    prompt_tokens: 100,
    completion_tokens: 21,
    cached_tokens: 0,
    cost_usd: 0.001,
  });
  expect(metricSteps[0]!.model_name).toBe('gpt-5.5');
});

test('multi-toolCall message attaches usage to first step only (no double-count)', () => {
  const lines = [
    sessionHeader,
    makeUsageMessage(
      [
        {
          type: 'toolCall',
          id: 'm1',
          name: 'read',
          arguments: { path: 'a' },
        },
        {
          type: 'toolCall',
          id: 'm2',
          name: 'read',
          arguments: { path: 'b' },
        },
      ],
      {
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 60,
        cost: { total: 0.0005 },
      },
    ),
  ].join('\n');
  const traj = normalizePi(lines, '0.3.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);
  expect(agentSteps[0]!.metrics).toEqual({
    prompt_tokens: 50,
    completion_tokens: 10,
    cached_tokens: 0,
    cost_usd: 0.0005,
  });
  expect(agentSteps[1]!.metrics).toBeUndefined();
});

test('messages without usage produce no metrics', () => {
  const traj = normalizePi(basicLines, '0.3.0');
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
    expect(step.model_name).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Full-fidelity content (reverse-engineered from a real captured pi session,
// see test/fixtures/pi-session.slice.jsonl). Asserts message text, reasoning,
// linked observations, session_id, model_change tracking, and per-step cost.
// ---------------------------------------------------------------------------

const fixtureSlice = readFileSync(
  new URL('./fixtures/pi-session.slice.jsonl', import.meta.url),
  'utf8',
);

test('session id is read from the type:session entry', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  expect(traj.session_id).toBe('019ecd1e-996e-70ba-8042-aeaa4c391744');
});

test('the produced trajectory is valid ATIF', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test('user text becomes a user step with the message', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const userSteps = traj.steps.filter((s) => s.source === 'user');
  expect(userSteps.length).toBe(1);
  expect(userSteps[0]!.message).toBe(
    'I have a plan at plan.md. Use subagent-driven-development.',
  );
});

test('assistant text is carried as step.message on the first tool step', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  )!;
  expect(readStep.message).toBe(
    'Using subagent-driven-development to execute the plan end-to-end.',
  );
});

test('thinking blocks become reasoning_content', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  )!;
  expect(readStep.reasoning_content).toBe(
    '**Considering skill requirements**\n\nI think I need to read the skill.',
  );
});

test('tool results link to their owning tool call (same-step observation)', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  )!;
  expect(readStep.observation).toBeDefined();
  const result = readStep.observation!.results[0]!;
  expect(result.source_call_id).toBe('call_read_1');
  expect(result.content).toContain('subagent-driven-development');
});

test('subagent execution call aliases to Agent and links its result', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const agentStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Agent',
  )!;
  expect(agentStep).toBeDefined();
  // task → prompt canonicalization
  expect(agentStep.tool_calls![0]!.arguments['prompt']).toBe(
    'Implement Task 1: project scaffolding.',
  );
  expect(agentStep.tool_calls![0]!.arguments['agent']).toBe('worker');
  // result linked to the same step's call id
  const result = agentStep.observation!.results[0]!;
  expect(result.source_call_id).toBe('call_sub_1');
  expect(result.content).toContain('Worker completed Task 1');
});

test('subagent management call stays subagent (action key present)', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const mgmtStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'subagent',
  );
  expect(mgmtStep).toBeDefined();
  expect(mgmtStep!.tool_calls![0]!.arguments['action']).toBe('list');
});

test('every usage-bearing step carries the tracked model_name (gpt-5.5)', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  for (const step of traj.steps) {
    if (step.metrics) {
      expect(step.model_name).toBe('gpt-5.5');
    }
  }
});

test('disjoint buckets preserved and per-step cost is present', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const readStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  )!;
  expect(readStep.metrics).toEqual({
    prompt_tokens: 5149,
    completion_tokens: 103,
    cached_tokens: 9728,
    cost_usd: 0.033699,
  });
  expect(readStep.extra).toEqual({ provider: 'openai-codex' });
});

test('cache_write rides on step.extra.cache_write (not metrics.extra)', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const agentStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Agent',
  )!;
  expect(agentStep.extra).toEqual({ provider: 'openai-codex', cache_write: 8 });
  // cache_write must NOT be under metrics.extra (obol ignores that location)
  expect(agentStep.metrics!.extra).toBeUndefined();
});

test('text-only final assistant message with usage records a metrics step with cost', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const finalStep = traj.steps.find(
    (s) => s.message === 'All tasks complete. The work is merged.',
  )!;
  expect(finalStep.source).toBe('agent');
  expect(finalStep.metrics).toEqual({
    prompt_tokens: 200,
    completion_tokens: 40,
    cached_tokens: 12000,
    cost_usd: 0.0082,
  });
  expect(finalStep.model_name).toBe('gpt-5.5');
});

test('total per-step cost across the fixture is the sum of message costs (non-zero)', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  const total = traj.steps.reduce(
    (acc, s) => acc + (s.metrics?.cost_usd ?? 0),
    0,
  );
  // 0.033699 + 0.085855 + 0.0082 (mgmt call has no usage)
  expect(total).toBeCloseTo(0.127754, 6);
  expect(total).toBeGreaterThan(0);
});

test('no final_metrics token totals (single-source: per-step only)', () => {
  const traj = normalizePi(fixtureSlice, '0.3.0');
  expect(traj.final_metrics).toBeUndefined();
});

test('model_change is tracked forward when a message omits its own model', () => {
  // An assistant message with usage but NO message.model still gets gpt-5.5
  // from the preceding model_change entry.
  const lines = [
    JSON.stringify({ type: 'session', id: 'sess-x', cwd: '/tmp' }),
    JSON.stringify({
      type: 'model_change',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.01 } },
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
      },
    }),
  ].join('\n');
  const traj = normalizePi(lines, '0.3.0');
  const step = traj.steps.find((s) => s.metrics)!;
  expect(step.model_name).toBe('gpt-5.5');
});
