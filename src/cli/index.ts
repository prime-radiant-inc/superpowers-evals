#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import type { FinalStatus, FinalVerdict } from '../contracts/verdict.ts';
import { FinalVerdictSchema } from '../contracts/verdict.ts';
import { assertNever } from '../invariant.ts';
import { runScenario } from '../runner/index.ts';
import type { ShowMode } from './render.ts';
import { render } from './render.ts';
import { resolveTarget, ShowError } from './resolve-target.ts';

// Process exit code per the verdict's final value. A closed switch over the
// FinalStatus union (coding standard 5.1) gives a guaranteed number without an
// index-signature lookup that noUncheckedIndexedAccess would widen.
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

function basename(path: string): string {
  const last = path.split('/').at(-1);
  return last !== undefined && last !== '' ? last : path;
}

interface RunOptions {
  readonly codingAgent: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
}

interface ShowOptions {
  readonly quiet: boolean;
  readonly json: boolean;
  readonly color: boolean;
  readonly resultsRoot: string;
}

const program = new Command();
program.name('quorum').description('Behavioral eval runner (TypeScript)');

program
  .command('run')
  .argument('<scenario-dir>', 'scenario directory')
  .requiredOption('--coding-agent <name>', 'coding agent to run')
  .option('--coding-agents-dir <dir>', 'agents dir', 'coding-agents')
  .option('--out-root <dir>', 'results root', 'results')
  .action(async (scenarioDir: string, opts: RunOptions) => {
    const scn = resolve(scenarioDir);
    if (!existsSync(scn)) {
      process.stderr.write(`scenario dir not found: ${scn}\n`);
      process.exit(2);
    }
    const { runDir, verdict } = await runScenario({
      scenarioDir: scn,
      codingAgent: opts.codingAgent,
      codingAgentsDir: resolve(opts.codingAgentsDir),
      outRoot: resolve(opts.outRoot),
    });
    process.stdout.write(`run-id: ${basename(runDir)}\n`);
    process.stdout.write(
      render(verdict, runDir, {
        color: process.stdout.isTTY ?? false,
        mode: 'full',
      }),
    );
    process.exit(exitCodeFor(verdict.final));
  });

program
  .command('show')
  .argument('[target]', 'run-dir, verdict.json, or scenario prefix')
  .option('-q, --quiet', 'final + reason only', false)
  .option('--json', 'raw verdict json', false)
  .option('--no-color', 'disable color')
  .option('--results-root <dir>', 'results root', 'results')
  .action((target: string | undefined, opts: ShowOptions) => {
    // show is display-only and never carries a verdict's exit code: success is
    // always 0, resolution failure is 1, a malformed verdict is 2.
    if (opts.quiet && opts.json) {
      process.stderr.write('--quiet and --json are mutually exclusive\n');
      process.exit(1);
    }

    let runDir: string;
    try {
      runDir = resolveTarget(target, resolve(opts.resultsRoot));
    } catch (err: unknown) {
      if (err instanceof ShowError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    let verdict: FinalVerdict;
    try {
      verdict = FinalVerdictSchema.parse(
        JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')),
      );
    } catch {
      // Both unparseable JSON and a schema mismatch land here; either way the
      // on-disk verdict is unusable and the exit code is 2.
      process.stderr.write('malformed verdict.json\n');
      process.exit(2);
    }

    const mode: ShowMode = opts.json ? 'json' : opts.quiet ? 'quiet' : 'full';
    process.stdout.write(
      render(verdict, runDir, {
        color: opts.color && (process.stdout.isTTY ?? false),
        mode,
      }),
    );
    process.exit(0);
  });

await program.parseAsync(process.argv);
