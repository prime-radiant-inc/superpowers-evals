import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';

// One recorded CommandRunner.run invocation, for assertions in adapter tests.
export interface RecordedCommand {
  readonly command: string;
  readonly args: string[];
  readonly options: CommandOptions | undefined;
}

type Responder = (command: string, args: readonly string[]) => CommandResult;

const OK: CommandResult = { status: 0, stdout: '', stderr: '' };

// Test double for CommandRunner. Records every invocation on `calls` and returns
// either a default success ({status:0}) or a caller-supplied responder's result
// (e.g. a preflight that replies "OK", or `gemini extensions list` output).
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  private readonly responder: Responder;

  constructor(responder?: Responder) {
    this.responder = responder ?? (() => OK);
  }

  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push({ command, args: [...args], options });
    return this.responder(command, args);
  }
}
