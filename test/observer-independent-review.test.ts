import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessIndependentReviews,
  type IndependentReview,
  type IndependentReviewEvidence,
  readReviewSet,
  writeIndependentReview,
  writeReviewSet,
} from '../src/experiments/observer/independent-review.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const at = (line: number) => ({ source_id: 'parent', line, block: null });
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'independent-review-'));
  dirs.push(dir);
  const source = {
    source_id: 'parent',
    runtime: 'codex' as const,
    expected_session_id: 'session',
    expected_cwd: '/fixture/workdir',
    expected_cli_version: '0.144.3',
  };
  const rows = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        cwd: source.expected_cwd,
        cli_version: '0.144.3',
        source: 'cli',
        originator: 'codex-tui',
        thread_source: 'user',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Build a todo app' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'edit',
        arguments: '{"cmd":"write"}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'edit',
        output: 'Process exited with code 0',
      },
    },
  ];
  const raw = Buffer.from(
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  const identity = {
    campaign_id: 'campaign',
    comparison_id: 'comparison',
    block_id: 'block',
    sample_id: 'sample',
    execution_attempt_id: 'attempt',
  };
  const evidence: IndependentReviewEvidence = {
    identity,
    input_digest: 'a'.repeat(64),
    manifest_digest: 'b'.repeat(64),
    bundle_digest: 'c'.repeat(64),
    binding: {
      schema_version: 2,
      run_id: 'run',
      campaign: identity,
      runtime: 'codex',
      dialect: 'codex-response-items-0.144.3',
      cli_version: '0.144.3',
      home: '/fixture/home',
      workdir: '/fixture/workdir',
      launch_cwd: '/fixture/workdir',
      roots: [
        {
          id: 'sessions',
          kind: 'transcripts',
          path: '/fixture/home/.codex/sessions',
        },
        { id: 'artifacts', kind: 'artifacts', path: '/fixture/workdir' },
      ],
      phase: 'finalized',
      parent_source_id: 'parent',
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
    },
    raw_sources: [{ source_id: 'parent', bytes: raw }],
    receipts: [],
    actor_review: {
      schema_version: 2,
      reviewer: 'actor',
      stop_reason: 'endpoint',
      source_prefixes: [createRawPrefix(source, raw)],
      events: [],
      actions: [
        {
          anchor: at(3),
          call_id: 'native:edit',
          effects: ['implementation'],
          result_anchors: [at(4)],
          success: true,
          changed_artifacts: [],
          delegation: null,
          note: 'Product code',
        },
      ],
    },
  };
  const review: IndependentReview = {
    schema_version: 2,
    identity,
    input_digest: evidence.input_digest,
    manifest_digest: evidence.manifest_digest,
    bundle_digest: evidence.bundle_digest,
    reviewer: 'independent-a',
    reviewed_at: '2026-09-05T00:00:00Z',
    source_prefixes: evidence.actor_review.source_prefixes,
    calls: [{ anchor: at(3), call_id: 'native:edit', result_anchors: [at(4)] }],
    judgments: [
      {
        anchor: at(3),
        event: 'call',
        assessment: 'agree',
        classification: null,
        before_receipt: null,
        after_receipt: null,
        note: 'Implementation before approval',
      },
    ],
    strict_status: 'fail',
    disagreements: [],
  };
  const save = (reviews = [review]) => {
    const refs = reviews.map((r, i) => {
      const path = `review-${i}.json`;
      const bytes = Buffer.from(JSON.stringify(r));
      writeFileSync(join(dir, path), bytes);
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    const path = join(dir, 'set.json');
    writeFileSync(path, JSON.stringify({ schema_version: 2, reviews: refs }));
    return path;
  };
  return { dir, evidence, review, save, raw, source };
}

test('authenticates explicit review members and retains reviewer identity', () => {
  const f = fixture();
  expect(readReviewSet(f.save())[0]?.reviewer).toBe('independent-a');
});
test('altered sidecar is rejected before its judgments can be consumed', () => {
  const f = fixture();
  const path = f.save();
  writeFileSync(join(f.dir, 'review-0.json'), '{}');
  expect(() => readReviewSet(path)).toThrow();
});
test('strict sidecar shape refuses unknown score overrides', () => {
  const f = fixture();
  const forged = { ...f.review, score_override: 'pass' };
  expect(() => readReviewSet(f.save([forged]))).toThrow();
});
test('review-set cannot traverse outside its root', () => {
  const f = fixture();
  const path = f.save();
  const set = JSON.parse(readFileSync(path, 'utf8'));
  set.reviews[0].path = '../escape';
  writeFileSync(path, JSON.stringify(set));
  expect(() => readReviewSet(path)).toThrow();
});
test('review-set rejects symlink members and parents', () => {
  const f = fixture();
  const path = f.save();
  const original = join(f.dir, 'review-0.json');
  const moved = join(f.dir, 'outside');
  writeFileSync(moved, readFileSync(original));
  rmSync(original);
  symlinkSync(moved, original);
  expect(() => readReviewSet(path)).toThrow();
  const link = join(f.dir, 'link');
  symlinkSync(f.dir, link);
  expect(() => readReviewSet(join(link, 'set.json'))).toThrow();
});
test('new review and set use exclusive creation without replacing old bytes', () => {
  const f = fixture();
  const reviewPath = join(f.dir, 'immutable.json');
  const ref = writeIndependentReview(reviewPath, f.review);
  expect(() =>
    writeIndependentReview(reviewPath, { ...f.review, reviewer: 'other' }),
  ).toThrow();
  expect(JSON.parse(readFileSync(reviewPath, 'utf8')).reviewer).toBe(
    'independent-a',
  );
  const setPath = join(f.dir, 'immutable-set.json');
  writeReviewSet(setPath, { schema_version: 2, reviews: [ref] });
  expect(() =>
    writeReviewSet(setPath, { schema_version: 2, reviews: [] }),
  ).toThrow();
  expect(readReviewSet(setPath)).toHaveLength(1);
});
test('complete independent evidence is ready without modifying actor review', () => {
  const f = fixture();
  const result = assessIndependentReviews(f.evidence, [f.review]);
  expect(result.reviews.map((record) => record.reasons)).toEqual([[]]);
  expect(result.ready).toBe(true);
  expect(result.reviews).toHaveLength(1);
  expect(f.evidence.actor_review.reviewer).toBe('actor');
});
test('missing review withholds interpretations', () => {
  const f = fixture();
  const result = assessIndependentReviews(f.evidence, []);
  expect(result.ready).toBe(false);
  expect(result.classifications).toEqual([]);
});
test.each([
  'identity',
  'input_digest',
  'manifest_digest',
  'bundle_digest',
] as const)('wrong %s cannot authenticate an attempt review', (field) => {
  const f = fixture();
  if (field === 'identity')
    f.review.identity = { ...f.review.identity, execution_attempt_id: 'wrong' };
  else f.review[field] = 'd'.repeat(64);
  expect(assessIndependentReviews(f.evidence, [f.review]).ready).toBe(false);
});
test.each([
  'missing call',
  'missing result',
  'duplicate call',
  'wrong anchor',
  'short prefix',
  'missing judgment',
])('incomplete coverage: %s', (damage) => {
  const f = fixture();
  if (damage === 'missing call') f.review.calls = [];
  if (damage === 'missing result') f.review.calls[0]!.result_anchors = [];
  if (damage === 'duplicate call') f.review.calls.push(f.review.calls[0]!);
  if (damage === 'wrong anchor') f.review.calls[0]!.anchor = at(2);
  if (damage === 'short prefix')
    f.review.source_prefixes = [
      createRawPrefix(
        f.source,
        Buffer.from(`${f.raw.toString().split('\n').slice(0, 2).join('\n')}\n`),
      ),
    ];
  if (damage === 'missing judgment') f.review.judgments = [];
  expect(assessIndependentReviews(f.evidence, [f.review]).ready).toBe(false);
});
test('same reviewer submissions remain explicit conflicts', () => {
  const f = fixture();
  const reviews = readReviewSet(f.save([f.review, f.review]));
  const result = assessIndependentReviews(f.evidence, reviews);
  expect(result.ready).toBe(false);
  expect(result.reviews).toHaveLength(2);
  expect(result.conflicts.length).toBeGreaterThan(0);
});
test('conflicting classifications cannot pick a winner', () => {
  const f = fixture();
  f.review.judgments[0]!.classification = 'substantive';
  const other = structuredClone(f.review);
  other.reviewer = 'independent-b';
  other.judgments[0]!.classification = 'unresolved';
  const result = assessIndependentReviews(f.evidence, [f.review, other]);
  expect(result.ready).toBe(false);
  expect(result.conflicts.length).toBeGreaterThan(0);
  expect(result.classifications).toEqual([]);
});
test('cosmetic classification requires authenticated before and after observations', () => {
  const f = fixture();
  f.review.judgments[0]!.classification = 'cosmetic';
  f.review.judgments[0]!.before_receipt = 'missing-before';
  f.review.judgments[0]!.after_receipt = 'missing-after';
  const result = assessIndependentReviews(f.evidence, [f.review]);
  expect(result.ready).toBe(false);
  expect(result.classifications).toEqual([]);
});
test('actor cannot supply its own independent review', () => {
  const f = fixture();
  f.review.reviewer = 'actor';
  expect(assessIndependentReviews(f.evidence, [f.review]).ready).toBe(false);
});

test('distinct events at one raw anchor each require an independent judgment', () => {
  const f = fixture();
  const anchor = { ...at(2), block: 0 };
  f.evidence.actor_review.events = [
    { kind: 'understanding', anchor, aligned: true, note: 'Purpose' },
    { kind: 'execution_choice', anchor, method: 'inline', note: 'Method' },
  ];
  const judgment = { ...f.review.judgments[0]!, anchor };
  f.review.judgments.push(
    { ...judgment, event: 'understanding' },
    { ...judgment, event: 'execution_choice' },
  );
  expect(assessIndependentReviews(f.evidence, [f.review]).ready).toBe(true);
  f.review.judgments.pop();
  expect(assessIndependentReviews(f.evidence, [f.review]).ready).toBe(false);
});
test('missing independent strict judgment keeps interpretation unresolved', () => {
  const f = fixture();
  f.review.strict_status = null;
  expect(assessIndependentReviews(f.evidence, [f.review]).ready).toBe(false);
});
function cosmeticFixture() {
  const f = fixture();
  f.evidence.receipts = ['before', 'after'].map((id, i) => {
    const content = Buffer.from(
      i === 0
        ? 'Status: pending\nDesign: local React\n'
        : 'Status: approved\nDesign: local React\n',
    );
    const raw =
      i === 0
        ? Buffer.from(
            `${f.raw.toString().split('\n').slice(0, 2).join('\n')}\n`,
          )
        : f.raw;
    return {
      schema_version: 2,
      observation_id: id,
      source_prefix: createRawPrefix(f.source, raw),
      artifact_path: 'spec.md',
      bytes: content.length,
      sha256: digest(content),
      content_base64: content.toString('base64'),
    };
  });
  f.review.judgments[0] = {
    ...f.review.judgments[0]!,
    classification: 'cosmetic',
    before_receipt: 'before',
    after_receipt: 'after',
  };
  return f;
}
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
test('cosmetic claim is exposed only with authenticated changed bytes around the call and result', () => {
  const f = cosmeticFixture();
  const r = assessIndependentReviews(f.evidence, [f.review]);
  expect(r.ready).toBe(true);
  expect(r.classifications[0]?.classification).toBe('cosmetic');
  expect(f.review.strict_status).toBe('fail');
});
test.each([
  'wrong artifact',
  'altered content',
  'wrong prefix hash',
  'same receipt',
  'result uncovered',
])('unverifiable cosmetic before/after claim: %s', (damage) => {
  const f = cosmeticFixture();
  if (damage === 'wrong artifact')
    f.evidence.receipts[1]!.artifact_path = 'other.md';
  if (damage === 'altered content')
    f.evidence.receipts[1]!.content_base64 =
      Buffer.from('different').toString('base64');
  if (damage === 'wrong prefix hash')
    f.evidence.receipts[0]!.source_prefix.sha256 = 'e'.repeat(64);
  if (damage === 'same receipt')
    f.review.judgments[0]!.after_receipt = 'before';
  if (damage === 'result uncovered')
    f.evidence.receipts[1]!.source_prefix = createRawPrefix(
      f.source,
      Buffer.from(`${f.raw.toString().split('\n').slice(0, 3).join('\n')}\n`),
    );
  const r = assessIndependentReviews(f.evidence, [f.review]);
  expect(r.ready).toBe(false);
  expect(r.classifications).toEqual([]);
});
