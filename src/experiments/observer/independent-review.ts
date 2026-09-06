import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  closePin,
  pinAbsoluteDir,
  readPinnedNoFollowBytes,
} from '../../appliance/credential-scope.ts';
import { readPublishedArtifactBytes } from '../../campaign/attempt-publish.ts';
import { createDurableMarker } from '../../campaign/journal.ts';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../../contracts/campaign/campaign.ts';
import { jcsCanonicalize } from '../../contracts/campaign/digest.ts';
import {
  type ArtifactRef,
  ArtifactRefSchema,
} from '../../contracts/campaign/execution.ts';
import {
  Sha256Schema,
  TimestampSchema,
} from '../../contracts/campaign/experiment.ts';
import {
  indexBoundObserverSource,
  indexObserverSource,
  type ObserverBinding,
} from './binding.ts';
import type { ObserverSupportingFile } from './contracts.ts';
import {
  type RawAnchor,
  RawAnchorSchema,
  RawPrefixSchema,
} from './contracts.ts';
import { createRawPrefix, verifyRawPrefix } from './raw.ts';
import {
  type ActorReview,
  type ArtifactReceipt,
  SupportingPrefixSchema,
  validateArtifactReceipt,
  verifySupportingPrefixes,
} from './review.ts';

const CallCoverageSchema = z
  .object({
    anchor: RawAnchorSchema,
    call_id: z.string().min(1),
    result_anchors: z.array(RawAnchorSchema),
  })
  .strict();
const JudgmentSchema = z
  .object({
    anchor: RawAnchorSchema,
    event: z.enum([
      'call',
      'understanding',
      'design_approval',
      'spec_approval',
      'plan_approval',
      'execution_choice',
    ]),
    assessment: z.enum(['agree', 'disagree', 'unresolved']),
    classification: z
      .enum(['cosmetic', 'substantive', 'unresolved'])
      .nullable(),
    before_receipt: z.string().min(1).nullable(),
    after_receipt: z.string().min(1).nullable(),
    note: z.string().min(1),
  })
  .strict();
export const IndependentReviewSchema = z
  .object({
    schema_version: z.literal(2),
    identity: CampaignIdentitySchema,
    input_digest: Sha256Schema,
    manifest_digest: Sha256Schema,
    bundle_digest: Sha256Schema,
    reviewer: z.string().min(1),
    reviewed_at: TimestampSchema,
    source_prefixes: z.array(RawPrefixSchema),
    supporting_prefixes: z.array(SupportingPrefixSchema),
    calls: z.array(CallCoverageSchema),
    judgments: z.array(JudgmentSchema),
    strict_status: z.enum(['pass', 'fail', 'indeterminate']).nullable(),
    disagreements: z.array(z.string().min(1)),
  })
  .strict();
export type IndependentReview = z.infer<typeof IndependentReviewSchema>;
export const ReviewSetSchema = z
  .object({ schema_version: z.literal(2), reviews: z.array(ArtifactRefSchema) })
  .strict();
export type ReviewSet = z.infer<typeof ReviewSetSchema>;

const parseJson = (bytes: Buffer): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
function readSetBytes(path: string): Buffer {
  if (!isAbsolute(path))
    throw new Error('Review set requires an explicit absolute path.');
  const bytes = readPinnedNoFollowBytes(
    dirname(path),
    [basename(path)],
    'independent review set',
    true,
  );
  if (bytes === null) throw new Error('Review set is missing.');
  return bytes;
}
/** Every listed submission survives, including duplicate and conflicting reviewers. */
export function readReviewSetEvidence(path: string): {
  anchor: {
    path: string;
    bytes: number;
    sha256: string;
    sidecars: ArtifactRef[];
  };
  files: { review: IndependentReview; path: string; ref: ArtifactRef }[];
} {
  const bytes = readSetBytes(path);
  const set = ReviewSetSchema.parse(parseJson(bytes));
  const result = set.reviews.map((ref) => ({
    review: IndependentReviewSchema.parse(
      parseJson(readPublishedArtifactBytes(dirname(path), ref)),
    ),
    path: join(dirname(path), ref.path),
    ref,
  }));
  if (!readSetBytes(path).equals(bytes))
    throw new Error('Review set changed during authentication.');
  return {
    anchor: {
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sidecars: set.reviews,
    },
    files: result,
  };
}
export function readReviewSet(path: string): IndependentReview[] {
  return readReviewSetEvidence(path).files.map((file) => file.review);
}
function writeExclusive(path: string, value: unknown): ArtifactRef {
  if (!isAbsolute(path))
    throw new Error('Review publication requires an absolute path.');
  const parent = pinAbsoluteDir(
    dirname(path),
    'independent review publication',
  );
  const bytes = Buffer.from(`${jcsCanonicalize(value)}\n`);
  try {
    createDurableMarker(join(parent.viaPath, basename(path)), bytes.toString());
  } finally {
    closePin(parent);
  }
  return {
    path: basename(path),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
export function writeIndependentReview(
  path: string,
  review: IndependentReview,
): ArtifactRef {
  return writeExclusive(path, IndependentReviewSchema.parse(review));
}
export function writeReviewSet(path: string, set: ReviewSet): ArtifactRef {
  return writeExclusive(path, ReviewSetSchema.parse(set));
}

export interface IndependentReviewEvidence {
  identity: CampaignIdentity;
  input_digest: string;
  manifest_digest: string;
  bundle_digest: string;
  binding: ObserverBinding;
  raw_sources: { source_id: string; bytes: Uint8Array }[];
  supporting_files: readonly ObserverSupportingFile[];
  actor_review: ActorReview;
  receipts: ArtifactReceipt[];
}
export interface IndependentReviewAssessment {
  ready: boolean;
  reviews: { review: IndependentReview; valid: boolean; reasons: string[] }[];
  conflicts: string[];
  classifications: {
    anchor: RawAnchor;
    classification: 'cosmetic' | 'substantive';
    reviewers: string[];
  }[];
}
const key = (anchor: RawAnchor) => jcsCanonicalize(anchor);
const judgmentKey = (
  judgment: Pick<IndependentReview['judgments'][number], 'anchor' | 'event'>,
) => `${key(judgment.anchor)}:${judgment.event}`;
const same = (a: unknown, b: unknown) =>
  jcsCanonicalize(a) === jcsCanonicalize(b);
function exactSet(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((value) => expected.includes(value))
  );
}

/** Bind claims to evidence; authentication cannot establish semantic truth. */
export function assessIndependentReviews(
  evidence: IndependentReviewEvidence,
  reviews: IndependentReview[],
): IndependentReviewAssessment {
  const result: IndependentReviewAssessment = {
    ready: false,
    reviews: [],
    conflicts: [],
    classifications: [],
  };
  const seenReviewers = new Set<string>();
  const judgments = new Map<
    string,
    { judgment: IndependentReview['judgments'][number]; reviewer: string }[]
  >();
  for (const rawReview of reviews) {
    const reasons: string[] = [];
    const record = { review: rawReview, valid: false, reasons };
    result.reviews.push(record);
    try {
      const review = IndependentReviewSchema.parse(rawReview);
      verifySupportingPrefixes(
        evidence.supporting_files,
        review.supporting_prefixes,
        true,
      );
      if (seenReviewers.has(review.reviewer))
        result.conflicts.push(
          `Duplicate reviewer submission: ${review.reviewer}`,
        );
      seenReviewers.add(review.reviewer);
      if (review.reviewer === evidence.actor_review.reviewer)
        throw new Error('Actor review is not independent.');
      if (
        !same(review.identity, evidence.identity) ||
        review.input_digest !== evidence.input_digest ||
        review.manifest_digest !== evidence.manifest_digest ||
        review.bundle_digest !== evidence.bundle_digest
      )
        throw new Error(
          'Independent review evidence identity or digest mismatch.',
        );
      const entries = evidence.binding.sources.flatMap((bound) => {
        const sources = evidence.raw_sources.filter(
          (source) => source.source_id === bound.source.source_id,
        );
        const raw = sources[0];
        if (sources.length !== 1 || !raw)
          throw new Error('Review raw source inventory is incomplete.');
        const prefixes = review.source_prefixes.filter(
          (prefix) => prefix.source_id === raw.source_id,
        );
        const prefix = prefixes[0];
        if (
          prefixes.length !== 1 ||
          !prefix ||
          !same(prefix, createRawPrefix(bound.source, raw.bytes))
        )
          throw new Error(
            'Independent review must cover each complete frozen source prefix.',
          );
        return (
          bound.source.source_id === evidence.binding.parent_source_id
            ? indexBoundObserverSource(
                evidence.binding,
                bound.source,
                raw.bytes,
                evidence.supporting_files,
              )
            : indexObserverSource(
                bound.source,
                raw.bytes,
                evidence.supporting_files,
              )
        ).entries;
      });
      if (review.source_prefixes.length !== evidence.binding.sources.length)
        throw new Error('Independent review has extra prefixes.');
      const calls = entries.filter((entry) => entry.kind === 'call');
      if (
        !exactSet(
          review.calls.map((call) => key(call.anchor)),
          calls.map((call) => key(call.anchor)),
        )
      )
        throw new Error(
          'Independent review call coverage is incomplete or duplicate.',
        );
      for (const call of review.calls) {
        const canonical = calls.find((entry) =>
          same(entry.anchor, call.anchor),
        );
        const results = entries.filter(
          (entry) =>
            entry.kind === 'result' && same(entry.call_anchor, call.anchor),
        );
        if (
          canonical?.call_id !== call.call_id ||
          !exactSet(
            call.result_anchors.map(key),
            results.map((entry) => key(entry.anchor)),
          )
        )
          throw new Error(
            'Independent review result coverage or call identity mismatch.',
          );
      }
      const expectedJudgments = [
        ...calls.map((call) =>
          judgmentKey({ anchor: call.anchor, event: 'call' }),
        ),
        ...evidence.actor_review.events.map((event) =>
          judgmentKey({
            anchor: event.anchor,
            event:
              event.kind === 'artifact_approval'
                ? `${event.stage}_approval`
                : event.kind,
          }),
        ),
      ];
      if (!exactSet(review.judgments.map(judgmentKey), expectedJudgments))
        throw new Error(
          'Independent event judgment coverage is incomplete or duplicate.',
        );
      for (const judgment of review.judgments) {
        const claims = judgments.get(judgmentKey(judgment)) ?? [];
        claims.push({ judgment, reviewer: review.reviewer });
        judgments.set(judgmentKey(judgment), claims);
        if (
          judgment.assessment === 'unresolved' ||
          judgment.classification === 'unresolved'
        )
          reasons.push('Independent judgment remains unresolved.');
        if (
          judgment.event !== 'call' &&
          (judgment.classification !== null ||
            judgment.before_receipt !== null ||
            judgment.after_receipt !== null)
        )
          throw new Error(
            'Only a physical call can carry an edit classification.',
          );
        const hasReceipts =
          judgment.before_receipt !== null || judgment.after_receipt !== null;
        if (judgment.classification === 'cosmetic' || hasReceipts) {
          const before = evidence.receipts.find(
            (receipt) => receipt.observation_id === judgment.before_receipt,
          );
          const after = evidence.receipts.find(
            (receipt) => receipt.observation_id === judgment.after_receipt,
          );
          const call = calls.find((entry) =>
            same(entry.anchor, judgment.anchor),
          );
          if (
            !before ||
            !after ||
            !call ||
            before.observation_id === after.observation_id ||
            before.artifact_path !== after.artifact_path ||
            before.source_prefix.source_id !== call.anchor.source_id ||
            after.source_prefix.source_id !== call.anchor.source_id ||
            before.source_prefix.after_line >= call.anchor.line ||
            after.source_prefix.after_line < call.anchor.line ||
            before.sha256 === after.sha256
          )
            throw new Error(
              'Edit before/after receipts do not establish the claimed change.',
            );
          const callResults = entries.filter(
            (entry) =>
              entry.kind === 'result' && same(entry.call_anchor, call.anchor),
          );
          if (
            callResults.length === 0 ||
            callResults.some(
              (entry) => entry.anchor.line > after.source_prefix.after_line,
            )
          )
            throw new Error('After receipt does not cover the edit result.');
          for (const receipt of [before, after]) {
            validateArtifactReceipt(receipt);
            const source = evidence.binding.sources.find(
              (bound) =>
                bound.source.source_id === receipt.source_prefix.source_id,
            );
            const raw = evidence.raw_sources.find(
              (raw) => raw.source_id === receipt.source_prefix.source_id,
            );
            if (!source || !raw) throw new Error('Receipt source is missing.');
            verifyRawPrefix(source.source, raw.bytes, receipt.source_prefix);
            verifySupportingPrefixes(
              evidence.supporting_files,
              receipt.supporting_prefixes,
              false,
            );
          }
        }
      }
      if (review.strict_status === null)
        reasons.push('Independent strict judgment is missing.');
      record.valid = reasons.length === 0;
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const claims of judgments.values()) {
    const first = claims[0];
    if (!first) continue;
    if (
      claims.some(
        ({ judgment }) =>
          judgment.assessment !== first.judgment.assessment ||
          judgment.classification !== first.judgment.classification ||
          judgment.before_receipt !== first.judgment.before_receipt ||
          judgment.after_receipt !== first.judgment.after_receipt,
      )
    )
      result.conflicts.push(
        `Conflicting judgments at ${key(first.judgment.anchor)}`,
      );
  }
  const statuses = new Set(reviews.map((review) => review.strict_status));
  if (statuses.size > 1)
    result.conflicts.push('Reviewers disagree on strict status.');
  result.ready =
    result.reviews.length > 0 &&
    result.reviews.every((review) => review.valid) &&
    result.conflicts.length === 0;
  if (result.ready)
    for (const claims of judgments.values()) {
      const first = claims[0];
      const classification = first?.judgment.classification;
      if (
        first &&
        (classification === 'cosmetic' || classification === 'substantive')
      )
        result.classifications.push({
          anchor: first.judgment.anchor,
          classification,
          reviewers: claims.map((claim) => claim.reviewer),
        });
    }
  return result;
}
