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
import type { GridManifest } from './manifest.ts';

// Read side of the dashboard: scan results/, bucket runs into cells, and resolve
// each cell's window, liveness, and verdicts. The filesystem is the single
// source of truth; the only in-memory state here is the immutable verdict cache.

// <scenario>-<agent>-<os>-<timestamp>-<nonce>, e.g. ...-linux-20260527T202301Z-f7fc
const RUN_DIR_RE = /-(\d{8}T\d{6}Z)-([0-9a-f]{4})$/;

// The parsed identity of a run dir: which cell it belongs to plus its sort keys.
export interface ParsedRunDir {
  readonly scenario: string;
  readonly agent: string;
  readonly os: string;
  readonly started_at: string;
  readonly nonce: string;
}

// Parse <scenario>-<agent>-<os>-<timestamp>-<nonce>. Agent is a longest-suffix
// match against knownAgents (so `claude-haiku` beats `haiku`/`claude`). The os
// segment is a single hyphen-free token (e.g. `linux`, `windows`) that is
// stripped before the agent match runs. Returns null for dirs that don't match
// the timestamp/nonce tail, whose agent segment is not a known agent, or whose
// scenario half is empty — callers log + skip those.
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
  // head = "<scenario>-<agent>-<os>" (new format) or "<scenario>-<agent>" (legacy)
  const head = name.slice(0, m.index);
  // Strip the trailing os segment (a single hyphen-free token) before the
  // agent match, so the match always runs on "<scenario>-<agent>".
  const lastHyphen = head.lastIndexOf('-');
  if (lastHyphen === -1) {
    return null;
  }
  const os = head.slice(lastHyphen + 1);
  const agentHead = head.slice(0, lastHyphen); // "<scenario>-<agent>"
  // Longest known agent that is a hyphen-delimited suffix of agentHead wins.
  const candidates = [...knownAgents].sort((a, b) => b.length - a.length);
  for (const agent of candidates) {
    const suffix = `-${agent}`;
    if (agentHead.endsWith(suffix)) {
      const scenario = agentHead.slice(0, agentHead.length - suffix.length);
      if (scenario.length > 0) {
        return { scenario, agent, os, started_at: timestamp, nonce };
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

// Collect the distinct `coding_agent` values across every completed verdict.json
// under results/. The results-only bootstrap: with no known-agent list (no
// manifest), the run-dir parser can't tell where the agent segment ends, so we
// seed the agent set from the verdicts the runs already wrote.
function bootstrapKnownAgents(
  resultsDir: string,
  runDirNames: readonly string[],
): string[] {
  const agents = new Set<string>();
  for (const name of runDirNames) {
    const verdict = readDashboardVerdict(join(resultsDir, name));
    if (verdict?.coding_agent !== undefined) {
      agents.add(verdict.coding_agent);
    }
  }
  return [...agents];
}

// Enumerate results/, skip batches/, bucket by (scenario, agent, os), window to
// the 5 newest by (started_at, nonce) (newest rightmost). For each windowed dir:
// verdict.json present ⇒ a RunRecord (the authority rule — phase.json is then
// ignored); absent + live pid ⇒ the cell's `running` (only the newest live dir
// wins); absent + dead/no pid ⇒ abandoned (excluded).
//
// When `manifest` is null the cell set is exactly the observed runs (a
// results-only board). When a manifest is present, EVERY manifest cell exists in
// the grid — observed runs filled in, and an empty cell for any manifest cell
// with no displayable run, so not_run/ineligible cells render.
export function scanResults(args: {
  resultsDir: string;
  knownAgents: readonly string[];
  manifest: GridManifest | null;
}): Grid {
  const { resultsDir, manifest } = args;
  const cells = new Map<string, Cell>();

  const runDirNames = listRunDirNames(resultsDir);

  // With an empty known-agent list (manifest-null, results-only), seed it from
  // the verdicts so parseRunDirName can split off the agent segment. When a
  // manifest is present its agents are passed in as knownAgents, so this is a
  // no-op for the manifest case.
  const knownAgents =
    args.knownAgents.length > 0
      ? args.knownAgents
      : bootstrapKnownAgents(resultsDir, runDirNames);

  const buckets = new Map<string, ParsedRunDir[]>();
  for (const name of runDirNames) {
    const parsed = parseRunDirName(name, knownAgents);
    if (parsed === null) {
      continue;
    }
    const key = cellKey(parsed.scenario, parsed.agent, parsed.os);
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
      const runId = `${p.scenario}-${p.agent}-${p.os}-${p.started_at}-${p.nonce}`;
      const runDir = join(resultsDir, runId);
      const verdict = readDashboardVerdict(runDir);
      if (verdict !== null) {
        const economics = verdict.economics ?? null;
        const ca = economics?.coding_agent ?? null;
        records.push({
          run_id: runId,
          started_at: p.started_at,
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
      os: first.os,
      window: records,
      running,
    });
  }

  // Manifest overlay: ensure every manifest cell exists (an empty cell where no
  // run was observed), so ineligible / not-yet-run cells still render.
  if (manifest !== null) {
    for (const mc of manifest.cells) {
      const key = cellKey(mc.scenario, mc.agent, mc.os);
      if (!cells.has(key)) {
        cells.set(key, {
          scenario: mc.scenario,
          agent: mc.agent,
          os: mc.os,
          window: [],
          running: null,
        });
      }
    }
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
