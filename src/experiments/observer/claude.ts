import { createHash } from 'node:crypto';
import {
  type JsonValue,
  ObserverEvidenceError,
  type RawAnchor,
  type RawEntry,
  type RawIndex,
  RawIndexSchema,
  type RawSource,
} from './contracts.ts';
import { canonicalJson, parseCompleteJsonl } from './raw.ts';

type JsonObject = { [key: string]: JsonValue };

interface ReplayTarget {
  block: number | null;
  canonical_anchor: RawAnchor;
}

interface SeenUuid {
  canonical_row: string;
  targets: ReplayTarget[];
}

interface SeenPayload {
  canonical_payload: string;
  anchor: RawAnchor;
}

function anchorAt(
  sourceId: string,
  line: number,
  block: number | null,
): RawAnchor {
  return { source_id: sourceId, line, block };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidRecord(message: string, anchor: RawAnchor): never {
  throw new ObserverEvidenceError('invalid_record', message, anchor);
}

function unknownRecord(message: string, anchor: RawAnchor): never {
  throw new ObserverEvidenceError('unknown_record', message, anchor);
}

function readMessage(
  row: JsonObject,
  expectedRole: 'assistant' | 'user',
  anchor: RawAnchor,
): JsonObject {
  const message = row['message'];
  if (!isObject(message) || message['role'] !== expectedRole) {
    return invalidRecord('Claude message record is malformed.', anchor);
  }
  return message;
}

function messageId(message: JsonObject, anchor: RawAnchor): string | null {
  const value = message['id'];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    return invalidRecord('Claude message ID is malformed.', anchor);
  }
  return value;
}

function contentBlocks(
  message: JsonObject,
  anchor: RawAnchor,
): JsonObject[] | string {
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return invalidRecord('Claude message content is malformed.', anchor);
  }
  return content.map((block) => {
    if (!isObject(block)) {
      return invalidRecord('Claude message block is malformed.', anchor);
    }
    return block;
  });
}

function textEntry(
  anchor: RawAnchor,
  role: 'assistant' | 'user',
  text: string,
  id: string | null,
  row: JsonObject,
  descendant: boolean,
): RawEntry {
  if (role === 'assistant') {
    return {
      kind: 'message',
      anchor,
      role,
      text,
      message_id: id,
      claimed_origin: 'internal',
      approval_eligibility: 'ineligible',
    };
  }

  const userType = row['userType'];
  if (userType === 'internal') {
    return {
      kind: 'message',
      anchor,
      role,
      text,
      message_id: id,
      claimed_origin: 'internal',
      approval_eligibility: 'ineligible',
    };
  }
  return {
    kind: 'message',
    anchor,
    role,
    text,
    message_id: id,
    claimed_origin: userType === 'external' ? 'external' : 'unclaimed',
    approval_eligibility: descendant ? 'ineligible' : 'unresolved',
  };
}

function recordType(row: JsonObject, anchor: RawAnchor): string {
  const type = row['type'];
  if (typeof type !== 'string' || type.length === 0) {
    return unknownRecord('Claude record type is not supported.', anchor);
  }
  return type;
}

function inspectConversationClaims(
  row: JsonObject,
  anchor: RawAnchor,
): {
  identityBearing: boolean;
  descendant: boolean;
} {
  const sidechain = row['isSidechain'];
  if (sidechain !== undefined && typeof sidechain !== 'boolean') {
    invalidRecord('Claude sidechain claim is malformed.', anchor);
  }
  const agentId = row['agentId'];
  if (agentId !== undefined && typeof agentId !== 'string') {
    invalidRecord('Claude agent claim is malformed.', anchor);
  }
  const parentUuid = row['parentUuid'];
  if (
    parentUuid !== undefined &&
    parentUuid !== null &&
    typeof parentUuid !== 'string'
  ) {
    invalidRecord('Claude parent claim is malformed.', anchor);
  }
  return {
    identityBearing:
      sidechain !== undefined ||
      agentId !== undefined ||
      parentUuid !== undefined,
    descendant:
      sidechain === true || (typeof agentId === 'string' && agentId.length > 0),
  };
}

function nonAction(anchor: RawAnchor, type: string): RawEntry {
  return { kind: 'non_action', anchor, record_type: type };
}

function addCanonicalEntry(
  entries: RawEntry[],
  targets: ReplayTarget[],
  entry: RawEntry,
): void {
  entries.push(entry);
  targets.push({ block: entry.anchor.block, canonical_anchor: entry.anchor });
}

function addReplayEntry(
  entries: RawEntry[],
  targets: ReplayTarget[],
  anchor: RawAnchor,
  canonicalAnchor: RawAnchor,
): void {
  entries.push({
    kind: 'replay',
    anchor,
    canonical_anchor: canonicalAnchor,
  });
  targets.push({ block: anchor.block, canonical_anchor: canonicalAnchor });
}

function inspectOptionalIdentity(
  row: JsonObject,
  source: RawSource,
  anchor: RawAnchor,
  observed: {
    session_id: string | null;
    cwd: string | null;
    cli_version: string | null;
  },
): boolean {
  let hasEvidence = false;
  const fields = [
    ['sessionId', 'session_id', source.expected_session_id],
    ['cwd', 'cwd', source.expected_cwd],
    ['version', 'cli_version', source.expected_cli_version],
  ] as const;
  for (const [rawName, observedName, expected] of fields) {
    const value = row[rawName];
    if (value === undefined) continue;
    hasEvidence = true;
    if (typeof value !== 'string' || value.length === 0) {
      invalidRecord('Claude identity field is malformed.', anchor);
    }
    const previous = observed[observedName];
    if (value !== expected || (previous !== null && value !== previous)) {
      throw new ObserverEvidenceError(
        'identity_conflict',
        'Claude identity conflicts with the supplied source.',
        anchor,
      );
    }
    observed[observedName] = value;
  }
  return hasEvidence;
}

export function indexClaudeTranscript(
  source: RawSource,
  raw: Uint8Array,
): RawIndex {
  if (source.runtime !== 'claude') {
    throw new ObserverEvidenceError(
      'invalid_source',
      'Claude observer requires a Claude source.',
    );
  }

  const rows = parseCompleteJsonl(source, raw);
  const entries: RawEntry[] = [];
  const seenUuids = new Map<string, SeenUuid>();
  const seenCalls = new Map<string, SeenPayload>();
  const seenResults = new Map<string, SeenPayload>();
  const observed = {
    session_id: null as string | null,
    cwd: null as string | null,
    cli_version: null as string | null,
  };
  const identityEvidence: RawAnchor[] = [];
  let descendant = false;

  for (const parsed of rows) {
    const row = parsed.value;
    const rowAnchor = parsed.anchor;
    const type = recordType(row, rowAnchor);
    if (
      type !== 'queue-operation' &&
      type !== 'assistant' &&
      type !== 'user' &&
      type !== 'attachment' &&
      type !== 'ai-title'
    ) {
      unknownRecord('Claude record type is not supported.', rowAnchor);
    }

    const uuid = row['uuid'];
    if (uuid !== undefined && (typeof uuid !== 'string' || uuid.length === 0)) {
      invalidRecord('Claude UUID is malformed.', rowAnchor);
    }
    const canonicalRow = canonicalJson(row);
    const previousUuid =
      typeof uuid === 'string' ? seenUuids.get(uuid) : undefined;
    if (previousUuid && previousUuid.canonical_row !== canonicalRow) {
      throw new ObserverEvidenceError(
        'replay_conflict',
        'Claude UUID replay conflicts with its original row.',
        rowAnchor,
      );
    }
    if (type !== 'user' && row['toolUseResult'] !== undefined) {
      unknownRecord(
        'Claude result metadata has no matching result block.',
        rowAnchor,
      );
    }

    const conversationClaims = inspectConversationClaims(row, rowAnchor);
    if (
      inspectOptionalIdentity(row, source, rowAnchor, observed) ||
      conversationClaims.identityBearing
    ) {
      identityEvidence.push(rowAnchor);
    }
    if (conversationClaims.descendant) descendant = true;

    if (previousUuid) {
      for (const target of previousUuid.targets) {
        entries.push({
          kind: 'replay',
          anchor: anchorAt(source.source_id, rowAnchor.line, target.block),
          canonical_anchor: target.canonical_anchor,
        });
      }
      continue;
    }

    const targets: ReplayTarget[] = [];

    if (type === 'queue-operation') {
      const operation = row['operation'];
      if (typeof operation !== 'string') {
        invalidRecord('Claude queue operation is malformed.', rowAnchor);
      }
      if (operation !== 'enqueue' && operation !== 'dequeue') {
        unknownRecord('Claude queue operation is not supported.', rowAnchor);
      }
      addCanonicalEntry(
        entries,
        targets,
        nonAction(rowAnchor, `queue-operation.${operation}`),
      );
    } else if (type === 'attachment') {
      const attachment = row['attachment'];
      if (!isObject(attachment) || typeof attachment['type'] !== 'string') {
        invalidRecord('Claude attachment record is malformed.', rowAnchor);
      }
      const attachmentType = attachment['type'];
      if (
        attachmentType !== 'deferred_tools_delta' &&
        attachmentType !== 'skill_listing'
      ) {
        unknownRecord('Claude attachment subtype is not supported.', rowAnchor);
      }
      addCanonicalEntry(
        entries,
        targets,
        nonAction(rowAnchor, `attachment.${attachmentType}`),
      );
    } else if (type === 'ai-title') {
      if (typeof row['aiTitle'] !== 'string') {
        invalidRecord('Claude title record is malformed.', rowAnchor);
      }
      addCanonicalEntry(entries, targets, nonAction(rowAnchor, 'ai-title'));
    } else {
      const role = type;
      const compactSummary = row['isCompactSummary'];
      if (compactSummary !== undefined && typeof compactSummary !== 'boolean') {
        invalidRecord('Claude compact-summary claim is malformed.', rowAnchor);
      }
      if (role === 'assistant' && compactSummary === true) {
        unknownRecord(
          'Claude assistant compact-summary variant is not supported.',
          rowAnchor,
        );
      }
      const message = readMessage(row, role, rowAnchor);
      const id = messageId(message, rowAnchor);
      const content = contentBlocks(message, rowAnchor);
      const containsToolResult =
        role === 'user' &&
        Array.isArray(content) &&
        content.some((block) => block['type'] === 'tool_result');
      if (row['toolUseResult'] !== undefined && !containsToolResult) {
        unknownRecord(
          'Claude result metadata has no matching result block.',
          rowAnchor,
        );
      }

      if (role === 'user' && compactSummary === true) {
        if (Array.isArray(content)) {
          for (const [blockIndex, block] of content.entries()) {
            const blockAnchor = anchorAt(
              source.source_id,
              rowAnchor.line,
              blockIndex,
            );
            if (block['type'] !== 'text') {
              unknownRecord(
                'Claude compact summary contains an action-bearing block.',
                blockAnchor,
              );
            }
            if (typeof block['text'] !== 'string') {
              invalidRecord(
                'Claude summary text block is malformed.',
                blockAnchor,
              );
            }
          }
        }
        addCanonicalEntry(
          entries,
          targets,
          nonAction(rowAnchor, 'user.compact_summary'),
        );
      } else if (typeof content === 'string') {
        addCanonicalEntry(
          entries,
          targets,
          textEntry(rowAnchor, role, content, id, row, descendant),
        );
      } else if (content.length === 0) {
        addCanonicalEntry(
          entries,
          targets,
          nonAction(rowAnchor, `${role}.empty`),
        );
      } else {
        for (const [blockIndex, block] of content.entries()) {
          const blockAnchor = anchorAt(
            source.source_id,
            rowAnchor.line,
            blockIndex,
          );
          const blockType = block['type'];
          if (blockType === 'text') {
            const text = block['text'];
            if (typeof text !== 'string') {
              invalidRecord('Claude text block is malformed.', blockAnchor);
            }
            addCanonicalEntry(
              entries,
              targets,
              textEntry(blockAnchor, role, text, id, row, descendant),
            );
            continue;
          }
          if (role === 'assistant' && blockType === 'thinking') {
            if (
              typeof block['thinking'] !== 'string' &&
              typeof block['text'] !== 'string'
            ) {
              invalidRecord('Claude thinking block is malformed.', blockAnchor);
            }
            addCanonicalEntry(
              entries,
              targets,
              nonAction(blockAnchor, 'assistant.thinking'),
            );
            continue;
          }
          if (role === 'assistant' && blockType === 'tool_use') {
            const nativeId = block['id'];
            const name = block['name'];
            const input = block['input'];
            if (
              typeof nativeId !== 'string' ||
              nativeId.length === 0 ||
              typeof name !== 'string' ||
              name.length === 0 ||
              !isObject(input)
            ) {
              invalidRecord('Claude tool-use block is malformed.', blockAnchor);
            }
            const canonicalPayload = canonicalJson(block);
            const previousCall = seenCalls.get(nativeId);
            if (previousCall) {
              if (previousCall.canonical_payload !== canonicalPayload) {
                throw new ObserverEvidenceError(
                  'replay_conflict',
                  'Claude tool-use identity conflicts with its original call.',
                  blockAnchor,
                );
              }
              addReplayEntry(
                entries,
                targets,
                blockAnchor,
                previousCall.anchor,
              );
            } else {
              const entry: RawEntry = {
                kind: 'call',
                anchor: blockAnchor,
                call_id: `native:${nativeId}`,
                native_call_id: nativeId,
                name,
                payload: block,
              };
              addCanonicalEntry(entries, targets, entry);
              seenCalls.set(nativeId, {
                canonical_payload: canonicalPayload,
                anchor: entry.anchor,
              });
            }
            continue;
          }
          if (role === 'user' && blockType === 'tool_result') {
            const nativeId = block['tool_use_id'];
            if (typeof nativeId !== 'string' || nativeId.length === 0) {
              invalidRecord(
                'Claude tool-result block is malformed.',
                blockAnchor,
              );
            }
            const call = seenCalls.get(nativeId);
            if (!call) {
              throw new ObserverEvidenceError(
                'orphan_result',
                'Claude tool result has no earlier matching call.',
                blockAnchor,
              );
            }
            const payload: JsonObject = {
              block,
              tool_use_result: row['toolUseResult'] ?? null,
            };
            const canonicalPayload = canonicalJson(payload);
            const previousResult = seenResults.get(nativeId);
            if (previousResult) {
              if (previousResult.canonical_payload !== canonicalPayload) {
                throw new ObserverEvidenceError(
                  'replay_conflict',
                  'Claude tool-result identity conflicts with its original result.',
                  blockAnchor,
                );
              }
              addReplayEntry(
                entries,
                targets,
                blockAnchor,
                previousResult.anchor,
              );
            } else {
              const entry: RawEntry = {
                kind: 'result',
                anchor: blockAnchor,
                call_id: `native:${nativeId}`,
                call_anchor: call.anchor,
                payload,
              };
              addCanonicalEntry(entries, targets, entry);
              seenResults.set(nativeId, {
                canonical_payload: canonicalPayload,
                anchor: entry.anchor,
              });
            }
            continue;
          }
          unknownRecord(
            'Claude message block type is not supported.',
            blockAnchor,
          );
        }
      }
    }

    if (typeof uuid === 'string') {
      seenUuids.set(uuid, { canonical_row: canonicalRow, targets });
    }
  }

  return RawIndexSchema.parse({
    schema_version: 2,
    source,
    identity: {
      ...observed,
      conversation: descendant ? 'descendant' : 'unresolved',
      evidence: identityEvidence,
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
