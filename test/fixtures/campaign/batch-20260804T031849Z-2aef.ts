import type { SimBlock } from '../../../src/campaign/simulate.ts';

/** Distilled from results/batches/batch-20260804T031849Z-2aef (codex-only,
 *  jobs=2, observed elapsed 6,370,019 ms). Real recorded durations;
 *  identity fields simplified to the simulation's needs.
 *
 *  Sources (per run, read from the main checkout's results/ tree):
 *  - wall_ms: verdict.json finished_at − started_at
 *  - gauntlet_ms: gauntlet-agent/results/<gauntlet-id>/result.json .duration_ms
 *    (primary source present for all 7 runs; economics.gauntlet.duration_ms
 *    agreed within ~0.3% everywhere and was not needed as fallback)
 *  - coding_ms: economics.coding_agent.duration_ms
 *  - No results.jsonl record carried a skipped flag (record keys are
 *    scenario/coding_agent/run_id/credential only), so no run was excluded
 *    from the replay and OBSERVED_ELAPSED_MS covers all 7 records.
 *  results.jsonl order = manifest order; historical-fifo replays it as-is. */
export const OBSERVED_ELAPSED_MS = 6_370_019; // batch.json finished_at − started_at (verified)
export const BATCH_JOBS = 2;

/** Subject pool = credential limiterKey `name|api` (codex_sub has no
 *  base_url, api openai-responses — see the batch's
 *  credentials.snapshot.yaml). One pool for all 7 runs. */
export const SUBJECT_POOL = 'codex_sub|openai-responses';

export const DISTILLED_BLOCKS: SimBlock[] = [
  {
    block_id: 'codex-subagent-wait-mapping/1',
    comparison_id: 'codex_sub',
    cell: 'codex-subagent-wait-mapping',
    replicate: 1,
    order_key: 'codex_sub|codex-subagent-wait-mapping|0001|1',
    samples: [
      {
        run_id:
          'codex-subagent-wait-mapping-codex-codex_sub-linux-20260804T031849Z-6bee',
        subject_pool: SUBJECT_POOL,
        wall_ms: 129_007,
        gauntlet_ms: 128_144,
        coding_ms: 21_204,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
  {
    block_id: 'sdd-breaker-adjudicates-at-cap/1',
    comparison_id: 'codex_sub',
    cell: 'sdd-breaker-adjudicates-at-cap',
    replicate: 1,
    order_key: 'codex_sub|sdd-breaker-adjudicates-at-cap|0001|1',
    samples: [
      {
        run_id:
          'sdd-breaker-adjudicates-at-cap-codex-codex_sub-linux-20260804T031849Z-a791',
        subject_pool: SUBJECT_POOL,
        wall_ms: 621_473,
        gauntlet_ms: 619_765,
        coding_ms: 487_834,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
  {
    block_id: 'sdd-escalates-broken-plan/1',
    comparison_id: 'codex_sub',
    cell: 'sdd-escalates-broken-plan',
    replicate: 1,
    order_key: 'codex_sub|sdd-escalates-broken-plan|0001|1',
    samples: [
      {
        run_id:
          'sdd-escalates-broken-plan-codex-codex_sub-linux-20260804T032058Z-0cf8',
        subject_pool: SUBJECT_POOL,
        wall_ms: 1_037_749,
        gauntlet_ms: 1_036_425,
        coding_ms: 907_266,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
  {
    block_id: 'sdd-fix-loop-resumes-implementer/1',
    comparison_id: 'codex_sub',
    cell: 'sdd-fix-loop-resumes-implementer',
    replicate: 1,
    order_key: 'codex_sub|sdd-fix-loop-resumes-implementer|0001|1',
    samples: [
      {
        run_id:
          'sdd-fix-loop-resumes-implementer-codex-codex_sub-linux-20260804T032910Z-e5a1',
        subject_pool: SUBJECT_POOL,
        wall_ms: 1_152_869,
        gauntlet_ms: 1_149_634,
        coding_ms: 885_529,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
  {
    block_id: 'sdd-quality-reviewer-catches-planted-defect/1',
    comparison_id: 'codex_sub',
    cell: 'sdd-quality-reviewer-catches-planted-defect',
    replicate: 1,
    order_key: 'codex_sub|sdd-quality-reviewer-catches-planted-defect|0001|1',
    samples: [
      {
        run_id:
          'sdd-quality-reviewer-catches-planted-defect-codex-codex_sub-linux-20260804T033816Z-1cf0',
        subject_pool: SUBJECT_POOL,
        wall_ms: 1_149_676,
        gauntlet_ms: 1_147_940,
        coding_ms: 898_768,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
  {
    block_id: 'sdd-rejects-extra-features/1',
    comparison_id: 'codex_sub',
    cell: 'sdd-rejects-extra-features',
    replicate: 1,
    order_key: 'codex_sub|sdd-rejects-extra-features|0001|1',
    samples: [
      {
        run_id:
          'sdd-rejects-extra-features-codex-codex_sub-linux-20260804T034823Z-3e63',
        subject_pool: SUBJECT_POOL,
        wall_ms: 783_160,
        gauntlet_ms: 780_653,
        coding_ms: 648_146,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
  {
    block_id: 'sdd-svelte-todo/1',
    comparison_id: 'codex_sub',
    cell: 'sdd-svelte-todo',
    replicate: 1,
    order_key: 'codex_sub|sdd-svelte-todo|0001|1',
    samples: [
      {
        run_id: 'sdd-svelte-todo-codex-codex_sub-linux-20260804T035725Z-24e0',
        subject_pool: SUBJECT_POOL,
        wall_ms: 4_053_174,
        gauntlet_ms: 4_046_841,
        coding_ms: 3_877_887,
        pre_exposure_ms: null,
        estimate_ms: 0, // unused in historical-fifo
      },
    ],
  },
];
