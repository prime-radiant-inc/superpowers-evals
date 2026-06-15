import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { backupCredential } from '../agents/agy-creds.ts';
import { killRunTmuxServer } from '../agents/agy-teardown.ts';
import { AgyRateLimitWatcher } from '../agents/agy-watch.ts';
import {
  ANTIGRAVITY_RATE_LIMIT_MARKER,
  antigravityRateLimitReason,
  excludeAntigravityProjectMarker,
  prepareAntigravityLaunchCwd,
  writeAntigravitySettings,
} from '../agents/antigravity.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  CopilotAgent,
  type CopilotProvisioning,
  copilotGauntletEnv,
  scanCopilotSecretLeaks,
} from '../agents/copilot.ts';
import { geminiAuthType } from '../agents/gemini.ts';
import {
  CLAUDE_ENV_FILE_NAME,
  ProvisionError,
  resolveAgent,
  shellSingleQuote,
} from '../agents/index.ts';
import {
  exportOpencodeSessions,
  OpenCodeCaptureError,
  snapshotOpencodeSessions,
} from '../agents/opencode-capture.ts';
import {
  captureTokenUsage,
  captureToolCallsWithRetry,
  detectMisplacedCodexRollouts,
  detectMisplacedPiSessions,
  detectUnusablePiSessions,
  diagnoseKimiUnmatchedLogs,
  snapshotDir,
} from '../capture/index.ts';
import { parseCodingAgentsDirective, runPhase } from '../checks/index.ts';
import { compose } from '../composer.ts';
import {
  CodingAgentConfigError,
  loadAgentConfig,
  substituteEnv,
} from '../contracts/agent-config.ts';
import type {
  CheckRecord,
  FinalVerdict,
  GauntletLayer,
  GauntletStatus,
  RunError,
  RunErrorStage,
} from '../contracts/verdict.ts';
import { buildRunEconomics } from '../economics.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { kimiLogsHaveSuperpowersSessionStart } from '../normalize/kimi.ts';
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

// Empty-capture retry/guard (PRI-2081). A transient flush race between the
// Coding-Agent exiting and the capture diff reading its session log used to
// become a permanent stage="capture" indeterminate. Bounded re-diff: worst
// case adds (attempts - 1) * delay ms to a genuinely-empty run before the
// per-backend diagnostic cascade proceeds unchanged.
const CAPTURE_RETRY_ATTEMPTS = 3;
const CAPTURE_RETRY_DELAY_MS = 2000;

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

// The valid gauntlet statuses quorum acts on. Anything else (incl. 'errored',
// schema drift) coerces to 'investigate' — parity with Python's _valid set,
// which is exactly {pass, fail, investigate}.
const VALID_GAUNTLET_STATUSES = new Set<GauntletStatus>([
  'pass',
  'fail',
  'investigate',
]);

function coerceGauntletStatus(raw: unknown): GauntletStatus {
  return typeof raw === 'string' &&
    VALID_GAUNTLET_STATUSES.has(raw as GauntletStatus)
    ? (raw as GauntletStatus)
    : 'investigate';
}

// Build a GauntletLayer from the run dir's gauntlet-agent/results/<runId>/
// result.json (parity with Python _build_gauntlet_layer_from_run_dir). Iterates
// the run-id subdirs sorted-then-reversed and, on a missing/unreadable/malformed
// result.json, skips to the next-newest candidate. run_id is the DIRECTORY NAME
// (always concrete when a result exists), not result.json's optional runId
// field. Status outside {pass,fail,investigate} coerces to investigate. Returns
// null when no candidate yields a parseable result.
export function gauntletLayerFromRunDir(runDir: string): GauntletLayer | null {
  const root = join(runDir, 'gauntlet-agent', 'results');
  if (!existsSync(root)) {
    return null;
  }
  const dirs = readdirSync(root)
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  for (const runId of dirs.reverse()) {
    const resultPath = join(root, runId, 'result.json');
    if (!existsSync(resultPath)) {
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch {
      continue;
    }
    if (typeof data !== 'object' || data === null) {
      continue;
    }
    const record = data as Record<string, unknown>;
    const summary = record['summary'];
    const reasoning = record['reasoning'];
    return {
      status: coerceGauntletStatus(record['status']),
      summary: typeof summary === 'string' ? summary : '',
      reasoning: typeof reasoning === 'string' ? reasoning : '',
      run_id: runId,
    };
  }
  return null;
}

// Kill the gauntlet tmux server driving agy for this run (parity with Python
// _kill_gauntlet_tmux_for_run). Gauntlet runs agy in a private tmux server whose
// pane cwd is <runDir>/gauntlet-agent/results/<runId>/scratch; the runId is
// minted inside gauntlet, but quorum is single-run-per-dir so exactly one such
// scratch dir exists. Globs them, takes the last, and hands it to the killer
// (which matches the server by strict pane-path equality). The killer is
// injectable so the watcher's teardown and tests can stub the real tmux kill.
export function killGauntletTmuxForRun(
  runDir: string,
  kill: (scratchDir: string) => boolean,
): boolean {
  const resultsRoot = join(runDir, 'gauntlet-agent', 'results');
  if (!existsSync(resultsRoot)) {
    return false;
  }
  const scratchDirs: string[] = [];
  for (const name of readdirSync(resultsRoot)) {
    const scratch = join(resultsRoot, name, 'scratch');
    if (existsSync(scratch)) {
      scratchDirs.push(scratch);
    }
  }
  scratchDirs.sort();
  const last = scratchDirs[scratchDirs.length - 1];
  if (last === undefined) {
    return false;
  }
  return kill(last);
}

// Outcome of a gauntlet drive: always a layer, derived from the run dir's
// result.json (synthesized 'investigate' when none parses). The exit code is
// not surfaced as a verdict error — parity with Python invoke_gauntlet, which
// discards it. A spawn-level failure rejects from spawnGauntlet instead.
export interface InvokeGauntletResult {
  readonly gauntlet: GauntletLayer;
}

export interface InvokeGauntletArgs extends GauntletArgvArgs {
  readonly launchCwd: string;
  readonly extraEnv: Record<string, string>;
  // Base env gauntlet inherits. Defaults to the full host snapshot; copilot
  // passes a tightly-scoped allowlist (copilotGauntletEnv) so the host
  // environment (other provider keys, credentialed proxies) is not leaked into
  // the agent subprocess (parity with Python's env_base).
  readonly envBase?: Readonly<Record<string, string | undefined>> | undefined;
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
        ...(a.envBase ?? envSnapshot()),
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

// Spawn the gauntlet CLI, then derive the gauntlet layer from its run dir. Parity
// with Python invoke_gauntlet: the exit code is DISCARDED — status always comes
// from result.json under gauntlet-agent/results/, falling back to a synthesized
// 'investigate' layer when no parseable result exists (a gauntlet that exited
// non-zero but wrote a valid result still yields that pass/fail; a non-zero exit
// with no/garbled result becomes investigate -> composer indeterminate, not a
// gauntlet-stage error). The subprocess env is the sanctioned snapshot (6.5)
// overlaid with the launch cwd and the agent's extra env. A spawn-level failure
// (gauntlet not on PATH) still rejects from spawnGauntlet and surfaces as an
// 'unknown'-stage crash, matching the un-catchable case in Python.
export async function invokeGauntlet(
  a: InvokeGauntletArgs,
): Promise<InvokeGauntletResult> {
  await spawnGauntlet(a);
  const gauntlet = gauntletLayerFromRunDir(a.runDir) ?? {
    status: 'investigate' as const,
    summary: '',
    reasoning: '',
    run_id: null,
  };
  return { gauntlet };
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

// setup.sh may override the agent's launch cwd by writing this sentinel into the
// workdir (parity with quorum LAUNCH_CWD_SENTINEL).
const LAUNCH_CWD_SENTINEL = '.quorum-launch-cwd';

// Build an indeterminate verdict directly (NOT via compose, whose error path
// prefixes "quorum error (stage): …"). Mirrors Python _write_indeterminate so
// every early/cascade short-circuit carries its exact final_reason. The verdict
// is identity-stamped + persisted by runScenario.
function writeIndeterminate(a: {
  finalReason: string;
  gauntlet?: GauntletLayer | null;
  checks?: readonly CheckRecord[];
  error?: RunError | null;
}): FinalVerdict {
  return {
    schema: 1,
    final: 'indeterminate',
    final_reason: a.finalReason,
    gauntlet: a.gauntlet ?? null,
    checks: a.checks ? [...a.checks] : [],
    error: a.error ?? null,
    economics: null,
  };
}

// Render paths relative to the session-log dir for human-facing reasons (parity
// with Python's path.relative_to(session_log_dir)).
function relToLogDir(logDir: string, paths: readonly string[]): string[] {
  return paths.map((p) => relative(logDir, p));
}

// Strict-capture dialects whose run is uninterpretable without a transcript:
// no source logs OR zero normalized rows is a capture indeterminate, regardless
// of whether any deterministic check is present (parity with Python
// strict_capture_names). codex is NOT here — its empty case is the post-checks
// misplaced-rollout guard. copilot is handled by its own leak/session-state
// branch wired alongside provisioning.
const STRICT_CAPTURE_NAMES: Readonly<Record<string, string>> = {
  antigravity: 'Antigravity',
  claude: 'Claude',
  gemini: 'Gemini',
};

export interface CaptureCascadeArgs {
  readonly normalizer: string;
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly launchCwd: string;
  readonly captureResult: {
    readonly sourceLogs: readonly string[];
    readonly rowCount: number;
  };
  readonly gauntlet: GauntletLayer;
  readonly preRecords: readonly CheckRecord[];
  readonly runDir: string;
}

// Per-normalizer strict-capture / diagnostic cascade (parity with the Python
// _run_scenario_inner capture-stage block). Returns a backend-specific
// indeterminate verdict when a strict backend produced no usable transcript, or
// null to proceed to post-checks. Each branch is independent of whether any
// deterministic check exists — that is the gap the generic captureEmpty path in
// composer.ts cannot cover.
export function captureCascadeVerdict(
  a: CaptureCascadeArgs,
): FinalVerdict | null {
  const { normalizer, captureResult, gauntlet, preRecords, logDir } = a;
  const { sourceLogs, rowCount } = captureResult;
  const indeterminate = (finalReason: string, error: RunError): FinalVerdict =>
    writeIndeterminate({
      finalReason,
      gauntlet,
      checks: preRecords,
      error,
    });

  if (normalizer === 'pi') {
    if (sourceLogs.length === 0) {
      const misplaced = detectMisplacedPiSessions({
        logDir: a.logDir,
        logGlob: a.logGlob,
        snapshot: a.snapshot,
        launchCwd: a.launchCwd,
      });
      if (misplaced.length > 0) {
        const rel = relToLogDir(logDir, misplaced);
        return indeterminate(
          'QA agent launched Pi from the wrong cwd - likely skipped ' +
            '`cd $QUORUM_AGENT_CWD` in the Pi launcher. See ' +
            `${JSON.stringify(rel)} for the misplaced session(s).`,
          {
            stage: 'qa-agent-misconfigured',
            message: `misplaced Pi sessions: ${JSON.stringify(rel)}`,
          },
        );
      }
      const unusable = detectUnusablePiSessions({
        logDir: a.logDir,
        logGlob: a.logGlob,
        snapshot: a.snapshot,
      });
      if (unusable.length > 0) {
        const rel = relToLogDir(logDir, unusable);
        return indeterminate(
          `unusable Pi session header(s): ${rel.join(', ')}`,
          {
            stage: 'capture',
            message: `unusable Pi session headers: ${JSON.stringify(rel)}`,
          },
        );
      }
      return indeterminate(
        `no Pi session appeared under isolated ${logDir}; cannot evaluate this run`,
        { stage: 'capture', message: 'no Pi session captured' },
      );
    }
    if (rowCount === 0) {
      const rel = relToLogDir(logDir, sourceLogs);
      return indeterminate(
        `Pi session(s) normalized to zero tool-call rows: ${rel.join(', ')}`,
        { stage: 'capture', message: 'Pi capture normalized to zero rows' },
      );
    }
  }

  if (normalizer === 'opencode') {
    if (sourceLogs.length === 0) {
      return indeterminate(
        `no OpenCode session export appeared under isolated ${logDir}; cannot evaluate this run`,
        { stage: 'capture', message: 'no OpenCode session export captured' },
      );
    }
    if (rowCount === 0) {
      const rel = relToLogDir(logDir, sourceLogs);
      return indeterminate(
        `OpenCode export(s) normalized to zero tool-call rows: ${rel.join(', ')}`,
        {
          stage: 'capture',
          message: 'OpenCode capture normalized to zero rows',
        },
      );
    }
  }

  const strictName = STRICT_CAPTURE_NAMES[normalizer];
  if (strictName !== undefined) {
    if (sourceLogs.length === 0) {
      return indeterminate(
        `no ${strictName} transcript appeared under isolated ${logDir}; cannot evaluate this run`,
        { stage: 'capture', message: `no ${strictName} transcript captured` },
      );
    }
    if (rowCount === 0) {
      const rel = relToLogDir(logDir, sourceLogs);
      return indeterminate(
        `${strictName} transcript(s) normalized to zero tool-call rows: ${rel.join(', ')}`,
        {
          stage: 'capture',
          message: `${strictName} capture normalized to zero rows`,
        },
      );
    }
  }

  if (normalizer === 'kimi') {
    if (sourceLogs.length === 0) {
      const unmatched = diagnoseKimiUnmatchedLogs({
        logDir: a.logDir,
        logGlob: a.logGlob,
        snapshot: a.snapshot,
        launchCwd: a.launchCwd,
      });
      if (unmatched !== null) {
        const rel = relToLogDir(logDir, unmatched.paths);
        if (unmatched.stage === 'qa-agent-misconfigured') {
          return indeterminate(
            'Kimi wrote wire logs, but none matched the launch cwd; ' +
              'the QA agent likely bypassed the generated launcher',
            {
              stage: 'qa-agent-misconfigured',
              message: `Kimi wire logs did not match launch cwd: ${JSON.stringify(rel)}`,
            },
          );
        }
        return indeterminate(
          'Kimi wrote wire logs, but session_index.jsonl did not ' +
            'map them to the launch cwd; cannot evaluate this run',
          {
            stage: 'capture',
            message: `Kimi wire logs were not indexed/mappable to launch cwd: ${JSON.stringify(rel)}`,
          },
        );
      }
      return indeterminate(
        `no Kimi wire.jsonl appeared under isolated ${logDir}; cannot evaluate this run`,
        { stage: 'capture', message: 'no Kimi wire.jsonl captured' },
      );
    }
    if (rowCount === 0) {
      const rel = relToLogDir(logDir, sourceLogs);
      return indeterminate(
        `Kimi wire log(s) normalized to zero tool-call rows: ${rel.join(', ')}`,
        { stage: 'capture', message: 'Kimi capture normalized to zero rows' },
      );
    }
    if (!kimiLogsHaveSuperpowersSessionStart(sourceLogs)) {
      return indeterminate(
        'Kimi raw wire log lacks Superpowers plugin_session_start',
        {
          stage: 'capture',
          message:
            'missing plugin_session_start plugin=superpowers skill=using-superpowers',
        },
      );
    }
  }

  return null;
}

export interface CodexMisplacedArgs {
  readonly captureEmpty: boolean;
  readonly normalizer: string;
  readonly logDir: string;
  readonly logGlob: string;
  readonly snapshot: ReadonlySet<string>;
  readonly runDir: string;
  readonly launchCwd: string;
}

// Codex empty-capture qa-agent-misconfigured short-circuit (parity with the
// Python step 12b guard, which runs AFTER post-checks). An empty capture plus a
// codex rollout sitting under run_dir but launched in a subdir other than
// launch_cwd means the QA agent skipped `cd $QUORUM_AGENT_CWD`. Surfaced as its
// own stage so downstream trace checks (all "never called") don't bury the cause.
export function codexMisplacedVerdict(
  a: CodexMisplacedArgs,
): FinalVerdict | null {
  if (!a.captureEmpty || a.normalizer !== 'codex') {
    return null;
  }
  const misplaced = detectMisplacedCodexRollouts({
    logDir: a.logDir,
    logGlob: a.logGlob,
    snapshot: a.snapshot,
    runDir: a.runDir,
    launchCwd: a.launchCwd,
  });
  if (misplaced.length === 0) {
    return null;
  }
  const rel = relToLogDir(a.logDir, misplaced);
  return writeIndeterminate({
    finalReason:
      'QA agent launched codex from the wrong cwd — likely skipped ' +
      '`cd $QUORUM_AGENT_CWD` in the codex HOWTO. See ' +
      `${JSON.stringify(rel)} for the misplaced rollout(s).`,
    error: {
      stage: 'qa-agent-misconfigured',
      message: `misplaced codex rollouts: ${JSON.stringify(rel)}`,
    },
  });
}

// Render a path relative to `base` when it is under it, else the absolute path
// (parity with Python's `path.relative_to(base) if is_relative_to else path`).
function relIfUnder(base: string, path: string): string {
  const rel = relative(base, path);
  return rel.startsWith('..') ? path : rel;
}

export interface CopilotCascadeArgs {
  readonly runDir: string;
  readonly sessionLogDir: string;
  readonly expectedEventsLog: string;
  readonly envFile: string;
  readonly secretValues: readonly string[];
  readonly sourceLogs: readonly string[];
  readonly gauntlet: GauntletLayer;
  readonly preRecords: readonly CheckRecord[];
}

// Copilot post-capture branch (parity with the Python copilot capture-stage
// block). In order: (1) a secret-leak scan over the whole run dir (skipping the
// env file that legitimately holds the secret) -> indeterminate naming the
// leaking artifacts; (2) the expected session-state events.jsonl must be among
// the captured source logs; (3) no UNEXPECTED session-state logs may appear.
// Returns null to proceed when the run is clean.
export function copilotCascadeVerdict(
  a: CopilotCascadeArgs,
): FinalVerdict | null {
  const resolveP = (p: string): string => resolve(p);
  const indeterminate = (finalReason: string, error: RunError): FinalVerdict =>
    writeIndeterminate({
      finalReason,
      gauntlet: a.gauntlet,
      checks: a.preRecords,
      error,
    });

  const leaks = scanCopilotSecretLeaks(a.runDir, a.secretValues, [a.envFile]);
  if (leaks.length > 0) {
    const rel = leaks.map((p) => relIfUnder(a.runDir, p));
    return indeterminate(
      `Copilot secret value appeared in non-secret run artifact: ${rel.join(', ')}`,
      {
        stage: 'capture',
        message: 'Copilot secret value leaked into run artifact',
      },
    );
  }

  const expectedResolved = resolveP(a.expectedEventsLog);
  const sourceResolved = a.sourceLogs.map(resolveP);
  if (a.sourceLogs.length > 0 && !sourceResolved.includes(expectedResolved)) {
    return indeterminate(
      `expected Copilot session-state log did not appear: ${a.expectedEventsLog}`,
      {
        stage: 'capture',
        message: 'expected Copilot session-state log missing',
      },
    );
  }

  const unexpected = a.sourceLogs.filter(
    (p) => resolveP(p) !== expectedResolved,
  );
  if (unexpected.length > 0) {
    const rel = unexpected.map((p) => relIfUnder(a.sessionLogDir, p));
    return indeterminate(
      `unexpected Copilot session-state log(s) appeared: ${rel.join(', ')}`,
      {
        stage: 'capture',
        message: 'unexpected Copilot session-state log captured',
      },
    );
  }

  return null;
}

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

// Claude-family binary PATH preflight (parity with quorum
// _preflight_coding_agent_binary): a claude run whose CLI is not installed fails
// fast at setup, not deep in the gauntlet drive. Other families are launched by
// gauntlet's own resolution, so this is claude-only. PATH is read through the
// sanctioned env snapshot, never process.env directly.
function preflightCodingAgentBinary(cfg: {
  runtime_family?: string | undefined;
  name: string;
  binary: string;
}): void {
  const family = cfg.runtime_family ?? cfg.name;
  if (family !== 'claude') {
    return;
  }
  const path = envSnapshot()['PATH'] ?? '';
  if (Bun.which(cfg.binary, { PATH: path }) === null) {
    throw new RunnerError(
      `Claude Code is not on PATH: '${cfg.binary}'`,
      'setup',
    );
  }
}

// Resolve the agent launch cwd from the workdir's .quorum-launch-cwd sentinel
// (parity with quorum _resolve_launch_cwd). No sentinel -> the workdir. A
// sentinel whose named path does not exist is a runner error, so a stale/typo
// sentinel fails up front rather than launching gauntlet from a missing dir.
function resolveLaunchCwd(workdir: string): string {
  const sentinel = join(workdir, LAUNCH_CWD_SENTINEL);
  if (!existsSync(sentinel)) {
    return workdir;
  }
  const resolved = readFileSync(sentinel, 'utf8').trim();
  if (!existsSync(resolved)) {
    throw new RunnerError(
      `setup.sh wrote ${LAUNCH_CWD_SENTINEL}=${resolved} but that path doesn't exist`,
      'setup',
    );
  }
  return resolved;
}

async function runInner(
  a: RunScenarioArgs,
  runDir: string,
): Promise<FinalVerdict> {
  writePhase(runDir, 'setup');
  // Early guards run in strict parity-order with quorum _run_scenario_inner,
  // BEFORE any side effect (workdir creation, provisioning, setup.sh, gauntlet).

  // 1. Unknown coding-agent: a missing yaml gets a clean runner error rather
  //    than a leaked raw ENOENT from loadAgentConfig's readFileSync.
  const codingAgentPath = join(a.codingAgentsDir, `${a.codingAgent}.yaml`);
  if (!existsSync(codingAgentPath)) {
    throw new RunnerError(
      `unknown coding-agent '${a.codingAgent}': no ${codingAgentPath}`,
      'setup',
    );
  }
  const cfg = loadAgentConfig(a.codingAgentsDir, a.codingAgent);

  // 2. story.md is required (gauntlet needs it); a missing file is a clean
  //    setup error, not a deferred ENOENT from readQuorumMaxTime.
  const storyPath = join(a.scenarioDir, 'story.md');
  if (!existsSync(storyPath)) {
    throw new RunnerError(`${a.scenarioDir}: story.md missing`, 'setup');
  }

  // 3. Per-scenario duration override (StoryMetaError -> setup runner error).
  let storyMaxTime: string | null;
  try {
    storyMaxTime = readQuorumMaxTime(storyPath);
  } catch (e: unknown) {
    throw new RunnerError(e instanceof Error ? e.message : String(e), 'setup');
  }
  const maxTime = storyMaxTime ?? cfg.max_time ?? undefined;

  // 4. checks.sh is REQUIRED. If absent, short-circuit to a setup indeterminate
  //    BEFORE provisioning or the (costly) agent run.
  const checksSh = join(a.scenarioDir, 'checks.sh');
  if (!existsSync(checksSh)) {
    return writeIndeterminate({
      finalReason: 'scenario missing checks.sh',
      error: { stage: 'setup', message: 'checks.sh not found' },
    });
  }

  // 5. Coding-agent gating: honor the `# coding-agents:` directive before any
  //    side effect, so a direct `quorum run` against an excluded agent skips.
  const allowed = parseCodingAgentsDirective(checksSh);
  if (allowed && !allowed.includes(a.codingAgent)) {
    return writeIndeterminate({
      finalReason: `requires coding-agents: ${allowed.join(', ')}`,
    });
  }

  // 6. Claude-family binary PATH preflight: fail fast at setup if the CLI is
  //    not installed, rather than deep in the gauntlet run.
  preflightCodingAgentBinary(cfg);

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
  const home = {
    configDir,
    workdir,
    // skeletonRoot default = the coding-agents dir itself, so ClaudeAgent copies
    // <codingAgentsDir>/claude-home-skeleton (parity with quorum/runner.py,
    // which defaults skeleton_root to _quorum_repo_root()/"coding-agents").
    skeletonRoot: a.skeletonRoot ?? a.codingAgentsDir,
  };
  // copilot is special-cased: it mints a per-run session id, threads it through
  // provisionCopilot, and returns the rich CopilotProvisioning record the runner
  // needs for the $QUORUM_COPILOT_SESSION_ID substitution, the gauntlet env base,
  // and the post-run secret-leak / session-state cascade (parity with Python's
  // copilot branch). Every other agent uses the declarative provision() motion.
  let copilotProvisioning: CopilotProvisioning | undefined;
  let extraEnv: Record<string, string>;
  if (cfg.name === 'copilot' && agent instanceof CopilotAgent) {
    copilotProvisioning = agent.provisionCopilot(
      home,
      defaultCommandRunner,
      crypto.randomUUID(),
    );
    extraEnv = copilotProvisioning.env;
  } else {
    extraEnv = agent.provision(home, defaultCommandRunner);
  }
  // setup.sh needs QUORUM_REPO_ROOT (some fixtures resolve repo-relative paths /
  // setup-helpers against it). Parity with quorum/runner.py 1826/1831:
  //   env_extra = {"QUORUM_REPO_ROOT": str(_quorum_repo_root())}
  //   run_setup(scenario_dir, workdir, env_extra=env_extra)
  runSetup(a.scenarioDir, workdir, { QUORUM_REPO_ROOT: repoRoot() });

  const quorumBin = join(process.cwd(), 'bin');

  // pre-checks: a crash is an error stage; a failed assertion is a verdict.
  // checks.sh is guaranteed present (the missing-checks guard returned early).
  const pre = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin,
    runDir,
  });
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

  // drive gauntlet. launch cwd honors a .quorum-launch-cwd sentinel written by
  // setup.sh (parity with Python _resolve_launch_cwd), else the workdir. A
  // sentinel naming a path that does not exist is a runner error, not a silent
  // launch from a nonexistent cwd. Resolved before the opencode snapshot, which
  // is keyed on the launch cwd.
  let launchCwd = resolveLaunchCwd(workdir);

  // antigravity launch-cwd preparation (parity with Python): (1) git-exclude the
  // per-run project marker so it never dirties the launch repo; (2) when the
  // launch cwd has a hidden path component (quorum runs live under .codex/ etc.)
  // expose it through a visible temp symlink, since Antigravity rejects --add-dir
  // workspaces with hidden components; (3) re-write trusted-workspaces settings
  // against the RESOLVED launch cwd (provision wrote them against the raw
  // workdir, before the sentinel/symlink was known).
  if (cfg.normalizer === 'antigravity') {
    excludeAntigravityProjectMarker(launchCwd);
    launchCwd = prepareAntigravityLaunchCwd(launchCwd, runDir);
    writeAntigravitySettings(configDir, launchCwd);
  }

  // snapshot the agent session-log dir before the run.
  const logDir = substituteEnv(cfg.session_log_dir, extraEnv);

  // opencode does not write capturable session logs on its own: snapshot the
  // pre-existing session ids before the run so the post-run export can diff to
  // the NEW ones (parity with Python snapshot_opencode_sessions). An
  // OpenCodeCaptureError -> capture indeterminate.
  let opencodeSessionSnapshot = new Set<string>();
  if (cfg.normalizer === 'opencode') {
    try {
      opencodeSessionSnapshot = snapshotOpencodeSessions({
        home: configDir,
        launchCwd,
      });
    } catch (e: unknown) {
      if (e instanceof OpenCodeCaptureError) {
        return writeIndeterminate({
          finalReason: `OpenCode session snapshot failed: ${e.message}`,
          checks: pre.records,
          error: { stage: 'capture', message: e.message },
        });
      }
      throw e;
    }
  }

  const snapshot = snapshotDir(logDir, cfg.session_log_glob);

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
    // The gemini launcher's GEMINI_DEFAULT_AUTH_TYPE reads $GEMINI_AUTH_TYPE_SH;
    // resolve it the same way GeminiAgent.provision does (Python: the gemini
    // branch in _run_scenario_inner). Mirrors the $CLAUDE_MODEL pattern.
    const geminiAuth = geminiAuthType();
    substitutions['$GEMINI_AUTH_TYPE'] = geminiAuth;
    substitutions['$GEMINI_AUTH_TYPE_SH'] = shellSingleQuote(geminiAuth);
  }
  if (cfg.name === 'pi') {
    substitutions['$PI_ENV_FILE'] = join(configDir, 'pi.env');
  }
  if (cfg.name === 'copilot' && copilotProvisioning !== undefined) {
    // Use the provisioning record's env file + minted session id (parity with
    // Python copilot_provisioning.env_file / .session_id) so the launcher's
    // `--session-id "$QUORUM_COPILOT_SESSION_ID"` resolves and the capture can
    // find the matching session-state/<id>/events.jsonl.
    substitutions['$COPILOT_ENV_FILE'] = copilotProvisioning.envFile;
    substitutions['$COPILOT_ENV_FILE_SH'] = shellSingleQuote(
      copilotProvisioning.envFile,
    );
    substitutions['$QUORUM_COPILOT_SESSION_ID'] = copilotProvisioning.sessionId;
  }
  // NOTE: provision-supplied substitutions the TS provision does not yet expose:
  //   - kimi: $KIMI_ENV_FILE / $KIMI_BINARY (KimiAgent.provision RETURNS these in
  //     its extra-env map, but that map is gauntlet env, not the context-dir
  //     substitution set; threading provision-substitutions back to the runner is
  //     deferred). The kimi-context launcher will carry unresolved placeholders
  //     until that lands.
  // CLAUDE needs none of these, so the claude context-dir path is COMPLETE.
  populateContextDir({
    codingAgentsDir: a.codingAgentsDir,
    codingAgent: family,
    runDir,
    substitutions,
    required: family === 'claude',
    forbiddenPlaceholders: family === 'claude' ? ['$CLAUDE_MODEL'] : [],
  });

  // copilot: gauntlet inherits a tightly-scoped allowlist instead of the full
  // host env, and a proxy var carrying credentialed userinfo is rejected
  // (parity with Python _copilot_gauntlet_env). copilotGauntletEnv can throw a
  // ProvisionError (credentialed proxy) -> mapped to a setup indeterminate.
  const gauntletEnvBase =
    cfg.name === 'copilot' ? copilotGauntletEnv(envSnapshot()) : undefined;

  writePhase(runDir, 'agent');

  // antigravity: agy reads auth from the live, token-rotating ~/.gemini/
  // oauth_creds.json. A SIGKILL/tmux-kill during a refresh can corrupt it and
  // brick the shared account — back it up before the run and verify/restore in a
  // finally (best-effort, restore only if the live file is missing or corrupt).
  // A live AgyRateLimitWatcher tails the run's agy.log during the drive and, on
  // a confirmed Code Assist 429, tears down gauntlet's private tmux server so the
  // cell fails fast instead of burning its full budget (parity with Python's
  // invoke_gauntlet watcher + agy_creds guard).
  const isAntigravity = cfg.normalizer === 'antigravity';
  const credBackup = isAntigravity ? backupCredential() : null;
  let watcher: AgyRateLimitWatcher | null = null;
  if (isAntigravity) {
    const agyLog = join(configDir, 'agy.log');
    mkdirSync(join(agyLog, '..'), { recursive: true });
    if (!existsSync(agyLog)) {
      // Pre-touch for a stable inode: agy (not quorum) creates the log when the
      // QA agent runs the launcher, which races the watcher's first poll.
      writeFileSync(agyLog, '');
    }
    watcher = new AgyRateLimitWatcher(agyLog, runDir, {
      teardown: (target: string) =>
        killGauntletTmuxForRun(target, (scratch) => killRunTmuxServer(scratch)),
    });
    watcher.start();
  }

  let gauntlet: GauntletLayer;
  try {
    ({ gauntlet } = await invokeGauntlet({
      storyPath,
      targetBinary: cfg.binary,
      runDir,
      maxTime,
      projectPrompt: cfg.project_prompt,
      launchCwd,
      extraEnv,
      envBase: gauntletEnvBase,
    }));
  } finally {
    if (watcher !== null) {
      await watcher.stop();
    }
    if (credBackup !== null) {
      credBackup.verifyOrRestore();
    }
  }

  // antigravity mid-run rate-limit short-circuit (parity with Python): when the
  // watcher tripped, agy was killed and the run dir has no usable transcript.
  // Intercept BEFORE the capture cascade so it surfaces as a recognizable
  // rate-limit verdict carrying ANTIGRAVITY_RATE_LIMIT_MARKER (for run_all's
  // latch) rather than a generic empty-trace capture indeterminate.
  if (watcher?.tripped) {
    return writeIndeterminate({
      finalReason:
        'antigravity hit a Code Assist rate limit mid-run; agy was ' +
        'killed and produced no usable transcript',
      gauntlet,
      checks: pre.records,
      error: {
        stage: 'gauntlet',
        message: `${ANTIGRAVITY_RATE_LIMIT_MARKER}: agy hit RESOURCE_EXHAUSTED mid-run; killed`,
      },
    });
  }

  // antigravity: a rate-limited Code Assist backend detected in the completed
  // agy.log (the watcher may not have tripped if the 429 landed late) is an
  // environmental indeterminate, not pass/fail. This precedes the capture
  // handling, parity with quorum/runner.py.
  if (isAntigravity) {
    const reason = antigravityRateLimitReason(configDir);
    if (reason !== null) {
      return writeIndeterminate({
        finalReason: reason,
        gauntlet,
        checks: pre.records,
        error: { stage: 'gauntlet', message: reason },
      });
    }
  }

  // opencode: after gauntlet exits, export the NEW sessions into the file-diffed
  // session-log dir so the generic capture can see them (parity with Python
  // export_opencode_sessions). Without this every opencode run captures zero
  // rows. An OpenCodeCaptureError -> capture indeterminate carrying the gauntlet
  // layer.
  let opencodeExportedPaths: readonly string[] = [];
  if (cfg.normalizer === 'opencode') {
    try {
      opencodeExportedPaths = exportOpencodeSessions({
        opencodeHome: configDir,
        exportDir: logDir,
        launchCwd,
        snapshot: opencodeSessionSnapshot,
      });
    } catch (e: unknown) {
      if (e instanceof OpenCodeCaptureError) {
        return writeIndeterminate({
          finalReason: `OpenCode session export failed: ${e.message}`,
          gauntlet,
          checks: pre.records,
          error: { stage: 'capture', message: e.message },
        });
      }
      throw e;
    }
  }

  // capture tool calls + token usage from the new session logs. The
  // empty-capture retry/guard (PRI-2081) re-diffs a session log still being
  // flushed when the post-drive diff runs, so a transient race does not become
  // a permanent capture indeterminate.
  const capture = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: cfg.session_log_glob,
      snapshot,
      normalizer: cfg.normalizer,
      runDir,
      launchCwd,
    },
    { attempts: CAPTURE_RETRY_ATTEMPTS, delayMs: CAPTURE_RETRY_DELAY_MS },
  );
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

  // opencode export/capture snapshot mismatch (parity with the Python check that
  // runs before the strict cascade): the export wrote session files but the
  // file-diff capture saw none as new — an export-snapshot timing problem rather
  // than a genuinely empty run.
  if (
    cfg.normalizer === 'opencode' &&
    capture.sourceLogs.length === 0 &&
    opencodeExportedPaths.length > 0
  ) {
    return writeIndeterminate({
      finalReason:
        'OpenCode exported session files, but file-diff capture did not ' +
        'see them as new; check export snapshot timing',
      gauntlet,
      checks: pre.records,
      error: {
        stage: 'capture',
        message: 'OpenCode export/capture snapshot mismatch',
      },
    });
  }

  // copilot post-capture branch (parity with the Python copilot block, which
  // runs ahead of the generic strict-capture cascade): secret-leak scan +
  // expected/unexpected session-state log checks, using the provisioning record.
  if (cfg.normalizer === 'copilot' && copilotProvisioning !== undefined) {
    const copilotVerdict = copilotCascadeVerdict({
      runDir,
      sessionLogDir: logDir,
      expectedEventsLog: copilotProvisioning.expectedEventsLog,
      envFile: copilotProvisioning.envFile,
      secretValues: copilotProvisioning.secretValues,
      sourceLogs: capture.sourceLogs,
      gauntlet,
      preRecords: pre.records,
    });
    if (copilotVerdict !== null) {
      return copilotVerdict;
    }
  }

  // Per-normalizer strict-capture / diagnostic cascade (parity with the Python
  // capture-stage block). A strict backend (claude/gemini/antigravity/opencode/
  // pi/kimi) that produced no usable transcript is an indeterminate with a
  // backend-specific reason — independent of whether any deterministic check
  // exists, which the generic composer captureEmpty path cannot cover.
  const cascade = captureCascadeVerdict({
    normalizer: cfg.normalizer,
    logDir,
    logGlob: cfg.session_log_glob,
    snapshot,
    launchCwd,
    captureResult: {
      sourceLogs: capture.sourceLogs,
      rowCount: capture.rowCount,
    },
    gauntlet,
    preRecords: pre.records,
    runDir,
  });
  if (cascade !== null) {
    return cascade;
  }

  // post-checks: again a crash is an error stage, a failure flows to compose.
  writePhase(runDir, 'checks');
  const post = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin,
    transcriptPath: capture.path,
    runDir,
  });
  if (post.exitCode !== 0) {
    return compose({
      gauntlet,
      checks: [...pre.records, ...post.records],
      captureEmpty,
      error: {
        stage: 'checks',
        message: `post-checks crashed (exit ${post.exitCode})`,
      },
    });
  }

  // Codex empty-capture qa-agent-misconfigured short-circuit (runs after
  // post-checks, parity with Python step 12b): an empty codex capture plus a
  // rollout launched from the wrong cwd surfaces as its own stage rather than a
  // wall of "never called" trace checks.
  const codexMisplaced = codexMisplacedVerdict({
    captureEmpty,
    normalizer: cfg.normalizer,
    logDir,
    logGlob: cfg.session_log_glob,
    snapshot,
    runDir,
    launchCwd,
  });
  if (codexMisplaced !== null) {
    return codexMisplaced;
  }

  // compose + attach economics (opaque at this layer; 4.1).
  const verdict = compose({
    gauntlet,
    checks: [...pre.records, ...post.records],
    captureEmpty,
    error: null,
  });
  // Economics is measurement, never worth losing a verdict over: a wrong-typed
  // artifact (version skew, tampering, a legacy pre-obol usage file) degrades to
  // a null economics block rather than crashing the composed verdict (PRI-2130,
  // parity with quorum's try/except around build_run_economics).
  const economics = await safeBuildRunEconomics(runDir);
  return {
    ...verdict,
    economics:
      economics === null ? null : OpaqueEconomicsSchema.parse(economics),
  };
}

// build_run_economics, isolated: any throw degrades to a null economics block so
// it cannot destroy an already-composed verdict (K-x-economics-call-site-guard).
async function safeBuildRunEconomics(
  runDir: string,
): Promise<Awaited<ReturnType<typeof buildRunEconomics>> | null> {
  try {
    return await buildRunEconomics(runDir);
  } catch {
    return null;
  }
}
