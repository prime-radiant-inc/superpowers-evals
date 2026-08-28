import { expect, test } from 'bun:test';
import {
  blockDemandVector,
  blockPrioritySeconds,
  compareAdmissionOrder,
  DispatcherError,
  estimateInflightTotal,
} from '../src/campaign/dispatcher.ts';
import { GLOBAL_POOL } from '../src/campaign/simulate.ts';

const block = (sample_ids: string[]) => ({
  block_id: 'b',
  comparison_id: 'c1',
  sample_ids,
});

test('demand vector: per-sample subject pool + REAL grader pool + global (R-DSP-1, R-DSP-8)', () => {
  const demand = blockDemandVector({
    block: block(['s1', 's2']),
    sampleArmCredentialPool: () => 'poolA',
    graderPool: 'the-registered-grader-poolKey',
  });
  expect(demand.get('poolA')).toBe(2); // two samples on one subject pool
  // The grader demand lands under the REAL registered grader pool key
  // (R-DSP-8), never under the simulator-reserved '__grader__' constant.
  expect(demand.get('the-registered-grader-poolKey')).toBe(2);
  expect(demand.has('__grader__')).toBe(false);
  expect(demand.get(GLOBAL_POOL)).toBe(2); // per-sample global slots (Decision D-1)
});

test('demand vector aggregates mixed subject pools per sample', () => {
  const demand = blockDemandVector({
    block: block(['s1', 's2', 's3']),
    sampleArmCredentialPool: (s) => (s === 's1' ? 'poolA' : 'poolB'),
    graderPool: 'grader',
  });
  expect(demand.get('poolA')).toBe(1);
  expect(demand.get('poolB')).toBe(2);
  expect(demand.get('grader')).toBe(3);
  expect(demand.get(GLOBAL_POOL)).toBe(3);
});

test('priority = max sample estimate (REV sol #15); zero is valid, invalid is not', () => {
  expect(
    blockPrioritySeconds({
      block: block(['s1', 's2']),
      sampleEstimateSeconds: (s) => (s === 's1' ? 100 : 300),
    }),
  ).toBe(300);
  expect(
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => 0,
    }),
  ).toBe(0);
});

test('admission tie-break is total and deterministic over all valid block ids', () => {
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b2' }, { block_id: 'c1:a:b1' }),
  ).toBeGreaterThan(0);
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c2:a:b1' }),
  ).toBeLessThan(0);
  // kind marker separates primary from reserve at the same replicate ordinal
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c1:a:x1' }),
  ).toBeLessThan(0);
  // lineage suffix separates a rerun instance from its root and orders instances
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c1:a:b1:i1' }),
  ).toBeLessThan(0);
  expect(
    compareAdmissionOrder(
      { block_id: 'c1:a:b1:i1' },
      { block_id: 'c1:a:b1:i2' },
    ),
  ).toBeLessThan(0);
  // reflexivity + unparsable ids sort last, ordered by raw id
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c1:a:b1' }),
  ).toBe(0);
  expect(
    compareAdmissionOrder(
      { block_id: 'c1:a:b1' },
      { block_id: 'not-a-block-id' },
    ),
  ).toBeLessThan(0);
  expect(
    compareAdmissionOrder({ block_id: 'zzz' }, { block_id: 'aaa' }),
  ).toBeGreaterThan(0);
  const shuffled = [
    'c1:a:b1:i2',
    'c1:a:x1',
    'c1:a:b2',
    'c2:z:b1',
    'c1:a:b1:i1',
    'c1:a:b1',
    'c2:a:b1',
  ];
  const ordered = shuffled
    .map((block_id) => ({ block_id }))
    .sort(compareAdmissionOrder)
    .map((b) => b.block_id);
  expect(ordered).toEqual([
    'c1:a:b1',
    'c1:a:b1:i1',
    'c1:a:b1:i2',
    'c1:a:x1',
    'c1:a:b2',
    'c2:a:b1',
    'c2:z:b1',
  ]);
});

test('estimateInflightTotal sums the exposure set (E7.7)', () => {
  expect(
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }, { sampleId: 'b' }],
      estimateCostUsd: () => 1.5,
    }),
  ).toBe(3);
  expect(
    estimateInflightTotal({ exposureSamples: [], estimateCostUsd: () => 1.5 }),
  ).toBe(0); // no in-flight exposure is a legitimate zero
});

test('pure cores fail closed on invalid numerics (typed error)', () => {
  expect(() =>
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => Number.NaN,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => -1,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    blockPrioritySeconds({
      block: block(['s1']),
      sampleEstimateSeconds: () => Number.POSITIVE_INFINITY,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    blockPrioritySeconds({ block: block([]), sampleEstimateSeconds: () => 1 }),
  ).toThrow(DispatcherError);
  expect(() =>
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }],
      estimateCostUsd: () => -0.5,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }],
      estimateCostUsd: () => Number.NaN,
    }),
  ).toThrow(DispatcherError);
  expect(() =>
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }],
      estimateCostUsd: () => Number.POSITIVE_INFINITY,
    }),
  ).toThrow(DispatcherError);
});
