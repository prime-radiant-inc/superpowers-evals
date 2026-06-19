#!/usr/bin/env bun
import { Command } from 'commander';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import { getEnv } from '../env.ts';
import { loadConfig } from './config.ts';
import { toErrorJson } from './errors.ts';
import { createJob, readJob } from './jobs.ts';
import { prepare } from './preflight.ts';
import { cancelJob, runWorker, spawnDetachedWorker } from './process.ts';
import { costsPayload, showPayload, statusPayload } from './summary.ts';

interface BaseCommandArgs {
  readonly json: boolean;
}

export interface DoctorCommandArgs extends BaseCommandArgs {}

export interface PrepareCommandArgs extends BaseCommandArgs {
  readonly superpowersRef: string;
}

export interface RunCommandArgs extends PrepareCommandArgs {
  readonly detach: boolean;
  readonly scenario: string;
  readonly agent: string;
}

export interface RunAllCommandArgs extends PrepareCommandArgs {
  readonly detach: boolean;
  readonly quorumArgs: readonly string[];
}

export interface IdCommandArgs extends BaseCommandArgs {
  readonly id: string;
}

export type ApplianceActionResult = unknown;

export interface ApplianceActions {
  readonly doctor: (
    args: DoctorCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly prepare: (
    args: PrepareCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly run: (
    args: RunCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly runAll: (
    args: RunAllCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly status: (
    args: IdCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly cancel: (
    args: IdCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly show: (
    args: IdCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly costs: (
    args: IdCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
}

export interface ApplianceCliDeps {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly actions?: Partial<ApplianceActions>;
}

interface JsonOption {
  readonly json?: boolean;
}

interface JsonDetachOptions extends JsonOption {
  readonly detach?: boolean;
}

function requester(): {
  readonly agent: string | null;
  readonly thread: string | null;
  readonly task: string | null;
} {
  return {
    agent: getEnv('EVALS_APPLIANCE_AGENT') ?? null,
    thread: getEnv('EVALS_APPLIANCE_THREAD') ?? null,
    task: getEnv('EVALS_APPLIANCE_TASK') ?? null,
  };
}

function asSuccessJson(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if ('ok' in value) {
      return value;
    }
    return { ok: true, ...value };
  }
  return { ok: true, result: value };
}

function renderResult(value: unknown, json: boolean): string {
  if (json) {
    return `${JSON.stringify(asSuccessJson(value), null, 2)}\n`;
  }
  if (typeof value === 'string') {
    return value.endsWith('\n') ? value : `${value}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultActions(): ApplianceActions {
  return {
    doctor: async () => {
      const loaded = loadConfig();
      return {
        ok: true,
        config_path: loaded.configPath,
        root: loaded.config.root,
        evals_ref: loaded.config.evals.ref,
        credential_bundle: {
          name: loaded.config.credential_bundle.name,
          bundle_id: loaded.bundle.bundle_id,
          providers: loaded.bundle.providers,
          rotated_at: loaded.bundle.rotated_at,
        },
      };
    },
    prepare: async (args) => {
      const loaded = loadConfig();
      const job = createJob(loaded, {
        kind: 'prepare',
        superpowersRef: args.superpowersRef,
        argv: ['prepare'],
        requester: requester(),
      });
      const result = await prepare({
        loaded,
        jobId: job.job_id,
        superpowersRef: args.superpowersRef,
        argv: ['prepare'],
        requester: requester(),
      });
      return { ok: true, job_id: job.job_id, ...result };
    },
    run: async (args) => {
      const argv = [
        'quorum',
        'run',
        args.scenario,
        '--coding-agent',
        args.agent,
      ];
      return submitLiveJob({
        kind: 'run',
        superpowersRef: args.superpowersRef,
        argv,
        detach: args.detach,
      });
    },
    runAll: async (args) =>
      submitLiveJob({
        kind: 'run-all',
        superpowersRef: args.superpowersRef,
        argv: ['quorum', 'run-all', ...args.quorumArgs],
        detach: args.detach,
      }),
    status: async (args) => {
      const loaded = loadConfig();
      return statusPayload(loaded, args.id);
    },
    cancel: async (args) => {
      const loaded = loadConfig();
      return cancelJob(loaded, args.id, defaultCommandRunner);
    },
    show: async (args) => {
      const loaded = loadConfig();
      return showPayload(loaded, args.id, args.json);
    },
    costs: async (args) => {
      const loaded = loadConfig();
      return costsPayload(loaded, args.id, args.json);
    },
  };
}

async function submitLiveJob(args: {
  readonly kind: 'run' | 'run-all';
  readonly superpowersRef: string;
  readonly argv: readonly string[];
  readonly detach: boolean;
}): Promise<unknown> {
  const loaded = loadConfig();
  const job = createJob(loaded, {
    kind: args.kind,
    superpowersRef: args.superpowersRef,
    argv: args.argv,
    requester: requester(),
  });

  if (args.detach) {
    spawnDetachedWorker(loaded, job.job_id);
    return readJob(loaded, job.job_id);
  }

  await runWorker(loaded, job.job_id);
  return readJob(loaded, job.job_id);
}

function mergedActions(actions?: Partial<ApplianceActions>): ApplianceActions {
  return { ...defaultActions(), ...actions };
}

async function handleAction(
  args: BaseCommandArgs,
  deps: Required<Pick<ApplianceCliDeps, 'stdout' | 'stderr' | 'setExitCode'>>,
  action: () => ApplianceActionResult | Promise<ApplianceActionResult>,
): Promise<void> {
  try {
    deps.stdout(renderResult(await action(), args.json));
  } catch (error) {
    if (args.json) {
      deps.stdout(`${JSON.stringify(toErrorJson(error), null, 2)}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      deps.stderr(`${message}\n`);
    }
    deps.setExitCode(1);
  }
}

function commandOptions(options: JsonOption): BaseCommandArgs {
  return { json: options.json ?? false };
}

function commandDetachOptions(options: JsonDetachOptions): {
  readonly json: boolean;
  readonly detach: boolean;
} {
  return {
    json: options.json ?? false,
    detach: options.detach ?? false,
  };
}

export function createApplianceProgram(deps: ApplianceCliDeps = {}): Command {
  const resolvedDeps = {
    stdout: deps.stdout ?? ((text: string) => process.stdout.write(text)),
    stderr: deps.stderr ?? ((text: string) => process.stderr.write(text)),
    setExitCode:
      deps.setExitCode ??
      ((code: number) => {
        process.exitCode = code;
      }),
  };
  const actions = mergedActions(deps.actions);
  const program = new Command();

  program
    .name('evals-appliance')
    .description('Shared quorum eval appliance helper')
    .addHelpCommand(false)
    .configureOutput({
      writeOut: resolvedDeps.stdout,
      writeErr: resolvedDeps.stderr,
    });

  program
    .command('doctor')
    .option('--json', 'emit JSON')
    .action((options: JsonOption) => {
      const args = commandOptions(options);
      return handleAction(args, resolvedDeps, () => actions.doctor(args));
    });

  program
    .command('prepare')
    .requiredOption('--superpowers-ref <ref>')
    .option('--json', 'emit JSON')
    .action((options: JsonOption & { superpowersRef: string }) => {
      const args = {
        ...commandOptions(options),
        superpowersRef: options.superpowersRef,
      };
      return handleAction(args, resolvedDeps, () => actions.prepare(args));
    });

  program
    .command('run')
    .requiredOption('--superpowers-ref <ref>')
    .requiredOption('--scenario <name>')
    .requiredOption('--coding-agent <agent>')
    .option('--json', 'emit JSON')
    .option('--detach', 'run in a detached appliance worker')
    .action(
      (
        options: JsonDetachOptions & {
          superpowersRef: string;
          scenario: string;
          codingAgent: string;
        },
      ) => {
        const args = {
          ...commandDetachOptions(options),
          superpowersRef: options.superpowersRef,
          scenario: options.scenario,
          agent: options.codingAgent,
        };
        return handleAction(args, resolvedDeps, () => actions.run(args));
      },
    );

  program
    .command('run-all')
    .requiredOption('--superpowers-ref <ref>')
    .option('--json', 'emit JSON')
    .option('--detach', 'run in a detached appliance worker')
    .argument('[quorumArgs...]')
    .action(
      (
        quorumArgs: string[],
        options: JsonDetachOptions & { superpowersRef: string },
      ) => {
        const args = {
          ...commandDetachOptions(options),
          superpowersRef: options.superpowersRef,
          quorumArgs,
        };
        return handleAction(args, resolvedDeps, () => actions.runAll(args));
      },
    );

  program
    .command('status')
    .option('--json', 'emit JSON')
    .argument('<job-id>')
    .action((id: string, options: JsonOption) => {
      const args = { ...commandOptions(options), id };
      return handleAction(args, resolvedDeps, () => actions.status(args));
    });

  program
    .command('cancel')
    .option('--json', 'emit JSON')
    .argument('<job-id>')
    .action((id: string, options: JsonOption) => {
      const args = { ...commandOptions(options), id };
      return handleAction(args, resolvedDeps, () => actions.cancel(args));
    });

  program
    .command('show')
    .option('--json', 'emit JSON')
    .argument('<job-id-or-artifact-id>')
    .action((id: string, options: JsonOption) => {
      const args = { ...commandOptions(options), id };
      return handleAction(args, resolvedDeps, () => actions.show(args));
    });

  program
    .command('costs')
    .option('--json', 'emit JSON')
    .argument('<job-id-or-artifact-id>')
    .action((id: string, options: JsonOption) => {
      const args = { ...commandOptions(options), id };
      return handleAction(args, resolvedDeps, () => actions.costs(args));
    });

  return program;
}

if (import.meta.main) {
  await createApplianceProgram().parseAsync();
}
