// Write-side fold rule (parent Checks; exact format pinned by the D1 spec):
// unknown keys on an emitted check record fold into `detail` instead of
// being silently stripped by the zod parse. Implemented, not a zod default.
// Folded pairs render `key=value` (non-string values JSON-serialized),
// sorted by key, joined by `; `; when detail is non-null — the empty string
// included — the pairs are appended after it with a ` | ` separator, else
// the pairs become the detail.

const KNOWN_RECORD_KEYS: ReadonlySet<string> = new Set([
  'check',
  'args',
  'negated',
  'passed',
  'detail',
  'phase',
  'score',
  'metrics',
  'tags',
  'notes',
]);

export function foldUnknownKeys(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const unknown = Object.keys(raw)
    .filter((key) => !KNOWN_RECORD_KEYS.has(key))
    .sort();
  if (unknown.length === 0) return raw;
  const foldedText = unknown
    .map((key) => {
      const value = raw[key];
      return `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
    })
    .join('; ');
  const detail =
    typeof raw['detail'] === 'string'
      ? `${raw['detail']} | ${foldedText}`
      : foldedText;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (KNOWN_RECORD_KEYS.has(key)) out[key] = raw[key];
  }
  out['detail'] = detail;
  return out;
}
