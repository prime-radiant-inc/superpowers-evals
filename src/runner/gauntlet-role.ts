import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GauntletRoleRecord,
  GauntletRolesSchema,
} from '../contracts/conversation.ts';

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
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(a.binary, a.argv, {
        cwd: a.runDir,
        env: a.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      active = child;
      const terminate = (
        cause: 'cancelled' | 'timed_out',
        signal: NodeJS.Signals,
      ) => {
        if (record.stop_cause !== null) return;
        record.stop_cause = cause;
        save();
        child.kill(signal);
        terminateRuntime(a.socketPath, groups);
        grace = setTimeout(() => {
          if (active === child) child.kill('SIGKILL');
          terminateRuntime(a.socketPath, groups);
        }, 200);
      };
      stop = (signal) => terminate('cancelled', signal);
      if (child.pid !== undefined) {
        record.started_at = new Date().toISOString();
        save();
      }
      deadline = setTimeout(
        () => terminate('timed_out', 'SIGTERM'),
        a.deadlineMs,
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
