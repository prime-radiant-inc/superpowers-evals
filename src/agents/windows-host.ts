import type { RemoteConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandResult, CommandRunner } from './command-runner.ts';

// Shared OpenSSH options. ControlMaster/ControlPath MUST be off: a host with
// `ControlMaster auto` otherwise multiplexes the connection back onto itself and
// runs the command on the host instead of the guest (observed on magic-kingdom).
const MUX_OFF = [
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
];

// Single-quote a value for the shell rsync runs for its -e transport. Inlined
// (not imported from ./index.ts) to avoid an import cycle.
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
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
      throw new Error(`guest SSH password env ${this.remote.password_env} not set`);
    }
    return pw;
  }

  private target(): string {
    return `${this.remote.user}@${this.remote.host}`;
  }

  ssh(remoteCmd: string): CommandResult {
    const args = [
      '-p', this.password(),
      'ssh', '-tt', ...MUX_OFF,
      '-p', String(this.remote.port),
      this.target(),
      remoteCmd,
    ];
    return this.runner.run('sshpass', args);
  }

  scpFrom(winPath: string, localDir: string): CommandResult {
    const args = [
      '-p', this.password(),
      'scp', '-r', ...MUX_OFF,
      '-P', String(this.remote.port),
      `${this.target()}:${winPath}`,
      localDir,
    ];
    return this.runner.run('sshpass', args);
  }

  scpTo(localPath: string, winPath: string): CommandResult {
    const args = [
      '-p', this.password(),
      'scp', '-r', ...MUX_OFF,
      '-P', String(this.remote.port),
      localPath,
      `${this.target()}:${winPath}`,
    ];
    return this.runner.run('sshpass', args);
  }

  // rsync over the same mux-off ssh. Used for the cached superpowers checkout.
  rsyncTo(localDir: string, winDir: string): CommandResult {
    const sshCmd = `sshpass -p ${shQuote(this.password())} ssh -tt ${MUX_OFF.join(' ')} -p ${this.remote.port}`;
    const args = ['-a', '--delete', '-e', sshCmd, `${localDir}/`, `${this.target()}:${winDir}`];
    return this.runner.run('rsync', args);
  }
}
