import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isBatchDir } from './render-batch.ts';

// A target that cannot be resolved to a run dir is an expected failure of the
// show command (coding standard 6.1), not a bug: the caller maps it to exit 1.
export class ShowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShowError';
  }
}

interface Candidate {
  readonly dir: string;
  readonly mtimeMs: number;
}

// Run dirs directly under resultsRoot that carry a verdict.json, sorted newest
// first by that file's mtime. Optionally restricted to names with a prefix.
function candidatesUnder(resultsRoot: string, prefix?: string): Candidate[] {
  if (!existsSync(resultsRoot)) {
    return [];
  }
  const out: Candidate[] = [];
  for (const name of readdirSync(resultsRoot)) {
    if (prefix !== undefined && !name.startsWith(prefix)) {
      continue;
    }
    const dir = join(resultsRoot, name);
    const verdictPath = join(dir, 'verdict.json');
    if (!existsSync(verdictPath)) {
      continue;
    }
    out.push({ dir, mtimeMs: statSync(verdictPath).mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Resolve a show target to the run dir whose verdict.json should be rendered:
//   undefined            -> newest run under resultsRoot (by verdict.json mtime)
//   a batch dir           -> that dir (caller renders the matrix)
//   dir with verdict.json -> that dir
//   a verdict.json file   -> its parent dir
//   a bare batch id        -> resultsRoot/batches/<id> when it is a batch dir
//   a scenario prefix      -> newest resultsRoot/<target>-* carrying a verdict
// Anything else throws ShowError. A returned path may be a run dir OR a batch
// dir; the caller branches via isBatchDir.
export function resolveTarget(
  target: string | undefined,
  resultsRoot: string,
): string {
  if (target === undefined) {
    const newest = candidatesUnder(resultsRoot)[0];
    if (newest === undefined) {
      throw new ShowError(`no runs found under ${resultsRoot}`);
    }
    return newest.dir;
  }

  // A path that is itself a batch dir resolves as-is (before the run-dir check).
  if (isBatchDir(target)) {
    return target;
  }

  // An existing non-batch directory must contain verdict.json; if it doesn't,
  // fail here rather than falling through to prefix matching — a named dir is
  // never reinterpreted as a prefix.
  if (existsSync(target) && statSync(target).isDirectory()) {
    if (existsSync(join(target, 'verdict.json'))) {
      return target;
    }
    throw new ShowError(`no verdict.json in ${target}`);
  }

  // A verdict.json file resolves to its parent — but only when the basename is
  // exactly "verdict.json", so a file like "oldverdict.json" is rejected.
  if (basename(target) === 'verdict.json' && existsSync(target)) {
    return dirname(target);
  }

  // A bare batch id under resultsRoot/batches/.
  const batchCandidate = join(resultsRoot, 'batches', target);
  if (isBatchDir(batchCandidate)) {
    return batchCandidate;
  }

  const matches = candidatesUnder(resultsRoot, `${target}-`);
  const first = matches[0];
  if (first !== undefined) {
    return first.dir;
  }

  throw new ShowError(`could not resolve target: ${target}`);
}
