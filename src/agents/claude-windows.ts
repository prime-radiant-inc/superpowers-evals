import { mkdirSync, renameSync, rmSync } from 'node:fs';
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
  // A missing guest projects dir (no-log run) is tolerated — logs capture is
  // skipped. A missing guest workdir is also tolerated — the local workdir is
  // left untouched. The guest workdir is pulled to a temp sibling and swapped
  // onto localWorkdir only on success, so a failed pull never destroys the
  // pre-run fixture (#5, #7).
  captureBack(
    localRunHomeDir: string,
    localWorkdir: string,
    runId: string,
  ): void {
    const p = winPaths(this.remote, runId);
    // Create the local .claude dir first so `scp -r host:...\projects
    // <dest>/.claude` lands the projects tree at <dest>/.claude/projects
    // (rather than renaming projects -> .claude into an absent parent).
    mkdirSync(join(localRunHomeDir, '.claude'), { recursive: true });
    const logs = this.host.scpFrom(
      winJoin(p.home, '.claude', 'projects'),
      join(localRunHomeDir, '.claude'),
    );
    if (logs.status !== 0 && !/no such file|not exist/i.test(logs.stderr)) {
      throw new Error(`capture session logs from guest failed: ${logs.stderr}`);
    }
    // Pull the guest workdir to a temp sibling, then atomic-rename onto
    // localWorkdir so a failed pull never destroys the pre-run fixture.
    const tmp = `${localWorkdir}.incoming-${runId}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const wd = this.host.scpFrom(p.workdir, tmp);
    if (wd.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      if (/no such file|not exist/i.test(wd.stderr)) return;
      throw new Error(`capture workdir from guest failed: ${wd.stderr}`);
    }
    rmSync(localWorkdir, { recursive: true, force: true });
    renameSync(join(tmp, 'coding-agent-workdir'), localWorkdir);
    rmSync(tmp, { recursive: true, force: true });
  }
}
