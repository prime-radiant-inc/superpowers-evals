import { spawnSync } from 'node:child_process';

// Injectable subprocess seam for provisioning. Real provisioning shells out to
// agent CLIs (codex login, gemini extensions link, kimi/opencode/agy preflight,
// agy plugin install) that cannot run in the hermetic gate. Adapters call a
// CommandRunner instead of spawnSync directly, so tests inject a fake that
// records calls and returns canned results while live runs use the real impl.

export interface CommandOptions {
  // Working directory for the child process.
  readonly cwd?: string;
  // Full environment for the child (compose with envSnapshot() at the call site).
  readonly env?: Readonly<Record<string, string | undefined>>;
  // Data written to the child's stdin (e.g. an API key piped to `codex login`).
  readonly input?: string;
}

export interface CommandResult {
  // Exit status, or null when the process could not be spawned / was signalled.
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult;
}

// Real runner: a thin synchronous spawnSync wrapper. provision() is synchronous
// (it returns an env map), so the seam is synchronous too.
export class SpawnCommandRunner implements CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    const proc = spawnSync(command, [...args], {
      cwd: options?.cwd,
      env: options?.env === undefined ? undefined : { ...options.env },
      input: options?.input,
      encoding: 'utf8',
    });
    return {
      status: proc.status,
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
    };
  }
}

// Shared default used by resolveAgent / the runner for live provisioning.
export const defaultCommandRunner: CommandRunner = new SpawnCommandRunner();
