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
import {
  ConversationRecordSchema,
  GauntletRolesSchema,
} from '../contracts/conversation.ts';
import { TokenUsageSchema } from '../contracts/economics.ts';
import {
  CheckRecordSchema,
  FinalVerdictSchema,
  GauntletLayerSchema,
  GauntletProcessExitSchema,
} from '../contracts/verdict.ts';
import { AssessmentCompletionSchema } from '../runner/assessment-completion.ts';
import { parseAttemptManifest } from '../runner/manifest.ts';
import {
  readPublishedArtifact,
  readPublishedArtifactBytes,
} from './attempt-publish.ts';
import { isValidSidecarLine } from './contention.ts';
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
    check_execution_complete: false,
    conversation: null,
    roles: null,
    assessment_report: null,
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
    const manifests = args.artifacts.filter(
      (r) =>
        r.path.split('/').length === 2 && r.path.endsWith('/manifest.json'),
    );
    const rawManifestRef = manifests[0];
    if (manifests.length !== 1 || !rawManifestRef)
      throw new Error('one bound manifest required');
    const manifestRef = ArtifactRefSchema.parse(rawManifestRef);
    const refs: ArtifactRef[] = [];
    for (const raw of args.artifacts) {
      const parsed = ArtifactRefSchema.safeParse(raw);
      if (parsed.success) refs.push(parsed.data);
      else fail(raw.path, 'invalid artifact reference');
    }
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
    ];

    for (const ref of refs) {
      if (!expected.some((bound) => bound.path === ref.path))
        fail(ref.path, 'unlisted artifact reference supplies no evidence');
    }
    for (const bound of expected) {
      const matches = refs.filter((ref) => ref.path === bound.path);
      const ref = matches[0];
      if (
        matches.length !== 1 ||
        !ref ||
        jcsCanonicalize(ref) !== jcsCanonicalize(bound)
      ) {
        fail(bound.path, 'missing, ambiguous or mismatched artifact reference');
        continue;
      }
      try {
        bodies.set(ref.path, readPublishedArtifactBytes(args.resultsRoot, ref));
        e.artifacts.push(ref);
      } catch {
        fail(ref.path, 'artifact authentication failed');
      }
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
  const conversation = ConversationRecordSchema.safeParse(
    json('conversation.json'),
  );
  e.conversation = conversation.success ? conversation.data : null;
  const roles = GauntletRolesSchema.safeParse(json('gauntlet-roles.json'));
  e.roles = roles.success ? roles.data : null;
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
  e.check_execution_complete = v['error'] === null;
  const checkBytes = bodies.get(`${runId}/evidence/checks.json`);
  if (checkBytes) {
    try {
      e.checks = z
        .array(CheckRecordSchema)
        .parse(JSON.parse(checkBytes.toString('utf8')));
    } catch {
      fail('checks', 'malformed authenticated check artifact');
    }
  }
  if (bodies.has(`${runId}/trajectory.json`)) {
    const trajectory = json('trajectory.json');
    if (!Array.isArray(trajectory['steps']) || trajectory['steps'].length === 0)
      fail('normalized_trace', 'malformed or empty normalized trajectory');
  }
  if (object(v['error'])['stage'] === 'capture')
    fail(
      'normalized_trace',
      'capture reported unavailable or defective normalization',
    );
  // QA terminal captures establish visible evidence availability, never a
  // conversation endpoint. Only the bound producer stream can name captures.
  if (!e.conversation && e.gauntlet?.run_id) {
    try {
      const id = e.gauntlet.run_id;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('invalid QA run identity');
      const root = `${runId}/gauntlet-agent/results/${id}`;
      const stream = bodies.get(`${root}/run.jsonl`);
      if (!stream) throw Error('missing QA event stream');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(stream);
      if (!text.endsWith('\n')) throw Error('incomplete QA event stream');
      let captures = 0;
      for (const line of text.trimEnd().split('\n')) {
        const event = object(JSON.parse(line));
        if (typeof event['type'] !== 'string') throw Error('invalid QA event');
        if (
          event['type'] !== 'tool_result' ||
          event['capturePath'] === undefined
        )
          continue;
        const path = event['capturePath'];
        if (typeof path !== 'string' || !/^captures\/\d+\.ansi$/.test(path))
          throw Error('unbound QA capture');
        const ansi = bodies.get(`${root}/${path}`);
        const grid = bodies.get(`${root}/${path.replace(/\.ansi$/, '.json')}`);
        if (!ansi || !grid) throw Error('missing QA capture twin');
        new TextDecoder('utf-8', { fatal: true }).decode(ansi);
        z.object({
          cells: z.array(z.array(z.object({ ch: z.string() }))),
        }).parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(grid)),
        );
        captures++;
      }
      if (!captures) throw Error('no bound QA captures');
    } catch (error) {
      fail('visible_delivery', String(error));
    }
  }
  if (e.roles) {
    const out = e.roles.assessment.out_dir;
    const completion = json(`${out}/assessment-completion.json`);
    const resultBytes = bodies.get(`${runId}/${out}/result.json`);
    const accepted =
      resultBytes &&
      AssessmentCompletionSchema.safeParse(completion).success &&
      e.roles.assessment.stop_cause === null &&
      completion['schema_version'] === 1 &&
      completion['status'] === 'completed' &&
      completion['run_id'] === out.split('/').at(-1) &&
      completion['accepted_report_sha256'] ===
        Bun.SHA256.hash(resultBytes, 'hex');
    if (accepted) {
      const result = json(`${out}/result.json`);
      const layer = GauntletLayerSchema.safeParse({
        ...result,
        run_id: result['runId'],
      });
      const rows = layer.success ? layer.data.criteria : undefined;
      const expectedStatus = rows?.some((r) => r.verdict === 'fail')
        ? 'fail'
        : rows?.every((r) => r.verdict === 'pass')
          ? 'pass'
          : 'investigate';
      if (
        layer.success &&
        result['runId'] === completion['run_id'] &&
        result['scenario'] === String(completion['run_id']).split('_')[0] &&
        layer.data.status === expectedStatus &&
        rows?.length &&
        rows.every(
          (r) =>
            ['pass', 'fail', 'unclear'].includes(r.verdict) &&
            r.criterion.trim().length &&
            r.evidence.trim().length,
        )
      ) {
        e.gauntlet = layer.data;
        e.assessment_report =
          e.artifacts.find((r) => r.path === `${runId}/${out}/result.json`) ??
          null;
      }
    }
    if (!e.assessment_report)
      fail('assessment', 'completed accepted assessment report unavailable');
  }
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
  // A priced subtotal does not cover requests whose usage never returned.
  const assessmentAccounting = economics['assessment_accounting'];
  if (
    assessmentAccounting !== undefined &&
    object(assessmentAccounting)['complete'] !== true
  ) {
    e.grader_cost_complete = false;
    fail('grader_tokens', 'known subtotal only; request usage incomplete');
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
      if (!r.details.telemetry.lines.every(isValidSidecarLine))
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

export type ObligationObservation = {
  id: string;
  verdict: 'pass' | 'fail' | 'unclear' | null;
  evidence: ArtifactRef[];
};
/** Each obligation consumes only its declared sources; accepted prose is never reconstructed from partial output. */
export function measureAttempt(
  e: AttemptEvidence | undefined,
  requirements:
    | import('../contracts/campaign/measurement.ts').ScenarioMeasurement
    | undefined,
): {
  interaction: ObligationObservation;
  checks: ObligationObservation[];
  criteria: ObligationObservation[];
} {
  if (e && !e.publication_valid) e = undefined;
  const refs = e?.artifacts ?? [];
  const manifests = refs.filter(
    (r) => r.path.split('/').length === 2 && r.path.endsWith('/manifest.json'),
  );
  const runRoot =
    manifests.length === 1 ? manifests[0]?.path.split('/')[0] : undefined;
  const supporting = (path: string) =>
    runRoot ? refs.filter((r) => r.path === `${runRoot}/${path}`) : [];
  const checksEvidence = supporting('evidence/checks.json').length
    ? supporting('evidence/checks.json')
    : supporting('verdict.json');
  const visible =
    e?.conversation?.status === 'completed' && e.conversation.evidence
      ? supporting(e.conversation.evidence.path)
      : [];
  const interaction: ObligationObservation = {
    id: 'interaction',
    verdict: visible.length ? 'pass' : null,
    evidence: visible.length
      ? [...supporting('conversation.json'), ...visible]
      : [],
  };
  const artifactClass = (
    kind: import('../contracts/campaign/measurement.ts').ScenarioMeasurement['criteria'][number]['required_artifact_classes'][number],
  ): ArtifactRef[] => {
    const matches = (path: string) =>
      kind === 'normalized_trace'
        ? path === `${runRoot}/trajectory.json`
        : kind === 'native_session'
          ? path.startsWith(`${runRoot}/evidence/native/`)
          : kind === 'output'
            ? path.startsWith(`${runRoot}/evidence/output/`) ||
              path.startsWith(`${runRoot}/coding-agent-workdir/`)
            : false;
    if (kind === 'visible_delivery') {
      if (e?.missingness.some((m) => m.field === kind)) return [];
      if (visible.length) return visible;
      if (e?.conversation || !e?.gauntlet?.run_id) return [];
      const root = `${runRoot}/gauntlet-agent/results/${e.gauntlet.run_id}`;
      return refs.filter(
        (r) =>
          r.path === `${root}/run.jsonl` ||
          r.path.startsWith(`${root}/captures/`),
      );
    }
    if (kind === 'check_dispositions') return e?.checks ? checksEvidence : [];
    if (e?.missingness.some((m) => m.field === kind || matches(m.field)))
      return [];
    return refs.filter((r) => matches(r.path));
  };
  const remainingChecks = new Set(e?.checks ?? []);
  const checks = [...(requirements?.checks ?? [])]
    .sort((a, b) => Number(a.args === null) - Number(b.args === null))
    .flatMap((c) => {
      const matching = [...remainingChecks]
        .filter(
          (r) =>
            r.phase === c.phase &&
            r.check === c.check &&
            r.negated === c.negated &&
            (c.args === null ||
              jcsCanonicalize(r.args) === jcsCanonicalize(c.args)),
        )
        .slice(0, c.count);
      for (const record of matching) remainingChecks.delete(record);
      return Array.from(
        { length: c.count },
        (_, index): ObligationObservation => {
          const record = matching[index];
          // Current emitters classify crashes. Retained false rows without that fact
          // cannot establish a behavioral failure in an independently measured check.
          const verdict =
            record &&
            record.checker_status !== 'errored' &&
            (record.passed ||
              record.checker_status === 'completed' ||
              e?.check_execution_complete) &&
            (c.authority.kind !== 'process_check' ||
              artifactClass('normalized_trace').length > 0)
              ? record.passed
                ? 'pass'
                : 'fail'
              : null;
          return {
            id: `check:${c.ordinal}`,
            verdict,
            evidence: verdict ? checksEvidence : [],
          };
        },
      );
    });
  const criteria = (requirements?.criteria ?? []).map(
    (c): ObligationObservation => {
      const row = e?.gauntlet?.criteria?.[c.ordinal - 1];
      const dependencies = c.required_artifact_classes.map(artifactClass);
      const checkDependenciesAvailable =
        !c.required_artifact_classes.includes('check_dispositions') ||
        (c.check_refs.length > 0 &&
          c.check_refs.every((ref) => {
            const records = checks.filter(
              (r) => r.id === `check:${ref.ordinal}`,
            );
            return (
              records.length > 0 && records.every((r) => r.verdict !== null)
            );
          }));
      const accepted =
        requirements?.mode !== 'conversation' ||
        (e?.assessment_report !== null && e?.assessment_report !== undefined);
      const verdict =
        accepted &&
        checkDependenciesAvailable &&
        row?.criterion === c.text &&
        ['pass', 'fail', 'unclear'].includes(row.verdict) &&
        row.evidence.trim().length > 0 &&
        dependencies.every((r) => r.length > 0)
          ? (row.verdict as 'pass' | 'fail' | 'unclear')
          : null;
      return {
        id: `${requirements?.rubric_sha256}:${c.ordinal}`,
        verdict,
        evidence: verdict
          ? [
              ...(e?.assessment_report
                ? [e.assessment_report]
                : supporting('verdict.json')),
              ...dependencies.flat(),
            ]
          : [],
      };
    },
  );
  checks.sort(
    (a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]),
  );
  return { interaction, checks, criteria };
}
