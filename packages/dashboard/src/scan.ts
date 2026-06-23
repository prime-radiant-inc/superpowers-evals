import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Cell,
  cellKey,
  type DashboardVerdict,
  DashboardVerdictSchema,
  type Grid,
  type PhaseIdentity,
  PhaseJsonSchema,
  type RunFinal,
  type RunningRun,
  type RunRecord,
} from './contracts.ts';
import type { GridManifest } from './manifest.ts';

// Read side of the dashboard: scan results/, bucket runs into cells, and resolve
// each cell's window, liveness, and verdicts. The filesystem is the single
// source of truth; the only in-memory state here is the immutable verdict cache.
//
// Identity (scenario, agent, credential, os) is read from the AUTHORITATIVE
// fields a run writes — verdict.json once a run completes, else the in-flight
// phase.json — never parsed out of the run-dir name. A dir whose started_at
// dir-stamp tail is unreadable, or that carries neither a verdict identity nor a
// live-phase identity, is skipped.

// pid liveness via the null-signal probe. process.kill(pid, 0) throws ESRCH when
// the process is gone and EPERM when it exists but is owned by another user
// (alive). Everything else (including an out-of-range pid) is treated as dead.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

// verdict.json is immutable ONCE WRITTEN, so a path-keyed cache of a PRESENT
// verdict never has to invalidate. Absence, however, is transient — a live
// in-flight dir has no verdict yet, and one lands later. So we cache only the
// present parse and re-read on a miss; caching `null` would pin a live dir as
// verdict-less forever and break the running -> done transition the scanner
// drives.
const _verdictCache = new Map<string, DashboardVerdict>();

// Cached (for present verdicts), immutable read of <runDir>/verdict.json narrowed
// to the read-side view. Returns null when the file is missing, unreadable, or
// unparseable — and does NOT cache that null, so a verdict landing later is seen.
export function readDashboardVerdict(runDir: string): DashboardVerdict | null {
  const cached = _verdictCache.get(runDir);
  if (cached !== undefined) {
    return cached;
  }
  const result = parseDashboardVerdict(join(runDir, 'verdict.json'));
  if (result !== null) {
    _verdictCache.set(runDir, result);
  }
  return result;
}

function parseDashboardVerdict(path: string): DashboardVerdict | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = DashboardVerdictSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// A run dir's live phase.json, narrowed, or null when missing/unparseable. A
// phase with no valid pid does not survive the schema, so the caller treats it
// as no-live-phase (abandoned). `identity` is optional on disk; a pre-identity
// phase.json parses but cannot place the run in a cell.
function readPhase(
  runDir: string,
): { phase: string; pid: number; identity?: PhaseIdentity } | null {
  const path = join(runDir, 'phase.json');
  if (!existsSync(path)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = PhaseJsonSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { phase, pid, identity } = parsed.data;
  return identity === undefined ? { phase, pid } : { phase, pid, identity };
}

function finalOf(verdict: DashboardVerdict): RunFinal {
  const final = verdict.final;
  if (final === 'pass' || final === 'fail' || final === 'indeterminate') {
    return final;
  }
  return 'unknown';
}

// The list of run-dir base names under results/ (excluding batches/ and
// non-directories), or [] when results/ is absent.
function listRunDirNames(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) {
    return [];
  }
  const names: string[] = [];
  for (const name of readdirSync(resultsDir)) {
    if (name === 'batches') {
      continue;
    }
    if (!statSync(join(resultsDir, name)).isDirectory()) {
      continue;
    }
    names.push(name);
  }
  return names;
}

// The run-dir-name started_at stamp: the `YYYYMMDDTHHMMSSZ` segment that
// precedes the trailing hex nonce. This is the ONLY thing read positionally from
// a run-dir name — and only for display/sort (age, card timestamp), never for
// identity. Returns null when the tail does not match.
const RUN_DIR_TAIL_RE = /-(\d{8}T\d{6}Z)-[0-9a-f]{4}$/;
function startedAtStamp(name: string): string | null {
  const m = RUN_DIR_TAIL_RE.exec(name);
  return m?.[1] ?? null;
}

// One bucketed run dir: its cell identity plus its display started_at stamp and
// dir name (the sort tiebreaker).
interface ScannedRun {
  readonly name: string;
  readonly scenario: string;
  readonly agent: string;
  readonly credential: string;
  readonly os: string;
  readonly startedAt: string;
}

// Place a run dir into its cell from its authoritative identity. verdict.json
// identity wins; else the in-flight phase.json identity; else null (not
// placeable — skipped). The started_at stamp comes from the dir-name tail (the
// only positional read), so a dir without that tail is also skipped.
function scanRunDir(resultsDir: string, name: string): ScannedRun | null {
  const startedAt = startedAtStamp(name);
  if (startedAt === null) {
    return null;
  }
  const runDir = join(resultsDir, name);
  const verdict = readDashboardVerdict(runDir);
  if (
    verdict?.scenario !== undefined &&
    verdict.coding_agent !== undefined &&
    verdict.os !== undefined
  ) {
    return {
      name,
      scenario: verdict.scenario,
      agent: verdict.coding_agent,
      credential: verdict.credential ?? '',
      os: verdict.os,
      startedAt,
    };
  }
  const phase = readPhase(runDir);
  if (phase?.identity !== undefined) {
    const id = phase.identity;
    return {
      name,
      scenario: id.scenario,
      agent: id.agent,
      credential: id.credential,
      os: id.os,
      startedAt,
    };
  }
  return null;
}

// Enumerate results/, skip batches/, read each run's authoritative identity
// (verdict.json, else in-flight phase.json), bucket by (scenario, agent,
// credential, os), window to the 5 newest by (started_at, dir-name) (newest
// rightmost). For each windowed dir: verdict.json present ⇒ a RunRecord (the
// authority rule — phase.json is then ignored); absent + live pid ⇒ the cell's
// `running` (only the newest live dir wins); absent + dead/no pid ⇒ abandoned
// (excluded).
//
// When `manifest` is null the cell set is exactly the observed runs (a
// results-only board). When a manifest is present, EVERY manifest cell exists in
// the grid — observed runs filled in, and an empty cell for any manifest cell
// with no displayable run, so not_run/ineligible cells render.
export function scanResults(args: {
  resultsDir: string;
  manifest: GridManifest | null;
}): Grid {
  const { resultsDir, manifest } = args;
  const cells = new Map<string, Cell>();

  const buckets = new Map<string, ScannedRun[]>();
  for (const name of listRunDirNames(resultsDir)) {
    const scanned = scanRunDir(resultsDir, name);
    if (scanned === null) {
      continue;
    }
    const key = cellKey(
      scanned.scenario,
      scanned.agent,
      scanned.credential,
      scanned.os,
    );
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [scanned]);
    } else {
      bucket.push(scanned);
    }
  }

  for (const [key, runs] of buckets) {
    runs.sort(compareByStartedAtThenName);
    const windowDirs = runs.slice(-5);
    const records: RunRecord[] = [];
    let running: RunningRun | null = null;
    for (const run of windowDirs) {
      const runDir = join(resultsDir, run.name);
      const verdict = readDashboardVerdict(runDir);
      if (verdict !== null) {
        const economics = verdict.economics ?? null;
        const ca = economics?.coding_agent ?? null;
        records.push({
          run_id: run.name,
          started_at: run.startedAt,
          final: finalOf(verdict),
          cost_usd: ca?.est_cost_usd ?? economics?.total_est_cost_usd ?? null,
          run_total_cost_usd: economics?.total_est_cost_usd ?? null,
          duration_ms: ca?.duration_ms ?? null,
          total_tokens: ca?.tokens?.total ?? null,
          finished_at: verdict.finished_at ?? null,
          error_stage: verdict.error?.stage ?? null,
        });
        continue;
      }
      const phase = readPhase(runDir);
      if (phase !== null && pidAlive(phase.pid)) {
        // Only the newest in-flight dir matters for the cell's running state.
        // The schema guarantees a string phase, so the value is used as-is.
        running = { run_id: run.name, phase: phase.phase };
      }
      // else: abandoned (dead/no pid) -> excluded from display.
    }
    if (records.length === 0 && running === null) {
      continue;
    }
    const first = runs[0];
    if (first === undefined) {
      continue;
    }
    cells.set(key, {
      scenario: first.scenario,
      agent: first.agent,
      credential: first.credential,
      os: first.os,
      window: records,
      running,
    });
  }

  // Manifest overlay: ensure every manifest cell exists (an empty cell where no
  // run was observed), so ineligible / not-yet-run cells still render.
  if (manifest !== null) {
    for (const mc of manifest.cells) {
      const key = cellKey(mc.scenario, mc.agent, mc.credential, mc.os);
      if (!cells.has(key)) {
        cells.set(key, {
          scenario: mc.scenario,
          agent: mc.agent,
          credential: mc.credential,
          os: mc.os,
          window: [],
          running: null,
        });
      }
    }
  }

  return { cells };
}

// Sort by the dir-name started_at stamp, then the full dir name as a stable
// tiebreaker (the trailing nonce makes it total). Both are ascending, so the
// newest run is last.
function compareByStartedAtThenName(a: ScannedRun, b: ScannedRun): number {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  return 0;
}
