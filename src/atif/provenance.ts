export interface NativeEvidence {
  /** One-based native source lines; bundles retain every contributing line. */
  lines: number[];
  origin?: 'human' | 'injected' | 'parent' | 'unknown';
  /** Native result or usage boundary timestamp, when present. */
  timestamp?: string;
  /** UTF-8 bytes of native textual tool-result content before decoration. */
  contentBytes?: number;
  /** UTF-8 bytes of the original serialized JSONL record, excluding LF/CRLF. */
  recordBytes?: number;
}

/** Native result status/counter retained separately from its rendered content. */
export interface NativeToolResultEvidence {
  isError?: boolean;
  durationMs?: number;
  /** Proven logical outcomes inside this one physical result; no copied outputs or usage. */
  subcalls?: {
    toolCallId: string;
    isError: boolean;
    contentBytes: number;
  }[];
}

export type NativeBoundaryKind = 'task' | 'turn' | 'compaction';

/** Non-priced native lifecycle evidence retained for later ATIF assessment. */
export interface NativeBoundary {
  kind: NativeBoundaryKind;
  phase?: 'start' | 'complete';
  /** Native-reported duration, distinct from boundary timestamp subtraction. */
  durationMs?: number;
  evidence: NativeEvidence;
}

export interface NativeChildEvidence {
  relationship: 'fork' | 'spawned' | 'unknown';
  id?: string;
  name?: string;
  path?: string;
}

/** Ordered native batch position, never a synthetic tool call id. */
export interface NativeChildDispatch {
  index: number;
  prompt?: string;
  child: NativeChildEvidence;
}

/** Observable inter-agent routing; opaque payload bytes are never copied. */
export interface NativeCommunication {
  id?: string;
  author?: string;
  recipient?: string;
  contentKinds: string[];
  opaqueContent: boolean;
  evidence: NativeEvidence;
}

export function withNativeEvidence(
  extra: Record<string, unknown> | undefined,
  evidence: NativeEvidence,
): Record<string, unknown> {
  return { ...extra, quorum_source: evidence };
}

/** Count only native textual result payload, never its JSON envelope. */
export function nativeTextBytes(content: unknown): number | undefined {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return undefined;
  let bytes = 0;
  let found = false;
  for (const block of content) {
    if (typeof block === 'string') {
      bytes += Buffer.byteLength(block, 'utf8');
      found = true;
      continue;
    }
    if (block && typeof block === 'object') {
      const text = (block as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        bytes += Buffer.byteLength(text, 'utf8');
        found = true;
      }
    }
  }
  return found ? bytes : undefined;
}

export function appendNativeLine(
  extra: Record<string, unknown> | undefined,
  line: number,
): Record<string, unknown> {
  const prior = extra?.['quorum_source'];
  const priorEvidence =
    prior && typeof prior === 'object' ? (prior as NativeEvidence) : undefined;
  const lines = priorEvidence?.lines ?? [];
  return withNativeEvidence(extra, {
    ...priorEvidence,
    lines: lines.includes(line) ? lines : [...lines, line],
  });
}

/** Native record size includes original whitespace/escaping, not a re-serialization. */
export function nativeRecordBytes(line: string): number {
  return Buffer.byteLength(line.replace(/\r$/, ''), 'utf8');
}
