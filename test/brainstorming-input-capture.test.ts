import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureInput,
  guardedInputCapture,
  installInputCapture,
  observerCommand,
  publishInputCapture,
  readInputObservation,
  runObserverCommand,
} from '../src/experiments/brainstorming-input-capture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(campaign = false) {
  const attempt = realpathSync(mkdtempSync(join(tmpdir(), 'input-capture-')));
  dirs.push(attempt);
  const dir = campaign ? join(attempt, 'staging', 'run') : attempt;
  const workdir = join(dir, 'coding-agent-workdir');
  const home = join(campaign ? attempt : dir, 'home');
  const logs = join(home, '.codex', 'sessions');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(workdir, 'README.md'), 'Empty app fixture');
  const evidence = join(dir, 'brainstorming-evidence');
  mkdirSync(evidence);
  const binding = {
    schema_version: 2 as const,
    run_id: 'local-test',
    campaign: null,
    runtime: 'codex' as const,
    dialect: 'codex-response-items-0.144.3',
    cli_version: '0.144.3',
    home,
    workdir,
    launch_cwd: workdir,
    roots: [
      { id: 'transcripts', kind: 'transcripts' as const, path: logs },
      { id: 'artifacts', kind: 'artifacts' as const, path: workdir },
    ],
    phase: 'unbound' as const,
    parent_source_id: null,
    sources: [],
  };
  installInputCapture(binding);
  const log = join(logs, 'main.jsonl');
  const spec = join(workdir, 'spec.md');
  const raw = `${JSON.stringify({ type: 'session_meta', payload: { id: 'parent', cwd: workdir, cli_version: '0.144.3', originator: 'codex-tui', thread_source: 'user', source: 'cli' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Please review spec.md.' }] } })}\n`;
  return { dir, workdir, logs, evidence, log, spec, raw };
}

test.each([
  false,
  true,
])('installed guard follows the selected subject home and fails closed after log loss (campaign=%s)', (campaign) => {
  const f = fixture(campaign);
  const guard = join(f.dir, 'gauntlet-agent', 'tui-input-guard');
  const invoke = () =>
    spawnSync(guard, [], {
      input: '{"name":"type","args":{"text":"yes"}}\n',
      encoding: 'utf8',
    });
  expect(invoke().status).toBe(0);
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  expect(invoke().status).toBe(0);
  rmSync(f.log);
  expect(invoke().status).not.toBe(0);
});

test('missing-log startup blocks non-Markdown product work', () => {
  const f = fixture();
  writeFileSync(
    join(f.workdir, 'package.json'),
    '{"scripts":{"start":"vite"}}',
  );
  expect(() => captureInput(f.workdir)).toThrow();
  expect(readdirSync(f.evidence)).toEqual([]);
});

test('captures actual bytes with a fresh transcript boundary for each revision and observation', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  const first = captureInput(f.workdir);
  appendFileSync(
    f.log,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } })}\n`,
  );
  const second = captureInput(f.workdir);
  writeFileSync(f.spec, 'Learning React state and events');
  const third = captureInput(f.workdir);
  const receipts = [first, second, third].map((result) => {
    const receipt = result.receipts.find((r) => r.artifact_path === 'spec.md')!;
    return JSON.parse(
      readFileSync(join(f.evidence, `${receipt.name}.json`), 'utf8'),
    );
  });
  expect(
    receipts.map((r) => Buffer.from(r.content_base64, 'base64').toString()),
  ).toEqual([
    'Learning React',
    'Learning React',
    'Learning React state and events',
  ]);
  expect(receipts.map((r) => r.source_prefix.after_line)).toEqual([2, 3, 3]);
  expect(new Set(receipts.map((r) => r.observation_id)).size).toBe(3);
});

test('unproven same-cwd review subagents and two parent sessions fail closed', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  writeFileSync(
    join(f.logs, 'child.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'parent', cwd: f.workdir, cli_version: '0.144.3', originator: 'codex-tui', thread_source: 'user', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } })}\n`,
  );
  expect(() => captureInput(f.workdir)).toThrow();
  rmSync(join(f.logs, 'child.jsonl'));
  writeFileSync(join(f.logs, 'second.jsonl'), f.raw);
  expect(() => captureInput(f.workdir)).toThrow();
});

test('incomplete JSONL and changed artifacts without a log cannot produce receipts', () => {
  const f = fixture();
  writeFileSync(f.spec, 'Learning React');
  expect(() => captureInput(f.workdir)).toThrow();
  writeFileSync(f.log, `${f.raw}{`);
  expect(() => captureInput(f.workdir)).toThrow('JSONL');
  expect(readdirSync(f.evidence)).toEqual([]);
});

test('document symlinks fail closed instead of silently omitting the presented file', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  const outside = join(f.dir, 'outside.md');
  writeFileSync(outside, 'private');
  symlinkSync(outside, f.spec);
  expect(() => captureInput(f.workdir)).toThrow();
});

test('non-regular files fail promptly instead of blocking the capture reader', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  // Reading this FIFO would hang until a writer connects.
  const fifo = join(f.workdir, 'pending.md');
  expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
  expect(() => captureInput(f.workdir)).toThrow();
  expect(readdirSync(f.evidence)).toEqual([]);
});

for (const change of ['rewrite', 'append', 'add', 'delete'] as const) {
  test(`a ${change} between observations publishes no receipts`, () => {
    const f = fixture();
    writeFileSync(f.log, f.raw);
    writeFileSync(f.spec, 'Learning React');
    const before = readInputObservation(f.workdir);
    if (change === 'rewrite') writeFileSync(f.spec, 'Different purpose');
    if (change === 'append')
      appendFileSync(
        f.log,
        `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } })}\n`,
      );
    if (change === 'add') writeFileSync(join(f.workdir, 'plan.md'), 'New plan');
    if (change === 'delete') rmSync(f.spec);
    const after = readInputObservation(f.workdir);
    expect(() => publishInputCapture(f.workdir, before, after)).toThrow(
      'changed during observation',
    );
    expect(readdirSync(f.evidence)).toEqual([]);
  });
}

test('guard refuses a shared-shell artifact edit and reply injection before execution', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  const result = spawnSync(
    join(f.dir, 'gauntlet-agent', 'tui-input-guard'),
    [],
    {
      input: JSON.stringify({
        name: 'bash',
        args: { command: `echo forged > ${f.spec}; tmux send-keys yes Enter` },
      }),
      encoding: 'utf8',
    },
  );
  expect(result.status).toBe(127);
  expect(readdirSync(f.evidence)).toEqual([]);
});

for (const route of ['type', 'press', 'type_and_submit', 'bash']) {
  test(`installed ${route} route captures before a fake tool effect and blocks unstable input`, () => {
    const f = fixture();
    writeFileSync(f.log, f.raw);
    writeFileSync(f.spec, Buffer.from([0x66, 0xff, 0x00]));
    const guard = join(f.dir, 'gauntlet-agent/tui-input-guard');
    const args =
      route === 'bash'
        ? { command: observerCommand(f.workdir, 'observer-index') }
        : route === 'press'
          ? { key: 'Enter' }
          : { text: 'arbitrary response' };
    const invoke = () =>
      spawnSync(guard, [], {
        input: JSON.stringify({ name: route, args }),
        encoding: 'utf8',
      });
    const captured = invoke();
    expect(captured.status).toBe(0);
    const result = JSON.parse(captured.stdout);
    const receipt = JSON.parse(
      readFileSync(
        join(
          f.evidence,
          `${
            result.receipts.find(
              (r: { artifact_path: string }) => r.artifact_path === 'spec.md',
            ).name
          }.json`,
        ),
        'utf8',
      ),
    );
    expect(Buffer.from(receipt.content_base64, 'base64')).toEqual(
      Buffer.from([0x66, 0xff, 0x00]),
    );
    appendFileSync(f.log, '{');
    expect(invoke().status).toBe(127);
    // A fake downstream effect occurs only after a successful guard, as in Gauntlet dispatch.
    expect(result.receipts.length).toBeGreaterThan(0);
  });
}
test('cancellation remains usable when evidence is unavailable', () => {
  const f = fixture();
  writeFileSync(f.log, '{');
  for (const key of ['Escape', 'Ctrl+C'])
    expect(
      spawnSync(join(f.dir, 'gauntlet-agent/tui-input-guard'), [], {
        input: JSON.stringify({ name: 'press', args: { key } }),
      }).status,
    ).toBe(0);
});
test('private observer commands read/index and write review bytes without home access or overwrite', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  captureInput(f.workdir);
  const wd = Buffer.from(f.workdir).toString('base64');
  const encode = (value: string) => Buffer.from(value).toString('base64');
  const indexed = runObserverCommand('observer-index', wd) as {
    content_base64: string;
  };
  expect(
    JSON.parse(Buffer.from(indexed.content_base64, 'base64').toString()),
  ).toMatchObject({ schema_version: 2 });
  expect(runObserverCommand('observer-read', wd, encode(f.spec))).toMatchObject(
    { content_base64: encode('Learning React') },
  );
  expect(() =>
    runObserverCommand('observer-read', wd, encode(f.log)),
  ).toThrow();
  expect(() =>
    runObserverCommand('observer-write-review', wd, encode('{')),
  ).toThrow();
  expect(() =>
    runObserverCommand(
      'observer-write-review',
      wd,
      encode('{"schema_version":2}'),
    ),
  ).toThrow();
  const review = JSON.stringify({
    schema_version: 2,
    reviewer: 'fixture',
    stop_reason: 'endpoint',
    supporting_prefixes: [],
    source_prefixes: [],
    events: [],
    actions: [],
  });
  runObserverCommand('observer-write-review', wd, encode(review));
  expect(readFileSync(join(f.evidence, 'review.json'), 'utf8')).toBe(review);
  expect(() =>
    runObserverCommand('observer-write-review', wd, encode(review)),
  ).toThrow();
});
test('source EACCES refuses capture without receipts', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  chmodSync(f.log, 0);
  try {
    expect(() => captureInput(f.workdir)).toThrow();
    expect(readdirSync(f.evidence)).toEqual([]);
  } finally {
    chmodSync(f.log, 0o600);
  }
});

test('receipt discovery exposes authenticated IDs and paths in bounded pages', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  const captured = captureInput(f.workdir);
  const wd = Buffer.from(f.workdir).toString('base64');
  const result = runObserverCommand('observer-receipts', wd) as {
    receipts: { path: string; observation_id: string; artifact_path: string }[];
    next_cursor: string | null;
  };
  const expected = captured.receipts.find(
    (receipt) => receipt.artifact_path === 'spec.md',
  )!;
  expect(
    result.receipts.find(
      (receipt) => receipt.observation_id === expected.observation_id,
    )?.path,
  ).toBe(join(f.evidence, `${expected.name}.json`));
  expect(result.next_cursor).toBeNull();
  for (let i = 0; i < 9; i++) captureInput(f.workdir);
  const first = runObserverCommand('observer-receipts', wd) as typeof result;
  expect(first.receipts).toHaveLength(16);
  expect(first.next_cursor).not.toBeNull();
  const second = runObserverCommand(
    'observer-receipts',
    wd,
    first.next_cursor!,
  ) as typeof result;
  expect(second.receipts).toHaveLength(4);
  expect(second.next_cursor).toBeNull();
  expect(
    new Set(
      [...first.receipts, ...second.receipts].map(
        (receipt) => receipt.observation_id,
      ),
    ).size,
  ).toBe(20);
  expect(() =>
    runObserverCommand(
      'observer-receipts',
      wd,
      Buffer.from('../home').toString('base64'),
    ),
  ).toThrow();
  mkdirSync(join(f.evidence, 'bundle'));
  writeFileSync(join(f.evidence, 'bundle', 'capture-unowned.json'), 'invalid');
  expect(
    (runObserverCommand('observer-receipts', wd) as typeof result).receipts,
  ).toHaveLength(16);
});
for (const mutation of ['bytes', 'prefix', 'id', 'symlink'])
  test(`receipt discovery and reading reject ${mutation} tampering`, () => {
    const f = fixture();
    writeFileSync(f.log, f.raw);
    const captured = captureInput(f.workdir);
    const path = join(f.evidence, `${captured.receipts[0]!.name}.json`);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (mutation === 'bytes')
      receipt.content_base64 = Buffer.from('forged').toString('base64');
    if (mutation === 'prefix') receipt.source_prefix.sha256 = '0'.repeat(64);
    if (mutation === 'id') receipt.observation_id = 'conflicting-id';
    if (mutation === 'symlink') {
      rmSync(path);
      symlinkSync(f.log, path);
    } else writeFileSync(path, JSON.stringify(receipt));
    const wd = Buffer.from(f.workdir).toString('base64');
    expect(() => runObserverCommand('observer-receipts', wd)).toThrow();
    expect(() =>
      runObserverCommand(
        'observer-read',
        wd,
        Buffer.from(path).toString('base64'),
      ),
    ).toThrow();
  });

test('deep legal artifact paths paginate below the transport byte cap without loss', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  // Control characters are legal filesystem path bytes and expand to six JSON bytes.
  const component = '\u0001'.repeat(160);
  const deep = join(f.workdir, component, component, component, component);
  mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 17; i++)
    writeFileSync(join(deep, `${'\u0001'.repeat(120)}-${i}.md`), 'artifact');
  const captured = captureInput(f.workdir);
  const wd = Buffer.from(f.workdir).toString('base64');
  type Page = {
    receipts: { observation_id: string; path: string }[];
    next_cursor: string | null;
  };
  const first = runObserverCommand('observer-receipts', wd) as Page;
  expect(Buffer.byteLength(`${JSON.stringify(first)}\n`)).toBeLessThanOrEqual(
    32 * 1024,
  );
  expect(first.receipts.length).toBeGreaterThan(0);
  expect(first.receipts.length).toBeLessThan(16);
  expect(runObserverCommand('observer-receipts', wd)).toEqual(first);
  const ids: string[] = [];
  let page = first;
  let calls = 0;
  for (;;) {
    expect(Buffer.byteLength(`${JSON.stringify(page)}\n`)).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(page.receipts.length).toBeGreaterThan(0);
    ids.push(...page.receipts.map((receipt) => receipt.observation_id));
    calls++;
    if (page.next_cursor === null) break;
    expect(calls).toBeLessThan(captured.receipts.length);
    page = runObserverCommand(
      'observer-receipts',
      wd,
      page.next_cursor,
    ) as Page;
  }
  expect(ids.sort()).toEqual(
    captured.receipts.map((receipt) => receipt.observation_id).sort(),
  );
  expect(new Set(ids).size).toBe(captured.receipts.length);
});
test('one schema-valid oversized receipt refuses instead of truncating or skipping it', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  const captured = captureInput(f.workdir);
  const path = join(f.evidence, `${captured.receipts[0]!.name}.json`);
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  receipt.artifact_path = '\u0001'.repeat(6000);
  writeFileSync(path, JSON.stringify(receipt));
  expect(() =>
    runObserverCommand(
      'observer-receipts',
      Buffer.from(f.workdir).toString('base64'),
    ),
  ).toThrow('exceeds the receipt page byte limit');
});

interface EvidencePage {
  offset: number;
  bytes: number;
  sha256: string;
  content_base64: string;
  content_utf8: string | null;
  next_cursor: string | null;
}
const encodeObserver = (value: string) => Buffer.from(value).toString('base64');

test.each([
  'leading',
  'continuation',
] as const)('readable pages preserve a %s BOM code point byte-for-byte', (position) => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'a'.repeat(50000));
  captureInput(f.workdir);
  const read = (cursor?: string) =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(f.spec),
      cursor,
    ) as EvidencePage;
  const probe = read();
  const boundary = Buffer.from(probe.content_base64, 'base64').length;
  const original = Buffer.from(
    `${position === 'continuation' ? 'a'.repeat(boundary) : ''}\uFEFF${'b'.repeat(50000)}`,
  );
  writeFileSync(f.spec, original);
  const expectedDigest = createHash('sha256').update(original).digest('hex');
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  do {
    const page = read(cursor);
    const readable = Buffer.from(page.content_utf8!);
    expect(readable).toEqual(Buffer.from(page.content_base64, 'base64'));
    expect(page.offset).toBe(Buffer.concat(chunks).length);
    expect(page.bytes).toBe(original.length);
    expect(page.sha256).toBe(expectedDigest);
    chunks.push(readable);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  const restored = Buffer.concat(chunks);
  expect(restored).toEqual(original);
  expect(createHash('sha256').update(restored).digest('hex')).toBe(
    expectedDigest,
  );
});

test('bounded index and document pages preserve oversized physical payloads and exact bytes', () => {
  const f = fixture();
  const payload = 'α漢🙂'.repeat(12000);
  const document = Buffer.from(`Learning React\n${payload}`);
  writeFileSync(
    f.log,
    f.raw +
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'large-call',
          name: 'functions.exec',
          arguments: JSON.stringify({ command: payload }),
        },
      }) +
      '\n',
  );
  writeFileSync(f.spec, document);
  const captured = captureInput(f.workdir);
  const receipt = captured.receipts.find(
    (receipt) => receipt.artifact_path === 'spec.md',
  )!;
  const receiptPath = join(f.evidence, `${receipt.name}.json`);
  for (const path of [undefined, f.spec, receiptPath]) {
    const operation = path ? 'observer-read' : 'observer-index';
    let cursor: string | undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    let digest = '';
    do {
      const page = runObserverCommand(
        operation,
        encodeObserver(f.workdir),
        path ? encodeObserver(path) : cursor,
        path ? cursor : undefined,
      ) as EvidencePage;
      expect(
        Buffer.byteLength(`${JSON.stringify(page)}\n`),
      ).toBeLessThanOrEqual(32 * 1024);
      expect(page.offset).toBe(total);
      const chunk = Buffer.from(page.content_base64, 'base64');
      expect(Buffer.from(page.content_utf8!)).toEqual(chunk);
      expect(chunk.length).toBeGreaterThan(0);
      chunks.push(chunk);
      total += chunk.length;
      digest = page.sha256;
      cursor = page.next_cursor ?? undefined;
      if (!cursor) expect(total).toBe(page.bytes);
      expect(chunks.length).toBeLessThan(100);
    } while (cursor);
    expect(chunks.length).toBeGreaterThan(1);
    const bytes = Buffer.concat(chunks);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    if (path) expect(bytes).toEqual(readFileSync(path));
    else
      expect(
        JSON.parse(bytes.toString()).entries.find(
          (entry: { kind: string }) => entry.kind === 'call',
        ).payload.arguments,
      ).toBe(JSON.stringify({ command: payload }));
  }
});

test('index continuation authenticates the original prefix across later append and rejects rewritten sources', () => {
  const f = fixture();
  const text = 'review '.repeat(16000);
  writeFileSync(
    f.log,
    f.raw +
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      }) +
      '\n',
  );
  captureInput(f.workdir);
  const first = runObserverCommand(
    'observer-index',
    encodeObserver(f.workdir),
  ) as EvidencePage;
  expect(first.next_cursor).toBeString();
  appendFileSync(
    f.log,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'later suffix' }],
      },
    })}\n`,
  );
  const second = runObserverCommand(
    'observer-index',
    encodeObserver(f.workdir),
    first.next_cursor!,
  ) as EvidencePage;
  expect(second.sha256).toBe(first.sha256);
  expect(second.bytes).toBe(first.bytes);
  writeFileSync(
    f.log,
    readFileSync(f.log, 'utf8').replace('review ', 'REVIEW '),
  );
  expect(() =>
    runObserverCommand(
      'observer-index',
      encodeObserver(f.workdir),
      first.next_cursor!,
    ),
  ).toThrow();
});

test('read continuation rejects changed bytes, another path, and forged cursor digest', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Large document '.repeat(6000));
  captureInput(f.workdir);
  const first = runObserverCommand(
    'observer-read',
    encodeObserver(f.workdir),
    encodeObserver(f.spec),
  ) as EvidencePage;
  expect(first.next_cursor).toBeString();
  const other = join(f.workdir, 'other.md');
  writeFileSync(other, readFileSync(f.spec));
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(other),
      first.next_cursor!,
    ),
  ).toThrow();
  const forged = JSON.parse(
    Buffer.from(first.next_cursor!, 'base64').toString(),
  );
  forged.content_sha256 = '0'.repeat(64);
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(f.spec),
      encodeObserver(JSON.stringify(forged)),
    ),
  ).toThrow();
  writeFileSync(f.spec, 'Different document '.repeat(6000));
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(f.spec),
      first.next_cursor!,
    ),
  ).toThrow();
});

test('continuation guard permits only exact command arity without shell composition', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Spec');
  const encoded = encodeObserver(f.spec);
  const read = observerCommand(f.workdir, 'observer-read', encoded, encoded);
  const index = observerCommand(f.workdir, 'observer-index', encoded);
  const saved = observerCommand(
    f.workdir,
    'observer-read',
    encoded,
    encoded,
    'receipt-content',
  );
  for (const command of [read, index, saved]) {
    expect(() =>
      guardedInputCapture(f.workdir, { name: 'bash', args: { command } }),
    ).not.toThrow();
    for (const suffix of [` '${encoded}'`, '; true', '\ntrue'])
      expect(() =>
        guardedInputCapture(f.workdir, {
          name: 'bash',
          args: { command: command + suffix },
        }),
      ).toThrow();
  }
});

test('readable pages bound escaped control text and preserve the saved receipt revision', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  const saved = `saved revision 漢🙂\n${'\u0001'.repeat(70000)}`;
  writeFileSync(f.spec, saved);
  const captured = captureInput(f.workdir);
  const receipt = captured.receipts.find(
    (receipt) => receipt.artifact_path === 'spec.md',
  )!;
  const receiptPath = join(f.evidence, `${receipt.name}.json`);
  const rawPage = runObserverCommand(
    'observer-read',
    encodeObserver(f.workdir),
    encodeObserver(receiptPath),
  ) as EvidencePage;
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(receiptPath),
      rawPage.next_cursor!,
      'receipt-content',
    ),
  ).toThrow();
  const savedPage = runObserverCommand(
    'observer-read',
    encodeObserver(f.workdir),
    encodeObserver(receiptPath),
    undefined,
    'receipt-content',
  ) as EvidencePage;
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(receiptPath),
      savedPage.next_cursor!,
    ),
  ).toThrow();
  writeFileSync(f.spec, 'a later revision');
  let cursor: string | undefined;
  let restored = '';
  do {
    const page = runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(receiptPath),
      cursor,
      'receipt-content',
    ) as EvidencePage;
    expect(page.content_utf8).toBeString();
    expect(Buffer.byteLength(`${JSON.stringify(page)}\n`)).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(page.offset).toBe(Buffer.byteLength(restored));
    restored += page.content_utf8;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(restored).toBe(saved);
  const changedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  changedReceipt.artifact_path = 'other.md';
  writeFileSync(receiptPath, JSON.stringify(changedReceipt));
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(receiptPath),
      savedPage.next_cursor!,
      'receipt-content',
    ),
  ).toThrow();
  expect(() =>
    runObserverCommand(
      'observer-read',
      encodeObserver(f.workdir),
      encodeObserver(f.spec),
      undefined,
      'receipt-content',
    ),
  ).toThrow();
});
