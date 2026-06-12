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
