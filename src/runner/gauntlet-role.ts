import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type GauntletRoleRecord,
  GauntletRolesSchema,
} from '../contracts/conversation.ts';
import {
  applyAssessmentStop,
  readAssessmentCompletion,
} from './assessment-completion.ts';

export type RoleProcessArgs = {
  role: 'conversation' | 'assessment';
  binary: string;
  argv: string[];
  runDir: string;
  env: Readonly<Record<string, string | undefined>>;
  deadlineMs: number;
  shouldStop: () => boolean;
  socketPath?: string;
};
let active: ChildProcess | null = null;
let stop: ((signal: NodeJS.Signals) => void) | null = null;
export function currentRoleChild(): ChildProcess | null {
  return active;
}
export function stopActiveRole(signal: NodeJS.Signals): void {
  stop?.(signal);
}

// The exact private server supplies the pane process groups. Capture their
// identities before destroying the server so reparented descendants remain
// addressable even when the role cannot execute its adapter's finally block.
function observeRuntime(
  socketPath: string | undefined,
  groups: Set<number>,
): void {
  if (socketPath === undefined || !existsSync(socketPath)) return;
  const panes = spawnSync(
    'tmux',
    ['-S', socketPath, 'list-panes', '-a', '-F', '#{pane_pid}'],
    { encoding: 'utf8', timeout: 100 },
  );
  for (const pid of (panes.stdout ?? '').trim().split(/\s+/).map(Number)) {
    if (Number.isInteger(pid) && pid > 1) groups.add(pid);
  }
}
function terminateRuntime(
  socketPath: string | undefined,
  groups: Set<number>,
): void {
  if (socketPath === undefined) return;
  observeRuntime(socketPath, groups);
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  spawnSync('tmux', ['-S', socketPath, 'kill-server'], { timeout: 100 });
}

// tmux can retain its socket inode after kill-server. Probe the exact server;
// an execution failure or timeout cannot establish that it has stopped.
function runtimeServerAlive(socketPath: string): boolean {
  if (!existsSync(socketPath)) return false;
  const result = spawnSync('tmux', ['-S', socketPath, 'list-sessions'], {
    timeout: 100,
  });
  return result.status !== 1;
}

function runtimeGroupAlive(groups: Set<number>): boolean {
  return [...groups].some((pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

export async function invokeGauntletRole(
  a: RoleProcessArgs,
): Promise<GauntletRoleRecord> {
  if (active !== null) throw new Error('a Gauntlet role is already active');
  if (
    a.role === 'assessment' &&
    a.argv.some(
      (arg) =>
        arg === '--hard-deadline-at-ms' ||
        arg.startsWith('--hard-deadline-at-ms='),
    )
  )
    throw new Error('assessment hard deadline is owned by quorum');
  const path = join(a.runDir, 'gauntlet-roles.json');
  const roles = GauntletRolesSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  const record = roles[a.role];
  const save = () => writeFileSync(path, `${JSON.stringify(roles, null, 2)}\n`);
  if (a.shouldStop()) {
    record.stop_cause = 'cancelled';
    save();
    return record;
  }
  const groups = new Set<number>();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let checkParentStop = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      // The wall anchor travels to the child; elapsed time never renews the
      // parent's allowance, even if its event-loop timer is delayed.
      let startedAtMs = Date.now();
      let startedAtMono = performance.now();
      const hardDeadlineAtMs = startedAtMs + a.deadlineMs;
      const child = spawn(
        a.binary,
        a.role === 'assessment'
          ? [...a.argv, '--hard-deadline-at-ms', String(hardDeadlineAtMs)]
          : a.argv,
        {
          cwd: a.runDir,
          env: a.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // Preserve the conversation role's preexisting post-spawn allowance.
      if (a.role === 'conversation') {
        startedAtMs = Date.now();
        startedAtMono = performance.now();
      }
      active = child;
      let settled = false;
      const terminate = (
        cause: 'cancelled' | 'timed_out',
        signal: NodeJS.Signals,
      ) => {
        if (record.stop_cause !== null) return;
        record.stop_cause = cause;
        save();
        if (!settled) child.kill(signal);
        terminateRuntime(a.socketPath, groups);
        if (!settled)
          grace = setTimeout(() => {
            if (active === child) child.kill('SIGKILL');
            terminateRuntime(a.socketPath, groups);
          }, 200);
      };
      stop = (signal) => terminate('cancelled', signal);
      checkParentStop = () => {
        if (a.shouldStop()) terminate('cancelled', 'SIGTERM');
        else if (performance.now() - startedAtMono >= a.deadlineMs)
          terminate('timed_out', 'SIGTERM');
      };
      if (child.pid !== undefined) {
        record.started_at = new Date(startedAtMs).toISOString();
        save();
      }
      deadline = setTimeout(
        () => terminate('timed_out', 'SIGTERM'),
        a.role === 'assessment'
          ? Math.max(0, a.deadlineMs - (performance.now() - startedAtMono))
          : a.deadlineMs,
      );
      observeRuntime(a.socketPath, groups);
      poll = setInterval(() => {
        observeRuntime(a.socketPath, groups);
        if (a.shouldStop()) terminate('cancelled', 'SIGTERM');
      }, 20);
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        settled = true;
        record.process_exit = { code, signal };
        record.finished_at = new Date().toISOString();
        save();
        resolve();
      });
    });
    // A clean role must have completed its adapter cleanup, including the
    // groups observed before a server/socket disappeared.
    if (record.process_exit?.code === 0 && record.stop_cause === null) {
      const until = Date.now() + 200;
      while (runtimeGroupAlive(groups) && Date.now() < until) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    if (
      a.socketPath !== undefined &&
      (runtimeServerAlive(a.socketPath) || runtimeGroupAlive(groups)) &&
      record.process_exit?.code === 0 &&
      record.stop_cause === null
    ) {
      terminateRuntime(a.socketPath, groups);
      throw new Error(
        'conversation role exited without closing its private runtime',
      );
    }
    if (a.role === 'assessment') {
      let failure: unknown;
      checkParentStop();
      try {
        const outDir = join(a.runDir, record.out_dir);
        const completion = readAssessmentCompletion({
          outDir,
          runId: basename(outDir),
        });
        // terminal_at is the decision time, not evidence that publication or
        // this validation finished before the parent's hard stop.
        checkParentStop();
        record.stop_cause = applyAssessmentStop(
          record.stop_cause,
          completion.status,
        );
        save();
        if (completion.status === 'errored')
          throw new Error(`assessment errored: ${completion.reason}`);
        const expectedExit =
          completion.status === 'completed' &&
          JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'))
            .status === 'pass'
            ? 0
            : 1;
        if (
          record.process_exit?.code !== expectedExit ||
          record.process_exit.signal !== null
        )
          throw new Error('assessment process exit contradicts completion');
      } catch (error) {
        failure = error;
      } finally {
        checkParentStop();
      }
      if (record.stop_cause === null && failure !== undefined) throw failure;
    }
    return record;
  } finally {
    clearTimeout(deadline);
    clearTimeout(grace);
    clearInterval(poll);
    if (record.stop_cause !== null || record.process_exit?.code !== 0)
      terminateRuntime(a.socketPath, groups);
    active = null;
    stop = null;
  }
}
