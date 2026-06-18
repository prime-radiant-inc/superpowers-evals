import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeGoose } from '../src/normalize/goose.ts';

// ---------------------------------------------------------------------------
// Harbor fixtures — ported from
//   tests/unit/agents/installed/test_goose_mcp.py
//   class TestGooseAtifTextFallback (SAMPLE_LOG) and
//   class TestGooseAtifStreamJson  (SAMPLE_JSONL)
// ---------------------------------------------------------------------------

// ── Text-path fixture (legacy plain-text format, no tokens) ──────────────────
const SAMPLE_TEXT_LOG = `Loading recipe: harbor-task
Description: harbor task recipe

starting session | provider: anthropic model: claude-sonnet-4-5-20250929
    session id: 20260216_1
    working directory: /app
I'll help you complete this task.
─── shell | developer ──────────────────────────
command: ls /app

file1.txt
file2.txt
Now let me read the file.
─── text_editor | developer ──────────────────────────
path: /app/file1.txt
command: read

Hello World
Task complete.
`;

// ── Stream-JSON fixture (current default format, total_tokens only) ──────────
const SAMPLE_JSONL = [
  JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-user-1',
      role: 'user',
      created: 1708000000,
      content: [{ type: 'text', text: 'Complete the task.' }],
    },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-asst-1',
      role: 'assistant',
      created: 1708000001,
      content: [
        { type: 'thinking', text: 'I need to list files first.' },
        { type: 'text', text: 'Let me check the directory contents.' },
        {
          type: 'toolRequest',
          id: 'tool-1',
          toolCall: {
            status: 'success',
            value: {
              name: 'shell',
              arguments: { command: 'ls /app' },
            },
          },
        },
        {
          type: 'toolResponse',
          id: 'tool-1',
          toolResult: {
            status: 'success',
            value: {
              content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }],
              isError: false,
            },
          },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-asst-2',
      role: 'assistant',
      created: 1708000002,
      content: [{ type: 'text', text: 'Task complete.' }],
    },
  }),
  JSON.stringify({ type: 'complete', total_tokens: 1500 }),
].join('\n');

// ── Stream-JSON fixture with input/output split (goose >= 1.37) ─────────────
const INPUT_OUTPUT_JSONL = [
  JSON.stringify({
    type: 'message',
    message: {
      id: 'msg-asst-1',
      role: 'assistant',
      created: 1708000001,
      content: [{ type: 'text', text: 'Task complete.' }],
    },
  }),
  JSON.stringify({
    type: 'complete',
    input_tokens: 900,
    output_tokens: 600,
    total_tokens: 1500,
  }),
].join('\n');

// ===========================================================================
// TEXT-PATH TESTS
// ===========================================================================

test('text path: validateTrajectory returns ok', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const result = validateTrajectory(traj);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

test('text path: schema_version is ATIF_SCHEMA_VERSION', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
});

test('text path: agent name and version', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, '1.2.3');
  expect(traj.agent.name).toBe('goose');
  expect(traj.agent.version).toBe('1.2.3');
});

test('text path: produces steps', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  expect(traj.steps.length).toBeGreaterThan(0);
});

test('text path: step_ids are sequential from 1', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  traj.steps.forEach((step, i) => {
    expect(step.step_id).toBe(i + 1);
  });
});

test('text path: tool-call steps have tool_calls and observations', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  expect(toolSteps.length).toBe(2);
  for (const step of toolSteps) {
    expect(step.observation).toBeDefined();
    expect(step.observation?.results.length).toBe(1);
  }
});

test('text path: tool names are canonicalized via GOOSE_TOOL_MAP', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  const names = toolSteps.map((s) => s.tool_calls?.[0]?.function_name ?? '');
  // shell → Bash, text_editor → Edit
  expect(names).toContain('Bash');
  expect(names).toContain('Edit');
});

test('text path: tool result source_call_id matches tool_call_id on same step', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  for (const step of toolSteps) {
    const callId = step.tool_calls?.[0]?.tool_call_id;
    const obsCallId = step.observation?.results[0]?.source_call_id;
    expect(obsCallId).toBe(callId);
  }
});

test('text path: tool output is populated in observation', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  // first tool call: shell → ls /app → file1.txt\nfile2.txt
  const firstObs = toolSteps[0]?.observation?.results[0]?.content;
  expect(typeof firstObs).toBe('string');
  expect(firstObs).toContain('file1.txt');
});

test('text path: no metrics (text log carries no tokens)', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
  if (traj.final_metrics) {
    expect(traj.final_metrics.total_prompt_tokens).toBeUndefined();
    expect(traj.final_metrics.total_completion_tokens).toBeUndefined();
  }
});

test('text path: agent text steps have message populated', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const textSteps = traj.steps.filter(
    (s) => (!s.tool_calls || s.tool_calls.length === 0) && s.source === 'agent',
  );
  expect(textSteps.length).toBeGreaterThan(0);
  for (const step of textSteps) {
    expect(typeof step.message).toBe('string');
    expect((step.message as string).length).toBeGreaterThan(0);
  }
});

test('text path: empty log returns minimal valid trajectory', () => {
  const traj = normalizeGoose('', 'stable');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  expect(traj.steps.length).toBeGreaterThanOrEqual(1);
});

// ===========================================================================
// STREAM-JSON PATH TESTS
// ===========================================================================

test('stream path: validateTrajectory returns ok', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  const result = validateTrajectory(traj);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

test('stream path: schema_version is ATIF_SCHEMA_VERSION', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
});

test('stream path: agent name and version', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, '1.37.0');
  expect(traj.agent.name).toBe('goose');
  expect(traj.agent.version).toBe('1.37.0');
});

test('stream path: produces 3 steps (user + assistant-with-tool + assistant-text)', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  expect(traj.steps.length).toBe(3);
  traj.steps.forEach((step, i) => {
    expect(step.step_id).toBe(i + 1);
  });
});

test('stream path: user step has message', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  const userSteps = traj.steps.filter((s) => s.source === 'user');
  expect(userSteps.length).toBe(1);
  expect(userSteps[0]?.message).toBe('Complete the task.');
});

test('stream path: assistant tool-call step has reasoning, message, tool_calls, observation', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  expect(toolSteps.length).toBe(1);
  const step = toolSteps[0];
  expect(step).toBeDefined();
  if (!step) return;

  expect(step.reasoning_content).toBe('I need to list files first.');
  expect(step.message).toBe('Let me check the directory contents.');

  expect(step.tool_calls?.length).toBe(1);
  const tc = step.tool_calls?.[0];
  expect(tc?.tool_call_id).toBe('tool-1');
  expect(tc?.function_name).toBe('Bash');
  expect(tc?.arguments).toEqual({ command: 'ls /app' });

  expect(step.observation).toBeDefined();
  const obs = step.observation?.results[0];
  expect(obs?.source_call_id).toBe('tool-1');
  expect(obs?.content).toBe('file1.txt\nfile2.txt');
});

test('stream path: final assistant text step has message', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  const lastStep = traj.steps[traj.steps.length - 1];
  expect(lastStep?.source).toBe('agent');
  expect(lastStep?.message).toBe('Task complete.');
});

test('stream path: total_tokens in final_metrics.extra when only total provided', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  expect(traj.final_metrics).toBeDefined();
  expect(traj.final_metrics?.extra).toEqual({ total_tokens: 1500 });
  // SINGLE-SOURCE: no per-step metrics
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

test('stream path: input/output split populates final_metrics (goose >= 1.37)', () => {
  const traj = normalizeGoose(INPUT_OUTPUT_JSONL, 'stable');
  expect(traj.final_metrics?.total_prompt_tokens).toBe(900);
  expect(traj.final_metrics?.total_completion_tokens).toBe(600);
  expect(traj.final_metrics?.extra).toEqual({ total_tokens: 1500 });
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

test('stream path: tool names are canonicalized (shell → Bash)', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  const names = toolSteps.map((s) => s.tool_calls?.[0]?.function_name ?? '');
  expect(names).toContain('Bash');
});

test('stream path: error event creates an agent step', () => {
  const jsonl = JSON.stringify({
    type: 'error',
    error: 'Something went wrong',
  });
  const traj = normalizeGoose(jsonl, 'stable');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]?.source).toBe('agent');
  expect(typeof traj.steps[0]?.message).toBe('string');
  expect(traj.steps[0]?.message as string).toContain('[error]');
  expect(traj.steps[0]?.message as string).toContain('Something went wrong');
});

test('stream path: empty JSONL returns minimal valid trajectory', () => {
  const traj = normalizeGoose('', 'stable');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
});

test('stream path: invalid JSON lines are skipped gracefully', () => {
  const jsonl = `not json\n${JSON.stringify({ type: 'complete', total_tokens: 10 })}`;
  const traj = normalizeGoose(jsonl, 'stable');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
});

// ── Streaming chunk aggregation by message id ────────────────────────────────
test('stream path: streaming chunks with same message id are aggregated', () => {
  const jsonl = [
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: ' world' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: '!' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [
          {
            type: 'toolRequest',
            id: 'tc-1',
            toolCall: {
              status: 'success',
              value: { name: 'shell', arguments: { command: 'ls' } },
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-user-resp',
        role: 'user',
        content: [
          {
            type: 'toolResponse',
            id: 'tc-1',
            toolResult: {
              status: 'success',
              value: {
                content: [{ type: 'text', text: 'file.txt' }],
                isError: false,
              },
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-2',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        id: 'msg-2',
        role: 'assistant',
        content: [{ type: 'text', text: '.' }],
      },
    }),
    JSON.stringify({ type: 'complete', total_tokens: 500 }),
  ].join('\n');

  const traj = normalizeGoose(jsonl, 'stable');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);

  expect(traj.steps.length).toBe(2);

  const step1 = traj.steps[0];
  expect(step1?.source).toBe('agent');
  expect(step1?.message).toBe('Hello world!');
  expect(step1?.tool_calls?.length).toBe(1);
  expect(step1?.tool_calls?.[0]?.function_name).toBe('Bash');
  expect(step1?.observation).toBeDefined();
  expect(step1?.observation?.results[0]?.content).toBe('file.txt');

  const step2 = traj.steps[1];
  expect(step2?.source).toBe('agent');
  expect(step2?.message).toBe('Done.');
  expect(step2?.tool_calls).toBeUndefined();
});

// ── Disjoint-bucket conservation test ───────────────────────────────────────
test('stream path: disjoint conservation — prompt + completion = total_tokens', () => {
  const traj = normalizeGoose(INPUT_OUTPUT_JSONL, 'stable');
  const fm = traj.final_metrics;
  expect(fm).toBeDefined();
  const prompt = fm?.total_prompt_tokens ?? 0;
  const completion = fm?.total_completion_tokens ?? 0;
  const total = (fm?.extra?.['total_tokens'] as number) ?? 0;
  expect(prompt + completion).toBe(total);
});

// ── Detection tests ──────────────────────────────────────────────────────────
test('detection: stream-JSON layout parsed correctly (reasoning_content present)', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  expect(toolSteps.length).toBe(1);
  expect(toolSteps[0]?.reasoning_content).toBe('I need to list files first.');
});

test('detection: text layout parsed correctly (arguments from key:value lines)', () => {
  const traj = normalizeGoose(SAMPLE_TEXT_LOG, 'stable');
  const toolSteps = traj.steps.filter(
    (s) => s.tool_calls && s.tool_calls.length > 0,
  );
  expect(toolSteps.length).toBe(2);
  const shellStep = toolSteps[0];
  expect(shellStep?.tool_calls?.[0]?.function_name).toBe('Bash');
  expect(shellStep?.tool_calls?.[0]?.arguments?.['command']).toBe('ls /app');
});

// ── Single-source invariant ──────────────────────────────────────────────────
test('single-source: no per-step metrics when final_metrics is used (stream path)', () => {
  const traj = normalizeGoose(SAMPLE_JSONL, 'stable');
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

// ── No complete event → no token fields ─────────────────────────────────────
test('stream path: no complete event → no final_metrics token fields', () => {
  const jsonl = JSON.stringify({
    type: 'message',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    },
  });
  const traj = normalizeGoose(jsonl, 'stable');
  const result = validateTrajectory(traj);
  expect(result.ok).toBe(true);
  if (traj.final_metrics) {
    expect(traj.final_metrics.extra).toBeUndefined();
    expect(traj.final_metrics.total_prompt_tokens).toBeUndefined();
    expect(traj.final_metrics.total_completion_tokens).toBeUndefined();
  }
});
