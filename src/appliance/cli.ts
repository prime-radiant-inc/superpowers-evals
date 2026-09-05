#!/usr/bin/env bun
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Command } from 'commander';
import {
  type CommandRunner,
  defaultCommandRunner,
} from '../agents/command-runner.ts';
import {
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import {
  type CredentialSelection,
  EMPTY_CREDENTIAL_SCOPE,
} from '../credentials/scope.ts';
import { getEnv } from '../env.ts';
import {
  type ParsedRunAllArgv,
  parseRunAllArgv,
  RunAllArgvError,
} from '../run-all/options.ts';
import {
  type LoadConfigOptions,
  loadCredentialConfig,
  loadStateConfig,
} from './config.ts';
import {
  buildLiveCredentialRequest,
  type LiveCredentialRequest,
} from './credential-request.ts';
import { doctorPayload } from './doctor.ts';
import { ApplianceError, toErrorJson } from './errors.ts';
import { currentCheckoutSha } from './git.ts';
import { importBundle } from './import.ts';
import { createJob, readJob } from './jobs.ts';
import { prepare } from './preflight.ts';
import { cancelJob, runWorker, spawnDetachedWorker } from './process.ts';
import { prune as pruneResults } from './prune.ts';
import { costsPayload, showPayload, statusPayload } from './summary.ts';
import {
  GraderModelSchema,
  type LoadedApplianceConfig,
  type LoadedApplianceStateConfig,
} from './types.ts';

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
  // The normalized operator selection: a validated single credential name, or
  // null for "the agent's default". The resolved concrete name lives on the
  // request's scope; this preserves what was actually asked for, and drives
  // the generated Quorum argv.
  readonly credential: string | null;
  readonly graderModel?: string;
}

export interface RunAllCommandArgs extends PrepareCommandArgs {
  readonly detach: boolean;
  readonly quorumArgs: readonly string[];
}

export interface IdCommandArgs extends BaseCommandArgs {
  readonly id: string;
}

export interface ImportCommandArgs extends BaseCommandArgs {
  readonly bundleDir: string;
}

export interface PruneCommandArgs extends BaseCommandArgs {
  readonly apply: boolean;
  readonly olderThanDays: number;
}

export type ApplianceActionResult = unknown;

export interface ApplianceActions {
  readonly doctor: (
    args: DoctorCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly prepare: (
    args: PrepareCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  // Live commands receive the credential request the program action already
  // resolved. It is an input, not something the action recomputes: fakes
  // observe exactly what the real writer would persist.
  readonly run: (
    args: RunCommandArgs,
    request: LiveCredentialRequest,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly runAll: (
    args: RunAllCommandArgs,
    request: LiveCredentialRequest,
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
  readonly import: (
    args: ImportCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
  readonly prune: (
    args: PruneCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
}

export interface ApplianceCliDeps {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
  // Argument validation only needs the structural config; the credential
  // bundle is never consulted at this layer.
  readonly loadConfig?: () => LoadedApplianceStateConfig;
  readonly actions?: Partial<ApplianceActions>;
}

interface JsonOption {
  readonly json?: boolean;
}

interface JsonDetachOptions extends JsonOption {
  readonly detach?: boolean;
}

const UNSUPPORTED_APPLIANCE_AGENTS = new Set(['antigravity']);
// Forwarded flags the appliance refuses to honour, with why. The first three
// would relocate the trusted roots the appliance controls; --credentials-file
// would swap the blessed registry the bundle was built for; --credential is
// run's flag, and accepting it on run-all would leave the real selection
// (--credentials) unset while looking like it had been made.
const FORBIDDEN_RUN_ALL_FLAGS: ReadonlyMap<string, string> = new Map([
  ['--coding-agents-dir', 'is controlled by the Phase 1 appliance'],
  ['--out-root', 'is controlled by the Phase 1 appliance'],
  ['--scenarios-root', 'is controlled by the Phase 1 appliance'],
  ['--credentials-file', 'is controlled by the Phase 1 appliance'],
  [
    '--credential',
    'is not a run-all flag; use --credentials with exactly one credential',
  ],
]);

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

function csv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function optionOccurrences(
  parsed: ParsedRunAllArgv,
  name: string,
): readonly string[] {
  return parsed.values.get(name) ?? [];
}

function rejectUnsupportedAgent(agent: string): never {
  throw new ApplianceError(
    'unsupported_os',
    'arguments',
    `${agent} is not supported on the Phase 1 appliance`,
  );
}

function assertSupportedAgent(agent: string, codingAgentsDir?: string): void {
  if (
    agent.length === 0 ||
    agent.startsWith('--') ||
    UNSUPPORTED_APPLIANCE_AGENTS.has(agent.toLowerCase())
  ) {
    rejectUnsupportedAgent(agent);
  }

  if (codingAgentsDir === undefined) {
    return;
  }

  try {
    const config = loadAgentConfigForValidation(codingAgentsDir, agent);
    if (
      UNSUPPORTED_APPLIANCE_AGENTS.has(agentRuntimeFamily(config).toLowerCase())
    ) {
      rejectUnsupportedAgent(agent);
    }
  } catch (error) {
    if (error instanceof ApplianceError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplianceError(
      'unsupported_os',
      'arguments',
      `${agent} is not supported on the Phase 1 appliance: ${message}`,
    );
  }
}

function assertNoDuplicateOption(parsed: ParsedRunAllArgv, name: string): void {
  if (optionOccurrences(parsed, name).length > 1) {
    throw new ApplianceError(
      'unsupported_os',
      'arguments',
      `duplicate ${name} is not supported on the Phase 1 appliance`,
    );
  }
}

function assertNoForbiddenRunAllFlags(parsed: ParsedRunAllArgv): void {
  for (const [flag, reason] of FORBIDDEN_RUN_ALL_FLAGS) {
    if (optionOccurrences(parsed, flag).length > 0) {
      throw new ApplianceError(
        'unsupported_os',
        'arguments',
        `run-all ${flag} ${reason}`,
      );
    }
  }
}

function rejectSelection(message: string): never {
  throw new ApplianceError('unsupported_os', 'arguments', message);
}

// One credential name, or nothing. A value that is blank, comma-bearing, or
// option-shaped is ambiguous about which single cell the job is, and an
// ambiguous selection must never reach job creation — the persisted scope
// would then assert something the operator did not choose.
function normalizeCredentialValue(
  raw: string | null,
  flag: string,
  allowCsv: boolean,
): string {
  if (raw === null) {
    rejectSelection(`appliance ${flag} requires exactly one credential`);
  }
  const value = raw.trim();
  if (value === '') {
    rejectSelection(`appliance ${flag} requires exactly one credential`);
  }
  if (value.startsWith('-')) {
    rejectSelection(
      `appliance ${flag} value looks like an option, not a credential: ${value}`,
    );
  }
  if (!allowCsv) {
    if (value.includes(',')) {
      rejectSelection(
        `appliance ${flag} takes exactly one credential, not a list: ${value}`,
      );
    }
    return value;
  }
  const entries = csv(value);
  const only = entries[0];
  if (entries.length !== 1 || only === undefined) {
    rejectSelection(
      `appliance ${flag} takes exactly one credential, got: ${value}`,
    );
  }
  return only;
}

// `run --credential`: omitted, or exactly one nonempty name. Commander keeps
// the LAST value for a repeated option, so duplicates are counted from the
// collected occurrences rather than silently resolved.
function normalizeRunCredential(occurrences: readonly string[]): string | null {
  if (occurrences.length === 0) {
    return null;
  }
  if (occurrences.length > 1) {
    rejectSelection(
      'duplicate --credential is not supported on the Phase 1 appliance',
    );
  }
  return normalizeCredentialValue(
    occurrences[0] ?? null,
    '--credential',
    false,
  );
}

function normalizeRunGraderModel(
  occurrences: readonly string[],
): string | undefined {
  if (occurrences.length === 0) return undefined;
  const model = occurrences[0];
  if (
    occurrences.length !== 1 ||
    model === undefined ||
    !GraderModelSchema.safeParse(model).success
  ) {
    rejectSelection(
      '--grader-model requires exactly one nonempty model identifier',
    );
  }
  return model;
}

// Validate the forwarded Quorum argv and read the ONE (agent, credential)
// cell it selects out of it. The argv itself is never rewritten — it is
// preserved verbatim for the worker — so this only reads.
//
// The asserted cell is exactly this normalized selection, not a union
// re-derived from scenario eligibility. A run-all that later finds zero
// runnable scenarios does no useful work, but it cannot widen into a second
// agent or credential, because a mixed selection never gets this far.
function assertSupportedRunAllArgs(
  args: readonly string[],
  loadConfig: () => LoadedApplianceStateConfig,
): {
  readonly loaded: LoadedApplianceStateConfig;
  readonly selection: CredentialSelection;
} {
  let parsed: ParsedRunAllArgv;
  try {
    parsed = parseRunAllArgv(args);
  } catch (error) {
    if (!(error instanceof RunAllArgvError)) {
      throw error;
    }
    throw new ApplianceError('unsupported_os', 'arguments', error.message);
  }
  assertNoDuplicateOption(parsed, '--coding-agents');
  assertNoDuplicateOption(parsed, '--credentials');
  assertNoForbiddenRunAllFlags(parsed);

  const codingAgents = optionOccurrences(parsed, '--coding-agents')[0] ?? null;
  if (codingAgents === null || codingAgents.trim() === '') {
    throw new ApplianceError(
      'unsupported_os',
      'arguments',
      'appliance run-all requires explicit --coding-agents',
    );
  }
  const agents = csv(codingAgents);
  if (agents.length === 0) {
    throw new ApplianceError(
      'unsupported_os',
      'arguments',
      'appliance run-all requires explicit --coding-agents',
    );
  }
  const agent = agents[0];
  if (agents.length !== 1 || agent === undefined) {
    throw new ApplianceError(
      'unsupported_os',
      'arguments',
      `appliance run-all takes exactly one --coding-agents entry (one agent per job), got: ${codingAgents}`,
    );
  }
  assertSupportedAgent(agent);

  // Absent is the agent default; present must name exactly one credential.
  // The shared parser keeps each actual occurrence, so duplicates cannot be
  // silently reduced to Commander's last value.
  const credentialOccurrences = optionOccurrences(parsed, '--credentials');
  const credential =
    credentialOccurrences.length === 0
      ? null
      : normalizeCredentialValue(
          credentialOccurrences[0] ?? null,
          '--credentials',
          true,
        );

  const loaded = loadConfig();
  assertSupportedAgent(agent, join(loaded.config.evals.path, 'coding-agents'));
  return { loaded, selection: { agent, credential } };
}

function normalizeScenarioPath(
  scenario: string,
  loaded: LoadedApplianceStateConfig,
): string {
  const value = scenario.trim();
  const scenariosRoot = join(loaded.config.evals.path, 'scenarios');
  if (value === '') {
    throw new ApplianceError(
      'config_invalid',
      'arguments',
      'scenario must not be blank',
    );
  }
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new ApplianceError(
      'config_invalid',
      'arguments',
      `scenario must stay under ${scenariosRoot}: ${scenario}`,
    );
  }

  const relativeScenario = value.includes('/') ? value : `scenarios/${value}`;
  const target = join(loaded.config.evals.path, relativeScenario);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new ApplianceError(
      'config_invalid',
      'arguments',
      `trusted scenario not found: ${scenario}`,
    );
  }
  const realRoot = realpathSync(scenariosRoot);
  const realTarget = realpathSync(target);
  const targetWithinRoot = relative(realRoot, realTarget);
  if (
    targetWithinRoot === '' ||
    targetWithinRoot.startsWith('..') ||
    isAbsolute(targetWithinRoot)
  ) {
    throw new ApplianceError(
      'config_invalid',
      'arguments',
      `scenario must stay under ${scenariosRoot}: ${scenario}`,
    );
  }
  return `scenarios/${targetWithinRoot.split(sep).join('/')}`;
}

/**
 * Everything the production actions reach outside their own module. It is a
 * closed list on purpose: the actions themselves are the real writers, and
 * this is the single seam a test substitutes at, so an end-to-end test drives
 * the same code an operator does.
 */
export interface ApplianceActionDeps {
  readonly loadStateConfig: (
    options?: LoadConfigOptions,
  ) => LoadedApplianceStateConfig;
  readonly loadCredentialConfig: (
    options?: LoadConfigOptions,
  ) => LoadedApplianceConfig;
  readonly commandRunner: CommandRunner;
  readonly spawnDetachedWorker: (
    loaded: LoadedApplianceStateConfig,
    jobId: string,
  ) => void;
  readonly runWorker: (
    loaded: LoadedApplianceConfig,
    jobId: string,
    runner: CommandRunner,
  ) => Promise<void>;
}

export function createApplianceActions(
  deps: ApplianceActionDeps,
): ApplianceActions {
  // Persists the request it was handed. It never reparses argv and never
  // patches the scope after the worker spawns: one construction, one write.
  const submitLiveJob = async (args: {
    readonly kind: 'run' | 'run-all';
    readonly superpowersRef: string;
    readonly argv: readonly string[];
    readonly detach: boolean;
    readonly request: LiveCredentialRequest;
  }): Promise<unknown> => {
    const loaded = deps.loadCredentialConfig({ ensureState: true });
    const job = createJob(loaded, {
      kind: args.kind,
      superpowersRef: args.superpowersRef,
      argv: args.argv,
      requester: requester(),
      credentialSelection: args.request.selection,
      credentialScope: args.request.scope,
      credentialScopeSourceEvalsSha: args.request.sourceEvalsSha,
    });

    if (args.detach) {
      deps.spawnDetachedWorker(loaded, job.job_id);
      return readJob(loaded, job.job_id);
    }

    await deps.runWorker(loaded, job.job_id, deps.commandRunner);
    return readJob(loaded, job.job_id);
  };

  return {
    doctor: async () => {
      const loaded = deps.loadCredentialConfig();
      return doctorPayload(loaded, deps.commandRunner);
    },
    prepare: async (args) => {
      // Structural-config validation first, then the credential-aware loader:
      // a broken bundle fails typed before any job record exists.
      deps.loadStateConfig();
      const loaded = deps.loadCredentialConfig({ ensureState: true });
      const job = createJob(loaded, {
        kind: 'prepare',
        superpowersRef: args.superpowersRef,
        argv: ['prepare'],
        requester: requester(),
        // prepare probes assert zero credential material.
        credentialSelection: null,
        credentialScope: EMPTY_CREDENTIAL_SCOPE,
        credentialScopeSourceEvalsSha: null,
      });
      const result = await prepare({
        loaded,
        jobId: job.job_id,
        superpowersRef: args.superpowersRef,
        argv: ['prepare'],
        requester: requester(),
        runner: deps.commandRunner,
      });
      return { ok: true, job_id: job.job_id, ...result };
    },
    run: async (args, request) => {
      const structural = deps.loadStateConfig();
      const scenario = normalizeScenarioPath(args.scenario, structural);
      const codingAgentsDir = join(
        structural.config.evals.path,
        'coding-agents',
      );
      assertSupportedAgent(args.agent, codingAgentsDir);
      // The operator's selection, forwarded verbatim. An omitted credential
      // stays omitted so Quorum resolves the same agent default the scope
      // already recorded; the request's source SHA is what proves the two
      // readings came from the same checkout.
      const argv = [
        'quorum',
        'run',
        scenario,
        '--coding-agent',
        args.agent,
        ...(args.credential === null ? [] : ['--credential', args.credential]),
        ...(args.graderModel === undefined
          ? []
          : ['--grader-model', args.graderModel]),
      ];
      return submitLiveJob({
        kind: 'run',
        superpowersRef: args.superpowersRef,
        argv,
        detach: args.detach,
        request,
      });
    },
    runAll: async (args, request) => {
      // Argument validation and request construction ran in the command
      // action; this validates the structural config before job creation.
      deps.loadStateConfig();
      return submitLiveJob({
        kind: 'run-all',
        superpowersRef: args.superpowersRef,
        argv: ['quorum', 'run-all', ...args.quorumArgs],
        detach: args.detach,
        request,
      });
    },
    status: async (args) => {
      const loaded = deps.loadStateConfig();
      return statusPayload(loaded, args.id);
    },
    cancel: async (args) => {
      const loaded = deps.loadStateConfig();
      return cancelJob(loaded, args.id, deps.commandRunner);
    },
    show: async (args) => {
      const loaded = deps.loadStateConfig();
      return showPayload(loaded, args.id, args.json);
    },
    costs: async (args) => {
      const loaded = deps.loadStateConfig();
      return costsPayload(loaded, args.id, args.json);
    },
    import: async (args) => {
      const loaded = deps.loadStateConfig({ ensureState: true });
      return importBundle(loaded, { bundleDir: args.bundleDir });
    },
    prune: async (args) => {
      // No ensureState: a default dry-run is read-only and must not create
      // or re-chmod state dirs; apply's own mutation helpers (lock acquire,
      // quarantine move) create exactly what they own.
      const loaded = deps.loadStateConfig();
      return pruneResults(loaded, {
        apply: args.apply,
        olderThanDays: args.olderThanDays,
      });
    },
  };
}

function productionActionDeps(): ApplianceActionDeps {
  return {
    loadStateConfig: (options) => loadStateConfig(undefined, options),
    loadCredentialConfig: (options) => loadCredentialConfig(undefined, options),
    commandRunner: defaultCommandRunner,
    spawnDetachedWorker,
    runWorker,
  };
}

function mergedActions(actions?: Partial<ApplianceActions>): ApplianceActions {
  return { ...createApplianceActions(productionActionDeps()), ...actions };
}

async function handleAction(
  args: BaseCommandArgs,
  deps: Required<Pick<ApplianceCliDeps, 'stdout' | 'stderr' | 'setExitCode'>>,
  action: () => ApplianceActionResult | Promise<ApplianceActionResult>,
  resultFailed?: (value: unknown) => boolean,
): Promise<void> {
  try {
    const value = await action();
    if (resultFailed?.(value) === true) {
      // A structured partial failure: preserve the full payload, but the
      // command did not succeed — ok:false and a nonzero exit.
      deps.stdout(renderResult({ ...(value as object), ok: false }, args.json));
      deps.setExitCode(1);
      return;
    }
    deps.stdout(renderResult(value, args.json));
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

// The age floor is prune's only eligibility dial; anything but a positive
// safe-integer string (0, negatives, fractions, '7days', non-numbers) is
// rejected before the action runs. planPrune revalidates independently.
function parseOlderThanDays(value: string): number {
  const days = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(days) || days <= 0) {
    throw new ApplianceError(
      'config_invalid',
      'arguments',
      `--older-than-days must be a positive integer, got: ${value}`,
    );
  }
  return days;
}

// An import with any failed entry is a failed command: the full result
// (successes AND per-entry failures) is preserved verbatim, but the CLI
// must not exit 0 over entries that did not land.
function importFailed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as { failed?: unknown; failures?: unknown };
  return (
    (typeof result.failed === 'number' && result.failed > 0) ||
    (Array.isArray(result.failures) && result.failures.length > 0)
  );
}

// An apply that could not move every candidate is a failed command even
// though the partial result (successes AND failures) is preserved verbatim:
// the CLI must not exit 0 over unquarantined candidates. Dry-run and
// all-success apply carry an empty failures list and stay successful.
function pruneApplyFailed(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'failures' in value &&
    Array.isArray((value as { failures: unknown }).failures) &&
    (value as { failures: unknown[] }).failures.length > 0
  );
}

// Commander keeps only the LAST value of a repeated option. Collecting every
// occurrence is what makes a duplicate selection flag visible instead of
// silently resolved. (Option state persists across parses on one Command
// instance, so each CLI invocation builds its own program.)
function collectOccurrence(
  value: string,
  previous: readonly string[],
): readonly string[] {
  return [...previous, value];
}

const NO_OCCURRENCES: readonly string[] = [];

// Resolve the selection against the configured evals checkout and pin it to
// that checkout's current HEAD. Runs in the program action, before the
// action itself, so a fake and the real writer see the identical request and
// an unresolvable selection fails before any job, state, bundle, or Docker.
function liveCredentialRequest(
  loaded: LoadedApplianceStateConfig,
  selection: CredentialSelection,
): LiveCredentialRequest {
  const evalsPath = loaded.config.evals.path;
  return buildLiveCredentialRequest(
    evalsPath,
    selection,
    currentCheckoutSha(evalsPath, 'evals', defaultCommandRunner),
  );
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
  const loadConfigForValidation = deps.loadConfig ?? (() => loadStateConfig());
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
    .option(
      '--credential <name>',
      'credential registry name (defaults to the agent default)',
      collectOccurrence,
      NO_OCCURRENCES,
    )
    .option(
      '--grader-model <model>',
      'Gauntlet-Agent model identifier',
      collectOccurrence,
      NO_OCCURRENCES,
    )
    .option('--json', 'emit JSON')
    .option('--detach', 'run in a detached appliance worker')
    .action(
      (
        options: JsonDetachOptions & {
          superpowersRef: string;
          scenario: string;
          codingAgent: string;
          credential: readonly string[];
          graderModel: readonly string[];
        },
      ) => {
        const base = {
          ...commandDetachOptions(options),
          superpowersRef: options.superpowersRef,
          scenario: options.scenario,
          agent: options.codingAgent,
        };
        return handleAction(base, resolvedDeps, () => {
          const credential = normalizeRunCredential(options.credential);
          const graderModel = normalizeRunGraderModel(options.graderModel);
          const loaded = loadConfigForValidation();
          const scenario = normalizeScenarioPath(base.scenario, loaded);
          const codingAgentsDir = join(
            loaded.config.evals.path,
            'coding-agents',
          );
          assertSupportedAgent(base.agent, codingAgentsDir);
          return actions.run(
            {
              ...base,
              scenario,
              credential,
              ...(graderModel === undefined ? {} : { graderModel }),
            },
            liveCredentialRequest(loaded, {
              agent: base.agent,
              credential,
            }),
          );
        });
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
        return handleAction(args, resolvedDeps, () => {
          const { loaded, selection } = assertSupportedRunAllArgs(
            args.quorumArgs,
            loadConfigForValidation,
          );
          return actions.runAll(args, liveCredentialRequest(loaded, selection));
        });
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

  program
    .command('import')
    .description(
      'ingest a scrubbed bundle built by quorum export-runs (never modifies landed runs; conflicts are quarantined)',
    )
    .option('--json', 'emit JSON')
    .argument('<bundle-dir>')
    .action((bundleDir: string, options: JsonOption) => {
      const args = { ...commandOptions(options), bundleDir };
      return handleAction(
        args,
        resolvedDeps,
        () => actions.import(args),
        importFailed,
      );
    });

  program
    .command('prune')
    .description(
      'quarantine incomplete, unreferenced run dirs (dry-run unless --apply)',
    )
    .option('--json', 'emit JSON')
    .option(
      '--apply',
      'move candidates to state/quarantine instead of just reporting',
    )
    .option(
      '--older-than-days <days>',
      'only consider directories untouched for at least this many days (positive integer)',
      '7',
    )
    .action(
      (options: JsonOption & { apply?: boolean; olderThanDays?: string }) => {
        const base = {
          ...commandOptions(options),
          apply: options.apply ?? false,
        };
        return handleAction(
          base,
          resolvedDeps,
          () =>
            actions.prune({
              ...base,
              olderThanDays: parseOlderThanDays(options.olderThanDays ?? '7'),
            }),
          pruneApplyFailed,
        );
      },
    );

  return program;
}

if (import.meta.main) {
  await createApplianceProgram().parseAsync();
}
