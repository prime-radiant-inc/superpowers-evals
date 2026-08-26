// Kernel D2: the tri-state superpowers spec and the shared helpers every
// consumption site uses. The three states are load-bearing and never
// conflated: undefined = legacy ambient behavior (byte-identical to the
// pre-D2 harness); {mode:'none'} = explicit suppression (a stock arm —
// absence-of-env is NOT the none signal); {mode:'root'} = an explicit,
// already-materialized root (refs never reach the runner — Decision D-2).
import { getEnv } from '../env.ts';
import type { RunHome } from './index.ts';

export type SuperpowersSpec = { mode: 'none' } | { mode: 'root'; root: string };

export type ResolvedSuperpowers =
  | { kind: 'none' } // explicit suppression — skip all staging
  | { kind: 'root'; root: string } // threaded root (explicit, or ambient legacy)
  | { kind: 'missing' }; // legacy ambient absent — the pre-D2 hard-fail path

/** The one tri-state helper all adapters consume (Decision D-3). */
export function resolveSuperpowersRoot(home: RunHome): ResolvedSuperpowers {
  const spec = home.superpowers;
  if (spec !== undefined) {
    return spec.mode === 'root'
      ? { kind: 'root', root: spec.root }
      : { kind: 'none' };
  }
  const root = getEnv('SUPERPOWERS_ROOT');
  return root === undefined || root === ''
    ? { kind: 'missing' }
    : { kind: 'root', root };
}

/** Explicit-wins projection for the setup/checks child env (threading sites
 *  2-3): root overrides the allowlist read; none strips the key entirely;
 *  undefined leaves the projection untouched. */
export function projectSuperpowersEnv(
  spec: SuperpowersSpec | undefined,
  projected: Record<string, string | undefined>,
): void {
  if (spec === undefined) return;
  if (spec.mode === 'root') {
    projected['SUPERPOWERS_ROOT'] = spec.root;
  } else {
    delete projected['SUPERPOWERS_ROOT'];
  }
}

/** POSIX single-quote a literal for splicing into launcher script text: each
 *  `'` becomes `'\''`. Matches the ClaudeAgent shellSingleQuote (a private
 *  copy, the adapter-module idiom — a value import from ./index.ts would
 *  create an adapter module cycle). */
function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The structured launcher placeholder ($SUPERPOWERS_PLUGIN_ARGS) expansion —
 *  threading site 4. Root → the family-specific flags pointing at the threaded
 *  root, each argument POSIX single-quoted independently: the expansion is
 *  spliced unquoted into executable launcher text, and an explicit root is a
 *  caller-supplied path with no safe-path restriction, so it must arrive as
 *  literal argv bytes — never word-split, expanded, or executed. None → the
 *  flags are ELIDED (never empty-substituted). Undefined → the legacy ambient
 *  expansion (double quotes, this flag order, including the absent-env
 *  `--plugin-dir ""` form), byte-locked by the whole-body launcher-equality
 *  tests. */
export function superpowersPluginArgs(
  family: string,
  spec: SuperpowersSpec | undefined,
): string {
  if (spec?.mode === 'none') return '';
  if (spec?.mode === 'root') {
    switch (family) {
      case 'claude':
      case 'serf':
        return `--plugin-dir ${shellSingleQuote(spec.root)}`;
      case 'pi':
        return `--extension ${shellSingleQuote(spec.root)} --skill ${shellSingleQuote(`${spec.root}/skills`)}`;
      default:
        return '';
    }
  }
  const root = getEnv('SUPERPOWERS_ROOT') ?? '';
  switch (family) {
    case 'claude':
    case 'serf':
      return `--plugin-dir "${root}"`;
    case 'pi':
      return `--extension "${root}" --skill "${root}/skills"`;
    default:
      return '';
  }
}
