import { expect, test } from 'bun:test';
import type { ObserverBinding } from '../src/experiments/observer/binding.ts';
import { indexCodexTranscript } from '../src/experiments/observer/codex.ts';
import {
  type JsonValue,
  ObserverEvidenceError,
  type RawAnchor,
  type RawSource,
} from '../src/experiments/observer/contracts.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';
import type { ActorReview } from '../src/experiments/observer/review.ts';
import { scoreObserverEvidence } from '../src/experiments/observer/score.ts';

// Privacy-safe contract cases reproduce inspected 0.146.0 shapes. They are
// synthetic and do not qualify a native build or claim a fresh capture.
type Payload = Record<string, JsonValue>;
const source: RawSource = {
  source_id: 'parent',
  runtime: 'codex',
  expected_session_id: 'web-fixture',
  expected_cwd: '/fixture/workdir',
  expected_cli_version: '0.146.0',
};
const header = {
  type: 'session_meta',
  payload: {
    id: source.expected_session_id,
    cwd: source.expected_cwd,
    cli_version: source.expected_cli_version,
    source: 'cli',
    originator: 'codex-tui',
    thread_source: 'user',
  },
};
const open: Payload = { type: 'open_page', url: 'https://example.com/' };
const search: Payload = {
  type: 'search',
  query: 'example documentation',
  queries: ['example documentation', 'example reference'],
};
const end = (id = 'web-one', action: Payload = open): Payload => ({
  type: 'web_search_end',
  call_id: id,
  query: 'example',
  action,
});
const completed = (id = 'web-one', action: Payload = open): Payload => ({
  type: 'web_search_call',
  id,
  status: 'completed',
  action,
  internal_chat_message_metadata_passthrough: { turn_id: 'turn-one' },
});
const abort: Payload = {
  type: 'turn_aborted',
  turn_id: 'turn-one',
  reason: 'interrupted',
  started_at: 1000,
  completed_at: 2000,
  duration_ms: 1000,
};
const at = (line: number): RawAnchor => ({
  source_id: 'parent',
  line,
  block: null,
});
function bytes(payloads: Payload[], version = '0.146.0'): Buffer {
  return Buffer.from(
    `${[
      { ...header, payload: { ...header.payload, cli_version: version } },
      ...payloads.map((payload) => ({
        type:
          payload['type'] === 'web_search_end' ||
          payload['type'] === 'turn_aborted' ||
          payload['type'] === 'patch_apply_end'
            ? 'event_msg'
            : 'response_item',
        payload,
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`,
  );
}
const index = (payloads: Payload[]) =>
  indexCodexTranscript(source, bytes(payloads));
function rejects(
  payloads: Payload[],
  code: ObserverEvidenceError['code'],
  line: number,
) {
  try {
    index(payloads);
    throw new Error('Expected native evidence rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ObserverEvidenceError);
    expect((error as ObserverEvidenceError).code).toBe(code);
    expect((error as ObserverEvidenceError).anchor).toEqual(at(line));
  }
}

test.each([
  open,
  search,
])('native web action joins the complete original payloads at their physical anchors: %j', (action) => {
  expect(
    index([end('web-one', action), completed('web-one', action)]).entries.slice(
      1,
    ),
  ).toEqual([
    {
      kind: 'call',
      anchor: at(2),
      call_id: 'native:web-one',
      native_call_id: 'web-one',
      name: 'web_search_call',
      payload: end('web-one', action),
    },
    {
      kind: 'result',
      anchor: at(3),
      call_id: 'native:web-one',
      call_anchor: at(2),
      payload: completed('web-one', action),
    },
  ]);
});

test('native web replay retains canonical anchors without duplicating actions or results', () => {
  const entries = index([end(), completed(), end(), completed()]).entries;
  expect(entries.filter((entry) => entry.kind === 'call')).toHaveLength(1);
  expect(entries.filter((entry) => entry.kind === 'result')).toHaveLength(1);
  expect(entries.slice(3)).toEqual([
    { kind: 'replay', anchor: at(4), canonical_anchor: at(2) },
    { kind: 'replay', anchor: at(5), canonical_anchor: at(3) },
  ]);
});

test('interleaved native web completions join by explicit identity and entire action', () => {
  const entries = index([
    end('first', open),
    end('second', search),
    completed('second', search),
    completed('first', open),
  ]).entries;
  expect(
    entries.flatMap((entry) =>
      entry.kind === 'result'
        ? [[entry.anchor.line, entry.call_anchor.line, entry.call_id]]
        : [],
    ),
  ).toEqual([
    [4, 3, 'native:second'],
    [5, 2, 'native:first'],
  ]);
});

test('a native end without the completed response retains an unresolved call', () => {
  const entries = index([end()]).entries;
  expect(entries.filter((entry) => entry.kind === 'call')).toHaveLength(1);
  expect(entries.filter((entry) => entry.kind === 'result')).toHaveLength(0);
});

test('native completion requires its earlier explicit end identity', () => {
  rejects([completed()], 'orphan_result', 2);
  rejects([completed(), end()], 'orphan_result', 2);
  rejects([end(), completed('different')], 'orphan_result', 3);
});

test('native joins compare the entire action, including secondary queries', () => {
  rejects(
    [end(), completed('web-one', { ...open, url: 'https://example.org/' })],
    'replay_conflict',
    3,
  );
  rejects(
    [
      end('web-one', search),
      completed('web-one', {
        ...search,
        queries: ['example documentation', 'changed'],
      }),
    ],
    'replay_conflict',
    3,
  );
});

test('reused native IDs reject changed event and completed-response payloads', () => {
  rejects([end(), { ...end(), query: 'changed' }], 'replay_conflict', 3);
  rejects(
    [
      end(),
      completed(),
      {
        ...completed(),
        internal_chat_message_metadata_passthrough: { turn_id: 'other' },
      },
    ],
    'replay_conflict',
    4,
  );
});

test('native web IDs cannot alias ordinary tool calls or outputs', () => {
  rejects(
    [
      {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'web-one',
        arguments: '{}',
      },
      completed(),
    ],
    'replay_conflict',
    3,
  );
  rejects(
    [
      end(),
      { type: 'function_call_output', call_id: 'web-one', output: 'completed' },
    ],
    'replay_conflict',
    3,
  );
});

test.each([
  { ...end(), hidden_action: {} },
  { ...end(), call_id: '' },
  { ...end(), id: 'web-one' },
  { ...end(), query: null },
  { ...end(), action: { ...open, hidden_action: {} } },
  { ...end(), action: { type: 'find', pattern: 'example' } },
  { ...end(), action: { ...search, queries: [1, 2] } },
] as Payload[])('rejects uninspected native end shape: %j', (payload) => {
  rejects([payload], 'unknown_record', 2);
});

test.each([
  { ...completed(), hidden_action: {} },
  { ...completed(), id: '' },
  { ...completed(), call_id: 'web-one' },
  { ...completed(), status: 'in_progress' },
  { ...completed(), status: 'failed' },
  { ...completed(), action: { ...open, hidden_action: {} } },
  {
    ...completed(),
    internal_chat_message_metadata_passthrough: {
      turn_id: 'turn-one',
      hidden_action: {},
    },
  },
] as Payload[])('rejects uninspected native completion shape: %j', (payload) => {
  rejects([end(), payload], 'unknown_record', 3);
});

test('the inspected interruption remains anchored metadata with no approval or success', () => {
  expect(index([abort]).entries.slice(1)).toEqual([
    {
      kind: 'non_action',
      anchor: at(2),
      record_type: 'event_msg.turn_aborted',
    },
  ]);
});

test.each([
  { ...abort, reason: 'completed' },
  { ...abort, hidden_action: {} },
  { ...abort, duration_ms: -1 },
  { ...abort, turn_id: '' },
] as Payload[])('interruption metadata remains closed: %j', (payload) => {
  rejects([payload], 'unknown_record', 2);
});

test('native allowances do not swallow patch events or widen the older web dialect', () => {
  rejects(
    [{ type: 'patch_apply_end', call_id: 'patch', success: true }],
    'unknown_record',
    2,
  );
  const older = { ...source, expected_cli_version: '0.144.3' };
  for (const payload of [end(), abort]) {
    expect(() =>
      indexCodexTranscript(older, bytes([payload], '0.144.3')),
    ).toThrow();
  }
  const legacy = indexCodexTranscript(older, bytes([completed()], '0.144.3'));
  expect(legacy.entries[1]).toMatchObject({
    kind: 'call',
    native_call_id: null,
    call_id: 'anchor:["parent",2,null]',
  });
});

function scoreWeb(includeResult: boolean, classifyResult: boolean) {
  const raw = bytes([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Read the reference.' }],
    },
    end(),
    ...(includeResult ? [completed()] : []),
    abort,
  ]);
  const binding: ObserverBinding = {
    schema_version: 2,
    run_id: 'web-fixture',
    campaign: null,
    runtime: 'codex',
    dialect: 'codex-response-items-0.146.0',
    cli_version: '0.146.0',
    home: '/fixture/home',
    workdir: source.expected_cwd,
    launch_cwd: source.expected_cwd,
    phase: 'finalized',
    parent_source_id: source.source_id,
    roots: [
      {
        id: 'sessions',
        kind: 'transcripts',
        path: '/fixture/home/.codex/sessions',
      },
      { id: 'documents', kind: 'artifacts', path: source.expected_cwd },
    ],
    sources: [
      {
        source,
        root_id: 'sessions',
        relative_path: 'parent.jsonl',
        device: '1',
        inode: '2',
        parent_link: null,
      },
    ],
  };
  const review: ActorReview = {
    schema_version: 2,
    reviewer: 'synthetic contract review',
    stop_reason: 'timeout',
    source_prefixes: [createRawPrefix(source, raw)],
    supporting_prefixes: [],
    events: [],
    actions: [
      {
        anchor: at(3),
        call_id: 'native:web-one',
        effects: ['read_only'],
        result_anchors: classifyResult ? [at(4)] : [],
        success: true,
        changed_artifacts: [],
        delegation: null,
        note: 'Read reference.',
      },
    ],
  };
  return scoreObserverEvidence({
    raw_sources: [{ source_id: source.source_id, bytes: raw }],
    supporting_files: [],
    binding,
    receipts: [],
    review,
  });
}

test('scoring requires native web result coverage and never invents missing completion', () => {
  expect(scoreWeb(true, true).evidence_errors).toEqual([]);
  expect(scoreWeb(true, false).evidence_errors).toEqual([
    { code: 'result_coverage_mismatch', anchor: at(3) },
  ]);
  expect(scoreWeb(false, false).evidence_errors).toContainEqual({
    code: 'unresolved_action_result',
    anchor: at(3),
  });
});
