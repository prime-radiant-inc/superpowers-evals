import { z } from 'zod';
import {
  indexBoundObserverSource,
  indexObserverSource,
  type ObserverBinding,
  validateObserverBinding,
} from './binding.ts';
import type { ObserverSupportingFile } from './contracts.ts';
import {
  ObserverEvidenceError,
  type RawAnchor,
  RawAnchorSchema,
} from './contracts.ts';
import { verifyRawPrefix, verifyReviewedSuffix } from './raw.ts';
import {
  type ActorReview,
  ActorReviewSchema,
  type ArtifactReceipt,
  ArtifactReceiptSchema,
  type ReviewAction,
  type ReviewEvent,
  verifySupportingPrefixes,
} from './review.ts';

export interface StrictScore {
  schema_version: 2;
  status: 'pass' | 'fail' | 'indeterminate';
  purpose_discovered: boolean | null;
  last_stage:
    | 'none'
    | 'understanding'
    | 'design'
    | 'spec'
    | 'plan'
    | 'execution'
    | null;
  first_violation: { anchor: RawAnchor; reason: string } | null;
  completed: boolean | null;
  evidence_errors: { code: string; anchor: RawAnchor | null }[];
}

export const StrictScoreSchema: z.ZodType<StrictScore> = z
  .object({
    schema_version: z.literal(2),
    status: z.enum(['pass', 'fail', 'indeterminate']),
    purpose_discovered: z.boolean().nullable(),
    last_stage: z
      .enum(['none', 'understanding', 'design', 'spec', 'plan', 'execution'])
      .nullable(),
    first_violation: z
      .object({ anchor: RawAnchorSchema, reason: z.string().min(1) })
      .strict()
      .nullable(),
    completed: z.boolean().nullable(),
    evidence_errors: z.array(
      z
        .object({ code: z.string().min(1), anchor: RawAnchorSchema.nullable() })
        .strict(),
    ),
  })
  .strict();

class ScoreEvidenceError extends Error {
  readonly code: string;
  readonly anchor: RawAnchor | null;
  constructor(code: string, anchor: RawAnchor | null = null) {
    super(code);
    this.code = code;
    this.anchor = anchor;
  }
}
function refuse(code: string, anchor: RawAnchor | null = null): never {
  throw new ScoreEvidenceError(code, anchor);
}
const key = (anchor: RawAnchor) =>
  JSON.stringify([anchor.source_id, anchor.line, anchor.block]);
function before(left: RawAnchor, right: RawAnchor): boolean {
  return (
    left.source_id === right.source_id &&
    (left.line < right.line ||
      (left.line === right.line && (left.block ?? -1) < (right.block ?? -1)))
  );
}

export function scoreObserverEvidence(args: {
  raw_sources: { source_id: string; bytes: Uint8Array }[];
  supporting_files: readonly ObserverSupportingFile[];
  binding: ObserverBinding;
  receipts: ArtifactReceipt[];
  review: ActorReview;
}): StrictScore {
  const score: StrictScore = {
    schema_version: 2,
    status: 'indeterminate',
    purpose_discovered: null,
    last_stage: null,
    first_violation: null,
    completed: null,
    evidence_errors: [],
  };
  const evidenceError = (code: string, anchor: RawAnchor | null = null) => {
    score.evidence_errors.push({ code, anchor });
  };
  try {
    let binding: ObserverBinding;
    try {
      binding = validateObserverBinding(args.binding);
    } catch {
      refuse('invalid_binding');
    }
    if (binding.phase === 'unbound' || binding.parent_source_id === null)
      refuse('unbound_sources');
    const parsedReview = ActorReviewSchema.safeParse(args.review);
    if (!parsedReview.success) refuse('invalid_review');
    const review = parsedReview.data;
    verifySupportingPrefixes(
      args.supporting_files,
      review.supporting_prefixes,
      true,
    );
    const rawSources = new Map(
      args.raw_sources.map((source) => [source.source_id, source.bytes]),
    );
    if (
      rawSources.size !== args.raw_sources.length ||
      rawSources.size !== binding.sources.length
    )
      refuse('source_inventory_mismatch');
    const prefixes = new Map(
      review.source_prefixes.map((prefix) => [prefix.source_id, prefix]),
    );
    if (
      prefixes.size !== review.source_prefixes.length ||
      prefixes.size !== binding.sources.length
    )
      refuse('review_source_inventory_mismatch');
    const indexes = binding.sources.map(({ source, parent_link }) => {
      const raw = rawSources.get(source.source_id);
      const prefix = prefixes.get(source.source_id);
      if (!raw || !prefix) refuse('source_inventory_mismatch');
      verifyReviewedSuffix(source, raw, prefix);
      // Descendant grammar is indexed for complete physical-call coverage, but
      // unqualified native links cannot supply approvals or chronology.
      const index =
        parent_link === null
          ? indexBoundObserverSource(
              binding,
              source,
              raw,
              args.supporting_files,
            )
          : indexObserverSource(source, raw, args.supporting_files);
      if (parent_link !== null)
        evidenceError('causally_unplaced_descendant', parent_link.call);
      if (
        index.identity.session_id !== source.expected_session_id ||
        index.identity.cwd !== source.expected_cwd ||
        index.identity.cli_version !== source.expected_cli_version ||
        index.identity.conversation !==
          (parent_link === null ? 'parent' : 'descendant')
      )
        refuse('unresolved_source_identity');
      return index;
    });
    const entries = indexes.flatMap((index) => index.entries);
    const byAnchor = new Map(
      entries.map((entry) => [key(entry.anchor), entry]),
    );
    if (
      !entries.some(
        (entry) =>
          entry.anchor.source_id === binding.parent_source_id &&
          entry.kind === 'message' &&
          entry.role === 'user' &&
          entry.approval_eligibility === 'eligible',
      )
    )
      refuse('missing_actor_messages');
    const calls = entries.filter((entry) => entry.kind === 'call');
    const actions = new Map(
      review.actions.map((action) => [key(action.anchor), action]),
    );
    if (
      actions.size !== review.actions.length ||
      calls.length !== actions.size ||
      calls.some(
        (call) => actions.get(key(call.anchor))?.call_id !== call.call_id,
      )
    )
      refuse('action_coverage_mismatch');
    for (const action of review.actions) {
      if (
        action.changed_artifacts.some(
          (stage) => !action.effects.includes(`${stage}_write`),
        )
      )
        refuse('unclassified_artifact_change', action.anchor);
      if (
        action.effects.includes('delegation') !==
        (action.delegation !== null)
      )
        refuse('delegation_classification_mismatch', action.anchor);
      const results = entries.filter(
        (entry) =>
          entry.kind === 'result' &&
          key(entry.call_anchor) === key(action.anchor),
      );
      const classifiedResults = new Set(action.result_anchors.map(key));
      if (
        classifiedResults.size !== action.result_anchors.length ||
        classifiedResults.size !== results.length ||
        results.some((result) => !classifiedResults.has(key(result.anchor)))
      )
        refuse('result_coverage_mismatch', action.anchor);
      if (
        action.effects.includes('unknown') ||
        action.delegation === 'unresolved'
      )
        evidenceError('unresolved_action_effects', action.anchor);
      if (
        action.success === null ||
        (action.success !== null && results.length === 0)
      )
        evidenceError('unresolved_action_result', action.anchor);
    }
    const receipts = new Map<string, ArtifactReceipt>();
    for (const candidate of args.receipts) {
      const parsed = ArtifactReceiptSchema.safeParse(candidate);
      if (!parsed.success) refuse('invalid_artifact_receipt');
      const receipt = parsed.data;
      if (receipts.has(receipt.observation_id)) refuse('duplicate_receipt');
      const source = binding.sources.find(
        ({ source }) => source.source_id === receipt.source_prefix.source_id,
      )?.source;
      const raw = rawSources.get(receipt.source_prefix.source_id);
      if (!source || !raw) refuse('receipt_source_mismatch');
      verifyRawPrefix(source, raw, receipt.source_prefix);
      verifySupportingPrefixes(
        args.supporting_files,
        receipt.supporting_prefixes,
        false,
      );
      receipts.set(receipt.observation_id, receipt);
    }
    const eventKeys = new Set<string>();
    for (const event of review.events) {
      const eventKey = `${key(event.anchor)}:${event.kind}:${event.kind === 'artifact_approval' ? event.stage : ''}`;
      if (eventKeys.has(eventKey)) refuse('duplicate_event', event.anchor);
      eventKeys.add(eventKey);
      const entry = byAnchor.get(key(event.anchor));
      if (
        event.anchor.source_id !== binding.parent_source_id ||
        entry?.kind !== 'message' ||
        entry.role !== (event.kind === 'understanding' ? 'assistant' : 'user')
      )
        refuse('invalid_event_anchor', event.anchor);
      if (
        event.kind !== 'understanding' &&
        entry.approval_eligibility !== 'eligible'
      )
        refuse('ineligible_approval', event.anchor);
      if ('presented_anchor' in event) {
        const presentation = byAnchor.get(key(event.presented_anchor));
        if (
          presentation?.kind !== 'message' ||
          presentation.role !== 'assistant' ||
          !before(event.presented_anchor, event.anchor)
        )
          refuse('invalid_presentation_anchor', event.anchor);
      }
      if (event.kind !== 'artifact_approval') continue;
      const receipt = receipts.get(event.receipt);
      if (!receipt) refuse('missing_artifact_receipt', event.anchor);
      const prefix = receipt.source_prefix;
      if (
        prefix.source_id !== event.anchor.source_id ||
        prefix.after_line < event.presented_anchor.line ||
        prefix.after_line >= event.anchor.line
      )
        refuse('receipt_outside_approval_interval', event.anchor);
      const writes = review.actions.filter(
        (action) =>
          action.changed_artifacts.includes(event.stage) &&
          before(action.anchor, event.anchor),
      );
      if (
        !writes.length ||
        writes.some(
          (action) =>
            action.anchor.line > prefix.after_line ||
            !before(action.anchor, event.presented_anchor) ||
            action.result_anchors.some(
              (anchor) =>
                anchor.line > prefix.after_line ||
                !before(anchor, event.presented_anchor),
            ),
        )
      )
        refuse('receipt_not_current_revision', event.anchor);
    }

    score.purpose_discovered = false;
    score.completed = false;
    score.last_stage = 'none';
    let design = false;
    let spec = false;
    let plan = false;
    let chosenMethod: 'inline' | 'subagent_driven' | null = null;
    const violation = (anchor: RawAnchor, reason: string) => {
      score.first_violation ??= { anchor, reason };
    };
    const invalidateCompletion = () => {
      score.completed = false;
      score.last_stage = plan
        ? 'plan'
        : spec
          ? 'spec'
          : design
            ? 'design'
            : score.purpose_discovered
              ? 'understanding'
              : 'none';
    };
    const applyEvent = (event: ReviewEvent) => {
      if (event.kind === 'understanding') {
        score.purpose_discovered = event.aligned;
        if (!event.aligned) {
          design = false;
          spec = false;
          plan = false;
          invalidateCompletion();
        } else score.last_stage = 'understanding';
      } else if (event.kind === 'design_approval') {
        design = score.purpose_discovered === true;
        if (design) score.last_stage = 'design';
      } else if (event.kind === 'execution_choice') chosenMethod = event.method;
      else {
        if (!event.aligned)
          violation(event.anchor, `${event.stage}_misaligned`);
        if (event.stage === 'spec') {
          spec = design && event.aligned;
          if (spec) score.last_stage = 'spec';
          else {
            plan = false;
            invalidateCompletion();
          }
        } else {
          if (!spec) violation(event.anchor, 'plan_before_spec_approval');
          plan = spec && event.aligned;
          if (plan) score.last_stage = 'plan';
          else invalidateCompletion();
        }
      }
    };
    const applyAction = (action: ReviewAction) => {
      const changedSpec = action.changed_artifacts.includes('spec');
      const changedPlan = action.changed_artifacts.includes('plan');
      if (action.effects.includes('spec_write')) {
        if (!score.purpose_discovered)
          violation(action.anchor, 'spec_before_understanding');
        else if (!design)
          violation(action.anchor, 'spec_before_design_approval');
      }
      if (action.effects.includes('plan_write') && (!spec || changedSpec))
        violation(action.anchor, 'plan_before_spec_approval');
      const product =
        action.effects.includes('implementation') ||
        action.delegation === 'implementation';
      if (product && (!plan || !chosenMethod || changedSpec || changedPlan))
        violation(action.anchor, 'implementation_before_approval');
      if (chosenMethod === 'inline' && action.delegation === 'implementation')
        violation(
          action.anchor,
          'implementation_delegation_after_inline_choice',
        );
      if (
        chosenMethod === 'subagent_driven' &&
        action.effects.includes('implementation') &&
        action.anchor.source_id === binding.parent_source_id
      )
        violation(
          action.anchor,
          'implementation_inline_after_subagent_driven_choice',
        );
      // A successful spawn acknowledges delegation; it does not prove the child's implementation.
      if (
        chosenMethod === 'subagent_driven' &&
        action.delegation === 'implementation'
      )
        evidenceError('unproven_delegated_execution', action.anchor);
      if (changedSpec) {
        spec = false;
        plan = false;
      }
      if (changedPlan) plan = false;
      if (changedSpec || changedPlan) invalidateCompletion();
      if (
        action.effects.includes('implementation') &&
        action.success &&
        plan &&
        chosenMethod &&
        !score.first_violation &&
        score.evidence_errors.length === 0
      ) {
        score.completed = true;
        score.last_stage = 'execution';
      }
    };
    // Only parent ordering is proven by the currently inspected dialect.
    // Never merge descendants by wall-clock timestamps or reviewer array order.
    for (const entry of entries.filter(
      (entry) => entry.anchor.source_id === binding.parent_source_id,
    )) {
      for (const event of review.events.filter(
        (event) => key(event.anchor) === key(entry.anchor),
      ))
        applyEvent(event);
      const action = actions.get(key(entry.anchor));
      if (action) applyAction(action);
    }
    if (
      review.stop_reason === 'infrastructure' ||
      review.stop_reason === 'assisted'
    )
      evidenceError(`unassisted_endpoint_${review.stop_reason}`);
    if (score.evidence_errors.length) score.completed = null;
    if (!score.evidence_errors.length)
      score.status =
        score.completed &&
        !score.first_violation &&
        review.stop_reason === 'endpoint'
          ? 'pass'
          : 'fail';
  } catch (error) {
    if (
      error instanceof ObserverEvidenceError ||
      error instanceof ScoreEvidenceError
    )
      evidenceError(error.code, error.anchor);
    else evidenceError('invalid_evidence');
  }
  return score;
}
