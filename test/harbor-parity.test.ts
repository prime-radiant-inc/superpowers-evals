import { expect, test } from 'bun:test';
import { disjointFromHarbor } from '../scripts/harbor-parity.ts';

// Verified against the real claude trace
// results/superpowers-bootstrap-claude-20260616T052827Z-bf6f
// Harbor inclusive buckets → disjoint conversion:
//   uncached = total_prompt_tokens − total_cached_tokens − total_cache_creation_input_tokens
//   cached   = total_cached_tokens
//   cache_write = total_cache_creation_input_tokens
test('disjointFromHarbor converts inclusive Harbor buckets to disjoint buckets', () => {
  const harborFinalMetrics = {
    total_prompt_tokens: 94269,
    total_cached_tokens: 71457,
    total_completion_tokens: 528,
    extra: {
      total_cache_creation_input_tokens: 17118,
    },
  };

  const result = disjointFromHarbor(harborFinalMetrics);

  expect(result).toEqual({
    uncached: 5694,
    cached: 71457,
    cache_write: 17118,
    completion: 528,
  });
});
