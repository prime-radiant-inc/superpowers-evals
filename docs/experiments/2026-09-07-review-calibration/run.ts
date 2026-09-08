import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { inspectLock } from '../../../src/appliance/locks.ts';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import { readBundleEnvForProjection } from '../../../src/appliance/credential-scope.ts';
import {
  APPLIANCE_SCOPED_GRADER_MODE,
  QUORUM_GRADER_SOURCE_MODE,
  SUPERVISOR_NETWORK_ENV_NAMES,
} from '../../../src/credentials/grader.ts';
import { getEnv } from '../../../src/env.ts';
import {
  acquireLiveSpendLock,
  realProcessIdentityProbe,
} from '../../../src/campaign/locks.ts';
import { verifyPricingSnapshot } from '../../../src/campaign/pricing-snapshot.ts';
import { estimateUsageSidecar } from '../../../src/obol/index.ts';
import { gauntletEnvBase } from '../../../src/runner/gauntlet-env.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';

const EXPECTED_Q = '5ec5784fb06655c07b8cd3f9d7c4390a987e9155';
const EXPECTED_G = '74d2037aed14f413db482b7635783e4e0498c316';
const G_ROOT = '/srv/quorum/pilots/conversation-assessment/gauntlet';
const MODEL = 'anthropic.claude-sonnet-5';
const MANTLE_URL = 'https://bedrock-mantle.us-east-1.api.aws/anthropic';
const PRICING = {
  path: 'docs/experiments/2026-09-06-pr2258-pricing/current.json',
  sha256: '6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b',
};
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

type Case = {
  id: string;
  rubric: string;
  evidence_root: string;
  evidence_index: string;
};
type Row = {
  id: string;
  process_status: string;
  assessment_status: string | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  cost_usd: number | null;
  output_path: string;
};

function parseCases(inputDir: string): Case[] {
  const value: unknown = JSON.parse(
    readFileSync(join(inputDir, 'cases.json'), 'utf8'),
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('cases' in value) ||
    !Array.isArray(value.cases)
  )
    throw new Error('cases.json must contain a cases array');
  if (value.cases.length === 0 || value.cases.length > 8)
    throw new Error('cases.json must contain between one and eight cases');
  const cases = value.cases.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`cases[${i}] must be an object`);
    for (const key of [
      'id',
      'rubric',
      'evidence_root',
      'evidence_index',
    ] as const)
      if (typeof entry[key] !== 'string' || entry[key] === '')
        throw new Error(`cases[${i}].${key} must be nonempty`);
    return entry as Case;
  });
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length)
    throw new Error('case ids must be unique');
  return cases.map((entry) => ({
    ...entry,
    rubric: realpathSync(resolve(inputDir, entry.rubric)),
    evidence_root: realpathSync(resolve(inputDir, entry.evidence_root)),
    evidence_index: realpathSync(resolve(inputDir, entry.evidence_index)),
  }));
}

function gitHead(root: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { PATH: getEnv('PATH') ?? '/usr/bin:/bin', LANG: 'C' },
  });
  if (result.status !== 0) throw new Error(`cannot read source ref at ${root}`);
  const clean = spawnSync(
    'git',
    ['-C', root, 'diff', '--quiet', 'HEAD', '--'],
    {
      env: { PATH: getEnv('PATH') ?? '/usr/bin:/bin', LANG: 'C' },
    },
  );
  if (clean.status !== 0) throw new Error(`tracked source changes at ${root}`);
  return result.stdout.trim();
}

function freshRunDir(outputRoot: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return join(
    outputRoot,
    `conversation-code-review_${stamp}_${randomUUID().slice(0, 4)}`,
  );
}

function resultStatus(path: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || !('status' in value))
      return null;
    return typeof value.status === 'string' ? value.status : null;
  } catch {
    return null;
  }
}

let active: ChildProcess | null = null;
let stoppingSignal: NodeJS.Signals | null = null;
let stopActive: ((signal: NodeJS.Signals) => void) | null = null;
function forward(signal: NodeJS.Signals): void {
  stoppingSignal = signal;
  stopActive?.(signal);
}
const onSigint = () => forward('SIGINT');
const onSigterm = () => forward('SIGTERM');

async function runCase(
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: boolean;
}> {
  let timedOut = false;
  let spawnError = false;
  return await new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'ignore' });
    active = child;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      child.kill(signal);
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    stopActive = terminate;
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
    }, 120_000);
    child.once('error', () => {
      spawnError = true;
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      if (active === child) active = null;
      if (stopActive === terminate) stopActive = null;
      done({ code, signal, timedOut, spawnError });
    });
  });
}

async function main(): Promise<void> {
  const [flag, inputArg, outputArg, ...extra] = process.argv.slice(2);
  if (flag !== '--execute' || !inputArg || !outputArg || extra.length)
    throw new Error('usage: bun run.ts --execute <inputdir> <outputdir>');
  if (process.platform !== 'linux')
    throw new Error('calibration runner requires Linux');
  const inputDir = realpathSync(resolve(inputArg));
  const requestedOutput = resolve(outputArg);
  const outputRoot = join(
    realpathSync(dirname(requestedOutput)),
    basename(requestedOutput),
  );
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  if (overlaps(inputDir, outputRoot) || overlaps(outputRoot, inputDir))
    throw new Error('outputdir must be separate from inputdir');
  const cases = parseCases(inputDir);
  for (const entry of cases) {
    for (const source of [
      dirname(entry.evidence_root),
      entry.rubric,
      entry.evidence_index,
    ]) {
      if (overlaps(source, outputRoot) || overlaps(outputRoot, source))
        throw new Error(
          'outputdir overlaps retained evidence or assessment inputs',
        );
    }
  }
  const qRoot = resolve(import.meta.dir, '../../..');
  if (gitHead(qRoot) !== EXPECTED_Q || gitHead(G_ROOT) !== EXPECTED_G)
    throw new Error(
      'installed pilot source refs do not match the frozen Q/G refs',
    );
  const pricing = verifyPricingSnapshot({
    evalsRoot: qRoot,
    snapshot: PRICING,
  });
  if (getEnv('OBOL_PRICING_DIR') !== pricing.directory)
    throw new Error(
      'start Bun with OBOL_PRICING_DIR set to the frozen pricing directory',
    );
  const loaded = loadStateConfig(
    '/srv/quorum/pilots/conversation-assessment/config/appliance.json',
  );
  const runLock = inspectLock(join(loaded.paths.locks, 'run.lock'));
  if (runLock.state !== 'missing')
    throw new Error(
      `ordinary run lock is ${runLock.state}; refusing calibration`,
    );
  mkdirSync(outputRoot, { mode: 0o700 });

  const summary: {
    q_sha: string;
    g_sha: string;
    model: string;
    cumulative_cost_usd: number;
    stop_reason: string | null;
    cases: Row[];
  } = {
    q_sha: EXPECTED_Q,
    g_sha: EXPECTED_G,
    model: MODEL,
    cumulative_cost_usd: 0,
    stop_reason: null,
    cases: [],
  };
  const writeSummary = () => {
    const tmp = join(outputRoot, '.summary.tmp');
    writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, join(outputRoot, 'summary.json'));
  };
  writeSummary();
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let lease: ReturnType<typeof acquireLiveSpendLock> | undefined;
  let failed = false;
  let leaseLost = false;
  try {
    lease = acquireLiveSpendLock({
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
      scheduler: {
        every(ms, beat) {
          const timer = setInterval(() => {
            try {
              beat();
            } catch {
              leaseLost = true;
              summary.stop_reason = 'lease_lost';
              forward('SIGTERM');
            }
          }, ms);
          return () => clearInterval(timer);
        },
      },
    });
    const names = ['AWS_BEARER_TOKEN_BEDROCK', ...SUPERVISOR_NETWORK_ENV_NAMES];
    const bundle = readBundleEnvForProjection(
      loaded.config.credential_bundle.path,
      names,
    );
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
    const env = {
      ...gauntletEnvBase(source),
      OBOL_PRICING_DIR: pricing.directory,
    };
    for (const entry of cases) {
      if (stoppingSignal) {
        summary.stop_reason = `cancelled:${stoppingSignal}`;
        break;
      }
      lease.heartbeat();
      const out = freshRunDir(outputRoot);
      mkdirSync(out, { mode: 0o700 });
      const home = join(out, 'home');
      const tmp = join(out, 'tmp');
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(tmp, { mode: 0o700 });
      const outcome = await runCase(
        [
          join(G_ROOT, 'src/index.ts'),
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
        { ...env, HOME: home, TMPDIR: tmp },
        out,
      );
      if (!leaseLost) lease.heartbeat();
      const status = resultStatus(join(out, 'result.json'));
      const usage = await estimateUsageSidecar(join(out, 'usage.jsonl'));
      const cost =
        usage?.unpriced_models.length === 0 ? usage.est_cost_usd : null;
      if (cost !== null) summary.cumulative_cost_usd += cost;
      const validGrade =
        (outcome.code === 0 && status === 'pass') ||
        (outcome.code === 1 && status === 'fail');
      const processStatus = leaseLost
        ? 'lease_lost'
        : stoppingSignal
          ? 'cancelled'
          : outcome.timedOut
            ? 'timed_out'
            : outcome.spawnError || !validGrade
              ? 'instrument_failure'
              : 'graded';
      summary.cases.push({
        id: entry.id,
        process_status: processStatus,
        assessment_status: status,
        exit_code: outcome.code,
        signal: outcome.signal,
        cost_usd: cost,
        output_path: out,
      });
      writeSummary();
      if (processStatus !== 'graded') {
        summary.stop_reason = processStatus;
        failed = true;
        break;
      }
      if (cost === null) {
        summary.stop_reason = 'missing_or_unpriced_usage';
        failed = true;
        break;
      }
      if (summary.cumulative_cost_usd >= 3) {
        summary.stop_reason = 'cost_threshold_reached';
        break;
      }
    }
    summary.stop_reason ??= 'completed';
    writeSummary();
  } catch (error) {
    summary.stop_reason ??= 'instrument_failure';
    writeSummary();
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    lease?.release();
  }
  if (failed) throw new Error(`calibration stopped: ${summary.stop_reason}`);
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
