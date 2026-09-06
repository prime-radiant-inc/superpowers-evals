import { expect, test } from 'bun:test';
import * as review from '../src/experiments/observer/review.ts';

const member = (text: string, relative_path = 'session/raw.jsonl') => ({
  root_id: 'trace',
  relative_path,
  bytes: Buffer.from(text),
});

test('support prefixes authenticate historical bytes while allowing later appends and members', () => {
  expect(typeof review.createSupportingPrefixes).toBe('function');
  const prefixes = review.createSupportingPrefixes([member('before\n')]);
  expect(() =>
    review.verifySupportingPrefixes(
      [member('before\nafter\n'), member('payload', 'session/payloads/2.json')],
      prefixes,
      false,
    ),
  ).not.toThrow();
  expect(() =>
    review.verifySupportingPrefixes(
      [member('changed\nafter\n')],
      prefixes,
      false,
    ),
  ).toThrow();
  expect(() => review.verifySupportingPrefixes([], prefixes, false)).toThrow();
  expect(() =>
    review.verifySupportingPrefixes(
      [member('before\nafter\n')],
      prefixes,
      true,
    ),
  ).toThrow();
  expect(() =>
    review.verifySupportingPrefixes(
      [member('before\n'), member('new', 'session/payloads/2.json')],
      prefixes,
      true,
    ),
  ).toThrow();
});

test('support prefixes reject duplicate or unsafe member identities', () => {
  expect(typeof review.createSupportingPrefixes).toBe('function');
  expect(() =>
    review.createSupportingPrefixes([member('a'), member('b')]),
  ).toThrow();
  expect(() =>
    review.createSupportingPrefixes([member('a', '../outside')]),
  ).toThrow();
});

import { afterEach } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureInput,
  installInputCapture,
  runObserverCommand,
} from '../src/experiments/brainstorming-input-capture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function captureFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trace-support-')));
  dirs.push(dir);
  const home = join(dir, 'home'),
    workdir = join(dir, 'workdir'),
    sessions = join(home, '.codex/sessions'),
    trace = join(home, '.codex/rollout-traces');
  for (const path of [workdir, sessions, trace])
    mkdirSync(path, { recursive: true });
  installInputCapture({
    schema_version: 2,
    run_id: 'run',
    campaign: null,
    runtime: 'codex',
    dialect: 'codex-response-items-0.146.0',
    cli_version: '0.146.0',
    home,
    workdir,
    launch_cwd: workdir,
    roots: [
      { id: 'sessions', kind: 'transcripts', path: sessions },
      { id: 'artifacts', kind: 'artifacts', path: workdir },
      { id: 'trace', kind: 'tool_trace', path: trace },
    ],
    phase: 'unbound',
    parent_source_id: null,
    sources: [],
  });
  const captured = JSON.parse(
    readFileSync(
      join(import.meta.dir, 'fixtures/observer/codex-0.146.0-trace-text.json'),
      'utf8',
    ),
  );
  const session = JSON.parse(captured.manifest).root_thread_id;
  for (const [path, bytes] of Object.entries({
    'manifest.json': captured.manifest,
    'trace.jsonl': captured.trace,
    ...captured.payloads,
  })) {
    const target = join(trace, 'session', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      (bytes as string).replaceAll('/capture/codex-parent/workdir', workdir),
    );
  }
  const raw =
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: session,
        cwd: workdir,
        cli_version: '0.146.0',
        originator: 'codex-tui',
        thread_source: 'user',
        source: 'cli',
      },
    }) +
    '\n' +
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: `Please review spec.md. ${'a'.repeat(20000)}`,
          },
        ],
      },
    }) +
    '\n';
  writeFileSync(join(sessions, 'parent.jsonl'), raw);
  writeFileSync(join(workdir, 'spec.md'), 'spec');
  return { dir, workdir, trace };
}
test('input observations retain complete support prefixes and reject changed support pagination', () => {
  const f = captureFixture();
  const receipt = captureInput(f.workdir).receipts[0]!;
  const saved = JSON.parse(
    readFileSync(
      join(f.dir, 'brainstorming-evidence', `${receipt.name}.json`),
      'utf8',
    ),
  );
  expect(saved.supporting_prefixes.length).toBeGreaterThan(2);
  const encoded = Buffer.from(f.workdir).toString('base64');
  const first = runObserverCommand('observer-index', encoded) as {
    next_cursor: string;
  };
  expect(first.next_cursor).not.toBeNull();
  appendFileSync(join(f.trace, 'session/manifest.json'), ' ');
  expect(() =>
    runObserverCommand('observer-index', encoded, first.next_cursor),
  ).toThrow();
});

import { createHash } from 'node:crypto';
import {
  discoverObserverSources,
  validateObserverBinding,
} from '../src/experiments/observer/binding.ts';
import {
  freezeObserverBundle,
  indexObserverBundle,
  readObserverBundle,
} from '../src/experiments/observer/bundle.ts';

test('offline indexing exposes authenticated support prefixes after original homes disappear', () => {
  const f = captureFixture();
  captureInput(f.workdir);
  const binding = validateObserverBinding(
    JSON.parse(
      readFileSync(join(f.dir, 'gauntlet-agent/observer-binding.json'), 'utf8'),
    ),
  );
  const evidence = join(f.dir, 'brainstorming-evidence');
  const bundle = freezeObserverBundle(
    discoverObserverSources(binding),
    evidence,
  );
  rmSync(binding.home, { recursive: true });
  rmSync(binding.workdir, { recursive: true });
  const index = indexObserverBundle(join(evidence, 'bundle'));
  expect(index.supporting_prefixes.length).toBe(bundle.supporting_files.length);
  expect(index.sources[0]!.identity.session_id).toBe(
    binding.sources[0]!.source.expected_session_id,
  );
});

test('receipts refuse earlier trace-byte rewrites even if final member hashes are recomputed', () => {
  const f = captureFixture();
  captureInput(f.workdir);
  const binding = validateObserverBinding(
    JSON.parse(
      readFileSync(join(f.dir, 'gauntlet-agent/observer-binding.json'), 'utf8'),
    ),
  );
  const evidence = join(f.dir, 'brainstorming-evidence');
  const bundle = freezeObserverBundle(
    discoverObserverSources(binding),
    evidence,
  );
  const bundleDir = join(evidence, 'bundle');
  const ref = bundle.supporting_files.find((ref) =>
    ref.relative_path.endsWith('/manifest.json'),
  )!;
  const bytes = readFileSync(join(bundleDir, ref.path));
  bytes[0] = 32;
  writeFileSync(join(bundleDir, ref.path), bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  bundle.files.find((file) => file.path === ref.path)!.sha256 = hash;
  bundle.final_state.nodes.find(
    (node) => node.root_id === ref.root_id && node.path === ref.relative_path,
  )!.sha256 = hash;
  writeFileSync(
    join(bundleDir, 'observer-bundle.json'),
    JSON.stringify(bundle),
  );
  expect(() => readObserverBundle(bundleDir)).toThrow(
    'Supporting member prefix changed',
  );
});
