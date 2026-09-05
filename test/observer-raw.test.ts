import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  ObserverEvidenceError,
  RawAnchorSchema,
  type RawIndex,
  RawIndexSchema,
  type RawPrefix,
  RawPrefixSchema,
  type RawSource,
  RawSourceSchema,
  SourceIdentitySchema,
} from '../src/experiments/observer/contracts.ts';
import {
  canonicalJson,
  createRawPrefix,
  parseCompleteJsonl,
  verifyRawPrefix,
  verifyReviewedSuffix,
} from '../src/experiments/observer/raw.ts';

const source = {
  source_id: 'main',
  runtime: 'codex' as const,
  expected_session_id: 's',
  expected_cwd: '/fixture',
  expected_cli_version: 'fixture',
};
const encode = (text: string) => new TextEncoder().encode(text);
const raw = encode('{"text":"é"}\r\n{"text":"second"}\n');

function evidenceError(operation: () => unknown): ObserverEvidenceError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ObserverEvidenceError);
    return error as ObserverEvidenceError;
  }
  throw new Error('Expected ObserverEvidenceError.');
}

function anchor(line: number, block: number | null = null) {
  return { source_id: source.source_id, line, block };
}

function validIndex(): RawIndex {
  return {
    schema_version: 2,
    source,
    identity: {
      session_id: 's',
      cwd: '/fixture',
      cli_version: 'fixture',
      conversation: 'parent',
      evidence: [anchor(1)],
    },
    prefix: {
      source_id: source.source_id,
      bytes: 100,
      sha256: 'a'.repeat(64),
      after_line: 4,
    },
    entries: [
      {
        kind: 'call',
        anchor: anchor(2, 0),
        call_id: 'call-1',
        native_call_id: null,
        name: 'exec',
        payload: { command: 'pwd' },
      },
      {
        kind: 'message',
        anchor: anchor(2, 1),
        role: 'assistant',
        text: 'Working on it.',
        message_id: 'message-1',
        claimed_origin: 'internal',
        approval_eligibility: 'ineligible',
      },
      {
        kind: 'result',
        anchor: anchor(3, 0),
        call_id: 'call-1',
        call_anchor: anchor(2, 0),
        payload: { output: '/fixture' },
      },
      {
        kind: 'replay',
        anchor: anchor(4, 0),
        canonical_anchor: anchor(2, 0),
      },
    ],
  };
}

test('anchors and boundaries count raw bytes and physical lines', () => {
  const rows = parseCompleteJsonl(source, raw);
  expect(rows.map((row) => row.anchor)).toEqual([
    { source_id: 'main', line: 1, block: null },
    { source_id: 'main', line: 2, block: null },
  ]);
  expect(rows[0]!.byte_end).toBe(encode('{"text":"é"}\r\n').length);
  expect(rows[1]!.byte_start).toBe(rows[0]!.byte_end);
  expect(rows[1]!.byte_end).toBe(raw.length);
  expect(rows.map((row) => row.value)).toEqual([
    { text: 'é' },
    { text: 'second' },
  ]);
});

test('empty input has no rows and a zero-byte prefix', () => {
  expect(parseCompleteJsonl(source, new Uint8Array())).toEqual([]);
  expect(createRawPrefix(source, new Uint8Array())).toEqual({
    source_id: 'main',
    bytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    after_line: 0,
  });
});

test.each([
  ['missing final LF', encode('{"a":1}'), 'incomplete_jsonl'],
  ['blank physical line', encode('{}\n\n'), 'invalid_jsonl'],
  ['null row', encode('null\n'), 'invalid_record'],
  ['array row', encode('[]\n'), 'invalid_record'],
  ['broken JSON', encode('{broken}\n'), 'invalid_jsonl'],
  [
    'invalid UTF-8',
    new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 10]),
    'invalid_utf8',
  ],
] as const)('%s rows reject without returning a partial index', (_name, bytes, code) => {
  const error = evidenceError(() => parseCompleteJsonl(source, bytes));
  expect(error.code).toBe(code);
});

test('UTF-8 BOM rejects before row parsing', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('{}\n')]);
  const error = evidenceError(() => parseCompleteJsonl(source, bytes));
  expect(error.code).toBe('invalid_utf8');
  expect(error.anchor).toBeNull();
});

test('UTF-8 BOM rejects at the start of a later physical line', () => {
  const bytes = new Uint8Array([
    ...encode('{}\n'),
    0xef,
    0xbb,
    0xbf,
    ...encode('{}\n'),
  ]);
  const error = evidenceError(() => parseCompleteJsonl(source, bytes));
  expect(error.code).toBe('invalid_utf8');
  expect(error.anchor).toEqual(anchor(2));
});

test('non-finite JSON numbers reject recursively', () => {
  const error = evidenceError(() =>
    parseCompleteJsonl(source, encode('{"nested":{"values":[1,1e400]}}\n')),
  );
  expect(error.code).toBe('invalid_record');
  expect(error.anchor).toEqual(anchor(1));
});

test('evidence errors do not disclose invalid raw content', () => {
  const secret = 'secret-observer-content';
  const error = evidenceError(() =>
    parseCompleteJsonl(source, encode(`{"value":"${secret}"} trailing\n`)),
  );
  expect(error.message).not.toContain(secret);
  expect(error.anchor).toEqual(anchor(1));
});

test('canonical JSON compares every nested value while ignoring object key order', () => {
  const left = { z: [{ b: 2, a: 'same' }], a: true };
  const reordered = { a: true, z: [{ a: 'same', b: 2 }] };
  expect(canonicalJson(left)).toBe(canonicalJson(reordered));
  expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
  expect(canonicalJson({ text: 'one' })).not.toBe(
    canonicalJson({ text: 'two' }),
  );
  expect(canonicalJson({ nested: { keep: null, number: 1 } })).toBe(
    '{"nested":{"keep":null,"number":1}}',
  );
});

test('prefix verification permits append; suffix policy does not', () => {
  const prefixBytes = encode('{"text":"é"}\r\n');
  const prefix = createRawPrefix(source, prefixBytes);
  expect(() => verifyRawPrefix(source, raw, prefix)).not.toThrow();
  expect(() => verifyReviewedSuffix(source, raw, prefix)).toThrow(
    ObserverEvidenceError,
  );
  expect(() => verifyReviewedSuffix(source, prefixBytes, prefix)).not.toThrow();
});

test('reviewed suffix rejects even a valid familiar telemetry row', () => {
  const prefixBytes = encode('{"type":"message"}\n');
  const full = encode('{"type":"message"}\n{"type":"event_msg"}\n');
  const error = evidenceError(() =>
    verifyReviewedSuffix(source, full, createRawPrefix(source, prefixBytes)),
  );
  expect(error.code).toBe('unreviewed_suffix');
});

test('prefix verification rejects changed claims and changed early bytes', () => {
  const prefixBytes = encode('{"text":"é"}\r\n');
  const prefix = createRawPrefix(source, prefixBytes);
  const mutations: Array<[string, RawSource, Uint8Array, RawPrefix]> = [
    ['source id', source, raw, { ...prefix, source_id: 'other' }],
    ['digest', source, raw, { ...prefix, sha256: '0'.repeat(64) }],
    ['invalid digest', source, raw, { ...prefix, sha256: 'A'.repeat(64) }],
    ['byte count', source, raw, { ...prefix, bytes: prefix.bytes + 1 }],
    ['line count', source, raw, { ...prefix, after_line: 2 }],
    ['source argument', { ...source, source_id: 'other' }, raw, prefix],
    [
      'truncation',
      source,
      prefixBytes.subarray(0, prefixBytes.length - 1),
      prefix,
    ],
    [
      'changed early bytes',
      source,
      encode('{"text":"aa"}\r\n{"text":"second"}\n'),
      prefix,
    ],
  ];
  for (const [_name, candidateSource, bytes, candidate] of mutations) {
    const error = evidenceError(() =>
      verifyRawPrefix(candidateSource, bytes, candidate),
    );
    expect(error.code).toBe('prefix_mismatch');
  }
});

test('prefix ending inside a multibyte character rejects', () => {
  const bytes = encode('{"text":"é"}\n');
  const insideCharacter = encode('{"text":"').length + 1;
  const partial = bytes.subarray(0, insideCharacter);
  const claimed = {
    source_id: 'main',
    bytes: insideCharacter,
    sha256: createHash('sha256').update(partial).digest('hex'),
    after_line: 0,
  };
  const error = evidenceError(() => verifyRawPrefix(source, bytes, claimed));
  expect(error.code).toBe('prefix_mismatch');
});

test('source, anchor, prefix, and identity schemas are strict and bounded', () => {
  expect(() => RawSourceSchema.parse({ ...source, extra: true })).toThrow();
  expect(() => RawSourceSchema.parse({ ...source, source_id: '' })).toThrow();
  expect(() =>
    SourceIdentitySchema.parse({
      session_id: '',
      cwd: null,
      cli_version: null,
      conversation: 'unresolved',
      evidence: [],
    }),
  ).toThrow();
  expect(() => RawAnchorSchema.parse(anchor(0))).toThrow();
  expect(() =>
    RawAnchorSchema.parse(anchor(Number.MAX_SAFE_INTEGER + 1)),
  ).toThrow();
  expect(() => RawAnchorSchema.parse(anchor(1, -1))).toThrow();
  expect(() =>
    RawAnchorSchema.parse(anchor(1, Number.MAX_SAFE_INTEGER + 1)),
  ).toThrow();

  const validPrefix = {
    source_id: 'main',
    bytes: 0,
    sha256: 'a'.repeat(64),
    after_line: 0,
  };
  for (const invalidPrefix of [
    { ...validPrefix, bytes: -1 },
    { ...validPrefix, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...validPrefix, sha256: 'A'.repeat(64) },
    { ...validPrefix, after_line: -1 },
    { ...validPrefix, after_line: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(() => RawPrefixSchema.parse(invalidPrefix)).toThrow();
  }
  expect(() =>
    RawPrefixSchema.parse({
      source_id: 'main',
      bytes: 0,
      sha256: 'a'.repeat(64),
      after_line: 0,
      extra: true,
    }),
  ).toThrow();
});

test('raw index accepts direct multi-block replay aliases', () => {
  const index = validIndex();
  index.identity = {
    session_id: null,
    cwd: null,
    cli_version: null,
    conversation: 'unresolved',
    evidence: [],
  };
  index.prefix.after_line = 2;
  index.entries = [
    {
      kind: 'message',
      anchor: anchor(1, 0),
      role: 'user',
      text: 'Please review this.',
      message_id: 'message-1',
      claimed_origin: 'unclaimed',
      approval_eligibility: 'unresolved',
    },
    {
      kind: 'call',
      anchor: anchor(1, 1),
      call_id: 'call-1',
      native_call_id: 'native-1',
      name: 'Read',
      payload: { path: '/fixture/spec.md' },
    },
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
  ];
  expect(RawIndexSchema.parse(index)).toEqual(index);
});

test('raw index rejects unknown fields and non-JSON payload values', () => {
  const index = validIndex();
  expect(() =>
    RawIndexSchema.parse({ ...index, unexpected: 'field' }),
  ).toThrow();
  expect(() =>
    RawIndexSchema.parse({
      ...index,
      entries: [
        {
          ...index.entries[0],
          unexpected: 'field',
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    RawIndexSchema.parse({
      ...index,
      entries: [
        {
          kind: 'call',
          anchor: anchor(2),
          call_id: 'call',
          native_call_id: null,
          name: 'exec',
          payload: { nested: [Number.POSITIVE_INFINITY] },
        },
      ],
    }),
  ).toThrow();
});

test('raw index rejects duplicate and out-of-order entry anchors', () => {
  const duplicate = validIndex();
  duplicate.entries[1] = {
    ...duplicate.entries[1]!,
    anchor: anchor(2, 0),
  };
  expect(() => RawIndexSchema.parse(duplicate)).toThrow();

  const outOfOrder = validIndex();
  outOfOrder.entries = [outOfOrder.entries[1]!, outOfOrder.entries[0]!];
  expect(() => RawIndexSchema.parse(outOfOrder)).toThrow();
});

test('raw index rejects anchors outside its source and prefix', () => {
  for (const mutate of [
    (index: RawIndex) => {
      index.prefix.source_id = 'other';
    },
    (index: RawIndex) => {
      index.identity.evidence = [{ ...anchor(1), source_id: 'other' }];
    },
    (index: RawIndex) => {
      index.entries[0]!.anchor.source_id = 'other';
    },
    (index: RawIndex) => {
      index.entries[0]!.anchor.line = index.prefix.after_line + 1;
    },
  ]) {
    const index = validIndex();
    mutate(index);
    expect(() => RawIndexSchema.parse(index)).toThrow();
  }
});

test('raw index rejects replay aliases without earlier canonical non-replay targets', () => {
  const missing = validIndex();
  missing.entries[3] = {
    kind: 'replay',
    anchor: anchor(4, 0),
    canonical_anchor: anchor(1, 0),
  };
  expect(() => RawIndexSchema.parse(missing)).toThrow();

  const forward = validIndex();
  forward.entries[3] = {
    kind: 'replay',
    anchor: anchor(4, 0),
    canonical_anchor: anchor(4, 1),
  };
  expect(() => RawIndexSchema.parse(forward)).toThrow();

  const aliasToAlias = validIndex();
  aliasToAlias.prefix.after_line = 5;
  aliasToAlias.entries.push({
    kind: 'replay',
    anchor: anchor(5, 0),
    canonical_anchor: anchor(4, 0),
  });
  expect(() => RawIndexSchema.parse(aliasToAlias)).toThrow();
});

test('raw index rejects result links that do not identify an earlier matching call', () => {
  for (const callAnchor of [anchor(1, 0), anchor(2, 1), anchor(4, 1)]) {
    const index = validIndex();
    index.entries[2] = {
      kind: 'result',
      anchor: anchor(3, 0),
      call_id: 'call-1',
      call_anchor: callAnchor,
      payload: null,
    };
    expect(() => RawIndexSchema.parse(index)).toThrow();
  }

  const mismatchedId = validIndex();
  mismatchedId.entries[2] = {
    kind: 'result',
    anchor: anchor(3, 0),
    call_id: 'different-call',
    call_anchor: anchor(2, 0),
    payload: null,
  };
  expect(() => RawIndexSchema.parse(mismatchedId)).toThrow();
});

test('raw index rejects assistant messages eligible for approval', () => {
  const index = validIndex();
  index.entries[1] = {
    kind: 'message',
    anchor: anchor(2, 1),
    role: 'assistant',
    text: 'I approve.',
    message_id: null,
    claimed_origin: 'internal',
    approval_eligibility: 'eligible',
  };
  expect(() => RawIndexSchema.parse(index)).toThrow();
});
