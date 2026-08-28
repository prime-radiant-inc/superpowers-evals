import { expect, test } from 'bun:test';
import {
  blockDemandVector,
  blockPrioritySeconds,
  compareAdmissionOrder,
  estimateInflightTotal,
} from '../src/campaign/dispatcher.ts';
import { GLOBAL_POOL, GRADER_POOL } from '../src/campaign/simulate.ts';

test('pure cores: demand vector per sample (subject + grader + global), priority = max sample estimate, deterministic order', () => {
  const demand = blockDemandVector({
    block: { block_id: 'b', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
    sampleArmCredentialPool: () => 'poolA',
    graderPool: 'graderPool',
  });
  expect(demand.get('poolA')).toBe(2); // two samples on one pool
  expect(demand.get(GRADER_POOL)).toBe(2);
  expect(demand.get(GLOBAL_POOL)).toBe(2); // per-sample global slots (Decision D-1)
  const priority = blockPrioritySeconds({
    block: { block_id: 'b', comparison_id: 'c1', sample_ids: ['s1', 's2'] },
    sampleEstimateSeconds: (s) => (s === 's1' ? 100 : 300),
  });
  expect(priority).toBe(300); // max across samples (REV sol #15)
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b2' }, { block_id: 'c1:a:b1' }),
  ).toBeGreaterThan(0);
  expect(
    compareAdmissionOrder({ block_id: 'c1:a:b1' }, { block_id: 'c2:a:b1' }),
  ).toBeLessThan(0);
  expect(
    estimateInflightTotal({
      exposureSamples: [{ sampleId: 'a' }, { sampleId: 'b' }],
      estimateCostUsd: () => 1.5,
    }),
  ).toBe(3);
});
