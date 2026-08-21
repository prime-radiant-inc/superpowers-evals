import { expect, test } from 'bun:test';
import {
  type SimBlock,
  SimConfigError,
  simulate,
} from '../src/campaign/simulate.ts';

function block(
  id: string,
  pool: string,
  walls: number[],
  orderKey?: string,
): SimBlock {
  return {
    block_id: id,
    comparison_id: 'cmp',
    cell: 'cell',
    replicate: 1,
    order_key: orderKey ?? id,
    samples: walls.map((w, i) => ({
      run_id: `${id}-s${i}`,
      subject_pool: pool,
      wall_ms: w,
      gauntlet_ms: w,
      coding_ms: w,
      pre_exposure_ms: null,
      estimate_ms: w,
    })),
  };
}

const CFG = (
  over: Partial<Parameters<typeof simulate>[1]>,
): Parameters<typeof simulate>[1] => ({
  subject_caps: { p1: 5 },
  grader_cap: 100,
  global_cap: 100,
  ordering: 'oracle',
  grader_occupancy: 'gauntlet',
  ...over,
});

test('single block: makespan = max arm wall; busy slots accumulate per sample', () => {
  const r = simulate([block('b1', 'p1', [100, 200])], CFG({}));
  expect(r.makespan_ms).toBe(200);
  expect(r.per_pool['p1']!.busy_slot_ms).toBe(300); // 100+200
  expect(r.per_pool['__grader__']!.busy_slot_ms).toBe(300);
  expect(r.per_pool['__global__']!.busy_slot_ms).toBe(300);
});

test('same-pool two-arm blocks draw 2 slots: cap 2 serializes, cap 4 pairs', () => {
  const blocks = [block('b1', 'p1', [100, 100]), block('b2', 'p1', [100, 100])];
  expect(simulate(blocks, CFG({ subject_caps: { p1: 2 } })).makespan_ms).toBe(
    200,
  );
  expect(simulate(blocks, CFG({ subject_caps: { p1: 4 } })).makespan_ms).toBe(
    100,
  );
});

test('cap-1 pool with a same-pool two-arm block is a loud infeasibility', () => {
  expect(() =>
    simulate([block('b1', 'p1', [100, 100])], CFG({ subject_caps: { p1: 1 } })),
  ).toThrow(SimConfigError);
});

test('grader pool binds: two blocks, grader_cap 1 → serialized despite subject headroom', () => {
  const blocks = [block('b1', 'p1', [100]), block('b2', 'p2', [100])];
  const r = simulate(
    blocks,
    CFG({ subject_caps: { p1: 5, p2: 5 }, grader_cap: 1 }),
  );
  expect(r.makespan_ms).toBe(200);
});

test('global cap counts runs: two-arm block needs 2 global slots', () => {
  const blocks = [block('b1', 'p1', [100, 100]), block('b2', 'p1', [100])];
  const r = simulate(blocks, CFG({ subject_caps: { p1: 9 }, global_cap: 2 }));
  expect(r.makespan_ms).toBe(200); // b1 fills both slots; b2 waits
});

test('multi-slot demand accounting: two-slot blocks cannot squeeze into one free slot (makespan floor 350)', () => {
  // giant needs 2 slots of cap 3; two smalls need 1 each.
  const giant = block('giant', 'p1', [300, 300]);
  const small1 = block('small1', 'p1', [100]);
  const small2 = block('small2', 'p1', [100]);
  const filler = block('filler', 'p1', [50, 50], 'aaa-filler');
  // oracle sorts by max wall desc → giant, small1, small2, filler.
  // cap 3: t=0 giant (2 slots) + small1 (1 slot) fill the pool; small2 and
  // filler both wait. t=100: small1's ONE slot frees → small2 takes it
  // (3/3 again); filler (2 slots) cannot fit into 1 free slot. t=200:
  // small2 done, only 1 free — filler still blocked by giant's 2. t=300:
  // giant releases → filler admits, finishing at 350.
  // NOTE (corrected from the brief's 300): a 300 makespan is impossible for
  // ANY schedule — giant (2×300) and filler (2×50) would need 4 concurrent
  // slots to overlap, so under cap 3 one must fully follow the other:
  // makespan ≥ 300 + 50 = 350. (Renamed in fix round 1: at t=100 small2 is
  // the queue HEAD and fits, so head-of-line scheduling produces the same
  // sequence — backfill itself is discriminated by a separate test below.)
  const r = simulate(
    [giant, small1, small2, filler],
    CFG({ subject_caps: { p1: 3 } }),
  );
  expect(r.makespan_ms).toBe(350);
  expect(r.admission_sequence).toEqual(['giant', 'small1', 'small2', 'filler']);
  expect(r.per_pool['p1']!.busy_slot_ms).toBe(300 + 300 + 100 + 100 + 100);
});

test('backfill discriminates from head-of-line: small bypasses a blocked big2', () => {
  const giant = block('giant', 'p1', [300, 300]);
  const big2 = block('big2', 'p1', [200, 200]);
  const small = block('small', 'p1', [100]);
  const r = simulate([giant, big2, small], CFG({ subject_caps: { p1: 3 } }));
  // t=0: giant admits (2/3). big2 needs 2 slots, only 1 free — it waits.
  // small needs 1 slot and FITS: backfill admits it past the blocked big2.
  // big2 then starts at t=300 (at t=100 only ONE slot has freed — giant
  // still holds 2 — which cannot satisfy big2's 2-slot demand) and finishes
  // at 500. A head-of-line engine would stall small behind big2, yielding
  // sequence [giant, big2, small] — the sequence is what discriminates
  // here (both schedules end at 500: small always fits alongside big2 once
  // giant releases).
  expect(r.makespan_ms).toBe(500);
  expect(r.admission_sequence).toEqual(['giant', 'small', 'big2']);
  expect(r.admission_sequence.indexOf('small')).toBeLessThan(
    r.admission_sequence.indexOf('big2'),
  );
});

test('wait attribution: waiting block charges the binding pool (ties split)', () => {
  const a = block('a', 'p1', [200, 200]);
  const b = block('b', 'p2', [200, 200], 'bbb');
  const r = simulate(
    [a, b],
    CFG({ subject_caps: { p1: 2, p2: 2 }, grader_cap: 3, global_cap: 2 }),
  );
  // Demand-aware binding at b's first failed instant (t=0): p2 has both
  // slots free (available now); __global__ is full — a holds 2 of 2, so b's
  // need of 2 is next satisfiable at 200 — and __grader__ has 1 of 3 free
  // vs b's need of 2 (also next satisfiable at 200). A genuine tie for
  // latest → the 200ms charge splits evenly across __global__ and
  // __grader__. (The brief's original "b waits 200ms on __global__"
  // expectation was calibrated to the demand-blind nextAvailable, which
  // returned 0 for __grader__ despite 1 free slot < 2 needed.)
  expect(r.makespan_ms).toBe(400);
  expect(r.per_pool['__global__']!.attributed_wait_ms).toBe(100);
  expect(r.per_pool['__grader__']!.attributed_wait_ms).toBe(100);
  expect(r.per_pool['p2']!.attributed_wait_ms).toBe(0);
});

test('demand-aware binding: one free slot of a cap-2 pool does not satisfy a 2-slot block', () => {
  // warm holds 1 of 2 p1 slots until t=500; `two` needs 2 p1 slots and so
  // fails at t=0 even though a slot is nominally free. nextAvailable(p1, 0, 2)
  // must be 500 (the held slot's release), not 0 — grader and global have
  // headroom, so the binding pool is p1 ALONE and the whole wait lands there.
  const warm = block('warm', 'p1', [500]);
  const two = block('two', 'p1', [100, 100]);
  const r = simulate([warm, two], CFG({ subject_caps: { p1: 2 } }));
  expect(r.admission_sequence).toEqual(['warm', 'two']);
  expect(r.makespan_ms).toBe(600);
  expect(r.per_pool['p1']!.attributed_wait_ms).toBe(500);
  expect(r.per_pool['__grader__']!.attributed_wait_ms).toBe(0);
  expect(r.per_pool['__global__']!.attributed_wait_ms).toBe(0);
});

test('binding selection counts only the evaluated pool\u2019s own releases', () => {
  // occA holds pA full until 600; occB holds pB full until 300. A mixed
  // block needing 1 slot from each pool binds on pA (next available 600),
  // not pB (300) — occB's earlier release must not contaminate pA's answer.
  const occA = block('occA', 'pA', [600, 600]);
  const occB = block('occB', 'pB', [300, 300]);
  const mixed: SimBlock = {
    block_id: 'mixed',
    comparison_id: 'cmp',
    cell: 'cell',
    replicate: 1,
    order_key: 'zzz-mixed',
    samples: [
      {
        run_id: 'mixed-a',
        subject_pool: 'pA',
        wall_ms: 100,
        gauntlet_ms: 100,
        coding_ms: 100,
        pre_exposure_ms: null,
        estimate_ms: 100,
      },
      {
        run_id: 'mixed-b',
        subject_pool: 'pB',
        wall_ms: 100,
        gauntlet_ms: 100,
        coding_ms: 100,
        pre_exposure_ms: null,
        estimate_ms: 100,
      },
    ],
  };
  const r = simulate(
    [occA, occB, mixed],
    CFG({ subject_caps: { pA: 2, pB: 2 } }),
  );
  expect(r.makespan_ms).toBe(700);
  expect(r.per_pool['pA']!.attributed_wait_ms).toBe(600);
  expect(r.per_pool['pB']!.attributed_wait_ms).toBe(0);
});

test('historical-fifo preserves manifest order regardless of wall length', () => {
  const long = block('long', 'p1', [400], 'aaa');
  const short = block('short', 'p1', [100], 'zzz');
  const r = simulate(
    [long, short],
    CFG({ subject_caps: { p1: 1 }, ordering: 'historical-fifo' }),
  );
  expect(r.makespan_ms).toBe(500); // long first (400), then short (100)
  const r2 = simulate(
    [long, short],
    CFG({ subject_caps: { p1: 1 }, ordering: 'oracle' }),
  );
  expect(r2.makespan_ms).toBe(500); // same here; order check is in the sequence — see admission log
  expect(r.admission_sequence).toEqual(['long', 'short']);
});

test('grader occupancy modes change grader busy time, not makespan drivers', () => {
  const b = block('b1', 'p1', [200]);
  b.samples[0]!.gauntlet_ms = 200;
  b.samples[0]!.coding_ms = 150;
  const full = simulate([b], CFG({}));
  const active = simulate(
    [{ ...b }],
    CFG({ grader_occupancy: 'gauntlet-active' }),
  );
  expect(full.per_pool['__grader__']!.busy_slot_ms).toBe(200);
  expect(active.per_pool['__grader__']!.busy_slot_ms).toBe(50);
});

// Pinning test (added beyond the brief's nine): saturation_ms is "time at
// cap", including caps reached via ADMISSION at an event instant — the
// brief's reference markSaturation only sampled cap-ness at release
// instants, so admission-driven saturation was silently dropped.
test('saturation_ms counts time at cap, including admission-driven cap entry', () => {
  const blocks = [block('a', 'p1', [100, 100]), block('b', 'p1', [100, 100])];
  const r = simulate(blocks, CFG({ subject_caps: { p1: 4 }, global_cap: 4 }));
  // both blocks admitted at t=0 → p1 and __global__ sit at 4/4 for [0, 100)
  expect(r.per_pool['p1']!.saturation_ms).toBe(100);
  expect(r.per_pool['__global__']!.saturation_ms).toBe(100);
  // grader cap 100 is never approached
  expect(r.per_pool['__grader__']!.saturation_ms).toBe(0);
  // lower bound sanity: 4 samples × 100ms = 400 slot-ms over 4 slots
  expect(r.per_pool['p1']!.lower_bound_ms).toBe(100);
});
