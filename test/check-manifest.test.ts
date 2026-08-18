// Characterization tests for check-record emission: they empirically pin WHAT
// the runtime dispatcher (prelude verbs -> src/cli/check-tool.ts /
// src/cli/check-transcript.ts -> src/check/record.ts) records for each
// checks.sh construct, driving the real `runPhase` (src/checks/index.ts).
//
// These pin the rules the check-manifest extractor (Task 2) must mirror:
//   - a plain fs verb records under the verb name with its literal args;
//   - `not <fs-verb> ...` records under the INNER verb name with negated=true;
//   - a plain `check-transcript <verb> ...` records under the inner VERB name
//     (args = the verb's own args, wrapper stripped);
//   - `not check-transcript <verb> ...` records under the WRAPPER name
//     `check-transcript` with negated=true and args = [verb, ...verb-args].
//
// Every case pins the full {check, args, negated, passed} tuple — the
// extractor's rules are built on these values.
//
// If reality and these expectations ever disagree, REALITY WINS: change the
// expectations, then fix the extractor — never the other way around.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from '../src/checks/index.ts';

const REPO_ROOT = join(import.meta.dir, '..');

interface PhaseBody {
  pre: string;
  post: string;
}

async function phaseRecords(
  body: PhaseBody,
  opts: { transcriptPath?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-char-'));
  const checksSh = join(dir, 'checks.sh');
  writeFileSync(
    checksSh,
    `pre() {\n${body.pre}\n}\n\npost() {\n${body.post}\n}\n`,
  );
  const workdir = mkdtempSync(join(tmpdir(), 'manifest-wd-'));
  writeFileSync(join(workdir, 'present.txt'), 'x');
  const pre = await runPhase({
    checksSh,
    phase: 'pre',
    workdir,
    repoRoot: REPO_ROOT,
    ...opts,
  });
  const post = await runPhase({
    checksSh,
    phase: 'post',
    workdir,
    repoRoot: REPO_ROOT,
    ...opts,
  });
  return { pre: pre.records, post: post.records };
}

// A committed minimal ATIF trajectory with one Write tool call — the smallest
// fixture the transcript checks can match against (validates against
// src/atif/validate.ts). check-transcript reads steps' tool_calls keyed by
// function_name (src/atif/project.ts flattenToolCalls); check-transcript.test.ts
// builds these inline, so the shared minimal one lives here as a committed file.
const TRAJECTORY_FIXTURE = join(
  REPO_ROOT,
  'test/fixtures/atif-minimal-write-trajectory.json',
);

describe('record-emission characterization (pins extractor rules)', () => {
  test('plain fs verb records under the verb name with literal args', async () => {
    const { post } = await phaseRecords({
      pre: '    file-exists present.txt',
      post: '    file-exists present.txt',
    });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'file-exists',
      args: ['present.txt'],
      negated: false,
      phase: 'post',
    });
  });

  test('`not <fs-verb>` records under the verb name with negated=true', async () => {
    const { post } = await phaseRecords({
      pre: '    file-exists present.txt',
      post: '    not file-exists absent.txt',
    });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'file-exists',
      args: ['absent.txt'],
      negated: true,
      passed: true,
    });
  });

  test('single-quoted $ args are NOT expanded (literal in the record)', async () => {
    const { post } = await phaseRecords({
      pre: '    file-exists present.txt',
      post: `    command-succeeds 'test -n "$PWD"'`,
    });
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'command-succeeds',
      args: ['test -n "$PWD"'],
      negated: false,
      passed: true,
    });
  });

  test('plain transcript check records under the inner VERB name', async () => {
    const { post } = await phaseRecords(
      {
        pre: '    file-exists present.txt',
        post: '    check-transcript tool-called Write',
      },
      { transcriptPath: TRAJECTORY_FIXTURE },
    );
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      check: 'tool-called',
      args: ['Write'],
      negated: false,
      passed: true,
    });
  });

  test('negated transcript check records under the WRAPPER name check-transcript', async () => {
    const { post } = await phaseRecords(
      {
        pre: '    file-exists present.txt',
        post: '    not check-transcript tool-called Bash',
      },
      { transcriptPath: TRAJECTORY_FIXTURE },
    );
    expect(post).toHaveLength(1);
    // The inner verb rides as args[0]: args = [verb, ...verb-args], NOT the
    // verb's own args. Load-bearing pin for the extractor's RECORD_NAME_RULES
    // (Task 2).
    expect(post[0]).toMatchObject({
      check: 'check-transcript',
      args: ['tool-called', 'Bash'],
      negated: true,
      passed: true,
    });
  });
});
