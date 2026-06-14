import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseCodingAgentsDirective, runPhase } from '../src/checks/index.ts';

const BIN = resolve(import.meta.dir, '..', 'bin');

function checksShWith(body: string): string {
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(checksSh, body);
  return checksSh;
}

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

// E-directive-missing-file-crash: Python guards `if not checks_sh.exists():
// return None` (quorum/checks.py:49-50). The TS bridge unconditionally read the
// file, throwing ENOENT — which crashes the whole matrix/run-all build for a
// story-only scenario dir. Parity: a missing checks.sh is un-gated (undefined).
test('parseCodingAgentsDirective returns undefined for a missing checks.sh (no crash)', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  expect(parseCodingAgentsDirective(missing)).toBeUndefined();
});

// E-directive-leading-whitespace: Python's regex `^\s*#\s*coding-agents:`
// (quorum/checks.py:41) allows leading whitespace before the `#`. The TS regex
// anchored on `^#`, silently dropping an indented directive.
test('parseCodingAgentsDirective honors a leading-whitespace directive line', () => {
  const checksSh = checksShWith(
    '   # coding-agents: claude, codex\npre() { :; }\npost() { :; }\n',
  );
  expect(parseCodingAgentsDirective(checksSh)).toEqual(['claude', 'codex']);
});

// E-directive-empty-returns-undefined: a directive line whose value is only
// separators (`# coding-agents: ,`) is a *matched-but-empty* directive. Python
// returns `[]` (quorum/checks.py:56), which the matrix gate treats as
// skip-ALL-agents. TS used to fall through to `undefined` (run-all). Parity
// requires `[]` (matched) here — distinct from `undefined` (no match).
test('parseCodingAgentsDirective returns [] for a degenerate (separators-only) directive', () => {
  const checksSh = checksShWith(
    '# coding-agents: ,\npre() { :; }\npost() { :; }\n',
  );
  expect(parseCodingAgentsDirective(checksSh)).toEqual([]);
});

// A bare `# coding-agents:` with nothing after the colon does NOT match Python's
// `(.+?)` (quorum/checks.py:41 requires at least one char), so it keeps scanning
// and ultimately returns None/undefined — distinct from the degenerate `,` case.
test('parseCodingAgentsDirective returns undefined for a bare "# coding-agents:" (no value)', () => {
  const checksSh = checksShWith(
    '# coding-agents:\npre() { :; }\npost() { :; }\n',
  );
  expect(parseCodingAgentsDirective(checksSh)).toBeUndefined();
});

// E-directive-line-window-offbyone: Python scans line indices 0..20 inclusive
// (`if i > 20: break`, quorum/checks.py:51-53) — 21 lines. TS sliced [0,20) — 20
// lines. A directive on the 21st physical line (index 20) must be honored.
test('parseCodingAgentsDirective honors a directive on the 21st physical line', () => {
  const filler = Array.from({ length: 20 }, () => '#').join('\n');
  const checksSh = checksShWith(
    `${filler}\n# coding-agents: claude\npre() { :; }\npost() { :; }\n`,
  );
  expect(parseCodingAgentsDirective(checksSh)).toEqual(['claude']);
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

// An ATIF trajectory carrying a single Read tool call. A "non-empty trace that
// lacks the asserted tool/skill" — the positive control for the empty-guard.
const READ_ONLY_TRAJECTORY = JSON.stringify({
  schema_version: 'ATIF-v1.7',
  agent: { name: 'claude-code', version: 'test' },
  steps: [
    {
      step_id: 1,
      source: 'agent',
      tool_calls: [
        { tool_call_id: 'r1', function_name: 'Read', arguments: {} },
      ],
    },
  ],
});

// An empty capture is the absence of a trajectory.json: capture removes the file
// on a zero-row run, so check-transcript reads a missing path → empty:true.
function missingTranscriptPath(workdir: string): string {
  return join(workdir, 'trajectory.json');
}

test('tool-not-called FAILs against an empty trace capture (no vacuous pass)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const transcriptPath = missingTranscriptPath(workdir);
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  check-transcript tool-not-called Edit\n}\n',
  );
  const { records } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    transcriptPath,
  });
  expect(records[0]).toMatchObject({
    check: 'tool-not-called',
    negated: false,
    passed: false,
  });
});

test('skill-not-called FAILs against an empty trace capture (no vacuous pass)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const transcriptPath = missingTranscriptPath(workdir);
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  check-transcript skill-not-called superpowers:foo\n}\n',
  );
  const { records } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    transcriptPath,
  });
  expect(records[0]).toMatchObject({
    check: 'skill-not-called',
    negated: false,
    passed: false,
  });
});

test('tool-not-called PASSes on a non-empty trace that lacks the tool (positive control)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const transcriptPath = join(workdir, 'trajectory.json');
  writeFileSync(transcriptPath, READ_ONLY_TRAJECTORY);
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  check-transcript tool-not-called Edit\n}\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    transcriptPath,
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
  const transcriptPath = join(workdir, 'trajectory.json');
  writeFileSync(transcriptPath, READ_ONLY_TRAJECTORY);
  const checksSh = join(mkdtempSync(join(tmpdir(), 'scn-')), 'checks.sh');
  writeFileSync(
    checksSh,
    'pre() { :; }\npost() {\n  check-transcript skill-not-called superpowers:foo\n}\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    quorumBin: BIN,
    transcriptPath,
  });
  expect(exitCode).toBe(0);
  expect(records[0]).toMatchObject({
    check: 'skill-not-called',
    negated: false,
    passed: true,
  });
});
