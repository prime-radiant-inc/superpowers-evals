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

/** Captured native envelopes distinguish the parent CLI from SDK and child rows. */
function isInspectedNativeEnvelope(row: JsonObject): boolean {
  return (
    row['entrypoint'] === 'cli' &&
    row['userType'] === 'external' &&
    row['isSidechain'] === false &&
    row['agentId'] === undefined &&
    row['version'] === '2.1.209' &&
    typeof row['sessionId'] === 'string' &&
    row['sessionId'].length > 0 &&
    typeof row['cwd'] === 'string' &&
    row['cwd'].length > 0 &&
    (row['session_id'] === undefined || row['session_id'] === row['sessionId'])
  );
}

function isInspectedNativeHumanInput(row: JsonObject): boolean {
  const origin = row['origin'];
  return (
    isInspectedNativeEnvelope(row) &&
    row['type'] === 'user' &&
    isObject(origin) &&
    Object.keys(origin).length === 1 &&
    origin['kind'] === 'human' &&
    row['promptSource'] === 'typed' &&
    row['isCompactSummary'] !== true &&
    isObject(row['message']) &&
    row['message']['role'] === 'user' &&
    typeof row['message']['content'] === 'string'
  );
}

export function inspectedClaudeParentIdentity(raw: Uint8Array): {
  session_id: string;
  cwd: string;
  cli_version: string;
} | null {
  const placeholder: RawSource = {
    source_id: 'claude-parent-discovery',
    runtime: 'claude',
    expected_session_id: 'unresolved',
    expected_cwd: 'unresolved',
    expected_cli_version: '2.1.209',
  };
  const rows = parseCompleteJsonl(placeholder, raw);
  const parent = rows.find(({ value }) => isInspectedNativeHumanInput(value));
  if (!parent) {
    let startupSource: RawSource | null = null;
    for (const { value, anchor } of rows) {
      const type = recordType(value, anchor);
      if (isStartupHook(value)) {
        inspectNativeAttachment(value, anchor);
        startupSource ??= {
          ...placeholder,
          expected_session_id: value['sessionId'] as string,
          expected_cwd: value['cwd'] as string,
        };
        continue;
      }
      if (
        type !== 'mode' &&
        type !== 'permission-mode' &&
        type !== 'file-history-snapshot' &&
        type !== 'last-prompt'
      ) {
        unknownRecord(
          'Claude source has no inspected native parent input.',
          anchor,
        );
      }
      inspectNativeMetadata(value, type, anchor);
    }
    if (startupSource) indexClaudeTranscript(startupSource, raw);
    return null;
  }
  const source = {
    ...placeholder,
    expected_session_id: parent.value['sessionId'] as string,
    expected_cwd: parent.value['cwd'] as string,
  };
  const index = indexClaudeTranscript(source, raw);
  if (index.identity.conversation !== 'parent') {
    throw new ObserverEvidenceError(
      'identity_conflict',
      'Claude source contradicts native parent provenance.',
    );
  }
  return {
    session_id: source.expected_session_id,
    cwd: source.expected_cwd,
    cli_version: source.expected_cli_version,
  };
}

function exactKeys(row: JsonObject, keys: string[], anchor: RawAnchor): void {
  if (Object.keys(row).some((key) => !keys.includes(key))) {
    unknownRecord('Claude metadata includes an uninspected field.', anchor);
  }
}

function inspectNativeMetadata(
  row: JsonObject,
  type: string,
  anchor: RawAnchor,
): void {
  if (
    type !== 'file-history-snapshot' &&
    (typeof row['sessionId'] !== 'string' || row['sessionId'].length === 0)
  ) {
    invalidRecord('Claude native metadata has no session identity.', anchor);
  }
  if (type === 'mode' || type === 'permission-mode') {
    const key = type === 'mode' ? 'mode' : 'permissionMode';
    exactKeys(row, ['type', key, 'sessionId'], anchor);
    if (
      type === 'mode'
        ? row[key] !== 'normal'
        : row[key] !== 'dontAsk' && row[key] !== 'bypassPermissions'
    ) {
      unknownRecord('Claude metadata variant is not inspected.', anchor);
    }
  } else if (type === 'last-prompt') {
    exactKeys(row, ['type', 'lastPrompt', 'leafUuid', 'sessionId'], anchor);
    if (
      (row['lastPrompt'] !== undefined &&
        typeof row['lastPrompt'] !== 'string') ||
      typeof row['leafUuid'] !== 'string'
    ) {
      invalidRecord('Claude last-prompt metadata is malformed.', anchor);
    }
  } else {
    exactKeys(
      row,
      ['type', 'messageId', 'snapshot', 'isSnapshotUpdate'],
      anchor,
    );
    const snapshot = row['snapshot'];
    if (!isObject(snapshot))
      invalidRecord('Claude file snapshot is malformed.', anchor);
    exactKeys(
      snapshot,
      ['messageId', 'trackedFileBackups', 'timestamp'],
      anchor,
    );
    if (
      typeof row['messageId'] !== 'string' ||
      snapshot['messageId'] !== row['messageId'] ||
      typeof row['isSnapshotUpdate'] !== 'boolean' ||
      typeof snapshot['timestamp'] !== 'string' ||
      !isObject(snapshot['trackedFileBackups'])
    ) {
      invalidRecord('Claude file snapshot is malformed.', anchor);
    }
  }
}

function isStartupHook(row: JsonObject): boolean {
  const attachment = row['attachment'];
  return (
    row['type'] === 'attachment' &&
    isObject(attachment) &&
    (attachment['type'] === 'hook_success' ||
      attachment['type'] === 'hook_additional_context')
  );
}

/** Native hooks and permission metadata carry context, never human approval. */
function inspectNativeAttachment(row: JsonObject, anchor: RawAnchor): void {
  if (!isInspectedNativeEnvelope(row)) {
    unknownRecord('Claude attachment envelope is not inspected.', anchor);
  }
  exactKeys(
    row,
    [
      'type',
      'attachment',
      'cwd',
      'entrypoint',
      'gitBranch',
      'isSidechain',
      'parentUuid',
      'sessionId',
      'session_id',
      'timestamp',
      'userType',
      'uuid',
      'version',
    ],
    anchor,
  );
  if (
    typeof row['uuid'] !== 'string' ||
    row['uuid'].length === 0 ||
    (row['parentUuid'] !== null &&
      (typeof row['parentUuid'] !== 'string' ||
        row['parentUuid'].length === 0)) ||
    typeof row['timestamp'] !== 'string' ||
    typeof row['gitBranch'] !== 'string'
  )
    invalidRecord('Claude attachment identity is malformed.', anchor);
  const attachment = row['attachment'];
  if (!isObject(attachment))
    invalidRecord('Claude attachment is malformed.', anchor);
  const type = attachment['type'];
  if (type === 'command_permissions') {
    exactKeys(attachment, ['type', 'allowedTools'], anchor);
    if (
      !Array.isArray(attachment['allowedTools']) ||
      attachment['allowedTools'].length !== 0
    ) {
      unknownRecord(
        'Claude command-permissions variant is not inspected.',
        anchor,
      );
    }
    return;
  }
  exactKeys(
    attachment,
    type === 'hook_success'
      ? [
          'type',
          'hookName',
          'toolUseID',
          'hookEvent',
          'content',
          'stdout',
          'stderr',
          'exitCode',
          'command',
          'durationMs',
        ]
      : ['type', 'content', 'hookName', 'toolUseID', 'hookEvent'],
    anchor,
  );
  if (
    attachment['hookEvent'] !== 'SessionStart' ||
    attachment['hookName'] !==
      (type === 'hook_success' ? 'SessionStart:startup' : 'SessionStart') ||
    typeof attachment['toolUseID'] !== 'string' ||
    attachment['toolUseID'].length === 0
  )
    unknownRecord('Claude startup-hook variant is not inspected.', anchor);
  if (type === 'hook_success') {
    if (
      !['content', 'stdout', 'stderr', 'command'].every(
        (key) => typeof attachment[key] === 'string',
      ) ||
      attachment['exitCode'] !== 0 ||
      typeof attachment['durationMs'] !== 'number' ||
      !Number.isFinite(attachment['durationMs']) ||
      attachment['durationMs'] < 0
    )
      invalidRecord('Claude startup-hook result is malformed.', anchor);
  } else if (
    !Array.isArray(attachment['content']) ||
    !attachment['content'].every((value) => typeof value === 'string')
  )
    invalidRecord('Claude startup-hook context is malformed.', anchor);
}

function textEntry(
  anchor: RawAnchor,
  role: 'assistant' | 'user',
  text: string,
  id: string | null,
  row: JsonObject,
  descendant: boolean,
  nativeApprovalEligible: boolean,
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
    approval_eligibility: descendant
      ? 'ineligible'
      : nativeApprovalEligible
        ? 'eligible'
        : 'unresolved',
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
  let parent = false;
  let nativeChainStarted = false;
  let nativeChainUuid: string | null = null;

  for (const parsed of rows) {
    const row = parsed.value;
    const rowAnchor = parsed.anchor;
    const type = recordType(row, rowAnchor);
    if (
      type !== 'queue-operation' &&
      type !== 'assistant' &&
      type !== 'user' &&
      type !== 'attachment' &&
      type !== 'ai-title' &&
      type !== 'mode' &&
      type !== 'permission-mode' &&
      type !== 'file-history-snapshot' &&
      type !== 'last-prompt' &&
      type !== 'system'
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

    const nativeHumanInput = isInspectedNativeHumanInput(row);
    // Every UUID link must continue the previously inspected physical chain.
    const nativeChainLinked: boolean =
      typeof uuid === 'string' &&
      isInspectedNativeEnvelope(row) &&
      ((!nativeChainStarted &&
        (nativeHumanInput ||
          (isStartupHook(row) &&
            isObject(row['attachment']) &&
            row['attachment']['type'] === 'hook_success')) &&
        row['parentUuid'] === null) ||
        (nativeChainUuid !== null && row['parentUuid'] === nativeChainUuid));
    const nativeApprovalEligible = nativeHumanInput && nativeChainLinked;
    if (nativeApprovalEligible) parent = true;
    const targets: ReplayTarget[] = [];

    if (
      type === 'mode' ||
      type === 'permission-mode' ||
      type === 'file-history-snapshot' ||
      type === 'last-prompt'
    ) {
      if (source.expected_cli_version !== '2.1.209')
        unknownRecord(
          'Claude native metadata build is not inspected.',
          rowAnchor,
        );
      inspectNativeMetadata(row, type, rowAnchor);
      addCanonicalEntry(entries, targets, nonAction(rowAnchor, type));
    } else if (type === 'system') {
      if (
        source.expected_cli_version !== '2.1.209' ||
        row['subtype'] !== 'turn_duration'
      )
        unknownRecord(
          'Claude system metadata variant is not inspected.',
          rowAnchor,
        );
      exactKeys(
        row,
        [
          'parentUuid',
          'isSidechain',
          'type',
          'subtype',
          'durationMs',
          'messageCount',
          'timestamp',
          'uuid',
          'isMeta',
          'userType',
          'entrypoint',
          'cwd',
          'sessionId',
          'version',
          'gitBranch',
        ],
        rowAnchor,
      );
      const duration = row['durationMs'];
      const count = row['messageCount'];
      if (
        typeof duration !== 'number' ||
        !Number.isFinite(duration) ||
        duration < 0 ||
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        typeof row['timestamp'] !== 'string' ||
        row['isMeta'] !== false
      )
        invalidRecord('Claude turn-duration metadata is malformed.', rowAnchor);
      addCanonicalEntry(
        entries,
        targets,
        nonAction(rowAnchor, 'system.turn_duration'),
      );
    } else if (type === 'queue-operation') {
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
        attachmentType !== 'skill_listing' &&
        attachmentType !== 'agent_listing_delta' &&
        attachmentType !== 'hook_success' &&
        attachmentType !== 'hook_additional_context' &&
        attachmentType !== 'command_permissions'
      ) {
        unknownRecord('Claude attachment subtype is not supported.', rowAnchor);
      }
      if (isStartupHook(row) || attachmentType === 'command_permissions') {
        inspectNativeAttachment(row, rowAnchor);
      }
      if (attachmentType === 'agent_listing_delta') {
        if (row['message'] !== undefined)
          unknownRecord(
            'Claude agent listing contains an uninspected message.',
            rowAnchor,
          );
        if (source.expected_cli_version !== '2.1.209')
          unknownRecord(
            'Claude agent listing build is not inspected.',
            rowAnchor,
          );
        exactKeys(
          attachment,
          [
            'type',
            'addedTypes',
            'addedLines',
            'removedTypes',
            'isInitial',
            'showConcurrencyNote',
          ],
          rowAnchor,
        );
        for (const key of ['addedTypes', 'addedLines', 'removedTypes']) {
          const values = attachment[key];
          if (
            !Array.isArray(values) ||
            !values.every((value) => typeof value === 'string')
          )
            invalidRecord('Claude agent listing is malformed.', rowAnchor);
        }
        if (
          typeof attachment['isInitial'] !== 'boolean' ||
          typeof attachment['showConcurrencyNote'] !== 'boolean'
        )
          invalidRecord('Claude agent listing flags are malformed.', rowAnchor);
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
          textEntry(
            rowAnchor,
            role,
            content,
            id,
            row,
            descendant,
            nativeApprovalEligible,
          ),
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
              textEntry(
                blockAnchor,
                role,
                text,
                id,
                row,
                descendant,
                nativeApprovalEligible,
              ),
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
      nativeChainStarted = true;
      nativeChainUuid = nativeChainLinked ? uuid : null;
      seenUuids.set(uuid, { canonical_row: canonicalRow, targets });
    } else if (
      type === 'user' ||
      type === 'assistant' ||
      type === 'attachment' ||
      type === 'system'
    ) {
      nativeChainStarted = true;
      nativeChainUuid = null;
    }
  }

  return RawIndexSchema.parse({
    schema_version: 2,
    source,
    identity: {
      ...observed,
      conversation: descendant
        ? 'descendant'
        : parent
          ? 'parent'
          : 'unresolved',
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
