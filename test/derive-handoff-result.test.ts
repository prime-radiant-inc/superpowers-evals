import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveHandoffResult } from '../scripts/derive-handoff-result.ts';

const block = (overrides: Record<string, string | number> = {}) => ({
  PAIRWISE_RESULT: 'B_BETTER',
  A_BINDING_BURDENS: 'lifecycle=2; result propagation=1',
  B_BINDING_BURDENS: 'none',
  SHARED_BINDING_BURDENS: 'none',
  A_UNIQUE_MAJOR_BURDENS: 'lifecycle=2',
  B_UNIQUE_MAJOR_BURDENS: 'none',
  A_UNIQUE_MINOR_BURDENS: 'result propagation=1',
  B_UNIQUE_MINOR_BURDENS: 'none',
  A_TOTAL_BURDEN: 3,
  B_TOTAL_BURDEN: 0,
  A_UNIQUE_CONTRADICTIONS: 'none',
  B_UNIQUE_CONTRADICTIONS: 'none',
  A_UNIQUE_DESIGN_DRIFT: 'none',
  B_UNIQUE_DESIGN_DRIFT: 'none',
  PLANNING_OWNED: 'method names',
  ...overrides,
});

function fixture(
  fields = block(),
  labels = { A: 'initial', B: 'final' },
  artifacts = { A: 'initial draft\n', B: 'final draft\n' },
) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-result-'));
  const manifest = join(dir, 'manifest.json');
  const result = join(dir, 'result.json');
  writeFileSync(manifest, JSON.stringify({ labels }));
  writeFileSync(join(dir, 'A.md'), artifacts.A);
  writeFileSync(join(dir, 'B.md'), artifacts.B);
  writeFileSync(
    result,
    JSON.stringify({
      reasoning: Object.entries(fields)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n'),
    }),
  );
  return { manifest, result };
}

test('GREEN requires lower final burden with no final-only major regression', () => {
  const { manifest, result } = fixture();
  expect(deriveHandoffResult(manifest, result)).toMatchObject({
    outcome: 'green',
    initialLabel: 'A',
    finalLabel: 'B',
    initialBurden: 3,
    finalBurden: 0,
  });
});

test('a restored byte-identical draft is a safe tie, not GREEN', () => {
  const tied = block({
    PAIRWISE_RESULT: 'TIED',
    B_BINDING_BURDENS: 'lifecycle=2; result propagation=1',
    B_UNIQUE_MAJOR_BURDENS: 'none',
    A_UNIQUE_MINOR_BURDENS: 'none',
    A_TOTAL_BURDEN: 3,
    B_TOTAL_BURDEN: 3,
  });
  const { manifest, result } = fixture(tied, undefined, {
    A: 'restored draft\n',
    B: 'restored draft\n',
  });
  expect(deriveHandoffResult(manifest, result).outcome).toBe('safe_tie');
});

test('a final-only minor burden permits GREEN when total burden falls', () => {
  const { manifest, result } = fixture(
    block({
      B_BINDING_BURDENS: 'new operator step=1',
      B_UNIQUE_MINOR_BURDENS: 'new operator step=1',
      B_TOTAL_BURDEN: 1,
    }),
  );
  expect(deriveHandoffResult(manifest, result).outcome).toBe('green');
});

test('unchanged or increased total burden is not GREEN', () => {
  const { manifest, result } = fixture(
    block({
      B_BINDING_BURDENS: 'replacement burden=3',
      B_UNIQUE_MINOR_BURDENS: 'replacement burden=3',
      B_TOTAL_BURDEN: 3,
    }),
  );
  expect(deriveHandoffResult(manifest, result).outcome).toBe('failure');
});

test('a final-only major burden prevents GREEN despite lower total', () => {
  const { manifest, result } = fixture(
    block({
      B_BINDING_BURDENS: 'new ownership decision=2',
      B_UNIQUE_MAJOR_BURDENS: 'new ownership decision=2',
      B_TOTAL_BURDEN: 2,
    }),
  );
  expect(deriveHandoffResult(manifest, result).outcome).toBe('failure');
});

test('a final-only contradiction prevents GREEN despite lower burden', () => {
  const { manifest, result } = fixture(
    block({
      B_UNIQUE_CONTRADICTIONS: 'resume conflicts with lifecycle',
      B_TOTAL_BURDEN: 1,
    }),
  );
  expect(deriveHandoffResult(manifest, result).outcome).toBe('failure');
});

test('the manifest controls direction when final is A', () => {
  const { manifest, result } = fixture(
    block({
      PAIRWISE_RESULT: 'A_BETTER',
      A_BINDING_BURDENS: 'none',
      B_BINDING_BURDENS: 'lifecycle=2',
      A_UNIQUE_MAJOR_BURDENS: 'none',
      B_UNIQUE_MAJOR_BURDENS: 'lifecycle=2',
      A_UNIQUE_MINOR_BURDENS: 'none',
      B_UNIQUE_MINOR_BURDENS: 'none',
      A_TOTAL_BURDEN: 0,
      B_TOTAL_BURDEN: 2,
    }),
    { A: 'final', B: 'initial' },
  );
  expect(deriveHandoffResult(manifest, result)).toMatchObject({
    outcome: 'green',
    initialLabel: 'B',
    finalLabel: 'A',
  });
});
