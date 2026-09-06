import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ExecutionJournalWriter,
  initExecutionJournal,
} from '../src/campaign/execution-journal.ts';
import { realProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { CampaignIdentity } from '../src/contracts/campaign/campaign.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import type { ObserverBinding } from '../src/experiments/observer/binding.ts';
import type { ObserverBundle } from '../src/experiments/observer/bundle.ts';
import {
  captureArtifactDirectories,
  captureFinalState,
} from '../src/experiments/observer/final-state.ts';
import {
  type IndependentReview,
  writeIndependentReview,
  writeReviewSet,
} from '../src/experiments/observer/independent-review.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';
import { readObserverCampaign } from '../src/experiments/observer/readout.ts';
import type { ActorReview } from '../src/experiments/observer/review.ts';
import { scoreObserverEvidence } from '../src/experiments/observer/score.ts';
import {
  parseAttemptManifest,
  writeAttemptManifest,
} from '../src/runner/manifest.ts';
import { RealClock } from '../src/scheduler/clock.ts';
import {
  blockActivation,
  fixtureTime,
  observation,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const at = (line: number) => ({ source_id: 'parent', line, block: null });
function publishFixture(
  resultsRoot: string,
  runId: string,
  identity: CampaignIdentity,
  inputDigest: string,
) {
  const runDir = join(resultsRoot, runId);
  const original = join(resultsRoot, `${runId}-original`);
  const home = join(original, 'home');
  const workdir = join(original, 'workdir');
  const sessions = join(home, '.codex/sessions');
  const bundleDir = join(runDir, 'brainstorming-evidence/bundle');
  for (const path of [sessions, workdir, bundleDir])
    mkdirSync(path, { recursive: true });
  const source = {
    source_id: 'parent',
    runtime: 'codex' as const,
    expected_session_id: 'session',
    expected_cwd: workdir,
    expected_cli_version: '0.144.3',
  };
  const rows = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        cwd: workdir,
        cli_version: '0.144.3',
        source: 'cli',
        originator: 'codex-tui',
        thread_source: 'user',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Build a todo app' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'edit',
        arguments: '{"cmd":"write"}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'edit',
        output: 'Process exited with code 0',
      },
    },
  ];
  const raw = Buffer.from(
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  writeFileSync(join(sessions, 'parent.jsonl'), raw);
  const info = statSync(join(sessions, 'parent.jsonl'), { bigint: true });
  const binding: ObserverBinding = {
    schema_version: 2,
    run_id: runId,
    campaign: identity,
    runtime: 'codex',
    dialect: 'codex-response-items-0.144.3',
    cli_version: '0.144.3',
    home,
    workdir,
    launch_cwd: workdir,
    phase: 'finalized',
    parent_source_id: 'parent',
    roots: [
      { id: 'sessions', kind: 'transcripts', path: sessions },
      { id: 'documents', kind: 'artifacts', path: workdir },
    ],
    sources: [
      {
        source,
        root_id: 'sessions',
        relative_path: 'parent.jsonl',
        device: info.dev.toString(),
        inode: info.ino.toString(),
        parent_link: null,
      },
    ],
  };
  const actorReview: ActorReview = {
    schema_version: 2,
    reviewer: 'actor',
    stop_reason: 'endpoint',
    supporting_prefixes: [],
    source_prefixes: [createRawPrefix(source, raw)],
    events: [],
    actions: [
      {
        anchor: at(3),
        call_id: 'native:edit',
        effects: ['implementation'],
        result_anchors: [at(4)],
        success: true,
        changed_artifacts: [],
        delegation: null,
        note: 'Unapproved implementation',
      },
    ],
  };
  const score = scoreObserverEvidence({
    binding,
    supporting_files: [],
    raw_sources: [{ source_id: 'parent', bytes: raw }],
    receipts: [],
    review: actorReview,
  });
  const members = {
    'parent.jsonl': raw,
    'actor-review.json': Buffer.from(JSON.stringify(actorReview)),
    'strict-score.json': Buffer.from(JSON.stringify(score)),
  };
  const bundle: ObserverBundle = {
    schema_version: 2,
    binding,
    final_state: captureFinalState(binding.roots),
    artifact_directories: captureArtifactDirectories(binding.roots),
    files: Object.entries(members).map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: digest(bytes),
    })),
    sources: [{ source_id: 'parent', path: 'parent.jsonl' }],
    supporting_files: [],
    terminal_artifacts: [],
    receipts: [],
    actor_review: 'actor-review.json',
    score: 'strict-score.json',
    evidence_errors: [],
  };
  for (const [path, bytes] of Object.entries(members))
    writeFileSync(join(bundleDir, path), bytes);
  const envelopeBytes = Buffer.from(JSON.stringify(bundle));
  writeFileSync(join(bundleDir, 'observer-bundle.json'), envelopeBytes);
  writeFileSync(
    join(runDir, 'verdict.json'),
    JSON.stringify({
      campaign: identity,
      final: 'indeterminate',
      gauntlet: {
        status: 'errored',
        summary: 'grader failed',
        reasoning: '',
        run_id: null,
      },
    }),
  );
  writeFileSync(join(runDir, 'worker.log'), 'finished\n');
  writeAttemptManifest(runDir, identity);
  const manifestBytes = readFileSync(join(runDir, 'manifest.json'));
  const manifest = parseAttemptManifest(manifestBytes.toString());
  const refs = [
    ...manifest.files.map((file) => ({
      path: `${runId}/${file.path}`,
      bytes: file.size,
      sha256: file.sha256,
    })),
    {
      path: `${runId}/manifest.json`,
      bytes: manifestBytes.length,
      sha256: digest(manifestBytes),
    },
  ];
  rmSync(original, { recursive: true });
  const review: IndependentReview = {
    schema_version: 2,
    identity,
    input_digest: inputDigest,
    manifest_digest: digest(manifestBytes),
    bundle_digest: digest(envelopeBytes),
    reviewer: 'independent',
    reviewed_at: fixtureTime(15),
    supporting_prefixes: [],
    source_prefixes: actorReview.source_prefixes,
    calls: actorReview.actions.map((action) => ({
      anchor: action.anchor,
      call_id: action.call_id,
      result_anchors: action.result_anchors,
    })),
    judgments: [
      {
        anchor: at(3),
        event: 'call',
        assessment: 'agree',
        classification: null,
        before_receipt: null,
        after_receipt: null,
        note: 'Known unapproved implementation',
      },
    ],
    strict_status: 'fail',
    disagreements: [],
  };
  return { refs, runDir, bundleDir, review, bundle };
}
function rewritePublication(
  publication: ReturnType<typeof publishFixture>,
  damage: 'score' | 'identity' | 'dialect' | 'instrument',
) {
  const bundle = publication.bundle;
  if (damage === 'identity')
    bundle.binding.campaign = {
      ...publication.review.identity,
      execution_attempt_id: 'wrong-attempt',
    };
  if (damage === 'dialect') bundle.binding.dialect = 'unsupported-native-build';
  if (damage === 'instrument') {
    bundle.evidence_errors = [
      { code: 'missing_review', message: 'Review unavailable' },
    ];
    bundle.score = null;
    bundle.actor_review = null;
    bundle.files = bundle.files.filter(
      (file) => !['strict-score.json', 'actor-review.json'].includes(file.path),
    );
    rmSync(join(publication.bundleDir, 'strict-score.json'));
    rmSync(join(publication.bundleDir, 'actor-review.json'));
  }
  if (damage === 'score' || damage === 'dialect') {
    const score = scoreObserverEvidence({
      binding: bundle.binding,
      supporting_files: [],
      raw_sources: [
        {
          source_id: 'parent',
          bytes: readFileSync(join(publication.bundleDir, 'parent.jsonl')),
        },
      ],
      receipts: [],
      review: JSON.parse(
        readFileSync(join(publication.bundleDir, 'actor-review.json'), 'utf8'),
      ),
    });
    if (damage === 'score') score.status = 'pass';
    const bytes = Buffer.from(JSON.stringify(score));
    writeFileSync(join(publication.bundleDir, 'strict-score.json'), bytes);
    bundle.files = bundle.files.map((file) =>
      file.path === 'strict-score.json'
        ? { ...file, bytes: bytes.length, sha256: digest(bytes) }
        : file,
    );
  }
  const bytes = Buffer.from(JSON.stringify(bundle));
  writeFileSync(join(publication.bundleDir, 'observer-bundle.json'), bytes);
  writeAttemptManifest(publication.runDir, publication.review.identity);
  const manifestBytes = readFileSync(join(publication.runDir, 'manifest.json'));
  const manifest = parseAttemptManifest(manifestBytes.toString());
  publication.refs = [
    ...manifest.files.map((file) => ({
      path: `${manifest.run_id}/${file.path}`,
      bytes: file.size,
      sha256: file.sha256,
    })),
    {
      path: `${manifest.run_id}/manifest.json`,
      bytes: manifestBytes.length,
      sha256: digest(manifestBytes),
    },
  ];
}

function fixture(
  options: {
    unstarted?: boolean;
    active?: boolean;
    invalid?: boolean;
    n?: number;
    replacement?: boolean;
    damage?: 'score' | 'identity' | 'dialect' | 'instrument';
  } = {},
) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'observer-readout-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const campaignDir = join(dir, 'campaign');
  const resultsRoot = join(dir, 'results');
  mkdirSync(resultsRoot);
  const experiment = twoArmExperiment();
  const n = options.n ?? 1;
  experiment.cells[0]!.n = n;
  experiment.cells[0]!.scenario = 'brainstorming-todo-shared-intent';
  experiment.suite.comparisons[0]!.n = n;
  experiment.suite.comparisons[0]!.scenarios = [
    'brainstorming-todo-shared-intent',
  ];
  experiment.reserve_slots[0]!.scenario = 'brainstorming-todo-shared-intent';
  experiment.planned_slots = Array.from({ length: n }, (_, i) =>
    twoArmExperiment().planned_slots.map((slot) => ({
      ...slot,
      sample_id: `${slot.sample_id}-${i + 1}`,
      primary_block_id: i === 0 ? 'primary' : `primary-${i + 1}`,
      replicate: i + 1,
      scenario: 'brainstorming-todo-shared-intent',
    })),
  ).flat();
  experiment.input_digest = experimentDigest(experiment);
  initExecutionJournal({ campaignDir, experiment });
  writeFileSync(join(campaignDir, 'campaign.json'), JSON.stringify(experiment));
  const writer = ExecutionJournalWriter.elect({
    campaignDir,
    experiment,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
  cleanup.push(() => writer.release());
  for (const item of sessionTransitions(experiment))
    writer.commitTransition(item);
  const publications: ReturnType<typeof publishFixture>[] = [];
  if (!options.unstarted) {
    const activated = {
      ...experiment,
      planned_slots: experiment.planned_slots.filter(
        (slot) => slot.replicate === 1,
      ),
    };
    const block = blockActivation(activated);
    writer.commitTransition(transition('block_activated', block, 3));
    for (const [i, attempt] of block.attempts.entries()) {
      const publication = publishFixture(
        resultsRoot,
        `run-${i}`,
        attempt.identity,
        experiment.input_digest,
      );
      if (options.damage && i === 0)
        rewritePublication(publication, options.damage);
      publications.push(publication);
      writer.commitTransition(
        transition(
          'attempt_observed',
          {
            observation: observation(block, i, 4 + i, {
              outcome: 'indeterminate',
              artifacts: publication.refs,
              failure_class: 'instrument',
              cause: 'grader_rate_limited',
            }),
            excluded_block: null,
          },
          4 + i,
        ),
      );
    }
    const auditBody = Buffer.from(
      JSON.stringify({
        campaign_id: experiment.campaign_id,
        input_digest: experiment.input_digest,
        start_id: 'start',
        block_id: 'primary',
        at: fixtureTime(6),
        verdict: 'valid',
        details: {
          exposures: [1, 1],
          contention: 'clean',
          intervals: [],
          telemetry: { lines: [], truncatedTail: false },
        },
      }),
    );
    writeFileSync(join(campaignDir, 'validity.json'), auditBody);
    writer.commitTransition(
      transition(
        'block_validated',
        {
          block_id: 'primary',
          evidence_refs: [
            {
              path: 'validity.json',
              bytes: auditBody.length,
              sha256: digest(auditBody),
            },
          ],
        },
        6,
      ),
    );
    if (options.invalid)
      writer.commitTransition(
        transition(
          'block_invalidated',
          {
            block_id: 'primary',
            reason: 'contention',
            evidence_refs: [
              {
                path: 'validity.json',
                bytes: auditBody.length,
                sha256: digest(auditBody),
              },
            ],
          },
          7,
        ),
      );
  }
  if (options.replacement) {
    const successor = blockActivation(experiment, true);
    writer.commitTransition(
      transition(
        'block_replaced',
        { activation: successor, reason: 'grader_rate_limited' },
        8,
      ),
    );
    for (const [i, attempt] of successor.attempts.entries()) {
      const publication = publishFixture(
        resultsRoot,
        `successor-${i}`,
        attempt.identity,
        experiment.input_digest,
      );
      publications.push(publication);
      writer.commitTransition(
        transition(
          'attempt_observed',
          {
            observation: observation(successor, i, 9 + i, {
              outcome: 'indeterminate',
              artifacts: publication.refs,
            }),
            excluded_block: null,
          },
          9 + i,
        ),
      );
    }
    const body = Buffer.from(
      JSON.stringify({
        campaign_id: experiment.campaign_id,
        input_digest: experiment.input_digest,
        start_id: 'start',
        block_id: 'successor',
        at: fixtureTime(11),
        verdict: 'valid',
        details: {
          exposures: [1, 1],
          contention: 'clean',
          intervals: [],
          telemetry: { lines: [], truncatedTail: false },
        },
      }),
    );
    writeFileSync(join(campaignDir, 'successor-validity.json'), body);
    writer.commitTransition(
      transition(
        'block_validated',
        {
          block_id: 'successor',
          evidence_refs: [
            {
              path: 'successor-validity.json',
              bytes: body.length,
              sha256: digest(body),
            },
          ],
        },
        11,
      ),
    );
  }

  if (!options.active)
    writer.commitTransition(
      transition(
        'ended',
        {
          outcome: 'interrupted',
          reason: 'fixture endpoint',
          cancel_intent: null,
        },
        15,
      ),
    );
  const reviews = () => {
    const reviewDir = join(dir, 'reviews');
    mkdirSync(reviewDir);
    const refs = publications.map((publication, i) =>
      writeIndependentReview(
        join(reviewDir, `review-${i}.json`),
        publication.review,
      ),
    );
    const reviewSetPath = join(reviewDir, 'set.json');
    writeReviewSet(reviewSetPath, { schema_version: 2, reviews: refs });
    return reviewSetPath;
  };
  return { dir, campaignDir, resultsRoot, publications, reviews, writer };
}

test('unstarted measured slots retain all four planned samples and two planned pairs', () => {
  const f = fixture({ unstarted: true, n: 2 });
  const r = readObserverCampaign(f);
  expect(r.slots).toHaveLength(4);
  expect(r.attempts).toEqual([]);
  expect(r.comparisons[0]?.planned_strict_pairs).toBe(2);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
  expect(r.slots.every((slot) => slot.exclusions.length > 0)).toBe(true);
  expect(r.interpretation_ready).toBe(false);
});
test('strict pair survives grader and composed failure with explicit disagreements', () => {
  const f = fixture();
  const r = readObserverCampaign(f);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(1);
  expect(r.comparisons[0]?.pairs[0]?.baseline.status).toBe('fail');
  expect(r.general.report.comparisons[0]?.paired.pass_rate.n).toBe(0);
  expect(r.attempts.every((attempt) => attempt.disagreements.length > 0)).toBe(
    true,
  );
  expect(r.attempts[0]?.strict_score?.first_violation?.anchor.line).toBe(3);
});
test('missing independent reviews preserve strict scores but withhold interpretation', () => {
  const f = fixture();
  const r = readObserverCampaign(f);
  expect(r.attempts[0]?.strict_score?.status).toBe('fail');
  expect(r.attempts[0]?.review?.classifications).toEqual([]);
  expect(r.interpretation_ready).toBe(false);
});
test('authenticated complete independent reviews make completed coverage interpretable', () => {
  const f = fixture();
  const r = readObserverCampaign({ ...f, reviewSetPath: f.reviews() });
  expect(r.attempts).toHaveLength(2);
  expect(r.interpretation_ready).toBe(true);
  expect(r.attempts.every((attempt) => attempt.review?.ready)).toBe(true);
});
test('active campaigns expose no strict, grader or independent review behavior', () => {
  const f = fixture({ active: true });
  const r = readObserverCampaign({ ...f, reviewSetPath: f.reviews() });
  expect(r.behavior_available).toBe(false);
  expect(r.comparisons).toEqual([]);
  expect(
    r.attempts.every(
      (attempt) =>
        attempt.strict_score === null &&
        attempt.review === null &&
        attempt.grader_status === null &&
        attempt.disagreements.length === 0,
    ),
  ).toBe(true);
  expect(r.general.report.behavior_available).toBe(false);
});
test('excluded blocks cannot enter strict pairs even with authentic positive receipt', () => {
  const f = fixture({ invalid: true });
  const r = readObserverCampaign(f);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
  expect(r.attempts.every((attempt) => !attempt.strict_eligible)).toBe(true);
  expect(r.attempts[0]?.strict_score?.status).toBe('fail');
});
test.each([
  'parent.jsonl',
  'observer-bundle.json',
  'strict-score.json',
])('altered observer member %s excludes the strict pair', (member) => {
  const f = fixture();
  writeFileSync(join(f.publications[0]!.bundleDir, member), '{}\n');
  const r = readObserverCampaign(f);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
  expect(r.attempts[0]?.strict_score).toBeNull();
  expect(r.attempts[0]?.instrument_failures.length).toBeGreaterThan(0);
});
test('publication_valid alone cannot hide a missing non-observer manifest member', () => {
  const f = fixture();
  rmSync(join(f.publications[0]!.runDir, 'worker.log'));
  const r = readObserverCampaign(f);
  expect(r.general.report.attempts[0]?.evidence.publication_valid).toBe(true);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
});
test('missing bundle cannot be replaced by an unreferenced directory', () => {
  const f = fixture();
  rmSync(f.publications[0]!.bundleDir, { recursive: true });
  const r = readObserverCampaign(f);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
  expect(r.slots).toHaveLength(2);
});
test('altered review makes interpretation unavailable without erasing sealed strict score', () => {
  const f = fixture();
  const path = f.reviews();
  writeFileSync(join(f.dir, 'reviews/review-0.json'), '{}');
  const r = readObserverCampaign({ ...f, reviewSetPath: path });
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(1);
  expect(r.interpretation_ready).toBe(false);
  expect(r.review_errors.length).toBeGreaterThan(0);
});
test('review sidecars inside a sealed run are refused', () => {
  const f = fixture();
  const ref = writeIndependentReview(
    join(f.publications[0]!.runDir, 'review.json'),
    f.publications[0]!.review,
  );
  const path = join(f.publications[0]!.runDir, 'review-set.json');
  writeReviewSet(path, { schema_version: 2, reviews: [ref] });
  const r = readObserverCampaign({ ...f, reviewSetPath: path });
  expect(r.interpretation_ready).toBe(false);
  expect(r.review_errors.length).toBeGreaterThan(0);
});
test('explicit absolute storage roots are required', () => {
  const f = fixture();
  expect(() =>
    readObserverCampaign({ ...f, resultsRoot: 'results' }),
  ).toThrow();
  expect(() =>
    readObserverCampaign({ ...f, campaignDir: 'campaign' }),
  ).toThrow();
});

test('review-set bytes and sidecar refs are part of the readout input anchor', () => {
  const f = fixture();
  const path = f.reviews();
  const r = readObserverCampaign({ ...f, reviewSetPath: path });
  expect(r.review_set?.path).toBe(path);
  expect(r.review_set?.sha256).toBe(digest(readFileSync(path)));
  expect(r.review_set?.sidecars).toHaveLength(2);
});
test('multiple attempts retain old strict results and all-attempt accounting without mixing blocks', () => {
  const f = fixture({ replacement: true });
  const r = readObserverCampaign(f);
  expect(r.attempts).toHaveLength(4);
  expect(r.general.report.accounting.subject_cost_usd.attempts).toBe(4);
  expect(
    r.attempts
      .slice(0, 2)
      .every(
        (attempt) =>
          !attempt.selected &&
          !attempt.strict_eligible &&
          attempt.strict_score?.status === 'fail',
      ),
  ).toBe(true);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(1);
  expect(r.comparisons[0]?.pairs[0]?.block_id).toBe('successor');
  rmSync(join(f.publications[3]!.bundleDir, 'strict-score.json'));
  expect(readObserverCampaign(f).comparisons[0]?.realized_strict_pairs).toBe(0);
});
test.each([
  'score',
  'identity',
] as const)('authenticated publication with wrong %s still cannot enter strict cohort', (damage) => {
  const f = fixture({ damage });
  const r = readObserverCampaign(f);
  expect(r.general.report.attempts[0]?.evidence.publication_valid).toBe(true);
  expect(r.attempts[0]?.strict_score).toBeNull();
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
});
test('unsupported native dialect remains indeterminate without readout adding authority', () => {
  const f = fixture({ damage: 'dialect' });
  const r = readObserverCampaign(f);
  expect(r.attempts[0]?.strict_score?.status).toBe('indeterminate');
  expect(r.attempts[0]?.instrument_failures.length).toBeGreaterThan(0);
  expect(r.comparisons[0]?.realized_strict_pairs).toBe(0);
});
test('authentic bundle instrument failure stays missing and cannot gain a strict score', () => {
  const f = fixture({ damage: 'instrument' });
  const r = readObserverCampaign(f);
  expect(r.attempts[0]?.strict_score).toBeNull();
  expect(r.attempts[0]?.instrument_failures).toContain(
    'missing_review: Review unavailable',
  );
  expect(r.interpretation_ready).toBe(false);
});
test('grader failure is separately visible from strict and composed statuses', () => {
  const f = fixture();
  const r = readObserverCampaign(f);
  expect(r.attempts[0]?.grader_status).toBe('errored');
  expect(r.attempts[0]?.composed_outcome).toBe('indeterminate');
  expect(r.attempts[0]?.strict_score?.status).toBe('fail');
});

test('wrong-attempt and incomplete independent submissions cannot change strict cohort', () => {
  for (const damage of ['wrong-attempt', 'incomplete'] as const) {
    const f = fixture();
    if (damage === 'wrong-attempt')
      f.publications[0]!.review.identity = {
        ...f.publications[0]!.review.identity,
        execution_attempt_id: 'other-attempt',
      };
    else f.publications[0]!.review.calls = [];
    const r = readObserverCampaign({ ...f, reviewSetPath: f.reviews() });
    expect(r.comparisons[0]?.realized_strict_pairs).toBe(1);
    expect(r.interpretation_ready).toBe(false);
    expect(r.attempts[0]?.review?.classifications).toEqual([]);
  }
});
test('reviewer disagreement is visible but cannot change the strict score', () => {
  const f = fixture();
  f.publications[0]!.review.strict_status = 'pass';
  const r = readObserverCampaign({ ...f, reviewSetPath: f.reviews() });
  expect(r.attempts[0]?.strict_score?.status).toBe('fail');
  expect(
    r.attempts[0]?.disagreements.some((reason) =>
      reason.includes('Reviewer independent: pass'),
    ),
  ).toBe(true);
});
test('unauthenticated review claims remain in rejected submissions without being reported as established disagreements', () => {
  const f = fixture();
  f.publications[0]!.review.strict_status = 'pass';
  f.publications[0]!.review.bundle_digest = 'f'.repeat(64);
  const r = readObserverCampaign({ ...f, reviewSetPath: f.reviews() });
  expect(r.attempts[0]?.review?.reviews[0]?.valid).toBe(false);
  expect(
    r.attempts[0]?.disagreements.some((reason) => reason.includes('Reviewer')),
  ).toBe(false);
});

function readoutCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      resolve(import.meta.dir, '../src/cli/brainstorming-evidence.ts'),
      'readout',
      ...args,
    ],
    { encoding: 'utf8' },
  );
}
test.each([
  true,
  false,
])('readout CLI accepts explicit roots and review set for active=%s', (active) => {
  const f = fixture({ active });
  const result = readoutCli([
    '--results-root',
    f.resultsRoot,
    '--review-set',
    f.reviews(),
    '--campaign-dir',
    f.campaignDir,
  ]);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.behavior_available).toBe(!active);
  if (active) expect(output.comparisons).toEqual([]);
  else {
    expect(output.comparisons.length).toBe(1);
    expect(
      output.attempts.every(
        (attempt: { review: { ready: boolean } }) => attempt.review.ready,
      ),
    ).toBe(true);
  }
});
test('readout CLI rejects missing duplicate unknown and positional arguments before reading evidence', () => {
  const f = fixture({ active: true });
  const required = [
    '--campaign-dir',
    f.campaignDir,
    '--results-root',
    f.resultsRoot,
  ];
  const invalid = [
    [],
    ['--campaign-dir'],
    ['--campaign-dir', f.campaignDir],
    ['--results-root', f.resultsRoot],
    ['--campaign-dir', f.campaignDir, '--results-root'],
    [...required, '--review-set'],
    [...required, '--campaign-dir', f.campaignDir],
    [...required, '--results-root', f.resultsRoot],
    [...required, '--review-set', 'absent', '--review-set', 'also-absent'],
    [...required, '--unknown', f.campaignDir],
    [f.campaignDir, f.resultsRoot],
    [...required, 'unexpected'],
  ];
  for (const args of invalid) {
    const result = readoutCli(args);
    expect(result.status).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('readout arguments:');
  }
});
