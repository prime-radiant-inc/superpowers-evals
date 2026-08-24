// src/contracts/campaign/digest.ts
// JCS (RFC 8785) canonicalization, hand-rolled per the D1 spec's
// implementation contract: no dependency, recursive key sort by UTF-16 code
// units, ES6 number/string serialization (JS semantics already match JCS for
// finite doubles and string escaping), NaN/Infinity rejected. Known failure
// mode this replaces: hashing non-canonicalized JSON.stringify output (see
// src/appliance/container.ts's plain-stringify hash — never do that here).

import type { Campaign } from './campaign.ts';

/** Canonicalize a JSON-domain value per RFC 8785. Throws on non-JSON inputs
 *  (undefined, functions, symbols, NaN, Infinity). */
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
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcsCanonicalize(item)).join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    // JS default sort compares strings by UTF-16 code units — exactly the
    // RFC 8785 key ordering.
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${jcsCanonicalize(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`JCS rejects non-JSON values of type ${t}`);
}

/** SHA-256 over the UTF-8 bytes of `text`, hex-encoded. */
export function sha256Hex(text: string): string {
  return Bun.SHA256.hash(new TextEncoder().encode(text), 'hex');
}

/** Strip the advisory/re-derivable fields out of a campaign before
 *  canonicalization (parent Appendix B digest definition): estimates_by_arm
 *  in every cell, budget.surcharge_applied, budget.priced_coverage,
 *  registered_at, registered_by, campaign_id, and digest itself.
 *  budget.usd_all_in (the registered figure) stays in. */
export function digestInput(campaign: Campaign): Record<string, unknown> {
  const {
    campaign_id: _id,
    registered_at: _at,
    registered_by: _by,
    digest: _digest,
    ...rest
  } = campaign;
  return {
    ...rest,
    cells: campaign.cells.map(({ estimates_by_arm: _e, ...cell }) => cell),
    budget: { usd_all_in: campaign.budget.usd_all_in },
  };
}

/** The campaign's identity: SHA-256 over the JCS-canonicalized digest input,
 *  hex-encoded. Refreshing estimates never forks identity — only the frozen
 *  grid, refs, suite, and registered budget figure do. */
export function campaignDigest(campaign: Campaign): string {
  return sha256Hex(jcsCanonicalize(digestInput(campaign)));
}
