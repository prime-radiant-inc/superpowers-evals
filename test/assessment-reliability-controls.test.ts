import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSupplementalControls } from '../docs/experiments/2026-09-09-conversation-assessor-reliability/controls.ts';
import { getEnv } from '../src/env.ts';

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'assessment-controls-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('a receipt claiming approval without the frozen byte identity cannot authorize controls', () => {
  const root = temporary();
  const receipt = join(root, 'receipt.json');
  writeFileSync(
    receipt,
    JSON.stringify({ status: 'approved', counts: { cases: 8, criteria: 16 } }),
  );
  expect(() => loadSupplementalControls(root, receipt)).toThrow(
    'receipt sha256 mismatch',
  );
});

const controlRoot = getEnv('ASSESSMENT_CONTROL_ROOT');
const gRoot = getEnv('GAUNTLET_ROOT');

// Private inputs are optional for routine CI. The Task 6 gate supplies both roots.
describe.skipIf(!controlRoot)('exact approved supplemental freeze', () => {
  function fixture() {
    const parent = temporary();
    const root = join(parent, 'heldout-v2');
    cpSync(controlRoot!, root, { recursive: true });
    const receiptPath = join(parent, 'heldout-freeze-receipt.json');
    cpSync(join(dirname(controlRoot!), basename(receiptPath)), receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      bindings: Record<string, { path: string }>;
    };
    for (const ref of Object.values(receipt.bindings)) {
      if (dirname(ref.path) === dirname(controlRoot!))
        cpSync(ref.path, join(parent, basename(ref.path)));
    }
    return { root, receiptPath };
  }

  test('the subsequent approved receipt authenticates all eight despite historical pre-review flags', () => {
    const { root, receiptPath } = fixture();
    const controls = loadSupplementalControls(root, receiptPath);
    expect(controls.map((c) => c.id)).toEqual([
      'control-01',
      'control-02',
      'control-03',
      'control-04',
      'control-05',
      'control-06',
      'control-07',
      'control-08',
    ]);
    expect(controls.map((c) => c.expected)).toEqual([
      ['pass', 'pass'],
      ['pass', 'fail'],
      ['unclear', 'pass'],
      ['pass', 'pass'],
      ['fail', 'pass'],
      ['pass', 'fail'],
      ['pass', 'fail'],
      ['pass', 'fail'],
    ]);
  });

  test.each([
    ['receipt', '../heldout-freeze-receipt.json'],
    ['manifest', 'manifest.json'],
    ['rubric', 'cases/control-01/rubric.md'],
    ['index', 'cases/control-01/evidence/index.json'],
    ['evidence', 'cases/control-01/evidence/conversation.md'],
    ['last case evidence', 'cases/control-08/evidence/20-actions.log'],
    ['expectation', 'expectations/control-08.json'],
    ['blind review', '../heldout-blind-review.json'],
    ['comparison review', '../heldout-comparison-review.md'],
  ])('rejects changed %s bytes even when JSON semantics are unchanged', (_label, path) => {
    const { root, receiptPath } = fixture();
    const target = resolve(root, path);
    writeFileSync(
      target,
      Buffer.concat([readFileSync(target), Buffer.from(' ')]),
    );
    expect(() => loadSupplementalControls(root, receiptPath)).toThrow(
      /sha256 mismatch/,
    );
  });

  test('recomputed manifest digests cannot replace the separately approved freeze', () => {
    const { root, receiptPath } = fixture();
    const target = join(root, 'manifest.json');
    const manifest = JSON.parse(readFileSync(target, 'utf8'));
    manifest.cases.pop();
    manifest.caseCount = 7;
    manifest.criterionCount = 14;
    writeFileSync(target, JSON.stringify(manifest));
    expect(() => loadSupplementalControls(root, receiptPath)).toThrow(
      'manifest sha256 mismatch',
    );
  });

  test('rejects an indexed symlink even if its target has the frozen bytes', () => {
    const { root, receiptPath } = fixture();
    const target = join(root, 'cases/control-01/evidence/conversation.md');
    const outside = join(dirname(root), 'copy.md');
    cpSync(target, outside);
    rmSync(target);
    symlinkSync(outside, target);
    expect(() => loadSupplementalControls(root, receiptPath)).toThrow(
      /regular|outside|symbolic/,
    );
  });

  test.skipIf(!gRoot)(
    'the projection and actual scoped reader expose only authenticated indexed evidence',
    async () => {
      const { root, receiptPath } = fixture();
      const { readEvidenceFile, parseEvidenceIndex } = await import(
        pathToFileURL(resolve(gRoot!, 'src/context/scoped-read.ts')).href
      );
      const { parseStoryCard } = await import(
        pathToFileURL(resolve(gRoot!, 'src/format/story-card.ts')).href
      );
      let criteria = 0;
      let evidenceFiles = 0;
      for (const c of loadSupplementalControls(root, receiptPath)) {
        const input = {
          rubricPath: c.rubricPath,
          evidenceRoot: c.evidenceRoot,
          evidenceIndexPath: c.evidenceIndexPath,
        };
        expect(Object.keys(input).sort()).toEqual([
          'evidenceIndexPath',
          'evidenceRoot',
          'rubricPath',
        ]);
        const rubric = parseStoryCard(readFileSync(input.rubricPath, 'utf8'));
        expect(rubric.acceptanceCriteria).toHaveLength(c.expected.length);
        criteria += rubric.acceptanceCriteria.length;
        const index = parseEvidenceIndex(
          JSON.parse(readFileSync(input.evidenceIndexPath, 'utf8')),
        );
        for (const path of index.files) {
          expect(readEvidenceFile(input.evidenceRoot, index, path)).toBe(
            readFileSync(join(input.evidenceRoot, path), 'utf8'),
          );
          evidenceFiles++;
        }
        // These really exist. Rejection must come from the scope, not ENOENT.
        for (const name of [
          'expectations.json',
          'manifest.json',
          'prior-adjudication.md',
          'source-review.json',
        ]) {
          writeFileSync(
            join(input.evidenceRoot, name),
            'private caller material',
          );
          expect(() =>
            readEvidenceFile(input.evidenceRoot, index, name),
          ).toThrow(/not listed/);
        }
        expect(() =>
          readEvidenceFile(input.evidenceRoot, index, '../rubric.md'),
        ).toThrow(/traversal/);
        expect(() =>
          readEvidenceFile(
            input.evidenceRoot,
            index,
            '../../../expectations/control-01.json',
          ),
        ).toThrow(/traversal/);
      }
      expect(criteria).toBe(16);
      expect(evidenceFiles).toBe(13);
    },
  );
});

describe.skipIf(!gRoot)('scoped reader with hostile fixture indexes', () => {
  test('a traversal or indexed symlink cannot expose caller gold', async () => {
    const { readEvidenceFile } = await import(
      pathToFileURL(resolve(gRoot!, 'src/context/scoped-read.ts')).href
    );
    const parent = temporary();
    const root = join(parent, 'evidence');
    mkdirSync(root);
    writeFileSync(join(parent, 'gold.json'), 'private labels');
    symlinkSync(join(parent, 'gold.json'), join(root, 'conversation.md'));
    expect(() =>
      readEvidenceFile(root, { files: ['../gold.json'] }, '../gold.json'),
    ).toThrow(/traversal/);
    expect(() =>
      readEvidenceFile(root, { files: ['conversation.md'] }, 'conversation.md'),
    ).toThrow(/symbolic link/);
  });
});
