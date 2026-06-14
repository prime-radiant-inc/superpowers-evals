import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseCodingAgentsDirective, runPhase } from '../src/checks/index.ts';

const BIN = resolve(import.meta.dir, '..', 'bin');

test('pre() emitting a passing file-exists record is collected', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() {\n  file-exists present.txt\n}\npost() { :; }\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin: BIN,
  });
  expect(exitCode).toBe(0);
  expect(records).toHaveLength(1);
  const record = records[0];
  expect(record).toBeDefined();
  expect(record).toMatchObject({
    check: 'file-exists',
    args: ['present.txt'],
    negated: false,
    passed: true,
    phase: 'pre',
  });
  expect(record?.args).toEqual(['present.txt']);
});

test('rc 0 with no records yields exitCode 0 and no records', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(checksSh, 'pre() { :; }\npost() { :; }\n');
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin: BIN,
  });
  expect(exitCode).toBe(0);
  expect(records).toEqual([]);
});

test('a bash crash (unbound command) with no records surfaces as a nonzero exitCode', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  // 127 == command not found; no records emitted -> crash, propagated.
  writeFileSync(
    checksSh,
    'pre() {\n  definitely-not-a-real-command\n}\npost() { :; }\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin: BIN,
  });
  expect(records).toEqual([]);
  expect(exitCode).toBe(127);
});

test('parseCodingAgentsDirective reads a leading "# coding-agents:" csv', () => {
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    '# coding-agents: claude, codex\npre() { :; }\npost() { :; }\n',
  );
  expect(parseCodingAgentsDirective(checksSh)).toEqual(['claude', 'codex']);
});

test('parseCodingAgentsDirective returns undefined when no directive present', () => {
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(checksSh, 'pre() { :; }\npost() { :; }\n');
  expect(parseCodingAgentsDirective(checksSh)).toBeUndefined();
});

// Negative-assertion empty-capture guard (oracle 0f6af56, lives in
// bin/tool-not-called + bin/skill-not-called). A negative assertion cannot be
// verified without a transcript: an empty/missing capture means "we don't know",
// not "it wasn't called". The guard must emit a FAIL record rather than vacuously
// pass. These drive both negative tools through runPhase so a regression in the
// shared bash is caught from the TS side. The load-bearing signal is the FAIL
// record (passed:false): the bin tool exits 1, but runPhase's crash heuristic
// normalizes a record-bearing assertion-fail to exitCode 0 — the record, not the
// exit code, is what flips RED if the guard ever vacuously passes again.

test('tool-not-called FAILs against an empty tool-calls capture (no vacuous pass)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const toolCallsPath = join(workdir, 'coding-agent-tool-calls.jsonl');
  writeFileSync(toolCallsPath, '');
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  tool-not-called Edit\n}\n',
  );
  const { records } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    toolCallsPath,
  });
  expect(records[0]).toMatchObject({
    check: 'tool-not-called',
    negated: false,
    passed: false,
  });
});

test('skill-not-called FAILs against an empty tool-calls capture (no vacuous pass)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const toolCallsPath = join(workdir, 'coding-agent-tool-calls.jsonl');
  writeFileSync(toolCallsPath, '');
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  skill-not-called superpowers:foo\n}\n',
  );
  const { records } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    toolCallsPath,
  });
  expect(records[0]).toMatchObject({
    check: 'skill-not-called',
    negated: false,
    passed: false,
  });
});

test('tool-not-called PASSes on a non-empty trace that lacks the tool (positive control)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const toolCallsPath = join(workdir, 'coding-agent-tool-calls.jsonl');
  writeFileSync(toolCallsPath, '{"tool":"Read","args":{}}\n');
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  tool-not-called Edit\n}\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    toolCallsPath,
  });
  expect(exitCode).toBe(0);
  expect(records[0]).toMatchObject({
    check: 'tool-not-called',
    negated: false,
    passed: true,
  });
});

test('skill-not-called PASSes on a non-empty trace that lacks the skill (positive control)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const toolCallsPath = join(workdir, 'coding-agent-tool-calls.jsonl');
  writeFileSync(toolCallsPath, '{"tool":"Read","args":{}}\n');
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  skill-not-called superpowers:foo\n}\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    toolCallsPath,
  });
  expect(exitCode).toBe(0);
  expect(records[0]).toMatchObject({
    check: 'skill-not-called',
    negated: false,
    passed: true,
  });
});
