import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envSnapshot, getEnv } from './env.ts';
import { repoRoot } from './paths.ts';

/** Raised when a scenario's `setup.sh` exits non-zero; carries its output. */
export class SetupError extends Error {}

/**
 * Run a scenario's `setup.sh` from `workdir` with `QUORUM_WORKDIR` set. The
 * subprocess environment is the current snapshot (via {@link envSnapshot})
 * overlaid with `QUORUM_WORKDIR` and any `envExtra`.
 *
 * Mirrors Python `_run_scenario_script`: a missing `setup.sh` is a silent
 * no-op; a spawn-level failure (e.g. a non-executable file — `spawnSync` sets
 * `proc.error` with `status` null) throws, rather than being swallowed by the
 * exit-code guard; and a non-zero exit throws a {@link SetupError} carrying the
 * captured stdout and stderr.
 */
export function runSetup(
  scenarioDir: string,
  workdir: string,
  envExtra: Record<string, string> = {},
): void {
  const script = join(scenarioDir, 'setup.sh');
  if (!existsSync(script)) {
    return;
  }
  const proc = spawnSync(script, [], {
    cwd: workdir,
    env: {
      ...envSnapshot(),
      PATH: `${join(repoRoot(), 'bin-ts')}:${getEnv('PATH') ?? ''}`,
      QUORUM_WORKDIR: workdir,
      ...envExtra,
    },
    encoding: 'utf8',
    // Python's subprocess.run has no output cap. spawnSync defaults maxBuffer to
    // 1 MB of stdout+stderr; a verbose-but-successful setup.sh (git clone / bun
    // install / uv sync routinely exceed 1 MB) would otherwise return
    // {status:null, error:{code:'ENOBUFS'}}, which the spawn-error guard below
    // then mislabels as a spawn failure. Uncap to match Python.
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (proc.error) {
    throw new SetupError(
      `setup.sh failed to spawn (${(proc.error as NodeJS.ErrnoException).code ?? proc.error.message})`,
    );
  }
  if ((proc.status ?? 0) !== 0) {
    throw new SetupError(
      `setup.sh failed (exit ${proc.status})\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
  }
}
