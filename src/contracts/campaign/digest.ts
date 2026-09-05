// src/contracts/campaign/digest.ts
// JCS (RFC 8785) canonicalization, hand-rolled per the D1 spec's
// implementation contract: no dependency, recursive key sort by UTF-16 code
// units, ES6 number/string serialization (JS semantics already match JCS for
// finite doubles and string escaping), NaN/Infinity rejected. Known failure
// mode this replaces: hashing non-canonicalized JSON.stringify output (see
// src/appliance/container.ts's plain-stringify hash — never do that here).

/** Quote one string per ES6 JSON.stringify after the RFC 8785 well-formedness
 *  check: a lone UTF-16 surrogate is not a Unicode string, so it must reject
 *  loud rather than be escape-mangled into the canonical bytes. Applies to
 *  values and object keys alike. */
function jcsQuoteString(value: string): string {
  if (!value.isWellFormed()) {
    throw new Error('JCS rejects lone UTF-16 surrogates (RFC 8785)');
  }
  return JSON.stringify(value);
}

/** Canonicalize a JSON-domain value per RFC 8785. Throws on non-JSON inputs
 *  (undefined, functions, symbols, NaN, Infinity, lone surrogates). */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`JCS rejects non-finite numbers: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === 'string') return jcsQuoteString(value as string);
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcsCanonicalize(item)).join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    // JS default sort compares strings by UTF-16 code units — exactly the
    // RFC 8785 key ordering.
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${jcsQuoteString(key)}:${jcsCanonicalize(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`JCS rejects non-JSON values of type ${t}`);
}

/** SHA-256 over the UTF-8 bytes of `text`, hex-encoded. */
export function sha256Hex(text: string): string {
  return Bun.SHA256.hash(new TextEncoder().encode(text), 'hex');
}
