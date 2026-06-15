import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { envSnapshot } from './env.ts';
import { repoRoot } from './paths.ts';

/** Raised when a scenario's `setup.sh` exits non-zero; carries its output. */
export class SetupError extends Error {}

/**
 * Run a scenario's `setup.sh` from `workdir` with `QUORUM_WORKDIR` set. The
 * subprocess environment is the current snapshot (via {@link envSnapshot})
 * overlaid with `QUORUM_WORKDIR` and any `envExtra`.
 *
 * A missing `setup.sh` is a silent no-op; a spawn-level failure (e.g. a
 * non-executable file — `spawnSync` sets `proc.error` with `status` null) throws,
 * rather than being swallowed by the exit-code guard; and a non-zero exit throws
 * a {@link SetupError} carrying the captured stdout and stderr.
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
  // setup.sh calls bare verbs (`setup-helpers run …`, etc). They resolve via the
  // sourced check prelude: BASH_ENV makes the non-interactive bash that runs
  // setup.sh source the prelude (which defines those functions) before the
  // script body. The prelude reads QUORUM_REPO_ROOT, set here and forwarded to
  // its delegating CLIs.
  const root = repoRoot();
  const prelude = join(root, 'src', 'checks', 'prelude.sh');
  const proc = spawnSync(script, [], {
    cwd: workdir,
    env: {
      ...envSnapshot(),
      BASH_ENV: prelude,
      QUORUM_REPO_ROOT: root,
      QUORUM_WORKDIR: workdir,
      ...envExtra,
    },
    encoding: 'utf8',
    // spawnSync defaults maxBuffer to 1 MB of stdout+stderr; a verbose-but-
    // successful setup.sh (git clone / bun install / uv sync routinely exceed
    // 1 MB) would otherwise return {status:null, error:{code:'ENOBUFS'}}, which
    // the spawn-error guard below then mislabels as a spawn failure. Uncap so a
    // chatty setup is not misread as a crash.
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
