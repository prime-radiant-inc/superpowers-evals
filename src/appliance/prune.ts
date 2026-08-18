// Guarded prune for incomplete run dirs. Apply never deletes: candidates are
// renamed into state/quarantine/ for operator inspection. Completed runs
// (verdict.json present) are never candidates — their retention waits for the
// explicit archive/retention contract (2026-08-17 platform spec, fix-now).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ApplianceError } from './errors.ts';
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

const BatchResultLineSchema = z
  .object({ run_id: z.string().nullable() })
  .passthrough();

// Everything that can legally point at a run dir: batch cell records and
// appliance job artifacts. (verdict.json, capture sidecars, provenance live
// INSIDE the run dir and move with it; grid-manifest references cells, not
// runs.) Reference metadata that cannot be read proves nothing about what it
// references, so it fails closed as config_invalid — a malformed record must
// never make a run eligible. Job records go through the same strict
// integrity-boundary reader as the exact lookups.
export function collectReferencedRunIds(
  loaded: LoadedApplianceConfig,
): Set<string> {
  const refs = new Set<string>();
  const resultsRoot = loaded.config.container.results_root;
  const batches = join(resultsRoot, 'batches');
  if (existsSync(batches)) {
    for (const entry of readdirSync(batches, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new ApplianceError(
          'config_invalid',
          'prune',
          `batches entry ${entry.name} is a symlink; repair it manually`,
        );
      }
      if (!entry.isDirectory()) continue;
      const jsonl = join(batches, entry.name, 'results.jsonl');
      if (!existsSync(jsonl)) continue;
      for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(s);
        } catch (error) {
          throw new ApplianceError(
            'config_invalid',
            'prune',
            `${jsonl}: unparseable record — cannot prove which runs are referenced; repair the batch record manually (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        const parsed = BatchResultLineSchema.safeParse(raw);
        if (!parsed.success) {
          throw new ApplianceError(
            'config_invalid',
            'prune',
            `${jsonl}: record without a readable run_id — cannot prove which runs are referenced; repair the batch record manually`,
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
export function collectCampaignProtected(
  loaded: LoadedApplianceConfig,
  names: readonly string[],
): Set<string> {
  const protectedNames = new Set<string>();
  const campaignsRoot = join(loaded.config.evals.path, 'campaigns');
  if (names.length === 0 || !existsSync(campaignsRoot)) return protectedNames;
  const texts: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) texts.push(readFileSync(p, 'utf8'));
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
  const resultsRoot = loaded.config.container.results_root;
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
    if (entry.name.startsWith('.importing-')) {
      entries.push({ name: entry.name, path: p, reason: 'stale_stage' });
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
