import { z } from 'zod';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ObserverSupportingFile {
  root_id: string;
  relative_path: string;
  bytes: Uint8Array;
}

export interface RawSource {
  source_id: string;
  runtime: 'codex' | 'claude';
  expected_session_id: string;
  expected_cwd: string;
  expected_cli_version: string;
}

export interface RawAnchor {
  source_id: string;
  line: number;
  block: number | null;
}

export interface RawPrefix {
  source_id: string;
  bytes: number;
  sha256: string;
  after_line: number;
}

export interface SourceIdentity {
  session_id: string | null;
  cwd: string | null;
  cli_version: string | null;
  conversation: 'parent' | 'descendant' | 'unresolved';
  evidence: RawAnchor[];
}

export type RawEntry =
  | {
      kind: 'message';
      anchor: RawAnchor;
      role: 'assistant' | 'user';
      text: string;
      message_id: string | null;
      claimed_origin: 'external' | 'internal' | 'unclaimed';
      approval_eligibility: 'eligible' | 'ineligible' | 'unresolved';
    }
  | {
      kind: 'call';
      anchor: RawAnchor;
      call_id: string;
      native_call_id: string | null;
      name: string;
      payload: JsonValue;
    }
  | {
      kind: 'result';
      anchor: RawAnchor;
      call_id: string;
      call_anchor: RawAnchor;
      payload: JsonValue;
    }
  | {
      kind: 'replay';
      anchor: RawAnchor;
      canonical_anchor: RawAnchor;
    }
  | {
      kind: 'non_action';
      anchor: RawAnchor;
      record_type: string;
    };

export interface RawIndex {
  schema_version: 2;
  source: RawSource;
  identity: SourceIdentity;
  prefix: RawPrefix;
  entries: RawEntry[];
}

export type EvidenceErrorCode =
  | 'invalid_source'
  | 'invalid_utf8'
  | 'incomplete_jsonl'
  | 'invalid_jsonl'
  | 'invalid_record'
  | 'unknown_record'
  | 'identity_conflict'
  | 'replay_conflict'
  | 'orphan_result'
  | 'prefix_mismatch'
  | 'unreviewed_suffix';

export class ObserverEvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  readonly anchor: RawAnchor | null;

  constructor(
    code: EvidenceErrorCode,
    message: string,
    anchor: RawAnchor | null = null,
  ) {
    super(message);
    this.name = 'ObserverEvidenceError';
    this.code = code;
    this.anchor = anchor;
  }
}

const NonemptyStringSchema = z.string().min(1);
const NonnegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const PositiveSafeIntegerSchema = z.number().int().safe().positive();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const RawSourceSchema: z.ZodType<RawSource> = z
  .object({
    source_id: NonemptyStringSchema,
    runtime: z.enum(['codex', 'claude']),
    expected_session_id: NonemptyStringSchema,
    expected_cwd: NonemptyStringSchema,
    expected_cli_version: NonemptyStringSchema,
  })
  .strict();

export const RawAnchorSchema: z.ZodType<RawAnchor> = z
  .object({
    source_id: NonemptyStringSchema,
    line: PositiveSafeIntegerSchema,
    block: NonnegativeSafeIntegerSchema.nullable(),
  })
  .strict();

export const RawPrefixSchema: z.ZodType<RawPrefix> = z
  .object({
    source_id: NonemptyStringSchema,
    bytes: NonnegativeSafeIntegerSchema,
    sha256: Sha256Schema,
    after_line: NonnegativeSafeIntegerSchema,
  })
  .strict();

export const SourceIdentitySchema: z.ZodType<SourceIdentity> = z
  .object({
    session_id: NonemptyStringSchema.nullable(),
    cwd: NonemptyStringSchema.nullable(),
    cli_version: NonemptyStringSchema.nullable(),
    conversation: z.enum(['parent', 'descendant', 'unresolved']),
    evidence: z.array(RawAnchorSchema),
  })
  .strict();

function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;

  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = Reflect.ownKeys(value).length === value.length + 1;
    for (let index = 0; valid && index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      valid =
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, 'value') &&
        isJsonValue(descriptor.value, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid =
      (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== 'string') return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor?.enumerable === true &&
          Object.hasOwn(descriptor, 'value') &&
          isJsonValue(descriptor.value, ancestors)
        );
      });
  }
  ancestors.delete(value);
  return valid;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isJsonValue, {
  message: 'Expected a finite JSON value.',
});

const RawEntrySchema: z.ZodType<RawEntry> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message'),
      anchor: RawAnchorSchema,
      role: z.enum(['assistant', 'user']),
      text: z.string(),
      message_id: NonemptyStringSchema.nullable(),
      claimed_origin: z.enum(['external', 'internal', 'unclaimed']),
      approval_eligibility: z.enum(['eligible', 'ineligible', 'unresolved']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('call'),
      anchor: RawAnchorSchema,
      call_id: NonemptyStringSchema,
      native_call_id: NonemptyStringSchema.nullable(),
      name: NonemptyStringSchema,
      payload: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      anchor: RawAnchorSchema,
      call_id: NonemptyStringSchema,
      call_anchor: RawAnchorSchema,
      payload: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('replay'),
      anchor: RawAnchorSchema,
      canonical_anchor: RawAnchorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('non_action'),
      anchor: RawAnchorSchema,
      record_type: NonemptyStringSchema,
    })
    .strict(),
]);

function compareAnchors(left: RawAnchor, right: RawAnchor): number {
  if (left.line !== right.line) return left.line - right.line;
  return (left.block ?? -1) - (right.block ?? -1);
}

function anchorKey(anchor: RawAnchor): string {
  return `${anchor.line}:${anchor.block === null ? 'row' : anchor.block}`;
}

function addIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

export const RawIndexSchema: z.ZodType<RawIndex> = z
  .object({
    schema_version: z.literal(2),
    source: RawSourceSchema,
    identity: SourceIdentitySchema,
    prefix: RawPrefixSchema,
    entries: z.array(RawEntrySchema),
  })
  .strict()
  .superRefine((index, context) => {
    const sourceId = index.source.source_id;
    if (index.prefix.source_id !== sourceId) {
      addIssue(
        context,
        ['prefix', 'source_id'],
        'Prefix source does not match.',
      );
    }

    for (const [evidenceIndex, evidence] of index.identity.evidence.entries()) {
      if (evidence.source_id !== sourceId) {
        addIssue(
          context,
          ['identity', 'evidence', evidenceIndex, 'source_id'],
          'Identity evidence source does not match.',
        );
      }
      if (evidence.line > index.prefix.after_line) {
        addIssue(
          context,
          ['identity', 'evidence', evidenceIndex, 'line'],
          'Identity evidence is outside the indexed prefix.',
        );
      }
    }

    const canonicalEntries = new Map<string, RawEntry>();
    let previousAnchor: RawAnchor | null = null;
    for (const [entryIndex, entry] of index.entries.entries()) {
      const path = ['entries', entryIndex] as Array<string | number>;
      if (entry.anchor.source_id !== sourceId) {
        addIssue(
          context,
          [...path, 'anchor', 'source_id'],
          'Entry source does not match.',
        );
      }
      if (entry.anchor.line > index.prefix.after_line) {
        addIssue(
          context,
          [...path, 'anchor', 'line'],
          'Entry is outside the indexed prefix.',
        );
      }
      if (
        previousAnchor !== null &&
        compareAnchors(previousAnchor, entry.anchor) >= 0
      ) {
        addIssue(
          context,
          [...path, 'anchor'],
          'Entry anchors must be unique and ordered.',
        );
      }

      if (
        entry.kind === 'message' &&
        entry.role === 'assistant' &&
        entry.approval_eligibility === 'eligible'
      ) {
        addIssue(
          context,
          [...path, 'approval_eligibility'],
          'Assistant messages cannot be eligible approvals.',
        );
      }

      if (entry.kind === 'result') {
        if (entry.call_anchor.source_id !== sourceId) {
          addIssue(
            context,
            [...path, 'call_anchor', 'source_id'],
            'Result link source does not match.',
          );
        }
        const call = canonicalEntries.get(anchorKey(entry.call_anchor));
        if (
          call?.kind !== 'call' ||
          call.call_id !== entry.call_id ||
          compareAnchors(entry.call_anchor, entry.anchor) >= 0
        ) {
          addIssue(
            context,
            [...path, 'call_anchor'],
            'Result must link to an earlier matching call.',
          );
        }
      }

      if (entry.kind === 'replay') {
        if (entry.canonical_anchor.source_id !== sourceId) {
          addIssue(
            context,
            [...path, 'canonical_anchor', 'source_id'],
            'Replay link source does not match.',
          );
        }
        const canonical = canonicalEntries.get(
          anchorKey(entry.canonical_anchor),
        );
        if (
          canonical === undefined ||
          canonical.kind === 'replay' ||
          compareAnchors(entry.canonical_anchor, entry.anchor) >= 0
        ) {
          addIssue(
            context,
            [...path, 'canonical_anchor'],
            'Replay must link directly to an earlier canonical entry.',
          );
        }
      } else {
        canonicalEntries.set(anchorKey(entry.anchor), entry);
      }

      previousAnchor = entry.anchor;
    }
  });
