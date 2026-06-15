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

test('tool.result rows are ignored', () => {
  const traj = normalizeKimi(basicLines, '0.1.0');
  // Only the three tool.call rows produce steps.
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
