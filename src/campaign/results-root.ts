// The one canonical results root a campaign run resolves. The controller,
// its detached children, and recovery all read and write the SAME run dirs,
// but they do not share a working directory: the controller runs from the
// evals checkout while every child runs with cwd = the campaign's evals
// worktree. A relative path therefore names two different directories —
// children writing verdicts, identities, and actual costs where the
// controller and recovery never look, so terminal evidence disappears and a
// resume can rerun paid work. Resolving once, to an absolute path, is what
// makes the three parties agree.
//
// Run dirs stay in `results/` and a campaign directory never contains or
// moves them (spec §"Storage semantics"), so the default anchors on the
// evals checkout, not on the campaign dir.

import { resolve } from 'node:path';
import { repoRoot } from '../paths.ts';

/** Absolute results root: an explicit value is canonicalized as given; the
 *  default is the evals checkout's own `results/` tree. */
export function resolveCampaignResultsRoot(explicit?: string): string {
  return explicit === undefined
    ? resolve(repoRoot(), 'results')
    : resolve(explicit);
}
