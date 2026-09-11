import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublishedArtifactBytes } from '../src/campaign/attempt-publish.ts';
import { observeCampaignStatus } from '../src/campaign/cancellation.ts';
import { readCommittedTransitions } from '../src/campaign/execution-journal.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import * as publication from '../src/campaign/report-publication.ts';
import * as sealing from '../src/campaign/seal.ts';
import { jcsCanonicalize } from '../src/contracts/campaign/digest.ts';
import { ReportSchema } from '../src/contracts/campaign/report.ts';
import {
  sessionTransitions,
  startTransition,
} from './fixtures/core-comparison/factory.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';
import {
  finishPublicationFixture,
  completedPublicationFixture as makePublicationFixture,
} from './fixtures/core-comparison/publication.ts';
import { mixedComparisonFixture } from './fixtures/core-comparison/report-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function completedPublicationFixture(validityBlockId = 'primary') {
  const f = makePublicationFixture(validityBlockId);
  roots.push(f.root);
  return f;
}
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

test('a live bound controller with a foreign lease cannot expose interrupted behavior', () => {
  const f = lifecycleFixture();
  roots.push(f.root);
  const w = f.elect();
  for (const t of sessionTransitions(f.experiment).slice(1))
    w.commitTransition(t);
  w.release();
  writeFileSync(
    `${f.loaded.config.live_spend_lock}.claim.json`,
    jcsCanonicalize({
      ...startTransition(f.experiment).payload,
      campaign_dir: f.campaignDir,
    }),
  );
  mkdirSync(f.loaded.config.live_spend_lock!);
  writeFileSync(
    join(
      f.loaded.config.live_spend_lock!,
      'owner-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ),
    '999\n123\n456\n',
  );
  expect(observeCampaignStatus(f, { observe: () => 'live' })).toEqual({
    state: 'unresolved',
    next_action: 'cancel',
  });
  expect(() =>
    publication.readComparisonReport(
      { ...f, resultsRoot: join(f.root, 'results') },
      { observe: () => 'live' },
    ),
  ).toThrow('active');
});

test('producer publications flow through one real journal prefix, remain behavior blind while active, and seal the completed anchor', () => {
  const f = completedPublicationFixture();
  const active = publication.readComparisonReadout(f, {
    observe: () => 'live',
  });
  expect(active.report.accounting.subject_cost_usd).toEqual({
    known_subtotal: 3,
    observed: 2,
    attempts: 2,
    complete: true,
  });
  expect(
    active.report.attempts.every(
      (a) =>
        a.accepted_outcome === null &&
        a.evidence.observed_outcome === null &&
        a.evidence.gauntlet === null &&
        a.evidence.checks === null,
    ),
  ).toBe(true);
  let advanced = false;
  const completed = publication.readComparisonReport(f, {
    observe: () => {
      if (!advanced) {
        advanced = true;
        finishPublicationFixture(f);
      }
      return 'live';
    },
  });
  const prefix = readCommittedTransitions(f.campaignDir).at(-1)!;
  expect(completed.anchor.last_sequence).toBe(prefix.sequence);
  expect(completed.anchor.prefix_digest).toBe(prefix.prefix_digest);
  expect(completed.report.comparisons[0]!.paired.pass_rate).toEqual({
    n: 1,
    baseline_mean: 1,
    treatment_mean: 0,
    mean_delta: -1,
  });
  expect(completed.report.complete).toBe(true);
  const terminationPath = join(f.campaignDir, 'termination.json');
  const terminationBytes = readFileSync(terminationPath);
  writeFileSync(terminationPath, '{}');
  expect(() =>
    sealing.sealReport({ campaignDir: f.campaignDir, report: completed }),
  ).toThrow();
  writeFileSync(terminationPath, terminationBytes);
  const result = sealing.sealReport({
    campaignDir: f.campaignDir,
    report: completed,
  });
  expect(
    JSON.parse(readFileSync(join(f.campaignDir, 'report-seal.json'), 'utf8')),
  ).toEqual({
    schema_version: 'quorum.comparison-seal/v1',
    report_digest: result.digest,
    anchor: completed.anchor,
  });
  expect(completed.anchor.artifacts.map((r) => `${r.root}/${r.path}`)).toEqual(
    completed.anchor.artifacts.map((r) => `${r.root}/${r.path}`).sort(),
  );
  for (const ref of completed.anchor.artifacts)
    expect(
      readPublishedArtifactBytes(completed.anchor.roots[ref.root], ref).length,
    ).toBe(ref.bytes);
  writeFileSync(join(f.campaignDir, 'validity.json'), '{}');
  const damaged = publication.readComparisonReport(f);
  expect(damaged.report.comparisons[0]!.paired.pass_rate.n).toBe(0);
  expect(damaged.report.accounting.subject_cost_usd.known_subtotal).toBe(3);
  expect(damaged.report.complete).toBe(false);
});

for (const change of [
  'subtotal',
  'role completeness',
  'accounting completeness',
  'omit termination',
  'omit attempt',
  'empty inventory',
] as const) {
  test(`seal refuses caller-edited ${change} before publishing`, () => {
    const f = completedPublicationFixture();
    finishPublicationFixture(f);
    const canonical = publication.readComparisonReport(f);
    const edited = structuredClone(canonical);
    if (change === 'subtotal')
      edited.report.accounting.subject_cost_usd.known_subtotal += 100;
    if (change === 'role completeness')
      edited.report.attempts[0]!.evidence.subject_cost_complete = false;
    if (change === 'accounting completeness') {
      edited.report.accounting.subject_cost_usd.complete = false;
      edited.report.accounting.subject_cost_usd.observed = 1;
    }
    if (change === 'omit termination')
      edited.anchor.artifacts = edited.anchor.artifacts.filter(
        (ref) => ref.path !== 'termination.json',
      );
    if (change === 'omit attempt')
      edited.anchor.artifacts = edited.anchor.artifacts.filter(
        (ref) => ref.root !== 'results',
      );
    if (change === 'empty inventory') edited.anchor.artifacts = [];
    expect(ReportSchema.safeParse(edited).success).toBe(true);
    expect(() =>
      sealing.sealReport({ campaignDir: f.campaignDir, report: edited }),
    ).toThrow('canonical');
    expect(existsSync(join(f.campaignDir, 'report.json'))).toBe(false);
    expect(existsSync(join(f.campaignDir, 'report-seal.json'))).toBe(false);
  });
}
test('the unchanged canonical completed report seals idempotently', () => {
  const f = completedPublicationFixture();
  finishPublicationFixture(f);
  const canonical = publication.readComparisonReport(f);
  const first = sealing.sealReport({
    campaignDir: f.campaignDir,
    report: canonical,
  });
  const jsonBytes = readFileSync(join(f.campaignDir, 'report.json'));
  const markdownBytes = readFileSync(join(f.campaignDir, 'report.md'));
  const sealBytes = readFileSync(join(f.campaignDir, 'report-seal.json'));
  const reread = publication.readComparisonReport(f);
  const second = sealing.sealReport({
    campaignDir: f.campaignDir,
    report: reread,
  });
  expect(second).toEqual(first);
  expect(jsonBytes.equals(publication.canonicalReportBytes(reread))).toBe(true);
  expect(readFileSync(join(f.campaignDir, 'report.json'))).toEqual(jsonBytes);
  expect(readFileSync(join(f.campaignDir, 'report.md'))).toEqual(markdownBytes);
  expect(readFileSync(join(f.campaignDir, 'report-seal.json'))).toEqual(
    sealBytes,
  );
});

test('seal rejects a forged analytical completeness claim despite authentic artifact bytes', () => {
  const f = completedPublicationFixture('foreign-block');
  finishPublicationFixture(f);
  const canonical = publication.readComparisonReport(f);
  expect(canonical.report.status).toBe('completed');
  expect(canonical.report.complete).toBe(false);
  const forged = structuredClone(canonical);
  forged.report.complete = true;
  expect(ReportSchema.safeParse(forged).success).toBe(true);
  expect(() =>
    sealing.sealReport({ campaignDir: f.campaignDir, report: forged }),
  ).toThrow('canonical');
  expect(existsSync(join(f.campaignDir, 'report.json'))).toBe(false);
});

test('same-prefix evidence changes get distinct immutable snapshot bytes', () => {
  const first = report();
  expect(
    first.report.report.comparisons[0]!.arms[0]!.available.subject_cost_usd,
  ).toBe(3);
  const a = publication.publishReportSnapshot(first);
  const directory = (digest: string) =>
    join(
      first.campaignDir,
      'report-snapshots',
      `${first.report.anchor.last_sequence}-${digest}`,
    );
  const original = readFileSync(join(directory(a.digest), 'report.json'));
  const changed = mixedComparisonFixture();
  changed.evidenceByAttempt.get('c1-r1-b-1')!.subject_cost_complete = false;
  const next = { ...first.report, report: foldComparisonReport(changed) };
  expect(next.report.comparisons[0]!.arms[0]!.available.subject_cost_usd).toBe(
    2,
  );
  const b = publication.publishReportSnapshot({ ...first, report: next });
  expect(b.digest).not.toBe(a.digest);
  expect(readFileSync(join(directory(a.digest), 'report.json'))).toEqual(
    original,
  );
  expect(
    readFileSync(join(directory(b.digest), 'report.json')).equals(
      publication.canonicalReportBytes(next),
    ),
  ).toBe(true);
  expect(publication.publishReportSnapshot(first).digest).toBe(a.digest);
  expect(existsSync(join(first.campaignDir, 'report.json'))).toBe(false);
});
