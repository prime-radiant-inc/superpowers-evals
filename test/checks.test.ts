import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// E-signal-killed-status-null: when the bash child running a phase is killed by a
// signal (OOM-killer, timeout SIGKILL), spawnSync returns status:null + a signal.
// TS used to do `proc.status ?? 0`, coercing the crash to a clean rc 0 with
// whatever partial records exist. Python's subprocess.run returns a NEGATIVE
// returncode (-9), which the crash heuristic treats as nonzero when no records
// were emitted. Parity: a signal-killed phase with no records must surface a
// nonzero (crash) exitCode.
test('a signal-killed bash phase with no records surfaces a nonzero crash exitCode', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  // No records emitted, then kill the running bash with SIGKILL.
  const checksSh = checksShWith('pre() {\n  kill -KILL $$\n}\npost() { :; }\n');
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin: BIN,
  });
  expect(records).toEqual([]);
  expect(exitCode).not.toBe(0);
});

// L4-signal-killed-with-records-is-clean: Python's subprocess.run returns a
// NEGATIVE returncode for a signal (-9 for SIGKILL), so its crash band test
// (`== 126 || == 127 || >= 128`) is False and it falls through to
// `elif records: exit_code = 0` (quorum/checks.py:134-143). A signal-killed
// phase that already emitted records is therefore treated as CLEAN by Python.
// TS used to map a kill to 128+signo (137), which lands in the >=128 crash band
// REGARDLESS of records — a parity divergence. Bug-for-bug parity: map the kill
// to a negative code so the records-clean-out path applies.
test('a signal-killed bash phase that already emitted a record is clean (parity with Python)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  // Emit a real record, then kill the running bash with SIGKILL.
  const checksSh = checksShWith(
    'pre() {\n  file-exists present.txt\n  kill -KILL $$\n}\npost() { :; }\n',
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin: BIN,
  });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    check: 'file-exists',
    passed: true,
    phase: 'pre',
  });
  expect(exitCode).toBe(0);
});

// E-spawn-failure-swallowed: Python `subprocess.run(['bash', ...])` raises
// FileNotFoundError when bash cannot be spawned, propagating out of run_phase.
// Node's spawnSync does NOT throw — it returns {status:null, error:<ENOENT>}.
// TS used to ignore proc.error and report a clean, empty phase. Parity: a spawn
// failure must throw rather than silently swallow into {records:[], exitCode:0}.
test('a bash spawn failure throws instead of reporting a clean empty phase', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'nobin-'));
  const checksSh = checksShWith('pre() { :; }\npost() { :; }\n');
  // Compose an env where neither quorumBin nor the inherited PATH can resolve
  // `bash`, forcing spawnSync to fail with ENOENT (status:null, error set).
  // runPhase composes the child PATH from envSnapshot() (a live process.env view),
  // so we set it to a bash-less dir for the duration of this one assertion.
  // biome-ignore lint/style/noProcessEnv: must mutate inherited PATH to provoke a spawn failure
  const savedPath = process.env['PATH'];
  // biome-ignore lint/style/noProcessEnv: must mutate inherited PATH to provoke a spawn failure
  process.env['PATH'] = emptyDir;
  try {
    await expect(
      runPhase({ checksSh, phase: 'pre', workdir, quorumBin: emptyDir }),
    ).rejects.toThrow();
  } finally {
    // biome-ignore lint/style/noProcessEnv: restore the inherited PATH after the assertion
    process.env['PATH'] = savedPath;
  }
});

// E-path-empty-fallback: Python composes the child PATH as
// `{quorum_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}` (quorum/checks.py:82),
// so an UNSET PATH still resolves system utilities. TS fell back to '' — yielding
// `{quorumBin}:` whose trailing empty component means CWD on POSIX, and no
// /usr/bin or /bin. Parity: an unset PATH falls back to /usr/bin:/bin.
test('an unset PATH falls back to /usr/bin:/bin in the child env (not a CWD-on-PATH empty component)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  // bash lives under /bin or /usr/bin, so the fallback is what makes this run at
  // all once PATH is unset. Capture the child's PATH for inspection.
  const out = join(workdir, 'path.txt');
  const checksSh = checksShWith(
    `pre() {\n  printf '%s' "$PATH" > '${out}'\n}\npost() { :; }\n`,
  );
  // biome-ignore lint/style/noProcessEnv: must unset inherited PATH to exercise the fallback
  const savedPath = process.env['PATH'];
  // biome-ignore lint/style/noProcessEnv: must unset inherited PATH to exercise the fallback
  process.env['PATH'] = undefined;
  let childPath: string;
  try {
    await runPhase({ checksSh, phase: 'pre', workdir, quorumBin: BIN });
    childPath = readFileSync(out, 'utf8');
  } finally {
    // biome-ignore lint/style/noProcessEnv: restore the inherited PATH after the assertion
    process.env['PATH'] = savedPath;
  }
  expect(childPath).toBe(`${BIN}:/usr/bin:/bin`);
});

// L3-phase-large-output-enobuf: runPhase's spawnSync has no maxBuffer, so a
// pre()/post() body emitting >1 MB to stdout returns {status:null,
// error:{code:'ENOBUFS'}}; the `if (proc.error) throw proc.error` guard then
// fires BEFORE the record sink is read, discarding records the check tools
// already wrote. Python reads the sink regardless of stdout volume. Parity: a
// verbose phase that still writes a record must have that record collected.
test('a phase emitting >1 MB still collects its records (no ENOBUFS discard)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const checksSh = checksShWith(
    // Emit ~2 MB of stdout (past Node's 1 MB default maxBuffer), then a real
    // check record. The record must survive the large-output run.
    "pre() {\n  head -c 2000000 /dev/zero | tr '\\0' 'x'\n  file-exists present.txt\n}\npost() { :; }\n",
  );
  const { records, exitCode } = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    quorumBin: BIN,
  });
  expect(exitCode).toBe(0);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    check: 'file-exists',
    args: ['present.txt'],
    passed: true,
    phase: 'pre',
  });
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
