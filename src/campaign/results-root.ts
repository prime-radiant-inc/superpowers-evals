// Canonical absolute result paths keep controller, worker publication and readout
// in agreement despite their distinct working directories. Control evidence stays
// in the campaign directory; worker artifacts stay under the results root.
import { resolve } from 'node:path';
import { repoRoot } from '../paths.ts';

/** Absolute results root: an explicit value is canonicalized as given; the
 *  default is the evals checkout's own `results/` tree. */
export function resolveCampaignResultsRoot(explicit?: string): string {
  return explicit === undefined
    ? resolve(repoRoot(), 'results')
    : resolve(explicit);
}
