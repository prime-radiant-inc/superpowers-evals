import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Cell,
  cellKey,
  type DashboardVerdict,
  DashboardVerdictSchema,
  type Grid,
  PhaseJsonSchema,
  type RunFinal,
  type RunningRun,
  type RunRecord,
} from './contracts.ts';

// Read side of the dashboard: scan results/, bucket runs into cells, and resolve
// each cell's window, liveness, and verdicts. The filesystem is the single
// source of truth; the only in-memory state here is the immutable verdict cache.
//
// Parity reference: .worktrees/dashboard-ref/quorum/dashboard/data.py.

// <scenario>-<agent>-<timestamp>-<nonce>, e.g. ...-20260527T202301Z-f7fc
const RUN_DIR_RE = /-(\d{8}T\d{6}Z)-([0-9a-f]{4})$/;

// The parsed identity of a run dir: which cell it belongs to plus its sort keys.
export interface ParsedRunDir {
  readonly scenario: string;
  readonly agent: string;
  readonly started_at: string;
  readonly nonce: string;
}

// Parse <scenario>-<agent>-<timestamp>-<nonce>. Agent is a longest-suffix match
// against knownAgents (so `claude-haiku` beats `haiku`/`claude`). Returns null
// for dirs that don't match the timestamp/nonce tail, whose agent segment is not
// a known agent, or whose scenario half is empty — callers log + skip those.
export function parseRunDirName(
  name: string,
  knownAgents: readonly string[],
): ParsedRunDir | null {
  const m = RUN_DIR_RE.exec(name);
  if (m === null) {
    return null;
  }
  const timestamp = m[1];
  const nonce = m[2];
  if (timestamp === undefined || nonce === undefined) {
    return null;
  }
  const head = name.slice(0, m.index); // "<scenario>-<agent>"
  // Longest known agent that is a hyphen-delimited suffix of head wins.
  const candidates = [...knownAgents].sort((a, b) => b.length - a.length);
  for (const agent of candidates) {
    const suffix = `-${agent}`;
    if (head.endsWith(suffix)) {
      const scenario = head.slice(0, head.length - suffix.length);
      if (scenario.length > 0) {
        return { scenario, agent, started_at: timestamp, nonce };
      }
    }
  }
  return null;
}

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
// drives (parity with the Python's uncached _read_json, but keeping the
// immutable-hit fast path).
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
// as no-live-phase (abandoned).
function readPhase(runDir: string): { phase: string; pid: number } | null {
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
  return parsed.success
    ? { phase: parsed.data.phase, pid: parsed.data.pid }
    : null;
}

function finalOf(verdict: DashboardVerdict): RunFinal {
  const final = verdict.final;
  if (final === 'pass' || final === 'fail' || final === 'indeterminate') {
    return final;
  }
  return 'unknown';
}

// Enumerate results/, skip batches/, bucket by (scenario, agent), window to the
// 5 newest by (started_at, nonce) (newest rightmost). For each windowed dir:
// verdict.json present ⇒ a RunRecord (the authority rule — phase.json is then
// ignored); absent + live pid ⇒ the cell's `running` (only the newest live dir
// wins); absent + dead/no pid ⇒ abandoned (excluded). Cells with no displayable
// run are omitted from the Grid.
export function scanResults(
  resultsRoot: string,
  knownAgents: readonly string[],
): Grid {
  const cells = new Map<string, Cell>();
  if (!existsSync(resultsRoot)) {
    return { cells };
  }

  const buckets = new Map<string, ParsedRunDir[]>();
  for (const name of readdirSync(resultsRoot)) {
    if (name === 'batches') {
      continue;
    }
    if (!statSync(join(resultsRoot, name)).isDirectory()) {
      continue;
    }
    const parsed = parseRunDirName(name, knownAgents);
    if (parsed === null) {
      continue;
    }
    const key = cellKey(parsed.scenario, parsed.agent);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [parsed]);
    } else {
      bucket.push(parsed);
    }
  }

  for (const [key, parsedList] of buckets) {
    parsedList.sort(comparePerStartedAtNonce);
    const windowDirs = parsedList.slice(-5);
    const records: RunRecord[] = [];
    let running: RunningRun | null = null;
    for (const p of windowDirs) {
      const runId = `${p.scenario}-${p.agent}-${p.started_at}-${p.nonce}`;
      const runDir = join(resultsRoot, runId);
      const verdict = readDashboardVerdict(runDir);
      if (verdict !== null) {
        const economics = verdict.economics ?? null;
        records.push({
          run_id: runId,
          started_at: p.started_at,
          final: finalOf(verdict),
          cost_usd: economics?.total_est_cost_usd ?? null,
          finished_at: verdict.finished_at ?? null,
        });
        continue;
      }
      const phase = readPhase(runDir);
      if (phase !== null && pidAlive(phase.pid)) {
        // Only the newest in-flight dir matters for the cell's running state.
        // The schema guarantees a string phase, so the data.py `.get(...,
        // "setup")` default never fires here — the value is used verbatim.
        running = { run_id: runId, phase: phase.phase };
      }
      // else: abandoned (dead/no pid) -> excluded from display.
    }
    if (records.length === 0 && running === null) {
      continue;
    }
    const first = parsedList[0];
    if (first === undefined) {
      continue;
    }
    cells.set(key, {
      scenario: first.scenario,
      agent: first.agent,
      window: records,
      running,
      queued: false,
    });
  }
  return { cells };
}

function comparePerStartedAtNonce(a: ParsedRunDir, b: ParsedRunDir): number {
  if (a.started_at !== b.started_at) {
    return a.started_at < b.started_at ? -1 : 1;
  }
  if (a.nonce !== b.nonce) {
    return a.nonce < b.nonce ? -1 : 1;
  }
  return 0;
}
