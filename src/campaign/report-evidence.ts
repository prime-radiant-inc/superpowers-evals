import { z } from 'zod';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import {
  type ArtifactRef,
  ArtifactRefSchema,
} from '../contracts/campaign/execution.ts';
import { TimestampSchema } from '../contracts/campaign/experiment.ts';
import {
  type AttemptEvidence,
  AttemptEvidenceSchema,
} from '../contracts/campaign/report.ts';
import { TokenUsageSchema } from '../contracts/economics.ts';
import {
  CheckRecordSchema,
  FinalVerdictSchema,
  GauntletLayerSchema,
  GauntletProcessExitSchema,
} from '../contracts/verdict.ts';
import { parseAttemptManifest } from '../runner/manifest.ts';
import {
  readPublishedArtifact,
  readPublishedArtifactBytes,
} from './attempt-publish.ts';
import { parseSidecar } from './contention.ts';
import type { BlockProjection, CampaignProjection } from './execution-state.ts';

export type { AttemptEvidence } from '../contracts/campaign/report.ts';

const object = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
const nonnegative = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
export function missingAttemptEvidence(
  reason = 'no published evidence',
): AttemptEvidence {
  return {
    publication_valid: false,
    observed_outcome: null,
    gauntlet: null,
    checks: null,
    wall_seconds: null,
    subject_cost_usd: null,
    subject_cost_complete: false,
    grader_cost_usd: null,
    grader_cost_complete: false,
    subject_tokens: null,
    grader_tokens: null,
    subject_usage: null,
    versions: null,
    missingness: [{ field: 'publication', reason }],
    artifacts: [],
  };
}
/** Authenticate the manifest binding first, then each independent artifact. A damaged
 * artifact loses all its fields; malformed optional values lose only that quantity. */
export function readAttemptEvidence(args: {
  resultsRoot: string;
  expectedIdentity: CampaignIdentity;
  artifacts: readonly ArtifactRef[];
}): AttemptEvidence {
  const e = missingAttemptEvidence();
  e.missingness = [];
  const fail = (field: string, reason: string) =>
    e.missingness.push({ field, reason });
  const bodies = new Map<string, Buffer>();
  let runId: string;
  try {
    const refs = args.artifacts.map((r) => ArtifactRefSchema.parse(r));
    if (new Set(refs.map((r) => r.path)).size !== refs.length)
      throw new Error('duplicate artifact reference');
    const manifests = refs.filter(
      (r) =>
        r.path.split('/').length === 2 && r.path.endsWith('/manifest.json'),
    );
    const manifestRef = manifests[0];
    if (manifests.length !== 1 || !manifestRef)
      throw new Error('one bound manifest required');
    const manifest = parseAttemptManifest(
      readPublishedArtifact(args.resultsRoot, manifestRef),
    );
    runId = manifest.run_id;
    if (
      manifestRef.path !== `${runId}/manifest.json` ||
      jcsCanonicalize(manifest.campaign) !==
        jcsCanonicalize(args.expectedIdentity)
    )
      throw new Error('manifest identity mismatch');
    const expected = [
      ...manifest.files.map((f) => ({
        path: `${runId}/${f.path}`,
        sha256: f.sha256,
        bytes: f.size,
      })),
      manifestRef,
    ].sort((a, b) => a.path.localeCompare(b.path));
    if (
      jcsCanonicalize(expected) !==
      jcsCanonicalize([...refs].sort((a, b) => a.path.localeCompare(b.path)))
    )
      throw new Error('manifest reference inventory mismatch');
    e.artifacts = expected;
    for (const ref of refs)
      try {
        bodies.set(ref.path, readPublishedArtifactBytes(args.resultsRoot, ref));
      } catch {
        fail(ref.path, 'artifact authentication failed');
      }
    e.publication_valid = true;
  } catch (error) {
    return missingAttemptEvidence(
      error instanceof Error ? error.message : String(error),
    );
  }
  const json = (name: string): Record<string, unknown> => {
    const body = bodies.get(`${runId}/${name}`);
    if (!body) return {};
    try {
      return object(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
      );
    } catch {
      fail(name, 'invalid JSON or UTF-8');
      return {};
    }
  };
  const v = json('verdict.json');
  if (Object.keys(v).length) {
    const identity = CampaignIdentitySchema.safeParse(v['campaign']);
    if (
      !identity.success ||
      jcsCanonicalize(identity.data) !== jcsCanonicalize(args.expectedIdentity)
    )
      return missingAttemptEvidence('verdict identity mismatch');
  }
  const outcome = FinalVerdictSchema.shape.final.safeParse(v['final']);
  e.observed_outcome = outcome.success ? outcome.data : null;
  // Optional process facts must not erase a parseable independent judgment.
  const g = object(v['gauntlet']);
  const exit = GauntletProcessExitSchema.safeParse(g['process_exit']);
  const judgment = { ...g };
  delete judgment['process_exit'];
  if (exit.success) judgment['process_exit'] = exit.data;
  const gauntlet = GauntletLayerSchema.safeParse(judgment);
  e.gauntlet = gauntlet.success ? gauntlet.data : null;
  if (g['process_exit'] !== undefined && !exit.success)
    fail('gauntlet.process_exit', 'invalid settled process facts');
  const checks = z.array(CheckRecordSchema).safeParse(v['checks']);
  e.checks = checks.success ? checks.data : null;
  const versions = FinalVerdictSchema.shape.provenance.safeParse(
    v['provenance'],
  );
  e.versions = versions.success ? (versions.data ?? null) : null;
  const start = TimestampSchema.safeParse(v['started_at']),
    end = TimestampSchema.safeParse(v['finished_at']);
  e.wall_seconds =
    start.success && end.success
      ? nonnegative((Date.parse(end.data) - Date.parse(start.data)) / 1000)
      : null;
  const economics = object(v['economics']);
  for (const [role, key] of [
    ['subject', 'coding_agent'],
    ['grader', 'gauntlet'],
  ] as const) {
    const block = object(economics[key]);
    e[`${role}_cost_usd`] = nonnegative(block['est_cost_usd']);
    const unpriced = object(block['obol'])['unpriced_models'];
    e[`${role}_cost_complete`] =
      e[`${role}_cost_usd`] !== null &&
      block['has_unpriced_model'] === false &&
      (unpriced === undefined ||
        (Array.isArray(unpriced) && unpriced.length === 0));
    e[`${role}_tokens`] = nonnegative(object(block['tokens'])['total']);
  }
  const usageRaw = json('coding-agent-token-usage.json');
  const sanitizedUsage = {
    ...usageRaw,
    est_cost_usd: nonnegative(usageRaw['est_cost_usd']),
    duration_ms: nonnegative(usageRaw['duration_ms']),
    models: Object.fromEntries(
      Object.entries(object(usageRaw['models'])).map(([name, raw]) => [
        name,
        {
          ...object(raw),
          est_cost_usd: nonnegative(object(raw)['est_cost_usd']),
        },
      ]),
    ),
  };
  const usage = TokenUsageSchema.safeParse(sanitizedUsage);
  if (
    usage.success &&
    [
      usage.data.total_input,
      usage.data.total_output,
      usage.data.total_cache_create,
      usage.data.total_cache_read,
      usage.data.total_tokens,
    ].every((n) => nonnegative(n) !== null)
  )
    e.subject_usage = usage.data;
  // Captured subject usage is an independently authenticated frozen source, even
  // when verdict bytes were lost. Never reconstruct grader pricing from logs.
  if (e.subject_tokens === null)
    e.subject_tokens = nonnegative(usageRaw['total_tokens']);
  if (e.subject_cost_usd === null) {
    e.subject_cost_usd = nonnegative(usageRaw['est_cost_usd']);
    e.subject_cost_complete =
      e.subject_cost_usd !== null &&
      Array.isArray(usageRaw['unpriced_models']) &&
      usageRaw['unpriced_models'].length === 0;
  }
  for (const field of [
    'observed_outcome',
    'gauntlet',
    'checks',
    'versions',
    'subject_usage',
  ] as const)
    if (e[field] === null)
      fail(field, 'missing or malformed authenticated field');
  for (const field of [
    'wall_seconds',
    'subject_cost_usd',
    'grader_cost_usd',
    'subject_tokens',
    'grader_tokens',
  ] as const)
    if (e[field] === null) fail(field, 'missing or invalid frozen quantity');
  for (const role of ['subject', 'grader'] as const)
    if (e[`${role}_cost_usd`] !== null && !e[`${role}_cost_complete`])
      fail(`${role}_cost_usd`, 'known subtotal only; pricing incomplete');
  return AttemptEvidenceSchema.parse(e);
}
export interface ValidityEvidence {
  available: boolean;
  reasons: string[];
}
const finite = z.number().finite();
const Receipt = z
  .object({
    campaign_id: z.string(),
    input_digest: z.string(),
    start_id: z.string(),
    block_id: z.string(),
    at: TimestampSchema,
    verdict: z.literal('valid'),
    details: z
      .object({
        exposures: z.array(finite.nullable()),
        contention: z.literal('clean'),
        intervals: z.array(
          z
            .object({
              block_id: z.string(),
              startTsMs: finite,
              endTsMs: finite.nullable(),
            })
            .strict(),
        ),
        telemetry: z
          .object({ lines: z.array(z.unknown()), truncatedTail: z.boolean() })
          .strict(),
      })
      .strict(),
  })
  .strict();
export function readBlockValidity(args: {
  campaignDir: string;
  state: CampaignProjection;
  block: BlockProjection;
}): ValidityEvidence {
  const receipt = args.block.validity_receipt;
  if (!receipt)
    return {
      available: false,
      reasons: ['missing final positive validity receipt'],
    };
  try {
    for (const ref of receipt.evidence_refs) {
      const r = Receipt.parse(
        JSON.parse(readPublishedArtifact(args.campaignDir, ref)),
      );
      if (
        r.campaign_id !== args.state.experiment.campaign_id ||
        r.input_digest !== args.state.experiment.input_digest ||
        r.start_id !== args.state.start?.start_id ||
        r.block_id !== args.block.activation.block_id ||
        r.details.exposures.length !== args.block.activation.attempts.length ||
        r.details.exposures.some((x) => x === null)
      )
        throw new Error(
          'positive validity identity or exposure shape mismatch',
        );
      const parsed = parseSidecar(
        r.details.telemetry.lines.map((l) => JSON.stringify(l)).join('\n') +
          '\n',
      );
      if (
        parsed.lines.length !== r.details.telemetry.lines.length ||
        parsed.truncatedTail
      )
        throw new Error('invalid telemetry receipt shape');
    }
    return { available: true, reasons: [] };
  } catch (error) {
    return {
      available: false,
      reasons: [
        `positive validity authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
