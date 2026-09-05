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
import {
  publishExecution,
  readPublishedArtifactBytes,
} from '../src/campaign/attempt-publish.ts';
import { observeCampaignStatus } from '../src/campaign/cancellation.ts';
import { readCommittedTransitions } from '../src/campaign/execution-journal.ts';
import { foldComparisonReport } from '../src/campaign/report.ts';
import * as publication from '../src/campaign/report-publication.ts';
import * as sealing from '../src/campaign/seal.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import { writeAttemptManifest } from '../src/runner/manifest.ts';
import {
  blockActivation,
  fixtureTime,
  observation,
  sessionTransitions,
  startTransition,
  transition,
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

function completedPublicationFixture() {
  const f = lifecycleFixture();
  roots.push(f.root);
  const resultsRoot = join(f.root, 'custom-results');
  mkdirSync(resultsRoot);
  const block = blockActivation(f.experiment);
  for (const intent of block.attempts) {
    const original = intent.output_root;
    const root = join(f.root, 'attempts', intent.identity.execution_attempt_id);
    Object.assign(
      intent,
      JSON.parse(JSON.stringify(intent).replaceAll(original, root)),
    );
    intent.runtime_spec_digest = sha256Hex(
      jcsCanonicalize(intent.runtime_spec),
    );
  }
  const w = f.elect();
  for (const t of sessionTransitions(f.experiment).slice(1))
    w.commitTransition(t);
  w.commitTransition(transition('block_activated', block, 3));
  const observations = block.attempts.map((intent, i) => {
    const runDir = join(intent.output_root, 'staging', `run-${i}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'verdict.json'),
      JSON.stringify({
        schema: 1,
        campaign: intent.identity,
        final: i === 0 ? 'pass' : 'fail',
        gauntlet: {
          status: i === 0 ? 'pass' : 'fail',
          summary: 'frozen',
          reasoning: 'observed',
          run_id: 'grader',
          process_exit: { code: 0, signal: null },
        },
        checks: [
          {
            check: 'fixture',
            args: [],
            negated: false,
            passed: i === 0,
            detail: null,
            phase: 'post',
          },
        ],
        started_at: fixtureTime(0),
        finished_at: fixtureTime(10 + i),
        economics: {
          coding_agent: {
            est_cost_usd: i + 1,
            has_unpriced_model: false,
            tokens: { total: 10 + i },
          },
          gauntlet: {
            est_cost_usd: 0.1,
            has_unpriced_model: false,
            tokens: { total: 2 },
          },
        },
      }),
    );
    writeFileSync(join(runDir, 'Z-binary'), Buffer.from([255, 128, 0]));
    writeAttemptManifest(runDir, intent.identity);
    const container_id = (i === 0 ? 'a' : 'b').repeat(64);
    const stopped = {
      execution_attempt_id: intent.identity.execution_attempt_id,
      container_id,
      proof: 'inspected_stopped' as const,
      observed_at: fixtureTime(4 + i),
    };
    const result = publishExecution({
      bound: { intent, container_id },
      stopped,
      resultsRoot,
    });
    const obs = observation(block, i, 4 + i, {
      outcome: i === 0 ? 'pass' : 'fail',
      artifacts: result.artifacts,
      stopped,
    });
    w.commitTransition(
      transition(
        'attempt_observed',
        { observation: obs, excluded_block: null },
        4 + i,
      ),
    );
    return obs;
  });
  const receipt = {
    campaign_id: f.experiment.campaign_id,
    input_digest: f.experiment.input_digest,
    start_id: 'start',
    block_id: 'primary',
    at: fixtureTime(6),
    verdict: 'valid',
    details: {
      exposures: [1, 2],
      contention: 'clean',
      intervals: [{ block_id: 'primary', startTsMs: 0, endTsMs: 5000 }],
      telemetry: {
        lines: [
          {
            ts_ms: 5000,
            load1: 0,
            mem_available_bytes: 4096,
            swap_used_bytes: 0,
            process_count: 3,
            disk_free_bytes: 8192,
            breach: [],
          },
        ],
        truncatedTail: false,
      },
    },
  };
  const body = `${jcsCanonicalize(receipt)}\n`;
  writeFileSync(join(f.campaignDir, 'validity.json'), body);
  w.commitTransition(
    transition(
      'block_validated',
      {
        block_id: 'primary',
        evidence_refs: [
          {
            path: 'validity.json',
            sha256: sha256Hex(body),
            bytes: Buffer.byteLength(body),
          },
        ],
      },
      6,
    ),
  );
  w.release();
  writeFileSync(
    `${f.loaded.config.live_spend_lock}.claim.json`,
    jcsCanonicalize({
      ...startTransition(f.experiment).payload,
      campaign_dir: f.campaignDir,
    }),
  );
  return { ...f, resultsRoot, observations };
}
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
        const w = f.elect();
        w.commitTransition(
          transition(
            'ended',
            { outcome: 'completed', reason: 'done', cancel_intent: null },
            7,
          ),
        );
        const body = `${jcsCanonicalize({ start: startTransition(f.experiment).payload, controller: { pid: 102, birth: 'controller', boot_id: 'boot' }, launcher_role_released: true, authorized_terminator: { pid: 102, birth: 'controller', boot_id: 'boot' }, observed_at: fixtureTime(8) })}\n`;
        writeFileSync(join(f.campaignDir, 'termination.json'), body);
        w.commitTransition(
          transition(
            'termination_verified',
            {
              start_id: 'start',
              stopped: f.observations.map((o) => o.stopped),
              process_evidence: [
                {
                  path: 'termination.json',
                  bytes: Buffer.byteLength(body),
                  sha256: sha256Hex(body),
                },
              ],
            },
            8,
          ),
        );
        w.release();
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
