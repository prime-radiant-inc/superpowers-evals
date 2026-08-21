import { expect, test } from 'bun:test';
import type { SimConfig } from '../src/campaign/simulate.ts';
import { simulate } from '../src/campaign/simulate.ts';
import {
  BATCH_JOBS,
  DISTILLED_BLOCKS,
  OBSERVED_ELAPSED_MS,
  SUBJECT_POOL,
} from './fixtures/campaign/batch-20260804T031849Z-2aef.ts';

/** Historical semantics: FIFO admission (run-all had no campaign policy),
 *  grader uncapped (no grader pool existed), one subject pool per
 *  credential at effectively uncapped concurrency, global cap = jobs. */
const HISTORICAL_CONFIG: SimConfig = {
  subject_caps: { [SUBJECT_POOL]: Number.POSITIVE_INFINITY },
  grader_cap: Number.POSITIVE_INFINITY,
  global_cap: BATCH_JOBS,
  ordering: 'historical-fifo',
  grader_occupancy: 'wall',
};

test('historical-mode replay reproduces the observed batch within 10%', () => {
  const result = simulate(DISTILLED_BLOCKS, HISTORICAL_CONFIG);
  const ratio = result.makespan_ms / OBSERVED_ELAPSED_MS;
  expect(ratio).toBeGreaterThan(0.9);
  expect(ratio).toBeLessThan(1.1);
  // FIFO semantics: admission follows results.jsonl (manifest) order.
  expect(result.admission_sequence).toEqual(
    DISTILLED_BLOCKS.map((b) => b.block_id),
  );
  expect(result.blocks_completed).toBe(DISTILLED_BLOCKS.length);
});

test('historical replay reports global-pool busy time consistent with sum of walls', () => {
  const result = simulate(DISTILLED_BLOCKS, HISTORICAL_CONFIG);
  const sumWalls = DISTILLED_BLOCKS.reduce(
    (n, b) => n + b.samples[0]!.wall_ms,
    0,
  );
  expect(result.per_pool['__global__']!.busy_slot_ms).toBe(sumWalls);
});
