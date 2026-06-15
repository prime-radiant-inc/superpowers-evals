import { readdirSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { getEnv } from '../env.ts';
import { type CommandRunner, defaultCommandRunner } from './command-runner.ts';

// Kill gauntlet's private named-socket tmux server for a given run.
//
// Gauntlet drives agy inside a per-session tmux server addressed by a randomly
// chosen named socket (`gauntlet-<epoch>-<rand>`). The name is chosen at runtime
// inside gauntlet — quorum cannot pre-compute it. Killing the launcher's process
// group does NOT reap agy because tmux reparents panes to PID 1; only
// `tmux -L <name> kill-server` does (gauntlet's own teardown path).
//
// Discovery strategy: glob the tmux socket dir for `gauntlet-*` sockets, then
// query each server for its pane cwd. The server whose pane path resolves to
// exactly the run's scratch directory is THIS run's server. Equality on resolved
// paths (not substring) guards against false-matching a sibling directory such
// as `scratch-extra`.
//
// Port of quorum/agy_teardown.py — the tmux subprocess calls route through the
// injectable CommandRunner seam (mirroring the Python `runner=subprocess.run`
// injection) so tests inject a fake instead of shelling out to real tmux.

export interface KillRunTmuxServerOptions {
  /** Injectable tmux runner. Defaults to the shared SpawnCommandRunner. */
  readonly runner?: CommandRunner;
  /** Injectable gauntlet-socket lister. Defaults to globbing the socket dir. */
  readonly listSockets?: () => string[];
}

// Mirror Python pathlib.Path(...).resolve(): resolve symlinks but never throw on
// a missing path (fs.realpathSync throws ENOENT; fall back to a non-resolving
// resolve()). Both the scratch dir and the tmux-reported pane path must be
// resolved this way: on macOS /tmp -> /private/tmp, so a purely lexical resolve()
// would false-negative when one side reports the realpath and the other the
// symlinked path, silently skipping the kill.
function realpathSafe(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/** The tmux socket directory: $TMUX_TMPDIR (or /tmp) / tmux-<uid>. */
export function socketDir(): string {
  const base = getEnv('TMUX_TMPDIR') ?? '/tmp';
  return join(base, `tmux-${userInfo().uid}`);
}

/** Sorted names of `gauntlet-*` sockets in the socket dir, or [] if absent. */
export function listGauntletSockets(): string[] {
  const dir = socketDir();
  try {
    if (!statSync(dir).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.startsWith('gauntlet-'))
    .sort();
}

// Pane start paths for a named tmux server, one per line. A non-zero exit (e.g.
// the server died between the glob and this query) yields no stdout, so this
// returns "" and the caller simply skips it.
function panePath(name: string, runner: CommandRunner): string {
  const r = runner.run('tmux', [
    '-L',
    name,
    'list-panes',
    '-a',
    '-F',
    '#{pane_start_path}',
  ]);
  return r.stdout.trim();
}

/**
 * Kill the gauntlet tmux server whose pane started in *scratchDir*.
 *
 * Returns true if a matching server was found and a `kill-server` was dispatched
 * (best-effort — not a guarantee the kill itself succeeded); false if no
 * gauntlet server's pane matched the run's scratch directory.
 */
export function killRunTmuxServer(
  scratchDir: string,
  opts: KillRunTmuxServerOptions = {},
): boolean {
  const runner = opts.runner ?? defaultCommandRunner;
  const listSockets = opts.listSockets ?? listGauntletSockets;

  const target = realpathSafe(scratchDir);
  for (const name of listSockets()) {
    for (const line of panePath(name, runner).split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      if (realpathSafe(trimmed) === target) {
        runner.run('tmux', ['-L', name, 'kill-server']);
        return true;
      }
    }
  }
  return false;
}
