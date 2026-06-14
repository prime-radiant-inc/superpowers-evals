import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { envSnapshot, getEnv } from './env.ts';
import { repoRoot } from './paths.ts';

/** Raised when a scenario's `setup.sh` exits non-zero; carries its output. */
export class SetupError extends Error {}

/**
 * Run a scenario's `setup.sh` from `workdir` with `QUORUM_WORKDIR` set. The
 * subprocess environment is the current snapshot (via {@link envSnapshot})
 * overlaid with `QUORUM_WORKDIR` and any `envExtra`. A non-zero exit throws a
 * {@link SetupError} carrying the captured stdout and stderr.
 */
export function runSetup(
  scenarioDir: string,
  workdir: string,
  envExtra: Record<string, string> = {},
): void {
  const script = join(scenarioDir, 'setup.sh');
  const proc = spawnSync(script, [], {
    cwd: workdir,
    env: {
      ...envSnapshot(),
      PATH: `${join(repoRoot(), 'bin-ts')}:${getEnv('PATH') ?? ''}`,
      QUORUM_WORKDIR: workdir,
      ...envExtra,
    },
    encoding: 'utf8',
  });
  if ((proc.status ?? 0) !== 0) {
    throw new SetupError(
      `setup.sh failed (exit ${proc.status})\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
  }
}
