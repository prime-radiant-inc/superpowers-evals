// Dependency reconciliation for the managed evals checkout. Both preflight
// kinds run this right after ref sync: `bun install --frozen-lockfile`
// reconciles node_modules with the checked-out lockfile and refuses to touch
// the lockfile itself. Without it a package.json bump silently executes
// stale dependency code while provenance records the correct evals SHA
// (PRI-2833: obol 0.8.0 priced runs while the checkout declared ^0.9.0, and
// costs freeze at capture, so the damage was permanent per run).
//
// The frozen-lockfile flag is the loud-failure contract: a non-zero exit
// covers both "install failed" and "lockfile disagrees with package.json".
// node_modules↔lockfile reconciliation is the install's own job, so there is
// no separate verification pass (a `bun pm ls` diff would re-derive the same
// information less reliably across bun versions). The in-repo bunfig.toml
// minimumReleaseAge exclusion rides with the checkout, so age-gate behavior
// stays consistent.

import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import { ApplianceError } from './errors.ts';

function summarize(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return `status=${result.status ?? 'null'} stderr=${stderr === '' ? '<empty>' : stderr}`;
}

export function installEvalsDeps(
  evalsPath: string,
  runner: CommandRunner,
): void {
  const result = runner.run('bun', ['install', '--frozen-lockfile'], {
    cwd: evalsPath,
  });
  if (result.status !== 0) {
    throw new ApplianceError(
      'deps_install_failed',
      'deps',
      `bun install --frozen-lockfile failed in ${evalsPath}: ${summarize(result)}`,
    );
  }
}
