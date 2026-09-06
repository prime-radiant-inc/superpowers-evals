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
