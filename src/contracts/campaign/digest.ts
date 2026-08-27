// src/contracts/campaign/digest.ts
// JCS (RFC 8785) canonicalization, hand-rolled per the D1 spec's
// implementation contract: no dependency, recursive key sort by UTF-16 code
// units, ES6 number/string serialization (JS semantics already match JCS for
// finite doubles and string escaping), NaN/Infinity rejected. Known failure
// mode this replaces: hashing non-canonicalized JSON.stringify output (see
// src/appliance/container.ts's plain-stringify hash — never do that here).

import type { Campaign } from './campaign.ts';

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

/** A campaign before registration stamps its digest: the digest field is the
 *  one document field that CANNOT exist when the digest is being computed,
 *  so digest creation accepts its absence instead of demanding a
 *  placeholder. */
export type PreDigestCampaign = Omit<Campaign, 'digest'> & {
  readonly digest?: string;
};

/** Strip the advisory/re-derivable fields out of a campaign before
 *  canonicalization (R-REG-4, parent Appendix B digest definition):
 *  estimates_by_arm in every cell, budget.surcharge_applied,
 *  budget.priced_coverage, registered_at, registered_by, campaign_id, and
 *  digest itself. budget.usd_all_in (the registered figure) stays in. The
 *  contention and execution_surface blocks are digest members by default —
 *  absent from the exclusion list, they ride the remainder spread
 *  (Decision D-4). */
export function digestInput(
  campaign: PreDigestCampaign,
): Record<string, unknown> {
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
    budget: {
      usd_all_in: campaign.budget.usd_all_in,
      // surcharge_formula_version is a digest member (absent from the
      // R-REG-4 exclusion list; inclusion is the default). surcharge_applied
      // and priced_coverage stay excluded.
      surcharge_formula_version: campaign.budget.surcharge_formula_version,
    },
  };
}

/** The campaign's identity: SHA-256 over the JCS-canonicalized digest input,
 *  hex-encoded. Refreshing estimates never forks identity — only the frozen
 *  grid, refs, suite, and registered budget figure do. */
export function campaignDigest(campaign: PreDigestCampaign): string {
  return sha256Hex(jcsCanonicalize(digestInput(campaign)));
}
