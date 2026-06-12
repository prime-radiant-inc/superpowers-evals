import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { z } from 'zod';
import { resolveAgent } from '../agents/index.ts';
import {
  captureTokenUsage,
  captureToolCalls,
  snapshotDir,
} from '../capture/index.ts';
import { runPhase } from '../checks/index.ts';
import { compose } from '../composer.ts';
import { loadAgentConfig, substituteEnv } from '../contracts/agent-config.ts';
import { GauntletResultSchema } from '../contracts/gauntlet.ts';
import type {
  FinalVerdict,
  GauntletLayer,
  RunError,
  RunErrorStage,
} from '../contracts/verdict.ts';
import { buildRunEconomics } from '../economics.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { hexNonce, nowStampUtc } from '../paths.ts';
import { runSetup, SetupError } from '../setup-step.ts';
import { readQuorumMaxTime } from '../story-meta.ts';

// A staged invariant failure inside the runner pipeline. The stage drives the
// error-stage of the indeterminate verdict (coding standard 6.1); a bug is an
// exception, but a staged one so the composer can attribute it.
// erasableSyntaxOnly forbids constructor parameter properties (5.3), so the
// stage is an explicit field assigned in the body.
export class RunnerError extends Error {
  readonly stage: RunErrorStage;
  constructor(message: string, stage: RunErrorStage) {
    super(message);
    this.name = 'RunnerError';
    this.stage = stage;
  }
}

// Create and return the per-run output dir
// <outRoot>/<scenario>-<agent>-<stamp>-<nonce>/.
export function allocateRunDir(
  outRoot: string,
  scenario: string,
  agent: string,
): string {
  const dir = join(
    outRoot,
    `${scenario}-${agent}-${nowStampUtc()}-${hexNonce()}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GauntletArgvArgs {
  readonly storyPath: string;
  readonly targetBinary: string;
  readonly runDir: string;
  readonly maxTime?: string | undefined;
  readonly projectPrompt?: string | undefined;
}

// Build the exact, order-stable gauntlet argv. Optional flags append only when
// present, so the argv is a pure function of its inputs.
export function buildGauntletArgv(a: GauntletArgvArgs): string[] {
  const argv = [
    'run',
    a.storyPath,
    '--adapter',
    'tui',
    '--target',
    a.targetBinary,
    '--project-dir',
    a.runDir,
    '--state-dir',
    'gauntlet-agent',
    '--silent',
  ];
  if (a.maxTime) {
    argv.push('--max-time', a.maxTime);
  }
  if (a.projectPrompt) {
    argv.push('--project-prompt', a.projectPrompt);
  }
  return argv;
}

// Newest gauntlet-agent results result.json under runDir, or undefined when
// none exists. Sorted lexically (the run-id stamps order correctly) and the
// last element checked (noUncheckedIndexedAccess).
function discoverGauntletResult(runDir: string): string | undefined {
  const base = join(runDir, 'gauntlet-agent', 'results');
  if (!existsSync(base)) {
    return undefined;
  }
  const hits = [
    ...new Glob('*/result.json').scanSync({ cwd: base, absolute: true }),
  ].sort();
  return hits.length > 0 ? hits[hits.length - 1] : undefined;
}

// Discriminated outcome of an attempted gauntlet drive (6.1): a layer on
// success, a staged error on failure. Exactly one of the two is present.
export interface InvokeGauntletResult {
  readonly gauntlet: GauntletLayer | undefined;
  readonly error: RunError | undefined;
}

export interface InvokeGauntletArgs extends GauntletArgvArgs {
  readonly launchCwd: string;
  readonly extraEnv: Record<string, string>;
}

// Spawn the gauntlet CLI, then discover and parse its result.json. The
// subprocess env is the sanctioned snapshot (6.5) overlaid with the launch cwd
// and the agent's extra env.
export function invokeGauntlet(a: InvokeGauntletArgs): InvokeGauntletResult {
  const proc = spawnSync('gauntlet', buildGauntletArgv(a), {
    env: {
      ...envSnapshot(),
      QUORUM_AGENT_CWD: a.launchCwd,
      ...a.extraEnv,
    },
    encoding: 'utf8',
  });
  const status = proc.status ?? 0;
  if (status !== 0) {
    return {
      gauntlet: undefined,
      error: {
        stage: 'gauntlet',
        message: `gauntlet exited ${proc.status}\n${proc.stderr ?? ''}`,
      },
    };
  }
  const resultPath = discoverGauntletResult(a.runDir);
  if (resultPath === undefined) {
    return {
      gauntlet: undefined,
      error: { stage: 'gauntlet', message: 'no gauntlet result.json found' },
    };
  }
  const result = GauntletResultSchema.parse(
    JSON.parse(readFileSync(resultPath, 'utf8')),
  );
  return {
    gauntlet: {
      status: result.status,
      summary: result.summary,
      reasoning: result.reasoning,
      run_id: result.runId ?? null,
    },
    error: undefined,
  };
}

export interface RunScenarioArgs {
  readonly scenarioDir: string;
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly skeletonRoot?: string | undefined;
}

export interface RunScenarioResult {
  readonly runDir: string;
  readonly verdict: FinalVerdict;
}

// The economics block is opaque at the verdict layer (a record of unknowns);
// re-validate the structured block through that schema to cross into the field
// without a type assertion (4.1).
const OpaqueEconomicsSchema = z.record(z.unknown());

// Run one scenario end to end. Always allocates a run dir and always writes
// verdict.json; a thrown invariant maps to an indeterminate verdict via the
// composer (6.1) rather than escaping.
export async function runScenario(
  a: RunScenarioArgs,
): Promise<RunScenarioResult> {
  const scenario = scenarioName(a.scenarioDir);
  const runDir = allocateRunDir(a.outRoot, scenario, a.codingAgent);
  let verdict: FinalVerdict;
  try {
    verdict = await runInner(a, runDir);
  } catch (err: unknown) {
    const stage = errorStage(err);
    const message = err instanceof Error ? err.message : String(err);
    verdict = compose({
      gauntlet: null,
      checks: [],
      captureEmpty: false,
      error: { stage, message },
    });
  }
  writeFileSync(
    join(runDir, 'verdict.json'),
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
  return { runDir, verdict };
}

// Trailing path segment of a scenario dir (its name), guarded against a
// trailing slash.
function scenarioName(scenarioDir: string): string {
  const parts = scenarioDir.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === undefined) {
    throw new RunnerError(`empty scenario dir: ${scenarioDir}`, 'setup');
  }
  return last;
}

// Map a caught value to its error stage without assertions or non-null (6.3): a
// staged RunnerError carries its own, a SetupError is setup, anything else is
// unknown.
function errorStage(err: unknown): RunErrorStage {
  if (err instanceof RunnerError) {
    return err.stage;
  }
  if (err instanceof SetupError) {
    return 'setup';
  }
  return 'unknown';
}

async function runInner(
  a: RunScenarioArgs,
  runDir: string,
): Promise<FinalVerdict> {
  const cfg = loadAgentConfig(a.codingAgentsDir, a.codingAgent);
  for (const key of cfg.required_env) {
    if (!getEnv(key)) {
      throw new RunnerError(
        `${a.codingAgent}.yaml: required env var not set: ${key}`,
        'setup',
      );
    }
  }
  const agent = resolveAgent(cfg);

  // setup: isolated config + workdir, claude provisioning, then setup.sh.
  const configDir = join(runDir, 'coding-agent-config');
  const workdir = join(runDir, 'coding-agent-workdir');
  mkdirSync(workdir, { recursive: true });
  const extraEnv = agent.provision({
    configDir,
    workdir,
    skeletonRoot: a.skeletonRoot ?? undefined,
  });
  runSetup(a.scenarioDir, workdir);

  const checksSh = join(a.scenarioDir, 'checks.sh');
  const hasChecks = existsSync(checksSh);
  const quorumBin = join(process.cwd(), 'bin');

  // pre-checks: a crash is an error stage; a failed assertion is a verdict.
  const pre = hasChecks
    ? await runPhase({ checksSh, phase: 'pre', workdir, quorumBin, runDir })
    : { records: [], exitCode: 0 };
  if (pre.exitCode !== 0) {
    return compose({
      gauntlet: null,
      checks: [...pre.records],
      captureEmpty: false,
      error: {
        stage: 'checks',
        message: `pre-checks crashed (exit ${pre.exitCode})`,
      },
    });
  }
  if (pre.records.some((r) => !r.passed)) {
    return compose({
      gauntlet: null,
      checks: [...pre.records],
      captureEmpty: false,
      error: null,
    });
  }

  // snapshot the agent session-log dir before the run.
  const logDir = substituteEnv(cfg.session_log_dir, extraEnv);
  const snapshot = snapshotDir(logDir, cfg.session_log_glob);

  // drive gauntlet. launch cwd honors a .quorum-launch-cwd sentinel written by
  // setup.sh (parity with Python _resolve_launch_cwd), else the workdir.
  const storyPath = join(a.scenarioDir, 'story.md');
  const maxTime = readQuorumMaxTime(storyPath) ?? cfg.max_time ?? undefined;
  const launchCwdFile = join(workdir, '.quorum-launch-cwd');
  const launchCwd = existsSync(launchCwdFile)
    ? readFileSync(launchCwdFile, 'utf8').trim()
    : workdir;
  const { gauntlet, error } = invokeGauntlet({
    storyPath,
    targetBinary: cfg.binary,
    runDir,
    maxTime,
    projectPrompt: cfg.project_prompt,
    launchCwd,
    extraEnv,
  });
  if (error !== undefined) {
    return compose({
      gauntlet: gauntlet ?? null,
      checks: [...pre.records],
      captureEmpty: false,
      error,
    });
  }

  // capture tool calls + token usage from the new session logs.
  const capture = captureToolCalls({
    logDir,
    logGlob: cfg.session_log_glob,
    snapshot,
    normalizer: cfg.normalizer,
    runDir,
  });
  // captureTokenUsage writes coding-agent-token-usage.json as a side effect
  // (null when obol cannot price); economics reads that file, so the returned
  // path is not needed here, but the promise still has an owner (6.2).
  await captureTokenUsage({
    logDir,
    logGlob: cfg.session_log_glob,
    snapshot,
    normalizer: cfg.normalizer,
    runDir,
  });
  const captureEmpty = capture.rowCount === 0;

  // post-checks: again a crash is an error stage, a failure flows to compose.
  const post = hasChecks
    ? await runPhase({
        checksSh,
        phase: 'post',
        workdir,
        quorumBin,
        toolCallsPath: capture.path,
        runDir,
      })
    : { records: [], exitCode: 0 };
  if (post.exitCode !== 0) {
    return compose({
      gauntlet: gauntlet ?? null,
      checks: [...pre.records, ...post.records],
      captureEmpty,
      error: {
        stage: 'checks',
        message: `post-checks crashed (exit ${post.exitCode})`,
      },
    });
  }

  // compose + attach economics (opaque at this layer; 4.1).
  const verdict = compose({
    gauntlet: gauntlet ?? null,
    checks: [...pre.records, ...post.records],
    captureEmpty,
    error: null,
  });
  const economics = await buildRunEconomics(runDir);
  return {
    ...verdict,
    economics:
      economics === null ? null : OpaqueEconomicsSchema.parse(economics),
  };
}
