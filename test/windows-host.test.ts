import { describe, expect, test } from 'bun:test';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';
import { RemoteConfigSchema } from '../src/contracts/os-target.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  result: CommandResult = { status: 0, stdout: '', stderr: '' };
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    return this.result;
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

describe('writeFileBase64', () => {
  test('sends base64 + FromBase64String, never raw content', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    const json = '{"a":"b\'c"}';
    new WindowsHost(remote, r).writeFileBase64('C:\\x\\f.json', json);
    const argv = r.calls[0]!.args.join(' ');
    expect(argv).toContain('FromBase64String');
    expect(argv).toContain(Buffer.from(json, 'utf8').toString('base64'));
    expect(argv).not.toContain(json);
  });
  test('secret write redacts content + b64 from error', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    r.result = { status: 1, stdout: '', stderr: 'boom' };
    const secret = 'sk-ant-SECRET';
    const body = `set KEY=${secret}`;
    try {
      new WindowsHost(remote, r).writeFileBase64('C:\\x\\launch.cmd', body, {
        secret: true,
      });
      expect(true).toBe(false);
    } catch (e) {
      const m = String((e as Error).message);
      expect(m).not.toContain(secret);
      expect(m).not.toContain(Buffer.from(body).toString('base64'));
    }
  });
});
