#!/usr/bin/env bun
// test/mock-gauntlet/mock-gauntlet.ts
//
// A zero-token stand-in for the real `gauntlet` binary. The runner spawns the
// literal `gauntlet` (see test/mock-gauntlet/gauntlet), which execs this file.
// Given MOCK_GAUNTLET_FIXTURE, it drops a canned result.json (+ usage.jsonl if
// present) into the project dir's gauntlet-agent results, and a canned claude
// session log under CLAUDE_CONFIG_DIR/projects so the runner's snapshot/diff
// sees it, then exits 0. It emulates:
//   gauntlet run <story> --adapter tui --target <t> --project-dir <dir>
//           --state-dir gauntlet-agent --silent [--max-time ...] [...]
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const pdIdx = argv.indexOf('--project-dir');
const projectDir = pdIdx >= 0 ? argv[pdIdx + 1] : undefined;
const fixture = process.env['MOCK_GAUNTLET_FIXTURE'];
if (projectDir === undefined || fixture === undefined) {
  console.error('mock-gauntlet: need --project-dir and MOCK_GAUNTLET_FIXTURE');
  process.exit(2);
}
const fixtureDir = join(import.meta.dir, 'fixtures', fixture);

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
// CLAUDE_CONFIG_DIR/projects/mock/<runId>.jsonl. That dir is under the resolved
// session_log_dir (${CLAUDE_CONFIG_DIR}/projects), so the runner diffs it in.
const sessionSrc = join(fixtureDir, 'claude-session.jsonl');
if (existsSync(sessionSrc)) {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir !== '') {
    const dest = join(configDir, 'projects', 'mock');
    mkdirSync(dest, { recursive: true });
    cpSync(sessionSrc, join(dest, `${runId}.jsonl`));
  }
}

process.exit(0);
