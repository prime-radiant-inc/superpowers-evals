import type { RemoteConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandResult, CommandRunner } from './command-runner.ts';

// Shared OpenSSH options. ControlMaster/ControlPath MUST be off: a host with
// `ControlMaster auto` otherwise multiplexes the connection back onto itself and
// runs the command on the host instead of the guest (observed on magic-kingdom).
const MUX_OFF = [
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
];

// Windows OpenSSH scp requires forward slashes in the remote endpoint even
// though the guest uses backslash paths everywhere else.
function toScpRemotePath(winPath: string): string {
  return winPath.replaceAll('\\', '/');
}

// Agent-neutral SSH/scp/rsync seam into a Windows guest, over the injectable
// CommandRunner so tests assert exact argv with a fake. A future non-Claude
// Windows agent reuses this unchanged.
export class WindowsHost {
  private readonly remote: RemoteConfig;
  private readonly runner: CommandRunner;

  constructor(remote: RemoteConfig, runner: CommandRunner) {
    this.remote = remote;
    this.runner = runner;
  }

  private password(): string {
    const pw = getEnv(this.remote.password_env);
    if (pw === undefined || pw === '') {
      throw new Error(
        `guest SSH password env ${this.remote.password_env} not set`,
      );
    }
    return pw;
  }

  private target(): string {
    return `${this.remote.user}@${this.remote.host}`;
  }

  ssh(remoteCmd: string): CommandResult {
    // No -tt: this is a non-interactive exec seam; a forced PTY over
    // spawnSync's non-TTY stdin silently no-ops the remote command on Windows
    // OpenSSH. The interactive launcher (claude-windows-context/launch-agent)
    // keeps -tt because it runs in a tmux PTY.
    const args = [
      '-p',
      this.password(),
      'ssh',
      ...MUX_OFF,
      '-p',
      String(this.remote.port),
      this.target(),
      remoteCmd,
    ];
    return this.runner.run('sshpass', args);
  }

  scpFrom(winPath: string, localDir: string): CommandResult {
    const args = [
      '-p',
      this.password(),
      'scp',
      '-r',
      ...MUX_OFF,
      '-P',
      String(this.remote.port),
      `${this.target()}:${toScpRemotePath(winPath)}`,
      localDir,
    ];
    return this.runner.run('sshpass', args);
  }

  scpTo(localPath: string, winPath: string): CommandResult {
    const args = [
      '-p',
      this.password(),
      'scp',
      '-r',
      ...MUX_OFF,
      '-P',
      String(this.remote.port),
      localPath,
      `${this.target()}:${toScpRemotePath(winPath)}`,
    ];
    return this.runner.run('sshpass', args);
  }
}
