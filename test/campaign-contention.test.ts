import { expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSidecarLine,
  breachWindows,
  ContentionSampler,
  evaluateContention,
  parseSidecar,
  type ResolvedThreshold,
  SIDECAR_FILENAME,
  type SidecarLine,
  samplerStaleMs,
  thresholdViolations,
} from '../src/campaign/contention.ts';
import type { HostStats, HostStatsProbe } from '../src/campaign/host-stats.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const GiB = 2 ** 30;
const MEM_FLOOR: ResolvedThreshold = {
  metric: 'mem_available_bytes',
  op: 'lt',
  value: 2 * GiB,
};
// The FROZEN registered fingerprint's core count (C6: never the live
// machine's) — threaded through every threshold evaluation.
const FROZEN_CORES = 8;

function stats(ts: number, memAvailable = 8 * GiB): HostStats {
  return {
    ts_ms: ts,
    load1: 0.1,
    mem_available_bytes: memAvailable,
    mem_total_bytes: 16 * GiB,
    swap_used_bytes: 0,
    swap_total_bytes: 2 * GiB,
    process_count: 100,
    pid_max: 4_194_304,
    disk_free_bytes: 50 * GiB,
    disk_total_bytes: 100 * GiB,
  };
}

test('thresholdViolations: gt/lt semantics over resolved absolute thresholds', () => {
  expect(
    thresholdViolations(stats(0, 1 * GiB), [MEM_FLOOR], FROZEN_CORES),
  ).toEqual(['mem_available_bytes']);
  expect(
    thresholdViolations(stats(0, 4 * GiB), [MEM_FLOOR], FROZEN_CORES),
  ).toEqual([]);
  expect(
    thresholdViolations(
      stats(0),
      [{ metric: 'load1', op: 'gt', value: 0.05 }],
      FROZEN_CORES,
    ),
  ).toEqual(['load1']);
});

test('C6a: load1_per_core normalizes by the FROZEN core count, never raw load', () => {
  const perCore: ResolvedThreshold = {
    metric: 'load1_per_core',
    op: 'gt',
    value: 2.0,
  };
  const loaded = { ...stats(0), load1: 20 };
  // 20 load on 16 frozen cores = 1.25/core -> in bounds; the same raw load
  // on 8 frozen cores = 2.5/core -> breached. Raw comparison (20 > 2.0)
  // would flag both.
  expect(thresholdViolations(loaded, [perCore], 16)).toEqual([]);
  expect(thresholdViolations(loaded, [perCore], 8)).toEqual(['load1_per_core']);
  // An unusable core count refuses rather than degrading to raw load
  // (fail-closed).
  expect(() => thresholdViolations(loaded, [perCore], 0)).toThrow(/cpu_cores/);
});

// The sampler loop resumes from its cadence sleep through a Promise.race —
// each clock.advance needs TWO microtask yields before the next iteration
// has run (the race's internal then, then the loop continuation).
async function tick2(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('sampler: cadence writes one fsynced JSON line per sample; probe failure writes a missing gap line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  const clock = new FakeClock(0);
  let failNext = false;
  const probe: HostStatsProbe = {
    sample(nowMs) {
      if (failNext) throw new Error('probe boom');
      return stats(nowMs);
    },
  };
  const sampler = new ContentionSampler({
    campaignDir: dir,
    probe,
    clock,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    cpuCores: FROZEN_CORES,
    onBreachEntry: () => {},
    onBreachExit: () => {},
    onSampleError: () => {},
  });
  const running = sampler.start(); // the FIRST sample fires at loop entry, t=0
  failNext = true;
  clock.advance(10); // iteration at t=10s: probe fails -> gap line
  await tick2();
  failNext = false;
  clock.advance(10); // iteration at t=20s: sample
  await tick2();
  await sampler.stop();
  await running;
  const { lines } = parseSidecar(dir);
  expect(lines.length).toBe(3); // sample@0, gap@10s, sample@20s
  const gaps = lines.filter((l) => 'missing' in l);
  expect(gaps.length).toBe(1);
  expect(gaps[0]).toEqual({ ts_ms: 10_000, missing: true });
});

test('symmetric K-sustained breach edges: entry after K consecutive crossings, exit after K consecutive in-bounds', () => {
  const lines: SidecarLine[] = [];
  let ts = 0;
  // 3 breached samples (K=3) -> entry; then 3 in-bounds -> exit.
  for (let i = 0; i < 3; i++) {
    ts += 10_000;
    lines.push({ ...stats(ts, 1 * GiB), breach: [] });
  }
  const windowsMid = breachWindows(lines, [MEM_FLOOR], 3, FROZEN_CORES);
  expect(windowsMid).toHaveLength(1);
  expect(windowsMid[0]!.endTsMs).toBeNull(); // still open
  for (let i = 0; i < 3; i++) {
    ts += 10_000;
    lines.push({ ...stats(ts, 8 * GiB), breach: [] });
  }
  const windows = breachWindows(lines, [MEM_FLOOR], 3, FROZEN_CORES);
  expect(windows).toHaveLength(1);
  expect(windows[0]!.startTsMs).toBe(30_000); // third consecutive crossing
  expect(windows[0]!.endTsMs).toBe(60_000); // third consecutive in-bounds
  // A single in-bounds sample mid-breach does NOT close it (sustain, not flap).
  const flap: SidecarLine[] = [
    { ...stats(10_000, 1 * GiB), breach: [] },
    { ...stats(20_000, 1 * GiB), breach: [] },
    { ...stats(30_000, 8 * GiB), breach: [] }, // one good sample
    { ...stats(40_000, 1 * GiB), breach: [] },
    { ...stats(50_000, 1 * GiB), breach: [] },
    { ...stats(60_000, 1 * GiB), breach: [] },
  ];
  const flapWindows = breachWindows(flap, [MEM_FLOOR], 3, FROZEN_CORES);
  expect(flapWindows[0]!.endTsMs).toBeNull();
});

test('gap lines count against coverage but neither extend nor interrupt a sustain run', () => {
  const lines: SidecarLine[] = [
    { ...stats(10_000, 1 * GiB), breach: [] },
    { ts_ms: 20_000, missing: true },
    { ...stats(30_000, 1 * GiB), breach: [] },
    { ...stats(40_000, 1 * GiB), breach: [] },
  ];
  const windows = breachWindows(lines, [MEM_FLOOR], 3, FROZEN_CORES);
  expect(windows).toHaveLength(1);
  expect(windows[0]!.startTsMs).toBe(40_000); // the gap did not break the sustain count
});

test('torn tail: parseSidecar truncates at the last complete line, loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  appendSidecarLine(dir, { ...stats(1000), breach: [] });
  // Append a torn (unterminated JSON) tail.
  appendFileSync(join(dir, SIDECAR_FILENAME), '{"ts_ms": 2000, "load1": ');
  // Capture the mandated stderr loudness instead of leaking it into test
  // output.
  const errSpy = spyOn(process.stderr, 'write');
  errSpy.mockImplementation(() => true); // pure capture — suppress the write
  let lines: SidecarLine[] = [];
  let truncatedTail = false;
  let loud = '';
  try {
    ({ lines, truncatedTail } = parseSidecar(dir));
    // Snapshot the captured calls BEFORE mockRestore — bun's restore
    // clears mock state.
    loud = errSpy.mock.calls.map((c) => String(c[0])).join('');
  } finally {
    errSpy.mockRestore();
  }
  expect(lines).toHaveLength(1);
  expect(truncatedTail).toBe(true);
  expect(loud).toContain('torn tail — truncated at the last complete line');
});

test('the pure evaluator: invalid > unknown > clean precedence, one interpretation', () => {
  // Samples every 10s from t=10..90s, then one at t=250s.
  // Crossings at 10/20/30 -> the K=3 window OPENS at 30s; in-bounds at
  // 40/50/60 -> it CLOSES at 60s. The 90s->250s sample gap (160s > N x
  // cadence = 40s) is the uncovered interval [90s, 250s].
  const lines: SidecarLine[] = [];
  for (let t = 10_000; t <= 90_000; t += 10_000) {
    const breached = t <= 30_000;
    lines.push({ ...stats(t, breached ? 1 * GiB : 8 * GiB), breach: [] });
  }
  lines.push({ ...stats(250_000, 8 * GiB), breach: [] });
  const verdicts = evaluateContention({
    lines,
    truncatedTail: false,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    cpuCores: FROZEN_CORES,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 250_000,
    blocks: [
      { block_id: 'overlaps-breach', startTsMs: 20_000, endTsMs: 55_000 },
      { block_id: 'in-gap', startTsMs: 100_000, endTsMs: 240_000 },
      { block_id: 'clean', startTsMs: 65_000, endTsMs: 85_000 },
    ],
  });
  expect(verdicts.get('overlaps-breach')).toBe('invalid'); // overlaps [30s, 60s]
  expect(verdicts.get('in-gap')).toBe('unknown'); // uncovered, never contention
  expect(verdicts.get('clean')).toBe('clean'); // covered, outside the window
});

test('evaluator: a still-live block clips to the breach-closure timestamp', () => {
  const lines: SidecarLine[] = [];
  for (let t = 10_000; t <= 60_000; t += 10_000) {
    lines.push({
      ...stats(t, t >= 30_000 && t <= 50_000 ? 1 * GiB : 8 * GiB),
      breach: [],
    });
  }
  const verdicts = evaluateContention({
    lines,
    truncatedTail: false,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    cpuCores: FROZEN_CORES,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 60_000,
    blocks: [{ block_id: 'live', startTsMs: 20_000, endTsMs: null }],
  });
  expect(verdicts.get('live')).toBe('invalid');
});

test('C6b: coverage anchors at the REAL campaign_opened — a pre-first-sample head gap is uncovered', () => {
  // The sidecar's first sample lands 100s after campaign_opened (> N x
  // cadence = 40s): work dispatched in that blind head must classify
  // unknown. This is why live evaluation must pass the journal's actual
  // campaign_opened.ts_ms, never 0 or another placeholder.
  const lines: SidecarLine[] = [
    { ...stats(100_000), breach: [] },
    { ...stats(110_000), breach: [] },
  ];
  const verdicts = evaluateContention({
    lines,
    truncatedTail: false,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    cpuCores: FROZEN_CORES,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 110_000,
    blocks: [
      { block_id: 'early', startTsMs: 10_000, endTsMs: 30_000 },
      { block_id: 'late', startTsMs: 102_000, endTsMs: 108_000 },
    ],
  });
  expect(verdicts.get('early')).toBe('unknown');
  expect(verdicts.get('late')).toBe('clean');
});

test('C6c: torn-tail state produces an uncovered interval from the last sample to the horizon', () => {
  const lines: SidecarLine[] = [];
  for (let t = 10_000; t <= 60_000; t += 10_000) {
    lines.push({ ...stats(t), breach: [] });
  }
  const blocks = [{ block_id: 'tail', startTsMs: 70_000, endTsMs: 90_000 }];
  const base = {
    lines,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    cpuCores: FROZEN_CORES,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 100_000,
    blocks,
  };
  // 60s -> 100s horizon is exactly N x cadence: covered when the tail is
  // intact...
  expect(
    evaluateContention({ ...base, truncatedTail: false }).get('tail'),
  ).toBe('clean');
  // ...but a torn tail truncated at 60s makes [60s, horizon] uncovered.
  expect(evaluateContention({ ...base, truncatedTail: true }).get('tail')).toBe(
    'unknown',
  );
});

test('C6c: an explicit gap line uncovers the interval between its real-sample neighbors', () => {
  // Real samples bracket the failed probe at 30s by only 20s (< N x cadence
  // = 40s) — the spacing test alone would call this covered; the recorded
  // gap line is direct evidence of blindness and uncovers (20s, 40s).
  const lines: SidecarLine[] = [
    { ...stats(10_000), breach: [] },
    { ...stats(20_000), breach: [] },
    { ts_ms: 30_000, missing: true },
    { ...stats(40_000), breach: [] },
    { ...stats(50_000), breach: [] },
  ];
  const verdicts = evaluateContention({
    lines,
    truncatedTail: false,
    thresholds: [MEM_FLOOR],
    sustainK: 3,
    cadenceMs: 10_000,
    coverageN: 4,
    cpuCores: FROZEN_CORES,
    campaignOpenedTsMs: 0,
    lastTerminalTsMs: 50_000,
    blocks: [
      { block_id: 'over-gap', startTsMs: 25_000, endTsMs: 35_000 },
      { block_id: 'clear', startTsMs: 42_000, endTsMs: 48_000 },
    ],
  });
  expect(verdicts.get('over-gap')).toBe('unknown');
  expect(verdicts.get('clear')).toBe('clean');
});

test('dead-sampler liveness: staleness > 2x cadence is detectable', () => {
  const lines: SidecarLine[] = [{ ...stats(10_000), breach: [] }];
  expect(samplerStaleMs(lines, 10_000)).toBe(0);
  expect(samplerStaleMs(lines, 31_000)).toBe(21_000); // > 2 x 10s cadence
  expect(samplerStaleMs([], 5_000)).toBe(Number.POSITIVE_INFINITY);
});

test('fsync-before-notify: the exit sample is durable BEFORE the closed-window callback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  const clock = new FakeClock(0);
  const probe: HostStatsProbe = {
    sample(nowMs) {
      return stats(
        nowMs,
        nowMs >= 10_000 && nowMs <= 30_000 ? 1 * GiB : 8 * GiB,
      );
    },
  };
  let exitLineCountAtNotify = -1;
  const sampler = new ContentionSampler({
    campaignDir: dir,
    probe,
    clock,
    thresholds: [MEM_FLOOR],
    sustainK: 1, // fast edges for the test
    cadenceMs: 10_000,
    cpuCores: FROZEN_CORES,
    onBreachEntry: () => {},
    onBreachExit: () => {
      exitLineCountAtNotify = readFileSync(join(dir, SIDECAR_FILENAME), 'utf8')
        .split('\n')
        .filter((l) => l !== '').length;
    },
    onSampleError: () => {},
  });
  const running = sampler.start(); // samples at t=0 (in-bounds), then per tick
  for (let i = 0; i < 4; i++) {
    clock.advance(10);
    await tick2();
  }
  await sampler.stop();
  await running;
  // Iterations at t=0,10,20,30,40: entry at 10s (K=1), exit at 40s. When the
  // exit callback fired, the sidecar ALREADY held all five lines including
  // the exit sample — the pinned fsync-before-notify order.
  expect(exitLineCountAtNotify).toBe(5);
});
