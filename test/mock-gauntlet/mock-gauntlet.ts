#!/usr/bin/env bun
// test/mock-gauntlet/mock-gauntlet.ts
//
// A zero-token stand-in for the real `gauntlet` binary. The runner spawns the
// literal `gauntlet` (see test/mock-gauntlet/gauntlet), which execs this file.
// Given MOCK_GAUNTLET_FIXTURE, it drops a canned result.json (+ usage.jsonl if
// present) into the project dir's gauntlet-agent results, and a canned claude
// session log under $QUORUM_AGENT_HOME/.claude/projects so the runner's
// snapshot/diff sees it, then exits 0. It emulates:
//   gauntlet run <story> --adapter tui --target <t> --project-dir <dir>
//           --state-dir gauntlet-agent --silent [--max-time ...] [...]
// The special `hang` fixture is the exception: it parks (see below) so the
// graceful-SIGINT receiver test can interrupt the runner mid-flight.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const pdIdx = argv.indexOf('--project-dir');
const projectDir = pdIdx >= 0 ? argv[pdIdx + 1] : undefined;
const fixture = process.env['MOCK_GAUNTLET_FIXTURE'];
if (projectDir === undefined || fixture === undefined) {
  console.error('mock-gauntlet: need --project-dir and MOCK_GAUNTLET_FIXTURE');
  process.exit(2);
}

// `hang` mode: the graceful-SIGINT receiver test (test/cli-run-sigint.test.ts)
// needs the runner parked mid-invokeGauntlet with a live gauntlet child. Instead
// of dropping a result and exiting, write a marker (carrying this mock's pid) so
// the test can poll for readiness without a fixed-sleep race, install a SIGINT
// handler that exits non-zero — the runner's onSigint forwards SIGINT here, so
// catching it proves the forward landed and leaves no orphan — then sleep long
// enough to be interrupted. No fixture dir is read in this mode.
if (fixture === 'hang') {
  process.once('SIGINT', () => {
    process.exit(130);
  });
  writeFileSync(join(projectDir, 'mock-gauntlet-hang.pid'), `${process.pid}\n`);
  // Long enough to be interrupted; a guard timeout (well under the test's
  // bounded wait) keeps a leaked mock from lingering if the signal never lands.
  setTimeout(() => {
    process.exit(0);
  }, 60_000);
} else {
  const fixtureDir = join(import.meta.dir, 'fixtures', fixture);

  // 0) opt-in finite-key env capture (test/gauntlet-env.test.ts): only when
  // the generated shim exported MOCK_GAUNTLET_ENV_KEYS, and only those keys.
  // Never a full env dump — the child env legitimately carries the grader
  // credential, and a full dump would persist a real token to disk.
  const captureKeys = process.env['MOCK_GAUNTLET_ENV_KEYS'];
  if (captureKeys !== undefined && captureKeys !== '') {
    const capture: Record<string, string> = {};
    for (const key of captureKeys.split(',')) {
      const value = process.env[key];
      if (value !== undefined) capture[key] = value;
    }
    writeFileSync(
      join(projectDir, 'mock-gauntlet-env.json'),
      `${JSON.stringify(capture, null, 2)}\n`,
    );
  }

  // 1) gauntlet result artifacts: <project-dir>/gauntlet-agent/results/<runId>/.
  const runId = `mock_${fixture}_0000`;
  const resultsDir = join(projectDir, 'gauntlet-agent', 'results', runId);
  mkdirSync(resultsDir, { recursive: true });
  cpSync(join(fixtureDir, 'result.json'), join(resultsDir, 'result.json'));
  const usageSrc = join(fixtureDir, 'usage.jsonl');
  if (existsSync(usageSrc)) {
    cpSync(usageSrc, join(resultsDir, 'usage.jsonl'));
  }

  // 2) canned coding-agent session log into
  // $QUORUM_AGENT_HOME/.claude/projects/mock/<runId>.jsonl. That dir is under the
  // resolved session_log_dir (${QUORUM_AGENT_HOME}/.claude/projects), where the
  // real claude writes via its $HOME/.claude default, so the runner diffs it in.
  const sessionSrc = join(fixtureDir, 'claude-session.jsonl');
  if (existsSync(sessionSrc)) {
    const agentHome = process.env['QUORUM_AGENT_HOME'];
    if (agentHome !== undefined && agentHome !== '') {
      const dest = join(agentHome, '.claude', 'projects', 'mock');
      mkdirSync(dest, { recursive: true });
      cpSync(sessionSrc, join(dest, `${runId}.jsonl`));
    }
  }

  process.exit(0);
}
