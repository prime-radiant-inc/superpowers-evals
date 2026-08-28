// Sensors (kernel D3, R-SNS-1..5; Decisions D-9/D-10): provider-broad
// rate-limit classification over a closed, table-driven marker registry —
// the shipped Antigravity predicate preserved EXACTLY as row 1, anchored
// provider-shaped structure mandatory for the new families (rows 2-5) —
// plus the exposure-measurement contract: per-harness tail-safe probes,
// monotonic single emission, source precedence, decision at block terminal.
// Sensors classify; the dispatcher journals (R-JRN emitters).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agyLogShowsRateLimit } from '../agents/agy-watch.ts';
import { ATIF_NORMALIZERS } from '../capture/index.ts';
import type { BlockReplacementReason } from '../contracts/campaign/typed-failures.ts';

export const RETRY_AFTER_MIN_MS = 5_000;

export interface RateLimitMarkerRow {
  readonly family: string;
  /** Provider/API predicate: returns the SPECIFICITY RANK when this entry
   *  applies to the credential shape, else null. D-10 precedence: runtime
   *  match (3) > credential api match (2) > base_url host match (1) >
   *  generic fallback (0) — the rank is computed per call so one family
   *  with both an api arm and a base_url arm ranks each arm correctly. */
  readonly appliesRank: (ctx: {
    api?: string;
    base_url?: string;
    runtimeFamily?: string;
  }) => number | null;
  /** Structured, case-insensitive where pinned. */
  readonly matches: (text: string) => boolean;
  /** D-10 evidence sources this row is qualified against — registry
   *  metadata for qualification receipts; additions are platform PRs with
   *  per-source fixtures. (Typed cause mapping rides role attribution: the
   *  dispatcher supplies subject|grader by matched credential context, and
   *  classifier rows 1/4 map it to grader_/subject_rate_limited.) */
  readonly evidenceSources: readonly string[];
  readonly retryAfterParsed: boolean;
  readonly defaultCooldownMs: number;
  readonly maxCooldownMs: number;
}

/** The five pinned v1 rows (Decision D-10; REV-2 P-7 literals). Vocabulary
 *  is INITIAL — qualification is the live receipt; additions are platform
 *  PRs with fixtures. */
export const RATE_LIMIT_MARKERS: readonly RateLimitMarkerRow[] = [
  {
    family: 'antigravity',
    appliesRank: (ctx) => (ctx.runtimeFamily === 'antigravity' ? 3 : null),
    // Exact shipped agyLogShowsRateLimit behavior: case-insensitive
    // resource_exhausted | ratelimitexceeded | word-boundaried 429. Bare and
    // prose 429 MATCH; embedded hex (e4291) does not.
    matches: (text) => agyLogShowsRateLimit(text),
    evidenceSources: ['agy.log tail', 'verdict reason', 'gauntlet result'],
    retryAfterParsed: false, // none in signal -> default
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'anthropic',
    // api match ranks ABOVE a base_url host match (D-10 precedence) — the
    // two arms of this family carry different ranks so a foreign-api
    // credential proxying through api.anthropic.com never outranks its own
    // api family's row.
    appliesRank: (ctx) =>
      ctx.api === 'anthropic'
        ? 2
        : ctx.base_url !== undefined &&
            new URL(ctx.base_url).host === 'api.anthropic.com'
          ? 1
          : null,
    matches: (text) => /"type"\s*:\s*"rate_limit_error"/i.test(text),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
    retryAfterParsed: true,
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'openai-compatible',
    appliesRank: (ctx) =>
      ctx.api === 'openai-chat' || ctx.api === 'openai-responses' ? 2 : null,
    // Anchor (D-10 row 3): JSON error body `"code":"rate_limit_exceeded"`, OR
    // an HTTP payload carrying a provider-shaped 429 status — a status-line
    // token (`HTTP/1.1 429`, `HTTP 429`) or `"status":429` JSON — together
    // with `Rate limit` text. Model-authored prose ("rate limit 429") carries
    // neither status shape and never trips (false-positive discipline).
    matches: (text) =>
      /"code"\s*:\s*"rate_limit_exceeded"/i.test(text) ||
      ((/\bHTTP(?:\/[\d.]+)? 429\b/i.test(text) ||
        /"status"\s*:\s*429\b/i.test(text)) &&
        /rate limit/i.test(text)),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
    retryAfterParsed: true,
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'gemini',
    appliesRank: (ctx) => (ctx.api === 'gemini' ? 2 : null),
    // Anchor (D-10 row 4): structured RESOURCE_EXHAUSTED in the error
    // payload — a `"status"`/`"code"` field carrying the enum. Bare or merely
    // quoted prose mentions never trip (false-positive discipline).
    matches: (text) =>
      /"(?:status|code)"\s*:\s*"resource_exhausted"/i.test(text),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
    retryAfterParsed: true,
    defaultCooldownMs: 60_000,
    maxCooldownMs: 15 * 60_000,
  },
  {
    family: 'generic-http-429',
    appliesRank: () => 0, // any credential — lowest precedence
    // Structured HTTP status ONLY: never prose.
    matches: (text) =>
      /"status"\s*:\s*429\b/i.test(text) ||
      /"status_code"\s*:\s*429\b/i.test(text) ||
      /^HTTP\/[\d.]+ 429\b/im.test(text),
    evidenceSources: ['child stderr', 'gauntlet result'],
    retryAfterParsed: false, // none -> default (weak signal, conservative)
    defaultCooldownMs: 30_000,
    maxCooldownMs: 5 * 60_000,
  },
];

/** `retry-after: N` / `"retry_after": N` in seconds, or null. */
export function parseRetryAfterMs(text: string): number | null {
  const m = /retry[-_]after"?\s*[:=]\s*"?(\d+)/i.exec(text);
  if (m === null) return null;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export interface RateLimitMatch {
  readonly family: string;
  readonly cooldownMs: number;
}

/** Closed-table classification: the most specific applicable predicate wins
 *  (per-call rank from appliesRank — api match > base_url host match >
 *  generic); one match per event (first in registry order within a rank).
 *  Parsed retry-after clamps to [5s, family max]; absent -> family default. */
export function classifyRateLimit(args: {
  api?: string;
  base_url?: string;
  runtimeFamily?: string;
  text: string;
}): RateLimitMatch | null {
  let best: { row: RateLimitMarkerRow; rank: number } | null = null;
  for (const row of RATE_LIMIT_MARKERS) {
    const rank = row.appliesRank(args);
    if (rank === null) continue;
    if (!row.matches(args.text)) continue;
    if (best === null || rank > best.rank) {
      best = { row, rank };
    }
  }
  if (best === null) return null;
  const { row } = best;
  let cooldownMs = row.defaultCooldownMs;
  if (row.retryAfterParsed) {
    const parsed = parseRetryAfterMs(args.text);
    if (parsed !== null) {
      cooldownMs = Math.min(
        Math.max(parsed, RETRY_AFTER_MIN_MS),
        row.maxCooldownMs,
      );
    }
  }
  return { family: row.family, cooldownMs };
}

// ---------------------------------------------------------------------------
// Evidence intake (Decision D-10 sources + role attribution; R-SNS-1, R-CLS-3)
// ---------------------------------------------------------------------------

/** The D-10 evidence-source vocabulary: where a piece of sensor text came
 *  from. Live sources (child stderr, agy.log tail, event stream) are fed by
 *  the dispatcher as they arrive; terminal sources (verdict reason, gauntlet
 *  result) are read at child exit via terminalEvidenceTexts. */
export type SensorEvidenceSource =
  | 'child_stderr'
  | 'verdict_reason'
  | 'gauntlet_result'
  | 'event_stream'
  | 'agy_log_tail';

export type SensorRole = 'subject' | 'grader';

/** The credential shape a marker predicate ranks against. */
export interface CredentialShape {
  readonly api?: string;
  readonly base_url?: string;
  readonly runtimeFamily?: string;
}

/** One piece of sensor evidence: text from a named source, attributed to the
 *  child role whose credential context it is classified against. The
 *  dispatcher supplies role + credential (D-10: the row shape carries no
 *  role override); classification runs ONLY against this evidence's own
 *  credential, so a grader-shaped error line carried as subject evidence
 *  never attributes to the subject. */
export interface SensorEvidence {
  readonly source: SensorEvidenceSource;
  readonly role: SensorRole;
  readonly credential: CredentialShape;
  readonly text: string;
}

export interface BillingMarkerRow {
  readonly family: string;
  readonly appliesRank: (ctx: CredentialShape) => number | null;
  readonly matches: (text: string) => boolean;
  readonly evidenceSources: readonly string[];
}

/** Initial anchored billing-exhaustion vocabulary (R-CLS-3: grader billing
 *  exhaustion must be reachable as a typed instrument cause). The D-10
 *  discipline applies unchanged — anchored provider-shaped structure, closed
 *  table, qualification is the live receipt, additions are platform PRs with
 *  fixtures. */
export const BILLING_MARKERS: readonly BillingMarkerRow[] = [
  {
    family: 'anthropic',
    appliesRank: (ctx) =>
      ctx.api === 'anthropic'
        ? 2
        : ctx.base_url !== undefined &&
            new URL(ctx.base_url).host === 'api.anthropic.com'
          ? 1
          : null,
    // Anthropic's credit-exhaustion error: the credit-balance message inside
    // a JSON message field. Model-authored prose mentioning a low credit
    // balance carries no such field shape and never trips.
    matches: (text) =>
      /"message"\s*:\s*"[^"]*credit balance is too low/i.test(text),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
  },
  {
    family: 'openai-compatible',
    appliesRank: (ctx) =>
      ctx.api === 'openai-chat' || ctx.api === 'openai-responses' ? 2 : null,
    // OpenAI's insufficient_quota code/type — billing, not throttling, even
    // though the provider delivers it with HTTP status 429.
    matches: (text) => /"(?:code|type)"\s*:\s*"insufficient_quota"/i.test(text),
    evidenceSources: ['child stderr', 'gauntlet result error text'],
  },
];

export interface BillingMatch {
  readonly family: string;
}

/** Closed-table billing classification, same rank arbitration as
 *  classifyRateLimit. */
export function classifyBillingExhaustion(
  args: CredentialShape & { text: string },
): BillingMatch | null {
  let best: { row: BillingMarkerRow; rank: number } | null = null;
  for (const row of BILLING_MARKERS) {
    const rank = row.appliesRank(args);
    if (rank === null) continue;
    if (!row.matches(args.text)) continue;
    if (best === null || rank > best.rank) {
      best = { row, rank };
    }
  }
  return best === null ? null : { family: best.row.family };
}

/** A classified sensor signal. `evidence` uses the classifier's input
 *  vocabulary verbatim (R-CLS-3 rows 1/2/4); source + role ride through
 *  unchanged so the journal and classifier see the attribution the
 *  dispatcher supplied. */
export type SensorSignal =
  | {
      readonly evidence: '429-match';
      readonly family: string;
      readonly cooldownMs: number;
      readonly source: SensorEvidenceSource;
      readonly role: SensorRole;
    }
  | {
      readonly evidence: 'billing-exhaustion';
      readonly family: string;
      readonly source: SensorEvidenceSource;
      readonly role: SensorRole;
    };

/** Classify one piece of evidence. Billing anchors are checked FIRST:
 *  OpenAI delivers insufficient_quota as an HTTP 429, so one payload can
 *  satisfy both tables and the billing anchor is the more specific claim —
 *  the same most-specific-wins principle as the rank arbitration. */
export function senseEvidence(ev: SensorEvidence): SensorSignal | null {
  const billing = classifyBillingExhaustion({
    ...ev.credential,
    text: ev.text,
  });
  if (billing !== null) {
    return {
      evidence: 'billing-exhaustion',
      family: billing.family,
      source: ev.source,
      role: ev.role,
    };
  }
  const rate = classifyRateLimit({ ...ev.credential, text: ev.text });
  if (rate !== null) {
    return {
      evidence: '429-match',
      family: rate.family,
      cooldownMs: rate.cooldownMs,
      source: ev.source,
      role: ev.role,
    };
  }
  return null;
}

/** Terminal evidence texts from a run dir — the registry's named run-dir
 *  sources, read at child exit (R-SNS-1: artifacts read at terminal):
 *  verdict reason + error message as 'verdict_reason', the newest parseable
 *  gauntlet result's summary + reasoning as 'gauntlet_result' (same
 *  newest-first iteration as the runner's gauntletLayerFromRunDir; JSON
 *  parsing un-escapes the strings so provider bodies quoted inside them
 *  stay anchor-matchable). Best-effort collection: a missing or unreadable
 *  artifact yields no entry — absence composes through the classifier as
 *  'none', never a throw at evidence-collection time. */
export function terminalEvidenceTexts(
  runDir: string,
): { source: SensorEvidenceSource; text: string }[] {
  const out: { source: SensorEvidenceSource; text: string }[] = [];
  try {
    const v = JSON.parse(
      readFileSync(join(runDir, 'verdict.json'), 'utf8'),
    ) as {
      final_reason?: string;
      error?: { message?: string } | null;
    };
    const text = [v.final_reason, v.error?.message]
      .filter((t): t is string => typeof t === 'string' && t !== '')
      .join('\n');
    if (text !== '') out.push({ source: 'verdict_reason', text });
  } catch {
    // no composed verdict — the exit-code heuristic classifies (dispatcher)
  }
  try {
    const root = join(runDir, 'gauntlet-agent', 'results');
    const dirs = readdirSync(root)
      .filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
    for (const id of dirs) {
      let r: { summary?: string; reasoning?: string };
      try {
        r = JSON.parse(readFileSync(join(root, id, 'result.json'), 'utf8')) as {
          summary?: string;
          reasoning?: string;
        };
      } catch {
        continue;
      }
      const text = [r.summary, r.reasoning]
        .filter((t): t is string => typeof t === 'string' && t !== '')
        .join('\n');
      if (text !== '') {
        out.push({ source: 'gauntlet_result', text });
        break;
      }
    }
  } catch {
    // no gauntlet results dir
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exposure measurement (Decision D-9; R-SNS-2/3/4/5)
// ---------------------------------------------------------------------------

export interface ExposureProbe {
  readonly agent: string;
  /** The earliest Coding-Agent generation-request ts_ms from the session
   *  log, or null. TAIL-SAFE: truncation or rotation re-reads from the file
   *  start — every observation is a full read, never an offset. */
  observe(sessionLogPath: string): number | null;
}

/** Per-harness probe over an injected parser (the harness's session-log
 *  shape knowledge already encoded in src/normalize). Production wiring
 *  passes each backend's earliest-generation-request extractor; tests use
 *  fixture parsers. */
export function exposureProbeFromParser(
  agent: string,
  parse: (text: string) => readonly number[],
): ExposureProbe {
  return {
    agent,
    observe(sessionLogPath: string): number | null {
      if (!existsSync(sessionLogPath)) return null;
      let text: string;
      try {
        text = readFileSync(sessionLogPath, 'utf8');
      } catch {
        return null;
      }
      const stamps = parse(text);
      return stamps.length === 0 ? null : Math.min(...stamps);
    },
  };
}

/** The per-harness runtime probe registry (Decision D-9: probes keyed by
 *  the harness's session-log shape knowledge already encoded in
 *  src/normalize/). Each probe parses the LIVE session log with the same
 *  normalizer capture uses and takes the earliest step timestamp; a
 *  half-written or unparseable log yields no stamps — absence, fail-closed
 *  at the decision point (R-SNS-4), never a crash mid-campaign. Unknown
 *  agents fail loud: by dispatch time every arm's agent is a registered
 *  capture backend. */
export function exposureProbeForAgent(agent: string): ExposureProbe {
  const normalize = ATIF_NORMALIZERS[agent];
  if (normalize === undefined) {
    throw new Error(
      `no exposure probe for agent '${agent}' — known agents: ${Object.keys(ATIF_NORMALIZERS).join(', ')}`,
    );
  }
  return exposureProbeFromParser(agent, (text) => {
    try {
      return normalize(text, 'unknown')
        .steps.map((s) =>
          s.timestamp === undefined ? Number.NaN : Date.parse(s.timestamp),
        )
        .filter((ms) => Number.isFinite(ms));
    } catch {
      return [];
    }
  });
}

/** Capture-side re-derivation (Decision D-9: the capture-derived value is
 *  permitted by the block-terminal decision point; R-SNS-2 names sensors
 *  the owner of the measurement): the run dir's ATIF trajectory's first
 *  step timestamp. Tail-safe by construction — a full read at decision
 *  time, never an offset. */
export function trajectoryExposureMs(runDir: string): number | null {
  try {
    const t = JSON.parse(
      readFileSync(join(runDir, 'trajectory.json'), 'utf8'),
    ) as {
      steps?: { timestamp?: string }[];
    };
    const first = t.steps?.find((s) => s.timestamp !== undefined)?.timestamp;
    if (first === undefined) return null;
    const ms = Date.parse(first);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Monotonic single emission per sample: the FIRST observed request
 *  timestamp wins; later observations never move it. */
export class ExposureTracker {
  private readonly first = new Map<string, number>();
  observe(sampleId: string, tsMs: number): boolean {
    if (this.first.has(sampleId)) return false;
    this.first.set(sampleId, tsMs);
    return true;
  }
  value(sampleId: string): number | null {
    return this.first.get(sampleId) ?? null;
  }
}

/** Source precedence (D1, retained): (1) the gauntlet child's first-
 *  generation mark wins when present; (2) the session-log probe. The v1
 *  fixtures trim to this hook — one synthetic-mark proof, no per-harness
 *  (1)-fixtures until a harness emits real marks. */
export function exposureWithPrecedence(args: {
  gauntletMarkTsMs: number | null;
  probeTsMs: number | null;
}): number | null {
  return args.gauntletMarkTsMs ?? args.probeTsMs;
}

export interface ExposureDecision {
  readonly tsMs: number | null;
  readonly source: 'runtime' | 'capture' | null;
}

/** Block-terminal decision (the Decision D-9 decision point): the
 *  runtime-pinned value wins (monotonic single emission); a sample whose
 *  runtime probe never fired may take the capture-derived value; neither
 *  source by decision time -> null. Absence is fail-closed (R-SNS-4): the
 *  dispatcher excludes gating samples and refills from reserve — null is
 *  never silently treated as no-exposure. */
export function decideExposureAtTerminal(args: {
  runtimeTsMs: number | null;
  captureTsMs: number | null;
}): ExposureDecision {
  if (args.runtimeTsMs !== null)
    return { tsMs: args.runtimeTsMs, source: 'runtime' };
  if (args.captureTsMs !== null)
    return { tsMs: args.captureTsMs, source: 'capture' };
  return { tsMs: null, source: null };
}

export interface ExposureAuditResult {
  readonly divergent: boolean;
  readonly inclusionChanged: boolean;
  /** Non-null exactly when the divergence flips inclusion — the D-9
   *  invalidation the dispatcher journals as block_replaced
   *  { kind: 'replacement', reason: 'exposure_audit' } (dispatch-live) or
   *  adjudicates at seal (post-dispatch). Sensors classify; the dispatcher
   *  journals. */
  readonly invalidationReason: Extract<
    BlockReplacementReason,
    'exposure_audit'
  > | null;
}

/** D-9 exposure audit: the decision-time value vs the capture
 *  re-derivation. A value-only divergence (both present, different) is
 *  reported but does not invalidate; a divergence that changes inclusion
 *  (the decided value included the sample in the paired comparison and the
 *  re-derived value would exclude it, or vice versa) invalidates the
 *  block. */
export function auditExposure(args: {
  decidedTsMs: number | null;
  rederivedTsMs: number | null;
}): ExposureAuditResult {
  const inclusionChanged =
    (args.decidedTsMs === null) !== (args.rederivedTsMs === null);
  return {
    divergent: args.decidedTsMs !== args.rederivedTsMs,
    inclusionChanged,
    invalidationReason: inclusionChanged ? 'exposure_audit' : null,
  };
}
