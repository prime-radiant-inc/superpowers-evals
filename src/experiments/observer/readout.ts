import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readPublishedArtifactBytes } from '../../campaign/attempt-publish.ts';
import { readCommittedPrefix } from '../../campaign/execution-journal.ts';
import type { AttemptProjection } from '../../campaign/execution-state.ts';
import { readBlockValidity } from '../../campaign/report-evidence.ts';
import { readComparisonFromPrefix } from '../../campaign/report-publication.ts';
import type { CampaignIdentity } from '../../contracts/campaign/campaign.ts';
import { jcsCanonicalize } from '../../contracts/campaign/digest.ts';
import {
  type ArtifactRef,
  ArtifactRefSchema,
} from '../../contracts/campaign/execution.ts';
import type { PlannedSlot } from '../../contracts/campaign/experiment.ts';
import type { Report } from '../../contracts/campaign/report.ts';
import type { GauntletStatus } from '../../contracts/verdict.ts';
import { parseAttemptManifest } from '../../runner/manifest.ts';
import {
  OBSERVER_BUNDLE_FILENAME,
  OBSERVER_BUNDLE_RELATIVE_DIR,
  readObserverBundle,
} from './bundle.ts';
import {
  assessIndependentReviews,
  type IndependentReviewAssessment,
  type IndependentReviewEvidence,
  readReviewSetEvidence,
} from './independent-review.ts';
import { validateActorReview, validateArtifactReceipt } from './review.ts';
import { type StrictScore, scoreObserverEvidence } from './score.ts';

const same = (a: unknown, b: unknown) =>
  jcsCanonicalize(a) === jcsCanonicalize(b);
const parseJson = (bytes: Buffer): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export interface ObserverAttemptReadout {
  identity: CampaignIdentity;
  arm: string;
  selected: boolean;
  strict_eligible: boolean;
  strict_score: StrictScore | null;
  composed_outcome: 'pass' | 'fail' | 'indeterminate' | null;
  grader_status: GauntletStatus | null;
  manifest_digest: string | null;
  bundle_digest: string | null;
  exclusions: string[];
  instrument_failures: string[];
  disagreements: string[];
  review: IndependentReviewAssessment | null;
}
export interface ObserverReadout {
  schema_version: 2;
  campaign_id: string;
  input_digest: string;
  anchor: Report['anchor'];
  behavior_available: boolean;
  slots: (PlannedSlot & {
    selected_block_id: string | null;
    attempt_ids: string[];
    exclusions: string[];
  })[];
  attempts: ObserverAttemptReadout[];
  comparisons: {
    comparison_id: string;
    scenario: string;
    planned_strict_pairs: number;
    realized_strict_pairs: number;
    pairs: {
      primary_block_id: string;
      block_id: string;
      baseline_attempt_id: string;
      treatment_attempt_id: string;
      baseline: StrictScore;
      treatment: StrictScore;
    }[];
  }[];
  general: Report;
  interpretation_ready: boolean;
  review_errors: string[];
  review_set: ReturnType<typeof readReviewSetEvidence>['anchor'] | null;
}
interface PublishedObserverEvidence {
  runDir: string;
  score: StrictScore | null;
  reviewEvidence: IndependentReviewEvidence | null;
  manifest_digest: string;
  bundle_digest: string;
  errors: string[];
}
function readPublishedObserver(
  resultsRoot: string,
  inputDigest: string,
  attempt: AttemptProjection,
): PublishedObserverEvidence {
  const refs = [
    ...new Map(
      [
        ...(attempt.observation?.artifacts ?? []),
        ...(attempt.accounting?.artifacts ?? []),
      ].map((ref) => [jcsCanonicalize(ref), ArtifactRefSchema.parse(ref)]),
    ).values(),
  ];
  const manifests = refs.filter(
    (ref) =>
      ref.path.split('/').length === 2 && ref.path.endsWith('/manifest.json'),
  );
  const manifestRef = manifests[0];
  if (manifests.length !== 1 || !manifestRef)
    throw new Error('One authenticated attempt manifest is required.');
  const manifestBytes = readPublishedArtifactBytes(resultsRoot, manifestRef);
  const manifest = parseAttemptManifest(
    new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
  );
  if (
    manifestRef.path !== `${manifest.run_id}/manifest.json` ||
    !same(manifest.campaign, attempt.intent.identity)
  )
    throw new Error('Published manifest identity mismatch.');
  const expected: ArtifactRef[] = [
    ...manifest.files.map((file) => ({
      path: `${manifest.run_id}/${file.path}`,
      bytes: file.size,
      sha256: file.sha256,
    })),
    manifestRef,
  ];
  if (
    refs.length !== expected.length ||
    new Set(refs.map((ref) => ref.path)).size !== refs.length
  )
    throw new Error(
      'Publication references are missing, duplicate or conflicting.',
    );
  const bodies = new Map<string, Buffer>();
  for (const bound of expected) {
    const ref = refs.find((ref) => ref.path === bound.path);
    if (!ref || !same(ref, bound))
      throw new Error('Publication member reference does not match manifest.');
    bodies.set(ref.path, readPublishedArtifactBytes(resultsRoot, ref));
  }
  const bundlePath = `${manifest.run_id}/${OBSERVER_BUNDLE_RELATIVE_DIR}`;
  const envelopePath = `${bundlePath}/${OBSERVER_BUNDLE_FILENAME}`;
  const envelopeRef = refs.find((ref) => ref.path === envelopePath);
  const envelope = bodies.get(envelopePath);
  if (!envelopeRef || !envelope)
    throw new Error(
      'Published observer bundle is missing from the authenticated manifest.',
    );
  const runDir = join(resultsRoot, manifest.run_id);
  const bundle = readObserverBundle(join(runDir, OBSERVER_BUNDLE_RELATIVE_DIR));
  if (
    !same(bundle, parseJson(envelope)) ||
    bundle.binding.run_id !== manifest.run_id ||
    !same(bundle.binding.campaign, attempt.intent.identity)
  )
    throw new Error('Observer bundle identity or envelope mismatch.');
  const content = (path: string) => {
    const member = bundle.files.find((file) => file.path === path);
    const ref = refs.find((ref) => ref.path === `${bundlePath}/${path}`);
    const bytes = bodies.get(`${bundlePath}/${path}`);
    if (
      !member ||
      !ref ||
      !bytes ||
      member.bytes !== ref.bytes ||
      member.sha256 !== ref.sha256
    )
      throw new Error('Observer member differs from published manifest.');
    return bytes;
  };
  for (const member of bundle.files) content(member.path);
  const published: PublishedObserverEvidence = {
    runDir,
    score: null,
    reviewEvidence: null,
    manifest_digest: manifestRef.sha256,
    bundle_digest: envelopeRef.sha256,
    errors: bundle.evidence_errors.map(
      (error) => `${error.code}: ${error.message}`,
    ),
  };
  if (bundle.score === null || bundle.actor_review === null) return published;
  const raw_sources = bundle.sources.map((source) => ({
    source_id: source.source_id,
    bytes: content(source.path),
  }));
  const receipts = bundle.receipts.map((path) =>
    validateArtifactReceipt(parseJson(content(path))),
  );
  const actor_review = validateActorReview(
    parseJson(content(bundle.actor_review)),
  );
  const replay = scoreObserverEvidence({
    raw_sources,
    binding: bundle.binding,
    receipts,
    review: actor_review,
  });
  if (!same(parseJson(content(bundle.score)), replay))
    throw new Error(
      'Saved strict score differs from authenticated frozen evidence replay.',
    );
  published.score = replay;
  published.errors.push(...replay.evidence_errors.map((error) => error.code));
  published.reviewEvidence = {
    identity: attempt.intent.identity,
    input_digest: inputDigest,
    manifest_digest: manifestRef.sha256,
    bundle_digest: envelopeRef.sha256,
    binding: bundle.binding,
    raw_sources,
    receipts,
    actor_review,
  };
  return published;
}

/** Both cohorts derive from one committed prefix; reviews never rewrite sealed scores. */
export function readObserverCampaign(args: {
  campaignDir: string;
  resultsRoot: string;
  reviewSetPath?: string;
}): ObserverReadout {
  if (
    !isAbsolute(args.campaignDir) ||
    !isAbsolute(args.resultsRoot) ||
    (args.reviewSetPath !== undefined && !isAbsolute(args.reviewSetPath))
  )
    throw new Error(
      'Observer readout storage roots must be explicit absolute paths.',
    );
  const prefix = readCommittedPrefix(args.campaignDir);
  const state = prefix.projection;
  const general = readComparisonFromPrefix({
    campaignDir: args.campaignDir,
    resultsRoot: args.resultsRoot,
    prefix,
  });
  const result: ObserverReadout = {
    schema_version: 2,
    campaign_id: state.experiment.campaign_id,
    input_digest: state.experiment.input_digest,
    anchor: general.anchor,
    behavior_available: general.report.behavior_available,
    slots: [],
    attempts: [],
    comparisons: [],
    general,
    interpretation_ready: false,
    review_errors: [],
    review_set: null,
  };
  let reviewFiles: ReturnType<typeof readReviewSetEvidence>['files'] = [];
  if (result.behavior_available && args.reviewSetPath) {
    try {
      const reviewSet = readReviewSetEvidence(args.reviewSetPath);
      result.review_set = reviewSet.anchor;
      const sealedRuns = [...state.attempts.values()].flatMap((attempt) =>
        [
          ...(attempt.observation?.artifacts ?? []),
          ...(attempt.accounting?.artifacts ?? []),
        ]
          .filter(
            (ref) =>
              ref.path.split('/').length === 2 &&
              ref.path.endsWith('/manifest.json'),
          )
          .map((ref) => resolve(args.resultsRoot, dirname(ref.path))),
      );
      if (
        [args.reviewSetPath, ...reviewSet.files.map((file) => file.path)].some(
          (path) =>
            sealedRuns.some(
              (run) =>
                resolve(path) === run || resolve(path).startsWith(`${run}/`),
            ),
        )
      )
        throw new Error(
          'Independent review set and sidecars must be outside sealed runs.',
        );
      reviewFiles = reviewSet.files;
    } catch (error) {
      result.review_errors.push(errorMessage(error));
    }
  }
  const usedReviews = new Set<number>();
  for (const [id, attempt] of state.attempts) {
    const identity = attempt.intent.identity;
    const slot = state.experiment.planned_slots.find(
      (slot) => slot.sample_id === identity.sample_id,
    );
    const block = state.blocks.get(identity.block_id);
    const generalAttempt = general.report.attempts.find(
      (attempt) => attempt.execution_attempt_id === id,
    );
    if (!slot || !block || !generalAttempt)
      throw new Error(
        'Observer projection lacks its frozen slot, block or general attempt.',
      );
    const selected =
      state.selected_blocks.get(attempt.intent.primary_block_id) ===
      identity.block_id;
    const item: ObserverAttemptReadout = {
      identity,
      arm: slot.arm,
      selected,
      strict_eligible: false,
      strict_score: null,
      composed_outcome: null,
      grader_status: null,
      manifest_digest: null,
      bundle_digest: null,
      exclusions: [],
      instrument_failures: [],
      disagreements: [],
      review: null,
    };
    result.attempts.push(item);
    if (!result.behavior_available) {
      item.exclusions.push(
        'Behavior hidden while session is active or unresolved.',
      );
      continue;
    }
    item.composed_outcome = generalAttempt.evidence.observed_outcome;
    item.grader_status = generalAttempt.evidence.gauntlet?.status ?? null;
    if (!selected)
      item.exclusions.push('Attempt belongs to a superseded block.');
    if (block.excluded)
      item.exclusions.push(`Block excluded: ${block.excluded}`);
    const validity = readBlockValidity({
      campaignDir: args.campaignDir,
      state,
      block,
    });
    if (!validity.available) item.exclusions.push(...validity.reasons);
    try {
      const published = readPublishedObserver(
        args.resultsRoot,
        state.experiment.input_digest,
        attempt,
      );
      item.manifest_digest = published.manifest_digest;
      item.bundle_digest = published.bundle_digest;
      item.strict_score = published.score;
      item.instrument_failures.push(...published.errors);
      const matching = reviewFiles.flatMap((file, index) => {
        if (file.review.identity.execution_attempt_id !== id) return [];
        usedReviews.add(index);
        return [file.review];
      });
      if (published.reviewEvidence)
        item.review = assessIndependentReviews(
          published.reviewEvidence,
          matching,
        );
      if (published.score) {
        const strict = published.score.status;
        if (item.composed_outcome !== null && item.composed_outcome !== strict)
          item.disagreements.push(
            `Strict ${strict}; composed ${item.composed_outcome}.`,
          );
        if (item.grader_status !== null && item.grader_status !== strict)
          item.disagreements.push(
            `Strict ${strict}; grader ${item.grader_status}.`,
          );
        for (const review of item.review?.reviews ?? []) {
          if (!review.valid) continue;
          if (
            review.review.strict_status !== null &&
            review.review.strict_status !== strict
          )
            item.disagreements.push(
              `Reviewer ${review.review.reviewer}: ${review.review.strict_status}; strict ${strict}.`,
            );
          item.disagreements.push(
            ...review.review.disagreements.map(
              (disagreement) =>
                `Reviewer ${review.review.reviewer}: ${disagreement}`,
            ),
          );
          item.disagreements.push(
            ...review.review.judgments
              .filter((judgment) => judgment.assessment === 'disagree')
              .map(
                (judgment) =>
                  `Reviewer ${review.review.reviewer} disagrees at ${jcsCanonicalize(judgment.anchor)}: ${judgment.note}`,
              ),
          );
        }
      }
    } catch (error) {
      item.instrument_failures.push(errorMessage(error));
    }
    if (item.strict_score === null)
      item.exclusions.push('Authenticated strict score is unavailable.');
    else if (item.strict_score.status === 'indeterminate')
      item.exclusions.push('Strict score is indeterminate.');
    if (item.instrument_failures.length)
      item.exclusions.push(
        'Observer instrument evidence is incomplete or invalid.',
      );
    item.strict_eligible = item.exclusions.length === 0;
  }
  for (const [index, file] of reviewFiles.entries())
    if (!usedReviews.has(index))
      result.review_errors.push(
        `Review does not match an observed attempt: ${file.review.identity.execution_attempt_id}`,
      );
  for (const slot of state.experiment.planned_slots) {
    const attempts = result.attempts.filter(
      (attempt) => attempt.identity.sample_id === slot.sample_id,
    );
    const eligible = attempts.filter((attempt) => attempt.strict_eligible);
    result.slots.push({
      ...slot,
      selected_block_id:
        state.selected_blocks.get(slot.primary_block_id) ?? null,
      attempt_ids: attempts.map(
        (attempt) => attempt.identity.execution_attempt_id,
      ),
      exclusions: !result.behavior_available
        ? ['Behavior hidden while session is active or unresolved.']
        : attempts.length === 0
          ? ['Planned slot was never admitted.']
          : eligible.length === 1
            ? []
            : [
                ...new Set(attempts.flatMap((attempt) => attempt.exclusions)),
                ...(eligible.length > 1
                  ? ['Multiple eligible attempts for one planned slot.']
                  : []),
              ],
    });
  }
  if (result.behavior_available)
    for (const cell of state.experiment.cells) {
      const roles = state.experiment.comparisons.find(
        (comparison) => comparison.comparison_id === cell.comparison_id,
      );
      if (!roles) throw new Error('Frozen comparison roles are missing.');
      const slots = result.slots.filter(
        (slot) =>
          slot.comparison_id === cell.comparison_id &&
          slot.scenario === cell.scenario,
      );
      const comparison: ObserverReadout['comparisons'][number] = {
        comparison_id: cell.comparison_id,
        scenario: cell.scenario,
        planned_strict_pairs:
          'arm' in roles
            ? 0
            : new Set(slots.map((slot) => slot.primary_block_id)).size,
        realized_strict_pairs: 0,
        pairs: [],
      };
      result.comparisons.push(comparison);
      if ('arm' in roles) continue;
      for (const primary of new Set(
        slots.map((slot) => slot.primary_block_id),
      )) {
        const select = (arm: string) => {
          const slot = slots.find(
            (slot) => slot.primary_block_id === primary && slot.arm === arm,
          );
          const attempts = result.attempts.filter(
            (attempt) =>
              attempt.identity.sample_id === slot?.sample_id &&
              attempt.strict_eligible,
          );
          return attempts.length === 1 ? attempts[0] : undefined;
        };
        const baseline = select(roles.baseline);
        const treatment = select(roles.treatment);
        if (
          !baseline?.strict_score ||
          !treatment?.strict_score ||
          baseline.identity.block_id !== treatment.identity.block_id
        )
          continue;
        comparison.pairs.push({
          primary_block_id: primary,
          block_id: baseline.identity.block_id,
          baseline_attempt_id: baseline.identity.execution_attempt_id,
          treatment_attempt_id: treatment.identity.execution_attempt_id,
          baseline: baseline.strict_score,
          treatment: treatment.strict_score,
        });
      }
      comparison.realized_strict_pairs = comparison.pairs.length;
    }
  result.interpretation_ready =
    result.behavior_available &&
    result.review_errors.length === 0 &&
    result.slots.length > 0 &&
    result.slots.every((slot) => slot.exclusions.length === 0) &&
    result.attempts.every((attempt) => attempt.review?.ready === true);
  if (result.review_errors.length > 0)
    for (const attempt of result.attempts)
      if (attempt.review) {
        attempt.review.ready = false;
        attempt.review.classifications = [];
      }
  return result;
}
