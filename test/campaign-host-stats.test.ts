import { expect, test } from 'bun:test';
import {
  assertFingerprintMatch,
  DEFAULT_RESOURCE_FLOORS,
  type HostFingerprint,
  type HostStats,
  PreflightError,
  preflightResourceFloors,
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
  expect(() =>
    preflightResourceFloors(stats({ process_count: 1_000_000 }), {
      ...DEFAULT_RESOURCE_FLOORS,
      process_headroom: 256,
    }),
  ).toThrow(/process|pid/i);
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
});
