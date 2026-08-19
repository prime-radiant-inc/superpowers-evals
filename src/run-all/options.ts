import type { Command } from 'commander';
import { DEFAULT_JOBS } from '../scheduler/index.ts';

export interface RunAllOptions {
  readonly codingAgents?: string;
  readonly scenarios?: string;
  readonly credentials?: string;
  readonly credentialsFile?: string;
  readonly jobs: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly tier?: string;
  readonly includeDrafts: boolean;
  readonly heartbeatSeconds: string;
  readonly graderModel?: string;
}

interface ValueOption {
  readonly flag: string;
  readonly declaration: string;
  readonly description: string;
  readonly defaultValue?: string;
  readonly kind: 'value';
}

interface BooleanOption {
  readonly flag: string;
  readonly declaration: string;
  readonly description: string;
  readonly defaultValue: boolean;
  readonly kind: 'boolean';
}

type RunAllOption = ValueOption | BooleanOption;

const RUN_ALL_OPTIONS: readonly RunAllOption[] = [
  {
    flag: '--coding-agents',
    declaration: '--coding-agents <csv>',
    description: 'CSV agent filter (default: all)',
    kind: 'value',
  },
  {
    flag: '--scenarios',
    declaration: '--scenarios <csv>',
    description: 'CSV scenario filter (default: all)',
    kind: 'value',
  },
  {
    flag: '--credentials',
    declaration: '--credentials <csv>',
    description: 'CSV credential filter (default: agent default_credential)',
    kind: 'value',
  },
  {
    flag: '--credentials-file',
    declaration: '--credentials-file <path>',
    description: 'credentials YAML path',
    kind: 'value',
  },
  {
    flag: '--jobs',
    declaration: '--jobs <n>',
    description: 'global slot pool size (>=1)',
    defaultValue: String(DEFAULT_JOBS),
    kind: 'value',
  },
  {
    flag: '--scenarios-root',
    declaration: '--scenarios-root <dir>',
    description: 'scenarios root',
    defaultValue: 'scenarios',
    kind: 'value',
  },
  {
    flag: '--coding-agents-dir',
    declaration: '--coding-agents-dir <dir>',
    description: 'agents dir',
    defaultValue: 'coding-agents',
    kind: 'value',
  },
  {
    flag: '--out-root',
    declaration: '--out-root <dir>',
    description: 'results root',
    defaultValue: 'results',
    kind: 'value',
  },
  {
    flag: '--tier',
    declaration: '--tier <tier>',
    description: 'restrict to sentinel|full|adhoc',
    kind: 'value',
  },
  {
    flag: '--include-drafts',
    declaration: '--include-drafts',
    description: 'include status: draft scenarios',
    defaultValue: false,
    kind: 'boolean',
  },
  {
    flag: '--heartbeat-seconds',
    declaration: '--heartbeat-seconds <n>',
    description: 'seconds between liveness heartbeats (0 disables)',
    defaultValue: '30',
    kind: 'value',
  },
  {
    flag: '--grader-model',
    declaration: '--grader-model <id>',
    description:
      'Gauntlet-Agent (grader) model for every cell (default: claude-sonnet-5)',
    kind: 'value',
  },
];

export class RunAllArgvError extends Error {}

export interface ParsedRunAllArgv {
  readonly values: ReadonlyMap<string, readonly string[]>;
}

/**
 * Owns the public `quorum run-all` option grammar. The appliance also parses
 * durable forwarded argv through this table before attaching credentials, so
 * option ownership cannot drift between submission, execution, and Quorum.
 */
export function configureRunAllOptions(command: Command): Command {
  for (const option of RUN_ALL_OPTIONS) {
    command.option(option.declaration, option.description, option.defaultValue);
  }
  return command;
}

/**
 * Parses the no-positional-argument `run-all` grammar without resolving
 * defaults. Values are consumed by their owning option; a delimiter,
 * positional token, unknown flag, or option-shaped value fails closed.
 */
export function parseRunAllArgv(args: readonly string[]): ParsedRunAllArgv {
  const options = new Map(
    RUN_ALL_OPTIONS.map((option) => [option.flag, option]),
  );
  const values = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    if (token === '--') {
      throw new RunAllArgvError('run-all accepts no positional arguments');
    }

    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const option = options.get(flag);
    if (option === undefined) {
      throw new RunAllArgvError(
        token.startsWith('-')
          ? `run-all does not support option ${flag}`
          : `run-all accepts no positional argument: ${token}`,
      );
    }

    if (option.kind === 'boolean') {
      if (equals !== -1) {
        throw new RunAllArgvError(`${flag} does not take a value`);
      }
      const occurrences = values.get(flag) ?? [];
      occurrences.push('true');
      values.set(flag, occurrences);
      continue;
    }

    const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || value.startsWith('-')) {
      throw new RunAllArgvError(`${flag} requires a non-option value`);
    }
    if (equals === -1) {
      index += 1;
    }
    const occurrences = values.get(flag) ?? [];
    occurrences.push(value);
    values.set(flag, occurrences);
  }

  return { values };
}
