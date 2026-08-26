import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SuperpowersSpec } from '../agents/superpowers.ts';
import type { CredentialLabels } from '../contracts/credential.ts';
import type { FinalStatus } from '../contracts/verdict.ts';
import { resolveCredentialNameForAgent } from '../credentials/resolve.ts';
import { assertNever } from '../invariant.ts';
import { RunnerError } from '../runner/errors.ts';
import { currentGauntletChild, runScenario } from '../runner/index.ts';
import { writeStoppedVerdict } from '../runner/stopped.ts';
import { render } from './render.ts';
import { resolveScenarioDir, scenarioName } from './scenario.ts';

export interface RunCommandOptions {
  readonly codingAgent: string;
  readonly os: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly scenariosRoot: string;
  readonly credential?: string;
  readonly credentialsFile?: string;
  readonly graderModel?: string;
  // Snapshot-local gauntlet wrapper (internal: the run-child parser is the
  // only flag surface; the public `quorum run` command does not expose it).
  readonly gauntletBin?: string;
  // Explicit superpowers mode. `superpowersRoot` is an already-materialized
  // root (resolved here, never a ref); `noSuperpowers` runs stock. Both unset
  // = legacy ambient behavior.
  readonly superpowersRoot?: string;
  readonly noSuperpowers?: boolean;
}

/** Project commander's parsed options onto RunCommandOptions. The
 *  `--no-superpowers` flag parses as the NEGATED boolean `superpowers`
 *  (default true, false only when passed); the shared executor instead reads
 *  the mode off `noSuperpowers`, so the negation is folded here, once, for
 *  both CLI parsers. */
export function normalizeRunCommandOptions(
  opts: RunCommandOptions & { superpowers?: boolean },
): RunCommandOptions {
  const { superpowers: suppressed, ...rest } = opts;
  return { ...rest, ...(suppressed === false ? { noSuperpowers: true } : {}) };
}

export type RunCredentialsOrigin =
  | 'external-campaign'
  | 'canonical-snapshot'
  | undefined;

function exitCodeFor(final: FinalStatus): number {
  switch (final) {
    case 'pass':
      return 0;
    case 'fail':
      return 1;
    case 'indeterminate':
      return 2;
    default:
      return assertNever(final);
  }
}

function runId(path: string): string {
  const last = path.split('/').at(-1);
  return last !== undefined && last !== '' ? last : path;
}

/** The machine-facing allocation line (parent Identity): emitted at run-dir
 *  allocation, before the first provider token, so a spawner can bind
 *  attempt -> run_id without waiting for exit. Legacy human output (the
 *  exit-time 'run-id:' line + rendered verdict) is unchanged. */
export function runAllocatedLine(runDir: string): string {
  return `run_allocated: ${runId(runDir)}\n`;
}

// Shared by the public `quorum run` command and run-all's narrow internal child
// entrypoint. The caller fixes credential origin; no user input selects it.
export async function executeRunCommand(
  scenario: string,
  opts: RunCommandOptions,
  credentialsOrigin: RunCredentialsOrigin,
): Promise<void> {
  const scn = resolveScenarioDir(scenario, opts.scenariosRoot);
  if (scn === undefined) {
    process.stderr.write(
      `scenario not found: ${scenario} (looked at the path and under ${opts.scenariosRoot}/)\n`,
    );
    process.exit(2);
  }
  const credentialName = resolveCredentialNameForAgent(
    resolve(opts.codingAgentsDir),
    opts.codingAgent,
    opts.credential,
  );
  const startedAt = new Date().toISOString();
  const scenarioId = scenarioName(scn);
  let runDirForStop: string | null = null;
  let labelsForStop: CredentialLabels | undefined;
  const onSigint = (): void => {
    currentGauntletChild()?.kill('SIGINT');
    if (runDirForStop !== null) {
      writeStoppedVerdict(runDirForStop, {
        scenario: scenarioId,
        codingAgent: opts.codingAgent,
        startedAt,
        ...(credentialName !== undefined ? { credential: credentialName } : {}),
        ...(labelsForStop !== undefined ? { labels: labelsForStop } : {}),
      });
    }
    process.exit(2);
  };
  process.once('SIGINT', onSigint);
  // Explicit superpowers mode from the CLI projection. Resolved paths only —
  // materialization/verification belongs to the spawning campaign.
  const superpowers: SuperpowersSpec | undefined =
    opts.superpowersRoot !== undefined
      ? { mode: 'root', root: resolve(opts.superpowersRoot) }
      : opts.noSuperpowers === true
        ? { mode: 'none' }
        : undefined;
  if (superpowers?.mode === 'root' && !existsSync(superpowers.root)) {
    throw new RunnerError(
      `--superpowers-root does not exist: ${superpowers.root}`,
      'setup',
    );
  }
  const { runDir, verdict } = await runScenario({
    scenarioDir: resolve(scn),
    codingAgent: opts.codingAgent,
    os: opts.os,
    codingAgentsDir: resolve(opts.codingAgentsDir),
    outRoot: resolve(opts.outRoot),
    startedAt,
    credential: opts.credential,
    ...(opts.credentialsFile !== undefined
      ? {
          credentialsPath: resolve(opts.credentialsFile),
          ...(credentialsOrigin !== undefined ? { credentialsOrigin } : {}),
        }
      : {}),
    graderModel: opts.graderModel,
    ...(opts.gauntletBin !== undefined
      ? { gauntletBin: resolve(opts.gauntletBin) }
      : {}),
    ...(superpowers !== undefined ? { superpowers } : {}),
    onRunDir: (dir) => {
      runDirForStop = dir;
      process.stdout.write(runAllocatedLine(dir));
    },
    onCredentialLabels: (labels) => {
      labelsForStop = labels;
    },
  });
  process.stdout.write(`run-id: ${runId(runDir)}\n`);
  process.stdout.write(
    render(verdict, runDir, {
      color: process.stdout.isTTY ?? false,
      mode: 'full',
    }),
  );
  process.exit(exitCodeFor(verdict.final));
}
