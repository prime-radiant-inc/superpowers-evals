/**
 * Kill gauntlet's private named-socket tmux server for a given run.
 *
 * Gauntlet drives agy inside a per-session tmux server addressed by a randomly
 * chosen named socket (`gauntlet-<epoch>-<rand>`). The name is chosen at runtime
 * inside gauntlet — quorum cannot pre-compute it. Killing the launcher's process
 * group does NOT reap agy because tmux reparents panes to PID 1; only
 * `tmux -L <name> kill-server` does (gauntlet's own teardown path).
 *
 * Discovery strategy: glob the tmux socket dir for `gauntlet-*` sockets, then
 * query each server for its pane cwd. The server whose pane path resolves to
 * exactly the run's scratch directory is THIS run's server. Equality on resolved
 * paths (not substring) guards against false-matching a sibling directory such
 * as `scratch-extra`.
 *
 * Port of quorum/agy_teardown.py — public API is camelCase TS, logic is
 * identical. Shells to tmux via an injectable runner for testability, matching
 * the Python `runner=subprocess.run` injection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Subset of a subprocess result the teardown logic reads. */
export interface TmuxRunResult {
  returncode?: number;
  stdout?: string;
  stderr?: string;
}

/** A function that runs a tmux command and returns its result. */
export type TmuxRunner = (cmd: string[]) => TmuxRunResult;

export interface KillRunTmuxServerOptions {
  /** Injectable tmux runner. Defaults to a real Bun.spawnSync-backed runner. */
  runner?: TmuxRunner;
  /** Injectable gauntlet-socket lister. Defaults to globbing the socket dir. */
  listSockets?: () => string[];
}

/** The tmux socket directory: $TMUX_TMPDIR (or /tmp) / tmux-<uid>. */
export function socketDir(): string {
  const base = process.env["TMUX_TMPDIR"] ?? "/tmp";
  // os.userInfo().uid is -1 on platforms without uids (Windows); tmux is POSIX-only.
  const uid = os.userInfo().uid;
  return path.join(base, `tmux-${uid}`);
}

/** Sorted names of `gauntlet-*` sockets in the socket dir, or [] if absent. */
export function listGauntletSockets(): string[] {
  const d = socketDir();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(d);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(d)
    .filter((name) => name.startsWith("gauntlet-"))
    .sort();
}

/** Run a real tmux command via Bun.spawnSync. */
function defaultRunner(cmd: string[]): TmuxRunResult {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    returncode: proc.exitCode ?? undefined,
    stdout: proc.stdout ? proc.stdout.toString() : "",
    stderr: proc.stderr ? proc.stderr.toString() : "",
  };
}

/**
 * Pane start paths for a named tmux server, one per line.
 *
 * A non-zero exit (e.g. the server died between the glob and this query) yields
 * no stdout, so this returns "" and the caller simply skips it.
 */
function panePath(name: string, runner: TmuxRunner): string {
  const r = runner(["tmux", "-L", name, "list-panes", "-a", "-F", "#{pane_start_path}"]);
  return (r.stdout ?? "").trim();
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
  const runner = opts.runner ?? defaultRunner;
  const listSockets = opts.listSockets ?? listGauntletSockets;

  const target = path.resolve(scratchDir);
  for (const name of listSockets()) {
    for (const line of panePath(name, runner).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const resolved = path.resolve(trimmed);
      if (resolved === target) {
        runner(["tmux", "-L", name, "kill-server"]);
        return true;
      }
    }
  }
  return false;
}
