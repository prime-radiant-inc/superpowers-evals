import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { indexCodexTranscript } from '../src/experiments/observer/codex.ts';
import {
  ObserverEvidenceError,
  type ObserverSupportingFile,
  type RawSource,
} from '../src/experiments/observer/contracts.ts';

const source: RawSource = {
  source_id: 'parent',
  runtime: 'codex',
  expected_session_id: 'session',
  expected_cwd: '/fixture/workdir',
  expected_cli_version: '0.146.0',
};
const patch = {
  type: 'patch_apply_end',
  call_id: 'inner',
  turn_id: 'turn',
  stdout: 'Success',
  stderr: '',
  success: true,
  changes: {
    '/fixture/workdir/example.md': { type: 'add', content: 'example\n' },
  },
  status: 'completed',
};
const call = {
  type: 'custom_tool_call',
  name: 'exec',
  call_id: 'outer',
  input:
    'await tools.apply_patch("*** Begin Patch\\n*** Add File: /fixture/workdir/example.md\\n+example\\n*** End Patch")',
  internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
};
function raw(events: unknown[], direct = false) {
  return Buffer.from(
    `${[
      {
        type: 'session_meta',
        payload: {
          id: 'session',
          cwd: source.expected_cwd,
          cli_version: '0.146.0',
          source: 'cli',
        },
      },
      {
        type: 'response_item',
        payload: direct
          ? { ...call, name: 'apply_patch', call_id: 'inner' }
          : call,
      },
      ...events.map((payload) => ({ type: 'event_msg', payload })),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`,
  );
}

test('a nested patch without native parent evidence remains an orphan result', () => {
  try {
    indexCodexTranscript(source, raw([patch]));
    throw new Error('Expected an evidence error');
  } catch (error) {
    expect(error).toBeInstanceOf(ObserverEvidenceError);
    expect((error as ObserverEvidenceError).code).toBe('orphan_result');
    expect((error as ObserverEvidenceError).anchor?.line).toBe(3);
  }
});

test('an explicitly identified direct patch retains its entire result at its original anchor', () => {
  const index = indexCodexTranscript(source, raw([patch], true));
  expect(index.entries.at(-1)).toEqual({
    kind: 'result',
    anchor: { source_id: 'parent', line: 3, block: null },
    call_id: 'native:inner',
    call_anchor: { source_id: 'parent', line: 2, block: null },
    payload: patch,
  });
});

test('exact native patch replays do not duplicate a result and conflicting replays refuse', () => {
  const index = indexCodexTranscript(source, raw([patch, patch], true));
  expect(index.entries.at(-1)).toEqual({
    kind: 'replay',
    anchor: { source_id: 'parent', line: 4, block: null },
    canonical_anchor: { source_id: 'parent', line: 3, block: null },
  });
  expect(() =>
    indexCodexTranscript(
      source,
      raw([patch, { ...patch, stdout: 'other result' }], true),
    ),
  ).toThrow(ObserverEvidenceError);
});

test('a patch result cannot acquire a parent through reused ID on an unrelated tool', () => {
  const bytes = raw([patch], true)
    .toString()
    .replace('"name":"apply_patch"', '"name":"read_file"');
  expect(() => indexCodexTranscript(source, Buffer.from(bytes))).toThrow(
    ObserverEvidenceError,
  );
});

test('an explicit patch ID cannot link across conflicting turns', () => {
  expect(() =>
    indexCodexTranscript(
      source,
      raw([{ ...patch, turn_id: 'another-turn' }], true),
    ),
  ).toThrow(ObserverEvidenceError);
});

function nativeFixture(status: 'completed' | 'failed') {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/observer/codex-0.146.0-trace-patch-${status}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const ordinary = Buffer.from(fixture.ordinary);
  const header = JSON.parse(fixture.ordinary.split('\n')[0]).payload;
  const nativeSource = {
    ...source,
    expected_session_id: header.id,
    expected_cwd: header.cwd,
  };
  const files: ObserverSupportingFile[] = Object.entries({
    'manifest.json': fixture.manifest,
    'trace.jsonl': fixture.trace,
    ...fixture.payloads,
  }).map(([path, raw]) => ({
    root_id: 'tool-trace',
    relative_path: `bundle/${path}`,
    bytes: Buffer.from(raw as string),
  }));
  return { ordinary, nativeSource, files };
}

test.each([
  'completed',
  'failed',
] as const)('native %s patch retains one outer action and both physical results', (status) => {
  const f = nativeFixture(status);
  const index = indexCodexTranscript(f.nativeSource, f.ordinary, f.files);
  const calls = index.entries.filter((entry) => entry.kind === 'call');
  const results = index.entries.filter((entry) => entry.kind === 'result');
  expect(calls).toHaveLength(1);
  expect(results).toHaveLength(2);
  expect(results.map((result) => result.call_anchor)).toEqual([
    calls[0]!.anchor,
    calls[0]!.anchor,
  ]);
  const event = f.ordinary
    .toString()
    .trimEnd()
    .split('\n')
    .map((row) => JSON.parse(row))
    .find((row) => row.payload?.type === 'patch_apply_end');
  expect(results[0]!.payload).toEqual(event.payload);
  expect((results[0]!.payload as typeof patch).success).toBe(
    status === 'completed',
  );
  expect(() => indexCodexTranscript(f.nativeSource, f.ordinary, [])).toThrow(
    ObserverEvidenceError,
  );
});

test('native patch indexing refuses missing payloads and mixed supporting roots', () => {
  const f = nativeFixture('completed');
  expect(() =>
    indexCodexTranscript(
      f.nativeSource,
      f.ordinary,
      f.files.filter((file) => !file.relative_path.includes('/payloads/')),
    ),
  ).toThrow(ObserverEvidenceError);
  expect(() =>
    indexCodexTranscript(
      f.nativeSource,
      f.ordinary,
      f.files.map((file, i) => ({
        ...file,
        root_id: i ? file.root_id : 'other',
      })),
    ),
  ).toThrow(ObserverEvidenceError);
});
