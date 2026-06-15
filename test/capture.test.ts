import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenToolCalls } from '../src/atif/project.ts';
import type { AtifTrajectory } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import {
  ATIF_TRAJECTORY_FILENAME,
  captureTokenUsage,
  captureToolCalls,
  captureToolCallsWithRetry,
  detectKimiCwdMismatch,
  detectMisplacedCodexRollouts,
  detectMisplacedPiSessions,
  detectUnusablePiSessions,
  diagnoseKimiUnmatchedLogs,
  newFilesSince,
  sessionDurationMs,
  snapshotDir,
} from '../src/capture/index.ts';

// A valid single-tool-call claude session log line (the real assistant-turn
// envelope: a message whose content carries a tool_use block).
const CLAUDE_LOG_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ],
  },
});

/** Read and parse the emitted ATIF trajectory.json from a run dir. */
function readTrajectory(runDir: string): AtifTrajectory {
  return JSON.parse(
    readFileSync(join(runDir, ATIF_TRAJECTORY_FILENAME), 'utf8'),
  ) as AtifTrajectory;
}

test('snapshot then diff finds only new files', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  writeFileSync(join(logDir, 'old.jsonl'), '');
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 'new.jsonl'), '');
  const fresh = newFilesSince(logDir, '**/*.jsonl', snap);
  expect(fresh.map((p) => p.split('/').pop())).toEqual(['new.jsonl']);
});

test('captureToolCalls writes a valid ATIF trajectory.json from claude logs', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: snap,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.rowCount).toBe(1);
  expect(res.path).toBe(join(runDir, ATIF_TRAJECTORY_FILENAME));

  const traj = readTrajectory(runDir);
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent.name).toBe('claude-code');
  expect(flattenToolCalls(traj)).toEqual([
    { tool: 'Bash', args: { command: 'ls' } },
  ]);
});

test('captureToolCalls merges gemini logs by message timestamp, not path', () => {
  // Two gemini session logs: the path-earlier subagent log carries a LATER
  // message timestamp than the path-later main log. The merged trajectory must
  // be in timestamp order (main's Skill first, subagent's Edit second), not path
  // order. The merge subsumes the old gemini-specific ordering special case.
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/chats/**/*.jsonl');
  // Path-earlier (sorts first by relative path): later timestamp.
  const subagentDir = join(logDir, 'workdir', 'chats', 'abc');
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, 'subagent.jsonl'),
    `${JSON.stringify({ kind: 'subagent' })}\n${JSON.stringify({
      type: 'gemini',
      timestamp: '2026-06-12T00:20:31.453Z',
      toolCalls: [
        { id: 'edit-1', name: 'replace', args: { file_path: 'app.js' } },
      ],
    })}\n`,
  );
  // Path-later: earlier timestamp.
  const mainDir = join(logDir, 'workdir', 'chats');
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(
    join(mainDir, 'session-20260612.jsonl'),
    `${JSON.stringify({ kind: 'main' })}\n${JSON.stringify({
      type: 'gemini',
      timestamp: '2026-06-12T00:19:23.695Z',
      toolCalls: [
        {
          id: 'skill-1',
          name: 'activate_skill',
          args: { name: 'writing-plans' },
        },
      ],
    })}\n`,
  );

  const res = captureToolCalls({
    logDir,
    logGlob: '**/chats/**/*.jsonl',
    snapshot: snap,
    normalizer: 'gemini',
    runDir,
    launchCwd: runDir,
  });

  const traj = readTrajectory(runDir);
  expect(validateTrajectory(traj).ok).toBe(true);
  const calls = flattenToolCalls(traj);
  expect(calls.map((c) => c.tool)).toEqual(['Skill', 'Edit']);
  expect(calls[0]?.args['skill']).toBe('superpowers:writing-plans');
  expect(res.rowCount).toBe(2);
});

test('captureToolCalls merges claude logs by message timestamp, not path', () => {
  // Two claude session logs whose steps interleave by timestamp. The
  // path-earlier "main" log carries Bash@t1 and Edit@t3; the path-later
  // "subagent" log carries Read@t2. File order alone would emit
  // [Bash, Edit, Read]; timestamp order interleaves to [Bash, Read, Edit].
  // The Read landing BETWEEN main's two calls proves the merge is
  // timestamp-ordered for claude, not just gemini.
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');

  const assistant = (ts: string, id: string, name: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { content: [{ type: 'tool_use', id, name, input: {} }] },
    });

  // Path-earlier file ("a-main"): Bash@t1, Edit@t3.
  writeFileSync(
    join(logDir, 'a-main.jsonl'),
    `${assistant('2026-06-13T19:00:00.000Z', 'c1', 'Bash')}\n${assistant(
      '2026-06-13T19:00:02.000Z',
      'c3',
      'Edit',
    )}\n`,
  );
  // Path-later file ("b-subagent"): Read@t2 (between main's two calls).
  writeFileSync(
    join(logDir, 'b-subagent.jsonl'),
    `${assistant('2026-06-13T19:00:01.000Z', 'c2', 'Read')}\n`,
  );

  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: snap,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });

  const traj = readTrajectory(runDir);
  expect(validateTrajectory(traj).ok).toBe(true);
  const calls = flattenToolCalls(traj);
  expect(calls.map((c) => c.tool)).toEqual(['Bash', 'Read', 'Edit']);
  expect(res.rowCount).toBe(3);
});

test('captureToolCalls keeps a mid-stream untimestamped step in file order', () => {
  // A single claude log: Bash@t1, a flat top-level tool_use Read with NO
  // timestamp, then Edit@t3. The untimestamped Read must stay BETWEEN its
  // file neighbours, not sink to the tail. (Regression: the merge previously
  // sorted all untimestamped steps to the end, flipping this to [Bash,Edit,Read]
  // and breaking the order-sensitive verbs.)
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');

  const assistant = (ts: string, id: string, name: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { content: [{ type: 'tool_use', id, name, input: {} }] },
    });
  // Flat top-level tool_use with no timestamp.
  const flat = JSON.stringify({
    type: 'tool_use',
    id: 'c2',
    name: 'Read',
    input: {},
  });

  writeFileSync(
    join(logDir, 'session.jsonl'),
    `${assistant('2026-06-13T19:00:00.000Z', 'c1', 'Bash')}\n${flat}\n${assistant(
      '2026-06-13T19:00:02.000Z',
      'c3',
      'Edit',
    )}\n`,
  );

  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: snap,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });

  const traj = readTrajectory(runDir);
  expect(validateTrajectory(traj).ok).toBe(true);
  const calls = flattenToolCalls(traj);
  expect(calls.map((c) => c.tool)).toEqual(['Bash', 'Read', 'Edit']);
  expect(res.rowCount).toBe(3);
});

test('captureToolCalls writes no trajectory when there are no new logs', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: new Set(),
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.rowCount).toBe(0);
  expect(existsSync(join(runDir, ATIF_TRAJECTORY_FILENAME))).toBe(false);
});

test('captureToolCalls removes a stale trajectory on a zero-row recapture', () => {
  // A trajectory written by an earlier pass must not survive a later pass that
  // captures nothing — downstream loaders must see "nothing captured".
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  writeFileSync(
    join(runDir, ATIF_TRAJECTORY_FILENAME),
    JSON.stringify({ stale: true }),
  );
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: new Set(),
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.rowCount).toBe(0);
  expect(existsSync(join(runDir, ATIF_TRAJECTORY_FILENAME))).toBe(false);
});

test('captureToolCalls records attempts === 1', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  const res = captureToolCalls({
    logDir,
    logGlob: '**/*.jsonl',
    snapshot: snap,
    normalizer: 'claude',
    runDir,
    launchCwd: runDir,
  });
  expect(res.attempts).toBe(1);
});

test('captureToolCallsWithRetry: empty first pass, filled on retry via sleep spy', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  let sleeps = 0;
  // The flush race: the session log lands only after the first (empty) diff,
  // simulated by writing it from the injected sleep before the re-diff.
  const sleep = (_ms: number): void => {
    sleeps += 1;
    writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  };
  const res = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
      normalizer: 'claude',
      runDir,
      launchCwd: runDir,
    },
    { sleep },
  );
  expect(res.rowCount).toBe(1);
  expect(res.attempts).toBe(2);
  expect(sleeps).toBe(1);
});

test('captureToolCallsWithRetry: genuinely empty exhausts attempts', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  let sleeps = 0;
  const sleep = (_ms: number): void => {
    sleeps += 1;
  };
  const res = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: new Set(),
      normalizer: 'claude',
      runDir,
      launchCwd: runDir,
    },
    { sleep },
  );
  expect(res.rowCount).toBe(0);
  expect(res.attempts).toBe(3);
  expect(sleeps).toBe(2);
});

test('sessionDurationMs spans ISO-8601 timestamps across files', () => {
  // Two claude/codex-style logs: the span is last-minus-first across BOTH files'
  // ISO-8601 `timestamp` rows, parsed with Z -> +00:00, floored at 0.
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const a = join(logDir, 'a.jsonl');
  const b = join(logDir, 'b.jsonl');
  writeFileSync(
    a,
    `${JSON.stringify({ timestamp: '2026-06-13T19:00:00.000Z' })}\n${JSON.stringify(
      { timestamp: '2026-06-13T19:00:02.000Z' },
    )}\n`,
  );
  writeFileSync(
    b,
    `${JSON.stringify({ timestamp: '2026-06-13T19:00:05.000Z' })}\n`,
  );
  expect(sessionDurationMs([a, b])).toBe(5000);
});

test('sessionDurationMs spans epoch-ms numeric time values (kimi)', () => {
  // Kimi rows carry a numeric epoch-ms `time`; booleans must NOT be counted.
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const f = join(logDir, 'kimi.jsonl');
  writeFileSync(
    f,
    `${JSON.stringify({ time: 1000 })}\n${JSON.stringify({
      time: true,
    })}\n${JSON.stringify({ time: 4500 })}\n`,
  );
  expect(sessionDurationMs([f])).toBe(3500);
});

test('sessionDurationMs returns null when no timestamps are found', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const f = join(logDir, 'empty.jsonl');
  writeFileSync(f, `${JSON.stringify({ kind: 'no-time-here' })}\nnot json\n\n`);
  expect(sessionDurationMs([f])).toBeNull();
  expect(sessionDurationMs(['/does/not/exist.jsonl'])).toBeNull();
});

test('captureToolCallsWithRetry: non-empty first pass does not retry', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  writeFileSync(join(logDir, 's.jsonl'), CLAUDE_LOG_LINE);
  let sleeps = 0;
  const sleep = (_ms: number): void => {
    sleeps += 1;
  };
  const res = captureToolCallsWithRetry(
    {
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
      normalizer: 'claude',
      runDir,
      launchCwd: runDir,
    },
    { sleep },
  );
  expect(res.rowCount).toBe(1);
  expect(res.attempts).toBe(1);
  expect(sleeps).toBe(0);
});

// --- qa-agent-misconfigured detectors (consumed by the Wave-2b runner) ------

test('detectMisplacedCodexRollouts flags rollouts inside run_dir at a wrong cwd', () => {
  // A rollout whose session_meta cwd is INSIDE run_dir but != launch_cwd is the
  // smoking gun that the QA agent skipped `cd $QUORUM_AGENT_CWD`. A rollout AT
  // the launch cwd, or one OUTSIDE run_dir, is not misplaced.
  const logDir = mkdtempSync(join(tmpdir(), 'codex-logs-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const launchCwd = join(runDir, 'workdir');
  mkdirSync(launchCwd, { recursive: true });
  const wrongInside = join(runDir, 'somewhere-else');
  mkdirSync(wrongInside, { recursive: true });

  const snap = snapshotDir(logDir, '**/*.jsonl');
  const misplaced = join(logDir, 'misplaced.jsonl');
  const correct = join(logDir, 'correct.jsonl');
  const outside = join(logDir, 'outside.jsonl');
  writeFileSync(
    misplaced,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: wrongInside } })}\n`,
  );
  writeFileSync(
    correct,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: launchCwd } })}\n`,
  );
  writeFileSync(
    outside,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: mkdtempSync(join(tmpdir(), 'elsewhere-')) } })}\n`,
  );

  expect(
    detectMisplacedCodexRollouts({
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
      runDir,
      launchCwd,
    }),
  ).toEqual([misplaced]);
});

test('detectMisplacedPiSessions flags sessions whose header cwd != launch cwd', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'pi-logs-'));
  const launchCwd = mkdtempSync(join(tmpdir(), 'launch-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  const wrong = join(logDir, 'wrong.jsonl');
  const right = join(logDir, 'right.jsonl');
  writeFileSync(
    wrong,
    `${JSON.stringify({ type: 'session', cwd: mkdtempSync(join(tmpdir(), 'other-')) })}\n`,
  );
  writeFileSync(
    right,
    `${JSON.stringify({ type: 'session', cwd: launchCwd })}\n`,
  );

  expect(
    detectMisplacedPiSessions({
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
      launchCwd,
    }),
  ).toEqual([wrong]);
});

test('detectUnusablePiSessions flags sessions with no identifiable cwd', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'pi-logs-'));
  const launchCwd = mkdtempSync(join(tmpdir(), 'launch-'));
  const snap = snapshotDir(logDir, '**/*.jsonl');
  const usable = join(logDir, 'usable.jsonl');
  const noType = join(logDir, 'no-type.jsonl');
  const noCwd = join(logDir, 'no-cwd.jsonl');
  const malformed = join(logDir, 'malformed.jsonl');
  writeFileSync(
    usable,
    `${JSON.stringify({ type: 'session', cwd: launchCwd })}\n`,
  );
  writeFileSync(
    noType,
    `${JSON.stringify({ type: 'response', cwd: launchCwd })}\n`,
  );
  writeFileSync(noCwd, `${JSON.stringify({ type: 'session' })}\n`);
  writeFileSync(malformed, 'not json\n');

  expect(
    detectUnusablePiSessions({
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: snap,
    }).sort(),
  ).toEqual([malformed, noCwd, noType].sort());
});

function buildKimiHome(target: string): {
  logDir: string;
  match: string;
  wrong: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  const matchDir = join(home, 'sessions', 'wd_target', 'session_match');
  const wrongDir = join(home, 'sessions', 'wd_wrong', 'session_wrong');
  mkdirSync(matchDir, { recursive: true });
  mkdirSync(wrongDir, { recursive: true });
  const match = join(matchDir, 'wire.jsonl');
  const wrong = join(wrongDir, 'wire.jsonl');
  writeFileSync(match, '{}\n');
  writeFileSync(wrong, '{}\n');
  const otherCwd = mkdtempSync(join(tmpdir(), 'kimi-other-'));
  writeFileSync(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionDir: matchDir, workDir: target })}\n${JSON.stringify(
      { sessionDir: wrongDir, workDir: otherCwd },
    )}\n`,
  );
  return { logDir: home, match, wrong };
}

test('diagnoseKimiUnmatchedLogs reports wrong-cwd when an indexed log mismatches', () => {
  // The only new log is the one in session_wrong, whose index workDir != target.
  // No new log matches the launch cwd, but this one IS attributable (to a
  // different workDir), so the diagnosis is wrong-cwd / qa-agent-misconfigured.
  const target = mkdtempSync(join(tmpdir(), 'kimi-target-'));
  const { logDir, wrong } = buildKimiHome(target);
  const diag = diagnoseKimiUnmatchedLogs({
    logDir,
    logGlob: '**/wd_wrong/**/*.jsonl',
    snapshot: new Set(),
    launchCwd: target,
  });
  expect(diag).not.toBeNull();
  expect((diag as NonNullable<typeof diag>).reason).toBe('wrong-cwd');
  expect((diag as NonNullable<typeof diag>).stage).toBe(
    'qa-agent-misconfigured',
  );
  expect((diag as NonNullable<typeof diag>).paths).toEqual([wrong]);
});

test('diagnoseKimiUnmatchedLogs reports unmapped when no index entry attributes the log', () => {
  const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  const sessDir = join(home, 'sessions', 'wd_x', 'session_x');
  mkdirSync(sessDir, { recursive: true });
  const orphan = join(sessDir, 'wire.jsonl');
  const snap = snapshotDir(home, '**/wire.jsonl');
  writeFileSync(orphan, '{}\n');
  // No session_index.jsonl exists, so the log cannot be attributed at all.
  const target = mkdtempSync(join(tmpdir(), 'kimi-target-'));

  const diag = diagnoseKimiUnmatchedLogs({
    logDir: home,
    logGlob: '**/wire.jsonl',
    snapshot: snap,
    launchCwd: target,
  });
  expect(diag).not.toBeNull();
  expect((diag as NonNullable<typeof diag>).reason).toBe('unmapped');
  expect((diag as NonNullable<typeof diag>).stage).toBe('capture');
  expect((diag as NonNullable<typeof diag>).paths).toEqual([orphan]);
});

test('diagnoseKimiUnmatchedLogs returns null when a log matches the launch cwd', () => {
  const target = mkdtempSync(join(tmpdir(), 'kimi-target-'));
  const { logDir } = buildKimiHome(target);
  const snap = new Set<string>(); // everything is new
  expect(
    diagnoseKimiUnmatchedLogs({
      logDir,
      logGlob: '**/wd_target/**/*.jsonl',
      snapshot: snap,
      launchCwd: target,
    }),
  ).toBeNull();
});

test('diagnoseKimiUnmatchedLogs returns null when there are no new logs', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  expect(
    diagnoseKimiUnmatchedLogs({
      logDir,
      logGlob: '**/*.jsonl',
      snapshot: new Set(),
      launchCwd: mkdtempSync(join(tmpdir(), 'kimi-target-')),
    }),
  ).toBeNull();
});

test('detectKimiCwdMismatch returns wrong-cwd paths only, never log contents (no secret leak)', () => {
  const target = mkdtempSync(join(tmpdir(), 'kimi-target-'));
  const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  const wrongDir = join(home, 'sessions', 'wd_wrong', 'session_wrong');
  mkdirSync(wrongDir, { recursive: true });
  const wrong = join(wrongDir, 'wire.jsonl');
  // The wire log body carries a secret that must NEVER surface in diagnostics —
  // detectors return file PATHS only.
  const secret = 'sk-SUPER-SECRET-API-KEY-DO-NOT-LEAK';
  writeFileSync(
    wrong,
    `${JSON.stringify({ type: 'usage.record', note: secret })}\n`,
  );
  const otherCwd = mkdtempSync(join(tmpdir(), 'kimi-other-'));
  writeFileSync(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionDir: wrongDir, workDir: otherCwd })}\n`,
  );
  const snap = new Set<string>();

  const mismatch = detectKimiCwdMismatch({
    logDir: home,
    logGlob: '**/wire.jsonl',
    snapshot: snap,
    launchCwd: target,
  });
  expect(mismatch).toEqual([wrong]);
  // The secret in the log body must not appear anywhere in the returned value.
  expect(JSON.stringify(mismatch).includes(secret)).toBe(false);
});

test('detectKimiCwdMismatch returns [] when reason is not wrong-cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  const sessDir = join(home, 'sessions', 'wd_x', 'session_x');
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(join(sessDir, 'wire.jsonl'), '{}\n');
  expect(
    detectKimiCwdMismatch({
      logDir: home,
      logGlob: '**/wire.jsonl',
      snapshot: new Set(),
      launchCwd: mkdtempSync(join(tmpdir(), 'kimi-target-')),
    }),
  ).toEqual([]);
});

// Antigravity (and any agent) can write its session transcript under a DOT
// directory — agy drops it at brain/<uuid>/.system_generated/logs/transcript.jsonl.
// Bun.Glob skips dot dirs unless dot:true, so a `**/transcript.jsonl` glob must
// still match a transcript nested under `.system_generated` or capture sees an
// empty run and the strict-capture floor wrongly fails it.
test('snapshotDir matches a log nested under a dot-directory', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'capture-dotdir-'));
  const deep = join(logDir, 'sess', '.system_generated', 'logs');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'transcript.jsonl'), '{}\n');
  const snap = snapshotDir(logDir, '**/transcript.jsonl');
  expect(snap.has('sess/.system_generated/logs/transcript.jsonl')).toBe(true);
});

// captureTokenUsage prices the ATIF trajectory (tokens come from there), but
// still stamps the kimi-only tool_result_total_bytes from the raw wire log — the
// UTF-8 byte total of every tool.result output. The trajectory carries the
// tokens; the wire log carries the bytes. Both flow into the frozen usage file.
test('captureTokenUsage stamps kimi tool_result_total_bytes from the raw wire log', async () => {
  const target = mkdtempSync(join(tmpdir(), 'kimi-bytes-target-'));
  const home = mkdtempSync(join(tmpdir(), 'kimi-bytes-home-'));
  const sessDir = join(home, 'sessions', 'wd_target', 'session_a');
  mkdirSync(sessDir, { recursive: true });
  // "café" is 5 UTF-8 bytes, "hi" is 2 -> 7; non-string outputs contribute 0.
  const wireRows = [
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: 't1',
        result: { output: 'café' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: 't2',
        result: { output: 'hi' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'tool.result', toolCallId: 't3', result: { output: 123 } },
    },
  ];
  writeFileSync(
    join(sessDir, 'wire.jsonl'),
    `${wireRows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  writeFileSync(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionDir: sessDir, workDir: target })}\n`,
  );

  // The run dir holds the priced trajectory (tokens) — economics' token source.
  const runDir = mkdtempSync(join(tmpdir(), 'kimi-bytes-run-'));
  const traj: AtifTrajectory = {
    schema_version: 'ATIF-v1.7',
    agent: { name: 'kimi', version: 'unknown', model_name: 'claude-opus-4-8' },
    steps: [
      {
        step_id: 1,
        source: 'agent',
        model_name: 'claude-opus-4-8',
        metrics: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0 },
      },
    ],
  };
  writeFileSync(
    join(runDir, ATIF_TRAJECTORY_FILENAME),
    `${JSON.stringify(traj, null, 2)}\n`,
  );

  const out = await captureTokenUsage({
    logDir: home,
    logGlob: '**/wire.jsonl',
    snapshot: new Set(),
    normalizer: 'kimi',
    runDir,
    launchCwd: target,
  });
  expect(out).not.toBeNull();
  const frozen = JSON.parse(readFileSync(out as string, 'utf8')) as Record<
    string,
    unknown
  >;
  // tokens from the trajectory, bytes from the raw wire log.
  expect(frozen['total_tokens']).toBe(15);
  expect(frozen['tool_result_total_bytes']).toBe(7);
});
