// The injectable host-stats probe seam (Decision D-3): preflight (task 2),
// registration fingerprint (task 5), and the contention sampler (task 7)
// share this one probe. Also the uniform ms derivation for the Clock seam:
// src/scheduler/clock.ts is SECONDS-based; every D3 millisecond field
// (journal ts_ms, sidecar lines, heartbeats, cooldowns) derives through
// clockNowMs — one Clock named uniformly, never wall-clock reads in tests.
import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { Clock } from '../scheduler/clock.ts';

export interface HostStats {
  readonly ts_ms: number;
  readonly load1: number;
  readonly mem_available_bytes: number;
  readonly mem_total_bytes: number;
  readonly swap_used_bytes: number;
  readonly swap_total_bytes: number;
  readonly process_count: number;
  readonly disk_free_bytes: number;
  readonly disk_total_bytes: number;
}

/** Injectable: tests supply scripted series; production supplies the Linux
 *  reader (task 2). A probe failure is the caller's policy (missing-sample
 *  gap line for the sampler, refusal for preflight). */
export interface HostStatsProbe {
  sample(nowMs: number): HostStats;
}

export function clockNowMs(clock: Clock): number {
  return Math.round(clock.now() * 1000);
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** Production probe (Decision D-3 metric sources): load1 via os.loadavg();
 *  memory via os.freemem/totalmem; swap + process count via /proc (Linux);
 *  disk via statfs on the campaign/results volume. The v1 designated host is
 *  the Linux appliance — other platforms fail closed (workstation use of the
 *  blessed bundle is forbidden by policy). */
export function linuxHostStatsProbe(diskPath: string): HostStatsProbe {
  return {
    sample(nowMs: number): HostStats {
      if (process.platform !== 'linux') {
        throw new PreflightError(
          `host stats probe requires the Linux appliance (got ${process.platform}) — portable tests inject a fake probe`,
        );
      }
      const meminfo = readMeminfo();
      const fs = statfsSync(diskPath);
      return {
        ts_ms: nowMs,
        load1: loadavg()[0] ?? 0,
        mem_available_bytes: freemem(),
        mem_total_bytes: totalmem(),
        swap_used_bytes: Math.max(0, meminfo.swapTotal - meminfo.swapFree),
        swap_total_bytes: meminfo.swapTotal,
        process_count: readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n))
          .length,
        disk_free_bytes: fs.bavail * fs.bsize,
        disk_total_bytes: fs.blocks * fs.bsize,
      };
    },
  };
}

function readMeminfo(): { swapTotal: number; swapFree: number } {
  const text = readFileSync('/proc/meminfo', 'utf8');
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m === null ? 0 : Number(m[1]) * 1024;
  };
  return { swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

export interface ResourceFloors {
  readonly disk_free_bytes: number;
  readonly mem_available_bytes: number;
  readonly process_headroom: number;
}

/** Drafted defaults (flagged for gate challenge — the parent pins the
 *  obligation, not the numbers). */
export const DEFAULT_RESOURCE_FLOORS: ResourceFloors = {
  disk_free_bytes: 2 * 2 ** 30,
  mem_available_bytes: 1 * 2 ** 30,
  process_headroom: 256,
};

/** Drafted PID-table ceiling for the headroom computation (flagged for gate
 *  challenge): refuse when the live process count leaves less than
 *  process_headroom slots beneath this ceiling. */
export const PID_MAX_SLOTS = 1_000_000;

export function preflightResourceFloors(
  stats: HostStats,
  floors: ResourceFloors,
): void {
  const violations: string[] = [];
  if (stats.disk_free_bytes < floors.disk_free_bytes) {
    violations.push(
      `disk free ${stats.disk_free_bytes} < floor ${floors.disk_free_bytes}`,
    );
  }
  if (stats.mem_available_bytes < floors.mem_available_bytes) {
    violations.push(
      `available memory ${stats.mem_available_bytes} < floor ${floors.mem_available_bytes}`,
    );
  }
  if (stats.process_count > PID_MAX_SLOTS - floors.process_headroom) {
    violations.push(
      `process count ${stats.process_count} leaves < ${floors.process_headroom} PID headroom beneath ${PID_MAX_SLOTS}`,
    );
  }
  if (violations.length > 0) {
    throw new PreflightError(
      `resource-floor preflight failed: ${violations.join('; ')} — refuse launch (fail-closed)`,
    );
  }
}

// The fingerprint shape is the contract's (campaign.ts HostFingerprintSchema,
// Task 1) — re-exported here so probes and registration share one type.
export type { HostFingerprint } from '../contracts/campaign/campaign.ts';

import type { HostFingerprint } from '../contracts/campaign/campaign.ts';

export function probeFingerprint(
  probe: HostStatsProbe,
  nowMs: number,
): HostFingerprint {
  const stats = probe.sample(nowMs);
  const cpu = cpus();
  return {
    cpu_model: cpu[0]?.model ?? 'unknown',
    cpu_cores: cpu.length,
    mem_bytes: stats.mem_total_bytes,
    disk_total_bytes: stats.disk_total_bytes,
  };
}

/** Decision D-4 fingerprint-match policy: exact match on cpu_model and
 *  cpu_cores; registered tolerance bands on mem_bytes/disk_total_bytes
 *  (hardware replacement within tolerance is the same host; outside is a
 *  new host → new campaign). */
export function assertFingerprintMatch(
  registered: HostFingerprint,
  live: HostFingerprint,
  tolerances: { mem_tolerance_pct: number; disk_tolerance_pct: number },
): void {
  const mismatches: string[] = [];
  if (registered.cpu_model !== live.cpu_model) {
    mismatches.push(
      `cpu_model registered=${registered.cpu_model} live=${live.cpu_model}`,
    );
  }
  if (registered.cpu_cores !== live.cpu_cores) {
    mismatches.push(
      `cpu_cores registered=${registered.cpu_cores} live=${live.cpu_cores}`,
    );
  }
  const memDriftPct =
    (Math.abs(live.mem_bytes - registered.mem_bytes) / registered.mem_bytes) *
    100;
  if (memDriftPct > tolerances.mem_tolerance_pct) {
    mismatches.push(
      `mem_bytes drift ${memDriftPct.toFixed(1)}% > tolerance ${tolerances.mem_tolerance_pct}% (registered=${registered.mem_bytes} live=${live.mem_bytes})`,
    );
  }
  const diskDriftPct =
    (Math.abs(live.disk_total_bytes - registered.disk_total_bytes) /
      registered.disk_total_bytes) *
    100;
  if (diskDriftPct > tolerances.disk_tolerance_pct) {
    mismatches.push(
      `disk_total_bytes drift ${diskDriftPct.toFixed(1)}% > tolerance ${tolerances.disk_tolerance_pct}% (registered=${registered.disk_total_bytes} live=${live.disk_total_bytes})`,
    );
  }
  if (mismatches.length > 0) {
    throw new PreflightError(
      `host fingerprint mismatch — registered {${registered.cpu_model}, ${registered.cpu_cores}c} vs live {${live.cpu_model}, ${live.cpu_cores}c}: ${mismatches.join('; ')} — v1 host migration is a new campaign (refuse, fail-closed)`,
    );
  }
}
