import { basename, dirname } from 'node:path';
import type { AgentConfig, RemoteConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import {
  type CodingAgent,
  ProvisionError,
  type RunHome,
  shellSingleQuote,
} from './index.ts';
import { WindowsHost } from './windows-host.ts';

// Join Windows path segments with backslashes (the guest is native Windows).
function winJoin(...parts: string[]): string {
  return parts.join('\\');
}

// Per-run Windows paths derived from the local runDir's basename (the runId).
function winPaths(remote: RemoteConfig, runId: string) {
  const runRoot = winJoin(remote.win_run_root, runId);
  return {
    runRoot,
    home: winJoin(runRoot, 'home'),
    workdir: winJoin(runRoot, 'workdir'),
    launchCmd: winJoin(runRoot, 'launch.cmd'),
    superpowers: remote.win_superpowers_dir,
  };
}

export class WindowsClaudeAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  private remote(): RemoteConfig {
    const r = this.config.remote;
    if (r === undefined)
      throw new ProvisionError('claude-windows config missing remote block');
    return r;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const remote = this.remote();
    const apiKey = getEnv('ANTHROPIC_API_KEY') ?? '';
    if (apiKey === '')
      throw new ProvisionError(
        'ANTHROPIC_API_KEY not set; cannot provision Windows Claude',
      );

    // runId = the local run dir name (parent of coding-agent-workdir).
    const runId = basename(dirname(home.workdir));
    const p = winPaths(remote, runId);
    const host = new WindowsHost(remote, runner);

    // 1. Fresh per-run guest tree.
    this.run(
      host,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${p.home}\\.claude','${p.workdir}' | Out-Null"`,
    );

    // 2. Seed .claude.json: trust the workdir + approve the API key fingerprint
    //    (same surface ClaudeAgent writes locally). Built as JSON on Linux and
    //    written to the guest via a here-string over ssh stdin-safe powershell.
    const claudeJson = JSON.stringify({
      projects: {
        [p.workdir]: {
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: 1,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
        },
      },
      customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
    });
    this.run(
      host,
      `powershell -NoProfile -Command "Set-Content -LiteralPath '${p.home}\\.claude\\.claude.json' -Value ${shellSingleQuote(claudeJson)} -Encoding utf8"`,
    );

    // 3. Per-run launch.cmd: env + cd + claude. ANTHROPIC_API_KEY lives only on
    //    the guest (outside captured artifacts: capture pulls \workdir and
    //    \home\.claude\projects, not \launch.cmd).
    const launchCmd = [
      '@echo off',
      `set "HOME=${p.home}"`,
      `set "USERPROFILE=${p.home}"`,
      `set "ANTHROPIC_API_KEY=${apiKey}"`,
      'set "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1"',
      `cd /d "${p.workdir}"`,
      `claude --dangerously-skip-permissions --plugin-dir "${p.superpowers}" --model ${this.config.model ?? 'opus'}`,
    ].join('\r\n');
    this.run(
      host,
      `powershell -NoProfile -Command "Set-Content -LiteralPath '${p.launchCmd}' -Value ${shellSingleQuote(launchCmd)} -Encoding ascii"`,
    );

    // 4. Ensure the superpowers checkout is present on the guest (cached).
    const sp = getEnv('SUPERPOWERS_ROOT') ?? '';
    if (sp === '') throw new ProvisionError('SUPERPOWERS_ROOT not set');
    const rsync = host.rsyncTo(sp, p.superpowers);
    if (rsync.status !== 0)
      throw new ProvisionError(
        `superpowers rsync to guest failed: ${rsync.stderr}`,
      );

    // 5. Launcher substitutions consumed by claude-windows-context/launch-agent.
    return {
      $WIN_SSH_PASSWORD: getEnv(remote.password_env) ?? '',
      $WIN_SSH_PORT: String(remote.port),
      $WIN_SSH_USER: remote.user,
      $WIN_SSH_HOST: remote.host,
      $WIN_LAUNCH_CMD: p.launchCmd,
      $WIN_LOG_DIR: winJoin(p.home, '.claude', 'projects'),
    };
  }

  private run(host: WindowsHost, cmd: string): void {
    const r = host.ssh(cmd);
    if (r.status !== 0)
      throw new ProvisionError(
        `guest command failed (${r.status}): ${cmd}\n${r.stderr}`,
      );
  }
}

// Remote artifact movement, gated by the runner on cfg.remote (Task 6).
export class RemoteExecution {
  private readonly remote: RemoteConfig;
  private readonly host: WindowsHost;

  constructor(remote: RemoteConfig, runner: CommandRunner) {
    this.remote = remote;
    this.host = new WindowsHost(remote, runner);
  }

  // After runSetup builds the local workdir, push it to the guest workdir.
  pushWorkdir(localWorkdir: string, runId: string): void {
    const p = winPaths(this.remote, runId);
    const r = this.host.scpTo(localWorkdir, p.runRoot); // lands as <runRoot>\workdir
    if (r.status !== 0)
      throw new Error(`push workdir to guest failed: ${r.stderr}`);
  }

  // After the drive, pull session logs + workdir back into the local run dir.
  captureBack(
    localRunHomeDir: string,
    localWorkdir: string,
    runId: string,
  ): void {
    const p = winPaths(this.remote, runId);
    const r1 = this.host.scpFrom(
      winJoin(p.home, '.claude', 'projects'),
      `${localRunHomeDir}/.claude`,
    );
    if (r1.status !== 0)
      throw new Error(`capture session logs from guest failed: ${r1.stderr}`);
    const r2 = this.host.scpFrom(p.workdir, dirname(localWorkdir));
    if (r2.status !== 0)
      throw new Error(`capture workdir from guest failed: ${r2.stderr}`);
  }
}
