// The injectable host-stats probe seam (Decision D-3): preflight (task 2),
// registration fingerprint (task 5), and the contention sampler (task 7)
// share this one probe. Also the uniform ms derivation for the Clock seam:
// src/scheduler/clock.ts is SECONDS-based; every D3 millisecond field
// (journal ts_ms, sidecar lines, heartbeats, cooldowns) derives through
// clockNowMs — one Clock named uniformly, never wall-clock reads in tests.
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
