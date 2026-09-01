import { spawn } from 'node:child_process';
import type { SuperpowersSpec } from '../agents/superpowers.ts';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import { getEnv } from '../env.ts';
import { COVERED_BY_LOCK_ENV } from './locks.ts';

// The child-spawner seam (Decision D-8): the dispatcher observes fake
// children with scripted protocol lines, exit codes, and run-dirs in tests;
// production wraps detached process-group-leader spawn (task 6). Journal FDs
// never reach children (stdio pinning — the Linux matrix asserts it).

export interface CampaignChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Inside the snapshot (R-SPN-8). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ChildExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnedCampaignChild {
  /** The dispatcher validates pgid == pid before journaling run_allocated
   *  (R-SPN-2); the production spawner guarantees detached setsid. */
  readonly pid: number;
  /** Buffered protocol surface: everything observed so far. */
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  /** Subscription for lines arriving after spawn (the parent-pinned
   *  `run_allocated: <run_id>` line; stderr feeds the sensors). */
  onStdoutLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  onExit(cb: (info: ChildExitInfo) => void): void;
}

export interface ChildSpawner {
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild;
}

export class SpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnError';
  }
}

/** R-SPN-2 pgid validation: detached setsid spawn makes the child its own
 *  process-group leader (pgid == pid, verified under Bun on Darwin); the
 *  group's existence is the check journaled pgids rely on. */
export function assertProcessGroupExists(pgid: number): void {
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      throw new SpawnError(
        `process group ${pgid} does not exist — pgid validation failed`,
      );
    }
    throw err;
  }
}

/** Production spawner (R-SPN-1): detached process-group-leader spawn. The
 *  stdio pinning is deliberate — journal FDs must never reach campaign
 *  children (O_CLOEXEC debt; the Linux matrix asserts non-inheritance).
 *  All observed output and the terminal event are LATCHED and replayed to
 *  subscribers that register late (C4): a fast child can never lose its
 *  `run_allocated` line or its exit notification. */
export class DetachedChildSpawner implements ChildSpawner {
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // ALL handlers are installed BEFORE any throw: a failed launch (async
    // ENOENT etc.) is consumed by the 'error' listener, so it can never
    // surface as an unhandled event that terminates the caller (C4/R1).
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutCbs: ((line: string) => void)[] = [];
    const stderrCbs: ((line: string) => void)[] = [];
    const exitCbs: ((info: ChildExitInfo) => void)[] = [];
    let exitInfo: ChildExitInfo | null = null;
    let stdoutBuf = '';
    let stderrBuf = '';
    const deliver = (
      buf: string,
      lines: string[],
      cbs: ((line: string) => void)[],
      chunk: string,
    ): string => {
      const next = buf + chunk;
      const parts = next.split('\n');
      const rest = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        for (const cb of cbs) cb(line);
      }
      return rest;
    };
    // Terminal settlement (C4/R2): publish only once the process has ended
    // AND both pipes have closed, each unterminated tail flushed exactly
    // once as a final line — a subscriber reacting to exit always sees the
    // complete record, and late subscribers replay it.
    let processEnd: ChildExitInfo | null = null;
    let stdoutEnded = false;
    let stderrEnded = false;
    let published = false;
    const flushStdoutTail = (): void => {
      if (stdoutBuf === '') return;
      const line = stdoutBuf;
      stdoutBuf = '';
      stdoutLines.push(line);
      for (const cb of stdoutCbs) cb(line);
    };
    const flushStderrTail = (): void => {
      if (stderrBuf === '') return;
      const line = stderrBuf;
      stderrBuf = '';
      stderrLines.push(line);
      for (const cb of stderrCbs) cb(line);
    };
    const settle = (): void => {
      if (published || processEnd === null || !stdoutEnded || !stderrEnded) {
        return;
      }
      published = true;
      flushStdoutTail();
      flushStderrTail();
      exitInfo = processEnd;
      for (const cb of exitCbs) cb(exitInfo);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf = deliver(
        stdoutBuf,
        stdoutLines,
        stdoutCbs,
        chunk.toString('utf8'),
      );
    });
    // 'end' and 'close' are alternative EOF signals across runtimes; the
    // first one to fire completes its stream.
    child.stdout?.on('end', () => {
      stdoutEnded = true;
      settle();
    });
    child.stdout?.on('close', () => {
      stdoutEnded = true;
      settle();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = deliver(
        stderrBuf,
        stderrLines,
        stderrCbs,
        chunk.toString('utf8'),
      );
    });
    child.stderr?.on('end', () => {
      stderrEnded = true;
      settle();
    });
    child.stderr?.on('close', () => {
      stderrEnded = true;
      settle();
    });
    child.on('exit', (code, signal) => {
      processEnd = { code, signal };
      settle();
    });
    // Launch/pipe failure: no streams may ever close, so it force-settles.
    // Exactly one failure notification per failed spawn — the first terminal
    // event wins (published guard), later ones are never re-notified.
    child.on('error', () => {
      processEnd = { code: null, signal: null };
      stdoutEnded = true;
      stderrEnded = true;
      settle();
    });
    // Backstop: the ChildProcess 'close' event means "process ended AND the
    // stdio streams have closed" — complete both streams if their own EOF
    // signals were missed, so settlement can never hang on a silent pipe.
    child.on('close', () => {
      stdoutEnded = true;
      stderrEnded = true;
      settle();
    });
    if (child.pid === undefined) {
      // The single typed failure the caller sees; the async 'error' event is
      // already consumed above, so the caller survives the launch failure.
      throw new SpawnError(
        `spawn failed: no pid for ${spec.command} ${spec.args.join(' ')}`,
      );
    }
    return {
      pid: child.pid,
      get stdoutLines() {
        return [...stdoutLines];
      },
      get stderrLines() {
        return [...stderrLines];
      },
      onStdoutLine(cb) {
        // Replay everything latched so far, then subscribe for the future.
        for (const line of stdoutLines) cb(line);
        stdoutCbs.push(cb);
      },
      onStderrLine(cb) {
        for (const line of stderrLines) cb(line);
        stderrCbs.push(cb);
      },
      onExit(cb) {
        if (exitInfo !== null) {
          cb(exitInfo);
          return;
        }
        exitCbs.push(cb);
      },
    };
  }
}

/** The parent-pinned protocol line (D1 Decision D-3; src/cli/run-command.ts
 *  runAllocatedLine): `run_allocated: <run_id>`. */
export function parseRunAllocatedLine(line: string): string | null {
  const m = /^run_allocated: (.+)$/.exec(line);
  return m === null ? null : (m[1] ?? '').trim() || null;
}

/** Children-never-acquire: campaign children are marked covered by the
 *  holder's accounting via this explicit env channel; locks.ts refuses
 *  acquisition when it is set. */
export function childCoveredEnv(): Record<string, string> {
  return { [COVERED_BY_LOCK_ENV]: '1' };
}

export interface CampaignChildArgvArgs {
  readonly evalsRoot: string;
  readonly scenarioDir: string;
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly os: string;
  readonly credentialName: string;
  readonly credentialsFile: string;
  readonly gauntletBin: string;
  /** The registered grader model (R-REG-20 singular grader). Authoritative
   *  for campaign children: without it the child grades with the runner's
   *  pinned default and the frozen campaign document lies about its grader. */
  readonly graderModel: string;
  readonly superpowers: SuperpowersSpec;
  readonly identity: CampaignIdentity;
}

/** R-SPN-8: the child argv addresses the SNAPSHOT's own entrypoint
 *  (`bun <evalsRoot>/src/cli/index.ts run …`, cwd inside the snapshot).
 *  A PATH-resolved or host-checkout quorum binary is forbidden. Carries the
 *  explicit superpowers mode, gauntletBin, and the campaign identity block
 *  (R-SPN-9, R-SPN-4). */
export function buildCampaignChildArgv(args: CampaignChildArgvArgs): string[] {
  const identity = CampaignIdentitySchema.parse(args.identity);
  const argv: string[] = [
    `${args.evalsRoot}/src/cli/index.ts`,
    'run',
    args.scenarioDir,
    '--coding-agent',
    args.codingAgent,
    '--coding-agents-dir',
    args.codingAgentsDir,
    '--out-root',
    args.outRoot,
    '--os',
    args.os,
    '--credential',
    args.credentialName,
    '--credentials-file',
    args.credentialsFile,
    '--gauntlet-bin',
    args.gauntletBin,
    '--grader-model',
    args.graderModel,
  ];
  if (args.superpowers.mode === 'root') {
    argv.push('--superpowers-root', args.superpowers.root);
  } else {
    argv.push('--no-superpowers');
  }
  argv.push('--campaign-identity', JSON.stringify(identity));
  return argv;
}

/** E7.5 new emission arm: 0-2 role-tagged grant entries, names only, never
 *  values. Grantable roles (api-key and bedrock-bearer credentials) each
 *  contribute their env NAME; flow-based auth (oauth/subscription) resolves
 *  native and contributes no entry (the dispatcher supplies role
 *  attribution, not key material). */
export function keyGrantsPayload(args: {
  subjectEnv?: string;
  graderEnv?: string;
}): { key_grants: { role: 'subject' | 'grader'; env: string }[] } {
  const key_grants: { role: 'subject' | 'grader'; env: string }[] = [];
  if (args.subjectEnv !== undefined)
    key_grants.push({ role: 'subject', env: args.subjectEnv });
  if (args.graderEnv !== undefined)
    key_grants.push({ role: 'grader', env: args.graderEnv });
  return { key_grants };
}

export interface CampaignChildEnvArgs {
  /** Caller-controlled base (PATH, HOME, projected credential vars). The
   *  child environment is CONSTRUCTED from it — the parent environment is
   *  never read wholesale (R-SPN-3). */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** Selected key grants (R-SPN-3): one env NAME per API-key role; the
   *  VALUES are resolved through the env seam and projected into the child
   *  env — names only are ever journaled (keyGrantsPayload). */
  readonly grants?: { subjectEnv?: string; graderEnv?: string };
}

/** R-SPN-3 (C4 spawn portion): the complete campaign-child environment —
 *  caller base + the children-never-acquire marker + the selected key
 *  VALUES. Values resolve through the env seam and fail loud on an unset
 *  selection — unset, empty, or whitespace-only (R-SPN-7); they never appear
 *  in any journal payload. */
export function composeCampaignChildEnv(
  args: CampaignChildEnvArgs,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.base)) {
    if (value !== undefined) env[name] = value;
  }
  env[COVERED_BY_LOCK_ENV] = '1';
  for (const grant of keyGrantsPayload(args.grants ?? {}).key_grants) {
    const value = getEnv(grant.env);
    if (value === undefined || value.trim() === '') {
      throw new SpawnError(
        `selected key env ${grant.env} (${grant.role}) is unset or empty — refusing to compose the child env (R-SPN-7)`,
      );
    }
    env[grant.env] = value;
  }
  return env;
}
