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
import { GLOBAL_POOL } from './simulate.ts';

export class DispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherError';
  }
}

export const SPAWN_FAILURE_HALT_N = 3;

/** R-DSP-1 + R-DSP-8: a block's demand vector is PER SAMPLE — 1 slot in
 *  the sample-arm's subject pool + 1 slot in the REAL registered grader
 *  credential's pool key + 1 global slot (Decision D-1) — aggregated by
 *  pool key (a two-arm block on one credential demands 2 slots from one
 *  subject pool). The grader pool is the registered credential's own key,
 *  never the simulator-reserved '__grader__' abstraction. */
export function blockDemandVector(args: {
  block: Block;
  sampleArmCredentialPool: (sampleId: string) => string;
  graderPool: string;
}): Map<string, number> {
  const demand = new Map<string, number>();
  for (const sampleId of args.block.sample_ids) {
    const subject = args.sampleArmCredentialPool(sampleId);
    demand.set(subject, (demand.get(subject) ?? 0) + 1);
    demand.set(args.graderPool, (demand.get(args.graderPool) ?? 0) + 1);
    demand.set(GLOBAL_POOL, (demand.get(GLOBAL_POOL) ?? 0) + 1);
  }
  return demand;
}

/** R-DSP-2: dispatch priority = the MAX expected duration across the
 *  block's samples (a two-arm block is as long as its longest arm).
 *  Fail-closed: estimates must be finite and non-negative — a NaN or
 *  negative estimate must never silently order a block. */
export function blockPrioritySeconds(args: {
  block: Block;
  sampleEstimateSeconds: (sampleId: string) => number;
}): number {
  if (args.block.sample_ids.length === 0) {
    throw new DispatcherError('blockPrioritySeconds: block has no samples');
  }
  let max = 0;
  for (const sampleId of args.block.sample_ids) {
    const seconds = args.sampleEstimateSeconds(sampleId);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new DispatcherError(
        `blockPrioritySeconds: invalid estimate for sample ${sampleId}: ${seconds}`,
      );
    }
    max = Math.max(max, seconds);
  }
  return max;
}

/** Deterministic admission tie-break (R-DSP-2): comparison ordinal,
 *  cell key, replicate ordinal, block kind (primary b before reserve x),
 *  rerun-lineage seq, then the raw id as the final arbiter — a TOTAL
 *  order over every valid block id (primary c<N>:<cell>:b<R>, reserve
 *  c<N>:<cell>:x<K>, rerun instance <root>:i<seq>; spec ID table).
 *  Ids outside the grammar sort last, ordered by raw id. */
export function compareAdmissionOrder(
  a: { block_id: string },
  b: { block_id: string },
): number {
  const parse = (
    id: string,
  ): {
    cmp: number;
    cell: string;
    rep: number;
    kind: string;
    lineage: number;
  } => {
    const m = /^c(\d+):([a-z0-9][a-z0-9._-]*):([bx])(\d+)(?::i(\d+))?$/.exec(
      id,
    );
    if (m === null) {
      return {
        cmp: Number.MAX_SAFE_INTEGER,
        cell: id,
        rep: 0,
        kind: '',
        lineage: 0,
      };
    }
    return {
      cmp: Number(m[1]),
      cell: m[2] ?? '',
      rep: Number(m[4]),
      kind: m[3] ?? '',
      lineage: m[5] === undefined ? 0 : Number(m[5]),
    };
  };
  const pa = parse(a.block_id);
  const pb = parse(b.block_id);
  if (pa.cmp !== pb.cmp) return pa.cmp - pb.cmp;
  if (pa.cell !== pb.cell) return pa.cell < pb.cell ? -1 : 1;
  if (pa.rep !== pb.rep) return pa.rep - pb.rep;
  if (pa.kind !== pb.kind) return pa.kind < pb.kind ? -1 : 1;
  if (pa.lineage !== pb.lineage) return pa.lineage - pb.lineage;
  return a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0;
}

/** E7.7: the absolute-total snapshot value — total remaining estimated
 *  exposure of the current budget-exposure set. Fail-closed: every cost
 *  must be finite and non-negative; an invalid cost must never silently
 *  enter a budget predicate. */
export function estimateInflightTotal(args: {
  exposureSamples: readonly { sampleId: string }[];
  estimateCostUsd: (sampleId: string) => number;
}): number {
  let total = 0;
  for (const s of args.exposureSamples) {
    const cost = args.estimateCostUsd(s.sampleId);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new DispatcherError(
        `estimateInflightTotal: invalid cost for sample ${s.sampleId}: ${cost}`,
      );
    }
    total += cost;
  }
  return total;
}
