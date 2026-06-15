// Prove the sourced check prelude (src/checks/prelude.sh) emits records that are
// BYTE-IDENTICAL to the legacy bin/ shims. Each prelude function still execs the
// same src/cli/check-tool.ts, so the {check,args,negated,passed,detail} line must
// match the shim's exactly. Covered: file-exists, git-count (a passing AND a
// failing op), and a negated `not file-exists`.

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const BIN = resolve(REPO, 'bin');
const PRELUDE = resolve(REPO, 'src', 'checks', 'prelude.sh');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'pre-wd-'));
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, encoding: 'utf8' as const };
  spawnSync('git', ['init', '-q'], opts);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], opts);
  spawnSync('git', ['config', 'user.email', 't@t'], opts);
  spawnSync('git', ['config', 'user.name', 't'], opts);
}

function gitCommit(dir: string, file: string): void {
  const opts = { cwd: dir, encoding: 'utf8' as const };
  writeFileSync(join(dir, file), file);
  spawnSync('git', ['add', '-A'], opts);
  spawnSync('git', ['commit', '-qm', file], opts);
}

/** Run a verb via the legacy bin/ shim; return the raw record line. */
function viaShim(tool: string, args: string[], cwd: string): string {
  const sink = join(mkdtempSync(join(tmpdir(), 'pre-sink-')), 'r.jsonl');
  spawnSync(join(BIN, tool), args, {
    cwd,
    env: { ...process.env, QUORUM_RECORD_SINK: sink },
    encoding: 'utf8',
  });
  return readFileSync(sink, 'utf8');
}

/** Run a verb via the sourced prelude function; return the raw record line. */
function viaPrelude(verb: string, verbArgs: string[], cwd: string): string {
  const sink = join(mkdtempSync(join(tmpdir(), 'pre-sink-')), 'r.jsonl');
  // Build `<verb> 'a' 'b' …` so multi-word args survive word splitting.
  const quoted = verbArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  spawnSync('bash', ['-c', `source '${PRELUDE}'; ${verb} ${quoted}`], {
    cwd,
    env: { ...process.env, QUORUM_REPO_ROOT: REPO, QUORUM_RECORD_SINK: sink },
    encoding: 'utf8',
  });
  return readFileSync(sink, 'utf8');
}

test('prelude file-exists record is byte-identical to the bin/ shim', () => {
  const wd = workdir();
  writeFileSync(join(wd, 'present.txt'), 'x');
  expect(viaPrelude('file-exists', ['present.txt'], wd)).toBe(
    viaShim('file-exists', ['present.txt'], wd),
  );
});

test('prelude git-count (passing op) record is byte-identical to the bin/ shim', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  expect(viaPrelude('git-count', ['commits', 'eq', '1'], wd)).toBe(
    viaShim('git-count', ['commits', 'eq', '1'], wd),
  );
});

test('prelude git-count (failing op) record is byte-identical to the bin/ shim', () => {
  const wd = workdir();
  gitInit(wd);
  gitCommit(wd, 'a');
  expect(viaPrelude('git-count', ['commits', 'eq', '5'], wd)).toBe(
    viaShim('git-count', ['commits', 'eq', '5'], wd),
  );
});

test('prelude `not file-exists` (miss) negated record is byte-identical to the bin/ shim', () => {
  const wd = workdir();
  expect(viaPrelude('not', ['file-exists', 'nope.txt'], wd)).toBe(
    viaShim('not', ['file-exists', 'nope.txt'], wd),
  );
});
