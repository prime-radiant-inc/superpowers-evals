import { expect, test } from 'bun:test';
import {
  ConversationRecordSchema,
  EvidenceIndexSchema,
  GauntletRolesSchema,
} from '../src/contracts/conversation.ts';
import { GauntletResultSchema } from '../src/contracts/gauntlet.ts';
import {
  EXIT_CODE_BY_FINAL,
  FINAL_STATUSES,
  type FinalVerdict,
  FinalVerdictSchema,
} from '../src/contracts/verdict.ts';

test('a real verdict.json parses and round-trips', () => {
  const v: FinalVerdict = {
    schema: 1,
    final: 'pass',
    final_reason: 'Gauntlet-Agent passed; no deterministic checks',
    gauntlet: {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'x_20260529T170857Z_32wy',
    },
    checks: [
      {
        check: 'git-repo',
        args: [],
        negated: false,
        passed: true,
        detail: null,
        phase: 'pre',
      },
    ],
    error: null,
    economics: null,
  };
  expect(FinalVerdictSchema.parse(v)).toEqual(v);
});

test('the quorum run exit-code contract encodes every final status distinctly (pass 0, fail 1, indeterminate 2)', () => {
  // Shared by the CLI (which exits with it) and the campaign dispatcher
  // (which reads the child's code back through it): a verdict's exit code
  // must be unique so the reader can tell a verdict-consistent exit from a
  // crash.
  expect(EXIT_CODE_BY_FINAL).toEqual({ pass: 0, fail: 1, indeterminate: 2 });
  const codes = FINAL_STATUSES.map((s) => EXIT_CODE_BY_FINAL[s]);
  expect(new Set(codes).size).toBe(FINAL_STATUSES.length);
});

test('gauntlet result.json validates status and reads run-relevant fields', () => {
  const r = GauntletResultSchema.parse({
    schemaVersion: 5,
    runId: 'x_20260529T170857Z_32wy',
    status: 'fail',
    summary: 's',
    reasoning: 'r',
    duration_ms: 1234,
    config: { model: 'claude-sonnet-4-6', target: 'claude', adapter: 'tui' },
  });
  expect(r.status).toBe('fail');
  expect(r.config?.model).toBe('claude-sonnet-4-6');
});

test('conversation records require a visible reference for completed delivery or refusal', () => {
  const completed = {
    status: 'completed',
    endpoint: 'refusal',
    reason: 'The requested change conflicts with the stated policy.',
    timestamp: '2026-09-07T18:30:00.000Z',
    evidence: {
      path: 'conversation-agent/run/captures/final.txt',
      quote: 'I cannot make that change.',
    },
  } as const;
  expect(ConversationRecordSchema.parse(completed)).toEqual(completed);
  expect(() =>
    ConversationRecordSchema.parse({ ...completed, endpoint: null }),
  ).toThrow();
  expect(() =>
    ConversationRecordSchema.parse({ ...completed, evidence: null }),
  ).toThrow();
  expect(() =>
    ConversationRecordSchema.parse({
      ...completed,
      status: 'timed_out',
      endpoint: 'delivery',
    }),
  ).toThrow();
});

test('conversation wire records reject malformed paths, timestamps, duplicate files, and partial role exits', () => {
  expect(() =>
    ConversationRecordSchema.parse({
      status: 'errored',
      endpoint: null,
      reason: 'child failed',
      timestamp: 'yesterday',
      evidence: { path: '../secret', quote: 'last visible text' },
    }),
  ).toThrow();
  expect(() =>
    EvidenceIndexSchema.parse({ files: ['output/a.js', 'output/a.js'] }),
  ).toThrow();
  expect(() => EvidenceIndexSchema.parse({ files: ['/tmp/a'] })).toThrow();
  expect(() => EvidenceIndexSchema.parse({ files: ['output/../a'] })).toThrow();

  const role = {
    out_dir: 'conversation-agent/conversation-pricing_20260907T183000Z_ab12',
    model: 'claude-sonnet-4-6',
    started_at: null,
    finished_at: null,
    process_exit: null,
    stop_cause: null,
  };
  expect(
    GauntletRolesSchema.parse({ conversation: role, assessment: role }),
  ).toEqual({ conversation: role, assessment: role });
  expect(() =>
    GauntletRolesSchema.parse({
      conversation: { ...role, process_exit: { code: null, signal: null } },
      assessment: role,
    }),
  ).toThrow();
});

test('final verdict accepts conversation evidence and criterion-level assessment', () => {
  const verdict: FinalVerdict = {
    schema: 1,
    final: 'pass',
    final_reason: 'criteria passed',
    gauntlet: {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'conversation-pricing_20260907T183000Z_ab12',
      criteria: [
        { criterion: 'Policy followed', verdict: 'pass', evidence: 'oracle' },
      ],
    },
    checks: [],
    error: null,
    economics: null,
    conversation: {
      status: 'completed',
      endpoint: 'delivery',
      reason: 'Delivered a fix.',
      timestamp: '2026-09-07T18:30:00.000Z',
      evidence: { path: 'evidence/visible/final.txt', quote: 'Fixed.' },
    },
  };
  expect(FinalVerdictSchema.parse(verdict)).toEqual(verdict);
  expect(() =>
    FinalVerdictSchema.parse({
      ...verdict,
      gauntlet: { ...verdict.gauntlet, criteria: [] },
    }),
  ).toThrow();
});
