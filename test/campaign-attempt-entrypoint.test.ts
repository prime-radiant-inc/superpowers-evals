import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entrypoint = resolve('container/attempt-entrypoint.sh');

test('entrypoint: appends stdio to the durable logs, sources deliveries, execs bun argv', async () => {
  const attempt = mkdtempSync(join(tmpdir(), 'attempt-entry-'));
  const subject = join(attempt, 'subject.env');
  const grader = join(attempt, 'grader.env');
  writeFileSync(subject, 'SUBJECT_KEY=subject-value\n');
  writeFileSync(grader, 'QUORUM_GRADER_API_KEY=grader-value\n');
  writeFileSync(join(attempt, 'stdout.log'), 'pre-existing\n');
  writeFileSync(join(attempt, 'stderr.log'), '');
  // A bun-executable probe: the entrypoint `exec bun "$@"`, so the probe
  // must be a script bun can run (the production argv is src/cli/index.ts).
  const probe = join(attempt, 'probe.ts');
  writeFileSync(
    probe,
    'console.log(`subject=${process.env.SUBJECT_KEY} grader=${process.env.QUORUM_GRADER_API_KEY}`);\nconsole.error("err-line");\nprocess.exit(3);\n',
  );
  const proc = Bun.spawn(['bash', entrypoint, probe], {
    env: {
      PATH: Bun.env['PATH'] ?? '',
      QUORUM_ATTEMPT_DIR: attempt,
      QUORUM_SUBJECT_FILE: subject,
      QUORUM_GRADER_FILE: grader,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await proc.exited).toBe(3); // the exec'd command's status propagates
  const stdout = readFileSync(join(attempt, 'stdout.log'), 'utf8');
  const stderr = readFileSync(join(attempt, 'stderr.log'), 'utf8');
  expect(stdout).toBe(
    'pre-existing\nsubject=subject-value grader=grader-value\n',
  );
  expect(stderr).toBe('err-line\n');
  // the caller's own pipes received nothing — all output went to the logs
  expect(await new Response(proc.stdout).text()).toBe('');
});

test('entrypoint: refuses to run without QUORUM_ATTEMPT_DIR', async () => {
  const proc = Bun.spawn(['bash', entrypoint, 'true'], {
    env: { PATH: Bun.env['PATH'] ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await proc.exited).not.toBe(0);
});

test('entrypoint: refuses missing or symlinked delivery files', async () => {
  const attempt = mkdtempSync(join(tmpdir(), 'attempt-entry-invalid-'));
  writeFileSync(join(attempt, 'stdout.log'), '');
  writeFileSync(join(attempt, 'stderr.log'), '');
  const subject = join(attempt, 'subject.env');
  const grader = join(attempt, 'grader.env');
  writeFileSync(subject, 'SUBJECT_KEY=subject-value\n');
  writeFileSync(grader, 'QUORUM_GRADER_API_KEY=grader-value\n');

  const run = (subjectFile: string, graderFile: string) =>
    Bun.spawn(['bash', entrypoint, '-e', ''], {
      env: {
        PATH: Bun.env['PATH'] ?? '',
        QUORUM_ATTEMPT_DIR: attempt,
        QUORUM_SUBJECT_FILE: subjectFile,
        QUORUM_GRADER_FILE: graderFile,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

  expect(await run(join(attempt, 'missing.env'), grader).exited).not.toBe(0);
  const linked = join(attempt, 'linked-subject.env');
  symlinkSync(subject, linked);
  expect(await run(linked, grader).exited).not.toBe(0);
});
