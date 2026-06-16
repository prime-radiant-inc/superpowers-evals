import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

test('active non-planted fixtures do not advertise fake backends', () => {
  const checkedFiles = [
    'scenarios/triggering-executing-plans/setup.sh',
    'scenarios/mid-conversation-skill-invocation/setup.sh',
    'scenarios/writing-plans-no-spec-conversational/setup.sh',
    'scenarios/cost-session-timeout-boundary/setup.sh',
  ];

  for (const rel of checkedFiles) {
    expect(read(rel), rel).not.toMatch(/\b(stub|placeholder|no-op)\b/i);
  }
});
