import { expect, test } from 'bun:test';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeGemini } from '../src/normalize/gemini.ts';

test('gemini: out-of-range numeric timestamp does not crash the normalizer', () => {
  // A nanosecond-scale epoch is finite but out of Date's range → toISOString()
  // would throw. The normalizer must tolerate it (no step timestamp) rather
  // than crash and drop the whole log from the merge.
  const raw = JSON.stringify({
    messages: [
      {
        type: 'gemini',
        timestamp: 8.64e18,
        content: [
          { type: 'tool_call', id: 'g1', name: 'Skill', args: { skill: 'x' } },
        ],
      },
    ],
  });
  expect(() => normalizeGemini(raw, 'test')).not.toThrow();
  expect(validateTrajectory(normalizeGemini(raw, 'test')).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

// JSONL format: individual lines, each a JSON object
const jsonlLines = [
  JSON.stringify({ kind: 'main' }), // not "gemini" type, should be ignored
  JSON.stringify({
    type: 'gemini',
    content: 'Reading file',
    toolCalls: [
      {
        id: 'read_file_1',
        name: 'read_file',
        args: { file_path: 'GEMINI.md' },
        status: 'success',
      },
    ],
  }),
  JSON.stringify({
    type: 'gemini',
    content: 'Running command',
    toolCalls: [
      {
        id: 'shell_1',
        name: 'run_shell_command',
        args: { command: 'git status' },
        status: 'success',
      },
    ],
  }),
].join('\n');

// JSON object format with "messages" array
const messagesJson = JSON.stringify({
  messages: [
    { kind: 'main' },
    {
      type: 'gemini',
      content: 'Using a skill',
      toolCalls: [
        {
          id: 'skill-1',
          name: 'activate_skill',
          args: { skill: 'superpowers:brainstorming' },
          status: 'success',
        },
        {
          id: 'ls-1',
          name: 'list_directory',
          args: { path: 'src' },
          status: 'success',
        },
        {
          id: 'write-1',
          name: 'write_file',
          args: { file_path: 'notes.md', content: 'x' },
          status: 'success',
        },
        {
          id: 'replace-1',
          name: 'replace',
          args: { file_path: 'notes.md', old_string: 'x', new_string: 'y' },
          status: 'success',
        },
        {
          id: 'shell-1',
          name: 'run_shell_command',
          args: { command: 'git status' },
          status: 'success',
        },
      ],
    },
    // duplicate shell-1 id in different message — should be deduplicated
    {
      type: 'gemini',
      content: 'duplicate',
      toolCalls: [
        {
          id: 'shell-1',
          name: 'run_shell_command',
          args: { command: 'pwd' },
          status: 'success',
        },
      ],
    },
  ],
});

// activate_skill with "name" argument (not "skill")
const nameArgJson = JSON.stringify({
  type: 'gemini',
  toolCalls: [
    {
      id: 'skill-1',
      name: 'activate_skill',
      args: { name: 'test-driven-development' },
    },
  ],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory (JSONL)', () => {
  const traj = normalizeGemini(jsonlLines, '0.1.18');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent).toEqual({ name: 'gemini', version: '0.1.18' });
});

test('read_file maps to Read', () => {
  const traj = normalizeGemini(jsonlLines, '0.1.18');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Read');
  expect(tc.arguments['file_path']).toBe('GEMINI.md');
});

test('run_shell_command maps to Bash', () => {
  const traj = normalizeGemini(jsonlLines, '0.1.18');
  const tc = traj.steps[1]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Bash');
  expect(tc.arguments['command']).toBe('git status');
});

test('JSON messages format: maps all expected tool names', () => {
  const traj = normalizeGemini(messagesJson, '0.1.18');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === 'agent')
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(['Skill', 'Glob', 'Write', 'Edit', 'Bash']);
});

test("activate_skill with 'skill' arg: normalizes to superpowers:<name>", () => {
  const traj = normalizeGemini(messagesJson, '0.1.18');
  const skillStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Skill',
  );
  expect(skillStep).toBeDefined();
  expect(skillStep!.tool_calls![0]!.arguments['skill']).toBe(
    'superpowers:brainstorming',
  );
});

test("activate_skill with 'name' arg: normalizes to superpowers:<name>", () => {
  const traj = normalizeGemini(nameArgJson, '0.1.18');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Skill');
  expect(tc.arguments['skill']).toBe('superpowers:test-driven-development');
});

test("activate_skill with already-namespaced 'skill' arg is kept as-is", () => {
  const raw = JSON.stringify({
    type: 'gemini',
    toolCalls: [
      {
        id: 'x',
        name: 'activate_skill',
        args: { skill: 'superpowers:brainstorming' },
      },
    ],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps[0]!.tool_calls![0]!.arguments['skill']).toBe(
    'superpowers:brainstorming',
  );
});

test('duplicate tool call ids across messages are deduplicated', () => {
  const traj = normalizeGemini(messagesJson, '0.1.18');
  // shell-1 appears twice but should only appear once
  const shellSteps = traj.steps.filter(
    (s) => s.tool_calls?.[0]?.tool_call_id === 'shell-1',
  );
  expect(shellSteps.length).toBe(1);
});

test('non-gemini type messages are ignored', () => {
  const raw = [
    JSON.stringify({ type: 'user', content: 'hello' }),
    JSON.stringify({
      type: 'gemini',
      toolCalls: [{ id: 'x', name: 'read_file', args: { file_path: 'f' } }],
    }),
  ].join('\n');
  const traj = normalizeGemini(raw, '0.1.18');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(1);
});

test('tolerates blank lines and bad JSON', () => {
  const raw = `\n{not json}\n${JSON.stringify({ type: 'gemini', toolCalls: [{ id: 'y', name: 'glob', args: { path: '.' } }] })}\n`;
  const traj = normalizeGemini(raw, '0.1.18');
  expect(validateTrajectory(traj).ok).toBe(true);
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Glob');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeGemini(jsonlLines, '0.1.18');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test('list_directory maps to Glob', () => {
  const traj = normalizeGemini(messagesJson, '0.1.18');
  const globStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === 'Glob' &&
      s.tool_calls?.[0]?.arguments['path'] === 'src',
  );
  expect(globStep).toBeDefined();
});

test('replace maps to Edit', () => {
  const traj = normalizeGemini(messagesJson, '0.1.18');
  const editStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Edit',
  );
  expect(editStep).toBeDefined();
});

test('write_file maps to Write', () => {
  const traj = normalizeGemini(messagesJson, '0.1.18');
  const writeStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Write',
  );
  expect(writeStep).toBeDefined();
  expect(writeStep!.tool_calls![0]!.arguments['file_path']).toBe('notes.md');
});

test('step timestamp is carried from the source message when present', () => {
  // The multi-log merge in quorum/capture.py orders steps by this timestamp,
  // so the normalizer must surface it where the source has it.
  const raw = JSON.stringify({
    type: 'gemini',
    timestamp: '2026-06-12T00:19:23.695Z',
    toolCalls: [
      {
        id: 'skill-1',
        name: 'activate_skill',
        args: { name: 'writing-plans' },
      },
    ],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps[0]!.timestamp).toBe('2026-06-12T00:19:23.695Z');
});

test('step timestamp falls back to createdAt when timestamp is absent', () => {
  const raw = JSON.stringify({
    type: 'gemini',
    createdAt: '2026-06-12T01:00:00.000Z',
    toolCalls: [{ id: 't1', name: 'read_file', args: { file_path: 'a.md' } }],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps[0]!.timestamp).toBe('2026-06-12T01:00:00.000Z');
});

test('step timestamp falls back to time when timestamp and createdAt are absent', () => {
  const raw = JSON.stringify({
    type: 'gemini',
    time: '2026-06-12T02:00:00.000Z',
    toolCalls: [{ id: 't2', name: 'read_file', args: { file_path: 'b.md' } }],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps[0]!.timestamp).toBe('2026-06-12T02:00:00.000Z');
});

test('step timestamp accepts a numeric epoch (milliseconds) and converts to ISO-8601', () => {
  // Some log formats emit timestamps as epoch-ms numbers rather than strings.
  // The normalizer must convert these so the Python merge can sort steps by time.
  const epochMs = 1749686400000; // 2025-06-12T00:00:00.000Z
  const raw = JSON.stringify({
    type: 'gemini',
    timestamp: epochMs,
    toolCalls: [{ id: 't3', name: 'read_file', args: { file_path: 'c.md' } }],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps[0]!.timestamp).toBe(new Date(epochMs).toISOString());
});

test('step timestamp is undefined when no timestamp field exists on the message', () => {
  const raw = JSON.stringify({
    type: 'gemini',
    toolCalls: [{ id: 't4', name: 'read_file', args: { file_path: 'd.md' } }],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps[0]!.timestamp).toBeUndefined();
});

// D-gemini-nonarray-messages-envelope (parity vs quorum/normalizers.py
// _gemini_messages :467-469): an object whose `messages` key is present but
// NOT an array takes the `"messages" in data` branch and iterates that value,
// filtering to dicts → []. The envelope object itself is NOT treated as a
// single message, so no tool call is emitted. (TS previously fell through to
// pushing the whole envelope, fabricating a tool call from its top-level keys.)
test('object with a present-but-non-array messages key yields no tool calls', () => {
  const raw = JSON.stringify({
    messages: 'hello',
    type: 'gemini',
    toolCalls: [
      { id: 'g1', name: 'run_shell_command', args: { command: 'ls' } },
    ],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps).toEqual([]);
});

// D-gemini-nondict-args-rawargs (parity vs quorum/normalizers.py
// _normalize_gemini_tool_call :490): a tool call whose `args` is a non-dict
// (string/number/array/null) is wrapped as {raw_args: <value>}, preserving the
// raw payload. (TS previously spread a string into char-indexed keys.)
test('non-dict tool-call args are wrapped as {raw_args: <value>}', () => {
  const raw = JSON.stringify({
    messages: [
      {
        type: 'gemini',
        toolCalls: [{ id: 'g1', name: 'run_shell_command', args: 'rawstring' }],
      },
    ],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe('Bash');
  expect(tc.arguments).toEqual({ raw_args: 'rawstring' });
});

// ---------------------------------------------------------------------------
// ATIF usage metrics (spec: 2026-06-15-atif-usage-unification.md)
//
// gemini-cli rewrites a running `messages[]` snapshot on each JSONL line, so the
// same assistant turn (same row `id`) is recorded more than once — once before
// tool calls and once with them — carrying identical `tokens`. The normalizer
// must sum each distinct row id ONCE. Field mapping per the contract:
// input→prompt_tokens, output+thoughts→completion_tokens, cached→cached_tokens.
// No per-message cost in gemini logs → cost_usd stays unset (priced downstream).
// model → step.model_name; provider "google" stamped on the row → extra.provider.
// ---------------------------------------------------------------------------

// Real-shaped fixture from a live gemini-cli run (mirrors test/obol-fallback.test.ts):
// turn `a1` is recorded TWICE with the same id — once without toolCalls, once
// with — so its tokens must be counted exactly once. Turn `a2` is text-only
// (tokens, no toolCalls).
const usageLog = [
  { sessionId: 's', startTime: '2026-06-15T02:07:00.000Z', kind: 'main' },
  {
    id: 'u1',
    timestamp: '2026-06-15T02:08:00.000Z',
    type: 'user',
    content: 'go',
  },
  {
    id: 'a1',
    timestamp: '2026-06-15T02:08:18.488Z',
    type: 'gemini',
    content: '',
    tokens: {
      input: 15813,
      output: 27,
      cached: 0,
      thoughts: 1005,
      tool: 0,
      total: 16845,
    },
    model: 'gemini-3.5-flash',
  },
  {
    id: 'a1',
    timestamp: '2026-06-15T02:08:18.500Z',
    type: 'gemini',
    content: '',
    tokens: {
      input: 15813,
      output: 27,
      cached: 0,
      thoughts: 1005,
      tool: 0,
      total: 16845,
    },
    model: 'gemini-3.5-flash',
    toolCalls: [
      {
        id: 'write_file__x',
        name: 'write_file',
        args: { file_path: 'hello.txt' },
      },
    ],
  },
  {
    id: 'a2',
    timestamp: '2026-06-15T02:08:25.000Z',
    type: 'gemini',
    content: 'done',
    tokens: {
      input: 16960,
      output: 14,
      cached: 7,
      thoughts: 150,
      tool: 0,
      total: 17131,
    },
    model: 'gemini-3.5-flash',
  },
]
  .map((r) => JSON.stringify(r))
  .join('\n');

test('usage: maps gemini tokens onto step.metrics with thoughts folded into completion', () => {
  const traj = normalizeGemini(usageLog, '0.1.18');
  expect(validateTrajectory(traj).ok).toBe(true);

  const withMetrics = traj.steps.filter((s) => s.metrics !== undefined);
  // Two distinct token-bearing turns (a1, a2) → two metrics-bearing steps.
  expect(withMetrics.length).toBe(2);

  // a1: input 15813, output 27 + thoughts 1005, cached 0
  const a1 = withMetrics[0]!;
  expect(a1.metrics).toEqual({
    prompt_tokens: 15813,
    completion_tokens: 27 + 1005,
    cached_tokens: 0,
  });
  expect(a1.model_name).toBe('gemini-3.5-flash');
  expect(a1.extra?.['provider']).toBe('google');

  // a2: input 16960, output 14 + thoughts 150, cached 7
  const a2 = withMetrics[1]!;
  expect(a2.metrics).toEqual({
    prompt_tokens: 16960,
    completion_tokens: 14 + 150,
    cached_tokens: 7,
  });
  expect(a2.model_name).toBe('gemini-3.5-flash');
});

test('usage: gemini dedups the running-snapshot turn (same id) so tokens count once', () => {
  const traj = normalizeGemini(usageLog, '0.1.18');
  const totals = traj.steps.reduce(
    (acc, s) => {
      if (!s.metrics) return acc;
      acc.prompt += s.metrics.prompt_tokens ?? 0;
      acc.completion += s.metrics.completion_tokens ?? 0;
      acc.cached += s.metrics.cached_tokens ?? 0;
      return acc;
    },
    { prompt: 0, completion: 0, cached: 0 },
  );
  // a1 counted once despite appearing on two snapshot lines, plus a2.
  expect(totals.prompt).toBe(15813 + 16960);
  expect(totals.completion).toBe(27 + 1005 + 14 + 150);
  expect(totals.cached).toBe(0 + 7);
});

test("usage: gemini turn metrics attach to the turn's first emitted step", () => {
  // A turn whose first snapshot already carries its tool call gets the metrics
  // on that tool-call step (no earlier metrics-only step to claim them).
  const raw = JSON.stringify({
    id: 'a1',
    type: 'gemini',
    tokens: {
      input: 100,
      output: 5,
      cached: 0,
      thoughts: 2,
      tool: 0,
      total: 107,
    },
    model: 'gemini-3.5-flash',
    toolCalls: [
      { id: 'w1', name: 'write_file', args: { file_path: 'hello.txt' } },
    ],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  const writeStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Write',
  );
  expect(writeStep).toBeDefined();
  expect(writeStep!.metrics?.prompt_tokens).toBe(100);
  expect(writeStep!.metrics?.completion_tokens).toBe(5 + 2);
  expect(writeStep!.model_name).toBe('gemini-3.5-flash');
});

test('usage: gemini turn whose first snapshot lacks tool calls gets a metrics-only step', () => {
  // Running-snapshot reality: the same id appears first without tool calls, then
  // with them. Tokens are counted once, on the first snapshot's metrics-only
  // step; the later tool-call step (same id) carries no metrics (already counted).
  const traj = normalizeGemini(usageLog, '0.1.18');
  const a1Metrics = traj.steps.find((s) => s.metrics?.prompt_tokens === 15813);
  expect(a1Metrics).toBeDefined();
  expect(a1Metrics!.tool_calls).toBeUndefined();
  const writeStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === 'Write',
  );
  expect(writeStep!.metrics).toBeUndefined();
});

test('usage: gemini text-only turn (no tool calls) still surfaces its tokens', () => {
  // a2 has tokens but no toolCalls; without a dedicated metrics step its usage
  // would be silently dropped from the trajectory.
  const traj = normalizeGemini(usageLog, '0.1.18');
  const a2 = traj.steps.find((s) => s.metrics?.prompt_tokens === 16960);
  expect(a2).toBeDefined();
  expect(a2!.source).toBe('agent');
  expect(a2!.tool_calls).toBeUndefined();
});

test('usage: no tokens on any row leaves step.metrics unset', () => {
  const raw = JSON.stringify({
    type: 'gemini',
    toolCalls: [{ id: 'x', name: 'read_file', args: { file_path: 'a' } }],
  });
  const traj = normalizeGemini(raw, '0.1.18');
  expect(traj.steps.every((s) => s.metrics === undefined)).toBe(true);
});
