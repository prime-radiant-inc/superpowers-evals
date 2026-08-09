import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { BundleManifest } from '../export-runs/manifest.ts';
import { BundleManifestSchema, denylistHit } from '../export-runs/manifest.ts';
import { ApplianceError } from './errors.ts';
import { atomicWriteJson } from './fs.ts';
import { createJob, readJob, updateJob } from './jobs.ts';
import { acquireLock } from './locks.ts';
import { provenancePath } from './provenance.ts';
import {
  ImportedProvenanceRecordSchema,
  type JobRecord,
  type LoadedApplianceConfig,
  type Origin,
} from './types.ts';

export interface ImportArgs {
  readonly bundleDir: string;
  readonly force: boolean;
}

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly run_ids: readonly string[];
}

function readManifest(bundleDir: string): BundleManifest {
  const path = join(bundleDir, 'manifest.json');
  if (!existsSync(path)) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `bundle has no manifest.json: ${bundleDir}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `bundle manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = BundleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `bundle manifest is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

// Walk what is actually on disk, not just what the manifest lists: a bundle
// that smuggles an unlisted secret must be caught too.
function allBundleFiles(runDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        out.push(relative(runDir, path));
      }
    }
  };
  if (existsSync(runDir)) {
    visit(runDir);
  }
  return out;
}

// Validation runs over the whole bundle before a single run lands, so a bad
// bundle leaves the results root untouched rather than half-populated.
function validateBundle(bundleDir: string, manifest: BundleManifest): void {
  for (const entry of manifest.entries) {
    const runDir = join(bundleDir, 'runs', entry.run_id);
    if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
      throw new ApplianceError(
        'artifact_missing',
        'import',
        `manifest lists ${entry.run_id} but the bundle has no payload for it`,
      );
    }

    for (const rel of allBundleFiles(runDir)) {
      const hit = denylistHit(rel);
      if (hit !== null) {
        throw new ApplianceError(
          'config_invalid',
          'import',
          `refusing bundle: ${entry.run_id}/${rel} matches credential pattern ${hit}`,
        );
      }
    }

    for (const [rel, expected] of Object.entries(entry.files)) {
      const path = join(runDir, rel);
      if (!existsSync(path)) {
        throw new ApplianceError(
          'artifact_missing',
          'import',
          `${entry.run_id}: manifest lists ${rel} but it is not in the bundle`,
        );
      }
      const actual = Bun.SHA256.hash(readFileSync(path), 'hex');
      if (actual !== expected) {
        throw new ApplianceError(
          'artifact_missing',
          'import',
          `${entry.run_id}: checksum mismatch for ${rel}`,
        );
      }
    }
  }
}

// An imported run already has a job when a previous import landed it; readJob
// resolves by run_id, so absence is the only signal we need.
function alreadyImported(
  loaded: LoadedApplianceConfig,
  runId: string,
): boolean {
  try {
    readJob(loaded, runId);
    return true;
  } catch {
    return false;
  }
}

function writeImportedProvenance(
  loaded: LoadedApplianceConfig,
  job: JobRecord,
  origin: Origin,
  runDir: string,
): string {
  const record = ImportedProvenanceRecordSchema.parse({
    schema_version: 1,
    kind: 'imported',
    job_id: job.job_id,
    created_at: origin.imported_at,
    origin,
    requester: job.requester,
    command_argv: [...job.command.argv],
  });
  const path = provenancePath(loaded, job.job_id);
  atomicWriteJson(path, record);
  atomicWriteJson(join(runDir, 'appliance-provenance.json'), record);
  return path;
}

export function importBundle(
  loaded: LoadedApplianceConfig,
  args: ImportArgs,
): ImportResult {
  // Import writes into the results root, so it must not interleave with a live
  // batch writing there. Held for the whole import, including validation, so a
  // job cannot start against a half-landed corpus.
  const lock = acquireLock({
    loaded,
    name: 'run.lock',
    jobId: `import-${Date.now().toString(36)}`,
    command: 'import',
  });
  try {
    return importLocked(loaded, args);
  } finally {
    lock.release();
  }
}

function importLocked(
  loaded: LoadedApplianceConfig,
  args: ImportArgs,
): ImportResult {
  const manifest = readManifest(args.bundleDir);
  validateBundle(args.bundleDir, manifest);

  const resultsRoot = loaded.config.container.results_root;
  const importedAt = new Date().toISOString();
  const runIds: string[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of manifest.entries) {
    const destRun = join(resultsRoot, entry.run_id);
    if (alreadyImported(loaded, entry.run_id) && !args.force) {
      skipped += 1;
      continue;
    }

    try {
      // Land the payload first: a job record pointing at a missing run dir is
      // worse than a run dir with no job, which the next import repairs.
      rmSync(destRun, { recursive: true, force: true });
      cpSync(join(args.bundleDir, 'runs', entry.run_id), destRun, {
        recursive: true,
      });

      const origin: Origin = {
        kind: 'imported',
        imported_at: importedAt,
        source_host: manifest.source_host,
        source_path: entry.source_path,
        superpowers_sha: entry.superpowers_sha,
        superpowers_tree_sha: entry.superpowers_tree_sha,
        inferred_superpowers_sha: entry.inferred_superpowers_sha,
        rev_recovery: entry.rev_recovery,
        harness_rev: entry.harness_rev,
        scenario: entry.scenario,
        coding_agent: entry.coding_agent,
        credential: entry.credential,
      };

      const created = createJob(loaded, {
        kind: 'import',
        // An imported run's ref is whatever we could establish about it, which
        // origin carries; the request field records the same for readability.
        superpowersRef: entry.superpowers_sha ?? 'unknown',
        argv: ['evals-appliance', 'import', entry.run_id],
        requester: { agent: null, thread: null, task: null },
      });

      const job = updateJob(loaded, created.job_id, (current) => ({
        ...current,
        status: 'done' as const,
        started_at: entry.started_at,
        finished_at: entry.finished_at,
        origin,
        artifacts: { ...current.artifacts, run_id: entry.run_id },
        result: {
          exit_code: entry.final === 'pass' ? 0 : 1,
          summary: `imported ${entry.final} run ${entry.run_id}`,
        },
      }));

      writeImportedProvenance(loaded, job, origin, destRun);
      runIds.push(entry.run_id);
      imported += 1;
    } catch {
      failed += 1;
    }
  }

  return { imported, skipped, failed, run_ids: runIds };
}
