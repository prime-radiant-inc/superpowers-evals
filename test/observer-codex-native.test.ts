import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  indexBoundObserverSource,
  type ObserverBinding,
} from '../src/experiments/observer/binding.ts';
import { indexCodexTranscript } from '../src/experiments/observer/codex.ts';
import type { RawSource } from '../src/experiments/observer/contracts.ts';

const raw = readFileSync(
  new URL(
    './fixtures/observer/codex-0.146.0-refused-parent.jsonl',
    import.meta.url,
  ),
);
const source: RawSource = {
  source_id: 'native-parent',
  runtime: 'codex',
  expected_session_id: '01a0750a-9200-7783-a181-bd52af4ea40c',
  expected_cwd: '/capture/codex-parent/workdir',
  expected_cli_version: '0.146.0',
};
const binding: ObserverBinding = {
  schema_version: 2,
  run_id: 'capture',
  campaign: null,
  runtime: 'codex',
  dialect: 'codex-response-items-0.146.0',
  cli_version: '0.146.0',
  home: '/capture/codex-parent/home',
  workdir: source.expected_cwd,
  launch_cwd: source.expected_cwd,
  roots: [
    {
      id: 'sessions',
      kind: 'transcripts',
      path: '/capture/codex-parent/home/.codex/sessions',
    },
    { id: 'documents', kind: 'artifacts', path: source.expected_cwd },
  ],
  phase: 'unbound',
  parent_source_id: null,
  sources: [],
};
type NativeRow = { type: string; payload: Record<string, unknown> };
function changed(mutator: (rows: NativeRow[]) => void): Buffer {
  const rows = raw
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  mutator(rows);
  return Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('indexes the captured Codex 0.146.0 refused turn without inventing tool activity', () => {
  const index = indexCodexTranscript(source, raw);
  expect(index.identity.conversation).toBe('parent');
  expect(index.prefix.after_line).toBe(9);
  expect(
    index.entries.filter(
      (entry) => entry.kind === 'call' || entry.kind === 'result',
    ),
  ).toEqual([]);
  expect(
    index.entries
      .filter((entry) => entry.kind === 'message' && entry.role === 'user')
      .map((entry) => entry.anchor.line),
  ).toEqual([4, 7]);
});

test('accepts matched native parent authority and refuses wrong build, parent and cwd', () => {
  expect(
    indexBoundObserverSource(binding, source, raw).identity.session_id,
  ).toBe(source.expected_session_id);
  for (const [field, value] of [
    ['cli_version', '0.146.1'],
    ['originator', 'other'],
    ['thread_source', 'subagent'],
    ['cwd', '/other'],
    ['id', 'other'],
  ]) {
    expect(() =>
      indexBoundObserverSource(
        binding,
        source,
        changed((rows) => {
          rows[0]!.payload[field!] = value;
        }),
      ),
    ).toThrow();
  }
  expect(() =>
    indexBoundObserverSource(
      { ...binding, dialect: 'codex-response-items-0.144.3' },
      source,
      raw,
    ),
  ).toThrow();
});

test('native event allowances remain closed to uninspected fields and builds', () => {
  for (const type of ['event_msg']) {
    expect(() =>
      indexCodexTranscript(
        source,
        changed((rows) => {
          rows.find((row) => row.type === type)!.payload['hidden_action'] = {};
        }),
      ),
    ).toThrow();
  }
  expect(() =>
    indexCodexTranscript(
      source,
      changed((rows) => {
        rows[1]!.payload['type'] = 'unknown_event';
      }),
    ),
  ).toThrow();
  const older = { ...source, expected_cli_version: '0.144.3' };
  expect(() =>
    indexCodexTranscript(
      older,
      changed((rows) => {
        rows[0]!.payload['cli_version'] = '0.144.3';
      }),
    ),
  ).toThrow();
});

test('preserves the native assistant response without counting its telemetry twice', () => {
  const events = readFileSync(
    new URL(
      './fixtures/observer/codex-0.146.0-response-events.jsonl',
      import.meta.url,
    ),
  );
  const index = indexCodexTranscript(source, events);
  expect(
    index.entries
      .filter((entry) => entry.kind === 'message')
      .map((entry) => entry.text),
  ).toEqual(['Native capture response one complete.']);
  expect(
    index.entries.filter(
      (entry) => entry.kind === 'call' || entry.kind === 'result',
    ),
  ).toEqual([]);
});

test('context settings remain opaque metadata while bound identity stays enforced', () => {
  const configured = changed((rows) => {
    const context = rows.find((row) => row.type === 'turn_context')!.payload;
    context['sandbox_policy'] = { type: 'danger-full-access' };
    context['permission_profile'] = { type: 'disabled' };
    context['multi_agent_version'] = 'v2';
    context['multi_agent_mode'] = 'explicitRequestOnly';
    const state = rows.find((row) => row.type === 'world_state')!.payload[
      'state'
    ] as Record<string, unknown>;
    state['plugins_instructions'] = { enabled: ['superpowers'] };
    state['agents_md'] = { '/fixture/AGENTS.md': 'project instructions' };
  });
  const index = indexCodexTranscript(source, configured);
  expect(index.identity.conversation).toBe('parent');
  expect(index.entries.filter((entry) => entry.kind === 'call')).toEqual([]);
  for (const type of ['world_state', 'turn_context']) {
    for (const field of [
      'session_id',
      'sessionId',
      'thread_id',
      'cli_version',
      'cwd',
    ]) {
      expect(() =>
        indexCodexTranscript(
          source,
          changed((rows) => {
            rows.find((row) => row.type === type)!.payload[field] = 'foreign';
          }),
        ),
      ).toThrow();
    }
  }
});

test('partial world updates retain metadata and reject conflicting local identity', () => {
  const partial = changed((rows) => {
    rows.find((row) => row.type === 'world_state')!.payload = {
      full: false,
      state: { plugins_instructions: true },
    };
  });
  expect(
    indexCodexTranscript(source, partial).entries.some(
      (entry) =>
        entry.kind === 'non_action' && entry.record_type === 'world_state',
    ),
  ).toBe(true);
  expect(() =>
    indexCodexTranscript(
      source,
      changed((rows) => {
        rows.find((row) => row.type === 'world_state')!.payload = {
          full: false,
          state: {
            environments: { environments: { local: { cwd: '/foreign' } } },
          },
        };
      }),
    ),
  ).toThrow();
});
