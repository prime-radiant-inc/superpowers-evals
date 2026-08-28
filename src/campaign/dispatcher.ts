// The campaign dispatcher (kernel D3, R-DSP-1..13): a THIN dispatcher over
// the shared execution primitive — CLI-argv children of the snapshot's own
// entrypoint, never in-process runScenario, runSchedule not generalized.
// Atomic per-block admission across subject pools + grader pool + the
// per-sample global cap; longest-expected-first + backfill; 429 cooldowns;
// E7 replacement/rerun entry with the ordered mint bundle; absolute-total
// budget snapshots with never-resurrects; the closed-window contention
// resolution batch; wave + block-terminal snapshot verify with the D-11
// drift response; D-13 storage-pause detection; halts; and D-12
// signal handling in the pinned order. This sub-task lands the pure cores;
// task 8b appends the orchestrator (and widens this import block).
import type { Block } from '../contracts/campaign/campaign.ts';
import { GLOBAL_POOL, GRADER_POOL } from './simulate.ts';

export class DispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherError';
  }
}

export const SPAWN_FAILURE_HALT_N = 3;

/** R-DSP-1: a block's demand vector is PER SAMPLE — 1 subject-pool slot +
 *  1 grader slot + 1 global slot (Decision D-1) — aggregated by pool key
 *  (a two-arm block on one credential demands 2 slots from one pool). */
export function blockDemandVector(args: {
  block: Block;
  sampleArmCredentialPool: (sampleId: string) => string;
  graderPool: string;
}): Map<string, number> {
  const demand = new Map<string, number>();
  for (const sampleId of args.block.sample_ids) {
    const subject = args.sampleArmCredentialPool(sampleId);
    demand.set(subject, (demand.get(subject) ?? 0) + 1);
    demand.set(GRADER_POOL, (demand.get(GRADER_POOL) ?? 0) + 1);
    demand.set(GLOBAL_POOL, (demand.get(GLOBAL_POOL) ?? 0) + 1);
  }
  return demand;
}

/** R-DSP-2: dispatch priority = the MAX expected duration across the
 *  block's samples (a two-arm block is as long as its longest arm). */
export function blockPrioritySeconds(args: {
  block: Block;
  sampleEstimateSeconds: (sampleId: string) => number;
}): number {
  let max = 0;
  for (const sampleId of args.block.sample_ids) {
    max = Math.max(max, args.sampleEstimateSeconds(sampleId));
  }
  return max;
}

/** Deterministic admission tie-break: comparison ordinal, cell key,
 *  replicate ordinal. block_id grammar: c<N>:<scenario>:b<R> / :x<K>. */
export function compareAdmissionOrder(
  a: { block_id: string },
  b: { block_id: string },
): number {
  const parse = (id: string): { cmp: number; cell: string; rep: number } => {
    const m = /^c(\d+):(.+):[bx](\d+)(?::|$)/.exec(id);
    if (m === null) return { cmp: Number.MAX_SAFE_INTEGER, cell: id, rep: 0 };
    return { cmp: Number(m[1]), cell: m[2] ?? '', rep: Number(m[3]) };
  };
  const pa = parse(a.block_id);
  const pb = parse(b.block_id);
  if (pa.cmp !== pb.cmp) return pa.cmp - pb.cmp;
  if (pa.cell !== pb.cell) return pa.cell < pb.cell ? -1 : 1;
  return pa.rep - pb.rep;
}

/** E7.7: the absolute-total snapshot value — total remaining estimated
 *  exposure of the current budget-exposure set. */
export function estimateInflightTotal(args: {
  exposureSamples: readonly { sampleId: string }[];
  estimateCostUsd: (sampleId: string) => number;
}): number {
  let total = 0;
  for (const s of args.exposureSamples)
    total += args.estimateCostUsd(s.sampleId);
  return total;
}
