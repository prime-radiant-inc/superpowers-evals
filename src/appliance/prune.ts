// Guarded prune for incomplete run dirs. Apply never deletes: candidates are
// renamed into state/quarantine/ for operator inspection. Completed runs
// (verdict.json present) are never candidates — their retention waits for the
// explicit archive/retention contract (2026-08-17 platform spec, fix-now).
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { BatchHeaderSchema, ResultRecordSchema } from '../contracts/batch.ts';
import { ApplianceError } from './errors.ts';
import { readJsonFile } from './fs.ts';
import { isImportStageName } from './import.ts';
import { readAllJobsStrict } from './jobs.ts';
import { acquireLock } from './locks.ts';
import { moveToQuarantine } from './safe-fs.ts';
import type { LoadedApplianceConfig } from './types.ts';

export interface PruneArgs {
  readonly apply: boolean;
  readonly olderThanDays: number;
}

export interface PruneCandidate {
  readonly name: string;
  readonly reason: 'incomplete' | 'stale_stage';
  readonly bytes: number;
  readonly mtime: string;
}

export interface PruneResult {
  readonly dry_run: boolean;
  readonly scanned: number;
  readonly protected: number;
  readonly candidates: readonly PruneCandidate[];
  readonly reclaimable_bytes: number;
  readonly quarantined: readonly {
    readonly name: string;
    readonly to: string;
  }[];
  readonly failures: readonly {
    readonly name: string;
    readonly message: string;
  }[];
}

function pruneFault(message: string): ApplianceError {
  return new ApplianceError('config_invalid', 'prune', message);
}

// lstat that never follows links: absent → undefined; caller decides.
function lstatNoFollow(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

// A reference-metadata file must be exactly a regular, non-symlink file: a
// link would read content from outside the namespace under this file's name.
function requireRegularFile(path: string, label: string): void {
  const stats = lstatNoFollow(path);
  if (stats === undefined) {
    throw pruneFault(`${label} is missing: ${path}; repair it manually`);
  }
  if (!stats.isFile()) {
    throw pruneFault(
      `${label} is not a regular file (symlink?): ${path}; repair it manually`,
    );
  }
}

// Everything that can legally point at a run dir: batch cell records and
// appliance job artifacts. (verdict.json, capture sidecars, provenance live
// INSIDE the run dir and move with it; grid-manifest references cells, not
// runs.) Reference metadata that cannot be read proves nothing about what it
// references, so it fails closed as config_invalid — a malformed record must
// never make a run eligible. Every batch dir must carry a canonical
// batch.json AND a regular results.jsonl of canonical ResultRecord rows
// (empty = zero rows; absence is stale/crashed state, not a live batch —
// apply re-plans under run.lock). Job records go through the same strict
// integrity-boundary reader as the exact lookups.
export function collectReferencedRunIds(
  loaded: LoadedApplianceConfig,
): Set<string> {
  const refs = new Set<string>();
  const resultsRoot = loaded.config.container.results_root;
  const batches = join(resultsRoot, 'batches');
  const batchesStats = lstatNoFollow(batches);
  if (batchesStats !== undefined) {
    if (!batchesStats.isDirectory()) {
      throw pruneFault(
        `batches must be a real directory (not a symlink): ${batches}; repair it manually`,
      );
    }
    for (const entry of readdirSync(batches, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw pruneFault(
          `batches entry ${entry.name} is a symlink; repair it manually`,
        );
      }
      if (!entry.isDirectory()) {
        throw pruneFault(
          `batches entry ${entry.name} is not a batch directory; repair it manually`,
        );
      }
      const batchDir = join(batches, entry.name);
      const headerPath = join(batchDir, 'batch.json');
      requireRegularFile(headerPath, `batch ${entry.name} batch.json`);
      try {
        readJsonFile(
          headerPath,
          BatchHeaderSchema,
          `batch header ${headerPath}`,
        );
      } catch (error) {
        throw pruneFault(
          error instanceof Error ? error.message : String(error),
        );
      }
      const jsonl = join(batchDir, 'results.jsonl');
      // Every batch dir must carry its record file: apply re-plans under
      // run.lock, so no live batch can be racing its first append — absence
      // means stale/crashed/ambiguous state. An empty regular file is a
      // valid zero-row record.
      requireRegularFile(jsonl, `batch ${entry.name} results.jsonl`);
      for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(s);
        } catch (error) {
          throw pruneFault(
            `${jsonl}: unparseable record — cannot prove which runs are referenced; repair the batch record manually (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        const parsed = ResultRecordSchema.safeParse(raw);
        if (!parsed.success) {
          throw pruneFault(
            `${jsonl}: non-canonical result record — cannot prove which runs are referenced; repair the batch record manually`,
          );
        }
        if (parsed.data.run_id !== null) {
          refs.add(parsed.data.run_id);
        }
      }
    }
  }
  for (const job of readAllJobsStrict(loaded)) {
    if (job.artifacts.run_id !== null) refs.add(job.artifacts.run_id);
  }
  return refs;
}

// Fail-closed campaign guard: campaigns don't exist in code yet, so instead of
// parsing a format that would drift, substring-scan every file under
// <evals.path>/campaigns/ (when it exists) for each candidate name. A hit
// protects the run regardless of how the kernel ends up storing references.
// The scan itself is a strict boundary: the root, every directory, and every
// file must be real (no symlinks, no fifos/sockets/devices) and readable —
// an entry the scan cannot honestly read could be hiding a reference, so it
// fails closed rather than being skipped.
export function collectCampaignProtected(
  loaded: LoadedApplianceConfig,
  names: readonly string[],
): Set<string> {
  const protectedNames = new Set<string>();
  const campaignsRoot = join(loaded.config.evals.path, 'campaigns');
  let rootStats: ReturnType<typeof lstatNoFollow>;
  try {
    rootStats = lstatNoFollow(campaignsRoot);
  } catch (error) {
    throw pruneFault(
      `campaigns root unreadable: ${campaignsRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (rootStats === undefined) return protectedNames;
  if (!rootStats.isDirectory()) {
    throw pruneFault(
      `campaigns must be a real directory (not a symlink): ${campaignsRoot}; repair it manually`,
    );
  }
  if (names.length === 0) return protectedNames;
  const texts: string[] = [];
  const readCampaignDir = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw pruneFault(
        `campaigns directory unreadable: ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const visit = (dir: string): void => {
    for (const entry of readCampaignDir(dir)) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw pruneFault(
          `campaigns entry is a symlink: ${p}; repair it manually`,
        );
      }
      if (entry.isDirectory()) {
        visit(p);
      } else if (entry.isFile()) {
        try {
          texts.push(readFileSync(p, 'utf8'));
        } catch (error) {
          throw pruneFault(
            `campaigns file unreadable: ${p}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        throw pruneFault(
          `campaigns entry is not a regular file or directory: ${p}; repair it manually`,
        );
      }
    }
  };
  visit(campaignsRoot);
  for (const name of names) {
    if (texts.some((t) => t.includes(name))) protectedNames.add(name);
  }
  return protectedNames;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) total += statSync(p).size;
    }
  };
  visit(dir);
  return total;
}

export function planPrune(
  loaded: LoadedApplianceConfig,
  olderThanDays: number,
): PruneResult {
  // Independent of any CLI validation: a non-positive, fractional, or NaN
  // floor would erase the eligibility floor (NaN makes every mtime pass).
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays <= 0) {
    throw pruneFault(
      `age floor must be a positive integer number of days, got: ${olderThanDays}`,
    );
  }
  const resultsRoot = loaded.config.container.results_root;
  // The results root is where candidates are enumerated and renamed from; a
  // symlinked root would pass assertInsideRoot's realpath check and let apply
  // move directories that live OUTSIDE the appliance's results volume.
  const rootStats = lstatNoFollow(resultsRoot);
  if (rootStats === undefined || !rootStats.isDirectory()) {
    throw pruneFault(
      `results_root must be a real directory (not a symlink): ${resultsRoot}`,
    );
  }
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const refs = collectReferencedRunIds(loaded);
  const candidates: PruneCandidate[] = [];
  let scanned = 0;

  const names: string[] = [];
  const entries: {
    name: string;
    path: string;
    reason: 'incomplete' | 'stale_stage';
  }[] = [];
  for (const entry of readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'batches') continue;
    scanned += 1;
    const p = join(resultsRoot, entry.name);
    const stat = statSync(p);
    if (stat.mtimeMs >= cutoff) continue;
    // Only a stage slot import could actually have created (safe run-id,
    // canonical pid) counts as a stage; a near-miss is an ordinary run dir
    // with every ordinary protection (verdict, references, campaigns). Both
    // classes stay excluded when batch/job records reference them by name.
    if (isImportStageName(entry.name)) {
      if (!refs.has(entry.name)) {
        entries.push({ name: entry.name, path: p, reason: 'stale_stage' });
      }
    } else if (!existsSync(join(p, 'verdict.json')) && !refs.has(entry.name)) {
      entries.push({ name: entry.name, path: p, reason: 'incomplete' });
    }
    names.push(entry.name);
  }

  const campaignProtected = collectCampaignProtected(loaded, names);
  for (const e of entries) {
    if (campaignProtected.has(e.name)) continue;
    candidates.push({
      name: e.name,
      reason: e.reason,
      bytes: dirSizeBytes(e.path),
      mtime: statSync(e.path).mtime.toISOString(),
    });
  }

  return {
    dry_run: true,
    scanned,
    protected: scanned - candidates.length,
    candidates,
    reclaimable_bytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
    quarantined: [],
    failures: [],
  };
}

export function prune(
  loaded: LoadedApplianceConfig,
  args: PruneArgs,
): PruneResult {
  if (!args.apply) {
    // Read-only report; lockless by design (the age floor is the conservative
    // guard against in-flight runs, which hold no artifacts yet).
    return planPrune(loaded, args.olderThanDays);
  }
  // Apply mutates the results root, so it serializes with imports and live
  // batches exactly the way import does — and re-plans under the lock.
  const lock = acquireLock({
    loaded,
    name: 'run.lock',
    jobId: `prune-${Date.now().toString(36)}`,
    command: 'prune',
  });
  try {
    const plan = planPrune(loaded, args.olderThanDays);
    const quarantined: { name: string; to: string }[] = [];
    const failures: { name: string; message: string }[] = [];
    for (const c of plan.candidates) {
      try {
        const to = moveToQuarantine(
          loaded,
          join(loaded.config.container.results_root, c.name),
          `prune-${c.name}`,
        );
        quarantined.push({ name: c.name, to });
      } catch (error) {
        failures.push({
          name: c.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ...plan, dry_run: false, quarantined, failures };
  } finally {
    lock.release();
  }
}
