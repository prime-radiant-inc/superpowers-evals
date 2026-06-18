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
    expect(args).toContain('ssh');
    expect(args).not.toContain('-tt');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ControlPath=none');
    expect(args).toContain('user@127.0.0.1');
    expect(args[args.length - 1]).toBe('whoami');
  });

  test('scpFrom pulls a guest path to a local dir, mux off, using forward slashes in remote endpoint', () => {
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
    // Remote endpoint must use forward slashes (Windows OpenSSH scp requirement)
    expect(args).toContain('user@127.0.0.1:C:/eval-runs/x/workdir');
    expect(args).not.toContain('user@127.0.0.1:C:\\eval-runs\\x\\workdir');
    expect(args[args.length - 1]).toBe('/tmp/out');
  });

  test('scpTo pushes a local path to a guest dir, mux off, using forward slashes in remote endpoint', () => {
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
    // Local source precedes the dest; remote endpoint uses forward slashes
    const localIdx = args.indexOf('/tmp/x');
    const destIdx = args.indexOf('user@127.0.0.1:C:/dst');
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(destIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeLessThan(destIdx);
    // Must NOT contain backslash form
    expect(args).not.toContain('user@127.0.0.1:C:\\dst');
  });
});
