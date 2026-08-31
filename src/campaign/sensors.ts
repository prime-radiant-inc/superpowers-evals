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
import type { SUITE_KINDS } from '../contracts/campaign/suite.ts';
import type { BlockReplacementReason } from '../contracts/campaign/typed-failures.ts';

export const RETRY_AFTER_MIN_MS = 5_000;

/** The D-10 evidence-source vocabulary: where a piece of sensor text came
 *  from. Live sources (child stderr, agy.log tail, event stream) are fed by
 *  the dispatcher as they arrive; terminal sources (verdict reason, gauntlet
 *  result) are read at child exit via terminalEvidenceTexts and
 *  gauntletEventStreamTexts. */
export type SensorEvidenceSource =
  | 'child_stderr'
  | 'verdict_reason'
  | 'gauntlet_result'
  | 'event_stream'
  | 'agy_log_tail';

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
  /** The D-10 evidence sources this row is qualified against — ENFORCED by
   *  senseEvidence: evidence from a source a row does not list never
   *  classifies through that row. The cells are exactly the pinned D-10
   *  table's: R-SNS-1 mandates event-stream INTAKE, but it does not amend
   *  these cells, so stream evidence classifies only where a row admits
   *  it. Additions are platform PRs with per-source fixtures. (Typed cause
   *  mapping rides role attribution: the dispatcher supplies
   *  subject|grader by matched credential context, and classifier rows 1/4
   *  map it to grader_/subject_rate_limited.) */
  readonly evidenceSources: readonly SensorEvidenceSource[];
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
    evidenceSources: ['agy_log_tail', 'verdict_reason', 'gauntlet_result'],
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
    evidenceSources: ['child_stderr', 'gauntlet_result'],
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
    evidenceSources: ['child_stderr', 'gauntlet_result'],
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
    evidenceSources: ['child_stderr', 'gauntlet_result'],
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
    evidenceSources: ['child_stderr', 'gauntlet_result'],
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
 *  Parsed retry-after clamps to [5s, family max]; absent -> family default.
 *  When `source` is given, only rows qualified against it participate
 *  (D-10 source enforcement — senseEvidence always passes it; the bare
 *  no-source call is the registry-wide view). */
export function classifyRateLimit(args: {
  api?: string;
  base_url?: string;
  runtimeFamily?: string;
  source?: SensorEvidenceSource;
  text: string;
}): RateLimitMatch | null {
  let best: { row: RateLimitMarkerRow; rank: number } | null = null;
  for (const row of RATE_LIMIT_MARKERS) {
    if (args.source !== undefined && !row.evidenceSources.includes(args.source))
      continue;
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

export type SensorRole = 'subject' | 'grader';

/** Which party PRODUCED a piece of evidence, by source provenance. One
 *  campaign child carries both parties' traffic, so a single text must be
 *  classified against exactly one role: classifying it against both lets a
 *  subject 429 win a grader row whenever the two credentials share a
 *  provider, cooling the wrong pool (D-10: attribution is by child role, and
 *  the marker rows carry no role override).
 *
 *  The child's own channels — its stderr, its agy.log, the verdict quorum
 *  composes for its run — are the SUBJECT's. The Gauntlet-Agent's composed
 *  result and its event stream are the GRADER's. */
export function roleOfEvidenceSource(source: SensorEvidenceSource): SensorRole {
  switch (source) {
    case 'gauntlet_result':
    case 'event_stream':
      return 'grader';
    case 'child_stderr':
    case 'verdict_reason':
    case 'agy_log_tail':
      return 'subject';
  }
}

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
  /** Enforced exactly like the rate-limit rows' evidenceSources. */
  readonly evidenceSources: readonly SensorEvidenceSource[];
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
    // This row is drafted (D-10 pins no billing cells) and its anchor is
    // STREAM-NATIVE by provenance: a turn-1 grader billing death lands the
    // credit-balance body in run.jsonl run_error with NO composed result —
    // without event_stream here, grader_billing_exhausted is unreachable in
    // its documented primary manifestation.
    evidenceSources: ['child_stderr', 'gauntlet_result', 'event_stream'],
  },
  {
    family: 'openai-compatible',
    appliesRank: (ctx) =>
      ctx.api === 'openai-chat' || ctx.api === 'openai-responses' ? 2 : null,
    // OpenAI's insufficient_quota code/type — billing, not throttling, even
    // though the provider delivers it with HTTP status 429. No documented
    // stream-native manifestation (the grader is Anthropic-pinned), so this
    // row keeps the pinned-parallel sources only.
    matches: (text) => /"(?:code|type)"\s*:\s*"insufficient_quota"/i.test(text),
    evidenceSources: ['child_stderr', 'gauntlet_result'],
  },
];

export interface BillingMatch {
  readonly family: string;
}

/** Closed-table billing classification, same rank arbitration and source
 *  enforcement as classifyRateLimit. */
export function classifyBillingExhaustion(
  args: CredentialShape & { source?: SensorEvidenceSource; text: string },
): BillingMatch | null {
  let best: { row: BillingMarkerRow; rank: number } | null = null;
  for (const row of BILLING_MARKERS) {
    if (args.source !== undefined && !row.evidenceSources.includes(args.source))
      continue;
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

/** Rank one classified attribution by the CLASSIFIER's own row order, so
 *  the stored attribution is the most specific signal seen rather than the
 *  last one to arrive (a weak subject 429 never masks later grader billing
 *  exhaustion read off a terminal artifact). Lower = stronger. */
export function sensorAttributionRank(signal: {
  readonly evidence: '429-match' | 'billing-exhaustion';
  readonly role: SensorRole;
}): number {
  if (signal.role === 'grader' && signal.evidence === '429-match') return 1;
  if (signal.role === 'grader') return 2; // billing
  if (signal.evidence === '429-match') return 4;
  return 9; // subject billing: no classifier row (weakest)
}

/** Classify one piece of evidence against the rows qualified for its
 *  source (D-10 enforcement — forbidden-source evidence never classifies).
 *  Billing anchors are checked FIRST: OpenAI delivers insufficient_quota as
 *  an HTTP 429, so one payload can satisfy both tables and the billing
 *  anchor is the more specific claim — the same most-specific-wins
 *  principle as the rank arbitration. */
export function senseEvidence(ev: SensorEvidence): SensorSignal | null {
  const billing = classifyBillingExhaustion({
    ...ev.credential,
    source: ev.source,
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
  const rate = classifyRateLimit({
    ...ev.credential,
    source: ev.source,
    text: ev.text,
  });
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

/** Run-id subdirectories of `<runDir>/gauntlet-agent/results`, newest
 *  first — the same iteration order as the runner's
 *  gauntletLayerFromRunDir. Empty when the results root is absent. */
export function gauntletResultDirs(runDir: string): {
  root: string;
  dirs: string[];
} {
  const root = join(runDir, 'gauntlet-agent', 'results');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root)
      .filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  } catch {
    // no gauntlet results dir
  }
  return { root, dirs };
}

/** Terminal evidence texts from a run dir — the registry's named run-dir
 *  sources, read at child exit (R-SNS-1: artifacts read at terminal):
 *  verdict reason + error message as 'verdict_reason', the newest parseable
 *  gauntlet result's summary + reasoning as 'gauntlet_result' (JSON parsing
 *  un-escapes the strings so provider bodies quoted inside them stay
 *  anchor-matchable). Best-effort collection: a missing or unreadable
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
  const { root, dirs } = gauntletResultDirs(runDir);
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
  return out;
}

/** Every string leaf of a parsed JSON value, in document order. run_error
 *  payloads nest the provider body inside message strings; extracting the
 *  parsed strings (not the raw escaped line) keeps the anchors matchable. */
function deepStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) deepStrings(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepStrings(nested, out);
  }
  return out;
}

/** Gauntlet event-stream intake (R-SNS-1: classification over the gauntlet
 *  child's event stream): the newest run's run.jsonl, one evidence text per
 *  `run_error` record (the stream's error surface — the documented channel
 *  where a grader billing/429 death lands when no result composes).
 *  Best-effort like the other terminal readers; the dispatcher may also
 *  tail the stream live and feed lines through senseEvidence directly. */
export function gauntletEventStreamTexts(
  runDir: string,
): { source: SensorEvidenceSource; text: string }[] {
  const out: { source: SensorEvidenceSource; text: string }[] = [];
  const { root, dirs } = gauntletResultDirs(runDir);
  for (const id of dirs) {
    let raw: string;
    try {
      raw = readFileSync(join(root, id, 'run.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof rec !== 'object' ||
        rec === null ||
        (rec as Record<string, unknown>)['type'] !== 'run_error'
      )
        continue;
      const text = deepStrings(rec).join('\n');
      if (text !== '') out.push({ source: 'event_stream', text });
    }
    break; // one stream per run dir (single-run-per-dir convention)
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

/** Epoch-ms points from JSONL rows via a field picker: ISO-8601 strings are
 *  parsed, finite numbers are taken as epoch ms. Unparseable lines are
 *  skipped — a half-written log reads as fewer points, never a crash. */
function jsonlTimePointsMs(
  text: string,
  pick: (row: Record<string, unknown>) => unknown,
): number[] {
  const out: number[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) continue;
    const v = pick(rec as Record<string, unknown>);
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) out.push(ms);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out.push(v);
    }
  }
  return out;
}

/** Earliest-generation extractor over the harness's ATIF normalizer (for
 *  the harnesses whose normalizers carry the log's own timestamps through
 *  to step.timestamp). A partial/unparseable log yields no stamps. */
function stepTimestampsVia(agent: string): (text: string) => readonly number[] {
  const normalize = ATIF_NORMALIZERS[agent];
  if (normalize === undefined) {
    throw new Error(`no ATIF normalizer for agent '${agent}'`);
  }
  return (text) => {
    try {
      return normalize(text, 'unknown')
        .steps.map((s) =>
          s.timestamp === undefined ? Number.NaN : Date.parse(s.timestamp),
        )
        .filter((ms) => Number.isFinite(ms));
    } catch {
      return [];
    }
  };
}

/** The per-harness runtime exposure derivations (Decision D-9), one row per
 *  LIVE harness (the agents with a coding-agents/<name>.yaml — corpus-replay
 *  ATIF dialects have no live session log to probe). Harnesses whose
 *  normalizer preserves timestamps ride it; the rest derive from the raw
 *  session-log shape they own. Absence (no stamps) is fail-closed at the
 *  decision point (R-SNS-4), never a crash mid-campaign. */
export const EXPOSURE_DERIVATIONS: Record<
  string,
  (text: string) => readonly number[]
> = {
  // Raw derivation: per-record `created_at` ISO stamps (the antigravity
  // normalizer builds its steps without timestamps).
  antigravity: (text) => jsonlTimePointsMs(text, (r) => r['created_at']),
  claude: stepTimestampsVia('claude'),
  codex: stepTimestampsVia('codex'),
  // Copilot: the copilot normalizer carries no timestamps and no
  // repo-verifiable events.jsonl time field exists, so the derivation is
  // fail-closed BY CONSTRUCTION — no stamps, ever; the terminal decision
  // enforces the R-SNS-4 outcome. Copilot mid-run exposure observability is
  // the D-9 qualification-checklist item; a verified real time field is the
  // platform PR that replaces this row.
  copilot: () => [],
  gemini: stepTimestampsVia('gemini'),
  // Hermes session exports are one JSON document with epoch-SECONDS
  // `messages[].timestamp` floats.
  hermes: (text) => {
    try {
      const doc = JSON.parse(text) as { messages?: { timestamp?: unknown }[] };
      return (doc.messages ?? [])
        .map((m) => m.timestamp)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        .map((s) => Math.round(s * 1000));
    } catch {
      return [];
    }
  },
  // Kimi wire.jsonl rows carry numeric epoch-ms `time` (the same convention
  // capture's sessionDurationMs reads).
  kimi: (text) => jsonlTimePointsMs(text, (r) => r['time']),
  opencode: stepTimestampsVia('opencode'),
  // Raw derivation over pi's wire shape (the pi normalizer builds its steps
  // without timestamps): ONLY `type: 'message'` records count — the session
  // header and model_change/thinking_level_change metadata records carry
  // earlier timestamps that are not generation requests.
  pi: (text) =>
    jsonlTimePointsMs(text, (r) =>
      r['type'] === 'message' ? r['timestamp'] : undefined,
    ),
  serf: stepTimestampsVia('serf'),
};

/** The per-harness runtime probe (Decision D-9: probes keyed by the
 *  harness's session-log shape knowledge). Unknown agents fail loud: by
 *  dispatch time every arm's agent is a registered live harness. */
export function exposureProbeForAgent(agent: string): ExposureProbe {
  const parse = EXPOSURE_DERIVATIONS[agent];
  if (parse === undefined) {
    throw new Error(
      `no exposure probe for agent '${agent}' — known agents: ${Object.keys(EXPOSURE_DERIVATIONS).join(', ')}`,
    );
  }
  return exposureProbeFromParser(agent, parse);
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

export type SuiteKind = (typeof SUITE_KINDS)[number];

/** The block-terminal decision outcome: either the established exposure or
 *  the ENFORCED unestablished resolution — never a silent neutral
 *  (R-SNS-4). Gating: a skew breach — the sample is excluded from the
 *  paired comparison and refilled from reserve (R-DSP-9's skew_excluded +
 *  skew_refill journal expression, emitted by the dispatcher).
 *  Exploratory: a rendered caveat. */
export type ExposureTerminalDecision =
  | {
      readonly established: true;
      readonly tsMs: number;
      readonly source: 'runtime' | 'capture';
    }
  | {
      readonly established: false;
      readonly resolution: 'skew_breach_exclude_and_refill' | 'render_caveat';
    };

/** Block-terminal decision (the Decision D-9 decision point): the
 *  runtime-pinned value wins (monotonic single emission); a sample whose
 *  runtime probe never fired may take the capture-derived value; neither
 *  source by decision time resolves to the suite-kind-enforced outcome —
 *  absence is never silently treated as no-exposure. */
export function decideExposureAtTerminal(args: {
  runtimeTsMs: number | null;
  captureTsMs: number | null;
  suiteKind: SuiteKind;
}): ExposureTerminalDecision {
  if (args.runtimeTsMs !== null)
    return { established: true, tsMs: args.runtimeTsMs, source: 'runtime' };
  if (args.captureTsMs !== null)
    return { established: true, tsMs: args.captureTsMs, source: 'capture' };
  return {
    established: false,
    resolution:
      args.suiteKind === 'gating'
        ? 'skew_breach_exclude_and_refill'
        : 'render_caveat',
  };
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
 *  re-derivation. Inclusion in the paired comparison rides the
 *  caller-supplied predicate (the block's exposure skew against the
 *  registered max_exposure_skew, R-DSP-9) — so two PRESENT timestamps
 *  whose difference crosses the skew bound flip inclusion and invalidate
 *  the block, exactly like a presence flip. Absence is excluded fail-closed
 *  before the predicate is consulted; a divergence that leaves inclusion
 *  unchanged is reported without invalidating. */
export function auditExposure(args: {
  decidedTsMs: number | null;
  rederivedTsMs: number | null;
  /** Whether a sample with this established exposure timestamp is included
   *  in the paired comparison. Called only with present timestamps. */
  includedAt: (tsMs: number) => boolean;
}): ExposureAuditResult {
  const included = (v: number | null): boolean =>
    v !== null && args.includedAt(v);
  const inclusionChanged =
    included(args.decidedTsMs) !== included(args.rederivedTsMs);
  return {
    divergent: args.decidedTsMs !== args.rederivedTsMs,
    inclusionChanged,
    invalidationReason: inclusionChanged ? 'exposure_audit' : null,
  };
}
