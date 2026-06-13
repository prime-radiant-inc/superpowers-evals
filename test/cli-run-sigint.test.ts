import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';

// Receiver side of the graceful-stop chain (the dashboard Stop button's
// load-bearing path): `quorum run` under SIGINT must forward the signal to the
// gauntlet child, write a stopped (indeterminate) verdict so the cell resolves
// instead of vanishing under the dead-pid rule, and exit 2. The pure pieces
// (buildStoppedVerdict / writeStoppedVerdict) are covered in
// runner-stopped.test.ts; this goes one level up and drives the real CLI under
// the mock gauntlet's `hang` fixture, then signals it.

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
// The REAL coding-agents/ dir (same rationale as cli-run.test.ts): a claude run
// requires claude-context/ + claude.project-prompt.md, which only live here.
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-sigint-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

// Resolve, then sleep, then resolve again — a poll tick.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll `predicate` until it returns a non-undefined value or the deadline
// passes; returns the value or undefined on timeout. Deterministic readiness
// without a fixed-sleep race.
async function pollFor<T>(
  predicate: () => T | undefined,
  deadlineMs: number,
  stepMs = 25,
): Promise<T | undefined> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = predicate();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() >= end) {
      return undefined;
    }
    await sleep(stepMs);
  }
}

// The single child dir of `outRoot` that holds the hang marker the mock writes,
// or undefined while none does yet. The marker is the runDir (the mock's
// --project-dir) and carries the mock's pid.
function hangRunDir(outRoot: string): string | undefined {
  if (!existsSync(outRoot)) {
    return undefined;
  }
  for (const name of readdirSync(outRoot)) {
    const dir = join(outRoot, name);
    if (existsSync(join(dir, 'mock-gauntlet-hang.pid'))) {
      return dir;
    }
  }
  return undefined;
}

// True once the OS reports no process for `pid` (kill(pid, 0) -> ESRCH).
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test('quorum run forwards SIGINT and writes a stopped verdict (exit 2)', async () => {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-sigint-'));
  const child = spawn(
    'bun',
    [
      CLI,
      'run',
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
    ],
    {
      env: {
        ...process.env,
        PATH: `${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
        MOCK_GAUNTLET_FIXTURE: 'hang',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // The child must outlive this test body even if an assertion throws; reap it.
  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code));
  });

  try {
    // Wait until the runner is parked mid-invokeGauntlet (phase `agent`, a live
    // gauntlet child): the mock writes its marker only after it has entered hang
    // mode and installed its own SIGINT handler. Polling the marker is the
    // race-free readiness gate.
    const runDir = await pollFor(() => hangRunDir(outRoot), 30_000);
    expect(runDir).toBeDefined();
    if (runDir === undefined) {
      throw new Error('mock gauntlet never reached hang mode');
    }

    // The phase the runner owns at this point is `agent` (it writes phase.json
    // `agent` right before invokeGauntlet) — a second, independent confirmation
    // that we are signaling at the right moment.
    const phaseRaw = readFileSync(join(runDir, 'phase.json'), 'utf8');
    expect(JSON.parse(phaseRaw).phase).toBe('agent');

    const mockPid = Number.parseInt(
      readFileSync(join(runDir, 'mock-gauntlet-hang.pid'), 'utf8').trim(),
      10,
    );
    expect(Number.isInteger(mockPid)).toBe(true);
    expect(mockPid).toBeGreaterThan(0);

    // Signal the CLI. onSigint forwards SIGINT to the gauntlet child, writes the
    // stopped verdict, and exits 2.
    child.kill('SIGINT');

    const code = await exited;
    expect(code).toBe(2);

    // verdict.json: indeterminate, error.stage stopped, identity stamped.
    const verdictPath = join(runDir, 'verdict.json');
    expect(existsSync(verdictPath)).toBe(true);
    const verdict = FinalVerdictSchema.parse(
      JSON.parse(readFileSync(verdictPath, 'utf8')),
    );
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('stopped');
    // Identity is stamped on the stopped verdict (the scenario dir's name, the
    // agent, and the run-start time the CLI shares with the happy path).
    const {
      scenario: scn,
      coding_agent: agent,
      started_at: startedAt,
    } = verdict;
    expect(typeof scn).toBe('string');
    expect(scn).not.toBe('');
    expect(agent).toBe('claude');
    expect(typeof startedAt).toBe('string');
    expect(startedAt).not.toBe('');

    // No orphaned mock gauntlet: the forwarded SIGINT terminated it. Bounded
    // poll — the child's exit is asynchronous after the forward.
    const gone = await pollFor(
      () => (pidGone(mockPid) ? true : undefined),
      10_000,
    );
    expect(gone).toBe(true);
  } finally {
    // Belt and suspenders: if anything above threw before the CLI exited, make
    // sure neither the CLI nor a leaked mock survives the test.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
  }
}, 60_000);
