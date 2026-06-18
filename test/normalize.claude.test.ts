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

// ===========================================================================
// FULL-FIDELITY ATIF (Task 2) — ported from Harbor's
// test_claude_code_trajectory.py. Each block below adds a fidelity item on top
// of the already-correct usage dedup / disjoint-bucket model.
// ===========================================================================

// ---------------------------------------------------------------------------
// uuid dedup (correctness/cost fix). Harbor drops any event whose `uuid`
// repeats (claude-code replays old events after a compact_boundary). The
// replay would otherwise double-count its tool_result/usage.
// Oracle: claude_code.py:645-657.
// ---------------------------------------------------------------------------

test('uuid dedup: a row whose uuid repeats after compaction is dropped', () => {
  // Mirrors Harbor's test_duplicate_session_uuid_tool_result_is_deduped:
  // tool_use + tool_result, a compact_boundary, then the SAME tool_result
  // replayed. The replay must not produce a second observation.
  const toolResult = {
    type: 'user',
    uuid: 'duplicate-tool-result',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_dup', content: 'ok' },
      ],
    },
  };
  const log = [
    { type: 'user', uuid: 'u0', message: { role: 'user', content: 'Run it' } },
    {
      type: 'assistant',
      uuid: 'assistant-tool-use',
      message: {
        role: 'assistant',
        id: 'msg_tu',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_dup',
            name: 'Bash',
            input: { command: 'echo ok' },
          },
        ],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    },
    toolResult,
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
    },
    // exact replay of the tool_result (same uuid) — must be dropped
    toolResult,
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');

  const traj = normalizeClaudeLegacy(log, '2.1.178');
  const toolSteps = traj.steps.filter((s) => s.tool_calls?.length);
  expect(toolSteps.length).toBe(1);
  expect(toolSteps[0]!.observation?.results.length).toBe(1);
});

test('uuid dedup: a re-emitted assistant row is counted once for usage', () => {
  const row = {
    type: 'assistant',
    uuid: 'same-uuid',
    message: {
      role: 'assistant',
      id: 'msg_one',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 42, output_tokens: 3 },
    },
  };
  const log = [row, row].map((e) => JSON.stringify(e)).join('\n');
  const traj = normalizeClaudeLegacy(log, '2.1.178');
  let promptTotal = 0;
  for (const s of traj.steps) promptTotal += s.metrics?.prompt_tokens ?? 0;
  expect(promptTotal).toBe(42);
});

// ---------------------------------------------------------------------------
// thinking: read the `text` key as well as `thinking`, and treat `reasoning`
// and `analysis` block types as reasoning_content.
// Oracle: claude_code.py:419-429.
// ---------------------------------------------------------------------------

test('thinking block under the text key becomes reasoning_content', () => {
  // Goose-style format: thinking content under 'text' key.
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'I need to list files first.' },
        { type: 'text', text: 'Let me check the directory.' },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.reasoning_content).toBe('I need to list files first.');
  expect(step.message).toBe('Let me check the directory.');
});

test('reasoning and analysis block types map to reasoning_content', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'step one' },
        { type: 'analysis', thinking: 'step two' },
        { type: 'text', text: 'answer' },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.reasoning_content).toBe('step one\n\nstep two');
});

test('empty thinking text key does not fall through to thinking key', () => {
  // Harbor: `block.get("text") if block.get("text") is not None`. An empty
  // string text is a present value, so reasoning is empty (block dropped).
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', text: '', thinking: 'fallback' }],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.reasoning_content).toBeUndefined();
});

test('multiple thinking blocks join with double newlines', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'First thought.' },
        { type: 'thinking', thinking: 'Second thought.' },
        { type: 'text', text: 'Final answer.' },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.reasoning_content).toBe('First thought.\n\nSecond thought.');
  expect(step.message).toBe('Final answer.');
});

// ---------------------------------------------------------------------------
// message: assistant + user text joined byte-faithfully with '\n\n'.
// Oracle: claude_code.py:862-1043, _extract_text_reasoning_tool_uses:473.
// ---------------------------------------------------------------------------

test('multiple assistant text blocks join with double newlines', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  const step = traj.steps.find((s) => s.source === 'agent')!;
  expect(step.message).toBe('first\n\nsecond');
});

test('user string content is byte-faithful (leading/trailing whitespace kept)', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '  indented prompt  ' },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  expect(traj.steps[0]!.message).toBe('  indented prompt  ');
});

test('user list text blocks join verbatim with double newlines', () => {
  const partA = 'first part keeps trailing spaces   ';
  const partB = '\n\tsecond part keeps its leading newline+tab';
  const line = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: partA },
        { type: 'text', text: partB },
      ],
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  expect(traj.steps[0]!.message).toBe(`${partA}\n\n${partB}`);
});

// ---------------------------------------------------------------------------
// observation: rich tool_result formatting from toolUseResult + is_error.
// Oracle: claude_code.py:516-587.
// ---------------------------------------------------------------------------

test('observation formats toolUseResult stdout/stderr/exitCode', () => {
  const log = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_bash',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bash',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      toolUseResult: {
        stdout: 'file.txt',
        stderr: 'a warning',
        exitCode: 2,
      },
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_bash', content: '' },
        ],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const traj = normalizeClaudeLegacy(log, '2.1.178');
  const step = traj.steps.find((s) => s.tool_calls?.length)!;
  const content = step.observation!.results[0]!.content as string;
  expect(content).toContain('[stdout]\nfile.txt');
  expect(content).toContain('[stderr]\na warning');
  expect(content).toContain('[exit_code] 2');
});

test('observation marks tool failures from is_error', () => {
  const log = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_err',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_err',
            name: 'Bash',
            input: { command: 'false' },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_err',
            content: 'boom',
            is_error: true,
          },
        ],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const traj = normalizeClaudeLegacy(log, '2.1.178');
  const step = traj.steps.find((s) => s.tool_calls?.length)!;
  const content = step.observation!.results[0]!.content as string;
  expect(content).toContain('boom');
  expect(content).toContain('[error] tool reported failure');
});

// ---------------------------------------------------------------------------
// agent.version from the log + agent.extra (cwds/git_branches/agent_ids).
// Oracle: claude_code.py:673-704.
// ---------------------------------------------------------------------------

test('agent.version is read from the log version field', () => {
  const line = JSON.stringify({
    type: 'assistant',
    version: '2.1.178',
    cwd: '/workspace/app',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    },
  });
  const traj = normalizeClaudeLegacy(line, 'unknown');
  expect(traj.agent.version).toBe('2.1.178');
});

test('agent.extra collects cwds, git_branches, and agent_ids', () => {
  const line = JSON.stringify({
    type: 'assistant',
    version: '2.1.178',
    cwd: '/workspace/app',
    gitBranch: 'main',
    agentId: 'agent-7',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    },
  });
  const traj = normalizeClaudeLegacy(line, 'unknown');
  expect(traj.agent.extra).toEqual({
    cwds: ['/workspace/app'],
    git_branches: ['main'],
    agent_ids: ['agent-7'],
  });
});

// ---------------------------------------------------------------------------
// turn-bundling: text + reasoning + every tool_use sharing one message.id
// collapse into ONE step. Oracle: claude_code.py:736-859.
// ---------------------------------------------------------------------------

test('rows sharing one message.id bundle into a single step', () => {
  // Mirrors the bf6f shape: thinking, text, tool_use split across three rows
  // that share msg_A. They must collapse to one agent step.
  const log = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_A',
        content: [{ type: 'thinking', thinking: 'planning' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_A',
        content: [{ type: 'text', text: 'running now' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_A',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_A',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_A', content: 'file.txt' },
        ],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const traj = normalizeClaudeLegacy(log, '2.1.178');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);
  const step = agentSteps[0]!;
  expect(step.reasoning_content).toBe('planning');
  expect(step.message).toBe('running now');
  expect(step.tool_calls!.length).toBe(1);
  expect(step.tool_calls![0]!.tool_call_id).toBe('toolu_A');
  expect(step.observation!.results[0]!.content).toBe('file.txt');
});

test('multiple tool_uses in one turn bundle into one step', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      id: 'msg_multi',
      content: [
        { type: 'text', text: 'Reading both files.' },
        { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { path: 'a' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Read', input: { path: 'b' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);
  expect(agentSteps[0]!.tool_calls!.map((c) => c.tool_call_id)).toEqual([
    'toolu_a',
    'toolu_b',
  ]);
});

test('id-less assistant rows are NOT bundled (each is its own step)', () => {
  // Preserves the legacy behaviour: assistant rows without a message.id stay
  // as separate steps (the existing fixtures rely on this).
  const log = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'one' }],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'two' }],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  const traj = normalizeClaudeLegacy(log, '2.1.178');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);
});

// ---------------------------------------------------------------------------
// session_id: read from the first row carrying a non-empty sessionId field.
// Real claude traces carry sessionId on every row (verified against
// results/superpowers-bootstrap-claude-20260616T052827Z-bf6f).
// ---------------------------------------------------------------------------

test('session_id is populated from row sessionId field', () => {
  const line = JSON.stringify({
    type: 'user',
    sessionId: 'abc-session-123',
    message: { role: 'user', content: 'hello' },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  expect(traj.session_id).toBe('abc-session-123');
});

test('session_id is absent when no row carries sessionId', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hello' },
  });
  const traj = normalizeClaudeLegacy(line, '2.1.178');
  expect(traj.session_id).toBeUndefined();
});

// Note: the per-agent `src/cli/normalize-claude.ts` shim and the unified
// `src/cli/normalize.ts` dispatcher are intentionally not grafted onto this
// branch — capture invokes the normalizers in-process, not via a CLI — so their
// CLI tests are omitted. The in-process normalizer behaviour is covered above.
