import {
  cpSync,
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { BundleManifest } from '../export-runs/manifest.ts';
import { BundleManifestSchema, denylistHit } from '../export-runs/manifest.ts';
import { ApplianceError, type ApplianceErrorCode } from './errors.ts';
import { atomicWriteJson } from './fs.ts';
import { createJob, readJobById, readJobByRunId, updateJob } from './jobs.ts';
import { acquireLock } from './locks.ts';
import { provenancePath } from './provenance.ts';
import {
  assertApplianceNamespaces,
  dirsEquivalent,
  moveToQuarantine,
} from './safe-fs.ts';
import {
  ImportedProvenanceRecordSchema,
  type JobRecord,
  type LoadedApplianceStateConfig,
  type Origin,
} from './types.ts';

export interface ImportArgs {
  readonly bundleDir: string;
}

export interface ImportFailure {
  readonly run_id: string;
  readonly code: ApplianceErrorCode | 'unknown';
  readonly message: string;
}

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly healed: number;
  readonly failed: number;
  readonly failures: readonly ImportFailure[];
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

function payloadFault(message: string): ApplianceError {
  return new ApplianceError('config_invalid', 'import', message);
}

// Strict no-follow walk of a payload tree: the root and every nested
// directory must be real directories, every leaf a regular file. Symlinks,
// fifos, sockets, devices, and unreadable structure are config faults —
// nothing is silently ignored. Returns every regular file's relative path,
// so callers can also require the tree to be exactly what a manifest lists.
function walkRealTree(root: string, label: string): Set<string> {
  const rootStats = lstatSync(root, { throwIfNoEntry: false });
  if (rootStats === undefined) {
    throw payloadFault(`${label} does not exist: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw payloadFault(
      `${label} must be a real directory (not a symlink): ${root}`,
    );
  }
  const out = new Set<string>();
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw payloadFault(
        `${label} is unreadable at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw payloadFault(
          `${label} contains a symlink: ${relative(root, path)}`,
        );
      }
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        out.add(relative(root, path));
      } else {
        throw payloadFault(
          `${label} contains a non-regular entry: ${relative(root, path)}`,
        );
      }
    }
  };
  visit(root);
  return out;
}

// The bundle root is operator input: it must be exactly a real directory
// before anything inside it is trusted or even read.
function assertBundleRoot(bundleDir: string): void {
  const stats = lstatSync(bundleDir, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw payloadFault(`bundle directory does not exist: ${bundleDir}`);
  }
  if (!stats.isDirectory()) {
    throw payloadFault(
      `bundle root must be a real directory (not a symlink): ${bundleDir}`,
    );
  }
}

// Manifest paths share one grammar: nonempty, relative, '/'-separated, no
// empty/./.. segments, no backslashes. Each names a regular file strictly
// inside its run root; nothing here may resolve outside it.
function assertSafeManifestPath(runId: string, rel: string): void {
  const unsafe =
    rel === '' ||
    rel.includes('\\') ||
    rel.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (unsafe) {
    throw payloadFault(`${runId}: unsafe manifest path ${JSON.stringify(rel)}`);
  }
}

// Validation runs over the whole bundle before a single run lands, so a bad
// bundle leaves the results root untouched rather than half-populated.
const RUN_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The complete run-id validity contract: the manifest alphabet plus the `..`
// exclusion (a run_id becomes a path component under the results root).
// validateBundle enforces it on every entry; the stage-name predicate below
// reuses it so nothing looser can pass for a name import created.
export function isSafeRunId(runId: string): boolean {
  return RUN_ID_SAFE.test(runId) && !runId.includes('..');
}

// Recognize exactly a stage slot this command could have created:
// `.importing-<run-id>.<pid>.tmp` where the run-id passes isSafeRunId and the
// pid text is a canonical positive decimal — process.pid never renders as 0
// or with a leading zero. The pid segment is the final all-digits component,
// so dotted run-ids parse unambiguously. Prune recognizes stale stages by
// this and nothing looser: any near-miss is an ordinary run dir with every
// ordinary run protection.
const STAGE_NAME_PARSE = /^\.importing-(.+)\.([0-9]+)\.tmp$/;
const CANONICAL_PID = /^[1-9][0-9]*$/;

export function isImportStageName(name: string): boolean {
  const match = STAGE_NAME_PARSE.exec(name);
  const runId = match?.[1];
  const pidText = match?.[2];
  if (runId === undefined || pidText === undefined) {
    return false;
  }
  return isSafeRunId(runId) && CANONICAL_PID.test(pidText);
}

function validateBundle(bundleDir: string, manifest: BundleManifest): void {
  const runsRoot = join(bundleDir, 'runs');
  const runsStats = lstatSync(runsRoot, { throwIfNoEntry: false });
  if (runsStats !== undefined && !runsStats.isDirectory()) {
    throw payloadFault(
      `bundle runs/ must be a real directory (not a symlink): ${runsRoot}`,
    );
  }
  for (const entry of manifest.entries) {
    // Safety first: the run_id becomes a path component under the results
    // root, so traversal is a config fault, never an artifact probe.
    if (!isSafeRunId(entry.run_id)) {
      throw payloadFault(
        `unsafe run_id in manifest: ${JSON.stringify(entry.run_id)}`,
      );
    }
    // The batches namespace is reserved: 'batches' is the batch index dir
    // itself, and status/show/costs resolve every id starting with 'batch-'
    // as a batch artifact — a run landed under either name could never be
    // addressed again.
    if (entry.run_id === 'batches' || entry.run_id.startsWith('batch-')) {
      throw payloadFault(
        `reserved run_id in manifest: ${JSON.stringify(entry.run_id)} (the batches namespace belongs to batch artifacts)`,
      );
    }
    const runDir = join(runsRoot, entry.run_id);
    const dirStats = lstatSync(runDir, { throwIfNoEntry: false });
    if (dirStats === undefined) {
      throw new ApplianceError(
        'artifact_missing',
        'import',
        `manifest lists ${entry.run_id} but the bundle has no payload for it`,
      );
    }
    if (!dirStats.isDirectory()) {
      throw payloadFault(
        `bundle payload for ${entry.run_id} must be a real directory (not a symlink)`,
      );
    }

    const onDisk = walkRealTree(runDir, `bundle payload for ${entry.run_id}`);

    for (const rel of onDisk) {
      const hit = denylistHit(rel);
      if (hit !== null) {
        throw payloadFault(
          `refusing bundle: ${entry.run_id}/${rel} matches credential pattern ${hit}`,
        );
      }
    }

    // The manifest's file set and the actual regular-file set must be
    // exactly equal — no unlisted file may ride along into the results root.
    const listed = new Set(Object.keys(entry.files));
    for (const rel of listed) {
      assertSafeManifestPath(entry.run_id, rel);
    }
    for (const rel of onDisk) {
      if (!listed.has(rel)) {
        throw payloadFault(
          `${entry.run_id}: bundle contains ${rel} but the manifest does not list it`,
        );
      }
    }

    for (const [rel, expected] of Object.entries(entry.files)) {
      if (!onDisk.has(rel)) {
        throw new ApplianceError(
          'artifact_missing',
          'import',
          `${entry.run_id}: manifest lists ${rel} but it is not in the bundle`,
        );
      }
      const actual = Bun.SHA256.hash(readFileSync(join(runDir, rel)), 'hex');
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

// Import resolves records by exact artifacts.run_id — never through readJob,
// whose job-id-first lookup would let a run_id that happens to equal an
// unrelated job's id resolve (and later rewrite) that job. Only a clean
// job_not_found means absence; ambiguity or corruption propagates as a typed
// per-entry failure so damaged legacy state gets repaired manually, never
// papered over with a duplicate record.
function resolveJobForRun(
  loaded: LoadedApplianceStateConfig,
  runId: string,
): JobRecord | null {
  try {
    return readJobByRunId(loaded, runId);
  } catch (error) {
    if (error instanceof ApplianceError && error.code === 'job_not_found') {
      return null;
    }
    throw error;
  }
}

// No-follow classification of a job's state provenance marker at its
// canonical derived path. Missing is recoverable — the retry re-creates
// it. Anything else that is not exactly a readable regular file holding
// THIS job's imported provenance record is corrupt state for manual
// repair: never skipped over, healed around, followed, or deleted.
function classifyProvenanceMarker(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
): 'missing' | 'valid' {
  const path = provenancePath(loaded, jobId);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    return 'missing';
  }
  if (!stats.isFile()) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `state provenance for ${jobId} is not a regular file (symlink or directory?): ${path}; repair state/provenance manually`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `state provenance for ${jobId} is unreadable or not JSON: ${path}: ${error instanceof Error ? error.message : String(error)}; repair state/provenance manually`,
    );
  }
  const parsed = ImportedProvenanceRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `state provenance for ${jobId} does not parse as an imported provenance record: ${path}; repair state/provenance manually`,
    );
  }
  if (parsed.data.job_id !== jobId) {
    throw new ApplianceError(
      'config_invalid',
      'import',
      `state provenance at ${path} belongs to job ${parsed.data.job_id}, not ${jobId}; repair state/provenance manually`,
    );
  }
  return 'valid';
}

// An imported run's recording is complete only when the job record finished
// AND the state-side provenance marker is exactly this job's valid record.
// A job's mere existence is not sufficient: a crash between the job update
// and the provenance write leaves a done-looking job with no provenance,
// which a retry must repair rather than skip — and a marker of any other
// shape is corrupt state that must fail typed, never pass as complete.
function importRecordingComplete(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
): boolean {
  // A non-import job claiming the run (a live run/run-all record) is not
  // ours to repair; treat it as recorded so healing never rewrites it.
  if (job.kind !== 'import') {
    return true;
  }
  const marker = classifyProvenanceMarker(loaded, job.job_id);
  return (
    job.status === 'done' &&
    job.origin?.kind === 'imported' &&
    job.artifacts.run_id !== null &&
    marker === 'valid'
  );
}

function importedProvenanceRecord(job: JobRecord, origin: Origin): unknown {
  return ImportedProvenanceRecordSchema.parse({
    schema_version: 1,
    kind: 'imported',
    job_id: job.job_id,
    created_at: origin.imported_at,
    origin,
    // Written explicitly, not defaulted: the record asserts that this run
    // received no scoped credential material, rather than staying silent.
    credential_scope: null,
    requester: job.requester,
    command_argv: [...job.command.argv],
  });
}

// State-side provenance: the sanctioned visibility record under state/. This
// is the only provenance write healing is allowed to make.
function writeStateProvenance(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
  origin: Origin,
): string {
  const path = provenancePath(loaded, job.job_id);
  atomicWriteJson(path, importedProvenanceRecord(job, origin));
  return path;
}

// Run-side provenance: prepared on the STAGED payload, so the only write a
// landed run dir ever receives from import is the atomic rename that creates
// it. Never call this against a landed (destRun) directory.
function writeStagedProvenance(
  job: JobRecord,
  origin: Origin,
  staged: string,
): void {
  atomicWriteJson(
    join(staged, 'appliance-provenance.json'),
    importedProvenanceRecord(job, origin),
  );
}

function buildOrigin(
  manifest: BundleManifest,
  entry: BundleManifest['entries'][number],
  importedAt: string,
): Origin {
  return {
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
}

// Reserve (or reuse) the import job claiming this run_id, kept NONTERMINAL:
// durable state may claim success only after the payload has actually landed,
// so the terminal status, result, and state provenance are written solely by
// finishImportJob. Reusing an existing (possibly partial) job keeps retries
// convergent — one run_id, one job record, however many attempts landing
// took. Writes into the STATE dir only, never inside a run directory.
function reserveImportJob(
  loaded: LoadedApplianceStateConfig,
  entry: BundleManifest['entries'][number],
  manifest: BundleManifest,
  importedAt: string,
  existing: JobRecord | null,
): { readonly job: JobRecord; readonly origin: Origin } {
  const origin = buildOrigin(manifest, entry, importedAt);
  const base =
    existing ??
    createJob(loaded, {
      kind: 'import',
      // An imported run's ref is whatever we could establish about it, which
      // origin carries; the request field records the same for readability.
      superpowersRef: entry.superpowers_sha ?? 'unknown',
      argv: ['evals-appliance', 'import', entry.run_id],
      // Associated from the very first durable write — see CreateJobRequest.
      runId: entry.run_id,
      requester: { agent: null, thread: null, task: null },
      // An imported run received no credential material through this
      // appliance. Stated, not omitted.
      credentialSelection: null,
      credentialScope: null,
      credentialScopeSourceEvalsSha: null,
    });
  // Retire any terminal provenance BEFORE the demotion below: a nonterminal
  // record must never sit next to terminal success evidence. State-only —
  // landed run bytes are never touched — and finishImportJob rewrites the
  // provenance after a successful landing. The path is DERIVED, never taken
  // from the record: a stored field is record-controlled and must not steer
  // a delete (exact lookup also rejects noncanonical fields upstream). Only
  // a marker classified as this job's own regular-file record may be
  // retired; any other shape is corrupt state that fails typed here.
  if (classifyProvenanceMarker(loaded, base.job_id) === 'valid') {
    rmSync(provenancePath(loaded, base.job_id), { force: true });
  }
  const job = updateJob(loaded, base.job_id, (current) => ({
    ...current,
    status: 'running' as const,
    started_at: entry.started_at,
    finished_at: null,
    origin,
    artifacts: { ...current.artifacts, run_id: entry.run_id },
    result: { exit_code: null, summary: null },
  }));
  return { job, origin };
}

// Bring a reserved job record to its finished imported form and write the
// state-side provenance. Idempotent: repairing an already-finished job
// rewrites the same bytes, so a retry after a partial failure converges
// without duplicates.
function finishImportJob(
  loaded: LoadedApplianceStateConfig,
  job: JobRecord,
  entry: BundleManifest['entries'][number],
  origin: Origin,
): JobRecord {
  const updated = updateJob(loaded, job.job_id, (current) => ({
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
  writeStateProvenance(loaded, updated, origin);
  return updated;
}

// Best-effort stage cleanup: a cleanup fault must never mask or replace the
// entry's original failure, and must never abort later entries. Returns a
// context note to append after the original message, or null on success.
function cleanupStageBestEffort(staged: string): string | null {
  try {
    rmSync(staged, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `; stage cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function importBundle(
  loaded: LoadedApplianceStateConfig,
  args: ImportArgs,
): ImportResult {
  // Every mutable namespace this command writes through — results root,
  // jobs, locks, provenance, quarantine — must be the real directory tree
  // it claims to be, validated no-follow before the first mkdir, lock
  // write, or landing.
  assertApplianceNamespaces(loaded);
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
  loaded: LoadedApplianceStateConfig,
  args: ImportArgs,
): ImportResult {
  assertBundleRoot(args.bundleDir);
  const manifest = readManifest(args.bundleDir);
  validateBundle(args.bundleDir, manifest);

  const resultsRoot = loaded.config.container.results_root;
  const importedAt = new Date().toISOString();
  const runIds: string[] = [];
  const failures: ImportFailure[] = [];
  let imported = 0;
  let skipped = 0;
  let healed = 0;
  let failed = 0;

  for (const entry of manifest.entries) {
    const destRun = join(resultsRoot, entry.run_id);
    // Stage beside the destination, then decide. The landed dir is never
    // deleted or copied over by this command. Recursive cleanup is permitted
    // only for this exact process-owned stage path (its run_id is validated
    // by validateBundle), never for destRun or any stable run directory.
    const staged = join(
      resultsRoot,
      `.importing-${entry.run_id}.${process.pid}.tmp`,
    );
    try {
      // A crashed import's stale stage from this exact slot:
      rmSync(staged, { recursive: true, force: true });
      cpSync(join(args.bundleDir, 'runs', entry.run_id), staged, {
        recursive: true,
      });
      // The stage must still be the validated shape — a real tree of
      // regular files — before provenance is written beside it or any
      // comparison vouches for it.
      walkRealTree(staged, `staged payload for ${entry.run_id}`);

      const existingJob = resolveJobForRun(loaded, entry.run_id);

      // Documented consumers (status/show) resolve direct job ids before
      // artifact ids, so a run_id that names an unrelated job's directory
      // would make them show that job instead of this run. Reject the entry
      // before anything lands or is reserved — unless the direct job IS the
      // record already claiming the run, where both lookups agree.
      const directJob = readJobById(loaded, entry.run_id);
      if (directJob !== null && directJob.artifacts.run_id !== entry.run_id) {
        throw new ApplianceError(
          'config_invalid',
          'import',
          `run_id ${entry.run_id} collides with unrelated job ${directJob.job_id}; status/show would resolve the job, not the run — rename the run or repair state/jobs manually`,
        );
      }

      if (!existsSync(destRun)) {
        if (existingJob !== null && existingJob.kind !== 'import') {
          // Fail closed rather than rewrite a live job into an import record
          // or mint a second job claiming the same run.
          throw new ApplianceError(
            'config_invalid',
            'import',
            `run_id ${entry.run_id} is claimed by ${existingJob.kind} job ${existingJob.job_id} but its run dir is absent; refusing to conflate records — resolve manually`,
          );
        }
        // Reserve before landing, finish only after: a landing failure
        // leaves a nonterminal record the retry finds and reuses — never a
        // done job for a run that is not there.
        const { job, origin } = reserveImportJob(
          loaded,
          entry,
          manifest,
          importedAt,
          existingJob,
        );
        // Provenance is prepared while the payload is still staged, so the
        // atomic rename is the only write a landed run dir ever receives.
        writeStagedProvenance(job, origin, staged);
        renameSync(staged, destRun);
        finishImportJob(loaded, job, entry, origin);
        runIds.push(entry.run_id);
        imported += 1;
        continue;
      }

      if (
        dirsEquivalent(staged, destRun, {
          exclude: ['appliance-provenance.json'],
        })
      ) {
        rmSync(staged, { recursive: true, force: true });
        if (
          existingJob !== null &&
          importRecordingComplete(loaded, existingJob)
        ) {
          skipped += 1;
        } else {
          // The landed bytes are already correct; healing repairs/creates the
          // state-side records only and never writes inside destRun — a
          // pre-existing sidecar (or none at all) survives as-is.
          const { job, origin } = reserveImportJob(
            loaded,
            entry,
            manifest,
            importedAt,
            existingJob,
          );
          finishImportJob(loaded, job, entry, origin);
          healed += 1;
        }
        continue;
      }

      // From here the payload is a classified conflict, and the stage is the
      // only copy an operator can inspect: a failed quarantine move must
      // retain it — never fall through to the generic stage cleanup below.
      let quarantined: string;
      try {
        quarantined = moveToQuarantine(
          loaded,
          staged,
          `import-conflict-${entry.run_id}`,
        );
      } catch (error) {
        failures.push({
          run_id: entry.run_id,
          code: 'import_conflict',
          message: `destination exists with different content; quarantine move failed (${error instanceof Error ? error.message : String(error)}); conflicting payload retained at ${staged}; landed run untouched`,
        });
        failed += 1;
        continue;
      }
      failures.push({
        run_id: entry.run_id,
        code: 'import_conflict',
        message: `destination exists with different content; staged payload quarantined to ${quarantined}; landed run untouched`,
      });
      failed += 1;
    } catch (error) {
      const cleanupNote = cleanupStageBestEffort(staged);
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        run_id: entry.run_id,
        code: error instanceof ApplianceError ? error.code : 'unknown',
        message: `${message}${cleanupNote ?? ''}`,
      });
      failed += 1;
    }
  }

  return { imported, skipped, healed, failed, failures, run_ids: runIds };
}
