import { expect, test } from 'bun:test';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeClaudeLegacy } from '../src/normalize/claude.ts';

const raw = await Bun.file(
  new URL('./fixtures/claude-legacy-basic.jsonl', import.meta.url),
).text();

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeClaudeLegacy(raw, '2.1.175');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'claude-code', version: '2.1.175' });
});

test('maps tool_use blocks to ATIF tool_calls', () => {
  const traj = normalizeClaudeLegacy(raw, '2.1.175');
  const calls = traj.steps.flatMap((s) => s.tool_calls ?? []);
  expect(calls.map((c) => c.function_name)).toEqual(['Write', 'Bash']);
  expect(calls[0]).toEqual({
    tool_call_id: 'toolu_01',
    function_name: 'Write',
    arguments: { file_path: 'hello.txt', content: 'hi' },
  });
});

test('captures thinking as reasoning_content and text as message', () => {
  const traj = normalizeClaudeLegacy(raw, '2.1.175');
  const writeStep = traj.steps.find((s) =>
    s.tool_calls?.some((c) => c.tool_call_id === 'toolu_01'),
  )!;
  expect(writeStep.source).toBe('agent');
  expect(writeStep.reasoning_content).toBe("I'll write the file.");
  expect(writeStep.message).toBe('Writing the file now.');
});

test('attaches tool_result to the issuing step as an observation', () => {
  const traj = normalizeClaudeLegacy(raw, '2.1.175');
  const writeStep = traj.steps.find((s) =>
    s.tool_calls?.some((c) => c.tool_call_id === 'toolu_01'),
  )!;
  expect(writeStep.observation?.results).toEqual([
    { source_call_id: 'toolu_01', content: 'File created' },
  ]);
});

test('emits a user step for the initial prompt and no step for pure tool_result lines', () => {
  const traj = normalizeClaudeLegacy(raw, '2.1.175');
  expect(traj.steps[0]).toMatchObject({
    step_id: 1,
    source: 'user',
    message: 'create hello.txt with hi',
  });
  expect(traj.steps.length).toBe(3);
  expect(traj.steps.map((s) => s.source)).toEqual(['user', 'agent', 'agent']);
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeClaudeLegacy(raw, '2.1.175');
  expect(traj.steps.map((s) => s.step_id)).toEqual([1, 2, 3]);
});

test('tolerates blank and unparseable lines', () => {
  const traj = normalizeClaudeLegacy(
    '\n{not json}\n{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n',
    '2.1.175',
  );
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.message).toBe('hi');
});

test('step timestamp is carried from the source entry when present', () => {
  // The multi-log merge in quorum/capture.py orders steps by this timestamp,
  // so the normalizer must surface the source entry's timestamp on its step.
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-13T19:37:26.300Z',
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.177');
  expect(traj.steps[0]!.timestamp).toBe('2026-06-13T19:37:26.300Z');
});

// --- string-content user message tests (2.1.177 real-format) ---

test('string-content user record becomes a user step', () => {
  const line =
    '{"type":"user","message":{"role":"user","content":"hello world"}}';
  const traj = normalizeClaudeLegacy(line, '2.1.177');
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe('user');
  expect(traj.steps[0]!.message).toBe('hello world');
});

test('real 2.1.177 fixture: user prompt captured, unknown types ignored', async () => {
  const raw = await Bun.file(
    new URL('./fixtures/claude-2.1.177-real.jsonl', import.meta.url),
  ).text();
  const traj = normalizeClaudeLegacy(raw, '2.1.177');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const userStep = traj.steps.find(
    (s) => s.source === 'user' && s.message && s.message.length > 0,
  );
  expect(userStep).toBeDefined();
  expect(userStep!.message).toBe(
    'create a file hello.txt containing the word hi, then stop',
  );
  expect(
    traj.steps.every((s) => s.source === 'user' || s.source === 'agent'),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Fix 4: mixed text+tool_result user turns
// ---------------------------------------------------------------------------

test('mixed user turn: attaches tool_result observation AND emits user step', () => {
  // A user message containing both a tool_result and a text block.
  // Before the fix: the tool_result was discarded and only the user step was emitted.
  // After the fix: the observation is attached to the issuing agent step AND
  // a user step is emitted for the text.
  const raw = [
    // assistant step that issues toolu_01
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    }),
    // user turn with BOTH a tool_result and a text block (interrupted)
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file.txt' },
          { type: 'text', text: '[interrupted]' },
        ],
      },
    }),
  ].join('\n');

  const traj = normalizeClaudeLegacy(raw, '2.1.175');

  // The agent step should have the observation attached
  const agentStep = traj.steps.find((s) => s.source === 'agent');
  expect(agentStep).toBeDefined();
  expect(agentStep!.observation?.results).toBeDefined();
  expect(agentStep!.observation!.results).toEqual([
    { source_call_id: 'toolu_01', content: 'file.txt' },
  ]);

  // A user step should also be emitted for the text
  const userStep = traj.steps.find((s) => s.source === 'user');
  expect(userStep).toBeDefined();
  expect(userStep!.message).toBe('[interrupted]');

  // Total: agent step + user step
  expect(traj.steps.length).toBe(2);
});

// ---------------------------------------------------------------------------
// Fix 5: real 2.1.177 fixture with tool_use
// ---------------------------------------------------------------------------

test('real 2.1.177 fixture with tool_use: noise rows ignored, tool_call and observation mapped', async () => {
  const raw = await Bun.file(
    new URL('./fixtures/claude-2.1.177-with-tooluse.jsonl', import.meta.url),
  ).text();
  const traj = normalizeClaudeLegacy(raw, '2.1.177');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);

  // Exactly one user step (the string prompt)
  const userSteps = traj.steps.filter((s) => s.source === 'user');
  expect(userSteps.length).toBe(1);
  expect(userSteps[0]!.message).toBe('create hello.txt with hi');

  // Exactly one agent step
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);

  // Agent step has a Write tool_call with id toolu_01
  const agentStep = agentSteps[0]!;
  expect(agentStep.tool_calls).toBeDefined();
  expect(agentStep.tool_calls!.length).toBe(1);
  const tc = agentStep.tool_calls![0]!;
  expect(tc.function_name).toBe('Write');
  expect(tc.tool_call_id).toBe('toolu_01');

  // Agent step has an observation for toolu_01
  expect(agentStep.observation?.results).toBeDefined();
  expect(agentStep.observation!.results).toEqual([
    { source_call_id: 'toolu_01', content: 'File created' },
  ]);

  // Noise rows (queue-operation, ai-title) are ignored
  expect(traj.steps.length).toBe(2); // user + agent only
});

// ---------------------------------------------------------------------------
// Fix: flat top-level tool_use entry (a line that is itself a tool_use block)
// ---------------------------------------------------------------------------

test('flat top-level tool_use entry becomes an agent step with one tool_call', () => {
  const line =
    '{"type":"tool_use","id":"x","name":"Bash","input":{"command":"ls"}}';
  const traj = normalizeClaudeLegacy(line, '2.1.175');
  expect(traj.steps.length).toBe(1);
  const step = traj.steps[0]!;
  expect(step.source).toBe('agent');
  expect(step.tool_calls).toBeDefined();
  expect(step.tool_calls!.length).toBe(1);
  expect(step.tool_calls![0]).toEqual({
    tool_call_id: 'x',
    function_name: 'Bash',
    arguments: { command: 'ls' },
  });
});

// ---------------------------------------------------------------------------
// ATIF usage metrics (spec: 2026-06-15-atif-usage-unification.md)
// ---------------------------------------------------------------------------

// Real-shaped assistant usage: claude session jsonl carries
// message.usage{input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens} + message.model. Per-message cost is NOT logged
// (priced downstream by obol).
const usageLine = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_u1',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ],
    usage: {
      input_tokens: 16153,
      output_tokens: 12,
      cache_read_input_tokens: 13804,
      cache_creation_input_tokens: 6918,
    },
  },
});

test('assistant step carries ATIF metrics + model from message.usage', () => {
  const traj = normalizeClaudeLegacy(usageLine, '2.1.177');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.model_name).toBe('claude-opus-4-8');
  expect(step.metrics).toEqual({
    prompt_tokens: 16153,
    completion_tokens: 12,
    cached_tokens: 13804,
  });
});

test('cache_creation_input_tokens lands in extra.cache_write', () => {
  const traj = normalizeClaudeLegacy(usageLine, '2.1.177');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.extra?.['cache_write']).toBe(6918);
});

test('no cost_usd is set (claude usage carries no per-message cost)', () => {
  const traj = normalizeClaudeLegacy(usageLine, '2.1.177');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.metrics?.cost_usd).toBeUndefined();
});

test('assistant step without usage gets no metrics or model_name', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.177');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.metrics).toBeUndefined();
  expect(step.model_name).toBeUndefined();
});

test('partial usage maps present fields and omits absent ones', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 100, output_tokens: 5 },
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.177');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.model_name).toBe('claude-sonnet-4-6');
  expect(step.metrics).toEqual({ prompt_tokens: 100, completion_tokens: 5 });
  expect(step.extra?.['cache_write']).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Usage dedup by message.id (claude-code re-emits a running snapshot: the same
// assistant message.id recurs across multiple rows, each carrying usage). The
// normalizer must count each message's usage ONCE, not once per row.
// Oracle: Harbor's claude_code.py keeps the last usage per message.id.
// ---------------------------------------------------------------------------

// Mirrors the bf6f real trace shape: each message.id spans 3 rows (thinking,
// text, tool_use), every row carrying the SAME usage snapshot. The buggy
// normalizer sums all rows (3× inflation); the fix counts each id once.
const reemittedUsageLog = [
  // message.id A — 3 rows, each with identical usage
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'msg_A',
      model: 'claude-opus-4-8',
      content: [{ type: 'thinking', thinking: 'planning' }],
      usage: {
        input_tokens: 5691,
        output_tokens: 160,
        cache_read_input_tokens: 15835,
        cache_creation_input_tokens: 7344,
      },
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'msg_A',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'thinking out loud' }],
      usage: {
        input_tokens: 5691,
        output_tokens: 160,
        cache_read_input_tokens: 15835,
        cache_creation_input_tokens: 7344,
      },
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'msg_A',
      model: 'claude-opus-4-8',
      content: [
        {
          type: 'tool_use',
          id: 'call_skill',
          name: 'Skill',
          input: { skill: 'superpowers:brainstorming' },
        },
      ],
      usage: {
        input_tokens: 5691,
        output_tokens: 160,
        cache_read_input_tokens: 15835,
        cache_creation_input_tokens: 7344,
      },
    },
  },
  // message.id B — single row
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'msg_B',
      model: 'claude-opus-4-8',
      content: [
        {
          type: 'tool_use',
          id: 'call_bash',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ],
      usage: {
        input_tokens: 2,
        output_tokens: 118,
        cache_read_input_tokens: 32443,
        cache_creation_input_tokens: 510,
      },
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

test('dedups re-emitted usage by message.id (counts each message once)', () => {
  const traj = normalizeClaudeLegacy(reemittedUsageLog, '2.1.177');

  let promptTotal = 0;
  let cachedTotal = 0;
  let cacheWriteTotal = 0;
  let completionTotal = 0;
  for (const s of traj.steps) {
    promptTotal += s.metrics?.prompt_tokens ?? 0;
    cachedTotal += s.metrics?.cached_tokens ?? 0;
    completionTotal += s.metrics?.completion_tokens ?? 0;
    cacheWriteTotal += (s.extra?.['cache_write'] as number | undefined) ?? 0;
  }

  // msg_A counted once (5691/15835/7344/160) + msg_B (2/32443/510/118)
  expect(promptTotal).toBe(5693);
  expect(cachedTotal).toBe(48278);
  expect(cacheWriteTotal).toBe(7854);
  expect(completionTotal).toBe(278);
});

test('re-emitted message.id does not duplicate tool_calls', () => {
  const traj = normalizeClaudeLegacy(reemittedUsageLog, '2.1.177');
  const calls = traj.steps.flatMap((s) => s.tool_calls ?? []);
  expect(calls.map((c) => c.function_name)).toEqual(['Skill', 'Bash']);
  expect(calls.map((c) => c.tool_call_id)).toEqual(['call_skill', 'call_bash']);
});

test('a tool_use repeated across re-emitted rows is emitted once', () => {
  // Same tool_use id appearing in two rows of one message.id must produce a
  // single tool_call, not two.
  const log = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_X',
        content: [
          {
            type: 'tool_use',
            id: 'dupe_call',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_X',
        content: [
          {
            type: 'tool_use',
            id: 'dupe_call',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');

  const traj = normalizeClaudeLegacy(log, '2.1.177');
  const calls = traj.steps.flatMap((s) => s.tool_calls ?? []);
  expect(calls.length).toBe(1);
  expect(calls[0]!.tool_call_id).toBe('dupe_call');
  // usage counted once
  let promptTotal = 0;
  for (const s of traj.steps) promptTotal += s.metrics?.prompt_tokens ?? 0;
  expect(promptTotal).toBe(10);
});

// Note: the per-agent `src/cli/normalize-claude.ts` shim and the unified
// `src/cli/normalize.ts` dispatcher are intentionally not grafted onto this
// branch — capture invokes the normalizers in-process, not via a CLI — so their
// CLI tests are omitted. The in-process normalizer behaviour is covered above.
