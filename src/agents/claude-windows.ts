import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentConfig, RemoteConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { WindowsHost } from './windows-host.ts';

// Join Windows path segments with backslashes (the guest is native Windows).
function winJoin(...parts: string[]): string {
  return parts.join('\\');
}

// Per-run Windows paths derived from the local runDir's basename (the runId).
// superpowers is per-run under runRoot so each run gets a clean plugin copy.
function winPaths(remote: RemoteConfig, runId: string) {
  const runRoot = winJoin(remote.win_run_root, runId);
  return {
    runRoot,
    home: winJoin(runRoot, 'home'),
    // Must match the LOCAL workdir basename (coding-agent-workdir): `scp -r
    // <localWorkdir> host:<runRoot>` lands the dir under its own basename, and
    // captureBack pulls it back to the same local name.
    workdir: winJoin(runRoot, 'coding-agent-workdir'),
    launchCmd: winJoin(runRoot, 'launch.cmd'),
    superpowers: winJoin(runRoot, 'superpowers'),
  };
}

export class WindowsClaudeAgent implements CodingAgent {
  readonly config: AgentConfig;
  readonly remote: RemoteConfig;
  constructor(config: AgentConfig, remote: RemoteConfig) {
    this.config = config;
    this.remote = remote;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const remote = this.remote;
    const apiKey = getEnv('ANTHROPIC_API_KEY') ?? '';
    if (apiKey === '')
      throw new ProvisionError(
        'ANTHROPIC_API_KEY not set; cannot provision Windows Claude',
      );

    // runId = the local run dir name (parent of coding-agent-workdir).
    const runId = basename(dirname(home.workdir));
    const p = winPaths(remote, runId);
    const host = new WindowsHost(remote, runner);

    // 1. Fresh per-run guest tree. Create ONLY the home\.claude chain (which
    //    also makes runRoot + home). The workdir is deliberately NOT
    //    pre-created: pushWorkdir's `scp -r` creates it cleanly, and a
    //    pre-existing dir would make scp nest the pushed dir inside it.
    this.run(
      host,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${p.home}\\.claude' | Out-Null"`,
    );

    // 2. Seed .claude.json: trust the workdir + approve the API key fingerprint
    //    (same surface ClaudeAgent writes locally). Written via base64 so the
    //    JSON content never appears raw in argv.
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
    try {
      host.writeFileBase64(
        winJoin(p.home, '.claude', '.claude.json'),
        claudeJson,
        { secret: true },
      );
    } catch (e) {
      throw new ProvisionError(
        `seed .claude.json failed: ${(e as Error).message}`,
      );
    }

    // 3. Per-run launch.cmd: env + cd + claude. ANTHROPIC_API_KEY is written
    //    via base64 so the key never appears raw in argv. The file itself lives
    //    outside captured artifacts (\launch.cmd, not \workdir or
    //    \home\.claude\projects).
    const launchCmd = [
      '@echo off',
      `set "HOME=${p.home}"`,
      `set "USERPROFILE=${p.home}"`,
      `set "ANTHROPIC_API_KEY=${apiKey}"`,
      'set "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1"',
      `cd /d "${p.workdir}"`,
      `claude --dangerously-skip-permissions --plugin-dir "${p.superpowers}" --model ${this.config.model ?? 'opus'}`,
    ].join('\r\n');
    try {
      host.writeFileBase64(p.launchCmd, launchCmd, { secret: true });
    } catch (e) {
      throw new ProvisionError(
        `seed launch.cmd failed: ${(e as Error).message}`,
      );
    }

    // 4. Copy the superpowers checkout into the per-run dir on the guest.
    //    Each run gets its own copy (no shared dir). rsync is not available on
    //    the Windows guest; use scp. Dest is absent + parent runRoot exists, so
    //    scp lands contents at p.superpowers directly.
    const sp = getEnv('SUPERPOWERS_ROOT') ?? '';
    if (sp === '') throw new ProvisionError('SUPERPOWERS_ROOT not set');
    const sync = host.scpTo(sp, p.superpowers);
    if (sync.status !== 0)
      throw new ProvisionError(
        `superpowers scp to guest failed: ${sync.stderr}`,
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
    const r = this.host.scpTo(localWorkdir, p.runRoot); // lands as <runRoot>\coding-agent-workdir, matching p.workdir
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
    // Create the local .claude dir first so `scp -r host:...\projects
    // <dest>/.claude` lands the projects tree at <dest>/.claude/projects
    // (rather than renaming projects -> .claude into an absent parent).
    const localClaudeDir = join(localRunHomeDir, '.claude');
    mkdirSync(localClaudeDir, { recursive: true });
    const r1 = this.host.scpFrom(
      winJoin(p.home, '.claude', 'projects'),
      localClaudeDir,
    );
    if (r1.status !== 0)
      throw new Error(`capture session logs from guest failed: ${r1.stderr}`);
    // The local coding-agent-workdir already exists (the pre-run fixture).
    // Remove it before the pull so (a) scp does not nest the pulled dir inside
    // it and (b) post-checks see the GUEST's final state, not the pre-run
    // fixture. With p.workdir basename now coding-agent-workdir, the pull lands
    // at dirname(localWorkdir)/coding-agent-workdir === localWorkdir.
    rmSync(localWorkdir, { recursive: true, force: true });
    const r2 = this.host.scpFrom(p.workdir, dirname(localWorkdir));
    if (r2.status !== 0)
      throw new Error(`capture workdir from guest failed: ${r2.stderr}`);
  }
}
