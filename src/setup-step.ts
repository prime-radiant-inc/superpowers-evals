import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_ENV_ALLOWLIST } from './checks/index.ts';
import { getEnv } from './env.ts';
import { repoRoot } from './paths.ts';

/** Raised when a scenario's `setup.sh` exits non-zero; carries its output. */
export class SetupError extends Error {}

// setup.sh executes scenario-authored shell — the same untrusted-author
// boundary as checks.sh, so it gets the same treatment: a non-secret
// allowlist projection of the host env plus quorum-owned vars, never the full
// snapshot. The base is the checks allowlist (corpus-governed for the sibling
// boundary; its SUPERPOWERS_ROOT is read by setup-helpers/cli.ts:94). Beyond
// it, every name requires concrete active-path evidence — the Fix-1 drop
// sweep ran all 85 scenarios' real setup.sh with one name removed at a time:
// dropping PATH broke 80/85 (exit 127: no binary resolution), dropping
// SUPERPOWERS_ROOT broke the 2 symlink_superpowers scenarios; dropping any
// other candidate (HOME, TMPDIR, SHELL, USER, LOGNAME, proxies, CA bundles)
// broke nothing (git auto-detects identity without HOME; runGit injects the
// fixture identity itself), so none of them are listed. A var setup.sh turns
// out to need on some host fails loudly (tool error) and is added with
// evidence; a var it doesn't need never leaks in.
export const SETUP_ENV_ALLOWLIST: readonly string[] = [
  ...CHECK_ENV_ALLOWLIST,
  'PATH',
];

/**
 * Run a scenario's `setup.sh` from `workdir` with `QUORUM_WORKDIR` set. The
 * subprocess environment is the {@link SETUP_ENV_ALLOWLIST} projection of the
 * host env overlaid with `QUORUM_*` vars and any `envExtra`.
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
      ...Object.fromEntries(
        SETUP_ENV_ALLOWLIST.map((name) => [name, getEnv(name)]),
      ),
      BASH_ENV: prelude,
      QUORUM_REPO_ROOT: root,
      QUORUM_WORKDIR: workdir,
      QUORUM_SCENARIO_DIR: scenarioDir,
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
