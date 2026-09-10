import { expect, test } from 'bun:test';
import { nativeTextBytes, withNativeEvidence } from '../src/atif/provenance.ts';
import { normalizeClaudeLegacy } from '../src/normalize/claude.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { normalizePi } from '../src/normalize/pi.ts';
import {
  NATIVE_RESULT_CASES,
  nativeDurationResult,
  nativeReadResult,
} from './fixtures/diagnosis/native-results.ts';

test('withNativeEvidence preserves existing extras and replaces only quorum source', () => {
  expect(
    withNativeEvidence(
      { provider: 'openai-codex', quorum_source: { lines: [99] } },
      { lines: [2, 4], origin: 'unknown', timestamp: '2026-09-01T00:00:02Z' },
    ),
  ).toEqual({
    provider: 'openai-codex',
    quorum_source: {
      lines: [2, 4],
      origin: 'unknown',
      timestamp: '2026-09-01T00:00:02Z',
    },
  });
});

test('native text bytes include input_text blocks and leave non-text size unknown', () => {
  expect(
    nativeTextBytes([
      { type: 'input_text', text: 'é' },
      { type: 'image', data: 'not-counted' },
    ]),
  ).toBe(2);
  expect(nativeTextBytes([{ type: 'image', data: 'unknown' }])).toBeUndefined();
});

test('Claude bundles contributor lines and locates call, result, and usage independently', () => {
  const first = {
    type: 'assistant',
    uuid: 'assistant-1',
    timestamp: '2026-09-01T00:00:01Z',
    message: {
      id: 'message-1',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'checking' }],
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
  const call = {
    type: 'assistant',
    uuid: 'assistant-2',
    timestamp: '2026-09-01T00:00:02Z',
    message: {
      id: 'message-1',
      model: 'claude-sonnet-5',
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'Agent',
          input: { prompt: 'inspect it' },
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  };
  const result = {
    type: 'user',
    uuid: 'result-1',
    timestamp: '2026-09-01T00:00:03Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: [{ type: 'text', text: 'é' }],
        },
      ],
    },
    toolUseResult: { agentId: 'child-7' },
  };
  const raw = [
    JSON.stringify(first),
    '{malformed',
    JSON.stringify(call),
    '',
    JSON.stringify(result),
    JSON.stringify(result),
  ].join('\n');

  const step = normalizeClaudeLegacy(raw, 'unit').steps[0]!;
  expect(step.extra?.['quorum_source']).toEqual({ lines: [1, 3] });
  expect(step.tool_calls![0]!.extra).toMatchObject({
    quorum_source: { lines: [3] },
    quorum_child: { relationship: 'spawned', id: 'child-7' },
  });
  expect(step.metrics).toEqual({
    prompt_tokens: 12,
    completion_tokens: 3,
    extra: {
      quorum_source: {
        lines: [3],
        timestamp: '2026-09-01T00:00:02Z',
      },
    },
  });
  expect(step.observation!.results).toHaveLength(1);
  expect(step.observation!.results[0]!.extra).toMatchObject({
    quorum_source: {
      lines: [5],
      origin: 'unknown',
      timestamp: '2026-09-01T00:00:03Z',
      contentBytes: 2,
    },
    quorum_child: { relationship: 'spawned', id: 'child-7' },
  });
});

test('Claude sidechain identity marks parent-authored user input without changing ATIF source', () => {
  const raw = JSON.stringify({
    type: 'user',
    isSidechain: true,
    agentId: 'agent-child',
    sessionId: 'shared-session',
    message: { role: 'user', content: 'review this branch' },
  });
  const trajectory = normalizeClaudeLegacy(raw, 'unit');
  expect(trajectory.session_id).toBe('shared-session');
  expect(trajectory.agent.extra).toMatchObject({
    agent_ids: ['agent-child'],
    is_sidechain: true,
  });
  expect(trajectory.steps[0]).toMatchObject({
    source: 'user',
    extra: { quorum_source: { lines: [1], origin: 'parent' } },
  });
});

test('Claude classifies only evidenced human, injected, parent, and unknown user origins', () => {
  const rows = [
    {
      type: 'user',
      isSidechain: false,
      origin: { kind: 'human' },
      promptSource: 'typed',
      userType: 'external',
      message: { role: 'user', content: 'human request' },
    },
    {
      type: 'user',
      isMeta: true,
      sourceToolUseID: 'tool-1',
      userType: 'external',
      message: { role: 'user', content: 'injected context' },
    },
    {
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'parent dispatch' },
    },
    {
      type: 'user',
      userType: 'external',
      message: { role: 'user', content: 'ambiguous input' },
    },
    {
      type: 'user',
      origin: { kind: 'human' },
      promptSource: 'typed',
      userType: 'external',
      isMeta: true,
      sourceToolUseID: 'tool-2',
      message: { role: 'user', content: 'conflicting evidence' },
    },
  ];
  const trajectory = normalizeClaudeLegacy(
    rows.map((row) => JSON.stringify(row)).join('\n'),
    'unit',
  );

  expect(
    trajectory.steps.map((step) => {
      const source = step.extra?.['quorum_source'] as
        | { origin?: unknown }
        | undefined;
      return source?.origin;
    }),
  ).toEqual(['human', 'injected', 'parent', 'unknown', 'unknown']);
  expect(trajectory.steps.map((step) => step.source)).toEqual([
    'user',
    'user',
    'user',
    'user',
    'user',
  ]);
});

test('Claude retains compaction boundaries as non-step ATIF evidence', () => {
  const trajectory = normalizeClaudeLegacy(
    [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-09-01T00:00:01Z',
        compactMetadata: { trigger: 'auto', preTokens: 1234 },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'continued' }] },
      }),
    ].join('\n'),
    'unit',
  );
  expect(trajectory.extra?.['quorum_boundaries']).toEqual([
    {
      kind: 'compaction',
      evidence: { lines: [1], timestamp: '2026-09-01T00:00:01Z' },
    },
  ]);
  expect(trajectory.steps).toHaveLength(1);
});

test('Codex preserves parent identity, Agent child evidence, boundaries, and one request usage', () => {
  const request = {
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 20,
    total_tokens: 120,
  };
  const usage = (timestamp: string) =>
    JSON.stringify({
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'token_count',
        info: { total_token_usage: request, last_token_usage: request },
      },
    });
  const raw = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child-thread',
        session_id: 'parent-thread',
        parent_thread_id: 'parent-thread',
        thread_source: 'subagent',
        agent_path: '/root/reviewer',
      },
    }),
    '{bad',
    JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-09-01T00:00:01Z',
      payload: { turn_id: 'turn-1', model: 'gpt-5.6-sol' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-01T00:00:02Z',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call-1',
        arguments: JSON.stringify({ task: 'review', fork_turns: 'all' }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-01T00:00:03Z',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({ output: 'done', agent_id: 'child-2' }),
      },
    }),
    usage('2026-09-01T00:00:04Z'),
    usage('2026-09-01T00:00:05Z'),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-09-01T00:00:06Z',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    }),
  ].join('\n');

  const trajectory = normalizeCodex(raw, 'unit');
  expect(trajectory.session_id).toBe('child-thread');
  expect(trajectory.agent.extra).toMatchObject({
    parent_session_id: 'parent-thread',
    parent_thread_id: 'parent-thread',
    thread_source: 'subagent',
    agent_path: '/root/reviewer',
  });
  expect(trajectory.extra?.['quorum_boundaries']).toEqual([
    {
      kind: 'turn',
      phase: 'start',
      evidence: { lines: [3], timestamp: '2026-09-01T00:00:01Z' },
    },
    {
      kind: 'task',
      phase: 'complete',
      evidence: { lines: [8], timestamp: '2026-09-01T00:00:06Z' },
    },
  ]);
  const step = trajectory.steps[0]!;
  expect(step.extra?.['quorum_source']).toEqual({ lines: [4] });
  expect(step.tool_calls![0]!.extra).toMatchObject({
    quorum_source: { lines: [4] },
    quorum_child: { relationship: 'fork', id: 'child-2' },
  });
  expect(step.observation!.results[0]!.extra).toMatchObject({
    quorum_source: {
      lines: [5],
      origin: 'unknown',
      timestamp: '2026-09-01T00:00:03Z',
      contentBytes: 4,
    },
    quorum_child: { relationship: 'fork', id: 'child-2' },
  });
  expect(
    trajectory.steps.filter((candidate) => candidate.metrics),
  ).toHaveLength(1);
  expect(step.metrics).toEqual({
    prompt_tokens: 40,
    cached_tokens: 60,
    completion_tokens: 20,
    extra: {
      quorum_source: {
        lines: [6],
        timestamp: '2026-09-01T00:00:04Z',
      },
    },
  });
  expect(trajectory.final_metrics?.extra).toMatchObject({
    total_cached_tokens: 60,
    quorum_source: {
      lines: [7],
      timestamp: '2026-09-01T00:00:05Z',
    },
  });
});

test('Codex child user messages remain ATIF user steps with parent origin', () => {
  const trajectory = normalizeCodex(
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'child-thread',
          parent_thread_id: 'parent-thread',
          thread_source: 'subagent',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-01T00:00:01Z',
        payload: {
          type: 'agent_message',
          id: 'message-link',
          author: '/root',
          recipient: '/root/reviewer',
          content: [
            { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
            { type: 'encrypted_content', encrypted_content: 'opaque-bytes' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'review the branch' }],
        },
      }),
    ].join('\n'),
    'unit',
  );
  expect(trajectory.steps[0]).toMatchObject({
    source: 'user',
    message: 'review the branch',
    extra: { quorum_source: { lines: [3], origin: 'parent' } },
  });
  expect(trajectory.extra?.['quorum_communications']).toEqual([
    {
      id: 'message-link',
      author: '/root',
      recipient: '/root/reviewer',
      contentKinds: ['input_text', 'encrypted_content'],
      opaqueContent: true,
      evidence: { lines: [2], timestamp: '2026-09-01T00:00:01Z' },
    },
  ]);
});

test('Codex reasoning provenance skips intervening user and system messages', () => {
  const trajectory = normalizeCodex(
    [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'reasoning', summary: ['reasoned privately'] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'follow-up' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'constraint' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer' }],
        },
      }),
    ].join('\n'),
    'unit',
  );

  expect(trajectory.steps).toMatchObject([
    {
      source: 'user',
      extra: { quorum_source: { lines: [2], origin: 'unknown' } },
    },
    {
      source: 'system',
      extra: { quorum_source: { lines: [3] } },
    },
    {
      source: 'agent',
      reasoning_content: 'reasoned privately',
      extra: { quorum_source: { lines: [1, 4] } },
    },
  ]);
});

test('Codex distinguishes explicit context forks from fresh analyst spawns', () => {
  const call = (id: string, forkTurns: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: id,
        arguments: JSON.stringify({
          message: 'inspect',
          fork_turns: forkTurns,
        }),
      },
    });
  const trajectory = normalizeCodex(
    [call('fresh', 'none'), call('forked', 'all')].join('\n'),
    'unit',
  );
  expect(
    trajectory.steps.map(
      (step) => step.tool_calls![0]!.extra?.['quorum_child'],
    ),
  ).toEqual([{ relationship: 'spawned' }, { relationship: 'fork' }]);
});

test('Codex Agent results retain an evidenced child task name', () => {
  const trajectory = normalizeCodex(
    [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: 'spawn-1',
          arguments: JSON.stringify({ message: 'review' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'spawn-1',
          output: JSON.stringify({ task_name: '/root/code_review' }),
        },
      }),
    ].join('\n'),
    'unit',
  );
  const step = trajectory.steps[0]!;

  expect(step.tool_calls![0]!.extra?.['quorum_child']).toEqual({
    relationship: 'unknown',
    name: '/root/code_review',
  });
  expect(step.observation!.results[0]!.extra?.['quorum_child']).toEqual({
    relationship: 'unknown',
    name: '/root/code_review',
  });
});

test('Pi result keeps its own line, time, and content size', () => {
  const raw = [
    { type: 'session', id: 'unit-session' },
    {
      type: 'message',
      timestamp: '2026-09-01T00:00:01Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'bash',
            arguments: { command: 'true' },
          },
        ],
      },
    },
    {
      type: 'message',
      timestamp: '2026-09-01T00:00:02Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const step = normalizePi(raw, 'unit').steps[0]!;
  expect(step.timestamp).toBe('2026-09-01T00:00:01Z');
  expect(step.extra?.['quorum_source']).toMatchObject({ lines: [2] });
  expect(step.tool_calls![0]!.extra?.['quorum_source']).toEqual({ lines: [2] });
  expect(step.observation!.results[0]!.extra?.['quorum_source']).toMatchObject({
    lines: [3],
    origin: 'unknown',
    timestamp: '2026-09-01T00:00:02Z',
    contentBytes: 2,
  });
});

test('Pi split tool steps share the assistant line while usage and child details occur once', () => {
  const raw = [
    JSON.stringify({ type: 'session', id: 'pi-child', cwd: '/work' }),
    '',
    '{bad',
    JSON.stringify({
      type: 'message',
      timestamp: '2026-09-01T00:00:01Z',
      message: {
        role: 'assistant',
        model: 'gpt-5.6-sol',
        usage: { input: 5, output: 2, cacheRead: 1 },
        content: [
          {
            type: 'toolCall',
            id: 'call-agent',
            name: 'subagent',
            arguments: { agent: 'reviewer', task: 'review' },
          },
          {
            type: 'toolCall',
            id: 'call-read',
            name: 'read',
            arguments: { path: 'x' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-09-01T00:00:02Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-agent',
        toolName: 'subagent',
        content: [{ type: 'text', text: 'reviewed' }],
        details: {
          mode: 'single',
          runId: 'run-7',
          results: [{ sessionFile: '/sessions/run-7/session.jsonl' }],
        },
      },
    }),
  ].join('\n');
  const steps = normalizePi(raw, 'unit').steps;
  expect(steps).toHaveLength(2);
  expect(steps.map((step) => step.extra?.['quorum_source'])).toEqual([
    { lines: [4] },
    { lines: [4] },
  ]);
  expect(steps.filter((step) => step.metrics)).toHaveLength(1);
  expect(steps[0]!.metrics?.extra?.['quorum_source']).toEqual({
    lines: [4],
    timestamp: '2026-09-01T00:00:01Z',
  });
  expect(steps[0]!.tool_calls![0]!.extra).toMatchObject({
    quorum_child: {
      relationship: 'spawned',
      id: 'run-7',
      path: '/sessions/run-7/session.jsonl',
    },
  });
  expect(steps[0]!.observation!.results[0]!.extra).toMatchObject({
    quorum_child: {
      relationship: 'spawned',
      id: 'run-7',
      path: '/sessions/run-7/session.jsonl',
    },
  });
});

// Synthetic native records; these test capture mechanics, not analyst behavior.
function syntheticPiBatch(tasks: unknown[], results: unknown[]) {
  return normalizePi(
    [
      { type: 'session', id: 'synthetic-controller' },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'assistant',
          usage: { input: 17, output: 3 },
          content: [
            {
              type: 'toolCall',
              id: 'batch',
              name: 'subagent',
              arguments: { tasks },
            },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'toolResult',
          toolCallId: 'batch',
          content: [{ type: 'text', text: 'done' }],
          details: { mode: 'parallel', runId: 'parent-batch', results },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
    'synthetic',
  );
}

test('Pi parallel batch retains ordered separate child paths and prompts without repeated usage', () => {
  const trajectory = syntheticPiBatch(
    [
      { agent: 'analyst', task: 'inspect A' },
      { agent: 'analyst', task: 'inspect B' },
    ],
    [
      { sessionFile: '/sessions/a.jsonl', usage: { input: 101, output: 11 } },
      { sessionFile: '/sessions/b.jsonl', usage: { input: 202, output: 22 } },
    ],
  );
  const step = trajectory.steps[0]!;
  const expected = [
    {
      index: 0,
      prompt: 'inspect A',
      child: { relationship: 'spawned', path: '/sessions/a.jsonl' },
    },
    {
      index: 1,
      prompt: 'inspect B',
      child: { relationship: 'spawned', path: '/sessions/b.jsonl' },
    },
  ];
  expect(step.tool_calls![0]!.extra?.['quorum_dispatches']).toEqual(expected);
  expect(step.observation!.results[0]!.extra?.['quorum_dispatches']).toEqual(
    expected,
  );
  expect(step.tool_calls![0]!.extra?.['quorum_source']).toEqual({ lines: [2] });
  expect(step.observation!.results[0]!.extra?.['quorum_source']).toMatchObject({
    lines: [3],
  });
  expect(step.observation!.results[0]!.extra?.['quorum_child']).toBeUndefined();
  expect(step.metrics).toMatchObject({
    prompt_tokens: 17,
    completion_tokens: 3,
  });
  expect(trajectory.steps.filter((s) => s.metrics)).toHaveLength(1);
  expect(trajectory.final_metrics).toBeUndefined();
});

test('Pi malformed batches and unqualified task count expansion do not invent relationships', () => {
  for (const [tasks, results] of [
    [[{ task: 'a' }, { task: 'b' }], [{ sessionFile: '/a' }]],
    [[{ task: 'a' }], [{}]],
    [
      [{ task: 'a' }, { task: 'b' }],
      [{ sessionFile: '/a' }, { sessionFile: '/a' }],
    ],
    [[{ task: 'a', count: 2 }], [{ sessionFile: '/a' }, { sessionFile: '/b' }]],
  ]) {
    const step = syntheticPiBatch(tasks!, results!).steps[0]!;
    expect(step.tool_calls![0]!.extra?.['quorum_dispatches']).toBeUndefined();
    expect(
      step.observation!.results[0]!.extra?.['quorum_child'],
    ).toBeUndefined();
  }
});

// Literal Unicode + JSON escaping: record bytes include the native envelope,
// while content bytes measure only decoded textual result content.
for (const [name, normalizer, call, result, expectedRecordBytes] of [
  [
    'Claude',
    normalizeClaudeLegacy,
    '{"type":"assistant","message":{"id":"a","content":[{"type":"tool_use","id":"x","name":"Read","input":{}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"é\\n"}]}}',
    97,
  ],
  [
    'Codex',
    normalizeCodex,
    '{"type":"response_item","payload":{"type":"function_call","name":"read_file","call_id":"x","arguments":"{}"}}',
    '{"type":"response_item","payload":{"type":"function_call_output","call_id":"x","output":"é\\n"}}',
    96,
  ],
  [
    'Pi',
    normalizePi,
    '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"x","name":"read","arguments":{}}]}}',
    '{"type":"message","message":{"role":"toolResult","toolCallId":"x","content":"é\\n"}}',
    84,
  ],
] as const)
  test(`${name} retains literal native result record bytes separately from decoded content bytes`, () => {
    for (const newline of ['\n', '\r\n']) {
      const t = normalizer(`${call}${newline}${result}${newline}`, 'synthetic');
      expect(
        t.steps[0]!.observation!.results[0]!.extra?.['quorum_source'],
      ).toMatchObject({
        lines: [2],
        contentBytes: 3,
        recordBytes: expectedRecordBytes,
      });
      expect(t.steps.filter((s) => s.metrics)).toHaveLength(0);
    }
  });

test('Claude retains native turn_duration completion and reported duration without pricing it', () => {
  const t = normalizeClaudeLegacy(
    [
      '{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Synthetic task"}}',
      '{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"id":"answer","content":[{"type":"text","text":"Done"}]}}',
      '{"type":"system","subtype":"turn_duration","timestamp":"2026-01-01T00:00:05Z","durationMs":4321}',
    ].join('\n'),
    'synthetic',
  );
  expect(t.extra?.['quorum_boundaries']).toEqual([
    {
      kind: 'turn',
      phase: 'complete',
      durationMs: 4321,
      evidence: { lines: [3], timestamp: '2026-01-01T00:00:05Z' },
    },
  ]);
  expect(t.steps).toHaveLength(2);
  expect(t.steps.filter((s) => s.metrics)).toHaveLength(0);
});

test('Codex retains native task_complete reported duration separately from timestamp subtraction', () => {
  const t = normalizeCodex(
    [
      '{"type":"event_msg","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"task_started"}}',
      '{"type":"event_msg","timestamp":"2026-01-01T00:00:05Z","payload":{"type":"task_complete","duration_ms":4567}}',
    ].join('\n'),
    'synthetic',
  );
  expect(t.extra?.['quorum_boundaries']).toEqual([
    {
      kind: 'task',
      phase: 'start',
      evidence: { lines: [1], timestamp: '2026-01-01T00:00:00Z' },
    },
    {
      kind: 'task',
      phase: 'complete',
      durationMs: 4567,
      evidence: { lines: [2], timestamp: '2026-01-01T00:00:05Z' },
    },
  ]);
  expect(t.steps.filter((s) => s.metrics)).toHaveLength(0);
});

for (const kind of NATIVE_RESULT_CASES)
  test(`${kind} preserves canonical native read failure separately from content`, () => {
    for (const failed of [true, false]) {
      const t = nativeReadResult(kind, '/synthetic/case.md', failed);
      const result = t.steps[0]!.observation!.results[0]!;
      expect(result.extra?.['quorum_result']).toEqual({ isError: failed });
      expect(String(result.content)).toContain(
        failed ? 'ENOENT: file not found' : 'Synthetic file content',
      );
      expect(t.steps.filter((step) => step.metrics)).toHaveLength(0);
    }
  });

for (const harness of ['claude', 'pi'] as const)
  test(`${harness} exposes singleton native wrapper duration without new priced content`, () => {
    const t = nativeDurationResult(harness, 4321);
    const result = t.steps[0]!.observation!.results[0]!;
    expect(result.extra?.['quorum_result']).toEqual({ durationMs: 4321 });
    expect(result.extra?.['quorum_source']).toMatchObject({ lines: [3] });
    expect(String(result.content)).toContain('4321');
    expect(t.steps.filter((step) => step.metrics)).toHaveLength(0);
  });
test('Pi parallel wrapper durations never collapse into an invented singleton', () => {
  const result = nativeDurationResult('pi', 4321, true).steps[0]!.observation!
    .results[0]!;
  expect(
    (result.extra?.['quorum_result'] as { durationMs?: number } | undefined)
      ?.durationMs,
  ).toBeUndefined();
});
