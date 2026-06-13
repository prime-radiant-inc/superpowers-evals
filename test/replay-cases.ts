import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolCall } from '../src/contracts/verdict.ts';
import { ToolCallSchema } from '../src/contracts/verdict.ts';

// Replay-differential parity harness shared by every per-dialect normalizer
// test. Each test/fixtures/<agent>/cases.json holds an array of cases whose
// `expected` rows are the FROZEN output of the real Python normalizer
// (quorum.normalizers.normalize_<agent>_logs) over the case `input` — see
// tools/gen_ts_replay_fixtures.py. The assertion is therefore a genuine parity
// check: the TS normalizer must reproduce the Python rows. If a case diverges,
// the TS normalizer is wrong — fix the normalizer, do NOT edit the fixture
// (regenerate it from the Python oracle instead).
const ReplayCaseSchema = z.object({
  name: z.string(),
  input: z.string(),
  expected: z.array(ToolCallSchema),
});
const CasesSchema = z.array(ReplayCaseSchema);

type Normalizer = (raw: string) => ToolCall[];

function loadCases(agent: string): z.infer<typeof CasesSchema> {
  const path = resolve(import.meta.dir, 'fixtures', agent, 'cases.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return CasesSchema.parse(parsed);
}

// Register one bun:test per fixture case (plus a non-empty guard) asserting the
// TS normalizer reproduces the frozen Python-oracle rows for `agent`.
export function runReplayCases(agent: string, normalize: Normalizer): void {
  const cases = loadCases(agent);
  test(`${agent}: replay fixture is non-empty`, () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const replayCase of cases) {
    test(`${agent} normalizer reproduces Python rows — ${replayCase.name}`, () => {
      expect(normalize(replayCase.input)).toEqual(replayCase.expected);
    });
  }
}
