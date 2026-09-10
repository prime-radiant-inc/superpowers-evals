import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';
import { z } from 'zod';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import { inspectLock } from '../../../src/appliance/locks.ts';
import { createDurableMarker } from '../../../src/campaign/journal.ts';
import {
  acquireLiveSpendLock,
  type LiveSpendLock,
  realProcessIdentityProbe,
} from '../../../src/campaign/locks.ts';
import { verifyPricingSnapshot } from '../../../src/campaign/pricing-snapshot.ts';
import { EvidenceIndexSchema } from '../../../src/contracts/conversation.ts';
import { GauntletResultSchema } from '../../../src/contracts/gauntlet.ts';
import { GauntletLayerSchema } from '../../../src/contracts/verdict.ts';
import { getEnv } from '../../../src/env.ts';
import { estimateUsageSidecar } from '../../../src/obol/index.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';
import {
  createRoleHeartbeatScheduler,
  retainedRoleEnv,
  runChild,
} from '../../../src/runner/retained-role.ts';
import { gitHead } from '../2026-09-08-conversation-reliability/run.ts';
import { verifyReturnedTurns } from '../../../src/runner/role-usage.ts';

const MODEL = 'anthropic.claude-sonnet-5';
const CHILD_MS = 120_000;
const CLEANUP_MS = 2_000;
const WINDOW_MS = 45 * 60_000;
const PRICING = {
  path: 'docs/experiments/2026-09-06-pr2258-pricing/current.json',
  sha256: '6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b',
};
const IDS = [
  'claude-design',
  'known-claude-design',
  'known-codex-review',
  'codex-design',
  'known-claude-review',
];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const absolute = z
  .string()
  .refine((p) => isAbsolute(p) && normalize(p) === p && !p.includes('\0'));
const timestamp = z.string().datetime();
const money = z.number().finite().nonnegative();
const reference = z.object({ path: absolute, sha256: digest }).strict();
const EntrySchema = z
  .object({
    ordinal: z.number().int().min(1).max(5),
    id: z.string(),
    rubric: absolute,
    evidence_root: absolute,
    evidence_index: absolute,
    scenario_id: z.string().regex(/^[a-zA-Z0-9-]+$/),
    rubric_sha256: digest,
    evidence_index_sha256: digest,
    evidence_sha256: z.record(digest),
  })
  .strict();
const ManifestSchema = z
  .object({
    q_root: absolute,
    g_root: absolute,
    q_sha: sha,
    g_sha: sha,
    experiment_dir: absolute,
    cutoff_at: timestamp,
    model: z.literal(MODEL),
    pricing: z
      .object({
        path: z.literal(PRICING.path),
        sha256: z.literal(PRICING.sha256),
      })
      .strict(),
    authentication_refs: z.array(reference).min(1),
    cases: z.array(EntrySchema).length(5),
  })
  .strict()
  .refine(
    (m) =>
      m.cases.every((row, i) => row.ordinal === i + 1 && row.id === IDS[i]),
    'fixed five case order required',
  );
const WindowSchema = z
  .object({
    manifest_sha256: digest,
    first_launched_at: timestamp,
    deadline_at: timestamp,
  })
  .strict();
const LaunchSchema = z
  .object({
    ordinal: z.number().int().min(1).max(5),
    id: z.string(),
    input_sha256: digest,
    manifest_sha256: digest,
    output_path: absolute,
    launched_at: timestamp,
  })
  .strict();
const OutcomeSchema = z
  .object({
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    spawnError: z.boolean(),
  })
  .strict();
const SettlementSchema = z
  .object({
    launch_sha256: digest,
    outcome: OutcomeSchema,
    result_sha256: digest.nullable(),
    usage_sha256: digest.nullable(),
    run_sha256: digest.nullable(),
    covered_turns: z.number().int().positive().nullable(),
    coverage_complete: z.boolean(),
    cost_usd: money.nullable(),
    cumulative_cost_usd: money,
    prior_semantic_miss: z.boolean(),
    operational_error: z.string().nullable(),
    finished_at: timestamp,
  })
  .strict();
const ReviewSchema = z
  .object({
    result_sha256: digest,
    decision: z.enum(['match', 'semantic_miss']),
    rationale: z.string().trim().min(1).max(2000),
  })
  .strict();
const StopSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('operational'),
      manifest_sha256: digest,
      stopped_at: timestamp,
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gold'),
      manifest_sha256: digest,
      stopped_at: timestamp,
      reason: z.string().min(1),
      evidence_refs: z.array(reference).min(1),
    })
    .strict(),
]);
type Manifest = z.infer<typeof ManifestSchema>;
type Entry = z.infer<typeof EntrySchema>;
type Rubric = { id: string; acceptanceCriteria: string[] };
export type CaseDependencies = {
  now(): number;
  signal: AbortSignal;
  acquireLease(
    onLost: () => void,
  ): Pick<LiveSpendLock, 'heartbeat' | 'release'>;
  graderEnv(): Record<string, string | undefined>;
  child: typeof runChild;
  priceUsage: typeof estimateUsageSidecar;
};
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const objectHash = (value: unknown) => hash(JSON.stringify(value));
const sum = (a: number, b: number) => Math.round((a + b) * 1e10) / 1e10;
const iso = (ms: number) => new Date(ms).toISOString();
function safePath(path: string, directory = false): void {
  absolute.parse(path);
  const stat = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error('unsafe path or symlink');
}
function fileHash(path: string): string {
  safePath(path);
  return hash(readFileSync(path));
}
function optionalHash(path: string): string | null {
  try {
    return fileHash(path);
  } catch {
    return null;
  }
}
function readJson(path: string): unknown {
  safePath(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function marker(path: string, value: unknown): void {
  createDurableMarker(path, `${JSON.stringify(value, null, 2)}\n`);
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
  );
}
function verifySources(m: Manifest): void {
  for (const [root, expected] of [
    [m.q_root, m.q_sha],
    [m.g_root, m.g_sha],
  ] as const) {
    safePath(root, true);
    if (gitHead(root) !== expected) throw new Error('source HEAD changed');
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      env: { PATH: getEnv('PATH') ?? '/usr/bin:/bin', LANG: 'C' },
    });
    if (status.status !== 0 || status.stdout.trim())
      throw new Error('source checkout is not clean');
  }
}
function verifyInputs(m: Manifest): void {
  for (const path of [
    'src/format/story-card.ts',
    'src/util/id.ts',
    'src/index.ts',
  ])
    safePath(join(m.g_root, path));
  verifyPricingSnapshot({ evalsRoot: m.q_root, snapshot: m.pricing });
  safePath(m.experiment_dir, true);
  if ((lstatSync(m.experiment_dir).mode & 0o077) !== 0)
    throw new Error('experiment directory must be private');
  const protectedPaths = [
    m.q_root,
    m.g_root,
    ...m.cases.map((row) => row.evidence_root),
  ];
  if (
    protectedPaths.some(
      (path) =>
        contained(path, m.experiment_dir) || contained(m.experiment_dir, path),
    )
  )
    throw new Error('experiment overlaps source or evidence');
  for (const ref of m.authentication_refs)
    if (fileHash(ref.path) !== ref.sha256)
      throw new Error('authentication reference changed');
  for (const row of m.cases) {
    safePath(row.evidence_root, true);
    if (
      fileHash(row.rubric) !== row.rubric_sha256 ||
      fileHash(row.evidence_index) !== row.evidence_index_sha256
    )
      throw new Error('frozen input changed');
    const index = EvidenceIndexSchema.parse(readJson(row.evidence_index));
    if (index.files.length !== Object.keys(row.evidence_sha256).length)
      throw new Error('indexed file hash coverage mismatch');
    for (const path of index.files) {
      const full = join(row.evidence_root, path);
      if (
        !contained(row.evidence_root, full) ||
        m.authentication_refs.some((ref) => ref.path === full)
      )
        throw new Error('unsafe evidence or exposed independent judgment');
      if (fileHash(full) !== row.evidence_sha256[path])
        throw new Error('indexed evidence changed');
    }
  }
}
/** Assessment adds its result and mandatory run-end obligations to shared coverage. */
export function verifyAssessmentUsage(out: string): number {
  const result = z
    .object({ usage: z.object({ turns: z.number().int().positive() }) })
    .parse(readJson(join(out, 'result.json')));
  for (const name of ['run.jsonl', 'usage.jsonl']) safePath(join(out, name));
  const coverage = verifyReturnedTurns({
    model: MODEL,
    runJsonl: readFileSync(join(out, 'run.jsonl'), 'utf8'),
    usageJsonl: readFileSync(join(out, 'usage.jsonl'), 'utf8'),
  });
  if (
    coverage.runEndTurns === null ||
    coverage.returnedTurns !== result.usage.turns
  )
    throw new Error('incomplete returned-turn coverage');
  return coverage.returnedTurns;
}
function verifyReport(
  out: string,
  rubric: Rubric,
  outcome: z.infer<typeof OutcomeSchema>,
): void {
  const raw = readJson(join(out, 'result.json'));
  const result = GauntletResultSchema.extend({
    scenario: z.string(),
    observations: z.array(z.unknown()),
    summary: z.string().trim().min(1),
    reasoning: z.string().trim().min(1),
    criteria: GauntletLayerSchema.shape.criteria.unwrap(),
  }).parse(raw);
  const criteria = result.criteria;
  if (
    result.runId !== basename(out) ||
    result.scenario !== rubric.id ||
    criteria.length !== rubric.acceptanceCriteria.length ||
    !criteria.length
  )
    throw new Error('report identity or criterion coverage mismatch');
  for (const [i, criterion] of criteria.entries()) {
    if (
      criterion.criterion !== rubric.acceptanceCriteria[i] ||
      !['pass', 'fail', 'unclear'].includes(criterion.verdict) ||
      !criterion.evidence.trim()
    )
      throw new Error('invalid canonical criterion');
  }
  const status = criteria.some((c) => c.verdict === 'fail')
    ? 'fail'
    : criteria.some((c) => c.verdict === 'unclear')
      ? 'investigate'
      : 'pass';
  if (
    result.status !== status ||
    outcome.signal !== null ||
    outcome.spawnError ||
    outcome.timedOut ||
    outcome.code !== (status === 'pass' ? 0 : 1)
  )
    throw new Error('report status or process exit mismatch');
}
async function price(
  path: string,
  deps: CaseDependencies,
): Promise<number | null> {
  try {
    const usage = await deps.priceUsage(path);
    return usage &&
      usage.unpriced_models.length === 0 &&
      usage.est_cost_usd !== null &&
      Number.isFinite(usage.est_cost_usd) &&
      usage.est_cost_usd >= 0
      ? usage.est_cost_usd
      : null;
  } catch {
    return null;
  }
}

/** Admit and settle one predeclared assessment; review and the next invocation belong to the coordinator. */
export async function runAssessmentCase(
  manifestPath: string,
  ordinal: number,
  deps: CaseDependencies,
): Promise<void> {
  z.number().int().min(1).max(5).parse(ordinal);
  const manifestDigest = fileHash(manifestPath);
  const m = ManifestSchema.parse(readJson(manifestPath));
  const revalidate = () => {
    if (fileHash(manifestPath) !== manifestDigest)
      throw new Error('manifest changed');
    verifySources(m);
    verifyInputs(m);
  };
  revalidate();
  const { parseStoryCard } = (await import(
    join(m.g_root, 'src/format/story-card.ts')
  )) as { parseStoryCard(text: string): Rubric };
  const { makeRunId } = (await import(join(m.g_root, 'src/util/id.ts'))) as {
    makeRunId(id: string): string;
  };
  const rubrics = m.cases.map((row) => {
    const rubric = parseStoryCard(readFileSync(row.rubric, 'utf8'));
    if (
      rubric.id !== row.scenario_id ||
      !rubric.acceptanceCriteria.length ||
      rubric.acceptanceCriteria.some((c) => !c.trim())
    )
      throw new Error('rubric identity or empty rubric');
    return rubric;
  });
  const controller = new AbortController();
  const cancel = () => controller.abort(deps.signal.reason ?? 'cancelled');
  deps.signal.addEventListener('abort', cancel, { once: true });
  if (deps.signal.aborted) cancel();
  const stopPath = join(m.experiment_dir, 'stopped.json');
  const stop = (reason: string) => {
    if (!existsSync(stopPath))
      marker(
        stopPath,
        StopSchema.parse({
          kind: 'operational',
          manifest_sha256: manifestDigest,
          stopped_at: iso(deps.now()),
          reason,
        }),
      );
  };
  let lease: ReturnType<CaseDependencies['acquireLease']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let launched = false;
  try {
    lease = deps.acquireLease(() => controller.abort('lease_lost'));
    lease.heartbeat();
    revalidate();
    if (existsSync(stopPath)) {
      StopSchema.parse(readJson(stopPath));
      throw new Error('diagnostic is stopped');
    }
    for (let n = ordinal; n <= 5; n++)
      if (existsSync(join(m.experiment_dir, String(n).padStart(2, '0'))))
        throw new Error('duplicate or out-of-order ordinal');
    const windowPath = join(m.experiment_dir, 'window.json');
    const now = deps.now();
    const window =
      ordinal === 1
        ? WindowSchema.parse({
            manifest_sha256: manifestDigest,
            first_launched_at: iso(now),
            deadline_at: iso(
              Math.min(Date.parse(m.cutoff_at), now + WINDOW_MS),
            ),
          })
        : WindowSchema.parse(readJson(windowPath));
    if (ordinal === 1 && readdirSync(m.experiment_dir).length)
      throw new Error('first launch requires an empty experiment directory');
    const started = Date.parse(window.first_launched_at),
      deadline = Date.parse(window.deadline_at);
    if (
      window.manifest_sha256 !== manifestDigest ||
      started > now ||
      deadline !== Math.min(Date.parse(m.cutoff_at), started + WINDOW_MS)
    )
      throw new Error('frozen window mismatch');
    let cumulative = 0,
      semanticMiss = false,
      lastFinished = started;
    for (let n = 1; n < ordinal; n++) {
      const row = m.cases[n - 1] as Entry,
        rubric = rubrics[n - 1] as Rubric;
      const dir = join(m.experiment_dir, String(n).padStart(2, '0'));
      safePath(dir, true);
      const launchPath = join(dir, 'launch.json');
      const launch = LaunchSchema.parse(readJson(launchPath));
      const settled = SettlementSchema.parse(
        readJson(join(dir, 'settled.json')),
      );
      const review = ReviewSchema.parse(readJson(join(dir, 'review.json')));
      const out = launch.output_path;
      safePath(out, true);
      if (
        launch.ordinal !== n ||
        launch.id !== row.id ||
        launch.manifest_sha256 !== manifestDigest ||
        launch.input_sha256 !== objectHash(row) ||
        dirname(out) !== dir ||
        !basename(out).startsWith(`${rubric.id}_`) ||
        settled.launch_sha256 !== fileHash(launchPath)
      )
        throw new Error('prior launch identity mismatch');
      if (
        Date.parse(launch.launched_at) < lastFinished ||
        Date.parse(settled.finished_at) < Date.parse(launch.launched_at) ||
        Date.parse(settled.finished_at) > now ||
        Date.parse(settled.finished_at) > deadline
      )
        throw new Error('prior receipt timestamp mismatch');
      lastFinished = Date.parse(settled.finished_at);
      if (
        settled.operational_error !== null ||
        !settled.coverage_complete ||
        settled.prior_semantic_miss !== semanticMiss ||
        settled.result_sha256 !== fileHash(join(out, 'result.json')) ||
        settled.usage_sha256 !== fileHash(join(out, 'usage.jsonl')) ||
        settled.run_sha256 !== fileHash(join(out, 'run.jsonl')) ||
        review.result_sha256 !== settled.result_sha256
      )
        throw new Error('prior output evidence changed or incomplete');
      verifyReport(out, rubric, settled.outcome);
      if (verifyAssessmentUsage(out) !== settled.covered_turns)
        throw new Error('prior usage coverage changed');
      const cost = await price(join(out, 'usage.jsonl'), deps);
      if (cost === null || cost !== settled.cost_usd)
        throw new Error('prior usage is unknown or changed');
      cumulative = sum(cumulative, cost);
      if (cumulative !== settled.cumulative_cost_usd)
        throw new Error('prior cumulative cost mismatch');
      semanticMiss ||= review.decision === 'semantic_miss';
    }
    const admit = () => {
      lease?.heartbeat();
      if (controller.signal.aborted)
        throw new Error('assessment cancelled or lease lost');
      if (cumulative >= 4) {
        stop('observed spend threshold reached');
        throw new Error('observed spend threshold reached');
      }
      if (deps.now() + CHILD_MS + CLEANUP_MS > deadline) {
        stop('insufficient remaining time');
        throw new Error('insufficient remaining time');
      }
    };
    admit();
    const entry = m.cases[ordinal - 1] as Entry,
      rubric = rubrics[ordinal - 1] as Rubric;
    const dir = join(m.experiment_dir, String(ordinal).padStart(2, '0'));
    const runId = makeRunId(rubric.id);
    if (
      !new RegExp(`^${rubric.id}_[0-9]{8}T[0-9]{6}Z_[a-z0-9]{4}$`).test(runId)
    )
      throw new Error('invalid allocated run id');
    if (ordinal === 1) marker(windowPath, window);
    mkdirSync(dir, { mode: 0o700 });
    const out = join(dir, runId);
    mkdirSync(out, { mode: 0o700 });
    mkdirSync(join(out, 'home'), { mode: 0o700 });
    mkdirSync(join(out, 'tmp'), { mode: 0o700 });
    revalidate();
    admit();
    const launchPath = join(dir, 'launch.json');
    marker(
      launchPath,
      LaunchSchema.parse({
        ordinal,
        id: entry.id,
        input_sha256: objectHash(entry),
        manifest_sha256: manifestDigest,
        output_path: out,
        launched_at: iso(deps.now()),
      }),
    );
    launched = true;
    timer = setTimeout(
      () => controller.abort('allocation_deadline'),
      Math.max(0, deadline - deps.now()),
    );
    let outcome: z.infer<typeof OutcomeSchema> = {
      code: null,
      signal: null,
      timedOut: false,
      spawnError: true,
    };
    let error: string | null = null;
    try {
      outcome = OutcomeSchema.parse(
        await deps.child({
          args: [
            join(m.g_root, 'src/index.ts'),
            'assess',
            entry.rubric,
            '--evidence-root',
            entry.evidence_root,
            '--evidence-index',
            entry.evidence_index,
            '--out',
            out,
            '--model',
            `agent=${MODEL}`,
            '--max-time',
            '2m',
          ],
          cwd: out,
          env: {
            ...deps.graderEnv(),
            HOME: join(out, 'home'),
            TMPDIR: join(out, 'tmp'),
          },
          signal: controller.signal,
          timeoutMs: CHILD_MS,
        }),
      );
    } catch {
      error = 'child launch failed';
    }
    let covered: number | null = null;
    try {
      covered = verifyAssessmentUsage(out);
    } catch {
      error ??= 'incomplete returned-turn coverage';
    }
    try {
      verifyReport(out, rubric, outcome);
    } catch {
      error ??= 'invalid report or process outcome';
    }
    const cost = await price(join(out, 'usage.jsonl'), deps);
    if (cost === null) error ??= 'unknown usage pricing';
    try {
      lease.heartbeat();
    } catch {
      controller.abort('lease_lost');
    }
    if (controller.signal.aborted) error = String(controller.signal.reason);
    if (deps.now() > deadline) error ??= 'allocation deadline exceeded';
    marker(
      join(dir, 'settled.json'),
      SettlementSchema.parse({
        launch_sha256: fileHash(launchPath),
        outcome,
        result_sha256: optionalHash(join(out, 'result.json')),
        usage_sha256: optionalHash(join(out, 'usage.jsonl')),
        run_sha256: optionalHash(join(out, 'run.jsonl')),
        covered_turns: covered,
        coverage_complete: covered !== null,
        cost_usd: cost,
        cumulative_cost_usd: cost === null ? cumulative : sum(cumulative, cost),
        prior_semantic_miss: semanticMiss,
        operational_error: error,
        finished_at: iso(deps.now()),
      }),
    );
    if (error !== null) {
      stop(error);
      throw new Error(`assessment stopped: ${error}`);
    }
  } catch (error) {
    if (launched) stop('operational failure');
    throw error;
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener('abort', cancel);
    try {
      lease?.release();
    } catch {
      stop('lease release failed');
      throw new Error('lease release failed');
    }
  }
}

async function main(): Promise<void> {
  const [flag, path, ordinal, ...extra] = process.argv.slice(2);
  if (
    flag !== '--execute' ||
    !path ||
    !isAbsolute(path) ||
    !ordinal ||
    !/^[1-5]$/.test(ordinal) ||
    extra.length
  )
    throw new Error(
      'usage: bun run.ts --execute <absolute-manifest.json> <ordinal-1-through-5>',
    );
  if (process.platform !== 'linux')
    throw new Error('retained assessment operator requires Linux');
  const manifest = ManifestSchema.parse(readJson(path));
  if (manifest.q_root !== realpathSync(resolve(import.meta.dir, '../../..')))
    throw new Error('manifest must name this operator checkout');
  const pricing = verifyPricingSnapshot({
    evalsRoot: manifest.q_root,
    snapshot: manifest.pricing,
  });
  if (getEnv('OBOL_PRICING_DIR') !== pricing.directory)
    throw new Error(
      'start Bun with OBOL_PRICING_DIR set to frozen pricing directory',
    );
  const loaded = loadStateConfig(
    '/srv/quorum/pilots/conversation-assessment/config/appliance.json',
  );
  const controller = new AbortController();
  const sigint = () => controller.abort('cancelled:SIGINT'),
    sigterm = () => controller.abort('cancelled:SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    await runAssessmentCase(path, Number(ordinal), {
      now: Date.now,
      signal: controller.signal,
      child: runChild,
      priceUsage: estimateUsageSidecar,
      acquireLease(lost) {
        for (const name of ['run.lock', 'sync.lock']) {
          const lock = inspectLock(join(loaded.paths.locks, name));
          if (lock.state !== 'missing')
            throw new Error(`ordinary ${name} is ${lock.state}`);
        }
        return acquireLiveSpendLock({
          clock: new RealClock(),
          identity: realProcessIdentityProbe,
          scheduler: createRoleHeartbeatScheduler(lost),
        });
      },
      graderEnv() {
        return retainedRoleEnv(
          loaded.config.credential_bundle.path,
          pricing.directory,
        );
      },
    });
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}
if (import.meta.main)
  main().catch(() => {
    process.stderr.write(
      'Retained assessment refused or stopped; inspect private receipts.\n',
    );
    process.exitCode = 1;
  });
