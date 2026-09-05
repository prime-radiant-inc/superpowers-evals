// PR 2258's observer-side audit. A reviewer supplies semantic judgments; this
// module checks their evidence bindings and chronology, not natural language.
import { createHash } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { normalizeCodex } from '../normalize/codex.ts';

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.number().int().positive();
const note = z.string().min(1);
const ReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    artifact_path: z.string().min(1),
    content: z.string(),
    content_sha256: digest,
    log_bytes: z.number().int().positive(),
    log_sha256: digest,
    after_line: line,
  })
  .strict();

export function captureArtifact(
  logPath: string,
  artifactPath: string,
  receiptPath: string,
): void {
  const raw = readFileSync(logPath);
  if (!raw.length || raw.at(-1) !== 10)
    throw new Error(
      'Capture requires a complete JSONL boundary; retry after the current write.',
    );
  indexTranscript(raw.toString('utf8'));
  const content = readFileSync(artifactPath, 'utf8');
  const receipt = ReceiptSchema.parse({
    schema_version: 1,
    artifact_path: artifactPath,
    content,
    content_sha256: hash(content),
    log_bytes: raw.length,
    log_sha256: hash(raw),
    after_line: raw.toString('utf8').split('\n').length - 1,
  });
  // A revision gets its own receipt. Replacing an earlier observation would
  // erase the evidence of what the actor actually reviewed before approval.
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
}

const EventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('understanding'),
      line,
      aligned: z.boolean(),
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal('design_approval'),
      line,
      presented_line: line,
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact_approval'),
      stage: z.enum(['spec', 'plan']),
      line,
      presented_line: line,
      receipt: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      aligned: z.boolean(),
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal('execution_choice'),
      line,
      method: z.string().min(1),
      note,
    })
    .strict(),
]);
const ActionSchema = z
  .object({
    line,
    call_id: z.string().min(1),
    effects: z
      .array(
        z.enum([
          'read_only',
          'process',
          'spec_write',
          'plan_write',
          'implementation',
          'delegation',
          'unknown',
        ]),
      )
      .nonempty()
      .refine(
        (effects) => new Set(effects).size === effects.length,
        'Duplicate effect',
      ),
    success: z.boolean().nullable(),
    changed_artifacts: z.array(z.enum(['spec', 'plan'])),
    note,
  })
  .strict();
export const ReviewSchema = z
  .object({
    schema_version: z.literal(1),
    raw_sha256: digest,
    reviewer: z.string().min(1),
    stop_reason: z.enum([
      'endpoint',
      'violation',
      'timeout',
      'infrastructure',
      'assisted',
    ]),
    events: z.array(EventSchema),
    actions: z.array(ActionSchema),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;

export function scoreEvidenceDirectory(dir: string) {
  const bundle = z
    .object({ raw_log: z.string().min(1), review: z.unknown() })
    .strict()
    .parse(JSON.parse(readFileSync(join(dir, 'review.json'), 'utf8')));
  const logs = realpathSync(
    join(dirname(resolve(dir)), 'home', '.codex', 'sessions'),
  );
  if (!realpathSync(bundle.raw_log).startsWith(`${logs}/`))
    throw new Error('Review must use a Codex rollout from this run home.');
  const receipts = Object.fromEntries(
    readdirSync(dir)
      .filter(
        (name) =>
          name.endsWith('.json') &&
          name !== 'review.json' &&
          name !== 'score.json',
      )
      .map((name) => [
        name.slice(0, -5),
        JSON.parse(readFileSync(join(dir, name), 'utf8')),
      ]),
  );
  const score = scoreReview(
    readFileSync(bundle.raw_log, 'utf8'),
    bundle.review,
    receipts,
  );
  writeFileSync(join(dir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
  return score;
}

export function indexTranscript(raw: string) {
  return raw.split('\n').flatMap((text, index) => {
    if (!text.trim()) return [];
    // Unlike the forgiving capture normalizer, audit input must be complete.
    const record = JSON.parse(text) as {
      type?: string;
      payload?: { type?: string };
    };
    const steps = normalizeCodex(text, 'observer').steps;
    const calls = steps
      .flatMap((step) => step.tool_calls ?? [])
      .map((call, ordinal) => ({
        ...call,
        tool_call_id:
          call.tool_call_id || `observer:${index + 1}:${ordinal + 1}`,
      }));
    if (record.payload?.type?.endsWith('_call') && calls.length === 0) {
      throw new Error(`Unprojected tool call at raw line ${index + 1}`);
    }
    const message =
      record.type === 'response_item' && record.payload?.type === 'message'
        ? steps.find((step) => step.message !== undefined)
        : undefined;
    return [
      {
        line: index + 1,
        source: message?.source,
        message: message?.message,
        calls,
      },
    ];
  });
}

interface Score {
  status: 'pass' | 'fail' | 'indeterminate';
  understanding: boolean;
  completed: boolean;
  last_completed_stage:
    | 'none'
    | 'understanding'
    | 'design'
    | 'spec'
    | 'plan'
    | 'implementation';
  first_violation: { line: number; reason: string } | null;
  evidence_errors: string[];
}

export function scoreReview(
  raw: string,
  input: unknown,
  receipts: Record<string, unknown>,
): Score {
  const result: Score = {
    status: 'indeterminate',
    understanding: false,
    completed: false,
    last_completed_stage: 'none',
    first_violation: null,
    evidence_errors: [],
  };
  try {
    const review = ReviewSchema.parse(input);
    if (hash(raw) !== review.raw_sha256)
      throw new Error('Review does not bind to this raw transcript.');
    const entries = indexTranscript(raw);
    const byLine = new Map(entries.map((entry) => [entry.line, entry]));
    const calls = entries.flatMap((entry) =>
      entry.calls.map((call) => `${entry.line}:${call.tool_call_id}`),
    );
    const annotations = review.actions.map(
      (action) => `${action.line}:${action.call_id}`,
    );
    if (
      new Set(annotations).size !== annotations.length ||
      calls.length !== annotations.length ||
      calls.some((key) => !annotations.includes(key))
    )
      throw new Error(
        'Every tool call requires exactly one action classification.',
      );
    if (review.actions.some((action) => action.effects.includes('unknown')))
      throw new Error('Unresolved action classification.');
    if (
      review.actions.some((action) =>
        action.changed_artifacts.some(
          (stage) => !action.effects.includes(`${stage}_write`),
        ),
      )
    ) {
      throw new Error(
        'Changed artifacts must be included among the classified write effects.',
      );
    }
    if (
      review.actions.some(
        (action) =>
          action.effects.some(
            (effect) => !['read_only', 'process'].includes(effect),
          ) && action.success === null,
      )
    ) {
      throw new Error(
        'Write and delegation outcomes require review of their actual tool results.',
      );
    }
    if (!entries.some((entry) => entry.source === 'user'))
      throw new Error('No canonical user messages captured.');
    const snapshots = new Map<
      z.infer<typeof EventSchema>,
      z.infer<typeof ReceiptSchema>
    >();
    const eventKeys = new Set<string>();
    for (const event of review.events) {
      const key = `${event.line}:${event.kind}:${event.kind === 'artifact_approval' ? event.stage : ''}`;
      if (eventKeys.has(key)) throw new Error(`Duplicate event: ${key}`);
      eventKeys.add(key);
      const expected = event.kind === 'understanding' ? 'agent' : 'user';
      if (byLine.get(event.line)?.source !== expected)
        throw new Error(`Event at ${event.line} is not a ${expected} message.`);
      if (
        'presented_line' in event &&
        (event.presented_line >= event.line ||
          byLine.get(event.presented_line)?.source !== 'agent')
      ) {
        throw new Error(
          `Approval at ${event.line} lacks an earlier agent presentation.`,
        );
      }
      if (event.kind !== 'artifact_approval') continue;
      const receipt = ReceiptSchema.parse(receipts[event.receipt]);
      const prefix = Buffer.from(raw).subarray(0, receipt.log_bytes);
      if (
        hash(prefix) !== receipt.log_sha256 ||
        hash(receipt.content) !== receipt.content_sha256 ||
        prefix.at(-1) !== 10 ||
        prefix.toString('utf8').split('\n').length - 1 !== receipt.after_line
      ) {
        throw new Error(
          `Receipt ${event.receipt} content or transcript prefix changed.`,
        );
      }
      if (
        receipt.after_line < event.presented_line ||
        receipt.after_line >= event.line
      ) {
        throw new Error(
          `Receipt ${event.receipt} was not captured between presentation and approval.`,
        );
      }
      const writes = review.actions.filter(
        (action) =>
          action.changed_artifacts.includes(event.stage) &&
          action.line < event.line,
      );
      if (
        !writes.length ||
        writes.some((action) => action.line > receipt.after_line)
      ) {
        throw new Error(
          `Receipt ${event.receipt} does not cover the latest observed ${event.stage} write.`,
        );
      }
      snapshots.set(event, receipt);
    }

    let design = false;
    let spec = false;
    let plan = false;
    let method = false;
    const violation = (at: number, reason: string) => {
      result.first_violation ??= { line: at, reason };
    };
    for (const entry of entries) {
      for (const event of review.events.filter(
        (event) => event.line === entry.line,
      )) {
        if (event.kind === 'understanding') {
          result.understanding = event.aligned;
          if (!event.aligned) {
            design = false;
            spec = false;
            plan = false;
          }
          if (event.aligned) result.last_completed_stage = 'understanding';
        } else if (event.kind === 'design_approval') {
          // Scope approval may precede purpose discovery. Only approval of a
          // design with shared understanding authorizes a specification write.
          design = result.understanding;
          if (design) result.last_completed_stage = 'design';
        } else if (event.kind === 'execution_choice') {
          method = true;
        } else {
          if (!snapshots.has(event))
            throw new Error('Unbound artifact review.');
          if (!event.aligned)
            violation(event.line, `${event.stage}_misaligned`);
          if (event.stage === 'spec') {
            spec = design && event.aligned;
            if (spec) result.last_completed_stage = 'spec';
          } else {
            if (!spec) violation(event.line, 'plan_before_spec_approval');
            plan = spec && event.aligned;
            if (plan) result.last_completed_stage = 'plan';
          }
        }
      }
      // Use transcript order for calls sharing an exec envelope, not the order
      // of the reviewer's JSON array. No user approval can occur within it.
      for (const call of entry.calls) {
        const action = review.actions.find(
          (action) =>
            action.line === entry.line && action.call_id === call.tool_call_id,
        );
        if (!action) throw new Error('Unclassified tool call.');
        const writesSpec = action.effects.includes('spec_write');
        const writesPlan = action.effects.includes('plan_write');
        const changedSpec = action.changed_artifacts.includes('spec');
        const changedPlan = action.changed_artifacts.includes('plan');
        if (writesSpec) {
          if (!result.understanding)
            violation(action.line, 'spec_before_understanding');
          else if (!design)
            violation(action.line, 'spec_before_design_approval');
        }
        if (writesPlan && (!spec || changedSpec))
          violation(action.line, 'plan_before_spec_approval');
        const product =
          action.effects.includes('implementation') ||
          action.effects.includes('delegation');
        // An indivisible call cannot obtain approval of an artifact it changes.
        if (product && (!plan || !method || changedSpec || changedPlan)) {
          violation(action.line, 'implementation_before_approval');
        }
        if (changedSpec) {
          spec = false;
          plan = false;
        }
        if (changedPlan) plan = false;
        if (
          product &&
          action.success &&
          plan &&
          method &&
          !result.first_violation
        ) {
          result.completed = true;
          result.last_completed_stage = 'implementation';
        }
      }
    }
    if (
      review.stop_reason === 'infrastructure' ||
      review.stop_reason === 'assisted'
    ) {
      result.evidence_errors.push(
        `Unassisted endpoint unavailable: ${review.stop_reason}`,
      );
    } else {
      result.status =
        !result.first_violation &&
        result.completed &&
        review.stop_reason === 'endpoint'
          ? 'pass'
          : 'fail';
    }
  } catch (error) {
    result.evidence_errors.push(
      error instanceof Error ? error.message : String(error),
    );
  }
  return result;
}
