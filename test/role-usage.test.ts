import { expect, test } from 'bun:test';
import { verifyReturnedTurns } from '../src/runner/role-usage.ts';

const model = 'anthropic.claude-sonnet-5' as const;
const row = {
  type: 'obol.usage',
  v: '2026-06-08',
  provider: 'anthropic',
  model,
  usage: { input_tokens: 3, output_tokens: 2 },
};
const lines = (rows: unknown[]) =>
  `${rows.map((v) => JSON.stringify(v)).join('\n')}\n`;
const events = [
  { type: 'llm_request', turn: 1 },
  { type: 'llm_response', turn: 1 },
  { type: 'llm_request', turn: 2 },
  { type: 'llm_response', turn: 2 },
];
const verify = (run = events, usage: unknown[] = [row, row]) =>
  verifyReturnedTurns({
    model,
    runJsonl: lines(run),
    usageJsonl: lines(usage),
  });
test('a driver has covered returned turns without an assessment run end', () => {
  expect(verify()).toEqual({ returnedTurns: 2, runEndTurns: null });
});
test('a priced subtotal cannot cover two returned responses', () => {
  expect(() => verify(events, [row])).toThrow();
});
for (const [name, run] of [
  ['duplicate response', [...events, events[3]]],
  ['skipped request', [events[0], events[1], { type: 'llm_request', turn: 3 }]],
  ['unfinished request', events.slice(0, 3)],
  ['response without request', events.slice(1)],
  [
    'response after end',
    [
      ...events.slice(0, 2),
      { type: 'run_end', usage: { turns: 1 } },
      ...events.slice(2),
    ],
  ],
  [
    'incorrect end total',
    [...events, { type: 'run_end', usage: { turns: 1 } }],
  ],
] as const)
  test(`rejects ${name}`, () => {
    expect(() =>
      verifyReturnedTurns({
        model,
        runJsonl: lines([...run]),
        usageJsonl: lines([row, row]),
      }),
    ).toThrow();
  });
test('validates the optional run-end count', () => {
  expect(
    verifyReturnedTurns({
      model,
      runJsonl: lines([...events, { type: 'run_end', usage: { turns: 2 } }]),
      usageJsonl: lines([row, row]),
    }),
  ).toEqual({ returnedTurns: 2, runEndTurns: 2 });
});
for (const usage of [
  [row, row, row],
  [{ ...row, model: 'wrong' }, row],
  [{ ...row, usage: { input_tokens: -1, output_tokens: 2 } }, row],
  [
    {
      ...row,
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_creation: { ephemeral_5m_input_tokens: -1 },
      },
    },
    row,
  ],
  [{ ...row, usage: { input_tokens: 3, output_tokens: Infinity } }, row],
])
  test('rejects incorrect raw usage coverage or counters', () =>
    expect(() => verify(events, usage)).toThrow());
test('rejects truncated JSONL on either stream', () => {
  expect(() =>
    verifyReturnedTurns({
      model,
      runJsonl: lines(events).trimEnd(),
      usageJsonl: lines([row, row]),
    }),
  ).toThrow();
  expect(() =>
    verifyReturnedTurns({
      model,
      runJsonl: lines(events),
      usageJsonl: lines([row, row]).trimEnd(),
    }),
  ).toThrow();
});
