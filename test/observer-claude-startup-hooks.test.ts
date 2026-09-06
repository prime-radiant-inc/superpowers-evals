import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  indexClaudeTranscript,
  inspectedClaudeParentIdentity,
} from '../src/experiments/observer/claude.ts';
import type { RawSource } from '../src/experiments/observer/contracts.ts';

const raw = readFileSync(
  new URL(
    './fixtures/claude-2.1.209-native-startup-hooks.jsonl',
    import.meta.url,
  ),
);
const rows = raw
  .toString()
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));
const source: RawSource = {
  source_id: 'native-hooks',
  runtime: 'claude',
  expected_session_id: 'native-hooks-parent',
  expected_cwd: '/capture/claude-hooks/workdir',
  expected_cli_version: '2.1.209',
};
const bytes = (input: unknown[]) =>
  Buffer.from(`${input.map((row) => JSON.stringify(row)).join('\n')}\n`);

// Rejecting a human input whose parent is a validated startup hook loses real
// parent authority; treating the hooks themselves as input invents authority.
test('startup hook chain identifies the parent only after a native typed input', () => {
  const index = indexClaudeTranscript(source, raw);
  expect(inspectedClaudeParentIdentity(raw)).toEqual({
    session_id: 'native-hooks-parent',
    cwd: '/capture/claude-hooks/workdir',
    cli_version: '2.1.209',
  });
  expect(index.identity.conversation).toBe('parent');
  expect(
    index.entries
      .filter((entry) => entry.kind === 'message')
      .map((entry) => [entry.anchor.line, entry.approval_eligibility]),
  ).toEqual([
    [7, 'eligible'],
    [12, 'eligible'],
  ]);
  expect(
    index.entries
      .filter((entry) => entry.kind === 'non_action')
      .map((entry) => [entry.anchor.line, entry.record_type]),
  ).toEqual([
    [1, 'last-prompt'],
    [2, 'mode'],
    [3, 'permission-mode'],
    [4, 'attachment.hook_success'],
    [5, 'attachment.hook_additional_context'],
    [6, 'file-history-snapshot'],
    [10, 'attachment.command_permissions'],
    [11, 'last-prompt'],
  ]);
  expect(index.entries.filter((entry) => entry.kind === 'call')).toHaveLength(
    1,
  );
  expect(index.entries.filter((entry) => entry.kind === 'result')).toHaveLength(
    1,
  );
});

test('a pending native startup remains unbound and keeps all inspected anchors', () => {
  const pending = bytes(rows.slice(0, 6));
  expect(inspectedClaudeParentIdentity(pending)).toBeNull();
  expect(indexClaudeTranscript(source, pending).identity.conversation).toBe(
    'unresolved',
  );
  expect(
    indexClaudeTranscript(source, pending).entries.every(
      (entry) => entry.kind === 'non_action',
    ),
  ).toBe(true);
});

test('startup hooks cannot repair broken links or grant nonhuman and child inputs authority', () => {
  for (const [rowIndex, change] of [
    [3, { parentUuid: 'unknown' }],
    [4, { parentUuid: 'unknown' }],
    [6, { parentUuid: null }],
    [6, { parentUuid: 'hook-success' }],
    [6, { parentUuid: 'typed-second' }],
    [6, { origin: { kind: 'agent' } }],
    [6, { promptSource: 'injected' }],
    [6, { entrypoint: 'sdk' }],
    [6, { isSidechain: true }],
    [6, { agentId: 'child' }],
  ] as const) {
    const changed = structuredClone(rows.slice(0, 7));
    changed[rowIndex] = { ...changed[rowIndex], ...change };
    expect(() => inspectedClaudeParentIdentity(bytes(changed))).toThrow();
    const index = indexClaudeTranscript(source, bytes(changed));
    expect(index.identity.conversation).not.toBe('parent');
    expect(
      index.entries.find((entry) => entry.anchor.line === 7),
    ).not.toMatchObject({ approval_eligibility: 'eligible' });
  }
});

test('startup metadata fails closed on unknown payloads, variants, identities and field types', () => {
  for (const [rowIndex, change] of [
    [0, { lastPrompt: null }],
    [0, { leafUuid: undefined }],
    [3, { message: { role: 'assistant', content: [{ type: 'tool_use' }] } }],
    [3, { attachment: { ...rows[3].attachment, exitCode: 1 } }],
    [3, { attachment: { ...rows[3].attachment, durationMs: -1 } }],
    [3, { attachment: { ...rows[3].attachment, hookEvent: 'PreToolUse' } }],
    [3, { attachment: { ...rows[3].attachment, hookName: 'other' } }],
    [3, { attachment: { ...rows[3].attachment, command: 123 } }],
    [3, { attachment: { ...rows[3].attachment, unexpected: 'payload' } }],
    [3, { version: '2.1.210' }],
    [3, { sessionId: 'other' }],
    [3, { cwd: '/other' }],
    [3, { uuid: undefined }],
    [
      4,
      {
        attachment: { ...rows[4].attachment, content: [{ type: 'tool_use' }] },
      },
    ],
    [4, { attachment: { ...rows[4].attachment, toolUseID: null } }],
    [9, { message: { role: 'assistant', content: 'hidden' } }],
    [9, { attachment: { type: 'command_permissions', allowedTools: [123] } }],
    [
      9,
      {
        attachment: {
          type: 'command_permissions',
          allowedTools: ['uninspected'],
        },
      },
    ],
  ] as const) {
    const changed = structuredClone(rows);
    changed[rowIndex] = { ...changed[rowIndex], ...change };
    expect(() => indexClaudeTranscript(source, bytes(changed))).toThrow();
    expect(() => inspectedClaudeParentIdentity(bytes(changed))).toThrow();
  }
});
