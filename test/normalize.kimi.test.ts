import { expect, test } from 'bun:test';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeKimi } from '../src/normalize/kimi.ts';

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

function toolCall(name: string, args: unknown): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.call', name, args },
  });
}

const basicLines = [
  toolCall('Read', { path: 'sample.txt' }),
  toolCall('Bash', { command: 'git status' }),
  toolCall('FetchURL', { url: 'https://example.test' }),
  JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'tool.result', toolCallId: 'tool_1' },
  }),
].join('\n');

// Real kimi wire.jsonl carries usage as standalone rows (verified against
// /tmp/quorum-live-results5/...-kimi-.../**/wire.jsonl, 2026-06-15):
//   {"type":"usage.record","model":"kimi-code/kimi-for-coding",
//    "usage":{"inputOther":4056,"output":319,"inputCacheRead":14336,
//    "inputCacheCreation":0},"usageScope":"turn","time":...}
function usageRecord(
  usage: {
    inputOther: number;
    output: number;
    inputCacheRead: number;
    inputCacheCreation: number;
  },
  usageScope: 'turn' | 'session',
  model = 'kimi-code/kimi-for-coding',
): string {
  return JSON.stringify({
    type: 'usage.record',
    model,
    usage,
    usageScope,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeKimi(basicLines, '0.1.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'kimi', version: '0.1.0' });
});

test('kimi tool names are preserved canonically', () => {
  const traj = normalizeKimi(basicLines, '0.1.0');
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(['Read', 'Bash', 'FetchURL']);
});

test('tool.result rows do not produce new steps (they attach to their call)', () => {
  const traj = normalizeKimi(basicLines, '0.1.0');
  // The tool.result in basicLines has no matching call (uses 'tool_1' which no call emits),
  // so it's dropped. Only the three tool.call rows produce steps.
  expect(traj.steps.filter((s) => s.source === 'agent').length).toBe(3);
});

test('args are carried through verbatim', () => {
  const traj = normalizeKimi(basicLines, '0.1.0');
  const read = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(read!.tool_calls![0]!.arguments['path']).toBe('sample.txt');
});

test('bare superpowers skill names are canonicalized', () => {
  const raw = toolCall('Skill', { skill: 'brainstorming' });
  const traj = normalizeKimi(raw, '0.1.0');
  const skill = traj.steps[0]!.tool_calls![0]!;
  expect(skill.function_name).toBe('Skill');
  expect(skill.arguments['skill']).toBe('superpowers:brainstorming');
});

test('already-qualified skill names are left untouched', () => {
  const raw = toolCall('Skill', { skill: 'otherplugin:thing' });
  const traj = normalizeKimi(raw, '0.1.0');
  expect(traj.steps[0]!.tool_calls![0]!.arguments['skill']).toBe(
    'otherplugin:thing',
  );
});

test('non-tool.call events are ignored', () => {
  const raw = JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'message', role: 'assistant' },
  });
  const traj = normalizeKimi(raw, '0.1.0');
  expect(traj.steps.filter((s) => s.source === 'agent').length).toBe(0);
});

test('non-string tool names are ignored', () => {
  const raw = [toolCall('Read', { path: 'x' }), toolCall('', {})].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(['Read']);
});

test('tolerates blank lines and bad JSON', () => {
  const raw = `\n{not json}\n${toolCall('Bash', { command: 'ls' })}\n`;
  const traj = normalizeKimi(raw, '0.1.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps[0]!.tool_calls![0]!.function_name).toBe('Bash');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeKimi(basicLines, '0.1.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

// ---------------------------------------------------------------------------
// Usage metrics (ATIF usage-unification contract, 2026-06-15)
// ---------------------------------------------------------------------------

test('per-turn usage.record rows become agent steps with metrics', () => {
  const raw = [
    usageRecord(
      {
        inputOther: 4056,
        output: 319,
        inputCacheRead: 14336,
        inputCacheCreation: 0,
      },
      'turn',
    ),
    usageRecord(
      {
        inputOther: 556,
        output: 28,
        inputCacheRead: 18176,
        inputCacheCreation: 64,
      },
      'turn',
    ),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  const withMetrics = traj.steps.filter((s) => s.metrics);
  expect(withMetrics.length).toBe(2);

  const first = withMetrics[0]!;
  expect(first.source).toBe('agent');
  expect(first.model_name).toBe('kimi-code/kimi-for-coding');
  expect(first.metrics).toEqual({
    prompt_tokens: 4056,
    completion_tokens: 319,
    cached_tokens: 14336,
  });

  const second = withMetrics[1]!;
  // inputCacheCreation maps to extra.cache_write, not cached_tokens.
  expect(second.metrics).toEqual({
    prompt_tokens: 556,
    completion_tokens: 28,
    cached_tokens: 18176,
  });
  expect(second.extra).toEqual({ cache_write: 64 });
});

test('kimi usage carries no per-message cost (priced downstream)', () => {
  const raw = usageRecord(
    {
      inputOther: 100,
      output: 10,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    'turn',
  );
  const traj = normalizeKimi(raw, '0.1.0');
  const step = traj.steps.find((s) => s.metrics)!;
  expect(step.metrics!.cost_usd).toBeUndefined();
});

test('turn-scope rows win; session-scope rows are dropped (no double-count)', () => {
  const raw = [
    usageRecord(
      { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 0 },
      'turn',
    ),
    usageRecord(
      { inputOther: 200, output: 20, inputCacheRead: 7, inputCacheCreation: 0 },
      'turn',
    ),
    // A session total that overlaps the per-turn rows must NOT be counted.
    usageRecord(
      {
        inputOther: 300,
        output: 30,
        inputCacheRead: 12,
        inputCacheCreation: 0,
      },
      'session',
    ),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  expect(traj.steps.filter((s) => s.metrics).length).toBe(2);
  // session row was dropped → no trajectory-level total derived from it
  expect(traj.final_metrics).toBeUndefined();
});

test('session-only usage folds into final_metrics', () => {
  const raw = usageRecord(
    {
      inputOther: 300,
      output: 30,
      inputCacheRead: 12,
      inputCacheCreation: 0,
    },
    'session',
  );
  const traj = normalizeKimi(raw, '0.1.0');
  expect(traj.steps.filter((s) => s.metrics).length).toBe(0);
  expect(traj.final_metrics).toEqual({
    total_prompt_tokens: 300,
    total_completion_tokens: 30,
  });
  expect(traj.agent.model_name).toBe('kimi-code/kimi-for-coding');
});

test('usage and tool.call rows coexist; trajectory stays valid', () => {
  const raw = [
    toolCall('Read', { path: 'sample.txt' }),
    usageRecord(
      { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 0 },
      'turn',
    ),
    toolCall('Bash', { command: 'ls' }),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  expect(validateTrajectory(traj).ok).toBe(true);
  const toolNames = traj.steps
    .filter((s) => s.tool_calls)
    .map((s) => s.tool_calls![0]!.function_name);
  expect(toolNames).toEqual(['Read', 'Bash']);
  expect(traj.steps.filter((s) => s.metrics).length).toBe(1);
});

test('usage rows with no tokens are ignored', () => {
  const raw = usageRecord(
    { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    'turn',
  );
  const traj = normalizeKimi(raw, '0.1.0');
  expect(traj.steps.filter((s) => s.metrics).length).toBe(0);
});

// ---------------------------------------------------------------------------
// tool.result → observation (verified against real wire.jsonl, 2026-06-17)
// ---------------------------------------------------------------------------

function toolCallWithId(name: string, args: unknown, id: string): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      name,
      args,
      toolCallId: id,
      stepUuid: `step-${id}`,
    },
  });
}

function toolResult(callId: string, output: string, isError?: boolean): string {
  const result: Record<string, unknown> = { output };
  if (isError !== undefined) result['isError'] = isError;
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      toolCallId: callId,
      parentUuid: callId,
      result,
    },
  });
}

test('tool.result rows become observations linked to their call step', () => {
  const raw = [
    toolCallWithId('Bash', { command: 'ls' }, 'call-1'),
    toolResult('call-1', 'file.txt\n'),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(step).toBeDefined();
  expect(step!.observation).toBeDefined();
  expect(step!.observation!.results).toHaveLength(1);
  expect(step!.observation!.results[0]!.source_call_id).toBe('call-1');
  expect(step!.observation!.results[0]!.content).toBe('file.txt\n');
});

test('tool.result row with isError=true is flagged in observation', () => {
  const raw = [
    toolCallWithId('Bash', { command: 'bad' }, 'call-err'),
    toolResult('call-err', 'Command not found', true),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(step!.observation!.results[0]!.content).toBe('Command not found');
  // isError carried in observation result extra
  expect(step!.observation!.results[0]!.extra?.['is_error']).toBe(true);
});

test('tool.result rows without a matching call are ignored', () => {
  const raw = toolResult('no-such-call', 'orphaned output');
  const traj = normalizeKimi(raw, '0.1.0');
  // No steps with observations for orphan results; only the fallback user step
  const withObs = traj.steps.filter((s) => s.observation);
  expect(withObs.length).toBe(0);
});

test('tool.result rows do not generate separate steps', () => {
  const raw = [
    toolCallWithId('Read', { path: 'x.txt' }, 'call-2'),
    toolResult('call-2', 'content'),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  // Only one agent step (for the tool.call); the tool.result attaches to it
  expect(traj.steps.filter((s) => s.source === 'agent').length).toBe(1);
});

// ---------------------------------------------------------------------------
// content.part think/text → reasoning_content / message
// (verified against real wire.jsonl — stepUuid links parts to their tool step)
// ---------------------------------------------------------------------------

test('think content.part rows become reasoning_content on the matching tool step', () => {
  // toolCallWithId uses stepUuid `step-${id}` → 'step-call-abc'; manually build
  // matching stepUuid so the think part links to the tool.call step.
  const rawFixed = [
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        stepUuid: 'step-abc',
        part: { type: 'think', think: 'I should read the file first.' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        name: 'Read',
        args: { path: 'a.txt' },
        toolCallId: 'call-abc',
        stepUuid: 'step-abc',
      },
    }),
  ].join('\n');
  const traj = normalizeKimi(rawFixed, '0.1.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Read',
  );
  expect(step!.reasoning_content).toBe('I should read the file first.');
});

test('text content.part rows become message on the matching step', () => {
  const raw = [
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        stepUuid: 'step-final',
        part: { type: 'text', text: 'Done.' },
      },
    }),
    // A step.end with matching stepUuid but no tool.call (final answer step)
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'step-final' },
    }),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  // A message-only step should have been created for the text content
  const msgStep = traj.steps.find((s) => s.message === 'Done.');
  expect(msgStep).toBeDefined();
  expect(msgStep!.source).toBe('agent');
});

test('multiple think parts on the same step are joined with newlines', () => {
  const raw = [
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        stepUuid: 'step-x',
        part: { type: 'think', think: 'First thought.' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        stepUuid: 'step-x',
        part: { type: 'think', think: 'Second thought.' },
      },
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        name: 'Bash',
        args: { command: 'ls' },
        toolCallId: 'call-x',
        stepUuid: 'step-x',
      },
    }),
  ].join('\n');
  const traj = normalizeKimi(raw, '0.1.0');
  const step = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Bash',
  );
  expect(step!.reasoning_content).toContain('First thought.');
  expect(step!.reasoning_content).toContain('Second thought.');
});
