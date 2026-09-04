import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entrypoint = resolve('container/attempt-entrypoint.sh');

test('entrypoint: appends stdio to the durable logs, loads literal deliveries, execs bun argv', async () => {
  const attempt = mkdtempSync(join(tmpdir(), 'attempt-entry-'));
  const subject = join(attempt, 'subject.env');
  const grader = join(attempt, 'grader.env');
  writeFileSync(subject, 'SUBJECT_KEY=subject-value\n');
  writeFileSync(grader, 'QUORUM_GRADER_ANTHROPIC_API_KEY=grader-value\n');
  writeFileSync(join(attempt, 'stdout.log'), 'pre-existing\n');
  writeFileSync(join(attempt, 'stderr.log'), '');
  // A bun-executable probe: the entrypoint `exec bun "$@"`, so the probe
  // must be a script bun can run (the production argv is src/cli/index.ts).
  const probe = join(attempt, 'probe.ts');
  writeFileSync(
    probe,
    'console.log(`subject=${process.env.SUBJECT_KEY} grader=${process.env.QUORUM_GRADER_ANTHROPIC_API_KEY}`);\nconsole.error("err-line");\nprocess.exit(3);\n',
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
  writeFileSync(grader, 'QUORUM_GRADER_ANTHROPIC_API_KEY=grader-value\n');

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

test('entrypoint treats credential values literally and refuses malformed directives', async () => {
  for (const malicious of [false, true]) {
    const attempt = mkdtempSync(join(tmpdir(), 'attempt-literal-'));
    const marker = join(attempt, 'executed');
    const subject = join(attempt, 'subject.env');
    const grader = join(attempt, 'grader.env');
    writeFileSync(join(attempt, 'stdout.log'), '');
    writeFileSync(join(attempt, 'stderr.log'), '');
    writeFileSync(
      subject,
      malicious ? `touch ${marker}\n` : `SUBJECT_KEY=$(touch ${marker})\n`,
    );
    writeFileSync(grader, 'QUORUM_GRADER_ANTHROPIC_API_KEY=value\n');
    const proc = Bun.spawn(
      ['bash', entrypoint, '-e', 'console.log(process.env.SUBJECT_KEY)'],
      {
        env: {
          PATH: Bun.env['PATH'] ?? '',
          QUORUM_ATTEMPT_DIR: attempt,
          QUORUM_SUBJECT_FILE: subject,
          QUORUM_GRADER_FILE: grader,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const code = await proc.exited;
    expect((await import('node:fs')).existsSync(marker)).toBe(false);
    if (malicious) expect(code).not.toBe(0);
    else {
      expect(code).toBe(0);
      expect(readFileSync(join(attempt, 'stdout.log'), 'utf8').trim()).toBe(
        `$(touch ${marker})`,
      );
    }
  }
});

test('entrypoint refuses duplicate, invalid and runtime-authority delivery variables', async () => {
  for (const body of [
    'KEY=a\nKEY=b\n',
    'bad-name=x\n',
    'QUORUM_ATTEMPT_AUTHORITY_FILE=/evil\n',
    'PATH=/evil\n',
    'HOME=/evil\n',
    'BASH_ENV=/evil\n',
    'KEY=a\0b\n',
    'KEY=a\rb\n',
  ]) {
    const attempt = mkdtempSync(join(tmpdir(), 'attempt-env-refuse-'));
    writeFileSync(join(attempt, 'stdout.log'), '');
    writeFileSync(join(attempt, 'stderr.log'), '');
    const subject = join(attempt, 'subject.env');
    const grader = join(attempt, 'grader.env');
    writeFileSync(subject, body);
    writeFileSync(grader, 'QUORUM_GRADER_ANTHROPIC_API_KEY=value\n');
    const child = Bun.spawn(
      ['bash', entrypoint, '-e', 'console.log("launched")'],
      {
        env: {
          PATH: Bun.env['PATH'] ?? '',
          QUORUM_ATTEMPT_DIR: attempt,
          QUORUM_SUBJECT_FILE: subject,
          QUORUM_GRADER_FILE: grader,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(join(attempt, 'stdout.log'), 'utf8')).toBe('');
  }
});
