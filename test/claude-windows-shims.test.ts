import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx = join(
  import.meta.dir,
  '..',
  'coding-agents',
  'claude-windows-context',
);

describe('claude-windows launcher', () => {
  const launcher = readFileSync(join(ctx, 'launch-agent'), 'utf8');

  test('execs a mux-off ssh -tt into the guest and runs the win launch cmd', () => {
    expect(launcher).toContain('ssh -tt');
    expect(launcher).toContain('ControlMaster=no');
    expect(launcher).toContain('ControlPath=none');
    expect(launcher).toContain('StrictHostKeyChecking=no');
    expect(launcher).toContain('UserKnownHostsFile=/dev/null');
    expect(launcher).toContain('$WIN_LAUNCH_CMD');
    expect(launcher.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('HOWTO tells the QA agent to type the one launch token', () => {
    const howto = readFileSync(join(ctx, 'HOWTO.md'), 'utf8');
    expect(howto).toContain('"$QUORUM_LAUNCH_AGENT"');
  });
});
