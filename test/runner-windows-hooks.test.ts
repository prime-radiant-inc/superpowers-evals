import { describe, expect, test } from 'bun:test';
import { RemoteExecution } from '../src/agents/claude-windows.ts';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/agent-config.ts';
import { setProcessEnv } from '../src/env.ts';

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push(`${command} ${args.join(' ')}`);
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
    expect(r.calls[0]).toContain('eval-runs\\abc');
  });

  test('captureBack pulls projects logs and workdir from the guest', () => {
    setProcessEnv('WIN_EVAL_PASSWORD', 'password');
    const r = new FakeRunner();
    new RemoteExecution(remote, r).captureBack(
      '/run/abc/home',
      '/run/abc/coding-agent-workdir',
      'abc',
    );
    expect(r.calls.join('\n')).toContain('.claude\\projects');
    expect(r.calls.join('\n')).toContain('eval-runs\\abc\\workdir');
  });
});
