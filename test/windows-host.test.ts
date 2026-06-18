import { describe, expect, test } from 'bun:test';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/agent-config.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';

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
    process.env['WIN_EVAL_PASSWORD'] = 'password';
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
    process.env['WIN_EVAL_PASSWORD'] = 'password';
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
});
