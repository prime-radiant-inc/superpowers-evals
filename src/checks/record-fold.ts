// Write-side fold rule (parent Checks): unknown keys on an emitted check
// record fold into `detail` instead of being silently stripped by the zod
// parse. Implemented, not a zod default. Folded pairs render `key=value`
// (non-string values JSON-serialized), sorted by key, joined by `; `,
// appended after an existing detail with a ` | ` separator.

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
  const existing =
    typeof raw['detail'] === 'string' && raw['detail'] !== ''
      ? raw['detail']
      : null;
  const detail =
    existing === null
      ? `folded: ${foldedText}`
      : `${existing} | folded: ${foldedText}`;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (KNOWN_RECORD_KEYS.has(key)) out[key] = raw[key];
  }
  out['detail'] = detail;
  return out;
}
