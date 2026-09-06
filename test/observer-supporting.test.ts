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
function captureFixture(dialect: 'text' | 'patch-completed' = 'text') {
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
      join(
        import.meta.dir,
        `fixtures/observer/codex-0.146.0-trace-${dialect}.json`,
      ),
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
  writeFileSync(
    join(sessions, 'parent.jsonl'),
    dialect === 'text'
      ? raw
      : captured.ordinary.replaceAll('/capture/codex-parent/workdir', workdir),
  );
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

test.each([
  'empty',
  'missing-payload',
  'truncated-trace',
])('receipt consumers reject %s historical supporting evidence even when final evidence is complete', (mutation) => {
  const f = captureFixture('patch-completed');
  const receiptRef = captureInput(f.workdir).receipts[0]!;
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
  const livePath = join(evidence, `${receiptRef.name}.json`);
  const receipt = JSON.parse(readFileSync(livePath, 'utf8'));
  if (mutation === 'empty') receipt.supporting_prefixes = [];
  if (mutation === 'missing-payload')
    receipt.supporting_prefixes = receipt.supporting_prefixes.filter(
      (prefix: review.SupportingPrefix) =>
        !prefix.relative_path.endsWith('/payloads/8.json'),
    );
  if (mutation === 'truncated-trace') {
    const prefix = receipt.supporting_prefixes.find(
      (prefix: review.SupportingPrefix) =>
        prefix.relative_path.endsWith('/trace.jsonl'),
    );
    const bytes = readFileSync(join(f.trace, prefix.relative_path));
    const end = bytes.indexOf(10) + 1;
    prefix.bytes = end;
    prefix.sha256 = createHash('sha256')
      .update(bytes.subarray(0, end))
      .digest('hex');
  }
  const rewritten = Buffer.from(JSON.stringify(receipt));
  writeFileSync(livePath, rewritten);
  expect(() =>
    runObserverCommand(
      'observer-receipts',
      Buffer.from(f.workdir).toString('base64'),
    ),
  ).toThrow();
  const bundleDir = join(evidence, 'bundle');
  const path = bundle.receipts[0]!;
  writeFileSync(join(bundleDir, path), rewritten);
  const file = bundle.files.find((file) => file.path === path)!;
  file.bytes = rewritten.length;
  file.sha256 = createHash('sha256').update(rewritten).digest('hex');
  writeFileSync(
    join(bundleDir, 'observer-bundle.json'),
    JSON.stringify(bundle),
  );
  expect(() => readObserverBundle(bundleDir)).toThrow();
});

import { createRawPrefix } from '../src/experiments/observer/raw.ts';

test('a header-only historical observation remains valid without borrowing later trace support', () => {
  const f = captureFixture('patch-completed');
  const ref = captureInput(f.workdir).receipts[0]!;
  const path = join(f.dir, 'brainstorming-evidence', `${ref.name}.json`);
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const binding = validateObserverBinding(
    JSON.parse(
      readFileSync(join(f.dir, 'gauntlet-agent/observer-binding.json'), 'utf8'),
    ),
  );
  const main = readFileSync(join(binding.home, '.codex/sessions/parent.jsonl'));
  receipt.source_prefix = createRawPrefix(
    binding.sources[0]!.source,
    main.subarray(0, main.indexOf(10) + 1),
  );
  receipt.supporting_prefixes = [];
  writeFileSync(path, JSON.stringify(receipt));
  expect(() =>
    runObserverCommand(
      'observer-receipts',
      Buffer.from(f.workdir).toString('base64'),
    ),
  ).not.toThrow();
});

test('historical native receipt replays its closed trace prefix after later complete trace events and files arrive', () => {
  const f = captureFixture('patch-completed');
  const tracePath = join(f.trace, 'session/trace.jsonl');
  const completeTrace = readFileSync(tracePath, 'utf8');
  const rows = completeTrace.trimEnd().split('\n');
  const cutoff =
    rows.findIndex(
      (row) => JSON.parse(row).payload.type === 'tool_call_ended',
    ) + 1;
  expect(cutoff).toBeGreaterThan(0);
  writeFileSync(tracePath, `${rows.slice(0, cutoff).join('\n')}\n`);
  captureInput(f.workdir);
  const binding = validateObserverBinding(
    JSON.parse(
      readFileSync(join(f.dir, 'gauntlet-agent/observer-binding.json'), 'utf8'),
    ),
  );
  writeFileSync(tracePath, completeTrace);
  writeFileSync(
    join(f.trace, 'session/payloads/later.json'),
    '{"later_observation":true}',
  );
  const evidence = join(f.dir, 'brainstorming-evidence');
  expect(() => freezeObserverBundle(binding, evidence)).not.toThrow();
  expect(() => readObserverBundle(join(evidence, 'bundle'))).not.toThrow();
});

import { readInputObservation } from '../src/experiments/brainstorming-input-capture.ts';
import { indexBoundObserverSource } from '../src/experiments/observer/binding.ts';
import { scoreObserverEvidence } from '../src/experiments/observer/score.ts';

function nativeReceiptEvidence() {
  const f = captureFixture('patch-completed');
  const mainPath = join(f.dir, 'home/.codex/sessions/parent.jsonl');
  appendFileSync(
    mainPath,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] } })}\n`,
  );
  const ref = captureInput(f.workdir).receipts[0]!;
  const observation = readInputObservation(f.workdir);
  const source = observation.binding.sources[0]!.source;
  const raw = Buffer.from(observation.raw_base64, 'base64');
  const index = indexBoundObserverSource(
    observation.binding,
    source,
    raw,
    observation.supporting_files,
  );
  const receipt = review.validateArtifactReceipt(
    JSON.parse(
      readFileSync(
        join(f.dir, 'brainstorming-evidence', `${ref.name}.json`),
        'utf8',
      ),
    ),
  );
  const actor = review.validateActorReview({
    schema_version: 2,
    reviewer: 'actor',
    stop_reason: 'endpoint',
    events: [],
    source_prefixes: [index.prefix],
    supporting_prefixes: review.createSupportingPrefixes(
      observation.supporting_files,
    ),
    actions: index.entries
      .filter((entry) => entry.kind === 'call')
      .map((call) => ({
        anchor: call.anchor,
        call_id: call.call_id,
        effects: ['read_only'],
        result_anchors: index.entries
          .filter(
            (entry) =>
              entry.kind === 'result' && entry.call_id === call.call_id,
          )
          .map((entry) => entry.anchor),
        success: true,
        changed_artifacts: [],
        delegation: null,
        note: 'Classified for receipt authentication test.',
      })),
  });
  const args = {
    binding: observation.binding,
    raw_sources: [{ source_id: source.source_id, bytes: raw }],
    supporting_files: observation.supporting_files,
    review: actor,
    receipts: [receipt],
  };
  return { args, source, raw, receipt };
}

test('strict scorer independently refuses a receipt needing omitted historical patch support', () => {
  const { args, receipt } = nativeReceiptEvidence();
  expect(scoreObserverEvidence(args).evidence_errors).toEqual([]);
  const rejected = scoreObserverEvidence({
    ...args,
    receipts: [{ ...receipt, supporting_prefixes: [] }],
  });
  expect(rejected.evidence_errors.map((error) => error.code)).toContain(
    'orphan_result',
  );
});

import {
  assessIndependentReviews,
  IndependentReviewSchema,
} from '../src/experiments/observer/independent-review.ts';

test('independent cosmetic review cannot borrow final trace bytes for an incomplete after receipt', () => {
  const { args, source, raw, receipt } = nativeReceiptEvidence();
  const bytes = Buffer.from('Before the edit');
  const before = review.validateArtifactReceipt({
    ...receipt,
    observation_id: 'before',
    source_prefix: createRawPrefix(
      source,
      raw.subarray(0, raw.indexOf(10) + 1),
    ),
    supporting_prefixes: [],
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content_base64: bytes.toString('base64'),
  });
  const identity = {
    campaign_id: 'campaign',
    comparison_id: 'comparison',
    block_id: 'block',
    sample_id: 'sample',
    execution_attempt_id: 'attempt',
  };
  const evidence = {
    ...args,
    identity,
    input_digest: 'a'.repeat(64),
    manifest_digest: 'b'.repeat(64),
    bundle_digest: 'c'.repeat(64),
    actor_review: args.review,
    receipts: [before, receipt],
  };
  const independent = IndependentReviewSchema.parse({
    schema_version: 2,
    identity,
    input_digest: evidence.input_digest,
    manifest_digest: evidence.manifest_digest,
    bundle_digest: evidence.bundle_digest,
    reviewer: 'independent',
    reviewed_at: '2026-09-06T00:00:00Z',
    source_prefixes: args.review.source_prefixes,
    supporting_prefixes: args.review.supporting_prefixes,
    calls: args.review.actions.map((action) => ({
      anchor: action.anchor,
      call_id: action.call_id,
      result_anchors: action.result_anchors,
    })),
    judgments: args.review.actions.map((action) => ({
      anchor: action.anchor,
      event: 'call',
      assessment: 'agree',
      classification: 'cosmetic',
      before_receipt: 'before',
      after_receipt: receipt.observation_id,
      note: 'Review supplied observed before and after bytes.',
    })),
    strict_status: 'fail',
    disagreements: [],
  });
  expect(
    assessIndependentReviews(evidence, [independent]).reviews[0]!.valid,
  ).toBe(true);
  const rejected = assessIndependentReviews(
    {
      ...evidence,
      receipts: [before, { ...receipt, supporting_prefixes: [] }],
    },
    [independent],
  );
  expect(rejected.reviews[0]!.valid).toBe(false);
  expect(rejected.reviews[0]!.reasons).toContain(
    'Native patch result lacks an explicit parent call link.',
  );
});
