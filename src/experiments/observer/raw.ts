import { createHash } from 'node:crypto';
import {
  type JsonValue,
  ObserverEvidenceError,
  type RawAnchor,
  type RawPrefix,
  RawPrefixSchema,
  type RawSource,
  RawSourceSchema,
} from './contracts.ts';

export interface RawRow {
  anchor: RawAnchor;
  byte_start: number;
  byte_end: number;
  value: { [key: string]: JsonValue };
}

function validateSource(source: RawSource): RawSource {
  const parsed = RawSourceSchema.safeParse(source);
  if (!parsed.success) {
    throw new ObserverEvidenceError(
      'invalid_source',
      'Raw source description is invalid.',
    );
  }
  return parsed.data;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return value !== null && !Array.isArray(value) && isJsonValue(value);
}

export function parseCompleteJsonl(
  source: RawSource,
  raw: Uint8Array,
): RawRow[] {
  const validatedSource = validateSource(source);
  if (raw.length > 0 && raw.at(-1) !== 10) {
    throw new ObserverEvidenceError(
      'incomplete_jsonl',
      'JSONL must end at LF.',
    );
  }
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new ObserverEvidenceError(
      'invalid_utf8',
      'JSONL must not start with BOM.',
    );
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const rows: RawRow[] = [];
  let start = 0;
  for (let end = 0; end < raw.length; end++) {
    if (raw[end] !== 10) continue;
    const anchor: RawAnchor = {
      source_id: validatedSource.source_id,
      line: rows.length + 1,
      block: null,
    };
    if (
      raw[start] === 0xef &&
      raw[start + 1] === 0xbb &&
      raw[start + 2] === 0xbf
    ) {
      throw new ObserverEvidenceError(
        'invalid_utf8',
        'JSONL row must not start with BOM.',
        anchor,
      );
    }
    let text: string;
    try {
      text = decoder.decode(raw.subarray(start, end));
    } catch {
      throw new ObserverEvidenceError(
        'invalid_utf8',
        'JSONL row is not valid UTF-8.',
        anchor,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ObserverEvidenceError(
        'invalid_jsonl',
        'JSONL row is not valid JSON.',
        anchor,
      );
    }
    if (!isJsonObject(value)) {
      throw new ObserverEvidenceError(
        'invalid_record',
        'JSONL row must be an object containing finite JSON values.',
        anchor,
      );
    }
    rows.push({ anchor, byte_start: start, byte_end: end + 1, value });
    start = end + 1;
  }
  return rows;
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const nested = value[key];
        if (nested === undefined) {
          throw new TypeError('Canonical JSON requires a finite JSON value.');
        }
        return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
      })
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Canonical JSON requires a finite JSON value.');
  }
  return encoded;
}

export function createRawPrefix(source: RawSource, raw: Uint8Array): RawPrefix {
  const rows = parseCompleteJsonl(source, raw);
  return {
    source_id: source.source_id,
    bytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
    after_line: rows.length,
  };
}

export function verifyRawPrefix(
  source: RawSource,
  raw: Uint8Array,
  prefix: RawPrefix,
): void {
  const validatedSource = validateSource(source);
  const parsedPrefix = RawPrefixSchema.safeParse(prefix);
  if (
    !parsedPrefix.success ||
    parsedPrefix.data.source_id !== validatedSource.source_id ||
    parsedPrefix.data.bytes > raw.length
  ) {
    throw new ObserverEvidenceError(
      'prefix_mismatch',
      'Reviewed raw prefix does not match its source.',
    );
  }

  let actual: RawPrefix;
  try {
    actual = createRawPrefix(
      validatedSource,
      raw.subarray(0, parsedPrefix.data.bytes),
    );
  } catch {
    throw new ObserverEvidenceError(
      'prefix_mismatch',
      'Reviewed raw prefix does not match its source.',
    );
  }
  if (
    actual.source_id !== parsedPrefix.data.source_id ||
    actual.bytes !== parsedPrefix.data.bytes ||
    actual.sha256 !== parsedPrefix.data.sha256 ||
    actual.after_line !== parsedPrefix.data.after_line
  ) {
    throw new ObserverEvidenceError(
      'prefix_mismatch',
      'Reviewed raw prefix does not match its source.',
    );
  }
}

export function verifyReviewedSuffix(
  source: RawSource,
  raw: Uint8Array,
  reviewed: RawPrefix,
): void {
  verifyRawPrefix(source, raw, reviewed);
  if (raw.length !== reviewed.bytes) {
    throw new ObserverEvidenceError(
      'unreviewed_suffix',
      'Raw source contains an unreviewed suffix.',
    );
  }
}
