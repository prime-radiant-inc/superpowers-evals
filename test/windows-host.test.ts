import { describe, expect, test } from 'bun:test';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';
import { RemoteConfigSchema } from '../src/contracts/agent-config.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    return { status: 0, stdout: '', stderr: '' };
  }
}

const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });

describe('WindowsHost', () => {
  test('ssh disables mux and runs the remote command', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    new WindowsHost(remote, r).ssh('whoami');
    const call = r.calls[0];
    if (call === undefined) throw new Error('No call recorded');
    const { command, args } = call;
    expect(command).toBe('sshpass');
    expect(args).toContain('-p');
    expect(args).toContain('password');
    expect(args.join(' ')).toContain('ssh -tt');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ControlPath=none');
    expect(args).toContain('user@127.0.0.1');
    expect(args[args.length - 1]).toBe('whoami');
  });

  test('scpFrom pulls a guest path to a local dir, mux off', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    new WindowsHost(remote, r).scpFrom('C:\\eval-runs\\x\\workdir', '/tmp/out');
    const call = r.calls[0];
    if (call === undefined) throw new Error('No call recorded');
    const { command, args } = call;
    expect(command).toBe('sshpass');
    expect(args).toContain('scp');
    expect(args).toContain('-r');
    expect(args).toContain('ControlMaster=no');
    expect(args.join(' ')).toContain('user@127.0.0.1:');
    expect(args[args.length - 1]).toBe('/tmp/out');
  });

  test('scpTo pushes a local path to a guest dir, mux off', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    new WindowsHost(remote, r).scpTo('/tmp/x', 'C:\\dst');
    const call = r.calls[0];
    if (call === undefined) throw new Error('No call recorded');
    const { command, args } = call;
    expect(command).toBe('sshpass');
    expect(args).toContain('scp');
    expect(args).toContain('-P');
    expect(args).toContain('ControlMaster=no');
    // Local source precedes the dest
    const localIdx = args.indexOf('/tmp/x');
    const destIdx = args.indexOf('user@127.0.0.1:C:\\dst');
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(destIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeLessThan(destIdx);
  });

  test('rsyncTo pushes a local dir to guest, mux off, with proper ssh flags', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    new WindowsHost(remote, r).rsyncTo('/tmp/src', 'C:\\sp');
    const call = r.calls[0];
    if (call === undefined) throw new Error('No call recorded');
    const { command, args } = call;
    expect(command).toBe('rsync');
    expect(args).toContain('-a');
    expect(args).toContain('--delete');
    expect(args).toContain('-e');
    // The -e arg should contain the mux-off flags
    const eIdx = args.indexOf('-e');
    expect(eIdx).toBeGreaterThanOrEqual(0);
    const sshCmd = args[eIdx + 1];
    expect(sshCmd).toContain('ControlMaster=no');
  });

  test('rsyncTo quotes password to prevent shell injection', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = "a b'c";
    const r = new FakeRunner();
    new WindowsHost(remote, r).rsyncTo('/tmp/src', 'C:\\sp');
    const call = r.calls[0];
    if (call === undefined) throw new Error('No call recorded');
    const { args } = call;
    const eIdx = args.indexOf('-e');
    const sshCmd = args[eIdx + 1];
    // The password should be single-quoted with inner quotes escaped
    expect(sshCmd).toContain(`'a b'\\''c'`);
    // Should NOT contain the raw unquoted password
    expect(sshCmd).not.toContain("a b'c");
  });
});
