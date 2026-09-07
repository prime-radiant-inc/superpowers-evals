import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from '../src/checks/index.ts';
import type { GauntletLayer } from '../src/contracts/verdict.ts';
import {
  captureCascadeVerdict,
  codexMisplacedVerdict,
  postCaptureFailureVerdict,
} from '../src/runner/index.ts';

const REPO = join(import.meta.dir, '..');

// Region 4 — per-normalizer strict-capture / diagnostic cascade. captureCascade-
// Verdict mirrors the Python _run_scenario_inner capture-stage cascade: it
// returns an indeterminate verdict with a backend-specific reason, or null to
// proceed to post-checks. codexMisplacedVerdict mirrors the post-post-check
// codex misplaced-rollout guard.

const GAUNTLET: GauntletLayer = {
  status: 'pass',
  summary: 's',
  reasoning: 'r',
  run_id: 'r1',
};

function freshLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'logdir-'));
}

function base(
  overrides: Partial<Parameters<typeof captureCascadeVerdict>[0]>,
): Parameters<typeof captureCascadeVerdict>[0] {
  const logDir = overrides.logDir ?? freshLogDir();
  return {
    normalizer: 'claude',
    logDir,
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    launchCwd: logDir,
    captureResult: {
      sourceLogs: [],
      rowCount: 0,
      availability: 'unavailable',
      errors: [],
    },
    gauntlet: GAUNTLET,
    preRecords: [],
    runDir: logDir,
    ...overrides,
  };
}

test('strict-capture: claude with no source logs -> capture indeterminate', () => {
  const v = captureCascadeVerdict(base({ normalizer: 'claude' }));
  expect(v?.final).toBe('indeterminate');
  expect(v?.final_reason).toContain('no Claude transcript appeared');
  expect(v?.error?.stage).toBe('capture');
  expect(v?.gauntlet).toEqual(GAUNTLET);
});

test('strict-capture: gemini with source logs but zero rows -> capture indeterminate', () => {
  const logDir = freshLogDir();
  const logPath = join(logDir, 'chat.jsonl');
  writeFileSync(logPath, '{}');
  const v = captureCascadeVerdict(
    base({
      normalizer: 'gemini',
      logDir,
      captureResult: {
        sourceLogs: [logPath],
        rowCount: 0,
        availability: 'unavailable',
        errors: [],
      },
    }),
  );
  expect(v?.final_reason).toContain(
    'transcript(s) normalized to zero tool-call rows',
  );
  expect(v?.error?.stage).toBe('capture');
});

test('strict-capture: claude WITH rows -> null (proceed)', () => {
  const logDir = freshLogDir();
  const logPath = join(logDir, 'chat.jsonl');
  writeFileSync(logPath, '{}');
  const v = captureCascadeVerdict(
    base({
      normalizer: 'claude',
      logDir,
      captureResult: {
        sourceLogs: [logPath],
        rowCount: 3,
        availability: 'available',
        errors: [],
      },
    }),
  );
  expect(v).toBe(null);
});

test('strict-capture: Claude message-only evidence is available and proceeds', () => {
  const logDir = freshLogDir();
  const logPath = join(logDir, 'chat.jsonl');
  writeFileSync(logPath, '{}');
  const v = captureCascadeVerdict(
    base({
      normalizer: 'claude',
      logDir,
      captureResult: {
        sourceLogs: [logPath],
        rowCount: 0,
        availability: 'available',
        errors: [],
      },
    }),
  );
  expect(v).toBe(null);
});

test('codex is NOT a strict-capture name (its empty case is handled post-checks)', () => {
  const v = captureCascadeVerdict(base({ normalizer: 'codex' }));
  expect(v).toBe(null);
});

test('strict-capture: copilot with no source logs -> capture indeterminate', () => {
  const v = captureCascadeVerdict(base({ normalizer: 'copilot' }));
  expect(v?.final).toBe('indeterminate');
  expect(v?.final_reason).toContain('no Copilot transcript appeared');
  expect(v?.error?.stage).toBe('capture');
  expect(v?.gauntlet).toEqual(GAUNTLET);
});

test('strict-capture: copilot with source logs but zero rows -> capture indeterminate', () => {
  const logDir = freshLogDir();
  const logPath = join(logDir, 'events.jsonl');
  writeFileSync(logPath, '{}');
  const v = captureCascadeVerdict(
    base({
      normalizer: 'copilot',
      logDir,
      captureResult: {
        sourceLogs: [logPath],
        rowCount: 0,
        availability: 'unavailable',
        errors: [],
      },
    }),
  );
  expect(v?.final).toBe('indeterminate');
  expect(v?.final_reason).toContain(
    'Copilot transcript(s) normalized to zero tool-call rows',
  );
  expect(v?.error?.stage).toBe('capture');
});

test('pi: no source logs -> "no Pi session appeared" capture indeterminate', () => {
  const v = captureCascadeVerdict(base({ normalizer: 'pi' }));
  expect(v?.final_reason).toContain('no Pi session appeared');
  expect(v?.error?.stage).toBe('capture');
});

test('pi: misplaced session -> qa-agent-misconfigured', () => {
  const logDir = freshLogDir();
  const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  const logPath = join(logDir, 'sess.jsonl');
  // A pi session header whose cwd != launchCwd.
  writeFileSync(
    logPath,
    `${JSON.stringify({ type: 'session', cwd: elsewhere })}\n`,
  );
  const v = captureCascadeVerdict(
    base({
      normalizer: 'pi',
      logDir,
      launchCwd: logDir,
      // capture filtered it out (cwd mismatch) -> no source logs
      captureResult: {
        sourceLogs: [],
        rowCount: 0,
        availability: 'unavailable',
        errors: [],
      },
    }),
  );
  expect(v?.error?.stage).toBe('qa-agent-misconfigured');
  expect(v?.final_reason).toContain('wrong cwd');
});

test('opencode: no export -> "no OpenCode session export appeared"', () => {
  const v = captureCascadeVerdict(base({ normalizer: 'opencode' }));
  expect(v?.final_reason).toContain('no OpenCode session export appeared');
});

test('kimi: source logs with rows but no session-start -> capture indeterminate', () => {
  const logDir = freshLogDir();
  const logPath = join(logDir, 'wire.jsonl');
  writeFileSync(
    logPath,
    `${JSON.stringify({ event: { type: 'tool.call' } })}\n`,
  );
  const v = captureCascadeVerdict(
    base({
      normalizer: 'kimi',
      logDir,
      captureResult: {
        sourceLogs: [logPath],
        rowCount: 2,
        availability: 'available',
        errors: [],
      },
    }),
  );
  expect(v?.final_reason).toContain('plugin_session_start');
  expect(v?.error?.stage).toBe('capture');
});

test('kimi: source logs with rows AND session-start -> null (proceed)', () => {
  const logDir = freshLogDir();
  const logPath = join(logDir, 'wire.jsonl');
  writeFileSync(
    logPath,
    `${JSON.stringify({
      event: {
        type: 'plugin_session_start',
        plugin: 'superpowers',
        skill: 'using-superpowers',
      },
    })}\n`,
  );
  const v = captureCascadeVerdict(
    base({
      normalizer: 'kimi',
      logDir,
      captureResult: {
        sourceLogs: [logPath],
        rowCount: 2,
        availability: 'available',
        errors: [],
      },
    }),
  );
  expect(v).toBe(null);
});

test('codexMisplacedVerdict: empty capture + misplaced rollout -> qa-agent-misconfigured', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const logDir = join(runDir, 'sessions');
  mkdirSync(logDir, { recursive: true });
  const launchCwd = join(runDir, 'coding-agent-workdir');
  mkdirSync(launchCwd, { recursive: true });
  // a codex rollout whose session_meta cwd is INSIDE run_dir but != launch_cwd
  const inside = join(runDir, 'somewhere-else');
  mkdirSync(inside, { recursive: true });
  const logPath = join(logDir, 'rollout.jsonl');
  writeFileSync(
    logPath,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: inside } })}\n`,
  );
  const v = codexMisplacedVerdict({
    captureAvailability: 'unavailable',
    normalizer: 'codex',
    logDir,
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    runDir,
    launchCwd,
  });
  expect(v?.error?.stage).toBe('qa-agent-misconfigured');
  expect(v?.final_reason).toContain('wrong cwd');
});

test('misplaced Codex attribution wins after an unavailable transcript post-check crashes', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const logDir = join(runDir, 'sessions');
  const workdir = join(runDir, 'coding-agent-workdir');
  const inside = join(runDir, 'somewhere-else');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  mkdirSync(inside, { recursive: true });
  writeFileSync(
    join(logDir, 'rollout.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: inside } })}\n`,
  );
  const checksSh = join(runDir, 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() { check-transcript tool-not-called Edit; }\n',
  );

  const post = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    repoRoot: REPO,
    transcriptPath: join(runDir, 'trajectory.json'),
    captureAvailability: 'unavailable',
  });
  expect(post.exitCode).toBe(127);
  expect(post.records).toMatchObject([
    { check: 'tool-not-called', phase: 'post', passed: false },
  ]);

  const verdict = postCaptureFailureVerdict({
    captureAvailability: 'unavailable',
    normalizer: 'codex',
    logDir,
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    runDir,
    launchCwd: workdir,
    gauntlet: GAUNTLET,
    checks: post.records,
    captureEmpty: true,
    expected: null,
    post,
  });

  expect(verdict?.error?.stage).toBe('qa-agent-misconfigured');
  expect(verdict?.gauntlet).toEqual(GAUNTLET);
  expect(verdict?.checks).toEqual([...post.records]);
});

test('codexMisplacedVerdict uses unavailable capture evidence rather than tool count', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const logDir = join(runDir, 'sessions');
  mkdirSync(logDir, { recursive: true });
  const launchCwd = join(runDir, 'coding-agent-workdir');
  const inside = join(runDir, 'somewhere-else');
  mkdirSync(launchCwd, { recursive: true });
  mkdirSync(inside, { recursive: true });
  writeFileSync(
    join(logDir, 'rollout.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: inside } })}\n`,
  );

  const v = codexMisplacedVerdict({
    captureAvailability: 'unavailable',
    normalizer: 'codex',
    logDir,
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    runDir,
    launchCwd,
  });

  expect(v?.error?.stage).toBe('qa-agent-misconfigured');
});

test('codexMisplacedVerdict: empty capture but no misplaced rollout -> null', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const logDir = join(runDir, 'sessions');
  mkdirSync(logDir, { recursive: true });
  const v = codexMisplacedVerdict({
    captureAvailability: 'unavailable',
    normalizer: 'codex',
    logDir,
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    runDir,
    launchCwd: runDir,
  });
  expect(v).toBe(null);
});

test('codexMisplacedVerdict: non-codex normalizer -> null', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const v = codexMisplacedVerdict({
    captureAvailability: 'unavailable',
    normalizer: 'claude',
    logDir: runDir,
    logGlob: '*.jsonl',
    snapshot: new Set<string>(),
    runDir,
    launchCwd: runDir,
  });
  expect(v).toBe(null);
});
