// The injectable host-stats probe seam (Decision D-3): preflight (task 2),
// registration fingerprint (task 5), and the contention sampler (task 7)
// share this one probe. Also the uniform ms derivation for the Clock seam:
// src/scheduler/clock.ts is SECONDS-based; every D3 millisecond field
// (journal ts_ms, sidecar lines, heartbeats, cooldowns) derives through
// clockNowMs — one Clock named uniformly, never wall-clock reads in tests.
//
// The production probe is split into a PURE translation layer (parseMeminfo,
// parsePidMax, hostStatsFromRaw, fingerprintFromStats — fixture-testable on
// any platform) over which the Linux reader composes the real OS reads.
// Every required OS datum is fail-closed: a missing /proc field or an
// unavailable CPU identity refuses, never degrades to a plausible value.
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
  /** The host's real PID ceiling (/proc/sys/kernel/pid_max on Linux). PID
   *  headroom is judged against THIS, never an invented constant. */
  readonly pid_max: number;
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

/** /proc/meminfo translation (pure, fixture-testable). SwapTotal/SwapFree
 *  must be present and parse — a swapless host writes `SwapTotal: 0 kB`,
 *  which is valid; a MISSING or malformed field refuses (fail-closed, never
 *  a silent 0). */
export function parseMeminfo(text: string): {
  readonly swap_total_bytes: number;
  readonly swap_free_bytes: number;
} {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
    return m === null ? null : Number(m[1]);
  };
  const swapTotalKb = kb('SwapTotal');
  const swapFreeKb = kb('SwapFree');
  if (swapTotalKb === null || swapFreeKb === null) {
    throw new PreflightError(
      `/proc/meminfo does not parse SwapTotal/SwapFree — missing swap data never becomes a silent 0 (fail-closed); got: ${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  return {
    swap_total_bytes: swapTotalKb * 1024,
    swap_free_bytes: swapFreeKb * 1024,
  };
}

/** /proc/sys/kernel/pid_max translation (pure): exactly one positive
 *  integer. The host's real PID ceiling — garbage, empty, zero, or negative
 *  refuses (fail-closed), because headroom cannot be judged without it. */
export function parsePidMax(text: string): number {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new PreflightError(
      `pid_max does not parse as one positive integer (${JSON.stringify(text.slice(0, 40))}) — PID headroom cannot be judged; refusing (fail-closed)`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PreflightError(
      `pid_max ${trimmed} is not a usable PID ceiling — refusing (fail-closed)`,
    );
  }
  return value;
}

/** The /proc directory listing → live process count: numeric entries only. */
function countPidEntries(entries: readonly string[]): number {
  return entries.filter((n) => /^[0-9]+$/.test(n)).length;
}

/** Raw OS inputs for one host sample. `fs` is the statfs shape of the
 *  campaign/results volume; `proc_entries` is a /proc listing. */
export interface RawHostSampleInputs {
  readonly load1: number;
  readonly mem_available_bytes: number;
  readonly mem_total_bytes: number;
  readonly meminfo_text: string;
  readonly pid_max_text: string;
  readonly proc_entries: readonly string[];
  readonly fs: {
    readonly bavail: number;
    readonly bsize: number;
    readonly blocks: number;
  };
}

/** Pure assembly of a HostStats sample from raw OS reads (fixture-testable):
 *  swap math (used clamped at 0), process count, the host PID ceiling, and
 *  the statfs disk math. Propagates parseMeminfo/parsePidMax refusals. */
export function hostStatsFromRaw(
  nowMs: number,
  raw: RawHostSampleInputs,
): HostStats {
  const swap = parseMeminfo(raw.meminfo_text);
  return {
    ts_ms: nowMs,
    load1: raw.load1,
    mem_available_bytes: raw.mem_available_bytes,
    mem_total_bytes: raw.mem_total_bytes,
    swap_used_bytes: Math.max(0, swap.swap_total_bytes - swap.swap_free_bytes),
    swap_total_bytes: swap.swap_total_bytes,
    process_count: countPidEntries(raw.proc_entries),
    pid_max: parsePidMax(raw.pid_max_text),
    disk_free_bytes: raw.fs.bavail * raw.fs.bsize,
    disk_total_bytes: raw.fs.blocks * raw.fs.bsize,
  };
}

/** R-LCK-3 platform gate (pure): the v1 designated host is the Linux
 *  appliance; every other platform refuses (workstation use of the blessed
 *  bundle is forbidden by policy). Takes the platform as a parameter so the
 *  refusal is deterministic and testable on every host — the probe passes
 *  its own platform, production passes process.platform. */
export function assertLinuxDesignatedHost(platform: string): void {
  if (platform !== 'linux') {
    throw new PreflightError(
      `host stats probe requires the Linux appliance (got ${platform}) — portable tests inject a fake probe`,
    );
  }
}

/** Production probe (Decision D-3 metric sources): load1 via os.loadavg();
 *  memory via os.freemem/totalmem; swap + process count + the PID ceiling
 *  via /proc (Linux); disk via statfs on the campaign/results volume. The
 *  reads compose the pure translation layer above. The v1 designated host is
 *  the Linux appliance — other platforms fail closed via
 *  assertLinuxDesignatedHost; `platform` is injectable so that refusal is
 *  testable everywhere (production callers pass only the disk path). */
export function linuxHostStatsProbe(
  diskPath: string,
  platform: string = process.platform,
): HostStatsProbe {
  return {
    sample(nowMs: number): HostStats {
      assertLinuxDesignatedHost(platform);
      return hostStatsFromRaw(nowMs, {
        load1: loadavg()[0] ?? 0,
        mem_available_bytes: freemem(),
        mem_total_bytes: totalmem(),
        meminfo_text: readFileSync('/proc/meminfo', 'utf8'),
        pid_max_text: readFileSync('/proc/sys/kernel/pid_max', 'utf8'),
        proc_entries: readdirSync('/proc'),
        fs: statfsSync(diskPath),
      });
    },
  };
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

/** Resource-floor preflight (R-LCK-2) — the ADMISSION step, standalone by
 *  design: spender verbs (`campaign run`, `run-all`, direct `quorum run`)
 *  call it AFTER acquiring the live-spend lock and killing/reconciling
 *  orphan spenders, per the spec's pinned recovery ordering (REV sol #8c:
 *  acquire lock → kill/reconcile → preflight → admit). Preflight failure
 *  refuses admission (fail-closed) but must NEVER block the lock itself or
 *  orphan cleanup — which is why this lives OUTSIDE acquireLiveSpendLock.
 *  Refuses when free disk, available memory, or PID headroom beneath the
 *  host's REAL pid_max (read through the probe) falls below the floors. An
 *  unusable ceiling fails closed — headroom is never judged against an
 *  invented constant. */
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
  if (!Number.isSafeInteger(stats.pid_max) || stats.pid_max <= 0) {
    violations.push(
      `pid_max ${stats.pid_max} is not a usable PID ceiling — the host PID limit is unreadable (fail-closed)`,
    );
  } else if (stats.process_count > stats.pid_max - floors.process_headroom) {
    violations.push(
      `process count ${stats.process_count} leaves < ${floors.process_headroom} PID headroom beneath pid_max ${stats.pid_max}`,
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

/** Fingerprint construction (pure): mem/disk from the probe sample, CPU
 *  identity supplied by the caller. An empty/whitespace CPU model or a
 *  non-positive core count refuses — an unidentified host is never
 *  fingerprinted as "unknown" (fail-closed). */
export function fingerprintFromStats(
  stats: HostStats,
  cpuModel: string,
  cpuCount: number,
): HostFingerprint {
  if (
    cpuModel.trim() === '' ||
    !Number.isSafeInteger(cpuCount) ||
    cpuCount < 1
  ) {
    throw new PreflightError(
      `host CPU identity unavailable (model=${JSON.stringify(cpuModel)}, cores=${cpuCount}) — refusing to fingerprint an unidentified host (fail-closed)`,
    );
  }
  return {
    cpu_model: cpuModel,
    cpu_cores: cpuCount,
    mem_bytes: stats.mem_total_bytes,
    disk_total_bytes: stats.disk_total_bytes,
  };
}

export function probeFingerprint(
  probe: HostStatsProbe,
  nowMs: number,
): HostFingerprint {
  const stats = probe.sample(nowMs);
  const cpu = cpus();
  // An absent CPU entry flows into fingerprintFromStats's refusal — never a
  // placeholder model string.
  return fingerprintFromStats(stats, cpu[0]?.model ?? '', cpu.length);
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
