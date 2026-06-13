import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

// The single rule every scenario-taking command shares (run, check, new,
// run-all). A bare name (no path separator) lives under scenariosRoot; anything
// path-like (contains a separator or is absolute) is taken as given. So `foo`
// and `scenarios/foo` both point at scenarios/foo (when scenariosRoot is
// 'scenarios'), letting tab-completed paths and bare names work interchangeably
// across the CLI. Relativeness is preserved — callers resolve() when they need
// an absolute path. Existence is the caller's concern.
export function scenarioDirFor(arg: string, scenariosRoot: string): string {
  if (isAbsolute(arg) || arg.includes('/')) {
    return normalize(arg);
  }
  return join(scenariosRoot, arg);
}

// scenarioDirFor, but only when the directory exists — for commands that resolve
// an EXISTING scenario (run, check). Returns undefined otherwise.
export function resolveScenarioDir(
  arg: string,
  scenariosRoot: string,
): string | undefined {
  const dir = scenarioDirFor(arg, scenariosRoot);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

// The bare scenario name from an argument (its final path segment). For
// name-matching uses like the run-all --scenarios filter: `scenarios/foo` and
// `foo` both yield `foo`.
export function scenarioName(arg: string): string {
  const segments = arg.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last ?? arg;
}
