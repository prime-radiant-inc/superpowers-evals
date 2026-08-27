import { expect, test } from 'bun:test';
import { cpus } from 'node:os';
import {
  assertFingerprintMatch,
  DEFAULT_RESOURCE_FLOORS,
  fingerprintFromStats,
  type HostFingerprint,
  type HostStats,
  type HostStatsProbe,
  hostStatsFromRaw,
  linuxHostStatsProbe,
  PreflightError,
  parseMeminfo,
  parsePidMax,
  preflightResourceFloors,
  probeFingerprint,
} from '../src/campaign/host-stats.ts';

const GiB = 2 ** 30;

function stats(overrides: Partial<HostStats> = {}): HostStats {
  return {
    ts_ms: 0,
    load1: 0.1,
    mem_available_bytes: 8 * GiB,
    mem_total_bytes: 16 * GiB,
    swap_used_bytes: 0,
    swap_total_bytes: 2 * GiB,
    process_count: 200,
    pid_max: 4_194_304,
    disk_free_bytes: 100 * GiB,
    disk_total_bytes: 494 * GiB,
    ...overrides,
  };
}

test('preflight passes above floors and fails loud beneath each floor', () => {
  expect(() =>
    preflightResourceFloors(stats(), DEFAULT_RESOURCE_FLOORS),
  ).not.toThrow();
  expect(() =>
    preflightResourceFloors(
      stats({ disk_free_bytes: 1 }),
      DEFAULT_RESOURCE_FLOORS,
    ),
  ).toThrow(PreflightError);
  expect(() =>
    preflightResourceFloors(
      stats({ mem_available_bytes: 1 }),
      DEFAULT_RESOURCE_FLOORS,
    ),
  ).toThrow(/memory/i);
  // PID headroom is judged against the HOST's real pid ceiling (R2), never
  // an invented constant: a low pid_max with a modest process count refuses.
  expect(() =>
    preflightResourceFloors(
      stats({ process_count: 5_000, pid_max: 4_096 }),
      DEFAULT_RESOURCE_FLOORS,
    ),
  ).toThrow(/process|pid/i);
  // An unusable ceiling (unreadable pid_max surfaced as 0) fails closed too.
  expect(() =>
    preflightResourceFloors(stats({ pid_max: 0 }), DEFAULT_RESOURCE_FLOORS),
  ).toThrow(/pid/i);
});

const FP: HostFingerprint = {
  cpu_model: 'Apple M1',
  cpu_cores: 8,
  mem_bytes: 16 * GiB,
  disk_total_bytes: 494 * GiB,
};

test('fingerprint match: exact cpu_model + cpu_cores; tolerance bands on mem/disk', () => {
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).not.toThrow();
  // CPU drift refuses loudly (names both fingerprints).
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP, cpu_model: 'AMD EPYC' },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).toThrow(/Apple M1.*AMD EPYC|fingerprint/i);
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP, cpu_cores: 16 },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).toThrow(PreflightError);
  // Mem within 10% ok; outside refuses.
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP, mem_bytes: 15 * GiB },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).not.toThrow();
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP, mem_bytes: 8 * GiB },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).toThrow(PreflightError);
  // Disk within 10% ok; outside refuses (R4: the disk legs were missing).
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP, disk_total_bytes: 480 * GiB },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).not.toThrow();
  expect(() =>
    assertFingerprintMatch(
      FP,
      { ...FP, disk_total_bytes: 200 * GiB },
      { mem_tolerance_pct: 10, disk_tolerance_pct: 10 },
    ),
  ).toThrow(PreflightError);
});

// ---- Pure translation layer (R4): raw OS text/structures -> HostStats /
// HostFingerprint, fixture-driven, never touching real /proc or statfs. ----

const MEMINFO = [
  'MemTotal:       16384000 kB',
  'MemFree:         8192000 kB',
  'MemAvailable:   12288000 kB',
  'SwapTotal:       2097152 kB',
  'SwapFree:        1048576 kB',
].join('\n');

test('parseMeminfo translates SwapTotal/SwapFree to bytes and throws on missing/malformed fields (R3)', () => {
  const swap = parseMeminfo(`${MEMINFO}\n`);
  expect(swap.swap_total_bytes).toBe(2 * GiB);
  expect(swap.swap_free_bytes).toBe(1 * GiB);
  // A swapless host is legitimate: SwapTotal present with value 0 is NOT a
  // failure — only a MISSING or unparseable field refuses.
  const swapless = parseMeminfo(
    ['MemTotal: 16384000 kB', 'SwapTotal: 0 kB', 'SwapFree: 0 kB'].join('\n'),
  );
  expect(swapless.swap_total_bytes).toBe(0);
  expect(swapless.swap_free_bytes).toBe(0);
  // Missing SwapTotal -> fail-closed, never a silent 0 (R3).
  expect(() =>
    parseMeminfo(['MemTotal: 16384000 kB', 'SwapFree: 1048576 kB'].join('\n')),
  ).toThrow(PreflightError);
  // Missing SwapFree -> fail-closed (R3).
  expect(() =>
    parseMeminfo(['MemTotal: 16384000 kB', 'SwapTotal: 2097152 kB'].join('\n')),
  ).toThrow(PreflightError);
  // Malformed value -> fail-closed (R3).
  expect(() =>
    parseMeminfo(['SwapTotal: lots kB', 'SwapFree: 1048576 kB'].join('\n')),
  ).toThrow(PreflightError);
  // Garbage text -> fail-closed (R3).
  expect(() => parseMeminfo('this is not meminfo')).toThrow(PreflightError);
});

test('parsePidMax reads the host ceiling and fails closed on garbage/zero/negative (R2, R3)', () => {
  expect(parsePidMax('4194304\n')).toBe(4_194_304);
  expect(parsePidMax('32768')).toBe(32_768);
  expect(() => parsePidMax('cat')).toThrow(PreflightError);
  expect(() => parsePidMax('')).toThrow(PreflightError);
  expect(() => parsePidMax('0\n')).toThrow(PreflightError);
  expect(() => parsePidMax('-42\n')).toThrow(PreflightError);
  expect(() => parsePidMax('4194304\n8192\n')).toThrow(PreflightError);
});

test('hostStatsFromRaw assembles HostStats: swap math, pid flow, process count, disk math (R4)', () => {
  const s = hostStatsFromRaw(7_000, {
    load1: 0.42,
    mem_available_bytes: 12 * GiB,
    mem_total_bytes: 16 * GiB,
    meminfo_text: `${MEMINFO}\n`,
    pid_max_text: '4194304\n',
    proc_entries: ['1', '42', 'self', 'thread-self', 'sys', 'irq', '999'],
    fs: { bavail: 1_000, bsize: 4_096, blocks: 5_000 },
  });
  expect(s.ts_ms).toBe(7_000);
  expect(s.load1).toBe(0.42);
  expect(s.mem_available_bytes).toBe(12 * GiB);
  expect(s.mem_total_bytes).toBe(16 * GiB);
  expect(s.swap_total_bytes).toBe(2 * GiB);
  expect(s.swap_used_bytes).toBe(1 * GiB); // total - free
  expect(s.process_count).toBe(3); // numeric /proc/<pid> entries only
  expect(s.pid_max).toBe(4_194_304);
  expect(s.disk_free_bytes).toBe(1_000 * 4_096);
  expect(s.disk_total_bytes).toBe(5_000 * 4_096);
  // swap_used clamps at zero when free > total (malformed-but-parseable data).
  const clamp = hostStatsFromRaw(0, {
    load1: 0,
    mem_available_bytes: 1,
    mem_total_bytes: 2,
    meminfo_text: 'SwapTotal: 100 kB\nSwapFree: 900 kB\n',
    pid_max_text: '4096\n',
    proc_entries: [],
    fs: { bavail: 0, bsize: 512, blocks: 0 },
  });
  expect(clamp.swap_used_bytes).toBe(0);
  expect(clamp.process_count).toBe(0);
  // Fail-closed inputs propagate (missing swap field refuses construction).
  expect(() =>
    hostStatsFromRaw(0, {
      load1: 0,
      mem_available_bytes: 1,
      mem_total_bytes: 2,
      meminfo_text: 'MemTotal: 1 kB\n',
      pid_max_text: '4096\n',
      proc_entries: [],
      fs: { bavail: 0, bsize: 512, blocks: 0 },
    }),
  ).toThrow(PreflightError);
});

test('fingerprintFromStats constructs the D-4 fingerprint and refuses empty CPU identity (R3, R4)', () => {
  const fp = fingerprintFromStats(stats(), 'Apple M1', 8);
  expect(fp).toEqual({
    cpu_model: 'Apple M1',
    cpu_cores: 8,
    mem_bytes: 16 * GiB,
    disk_total_bytes: 494 * GiB,
  });
  // Missing CPU identity refuses — never a placeholder string (R3).
  expect(() => fingerprintFromStats(stats(), '', 8)).toThrow(PreflightError);
  expect(() => fingerprintFromStats(stats(), '   ', 8)).toThrow(PreflightError);
  expect(() => fingerprintFromStats(stats(), 'Apple M1', 0)).toThrow(
    PreflightError,
  );
});

test('probeFingerprint derives mem/disk from the probe and CPU from the host (R4)', () => {
  const probe: HostStatsProbe = {
    sample: (nowMs: number) => stats({ ts_ms: nowMs }),
  };
  const fp = probeFingerprint(probe, 1_234);
  expect(fp.mem_bytes).toBe(16 * GiB); // from the probe sample
  expect(fp.disk_total_bytes).toBe(494 * GiB); // from the probe sample
  expect(fp.cpu_cores).toBe(cpus().length); // from os.cpus()
  expect(fp.cpu_model.length).toBeGreaterThan(0);
  expect(probe.sample(1_234).ts_ms).toBe(1_234); // the probe saw the passed now
});

test('linuxHostStatsProbe refuses on non-Linux platforms (fail-closed, R-LCK-3)', () => {
  const probe = linuxHostStatsProbe('/tmp');
  if (process.platform === 'linux') {
    // On a real Linux host the platform gate passes and the reads are real;
    // the read path itself is covered by the pure-layer tests above.
    expect(probe).toBeDefined();
    return;
  }
  expect(() => probe.sample(0)).toThrow(/requires the Linux appliance/);
  expect(() => probe.sample(0)).toThrow(PreflightError);
});
