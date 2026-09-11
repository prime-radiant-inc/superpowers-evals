import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveFallbackResult } from '../scripts/derive-fallback-result.ts';
import { extractFallbackPair } from '../scripts/extract-fallback-pair.ts';

test('extracts and blinds original versus tentative while omitting review specs', () => {
  const root = mkdtempSync(join(tmpdir(), 'fallback-pair-'));
  const workdir = join(root, 'coding-agent-workdir');
  const specs = join(workdir, 'docs/superpowers/specs');
  mkdirSync(specs, { recursive: true });
  mkdirSync(join(workdir, 'src'), { recursive: true });
  writeFileSync(join(specs, 'original.md'), 'original\n');
  writeFileSync(join(specs, 'tentative.md'), 'tentative\n');
  writeFileSync(join(specs, 'selected.md'), 'original\n');
  writeFileSync(join(workdir, 'src/service.js'), 'export {};\n');

  const out = join(root, 'blind');
  const result = extractFallbackPair(
    root,
    'docs/superpowers/specs/original.md',
    'docs/superpowers/specs/tentative.md',
    'docs/superpowers/specs/selected.md',
    out,
    () => 0,
  );

  expect(result.labels).toEqual({ A: 'original', B: 'tentative' });
  expect(readFileSync(join(out, 'A.md'), 'utf8')).toBe('original\n');
  expect(readFileSync(join(out, 'B.md'), 'utf8')).toBe('tentative\n');
  expect(readFileSync(join(out, 'repository/src/service.js'), 'utf8')).toBe(
    'export {};\n',
  );
  expect(() =>
    readFileSync(join(out, 'repository/docs/superpowers/specs/original.md')),
  ).toThrow();
});

test('derives fallback GREEN from restoration plus tentative-only major burden', () => {
  const root = mkdtempSync(join(tmpdir(), 'fallback-result-'));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ labels: { A: 'tentative', B: 'original' } }),
  );
  writeFileSync(join(root, 'selected.md'), 'original\n');
  writeFileSync(join(root, 'original.md'), 'original\n');
  writeFileSync(join(root, 'tentative.md'), 'tentative\n');
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({
      reasoning: [
        'A_UNIQUE_MAJOR_BURDENS: moves execution into control boundary=2',
        'B_UNIQUE_MAJOR_BURDENS: none',
        'A_UNIQUE_CONTRADICTIONS: none',
        'B_UNIQUE_CONTRADICTIONS: none',
        'A_UNIQUE_DESIGN_DRIFT: moves execution into control boundary',
        'B_UNIQUE_DESIGN_DRIFT: none',
      ].join('\n'),
    }),
  );

  expect(
    deriveFallbackResult(
      join(root, 'manifest.json'),
      join(root, 'result.json'),
      join(root, 'selected.md'),
      join(root, 'original.md'),
      join(root, 'tentative.md'),
    ),
  ).toMatchObject({ outcome: 'fallback_green', tentativeLabel: 'A' });
});

test('does not pass when the tentative revision has no independent disqualifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'fallback-result-'));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ labels: { A: 'original', B: 'tentative' } }),
  );
  for (const [name, body] of [
    ['selected.md', 'original\n'],
    ['original.md', 'original\n'],
    ['tentative.md', 'tentative\n'],
  ] as const) {
    writeFileSync(join(root, name), body);
  }
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({
      reasoning: [
        'A_UNIQUE_MAJOR_BURDENS: none',
        'B_UNIQUE_MAJOR_BURDENS: none',
        'A_UNIQUE_CONTRADICTIONS: none',
        'B_UNIQUE_CONTRADICTIONS: none',
        'A_UNIQUE_DESIGN_DRIFT: none',
        'B_UNIQUE_DESIGN_DRIFT: none',
      ].join('\n'),
    }),
  );

  expect(
    deriveFallbackResult(
      join(root, 'manifest.json'),
      join(root, 'result.json'),
      join(root, 'selected.md'),
      join(root, 'original.md'),
      join(root, 'tentative.md'),
    ).outcome,
  ).toBe('failure');
});
