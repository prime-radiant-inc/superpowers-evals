import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type JsonValue,
  ObserverEvidenceError,
  type RawAnchor,
  type RawSource,
} from './contracts.ts';
import { canonicalJson, parseCompleteJsonl, type RawRow } from './raw.ts';

export interface CodexTraceBundle {
  manifest: Uint8Array;
  trace: Uint8Array;
  payloads: ReadonlyMap<string, Uint8Array>;
}
export interface CodexTraceEvidence {
  member: string;
  line: number | null;
  sha256: string;
  payload: JsonValue;
}
export interface CodexTracePatchLink {
  inner_call_id: string;
  outer_call_id: string;
  runtime_cell_id: string;
  turn_id: string;
  patch_anchor: RawAnchor;
  call_anchor: RawAnchor;
  evidence: CodexTraceEvidence[];
}

const nonempty = z.string().min(1);
const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    trace_id: nonempty,
    rollout_id: nonempty,
    root_thread_id: nonempty,
    started_at_unix_ms: z.number().int().safe(),
    raw_event_log: z.literal('trace.jsonl'),
    payloads_dir: z.literal('payloads'),
  })
  .strict();
const EnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    seq: z.number().int().safe().positive(),
    wall_time_unix_ms: z.number().int().safe(),
    rollout_id: nonempty,
    thread_id: nonempty.nullable(),
    codex_turn_id: nonempty.nullable(),
    payload: z.object({ type: nonempty }).passthrough(),
  })
  .strict();
const RefSchema = z
  .object({
    raw_payload_id: nonempty,
    kind: z.object({ type: nonempty }).strict(),
    path: z.string().regex(/^payloads\/[A-Za-z0-9_-]+\.json$/),
  })
  .strict();
const RootSchema = z
  .object({
    type: z.literal('rollout_started'),
    trace_id: nonempty,
    root_thread_id: nonempty,
  })
  .strict();
const ThreadSchema = z
  .object({
    type: z.literal('thread_started'),
    thread_id: nonempty,
    agent_path: z.literal('/root'),
    metadata_payload: RefSchema,
  })
  .strict();
const TurnSchema = z
  .object({
    type: z.literal('codex_turn_started'),
    codex_turn_id: nonempty,
    thread_id: nonempty,
  })
  .strict();

type ObjectValue = { [key: string]: JsonValue };
function fail(message: string, anchor: RawAnchor | null = null): never {
  throw new ObserverEvidenceError('invalid_record', message, anchor);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    fail('Native trace shape is outside the inspected dialect.');
  return parsed.data;
}
function parseJson(raw: Uint8Array): ObjectValue {
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(raw),
    );
    if (
      !finiteJson(value) ||
      value === null ||
      Array.isArray(value) ||
      typeof value !== 'object'
    )
      fail('Native trace member must be a JSON object.');
    return value;
  } catch {
    fail('Native trace member is not complete finite JSON.');
  }
}
function finiteJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteJson);
  return typeof value === 'object' && Object.values(value).every(finiteJson);
}
function evidence(
  member: string,
  raw: Uint8Array,
  payload: JsonValue,
  line: number | null = null,
): CodexTraceEvidence {
  return {
    member,
    line,
    sha256: createHash('sha256').update(raw).digest('hex'),
    payload,
  };
}

/** Validate supplied authenticated members only; native paths are never opened. */
export function validateCodexTraceLinks(
  source: RawSource,
  ordinaryRaw: Uint8Array,
  bundle: CodexTraceBundle,
): CodexTracePatchLink[] {
  if (source.runtime !== 'codex' || source.expected_cli_version !== '0.146.0')
    fail('Native trace linkage requires the qualified Codex build.');
  const manifestValue = parseJson(bundle.manifest);
  const manifest = parse(ManifestSchema, manifestValue);
  if (manifest.root_thread_id !== source.expected_session_id)
    fail('Native trace root conflicts with the ordinary source.');
  const rows = parseCompleteJsonl(source, bundle.trace);
  const ordinary = parseCompleteJsonl(source, ordinaryRaw);
  const proofs = [evidence('manifest.json', bundle.manifest, manifestValue)];
  let rootSeen = false;
  let threadSeen = false;
  const turns = new Set<string>();
  const cellIds = new Set<string>();
  const modelIds = new Set<string>();
  const toolIds = new Set<string>();
  const runtimeIds = new Set<string>();
  const payloadIds = new Map<string, string>();
  const payloadPaths = new Map<string, string>();
  for (const [offset, row] of rows.entries()) {
    const env = parse(EnvelopeSchema, row.value);
    if (
      env.seq !== offset + 1 ||
      env.rollout_id !== manifest.rollout_id ||
      (env.thread_id !== null && env.thread_id !== source.expected_session_id)
    )
      fail(
        'Native trace envelope continuity or identity conflicts.',
        row.anchor,
      );
    const value = env.payload;
    for (const key of [
      'metadata_payload',
      'invocation_payload',
      'runtime_payload',
      'result_payload',
      'response_payload',
      'event_payload',
      'request_payload',
      'partial_response_payload',
      'checkpoint_payload',
      'carried_payload',
    ]) {
      const reference = value[key];
      if (reference === undefined || reference === null) continue;
      const ref = parse(RefSchema, reference);
      if (
        (payloadIds.has(ref.raw_payload_id) &&
          payloadIds.get(ref.raw_payload_id) !== ref.path) ||
        (payloadPaths.has(ref.path) &&
          payloadPaths.get(ref.path) !== ref.raw_payload_id)
      )
        fail('Native payload identifiers conflict.');
      payloadIds.set(ref.raw_payload_id, ref.path);
      payloadPaths.set(ref.path, ref.raw_payload_id);
    }
    if (value.type === 'code_cell_started') {
      const cell = parse(CellSchema, value);
      if (
        cellIds.has(cell.runtime_cell_id) ||
        modelIds.has(cell.model_visible_call_id)
      )
        fail('Native cell identifiers are duplicated.');
      cellIds.add(cell.runtime_cell_id);
      modelIds.add(cell.model_visible_call_id);
    }
    if (value.type === 'tool_call_started') {
      const id = parse(nonempty, value['tool_call_id']);
      if (toolIds.has(id)) fail('Native tool identifier is duplicated.');
      toolIds.add(id);
      const requester = object(value['requester'] as JsonValue);
      if (requester['type'] === 'code_cell') {
        const cellId = parse(nonempty, requester['runtime_cell_id']);
        const runtimeId = parse(nonempty, value['code_mode_runtime_tool_id']);
        const key = JSON.stringify([cellId, runtimeId]);
        if (runtimeIds.has(key))
          fail('Native cell-local tool identifier is duplicated.');
        runtimeIds.add(key);
      }
    }
    if (value.type === 'rollout_started') {
      const root = parse(RootSchema, value);
      if (
        rootSeen ||
        offset !== 0 ||
        root.trace_id !== manifest.trace_id ||
        root.root_thread_id !== manifest.root_thread_id ||
        env.thread_id !== null ||
        env.codex_turn_id !== null
      )
        fail(
          'Native trace root identity is missing, duplicated, or conflicting.',
          row.anchor,
        );
      rootSeen = true;
    } else if (value.type === 'thread_started') {
      const thread = parse(ThreadSchema, value);
      if (
        !rootSeen ||
        threadSeen ||
        thread.thread_id !== manifest.root_thread_id
      )
        fail(
          'Native trace thread identity is missing, duplicated, or conflicting.',
          row.anchor,
        );
      const ref = thread.metadata_payload;
      const raw = bundle.payloads.get(ref.path);
      if (ref.kind.type !== 'session_metadata' || raw === undefined)
        fail('Native thread metadata member is missing.');
      const metadata = parseJson(raw);
      const expected: ObjectValue = {
        thread_id: source.expected_session_id,
        cwd: source.expected_cwd,
        session_source: 'cli',
        agent_path: '/root',
        cli_version: source.expected_cli_version,
      };
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (
          (key !== 'cli_version' || Object.hasOwn(metadata, key)) &&
          metadata[key] !== expectedValue
        )
          fail('Native thread metadata conflicts with the ordinary source.');
      }
      proofs.push(evidence(ref.path, raw, metadata));
      threadSeen = true;
    } else if (value.type === 'codex_turn_started') {
      const turn = parse(TurnSchema, value);
      if (
        !threadSeen ||
        turns.has(turn.codex_turn_id) ||
        turn.thread_id !== source.expected_session_id ||
        env.thread_id !== turn.thread_id ||
        env.codex_turn_id !== turn.codex_turn_id
      )
        fail(
          'Native turn identity is missing, duplicated, or conflicting.',
          row.anchor,
        );
      turns.add(turn.codex_turn_id);
    }
    if (env.codex_turn_id !== null && !turns.has(env.codex_turn_id))
      fail('Native trace refers to an unestablished turn.', row.anchor);
  }
  if (!rootSeen || !threadSeen)
    fail('Native trace root metadata is incomplete.');
  return patchLinks(source, ordinary, rows, bundle, proofs);
}

const ChangesSchema = z.record(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('add'), content: z.string() }).strict(),
    z.object({ type: z.literal('delete'), content: z.string() }).strict(),
    z
      .object({
        type: z.literal('update'),
        unified_diff: z.string(),
        move_path: z.string().nullable(),
      })
      .strict(),
  ]),
);
const PatchRuntimeSchema = z
  .object({
    call_id: nonempty,
    turn_id: nonempty,
    stdout: z.string(),
    stderr: z.string(),
    success: z.boolean(),
    changes: ChangesSchema,
    status: z.enum(['completed', 'failed', 'declined']),
  })
  .strict();
export const NativePatchApplyEndSchema = PatchRuntimeSchema.extend({
  type: z.literal('patch_apply_end'),
})
  .strict()
  .refine((value) => value.success === (value.status === 'completed'));
const CellSchema = z
  .object({
    type: z.literal('code_cell_started'),
    runtime_cell_id: nonempty,
    model_visible_call_id: nonempty,
    source_js: z.string(),
  })
  .strict();
const ToolSchema = z
  .object({
    type: z.literal('tool_call_started'),
    tool_call_id: nonempty,
    model_visible_call_id: z.null(),
    code_mode_runtime_tool_id: nonempty,
    requester: z
      .object({ type: z.literal('code_cell'), runtime_cell_id: nonempty })
      .strict(),
    kind: z.object({ type: z.literal('apply_patch') }).strict(),
    summary: z
      .object({
        type: z.literal('generic'),
        label: z.literal('apply_patch'),
        input_preview: z.string().nullable(),
        output_preview: z.null(),
      })
      .strict(),
    invocation_payload: RefSchema,
  })
  .strict();
const RuntimeStartSchema = z
  .object({
    type: z.literal('tool_call_runtime_started'),
    tool_call_id: nonempty,
    runtime_payload: RefSchema,
  })
  .strict();
const RuntimeEndSchema = z
  .object({
    type: z.literal('tool_call_runtime_ended'),
    tool_call_id: nonempty,
    status: z.enum(['completed', 'failed']),
    runtime_payload: RefSchema,
  })
  .strict();
const ToolEndSchema = z
  .object({
    type: z.literal('tool_call_ended'),
    tool_call_id: nonempty,
    status: z.enum(['completed', 'failed']),
    result_payload: RefSchema,
  })
  .strict();
const PatchBeginSchema = z
  .object({
    call_id: nonempty,
    turn_id: nonempty,
    auto_approved: z.boolean(),
    changes: ChangesSchema,
  })
  .strict();
const InvocationSchema = z
  .object({
    tool_name: z.literal('apply_patch'),
    tool_namespace: z.null(),
    payload: z
      .object({ type: z.literal('custom'), input: z.string() })
      .strict(),
  })
  .strict();
const ResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('error'), error: z.string() }).strict(),
  z
    .object({
      type: z.literal('code_mode_response'),
      value: z.object({}).strict(),
    })
    .strict(),
]);

function object(value: JsonValue | undefined): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('Expected a native trace object.');
  return value;
}
function patchLinks(
  source: RawSource,
  ordinary: RawRow[],
  rows: RawRow[],
  bundle: CodexTraceBundle,
  identityProofs: CodexTraceEvidence[],
): CodexTracePatchLink[] {
  const links: CodexTracePatchLink[] = [];
  const patches = new Set<string>();
  const calls = ordinary.filter(
    (row) =>
      row.value['type'] === 'response_item' &&
      ['custom_tool_call', 'function_call'].includes(
        String(object(row.value['payload'])['type']),
      ),
  );
  const one = (type: string, field: string, id: string): RawRow => {
    const matched = rows.filter((row) => {
      const payload = object(row.value['payload']);
      return payload['type'] === type && payload[field] === id;
    });
    const match = matched[0];
    if (matched.length !== 1 || match === undefined)
      fail('Required native trace edge is missing or duplicated.');
    return match;
  };
  for (const ordinaryRow of ordinary) {
    if (ordinaryRow.value['type'] !== 'event_msg') continue;
    const ordinaryPayload = object(ordinaryRow.value['payload']);
    if (ordinaryPayload['type'] !== 'patch_apply_end') continue;
    const patch = parse(NativePatchApplyEndSchema, ordinaryPayload);
    if (patches.has(patch.call_id))
      fail('Ordinary patch ID is duplicated.', ordinaryRow.anchor);
    patches.add(patch.call_id);
    const direct = calls.filter(
      (row) => object(row.value['payload'])['call_id'] === patch.call_id,
    );
    if (
      direct.length === 1 &&
      object(direct[0]?.value['payload'])['name'] === 'apply_patch'
    )
      continue;
    if (direct.length !== 0)
      fail('Patch ID conflicts with an ordinary call.', ordinaryRow.anchor);
    const toolRow = one('tool_call_started', 'tool_call_id', patch.call_id);
    const tool = parse(ToolSchema, toolRow.value['payload']);
    const cellRow = one(
      'code_cell_started',
      'runtime_cell_id',
      tool.requester.runtime_cell_id,
    );
    const cell = parse(CellSchema, cellRow.value['payload']);
    const beginRow = one(
      'tool_call_runtime_started',
      'tool_call_id',
      patch.call_id,
    );
    const begin = parse(RuntimeStartSchema, beginRow.value['payload']);
    const runtimeRow = one(
      'tool_call_runtime_ended',
      'tool_call_id',
      patch.call_id,
    );
    const runtime = parse(RuntimeEndSchema, runtimeRow.value['payload']);
    const endRow = one('tool_call_ended', 'tool_call_id', patch.call_id);
    const end = parse(ToolEndSchema, endRow.value['payload']);
    const joined = [cellRow, toolRow, beginRow, runtimeRow, endRow];
    let sequence = 0;
    for (const row of joined) {
      const env = parse(EnvelopeSchema, row.value);
      if (
        env.thread_id !== source.expected_session_id ||
        env.codex_turn_id !== patch.turn_id ||
        env.seq <= sequence
      )
        fail(
          'Native patch edges cross identities or lifecycle order.',
          row.anchor,
        );
      sequence = env.seq;
    }
    const outerRows = calls.filter(
      (row) =>
        object(row.value['payload'])['call_id'] === cell.model_visible_call_id,
    );
    const outerRow = outerRows[0];
    if (outerRows.length !== 1 || outerRow === undefined)
      fail('Native cell has no unique ordinary exec call.');
    const outer = object(outerRow.value['payload']);
    if (
      outer['type'] !== 'custom_tool_call' ||
      outer['name'] !== 'exec' ||
      outer['input'] !== cell.source_js ||
      outerRow.anchor.line >= ordinaryRow.anchor.line
    )
      fail(
        'Native cell source does not agree with the ordinary exec call.',
        outerRow.anchor,
      );
    const outerTurn = object(
      outer['internal_chat_message_metadata_passthrough'],
    )['turn_id'];
    if (outerTurn !== patch.turn_id)
      fail('Ordinary exec and native patch turn conflict.', outerRow.anchor);
    const proof = [
      ...identityProofs,
      ...joined.map((row) =>
        evidence('trace.jsonl', bundle.trace, row.value, row.anchor.line),
      ),
    ];
    const readMember = (
      value: z.infer<typeof RefSchema>,
      kind: string,
    ): ObjectValue => {
      const raw = bundle.payloads.get(value.path);
      if (raw === undefined || value.kind.type !== kind)
        fail(
          'Required native payload member is missing or has the wrong kind.',
        );
      const payload = parseJson(raw);
      proof.push(evidence(value.path, raw, payload));
      return payload;
    };
    parse(
      InvocationSchema,
      readMember(tool.invocation_payload, 'tool_invocation'),
    );
    const begun = parse(
      PatchBeginSchema,
      readMember(begin.runtime_payload, 'tool_runtime_event'),
    );
    const endedValue = readMember(
      runtime.runtime_payload,
      'tool_runtime_event',
    );
    const ended = parse(PatchRuntimeSchema, endedValue);
    const { type: _type, ...ordinaryRuntime } = patch;
    if (
      canonicalJson(endedValue) !== canonicalJson(ordinaryRuntime) ||
      begun.call_id !== patch.call_id ||
      begun.turn_id !== patch.turn_id ||
      canonicalJson(begun.changes) !== canonicalJson(ended.changes)
    )
      fail(
        'Native runtime patch disagrees with the ordinary patch event.',
        ordinaryRow.anchor,
      );
    const result = parse(
      ResultSchema,
      readMember(end.result_payload, 'tool_result'),
    );
    const expectedStatus = patch.success ? 'completed' : 'failed';
    if (
      runtime.status !== expectedStatus ||
      end.status !== expectedStatus ||
      (result.type === 'error') !== !patch.success
    )
      fail(
        'Native patch runtime and dispatch outcomes conflict.',
        ordinaryRow.anchor,
      );
    links.push({
      inner_call_id: patch.call_id,
      outer_call_id: cell.model_visible_call_id,
      runtime_cell_id: cell.runtime_cell_id,
      turn_id: patch.turn_id,
      patch_anchor: ordinaryRow.anchor,
      call_anchor: outerRow.anchor,
      evidence: proof,
    });
  }
  return links;
}
