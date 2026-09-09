import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
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
import { inspect } from 'node:util';
import { z } from 'zod';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import { readBundleEnvForProjection } from '../../../src/appliance/credential-scope.ts';
import { inspectLock } from '../../../src/appliance/locks.ts';
import {
  acquireLiveSpendLock,
  type HeartbeatScheduler,
  realProcessIdentityProbe,
} from '../../../src/campaign/locks.ts';
import { verifyPricingSnapshot } from '../../../src/campaign/pricing-snapshot.ts';
import {
  APPLIANCE_SCOPED_GRADER_MODE,
  QUORUM_GRADER_SOURCE_MODE,
  SUPERVISOR_NETWORK_ENV_NAMES,
} from '../../../src/credentials/grader.ts';
import { getEnv } from '../../../src/env.ts';
import { estimateUsageSidecar } from '../../../src/obol/index.ts';
import { gauntletEnvBase } from '../../../src/runner/gauntlet-env.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';

const CANDIDATE_ROOT =
  '/srv/quorum/pilots/conversation-assessment/gauntlet-reliability';
const MODEL = 'anthropic.claude-sonnet-5';
const MANTLE_URL = 'https://bedrock-mantle.us-east-1.api.aws/anthropic';
const PRICING = {
  path: 'docs/experiments/2026-09-06-pr2258-pricing/current.json',
  sha256: '6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b',
};
const LIVE_WINDOW_MS = 4 * 60 * 60_000;
const WINDOW_MS = 90 * 60_000;
const CHILD_MS = 120_000;
const CLEANUP_MS = 2_000;
const ALLOCATION_USD = 8;
const SYSTEM_ENV = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
] as const;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pathString = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'));
const SourcesSchema = z
  .object({
    candidate: z
      .object({
        root: z.literal(CANDIDATE_ROOT),
        sha,
      })
      .strict(),
  })
  .strict();
const CaseSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    rubric: pathString,
    evidence_root: pathString,
    evidence_index: pathString,
    gauntlet_root: pathString,
    gauntlet_sha: sha,
  })
  .strict();
const EnvelopeSchema = z
  .object({
    stage: z.enum(['known', 'controls']),
    q_sha: sha,
    cutoff_at: z.string().datetime(),
    expectations: z.object({ path: pathString, sha256: digest }).strict(),
    sources: SourcesSchema,
    prior_summary: z
      .object({ path: pathString, sha256: digest })
      .strict()
      .optional(),
    cases: z.array(CaseSchema),
  })
  .strict();
type Envelope = z.infer<typeof EnvelopeSchema>;
type PreparedCase = z.infer<typeof CaseSchema> & {
  scenario_id: string;
  input_sha256: string;
};
export type ExecutionInput = Omit<Envelope, 'cases'> & {
  input_dir: string;
  inputs_sha256: string;
  file_hashes: Record<string, string>;
  cases: PreparedCase[];
};
type RubricParser = (text: string) => { id: string };
export type ChildOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: boolean;
};
const RowSchema = z
  .object({
    id: z.string(),
    input_sha256: digest,
    scenario_id: z.string(),
    gauntlet_root: pathString,
    gauntlet_sha: sha,
    process_status: z.enum([
      'graded',
      'instrument_failure',
      'timed_out',
      'lease_lost',
      'cancelled',
    ]),
    assessment_status: z.string().nullable(),
    exit_code: z.number().int().nullable(),
    signal: z.string().nullable(),
    cost_usd: z.number().finite().nonnegative().nullable(),
    output_path: pathString,
    result_sha256: digest.nullable(),
    usage_sha256: digest.nullable(),
  })
  .strict();
const SummarySchema = z
  .object({
    stage: z.enum(['known', 'controls']),
    status: z.enum(['running', 'completed', 'stopped']),
    stop_reason: z.string().nullable(),
    q_sha: sha,
    cutoff_at: z.string().datetime(),
    expectations: z.object({ path: pathString, sha256: digest }).strict(),
    sources: SourcesSchema,
    model: z.literal(MODEL),
    pricing: z
      .object({
        path: z.literal(PRICING.path),
        sha256: z.literal(PRICING.sha256),
      })
      .strict(),
    input_dir: pathString,
    inputs_sha256: digest,
    file_hashes: z.record(digest),
    prior_summary: z
      .object({ path: pathString, sha256: digest })
      .strict()
      .nullable(),
    execution_started_at: z.string().datetime(),
    stage_started_at: z.string().datetime(),
    deadline_at: z.string().datetime(),
    finished_at: z.string().datetime().nullable(),
    prior_cost_usd: z.number().finite().nonnegative(),
    cumulative_cost_usd: z.number().finite().nonnegative(),
    cost_complete: z.boolean(),
    cases: z.array(RowSchema),
  })
  .strict();
export type Summary = z.infer<typeof SummarySchema>;
type Lease = { heartbeat(): void; release(): void };
export type StageDependencies = {
  now(): number;
  signal: AbortSignal;
  acquireLease(lost: () => void): Lease;
  verifyInputs(): void;
  execute(
    entry: PreparedCase,
    out: string,
    signal: AbortSignal,
  ): Promise<ChildOutcome>;
  priceUsage(path: string): Promise<number | null>;
};

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const hashFile = (path: string) => hash(readFileSync(path));
const hashObject = (value: unknown) => hash(JSON.stringify(value));
const totalCost = (a: number, b: number) => Math.round((a + b) * 1e10) / 1e10;
function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith('../') && !isAbsolute(path))
  );
}
function overlaps(a: string, b: string): boolean {
  return contained(a, b) || contained(b, a);
}
function readEnvelope(inputDir: string): Envelope {
  const value = EnvelopeSchema.parse(
    JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')),
  );
  if (value.cases.length !== 12)
    throw new Error('known and controls each require 12 candidate rows');
  if ((value.stage === 'controls') !== (value.prior_summary !== undefined))
    throw new Error('only controls requires a prior known-stage summary');
  if (new Set(value.cases.map((entry) => entry.id)).size !== value.cases.length)
    throw new Error('case ids must be unique');
  for (const entry of value.cases) {
    if (
      !Object.values(value.sources).some(
        (source) =>
          source.root === entry.gauntlet_root &&
          source.sha === entry.gauntlet_sha,
      )
    )
      throw new Error(`unapproved Gauntlet source for ${entry.id}`);
  }
  return value;
}

/** Parse only the frozen case domain; source approvals never supply a command. */
export function loadExecutionInput(
  inputArg: string,
  parseRubric: RubricParser,
): ExecutionInput {
  const inputDir = realpathSync(resolve(inputArg));
  const envelope = readEnvelope(inputDir);
  const files = new Map<string, string>();
  const freeze = (path: string) => {
    const canonical = realpathSync(resolve(inputDir, path));
    if (!statSync(canonical).isFile())
      throw new Error(`input is not a regular file: ${path}`);
    files.set(canonical, hashFile(canonical));
    return canonical;
  };
  freeze('cases.json');
  const expectations = freeze(envelope.expectations.path);
  if (files.get(expectations) !== envelope.expectations.sha256)
    throw new Error('expectation digest mismatch');
  const bundles = new Map<string, Map<string, number>>();
  const cases = envelope.cases.map((entry) => {
    const rubric = freeze(entry.rubric);
    const evidenceRoot = realpathSync(resolve(inputDir, entry.evidence_root));
    const evidenceIndex = freeze(entry.evidence_index);
    const index = z
      .object({ files: z.array(pathString) })
      .strict()
      .parse(JSON.parse(readFileSync(evidenceIndex, 'utf8')));
    if (new Set(index.files).size !== index.files.length)
      throw new Error('duplicate evidence index paths');
    const evidenceHashes: Record<string, string> = {};
    for (const file of index.files) {
      if (
        isAbsolute(file) ||
        normalize(file) !== file ||
        file === '.' ||
        file === '..' ||
        file.startsWith('../')
      )
        throw new Error(
          'evidence index paths must be normalized relative paths',
        );
      const path = resolve(evidenceRoot, file);
      if (
        lstatSync(path).isSymbolicLink() ||
        !contained(evidenceRoot, realpathSync(path))
      )
        throw new Error('evidence index escapes its root or names a symlink');
      const canonical = freeze(path);
      evidenceHashes[file] = files.get(canonical)!;
    }
    const scenario = parseRubric(readFileSync(rubric, 'utf8')).id;
    if (!/^[a-zA-Z0-9-]+$/.test(scenario))
      throw new Error('rubric ID must be a Gauntlet card ID');
    const prepared = {
      ...entry,
      rubric,
      evidence_root: evidenceRoot,
      evidence_index: evidenceIndex,
      scenario_id: scenario,
    };
    const bundle = hashObject([rubric, evidenceRoot, evidenceIndex]);
    const versions = bundles.get(bundle) ?? new Map<string, number>();
    versions.set(
      entry.gauntlet_sha,
      (versions.get(entry.gauntlet_sha) ?? 0) + 1,
    );
    bundles.set(bundle, versions);
    return {
      ...prepared,
      input_sha256: hashObject([
        prepared,
        files.get(rubric),
        files.get(evidenceIndex),
        evidenceHashes,
      ]),
    };
  });
  if (
    bundles.size !== 6 ||
    [...bundles.values()].some(
      (versions) =>
        versions.size !== 1 ||
        [...versions.values()].some((count) => count !== 2),
    )
  )
    throw new Error(
      'each evidence bundle requires the candidate source and exactly two repetitions',
    );
  const fileHashes = Object.fromEntries(
    [...files.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    ...envelope,
    expectations: { ...envelope.expectations, path: expectations },
    ...(envelope.prior_summary
      ? {
          prior_summary: {
            ...envelope.prior_summary,
            path: realpathSync(resolve(inputDir, envelope.prior_summary.path)),
          },
        }
      : {}),
    input_dir: inputDir,
    cases,
    file_hashes: fileHashes,
    inputs_sha256: hashObject(fileHashes),
  };
}

export function gitHead(root: string): string {
  const env = { PATH: getEnv('PATH') ?? '/usr/bin:/bin', LANG: 'C' };
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) throw new Error(`cannot read source ref at ${root}`);
  if (
    spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'], { env })
      .status !== 0
  )
    throw new Error(`tracked source changes at ${root}`);
  return result.stdout.trim();
}
function verifySources(input: Envelope, qRoot: string): void {
  if (gitHead(qRoot) !== input.q_sha)
    throw new Error('installed Quorum ref does not match frozen q_sha');
  for (const source of Object.values(input.sources)) {
    if (
      realpathSync(source.root) !== source.root ||
      gitHead(source.root) !== source.sha
    )
      throw new Error(
        `installed Gauntlet source does not match frozen approval at ${source.root}`,
      );
  }
}

export function createOutputRoot(
  input: ExecutionInput,
  outputArg: string,
): string {
  const requested = resolve(outputArg);
  const output = join(realpathSync(dirname(requested)), basename(requested));
  const protectedPaths = [
    input.input_dir,
    ...Object.keys(input.file_hashes),
    ...Object.values(input.sources).map((source) => source.root),
    ...input.cases.map((entry) => dirname(entry.evidence_root)),
  ];
  if (input.prior_summary)
    protectedPaths.push(dirname(input.prior_summary.path));
  if (protectedPaths.some((path) => overlaps(path, output)))
    throw new Error(
      'outputdir must be separate from inputs, source roots and retained evidence',
    );
  // Exclusive mkdir rejects both reused outputs and symlink substitutions.
  mkdirSync(output, { mode: 0o700 });
  return output;
}
function freshRunDir(root: string, scenario: string, now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return join(root, `${scenario}_${stamp}_${randomUUID().slice(0, 4)}`);
}
function fileDigestOrNull(path: string): string | null {
  try {
    return hashFile(path);
  } catch {
    return null;
  }
}
function resultStatus(path: string): string | null {
  try {
    const value = z
      .object({ status: z.string() })
      .parse(JSON.parse(readFileSync(path, 'utf8')));
    return value.status;
  } catch {
    return null;
  }
}
function validGrade(
  code: number | null,
  signal: string | null,
  status: string | null,
): boolean {
  return (
    signal === null &&
    ((code === 0 && status === 'pass') || (code === 1 && status === 'fail'))
  );
}
function writeSummary(root: string, summary: Summary): void {
  const tmp = join(root, '.summary.tmp');
  writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(root, 'summary.json'));
}

/** Rederive the prior stage's costs from its exact outputs before any new call. */
export async function validatePriorSummary(
  input: ExecutionInput,
  priceUsage: StageDependencies['priceUsage'],
  parseRubric: RubricParser,
  now: number,
): Promise<Summary | undefined> {
  if (input.stage === 'known') return undefined;
  const prior = input.prior_summary;
  if (!prior || hashFile(prior.path) !== prior.sha256)
    throw new Error('prior summary digest mismatch');
  const summary = SummarySchema.parse(
    JSON.parse(readFileSync(prior.path, 'utf8')),
  );
  if (
    summary.stage !== 'known' ||
    summary.status !== 'completed' ||
    summary.stop_reason !== 'completed' ||
    !summary.cost_complete ||
    summary.cases.length !== 12 ||
    summary.prior_summary !== null ||
    summary.prior_cost_usd !== 0
  )
    throw new Error('prior known stage is not complete and priced');
  if (
    summary.q_sha !== input.q_sha ||
    summary.cutoff_at !== input.cutoff_at ||
    summary.expectations.sha256 !== input.expectations.sha256 ||
    hashObject(summary.sources) !== hashObject(input.sources) ||
    hashObject(summary.pricing) !== hashObject(PRICING)
  )
    throw new Error('prior stage source or pricing identity mismatch');
  const known = loadExecutionInput(summary.input_dir, parseRubric);
  if (
    known.stage !== 'known' ||
    known.q_sha !== summary.q_sha ||
    hashObject(known.sources) !== hashObject(summary.sources) ||
    known.inputs_sha256 !== summary.inputs_sha256 ||
    hashObject(known.file_hashes) !== hashObject(summary.file_hashes)
  )
    throw new Error('prior frozen input identity mismatch');
  const started = Date.parse(summary.execution_started_at);
  const cutoff = Date.parse(summary.cutoff_at);
  const finished =
    summary.finished_at === null ? NaN : Date.parse(summary.finished_at);
  if (
    summary.stage_started_at !== summary.execution_started_at ||
    !Number.isFinite(finished) ||
    finished < started ||
    finished > now ||
    started >= cutoff ||
    cutoff - started > LIVE_WINDOW_MS ||
    Date.parse(summary.deadline_at) !== Math.min(started + WINDOW_MS, cutoff) ||
    finished > Date.parse(summary.deadline_at)
  )
    throw new Error('prior stage execution timestamps are inconsistent');
  const outputPaths = new Set<string>();
  let cost = 0;
  for (const [i, row] of summary.cases.entries()) {
    const entry = known.cases[i];
    if (
      !entry ||
      row.id !== entry.id ||
      row.input_sha256 !== entry.input_sha256 ||
      row.scenario_id !== entry.scenario_id ||
      row.gauntlet_root !== entry.gauntlet_root ||
      row.gauntlet_sha !== entry.gauntlet_sha ||
      row.process_status !== 'graded' ||
      row.cost_usd === null ||
      !validGrade(row.exit_code, row.signal, row.assessment_status)
    )
      throw new Error(
        'prior stage does not contain the complete graded row set',
      );
    const output = realpathSync(row.output_path);
    if (
      output !== row.output_path ||
      dirname(output) !== dirname(prior.path) ||
      outputPaths.has(output) ||
      !basename(output).startsWith(`${entry.scenario_id}_`)
    )
      throw new Error('prior output path is reused or inconsistent');
    outputPaths.add(output);
    const result = join(output, 'result.json');
    const usage = join(output, 'usage.jsonl');
    if (
      row.result_sha256 === null ||
      row.usage_sha256 === null ||
      hashFile(result) !== row.result_sha256 ||
      hashFile(usage) !== row.usage_sha256 ||
      resultStatus(result) !== row.assessment_status
    )
      throw new Error('prior output evidence is missing or changed');
    const observed = await priceUsage(usage);
    if (
      observed === null ||
      !Number.isFinite(observed) ||
      observed < 0 ||
      observed !== row.cost_usd
    )
      throw new Error('prior usage is missing, unpriced or inconsistent');
    cost = totalCost(cost, observed);
  }
  if (cost !== summary.cumulative_cost_usd)
    throw new Error('prior cumulative spend is inconsistent');
  return summary;
}

/** Every termination waits for child close, retaining the external two-minute bound. */
export async function runChild(options: {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ChildOutcome> {
  const cancellationSignal = (): NodeJS.Signals =>
    options.signal.reason === 'cancelled:SIGINT' ? 'SIGINT' : 'SIGTERM';
  if (options.signal.aborted)
    return {
      code: null,
      signal: cancellationSignal(),
      timedOut: false,
      spawnError: false,
    };
  const logs: number[] = [];
  try {
    const stdout = openSync(join(options.cwd, 'child.stdout.log'), 'wx', 0o600);
    logs.push(stdout);
    const stderr = openSync(join(options.cwd, 'child.stderr.log'), 'wx', 0o600);
    logs.push(stderr);
    let spawnFailure: Error | undefined;
    const outcome = await new Promise<ChildOutcome>((done) => {
      const child = spawn(process.execPath, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', stdout, stderr],
      });
      let timedOut = false;
      let spawnError = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (signal: NodeJS.Signals) => {
        child.kill(signal);
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), CLEANUP_MS);
      };
      const abort = () => terminate(cancellationSignal());
      options.signal.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
      }, options.timeoutMs ?? CHILD_MS);
      child.once('error', (error) => {
        spawnError = true;
        spawnFailure = error;
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        options.signal.removeEventListener('abort', abort);
        done({ code, signal, timedOut, spawnError });
      });
      if (options.signal.aborted) abort();
    });
    if (spawnFailure) writeFileSync(stderr, `${inspect(spawnFailure)}\n`);
    return outcome;
  } finally {
    for (const fd of logs) closeSync(fd);
  }
}

/** One sequential stage; completion requires all planned grades and priced usage. */
export async function executeStage(
  input: ExecutionInput,
  outputRoot: string,
  deps: StageDependencies,
  prior?: Summary,
): Promise<Summary> {
  if ((input.stage === 'controls') !== (prior !== undefined))
    throw new Error('controls require a verified known-stage summary');
  const now = deps.now();
  const started = prior ? Date.parse(prior.execution_started_at) : now;
  const cutoff = Date.parse(input.cutoff_at);
  if (!prior && cutoff - started > LIVE_WINDOW_MS)
    throw new Error('frozen cutoff exceeds the four-hour live window');
  const deadline = Math.min(started + WINDOW_MS, cutoff);
  const summary: Summary = {
    stage: input.stage,
    status: 'running',
    stop_reason: null,
    q_sha: input.q_sha,
    cutoff_at: input.cutoff_at,
    expectations: input.expectations,
    sources: input.sources,
    model: MODEL,
    pricing: PRICING,
    input_dir: input.input_dir,
    inputs_sha256: input.inputs_sha256,
    file_hashes: input.file_hashes,
    prior_summary: input.prior_summary ?? null,
    execution_started_at: new Date(started).toISOString(),
    stage_started_at: new Date(now).toISOString(),
    deadline_at: new Date(deadline).toISOString(),
    finished_at: null,
    prior_cost_usd: prior?.cumulative_cost_usd ?? 0,
    cumulative_cost_usd: prior?.cumulative_cost_usd ?? 0,
    cost_complete: true,
    cases: [],
  };
  const controller = new AbortController();
  const stop = (reason: string) => {
    summary.stop_reason ??= reason;
    controller.abort(reason);
  };
  const cancel = () =>
    stop(
      typeof deps.signal.reason === 'string' ? deps.signal.reason : 'cancelled',
    );
  deps.signal.addEventListener('abort', cancel, { once: true });
  if (deps.signal.aborted) cancel();
  const cutoffTimer = setTimeout(
    () => stop('execution_deadline'),
    Math.max(0, deadline - deps.now()),
  );
  // Error details may contain provider data; only the private artifact retains them.
  const diagnostics: { context: string; detail: string }[] = [];
  const recordError = (context: string, error: unknown) => {
    diagnostics.push({ context, detail: inspect(error) });
  };
  let context = 'write initial summary';
  let lease: Lease | undefined;
  const heartbeat = () => {
    try {
      lease?.heartbeat();
    } catch (error) {
      recordError('lease heartbeat', error);
      stop('lease_lost');
    }
  };
  try {
    writeSummary(outputRoot, summary);
    context = 'acquire lease';
    lease = deps.acquireLease(() => stop('lease_lost'));
    for (const entry of input.cases) {
      if (controller.signal.aborted) break;
      if (summary.cumulative_cost_usd >= ALLOCATION_USD) {
        stop('cost_threshold_reached');
        break;
      }
      if (deps.now() + CHILD_MS + CLEANUP_MS > deadline) {
        stop('insufficient_time');
        break;
      }
      heartbeat();
      if (controller.signal.aborted) break;
      context = `verify inputs for ${entry.id}`;
      deps.verifyInputs();
      if (deps.now() + CHILD_MS + CLEANUP_MS > deadline) {
        stop('insufficient_time');
        break;
      }
      context = `prepare output for ${entry.id}`;
      const out = freshRunDir(outputRoot, entry.scenario_id, deps.now());
      mkdirSync(out, { mode: 0o700 });
      mkdirSync(join(out, 'home'), { mode: 0o700 });
      mkdirSync(join(out, 'tmp'), { mode: 0o700 });
      let outcome: ChildOutcome;
      try {
        outcome = await deps.execute(entry, out, controller.signal);
      } catch (error) {
        recordError(`execute ${entry.id}`, error);
        outcome = {
          code: null,
          signal: null,
          timedOut: false,
          spawnError: true,
        };
      }
      context = `record outcome for ${entry.id}`;
      // Price the just-finished call even when the lease was lost during it.
      heartbeat();
      const status = resultStatus(join(out, 'result.json'));
      let cost: number | null = null;
      try {
        cost = await deps.priceUsage(join(out, 'usage.jsonl'));
      } catch (error) {
        recordError(`price usage for ${entry.id}`, error);
        /* An unknown bill stops the stage. */
      }
      if (cost !== null && (!Number.isFinite(cost) || cost < 0)) cost = null;
      if (cost === null) summary.cost_complete = false;
      else
        summary.cumulative_cost_usd = totalCost(
          summary.cumulative_cost_usd,
          cost,
        );
      const processStatus =
        summary.stop_reason === 'lease_lost'
          ? 'lease_lost'
          : controller.signal.aborted
            ? 'cancelled'
            : outcome.timedOut
              ? 'timed_out'
              : outcome.spawnError ||
                  !validGrade(outcome.code, outcome.signal, status)
                ? 'instrument_failure'
                : 'graded';
      summary.cases.push({
        id: entry.id,
        input_sha256: entry.input_sha256,
        scenario_id: entry.scenario_id,
        gauntlet_root: entry.gauntlet_root,
        gauntlet_sha: entry.gauntlet_sha,
        process_status: processStatus,
        assessment_status: status,
        exit_code: outcome.code,
        signal: outcome.signal,
        cost_usd: cost,
        output_path: out,
        result_sha256: fileDigestOrNull(join(out, 'result.json')),
        usage_sha256: fileDigestOrNull(join(out, 'usage.jsonl')),
      });
      if (processStatus !== 'graded') stop(processStatus);
      else if (cost === null) stop('missing_or_unpriced_usage');
      context = `write summary for ${entry.id}`;
      writeSummary(outputRoot, summary);
    }
  } catch (error) {
    recordError(context, error);
    stop('instrument_failure');
  } finally {
    clearTimeout(cutoffTimer);
    deps.signal.removeEventListener('abort', cancel);
    try {
      lease?.release();
    } catch (error) {
      recordError('release lease', error);
      summary.stop_reason =
        summary.stop_reason === null
          ? 'lease_release_failure'
          : `${summary.stop_reason};lease_release_failure`;
    }
    summary.status =
      summary.stop_reason === null &&
      summary.cases.length === input.cases.length &&
      summary.cost_complete
        ? 'completed'
        : 'stopped';
    summary.stop_reason ??=
      summary.status === 'completed' ? 'completed' : 'instrument_failure';
    summary.finished_at = new Date(deps.now()).toISOString();
    writeSummary(outputRoot, summary);
    if (diagnostics.length > 0)
      writeFileSync(
        join(outputRoot, 'diagnostics.jsonl'),
        `${diagnostics.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        { mode: 0o600, flag: 'wx' },
      );
  }
  return summary;
}

async function pricedUsage(path: string): Promise<number | null> {
  const usage = await estimateUsageSidecar(path);
  return usage?.unpriced_models.length === 0 ? usage.est_cost_usd : null;
}

/** Keep ownership loss inside the operator cancellation path. */
export function createRetainedAssessmentHeartbeatScheduler(
  lost: () => void,
): HeartbeatScheduler {
  return {
    every(ms, beat) {
      const timer = setInterval(() => {
        try {
          beat();
        } catch {
          lost();
        }
      }, ms);
      return () => clearInterval(timer);
    },
  };
}

/** Project the blessed retained-assessment credential and network policy. */
export function retainedAssessmentEnv(
  bundlePath: string,
  pricingDirectory: string,
): Record<string, string | undefined> {
  const names = ['AWS_BEARER_TOKEN_BEDROCK', ...SUPERVISOR_NETWORK_ENV_NAMES];
  const bundle = readBundleEnvForProjection(bundlePath, names);
  const bearer = bundle.get('AWS_BEARER_TOKEN_BEDROCK');
  if (!bearer) throw new Error('blessed bundle has no Bedrock bearer');
  const source: Record<string, string | undefined> = {
    [QUORUM_GRADER_SOURCE_MODE]: APPLIANCE_SCOPED_GRADER_MODE,
    QUORUM_GRADER_ANTHROPIC_API_KEY: bearer,
    QUORUM_GRADER_ANTHROPIC_BASE_URL: MANTLE_URL,
  };
  for (const name of SYSTEM_ENV) source[name] = getEnv(name);
  for (const name of SUPERVISOR_NETWORK_ENV_NAMES)
    source[name] = bundle.get(name);
  return {
    ...gauntletEnvBase(source),
    OBOL_PRICING_DIR: pricingDirectory,
  };
}

async function main(): Promise<void> {
  const [flag, inputArg, outputArg, ...extra] = process.argv.slice(2);
  if (flag !== '--execute' || !inputArg || !outputArg || extra.length)
    throw new Error('usage: bun run.ts --execute <inputdir> <outputdir>');
  if (process.platform !== 'linux')
    throw new Error('retained assessment operator requires Linux');
  const inputDir = realpathSync(resolve(inputArg));
  const qRoot = resolve(import.meta.dir, '../../..');
  const envelope = readEnvelope(inputDir);
  // The parser import is allowed only from the owned, exact checked candidate.
  verifySources(envelope, qRoot);
  const parser = (await import(
    join(CANDIDATE_ROOT, 'src/format/story-card.ts')
  )) as { parseStoryCard: RubricParser };
  const input = loadExecutionInput(inputDir, parser.parseStoryCard);
  const pricing = verifyPricingSnapshot({
    evalsRoot: qRoot,
    snapshot: PRICING,
  });
  if (getEnv('OBOL_PRICING_DIR') !== pricing.directory)
    throw new Error(
      'start Bun with OBOL_PRICING_DIR set to the frozen pricing directory',
    );
  const prior = await validatePriorSummary(
    input,
    pricedUsage,
    parser.parseStoryCard,
    Date.now(),
  );
  const loaded = loadStateConfig(
    '/srv/quorum/pilots/conversation-assessment/config/appliance.json',
  );
  const runLock = inspectLock(join(loaded.paths.locks, 'run.lock'));
  if (runLock.state !== 'missing')
    throw new Error(
      `ordinary run lock is ${runLock.state}; refusing retained assessment`,
    );
  const outputRoot = createOutputRoot(input, outputArg);
  const controller = new AbortController();
  const onSigint = () => controller.abort('cancelled:SIGINT');
  const onSigterm = () => controller.abort('cancelled:SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let env: Record<string, string | undefined> = {};
  try {
    const summary = await executeStage(
      input,
      outputRoot,
      {
        now: Date.now,
        signal: controller.signal,
        acquireLease(lost) {
          return acquireLiveSpendLock({
            clock: new RealClock(),
            identity: realProcessIdentityProbe,
            scheduler: createRetainedAssessmentHeartbeatScheduler(lost),
          });
        },
        verifyInputs() {
          verifySources(input, qRoot);
          if (
            loadExecutionInput(inputDir, parser.parseStoryCard)
              .inputs_sha256 !== input.inputs_sha256
          )
            throw new Error('frozen assessment input bytes changed');
        },
        async execute(entry, out, signal) {
          if (Object.keys(env).length === 0) {
            env = retainedAssessmentEnv(
              loaded.config.credential_bundle.path,
              pricing.directory,
            );
          }
          return await runChild({
            args: [
              join(entry.gauntlet_root, 'src/index.ts'),
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
            env: { ...env, HOME: join(out, 'home'), TMPDIR: join(out, 'tmp') },
            cwd: out,
            signal,
          });
        },
        priceUsage: pricedUsage,
      },
      prior,
    );
    if (summary.status !== 'completed')
      throw new Error(`retained assessment stopped: ${summary.stop_reason}`);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
