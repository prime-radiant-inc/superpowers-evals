import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteExecution } from '../src/agents/claude-windows.ts';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/agent-config.ts';
import { setProcessEnv } from '../src/env.ts';

// Simulates scp pulling the guest workdir: creates coding-agent-workdir inside
// the local destination so the safe-swap renameSync succeeds.
class FakeRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push(`${command} ${args.join(' ')}`);
    // When scpFrom pulls the guest workdir, create the expected subdir so the
    // safe-swap renameSync has something to rename (mirrors real scp behaviour).
    if (
      command === 'sshpass' &&
      args.includes('scp') &&
      args.some((a) => a.includes('coding-agent-workdir'))
    ) {
      const dest = args[args.length - 1];
      if (typeof dest === 'string' && !dest.includes(':')) {
        mkdirSync(join(dest, 'coding-agent-workdir'), { recursive: true });
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });

describe('RemoteExecution', () => {
  test('pushWorkdir scps local workdir to <runRoot> on the guest', () => {
    setProcessEnv('WIN_EVAL_PASSWORD', 'password');
    const r = new FakeRunner();
    new RemoteExecution(remote, r).pushWorkdir(
      '/run/abc/coding-agent-workdir',
      'abc',
    );
    expect(r.calls[0]).toContain('scp');
    expect(r.calls[0]).toContain('coding-agent-workdir');
    // Remote endpoint uses forward slashes (Windows OpenSSH scp requirement)
    expect(r.calls[0]).toContain('eval-runs/abc');
  });

  test('captureBack pulls projects logs and workdir from the guest', () => {
    setProcessEnv('WIN_EVAL_PASSWORD', 'password');
    const r = new FakeRunner();
    // captureBack now mkdir/rm's the local paths it is handed, so they must be
    // REAL temp dirs, not fake /run/abc/... strings.
    const localRunHomeDir = mkdtempSync(join(tmpdir(), 'cap-home-'));
    const localWorkdir = join(localRunHomeDir, 'coding-agent-workdir');
    mkdirSync(localWorkdir, { recursive: true });
    new RemoteExecution(remote, r).captureBack(
      localRunHomeDir,
      localWorkdir,
      'abc',
    );
    // Remote endpoints use forward slashes (Windows OpenSSH scp requirement)
    expect(r.calls.join('\n')).toContain('.claude/projects');
    expect(r.calls.join('\n')).toContain('eval-runs/abc/coding-agent-workdir');
  });

  // C2 regression guard: the dir name pushWorkdir's scp DESTINATION lands as on
  // the guest must be the SAME dir name captureBack's scp SOURCE pulls back, so
  // the workdir round-trips (push -> guest -> pull -> same local name).
  test('pushWorkdir destination and captureBack source share one guest dir name', () => {
    setProcessEnv('WIN_EVAL_PASSWORD', 'password');
    const pushRunner = new FakeRunner();
    new RemoteExecution(remote, pushRunner).pushWorkdir(
      '/run/abc/coding-agent-workdir',
      'abc',
    );
    // scpTo lands the local dir under its own basename inside <runRoot>.
    expect(pushRunner.calls[0]).toContain('coding-agent-workdir');

    const captureRunner = new FakeRunner();
    const localRunHomeDir = mkdtempSync(join(tmpdir(), 'cap-home-'));
    const localWorkdir = join(localRunHomeDir, 'coding-agent-workdir');
    mkdirSync(localWorkdir, { recursive: true });
    new RemoteExecution(remote, captureRunner).captureBack(
      localRunHomeDir,
      localWorkdir,
      'abc',
    );
    // captureBack's workdir-source basename matches the pushed dir name (forward slashes).
    expect(captureRunner.calls.join('\n')).toContain(
      'eval-runs/abc/coding-agent-workdir',
    );
  });
});
