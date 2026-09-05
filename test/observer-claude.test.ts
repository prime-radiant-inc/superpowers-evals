import { expect, test } from 'bun:test';
import { indexClaudeTranscript } from '../src/experiments/observer/claude.ts';
import {
  ObserverEvidenceError,
  RawIndexSchema,
  type RawSource,
} from '../src/experiments/observer/contracts.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';

const source: RawSource = {
  source_id: 'main',
  runtime: 'claude',
  expected_session_id: 's',
  expected_cwd: '/fixture',
  expected_cli_version: 'fixture',
};
const common = {
  sessionId: 's',
  cwd: '/fixture',
  version: 'fixture',
  isSidechain: false,
  parentUuid: null,
};
const bytes = (rows: unknown[]) =>
  new TextEncoder().encode(
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );

function evidenceError(operation: () => unknown): ObserverEvidenceError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ObserverEvidenceError);
    return error as ObserverEvidenceError;
  }
  throw new Error('Expected ObserverEvidenceError.');
}

test('a repeated message ID never pulls later blocks into an earlier row', () => {
  const text = {
    ...common,
    uuid: 'a',
    type: 'assistant',
    message: {
      id: 'm',
      role: 'assistant',
      content: [{ type: 'text', text: 'Review this.' }],
    },
  };
  const user = {
    ...common,
    uuid: 'u',
    userType: 'external',
    type: 'user',
    message: { role: 'user', content: 'Approved.' },
  };
  const call = {
    ...common,
    uuid: 'b',
    type: 'assistant',
    message: {
      id: 'm',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'c',
          name: 'Write',
          input: { file_path: 'app.ts', content: 'product' },
        },
      ],
    },
  };

  const prefix = indexClaudeTranscript(source, bytes([text, user]));
  const full = indexClaudeTranscript(source, bytes([text, user, call, user]));

  expect(full.entries.filter((entry) => entry.anchor.line <= 2)).toEqual(
    prefix.entries,
  );
  expect(full.entries.find((entry) => entry.kind === 'call')).toMatchObject({
    anchor: { source_id: 'main', line: 3, block: 0 },
    native_call_id: 'c',
  });
  expect(
    full.entries.filter(
      (entry) => entry.kind === 'message' && entry.role === 'user',
    ),
  ).toHaveLength(1);
  expect(full.entries.at(-1)).toEqual({
    kind: 'replay',
    anchor: { source_id: 'main', line: 4, block: null },
    canonical_anchor: { source_id: 'main', line: 2, block: null },
  });
  expect(full.identity.conversation).toBe('unresolved');
  expect(
    full.entries.find(
      (entry) => entry.kind === 'message' && entry.role === 'user',
    ),
  ).toMatchObject({
    claimed_origin: 'external',
    approval_eligibility: 'unresolved',
  });
});

test('UUID replay aliases each original block rather than an absent row entry', () => {
  const mixed = {
    ...common,
    uuid: 'mixed',
    type: 'assistant',
    message: {
      id: 'mixed-message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        {
          type: 'tool_use',
          id: 'read',
          name: 'Read',
          input: { file_path: 'spec.md' },
        },
      ],
    },
  };

  const index = indexClaudeTranscript(source, bytes([mixed, mixed]));

  expect(RawIndexSchema.safeParse(index).success).toBe(true);
  expect(index.entries.filter((entry) => entry.kind === 'replay')).toEqual([
    {
      kind: 'replay',
      anchor: { source_id: 'main', line: 2, block: 0 },
      canonical_anchor: { source_id: 'main', line: 1, block: 0 },
    },
    {
      kind: 'replay',
      anchor: { source_id: 'main', line: 2, block: 1 },
      canonical_anchor: { source_id: 'main', line: 1, block: 1 },
    },
  ]);

  const invalid = structuredClone(index);
  const alias = invalid.entries.find((entry) => entry.kind === 'replay');
  if (alias?.kind !== 'replay') throw new Error('Expected replay fixture.');
  alias.canonical_anchor.block = null;
  expect(RawIndexSchema.safeParse(invalid).success).toBe(false);
});

test('wrong runtime is an invalid source', () => {
  const error = evidenceError(() =>
    indexClaudeTranscript({ ...source, runtime: 'codex' }, new Uint8Array()),
  );
  expect(error.code).toBe('invalid_source');
});

test('calls and results retain complete physical payloads at occurrence anchors', () => {
  const callBlock = {
    type: 'tool_use',
    id: 'shell',
    name: 'Bash',
    input: { command: 'printf review && printf product', timeout: 2000 },
  };
  const resultBlock = {
    type: 'tool_result',
    tool_use_id: 'shell',
    content: [{ type: 'text', text: 'done' }],
    is_error: false,
  };
  const toolUseResult = { stdout: 'done', stderr: '', exitCode: 0 };
  const index = indexClaudeTranscript(
    source,
    bytes([
      {
        ...common,
        uuid: 'call-row',
        type: 'assistant',
        message: { role: 'assistant', content: [callBlock] },
      },
      {
        ...common,
        uuid: 'result-row',
        userType: 'external',
        toolUseResult,
        type: 'user',
        message: {
          id: 'result-message',
          role: 'user',
          content: [
            resultBlock,
            { type: 'text', text: '[interrupted by user]' },
          ],
        },
      },
    ]),
  );

  expect(index.entries).toEqual([
    {
      kind: 'call',
      anchor: { source_id: 'main', line: 1, block: 0 },
      call_id: 'native:shell',
      native_call_id: 'shell',
      name: 'Bash',
      payload: callBlock,
    },
    {
      kind: 'result',
      anchor: { source_id: 'main', line: 2, block: 0 },
      call_id: 'native:shell',
      call_anchor: { source_id: 'main', line: 1, block: 0 },
      payload: { block: resultBlock, tool_use_result: toolUseResult },
    },
    {
      kind: 'message',
      anchor: { source_id: 'main', line: 2, block: 1 },
      role: 'user',
      text: '[interrupted by user]',
      message_id: 'result-message',
      claimed_origin: 'external',
      approval_eligibility: 'unresolved',
    },
  ]);
});

test('tool-use and result identities replay directly or reject conflicts', () => {
  const call = (uuid: string, input: Record<string, unknown>) => ({
    ...common,
    uuid,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c', name: 'Read', input }],
    },
  });
  const result = (uuid: string, content: string) => ({
    ...common,
    uuid,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c', content }],
    },
  });
  const index = indexClaudeTranscript(
    source,
    bytes([
      call('call-1', { file_path: 'spec.md' }),
      call('call-2', { file_path: 'spec.md' }),
      result('result-1', 'read'),
      result('result-2', 'read'),
    ]),
  );
  expect(index.entries).toEqual([
    expect.objectContaining({
      kind: 'call',
      anchor: { source_id: 'main', line: 1, block: 0 },
    }),
    {
      kind: 'replay',
      anchor: { source_id: 'main', line: 2, block: 0 },
      canonical_anchor: { source_id: 'main', line: 1, block: 0 },
    },
    expect.objectContaining({
      kind: 'result',
      anchor: { source_id: 'main', line: 3, block: 0 },
      call_anchor: { source_id: 'main', line: 1, block: 0 },
    }),
    {
      kind: 'replay',
      anchor: { source_id: 'main', line: 4, block: 0 },
      canonical_anchor: { source_id: 'main', line: 3, block: 0 },
    },
  ]);

  const changedCall = evidenceError(() =>
    indexClaudeTranscript(
      source,
      bytes([
        call('call-1', { file_path: 'spec.md' }),
        call('call-2', { file_path: 'other.md' }),
      ]),
    ),
  );
  expect(changedCall.code).toBe('replay_conflict');
  expect(changedCall.anchor).toEqual({
    source_id: 'main',
    line: 2,
    block: 0,
  });

  const changedResult = evidenceError(() =>
    indexClaudeTranscript(
      source,
      bytes([
        call('call-1', { file_path: 'spec.md' }),
        result('result-1', 'read'),
        result('result-2', 'changed'),
      ]),
    ),
  );
  expect(changedResult.code).toBe('replay_conflict');
  expect(changedResult.anchor).toEqual({
    source_id: 'main',
    line: 3,
    block: 0,
  });

  const changedResultMetadata = evidenceError(() =>
    indexClaudeTranscript(
      source,
      bytes([
        call('call-1', { file_path: 'spec.md' }),
        {
          ...result('result-1', 'read'),
          toolUseResult: { stdout: 'first' },
        },
        {
          ...result('result-2', 'read'),
          toolUseResult: { stdout: 'changed' },
        },
      ]),
    ),
  );
  expect(changedResultMetadata.code).toBe('replay_conflict');
});

test('row replay targets canonical entries even when one original slot was a call replay', () => {
  const callBlock = {
    type: 'tool_use',
    id: 'read',
    name: 'Read',
    input: { file_path: 'spec.md' },
  };
  const firstCall = {
    ...common,
    uuid: 'first-call',
    type: 'assistant',
    message: { role: 'assistant', content: [callBlock] },
  };
  const mixed = {
    ...common,
    uuid: 'mixed-call',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Still reading.' }, callBlock],
    },
  };
  const index = indexClaudeTranscript(source, bytes([firstCall, mixed, mixed]));

  expect(index.entries.slice(-2)).toEqual([
    {
      kind: 'replay',
      anchor: { source_id: 'main', line: 3, block: 0 },
      canonical_anchor: { source_id: 'main', line: 2, block: 0 },
    },
    {
      kind: 'replay',
      anchor: { source_id: 'main', line: 3, block: 1 },
      canonical_anchor: { source_id: 'main', line: 1, block: 0 },
    },
  ]);
  expect(RawIndexSchema.safeParse(index).success).toBe(true);
});

test('UUID conflicts include provenance and identity changes', () => {
  const original = {
    ...common,
    uuid: 'same',
    timestamp: 'first',
    userType: 'external',
    type: 'user',
    message: { role: 'user', content: 'Approved.' },
  };
  for (const changed of [
    { ...original, timestamp: 'later' },
    { ...original, userType: 'internal' },
    { ...original, cwd: '/other' },
    { ...original, parentUuid: 'parent' },
  ]) {
    const error = evidenceError(() =>
      indexClaudeTranscript(source, bytes([original, changed])),
    );
    expect(error.code).toBe('replay_conflict');
    expect(error.anchor).toEqual({ source_id: 'main', line: 2, block: null });
  }
});

test('orphan results reject rather than becoming user text', () => {
  const error = evidenceError(() =>
    indexClaudeTranscript(
      source,
      bytes([
        {
          ...common,
          uuid: 'orphan',
          userType: 'external',
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'missing', content: 'ok' },
            ],
          },
        },
      ]),
    ),
  );
  expect(error.code).toBe('orphan_result');
  expect(error.anchor).toEqual({ source_id: 'main', line: 1, block: 0 });
});

test('supported metadata, summaries, empty turns, and thinking stay non-action', () => {
  const index = indexClaudeTranscript(
    source,
    bytes([
      {
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: 's',
        content: 'Approved from queue',
      },
      { type: 'queue-operation', operation: 'dequeue', sessionId: 's' },
      {
        ...common,
        uuid: 'thinking',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'private' }],
        },
      },
      {
        ...common,
        uuid: 'assistant-empty',
        type: 'assistant',
        message: { role: 'assistant', content: [] },
      },
      {
        ...common,
        uuid: 'user-empty',
        type: 'user',
        message: { role: 'user', content: [] },
      },
      {
        ...common,
        uuid: 'summary',
        userType: 'external',
        isCompactSummary: true,
        type: 'user',
        message: { role: 'user', content: 'Approved in summary' },
      },
      {
        ...common,
        uuid: 'tools',
        userType: 'external',
        type: 'attachment',
        attachment: { type: 'deferred_tools_delta', addedNames: ['Write'] },
      },
      {
        ...common,
        uuid: 'skills',
        userType: 'external',
        type: 'attachment',
        attachment: { type: 'skill_listing', content: 'Approved in listing' },
      },
      { type: 'ai-title', aiTitle: 'Approved title', sessionId: 's' },
    ]),
  );

  expect(index.entries.every((entry) => entry.kind === 'non_action')).toBe(
    true,
  );
  expect(index.entries.map((entry) => entry.anchor)).toEqual([
    { source_id: 'main', line: 1, block: null },
    { source_id: 'main', line: 2, block: null },
    { source_id: 'main', line: 3, block: 0 },
    { source_id: 'main', line: 4, block: null },
    { source_id: 'main', line: 5, block: null },
    { source_id: 'main', line: 6, block: null },
    { source_id: 'main', line: 7, block: null },
    { source_id: 'main', line: 8, block: null },
    { source_id: 'main', line: 9, block: null },
  ]);
  expect(index.entries[3]).toMatchObject({ record_type: 'assistant.empty' });
  expect(index.entries[4]).toMatchObject({ record_type: 'user.empty' });
  expect(index.entries.some((entry) => entry.kind === 'message')).toBe(false);
});

test('identity claims are checked on every recognized row', () => {
  const index = indexClaudeTranscript(
    source,
    bytes([
      { type: 'queue-operation', operation: 'enqueue', sessionId: 's' },
      {
        ...common,
        uuid: 'user',
        userType: 'external',
        type: 'user',
        message: { role: 'user', content: 'Review.' },
      },
      { type: 'ai-title', aiTitle: 'Title', sessionId: 's' },
    ]),
  );
  expect(index.identity).toEqual({
    session_id: 's',
    cwd: '/fixture',
    cli_version: 'fixture',
    conversation: 'unresolved',
    evidence: [
      { source_id: 'main', line: 1, block: null },
      { source_id: 'main', line: 2, block: null },
      { source_id: 'main', line: 3, block: null },
    ],
  });

  for (const conflicting of [
    { type: 'queue-operation', operation: 'enqueue', sessionId: 'other' },
    { type: 'ai-title', aiTitle: 'Title', cwd: '/other' },
    { type: 'ai-title', aiTitle: 'Title', version: 'other' },
  ]) {
    const error = evidenceError(() =>
      indexClaudeTranscript(source, bytes([conflicting])),
    );
    expect(error.code).toBe('identity_conflict');
  }
});

test('descendant and internal user messages cannot approve', () => {
  const child = indexClaudeTranscript(
    source,
    bytes([
      {
        ...common,
        uuid: 'child',
        agentId: 'worker-1',
        userType: 'external',
        type: 'user',
        message: { role: 'user', content: 'Approved.' },
      },
    ]),
  );
  expect(child.identity.conversation).toBe('descendant');
  expect(child.entries[0]).toMatchObject({
    claimed_origin: 'external',
    approval_eligibility: 'ineligible',
  });

  const internal = indexClaudeTranscript(
    source,
    bytes([
      {
        ...common,
        uuid: 'internal',
        userType: 'internal',
        type: 'user',
        message: { role: 'user', content: 'Approved.' },
      },
    ]),
  );
  expect(internal.entries[0]).toMatchObject({
    claimed_origin: 'internal',
    approval_eligibility: 'ineligible',
  });
  expect(
    [...child.entries, ...internal.entries].some(
      (entry) =>
        entry.kind === 'message' && entry.approval_eligibility === 'eligible',
    ),
  ).toBe(false);
});

test('a later sidechain claim makes every message in that source ineligible', () => {
  const index = indexClaudeTranscript(
    source,
    bytes([
      {
        ...common,
        uuid: 'early',
        userType: 'external',
        type: 'user',
        message: { role: 'user', content: 'Approved before marker.' },
      },
      {
        ...common,
        uuid: 'marker',
        isSidechain: true,
        type: 'assistant',
        message: { role: 'assistant', content: 'Child response.' },
      },
    ]),
  );
  expect(index.identity.conversation).toBe('descendant');
  expect(index.entries[0]).toMatchObject({
    claimed_origin: 'external',
    approval_eligibility: 'ineligible',
  });
});

test.each([
  [{ type: 'progress', data: {} }, 'unknown_record'],
  [{ type: 'queue-operation', operation: 'replace' }, 'unknown_record'],
  [
    {
      type: 'attachment',
      attachment: { type: 'other' },
    },
    'unknown_record',
  ],
  [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'analysis', text: 'x' }],
      },
    },
    'unknown_record',
  ],
  [
    {
      type: 'user',
      message: { role: 'assistant', content: 'wrong role' },
    },
    'invalid_record',
  ],
  [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'Read', input: 'bad' }],
      },
    },
    'invalid_record',
  ],
] as const)('unknown and malformed Claude variants fail closed', (row, code) => {
  const error = evidenceError(() =>
    indexClaudeTranscript(source, bytes([row])),
  );
  expect(error.code).toBe(code);
});

test('compact summaries reject embedded action blocks', () => {
  const error = evidenceError(() =>
    indexClaudeTranscript(
      source,
      bytes([
        {
          ...common,
          uuid: 'summary',
          isCompactSummary: true,
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'hidden', content: 'ok' },
            ],
          },
        },
      ]),
    ),
  );
  expect(error.code).toBe('unknown_record');
});

test('malformed summary and thinking claims reject', () => {
  for (const row of [
    {
      ...common,
      type: 'user',
      isCompactSummary: 'yes',
      message: { role: 'user', content: 'summary' },
    },
    {
      ...common,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking' }] },
    },
  ]) {
    const error = evidenceError(() =>
      indexClaudeTranscript(source, bytes([row])),
    );
    expect(error.code).toBe('invalid_record');
  }
});

test('action-bearing result metadata cannot disappear on a non-result row', () => {
  for (const row of [
    {
      ...common,
      type: 'user',
      toolUseResult: { stdout: 'hidden' },
      message: { role: 'user', content: 'ordinary text' },
    },
    {
      ...common,
      type: 'assistant',
      isCompactSummary: true,
      message: { role: 'assistant', content: 'summary-shaped' },
    },
  ]) {
    const error = evidenceError(() =>
      indexClaudeTranscript(source, bytes([row])),
    );
    expect(error.code).toBe('unknown_record');
  }
});

test('appending supported rows does not change earlier indexed entries', () => {
  const rows = [
    {
      ...common,
      uuid: 'prompt',
      userType: 'external',
      type: 'user',
      message: { role: 'user', content: 'Review this.' },
    },
    {
      ...common,
      uuid: 'call',
      type: 'assistant',
      message: {
        id: 'same-message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'read', name: 'Read', input: { path: 'a' } },
        ],
      },
    },
    {
      ...common,
      uuid: 'result',
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'read', content: 'contents' },
        ],
      },
    },
    {
      ...common,
      uuid: 'later-text',
      type: 'assistant',
      message: {
        id: 'same-message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Later.' }],
      },
    },
    {
      ...common,
      uuid: 'result-replay',
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'read', content: 'contents' },
        ],
      },
    },
  ];
  const prefix = indexClaudeTranscript(source, bytes(rows.slice(0, 2)));
  const fullRaw = bytes(rows);
  const full = indexClaudeTranscript(source, fullRaw);

  expect(full.entries.filter((entry) => entry.anchor.line <= 2)).toEqual(
    prefix.entries,
  );
  expect(full.prefix).toEqual(createRawPrefix(source, fullRaw));
  expect(full.entries.at(-1)).toEqual({
    kind: 'replay',
    anchor: { source_id: 'main', line: 5, block: 0 },
    canonical_anchor: { source_id: 'main', line: 3, block: 0 },
  });
});

test('rows without UUID are never inferred to be replays', () => {
  const row = {
    ...common,
    type: 'user',
    userType: 'external',
    message: { role: 'user', content: 'same' },
  };
  const index = indexClaudeTranscript(source, bytes([row, row]));
  expect(index.entries.map((entry) => entry.kind)).toEqual([
    'message',
    'message',
  ]);
});

test('empty input is a valid unresolved Claude index', () => {
  const index = indexClaudeTranscript(source, new Uint8Array());
  expect(index.identity).toEqual({
    session_id: null,
    cwd: null,
    cli_version: null,
    conversation: 'unresolved',
    evidence: [],
  });
  expect(index.prefix).toEqual(createRawPrefix(source, new Uint8Array()));
  expect(index.entries).toEqual([]);
  expect(RawIndexSchema.safeParse(index).success).toBe(true);
});

test('the SDK 2.1.177 shape preserves its external claim without granting eligibility', async () => {
  const sdkSource: RawSource = {
    source_id: 'sdk-shape',
    runtime: 'claude',
    expected_session_id: 'f12c4b4d-de7b-45e3-b5c2-ea782aa9595e',
    expected_cwd:
      '/private/var/folders/43/prgnkdr95317fd_zbljq8thm0000gn/T/tmp.H3VT1AvRAc/wd',
    expected_cli_version: '2.1.177',
  };
  const raw = new Uint8Array(
    await Bun.file(
      new URL('./fixtures/claude-2.1.177-real.jsonl', import.meta.url),
    ).arrayBuffer(),
  );
  const index = indexClaudeTranscript(sdkSource, raw);
  const user = index.entries.find(
    (entry) => entry.kind === 'message' && entry.role === 'user',
  );

  expect(index.entries.slice(0, 2)).toEqual([
    expect.objectContaining({
      kind: 'non_action',
      anchor: { source_id: 'sdk-shape', line: 1, block: null },
    }),
    expect.objectContaining({
      kind: 'non_action',
      anchor: { source_id: 'sdk-shape', line: 2, block: null },
    }),
  ]);
  expect(user).toMatchObject({
    anchor: { source_id: 'sdk-shape', line: 3, block: null },
    text: 'create a file hello.txt containing the word hi, then stop',
    claimed_origin: 'external',
    approval_eligibility: 'unresolved',
  });
  expect(index.identity).toMatchObject({
    session_id: sdkSource.expected_session_id,
    cwd: sdkSource.expected_cwd,
    cli_version: sdkSource.expected_cli_version,
    conversation: 'unresolved',
  });
  expect(
    index.entries.some(
      (entry) =>
        entry.kind === 'message' && entry.approval_eligibility === 'eligible',
    ),
  ).toBe(false);
});

test('the tool-use shape does not manufacture missing session or build identity', async () => {
  const toolSource: RawSource = {
    source_id: 'tool-shape',
    runtime: 'claude',
    expected_session_id: 'fixture',
    expected_cwd: '/wd',
    expected_cli_version: 'fixture',
  };
  const raw = new Uint8Array(
    await Bun.file(
      new URL('./fixtures/claude-2.1.177-with-tooluse.jsonl', import.meta.url),
    ).arrayBuffer(),
  );
  const index = indexClaudeTranscript(toolSource, raw);

  expect(index.identity).toMatchObject({
    session_id: null,
    cwd: '/wd',
    cli_version: null,
    conversation: 'unresolved',
  });
  expect(index.entries).toEqual([
    expect.objectContaining({
      kind: 'non_action',
      anchor: { source_id: 'tool-shape', line: 1, block: null },
    }),
    expect.objectContaining({
      kind: 'message',
      anchor: { source_id: 'tool-shape', line: 2, block: null },
    }),
    expect.objectContaining({
      kind: 'message',
      anchor: { source_id: 'tool-shape', line: 3, block: 0 },
    }),
    expect.objectContaining({
      kind: 'call',
      anchor: { source_id: 'tool-shape', line: 3, block: 1 },
    }),
    expect.objectContaining({
      kind: 'result',
      anchor: { source_id: 'tool-shape', line: 4, block: 0 },
      call_anchor: { source_id: 'tool-shape', line: 3, block: 1 },
    }),
    expect.objectContaining({
      kind: 'non_action',
      anchor: { source_id: 'tool-shape', line: 5, block: null },
    }),
  ]);
  expect(
    index.entries.some(
      (entry) =>
        entry.kind === 'message' && entry.approval_eligibility === 'eligible',
    ),
  ).toBe(false);
});
