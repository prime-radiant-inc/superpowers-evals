import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditExposure,
  classifyBillingExhaustion,
  classifyRateLimit,
  decideExposureAtTerminal,
  ExposureTracker,
  exposureProbeForAgent,
  exposureProbeFromParser,
  exposureWithPrecedence,
  parseRetryAfterMs,
  RATE_LIMIT_MARKERS,
  RETRY_AFTER_MIN_MS,
  senseEvidence,
  terminalEvidenceTexts,
  trajectoryExposureMs,
} from '../src/campaign/sensors.ts';
import { ATIF_NORMALIZERS } from '../src/capture/index.ts';

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

test('C7 per-harness runtime probe registry: probes ride the capture normalizers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const log = join(dir, 'session.jsonl');
  const lines = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-08-27T10:00:05.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-27T10:00:07.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    }),
  ];
  writeFileSync(log, `${lines.join('\n')}\n`);
  const probe = exposureProbeForAgent('claude');
  expect(probe.agent).toBe('claude');
  expect(probe.observe(log)).toBe(Date.parse('2026-08-27T10:00:05.000Z'));
  // A half-written/unparseable log is absence (fail-closed at the decision
  // point, R-SNS-4), never a crash mid-campaign.
  writeFileSync(log, '{"type":"user","timestamp":');
  expect(probe.observe(log)).toBeNull();
  // The registry covers every capture backend; unknown agents fail loud.
  for (const agent of Object.keys(ATIF_NORMALIZERS)) {
    expect(exposureProbeForAgent(agent).agent).toBe(agent);
  }
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

test('C7 D-9 decision + audit: runtime wins, capture fallback, inclusion-flip mints exposure_audit', () => {
  expect(
    decideExposureAtTerminal({ runtimeTsMs: 900, captureTsMs: 1000 }),
  ).toEqual({ tsMs: 900, source: 'runtime' });
  expect(
    decideExposureAtTerminal({ runtimeTsMs: null, captureTsMs: 1000 }),
  ).toEqual({ tsMs: 1000, source: 'capture' });
  expect(
    decideExposureAtTerminal({ runtimeTsMs: null, captureTsMs: null }),
  ).toEqual({ tsMs: null, source: null });
  // Agreement: clean.
  expect(auditExposure({ decidedTsMs: 900, rederivedTsMs: 900 })).toEqual({
    divergent: false,
    inclusionChanged: false,
    invalidationReason: null,
  });
  // Value-only divergence: reported, not invalidating (inclusion unchanged).
  expect(auditExposure({ decidedTsMs: 900, rederivedTsMs: 950 })).toEqual({
    divergent: true,
    inclusionChanged: false,
    invalidationReason: null,
  });
  // Decided included, re-derived would exclude -> block invalidation.
  expect(auditExposure({ decidedTsMs: 900, rederivedTsMs: null })).toEqual({
    divergent: true,
    inclusionChanged: true,
    invalidationReason: 'exposure_audit',
  });
  // Vice versa: decided excluded, re-derived would include.
  expect(auditExposure({ decidedTsMs: null, rederivedTsMs: 900 })).toEqual({
    divergent: true,
    inclusionChanged: true,
    invalidationReason: 'exposure_audit',
  });
});

test('C7 terminal sources: verdict reason + gauntlet result texts are collected, tagged, and classifiable', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'term-'));
  expect(terminalEvidenceTexts(runDir)).toEqual([]);
  writeFileSync(
    join(runDir, 'verdict.json'),
    JSON.stringify({
      final: 'indeterminate',
      final_reason: 'gauntlet errored',
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
  // The collected texts feed senseEvidence under the grader credential:
  // classifier row 1 (grader 429) and row 2 (grader billing) both reachable
  // from the registry's named terminal sources.
  const signals = texts.map((t) =>
    senseEvidence({
      source: t.source,
      role: 'grader',
      credential: { api: 'anthropic' },
      text: t.text,
    }),
  );
  expect(signals[0]).toEqual({
    evidence: '429-match',
    family: 'anthropic',
    cooldownMs: 60_000,
    source: 'verdict_reason',
    role: 'grader',
  });
  expect(signals[1]).toEqual({
    evidence: 'billing-exhaustion',
    family: 'anthropic',
    source: 'gauntlet_result',
    role: 'grader',
  });
});
