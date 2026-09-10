/** Offline evidence comparisons. Prose entailment, extraction fidelity, and
 * behavior judgments belong to the independently authored, digest-bound review.
 * Native bytes are used only for integrity/quotes; behavior comes from ATIF. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  NativeBoundary,
  NativeChildDispatch,
  NativeChildEvidence,
  NativeEvidence,
  NativeToolResultEvidence,
} from '../../atif/provenance.ts';
import type { AtifStep, AtifTrajectory } from '../../atif/types.ts';
import { validateTrajectory } from '../../atif/validate.ts';
import type { CapturedSource } from '../../capture/source-index.ts';
import {
  type AssessDiagnosisArgs,
  type AssessmentStatus,
  DIMENSIONS,
  DiagnosisArtifactsSchema,
  type DiagnosisAssessment,
  type DiagnosisKey,
  DiagnosisKeySchema,
  type DiagnosisReview,
  DiagnosisReviewSchema,
  FixtureManifestSchema,
  type NativeLocator,
  NormalizedRelativePathSchema,
  type RetainedArtifact,
  RUBRIC,
} from './contracts.ts';

export function diagnosisDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Reject escaping paths and symlink components, including directory links. */
export function readDiagnosisFile(root: string, path: string): Buffer {
  const base = resolve(root);
  const absolute = resolve(base, path);
  const rel = relative(base, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`path escapes retained run: ${path}`);
  let current = base;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`symlink evidence refused: ${path}`);
  }
  if (!lstatSync(absolute).isFile())
    throw new Error(`not a regular retained file: ${path}`);
  return readFileSync(absolute);
}

const SourceIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(
      z
        .object({
          id: z.string().min(1),
          nativePath: z.string().min(1),
          sha256: z.string(),
          trajectoryPath: NormalizedRelativePathSchema.nullable(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
    mergedSteps: z.array(
      z
        .object({
          mergedStepId: z.number().int().positive(),
          sourceId: z.string(),
          sourceStepId: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
interface Source {
  row: CapturedSource;
  trajectory?: AtifTrajectory;
  error?: string;
  bytes?: Buffer;
}
interface MappedEvidence {
  source: Source;
  step?: AtifStep;
  text?: string;
  timestamp?: string | undefined;
  native?: NativeEvidence;
  durationMs?: number;
  origin?: string;
  metrics?: Record<string, unknown>;
}
function evidence(
  extra: Record<string, unknown> | undefined,
): NativeEvidence | undefined {
  const item = extra?.['quorum_source'];
  return item &&
    typeof item === 'object' &&
    Array.isArray((item as NativeEvidence).lines)
    ? (item as NativeEvidence)
    : undefined;
}
const textOf = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value === undefined
      ? ''
      : JSON.stringify(value);
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const err = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const bool = (value: boolean): AssessmentStatus => (value ? 'pass' : 'fail');

export function assessDiagnosis(
  args: AssessDiagnosisArgs,
): DiagnosisAssessment {
  const checks: DiagnosisAssessment['checks'] = [];
  const add = (name: string, status: AssessmentStatus, detail: string) => {
    checks.push({ name, status, detail });
  };
  const finish = (): DiagnosisAssessment => ({
    status: checks.some((c) => c.status === 'incomplete')
      ? 'incomplete'
      : checks.some((c) => c.status === 'fail')
        ? 'fail'
        : 'pass',
    checks,
  });
  const read = (path: string) => readDiagnosisFile(args.runDir, path);
  const parse = <T>(
    name: string,
    schema: z.ZodType<T>,
    bytes: () => Buffer,
  ): T | undefined => {
    try {
      const result = schema.parse(JSON.parse(bytes().toString('utf8')));
      add(name, 'pass', 'structure validated');
      return result;
    } catch (error) {
      add(name, 'incomplete', err(error));
      return undefined;
    }
  };
  const key = parse('key-schema', DiagnosisKeySchema, () =>
    readFileSync(args.keyPath),
  );
  const review = parse('review-schema', DiagnosisReviewSchema, () =>
    readFileSync(args.reviewPath),
  );
  const artifacts = parse('artifact-schema', DiagnosisArtifactsSchema, () =>
    read('diagnosis-artifacts.json'),
  );
  if (!key || !review || !artifacts) return finish();
  add(
    'key-identity',
    same(review.keySha256, diagnosisDigest(readFileSync(args.keyPath)))
      ? 'pass'
      : 'incomplete',
    'review must bind exact private key bytes',
  );
  const files = new Map<string, RetainedArtifact>();
  const retained = new Map<string, RetainedArtifact>();
  for (const row of artifacts.files) {
    if (files.has(row.originalPath) || retained.has(row.retainedPath))
      add(
        'artifact-map',
        'incomplete',
        `ambiguous retained mapping: ${row.originalPath}`,
      );
    files.set(row.originalPath, row);
    retained.set(row.retainedPath, row);
  }
  const fileBytes = (row: RetainedArtifact) => {
    const bytes = read(row.retainedPath);
    if (diagnosisDigest(bytes) !== row.sha256 || bytes.length !== row.bytes)
      throw new Error(`retained digest/size mismatch: ${row.retainedPath}`);
    return bytes;
  };
  // Scan all accessible evidence without returning early on a partial collection.
  for (const row of artifacts.files) {
    try {
      fileBytes(row);
    } catch (error) {
      add(`artifact-integrity:${row.retainedPath}`, 'incomplete', err(error));
    }
  }
  add(
    'collection',
    artifacts.errors.length ? 'incomplete' : 'pass',
    artifacts.errors.join('; ') || 'collection contains no recorded errors',
  );
  const manifest = parse('manifest-schema', FixtureManifestSchema, () =>
    read('diagnosis-history/manifest.json'),
  );
  if (manifest) {
    add(
      'manifest-identity',
      diagnosisDigest(read('diagnosis-history/manifest.json')) ===
        key.manifestSha256 && manifest.harness === key.harness
        ? 'pass'
        : 'incomplete',
      'retained manifest must match frozen key and harness',
    );
    const missing = manifest.files.filter(
      (f) =>
        !artifacts.preservation.some(
          (p) => p.source === f.path && p.expectedSha256 === f.sha256,
        ),
    );
    add(
      'preservation-coverage',
      missing.length ? 'incomplete' : 'pass',
      missing.length
        ? `missing preservation records: ${missing.map((f) => f.path).join(', ')}`
        : 'all fixture declarations covered',
    );
  }
  const changed = artifacts.preservation.filter(
    (p) => p.status !== 'unchanged' || p.actualSha256 !== p.expectedSha256,
  );
  add(
    'source-preservation',
    bool(changed.length === 0),
    changed.length
      ? `historical files changed or missing: ${changed.map((p) => p.source).join(', ')}`
      : 'historical sources preserved',
  );
  const declared = new Map(
    artifacts.preservation.map((p) => [p.source, p.installedPath]),
  );
  // Publication relocates the throwaway home. The frozen manifest and its
  // preservation map establish one exact original store root; never guess a
  // suffix/ancestor based on the untrusted current source path.
  const storeRoots = new Set<string>();
  if (manifest)
    for (const declaration of manifest.files.filter(
      (f) => f.destination === 'session-store',
    )) {
      const records = artifacts.preservation.filter(
        (p) =>
          p.source === declaration.path &&
          p.expectedSha256 === declaration.sha256,
      );
      const record = records[0];
      const suffix = `/${declaration.relativePath}`;
      if (
        records.length !== 1 ||
        !record ||
        !record.installedPath.endsWith(suffix)
      ) {
        add(
          'native-store-map',
          'incomplete',
          `ambiguous original store mapping: ${declaration.path}`,
        );
        continue;
      }
      storeRoots.add(record.installedPath.slice(0, -suffix.length));
    }
  if (storeRoots.size !== 1)
    add(
      'native-store-map',
      'incomplete',
      'manifest must establish one consistent original native store root',
    );
  const storeRoot = storeRoots.size === 1 ? [...storeRoots][0] : undefined;
  const storeParts = {
    claude: '.claude/projects',
    codex: '.codex/sessions',
    pi: '.pi/agent/sessions',
  }[key.harness];
  const currentNative = (nativePath: string): Buffer => {
    if (storeRoot && nativePath.startsWith(`${storeRoot}/`)) {
      const rel = nativePath.slice(storeRoot.length + 1);
      NormalizedRelativePathSchema.parse(rel);
      return read(`home/${storeParts}/${rel}`);
    }
    return read(nativePath);
  };
  const loadSources = (name: string, path: string): Map<string, Source> => {
    const index = parse(name, SourceIndexSchema, () => read(path));
    const result = new Map<string, Source>();
    if (!index) return result;
    if (name === 'historical-sources' && index.mergedSteps.length)
      add(
        name,
        'incomplete',
        'historical population must not enter current merged usage',
      );
    const paths = new Set<string>();
    for (const row of index.sources) {
      if (result.has(row.id) || paths.has(row.nativePath)) {
        add(name, 'incomplete', `duplicate source identity: ${row.id}`);
        continue;
      }
      paths.add(row.nativePath);
      const source: Source = { row };
      result.set(row.id, source);
      try {
        if (row.error || !row.trajectoryPath)
          throw new Error(row.error ?? 'trajectory unavailable');
        const nativeRow = files.get(row.nativePath);
        source.bytes = nativeRow
          ? fileBytes(nativeRow)
          : name === 'current-sources'
            ? currentNative(row.nativePath)
            : read(row.nativePath);
        if (diagnosisDigest(source.bytes) !== row.sha256)
          throw new Error(`native source digest mismatch: ${row.id}`);
        const t = JSON.parse(
          read(row.trajectoryPath).toString('utf8'),
        ) as AtifTrajectory;
        const valid = validateTrajectory(t);
        if (!valid.ok)
          throw new Error(`invalid source ATIF: ${valid.errors.join('; ')}`);
        if (new Set(t.steps.map((s) => s.step_id)).size !== t.steps.length)
          throw new Error('duplicate source step ids');
        source.trajectory = t;
      } catch (error) {
        source.error = err(error);
        add(`source:${row.id}`, 'incomplete', source.error);
      }
    }
    return result;
  };
  const history = loadSources(
    'historical-sources',
    'diagnosis-history/atif-sources.json',
  );
  const current = loadSources('current-sources', 'atif-sources.json');
  const historicalPaths = new Set(
    [...history.values()].map((s) => s.row.nativePath),
  );
  for (const source of current.values())
    if (historicalPaths.has(source.row.nativePath))
      add(
        'source-populations',
        'incomplete',
        `historical source included in current diagnosis: ${source.row.nativePath}`,
      );
  const sourceAt = (
    path: string,
    population: Map<string, Source>,
  ): Source | undefined => {
    const absolute =
      declared.get(path) ?? retained.get(path)?.originalPath ?? path;
    return (
      population.get(path) ??
      [...population.values()].find((s) => s.row.nativePath === absolute)
    );
  };
  const mapped = (
    locator: NativeLocator,
    populations = [history],
  ): MappedEvidence[] => {
    const source = populations
      .map((p) => sourceAt(locator.source, p))
      .find(Boolean);
    if (
      !source?.trajectory ||
      !source.bytes?.toString('utf8').split(/\r?\n/)[locator.line - 1]
    )
      return [];
    const result: MappedEvidence[] = [];
    const match = (
      extra: Record<string, unknown> | undefined,
      step?: AtifStep,
      text?: unknown,
      metrics?: Record<string, unknown>,
      useStepTime = true,
      boundaryDurationMs?: number,
    ) => {
      const e = evidence(extra);
      if (!e?.lines.includes(locator.line)) return;
      const timestamp =
        e.timestamp ?? (useStepTime ? step?.timestamp : undefined);
      const durationMs =
        boundaryDurationMs ??
        (extra?.['quorum_result'] as NativeToolResultEvidence | undefined)
          ?.durationMs;
      result.push({
        source,
        ...(typeof durationMs === 'number' &&
        Number.isFinite(durationMs) &&
        durationMs >= 0
          ? { durationMs }
          : {}),
        native: e,
        ...(step ? { step } : {}),
        text: textOf(text),
        ...(timestamp ? { timestamp } : {}),
        ...(e.origin ? { origin: e.origin } : {}),
        ...(metrics ? { metrics } : {}),
      });
    };
    for (const step of source.trajectory.steps) {
      // More specific native boundaries are evaluated first: bundled step time
      // must never substitute for a later result or usage boundary time.
      for (const result of step.observation?.results ?? [])
        match(result.extra, step, result.content, undefined, false);
      if (step.metrics)
        match(
          step.metrics.extra,
          step,
          step.metrics,
          step.metrics as Record<string, unknown>,
          false,
        );
      for (const call of step.tool_calls ?? [])
        match(call.extra, step, call.arguments);
      match(step.extra, step, step.message);
    }
    const final = source.trajectory.final_metrics;
    if (final)
      match(
        final.extra,
        undefined,
        final,
        final as Record<string, unknown>,
        false,
      );
    for (const communication of (source.trajectory.extra?.[
      'quorum_communications'
    ] ?? []) as Array<{ evidence: NativeEvidence }>)
      match({ quorum_source: communication.evidence });
    for (const boundary of (source.trajectory.extra?.['quorum_boundaries'] ??
      []) as NativeBoundary[])
      match(
        { quorum_source: boundary.evidence },
        undefined,
        undefined,
        undefined,
        false,
        boundary.durationMs,
      );
    return result;
  };
  const available = (locator: NativeLocator): boolean => {
    if (mapped(locator, [history, current]).length) return true;
    const path =
      declared.get(locator.source) ??
      retained.get(locator.source)?.originalPath ??
      locator.source;
    const row = files.get(path);
    // Non-transcript case/workdir evidence may be literal; native behavior is ATIF only.
    if (!row || row.retainedPath.endsWith('.jsonl')) return false;
    try {
      return (
        fileBytes(row).toString('utf8').split(/\r?\n/)[locator.line - 1] !==
        undefined
      );
    } catch {
      return false;
    }
  };
  assessIdentity(key, review, history, sourceAt, mapped, add);
  for (const finding of [...key.requiredFindings, ...key.negativeControls]) {
    add(
      `finding-evidence:${finding.id}`,
      finding.evidence.length && finding.evidence.every(available)
        ? 'pass'
        : 'incomplete',
      `frozen finding evidence must remain accessible: ${finding.id}`,
    );
  }
  add(
    'required-findings',
    bool(
      key.requiredFindings.every((f) =>
        review.recoveredFindingIds.includes(f.id),
      ),
    ),
    `required findings: ${key.requiredFindings.map((f) => f.id).join(', ')}; recovered: ${review.recoveredFindingIds.join(', ')}`,
  );
  let report: string | undefined;
  const reportRow = files.get(review.reportPath);
  if (!reportRow)
    add(
      'report-delivery',
      'fail',
      `delivered report path not retained: ${review.reportPath}`,
    );
  else {
    try {
      report = fileBytes(reportRow).toString('utf8');
      add(
        'report-identity',
        diagnosisDigest(report) === review.reportSha256 ? 'pass' : 'incomplete',
        'review must bind exact retained report bytes',
      );
      const children = new Set(review.analysts.map((a) => a.childSourceId));
      const delivered = [...current.values()]
        .filter((s) => !children.has(s.row.id))
        .some((s) =>
          s.trajectory?.steps.some(
            (step) =>
              step.source === 'agent' &&
              textOf(step.message).includes(review.reportPath),
          ),
        );
      add(
        'report-delivery',
        delivered
          ? 'pass'
          : current.size && [...current.values()].every((s) => s.trajectory)
            ? 'fail'
            : 'incomplete',
        delivered
          ? `retained and delivered ${review.reportPath}`
          : 'no retained controller delivery of original report path',
      );
    } catch (error) {
      add('report-identity', 'incomplete', err(error));
    }
  }
  if (report !== undefined) assessCoverage(report, review, add);
  for (const claim of review.claims) {
    add(
      `claim:${claim.id}`,
      claim.judgment === 'supported'
        ? 'pass'
        : claim.judgment === 'unsupported'
          ? 'fail'
          : 'incomplete',
      `independent reviewer: ${claim.reason}`,
    );
    for (const [i, citation] of claim.citations.entries()) {
      const name = `citation:${claim.id}:${i}`;
      const absolute =
        declared.get(citation.path) ??
        retained.get(citation.path)?.originalPath ??
        citation.path;
      const row = files.get(absolute);
      const src =
        sourceAt(citation.path, history) ?? sourceAt(citation.path, current);
      try {
        const bytes = row ? fileBytes(row) : src?.bytes;
        if (!bytes) {
          add(name, 'fail', `citation source not retained: ${citation.path}`);
          continue;
        }
        const line = bytes.toString('utf8').split(/\r?\n/)[citation.line - 1];
        const normalized = mapped(
          { source: citation.path, line: citation.line },
          [history, current],
        );
        const matches =
          line !== undefined &&
          (line.includes(citation.quote) ||
            normalized.some((e) => e.text?.includes(citation.quote)));
        add(
          name,
          bool(matches),
          matches
            ? `quote exists at ${citation.path}:${citation.line}; relevance judged independently`
            : `quote absent at ${citation.path}:${citation.line}`,
        );
      } catch (error) {
        add(name, 'incomplete', err(error));
      }
    }
  }
  assessQuantities(key, review, mapped, add);
  assessAnalysts(review, current, files, add);
  for (const [kind, names, items] of [
    ['dimension', DIMENSIONS, review.dimensions],
    ['rubric', RUBRIC, review.rubric],
  ] as const) {
    for (const name of names) {
      const item = (items as Record<string, DiagnosisReview['rubric']['case']>)[
        name
      ];
      if (!item) continue;
      add(
        `${kind}:${name}`,
        item.status,
        `independent reviewer: ${item.reason}`,
      );
      const requiresCurrent =
        kind === 'rubric' &&
        [
          'environment',
          'involvement',
          'contextSafety',
          'scope',
          'exposure',
          'reportDelivery',
        ].includes(name);
      const currentEvidence =
        !requiresCurrent ||
        item.evidence.some((locator) => mapped(locator, [current]).length > 0);
      if (
        !item.evidence.length ||
        !item.evidence.every(available) ||
        !currentEvidence
      )
        add(
          `${kind}:${name}:evidence`,
          'incomplete',
          'review judgment lacks retained source-mapped evidence',
        );
    }
  }
  return finish();
}

type Add = (name: string, status: AssessmentStatus, detail: string) => void;
type MapEvidence = (locator: NativeLocator) => MappedEvidence[];
function assessIdentity(
  key: DiagnosisKey,
  review: DiagnosisReview,
  history: Map<string, Source>,
  sourceAt: (
    path: string,
    population: Map<string, Source>,
  ) => Source | undefined,
  mapped: MapEvidence,
  add: Add,
) {
  const roots = key.sessions.filter((s) => s.role === 'root');
  if (
    roots.length !== 1 ||
    new Set(key.sessions.map((s) => s.id)).size !== key.sessions.length
  ) {
    add(
      'key-sessions',
      'incomplete',
      'key requires one root and unique session ids',
    );
    return;
  }
  const root = roots[0];
  if (!root) return;
  add(
    'target-session',
    bool(root.id === review.targetSessionId),
    `expected ${root.id}; reported ${review.targetSessionId}`,
  );
  const targetSource = sourceAt(root.source, history);
  add(
    'source-path',
    targetSource
      ? bool(targetSource.row.nativePath === review.sourcePath)
      : 'incomplete',
    targetSource
      ? `expected original absolute path ${targetSource.row.nativePath}; reported ${review.sourcePath}`
      : 'target historical source missing',
  );
  const expected = key.sessions
    .filter((s) => s.role !== 'decoy')
    .map((s) => s.id)
    .sort();
  add(
    'historical-sessions',
    bool(same([...review.historicalSessionIds].sort(), expected)),
    `expected historical set ${expected.join(', ')}; reported ${review.historicalSessionIds.join(', ')}`,
  );
  for (const session of key.sessions) {
    const source = sourceAt(session.source, history);
    add(
      `session:${session.id}:evidence`,
      !source?.trajectory
        ? 'incomplete'
        : nativeIdentity(source.trajectory).includes(session.id)
          ? 'pass'
          : 'incomplete',
      `frozen historical identity ${session.id} must match per-source ATIF`,
    );
  }
  add(
    'human-turns',
    bool(
      same(
        review.humanTurnIds,
        key.humanTurns.map((t) => t.id),
      ),
    ),
    'human turn ids must match the key in order; parent/injected turns are separate',
  );
  for (const turn of key.humanTurns) {
    const records = turn.evidence
      .flatMap((locator) => mapped(locator))
      .filter((e) => e.step?.source === 'user' && e.text?.includes(turn.text));
    const human = records.some(
      (e) =>
        e.origin !== 'parent' &&
        e.origin !== 'injected' &&
        (turn.timestamp === null || e.timestamp === turn.timestamp),
    );
    add(
      `human-turn:${turn.id}:evidence`,
      human ? 'pass' : 'incomplete',
      'frozen human text, origin, and native timestamp require historical ATIF support',
    );
  }
}

function assessCoverage(report: string, review: DiagnosisReview, add: Add) {
  const lines = report.split(/\r?\n/);
  const covered = new Array<number>(lines.length).fill(0);
  const problems: string[] = [];
  function span(start: number, end: number) {
    if (end < start || start < 1 || end > lines.length) {
      problems.push(`invalid span ${start}-${end}`);
      return;
    }
    for (let n = start; n <= end; n++)
      covered[n - 1] = (covered[n - 1] ?? 0) + 1;
  }
  for (const claim of review.claims) {
    span(...claim.reportLines);
    if (
      lines.slice(claim.reportLines[0] - 1, claim.reportLines[1]).join('\n') !==
      claim.text
    )
      problems.push(`claim text differs from report span: ${claim.id}`);
  }
  for (const item of review.nonClaimLines) span(item.start, item.end);
  lines.forEach((line, i) => {
    if (line.trim() && covered[i] !== 1)
      problems.push(`line ${i + 1} covered ${covered[i]} times`);
  });
  add(
    'report-coverage',
    problems.length ? 'incomplete' : 'pass',
    problems.join('; ') ||
      'every nonblank line covered once; non-claim classification independently audited in coverage rubric',
  );
  // Recognize literal path:line and Markdown path#Lline citations. This is an
  // extraction consistency check, not a semantic citation or prose parser.
  const missing: string[] = [];
  for (const claim of review.claims) {
    for (const match of claim.text.matchAll(
      /(?:\]\(|`|\s|^)(\/?[^\s`()[\]<>]+?)(?::|#L)(\d+)(?=[\s`),.;\]]|$)/g,
    )) {
      const path = match[1] ?? '';
      const line = Number(match[2]);
      if (!claim.citations.some((c) => c.path === path && c.line === line))
        missing.push(`${claim.id}: ${path}:${line}`);
    }
  }
  add(
    'citation-coverage',
    missing.length ? 'incomplete' : 'pass',
    missing.length
      ? `review omitted report citations: ${missing.join(', ')}`
      : 'recognized citation locators retained; coverage rubric audits all other citation forms',
  );
}

const DISPLAY_UNITS = {
  tokens: ['tokens', 1],
  kTokens: ['tokens', 1000],
  MTokens: ['tokens', 1_000_000],
  ms: ['ms', 1],
  s: ['ms', 1000],
  min: ['ms', 60000],
  bytes: ['bytes', 1],
  KiB: ['bytes', 1024],
  MiB: ['bytes', 1048576],
  count: ['count', 1],
} as const;
function assessQuantities(
  key: DiagnosisKey,
  review: DiagnosisReview,
  mapped: MapEvidence,
  add: Add,
) {
  for (const expected of key.quantities) {
    const name = `quantity:${expected.id}`;
    const observation = review.quantities.find((q) => q.id === expected.id);
    if (!observation) {
      add(name, 'fail', 'required quantity missing from report extraction');
      continue;
    }
    const candidates = [expected, ...(expected.alternatives ?? [])];
    if (new Set(candidates.map((q) => q.scope)).size !== candidates.length) {
      add(
        name,
        'incomplete',
        'frozen quantity contains ambiguous scope alternatives',
      );
      continue;
    }
    const selected = candidates.find((q) => q.scope === observation.scope);
    if (!selected) {
      add(name, 'fail', `unsupported measurement scope: ${observation.scope}`);
      continue;
    }
    const evidenceSets = selected.evidence.map((locator) => mapped(locator));
    const quantityEvidence =
      selected.value === null ||
      expected.unit !== 'tokens' ||
      evidenceSets
        .flat()
        .some(
          (e) =>
            e.metrics &&
            [
              'prompt_tokens',
              'completion_tokens',
              'cached_tokens',
              'total_prompt_tokens',
              'total_completion_tokens',
            ].some((k) => typeof e.metrics?.[k] === 'number'),
        );
    const recordsAvailable =
      evidenceSets.length > 0 && evidenceSets.every((es) => es.length > 0);
    let timeEvidence = true;
    if (selected.measurement === 'native-duration') {
      // The frozen convention identifies a singleton counter, not elapsed time.
      // A timestamp or surviving formatted metadata text cannot replace it.
      timeEvidence =
        evidenceSets.length === 1 &&
        (selected.value === null
          ? evidenceSets.flat().every((e) => e.durationMs === undefined)
          : evidenceSets[0]?.some((e) => e.durationMs === selected.value) ===
            true);
    } else if (selected.measurement === 'elapsed-time') {
      timeEvidence =
        selected.evidence.length === 2 &&
        !same(selected.evidence[0], selected.evidence[1]) &&
        evidenceSets.every((es) =>
          es.some(
            (e) => e.timestamp && Number.isFinite(Date.parse(e.timestamp)),
          ),
        );
    }
    add(
      `${name}:evidence`,
      quantityEvidence && recordsAvailable && timeEvidence
        ? 'pass'
        : 'incomplete',
      selected.measurement === 'native-duration'
        ? 'native-duration requires its exact source-mapped singleton counter; timestamps and rendered metadata are not substitutes'
        : selected.measurement === 'elapsed-time'
          ? 'elapsed-time requires both distinct source-mapped native timestamp endpoints; native counters are not substitutes'
          : 'literal frozen quantity requires its historical ATIF evidence',
    );
    const claim = review.claims.find((c) => c.id === observation.claimId);
    if (!claim) {
      add(
        name,
        'incomplete',
        `quantity has no original claim: ${observation.claimId}`,
      );
      continue;
    }
    let rounded = selected.value;
    if (observation.rounding && selected.value !== null) {
      const display = DISPLAY_UNITS[observation.rounding.unit];
      if (display[0] !== expected.unit) {
        add(
          name,
          'fail',
          `incompatible display unit ${observation.rounding.unit} for ${expected.unit}`,
        );
        continue;
      }
      const { decimalPlaces, mode } = observation.rounding;
      const quantum = display[1] / 10 ** decimalPlaces;
      if (
        mode !== 'nearest' &&
        !new RegExp(
          mode === 'floor'
            ? 'round(?:ed|ing)? down|floor'
            : 'round(?:ed|ing)? up|ceil',
          'i',
        ).test(claim.text)
      ) {
        add(
          name,
          'incomplete',
          `${mode} convention not evidenced in original report claim`,
        );
        continue;
      }
      rounded =
        Math[mode === 'nearest' ? 'round' : mode](selected.value / quantum) *
        quantum;
    }
    // No broad tolerance: compare the declared display grid in base units.
    const equal =
      rounded === observation.value ||
      (rounded !== null &&
        observation.value !== null &&
        Math.abs(rounded - observation.value) <=
          Number.EPSILON * Math.max(1, Math.abs(rounded)));
    if (equal && observation.rounding && observation.value !== null) {
      const { unit, decimalPlaces } = observation.rounding;
      const number = (observation.value / DISPLAY_UNITS[unit][1]).toFixed(
        decimalPlaces,
      );
      const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const unitPattern = {
        tokens: 'tokens?',
        kTokens: '(?:kTokens|k\\s*tokens|thousand tokens)',
        MTokens: '(?:MTokens|M\\s*tokens|million tokens)',
        ms: '(?:ms|milliseconds?)',
        s: '(?:s|seconds?)',
        min: '(?:min|minutes?)',
        bytes: 'bytes?',
        KiB: 'KiB',
        MiB: 'MiB',
        count: '(?:count)?',
      }[unit];
      const displayed = new RegExp(
        `(?:^|[^\\d.])${escaped}\\s*${unitPattern}(?:$|[^a-zA-Z])`,
        'i',
      ).test(claim.text);
      add(
        `${name}:display`,
        displayed ? 'pass' : 'incomplete',
        displayed
          ? 'declared quantity and decimal precision occur in original claim; scope independently reviewed'
          : 'declared rounding quantum/value not evidenced by original display',
      );
    }
    add(
      name,
      bool(equal),
      `scope=${selected.scope}; expected exact=${selected.value}; expected displayed=${rounded}; reported displayed=${observation.value}; unit=${expected.unit}; display=${JSON.stringify(observation.rounding)}`,
    );
  }
  for (const observation of review.quantities)
    if (!review.claims.some((c) => c.id === observation.claimId))
      add(
        `quantity:${observation.id}:claim`,
        'incomplete',
        'extra quantity must retain its original report claim',
      );
}

/** Claude sidechains share session_id but expose their native agent identity. */
function nativeIdentity(t: AtifTrajectory): string[] {
  const ids = t.agent.extra?.['agent_ids'];
  if (
    t.agent.name === 'claude-code' &&
    t.agent.extra?.['is_sidechain'] === true &&
    Array.isArray(ids) &&
    ids.length &&
    ids.every((id) => typeof id === 'string')
  )
    return ids;
  return t.session_id ? [t.session_id] : [];
}

function nativeResultFailed(
  extra: Record<string, unknown> | undefined,
  content: string,
): boolean {
  const isError = (
    extra?.['quorum_result'] as NativeToolResultEvidence | undefined
  )?.isError;
  if (typeof isError === 'boolean') return isError;
  // Compatibility with already-retained ATIF using the normalizers' marker.
  return (
    /^\[error\]/i.test(content.trim()) ||
    /(?:^|\n)\[error\] tool reported failure\s*$/.test(content)
  );
}

function assessAnalysts(
  review: DiagnosisReview,
  current: Map<string, Source>,
  files: Map<string, RetainedArtifact>,
  add: Add,
) {
  const analysts = review.analysts;
  const unique = new Set(analysts.map((a) => a.childSourceId));
  const dispatchKeys = new Set(
    analysts.map((a) =>
      JSON.stringify([a.sourceId, a.dispatchStepId, a.callId, a.batchIndex]),
    ),
  );
  const knownSessions = analysts
    .map((a) => {
      const t = current.get(a.childSourceId)?.trajectory;
      return t ? nativeIdentity(t).join('|') : undefined;
    })
    .filter((id): id is string => !!id);
  const uniqueSessions = new Set(knownSessions);
  add(
    'analyst-executions',
    bool(
      uniqueSessions.size === knownSessions.length &&
        analysts.length === 7 &&
        unique.size === 7 &&
        dispatchKeys.size === 7 &&
        DIMENSIONS.every(
          (d) => analysts.filter((a) => a.dimension === d).length === 1,
        ),
    ),
    'requires seven dimension-specific dispatches and seven distinct linked child sources',
  );
  const casePaths = new Set(analysts.map((a) => a.casePath));
  const commonPaths = new Set(analysts.map((a) => a.commonPath));
  const dimensionPaths = new Set(analysts.map((a) => a.dimensionPath));
  for (const analyst of analysts) {
    const prefix = `analyst:${analyst.dimension}`;
    const dispatcher = current.get(analyst.sourceId);
    const child = current.get(analyst.childSourceId);
    if (!dispatcher?.trajectory || !child?.trajectory) {
      add(
        `${prefix}:source`,
        'incomplete',
        'dispatcher or child evidence unavailable in new-session index',
      );
      continue;
    }
    add(
      `${prefix}:source`,
      'pass',
      `new-session sources ${analyst.sourceId} → ${analyst.childSourceId}`,
    );
    const step = dispatcher.trajectory.steps.find(
      (s) => s.step_id === analyst.dispatchStepId,
    );
    const call = step?.tool_calls?.find(
      (c) => c.tool_call_id === analyst.callId && c.function_name === 'Agent',
    );
    if (!call || !evidence(call.extra)?.lines.length) {
      add(
        `${prefix}:dispatch`,
        'fail',
        'no actual source-scoped canonical Agent call at supplied dispatch',
      );
      continue;
    }
    const dispatches = call.extra?.['quorum_dispatches'] as
      | NativeChildDispatch[]
      | undefined;
    const batch =
      analyst.batchIndex === null
        ? undefined
        : dispatches?.find((d) => d.index === analyst.batchIndex);
    const relationship =
      analyst.batchIndex === null
        ? (call.extra?.['quorum_child'] as NativeChildEvidence | undefined)
        : batch?.child;
    const childMeta = child.trajectory.agent.extra;
    const linked =
      analyst.sourceId !== analyst.childSourceId &&
      !!relationship &&
      ((relationship.id !== undefined &&
        nativeIdentity(child.trajectory).includes(relationship.id)) ||
        (relationship.path !== undefined &&
          relationship.path === child.row.nativePath) ||
        (relationship.name !== undefined &&
          relationship.name === childMeta?.['agent_path'] &&
          childMeta?.['parent_session_id'] ===
            dispatcher.trajectory.session_id));
    add(
      `${prefix}:dispatch`,
      linked
        ? 'pass'
        : relationship &&
            (relationship.id || relationship.name || relationship.path)
          ? 'fail'
          : 'incomplete',
      linked
        ? `native relationship resolves to distinct child; batch index=${analyst.batchIndex}`
        : 'native child relationship unavailable or mismatched',
    );
    const prompt =
      analyst.batchIndex === null ? call.arguments['prompt'] : batch?.prompt;
    const paths = [analyst.casePath, analyst.commonPath, analyst.dimensionPath];
    const pathToken = (text: string, path: string) => {
      const start = text.indexOf(path);
      if (start < 0) return false;
      return (
        !/[\w./-]/.test(text[start + path.length] ?? '') &&
        !/[\w./-]/.test(text[start - 1] ?? '')
      );
    };
    const promptPresent = typeof prompt === 'string' && prompt.length > 0;
    const readInputs = paths.every((path) =>
      child.trajectory?.steps.some((s) =>
        s.tool_calls?.some((c) => {
          const direct =
            c.function_name === 'Read' &&
            (c.arguments['file_path'] === path || c.arguments['path'] === path);
          const shell =
            c.function_name === 'Bash' &&
            typeof c.arguments['command'] === 'string' &&
            /(?:^|[\s;&|])(?:cat|sed|head|tail|rg)\s/.test(
              c.arguments['command'],
            ) &&
            pathToken(c.arguments['command'], path);
          return (
            (direct || shell) &&
            !!evidence(c.extra)?.lines.length &&
            s.observation?.results.some((r) => {
              if (!evidence(r.extra)?.lines.length) return false;
              const composite = c.extra?.['composite_call_id'];
              if (typeof composite === 'string') {
                const outcomes = (
                  r.extra?.['quorum_result'] as
                    | NativeToolResultEvidence
                    | undefined
                )?.subcalls?.filter(
                  (outcome) => outcome.toolCallId === c.tool_call_id,
                );
                // Includes the first logical call, whose id is also the
                // physical result id. Outer success never proves its read.
                return (
                  r.source_call_id === composite &&
                  outcomes?.length === 1 &&
                  outcomes[0]?.isError === false &&
                  outcomes[0].contentBytes > 0 &&
                  textOf(r.content).length > 0
                );
              }
              return (
                r.source_call_id === c.tool_call_id &&
                textOf(r.content).length > 0 &&
                !nativeResultFailed(r.extra, textOf(r.content))
              );
            })
          );
        }),
      ),
    );
    const correctPaths =
      casePaths.size === 1 &&
      commonPaths.size === 1 &&
      dimensionPaths.size === 7 &&
      files.has(analyst.casePath);
    const inputSupported = promptPresent
      ? paths.every((p) => pathToken(prompt, p))
      : readInputs;
    add(
      `${prefix}:inputs`,
      !promptPresent && !readInputs
        ? 'incomplete'
        : bool(correctPaths && inputSupported),
      promptPresent
        ? 'compare exact absolute case/common/dimension inputs in native dispatch; content correctness independently reviewed'
        : `prompt unavailable; exact child reads and result evidence ${readInputs ? 'establish' : 'do not establish'} input consumption`,
    );
    const completion = child.trajectory.steps.find(
      (s) => s.step_id === analyst.completionStepId,
    );
    const completed =
      completion?.source === 'agent' &&
      textOf(completion.message).trim().length > 0 &&
      !completion.tool_calls?.length &&
      !!evidence(completion.extra)?.lines.length;
    add(
      `${prefix}:completion`,
      completed
        ? 'pass'
        : analyst.completionStepId === null &&
            review.dimensions[analyst.dimension].status !== 'fail'
          ? 'incomplete'
          : 'fail',
      completed
        ? 'source-bound child assistant completion retained; substantive analysis independently reviewed'
        : 'no completed analyst assistant response at supplied child step',
    );
  }
}
