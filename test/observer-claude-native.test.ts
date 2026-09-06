import { expect, test } from 'bun:test';
import {
  indexClaudeTranscript,
  inspectedClaudeParentIdentity,
} from '../src/experiments/observer/claude.ts';
import type { RawSource } from '../src/experiments/observer/contracts.ts';

const raw = new Uint8Array(
  await Bun.file(
    new URL('./fixtures/claude-2.1.209-native-parent.jsonl', import.meta.url),
  ).arrayBuffer(),
);
const rows = new TextDecoder()
  .decode(raw)
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));
const source: RawSource = {
  source_id: 'native',
  runtime: 'claude',
  expected_session_id: '9833e854-9a93-4863-877e-994ff7a4b2d6',
  expected_cwd: '/capture/claude-parent/workdir',
  expected_cli_version: '2.1.209',
};
const bytes = (input: unknown[]) =>
  new TextEncoder().encode(
    `${input.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );

test('native first typed input identifies the parent while every startup row keeps its anchor', () => {
  const index = indexClaudeTranscript(source, raw);
  expect(index.identity.conversation).toBe('parent');
  expect(index.entries.map((entry) => entry.anchor)).toEqual(
    Array.from({ length: 7 }, (_, n) => ({
      source_id: 'native',
      line: n + 1,
      block: null,
    })),
  );
  expect(index.entries.filter((entry) => entry.kind !== 'non_action')).toEqual([
    expect.objectContaining({
      kind: 'message',
      role: 'user',
      claimed_origin: 'external',
      approval_eligibility: 'eligible',
      anchor: { source_id: 'native', line: 4, block: null },
    }),
  ]);
});

test('native authority requires the complete captured provenance, including exact build', () => {
  for (const field of [
    'origin',
    'promptSource',
    'entrypoint',
    'userType',
    'isSidechain',
    'parentUuid',
    'version',
    'sessionId',
    'cwd',
  ]) {
    const row = { ...rows[3] };
    delete row[field];
    const index = indexClaudeTranscript(source, bytes([row]));
    expect(index.identity.conversation).not.toBe('parent');
    expect(index.entries[0]).not.toMatchObject({
      approval_eligibility: 'eligible',
    });
  }
  for (const change of [
    { origin: { kind: 'agent' } },
    { origin: { kind: 'human', other: 'unqualified' } },
    { promptSource: 'sdk' },
    { entrypoint: 'sdk' },
    { isSidechain: true },
    { parentUuid: 'unqualified-previous' },
    { userType: 'internal' },
    { agentId: 'child' },
  ]) {
    const index = indexClaudeTranscript(
      source,
      bytes([{ ...rows[3], ...change }]),
    );
    expect(index.identity.conversation).not.toBe('parent');
    expect(index.entries[0]).not.toMatchObject({
      approval_eligibility: 'eligible',
    });
  }
  const older = indexClaudeTranscript(
    { ...source, expected_cli_version: '2.1.177' },
    bytes([{ ...rows[3], version: '2.1.177' }]),
  );
  expect(older.identity.conversation).toBe('unresolved');
  expect(older.entries[0]).not.toMatchObject({
    approval_eligibility: 'eligible',
  });
});

test('new metadata cannot hide unknown action payloads or malformed native variants', () => {
  for (const input of [
    {
      ...rows[0],
      message: { role: 'assistant', content: [{ type: 'tool_use' }] },
    },
    { ...rows[1], permissionMode: 'uninspected' },
    { ...rows[0], sessionId: undefined },
    { ...rows[4], message: { role: 'assistant', content: 'hidden' } },
    { ...rows[2], snapshot: { ...rows[2].snapshot, surprise: 'action' } },
    { ...rows[4], attachment: { ...rows[4].attachment, addedLines: [123] } },
    { ...rows[6], toolUseResult: { stdout: 'hidden' } },
  ])
    expect(() => indexClaudeTranscript(source, bytes([input]))).toThrow();
});

test('binding discovers only a qualified native parent and rejects conflicting identities', async () => {
  const discover = inspectedClaudeParentIdentity;
  expect(discover(raw)).toEqual({
    session_id: source.expected_session_id,
    cwd: source.expected_cwd,
    cli_version: source.expected_cli_version,
  });
  expect(discover(bytes(rows.slice(0, 3)))).toBeNull();
  expect(() =>
    discover(bytes([{ ...rows[3], origin: { kind: 'agent' } }])),
  ).toThrow();
  expect(() => discover(bytes([{ type: 'uninspected-action' }]))).toThrow();
  expect(() =>
    discover(
      bytes([...rows, { ...rows[3], uuid: 'other', sessionId: 'other' }]),
    ),
  ).toThrow();
  expect(() =>
    discover(
      bytes([...rows, { ...rows[3], uuid: 'child', isSidechain: true }]),
    ),
  ).toThrow();
});

const twoTurnRaw = new Uint8Array(
  await Bun.file(
    new URL(
      './fixtures/claude-2.1.209-native-two-turns.jsonl',
      import.meta.url,
    ),
  ).arrayBuffer(),
);
const twoTurnRows = new TextDecoder()
  .decode(twoTurnRaw)
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));
const twoTurnSource = {
  ...source,
  expected_session_id: 'a7485dd1-6b5e-4f47-956e-ffcd198af2e9',
};

test('captured later typed input gains authority through the earlier native UUID chain', () => {
  const identity = inspectedClaudeParentIdentity(twoTurnRaw);
  expect(identity).toEqual({
    session_id: twoTurnSource.expected_session_id,
    cwd: twoTurnSource.expected_cwd,
    cli_version: twoTurnSource.expected_cli_version,
  });
  const replay = indexClaudeTranscript(twoTurnSource, twoTurnRaw);
  expect(replay.identity.conversation).toBe('parent');
  expect(
    replay.entries
      .filter(
        (entry) =>
          entry.kind === 'message' && entry.approval_eligibility === 'eligible',
      )
      .map((entry) => entry.anchor),
  ).toEqual([
    { source_id: 'native', line: 4, block: null },
    { source_id: 'native', line: 10, block: null },
  ]);
  expect(
    replay.entries
      .filter((entry) => entry.kind === 'non_action')
      .map((entry) => entry.anchor.line),
  ).toEqual([1, 2, 3, 5, 6, 8, 9, 12, 13]);
  const prefix = indexClaudeTranscript(
    twoTurnSource,
    bytes(twoTurnRows.slice(0, 8)),
  );
  expect(replay.entries.filter((entry) => entry.anchor.line <= 8)).toEqual(
    prefix.entries,
  );
  expect(
    replay.entries.some(
      (entry) => entry.kind === 'call' || entry.kind === 'result',
    ),
  ).toBe(false);
});

test('later native approval requires an unbroken physically earlier parent chain', () => {
  for (const change of [
    { parentUuid: undefined },
    { parentUuid: null },
    { parentUuid: 'unknown' },
    { parentUuid: twoTurnRows[11].uuid },
    { parentUuid: twoTurnRows[3].uuid },
    { origin: undefined },
    { entrypoint: 'sdk' },
  ]) {
    const changed = structuredClone(twoTurnRows);
    changed[9] = { ...changed[9], ...change };
    const index = indexClaudeTranscript(twoTurnSource, bytes(changed));
    expect(
      index.entries.find((entry) => entry.anchor.line === 10),
    ).not.toMatchObject({ approval_eligibility: 'eligible' });
  }
  for (const change of [
    { parentUuid: 'unknown' },
    { entrypoint: 'sdk' },
    { version: undefined },
    { isSidechain: undefined },
    { sessionId: undefined },
    { cwd: undefined },
  ]) {
    const changed = structuredClone(twoTurnRows);
    changed[7] = { ...changed[7], ...change };
    const index = indexClaudeTranscript(twoTurnSource, bytes(changed));
    expect(
      index.entries.find((entry) => entry.anchor.line === 10),
    ).not.toMatchObject({ approval_eligibility: 'eligible' });
  }
});

test('turn-duration metadata preserves its anchor but rejects uninspected action variants', () => {
  for (const change of [
    { subtype: 'tool_execution' },
    { message: { role: 'assistant', content: [] } },
    { durationMs: -1 },
    { messageCount: 1.5 },
    { toolUseResult: { stdout: 'hidden' } },
  ]) {
    expect(() =>
      indexClaudeTranscript(
        twoTurnSource,
        bytes([{ ...twoTurnRows[7], ...change }]),
      ),
    ).toThrow();
  }
});
