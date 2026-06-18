import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsClaudeAgent } from '../src/agents/claude-windows.ts';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { loadAgentConfig } from '../src/contracts/agent-config.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[]; input: string | undefined }[] = [];
  run(
    command: string,
    args: readonly string[],
    options?: { input?: string },
  ): CommandResult {
    this.calls.push({ command, args: [...args], input: options?.input });
    return { status: 0, stdout: '', stderr: '' };
  }
}

describe('WindowsClaudeAgent.provision', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    process.env['WIN_EVAL_PASSWORD'] = 'password';
    process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sp-'));
  });

  test('creates the per-run guest tree and returns launcher substitutions', () => {
    const cfg = loadAgentConfig(
      join(import.meta.dir, '..', 'coding-agents'),
      'claude-windows',
    );
    const runDir = mkdtempSync(
      join(tmpdir(), 'myscenario-claude-windows-run-'),
    );
    const runId = runDir.split('/').pop()!;
    const home = {
      configDir: join(runDir, 'home', '.claude'),
      workdir: join(runDir, 'coding-agent-workdir'),
      skeletonRoot: undefined,
    };
    const runner = new FakeRunner();

    const subs = new WindowsClaudeAgent(cfg).provision(home, runner) as Record<
      string,
      string
    >;

    // mkdir of the per-run tree happened over ssh
    const sshCalls = runner.calls.filter(
      (c) => c.command === 'sshpass' && c.args.includes('ssh'),
    );
    expect(
      sshCalls.some((c) => c.args.join(' ').includes(`eval-runs\\${runId}`)),
    ).toBe(true);
    // rsync pushed superpowers to the cache
    expect(runner.calls.some((c) => c.command === 'rsync')).toBe(true);
    // launcher substitutions present
    expect(subs['$WIN_SSH_HOST']).toBe('127.0.0.1');
    expect(subs['$WIN_SSH_PORT']).toBe('2222');
    expect(subs['$WIN_LAUNCH_CMD']).toContain(
      `eval-runs\\${runId}\\launch.cmd`,
    );
  });

  test('throws ProvisionError when ANTHROPIC_API_KEY is unset', () => {
    // Load config while key is still set (loadAgentConfig validates required_env),
    // then clear it so provision() itself throws ProvisionError.
    const cfg = loadAgentConfig(
      join(import.meta.dir, '..', 'coding-agents'),
      'claude-windows',
    );
    process.env['ANTHROPIC_API_KEY'] = '';
    const runDir = mkdtempSync(join(tmpdir(), 's-claude-windows-'));
    const home = {
      configDir: join(runDir, 'home', '.claude'),
      workdir: join(runDir, 'coding-agent-workdir'),
      skeletonRoot: undefined,
    };
    expect(() =>
      new WindowsClaudeAgent(cfg).provision(home, new FakeRunner()),
    ).toThrow();
  });
});
