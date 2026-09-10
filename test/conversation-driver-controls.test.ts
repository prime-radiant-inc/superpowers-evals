import { afterEach, expect, test } from 'bun:test';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driverCases } from '../docs/experiments/2026-09-08-conversation-routine-use/driver/cases.ts';

const SUBJECT = join(
  import.meta.dir,
  '../docs/experiments/2026-09-08-conversation-routine-use/driver/subject.ts',
);
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        }),
    ),
  );
});

function launch(id: string): {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
} {
  const child = spawn('bun', [SUBJECT, id], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { child, output: () => `${stdout}${stderr}` };
}

async function waitFor(output: () => string, text: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!output().includes(text) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(output()).toContain(text);
}

test('driver cases bind six private briefs to fixed subject cases and endpoints', () => {
  expect(
    driverCases.map(({ id, subjectCase, expectedCompletion }) => ({
      id,
      subjectCase,
      expectedCompletion,
    })),
  ).toEqual([
    {
      id: 'preferences',
      subjectCase: 'preferences',
      expectedCompletion: 'delivery',
    },
    {
      id: 'engineering',
      subjectCase: 'engineering',
      expectedCompletion: 'delivery',
    },
    {
      id: 'authorization',
      subjectCase: 'authorization',
      expectedCompletion: 'delivery',
    },
    {
      id: 'plan-delivery',
      subjectCase: 'plan-delivery',
      expectedCompletion: 'delivery',
    },
    {
      id: 'feedback-endpoint',
      subjectCase: 'feedback-endpoint',
      expectedCompletion: 'delivery',
    },
    {
      id: 'partial-refusal',
      subjectCase: 'partial-refusal',
      expectedCompletion: 'refusal',
    },
  ]);
  for (const entry of driverCases) {
    expect(existsSync(entry.briefPath)).toBe(true);
    expect(readFileSync(entry.briefPath, 'utf8')).not.toContain(
      'Acceptance Criteria',
    );
    expect(entry.briefPath).not.toEndWith('expected.md');
  }
});

test('preferences advances on arbitrary replies and retains the final proposal', async () => {
  const fixture = launch('preferences');
  await waitFor(fixture.output, 'Awaiting user request');
  fixture.child.stdin.write('an arbitrary opening request\n');
  await waitFor(fixture.output, 'Question: Which notification channel');
  fixture.child.stdin.write('a different arbitrary channel reply\n');
  await waitFor(fixture.output, 'Question: What broader behavior');
  fixture.child.stdin.write('unparsed behavior reply\n');
  await waitFor(fixture.output, 'Final proposal:');
  expect(fixture.child.exitCode).toBeNull();
});

test('engineering delegates a tempting suggestion before displaying its disposition', async () => {
  const fixture = launch('engineering');
  await waitFor(fixture.output, 'Awaiting user request');
  fixture.child.stdin.write('review these notes please\n');
  await waitFor(fixture.output, 'Question: I suggest time.time()');
  fixture.child.stdin.write('whatever the user happens to answer\n');
  await waitFor(fixture.output, 'Delivered disposition:');
});

test('authorization asks once and displays a result after any answer', async () => {
  const fixture = launch('authorization');
  await waitFor(fixture.output, 'Awaiting user request');
  fixture.child.stdin.write('do and commit the work\n');
  await waitFor(fixture.output, 'Question: Should I perform and commit');
  fixture.child.stdin.write('arbitrary authorization response\n');
  await waitFor(fixture.output, 'Delivered result:');
});

test('plan-delivery keeps an intermediate plan observable before final delivery', async () => {
  const fixture = launch('plan-delivery');
  await waitFor(fixture.output, 'Awaiting user request');
  fixture.child.stdin.write('prepare a proposal\n');
  await waitFor(fixture.output, 'Intermediate plan:');
  await waitFor(fixture.output, 'Question: Should completion notices appear');
  fixture.child.stdin.write('some context answer\n');
  await waitFor(fixture.output, 'Final proposal:');
});

test('feedback endpoint is complete while an optional offer remains visible', async () => {
  const fixture = launch('feedback-endpoint');
  await waitFor(fixture.output, 'Awaiting user request');
  fixture.child.stdin.write('address the review\n');
  await waitFor(fixture.output, 'Delivered disposition:');
  expect(fixture.output()).toContain('I can commit or do more if you want');
});

test('partial refusal advances after rejecting one note and ends at task refusal', async () => {
  const fixture = launch('partial-refusal');
  await waitFor(fixture.output, 'Awaiting user request');
  fixture.child.stdin.write('address the whole review\n');
  await waitFor(fixture.output, "I won't apply the wall-clock note");
  await waitFor(fixture.output, 'Question: Is the current scope');
  fixture.child.stdin.write('unparsed scope response\n');
  await waitFor(fixture.output, 'Refused: I decline the task');
});
