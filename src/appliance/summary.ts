import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { costsJson, loadCostRows, renderCosts } from '../cli/costs.ts';
import { render } from '../cli/render.ts';
import {
  type BatchVerdict,
  batchJson,
  isBatchDir,
  renderBatch,
} from '../cli/render-batch.ts';
import { resolveTarget, ShowError } from '../cli/resolve-target.ts';
import { type FinalStatus, FinalVerdictSchema } from '../contracts/verdict.ts';
import { ApplianceError } from './errors.ts';
import { readJob } from './jobs.ts';
import type { JobRecord, JobStatus, LoadedApplianceConfig } from './types.ts';

export interface BatchSummary {
  readonly pass: number;
  readonly fail: number;
  readonly indeterminate: number;
  readonly unknown: number;
  readonly skipped: number;
}

type MutableBatchSummary = {
  -readonly [K in keyof BatchSummary]: BatchSummary[K];
};

export interface RunSummary {
  readonly final: FinalStatus;
  readonly final_reason: string;
}

export type StatusSummary = BatchSummary | RunSummary | null;

export interface StatusPayload {
  readonly id: string;
  readonly status: JobStatus | 'running' | 'done';
  readonly appliance_failed: boolean;
  readonly summary: StatusSummary;
  readonly job: JobStatusPayload | null;
  readonly artifact: ArtifactPayload | null;
}

export interface JobStatusPayload {
  readonly job_id: string;
  readonly status: JobStatus;
  readonly run_id: string | null;
  readonly batch_id: string | null;
}

export interface ArtifactPayload {
  readonly type: 'batch' | 'run';
  readonly id: string;
  readonly path: string;
}

type Target =
  | {
      readonly kind: 'batch';
      readonly path: string;
      readonly id: string;
      readonly job: JobRecord | null;
    }
  | {
      readonly kind: 'run';
      readonly path: string;
      readonly id: string;
      readonly job: JobRecord | null;
    }
  | {
      readonly kind: 'job';
      readonly job: JobRecord;
    };

const BatchHeaderSchema = z.object({
  id: z.string(),
  finished_at: z.string().nullable().optional(),
});

const BatchResultSchema = z.object({
  scenario: z.string(),
  coding_agent: z.string(),
  run_id: z.string().nullable().optional(),
  skipped: z.unknown().optional(),
});

const VerdictFinalSchema = z.object({
  final: z.string(),
});

function artifactMissing(step: string, message: string): ApplianceError {
  return new ApplianceError('artifact_missing', step, message);
}

function readRequiredText(path: string, step: string): string {
  if (!existsSync(path)) {
    throw artifactMissing(step, `${path} not found`);
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw artifactMissing(step, `${path}: ${message}`);
  }
}

function readRequiredJson(path: string, step: string): unknown {
  try {
    return JSON.parse(readRequiredText(path, step));
  } catch (error) {
    if (error instanceof ApplianceError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw artifactMissing(step, `${path}: ${message}`);
  }
}

function parseJson<T>(schema: z.ZodType<T>, path: string, step: string): T {
  const parsed = schema.safeParse(readRequiredJson(path, step));
  if (!parsed.success) {
    throw artifactMissing(step, `${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function batchDir(loaded: LoadedApplianceConfig, batchId: string): string {
  return join(loaded.config.container.results_root, 'batches', batchId);
}

function runDir(loaded: LoadedApplianceConfig, runId: string): string {
  return join(loaded.config.container.results_root, runId);
}

function artifactIdFromPath(path: string): string {
  const id = path.split('/').at(-1);
  return id === undefined || id === '' ? path : id;
}

function classifyResolvedTarget(path: string, job: JobRecord | null): Target {
  if (isBatchDir(path)) {
    return { kind: 'batch', path, id: artifactIdFromPath(path), job };
  }
  return { kind: 'run', path, id: artifactIdFromPath(path), job };
}

function jobPayload(job: JobRecord | null): JobStatusPayload | null {
  if (job === null) {
    return null;
  }
  return {
    job_id: job.job_id,
    status: job.status,
    run_id: job.artifacts.run_id,
    batch_id: job.artifacts.batch_id,
  };
}

function artifactPayload(target: Target): ArtifactPayload | null {
  if (target.kind === 'job') {
    return null;
  }
  return { type: target.kind, id: target.id, path: target.path };
}

function applianceFailed(status: JobStatus): boolean {
  return status === 'failed' || status === 'lost' || status === 'quarantined';
}

function resolveJobArtifact(loaded: LoadedApplianceConfig, id: string): Target {
  const job = readJob(loaded, id);
  if (job.artifacts.batch_id !== null) {
    return {
      kind: 'batch',
      path: batchDir(loaded, job.artifacts.batch_id),
      id: job.artifacts.batch_id,
      job,
    };
  }
  if (job.artifacts.run_id !== null) {
    return {
      kind: 'run',
      path: runDir(loaded, job.artifacts.run_id),
      id: job.artifacts.run_id,
      job,
    };
  }
  return { kind: 'job', job };
}

function resolveSummaryTarget(
  loaded: LoadedApplianceConfig,
  id: string,
): Target {
  const resultsRoot = loaded.config.container.results_root;
  if (id.startsWith('job-')) {
    return resolveJobArtifact(loaded, id);
  }
  if (id.startsWith('batch-')) {
    return {
      kind: 'batch',
      path: batchDir(loaded, id),
      id,
      job: null,
    };
  }
  try {
    return classifyResolvedTarget(resolveTarget(id, resultsRoot), null);
  } catch (error) {
    if (error instanceof ShowError) {
      throw artifactMissing('artifact', error.message);
    }
    throw error;
  }
}

function requireBatchArtifacts(batchPath: string): void {
  readRequiredText(join(batchPath, 'batch.json'), 'batch');
  readRequiredText(join(batchPath, 'results.jsonl'), 'batch');
}

function verdictFromRun(
  runPath: string,
  step = 'verdict',
): z.infer<typeof FinalVerdictSchema> {
  return parseJson(FinalVerdictSchema, join(runPath, 'verdict.json'), step);
}

function isCountedVerdict(
  value: string,
): value is Exclude<BatchVerdict, 'skipped' | 'unknown'> {
  return value === 'pass' || value === 'fail' || value === 'indeterminate';
}

function cellVerdict(
  resultsRoot: string,
  runId: string | null,
): keyof BatchSummary {
  if (runId === null) {
    return 'unknown';
  }
  const verdictPath = join(resultsRoot, runId, 'verdict.json');
  if (!existsSync(verdictPath)) {
    return 'unknown';
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(verdictPath, 'utf8'));
  } catch {
    return 'unknown';
  }
  const parsed = VerdictFinalSchema.safeParse(raw);
  if (!parsed.success || !isCountedVerdict(parsed.data.final)) {
    return 'unknown';
  }
  return parsed.data.final;
}

function batchSummary(
  loaded: LoadedApplianceConfig,
  batchPath: string,
): {
  readonly header: z.infer<typeof BatchHeaderSchema>;
  readonly summary: BatchSummary;
} {
  const header = parseJson(
    BatchHeaderSchema,
    join(batchPath, 'batch.json'),
    'batch',
  );
  const text = readRequiredText(join(batchPath, 'results.jsonl'), 'batch');
  const summary: MutableBatchSummary = {
    pass: 0,
    fail: 0,
    indeterminate: 0,
    unknown: 0,
    skipped: 0,
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw artifactMissing('batch', `${batchPath}/results.jsonl: ${message}`);
    }
    const row = BatchResultSchema.safeParse(raw);
    if (!row.success) {
      throw artifactMissing(
        'batch',
        `${batchPath}/results.jsonl: ${row.error.message}`,
      );
    }
    if (row.data.skipped) {
      summary.skipped += 1;
      continue;
    }
    summary[
      cellVerdict(loaded.config.container.results_root, row.data.run_id ?? null)
    ] += 1;
  }
  return { header, summary };
}

function costsTarget(target: Target): string | undefined {
  if (target.kind === 'job') {
    return undefined;
  }
  return target.path;
}

export function statusPayload(
  loaded: LoadedApplianceConfig,
  id: string,
): StatusPayload {
  const target = resolveSummaryTarget(loaded, id);
  if (target.kind === 'job') {
    return {
      id,
      status: target.job.status,
      appliance_failed: applianceFailed(target.job.status),
      summary: null,
      job: jobPayload(target.job),
      artifact: null,
    };
  }

  if (target.kind === 'batch') {
    const { header, summary } = batchSummary(loaded, target.path);
    return {
      id,
      status: target.job?.status ?? (header.finished_at ? 'done' : 'running'),
      appliance_failed:
        target.job !== null ? applianceFailed(target.job.status) : false,
      summary,
      job: jobPayload(target.job),
      artifact: artifactPayload(target),
    };
  }

  const verdict = verdictFromRun(target.path);
  return {
    id,
    status: target.job?.status ?? 'done',
    appliance_failed:
      target.job !== null ? applianceFailed(target.job.status) : false,
    summary: {
      final: verdict.final,
      final_reason: verdict.final_reason,
    },
    job: jobPayload(target.job),
    artifact: artifactPayload(target),
  };
}

export function showPayload(
  loaded: LoadedApplianceConfig,
  id: string,
  json: boolean,
): string | unknown {
  const target = resolveSummaryTarget(loaded, id);
  if (target.kind === 'job') {
    throw artifactMissing('artifact', `${id} has no run or batch artifact`);
  }
  if (target.kind === 'batch') {
    requireBatchArtifacts(target.path);
    return json
      ? batchJson(target.path)
      : renderBatch({
          batchDir: target.path,
          resultsRoot: loaded.config.container.results_root,
          color: false,
        });
  }

  if (json) {
    return readRequiredJson(join(target.path, 'verdict.json'), 'verdict');
  }
  const verdict = verdictFromRun(target.path);
  return render(verdict, target.path, { color: false, mode: 'full' });
}

export function costsPayload(
  loaded: LoadedApplianceConfig,
  id: string,
  json: boolean,
): string | unknown {
  const target = resolveSummaryTarget(loaded, id);
  if (target.kind === 'job') {
    throw artifactMissing('artifact', `${id} has no run or batch artifact`);
  }
  try {
    const rows = loadCostRows(
      costsTarget(target),
      loaded.config.container.results_root,
    );
    return json
      ? costsJson(rows)
      : renderCosts(rows, { color: false, withGauntlet: false });
  } catch (error) {
    if (error instanceof ShowError) {
      throw artifactMissing('artifact', error.message);
    }
    throw error;
  }
}
