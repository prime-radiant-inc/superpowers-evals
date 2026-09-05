import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCommittedTransitions } from '../src/campaign/execution-journal.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import * as publication from '../src/campaign/report-publication.ts';
import * as sealing from '../src/campaign/seal.ts';
import { jcsCanonicalize } from '../src/contracts/campaign/digest.ts';
import {
  sessionTransitions,
  startTransition,
} from './fixtures/core-comparison/factory.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';
import { mixedComparisonFixture } from './fixtures/core-comparison/report-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function report() {
  const campaignDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'comparison-report-')),
  );
  roots.push(campaignDir);
  const f = mixedComparisonFixture();
  return {
    campaignDir,
    report: {
      report: foldComparisonReport(f),
      anchor: {
        campaign_id: f.experiment.campaign_id,
        input_digest: f.experiment.input_digest,
        last_sequence: f.transitions.length,
        prefix_digest: 'a'.repeat(64),
        roots: { campaign: campaignDir, results: join(campaignDir, 'results') },
        artifacts: [],
      },
    },
  };
}
test('canonical JSON and Markdown publish immutably at one anchor', () => {
  const f = report();
  const result = publication.publishReport(f);
  expect(readFileSync(join(f.campaignDir, 'report.json'), 'utf8')).toBe(
    publication.canonicalReportBytes(f.report).toString(),
  );
  expect(readFileSync(join(f.campaignDir, 'report.md'), 'utf8')).toBe(
    publication.renderReportMd(f.report),
  );
  expect(publication.publishReport(f).digest).toBe(result.digest);
  const changed = structuredClone(f.report);
  changed.anchor.last_sequence++;
  expect(() => publication.publishReport({ ...f, report: changed })).toThrow(
    'conflict',
  );
  expect(readFileSync(join(f.campaignDir, 'report.json'), 'utf8')).toBe(
    publication.canonicalReportBytes(f.report).toString(),
  );
  expect(() => sealing.sealReport(f)).toThrow('completed');
});
test('active status costs are behavior blind; conclusively dead controller permits interrupted prefix', () => {
  const f = lifecycleFixture();
  roots.push(f.root);
  const w = f.elect();
  for (const t of sessionTransitions(f.experiment).slice(1))
    w.commitTransition(t);
  w.release();
  const start = startTransition(f.experiment).payload;
  writeFileSync(
    `${f.loaded.config.live_spend_lock}.claim.json`,
    jcsCanonicalize({ ...start, campaign_dir: f.campaignDir }),
  );
  const args = { ...f, resultsRoot: join(f.root, 'custom-artifacts') };
  mkdirSync(args.resultsRoot);
  const active = publication.readComparisonReadout(args, {
    observe: () => 'live',
  });
  expect(active.report.behavior_available).toBe(false);
  expect(() =>
    publication.readComparisonReport(args, { observe: () => 'unknown' }),
  ).toThrow('active');
  const interrupted = publication.readComparisonReport(args, {
    observe: () => 'dead',
  });
  expect(interrupted.report.status).toBe('interrupted');
  expect(interrupted.report.complete).toBe(false);
  const prefix = readCommittedTransitions(f.campaignDir).at(-1)!;
  expect(interrupted.anchor.prefix_digest).toBe(prefix.prefix_digest);
  expect(interrupted.anchor.last_sequence).toBe(prefix.sequence);
});
test('healthy unbound startup is hidden and unknown launcher state never authorizes a report', () => {
  const f = lifecycleFixture();
  roots.push(f.root);
  const w = f.elect();
  w.commitTransition(startTransition(f.experiment));
  w.release();
  const args = { ...f, resultsRoot: join(f.root, 'custom') };
  mkdirSync(args.resultsRoot);
  expect(() =>
    publication.readComparisonReport(args, { observe: () => 'unknown' }),
  ).toThrow('active');
  expect(
    publication.readComparisonReport(args, { observe: () => 'dead' }).report
      .status,
  ).toBe('interrupted');
});
test('a later accounting prefix conflicts with a previously published interrupted report', () => {
  const f = report();
  publication.publishReport(f);
  const next = structuredClone(f.report);
  next.anchor.prefix_digest = 'b'.repeat(64);
  expect(() => publication.publishReport({ ...f, report: next })).toThrow(
    'conflict',
  );
});
