import type { LoadedCorpus } from './replay.ts';

export class SimConfigError extends Error {}

export interface SimSample {
  run_id: string;
  subject_pool: string;
  wall_ms: number;
  gauntlet_ms: number | null;
  coding_ms: number | null;
  pre_exposure_ms: number | null;
  estimate_ms: number;
}

export interface SimBlock {
  block_id: string;
  comparison_id: string;
  cell: string;
  replicate: number;
  order_key: string;
  samples: SimSample[];
}

export interface SimConfig {
  subject_caps: Record<string, number>;
  grader_cap: number;
  global_cap: number;
  ordering: 'estimates' | 'oracle' | 'historical-fifo';
  grader_occupancy: 'gauntlet' | 'gauntlet-active' | 'wall';
}

export interface PoolStats {
  busy_slot_ms: number;
  lower_bound_ms: number;
  attributed_wait_ms: number;
  saturation_ms: number;
}

export interface SimResult {
  makespan_ms: number;
  per_pool: Record<string, PoolStats>;
  blocks_completed: number;
  samples_completed: number;
  admission_sequence: string[];
}

export const GRADER_POOL = '__grader__';
export const GLOBAL_POOL = '__global__';

export function toSimBlocks(
  loaded: LoadedCorpus,
  estimateFor: (runId: string) => number,
): SimBlock[] {
  return loaded.blocks.map((b) => ({
    block_id: b.block_id,
    comparison_id: b.comparison_id,
    cell: b.cell,
    replicate: b.replicate,
    order_key: b.order_key,
    samples: b.samples.map((s) => {
      const rec = loaded.records.get(s.run_id);
      if (!rec) throw new SimConfigError(`missing record for ${s.run_id}`);
      return {
        run_id: s.run_id,
        subject_pool: s.subject_pool,
        wall_ms: rec.wall_ms,
        gauntlet_ms: rec.gauntlet_ms,
        coding_ms: rec.coding_ms,
        pre_exposure_ms: rec.pre_exposure_ms,
        estimate_ms: estimateFor(s.run_id),
      };
    }),
  }));
}

interface Active {
  blockId: string;
  runId: string;
  subjectPool: string;
  wallMs: number;
  graderHoldMs: number;
  subjectReleaseAt: number;
  graderReleaseAt: number;
}

function graderHold(
  sample: SimSample,
  mode: SimConfig['grader_occupancy'],
): number {
  const g = sample.gauntlet_ms ?? sample.wall_ms;
  if (mode === 'gauntlet') return g;
  if (mode === 'wall') return sample.wall_ms;
  return Math.max(0, g - (sample.coding_ms ?? 0)); // gauntlet-active
}

function blockPriority(
  block: SimBlock,
  ordering: SimConfig['ordering'],
): number {
  if (ordering === 'oracle')
    return Math.max(...block.samples.map((s) => s.wall_ms));
  return Math.max(...block.samples.map((s) => s.estimate_ms)); // estimates
}

/** Guard-cast: pool bookkeeping is pre-seeded for every cap key, so a miss
 *  here is an internal invariant violation — still loud, never silently
 *  defaulted (the src/campaign/replay.ts expectEntry pattern). */
function poolStat(stats: Map<string, PoolStats>, id: string): PoolStats {
  const s = stats.get(id);
  if (s === undefined)
    throw new SimConfigError(`internal: no stats for pool ${id}`);
  return s;
}

function poolCap(caps: Map<string, number>, id: string): number {
  const c = caps.get(id);
  if (c === undefined)
    throw new SimConfigError(`internal: no cap for pool ${id}`);
  return c;
}

export function simulate(blocks: SimBlock[], config: SimConfig): SimResult {
  // Reserved engine pools must not collide with subject pool ids — a
  // collision would silently overwrite the grader/global cap below and
  // conflate subject with grader/global occupancy.
  for (const pool of Object.keys(config.subject_caps)) {
    if (pool === GRADER_POOL || pool === GLOBAL_POOL) {
      throw new SimConfigError(
        `subject pool ${pool} collides with a reserved engine pool`,
      );
    }
  }

  // Structural infeasibility: cap-1 (or < demand) pools, loud at start.
  const demandOf = (b: SimBlock): Map<string, number> => {
    const d = new Map<string, number>();
    for (const s of b.samples) {
      d.set(s.subject_pool, (d.get(s.subject_pool) ?? 0) + 1);
      d.set(GRADER_POOL, (d.get(GRADER_POOL) ?? 0) + 1);
      d.set(GLOBAL_POOL, (d.get(GLOBAL_POOL) ?? 0) + 1);
    }
    return d;
  };
  const caps = new Map<string, number>(Object.entries(config.subject_caps));
  caps.set(GRADER_POOL, config.grader_cap);
  caps.set(GLOBAL_POOL, config.global_cap);
  for (const b of blocks) {
    for (const s of b.samples) {
      if (s.subject_pool === GRADER_POOL || s.subject_pool === GLOBAL_POOL) {
        throw new SimConfigError(
          `block ${b.block_id} sample ${s.run_id} names reserved pool ${s.subject_pool}`,
        );
      }
    }
    for (const [pool, need] of demandOf(b)) {
      const cap = caps.get(pool);
      if (cap === undefined)
        throw new SimConfigError(
          `no cap for pool ${pool} (block ${b.block_id})`,
        );
      if (cap < need) {
        throw new SimConfigError(
          `block ${b.block_id} demands ${need} slots from pool ${pool} with cap ${cap} — structurally infeasible`,
        );
      }
    }
  }

  const queue =
    config.ordering === 'historical-fifo'
      ? [...blocks]
      : [...blocks].sort(
          (a, b2) =>
            blockPriority(b2, config.ordering) -
              blockPriority(a, config.ordering) ||
            a.order_key.localeCompare(b2.order_key),
        );

  const active: Active[] = [];
  const stats = new Map<string, PoolStats>();
  const poolIds = new Set<string>([...caps.keys()]);
  for (const id of poolIds) {
    stats.set(id, {
      busy_slot_ms: 0,
      lower_bound_ms: 0,
      attributed_wait_ms: 0,
      saturation_ms: 0,
    });
  }
  const atCapSince = new Map<string, number | null>();
  const firstWaitAt = new Map<string, number>();
  const waitBinding = new Map<string, string[]>();
  const admissionSequence: string[] = [];

  const activeCount = (pool: string, t: number): number => {
    let n = 0;
    for (const a of active) {
      if (pool === a.subjectPool && a.subjectReleaseAt > t) n++;
      else if (pool === GRADER_POOL && a.graderReleaseAt > t) n++;
      else if (pool === GLOBAL_POOL && a.subjectReleaseAt > t) n++;
    }
    return n;
  };

  // Earliest instant at which `pool` has `need` free slots. Demand-aware:
  // one free slot does not satisfy a two-slot block. Only releases that
  // belong to THIS pool count (subject pools: their own samples' subject
  // holds; __grader__: grader holds; __global__: every sample's subject
  // hold) — another pool's earlier release must not contaminate the answer.
  const nextAvailable = (pool: string, t: number, need: number): number => {
    const free = poolCap(caps, pool) - activeCount(pool, t);
    if (free >= need) return t;
    const releases = active
      .filter(
        (a) =>
          pool === GRADER_POOL ||
          pool === GLOBAL_POOL ||
          a.subjectPool === pool,
      )
      .map((a) =>
        pool === GRADER_POOL ? a.graderReleaseAt : a.subjectReleaseAt,
      )
      .filter((x) => x > t)
      .sort((x, y) => x - y);
    const release = releases[need - free - 1];
    return release ?? t;
  };

  const fits = (b: SimBlock, t: number): boolean => {
    for (const [pool, need] of demandOf(b)) {
      if (activeCount(pool, t) + need > poolCap(caps, pool)) return false;
    }
    return true;
  };

  let t = 0;
  let makespan = 0;
  let samplesCompleted = 0;

  // Saturation = time at cap. Occupancy only changes at event instants, so a
  // pool that is at cap right after an admission scan stays at cap until the
  // next release instant. Cap-entry is detected after every scan (including
  // admission-driven entry); accrual happens when time advances past it.
  const accrueSaturation = (newT: number) => {
    for (const id of poolIds) {
      const since = atCapSince.get(id);
      if (since !== null && since !== undefined) {
        poolStat(stats, id).saturation_ms += newT - since;
        atCapSince.set(id, null);
      }
    }
  };
  const markCapEntry = (now: number) => {
    for (const id of poolIds) {
      if (
        (atCapSince.get(id) ?? null) === null &&
        activeCount(id, now) >= poolCap(caps, id)
      ) {
        atCapSince.set(id, now);
      }
    }
  };

  for (;;) {
    // Admit (greedy scan with backfill).
    for (const b of [...queue]) {
      if (!fits(b, t)) {
        if (!firstWaitAt.has(b.block_id)) {
          firstWaitAt.set(b.block_id, t);
          // Binding pools = demanded pools whose demand-aware next-available
          // instant is latest; ties split the charge.
          const demanded = [...demandOf(b)];
          const latest = Math.max(
            ...demanded.map(([p, need]) => nextAvailable(p, t, need)),
          );
          waitBinding.set(
            b.block_id,
            demanded
              .filter(([p, need]) => nextAvailable(p, t, need) === latest)
              .map(([p]) => p),
          );
        }
        continue;
      }
      queue.splice(queue.indexOf(b), 1);
      for (const s of b.samples) {
        const hold = graderHold(s, config.grader_occupancy);
        active.push({
          blockId: b.block_id,
          runId: s.run_id,
          subjectPool: s.subject_pool,
          wallMs: s.wall_ms,
          graderHoldMs: hold,
          subjectReleaseAt: t + s.wall_ms,
          graderReleaseAt: t + hold,
        });
        poolStat(stats, s.subject_pool).busy_slot_ms += s.wall_ms;
        poolStat(stats, GLOBAL_POOL).busy_slot_ms += s.wall_ms;
        poolStat(stats, GRADER_POOL).busy_slot_ms += hold;
        makespan = Math.max(makespan, t + s.wall_ms);
        samplesCompleted++;
      }
      admissionSequence.push(b.block_id);
      const firstWait = firstWaitAt.get(b.block_id);
      const binding = waitBinding.get(b.block_id);
      if (firstWait !== undefined && binding !== undefined) {
        const wait = t - firstWait;
        const share = wait / binding.length;
        for (const p of binding) poolStat(stats, p).attributed_wait_ms += share;
      }
    }
    markCapEntry(t);
    if (queue.length === 0 && active.length === 0) break;

    // Advance to the next release instant.
    const nextT = Math.min(
      ...active.flatMap((a) =>
        [a.subjectReleaseAt, a.graderReleaseAt].filter((x) => x > t),
      ),
    );
    if (!Number.isFinite(nextT)) break;
    accrueSaturation(nextT);
    t = nextT;
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i];
      if (
        a !== undefined &&
        a.subjectReleaseAt <= t &&
        a.graderReleaseAt <= t
      ) {
        active.splice(i, 1);
      }
    }
  }

  const per_pool: Record<string, PoolStats> = {};
  for (const [id, s] of stats) {
    const cap = poolCap(caps, id);
    per_pool[id] = { ...s, lower_bound_ms: cap > 0 ? s.busy_slot_ms / cap : 0 };
  }
  return {
    makespan_ms: makespan,
    per_pool,
    blocks_completed: admissionSequence.length,
    samples_completed: samplesCompleted,
    admission_sequence: admissionSequence,
  };
}
