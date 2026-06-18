import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RemoteExecution,
  WindowsClaudeAgent,
} from '../src/agents/claude-windows.ts';
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

class FailingScpRunner implements CommandRunner {
  calls: { command: string; args: string[]; input: string | undefined }[] = [];
  run(
    command: string,
    args: readonly string[],
    options?: { input?: string },
  ): CommandResult {
    this.calls.push({ command, args: [...args], input: options?.input });
    if (command === 'sshpass' && args.some((a) => a.includes('scp'))) {
      return { status: 1, stdout: '', stderr: 'scp failed' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

describe('WindowsClaudeAgent.provision', () => {
  beforeEach(() => {
    Bun.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    Bun.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sp-'));
  });

  test('creates the per-run guest tree and returns launcher substitutions', () => {
    const cfg = loadAgentConfig(
      join(import.meta.dir, '..', 'coding-agents'),
      'claude-windows',
    );
    const remote = cfg.remote!;
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

    const subs = new WindowsClaudeAgent(cfg, remote).provision(
      home,
      runner,
    ) as Record<string, string>;

    // mkdir of the per-run tree happened over ssh
    const sshCalls = runner.calls.filter(
      (c) => c.command === 'sshpass' && c.args.includes('ssh'),
    );
    expect(
      sshCalls.some((c) => c.args.join(' ').includes(`eval-runs\\${runId}`)),
    ).toBe(true);
    // rsync is not available on the Windows guest; must NOT be called
    expect(runner.calls.some((c) => c.command === 'rsync')).toBe(false);
    // Remove-Item for the shared C:\eval-superpowers must NOT appear
    expect(
      sshCalls.some(
        (c) =>
          c.args.join(' ').includes('Remove-Item') &&
          c.args.join(' ').includes('C:\\eval-superpowers'),
      ),
    ).toBe(false);
    // .claude.json and launch.cmd are written via base64 (FromBase64String in argv)
    expect(
      sshCalls.some((c) => c.args.join(' ').includes('FromBase64String')),
    ).toBe(true);
    // scp (scpTo) copied the superpowers checkout to the per-run dir
    const scpCalls = runner.calls.filter(
      (c) => c.command === 'sshpass' && c.args.includes('scp'),
    );
    expect(
      scpCalls.some((c) =>
        c.args.join(' ').includes(`eval-runs/${runId}/superpowers`),
      ),
    ).toBe(true);
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
    const remote = cfg.remote!;
    Bun.env['ANTHROPIC_API_KEY'] = '';
    const runDir = mkdtempSync(join(tmpdir(), 's-claude-windows-'));
    const home = {
      configDir: join(runDir, 'home', '.claude'),
      workdir: join(runDir, 'coding-agent-workdir'),
      skeletonRoot: undefined,
    };
    expect(() =>
      new WindowsClaudeAgent(cfg, remote).provision(home, new FakeRunner()),
    ).toThrow();
  });
});

describe('RemoteExecution.captureBack', () => {
  beforeEach(() => {
    Bun.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
  });

  test('throws when scpFrom fails', () => {
    const cfg = loadAgentConfig(
      join(import.meta.dir, '..', 'coding-agents'),
      'claude-windows',
    );
    const remote = cfg.remote;
    if (!remote) throw new Error('remote config required');

    const localRunHomeDir = mkdtempSync(join(tmpdir(), 'capture-test-'));
    const localWorkdir = join(localRunHomeDir, 'coding-agent-workdir');
    const runId = localRunHomeDir.split('/').pop()!;

    const runner = new FailingScpRunner();
    const exec = new RemoteExecution(remote, runner);

    expect(() =>
      exec.captureBack(localRunHomeDir, localWorkdir, runId),
    ).toThrow();
  });
});
