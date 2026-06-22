import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
import { RemoteExecution } from '../agents/claude-windows.ts';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  CopilotAgent,
  type CopilotProvisioning,
  copilotGauntletEnv,
  scanCopilotSecretLeaks,
} from '../agents/copilot.ts';
import { geminiAuthType } from '../agents/gemini.ts';
import { xdgHomeEnv, xdgHomeSubdirs } from '../agents/home-env.ts';
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
import { WindowsHost } from '../agents/windows-host.ts';
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
  agentConfigDir,
  CodingAgentConfigError,
  loadAgentConfig,
  resolveSessionLogDir,
} from '../contracts/agent-config.ts';
import { loadOsTarget } from '../contracts/os-target.ts';
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

// RunnerError lives in ./errors.ts so context.ts can throw it without a
// runner<->context import cycle. Re-exported here so it is part of this module's
// public surface.
export { RunnerError };

// Empty-capture retry/guard. A transient flush race between the Coding-Agent
// exiting and the capture diff reading its session log can otherwise become a
// permanent stage="capture" indeterminate. Bounded re-diff: worst case adds
// (attempts - 1) * delay ms to a genuinely-empty run before the per-backend
// diagnostic cascade proceeds unchanged.
const CAPTURE_RETRY_ATTEMPTS = 3;
const CAPTURE_RETRY_DELAY_MS = 2000;

// Create and return the per-run output dir
// <outRoot>/<scenario>-<agent>-<os>-<stamp>-<nonce>/.
export function allocateRunDir(
  outRoot: string,
  scenario: string,
  agent: string,
  os = 'linux',
): string {
  const dir = join(
    outRoot,
    `${scenario}-${agent}-${os}-${nowStampUtc()}-${hexNonce()}`,
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

// The valid gauntlet statuses quorum acts on, exactly {pass, fail, investigate}.
// Anything else (incl. 'errored', schema drift) coerces to 'investigate'.
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
// result.json. Iterates the run-id subdirs sorted-then-reversed and, on a
// missing/unreadable/malformed result.json, skips to the next-newest candidate.
// run_id is the DIRECTORY NAME (always concrete when a result exists), not
// result.json's optional runId field. Status outside {pass,fail,investigate}
// coerces to investigate. Returns null when no candidate yields a parseable
// result.
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

// Kill the gauntlet tmux server driving agy for this run. Gauntlet runs agy in a
// private tmux server whose pane cwd is
// <runDir>/gauntlet-agent/results/<runId>/scratch; the runId is
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
// not surfaced as a verdict error — it is discarded. A spawn-level failure
// rejects from spawnGauntlet instead.
export interface InvokeGauntletResult {
  readonly gauntlet: GauntletLayer;
}

export interface InvokeGauntletArgs extends GauntletArgvArgs {
  readonly launchCwd: string;
  // The per-run throwaway home. Exposed to the gauntlet child as
  // QUORUM_AGENT_HOME (mirroring the QUORUM_AGENT_CWD exposure) so tooling that
  // drives the agent can locate the agent's collapsed config dir.
  readonly runHomeDir: string;
  readonly extraEnv: Record<string, string>;
  // Base env gauntlet inherits. Defaults to the full host snapshot; copilot
  // passes a tightly-scoped allowlist (copilotGauntletEnv) so the host
  // environment (other provider keys, credentialed proxies) is not leaked into
  // the agent subprocess.
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
// match on stderr inline.
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
        QUORUM_AGENT_HOME: a.runHomeDir,
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

// Spawn the gauntlet CLI, then derive the gauntlet layer from its run dir. The
// exit code is DISCARDED — status always comes from result.json under
// gauntlet-agent/results/, falling back to a synthesized 'investigate' layer
// when no parseable result exists (a gauntlet that exited non-zero but wrote a
// valid result still yields that pass/fail; a non-zero exit with no/garbled
// result becomes investigate -> composer indeterminate, not a gauntlet-stage
// error). The subprocess env is the sanctioned snapshot overlaid with the launch
// cwd and the agent's extra env. A spawn-level failure (gauntlet not on PATH)
// still rejects from spawnGauntlet and surfaces as an 'unknown'-stage crash.
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
  readonly os?: string | undefined;
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
// without a type assertion.
const OpaqueEconomicsSchema = z.record(z.unknown());

// setup.sh may override the agent's launch cwd by writing this sentinel into the
// workdir.
const LAUNCH_CWD_SENTINEL = '.quorum-launch-cwd';

// Build an indeterminate verdict directly (NOT via compose, whose error path
// prefixes "quorum error (stage): …") so every early/cascade short-circuit
// carries its exact final_reason. The verdict is identity-stamped + persisted by
// runScenario.
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

// Render paths relative to the session-log dir for human-facing reasons.
function relToLogDir(logDir: string, paths: readonly string[]): string[] {
  return paths.map((p) => relative(logDir, p));
}

// Strict-capture dialects whose run is uninterpretable without a transcript:
// no source logs OR zero normalized rows is a capture indeterminate, regardless
// of whether any deterministic check is present. codex is NOT here — its empty
// case is the post-checks misplaced-rollout guard. copilot's leak/session-state
// checks run first in
// copilotCascadeVerdict; its no-transcript/zero-row floor lives here (the
// copilot branch is guarded by source_logs, so it cannot cover the empty case).
const STRICT_CAPTURE_NAMES: Readonly<Record<string, string>> = {
  antigravity: 'Antigravity',
  claude: 'Claude',
  copilot: 'Copilot',
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

// Per-normalizer strict-capture / diagnostic cascade. Returns a backend-specific
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

// Codex empty-capture qa-agent-misconfigured short-circuit, run AFTER
// post-checks. An empty capture plus a codex rollout sitting under run_dir but
// launched in a subdir other than launch_cwd means the QA agent skipped
// `cd $QUORUM_AGENT_CWD`. Surfaced as its own stage so downstream trace checks
// (all "never called") don't bury the cause.
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

// Render a path relative to `base` when it is under it, else the absolute path.
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

// Copilot post-capture branch. In order: (1) a secret-leak scan over the whole
// run dir (skipping the env file that legitimately holds the secret) ->
// indeterminate naming the leaking artifacts; (2) the expected session-state
// events.jsonl must be among the captured source logs; (3) no UNEXPECTED
// session-state logs may appear. Returns null to proceed when the run is clean.
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

// Secret temp dirs an agent's provisioning created OUTSIDE the run artifact
// root, to be reaped after the run (currently only kimi populates this). kimi
// writes a mode-0600 runtime env file into a run-scoped mkdtemp kept out of the
// run root so capture never snapshots it; the dir to reap is the env file's
// parent. Derived from the provision env map ($KIMI_ENV_FILE) rather than
// threading a runtime record back through provision().
export function runtimeCleanupDirs(
  extraEnv: Readonly<Record<string, string>>,
): string[] {
  const kimiEnvFile = extraEnv['KIMI_ENV_FILE'];
  return kimiEnvFile === undefined ? [] : [dirname(kimiEnvFile)];
}

// The kimi launch-agent substitutions, derived from KimiAgent.provision's extra
// -env map ($KIMI_ENV_FILE / $KIMI_BINARY). The kimi-context launcher sources
// "$KIMI_ENV_FILE" (already double-quoted in the script, so the value stays raw)
// and execs $KIMI_BINARY unquoted under `set -u`, so the binary value is
// pre-quoted here. Both are required: a kimi run reaching context setup without
// them is a setup-stage invariant failure — without it the launcher would carry
// unresolved placeholders and abort under `set -u`.
export function kimiLaunchSubstitutions(
  extraEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const envFile = extraEnv['KIMI_ENV_FILE'];
  const binary = extraEnv['KIMI_BINARY'];
  if (envFile === undefined) {
    throw new RunnerError(
      'kimi provisioning missing KIMI_ENV_FILE before context setup',
      'setup',
    );
  }
  if (binary === undefined) {
    throw new RunnerError(
      'kimi provisioning missing KIMI_BINARY before context setup',
      'setup',
    );
  }
  return {
    $KIMI_ENV_FILE: envFile,
    $KIMI_BINARY: shellSingleQuote(binary),
  };
}

// Per-run throwaway $HOME for the coding agent under test (spec
// docs/superpowers/specs/2026-06-15-per-run-home-isolation.md). Every coding
// agent runs with HOME and the XDG base dirs pinned under <runDir>/home so it
// cannot read or write the operator's real ~/.gemini, ~/.codex, ~/.claude,
// ~/.config, ~/.cache, or XDG dirs. $QUORUM_HOME_ENV is the pre-quoted
// `env`-line fragment each launcher splices into its `exec env …` line; it works
// in both the quoted-VAR launcher style (claude/pi) and the unquoted-$VAR_SH
// style (gemini) because every value is single-quoted here. Quorum's OWN
// credential reads stay anchored to the REAL home: Bun's os.homedir() snapshots
// $HOME at startup and ignores this per-subprocess pin (never setProcessEnv).
export function homeEnvSubstitutions(
  runHomeDir: string,
): Record<string, string> {
  const fragment = Object.entries(xdgHomeEnv(runHomeDir))
    .map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
    .join(' ');
  return {
    $QUORUM_AGENT_HOME: runHomeDir,
    $QUORUM_AGENT_HOME_SH: shellSingleQuote(runHomeDir),
    $QUORUM_HOME_ENV: fragment,
  };
}

// Reap the agent runtime's secret temp dirs. Each dir is removed recursively; an
// already-absent dir is fine, but any other removal failure — or a path that
// survives removal —
// is a setup-stage RunnerError so a leaked secret dir fails the run (mapped to
// indeterminate by runScenario) rather than silently persisting on disk.
export function cleanupAgentRuntime(cleanupDirs: readonly string[]): void {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true });
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
        continue;
      }
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      throw new RunnerError(
        `agent runtime cleanup failed for ${dir}: ${detail}`,
        'setup',
      );
    }
  }
  const leftovers = cleanupDirs.filter((dir) => existsSync(dir));
  if (leftovers.length > 0) {
    throw new RunnerError(
      `agent runtime cleanup failed; path remains: ${leftovers.join(', ')}`,
      'setup',
    );
  }
}

// Run one scenario end to end. Always allocates a run dir and always writes
// verdict.json; a thrown invariant maps to an indeterminate verdict via the
// composer rather than escaping.
export async function runScenario(
  a: RunScenarioArgs,
): Promise<RunScenarioResult> {
  const scenario = scenarioName(a.scenarioDir);
  const runDir = allocateRunDir(
    a.outRoot,
    scenario,
    a.codingAgent,
    a.os ?? 'linux',
  );
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

// Map a caught value to its error stage without assertions or non-null: a staged
// RunnerError carries its own, a SetupError is setup, anything else is unknown.
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

// The context dir an agent installs into <runDir>/gauntlet-agent/context/.
// Linux returns the runtime_family (or name); non-linux returns
// `${runtime_family ?? name}-${os}` (e.g. claude-windows for os=windows).
export function contextDirName(
  cfg: {
    name: string;
    runtime_family?: string | undefined;
  },
  os = 'linux',
): string {
  return os === 'linux'
    ? (cfg.runtime_family ?? cfg.name)
    : `${cfg.runtime_family ?? cfg.name}-${os}`;
}

// Claude-family binary PATH preflight: a claude run whose CLI is not installed
// fails fast at setup, not deep in the gauntlet drive. Other families are
// launched by gauntlet's own resolution, so this is claude-only. PATH is read
// through the sanctioned env snapshot, never process.env directly.
function preflightCodingAgentBinary(
  cfg: {
    runtime_family?: string | undefined;
    name: string;
    binary: string;
  },
  os: string,
): void {
  const family = cfg.runtime_family ?? cfg.name;
  // A non-linux (e.g. Windows) agent runs claude on the GUEST, not the Linux
  // host, so the host-PATH preflight does not apply.
  if (os !== 'linux') {
    return;
  }
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

// Resolve the agent launch cwd from the workdir's .quorum-launch-cwd sentinel.
// No sentinel -> the workdir. A sentinel whose named path does not exist is a
// runner error, so a stale/typo sentinel fails up front rather than launching
// gauntlet from a missing dir.
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

// Thin wrapper guaranteeing agent-runtime teardown on EVERY exit path of the
// run body — normal return, early indeterminate return, or throw. cleanupDirs
// starts empty and is populated by the body right after provisioning, so a crash
// before provisioning reaps nothing and a crash after still reaps the secret dir.
async function runInner(
  a: RunScenarioArgs,
  runDir: string,
): Promise<FinalVerdict> {
  const cleanupDirs: string[] = [];
  const os = a.os ?? 'linux';
  try {
    return await runInnerBody(a, runDir, cleanupDirs);
  } finally {
    cleanupAgentRuntime(cleanupDirs);
    // Windows runtime: best-effort removal of the per-run guest directory.
    // Teardown failure must NOT mask the verdict — the try/catch is intentional.
    if (os !== 'linux') {
      try {
        const osTarget = loadOsTarget(join(repoRoot(), 'os-targets'), os);
        if (osTarget.remote !== undefined) {
          new WindowsHost(osTarget.remote, defaultCommandRunner).ssh(
            `powershell -NoProfile -Command "Remove-Item -Recurse -Force '${osTarget.remote.win_run_root}\\${basename(runDir)}' -ErrorAction SilentlyContinue"`,
          );
        }
      } catch {
        // Swallow — teardown failure must not mask the verdict.
      }
    }
  }
}

async function runInnerBody(
  a: RunScenarioArgs,
  runDir: string,
  cleanupDirs: string[],
): Promise<FinalVerdict> {
  writePhase(runDir, 'setup');
  const os = a.os ?? 'linux';
  // Early guards run BEFORE any side effect (workdir creation, provisioning,
  // setup.sh, gauntlet).

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
  const osTarget = loadOsTarget(join(repoRoot(), 'os-targets'), os);
  // loadOsTarget guarantees remote is defined for any non-linux os target;
  // extract it to a typed const so downstream hooks can use it without `!`.
  const remoteConfig = osTarget.remote;
  if (!cfg.os_support.includes(os)) {
    throw new RunnerError(
      `coding-agent '${a.codingAgent}' does not support os '${os}'; supported: ${cfg.os_support.join(', ')}`,
      'setup',
    );
  }

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
  preflightCodingAgentBinary(cfg, os);

  for (const key of cfg.required_env) {
    if (!getEnv(key)) {
      throw new RunnerError(
        `${a.codingAgent}.yaml: required env var not set: ${key}`,
        'setup',
      );
    }
  }
  const agent = resolveAgent(cfg, os, osTarget);

  // setup: isolated config + workdir, claude provisioning, then setup.sh.
  const workdir = join(runDir, 'coding-agent-workdir');
  mkdirSync(workdir, { recursive: true });
  // Throwaway $HOME for the coding agent under test — always on, every agent.
  // Run-dir-relative so it's captured and reaped with the run (no mkdtemp / no
  // runtimeCleanupDirs). The launchers pin HOME/XDG/TMPDIR to it via
  // $QUORUM_HOME_ENV; pre-create the XDG base dirs + TMPDIR so every agent (and
  // opencode's capture subprocess) finds them present.
  const runHomeDir = join(runDir, 'home');
  for (const dir of [runHomeDir, ...xdgHomeSubdirs(runHomeDir)]) {
    mkdirSync(dir, { recursive: true });
  }
  // The agent's isolated config dir: rooted under the throwaway home at the
  // agent's home_config_subdir (it finds config via its $HOME default and the
  // launcher omits the config-dir env var).
  const configDir = agentConfigDir(cfg, runHomeDir);
  const home = {
    configDir,
    workdir,
    // skeletonRoot default = the coding-agents dir itself, so an agent that ships
    // a <family>-home-skeleton there gets it copied. Only CodexAgent consumes it
    // now (claude no longer seeds an onboarding skeleton).
    skeletonRoot: a.skeletonRoot ?? a.codingAgentsDir,
  };
  // copilot is special-cased: it mints a per-run session id, threads it through
  // provisionCopilot, and returns the rich CopilotProvisioning record the runner
  // needs for the $QUORUM_COPILOT_SESSION_ID substitution, the gauntlet env base,
  // and the post-run secret-leak / session-state cascade. Every other agent uses
  // the declarative provision() motion.
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
  // Track any secret temp dir provisioning created outside the run root (kimi's
  // runtime-env mkdtemp) so the runInner finally reaps it. Pushed AFTER provision
  // returns, so this covers the success path and every later run-exit; a
  // provision that THROWS after writing the secret file is the one window not
  // covered here.
  cleanupDirs.push(...runtimeCleanupDirs(extraEnv));
  // setup.sh needs QUORUM_REPO_ROOT (some fixtures resolve repo-relative paths /
  // setup-helpers against it).
  runSetup(a.scenarioDir, workdir, { QUORUM_REPO_ROOT: repoRoot() });
  // Windows runtime: runSetup built the workdir locally; push it to the guest so
  // the SSH-launched agent works in it. (Local model: agent runs here, no push.)
  if (os !== 'linux' && remoteConfig !== undefined) {
    new RemoteExecution(remoteConfig, defaultCommandRunner).pushWorkdir(
      workdir,
      basename(runDir),
    );
  }

  const checksRepoRoot = repoRoot();

  // pre-checks: a crash is an error stage; a failed assertion is a verdict.
  // checks.sh is guaranteed present (the missing-checks guard returned early).
  const pre = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: checksRepoRoot,
    runDir,
    configDir,
    codingAgent: a.codingAgent,
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
  // setup.sh, else the workdir. A sentinel naming a path that does not exist is a
  // runner error, not a silent launch from a nonexistent cwd. Resolved before the
  // opencode snapshot, which is keyed on the launch cwd.
  let launchCwd = resolveLaunchCwd(workdir);

  // antigravity launch-cwd preparation: (1) git-exclude the per-run project
  // marker so it never dirties the launch repo; (2) when the launch cwd has a
  // hidden path component (quorum runs live under .codex/ etc.) expose it through
  // a visible temp symlink, since Antigravity rejects --add-dir workspaces with
  // hidden components; (3) re-write trusted-workspaces settings against the
  // RESOLVED launch cwd (provision wrote them against the raw workdir, before the
  // sentinel/symlink was known).
  if (cfg.normalizer === 'antigravity') {
    excludeAntigravityProjectMarker(launchCwd);
    launchCwd = prepareAntigravityLaunchCwd(launchCwd, runDir);
    writeAntigravitySettings(configDir, launchCwd);
  }

  // snapshot the agent session-log dir before the run (substitute env vars +
  // expand a leading ~). session_log_dir templates reference $QUORUM_AGENT_HOME.
  const logDir = resolveSessionLogDir(cfg.session_log_dir, {
    QUORUM_AGENT_HOME: runHomeDir,
  });

  // opencode does not write capturable session logs on its own: snapshot the
  // pre-existing session ids before the run so the post-run export can diff to
  // the NEW ones. An OpenCodeCaptureError -> capture indeterminate.
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
  // paths from the substituted files rather than from env inheritance.
  const family = cfg.runtime_family ?? cfg.name;
  const isRemote = os !== 'linux';
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
    // Throwaway-$HOME isolation for the coding agent (always on). Each launcher
    // splices $QUORUM_HOME_ENV into its `exec env …` line.
    ...homeEnvSubstitutions(runHomeDir),
  };
  // Provision-supplied substitutions. For LOCAL claude these are the auth
  // env-file path the launcher sources; the path is deterministic
  // (configDir/.claude-env, written by ClaudeAgent.provision), so the runner
  // derives it rather than threading it back through provision(). A remote
  // claude (claude-windows) uses neither — its launcher SSHes to the guest and
  // the model is baked into the guest launch.cmd.
  if (family === 'claude' && !isRemote) {
    const claudeEnvFile = join(configDir, CLAUDE_ENV_FILE_NAME);
    substitutions['$CLAUDE_ENV_FILE'] = claudeEnvFile;
    substitutions['$CLAUDE_ENV_FILE_SH'] = shellSingleQuote(claudeEnvFile);
    substitutions['$CLAUDE_MODEL'] = cfg.model ?? '';
  }
  // Per-agent env-file substitutions the runner derives from configDir as
  // deterministic config-dir-relative paths.
  if (cfg.name === 'gemini') {
    const geminiEnvFile = join(configDir, '.gemini-env');
    substitutions['$GEMINI_ENV_FILE'] = geminiEnvFile;
    substitutions['$GEMINI_ENV_FILE_SH'] = shellSingleQuote(geminiEnvFile);
    // The gemini launcher's GEMINI_DEFAULT_AUTH_TYPE reads $GEMINI_AUTH_TYPE_SH;
    // resolve it the same way GeminiAgent.provision does. Mirrors the
    // $CLAUDE_MODEL pattern.
    const geminiAuth = geminiAuthType();
    substitutions['$GEMINI_AUTH_TYPE'] = geminiAuth;
    substitutions['$GEMINI_AUTH_TYPE_SH'] = shellSingleQuote(geminiAuth);
  }
  if (cfg.name === 'pi') {
    substitutions['$PI_ENV_FILE'] = join(configDir, 'pi.env');
  }
  if (family === 'serf') {
    // serf's launcher bakes `--model "$SERF_MODEL"`; resolve it from the YAML
    // model pin, mirroring the $CLAUDE_MODEL pattern. The model-agnostic adapter
    // keeps the provider/model entirely in serf.yaml.
    substitutions['$SERF_MODEL'] = cfg.model ?? '';
    substitutions['$SERF_MODEL_SH'] = shellSingleQuote(cfg.model ?? '');
  }
  if (cfg.name === 'copilot' && copilotProvisioning !== undefined) {
    // Use the provisioning record's env file + minted session id so the
    // launcher's `--session-id "$QUORUM_COPILOT_SESSION_ID"` resolves and the
    // capture can find the matching session-state/<id>/events.jsonl.
    substitutions['$COPILOT_ENV_FILE'] = copilotProvisioning.envFile;
    substitutions['$COPILOT_ENV_FILE_SH'] = shellSingleQuote(
      copilotProvisioning.envFile,
    );
    substitutions['$QUORUM_COPILOT_SESSION_ID'] = copilotProvisioning.sessionId;
  }
  if (cfg.normalizer === 'kimi') {
    // KimiAgent.provision returns $KIMI_ENV_FILE / $KIMI_BINARY in its extra-env
    // map; thread them into the context-dir substitution set so the kimi-context
    // launcher's `. "$KIMI_ENV_FILE"` / `exec $KIMI_BINARY` resolve under `set -u`.
    Object.assign(substitutions, kimiLaunchSubstitutions(extraEnv));
  }
  // Windows runtime: the WindowsClaudeAgent.provision return value carries the
  // $WIN_* launcher substitutions; merge them so the SSH launcher resolves.
  if (os !== 'linux') {
    Object.assign(substitutions, extraEnv);
  }
  populateContextDir({
    codingAgentsDir: a.codingAgentsDir,
    codingAgent: contextDirName(cfg, os),
    runDir,
    substitutions,
    required: family === 'claude' || family === 'serf',
    forbiddenPlaceholders:
      family === 'claude' && !isRemote
        ? ['$CLAUDE_MODEL']
        : family === 'serf'
          ? ['$SERF_MODEL']
          : [],
  });

  // copilot: gauntlet inherits a tightly-scoped allowlist instead of the full
  // host env, and a proxy var carrying credentialed userinfo is rejected.
  // copilotGauntletEnv can throw a ProvisionError (credentialed proxy) -> mapped
  // to a setup indeterminate.
  const gauntletEnvBase =
    cfg.name === 'copilot' ? copilotGauntletEnv(envSnapshot()) : undefined;

  writePhase(runDir, 'agent');

  // antigravity: agy reads auth from the live, token-rotating ~/.gemini/
  // oauth_creds.json. A SIGKILL/tmux-kill during a refresh can corrupt it and
  // brick the shared account — back it up before the run and verify/restore in a
  // finally (best-effort, restore only if the live file is missing or corrupt).
  // A live AgyRateLimitWatcher tails the run's agy.log during the drive and, on
  // a confirmed Code Assist 429, tears down gauntlet's private tmux server so the
  // cell fails fast instead of burning its full budget.
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
      runHomeDir,
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

  // antigravity mid-run rate-limit short-circuit: when the watcher tripped, agy
  // was killed and the run dir has no usable transcript.
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
  // handling.
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
  // session-log dir so the generic capture can see them. Without this every
  // opencode run captures zero rows. An OpenCodeCaptureError -> capture
  // indeterminate carrying the gauntlet layer.
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

  // Windows runtime: pull the guest's session logs + workdir into the local run
  // dir so the pre-run snapshot diff and post-checks see them (reproduce the
  // local artifact layout). Must precede the capture diff below.
  if (os !== 'linux' && remoteConfig !== undefined) {
    try {
      new RemoteExecution(remoteConfig, defaultCommandRunner).captureBack(
        runHomeDir,
        workdir,
        basename(runDir),
      );
    } catch (e: unknown) {
      return writeIndeterminate({
        finalReason: `capture: ${(e as Error).message}`,
        gauntlet,
        checks: pre.records,
        error: { stage: 'capture', message: (e as Error).message },
      });
    }
  }

  // capture tool calls + token usage from the new session logs. The
  // empty-capture retry/guard re-diffs a session log still being flushed when the
  // post-drive diff runs, so a transient race does not become a permanent capture
  // indeterminate.
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
  // path is not needed here, but the promise still has an owner.
  await captureTokenUsage({
    logDir,
    logGlob: cfg.session_log_glob,
    snapshot,
    normalizer: cfg.normalizer,
    runDir,
    launchCwd,
  });
  const captureEmpty = capture.rowCount === 0;

  // opencode export/capture snapshot mismatch, checked before the strict
  // cascade: the export wrote session files but the file-diff capture saw none as
  // new — an export-snapshot timing problem rather than a genuinely empty run.
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

  // copilot post-capture branch, run ahead of the generic strict-capture
  // cascade: secret-leak scan + expected/unexpected session-state log checks,
  // using the provisioning record.
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

  // Per-normalizer strict-capture / diagnostic cascade. A strict backend
  // (claude/gemini/antigravity/opencode/pi/kimi) that produced no usable
  // transcript is an indeterminate with a backend-specific reason — independent
  // of whether any deterministic check exists, which the generic composer
  // captureEmpty path cannot cover.
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
    repoRoot: checksRepoRoot,
    transcriptPath: capture.path,
    runDir,
    configDir,
    codingAgent: a.codingAgent,
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

  // Codex empty-capture qa-agent-misconfigured short-circuit, run after
  // post-checks: an empty codex capture plus a rollout launched from the wrong
  // cwd surfaces as its own stage rather than a wall of "never called" trace
  // checks.
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

  // compose + attach economics (opaque at this layer).
  const verdict = compose({
    gauntlet,
    checks: [...pre.records, ...post.records],
    captureEmpty,
    error: null,
  });
  // Economics is measurement, never worth losing a verdict over: a wrong-typed
  // artifact (version skew, tampering, a legacy pre-obol usage file) degrades to
  // a null economics block rather than crashing the composed verdict.
  const economics = await safeBuildRunEconomics(runDir);
  return {
    ...verdict,
    economics:
      economics === null ? null : OpaqueEconomicsSchema.parse(economics),
  };
}

// build_run_economics, isolated: any throw degrades to a null economics block so
// it cannot destroy an already-composed verdict.
async function safeBuildRunEconomics(
  runDir: string,
): Promise<Awaited<ReturnType<typeof buildRunEconomics>> | null> {
  try {
    return await buildRunEconomics(runDir);
  } catch {
    return null;
  }
}
