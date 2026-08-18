import { describe, expect, test } from 'bun:test';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';
import { RemoteConfigSchema } from '../src/contracts/os-target.ts';

class FakeRunner implements CommandRunner {
  calls: {
    command: string;
    args: string[];
    options?: CommandOptions | undefined;
  }[] = [];
  result: CommandResult = { status: 0, stdout: '', stderr: '' };
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push({ command, args: [...args], options });
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

// F13 env scoping (Fix Round 1): every WindowsHost subprocess must pass an
// explicit env — omitted CommandRunner options mean spawnSync's env is
// undefined and the child INHERITS THE FULL PARENT ENV (the whole provider
// bundle). All three methods (ssh, scpFrom, scpTo) run on the non-secret
// provision allowlist. The SSH password rides argv via `sshpass -p` (never
// SSHPASS/env) and the password env itself must NOT survive into the child.
describe('WindowsHost env isolation (F13)', () => {
  test('ssh/scpFrom/scpTo pass an allowlisted env: no password env, no host credentials, PATH survives', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const HOSTILE = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
    ];
    const saved: Record<string, string | undefined> = {};
    for (const name of HOSTILE) {
      saved[name] = Bun.env[name];
      Bun.env[name] = `hostile-${name}`;
    }
    try {
      const r = new FakeRunner();
      const host = new WindowsHost(remote, r);
      host.ssh('whoami');
      host.scpFrom('C:\\eval-runs\\x\\w', '/tmp/out');
      host.scpTo('/tmp/x', 'C:\\dst');
      expect(r.calls.length).toBe(3);
      for (const call of r.calls) {
        // An explicit env must be present at all — omitted options mean
        // spawnSync inherits the parent env wholesale.
        const env = call.options?.env;
        expect(env).toBeDefined();
        // The password env feeds `sshpass -p` argv; it must never leak into
        // the child env (and SSHPASS is not used — auth is argv-only).
        expect(env?.['WIN_EVAL_PASSWORD']).toBeUndefined();
        expect(env?.['SSHPASS']).toBeUndefined();
        for (const name of HOSTILE) {
          expect(env?.[name]).toBeUndefined();
        }
        // The one var this surface actively needs survives: sshpass resolves
        // `ssh` via the child PATH.
        expect(env?.['PATH']).toBe(Bun.env['PATH']);
        // The password still rides argv (unchanged delivery mechanism).
        expect(call.args).toContain('-p');
        expect(call.args).toContain('password');
      }
    } finally {
      for (const name of HOSTILE) {
        if (saved[name] === undefined) delete Bun.env[name];
        else Bun.env[name] = saved[name];
      }
    }
  });
});

describe('writeFileBase64', () => {
  test('sends base64 + FromBase64String, never raw content, no variable interpolation', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner();
    const json = '{"a":"b\'c"}';
    new WindowsHost(remote, r).writeFileBase64('C:\\x\\f.json', json);
    const argv = r.calls[0]!.args.join(' ');
    expect(argv).toContain('FromBase64String');
    expect(argv).toContain(Buffer.from(json, 'utf8').toString('base64'));
    expect(argv).not.toContain(json);
    expect(argv).not.toContain('$d');
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
