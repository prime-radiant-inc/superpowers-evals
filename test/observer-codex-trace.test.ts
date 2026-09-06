import { expect, test } from 'bun:test';
import { indexCodexTranscript } from '../src/experiments/observer/codex.ts';
import { validateCodexTraceLinks } from '../src/experiments/observer/codex-trace.ts';
import type {
  JsonValue,
  RawSource,
} from '../src/experiments/observer/contracts.ts';

type TestObject = Record<string, JsonValue>;
type TestRow = TestObject & { payload: TestObject };

const source: RawSource = {
  source_id: 'codex-parent',
  runtime: 'codex',
  expected_session_id: 'trace-thread',
  expected_cwd: '/capture/codex-parent/workdir',
  expected_cli_version: '0.146.0',
};
const empty = new Uint8Array();

test('missing native evidence cannot prove a nested patch parent', () => {
  const ordinary = new TextEncoder().encode(
    `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'inner',
        turn_id: 'turn',
        stdout: 'Success',
        stderr: '',
        success: true,
        changes: {
          '/capture/codex-parent/workdir/note.txt': {
            type: 'add',
            content: 'hello\n',
          },
        },
        status: 'completed',
      },
    })}\n`,
  );
  expect(() =>
    validateCodexTraceLinks(source, ordinary, {
      manifest: empty,
      trace: empty,
      payloads: new Map(),
    }),
  ).toThrow();
});

function textBundle(): {
  manifest: Uint8Array;
  trace: Uint8Array;
  payloads: Map<string, Uint8Array>;
} {
  const fixture = require('./fixtures/observer/codex-0.146.0-trace-text.json');
  return {
    manifest: new TextEncoder().encode(fixture.manifest),
    trace: new TextEncoder().encode(fixture.trace),
    payloads: new Map<string, Uint8Array>(
      Object.entries(fixture.payloads).map(([path, value]) => [
        path,
        new TextEncoder().encode(value as string),
      ]),
    ),
  };
}
const textSource = {
  ...source,
  expected_session_id: '01a075b7-4ea7-7f53-a086-3d455194b767',
};

test('a native text-only trace proves no patch actions', () => {
  expect(validateCodexTraceLinks(textSource, empty, textBundle())).toEqual([]);
});

function editJson(
  raw: Uint8Array,
  edit: (value: TestObject) => void,
): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(raw));
  edit(value);
  return new TextEncoder().encode(JSON.stringify(value));
}
function editTrace(
  bundle: ReturnType<typeof textBundle>,
  edit: (rows: TestRow[]) => void,
) {
  const rows = new TextDecoder()
    .decode(bundle.trace)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  edit(rows);
  bundle.trace = new TextEncoder().encode(
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

test.each([
  ['foreign runtime', { runtime: 'claude' }],
  ['unqualified build', { expected_cli_version: '0.144.3' }],
  ['foreign root thread', { expected_session_id: 'other-thread' }],
  ['foreign cwd', { expected_cwd: '/other' }],
] as const)('rejects %s in the supplied source', (_name, change) => {
  expect(() =>
    validateCodexTraceLinks({ ...textSource, ...change }, empty, textBundle()),
  ).toThrow();
});

test.each([
  [
    'wrong schema',
    (m: TestObject) => {
      m['schema_version'] = 2;
    },
  ],
  [
    'unknown field',
    (m: TestObject) => {
      m['parent_thread_id'] = 'foreign';
    },
  ],
  [
    'foreign root',
    (m: TestObject) => {
      m['root_thread_id'] = 'foreign';
    },
  ],
  [
    'foreign rollout',
    (m: TestObject) => {
      m['rollout_id'] = 'foreign';
    },
  ],
  [
    'foreign trace',
    (m: TestObject) => {
      m['trace_id'] = 'foreign';
    },
  ],
  [
    'external raw log',
    (m: TestObject) => {
      m['raw_event_log'] = '/tmp/trace.jsonl';
    },
  ],
] as const)('rejects manifest %s', (_name, edit) => {
  const bundle = textBundle();
  bundle.manifest = editJson(bundle.manifest, edit);
  expect(() => validateCodexTraceLinks(textSource, empty, bundle)).toThrow();
});

test.each([
  [
    'gap',
    (r: TestRow[]) => {
      r.splice(3, 1);
    },
  ],
  [
    'duplicate sequence',
    (r: TestRow[]) => {
      r[3]!['seq'] = 3;
    },
  ],
  [
    'foreign rollout',
    (r: TestRow[]) => {
      r[3]!['rollout_id'] = 'foreign';
    },
  ],
  [
    'foreign thread',
    (r: TestRow[]) => {
      r[3]!['thread_id'] = 'foreign';
    },
  ],
  [
    'conflicting turn',
    (r: TestRow[]) => {
      r[3]!['codex_turn_id'] = 'foreign';
    },
  ],
  [
    'unknown envelope field',
    (r: TestRow[]) => {
      r[3]!['parent_thread_id'] = 'foreign';
    },
  ],
  [
    'duplicate root',
    (r: TestRow[]) => {
      r[2]!.payload = r[0]!.payload;
    },
  ],
] as const)('rejects native envelope %s', (_name, edit) => {
  const bundle = textBundle();
  editTrace(bundle, edit);
  expect(() => validateCodexTraceLinks(textSource, empty, bundle)).toThrow();
});

test('native root metadata cannot disagree or disappear', () => {
  const bundle = textBundle();
  const raw = bundle.payloads.get('payloads/1.json')!;
  for (const edit of [
    (m: TestObject) => {
      m['cwd'] = '/other';
    },
    (m: TestObject) => {
      m['session_source'] = { subagent: {} };
    },
    (m: TestObject) => {
      m['cli_version'] = '0.144.3';
    },
    (m: TestObject) => {
      m['thread_id'] = 'other';
    },
  ]) {
    bundle.payloads.set('payloads/1.json', editJson(raw, edit));
    expect(() => validateCodexTraceLinks(textSource, empty, bundle)).toThrow();
  }
  bundle.payloads.clear();
  expect(() => validateCodexTraceLinks(textSource, empty, bundle)).toThrow();
});

test('an existing native bundle cannot substitute for a missing required patch join', () => {
  const raw = new TextEncoder().encode(
    `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'patch_apply_end', call_id: 'inner' },
    })}\n`,
  );
  expect(() =>
    validateCodexTraceLinks(textSource, raw, textBundle()),
  ).toThrow();
});

function patchFixture(completed = false) {
  const fixture = completed
    ? require('./fixtures/observer/codex-0.146.0-trace-patch-completed.json')
    : require('./fixtures/observer/codex-0.146.0-trace-patch-failed.json');
  const encode = (value: string) => new TextEncoder().encode(value);
  return {
    source: {
      ...source,
      expected_session_id: JSON.parse(fixture.manifest)['root_thread_id'],
    },
    ordinary: encode(fixture.ordinary),
    bundle: {
      manifest: encode(fixture.manifest),
      trace: encode(fixture.trace),
      payloads: new Map<string, Uint8Array>(
        Object.entries(fixture.payloads).map(([path, value]) => [
          path,
          encode(value as string),
        ]),
      ),
    },
  };
}

test('proves a native failed patch inner ID through its runtime cell to outer exec', () => {
  const fixture = patchFixture();
  const links = validateCodexTraceLinks(
    fixture.source,
    fixture.ordinary,
    fixture.bundle,
  );
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    inner_call_id: 'exec-ed8a4740-519c-4bdb-9ba0-51920aeb6a9a',
    outer_call_id: 'call_native_trace_patch',
    runtime_cell_id: '1',
    turn_id: '01a075bc-2d2c-7361-b8a3-74eb4410c972',
    patch_anchor: { source_id: 'codex-parent', line: 3, block: null },
    call_anchor: { source_id: 'codex-parent', line: 2, block: null },
  });
  expect(
    links[0]?.evidence.find((p) => p.member === 'payloads/8.json')?.payload,
  ).toMatchObject({
    success: false,
    status: 'failed',
    changes: {
      '/capture/codex-parent/workdir/trace-spec.md': {
        type: 'add',
        content: 'native trace patch\n',
      },
    },
  });
});

test('completed inner links work before cell completion and later trace actions stay outside the ordinary prefix', () => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    rows.splice(12);
  });
  expect(
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toHaveLength(1);
  const prefix = new TextEncoder().encode(
    `${new TextDecoder().decode(fixture.ordinary).split('\n').slice(0, 2).join('\n')}\n`,
  );
  expect(
    validateCodexTraceLinks(fixture.source, prefix, fixture.bundle),
  ).toEqual([]);
});

const requiredEvents = [
  'code_cell_started',
  'tool_call_started',
  'tool_call_runtime_started',
  'tool_call_runtime_ended',
  'tool_call_ended',
];
test.each(requiredEvents)('requires the explicit %s edge', (type) => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    const index = rows.findIndex((r) => r.payload['type'] === type);
    rows.splice(index, 1);
    rows.forEach((r, i) => {
      r['seq'] = i + 1;
    });
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test.each(
  requiredEvents,
)('rejects duplicate %s IDs even with identical payload', (type) => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    const index = rows.findIndex((r) => r.payload['type'] === type);
    rows.splice(index, 0, structuredClone(rows[index]!));
    rows.forEach((r, i) => {
      r['seq'] = i + 1;
    });
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test.each(requiredEvents)('rejects unknown %s linkage fields', (type) => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    rows.find((r) => r.payload['type'] === type)!.payload['parent_call_id'] =
      'foreign';
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test.each([
  'payloads/6.json',
  'payloads/7.json',
  'payloads/8.json',
  'payloads/9.json',
])('requires linked member %s', (member) => {
  const fixture = patchFixture();
  fixture.bundle.payloads.delete(member);
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test.each([
  ['runtime_cell_id', 'foreign-cell'],
  ['source_js', 'text("unrelated")'],
  ['model_visible_call_id', 'foreign-call'],
] as const)('rejects a conflicting cell %s', (field, value) => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    rows.find((r) => r.payload['type'] === 'code_cell_started')!.payload[
      field
    ] = value;
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test.each([
  ['success', true],
  ['status', 'completed'],
  ['stdout', 'different'],
  ['stderr', 'different'],
  ['changes', {}],
  ['call_id', 'foreign'],
  ['turn_id', 'foreign'],
  ['parent_call_id', 'foreign'],
] as const)('requires full ordinary/runtime agreement for %s', (field, value) => {
  const fixture = patchFixture();
  fixture.bundle.payloads.set(
    'payloads/8.json',
    editJson(fixture.bundle.payloads.get('payloads/8.json')!, (p) => {
      p[field] = value;
    }),
  );
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});

test('rejects conflicting ordinary patch replays and outer turn identity', () => {
  const fixture = patchFixture();
  const lines = new TextDecoder().decode(fixture.ordinary).trim().split('\n');
  const conflictingPatch = JSON.parse(lines[2]!);
  conflictingPatch.payload.stdout = 'conflicting';
  const duplicated = new TextEncoder().encode(
    `${lines.concat(JSON.stringify(conflictingPatch)).join('\n')}\n`,
  );
  expect(() =>
    validateCodexTraceLinks(fixture.source, duplicated, fixture.bundle),
  ).toThrow();
  const outer = JSON.parse(lines[1]!);
  outer.payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign';
  lines[1] = JSON.stringify(outer);
  expect(() =>
    validateCodexTraceLinks(
      fixture.source,
      new TextEncoder().encode(`${lines.join('\n')}\n`),
      fixture.bundle,
    ),
  ).toThrow();
});

test('proves the actual successful native patch without rewriting its result', () => {
  const fixture = patchFixture(true);
  const links = validateCodexTraceLinks(
    fixture.source,
    fixture.ordinary,
    fixture.bundle,
  );
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    inner_call_id: 'exec-16fb020d-313b-41bb-8f69-9a62d2311d83',
    outer_call_id: 'call_native_trace_patch',
  });
  expect(
    links[0]?.evidence.find((p) => p.member === 'payloads/8.json')?.payload,
  ).toMatchObject({ success: true, status: 'completed' });
  expect(
    links[0]?.evidence.find((p) => p.member === 'payloads/9.json')?.payload,
  ).toEqual({ type: 'code_mode_response', value: {} });
});

test('rejects two runtime cells claiming the same outer exec', () => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    const index = rows.findIndex(
      (row) => row.payload['type'] === 'code_cell_started',
    );
    const extra = structuredClone(rows[index]!);
    extra.payload['runtime_cell_id'] = 'other-cell';
    rows.splice(index, 0, extra);
    rows.forEach((row, i) => {
      row['seq'] = i + 1;
    });
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test('rejects reused code mode tool IDs within a runtime cell', () => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    const index = rows.findIndex(
      (row) => row.payload['type'] === 'tool_call_started',
    );
    const extra = structuredClone(rows[index]!);
    extra.payload['tool_call_id'] = 'other-inner';
    rows.splice(index, 0, extra);
    rows.forEach((row, i) => {
      row['seq'] = i + 1;
    });
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test('rejects one raw payload ID naming two different members', () => {
  const fixture = patchFixture();
  editTrace(fixture.bundle, (rows) => {
    const invocation = rows.find(
      (row) => row.payload['type'] === 'tool_call_started',
    )!.payload['invocation_payload'] as TestObject;
    invocation['raw_payload_id'] = 'raw_payload:1';
  });
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});
test('retains the digest and full native event payload for each join witness', () => {
  const fixture = patchFixture(true);
  const [link] = validateCodexTraceLinks(
    fixture.source,
    fixture.ordinary,
    fixture.bundle,
  );
  const proof = link!.evidence.find(
    (p) => p.member === 'trace.jsonl' && p.line === 8,
  )!;
  expect(proof.payload).toMatchObject({
    seq: 8,
    payload: {
      type: 'code_cell_started',
      model_visible_call_id: 'call_native_trace_patch',
    },
  });
  expect(proof.sha256).toBe(
    new Bun.CryptoHasher('sha256').update(fixture.bundle.trace).digest('hex'),
  );
});

function supportingFiles(bundle: ReturnType<typeof patchFixture>['bundle']) {
  return [
    ...new Map([
      ['manifest.json', bundle.manifest],
      ['trace.jsonl', bundle.trace],
      ...bundle.payloads,
    ]),
  ].map(([path, bytes]) => ({
    root_id: 'trace',
    relative_path: `bundle/${path}`,
    bytes,
  }));
}
function ordinaryRows(raw: Uint8Array): TestRow[] {
  return new TextDecoder()
    .decode(raw)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
function encodeRows(rows: TestRow[]): Uint8Array {
  return new TextEncoder().encode(
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

test.each([
  'outer',
  'patch',
])('canonicalizes exact ordinary %s replays through the indexer', (kind) => {
  const fixture = patchFixture(true);
  const rows = ordinaryRows(fixture.ordinary);
  if (kind === 'outer') rows.splice(2, 0, structuredClone(rows[1]!));
  else rows.push(structuredClone(rows[2]!));
  const raw = encodeRows(rows);
  const links = validateCodexTraceLinks(fixture.source, raw, fixture.bundle);
  expect(links).toHaveLength(1);
  expect(links[0]?.call_anchor.line).toBe(2);
  expect(links[0]?.patch_anchor.line).toBe(kind === 'outer' ? 4 : 3);
  const index = indexCodexTranscript(
    fixture.source,
    raw,
    supportingFiles(fixture.bundle),
  );
  expect(index.entries.filter((entry) => entry.kind === 'result')).toHaveLength(
    2,
  );
  expect(index.entries.find((entry) => entry.kind === 'replay')).toMatchObject({
    anchor: { line: kind === 'outer' ? 3 : 5 },
    canonical_anchor: { line: kind === 'outer' ? 2 : 3 },
  });
  const changed = rows[kind === 'outer' ? 2 : 4]!;
  changed.payload[kind === 'outer' ? 'input' : 'stdout'] = 'conflicting';
  expect(() =>
    indexCodexTranscript(
      fixture.source,
      encodeRows(rows),
      supportingFiles(fixture.bundle),
    ),
  ).toThrow();
});

test('direct patch replays also retain their first anchor with native members supplied', () => {
  const fixture = patchFixture(true);
  const rows = ordinaryRows(fixture.ordinary);
  const innerId = rows[2]!.payload['call_id']!;
  rows[1]!.payload['call_id'] = innerId;
  rows[1]!.payload['name'] = 'apply_patch';
  rows[3]!.payload['call_id'] = innerId;
  rows.push(structuredClone(rows[2]!));
  const raw = encodeRows(rows);
  expect(validateCodexTraceLinks(fixture.source, raw, fixture.bundle)).toEqual(
    [],
  );
  const index = indexCodexTranscript(
    fixture.source,
    raw,
    supportingFiles(fixture.bundle),
  );
  expect(index.entries.at(-1)).toMatchObject({
    kind: 'replay',
    anchor: { line: 5 },
    canonical_anchor: { line: 3 },
  });
});

test('rejects a required invocation whose input disagrees with its native preview', () => {
  const fixture = patchFixture(true);
  fixture.bundle.payloads.set(
    'payloads/6.json',
    editJson(fixture.bundle.payloads.get('payloads/6.json')!, (value) => {
      (value['payload'] as TestObject)['input'] =
        '*** Begin Patch\n*** Add File: unrelated.txt\n+other\n*** End Patch';
    }),
  );
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});

test('native previews count 160 Unicode scalar values and append ellipsis only when truncated', () => {
  const fixture = patchFixture(true);
  const prefix = '*** Begin Patch\n*** Add File: unicode.md\n+';
  const input = `${prefix}${'🙂'.repeat(200)}\n*** End Patch`;
  fixture.bundle.payloads.set(
    'payloads/6.json',
    editJson(fixture.bundle.payloads.get('payloads/6.json')!, (value) => {
      (value['payload'] as TestObject)['input'] = input;
    }),
  );
  const setPreview = (preview: string) =>
    editTrace(fixture.bundle, (rows) => {
      const tool = rows.find(
        (row) => row.payload['type'] === 'tool_call_started',
      )!;
      (tool.payload['summary'] as TestObject)['input_preview'] = preview;
    });
  setPreview(`${prefix}${'🙂'.repeat(118)}...`);
  expect(
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toHaveLength(1);
  setPreview(`${prefix}${'🙂'.repeat(118)}`);
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
  setPreview(`${input.slice(0, 160)}...`);
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
  fixture.bundle.payloads.set(
    'payloads/6.json',
    editJson(fixture.bundle.payloads.get('payloads/6.json')!, (value) => {
      (value['payload'] as TestObject)['input'] = '🙂'.repeat(160);
    }),
  );
  setPreview('🙂'.repeat(160));
  expect(
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toHaveLength(1);
  setPreview(`${'🙂'.repeat(160)}...`);
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});

function moveTraceEvent(
  rows: TestRow[],
  type: string,
  beforeType: string,
): void {
  const index = rows.findIndex((row) => row.payload['type'] === type);
  const [row] = rows.splice(index, 1);
  rows.splice(
    rows.findIndex((value) => value.payload['type'] === beforeType),
    0,
    row!,
  );
  rows.forEach((value, i) => {
    value['seq'] = i + 1;
  });
}

test.each([
  [
    'cell ended before nested start',
    (rows: TestRow[]) =>
      moveTraceEvent(rows, 'code_cell_ended', 'tool_call_started'),
  ],
  [
    'terminal initial response before nested start',
    (rows: TestRow[]) =>
      moveTraceEvent(rows, 'code_cell_initial_response', 'tool_call_started'),
  ],
  [
    'new cell after turn end',
    (rows: TestRow[]) =>
      moveTraceEvent(rows, 'codex_turn_ended', 'code_cell_started'),
  ],
  [
    'foreign turn end ID',
    (rows: TestRow[]) => {
      rows.find((row) => row.payload['type'] === 'codex_turn_ended')!.payload[
        'codex_turn_id'
      ] = 'foreign';
    },
  ],
  [
    'foreign cell end ID',
    (rows: TestRow[]) => {
      rows.find((row) => row.payload['type'] === 'code_cell_ended')!.payload[
        'runtime_cell_id'
      ] = 'foreign';
    },
  ],
  [
    'foreign cell end context',
    (rows: TestRow[]) => {
      rows.find((row) => row.payload['type'] === 'code_cell_ended')![
        'codex_turn_id'
      ] = null;
    },
  ],
  [
    'unrecognized cell end field',
    (rows: TestRow[]) => {
      rows.find((row) => row.payload['type'] === 'code_cell_ended')!.payload[
        'parent_call_id'
      ] = 'foreign';
    },
  ],
  [
    'nonterminal cell end',
    (rows: TestRow[]) => {
      rows.find((row) => row.payload['type'] === 'code_cell_ended')!.payload[
        'status'
      ] = 'yielded';
    },
  ],
  [
    'duplicate cell end',
    (rows: TestRow[]) => {
      const index = rows.findIndex(
        (row) => row.payload['type'] === 'code_cell_ended',
      );
      rows.splice(index, 0, structuredClone(rows[index]!));
      rows.forEach((row, i) => {
        row['seq'] = i + 1;
      });
    },
  ],
] as const)('rejects contradictory lifecycle: %s', (_name, edit) => {
  const fixture = patchFixture(true);
  editTrace(fixture.bundle, edit);
  expect(() =>
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toThrow();
});

test('a yielded cell may continue issuing nested work after its own turn completes', () => {
  const fixture = patchFixture(true);
  editTrace(fixture.bundle, (rows) => {
    rows.find(
      (row) => row.payload['type'] === 'code_cell_initial_response',
    )!.payload['status'] = 'yielded';
    moveTraceEvent(rows, 'code_cell_initial_response', 'tool_call_started');
    moveTraceEvent(rows, 'codex_turn_ended', 'tool_call_started');
  });
  expect(
    validateCodexTraceLinks(fixture.source, fixture.ordinary, fixture.bundle),
  ).toHaveLength(1);
  const index = indexCodexTranscript(
    fixture.source,
    fixture.ordinary,
    supportingFiles(fixture.bundle),
  );
  expect(index.entries.filter((entry) => entry.kind === 'result')).toHaveLength(
    2,
  );
});
