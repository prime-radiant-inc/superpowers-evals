import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { indexCodexTranscript } from '../src/experiments/observer/codex.ts';
import {
  type JsonValue,
  ObserverEvidenceError,
  RawIndexSchema,
  type RawSource,
} from '../src/experiments/observer/contracts.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';

const source: RawSource = {
  source_id: 'main',
  runtime: 'codex',
  expected_session_id: 's',
  expected_cwd: '/fixture',
  expected_cli_version: 'fixture',
};

const encode = (text: string) => new TextEncoder().encode(text);
const bytes = (rows: unknown[]) =>
  encode(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
const anchor = (line: number, block: number | null = null) => ({
  source_id: 'main',
  line,
  block,
});

const meta = {
  type: 'session_meta',
  payload: {
    id: 's',
    cwd: '/fixture',
    cli_version: 'fixture',
    source: 'cli',
  },
};
const call = {
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'c',
    input: 'await tools.exec_command({cmd:"pwd"}); await unknownEffect();',
  },
};
const result = {
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    call_id: 'c',
    output: 'done',
  },
};

function evidenceError(operation: () => unknown): ObserverEvidenceError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ObserverEvidenceError);
    return error as ObserverEvidenceError;
  }
  throw new Error('Expected ObserverEvidenceError.');
}

function expectEvidenceError(
  rows: unknown[],
  code: ObserverEvidenceError['code'],
  expectedAnchor?: ReturnType<typeof anchor>,
): void {
  const error = evidenceError(() => indexCodexTranscript(source, bytes(rows)));
  expect(error.code).toBe(code);
  if (expectedAnchor !== undefined)
    expect(error.anchor).toEqual(expectedAnchor);
}

test('empty input returns a valid unresolved index', () => {
  const index = indexCodexTranscript(source, new Uint8Array());
  expect(index).toEqual({
    schema_version: 2,
    source,
    identity: {
      session_id: null,
      cwd: null,
      cli_version: null,
      conversation: 'unresolved',
      evidence: [],
    },
    prefix: {
      source_id: 'main',
      bytes: 0,
      sha256:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      after_line: 0,
    },
    entries: [],
  });
  expect(RawIndexSchema.parse(index)).toEqual(index);
});

test('full physical scripts stay intact and results stay later', () => {
  const prefixBytes = bytes([meta, call]);
  const prefix = indexCodexTranscript(source, prefixBytes);
  const full = indexCodexTranscript(source, bytes([meta, call, result, call]));

  expect(prefix.prefix).toEqual(createRawPrefix(source, prefixBytes));
  expect(full.entries.filter((entry) => entry.anchor.line <= 2)).toEqual(
    prefix.entries,
  );
  expect(full.entries.filter((entry) => entry.kind === 'call')).toEqual([
    {
      kind: 'call',
      anchor: anchor(2),
      call_id: 'native:c',
      native_call_id: 'c',
      name: 'exec',
      payload: call.payload,
    },
  ]);
  expect(full.entries.find((entry) => entry.kind === 'result')).toEqual({
    kind: 'result',
    anchor: anchor(3),
    call_id: 'native:c',
    call_anchor: anchor(2),
    payload: result.payload,
  });
  expect(full.entries.at(-1)).toEqual({
    kind: 'replay',
    anchor: anchor(4),
    canonical_anchor: anchor(2),
  });
});

test('all supported physical call and result records retain their payloads', () => {
  const rows = [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'function',
        arguments: '{"cmd":"pwd"}',
        status: 'completed',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'function',
        output: { output: '/fixture', metadata: { size: 8 } },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'custom',
        input: '*** Begin Patch\n*** End Patch',
        status: 'completed',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'custom',
        output: 'ok',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'local_shell_call',
        action: { type: 'exec', command: ['pwd', '--logical'] },
        status: 'completed',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'web_search_call',
        action: { type: 'search', query: 'observer chronology' },
        status: 'completed',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'tool_search_call',
        call_id: 'search-tools',
        arguments: { query: 'spawn agent', limit: 8 },
        status: 'completed',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'tool_search_output',
        call_id: 'search-tools',
        tools: [{ name: 'spawn_agent' }],
        status: 'completed',
      },
    },
  ];

  const index = indexCodexTranscript(source, bytes(rows));
  const calls = index.entries.filter((entry) => entry.kind === 'call');
  expect(calls.map((entry) => entry.name)).toEqual([
    'exec_command',
    'apply_patch',
    'local_shell_call',
    'web_search_call',
    'tool_search_call',
  ]);
  expect(calls.map((entry) => entry.payload)).toEqual([
    (rows[0] as { payload: JsonValue }).payload,
    (rows[2] as { payload: JsonValue }).payload,
    (rows[4] as { payload: JsonValue }).payload,
    (rows[5] as { payload: JsonValue }).payload,
    (rows[6] as { payload: JsonValue }).payload,
  ]);
  expect(calls.map((entry) => entry.call_id)).toEqual([
    'native:function',
    'native:custom',
    'anchor:["main",5,null]',
    'anchor:["main",6,null]',
    'native:search-tools',
  ]);
  expect(index.entries.filter((entry) => entry.kind === 'result')).toEqual([
    {
      kind: 'result',
      anchor: anchor(2),
      call_id: 'native:function',
      call_anchor: anchor(1),
      payload: (rows[1] as { payload: JsonValue }).payload,
    },
    {
      kind: 'result',
      anchor: anchor(4),
      call_id: 'native:custom',
      call_anchor: anchor(3),
      payload: (rows[3] as { payload: JsonValue }).payload,
    },
    {
      kind: 'result',
      anchor: anchor(8),
      call_id: 'native:search-tools',
      call_anchor: anchor(7),
      payload: (rows[7] as { payload: JsonValue }).payload,
    },
  ]);
  expect(RawIndexSchema.parse(index)).toEqual(index);
});

test('native calls replay only when the complete payload is identical', () => {
  const functionCall = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'same',
      arguments: { cmd: 'pwd' },
      status: 'completed',
    },
  };
  const replayed = indexCodexTranscript(
    source,
    bytes([functionCall, functionCall]),
  );
  expect(replayed.entries.at(-1)).toEqual({
    kind: 'replay',
    anchor: anchor(2),
    canonical_anchor: anchor(1),
  });

  expectEvidenceError(
    [
      functionCall,
      {
        ...functionCall,
        payload: { ...functionCall.payload, arguments: { cmd: 'ls' } },
      },
    ],
    'replay_conflict',
    anchor(2),
  );
});

test('identical ID-less native calls remain separate calls', () => {
  const local = {
    type: 'response_item',
    payload: {
      type: 'local_shell_call',
      action: { type: 'exec', command: ['pwd'] },
    },
  };
  const index = indexCodexTranscript(source, bytes([local, local]));
  expect(index.entries).toEqual([
    {
      kind: 'call',
      anchor: anchor(1),
      call_id: 'anchor:["main",1,null]',
      native_call_id: null,
      name: 'local_shell_call',
      payload: local.payload,
    },
    {
      kind: 'call',
      anchor: anchor(2),
      call_id: 'anchor:["main",2,null]',
      native_call_id: null,
      name: 'local_shell_call',
      payload: local.payload,
    },
  ]);
});

test('results require an earlier call and replay only with an identical payload', () => {
  expectEvidenceError([result], 'orphan_result', anchor(1));

  const repeated = indexCodexTranscript(source, bytes([call, result, result]));
  expect(repeated.entries.at(-1)).toEqual({
    kind: 'replay',
    anchor: anchor(3),
    canonical_anchor: anchor(2),
  });

  expectEvidenceError(
    [
      call,
      result,
      { ...result, payload: { ...result.payload, output: 'changed' } },
    ],
    'replay_conflict',
    anchor(3),
  );
});

test('parent user and assistant content blocks keep separate block anchors', () => {
  const user = {
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'user-message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'First approval sentence.' },
        { type: 'input_text', text: 'Second approval sentence.' },
      ],
    },
  };
  const assistant = {
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'assistant-message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'First response.' },
        { type: 'output_text', text: 'Second response.' },
      ],
    },
  };
  const index = indexCodexTranscript(source, bytes([meta, user, assistant]));
  expect(index.entries.slice(1)).toEqual([
    {
      kind: 'message',
      anchor: anchor(2, 0),
      role: 'user',
      text: 'First approval sentence.',
      message_id: 'user-message',
      claimed_origin: 'external',
      approval_eligibility: 'eligible',
    },
    {
      kind: 'message',
      anchor: anchor(2, 1),
      role: 'user',
      text: 'Second approval sentence.',
      message_id: 'user-message',
      claimed_origin: 'external',
      approval_eligibility: 'eligible',
    },
    {
      kind: 'message',
      anchor: anchor(3, 0),
      role: 'assistant',
      text: 'First response.',
      message_id: 'assistant-message',
      claimed_origin: 'internal',
      approval_eligibility: 'ineligible',
    },
    {
      kind: 'message',
      anchor: anchor(3, 1),
      role: 'assistant',
      text: 'Second response.',
      message_id: 'assistant-message',
      claimed_origin: 'internal',
      approval_eligibility: 'ineligible',
    },
  ]);
});

test('message replay aliases every original block without moving chronology', () => {
  const message = {
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'message-1',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'First.' },
        { type: 'output_text', text: 'Second.' },
      ],
    },
  };
  const index = indexCodexTranscript(source, bytes([message, message]));
  expect(index.entries.slice(2)).toEqual([
    {
      kind: 'replay',
      anchor: anchor(2, 0),
      canonical_anchor: anchor(1, 0),
    },
    {
      kind: 'replay',
      anchor: anchor(2, 1),
      canonical_anchor: anchor(1, 1),
    },
  ]);
  expect(RawIndexSchema.parse(index)).toEqual(index);

  expectEvidenceError(
    [
      message,
      {
        ...message,
        payload: {
          ...message.payload,
          content: [{ type: 'output_text', text: 'Changed.' }],
        },
      },
    ],
    'replay_conflict',
    anchor(2),
  );
});

test('ID-less repeated messages remain distinct', () => {
  const message = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Same text.' }],
    },
  };
  const index = indexCodexTranscript(source, bytes([message, message]));
  expect(index.entries.map((entry) => entry.kind)).toEqual([
    'message',
    'message',
  ]);
  expect(index.entries.map((entry) => entry.anchor)).toEqual([
    anchor(1, 0),
    anchor(2, 0),
  ]);
});

test('message eligibility uses identity established at the message position', () => {
  const user = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Proceed.' }],
    },
  };
  const index = indexCodexTranscript(source, bytes([user, meta, user]));
  expect(index.identity.conversation).toBe('parent');
  expect(index.entries[0]).toMatchObject({
    kind: 'message',
    claimed_origin: 'unclaimed',
    approval_eligibility: 'unresolved',
  });
  expect(index.entries[2]).toMatchObject({
    kind: 'message',
    claimed_origin: 'external',
    approval_eligibility: 'eligible',
  });
});

test('descendant user messages are internal and ineligible', () => {
  const childMeta = {
    ...meta,
    payload: { ...meta.payload, source: { subagent: { depth: 1 } } },
  };
  const user = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Delegated prompt.' }],
    },
  };
  const index = indexCodexTranscript(source, bytes([childMeta, user]));
  expect(index.identity.conversation).toBe('descendant');
  expect(index.entries[1]).toEqual({
    kind: 'message',
    anchor: anchor(2, 0),
    role: 'user',
    text: 'Delegated prompt.',
    message_id: null,
    claimed_origin: 'internal',
    approval_eligibility: 'ineligible',
  });
});

test('missing or unknown parent metadata leaves user approval unresolved', () => {
  const user = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Proceed.' }],
    },
  };
  for (const rows of [
    [user],
    [
      {
        type: 'session_meta',
        payload: { id: 's', source: 'unknown-launcher' },
      },
      user,
    ],
  ]) {
    const index = indexCodexTranscript(source, bytes(rows));
    expect(index.identity.conversation).toBe('unresolved');
    expect(index.entries.at(-1)).toMatchObject({
      kind: 'message',
      claimed_origin: 'unclaimed',
      approval_eligibility: 'unresolved',
    });
  }
});

test('metadata records retain established identity and evidence', () => {
  const partialMeta = {
    type: 'session_meta',
    payload: { id: 's', source: 'cli' },
  };
  const index = indexCodexTranscript(source, bytes([partialMeta]));
  expect(index.identity).toEqual({
    session_id: 's',
    cwd: null,
    cli_version: null,
    conversation: 'unresolved',
    evidence: [anchor(1)],
  });
  expect(index.entries).toEqual([
    {
      kind: 'non_action',
      anchor: anchor(1),
      record_type: 'session_meta',
    },
  ]);
});

test('wrong or changing identity fields fail at their metadata anchor', () => {
  for (const payload of [
    { ...meta.payload, id: 'wrong' },
    { ...meta.payload, session_id: 'wrong' },
    { ...meta.payload, cwd: '/wrong' },
    { ...meta.payload, cli_version: 'wrong' },
    { ...meta.payload, id: 's', session_id: 'different' },
  ]) {
    expectEvidenceError(
      [{ type: 'session_meta', payload }],
      'identity_conflict',
      anchor(1),
    );
  }

  expectEvidenceError(
    [meta, { ...meta, payload: { ...meta.payload, source: 'other' } }],
    'identity_conflict',
    anchor(2),
  );
});

test('non-Codex sources reject before indexing', () => {
  const error = evidenceError(() =>
    indexCodexTranscript({ ...source, runtime: 'claude' }, bytes([meta])),
  );
  expect(error.code).toBe('invalid_source');
  expect(error.anchor).toBeNull();
});

test('system and developer messages are anchored non-actions', () => {
  const rows = (['system', 'developer'] as const).map((role) => ({
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: 'input_text', text: `${role} instructions` }],
    },
  }));
  const index = indexCodexTranscript(source, bytes(rows));
  expect(index.entries).toEqual([
    {
      kind: 'non_action',
      anchor: anchor(1, 0),
      record_type: 'message.system.input_text',
    },
    {
      kind: 'non_action',
      anchor: anchor(2, 0),
      record_type: 'message.developer.input_text',
    },
  ]);
});

test('empty user and assistant content arrays are explicit non-actions', () => {
  const rows = (['user', 'assistant'] as const).map((role) => ({
    type: 'response_item',
    payload: { type: 'message', role, content: [] },
  }));
  const index = indexCodexTranscript(source, bytes(rows));
  expect(index.entries).toEqual([
    {
      kind: 'non_action',
      anchor: anchor(1),
      record_type: 'user.empty',
    },
    {
      kind: 'non_action',
      anchor: anchor(2),
      record_type: 'assistant.empty',
    },
  ]);
});

test('unknown record and content discriminants fail closed', () => {
  const cases: Array<[unknown, ReturnType<typeof anchor>]> = [
    [{ type: 'turn_context', payload: {} }, anchor(1)],
    [{ type: 'event_msg', payload: { type: 'mirrored_message' } }, anchor(1)],
    [{ type: 'response_item', payload: { type: 'computer_call' } }, anchor(1)],
    [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'unknown', content: [] },
      },
      anchor(1),
    ],
    [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', text: 'No.' }],
        },
      },
      anchor(1, 0),
    ],
  ];
  for (const [row, expectedAnchor] of cases) {
    expectEvidenceError([row], 'unknown_record', expectedAnchor);
  }
});

test('recognized records reject malformed required fields', () => {
  const malformed: Array<[unknown, ReturnType<typeof anchor>]> = [
    [{ type: 'session_meta', payload: null }, anchor(1)],
    [{ type: 'response_item', payload: null }, anchor(1)],
    [
      {
        type: 'response_item',
        payload: { type: 'message', content: [] },
      },
      anchor(1),
    ],
    [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text' }],
        },
      },
      anchor(1, 0),
    ],
    [
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c',
        },
      },
      anchor(1),
    ],
    [
      {
        type: 'response_item',
        payload: {
          type: 'local_shell_call',
          action: { type: 'exec', command: 'pwd' },
        },
      },
      anchor(1),
    ],
    [
      {
        type: 'response_item',
        payload: { type: 'web_search_call', action: { type: '' } },
      },
      anchor(1),
    ],
    [
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'c',
        },
      },
      anchor(1),
    ],
    [
      {
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'c',
          output: [],
        },
      },
      anchor(1),
    ],
  ];
  for (const [row, expectedAnchor] of malformed) {
    expectEvidenceError([row], 'invalid_record', expectedAnchor);
  }
});

test('function and tool search calls require JSON object arguments', () => {
  for (const type of ['function_call', 'tool_search_call'] as const) {
    for (const argumentsValue of [
      undefined,
      null,
      [],
      1,
      '{broken}',
      'null',
      '[]',
    ]) {
      const payload: Record<string, unknown> = {
        type,
        call_id: 'c',
        arguments: argumentsValue,
      };
      if (type === 'function_call') payload['name'] = 'exec_command';
      expectEvidenceError(
        [{ type: 'response_item', payload }],
        'invalid_record',
        anchor(1),
      );
    }
  }
});

test('selected Codex slice rows retain original shape and script, not qualification', () => {
  const fixture = readFileSync(
    new URL('./fixtures/codex-56-exec.slice.jsonl', import.meta.url),
    'utf8',
  );
  const lines = fixture.trimEnd().split('\n');
  const metadata = JSON.parse(lines[0]!) as {
    payload: {
      id: string;
      cwd: string;
      cli_version: string;
      source: string;
    };
  };
  const physicalCall = JSON.parse(lines[2]!) as {
    payload: { input: string };
  };
  const selectedSource: RawSource = {
    source_id: 'main',
    runtime: 'codex',
    expected_session_id: metadata.payload.id,
    expected_cwd: metadata.payload.cwd,
    expected_cli_version: '0.144.3',
  };
  const selected = encode(`${lines[0]}\n${lines[2]}\n`);

  const index = indexCodexTranscript(selectedSource, selected);
  expect(index.entries[0]).toEqual({
    kind: 'non_action',
    anchor: anchor(1),
    record_type: 'session_meta',
  });
  expect(index.entries[1]).toMatchObject({
    kind: 'call',
    anchor: anchor(2),
    name: 'exec',
    payload: physicalCall.payload,
  });
  expect(physicalCall.payload.input).toContain('tools.exec_command');
  const indexedCall = index.entries[1];
  if (indexedCall?.kind !== 'call') throw new Error('Expected physical call.');
  expect((indexedCall.payload as { input: string }).input).toBe(
    physicalCall.payload.input,
  );
});

test('full existing Codex slice rejects its first unsupported physical row', () => {
  const fixture = readFileSync(
    new URL('./fixtures/codex-56-exec.slice.jsonl', import.meta.url),
  );
  const metadata = JSON.parse(
    new TextDecoder().decode(fixture).split('\n')[0]!,
  ) as {
    payload: { id: string; cwd: string; cli_version: string };
  };
  const selectedSource: RawSource = {
    source_id: 'main',
    runtime: 'codex',
    expected_session_id: metadata.payload.id,
    expected_cwd: metadata.payload.cwd,
    expected_cli_version: metadata.payload.cli_version,
  };

  const error = evidenceError(() =>
    indexCodexTranscript(selectedSource, fixture),
  );
  expect(error.code).toBe('unknown_record');
  expect(error.anchor).toEqual(anchor(2));
});
