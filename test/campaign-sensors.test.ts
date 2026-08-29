import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditExposure,
  classifyBillingExhaustion,
  classifyRateLimit,
  decideExposureAtTerminal,
  EXPOSURE_DERIVATIONS,
  ExposureTracker,
  exposureProbeForAgent,
  exposureProbeFromParser,
  exposureWithPrecedence,
  gauntletEventStreamTexts,
  parseRetryAfterMs,
  RATE_LIMIT_MARKERS,
  RETRY_AFTER_MIN_MS,
  roleOfEvidenceSource,
  senseEvidence,
  terminalEvidenceTexts,
  trajectoryExposureMs,
} from '../src/campaign/sensors.ts';

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));

test('the v1 registry is exactly the five pinned rows', () => {
  expect(RATE_LIMIT_MARKERS.map((r) => r.family)).toEqual([
    'antigravity',
    'anthropic',
    'openai-compatible',
    'gemini',
    'generic-http-429',
  ]);
});

test('row 1 antigravity: shipped truth — bare/prose 429 trips, embedded hex does not', () => {
  const ctx = { runtimeFamily: 'antigravity' };
  expect(
    classifyRateLimit({ ...ctx, text: 'RESOURCE_EXHAUSTED: quota' })?.family,
  ).toBe('antigravity');
  expect(classifyRateLimit({ ...ctx, text: 'ratelimitexceeded' })?.family).toBe(
    'antigravity',
  );
  expect(classifyRateLimit({ ...ctx, text: 'rate limit 429' })?.family).toBe(
    'antigravity',
  ); // prose 429 MATCHES (shipped)
  expect(
    classifyRateLimit({ ...ctx, text: 'trace id 0xe4291f' })?.family,
  ).not.toBe('antigravity'); // embedded hex does not
  expect(classifyRateLimit({ ...ctx, text: 'all good' })).toBeNull();
  // Row 1 requires the antigravity runtime predicate.
  expect(
    classifyRateLimit({
      runtimeFamily: 'claude',
      api: 'anthropic',
      text: 'rate limit 429',
    })?.family,
  ).not.toBe('antigravity');
});

test('rows 2-5 require provider-shaped structure; model-authored 429 prose never trips them', () => {
  const anthropic = { api: 'anthropic' };
  expect(
    classifyRateLimit({
      ...anthropic,
      text: '{"type":"rate_limit_error","message":"..."}',
    })?.family,
  ).toBe('anthropic');
  expect(
    classifyRateLimit({
      ...anthropic,
      text: 'I kept hitting rate limit 429 in my tests',
    }),
  ).toBeNull(); // no structure
  const openai = { api: 'openai-chat' };
  expect(
    classifyRateLimit({
      ...openai,
      text: '{"error":{"code":"rate_limit_exceeded"}}',
    })?.family,
  ).toBe('openai-compatible');
  expect(
    classifyRateLimit({ ...openai, text: 'HTTP 429 Rate limit reached' })
      ?.family,
  ).toBe('openai-compatible');
  expect(
    classifyRateLimit({ ...openai, text: 'HTTP/1.1 429 Rate limit exceeded' })
      ?.family,
  ).toBe('openai-compatible'); // status-line shape
  expect(
    classifyRateLimit({
      ...openai,
      text: '{"status":429,"message":"Rate limit reached"}',
    })?.family,
  ).toBe('openai-compatible'); // JSON status + Rate limit text
  expect(
    classifyRateLimit({ ...openai, text: 'the model said "rate limit 429"' }),
  ).toBeNull(); // model-authored prose: no provider structure
  expect(
    classifyRateLimit({ ...openai, text: 'HTTP/1.1 429 Too Many Requests' })
      ?.family,
  ).toBe('generic-http-429'); // status without Rate-limit text falls through to row 5
  const gemini = { api: 'gemini' };
  expect(
    classifyRateLimit({
      ...gemini,
      text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}',
    })?.family,
  ).toBe('gemini');
  expect(
    classifyRateLimit({
      ...gemini,
      text: '{"error":{"code":"RESOURCE_EXHAUSTED","message":"quota"}}',
    })?.family,
  ).toBe('gemini');
  expect(classifyRateLimit({ ...gemini, text: 'resource notes' })).toBeNull();
  expect(
    classifyRateLimit({
      ...gemini,
      text: 'the model said RESOURCE_EXHAUSTED happened',
    }),
  ).toBeNull(); // unquoted prose
  expect(
    classifyRateLimit({
      ...gemini,
      text: 'model said "RESOURCE_EXHAUSTED" once in prose',
    }),
  ).toBeNull(); // quoted but no error-payload field shape
  // Generic row: structured status only, never prose; lowest precedence.
  expect(
    classifyRateLimit({ api: 'mantle', text: '"status":429' })?.family,
  ).toBe('generic-http-429');
  expect(
    classifyRateLimit({ api: 'mantle', text: '"status_code": 429' })?.family,
  ).toBe('generic-http-429');
  expect(
    classifyRateLimit({ api: 'mantle', text: 'HTTP/1.1 429 Too Many Requests' })
      ?.family,
  ).toBe('generic-http-429');
  expect(
    classifyRateLimit({ api: 'mantle', text: 'rate limit 429 happened' }),
  ).toBeNull();
});

test('base_url host predicate: api.anthropic.com matches row 2 below an api match', () => {
  expect(
    classifyRateLimit({
      base_url: 'https://api.anthropic.com/v1',
      text: '{"type":"rate_limit_error"}',
    })?.family,
  ).toBe('anthropic');
});

test('precedence: the most specific predicate wins', () => {
  // A stream carrying BOTH an anthropic body and a generic status classifies
  // anthropic (api match > generic fallback).
  expect(
    classifyRateLimit({
      api: 'anthropic',
      text: '{"type":"rate_limit_error"} and "status":429',
    })?.family,
  ).toBe('anthropic');
  // api match (rank 2) beats a base_url HOST match (rank 1): an
  // openai-family credential proxying through api.anthropic.com whose text
  // matches BOTH anchors classifies openai-compatible, never anthropic.
  expect(
    classifyRateLimit({
      api: 'openai-chat',
      base_url: 'https://api.anthropic.com/v1',
      text: '{"type":"rate_limit_error"} {"code":"rate_limit_exceeded"}',
    })?.family,
  ).toBe('openai-compatible');
});

test('retry-after parse + clamp [5s, family max]; absent -> family default', () => {
  // The PARSE is raw; the CLAMP lives in classifyRateLimit — the spec clamps
  // the computed until, not the parsed value.
  expect(parseRetryAfterMs('retry-after: 30')).toBe(30_000);
  expect(parseRetryAfterMs('"retry_after": 2')).toBe(2_000); // raw — clamp applies below
  expect(parseRetryAfterMs('nothing here')).toBeNull();
  // Clamp up to the 5s floor.
  expect(
    classifyRateLimit({
      api: 'anthropic',
      text: '{"type":"rate_limit_error"} retry-after: 2',
    })?.cooldownMs,
  ).toBe(RETRY_AFTER_MIN_MS);
  // Clamp to the family max: anthropic max is 15min.
  expect(
    classifyRateLimit({
      api: 'anthropic',
      text: '{"type":"rate_limit_error"} retry-after: 99999',
    })?.cooldownMs,
  ).toBe(15 * 60_000);
  expect(
    classifyRateLimit({ api: 'anthropic', text: '{"type":"rate_limit_error"}' })
      ?.cooldownMs,
  ).toBe(60_000); // default
  expect(
    classifyRateLimit({ api: 'mantle', text: '"status":429' })?.cooldownMs,
  ).toBe(30_000); // generic default
});

test('ExposureProbe: tail-safe re-read from file start; monotonic single emission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expo-'));
  const log = join(dir, 'session.log');
  writeFileSync(log, 'ts:1000 gen\nts:2000 gen\n');
  const probe = exposureProbeFromParser('test-agent', (text) =>
    [...text.matchAll(/ts:(\d+)/g)].map((m) => Number(m[1])),
  );
  expect(probe.agent).toBe('test-agent');
  expect(probe.observe(log)).toBe(1000); // earliest request wins
  // Truncation/rotation: the file shrinks; observe re-reads from the start.
  writeFileSync(log, 'ts:500 gen\n');
  expect(probe.observe(log)).toBe(500);
  // The tracker pins the FIRST observed value per sample — later observations
  // never move it (monotonic single emission).
  const tracker = new ExposureTracker();
  expect(tracker.observe('s1', 1000)).toBe(true);
  expect(tracker.observe('s1', 500)).toBe(false);
  expect(tracker.value('s1')).toBe(1000);
  expect(tracker.value('s2')).toBeNull();
});

test('exposure source precedence: the gauntlet first-generation mark wins when present (precedence hook)', () => {
  expect(
    exposureWithPrecedence({ gauntletMarkTsMs: 900, probeTsMs: 1000 }),
  ).toBe(900);
  expect(
    exposureWithPrecedence({ gauntletMarkTsMs: null, probeTsMs: 1000 }),
  ).toBe(1000);
  expect(
    exposureWithPrecedence({ gauntletMarkTsMs: null, probeTsMs: null }),
  ).toBeNull();
});

test('M1: HTTP status-line matchers are case-insensitive (openai row + generic row)', () => {
  expect(
    classifyRateLimit({
      api: 'openai-chat',
      text: 'http/1.1 429 Rate limit exceeded',
    })?.family,
  ).toBe('openai-compatible');
  expect(
    classifyRateLimit({ api: 'mantle', text: 'http/1.1 429 Too Many Requests' })
      ?.family,
  ).toBe('generic-http-429');
});

test('C7 role attribution: the same line against both credentials never attributes grader evidence to the subject', () => {
  const line = '{"type":"rate_limit_error","message":"..."}';
  // Grader evidence classified against the GRADER credential: anthropic 429.
  expect(
    senseEvidence({
      source: 'child_stderr',
      role: 'grader',
      credential: { api: 'anthropic' },
      text: line,
    }),
  ).toEqual({
    evidence: '429-match',
    family: 'anthropic',
    cooldownMs: 60_000,
    source: 'child_stderr',
    role: 'grader',
  });
  // The SAME line classified as subject evidence against the subject's
  // openai credential: no anthropic predicate applies -> null, never a
  // subject-attributed match (feeds classifier rows 1/4 correctly).
  expect(
    senseEvidence({
      source: 'child_stderr',
      role: 'subject',
      credential: { api: 'openai-chat' },
      text: line,
    }),
  ).toBeNull();
});

test('C7 billing-exhaustion: anchored provider shapes only; billing outranks the 429 tables', () => {
  const anthropicBilling =
    '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';
  expect(
    senseEvidence({
      source: 'gauntlet_result',
      role: 'grader',
      credential: { api: 'anthropic' },
      text: anthropicBilling,
    }),
  ).toEqual({
    evidence: 'billing-exhaustion',
    family: 'anthropic',
    source: 'gauntlet_result',
    role: 'grader',
  });
  // Model-authored prose: no JSON message-field shape -> no billing signal.
  expect(
    senseEvidence({
      source: 'child_stderr',
      role: 'subject',
      credential: { api: 'anthropic' },
      text: 'my credit balance is too low today',
    }),
  ).toBeNull();
  // OpenAI delivers insufficient_quota as an HTTP 429: the billing anchor is
  // the more specific claim and wins over the 429 tables (else this payload
  // would misclassify as a generic 429-match via its "status":429).
  const openaiQuota =
    '{"status":429,"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}';
  expect(
    senseEvidence({
      source: 'child_stderr',
      role: 'subject',
      credential: { api: 'openai-chat' },
      text: openaiQuota,
    })?.evidence,
  ).toBe('billing-exhaustion');
  // A foreign credential shape never reaches the anthropic billing row.
  expect(
    classifyBillingExhaustion({ api: 'gemini', text: anthropicBilling }),
  ).toBeNull();
});

test('D-10 source enforcement: a row classifies only evidence from its pinned sources', () => {
  const anthropicBody = '{"type":"rate_limit_error","message":"throttled"}';
  const grader = { role: 'grader' as const, credential: { api: 'anthropic' } };
  // Row 2's pinned sources are child stderr + gauntlet result (error text)
  // ONLY — verdict reason and the event stream are NOT among them (R-SNS-1
  // mandates stream INTAKE; it does not amend D-10's pinned row cells).
  expect(
    senseEvidence({ ...grader, source: 'verdict_reason', text: anthropicBody }),
  ).toBeNull();
  expect(
    senseEvidence({ ...grader, source: 'gauntlet_result', text: anthropicBody })
      ?.evidence,
  ).toBe('429-match');
  expect(
    senseEvidence({ ...grader, source: 'event_stream', text: anthropicBody }),
  ).toBeNull();
  // Row 1's pinned sources are agy.log tail + verdict reason + gauntlet
  // result — child stderr is NOT among them.
  const agy = {
    role: 'subject' as const,
    credential: { runtimeFamily: 'antigravity' },
  };
  expect(
    senseEvidence({
      ...agy,
      source: 'agy_log_tail',
      text: 'RESOURCE_EXHAUSTED: quota',
    })?.family,
  ).toBe('antigravity');
  expect(
    senseEvidence({
      ...agy,
      source: 'verdict_reason',
      text: 'RESOURCE_EXHAUSTED: quota',
    })?.family,
  ).toBe('antigravity');
  expect(
    senseEvidence({
      ...agy,
      source: 'child_stderr',
      text: 'RESOURCE_EXHAUSTED: quota',
    }),
  ).toBeNull();
  // Billing rows pin child stderr + gauntlet result + event stream — never
  // verdict reason.
  const billing =
    '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';
  expect(
    senseEvidence({ ...grader, source: 'verdict_reason', text: billing }),
  ).toBeNull();
  // The bare classification API without a source stays unrestricted (the
  // registry-wide view the pinned classifyRateLimit tests exercise).
  expect(
    classifyRateLimit({ api: 'anthropic', text: anthropicBody })?.family,
  ).toBe('anthropic');
});

test('R-SNS-1 gauntlet event-stream intake: run.jsonl run_error records become classifiable event_stream evidence', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'stream-'));
  expect(gauntletEventStreamTexts(runDir)).toEqual([]);
  const resultDir = join(runDir, 'gauntlet-agent', 'results', 'r1');
  mkdirSync(resultDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'run_start', ts: 1 }),
    JSON.stringify({ type: 'llm_request', model: 'claude-sonnet-5' }),
    // Turn-1 grader death: the provider body rides inside the run_error
    // record's nested message string (deep string extraction un-nests it).
    JSON.stringify({
      type: 'run_error',
      error: {
        message:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      },
    }),
    JSON.stringify({
      type: 'run_error',
      error: {
        message: '429 {"type":"rate_limit_error","message":"throttled"}',
      },
    }),
  ];
  writeFileSync(join(resultDir, 'run.jsonl'), `${lines.join('\n')}\n`);
  const texts = gauntletEventStreamTexts(runDir);
  expect(texts.map((t) => t.source)).toEqual(['event_stream', 'event_stream']);
  const signals = texts.map((t) =>
    senseEvidence({
      source: t.source,
      role: 'grader',
      credential: { api: 'anthropic' },
      text: t.text,
    }),
  );
  // The billing row classifies from the stream — its anchor is stream-native
  // (the documented appliance failure lands the credit-balance body in
  // run.jsonl run_error, often with NO composed result). The rate-limit body
  // does NOT: D-10 pins rows 2-5 to child stderr + gauntlet result, and the
  // stream intake does not amend those cells.
  expect(signals[0]?.evidence).toBe('billing-exhaustion');
  expect(signals[1]).toBeNull();
});

test('per-harness exposure derivations: every live harness parses its real session-log shape', () => {
  // The registry covers exactly the live-runnable harnesses (the agents with
  // a coding-agents/<name>.yaml) — corpus-replay ATIF dialects have no live
  // session log to probe.
  const liveHarnesses = readdirSync(
    fileURLToPath(new URL('../coding-agents/', import.meta.url)),
  )
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
  expect(Object.keys(EXPOSURE_DERIVATIONS).sort()).toEqual(liveHarnesses);

  // Each harness's probe parses a REAL session-log fixture to a concrete
  // earliest-generation timestamp — no label-only coverage.
  const cases: { agent: string; path: string; expected: number }[] = [
    // Raw derivations (the ATIF normalizer drops these logs' timestamps).
    {
      agent: 'antigravity',
      path: fixture('antigravity-real-no-usage.jsonl'),
      expected: Date.parse('2026-06-15T02:52:26Z'),
    },
    {
      // The exposure start is the first REQUEST (`type: 'message'` record) —
      // never the session header's or model_change's metadata timestamps.
      agent: 'pi',
      path: fixture('pi-session.slice.jsonl'),
      expected: Date.parse('2026-06-15T21:10:00.000Z'),
    },
    {
      agent: 'hermes',
      path: fixture('hermes-real-session.jsonl'),
      expected: 1784842079846,
    }, // messages[].timestamp epoch-SECONDS -> ms
    {
      agent: 'kimi',
      path: fixture('exposure/kimi-wire.jsonl'),
      expected: 1756288805000,
    }, // numeric epoch-ms `time` (capture's kimi convention)
    // Normalizer-backed derivations (step timestamps survive normalization).
    {
      agent: 'claude',
      path: fixture('claude-2.1.177-real.jsonl'),
      expected: Date.parse('2026-06-13T19:37:26.328Z'),
    },
    {
      agent: 'codex',
      path: fixture('codex-56-exec.slice.jsonl'),
      expected: Date.parse('2026-07-14T08:55:26.637Z'),
    },
    {
      agent: 'gemini',
      path: fixture('exposure/gemini-session.json'),
      expected: Date.parse('2026-08-27T10:00:07.000Z'),
    },
    {
      agent: 'opencode',
      path: fixture('exposure/opencode-session.json'),
      expected: 1756288805000,
    },
    {
      agent: 'serf',
      path: fixture('serf-real-trajectory.json'),
      expected: Date.parse('2026-06-22T17:22:35Z'),
    },
  ];
  for (const c of cases) {
    const probe = exposureProbeForAgent(c.agent);
    expect(probe.agent).toBe(c.agent);
    expect(probe.observe(c.path)).toBe(c.expected);
  }

  // Copilot: the copilot normalizer carries no timestamps and no
  // repo-verifiable events.jsonl time field exists — the derivation is
  // fail-closed BY CONSTRUCTION (no stamps regardless of content; the D-9
  // qualification-checklist item). Even a stray timestamp-bearing row yields
  // nothing: there is no speculative scan codifying a shape no real copilot
  // log is known to have. The null is not a silent no-exposure pass — it
  // flows into the enforced R-SNS-4 terminal outcome.
  const copilot = exposureProbeForAgent('copilot');
  const observed = copilot.observe(fixture('exposure/copilot-events.jsonl'));
  expect(observed).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), 'copilot-'));
  const stray = join(dir, 'events.jsonl');
  writeFileSync(
    stray,
    `${JSON.stringify({ type: 'session.start', timestamp: '2026-08-27T09:59:59.000Z' })}\n`,
  );
  expect(copilot.observe(stray)).toBeNull();
  expect(
    decideExposureAtTerminal({
      runtimeTsMs: observed,
      captureTsMs: null,
      suiteKind: 'gating',
    }),
  ).toEqual({
    established: false,
    resolution: 'skew_breach_exclude_and_refill',
  });

  // A half-written/unparseable log is absence, never a crash mid-campaign.
  const torn = join(dir, 'torn.jsonl');
  writeFileSync(torn, '{"type":"user","timestamp":');
  expect(exposureProbeForAgent('claude').observe(torn)).toBeNull();
  // Unknown agents fail loud.
  expect(() => exposureProbeForAgent('not-an-agent')).toThrow(
    /no exposure probe/,
  );
});

test('C7 capture re-derivation: trajectoryExposureMs reads the first step timestamp; absence is null', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'rederive-'));
  writeFileSync(
    join(runDir, 'trajectory.json'),
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'claude-code', version: 'x' },
      steps: [
        { step_id: 1, source: 'user' }, // no timestamp -> skipped
        { step_id: 2, source: 'agent', timestamp: '2026-08-27T10:00:06.000Z' },
        { step_id: 3, source: 'agent', timestamp: '2026-08-27T10:00:09.000Z' },
      ],
    }),
  );
  expect(trajectoryExposureMs(runDir)).toBe(
    Date.parse('2026-08-27T10:00:06.000Z'),
  );
  expect(trajectoryExposureMs(join(runDir, 'nope'))).toBeNull();
});

test('R-SNS-4 decision point: established value or the enforced gating/exploratory outcome, never a silent neutral', () => {
  // Runtime wins (monotonic single emission); capture fallback.
  expect(
    decideExposureAtTerminal({
      runtimeTsMs: 900,
      captureTsMs: 1000,
      suiteKind: 'gating',
    }),
  ).toEqual({
    established: true,
    tsMs: 900,
    source: 'runtime',
  });
  expect(
    decideExposureAtTerminal({
      runtimeTsMs: null,
      captureTsMs: 1000,
      suiteKind: 'gating',
    }),
  ).toEqual({
    established: true,
    tsMs: 1000,
    source: 'capture',
  });
  // Gating absence is a skew breach: excluded from the paired comparison and
  // refilled from reserve (R-SNS-4/R-DSP-9); exploratory renders a caveat.
  expect(
    decideExposureAtTerminal({
      runtimeTsMs: null,
      captureTsMs: null,
      suiteKind: 'gating',
    }),
  ).toEqual({
    established: false,
    resolution: 'skew_breach_exclude_and_refill',
  });
  expect(
    decideExposureAtTerminal({
      runtimeTsMs: null,
      captureTsMs: null,
      suiteKind: 'exploratory',
    }),
  ).toEqual({
    established: false,
    resolution: 'render_caveat',
  });
});

test('D-9 audit: inclusion rides the paired-comparison predicate — a skew-crossing value divergence mints exposure_audit', () => {
  // The dispatcher supplies the block's inclusion predicate (exposure skew
  // vs the registered max_exposure_skew, R-DSP-9); absence is excluded
  // fail-closed before the predicate is consulted.
  const withinSkew = (tsMs: number): boolean => tsMs <= 1000;
  // Agreement: clean.
  expect(
    auditExposure({
      decidedTsMs: 900,
      rederivedTsMs: 900,
      includedAt: withinSkew,
    }),
  ).toEqual({
    divergent: false,
    inclusionChanged: false,
    invalidationReason: null,
  });
  // Value divergence inside the skew window: reported, not invalidating.
  expect(
    auditExposure({
      decidedTsMs: 900,
      rederivedTsMs: 950,
      includedAt: withinSkew,
    }),
  ).toEqual({
    divergent: true,
    inclusionChanged: false,
    invalidationReason: null,
  });
  // BOTH present, but the re-derived value crosses max_exposure_skew: the
  // decided value included the sample, the re-derived value would exclude
  // it -> block invalidation (D-9).
  expect(
    auditExposure({
      decidedTsMs: 900,
      rederivedTsMs: 1500,
      includedAt: withinSkew,
    }),
  ).toEqual({
    divergent: true,
    inclusionChanged: true,
    invalidationReason: 'exposure_audit',
  });
  // Both present, both outside the window: divergent, inclusion unchanged.
  expect(
    auditExposure({
      decidedTsMs: 1500,
      rederivedTsMs: 1600,
      includedAt: withinSkew,
    }),
  ).toEqual({
    divergent: true,
    inclusionChanged: false,
    invalidationReason: null,
  });
  // Presence flips still invalidate regardless of the predicate (absence is
  // excluded fail-closed).
  expect(
    auditExposure({
      decidedTsMs: 900,
      rederivedTsMs: null,
      includedAt: () => true,
    }),
  ).toEqual({
    divergent: true,
    inclusionChanged: true,
    invalidationReason: 'exposure_audit',
  });
  expect(
    auditExposure({
      decidedTsMs: null,
      rederivedTsMs: 900,
      includedAt: () => true,
    }),
  ).toEqual({
    divergent: true,
    inclusionChanged: true,
    invalidationReason: 'exposure_audit',
  });
  expect(
    auditExposure({
      decidedTsMs: null,
      rederivedTsMs: null,
      includedAt: () => true,
    }),
  ).toEqual({
    divergent: false,
    inclusionChanged: false,
    invalidationReason: null,
  });
});

test('C7 terminal sources: verdict reason + gauntlet result texts are collected, tagged, and source-enforced', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'term-'));
  expect(terminalEvidenceTexts(runDir)).toEqual([]);
  writeFileSync(
    join(runDir, 'verdict.json'),
    JSON.stringify({
      final: 'indeterminate',
      final_reason: 'agy hit RESOURCE_EXHAUSTED',
      error: {
        stage: 'gauntlet',
        message: '{"type":"rate_limit_error","message":"throttled"}',
      },
    }),
  );
  const resultDir = join(runDir, 'gauntlet-agent', 'results', 'r1');
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    join(resultDir, 'result.json'),
    JSON.stringify({
      status: 'investigate',
      summary: 'API error',
      reasoning:
        'The grader died: {"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}',
    }),
  );
  const texts = terminalEvidenceTexts(runDir);
  expect(texts.map((t) => t.source)).toEqual([
    'verdict_reason',
    'gauntlet_result',
  ]);
  // Row 1 is the only row qualified against verdict reason: the antigravity
  // signal in final_reason classifies from it; the anthropic body carried in
  // the same verdict text does NOT (row 2 forbids verdict_reason — D-10
  // pinned sources).
  const verdictText = texts[0]!;
  expect(
    senseEvidence({
      source: verdictText.source,
      role: 'subject',
      credential: { runtimeFamily: 'antigravity' },
      text: verdictText.text,
    })?.family,
  ).toBe('antigravity');
  expect(
    senseEvidence({
      source: verdictText.source,
      role: 'grader',
      credential: { api: 'anthropic' },
      text: verdictText.text,
    }),
  ).toBeNull();
  // Classifier row 2 (grader billing) reachable from the gauntlet result.
  const resultText = texts[1]!;
  expect(
    senseEvidence({
      source: resultText.source,
      role: 'grader',
      credential: { api: 'anthropic' },
      text: resultText.text,
    }),
  ).toEqual({
    evidence: 'billing-exhaustion',
    family: 'anthropic',
    source: 'gauntlet_result',
    role: 'grader',
  });
});

test('evidence source names its producer: the child channels are the subject, the Gauntlet-Agent artifacts are the grader', () => {
  expect(roleOfEvidenceSource('child_stderr')).toBe('subject');
  expect(roleOfEvidenceSource('verdict_reason')).toBe('subject');
  expect(roleOfEvidenceSource('agy_log_tail')).toBe('subject');
  expect(roleOfEvidenceSource('gauntlet_result')).toBe('grader');
  expect(roleOfEvidenceSource('event_stream')).toBe('grader');
});
