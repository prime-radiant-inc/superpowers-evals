import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type JsonValue,
  ObserverEvidenceError,
  type RawAnchor,
  type RawEntry,
  type RawIndex,
  RawIndexSchema,
  type RawSource,
  type SourceIdentity,
} from './contracts.ts';
import { canonicalJson, parseCompleteJsonl } from './raw.ts';

type JsonObject = { [key: string]: JsonValue };

interface ReplayRecord {
  payload: string;
  anchors: RawAnchor[];
}

interface CallRecord {
  callId: string;
  anchor: RawAnchor;
  payload: string;
}

interface IdentityState {
  sessionId: string | null;
  cwd: string | null;
  cliVersion: string | null;
  source: JsonValue | undefined;
  evidence: RawAnchor[];
}

function fail(
  code: ObserverEvidenceError['code'],
  message: string,
  anchor: RawAnchor,
): never {
  throw new ObserverEvidenceError(code, message, anchor);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteJson(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isFiniteJson);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isFiniteJson);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

function requireObject(
  value: JsonValue | undefined,
  anchor: RawAnchor,
  description: string,
): JsonObject {
  if (value === undefined || !isJsonObject(value)) {
    fail('invalid_record', `${description} must be an object.`, anchor);
  }
  return value;
}

function requireNonemptyString(
  value: JsonValue | undefined,
  anchor: RawAnchor,
  description: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_record', `${description} must be a nonempty string.`, anchor);
  }
  return value;
}

function optionalNonemptyString(
  object: JsonObject,
  key: string,
  anchor: RawAnchor,
): string | undefined {
  if (!hasOwn(object, key)) return undefined;
  return requireNonemptyString(object[key], anchor, key);
}

function blockAnchor(anchor: RawAnchor, block: number): RawAnchor {
  return { ...anchor, block };
}

function observerCallId(anchor: RawAnchor, nativeId: string | null): string {
  return nativeId === null
    ? `anchor:${JSON.stringify([anchor.source_id, anchor.line, anchor.block])}`
    : `native:${nativeId}`;
}

function conversationFor(state: IdentityState): SourceIdentity['conversation'] {
  const source = state.source;
  if (
    source !== undefined &&
    isJsonObject(source) &&
    hasOwn(source, 'subagent')
  ) {
    return 'descendant';
  }
  if (
    state.source === 'cli' &&
    state.sessionId !== null &&
    state.cwd !== null &&
    state.cliVersion !== null
  ) {
    return 'parent';
  }
  return 'unresolved';
}

function establishIdentity(
  state: IdentityState,
  field: 'sessionId' | 'cwd' | 'cliVersion',
  value: string | undefined,
  expected: string,
  anchor: RawAnchor,
): void {
  if (value === undefined) return;
  if (value !== expected || (state[field] !== null && state[field] !== value)) {
    fail(
      'identity_conflict',
      'Session metadata conflicts with the supplied source identity.',
      anchor,
    );
  }
  state[field] = value;
}

function indexMetadata(
  payloadValue: JsonValue | undefined,
  state: IdentityState,
  source: RawSource,
  anchor: RawAnchor,
): RawEntry {
  const payload = requireObject(payloadValue, anchor, 'session_meta payload');
  const id = optionalNonemptyString(payload, 'id', anchor);
  const sessionId = optionalNonemptyString(payload, 'session_id', anchor);
  if (id !== undefined && sessionId !== undefined && id !== sessionId) {
    fail(
      'identity_conflict',
      'Session metadata contains conflicting session identifiers.',
      anchor,
    );
  }

  establishIdentity(
    state,
    'sessionId',
    id ?? sessionId,
    source.expected_session_id,
    anchor,
  );
  establishIdentity(
    state,
    'cwd',
    optionalNonemptyString(payload, 'cwd', anchor),
    source.expected_cwd,
    anchor,
  );
  establishIdentity(
    state,
    'cliVersion',
    optionalNonemptyString(payload, 'cli_version', anchor),
    source.expected_cli_version,
    anchor,
  );

  if (hasOwn(payload, 'source')) {
    const sourceValue = payload['source'];
    if (sourceValue === undefined) {
      fail('invalid_record', 'Session source must be JSON data.', anchor);
    }
    if (
      state.source !== undefined &&
      canonicalJson(state.source) !== canonicalJson(sourceValue)
    ) {
      fail(
        'identity_conflict',
        'Session metadata changes the established source identity.',
        anchor,
      );
    }
    state.source = sourceValue;
  }
  state.evidence.push(anchor);
  return { kind: 'non_action', anchor, record_type: 'session_meta' };
}

function validateObjectArguments(payload: JsonObject, anchor: RawAnchor): void {
  if (!hasOwn(payload, 'arguments')) {
    fail('invalid_record', 'Call arguments are required.', anchor);
  }
  const argumentsValue = payload['arguments'];
  if (argumentsValue !== undefined && isJsonObject(argumentsValue)) return;
  if (typeof argumentsValue !== 'string') {
    fail(
      'invalid_record',
      'Call arguments must describe a JSON object.',
      anchor,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(argumentsValue);
  } catch {
    fail('invalid_record', 'Call arguments are not valid JSON.', anchor);
  }
  if (!isFiniteJson(decoded) || !isJsonObject(decoded)) {
    fail(
      'invalid_record',
      'Call arguments must describe a JSON object.',
      anchor,
    );
  }
}

function callShape(
  payload: JsonObject,
  anchor: RawAnchor,
): { name: string; nativeId: string | null } {
  const type = payload['type'];
  if (type === 'function_call') {
    const name = requireNonemptyString(payload['name'], anchor, 'Call name');
    const nativeId = requireNonemptyString(
      payload['call_id'],
      anchor,
      'Call ID',
    );
    validateObjectArguments(payload, anchor);
    return { name, nativeId };
  }
  if (type === 'custom_tool_call') {
    const name = requireNonemptyString(payload['name'], anchor, 'Call name');
    const nativeId = requireNonemptyString(
      payload['call_id'],
      anchor,
      'Call ID',
    );
    if (typeof payload['input'] !== 'string') {
      fail('invalid_record', 'Custom tool input must be a string.', anchor);
    }
    return { name, nativeId };
  }
  if (type === 'local_shell_call') {
    const action = requireObject(
      payload['action'],
      anchor,
      'Local shell action',
    );
    const command = action['command'];
    if (
      !Array.isArray(command) ||
      !command.every((part) => typeof part === 'string')
    ) {
      fail(
        'invalid_record',
        'Local shell command must be an array of strings.',
        anchor,
      );
    }
    return {
      name: type,
      nativeId: optionalNonemptyString(payload, 'call_id', anchor) ?? null,
    };
  }
  if (type === 'web_search_call') {
    const action = requireObject(
      payload['action'],
      anchor,
      'Web search action',
    );
    requireNonemptyString(action['type'], anchor, 'Web search action type');
    return {
      name: type,
      nativeId: optionalNonemptyString(payload, 'call_id', anchor) ?? null,
    };
  }
  if (type === 'tool_search_call') {
    const nativeId = requireNonemptyString(
      payload['call_id'],
      anchor,
      'Call ID',
    );
    validateObjectArguments(payload, anchor);
    return { name: type, nativeId };
  }
  fail('unknown_record', 'Response item type is not recognized.', anchor);
}

function indexCall(
  payload: JsonObject,
  anchor: RawAnchor,
  calls: Map<string, CallRecord>,
): RawEntry {
  const { name, nativeId } = callShape(payload, anchor);
  const callId = observerCallId(anchor, nativeId);
  const serialized = canonicalJson(payload);
  if (nativeId !== null) {
    const existing = calls.get(nativeId);
    if (existing !== undefined) {
      if (existing.payload !== serialized) {
        fail(
          'replay_conflict',
          'Native call ID was reused with a different payload.',
          anchor,
        );
      }
      return {
        kind: 'replay',
        anchor,
        canonical_anchor: existing.anchor,
      };
    }
    calls.set(nativeId, { callId, anchor, payload: serialized });
  }
  return {
    kind: 'call',
    anchor,
    call_id: callId,
    native_call_id: nativeId,
    name,
    payload,
  };
}

function resultNativeId(payload: JsonObject, anchor: RawAnchor): string {
  const type = payload['type'];
  const nativeId = requireNonemptyString(
    payload['call_id'],
    anchor,
    'Result call ID',
  );
  if (type === 'tool_search_output') {
    if (!hasOwn(payload, 'tools')) {
      fail('invalid_record', 'Tool search results are required.', anchor);
    }
  } else if (
    type === 'function_call_output' ||
    type === 'custom_tool_call_output'
  ) {
    if (!hasOwn(payload, 'output')) {
      fail('invalid_record', 'Call output is required.', anchor);
    }
  } else {
    fail('unknown_record', 'Response item type is not recognized.', anchor);
  }
  return nativeId;
}

function indexResult(
  payload: JsonObject,
  anchor: RawAnchor,
  calls: Map<string, CallRecord>,
  results: Map<string, ReplayRecord>,
): RawEntry {
  const nativeId = resultNativeId(payload, anchor);
  const call = calls.get(nativeId);
  if (call === undefined) {
    fail('orphan_result', 'Result does not have an earlier call.', anchor);
  }

  const serialized = canonicalJson(payload);
  const existing = results.get(nativeId);
  if (existing !== undefined) {
    if (existing.payload !== serialized) {
      fail(
        'replay_conflict',
        'Native result ID was reused with a different payload.',
        anchor,
      );
    }
    const canonicalAnchor = existing.anchors[0];
    if (canonicalAnchor === undefined) {
      throw new Error('Canonical result anchor is missing.');
    }
    return { kind: 'replay', anchor, canonical_anchor: canonicalAnchor };
  }
  results.set(nativeId, { payload: serialized, anchors: [anchor] });
  return {
    kind: 'result',
    anchor,
    call_id: call.callId,
    call_anchor: call.anchor,
    payload,
  };
}

function messageRole(
  payload: JsonObject,
  anchor: RawAnchor,
): 'assistant' | 'developer' | 'system' | 'user' {
  const role = payload['role'];
  if (typeof role !== 'string' || role.length === 0) {
    fail('invalid_record', 'Message role is required.', anchor);
  }
  if (
    role !== 'assistant' &&
    role !== 'developer' &&
    role !== 'system' &&
    role !== 'user'
  ) {
    fail('unknown_record', 'Message role is not recognized.', anchor);
  }
  return role;
}

function indexMessageBlocks(
  payload: JsonObject,
  anchor: RawAnchor,
  role: ReturnType<typeof messageRole>,
  messageId: string | null,
  conversation: SourceIdentity['conversation'],
): RawEntry[] {
  const content = payload['content'];
  if (!Array.isArray(content)) {
    fail('invalid_record', 'Message content must be an array.', anchor);
  }
  if (content.length === 0) {
    if (role !== 'assistant' && role !== 'user') {
      fail(
        'invalid_record',
        'Non-action text message cannot be empty.',
        anchor,
      );
    }
    return [{ kind: 'non_action', anchor, record_type: `${role}.empty` }];
  }

  return content.map((value, block) => {
    const currentAnchor = blockAnchor(anchor, block);
    const item = requireObject(value, currentAnchor, 'Message content block');
    const type = item['type'];
    if (typeof type !== 'string' || type.length === 0) {
      fail('invalid_record', 'Message block type is required.', currentAnchor);
    }
    if (type !== 'input_text' && type !== 'output_text') {
      fail(
        'unknown_record',
        'Message block type is not recognized.',
        currentAnchor,
      );
    }
    if (
      (role === 'user' && type !== 'input_text') ||
      (role === 'assistant' && type !== 'output_text')
    ) {
      fail(
        'unknown_record',
        'Message block does not match its role.',
        currentAnchor,
      );
    }
    const text = item['text'];
    if (typeof text !== 'string') {
      fail(
        'invalid_record',
        'Message block text must be a string.',
        currentAnchor,
      );
    }

    if (role === 'system' || role === 'developer') {
      return {
        kind: 'non_action' as const,
        anchor: currentAnchor,
        record_type: `message.${role}.${type}`,
      };
    }
    if (role === 'assistant') {
      return {
        kind: 'message' as const,
        anchor: currentAnchor,
        role,
        text,
        message_id: messageId,
        claimed_origin: 'internal' as const,
        approval_eligibility: 'ineligible' as const,
      };
    }
    if (conversation === 'parent') {
      return {
        kind: 'message' as const,
        anchor: currentAnchor,
        role,
        text,
        message_id: messageId,
        claimed_origin: 'external' as const,
        approval_eligibility: 'eligible' as const,
      };
    }
    if (conversation === 'descendant') {
      return {
        kind: 'message' as const,
        anchor: currentAnchor,
        role,
        text,
        message_id: messageId,
        claimed_origin: 'internal' as const,
        approval_eligibility: 'ineligible' as const,
      };
    }
    return {
      kind: 'message' as const,
      anchor: currentAnchor,
      role,
      text,
      message_id: messageId,
      claimed_origin: 'unclaimed' as const,
      approval_eligibility: 'unresolved' as const,
    };
  });
}

function indexMessage(
  payload: JsonObject,
  anchor: RawAnchor,
  identity: IdentityState,
  messages: Map<string, ReplayRecord>,
): RawEntry[] {
  const messageId = optionalNonemptyString(payload, 'id', anchor) ?? null;
  const serialized = canonicalJson(payload);
  if (messageId !== null) {
    const existing = messages.get(messageId);
    if (existing !== undefined) {
      if (existing.payload !== serialized) {
        fail(
          'replay_conflict',
          'Message ID was reused with a different payload.',
          anchor,
        );
      }
      return existing.anchors.map((canonicalAnchor) => ({
        kind: 'replay',
        anchor:
          canonicalAnchor.block === null
            ? anchor
            : blockAnchor(anchor, canonicalAnchor.block),
        canonical_anchor: canonicalAnchor,
      }));
    }
  }

  const entries = indexMessageBlocks(
    payload,
    anchor,
    messageRole(payload, anchor),
    messageId,
    conversationFor(identity),
  );
  if (messageId !== null) {
    messages.set(messageId, {
      payload: serialized,
      anchors: entries.map((entry) => entry.anchor),
    });
  }
  return entries;
}

function indexResponseItem(
  payloadValue: JsonValue | undefined,
  anchor: RawAnchor,
  identity: IdentityState,
  calls: Map<string, CallRecord>,
  results: Map<string, ReplayRecord>,
  messages: Map<string, ReplayRecord>,
): RawEntry[] {
  const payload = requireObject(payloadValue, anchor, 'response_item payload');
  const type = payload['type'];
  if (typeof type !== 'string' || type.length === 0) {
    fail('invalid_record', 'Response item type is required.', anchor);
  }
  if (type === 'message') {
    return indexMessage(payload, anchor, identity, messages);
  }
  if (
    type === 'function_call' ||
    type === 'custom_tool_call' ||
    type === 'local_shell_call' ||
    type === 'web_search_call' ||
    type === 'tool_search_call'
  ) {
    return [indexCall(payload, anchor, calls)];
  }
  if (
    type === 'function_call_output' ||
    type === 'custom_tool_call_output' ||
    type === 'tool_search_output'
  ) {
    return [indexResult(payload, anchor, calls, results)];
  }
  fail('unknown_record', 'Response item type is not recognized.', anchor);
}

// Closed metadata shapes inspected in codex-56-exec.slice.jsonl (0.144.3).
// Unknown fields are evidence gaps, never an implicit non-action escape hatch.
const TurnContextSchema = z
  .object({
    turn_id: z.string().min(1),
    cwd: z.string().min(1),
    workspace_roots: z.array(z.string()),
    current_date: z.string(),
    timezone: z.string(),
    approval_policy: z.literal('never'),
    approvals_reviewer: z.literal('user'),
    sandbox_policy: z
      .object({ type: z.literal('danger-full-access') })
      .strict(),
    permission_profile: z.object({ type: z.literal('disabled') }).strict(),
    model: z.string(),
    comp_hash: z.string(),
    personality: z.string(),
    collaboration_mode: z
      .object({
        mode: z.literal('default'),
        settings: z
          .object({
            model: z.string(),
            reasoning_effort: z.string().nullable(),
            developer_instructions: z.string(),
          })
          .strict(),
      })
      .strict(),
    multi_agent_version: z.literal('v2'),
    multi_agent_mode: z.literal('explicitRequestOnly'),
    realtime_active: z.boolean(),
    summary: z.string(),
  })
  .strict();
// Native 0.146.0 event telemetry duplicates messages or records turn status.
// It grants no approval or tool authority.
const NativeEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('agent_message'),
      message: z.string(),
      phase: z.null(),
      memory_citation: z.null(),
    })
    .strict(),
  z
    .object({
      type: z.literal('task_started'),
      turn_id: z.string().min(1),
      started_at: z.number().int().nonnegative(),
      model_context_window: z.number().int().positive(),
      collaboration_mode_kind: z.literal('default'),
    })
    .strict(),
  z
    .object({
      type: z.literal('user_message'),
      message: z.string(),
      images: z.tuple([]),
      local_images: z.tuple([]),
      audio: z.tuple([]),
      local_audio: z.tuple([]),
      text_elements: z.tuple([]),
    })
    .strict(),
  z
    .object({
      type: z.literal('task_complete'),
      turn_id: z.string().min(1),
      last_agent_message: z.string().nullable(),
      error: z
        .object({ message: z.string(), codex_error_info: z.literal('other') })
        .strict()
        .optional(),
      started_at: z.number().int().nonnegative(),
      completed_at: z.number().int().nonnegative(),
      duration_ms: z.number().int().nonnegative(),
      time_to_first_token_ms: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    reasoning_output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .strict();
const TokenCountSchema = z
  .object({
    type: z.literal('token_count'),
    info: z
      .object({
        total_token_usage: UsageSchema,
        last_token_usage: UsageSchema,
        model_context_window: z.number().int().positive(),
      })
      .strict(),
    rate_limits: z
      .object({
        limit_id: z.string(),
        limit_name: z.null(),
        primary: z.null(),
        secondary: z.null(),
        credits: z.null(),
        individual_limit: z.null(),
        plan_type: z.null(),
        rate_limit_reached_type: z.null(),
      })
      .strict(),
  })
  .strict();
const NativeUsageSchema = UsageSchema.extend({
  cache_write_input_tokens: z.number().int().nonnegative(),
}).strict();
const NativeTokenCountSchema = TokenCountSchema.extend({
  info: TokenCountSchema.shape.info
    .extend({
      total_token_usage: NativeUsageSchema,
      last_token_usage: NativeUsageSchema,
    })
    .strict(),
  rate_limits: TokenCountSchema.shape.rate_limits
    .extend({ spend_control_reached: z.null() })
    .strict(),
}).strict();
/** Context records describe settings; only physical response items describe actions. */
function checkContextIdentity(
  context: JsonObject,
  source: RawSource,
  anchor: RawAnchor,
): void {
  const expected: Record<string, string> = {
    cwd: source.expected_cwd,
    session_id: source.expected_session_id,
    sessionId: source.expected_session_id,
    thread_id: source.expected_session_id,
    cli_version: source.expected_cli_version,
    originator: 'codex-tui',
    thread_source: 'user',
    source: 'cli',
  };
  for (const [field, value] of Object.entries(expected)) {
    if (hasOwn(context, field) && context[field] !== value)
      fail(
        'identity_conflict',
        'Context conflicts with the bound source identity.',
        anchor,
      );
  }
}

function indexContext(
  value: JsonValue | undefined,
  source: RawSource,
  anchor: RawAnchor,
): RawEntry {
  if (source.expected_cli_version === '0.146.0') {
    const context = requireObject(value, anchor, 'Turn context');
    requireNonemptyString(context['cwd'], anchor, 'Turn context cwd');
    checkContextIdentity(context, source, anchor);
  } else {
    const parsed = TurnContextSchema.safeParse(value);
    if (!parsed.success)
      fail(
        'unknown_record',
        'Turn context shape is outside the inspected dialect.',
        anchor,
      );
    if (parsed.data.cwd !== source.expected_cwd)
      fail(
        'identity_conflict',
        'Turn context cwd conflicts with the bound launch cwd.',
        anchor,
      );
  }
  return { kind: 'non_action', anchor, record_type: 'turn_context' };
}

function indexWorldState(
  value: JsonValue | undefined,
  source: RawSource,
  anchor: RawAnchor,
): RawEntry {
  const payload = requireObject(value, anchor, 'World state payload');
  if (typeof payload['full'] !== 'boolean')
    fail(
      'invalid_record',
      'World state must declare full or partial state.',
      anchor,
    );
  const state = requireObject(payload['state'], anchor, 'World state');
  checkContextIdentity(payload, source, anchor);
  checkContextIdentity(state, source, anchor);
  // Partial state updates may omit environments. A supplied local cwd must agree.
  if (hasOwn(state, 'environments')) {
    const environments = requireObject(
      state['environments'],
      anchor,
      'World environments',
    );
    if (hasOwn(environments, 'environments')) {
      const entries = requireObject(
        environments['environments'],
        anchor,
        'World environment entries',
      );
      if (hasOwn(entries, 'local'))
        checkContextIdentity(
          requireObject(entries['local'], anchor, 'Local environment'),
          source,
          anchor,
        );
    }
  }
  return { kind: 'non_action', anchor, record_type: 'world_state' };
}

export function indexCodexTranscript(
  source: RawSource,
  raw: Uint8Array,
): RawIndex {
  if (source.runtime !== 'codex') {
    throw new ObserverEvidenceError(
      'invalid_source',
      'Codex observer requires a Codex source.',
    );
  }
  const rows = parseCompleteJsonl(source, raw);
  const identity: IdentityState = {
    sessionId: null,
    cwd: null,
    cliVersion: null,
    source: undefined,
    evidence: [],
  };
  const calls = new Map<string, CallRecord>();
  const results = new Map<string, ReplayRecord>();
  const messages = new Map<string, ReplayRecord>();
  const entries: RawEntry[] = [];

  for (const row of rows) {
    const type = row.value['type'];
    if (typeof type !== 'string' || type.length === 0) {
      fail('invalid_record', 'Record type is required.', row.anchor);
    }
    if (type === 'session_meta') {
      entries.push(
        indexMetadata(row.value['payload'], identity, source, row.anchor),
      );
      continue;
    }
    if (type === 'turn_context') {
      entries.push(indexContext(row.value['payload'], source, row.anchor));
      continue;
    }
    if (type === 'world_state' && source.expected_cli_version === '0.146.0') {
      entries.push(indexWorldState(row.value['payload'], source, row.anchor));
      continue;
    }
    if (type === 'event_msg') {
      const native =
        source.expected_cli_version === '0.146.0'
          ? NativeEventSchema.safeParse(row.value['payload'])
          : null;
      if (
        !native?.success &&
        !(
          source.expected_cli_version === '0.146.0'
            ? NativeTokenCountSchema
            : TokenCountSchema
        ).safeParse(row.value['payload']).success
      )
        fail(
          'unknown_record',
          'Event shape is outside the inspected dialect.',
          row.anchor,
        );
      entries.push({
        kind: 'non_action',
        anchor: row.anchor,
        record_type: `event_msg.${native?.success ? native.data.type : 'token_count'}`,
      });
      continue;
    }
    if (type === 'response_item') {
      entries.push(
        ...indexResponseItem(
          row.value['payload'],
          row.anchor,
          identity,
          calls,
          results,
          messages,
        ),
      );
      continue;
    }
    fail('unknown_record', 'Record type is not recognized.', row.anchor);
  }

  return RawIndexSchema.parse({
    schema_version: 2,
    source,
    identity: {
      session_id: identity.sessionId,
      cwd: identity.cwd,
      cli_version: identity.cliVersion,
      conversation: conversationFor(identity),
      evidence: identity.evidence,
    },
    prefix: {
      source_id: source.source_id,
      bytes: raw.byteLength,
      sha256: createHash('sha256').update(raw).digest('hex'),
      after_line: rows.length,
    },
    entries,
  });
}
