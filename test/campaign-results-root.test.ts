// One canonical results root: the controller, its detached children, and
// recovery must name the SAME run dirs while running from different working
// directories.
import { expect, test } from 'bun:test';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveCampaignResultsRoot } from '../src/campaign/results-root.ts';
import { repoRoot } from '../src/paths.ts';

test("the default results root is the evals checkout's own results/ tree, absolute", () => {
  const root = resolveCampaignResultsRoot();
  expect(isAbsolute(root)).toBe(true);
  expect(root).toBe(join(repoRoot(), 'results'));
});

test('an explicit relative root is canonicalized; an absolute one rides through unchanged', () => {
  expect(resolveCampaignResultsRoot('some/where')).toBe(resolve('some/where'));
  expect(isAbsolute(resolveCampaignResultsRoot('some/where'))).toBe(true);
  expect(resolveCampaignResultsRoot('/tmp/quorum-results')).toBe(
    '/tmp/quorum-results',
  );
});

test('the campaign directory is never the anchor — run dirs stay in results/ and a campaign dir never contains them', () => {
  const campaignDir = '/tmp/campaigns/abc-suite';
  expect(resolveCampaignResultsRoot().startsWith(campaignDir)).toBe(false);
});
