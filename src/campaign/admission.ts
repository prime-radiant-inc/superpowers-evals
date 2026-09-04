import type { Block } from '../contracts/campaign/campaign.ts';

export class DispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherError';
  }
}

/** R-DSP-2: dispatch priority = the MAX expected duration across the
 *  block's samples (a two-arm block is as long as its longest arm).
 *  A missing optional estimate uses the experiment's frozen attempt
 *  deadline. Explicit estimates must be finite and non-negative. */
export function blockPrioritySeconds(args: {
  block: Pick<Block, 'sample_ids'>;
  sampleEstimateSeconds: (sampleId: string) => number | undefined;
  attemptDeadlineSeconds?: number;
}): number {
  if (args.block.sample_ids.length === 0) {
    throw new DispatcherError('blockPrioritySeconds: block has no samples');
  }
  let max = 0;
  for (const sampleId of args.block.sample_ids) {
    const estimate = args.sampleEstimateSeconds(sampleId);
    const seconds = estimate ?? args.attemptDeadlineSeconds;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
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
