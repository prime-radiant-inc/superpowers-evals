import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseClaudeThreads } from '../src/seats/parse-claude.ts';
import { parseCodexThreads } from '../src/seats/parse-codex.ts';
import { markRedundantSuiteRuns } from '../src/seats/redundancy.ts';
import type { SeatEvent } from '../src/seats/types.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'seats');

function suite(timestamp: string, command: string): SeatEvent {
  return {
    kind: 'tool_call',
    tool: 'Bash',
    command,
    timestamp,
    isSuiteRun: true,
    suiteScope: 'full',
    suiteFamilies: ['npm-test'],
  };
}

function patch(timestamp: string): SeatEvent {
  return { kind: 'patch', tool: 'Write', timestamp };
}

function seat(seatId: string, events: SeatEvent[]) {
  return {
    seatId,
    role: 'implementer' as const,
    roleSource: 'description' as const,
    taskLabel: seatId,
    spawnDepth: null,
    parentId: null,
    models: [],
    events,
    firstTimestamp: events[0]?.timestamp ?? '',
  };
}

test('a second run of the same family with no patch between is redundant', () => {
  const marked = markRedundantSuiteRuns([
    seat('a', [suite('2026-08-03T10:00:10.000Z', 'npm test')]),
    seat('b', [suite('2026-08-03T10:00:20.000Z', 'npm test')]),
  ]);
  expect(marked[0]?.events[0]?.redundant).toBe(false);
  expect(marked[1]?.events[0]?.redundant).toBe(true);
});

test('a patch between two runs of the same family makes neither redundant', () => {
  const marked = markRedundantSuiteRuns([
    seat('a', [
      suite('2026-08-03T10:00:10.000Z', 'npm test'),
      patch('2026-08-03T10:00:15.000Z'),
    ]),
    seat('b', [suite('2026-08-03T10:00:20.000Z', 'npm test')]),
  ]);
  expect(marked[0]?.events[0]?.redundant).toBe(false);
  expect(marked[1]?.events[0]?.redundant).toBe(false);
});

test('redundancy is per family and the timeline spans every thread', () => {
  // Interleaved: seat b runs a DIFFERENT family, so it is not redundant even
  // though nothing was patched; seat c repeats a's family and is.
  const marked = markRedundantSuiteRuns([
    seat('a', [suite('2026-08-03T10:00:10.000Z', 'npm test')]),
    seat('b', [
      {
        kind: 'tool_call',
        tool: 'Bash',
        command: 'go test ./...',
        timestamp: '2026-08-03T10:00:12.000Z',
        isSuiteRun: true,
        suiteScope: 'full',
        suiteFamilies: ['go-test'],
      },
    ]),
    seat('c', [suite('2026-08-03T10:00:14.000Z', 'npm test')]),
  ]);
  expect(marked.map((s) => s.events[0]?.redundant)).toEqual([
    false,
    false,
    true,
  ]);
});

test('a run that adds a family not yet seen is not redundant', () => {
  // One call ran npm test AND playwright test. npm test was already run, but
  // playwright test was not, so the call produced new information.
  const marked = markRedundantSuiteRuns([
    seat('a', [suite('2026-08-03T10:00:10.000Z', 'npm test')]),
    seat('b', [
      {
        kind: 'tool_call',
        tool: 'Bash',
        command: 'npm test && npx playwright test',
        timestamp: '2026-08-03T10:00:20.000Z',
        isSuiteRun: true,
        suiteScope: 'full',
        suiteFamilies: ['npm-test', 'playwright-test'],
      },
    ]),
  ]);
  expect(marked[1]?.events[0]?.redundant).toBe(false);
});

test('Claude fixture: the final reviewer re-ran a suite nothing had changed', () => {
  // The implementer wrote src/report.js and ran npm test; the final reviewer
  // then ran npm test twice more with no patch anywhere in between.
  const marked = markRedundantSuiteRuns(
    parseClaudeThreads(
      join(
        FIXTURES,
        'sdd-report-formatter-claude-opus-linux-20260803T000000Z-aaaa',
      ),
    ),
  );
  const suiteRuns = marked.flatMap((s) =>
    s.events
      .filter((e) => e.isSuiteRun === true)
      .map((e) => [s.role, e.redundant] as const),
  );
  expect(suiteRuns).toEqual([
    ['implementer', false],
    ['final_reviewer', true],
    ['final_reviewer', true],
  ]);
});

test('Codex fixture: a landed patch between the two runs clears redundancy', () => {
  // The implementer ran npm test, THEN applied a patch; the final reviewer's
  // npm test therefore tested a tree it had not seen.
  const marked = markRedundantSuiteRuns(
    parseCodexThreads(
      join(
        FIXTURES,
        'sdd-report-formatter-codex-codex_sub-linux-20260803T000000Z-bbbb',
      ),
    ),
  );
  const suiteRuns = marked.flatMap((s) =>
    s.events
      .filter((e) => e.isSuiteRun === true)
      .map((e) => [s.role, e.redundant] as const),
  );
  expect(suiteRuns).toEqual([
    ['implementer', false],
    ['final_reviewer', false],
    ['final_reviewer', false],
  ]);
});
