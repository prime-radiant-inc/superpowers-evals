import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { z } from 'zod';
import { antigravityRateLimitReason } from '../agents/antigravity.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  CLAUDE_ENV_FILE_NAME,
  ProvisionError,
  resolveAgent,
  shellSingleQuote,
} from '../agents/index.ts';
import {
  captureTokenUsage,
  captureToolCalls,
  snapshotDir,
} from '../capture/index.ts';
import { runPhase } from '../checks/index.ts';
import { compose } from '../composer.ts';
import {
  CodingAgentConfigError,
  loadAgentConfig,
  substituteEnv,
} from '../contracts/agent-config.ts';
import { GauntletResultSchema } from '../contracts/gauntlet.ts';
import type {
  FinalVerdict,
  GauntletLayer,
  RunError,
  RunErrorStage,
} from '../contracts/verdict.ts';
import { buildRunEconomics } from '../economics.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { hexNonce, nowStampUtc, repoRoot } from '../paths.ts';
import { runSetup, SetupError } from '../setup-step.ts';
import { readQuorumMaxTime } from '../story-meta.ts';
import { populateContextDir } from './context.ts';
import { RunnerError } from './errors.ts';
import { writePhase } from './phase.ts';

// RunnerError moved to ./errors.ts so context.ts can throw it without a
// runner<->context import cycle. Re-export it here to preserve the existing
// public surface (src/runner/index.ts exported it before this split).
export { RunnerError };

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

// The gauntlet child currently in flight for this process (one run per process),
// so the run-command SIGINT handler can forward the signal to it before writing
// the stopped verdict. Set on spawn, cleared on exit.
let activeGauntletChild: ChildProcess | null = null;
export function currentGauntletChild(): ChildProcess | null {
  return activeGauntletChild;
}

// Settled exit of the gauntlet child: the exit code (null on signal-kill) plus
// the collected stderr (for the error message). A typed value, not a string
// match on stderr inline (coding standard 6.4).
interface GauntletExit {
  readonly status: number | null;
  readonly stderr: string;
}

// Spawn the gauntlet CLI and await its exit, collecting stdout/stderr. async
// (not spawnSync) so the run-command SIGINT handler can fire while gauntlet runs
// — spawnSync would block the event loop and starve the handler. The live child
// is published via currentGauntletChild() for the duration.
function spawnGauntlet(a: InvokeGauntletArgs): Promise<GauntletExit> {
  return new Promise<GauntletExit>((resolvePromise, rejectPromise) => {
    const child = spawn('gauntlet', buildGauntletArgv(a), {
      env: {
        ...envSnapshot(),
        QUORUM_AGENT_CWD: a.launchCwd,
        ...a.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeGauntletChild = child;
    let stderr = '';
    child.stdout?.on('data', () => {
      // Drain stdout so the pipe never fills and blocks the child; the runner
      // reads gauntlet's result from result.json, not its stdout.
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      activeGauntletChild = null;
      rejectPromise(err);
    });
    child.on('close', (code: number | null) => {
      activeGauntletChild = null;
      resolvePromise({ status: code, stderr });
    });
  });
}

// Spawn the gauntlet CLI, then discover and parse its result.json. The
// subprocess env is the sanctioned snapshot (6.5) overlaid with the launch cwd
// and the agent's extra env.
export async function invokeGauntlet(
  a: InvokeGauntletArgs,
): Promise<InvokeGauntletResult> {
  const proc = await spawnGauntlet(a);
  const status = proc.status ?? 0;
  if (status !== 0) {
    return {
      gauntlet: undefined,
      error: {
        stage: 'gauntlet',
        message: `gauntlet exited ${proc.status}\n${proc.stderr}`,
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
  // Caller-supplied run-start stamp (ISO8601). When set, the verdict's
  // started_at uses it so a CLI SIGINT handler and the happy path agree.
  readonly startedAt?: string | undefined;
  // Fired once, right after the run dir is allocated, so a caller can learn the
  // dir before the long await (the SIGINT handler writes a stopped verdict here).
  readonly onRunDir?: ((runDir: string) => void) | undefined;
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
  // Fire onRunDir right after allocation so a caller (the CLI SIGINT handler)
  // learns the run dir before the long await — it needs it to write a stopped
  // verdict if the run is interrupted mid-flight.
  a.onRunDir?.(runDir);
  // startedAt: caller-supplied stamp wins so the handler and the happy path
  // agree on the same value; else stamp it here.
  const startedAt = a.startedAt ?? new Date().toISOString();
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
  const identified: FinalVerdict = {
    ...verdict,
    scenario,
    coding_agent: a.codingAgent,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  writeFileSync(
    join(runDir, 'verdict.json'),
    `${JSON.stringify(identified, null, 2)}\n`,
  );
  return { runDir, verdict: identified };
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
  if (
    err instanceof SetupError ||
    err instanceof ProvisionError ||
    err instanceof CodingAgentConfigError
  ) {
    return 'setup';
  }
  return 'unknown';
}

async function runInner(
  a: RunScenarioArgs,
  runDir: string,
): Promise<FinalVerdict> {
  writePhase(runDir, 'setup');
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
  // skeletonRoot default = the coding-agents dir itself, so ClaudeAgent copies
  // <codingAgentsDir>/claude-home-skeleton (parity with quorum/runner.py, which
  // defaults skeleton_root to _quorum_repo_root()/"coding-agents").
  const extraEnv = agent.provision(
    {
      configDir,
      workdir,
      skeletonRoot: a.skeletonRoot ?? a.codingAgentsDir,
    },
    defaultCommandRunner,
  );
  // setup.sh needs QUORUM_REPO_ROOT (some fixtures resolve repo-relative paths /
  // setup-helpers against it). Parity with quorum/runner.py 1826/1831:
  //   env_extra = {"QUORUM_REPO_ROOT": str(_quorum_repo_root())}
  //   run_setup(scenario_dir, workdir, env_extra=env_extra)
  runSetup(a.scenarioDir, workdir, { QUORUM_REPO_ROOT: repoRoot() });

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

  // Populate <runDir>/gauntlet-agent/context/ with the per-agent HOWTO +
  // launcher, burning resolved absolute paths into every $… placeholder. tmux
  // strips arbitrary env from new sessions, so the QA agent reads concrete
  // paths from the substituted files rather than from env inheritance. Parity
  // with quorum/runner.py 1885-1925 (the substitutions dict + _populate_context_dir).
  const family = cfg.runtime_family ?? cfg.name;
  const agentConfigEnv = cfg.agent_config_env;
  const launchAgentPath = join(
    runDir,
    'gauntlet-agent',
    'context',
    'launch-agent',
  );
  const substitutions: Record<string, string> = {
    $QUORUM_AGENT_CWD: launchCwd,
    $QUORUM_AGENT_CWD_SH: shellSingleQuote(launchCwd),
    $SUPERPOWERS_ROOT: getEnv('SUPERPOWERS_ROOT') ?? '',
    $QUORUM_LAUNCH_AGENT: launchAgentPath,
    $QUORUM_LAUNCH_AGENT_SH: shellSingleQuote(launchAgentPath),
    [`$${agentConfigEnv}`]: configDir,
    [`$${agentConfigEnv}_SH`]: shellSingleQuote(configDir),
  };
  // Provision-supplied substitutions (quorum's agent_runtime.substitutions). For
  // claude these are the auth env-file path the launcher sources; the path is
  // deterministic (configDir/.claude-env, written by ClaudeAgent.provision), so
  // the runner derives it rather than threading it back through provision().
  if (family === 'claude') {
    const claudeEnvFile = join(configDir, CLAUDE_ENV_FILE_NAME);
    substitutions['$CLAUDE_ENV_FILE'] = claudeEnvFile;
    substitutions['$CLAUDE_ENV_FILE_SH'] = shellSingleQuote(claudeEnvFile);
    substitutions['$CLAUDE_MODEL'] = cfg.model ?? '';
  }
  // Per-agent env-file substitutions the runner can derive from configDir (parity
  // with quorum/runner.py's name-keyed additions). These mirror the Python's
  // deterministic agent_config_dir-relative paths.
  if (cfg.name === 'gemini') {
    const geminiEnvFile = join(configDir, '.gemini-env');
    substitutions['$GEMINI_ENV_FILE'] = geminiEnvFile;
    substitutions['$GEMINI_ENV_FILE_SH'] = shellSingleQuote(geminiEnvFile);
  }
  if (cfg.name === 'pi') {
    substitutions['$PI_ENV_FILE'] = join(configDir, 'pi.env');
  }
  if (cfg.name === 'copilot') {
    const copilotEnvFile = join(configDir, '.copilot-env');
    substitutions['$COPILOT_ENV_FILE'] = copilotEnvFile;
    substitutions['$COPILOT_ENV_FILE_SH'] = shellSingleQuote(copilotEnvFile);
  }
  // NOTE: provision-supplied substitutions the TS provision does not yet expose:
  //   - kimi: $KIMI_ENV_FILE / $KIMI_BINARY (KimiAgent.provision RETURNS these in
  //     its extra-env map, but that map is gauntlet env, not the context-dir
  //     substitution set; threading provision-substitutions back to the runner is
  //     deferred). The kimi-context launcher will carry unresolved placeholders
  //     until that lands.
  //   - copilot: $QUORUM_COPILOT_SESSION_ID (minted inside CopilotAgent.provision;
  //     not yet surfaced). The $COPILOT_ENV_FILE path above is derived, but the
  //     real Python uses copilot_provisioning.env_file — verify before a live
  //     copilot run.
  // CLAUDE needs none of these, so the claude context-dir path is COMPLETE.
  populateContextDir({
    codingAgentsDir: a.codingAgentsDir,
    codingAgent: family,
    runDir,
    substitutions,
    required: family === 'claude',
    forbiddenPlaceholders: family === 'claude' ? ['$CLAUDE_MODEL'] : [],
  });

  writePhase(runDir, 'agent');
  const { gauntlet, error } = await invokeGauntlet({
    storyPath,
    targetBinary: cfg.binary,
    runDir,
    maxTime,
    projectPrompt: cfg.project_prompt,
    launchCwd,
    extraEnv,
  });

  // antigravity: a rate-limited Code Assist backend is an environmental
  // indeterminate, not pass/fail (parity with quorum/runner.py, which maps it
  // ahead of the generic empty-trace path). spawnSync blocks, so we scan the
  // post-run agy.log rather than tailing it live; the early-teardown watcher is
  // deferred. This precedes the gauntlet-error and capture handling.
  if (cfg.normalizer === 'antigravity') {
    const reason = antigravityRateLimitReason(configDir);
    if (reason !== null) {
      return compose({
        gauntlet: gauntlet ?? null,
        checks: [...pre.records],
        captureEmpty: false,
        error: { stage: 'gauntlet', message: reason },
      });
    }
  }

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
    launchCwd,
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
    launchCwd,
  });
  const captureEmpty = capture.rowCount === 0;

  // post-checks: again a crash is an error stage, a failure flows to compose.
  writePhase(runDir, 'checks');
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
