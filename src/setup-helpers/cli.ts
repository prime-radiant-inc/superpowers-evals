// `setup-helpers run <helper> [<helper>...]`. Scenario setup.sh scripts dispatch
// named helpers here. Each name is looked up in REGISTRY and invoked against
// QUORUM_WORKDIR. Helpers whose registry entry declares needsTemplateDir /
// needsSuperpowersRoot are filled from QUORUM_REPO_ROOT / SUPERPOWERS_ROOT.

import { join } from 'node:path';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import { getEnv } from '../env.ts';
import { REGISTRY } from './registry.ts';

// The resolved environment a helper chain needs. Passed explicitly so the core
// dispatch is a testable seam; main() reads these from the process environment.
export interface HelperEnv {
  readonly workdir: string;
  readonly repoRoot: string | undefined;
  readonly superpowersRoot: string | undefined;
}

// Dispatch each named helper in order against the resolved environment. Throws
// on the first failure (unknown helper, missing QUORUM_REPO_ROOT for a
// needsTemplateDir helper, missing SUPERPOWERS_ROOT for a needsSuperpowersRoot
// helper, or any error the helper itself raises). Awaits every call because
// install_codex_superpowers_plugin_hooks is async.
export async function runHelpers(
  names: readonly string[],
  helperEnv: HelperEnv,
): Promise<void> {
  for (const name of names) {
    const entry = REGISTRY[name];
    if (entry === undefined) {
      const known = Object.keys(REGISTRY).sort().join(', ');
      throw new Error(
        `setup-helpers: unknown helper '${name}'; known: ${known}`,
      );
    }

    let templateDir: string | undefined;
    if (entry.needsTemplateDir === true) {
      if (helperEnv.repoRoot === undefined || helperEnv.repoRoot === '') {
        throw new Error('setup-helpers: QUORUM_REPO_ROOT is not set');
      }
      templateDir = join(helperEnv.repoRoot, 'fixtures', 'template-repo');
    }

    let superpowersRoot: string | undefined;
    if (entry.needsSuperpowersRoot === true) {
      if (
        helperEnv.superpowersRoot === undefined ||
        helperEnv.superpowersRoot === ''
      ) {
        throw new Error('setup-helpers: SUPERPOWERS_ROOT is not set');
      }
      superpowersRoot = helperEnv.superpowersRoot;
    }

    await entry.fn({
      workdir: helperEnv.workdir,
      templateDir,
      superpowersRoot,
      run: defaultCommandRunner,
    });
  }
}

// Entrypoint. Returns the process exit code: 2 for a usage error, 1 for a
// missing workdir or a helper failure, 0 on success. SUPERPOWERS_ROOT rides the
// inherited environment (the runner injects only QUORUM_REPO_ROOT via envExtra;
// SUPERPOWERS_ROOT comes from envSnapshot).
async function main(argv: readonly string[]): Promise<number> {
  if (argv.length < 2 || argv[0] !== 'run') {
    process.stderr.write('usage: setup-helpers run <helper> [<helper>...]\n');
    return 2;
  }
  const workdir = getEnv('QUORUM_WORKDIR');
  if (workdir === undefined || workdir === '') {
    process.stderr.write('setup-helpers: QUORUM_WORKDIR is not set\n');
    return 1;
  }
  try {
    await runHelpers(argv.slice(1), {
      workdir,
      repoRoot: getEnv('QUORUM_REPO_ROOT'),
      superpowersRoot: getEnv('SUPERPOWERS_ROOT'),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  // The prelude's `setup-helpers` function (`bun run …/cli.ts "$@"`) inherits
  // this exit code, preserving the 2-vs-1 usage-vs-failure distinction.
  process.exit(await main(process.argv.slice(2)));
}
