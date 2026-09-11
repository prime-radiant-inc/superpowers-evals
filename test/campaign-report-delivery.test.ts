import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { renderCampaignReport } from '../src/appliance/campaign-render.ts';
import * as credentialScope from '../src/appliance/credential-scope.ts';
import { journalFsOps } from '../src/campaign/journal.ts';
import {
  deliverComparisonReport,
  readReportDelivery,
} from '../src/campaign/report-delivery.ts';
import { readComparisonReport } from '../src/campaign/report-publication.ts';
import { sealReport } from '../src/campaign/seal.ts';
import {
  fixtureTime,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';
import {
  completedPublicationFixture,
  finishPublicationFixture,
} from './fixtures/core-comparison/publication.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const processes = { observe: () => 'dead' as const };
function completed() {
  const f = completedPublicationFixture();
  roots.push(f.root);
  finishPublicationFixture(f);
  return f;
}
test('durable delivery preserves first digest and actual acceptance-to-publication clock', () => {
  const f = completed();
  const first = deliverComparisonReport({
    ...f,
    processes,
    now: () => Date.parse(fixtureTime(11)),
  });
  expect(first.delivery.request_accepted_at).toBe(fixtureTime(1));
  expect(first.delivery.execution_started_at).toBe(fixtureTime(3));
  expect(
    Date.parse(first.delivery.artifacts_published_at) -
      Date.parse(first.delivery.request_accepted_at!),
  ).toBe(10000);
  expect(
    Date.parse(first.delivery.execution_started_at!) -
      Date.parse(first.delivery.request_accepted_at!),
  ).toBe(2000);
  expect(first.delivery.requested_at).toBeNull();
  const again = deliverComparisonReport({
    ...f,
    processes,
    now: () => Date.parse(fixtureTime(21)),
  });
  expect(again).toEqual(first);
  expect(
    JSON.parse(
      readFileSync(join(f.campaignDir, 'report-delivery.json'), 'utf8'),
    ),
  ).toEqual(first.delivery);
  expect(first.delivery.measurement_readiness.some((o) => !o.complete)).toBe(
    true,
  );
});
test('failed report write leaves no successful delivery and retry records recovery time', () => {
  const f = completed();
  mkdirSync(join(f.campaignDir, 'report.md'));
  expect(() =>
    deliverComparisonReport({
      ...f,
      processes,
      now: () => Date.parse(fixtureTime(11)),
    }),
  ).toThrow();
  expect(existsSync(join(f.campaignDir, 'report-delivery.json'))).toBe(false);
  rmSync(join(f.campaignDir, 'report.md'), { recursive: true });
  expect(
    deliverComparisonReport({
      ...f,
      processes,
      now: () => Date.parse(fixtureTime(21)),
    }).delivery.artifacts_published_at,
  ).toBe(fixtureTime(21));
});
test('crash after report and seal but before receipt recovers without changing report bytes', () => {
  const f = completed();
  const published = sealReport({
    campaignDir: f.campaignDir,
    report: readComparisonReport(f, processes),
  });
  const delivered = deliverComparisonReport({
    ...f,
    processes,
    now: () => Date.parse(fixtureTime(21)),
  });
  expect(delivered.delivery.report_digest).toBe(published.digest);
  expect(delivered.delivery.artifacts_published_at).toBe(fixtureTime(21));
  writeFileSync(
    join(f.campaignDir, 'report-delivery.json'),
    JSON.stringify({ ...delivered.delivery, report_digest: 'b'.repeat(64) }),
  );
  expect(() =>
    deliverComparisonReport({ ...f, processes, now: Date.now }),
  ).toThrow('conflict');
});
test('interrupted session publishes only a snapshot receipt with unavailable attempt clock', () => {
  const f = lifecycleFixture();
  roots.push(f.root);
  const w = f.elect();
  for (const t of sessionTransitions(f.experiment).slice(1))
    w.commitTransition(t);
  w.commitTransition(
    transition(
      'ended',
      {
        outcome: 'interrupted',
        reason: 'cancelled before preparation',
        cancel_intent: null,
      },
      3,
    ),
  );
  w.release();
  const delivered = deliverComparisonReport({
    ...f,
    resultsRoot: join(f.root, 'results'),
    processes,
    now: () => Date.parse(fixtureTime(11)),
  });
  expect(delivered.delivery.execution_started_at).toBeNull();
  expect(existsSync(join(f.campaignDir, 'report-delivery.json'))).toBe(false);
  expect(existsSync(join(f.campaignDir, 'report-seal.json'))).toBe(false);
  expect(
    existsSync(
      join(
        f.campaignDir,
        'report-snapshots',
        `${delivered.report.anchor.last_sequence}-${delivered.delivery.report_digest}`,
        'report-delivery.json',
      ),
    ),
  ).toBe(true);
  expect(
    delivered.delivery.measurement_readiness.every((o) => !o.complete),
  ).toBe(true);
});

test('human rendering names actual delivery endpoint and keeps missing request clock unavailable', () => {
  const f = completed();
  const { report, delivery } = deliverComparisonReport({
    ...f,
    processes,
    now: () => Date.parse(fixtureTime(11)),
  });
  const text = renderCampaignReport({ ...report, delivery });
  expect(text).toContain('Acceptance → publication: 10000 ms');
  expect(text).toContain('Acceptance → first attempt preparation: 2000 ms');
  expect(text).toContain('Request → acceptance: unavailable');
  expect(text).toContain('Request → publication: unavailable');
  expect(text).toContain('incomplete');
});

for (const required of [false, true])
  test(`readiness honors required qualification=${required} and keeps missing criteria incomplete`, () => {
    const experiment = twoArmExperiment();
    experiment.measurement_requirements = {
      scenario: {
        mode: 'qa',
        story_sha256: 'a'.repeat(64),
        rubric_sha256: 'b'.repeat(64),
        check_manifest_sha256: 'c'.repeat(64),
        checks: [],
        criteria: [
          {
            id: 'review',
            ordinal: 1,
            text: 'Grounded review',
            required_artifact_classes: [],
            check_refs: [],
            requires_assessment_qualification: required,
          },
          {
            id: 'missing',
            ordinal: 2,
            text: 'Missing criterion',
            required_artifact_classes: [],
            check_refs: [],
          },
        ],
      },
    };
    const f = completedPublicationFixture('primary', experiment, [
      {
        criterion: 'Grounded review',
        verdict: 'fail',
        evidence: 'Observed failure',
      },
    ]);
    roots.push(f.root);
    finishPublicationFixture(f);
    const { delivery } = deliverComparisonReport({
      ...f,
      processes,
      now: () => Date.parse(fixtureTime(11)),
    });
    const criteria = delivery.measurement_readiness.filter(
      (o) => o.kind === 'criterion',
    );
    expect(criteria).toHaveLength(4);
    expect(
      criteria
        .filter((o) => o.id.endsWith(':1'))
        .every((o) => o.complete === !required),
    ).toBe(true);
    expect(
      criteria
        .filter((o) => o.id.endsWith(':1'))
        .every(
          (o) =>
            o.qualification === (required ? 'unverified' : 'not_calibrated'),
        ),
    ).toBe(true);
    expect(
      criteria
        .filter((o) => o.id.endsWith(':2'))
        .every((o) => !o.complete && o.artifacts_published_at === null),
    ).toBe(true);
  });

for (const requested of [-1, 2])
  test(`request timestamp outside registered-to-accepted interval (${requested}) is rejected`, () => {
    const f = lifecycleFixture();
    roots.push(f.root);
    const w = f.elect();
    const started = sessionTransitions(f.experiment)[1]!;
    if (started.type !== 'started')
      throw Error('fixture expected started transition');
    started.payload.requested_at = fixtureTime(requested);
    try {
      expect(() => w.commitTransition(started)).toThrow();
    } finally {
      w.release();
    }
  });

test('existing receipt observed after report flush still requires its own durable confirmation', () => {
  const f = completed();
  const first = deliverComparisonReport({
    ...f,
    processes,
    now: () => Date.parse(fixtureTime(11)),
  });
  const receiptPath = join(f.campaignDir, 'report-delivery.json');
  const bytes = readFileSync(receiptPath);
  const stage = join(f.campaignDir, 'concurrent-receipt.stage');
  writeFileSync(stage, bytes);
  const stageFd = openSync(stage, 'r');
  try {
    fsyncSync(stageFd);
  } finally {
    closeSync(stageFd);
  }
  rmSync(receiptPath);
  const directory = statSync(f.campaignDir);
  let linked = false;
  const realRead = credentialScope.readPinnedNoFollowFile;
  const realSync = journalFsOps.fsync;
  const read = spyOn(
    credentialScope,
    'readPinnedNoFollowFile',
  ).mockImplementation((anchor, parts, label, required) => {
    if (
      !linked &&
      anchor === f.campaignDir &&
      parts.length === 1 &&
      parts[0] === 'report-delivery.json'
    ) {
      // The competing publisher has synced the file, but not its new directory entry.
      linkSync(stage, receiptPath);
      linked = true;
    }
    return realRead(anchor, parts, label, required);
  });
  const sync = spyOn(journalFsOps, 'fsync').mockImplementation((fd) => {
    const stat = fstatSync(fd);
    if (linked && stat.dev === directory.dev && stat.ino === directory.ino)
      throw new Error('receipt directory sync failed');
    return realSync(fd);
  });
  try {
    expect(() =>
      deliverComparisonReport({
        ...f,
        processes,
        now: () => {
          throw new Error('must retain first clock');
        },
      }),
    ).toThrow('receipt directory sync failed');
    expect(readFileSync(receiptPath)).toEqual(bytes);
  } finally {
    read.mockRestore();
    sync.mockRestore();
  }
  expect(
    deliverComparisonReport({
      ...f,
      processes,
      now: () => Date.parse(fixtureTime(21)),
    }).delivery,
  ).toEqual(first.delivery);
});

test('status withholds a visible receipt while its directory cannot be synced without changing artifacts', () => {
  const f = completed();
  const first = deliverComparisonReport({
    ...f,
    processes,
    now: () => Date.parse(fixtureTime(11)),
  });
  const receiptPath = join(f.campaignDir, 'report-delivery.json');
  const bytes = readFileSync(receiptPath);
  const names = readdirSync(f.campaignDir).sort();
  const directory = statSync(f.campaignDir);
  const realSync = journalFsOps.fsync;
  const sync = spyOn(journalFsOps, 'fsync').mockImplementation((fd) => {
    const stat = fstatSync(fd);
    if (stat.dev === directory.dev && stat.ino === directory.ino)
      throw new Error('receipt directory sync failed');
    return realSync(fd);
  });
  try {
    expect(readReportDelivery(first.report)).toBeNull();
    expect(readFileSync(receiptPath)).toEqual(bytes);
    expect(readdirSync(f.campaignDir).sort()).toEqual(names);
  } finally {
    sync.mockRestore();
  }
  expect(readReportDelivery(first.report)).toEqual(first.delivery);
});
