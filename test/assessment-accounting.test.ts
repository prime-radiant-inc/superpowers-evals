import { expect, test } from 'bun:test';
import {
  reconcileAssessmentAccounting,
  verifyAssessmentAccounting,
} from '../src/runner/role-usage.ts';

const lines = (rows: unknown[]) =>
  rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
const request = (turn = 1) => ({
  type: 'llm_request',
  turn,
  assessment_request_id: String(turn).padStart(3, '0'),
});
const response = (turn = 1) => ({ ...request(turn), type: 'llm_response' });
const admission = (id = '001', req = '001') => ({
  schema_version: 1,
  event: 'admission',
  assessment_request_id: req,
  assessment_attempt_id: id,
  timestamp_ms: 100,
  outcome: 'admitted',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
});
const settlement = (id = '001', req = '001', known = true) => ({
  schema_version: 1,
  event: 'settlement',
  assessment_request_id: req,
  assessment_attempt_id: id,
  timestamp_ms: 110,
  outcome: 'response',
  usage: known ? 'recorded' : 'not_returned',
  ...(known ? {} : { usage_unavailable: 'api_error' }),
  accounting_failure: false,
  capture: 'disabled',
});
const usage = (id = '001', req = '001') => ({
  type: 'obol.usage',
  v: '2026-06-08',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  assessment_attempt_id: id,
  assessment_request_id: req,
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3,
  },
});
const end = (turns: number) => ({ type: 'run_end', usage: { turns } });
function verify(run: unknown[], attempts: unknown[], rows: unknown[]) {
  return verifyAssessmentAccounting({
    runJsonl: lines(run),
    attemptsJsonl: lines(attempts),
    usageJsonl: lines(rows),
  });
}
test('retries reconcile physical rows once and keep unknown coverage', () => {
  expect(
    verify(
      [request(), response(), request(2), response(2), end(2)],
      [
        admission(),
        settlement('001', '001', false),
        admission('002'),
        settlement('002'),
        admission('003', '002'),
        settlement('003', '002'),
      ],
      [usage('002'), usage('003', '002')],
    ),
  ).toEqual({
    logicalResponses: 2,
    physicalAttempts: 3,
    unknownUsageAttemptIds: ['001'],
  });
});
test('a settled retry preserves report eligibility with incomplete cost coverage', () => {
  const result = reconcileAssessmentAccounting({
    runJsonl: lines([request(), response(), end(1)]),
    attemptsJsonl: lines([
      admission(),
      settlement('001', '001', false),
      admission('002'),
      settlement('002'),
    ]),
    usageJsonl: lines([usage('002')]),
  });
  expect(result).toMatchObject({
    reportEligible: true,
    complete: false,
    error: null,
    accounting: {
      logicalResponses: 1,
      physicalAttempts: 2,
      unknownUsageAttemptIds: ['001'],
    },
  });
});
for (const [name, run, attempts, rows] of [
  ['empty history', [], [], []],
  ['zero adapted responses', [request(), end(0)], [], []],
  [
    'missing run_end',
    [request(), response()],
    [admission(), settlement()],
    [usage()],
  ],
  [
    'pending logical request',
    [request(), response(), request(2), end(1)],
    [admission(), settlement()],
    [usage()],
  ],
] as const)
  test(`${name} can describe interruption but cannot qualify a completed report`, () => {
    const input = {
      runJsonl: lines([...run]),
      attemptsJsonl: lines([...attempts]),
      usageJsonl: lines([...rows]),
    };
    expect(() => verifyAssessmentAccounting(input)).not.toThrow();
    expect(reconcileAssessmentAccounting(input)).toMatchObject({
      reportEligible: false,
      complete: false,
      error: null,
    });
  });
test('a missing recorded usage row is ineligible even with completed logical history', () => {
  const result = reconcileAssessmentAccounting({
    runJsonl: lines([request(), response(), end(1)]),
    attemptsJsonl: lines([admission(), settlement()]),
    usageJsonl: '',
  });
  expect(result).toMatchObject({ reportEligible: false, complete: false });
  expect(result.error).toContain('physical usage row/settlement mismatch');
});
for (const run of [[], [request()], [request(), end(0)]])
  test(`honest zero-response interruption: ${lines(run)}`, () => {
    expect(verify(run, [], [])).toEqual({
      logicalResponses: 0,
      physicalAttempts: 0,
      unknownUsageAttemptIds: [],
    });
  });
test('conversion failure keeps known physical usage with no logical response', () => {
  expect(
    verify([request(), end(0)], [admission(), settlement()], [usage()]),
  ).toEqual({
    logicalResponses: 0,
    physicalAttempts: 1,
    unknownUsageAttemptIds: [],
  });
});
test('seal incomplete preserves unknown coverage', () => {
  expect(
    verify(
      [request(), end(0)],
      [
        admission(),
        {
          ...settlement('001', '001', false),
          outcome: 'incomplete',
          usage_unavailable: 'incomplete',
          capture: 'incomplete',
        },
      ],
      [],
    ).unknownUsageAttemptIds,
  ).toEqual(['001']);
});
for (const [name, run, attempts, rows] of [
  [
    'duplicate request',
    [request(), request(), response()],
    [admission(), settlement()],
    [usage()],
  ],
  [
    'duplicate response',
    [request(), response(), response()],
    [admission(), settlement()],
    [usage()],
  ],
  [
    'missing logical request',
    [response()],
    [admission(), settlement()],
    [usage()],
  ],
  [
    'noncanonical request',
    [{ ...request(), assessment_request_id: '1' }, response()],
    [admission(), settlement()],
    [usage()],
  ],
  [
    'wrong run end',
    [request(), response(), end(0)],
    [admission(), settlement()],
    [usage()],
  ],
  [
    'duplicate run end',
    [request(), response(), end(1), end(1)],
    [admission(), settlement()],
    [usage()],
  ],
  ['response without physical attempt', [request(), response()], [], []],
  [
    'duplicate admission',
    [request(), response()],
    [admission(), admission(), settlement()],
    [usage()],
  ],
  ['missing admission', [request(), response()], [settlement()], [usage()]],
  ['missing settlement', [request(), response()], [admission()], [usage()]],
  [
    'duplicate settlement',
    [request(), response()],
    [admission(), settlement(), settlement()],
    [usage()],
  ],
  [
    'wrong settlement request',
    [request(), response()],
    [admission(), settlement('001', '002')],
    [usage()],
  ],
  [
    'unlinked admission',
    [request(), response()],
    [admission('001', '002'), settlement('001', '002')],
    [usage('001', '002')],
  ],
  ['missing usage', [request(), response()], [admission(), settlement()], []],
  [
    'duplicate usage',
    [request(), response()],
    [admission(), settlement()],
    [usage(), usage()],
  ],
  [
    'unlinked usage',
    [request(), response()],
    [admission(), settlement()],
    [usage('002')],
  ],
  [
    'wrong provider',
    [request(), response()],
    [admission(), settlement()],
    [{ ...usage(), provider: 'openai' }],
  ],
  [
    'wrong model',
    [request(), response()],
    [admission(), settlement()],
    [{ ...usage(), model: 'other' }],
  ],
  [
    'invalid returned usage',
    [request(), response()],
    [
      admission(),
      {
        ...settlement(),
        usage: 'invalid',
        usage_unavailable: 'missing_usage',
        accounting_failure: true,
      },
    ],
    [],
  ],
  [
    'unreported row',
    [request(), response()],
    [admission(), settlement('001', '001', false)],
    [usage()],
  ],
] as const)
  test(`rejects ${name}`, () => {
    expect(() => verify([...run], [...attempts], [...rows])).toThrow();
  });
for (const value of [-1, 1.5, '2', null])
  test(`rejects malformed known tokens ${value}`, () => {
    expect(() =>
      verify(
        [request(), response()],
        [admission(), settlement()],
        [{ ...usage(), usage: { input_tokens: value, output_tokens: 5 } }],
      ),
    ).toThrow();
  });
test('OpenAI provider/model follow admission and native cached-token constraints', () => {
  const a = { ...admission(), provider: 'openai', model: 'gpt-5.6-sol' };
  const row = {
    ...usage(),
    provider: 'openai',
    model: 'gpt-5.6-sol',
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  };
  expect(
    verify([request(), response(), end(1)], [a, settlement()], [row])
      .physicalAttempts,
  ).toBe(1);
  expect(() =>
    verify(
      [request(), response()],
      [a, settlement()],
      [
        {
          ...row,
          usage: { ...row.usage, input_tokens_details: { cached_tokens: 13 } },
        },
      ],
    ),
  ).toThrow();
});
test('truncated sidecars cannot qualify as valid accounting', () => {
  expect(() =>
    verifyAssessmentAccounting({
      runJsonl: lines([request(), response()]),
      attemptsJsonl: lines([admission(), settlement()]),
      usageJsonl: `${lines([usage()])}{"type":`,
    }),
  ).toThrow();
});

test('optional native null usage fields retain the producer contract', () => {
  const row = {
    ...usage(),
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  };
  expect(
    verify([request(), response(), end(1)], [admission(), settlement()], [row])
      .physicalAttempts,
  ).toBe(1);
  const openai = {
    ...row,
    provider: 'openai',
    model: 'gpt-5.6-sol',
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      input_tokens_details: null,
      output_tokens_details: null,
    },
  };
  expect(
    verify(
      [request(), response(), end(1)],
      [
        { ...admission(), provider: 'openai', model: 'gpt-5.6-sol' },
        settlement(),
      ],
      [openai],
    ).physicalAttempts,
  ).toBe(1);
});
test('a broken preceding admission cannot erase a later independently linked known row', () => {
  const result = reconcileAssessmentAccounting({
    runJsonl: lines([request(), response(), end(1)]),
    attemptsJsonl: `{"schema_version":\n${lines([admission('002'), settlement('002')])}`,
    usageJsonl: lines([usage('002')]),
  });
  expect(result.error).not.toBeNull();
  expect(result.complete).toBe(false);
  expect(JSON.parse(result.knownUsageJsonl)).toMatchObject({
    assessment_attempt_id: '002',
    usage: { input_tokens: 12, output_tokens: 5 },
  });
});
for (const bad of [
  { cache_creation: { ephemeral_5m_input_tokens: -2 } },
  { output_tokens_details: { reasoning_tokens: -1 } },
])
  test(`rejects malformed native detail counters ${JSON.stringify(bad)}`, () => {
    expect(() =>
      verify(
        [request(), response()],
        [admission(), settlement()],
        [{ ...usage(), usage: { ...usage().usage, ...bad } }],
      ),
    ).toThrow();
  });

for (const finalResponse of [false, true])
  test(`aborted inspection before report request retains both physical attempts: response ${finalResponse}`, () => {
    const aborted = {
      ...settlement('001', '001', false),
      outcome: 'aborted',
      usage_unavailable: 'aborted',
    };
    const secondAdmission = { ...admission('002', '002'), timestamp_ms: 120 };
    const secondSettlement = {
      ...settlement('002', '002', finalResponse),
      timestamp_ms: 130,
      ...(finalResponse
        ? {}
        : { outcome: 'aborted', usage_unavailable: 'aborted' }),
    };
    const result = reconcileAssessmentAccounting({
      runJsonl: lines([
        request(),
        request(2),
        ...(finalResponse ? [response(2)] : []),
        end(finalResponse ? 1 : 0),
      ]),
      attemptsJsonl: lines([
        admission(),
        aborted,
        secondAdmission,
        secondSettlement,
      ]),
      usageJsonl: lines(finalResponse ? [usage('002', '002')] : []),
    });
    expect(result.error).toBeNull();
    expect(result.accounting).toEqual({
      logicalResponses: finalResponse ? 1 : 0,
      physicalAttempts: 2,
      unknownUsageAttemptIds: finalResponse ? ['001'] : ['001', '002'],
    });
    expect(result.reportEligible).toBe(finalResponse);
    expect(result.complete).toBe(false);
  });

for (const fault of ['unsettled', 'response', 'overlap'])
  test(`an abandoned request without settled abort authority is refused: ${fault}`, () => {
    const abandoned = {
      ...settlement('001', '001', false),
      outcome: fault === 'response' ? 'response' : 'aborted',
      usage_unavailable: 'aborted',
      timestamp_ms: fault === 'overlap' ? 121 : 110,
    };
    const result = reconcileAssessmentAccounting({
      runJsonl: lines([request(), request(2), response(2), end(1)]),
      attemptsJsonl: lines([
        admission(),
        ...(fault === 'unsettled' ? [] : [abandoned]),
        { ...admission('002', '002'), timestamp_ms: 120 },
        { ...settlement('002', '002'), timestamp_ms: 130 },
      ]),
      usageJsonl: lines([usage('002', '002')]),
    });
    expect(result.reportEligible).toBe(false);
    expect(result.error).not.toBeNull();
  });

test('recorded physical response discarded at cancellation retains price before a valid final report', () => {
  const result = reconcileAssessmentAccounting({
    runJsonl: lines([request(), request(2), response(2), end(1)]),
    attemptsJsonl: lines([
      admission(),
      { ...settlement(), aborted_at_ms: 105 },
      { ...admission('002', '002'), timestamp_ms: 120 },
      { ...settlement('002', '002'), timestamp_ms: 130 },
    ]),
    usageJsonl: lines([usage(), usage('002', '002')]),
  });
  expect(result.error).toBeNull();
  expect(result.reportEligible).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.accounting).toEqual({
    logicalResponses: 1,
    physicalAttempts: 2,
    unknownUsageAttemptIds: [],
  });
  expect(result.knownUsageJsonl.trim().split('\n')).toHaveLength(2);
});
