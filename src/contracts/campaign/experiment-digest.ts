import { jcsCanonicalize, sha256Hex } from './digest.ts';
import type { Experiment } from './experiment.ts';

/** Frozen scheduling estimates are inputs; only registration stamps are omitted. */
export function experimentDigest(
  experiment: Omit<Experiment, 'input_digest'> & { input_digest?: string },
): string {
  const {
    campaign_id: _id,
    input_digest: _digest,
    registered_at: _at,
    registered_by: _by,
    ...input
  } = experiment;
  return sha256Hex(jcsCanonicalize(input));
}
